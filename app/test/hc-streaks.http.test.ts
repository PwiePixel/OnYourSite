// HTTP/DB: Serie und Tageslimit (honeycomb-shop HC-8). Verdienen beim Öffnen des Editors (earnOnVisit): Tagesbonus,
// Serie weiterzählen oder neu beginnen, Bonus nach 7 und 30 Tagen (30 geht vor), Tageslimit für Profil und Aufrufe
// unter der Sperre, angehaltenes Konto, gesperrtes Konto (NOWAIT), 10-Sekunden-Bremse, Admin-Modus; der Stand im
// Editor (Bootstrap, honeycombs, shop), die Regeln im Admin und das Nachtragen der Serie im Schema-Schritt.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { makeTestCtx, type Ctx } from '../src/web/ctx.js';
import { appRoutes } from '../src/app/dispatch.js';
import { ensureSchema, shopStreaks } from '../src/schema.js';
import { withConnection } from '../src/db.js';
import { date, strtotime, time } from '../src/php.js';
import { nowStr } from '../src/honeycombs/clock.js';
import { earnLimitsFrom, earnOnVisit, nextBonus, resetEarnThrottleForTests, EARN_DEFAULTS } from '../src/honeycombs/earn.js';
import { adminHcHandle } from '../src/honeycombs/honeycombs.js';
import { setPauseGateForTests } from '../src/honeycombs/ledger.js';
import { CSRF, jsonBody, loginSession, runRequest, testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
const OLD = '2026-01-01 10:00:00';
const ADMIN = 3;
const U = 5;
const day = (offset: number): string => date('Y-m-d', strtotime(date('Y-m-d') + ` ${offset >= 0 ? '+' : ''}${offset} days`) as number);
const TODAY = (): string => day(0);

async function sql(query: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [r] = await t.admin.query<RowDataPacket[]>(query.replace(/`DB`/g, '`' + t.name + '`'), params);
  return r;
}
const n = async (query: string, params: unknown[] = []): Promise<number> => Number(Object.values((await sql(query, params))[0])[0]);
const acc = async (uid = U) => ({ ...(await sql('SELECT streak, CAST(streak_day AS CHAR) AS streak_day, best_streak FROM `DB`.hc_accounts WHERE user_id = ?', [uid]))[0] });
const setStreak = (streak: number, dayStr: string | null, best = streak, uid = U) =>
  sql('UPDATE `DB`.hc_accounts SET streak = ?, streak_day = ?, best_streak = ? WHERE user_id = ?', [streak, dayStr, best, uid]);
const ledger = async (uid = U) => (await sql("SELECT reason, ref, amount FROM `DB`.honeycomb_ledger WHERE user_id = ? AND reason <> 'admin' ORDER BY id", [uid])).map((r) => `${r.reason}:${r.ref}:${r.amount}`);
const meta = (o: Record<string, unknown>) => sql("REPLACE INTO `DB`.oys_meta (meta_key, meta_value) VALUES ('honeycombs', ?)", [JSON.stringify(o)]);
async function visit(uid = U): Promise<Array<{ amount: number; text: string }>> {
  resetEarnThrottleForTests();
  return earnOnVisit(uid);
}
async function api(action: string, uid: number, method = 'GET'): Promise<Ctx> {
  const sid = await loginSession(uid);
  const ctx = makeTestCtx({ method, url: '/dashboard/api/' + action, headers: { 'x-csrf-token': CSRF, 'content-type': 'application/json' }, cookies: { PHPSESSID: sid }, rawBody: method === 'POST' ? Buffer.from('{}') : undefined });
  return runRequest(ctx, appRoutes);
}
async function dashboard(uid: number, impersonatedBy?: number): Promise<Record<string, unknown>> {
  const sid = await loginSession(uid, { impersonatedBy });
  const ctx = makeTestCtx({ url: '/dashboard', host: 'oys.test:8080', cookies: { PHPSESSID: sid } });
  await runRequest(ctx, appRoutes);
  const m = /window\.OYS_EDITOR = (\{[\s\S]*?\});\s*<\/script>/.exec(String(ctx.body));
  assert.ok(m, 'bootstrap');
  return JSON.parse(m[1]) as Record<string, unknown>;
}

before(async () => {
  t = await testDatabase('hcstreak', { empty: true });
  await ensureSchema();
  const user = 'INSERT INTO `DB`.users (id, email, password, full_name, is_admin, created_at) VALUES (?, ?, \'x\', ?, ?, ?)';
  await sql(user, [ADMIN, 'admin@test.de', 'Pixel Admin', 1, OLD]);
  for (const id of [5, 6, 7]) await sql(user, [id, `u${id}@test.de`, 'User ' + id, 0, OLD]);
  await sql("INSERT INTO `DB`.pages (id, user_id, slug, created_at) VALUES (1, 5, 'five', ?), (2, 6, 'six', ?)", [OLD, OLD]);
});

beforeEach(async () => {
  await sql('DELETE FROM `DB`.honeycomb_ledger');
  await sql('DELETE FROM `DB`.hc_accounts');
  await sql("DELETE FROM `DB`.oys_meta WHERE meta_key = 'honeycombs'");
  await sql('UPDATE `DB`.pages SET views = 0');
});

after(async () => {
  await t.done();
});

test('settings: defaults, only numbers count, ranges (daily limit at least 50), the next bonus', () => {
  assert.deepEqual(earnLimitsFrom(''), EARN_DEFAULTS);
  assert.deepEqual(earnLimitsFrom('{"streak_week":"20","streak_month":-5,"daily_cap":10}'), { streak_week: 20, streak_month: 0, daily_cap: 50 });
  assert.deepEqual(earnLimitsFrom('{"streak_week":"x","daily_cap":999999}'), { streak_week: 15, streak_month: 50, daily_cap: 100000 });
  assert.deepEqual(nextBonus(0, EARN_DEFAULTS), { at: 7, amount: 15 });
  assert.deepEqual(nextBonus(27, EARN_DEFAULTS), { at: 28, amount: 15 });
  assert.deepEqual(nextBonus(28, EARN_DEFAULTS), { at: 30, amount: 50 });
  assert.deepEqual(nextBonus(203, EARN_DEFAULTS), { at: 210, amount: 50 }, '210 is a multiple of 7 and 30 – the 30-day bonus wins');
  assert.deepEqual(nextBonus(3, { ...EARN_DEFAULTS, streak_week: 0 }), { at: 30, amount: 50 });
  assert.equal(nextBonus(3, { ...EARN_DEFAULTS, streak_week: 0, streak_month: 0 }), null);
});

test('first visit: the daily reward and day 1; a second visit the same day earns nothing and takes no lock', async () => {
  assert.deepEqual(await visit(), [{ amount: 5, text: 'for being active today' }]);
  assert.deepEqual(await acc(), { streak: 1, streak_day: TODAY(), best_streak: 1 });
  // Throttle: gleich danach im selben Prozess gar nichts (auch ohne Reset)
  assert.deepEqual(await earnOnVisit(U), []);
  assert.deepEqual(await visit(), []);
  assert.deepEqual(await ledger(), [`daily:${TODAY()}:5`]);
});

test('the streak goes on from yesterday, starts again after a gap, and pays +15 on day 7 and +50 on day 30 (not both)', async () => {
  await visit();
  await sql('DELETE FROM `DB`.honeycomb_ledger');
  await setStreak(6, day(-1), 6);
  assert.deepEqual(await visit(), [{ amount: 5, text: 'for being active today' }, { amount: 15, text: 'for a 7-day streak' }]);
  assert.deepEqual(await acc(), { streak: 7, streak_day: TODAY(), best_streak: 7 });
  assert.ok((await ledger()).includes(`streak:w${TODAY()}:15`));

  await sql('DELETE FROM `DB`.honeycomb_ledger');
  await setStreak(209, day(-1), 209);
  assert.deepEqual((await visit()).map((x) => x.text), ['for being active today', 'for a 30-day streak']);
  assert.deepEqual(await ledger(), [`daily:${TODAY()}:5`, `streak:m${TODAY()}:50`]);

  // Lücke: neu ab 1, die beste bleibt
  await sql('DELETE FROM `DB`.honeycomb_ledger');
  await setStreak(10, day(-2), 12);
  await visit();
  assert.deepEqual(await acc(), { streak: 1, streak_day: TODAY(), best_streak: 12 });

  // Bonus aus (0): die Serie zählt trotzdem weiter
  await sql('DELETE FROM `DB`.honeycomb_ledger');
  await meta({ streak_week: 0, daily: 0 });
  await setStreak(13, day(-1), 13);
  assert.deepEqual(await visit(), []);
  assert.deepEqual(await acc(), { streak: 14, streak_day: TODAY(), best_streak: 14 });
});

test('daily limit: profile and views count, daily and streaks never; checked under the lock; the rest comes another day', async () => {
  await meta({ daily_cap: 50 });
  await sql('INSERT INTO `DB`.hc_accounts (user_id, created_at, updated_at) VALUES (?, ?, ?)', [U, nowStr(), nowStr()]);
  // Heute schon 45 aus begrenzten Gründen; 100 Aufrufe = eine Stufe zu 10 → 55 > 50: übersprungen
  await sql("INSERT INTO `DB`.honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (?, 45, 'profile', 'complete', '', ?)", [U, nowStr()]);
  await sql('UPDATE `DB`.pages SET views = 100 WHERE user_id = ?', [U]);
  await setStreak(6, day(-1), 6);
  assert.deepEqual((await visit()).map((x) => x.text), ['for being active today', 'for a 7-day streak']);
  assert.equal(await n("SELECT COUNT(*) FROM `DB`.honeycomb_ledger WHERE user_id = ? AND reason = 'views'", [U]), 0);
  // Höheres Limit: jetzt passt die Stufe
  await meta({ daily_cap: 60 });
  assert.deepEqual(await visit(), [{ amount: 10, text: 'for 100 page views' }]);
  // Gaben des Teams zählen nicht mit
  await sql("INSERT INTO `DB`.honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (?, 500, 'admin', 'a3-x', '', ?)", [U, nowStr()]);
  const st = jsonBody(await api('shop', U)).shop as { earn: { capLeft: number; cap: number } };
  assert.deepEqual([st.earn.capLeft, st.earn.cap], [5, 60]);
});

test('a frozen account earns nothing and keeps its streak; a locked account is skipped at once (NOWAIT)', async () => {
  await sql('INSERT INTO `DB`.hc_accounts (user_id, frozen_at, frozen_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [U, nowStr(), 'Check', nowStr(), nowStr()]);
  await setStreak(3, day(-1), 3);
  assert.deepEqual(await visit(), []);
  assert.deepEqual(await acc(), { streak: 3, streak_day: day(-1), best_streak: 3 });
  assert.equal(await n('SELECT COUNT(*) FROM `DB`.honeycomb_ledger'), 0);

  await sql('UPDATE `DB`.hc_accounts SET frozen_at = NULL WHERE user_id = ?', [U]);
  await t.admin.query('BEGIN');
  try {
    await t.admin.query(`SELECT * FROM \`${t.name}\`.hc_accounts WHERE user_id = ? FOR UPDATE`, [U]);
    const start = Date.now();
    assert.deepEqual(await visit(), []);
    assert.ok(Date.now() - start < 3000, 'no waiting for the lock');
  } finally {
    await t.admin.query('ROLLBACK');
  }
  assert.equal((await visit()).length, 1, 'the next load books it');
});

test('the editor: notices and honeycombs.streak in the bootstrap, nothing while an admin works as the user, streak in the API and the shop', async () => {
  await sql('INSERT INTO `DB`.hc_accounts (user_id, created_at, updated_at) VALUES (?, ?, ?), (?, ?, ?)', [U, nowStr(), nowStr(), 6, nowStr(), nowStr()]);
  await setStreak(6, day(-1), 9);
  resetEarnThrottleForTests();
  const boot = await dashboard(U);
  assert.deepEqual(boot.notices, [{ tone: 'hc', text: 'for being active today', amount: 5 }, { tone: 'hc', text: 'for a 7-day streak', amount: 15 }]);
  assert.deepEqual((boot.honeycombs as Record<string, unknown>).streak, { days: 7, best: 9, nextAt: 14, nextAmount: 15 });

  // Admin im Nutzer-Modus: nichts gebucht, Serie unverändert
  await setStreak(6, day(-1), 6, 6);
  resetEarnThrottleForTests();
  const asUser = await dashboard(6, ADMIN);
  assert.deepEqual(asUser.notices, []);
  assert.equal(await n('SELECT COUNT(*) FROM `DB`.honeycomb_ledger WHERE user_id = 6'), 0);
  assert.deepEqual(await acc(6), { streak: 6, streak_day: day(-1), best_streak: 6 });

  const hc = jsonBody(await api('honeycombs', U)).honeycombs as Record<string, unknown>;
  assert.deepEqual(hc.streak, { days: 7, best: 9, nextAt: 14, nextAmount: 15 });
  const shop = jsonBody(await api('shop', U)).shop as { earn: { rules: Array<Record<string, unknown>>; streak: unknown } };
  assert.deepEqual(shop.earn.streak, { days: 7, best: 9, nextAt: 14, nextAmount: 15 });
  const rule = shop.earn.rules.find((r) => r.key === 'streak');
  assert.deepEqual([rule?.title, rule?.text, rule?.amount], ['Keep a streak', 'Day 7 – 7 more days to +15', 15]);
  // Eine Serie, die vorgestern endete, zählt nicht mehr
  await setStreak(20, day(-2), 20);
  const st2 = jsonBody(await api('shop', U)).shop as { earn: { rules: Array<Record<string, unknown>>; streak: unknown } };
  assert.deepEqual(st2.earn.streak, { days: 0, best: 20, nextAt: 7, nextAmount: 15 });
  assert.equal(st2.earn.rules.find((r) => r.key === 'streak')?.text, 'Open your editor every day: +15 every 7 days, +50 every 30 days in a row');
});

test('admin: the earning rules save the streak bonuses and the daily limit (clamped), keep unknown keys and audit the change', async () => {
  await meta({ daily: 5, later_key: 7 });
  const r = await adminHcHandle({ hc_action: 'settings', daily: '5', profile: '20', views: '10', views_step: '100', streak_week: '20', streak_month: '60', daily_cap: '10' }, ADMIN);
  assert.deepEqual(r, { ok: 'Honeycomb settings saved.' });
  const saved = JSON.parse(String((await sql("SELECT meta_value FROM `DB`.oys_meta WHERE meta_key = 'honeycombs'"))[0].meta_value));
  assert.deepEqual([saved.streak_week, saved.streak_month, saved.daily_cap, saved.later_key], [20, 60, 50, 7]);
  const audit = await sql("SELECT details FROM `DB`.hc_audit WHERE action = 'settings' ORDER BY id DESC LIMIT 1");
  assert.deepEqual(JSON.parse(String(audit[0].details)), { streak_week: 20, streak_month: 60, daily_cap: 50 });
});

test('schema step: the streak is filled in from the daily rewards of the last 60 days; a second run changes nothing', async () => {
  const add = (uid: number, d: string) => sql("INSERT INTO `DB`.honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (?, 5, 'daily', ?, '', ?)", [uid, d, d + ' 10:00:00']);
  // 5: heute und die 3 Tage davor (4), vorher eine Folge von 6; 6: Folge endet vorgestern (nur die beste zählt);
  // 7: Folge endet gestern; Einträge älter als 60 Tage zählen nicht
  for (const o of [0, -1, -2, -3, -10, -11, -12, -13, -14, -15]) await add(5, day(o));
  for (const o of [-2, -3, -4]) await add(6, day(o));
  for (const o of [-1, -2, -70, -71, -72, -73, -74, -75, -76, -77]) await add(7, day(o));
  await withConnection(async (_db, conn) => shopStreaks(conn));
  assert.deepEqual(await acc(5), { streak: 4, streak_day: TODAY(), best_streak: 6 });
  assert.deepEqual(await acc(6), { streak: 0, streak_day: null, best_streak: 3 });
  assert.deepEqual(await acc(7), { streak: 2, streak_day: day(-1), best_streak: 2 });
  // Eine schon gezählte Serie bleibt beim zweiten Lauf stehen
  await setStreak(9, TODAY(), 9, 5);
  await withConnection(async (_db, conn) => shopStreaks(conn));
  assert.deepEqual(await acc(5), { streak: 9, streak_day: TODAY(), best_streak: 9 });
  assert.ok(time() > 0);
});

test('review: a frozen account and a reward above the daily limit take no lock on every load', async () => {
  let locks = 0;
  setPauseGateForTests((name) => { if (name === 'account-locked') locks++; });
  try {
    await sql('INSERT INTO `DB`.hc_accounts (user_id, frozen_at, frozen_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [U, nowStr(), 'Check', nowStr(), nowStr()]);
    await visit();
    await visit();
    assert.equal(locks, 0, 'frozen: no lock');
    // Aufrufe-Belohnung über dem Limit (nie zahlbar): nach dem ersten Laden des Tages keine Sperre mehr
    await sql('UPDATE `DB`.hc_accounts SET frozen_at = NULL WHERE user_id = ?', [U]);
    await meta({ views: 400, daily_cap: 300 });
    await sql('UPDATE `DB`.pages SET views = 100 WHERE user_id = ?', [U]);
    await visit();
    const after1 = locks;
    await visit();
    assert.equal(locks, after1, 'a reward above the limit never takes the lock again');
  } finally {
    setPauseGateForTests(null);
  }
});
