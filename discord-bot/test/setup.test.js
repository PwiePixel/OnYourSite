'use strict';
// Einrichtung für den Installer: #updates finden oder anlegen (gespeicherte ID, gleicher Name – unverändert benutzt;
// neu als Ankündigungskanal nur auf Community-Servern), --discord-channel und --channel-keys über index.js, und die
// volle Einrichtung mit #updates – gegen ein nachgebautes Discord. Mit OYS_DISCORD_SETUP_MOCK (Adresse …/api eines
// weiteren nachgebauten Discords, dessen Token mit „MTEx“ beginnt) läuft die Einrichtung zusätzlich auch dagegen.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { ChannelType } = require('discord.js');
const { ensureNamedChannel, CHANNEL_SPECS } = require('../src/setup');
const { startFakeDiscord } = require('./fakeDiscord');

const INDEX = path.join(__dirname, '..', 'index.js');
const ID = (n) => String(1600000000000000000n + BigInt(n));
const GUILD = ID(1);
const BOT = ID(2);

// REST-Ersatz im Speicher: GET liefert den Zustand, POST legt einen Kanal an; alles landet in calls
function fakeRest(channels, { community = true } = {}) {
  const calls = [];
  let next = 100;
  return {
    calls,
    async get(route) {
      calls.push(['GET', route]);
      if (route === '/users/@me') return { id: BOT };
      if (route === `/guilds/${GUILD}`) return { id: GUILD, features: community ? ['COMMUNITY'] : [] };
      if (route === `/guilds/${GUILD}/channels`) return channels.map((c) => ({ ...c }));
      throw new Error(`unexpected GET ${route}`);
    },
    async post(route, { body }) {
      calls.push(['POST', route, body]);
      const ch = { id: ID(next++), ...body };
      channels.push(ch);
      return ch;
    },
    async put(route) { calls.push(['PUT', route]); },
    async patch(route) { calls.push(['PATCH', route]); },
  };
}
const writes = (rest) => rest.calls.filter((c) => c[0] !== 'GET');

test('an existing channel named "updates" (text, announcement or forum, any case) is used exactly as it is', async () => {
  for (const type of [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum]) {
    const rest = fakeRest([{ id: ID(10), name: 'Updates', type, parent_id: null }]);
    const r = await ensureNamedChannel(rest, GUILD, 'UPDATES_CHANNEL_ID', {});
    assert.deepEqual(r, { id: ID(10), done: ['Using your existing #Updates'], warnings: [] });
    assert.deepEqual(writes(rest), [], 'no new channel, no permissions, no topic');
  }
  // Ein Sprachkanal oder eine Kategorie mit dem Namen zählt nicht
  const rest = fakeRest([{ id: ID(11), name: 'updates', type: ChannelType.GuildVoice }, { id: ID(12), name: 'updates', type: ChannelType.GuildCategory }]);
  const r = await ensureNamedChannel(rest, GUILD, 'UPDATES_CHANNEL_ID', {});
  assert.notEqual(r.id, ID(11));
  assert.equal(writes(rest).length, 1);
});

test('the stored ID wins over the name, as long as it is a text, announcement or forum channel', async () => {
  const channels = [{ id: ID(10), name: 'updates', type: ChannelType.GuildText }, { id: ID(20), name: 'news', type: ChannelType.GuildForum }, { id: ID(30), name: 'talk', type: ChannelType.GuildVoice }];
  const rest = fakeRest(channels);
  assert.equal((await ensureNamedChannel(rest, GUILD, 'UPDATES_CHANNEL_ID', { UPDATES_CHANNEL_ID: ID(20) })).id, ID(20));
  assert.equal((await ensureNamedChannel(rest, GUILD, 'UPDATES_CHANNEL_ID', { UPDATES_CHANNEL_ID: ID(30) })).id, ID(10), 'a voice channel ID is ignored');
  assert.equal((await ensureNamedChannel(rest, GUILD, 'UPDATES_CHANNEL_ID', { UPDATES_CHANNEL_ID: ID(99) })).id, ID(10), 'a deleted channel is ignored');
  assert.deepEqual(writes(rest), []);
  await assert.rejects(ensureNamedChannel(rest, GUILD, 'NOPE_CHANNEL_ID', {}), /Unknown channel NOPE_CHANNEL_ID/);
});

test('a missing #updates is created read-only in the OnYourSite category: an announcement channel on community servers, else text', async () => {
  const base = () => [
    { id: ID(1), name: 'Info', type: ChannelType.GuildCategory },
    { id: ID(2), name: 'OnYourSite', type: ChannelType.GuildCategory },
    { id: ID(3), name: 'welcome', type: ChannelType.GuildText, parent_id: ID(1) },
  ];
  // Die Kategorie des gespeicherten Willkommenskanals (auch umbenannt) vor dem Namen
  const rest = fakeRest(base());
  const r = await ensureNamedChannel(rest, GUILD, 'UPDATES_CHANNEL_ID', { WELCOME_CHANNEL_ID: ID(3) });
  const [post] = writes(rest);
  assert.equal(post[1], `/guilds/${GUILD}/channels`);
  assert.deepEqual({ ...post[2], permission_overwrites: undefined }, { name: 'updates', type: ChannelType.GuildAnnouncement, topic: CHANNEL_SPECS.UPDATES_CHANNEL_ID.topic, parent_id: ID(1), permission_overwrites: undefined });
  const [everyone, bot] = post[2].permission_overwrites;
  assert.equal(everyone.id, GUILD);
  assert.ok(BigInt(everyone.deny) & 2048n, 'members can’t write');
  assert.equal(bot.id, BOT);
  assert.ok(BigInt(bot.allow) & 2048n && BigInt(bot.allow) & 16384n, 'the bot can write and embed');
  assert.equal(typeof everyone.deny, 'string', 'Discord wants permission bits as strings');
  assert.deepEqual(r.done, ['Created channel #updates']);
  // Ohne gespeicherten Kanal: die Kategorie „OnYourSite“; ohne Community ein Textkanal (und die Ausgabe sagt warum)
  const rest2 = fakeRest(base(), { community: false });
  const r2 = await ensureNamedChannel(rest2, GUILD, 'UPDATES_CHANNEL_ID', {});
  assert.equal(writes(rest2)[0][2].parent_id, ID(2));
  assert.equal(writes(rest2)[0][2].type, ChannelType.GuildText);
  assert.deepEqual(r2.done, ['Created channel #updates (a text channel – announcement channels need a community server)']);
  // Ohne Kategorie: ohne parent_id
  const rest3 = fakeRest([]);
  await ensureNamedChannel(rest3, GUILD, 'UPDATES_CHANNEL_ID', {});
  assert.equal('parent_id' in writes(rest3)[0][2], false);
});

test('#status is created like #updates: read-only for members, an announcement channel on community servers', async () => {
  const rest = fakeRest([{ id: ID(2), name: 'OnYourSite', type: ChannelType.GuildCategory }]);
  const r = await ensureNamedChannel(rest, GUILD, 'STATUS_CHANNEL_ID', {});
  const [post] = writes(rest);
  assert.equal(post[2].name, 'status');
  assert.equal(post[2].type, ChannelType.GuildAnnouncement);
  assert.equal(post[2].parent_id, ID(2));
  assert.ok(BigInt(post[2].permission_overwrites[0].deny) & 2048n, 'members can’t write');
  assert.deepEqual(r, { id: post[2].id ?? r.id, done: ['Created channel #status'], warnings: [] });
});

test('#alerts is created private: hidden from @everyone, visible to the Staff role and the bot – always a text channel', async () => {
  const VIEW = 1024n;
  const rest = fakeRest([{ id: ID(2), name: 'OnYourSite', type: ChannelType.GuildCategory }]);
  const r = await ensureNamedChannel(rest, GUILD, 'ALERTS_CHANNEL_ID', { TEAM_ROLE_ID: ID(7) });
  const [post] = writes(rest);
  assert.equal(post[2].name, 'alerts');
  assert.equal(post[2].type, ChannelType.GuildText, 'never an announcement channel');
  const [everyone, staff, bot] = post[2].permission_overwrites;
  assert.equal(everyone.id, GUILD);
  assert.ok(BigInt(everyone.deny) & VIEW, '@everyone can’t see it');
  assert.equal(staff.id, ID(7));
  assert.ok(BigInt(staff.allow) & VIEW);
  assert.equal(bot.id, BOT);
  assert.ok(BigInt(bot.allow) & VIEW && BigInt(bot.allow) & 2048n && BigInt(bot.allow) & 16384n);
  assert.deepEqual(r.done, ['Created the private channel #alerts (only Staff and the bot)']);
  assert.deepEqual(r.warnings, []);
  // Ohne Rolle: nur Bot und Admins – mit Hinweis
  const rest2 = fakeRest([]);
  const r2 = await ensureNamedChannel(rest2, GUILD, 'ALERTS_CHANNEL_ID', { TEAM_ROLE_ID: 'x' });
  assert.equal(writes(rest2)[0][2].permission_overwrites.length, 2);
  assert.match(r2.warnings[0], /give your team’s role access/);
});

test('an existing #alerts is used unchanged – with a note when everyone can see it', async () => {
  const VIEW = String(1024n);
  const cases = [
    [{ id: ID(30), name: 'alerts', type: ChannelType.GuildText, permission_overwrites: [] }, true],
    [{ id: ID(30), name: 'alerts', type: ChannelType.GuildText, permission_overwrites: [{ id: GUILD, type: 0, deny: VIEW, allow: '0' }] }, false],
    [{ id: ID(30), name: 'alerts', type: ChannelType.GuildText, parent_id: ID(5), permission_overwrites: [] }, false],
    [{ id: ID(30), name: 'alerts', type: ChannelType.GuildText, parent_id: ID(5), permission_overwrites: [{ id: GUILD, type: 0, allow: VIEW, deny: '0' }] }, true],
  ];
  for (const [channel, warn] of cases) {
    const rest = fakeRest([{ id: ID(5), name: 'Team', type: ChannelType.GuildCategory, permission_overwrites: [{ id: GUILD, type: 0, deny: VIEW, allow: '0' }] }, channel]);
    const r = await ensureNamedChannel(rest, GUILD, 'ALERTS_CHANNEL_ID', {});
    assert.equal(r.id, ID(30));
    assert.deepEqual(writes(rest), [], 'nothing is changed');
    assert.equal(r.warnings.length, warn ? 1 : 0, JSON.stringify(channel));
    if (warn) assert.match(r.warnings[0], /Everyone on the server can see #alerts/);
  }
});

// index.js als eigener Prozess (wie install.sh es aufruft)
function run(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [INDEX, ...args], { env: { PATH: process.env.PATH, ...env }, timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}
const lines = (out) => out.trim().split('\n').filter(Boolean);

test('--channel-keys lists the channels this version knows, without a token', async () => {
  const r = await run(['--channel-keys'], {});
  assert.equal(r.code, 0);
  assert.deepEqual(lines(r.stdout), ['UPDATES_CHANNEL_ID=updates', 'STATUS_CHANNEL_ID=status', 'ALERTS_CHANNEL_ID=alerts']);
});

test('--discord-channel creates #updates once, then finds it; Discord’s refusal is an error with its message', async () => {
  const d = await startFakeDiscord({ community: true });
  try {
    const env = { DISCORD_TOKEN: d.token, DISCORD_API_BASE: d.base };
    const first = await run(['--discord-channel', 'UPDATES_CHANNEL_ID', d.guildId], env);
    assert.equal(first.code, 0, first.stderr);
    const id = d.state.channels.find((c) => c.name === 'updates').id;
    assert.deepEqual(lines(first.stdout), [`UPDATES_CHANNEL_ID=${id}`, 'DONE=Created channel #updates']);
    assert.equal(d.state.channels.find((c) => c.id === id).type, ChannelType.GuildAnnouncement);
    const second = await run(['--discord-channel', 'UPDATES_CHANNEL_ID', d.guildId], { ...env, UPDATES_CHANNEL_ID: id });
    assert.deepEqual(lines(second.stdout), [`UPDATES_CHANNEL_ID=${id}`, 'DONE=Using your existing #updates']);
    assert.equal(d.writes().length, 1, 'one channel, nothing else changed');
    // Discord lehnt ab: Exit-Code 1, Discords Meldung auf stderr, nichts auf stdout
    d.state.channels = d.state.channels.filter((c) => c.id !== id);
    d.state.failCreate = { status: 403, code: 50013, message: 'Missing Permissions' };
    const refused = await run(['--discord-channel', 'UPDATES_CHANNEL_ID', d.guildId], env);
    assert.equal(refused.code, 1);
    assert.equal(refused.stdout, '');
    assert.match(refused.stderr, /Missing Permissions \(HTTP 403\)/);
    // Falscher Aufruf
    assert.equal((await run(['--discord-channel', 'FOO', d.guildId], env)).code, 1);
    assert.equal((await run(['--discord-channel', 'UPDATES_CHANNEL_ID', 'x'], env)).code, 1);
    // Ohne Token kein Zugriff
    assert.equal((await run(['--discord-channel', 'UPDATES_CHANNEL_ID', d.guildId], { DISCORD_API_BASE: d.base })).code, 1);
  } finally {
    await d.close();
  }
});

// Volle Einrichtung (--discord-setup): legt #updates mit an und gibt UPDATES_CHANNEL_ID aus; ein zweiter Lauf mit den
// gespeicherten IDs legt nichts neu an
async function fullSetupTwice(base, token, guildId) {
  const env = { DISCORD_TOKEN: token, DISCORD_API_BASE: base };
  const first = await run(['--discord-setup', guildId], env);
  assert.equal(first.code, 0, first.stderr);
  const ids = Object.fromEntries(lines(first.stdout).filter((l) => /^[A-Z_]+_ID=/.test(l)).map((l) => l.split('=')));
  assert.match(ids.UPDATES_CHANNEL_ID, /^\d{17,20}$/);
  assert.ok(lines(first.stdout).some((l) => /^DONE=Created channel #updates/.test(l)), first.stdout);
  const second = await run(['--discord-setup', guildId], { ...env, ...ids });
  assert.equal(second.code, 0, second.stderr);
  const again = Object.fromEntries(lines(second.stdout).filter((l) => /^[A-Z_]+_ID=/.test(l)).map((l) => l.split('=')));
  assert.equal(again.UPDATES_CHANNEL_ID, ids.UPDATES_CHANNEL_ID);
  assert.ok(lines(second.stdout).includes('DONE=Using your existing #updates'));
  return { first, second };
}

test('the full setup adds #updates next to the other channels and reuses it on the next run', async () => {
  const d = await startFakeDiscord({ community: false });
  try {
    const { first } = await fullSetupTwice(d.base, d.token, d.guildId);
    // #status und #alerts (privat, für die Rolle Staff) entstehen mit – je einmal
    const ids = Object.fromEntries(lines(first.stdout).filter((l) => /^[A-Z_]+_ID=/.test(l)).map((l) => l.split('=')));
    const alerts = d.state.channels.find((c) => c.name === 'alerts');
    assert.equal(ids.STATUS_CHANNEL_ID, d.state.channels.find((c) => c.name === 'status').id);
    assert.equal(ids.ALERTS_CHANNEL_ID, alerts.id);
    assert.ok(alerts.permission_overwrites.some((o) => o.id === ids.TEAM_ROLE_ID), 'Staff sees #alerts');
    assert.ok(alerts.permission_overwrites.some((o) => o.id === d.guildId && BigInt(o.deny) & 1024n), '@everyone doesn’t');
    const made = d.writes().filter((c) => c.method === 'POST' && /\/channels$/.test(c.path));
    assert.equal(made.filter((c) => c.body.name === 'status').length, 1);
    assert.equal(made.filter((c) => c.body.name === 'alerts').length, 1);
    const created = d.writes().filter((c) => c.method === 'POST' && /\/channels$/.test(c.path));
    assert.equal(created.filter((c) => c.body.name === 'updates').length, 1, '#updates is created once');
    const updates = d.state.channels.find((c) => c.name === 'updates');
    const category = d.state.channels.find((c) => c.name === 'OnYourSite');
    assert.equal(updates.parent_id, category.id);
    assert.equal(updates.type, ChannelType.GuildText);
    // Am vorhandenen #updates ändert der zweite Lauf nichts
    assert.equal(d.writes().filter((c) => c.path.includes(updates.id)).length, 0);
  } finally {
    await d.close();
  }
});

test('the setup also works against the separate Discord stand-in (only with OYS_DISCORD_SETUP_MOCK)', { skip: !process.env.OYS_DISCORD_SETUP_MOCK }, async () => {
  const base = process.env.OYS_DISCORD_SETUP_MOCK;
  const root = base.replace(/\/api\/?$/, '');
  await fetch(`${root}/__reset`, { method: 'POST' });
  const state = await (await fetch(`${root}/__state`)).json();
  const guildId = Object.keys(state.guilds)[0];
  const token = ['MTEx', crypto.randomBytes(18).toString('base64url'), crypto.randomBytes(20).toString('base64url')].join('.');
  await fullSetupTwice(base, token, guildId);
  // Ein einzelner Kanal nach dem Entfernen von #updates: wird neu angelegt, sonst nichts
  await fetch(`${root}/__reset`, { method: 'POST' });
  const one = await run(['--discord-channel', 'UPDATES_CHANNEL_ID', guildId], { DISCORD_TOKEN: token, DISCORD_API_BASE: base });
  assert.equal(one.code, 0, one.stderr);
  const after = await (await fetch(`${root}/__state`)).json();
  assert.deepEqual(after.channels[guildId].map((c) => c.name), ['general', 'updates']);
});
