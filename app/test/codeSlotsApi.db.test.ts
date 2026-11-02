// Editor-API der Code-Seiten auf Seitenplätzen (CS-4, noch ruhend: max_on_pages ist 0, bis die Moderation da ist):
// Pflichtfeld site (409 für alte Tabs), fremde Code-Seiten, CSRF, die Regeln E1–E8 über HTTP, code-connect,
// code-move in beide Richtungen, code-delete, code-unlock für code_more und gleichzeitige Anfragen unter der
// Platz-Sperre. Strenger Schalter: eine zweite Verbindung innerhalb der Sperre fällt auf.
process.env.OYS_DB_STRICT = '1';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { makeTestCtx } from '../src/web/ctx.js';
import { appRoutes } from '../src/app/dispatch.js';
import { saveCodeSettings } from '../src/code/settings.js';
import { CSRF, loginSession, runRequest, testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
const q = async (s: string, p: unknown[] = []): Promise<RowDataPacket[]> => (await t.admin.query<RowDataPacket[]>(s, p))[0];
const HOST = 'oys.test:8080';
const STALE = { ok: false, error: 'This tab is out of date. Please reload the editor.', reload: true };
const GONE = { ok: false, error: 'This code page no longer exists. Please reload the editor.', reload: true };

before(async () => {
  t = await testDatabase('cs4api');
  await t.admin.query('USE `' + t.name + '`');
  // Mia (5) und Tom (6) haben Code-Seiten freigeschaltet und die Regeln akzeptiert; Lea (7) nicht
  await q("INSERT INTO honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (5, 0, 'unlock', 'code_page', '', NOW()), (6, 0, 'unlock', 'code_page', '', NOW())");
  await q('UPDATE users SET code_terms_at = NOW() WHERE id IN (5, 6)');
});

after(async () => {
  await t.done();
});

async function api(userId: number, action: string, json?: unknown, opts: { query?: string; csrf?: string; impersonatedBy?: number } = {}):
  Promise<{ status: number; body: Record<string, unknown> }> {
  const sid = await loginSession(userId, opts.impersonatedBy !== undefined ? { impersonatedBy: opts.impersonatedBy } : {});
  const post = json !== undefined;
  const ctx = makeTestCtx({
    method: post ? 'POST' : 'GET',
    url: '/dashboard/api/' + action + (opts.query ?? ''),
    host: HOST,
    headers: post ? { 'content-type': 'application/json', 'x-csrf-token': opts.csrf ?? CSRF } : {},
    cookies: { PHPSESSID: sid },
    rawBody: post ? Buffer.from(JSON.stringify(json)) : undefined,
  });
  await runRequest(ctx, appRoutes);
  return { status: ctx.status, body: JSON.parse(String(ctx.body)) as Record<string, unknown> };
}

const n = async (sql: string, p: unknown[] = []): Promise<number> => Number(Object.values((await q(sql, p))[0])[0]);
const siteId = (b: Record<string, unknown>): number => (b.site as { id: number }).id;
const pageOf = async (slug: string): Promise<number> => n('SELECT id FROM pages WHERE slug = ?', [slug]);
async function resetRates(): Promise<void> {
  await q("DELETE FROM rate_limits WHERE rl_key LIKE 'slots:%'");
}

test('default max_on_pages 0: nothing on page slots is reachable, the own address still works', async () => {
  let r = await api(6, 'code-connect', { slot: await pageOf('tom'), title: 'X' });
  assert.deepEqual(r.body, { ok: false, error: 'Code pages can’t use your page addresses right now.' });
  r = await api(6, 'code-connect', { slot: 'new', slug: 'tom-new-code', title: 'X' });
  assert.deepEqual(r.body, { ok: false, error: 'Code pages can’t use your page addresses right now.' });
  assert.equal(await n("SELECT COUNT(*) FROM pages WHERE slug = 'tom-new-code'"), 0);
  assert.equal(await n('SELECT COUNT(*) FROM code_sites WHERE user_id = 6'), 0);
  r = await api(6, 'code-create', { slug: 'tom-lab', title: 'Lab' });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const s = r.body.site as Record<string, unknown>;
  assert.equal(s.kind, 'own');
  assert.equal(s.slot, null);
  assert.equal(s.days_left, 0);
  assert.deepEqual(s.limits, { files: 30, file: 262144, total: 2097152, types: (s.limits as { types: string[] }).types });
  assert.deepEqual(r.body.slots, { pages: { used: 1, max: 3, unlimited: false }, own: { used: 1, max: 1 }, onPages: { used: 0, max: 0 } });
  assert.deepEqual(r.body.more, { unlocked: true, cost: 0 });
  assert.equal(r.body.banned, null);
  assert.equal(r.body.paused, false);
  // E4: eine zweite eigene Adresse
  r = await api(6, 'code-create', { slug: 'tom-lab-two', title: 'Lab' });
  assert.deepEqual(r.body, { ok: false, error: 'You already have a code page with its own address.' });
});

test('stale tabs: site is required on save, address, move and delete; unknown or foreign ids answer 409', async () => {
  const mine = await n("SELECT id FROM code_sites WHERE slug = 'tom-lab'");
  for (const action of ['code-save', 'code-address', 'code-move', 'code-delete']) {
    let r = await api(6, action, { slug: 'tom-x', files: {}, deleted: [], confirm: 'tom-lab' });
    assert.equal(r.status, 409, action);
    assert.deepEqual(r.body, STALE, action);
    for (const bad of [0, -3, 'abc', [mine], { id: mine }]) {
      r = await api(6, action, { site: bad, slug: 'tom-x', files: {}, deleted: [], confirm: 'tom-lab' });
      assert.equal(r.status, 409, action + ' ' + JSON.stringify(bad));
      assert.deepEqual(r.body, STALE, action);
    }
    // Eine Code-Seite eines anderen Kontos: wie eine gelöschte – nichts verraten, nichts ändern
    r = await api(5, action, { site: mine, slug: 'mia-takes', files: { 'index.html': 'x' }, deleted: [], confirm: 'tom-lab' });
    assert.equal(r.status, 409, action);
    assert.deepEqual(r.body, GONE, action);
    r = await api(6, action, { site: 999999, slug: 'tom-x', files: {}, deleted: [], confirm: 'tom-lab' });
    assert.deepEqual(r.body, GONE, action);
  }
  assert.equal(await n("SELECT COUNT(*) FROM code_sites WHERE slug = 'tom-lab' AND user_id = 6"), 1);
  assert.equal(await n("SELECT COUNT(*) FROM code_files WHERE content = 'x'"), 0);
  // GET code: ohne site die Code-Seite mit eigener Adresse; eine fremde site → 409
  let r = await api(6, 'code', undefined);
  assert.equal(siteId(r.body), mine);
  r = await api(5, 'code', undefined, { query: '?site=' + mine });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, GONE);
  // Mit site wie bisher
  r = await api(6, 'code-save', { site: mine, files: { 'index.html': '<p>new</p>' }, deleted: [], title: 'Lab 2' });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal((r.body.site as { title: string }).title, 'Lab 2');
});

test('CSRF and login: every code action that changes something needs both', async () => {
  for (const action of ['code-create', 'code-connect', 'code-save', 'code-address', 'code-move', 'code-delete', 'code-unlock']) {
    const r = await api(6, action, { slug: 'tom-csrf', site: 1 }, { csrf: 'd'.repeat(64) });
    assert.equal(r.status, 419, action);
  }
  const ctx = makeTestCtx({ method: 'POST', url: '/dashboard/api/code-connect', host: HOST, headers: { 'content-type': 'application/json' }, rawBody: Buffer.from('{}') });
  await runRequest(ctx, appRoutes);
  assert.equal(ctx.status, 401);
  assert.equal(await n("SELECT COUNT(*) FROM site_addresses WHERE slug = 'tom-csrf'"), 0);
});

test('connect, move to own and back, delete: one slot, E5 and E7, ownership of pages', async () => {
  await saveCodeSettings({ max_on_pages: 1 });
  await resetRates();
  const tom = await pageOf('tom');
  const mia = await pageOf('mia');
  // Eine fremde Seite ist für Tom „nicht gefunden“
  let r = await api(6, 'code-connect', { slot: mia, title: 'Steal' });
  assert.equal(r.status, 404);
  assert.deepEqual(r.body, { ok: false, error: 'Page not found.' });
  assert.equal(await n('SELECT COUNT(*) FROM pages WHERE id = ? AND code_site_id IS NOT NULL', [mia]), 0);
  // E7: eine eigene Domain auf dem Platz
  await q("INSERT INTO custom_domains SET hostname = 'tom.example', target_type = 'page', target_id = ?, user_id = 6, state = 'verifying', state_at = NOW(), created_at = NOW(), updated_at = NOW()", [tom]);
  r = await api(6, 'code-connect', { slot: tom, title: 'Studio' });
  assert.deepEqual(r.body, { ok: false, error: 'Remove the custom domain of this page first – custom domains work for link pages only.' });
  await q("DELETE FROM custom_domains WHERE hostname = 'tom.example'");
  // Neue Seite mit Code-Seite
  r = await api(6, 'code-connect', { slot: 'new', slug: 'tom-studio', title: 'Studio' });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const studio = await pageOf('tom-studio');
  const onPage = siteId(r.body);
  assert.equal((r.body.site as { kind: string }).kind, 'page');
  assert.equal((r.body.site as { slot: number }).slot, studio);
  assert.equal((r.body.site as { slug: string }).slug, 'tom-studio');
  assert.equal(await n('SELECT code_site_id FROM pages WHERE id = ?', [studio]), onPage);
  assert.equal(await n('SELECT COUNT(*) FROM code_sites WHERE id = ? AND slug IS NULL', [onPage]), 1);
  assert.equal(await n("SELECT COUNT(*) FROM site_addresses WHERE slug = 'tom-studio' AND kind = 'page'"), 1);
  assert.deepEqual((r.body.pages as Array<{ id: number; code: number | null }>).map((p) => [p.id, p.code]), [[tom, null], [studio, onPage]]);
  // E5: nur ein Platz
  r = await api(6, 'code-connect', { slot: tom, title: 'Second' });
  assert.deepEqual(r.body, { ok: false, error: 'Only one of your pages can show a code page.' });
  // Schon belegter Platz
  r = await api(6, 'code-connect', { slot: studio, title: 'Again' });
  assert.deepEqual(r.body, { ok: false, error: 'This page already shows a code page.' });
  // Umziehen: weder noch / beides
  r = await api(6, 'code-move', { site: onPage });
  assert.deepEqual(r.body, { ok: false, error: 'Choose where your code page should go.' });
  r = await api(6, 'code-move', { site: onPage, slot: tom, slug: 'x-y' });
  assert.deepEqual(r.body, { ok: false, error: 'Choose where your code page should go.' });
  // E4: Tom hat schon eine eigene Adresse (tom-lab)
  r = await api(6, 'code-move', { site: onPage, slug: 'tom-studio-own' });
  assert.deepEqual(r.body, { ok: false, error: 'You already have a code page with its own address.' });
  // Die eigene Code-Seite löschen (Bestätigung = Adresse), dann umziehen
  const lab = await n("SELECT id FROM code_sites WHERE slug = 'tom-lab'");
  r = await api(6, 'code-delete', { site: lab, confirm: 'tom-la' });
  assert.deepEqual(r.body, { ok: false, error: 'To confirm, please type the address of the code page.' });
  r = await api(6, 'code-delete', { site: lab, confirm: ' tom-lab ' });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(await n('SELECT COUNT(*) FROM code_sites WHERE id = ?', [lab]), 0);
  assert.equal(await n('SELECT COUNT(*) FROM code_files WHERE site_id = ?', [lab]), 0);
  assert.equal(await n("SELECT COUNT(*) FROM site_addresses WHERE slug = 'tom-lab' AND kind = 'code'"), 0);
  r = await api(6, 'code-move', { site: onPage, slug: 'tom-studio-own' });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal((r.body.site as { kind: string }).kind, 'own');
  assert.equal(await n('SELECT COUNT(*) FROM pages WHERE code_site_id = ?', [onPage]), 0);
  assert.equal(await n("SELECT COUNT(*) FROM site_addresses WHERE slug = 'tom-studio-own' AND kind = 'code' AND ref_id = ?", [onPage]), 1);
  // Und zurück auf einen Platz: die eigene Adresse wird für Tom reserviert
  r = await api(6, 'code-move', { site: onPage, slot: tom });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(await n('SELECT code_site_id FROM pages WHERE id = ?', [tom]), onPage);
  assert.equal(await n('SELECT COUNT(*) FROM code_sites WHERE id = ? AND slug IS NULL', [onPage]), 1);
  assert.equal(await n("SELECT COUNT(*) FROM site_addresses WHERE slug = 'tom-studio-own' AND kind = 'code'"), 0);
  // Löschen auf einem Platz: der Platz zeigt wieder seine Link-Seite
  r = await api(6, 'code-delete', { site: onPage, confirm: 'tom' });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(await n('SELECT COUNT(*) FROM pages WHERE id = ? AND code_site_id IS NULL', [tom]), 1);
  assert.equal(r.body.site, null);
});

test('E1 ban, E3 pause and a blocked code page; banned users may still delete', async () => {
  await resetRates();
  let r = await api(6, 'code-create', { slug: 'tom-lab3', title: 'Lab' });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const lab = siteId(r.body);
  await saveCodeSettings({ paused: true });
  r = await api(6, 'code-connect', { slot: 'new', slug: 'tom-paused', title: 'P' });
  assert.deepEqual(r.body, { ok: false, error: 'New code pages are paused right now. Please try again later.' });
  r = await api(6, 'code-address', { site: lab, slug: 'tom-lab4' });
  assert.deepEqual(r.body, { ok: false, error: 'Code pages can’t move to a new address right now. Please try again later.' });
  r = await api(6, 'code-move', { site: lab, slot: await pageOf('tom') });
  assert.deepEqual(r.body, { ok: false, error: 'Code pages can’t move to a new address right now. Please try again later.' });
  // Bearbeiten geht in der Pause
  r = await api(6, 'code-save', { site: lab, files: {}, deleted: [], online: false });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(r.body.paused, true);
  await saveCodeSettings({ paused: false });
  await q("UPDATE users SET code_banned_at = NOW(), code_ban_reason = 'Spam' WHERE id = 6");
  const BANNED = { ok: false, error: 'Code pages have been turned off for your account by the team: Spam' };
  for (const [action, body] of [['code-create', { slug: 'tom-b1' }], ['code-connect', { slot: 'new', slug: 'tom-b2' }], ['code-save', { site: lab, files: {}, deleted: [] }],
    ['code-address', { site: lab, slug: 'tom-b3' }], ['code-move', { site: lab, slot: await pageOf('tom') }], ['code-unlock', { item: 'code_more', request_id: 'a'.repeat(32), expected_price: 0 }]] as const) {
    r = await api(6, action, body);
    assert.deepEqual(r.body, BANNED, action);
  }
  r = await api(6, 'code', undefined);
  assert.deepEqual(r.body.banned, { reason: 'Spam' });
  r = await api(6, 'code-delete', { site: lab, confirm: 'tom-lab3' });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  await q('UPDATE users SET code_banned_at = NULL, code_ban_reason = NULL WHERE id = 6');
  // Vom Team gesperrte Code-Seite: weder ändern noch löschen
  r = await api(6, 'code-create', { slug: 'tom-lab5', title: 'Lab' });
  const blocked = siteId(r.body);
  await q("UPDATE code_sites SET is_blocked = 1, blocked_reason = 'Phishing' WHERE id = ?", [blocked]);
  for (const [action, body] of [['code-save', { files: {}, deleted: [] }], ['code-address', { slug: 'tom-lab6' }], ['code-delete', { confirm: 'tom-lab5' }]] as const) {
    r = await api(6, action, { site: blocked, ...body });
    assert.deepEqual(r.body, { ok: false, error: 'Your code page has been blocked by the team: Phishing' }, action);
  }
  assert.equal(await n('SELECT COUNT(*) FROM code_sites WHERE id = ?', [blocked]), 1);
});

test('E2 and E6 over HTTP: not unlocked (403 need) and the page allowance for a new page', async () => {
  await resetRates();
  let r = await api(7, 'code-connect', { slot: 'new', slug: 'lea-code', terms: true });
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, { ok: false, error: 'Unlock code pages with honeycombs first.', need: 'code_page' });
  // Mia hat 1 Seite; mit max_pages 3 und zwei weiteren Seiten ist für eine neue Seite kein Platz mehr
  await q("INSERT INTO pages (user_id, slug, position, title, subtitle, bio, theme, layout, address_mode, settings, created_at, updated_at) VALUES (5, 'mia-two', 1, 'x', '', '', 'aurora', 'buttons', 'subdomain', '{}', NOW(), NOW()), (5, 'mia-three', 2, 'x', '', '', 'aurora', 'buttons', 'subdomain', '{}', NOW(), NOW())");
  r = await api(5, 'code-connect', { slot: 'new', slug: 'mia-code', title: 'Code' });
  assert.deepEqual(r.body, { ok: false, error: 'You can create up to 3 pages.' });
  assert.equal(await n("SELECT COUNT(*) FROM pages WHERE slug = 'mia-code'"), 0);
});

test('code-unlock code_more: needs code_page, free at price 0, a price, a replay and admin mode', async () => {
  let r = await api(7, 'code-unlock', { item: 'code_more', request_id: 'b'.repeat(32), expected_price: 0 });
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, { ok: false, error: 'Unlock code pages with honeycombs first.', need: 'code_page' });
  r = await api(5, 'code-unlock', { item: 'nope', request_id: 'b'.repeat(32), expected_price: 0 });
  assert.equal(r.status, 400);
  // Preis 0: nichts zu kaufen, Antwort ist der Zustand, keine Buchung
  r = await api(5, 'code-unlock', { item: 'code_more', request_id: 'c'.repeat(32), expected_price: 0 });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.deepEqual(r.body.more, { unlocked: true, cost: 0 });
  assert.equal(await n("SELECT COUNT(*) FROM hc_purchases WHERE user_id = 5 AND item_key = 'code_more'"), 0);
  // Mit Preis: nicht verkauft, solange keine weitere Code-Seite möglich ist (max_on_pages 0)
  // Der Katalog hat die Zeile code_more (beim ersten Lesen des Preises angelegt, Startpreis 0)
  assert.equal(await n("SELECT price FROM hc_items WHERE item_key = 'code_more'"), 0);
  await q("UPDATE hc_items SET price = 40 WHERE item_key = 'code_more'");
  await q('INSERT INTO honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (5, 500, \'admin\', \'\', \'\', NOW())');
  await saveCodeSettings({ max_on_pages: 0 });
  r = await api(5, 'code-unlock', { item: 'code_more', request_id: 'd'.repeat(32), expected_price: 40 });
  assert.equal(r.body.ok, false);
  assert.equal(r.body.error, 'More code pages aren’t available right now.');
  await saveCodeSettings({ max_on_pages: 2 });
  // Admin-Modus: 403, nichts gebucht
  r = await api(5, 'code-unlock', { item: 'code_more', request_id: 'e'.repeat(32), expected_price: 40 }, { impersonatedBy: 3 });
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, { ok: false, code: 'admin_mode', error: 'Buying is turned off in admin mode.' });
  r = await api(5, 'code-unlock', { item: 'code_more', request_id: 'f'.repeat(32), expected_price: 40 });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  // Dieselbe Anfrage noch einmal: keine zweite Abbuchung
  r = await api(5, 'code-unlock', { item: 'code_more', request_id: 'f'.repeat(32), expected_price: 40 });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(await n("SELECT COUNT(*) FROM honeycomb_ledger WHERE user_id = 5 AND ref = 'code_more' AND amount < 0"), 1);
  assert.deepEqual(r.body.more, { unlocked: true, cost: 40 });
  // E8 über HTTP: ohne code_more und mit Preis wird eine zweite Code-Seite abgelehnt
  await q("UPDATE honeycomb_ledger SET ref = 'code_more_x' WHERE user_id = 5 AND ref = 'code_more'");
  await q("DELETE FROM hc_entitlements WHERE user_id = 5 AND feature = 'code_more'");
  await resetRates();
  r = await api(5, 'code-create', { slug: 'mia-lab', title: 'Lab' });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  r = await api(5, 'code-connect', { slot: await pageOf('mia'), title: 'More' });
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, { ok: false, error: 'Unlock more code pages with honeycombs first.', need: 'code_more' });
  await q("UPDATE hc_items SET price = 0 WHERE item_key = 'code_more'");
});

test('races: two connects at once fill one slot only; parallel moves keep one address', async () => {
  await saveCodeSettings({ max_on_pages: 1 });
  await resetRates();
  await q('UPDATE pages SET code_site_id = NULL WHERE user_id = 6');
  await q('DELETE FROM code_files WHERE site_id IN (SELECT id FROM code_sites WHERE user_id = 6)');
  await q('DELETE FROM code_sites WHERE user_id = 6');
  const tom = await pageOf('tom');
  const studio = await pageOf('tom-studio');
  const answers = await Promise.all([
    api(6, 'code-connect', { slot: tom, title: 'A' }),
    api(6, 'code-connect', { slot: studio, title: 'B' }),
    api(6, 'code-connect', { slot: tom, title: 'C' }),
  ]);
  const ok = answers.filter((a) => a.body.ok === true);
  assert.equal(ok.length, 1, JSON.stringify(answers.map((a) => a.body.error ?? 'ok')));
  assert.equal(await n('SELECT COUNT(*) FROM pages WHERE user_id = 6 AND code_site_id IS NOT NULL'), 1);
  assert.equal(await n('SELECT COUNT(*) FROM code_sites WHERE user_id = 6'), 1);
  // Zwei Umzüge derselben Code-Seite an zwei eigene Adressen: genau eine gilt, keine Adresse bleibt verwaist
  const site = siteId(ok[0].body);
  const moves = await Promise.all([api(6, 'code-move', { site, slug: 'tom-race-1' }), api(6, 'code-move', { site, slug: 'tom-race-2' })]);
  assert.equal(moves.filter((m) => m.body.ok === true).length, 1, JSON.stringify(moves.map((m) => m.body)));
  const slug = String((await q('SELECT slug FROM code_sites WHERE id = ?', [site]))[0].slug);
  assert.ok(slug === 'tom-race-1' || slug === 'tom-race-2', slug);
  assert.equal(await n("SELECT COUNT(*) FROM site_addresses WHERE kind = 'code' AND ref_id = ?", [site]), 1);
  assert.equal(await n('SELECT COUNT(*) FROM pages WHERE code_site_id = ?', [site]), 0);
});

test('enforcer: losing code_page takes every code page offline, losing code_more the newer ones; a re-run changes nothing', async () => {
  const { enforceSlots } = await import('../src/code/enforce.js');
  const { registeredEnforcers } = await import('../src/honeycombs/reconcile.js');
  assert.deepEqual(registeredEnforcers().filter((e) => e.name === 'code-slots'), [{ name: 'code-slots', inline: true }]);
  // Mia: zwei Code-Seiten (eigene Adresse + eine auf dem Platz mia-two), beide online
  const res = (await t.admin.query("INSERT INTO code_sites (user_id, slug, title, is_published, is_blocked, views, created_at, updated_at) VALUES (5, NULL, 'Two', 1, 0, 0, NOW(), NOW())"))[0] as { insertId: number };
  await q("INSERT INTO code_files (site_id, path, content, updated_at) VALUES (?, 'index.html', '<p>two</p>', NOW())", [res.insertId]);
  await q("UPDATE pages SET code_site_id = ? WHERE slug = 'mia-two'", [res.insertId]);
  await q('UPDATE code_sites SET is_published = 1 WHERE user_id = 5');
  const mias = (await q('SELECT id FROM code_sites WHERE user_id = 5 ORDER BY id')).map((r) => Number(r.id));
  assert.equal(mias.length, 2);
  // code_more war gekauft und ist erstattet (Zeile mit Menge 0), und weitere Code-Seiten kosten etwas: die neuere geht
  // offline, die Dateien bleiben. Bei Preis 0 sind weitere Code-Seiten für alle frei – dann bleibt alles online.
  await q("INSERT INTO hc_entitlements (user_id, feature, lot, quantity, permanent, source, created_at, updated_at) VALUES (5, 'code_more', 0, 0, 1, 'purchase', NOW(), NOW())");
  assert.equal(await enforceSlots(5), 0);
  await q("UPDATE hc_items SET price = 40 WHERE item_key = 'code_more'");
  assert.equal(await enforceSlots(5), 1);
  assert.deepEqual((await q('SELECT id, is_published FROM code_sites WHERE user_id = 5 ORDER BY id')).map((r) => [Number(r.id), Number(r.is_published)]), [[mias[0], 1], [mias[1], 0]]);
  assert.ok(await n('SELECT COUNT(*) FROM code_files WHERE site_id = ?', [mias[1]]) > 0);
  assert.equal(await enforceSlots(5), 0);
  await q("UPDATE hc_items SET price = 0 WHERE item_key = 'code_more'");
  // code_page entzogen: alle offline; ohne Freischaltung kann Mia sie nicht wieder einschalten
  await q("DELETE FROM honeycomb_ledger WHERE user_id = 5 AND reason = 'unlock' AND ref = 'code_page'");
  await q("INSERT INTO hc_entitlements (user_id, feature, lot, quantity, permanent, source, created_at, updated_at) VALUES (5, 'code_page', 0, 0, 1, 'purchase', NOW(), NOW())");
  assert.equal(await enforceSlots(5), 1);
  assert.equal(await n('SELECT COUNT(*) FROM code_sites WHERE user_id = 5 AND is_published = 1'), 0);
  assert.equal(await enforceSlots(5), 0);
  const r = await api(5, 'code-save', { site: mias[0], files: {}, deleted: [], online: true });
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, { ok: false, error: 'Unlock code pages with honeycombs first.', need: 'code_page' });
  // Tom hat code_more nie gehabt (Preis 0): nichts geht offline
  assert.equal(await enforceSlots(6), 0);
  // Lea hatte code_page nie (keine Zeile, keine alte Freischaltung) und hat trotzdem eine Code-Seite online (alte Daten):
  // ein Abgleich nach einem anderen Kauf lässt sie online
  await q("DELETE FROM honeycomb_ledger WHERE user_id = 7 AND reason = 'unlock' AND ref = 'code_page'");
  await q("DELETE FROM hc_entitlements WHERE user_id = 7 AND feature IN ('code_page', 'code_more')");
  const lea = (await t.admin.query("INSERT INTO code_sites (user_id, slug, title, is_published, is_blocked, views, created_at, updated_at) VALUES (7, NULL, 'Old', 1, 0, 0, NOW(), NOW())"))[0] as { insertId: number };
  assert.equal(await enforceSlots(7), 0);
  assert.equal(await n('SELECT COUNT(*) FROM code_sites WHERE id = ? AND is_published = 1', [lea.insertId]), 1);
  await q('DELETE FROM code_sites WHERE id = ?', [lea.insertId]);
  // Ein gelöschtes Konto: nichts zu tun
  assert.equal(await enforceSlots(999999), 0);
});
