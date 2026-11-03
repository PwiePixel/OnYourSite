// CS-6: Code-Seiten-Plätze im Editor – Start des Editors (OYS_EDITOR.code, pages[].code, openSite) und der Weg aus dem
// Seitenwechsler: weitere Code-Seite anlegen (eigene Adresse, dann neue Seite auf einem Platz) und wieder löschen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { makeTestCtx } from '../src/web/ctx.js';
import { appRoutes } from '../src/app/dispatch.js';
import { CODE_SETTINGS_DEFAULTS, codeSettings } from '../src/code/settings.js';
import { ensureSchema, V_CODE_SLOTS_LIVE } from '../src/schema.js';
import { CSRF, loginSession, runRequest, testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
const q = async (s: string, p: unknown[] = []): Promise<RowDataPacket[]> => (await t.admin.query<RowDataPacket[]>(s, p))[0];
const n = async (sql: string, p: unknown[] = []): Promise<number> => Number(Object.values((await q(sql, p))[0])[0]);
const HOST = 'oys.test:8080';

before(async () => {
  t = await testDatabase('cs6ed');
  await t.admin.query('USE `' + t.name + '`');
  // Tom (6) hat Code-Seiten freigeschaltet und die Regeln akzeptiert; Mia (5) auch (für die Fremd-Prüfung)
  await q("INSERT INTO honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (5, 0, 'unlock', 'code_page', '', NOW()), (6, 0, 'unlock', 'code_page', '', NOW())");
  await q('UPDATE users SET code_terms_at = NOW() WHERE id IN (5, 6)');
});

after(async () => {
  await t.done();
});

async function api(userId: number, action: string, json?: unknown, csrf = CSRF): Promise<{ status: number; body: Record<string, unknown> }> {
  const sid = await loginSession(userId);
  const post = json !== undefined;
  const ctx = makeTestCtx({
    method: post ? 'POST' : 'GET',
    url: '/dashboard/api/' + action,
    host: HOST,
    headers: post ? { 'content-type': 'application/json', 'x-csrf-token': csrf } : {},
    cookies: { PHPSESSID: sid },
    rawBody: post ? Buffer.from(JSON.stringify(json)) : undefined,
  });
  await runRequest(ctx, appRoutes);
  return { status: ctx.status, body: JSON.parse(String(ctx.body)) as Record<string, unknown> };
}

// GET /dashboard: window.OYS_EDITOR
async function bootstrap(userId: number, query = ''): Promise<Record<string, unknown>> {
  const sid = await loginSession(userId);
  const ctx = await runRequest(makeTestCtx({ url: '/dashboard' + query, host: HOST, cookies: { PHPSESSID: sid } }), appRoutes);
  assert.equal(ctx.status, 200);
  const m = /window\.OYS_EDITOR = (.*);<\/script>/.exec(String(ctx.body));
  assert.ok(m, 'bootstrap script');
  return JSON.parse(m[1]) as Record<string, unknown>;
}
type Site = { id: number; kind: string; slug: string; url: string; title: string; slot: number | null; online: boolean; blocked: boolean };
type Summary = { unlocked: boolean; more: { unlocked: boolean; cost: number }; own: number; onPages: number; maxOnPages: number; total: number; sites: Site[] };

test('go-live default: one page slot per account may show a code page', async () => {
  assert.equal(CODE_SETTINGS_DEFAULTS.max_on_pages, 1);
  assert.equal((await codeSettings()).max_on_pages, 1);
});

test('schema step 18: a max_on_pages 0 saved while the feature was dark becomes 1, other values stay', async () => {
  const again = async (stored: string): Promise<string> => {
    await q("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('code_pages', ?)", [stored]);
    await q("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('schema_version', ?)", [String(V_CODE_SLOTS_LIVE - 1)]);
    await ensureSchema();
    return String((await q("SELECT meta_value FROM oys_meta WHERE meta_key = 'code_pages'"))[0].meta_value);
  };
  assert.deepEqual(JSON.parse(await again('{"max_on_pages":0,"max_files":12,"max_file_kb":256,"max_total_kb":2048,"paused":true}')),
    { max_on_pages: 1, max_files: 12, max_file_kb: 256, max_total_kb: 2048, paused: true });
  assert.equal((await codeSettings()).max_on_pages, 1);
  assert.equal(JSON.parse(await again('{"max_on_pages":2,"max_files":30}')).max_on_pages, 2);
  assert.equal(await again('{broken'), '{broken');
  assert.equal(await n("SELECT meta_value FROM oys_meta WHERE meta_key = 'schema_version'"), V_CODE_SLOTS_LIVE);
  await q("DELETE FROM oys_meta WHERE meta_key = 'code_pages'");
});

test('Your pages: add an own-address code page, then an extra one on a new page slot, then delete both', async () => {
  let e = await bootstrap(6);
  let code = e.code as Summary;
  assert.equal(code.unlocked, true);
  assert.deepEqual([code.own, code.onPages, code.maxOnPages, code.total, code.sites.length], [0, 0, 1, 0, 0]);
  assert.equal(e.openSite, null);

  // Erste Code-Seite: eigene Adresse
  let r = await api(6, 'code-create', { slug: 'tom-lab', title: 'Lab <b>', terms: true });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const own = (r.body.site as { id: number }).id;
  // Weitere Code-Seite (kostenlos, More code pages): eine neue Seite, die gleich die Code-Seite zeigt
  r = await api(6, 'code-connect', { slot: 'new', slug: 'tom-extra', title: 'Extra', terms: true });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const extra = (r.body.site as { id: number }).id;
  const slot = await n("SELECT id FROM pages WHERE slug = 'tom-extra' AND user_id = 6");
  assert.equal(await n('SELECT code_site_id FROM pages WHERE id = ?', [slot]), extra);

  e = await bootstrap(6);
  code = e.code as Summary;
  assert.deepEqual([code.own, code.onPages, code.total], [1, 1, 2]);
  assert.deepEqual(code.sites.map((s) => [s.id, s.kind, s.slug, s.slot]).sort(), [[own, 'own', 'tom-lab', null], [extra, 'page', 'tom-extra', slot]].sort());
  // Der Titel kommt als JSON-Text (kein HTML), die Adresse ist die Subdomain
  assert.equal(code.sites.find((s) => s.id === own)?.title, 'Lab <b>');
  assert.match(code.sites.find((s) => s.id === extra)?.url ?? '', /^https?:\/\/tom-extra\./);
  const pages = e.pages as Array<{ id: number; code: number | null; title: string }>;
  assert.deepEqual(pages.find((p) => p.id === slot)?.code, extra);
  assert.equal(pages.find((p) => p.id === slot)?.title, 'Extra');
  assert.equal(pages.find((p) => p.code === null)?.code, null);

  // openSite: ?site=ID (eigene Code-Seite) oder ?page=ID eines Platzes mit Code-Seite
  assert.equal((await bootstrap(6, '?site=' + own)).openSite, own);
  assert.equal((await bootstrap(6, '?page=' + slot)).openSite, extra);
  assert.equal((await bootstrap(6, '?site=999999')).openSite, null);

  // Ein dritter: E5 (nur ein Platz darf eine Code-Seite zeigen)
  r = await api(6, 'code-connect', { slot: 'new', slug: 'tom-third', title: 'Third', terms: true });
  assert.deepEqual(r.body, { ok: false, error: 'Only one of your pages can show a code page.' });

  // Löschen ohne CSRF: abgelehnt, nichts gelöscht
  r = await api(6, 'code-delete', { site: extra, confirm: 'tom-extra' }, 'wrong');
  assert.notEqual(r.body.ok, true);
  assert.equal(await n('SELECT COUNT(*) FROM code_sites WHERE id = ?', [extra]), 1);
  // Falsche Adresse getippt
  r = await api(6, 'code-delete', { site: extra, confirm: 'tom-lab' });
  assert.deepEqual(r.body, { ok: false, error: 'To confirm, please type the address of the code page.' });
  // Richtig: die Seite zeigt wieder ihre Link-Seite
  r = await api(6, 'code-delete', { site: extra, confirm: 'tom-extra' });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(await n('SELECT COUNT(*) FROM code_sites WHERE id = ?', [extra]), 0);
  assert.equal(await n('SELECT COUNT(*) FROM pages WHERE id = ? AND code_site_id IS NULL', [slot]), 1);
  r = await api(6, 'code-delete', { site: own, confirm: 'tom-lab' });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  code = (await bootstrap(6)).code as Summary;
  assert.deepEqual([code.own, code.onPages, code.total, code.sites.length], [0, 0, 0, 0]);
});

test('ownership: another account’s code page is never listed, opened or deleted', async () => {
  const r = await api(5, 'code-create', { slug: 'mia-lab', title: 'Mia Lab', terms: true });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const mias = (r.body.site as { id: number }).id;
  const e = await bootstrap(6, '?site=' + mias);
  assert.equal(e.openSite, null);
  assert.equal((e.code as Summary).sites.some((s) => s.id === mias), false);
  const del = await api(6, 'code-delete', { site: mias, confirm: 'mia-lab' });
  assert.equal(del.status, 409);
  assert.equal(await n('SELECT COUNT(*) FROM code_sites WHERE id = ?', [mias]), 1);
});
