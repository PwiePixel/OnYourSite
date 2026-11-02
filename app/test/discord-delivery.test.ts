// Zustellung an Discord ohne Datenbank: die Übergänge der Beiträge (discord-pages §5.5.3) Zelle für Zelle, die
// Ergebnisse des Bots, der Bericht des Bots (POST /_/bot/hello), der Bot als Ziel und die Regeln der Warteschlange.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, decide, decideResult, type AdminEvent, type Decision, type Facts, type PostState, type ResultOutcome } from '../src/discord/posts.js';
import { REPORT_MAX_BYTES, botTarget, validateReport, type BotReport } from '../src/discord/botReport.js';
import { discordDefaults, type DiscordSettings } from '../src/discord/settings.js';
import { knownFeatures, parseDone, parseFeatures, pauseAfter } from '../src/community/outbox.js';

const STATES: PostState[] = ['queued', 'posting', 'posted', 'failed', 'removing', 'remove_failed'];
const facts = (state: PostState, over: Partial<Facts> = {}): Facts => ({
  via: 'webhook', state, ageSec: 0, jobClaimed: false, hasError: false, botInstalled: true, updateGone: false, ...over,
});

// Erwartung je Ereignis und Zustand – [Webhook/Token, Bot]
type Row = Record<PostState | 'none', [Decision, Decision]>;
const TABLE: Record<'announce' | 'edit' | 'remove', Row> = {
  announce: {
    none: ['claim_post', 'queue_post'],
    queued: ['already_queued', 'already_queued'],
    posting: ['already_posting', 'already_posting'],
    posted: ['edit', 'edit'],
    failed: ['claim_post', 'queue_post'],
    removing: ['still_removing', 'still_removing'],
    remove_failed: ['remove_failed_first', 'remove_failed_first'],
  },
  edit: {
    none: ['none', 'none'],
    queued: ['mark_dirty', 'mark_dirty'],
    posting: ['mark_dirty', 'mark_dirty'],
    posted: ['edit', 'edit'],
    failed: ['none', 'none'],
    removing: ['none', 'none'],
    remove_failed: ['none', 'none'],
  },
  remove: {
    none: ['none', 'none'],
    queued: ['cancel', 'cancel'],
    posting: ['still_posting', 'still_posting'],
    posted: ['delete', 'delete'],
    failed: ['drop', 'drop'],
    removing: ['none', 'none'],
    remove_failed: ['delete', 'delete'],
  },
};

test('post state machine: announce, edit and remove – every cell for webhook/token and bot', () => {
  for (const [event, row] of Object.entries(TABLE) as Array<[AdminEvent, Row]>) {
    for (const [state, [sync, bot]] of Object.entries(row) as Array<[PostState | 'none', [Decision, Decision]]>) {
      for (const via of ['webhook', 'token'] as const) {
        assert.equal(decide(event, state === 'none' ? null : facts(state, { via }), via), sync, `${event} ${state} ${via}`);
      }
      assert.equal(decide(event, state === 'none' ? null : facts(state, { via: 'bot' }), 'bot'), bot, `${event} ${state} bot`);
    }
  }
  // Ein schon beim Bot abgeholter Beitrag wird beim Entfernen zu „removing“ (sein Ergebnis löst das Löschen aus)
  assert.equal(decide('remove', facts('queued', { via: 'bot', jobClaimed: true }), 'bot'), 'set_removing');
  // Ohne installierten Bot: Bot-Beiträge werden nicht bearbeitet bzw. als „nicht entfernt“ markiert
  assert.equal(decide('edit', facts('posted', { via: 'bot', botInstalled: false }), 'bot'), 'edit_no_bot');
  assert.equal(decide('announce', facts('posted', { via: 'bot', botInstalled: false }), 'bot'), 'edit_no_bot');
  assert.equal(decide('remove', facts('posted', { via: 'bot', botInstalled: false }), 'bot'), 'delete_no_bot');
  assert.equal(decide('remove', facts('remove_failed', { via: 'bot', botInstalled: false }), 'bot'), 'delete_no_bot');
  // Für Webhook/Token spielt der Bot keine Rolle
  assert.equal(decide('edit', facts('posted', { via: 'webhook', botInstalled: false }), 'webhook'), 'edit');
});

test('post state machine: retry, forget and the clean-up', () => {
  for (const via of ['webhook', 'token', 'bot'] as const) {
    const bot = via === 'bot';
    const f = (state: PostState, over: Partial<Facts> = {}) => facts(state, { via, ...over });
    // Retry
    assert.equal(decide('retry', f('posted', { hasError: true }), via), 'edit', via);
    assert.equal(decide('retry', f('posted'), via), 'none', via);
    assert.equal(decide('retry', f('failed'), via), bot ? 'queue_post' : 'claim_post', via);
    assert.equal(decide('retry', f('remove_failed'), via), 'delete', via);
    for (const state of ['queued', 'posting', 'removing'] as const) assert.equal(decide('retry', f(state), via), 'none', `${via} ${state}`);
    // Forget: queued/removing erst nach 10 Minuten, posting nach 2 Minuten, alles andere sofort
    assert.equal(decide('forget', f('queued', { ageSec: 599 }), via), 'too_early');
    assert.equal(decide('forget', f('queued', { ageSec: 600 }), via), 'drop_jobs');
    assert.equal(decide('forget', f('removing', { ageSec: 10 }), via), 'too_early');
    assert.equal(decide('forget', f('removing', { ageSec: 601 }), via), 'drop_jobs');
    assert.equal(decide('forget', f('posting', { ageSec: 119 }), via), 'too_early');
    assert.equal(decide('forget', f('posting', { ageSec: 120 }), via), 'drop_jobs');
    for (const state of ['posted', 'failed', 'remove_failed'] as const) assert.equal(decide('forget', f(state), via), 'drop_jobs', `${via} ${state}`);
    // Aufräumen
    assert.equal(decide('cleanup', f('posting', { ageSec: 120 }), via), 'fail_stuck');
    assert.equal(decide('cleanup', f('posting', { ageSec: 30 }), via), 'none');
    assert.equal(decide('cleanup', f('posted', { updateGone: true }), via), 'orphan');
    assert.equal(decide('cleanup', f('posted'), via), 'none');
    for (const state of STATES.filter((x) => x !== 'posting' && x !== 'posted')) assert.equal(decide('cleanup', f(state, { ageSec: 99999, updateGone: true }), via), 'none');
  }
  assert.equal(decide('retry', facts('posted', { via: 'bot', hasError: true, botInstalled: false }), 'bot'), 'edit_no_bot');
});

test('results of the bot: every action, outcome and row state', () => {
  const OUT: ResultOutcome[] = ['ok', 'not_found', 'missing', 'failed', 'retry'];
  const expect = (action: string, state: PostState, outcome: ResultOutcome): string => {
    if (outcome === 'retry') return 'ignore';
    if (action === 'update.post') {
      if (state === 'queued') return outcome === 'ok' ? 'posted' : outcome === 'not_found' ? 'failed_not_picked' : 'failed';
      if (state === 'removing') return outcome === 'ok' ? 'store_and_delete' : 'drop';
      return 'ignore';
    }
    if (action === 'update.edit') return state !== 'posted' ? 'ignore' : outcome === 'ok' ? 'clear_error' : outcome === 'missing' ? 'drop' : 'edit_error';
    if (action === 'update.delete') return state !== 'removing' ? 'ignore' : outcome === 'failed' ? 'remove_failed' : 'drop';
    return 'ignore';
  };
  for (const action of ['update.post', 'update.edit', 'update.delete', 'update.test', 'other']) {
    for (const state of STATES) for (const o of OUT) assert.equal(decideResult(action, o, state), expect(action, state, o), `${action} ${state} ${o}`);
  }
  // Ein toter Edit bleibt „posted“ mit Fehler – nie „failed“
  assert.equal(decideResult('update.edit', 'failed', 'posted'), 'edit_error');
  // classify: Fehler, endgültig, Ergebnisse
  assert.equal(classify('update.post', null, 'boom', false), 'retry');
  assert.equal(classify('update.post', null, 'boom', true), 'failed');
  assert.equal(classify('update.post', { message_id: '1300000000000000001', channel_id: '1300000000000000002' }, '', true), 'ok');
  assert.equal(classify('update.post', { found: false }, '', true), 'not_found');
  assert.equal(classify('update.post', { message_id: 'abc' }, '', true), 'failed', 'no valid message ID');
  assert.equal(classify('update.post', null, '', true), 'failed');
  assert.equal(classify('update.edit', { missing: true }, '', true), 'missing');
  assert.equal(classify('update.edit', {}, '', true), 'ok');
  assert.equal(classify('update.delete', { missing: true }, '', true), 'missing');
});

// ------------------------------------------------------------------ Bericht des Bots

const ID = (n: number): string => String(1300000000000000000n + BigInt(n));
function report(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '0.2.0', runtime: 'service', features: ['updates.v1'],
    guild: { id: ID(1), name: 'OnYourSite', community: true },
    updates_channel_id: ID(10),
    categories: [{ id: ID(2), name: 'OnYourSite' }],
    channels: [
      { id: ID(10), name: 'updates', type: 'announcement', parent_id: ID(2), can_post: true, can_mention_everyone: false, missing: [] },
      { id: ID(11), name: 'general', type: 'text', parent_id: '', can_post: false, can_mention_everyone: false, missing: ['SendMessages'] },
      { id: ID(12), name: 'changelog', type: 'forum', parent_id: '', can_post: true, can_mention_everyone: true, missing: [] },
    ],
    threads: [{ id: ID(20), name: 'Release notes', parent_id: ID(11), can_post: true }],
    roles: [{ id: ID(30), name: 'Update pings', mentionable: true }],
    truncated: false,
    ...over,
  };
}
const known = ['hello', 'updates.v1', 'suggestions.v2'];

test('hello report: valid reports are stored with reported_at, unknown features and top-level keys dropped, gateway accepted', () => {
  const ok = validateReport(report({ features: ['updates.v1', 'future.v9', 'updates.v1'], extra: { x: 1 }, gateway: { ready: true, ping_ms: 42 } }), known, 1793563302);
  assert.ok(ok.ok);
  if (!ok.ok) return;
  assert.equal(ok.report.reported_at, 1793563302);
  assert.deepEqual(ok.report.features, ['updates.v1'], 'unknown and repeated features are dropped');
  assert.equal('extra' in ok.report, false, 'unknown top-level keys are dropped');
  assert.deepEqual(ok.report.gateway, { ready: true, ping_ms: 42 });
  assert.equal(ok.report.channels[1].missing[0], 'SendMessages');
  assert.ok(!ok.json.includes('\\u'), 'stored without \\u escapes');
  // Namen wie jeder Text von außen: ohne Steuerzeichen, höchstens 100 Zeichen
  const named = validateReport(report({ guild: { id: ID(1), name: 'A\u0000B' + 'x'.repeat(200) } }), known);
  assert.ok(named.ok && named.report.guild.name.length <= 100 && !named.report.guild.name.includes('\u0000'));
  // Optionale Teile dürfen fehlen
  const lean = validateReport({ version: '0.2.0', runtime: 'other', features: [], guild: { id: ID(1) }, channels: [] }, known);
  assert.ok(lean.ok && lean.report.updates_channel_id === '' && lean.report.threads.length === 0 && lean.report.truncated === false);
});

test('hello report: every violation is a 400, too much to store a 413', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['version with capitals', { version: 'V1' }],
    ['version too long', { version: '1'.repeat(21) }],
    ['runtime', { runtime: 'kubernetes' }],
    ['features not a list', { features: 'updates.v1' }],
    ['feature not a string', { features: [1] }],
    ['guild missing', { guild: undefined }],
    ['guild id', { guild: { id: '123', name: 'x' } }],
    ['channel id as number', { channels: [{ id: 1300000000000000010, name: 'x', type: 'text', parent_id: '', can_post: true, missing: [] }] }],
    ['channel type', { channels: [{ id: ID(10), name: 'x', type: 'voice', parent_id: '', can_post: true, missing: [] }] }],
    ['unknown permission', { channels: [{ id: ID(10), name: 'x', type: 'text', parent_id: '', can_post: true, missing: ['Administrator'] }] }],
    ['can_post not boolean', { channels: [{ id: ID(10), name: 'x', type: 'text', parent_id: '', can_post: 'yes', missing: [] }] }],
    ['channels missing', { channels: undefined }],
    ['too many channels', { channels: Array.from({ length: 201 }, (_, i) => ({ id: ID(100 + i), name: 'c', type: 'text', parent_id: '', can_post: true, missing: [] })) }],
    ['too many categories', { categories: Array.from({ length: 51 }, (_, i) => ({ id: ID(500 + i), name: 'c' })) }],
    ['too many threads', { threads: Array.from({ length: 51 }, (_, i) => ({ id: ID(600 + i), name: 't', parent_id: '', can_post: true })) }],
    ['too many roles', { roles: Array.from({ length: 101 }, (_, i) => ({ id: ID(700 + i), name: 'r', mentionable: false })) }],
    ['updates channel', { updates_channel_id: 'general' }],
    ['gateway ping negative', { gateway: { ready: true, ping_ms: -1 } }],
    ['gateway ping fraction', { gateway: { ready: true, ping_ms: 1.5 } }],
    ['gateway ready missing', { gateway: { ping_ms: 1 } }],
    ['truncated not boolean', { truncated: 1 }],
  ];
  for (const [name, over] of bad) {
    const r = validateReport(report(over), known);
    assert.deepEqual(r, { ok: false, status: 400, error: 'Invalid report.' }, name);
  }
  for (const body of [null, [], 'x', 5]) assert.deepEqual(validateReport(body, known), { ok: false, status: 400, error: 'Invalid report.' });
  // Groß, aber innerhalb der Grenzen: 200 Kanäle mit langen Namen und 100 Rollen überschreiten 60.000 Bytes → 413
  const long = (i: number) => 'ü'.repeat(60) + i;
  const big = validateReport(report({
    channels: Array.from({ length: 200 }, (_, i) => ({ id: ID(100 + i), name: long(i), type: 'text', parent_id: ID(2), can_post: true, can_mention_everyone: false, missing: ['ViewChannel', 'SendMessages', 'EmbedLinks'] })),
    roles: Array.from({ length: 100 }, (_, i) => ({ id: ID(700 + i), name: long(i), mentionable: true })),
  }), known);
  assert.deepEqual(big, { ok: false, status: 413, error: 'Request too large.' });
  assert.equal(REPORT_MAX_BYTES, 60000);
});

test('the bot as a destination: #updates by itself while nothing else is set up; an explicit choice wins', () => {
  const r = validateReport(report(), known);
  assert.ok(r.ok);
  const rep = (r as { report: BotReport }).report;
  const s = (over: (x: DiscordSettings) => void = () => undefined): DiscordSettings => {
    const x = discordDefaults();
    over(x);
    return x;
  };
  // Nichts eingerichtet: der Kanal #updates aus dem Bericht
  assert.deepEqual(botTarget(s(), rep, true), { channel_id: ID(10), channel_type: 'announcement', name: 'updates', mention: '', auto: true });
  // Ohne installierten Bot, ohne Bericht, ohne updates.v1, ohne Rechte im Kanal oder ohne #updates: nichts
  assert.equal(botTarget(s(), rep, false), null);
  assert.equal(botTarget(s(), null, true), null);
  assert.equal(botTarget(s(), { ...rep, features: [] }, true), null);
  assert.equal(botTarget(s(), { ...rep, updates_channel_id: ID(11) }, true), null, 'the bot can’t post there');
  assert.equal(botTarget(s(), { ...rep, updates_channel_id: '' }, true), null);
  // Ein eingeschalteter Webhook oder der alte Token: kein doppelter Beitrag durch den Bot
  const hook = 'https://discord.com/api/webhooks/123456789012345678/' + 'aB3_-'.repeat(8);
  assert.equal(botTarget(s((x) => Object.assign(x.webhook, { enabled: true, url: hook })), rep, true), null);
  assert.ok(botTarget(s((x) => Object.assign(x.webhook, { enabled: false, url: hook })), rep, true), 'a webhook that is off doesn’t count');
  assert.equal(botTarget(s((x) => Object.assign(x, { bot_token: 'x'.repeat(60), channel_id: ID(40) })), rep, true), null);
  // Vom Admin gespeichert: sein Kanal und Ping – oder aus
  const saved = s((x) => Object.assign(x.bot, { enabled: true, channel_id: ID(12), channel_type: 'forum', mention: 'here', saved_at: '2026-11-01 10:00:00' }));
  assert.deepEqual(botTarget(saved, rep, true), { channel_id: ID(12), channel_type: 'forum', name: 'changelog', mention: 'here', auto: false });
  assert.equal(botTarget(s((x) => Object.assign(x.bot, { enabled: false, channel_id: ID(12), saved_at: 'x' })), rep, true), null);
  const thread = s((x) => Object.assign(x.bot, { enabled: true, channel_id: ID(20), saved_at: 'x' }));
  assert.equal(botTarget(thread, rep, true)?.channel_type, 'thread');
});

test('outbox rules: features of the polling bot, pauses after errors and the done body', () => {
  assert.deepEqual([...parseFeatures('updates.v1,suggestions.v2')], ['updates.v1', 'suggestions.v2']);
  assert.deepEqual([...parseFeatures('')], []);
  assert.deepEqual([...parseFeatures(undefined)], []);
  assert.deepEqual([...parseFeatures(['updates.v1'])], [], 'an array is no list of features');
  assert.deepEqual([...parseFeatures('UPDATES,ok.v1,a b,' + 'x'.repeat(41))], ['ok.v1']);
  assert.equal(parseFeatures(Array.from({ length: 80 }, (_, i) => 'f' + i).join(',')).size, 50);
  // 10, 20, 40 … 2560 s, dann höchstens eine Stunde
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(pauseAfter), [10, 20, 40, 80, 160, 320, 640, 1280, 2560, 3600, 3600]);
  assert.ok(knownFeatures().includes('hello') && knownFeatures().includes('updates.v1'));
  assert.deepEqual(parseDone({}, ''), { ok: true, error: '', final: false, result: null });
  assert.deepEqual(parseDone({ final: true, result: { message_id: '1' } }, 'x'), { ok: true, error: 'x', final: true, result: { message_id: '1' } });
  assert.deepEqual(parseDone({ final: 'yes' }, ''), { ok: false });
  assert.deepEqual(parseDone({ result: [1] }, ''), { ok: false });
  assert.deepEqual(parseDone({ result: 'x' }, ''), { ok: false });
  assert.deepEqual(parseDone(null, ''), { ok: false });
});
