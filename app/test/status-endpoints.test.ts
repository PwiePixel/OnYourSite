// Statusseiten über HTTP (Fastify inject gegen den ganzen Server): /_/health mit und ohne Datenbank, Heartbeats
// /_/hb/<token> und /fail (Schreiben höchstens alle 10 s, Grenzen je Token und für unbekannte Tokens je Absender,
// unbekannte Tokens 60 s ohne Datenbank, pausiert → „OK (paused)“), dazu die Befehle ping/planned und der Start der
// Webseite.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import type { FastifyInstance } from 'fastify';
import { setConfigForTests, type ConfigData } from '../src/config.js';
import { closePool } from '../src/db.js';
import { ensureSchema } from '../src/schema.js';
import { buildServer } from '../src/server.js';
import { recordWebStart, resetHealthCacheForTests, resetHeartbeatMemoryForTests } from '../src/status/endpoints.js';
import { statusCommand, statusPing, statusPlanned } from '../src/status/commands.js';
import { BASE, testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
let app: FastifyInstance;
let page = 0;

async function q(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  await t.admin.query(`USE \`${t.name}\``);
  return (await t.admin.query<RowDataPacket[]>(sql, params))[0];
}

const token = (): string => randomBytes(24).toString('base64url');
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

async function heartbeat(tok: string, o: { paused?: boolean } = {}): Promise<number> {
  await q(`INSERT INTO status_monitors (page_id, user_id, type, name, hb_token_hash, config, is_paused, changed_at, created_at, updated_at)
    VALUES (?, 5, 'heartbeat', 'Nightly job', ?, '{"period":3600,"grace":300}', ?, 0, NOW(), NOW())`, [page, sha(tok), o.paused ? 1 : 0]);
  return Number((await q('SELECT id FROM status_monitors WHERE hb_token_hash = ?', [sha(tok)]))[0].id);
}

const get = (url: string, method: 'GET' | 'HEAD' | 'POST' | 'PUT' = 'GET', ip = '203.0.113.7') =>
  app.inject({ method, url, headers: { host: 'oys.test:8080' }, remoteAddress: ip });

before(async () => {
  t = await testDatabase('st2http');
  await ensureSchema();
  await q("INSERT INTO status_pages (user_id, is_system, slug, title, created_at, updated_at) VALUES (5, 0, 'mia-status', 'Mia', NOW(), NOW())");
  page = Number((await q("SELECT id FROM status_pages WHERE slug = 'mia-status'"))[0].id);
  app = await buildServer();
});

after(async () => {
  await app.close();
  await t.done();
});

test('/_/health: ok with the database, cached for 2 s, noindex and no-store, on every host', async () => {
  resetHealthCacheForTests();
  const res = await get('/_/health');
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body) as { ok: boolean; db: boolean; time: number };
  assert.deepEqual([body.ok, body.db], [true, true]);
  assert.ok(Math.abs(body.time - Date.now() / 1000) < 5);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-robots-tag'], 'noindex');
  assert.match(String(res.headers['content-type']), /^application\/json/);
  assert.equal(res.headers['set-cookie'], undefined);
  const sub = await app.inject({ method: 'GET', url: '/_/health', headers: { host: 'health.oys.test:8080' } });
  assert.equal(sub.statusCode, 200);
  assert.equal((await get('/_/health', 'POST')).statusCode, 405);
});

test('/_/health without a database: 503 as JSON (not the HTML error page)', async () => {
  resetHealthCacheForTests();
  await closePool();
  setConfigForTests({ ...BASE, db: { ...(BASE.db as ConfigData), name: t.name, host: '127.0.0.1', port: '1' }, uploads_dir: t.uploads });
  try {
    const res = await get('/_/health');
    assert.equal(res.statusCode, 503);
    assert.deepEqual(JSON.parse(res.body), { ok: false, db: false });
    assert.equal(res.headers['cache-control'], 'no-store');
  } finally {
    await closePool();
    setConfigForTests({ ...BASE, db: { ...(BASE.db as ConfigData), name: t.name }, uploads_dir: t.uploads });
    resetHealthCacheForTests();
  }
  assert.equal((await get('/_/health')).statusCode, 200);
});

test('heartbeats: a ping and /fail are stored, at most once per 10 s per token; the answer is plain text', async () => {
  resetHeartbeatMemoryForTests();
  const tok = token();
  assert.equal(tok.length, 32);
  const id = await heartbeat(tok);
  const res = await get(`/_/hb/${tok}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'OK');
  assert.match(String(res.headers['content-type']), /^text\/plain/);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-robots-tag'], 'noindex');
  const first = Number((await q('SELECT hb_last_ping_at FROM status_monitors WHERE id = ?', [id]))[0].hb_last_ping_at);
  assert.ok(Math.abs(first - Date.now() / 1000) < 5);
  // Eine Sekunde zurück: der nächste Ping schreibt nicht (weniger als 10 s)
  await q('UPDATE status_monitors SET hb_last_ping_at = ? WHERE id = ?', [first - 5, id]);
  assert.equal((await get(`/_/hb/${tok}/`, 'POST')).body, 'OK');
  assert.equal(Number((await q('SELECT hb_last_ping_at FROM status_monitors WHERE id = ?', [id]))[0].hb_last_ping_at), first - 5);
  await q('UPDATE status_monitors SET hb_last_ping_at = ? WHERE id = ?', [first - 11, id]);
  await get(`/_/hb/${tok}`);
  assert.ok(Number((await q('SELECT hb_last_ping_at FROM status_monitors WHERE id = ?', [id]))[0].hb_last_ping_at) >= first);
  // /fail
  const fail = await get(`/_/hb/${tok}/fail`);
  assert.equal(fail.body, 'OK');
  assert.ok((await q('SELECT hb_last_fail_at FROM status_monitors WHERE id = ?', [id]))[0].hb_last_fail_at !== null);
  // HEAD ohne Inhalt, andere Methoden nicht
  const head = await get(`/_/hb/${tok}`, 'HEAD');
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');
  const put = await get(`/_/hb/${tok}`, 'PUT');
  assert.equal(put.statusCode, 405);
  assert.equal(put.headers.allow, 'GET, HEAD, POST');
});

test('heartbeats: a paused check answers "OK (paused)" and writes nothing; wrong paths are 404', async () => {
  resetHeartbeatMemoryForTests();
  const tok = token();
  const id = await heartbeat(tok, { paused: true });
  const res = await get(`/_/hb/${tok}`);
  assert.deepEqual([res.statusCode, res.body], [200, 'OK (paused)']);
  assert.equal((await q('SELECT hb_last_ping_at FROM status_monitors WHERE id = ?', [id]))[0].hb_last_ping_at, null);
  for (const url of ['/_/hb/short', '/_/hb/' + 'a'.repeat(33), '/_/hb/' + 'a'.repeat(31) + '!', `/_/hb/${tok}/other`]) {
    assert.equal((await get(url)).statusCode, 404, url);
  }
});

test('heartbeats: unknown tokens are remembered 60 s (no database read), limits per token and for unknown tokens per client', async () => {
  resetHeartbeatMemoryForTests();
  const tok = token();
  assert.equal((await get(`/_/hb/${tok}`)).statusCode, 404);
  // Jetzt gäbe es das Token – die Antwort bleibt 404, weil der Prozess es sich als unbekannt gemerkt hat
  await heartbeat(tok);
  const again = await get(`/_/hb/${tok}`);
  assert.deepEqual([again.statusCode, again.body], [404, 'Not found']);
  resetHeartbeatMemoryForTests();
  assert.equal((await get(`/_/hb/${tok}`)).statusCode, 200);

  // Je Token 10 in 10 s; zwei Tokens hinter derselben Adresse bekommen je 10
  resetHeartbeatMemoryForTests();
  const a = token();
  const b = token();
  await heartbeat(a);
  await heartbeat(b);
  for (let i = 0; i < 10; i++) {
    assert.equal((await get(`/_/hb/${a}`, 'GET', '198.51.100.9')).statusCode, 200);
    assert.equal((await get(`/_/hb/${b}`, 'GET', '198.51.100.9')).statusCode, 200);
  }
  const limited = await get(`/_/hb/${a}`, 'GET', '198.51.100.9');
  assert.deepEqual([limited.statusCode, limited.body], [429, 'Too many requests']);

  // Unbekannte Tokens: höchstens 600 je Minute und Absender (ein Token, das der Prozess schon als echt kennt, nie)
  resetHeartbeatMemoryForTests();
  await q('UPDATE status_monitors SET hb_last_ping_at = NULL WHERE hb_token_hash = ?', [sha(b)]);
  assert.equal((await get(`/_/hb/${b}`, 'GET', '198.51.100.10')).statusCode, 200);
  let last = 0;
  for (let i = 0; i < 601; i++) last = (await get(`/_/hb/${token()}`, 'GET', '192.0.2.44')).statusCode;
  assert.equal(last, 429);
  assert.equal((await get(`/_/hb/${token()}`, 'GET', '192.0.2.45')).statusCode, 404, 'another client is not affected');
  assert.equal((await get(`/_/hb/${b}`, 'GET', '192.0.2.44')).statusCode, 200, 'known tokens are never limited per client');
});

test('commands: ping for backup and weekly, planned windows, the web start', async () => {
  const io = { out: '', err: '' };
  const capture = { out: (s: string) => void (io.out += s), err: (s: string) => void (io.err += s) };
  assert.equal(await statusCommand(['ping', 'backup'], capture), 0);
  assert.match(io.out, /ping for backup saved/);
  const ping = Number((await q("SELECT hb_last_ping_at FROM status_monitors WHERE type = 'system' AND target = 'job:backup'"))[0].hb_last_ping_at);
  assert.ok(Math.abs(ping - Date.now() / 1000) < 5);
  assert.equal(await statusPing('weekly', 1_800_000_000), true);
  assert.equal(Number((await q("SELECT hb_last_ping_at FROM status_monitors WHERE target = 'job:weekly'"))[0].hb_last_ping_at), 1_800_000_000);
  assert.equal(await statusCommand(['ping', 'nightly'], capture), 1);
  assert.match(io.err, /Unknown job "nightly"/);
  assert.equal(await statusCommand(['planned', '600'], capture), 0);
  const planned = Number((await q("SELECT meta_value FROM oys_meta WHERE meta_key = 'status_planned'"))[0].meta_value);
  assert.ok(Math.abs(planned - (Date.now() / 1000 + 600)) < 5);
  assert.equal(await statusPlanned(0, 1_800_000_000), 1_800_000_000);
  assert.equal(await statusPlanned(999_999, 0), 6 * 3600, 'at most six hours');
  for (const bad of [['planned', '-5'], ['planned'], ['planned', 'x'], ['nope'], []]) assert.equal(await statusCommand(bad, capture), 1, bad.join(' '));
  await recordWebStart(1_800_000_123);
  assert.equal((await q("SELECT meta_value FROM oys_meta WHERE meta_key = 'status_web_start'"))[0].meta_value, '1800000123');
});

// Prüfbericht: die Grenze „600 unbekannte Tokens je Minute und Absender“ wurde erst NACH der Suche in der Datenbank
// gezählt – wer ständig neue Tokens schickt, kostete trotzdem eine Abfrage je Anfrage (die Grenze änderte nur die
// Antwort). Jetzt wird ein Absender über der Grenze vor der Datenbank abgewiesen; Tokens, die der Prozess schon als
// echt kennt, bleiben davon unberührt.
test('heartbeats: a client over its limit for unknown tokens costs no database reads', async () => {
  resetHeartbeatMemoryForTests();
  const known = token();
  await heartbeat(known);
  assert.equal((await get(`/_/hb/${known}`, 'GET', '192.0.2.77')).statusCode, 200);
  let last = 0;
  for (let i = 0; i < 601; i++) last = (await get(`/_/hb/${token()}`, 'GET', '192.0.2.77')).statusCode;
  assert.equal(last, 429);
  // Ohne Tabelle schlüge jede Suche fehl: ein weiteres neues Token wird abgewiesen, ohne zu suchen
  await q('RENAME TABLE status_monitors TO status_monitors_off');
  let res;
  try {
    res = await get(`/_/hb/${token()}`, 'GET', '192.0.2.77');
  } finally {
    await q('RENAME TABLE status_monitors_off TO status_monitors');
  }
  assert.deepEqual([res.statusCode, res.body], [429, 'Too many requests']);
  // Das bekannte Token desselben Absenders kommt weiter durch
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal((await get(`/_/hb/${known}`, 'GET', '192.0.2.77')).statusCode, 200);
});
