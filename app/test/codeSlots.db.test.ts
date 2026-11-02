// Code-Seiten auf Seitenplätzen – noch ruhend: nur Testdaten legen Plätze an. Der Schritt V_CODE_SLOTS (Schlüssel,
// Zähler, erneuter Lauf, frische Installation), das Ausliefern unter der Adresse des Platzes, die geparkte Link-Seite an
// allen öffentlichen Stellen, die Editor-API (409 für geparkte Seiten, Konto-Aktionen ohne gezeigte Link-Seite,
// page-create und page-delete unter der Platz-Sperre mit Begrenzung), Wochenbericht, Uploads über alle Code-Seiten,
// Konto löschen und gleichzeitige Anfragen. Strenger Schalter: eine zweite Verbindung innerhalb einer Sperre fällt auf.
process.env.OYS_DB_STRICT = '1';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { closePool, one, transaction, withConnection } from '../src/db.js';
import { date, time } from '../src/php.js';
import { setConfigForTests, type ConfigData } from '../src/config.js';
import { hmac, passwordHash } from '../src/crypto.js';
import { V_CODE_SLOTS, columnIsNotNull, ensureSchema, hasIndex } from '../src/schema.js';
import { makeTestCtx, type Ctx } from '../src/web/ctx.js';
import { Session } from '../src/web/session.js';
import { dispatch } from '../src/router.js';
import { appRoutes } from '../src/app/dispatch.js';
import { createPage, cleanupFiles, loadPage } from '../src/content/pages.js';
import { ogSupported, ogUrl } from '../src/content/share.js';
import { duplicateKey } from '../src/content/addresses.js';
import { codePreviewToken, codeSiteById, codeUsedUploads } from '../src/code/sites.js';
import { SLOT_BUSY_TEXT, SlotBusyError, SlotGoneError, withSlotLock } from '../src/code/slots.js';
import { runWeeklyReports, setReportMailerForTests } from '../src/app/report.js';
import { deleteUser } from '../src/admin/users.js';
import { BASE, CSRF, adminConnection, loginSession, runRequest, testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
const q = async (s: string, p: unknown[] = []): Promise<RowDataPacket[]> => (await t.admin.query<RowDataPacket[]>(s, p))[0];
const ago = (days: number): string => date('Y-m-d H:i:s', time() - Math.round(days * 86400));
const HOST = 'oys.test:8080';

before(async () => {
  t = await testDatabase('cs3slots');
  await t.admin.query('USE `' + t.name + '`');
});

after(async () => {
  setReportMailerForTests(undefined);
  await t.done();
});

// ---------------------------------------------------------------- Hilfen

// Ein Seitenplatz, der eine Code-Seite zeigt (so, wie ihn später die Editor-API anlegt): Link-Seite mit Startinhalt und
// Adresse, eine Code-Seite ohne eigene Adresse, die Verbindung über pages.code_site_id
async function codeSlot(userId: number, slug: string, files: Record<string, string> = { 'index.html': `<p>${slug} code</p>` },
  site: { published?: number; blocked?: number } = {}): Promise<{ pageId: number; siteId: number }> {
  const pageId = await createPage(userId, slug, 'Slot ' + slug);
  const siteId = await codeSiteRow(userId, null, files, site);
  await q('UPDATE pages SET code_site_id = ? WHERE id = ?', [siteId, pageId]);
  return { pageId, siteId };
}

async function codeSiteRow(userId: number, slug: string | null, files: Record<string, string>, site: { published?: number; blocked?: number } = {}): Promise<number> {
  const bytes = Object.values(files).reduce((n, c) => n + Buffer.byteLength(c), 0);
  const res = (await t.admin.query('INSERT INTO code_sites (user_id, slug, title, is_published, is_blocked, blocked_reason, views, file_count, bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, NOW(), NOW())',
    [userId, slug, 'Code ' + (slug ?? 'slot'), site.published ?? 1, site.blocked ?? 0, site.blocked ? 'Phishing' : null, Object.keys(files).length, bytes]))[0] as { insertId: number };
  for (const [path, content] of Object.entries(files)) {
    await q('INSERT INTO code_files (site_id, path, content, updated_at) VALUES (?, ?, ?, NOW())', [res.insertId, path, content]);
  }
  if (slug !== null) await q("INSERT INTO site_addresses (slug, kind, ref_id, user_id, claimed_at) VALUES (?, 'code', ?, ?, NOW())", [slug, res.insertId, userId]);
  return res.insertId;
}

// Eine Anfrage an den Server (Router wie im Betrieb), ohne Sitzung
async function get(host: string, url: string, init: { method?: string; post?: Record<string, string>; headers?: Record<string, string>; rawBody?: Buffer } = {}): Promise<Ctx> {
  const ctx = makeTestCtx({ method: init.method ?? 'GET', url, host, headers: init.headers, post: init.post, rawBody: init.rawBody });
  return runRequest(ctx, dispatch);
}

// Editor-API wie über den Server (Sitzung mit Login und CSRF-Token)
async function api(userId: number, action: string, json?: unknown, query = ''): Promise<{ status: number; body: Record<string, unknown> }> {
  const sid = await loginSession(userId);
  const post = json !== undefined;
  const ctx = makeTestCtx({
    method: post ? 'POST' : 'GET',
    url: '/dashboard/api/' + action + query,
    host: HOST,
    headers: post ? { 'content-type': 'application/json', 'x-csrf-token': CSRF } : {},
    cookies: { PHPSESSID: sid },
    rawBody: post ? Buffer.from(JSON.stringify(json)) : undefined,
  });
  await runRequest(ctx, appRoutes);
  return { status: ctx.status, body: JSON.parse(String(ctx.body)) as Record<string, unknown> };
}

const count = async (sql: string, p: unknown[] = []): Promise<number> => Number((await q(sql, p))[0].n);

// ---------------------------------------------------------------- Schritt V_CODE_SLOTS

test('the step allows code pages on page slots, keeps one own address per account, counts files and can run again', async () => {
  const names = [t.name + '_mig', t.name + '_new'];
  const ddl = async (db: string, table: string) =>
    String((await q(`SHOW CREATE TABLE \`${db}\`.\`${table}\``))[0]['Create Table']).replace(/ AUTO_INCREMENT=\d+/, '');
  const use = async (db: string) => {
    await closePool();
    setConfigForTests({ ...BASE, db: { ...(BASE.db as ConfigData), name: db }, uploads_dir: t.uploads });
  };
  try {
    for (const name of names) {
      await t.admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
      await t.admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    }
    // Stand vor dem Schritt: eine Code-Seite je Konto (uq_user), Dateien ohne Zähler
    await use(names[0]);
    await ensureSchema({ upTo: V_CODE_SLOTS - 1 });
    const m = (s: string, p: unknown[] = []) => t.admin.query<RowDataPacket[]>(s.replace(/`M`/g, '`' + names[0] + '`'), p);
    await m("INSERT INTO `M`.users (id, email, password) VALUES (5, 'mia@x.de', 'x'), (6, 'tom@x.de', 'x')");
    await m("INSERT INTO `M`.pages (id, user_id, slug, created_at) VALUES (1, 5, 'mia', NOW()), (2, 5, 'studio', NOW()), (3, 6, 'tom', NOW())");
    await m("INSERT INTO `M`.code_sites (id, user_id, slug, title, created_at) VALUES (1, 5, 'mia-dev', 'Dev', NOW()), (2, 6, 'tom-code', 'T', NOW())");
    await m("INSERT INTO `M`.code_files (site_id, path, content) VALUES (1, 'index.html', 'äbc'), (1, 'a.css', 'x{}'), (2, 'index.html', '')");
    await withConnection(async (_db, conn) => {
      assert.equal(await hasIndex(conn, 'code_sites', 'uq_user'), true);
      assert.equal(await columnIsNotNull(conn, 'code_sites', 'slug'), true);
    });
    await ensureSchema({ upTo: V_CODE_SLOTS });
    await withConnection(async (_db, conn) => {
      assert.equal(await hasIndex(conn, 'code_sites', 'uq_user'), false);
      for (const idx of ['idx_user', 'uq_own']) assert.equal(await hasIndex(conn, 'code_sites', idx), true, idx);
      assert.equal(await hasIndex(conn, 'pages', 'uq_code_site'), true);
      assert.equal(await columnIsNotNull(conn, 'code_sites', 'slug'), false);
    });
    const sites = (await m('SELECT id, own_user_id, file_count, bytes FROM `M`.code_sites ORDER BY id'))[0].map((r) => ({ ...r }));
    assert.deepEqual(sites, [{ id: 1, own_user_id: 5, file_count: 2, bytes: 7 }, { id: 2, own_user_id: 6, file_count: 1, bytes: 0 }]);
    assert.deepEqual((await m('SELECT COUNT(*) AS n FROM `M`.pages WHERE code_site_id IS NOT NULL'))[0][0].n, 0);
    assert.equal((await m("SHOW TABLES FROM `M` LIKE 'code\\_moderation'"))[0].length, 1);

    // Schlüssel: eine zweite Code-Seite mit eigener Adresse geht nicht, beliebig viele ohne eigene Adresse schon; ein Platz
    // zeigt höchstens eine Code-Seite, eine Code-Seite steht auf höchstens einem Platz
    const fail = async (s: string): Promise<string | null> => m(s).then(() => null, (err: unknown) => duplicateKey(err));
    assert.equal(await fail("INSERT INTO `M`.code_sites (user_id, slug, title) VALUES (5, 'mia-two', 'x')"), 'uq_own');
    assert.equal(await fail("INSERT INTO `M`.code_sites (id, user_id, slug, title) VALUES (3, 5, NULL, 'a'), (4, 5, NULL, 'b')"), null);
    assert.equal(await fail('UPDATE `M`.pages SET code_site_id = 3 WHERE id = 2'), null);
    assert.equal(await fail('UPDATE `M`.pages SET code_site_id = 3 WHERE id = 1'), 'uq_code_site');
    // Mia hat schon eine Code-Seite mit eigener Adresse: keine zweite bekommt eine
    assert.equal(await fail("UPDATE `M`.code_sites SET slug = 'clash' WHERE id = 4"), 'uq_own');
    // Abgebrochen mitten im Schritt (Index weg, Version zurück): der Schritt läuft noch einmal und ändert sonst nichts
    await m('ALTER TABLE `M`.code_sites DROP INDEX uq_own');
    await m("UPDATE `M`.oys_meta SET meta_value = ? WHERE meta_key = 'schema_version'", [String(V_CODE_SLOTS - 1)]);
    await ensureSchema({ upTo: V_CODE_SLOTS });
    await withConnection(async (_db, conn) => assert.equal(await hasIndex(conn, 'code_sites', 'uq_own'), true));
    // Frische Installation: dieselben Tabellen wie nach dem Schritt
    await use(names[1]);
    await ensureSchema({ upTo: V_CODE_SLOTS });
    for (const table of ['code_sites', 'pages', 'users', 'code_moderation', 'site_addresses']) {
      assert.equal(await ddl(names[1], table), await ddl(names[0], table), table);
    }
  } finally {
    await use(t.name);
    for (const name of names) await t.admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  }
});

// ---------------------------------------------------------------- Ausliefern

test('a slot that shows a code page serves the code page at its subdomain; the path form redirects there', async () => {
  const studio = await codeSlot(5, 'studio', { 'index.html': '<!DOCTYPE html><html><body><p>Studio code</p></body></html>', 'app.js': 'console.log(1)' });
  await codeSiteRow(5, 'mia-dev', { 'index.html': '<p>Dev</p>' });

  let ctx = await get('studio.' + HOST, '/');
  assert.equal(ctx.status, 200);
  assert.match(String(ctx.header('Content-Security-Policy')), /^sandbox allow-scripts/);
  assert.match(String(ctx.body), /<p>Studio code<\/p><a href="http:\/\/oys\.test:8080\/terms\/code-pages#report"/);
  ctx = await get('studio.' + HOST, '/app.js');
  assert.equal(String(ctx.body), 'console.log(1)');
  // Der Kalender und andere Pfade gehören der Code-Seite (hier: ihre 404)
  ctx = await get('studio.' + HOST, '/kalender');
  assert.equal(ctx.status, 404);
  assert.match(String(ctx.body), /This page doesn’t exist on studio\.oys\.test:8080\./);
  // Hauptdomain: Weiterleitung ohne Abfrage; /studio/kalender gibt es nicht
  ctx = await get(HOST, '/studio?ref=x');
  assert.equal(ctx.status, 302);
  assert.equal(ctx.header('Location'), 'http://studio.oys.test:8080/');
  ctx = await get(HOST, '/studio/kalender');
  assert.equal(ctx.status, 404);
  assert.match(String(ctx.body), /Page not found/);
  // Andere Plätze und die Code-Seite mit eigener Adresse bleiben, wie sie sind
  ctx = await get('mia.' + HOST, '/');
  assert.equal(ctx.status, 200);
  assert.equal(ctx.header('Content-Security-Policy'), undefined);
  ctx = await get('mia-dev.' + HOST, '/');
  assert.match(String(ctx.body), /<p>Dev<\/p>/);
  ctx = await get(HOST, '/mia-dev');
  assert.equal(ctx.header('Location'), 'http://mia-dev.oys.test:8080/');

  // Offline: Hinweis – mit dem Vorschau-Schlüssel für die Adresse des Platzes sieht der Besitzer die Seite
  await q('UPDATE code_sites SET is_published = 0 WHERE id = ?', [studio.siteId]);
  ctx = await get('studio.' + HOST, '/');
  assert.equal(ctx.status, 404);
  assert.match(String(ctx.body), /This page is offline/);
  const site = (await codeSiteById(studio.siteId))!;
  ctx = await get('studio.' + HOST, '/?oys-preview=' + codePreviewToken(site, null, 'studio'));
  assert.equal(ctx.status, 200);
  // Ein Schlüssel für eine andere Adresse gilt hier nicht
  ctx = await get('studio.' + HOST, '/?oys-preview=' + codePreviewToken(site, null, 'mia-dev'));
  assert.equal(ctx.status, 404);
  // Gesperrt: 451
  await q('UPDATE code_sites SET is_published = 1, is_blocked = 1 WHERE id = ?', [studio.siteId]);
  ctx = await get('studio.' + HOST, '/');
  assert.equal(ctx.status, 451);
  await q('UPDATE code_sites SET is_blocked = 0 WHERE id = ?', [studio.siteId]);
  // Kaputte Verbindung (Handarbeit in der Datenbank): wie eine unbekannte Adresse
  const broken = await createPage(5, 'broken-slot', 'B');
  await q('UPDATE pages SET code_site_id = 999999 WHERE id = ?', [broken]);
  ctx = await get('broken-slot.' + HOST, '/');
  assert.equal(ctx.status, 404);
  assert.match(String(ctx.body), /Page not found/);
  // Eine fremde Code-Seite wird nie gezeigt
  const foreign = await codeSiteRow(6, null, { 'index.html': '<p>Tom</p>' });
  await q('UPDATE pages SET code_site_id = ? WHERE id = ?', [foreign, broken]);
  ctx = await get('broken-slot.' + HOST, '/');
  assert.equal(ctx.status, 404);
  assert.doesNotMatch(String(ctx.body), /Tom/);
  await q('UPDATE pages SET code_site_id = NULL WHERE id = ?', [broken]);
});

test('a parked link page does not exist for visitors: no views, clicks, passwords, messages, preview cards or API', async () => {
  const pageId = await createPage(6, 'tom-parked', 'Parked');
  // Hash eines Passworts, das niemand eingibt (zur Laufzeit erzeugt, kein fester Wert in der Datei)
  const lockHash = await passwordHash('parked-' + time());
  const block = async (type: string, data: unknown, protection = 'none', legacy: number | null = null): Promise<number> =>
    ((await t.admin.query("INSERT INTO page_blocks (page_id, type, position, is_visible, data, protection, password_hash, legacy_link_id, created_at) VALUES (?, ?, 9, 1, ?, ?, ?, ?, NOW())",
      [pageId, type, JSON.stringify(data), protection, protection === 'password' ? lockHash : null, legacy]))[0] as { insertId: number }).insertId;
  const link = await block('link', { title: 'Shop', url: 'https://example.com' });
  const locked = await block('link', { title: 'Secret', url: 'https://example.com/secret' }, 'password');
  const contact = await block('contact', { title: 'Write me' });
  await block('link', { title: 'Old', url: 'https://example.com/old' }, 'none', 777001);
  // Besuch aus einem Browser auf der Seite selbst (sonst zählen /_/v und /_/c ohnehin nichts)
  const own = { origin: 'http://tom-parked.' + HOST, 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36' };
  const form = (fields: Record<string, string>) => ({ 'content-type': 'application/x-www-form-urlencoded', ...own, accept: 'application/json', ...fields });
  const stats = async () => ({
    views: await count('SELECT COALESCE(SUM(views), 0) AS n FROM stats_daily WHERE page_id = ?', [pageId]),
    clicks: await count('SELECT COALESCE(SUM(clicks), 0) AS n FROM block_clicks_daily WHERE page_id = ?', [pageId]),
    messages: await count('SELECT COUNT(*) AS n FROM messages WHERE page_id = ?', [pageId]),
  });
  const ts = time() - 10;
  const token = ts + '.' + hmac(pageId + '|' + contact + '|' + ts).slice(0, 32);
  const contactPost = { b: String(contact), t: token, website: '', name: 'Visitor', email: 'v@example.org', message: 'Hello there, nice page!' };
  const visit = async () => {
    const out: Record<string, unknown> = {};
    out.v = (await get(HOST, '/_/v', { method: 'POST', post: { p: String(pageId) }, headers: form({}) })).status;
    out.c = (await get(HOST, '/_/c', { method: 'POST', post: { b: String(link) }, headers: form({}) })).status;
    const unlock = await get(HOST, '/_/unlock', { method: 'POST', post: { b: String(locked), pw: 'wrong' }, headers: form({}) });
    out.unlock = [unlock.status, JSON.parse(String(unlock.body))];
    out.go = (await get('tom-parked.' + HOST, '/_/go/' + locked)).status;
    const contactRes = await get(HOST, '/_/contact', { method: 'POST', post: contactPost, headers: form({}) });
    out.contact = [contactRes.status, JSON.parse(String(contactRes.body))];
    const contactForm = await get(HOST, '/_/contact', { method: 'POST', post: contactPost, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    out.contactForm = [contactForm.status, contactForm.header('Location')];
    const page = (await loadPage(pageId))!;
    out.og = ogSupported() ? (await get(HOST, new URL(ogUrl(page, false)).pathname)).status : 'unsupported';
    const track = await get(HOST, '/track-click', { method: 'POST', rawBody: Buffer.from(JSON.stringify({ link_id: 777001 })), headers: { 'content-type': 'application/json', 'user-agent': own['user-agent'] } });
    out.track = String(track.body);
    out.api = JSON.parse(String((await get(HOST, '/api.php?user=tom-parked')).body)).status;
    return out;
  };

  // Gezeigt: alles wie immer
  await q('DELETE FROM rate_limits');
  const shown = await visit();
  assert.equal(shown.v, 204);
  assert.deepEqual(shown.unlock, [200, { ok: false, error: 'Wrong password.' }]);
  assert.equal(shown.go, 200);
  assert.deepEqual(shown.contact, [200, { ok: true }]);
  assert.equal(shown.api, 'success');
  if (ogSupported()) assert.equal(shown.og, 200);
  const counted = await stats();
  // ein Aufruf, ein Klick über /_/c und einer über /track-click, zwei Nachrichten (JSON und Formular)
  assert.ok(counted.views === 1 && counted.clicks === 2 && counted.messages === 2, JSON.stringify(counted));

  // Geparkt (der Platz zeigt eine Code-Seite): nichts wird gezählt oder angenommen
  const siteId = await codeSiteRow(6, null, { 'index.html': '<p>code</p>' });
  await q('UPDATE pages SET code_site_id = ? WHERE id = ?', [siteId, pageId]);
  await q('DELETE FROM rate_limits');
  const parked = await visit();
  assert.deepEqual(parked, {
    v: 204,
    c: 204,
    unlock: [404, { ok: false, error: 'This link isn’t available right now.' }],
    go: 404,
    contact: [404, { ok: false, error: 'This form is no longer available.' }],
    contactForm: [302, 'http://oys.test:8080/'],
    og: ogSupported() ? 404 : 'unsupported',
    track: '{"status":"success"}',
    api: 'error',
  });
  assert.deepEqual(await stats(), counted);
});

// ---------------------------------------------------------------- Editor-API

test('the editor refuses changes to a parked link page with 409 and opens the next shown page instead', async () => {
  const { pageId } = await codeSlot(6, 'tom-studio');
  for (const [action, json] of [['save', { page_id: pageId, page: {}, blocks: [] }], ['preview', { page_id: pageId, page: {} }], ['address', { page_id: pageId, slug: 'x-new' }]] as const) {
    const res = await api(6, action, json);
    assert.equal(res.status, 409, action);
    assert.deepEqual(res.body, { ok: false, error: 'This page now shows a code page. Please reload the editor.', reload: true }, action);
  }
  const stats = await api(6, 'stats', undefined, '?page=' + pageId);
  assert.equal(stats.status, 409);
  assert.equal((await loadPage(pageId))?.slug, 'tom-studio');
  // Ohne Angabe: die erste gezeigte Link-Seite
  const tom = await one("SELECT id FROM pages WHERE slug = 'tom'");
  const res = await api(6, 'stats');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(tom);
});

test('an account whose slots all show code pages keeps its inbox, settings and page deletion', async () => {
  // Lea (7): ihre Seite und ein zweiter Platz zeigen Code-Seiten
  const leaPage = Number((await one("SELECT id FROM pages WHERE slug = 'lea'"))?.id);
  const leaSite = await codeSiteRow(7, null, { 'index.html': '<p>Lea code</p>' });
  await q('UPDATE pages SET code_site_id = ? WHERE id = ?', [leaSite, leaPage]);
  const second = await codeSlot(7, 'lea-two');
  await q("INSERT INTO messages (page_id, user_id, name, email, message, created_at) VALUES (?, 7, 'n', 'e', 'Hello Lea', NOW())", [leaPage]);
  await q("INSERT INTO notifications (user_id, type, title, created_at) VALUES (7, 'message', 'New message', NOW())");

  const messages = await api(7, 'messages');
  assert.equal(messages.status, 200);
  assert.equal((messages.body.messages as unknown[]).length, 1);
  assert.equal((await api(7, 'notifications')).status, 200);
  assert.deepEqual((await api(7, 'weekly', { enabled: true })).body, { ok: true });
  assert.equal(Number((await one('SELECT weekly_report FROM users WHERE id = 7'))?.weekly_report), 1);
  assert.deepEqual((await api(7, 'weekly-test', {})).body, { ok: false, error: 'There’s no link page to report on yet.' });
  assert.deepEqual((await api(7, 'discord', { discord_id: '123456789012345678' })).body, { ok: true });
  // Was zu einer Link-Seite gehört: wie bisher ohne Seite
  assert.deepEqual((await api(7, 'stats')).body, { ok: false, error: 'Create a page first.' });

  // Den zweiten Platz löschen: Code-Seite, Dateien und die geparkte Link-Seite verschwinden
  await q("UPDATE site_addresses SET claimed_at = ? WHERE slug = 'lea-two'", [ago(20)]);
  const del = await api(7, 'page-delete', { id: second.pageId, confirm: 'lea-two' });
  assert.deepEqual(del.body, { ok: true });
  assert.equal(await loadPage(second.pageId), null);
  assert.equal(await codeSiteById(second.siteId), null);
  assert.equal(await count('SELECT COUNT(*) AS n FROM code_files WHERE site_id = ?', [second.siteId]), 0);
  assert.equal((await q("SELECT kind, user_id FROM site_addresses WHERE slug = 'lea-two'"))[0]?.kind, 'held');
  // Der letzte Platz bleibt
  assert.deepEqual((await api(7, 'page-delete', { id: leaPage, confirm: 'lea' })).body, { ok: false, error: 'You can’t delete your last page.' });

  // Wochenbericht: nichts zu berichten – übersprungen, nicht fehlgeschlagen, für heute erledigt
  const mails: unknown[] = [];
  setReportMailerForTests(async (...args) => {
    mails.push(args[0]);
    return true;
  });
  await q('UPDATE users SET weekly_report = 0, weekly_report_sent_at = NULL WHERE id <> 7');
  await q('UPDATE users SET weekly_report_sent_at = NULL WHERE id = 7');
  assert.deepEqual(await runWeeklyReports(), { sent: 0, failed: 0, skipped: 1 });
  assert.deepEqual(mails, []);
  assert.notEqual((await one('SELECT weekly_report_sent_at FROM users WHERE id = 7'))?.weekly_report_sent_at, null);
  assert.deepEqual(await runWeeklyReports(), { sent: 0, failed: 0, skipped: 0 });
});

test('page-delete of a slot with a blocked code page is refused; the rate limit counts only successful changes', async () => {
  const blocked = await codeSlot(6, 'tom-blocked', { 'index.html': '<p>x</p>' }, { blocked: 1 });
  const text = 'This page shows a code page that has been blocked by the team. It can’t be deleted right now.';
  assert.deepEqual((await api(6, 'page-delete', { id: blocked.pageId, confirm: 'tom-blocked' })).body, { ok: false, error: text });
  assert.ok(await loadPage(blocked.pageId));
  assert.ok(await codeSiteById(blocked.siteId));
  await q('UPDATE code_sites SET is_blocked = 0 WHERE id = ?', [blocked.siteId]);
  assert.deepEqual((await api(6, 'page-delete', { id: blocked.pageId, confirm: 'tom-blocked' })).body, { ok: true });

  // Pixel (Admin, ohne Grenze für Seiten): 30 abgelehnte Versuche kosten nichts, 20 erfolgreiche Änderungen gehen
  await q("DELETE FROM rate_limits WHERE rl_key = 'slots:3'");
  for (let i = 0; i < 30; i++) {
    const res = await api(3, 'page-create', { slug: 'mia', title: 'x' });
    assert.deepEqual(res.body, { ok: false, error: 'Sorry, the address “mia” is already taken.' });
  }
  const made: number[] = [];
  for (let i = 0; i < 20; i++) {
    const res = await api(3, 'page-create', { slug: 'pixel-p' + i, title: 'P' });
    assert.equal(res.body.ok, true, JSON.stringify(res.body));
    made.push(Number(res.body.id));
  }
  assert.deepEqual((await api(3, 'page-create', { slug: 'pixel-p20', title: 'P' })).body, { ok: false, error: 'Too many changes in a short time – please wait a moment.' });
  assert.deepEqual((await api(3, 'page-delete', { id: made[0], confirm: 'pixel-p0' })).body, { ok: false, error: 'Too many changes in a short time – please wait a moment.' });
  assert.equal(await count("SELECT COUNT(*) AS n FROM pages WHERE slug = 'pixel-p20'"), 0);
  // Aufräumen (ohne die Begrenzung)
  await q(`DELETE FROM page_blocks WHERE page_id IN (${made.join(',')})`);
  await q(`DELETE FROM pages WHERE id IN (${made.join(',')})`);
  await q("DELETE FROM site_addresses WHERE slug LIKE 'pixel-p%'");
  await q("DELETE FROM rate_limits WHERE rl_key = 'slots:3'");
});

test('page slots: code pages count against the allowance, also when many requests arrive at once', async () => {
  // Nutzer 8 hat noch keine Seite: drei Plätze (einer zeigt eine Code-Seite), dann ist Schluss
  await q("DELETE FROM rate_limits WHERE rl_key = 'slots:8'");
  await codeSlot(8, 'nn-code');
  const parallel = await Promise.all(Array.from({ length: 6 }, (_v, i) => api(8, 'page-create', { slug: 'nn-par' + i, title: 'N' })));
  const ok = parallel.filter((r) => r.body.ok === true);
  const refused = parallel.filter((r) => r.body.ok !== true);
  assert.equal(ok.length, 2, JSON.stringify(parallel.map((r) => r.body)));
  for (const r of refused) assert.deepEqual(r.body, { ok: false, error: 'You can create up to 3 pages.' });
  assert.equal(await count('SELECT COUNT(*) AS n FROM pages WHERE user_id = 8'), 3);

  // Zehn Konten wollen dieselbe vergebene Adresse – alle bekommen die Meldung, nichts entsteht
  const users: number[] = [];
  for (let i = 0; i < 10; i++) {
    const res = (await t.admin.query("INSERT INTO users (email, password, full_name) VALUES (?, 'x', 'Racer')", [`racer${i}@example.org`]))[0] as { insertId: number };
    users.push(res.insertId);
  }
  const started = Date.now();
  const raced = await Promise.all(users.map((uid) => api(uid, 'page-create', { slug: 'mia', title: 'x' })));
  assert.ok(Date.now() - started < 10000);
  for (const r of raced) assert.deepEqual(r.body, { ok: false, error: 'Sorry, the address “mia” is already taken.' });
  assert.equal(await count(`SELECT COUNT(*) AS n FROM pages WHERE user_id IN (${users.join(',')})`), 0);
  // … und um eine freie Adresse: genau einer bekommt sie
  const free = await Promise.all(users.map((uid) => api(uid, 'page-create', { slug: 'race-free', title: 'x' })));
  assert.equal(free.filter((r) => r.body.ok === true).length, 1);
  for (const r of free.filter((x) => x.body.ok !== true)) assert.deepEqual(r.body, { ok: false, error: 'Sorry, the address “race-free” is already taken.' });
  assert.equal(await count("SELECT COUNT(*) AS n FROM pages WHERE slug = 'race-free'"), 1);
  assert.equal(await count("SELECT COUNT(*) AS n FROM site_addresses WHERE slug = 'race-free' AND kind = 'page'"), 1);
});

test('a slot change waits at most about 3 s for the account lock and then answers busy', async () => {
  const uid = ((await t.admin.query("INSERT INTO users (email, password, full_name) VALUES ('busy@example.org', 'x', 'Busy')"))[0] as { insertId: number }).insertId;
  const other: Connection = await adminConnection();
  try {
    await other.query('USE `' + t.name + '`');
    await other.query('START TRANSACTION');
    await other.query('SELECT id FROM users WHERE id = ? FOR UPDATE', [uid]);
    const started = Date.now();
    const res = await api(uid, 'page-create', { slug: 'busy-page', title: 'x' });
    const waited = Date.now() - started;
    assert.deepEqual(res.body, { ok: false, error: SLOT_BUSY_TEXT, busy: true });
    assert.ok(waited >= 2500 && waited < 15000, 'waited ' + waited + ' ms');
    await other.query('ROLLBACK');
  } finally {
    await other.end();
  }
  assert.equal(await count("SELECT COUNT(*) AS n FROM pages WHERE slug = 'busy-page'"), 0);
  // Danach geht es wieder
  const res = await api(uid, 'page-create', { slug: 'busy-page', title: 'x' });
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
});

test('the slot lock retries a deadlock once and maps lock trouble to busy; a deleted account is gone', async () => {
  const deadlock = () => Object.assign(new Error('Deadlock found when trying to get lock'), { errno: 1213, code: 'ER_LOCK_DEADLOCK' });
  const timeout = () => Object.assign(new Error('Lock wait timeout exceeded'), { errno: 1205, code: 'ER_LOCK_WAIT_TIMEOUT' });
  let calls = 0;
  assert.equal(await withSlotLock(6, async (_db, user) => {
    if (calls++ === 0) throw deadlock();
    return Number(user.id);
  }), 6);
  assert.equal(calls, 2);
  await assert.rejects(withSlotLock(6, async () => { throw deadlock(); }), SlotBusyError);
  await assert.rejects(withSlotLock(6, async () => { throw timeout(); }), SlotBusyError);
  await assert.rejects(withSlotLock(999999, async () => 'never'), SlotGoneError);
  await assert.rejects(withSlotLock(6, async () => { throw new Error('other'); }), /other/);
  // Was in fn geschrieben wurde, ist nach einem Fehler zurückgerollt
  await assert.rejects(withSlotLock(6, async (db) => {
    await db.exec("UPDATE users SET full_name = 'changed' WHERE id = 6");
    throw new Error('stop');
  }), /stop/);
  assert.notEqual((await one('SELECT full_name FROM users WHERE id = 6'))?.full_name, 'changed');
});

// ---------------------------------------------------------------- Uploads, Konto löschen

test('uploads used by any code page stay; deleting a code slot removes what only it used', async () => {
  const file = (n: number) => `img_5_${1700000100 + n}_${(0xabcdef00 + n).toString(16)}.png`;
  const [ownImg, slotImg, unused] = [file(1), file(2), file(3)];
  for (const f of [ownImg, slotImg, unused]) writeFileSync(join(t.uploads, f), 'x');
  const own = await one("SELECT id FROM code_sites WHERE slug = 'mia-dev'");
  await q("INSERT INTO code_files (site_id, path, content, updated_at) VALUES (?, 'img.html', ?, NOW())", [Number(own?.id), `<img src="/static/uploads/${ownImg}">`]);
  const slot = await codeSlot(5, 'mia-gallery', { 'index.html': `<img src="${slotImg}">` });
  const used = await codeUsedUploads(5);
  assert.ok(used.has(ownImg) && used.has(slotImg) && !used.has(unused), JSON.stringify([...used]));
  await cleanupFiles(5, [ownImg, slotImg, unused]);
  assert.ok(existsSync(join(t.uploads, ownImg)) && existsSync(join(t.uploads, slotImg)));
  assert.ok(!existsSync(join(t.uploads, unused)));
  // Den Platz löschen: das Bild, das nur seine Code-Seite benutzte, geht mit; das der anderen bleibt
  assert.deepEqual((await api(5, 'page-delete', { id: slot.pageId, confirm: 'mia-gallery' })).body, { ok: true });
  assert.ok(!existsSync(join(t.uploads, slotImg)));
  assert.ok(existsSync(join(t.uploads, ownImg)));
});

test('deleting an account removes every code page, its files and moderation rows, and holds the addresses for nobody', async () => {
  const before = await count('SELECT COUNT(*) AS n FROM code_sites WHERE user_id = 5');
  assert.ok(before >= 2, String(before));
  await q("INSERT INTO code_moderation (site_id, user_id, admin_id, action, address, reason, created_at) VALUES (NULL, 5, 3, 'block', 'studio.oys.test', 'x', NOW())");
  await q("UPDATE site_addresses SET claimed_at = ? WHERE user_id = 5", [ago(100)]);
  await deleteUser(5);
  assert.equal(await count('SELECT COUNT(*) AS n FROM code_sites WHERE user_id = 5'), 0);
  assert.equal(await count('SELECT COUNT(*) AS n FROM code_files f LEFT JOIN code_sites s ON s.id = f.site_id WHERE s.id IS NULL'), 0);
  assert.equal(await count('SELECT COUNT(*) AS n FROM code_moderation WHERE user_id = 5'), 0);
  assert.equal(await count('SELECT COUNT(*) AS n FROM pages WHERE user_id = 5'), 0);
  for (const slug of ['studio', 'mia-dev', 'mia']) {
    const row = (await q('SELECT kind, user_id FROM site_addresses WHERE slug = ?', [slug]))[0];
    assert.deepEqual({ ...row }, { kind: 'held', user_id: null }, slug);
  }
  // Wochenbericht und Konto: nichts zeigt mehr auf die gelöschten Code-Seiten
  assert.equal(await count('SELECT COUNT(*) AS n FROM pages WHERE code_site_id IS NOT NULL AND code_site_id NOT IN (SELECT id FROM code_sites)'), 0);
});

test('sites:repair recounts code page files and reports pages without an address and broken slots', async () => {
  const { codeRepair } = await import('../src/code/sites.js');
  const lost = await codeSiteRow(6, null, { 'index.html': '<p>lost</p>' });
  const tomPage = await createPage(6, 'tom-broken', 'x');
  await q('UPDATE pages SET code_site_id = 888888 WHERE id = ?', [tomPage]);
  await q('UPDATE code_sites SET file_count = 9, bytes = 9 WHERE id = ?', [lost]);
  const report = await transaction((_c, db) => codeRepair(db));
  assert.ok(report.recounted >= 1);
  assert.ok(report.anomalies.some((a) => a.startsWith(`No address: code page #${lost} of user #6`)), report.anomalies.join('\n'));
  assert.ok(report.anomalies.some((a) => a.includes(`(tom-broken) shows code page #888888, which doesn’t exist`)), report.anomalies.join('\n'));
  const fixed = (await q('SELECT file_count, bytes FROM code_sites WHERE id = ?', [lost]))[0];
  assert.deepEqual({ ...fixed }, { file_count: 1, bytes: 11 });
  assert.equal((await transaction((_c, db) => codeRepair(db))).recounted, 0);
  await q('UPDATE pages SET code_site_id = NULL WHERE id = ?', [tomPage]);
});

test('the dashboard tells the editor the page allowance', async () => {
  for (const [uid, unlimited] of [[6, false], [3, true]] as const) {
    const sid = await loginSession(uid);
    const ctx = makeTestCtx({ url: '/dashboard', host: HOST, cookies: { PHPSESSID: sid } });
    await Session.start(ctx);
    await runRequest(ctx, appRoutes);
    const m = /"maxPages":(\d+),"premium":(true|false),"pagesUnlimited":(true|false)/.exec(String(ctx.body));
    assert.ok(m, 'bootstrap keys');
    assert.equal(m[1], '3');
    assert.equal(m[3], String(unlimited));
  }
});
