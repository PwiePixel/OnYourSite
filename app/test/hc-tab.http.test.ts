// HTTP: der Bereich „Honeycombs“ im Editor (honeycomb-shop HC-4). Stand des Shops (Karten mit Preisen und Angeboten je
// Konto, gesperrte und kostenlose Karten, Besitz in der richtigen Reihenfolge, Admin-Modus, angehaltene Konten), Kaufen
// nach dem Vertrag der Kauf-Routen (409 reload, 400, 403 im Admin-Modus ohne jede Schreibung, Regeln, geänderter Preis,
// Erfolg mit dem neuen Stand, Wiederholung ohne zweite Abbuchung, Kennung für eine andere Option oder einen erstatteten
// Kauf → 409, Ratenlimit), der Verlauf seitenweise, unbekannte Aktionen, CSRF, Login – dazu die Leiste des Editors und
// der neue Abschnitt der Bedingungen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { randomHex } from '../src/crypto.js';
import { makeTestCtx, type Ctx } from '../src/web/ctx.js';
import { appRoutes } from '../src/app/dispatch.js';
import { ensureSchema } from '../src/schema.js';
import { addDays, nowStr } from '../src/honeycombs/clock.js';
import {
  premiumPerks, registerFeature, registerPerk, setLifecycleReadyForTests, unregisterFeatureForTests, unregisterPerksForTests, type Feature,
} from '../src/honeycombs/features.js';
import { premiumReady } from '../src/honeycombs/premium.js';
import { refund } from '../src/honeycombs/shop.js';
import { HONEYCOMBS_SECTION, termsView } from '../src/app/views/terms.js';
import { termsCodePagesView } from '../src/code/terms.js';
import '../src/code/shop.js';
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
const count = async (query: string, params: unknown[] = []): Promise<number> => Number((await sql(query, params))[0].n);

// Editor-API wie über den Server
async function api(action: string, o: { userId?: number; impersonatedBy?: number; json?: unknown; raw?: string; method?: string; csrf?: string | null } = {}): Promise<Ctx> {
  const sid = o.userId === undefined ? null : await loginSession(o.userId, { impersonatedBy: o.impersonatedBy });
  const method = o.method ?? 'POST';
  const headers: Record<string, string> = {};
  if (method === 'POST') headers['content-type'] = 'application/json';
  if (o.csrf !== null) headers['x-csrf-token'] = o.csrf ?? CSRF;
  const body = o.raw !== undefined ? Buffer.from(o.raw) : Buffer.from(JSON.stringify(o.json ?? {}));
  const ctx = makeTestCtx({ method, url: '/dashboard/api/' + action, headers, cookies: sid ? { PHPSESSID: sid } : undefined, rawBody: method === 'POST' ? body : undefined });
  return runRequest(ctx, appRoutes);
}
const buy = (userId: number, json: unknown, extra: { impersonatedBy?: number } = {}) => api('shop-buy', { userId, json, ...extra });
type Card = { feature: string; state: string; note: string; options: Array<Record<string, unknown>>; [k: string]: unknown };
type State = { balance: number; features: Card[]; owned: Array<Record<string, unknown>>; [k: string]: unknown };
async function shop(userId: number, extra: { impersonatedBy?: number } = {}): Promise<State> {
  const ctx = await api('shop', { userId, method: 'GET', ...extra });
  assert.equal(ctx.status, 200);
  const body = jsonBody(ctx);
  assert.equal(body.ok, true);
  return body.shop as State;
}
const card = (st: State, feature: string): Card | undefined => st.features.find((c) => c.feature === feature);

const TEST_FEATURES: Feature[] = [
  { key: 'test_badge', owner: 'test', title: 'Test badge', icon: 'bx-badge', description: 'A badge for tests.', kind: 'permanent', items: { test_badge: { price: 10, active: true } } },
  { key: 'test_addon', owner: 'test', title: 'Code add-on', icon: 'bx-plus', description: 'Needs the code page.', kind: 'permanent', requires: 'code_page', items: { test_addon: { price: 20, active: true } } },
  { key: 'test_free', owner: 'test', title: 'Free thing', icon: 'bx-gift', description: 'Free for everybody.', kind: 'permanent', freeAtZero: true, items: { test_free: { price: 0, active: true } } },
  { key: 'test_pack', owner: 'test', title: 'Extra checks', icon: 'bx-pulse', description: 'Stackable packs.', kind: 'timed', stack: 2, items: { test_pack_30: { days: 30, price: 60, active: true } } },
];

before(async () => {
  // Diese Abläufe prüfen zuerst den Stand vor HC-7a (zeitlich begrenzt gesperrt) und schalten es selbst ein
  setLifecycleReadyForTests(false);
  t = await testDatabase('hctab', { empty: true });
  await ensureSchema();
  const user = 'INSERT INTO `DB`.users (id, email, password, full_name, is_admin, created_at) VALUES (?, ?, \'x\', ?, ?, ?)';
  await sql(user, [3, 'admin@test.de', 'Pixel Admin', 1, OLD]);
  for (const id of [5, 6, 7, 8, 10, 11, 12]) await sql(user, [id, `u${id}@test.de`, 'User ' + id, 0, OLD]);
  await sql(user, [9, 'new@test.de', 'New user', 0, nowStr()]);
});

after(async () => {
  setLifecycleReadyForTests(true);
  for (const f of TEST_FEATURES) unregisterFeatureForTests(f.key);
  await t.done();
});

test('shop: login, CSRF and the state of an account (the code page card, no Premium while it is not ready)', async () => {
  assert.equal((await api('shop', { method: 'GET' })).status, 401);
  assert.equal((await api('shop', { userId: 5, json: {}, csrf: 'x'.repeat(64) })).status, 419);
  await give(5, 150);
  const st = await shop(5);
  assert.deepEqual(Object.keys(st), ['balance', 'frozen', 'frozenReason', 'readOnly', 'premium', 'features', 'owned', 'earn']);
  assert.equal(st.balance, 150);
  assert.deepEqual([st.frozen, st.frozenReason, st.readOnly], [false, '', false]);
  assert.deepEqual(st.premium, { active: false, until: null, forever: false, source: null, buyable: false });
  assert.deepEqual(st.features.map((c) => c.feature), ['code_page', 'status_page'], 'Premium stays hidden until it is ready and timed options can be sold (the status page card is in since ST-4)');
  const c = st.features[0];
  assert.deepEqual({ ...c, options: undefined }, {
    feature: 'code_page', title: 'Code page', icon: 'bx-code-alt', description: 'Your own website with HTML, CSS and JavaScript at its own address.', perks: [],
    href: '#code', kind: 'permanent', stack: 1, state: 'buy', note: '', quantity: 0, max: null, activeUntil: null, lotsActive: 0, needsTerms: true, options: undefined,
  });
  assert.deepEqual(c.options, [{ item: 'code_page', label: 'Unlock', days: null, units: 1, listPrice: 100, price: 100, offer: null, availableUntil: null, affordable: true, note: '' }]);
  assert.deepEqual(st.owned, []);
  const rules = (st.earn as { rules: Array<{ key: string; amount: number; progress: unknown }> }).rules;
  assert.deepEqual(rules.map((r) => [r.key, r.amount]), [['daily', 5], ['streak', 15], ['profile', 20], ['views', 10], ['codes', 0], ['gifts', 0]]);
  assert.deepEqual(rules.find((r) => r.key === 'views')?.progress, { value: 0, goal: 20 });
  // POST geht genauso (z. B. aus einem Formular), und der Kontostand zählt für „affordable“
  const poor = jsonBody(await api('shop', { userId: 9, json: {} })).shop as State;
  assert.equal(poor.features[0].options[0].affordable, false);
});

test('shop-buy: wrong method, 409 reload without request id or price, 400 for bad input, 403 in admin mode without writing anything', async () => {
  let ctx = await api('shop-buy', { userId: 5, method: 'GET' });
  assert.equal(ctx.status, 404);
  assert.deepEqual(jsonBody(ctx), { ok: false, error: 'Not found.' });
  const reload = { ok: false, error: 'OnYourSite was updated – please reload the editor.', reload: true };
  for (const json of [{ item: 'code_page', expected_price: 100 }, { item: 'code_page', request_id: rid() }, { item: 'code_page', request_id: '', expected_price: 100 }]) {
    ctx = await buy(5, { terms: true, ...json });
    assert.equal(ctx.status, 409, JSON.stringify(json));
    assert.deepEqual(jsonBody(ctx), reload);
  }
  const bad = { ok: false, error: 'Not all of the data arrived. Please try again.' };
  for (const json of [{ item: 'Code_page' }, { item: 5 }, { item: 'x' }, { item: ['code_page'] }, { request_id: rid().toUpperCase() }, { request_id: 'abc' },
    { expected_price: -1 }, { expected_price: 1.5 }, { expected_price: '1e3' }, { expected_price: true }, { expected_price: [100] }, { mode: 'both' }, { mode: 5 }]) {
    ctx = await buy(5, { item: 'code_page', request_id: rid(), expected_price: 100, terms: true, ...json });
    assert.equal(ctx.status, 400, JSON.stringify(json));
    assert.deepEqual(jsonBody(ctx), bad);
  }
  // Kaputtes JSON: die gemeinsame Vorprüfung der Editor-API
  ctx = await api('shop-buy', { userId: 5, raw: '{"item": "code_page",' });
  assert.equal(ctx.status, 400);
  ctx = await buy(5, { item: 'code_page', request_id: rid(), expected_price: 100, terms: true }, { impersonatedBy: 3 });
  assert.equal(ctx.status, 403);
  assert.deepEqual(jsonBody(ctx), { ok: false, code: 'admin_mode', error: 'Buying is turned off in admin mode.' });
  assert.equal(await count('SELECT COUNT(*) AS n FROM `DB`.hc_purchases WHERE user_id = 5'), 0);
  assert.equal(await count("SELECT COUNT(*) AS n FROM `DB`.honeycomb_ledger WHERE user_id = 5 AND reason = 'unlock'"), 0);
  assert.equal((await sql('SELECT code_terms_at FROM `DB`.users WHERE id = 5'))[0].code_terms_at, null);
  assert.equal(await count("SELECT COUNT(*) AS n FROM `DB`.rate_limits WHERE rl_key = 'hcbuy:5'"), 0, 'admin mode is refused before the rate limit counts');
  // Admin-Modus: der Stand ist nur zum Ansehen
  assert.equal((await shop(5, { impersonatedBy: 3 })).readOnly, true);
});

test('shop-buy: the rules, a changed price, success with the new state, a replay, and a request id used for another item or a refunded purchase', async () => {
  for (const f of TEST_FEATURES) registerFeature(f);
  await give(6, 300);
  let ctx = await buy(6, { item: 'code_page', request_id: rid(), expected_price: 100 });
  assert.deepEqual(jsonBody(ctx), { ok: false, code: 'rule', error: 'Please read and accept the rules for code pages first.' });
  ctx = await buy(6, { item: 'code_page', request_id: rid(), expected_price: 90, terms: true });
  assert.equal(ctx.status, 200);
  assert.deepEqual(jsonBody(ctx), { ok: false, code: 'price_changed', price: 100, error: 'The price changed – this now costs 100 honeycombs.' });
  const id = rid();
  ctx = await buy(6, { item: 'code_page', request_id: id, expected_price: '100', terms: true });
  assert.equal(ctx.status, 200);
  const body = jsonBody(ctx);
  assert.deepEqual(Object.keys(body), ['ok', 'purchase', 'notices', 'shop']);
  const purchase = body.purchase as Record<string, unknown>;
  assert.deepEqual({ ...purchase, id: 0 }, { id: 0, item: 'code_page', feature: 'code_page', title: 'Code page', price: 100, listPrice: 100, expiresAt: null, quantity: 1 });
  assert.deepEqual(body.notices, [{ tone: 'hc', text: 'Code page unlocked', amount: -100 }]);
  const st = body.shop as State;
  assert.equal(st.balance, 200);
  assert.equal(card(st, 'code_page')?.state, 'owned');
  assert.deepEqual(st.owned.map((o) => [o.feature, o.permanent, o.active, o.source]), [['code_page', true, true, 'purchase']]);
  // Die Erweiterung, die die Code-Seite braucht, ist jetzt zu kaufen
  assert.equal(card(st, 'test_addon')?.state, 'buy');
  assert.deepEqual((await sql('SELECT via, price FROM `DB`.hc_purchases WHERE user_id = 6')).map((r) => ({ ...r })), [{ via: 'shop', price: 100 }]);
  // Doppelklick: dieselbe Kennung noch einmal – Erfolg ohne zweite Abbuchung und ohne zweiten Hinweis
  ctx = await buy(6, { item: 'code_page', request_id: id, expected_price: 100, terms: true });
  assert.equal(jsonBody(ctx).ok, true);
  assert.deepEqual(jsonBody(ctx).notices, []);
  assert.equal((jsonBody(ctx).shop as State).balance, 200);
  assert.equal(await count("SELECT COUNT(*) AS n FROM `DB`.honeycomb_ledger WHERE user_id = 6 AND reason = 'unlock'"), 1);
  assert.equal(await count('SELECT COUNT(*) AS n FROM `DB`.hc_purchases WHERE user_id = 6'), 1);
  // Dieselbe Kennung für eine andere Option: 409, nichts gebucht
  ctx = await buy(6, { item: 'test_badge', request_id: id, expected_price: 10 });
  assert.equal(ctx.status, 409);
  assert.deepEqual(jsonBody(ctx), { ok: false, code: 'request_used', error: 'This request was already used. Please reload and try again.' });
  // Neue Kennung, schon freigeschaltet
  ctx = await buy(6, { item: 'code_page', request_id: rid(), expected_price: 100, terms: true });
  assert.deepEqual(jsonBody(ctx), { ok: false, code: 'owned', error: 'You already own this.' });
  // Erstattet: die alte Kennung bucht nicht noch einmal
  const pid = Number((await sql('SELECT id FROM `DB`.hc_purchases WHERE user_id = 6'))[0].id);
  assert.ok('ok' in (await refund(3, pid, null, true, '')));
  ctx = await buy(6, { item: 'code_page', request_id: id, expected_price: 100, terms: true });
  assert.equal(ctx.status, 409);
  assert.equal(jsonBody(ctx).code, 'request_used');
  assert.equal(card(await shop(6), 'code_page')?.state, 'buy', 'after a refund with removal the card can be bought again');
});

test('shop-buy: not enough honeycombs, an unknown option and the rate limit', async () => {
  await give(7, 50);
  let ctx = await buy(7, { item: 'code_page', request_id: rid(), expected_price: 100, terms: true });
  assert.deepEqual(jsonBody(ctx), { ok: false, code: 'balance', error: 'You need 100 honeycombs – you have 50.' });
  ctx = await buy(7, { item: 'nothing_here', request_id: rid(), expected_price: 1 });
  assert.deepEqual(jsonBody(ctx), { ok: false, code: 'unavailable', error: 'This isn’t available right now.' });
  // 20 Käufe in 10 Minuten je Konto (gemeinsam mit code-unlock)
  // Zeit der Seite (die Verbindung der Seite liest window_start in ihrer Zeitzone)
  await sql("INSERT INTO `DB`.rate_limits (rl_key, hits, window_start) VALUES ('hcbuy:8', 20, ?)", [nowStr()]);
  ctx = await buy(8, { item: 'code_page', request_id: rid(), expected_price: 100, terms: true });
  assert.equal(ctx.status, 200);
  assert.deepEqual(jsonBody(ctx), { ok: false, error: 'Too many purchases in a short time – please wait a moment.' });
});

test('shop: offers for this account, locked, free and requiring cards, the account age, frozen accounts', async () => {
  const label = 'Sale <img src=x onerror=alert(1)>';
  await sql(`INSERT INTO \`DB\`.hc_offers (label, scope, percent_off, fixed_price, starts_at, ends_at, max_uses, uses, per_user_max, min_account_days, min_active_days,
      cancelled_at, form_ref, created_by, created_at) VALUES (?, 'item:code_page', 30, NULL, ?, ?, NULL, 0, NULL, 30, 0, NULL, ?, 3, ?)`,
  [label, addDays(nowStr(), -1), '2030-01-01 00:00:00', randomHex(8), nowStr()]);
  await sql(`INSERT INTO \`DB\`.hc_offers (label, scope, percent_off, fixed_price, starts_at, ends_at, max_uses, uses, per_user_max, min_account_days, min_active_days,
      cancelled_at, form_ref, created_by, created_at) VALUES ('Badge deal', 'item:test_badge', NULL, 7, ?, '2030-01-01 00:00:00', NULL, 0, NULL, 0, 0, NULL, ?, 3, ?)`,
  [addDays(nowStr(), -1), randomHex(8), nowStr()]);
  const st = await shop(7);
  const code = card(st, 'code_page')!;
  // Der Text des Angebots kommt unverändert (der Editor maskiert ihn beim Zeichnen)
  assert.deepEqual(code.options[0], { item: 'code_page', label: 'Unlock', days: null, units: 1, listPrice: 100, price: 70,
    offer: { label, endsAt: '2030-01-01 00:00:00', percentOff: 30 }, availableUntil: null, affordable: false, note: '' });
  // 50 Honigwaben: zu wenig für 70, genug für den Sticker zum festen Preis
  assert.equal(st.balance, 50);
  assert.deepEqual(card(st, 'test_badge')?.options[0].offer, { label: 'Badge deal', endsAt: '2030-01-01 00:00:00', percentOff: 30 });
  assert.deepEqual([card(st, 'test_badge')?.options[0].price, card(st, 'test_badge')?.options[0].affordable], [7, true]);
  // Ohne Code-Seite: die Erweiterung ist gesperrt; kostenlose Funktionen haben keine Karte
  assert.deepEqual([card(st, 'test_addon')?.state, card(st, 'test_addon')?.note], ['locked', 'Needs your code page first.']);
  assert.equal(card(st, 'test_free'), undefined);
  // Zeitpakete ohne den Ablauf (HC-7a): keine Karte
  assert.equal(card(st, 'test_pack'), undefined);
  // Ein neues Konto bekommt das Angebot nicht (Mindestalter 30 Tage); eine Option mit Mindestalter ist gesperrt
  await sql("UPDATE `DB`.hc_items SET min_account_days = 14 WHERE item_key = 'test_badge'");
  const fresh = await shop(9);
  assert.equal(card(fresh, 'code_page')?.options[0].price, 100);
  assert.deepEqual([card(fresh, 'test_badge')?.state, card(fresh, 'test_badge')?.note, card(fresh, 'test_badge')?.options[0].note],
    ['locked', 'This is available once your account is 14 days old.', 'This is available once your account is 14 days old.']);
  // Vom Team angehalten
  await sql("INSERT INTO `DB`.hc_accounts (user_id, frozen_at, frozen_reason, created_at, updated_at) VALUES (11, NOW(), 'Checking your views', NOW(), NOW())");
  const frozen = await shop(11);
  assert.deepEqual([frozen.frozen, frozen.frozenReason], [true, 'Checking your views']);
  await sql('DELETE FROM `DB`.hc_offers');
});

test('shop: Premium when it is ready – included for admins, the account age floor, and what an account owns in order', async () => {
  // Bereit ist Premium mit dem Vorteil von premium-domains (content/branding.ts meldet ihn an); zeitlich begrenzte
  // Optionen erst mit dem Ablauf (HC-7a) – hier für den Test eingeschaltet
  const ownPerk = !premiumReady();
  if (ownPerk) registerPerk('premium', { owner: 'premium-domains', text: 'No OnYourSite branding on your pages', ready: () => true });
  setLifecycleReadyForTests(true);
  await sql("UPDATE `DB`.hc_items SET is_active = 1 WHERE feature = 'premium'");
  const admin = await shop(3);
  assert.deepEqual([card(admin, 'premium')?.state, card(admin, 'premium')?.note], ['included', 'Premium is included with your admin account.']);
  assert.deepEqual(admin.premium, { active: true, until: null, forever: true, source: 'admin-role', buyable: false });
  const fresh = card(await shop(9), 'premium')!;
  assert.deepEqual([fresh.state, fresh.note], ['locked', 'This is available once your account is 30 days old.']);
  assert.deepEqual(fresh.perks, premiumPerks().filter((p) => p.ready()).map((p) => p.text));
  assert.ok(fresh.perks.length >= 1);
  assert.deepEqual(fresh.options.map((o) => [o.item, o.label, o.price]), [['premium_30', '30 days', 350], ['premium_90', '90 days', 700]]);
  // Alt genug, aber nicht an 10 Tagen aktiv
  const inactive = card(await shop(10), 'premium')!;
  assert.equal(inactive.note, 'This is available once you’ve been active on 10 days.');
  // Besitz: aktive Zeitpakete (das zuerst endende zuerst), dann dauerhafte, dann beendete (≤ 90 Tage)
  const now = nowStr();
  const ent = 'INSERT INTO `DB`.hc_entitlements (user_id, feature, lot, quantity, permanent, expires_at, source, note, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)';
  await sql(ent, [12, 'premium', 0, 0, addDays(now, 10), 'admin', 'Thanks!', now, now]);
  await sql(ent, [12, 'code_page', 0, 1, null, 'purchase', '', now, now]);
  await sql(ent, [12, 'test_pack', 0, 0, addDays(now, -5), 'purchase', '', now, now]);
  await sql(ent, [12, 'test_pack', 1, 0, addDays(now, 2), 'purchase', '', now, now]);
  await sql('UPDATE `DB`.users SET premium_until = ? WHERE id = 12', [addDays(now, 10)]);
  const st = await shop(12);
  assert.deepEqual(st.owned.map((o) => [o.feature, o.lot, o.active, o.permanent, o.endsInDays, o.source]), [
    ['test_pack', 1, true, false, 2, 'purchase'], ['premium', 0, true, false, 10, 'admin'], ['code_page', 0, true, true, null, 'purchase'], ['test_pack', 0, false, false, null, 'purchase'],
  ]);
  assert.equal(st.owned[1].note, 'Thanks!');
  assert.deepEqual(st.premium, { active: true, until: addDays(now, 10), forever: false, source: 'admin', buyable: false });
  // Ein Paket von zweien aktiv: die Karte bietet weiter Kaufen an (neues Paket oder verlängern)
  const pack = card(st, 'test_pack')!;
  assert.deepEqual([pack.state, pack.lotsActive, pack.stack, pack.activeUntil], ['buy', 1, 2, addDays(now, 2)]);
  // Länger als 100 Tage beendet: nicht mehr in der Liste
  await sql('UPDATE `DB`.hc_entitlements SET expires_at = ? WHERE user_id = 12 AND feature = ? AND lot = 0', [addDays(now, -100), 'test_pack']);
  assert.equal((await shop(12)).owned.length, 3);
  await sql("UPDATE `DB`.hc_items SET is_active = 0 WHERE feature = 'premium'");
  setLifecycleReadyForTests(false);
  if (ownPerk) unregisterPerksForTests('premium-domains');
});

test('hc-history: pages of 20 with next, before as query or JSON, bad input and the rate limit', async () => {
  const now = nowStr();
  for (let i = 1; i <= 45; i++) {
    await sql("INSERT INTO `DB`.honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (10, ?, 'admin', ?, ?, ?)", [i, 'a3-' + randomHex(8), 'Gift ' + i, now]);
  }
  let ctx = await api('hc-history', { userId: 10, method: 'GET' });
  let body = jsonBody(ctx) as { ok: boolean; items: Array<{ id: number; amount: number; text: string; at: string }>; next: number | null };
  assert.equal(body.ok, true);
  assert.equal(body.items.length, 20);
  assert.deepEqual(Object.keys(body.items[0]), ['id', 'amount', 'text', 'at']);
  assert.deepEqual([body.items[0].amount, body.items[0].text, body.items[0].at], [45, 'Gift 45', now]);
  assert.equal(body.next, body.items[19].id);
  const ctx2 = runRequest(makeTestCtx({ url: '/dashboard/api/hc-history?before=' + body.next, cookies: { PHPSESSID: await loginSession(10) } }), appRoutes);
  body = jsonBody(await ctx2) as typeof body;
  assert.deepEqual([body.items.length, body.items[0].amount], [20, 25]);
  ctx = await api('hc-history', { userId: 10, json: { before: body.next } });
  body = jsonBody(ctx) as typeof body;
  assert.deepEqual([body.items.length, body.items[0].amount, body.items[4].amount, body.next], [5, 5, 1, null]);
  for (const before of [0, -1, 'abc', 1.5, [3]]) {
    ctx = await api('hc-history', { userId: 10, json: { before } });
    assert.equal(ctx.status, 400, JSON.stringify(before));
  }
  // Nur die eigenen Buchungen
  body = jsonBody(await api('hc-history', { userId: 9, method: 'GET' })) as typeof body;
  assert.deepEqual([body.items, body.next], [[], null]);
  await sql("INSERT INTO `DB`.rate_limits (rl_key, hits, window_start) VALUES ('hchist:10', 120, ?) ON DUPLICATE KEY UPDATE hits = 120, window_start = VALUES(window_start)", [nowStr()]);
  ctx = await api('hc-history', { userId: 10, method: 'GET' });
  assert.deepEqual(jsonBody(ctx), { ok: false, error: 'Too many requests – please wait a moment.' });
});

test('unknown actions of the area answer 404 (GET and POST)', async () => {
  // hc-redeem gibt es seit HC-9 (nur POST; GET bleibt 404, siehe hc-codes.http.test.ts)
  for (const action of ['shop-redeem', 'shop-auto-renew', 'shop-reminders', 'hc-foo']) {
    for (const method of ['GET', 'POST']) {
      const ctx = await api(action, { userId: 5, method });
      assert.equal(ctx.status, 404, action + ' ' + method);
      assert.deepEqual(jsonBody(ctx), { ok: false, error: 'Not found.' });
    }
  }
});

test('the editor has the Honeycombs tab (rail item only on the desktop) without the old honeycomb window', async () => {
  const ctx = await runRequest(makeTestCtx({ url: '/dashboard', cookies: { PHPSESSID: await loginSession(5) } }), appRoutes);
  const page = String(ctx.body);
  assert.match(page, /<button type="button" data-tab="honeycombs" class="nav-btn nav-desktop"><i class='bx bx-hive text-xl hc-icon'><\/i> <span class="hidden lg:block text-sm">Honeycombs<\/span><\/button>/);
  assert.equal(page.split('id="tab-honeycombs"').length, 2);
  // Reihenfolge der Leiste: … Code page, Honeycombs, Settings
  assert.ok(page.indexOf('data-tab="code"') < page.indexOf('data-tab="honeycombs"') && page.indexOf('data-tab="honeycombs"') < page.indexOf('data-tab="settings"'));
});

test('terms: the section “Honeycombs and Premium” once, and the code page terms link to it', () => {
  const page = termsView();
  assert.equal(page.split(HONEYCOMBS_SECTION).length, 2);
  assert.match(HONEYCOMBS_SECTION, /^<section id="honeycombs" class="scroll-mt-28">/);
  assert.match(HONEYCOMBS_SECTION, /<i class='bx bx-hive text-yellow-400 text-2xl'><\/i> 10\. Honeycombs and Premium/);
  for (const rule of ['no monetary value', 'A purchase keeps the price you paid.', 'your pages, content and settings are kept', 'only for the unused part', 'cheating']) {
    assert.ok(HONEYCOMBS_SECTION.includes(rule), rule);
  }
  assert.ok(page.includes('11. Modifications to Terms') && !page.includes('10. Modifications to Terms'));
  assert.match(termsCodePagesView(100), /<a href="\/terms#honeycombs" [^>]*>Honeycombs and Premium<\/a> in our general Terms\./);
});
