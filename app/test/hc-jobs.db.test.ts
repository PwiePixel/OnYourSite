// DB: gemeinsamer Hintergrund-Läufer und die Aufgabe der Honigwaben (honeycomb-shop HC-7a). Läufer: fällig/nicht fällig,
// Sperre je Aufgabe (belegt → übersprungen), Schema zu alt, Fehler gespeichert, nächtliche Aufgaben einmal am Tag nach
// 04:00. Aufgabe: Erinnerungen je Stufe genau einmal (zwei Läufe = eine Glocke), mit den Zeilen „was wegfällt“, das Ende
// einmal (Glocke, Merker, Abgleich), eine Verlängerung lässt nichts zu tun, ein werfender Abgleich behält den Merker
// und wird wiederholt, nachts fehlende Berechtigungen nachtragen.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { ensureSchema, V_SHOP_CATALOGUE } from '../src/schema.js';
import { strtotime, time, wallToUnix } from '../src/php.js';
import { addSeconds, nowStr } from '../src/honeycombs/clock.js';
import { registerFeature, registerLossPreview, unregisterFeatureForTests, type Feature } from '../src/honeycombs/features.js';
import { registerEnforcer, unregisterEnforcerForTests } from '../src/honeycombs/reconcile.js';
import { expiryStep, reconcileStep, reminderStep, repairEntitlements, endsText } from '../src/honeycombs/job.js';
import { jobsState, registerJob, registerNightly, tick, unregisterJobsForTests, type JobContext } from '../src/jobs/registry.js';
import { setPauseGateForTests } from '../src/honeycombs/ledger.js';
import { testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
const U = 5;
const OLD = '2026-01-01 10:00:00';
const ctx = (): JobContext => ({ deadline: Date.now() + 60_000, log: () => undefined });
const silent = () => undefined;

async function sql(query: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [r] = await t.admin.query<RowDataPacket[]>(query.replace(/`DB`/g, '`' + t.name + '`'), params);
  return r;
}
const n = async (query: string, params: unknown[] = []): Promise<number> => Number(Object.values((await sql(query, params))[0])[0]);
const bells = async (uid = U) => (await sql('SELECT title, body, link, type FROM `DB`.notifications WHERE user_id = ? ORDER BY id', [uid])).map((r) => ({ ...r }));
async function lot(o: { feature?: string; lot?: number; expires: string; reminded?: number; uid?: number }): Promise<number> {
  const [r] = await t.admin.query<import('mysql2/promise').ResultSetHeader>(`INSERT INTO \`${t.name}\`.hc_entitlements
      (user_id, feature, lot, quantity, permanent, expires_at, source, reminded, created_at, updated_at) VALUES (?, ?, ?, 1, 0, ?, 'purchase', ?, ?, ?)`,
  [o.uid ?? U, o.feature ?? 'test_timed', o.lot ?? 0, o.expires, o.reminded ?? 0, OLD, OLD]);
  return r.insertId;
}

const TIMED: Feature = {
  key: 'test_timed', owner: 'tests', title: 'Test pass', icon: 'bx-time', description: 'Timed test.', kind: 'timed', stack: 2,
  items: { test_timed_30: { days: 30, price: 10, active: true } },
};
let enforced = 0;
let throwing = false;

before(async () => {
  t = await testDatabase('hcjobs', { empty: true });
  await ensureSchema();
  const user = 'INSERT INTO `DB`.users (id, email, password, full_name, is_admin, created_at) VALUES (?, ?, \'x\', ?, 0, ?)';
  for (const id of [5, 6]) await sql(user, [id, `u${id}@test.de`, 'User ' + id, OLD]);
  registerFeature(TIMED);
  registerLossPreview('test_timed', async (uid) => [`Page #${uid} goes back to the free plan.`]);
  registerEnforcer({ name: 'jobs-test', features: ['test_timed'], inline: true, run: async () => {
    enforced++;
    if (throwing) throw new Error('enforcer broke');
  } });
});

beforeEach(async () => {
  for (const tb of ['hc_entitlements', 'notifications', 'honeycomb_ledger']) await sql(`DELETE FROM \`DB\`.${tb}`);
  await sql("DELETE FROM `DB`.oys_meta WHERE meta_key = 'jobs'");
  await sql('UPDATE `DB`.hc_accounts SET reconcile_at = NULL, reconcile_error = \'\', reconcile_tries = 0');
  unregisterJobsForTests();
  enforced = 0;
  throwing = false;
});

after(async () => {
  unregisterEnforcerForTests('jobs-test');
  unregisterFeatureForTests('test_timed');
  unregisterJobsForTests();
  await t.done();
});

test('texts: ends in N days, tomorrow, today', () => {
  const now = '2026-05-10 12:00:00';
  assert.equal(endsText('Premium', '2026-05-13 12:00:00', now), 'Premium ends in 3 days');
  assert.equal(endsText('Premium', '2026-05-11 10:00:00', now), 'Premium ends tomorrow');
  assert.equal(endsText('Premium', '2026-05-11 23:59:00', now), 'Premium ends tomorrow');
  assert.equal(endsText('Premium', '2026-05-10 20:00:00', now), 'Premium ends today');
  // Über die Zeitumstellung (29. März) zählen Kalendertage
  assert.equal(endsText('Premium', '2026-03-31 01:00:00', '2026-03-28 23:00:00'), 'Premium ends in 3 days');
});

test('runner: a job runs when due, once per interval, forced again; errors are stored; a busy lock skips; an old schema skips', async () => {
  let runs = 0;
  let fail = false;
  registerJob({ name: 'probe', everyMinutes: 15, minSchema: 1, budgetSec: 5, run: async () => {
    runs++;
    if (fail) throw new Error('boom');
  } });
  const now = time();
  assert.deepEqual(await tick({ now, log: silent }), [{ name: 'probe', outcome: 'ran' }]);
  assert.deepEqual(await tick({ now: now + 5 * 60, log: silent }), [{ name: 'probe', outcome: 'not-due' }]);
  // 14½ Minuten später ist es fällig (der Timer läuft alle 5 Minuten)
  assert.deepEqual(await tick({ now: now + 15 * 60 - 20, log: silent }), [{ name: 'probe', outcome: 'ran' }]);
  fail = true;
  assert.deepEqual(await tick({ now, force: true, log: silent }), [{ name: 'probe', outcome: 'failed' }]);
  const st = (await jobsState()).probe;
  assert.deepEqual([st.ok, st.error, st.at, st.every], [false, 'boom', now, 900]);
  assert.equal(runs, 3);

  // Ein anderer Läufer hält die Sperre
  await t.admin.query("SELECT GET_LOCK('oys_job_probe', 0)");
  try {
    assert.deepEqual(await tick({ now, force: true, log: silent }), [{ name: 'probe', outcome: 'busy' }]);
  } finally {
    await t.admin.query("SELECT RELEASE_LOCK('oys_job_probe')");
  }
  assert.equal(runs, 3);

  // Schema älter als nötig: nichts läuft, die Meldung steht im Protokoll
  unregisterJobsForTests();
  registerJob({ name: 'future', everyMinutes: 5, minSchema: 999, budgetSec: 5, run: async () => { runs++; } });
  const lines: string[] = [];
  assert.deepEqual(await tick({ now, log: (l) => lines.push(l) }), [{ name: 'future', outcome: 'schema' }]);
  assert.deepEqual(lines, ['future: schema too old – skipped']);
  assert.equal(runs, 3);
});

test('runner: a nightly job runs in the first tick after 04:00, once per day', async () => {
  let runs = 0;
  registerNightly('probe', async () => { runs++; }, V_SHOP_CATALOGUE);
  const at = (d: number, h: number, m = 0) => wallToUnix(2026, 5, d, h, m);
  assert.equal((await tick({ now: at(10, 3, 55), log: silent }))[0].outcome, 'not-due');
  assert.equal((await tick({ now: at(10, 4, 0), log: silent }))[0].outcome, 'ran');
  assert.equal((await tick({ now: at(10, 4, 5), log: silent }))[0].outcome, 'not-due');
  assert.equal((await tick({ now: at(10, 23, 50), log: silent }))[0].outcome, 'not-due');
  assert.equal((await tick({ now: at(11, 2, 0), log: silent }))[0].outcome, 'not-due');
  assert.equal((await tick({ now: at(11, 4, 10), log: silent }))[0].outcome, 'ran');
  assert.equal(runs, 2);
});

test('reminders: one bell per stage (7, 3, 1 days) with the loss preview; a second run sends nothing', async () => {
  const now = nowStr();
  const id = await lot({ expires: addSeconds(now, 2.5 * 86400) });
  assert.equal(await reminderStep(ctx(), now), 1);
  assert.equal(await reminderStep(ctx(), now), 0, 'twice = one reminder');
  assert.equal(await n('SELECT reminded FROM `DB`.hc_entitlements WHERE id = ?', [id]), 2);
  const b = await bells();
  assert.equal(b.length, 1);
  assert.equal(b[0].title, endsText('Test pass', addSeconds(now, 2.5 * 86400), now));
  assert.match(String(b[0].title), /^Test pass ends in [23] days$/);
  assert.equal(b[0].type, 'unlock');
  assert.equal(b[0].link, '/dashboard#honeycombs/test_timed');
  assert.match(String(b[0].body), /^It ends on \w{3} \d{1,2}, \d{4}\. Renew it in the shop to keep it\. Page #5 goes back to the free plan\.$/);
  // Später, weniger als ein Tag übrig: Stufe 3
  const later = addSeconds(now, 1.8 * 86400);
  assert.equal(await reminderStep(ctx(), later), 1);
  assert.equal((await bells()).at(-1)?.title, endsText('Test pass', addSeconds(now, 2.5 * 86400), later));
  assert.equal(await n('SELECT reminded FROM `DB`.hc_entitlements WHERE id = ?', [id]), 3);
  // Ein Kauf von heute hat reminded schon auf seiner Stufe: nichts
  await lot({ uid: 6, expires: addSeconds(now, 6 * 86400), reminded: 1 });
  assert.equal(await reminderStep(ctx(), now), 0);
  // Ein weiteres Paket läuft noch: „A pack of …“, ohne die Zeilen
  await sql('DELETE FROM `DB`.notifications');
  await lot({ uid: 6, lot: 1, expires: addSeconds(now, 40 * 86400) });
  await sql('UPDATE `DB`.hc_entitlements SET reminded = 0 WHERE user_id = 6 AND lot = 0');
  assert.equal(await reminderStep(ctx(), now), 1);
  assert.deepEqual((await bells(6)).map((x) => [x.title, x.body]), [['A pack of Test pass ends in 6 days', 'Renew it in the shop to keep it.']]);
});

test('expiry: once per lot – bell, marker and reconcile; a renewal leaves nothing to do', async () => {
  const now = nowStr();
  const id = await lot({ expires: addSeconds(now, -3600) });
  await lot({ uid: 6, expires: addSeconds(now, 86400 * 20) });
  assert.equal(await expiryStep(ctx(), now), 1);
  assert.equal(await expiryStep(ctx(), now), 0, 'twice = one expiry');
  assert.notEqual((await sql('SELECT expiry_done_at FROM `DB`.hc_entitlements WHERE id = ?', [id]))[0].expiry_done_at, null);
  const b = await bells();
  assert.equal(b.length, 1);
  assert.equal(b[0].title, 'Test pass has ended');
  assert.match(String(b[0].body), /^It ended on \w{3} \d{1,2}, \d{4}\. You can renew it in the shop\. Page #5 goes back to the free plan\.$/);
  assert.equal(enforced, 1, 'the enforcers ran after the commit');
  assert.equal(await n('SELECT COUNT(*) FROM `DB`.hc_accounts WHERE user_id = ? AND reconcile_at IS NOT NULL', [U]), 0);
  assert.equal(await n('SELECT COUNT(*) FROM `DB`.notifications WHERE user_id = 6'), 0);
});

test('a throwing enforcer keeps the marker; the reconcile step retries it after 30 seconds', async () => {
  const now = nowStr();
  await lot({ expires: addSeconds(now, -60) });
  throwing = true;
  assert.equal(await expiryStep(ctx(), now), 1);
  const acc = (await sql('SELECT reconcile_at, reconcile_error FROM `DB`.hc_accounts WHERE user_id = ?', [U]))[0];
  assert.notEqual(acc.reconcile_at, null);
  assert.equal(acc.reconcile_error, 'jobs-test: enforcer broke');
  // Zu früh: nichts; nach 30 Sekunden und repariert: erledigt
  throwing = false;
  assert.equal(await reconcileStep(ctx(), now), 0);
  assert.equal(await reconcileStep(ctx(), addSeconds(now, 31)), 1);
  assert.equal(await n('SELECT COUNT(*) FROM `DB`.hc_accounts WHERE user_id = ? AND reconcile_at IS NOT NULL', [U]), 0);
});

test('nightly repair: an unlock in the ledger without its entitlement gets one; timed features are left alone', async () => {
  await sql("INSERT INTO `DB`.honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (?, -100, 'unlock', 'code_page', '', ?), (?, 0, 'unlock', 'test_timed', '', ?)", [U, OLD, U, OLD]);
  assert.equal(await repairEntitlements(ctx()), 1);
  assert.equal(await repairEntitlements(ctx()), 0);
  const e = (await sql("SELECT feature, permanent, source FROM `DB`.hc_entitlements WHERE user_id = ?", [U])).map((r) => ({ ...r }));
  assert.deepEqual(e, [{ feature: 'code_page', permanent: 1, source: 'legacy' }]);
  assert.ok(strtotime(OLD) !== false);
});

test('review: reminders skip lots already reminded at their stage (no stall behind 500 of them); one failing row doesn’t stop the others', async () => {
  const now = nowStr();
  // 520 Pakete, schon auf ihrer Stufe erinnert, enden vor dem einen neuen
  await sql(`INSERT INTO \`DB\`.hc_entitlements (user_id, feature, lot, quantity, permanent, expires_at, source, reminded, created_at, updated_at)
      SELECT 20000 + seq, 'test_timed', 0, 1, 0, ?, 'purchase', 1, ?, ? FROM \`DB\`.seq_1_to_520`, [addSeconds(now, 5 * 86400), OLD, OLD]);
  await lot({ expires: addSeconds(now, 6 * 86400) });
  assert.equal(await reminderStep(ctx(), now), 1);
  assert.equal((await bells()).length, 1);
  await sql('DELETE FROM `DB`.hc_entitlements WHERE user_id >= 20000');
  await sql('DELETE FROM `DB`.hc_accounts WHERE user_id >= 20000');
  await sql('DELETE FROM `DB`.hc_entitlements');

  // Das Konto 6 wirft (z. B. eine Verklemmung): Konto 5 dahinter wird trotzdem verarbeitet
  await lot({ uid: 6, expires: addSeconds(now, -7200) });
  await lot({ expires: addSeconds(now, -3600) });
  setPauseGateForTests((name, info) => { if (name === 'account-locked' && info.uid === 6) throw new Error('deadlock'); });
  try {
    assert.equal(await expiryStep(ctx(), now), 1);
  } finally {
    setPauseGateForTests(null);
  }
  assert.equal(await n('SELECT COUNT(*) FROM `DB`.hc_entitlements WHERE user_id = 5 AND expiry_done_at IS NOT NULL'), 1);
});
