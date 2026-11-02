'use strict';
// Bericht an die Webseite (POST /_/bot/hello): Version, Funktionen, wie der Bot läuft, der Server, alle Text-,
// Ankündigungs- und Forenkanäle mit den eigenen Rechten (ohne die privaten Ticket-Kanäle), aktive Threads (ohne die
// Vorschläge), Rollen und der Kanal #updates. Daraus wählt die Webseite, wo Updates erscheinen. Der Bericht bleibt
// unter 48 KB: erst fallen die Threads weg, dann Kanäle, in denen der Bot nicht posten darf, dann der Rest der Liste.
const { ChannelType, Events, PermissionFlagsBits: P } = require('discord.js');
const { version } = require('../package.json');

const BUDGET = 48 * 1024;
const CAPS = { categories: 50, channels: 200, threads: 50, roles: 100 };
const TYPES = { [ChannelType.GuildText]: 'text', [ChannelType.GuildAnnouncement]: 'announcement', [ChannelType.GuildForum]: 'forum' };
// Was der Bot für Updates in einem Kanal braucht (im Forum zusätzlich Beiträge umbenennen und löschen)
const NEEDED = {
  text: ['ViewChannel', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory'],
  announcement: ['ViewChannel', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory'],
  forum: ['ViewChannel', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory', 'ManageThreads'],
};

// Wie der Bot läuft: vom Installer gesetzt (Systemdienst) bzw. im Dockerfile
function runtime() {
  const r = String(process.env.OYS_BOT_RUNTIME || '');
  return r === 'service' || r === 'docker' ? r : 'other';
}

function byPosition(a, b) {
  return (a.rawPosition || 0) - (b.rawPosition || 0) || String(a.id).localeCompare(String(b.id));
}

function buildReport(guild, me, cfg, features) {
  const all = [...guild.channels.cache.values()];
  const inTickets = (c) => Boolean(cfg.supportCategoryId) && c.parentId === cfg.supportCategoryId;
  const categories = new Map();
  const channels = [];
  for (const c of all.filter((x) => TYPES[x.type] !== undefined && !inTickets(x)).sort(byPosition)) {
    const type = TYPES[c.type];
    const perms = c.permissionsFor(me);
    const has = (name) => Boolean(perms && perms.has(P[name]));
    channels.push({
      id: c.id,
      name: String(c.name || ''),
      type,
      parent_id: c.parentId || '',
      can_post: has('ViewChannel') && has('SendMessages') && has('EmbedLinks'),
      can_mention_everyone: has('MentionEveryone'),
      missing: NEEDED[type].filter((name) => !has(name)),
    });
    const parent = c.parentId ? guild.channels.cache.get(c.parentId) : null;
    if (parent) categories.set(parent.id, String(parent.name || ''));
  }
  const threads = [];
  for (const t of all.filter((x) => typeof x.isThread === 'function' && x.isThread() && !x.archived).sort(byPosition)) {
    if (cfg.suggestionForumId && t.parentId === cfg.suggestionForumId) continue;
    const parent = t.parentId ? guild.channels.cache.get(t.parentId) : null;
    if (parent && inTickets(parent)) continue;
    const perms = t.permissionsFor(me);
    const has = (name) => Boolean(perms && perms.has(P[name]));
    threads.push({ id: t.id, name: String(t.name || ''), parent_id: t.parentId || '', can_post: has('ViewChannel') && has('SendMessagesInThreads') && has('EmbedLinks') });
  }
  const roles = [...guild.roles.cache.values()]
    .filter((r) => r.id !== guild.id && !r.managed)
    .sort((a, b) => (b.position || 0) - (a.position || 0))
    .map((r) => ({ id: r.id, name: String(r.name || ''), mentionable: Boolean(r.mentionable) }));

  let truncated = false;
  const cap = (list, max) => {
    if (list.length <= max) return list;
    truncated = true;
    return list.slice(0, max);
  };
  // #updates bleibt in der gekürzten Liste (statt des letzten Kanals)
  const keepUpdates = (list, full) => {
    const updates = full.find((c) => c.id === cfg.updatesChannelId);
    if (updates && !list.includes(updates)) list[list.length - 1] = updates;
    return list;
  };
  const report = {
    version,
    runtime: runtime(),
    features,
    guild: { id: guild.id, name: String(guild.name || ''), community: Array.isArray(guild.features) && guild.features.includes('COMMUNITY') },
    updates_channel_id: cfg.updatesChannelId || '',
    categories: cap([...categories].map(([id, name]) => ({ id, name })), CAPS.categories),
    channels: keepUpdates(cap(channels, CAPS.channels), channels),
    threads: cap(threads, CAPS.threads),
    roles: cap(roles, CAPS.roles),
    truncated: false,
  };
  const size = () => Buffer.byteLength(JSON.stringify({ ...report, truncated: true }));
  if (size() > BUDGET && report.threads.length) {
    report.threads = [];
    truncated = true;
  }
  if (size() > BUDGET) {
    const before = report.channels.length;
    report.channels = report.channels.filter((c) => c.can_post);
    truncated = truncated || report.channels.length !== before;
  }
  // Dann vom Ende her kürzen: erst Rollen, dann Kanäle – #updates bleibt drin
  while (size() > BUDGET) {
    if (report.roles.length) {
      report.roles.pop();
      truncated = true;
      continue;
    }
    let i = report.channels.length - 1;
    while (i >= 0 && report.channels[i].id === report.updates_channel_id) i--;
    if (i < 0) break;
    report.channels.splice(i, 1);
    truncated = true;
  }
  report.truncated = truncated;
  return report;
}

// Bericht senden: beim Start, alle 10 Minuten, nach Änderungen an Kanälen, Threads und Rollen (gesammelt, 5 s) und auf
// Wunsch der Webseite (Auftrag bot.report). Die Antwort nennt die Funktionen der Webseite.
function setupReport(client, cfg, site, log, features) {
  let siteFeatures = null;
  let soonTimer = null;
  let every = null;

  async function send() {
    const guild = client.guilds.cache.get(cfg.guildId);
    if (!guild || !guild.members.me) return null;
    const res = await site.post('/_/bot/hello', buildReport(guild, guild.members.me, cfg, features));
    if (res.ok) siteFeatures = Array.isArray(res.features) ? res.features : [];
    else if (res.httpStatus === 404) siteFeatures = []; // ältere Webseite: kennt den Bericht nicht
    else log(`Report to the website failed: ${res.error}`);
    return res;
  }

  function soon() {
    clearTimeout(soonTimer);
    soonTimer = setTimeout(() => send().catch((err) => log(`Report failed: ${err.message}`)), 5000);
    if (soonTimer.unref) soonTimer.unref();
  }

  const mine = (x) => {
    const guildId = x && (x.guildId || (x.guild && x.guild.id));
    return guildId === cfg.guildId;
  };
  for (const ev of [Events.ChannelCreate, Events.ChannelDelete, Events.ThreadCreate, Events.ThreadDelete, Events.GuildRoleCreate, Events.GuildRoleDelete]) {
    client.on(ev, (x) => { if (mine(x)) soon(); });
  }
  for (const ev of [Events.ChannelUpdate, Events.ThreadUpdate, Events.GuildRoleUpdate]) {
    client.on(ev, (_old, x) => { if (mine(x)) soon(); });
  }

  function start() {
    send().catch((err) => log(`Report failed: ${err.message}`));
    every = setInterval(() => send().catch((err) => log(`Report failed: ${err.message}`)), 10 * 60 * 1000);
    if (every.unref) every.unref();
  }
  function stop() {
    clearTimeout(soonTimer);
    clearInterval(every);
  }
  return { send, start, stop, siteFeatures: () => siteFeatures };
}

module.exports = { buildReport, setupReport, runtime, BUDGET };
