// Admin: Honigwaben und Code-Seiten als getrennte Bereiche. Verteiler (code_action, alte hc_action=code_*-Formulare,
// Reihenfolge, CSRF), die Seite mit zwei Einträgen in der Navigation, Zugriff nur für Admins und freigegebene
// Schnappschüsse beider Bereiche (test/snapshots; neu schreiben mit OYS_UPDATE_SNAPSHOTS=1).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { setConfigForTests, type ConfigData } from '../src/config.js';
import { closePool, one, q } from '../src/db.js';
import { Ctx, makeTestCtx, isHalt } from '../src/web/ctx.js';
import { Session } from '../src/web/session.js';
import { adminPage } from '../src/admin/page.js';
import { appRoutes } from '../src/app/dispatch.js';
import { setEmailDirForTests } from '../src/admin/newsletter.js';
import { adminHoneycombsView } from '../src/honeycombs/adminView.js';
import { adminCodePagesView } from '../src/code/adminView.js';
import { legacyCodePost } from '../src/code/admin.js';
import type { PhpArray } from '../src/php.js';
import { BASE, adminConnection, freshDb, restoreDb } from './hcHarness.js';

const SOURCE = String((BASE.db as ConfigData).name ?? 'oys_test').replace(/[^a-z0-9_]/gi, '');
const DB = SOURCE + '_split';
const SNAPSHOTS = join(dirname(fileURLToPath(import.meta.url)), 'snapshots');
const mailDir = mkdtempSync(join(tmpdir(), 'oys-split-mail-'));
let admin: Connection;

function fixture(): Array<[string, unknown[]]> {
  const user = 'INSERT INTO users (id, email, password, full_name, username, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)';
  const page = 'INSERT INTO pages (id, user_id, slug, position, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)';
  const ledger = 'INSERT INTO honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (?, ?, ?, ?, ?, ?)';
  const site = 'INSERT INTO code_sites (id, user_id, slug, title, is_published, is_blocked, blocked_reason, views, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
  const file = 'INSERT INTO code_files (site_id, path, content, updated_at) VALUES (?, ?, ?, ?)';
  const t = '2026-10-01 10:00:00';
  return [
    [user, [3, 'admin@test.de', 'h', 'Pixel Admin', 'pixel', 1, t]],
    [user, [5, 'mia@test.de', 'h', 'Mia Müller', 'mia', 0, t]],
    [user, [6, 'tom@test.de', 'h', null, 'tom', 0, t]],
    [user, [7, 'lea@test.de', 'h', '', 'lea', 0, t]],
    [user, [10, 'Quote@Test.de', 'h', "O'Brien <b>& “Co”", 'quote', 0, t]],
    [page, [1, 3, 'pixel', 0, 'Pixel', t, t]],
    [page, [2, 5, 'mia', 0, 'Mia', t, t]],
    [page, [3, 6, 'tom', 0, 'Tom', t, t]],
    [ledger, [5, 150, 'admin', 'a3-1111111111111111', 'Welcome', '2026-10-02 09:00:00']],
    [ledger, [5, -100, 'unlock', 'code_page', '', '2026-10-02 09:30:00']],
    [ledger, [6, 0, 'unlock', 'code_page', 'Unlocked by the team', '2026-10-03 11:00:00']],
    [ledger, [3, 500, 'admin', 'a3-3333333333333333', 'Start', '2026-10-04 08:15:00']],
    [ledger, [7, 5, 'daily', '2026-10-05', '', '2026-10-05 07:00:00']],
    [site, [1, 5, 'miacode', 'Mia Code', 1, 0, null, 1234, t, '2026-10-05 10:00:00']],
    [site, [2, 6, 'tomcode', 'Tom', 1, 1, 'Spam <b>', 3, t, '2026-10-04 10:00:00']],
    [site, [3, 10, 'quotecode', '<script>alert(1)</script>', 0, 0, null, 0, t, '2026-10-03 10:00:00']],
    [file, [1, 'index.html', '<p>Mia</p>', t]],
    [file, [1, 'style.css', 'p{color:red}', t]],
    [file, [2, 'index.html', 'x'.repeat(1536), t]],
    // Zähler wie im Betrieb (codeWrite pflegt sie; die Liste liest nur sie)
    ['UPDATE code_sites s SET file_count = (SELECT COUNT(*) FROM code_files f WHERE f.site_id = s.id), bytes = (SELECT COALESCE(SUM(LENGTH(f.content)), 0) FROM code_files f WHERE f.site_id = s.id)', []],
  ];
}

// Feste Werte für die Schnappschüsse: Adresse, Schema und Zeitzone hängen sonst von der Konfiguration ab
const CONFIG: ConfigData = { ...BASE, base_domain: 'oys.test:8080', scheme: 'http', timezone: 'Europe/Berlin', db: { ...(BASE.db as ConfigData), name: DB } };

async function reset(): Promise<void> {
  await freshDb(admin, DB, fixture());
  await closePool();
  setConfigForTests(CONFIG);
}

before(async () => {
  admin = await adminConnection();
  await reset();
  mkdirSync(mailDir, { recursive: true });
  setEmailDirForTests(mailDir);
});

after(async () => {
  setEmailDirForTests(null);
  await restoreDb();
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.end();
  rmSync(mailDir, { recursive: true, force: true });
});

// Angemeldete Sitzung (mit CSRF-Token) für ein Konto
async function sessionFor(userId: number): Promise<{ id: string; csrf: string }> {
  const ctx = makeTestCtx({ url: '/admin' });
  const s = await Session.start(ctx);
  s.set('user_id', userId);
  s.set('csrf', 'c'.repeat(64));
  await s.close();
  return { id: s.id, csrf: 'c'.repeat(64) };
}

// /admin als Admin (id 3): POST mit CSRF-Feld (außer withCsrf = false) oder GET; Sitzung danach speichern
async function request(form: PhpArray | null, withCsrf = true, query = ''): Promise<Ctx> {
  const s = await sessionFor(3);
  const ctx = form === null
    ? makeTestCtx({ url: '/admin' + query, cookies: { PHPSESSID: s.id } })
    : makeTestCtx({ method: 'POST', url: '/admin', cookies: { PHPSESSID: s.id }, post: withCsrf ? { csrf: s.csrf, ...form } : form });
  await Session.start(ctx);
  const user = (await one('SELECT * FROM users WHERE id = 3'))!;
  try {
    await adminPage(ctx, user);
  } catch (err) {
    if (!isHalt(err)) throw err;
  } finally {
    await ctx.session?.close();
  }
  return ctx;
}

// Ein Bereich der Admin-Seite: vom <div id="tab-…"> bis vor den nächsten Bereich
function section(page: string, id: string): string {
  const start = page.indexOf(`<div id="tab-${id}"`);
  assert.ok(start > 0, 'section ' + id);
  const next = page.indexOf('<div id="tab-', start + 1);
  return page.slice(start, next < 0 ? undefined : next);
}

const site = (id: number) => one('SELECT is_blocked, blocked_reason FROM code_sites WHERE id = ?', [id]);

test('old forms: hc_action=code_* becomes the matching code_action, every other action stays with the honeycombs', () => {
  assert.deepEqual(legacyCodePost({ hc_action: 'code_block', site_id: '7', reason: 'Spam', csrf: 'x' }), { site_id: '7', reason: 'Spam', csrf: 'x', code_action: 'block' });
  assert.deepEqual(legacyCodePost({ hc_action: 'code_unblock', site_id: '7' }), { site_id: '7', code_action: 'unblock' });
  assert.deepEqual(legacyCodePost({ hc_action: 'code_unlock', user_id: '5', item: 'other' }), { user_id: '5', item: 'code_page', code_action: 'unlock' });
  for (const action of ['settings', 'grant', 'code_settings', 'Code_block', 'code_block ', '', 'toString', '__proto__']) {
    assert.equal(legacyCodePost({ hc_action: action }), null, action);
  }
  assert.equal(legacyCodePost({ hc_action: { 0: 'code_block' } }), null);
  assert.equal(legacyCodePost({ code_action: 'block' }), null);
});

test('approved snapshots of the Honeycombs and Code pages sections', async () => {
  const ctx = new Ctx({ method: 'GET', url: '/admin', headers: { host: 'oys.test:8080' }, peer: '127.0.0.1' });
  ctx.session = { get: (k: string) => (k === 'csrf' ? 'CSRFTOKEN' : undefined), set: () => undefined } as unknown as Ctx['session'];
  // Honeycombs: der Unterbereich „Users“ (vergeben, Kontostände) – die Übersicht zählt die letzten 30 Tage und hängt
  // damit vom Datum ab (hc-admin.http.test.ts prüft sie)
  const usersCtx = new Ctx({ method: 'GET', url: '/admin?hc_tab=users', headers: { host: 'oys.test:8080' }, peer: '127.0.0.1' });
  usersCtx.session = ctx.session;
  const users = await q('SELECT id, full_name, email, username, discord_id, is_admin, created_at FROM users ORDER BY id DESC');
  const views = {
    'admin-honeycombs.html': (await adminHoneycombsView(usersCtx, users)).replace(/name="grant_ref" value="[0-9a-f]{16}"/, 'name="grant_ref" value="REF"'),
    'admin-code-pages.html': await adminCodePagesView(ctx, users),
  };
  for (const [name, htmlOut] of Object.entries(views)) {
    const file = join(SNAPSHOTS, name);
    if (process.env.OYS_UPDATE_SNAPSHOTS === '1') {
      mkdirSync(SNAPSHOTS, { recursive: true });
      writeFileSync(file, htmlOut);
    }
    assert.equal(htmlOut, readFileSync(file, 'utf8'), name + ' differs from the approved snapshot (OYS_UPDATE_SNAPSHOTS=1 writes it)');
  }
  const code = views['admin-code-pages.html'];
  // Nutzertext immer maskiert
  assert.ok(code.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !code.includes('<script>alert(1)'));
  assert.ok(code.includes('O&#039;Brien &lt;b&gt;&amp; “Co”') && code.includes('Reason: Spam &lt;b&gt;'));
  // Zugang: bezahlt, geschenkt, noch nicht freigeschaltet (mit Formular), Konten ohne Code-Seite und Freischaltung fehlen
  assert.match(code, /mia@test\.de[\s\S]*?miacode\.oys\.test:8080[\s\S]*?Paid 100/);
  assert.match(code, /tom@test\.de[\s\S]*?tomcode\.oys\.test:8080[\s\S]*?>Free</);
  assert.match(code, /Quote@Test\.de<\/span><\/td>[\s\S]*?quotecode[\s\S]*?name="user_id" value="10"/);
  const access = code.slice(code.indexOf('id="codeAccessRows"'));
  assert.ok(!access.includes('lea@test.de') && !access.includes('admin@test.de'));
  assert.match(code, /<span class="text-gray-500 text-sm font-normal">3<\/span><\/h2>\n {24}<input type="search" id="codeAccessFilter"/);
  // Preis aus den Honigwaben-Regeln, Link dorthin
  assert.match(code, /id="codePrice">100 <i class='bx bx-hive/);
  assert.ok(code.includes('<a href="/admin?hc_tab=catalogue#honeycombs"'));
});

test('GET /admin: two nav entries and two sections; nothing about code pages is left in Honeycombs', async () => {
  const ctx = await request(null);
  assert.equal(ctx.status, 200);
  const page = String(ctx.body);
  assert.ok(page.endsWith('</html>'));
  assert.match(page, /id="nav-honeycombs"[^>]*>\n {20}<i class='bx bx-hive text-xl text-yellow-400'><\/i> <span class="hidden lg:block text-sm">Honeycombs<\/span>/);
  assert.match(page, /onclick="switchAdminTab\('code-pages'\)" id="nav-code-pages"[^>]*>\n {20}<i class='bx bx-code-alt text-xl'><\/i> <span class="hidden lg:block text-sm">Code pages<\/span>/);
  assert.ok(!page.includes('Honeycombs &amp; code pages') && !page.includes('Honeycombs & code pages'));
  assert.match(page, /honeycombs: \['Honeycombs', 'border-yellow-500\/30 bg-yellow-500\/10 text-yellow-400'\],\n {12}'code-pages': \['Code pages', 'border-brand-500\/30 bg-brand-500\/10 text-brand-400'\],/);
  // Honigwaben-Symbole gelb, das Logo bleibt in der Markenfarbe
  assert.deepEqual([...new Set(page.match(/bx-hive[^']*/g))].sort(), ['bx-hive text-2xl text-yellow-400', 'bx-hive text-xl text-white', 'bx-hive text-xl text-yellow-400', 'bx-hive text-yellow-400']);
  assert.match(page, /from-brand-500 to-purple-600[^>]*>\n {20}<i class='bx bx-hive text-xl text-white'><\/i>/);
  // Reihenfolge der Bereiche: … Community, Honeycombs, Code pages, Storage
  const order = ['tab-community', 'tab-honeycombs', 'tab-code-pages', 'tab-storage'].map((id) => page.indexOf(`<div id="${id}"`));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(order.every((i) => i > 0));
  const hc = section(page, 'honeycombs');
  assert.doesNotMatch(hc, /code_action|hc_action" value="code_|bx-code-alt|miacode|Unlock for free/);
  // Unterbereiche (HC-5): ohne hc_tab die Übersicht mit den letzten Buchungen; vergeben und Kontostände unter „Users“,
  // die Regeln unter „Earning rules“
  assert.ok(hc.includes('Latest activity') && hc.includes('In circulation') && !hc.includes('Give honeycombs'));
  const usersTab = section(String((await request(null, true, '?hc_tab=users')).body), 'honeycombs');
  assert.doesNotMatch(usersTab, /code_action|hc_action" value="code_|bx-code-alt|miacode|Code page|Unlock for free/);
  assert.ok(usersTab.includes('Give honeycombs') && usersTab.includes('Balances'));
  assert.ok(section(String((await request(null, true, '?hc_tab=rules')).body), 'honeycombs').includes('How users earn them'));
  const code = section(page, 'code-pages');
  assert.ok(code.includes('Give code access') && code.includes('Prices') && code.includes('Access') && code.includes('Rules for code pages'));
  assert.equal(code.match(/name="code_action" value="block"/g)?.length, 2);
  assert.equal(code.match(/name="code_action" value="unblock"/g)?.length, 1);
  assert.ok(!code.includes('hc_action'));
  // Admin-Bereich bleibt privat
  assert.ok(page.includes('<meta name="robots" content="noindex, nofollow">'));
});

test('code_action: block, unblock and unlock answer with their message on #code-pages', async () => {
  let ctx = await request({ code_action: 'block', site_id: '1', reason: '  Selling <b>stuff</b>  ' });
  assert.equal(ctx.header('Location'), '/admin#code-pages');
  assert.equal(ctx.session!.data.admin_success, '“miacode” is blocked.');
  assert.deepEqual(await site(1), { is_blocked: 1, blocked_reason: 'Selling <b>stuff</b>' });

  ctx = await request({ code_action: 'unblock', site_id: '1' });
  assert.equal(ctx.session!.data.admin_success, '“miacode” is online again.');
  assert.deepEqual(await site(1), { is_blocked: 0, blocked_reason: null });

  ctx = await request({ code_action: 'block', site_id: '99' });
  assert.equal(ctx.header('Location'), '/admin#code-pages');
  assert.equal(ctx.session!.data.admin_error, 'Code page not found.');

  ctx = await request({ code_action: 'unlock', user_id: '7', item: 'code_page' });
  assert.equal(ctx.session!.data.admin_success, 'Code page unlocked for lea@test.de.');
  assert.deepEqual(await one("SELECT amount, note FROM honeycomb_ledger WHERE user_id = 7 AND reason = 'unlock' AND ref = 'code_page'"), { amount: 0, note: 'Unlocked by the team' });
  ctx = await request({ code_action: 'unlock', user_id: '7', item: 'code_page' });
  assert.equal(ctx.session!.data.admin_success, 'lea@test.de had already unlocked the code page.');

  // Seit CS-5 lässt sich auch „More code pages“ schenken; ein unbekannter Eintrag nicht
  ctx = await request({ code_action: 'unlock', user_id: '10', item: 'code_more' });
  assert.match(String(ctx.session!.data.admin_success), /^More code pages unlocked for /);
  ctx = await request({ code_action: 'unlock', user_id: '10', item: 'nope' });
  assert.equal(ctx.session!.data.admin_error, 'Please choose what to unlock.');
  ctx = await request({ code_action: 'unlock', user_id: '999', item: 'code_page' });
  assert.equal(ctx.session!.data.admin_error, 'Please choose a user.');
  // Nur die Freischaltung von „More code pages“ für 10, nichts für die unbekannten Einträge
  assert.equal((await q("SELECT id FROM honeycomb_ledger WHERE user_id IN (10, 999) AND reason = 'unlock' AND ref <> 'code_more'")).length, 0);

  // Unbekannte Aktion: zurück zum Bereich, ohne Meldung
  ctx = await request({ code_action: 'nope' });
  assert.equal(ctx.header('Location'), '/admin#code-pages');
  assert.equal(ctx.session!.data.admin_success, undefined);
  assert.equal(ctx.session!.data.admin_error, undefined);
});

test('old forms (hc_action=code_*) still work and land on #code-pages; the honeycomb actions stay on #honeycombs', async () => {
  let ctx = await request({ hc_action: 'code_block', site_id: '3', reason: 'Old tab' });
  assert.equal(ctx.header('Location'), '/admin#code-pages');
  assert.equal(ctx.session!.data.admin_success, '“quotecode” is blocked.');
  assert.deepEqual(await site(3), { is_blocked: 1, blocked_reason: 'Old tab' });
  ctx = await request({ hc_action: 'code_unblock', site_id: '3' });
  assert.equal(ctx.session!.data.admin_success, '“quotecode” is online again.');
  ctx = await request({ hc_action: 'code_unlock', user_id: '10' });
  assert.equal(ctx.header('Location'), '/admin#code-pages');
  assert.equal(ctx.session!.data.admin_success, 'Code page unlocked for O\'Brien <b>& “Co”.');

  ctx = await request({ hc_action: 'settings', daily: '7' });
  assert.equal(ctx.header('Location'), '/admin?hc_tab=rules#honeycombs');
  assert.equal(ctx.session!.data.admin_success, 'Honeycomb settings saved.');
  ctx = await request({ hc_action: 'nope' });
  assert.equal(ctx.header('Location'), '/admin#honeycombs');
  assert.equal(ctx.session!.data.admin_success, undefined);
});

test('dispatch order (community → honeycombs → code pages → updates) and CSRF', async () => {
  let ctx = await request({ hc_action: 'nope', code_action: 'block', site_id: '2' });
  assert.equal(ctx.header('Location'), '/admin#honeycombs');
  ctx = await request({ code_action: 'nope', oys_action: 'nope', save_smtp: '1' });
  assert.equal(ctx.header('Location'), '/admin#code-pages');
  ctx = await request({ community_action: 'nope', code_action: 'block', site_id: '2' });
  assert.equal(ctx.header('Location'), '/admin#community');
  ctx = await request({ storage_action: 'nope', code_action: 'block', site_id: '2' });
  assert.equal(ctx.header('Location'), '/admin#storage');
  assert.deepEqual(await site(2), { is_blocked: 1, blocked_reason: 'Spam <b>' });

  // Ohne CSRF-Feld ändert sich nichts
  for (const form of [{ code_action: 'unblock', site_id: '2' }, { hc_action: 'code_unblock', site_id: '2' }, { code_action: 'unlock', user_id: '3' }]) {
    ctx = await request(form, false);
    assert.equal(ctx.header('Location'), '/admin');
    assert.equal(ctx.session!.data.admin_error, 'Session expired – please try again.');
  }
  assert.deepEqual(await site(2), { is_blocked: 1, blocked_reason: 'Spam <b>' });
  assert.equal(await one("SELECT id FROM honeycomb_ledger WHERE user_id = 3 AND reason = 'unlock'"), null);
});

test('only admins reach /admin: a user is sent to the dashboard, a visitor to the login', async () => {
  const s = await sessionFor(5);
  for (const method of ['GET', 'POST']) {
    const ctx = makeTestCtx({ method, url: '/admin', cookies: { PHPSESSID: s.id }, post: { csrf: s.csrf, code_action: 'block', site_id: '1' } });
    try {
      await appRoutes(ctx);
    } catch (err) {
      if (!isHalt(err)) throw err;
    } finally {
      await ctx.session?.close();
    }
    assert.equal(ctx.status, 302);
    assert.equal(ctx.header('Location'), '/dashboard');
  }
  const anon = makeTestCtx({ method: 'POST', url: '/admin', post: { code_action: 'unblock', site_id: '2' } });
  try {
    await appRoutes(anon);
  } catch (err) {
    if (!isHalt(err)) throw err;
  } finally {
    await anon.session?.close();
  }
  assert.equal(anon.header('Location'), '/login');
  assert.deepEqual(await site(1), { is_blocked: 0, blocked_reason: null });
  assert.deepEqual(await site(2), { is_blocked: 1, blocked_reason: 'Spam <b>' });
});

// Datenbank-Zustand nach allen Tests: nur die erwarteten Freischaltungen
test('ledger after the admin actions: one free unlock each, nothing paid', async () => {
  const rows = await admin.query<RowDataPacket[]>(`SELECT user_id, amount, note FROM \`${DB}\`.honeycomb_ledger WHERE reason = 'unlock' AND ref = 'code_page' ORDER BY user_id`);
  assert.deepEqual(rows[0].map((r) => ({ ...r })), [
    { user_id: 5, amount: -100, note: '' },
    { user_id: 6, amount: 0, note: 'Unlocked by the team' },
    { user_id: 7, amount: 0, note: 'Unlocked by the team' },
    { user_id: 10, amount: 0, note: 'Unlocked by the team' },
  ]);
  await reset();
});
