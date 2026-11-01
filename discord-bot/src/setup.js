'use strict';
// Einrichtung über die Discord-API (für install.sh): Bot prüfen, Server finden, Rolle „Staff“ und die Kanäle anlegen.
// Was es schon gibt (gespeicherte ID oder gleicher Name), wird weiterverwendet – nichts entsteht doppelt, und an
// vorhandenen Kanälen und Rollen ändert sich nichts. Ausgabe: KEY=VALUE-Zeilen auf stdout, Fehler auf stderr.
//
//   node index.js --discord-app      → APP_ID=…, APP_NAME=…, INVITE=… (Einladungslink)
//   node index.js --discord-guilds   → GUILD_<id>=<Name> für jeden Server, auf dem der Bot ist
//   node index.js --discord-setup ID → GUILD_ID=…, TEAM_ROLE_ID=…, … sowie DONE=… und WARN=… (Texte für die Ausgabe)
//
// Das Token kommt aus DISCORD_TOKEN, gespeicherte IDs (zum Wiederverwenden) aus den gleichnamigen Variablen.
const { REST, Routes, ChannelType, PermissionFlagsBits: P } = require('discord.js');

// Rechte im Einladungslink: View Channels, Send Messages, Send Messages in Threads, Embed Links, Read Message History,
// Manage Channels, Manage Roles, Manage Threads, Create Public/Private Threads (damit Kanäle schreibgeschützt werden können)
const INVITE_PERMISSIONS = String(P.ViewChannel | P.SendMessages | P.SendMessagesInThreads | P.EmbedLinks
  | P.ReadMessageHistory | P.ManageChannels | P.ManageRoles | P.ManageThreads | P.CreatePublicThreads | P.CreatePrivateThreads);
const BRAND = 0x6366f1;
const REASON = 'OnYourSite bot setup';

const bits = (...flags) => String(flags.reduce((a, b) => a | b, 0n));

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
  const guild = await rest.get(Routes.guild(guildId));
  const roles = await rest.get(Routes.guildRoles(guildId));
  const channels = await rest.get(Routes.guildChannels(guildId));
  const everyone = guild.id;

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

  // Kanal finden (gespeicherte ID, sonst gleicher Name und Typ) oder anlegen
  async function ensure(storedId, spec, label) {
    let ch = channels.find((c) => c.id === storedId && c.type === spec.type)
      || channels.find((c) => c.type === spec.type && (c.name || '').toLowerCase() === spec.name.toLowerCase());
    if (ch) {
      done.push(`${label} ${spec.type === ChannelType.GuildCategory ? '' : '#'}${ch.name} is already there`);
      return ch;
    }
    ch = await rest.post(Routes.guildChannels(guildId), { body: spec, reason: REASON });
    channels.push(ch);
    done.push(`Created ${label.toLowerCase()} ${spec.type === ChannelType.GuildCategory ? '' : '#'}${ch.name}`);
    return ch;
  }

  // Lesekanäle: nur der Bot schreibt (das Team kann es über die Kanal-Rechte jederzeit ändern)
  const botWrites = { id: me.id, type: 1, allow: bits(P.ViewChannel, P.SendMessages, P.SendMessagesInThreads, P.EmbedLinks, P.ReadMessageHistory) };
  const readOnly = [
    { id: everyone, type: 0, deny: bits(P.SendMessages, P.SendMessagesInThreads, P.CreatePublicThreads, P.CreatePrivateThreads) },
    botWrites,
  ];
  const info = await ensure(null, { name: 'OnYourSite', type: ChannelType.GuildCategory }, 'Category');
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
    let available = forum.available_tags || [];
    const missing = ['Accepted', 'Declined'].filter((n) => !available.some((t) => t.name.toLowerCase() === n.toLowerCase()));
    if (missing.length) {
      const updated = await rest.patch(Routes.channel(forum.id), {
        body: { available_tags: [...available, ...missing.map((name) => ({ name, moderated: true }))] }, reason: REASON,
      });
      available = updated.available_tags || [];
      done.push(`Added the forum tags ${missing.join(' and ')}`);
    }
    tags.accepted = (available.find((t) => t.name.toLowerCase() === 'accepted') || {}).id || '';
    tags.declined = (available.find((t) => t.name.toLowerCase() === 'declined') || {}).id || '';
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
    },
    done,
    warnings,
  };
}

// Eine Zeile pro Wert, damit install.sh die Ausgabe ohne weitere Werkzeuge lesen kann
const line = (key, value) => `${key}=${String(value).replace(/[\r\n\t]+/g, ' ')}`;

// Aufruf aus index.js – gibt den Exit-Code zurück
async function cli(argv) {
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
    } else {
      const guildId = argv[argv.indexOf('--discord-setup') + 1] || '';
      if (!/^\d{15,22}$/.test(guildId)) {
        console.error('Usage: --discord-setup <server ID>');
        return 1;
      }
      const current = {};
      for (const key of ['TEAM_ROLE_ID', 'WELCOME_CHANNEL_ID', 'RULES_CHANNEL_ID', 'SUPPORT_CHANNEL_ID', 'SUGGESTION_FORUM_ID', 'SUPPORT_CATEGORY_ID']) {
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

module.exports = { cli, inviteUrl, INVITE_PERMISSIONS, setupGuild };
