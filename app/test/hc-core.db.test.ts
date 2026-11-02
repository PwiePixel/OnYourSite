// Shop-Kern mit Datenbank: der Schritt V_SHOP_CORE (bisherige Freischaltungen werden Berechtigungen, zweimal
// ausführbar), Zugang nach der Migration, über eine Buchung des alten Prozesses, die kostenlose Freischaltung im Admin
// und hcSpend, die Kontosperre (5 Sekunden, NOWAIT, eine Verklemmung wird einmal wiederholt), Premium in
// users.premium_until, includedFor, der Abgleich-Merker, die Admin-Rolle, das Löschen eines Kontos und die neuen
// Schlüssel im Editor.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { one, q, transaction } from '../src/db.js';
import { makeTestCtx } from '../src/web/ctx.js';
import { appRoutes } from '../src/app/dispatch.js';
import { ensureSchema, V_SHOP_CORE } from '../src/schema.js';
import { BUSY, balanceIn, debit, setPauseGateForTests, withAccount } from '../src/honeycombs/ledger.js';
import { entitlement, has, quantity, setPeriod, PREMIUM_FOREVER } from '../src/honeycombs/entitlements.js';
import { registerFeature, unregisterFeatureForTests } from '../src/honeycombs/features.js';
import { markReconcile, reconcileNow, registerEnforcer, unregisterEnforcerForTests } from '../src/honeycombs/reconcile.js';
import { isPremium, premiumState } from '../src/honeycombs/premium.js';
import { HC_BUSY, adminHcHandle, hcAdd, hcSpend } from '../src/honeycombs/honeycombs.js';
import { codeUnlocked } from '../src/code/sites.js';
import { adminCodeHandle } from '../src/code/admin.js';
import { toggleAdmin } from '../src/admin/users.js';
import { deleteAccount } from '../src/admin/accountDeletion.js';
import { addDays, nowStr } from '../src/honeycombs/clock.js';
import { CSRF, adminConnection, jsonBody, loginSession, runRequest, testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
const T = '2026-01-01 10:00:00';

// Abfrage direkt auf der Test-Datenbank (eigene Verbindung, nicht der Pool der Seite)
async function sql(query: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [r] = await t.admin.query<RowDataPacket[]>(query.replace(/`DB`/g, '`' + t.name + '`'), params);
  return r;
}
const ledgerOf = async (uid: number) => (await sql('SELECT amount, reason, ref, note, actor_id FROM `DB`.honeycomb_ledger WHERE user_id = ? ORDER BY id', [uid])).map((r) => ({ ...r }));
const entsOf = async (uid: number) => (await sql('SELECT feature, lot, quantity, permanent, expires_at, source FROM `DB`.hc_entitlements WHERE user_id = ? ORDER BY feature, lot', [uid])).map((r) => ({ ...r }));
const account = async (uid: number) => (await sql('SELECT * FROM `DB`.hc_accounts WHERE user_id = ?', [uid]))[0] as RowDataPacket | undefined;

async function addUser(id: number, email: string, admin = 0): Promise<void> {
  await sql("INSERT INTO `DB`.users (id, email, password, full_name, is_admin, created_at) VALUES (?, ?, 'x', ?, ?, ?)", [id, email, 'User ' + id, admin, T]);
}

before(async () => {
  t = await testDatabase('hc2', { empty: true });
  // Stand vor dem Shop-Kern mit den Daten, die es dann gibt
  await ensureSchema({ upTo: V_SHOP_CORE - 1 });
  await addUser(3, 'admin@test.de', 1);
  for (const [id, email] of [[5, 'mia@test.de'], [6, 'tom@test.de'], [7, 'lea@test.de'], [8, 'noname@test.de'], [9, 'nopage@test.de']] as const) await addUser(id, email);
  const l = 'INSERT INTO `DB`.honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (?, ?, ?, ?, ?, ?)';
  await sql(l, [5, 500, 'admin', 'a3-1111111111111111', 'Welcome', '2026-09-30 09:00:00']);
  await sql(l, [5, -100, 'unlock', 'code_page', '', '2026-10-01 10:00:00']);
  await sql(l, [6, 0, 'unlock', 'code_page', 'Unlocked by the team', '2026-10-02 10:00:00']);
  await sql(l, [6, 30, 'admin', 'a3-zzzz', '', '2026-10-02 11:00:00']);
  await sql(l, [6, 30, 'admin', 'a12-2222222222222222', '', '2026-10-02 12:00:00']);
  await sql(l, [6, 30, 'admin', 'a99999999999-3333333333333333', '', '2026-10-02 13:00:00']);
  await sql(l, [7, 0, 'unlock', 'code_more', '', '2026-10-03 10:00:00']);
  await sql(l, [7, -150, 'unlock', 'status_page', '', '2026-10-04 10:00:00']);
  // Kein Schlüssel einer Funktion (Groß/klein, zu kurz) → keine Berechtigung
  await sql(l, [3, 0, 'unlock', 'CODE_PAGE', '', '2026-10-05 10:00:00']);
  await sql(l, [3, 0, 'unlock', 'x', '', '2026-10-05 10:00:01']);
  await sql(l, [9, 5, 'daily', '2026-10-05', '', '2026-10-05 10:00:00']);
  // Code-Seiten: 9 ohne Freischaltung im Buch (Sicherheitsnetz), 5 mit
  await sql("INSERT INTO `DB`.code_sites (user_id, slug, title, created_at, updated_at) VALUES (9, 'ninecode', 'Nine', '2026-10-06 10:00:00', NULL), (5, 'miacode', 'Mia', NULL, NULL)");
});

after(async () => {
  setPauseGateForTests(null);
  await t.done();
});

test('migration: every unlock becomes an entitlement, code sites are covered, admins of grants are filled in, and the step runs twice', async () => {
  await ensureSchema();
  assert.deepEqual((await sql('SELECT user_id FROM `DB`.hc_accounts ORDER BY user_id')).map((r) => r.user_id), [3, 5, 6, 7, 8, 9]);
  const ents = (await sql('SELECT user_id, feature, lot, quantity, permanent, expires_at, source, note, created_at FROM `DB`.hc_entitlements ORDER BY user_id, feature'))
    .map((r) => ({ ...r }));
  assert.deepEqual(ents, [
    { user_id: 5, feature: 'code_page', lot: 0, quantity: 1, permanent: 1, expires_at: null, source: 'legacy', note: '', created_at: '2026-10-01 10:00:00' },
    { user_id: 6, feature: 'code_page', lot: 0, quantity: 1, permanent: 1, expires_at: null, source: 'admin', note: '', created_at: '2026-10-02 10:00:00' },
    { user_id: 7, feature: 'code_more', lot: 0, quantity: 1, permanent: 1, expires_at: null, source: 'admin', note: '', created_at: '2026-10-03 10:00:00' },
    { user_id: 7, feature: 'status_page', lot: 0, quantity: 1, permanent: 1, expires_at: null, source: 'legacy', note: '', created_at: '2026-10-04 10:00:00' },
    { user_id: 9, feature: 'code_page', lot: 0, quantity: 1, permanent: 1, expires_at: null, source: 'legacy', note: '', created_at: '2026-10-06 10:00:00' },
  ]);
  const actors = (await sql("SELECT ref, actor_id FROM `DB`.honeycomb_ledger WHERE reason = 'admin' ORDER BY id")).map((r) => [r.ref, r.actor_id]);
  assert.deepEqual(actors, [['a3-1111111111111111', 3], ['a3-zzzz', null], ['a12-2222222222222222', 12], ['a99999999999-3333333333333333', null]]);
  assert.deepEqual((await sql('SELECT DISTINCT premium_until FROM `DB`.users')).map((r) => r.premium_until), [null]);
  const indexes = async (table: string) => (await sql(`SHOW INDEX FROM \`DB\`.${table}`)).map((r) => String(r.Key_name));
  assert.ok((await indexes('honeycomb_ledger')).includes('idx_reason_time') && (await indexes('honeycomb_ledger')).includes('idx_time'));
  assert.ok((await indexes('users')).includes('idx_premium_until'));

  // Noch einmal (z. B. nach einem abgebrochenen Update): nichts ändert sich
  const snapshot = async () => [await sql('SELECT * FROM `DB`.hc_accounts ORDER BY user_id'), await sql('SELECT * FROM `DB`.hc_entitlements ORDER BY id'),
    await sql('SELECT * FROM `DB`.honeycomb_ledger ORDER BY id')].map((rows) => rows.map((r) => ({ ...r })));
  const first = await snapshot();
  await sql("REPLACE INTO `DB`.oys_meta (meta_key, meta_value) VALUES ('schema_version', ?)", [String(V_SHOP_CORE - 1)]);
  await ensureSchema();
  assert.deepEqual(await snapshot(), first);
});

test('access: after the migration, through an unlock row of the old process, the free admin unlock and hcSpend', async () => {
  assert.equal(await has(5, 'code_page'), true);
  assert.equal(await codeUnlocked(6), true);
  assert.equal(await has(7, 'code_more'), true);
  assert.equal(await has(7, 'status_page'), true);
  assert.equal(await codeUnlocked(9), true);
  assert.equal(await codeUnlocked(8), false);
  assert.equal(await has(3, 'code_page'), false, 'CODE_PAGE in capitals is not the code page');

  // Buchung des alten Prozesses zwischen migrate und Neustart: Zugang ohne Berechtigung (Rückgriff aufs Buch)
  await sql("INSERT INTO `DB`.honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (8, -100, 'unlock', 'code_page', '', ?)", [nowStr()]);
  assert.equal(await codeUnlocked(8), true);
  assert.equal(await quantity(8, 'code_page'), 1);
  assert.deepEqual(await entitlement(8, 'code_page'), { active: true, until: null, quantity: 1, permanent: true, included: false, lots: [] });
  assert.deepEqual(await entsOf(8), [], 'reading never writes');
  // Kein zweites Bezahlen; die fehlende Berechtigung wird beim nächsten Schreiben nachgetragen, ohne Buchung
  assert.equal(await hcSpend(8, 100, 'code_page'), null);
  assert.equal((await ledgerOf(8)).length, 1);
  assert.equal(await hcAdd(8, 0, 'unlock', 'code_page', 'Unlocked by the team'), false);
  assert.deepEqual(await entsOf(8), [{ feature: 'code_page', lot: 0, quantity: 1, permanent: 1, expires_at: null, source: 'legacy' }]);
  assert.equal((await ledgerOf(8)).length, 1);

  // Kostenlos im Admin (Bereich Code-Seiten): Buchung über 0 und Berechtigung
  await addUser(10, 'ten@test.de');
  assert.deepEqual(await adminCodeHandle({ code_action: 'unlock', user_id: '10', item: 'code_page' }), { ok: 'Code page unlocked for User 10.' });
  assert.deepEqual(await ledgerOf(10), [{ amount: 0, reason: 'unlock', ref: 'code_page', note: 'Unlocked by the team', actor_id: null }]);
  assert.deepEqual(await entsOf(10), [{ feature: 'code_page', lot: 0, quantity: 1, permanent: 1, expires_at: null, source: 'admin' }]);
  assert.equal(await codeUnlocked(10), true);
  // Die Änderung setzt den Merker; nach dem Commit liefen die schnellen Abgleiche (hier keine) und löschten ihn
  const marked = await account(10);
  assert.ok(Number(marked?.reconcile_gen) >= 1, 'the change marks the account for reconcile');
  assert.equal(marked?.reconcile_at, null, 'and the reconcile after the commit cleared it');
  assert.deepEqual(await adminCodeHandle({ code_action: 'unlock', user_id: '10', item: 'code_page' }), { ok: 'User 10 had already unlocked the code page.' });
  assert.equal((await ledgerOf(10)).length, 1);

  // Bezahlt (hcSpend, die Code-Seite bis zum Katalog): Buchung −Preis und Berechtigung „purchase“
  await addUser(11, 'eleven@test.de');
  assert.deepEqual(await adminHcHandle({ hc_action: 'grant', user_id: '11', amount: '150', grant_ref: '0123456789abcdef' }, 3),
    { ok: '+150 honeycombs for User 11. New balance: 150.' });
  assert.equal(await hcSpend(11, 100, 'code_page'), null);
  assert.equal(await hcSpend(11, 100, 'code_page'), null, 'owned: no second charge');
  assert.deepEqual(await ledgerOf(11), [
    { amount: 150, reason: 'admin', ref: 'a3-0123456789abcdef', note: '', actor_id: 3 },
    { amount: -100, reason: 'unlock', ref: 'code_page', note: '', actor_id: null },
  ]);
  assert.deepEqual(await entsOf(11), [{ feature: 'code_page', lot: 0, quantity: 1, permanent: 1, expires_at: null, source: 'purchase' }]);
  await addUser(12, 'twelve@test.de');
  assert.equal(await hcSpend(12, 100, 'code_page'), 'You need 100 honeycombs – you have 0.');
  assert.deepEqual(await entsOf(12), []);
});

test('a removed unlock stays locked although its ledger row exists; unlocking again books code_page:2', async () => {
  const out = await withAccount(11, (db) => setPeriod(db, 11, 'code_page', 0, { quantity: 0, permanent: false, expiresAt: null }));
  assert.notEqual(out, BUSY);
  assert.equal(await codeUnlocked(11), false);
  assert.equal(await hcSpend(11, 30, 'code_page'), null);
  assert.deepEqual((await ledgerOf(11)).filter((r) => r.reason === 'unlock').map((r) => [r.ref, r.amount]), [['code_page', -100], ['code_page:2', -30]]);
  assert.equal(await codeUnlocked(11), true);
  assert.equal(await withAccount(11, (db) => balanceIn(db, 11)), 20);
});

test('includedFor: a feature that is included for admins needs no row', async () => {
  registerFeature({ key: 'hc_test_incl', owner: 'test', title: 'Included', icon: 'bx-star', description: 'd', kind: 'permanent',
    includedFor: (u) => Number(u.is_admin) === 1, items: { hc_test_incl: { price: 5, active: true } } });
  try {
    assert.equal(await has(3, 'hc_test_incl'), true);
    assert.equal(await has(5, 'hc_test_incl'), false);
    assert.deepEqual(await entitlement(3, 'hc_test_incl'), { active: true, until: null, quantity: 0, permanent: true, included: true, lots: [] });
    assert.equal(await has(3, 'premium'), true, 'Premium is included for admins');
    assert.equal(await isPremium(3), true);
    assert.deepEqual(await premiumState(3), { active: true, until: null, forever: true, source: 'admin-role' });
  } finally {
    unregisterFeatureForTests('hc_test_incl');
  }
});

test('premium: setPeriod writes users.premium_until in the same transaction (timed, for good, removed, ended)', async () => {
  const until = (await one('SELECT premium_until FROM users WHERE id = 5'))?.premium_until;
  assert.equal(until, null);
  const end = addDays(nowStr(), 30);
  const gen0 = Number((await account(5))?.reconcile_gen ?? 0);
  await withAccount(5, (db) => setPeriod(db, 5, 'premium', 0, { quantity: 1, permanent: false, expiresAt: end, source: 'purchase' }));
  assert.equal((await one('SELECT premium_until FROM users WHERE id = 5'))?.premium_until, end);
  assert.equal(await isPremium(5), true);
  assert.deepEqual(await premiumState(5), { active: true, until: end, forever: false, source: 'purchase' });
  assert.equal(Number((await sql("SELECT reminded FROM `DB`.hc_entitlements WHERE user_id = 5 AND feature = 'premium'"))[0].reminded), 0);
  assert.ok(Number((await account(5))?.reconcile_gen) > gen0);

  // Fünf Tage vor dem Ende: Erinnerungsstufe 1 schon gesetzt (keine Erinnerung am Tag des Kaufs)
  await withAccount(5, (db) => setPeriod(db, 5, 'premium', 0, { quantity: 1, permanent: false, expiresAt: addDays(nowStr(), 5) }));
  assert.equal(Number((await sql("SELECT reminded FROM `DB`.hc_entitlements WHERE user_id = 5 AND feature = 'premium'"))[0].reminded), 1);

  await withAccount(5, (db) => setPeriod(db, 5, 'premium', 0, { quantity: 1, permanent: true, expiresAt: null, source: 'admin', grantedBy: 3 }));
  assert.equal((await one('SELECT premium_until FROM users WHERE id = 5'))?.premium_until, PREMIUM_FOREVER);
  assert.deepEqual(await premiumState(5), { active: true, until: null, forever: true, source: 'admin' });
  assert.deepEqual(await entsOf(5), [
    { feature: 'code_page', lot: 0, quantity: 1, permanent: 1, expires_at: null, source: 'legacy' },
    { feature: 'premium', lot: 0, quantity: 1, permanent: 1, expires_at: null, source: 'admin' },
  ]);

  // Entzogen (Menge 0, Ende verarbeitet): kein Premium, NULL
  const now = nowStr();
  await withAccount(5, (db) => setPeriod(db, 5, 'premium', 0, { quantity: 0, permanent: false, expiresAt: now, expiryDoneAt: now }));
  assert.equal((await one('SELECT premium_until FROM users WHERE id = 5'))?.premium_until, null);
  assert.equal(await isPremium(5), false);
  assert.deepEqual(await premiumState(5), { active: false, until: null, forever: false, source: null });
  assert.equal((await sql("SELECT expiry_done_at FROM `DB`.hc_entitlements WHERE user_id = 5 AND feature = 'premium'"))[0].expiry_done_at, now);
  // Wieder aktiv: das Ende zählt wieder als offen
  await withAccount(5, (db) => setPeriod(db, 5, 'premium', 0, { quantity: 1, permanent: false, expiresAt: end }));
  assert.equal((await sql("SELECT expiry_done_at FROM `DB`.hc_entitlements WHERE user_id = 5 AND feature = 'premium'"))[0].expiry_done_at, null);
  // Ein Ende in der Vergangenheit ist kein Premium
  await withAccount(5, (db) => setPeriod(db, 5, 'premium', 0, { quantity: 1, permanent: false, expiresAt: '2026-01-01 00:00:00' }));
  assert.equal(await isPremium(5), false);
  await withAccount(5, (db) => setPeriod(db, 5, 'premium', 0, { quantity: 1, permanent: false, expiresAt: end }));
});

test('the account lock: busy after 5 seconds, at once with NOWAIT; spends never overdraw; misuse is refused', async () => {
  // Fremde Transaktion hält die Zeile des Kontos
  const holder = await adminConnection();
  try {
    await holder.query(`USE \`${t.name}\``);
    await holder.query('START TRANSACTION');
    await holder.query('SELECT * FROM hc_accounts WHERE user_id = 6 FOR UPDATE');
    let started = Date.now();
    assert.equal(await withAccount(6, async () => 'ran', { nowait: true }), BUSY);
    assert.ok(Date.now() - started < 2000, 'NOWAIT gives up at once');
    started = Date.now();
    assert.equal(await hcSpend(6, 0, 'hc_busy_test'), HC_BUSY);
    const waited = Date.now() - started;
    assert.ok(waited >= 4500 && waited < 20000, `waited ${waited} ms`);
    await holder.query('COMMIT');
  } finally {
    await holder.end();
  }
  assert.equal(await withAccount(6, async () => 'free again', { nowait: true }), 'free again');

  // Drei gleichzeitige Freischaltungen, Geld für eine
  await addUser(13, 'thirteen@test.de');
  await adminHcHandle({ hc_action: 'grant', user_id: '13', amount: '100', grant_ref: 'aaaaaaaaaaaaaaa1' }, 3);
  const results = await Promise.all([hcSpend(13, 60, 'hc_f_a'), hcSpend(13, 60, 'hc_f_b'), hcSpend(13, 60, 'hc_f_c')]);
  assert.equal(results.filter((r) => r === null).length, 1);
  assert.deepEqual(results.filter((r) => r !== null), ['You need 60 honeycombs – you have 40.', 'You need 60 honeycombs – you have 40.']);
  assert.equal(Number((await sql('SELECT SUM(amount) AS s FROM `DB`.honeycomb_ledger WHERE user_id = 13'))[0].s), 40);

  // Abbuchen nur unter der Sperre genau dieses Kontos; nie zwei Konten; nie in einer laufenden Transaktion
  await assert.rejects(transaction(async (_c, db) => debit(db, 13, 1, 'purchase', 'x')), /needs the account lock/);
  await assert.rejects(withAccount(13, (db) => debit(db, 5, 1, 'purchase', 'x')), /needs the account lock/);
  await assert.rejects(withAccount(13, () => withAccount(5, async () => 1)), /only one honeycomb account/);
  // (MariaDB lehnt schon die Isolationsstufe ab, die nur vor einer Transaktion geändert werden kann)
  await assert.rejects(transaction(() => withAccount(13, async () => 1)), /already an active transaction|Transaction characteristics/);
  // Ein Fehler in fn rollt zurück und gibt die Sperre frei
  await assert.rejects(withAccount(13, async (db) => {
    await db.exec("INSERT INTO honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (13, -40, 'purchase', 'boom', '', ?)", [nowStr()]);
    throw new Error('boom');
  }), /boom/);
  assert.equal(Number((await sql('SELECT SUM(amount) AS s FROM `DB`.honeycomb_ledger WHERE user_id = 13'))[0].s), 40);
  assert.equal(await withAccount(13, async () => 'ok', { nowait: true }), 'ok');
});

test('a deadlock is run again exactly once, and both sides finish', async () => {
  // Bewusst falsch herum (zwei Konten): A sperrt 5 und will 6, B sperrt 6 und will 5. MariaDB bricht einen ab.
  const arrived = new Set<number>();
  let release: () => void = () => undefined;
  const both = new Promise<void>((r) => (release = r));
  let firstPass = true;
  setPauseGateForTests(async (name, info) => {
    if (name !== 'account-locked' || !firstPass) return;
    arrived.add(Number(info.uid));
    if (arrived.size === 2) {
      firstPass = false;
      release();
    }
    await both;
  });
  const runs: number[] = [];
  const cross = (own: number, other: number) => withAccount(own, async (db) => {
    runs.push(own);
    await db.q('SELECT * FROM hc_accounts WHERE user_id = ? FOR UPDATE', [other]);
    return own;
  });
  try {
    const [a, b] = await Promise.all([cross(5, 6), cross(6, 5)]);
    assert.deepEqual([a, b], [5, 6]);
    assert.equal(runs.length, 3, 'one side ran twice: ' + runs.join(','));
  } finally {
    setPauseGateForTests(null);
  }
});

test('reconcile: a failing enforcer keeps the marker, a change during the run keeps it, success clears it', async () => {
  const calls: number[] = [];
  let fail = true;
  registerEnforcer({ name: 'hc-test', features: ['code_page'], inline: true, run: async (uid) => {
    calls.push(uid);
    if (fail) throw new Error('boom');
  } });
  try {
    await withAccount(7, (db) => markReconcile(db, 7));
    assert.notEqual((await account(7))?.reconcile_at, null);
    assert.equal(await reconcileNow(7), false);
    let acc = await account(7);
    assert.notEqual(acc?.reconcile_at, null);
    assert.equal(acc?.reconcile_tries, 1);
    assert.equal(acc?.reconcile_error, 'hc-test: boom');

    // Während des Laufs ändert sich etwas: der Merker bleibt für den nächsten Lauf
    fail = false;
    let changed = false;
    setPauseGateForTests(async (name, info) => {
      if (name === 'enforcer' && info.uid === 7 && !changed) {
        changed = true;
        await withAccount(7, (db) => markReconcile(db, 7));
      }
    });
    assert.equal(await reconcileNow(7), false);
    assert.notEqual((await account(7))?.reconcile_at, null);
    setPauseGateForTests(null);
    assert.equal(await reconcileNow(7), true);
    acc = await account(7);
    assert.equal(acc?.reconcile_at, null);
    assert.equal(acc?.reconcile_tries, 0);
    assert.equal(acc?.reconcile_error, '');
    assert.ok(calls.filter((u) => u === 7).length >= 3);
    // Nichts offen: kein Lauf
    const before = calls.length;
    assert.equal(await reconcileNow(7), true);
    assert.equal(calls.length, before);

    // Ein langsamer Abgleich (nur im Job): die Anfrage lässt den Merker stehen
    registerEnforcer({ name: 'hc-slow', features: '*', inline: false, run: async () => undefined });
    await withAccount(7, (db) => markReconcile(db, 7));
    assert.equal(await reconcileNow(7, { inlineOnly: true }), false);
    assert.notEqual((await account(7))?.reconcile_at, null);
    assert.equal(await reconcileNow(7), true);
    assert.equal((await account(7))?.reconcile_at, null);
  } finally {
    setPauseGateForTests(null);
    unregisterEnforcerForTests('hc-test');
    unregisterEnforcerForTests('hc-slow');
  }
});

test('the admin role toggle marks the account and runs the reconcile', async () => {
  const calls: number[] = [];
  registerEnforcer({ name: 'hc-role', features: ['premium'], inline: true, run: async (uid) => void calls.push(uid) });
  try {
    assert.equal(await toggleAdmin(9), 1);
    assert.equal((await one('SELECT is_admin FROM users WHERE id = 9'))?.is_admin, 1);
    assert.deepEqual(calls, [9]);
    assert.equal((await account(9))?.reconcile_at, null);
    assert.equal(await isPremium(9), true);
    assert.equal(await toggleAdmin(9), 0);
    assert.equal(await isPremium(9), false);
    assert.deepEqual(calls, [9, 9]);
    // Unbekanntes Konto: nichts markiert
    assert.equal(await toggleAdmin(424242), 1);
    assert.equal(await account(424242), undefined);
  } finally {
    unregisterEnforcerForTests('hc-role');
  }
});

test('the admin role toggle is a request: it runs only the quick enforcers, the slow ones stay for the job', async () => {
  const calls: string[] = [];
  registerEnforcer({ name: 'hc-role-quick', features: ['premium'], inline: true, run: async (uid) => void calls.push('quick:' + uid) });
  registerEnforcer({ name: 'hc-role-slow', features: ['premium'], inline: false, run: async (uid) => void calls.push('slow:' + uid) });
  try {
    assert.equal(await toggleAdmin(8), 1);
    assert.deepEqual(calls, ['quick:8'], 'no slow enforcer (e.g. Cloudflare calls) in the admin request');
    assert.notEqual((await account(8))?.reconcile_at, null, 'the marker stays for the job');
    assert.equal(await toggleAdmin(8), 0);
    assert.deepEqual(calls, ['quick:8', 'quick:8']);
  } finally {
    unregisterEnforcerForTests('hc-role-quick');
    unregisterEnforcerForTests('hc-role-slow');
  }
  // Ohne angemeldete Abgleiche ist danach nichts mehr offen
  assert.equal(await reconcileNow(8), true);
});

test('a free unlock in the admin and hcSpend run the quick enforcers after the commit', async () => {
  const calls: number[] = [];
  registerEnforcer({ name: 'hc-unlock-quick', features: ['code_page'], inline: true, run: async (uid) => void calls.push(uid) });
  try {
    await addUser(15, 'fifteen@test.de');
    assert.deepEqual(await adminCodeHandle({ code_action: 'unlock', user_id: '15', item: 'code_page' }), { ok: 'Code page unlocked for User 15.' });
    assert.deepEqual(calls, [15], 'the code page owner (slots) hears about the unlock at once, not only from a later job');
    assert.equal((await account(15))?.reconcile_at, null);
    await addUser(16, 'sixteen@test.de');
    await adminHcHandle({ hc_action: 'grant', user_id: '16', amount: '100', grant_ref: 'aaaaaaaaaaaaaaa3' }, 3);
    assert.equal(await hcSpend(16, 100, 'code_page'), null);
    assert.deepEqual(calls, [15, 16]);
    assert.equal((await account(16))?.reconcile_at, null);
    // Innerhalb einer Kontosperre ruft hcAdd keinen Abgleich auf (die Verbindung ist noch belegt) – das macht der Aufrufer
    await addUser(17, 'seventeen@test.de');
    const out = await withAccount(17, async (db) => {
      assert.equal(await hcAdd(17, 0, 'unlock', 'code_page', 'Unlocked by the team', db), true);
      return calls.length;
    });
    assert.equal(out, 2);
    assert.notEqual((await account(17))?.reconcile_at, null);
  } finally {
    unregisterEnforcerForTests('hc-unlock-quick');
  }
});

test('the admin role toggle takes the honeycomb account before the user row, like every purchase (no deadlock)', async () => {
  // Ein Kauf (z. B. Premium): Konto gesperrt, Zeilen geschrieben, zuletzt users (premium_until, code_terms_at)
  const buyer = await adminConnection();
  let bought = '';
  let toggled: Promise<number | string> = Promise.resolve('not started');
  try {
    await buyer.query(`USE \`${t.name}\``);
    await buyer.query('START TRANSACTION');
    await buyer.query('SELECT * FROM hc_accounts WHERE user_id = 6 FOR UPDATE');
    for (let i = 0; i < 3; i++) {
      await buyer.query("INSERT INTO hc_audit (admin_id, action, user_id, target, details, created_at) VALUES (3, 'lock_test', NULL, '', '{}', ?)", [nowStr()]);
    }
    toggled = toggleAdmin(6).catch((err: Error) => err.message);
    await new Promise((r) => setTimeout(r, 500));
    try {
      await buyer.query('UPDATE users SET premium_until = NULL WHERE id = 6');
      await buyer.query('COMMIT');
      bought = 'committed';
    } catch (err) {
      bought = (err as Error).message;
      await buyer.query('ROLLBACK').catch(() => undefined);
    }
    assert.equal(bought, 'committed');
    assert.equal(await toggled, 1);
  } finally {
    await toggled;
    await buyer.end();
  }
  assert.equal(await toggleAdmin(6), 0);
  await sql("DELETE FROM `DB`.hc_audit WHERE action = 'lock_test'");
});

test('deleting an account removes every honeycomb row; the audit keeps only numbers', async () => {
  await sql("INSERT INTO `DB`.hc_audit (admin_id, action, user_id, target, details, created_at) VALUES (3, 'grant', 7, '', '{\"amount\":5}', ?)", [nowStr()]);
  assert.ok((await ledgerOf(7)).length > 0 && (await entsOf(7)).length > 0 && (await account(7)) !== undefined);
  await deleteAccount(null, 7);
  assert.deepEqual(await ledgerOf(7), []);
  assert.deepEqual(await entsOf(7), []);
  assert.equal(await account(7), undefined);
  // Die Zeile des gelöschten Kontos bleibt ohne Bezug; Zeilen anderer Konten (Geschenke oben) behalten ihren
  assert.deepEqual((await sql("SELECT admin_id, action, user_id, details FROM `DB`.hc_audit WHERE action = 'grant' AND (user_id IS NULL OR user_id = 7)")).map((r) => ({ ...r })),
    [{ admin_id: 3, action: 'grant', user_id: null, details: '{"amount":5}' }]);
  assert.equal(Number((await sql("SELECT COUNT(*) AS n FROM `DB`.hc_audit WHERE action = 'grant' AND user_id IS NOT NULL"))[0].n) > 0, true);
  // Andere Konten unberührt
  assert.ok((await ledgerOf(5)).length > 0 && (await entsOf(5)).length > 0);
});

// GET /dashboard als Nutzer (optional als Admin im Nutzer-Modus): window.OYS_EDITOR
async function bootstrap(userId: number, impersonatedBy?: number): Promise<Record<string, unknown>> {
  const sid = await loginSession(userId, { impersonatedBy });
  const ctx = await runRequest(makeTestCtx({ url: '/dashboard', cookies: { PHPSESSID: sid } }), appRoutes);
  assert.equal(ctx.status, 200);
  const m = /window\.OYS_EDITOR = (.*);<\/script>/.exec(String(ctx.body));
  assert.ok(m, 'bootstrap script');
  return JSON.parse(m[1]) as Record<string, unknown>;
}

test('the editor bootstrap: premium is the real status (PD-1), staff separately, plus premiumUntil and premiumForever', async () => {
  // Mia: zeitlich begrenzt (aus dem Premium-Test) – E.premium ist ihr echter Stand, sie ist nicht im Team
  let e = await bootstrap(5);
  assert.equal(e.premium, true);
  assert.equal(e.staff, false);
  assert.equal(e.premiumUntil, (await one('SELECT premium_until FROM users WHERE id = 5'))?.premium_until);
  assert.equal(e.premiumForever, false);
  // Hinter „premium“, „pagesUnlimited“ (Seitenplätze) und „staff“ – die älteren Schlüssel behalten ihre Reihenfolge
  const keys = Object.keys(e);
  assert.deepEqual(keys.slice(keys.indexOf('premium'), keys.indexOf('premium') + 5), ['premium', 'pagesUnlimited', 'staff', 'premiumUntil', 'premiumForever']);
  // Admin: immer Premium und Team
  e = await bootstrap(3);
  assert.equal(e.premium, true);
  assert.equal(e.staff, true);
  assert.equal(e.premiumUntil, null);
  assert.equal(e.premiumForever, true);
  // Admin im Nutzer-Modus bei Tom: Team (Seiten, Wartezeit), aber Premium ist der echte Stand von Tom
  e = await bootstrap(6, 3);
  assert.equal(e.premium, false);
  assert.equal(e.staff, true);
  assert.equal(e.premiumUntil, null);
  assert.equal(e.premiumForever, false);
});

test('code-unlock in the editor unlocks through the shop core', async () => {
  await addUser(14, 'fourteen@test.de');
  await adminHcHandle({ hc_action: 'grant', user_id: '14', amount: '120', grant_ref: 'aaaaaaaaaaaaaaa2' }, 3);
  const sid = await loginSession(14);
  const ctx = await runRequest(makeTestCtx({
    method: 'POST', url: '/dashboard/api/code-unlock', cookies: { PHPSESSID: sid },
    headers: { 'content-type': 'application/json', 'x-csrf-token': CSRF },
    rawBody: Buffer.from(JSON.stringify({ terms: true, request_id: 'c'.repeat(32), expected_price: 100 })),
  }), appRoutes);
  const body = jsonBody(ctx);
  assert.equal(body.ok, true);
  assert.equal(body.unlocked, true);
  assert.deepEqual(await entsOf(14), [{ feature: 'code_page', lot: 0, quantity: 1, permanent: 1, expires_at: null, source: 'purchase' }]);
  assert.deepEqual((await q("SELECT ref FROM honeycomb_ledger WHERE user_id = 14 AND reason = 'unlock'")).map((r) => r.ref), ['code_page']);
});
