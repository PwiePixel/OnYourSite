// HTTP: code-unlock nach dem Vertrag der Kauf-Routen (409 reload ohne Anfrage-ID, 400, 403 im Admin-Modus ohne jede
// Schreibung, geänderter Preis, Erfolg mit Hinweis, Wiederholung, schon freigeschaltet, Regeln im Kauf, Ratenlimit,
// Methode, CSRF, Login) und der Preis aus dem Katalog im Code-Tab, im alten Honigwaben-Fenster, in den Bedingungen
// und im Admin (das bisherige Preisfeld schreibt jetzt den Katalog, mit Protokoll).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { randomHex } from '../src/crypto.js';
import { makeTestCtx, type Ctx } from '../src/web/ctx.js';
import { appRoutes } from '../src/app/dispatch.js';
import { ensureSchema } from '../src/schema.js';
import { addDays, nowStr } from '../src/honeycombs/clock.js';
import { CSRF, jsonBody, loginSession, runRequest, testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
const OLD = '2026-01-01 10:00:00';
const rid = (): string => randomHex(16);

async function sql(query: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [r] = await t.admin.query<RowDataPacket[]>(query.replace(/`DB`/g, '`' + t.name + '`'), params);
  return r;
}
async function give(uid: number, amount: number): Promise<void> {
  await sql("INSERT INTO `DB`.honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (?, ?, 'admin', ?, '', ?)", [uid, amount, 'a3-' + randomHex(8), nowStr()]);
}

// Editor-API wie über den Server
async function api(action: string, o: { userId?: number; impersonatedBy?: number; json?: unknown; method?: string; csrf?: string | null } = {}): Promise<Ctx> {
  const sid = o.userId === undefined ? null : await loginSession(o.userId, { impersonatedBy: o.impersonatedBy });
  const method = o.method ?? 'POST';
  const headers: Record<string, string> = {};
  if (method === 'POST') headers['content-type'] = 'application/json';
  if (o.csrf !== null) headers['x-csrf-token'] = o.csrf ?? CSRF;
  const ctx = makeTestCtx({ method, url: '/dashboard/api/' + action, headers, cookies: sid ? { PHPSESSID: sid } : undefined,
    rawBody: method === 'POST' ? Buffer.from(JSON.stringify(o.json ?? {})) : undefined });
  return runRequest(ctx, appRoutes);
}
const unlock = (userId: number, json: unknown, extra: { impersonatedBy?: number } = {}) => api('code-unlock', { userId, json, ...extra });

before(async () => {
  t = await testDatabase('hc3http', { empty: true });
  await ensureSchema();
  const user = 'INSERT INTO `DB`.users (id, email, password, full_name, is_admin, created_at) VALUES (?, ?, \'x\', ?, ?, ?)';
  await sql(user, [3, 'admin@test.de', 'Pixel Admin', 1, OLD]);
  for (const id of [5, 6, 7, 8]) await sql(user, [id, `u${id}@test.de`, 'User ' + id, 0, OLD]);
  await sql(user, [9, 'new@test.de', 'New user', 0, nowStr()]);
});

after(async () => {
  await t.done();
});

test('code-unlock: 409 reload without request id or price, 400 for bad input, 403 in admin mode without writing anything', async () => {
  await give(5, 300);
  const reload = { ok: false, error: 'OnYourSite was updated – please reload the editor.', reload: true };
  let ctx = await unlock(5, { terms: true });
  assert.equal(ctx.status, 409);
  assert.deepEqual(jsonBody(ctx), reload);
  ctx = await unlock(5, { terms: true, request_id: rid() });
  assert.equal(ctx.status, 409);
  assert.deepEqual(jsonBody(ctx), reload);
  ctx = await unlock(5, { terms: true, request_id: '', expected_price: 100 });
  assert.equal(ctx.status, 409);
  for (const bad of [{ request_id: 'xyz', expected_price: 100 }, { request_id: rid().toUpperCase(), expected_price: 100 }, { request_id: rid(), expected_price: 'abc' },
    { request_id: rid(), expected_price: -1 }, { request_id: rid(), expected_price: 1.5 }, { request_id: [rid()], expected_price: 100 }, { request_id: rid(), expected_price: true }]) {
    ctx = await unlock(5, { terms: true, ...bad });
    assert.equal(ctx.status, 400, JSON.stringify(bad));
    assert.deepEqual(jsonBody(ctx), { ok: false, error: 'Not all of the data arrived. Please try again.' });
  }
  ctx = await unlock(5, { terms: true, request_id: rid(), expected_price: 100 }, { impersonatedBy: 3 });
  assert.equal(ctx.status, 403);
  assert.deepEqual(jsonBody(ctx), { ok: false, code: 'admin_mode', error: 'Buying is turned off in admin mode.' });
  assert.equal((await sql('SELECT code_terms_at FROM `DB`.users WHERE id = 5'))[0].code_terms_at, null);
  assert.equal((await sql('SELECT COUNT(*) AS n FROM `DB`.hc_purchases WHERE user_id = 5'))[0].n, 0);
  assert.equal((await sql("SELECT COUNT(*) AS n FROM `DB`.honeycomb_ledger WHERE user_id = 5 AND reason = 'unlock'"))[0].n, 0);
});

test('code-unlock: a changed price, success with a notice, a replay and an unlock that is already there', async () => {
  let ctx = await unlock(5, { terms: true, request_id: rid(), expected_price: 90 });
  assert.equal(ctx.status, 200);
  assert.deepEqual(jsonBody(ctx), { ok: false, code: 'price_changed', price: 100, error: 'The price changed – this now costs 100 honeycombs.' });
  const id = rid();
  ctx = await unlock(5, { terms: true, request_id: id, expected_price: '100' });
  assert.equal(ctx.status, 200);
  const body = jsonBody(ctx);
  // Antwort wie bisher (Zustand des Code-Tabs) plus die Hinweise
  assert.deepEqual(Object.keys(body), ['ok', 'unlocked', 'terms', 'cost', 'balance', 'site', 'notices']);
  assert.deepEqual(body, { ok: true, unlocked: true, terms: true, cost: 100, balance: 200, site: null, notices: [{ tone: 'hc', text: 'Code page unlocked', amount: -100 }] });
  assert.notEqual((await sql('SELECT code_terms_at FROM `DB`.users WHERE id = 5'))[0].code_terms_at, null);
  // Dieselbe Anfrage noch einmal (Doppelklick): Erfolg ohne zweite Abbuchung, ohne zweiten Hinweis
  ctx = await unlock(5, { terms: true, request_id: id, expected_price: 100 });
  assert.deepEqual(jsonBody(ctx), { ok: true, unlocked: true, terms: true, cost: 100, balance: 200, site: null, notices: [] });
  // Neue Anfrage, schon freigeschaltet: Erfolg wie bisher, nichts gebucht
  ctx = await unlock(5, { terms: true, request_id: rid(), expected_price: 100 });
  assert.deepEqual(jsonBody(ctx), { ok: true, unlocked: true, terms: true, cost: 100, balance: 200, site: null });
  const rows = (await sql("SELECT reason, ref, amount FROM `DB`.honeycomb_ledger WHERE user_id = 5 AND reason = 'unlock'")).map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ reason: 'unlock', ref: 'code_page', amount: -100 }]);
  assert.deepEqual((await sql('SELECT request_id, via, price FROM `DB`.hc_purchases WHERE user_id = 5')).map((r) => ({ ...r })), [{ request_id: id, via: 'code', price: 100 }]);
});

test('code-unlock: the rules are accepted in the purchase, not enough honeycombs, method, CSRF, login and the rate limit', async () => {
  await give(6, 300);
  let ctx = await unlock(6, { request_id: rid(), expected_price: 100 });
  assert.deepEqual(jsonBody(ctx), { ok: false, code: 'rule', error: 'Please read and accept the rules for code pages first.' });
  assert.equal((await sql('SELECT code_terms_at FROM `DB`.users WHERE id = 6'))[0].code_terms_at, null);
  await give(7, 50);
  ctx = await unlock(7, { terms: true, request_id: rid(), expected_price: 100 });
  assert.deepEqual(jsonBody(ctx), { ok: false, code: 'balance', error: 'You need 100 honeycombs – you have 50.' });
  ctx = await api('code-unlock', { userId: 7, method: 'GET' });
  assert.equal(ctx.status, 404);
  assert.deepEqual(jsonBody(ctx), { ok: false, error: 'Not found.' });
  ctx = await api('code-unlock', { userId: 7, json: { terms: true, request_id: rid(), expected_price: 100 }, csrf: 'x'.repeat(64) });
  assert.equal(ctx.status, 419);
  ctx = await api('code-unlock', { json: { terms: true, request_id: rid(), expected_price: 100 } });
  assert.equal(ctx.status, 401);
  // 20 Käufe in 10 Minuten je Konto
  for (let i = 0; i < 20; i++) {
    ctx = await unlock(8, { terms: true, request_id: rid(), expected_price: 100 });
    assert.deepEqual(jsonBody(ctx), { ok: false, code: 'balance', error: 'You need 100 honeycombs – you have 0.' }, 'try ' + i);
  }
  ctx = await unlock(8, { terms: true, request_id: rid(), expected_price: 100 });
  assert.equal(ctx.status, 200);
  assert.deepEqual(jsonBody(ctx), { ok: false, error: 'Too many purchases in a short time – please wait a moment.' });
});

test('the code tab, the old honeycomb window and the terms page show the catalogue price, with an offer for the account', async () => {
  await sql(`INSERT INTO \`DB\`.hc_offers (label, scope, percent_off, fixed_price, starts_at, ends_at, max_uses, uses, per_user_max, min_account_days, min_active_days,
      cancelled_at, form_ref, created_by, created_at) VALUES ('Sale', 'item:code_page', 20, NULL, ?, ?, NULL, 0, NULL, 30, 0, NULL, ?, 3, ?)`,
  [addDays(nowStr(), -1), addDays(nowStr(), 3), randomHex(8), nowStr()]);
  let ctx = await api('code', { userId: 6, method: 'GET' });
  assert.equal(jsonBody(ctx).cost, 80);
  ctx = await api('code', { userId: 9, method: 'GET' });
  assert.equal(jsonBody(ctx).cost, 100, 'the offer needs accounts that are 30 days old');
  ctx = await api('honeycombs', { userId: 6, method: 'GET' });
  assert.equal((jsonBody(ctx).honeycombs as { rules: { code_page: number } }).rules.code_page, 80);
  // Gekauft wird zum Angebotspreis
  ctx = await unlock(6, { terms: true, request_id: rid(), expected_price: 80 });
  assert.equal(jsonBody(ctx).ok, true);
  assert.equal(jsonBody(ctx).balance, 220);
  const page = await runRequest(makeTestCtx({ url: '/terms/code-pages' }), appRoutes);
  assert.match(String(page.body), /\(currently 80\)/);
  await sql('DELETE FROM `DB`.hc_offers');
  const plain = await runRequest(makeTestCtx({ url: '/terms/code-pages' }), appRoutes);
  assert.match(String(plain.body), /\(currently 100\)/);
});

test('admin: the code page price field now sets the catalogue price (with an audit row), and both admin sections show it', async () => {
  const sid = await loginSession(3);
  const post = { csrf: CSRF, hc_action: 'settings', daily: '5', profile: '20', views: '10', views_step: '100', code_page: '150' };
  const ctx = await runRequest(makeTestCtx({ method: 'POST', url: '/admin', cookies: { PHPSESSID: sid }, post }), appRoutes);
  assert.equal(ctx.status, 302);
  assert.equal(Number((await sql("SELECT price FROM `DB`.hc_items WHERE item_key = 'code_page'"))[0].price), 150);
  const audit = (await sql("SELECT admin_id, action, user_id, target, details FROM `DB`.hc_audit WHERE action = 'item_save'")).map((r) => ({ ...r }));
  assert.deepEqual(audit, [{ admin_id: 3, action: 'item_save', user_id: null, target: 'code_page', details: '{"old":100,"new":150}' }]);
  // Gleicher Preis noch einmal: kein zweiter Eintrag
  await runRequest(makeTestCtx({ method: 'POST', url: '/admin', cookies: { PHPSESSID: await loginSession(3) }, post }), appRoutes);
  assert.equal((await sql("SELECT COUNT(*) AS n FROM `DB`.hc_audit WHERE action = 'item_save'"))[0].n, 1);
  const view = await runRequest(makeTestCtx({ url: '/admin', cookies: { PHPSESSID: await loginSession(3) } }), appRoutes);
  const html = String(view.body);
  assert.match(html, /name="code_page" min="0" max="100000" step="1" value="150"/);
  assert.match(html, /id="codePrice">150 <i class='bx bx-hive text-yellow-400'><\/i>/);
  assert.equal(jsonBody(await api('code', { userId: 7, method: 'GET' })).cost, 150);
});
