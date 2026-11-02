// Die Begrüßungs-Mail einer Registrierung von Anfang bis Ende: register() mit dem echten mail.ts (kein Ersatz) schickt
// an einen SMTP-Server dieses Tests inhaltlich dieselbe Nachricht wie PHP. PHP rechnet die Werte mit den Zeilen aus
// routes_app.php (103-106, 139) und schickt mit einer unveränderten Kopie von mail.php und dem echten PHPMailer (aus
// der PHP-Version, siehe support/phpRef.ts – ohne OYS_PHP_REF wird hier nichts aufgebaut).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { ROOT_DIR, configString, loadConfig, setConfigForTests } from '../src/config.js';
import { closePool } from '../src/db.js';
import { makeTestCtx, isHalt, type Ctx } from '../src/web/ctx.js';
import { register, setAuthMailerForTests } from '../src/app/auth.js';
import { setMailDirForTests } from '../src/mail.js';
import { SmtpSink, type SinkSession } from './support/smtpSink.js';
import { decodeWords, header, leaves, parseAddress, parseMessage } from './support/mime.js';
import type { PhpArray } from '../src/php.js';
import { PHP_SKIP, phpFile, phpRef } from './support/phpRef.js';

const BASE = loadConfig();
const SOURCE = configString('db.name');
const DB = SOURCE + '_authwelcome';
const USER = 'noreply@on-your.site';
const PASS = 'p@ss wörd';
let admin: Connection;
let dir = '';
let phpRoot = '';
let sink: SmtpSink;

before(async () => {
  if (PHP_SKIP) return;
  // Eigene Kopie der Datenbank, ohne Zähler der Begrenzungen (frühere Läufe dürfen nichts sperren)
  admin = await mysql.createConnection({ host: configString('db.host', 'localhost'), user: configString('db.user', ''), password: configString('db.pass', ''), charset: 'utf8mb4_unicode_ci' });
  const [tables] = await admin.query<RowDataPacket[]>(`SHOW TABLES FROM \`${SOURCE}\``);
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  for (const row of tables) {
    const t = String(Object.values(row)[0]);
    await admin.query(`CREATE TABLE \`${DB}\`.\`${t}\` LIKE \`${SOURCE}\`.\`${t}\``);
    await admin.query(`INSERT INTO \`${DB}\`.\`${t}\` SELECT * FROM \`${SOURCE}\`.\`${t}\``);
  }
  await admin.query(`DELETE FROM \`${DB}\`.rate_limits`);
  await closePool();
  setConfigForTests({ ...BASE, db: { ...(BASE.db as Record<string, string>), name: DB } });

  // Test-CA und Zertifikat für den SMTP-Server (STARTTLS wie im Betrieb); Node und PHP vertrauen der CA
  dir = mkdtempSync(join(tmpdir(), 'oys-welcome-'));
  const run = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=OnYourSite Test CA');
  run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'srv.key', '-out', 'srv.csr', '-subj', '/CN=localhost');
  writeFileSync(join(dir, 'ext.cnf'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
  run('x509', '-req', '-in', 'srv.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'srv.pem', '-days', '2', '-extfile', 'ext.cnf');
  const ca = readFileSync(join(dir, 'ca.pem'), 'utf8');
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), ca]);
  sink = new SmtpSink({ user: USER, pass: PASS }, { key: readFileSync(join(dir, 'srv.key')), cert: readFileSync(join(dir, 'srv.pem')) });
  sink.behavior = { startTls: true };
  const port = await sink.listen('127.0.0.1', 0, false);

  // email/-Ordner mit den Vorlagen des Projekts und einer smtp.json für den Test-Server (PHP und Node lesen denselben)
  phpRoot = join(dir, 'php');
  mkdirSync(join(phpRoot, 'email'), { recursive: true });
  for (const f of readdirSync(join(ROOT_DIR, 'email'))) if (f.endsWith('.json') && f !== 'smtp.json') copyFileSync(join(ROOT_DIR, 'email', f), join(phpRoot, 'email', f));
  writeFileSync(join(phpRoot, 'email', 'smtp.json'), JSON.stringify({ host: '127.0.0.1', port: String(port), username: USER, password: PASS, from_email: USER, from_name: 'OnYourSite' }));
  copyFileSync(phpRef('mail.php'), join(phpRoot, 'mail.php'));
  symlinkSync(phpRef('PHPMailer'), join(phpRoot, 'PHPMailer'));
  writeFileSync(join(phpRoot, 'harness.php'), `<?php
    date_default_timezone_set('Europe/Berlin');
    mb_internal_encoding('UTF-8');
    require '${phpFile('lib/helpers.php')}';
    require __DIR__ . '/mail.php';
    $in = json_decode(stream_get_contents(STDIN), true);
    $fullname = oys_clean_text($in['fullname'] ?? '', 120);
    $email = strtolower(trim((string) ($in['email'] ?? '')));
    $slug = oys_normalize_slug($in['subdomain'] ?? '');
    echo json_encode(sendCustomEmail($email, 'register', ['full_name' => e($fullname), 'subdomain' => e($slug)]));
  `);
  setMailDirForTests(join(phpRoot, 'email'));
});

after(async () => {
  if (PHP_SKIP) return;
  setMailDirForTests(null);
  setAuthMailerForTests(undefined);
  await sink?.close();
  await closePool();
  setConfigForTests(BASE);
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.end();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function call(ctx: Ctx): Promise<Ctx> {
  try {
    await register(ctx);
  } catch (err) {
    if (!isHalt(err)) throw err;
  } finally {
    await ctx.session?.close();
  }
  return ctx;
}

// Formular holen (Sitzung mit Token), dann mit diesen Werten absenden
async function signUp(post: PhpArray, ip: string): Promise<Ctx> {
  const page = await call(makeTestCtx({ url: '/register', ip }));
  const token = /name="csrf" value="([0-9a-f]{64})"/.exec(String(page.body))![1];
  return call(makeTestCtx({ method: 'POST', url: '/register', ip, cookies: { PHPSESSID: page.session!.id }, post: { ...post, csrf: token } }));
}

function phpSend(form: Record<string, string>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = execFile('php', ['-d', 'display_errors=0', '-d', `openssl.cafile=${join(dir, 'ca.pem')}`, join(phpRoot, 'harness.php')], (err, stdout) => {
      if (err) return reject(err);
      resolve(JSON.parse(stdout));
    });
    child.stdin!.end(JSON.stringify(form));
  });
}

// Was beim SMTP-Server ankam, ohne die Bytes der Kodierung (PHPMailer und nodemailer kodieren anders, KD-9)
function summary(s: SinkSession) {
  const msg = s.data ? parseMessage(s.data) : null;
  return {
    secure: s.secure,
    auth: s.auth,
    mailFrom: s.mailFrom,
    rcpt: s.rcpt,
    from: msg ? parseAddress(header(msg, 'from')) : null,
    to: msg ? header(msg, 'to') : null,
    subject: msg && header(msg, 'subject') !== undefined ? decodeWords(header(msg, 'subject')!) : null,
    parts: msg ? leaves(msg).map((p) => ({ type: p.type, body: p.body.toString('utf8').replace(/\r\n|\r|\n/g, '\n').replace(/\n+$/, '') })) : null,
  };
}

const RUN = String(Date.now() % 1e8);
const CASES: Array<Record<string, string>> = [
  { fullname: 'Max Muster', email: `max${RUN}@example.com`, subdomain: `max-${RUN}` },
  { fullname: `  <b>Zoë</b> & "Co" 'x' 🐝‮\u0007  `, email: ` Zoe${RUN}@Example.COM\t`, subdomain: ` Zoe_${RUN}.ä ` },
  { fullname: 'a😀'.repeat(70), email: `long${RUN}@sub.example.co.uk`, subdomain: `LONG-${RUN}` },
];

test('a sign-up sends the same welcome mail as PHP through the real mail module', { skip: PHP_SKIP }, async () => {
  setAuthMailerForTests(undefined);
  for (const [i, form] of CASES.entries()) {
    sink.sessions = [];
    sink.side = 'php';
    assert.equal(await phpSend(form), true, `PHP sent case ${i}`);
    sink.side = 'node';
    const ctx = await signUp({ ...form, password: 'secret123' }, `10.9.8.${i + 1}`);
    assert.equal(ctx.header('Location'), '/dashboard', `case ${i}: ${String(ctx.session?.data.error)}`);
    const bySide = (side: string) => sink.sessions.filter((x) => x.side === side).map(summary);
    const php = bySide('php');
    assert.equal(php.length, 1, `case ${i}: one PHP mail`);
    assert.deepEqual(bySide('node'), php, `case ${i}`);
    // Name und Adresse stehen mit e() maskiert in Betreff und Text
    assert.match(php[0].subject!, /^Welcome to OnYourSite, .*! 🚀$/);
  }
});
