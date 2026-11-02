// Zustellung der Updates über den installierten Bot – mit Datenbank und dem ganzen Server (signierte Anfragen an
// /_/bot/*): Bericht (hello), Funktionen in ping, Aufträge (Filter nach Funktionen, Pausen, Reihenfolge je ref,
// Regeln beim Ausgeben, Verfallen), Rückmeldungen (/done mit result und final, Wiederholungen), das Register mit
// onResult in der Transaktion von /done, Rennen mit Haltepunkten, der Schritt V_DISCORD_DELIVERY und das Aufräumen.
// Discord selbst (Webhook) ist der Ersatz aus fixtures/discord/standIn.ts.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { configString, setConfigForTests, type ConfigData } from '../src/config.js';
import { closePool, exec, one, q, value, withConnection } from '../src/db.js';
import { decryptData, encryptData } from '../src/crypto.js';
import { date, time } from '../src/php.js';
import { buildServer } from '../src/server.js';
import { V_DISCORD_DELIVERY, ensureSchema, hasIndex, convertLegacyPosts } from '../src/schema.js';
import { adminUpdatesHandle } from '../src/updates/admin.js';
import { updateGet } from '../src/updates/updates.js';
import { outboxAdd } from '../src/community/community.js';
import { outboxCleanup, outboxHooks, registerBotAction } from '../src/community/outbox.js';
import { TEXTS, announce, delivery, forget, postHooks, retry, syncEdit } from '../src/discord/posts.js';
import { discordAdminHandle } from '../src/discord/admin.js';
import { BASE, testDatabase, type TestDb } from './coreHarness.js';
import { GOOD_TOKEN, startStandIn, type DiscordStandIn } from './fixtures/discord/standIn.js';

let t: TestDb;
let app: FastifyInstance;
let discord: DiscordStandIn;
const HOST = 'oys.test:8080';
const SECRET = configString('bot_secret');
const ID = (n: number): string => String(1300000000000000000n + BigInt(n));
const UPDATES_CHANNEL = ID(10);
const token = (seed: string): string => (seed + 'Qz7_-').repeat(12).slice(0, 68);
const HOOK = '1301234567890123456';

function useConfig(extra: ConfigData = {}): void {
  setConfigForTests({ ...BASE, db: { ...(BASE.db as ConfigData), name: t.name }, discord_api_base: discord.base, ...extra });
}

before(async () => {
  assert.ok(SECRET.length >= 32, 'the test settings need a bot_secret');
  discord = await startStandIn();
  t = await testDatabase('dpbot');
  useConfig();
  app = await buildServer();
  await app.ready();
});

after(async () => {
  await app?.close();
  await t?.done();
  await discord?.close();
});

beforeEach(async () => {
  useConfig();
  discord.restart();
  postHooks.pause = null;
  outboxHooks.pause = null;
  for (const sql of ['DELETE FROM updates', 'DELETE FROM update_discord_posts', 'DELETE FROM community_outbox', "DELETE FROM rate_limits WHERE rl_key LIKE 'discord%'",
    "DELETE FROM oys_meta WHERE meta_key IN ('discord', 'discord_bot_report', 'discord_bot_test', 'bot_last_seen')"]) await exec(sql);
});

// ------------------------------------------------------------------ Hilfen

interface BotRes { status: number; json: Record<string, unknown> }
// Signierte Anfrage wie der Bot (site.js): HMAC über Zeitstempel, Methode, Pfad mit Abfrage und Inhalt
async function bot(method: 'GET' | 'POST', path: string, body?: unknown, raw?: string): Promise<BotRes> {
  const payload = raw ?? (body === undefined ? '' : JSON.stringify(body));
  const ts = String(time());
  const sig = createHmac('sha256', SECRET).update(`${ts}\n${method}\n${path}\n${method === 'GET' ? '' : payload}`).digest('hex');
  const headers: Record<string, string> = { host: HOST, 'x-oys-timestamp': ts, 'x-oys-signature': sig };
  if (payload !== '') headers['content-type'] = 'application/json';
  const res = await app.inject({ method, url: path, headers, payload: payload === '' ? undefined : payload });
  return { status: res.statusCode, json: res.body === '' ? {} : (JSON.parse(res.body) as Record<string, unknown>) };
}

function report(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '0.2.0', runtime: 'service', features: ['updates.v1'],
    guild: { id: ID(1), name: 'OnYourSite', community: true }, updates_channel_id: UPDATES_CHANNEL,
    categories: [{ id: ID(2), name: 'OnYourSite' }],
    channels: [
      { id: UPDATES_CHANNEL, name: 'updates', type: 'announcement', parent_id: ID(2), can_post: true, can_mention_everyone: false, missing: [] },
      { id: ID(11), name: 'general', type: 'text', parent_id: '', can_post: false, can_mention_everyone: false, missing: ['SendMessages'] },
    ],
    threads: [], roles: [], truncated: false, ...over,
  };
}

async function addUpdate(id: number, extra: Record<string, unknown> = {}): Promise<void> {
  const row = { id, title: 'Update ' + id, body: 'Text ' + id, version: '', category: 'new', is_published: 1, published_at: date('Y-m-d H:i:s'), discord_announce: 1, created_at: date('Y-m-d H:i:s'), updated_at: date('Y-m-d H:i:s'), ...extra };
  await exec(`INSERT INTO updates (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`, Object.values(row) as never[]);
}

const postOf = (updateId: number, via = 'bot') => one('SELECT * FROM update_discord_posts WHERE update_id = ? AND via = ?', [updateId, via]);
const jobsOf = (postId: number) => q('SELECT * FROM community_outbox WHERE ref = ? ORDER BY id', ['post:' + postId]);
const jobById = (id: number) => one('SELECT * FROM community_outbox WHERE id = ?', [id]);
const items = (r: BotRes): Array<{ id: number; action: string; data: Record<string, unknown>; attempts: number }> => r.json.items as never;

async function storeSettings(v: Record<string, unknown>): Promise<void> {
  await exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('discord', ?)", [String(encryptData(JSON.stringify(v)))]);
}
async function storedSettings(): Promise<Record<string, unknown> | null> {
  const raw = await value("SELECT meta_value FROM oys_meta WHERE meta_key = 'discord'");
  return raw === null ? null : (JSON.parse(String(decryptData(String(raw)))) as Record<string, unknown>);
}

// Haltepunkt: der erste Lauf an `point` wartet, bis open() gerufen wird; reached löst aus, sobald er dort steht
function gate(point: string, hooks: { pause: unknown }) {
  let open!: () => void;
  let reached!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  const arrived = new Promise<void>((r) => (reached = r));
  let armed = true;
  (hooks as { pause: (p: string) => Promise<void> }).pause = async (p: string) => {
    if (p !== point || !armed) return;
    armed = false;
    reached();
    await opened;
  };
  return { open, arrived };
}

// Kurz warten, damit eine zweite Anfrage an einer Sperre ansteht
const settle = (ms = 300): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ hello, ping, Größe

test('hello stores the report; ping and hello list the features; invalid reports are 400, big bodies 413', async () => {
  const ping = await bot('GET', '/_/bot/ping');
  assert.equal(ping.status, 200);
  assert.deepEqual((ping.json.features as string[]).slice(0, 2), ['hello', 'updates.v1']);

  const hello = await bot('POST', '/_/bot/hello', report({ features: ['updates.v1', 'status.v9'], future_key: { a: 1 }, gateway: { ready: true, ping_ms: 37 } }));
  assert.equal(hello.status, 200);
  assert.equal(hello.json.ok, true);
  assert.equal(hello.json.site, 'http://oys.test:8080/');
  assert.deepEqual((hello.json.features as string[]).slice(0, 2), ['hello', 'updates.v1']);
  const stored = JSON.parse(String(await value("SELECT meta_value FROM oys_meta WHERE meta_key = 'discord_bot_report'"))) as Record<string, unknown>;
  assert.ok(Math.abs(Number(stored.reported_at) - time()) <= 5);
  assert.deepEqual(stored.features, ['updates.v1'], 'only features this website knows are stored');
  assert.equal('future_key' in stored, false);
  assert.deepEqual(stored.gateway, { ready: true, ping_ms: 37 });
  // Der Bot hat sich gemeldet: zuletzt gesehen
  assert.ok(Number(await value("SELECT meta_value FROM oys_meta WHERE meta_key = 'bot_last_seen'")) >= time() - 5);

  const bad = await bot('POST', '/_/bot/hello', report({ runtime: 'kubernetes' }));
  assert.deepEqual([bad.status, bad.json], [400, { ok: false, error: 'Invalid report.' }]);
  const broken = await bot('POST', '/_/bot/hello', undefined, '{"version":');
  assert.equal(broken.status, 400);
  const big = await bot('POST', '/_/bot/hello', undefined, JSON.stringify(report({ pad: 'x'.repeat(70000) })));
  assert.deepEqual([big.status, big.json], [413, { ok: false, error: 'Request too large.' }]);
  // Unsigniert gibt es nichts
  const anon = await app.inject({ method: 'POST', url: '/_/bot/hello', headers: { host: HOST, 'content-type': 'application/json' }, payload: JSON.stringify(report()) });
  assert.equal(anon.statusCode, 401);
});

// ------------------------------------------------------------------ der Bot postet (DECISIONS Q13: ohne Token)

test('the installed bot posts, edits and removes updates in #updates by itself – no token anywhere', async () => {
  assert.equal((await bot('POST', '/_/bot/hello', report())).status, 200);
  const saved = await adminUpdatesHandle({ oys_action: 'update_save', title: 'Bot news', body: 'Hello', category: 'new', publish: '1', announce_field: '1', post_discord: '1' });
  assert.deepEqual(saved, { tab: 'updates', ok: 'Update published. The bot posts it to Discord within a few seconds.' });
  const u = (await q('SELECT id FROM updates'))[0];
  const id = Number(u.id);
  const row = (await postOf(id))!;
  assert.equal(row.state, 'queued');
  assert.equal(row.channel_id, UPDATES_CHANNEL);
  const [job] = await jobsOf(Number(row.id));
  assert.equal(job.action, 'update.post');
  const data = JSON.parse(String(job.payload)) as Record<string, unknown>;
  assert.equal(data.channel_id, UPDATES_CHANNEL);
  assert.equal(data.kind, 'announcement');
  assert.deepEqual((data.message as Record<string, unknown>).allowed_mentions, { parse: [] }, 'nobody is pinged');
  // Nirgends ein Token: weder in den Einstellungen noch im Auftrag
  const s = await storedSettings();
  assert.ok(s === null || s.bot_token === '');
  assert.doesNotMatch(String(job.payload), /token/i);
  assert.equal(discord.calls().length, 0, 'the website never calls Discord for the bot');

  // Ein alter Bot (ohne f) bekommt den Auftrag nicht, der neue schon – einmal abgeholt
  assert.deepEqual(items(await bot('GET', '/_/bot/outbox')), []);
  const got = items(await bot('GET', '/_/bot/outbox?f=updates.v1'));
  assert.equal(got.length, 1);
  assert.equal(got[0].action, 'update.post');
  assert.equal(got[0].data.recheck, false);
  assert.notEqual((await jobById(got[0].id))!.claimed_at, null);
  const done = await bot('POST', `/_/bot/outbox/${got[0].id}/done`, { error: '', result: { message_id: ID(500), channel_id: UPDATES_CHANNEL } });
  assert.deepEqual(done.json, { ok: true });
  let r = (await postOf(id))!;
  assert.equal(r.state, 'posted');
  assert.equal(r.message_id, ID(500));

  // Bearbeiten: ein update.edit, ohne neuen Ping
  const edited = await adminUpdatesHandle({ oys_action: 'update_save', id: String(id), title: 'Bot news, edited', body: 'New', category: 'new', publish: '1' });
  assert.deepEqual(edited, { tab: 'updates', ok: 'Update published. The bot updates its post within a few seconds.' });
  const [edit] = items(await bot('GET', '/_/bot/outbox?f=updates.v1'));
  assert.equal(edit.action, 'update.edit');
  assert.equal(edit.data.message_id, ID(500));
  assert.equal((edit.data.message as Record<string, unknown>).allowed_mentions, undefined, 'an edit never pings');
  await bot('POST', `/_/bot/outbox/${edit.id}/done`, {});

  // Zurück zu den Entwürfen: removing + update.delete; nach der Rückmeldung ist die Zeile weg
  const unpublished = await adminUpdatesHandle({ oys_action: 'update_publish', id: String(id), state: '' });
  assert.deepEqual(unpublished, { tab: 'updates', ok: 'Moved back to drafts. The bot removes its post within a few seconds.' });
  r = (await postOf(id))!;
  assert.equal(r.state, 'removing');
  const [del] = items(await bot('GET', '/_/bot/outbox?f=updates.v1'));
  assert.equal(del.action, 'update.delete');
  await bot('POST', `/_/bot/outbox/${del.id}/done`, { result: { missing: true } });
  assert.equal(await postOf(id), null);
});

test('flash texts for the bot: offline, too old, already queued, and "Post to Discord"', async () => {
  await bot('POST', '/_/bot/hello', report());
  await addUpdate(1, { is_published: 1 });
  await exec("UPDATE oys_meta SET meta_value = ? WHERE meta_key = 'bot_last_seen'", [String(time() - 600)]);
  assert.equal((await adminUpdatesHandle({ oys_action: 'update_discord', id: '1' }))?.ok, 'Queued for the bot – it is offline and posts it when it’s back, within 24 hours.');
  assert.equal((await adminUpdatesHandle({ oys_action: 'update_discord', id: '1' }))?.error, 'Already queued for the bot.');
  await addUpdate(2, { is_published: 0 });
  assert.equal((await adminUpdatesHandle({ oys_action: 'update_publish', id: '2', state: '1' }))?.ok, 'Published – the bot is offline – it posts it when it’s back, within 24 hours.');
  // Ein vom Admin gespeicherter Bot-Kanal, aber der Bot meldet updates.v1 nicht (zu alt)
  await storeSettings({ v: 2, auto_post: true, invite_url: '', bot: { enabled: true, channel_id: UPDATES_CHANNEL, channel_type: 'text', mention: '', saved_at: '2026-11-01 10:00:00' }, webhook: {}, bot_token: '', channel_id: '', mention: '' });
  await bot('POST', '/_/bot/hello', report({ features: [] }));
  await addUpdate(3, { is_published: 1 });
  assert.equal((await adminUpdatesHandle({ oys_action: 'update_discord', id: '3' }))?.ok, 'Queued for the bot – it needs an update before it can post it.');
  // Ohne jedes Ziel
  await exec("DELETE FROM oys_meta WHERE meta_key IN ('discord', 'discord_bot_report')");
  await addUpdate(4);
  assert.equal((await adminUpdatesHandle({ oys_action: 'update_discord', id: '4' }))?.error, 'Discord isn’t set up yet (Admin → Discord).');
});

test('a webhook keeps the bot from posting by itself (no double posts); removing the webhook lets the bot take over', async () => {
  await bot('POST', '/_/bot/hello', report());
  const link = `${discord.base}/webhooks/${HOOK}/${token('k1')}`;
  assert.match(String((await discordAdminHandle('discord_webhook_save', { webhook_link: link }))?.ok), /^Webhook saved and checked/);
  await addUpdate(1);
  assert.equal((await adminUpdatesHandle({ oys_action: 'update_discord', id: '1' }))?.ok, 'Posted to Discord.');
  assert.equal(await postOf(1), null, 'no bot post next to the webhook');
  assert.equal((await postOf(1, 'webhook'))?.state, 'posted');
  assert.equal((await discordAdminHandle('discord_webhook_remove', { _confirmed: '1' }))?.ok, 'Webhook removed. Its earlier posts stay in Discord.');
  assert.equal(await postOf(1, 'webhook'), null, 'its posts are forgotten');
  await addUpdate(2);
  assert.equal((await adminUpdatesHandle({ oys_action: 'update_discord', id: '2' }))?.ok, 'Queued for the bot.');
  assert.equal((await postOf(2))?.state, 'queued');
});

// ------------------------------------------------------------------ Warteschlange

test('outbox: same-ref order, pauses after errors, dead jobs, replays and claimed_at', async () => {
  const a = await outboxAdd('ticket.reply', { id: 1, body: 'a' }, { ref: 'ticket:1' });
  const b = await outboxAdd('ticket.close', { id: 1 }, { ref: 'ticket:1' });
  const c = await outboxAdd('ticket.reply', { id: 2, body: 'c' }, { ref: 'ticket:2' });
  const d = await outboxAdd('suggestion.decided', { id: 9 });
  let got = items(await bot('GET', '/_/bot/outbox')).map((i) => i.id);
  assert.deepEqual(got, [a, c, d], 'the close waits behind the reply of the same ticket');
  for (const id of [a, c, d]) assert.notEqual((await jobById(id))!.claimed_at, null);
  // Fehler: Pause 10 s – solange bekommt der Bot weder den Auftrag noch den nächsten mit demselben ref
  assert.deepEqual((await bot('POST', `/_/bot/outbox/${a}/done`, { error: 'Discord is down' })).json, { ok: true });
  let ja = (await jobById(a))!;
  assert.equal(ja.attempts, 1);
  assert.equal(ja.last_error, 'Discord is down');
  const pause = (Date.parse(String(ja.next_try_at).replace(' ', 'T')) - Date.parse(date('Y-m-d\\TH:i:s'))) / 1000;
  assert.ok(pause >= 9 && pause <= 11, `pause ${pause}`);
  got = items(await bot('GET', '/_/bot/outbox')).map((i) => i.id);
  assert.deepEqual(got, [c, d]);
  // Weitere Fehler verdoppeln die Pause
  await exec('UPDATE community_outbox SET next_try_at = NULL WHERE id = ?', [a]);
  await bot('POST', `/_/bot/outbox/${a}/done`, { error: 'again' });
  ja = (await jobById(a))!;
  const pause2 = (Date.parse(String(ja.next_try_at).replace(' ', 'T')) - Date.parse(date('Y-m-d\\TH:i:s'))) / 1000;
  assert.ok(pause2 >= 19 && pause2 <= 21, `pause ${pause2}`);
  // Nach der Pause wieder dabei, mit der Zahl der Versuche
  await exec('UPDATE community_outbox SET next_try_at = ? WHERE id = ?', [date('Y-m-d H:i:s', time() - 1), a]);
  const again = items(await bot('GET', '/_/bot/outbox'));
  assert.deepEqual(again.map((i) => [i.id, i.attempts]), [[a, 2], [c, 0], [d, 0]]);
  // Erledigt: der nächste desselben Tickets kommt dran; eine wiederholte Rückmeldung ändert nichts
  await bot('POST', `/_/bot/outbox/${a}/done`, {});
  const doneAt = (await jobById(a))!.done_at;
  assert.notEqual(doneAt, null);
  assert.deepEqual((await bot('POST', `/_/bot/outbox/${a}/done`, { error: 'late error' })).json, { ok: true });
  ja = (await jobById(a))!;
  assert.deepEqual([ja.done_at, ja.attempts, ja.last_error], [doneAt, 2, null]);
  assert.ok(items(await bot('GET', '/_/bot/outbox')).some((i) => i.id === b));
  // final: sofort tot – blockiert sein ref nicht mehr
  await bot('POST', `/_/bot/outbox/${b}/done`, { error: 'The ticket channel no longer exists.', final: true });
  assert.equal((await jobById(b))!.attempts, 10);
  const e = await outboxAdd('ticket.reply', { id: 1, body: 'e' }, { ref: 'ticket:1' });
  assert.ok(items(await bot('GET', '/_/bot/outbox')).some((i) => i.id === e));
  // Unbekannter Auftrag: einfach ok
  assert.deepEqual((await bot('POST', '/_/bot/outbox/999999/done', {})).json, { ok: true });
  // Kaputtes result: 400, nichts passiert
  assert.equal((await bot('POST', `/_/bot/outbox/${c}/done`, { result: 'x' })).status, 400);
  assert.equal((await jobById(c))!.done_at, null);
});

test('a registered action: only bots with its feature get it, and onResult runs inside the /done transaction', async () => {
  const seen: Array<[string, boolean]> = [];
  registerBotAction('probe.run', {
    feature: 'probe.v1',
    async onResult(db, job, result, error, final) {
      seen.push([error, final]);
      await db.exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('probe', ?)", [String(job.id)]);
      if (result?.explode === true) throw new Error('probe failed');
    },
  });
  assert.ok(((await bot('GET', '/_/bot/ping')).json.features as string[]).includes('probe.v1'));
  // hello speichert die neue Funktion jetzt (sie ist registriert)
  await bot('POST', '/_/bot/hello', report({ features: ['updates.v1', 'probe.v1'] }));
  assert.deepEqual(JSON.parse(String(await value("SELECT meta_value FROM oys_meta WHERE meta_key = 'discord_bot_report'"))).features, ['updates.v1', 'probe.v1']);
  const id = await outboxAdd('probe.run', { x: 1 }, { ref: 'probe' });
  assert.deepEqual(items(await bot('GET', '/_/bot/outbox?f=updates.v1')), []);
  assert.equal(items(await bot('GET', '/_/bot/outbox?f=updates.v1,probe.v1'))[0].id, id);
  // onResult wirft: alles in der Transaktion zurück – der Auftrag bleibt offen, nichts geschrieben
  const log = console.error;
  console.error = () => undefined;
  try {
    assert.equal((await bot('POST', `/_/bot/outbox/${id}/done`, { result: { explode: true } })).status, 500);
  } finally {
    console.error = log;
  }
  assert.equal((await jobById(id))!.done_at, null);
  assert.equal(await value("SELECT meta_value FROM oys_meta WHERE meta_key = 'probe'"), null);
  // Danach klappt es: erledigt und geschrieben, einmal
  await bot('POST', `/_/bot/outbox/${id}/done`, { result: {} });
  assert.notEqual((await jobById(id))!.done_at, null);
  assert.equal(await value("SELECT meta_value FROM oys_meta WHERE meta_key = 'probe'"), String(id));
  // Fehler ohne final: onResult mit final=false; final: true
  const id2 = await outboxAdd('probe.run', {}, { ref: 'probe2' });
  await bot('POST', `/_/bot/outbox/${id2}/done`, { error: 'try later' });
  await bot('POST', `/_/bot/outbox/${id2}/done`, { error: 'give up', final: true });
  assert.deepEqual(seen.slice(-3), [['', true], ['try later', false], ['give up', true]]);
  await exec("DELETE FROM oys_meta WHERE meta_key = 'probe'");
});

test('hand-out rules for update jobs: recheck, only_if_posted, cancel, 24-hour and 2-minute expiry, skipped edits', async () => {
  await bot('POST', '/_/bot/hello', report());
  for (const id of [1, 2, 3, 4, 5]) {
    await addUpdate(id);
    await announce((await updateGet(id))!, await delivery());
  }
  const row = async (id: number) => (await postOf(id))!;
  const job = async (id: number) => (await jobsOf(Number((await row(id)).id)))[0];
  const old = date('Y-m-d H:i:s', time() - 86401);
  // 1: nie abgeholt, älter als 24 h → verfällt, Beitrag „failed“ mit Hinweis
  await exec('UPDATE community_outbox SET created_at = ? WHERE id = ?', [old, (await job(1)).id]);
  // 2: abgeholt, älter als 24 h → nur melden, was schon da ist
  await exec('UPDATE community_outbox SET created_at = ?, claimed_at = ? WHERE id = ?', [old, old, (await job(2)).id]);
  // 3: abgeholt (Bot war weg) → erst nachsehen
  await exec('UPDATE community_outbox SET claimed_at = ? WHERE id = ?', [date('Y-m-d H:i:s'), (await job(3)).id]);
  // 4: entfernt, nie abgeholt → abbrechen, Zeile weg
  await exec("UPDATE update_discord_posts SET state = 'removing' WHERE id = ?", [(await row(4)).id]);
  // 5: entfernt, abgeholt → nur melden
  await exec("UPDATE update_discord_posts SET state = 'removing' WHERE id = ?", [(await row(5)).id]);
  await exec('UPDATE community_outbox SET claimed_at = ? WHERE id = ?', [date('Y-m-d H:i:s'), (await job(5)).id]);
  const jobs = Object.fromEntries(await Promise.all([1, 2, 3, 4, 5].map(async (i) => [i, Number((await job(i)).id)])));
  const got = items(await bot('GET', '/_/bot/outbox?f=updates.v1'));
  const byId = new Map(got.map((g) => [g.id, g]));
  assert.equal(byId.has(jobs[1]), false);
  const j1 = (await jobById(jobs[1]))!;
  assert.deepEqual([j1.last_error, j1.done_at !== null], ['expired', true]);
  assert.deepEqual([(await row(1)).state, (await row(1)).error], ['failed', TEXTS.notPicked]);
  assert.deepEqual([byId.get(jobs[2])?.data.only_if_posted, byId.get(jobs[2])?.data.recheck], [true, true]);
  assert.deepEqual([byId.get(jobs[3])?.data.only_if_posted, byId.get(jobs[3])?.data.recheck], [false, true]);
  assert.equal(byId.has(jobs[4]), false);
  assert.equal((await jobById(jobs[4]))!.last_error, 'cancelled');
  assert.equal(await postOf(4), null);
  assert.equal(byId.get(jobs[5])?.data.only_if_posted, true);
  // only_if_posted ohne eigenen Beitrag: queued → failed, removing → Zeile weg
  await bot('POST', `/_/bot/outbox/${jobs[2]}/done`, { result: { found: false } });
  assert.deepEqual([(await row(2)).state, (await row(2)).error], ['failed', TEXTS.notPicked]);
  await bot('POST', `/_/bot/outbox/${jobs[5]}/done`, { result: { found: false } });
  assert.equal(await postOf(5), null);
  // Ein Edit für einen Beitrag, der nicht (mehr) gepostet ist: übersprungen
  const editId = await outboxAdd('update.edit', { post_id: (await row(1)).id, channel_id: UPDATES_CHANNEL, message_id: ID(1), kind: 'message', message: {} }, { ref: 'post:' + (await row(1)).id });
  assert.equal(items(await bot('GET', '/_/bot/outbox?f=updates.v1')).some((i) => i.id === editId), false);
  assert.equal((await jobById(editId))!.last_error, 'skipped');
  // Ein Test, der länger als 2 Minuten wartet, verfällt; der Stand des Tests sagt es
  const testId = await outboxAdd('update.test', { channel_id: UPDATES_CHANNEL, kind: 'text', message: {} }, { ref: 'test' });
  await exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('discord_bot_test', ?)", [JSON.stringify({ at: date('Y-m-d H:i:s'), state: 'queued', job_id: testId, channel_id: UPDATES_CHANNEL, error: '' })]);
  await exec('UPDATE community_outbox SET created_at = ? WHERE id = ?', [date('Y-m-d H:i:s', time() - 121), testId]);
  assert.equal(items(await bot('GET', '/_/bot/outbox?f=updates.v1')).some((i) => i.id === testId), false);
  assert.equal(JSON.parse(String(await value("SELECT meta_value FROM oys_meta WHERE meta_key = 'discord_bot_test'"))).state, 'expired');
});

test('results: a dead post fails, a dead edit stays posted with its error, a dead delete is "couldn’t remove", a missing message is forgotten', async () => {
  await bot('POST', '/_/bot/hello', report());
  for (const id of [1, 2, 3]) {
    await addUpdate(id);
    await announce((await updateGet(id))!, await delivery());
  }
  const postId = async (id: number) => Number((await postOf(id))!.id);
  const take = async (action: string) => items(await bot('GET', '/_/bot/outbox?f=updates.v1')).filter((i) => i.action === action);
  // 1: zehn Fehler → tot → failed mit dem letzten Fehler
  const pid1 = await postId(1);
  const p1 = (await take('update.post')).find((i) => Number(i.data.post_id) === pid1)!;
  for (let i = 0; i < 10; i++) {
    await exec('UPDATE community_outbox SET next_try_at = NULL WHERE id = ?', [p1.id]);
    await bot('POST', `/_/bot/outbox/${p1.id}/done`, { error: 'The bot can’t post in #updates: it needs Send Messages there.' });
  }
  const r1 = (await postOf(1))!;
  assert.deepEqual([r1.state, r1.error], ['failed', 'The bot can’t post in #updates: it needs Send Messages there.']);
  // „Post to Discord“ noch einmal: neuer Auftrag, der tote ist erledigt (er steht nicht mehr als Fehler im Community-Bereich)
  assert.equal((await adminUpdatesHandle({ oys_action: 'update_discord', id: '1' }))?.ok, 'Queued for the bot.');
  assert.deepEqual([(await jobById(p1.id))!.last_error, (await jobById(p1.id))!.done_at !== null], ['retried', true]);
  assert.equal((await postOf(1))!.state, 'queued');
  // 2: gepostet, dann ein toter Edit: bleibt posted, mit Fehler
  const posts = await take('update.post');
  for (const p of posts) await bot('POST', `/_/bot/outbox/${p.id}/done`, { result: { message_id: ID(700 + Number(p.data.update_id)), channel_id: UPDATES_CHANNEL } });
  await syncEdit((await updateGet(2))!, await delivery());
  const [e2] = await take('update.edit');
  await bot('POST', `/_/bot/outbox/${e2.id}/done`, { error: 'Missing Permissions (50013)', final: true });
  const r2 = (await postOf(2))!;
  assert.deepEqual([r2.state, r2.error], ['posted', 'Missing Permissions (50013)']);
  // Retry eines Beitrags mit Fehler: ein neuer Edit
  assert.deepEqual(await retry(await postId(2), await delivery()), { ok: true, text: 'The bot updates its post within a few seconds.' });
  const [e2b] = await take('update.edit');
  await bot('POST', `/_/bot/outbox/${e2b.id}/done`, { result: { missing: true } });
  assert.equal(await postOf(2), null, 'deleted in Discord: forgotten');
  // 3: Entfernen scheitert endgültig → remove_failed; Forget beendet die Aufträge und vergisst den Beitrag
  await adminUpdatesHandle({ oys_action: 'update_publish', id: '3', state: '' });
  const [d3] = await take('update.delete');
  await bot('POST', `/_/bot/outbox/${d3.id}/done`, { error: 'Missing Access (50001)', final: true });
  const r3 = (await postOf(3))!;
  assert.deepEqual([r3.state, r3.error], ['remove_failed', 'Missing Access (50001)']);
  assert.equal((await adminUpdatesHandle({ oys_action: 'update_publish', id: '3', state: '1' }))?.error, 'Published. But Discord: ' + TEXTS.removeFailedFirst);
  assert.deepEqual(await forget(Number(r3.id)), { ok: true, text: 'Forgotten. If the message is in Discord, it stays there.' });
  assert.equal(await postOf(3), null);
  assert.equal((await q("SELECT id FROM community_outbox WHERE ref = ? AND done_at IS NULL", ['post:' + r3.id])).length, 0);
});

test('the old token: it keeps posting after the migration; deleting it hands its posts to the installed bot (legacy)', async () => {
  await storeSettings({ mode: 'bot', webhook_url: '', bot_token: GOOD_TOKEN, channel_id: ID(40), mention: '', username: '', avatar_url: '', invite_url: '', auto_post: true });
  await addUpdate(1);
  assert.equal((await adminUpdatesHandle({ oys_action: 'update_discord', id: '1' }))?.ok, 'Posted to Discord.');
  const tokenRow = (await postOf(1, 'token'))!;
  assert.deepEqual([tokenRow.state, tokenRow.legacy, tokenRow.target], ['posted', 1, 'bot:' + ID(40)]);
  assert.equal(discord.calls()[0].auth, 'Bot ' + GOOD_TOKEN);
  // Der Bot ist installiert und meldet sich; der Admin löscht den Token
  await bot('POST', '/_/bot/hello', report());
  assert.equal((await discordAdminHandle('discord_token_remove', { _confirmed: '1' }))?.ok, 'The old bot token is deleted from the website.');
  assert.equal((await storedSettings())?.bot_token, '');
  assert.equal(await postOf(1, 'token'), null);
  const legacy = (await postOf(1, 'bot'))!;
  assert.deepEqual([legacy.state, legacy.legacy, legacy.channel_id, legacy.message_id], ['posted', 1, ID(40), tokenRow.message_id]);
  // Der Bot versucht zu bearbeiten; eine Nachricht einer anderen Anwendung kann er nicht ändern
  await adminUpdatesHandle({ oys_action: 'update_save', id: '1', title: 'Edited', publish: '1' });
  const [e] = items(await bot('GET', '/_/bot/outbox?f=updates.v1')).filter((i) => i.action === 'update.edit');
  assert.equal(e.data.channel_id, ID(40));
  await bot('POST', `/_/bot/outbox/${e.id}/done`, { error: 'Cannot edit a message authored by another user (50005)', final: true });
  assert.deepEqual([(await postOf(1, 'bot'))!.state, (await postOf(1, 'bot'))!.error], ['posted', TEXTS.otherBot]);
  // Ohne installierten Bot werden die Beiträge des Tokens beim Löschen vergessen
  await exec('DELETE FROM update_discord_posts');
  await storeSettings({ mode: 'bot', webhook_url: '', bot_token: GOOD_TOKEN, channel_id: ID(40), mention: '', username: '', avatar_url: '', invite_url: '', auto_post: true });
  await adminUpdatesHandle({ oys_action: 'update_discord', id: '1' });
  useConfig({ bot_secret: '' });
  assert.equal((await discordAdminHandle('discord_token_remove', { _confirmed: '1' }))?.ok, 'The old bot token is deleted from the website.');
  assert.equal((await q('SELECT id FROM update_discord_posts')).length, 0);
});

test('without an installed bot: edits leave its posts marked, removals become "couldn’t remove" with today’s note', async () => {
  await bot('POST', '/_/bot/hello', report());
  await addUpdate(1);
  await announce((await updateGet(1))!, await delivery());
  const [p] = items(await bot('GET', '/_/bot/outbox?f=updates.v1'));
  await bot('POST', `/_/bot/outbox/${p.id}/done`, { result: { message_id: ID(800), channel_id: UPDATES_CHANNEL } });
  useConfig({ bot_secret: '' });
  assert.deepEqual(await adminUpdatesHandle({ oys_action: 'update_save', id: '1', title: 'Changed', publish: '1' }),
    { tab: 'updates', error: 'Update published. Its Discord post wasn’t updated – the Discord bot isn’t set up.' });
  assert.equal((await postOf(1))!.error, TEXTS.noBotEdit);
  assert.deepEqual(await adminUpdatesHandle({ oys_action: 'update_publish', id: '1', state: '' }),
    { tab: 'updates', error: 'Moved back to drafts. Discord isn’t connected, so its post there was not removed.' });
  assert.deepEqual([(await postOf(1))!.state, (await postOf(1))!.error], ['remove_failed', TEXTS.noBotRemove]);
});

test('deleting an update: bot posts stay "removing" until the bot confirms; a transient webhook error aborts before the bot gets a job', async () => {
  await bot('POST', '/_/bot/hello', report());
  await addUpdate(1);
  await announce((await updateGet(1))!, await delivery());
  const [p] = items(await bot('GET', '/_/bot/outbox?f=updates.v1'));
  await bot('POST', `/_/bot/outbox/${p.id}/done`, { result: { message_id: ID(900), channel_id: UPDATES_CHANNEL } });
  assert.deepEqual(await adminUpdatesHandle({ oys_action: 'update_delete', id: '1' }), { tab: 'updates', ok: 'Update deleted. The bot removes its post within a few seconds.' });
  assert.equal(await updateGet(1), null);
  assert.equal((await postOf(1))!.state, 'removing', 'the row outlives the update until Discord confirms');
  const [d] = items(await bot('GET', '/_/bot/outbox?f=updates.v1'));
  await bot('POST', `/_/bot/outbox/${d.id}/done`, {});
  assert.equal(await postOf(1), null);
  // Webhook + Bot-Beitrag: ein kurzer Aussetzer beim Webhook bricht alles ab, bevor der Bot einen Auftrag bekommt
  await addUpdate(2);
  await announce((await updateGet(2))!, await delivery());
  const [p2] = items(await bot('GET', '/_/bot/outbox?f=updates.v1'));
  await bot('POST', `/_/bot/outbox/${p2.id}/done`, { result: { message_id: ID(901), channel_id: UPDATES_CHANNEL } });
  await exec(`INSERT INTO update_discord_posts (update_id, via, target, kind, message_id, state, created_at, updated_at) VALUES (2, 'webhook', 'webhook:${HOOK}', 'message', ?, 'posted', NOW(), NOW())`, [ID(902)]);
  await storeSettings({ v: 2, auto_post: true, invite_url: '', bot: {}, webhook: { enabled: true, url: `${discord.base}/webhooks/${HOOK}/${token('k2')}` }, bot_token: '', channel_id: '', mention: '' });
  discord.failNext(503);
  const r = await adminUpdatesHandle({ oys_action: 'update_delete', id: '2' });
  assert.equal(r?.error, 'Nothing was deleted, because its Discord post couldn’t be removed: Discord had a problem (503) – please try again in a moment.');
  assert.ok(await updateGet(2));
  assert.equal((await postOf(2))!.state, 'posted', 'the bot post is untouched');
  assert.equal((await q("SELECT id FROM community_outbox WHERE action = 'update.delete' AND done_at IS NULL")).length, 0);
});

// ------------------------------------------------------------------ Rennen (zwei Abläufe, Haltepunkte)

test('race: the bot’s result and an unpublish, in both orders – the row ends "removing" with a delete job, never stuck', async () => {
  await bot('POST', '/_/bot/hello', report());
  for (const order of ['done first', 'unpublish first'] as const) {
    await exec('DELETE FROM updates');
    await exec('DELETE FROM update_discord_posts');
    await exec('DELETE FROM community_outbox');
    await addUpdate(1);
    await announce((await updateGet(1))!, await delivery());
    const [p] = items(await bot('GET', '/_/bot/outbox?f=updates.v1'));
    const g = gate(order === 'done first' ? 'result:locked' : 'remove:locked', postHooks);
    const first = order === 'done first'
      ? bot('POST', `/_/bot/outbox/${p.id}/done`, { result: { message_id: ID(950), channel_id: UPDATES_CHANNEL } })
      : adminUpdatesHandle({ oys_action: 'update_publish', id: '1', state: '' });
    await g.arrived;
    const second = order === 'done first'
      ? adminUpdatesHandle({ oys_action: 'update_publish', id: '1', state: '' })
      : bot('POST', `/_/bot/outbox/${p.id}/done`, { result: { message_id: ID(950), channel_id: UPDATES_CHANNEL } });
    await settle();
    g.open();
    await Promise.all([first, second]);
    postHooks.pause = null;
    const row = (await postOf(1))!;
    assert.equal(row.state, 'removing', order);
    assert.equal(row.message_id, ID(950), order);
    const open = await q("SELECT action FROM community_outbox WHERE ref = ? AND done_at IS NULL", ['post:' + row.id]);
    assert.deepEqual(open.map((o) => o.action), ['update.delete'], order);
  }
});

test('race: an edit against the bot’s result is never lost (dirty or a new job)', async () => {
  await bot('POST', '/_/bot/hello', report());
  for (const order of ['done first', 'edit first'] as const) {
    await exec('DELETE FROM updates');
    await exec('DELETE FROM update_discord_posts');
    await exec('DELETE FROM community_outbox');
    await addUpdate(1);
    await announce((await updateGet(1))!, await delivery());
    const [p] = items(await bot('GET', '/_/bot/outbox?f=updates.v1'));
    await exec("UPDATE updates SET title = 'Edited title' WHERE id = 1");
    const g = gate(order === 'done first' ? 'result:locked' : 'edit:locked', postHooks);
    const first = order === 'done first'
      ? bot('POST', `/_/bot/outbox/${p.id}/done`, { result: { message_id: ID(960), channel_id: UPDATES_CHANNEL } })
      : syncEdit((await updateGet(1))!, await delivery());
    await g.arrived;
    const second = order === 'done first'
      ? syncEdit((await updateGet(1))!, await delivery())
      : bot('POST', `/_/bot/outbox/${p.id}/done`, { result: { message_id: ID(960), channel_id: UPDATES_CHANNEL } });
    await settle();
    g.open();
    await Promise.all([first, second]);
    postHooks.pause = null;
    const row = (await postOf(1))!;
    assert.deepEqual([row.state, row.dirty], ['posted', 0], order);
    const [edit] = items(await bot('GET', '/_/bot/outbox?f=updates.v1'));
    assert.equal(edit?.action, 'update.edit', order);
    assert.match(JSON.stringify(edit.data.message), /Edited title/, order);
  }
});

test('race: two announces to the webhook post once (the other hears "Already posting"); two to the bot queue one job', async () => {
  const link = `${discord.base}/webhooks/${HOOK}/${token('k3')}`;
  await discordAdminHandle('discord_webhook_save', { webhook_link: link });
  await addUpdate(1);
  discord.restart();
  const d = await delivery();
  const g = gate('announce:claimed', postHooks);
  const first = announce((await updateGet(1))!, d);
  await g.arrived;
  const second = await announce((await updateGet(1))!, d);
  g.open();
  assert.deepEqual(await first, [{ via: 'webhook', what: 'posted' }]);
  assert.deepEqual(second, [{ via: 'webhook', what: 'busy', text: TEXTS.alreadyPosting }]);
  assert.equal(discord.calls().filter((c) => c.method === 'POST').length, 1, 'exactly one post at Discord');
  postHooks.pause = null;

  await discordAdminHandle('discord_webhook_remove', { _confirmed: '1' });
  await bot('POST', '/_/bot/hello', report());
  await addUpdate(2);
  const d2 = await delivery();
  const g2 = gate('announce:queued', postHooks);
  const a = announce((await updateGet(2))!, d2);
  await g2.arrived;
  const b = announce((await updateGet(2))!, d2);
  await settle();
  g2.open();
  const results = await Promise.all([a, b]);
  postHooks.pause = null;
  assert.deepEqual(results.map((r) => r[0].what).sort(), ['busy', 'queued']);
  assert.equal((await q("SELECT id FROM community_outbox WHERE action = 'update.post'")).length, 1, 'one job');
});

// ------------------------------------------------------------------ Aufräumen

test('clean-up: stuck posts, posts of deleted updates, old done jobs and posts no bot picked up', async () => {
  await addUpdate(1);
  await addUpdate(2);
  const long = date('Y-m-d H:i:s', time() - 300);
  await exec(`INSERT INTO update_discord_posts (update_id, via, target, kind, state, created_at, updated_at) VALUES (1, 'webhook', 'webhook:${HOOK}', 'message', 'posting', ?, ?)`, [long, long]);
  await exec(`INSERT INTO update_discord_posts (update_id, via, target, kind, message_id, state, created_at, updated_at) VALUES (99, 'webhook', 'webhook:${HOOK}', 'message', ?, 'posted', NOW(), NOW())`, [ID(1)]);
  await exec(`INSERT INTO update_discord_posts (update_id, via, target, kind, message_id, state, created_at, updated_at) VALUES (2, 'webhook', 'webhook:${HOOK}', 'message', ?, 'posted', NOW(), NOW())`, [ID(2)]);
  const oldDone = await outboxAdd('ticket.reply', {});
  await exec('UPDATE community_outbox SET done_at = ? WHERE id = ?', [date('Y-m-d H:i:s', time() - 31 * 86400), oldDone]);
  const recentDone = await outboxAdd('ticket.reply', {});
  await exec('UPDATE community_outbox SET done_at = ? WHERE id = ?', [date('Y-m-d H:i:s', time() - 86400), recentDone]);
  // Ein Beitrag für den Bot, den nie ein passender Bot abgeholt hat (nur ein alter Bot fragt)
  await bot('POST', '/_/bot/hello', report());
  await addUpdate(3);
  await announce((await updateGet(3))!, await delivery());
  await exec("UPDATE community_outbox SET created_at = ? WHERE action = 'update.post'", [date('Y-m-d H:i:s', time() - 86401)]);
  assert.deepEqual(items(await bot('GET', '/_/bot/outbox')), []);
  assert.equal(await outboxCleanup(), true);
  assert.deepEqual([(await postOf(1, 'webhook'))!.state, (await postOf(1, 'webhook'))!.error], ['failed', TEXTS.stuck]);
  assert.deepEqual([(await postOf(99, 'webhook'))!.state, (await postOf(99, 'webhook'))!.error], ['remove_failed', TEXTS.orphan]);
  assert.equal((await postOf(2, 'webhook'))!.state, 'posted');
  assert.equal(await jobById(oldDone), null);
  assert.ok(await jobById(recentDone));
  assert.deepEqual([(await postOf(3))!.state, (await postOf(3))!.error], ['failed', TEXTS.notPicked]);
  // Ein zweiter Prozess räumt nicht gleichzeitig auf
  const lockName = configString('db.name') + ':oys_outbox_cleanup';
  await withConnection(async (db) => {
    await db.value('SELECT GET_LOCK(?, 0)', [lockName]);
    try {
      assert.equal(await (async () => {
        const { outsidePinned } = await import('../src/db.js');
        return outsidePinned(() => outboxCleanup());
      })(), false);
    } finally {
      await db.value('SELECT RELEASE_LOCK(?)', [lockName]);
    }
  });
});

// ------------------------------------------------------------------ Schritt V_DISCORD_DELIVERY

test('migration: v1 settings become v2 without a mirror, posts from before become rows (webhook, forum, thread, token); a re-run changes nothing', async () => {
  const m = await testDatabase('dpmig', { empty: true });
  try {
    setConfigForTests({ ...BASE, db: { ...(BASE.db as ConfigData), name: m.name } });
    await ensureSchema({ upTo: V_DISCORD_DELIVERY - 1 });
    const db = '`' + m.name + '`';
    const v1 = { mode: 'bot', webhook_url: 'https://discord.com/api/webhooks/123456789012345678/' + token('mm'), bot_token: GOOD_TOKEN, channel_id: ID(40),
      mention: 'here', username: 'admin@test.de', avatar_url: 'https://x.y/a.png', invite_url: 'https://discord.gg/x', auto_post: false, post_in: 'channel' };
    await m.admin.query(`REPLACE INTO ${db}.oys_meta (meta_key, meta_value) VALUES ('discord', ?)`, [String(encryptData(JSON.stringify(v1)))]);
    await m.admin.query(`INSERT INTO ${db}.community_outbox (action, payload, attempts, created_at) VALUES ('ticket.reply', '{}', 0, NOW())`);
    const up = (id: number, msg: string | null, target: string | null) =>
      m.admin.query(`INSERT INTO ${db}.updates (id, title, is_published, discord_message_id, discord_target, created_at) VALUES (?, ?, 1, ?, ?, NOW())`, [id, 'U' + id, msg, target]);
    await up(101, ID(201), 'webhook:123456');
    await up(102, ID(202), 'webhook:123456:' + ID(202)); // neuer Forenbeitrag (Thread-ID = Nachricht)
    await up(103, ID(203), 'webhook:123456:' + ID(299)); // Nachricht in einem Thread
    await up(104, ID(204), 'bot:' + ID(40)); // alter Token
    await up(105, ID(205), 'garbage');
    await up(106, '', 'webhook:123456');
    await up(107, null, null);
    await ensureSchema();
    const rows = async () => (await m.admin.query<RowDataPacket[]>(`SELECT update_id, via, target, kind, channel_id, message_id, state, legacy FROM ${db}.update_discord_posts ORDER BY update_id`))[0];
    const first = await rows();
    assert.deepEqual(first.map((r) => [r.update_id, r.via, r.target, r.kind, r.channel_id, r.message_id, r.state, r.legacy]), [
      [101, 'webhook', 'webhook:123456', 'message', null, ID(201), 'posted', 0],
      [102, 'webhook', 'webhook:123456', 'forum_post', ID(202), ID(202), 'posted', 0],
      [103, 'webhook', 'webhook:123456', 'thread_msg', ID(299), ID(203), 'posted', 0],
      [104, 'token', 'bot:' + ID(40), 'message', ID(40), ID(204), 'posted', 1],
    ]);
    // Die alten Spalten bleiben stehen
    assert.equal((await m.admin.query<RowDataPacket[]>(`SELECT discord_target FROM ${db}.updates WHERE id = 104`))[0][0].discord_target, 'bot:' + ID(40));
    // Einstellungen v2 ohne die alte Form; der Token bleibt (er ist noch das Ziel), der Webhook bleibt aus
    const raw = (await m.admin.query<RowDataPacket[]>(`SELECT meta_value FROM ${db}.oys_meta WHERE meta_key = 'discord'`))[0][0].meta_value as string;
    assert.match(raw, /^ENC:/);
    const v2 = JSON.parse(String(decryptData(raw))) as Record<string, unknown>;
    assert.equal(v2.v, 2);
    for (const k of ['mode', 'webhook_url', 'username', 'avatar_url']) assert.equal(k in v2, false, `no v1 key ${k}`);
    assert.equal(v2.bot_token, GOOD_TOKEN);
    assert.equal(v2.channel_id, ID(40));
    assert.equal(v2.mention, 'here');
    assert.equal(v2.auto_post, false);
    assert.equal(v2.invite_url, 'https://discord.gg/x');
    assert.deepEqual([(v2.webhook as Record<string, unknown>).enabled, (v2.webhook as Record<string, unknown>).display_name], [false, '']);
    assert.deepEqual([(v2.bot as Record<string, unknown>).enabled, (v2.bot as Record<string, unknown>).channel_id], [false, ID(40)]);
    // Warteschlange: neue Spalten und Index
    const cols = (await m.admin.query<RowDataPacket[]>(`SHOW COLUMNS FROM ${db}.community_outbox`))[0].map((c) => c.Field);
    for (const c of ['ref', 'next_try_at', 'claimed_at']) assert.ok(cols.includes(c), c);
    await withConnection(async (_d, conn) => assert.equal(await hasIndex(conn, 'community_outbox', 'idx_ref'), true));
    // Noch einmal (z. B. nach einem Abbruch zwischen zwei Schritten): nichts ändert sich
    await m.admin.query(`REPLACE INTO ${db}.oys_meta (meta_key, meta_value) VALUES ('schema_version', ?)`, [String(V_DISCORD_DELIVERY - 1)]);
    await ensureSchema();
    assert.deepEqual(await rows(), first);
    assert.equal((await m.admin.query<RowDataPacket[]>(`SELECT meta_value FROM ${db}.oys_meta WHERE meta_key = 'discord'`))[0][0].meta_value === raw, true, 'v2 is not converted again');
    // Ohne gespeicherten Token übernimmt der installierte Bot dessen Beiträge; ohne Bot werden sie nicht übernommen
    await m.admin.query(`DELETE FROM ${db}.update_discord_posts`);
    await withConnection(async (_d, conn) => {
      assert.equal(await convertLegacyPosts(conn, { tokenStored: false, botInstalled: true }), 4);
      const bot = (await m.admin.query<RowDataPacket[]>(`SELECT via, target, legacy FROM ${db}.update_discord_posts WHERE update_id = 104`))[0][0];
      assert.deepEqual([bot.via, bot.target, bot.legacy], ['bot', 'bot', 1]);
      await m.admin.query(`DELETE FROM ${db}.update_discord_posts`);
      assert.equal(await convertLegacyPosts(conn, { tokenStored: false, botInstalled: false }), 3);
    });
  } finally {
    await m.done();
    useConfig();
  }
});

test('migration with a wrong key keeps the stored settings and still adds the tables', async () => {
  const m = await testDatabase('dpmig2', { empty: true });
  try {
    setConfigForTests({ ...BASE, db: { ...(BASE.db as ConfigData), name: m.name } });
    await ensureSchema({ upTo: V_DISCORD_DELIVERY - 1 });
    const db = '`' + m.name + '`';
    setConfigForTests({ ...BASE, db: { ...(BASE.db as ConfigData), name: m.name }, aes_key: 'k'.repeat(32) });
    const foreign = String(encryptData(JSON.stringify({ mode: 'webhook', webhook_url: 'x' })));
    setConfigForTests({ ...BASE, db: { ...(BASE.db as ConfigData), name: m.name } });
    await m.admin.query(`REPLACE INTO ${db}.oys_meta (meta_key, meta_value) VALUES ('discord', ?)`, [foreign]);
    await ensureSchema();
    assert.equal((await m.admin.query<RowDataPacket[]>(`SELECT meta_value FROM ${db}.oys_meta WHERE meta_key = 'discord'`))[0][0].meta_value, foreign);
    assert.equal((await m.admin.query<RowDataPacket[]>(`SHOW TABLES FROM ${db} LIKE 'update_discord_posts'`))[0].length, 1);
  } finally {
    await m.done();
    useConfig();
  }
});
