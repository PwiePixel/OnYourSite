// Katalog, Angebote, Käufe und Erstattungen mit Datenbank: Startpreise, buy() mit allen Prüfungen, Wiederholungen,
// Angebote (Vorrang, Grenzen je Konto auch nach einer Erstattung, Mindestalter, Einlösungen), Wettläufe mit festen
// Haltepunkten, Zeitpakete und Premium, die Rechnung bei Erstattungen und das Anlegen und Absagen von Angeboten.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { one } from '../src/db.js';
import type { Ctx } from '../src/web/ctx.js';
import { randomHex } from '../src/crypto.js';
import { ensureSchema } from '../src/schema.js';
import { setPauseGateForTests } from '../src/honeycombs/ledger.js';
import {
  registerFeature, registerPerk, setLifecycleReadyForTests, unregisterFeatureForTests, unregisterPerksForTests, type Feature,
} from '../src/honeycombs/features.js';
import { entitlement, has, setPeriod } from '../src/honeycombs/entitlements.js';
import { withAccount } from '../src/honeycombs/ledger.js';
import { isPremium, premiumState } from '../src/honeycombs/premium.js';
import { ensureCatalogue, seedItems, shopPrice } from '../src/honeycombs/catalogue.js';
import { cancelOffer, createOffer, type OfferInput } from '../src/honeycombs/offers.js';
import { buy, purchaseUnlock, refund } from '../src/honeycombs/shop.js';
import { adminHcHandle } from '../src/honeycombs/honeycombs.js';
import { deleteAccount } from '../src/admin/accountDeletion.js';
import { addDays, addSeconds, dayLabel, nowStr } from '../src/honeycombs/clock.js';
import '../src/code/shop.js';
import { testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
const OLD = '2026-01-01 10:00:00';
const rid = (): string => randomHex(16);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sql(query: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [r] = await t.admin.query<RowDataPacket[]>(query.replace(/`DB`/g, '`' + t.name + '`'), params);
  return r;
}
const plain = (rows: RowDataPacket[]) => rows.map((r) => ({ ...r }));
async function give(uid: number, amount: number): Promise<void> {
  await sql("INSERT INTO `DB`.honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (?, ?, 'admin', ?, '', ?)", [uid, amount, 'a3-' + randomHex(8), nowStr()]);
}
const balance = async (uid: number): Promise<number> => Number((await sql('SELECT COALESCE(SUM(amount), 0) AS s FROM `DB`.honeycomb_ledger WHERE user_id = ?', [uid]))[0].s);

// Admin im Nutzer-Modus (nur die Sitzung zählt)
const adminCtx = { session: { get: (k: string) => (k === 'original_admin_id' ? 3 : undefined) } } as unknown as Ctx;

// Einen Ablauf an einem Haltepunkt anhalten, bis release() kommt
function holdAt(point: string, uid: number): { reached: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  let reached: () => void = () => undefined;
  const released = new Promise<void>((r) => (release = r));
  const arrived = new Promise<void>((r) => (reached = r));
  let done = false;
  setPauseGateForTests(async (name, info) => {
    if (done || name !== point || info.uid !== uid) return;
    done = true;
    reached();
    await released;
  });
  return { reached: arrived, release };
}

const TEST_FEATURES: Feature[] = [];
function feat(f: Partial<Feature> & { key: string; title: string; items: Feature['items'] }): void {
  const full: Feature = { owner: 'test', icon: 'bx-star', description: 'Test', kind: 'permanent', ...f };
  registerFeature(full);
  TEST_FEATURES.push(full);
}

before(async () => {
  t = await testDatabase('hc3', { empty: true });
  await ensureSchema();
  const user = 'INSERT INTO `DB`.users (id, email, password, full_name, is_admin, created_at) VALUES (?, ?, \'x\', ?, ?, ?)';
  await sql(user, [3, 'admin@test.de', 'Pixel Admin', 1, OLD]);
  for (let id = 5; id <= 20; id++) await sql(user, [id, `u${id}@test.de`, 'User ' + id, 0, id === 8 ? nowStr() : OLD]);
  feat({ key: 'hc_t_perm', title: 'Perm test', items: { hc_t_perm: { price: 50, active: true } } });
  feat({ key: 'hc_t_req', title: 'Req test', requires: 'hc_t_perm', items: { hc_t_req: { price: 10, active: true } } });
  feat({ key: 'hc_t_free', title: 'Free test', freeAtZero: true, items: { hc_t_free: { price: 0, active: true } } });
  feat({ key: 'hc_t_rule', title: 'Rule test', canBuy: async (c) => (c.input.terms ? null : 'Please accept the test rules first.'),
    items: { hc_t_rule: { price: 5, active: true } } });
  feat({ key: 'hc_t_hidden', title: 'Hidden test', ready: () => false, items: { hc_t_hidden: { price: 5, active: true } } });
  feat({ key: 'hc_t_young', title: 'Young test', items: { hc_t_young: { price: 5, active: true, minAccountDays: 30 } } });
  feat({ key: 'hc_t_incl', title: 'Incl test', includedFor: (u) => Number(u.is_admin) === 1, items: { hc_t_incl: { price: 5, active: true } } });
  feat({ key: 'hc_t_time', title: 'Time test', kind: 'timed', stack: 2, items: { hc_t_time_30: { days: 30, price: 60, active: true } } });
  feat({ key: 'hc_t_long', title: 'Long test', kind: 'timed', items: { hc_t_long_365: { days: 365, price: 1, active: true } } });
  feat({ key: 'hc_t_pass', title: 'Pass test', kind: 'consumable', max: 6, items: { hc_t_pass_x3: { units: 3, price: 30, active: true } } });
  feat({ key: 'hc_t_cnt', title: 'Count test', kind: 'count', max: 2, items: { hc_t_cnt_x1: { units: 1, price: 40, active: true } } });
  for (const k of ['hc_t_p1', 'hc_t_p2', 'hc_t_p3', 'hc_t_p4', 'hc_t_p5', 'hc_t_trial', 'hc_t_offer']) feat({ key: k, title: k, items: { [k]: { price: 50, active: true } } });
  setLifecycleReadyForTests(true);
});

after(async () => {
  setPauseGateForTests(null);
  setLifecycleReadyForTests(false);
  unregisterPerksForTests('premium-domains');
  for (const f of TEST_FEATURES) unregisterFeatureForTests(f.key);
  await t.done();
});

test('seedItems: the start prices of Q4, the old code page price, Premium inactive; what an admin changed stays', async () => {
  await sql("REPLACE INTO `DB`.oys_meta (meta_key, meta_value) VALUES ('honeycombs', '{\"code_page\":120}')");
  await ensureCatalogue();
  const items = plain(await sql("SELECT item_key, feature, days, units, price, is_active, min_account_days, min_active_days FROM `DB`.hc_items WHERE item_key IN ('premium_30', 'premium_90', 'code_page', 'hc_t_time_30', 'hc_t_pass_x3') ORDER BY item_key"));
  assert.deepEqual(items, [
    { item_key: 'code_page', feature: 'code_page', days: null, units: 1, price: 120, is_active: 1, min_account_days: 0, min_active_days: 0 },
    { item_key: 'hc_t_pass_x3', feature: 'hc_t_pass', days: null, units: 3, price: 30, is_active: 1, min_account_days: 0, min_active_days: 0 },
    { item_key: 'hc_t_time_30', feature: 'hc_t_time', days: 30, units: 1, price: 60, is_active: 1, min_account_days: 0, min_active_days: 0 },
    { item_key: 'premium_30', feature: 'premium', days: 30, units: 1, price: 350, is_active: 0, min_account_days: 30, min_active_days: 10 },
    { item_key: 'premium_90', feature: 'premium', days: 90, units: 1, price: 700, is_active: 0, min_account_days: 30, min_active_days: 10 },
  ]);
  await sql("UPDATE `DB`.hc_items SET price = 300 WHERE item_key = 'premium_30'");
  assert.equal(await seedItems(), 0);
  assert.equal(Number((await sql("SELECT price FROM `DB`.hc_items WHERE item_key = 'premium_30'"))[0].price), 300);
  await sql("UPDATE `DB`.hc_items SET price = 350 WHERE item_key = 'premium_30'");
  await sql("UPDATE `DB`.hc_items SET price = 100 WHERE item_key = 'code_page'");
  assert.equal(await shopPrice('code_page'), 100);
});

test('a permanent unlock: one ledger row, one purchase, the entitlement and a notice; a replay charges nothing', async () => {
  await give(5, 500);
  const id1 = rid();
  const r = await buy(null, 5, 'hc_t_perm', id1, 50, { via: 'shop' });
  assert.ok(r.ok);
  assert.equal(r.replay, false);
  assert.deepEqual(r.notices, [{ tone: 'hc', text: 'Perm test unlocked', amount: -50 }]);
  assert.equal(r.balance, 450);
  assert.deepEqual(r.purchase, { id: r.purchase.id, item: 'hc_t_perm', feature: 'hc_t_perm', title: 'Perm test', price: 50, listPrice: 50, expiresAt: null, quantity: 1 });
  assert.equal(r.entitlement.active, true);
  const ledger = plain(await sql("SELECT id, amount, reason, ref, note FROM `DB`.honeycomb_ledger WHERE user_id = 5 AND reason = 'unlock'"));
  assert.deepEqual(ledger.map(({ id: _id, ...rest }) => rest), [{ amount: -50, reason: 'unlock', ref: 'hc_t_perm', note: 'Perm test' }]);
  const p = plain(await sql('SELECT request_id, item_key, feature, lot, units, days, list_price, price, offer_id, ledger_id, via, period_start, period_end, refunded_at FROM `DB`.hc_purchases WHERE user_id = 5'));
  assert.deepEqual(p, [{ request_id: id1, item_key: 'hc_t_perm', feature: 'hc_t_perm', lot: 0, units: 1, days: null, list_price: 50, price: 50, offer_id: null,
    ledger_id: ledger[0].id, via: 'shop', period_start: null, period_end: null, refunded_at: null }]);
  assert.equal((await sql('SELECT reconcile_at FROM `DB`.hc_accounts WHERE user_id = 5'))[0].reconcile_at, null, 'reconciled after the commit');

  const again = await buy(null, 5, 'hc_t_perm', id1, 50, { via: 'shop' });
  assert.ok(again.ok);
  assert.equal(again.replay, true);
  assert.deepEqual(again.notices, []);
  assert.equal(again.purchase.id, r.purchase.id);
  assert.equal(await balance(5), 450);
  assert.deepEqual(await buy(null, 5, 'hc_t_req', id1, 10, { via: 'shop' }),
    { ok: false, status: 409, code: 'request_used', error: 'This request was already used. Please reload and try again.' });
  assert.deepEqual(await buy(null, 5, 'hc_t_perm', rid(), 50, { via: 'shop' }), { ok: false, status: 200, code: 'owned', error: 'You already own this.' });
  assert.equal(await balance(5), 450);
});

test('refusals: admin mode, bad input, not for sale, account age, active days, hold, requires, owner rules, included, price and balance', async () => {
  await give(6, 20);
  const no = async (r: Promise<unknown>, code: string, error?: string, status = 200) => {
    const out = (await r) as { ok: boolean; status: number; code: string; error: string };
    assert.equal(out.ok, false, code);
    assert.equal(out.code, code);
    assert.equal(out.status, status, code);
    if (error !== undefined) assert.equal(out.error, error, code);
  };
  await no(buy(adminCtx, 6, 'hc_t_perm', rid(), 50, { via: 'shop' }), 'admin_mode', 'Buying is turned off in admin mode.', 403);
  assert.equal(plain(await sql('SELECT id FROM `DB`.hc_purchases WHERE user_id = 6')).length, 0);
  await no(buy(null, 6, 'hc_t_perm', 'not-an-id', 50, { via: 'shop' }), 'bad_request', 'Not all of the data arrived. Please try again.', 400);
  await no(buy(null, 6, 'hc_t_perm', rid(), -1, { via: 'shop' }), 'bad_request', undefined, 400);
  await no(buy(null, 6, 'hc_t_perm', rid(), 1.5, { via: 'shop' }), 'bad_request', undefined, 400);
  await no(buy(null, 6, 'hc_t_perm', rid(), 50, { via: 'auto' }), 'bad_request', undefined, 400);
  const NA = 'This isn’t available right now.';
  await no(buy(null, 6, 'no_such_item', rid(), 50, { via: 'shop' }), 'unavailable', NA);
  await sql("UPDATE `DB`.hc_items SET is_active = 0 WHERE item_key = 'hc_t_perm'");
  await no(buy(null, 6, 'hc_t_perm', rid(), 50, { via: 'shop' }), 'unavailable', NA);
  await sql("UPDATE `DB`.hc_items SET is_active = 1, available_from = ? WHERE item_key = 'hc_t_perm'", [addDays(nowStr(), 1)]);
  await no(buy(null, 6, 'hc_t_perm', rid(), 50, { via: 'shop' }), 'unavailable', NA);
  await sql("UPDATE `DB`.hc_items SET available_from = NULL, available_until = ? WHERE item_key = 'hc_t_perm'", [addDays(nowStr(), -1)]);
  await no(buy(null, 6, 'hc_t_perm', rid(), 50, { via: 'shop' }), 'unavailable', NA);
  await sql("UPDATE `DB`.hc_items SET available_until = NULL WHERE item_key = 'hc_t_perm'");
  await no(buy(null, 6, 'hc_t_hidden', rid(), 5, { via: 'shop' }), 'unavailable', NA);
  setLifecycleReadyForTests(false);
  await no(buy(null, 6, 'hc_t_time_30', rid(), 60, { via: 'shop' }), 'unavailable', NA);
  setLifecycleReadyForTests(true);
  await no(buy(null, 6, 'hc_t_free', rid(), 0, { via: 'shop' }), 'free', 'Nothing to unlock – this is free right now.');
  await give(8, 100);
  await no(buy(null, 8, 'hc_t_young', rid(), 5, { via: 'shop' }), 'too_new', 'This is available once your account is 30 days old.');
  await sql("UPDATE `DB`.hc_items SET min_active_days = 2 WHERE item_key = 'hc_t_young'");
  await no(buy(null, 6, 'hc_t_young', rid(), 5, { via: 'shop' }), 'too_inactive', 'This is available once you’ve been active on 2 days.');
  await sql("INSERT INTO `DB`.honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (6, 0, 'daily', '2026-10-01', '', ?), (6, 0, 'daily', '2026-10-02', '', ?)", [OLD, OLD]);
  assert.ok((await buy(null, 6, 'hc_t_young', rid(), 5, { via: 'shop' })).ok);
  await sql("UPDATE `DB`.hc_accounts SET frozen_at = ?, frozen_reason = 'test' WHERE user_id = 6", [nowStr()]);
  await no(buy(null, 6, 'hc_t_rule', rid(), 5, { via: 'shop', terms: true }), 'frozen', 'Your honeycombs are on hold. Please contact the team.');
  await sql('UPDATE `DB`.hc_accounts SET frozen_at = NULL, frozen_reason = NULL WHERE user_id = 6');
  await no(buy(null, 6, 'hc_t_req', rid(), 10, { via: 'shop' }), 'requires', 'Needs your perm test first.');
  await no(buy(null, 6, 'hc_t_rule', rid(), 5, { via: 'shop' }), 'rule', 'Please accept the test rules first.');
  assert.ok((await buy(null, 6, 'hc_t_rule', rid(), 5, { via: 'shop', terms: true })).ok);
  await no(buy(null, 3, 'hc_t_incl', rid(), 5, { via: 'shop' }), 'included', 'This is included with your account.');
  const changed = await buy(null, 6, 'hc_t_perm', rid(), 49, { via: 'shop' });
  assert.deepEqual(changed, { ok: false, status: 200, code: 'price_changed', error: 'The price changed – this now costs 50 honeycombs.', price: 50 });
  await no(buy(null, 6, 'hc_t_perm', rid(), 50, { via: 'shop' }), 'balance', 'You need 50 honeycombs – you have 10.');
  assert.equal(await balance(6), 10);

  // Code-Seite: die Regeln werden im Kauf angekreuzt und in seiner Transaktion gespeichert
  await give(7, 200);
  await no(buy(null, 7, 'code_page', rid(), 100, { via: 'code' }), 'rule', 'Please read and accept the rules for code pages first.');
  assert.equal((await one('SELECT code_terms_at FROM users WHERE id = 7'))?.code_terms_at, null);
  await no(buy(adminCtx, 7, 'code_page', rid(), 100, { via: 'code', terms: true }), 'admin_mode', undefined, 403);
  assert.equal((await one('SELECT code_terms_at FROM users WHERE id = 7'))?.code_terms_at, null, 'admin mode writes nothing');
  const unlocked = await buy(null, 7, 'code_page', rid(), 100, { via: 'code', terms: true });
  assert.ok(unlocked.ok);
  assert.deepEqual(unlocked.notices, [{ tone: 'hc', text: 'Code page unlocked', amount: -100 }]);
  assert.notEqual((await one('SELECT code_terms_at FROM users WHERE id = 7'))?.code_terms_at, null);
  assert.equal((await sql("SELECT via FROM `DB`.hc_purchases WHERE user_id = 7 AND item_key = 'code_page'"))[0].via, 'code');
});

async function offer(scope: string, o: { percent?: number; fixed?: number; maxUses?: number; perUser?: number; minAccount?: number;
  starts?: string; ends?: string; cancelled?: boolean } = {}): Promise<number> {
  const r = await sql(`INSERT INTO \`DB\`.hc_offers (label, scope, percent_off, fixed_price, starts_at, ends_at, max_uses, uses, per_user_max, min_account_days,
      min_active_days, cancelled_at, form_ref, created_by, created_at) VALUES ('Test', ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, ?, ?, 3, ?)`,
  [scope, o.percent ?? null, o.fixed ?? null, o.starts ?? addDays(nowStr(), -1), o.ends ?? addDays(nowStr(), 5), o.maxUses ?? null, o.perUser ?? null,
    o.minAccount ?? 0, o.cancelled ? nowStr() : null, randomHex(8), nowStr()]);
  return (r as unknown as { insertId: number }).insertId;
}

test('offers: rounding up, the most specific wins a tie, per-account limits count refunded purchases, account age, ignored offers', async () => {
  await give(9, 1000);
  const a = await offer('all', { percent: 30 });
  assert.equal(await shopPrice('hc_t_offer'), 35);
  assert.equal(await shopPrice('hc_t_offer', 9), 35);
  const b = await offer('item:hc_t_offer', { fixed: 35 });
  const r = await buy(null, 9, 'hc_t_offer', rid(), 35, { via: 'shop' });
  assert.ok(r.ok);
  assert.equal(r.purchase.price, 35);
  assert.equal(r.purchase.listPrice, 50);
  assert.deepEqual(plain(await sql("SELECT offer_id, price, list_price FROM `DB`.hc_purchases WHERE user_id = 9 AND item_key = 'hc_t_offer'")), [{ offer_id: b, price: 35, list_price: 50 }]);
  assert.deepEqual(plain(await sql('SELECT id, uses FROM `DB`.hc_offers WHERE id IN (?, ?) ORDER BY id', [a, b])), [{ id: a, uses: 0 }, { id: b, uses: 1 }]);

  // „Einmal je Konto“: eine Erstattung gibt das Angebot nicht wieder frei
  await offer('item:hc_t_trial', { fixed: 5, perUser: 1 });
  const trial = await buy(null, 9, 'hc_t_trial', rid(), 5, { via: 'shop' });
  assert.ok(trial.ok);
  assert.ok('ok' in (await refund(3, trial.purchase.id, null, true, '')));
  assert.equal(await has(9, 'hc_t_trial'), false);
  assert.deepEqual(await buy(null, 9, 'hc_t_trial', rid(), 5, { via: 'shop' }),
    { ok: false, status: 200, code: 'price_changed', error: 'The price changed – this now costs 35 honeycombs.', price: 35 });
  // Mindestalter eines Angebots: neue Konten zahlen den Listenpreis
  await offer('feature:hc_t_p1', { percent: 50, minAccount: 30 });
  assert.equal(await shopPrice('hc_t_p1', 8), 35, 'the general 30 % still applies');
  assert.equal(await shopPrice('hc_t_p1', 9), 25);
  // Abgesagt, vorbei, noch nicht begonnen: zählen nicht
  await sql('DELETE FROM `DB`.hc_offers');
  await offer('all', { percent: 90, cancelled: true });
  await offer('all', { percent: 90, starts: addDays(nowStr(), -5), ends: addDays(nowStr(), -1) });
  await offer('all', { percent: 90, starts: addDays(nowStr(), 1), ends: addDays(nowStr(), 2) });
  assert.equal(await shopPrice('hc_t_p1', 9), 50);
  await sql('DELETE FROM `DB`.hc_offers');
});

test('an offer with one use left: two buyers at once, exactly one gets it', async () => {
  await give(10, 100);
  const m = await offer('item:hc_t_p2', { fixed: 10, maxUses: 1 });
  // X zählt das Angebot und hält vor der Buchung an; Y wartet auf dieselbe Zeile des Angebots
  const hold = holdAt('before-debit', 9);
  const x = buy(null, 9, 'hc_t_p2', rid(), 10, { via: 'shop' });
  await hold.reached;
  const y = buy(null, 10, 'hc_t_p2', rid(), 10, { via: 'shop' });
  await sleep(400);
  hold.release();
  const [rx, ry] = await Promise.all([x, y]);
  setPauseGateForTests(null);
  assert.ok(rx.ok && rx.purchase.price === 10);
  assert.deepEqual(ry, { ok: false, status: 200, code: 'price_changed', error: 'The price changed – this now costs 50 honeycombs.', price: 50 });
  assert.equal(Number((await sql('SELECT uses FROM `DB`.hc_offers WHERE id = ?', [m]))[0].uses), 1);
  await sql('DELETE FROM `DB`.hc_offers');
});

test('races: the same request twice books once; money for three of five buys; a purchase and an admin deduction never overdraw', async () => {
  // Gleiche Anfrage-ID, die zweite wartet hinter der ersten
  await give(11, 500);
  const id = rid();
  const hold = holdAt('after-purchase-insert', 11);
  const a = buy(null, 11, 'hc_t_p3', id, 50, { via: 'shop' });
  await hold.reached;
  const b = buy(null, 11, 'hc_t_p3', id, 50, { via: 'shop' });
  await sleep(300);
  hold.release();
  const [ra, rb] = await Promise.all([a, b]);
  setPauseGateForTests(null);
  assert.ok(ra.ok && !ra.replay);
  assert.ok(rb.ok && rb.replay);
  assert.equal(ra.purchase.id, rb.purchase.id);
  assert.equal(plain(await sql('SELECT id FROM `DB`.hc_purchases WHERE user_id = 11 AND request_id = ?', [id])).length, 1);
  assert.equal(plain(await sql("SELECT id FROM `DB`.honeycomb_ledger WHERE user_id = 11 AND reason = 'unlock' AND ref = 'hc_t_p3'")).length, 1);
  assert.equal(await balance(11), 450);

  // Geld für drei von fünf Käufen; jeder hält kurz vor der Buchung an
  await give(12, 150);
  setPauseGateForTests(async (name, info) => {
    if (name === 'before-debit' && info.uid === 12) await sleep(50);
  });
  const results = await Promise.all(['hc_t_p1', 'hc_t_p2', 'hc_t_p3', 'hc_t_p4', 'hc_t_p5'].map((k) => buy(null, 12, k, rid(), 50, { via: 'shop' })));
  setPauseGateForTests(null);
  assert.equal(results.filter((r) => r.ok).length, 3);
  assert.deepEqual(results.filter((r) => !r.ok).map((r) => (r.ok ? '' : r.error)), ['You need 50 honeycombs – you have 0.', 'You need 50 honeycombs – you have 0.']);
  assert.equal(await balance(12), 0);

  // Ein Kauf hält nach der Prüfung des Kontostands; der Abzug des Admins wartet und sieht danach den neuen Stand
  await give(13, 100);
  const hold2 = holdAt('before-debit', 13);
  const p = buy(null, 13, 'hc_t_p4', rid(), 50, { via: 'shop' });
  await hold2.reached;
  const d = adminHcHandle({ hc_action: 'grant', user_id: '13', amount: '-80', grant_ref: randomHex(8), _confirmed: '1' }, 3);
  await sleep(300);
  hold2.release();
  const [rp, rd] = await Promise.all([p, d]);
  setPauseGateForTests(null);
  assert.ok(rp.ok);
  assert.deepEqual(rd, { error: 'That would take the balance below 0 (current: 50).' });
  assert.equal(await balance(13), 50);
});

test('timed packs: a second pack, all packs taken, extending the one that ends first, the 400-day limit', async () => {
  await give(14, 1000);
  const first = await buy(null, 14, 'hc_t_time_30', rid(), 60, { via: 'shop' });
  const second = await buy(null, 14, 'hc_t_time_30', rid(), 60, { via: 'shop' });
  assert.ok(first.ok && second.ok);
  const lots = plain(await sql("SELECT lot, period_start, period_end FROM `DB`.hc_purchases WHERE user_id = 14 AND feature = 'hc_t_time' ORDER BY id"));
  assert.deepEqual(lots.map((l) => l.lot), [0, 1]);
  assert.equal(lots[0].period_end, addDays(lots[0].period_start, 30));
  assert.deepEqual(await buy(null, 14, 'hc_t_time_30', rid(), 60, { via: 'shop', mode: 'stack' }),
    { ok: false, status: 200, code: 'packs_full', error: 'You already have 2 packs – you can extend one instead.' });
  const ext = await buy(null, 14, 'hc_t_time_30', rid(), 60, { via: 'shop', mode: 'extend' });
  assert.ok(ext.ok);
  const third = plain(await sql("SELECT lot, period_start, period_end FROM `DB`.hc_purchases WHERE user_id = 14 AND feature = 'hc_t_time' ORDER BY id DESC LIMIT 1"))[0];
  // Beide enden gleich: das kleinere Paket wird verlängert, ab seinem Ende
  assert.equal(third.lot, 0);
  assert.equal(third.period_start, lots[0].period_end);
  assert.equal(third.period_end, addDays(lots[0].period_end, 30));
  assert.equal(ext.purchase.expiresAt, third.period_end);
  const e = await entitlement(14, 'hc_t_time');
  assert.equal(e.quantity, 2);
  assert.equal(e.until, lots[1].period_end, 'until = the earliest end of an active pack');
  assert.deepEqual(ext.notices, [{ tone: 'hc', text: 'Time test · 30 days – until ' + dayLabel(third.period_end), amount: -60 }]);
  // 365 Tage, dann noch einmal: über 400 Tage im Voraus
  const long1 = await buy(null, 14, 'hc_t_long_365', rid(), 1, { via: 'shop' });
  assert.ok(long1.ok);
  assert.deepEqual(await buy(null, 14, 'hc_t_long_365', rid(), 1, { via: 'shop' }), { ok: false, status: 200, code: 'too_far',
    error: 'You already have Long test until ' + dayLabel(long1.purchase.expiresAt as string) + '. You can extend it again later.' });
});

test('Premium: hidden until ready; then account age, active days, a purchase writes users.premium_until, extending, admins, for good', async () => {
  await give(15, 2000);
  assert.equal((await buy(null, 15, 'premium_30', rid(), 350, { via: 'shop' })).ok, false);
  registerPerk('premium', { owner: 'premium-domains', text: 'No “Made with OnYourSite”', ready: () => true });
  await sql("UPDATE `DB`.hc_items SET is_active = 1 WHERE feature = 'premium'");
  await give(8, 1000);
  const r8 = await buy(null, 8, 'premium_30', rid(), 350, { via: 'shop' });
  assert.equal(r8.ok ? '' : r8.error, 'This is available once your account is 30 days old.');
  const r15 = await buy(null, 15, 'premium_30', rid(), 350, { via: 'shop' });
  assert.equal(r15.ok ? '' : r15.error, 'This is available once you’ve been active on 10 days.');
  for (let d = 1; d <= 10; d++) {
    await sql("INSERT INTO `DB`.honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (15, 0, 'daily', ?, '', ?)", ['2026-09-' + String(d).padStart(2, '0'), OLD]);
  }
  const bought = await buy(null, 15, 'premium_30', rid(), 350, { via: 'shop' });
  assert.ok(bought.ok);
  const until = bought.purchase.expiresAt as string;
  assert.equal((await one('SELECT premium_until FROM users WHERE id = 15'))?.premium_until, until);
  assert.equal(await isPremium(15), true);
  assert.deepEqual(await premiumState(15), { active: true, until, forever: false, source: 'purchase' });
  const longer = await buy(null, 15, 'premium_90', rid(), 700, { via: 'shop' });
  assert.ok(longer.ok);
  assert.equal(longer.purchase.expiresAt, addDays(until, 90));
  assert.equal((await one('SELECT premium_until FROM users WHERE id = 15'))?.premium_until, addDays(until, 90));
  const admin = await buy(null, 3, 'premium_30', rid(), 350, { via: 'shop' });
  assert.equal(admin.ok ? '' : admin.error, 'Premium is included with your admin account.');
  await give(16, 1000);
  for (let d = 1; d <= 10; d++) {
    await sql("INSERT INTO `DB`.honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (16, 0, 'daily', ?, '', ?)", ['2026-09-' + String(d).padStart(2, '0'), OLD]);
  }
  await withAccount(16, (db) => setPeriod(db, 16, 'premium', 0, { quantity: 1, permanent: true, expiresAt: null, source: 'admin' }));
  const forever = await buy(null, 16, 'premium_30', rid(), 350, { via: 'shop' });
  assert.equal(forever.ok ? '' : forever.error, 'You have Premium for good – no need to buy it.');
  unregisterPerksForTests('premium-domains');
  await sql("UPDATE `DB`.hc_items SET is_active = 0 WHERE feature = 'premium'");
});

test('refunds: permanent with and without removing, no second refund, the bell once, unlocking again books :2', async () => {
  await give(17, 200);
  const p1 = await buy(null, 17, 'hc_t_perm', rid(), 50, { via: 'shop' });
  assert.ok(p1.ok);
  assert.deepEqual(await refund(3, p1.purchase.id, 60, true), { error: 'Refund at most 50 honeycombs (the unused part).' });
  assert.deepEqual(await refund(3, p1.purchase.id, null, true), { ok: 'Refunded 50 honeycombs to User 17. The perm test is locked again.' });
  assert.equal(await has(17, 'hc_t_perm'), false);
  assert.deepEqual(await refund(3, p1.purchase.id, null, true), { error: 'This purchase was already refunded.' });
  assert.deepEqual(await refund(3, 999999, null, true), { error: 'Purchase not found.' });
  const ledger = plain(await sql("SELECT amount, reason, ref, note, actor_id FROM `DB`.honeycomb_ledger WHERE user_id = 17 AND reason IN ('unlock', 'refund') ORDER BY id"));
  assert.deepEqual(ledger, [
    { amount: -50, reason: 'unlock', ref: 'hc_t_perm', note: 'Perm test', actor_id: null },
    { amount: 50, reason: 'refund', ref: 'p' + p1.purchase.id, note: 'Refund: Perm test', actor_id: 3 },
  ]);
  const bell = plain(await sql('SELECT type, title, body, link FROM `DB`.notifications WHERE user_id = 17'));
  assert.deepEqual(bell, [{ type: 'honeycombs', title: 'Perm test was refunded: +50 honeycombs.', body: 'The perm test is locked again.', link: '/dashboard#honeycombs/hc_t_perm' }]);
  const audit = plain(await sql("SELECT admin_id, action, user_id, target, details FROM `DB`.hc_audit WHERE action = 'refund' AND user_id = 17"));
  assert.deepEqual(audit, [{ admin_id: 3, action: 'refund', user_id: 17, target: 'p' + p1.purchase.id, details: `{"purchase":${p1.purchase.id},"amount":50,"removed":true}` }]);
  const purchase = plain(await sql('SELECT refund_amount, refund_units, refund_cut_sec, refund_removed, refunded_by FROM `DB`.hc_purchases WHERE id = ?', [p1.purchase.id]))[0];
  assert.deepEqual(purchase, { refund_amount: 50, refund_units: 0, refund_cut_sec: 0, refund_removed: 1, refunded_by: 3 });
  // Wieder freischalten: neuer Bezug, wieder Zugang
  const p2 = await buy(null, 17, 'hc_t_perm', rid(), 50, { via: 'shop' });
  assert.ok(p2.ok);
  assert.equal(await has(17, 'hc_t_perm'), true);
  assert.deepEqual(plain(await sql("SELECT ref FROM `DB`.honeycomb_ledger WHERE user_id = 17 AND reason = 'unlock' ORDER BY id")).map((r) => r.ref), ['hc_t_perm', 'hc_t_perm:2']);
  // Ein Teil zurück, ohne wegzunehmen
  assert.deepEqual(await refund(3, p2.purchase.id, 10, false, 'Sorry'), { ok: 'Refunded 10 honeycombs to User 17. The perm test stays unlocked.' });
  assert.equal(await has(17, 'hc_t_perm'), true);
  assert.equal((await sql("SELECT note FROM `DB`.honeycomb_ledger WHERE user_id = 17 AND ref = ?", ['p' + p2.purchase.id]))[0].note, 'Sorry');
  assert.equal(plain(await sql('SELECT id FROM `DB`.notifications WHERE user_id = 17')).length, 2);
});

test('refunds of periods: the unused part, later periods move back, an ended period cuts nothing', async () => {
  await give(18, 1000);
  const p1 = await buy(null, 18, 'hc_t_time_30', rid(), 60, { via: 'shop' });
  const p2 = await buy(null, 18, 'hc_t_time_30', rid(), 60, { via: 'shop', mode: 'extend' });
  assert.ok(p1.ok && p2.ok);
  // 10 Tage vergangen: P1 läuft noch 20 Tage, P2 schließt daran an
  const now = nowStr();
  await sql('UPDATE `DB`.hc_purchases SET period_start = ?, period_end = ? WHERE id = ?', [addDays(now, -10), addDays(now, 20), p1.purchase.id]);
  await sql('UPDATE `DB`.hc_purchases SET period_start = ?, period_end = ? WHERE id = ?', [addDays(now, 20), addDays(now, 50), p2.purchase.id]);
  await sql("UPDATE `DB`.hc_entitlements SET expires_at = ? WHERE user_id = 18 AND feature = 'hc_t_time' AND lot = 0", [addDays(now, 50)]);
  const out = await refund(3, p1.purchase.id, null, true);
  assert.ok('ok' in out, JSON.stringify(out));
  const ent = plain(await sql("SELECT expires_at FROM `DB`.hc_entitlements WHERE user_id = 18 AND feature = 'hc_t_time' AND lot = 0"))[0];
  const later = plain(await sql('SELECT period_start, period_end FROM `DB`.hc_purchases WHERE id = ?', [p2.purchase.id]))[0];
  const refunded = plain(await sql('SELECT refund_amount, refund_cut_sec FROM `DB`.hc_purchases WHERE id = ?', [p1.purchase.id]))[0];
  assert.equal(refunded.refund_amount, 40);
  assert.ok(Math.abs(Number(refunded.refund_cut_sec) - 20 * 86400) <= 2);
  // Um die unbenutzten 20 Tage verkürzt; der spätere Zeitraum rückt um genauso viel nach vorn
  assert.equal(ent.expires_at, later.period_end);
  assert.equal(later.period_end, addSeconds(addDays(now, 50), -Number(refunded.refund_cut_sec)));
  assert.equal(later.period_start, addSeconds(addDays(now, 20), -Number(refunded.refund_cut_sec)));
  assert.equal((out as { ok: string }).ok, 'Refunded 40 honeycombs to User 18. Time test · 30 days now ends on ' + dayLabel(ent.expires_at) + '.');

  // Ein vorbeigegangener Zeitraum (Paket 1): nichts zu erstatten, nichts verkürzt
  const p3 = await buy(null, 18, 'hc_t_time_30', rid(), 60, { via: 'shop', mode: 'stack' });
  assert.ok(p3.ok);
  await sql('UPDATE `DB`.hc_purchases SET period_start = ?, period_end = ? WHERE id = ?', [addDays(now, -40), addDays(now, -10), p3.purchase.id]);
  await sql("UPDATE `DB`.hc_entitlements SET expires_at = ? WHERE user_id = 18 AND feature = 'hc_t_time' AND lot = 1", [addDays(now, -10)]);
  assert.deepEqual(await refund(3, p3.purchase.id, 1, true), { error: 'Refund at most 0 honeycombs (the unused part).' });
  assert.deepEqual(await refund(3, p3.purchase.id, null, true), { ok: 'Refunded 0 honeycombs to User 18.' });
  assert.equal(plain(await sql("SELECT expires_at FROM `DB`.hc_entitlements WHERE user_id = 18 AND feature = 'hc_t_time' AND lot = 1"))[0].expires_at, addDays(now, -10));
  assert.deepEqual(plain(await sql('SELECT period_start, period_end FROM `DB`.hc_purchases WHERE id = ?', [p2.purchase.id]))[0], later);
});

test('refunds of passes and counts: only unused passes, fewer left than bought, the maximum count', async () => {
  await give(19, 500);
  const pass = await buy(null, 19, 'hc_t_pass_x3', rid(), 30, { via: 'shop' });
  assert.ok(pass.ok);
  assert.equal(pass.purchase.quantity, 3);
  // Zwei von drei benutzt
  await sql("UPDATE `DB`.hc_entitlements SET quantity = 1 WHERE user_id = 19 AND feature = 'hc_t_pass'");
  assert.deepEqual(await refund(3, pass.purchase.id, 11, true), { error: 'Refund at most 10 honeycombs (the unused part).' });
  assert.deepEqual(await refund(3, pass.purchase.id, null, true), { ok: 'Refunded 10 honeycombs to User 19. 1 taken back.' });
  assert.equal(Number((await sql("SELECT quantity FROM `DB`.hc_entitlements WHERE user_id = 19 AND feature = 'hc_t_pass'"))[0].quantity), 0);
  assert.ok((await buy(null, 19, 'hc_t_cnt_x1', rid(), 40, { via: 'shop' })).ok);
  const two = await buy(null, 19, 'hc_t_cnt_x1', rid(), 40, { via: 'shop' });
  assert.ok(two.ok && two.purchase.quantity === 2);
  assert.deepEqual(await buy(null, 19, 'hc_t_cnt_x1', rid(), 40, { via: 'shop' }), { ok: false, status: 200, code: 'max', error: 'You already have the maximum (2).' });
  // Eine Anzahl erstatten (mit Wegnehmen): IF() statt quantity − n, auch wenn weniger übrig ist
  await sql("UPDATE `DB`.hc_entitlements SET quantity = 1 WHERE user_id = 19 AND feature = 'hc_t_cnt'");
  assert.ok('ok' in (await refund(3, two.purchase.id, null, true)));
  assert.equal(Number((await sql("SELECT quantity FROM `DB`.hc_entitlements WHERE user_id = 19 AND feature = 'hc_t_cnt'"))[0].quantity), 0);
});

function offerInput(o: Partial<OfferInput> = {}): OfferInput {
  const local = (dt: string) => dt.slice(0, 16).replace(' ', 'T');
  return { label: 'Black Friday', scope: 'all', percentOff: '30', fixedPrice: '', startsAt: local(nowStr()), endsAt: local(addDays(nowStr(), 5)),
    maxUses: '', perUserMax: '', minAccountDays: '30', minActiveDays: '0', formRef: randomHex(8), ...o };
}

test('creating and cancelling offers: every check, double submit, the Premium age floor, at most 20 open offers', async () => {
  await sql('DELETE FROM `DB`.hc_offers');
  const bad: Array<[Partial<OfferInput>, string]> = [
    [{ label: '' }, 'Please give the offer a name (up to 60 characters).'],
    [{ formRef: 'nope' }, 'The form is out of date. Please reload the page.'],
    [{ scope: 'feature:nope_feature' }, 'Please choose what the offer is for.'],
    [{ scope: 'item:nope_item' }, 'Please choose what the offer is for.'],
    [{ scope: 'everything' }, 'Please choose what the offer is for.'],
    [{ percentOff: '0' }, 'Enter a discount between 1 and 100 %.'],
    [{ percentOff: '101' }, 'Enter a discount between 1 and 100 %.'],
    [{ percentOff: 'abc' }, 'Enter a discount between 1 and 100 %.'],
    [{ percentOff: '', fixedPrice: '' }, 'Enter a discount between 1 and 100 % or a fixed price.'],
    [{ fixedPrice: '10' }, 'Enter either a discount or a fixed price, not both.'],
    [{ percentOff: '', fixedPrice: '10' }, 'A fixed price is only possible for a single option.'],
    [{ scope: 'item:hc_t_offer', percentOff: '', fixedPrice: '51', minAccountDays: '0' }, 'The fixed price can be 0 to 50 (the list price).'],
    [{ endsAt: offerInput().startsAt }, 'Please enter a start and an end after it.'],
    [{ startsAt: '2026-02-31T10:00' }, 'Please enter a start and an end after it.'],
    [{ startsAt: '2020-01-01T00:00', endsAt: '2020-01-02T00:00' }, 'The end must be in the future.'],
    [{ endsAt: addDays(nowStr(), 95).slice(0, 16).replace(' ', 'T') }, 'An offer can run for up to 90 days.'],
    [{ maxUses: '0' }, 'Maximum uses: leave it empty or enter 1 to 1,000,000.'],
    [{ perUserMax: '101' }, 'Uses per account: leave it empty or enter 1 to 100.'],
    [{ minAccountDays: 'x' }, 'Minimum days: enter 0 to 3,650.'],
    [{ minAccountDays: '0' }, 'Offers that include Premium need accounts that are at least 30 days old.'],
    [{ scope: 'item:premium_30', minAccountDays: '10' }, 'Offers that include Premium need accounts that are at least 30 days old.'],
  ];
  for (const [patch, error] of bad) assert.deepEqual(await createOffer(3, offerInput(patch)), { error }, JSON.stringify(patch));
  assert.equal(plain(await sql('SELECT id FROM `DB`.hc_offers')).length, 0);

  const ref = randomHex(8);
  assert.deepEqual(await createOffer(3, offerInput({ formRef: ref })), { ok: 'Offer “Black Friday” created.' });
  assert.deepEqual(await createOffer(3, offerInput({ formRef: ref })), { error: 'This offer was already created – the form was sent twice.' });
  assert.deepEqual(await createOffer(3, offerInput({ scope: 'feature:hc_t_perm', minAccountDays: '0', label: 'Perm sale' })), { ok: 'Offer “Perm sale” created.' });
  assert.deepEqual(await createOffer(3, offerInput({ scope: 'item:hc_t_offer', percentOff: '', fixedPrice: '20', minAccountDays: '0', label: 'Fixed' })), { ok: 'Offer “Fixed” created.' });
  const rows = plain(await sql('SELECT label, scope, percent_off, fixed_price, min_account_days, created_by FROM `DB`.hc_offers ORDER BY id'));
  assert.deepEqual(rows, [
    { label: 'Black Friday', scope: 'all', percent_off: 30, fixed_price: null, min_account_days: 30, created_by: 3 },
    { label: 'Perm sale', scope: 'feature:hc_t_perm', percent_off: 30, fixed_price: null, min_account_days: 0, created_by: 3 },
    { label: 'Fixed', scope: 'item:hc_t_offer', percent_off: null, fixed_price: 20, min_account_days: 0, created_by: 3 },
  ]);
  for (let i = 0; i < 17; i++) assert.ok('ok' in (await createOffer(3, offerInput({ label: 'Sale ' + i }))));
  assert.deepEqual(await createOffer(3, offerInput({ label: 'One too many' })), { error: 'There are already 20 active or upcoming offers.' });
  const first = Number((await sql('SELECT MIN(id) AS id FROM `DB`.hc_offers'))[0].id);
  assert.deepEqual(await cancelOffer(3, first), { ok: 'Offer cancelled. Purchases made with it keep their price.' });
  assert.notEqual((await sql('SELECT cancelled_at FROM `DB`.hc_offers WHERE id = ?', [first]))[0].cancelled_at, null);
  assert.deepEqual(await cancelOffer(3, 999999), { error: 'Offer not found.' });
  assert.ok('ok' in (await createOffer(3, offerInput({ label: 'Room again' }))));
  assert.equal(plain(await sql("SELECT id FROM `DB`.hc_audit WHERE action = 'offer_create'")).length, 21);
  assert.equal(plain(await sql("SELECT id FROM `DB`.hc_audit WHERE action = 'offer_cancel'")).length, 1);
  await sql('DELETE FROM `DB`.hc_offers');
});

test('purchaseUnlock answers with text (owned is done), and deleting an account removes its purchases', async () => {
  await give(20, 100);
  assert.equal(await purchaseUnlock(null, 20, 'hc_t_p5', { requestId: rid(), expectedPrice: 49, via: 'shop' }), 'The price changed – this now costs 50 honeycombs.');
  assert.equal(await purchaseUnlock(adminCtx, 20, 'hc_t_p5', { requestId: rid(), expectedPrice: 50, via: 'shop' }), 'Buying is turned off in admin mode.');
  assert.equal(await purchaseUnlock(null, 20, 'hc_t_p5', { requestId: rid(), expectedPrice: 50, via: 'shop' }), null);
  assert.equal(await purchaseUnlock(null, 20, 'hc_t_p5', { requestId: rid(), expectedPrice: 50, via: 'shop' }), null, 'owned: done, no charge');
  assert.equal(await balance(20), 50);
  assert.ok(plain(await sql('SELECT id FROM `DB`.hc_purchases WHERE user_id = 20')).length > 0);
  await deleteAccount(null, 20);
  assert.equal(plain(await sql('SELECT id FROM `DB`.hc_purchases WHERE user_id = 20')).length, 0);
});
