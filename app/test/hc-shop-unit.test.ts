// Shop ohne Datenbank: Preise mit Angeboten (Aufrunden, fester Preis, Vorrang bei Gleichstand), Wahl des Pakets,
// neue Zeiträume, der erstattbare Wert (Zeiträume, Pässe, Anzahl), Bezeichnungen der Optionen und Formulardaten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestOffer, formDateTime, offerPrice, scopeRank } from '../src/honeycombs/offers.js';
import { nextPeriod, pickLot, refundableValue, type LotState } from '../src/honeycombs/shop.js';
import { optionLabel, optionTitle } from '../src/honeycombs/catalogue.js';

const offer = (id: number, scope: string, percent: number | null, fixed: number | null = null) =>
  ({ id, scope, percent_off: percent, fixed_price: fixed });

test('offer prices: percent off rounds up, a fixed price is taken as it is', () => {
  assert.equal(offerPrice(350, { percent_off: 30, fixed_price: null }), 245);
  assert.equal(offerPrice(100, { percent_off: 33, fixed_price: null }), 67);
  assert.equal(offerPrice(1, { percent_off: 50, fixed_price: null }), 1);
  assert.equal(offerPrice(3, { percent_off: 99, fixed_price: null }), 1);
  assert.equal(offerPrice(350, { percent_off: 100, fixed_price: null }), 0);
  assert.equal(offerPrice(350, { percent_off: null, fixed_price: 100 }), 100);
  assert.equal(offerPrice(350, { percent_off: null, fixed_price: 0 }), 0);
});

test('the lowest price wins; on a tie the more specific scope, then the lower id; nothing cheaper → no offer', () => {
  assert.deepEqual(bestOffer(100, []), { price: 100, offer: null });
  assert.deepEqual(bestOffer(100, [offer(1, 'all', 0 as unknown as number)]), { price: 100, offer: null });
  const a = offer(1, 'all', 30);
  const f = offer(2, 'feature:premium', 30);
  const i = offer(3, 'item:premium_30', null, 70);
  assert.equal(bestOffer(100, [a, f, i]).offer, i, 'item beats feature beats all at the same price');
  assert.equal(bestOffer(100, [a, f]).offer, f);
  assert.equal(bestOffer(100, [offer(9, 'all', 30), a]).offer, a, 'then the lower id');
  assert.deepEqual(bestOffer(100, [a, offer(4, 'item:premium_30', null, 50)]), { price: 50, offer: offer(4, 'item:premium_30', null, 50) });
  assert.deepEqual(bestOffer(100, [offer(5, 'item:x', null, 100)]), { price: 100, offer: null }, 'a fixed price equal to the list price is no offer');
  assert.deepEqual([scopeRank('all'), scopeRank('feature:x'), scopeRank('item:x_30')], [0, 1, 2]);
});

const lot = (n: number, active: boolean, expiresAt: string | null, permanent = false): LotState => ({ lot: n, active, permanent, expiresAt });

test('lots: one pack always lot 0; with two the lowest free one, extend takes the pack that ends first', () => {
  assert.deepEqual(pickLot(1, [], undefined), { lot: 0 });
  assert.deepEqual(pickLot(1, [lot(0, true, '2026-12-01 00:00:00')], 'stack'), { lot: 0 });
  assert.deepEqual(pickLot(2, [], undefined), { lot: 0 });
  assert.deepEqual(pickLot(2, [lot(0, true, '2026-12-01 00:00:00')], undefined), { lot: 1 });
  assert.deepEqual(pickLot(2, [lot(0, true, '2026-12-01 00:00:00')], 'stack'), { lot: 1 });
  assert.deepEqual(pickLot(2, [lot(0, true, '2026-12-01 00:00:00')], 'extend'), { lot: 0 });
  assert.deepEqual(pickLot(2, [lot(0, false, '2026-10-01 00:00:00'), lot(1, true, '2026-12-01 00:00:00')], undefined), { lot: 0 });
  const full = [lot(0, true, '2026-12-05 00:00:00'), lot(1, true, '2026-12-01 00:00:00')];
  assert.deepEqual(pickLot(2, full, 'stack'), { full: true });
  assert.deepEqual(pickLot(2, full, undefined), { lot: 1 }, 'no free lot: extend the one that ends first');
  assert.deepEqual(pickLot(2, full, 'extend'), { lot: 1 });
  assert.deepEqual(pickLot(2, [lot(0, true, '2026-12-01 00:00:00'), lot(1, true, '2026-12-01 00:00:00')], 'extend'), { lot: 0 }, 'tie: lower lot');
});

test('a new period starts at the end of the running one, otherwise now', () => {
  const now = '2026-11-02 12:00:00';
  assert.deepEqual(nextPeriod(null, 30, now), { start: now, end: '2026-12-02 12:00:00' });
  assert.deepEqual(nextPeriod(lot(0, true, '2026-11-20 08:00:00'), 30, now), { start: '2026-11-20 08:00:00', end: '2026-12-20 08:00:00' });
  assert.deepEqual(nextPeriod(lot(0, false, '2026-10-20 08:00:00'), 30, now), { start: now, end: '2026-12-02 12:00:00' });
  // Über die Zeitumstellung: Kalendertage, gleiche Uhrzeit
  assert.deepEqual(nextPeriod(null, 30, '2026-03-20 10:00:00'), { start: '2026-03-20 10:00:00', end: '2026-04-19 10:00:00' });
});

test('refundable value: the unused part of a period, only unused passes, the full price otherwise', () => {
  const now = '2026-11-11 00:00:00';
  const timed = (start: string, end: string) => ({ kind: 'timed' as const, price: 60, units: 1, periodStart: start, periodEnd: end });
  assert.deepEqual(refundableValue(timed('2026-11-01 00:00:00', '2026-12-01 00:00:00'), 1, now), { value: 40, unusedSec: 20 * 86400, units: 0 });
  assert.deepEqual(refundableValue(timed('2026-10-01 00:00:00', '2026-10-31 00:00:00'), 1, now), { value: 0, unusedSec: 0, units: 0 }, 'over → 0');
  assert.deepEqual(refundableValue(timed('2026-12-01 00:00:00', '2026-12-31 00:00:00'), 1, now), { value: 60, unusedSec: 30 * 86400, units: 0 }, 'not started → all');
  // Aufrunden: 1 Sekunde übrig ist 1 Honigwabe
  assert.equal(refundableValue(timed('2026-10-12 00:00:01', '2026-11-11 00:00:01'), 1, now).value, 1);
  assert.deepEqual(refundableValue({ kind: 'timed', price: 60, units: 1, periodStart: null, periodEnd: null }, 1, now), { value: 0, unusedSec: 0, units: 0 });
  const pass = { kind: 'consumable' as const, price: 30, units: 3, periodStart: null, periodEnd: null };
  assert.deepEqual(refundableValue(pass, 3, now), { value: 30, unusedSec: 0, units: 3 });
  assert.deepEqual(refundableValue(pass, 1, now), { value: 10, unusedSec: 0, units: 1 }, 'two of three used: a third');
  assert.deepEqual(refundableValue({ ...pass, price: 31 }, 2, now), { value: 20, unusedSec: 0, units: 2 }, 'rounded down');
  assert.deepEqual(refundableValue(pass, 7, now), { value: 30, unusedSec: 0, units: 3 }, 'never more than were bought');
  assert.deepEqual(refundableValue(pass, 0, now), { value: 0, unusedSec: 0, units: 0 });
  assert.deepEqual(refundableValue({ kind: 'count', price: 150, units: 1, periodStart: null, periodEnd: null }, 0, now), { value: 150, unusedSec: 0, units: 0 });
  assert.deepEqual(refundableValue({ kind: 'permanent', price: 100, units: 1, periodStart: null, periodEnd: null }, 1, now), { value: 100, unusedSec: 0, units: 0 });
});

test('option labels and titles', () => {
  assert.equal(optionLabel({ kind: 'timed' }, { days: 30, units: 1 }), '30 days');
  assert.equal(optionLabel({ kind: 'timed' }, { days: 1, units: 1 }), '1 day');
  assert.equal(optionLabel({ kind: 'count' }, { days: null, units: 3 }), '+3');
  assert.equal(optionLabel({ kind: 'consumable' }, { days: null, units: 1 }), '1 pass');
  assert.equal(optionLabel({ kind: 'consumable' }, { days: null, units: 2 }), '2 passes');
  assert.equal(optionLabel({ kind: 'permanent' }, { days: null, units: 1 }), 'Unlock');
  assert.equal(optionTitle({ kind: 'timed', title: 'Premium' }, { days: 30, units: 1 }), 'Premium · 30 days');
  assert.equal(optionTitle({ kind: 'permanent', title: 'Code page' }, { days: null, units: 1 }), 'Code page');
});

test('dates from admin forms', () => {
  assert.equal(formDateTime('2026-11-27T00:00'), '2026-11-27 00:00:00');
  assert.equal(formDateTime('2026-12-01 23:59:30'), '2026-12-01 23:59:30');
  for (const bad of ['', '2026-02-31T10:00', '2026-11-27', '27.11.2026 10:00', '2026-11-27T25:00', null, 5, ['2026-11-27T00:00']]) {
    assert.equal(formDateTime(bad), null, JSON.stringify(bad));
  }
});
