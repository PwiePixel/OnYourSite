// Anfragen an Discord auf der Leitung: oys_discord_request() von PHP (curl) und discordRequest() von Node gegen
// denselben TCP-Lauscher. Verglichen werden die rohen Anfragen (Inhalt Byte für Byte, alle Kopfzeilen außer
// „Connection“, die Node wegen agent: false mitschickt) und die Ergebnisse – auch bei kaputten Antworten, abgebrochenen
// Verbindungen und Zeitüberschreitungen (die Millisekunden in den Fehlertexten von curl unterscheiden sich naturgemäß).
// Die Vergleiche brauchen die PHP-Version (support/phpRef.ts); ohne sie prüft ein eigener Test die Node-Seite allein.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import https from 'node:https';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discordRequest } from '../src/updates/discord.js';
import { PHP_SKIP, phpFile, phpRoot } from './support/phpRef.js';

// Antworten des Lauschers je Pfad (/r/<name>); null = nie antworten, 'close' = ohne Antwort schließen,
// { partial } = nur den Anfang schicken und dann warten
const json = (status: string, body: string, extra = ''): Buffer =>
  Buffer.from(`HTTP/1.1 ${status}\r\nContent-Type: application/json\r\n${extra}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
const REPLIES: Record<string, Buffer | 'close' | { partial: Buffer } | null> = {
  ok: json('200 OK', '{"id":"1300000000000000001","channel_id":"1200000000000000001"}'),
  nocontent: Buffer.from('HTTP/1.1 204 No Content\r\n\r\n'),
  redirect: Buffer.from('HTTP/1.1 301 Moved Permanently\r\nLocation: http://127.0.0.1:1/elsewhere\r\nContent-Length: 0\r\n\r\n'),
  chunked: Buffer.from('HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n'
    + 'f\r\n{"message":"Unk\r\n1b\r\nnown Message","code":10008}\r\n0\r\n\r\n'),
  close10: Buffer.from('HTTP/1.0 404 Not Found\r\n\r\n{"message":"Unknown Webhook","code":10015}'),
  bom: Buffer.concat([Buffer.from('HTTP/1.1 404 Not Found\r\nContent-Length: 17\r\n\r\n'), Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"code":10008}')]),
  list: json('400 Bad Request', '[{"code":10008}]'),
  ratelimit: json('429 Too Many Requests', '{"message":"You are being rate limited.","retry_after":1.5,"global":false}', 'Retry-After: 2\r\n'),
  html: Buffer.from('HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/html\r\nContent-Length: 30\r\n\r\n<html><b>Bad gateway</b></html'),
  codes: json('404 Not Found', '{"message":"x","code":"10008"}'),
  invalid: Buffer.from('HTTP/1.1 400 Bad Request\r\nContent-Length: 6\r\n\r\n\xff\xfe{}\xff\xfe', 'latin1'),
  empty: 'close',
  garbage: Buffer.from('HELLO THERE\r\n\r\n'),
  truncated: Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\n{"id":"1"'),
  chunkcut: Buffer.from('HTTP/1.1 404 Not Found\r\nTransfer-Encoding: chunked\r\n\r\nf\r\n{"message":"Unk\r\n'),
  excess: Buffer.from('HTTP/1.1 404 Not Found\r\nContent-Length: 14\r\n\r\n{"code":10008}GARBAGE AFTER THE BODY'),
  hang: null,
  stall: { partial: Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\n{"id":"1"') },
  stallchunked: { partial: Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n9\r\n{"id":"1"\r\n') },
};

let server: net.Server;
let base = '';
let closedPort = 0;
let tlsServer: https.Server | null = null;
let tlsBase = '';
let tlsDir = '';
const captured: string[] = [];

before(async () => {
  server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = buf.subarray(0, end).toString('latin1');
      const len = Number(/\r\ncontent-length: *(\d+)/i.exec(head)?.[1] ?? 0);
      if (buf.length < end + 4 + len) return;
      captured.push(buf.toString('latin1'));
      const name = (/^\S+ \/r\/(\w+)/.exec(head)?.[1] ?? 'ok');
      const reply = REPLIES[name];
      if (reply === 'close') sock.destroy();
      else if (reply instanceof Buffer) sock.end(reply);
      else if (reply !== null) sock.write(reply.partial);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  closedPort = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  // Eigenes Zertifikat nur für diesen Lauf (kein privater Schlüssel im Repository); ohne openssl fällt der Fall weg
  try {
    tlsDir = mkdtempSync(join(tmpdir(), 'oys-tls-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(tlsDir, 'k.pem'), '-out', join(tlsDir, 'c.pem'),
      '-days', '2', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    tlsServer = https.createServer({ key: readFileSync(join(tlsDir, 'k.pem')), cert: readFileSync(join(tlsDir, 'c.pem')) }, (_q, r) => r.end('{}'));
    await new Promise<void>((resolve) => tlsServer!.listen(0, '127.0.0.1', () => resolve()));
    tlsBase = `https://localhost:${(tlsServer.address() as net.AddressInfo).port}`;
  } catch {
    tlsServer = null;
  }
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (tlsServer) await new Promise<void>((resolve) => tlsServer!.close(() => resolve()));
  if (tlsDir) rmSync(tlsDir, { recursive: true, force: true });
});

// PHP mit lib/updates.php, ohne Proxy-Variablen (curl würde sie nutzen, Node nicht); läuft asynchron, damit der
// Lauscher im selben Prozess antworten kann
function php(method: string, url: string, payload: unknown, headers: string[]): Promise<unknown> {
  const code = `require '${phpFile('lib/config.php')}'; date_default_timezone_set(oys_config('timezone', 'Europe/Berlin')); mb_internal_encoding('UTF-8');
    require '${phpFile('security.php')}'; require '${phpFile('lib/helpers.php')}'; require '${phpFile('lib/updates.php')}';
    $in = json_decode(stream_get_contents(STDIN), true);
    echo json_encode(oys_discord_request($in[0], $in[1], $in[2], $in[3]), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);`;
  const env = { ...process.env };
  for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) delete env[k];
  return new Promise((resolve, reject) => {
    const child = spawn('php', ['-d', 'display_errors=stderr', '-r', code], { cwd: phpRoot(), env });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('close', (status) => (status === 0 ? resolve(JSON.parse(out)) : reject(new Error(err))));
    child.stdin.end(JSON.stringify([method, url, payload, headers]));
  });
}

// Millisekunden in den Texten von curl
const ms = (v: unknown): unknown => JSON.parse(JSON.stringify(v).replace(/after \d+ (ms|milliseconds)/g, 'after N $1'));
// Gewollter Unterschied: bricht eine Antwort ab, zählt sie in Node als „keine Antwort“ (Status 0) – curl behält den
// schon gelesenen Status (z. B. 200), und PHP hielt einen abgeschnittenen Erfolg für einen Erfolg ohne Nachrichten-ID
const brokenIsNoAnswer = (v: unknown): unknown => {
  const list = Array.isArray(v) ? v : [v];
  const out = list.map((r) => (r && typeof r === 'object' && (r as { error?: string }).error ? { ...(r as object), status: 0 } : r));
  return Array.isArray(v) ? out : out[0];
};

// Rohe Anfrage: Anfragezeile, Kopfzeilen (sortiert, ohne Connection) und Inhalt
function raw(text: string): { line: string; headers: string[]; body: string } {
  const end = text.indexOf('\r\n\r\n');
  const [line, ...headers] = text.slice(0, end).split('\r\n');
  return { line, headers: headers.filter((h) => !/^connection:/i.test(h)).sort(), body: text.slice(end + 4) };
}

test('Discord requests carry JSON, the bot header and the user agent; answers and failures are read', async () => {
  captured.length = 0;
  const ok = await discordRequest('POST', base + '/r/ok', { embeds: [{ title: 'Äpfel & "q"' }] }, ['Authorization: Bot test']);
  assert.deepEqual([ok.status, ok.data?.id], [200, '1300000000000000001']);
  const sent = raw(captured[0]);
  assert.equal(sent.line, 'POST /r/ok HTTP/1.1');
  assert.ok(sent.headers.includes('Content-Type: application/json') && sent.headers.includes('Authorization: Bot test'), sent.headers.join('\n'));
  assert.ok(sent.headers.some((h) => h.startsWith('User-Agent: DiscordBot (https://')), sent.headers.join('\n'));
  // Mitschnitt als latin1: der Inhalt geht als UTF-8 ohne \u-Escapes hinaus
  assert.equal(sent.body, Buffer.from('{"embeds":[{"title":"Äpfel & \\"q\\""}]}').toString('latin1'));
  const missing = await discordRequest('DELETE', base + '/r/chunked', null, []);
  assert.deepEqual([missing.status, missing.code], [404, 10008]);
  const refused = await discordRequest('POST', `http://127.0.0.1:${closedPort}/api`, { a: 1 }, []);
  assert.equal(refused.status, 0);
  assert.notEqual(refused.error, '');
});

test('Discord requests leave the server byte for byte like curl in PHP', { skip: PHP_SKIP }, async () => {
  const payload = {
    embeds: [{
      title: 'v2.4 – Äpfel & "quotes" / <b>     \u{1F41D} \\ back', url: 'https://oys.test/updates/7', color: 2278750,
      author: { name: 'New' }, footer: { text: 'OnYourSite Updates' }, timestamp: '2026-10-25T00:30:00Z', description: 'line\nnext\ttab \u007f   ' + 'wärd '.repeat(700),
    }],
    allowed_mentions: { parse: [], roles: ['1301234567890123457'] }, content: '<@&1301234567890123457>', username: 'News', avatar_url: 'https://x.y/a b.png',
  };
  const cases: Array<[string, string, unknown, string[]]> = [
    ['POST', '/api/v10/webhooks/123456/AbCdEfGhIjKlMnOpQrStUvWxYz0123?wait=true', payload, []],
    ['PATCH', '/api/v10/channels/1301234567890123456/messages/1300000000000000001', { embeds: [{ title: 'x' }] }, ['Authorization: Bot MTMw.Ga.abc']],
    ['DELETE', '/api/v10/webhooks/123456/AbCdEfGhIjKlMnOpQrStUvWxYz0123/messages/1300000000000000001', null, []],
    ['POST', '/r/nocontent', { embeds: [], allowed_mentions: { parse: [] } }, []],
  ];
  for (const [method, path, body, headers] of cases) {
    captured.length = 0;
    const theirs = await php(method, base + path, body, headers);
    const ours = await discordRequest(method, base + path, body as never, headers);
    assert.deepEqual(ours, theirs, path);
    assert.equal(captured.length, 2, path);
    assert.deepEqual(raw(captured[1]), raw(captured[0]), path);
  }
});

test('Discord answers, broken replies and network errors give the same result as curl in PHP', { skip: PHP_SKIP }, async () => {
  const urls = Object.keys(REPLIES).filter((k) => !['hang', 'stall', 'stallchunked'].includes(k)).map((k) => base + '/r/' + k);
  urls.push(`http://127.0.0.1:${closedPort}/api`, 'https://nonexistent-host-oys.invalid/api/v10/webhooks/1/x');
  // Steuer- und Leerzeichen in der Adresse (z. B. eine gespeicherte Nachrichten-ID mit \n am Ende): curl sendet nichts
  for (const bad of ['1300000000000000050\n', '13 00', '1\t2', '1\r', '\x7f', '\x01', '?a b']) urls.push(base + '/r/ok/messages/' + bad);
  if (tlsBase) urls.push(tlsBase + '/api');
  for (const url of urls) {
    for (const [method, body] of [['POST', { a: 1 }], ['DELETE', null]] as const) {
      const theirs = await php(method, url, body, []);
      const ours = await discordRequest(method, url, body, []);
      assert.deepEqual(ms(ours), ms(brokenIsNoAnswer(theirs)), `${method} ${url}`);
    }
  }
});

test('Discord timeouts: no answer, a stuck body and a stuck TLS handshake give the texts of curl in PHP', { skip: PHP_SKIP }, async () => {
  // Alles gleichzeitig, damit der Test nur einmal 10 Sekunden wartet
  const urls = ['hang', 'stall', 'stallchunked'].map((k) => base + '/r/' + k);
  const stuckTls = base.replace('http:', 'https:') + '/r/hang';
  const [theirs, ours] = await Promise.all([
    Promise.all([...urls.map((u) => php('POST', u, { a: 1 }, [])), php('DELETE', stuckTls, null, [])]),
    Promise.all([...urls.map((u) => discordRequest('POST', u, { a: 1 }, [])), discordRequest('DELETE', stuckTls, null, [])]),
  ]);
  assert.deepEqual(ms(ours), ms(brokenIsNoAnswer(theirs)));
});
