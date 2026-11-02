'use strict';
// Vorschläge und die öffentliche Vorschlagsseite: Hinweis im Status-Embed und web_notice, gelöschte Beiträge über rohe
// Gateway-Ereignisse (mit einem echten, nicht angemeldeten Client), die tägliche Prüfung (Fehlercodes, höchstens eine
// Anfrage je Pause) und der Satz in den Richtlinien des Forums.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { Client, Events, Status } = require('discord.js');
const { setupSuggestions, statusEmbed, guidelines } = require('../src/suggestions');
const { apiError } = require('./fakes');

const GUILD = '960000000000000001';
const FORUM = '960000000000000002';
const ID = (n) => String(960000000000000000n + BigInt(n));
const cfg = { guildId: GUILD, suggestionForumId: FORUM, teamRoleId: '', tagAcceptedId: '', tagDeclinedId: '' };
const SENTENCE = 'Decided ideas are shown on on-your.site/suggestions without your name.';

// Webseite: zeichnet Anfragen auf; answer(route, body) bestimmt die Antwort
function fakeSite(answer = () => ({ ok: true })) {
  const calls = [];
  return {
    calls,
    async post(route, body) {
      calls.push(['POST', route, body]);
      return answer(route, body);
    },
    async get(route) {
      calls.push(['GET', route]);
      return answer(route);
    },
  };
}
const tick = () => new Promise((r) => setImmediate(r));

test('status embed: the website note only while the page is on', () => {
  const s = { id: 5, title: 'Dark mode', status: 'open' };
  const field = (e) => (e.data.fields || []).find((f) => f.name === 'Website');
  assert.equal(field(statusEmbed(s)), undefined, 'an older website sends no web');
  assert.equal(field(statusEmbed({ ...s, web: { notice: false, host: 'on-your.site' } })), undefined);
  assert.equal(field(statusEmbed({ ...s, web: { notice: true, host: 'on-your.site' } })).value,
    'Once decided, this idea is shown on on-your.site/suggestions, without your name.');
});

test('a new forum post: the bot tells the website that the author got the note (web_notice) – only when it was in the embed', async () => {
  for (const notice of [true, false]) {
    const client = Object.assign(new EventEmitter(), { users: { fetch: async () => ({ username: 'mia' }) } });
    const site = fakeSite((route) => (route === '/_/bot/suggestions'
      ? { ok: true, suggestion: { id: 5, title: 'Dark mode', status: 'open', web: { notice, host: 'on-your.site' } } }
      : { ok: true }));
    setupSuggestions(client, cfg, site, () => {});
    const sent = [];
    const thread = {
      id: ID(10), parentId: FORUM, guildId: GUILD, ownerId: ID(11), name: 'Dark mode',
      fetchStarterMessage: async () => ({ content: 'Please', attachments: new Map() }),
      send: async (payload) => {
        sent.push(payload);
        return { id: ID(12) };
      },
    };
    client.emit(Events.ThreadCreate, thread, true);
    for (let i = 0; i < 20 && site.calls.length < 2; i++) await tick();
    assert.deepEqual(site.calls[1], ['POST', '/_/bot/suggestions/5', notice ? { status_message_id: ID(12), web_notice: true } : { status_message_id: ID(12) }]);
    assert.equal(sent[0].embeds[0].data.fields.some((f) => f.name === 'Website'), notice);
  }
});

test('raw gateway events: a deleted suggestion post reaches the website, although discord.js ignores the uncached thread', async () => {
  const client = new Client({ intents: [] });
  try {
    const site = fakeSite((route) => (route.endsWith(ID(20)) ? { ok: true } : { ok: false, httpStatus: 404, error: 'Suggestion not found.' }));
    const logs = [];
    let features = ['updates.v1', 'suggestions.v2'];
    setupSuggestions(client, cfg, site, (l) => logs.push(l), { siteFeatures: () => features });
    const threadDeletes = [];
    client.on(Events.ThreadDelete, (t) => threadDeletes.push(t));
    const packet = { t: 'THREAD_DELETE', d: { id: ID(20), parent_id: FORUM, guild_id: GUILD, type: 11 } };
    // So verarbeitet discord.js das Ereignis: ein Thread, der nicht im Cache ist, löst kein threadDelete aus
    client.ws.status = Status.Ready;
    client.ws.handlePacket(packet);
    assert.equal(threadDeletes.length, 0, 'discord.js emits threadDelete only for cached threads');
    // Das rohe Ereignis kommt immer
    client.emit(Events.Raw, packet);
    // Erste Nachricht eines Forenbeitrags (ID = Beitrag) gelöscht; eine andere Nachricht zählt nicht
    client.emit(Events.Raw, { t: 'MESSAGE_DELETE', d: { id: ID(21), channel_id: ID(21), guild_id: GUILD } });
    client.emit(Events.Raw, { t: 'MESSAGE_DELETE', d: { id: ID(22), channel_id: ID(21), guild_id: GUILD } });
    // Andere Foren, andere Server, andere Ereignisse: nichts
    client.emit(Events.Raw, { t: 'THREAD_DELETE', d: { id: ID(23), parent_id: ID(99), guild_id: GUILD } });
    client.emit(Events.Raw, { t: 'THREAD_DELETE', d: { id: ID(24), parent_id: FORUM, guild_id: ID(98) } });
    client.emit(Events.Raw, { t: 'MESSAGE_CREATE', d: { id: ID(25), channel_id: ID(25), guild_id: GUILD } });
    await tick();
    assert.deepEqual(site.calls, [
      ['POST', `/_/bot/suggestions/thread/${ID(20)}`, { deleted: true }],
      ['POST', `/_/bot/suggestions/thread/${ID(21)}`, { body_deleted: true }],
    ]);
    assert.deepEqual(logs, [], 'a 404 (not a suggestion) is no error');
    // Eine Webseite ohne suggestions.v2 bekommt keine Löschungen
    features = ['updates.v1'];
    client.emit(Events.Raw, packet);
    await tick();
    assert.equal(site.calls.length, 2);
  } finally {
    await client.destroy();
  }
});

test('daily check: 10003 deletes, 10008 erases the text, lost access skips, other errors wait; at most one request per pause', async () => {
  const T = { gone: ID(30), noAccess: ID(31), noStarter: ID(32), fine: ID(33), noBody: ID(34), broken: ID(35) };
  const pages = {
    0: { ok: true, items: [{ id: 1, thread_id: T.gone, has_body: true }, { id: 2, thread_id: T.noAccess, has_body: true }, { id: 3, thread_id: T.noStarter, has_body: true }], next: 3 },
    3: { ok: true, items: [{ id: 4, thread_id: T.fine, has_body: true }, { id: 5, thread_id: T.noBody, has_body: false }, { id: 6, thread_id: T.broken, has_body: true }, { id: 7, thread_id: '../x', has_body: true }], next: null },
  };
  const site = fakeSite((route) => {
    const m = /threads\?after=(\d+)$/.exec(route);
    return m ? pages[m[1]] : { ok: true };
  });
  const stamps = [];
  const thread = (id, starter) => ({ id, messages: { fetch: async () => { stamps.push(Date.now()); if (!starter) throw apiError(404, 10008, 'Unknown Message'); return {}; } } });
  const client = Object.assign(new EventEmitter(), {
    channels: {
      fetch: async (id, opts) => {
        stamps.push(Date.now());
        assert.deepEqual(opts, { force: true });
        if (id === T.gone) throw apiError(404, 10003, 'Unknown Channel');
        if (id === T.noAccess) throw apiError(403, 50001, 'Missing Access');
        if (id === T.broken) throw apiError(500, 0, 'Internal Server Error');
        return thread(id, id !== T.noStarter);
      },
    },
  });
  const pause = 40;
  const s = setupSuggestions(client, cfg, site, () => {}, { siteFeatures: () => ['suggestions.v2'], pauseMs: pause });
  const out = await s.dailyCheck();
  assert.deepEqual(out, { checked: 6, deleted: 1, bodies: 1 });
  assert.deepEqual(site.calls.filter((c) => c[0] === 'POST'), [
    ['POST', `/_/bot/suggestions/thread/${T.gone}`, { deleted: true }],
    ['POST', `/_/bot/suggestions/thread/${T.noStarter}`, { body_deleted: true }],
  ]);
  assert.deepEqual(site.calls.filter((c) => c[0] === 'GET').map((c) => c[1]), ['/_/bot/suggestions/threads?after=0', '/_/bot/suggestions/threads?after=3']);
  for (let i = 1; i < stamps.length; i++) assert.ok(stamps[i] - stamps[i - 1] >= pause - 2, `request ${i} came ${stamps[i] - stamps[i - 1]} ms after the one before`);
  // Ohne suggestions.v2 auf der Webseite: keine Prüfung
  const quiet = fakeSite();
  assert.deepEqual(await setupSuggestions(client, cfg, quiet, () => {}, { siteFeatures: () => ['updates.v1'] }).dailyCheck(), { checked: 0, deleted: 0, bodies: 0 });
  assert.equal(quiet.calls.length, 0);
});

test('suggestions.notice adds the sentence to the forum guidelines once and removes it again; the rest stays', async () => {
  assert.equal(guidelines('Rules.\n\nDecided ideas are shown on old.site/suggestions without your name.', true, SENTENCE), `Rules.\n\n${SENTENCE}`);
  const forum = { topic: 'One idea per post.', topics: [], async setTopic(t) { this.topics.push(t); this.topic = t; } };
  const client = { channels: { fetch: async (id) => { if (id !== FORUM) throw apiError(404, 10003, 'Unknown Channel'); return forum; } } };
  const s = setupSuggestions(Object.assign(new EventEmitter(), client), cfg, fakeSite(), () => {});
  assert.deepEqual(await s.applyNotice({ on: true, text: SENTENCE }), {});
  assert.equal(forum.topic, `One idea per post.\n\n${SENTENCE}`);
  await s.applyNotice({ on: true, text: SENTENCE });
  assert.equal(forum.topics.length, 1, 'already there: nothing changes');
  await s.applyNotice({ on: false, text: SENTENCE });
  assert.equal(forum.topic, 'One idea per post.');
  await s.applyNotice({ on: false, text: SENTENCE });
  assert.equal(forum.topics.length, 2);
  // Ohne Recht: endgültiger Fehler mit Discords Code; ohne Forum ebenso
  forum.setTopic = async () => { throw apiError(403, 50013, 'Missing Permissions'); };
  await assert.rejects(s.applyNotice({ on: true, text: SENTENCE }), (err) => err.final === true && err.message === 'Missing Permissions (50013)');
  const none = setupSuggestions(Object.assign(new EventEmitter(), client), { ...cfg, suggestionForumId: '' }, fakeSite(), () => {});
  await assert.rejects(none.applyNotice({ on: true, text: SENTENCE }), (err) => err.final === true);
});
