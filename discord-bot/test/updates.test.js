'use strict';
// Updates der Webseite in Discord: posten (Text, Ankündigung, Forum, archivierter Thread), Rechte, Nonce, nach einem
// eigenen Beitrag sehen (recheck, only_if_posted), bearbeiten und entfernen – mit nachgebauten Discord-Objekten.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType } = require('discord.js');
const { setupUpdates } = require('../src/updates');
const { apiError, perms, FakeChannel, FakeThread, FakeForum, FakeMessage, fakeClient } = require('./fakes');

const URL = 'https://on-your.site/updates/12';
const message = (over = {}) => ({
  content: '<@&930000000000000001>',
  embeds: [{ title: '2.5 – Own pages', url: URL, color: 2278750, author: { name: 'New' }, footer: { text: 'OnYourSite Updates' } }],
  allowed_mentions: { parse: [], roles: ['930000000000000001'] },
  ...over,
});
const job = (id = 41, action = 'update.post') => ({ id, action });

test('update.post into a text and an announcement channel: embed, explicit pings, nonce against double posts', async () => {
  for (const type of [ChannelType.GuildText, ChannelType.GuildAnnouncement]) {
    const ch = new FakeChannel({ type });
    const u = setupUpdates(fakeClient([ch]));
    const r = await u.post({ post_id: 7, channel_id: ch.id, kind: type === ChannelType.GuildText ? 'text' : 'announcement', thread_name: '2.5 – Own pages', message: message() }, job());
    assert.deepEqual(r, { message_id: ch.sent[0].id, channel_id: ch.id });
    const p = ch.sent[0].payload;
    assert.equal(p.nonce, 'oys-update.post-41');
    assert.equal(p.enforceNonce, true);
    assert.equal(p.content, '<@&930000000000000001>');
    assert.deepEqual(p.allowedMentions, { parse: [], roles: ['930000000000000001'] });
    assert.equal(p.embeds[0].url, URL);
  }
  // Ohne allowed_mentions pingt niemand
  const ch = new FakeChannel();
  await setupUpdates(fakeClient([ch])).post({ channel_id: ch.id, message: { embeds: [] } }, job(1));
  assert.deepEqual(ch.sent[0].payload.allowedMentions, { parse: [] });
  assert.equal(ch.sent[0].payload.content, undefined);
  // Nonce höchstens 25 Zeichen
  await setupUpdates(fakeClient([ch])).post({ channel_id: ch.id, message: { embeds: [] } }, job(123456789012));
  assert.ok(ch.sent[1].payload.nonce.length <= 25);
});

test('update.post into a forum creates a post titled like the update; into an archived thread it reopens it first', async () => {
  const forum = new FakeForum();
  const u = setupUpdates(fakeClient([forum]));
  const r = await u.post({ channel_id: forum.id, kind: 'forum', thread_name: '2.5 – Own pages', message: message() }, job());
  const post = forum.posts[0];
  assert.equal(post.name, '2.5 – Own pages');
  assert.deepEqual(r, { message_id: post.id, channel_id: post.id }, 'a forum post’s starter message has the post’s ID');
  const thread = new FakeThread({ archived: true });
  await setupUpdates(fakeClient([thread])).post({ channel_id: thread.id, kind: 'thread', message: message() }, job());
  assert.equal(thread.archived, false);
  assert.equal(thread.sent.length, 1);
});

test('missing permissions are a final error that names them; an unknown channel too; Discord trouble is retried', async () => {
  const ch = new FakeChannel({ name: 'updates', perms: perms('ViewChannel') });
  await assert.rejects(setupUpdates(fakeClient([ch])).post({ channel_id: ch.id, message: message() }, job()),
    (err) => err.final === true && err.message === 'The bot can’t post in #updates: it needs Send Messages, Embed Links there.');
  const thread = new FakeThread({ name: 'notes', perms: perms('ViewChannel', 'SendMessages', 'EmbedLinks') });
  await assert.rejects(setupUpdates(fakeClient([thread])).post({ channel_id: thread.id, message: message() }, job()),
    (err) => err.final === true && /needs Send Messages in Threads there/.test(err.message));
  await assert.rejects(setupUpdates(fakeClient([])).post({ channel_id: '900000000000000555', message: message() }, job()),
    (err) => err.final === true && err.message === 'The channel no longer exists.');
  const busy = new FakeChannel();
  busy.failSend = apiError(500, 0, 'Internal Server Error');
  await assert.rejects(setupUpdates(fakeClient([busy])).post({ channel_id: busy.id, message: message() }, job()), (err) => err.final === false);
  busy.failSend = Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' });
  await assert.rejects(setupUpdates(fakeClient([busy])).post({ channel_id: busy.id, message: message() }, job()), (err) => err.final === false);
  busy.failSend = apiError(400, 50008, 'Cannot send messages in a non-text channel');
  await assert.rejects(setupUpdates(fakeClient([busy])).post({ channel_id: busy.id, message: message() }, job()),
    (err) => err.final === true && /\(50008\)$/.test(err.message));
});

test('recheck finds the bot’s earlier post and posts nothing; only_if_posted without a match posts nothing', async () => {
  const ch = new FakeChannel();
  ch.sent.push(new FakeMessage(ch, { embeds: [{ url: URL }] }, '900000000000000777')); // anderer Absender
  const own = new FakeMessage(ch, { embeds: [{ url: URL }] });
  ch.sent.push(own);
  const u = setupUpdates(fakeClient([ch]));
  assert.deepEqual(await u.post({ channel_id: ch.id, recheck: true, message: message() }, job()), { message_id: own.id, channel_id: ch.id, found: true });
  assert.equal(ch.sent.length, 2, 'nothing posted');
  // Nichts gefunden: recheck postet, only_if_posted nicht
  const empty = new FakeChannel();
  const u2 = setupUpdates(fakeClient([empty]));
  assert.deepEqual(await u2.post({ channel_id: empty.id, only_if_posted: true, recheck: true, message: message() }, job()), { found: false });
  assert.equal(empty.sent.length, 0);
  assert.ok((await u2.post({ channel_id: empty.id, recheck: true, message: message() }, job())).message_id);
  assert.equal(empty.sent.length, 1);
  // Im Forum: der eigene Beitrag mit demselben Titel und Link
  const forum = new FakeForum();
  const u3 = setupUpdates(fakeClient([forum]));
  await u3.post({ channel_id: forum.id, thread_name: '2.5 – Own pages', message: message() }, job());
  const again = await u3.post({ channel_id: forum.id, thread_name: '2.5 – Own pages', only_if_posted: true, message: message() }, job());
  assert.deepEqual(again, { message_id: forum.posts[0].id, channel_id: forum.posts[0].id, found: true });
  assert.equal(forum.posts.length, 1);
});

test('update.edit changes only the embed (never pings again) and renames a forum post; a deleted message is "missing"', async () => {
  const ch = new FakeChannel();
  const m = await ch.send({ content: '@here', embeds: [{ title: 'Old', url: URL }] });
  const u = setupUpdates(fakeClient([ch]));
  assert.deepEqual(await u.edit({ channel_id: ch.id, message_id: m.id, kind: 'message', message: { embeds: [{ title: 'New', url: URL }], content: '@everyone' } }), {});
  assert.deepEqual(m.edits, [{ embeds: [{ title: 'New', url: URL }] }]);
  assert.deepEqual(await u.edit({ channel_id: ch.id, message_id: '900000000000000444', kind: 'message', message: { embeds: [] } }), { missing: true });
  assert.deepEqual(await u.edit({ channel_id: '900000000000000555', message_id: m.id, kind: 'message', message: { embeds: [] } }), { missing: true });
  // Nachricht einer anderen Anwendung (alter Token): endgültig, mit Discords Code
  ch.failEdit = apiError(403, 50005, 'Cannot edit a message authored by another user');
  await assert.rejects(u.edit({ channel_id: ch.id, message_id: m.id, kind: 'message', message: { embeds: [] } }),
    (err) => err.final === true && err.message === 'Cannot edit a message authored by another user (50005)');
  // Forenbeitrag: Titel folgt dem Update
  const forum = new FakeForum();
  const uf = setupUpdates(fakeClient([forum]));
  const r = await uf.post({ channel_id: forum.id, thread_name: 'Old title', message: message() }, job());
  const post = forum.posts[0];
  setupUpdates(fakeClient([forum, post]));
  const u4 = setupUpdates(fakeClient([post]));
  assert.deepEqual(await u4.edit({ channel_id: r.channel_id, message_id: r.message_id, kind: 'forum_post', thread_name: 'New title', message: { embeds: [{ url: URL }] } }), {});
  assert.deepEqual(post.renamed, ['New title']);
});

test('update.delete removes the message or the whole forum post (without the right: its first message); gone is fine', async () => {
  const ch = new FakeChannel();
  const m = await ch.send({ embeds: [] });
  const u = setupUpdates(fakeClient([ch]));
  assert.deepEqual(await u.remove({ channel_id: ch.id, message_id: m.id, kind: 'message' }), {});
  assert.equal(m.deleted, true);
  assert.deepEqual(await u.remove({ channel_id: ch.id, message_id: m.id, kind: 'message' }), { missing: true });
  assert.deepEqual(await u.remove({ channel_id: '900000000000000556', message_id: m.id, kind: 'message' }), { missing: true });
  const forum = new FakeForum();
  await setupUpdates(fakeClient([forum])).post({ channel_id: forum.id, thread_name: 'T', message: message() }, job());
  const post = forum.posts[0];
  assert.deepEqual(await setupUpdates(fakeClient([post])).remove({ channel_id: post.id, message_id: post.id, kind: 'forum_post' }), {});
  assert.equal(post.deletedThread, true);
  // 403 beim Löschen des Beitrags: dann seine erste Nachricht
  await setupUpdates(fakeClient([forum])).post({ channel_id: forum.id, thread_name: 'T2', message: message() }, job());
  const post2 = forum.posts[1];
  post2.failDelete = apiError(403, 50013, 'Missing Permissions');
  const logs = [];
  assert.deepEqual(await setupUpdates(fakeClient([post2]), (l) => logs.push(l)).remove({ channel_id: post2.id, message_id: post2.id, kind: 'forum_post' }), {});
  assert.equal(post2.deletedThread, false);
  assert.equal(post2.sent.length, 0, 'the starter message is gone');
  assert.equal(logs.length, 1);
});

test('update.edit and update.delete reopen an archived forum post or thread first (Discord refuses changes there)', async () => {
  // Forenbeitrag, den Discord nach einer Weile archiviert hat: Embed und Titel ändern
  const forum = new FakeForum();
  const r = await setupUpdates(fakeClient([forum])).post({ channel_id: forum.id, thread_name: 'Old title', message: message() }, job());
  const post = forum.posts[0];
  post.archived = true;
  assert.deepEqual(await setupUpdates(fakeClient([post])).edit({ channel_id: r.channel_id, message_id: r.message_id, kind: 'forum_post', thread_name: 'New title', message: { embeds: [{ title: 'New', url: URL }] } }), {});
  assert.equal(post.archived, false);
  assert.deepEqual(post.sent[0].edits, [{ embeds: [{ title: 'New', url: URL }] }]);
  assert.deepEqual(post.renamed, ['New title']);
  // Nachricht in einem archivierten Thread: bearbeiten und entfernen
  const thread = new FakeThread();
  const u = setupUpdates(fakeClient([thread]));
  const sent = await u.post({ channel_id: thread.id, kind: 'thread', message: message() }, job());
  thread.archived = true;
  assert.deepEqual(await u.edit({ channel_id: thread.id, message_id: sent.message_id, kind: 'thread_msg', message: { embeds: [{ title: 'Fixed', url: URL }] } }), {});
  assert.equal(thread.archived, false);
  thread.archived = true;
  assert.deepEqual(await u.remove({ channel_id: thread.id, message_id: sent.message_id, kind: 'thread_msg' }), {});
  assert.equal(thread.sent.length, 0);
  // Eine schon gelöschte Nachricht öffnet den Thread nicht
  thread.archived = true;
  assert.deepEqual(await u.edit({ channel_id: thread.id, message_id: sent.message_id, kind: 'thread_msg', message: { embeds: [] } }), { missing: true });
  assert.equal(thread.archived, true);
});

test('update.test posts the test message (in a forum as a post "OnYourSite test")', async () => {
  const ch = new FakeChannel();
  const r = await setupUpdates(fakeClient([ch])).test({ channel_id: ch.id, kind: 'text', message: { embeds: [{ title: 'Discord is connected' }], allowed_mentions: { parse: [] } } }, job(5, 'update.test'));
  assert.equal(ch.sent[0].payload.embeds[0].title, 'Discord is connected');
  assert.equal(r.channel_id, ch.id);
  const forum = new FakeForum();
  await setupUpdates(fakeClient([forum])).test({ channel_id: forum.id, kind: 'forum', message: { embeds: [] } }, job(6, 'update.test'));
  assert.equal(forum.posts[0].name, 'OnYourSite test');
});
