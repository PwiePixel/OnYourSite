'use strict';
// Bericht an die Webseite: welche Kanäle, Threads und Rollen hineingehören, die eigenen Rechte, wie der Bot läuft, und
// das 48-KB-Budget (erst Threads weg, dann Kanäle ohne Rechte, dann kürzen – #updates bleibt).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType } = require('discord.js');
const { buildReport, runtime, gatewayOf, BUDGET } = require('../src/report');
const { perms, ALL } = require('./fakes');

const GUILD = '920000000000000001';
const ID = (n) => String(920000000000000000n + BigInt(n));
const me = { id: ID(999) };

function chan(id, name, type, o = {}) {
  return {
    id, name, type, parentId: o.parentId || null, rawPosition: o.position || 0, archived: Boolean(o.archived),
    permissionsFor: (who) => (who && who.id === GUILD ? (o.everyone || perms('ViewChannel')) : (o.perms || perms(...ALL))),
    isThread: () => [ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread].includes(type),
  };
}

function guild(channels, roles = [], features = ['COMMUNITY']) {
  return {
    id: GUILD, name: 'OnYourSite', features,
    channels: { cache: new Map(channels.map((c) => [c.id, c])) },
    roles: { cache: new Map(roles.map((r) => [r.id, r])) },
    members: { me },
  };
}

const cfg = { supportCategoryId: ID(50), suggestionForumId: ID(30), updatesChannelId: ID(10) };

test('report: text, announcement and forum channels with the bot’s permissions – without ticket channels, suggestion posts or managed roles', () => {
  const g = guild([
    chan(ID(1), 'OnYourSite', ChannelType.GuildCategory),
    chan(ID(10), 'updates', ChannelType.GuildAnnouncement, { parentId: ID(1), position: 1 }),
    chan(ID(11), 'general', ChannelType.GuildText, { position: 2, perms: perms('ViewChannel', 'ReadMessageHistory') }),
    chan(ID(12), 'changelog', ChannelType.GuildForum, { position: 3, perms: perms('ViewChannel', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory') }),
    chan(ID(13), 'voice', ChannelType.GuildVoice),
    chan(ID(30), 'suggestions', ChannelType.GuildForum, { position: 4 }),
    chan(ID(31), 'My idea', ChannelType.PublicThread, { parentId: ID(30) }),
    chan(ID(32), 'Release notes', ChannelType.PublicThread, { parentId: ID(11) }),
    chan(ID(33), 'Old notes', ChannelType.PublicThread, { parentId: ID(11), archived: true }),
    chan(ID(50), 'Tickets', ChannelType.GuildCategory),
    chan(ID(51), 'ticket-1', ChannelType.GuildText, { parentId: ID(50) }),
    chan(ID(52), 'in ticket', ChannelType.PrivateThread, { parentId: ID(51) }),
  ], [
    { id: GUILD, name: '@everyone', managed: false, mentionable: true, position: 0 },
    { id: ID(60), name: 'Update pings', managed: false, mentionable: true, position: 2 },
    { id: ID(61), name: 'OnYourSite', managed: true, mentionable: false, position: 3 },
  ]);
  const r = buildReport(g, me, cfg, ['updates.v1']);
  assert.equal(r.version, require('../package.json').version);
  assert.deepEqual(r.features, ['updates.v1']);
  assert.deepEqual(r.guild, { id: GUILD, name: 'OnYourSite', community: true });
  assert.equal(r.updates_channel_id, ID(10));
  assert.deepEqual(r.channels.map((c) => c.name), ['updates', 'general', 'changelog'], 'no voice channel, no ticket channels, not the suggestion forum');
  const [updates, general, changelog] = r.channels;
  assert.deepEqual(updates, { id: ID(10), name: 'updates', type: 'announcement', parent_id: ID(1), can_post: true, can_mention_everyone: true, missing: [], everyone_can_view: true });
  assert.deepEqual([general.can_post, general.missing], [false, ['SendMessages', 'EmbedLinks']]);
  assert.deepEqual([changelog.type, changelog.can_post, changelog.can_mention_everyone, changelog.missing], ['forum', true, false, ['ManageThreads']]);
  assert.deepEqual(r.categories, [{ id: ID(1), name: 'OnYourSite' }]);
  assert.deepEqual(r.threads.map((t) => t.name), ['Release notes'], 'no suggestion posts, no archived threads, nothing from tickets');
  assert.deepEqual(r.roles, [{ id: ID(60), name: 'Update pings', mentionable: true }]);
  assert.equal(r.truncated, false);
  assert.ok(Buffer.byteLength(JSON.stringify(r)) < BUDGET);
});

test('report: over 48 KB it drops threads, then channels the bot can’t post in, then cuts the list – #updates stays', () => {
  const long = (i) => 'ü'.repeat(90) + i;
  const channels = [chan(ID(10), 'updates', ChannelType.GuildText, { position: 999 })];
  for (let i = 0; i < 160; i++) channels.push(chan(ID(100 + i), long(i), ChannelType.GuildText, { position: i, perms: i % 2 ? perms('ViewChannel') : perms(...ALL) }));
  for (let i = 0; i < 40; i++) channels.push(chan(ID(400 + i), long(i), ChannelType.PublicThread, { parentId: ID(100) }));
  const roles = Array.from({ length: 100 }, (_, i) => ({ id: ID(600 + i), name: long(i), managed: false, mentionable: true, position: i }));
  const r = buildReport(guild(channels, roles, []), me, cfg, ['updates.v1']);
  assert.ok(Buffer.byteLength(JSON.stringify(r)) <= BUDGET, `size ${Buffer.byteLength(JSON.stringify(r))}`);
  assert.equal(r.truncated, true);
  assert.deepEqual(r.threads, []);
  assert.ok(r.channels.every((c) => c.can_post), 'channels without permissions go first');
  assert.ok(r.channels.some((c) => c.id === ID(10)), '#updates stays');
  assert.equal(r.guild.community, false);
  // Grenzen der Webseite: höchstens 200 Kanäle und 50 Threads
  const many = [];
  for (let i = 0; i < 230; i++) many.push(chan(ID(1000 + i), 'c' + i, ChannelType.GuildText, { position: i }));
  const r2 = buildReport(guild(many), me, { ...cfg, updatesChannelId: ID(1225) }, []);
  assert.equal(r2.channels.length, 200);
  assert.equal(r2.truncated, true);
  assert.equal(r2.channels[199].id, ID(1225), '#updates stays in the list');
});

test('report: the runtime comes from OYS_BOT_RUNTIME (service, docker), else "other"', () => {
  const old = process.env.OYS_BOT_RUNTIME;
  try {
    for (const [value, want] of [['service', 'service'], ['docker', 'docker'], ['k8s', 'other'], [undefined, 'other']]) {
      if (value === undefined) delete process.env.OYS_BOT_RUNTIME;
      else process.env.OYS_BOT_RUNTIME = value;
      assert.equal(runtime(), want);
    }
  } finally {
    if (old === undefined) delete process.env.OYS_BOT_RUNTIME;
    else process.env.OYS_BOT_RUNTIME = old;
  }
});

test('report 0.3.0: the connection to Discord (gateway) and the suggested #status and #alerts – both stay in a cut list', () => {
  const channels = [
    chan(ID(10), 'updates', ChannelType.GuildText, { position: 1 }),
    chan(ID(20), 'status', ChannelType.GuildAnnouncement, { position: 900 }),
    chan(ID(21), 'alerts', ChannelType.GuildText, { position: 901 }),
  ];
  for (let i = 0; i < 230; i++) channels.push(chan(ID(1000 + i), 'c' + i, ChannelType.GuildText, { position: 10 + i }));
  const own = { ...cfg, statusChannelId: ID(20), alertsChannelId: ID(21) };
  const r = buildReport(guild(channels), me, own, ['updates.v1', 'suggestions.v2', 'status.v1'], { ready: true, ping_ms: 42 });
  assert.deepEqual(r.gateway, { ready: true, ping_ms: 42 });
  assert.equal(r.status_channel_id, ID(20));
  assert.equal(r.alerts_channel_id, ID(21));
  assert.equal(r.channels.length, 200);
  for (const id of [ID(10), ID(20), ID(21)]) assert.ok(r.channels.some((c) => c.id === id), `${id} stays in the list`);
  // Ohne Angaben: leere IDs und kein gateway (ältere Aufrufer)
  const plain = buildReport(guild(channels.slice(0, 3)), me, cfg, []);
  assert.equal(plain.status_channel_id, '');
  assert.equal(plain.alerts_channel_id, '');
  assert.equal('gateway' in plain, false);
});

test('gateway: ready from discord.js, the ping rounded; before the first heartbeat (-1) it is 0', () => {
  assert.deepEqual(gatewayOf({ isReady: () => true, ws: { ping: 41.6 } }), { ready: true, ping_ms: 42 });
  assert.deepEqual(gatewayOf({ isReady: () => false, ws: { ping: -1 } }), { ready: false, ping_ms: 0 });
  assert.deepEqual(gatewayOf(null), { ready: false, ping_ms: 0 });
});

test('report: whether everyone on the server can see a channel – without the @everyone role a channel counts as visible', () => {
  const channels = [
    chan(ID(20), 'status', ChannelType.GuildAnnouncement, { position: 1 }),
    chan(ID(21), 'alerts', ChannelType.GuildText, { position: 2, everyone: perms() }),
  ];
  const everyone = [{ id: GUILD, name: '@everyone', managed: false, mentionable: true, position: 0 }];
  const r = buildReport(guild(channels, everyone), me, cfg, ['status.v1']);
  assert.deepEqual(r.channels.map((c) => [c.name, c.everyone_can_view]), [['status', true], ['alerts', false]]);
  const unknown = buildReport(guild(channels), me, cfg, ['status.v1']);
  assert.deepEqual(unknown.channels.map((c) => c.everyone_can_view), [true, true]);
});
