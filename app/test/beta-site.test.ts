// Die Beta-Webseite hinter beta.<domain>: das Tor reicht angemeldete Tester an die zweite Installation weiter (Methode,
// Adresse, Kopfzeilen, Inhalt – auch nach multipart), setzt in HTML den Hinweis „Beta x.y.z · Panel“, lässt alles andere
// unverändert, schreibt die Sitzung nie; alle anderen landen beim Panel unter /_beta/; ohne Antwort der Beta-Webseite
// eine Hinweisseite; die Beta-Webseite selbst (beta_build) hat kein Tor und behandelt beta.<domain> als Hauptadresse.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import type { RowDataPacket } from 'mysql2/promise';
import { makeTestCtx, type Ctx } from '../src/web/ctx.js';
import { dispatch } from '../src/router.js';
import { ensureSchema } from '../src/schema.js';
import { loadConfig, setConfigForTests, type ConfigData } from '../src/config.js';
import { encryptData, passwordHash } from '../src/crypto.js';
import { betaUrl, grantBeta } from '../src/beta/beta.js';
import { addressUrl } from '../src/helpers.js';
import { betaGate, forgetBetaSiteVersion, isBetaBuild, withPill } from '../src/beta/site.js';
import { CSRF, loginSession, runRequest, testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
const ADMIN = 3, MIA = 5, LEA = 7;
const BETA = 'beta.oys.test:8080';
let upstream: http.Server;
let port = 0;
let dir = '';
let base: ConfigData;
// Was die nachgebaute Beta-Webseite zuletzt bekam
let seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer } | null = null;

async function sql(query: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [r] = await t.admin.query<RowDataPacket[]>(query.replace(/`DB`/g, '`' + t.name + '`'), params);
  return r;
}
async function req(url: string, o: { method?: string; sid?: string; headers?: Record<string, string>; rawBody?: Buffer; post?: Record<string, string>; host?: string } = {}): Promise<Ctx> {
  return runRequest(makeTestCtx({ url, host: o.host ?? BETA, method: o.method ?? (o.post || o.rawBody ? 'POST' : 'GET'), cookies: o.sid ? { PHPSESSID: o.sid } : undefined, headers: o.headers, rawBody: o.rawBody, post: o.post }), dispatch);
}
const bodyText = async (ctx: Ctx): Promise<string> => (ctx.body instanceof Readable ? await text(ctx.body) : String(ctx.body));
function configure(extra: ConfigData): void {
  setConfigForTests({ ...base, ...extra });
  forgetBetaSiteVersion();
}

before(async () => {
  t = await testDatabase('betasite', { empty: true });
  base = { ...loadConfig(), db: { ...(loadConfig().db as Record<string, string>), name: t.name }, base_domain: 'oys.test:8080', scheme: 'http' };
  dir = mkdtempSync(join(tmpdir(), 'oys-beta-site-'));
  writeFileSync(join(dir, 'VERSION'), '3.6.0-beta.1\n');
  upstream = http.createServer((rq, rs) => {
    const chunks: Buffer[] = [];
    rq.on('data', (c: Buffer) => chunks.push(c));
    rq.on('end', () => {
      seen = { method: rq.method ?? '', url: rq.url ?? '', headers: rq.headers, body: Buffer.concat(chunks) };
      if (rq.url === '/latin') {
        rs.writeHead(200, { 'Content-Type': 'text/html; charset=ISO-8859-1' });
        rs.end(Buffer.from([0x3c, 0x62, 0x3e, 0xe9, 0x3c, 0x2f, 0x62, 0x6f, 0x64, 0x79, 0x3e]));
        return;
      }
      if (rq.url?.startsWith('/api')) {
        rs.writeHead(201, { 'Content-Type': 'application/json', 'X-Beta': 'yes' });
        rs.end('{"ok":true,"html":"</body>"}');
        return;
      }
      rs.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8', 'Set-Cookie': ['a=1; path=/', 'b=2; path=/'], 'Content-Length': '60', Connection: 'close' });
      rs.end('<!DOCTYPE html><html><body><h1>Next version</h1></body></html>');
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  port = (upstream.address() as AddressInfo).port;
  configure({ beta_site: { port, dir } });
  await ensureSchema();
  const hash = await passwordHash('beta-site-1234');
  const add = 'INSERT INTO `DB`.users (id, email, password, full_name, username, is_admin, discord_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
  await sql(add, [ADMIN, 'admin@test.de', hash, 'Pixel Admin', 'pixel', 1, null, '2025-01-01 10:00:00']);
  await sql(add, [MIA, 'mia@test.de', hash, 'Mia Müller', 'mia', 0, encryptData('111111111111111111'), '2025-01-01 10:00:00']);
  await sql(add, [LEA, 'lea@test.de', hash, 'Lea', 'lea', 0, null, '2025-01-01 10:00:00']);
  await grantBeta(ADMIN, MIA);
});
after(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
  setConfigForTests(null);
  await t.done();
});

test('without a login, or without beta access: every address leads to the panel, nothing reaches the beta website', async () => {
  seen = null;
  let ctx = await req('/dashboard');
  assert.equal(ctx.status, 302);
  assert.equal(ctx.header('Location'), '/_beta/');
  ctx = await req('/_beta/');
  assert.match(String(ctx.body), /Welcome to the beta/);
  assert.match(String(ctx.body), /<form action="\/_beta\/login" method="POST"/);
  const lea = await loginSession(LEA);
  ctx = await req('/', { sid: lea });
  assert.equal(ctx.header('Location'), '/_beta/');
  assert.match(String((await req('/_beta/', { sid: lea })).body), /For beta testers only/);
  assert.equal(seen, null, 'the beta website got nothing');
});

test('testers: the panel has the button to the website with its version; every other address is the beta website', async () => {
  const mia = await loginSession(MIA);
  const panel = String((await req('/_beta/', { sid: mia })).body);
  assert.match(panel, /<a href="\/" [^>]*data-open-website/);
  assert.match(panel, /data-beta-version>3\.6\.0-beta\.1</);
  seen = null;
  const ctx = await req('/dashboard?tab=pages', { sid: mia, headers: { 'accept-language': 'en' } });
  assert.ok(seen, 'the beta website got the request');
  assert.deepEqual([seen!.method, seen!.url, seen!.headers.host, seen!.headers['accept-language']], ['GET', '/dashboard?tab=pages', BETA, 'en']);
  assert.match(String(seen!.headers.cookie), new RegExp('PHPSESSID=' + mia), 'the same session – logged in there too');
  assert.equal(ctx.status, 200);
  const html = await bodyText(ctx);
  assert.match(html, /<h1>Next version<\/h1><a href="\/_beta\/" id="oys-beta-pill"[\s\S]*Beta<\/span><span>3\.6\.0-beta\.1<\/span>[\s\S]*Panel<\/span><\/a><\/body>/);
  assert.equal(ctx.header('Content-Length'), undefined, 'the length changed with the note');
  assert.equal(ctx.header('Connection'), undefined, 'no per-connection headers');
  assert.equal(ctx.header('X-Robots-Tag'), 'noindex, nofollow');
  assert.deepEqual(ctx.headersOut().filter(([n]) => n.toLowerCase() === 'set-cookie').map(([, v]) => v), ['a=1; path=/', 'b=2; path=/']);
});

test('the request body goes along unchanged (also after multipart); other answers pass through untouched', async () => {
  const mia = await loginSession(MIA);
  const body = Buffer.from('--x\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--x--\r\n');
  const ctx = makeTestCtx({ url: '/api/upload', host: BETA, method: 'POST', cookies: { PHPSESSID: mia }, headers: { 'content-type': 'multipart/form-data; boundary=x' }, rawBody: body });
  ctx.rawBody = Buffer.alloc(0);
  await runRequest(ctx, dispatch);
  assert.deepEqual([seen!.method, seen!.headers['content-type'], seen!.body.toString()], ['POST', 'multipart/form-data; boundary=x', body.toString()]);
  assert.equal(ctx.status, 201);
  assert.equal(ctx.header('X-Beta'), 'yes');
  assert.equal(await bodyText(ctx), '{"ok":true,"html":"</body>"}', 'JSON stays as it is');
});

test('the gate never writes the session; admins always pass', async () => {
  const mia = await loginSession(MIA);
  await sql('UPDATE `DB`.oys_sessions SET last_seen = last_seen - 100 WHERE id = ?', [mia]);
  const [before] = await sql('SELECT data, last_seen FROM `DB`.oys_sessions WHERE id = ?', [mia]);
  await bodyText(await req('/', { sid: mia }));
  const [after] = await sql('SELECT data, last_seen FROM `DB`.oys_sessions WHERE id = ?', [mia]);
  assert.deepEqual(after, before);
  seen = null;
  await bodyText(await req('/admin', { sid: await loginSession(ADMIN) }));
  assert.equal(seen!.url, '/admin');
});

test('when the beta website doesn’t answer: a note with the way back to the panel; without one set up: the panel', async () => {
  const mia = await loginSession(MIA);
  const free = http.createServer();
  await new Promise<void>((r) => free.listen(0, '127.0.0.1', r));
  const dead = (free.address() as AddressInfo).port;
  await new Promise<void>((r) => free.close(() => r()));
  configure({ beta_site: { port: dead, dir } });
  const ctx = await req('/', { sid: mia });
  assert.equal(ctx.status, 502);
  assert.match(String(ctx.body), /The beta website is starting[\s\S]*href="\/_beta\/"/);
  configure({});
  assert.equal((await req('/', { sid: mia })).header('Location'), '/_beta/');
  assert.match(String((await req('/_beta/', { sid: mia })).body), /There’s no pre-release to try right now\./);
  configure({ beta_site: { port, dir } });
});

test('the beta website itself (beta_build): no gate, beta.<domain> is its main address, no way to the beta area', async () => {
  configure({ beta_build: true, base_domain: BETA, beta_site: { port, dir } });
  try {
    assert.equal(isBetaBuild(), true);
    const mia = await loginSession(MIA);
    seen = null;
    const ctx = makeTestCtx({ url: '/', host: BETA, cookies: { PHPSESSID: mia } });
    assert.equal(await betaGate(ctx), false);
    const login = await req('/login');
    assert.equal(login.status, 200);
    assert.match(String(login.body), /<form[^>]*action="\/login"/);
    assert.equal(seen, null);
  } finally {
    configure({ beta_site: { port, dir } });
  }
});

test('the note goes before the last </body>, or at the end', () => {
  assert.match(withPill('<body>a</body>', '1.0.0-beta.1'), /^<body>a<a href="\/_beta\/"[\s\S]*<\/a><\/body>$/);
  assert.match(withPill('no body', ''), /^no body<a href="\/_beta\/"/);
  assert.doesNotMatch(withPill('x', '<script>'), /<script>/, 'a version is escaped');
  assert.ok(CSRF);
});

test('a GET with a Content-Length but no body: the beta website gets no length (no request runs into the next one)', { timeout: 8000 }, async () => {
  const mia = await loginSession(MIA);
  seen = null;
  const ctx = await req('/dashboard', { sid: mia, headers: { 'content-length': '40' } });
  assert.equal(ctx.status, 200);
  await bodyText(ctx);
  assert.equal(seen!.headers['content-length'], undefined);
});

test('HTML in another charset keeps its bytes (the note is added to the bytes)', async () => {
  const mia = await loginSession(MIA);
  const ctx = await req('/latin', { sid: mia });
  const body = ctx.body as Buffer;
  assert.ok(Buffer.isBuffer(body));
  assert.deepEqual([...body.subarray(0, 4)], [0x3c, 0x62, 0x3e, 0xe9], 'é as one byte, as sent');
  assert.match(body.toString('latin1'), /<a href="\/_beta\/" id="oys-beta-pill"[\s\S]*<\/a><\/body>$/);
});

test('on the beta website: page addresses are paths (there is no name.beta.<domain>), the beta area link stays on beta.<domain>', async () => {
  configure({ beta_build: true, base_domain: BETA, beta_site: { port, dir } });
  try {
    assert.equal(addressUrl({ slug: 'mia', address_mode: 'subdomain' }), 'http://beta.oys.test:8080/mia');
    assert.equal(betaUrl('/_beta/'), 'http://beta.oys.test:8080/_beta/');
  } finally {
    configure({ beta_site: { port, dir } });
  }
  assert.equal(addressUrl({ slug: 'mia', address_mode: 'subdomain' }), 'http://mia.oys.test:8080');
});
