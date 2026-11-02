// src/cli.ts – die Befehle für den Server. create-admin und cert-alert laufen gegen die PHP-Originale
// (server/create-admin.php, server/cert-alert.php) in einer eigenen Kopie der PHP-Version mit eigener Datenbank:
// gleiche Ausgabe, gleiche Rückgabe, gleiche Zeilen in der Datenbank bzw. gleiche Mails an den Test-SMTP-Server.
// Dazu migrate (Rückgaben, Ausgabe), check --native, check --crypto (Werte von PHP verschlüsselt, wenn es da ist) und
// weekly-report. Die PHP-Vergleiche brauchen die PHP-Version unter OYS_PHP_REF (support/phpRef.ts) – sonst werden sie
// übersprungen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import mysql from 'mysql2/promise';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { ROOT_DIR, loadConfig, setConfigForTests, type ConfigData } from '../src/config.js';
import { closePool } from '../src/db.js';
import { encryptData, passwordVerify } from '../src/crypto.js';
import { ensureSchema } from '../src/schema.js';
import { setMailDirForTests } from '../src/mail.js';
import { runCli, weeklyReport, type CliIo } from '../src/cli.js';
import { SmtpSink } from './support/smtpSink.js';
import { parseMessage, leaves, header, decodeWords } from './support/mime.js';
import { PHP_SKIP, phpRef, phpTree, writePhpConfig } from './support/phpRef.js';

const BASE = loadConfig();
const PREFIX = String((BASE.db as ConfigData).name ?? 'oys_test').replace(/[^a-z0-9_]/gi, '');
const DB = { php: PREFIX + '_cli_php', node: PREFIX + '_cli_node', crypt: PREFIX + '_cli_crypt', fresh: PREFIX + '_cli_fresh' };
let admin: Connection;
let dir = '';
let phpRoot = '';

function config(dbName: string, extra: ConfigData = {}): ConfigData {
  return { ...BASE, db: { ...(BASE.db as ConfigData), name: dbName }, base_domain: 'oys.test:8080', scheme: 'https', ...extra };
}

async function recreate(name: string): Promise<void> {
  await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
}

// Neue Datenbank mit dem Schema dieser Version (die Befehle prüfen das Schema nur einmal je Prozess)
async function recreateWithSchema(name: string): Promise<void> {
  await recreate(name);
  setConfigForTests(config(name));
  await closePool();
  await ensureSchema();
  await closePool();
  setConfigForTests(BASE);
}

// Node-Seite: Befehl mit eigener Ausgabe, eigener Umgebung und eigener Datenbank
async function node(argv: string[], dbName: string, env: Record<string, string> = {}, extra: ConfigData = {}): Promise<{ code: number; out: string; err: string }> {
  setConfigForTests(config(dbName, extra));
  await closePool();
  let out = '';
  let err = '';
  const io: CliIo = { out: (t) => void (out += t), err: (t) => void (err += t), env };
  try {
    const code = await runCli(argv, io);
    return { code, out, err };
  } finally {
    setConfigForTests(BASE);
  }
}

// PHP-Seite: Skript aus der Kopie der PHP-Version mit config.php für die Test-Datenbank
function php(script: string, args: string[], dbName: string, env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  writePhpConfig(phpRoot, config(dbName));
  return new Promise((resolve) => {
    execFile('php', ['-d', 'display_errors=0', '-d', `openssl.cafile=${join(dir, 'ca.pem')}`, join(phpRoot, 'server', script), ...args],
      { env: { PATH: process.env.PATH ?? '', ...env } }, (error, stdout, stderr) => {
        resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: stdout, err: stderr });
      });
  });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'oys-cli-'));
  const db = BASE.db as ConfigData;
  admin = await mysql.createConnection({ host: String(db.host), user: String(db.user), password: String(db.pass), charset: 'utf8mb4_unicode_ci' });
  // Kopie der PHP-Version mit eigener config.php (je Aufruf neu geschrieben)
  if (!PHP_SKIP) phpRoot = phpTree(BASE, dir);
});

after(async () => {
  setMailDirForTests(null);
  setConfigForTests(BASE);
  await closePool();
  if (admin) {
    for (const name of Object.values(DB)) await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await admin.end();
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- migrate

test('migrate brings a database to this release, prints the version and reports pending steps', async () => {
  await recreate(DB.fresh);
  let r = await node(['migrate', '--pending'], DB.fresh);
  assert.deepEqual(r, { code: 2, out: 'Database schema: version 0 – this release needs 5\n', err: '' });
  r = await node(['migrate'], DB.fresh);
  assert.deepEqual(r, { code: 0, out: 'Database schema: version 5 (was 0)\n', err: '' });
  r = await node(['migrate'], DB.fresh);
  assert.deepEqual(r, { code: 0, out: 'Database schema: version 5\n', err: '' });
  r = await node(['migrate', '--pending'], DB.fresh);
  assert.deepEqual(r, { code: 0, out: 'Database schema: version 5 – up to date\n', err: '' });
  // Eine neuere Datenbank (z. B. nach dem Zurückspielen einer älteren Version ohne die Datenbank) wird nicht angefasst
  await admin.query(`REPLACE INTO \`${DB.fresh}\`.oys_meta (meta_key, meta_value) VALUES ('schema_version', '7')`);
  r = await node(['migrate', '--pending'], DB.fresh);
  assert.deepEqual(r, { code: 0, out: 'Database schema: version 7 – up to date (newer than this release: 5)\n', err: '' });
  r = await node(['migrate'], DB.fresh);
  assert.equal(r.code, 0);
  assert.equal(r.out, 'Database schema: version 7 – newer than this release (5)\n');
});

test('migrate fails with exit code 1 and a clear message when the database can’t be reached', async () => {
  const db = BASE.db as ConfigData;
  const r = await node(['migrate'], DB.fresh, {}, { db: { ...db, name: DB.fresh, pass: 'wrong-' + 'password' } });
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.match(r.err, /^The database can’t be reached: .*ER_ACCESS_DENIED_ERROR/);
  const p = await node(['migrate', '--pending'], DB.fresh, {}, { db: { ...db, name: DB.fresh, pass: 'wrong-' + 'password' } });
  assert.equal(p.code, 1);
});

test('unknown commands and a missing config.json end with exit code 1', async () => {
  const r = await node(['nope'], DB.fresh);
  assert.equal(r.code, 1);
  assert.match(r.err, /^Usage: node app\/dist\/cli\.js migrate/);
  const missing = spawnSync(process.execPath, ['--import', 'tsx', join(ROOT_DIR, 'app', 'src', 'cli.ts'), 'migrate'], {
    cwd: join(ROOT_DIR, 'app'), env: { ...process.env, OYS_CONFIG: join(dir, 'nothing.json') }, encoding: 'utf8',
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /The settings file .*nothing\.json is missing\./);
});

// ---------------------------------------------------------------- check --native

test('check --native loads sharp and @napi-rs/canvas and draws a picture', async () => {
  const r = await node(['check', '--native'], DB.fresh);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^sharp [\d.]+ with libvips [\d.]+: works\n@napi-rs\/canvas with the Inter font: works\n$/);
  const bad = await node(['check', '--native', '--extra'], DB.fresh);
  assert.equal(bad.code, 1);
  // Ohne config.json (beim Bauen einer neuen Version): geht trotzdem
  const bare = spawnSync(process.execPath, ['--import', 'tsx', join(ROOT_DIR, 'app', 'src', 'cli.ts'), 'check', '--native'], {
    cwd: join(ROOT_DIR, 'app'), env: { ...process.env, OYS_CONFIG: join(dir, 'nothing.json') }, encoding: 'utf8',
  });
  assert.equal(bare.status, 0, bare.stderr);
});

// ---------------------------------------------------------------- check --crypto

const KEY = 'unit-test-key-' + 'k'.repeat(18);

// Werte wie PHP sie verschlüsselt: mit security.php und demselben Schlüssel (mit OYS_PHP_REF), sonst mit Node
function phpEncrypt(values: string[], key: string): string[] {
  if (PHP_SKIP) return values.map(enc);
  const code = `define('AES_256_KEY', $argv[1]); require '${phpRef('security.php')}'; echo json_encode(array_map('encryptData', json_decode(stream_get_contents(STDIN), true)));`;
  return JSON.parse(execFileSync('php', ['-d', 'display_errors=0', '-r', code, key], { input: JSON.stringify(values) }).toString());
}

// Mit Node und dem Test-Schlüssel verschlüsseln
function enc(v: string): string {
  setConfigForTests(config(DB.crypt, { aes_key: KEY }));
  try {
    return String(encryptData(v));
  } finally {
    setConfigForTests(BASE);
  }
}

async function cryptoDb(): Promise<void> {
  await recreate(DB.crypt);
  setConfigForTests(config(DB.crypt, { aes_key: KEY }));
  await closePool();
  await ensureSchema();
  await closePool();
  setConfigForTests(BASE);
  const t = (sql: string, params: unknown[] = []) => admin.query(sql.replace(/`db`/g, `\`${DB.crypt}\``), params);
  const [n1, e1, m1, n2, e2, m2] = phpEncrypt(['Mia', 'mia@example.com', 'Hallo 👋 – wie geht’s?', 'Tom', 'tom@example.com', 'Line\nbreak'], KEY);
  await t("INSERT INTO `db`.users (id, email, password, full_name, username, last_ip, discord_id, booking_url) VALUES (1, 'a@x.de', 'h', 'A', 'a', ?, ?, ?), (2, 'b@x.de', 'h', 'B', 'b', ?, '', 'https://plain.example')",
    [enc('203.0.113.7'), enc('123456789012345678'), enc('https://cal.example/a'), enc('2001:db8::1')]);
  await t('INSERT INTO `db`.messages (page_id, user_id, name, email, message, is_read, created_at) VALUES (1, 1, ?, ?, ?, 0, NOW()), (1, 1, ?, ?, ?, 0, NOW())', [n1, e1, m1, n2, e2, m2]);
  await t("INSERT INTO `db`.user_bookings (user_id, guest_name, guest_email, booking_date, booking_time) VALUES (1, ?, ?, '2026-11-02', '10:00')", [enc('Gast'), enc('gast@example.com')]);
  await t("INSERT INTO `db`.oys_meta (meta_key, meta_value) VALUES ('discord', ?)", [enc('{"mode":"webhook","webhook":"https://discord.example/x"}')]);
  await t("INSERT INTO `db`.community_tickets (id, user_id, user_name, subject, channel_id, status, created_at, updated_at) VALUES (1, '2', 'u', 's', '1', 'open', NOW(), NOW())");
  await t("INSERT INTO `db`.community_ticket_messages (ticket_id, discord_message_id, author_id, author_name, is_team, source, body, created_at) VALUES (1, '9', '2', 'u', 0, 'discord', ?, NOW())", [enc('\x01Ticket text')]);
}

test('check --crypto decrypts every encrypted column with the configured key', async () => {
  await cryptoDb();
  const r = await node(['check', '--crypto'], DB.crypt, {}, { aes_key: KEY });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /messages\.message +2 checked, all readable/);
  assert.match(r.out, /users\.last_ip +2 checked, all readable/);
  assert.match(r.out, /users\.booking_url +1 checked, all readable/);
  assert.match(r.out, /oys_meta\.discord +1 checked, all readable/);
  assert.match(r.out, /community_ticket_messages\.body +1 checked, all readable/);
  assert.match(r.out, /All 14 checked values can be read with this key\.\n$/);
  // Nichts Entschlüsseltes in der Ausgabe
  assert.doesNotMatch(r.out + r.err, /Mia|203\.0\.113|gast@|webhook/);
});

test('check --crypto fails with exit code 1 on a wrong key or broken values and names them', async () => {
  await cryptoDb();
  const wrong = await node(['check', '--crypto'], DB.crypt, {}, { aes_key: 'another-key-' + 'w'.repeat(20) });
  assert.equal(wrong.code, 1);
  assert.match(wrong.err, /^14 encrypted values can’t be read with the aes_key in config\.json \(/);
  // Ein einzelner kaputter Wert und Discord-Einstellungen, die kein JSON sind
  await admin.query(`UPDATE \`${DB.crypt}\`.messages SET email = 'ENC:not-base64!' WHERE id = 2`);
  await admin.query(`UPDATE \`${DB.crypt}\`.oys_meta SET meta_value = ? WHERE meta_key = 'discord'`, [enc('not json')]);
  const r = await node(['check', '--crypto'], DB.crypt, {}, { aes_key: KEY });
  assert.equal(r.code, 1);
  assert.match(r.out, /messages\.email +2 checked, 1 can’t be read/);
  assert.match(r.err, /^2 encrypted values can’t be read .*messages\.email id 2; oys_meta\.discord meta_key discord/);
});

test('check --crypto takes no other options', async () => {
  for (const args of [['check', '--crypto', '--php'], ['check', '--crypto', '--extra'], ['check']]) {
    const r = await node(args, DB.crypt);
    assert.equal(r.code, 1, args.join(' '));
    assert.equal(r.err, 'Usage: node app/dist/cli.js check --native | check --crypto\n');
  }
});

// ---------------------------------------------------------------- create-admin = server/create-admin.php

const ADMIN_CASES: Array<Record<string, string>> = [
  {},
  { OYS_NAME: 'Pixel', OYS_EMAIL: 'pixel@example.com', OYS_SLUG: 'pixel' },
  { OYS_NAME: 'Pixel', OYS_EMAIL: 'not-an-email', OYS_SLUG: 'pixel', OYS_PASSWORD: 'secret123' },
  { OYS_NAME: 'Pixel', OYS_EMAIL: 'pixel@example.com', OYS_SLUG: 'pixel', OYS_PASSWORD: 'short7!' },
  { OYS_NAME: 'Pixel', OYS_EMAIL: 'pixel@example.com', OYS_SLUG: 'pixel', OYS_PASSWORD: 'äää' },
  { OYS_NAME: 'Pixel', OYS_EMAIL: 'pixel@example.com', OYS_SLUG: 'admin', OYS_PASSWORD: 'secret123' },
  { OYS_NAME: 'Pixel', OYS_EMAIL: 'pixel@example.com', OYS_SLUG: 'a', OYS_PASSWORD: 'secret123' },
  { OYS_NAME: 'Pixel', OYS_EMAIL: 'pixel@example.com', OYS_SLUG: 'x'.repeat(31), OYS_PASSWORD: 'secret123' },
  { OYS_NAME: 'Pixel', OYS_EMAIL: 'pixel@example.com', OYS_SLUG: 'xn--abc', OYS_PASSWORD: 'secret123' },
  { OYS_NAME: '   ', OYS_EMAIL: 'pixel@example.com', OYS_SLUG: 'pixel', OYS_PASSWORD: 'secret123' },
  // Erfolg: Name wird gereinigt, Adresse klein und ohne Leerraum, Seite aus dem Namen
  { OYS_NAME: '  Pixel\tAdmin  ' + 'x'.repeat(150), OYS_EMAIL: '  Pixel@Example.COM ', OYS_SLUG: ' My Page ', OYS_PASSWORD: 'pässwörd' },
  // Schon vergeben: E-Mail bzw. Seitenadresse
  { OYS_NAME: 'Other', OYS_EMAIL: 'pixel@example.com', OYS_SLUG: 'other', OYS_PASSWORD: 'secret123' },
  { OYS_NAME: 'Other', OYS_EMAIL: 'other@example.com', OYS_SLUG: 'mypage', OYS_PASSWORD: 'secret123' },
  { OYS_NAME: 'Mia', OYS_EMAIL: 'mia@example.com', OYS_SLUG: 'mia', OYS_PASSWORD: '12345678' },
];

async function adminRows(dbName: string): Promise<unknown> {
  const [users] = await admin.query<RowDataPacket[]>(`SELECT id, email, password, full_name, username, layout_type, last_ip, theme, is_admin FROM \`${dbName}\`.users ORDER BY id`);
  const [pages] = await admin.query<RowDataPacket[]>(`SELECT id, user_id, slug, position, title, subtitle, bio, theme, layout, address_mode, settings FROM \`${dbName}\`.pages ORDER BY id`);
  const [blocks] = await admin.query<RowDataPacket[]>(`SELECT page_id, type, position, is_visible, data FROM \`${dbName}\`.page_blocks ORDER BY id`);
  return {
    users: users.map((u) => ({ ...u, password: String(u.password).slice(0, 7) })),
    passwords: users.map((u) => String(u.password)),
    pages,
    blocks,
  };
}

test('create-admin creates the first admin with a page and refuses taken or invalid values', async () => {
  await recreateWithSchema(DB.node);
  const outs: Array<{ code: number; out: string; err: string }> = [];
  for (const env of ADMIN_CASES) outs.push(await node(['create-admin'], DB.node, env));
  assert.deepEqual(outs.map((o) => o.code), [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0]);
  assert.equal(outs[0].err, 'Please fill in everything.\n');
  assert.equal(outs[2].err, 'Please enter a valid email address.\n');
  assert.equal(outs[3].err, 'The password must be at least 8 characters long.\n');
  assert.equal(outs[11].err, 'This email address or page address is already taken.\n');
  assert.match(outs[10].out, /^Admin account created – log in at https:\/\/oys\.test:8080\/login with pixel@example\.com\. Your page: https:\/\/mypage\.oys\.test:8080\/?\n$/);
  const n = (await adminRows(DB.node)) as { users: Array<Record<string, unknown>>; passwords: string[]; pages: unknown[] };
  assert.deepEqual(n.users.map((u) => [u.email, u.username, u.is_admin]), [['pixel@example.com', 'mypage', 1], ['mia@example.com', 'mia', 1]]);
  assert.equal(n.pages.length, 2);
  assert.equal(await passwordVerify('pässwörd', n.passwords[0]), true);
});

test('create-admin answers like server/create-admin.php and writes the same rows', { skip: PHP_SKIP }, async () => {
  await recreate(DB.php);
  await recreateWithSchema(DB.node);
  for (const env of ADMIN_CASES) {
    const p = await php('create-admin.php', [], DB.php, env);
    const n = await node(['create-admin'], DB.node, env);
    assert.deepEqual(n, p, JSON.stringify(env));
  }
  const p = (await adminRows(DB.php)) as { users: unknown[]; passwords: string[]; pages: unknown[]; blocks: unknown[] };
  const n = (await adminRows(DB.node)) as typeof p;
  assert.equal(p.users.length, 2);
  assert.deepEqual(n.users, p.users);
  assert.deepEqual(n.pages, p.pages);
  assert.deepEqual(n.blocks, p.blocks);
  // Beide Hashes passen zum Passwort (bcrypt $2y$, Kosten 10)
  for (const hashes of [p.passwords, n.passwords]) {
    assert.match(hashes[0], /^\$2y\$10\$/);
    assert.equal(await passwordVerify('pässwörd', hashes[0]), true);
    assert.equal(await passwordVerify('12345678', hashes[1]), true);
  }
});

test('create-admin prints the setup page and ends with 0 when the database is down', async () => {
  const db = BASE.db as ConfigData;
  const n = await node(['create-admin'], DB.node, { OYS_NAME: 'x' }, { db: { ...db, name: DB.node, pass: 'wrong-' + 'password' } });
  assert.equal(n.code, 0);
  assert.match(n.out, /^<!DOCTYPE html>.*Database connection failed\./);
  assert.match(n.err, /^DB connection failed: /);
});

// ---------------------------------------------------------------- cert-alert = server/cert-alert.php

let sink: SmtpSink;
let sinkPort = 0;
const SMTP_USER = 'noreply@oys.test';
const SMTP_PASS = 'smtp-' + 'pass';

function certs(): { ca: string; key: string; cert: string } {
  const run = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=OnYourSite CLI Test CA');
  run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'srv.key', '-out', 'srv.csr', '-subj', '/CN=localhost');
  writeFileSync(join(dir, 'ext.cnf'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
  run('x509', '-req', '-in', 'srv.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'srv.pem', '-days', '2', '-extfile', 'ext.cnf');
  const r = (f: string) => readFileSync(join(dir, f), 'utf8');
  return { ca: r('ca.pem'), key: r('srv.key'), cert: r('srv.pem') };
}

function smtpJson(settings: Record<string, unknown> | null): void {
  for (const d of phpRoot ? [join(phpRoot, 'email'), join(dir, 'node-email')] : [join(dir, 'node-email')]) {
    mkdirSync(d, { recursive: true });
    const f = join(d, 'smtp.json');
    if (settings === null) rmSync(f, { force: true });
    else writeFileSync(f, JSON.stringify(settings));
  }
  setMailDirForTests(join(dir, 'node-email'));
}

// Was beim SMTP-Server ankam: Empfänger, Betreff, Text (Pfad zur PHP-Kopie durch den Code-Ordner ersetzt)
function received(from: number, server = sink): Array<{ rcpt: string[]; from: string | null; subject: string; text: string; type: string }> {
  return server.sessions.slice(from).filter((s) => s.data).map((s) => {
    const msg = parseMessage(s.data!);
    const part = leaves(msg)[0];
    return {
      rcpt: s.rcpt,
      from: s.mailFrom,
      subject: decodeWords(header(msg, 'subject') ?? ''),
      text: part.body.toString('utf8').replace(/\r\n/g, '\n').split(phpRoot || '\0').join(ROOT_DIR).replace(/\n+$/, ''),
      type: part.type,
    };
  });
}

// Zwei Admins und ein normales Konto in einer frischen Datenbank
async function certDb(name: string): Promise<void> {
  await recreateWithSchema(name);
  await admin.query(`INSERT INTO \`${name}\`.users (email, password, full_name, username, is_admin) VALUES ('boss@example.com', 'h', 'Boss', 'boss', 1), ('user@example.com', 'h', 'User', 'user', 0), ('ops@example.com', 'h', 'Ops', 'ops', 1)`);
}

test('cert-alert warns every admin by mail and does nothing without a mail server', async () => {
  const c = certs();
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), c.ca]);
  const server = new SmtpSink({ user: SMTP_USER, pass: SMTP_PASS }, { key: c.key, cert: c.cert });
  server.behavior = { startTls: true };
  const port = await server.listen('127.0.0.1', 0, false);
  try {
    await certDb(DB.node);
    smtpJson(null);
    let n = await node(['cert-alert', '12'], DB.node);
    assert.deepEqual(n, { code: 1, out: '', err: 'No mail server is set up (Admin → Mail Server) – no warning sent.\n' });
    smtpJson({ host: '127.0.0.1', port, username: SMTP_USER, password: SMTP_PASS, from_email: 'noreply@oys.test', from_name: 'OnYourSite' });
    n = await node(['cert-alert', '12'], DB.node);
    assert.deepEqual(n, { code: 0, out: 'Warning sent to 2 of 2 admins.\n', err: '' });
    const mails = received(0, server);
    assert.deepEqual(mails.map((m) => m.rcpt), [['boss@example.com'], ['ops@example.com']]);
    assert.equal(mails[0].subject, 'HTTPS certificate of oys.test expires in 12 days');
    assert.equal(mails[0].type, 'text/plain');
    assert.ok(mails[0].text.includes(`sudo bash ${ROOT_DIR}/server/install.sh --https`), mails[0].text);
  } finally {
    await server.close();
  }
});

test('cert-alert warns every admin like server/cert-alert.php', { skip: PHP_SKIP }, async () => {
  const c = certs();
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), c.ca]);
  sink = new SmtpSink({ user: SMTP_USER, pass: SMTP_PASS }, { key: c.key, cert: c.cert });
  sink.behavior = { startTls: true };
  sinkPort = await sink.listen('127.0.0.1', 0, false);
  try {
    // Gleiche Daten in beiden Datenbanken: zwei Admins, ein normales Konto
    for (const name of [DB.php, DB.node]) await certDb(name);
    const settings = { host: '127.0.0.1', port: sinkPort, username: SMTP_USER, password: SMTP_PASS, from_email: 'noreply@oys.test', from_name: 'OnYourSite' };
    const cases: Array<[string, Record<string, unknown> | null, string[], { startTls?: boolean; rejectRcpt?: boolean }?]> = [
      ['no smtp.json', null, ['12']],
      ['no host', { ...settings, host: '' }, ['12']],
      ['sent to both admins', settings, ['12']],
      ['days as text', settings, ['7 days']],
      ['without days', settings, []],
      ['without from_name', { ...settings, from_name: undefined }, ['3']],
      ['invalid sender', { ...settings, from_email: 'nobody' }, ['3']],
      ['nobody listens', { ...settings, port: 1 }, ['3']],
      ['no STARTTLS offered', settings, ['3'], { startTls: false }],
      ['recipient refused', settings, ['3'], { startTls: true, rejectRcpt: true }],
    ];
    for (const [label, s, args, behavior] of cases) {
      sink.behavior = behavior ?? { startTls: true };
      smtpJson(s === null ? null : JSON.parse(JSON.stringify(s)));
      const before = sink.sessions.length;
      const p = await php('cert-alert.php', args, DB.php);
      const phpMail = received(before);
      const mid = sink.sessions.length;
      const n = await node(['cert-alert', ...args], DB.node);
      const nodeMail = received(mid);
      assert.equal(n.code, p.code, label);
      assert.equal(n.out, p.out, label);
      // Fehlerzeilen: gleiche Empfänger in gleicher Reihenfolge (den Wortlaut des SMTP-Fehlers liefern PHPMailer bzw. nodemailer)
      const shape = (err: string) => err.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/^(Mail to \S+ failed: ).*$/s, '$1…'));
      assert.deepEqual(shape(n.err), shape(p.err), `${label} – Node: ${n.err} – PHP: ${p.err}`);
      assert.deepEqual(nodeMail, phpMail, label);
      if (label === 'sent to both admins') {
        assert.equal(nodeMail.length, 2);
        assert.deepEqual(nodeMail.map((m) => m.rcpt), [['boss@example.com'], ['ops@example.com']]);
        assert.equal(nodeMail[0].subject, 'HTTPS certificate of oys.test expires in 12 days');
        assert.equal(nodeMail[0].type, 'text/plain');
        assert.match(nodeMail[0].text, /sudo bash .*\/server\/install\.sh --https/);
        assert.equal(n.out, 'Warning sent to 2 of 2 admins.\n');
      }
    }
  } finally {
    await sink.close();
  }
});

// ---------------------------------------------------------------- weekly-report

test('weekly-report runs src/cli/weekly-report.ts – and says so clearly while it is missing', async () => {
  let out = '';
  let err = '';
  const io: CliIo = { out: (t) => void (out += t), err: (t) => void (err += t), env: {} };
  if (!existsSync(join(ROOT_DIR, 'app', 'src', 'cli', 'weekly-report.ts'))) {
    assert.equal(await weeklyReport(io), 1);
    assert.equal(err, 'The weekly report isn’t part of this version of OnYourSite yet (app/src/cli/weekly-report.ts is missing) – nothing was sent.\n');
  }
  // Ein Modul mit weeklyReportCli(): dessen Rückgabe gilt
  const stub = join(dir, 'weekly-stub.mjs');
  writeFileSync(stub, 'export async function weeklyReportCli() { process.stdout.write(""); return 7; }\n');
  assert.equal(await weeklyReport(io, new URL('file://' + stub)), 7);
  const empty = join(dir, 'weekly-empty.mjs');
  writeFileSync(empty, 'export const x = 1;\n');
  err = '';
  assert.equal(await weeklyReport(io, new URL('file://' + empty)), 1);
  assert.match(err, /has no weeklyReportCli\(\)/);
  assert.equal(out, '');
});
