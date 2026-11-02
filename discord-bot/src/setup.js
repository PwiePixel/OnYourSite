'use strict';
// Einrichtung über die Discord-API (für install.sh): Bot prüfen, Server finden, Rolle „Staff“ und die Kanäle anlegen.
// Was es schon gibt (gespeicherte ID oder gleicher Name), wird weiterverwendet – nichts entsteht doppelt, und an
// vorhandenen Kanälen und Rollen ändert sich nichts. Ausgabe: KEY=VALUE-Zeilen auf stdout, Fehler auf stderr.
//
//   node index.js --discord-app      → APP_ID=…, APP_NAME=…, INVITE=… (Einladungslink)
//   node index.js --discord-guilds   → GUILD_<id>=<Name> für jeden Server, auf dem der Bot ist
//   node index.js --discord-setup ID → GUILD_ID=…, TEAM_ROLE_ID=…, … sowie DONE=… und WARN=… (Texte für die Ausgabe)
//   node index.js --discord-channel KEY ID → KEY=… sowie DONE=…/WARN=…: nur diesen einen Kanal finden oder anlegen
//   node index.js --channel-keys     → KEY=name für jeden Kanal aus CHANNEL_SPECS (ohne Token)
//
// Das Token kommt aus DISCORD_TOKEN, gespeicherte IDs (zum Wiederverwenden) aus den gleichnamigen Variablen.
const { REST, Routes, ChannelType, PermissionFlagsBits: P } = require('discord.js');

// Rechte im Einladungslink: View Channels, Send Messages, Send Messages in Threads, Embed Links, Attach Files,
// Read Message History, Manage Messages, Manage Channels, Manage Roles, Manage Threads, Create Public/Private Threads.
// Discord lässt den Bot in Kanal-Rechten nur vergeben, was er selbst hat: Create … Threads braucht er, um Kanäle
// schreibgeschützt zu machen, Attach Files und Manage Messages für die Ticket-Kanäle (Dateien, Moderation durch Staff).
const INVITE_PERMISSIONS = String(P.ViewChannel | P.SendMessages | P.SendMessagesInThreads | P.EmbedLinks | P.AttachFiles
  | P.ReadMessageHistory | P.ManageMessages | P.ManageChannels | P.ManageRoles | P.ManageThreads | P.CreatePublicThreads
  | P.CreatePrivateThreads);
const BRAND = 0x6366f1;
const REASON = 'OnYourSite bot setup';

const bits = (...flags) => String(flags.reduce((a, b) => a | b, 0n));

// Kanäle, die einzeln dazukommen können: install.sh --update legt jeden an, dessen Schlüssel in den Einstellungen fehlt
// (einmal; ein Fehlschlag wird als leerer Wert gemerkt). Weitere Teile der Webseite ergänzen hier ihre Kanäle.
// private: nur das Team (Rolle aus TEAM_ROLE_ID) und der Bot sehen ihn – immer ein Textkanal.
const CHANNEL_SPECS = {
  UPDATES_CHANNEL_ID: { name: 'updates', topic: 'Release notes and updates from OnYourSite.' },
  STATUS_CHANNEL_ID: { name: 'status', topic: 'Incidents and maintenance of OnYourSite, as on our status page.' },
  ALERTS_CHANNEL_ID: { name: 'alerts', topic: 'Alerts for the team when one of OnYourSite’s checks fails or recovers.', private: true },
};
const NAMED_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum];

// Lesekanal: nur der Bot schreibt (das Team kann es über die Kanal-Rechte jederzeit ändern)
function readOnlyOverwrites(everyoneId, botId) {
  return [
    { id: everyoneId, type: 0, deny: bits(P.SendMessages, P.SendMessagesInThreads, P.CreatePublicThreads, P.CreatePrivateThreads) },
    { id: botId, type: 1, allow: bits(P.ViewChannel, P.SendMessages, P.SendMessagesInThreads, P.EmbedLinks, P.ReadMessageHistory) },
  ];
}

// Privater Kanal: niemand außer dem Team und dem Bot sieht ihn
function privateOverwrites(everyoneId, botId, teamRoleId) {
  const list = [{ id: everyoneId, type: 0, deny: bits(P.ViewChannel) }];
  if (teamRoleId) list.push({ id: teamRoleId, type: 0, allow: bits(P.ViewChannel, P.SendMessages, P.ReadMessageHistory) });
  list.push({ id: botId, type: 1, allow: bits(P.ViewChannel, P.SendMessages, P.EmbedLinks, P.ReadMessageHistory) });
  return list;
}

// Sieht @everyone diesen Kanal nicht? (eigene Rechte des Kanals, sonst die seiner Kategorie)
function hiddenFromEveryone(channel, channels, everyoneId) {
  const rule = (c) => (c && c.permission_overwrites ? c.permission_overwrites.find((o) => o.id === everyoneId) : null);
  const own = rule(channel);
  if (own && (BigInt(own.deny || '0') & P.ViewChannel)) return true;
  if (own && (BigInt(own.allow || '0') & P.ViewChannel)) return false;
  const parent = rule(channels.find((c) => c.id === channel.parent_id));
  return Boolean(parent && (BigInt(parent.deny || '0') & P.ViewChannel));
}

// Einen Kanal aus CHANNEL_SPECS finden oder anlegen: die gespeicherte ID, sonst ein Text-, Ankündigungs- oder
// Forenkanal mit diesem Namen – beides unverändert benutzt (keine Rechte, kein Thema, nichts wird geändert; ein privater
// Kanal, den alle sehen, bekommt nur einen Hinweis). Sonst entsteht er in der Kategorie „OnYourSite“: auf einem
// Community-Server als Ankündigungskanal, sonst als Textkanal; ein privater immer als Textkanal nur für das Team.
async function ensureNamedChannel(rest, guildId, key, current = {}) {
  const spec = CHANNEL_SPECS[key];
  if (!spec) throw new Error(`Unknown channel ${key}.`);
  const me = await rest.get(Routes.user());
  const guild = await rest.get(Routes.guild(guildId));
  const channels = await rest.get(Routes.guildChannels(guildId));
  const found = channels.find((c) => c.id === current[key] && NAMED_TYPES.includes(c.type))
    || channels.find((c) => NAMED_TYPES.includes(c.type) && (c.name || '').toLowerCase() === spec.name);
  if (found) {
    const warnings = [];
    if (spec.private && !hiddenFromEveryone(found, channels, guild.id)) {
      warnings.push(`Everyone on the server can see #${found.name} – the team alerts would be public there. In Discord, make it `
        + 'private (only Staff and the bot), or choose another channel on the website.');
    }
    return { id: found.id, done: [`Using your existing #${found.name}`], warnings };
  }
  const community = (guild.features || []).includes('COMMUNITY');
  const parentOf = (id) => (channels.find((c) => c.id === id) || {}).parent_id || null;
  const categoryId = parentOf(current.WELCOME_CHANNEL_ID) || parentOf(current.SUPPORT_CHANNEL_ID);
  const category = channels.find((c) => c.type === ChannelType.GuildCategory && c.id === categoryId)
    || channels.find((c) => c.type === ChannelType.GuildCategory && (c.name || '').toLowerCase() === 'onyoursite');
  if (spec.private) {
    const teamRoleId = /^\d{15,22}$/.test(String(current.TEAM_ROLE_ID || '')) ? String(current.TEAM_ROLE_ID) : '';
    const body = { name: spec.name, type: ChannelType.GuildText, topic: spec.topic, permission_overwrites: privateOverwrites(guild.id, me.id, teamRoleId) };
    if (category) body.parent_id = category.id;
    const ch = await rest.post(Routes.guildChannels(guildId), { body, reason: REASON });
    const warnings = teamRoleId ? [] : [`Only the bot and server admins can see #${ch.name} – give your team’s role access to it in Discord.`];
    return { id: ch.id, done: [`Created the private channel #${ch.name} (only Staff and the bot)`], warnings };
  }
  const body = {
    name: spec.name,
    type: community ? ChannelType.GuildAnnouncement : ChannelType.GuildText,
    topic: spec.topic,
    permission_overwrites: readOnlyOverwrites(guild.id, me.id),
  };
  if (category) body.parent_id = category.id;
  const ch = await rest.post(Routes.guildChannels(guildId), { body, reason: REASON });
  const done = community ? `Created channel #${ch.name}` : `Created channel #${ch.name} (a text channel – announcement channels need a community server)`;
  return { id: ch.id, done: [done], warnings: [] };
}

function api(token) {
  // DISCORD_API_BASE nur für Tests mit einem nachgebauten Discord
  const options = { version: '10', ...(process.env.DISCORD_API_BASE ? { api: process.env.DISCORD_API_BASE } : {}) };
  return new REST(options).setToken(token);
}

function inviteUrl(appId) {
  return `https://discord.com/oauth2/authorize?client_id=${appId}&permissions=${INVITE_PERMISSIONS}&scope=bot%20applications.commands`;
}

async function application(rest) {
  const app = await rest.get(Routes.oauth2CurrentApplication());
  return { id: app.id, name: app.name, invite: inviteUrl(app.id) };
}

async function guilds(rest) {
  return (await rest.get(Routes.userGuilds())).map((g) => ({ id: g.id, name: g.name }));
}

async function setupGuild(rest, guildId, current) {
  const done = [];
  const warnings = [];
  const me = await rest.get(Routes.user());
  const app = await application(rest);
  const guild = await rest.get(Routes.guild(guildId));
  const roles = await rest.get(Routes.guildRoles(guildId));
  const channels = await rest.get(Routes.guildChannels(guildId));
  const member = await rest.get(Routes.guildMember(guildId, me.id));
  const everyone = guild.id;

  // Hat der Bot alle Rechte aus dem Einladungslink? (z. B. mit einem älteren Link eingeladen) Sonst scheitern Tickets –
  // denselben Link noch einmal öffnen: Discord ergänzt dann die Rechte der Bot-Rolle.
  let have = 0n;
  for (const r of roles) {
    if (r.id === everyone || (member.roles || []).includes(r.id)) have |= BigInt(r.permissions || '0');
  }
  if (!(have & P.Administrator)) {
    const need = BigInt(INVITE_PERMISSIONS);
    const missing = Object.entries(P).filter(([, bit]) => (need & bit) && !(have & bit)).map(([name]) => name);
    if (missing.length) {
      warnings.push(`The bot is missing permissions on this server (${missing.join(', ')}). Open this link, choose the server `
        + `and authorize again – Discord adds them: ${app.invite}`);
    }
  }

  // Rolle „Staff“: darf Vorschläge annehmen/ablehnen und sieht alle Tickets
  let staff = roles.find((r) => r.id === current.TEAM_ROLE_ID)
    || roles.find((r) => !r.managed && r.name.toLowerCase() === 'staff');
  if (staff) {
    done.push(`Role "${staff.name}" is already there`);
  } else {
    staff = await rest.post(Routes.guildRoles(guildId), {
      body: { name: 'Staff', color: BRAND, hoist: true, mentionable: false, permissions: '0' }, reason: REASON,
    });
    done.push('Created the role "Staff"');
  }
  try {
    await rest.put(Routes.guildMemberRole(guildId, guild.owner_id, staff.id), { reason: REASON });
    done.push('The server owner has the Staff role');
  } catch (err) {
    warnings.push(`The Staff role couldn’t be given to the server owner (${err.message}) – give it by hand.`);
  }

  // Kanal finden (gespeicherte ID, sonst gleicher Name und Typ) oder anlegen. Einem vorhandenen Kanal gibt der Bot
  // seine eigenen Rechte dazu – z. B. einer schon vorhandenen Kategorie „Tickets“, die alle anderen nicht sehen.
  async function ensure(storedId, spec, label) {
    const kind = spec.type === ChannelType.GuildCategory ? '' : '#';
    // Gleich benannte Kanäle: zuerst einer, in dem der Bot schon eigene Rechte hat
    const named = channels.filter((c) => c.type === spec.type && (c.name || '').toLowerCase() === spec.name.toLowerCase());
    let ch = channels.find((c) => c.id === storedId && c.type === spec.type)
      || named.find((c) => (c.permission_overwrites || []).some((o) => o.id === me.id)) || named[0];
    if (ch) {
      const want = (spec.permission_overwrites || []).find((o) => o.id === me.id);
      const has = (ch.permission_overwrites || []).find((o) => o.id === me.id);
      if (want && !(has && (BigInt(has.allow || '0') & BigInt(want.allow)) === BigInt(want.allow))) {
        // Nur ergänzen: was der Bot dort schon darf, bleibt; nur ein Verbot der gewünschten Rechte fällt weg
        const allow = String(BigInt((has && has.allow) || '0') | BigInt(want.allow));
        const deny = String(BigInt((has && has.deny) || '0') & ~BigInt(want.allow));
        try {
          await rest.put(Routes.channelPermission(ch.id, me.id), { body: { type: 1, allow, deny }, reason: REASON });
          done.push(`${label} ${kind}${ch.name} is already there`);
          done.push(`Gave the bot access to ${kind}${ch.name}`);
          return ch;
        } catch (err) {
          if (ch.id === storedId) {
            done.push(`${label} ${kind}${ch.name} is already there`);
            warnings.push(`The bot couldn’t give itself access to ${kind}${ch.name} (${err.message}). In Discord, give the bot `
              + 'View Channel, Send Messages and Manage Channels there, then run the installer again.');
            return ch;
          }
          // Nur über den Namen gefunden und für den Bot nicht nutzbar (z. B. die Kategorie eines anderen Bots): neu anlegen
          ch = null;
        }
      } else {
        done.push(`${label} ${kind}${ch.name} is already there`);
        return ch;
      }
    }
    ch = await rest.post(Routes.guildChannels(guildId), { body: spec, reason: REASON });
    channels.push(ch);
    done.push(`Created ${label.toLowerCase()} ${kind}${ch.name}`);
    return ch;
  }

  // Lesekanäle: nur der Bot schreibt (das Team kann es über die Kanal-Rechte jederzeit ändern)
  const readOnly = readOnlyOverwrites(everyone, me.id);
  // Die Kategorie wiederfinden: über die gespeicherten Kanäle (auch wenn sie umbenannt wurde), sonst über den Namen
  const parentOf = (id) => (channels.find((c) => c.id === id) || {}).parent_id || null;
  const info = await ensure(parentOf(current.WELCOME_CHANNEL_ID) || parentOf(current.SUPPORT_CHANNEL_ID),
    { name: 'OnYourSite', type: ChannelType.GuildCategory }, 'Category');
  const textChannel = (name, topic) => ({ name, type: ChannelType.GuildText, parent_id: info.id, topic, permission_overwrites: readOnly });

  const welcome = await ensure(current.WELCOME_CHANNEL_ID, textChannel('welcome', 'New members are welcomed here.'), 'Channel');
  let rules;
  if (guild.rules_channel_id) {
    rules = { id: guild.rules_channel_id };
    done.push('Using the rules channel of the server');
  } else {
    rules = await ensure(current.RULES_CHANNEL_ID, textChannel('rules', 'The rules of this server.'), 'Channel');
  }
  const support = await ensure(current.SUPPORT_CHANNEL_ID, textChannel('support', 'Need help? Open a private ticket with the button.'), 'Channel');
  // #updates (Beiträge der Webseite), #status (Vorfälle) und #alerts (Meldungen ans Team, privat): ein vorhandener Kanal
  // mit dem Namen bleibt, wie er ist
  const named = { UPDATES_CHANNEL_ID: current.UPDATES_CHANNEL_ID || '', STATUS_CHANNEL_ID: current.STATUS_CHANNEL_ID || '', ALERTS_CHANNEL_ID: current.ALERTS_CHANNEL_ID || '' };
  const fallback = {
    UPDATES_CHANNEL_ID: 'the website can still use a webhook',
    STATUS_CHANNEL_ID: 'run install.sh --channel STATUS_CHANNEL_ID to try again',
    ALERTS_CHANNEL_ID: 'run install.sh --channel ALERTS_CHANNEL_ID to try again',
  };
  for (const key of Object.keys(named)) {
    try {
      const r = await ensureNamedChannel(rest, guildId, key, { ...current, TEAM_ROLE_ID: staff.id, WELCOME_CHANNEL_ID: welcome.id, SUPPORT_CHANNEL_ID: support.id });
      named[key] = r.id;
      done.push(...r.done);
      warnings.push(...r.warnings);
    } catch (err) {
      warnings.push(`The #${CHANNEL_SPECS[key].name} channel couldn’t be added (${err.message}) – ${fallback[key]}.`);
    }
  }

  // Forum für Vorschläge mit den Tags „Accepted“ und „Declined“ (nur der Bot und das Team dürfen sie setzen)
  let forum = null;
  const tags = { accepted: '', declined: '' };
  try {
    forum = await ensure(current.SUGGESTION_FORUM_ID, {
      name: 'suggestions',
      type: ChannelType.GuildForum,
      parent_id: info.id,
      topic: 'One idea per post. The team accepts or declines it here or on the website.',
      available_tags: [{ name: 'Accepted', moderated: true }, { name: 'Declined', moderated: true }],
      permission_overwrites: [
        { id: me.id, type: 1, allow: bits(P.ViewChannel, P.SendMessages, P.SendMessagesInThreads, P.EmbedLinks, P.ReadMessageHistory, P.ManageThreads) },
      ],
    }, 'Forum');
    // Tags: gespeicherte IDs zuerst (auch wenn sie umbenannt wurden), sonst gleicher Name; fehlende werden ergänzt
    let available = forum.available_tags || [];
    const find = (id, name) => available.find((t) => t.id === id) || available.find((t) => t.name.toLowerCase() === name.toLowerCase());
    const missing = [['Accepted', current.TAG_ACCEPTED_ID], ['Declined', current.TAG_DECLINED_ID]]
      .filter(([name, id]) => !find(id, name)).map(([name]) => name);
    if (missing.length) {
      const updated = await rest.patch(Routes.channel(forum.id), {
        body: { available_tags: [...available, ...missing.map((name) => ({ name, moderated: true }))] }, reason: REASON,
      });
      available = updated.available_tags || [];
      done.push(`Added the forum tags ${missing.join(' and ')}`);
    }
    tags.accepted = (find(current.TAG_ACCEPTED_ID, 'Accepted') || {}).id || '';
    tags.declined = (find(current.TAG_DECLINED_ID, 'Declined') || {}).id || '';
  } catch (err) {
    warnings.push(`Discord didn’t create the suggestion forum (${err.message}). Forum channels may need a community server: `
      + 'Server Settings → Enable Community, then run the installer again. Everything else works without it.');
  }

  // Kategorie für Tickets: unsichtbar für alle außer Staff und dem Bot (der Bot legt darin die privaten Ticket-Kanäle an)
  const tickets = await ensure(current.SUPPORT_CATEGORY_ID, {
    name: 'Tickets',
    type: ChannelType.GuildCategory,
    permission_overwrites: [
      { id: everyone, type: 0, deny: bits(P.ViewChannel) },
      { id: staff.id, type: 0, allow: bits(P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks) },
      { id: me.id, type: 1, allow: bits(P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks, P.ManageChannels) },
    ],
  }, 'Category');

  return {
    ids: {
      GUILD_ID: guild.id,
      TEAM_ROLE_ID: staff.id,
      WELCOME_CHANNEL_ID: welcome.id,
      RULES_CHANNEL_ID: rules.id,
      SUPPORT_CHANNEL_ID: support.id,
      SUGGESTION_FORUM_ID: forum ? forum.id : '',
      TAG_ACCEPTED_ID: tags.accepted,
      TAG_DECLINED_ID: tags.declined,
      SUPPORT_CATEGORY_ID: tickets.id,
      UPDATES_CHANNEL_ID: named.UPDATES_CHANNEL_ID,
      STATUS_CHANNEL_ID: named.STATUS_CHANNEL_ID,
      ALERTS_CHANNEL_ID: named.ALERTS_CHANNEL_ID,
    },
    done,
    warnings,
  };
}

// Eine Zeile pro Wert, damit install.sh die Ausgabe ohne weitere Werkzeuge lesen kann
const line = (key, value) => `${key}=${String(value).replace(/[\r\n\t]+/g, ' ')}`;

// Aufruf aus index.js – gibt den Exit-Code zurück
async function cli(argv) {
  if (argv.includes('--channel-keys')) {
    process.stdout.write(`${Object.entries(CHANNEL_SPECS).map(([key, spec]) => line(key, spec.name)).join('\n')}\n`);
    return 0;
  }
  const token = String(process.env.DISCORD_TOKEN || '').trim();
  if (!token) {
    console.error('DISCORD_TOKEN is missing.');
    return 1;
  }
  const rest = api(token);
  try {
    const out = [];
    if (argv.includes('--discord-app')) {
      const app = await application(rest);
      out.push(line('APP_ID', app.id), line('APP_NAME', app.name), line('INVITE', app.invite));
    } else if (argv.includes('--discord-guilds')) {
      for (const g of await guilds(rest)) out.push(line(`GUILD_${g.id}`, g.name));
    } else if (argv.includes('--discord-channel')) {
      const i = argv.indexOf('--discord-channel');
      const key = argv[i + 1] || '';
      const guildId = argv[i + 2] || '';
      if (!CHANNEL_SPECS[key] || !/^\d{15,22}$/.test(guildId)) {
        console.error(`Usage: --discord-channel <${Object.keys(CHANNEL_SPECS).join('|')}> <server ID>`);
        return 1;
      }
      const current = {};
      for (const k of [key, 'TEAM_ROLE_ID', 'WELCOME_CHANNEL_ID', 'SUPPORT_CHANNEL_ID']) current[k] = String(process.env[k] || '');
      const r = await ensureNamedChannel(rest, guildId, key, current);
      out.push(line(key, r.id));
      for (const text of r.done) out.push(line('DONE', text));
      for (const text of r.warnings) out.push(line('WARN', text));
    } else {
      const guildId = argv[argv.indexOf('--discord-setup') + 1] || '';
      if (!/^\d{15,22}$/.test(guildId)) {
        console.error('Usage: --discord-setup <server ID>');
        return 1;
      }
      const current = {};
      for (const key of ['TEAM_ROLE_ID', 'WELCOME_CHANNEL_ID', 'RULES_CHANNEL_ID', 'SUPPORT_CHANNEL_ID', 'SUGGESTION_FORUM_ID',
        'TAG_ACCEPTED_ID', 'TAG_DECLINED_ID', 'SUPPORT_CATEGORY_ID', 'UPDATES_CHANNEL_ID', 'STATUS_CHANNEL_ID', 'ALERTS_CHANNEL_ID']) {
        current[key] = String(process.env[key] || '');
      }
      const result = await setupGuild(rest, guildId, current);
      for (const [key, value] of Object.entries(result.ids)) out.push(line(key, value));
      for (const text of result.done) out.push(line('DONE', text));
      for (const text of result.warnings) out.push(line('WARN', text));
    }
    process.stdout.write(`${out.join('\n')}\n`);
    return 0;
  } catch (err) {
    const status = err && err.status ? ` (HTTP ${err.status})` : '';
    console.error(`${err && err.message ? err.message : err}${status}`);
    return 1;
  }
}

module.exports = { cli, inviteUrl, INVITE_PERMISSIONS, setupGuild, ensureNamedChannel, CHANNEL_SPECS };
