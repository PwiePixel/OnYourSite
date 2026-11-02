// Statusseiten, Rechnen mit Zeitspannen (aggregate.ts): Stunden an UTC-Grenzen, Tage um Mitternacht Ortszeit (die
// Tage der Zeitumstellung 2026-03-29 mit 23 und 2026-10-25 mit 25 Stunden), nachträgliche Ausfallzeit, Lücken,
// Verfügbarkeit abgerundet, Farben der Balken, Status eines Bestandteils und der Seite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Aggregator, barColor, componentStatus, creditWindow, dayKey, nextMidnight, pageIndicator, splitDays, splitHours, uptimePercent,
  type ComponentInput,
} from '../src/status/aggregate.js';

const TZ = 'Europe/Berlin';
const utc = (y: number, mo: number, d: number, h = 0, mi = 0): number => Date.UTC(y, mo - 1, d, h, mi) / 1000;

test('hours split at UTC borders', () => {
  assert.deepEqual(splitHours(utc(2026, 11, 2, 10, 50), utc(2026, 11, 2, 12, 10)), [
    [utc(2026, 11, 2, 10), 600], [utc(2026, 11, 2, 11), 3600], [utc(2026, 11, 2, 12), 600],
  ]);
  assert.deepEqual(splitHours(100, 100), []);
});

test('days split at local midnight, also on the DST days (23 and 25 hours)', () => {
  // 29. März 2026: Mitternacht Berlin = 28.3. 23:00 UTC, der Tag hat 23 Stunden
  const spring = utc(2026, 3, 28, 23);
  assert.equal(dayKey(spring, TZ), '2026-03-29');
  assert.equal(nextMidnight(spring, TZ) - spring, 23 * 3600);
  // 25. Oktober 2026: 25 Stunden
  const autumn = utc(2026, 10, 24, 22);
  assert.equal(dayKey(autumn, TZ), '2026-10-25');
  assert.equal(nextMidnight(autumn, TZ) - autumn, 25 * 3600);
  const parts = splitDays(utc(2026, 10, 24, 21), utc(2026, 10, 26, 0), TZ);
  assert.deepEqual(parts, [['2026-10-24', 3600], ['2026-10-25', 25 * 3600], ['2026-10-26', 3600]]);
  assert.equal(parts.reduce((a, p) => a + p[1], 0), utc(2026, 10, 26, 0) - utc(2026, 10, 24, 21));
});

test('the credit window: the time since the previous result, at most 2 × interval + timeout', () => {
  assert.deepEqual(creditWindow(1000, 1060, 60, 10), [1000, 1060]);
  assert.deepEqual(creditWindow(1000, 5000, 60, 10), [1000, 1130], 'a gap beyond the window is not covered');
  assert.equal(creditWindow(null, 1000, 60, 10), null);
  assert.equal(creditWindow(1000, 1000, 60, 10), null);
});

test('the aggregator: results, spans, the down back-date and merging back after a failed write', () => {
  const a = new Aggregator(TZ);
  const h10 = utc(2026, 11, 2, 10);
  a.addResult(7, h10 + 5, true, 120);
  a.addResult(7, h10 + 65, true, 80);
  a.addResult(7, h10 + 125, false, null);
  a.addSpan(7, h10 + 5, h10 + 65, 'up');
  a.addSpan(7, h10 + 3590, h10 + 3610, 'down'); // über die Stundengrenze
  a.addSpan(7, h10 + 100, h10 + 110, 'maint');
  a.addDownBackdate(7, h10 + 3500, h10 + 3590);
  const data = a.take();
  assert.equal(a.size, 0);
  const hour10 = data.hourly.find(([id, h]) => id === 7 && h === h10)?.[2];
  assert.deepEqual(hour10, { checks: 3, fails: 1, ms_sum: 200, ms_count: 2, ms_min: 80, ms_max: 120, covered_s: 60 + 10 + 10, down_s: 10 + 90, degraded_s: 0, maint_s: 10 });
  const hour11 = data.hourly.find(([id, h]) => id === 7 && h === h10 + 3600)?.[2];
  assert.equal(hour11?.down_s, 10);
  assert.equal(hour11?.covered_s, 10);
  const day = data.daily.find(([id, d]) => id === 7 && d === '2026-11-02')?.[2];
  assert.equal(day?.checks, 3);
  assert.equal(day?.down_s, 110);
  // Zurücklegen nach einem fehlgeschlagenen Schreiben: nichts geht verloren, nichts doppelt
  a.addResult(7, h10 + 200, true, 50);
  a.merge(data);
  const again = a.take().hourly.find(([id, h]) => id === 7 && h === h10)?.[2];
  assert.equal(again?.checks, 4);
  assert.equal(again?.ms_min, 50);
});

test('uptime: floored to two decimals, maintenance excluded, no data → null', () => {
  assert.equal(uptimePercent(0, 86400, 0), 100);
  assert.equal(uptimePercent(1, 100000, 0), 99.99, '99.999 shows 99.99');
  assert.equal(uptimePercent(864, 86400, 0), 99);
  assert.equal(uptimePercent(0, 3600, 3600), null);
  assert.equal(uptimePercent(0, 0, 0), null);
  assert.equal(uptimePercent(3600, 7200, 3600), 0);
  assert.equal(uptimePercent(60, 7200, 3600), 98.33);
});

test('bar colours', () => {
  const day = (o: Partial<{ covered_s: number; down_s: number; degraded_s: number; maint_s: number }>) => ({ covered_s: 86400, down_s: 0, degraded_s: 0, maint_s: 0, ...o });
  assert.equal(barColor(day({})), 'd-ok');
  assert.equal(barColor(null), 'd-none');
  assert.equal(barColor(day({ covered_s: 0 })), 'd-none');
  assert.equal(barColor(day({ down_s: 60 })), 'd-partial');
  assert.equal(barColor(day({ down_s: 1800 })), 'd-major');
  assert.equal(barColor(day({ degraded_s: 1800 })), 'd-minor');
  assert.equal(barColor(day({ degraded_s: 1799 })), 'd-ok');
  assert.equal(barColor(day({ maint_s: 3600 })), 'd-maint');
  assert.equal(barColor(day({}), 'major'), 'd-major');
  assert.equal(barColor(day({}), 'partial'), 'd-minor');
  assert.equal(barColor(day({}), 'degraded'), 'd-minor');
  assert.equal(barColor(null, 'maintenance'), 'd-maint');
  assert.equal(barColor(day({ down_s: 10 }), 'degraded'), 'd-partial', 'downtime beats a light incident');
});

test('component status and the page indicator for every combination', () => {
  const c = (o: Partial<ComponentInput>): ComponentInput => ({ type: 'http', notChecked: false, state: 'up', flapping: false, maintenance: false, incidentEffects: [], ...o });
  assert.equal(componentStatus(c({})), 'operational');
  assert.equal(componentStatus(c({ state: 'degraded' })), 'degraded');
  assert.equal(componentStatus(c({ state: 'down' })), 'major');
  assert.equal(componentStatus(c({ state: 'unknown' })), 'unknown');
  assert.equal(componentStatus(c({ flapping: true })), 'degraded');
  assert.equal(componentStatus(c({ state: 'down', flapping: true })), 'degraded');
  assert.equal(componentStatus(c({ notChecked: true, state: 'down' })), 'unknown');
  assert.equal(componentStatus(c({ state: 'down', maintenance: true })), 'maintenance', 'maintenance replaces an automatic major');
  assert.equal(componentStatus(c({ incidentEffects: ['partial'] })), 'partial');
  assert.equal(componentStatus(c({ state: 'down', incidentEffects: ['degraded'] })), 'major', 'the worse one wins');
  assert.equal(componentStatus(c({ type: 'manual', manualStatus: 'partial' })), 'partial');
  assert.equal(componentStatus(c({ type: 'manual', manualStatus: 'nonsense' })), 'unknown');
  assert.equal(componentStatus(c({ type: 'manual', manualStatus: 'operational', incidentEffects: ['maintenance'] })), 'maintenance');

  assert.equal(pageIndicator([]), 'unknown');
  assert.equal(pageIndicator(['unknown', 'unknown']), 'unknown');
  assert.equal(pageIndicator(['major']), 'major');
  assert.equal(pageIndicator(['major', 'major', 'unknown']), 'major', 'every checked component is major');
  assert.equal(pageIndicator(['major', 'operational']), 'partial');
  assert.equal(pageIndicator(['partial', 'operational']), 'partial');
  assert.equal(pageIndicator(['degraded', 'operational', 'maintenance']), 'degraded');
  assert.equal(pageIndicator(['maintenance', 'operational']), 'maintenance');
  assert.equal(pageIndicator(['operational', 'unknown']), 'operational');
});
