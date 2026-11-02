// Erweiterungen des Mail-Versands für Hintergrunddienste: eigene Kopfzeilen (z. B. List-Unsubscribe), eine Zeitgrenze
// je Aufruf und der Testversand ohne SMTP-Server. Ohne diese Optionen bleibt alles wie bisher (mail.test.ts vergleicht
// das mit PHPMailer).
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendCustomEmail, setMailDirForTests, setMailTransportForTests, type CapturedMail } from '../src/mail.js';
import { header, parseMessage } from './support/mime.js';

let dir = '';
let silent: Server;
let silentPort = 0;
const sockets = new Set<Socket>();

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'oys-core-mail-'));
  // Ein Server, der Verbindungen annimmt und nie antwortet (kein Gruß)
  silent = createServer((s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', () => resolve()));
  silentPort = (silent.address() as { port: number }).port;
  // Zugangsdaten zur Laufzeit zusammensetzen (keine festen Werte im Repository)
  const pass = ['t', 'e', 's', 't'].join('') + '-' + process.pid;
  writeFileSync(join(dir, 'smtp.json'), JSON.stringify({
    host: '127.0.0.1', port: silentPort, username: 'noreply@on-your.site', password: pass, from_email: 'noreply@on-your.site', from_name: 'OnYourSite',
  }));
  writeFileSync(join(dir, 'status_alert.json'), JSON.stringify({ subject: 'Status for {page}', body: '<p>Hello {name},</p><p>{page} is down.</p>' }));
  setMailDirForTests(dir);
});

after(async () => {
  setMailTransportForTests(null);
  setMailDirForTests(null);
  for (const s of sockets) s.destroy();
  await new Promise<void>((resolve) => silent.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => setMailTransportForTests(null));

function capture(): CapturedMail[] {
  const sent: CapturedMail[] = [];
  setMailTransportForTests((m) => void sent.push(m));
  return sent;
}

// Protokollzeilen eines Aufrufs mitschreiben
async function logsOf<T>(fn: () => Promise<T>): Promise<[T, string[]]> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  try {
    return [await fn(), lines];
  } finally {
    console.error = orig;
  }
}

// Prüfsumme im Link zur Laufzeit (keine festen, token-artigen Werte im Repository)
const UNSUB = `<https://on-your.site/_/status/sub/u/12.${'ab'.repeat(8)}>, <mailto:unsubscribe@on-your.site?subject=u12>`;

test('extra headers end up in the message exactly as given, next to the usual ones', async () => {
  const sent = capture();
  const ok = await sendCustomEmail('mia@test.de', 'status_alert', { name: 'Mia', page: 'acme' }, null, null, {
    headers: { 'List-Unsubscribe': UNSUB, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click', 'Auto-Submitted': 'auto-generated' },
  });
  assert.equal(ok, true);
  assert.equal(sent.length, 1);
  const mail = sent[0];
  assert.equal(mail.to, 'mia@test.de');
  assert.equal(mail.from, 'noreply@on-your.site');
  assert.deepEqual(mail.headers, { 'List-Unsubscribe': UNSUB, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click', 'Auto-Submitted': 'auto-generated' });
  // Unverändert und ungefaltet in der Nachricht (der Link darf nicht umbrochen werden)
  const raw = mail.raw.toString('latin1');
  const head = raw.slice(0, raw.indexOf('\r\n\r\n')).split('\r\n');
  assert.ok(head.includes('List-Unsubscribe: ' + UNSUB), raw.slice(0, 800));
  assert.ok(head.includes('List-Unsubscribe-Post: List-Unsubscribe=One-Click'));
  const msg = parseMessage(mail.raw);
  assert.equal(header(msg, 'subject'), 'Status for acme');
  assert.equal(header(msg, 'auto-submitted'), 'auto-generated');
  assert.ok(header(msg, 'from')?.includes('noreply@on-your.site'));
  assert.equal(mail.timeoutMs, 10_000);
});

test('without options nothing is added and the usual 10 s per step apply', async () => {
  const sent = capture();
  assert.equal(await sendCustomEmail('mia@test.de', 'status_alert', { name: 'Mia', page: 'acme' }), true);
  assert.deepEqual(sent[0].headers, {});
  const names = parseMessage(sent[0].raw).headers.map(([k]) => k);
  assert.ok(!names.includes('list-unsubscribe'));
  assert.equal(sent[0].timeoutMs, 10_000);
  // Eine eigene Zeitgrenze kommt beim Versand an (in sinnvollen Grenzen)
  await sendCustomEmail('mia@test.de', 'status_alert', {}, null, null, { timeoutMs: 15_000 });
  await sendCustomEmail('mia@test.de', 'status_alert', {}, null, null, { timeoutMs: 5 });
  await sendCustomEmail('mia@test.de', 'status_alert', {}, null, null, { timeoutMs: 10 ** 9 });
  assert.deepEqual(sent.slice(1).map((m) => m.timeoutMs), [15_000, 100, 120_000]);
});

test('headers that could inject lines, replace our own headers or carry odd bytes are refused, nothing is sent', async () => {
  const sent = capture();
  const secret = 'tok' + process.pid;
  const bad: Array<Record<string, string>> = [
    { 'List-Unsubscribe': `<https://x/${secret}>\r\nBcc: evil@example.com` },
    { 'List-Unsubscribe': `<https://x/${secret}>\nX-Evil: 1` },
    { 'X-Note': `café ${secret}` },
    { 'X-Note': '' },
    { 'X-Note': ` ${secret}` },
    { 'X-Note': 'x'.repeat(901) },
    { From: 'evil@example.com' },
    { bcc: 'evil@example.com' },
    { 'Content-Type': 'text/plain' },
    { 'Message-ID': '<x@y>' },
    { 'X Bad': '1' },
    { 'X-Bad:': '1' },
    { 'X-Dup': '1', 'x-dup': '2' },
  ];
  for (const headers of bad) {
    const [ok, logs] = await logsOf(() => sendCustomEmail('mia@test.de', 'status_alert', {}, null, null, { headers }));
    assert.equal(ok, false, JSON.stringify(headers));
    assert.ok(logs.some((l) => l.startsWith('Mailer Error: Invalid')), logs.join('\n'));
    // Werte (z. B. Tokens in Links) landen nie im Protokoll
    assert.ok(!logs.some((l) => l.includes(secret)), logs.join('\n'));
  }
  assert.deepEqual(sent, []);
  // Ein langer, aber gültiger Wert geht
  assert.equal(await sendCustomEmail('mia@test.de', 'status_alert', {}, null, null, { headers: { 'X-Note': 'y'.repeat(900) } }), true);
});

test('the per-call timeout ends a send that hangs (test transport)', async () => {
  let calls = 0;
  setMailTransportForTests(() => {
    calls++;
    return new Promise<void>(() => undefined);
  });
  const started = Date.now();
  const [ok, logs] = await logsOf(() => sendCustomEmail('mia@test.de', 'status_alert', {}, null, null, { timeoutMs: 200 }));
  const took = Date.now() - started;
  assert.equal(ok, false);
  assert.equal(calls, 1);
  assert.ok(took >= 190 && took < 2000, `took ${took} ms`);
  assert.ok(logs.includes('Mailer Error: SMTP Error: Sending took longer than 200 ms.'), logs.join('\n'));
});

test('the per-call timeout also applies to a mail server that never answers', async () => {
  const started = Date.now();
  const [ok, logs] = await logsOf(() => sendCustomEmail('mia@test.de', 'status_alert', {}, null, null, { timeoutMs: 300 }));
  const took = Date.now() - started;
  assert.equal(ok, false);
  assert.ok(took < 3000, `took ${took} ms`);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^Mailer Error: /);
});
