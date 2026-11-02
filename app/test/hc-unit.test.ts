// Shop-Kern ohne Datenbank: Texte im Verlauf (alle Gründe, auch unlock/<Funktion>:<n>), die Regeln für Anmeldungen
// von Funktionen, Erinnerungsstufen, Premium auf einer users-Zeile und Kalendertage über die Zeitumstellung.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hcDescribe } from '../src/honeycombs/honeycombs.js';
import {
  feature, itemKeyFor, premiumPerks, registerFeature, registerLossPreview, registerPerk, unregisterFeatureForTests, unregisterPerksForTests,
  type Feature,
} from '../src/honeycombs/features.js';
import { isActive, stage, PREMIUM_FOREVER } from '../src/honeycombs/entitlements.js';
import { isPremiumRow, premiumReady } from '../src/honeycombs/premium.js';
import { addDays, addSeconds, dayLabel, toUnix } from '../src/honeycombs/clock.js';

test('history texts: every shop reason, unlock refs with :<n>, and the old texts unchanged', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ reason: 'unlock', ref: 'code_page', note: '', amount: -100 }, 'Unlocked your code page'],
    [{ reason: 'unlock', ref: 'code_page:2', note: 'Code page', amount: -100 }, 'Unlocked your code page'],
    [{ reason: 'unlock', ref: 'code_page:17', note: '', amount: 0 }, 'Unlocked your code page'],
    [{ reason: 'unlock', ref: 'code_more', note: '', amount: 0 }, 'Unlocked more code pages'],
    [{ reason: 'unlock', ref: 'code_more:3', note: '', amount: 0 }, 'Unlocked more code pages'],
    [{ reason: 'unlock', ref: 'premium', note: '', amount: 0 }, 'Unlocked Premium'],
    [{ reason: 'unlock', ref: 'not_registered', note: 'x', amount: 0 }, 'Unlocked an extra'],
    // Groß/klein, Leerzeichen und :0 wie bisher: keine bekannte Freischaltung
    [{ reason: 'unlock', ref: 'CODE_PAGE', note: '', amount: 0 }, 'Unlocked an extra'],
    [{ reason: 'unlock', ref: 'code_page ', note: '', amount: 0 }, 'Unlocked an extra'],
    [{ reason: 'unlock', ref: 'code_page\n', note: '', amount: 0 }, 'Unlocked an extra'],
    [{ reason: 'unlock', ref: 'code_page:0', note: '', amount: 0 }, 'Unlocked an extra'],
    [{ reason: 'unlock', ref: 'code_page:x', note: '', amount: 0 }, 'Unlocked an extra'],
    [{ reason: 'purchase', ref: 'a'.repeat(32), note: 'Premium · 30 days', amount: -350 }, 'Bought Premium · 30 days'],
    [{ reason: 'purchase', ref: 'auto-12-3', note: 'Premium · 30 days', amount: -350 }, 'Renewed Premium · 30 days'],
    [{ reason: 'purchase', ref: 'b'.repeat(32), note: '', amount: 0 }, 'Bought an extra'],
    [{ reason: 'grant', ref: 'g3-0123456789abcdef', note: 'Premium · 30 days from the team', amount: 0 }, 'Premium · 30 days from the team'],
    [{ reason: 'grant', ref: 'g3-0123456789abcdef', note: '', amount: 0 }, 'From the team'],
    [{ reason: 'revoke', ref: 'v3-0123456789abcdef', note: '', amount: 0 }, 'Removed by the team'],
    [{ reason: 'refund', ref: 'p12', note: 'Refund: Premium · 30 days', amount: 120 }, 'Refund: Premium · 30 days'],
    [{ reason: 'refund', ref: 'p12', note: '', amount: 0 }, 'Refund'],
    [{ reason: 'reversal', ref: 'x40', note: '', amount: -50 }, 'Correction by the team'],
    [{ reason: 'streak', ref: 'w2026-11-02', note: '', amount: 15 }, '7-day streak'],
    [{ reason: 'streak', ref: 'm2026-11-02', note: '', amount: 50 }, '30-day streak'],
    [{ reason: 'code', ref: 'c4', note: 'Halloween 2026', amount: 50 }, 'Halloween 2026'],
    [{ reason: 'code', ref: 'c4', note: '', amount: 50 }, 'Code redeemed'],
    // Unverändert
    [{ reason: 'daily', ref: '2026-11-02', note: '', amount: 5 }, 'Active on OnYourSite'],
    [{ reason: 'profile', ref: 'complete', note: '', amount: 20 }, 'Profile completed'],
    [{ reason: 'views', ref: '2026-11-02', note: '1200', amount: 10 }, '1,200 page views reached'],
    [{ reason: 'admin', ref: 'a3-1', note: '', amount: -3 }, 'Correction by the team'],
    [{ reason: 'admin', ref: 'a3-1', note: '', amount: 3 }, 'Gift from the team'],
    [{ reason: 'bonus', ref: 'b1', note: '', amount: 4 }, 'Bonus'],
  ];
  for (const [row, text] of cases) assert.equal(hcDescribe(row), text, JSON.stringify(row));
});

test('registerFeature rejects broken registrations and names options by kind', () => {
  const base: Feature = { key: 'hc_unit_perm', owner: 'test', title: 'Test', icon: 'bx-star', description: 'd', kind: 'permanent',
    items: { hc_unit_perm: { price: 10, active: true } } };
  const bad: Array<[Partial<Feature>, RegExp]> = [
    [{ key: 'Bad' }, /invalid key/],
    [{ key: 'x' }, /invalid key/],
    [{ items: {} }, /at least one option/],
    [{ items: { other: { price: 1, active: true } } }, /exactly one option/],
    [{ items: { hc_unit_perm: { price: -1, active: true } } }, /invalid price/],
    [{ items: { hc_unit_perm: { price: 1.5, active: true } } }, /invalid price/],
    [{ items: { hc_unit_perm: { price: 1000001, active: true } } }, /invalid price/],
    [{ stack: 2 }, /stack is for timed/],
    [{ freeAtZero: true, kind: 'count', items: { hc_unit_perm_x1: { price: 1, active: true } } }, /freeAtZero/],
    [{ kind: 'timed', items: { hc_unit_perm_30: { price: 1, active: true } } }, /1–365 days/],
    [{ kind: 'timed', items: { hc_unit_perm_400: { price: 1, active: true, days: 400 } } }, /1–365 days/],
    [{ kind: 'timed', items: { hc_unit_perm_7: { price: 1, active: true, days: 30 } } }, /must be called hc_unit_perm_30/],
    [{ kind: 'count', items: { hc_unit_perm_x2: { price: 1, active: true, units: 3 } } }, /must be called hc_unit_perm_x3/],
    [{ requires: 'hc_unit_perm' }, /invalid requires/],
  ];
  for (const [patch, err] of bad) assert.throws(() => registerFeature({ ...base, ...patch } as Feature), err, JSON.stringify(patch));
  assert.equal(feature('hc_unit_perm'), null);
  registerFeature(base);
  try {
    assert.equal(feature('hc_unit_perm')?.title, 'Test');
    assert.throws(() => registerFeature(base), /registered twice/);
  } finally {
    unregisterFeatureForTests('hc_unit_perm');
  }
  assert.equal(itemKeyFor({ key: 'premium', kind: 'timed' }, { days: 30 }), 'premium_30');
  assert.equal(itemKeyFor({ key: 'custom_domain', kind: 'count' }, { units: 1 }), 'custom_domain_x1');
  assert.equal(itemKeyFor({ key: 'address_pass', kind: 'consumable' }, {}), 'address_pass_x1');
  assert.equal(itemKeyFor({ key: 'code_page', kind: 'permanent' }, {}), 'code_page');
  assert.throws(() => registerLossPreview('Bad Key', async () => []), /invalid feature/);
});

test('premium: registered by the shop with the Q4 prices, hidden until premium-domains marks it ready', () => {
  const f = feature('premium');
  assert.ok(f);
  assert.equal(f.kind, 'timed');
  assert.equal(f.minAccountDaysFloor, 30);
  assert.equal(f.maxAheadDays, 400);
  assert.deepEqual(f.items, {
    premium_30: { days: 30, price: 350, active: false, minAccountDays: 30, minActiveDays: 10 },
    premium_90: { days: 90, price: 700, active: false, minAccountDays: 30, minActiveDays: 10 },
  });
  assert.equal(premiumReady(), false);
  // Andere Vorteile machen Premium nicht bereit, nur der von premium-domains
  registerPerk('premium', { owner: 'status-pages', text: 'Status page: 30 checks', ready: () => true });
  assert.equal(premiumReady(), false);
  let ready = false;
  registerPerk('premium', { owner: 'premium-domains', text: 'No “Made with OnYourSite”', ready: () => ready });
  assert.equal(premiumReady(), false);
  ready = true;
  assert.equal(premiumReady(), true);
  assert.deepEqual(premiumPerks().map((p) => p.owner), ['status-pages', 'premium-domains']);
  unregisterPerksForTests('status-pages');
  unregisterPerksForTests('premium-domains');
  assert.equal(premiumReady(), false);
  assert.throws(() => registerPerk('code_page' as 'premium', { owner: 'x', text: 'y', ready: () => true }), /only premium/);
});

test('isPremiumRow: admins always, otherwise premium_until in the future (for good is a far date, never NULL)', () => {
  const now = '2026-11-02 12:00:00';
  assert.equal(isPremiumRow({ is_admin: 1, premium_until: null }, now), true);
  assert.equal(isPremiumRow({ is_admin: 0, premium_until: null }, now), false);
  assert.equal(isPremiumRow({ is_admin: 0, premium_until: '2026-11-02 12:00:01' }, now), true);
  assert.equal(isPremiumRow({ is_admin: 0, premium_until: '2026-11-02 12:00:00' }, now), false);
  assert.equal(isPremiumRow({ is_admin: '0', premium_until: PREMIUM_FOREVER }, now), true);
  assert.equal(isPremiumRow({ is_admin: null, premium_until: '2025-01-01 00:00:00' }, now), false);
});

test('active lots and reminder stages', () => {
  const now = '2026-11-02 12:00:00';
  assert.equal(isActive({ quantity: 1, permanent: 1, expires_at: null }, now), true);
  assert.equal(isActive({ quantity: 0, permanent: 1, expires_at: null }, now), false);
  assert.equal(isActive({ quantity: 1, permanent: 0, expires_at: null }, now), false);
  assert.equal(isActive({ quantity: 1, permanent: 0, expires_at: '2026-11-02 12:00:01' }, now), true);
  assert.equal(isActive({ quantity: 1, permanent: 0, expires_at: now }, now), false);
  assert.equal(stage('2026-11-12 12:00:00', now), 0);
  assert.equal(stage('2026-11-09 12:00:00', now), 1);
  assert.equal(stage('2026-11-05 12:00:01', now), 1);
  assert.equal(stage('2026-11-05 12:00:00', now), 2);
  assert.equal(stage('2026-11-03 12:00:01', now), 2);
  assert.equal(stage('2026-11-03 12:00:00', now), 3);
  assert.equal(stage('2026-11-02 12:00:01', now), 3);
});

test('calendar days keep the wall-clock time across the DST weeks (Mar 29 / Oct 25, 2026)', () => {
  assert.equal(addDays('2026-03-28 10:00:00', 1), '2026-03-29 10:00:00');
  assert.equal(toUnix('2026-03-29 10:00:00') - toUnix('2026-03-28 10:00:00'), 23 * 3600);
  assert.equal(addDays('2026-10-24 10:00:00', 1), '2026-10-25 10:00:00');
  assert.equal(toUnix('2026-10-25 10:00:00') - toUnix('2026-10-24 10:00:00'), 25 * 3600);
  assert.equal(addDays('2026-03-20 23:30:00', 30), '2026-04-19 23:30:00');
  assert.equal(addDays('2026-12-15 08:00:00', 30), '2027-01-14 08:00:00');
  assert.equal(addDays('2026-11-02 12:00:00', -3), '2026-10-30 12:00:00');
  assert.equal(addSeconds('2026-11-02 12:00:00', 90), '2026-11-02 12:01:30');
  assert.equal(dayLabel('2026-12-01 00:00:00'), 'Dec 1, 2026');
  assert.throws(() => addDays('2026-11-02 12:00:00', 1.5), /invalid number/);
  assert.throws(() => toUnix('nope'), /invalid date/);
});
