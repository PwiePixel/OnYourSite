// OnYourSites öffentliche Statusseite (status.oys.test) über den ganzen Server (Fastify inject): ohne Cookie, strenge
// CSP, Zwischenspeicher mit ETag/304, 405/404, jeder Text der Seite maskiert (Namen, Titel, Updates), private
// Bestandteile nirgends (HTML, JSON, Vorfall), Vorfall- und Verlaufsseiten (Markdown des Teams), /summary.json mit CORS, offline nur mit
// Vorschau-Schlüssel, die Weiterleitung von on-your.site/status, die Seite ohne Datenbank (letzte Ansicht mit rotem
// Hinweis, sonst die Notfall-Seite bzw. 503 für Seiten von Nutzern) und der Link „Status“ auf der Hauptseite.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { setConfigForTests, type ConfigData } from '../src/config.js';
import { closePool } from '../src/db.js';
import { ensureSchema } from '../src/schema.js';
import { buildServer } from '../src/server.js';
import { CSP, resetStatusRoutesForTests, statusPreviewToken } from '../src/status/routes.js';
import { BASE, testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
let app: FastifyInstance;
const OLD = '2026-01-01 10:00:00';
const STATUS = 'status.oys.test:8080';
let pageId = 0;
let pub = 0;
let secret = 0;
let incident = 0;

async function sql(query: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [r] = await t.admin.query<RowDataPacket[]>(query.replace(/`DB`/g, '`' + t.name + '`'), params);
  return r;
}
const get = (url: string, o: { host?: string; method?: 'GET' | 'HEAD' | 'POST' | 'DELETE'; headers?: Record<string, string> } = {}) =>
  app.inject({ method: o.method ?? 'GET', url, headers: { host: o.host ?? STATUS, ...(o.headers ?? {}) } });
const bump = () => sql('UPDATE `DB`.status_pages SET rev = rev + 1 WHERE id = ?', [pageId]);

before(async () => {
  t = await testDatabase('st3public', { empty: true });
  await ensureSchema();
  await sql("INSERT INTO `DB`.users (id, email, password, full_name, is_admin, created_at) VALUES (3, 'admin@test.de', 'x', 'Admin', 1, ?)", [OLD]);
  pageId = Number((await sql('SELECT id FROM `DB`.status_pages WHERE is_system = 1'))[0].id);
  const add = async (name: string, isPublic: number, group = ''): Promise<number> => {
    await sql(`INSERT INTO \`DB\`.status_monitors (page_id, user_id, type, name, group_name, is_public, target, config, interval_s, manual_status, manual_since, changed_at, created_at, updated_at)
      VALUES (?, NULL, 'manual', ?, ?, ?, '', '{}', 300, 'operational', 0, 0, NOW(), NOW())`, [pageId, name, group, isPublic]);
    return Number((await sql('SELECT MAX(id) AS id FROM `DB`.status_monitors'))[0].id);
  };
  pub = await add('<script>alert("pub")</script> Shop “API”', 1, 'Group <i>x</i>');
  secret = await add('Secret origin 10.0.0.7', 0);
  const now = Math.floor(Date.now() / 1000);
  await sql(`INSERT INTO \`DB\`.status_incidents (page_id, kind, title, status, impact, is_auto, starts_at, notify, created_by, created_at, updated_at)
    VALUES (?, 'incident', '<img src=x onerror=alert(1)> Payments “slow”', 'identified', 'major', 0, ?, 1, 3, NOW(), NOW())`, [pageId, now - 600]);
  incident = Number((await sql('SELECT MAX(id) AS id FROM `DB`.status_incidents'))[0].id);
  await sql("INSERT INTO `DB`.status_incident_monitors (incident_id, monitor_id, effect) VALUES (?, ?, 'partial'), (?, ?, 'major')", [incident, pub, incident, secret]);
  await sql(`INSERT INTO \`DB\`.status_incident_updates (incident_id, status, body, is_auto, created_by, created_at) VALUES
    (?, 'investigating', 'We look at it. <script>alert(2)</script> [docs](https://example.org/x) and [ours](/history) **bold**', 0, 3, ?)`, [incident, now - 600]);
  app = await buildServer();
  await app.ready();
});

after(async () => {
  await app?.close();
  await t?.done();
});

test('the page: 200 without a cookie, strict CSP, public cache, banner role=status, labelled bars – every text escaped', async () => {
  resetStatusRoutesForTests();
  const res = await get('/');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['set-cookie'], undefined);
  assert.equal(res.headers['content-security-policy'], CSP);
  assert.equal(res.headers['cache-control'], 'public, max-age=30, stale-while-revalidate=60, stale-if-error=86400');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.match(String(res.headers.etag), /^W\/"[0-9a-f]{20}"$/);
  const html = res.body;
  assert.match(html, /<title>OnYourSite status<\/title>/);
  assert.match(html, /class="st-banner [^"]*" role="status" aria-live="polite" data-indicator="partial"/);
  assert.ok(html.includes('&lt;script&gt;alert(&quot;pub&quot;)&lt;/script&gt; Shop “API”'), 'component name escaped');
  assert.ok(html.includes('Group &lt;i&gt;x&lt;/i&gt;'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt; Payments “slow”'), 'incident title escaped');
  assert.ok(!/<script>alert|<img src=x|onerror=alert\(1\)>/.test(html), 'no raw markup from the database');
  assert.ok(!html.includes('Secret origin'), 'private components never appear');
  assert.match(html, /<i class="st-bar [^"]*" role="img" title="[^"]+" aria-label="[^"]+"><\/i>/);
  assert.equal((html.match(/class="st-bar /g) ?? []).length % 90, 0, '90 bars per component');
  assert.ok(!html.includes('Made with'), 'OnYourSite’s own page has no “Made with” line');
  // Nur Dateien vom eigenen Ursprung
  for (const m of html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)) assert.ok(!/^https?:\/\/(?!status\.oys\.test)/.test(m[1]) || m[0].includes('canonical') || m[0].includes('icon'), m[1]);
  // ETag: dieselbe Ausgabe → 304 ohne Inhalt
  const again = await get('/', { headers: { 'if-none-match': String(res.headers.etag) } });
  assert.equal(again.statusCode, 304);
  assert.equal(again.body, '');
  assert.equal((await get('/', { method: 'HEAD' })).statusCode, 200);
});

test('wrong methods 405, unknown paths 404 (noindex, no-store), an incident of another page 404', async () => {
  let res = await get('/', { method: 'POST' });
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, 'GET, HEAD');
  res = await get('/wp-admin');
  assert.equal(res.statusCode, 404);
  assert.equal(res.headers['x-robots-tag'], 'noindex');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['set-cookie'], undefined);
  res = await get('/incidents/999999');
  assert.equal(res.statusCode, 404);
  res = await get('/incidents/abc');
  assert.equal(res.statusCode, 404);
});

test('incident page and history: updates as escaped Markdown, links of the team’s text, private components left out', async () => {
  let res = await get('/incidents/' + incident);
  assert.equal(res.statusCode, 200);
  const html = res.body;
  assert.ok(html.includes('&lt;script&gt;alert(2)&lt;/script&gt;'), 'update text escaped');
  assert.match(html, /<strong>bold<\/strong>/);
  // Texte des Teams (OnYourSites Seite): fremde Links ohne ugc, eigene Pfade führen zur Hauptseite
  assert.match(html, /<a href="https:\/\/example\.org\/x" target="_blank" rel="noopener noreferrer">docs<\/a>/);
  assert.match(html, /<a href="http:\/\/oys\.test:8080\/history">ours<\/a>/);
  assert.ok(!html.includes('Secret origin'));
  assert.ok(html.includes('Shop “API”'));
  res = await get('/history');
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('Payments “slow”'));
  res = await get('/history?page=9');
  assert.equal(res.statusCode, 404, 'an empty later page');
});

test('/summary.json: CORS, only public components, the open incident with its URL', async () => {
  const res = await get('/summary.json');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['access-control-allow-origin'], '*');
  assert.match(String(res.headers['content-type']), /^application\/json/);
  const j = JSON.parse(res.body) as { page: { name: string; url: string }; status: { indicator: string }; components: Array<{ id: number; name: string }>; incidents: Array<{ id: number; url: string; impact: string }> };
  assert.equal(j.page.url, 'http://status.oys.test:8080/');
  assert.equal(j.status.indicator, 'partial');
  assert.ok(j.components.some((c) => c.id === pub));
  assert.ok(!j.components.some((c) => c.id === secret));
  assert.ok(!res.body.includes('Secret origin'));
  assert.deepEqual(j.incidents.map((i) => [i.id, i.url, i.impact]), [[incident, `http://status.oys.test:8080/incidents/${incident}`, 'major']]);
});

test('offline: “This status page is offline” (404, noindex) – the preview link shows it, noindex and no-store', async () => {
  await sql('UPDATE `DB`.status_pages SET is_published = 0 WHERE id = ?', [pageId]);
  await bump();
  try {
    let res = await get('/');
    assert.equal(res.statusCode, 404);
    assert.ok(res.body.includes('This status page is offline'));
    const token = statusPreviewToken({ id: pageId, slug: 'status' });
    res = await get('/?preview=' + token);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['x-robots-tag'], 'noindex');
    assert.match(res.body, /<meta name="robots" content="noindex">/);
    res = await get('/?preview=' + token.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')));
    assert.equal(res.statusCode, 404, 'a wrong key');
    // Kein Link „Status“ auf der Hauptseite, solange sie offline ist
    res = await get('/', { host: 'oys.test:8080' });
    assert.ok(!res.body.includes('>Status</a>'));
  } finally {
    await sql('UPDATE `DB`.status_pages SET is_published = 1 WHERE id = ?', [pageId]);
    await bump();
  }
});

test('the main host: /status redirects to the subdomain; landing page, /updates and /roadmap link “Status” in the footer', async () => {
  let res = await get('/status', { host: 'oys.test:8080' });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, 'http://status.oys.test:8080/');
  for (const path of ['/', '/updates', '/roadmap']) {
    res = await get(path, { host: 'oys.test:8080' });
    assert.equal(res.statusCode, 200, path);
    assert.match(res.body, /<a href="http:\/\/status\.oys\.test:8080\/" class="[^"]*">Status<\/a>/, path);
  }
});

test('without the database: the last view with a red notice and no-store; without one the fallback page (200) – a user page 503', async () => {
  resetStatusRoutesForTests();
  assert.equal((await get('/')).statusCode, 200, 'a good view is remembered');
  await closePool();
  setConfigForTests({ ...BASE, db: { ...(BASE.db as ConfigData), name: t.name, host: '127.0.0.1', port: '1' }, uploads_dir: t.uploads });
  try {
    let res = await get('/');
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.match(res.body, /<div class="st-alert st-alert-red" role="alert">We can’t load live data right now/);
    assert.ok(res.body.includes('Shop “API”'), 'the remembered components');
    assert.ok(!res.body.includes('Secret origin'));
    res = await get('/summary.json');
    assert.equal(res.statusCode, 200);
    assert.equal((JSON.parse(res.body) as { notice: string }).notice, 'We can’t load live data right now.');
    // Ohne gespeicherte Ansicht: die feste Notfall-Seite (Website und Datenbank gestört)
    resetStatusRoutesForTests();
    res = await get('/');
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /role="status"><span class="st-dot" aria-hidden="true"><\/span><strong>Major outage<\/strong>/);
    assert.equal(res.headers['cache-control'], 'no-store');
    res = await get('/history');
    assert.equal(res.statusCode, 503);
    assert.equal(res.headers['retry-after'], '60');
  } finally {
    await closePool();
    setConfigForTests({ ...BASE, db: { ...(BASE.db as ConfigData), name: t.name }, uploads_dir: t.uploads });
    resetStatusRoutesForTests();
  }
  assert.equal((await get('/')).statusCode, 200);
});
