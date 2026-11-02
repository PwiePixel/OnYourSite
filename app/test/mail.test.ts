// mail.php (sendCustomEmail mit PHPMailer) gegen src/mail.ts (nodemailer). Beide schicken an einen kleinen SMTP-Server
// dieses Tests (mit eigenem Zertifikat, STARTTLS bzw. TLS auf Port 465). Verglichen werden Rückgabewert, Protokoll,
// Umschlag, Anmeldung, die wichtigen Kopfzeilen und die dekodierten HTML- und Text-Teile – für jede Vorlage in email/
// und die Fehlerfälle. PHP läuft aus einer unveränderten Kopie von mail.php mit dem echten PHPMailer (PHP-Version,
// siehe support/phpRef.ts); ohne sie prüft ein eigener Test, ob Node jede Mail sendet bzw. ablehnt wie erwartet.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { ROOT_DIR } from '../src/config.js';
import { e } from '../src/html.js';
import { sendCustomEmail, setMailDirForTests, stripTags, PhpTypeError } from '../src/mail.js';
import { SmtpSink, type SinkBehavior, type SinkSession } from './support/smtpSink.js';
import { decodeWords, header, leaves, parseAddress, parseMessage } from './support/mime.js';
import { PHP_SKIP, phpRef } from './support/phpRef.js';

const SMTPS_HOST = '127.0.13.107';
let dir = '';
let phpRoot = '';
let sink: SmtpSink;
let badSink: SmtpSink;
let smtpsSink: SmtpSink | null = null;
let port = 0;
let badPort = 0;
let closedPort = 0;
const USER = 'noreply@on-your.site';
const PASS = 'p@ss wörd';

// ---------------------------------------------------------------- Aufbau

function certs(): { ca: string; key: string; cert: string; badKey: string; badCert: string } {
  const run = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=OnYourSite Test CA');
  run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'srv.key', '-out', 'srv.csr', '-subj', '/CN=localhost');
  writeFileSync(join(dir, 'ext.cnf'), `subjectAltName=DNS:localhost,IP:127.0.0.1,IP:${SMTPS_HOST}\n`);
  run('x509', '-req', '-in', 'srv.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'srv.pem', '-days', '2', '-extfile', 'ext.cnf');
  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'bad.key', '-out', 'bad.pem', '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1');
  const r = (f: string) => readFileSync(join(dir, f), 'utf8');
  return { ca: r('ca.pem'), key: r('srv.key'), cert: r('srv.pem'), badKey: r('bad.key'), badCert: r('bad.pem') };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'oys-mail-'));
  const c = certs();
  // Node vertraut der Test-CA wie einer normalen – mail.ts selbst bleibt unverändert
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), c.ca]);
  sink = new SmtpSink({ user: USER, pass: PASS }, { key: c.key, cert: c.cert });
  port = await sink.listen('127.0.0.1', 0, false);
  badSink = new SmtpSink({ user: USER, pass: PASS }, { key: c.badKey, cert: c.badCert });
  badPort = await badSink.listen('127.0.0.1', 0, false);
  try {
    const s = new SmtpSink({ user: USER, pass: PASS }, { key: c.key, cert: c.cert });
    await s.listen(SMTPS_HOST, 465, true);
    smtpsSink = s;
  } catch {
    smtpsSink = null; // Port 465 nicht verfügbar (ohne root): diese Fälle werden übersprungen
  }
  // Ein Port, auf dem niemand lauscht
  const tmp = new SmtpSink({ user: USER, pass: PASS }, { key: c.key, cert: c.cert });
  closedPort = await tmp.listen('127.0.0.1', 0, false);
  await tmp.close();

  // PHP: unveränderte Kopie von mail.php, der echte PHPMailer, ein eigener email/-Ordner (Node liest denselben)
  phpRoot = join(dir, 'php');
  mkdirSync(join(phpRoot, 'email'), { recursive: true });
  setMailDirForTests(join(phpRoot, 'email'));
  if (PHP_SKIP) return;
  copyFileSync(phpRef('mail.php'), join(phpRoot, 'mail.php'));
  assert.equal(readFileSync(join(phpRoot, 'mail.php'), 'utf8'), readFileSync(phpRef('mail.php'), 'utf8'));
  symlinkSync(phpRef('PHPMailer'), join(phpRoot, 'PHPMailer'));
  writeFileSync(join(phpRoot, 'harness.php'), `<?php
    date_default_timezone_set('Europe/Berlin');
    mb_internal_encoding('UTF-8');
    require __DIR__ . '/mail.php';
    $in = json_decode(stream_get_contents(STDIN), true);
    ini_set('error_log', $in['log']);
    try { $r = sendCustomEmail(...$in['args']); } catch (Throwable $e) { $r = 'fatal: ' . get_class($e); }
    echo json_encode($r);
  `);
});

after(async () => {
  setMailDirForTests(null);
  await sink?.close();
  await badSink?.close();
  await smtpsSink?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- Vergleich

function runPhp(args: unknown[]): Promise<{ result: unknown; log: string }> {
  const log = join(dir, 'php-error.log');
  writeFileSync(log, '');
  return new Promise((resolve, reject) => {
    const child = execFile('php', ['-d', 'display_errors=0', '-d', `openssl.cafile=${join(dir, 'ca.pem')}`, join(phpRoot, 'harness.php')], (err, stdout) => {
      if (err) return reject(err);
      resolve({ result: JSON.parse(stdout), log: readFileSync(log, 'utf8') });
    });
    child.stdin!.end(JSON.stringify({ args, log }));
  });
}

async function runNode(args: unknown[]): Promise<{ result: unknown; log: string }> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => lines.push(a.join(' '));
  try {
    const [to, tpl, vars, subject, reply] = args as [unknown, string, Record<string, unknown> | undefined, unknown, unknown];
    const result = await sendCustomEmail(to, tpl, vars ?? {}, subject ?? null, reply ?? null);
    return { result, log: lines.join('\n') };
  } catch (err) {
    if (err instanceof PhpTypeError) return { result: 'fatal: TypeError', log: lines.join('\n') };
    throw err;
  } finally {
    console.error = orig;
  }
}

// Fehlerprotokoll: nur die Art der Meldung (der genaue Text kommt von PHPMailer bzw. nodemailer)
function logKind(log: string): string {
  // (PHP schreibt die Zeile nur bis zu einem Nullbyte)
  if (log.includes("Mail Error: SMTP config or Template '")) return 'missing';
  if (log.includes('Mail Error: JSON format invalid.')) return 'json';
  if (log.includes('Mailer Error:')) return 'mailer';
  return log.trim() === '' ? '' : 'other: ' + log.trim();
}

function asciiCharset(charset: string | undefined, body: string): string {
  const c = (charset ?? '').toLowerCase();
  // PHPMailer schreibt bei reinem ASCII us-ascii, nodemailer utf-8 – für ASCII-Inhalt dasselbe
  return /^[\x00-\x7f]*$/.test(body) && (c === 'us-ascii' || c === 'utf-8') ? 'ascii-compatible' : c;
}

function messageSummary(raw: Buffer) {
  const msg = parseMessage(raw);
  return {
    from: parseAddress(header(msg, 'from')),
    to: header(msg, 'to'),
    replyTo: parseAddress(header(msg, 'reply-to')),
    subject: header(msg, 'subject') === undefined ? null : decodeWords(header(msg, 'subject')!),
    mimeVersion: header(msg, 'mime-version'),
    type: msg.type,
    // Zeilenenden vereinheitlicht: PHPMailer lässt in quoted-printable einzelne LF stehen und hängt an den letzten
    // Teil ein CRLF an – für den Inhalt ohne Bedeutung
    parts: leaves(msg).map((p) => {
      const body = p.body.toString('utf8').replace(/\r\n|\r|\n/g, '\n').replace(/\n+$/, '');
      return { type: p.type, charset: asciiCharset(p.params.charset, body), body };
    }),
  };
}

function sessionSummary(s: SinkSession) {
  return {
    secure: s.secure,
    auth: s.auth,
    authTried: s.authAttempts.length > 0,
    mailFrom: s.mailFrom,
    rcpt: s.rcpt,
    delivered: s.data !== null,
    message: s.data ? messageSummary(s.data) : null,
  };
}

interface MailCase {
  name: string;
  smtp?: Record<string, unknown> | string | Buffer | null; // null = keine smtp.json
  templates?: Record<string, string | Buffer>;
  args: unknown[];
  behavior?: SinkBehavior;
  target?: 'main' | 'bad' | 'smtps' | 'closed';
  expectSent?: boolean;
}

const smtpFor = (target: MailCase['target'], extra: Record<string, unknown> = {}) => ({
  host: target === 'smtps' ? SMTPS_HOST : '127.0.0.1',
  port: String(target === 'smtps' ? 465 : target === 'bad' ? badPort : target === 'closed' ? closedPort : port),
  username: USER,
  password: PASS,
  from_email: 'noreply@on-your.site',
  from_name: 'OnYourSite',
  ...extra,
});

// Vorlagen, smtp.json und Verhalten des SMTP-Servers für einen Fall; gibt den Server zurück
function prepare(c: MailCase): SmtpSink {
  const emailDir = join(phpRoot, 'email');
  // Vorlagen wie im Projekt, dazu die des Falls
  for (const f of readdirSync(emailDir)) rmSync(join(emailDir, f));
  for (const f of readdirSync(join(ROOT_DIR, 'email'))) if (f.endsWith('.json') && f !== 'smtp.json') copyFileSync(join(ROOT_DIR, 'email', f), join(emailDir, f));
  for (const [name, content] of Object.entries(c.templates ?? {})) writeFileSync(join(emailDir, name), content);
  const target = c.target ?? 'main';
  const smtp = c.smtp === undefined ? smtpFor(target) : c.smtp;
  if (smtp !== null) writeFileSync(join(emailDir, 'smtp.json'), typeof smtp === 'string' || Buffer.isBuffer(smtp) ? smtp : JSON.stringify(smtp, null, 4));
  const s = target === 'bad' ? badSink : target === 'smtps' ? smtpsSink! : sink;
  s.behavior = c.behavior ?? { startTls: target !== 'smtps' };
  s.sessions = [];
  return s;
}

// Nur Node: senden bzw. ablehnen wie erwartet; was gesendet wurde, kam beim SMTP-Server an
async function nodeSends(c: MailCase): Promise<unknown> {
  const s = prepare(c);
  s.side = 'node';
  const node = await runNode(c.args);
  if (c.expectSent !== undefined) assert.equal(node.result, c.expectSent, `${c.name}: sent`);
  if (node.result === true) assert.ok(s.sessions.some((x) => x.data !== null), `${c.name}: delivered`);
  return node.result;
}

async function compare(c: MailCase): Promise<{ php: unknown; node: unknown; sessions: number }> {
  const s = prepare(c);
  s.side = 'php';
  const php = await runPhp(c.args);
  s.side = 'node';
  const node = await runNode(c.args);
  // TLS-Verbindungen (Port 465) ohne einen einzigen SMTP-Befehl zählen nicht: scheitert TLS an der Prüfung des Namens,
  // sieht der Server von PHP einen fertigen Handschlag (PHP prüft danach), von Node einen abgebrochenen (Node prüft währenddessen)
  const bySide = (side: string) => s.sessions.filter((x) => x.side === side && !(x.secure && x.commands.length === 0 && x.hello.length === 0)).map(sessionSummary);
  assert.deepEqual(node.result, php.result, `${c.name}: return value`);
  assert.equal(logKind(node.log), logKind(php.log), `${c.name}: error log`);
  assert.deepEqual(bySide('node'), bySide('php'), `${c.name}: what the SMTP server saw`);
  if (c.expectSent !== undefined) assert.equal(php.result, c.expectSent, `${c.name}: PHP result as expected`);
  return { php: php.result, node: node.result, sessions: s.sessions.length };
}

// ---------------------------------------------------------------- Fälle

const LONG_MESSAGE = 'Hi!\nI would like to book you.\r\n\r\nBest, <Guest> & co.\rLine';
// Erst nach before() aufbauen (Ports stehen dann fest)
const CASES = (): MailCase[] => [
  // Jede Vorlage aus email/ mit den Variablen, die die Aufrufer übergeben
  { name: 'register', args: ['mia@test.de', 'register', { full_name: e('Mia <Müller> & “Co”'), subdomain: e('mia') }], expectSent: true },
  {
    name: 'new_message (contact form)',
    args: ['owner@test.de', 'new_message', {
      full_name: e('Pixel'), guest_name: e('Gäst <x>'), guest_email: e('guest@example.com'), message: e(LONG_MESSAGE),
      page_url: e('pixel.oys.test:8080'), dashboard_url: e('http://oys.test:8080/dashboard'),
    }, 'New message from Gäst <x>', 'guest@example.com'],
    expectSent: true,
  },
  {
    name: 'new_booking',
    args: ['owner@test.de', 'new_booking', {
      full_name: e('Pixel'), guest_name: e('Tom'), guest_email: e('tom@example.com'), booking_date: e('Nov 3, 2026'), booking_time: e('14:30'),
      dashboard_url: e('http://oys.test:8080/dashboard'),
    }, 'New booking: Tom on Nov 3, 2026', 'tom@example.com'],
    expectSent: true,
  },
  {
    name: 'weekly_report',
    args: ['mia@test.de', 'weekly_report', {
      full_name: e('Mia'), period: e('Oct 26 – Nov 1, 2026'), views: '1,234', clicks: '1',
      report_html: '<div style="x">🏆 Best link: <strong>{dashboard_url}</strong> (3 clicks)</div>\n<p>second</p>', dashboard_url: e('http://oys.test:8080/dashboard'),
    }, 'Your weekly report: 1,234 views, 1 click'],
    expectSent: true,
  },
  { name: 'newsletter update0.1 (raw name)', args: ['tom@test.de', 'update0.1', { full_name: 'Tom "<b>bold</b>" & Ö', subdomain: 'tom' }], expectSent: true },
  { name: 'newsletter welcome with subject', args: ['lea@test.de', 'welcome', { full_name: null, subdomain: 'yourname' }, 'Hello {full_name} at {subdomain}!'], expectSent: true },
  { name: 'newsletter smtp.example (empty body)', args: ['lea@test.de', 'smtp.example', { full_name: 'Lea', subdomain: 'lea' }], expectSent: false },
  // Betreff, Variablen, Antwortadresse
  { name: 'subject override "0"', args: ['mia@test.de', 'register', { full_name: 'Mia', subdomain: 'mia' }, '0'], expectSent: true },
  { name: 'subject override empty', args: ['mia@test.de', 'register', { full_name: 'Mia', subdomain: 'mia' }, ''], expectSent: true },
  { name: 'subject with line breaks', args: ['mia@test.de', 'register', {}, '  Line\r\none\ttwo  '], expectSent: true },
  { name: 'variables replaced in order', args: ['mia@test.de', 'register', { full_name: '{subdomain}', subdomain: 'x{full_name}' }], expectSent: true },
  { name: 'reply-to invalid', args: ['mia@test.de', 'register', {}, null, 'not an address'], expectSent: true },
  { name: 'reply-to with spaces', args: ['mia@test.de', 'register', {}, null, ' guest@example.com'], expectSent: true },
  { name: 'reply-to "0"', args: ['mia@test.de', 'register', {}, null, '0'], expectSent: true },
  { name: 'recipient with spaces', args: [' mia@test.de ', 'register', {}], expectSent: true },
  { name: 'recipient invalid', args: ['mia@', 'register', {}], expectSent: false },
  { name: 'recipient without @', args: ['nobody', 'register', {}], expectSent: false },
  { name: 'recipient empty', args: ['', 'register', {}], expectSent: false },
  { name: 'recipient with IDN domain', args: ['user@bücher.de', 'register', {}], expectSent: true },
  { name: 'reply-to with IDN domain', args: ['mia@test.de', 'register', {}, null, 'guest@bücher.de'], expectSent: true },
  // Vorlagen
  { name: 'template missing', args: ['mia@test.de', 'nope', {}], expectSent: false },
  { name: 'template path outside', args: ['mia@test.de', '../email/register', {}], expectSent: true },
  { name: 'template with null byte', args: ['mia@test.de', 'register\0x', {}], expectSent: false },
  { name: 'template invalid JSON', templates: { 'bad.json': '{"subject":' }, args: ['mia@test.de', 'bad', {}], expectSent: false },
  { name: 'template empty object', templates: { 'empty.json': '{}' }, args: ['mia@test.de', 'empty', {}], expectSent: false },
  { name: 'template JSON text', templates: { 'text.json': '"just text"' }, args: ['mia@test.de', 'text', {}], expectSent: false },
  { name: 'template without subject', templates: { 'nosub.json': '{"body":"Hi {name}"}' }, args: ['mia@test.de', 'nosub', { name: 'Mia' }], expectSent: true },
  { name: 'template empty subject', templates: { 'emptysub.json': '{"subject":"","body":"Hi"}' }, args: ['mia@test.de', 'emptysub', {}], expectSent: true },
  { name: 'template numbers', templates: { 'num.json': '{"subject":123,"body":1.5e-5}' }, args: ['mia@test.de', 'num', {}], expectSent: true },
  { name: 'template body "0"', templates: { 'zero.json': '{"subject":"Zero","body":"0"}' }, args: ['mia@test.de', 'zero', {}], expectSent: false },
  { name: 'template body only tags', templates: { 'tags.json': '{"subject":"Tags","body":"<p></p><br>"}' }, args: ['mia@test.de', 'tags', {}], expectSent: true },
  {
    name: 'template short lines (8bit)', templates: { 'short.json': JSON.stringify({ subject: 'Kurz äöü', body: 'Hallo {n},\nzweite Zeile\r\ndritte <a href="x">Link</a> < 5 & mehr\rEnde' }) },
    args: ['mia@test.de', 'short', { n: 'Ä' }], expectSent: true,
  },
  { name: 'template body array', templates: { 'arr.json': '{"subject":"A","body":["x"]}' }, args: ['mia@test.de', 'arr', {}] },
  { name: 'template subject array', templates: { 'arrsub.json': '{"subject":["x"],"body":"Hi"}' }, args: ['mia@test.de', 'arrsub', {}] },
  // Vorlagen, die nicht als UTF-8 gespeichert sind (z. B. Windows-1252): json_decode() lehnt sie ab
  { name: 'template in Latin-1', templates: { 'latin1.json': Buffer.from('{"subject":"Gr\xfc\xdfe","body":"Hallo"}', 'latin1') }, args: ['mia@test.de', 'latin1', {}], expectSent: false },
  { name: 'template with a byte order mark', templates: { 'bom.json': Buffer.from('\ufeff{"subject":"BOM","body":"Hallo"}', 'utf8') }, args: ['mia@test.de', 'bom', {}], expectSent: false },
  // SMTP-Einstellungen
  { name: 'smtp.json missing', smtp: null, args: ['mia@test.de', 'register', {}], expectSent: false },
  { name: 'smtp.json invalid', smtp: '{"host":', args: ['mia@test.de', 'register', {}], expectSent: false },
  { name: 'smtp.json empty', smtp: '{}', args: ['mia@test.de', 'register', {}], expectSent: false },
  { name: 'smtp.json is a string', smtp: '"text"', args: ['mia@test.de', 'register', {}] },
  { name: 'smtp.json is a number', smtp: '5', args: ['mia@test.de', 'register', {}], expectSent: false },
  { name: 'smtp.json in Latin-1', smtp: Buffer.from(JSON.stringify(smtpFor('main', { from_name: '\xd6-Team' })), 'latin1'), args: ['mia@test.de', 'register', {}], expectSent: false },
  { name: 'from address invalid', smtp: smtpFor('main', { from_email: 'nope' }), args: ['mia@test.de', 'register', {}], expectSent: false },
  { name: 'from name empty', smtp: smtpFor('main', { from_name: '' }), args: ['mia@test.de', 'register', {}], expectSent: true },
  { name: 'from with IDN domain', smtp: smtpFor('main', { from_email: 'noreply@bücher.de' }), args: ['mia@test.de', 'register', {}], expectSent: true },
  { name: 'from name special', smtp: smtpFor('main', { from_name: ' Ö-Team, "Inc."\r\n ' }), args: ['mia@test.de', 'register', {}], expectSent: true },
  { name: 'port as number', smtp: smtpFor('main', { port: port }), args: ['mia@test.de', 'register', {}], expectSent: true },
  { name: 'port not a number', smtp: smtpFor('main', { port: 'abc' }), args: ['mia@test.de', 'register', {}], expectSent: false },
  // Port-Text: PHP verbindet mit atoi(), findet den Servernamen für TLS aber nur bei 1–5 Ziffern (parse_url("host:port"))
  { name: 'port with a leading space', smtp: smtpFor('main', { port: ' ' + port }), args: ['mia@test.de', 'register', {}], expectSent: false },
  { name: 'port with a trailing space', smtp: smtpFor('main', { port: port + ' ' }), args: ['mia@test.de', 'register', {}], expectSent: false },
  { name: 'port with a plus sign', smtp: smtpFor('main', { port: '+' + port }), args: ['mia@test.de', 'register', {}], expectSent: false },
  { name: 'port with trailing text', smtp: smtpFor('main', { port: port + 'x' }), args: ['mia@test.de', 'register', {}], expectSent: false },
  { name: 'port with six digits', smtp: smtpFor('main', { port: String(port).padStart(6, '0') }), args: ['mia@test.de', 'register', {}], expectSent: false },
  { name: 'port with a leading zero', smtp: smtpFor('main', { port: '0' + port }), args: ['mia@test.de', 'register', {}] },
  { name: 'port as a JSON float', smtp: JSON.stringify(smtpFor('main', { port: 'PORT' })).replace('"PORT"', port + '.0'), args: ['mia@test.de', 'register', {}], expectSent: true },
  { name: 'port "0" with the port at the host', smtp: smtpFor('main', { port: '0', host: '127.0.0.1:' + port }), args: ['mia@test.de', 'register', {}], expectSent: true },
  { name: 'port "00" (no connection)', smtp: smtpFor('main', { port: '00' }), args: ['mia@test.de', 'register', {}], expectSent: false },
  { name: 'host in capitals', smtp: smtpFor('main', { host: 'LOCALHOST' }), args: ['mia@test.de', 'register', {}], expectSent: true },
  { name: 'host with a trailing dot', smtp: smtpFor('main', { host: 'localhost.' }), args: ['mia@test.de', 'register', {}], expectSent: false },
  { name: 'host list with a bad first host', smtp: smtpFor('main', { host: 'bad_host!;127.0.0.1' }), args: ['mia@test.de', 'register', {}], expectSent: true },
  { name: 'host with port', smtp: smtpFor('main', { host: `127.0.0.1:${port}`, port: '25' }), args: ['mia@test.de', 'register', {}], expectSent: true },
  { name: 'host refused, then good', smtp: smtpFor('main', { host: `127.0.0.1:${closedPort};127.0.0.1` }), args: ['mia@test.de', 'register', {}], expectSent: true },
  { name: 'connection refused', target: 'closed', args: ['mia@test.de', 'register', {}], expectSent: false },
  { name: 'untrusted certificate', target: 'bad', args: ['mia@test.de', 'register', {}], expectSent: false },
  { name: 'no STARTTLS offered', behavior: { startTls: false }, args: ['mia@test.de', 'register', {}], expectSent: false },
  { name: 'wrong password', smtp: smtpFor('main', { password: 'wrong' }), args: ['mia@test.de', 'register', {}], expectSent: false },
  { name: 'auth rejected', behavior: { startTls: true, rejectAuth: true }, args: ['mia@test.de', 'register', {}], expectSent: false },
  { name: 'no AUTH offered', behavior: { startTls: true, authMethods: [] }, args: ['mia@test.de', 'register', {}], expectSent: false },
  { name: 'CRAM-MD5 preferred', behavior: { startTls: true, authMethods: ['PLAIN', 'LOGIN', 'CRAM-MD5'] }, args: ['mia@test.de', 'register', {}], expectSent: true },
  { name: 'only PLAIN', behavior: { startTls: true, authMethods: ['PLAIN'] }, args: ['mia@test.de', 'register', {}], expectSent: true },
  { name: 'recipient rejected', behavior: { startTls: true, rejectRcpt: true }, args: ['mia@test.de', 'register', {}], expectSent: false },
  { name: 'message rejected', behavior: { startTls: true, rejectData: true }, args: ['mia@test.de', 'register', {}], expectSent: false },
  { name: 'greeting refused', behavior: { greeting: '554 5.3.2 Not now' }, args: ['mia@test.de', 'register', {}], expectSent: false },
];
const SMTPS_CASES = (): MailCase[] => [
  // Port-Text auf Port 465: TLS ab der ersten Zeile, der Servername wird genauso gesucht
  { name: 'port 465 with a leading space', target: 'smtps', smtp: smtpFor('smtps', { port: ' 465' }), args: ['mia@test.de', 'register', {}], expectSent: false },
  { name: 'port 465 with trailing text', target: 'smtps', smtp: smtpFor('smtps', { port: '465x' }), args: ['mia@test.de', 'register', {}], expectSent: false },
  { name: 'port 465 as decimal text', target: 'smtps', smtp: smtpFor('smtps', { port: '465.0' }), args: ['mia@test.de', 'register', {}], expectSent: false },
  { name: 'port 465 with zeros in front', target: 'smtps', smtp: smtpFor('smtps', { port: '00465' }), args: ['mia@test.de', 'register', {}], expectSent: true },
  { name: 'port 465 (TLS from the start)', target: 'smtps', args: ['mia@test.de', 'register', { full_name: 'Mia', subdomain: 'mia' }], expectSent: true },
  { name: 'ssl:// host prefix', target: 'smtps', smtp: smtpFor('smtps', { host: `ssl://${SMTPS_HOST}:465`, port: '587' }), args: ['mia@test.de', 'welcome', { full_name: 'Mia' }], expectSent: true },
];

test('every template and setting sends or refuses the mail as expected', async () => {
  let sent = 0;
  for (const c of CASES()) if ((await nodeSends(c)) === true) sent++;
  assert.ok(sent >= 25, 'most cases deliver a message');
});

test('SMTPS on port 465 sends or refuses the mail as expected', async (t) => {
  if (!smtpsSink) {
    t.skip('port 465 is not available');
    return;
  }
  for (const c of SMTPS_CASES()) await nodeSends(c);
});

test('every template and setting sends the same mail as PHPMailer', { skip: PHP_SKIP }, async () => {
  let sent = 0;
  for (const c of CASES()) {
    const r = await compare(c);
    if (r.php === true) sent++;
  }
  assert.ok(sent >= 25, 'most cases deliver a message');
});

test('SMTPS on port 465 behaves like PHPMailer', { skip: PHP_SKIP }, async (t) => {
  if (!smtpsSink) {
    t.skip('port 465 is not available');
    return;
  }
  for (const c of SMTPS_CASES()) await compare(c);
});

test('strip_tags matches PHP', { skip: PHP_SKIP }, () => {
  let seed = 99;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const parts = ['<', '>', '!', '?', '-', '--', '"', "'", '\\', '(', ')', 'x', 'm', 'l', 'xml', 'E', 'e', 'doctyp', 'DOCTYP', ' ', '\t', '\n', '\0', 'a', 'b',
    '<!--', '-->', '<?', '?>', '<br />', '<p class="a>b">', 'é', '😀', '<!DOCTYPE html>', '<?xml ', "<a href='x'>"];
  const inputs: string[] = [];
  for (let i = 0; i < 3000; i++) {
    let s = '';
    for (let j = 0, len = 1 + rnd(14); j < len; j++) s += parts[rnd(parts.length)];
    inputs.push(s);
  }
  for (const f of readdirSync(join(ROOT_DIR, 'email'))) if (f.endsWith('.json')) inputs.push(String(JSON.parse(readFileSync(join(ROOT_DIR, 'email', f), 'utf8')).body ?? ''));
  const php = JSON.parse(execFileSync('php', ['-r', 'echo json_encode(array_map("strip_tags", json_decode(stream_get_contents(STDIN), true)));'], { input: JSON.stringify(inputs), maxBuffer: 1e8 }).toString());
  assert.deepEqual(inputs.map(stripTags), php);
});
