// Eigene Domains (PD-2) über den echten Server (Fastify inject, ohne offenen Port): Prüfstelle je Zustand, was auf
// einer Kunden-Domain erreichbar ist (Seite, Kalender, Uploads nur des Besitzers, /_/ nur für Kennungen dieser Seite),
// Weiterleitungen der OnYourSite-Adressen, Termin-Block, keine Sitzung – und ohne Einrichtung keine einzige Abfrage.
// Domains werden über den Store aktiviert (ohne Cloudflare, wie es der Domain-Dienst später tut).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { loadConfig, setConfigForTests, type ConfigData } from '../src/config.js';
import { closePool, exec, getPool, one, q, value, type Db, type Param } from '../src/db.js';
import { passwordHash } from '../src/crypto.js';
import { buildServer } from '../src/server.ts';
import { dispatch } from '../src/router.js';
import { isHalt, makeTestCtx } from '../src/web/ctx.js';
import { ogHash } from '../src/content/share.js';
import { calendarKey } from '../src/content/blocks.js';
import { loadPage, savePage } from '../src/content/pages.js';
import { clearUnknownHostsForTests } from '../src/domains/store.js';
import { createDomain, domainById, probeAnswer, removeDomain, transition, type DomainState } from '../src/domains/index.js';
import { testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let cfg: ConfigData;
let domainId = 0;
const HOST = 'links.example.com';
const ORIGIN = 'http://links.example.com:8080';
const NEUTRAL = 'This domain isn’t connected to a page right now.';
// Testpasswort zur Laufzeit zusammengesetzt
const PW = ['garden', 'gate', '42'].join('-');
const seen: LightMyRequestResponse[] = [];
const ids = { link: 0, contact: 0, foreignContact: 0, foreignLink: 13, booking: 4 };
const files = { own: 'avatar_5_1700000000_abcdef01.webp', foreign: 'file_6_1700000000_abcdef02.pdf' };

async function req(method: string, url: string, host: string, o: { form?: Record<string, string>; headers?: Record<string, string> } = {}): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { host, ...(o.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(o.headers ?? {}) };
  const res = await app.inject({ method: method as 'GET', url, headers, payload: o.form ? new URLSearchParams(o.form).toString() : undefined });
  if (host.split(':')[0] === HOST || host.startsWith('nothing.')) seen.push(res);
  return res;
}
const neutral = (res: LightMyRequestResponse, what: string): void => {
  assert.equal(res.statusCode, 404, what);
  assert.ok(res.body.includes(NEUTRAL), what + ': neutral page');
  assert.ok(!res.body.includes('OnYourSite') && !res.body.includes('/register'), what + ': no OnYourSite marketing');
  assert.equal(res.headers['x-robots-tag'], 'noindex', what);
};

async function setState(state: DomainState, set: Record<string, Param> = {}): Promise<void> {
  assert.equal(await transition((await domainById(domainId))!, { state, set }), true, state);
}
const views = async (pageId: number): Promise<number> => Number(await value('SELECT views FROM pages WHERE id = ?', [pageId]));
const canonical = (body: string): string | undefined => /<link rel="canonical" href="([^"]*)"/.exec(body)?.[1];

before(async () => {
  t = await testDatabase('pd2http');
  cfg = {
    ...loadConfig(), base_domain: 'oys.test:8080', scheme: 'http',
    cloudflare: { zone_id: 'f'.repeat(32) }, custom_domains: { cname_target: 'edge.oys.test', fallback_origin: 'origin.oys.test', url_port: ':8080' },
  };
  setConfigForTests(cfg);
  app = await buildServer();
  const sql = (s: string, p: unknown[]) => t.admin.query(s.replace(/`DB`/g, '`' + t.name + '`'), p);
  const hash = await passwordHash(PW);
  const now = '2026-11-01 10:00:00';
  const add = async (pageId: number, type: string, data: unknown, protection = 'none', pw: string | null = null): Promise<number> => {
    const [r] = await sql("INSERT INTO `DB`.page_blocks (page_id, type, position, is_visible, data, protection, password_hash, created_at) VALUES (?, ?, 9, 1, ?, ?, ?, ?)",
      [pageId, type, JSON.stringify(data), protection, pw, now]);
    return (r as { insertId: number }).insertId;
  };
  ids.link = await add(2, 'link', { title: 'Secret', url: 'https://mia.design/secret' }, 'password', hash);
  ids.contact = await add(2, 'contact', { title: 'Write me' });
  ids.foreignContact = await add(3, 'contact', { title: 'Tom' });
  writeFileSync(join(t.uploads, files.own), 'own');
  writeFileSync(join(t.uploads, files.foreign), 'foreign');
  domainId = await createDomain({ hostname: HOST, targetId: 2, userId: 5 });
});

after(async () => {
  await app.close();
  await t.done();
});

test('the probe answers in the states where the domain is set up, and never with 403', async () => {
  const answer = probeAnswer(HOST);
  for (const state of ['pending', 'active', 'broken', 'suspended', 'verifying', 'failed', 'blocked', 'removing'] as DomainState[]) {
    await setState(state);
    const res = await req('GET', '/_/domain-check', HOST);
    assert.notEqual(res.statusCode, 403, state);
    if (['pending', 'active', 'broken', 'suspended'].includes(state)) {
      assert.equal(res.statusCode, 200, state);
      assert.equal(res.body, answer, state);
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(res.headers['x-robots-tag'], 'noindex');
      assert.match(String(res.headers['content-type']), /^text\/plain/);
      assert.equal((await req('HEAD', '/_/domain-check', HOST)).statusCode, 200);
    } else {
      neutral(res, state);
    }
  }
  neutral(await req('GET', '/_/domain-check', 'nothing.example.net'), 'unknown host');
  // Wie die Prüfung des Dienstes durch dispatch() (Host mit Punkt am Ende, Großbuchstaben)
  await setState('active');
  const ctx = makeTestCtx({ url: '/_/domain-check', host: 'LINKS.example.com.' });
  try {
    await dispatch(ctx);
  } catch (err) {
    if (!isHalt(err)) throw err;
  }
  assert.equal(ctx.status, 200);
  assert.equal(String(ctx.body), answer);
  assert.equal(ctx.customDomain?.hostname, HOST);
  neutral(await req('POST', '/_/domain-check', HOST), 'POST');
});

test('the main host answers the self-test after a database query, and 503 without the database', async () => {
  const res = await req('GET', '/_/domain-check', 'oys.test:8080');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, probeAnswer('oys.test'));
  assert.equal(res.headers['cache-control'], 'no-store');
  // Auf einer Subdomain wie bisher: nichts
  assert.equal((await req('GET', '/_/domain-check', 'mia.oys.test:8080')).statusCode, 404);
  await closePool();
  setConfigForTests({ ...cfg, db: { ...(cfg.db as ConfigData), host: '127.0.0.1', port: '1' } });
  try {
    const down = await req('GET', '/_/domain-check', 'oys.test:8080');
    assert.equal(down.statusCode, 503);
    assert.notEqual(down.body, probeAnswer('oys.test'));
  } finally {
    await closePool();
    setConfigForTests(cfg);
  }
});

test('a live domain shows its page and nothing else of OnYourSite', async () => {
  await setState('active');
  const page = await req('GET', '/', HOST);
  assert.equal(page.statusCode, 200);
  assert.equal(canonical(page.body), ORIGIN);
  assert.ok(page.body.includes(`<meta property="og:url" content="${ORIGIN}">`));
  assert.equal((await req('GET', '/kalender', HOST)).statusCode, 200);
  assert.equal((await req('GET', '/kalender?k=anything', HOST)).statusCode, 200);
  for (const path of ['/x', '/mia', '/kalender/x', '/favicon.ico', '/Login']) {
    const r = await req('GET', path, HOST);
    assert.equal(r.statusCode, 302, path);
    assert.equal(r.headers.location, ORIGIN + '/', path);
  }
  for (const [method, path] of [['GET', '/login'], ['GET', '/register'], ['GET', '/logout'], ['GET', '/dashboard'], ['GET', '/dashboard/api/stats'],
    ['POST', '/dashboard/api/save'], ['GET', '/admin'], ['POST', '/admin'], ['GET', '/updates'], ['GET', '/updates/1'], ['GET', '/privacy'],
    ['GET', '/api.php?user=mia'], ['GET', '/admin_impersonate.php?id=5'], ['GET', '/admin_return.php'], ['POST', '/track-click'],
    ['GET', '/_/bot/ping'], ['GET', '/_/cron/weekly-report?key=x'], ['GET', '/_/demo/aurora'], ['GET', '/_/nothing'], ['GET', '/_/v'], ['GET', '/static/nope.css']]) {
    neutral(await req(method, path, HOST), `${method} ${path}`);
  }
  // Designs, Schriften und Skripte wie überall
  const css = await req('GET', '/static/css/page.css', HOST);
  assert.equal(css.statusCode, 200);
  assert.match(String(css.headers['content-type']), /text\/css/);
  assert.equal((await req('GET', '/robots.txt', HOST)).statusCode, 200);
  // Die Sperrliste gilt auch hier
  assert.equal((await req('GET', '/.git/HEAD', HOST)).statusCode, 403);
  assert.equal((await req('GET', '/config.json', HOST)).statusCode, 403);
});

test('uploads on a custom domain: only files of the domain’s owner', async () => {
  await setState('active');
  const own = await req('GET', '/static/uploads/' + files.own, HOST);
  assert.equal(own.statusCode, 200);
  assert.equal(own.body, 'own');
  for (const path of ['/static/uploads/' + files.foreign, '/static/%75ploads/' + files.foreign, '/static/uploads/avatar_5_x/../' + files.foreign,
    '/static/uploads/avatar_5_x%2f..%2f' + files.foreign, '/static/uploads/avatar_5_1700000000_missing.webp', '/static/uploads/og/2-abcdefabcdef.png',
    '/static/uploads/', '/static/uploads/x.php']) {
    neutral(await req('GET', path, HOST), path);
  }
  // Auf der Hauptdomain unverändert öffentlich
  assert.equal((await req('GET', '/static/uploads/' + files.foreign, 'oys.test:8080')).statusCode, 200);
});

test('/_/ endpoints on a custom domain take only ids of this page', async () => {
  await setState('active');
  const before = await views(2);
  assert.equal((await req('POST', '/_/v', HOST, { form: { p: '2' }, headers: { origin: ORIGIN } })).statusCode, 204);
  assert.equal(await views(2), before + 1);
  // Fremder Ursprung: angenommen, aber nicht gezählt
  assert.equal((await req('POST', '/_/v', HOST, { form: { p: '2' }, headers: { origin: 'https://evil.example' } })).statusCode, 204);
  assert.equal(await views(2), before + 1);
  const tom = await views(3);
  neutral(await req('POST', '/_/v', HOST, { form: { p: '3' }, headers: { origin: ORIGIN } }), 'view of another page');
  assert.equal(await views(3), tom);

  const clicks = Number(await value('SELECT clicks FROM page_blocks WHERE id = 8'));
  assert.equal((await req('POST', '/_/c', HOST, { form: { b: '8' }, headers: { referer: ORIGIN + '/' } })).statusCode, 204);
  assert.equal(Number(await value('SELECT clicks FROM page_blocks WHERE id = 8')), clicks + 1);
  neutral(await req('POST', '/_/c', HOST, { form: { b: String(ids.foreignLink) } }), 'click of another page');
  neutral(await req('POST', '/_/c', HOST, { form: { b: '8x' } }), 'malformed block id');

  // Geschützter Link: Gate auf der Domain, fremde Blöcke nicht
  const gate = await req('GET', '/_/go/' + ids.link, HOST);
  assert.equal(gate.statusCode, 200);
  assert.ok(gate.body.includes('Protected link'));
  assert.equal(gate.headers['x-robots-tag'], 'noindex');
  neutral(await req('GET', '/_/go/' + ids.foreignLink, HOST), 'go to another page');
  neutral(await req('GET', '/_/go/999999', HOST), 'go to an unknown block');
  const unlocked = await req('POST', '/_/unlock', HOST, { form: { b: String(ids.link), pw: PW } });
  assert.equal(unlocked.statusCode, 200);
  assert.deepEqual(JSON.parse(unlocked.body), { ok: true, url: 'https://mia.design/secret' });
  neutral(await req('POST', '/_/unlock', HOST, { form: { b: String(ids.foreignContact), pw: PW } }), 'unlock of another page');

  // Kontaktformular: zurück auf die Domain, auch beim Fehler ohne JSON (nie zur Startseite von OnYourSite)
  const expired = await req('POST', '/_/contact', HOST, { form: { b: String(ids.contact), t: 'bad', name: 'A', email: 'a@example.org', message: 'Hello there' } });
  assert.equal(expired.statusCode, 302);
  assert.equal(expired.headers.location, ORIGIN + '#contact-' + ids.contact);
  const notContact = await req('POST', '/_/contact', HOST, { form: { b: '8' } });
  assert.equal(notContact.statusCode, 302);
  assert.equal(notContact.headers.location, ORIGIN + '/');
  const json = await req('POST', '/_/contact', HOST, { form: { b: '8' }, headers: { accept: 'application/json' } });
  assert.equal(json.statusCode, 404);
  assert.equal(JSON.parse(json.body).ok, false);
  neutral(await req('POST', '/_/contact', HOST, { form: { b: String(ids.foreignContact) } }), 'contact form of another page');

  // Vorschaubild: der Hash enthält die Domain, das Bild einer anderen Seite gibt es hier nicht
  const mia = (await loadPage(2))!;
  assert.equal(mia.custom_domain, HOST);
  const hash = ogHash(mia);
  const og = await req('GET', `/_/og/2-${hash}.png`, HOST);
  assert.equal(og.statusCode, 200);
  assert.equal(og.headers['content-type'], 'image/png');
  const old = await req('GET', '/_/og/2-000000000000.png', HOST);
  assert.equal(old.statusCode, 302);
  assert.equal(old.headers.location, `/_/og/2-${hash}.png`);
  neutral(await req('GET', `/_/og/3-${ogHash((await loadPage(3))!)}.png`, HOST), 'card of another page');
  assert.ok((await req('GET', '/', HOST)).body.includes(`${ORIGIN}/_/og/2-${hash}.png`));
});

test('pending and broken domains still show the page, with the OnYourSite address as canonical; paused ones forward', async () => {
  for (const state of ['pending', 'broken'] as DomainState[]) {
    await setState(state);
    const res = await req('GET', '/', HOST);
    assert.equal(res.statusCode, 200, state);
    assert.equal(canonical(res.body), 'http://mia.oys.test:8080', state);
    // Die OnYourSite-Adresse zeigt die Seite wieder selbst
    assert.equal((await req('GET', '/', 'mia.oys.test:8080')).statusCode, 200, state);
  }
  await setState('suspended');
  for (const [path, location] of [['/?a=1&b=2', 'http://mia.oys.test:8080?a=1&b=2'], ['/kalender?k=x', 'http://mia.oys.test:8080/kalender?k=x'],
    ['/somewhere?a=1', 'http://mia.oys.test:8080'], ['/_/go/' + ids.link, 'http://mia.oys.test:8080']]) {
    const res = await req('GET', path, HOST);
    assert.equal(res.statusCode, 302, path);
    assert.equal(res.headers.location, location, path);
    assert.equal(res.headers['cache-control'], 'no-store', path);
  }
  // Seite im Pfad-Modus: dorthin
  await t.admin.query(`UPDATE \`${t.name}\`.pages SET address_mode = 'path' WHERE id = 2`);
  assert.equal((await req('GET', '/', HOST)).headers.location, 'http://oys.test:8080/mia');
  await t.admin.query(`UPDATE \`${t.name}\`.pages SET address_mode = 'subdomain' WHERE id = 2`);
  for (const state of ['verifying', 'failed', 'blocked', 'removing'] as DomainState[]) {
    await setState(state);
    neutral(await req('GET', '/', HOST), state);
    neutral(await req('GET', '/static/uploads/' + files.own, HOST), state + ' upload');
  }
});

test('the OnYourSite addresses of a page with a live domain forward to it, unless the owner switched that off', async () => {
  await setState('active', { redirect: 1 });
  for (const [host, path, location] of [
    ['mia.oys.test:8080', '/?x=1', ORIGIN + '?x=1'],
    ['mia.oys.test:8080', '/kalender?k=abc', ORIGIN + '/kalender?k=abc'],
    ['mia.oys.test:8080', '/xyz?q=1', ORIGIN],
    ['oys.test:8080', '/mia?x=1', ORIGIN + '?x=1'],
    ['oys.test:8080', '/mia/kalender', ORIGIN + '/kalender'],
  ]) {
    const res = await req('GET', path, host);
    assert.equal(res.statusCode, 302, host + path);
    assert.equal(res.headers.location, location, host + path);
    assert.equal(res.headers['cache-control'], 'no-store', host + path);
  }
  // Öffentliche Schnittstelle: url ist die Domain, urls.custom nur mit Domain
  const api = JSON.parse((await req('GET', '/api.php?user=mia', 'oys.test:8080')).body);
  assert.equal(api.data.profile.url, ORIGIN);
  assert.deepEqual(api.data.profile.urls, { subdomain: 'http://mia.oys.test:8080', path: 'http://oys.test:8080/mia', custom: ORIGIN });
  const tom = JSON.parse((await req('GET', '/api.php?user=tom', 'oys.test:8080')).body);
  assert.deepEqual(Object.keys(tom.data.profile.urls), ['subdomain', 'path']);

  // Schalter aus: beide OnYourSite-Adressen zeigen die Seite (wie bisher je nach Adress-Art), kanonisch bleibt die Domain
  await setState('active', { redirect: 0 });
  const sub = await req('GET', '/', 'mia.oys.test:8080');
  assert.equal(sub.statusCode, 200);
  assert.equal(canonical(sub.body), ORIGIN);
  assert.ok(sub.body.includes(`"share":{"url":"${ORIGIN}"`), 'share button uses the domain');
  assert.ok(sub.body.includes('<p class="oys-share-url">links.example.com:8080</p>'), 'share dialog shows the domain');
  const path = await req('GET', '/mia', 'oys.test:8080');
  assert.equal(path.statusCode, 302);
  assert.equal(path.headers.location, 'http://mia.oys.test:8080');
  assert.equal(path.headers['cache-control'], undefined);
  await setState('active', { redirect: 1 });
  // Ohne Domain: unverändert, keine Weiterleitung
  assert.equal((await req('GET', '/', 'tom.oys.test:8080')).statusCode, 200);
});

test('a booking block that names the domain keeps its key gate in every state, and is saved as /kalender', async () => {
  await t.admin.query(`UPDATE \`${t.name}\`.page_blocks SET protection = 'password', password_hash = ?, data = ? WHERE id = ?`,
    [await passwordHash(PW), JSON.stringify({ title: 'Book', url: ORIGIN + '/kalender' }), ids.booking]);
  const block = await one('SELECT * FROM page_blocks WHERE id = ?', [ids.booking]);
  const key = calendarKey({ id: 2 }, block!);
  for (const state of ['active', 'broken', 'suspended'] as DomainState[]) {
    await setState(state);
    const host = state === 'active' ? HOST : 'mia.oys.test:8080';
    const base = state === 'active' ? ORIGIN : 'http://mia.oys.test:8080';
    assert.equal((await req('GET', '/kalender', host)).statusCode, 404, state + ': no key, no calendar');
    assert.equal((await req('GET', '/kalender?k=' + key, host)).statusCode, 200, state + ': with the key');
    const unlocked = JSON.parse((await req('POST', '/_/unlock', host, { form: { b: String(ids.booking), pw: PW } })).body);
    assert.deepEqual(unlocked, { ok: true, url: base + '/kalender?k=' + key }, state);
  }
  // Speichern im Editor macht daraus /kalender – der Kalender bleibt geschützt, auch nachdem die Domain weg ist
  await setState('active');
  const page = (await loadPage(2))!;
  const blocks = [{ id: ids.booking, type: 'booking', data: { title: 'Book', url: ORIGIN + '/kalender/' }, protection: 'password', password: '' }];
  await savePage(page, { page: { title: page.title, settings: {} }, blocks }, 5, false);
  const saved = JSON.parse(String(await value('SELECT data FROM page_blocks WHERE id = ?', [ids.booking])));
  assert.equal(saved.url, '/kalender');
  const pool: Db = { q, one, value, exec };
  assert.equal(await removeDomain(pool, domainId, 'test'), 'deleted');
  const key2 = calendarKey({ id: 2 }, (await one('SELECT * FROM page_blocks WHERE id = ?', [ids.booking]))!);
  assert.equal((await req('GET', '/kalender', 'mia.oys.test:8080')).statusCode, 404);
  assert.equal((await req('GET', '/kalender?k=' + key2, 'mia.oys.test:8080')).statusCode, 200);
  neutral(await req('GET', '/', HOST), 'removed domain');
  domainId = await createDomain({ hostname: HOST, targetId: 2, userId: 5 });
});

test('a custom domain never starts a session', () => {
  assert.ok(seen.length > 50, String(seen.length));
  for (const res of seen) assert.equal(res.headers['set-cookie'], undefined, `${res.statusCode} ${res.body.slice(0, 60)}`);
});

test('without the setup an unknown host gets today’s 404 and costs no database query; with it, one lookup per 10 s', async () => {
  let acquired = 0;
  const watch = (): void => {
    getPool().on('acquire', () => void acquired++);
  };
  setConfigForTests({ ...cfg, cloudflare: {} });
  await closePool();
  watch();
  const res = await req('GET', '/', 'nothing.example.net');
  assert.equal(res.statusCode, 404);
  assert.ok(res.body.includes('Page not found') && res.body.includes('OnYourSite'), 'today’s 404 page');
  assert.equal((await req('GET', '/_/domain-check', 'oys.test:8080')).statusCode, 404);
  assert.equal(acquired, 0);

  setConfigForTests(cfg);
  await closePool();
  clearUnknownHostsForTests();
  watch();
  neutral(await req('GET', '/', 'nothing.example.net'), 'unknown host');
  assert.equal(acquired, 1);
  neutral(await req('GET', '/x', 'nothing.example.net'), 'unknown host, cached');
  assert.equal(acquired, 1);
  // Unsinn im Host-Kopf: ohne Abfrage
  neutral(await req('GET', '/', 'bad_host!'), 'invalid host');
  assert.equal(acquired, 1);
  // Eine neue Domain in diesem Prozess ist sofort bekannt
  const id = await createDomain({ hostname: 'nothing.example.net', targetId: 3, userId: 6 });
  assert.equal(await transition((await domainById(id))!, { state: 'active' }), true);
  assert.equal((await req('GET', '/', 'nothing.example.net')).statusCode, 200);
});
