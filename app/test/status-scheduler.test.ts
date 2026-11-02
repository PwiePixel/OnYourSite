// Statusseiten, Zeitplan (scheduler.ts) mit einer erfundenen Uhr: gleichmäßige erste Läufe, Takt ohne Drift,
// Wiederholungen (auch mit Retry-After eines 503), Eimer je Host/Domain/IP, Obergrenzen insgesamt, mit Stichwort und je
// Nutzer, 429 pausiert den Host, Verzögerung p95.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DueHeap, Scheduler, TokenBucket, crc32, firstDue, nextDue, retryDelay, type Job, type SchedulerOptions } from '../src/status/scheduler.js';

const OPTS: SchedulerOptions = { concurrency: 1000, keywordConcurrency: 64, userInflight: 32, hostPerMin: 30, domainPerMin: 60, ipPerMin: 3000 };
const job = (id: number, due: number, o: Partial<Job> = {}): Job => ({ id, due, userId: null, host: `h${id}.zz`, domain: `h${id}.zz`, keyword: false, ...o });

test('the heap returns jobs by due time and supports removal and updates', () => {
  const h = new DueHeap();
  for (const [id, due] of [[1, 50], [2, 10], [3, 30], [4, 20], [5, 40]]) h.push(job(id, due));
  h.remove(3);
  h.push(job(5, 5));
  const order: number[] = [];
  for (let j = h.pop(); j; j = h.pop()) order.push(j.id);
  assert.deepEqual(order, [5, 2, 4, 1]);
  assert.equal(h.size, 0);
});

test('first runs spread evenly over the interval (crc32), at most 2 % of checks in the same second', () => {
  const now = 1_800_000_000_000;
  const spread = (intervalMs: number): Map<number, number> => {
    const counts = new Map<number, number>();
    for (let id = 1; id <= 5000; id++) {
      const due = firstDue(id, intervalMs, null, now);
      assert.ok(due >= now && due < now + intervalMs);
      const sec = Math.floor((due - now) / 1000);
      counts.set(sec, (counts.get(sec) ?? 0) + 1);
    }
    return counts;
  };
  for (const interval of [120_000, 180_000, 300_000]) {
    const counts = spread(interval);
    assert.ok(Math.max(...counts.values()) <= 5000 * 0.02, `interval ${interval}: max per second ${Math.max(...counts.values())}`);
  }
  // Bei einer Minute ist schon der Durchschnitt 1,7 % je Sekunde – die Spitze bleibt nah daran
  const minute = spread(60_000);
  assert.equal(minute.size, 60);
  assert.ok(Math.max(...minute.values()) <= 5000 * 0.025, `max per second ${Math.max(...minute.values())}`);
  // nach einem Neustart: vom letzten Lauf aus, überfällig → verteilt
  assert.equal(firstDue(7, 60_000, now - 10_000, now), now + 50_000);
  assert.ok(firstDue(7, 60_000, now - 600_000, now) < now + 60_000);
  assert.equal(crc32(123), crc32('123'));
});

test('rescheduling without drift; more than one interval behind starts from now; retries and Retry-After of a 503', () => {
  assert.equal(nextDue(1000, 60_000, 1500), 61_000);
  assert.equal(nextDue(1000, 60_000, 65_000), 61_000, 'a little late: the next one stays on the grid');
  assert.equal(nextDue(1000, 60_000, 200_000), 260_000, 'far behind: from now');
  assert.equal(retryDelay(60_000), 20_000);
  assert.equal(retryDelay(30_000), 10_000);
  assert.equal(retryDelay(300_000), 20_000);
  assert.equal(retryDelay(60_000, 600), 60_000, 'Retry-After: 600 is capped at the interval');
  assert.equal(retryDelay(300_000, 45), 45_000);
  assert.equal(retryDelay(60_000, 5), 20_000, 'never shorter than the normal spacing');
});

test('token buckets refill continuously', () => {
  const b = new TokenBucket(30, 5, 0);
  for (let i = 0; i < 5; i++) assert.equal(b.take(0), 0);
  assert.equal(b.take(0), 2000, 'the next token in 2 s (30 a minute)');
  assert.equal(b.take(1999), 1);
  assert.equal(b.take(2000), 0);
});

test('host and domain buckets throttle; the domain is shared by its subdomains; lag is not counted for politeness', () => {
  const s = new Scheduler(OPTS);
  const now = 1_000_000;
  // 8 Prüfungen auf einen Host: 5 sofort (Stoß), der Rest wartet auf Token
  for (let i = 1; i <= 8; i++) s.upsert(job(i, now, { host: 'victim.zz', domain: 'victim.zz' }));
  const first = s.takeRunnable(now);
  assert.equal(first.length, 5);
  assert.equal(s.queued, 3);
  assert.ok(s.delayed10m(now) >= 3);
  for (const j of first) s.finish(j.id);
  const later = s.takeRunnable(now + 2000);
  assert.equal(later.length, 1);
  // Domain: a.victim2.zz und b.victim2.zz teilen 60/min (Stoß 10)
  const d = new Scheduler(OPTS);
  for (let i = 1; i <= 12; i++) d.upsert(job(i, now, { host: (i % 2 ? 'a' : 'b') + '.victim2.zz', domain: 'victim2.zz' }));
  assert.equal(d.takeRunnable(now).length, 10);
  assert.equal(d.lagP95(now), 0);
});

test('global, keyword and per-user gates; one run per monitor', () => {
  const s = new Scheduler({ ...OPTS, concurrency: 3, keywordConcurrency: 1, userInflight: 2 });
  const now = 5_000_000;
  s.upsert(job(1, now, { keyword: true }));
  s.upsert(job(2, now + 1, { keyword: true }));
  s.upsert(job(3, now + 2, { userId: 9 }));
  s.upsert(job(4, now + 3, { userId: 9 }));
  s.upsert(job(5, now + 4, { userId: 9 }));
  const run = s.takeRunnable(now + 10);
  assert.deepEqual(run.map((j) => j.id).sort(), [1, 3, 4]);
  assert.equal(s.inflight, 3);
  assert.equal(s.keywordInflight, 1);
  // eine laufende Prüfung wird nicht noch einmal eingeplant
  s.upsert(job(1, now));
  assert.equal(s.isRunning(1), true);
  assert.equal(s.queuedJob(1), undefined);
  s.finish(1);
  s.finish(3);
  const next = s.takeRunnable(now + 300);
  assert.deepEqual(next.map((j) => j.id).sort(), [2, 5]);
  // die Wartezeit wegen fehlender Kapazität zählt als Verzögerung
  assert.ok(s.lagP95(now + 300) >= 250);
});

test('429 pauses the host; jobs of that host wait until the pause ends', () => {
  const s = new Scheduler(OPTS);
  const now = 9_000_000;
  s.pauseHost('busy.zz', now + 60_000);
  s.upsert(job(1, now, { host: 'busy.zz', domain: 'busy.zz' }));
  s.upsert(job(2, now, { host: 'other.zz', domain: 'other.zz' }));
  assert.deepEqual(s.takeRunnable(now).map((j) => j.id), [2]);
  assert.equal(s.queuedJob(1)?.due, now + 60_000);
  assert.equal(s.queuedJob(1)?.throttled, true);
  assert.deepEqual(s.takeRunnable(now + 60_000).map((j) => j.id), [1]);
  assert.equal(s.hostPausedUntil('busy.zz', now + 60_001), null);
});

test('the IP bucket is a ceiling for many domains on one address', () => {
  const s = new Scheduler({ ...OPTS, ipPerMin: 60 });
  let waited = 0;
  for (let i = 0; i < 120; i++) if (s.takeIp('76.76.21.21', 0) > 0) waited++;
  assert.equal(waited, 20, 'burst 100, then wait');
  assert.equal(s.takeIp('185.199.108.153', 0), 0, 'another address is not affected');
});
