// Prüfung von CS-4 (Editor-API der Code-Seiten auf Seitenplätzen): Markennamen bei jeder Adresse, die eine Code-Seite
// bekommt (auch beim Übernehmen eines Platzes), der Online-Schalter nach dem Verlust von code_more, ein Speichern,
// das auf die Zeile wartet, während das Team die Code-Seite sperrt oder das Konto bannt, die Adressänderung einer
// Link-Seite, deren Platz inzwischen eine Code-Seite zeigt, und zwei Konten, die gleichzeitig dieselbe Adresse wollen.
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

before(async () => {
  t = await testDatabase('cs4rev');
  await t.admin.query('USE `' + t.name + '`');
  // Mia (5) und Tom (6) haben Code-Seiten freigeschaltet und die Regeln akzeptiert
  await q("INSERT INTO honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (5, 0, 'unlock', 'code_page', '', NOW()), (6, 0, 'unlock', 'code_page', '', NOW())");
  await q('UPDATE users SET code_terms_at = NOW() WHERE id IN (5, 6)');
  await q('UPDATE pages SET slug_changed_at = NULL WHERE user_id IN (5, 6)');
  await saveCodeSettings({ max_on_pages: 1 });
});

after(async () => {
  await t.done();
});

async function api(userId: number, action: string, json?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const sid = await loginSession(userId);
  const post = json !== undefined;
  const ctx = makeTestCtx({
    method: post ? 'POST' : 'GET',
    url: '/dashboard/api/' + action,
    host: HOST,
    headers: post ? { 'content-type': 'application/json', 'x-csrf-token': CSRF } : {},
    cookies: { PHPSESSID: sid },
    rawBody: post ? Buffer.from(JSON.stringify(json)) : undefined,
  });
  await runRequest(ctx, appRoutes);
  return { status: ctx.status, body: JSON.parse(String(ctx.body)) as Record<string, unknown> };
}

const n = async (sql: string, p: unknown[] = []): Promise<number> => Number(Object.values((await q(sql, p))[0])[0]);
const siteId = (b: Record<string, unknown>): number => (b.site as { id: number }).id;
const pageOf = async (slug: string): Promise<number> => n('SELECT id FROM pages WHERE slug = ?', [slug]);
const brandText = (slug: string): string => `The address “${slug}” contains a brand name. Code pages can’t use brand names in their address.`;
const BRAND_SLOT = { ok: false, error: 'This page’s address contains a brand name. Code pages can’t use brand names in their address.' };

test('brand names: a code page never gets a brand address – new page, taking over a slot, moving onto it or renaming it', async () => {
  // Eine Link-Seite darf einen Markennamen tragen (nur Code- und Statusseiten nicht)
  await q("INSERT INTO pages (user_id, slug, position, title, subtitle, bio, theme, layout, address_mode, settings, created_at, updated_at) VALUES (6, 'paypal-login', 1, 'x', '', '', 'aurora', 'buttons', 'subdomain', '{}', NOW(), NOW())");
  const brandPage = await pageOf('paypal-login');
  await q("INSERT INTO site_addresses (slug, kind, ref_id, user_id, claimed_at) VALUES ('paypal-login', 'page', ?, 6, NOW())", [brandPage]);
  // Den Platz übernehmen: abgelehnt, nichts angelegt
  let r = await api(6, 'code-connect', { slot: brandPage, title: 'Shop' });
  assert.deepEqual(r.body, BRAND_SLOT);
  assert.equal(await n('SELECT COUNT(*) FROM code_sites WHERE user_id = 6'), 0);
  assert.equal(await n('SELECT COUNT(*) FROM pages WHERE id = ? AND code_site_id IS NULL', [brandPage]), 1);
  // Neue Seite, die gleich eine Code-Seite zeigt: dieselbe Regel wie eine eigene Adresse
  r = await api(6, 'code-connect', { slot: 'new', slug: 'paypal-shop', title: 'Shop' });
  assert.deepEqual(r.body, { ok: false, error: brandText('paypal-shop') });
  assert.equal(await n("SELECT COUNT(*) FROM pages WHERE slug = 'paypal-shop'"), 0);
  assert.equal(await n("SELECT COUNT(*) FROM site_addresses WHERE slug = 'paypal-shop'"), 0);
  // Eine Code-Seite mit eigener Adresse auf den Platz umziehen: abgelehnt, sie behält ihre Adresse
  r = await api(6, 'code-create', { slug: 'tom-own', title: 'Own' });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const own = siteId(r.body);
  r = await api(6, 'code-move', { site: own, slot: brandPage });
  assert.deepEqual(r.body, BRAND_SLOT);
  assert.equal(await n("SELECT COUNT(*) FROM code_sites WHERE id = ? AND slug = 'tom-own'", [own]), 1);
  assert.equal(await n('SELECT COUNT(*) FROM pages WHERE id = ? AND code_site_id IS NULL', [brandPage]), 1);
  // Eine Code-Seite auf einem Platz umbenennen: dieselbe Regel wie eine eigene Adresse
  r = await api(6, 'code-connect', { slot: await pageOf('tom'), title: 'On tom' });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const onTom = siteId(r.body);
  r = await api(6, 'code-address', { site: onTom, slug: 'paypal-help' });
  assert.deepEqual(r.body, { ok: false, error: brandText('paypal-help') });
  assert.equal(await n("SELECT COUNT(*) FROM pages WHERE slug = 'tom' AND code_site_id = ?", [onTom]), 1);
  assert.equal(await n("SELECT COUNT(*) FROM site_addresses WHERE slug = 'paypal-help'"), 0);
  // Ohne Markennamen geht beides weiter
  r = await api(6, 'code-address', { site: onTom, slug: 'tom-studio' });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
});

test('code_more lost while it costs something: the newer code page stays offline – the online switch cannot bring it back', async () => {
  const { enforceSlots } = await import('../src/code/enforce.js');
  // Katalogzeile anlegen (erstes Lesen des Preises), dann einen Preis setzen; Mia bekam code_more vom Team
  await api(5, 'code');
  await q("UPDATE hc_items SET price = 40 WHERE item_key = 'code_more'");
  await q("INSERT INTO hc_entitlements (user_id, feature, lot, quantity, permanent, source, created_at, updated_at) VALUES (5, 'code_more', 0, 1, 1, 'grant', NOW(), NOW())");
  let r = await api(5, 'code-create', { slug: 'mia-lab', title: 'Lab' });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const older = siteId(r.body);
  r = await api(5, 'code-connect', { slot: await pageOf('mia'), title: 'More' });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const newer = siteId(r.body);
  // Entzogen: der Abgleich nimmt die neuere offline
  await q("UPDATE hc_entitlements SET quantity = 0 WHERE user_id = 5 AND feature = 'code_more'");
  assert.equal(await enforceSlots(5), 1);
  assert.equal(await n('SELECT is_published FROM code_sites WHERE id = ?', [newer]), 0);
  // Der Online-Schalter bringt sie nicht zurück
  r = await api(5, 'code-save', { site: newer, files: {}, deleted: [], online: true });
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, { ok: false, error: 'Unlock more code pages with honeycombs first.', need: 'code_more' });
  assert.equal(await n('SELECT is_published FROM code_sites WHERE id = ?', [newer]), 0);
  // Bearbeiten (ohne Schalter) geht weiter und lässt sie offline; die ältere darf online sein
  r = await api(5, 'code-save', { site: newer, files: { 'index.html': '<p>v2</p>' }, deleted: [], title: 'More 2' });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(await n("SELECT COUNT(*) FROM code_sites WHERE id = ? AND is_published = 0 AND title = 'More 2'", [newer]), 1);
  r = await api(5, 'code-save', { site: older, files: {}, deleted: [], online: true });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  // Preis 0: weitere Code-Seiten sind für alle frei – die Seite darf wieder online, und ein Abgleich lässt sie dort
  await q("UPDATE hc_items SET price = 0 WHERE item_key = 'code_more'");
  r = await api(5, 'code-save', { site: newer, files: {}, deleted: [], online: true });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(await enforceSlots(5), 0);
  assert.equal(await n('SELECT COUNT(*) FROM code_sites WHERE user_id = 5 AND is_published = 1'), 2);
});

// Hält die Zeile der Code-Seite auf einer eigenen Verbindung, bis die Anfrage auf sie wartet, und führt dann change aus
async function whileSaveWaits(site: number, body: Record<string, unknown>, change: () => Promise<void>): Promise<{ status: number; body: Record<string, unknown> }> {
  await t.admin.query('START TRANSACTION');
  await t.admin.query('SELECT id FROM code_sites WHERE id = ? FOR UPDATE', [site]);
  const pending = api(6, 'code-save', { site, ...body });
  let waiting = false;
  for (let i = 0; i < 200 && !waiting; i++) {
    // Eigene Verbindungen sieht man ohne Sonderrechte: die Anfrage steht mit ihrer Abfrage in der Prozessliste
    const [rows] = await t.admin.query<RowDataPacket[]>("SELECT COUNT(*) AS c FROM information_schema.PROCESSLIST WHERE DB = ? AND COMMAND = 'Query' AND INFO LIKE '%FROM code_sites WHERE id = % FOR UPDATE%' AND ID <> CONNECTION_ID()", [t.name]);
    waiting = Number(rows[0].c) > 0;
    if (!waiting) await new Promise((res) => setTimeout(res, 20));
  }
  assert.ok(waiting, 'the save never waited for the row');
  await change();
  await t.admin.query('COMMIT');
  return pending;
}

test('a block or a ban that lands while a save waits for its row is seen: nothing is written', async () => {
  // Toms Code-Seite mit eigener Adresse (aus dem ersten Test, sonst neu)
  let site = await n('SELECT COALESCE(MAX(id), 0) FROM code_sites WHERE user_id = 6 AND slug IS NOT NULL');
  if (!site) {
    const created = await api(6, 'code-create', { slug: 'tom-race', title: 'Race' });
    assert.equal(created.body.ok, true, JSON.stringify(created.body));
    site = siteId(created.body);
  }
  let r = await whileSaveWaits(site, { files: { 'index.html': '<p>after block</p>' }, deleted: [] }, async () => {
    await t.admin.query("UPDATE code_sites SET is_blocked = 1, blocked_reason = 'Phishing' WHERE id = ?", [site]);
  });
  assert.deepEqual(r.body, { ok: false, error: 'Your code page has been blocked by the team: Phishing' });
  assert.equal(await n("SELECT COUNT(*) FROM code_files WHERE site_id = ? AND content = '<p>after block</p>'", [site]), 0);
  await q('UPDATE code_sites SET is_blocked = 0, blocked_reason = NULL WHERE id = ?', [site]);
  r = await whileSaveWaits(site, { files: { 'index.html': '<p>after ban</p>' }, deleted: [], online: true }, async () => {
    await t.admin.query("UPDATE users SET code_banned_at = NOW(), code_ban_reason = 'Spam' WHERE id = 6");
  });
  assert.deepEqual(r.body, { ok: false, error: 'Code pages have been turned off for your account by the team: Spam' });
  assert.equal(await n("SELECT COUNT(*) FROM code_files WHERE site_id = ? AND content = '<p>after ban</p>'", [site]), 0);
  await q('UPDATE users SET code_banned_at = NULL, code_ban_reason = NULL WHERE id = 6');
});

test('the link page address action re-checks the slot on its locked row: a page that started showing code keeps its address', async () => {
  // Tom: eine Link-Seite, deren Adresse er ändern will; während die Änderung auf die Zeile wartet, zeigt der Platz eine
  // Code-Seite (so wie es code-connect oder code-move in einer gleichzeitigen Anfrage tun) – Markennamen über diesen Weg
  // gingen sonst an der Namensregel der Code-Seiten vorbei
  await q("INSERT INTO pages (user_id, slug, position, title, subtitle, bio, theme, layout, address_mode, settings, created_at, updated_at) VALUES (6, 'tom-race-page', 5, 'x', '', '', 'aurora', 'buttons', 'subdomain', '{}', NOW(), NOW())");
  const page = await pageOf('tom-race-page');
  await q("INSERT INTO site_addresses (slug, kind, ref_id, user_id, claimed_at) VALUES ('tom-race-page', 'page', ?, 6, NOW())", [page]);
  await t.admin.query('START TRANSACTION');
  await t.admin.query('SELECT id FROM pages WHERE id = ? FOR UPDATE', [page]);
  const pending = api(6, 'address', { page: { id: page }, slug: 'paypal-race', mode: 'subdomain' });
  let waiting = false;
  for (let i = 0; i < 200 && !waiting; i++) {
    const [rows] = await t.admin.query<RowDataPacket[]>("SELECT COUNT(*) AS c FROM information_schema.PROCESSLIST WHERE DB = ? AND COMMAND = 'Query' AND INFO LIKE '%FROM pages WHERE id = % FOR UPDATE%' AND ID <> CONNECTION_ID()", [t.name]);
    waiting = Number(rows[0].c) > 0;
    if (!waiting) await new Promise((res) => setTimeout(res, 20));
  }
  assert.ok(waiting, 'the address change never waited for the row');
  const [ins] = await t.admin.query("INSERT INTO code_sites (user_id, slug, title, is_published, is_blocked, views, created_at, updated_at) VALUES (6, NULL, 'Race', 1, 0, 0, NOW(), NOW())");
  const code = (ins as { insertId: number }).insertId;
  await t.admin.query('UPDATE pages SET code_site_id = ? WHERE id = ?', [code, page]);
  await t.admin.query('COMMIT');
  const r = await pending;
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { ok: false, error: 'This page now shows a code page. Please reload the editor.', reload: true });
  assert.equal(await n("SELECT COUNT(*) FROM pages WHERE id = ? AND slug = 'tom-race-page'", [page]), 1);
  assert.equal(await n("SELECT COUNT(*) FROM site_addresses WHERE slug = 'paypal-race'"), 0);
});

test('two accounts take the same new address at once: the slower one is told which address is taken', async () => {
  // Toms Code-Seite mit eigener Adresse soll „race-slug“ bekommen, während Leas Code-Seite diese Adresse gerade belegt
  let site = await n('SELECT COALESCE(MAX(id), 0) FROM code_sites WHERE user_id = 6 AND slug IS NOT NULL');
  if (!site) {
    const created = await api(6, 'code-create', { slug: 'tom-dup', title: 'Dup' });
    assert.equal(created.body.ok, true, JSON.stringify(created.body));
    site = siteId(created.body);
  }
  const before = String((await q('SELECT slug FROM code_sites WHERE id = ?', [site]))[0].slug);
  await t.admin.query('START TRANSACTION');
  await t.admin.query("INSERT INTO code_sites (user_id, slug, title, is_published, is_blocked, views, created_at, updated_at) VALUES (7, 'race-slug', 'Lea', 1, 0, 0, NOW(), NOW())");
  const pending = api(6, 'code-address', { site, slug: 'race-slug' });
  let waiting = false;
  for (let i = 0; i < 200 && !waiting; i++) {
    const [rows] = await t.admin.query<RowDataPacket[]>("SELECT COUNT(*) AS c FROM information_schema.PROCESSLIST WHERE DB = ? AND COMMAND = 'Query' AND INFO LIKE '%UPDATE code_sites SET slug%' AND ID <> CONNECTION_ID()", [t.name]);
    waiting = Number(rows[0].c) > 0;
    if (!waiting) await new Promise((res) => setTimeout(res, 20));
  }
  assert.ok(waiting, 'the address change never waited for the other account');
  await t.admin.query('COMMIT');
  const r = await pending;
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: false, error: 'Sorry, the address “race-slug” is already taken.' });
  assert.equal(String((await q('SELECT slug FROM code_sites WHERE id = ?', [site]))[0].slug), before);
  await q("DELETE FROM code_sites WHERE slug = 'race-slug' AND user_id = 7");
});
