// Statusseiten: Zusatzpakete und Premium (ST-7). Grenzen aus den Einstellungen und dem Besitz (frei 10 Prüfungen/3 min,
// je Paket „Extra checks“ +10 bis 30, „Fast checks“ jede Minute, Premium 30 und jede Minute mit 250 Abonnenten; das
// früheste Ende), die Regeln beim Kauf (Seite nötig, gesperrt, Prüfungen vom Team pausiert, Premium für immer), der
// Abgleich nach jeder Änderung (eine Glocke je Wechsel der pausierten Prüfungen, zweimal = nichts Neues, über den
// Abgleich des Shops), der Vorteil in Premium und „Made with OnYourSite“ auf der Statusseite (nur mit Premium aus).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { makeTestCtx, type Ctx } from '../src/web/ctx.js';
import { appRoutes } from '../src/app/dispatch.js';
import { ensureSchema } from '../src/schema.js';
import { addDays, nowStr } from '../src/honeycombs/clock.js';
import { randomHex } from '../src/crypto.js';
import { premiumPerks, setLifecycleReadyForTests } from '../src/honeycombs/features.js';
import { buy } from '../src/honeycombs/shop.js';
import { grantFeature } from '../src/honeycombs/grants.js';
import { statusSettings } from '../src/status/settings.js';
import { planLimits, statusLimits } from '../src/status/limits.js';
import { limitNotice, refreshStatusLimits } from '../src/status/limitsSync.js';
import { dispatch } from '../src/router.js';
import '../src/status/shop.js';
import { CSRF, jsonBody, loginSession, runRequest, testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
const OLD = '2026-01-01 10:00:00';
const ADMIN = 3;
const MIA = 5;
const BEN = 6;
let pageId = 0;

async function sql(query: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [r] = await t.admin.query<RowDataPacket[]>(query.replace(/`DB`/g, '`' + t.name + '`'), params);
  return r;
}
const n = async (query: string, params: unknown[] = []): Promise<number> => Number(Object.values((await sql(query, params))[0])[0]);
async function api(action: string, o: { userId?: number; json?: Record<string, unknown>; method?: string } = {}): Promise<Ctx> {
  const sid = await loginSession(o.userId ?? MIA);
  const method = o.method ?? 'POST';
  const headers: Record<string, string> = method === 'POST' ? { 'content-type': 'application/json', 'x-csrf-token': CSRF } : {};
  return runRequest(makeTestCtx({ method, url: '/dashboard/api/' + action, headers, cookies: { PHPSESSID: sid }, rawBody: method === 'POST' ? Buffer.from(JSON.stringify(o.json ?? {})) : undefined }), appRoutes);
}
const body = (ctx: Ctx): Record<string, any> => jsonBody(ctx) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function lot(uid: number, key: string, lotNo: number, days: number): Promise<void> {
  await sql(`INSERT INTO \`DB\`.hc_entitlements (user_id, feature, lot, quantity, permanent, expires_at, source, created_at, updated_at)
      VALUES (?, ?, ?, 1, 0, ?, 'purchase', ?, ?)`, [uid, key, lotNo, addDays(nowStr(), days), OLD, OLD]);
}
async function premium(uid: number, until: string | null): Promise<void> {
  await sql('UPDATE `DB`.users SET premium_until = ? WHERE id = ?', [until, uid]);
  await sql('DELETE FROM `DB`.hc_entitlements WHERE user_id = ? AND feature = ?', [uid, 'premium']);
  if (until !== null) {
    await sql(`INSERT INTO \`DB\`.hc_entitlements (user_id, feature, lot, quantity, permanent, expires_at, source, created_at, updated_at)
      VALUES (?, 'premium', 0, 1, ?, ?, 'admin', ?, ?)`, [uid, until.startsWith('9999') ? 1 : 0, until.startsWith('9999') ? null : until, OLD, OLD]);
  }
}
async function addChecks(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await sql(`INSERT INTO \`DB\`.status_monitors (page_id, user_id, type, name, is_public, target, config, interval_s, position, changed_at, created_at, updated_at)
      VALUES (?, ?, 'http', ?, 1, 'https://example.com/', '{}', 300, ?, 0, NOW(), NOW())`, [pageId, MIA, 'Check ' + i, i]);
  }
}

before(async () => {
  setLifecycleReadyForTests(true);
  t = await testDatabase('st7addons', { empty: true });
  await ensureSchema();
  const user = 'INSERT INTO `DB`.users (id, email, password, full_name, is_admin, created_at, status_terms_at) VALUES (?, ?, \'x\', ?, ?, ?, NOW())';
  await sql(user, [ADMIN, 'admin@test.de', 'Pixel Admin', 1, OLD]);
  for (const id of [MIA, BEN]) await sql(user, [id, `u${id}@test.de`, 'User ' + id, 0, OLD]);
  for (const id of [MIA, BEN]) {
    await sql(`INSERT INTO \`DB\`.hc_entitlements (user_id, feature, lot, quantity, permanent, expires_at, source, created_at, updated_at) VALUES (?, 'status_page', 0, 1, 1, NULL, 'admin', ?, ?)`, [id, OLD, OLD]);
  }
  assert.equal(body(await api('status-create', { json: { title: 'Mia status', slug: 'mia-status' } })).ok, true);
  pageId = await n('SELECT id FROM `DB`.status_pages WHERE user_id = ?', [MIA]);
});

beforeEach(async () => {
  await sql("DELETE FROM `DB`.hc_entitlements WHERE feature IN ('status_more_checks', 'status_fast_checks', 'premium')");
  await sql('UPDATE `DB`.users SET premium_until = NULL');
  await sql('DELETE FROM `DB`.status_monitors WHERE page_id = ?', [pageId]);
  await sql('UPDATE `DB`.status_pages SET limit_paused = 0, is_blocked = 0, settings = ? WHERE id = ?', ['{}', pageId]);
  await sql('DELETE FROM `DB`.notifications');
});

after(async () => {
  await t.done();
});

test('limits: free, one and two packs, fast checks, Premium; the earliest end', async () => {
  const s = await statusSettings();
  const none = { packs: 0, packsUntil: [], fast: false, fastUntil: null, premium: false, premiumUntil: null };
  const pick = (l: ReturnType<typeof planLimits>) => [l.plan, l.checks, l.minInterval, l.channels, l.subscribers, l.broadcastsDay, l.until];
  assert.deepEqual(pick(planLimits(s, none)), ['free', 10, 180, 3, 50, 3, null]);
  assert.deepEqual(pick(planLimits(s, { ...none, packs: 1, packsUntil: ['2026-12-01 10:00:00'] })), ['addons', 20, 180, 3, 50, 3, '2026-12-01 10:00:00']);
  assert.deepEqual(pick(planLimits(s, { ...none, packs: 3, packsUntil: ['2026-12-05 10:00:00', '2026-12-02 10:00:00'] })), ['addons', 30, 180, 3, 50, 3, '2026-12-02 10:00:00'], 'at most 2 packs');
  assert.deepEqual(pick(planLimits(s, { ...none, fast: true, fastUntil: '2026-12-09 10:00:00' })), ['addons', 10, 60, 3, 50, 3, '2026-12-09 10:00:00']);
  assert.deepEqual(pick(planLimits(s, { ...none, premium: true })), ['premium', 30, 60, 3, 250, 3, null], 'Premium for good: no end; channels and broadcasts stay (Q1 = b)');
  // Aus der Datenbank
  assert.equal((await statusLimits(MIA)).checks, 10);
  await lot(MIA, 'status_more_checks', 0, 10);
  await lot(MIA, 'status_more_checks', 1, 20);
  await lot(MIA, 'status_fast_checks', 0, 5);
  let l = await statusLimits(MIA);
  assert.deepEqual([l.plan, l.checks, l.minInterval, l.until?.slice(0, 10)], ['addons', 30, 60, addDays(nowStr(), 5).slice(0, 10)]);
  await sql("UPDATE `DB`.hc_entitlements SET expires_at = ? WHERE user_id = ? AND feature = 'status_more_checks' AND lot = 1", [addDays(nowStr(), -1), MIA]);
  l = await statusLimits(MIA);
  assert.equal(l.checks, 20, 'an ended pack counts no more');
  await premium(MIA, addDays(nowStr(), 3));
  l = await statusLimits(MIA);
  assert.deepEqual([l.plan, l.checks, l.subscribers], ['premium', 30, 250]);
  assert.ok(premiumPerks().some((p) => p.owner === 'status-pages' && p.text === 'Status page: 30 checks and checks every minute'));
});

test('buying add-ons: a page is needed, not while blocked or paused by the team, not with Premium for good', async () => {
  await sql("INSERT INTO `DB`.honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (?, 1000, 'admin', ?, '', ?), (?, 1000, 'admin', ?, '', ?)",
    [MIA, 'a3-' + randomHex(8), nowStr(), BEN, 'a3-' + randomHex(8), nowStr()]);
  const tryBuy = (uid: number, item: string, price: number) => buy(null, uid, item, randomHex(16), price, { via: 'shop' });
  let r = await tryBuy(BEN, 'status_more_checks_30', 60);
  assert.deepEqual([r.ok, r.error], [false, 'Create your status page first.']);
  await sql('UPDATE `DB`.status_pages SET is_blocked = 1 WHERE id = ?', [pageId]);
  r = await tryBuy(MIA, 'status_more_checks_30', 60);
  assert.equal(r.error, 'Your status page is blocked by the team.');
  await sql('UPDATE `DB`.status_pages SET is_blocked = 0 WHERE id = ?', [pageId]);
  await premium(MIA, '9999-12-31 23:59:59');
  r = await tryBuy(MIA, 'status_fast_checks_30', 80);
  assert.equal(r.error, 'Your Premium already includes this.');
  await premium(MIA, null);
  r = await tryBuy(MIA, 'status_more_checks_30', 60);
  assert.equal(r.ok, true, JSON.stringify(r));
  r = await tryBuy(MIA, 'status_more_checks_30', 60);
  assert.equal(r.ok, true, 'a second pack');
  assert.equal((await statusLimits(MIA)).checks, 30);
});

test('the refresh after a change: one bell per change of paused checks, a second run adds nothing, it runs with the shop’s reconcile', async () => {
  assert.equal(limitNotice(0, 0, 10), null);
  assert.equal(limitNotice(0, 2, 10)?.title, '2 status checks are paused');
  assert.equal(limitNotice(2, 0, 20)?.title, 'All your status checks run again');
  await addChecks(12);
  const rev = await n("SELECT COALESCE(MAX(CAST(meta_value AS UNSIGNED)), 0) FROM `DB`.oys_meta WHERE meta_key = 'status_rev'");
  await refreshStatusLimits(MIA);
  await refreshStatusLimits(MIA);
  assert.equal(await n('SELECT limit_paused FROM `DB`.status_pages WHERE id = ?', [pageId]), 2);
  assert.ok(await n("SELECT CAST(meta_value AS UNSIGNED) FROM `DB`.oys_meta WHERE meta_key = 'status_rev'") > rev, 'the checker re-reads');
  let bells = await sql('SELECT type, title FROM `DB`.notifications WHERE user_id = ? ORDER BY id', [MIA]);
  assert.deepEqual(bells.map((b) => [b.type, b.title]), [['status_team', '2 status checks are paused']]);
  // Ein Paket über den Shop: der Abgleich läuft gleich mit
  const g = await grantFeature(ADMIN, MIA, 'status_more_checks', { days: 30, formRef: randomHex(8) }, '');
  assert.ok('ok' in g, JSON.stringify(g));
  bells = await sql('SELECT title FROM `DB`.notifications WHERE user_id = ? AND type = ? ORDER BY id', [MIA, 'status_team']);
  assert.deepEqual(bells.map((b) => b.title), ['2 status checks are paused', 'All your status checks run again']);
  assert.equal(await n('SELECT limit_paused FROM `DB`.status_pages WHERE id = ?', [pageId]), 0);
});

test('“Made with OnYourSite” on the status page: hidden only with Premium; switching it on needs Premium', async () => {
  const page = async (): Promise<string> => {
    const ctx = makeTestCtx({ url: '/?rev=' + randomHex(4), host: 'mia-status.oys.test:8080' });
    await dispatch(ctx).catch(() => undefined);
    return String(ctx.body);
  };
  assert.deepEqual(body(await api('status-page', { json: { hide_branding: true } })), { ok: false, error: 'Hiding “Made with OnYourSite” comes with Premium.', field: 'hide_branding' });
  await premium(MIA, addDays(nowStr(), 30));
  let st = body(await api('status-page', { json: { hide_branding: true } }));
  assert.equal(st.ok, true, JSON.stringify(st));
  assert.deepEqual([st.page.premium, st.page.settings.hide_branding], [true, true]);
  const html = await page();
  assert.ok(html.includes('Report this page'), 'the status page renders: ' + html.slice(0, 200));
  assert.ok(!html.includes('Made with <strong>OnYourSite</strong>'), 'hidden with Premium');
  // Premium endet: der Schalter bleibt, wirkt aber nicht mehr (der Abgleich macht die Seite neu)
  await premium(MIA, null);
  await refreshStatusLimits(MIA);
  assert.ok((await page()).includes('Made with <strong>OnYourSite</strong>'), 'shown again without Premium');
  st = body(await api('status-page', { json: { hide_branding: false } }));
  assert.equal(st.page.settings.hide_branding, false, 'switching off always works');
});

test('review: notice without the unlock, saving after Premium ended, Premium’s own end, packs by quantity, editing a 1-minute check after Fast checks ended', async () => {
  assert.equal(limitNotice(0, 3, 0, 'none')?.body, 'Your status page has no checks right now – the status page unlock has ended. The checks and their history are kept.');
  assert.match(String(limitNotice(0, 3, 10, 'free')?.body), /Extra checks or Premium bring them back\.$/);
  // Premium endete, der Schalter steht noch auf an: andere Änderungen speichern trotzdem
  await premium(MIA, addDays(nowStr(), 30));
  assert.equal(body(await api('status-page', { json: { hide_branding: true } })).ok, true);
  await premium(MIA, null);
  const st = body(await api('status-page', { json: { title: 'Mia status 2', hide_branding: true } }));
  assert.equal(st.ok, true, JSON.stringify(st));
  // Mit Premium: das Ende von Premium, nicht das eines früher endenden Pakets
  const s = await statusSettings();
  assert.equal(planLimits(s, { packs: 1, packsUntil: ['2026-12-01 10:00:00'], fast: false, fastUntil: null, premium: true, premiumUntil: '2027-01-01 10:00:00' }).until, '2027-01-01 10:00:00');
  // Ein Los mit Menge 2 zählt als zwei Pakete
  await sql(`INSERT INTO \`DB\`.hc_entitlements (user_id, feature, lot, quantity, permanent, expires_at, source, created_at, updated_at)
      VALUES (?, 'status_more_checks', 0, 2, 0, ?, 'admin', ?, ?)`, [MIA, addDays(nowStr(), 9), OLD, OLD]);
  assert.equal((await statusLimits(MIA)).checks, 30);
  await sql("DELETE FROM `DB`.hc_entitlements WHERE feature = 'status_more_checks'");
  // Fast checks endete: die gespeicherte Minute bleibt beim Bearbeiten erlaubt (der Prüfdienst streckt sie)
  await sql(`INSERT INTO \`DB\`.status_monitors (page_id, user_id, type, name, is_public, target, config, interval_s, position, changed_at, created_at, updated_at)
      VALUES (?, ?, 'http', 'Fast one', 1, 'https://example.com/', '{"timeout":10}', 60, 0, 0, NOW(), NOW())`, [pageId, MIA]);
  const id = await n("SELECT id FROM `DB`.status_monitors WHERE name = 'Fast one'");
  const r = body(await api('status-monitor-save', { json: { id, name: 'Fast one renamed' } }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(String(body(await api('status-monitor-save', { json: { name: 'New fast', type: 'http', url: 'https://example.org/', interval: 60 } })).error), /You can check every 3 minutes at most/);
});
