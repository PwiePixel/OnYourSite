// Code-Seiten moderieren (CS-5): POST /admin mit code_action – Grenzen (gelten beim Speichern; eine Seite über einer
// gesenkten Grenze darf nur nicht größer werden), sperren und entsperren, löschen mit getippter Adresse, ein Konto für
// Code-Seiten sperren und wieder zulassen, „More code pages“ freischalten – jeweils mit Protokoll und genau einem
// Hinweis an den Besitzer; dazu Filter, Suche, Quelltext-Betrachter und Referrer-Policy der Admin-Seite.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { makeTestCtx, type Ctx } from '../src/web/ctx.js';
import { appRoutes } from '../src/app/dispatch.js';
import { CSRF, jsonBody, loginSession, runRequest, testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
const ADMIN = 3;
const ADMIN_B = 4;
const MIA = 5;
const TOM = 6;
let sid = '';

async function sql(query: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [r] = await t.admin.query<RowDataPacket[]>(query.replace(/`DB`/g, '`' + t.name + '`'), params);
  return r;
}
const n = async (query: string, params: unknown[] = []): Promise<number> => Number(Object.values((await sql(query, params))[0])[0]);
const post = (form: Record<string, string>, session = sid): Promise<Ctx> =>
  runRequest(makeTestCtx({ method: 'POST', url: '/admin', cookies: { PHPSESSID: session }, post: { csrf: CSRF, _confirmed: '1', ...form } }), appRoutes);
const page = async (url = '/admin'): Promise<{ html: string; ctx: Ctx }> => {
  const ctx = await runRequest(makeTestCtx({ url, cookies: { PHPSESSID: sid } }), appRoutes);
  return { html: String(ctx.body), ctx };
};
const flash = async (): Promise<string> => /<div data-flash="[a-z]+"[^>]*>([\s\S]*?)<\/div>/.exec((await page()).html)?.[1].replace(/<[^>]+>/g, '').trim() ?? '';
const notes = async (uid: number) => (await sql('SELECT title, body, link FROM `DB`.notifications WHERE user_id = ? ORDER BY id', [uid])).map((r) => ({ ...r }));
const logOf = async () => (await sql('SELECT action, address, reason, admin_id FROM `DB`.code_moderation ORDER BY id DESC LIMIT 1'))[0];

async function site(uid: number, slug: string | null, files: Record<string, string>, slot?: number): Promise<number> {
  const [r] = await t.admin.query(`INSERT INTO \`${t.name}\`.code_sites (user_id, slug, title, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())`, [uid, slug, 'T ' + (slug ?? 'slot')]);
  const id = (r as { insertId: number }).insertId;
  for (const [p, c] of Object.entries(files)) await sql('INSERT INTO `DB`.code_files (site_id, path, content, updated_at) VALUES (?, ?, ?, NOW())', [id, p, c]);
  if (slug) await sql("INSERT INTO `DB`.site_addresses (slug, kind, ref_id, user_id, claimed_at) VALUES (?, 'code', ?, ?, NOW())", [slug, id, uid]);
  if (slot) await sql('UPDATE `DB`.pages SET code_site_id = ? WHERE id = ?', [id, slot]);
  return id;
}

before(async () => {
  t = await testDatabase('cs5mod');
  await sql("INSERT INTO `DB`.users (id, email, password, full_name, is_admin, created_at) VALUES (?, 'admin2@test.de', 'x', 'Second Admin', 1, NOW())", [ADMIN_B]);
  await sql("INSERT INTO `DB`.honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (5, 0, 'unlock', 'code_page', '', NOW()), (6, 0, 'unlock', 'code_page', '', NOW())");
  await sql('UPDATE `DB`.users SET code_terms_at = NOW() WHERE id IN (5, 6)');
  sid = await loginSession(ADMIN);
});

after(async () => {
  await t.done();
});

beforeEach(async () => {
  await sql('DELETE FROM `DB`.notifications');
});

test('limits: saved with bounds and logged; saving follows them, a page above a lowered limit may only get smaller', async () => {
  await post({ code_action: 'settings', max_on_pages: '9', max_files: '2', max_file_kb: '16', max_total_kb: '256' });
  assert.equal(await flash(), 'Code page settings saved.');
  assert.equal((await logOf()).action, 'limits');
  const id = await site(MIA, 'mia-lab', { 'index.html': '<p>x</p>', 'a.css': 'a{}', 'b.css': 'b{}' });
  const as = async (files: Record<string, string>, deleted: string[] = []) => {
    const ctx = makeTestCtx({ method: 'POST', url: '/dashboard/api/code-save', headers: { 'content-type': 'application/json', 'x-csrf-token': CSRF },
      cookies: { PHPSESSID: await loginSession(MIA) }, rawBody: Buffer.from(JSON.stringify({ site: id, files, deleted })) });
    await runRequest(ctx, appRoutes);
    return jsonBody(ctx) as { ok: boolean; error?: string };
  };
  // Schon 3 Dateien bei einer Grenze von 2: ändern geht, eine vierte nicht
  assert.equal((await as({ 'a.css': 'a{color:red}' })).ok, true);
  assert.deepEqual(await as({ 'c.css': 'c{}' }), { ok: false, error: 'A code page can have up to 2 files.' });
  // Eine Datei auf über 16 KB wachsen lassen: nein
  assert.deepEqual(await as({ 'a.css': 'x'.repeat(17 * 1024) }), { ok: false, error: 'a.css is larger than 16 KB.' });
  await post({ code_action: 'settings', max_on_pages: '1', max_files: '30', max_file_kb: '256', max_total_kb: '2048' });
  assert.equal((await as({ 'c.css': 'c{}' })).ok, true);
  const page = await sql("SELECT meta_value FROM `DB`.oys_meta WHERE meta_key = 'code_pages'");
  assert.equal(JSON.parse(String(page[0].meta_value)).max_on_pages, 1);
});

test('block and unblock: one notice each with the address, logged; the page’s address for a slot; twice changes nothing', async () => {
  const id = await site(TOM, null, { 'index.html': '<p>t</p>' }, 3);
  await post({ code_action: 'block', site_id: String(id), reason: 'Phishing <b>' });
  assert.equal(await flash(), '“tom” is blocked.');
  assert.equal(await n('SELECT is_blocked FROM `DB`.code_sites WHERE id = ?', [id]), 1);
  assert.deepEqual(await notes(TOM), [{ title: 'Your code page was blocked', body: 'tom: Phishing <b>', link: `/dashboard?site=${id}#code` }]);
  assert.deepEqual({ ...(await logOf()) }, { action: 'block', address: 'tom', reason: 'Phishing <b>', admin_id: ADMIN });
  await post({ code_action: 'block', site_id: String(id), reason: 'x' });
  assert.equal(await flash(), '“tom” is already blocked.');
  assert.equal((await notes(TOM)).length, 1, 'no second notice');
  await post({ code_action: 'unblock', site_id: String(id) });
  assert.equal(await flash(), '“tom” is online again.');
  assert.equal((await notes(TOM)).at(-1)?.title, 'Your code page is online again');
  await sql('UPDATE `DB`.pages SET code_site_id = NULL WHERE id = 3');
  await sql('DELETE FROM `DB`.code_files WHERE site_id = ?', [id]);
  await sql('DELETE FROM `DB`.code_sites WHERE id = ?', [id]);
});

test('delete: only with the typed address; the slot shows its link page again, an own address is held for nobody', async () => {
  const onSlot = await site(TOM, null, { 'index.html': '<p>t</p>' }, 3);
  await post({ code_action: 'delete', site_id: String(onSlot), confirm: 'nope' });
  assert.equal(await flash(), 'To delete it, type the address “tom”.');
  assert.equal(await n('SELECT COUNT(*) FROM `DB`.code_sites WHERE id = ?', [onSlot]), 1);
  await post({ code_action: 'delete', site_id: String(onSlot), confirm: 'TOM', reason: 'Spam' });
  assert.equal(await flash(), '“tom” was deleted – the address shows the link page again.');
  assert.equal(await n('SELECT COUNT(*) FROM `DB`.code_sites WHERE id = ?', [onSlot]), 0);
  assert.equal(await n('SELECT COUNT(*) FROM `DB`.pages WHERE id = 3 AND code_site_id IS NULL'), 1);
  assert.deepEqual(await notes(TOM), [{ title: 'Your code page was deleted by the team', body: 'tom: Spam', link: '/dashboard#code' }]);
  const own = await site(TOM, 'tom-lab', { 'index.html': '<p>t</p>' });
  // Länger als 7 Tage benutzt – sonst wäre die Adresse ohnehin sofort frei (HOLD_POLICY)
  await sql("UPDATE `DB`.site_addresses SET claimed_at = NOW() - INTERVAL 30 DAY WHERE slug = 'tom-lab'");
  await post({ code_action: 'delete', site_id: String(own), confirm: 'tom-lab' });
  assert.equal(await flash(), '“tom-lab” was deleted.');
  const held = (await sql("SELECT kind, user_id FROM `DB`.site_addresses WHERE slug = 'tom-lab'"))[0];
  assert.deepEqual({ ...held }, { kind: 'held', user_id: null }, 'the owner doesn’t get the address back');
});

test('ban and unban: the account can’t create or change code pages; with “block all” every page is blocked; one notice each', async () => {
  // Mias Code-Seite mit eigener Adresse (aus dem ersten Fall) und eine auf ihrer Seite
  const a = await site(MIA, null, { 'index.html': '<p>1</p>' }, 2);
  await post({ code_action: 'ban', user_id: String(MIA), reason: 'Scam', block_all: '1' });
  assert.match(await flash(), /^Mia Müller can no longer create or change code pages\. \d+ code pages? blocked\.$/);
  assert.equal(await n('SELECT COUNT(*) FROM `DB`.code_sites WHERE user_id = ? AND is_blocked = 0', [MIA]), 0);
  assert.deepEqual(await notes(MIA), [{ title: 'Code pages are turned off for your account', body: 'Scam', link: '/dashboard#code' }]);
  const ctx = makeTestCtx({ method: 'POST', url: '/dashboard/api/code-create', headers: { 'content-type': 'application/json', 'x-csrf-token': CSRF },
    cookies: { PHPSESSID: await loginSession(MIA) }, rawBody: Buffer.from(JSON.stringify({ slug: 'mia-new', title: 'x', terms: true })) });
  await runRequest(ctx, appRoutes);
  assert.equal((jsonBody(ctx) as { ok: boolean }).ok, false);
  // Im Editor: der Hinweis mit dem Grund (die Antwort der Code-API trägt ihn)
  const state = makeTestCtx({ url: '/dashboard/api/code', cookies: { PHPSESSID: await loginSession(MIA) } });
  await runRequest(state, appRoutes);
  assert.deepEqual((jsonBody(state) as { banned: unknown }).banned, { reason: 'Scam' });
  await post({ code_action: 'unban', user_id: String(MIA) });
  assert.equal(await flash(), 'Mia Müller can use code pages again. 2 code pages stay blocked until you unblock them.');
  assert.equal(await n('SELECT COUNT(*) FROM `DB`.users WHERE id = ? AND code_banned_at IS NULL AND code_ban_reason IS NULL', [MIA]), 1);
  assert.equal((await notes(MIA)).at(-1)?.title, 'You can use code pages again');
  await sql('UPDATE `DB`.code_sites SET is_blocked = 0 WHERE user_id = ?', [MIA]);
  await sql('UPDATE `DB`.pages SET code_site_id = NULL WHERE id = 2');
  await sql('DELETE FROM `DB`.code_sites WHERE id = ?', [a]);
});

test('unlock More code pages for free; unknown users and items are refused', async () => {
  await post({ code_action: 'unlock', user_id: String(TOM), item: 'code_more' });
  assert.equal(await flash(), 'More code pages unlocked for Tom Weber.');
  await post({ code_action: 'unlock', user_id: String(TOM), item: 'code_more' });
  assert.equal(await flash(), 'Tom Weber had already unlocked more code pages.');
  await post({ code_action: 'unlock', user_id: String(TOM), item: 'nope' });
  assert.equal(await flash(), 'Please choose what to unlock.');
  await post({ code_action: 'ban', user_id: '999999' });
  assert.equal(await flash(), 'Please choose a user.');
});

test('the list: filters, search, the source viewer as text, links without a referrer', async () => {
  await sql("DELETE FROM `DB`.code_sites WHERE user_id = ? AND slug IS NOT NULL", [MIA]);
  const id = await site(MIA, 'mia-src', { 'index.html': '<script>alert(1)</script>', 'style.css': 'p{}' });
  await sql('UPDATE `DB`.code_sites SET is_blocked = 1 WHERE id = ?', [id]);
  let r = await page('/admin?cs=blocked&csq=mia-src');
  assert.equal(r.ctx.header('Referrer-Policy'), 'no-referrer');
  const list = r.html.slice(r.html.indexOf('id="tab-code-pages"'));
  assert.ok(list.includes('mia-src.'), 'the blocked page is listed');
  assert.ok(!/href="[^"]*mia-src[^"]*" target="_blank" rel="noopener"(?! noreferrer)/.test(list), 'links to user sites carry noreferrer');
  r = await page('/admin?cs=online&csq=mia-src');
  // Nur die Liste (bis zur Zugangsliste darunter)
  const only = r.html.slice(r.html.indexOf('id="codeFilters"'), r.html.indexOf('Access <span'));
  assert.ok(only.length > 0 && !only.includes('mia-src.oys'), 'filtered out');
  r = await page(`/admin?code_site=${id}&file=style.css`);
  assert.match(r.html, /id="codeViewer"/);
  assert.ok(r.html.includes('p{}'));
  r = await page(`/admin?code_site=${id}&file=../../etc/passwd`);
  assert.ok(r.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !r.html.includes('<script>alert(1)</script>'), 'index.html as text');
  // Aus dem Betrachter: zurück dorthin
  const back = await post({ code_action: 'unblock', site_id: String(id), from_viewer: String(id) });
  assert.equal(back.header('Location'), `/admin?code_site=${id}#code-pages`);
  // Protokoll
  assert.match((await page()).html, /id="codeLog"[\s\S]*unblock · mia-src/);
});

test('only an admin in their own session, with the confirmation, moderates', async () => {
  const id = await site(TOM, 'tom-guard', { 'index.html': 'x' });
  for (const session of [await loginSession(MIA), await loginSession(ADMIN_B, { impersonatedBy: ADMIN })]) {
    await post({ code_action: 'block', site_id: String(id) }, session);
    await post({ code_action: 'delete', site_id: String(id), confirm: 'tom-guard' }, session);
    await post({ code_action: 'ban', user_id: String(TOM) }, session);
  }
  await post({ code_action: 'delete', site_id: String(id), confirm: 'tom-guard', _confirmed: '0' });
  assert.equal(await n('SELECT COUNT(*) FROM `DB`.code_sites WHERE id = ? AND is_blocked = 0', [id]), 1);
  assert.equal(await n('SELECT COUNT(*) FROM `DB`.users WHERE id = ? AND code_banned_at IS NULL', [TOM]), 1);
});

test('review fixes: an empty limit keeps its saved value, a delete reason reaches the owner and the log, More code pages is logged', async () => {
  await post({ code_action: 'settings', max_on_pages: '2', max_files: '30', max_file_kb: '256', max_total_kb: '2048' });
  await post({ code_action: 'settings', max_on_pages: '', max_files: '30', max_file_kb: '256', max_total_kb: '2048' });
  assert.equal(JSON.parse(String((await sql("SELECT meta_value FROM `DB`.oys_meta WHERE meta_key = 'code_pages'"))[0].meta_value)).max_on_pages, 2, 'empty field keeps the value');
  await post({ code_action: 'settings', max_on_pages: '1', max_files: '30', max_file_kb: '256', max_total_kb: '2048' });
  // Der Löschdialog hat ein Feld für den Grund
  const id = await site(TOM, null, { 'index.html': '<p>r</p>' }, 3);
  const list = (await page()).html;
  assert.match(list, new RegExp(`<form[^>]*data-confirm="Delete “tom”\\?"[^>]*>(?:(?!</form>)[\\s\\S])*name="reason"(?:(?!</form>)[\\s\\S])*type="text"|<form[^>]*data-confirm="Delete “tom”\\?"[^>]*>(?:(?!</form>)[\\s\\S])*type="text"[^>]*name="reason"`));
  await post({ code_action: 'delete', site_id: String(id), confirm: 'tom', reason: 'Copyright' });
  assert.equal((await notes(TOM)).at(-1)?.body, 'tom: Copyright');
  assert.equal((await logOf()).reason, 'Copyright');
  const before = await n('SELECT COUNT(*) FROM `DB`.code_moderation');
  await post({ code_action: 'unlock', user_id: String(MIA), item: 'code_more' });
  assert.equal(await n('SELECT COUNT(*) FROM `DB`.code_moderation'), before + 1);
  assert.deepEqual({ ...(await logOf()) }, { action: 'unlock', address: '', reason: 'code_more', admin_id: ADMIN });
});

test('second review: More code pages can be unlocked from the form, a code page without an address is never deleted', async () => {
  const html = (await page()).html;
  const form = /<form[^>]*id="codeAccessForm"[\s\S]*?<\/form>/.exec(html)?.[0] ?? '';
  assert.match(form, /<select[^>]*name="item"[\s\S]*<option value="code_page"[\s\S]*<option value="code_more"/, 'the form chooses what to unlock');
  // Ohne Adresse (kein Platz zeigt sie): ein leeres „confirm“ löscht nichts
  const id = await site(TOM, null, { 'index.html': '<p>x</p>' });
  await post({ code_action: 'delete', site_id: String(id), confirm: '' });
  assert.equal(await n('SELECT COUNT(*) FROM `DB`.code_sites WHERE id = ?', [id]), 1);
  assert.equal(await flash(), 'A code page without an address can’t be deleted here – block it instead.');
});
