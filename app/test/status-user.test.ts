// Statusseiten für Nutzer (ST-4): die Freischaltung `status_page` im Shop (150, dauerhaft, für Admins dabei), die
// Grenzen (Plan 'none' ohne, 'free' mit Freischaltung), der Bereich „Status“ im Editor nur mit Freischaltung, eigene
// Seite anlegen (Adresse über die Liste aller Adressen), Bestandteile innerhalb der Grenze, ändern, löschen (Adresse
// bleibt für den Besitzer reserviert) – nie OnYourSites oder eine fremde Seite. Dazu die öffentliche Seite.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { makeTestCtx, type Ctx } from '../src/web/ctx.js';
import { appRoutes } from '../src/app/dispatch.js';
import { ensureSchema } from '../src/schema.js';
import { feature } from '../src/honeycombs/features.js';
import { nowStr } from '../src/honeycombs/clock.js';
import { statusLimits } from '../src/status/limits.js';
import '../src/status/shop.js';
import { CSRF, jsonBody, loginSession, runRequest, testDatabase, type TestDb } from './coreHarness.js';
import { randomHex } from '../src/crypto.js';
import { deleteAccount } from '../src/admin/accountDeletion.js';

let t: TestDb;
const OLD = '2026-01-01 10:00:00';
const ADMIN = 3;
const MIA = 5;
const BEN = 6;
const POOR = 7;

async function sql(query: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [r] = await t.admin.query<RowDataPacket[]>(query.replace(/`DB`/g, '`' + t.name + '`'), params);
  return r;
}
async function give(uid: number, amount: number): Promise<void> {
  await sql("INSERT INTO `DB`.honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (?, ?, 'admin', ?, '', ?)", [uid, amount, 'st4-' + randomHex(8), nowStr()]);
}

async function api(action: string, o: { userId?: number; impersonatedBy?: number; json?: Record<string, unknown>; method?: string; csrf?: string | null; query?: string } = {}): Promise<Ctx> {
  const sid = o.userId === undefined ? null : await loginSession(o.userId, { impersonatedBy: o.impersonatedBy });
  const method = o.method ?? 'POST';
  const headers: Record<string, string> = {};
  if (method === 'POST') headers['content-type'] = 'application/json';
  if (o.csrf !== null) headers['x-csrf-token'] = o.csrf ?? CSRF;
  const ctx = makeTestCtx({ method, url: '/dashboard/api/' + action + (o.query ?? ''), headers, cookies: sid ? { PHPSESSID: sid } : undefined,
    rawBody: method === 'POST' ? Buffer.from(JSON.stringify(o.json ?? {})) : undefined });
  return runRequest(ctx, appRoutes);
}
const body = (ctx: Ctx): Record<string, any> => jsonBody(ctx) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const buy = (uid: number) => api('shop-buy', { userId: uid, json: { item: 'status_page', request_id: randomHex(16), expected_price: 150 } });

before(async () => {
  t = await testDatabase('st4user', { empty: true });
  await ensureSchema();
  const user = 'INSERT INTO `DB`.users (id, email, password, full_name, is_admin, created_at) VALUES (?, ?, \'x\', ?, ?, ?)';
  await sql(user, [ADMIN, 'admin@test.de', 'Pixel Admin', 1, OLD]);
  for (const id of [MIA, BEN, POOR]) await sql(user, [id, `u${id}@test.de`, 'User ' + id, 0, OLD]);
});

after(async () => {
  await t.done();
});

test('status_page is registered: permanent, 150 honeycombs, included for admins, opens the Status tab', () => {
  const f = feature('status_page');
  assert.ok(f);
  assert.equal(f.kind, 'permanent');
  assert.deepEqual(f.items, { status_page: { price: 150, active: true } });
  assert.equal(f.href, '#status');
  assert.equal(f.includedFor?.({ is_admin: 1 }), true);
  assert.equal(f.includedFor?.({ is_admin: 0 }), false);
});

test('limits: plan none without the unlock, free with it; admins have it included', async () => {
  assert.equal((await statusLimits(MIA)).plan, 'none');
  assert.equal((await statusLimits(MIA)).checks, 0);
  assert.equal((await statusLimits(ADMIN)).plan, 'free');
  assert.equal((await statusLimits(null)).plan, 'system');
});

test('shop: the card is shown, a purchase unlocks the Status tab; without the unlock the user scope is locked', async () => {
  let ctx = await api('shop', { userId: MIA, method: 'GET' });
  assert.equal(ctx.status, 200);
  const card = JSON.stringify(body(ctx)).includes('"status_page"');
  assert.ok(card, 'the status page card is in the shop');
  ctx = await api('status', { userId: MIA, method: 'GET' });
  assert.equal(ctx.status, 403);
  assert.deepEqual(body(ctx), { ok: false, error: 'Unlock status pages with honeycombs first.' });
  ctx = await api('status-create', { userId: MIA, json: { title: 'Mine', slug: 'mia-status' } });
  assert.equal(ctx.status, 403);
  // Ohne genug Honigwaben: nichts gebucht
  ctx = await buy(POOR);
  assert.equal(body(ctx).ok, false);
  assert.equal(body(ctx).code, 'balance');
  await give(MIA, 200);
  ctx = await buy(MIA);
  assert.equal(ctx.status, 200, JSON.stringify(body(ctx)));
  assert.equal(body(ctx).ok, true);
  assert.equal((await statusLimits(MIA)).plan, 'free');
  assert.equal((await statusLimits(MIA)).checks, 10);
  // Zweiter Kauf: schon freigeschaltet, nichts doppelt abgebucht
  ctx = await buy(MIA);
  assert.equal(Number((await sql('SELECT SUM(amount) AS s FROM `DB`.honeycomb_ledger WHERE user_id = ?', [MIA]))[0].s), 50);
  // Editor: Bereich „Status“ für Mia, nicht für Ben
  const dash = makeTestCtx({ method: 'GET', url: '/dashboard', cookies: { PHPSESSID: await loginSession(MIA) } });
  const html = String((await runRequest(dash, appRoutes)).body);
  assert.match(html, /data-tab="status"/);
  assert.match(html, /"statusUser":true/);
  // Auf dem Handy führt die Zeile in den Einstellungen in den Bereich (der Knopf im Menü ist nur breit sichtbar)
  assert.match(html, /id="statusSettingsRow"[\s\S]*?Status page<\/h3>[\s\S]*?data-open-status/);
  assert.doesNotMatch(html, /OnYourSite’s own status page/);
  const benDash = await runRequest(makeTestCtx({ method: 'GET', url: '/dashboard', cookies: { PHPSESSID: await loginSession(BEN) } }), appRoutes);
  assert.doesNotMatch(String(benDash.body), /data-tab="status"/);
});

test('create: name and address through the address registry; one page per account; address rules', async () => {
  let ctx = await api('status', { userId: MIA, method: 'GET' });
  assert.equal(ctx.status, 200);
  assert.deepEqual(body(ctx), { ok: true, scope: 'user', page: null, limits: { checks: 10, components: 40, minInterval: 180 } });
  ctx = await api('status-create', { userId: MIA, csrf: null, json: { title: 'Mine', slug: 'mia-status' } });
  assert.equal(ctx.status, 419, 'CSRF on every change');
  ctx = await api('status-create', { userId: MIA, json: { title: '', slug: 'mia-status' } });
  assert.deepEqual(body(ctx), { ok: false, error: 'Please give the page a name.', field: 'title' });
  ctx = await api('status-create', { userId: MIA, json: { title: 'Mine', slug: 'status' } });
  assert.equal(body(ctx).ok, false);
  assert.equal(body(ctx).field, 'slug', 'OnYourSite’s own status address is taken');
  ctx = await api('status-create', { userId: MIA, json: { title: 'Mine', slug: 'paypal-status' } });
  assert.equal(body(ctx).field, 'slug', 'no brand names in status addresses');
  ctx = await api('status-create', { userId: MIA, json: { title: '<b>Mia</b> status', slug: 'mia-status' } });
  assert.equal(ctx.status, 200, JSON.stringify(body(ctx)));
  assert.equal(body(ctx).scope, 'user');
  assert.equal(body(ctx).page.slug, 'mia-status');
  const rows = await sql('SELECT id, user_id, is_system FROM `DB`.status_pages WHERE slug = ?', ['mia-status']);
  assert.equal(Number(rows[0].user_id), MIA);
  assert.equal(Number(rows[0].is_system), 0);
  const addr = await sql('SELECT kind, ref_id, user_id FROM `DB`.site_addresses WHERE slug = ?', ['mia-status']);
  assert.deepEqual({ kind: addr[0].kind, ref: Number(addr[0].ref_id), user: Number(addr[0].user_id) }, { kind: 'status', ref: Number(rows[0].id), user: MIA });
  ctx = await api('status-create', { userId: MIA, json: { title: 'Second', slug: 'mia-two' } });
  assert.deepEqual(body(ctx), { ok: false, error: 'You already have a status page.' });
  // Das Admin-Konto bekommt die Adresse eines anderen nicht
  ctx = await api('status-create', { userId: ADMIN, json: { title: 'Taken', slug: 'mia-status' } });
  assert.equal(body(ctx).ok, false);
  assert.equal(body(ctx).field, 'slug');
});

test('components within the limits; never the system page or another account’s page', async () => {
  const mine = Number((await sql('SELECT id FROM `DB`.status_pages WHERE user_id = ?', [MIA]))[0].id);
  const sys = Number((await sql('SELECT id FROM `DB`.status_pages WHERE is_system = 1'))[0].id);
  let ctx = await api('status-monitor-save', { userId: MIA, json: { type: 'manual', name: 'API', manual_status: 'operational' } });
  assert.equal(ctx.status, 200, JSON.stringify(body(ctx)));
  const monitors = await sql('SELECT id, page_id, user_id FROM `DB`.status_monitors WHERE page_id = ?', [mine]);
  assert.equal(monitors.length, 1);
  assert.equal(Number(monitors[0].user_id), MIA);
  // Eine SSRF-Adresse wird abgelehnt (geprüfter Prüfdienst)
  ctx = await api('status-monitor-save', { userId: MIA, json: { type: 'http', name: 'Local', target: 'http://127.0.0.1/', interval: 300 } });
  assert.equal(body(ctx).ok, false);
  // Fremde Bestandteile (OnYourSites Seite) sind für Mia nicht da
  const sysMon = await sql('SELECT id FROM `DB`.status_monitors WHERE page_id = ? LIMIT 1', [sys]);
  if (sysMon.length) {
    ctx = await api('status-monitor-delete', { userId: MIA, json: { id: Number(sysMon[0].id) } });
    assert.equal(ctx.status, 404);
    assert.equal((await sql('SELECT COUNT(*) AS n FROM `DB`.status_monitors WHERE id = ?', [Number(sysMon[0].id)]))[0].n, 1);
  }
  // Die Seite ändern: nur die eigene
  ctx = await api('status-page', { userId: MIA, json: { title: 'Mia’s services' } });
  assert.equal(ctx.status, 200);
  assert.equal(body(ctx).page.title, 'Mia’s services');
  assert.equal((await sql('SELECT title FROM `DB`.status_pages WHERE id = ?', [sys]))[0].title, 'OnYourSite status');
  // Ben (nicht freigeschaltet) erreicht Mias Seite nie
  ctx = await api('status-monitors', { userId: BEN, method: 'GET' });
  assert.equal(ctx.status, 403);
  // Nur OnYourSites Seite kennt Admin-Alarme und Bot-Kanäle
  ctx = await api('status-alerts', { userId: MIA, method: 'GET' });
  assert.equal(ctx.status, 403);
  ctx = await api('status-bot-channels', { userId: MIA, json: {} });
  assert.equal(ctx.status, 403);
  // scope=system bleibt für Nutzer verboten
  ctx = await api('status', { userId: MIA, method: 'GET', query: '?scope=system' });
  assert.equal(ctx.status, 403);
});

test('delete: the page and its rows go, the address stays reserved for the owner', async () => {
  const mine = Number((await sql('SELECT id FROM `DB`.status_pages WHERE user_id = ?', [MIA]))[0].id);
  let ctx = await api('status-page-delete', { userId: MIA, csrf: null, json: {} });
  assert.equal(ctx.status, 419);
  ctx = await api('status-page-delete', { userId: MIA, json: {} });
  assert.equal(ctx.status, 200, JSON.stringify(body(ctx)));
  assert.equal(body(ctx).page, null);
  assert.equal((await sql('SELECT COUNT(*) AS n FROM `DB`.status_pages WHERE id = ?', [mine]))[0].n, 0);
  assert.equal((await sql('SELECT COUNT(*) AS n FROM `DB`.status_monitors WHERE page_id = ?', [mine]))[0].n, 0);
  assert.ok((await sql("SELECT COUNT(*) AS n FROM `DB`.status_purge WHERE kind = 'page' AND ref_id = ?", [mine]))[0].n >= 1);
  const addr = await sql('SELECT kind, user_id FROM `DB`.site_addresses WHERE slug = ?', ['mia-status']);
  assert.equal(addr[0].kind, 'held');
  assert.equal(Number(addr[0].user_id), MIA);
  // Ein anderes Konto bekommt die reservierte Adresse nicht, die Besitzerin schon
  ctx = await api('status-create', { userId: ADMIN, json: { title: 'Grab', slug: 'mia-status' } });
  assert.equal(body(ctx).field, 'slug');
  ctx = await api('status-create', { userId: MIA, json: { title: 'Back', slug: 'mia-status' } });
  assert.equal(ctx.status, 200, JSON.stringify(body(ctx)));
});

test('race: two accounts create a page with the same address at once – exactly one gets it', async () => {
  await give(BEN, 150);
  assert.equal(body(await buy(BEN)).ok, true);
  const [a, b] = await Promise.all([
    api('status-create', { userId: BEN, json: { title: 'Ben', slug: 'race-status' } }),
    api('status-create', { userId: ADMIN, json: { title: 'Admin', slug: 'race-status' } }),
  ]);
  const oks = [a, b].filter((c) => body(c).ok === true);
  assert.equal(oks.length, 1, JSON.stringify([body(a), body(b)]));
  const loser = [a, b].find((c) => body(c).ok !== true)!;
  assert.equal(body(loser).field, 'slug');
  assert.equal((await sql("SELECT COUNT(*) AS n FROM `DB`.status_pages WHERE slug = 'race-status'"))[0].n, 1);
  const owner = Number((await sql("SELECT user_id FROM `DB`.status_pages WHERE slug = 'race-status'"))[0].user_id);
  const addr = await sql("SELECT kind, user_id FROM `DB`.site_addresses WHERE slug = 'race-status'");
  assert.deepEqual({ kind: addr[0].kind, user: Number(addr[0].user_id) }, { kind: 'status', user: owner });
});

test('deleting an account removes its status page with everything on it; OnYourSite\u2019s page stays', async () => {
  const GONE = 8;
  await sql('INSERT INTO `DB`.users (id, email, password, full_name, is_admin, created_at) VALUES (?, ?, \'x\', ?, 0, ?)', [GONE, 'gone@test.de', 'Gone User', OLD]);
  await give(GONE, 500);
  assert.equal((await buy(GONE)).status, 200);
  let ctx = await api('status-create', { userId: GONE, json: { title: 'Gone status', slug: 'gone-status' } });
  assert.equal(ctx.status, 200, JSON.stringify(body(ctx)));
  const page = Number((await sql('SELECT id FROM `DB`.status_pages WHERE user_id = ?', [GONE]))[0].id);
  ctx = await api('status-monitor-save', { userId: GONE, json: { type: 'manual', name: 'API', manual_status: 'operational' } });
  assert.equal(ctx.status, 200, JSON.stringify(body(ctx)));
  const monitor = Number((await sql('SELECT id FROM `DB`.status_monitors WHERE page_id = ?', [page]))[0].id);
  const t0 = Math.floor(Date.now() / 1000);
  // Eine offene Benachrichtigung an die Besitzerin (darf das Konto nicht überleben)
  await sql("INSERT INTO `DB`.status_outbox (page_id, monitor_id, kind, channel, event, payload, next_at, created_at) VALUES (?, ?, 'alert', 'owner', 'down', '{}', ?, ?)", [page, monitor, t0, t0]);
  const system = await sql('SELECT COUNT(*) AS n FROM `DB`.status_pages WHERE is_system = 1');
  await deleteAccount(null, GONE);
  for (const [table, where] of [['status_pages', 'id'], ['status_monitors', 'page_id'], ['status_outbox', 'page_id'], ['status_channels', 'page_id'], ['status_incidents', 'page_id']] as const) {
    assert.equal(Number((await sql(`SELECT COUNT(*) AS n FROM \`DB\`.${table} WHERE ${where} = ?`, [page]))[0].n), 0, table);
  }
  assert.ok(Number((await sql("SELECT COUNT(*) AS n FROM `DB`.status_purge WHERE kind = 'monitor' AND ref_id = ?", [monitor]))[0].n) >= 1);
  assert.ok(Number((await sql("SELECT COUNT(*) AS n FROM `DB`.status_purge WHERE kind = 'page' AND ref_id = ?", [page]))[0].n) >= 1);
  assert.deepEqual(await sql('SELECT COUNT(*) AS n FROM `DB`.status_pages WHERE is_system = 1'), system);
  assert.equal(Number((await sql('SELECT COUNT(*) AS n FROM `DB`.users WHERE id = ?', [GONE]))[0].n), 0);
});
