'use strict';
// Statusseite in Discord (status.v1): Beiträge zu Vorfällen in #status (posten mit Nonce, nach dem eigenen Beitrag
// sehen, bearbeiten ohne neuen Ping, löschen, in Discord gelöscht = missing) und Meldungen ans Team in #alerts – mit
// nachgebauten Discord-Objekten. Dazu: der Bot meldet status.v1 und hat für jede Aktion einen Handler.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ChannelType } = require('discord.js');
const { setupUpdates } = require('../src/updates');
const { setupStatus } = require('../src/status');
const { perms, FakeChannel, FakeForum, FakeMessage, fakeClient } = require('./fakes');

const URL = 'https://status.on-your.site/incidents/12';
const incident = (over = {}) => ({
  embeds: [{ title: 'Investigating · Website is slow', url: URL, color: 0xf59e0b, fields: [{ name: 'Affected', value: 'Website', inline: true }] }],
  ...over,
});
const job = (id, action) => ({ id, action });
const statusOf = (channels) => {
  const client = fakeClient(channels);
  return setupStatus(client, setupUpdates(client));
};

test('status.post posts the incident embed with a nonce and pings nobody; the result carries the message ID', async () => {
  for (const type of [ChannelType.GuildText, ChannelType.GuildAnnouncement]) {
    const ch = new FakeChannel({ name: 'status', type });
    const r = await statusOf([ch]).post({ post_id: 3, incident_id: 12, channel_id: ch.id, message: incident(), incident_url: URL }, job(77, 'status.post'));
    assert.deepEqual(r, { message_id: ch.sent[0].id, channel_id: ch.id });
    const p = ch.sent[0].payload;
    assert.equal(p.nonce, 'oys-status.post-77');
    assert.equal(p.enforceNonce, true);
    assert.deepEqual(p.allowedMentions, { parse: [] }, 'no pings');
    assert.equal(p.content, undefined);
    assert.equal(p.embeds[0].url, URL);
  }
});

test('status.post after a lost answer finds the bot’s own post first; only_if_posted without a post posts nothing', async () => {
  const ch = new FakeChannel({ name: 'status' });
  ch.sent.push(new FakeMessage(ch, { embeds: [{ url: URL }] }, '900000000000000777')); // jemand anderes
  const own = new FakeMessage(ch, { embeds: [{ url: URL }] });
  ch.sent.push(own);
  const s = statusOf([ch]);
  assert.deepEqual(await s.post({ channel_id: ch.id, recheck: true, message: incident() }, job(78, 'status.post')), { message_id: own.id, channel_id: ch.id, found: true });
  assert.equal(ch.sent.length, 2, 'nothing new');
  const empty = new FakeChannel({ name: 'status' });
  assert.deepEqual(await statusOf([empty]).post({ channel_id: empty.id, only_if_posted: true, message: incident() }, job(79, 'status.post')), { found: false });
  assert.equal(empty.sent.length, 0);
});

test('a forum, an unknown channel or missing permissions are final errors; Discord trouble is retried', async () => {
  const forum = new FakeForum({ name: 'status' });
  await assert.rejects(statusOf([forum]).post({ channel_id: forum.id, message: incident() }, job(1, 'status.post')),
    (err) => err.final === true && /can’t go to a forum/.test(err.message));
  assert.equal(forum.posts.length, 0);
  await assert.rejects(statusOf([]).alert({ channel_id: '900000000000000555', message: incident() }, job(2, 'status.alert')),
    (err) => err.final === true && err.message === 'The channel no longer exists.');
  await assert.rejects(statusOf([]).post({ channel_id: 'nope', message: incident() }, job(3, 'status.post')), (err) => err.final === true);
  const locked = new FakeChannel({ name: 'alerts', perms: perms('ViewChannel', 'SendMessages') });
  await assert.rejects(statusOf([locked]).alert({ channel_id: locked.id, message: incident() }, job(4, 'status.alert')),
    (err) => err.final === true && err.message === 'The bot can’t post in #alerts: it needs Embed Links there.');
  const busy = new FakeChannel({ name: 'status' });
  busy.failSend = Object.assign(new Error('Internal Server Error'), { status: 500, code: 0 });
  await assert.rejects(statusOf([busy]).post({ channel_id: busy.id, message: incident() }, job(5, 'status.post')), (err) => err.final === false);
});

test('status.edit changes only the embed (no new ping); a message deleted in Discord is reported as missing', async () => {
  const ch = new FakeChannel({ name: 'status' });
  const msg = new FakeMessage(ch, incident());
  ch.sent.push(msg);
  const s = statusOf([ch]);
  const next = incident({ embeds: [{ title: 'Resolved · Website is slow', url: URL, color: 0x22c55e }], content: '@everyone' });
  assert.deepEqual(await s.edit({ post_id: 3, channel_id: ch.id, message_id: msg.id, message: next }), {});
  assert.deepEqual(msg.edits, [{ embeds: next.embeds }], 'only the embed – never content');
  assert.deepEqual(await s.edit({ channel_id: ch.id, message_id: '910000000000099999', message: next }), { missing: true });
  assert.deepEqual(await s.edit({ channel_id: '900000000000000555', message_id: msg.id, message: next }), { missing: true }, 'channel gone');
});

test('status.delete removes the message; already gone is fine (missing)', async () => {
  const ch = new FakeChannel({ name: 'status' });
  const msg = new FakeMessage(ch, incident());
  ch.sent.push(msg);
  const s = statusOf([ch]);
  assert.deepEqual(await s.remove({ channel_id: ch.id, message_id: msg.id }), {});
  assert.equal(msg.deleted, true);
  assert.deepEqual(await s.remove({ channel_id: ch.id, message_id: msg.id }), { missing: true });
});

test('status.alert posts one message in the team channel with a nonce', async () => {
  const ch = new FakeChannel({ name: 'alerts' });
  const alert = { embeds: [{ title: 'Website is down', description: 'Timeout after 10 s.', color: 0xef4444, url: 'https://on-your.site/dashboard#status/system' }] };
  const r = await statusOf([ch]).alert({ channel_id: ch.id, message: alert }, job(90, 'status.alert'));
  assert.deepEqual(r, { message_id: ch.sent[0].id, channel_id: ch.id });
  assert.equal(ch.sent[0].payload.nonce, 'oys-status.alert-90');
  assert.deepEqual(ch.sent[0].payload.allowedMentions, { parse: [] });
});

test('version 0.3.0 reports status.v1 and handles every status.* job', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.equal(require('../package.json').version, '0.3.0');
  assert.match(index, /const FEATURES = \['updates\.v1', 'suggestions\.v2', 'status\.v1'\];/);
  for (const action of ['status.post', 'status.edit', 'status.delete', 'status.alert']) assert.ok(index.includes(`'${action}': `), action);
});
