// Verbindungsregel des Shops mit einem Pool von EINER Verbindung und dem strengen Schalter: Alles, was andere Bereiche
// in ihrer eigenen Sperre lesen (has, quantity, entitlement, Premium, codeUnlocked), läuft über die Verbindung des
// Aufrufers – eine zweite aus dem Pool fiele sofort auf (und würde unter Last ewig warten).
process.env.OYS_DB_POOL_SIZE = '1';
process.env.OYS_DB_STRICT = '1';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NestedConnectionError, outsidePinned, q } from '../src/db.js';
import { ensureSchema } from '../src/schema.js';
import { BUSY, withAccount } from '../src/honeycombs/ledger.js';
import { entitlement, grantUnlock, has, quantity, setPeriod } from '../src/honeycombs/entitlements.js';
import { isPremium, premiumState } from '../src/honeycombs/premium.js';
import { reconcileNow, registerEnforcer, unregisterEnforcerForTests } from '../src/honeycombs/reconcile.js';
import { hcSpend } from '../src/honeycombs/honeycombs.js';
import { codeUnlocked } from '../src/code/sites.js';
import { toggleAdmin } from '../src/admin/users.js';
import { addDays, nowStr } from '../src/honeycombs/clock.js';
import { buy, refund } from '../src/honeycombs/shop.js';
import { randomHex } from '../src/crypto.js';
import { testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;

before(async () => {
  t = await testDatabase('hc2pool');
  await ensureSchema();
});

after(async () => {
  await t.done();
});

test('reads inside the account lock use the caller\'s connection (they see its uncommitted writes); a second one is refused', async () => {
  const out = await withAccount(6, async (db) => {
    assert.equal(await has(6, 'code_page', db), false);
    await grantUnlock(db, 6, 'code_page', 0, 'Unlocked by the team', 3, 'admin');
    await setPeriod(db, 6, 'premium', 0, { quantity: 1, permanent: false, expiresAt: addDays(nowStr(), 30), source: 'admin' });
    // Noch nicht festgeschrieben – nur auf DIESER Verbindung sichtbar
    assert.equal(await has(6, 'code_page', db), true);
    assert.equal(await codeUnlocked(6, db), true);
    assert.equal(await quantity(6, 'code_page', db), 1);
    assert.equal((await entitlement(6, 'premium', db)).active, true);
    assert.equal(await isPremium(6, db), true);
    assert.equal((await premiumState(6, db)).source, 'admin');
    await assert.rejects(outsidePinned(() => q('SELECT 1')), NestedConnectionError);
    return 'done';
  });
  assert.equal(out, 'done');
  assert.equal(await codeUnlocked(6), true);
  assert.equal(await isPremium(6), true);
});

test('enforcers never run while the caller holds the connection; after the commit they do', async () => {
  const calls: number[] = [];
  registerEnforcer({ name: 'hc-pool', features: '*', inline: true, run: async (uid) => {
    // Ein Abgleich holt sich seine eigene Verbindung (hier: die einzige des Pools)
    await q('SELECT id FROM users WHERE id = ?', [uid]);
    calls.push(uid);
  } });
  const orig = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
  try {
    await withAccount(5, async (db) => {
      await setPeriod(db, 5, 'premium', 0, { quantity: 1, permanent: true, expiresAt: null, source: 'admin' });
      // Falsch benutzt (in der Sperre): läuft nicht, der Merker bleibt für später
      assert.equal(await reconcileNow(5), false);
    });
    assert.deepEqual(calls, []);
    assert.ok(logged.some((l) => l.includes('second pool connection')), logged.join('\n'));
    assert.equal(await reconcileNow(5), true);
    assert.deepEqual(calls, [5]);
    // Admin-Rolle umschalten: Transaktion auf der einen Verbindung, danach der Abgleich
    assert.equal(await toggleAdmin(7), 1);
    assert.equal(await toggleAdmin(7), 0);
    assert.deepEqual(calls, [5, 7, 7]);
  } finally {
    console.error = orig;
    unregisterEnforcerForTests('hc-pool');
  }
});

test('hcSpend works with a pool of one', async () => {
  await q("INSERT INTO honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (8, 100, 'admin', 'a3-pool000000000001', '', ?)", [nowStr()]);
  assert.equal(await hcSpend(8, 100, 'code_page'), null);
  assert.equal(await codeUnlocked(8), true);
  assert.notEqual(await withAccount(8, async () => 1, { nowait: true }), BUSY);
});

test('buying and refunding work with a pool of one (no second connection anywhere on the way)', async () => {
  await q("INSERT INTO honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (7, 150, 'admin', 'a3-pool000000000002', '', ?)", [nowStr()]);
  await q('UPDATE users SET code_terms_at = NULL WHERE id = 7');
  await q("DELETE FROM hc_entitlements WHERE user_id = 7 AND feature = 'code_page'");
  const r = await buy(null, 7, 'code_page', randomHex(16), 100, { via: 'code', terms: true });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(await codeUnlocked(7), true);
  const back = await refund(3, r.purchase.id, null, true);
  assert.ok('ok' in back, JSON.stringify(back));
  assert.equal(await codeUnlocked(7), false);
});
