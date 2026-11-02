// Bot-Schnittstelle /_/bot/… über HTTP: PHP (index.php im eingebauten Server, aus einer unveränderten Kopie der
// PHP-Version mit eigener Test-Datenbank, siehe support/phpRef.ts) gegen den ganzen Node-Server (Fastify, ohne Netz).
// Verglichen werden Status, die wichtigen Kopfzeilen, der Inhalt und die Community-Tabellen. Dazu: viele gleichzeitige
// Anfragen (Sperre und Datenbank-Verbindungen) und Feldnamen wie __proto__ in Adresse und Formular.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import net from 'node:net';
import http from 'node:http';
import mysql from 'mysql2/promise';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import type { FastifyInstance } from 'fastify';
import { loadConfig, setConfigForTests, configString, type ConfigData } from '../src/config.js';
import { closePool } from '../src/db.js';
import { decrypt } from '../src/crypto.js';
import { parseStr, strtotime, time } from '../src/php.js';
import { ensureSchema } from '../src/schema.js';
import { buildServer } from '../src/server.js';
import { Ctx } from '../src/web/ctx.js';
import type { Session } from '../src/web/session.js';
import { communitySeal } from '../src/community/community.js';
import { adminCommunityHandle } from '../src/community/admin.js';
import { adminCommunityView } from '../src/community/adminView.js';
import { PHP_SKIP, phpRef, phpTree as phpCodeTree, removePhpTree } from './support/phpRef.js';

const BASE = loadConfig();
// Eigene Datenbank je Arbeitsordner (der Name der Test-Datenbank aus den Einstellungen plus Endung)
const DB = String((BASE.db as ConfigData).name ?? 'oys_test').replace(/[^a-z0-9_]/gi, '') + '_capi';
const HOST = 'oys.test:8080';
const SECRET = configString('bot_secret');
// Einstellungen der Node-Seite für diese Tests (Test-Datenbank)
const TEST_CONFIG: ConfigData = { ...BASE, db: { ...(BASE.db as ConfigData), name: DB } };
let admin: Connection;
let phpRoot = '';
let phpPort = 0;
let php: PhpServer | null = null;
let app: FastifyInstance;
let started = 0;

// ---------------------------------------------------------------- PHP

// Unveränderte Kopie der PHP-Version mit den Einstellungen der Tests (Test-Datenbank, ohne Fehleranzeige); config:
// andere Einstellungen, z. B. ohne bot_secret
const PHP_CONFIG: ConfigData = { ...TEST_CONFIG, debug: false };
function phpTree(config = PHP_CONFIG): string {
  const root = phpCodeTree(config);
  for (const file of ['index.php', 'lib/community.php', 'lib/routes_public.php', 'lib/helpers.php']) {
    assert.equal(readFileSync(join(root, file), 'utf8'), readFileSync(phpRef(file), 'utf8'));
  }
  // Wie der Router der Entwicklung: alles geht an index.php
  writeFileSync(join(root, 'router.php'), `<?php chdir(__DIR__); $_SERVER['SCRIPT_NAME'] = '/index.php'; require __DIR__ . '/index.php';\n`);
  // Einzelne Funktionen mit der Datenbank der Seite (lib/bootstrap.php) aufrufen
  writeFileSync(join(root, 'harness.php'), `<?php require __DIR__ . '/lib/bootstrap.php';
    $in = json_decode(stream_get_contents(STDIN), true);
    $out = (function ($in, $pdo, $root) { return eval($in['code']); })($in, $pdo, __DIR__);
    echo json_encode($out);\n`);
  return root;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForPort(port: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port }, () => {
        s.destroy();
        resolve(true);
      });
      s.on('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the PHP server did not start');
}

interface PhpServer {
  root: string;
  port: number;
  proc: ChildProcess;
}

// PHP-Server auf einer freien Adresse; mehrere Arbeitsprozesse, damit auch PHP gleichzeitige Anfragen gleichzeitig bearbeitet
async function startPhp(config = PHP_CONFIG): Promise<PhpServer> {
  const root = phpTree(config);
  const port = await freePort();
  const proc = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', root, join(root, 'router.php')], {
    cwd: root, env: { ...process.env, PHP_CLI_SERVER_WORKERS: '4' }, stdio: 'ignore', detached: true,
  });
  await waitForPort(port);
  return { root, port, proc };
}

function stopPhp(server: PhpServer | null): void {
  if (!server) return;
  try {
    process.kill(-(server.proc.pid ?? 0), 'SIGTERM');
  } catch {
    server.proc.kill('SIGTERM');
  }
  removePhpTree(server.root);
}

function runPhp(code: string, input: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn('php', ['-d', 'display_errors=0', '-d', 'log_errors=0', join(phpRoot, 'harness.php')], { cwd: phpRoot });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('error', reject);
    child.on('close', () => {
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error('PHP: ' + out.slice(0, 500)));
      }
    });
    child.stdin.end(JSON.stringify({ ...input, code }));
  });
}

// ---------------------------------------------------------------- Anfragen

interface Req {
  method: string;
  path: string;
  body?: string;
  type?: string | null;
  // ok: richtig signiert, bad: falsche Signatur, old: Zeitstempel zu alt, none: ohne Signatur
  sign?: 'ok' | 'bad' | 'old' | 'none';
  // Worüber signiert wird (sonst der echte Inhalt bei POST)
  signedBody?: string;
}
interface Res {
  status: number;
  headers: Record<string, string>;
  body: string;
}
const HEADERS = ['content-type', 'cache-control', 'x-robots-tag'];

function signedHeaders(r: Req, secret = SECRET): Record<string, string> {
  const h: Record<string, string> = { host: HOST, 'user-agent': 'OnYourSite-Bot/0.1' };
  if (r.body !== undefined && r.type !== null) h['content-type'] = r.type ?? 'application/json';
  if (r.sign === 'none') return h;
  const ts = String(time() + (r.sign === 'old' ? -400 : 0));
  const body = r.signedBody ?? (r.method === 'POST' ? r.body ?? '' : '');
  const sig = createHmac('sha256', secret).update(Buffer.concat([Buffer.from(`${ts}\n${r.method}\n${r.path}\n`, 'latin1'), Buffer.from(body, 'utf8')])).digest('hex');
  h['x-oys-timestamp'] = ts;
  h['x-oys-signature'] = r.sign === 'bad' ? 'f'.repeat(64) : sig;
  return h;
}

function pick(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of HEADERS) if (headers[k] !== undefined) out[k] = String(headers[k]);
  return out;
}

function sendPhp(r: Req, port = phpPort, secret = SECRET): Promise<Res> {
  return new Promise((resolve, reject) => {
    const body = r.body === undefined ? undefined : Buffer.from(r.body, 'utf8');
    const headers = signedHeaders(r, secret);
    if (body) headers['content-length'] = String(body.length);
    const req = http.request({ host: '127.0.0.1', port, method: r.method, path: r.path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: pick(res.headers), body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function sendNode(r: Req, secret = SECRET): Promise<Res> {
  // Ein Fehler 500 (z. B. doppelter Kanal) steht sonst im Protokoll des Servers – hier gewollt
  const log = console.error;
  console.error = () => undefined;
  try {
    const res = await app.inject({ method: r.method as 'GET', url: r.path, headers: signedHeaders(r, secret), payload: r.body });
    return { status: res.statusCode, headers: pick(res.headers), body: res.body };
  } finally {
    console.error = log;
  }
}

// Zeitpunkte dieser Anfrage („jetzt“) und /ping-Uhrzeit vereinheitlichen
function normalizeBody(text: string): string {
  return text
    .replace(/"(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)"/g, (m, v: string) => {
      const at = strtotime(v);
      return at !== false && at >= started - 5 && at <= time() + 5 ? '"NOW"' : m;
    })
    .replace(/"time":(\d+)/, (m, v: string) => (Math.abs(Number(v) - time()) <= 5 ? '"time":TIME' : m));
}

// ---------------------------------------------------------------- Testdaten

let SEALED: string[] = [];
async function fixtures(): Promise<void> {
  for (const t of ['community_suggestions', 'community_tickets', 'community_ticket_messages', 'community_outbox']) await admin.query(`TRUNCATE TABLE \`${DB}\`.\`${t}\``);
  await admin.query(`DELETE FROM \`${DB}\`.oys_meta WHERE meta_key = 'bot_last_seen'`);
  // Fester Wert je Lauf: vor einer Stunde zuletzt gesehen (jede gültige Anfrage schreibt dann „jetzt“)
  await admin.query(`INSERT INTO \`${DB}\`.oys_meta (meta_key, meta_value) VALUES ('bot_last_seen', ?)`, [String(started - 3600)]);
  if (!SEALED.length) SEALED = [communitySeal('The upload fails.'), communitySeal('Looking into it – “quotes” & <b>tags</b>'), communitySeal('ENC:looks encrypted')];
  const s = `INSERT INTO \`${DB}\`.community_suggestions (id, thread_id, author_id, author_name, title, body, status, reason, decided_by, decided_via, decided_at, status_message_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
  for (const r of [
    [1, '100000000000000001', '200000000000000001', 'Mia', 'Dark mode', 'Please add dark mode', 'open', '', '', '', null, null, '2026-10-30 10:00:00', '2026-10-30 10:00:00'],
    [2, '100000000000000002', '200000000000000002', '', 'Ümlauts & “quotes”', '', 'open', '', '', '', null, '300000000000000002', '2026-10-30 11:00:00', '2026-10-30 11:00:00'],
    [3, '100000000000000003', '200000000000000003', 'Tom', 'Accepted idea', 'Body', 'accepted', 'Coming soon.', 'Boss', 'discord', '2026-10-31 09:15:00', '300000000000000003', '2026-10-29 08:00:00', '2026-10-31 09:15:00'],
  ]) await admin.query(s, r);
  const t = `INSERT INTO \`${DB}\`.community_tickets (id, user_id, user_name, subject, channel_id, status, closed_by, closed_via, closed_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`;
  for (const r of [
    [1, '400000000000000001', 'Mia', 'Upload fails', '500000000000000001', 'open', '', '', null, '2026-10-31 10:00:00', '2026-10-31 12:00:00'],
    [2, '400000000000000002', '', 'Closed one', '500000000000000002', 'closed', 'Team', 'discord', '2026-10-31 13:00:00', '2026-10-31 09:00:00', '2026-10-31 13:00:00'],
    [3, '400000000000000003', 'Tom', 'No channel yet', null, 'open', '', '', null, '2026-10-31 11:00:00', '2026-10-31 11:00:00'],
  ]) await admin.query(t, r);
  const m = `INSERT INTO \`${DB}\`.community_ticket_messages (id, ticket_id, discord_message_id, author_id, author_name, is_team, source, body, created_at) VALUES (?,?,?,?,?,?,?,?,?)`;
  for (const r of [
    [1, 1, '600000000000000001', '400000000000000001', 'Mia', 0, 'discord', SEALED[0], '2026-10-31 10:00:00'],
    [2, 1, null, null, 'Pixel Admin', 1, 'web', SEALED[1], '2026-10-31 12:00:00'],
    [3, 2, '600000000000000003', '400000000000000002', '', 0, 'discord', SEALED[2], '2026-10-31 09:00:00'],
  ]) await admin.query(m, r);
  const o = `INSERT INTO \`${DB}\`.community_outbox (id, action, payload, attempts, last_error, created_at, done_at) VALUES (?,?,?,?,?,?,?)`;
  for (const r of [
    [1, 'suggestion.decided', '{"id":3,"status":"accepted"}', 0, null, '2026-10-31 12:00:00', '2026-10-31 12:00:05'],
    [2, 'ticket.reply', '{"id":1,"body":"Looking into it. \\/ ü","big":123456789012345678,"f":1.0,"e":1e25,"list":{"0":"a","1":"b"}}', 2, 'The ticket channel no longer exists.', '2026-10-31 12:01:00', null],
    [3, 'odd.invalid', 'not json', 1, null, '2026-10-31 12:02:00', null],
  ]) await admin.query(o, r);
}

// Inhalt der Community-Tabellen: verschlüsselte Texte entschlüsselt, Zeitpunkte von „jetzt“ vereinheitlicht
async function snapshot(): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const t of ['community_suggestions', 'community_tickets', 'community_ticket_messages', 'community_outbox', 'oys_meta']) {
    const [rows] = await admin.query<RowDataPacket[]>(`SELECT * FROM \`${DB}\`.\`${t}\` ORDER BY 1`);
    out[t] = rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => {
      if (typeof v === 'string' && v.startsWith('ENC:')) return [k, 'DEC(' + JSON.stringify(decrypt(v)) + ')'];
      if (typeof v === 'string') v = v.replace(/\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/g, (m) => {
        const at = strtotime(m);
        return at !== false && at >= started - 5 && at <= time() + 5 ? 'NOW' : m;
      });
      if (t === 'oys_meta' && k === 'meta_value' && row.meta_key === 'bot_last_seen') return [k, Math.abs(Number(v) - time()) <= 5 ? 'NOW' : v];
      return [k, v];
    })));
  }
  return out;
}

before(async () => {
  started = time();
  assert.ok(SECRET.length >= 32, 'the test settings need a bot_secret');
  admin = await mysql.createConnection({
    host: configString('db.host', 'localhost'), user: configString('db.user', ''), password: configString('db.pass', ''),
    charset: 'utf8mb4_unicode_ci', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  setConfigForTests(TEST_CONFIG);
  await closePool();
  await ensureSchema();
  if (!PHP_SKIP) {
    php = await startPhp();
    phpRoot = php.root;
    phpPort = php.port;
  }
  app = await buildServer();
  await app.ready();
});

after(async () => {
  await app?.close();
  stopPhp(php);
  await closePool();
  setConfigForTests(BASE);
  await admin?.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin?.end();
});

// ---------------------------------------------------------------- Fälle

const J = (o: Record<string, unknown>): string => JSON.stringify(o);
const sug = (o: Record<string, unknown> = {}) => J({ thread_id: '100000000000000099', author_id: '200000000000000099', author_name: 'Bee', title: 'New idea', body: 'Text', ...o });
const dec = (o: Record<string, unknown> = {}) => J({ status: 'accepted', reason: 'Good', by_name: 'Boss', thread_id: '100000000000000001', ...o });
const tkt = (o: Record<string, unknown> = {}) => J({ user_id: '400000000000000099', user_name: 'Bee', subject: 'Help', body: 'It broke.', ...o });
const msg = (o: Record<string, unknown> = {}) => J({ message_id: '600000000000000099', author_id: '400000000000000001', author_name: 'Mia', team: false, body: 'More info', ...o });
const post = (path: string, body: string, extra: Partial<Req> = {}): Req => ({ method: 'POST', path, body, ...extra });
const get = (path: string, extra: Partial<Req> = {}): Req => ({ method: 'GET', path, ...extra });

const CASES: Array<[string, Req]> = [
  ['ping with query', get('/_/bot/ping?x=1&y=%C3%A4')],
  ['unsigned', get('/_/bot/ping', { sign: 'none' })],
  ['bad signature', get('/_/bot/outbox', { sign: 'bad' })],
  ['old timestamp', get('/_/bot/outbox', { sign: 'old' })],
  ['body too big', post('/_/bot/outbox/2/done', J({ error: 'x'.repeat(65537) }))],
  ['invalid JSON', post('/_/bot/suggestions', '{"thread_id":')],
  ['JSON scalar', post('/_/bot/suggestions', '"text"')],
  ['JSON list', post('/_/bot/suggestions', '[1,2]')],
  ['empty body', post('/_/bot/suggestions', '')],
  ['unknown route', get('/_/bot/nothing')],
  ['POST to ping', post('/_/bot/ping', '{}')],
  ['HEAD ping', { method: 'HEAD', path: '/_/bot/ping' }],
  ['suggestion', post('/_/bot/suggestions', sug())],
  ['suggestion for a known thread', post('/_/bot/suggestions', sug({ thread_id: '100000000000000001', title: 'Changed' }))],
  ['suggestion without author', post('/_/bot/suggestions', sug({ author_id: 'abc' }))],
  ['suggestion with long texts', post('/_/bot/suggestions', sug({ title: 'T'.repeat(250), body: 'ü'.repeat(4100), author_name: 'N'.repeat(120) }))],
  ['suggestion IDs as numbers', post('/_/bot/suggestions', '{"thread_id":123456789012345678,"author_id":2000000000000099,"title":"Numbers"}')],
  ['status message', post('/_/bot/suggestions/1', J({ status_message_id: '300000000000000001' }))],
  ['status message, unknown suggestion', post('/_/bot/suggestions/99', J({ status_message_id: '300000000000000001' }))],
  ['decision', post('/_/bot/suggestions/1/decision', dec())],
  ['decision from an older post', post('/_/bot/suggestions/1/decision', dec({ thread_id: '100000000000000002' }))],
  ['decision with a bad status', post('/_/bot/suggestions/1/decision', dec({ status: 'open' }))],
  ['decision, already decided', post('/_/bot/suggestions/3/decision', dec({ thread_id: '100000000000000003', status: 'declined' }))],
  ['decision without a name', post('/_/bot/suggestions/2/decision', J({ status: 'declined' }))],
  ['ticket', post('/_/bot/tickets', tkt())],
  ['ticket while one is open', post('/_/bot/tickets', tkt({ user_id: '400000000000000001' }))],
  ['ticket without text', post('/_/bot/tickets', tkt({ body: ' ' }))],
  ['ticket user as number', post('/_/bot/tickets', '{"user_id":400000000000000098,"subject":"Num","body":"x"}')],
  ['ticket by channel', get('/_/bot/tickets/by-channel/500000000000000001')],
  ['ticket by unknown channel', get('/_/bot/tickets/by-channel/500000000000000099')],
  ['channel', post('/_/bot/tickets/3/channel', J({ channel_id: '500000000000000003' }))],
  ['channel already set', post('/_/bot/tickets/1/channel', J({ channel_id: '500000000000000009' }))],
  ['channel taken by another ticket', post('/_/bot/tickets/3/channel', J({ channel_id: '500000000000000001' }))],
  ['message', post('/_/bot/tickets/1/messages', msg())],
  ['message from the team', post('/_/bot/tickets/1/messages', msg({ team: '0.0', author_name: 'Boss' }))],
  ['message twice', post('/_/bot/tickets/1/messages', msg({ message_id: '600000000000000001' }))],
  ['message to a closed ticket', post('/_/bot/tickets/2/messages', msg())],
  ['close', post('/_/bot/tickets/1/close', J({ by_name: 'Mia' }))],
  ['close a closed ticket', post('/_/bot/tickets/2/close', J({ by_name: 'Mia' }))],
  ['outbox', get('/_/bot/outbox')],
  ['outbox done', post('/_/bot/outbox/2/done', '{}')],
  ['outbox error', post('/_/bot/outbox/2/done', J({ error: 'Unknown action “x”.' }))],
  ['multipart body is not read', post('/_/bot/outbox/2/done', '--b\r\nContent-Disposition: form-data; name="error"\r\n\r\nx\r\n--b--\r\n', { type: 'multipart/form-data; boundary=b', signedBody: '' })],
  // Ob php://input leer ist, entscheidet der Kern wie PHP (server.ts, web/multipart.ts): nur wenn PHP den Inhalt selbst liest
  ['multipart without boundary is read', post('/_/bot/outbox/2/done', J({ error: 'no boundary' }), { type: 'multipart/form-data' })],
  ['multipart with an unclosed quoted boundary is read', post('/_/bot/outbox/2/done', J({ error: 'unclosed' }), { type: 'multipart/form-data; boundary="b' })],
  ['multipart boundary without = is read', post('/_/bot/outbox/2/done', J({ error: 'no equals' }), { type: 'multipart/form-data; boundary' })],
  ['multipart with an empty boundary is not read', post('/_/bot/outbox/2/done', J({ error: 'empty' }), { type: 'multipart/form-data; boundary=', signedBody: '' })],
  ['multipart type with a tab is no multipart', post('/_/bot/outbox/2/done', J({ error: 'tab' }), { type: 'multipart/form-data\t; boundary=b' })],
  ['multipart in capitals is not read', post('/_/bot/outbox/2/done', J({ error: 'caps' }), { type: 'MULTIPART/FORM-DATA; BOUNDARY=b', signedBody: '' })],
  ['multipart behind a comma is not read', post('/_/bot/outbox/2/done', J({ error: 'comma' }), { type: 'multipart/form-data, boundary=b', signedBody: '' })],
  ['multipart signed over the body is refused', post('/_/bot/outbox/2/done', J({ error: 'signed' }), { type: 'multipart/form-data; boundary=b' })],
  ['hostile multipart body is not read', post('/_/bot/outbox/2/done', ('--' + 'b'.repeat(300) + '\r\nContent-Disposition: form-data; name="a[]"\r\n\r\n' + '\n--'.repeat(50) + '\r\n').repeat(40),
    { type: 'multipart/form-data; boundary=' + 'b'.repeat(300), signedBody: '' })],
  ['plain text body is read', post('/_/bot/outbox/2/done', J({ error: 'plain' }), { type: 'text/plain' })],
];

test('every bot API route answers and writes like PHP', { skip: PHP_SKIP }, async () => {
  for (const [name, req] of CASES) {
    await fixtures();
    const p = await sendPhp(req);
    const phpDb = await snapshot();
    await fixtures();
    const n = await sendNode(req);
    const nodeDb = await snapshot();
    assert.equal(n.status, p.status, `${name}: status`);
    assert.deepEqual(n.headers, p.headers, `${name}: headers`);
    assert.equal(normalizeBody(n.body), normalizeBody(p.body), `${name}: body`);
    assert.deepEqual(nodeDb, phpDb, `${name}: database`);
  }
});

// Kein Geheimnis und eines mit nur 31 Bytes (signiert wird trotzdem damit)
const NO_SECRET: Array<[string, string | null]> = [['no secret', null], ['secret too short', 's'.repeat(31)]];
const NO_SECRET_REQUESTS = (): Array<[string, Req]> => [['signed ping', get('/_/bot/ping')], ['unsigned suggestion', post('/_/bot/suggestions', sug(), { sign: 'none' })]];

test('without a usable bot secret the API does not exist', async () => {
  for (const [variant, secret] of NO_SECRET) {
    setConfigForTests({ ...TEST_CONFIG, bot_secret: secret });
    try {
      for (const [name, req] of NO_SECRET_REQUESTS()) {
        await fixtures();
        const before = await snapshot();
        assert.equal((await sendNode(req, secret ?? 'x'.repeat(32))).status, 404, `${variant}, ${name}`);
        assert.deepEqual(await snapshot(), before, `${variant}, ${name}: database`);
      }
    } finally {
      setConfigForTests(TEST_CONFIG);
    }
  }
});

test('without a usable bot secret the API does not exist, like in PHP', { skip: PHP_SKIP }, async () => {
  for (const [variant, secret] of NO_SECRET) {
    // Ohne Geheimnis fehlt bot_secret in config.php ganz
    const config: ConfigData = { ...PHP_CONFIG, bot_secret: secret ?? '' };
    if (secret === null) delete config.bot_secret;
    const other = await startPhp(config);
    setConfigForTests({ ...TEST_CONFIG, bot_secret: secret });
    try {
      for (const [name, req] of NO_SECRET_REQUESTS()) {
        await fixtures();
        const p = await sendPhp(req, other.port, secret ?? 'x'.repeat(32));
        const phpDb = await snapshot();
        await fixtures();
        const n = await sendNode(req, secret ?? 'x'.repeat(32));
        assert.equal(p.status, 404, `${variant}, ${name}: PHP status`);
        assert.equal(n.status, p.status, `${variant}, ${name}: status`);
        assert.deepEqual(n.headers, p.headers, `${variant}, ${name}: headers`);
        assert.equal(n.body, p.body, `${variant}, ${name}: body`);
        assert.deepEqual(await snapshot(), phpDb, `${variant}, ${name}: database`);
      }
    } finally {
      setConfigForTests(TEST_CONFIG);
      stopPhp(other);
    }
  }
});

// ---------------------------------------------------------------- Gleichzeitige Anfragen

// Antworten ohne die laufenden Nummern (welche Anfrage zuerst drankommt, ist bei Gleichzeitigkeit offen)
const unnumbered = (r: Res): string => r.status + ' ' + normalizeBody(r.body).replace(/"id":\d+/g, '"id":N');
async function ticketRows(): Promise<string[]> {
  const [rows] = await admin.query<RowDataPacket[]>(`SELECT t.user_id, t.user_name, t.subject, t.status, m.author_id, m.author_name, m.is_team, m.source, m.body
    FROM \`${DB}\`.community_tickets t LEFT JOIN \`${DB}\`.community_ticket_messages m ON m.ticket_id = t.id ORDER BY t.user_id, m.id`);
  return rows.map((r) => JSON.stringify({ ...r, body: decrypt(r.body) }));
}
async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what}: no answer within ${ms} ms`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

// 14 Personen gleichzeitig (mehr als Verbindungen im Pool) und dieselbe Person sechsmal (Sperre gegen Doppelklicks)
function manyTickets(): Req[] {
  const reqs: Req[] = [];
  for (let i = 0; i < 14; i++) reqs.push(post('/_/bot/tickets', tkt({ user_id: '41000000000000' + String(1000 + i), user_name: 'U' + i, subject: 'S' + i, body: 'B' + i })));
  for (let i = 0; i < 6; i++) reqs.push(post('/_/bot/tickets', tkt({ user_id: '420000000000000001', subject: 'Twice', body: 'Again' })));
  return reqs;
}

test('many tickets at once all get an answer and one person gets one ticket', async () => {
  await fixtures();
  const n = await withTimeout(Promise.all(manyTickets().map((r) => sendNode(r))), 30000, 'Node');
  assert.deepEqual(n.slice(0, 14).map((r) => r.status), Array(14).fill(200));
  assert.deepEqual(n.slice(14).map((r) => r.status).sort(), [200, 409, 409, 409, 409, 409]);
  const [dups] = await admin.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${DB}\`.community_tickets WHERE user_id = '420000000000000001'`);
  assert.equal(Number(dups[0].n), 1);
  // Danach antwortet der Server weiter
  assert.equal((await sendNode(get('/_/bot/ping'))).status, 200);
});

test('many tickets at once all get an answer, like in PHP', { skip: PHP_SKIP }, async () => {
  const reqs = manyTickets();
  await fixtures();
  const p = await withTimeout(Promise.all(reqs.map((r) => sendPhp(r))), 30000, 'PHP');
  const phpRows = await ticketRows();
  await fixtures();
  const n = await withTimeout(Promise.all(reqs.map((r) => sendNode(r))), 30000, 'Node');
  const nodeRows = await ticketRows();
  assert.deepEqual(n.slice(0, 14).map(unnumbered), p.slice(0, 14).map(unnumbered));
  assert.deepEqual(n.slice(14).map((r) => r.status).sort(), p.slice(14).map((r) => r.status).sort());
  assert.deepEqual(p.slice(14).map((r) => r.status).sort(), [200, 409, 409, 409, 409, 409]);
  assert.deepEqual(nodeRows, phpRows);
  // Danach antwortet der Server weiter
  assert.equal((await sendNode(get('/_/bot/ping'))).status, 200);
});

// ---------------------------------------------------------------- Feldnamen wie __proto__

const CSRF = 'c'.repeat(64);
function adminCtx(query: string): Ctx {
  const ctx = new Ctx({ method: 'GET', url: '/admin' + query, headers: { host: HOST }, peer: '127.0.0.1' });
  ctx.session = { get: (k: string) => (k === 'csrf' ? CSRF : undefined), set: () => undefined } as unknown as Session;
  return ctx;
}

test('names like __proto__ in the address or a form stay ordinary keys', async () => {
  const polluted = (): string[] => ['polluted', 'deep', 'community_action', 'ticket', 'suggestions'].filter((k) => k in ({} as object));
  try {
    await app.inject({ method: 'GET', url: '/_/bot/ping?__proto__[polluted]=1&a[__proto__][deep]=1', headers: { host: HOST } });
    await app.inject({ method: 'POST', url: '/_/bot/ping', headers: { host: HOST, 'content-type': 'application/x-www-form-urlencoded' }, payload: '__proto__[community_action]=ticket_close&__proto__[id]=1' });
    assert.equal(JSON.stringify(parseStr('__proto__[community_action]=ticket_close&id=1')), '{"__proto__":{"community_action":"ticket_close"},"id":"1"}');
    await fixtures();
    await adminCommunityHandle(parseStr('__proto__[community_action]=ticket_close&__proto__[id]=1&id=3'), 'Pixel Admin');
    assert.doesNotMatch(await adminCommunityView(adminCtx('?__proto__[ticket]=1&__proto__[suggestions]=all')), /Close view/);
    assert.deepEqual(polluted(), []);
    // Das Ticket 3 ist noch offen: die Aktion stand nur unter __proto__
    const [rows] = await admin.query<RowDataPacket[]>(`SELECT status FROM \`${DB}\`.community_tickets WHERE id = 3`);
    assert.equal(rows[0].status, 'open');
  } finally {
    for (const k of polluted()) delete (Object.prototype as Record<string, unknown>)[k];
  }
});

test('names like __proto__ in the address or a form stay ordinary keys, as in PHP', { skip: PHP_SKIP }, async () => {
  const polluted = (): string[] => ['polluted', 'deep', 'community_action', 'ticket', 'suggestions'].filter((k) => k in ({} as object));
  try {
    // Durch den ganzen Server: Adresse und Formular
    await app.inject({ method: 'GET', url: '/_/bot/ping?__proto__[polluted]=1&a[__proto__][deep]=1', headers: { host: HOST } });
    await app.inject({ method: 'POST', url: '/_/bot/ping', headers: { host: HOST, 'content-type': 'application/x-www-form-urlencoded' }, payload: '__proto__[community_action]=ticket_close&__proto__[ticket]=1' });
    assert.deepEqual(polluted(), []);
    // parse_str() liefert dieselben Schlüssel
    const inputs = ['__proto__[community_action]=ticket_close&id=1', '__proto__=x&a[__proto__][q]=1', 'constructor[prototype][x]=1&toString=2'];
    const php = await runPhp('return array_map(function ($s) { parse_str($s, $o); return $o; }, $in["s"]);', { s: inputs });
    assert.deepEqual(inputs.map((s) => JSON.parse(JSON.stringify(parseStr(s)))), php);
    assert.deepEqual(polluted(), []);

    // Admin: Aktion und Ansicht mit solchen Namen wie in PHP (keine Aktion, kein geöffnetes Ticket, Filter „open“)
    await fixtures();
    const body = '__proto__[community_action]=ticket_close&__proto__[id]=1&id=3';
    const phpResult = await runPhp('parse_str($in["body"], $post); return oys_admin_community_handle($pdo, $post, "Pixel Admin");', { body });
    assert.equal(await adminCommunityHandle(parseStr(body), 'Pixel Admin'), phpResult);
    const query = '?__proto__[ticket]=1&__proto__[suggestions]=all';
    const phpView = await runPhp(`$_SESSION = ['csrf' => $in['csrf']]; parse_str($in['q'], $_GET); ob_start(); include $root . '/views/admin_community.php'; return ob_get_clean();`, { q: query.slice(1), csrf: CSRF });
    assert.equal(await adminCommunityView(adminCtx(query)), phpView);
    assert.doesNotMatch(phpView, /Close view/);
  } finally {
    for (const k of polluted()) delete (Object.prototype as Record<string, unknown>)[k];
  }
});
