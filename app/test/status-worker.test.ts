// Statusseiten, Prüfdienst mit Datenbank (Integration): der Kern läuft mit dem Test-Einstieg (Richtlinie nur für die
// lokalen Testserver, Test-DNS, Kanarienvögel auf dem Testserver, verstellbare Uhr) gegen eine eigene Test-Datenbank.
// Rohdaten, Zustand, Ereignisse, Summen, robots.txt, 403/429 über 24 Stunden, private Adressen, die Plattform-Sperre
// (DNS weg → eingefroren; viele Hosts scheitern → hold und danach echte Ausfälle mit der Zeit des ersten Fehlschlags),
// Heartbeats mit einem geplanten Fenster, „Jetzt prüfen“, System-Bestandteile, Partitionen, Aufräumen, sauberes Ende,
// die Leitsperre und das Warten auf das Schema ohne Migration.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { ensureSchema, V_STATUS_TABLES } from '../src/schema.js';
import { statusSaveSettings } from '../src/status/settings.js';
import { statusPing } from '../src/status/commands.js';
import { LeaderLock } from '../src/status/lock.js';
import { runWorker, waitForSchema } from '../src/status/worker.js';
import { partitionDay, utcDay } from '../src/status/partitions.js';
import { errorText } from '../src/status/errors.js';
import type { Checker } from '../src/status/checker.js';
import { testDatabase, type TestDb } from './coreHarness.js';
import { startDns, type FakeDns } from './helpers/dnsServer.js';
import { hasOpenssl, testPki, type TestPki } from './helpers/certs.js';
import { startTargets, type Targets } from './helpers/targets.js';
import { testChecker, testClock, type TestClock } from './helpers/checkerHarness.js';

let db: TestDb;
let dns: FakeDns;
let pki: TestPki;
let t: Targets;
let systemPage = 0;
const skip = !hasOpenssl();

async function q(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  await db.admin.query(`USE \`${db.name}\``);
  return (await db.admin.query<RowDataPacket[]>(sql, params))[0];
}

before(async () => {
  if (skip) return;
  db = await testDatabase('st2worker');
  await ensureSchema();
  await statusSaveSettings({ components_max: 100 });
  systemPage = Number((await q('SELECT id FROM status_pages WHERE is_system = 1'))[0].id);
  pki = testPki();
  const leaf = pki.leaf(['site.zz']);
  t = await startTargets({ byName: new Map([['site.zz', leaf]]), fallback: leaf });
  const zone: Record<string, { A?: string[] }> = {
    'web.zz': { A: ['127.0.0.1'] }, 'health.web.zz': { A: ['127.0.0.1'] }, 'site.zz': { A: ['127.0.0.1'] }, 'robots.zz': { A: ['127.0.0.1'] },
    'refuse.zz': { A: ['127.0.0.1'] }, 'evil.zz': { A: ['10.0.0.1'] },
  };
  for (let i = 1; i <= 3; i++) zone[`canary${i}.zz`] = { A: ['127.0.0.1'] };
  for (let i = 1; i <= 50; i++) zone[`h${i}.zz`] = { A: ['127.0.0.1'] };
  dns = await startDns(zone);
});

after(async () => {
  if (skip) return;
  await t.close();
  await dns.stop();
  pki.done();
  await db.done();
});

let seq = 0;
async function addMonitor(o: { target: string; pageId?: number; userId?: number | null; type?: string; interval?: number; config?: Record<string, unknown> }): Promise<number> {
  const type = o.type ?? 'http';
  const host = type === 'http' ? new URL(o.target).hostname : '';
  const now = Math.floor(Date.now() / 1000);
  const [res] = await db.admin.query<{ insertId: number } & RowDataPacket[]>(`INSERT INTO \`${db.name}\`.status_monitors
      (page_id, user_id, type, name, target, target_host, target_domain, config, interval_s, position, changed_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
  [o.pageId ?? systemPage, o.userId ?? null, type, `Test ${++seq}`, o.target, host, host, JSON.stringify(o.config ?? { retries: 1 }), o.interval ?? 60, 100 + seq, now]);
  return (res as unknown as { insertId: number }).insertId;
}

async function runOnce(c: Checker, id: number): Promise<void> {
  assert.ok(c.runNow(id), `monitor ${id} is scheduled`);
  c.tick();
  await c.idle();
  await c.settle();
}

async function fresh(clock: TestClock, o: { userChecks?: number; log?: string[] } = {}): Promise<Checker> {
  const c = testChecker({ dns, targets: t, clock, ca: pki.ca, userChecks: o.userChecks, log: o.log });
  await c.start();
  return c;
}

test('a website check: state, raw rows, aggregates and the health record', { skip }, async () => {
  const clock = testClock();
  const id = await addMonitor({ target: `http://site.zz:${t.httpPort}/ok` });
  const c = await fresh(clock);
  await runOnce(c, id);
  assert.equal(c.snapshot(id)?.state.state, 'up');
  clock.advance(60_000);
  await runOnce(c, id);
  await c.flush();
  await c.flushAggregates();
  await c.writeHealth();
  const raw = await q('SELECT ok, code, error FROM status_checks WHERE monitor_id = ? ORDER BY at', [id]);
  assert.deepEqual(raw.map((r) => [r.ok, r.code, r.error]), [[1, 200, null], [1, 200, null]]);
  const state = (await q('SELECT * FROM status_state WHERE monitor_id = ?', [id]))[0];
  assert.equal(state.state, 'up');
  assert.equal(state.last_code, 200);
  const hourly = await q('SELECT SUM(checks) AS checks, SUM(covered_s) AS covered, SUM(down_s) AS down FROM status_hourly WHERE monitor_id = ?', [id]);
  assert.equal(Number(hourly[0].checks), 2);
  assert.ok(Number(hourly[0].covered) >= 59, 'the minute between the checks is covered');
  assert.equal(Number(hourly[0].down), 0);
  assert.equal(Number((await q('SELECT SUM(checks) AS n FROM status_daily WHERE monitor_id = ?', [id]))[0].n), 2);
  const worker = JSON.parse(String((await q("SELECT meta_value FROM oys_meta WHERE meta_key = 'status_worker'"))[0].meta_value)) as Record<string, unknown>;
  assert.ok(Number((worker.monitors as { active: number }).active) >= 1);
  assert.equal(worker.version, '1');
  assert.ok(typeof worker.lag_p95_ms === 'number');
  await c.stop();
});

test('failures: down after the retries with the first failure as start, back up, events and down time', { skip }, async () => {
  const clock = testClock();
  const id = await addMonitor({ target: `http://site.zz:${t.httpPort}/switch`, config: { retries: 1 } });
  const c = await fresh(clock);
  await runOnce(c, id);
  clock.advance(60_000);
  t.status.set('/switch', 500);
  await runOnce(c, id);
  const firstFail = c.snapshot(id)?.state.firstFailAt;
  assert.equal(c.snapshot(id)?.state.state, 'up', 'one failure is pending');
  clock.advance(20_000);
  await runOnce(c, id);
  assert.equal(c.snapshot(id)?.state.state, 'down');
  assert.equal(c.snapshot(id)?.state.since, firstFail);
  clock.advance(60_000);
  t.status.delete('/switch');
  await runOnce(c, id);
  assert.equal(c.snapshot(id)?.state.state, 'up');
  await c.flush();
  await c.flushAggregates();
  const events = await q('SELECT kind, error FROM status_events WHERE monitor_id = ? ORDER BY id', [id]);
  assert.deepEqual(events.map((e) => [e.kind, e.error]), [['down', 'status'], ['up', null]]);
  const down = Number((await q('SELECT SUM(down_s) AS d FROM status_hourly WHERE monitor_id = ?', [id]))[0].d);
  assert.ok(down >= 79 && down <= 82, `down time from the first failure until it was back: ${down}`);
  await c.stop();
});

test('429 delays without a result and pauses the host; 503 is a failure', { skip }, async () => {
  const clock = testClock();
  const limited = await addMonitor({ target: `http://site.zz:${t.httpPort}/429` });
  const maint = await addMonitor({ target: `http://site.zz:${t.httpPort}/503`, config: { retries: 0 } });
  const c = await fresh(clock);
  await runOnce(c, limited);
  const asked = t.seen.filter((s) => s.path === '/429').length;
  assert.equal(c.snapshot(limited)?.state.state, 'unknown', 'no result');
  assert.ok(c.snapshot(limited)?.state.refusedSince !== null);
  // Der Host pausiert (Retry-After: 120): auch „Jetzt prüfen“ fragt ihn nicht
  c.runNow(limited);
  c.tick();
  await c.idle();
  assert.equal(t.seen.filter((s) => s.path === '/429').length, asked);
  await c.flush();
  assert.equal((await q('SELECT COUNT(*) AS n FROM status_checks WHERE monitor_id = ?', [limited]))[0].n, 0);
  assert.ok((await q('SELECT throttled_at FROM status_state WHERE monitor_id = ?', [limited]))[0].throttled_at !== null);
  // 503 mit Retry-After: ein Fehlschlag (eine Seite im Wartungsmodus ist für Besucher weg)
  clock.advance(130_000);
  await runOnce(c, maint);
  assert.equal(c.snapshot(maint)?.state.state, 'down');
  await c.stop();
});

test('robots.txt: an opt-out pauses the check, a later fetch that allows it resumes it', { skip }, async () => {
  const clock = testClock();
  t.robots.set('robots.zz', { status: 200, body: 'User-agent: *\nDisallow: /\n\nUser-agent: OnYourSite-Monitor\nDisallow: /ok\n' });
  const id = await addMonitor({ target: `http://robots.zz:${t.httpPort}/ok` });
  const c = await fresh(clock);
  await runOnce(c, id);
  assert.equal((await q('SELECT auto_paused FROM status_monitors WHERE id = ?', [id]))[0].auto_paused, 'robots');
  assert.equal(t.seen.filter((s) => s.host === 'robots.zz' && s.path === '/ok').length, 0, 'the page itself was not requested');
  assert.equal(c.snapshot(id)?.active, false);
  const meta = (await q("SELECT robots_rules FROM status_host_meta WHERE host = 'robots.zz'"))[0];
  assert.deepEqual(JSON.parse(String(meta.robots_rules)), [['disallow', '/ok']]);
  // Die tägliche Nachschau (eigene Aufgabe des Prüfdienstes)
  const recheck = async (): Promise<void> => {
    c.makeDue('robots');
    c.tick();
    await c.settle();
  };
  await recheck(); // heute noch nicht wieder geholt
  t.robots.set('robots.zz', { status: 200, body: 'User-agent: OnYourSite-Monitor\nDisallow: /private\n' });
  clock.advance(25 * 3600 * 1000);
  await recheck();
  assert.equal((await q('SELECT auto_paused FROM status_monitors WHERE id = ?', [id]))[0].auto_paused, null);
  assert.equal(c.snapshot(id)?.active, true);
  await c.flush();
  assert.deepEqual((await q('SELECT kind, error FROM status_events WHERE monitor_id = ? ORDER BY id', [id])).map((e) => [e.kind, e.error]),
    [['paused', 'robots'], ['resumed', 'robots']]);
  await c.stop();
});

test('403 without a break for 24 hours pauses the check; three private answers in a row pause it too', { skip }, async () => {
  const clock = testClock();
  const log: string[] = [];
  const refused = await addMonitor({ target: `http://refuse.zz:${t.httpPort}/403`, config: { retries: 0 } });
  const evil = await addMonitor({ target: `http://evil.zz:${t.httpPort}/`, config: { retries: 3 } });
  const c = await fresh(clock, { log });
  await runOnce(c, refused);
  assert.equal(c.snapshot(refused)?.autoPaused, null);
  clock.advance(24 * 3600 * 1000 + 1000);
  await runOnce(c, refused);
  assert.equal((await q('SELECT auto_paused FROM status_monitors WHERE id = ?', [refused]))[0].auto_paused, 'refused');
  // Nach dem Sprung der Uhr laufen fällige Prüfungen auch nebenher – bis zur Pause, höchstens fünfmal
  for (let i = 0; i < 5 && c.runNow(evil); i++) {
    c.tick();
    await c.idle();
    await c.settle();
  }
  assert.equal((await q('SELECT auto_paused FROM status_monitors WHERE id = ?', [evil]))[0].auto_paused, 'private_ip');
  assert.ok(log.some((l) => l.includes(`monitor #${evil} paused itself`)));
  assert.equal(t.seen.filter((s) => s.host === 'evil.zz').length, 0, 'nothing was sent to the private address');
  await c.stop();
});

test('a frozen gate: nothing counts while our DNS is gone, checks continue when it is back', { skip }, async () => {
  const clock = testClock();
  const id = await addMonitor({ target: `http://127.0.0.1:${t.httpPort}/500`, config: { retries: 0 } });
  const c = await fresh(clock);
  await dns.stop();
  try {
    c.makeDue('canaries');
    c.tick();
    await c.settle();
    assert.equal(c.gate.state, 'frozen');
    await runOnce(c, id);
    assert.equal(c.snapshot(id)?.state.state, 'unknown', 'no state change while frozen');
    assert.equal(c.snapshot(id)?.lastError, 'internal');
  } finally {
    await dns.start();
  }
  const gate = JSON.parse(String((await q("SELECT meta_value FROM oys_meta WHERE meta_key = 'status_gate'"))[0].meta_value)) as { state: string; reason: string };
  assert.deepEqual([gate.state, gate.reason], ['frozen', 'resolver']);
  for (let i = 0; i < 2; i++) {
    clock.advance(30_000);
    c.makeDue('canaries');
    c.tick();
    await c.settle();
  }
  assert.equal(c.gate.state, 'ok');
  await runOnce(c, id);
  assert.equal(c.snapshot(id)?.state.state, 'down');
  await c.flush();
  assert.deepEqual((await q('SELECT kind FROM status_events WHERE monitor_id = ?', [id])).map((e) => e.kind), ['down'], 'one event, after the gate opened');
  const raw = await q('SELECT error FROM status_checks WHERE monitor_id = ? ORDER BY at', [id]);
  assert.equal(raw[0].error, 'internal');
  await c.stop();
});

test('hold: when many sites fail at once, down waits while the canaries are healthy – then it is real, with the first failure time', { skip }, async () => {
  const clock = testClock();
  const ids: number[] = [];
  for (let i = 1; i <= 50; i++) ids.push(await addMonitor({ target: `http://h${i}.zz:${t.httpPort}/${i <= 20 ? '500' : 'ok'}`, config: { retries: 1 } }));
  const c = await fresh(clock);
  c.makeDue('canaries');
  c.tick();
  await c.settle();
  assert.equal(c.gate.state, 'ok');
  for (const id of ids) c.runNow(id);
  c.tick();
  await c.idle();
  await c.settle();
  const firstFail = c.snapshot(ids[0])?.state.firstFailAt;
  assert.ok(firstFail);
  c.makeDue('gate');
  c.tick();
  await c.settle();
  assert.equal(c.gate.state, 'hold');
  clock.advance(20_000);
  for (const id of ids.slice(0, 20)) c.runNow(id);
  c.tick();
  await c.idle();
  await c.settle();
  assert.equal(c.snapshot(ids[0])?.state.state, 'unknown', 'the down transition waits');
  assert.equal(c.snapshot(ids[0])?.state.fails, 2);
  for (const step of [100_000, 90_000]) {
    clock.advance(step);
    c.makeDue('canaries');
    c.tick();
    await c.settle();
  }
  assert.equal(c.gate.state, 'ok');
  for (const id of ids.slice(0, 20)) {
    assert.equal(c.snapshot(id)?.state.state, 'down', `monitor ${id}`);
    assert.equal(c.snapshot(id)?.state.since, c.snapshot(id)?.state.firstFailAt ?? firstFail);
  }
  assert.equal(c.snapshot(ids[30])?.state.state, 'up');
  await c.stop();
  await q(`DELETE FROM status_monitors WHERE id IN (${ids.join(',')})`);
});

test('heartbeats: a planned window on our side restarts the deadline', { skip }, async () => {
  const clock = testClock();
  const now = Math.floor(Date.now() / 1000);
  await q("INSERT INTO status_pages (user_id, is_system, slug, title, created_at, updated_at, changed_at) VALUES (5, 0, 'mia-status', 'Mia', NOW(), NOW(), ?)", [now]);
  const page = Number((await q("SELECT id FROM status_pages WHERE slug = 'mia-status'"))[0].id);
  const id = await addMonitor({ pageId: page, userId: 5, type: 'heartbeat', target: '', config: { period: 120, grace: 60 } });
  await q('UPDATE status_monitors SET hb_last_ping_at = ? WHERE id = ?', [now, id]);
  const c = await fresh(clock, { userChecks: 5 });
  await c.sweep();
  assert.equal(c.snapshot(id)?.state.state, 'up');
  // Update: unser Eingang ist bis jetzt + 300 s absichtlich weg
  await q("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('status_planned', ?)", [String(now + 300)]);
  const gateRound = async (): Promise<void> => {
    c.makeDue('gate');
    c.tick();
    await c.settle();
  };
  await gateRound();
  assert.ok(c.gate.ingressDownSince !== null);
  clock.advance(250_000);
  await c.sweep();
  assert.equal(c.snapshot(id)?.state.state, 'up', 'no deadline runs out while our ingress is down');
  clock.advance(60_000);
  await gateRound();
  assert.equal(c.gate.ingressDownSince, null);
  const recovered = c.gate.ingressRecoveredAt ?? 0;
  assert.ok(recovered >= now + 300);
  clock.advance(150_000);
  await c.sweep();
  assert.equal(c.snapshot(id)?.state.state, 'up', 'the deadline counts from the end of the window');
  clock.advance(40_000);
  await c.sweep();
  assert.equal(c.snapshot(id)?.state.state, 'down');
  assert.equal(c.snapshot(id)?.lastError, 'hb_missed');
  // Ein neuer Ping → wieder da
  await q('UPDATE status_monitors SET hb_last_ping_at = ? WHERE id = ?', [Math.floor(clock.now() / 1000), id]);
  await c.sweep();
  assert.equal(c.snapshot(id)?.state.state, 'up');
  await c.stop();
});

test('"Check now" runs the check at once and does not change status_rev', { skip }, async () => {
  const clock = testClock();
  const id = await addMonitor({ target: `http://site.zz:${t.httpPort}/ok`, interval: 300 });
  const c = await fresh(clock);
  const rev = (await q("SELECT meta_value FROM oys_meta WHERE meta_key = 'status_rev'"))[0].meta_value;
  const asked = t.seen.length;
  await q('INSERT INTO status_run_requests (monitor_id, requested_at) VALUES (?, ?)', [id, Math.floor(clock.now() / 1000)]);
  c.makeDue('runs');
  c.tick();
  await c.settle();
  c.tick();
  await c.idle();
  assert.ok(t.seen.length > asked);
  assert.equal((await q('SELECT COUNT(*) AS n FROM status_run_requests')).at(0)?.n, 0);
  assert.equal((await q("SELECT meta_value FROM oys_meta WHERE meta_key = 'status_rev'"))[0].meta_value, rev);
  await c.stop();
});

test('OnYourSite components: probes, hidden parts, job heartbeats and the job runner', { skip }, async () => {
  const clock = testClock();
  const sys = new Map((await q("SELECT id, target FROM status_monitors WHERE page_id = ? AND type = 'system'", [systemPage])).map((r) => [String(r.target), Number(r.id)]));
  const c = await fresh(clock);
  for (const key of ['web', 'pages', 'db', 'bot', 'mail', 'tunnel', 'origin', 'disk', 'domains', 'job:runner']) await runOnce(c, sys.get(key) as number);
  const snap = (key: string) => c.snapshot(sys.get(key) as number);
  assert.equal(snap('web')?.state.state, 'up');
  assert.equal(snap('pages')?.state.state, 'up');
  assert.ok(t.seen.some((s) => s.host === 'health.web.zz' && s.path === '/_/health'));
  assert.equal(snap('db')?.state.state, 'up');
  for (const key of ['bot', 'mail', 'tunnel', 'domains', 'job:runner']) assert.equal(snap(key)?.hidden, true, key);
  assert.equal(snap('origin')?.state.state, 'unknown', 'no measurement of the sensor yet');
  // Job-Heartbeat über status:ping (schreibt direkt in die Datenbank)
  assert.equal(await statusPing('backup'), true);
  await c.sweep();
  assert.equal(snap('job:backup')?.state.state, 'up');
  // Der Job-Läufer erscheint, sobald es ihn gibt
  const now = Math.floor(clock.now() / 1000);
  await q("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('jobs', ?)", [JSON.stringify({ shop: { at: now, ok: true, every: 300 } })]);
  await runOnce(c, sys.get('job:runner') as number);
  assert.equal(snap('job:runner')?.hidden, false);
  assert.equal(snap('job:runner')?.state.state, 'up');
  await q("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('jobs', ?)", [JSON.stringify({ shop: { at: now - 3600, ok: true, every: 300 } })]);
  await runOnce(c, sys.get('job:runner') as number);
  assert.equal(snap('job:runner')?.state.state, 'down');
  assert.equal(snap('job:runner')?.lastError, 'job_late');
  // Sensor: Speicher knapp → eingeschränkt
  await q("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('status_probe', ?)", [JSON.stringify({ at: now, origin: { ok: true, ms: 3 }, disk: { free_pct: 12 }, tunnel: null })]);
  await runOnce(c, sys.get('disk') as number);
  await runOnce(c, sys.get('origin') as number);
  assert.equal(snap('disk')?.state.state, 'degraded');
  assert.equal(snap('disk')?.lastError, 'disk_low', 'the key of the component, not just “slow”');
  assert.equal(errorText('disk_low'), 'Less than 15 % disk space left.');
  assert.equal(snap('origin')?.state.state, 'up');
  await c.stop();
});

test('partitions: future days are added and old days dropped; without partitions old rows go in batches', { skip }, async () => {
  const clock = testClock();
  const c = await fresh(clock);
  const parts = async (): Promise<string[]> => (await q(`SELECT PARTITION_NAME AS n FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'status_checks'
      AND PARTITION_NAME IS NOT NULL ORDER BY PARTITION_ORDINAL_POSITION`, [db.name])).map((r) => String(r.n));
  clock.advance(5 * 86400_000);
  await c.maintainPartitions();
  const after5 = await parts();
  const today = utcDay(Math.floor(clock.now() / 1000));
  const days = after5.map(partitionDay).filter((d): d is number => d !== null);
  assert.ok(days.includes(today + 3 * 86400), 'three days ahead');
  assert.ok(days.every((d) => d >= today - 2 * 86400), 'nothing older than raw_days');
  assert.equal(after5.at(-1), 'pmax');
  // Ohne Partitionen: in Schritten löschen
  await q('ALTER TABLE status_checks REMOVE PARTITIONING');
  const nowS = Math.floor(clock.now() / 1000);
  await q('INSERT INTO status_checks (monitor_id, at, ok) VALUES (9999, ?, 1), (9999, ?, 1)', [nowS - 10 * 86400, nowS]);
  await c.retention();
  assert.deepEqual((await q('SELECT at FROM status_checks WHERE monitor_id = 9999')).map((r) => r.at), [nowS]);
  await c.maintainPartitions(); // ohne Partitionen: nichts zu tun
  assert.deepEqual(await parts(), []);
  await c.stop();
});

test('the purge queue removes the measured data of deleted monitors; retention removes old rows', { skip }, async () => {
  const clock = testClock();
  const c = await fresh(clock);
  const now = Math.floor(clock.now() / 1000);
  const gone = 777001;
  await q('INSERT INTO status_state (monitor_id, state, updated_at) VALUES (?, ?, ?)', [gone, 'up', now]);
  await q('INSERT INTO status_hourly (monitor_id, hour, checks) VALUES (?, ?, 1), (?, ?, 1)', [gone, now - 7200, gone, now - 3600]);
  await q('INSERT INTO status_daily (monitor_id, day, checks) VALUES (?, CURDATE(), 1)', [gone]);
  await q('INSERT INTO status_events (monitor_id, at, kind) VALUES (?, ?, ?)', [gone, now, 'down']);
  await q('INSERT INTO status_purge (kind, ref_id, created_at) VALUES (?, ?, ?)', ['monitor', gone, now]);
  await c.purge();
  for (const tb of ['status_state', 'status_hourly', 'status_daily', 'status_events']) {
    assert.equal((await q(`SELECT COUNT(*) AS n FROM ${tb} WHERE monitor_id = ?`, [gone]))[0].n, 0, tb);
  }
  assert.equal((await q('SELECT COUNT(*) AS n FROM status_purge'))[0].n, 0);
  // Aufbewahrung: Ereignisse 90 Tage, Stunden 14 Tage
  await q('INSERT INTO status_events (monitor_id, at, kind) VALUES (777002, ?, ?), (777002, ?, ?)', [now - 91 * 86400, 'down', now - 89 * 86400, 'up']);
  await q('INSERT INTO status_hourly (monitor_id, hour, checks) VALUES (777002, ?, 1), (777002, ?, 1)', [now - 15 * 86400, now - 13 * 86400]);
  await c.retention();
  assert.deepEqual((await q('SELECT kind FROM status_events WHERE monitor_id = 777002')).map((r) => r.kind), ['up']);
  assert.equal((await q('SELECT COUNT(*) AS n FROM status_hourly WHERE monitor_id = 777002'))[0].n, 1);
  await c.stop();
});

test('stop() writes everything that is still buffered', { skip }, async () => {
  const clock = testClock();
  const id = await addMonitor({ target: `http://site.zz:${t.httpPort}/ok` });
  const c = await fresh(clock);
  await runOnce(c, id);
  await c.stop();
  assert.equal((await q('SELECT COUNT(*) AS n FROM status_checks WHERE monitor_id = ?', [id]))[0].n, 1);
  assert.equal((await q('SELECT state FROM status_state WHERE monitor_id = ?', [id]))[0].state, 'up');
});

test('the leader lock: one checker at a time, the second takes over after the first ends', { skip }, async () => {
  const a = new LeaderLock('oys_status_test_lock');
  const b = new LeaderLock('oys_status_test_lock');
  assert.equal(await a.acquire(), true);
  assert.equal(await b.acquire(), false);
  assert.equal(await a.alive(), true);
  await a.release();
  assert.equal(await b.acquire(), true);
  assert.equal(await b.alive(), true);
  await b.release();
  assert.equal(await b.alive(), false);

  // Zwei Dienste: nur einer startet; endet er, übernimmt der andere
  const started: string[] = [];
  const fake = (name: string) => () => ({
    start: async () => void started.push(name),
    tick: () => Date.now() + 50,
    stop: async () => undefined,
  }) as unknown as Checker;
  let stopA = false;
  let stopB = false;
  const runA = runWorker({ stop: () => stopA, makeChecker: fake('a'), lock: new LeaderLock('oys_status_test_worker'), waitMs: 300 });
  await new Promise((r) => setTimeout(r, 200));
  const runB = runWorker({ stop: () => stopB, makeChecker: fake('b'), lock: new LeaderLock('oys_status_test_worker'), waitMs: 300 });
  await new Promise((r) => setTimeout(r, 800));
  assert.deepEqual(started, ['a']);
  stopA = true;
  await runA;
  await new Promise((r) => setTimeout(r, 1200));
  assert.deepEqual(started, ['a', 'b']);
  stopB = true;
  await runB;
});

test('the checker only waits for the schema – it never migrates', { skip }, async () => {
  await q("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('schema_version', ?)", [String(V_STATUS_TABLES - 1)]);
  try {
    let polls = 0;
    const ready = await waitForSchema(() => ++polls > 4, 50);
    assert.equal(ready, false);
    assert.equal((await q("SELECT meta_value FROM oys_meta WHERE meta_key = 'schema_version'"))[0].meta_value, String(V_STATUS_TABLES - 1), 'nothing migrated');
  } finally {
    await q("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('schema_version', ?)", [String(V_STATUS_TABLES)]);
  }
  assert.equal(await waitForSchema(() => false, 50), true);
});

// Prüfbericht: während „hold“ wartet auch der Wechsel eines Heartbeats nach „down“ – beim Ende von „hold“ wurden aber
// nur HTTP-Prüfungen nachgeholt. Ein Heartbeat, dessen Frist in einem „hold“ ablief, blieb für immer „up“ (die Frist
// war schon als gemeldet vermerkt) – ein toter Job galt als in Ordnung.
test('hold: a heartbeat that missed its deadline during a hold goes down when the hold ends', { skip }, async () => {
  const clock = testClock();
  await q("DELETE FROM oys_meta WHERE meta_key IN ('status_planned', 'status_gate', 'status_worker')");
  const now = Math.floor(clock.now() / 1000);
  await q("INSERT INTO status_pages (user_id, is_system, slug, title, created_at, updated_at, changed_at) VALUES (6, 0, 'tom-status', 'Tom', NOW(), NOW(), ?)", [now]);
  const page = Number((await q("SELECT id FROM status_pages WHERE slug = 'tom-status'"))[0].id);
  const id = await addMonitor({ pageId: page, userId: 6, type: 'heartbeat', target: '', config: { period: 120, grace: 60 } });
  await q('UPDATE status_monitors SET hb_last_ping_at = ? WHERE id = ?', [now, id]);
  const c = await fresh(clock, { userChecks: 5 });
  await c.sweep();
  assert.equal(c.snapshot(id)?.state.state, 'up');
  // Viele Websites scheitern zugleich, die Kanarienvögel sind gesund: „hold“
  c.gate = { ...c.gate, state: 'hold', since: now, reason: 'ratio', holdHealthySince: now, canaries: { ok: 3, of: 3, at: now, resolverOk: true } };
  clock.advance(200_000);
  await c.sweep();
  assert.equal(c.snapshot(id)?.state.state, 'up', 'the down transition waits during the hold');
  assert.equal(c.snapshot(id)?.state.fails, 1);
  const missedAt = c.snapshot(id)?.state.firstFailAt;
  // Die Kanarienvögel bleiben gesund: „hold“ endet, die Ausfälle waren echt
  c.makeDue('canaries');
  c.tick();
  await c.settle();
  assert.equal(c.gate.state, 'ok');
  assert.equal(c.snapshot(id)?.state.state, 'down', 'the held heartbeat goes down');
  assert.equal(c.snapshot(id)?.state.since, missedAt);
  await c.flush();
  assert.deepEqual((await q('SELECT kind, error FROM status_events WHERE monitor_id = ?', [id])).map((e) => [e.kind, e.error]), [['down', 'hb_missed']]);
  await c.stop();
  await q('DELETE FROM status_monitors WHERE id = ?', [id]);
  await q('DELETE FROM status_pages WHERE id = ?', [page]);
});

// Prüfbericht: beim Ende von „hold“ wurde die Ausfallzeit seit dem ersten Fehlschlag bis JETZT gebucht – abgedeckt war
// aber nur die Zeit bis zum letzten Ergebnis, und die nächste Prüfung buchte dieselbe Spanne noch einmal als Ausfall.
test('hold: the down time is booked once when the hold ends (never more down than covered time)', { skip }, async () => {
  const clock = testClock();
  await q("DELETE FROM oys_meta WHERE meta_key IN ('status_planned', 'status_gate', 'status_worker')");
  t.status.set('/switch', 200);
  // Ein eigener Host: andere Prüfungen der Datei teilen sich sonst seinen Eimer (die Prüfung würde verschoben)
  const id = await addMonitor({ target: `http://h9.zz:${t.httpPort}/switch`, config: { retries: 1 } });
  const c = await fresh(clock);
  try {
    await runOnce(c, id);
    assert.equal(c.snapshot(id)?.state.state, 'up');
    t.status.set('/switch', 500);
    clock.advance(60_000);
    await runOnce(c, id);
    const now = Math.floor(clock.now() / 1000);
    c.gate = { ...c.gate, state: 'hold', since: now, reason: 'ratio', holdHealthySince: now, canaries: { ok: 3, of: 3, at: now, resolverOk: true } };
    clock.advance(20_000);
    await runOnce(c, id);
    assert.equal(c.snapshot(id)?.state.state, 'up', 'held');
    clock.advance(190_000);
    // Nur die Kanarienvögel – die fällige Prüfung soll nicht nebenher laufen (sonst hinge das Ergebnis vom Zufall ab)
    const job = c.scheduler.queuedJob(id);
    assert.ok(job);
    c.scheduler.remove(id);
    c.makeDue('canaries');
    c.tick();
    await c.settle();
    c.scheduler.upsert(job);
    assert.equal(c.gate.state, 'ok');
    assert.equal(c.snapshot(id)?.state.state, 'down');
    clock.advance(30_000);
    await runOnce(c, id);
    await c.flushAggregates();
    const sum = (await q('SELECT SUM(covered_s) AS covered, SUM(down_s) AS down FROM status_hourly WHERE monitor_id = ?', [id]))[0];
    assert.ok(Number(sum.down) <= Number(sum.covered), `down ${sum.down} s, covered ${sum.covered} s`);
    assert.equal(Number(sum.down), 20 + 130, 'from the first failure to the last result in the hold, then the next interval');
  } finally {
    t.status.delete('/switch');
    await c.stop();
    await q('DELETE FROM status_monitors WHERE id = ?', [id]);
  }
});

// Prüfbericht: die eingeplante Prüfung behielt nach einer Änderung Host, Domain und Stichwort des alten Ziels – die
// Höflichkeit (Eimer je Host und Domain, die Pause nach 429) galt dem alten Host, nicht dem, der jetzt Anfragen bekommt.
// Außerdem lief eine geänderte Prüfung erst zum alten Termin statt „innerhalb von 5 s“ (Entwurf §4.8.2).
test('a changed check: the queued job follows the new target and runs within 5 s', { skip }, async () => {
  const clock = testClock();
  const id = await addMonitor({ target: `http://h8.zz:${t.httpPort}/ok`, interval: 300 });
  const c = await fresh(clock);
  try {
    assert.equal(c.scheduler.queuedJob(id)?.host, 'h8.zz');
    await runOnce(c, id);
    assert.equal(c.scheduler.queuedJob(id)?.host, 'h8.zz');
    // Der Besitzer ändert die Adresse und setzt ein Stichwort (wie es der Editor schreiben wird)
    clock.advance(10_000);
    const now = Math.floor(clock.now() / 1000);
    await q(`UPDATE status_monitors SET target = ?, target_host = 'h7.zz', target_domain = 'h7.zz', config = ?, changed_at = ? WHERE id = ?`,
      [`http://h7.zz:${t.httpPort}/ok`, JSON.stringify({ retries: 1, keyword: 'hello' }), now, id]);
    await q("UPDATE oys_meta SET meta_value = meta_value + 1 WHERE meta_key = 'status_rev'");
    c.makeDue('sync');
    c.tick();
    await c.settle();
    const job = c.scheduler.queuedJob(id);
    assert.deepEqual([job?.host, job?.domain, job?.keyword], ['h7.zz', 'h7.zz', true]);
    assert.ok(job && job.due <= clock.now() + 5000, 'runs within 5 s');
    // Nach dem Lauf bleibt es beim neuen Ziel
    await runOnce(c, id);
    assert.equal(t.seen.at(-1)?.host, 'h7.zz');
    assert.equal(c.scheduler.queuedJob(id)?.host, 'h7.zz');
    // Ein voller Abgleich (alle 10 Minuten) zieht nichts vor
    const due = c.scheduler.queuedJob(id)?.due;
    c.makeDue('reload');
    c.tick();
    await c.settle();
    assert.equal(c.scheduler.queuedJob(id)?.due, due);
  } finally {
    await c.stop();
    await q('DELETE FROM status_monitors WHERE id = ?', [id]);
  }
});

// Prüfbericht: die Grenze je Host zählte im laufenden Betrieb auch Prüfungen, die gar nicht laufen (gesperrte Seite,
// selbst angehalten, über der Grenze des Nutzers …). Wer die Plätze eines Hosts so belegte, hielt die echten Prüfungen
// dieses Hosts an – und das Sperren der Seite durch das Team gab die Plätze nicht frei.
test('the per-host cap only counts checks that run', { skip }, async () => {
  const clock = testClock();
  await statusSaveSettings({ components_max: 100, host_cap: 1 });
  const now = Math.floor(clock.now() / 1000);
  await q("INSERT INTO status_pages (user_id, is_system, slug, title, is_blocked, created_at, updated_at, changed_at) VALUES (7, 0, 'lea-status', 'Lea', 1, NOW(), NOW(), ?)", [now]);
  const blockedPage = Number((await q("SELECT id FROM status_pages WHERE slug = 'lea-status'"))[0].id);
  const blocked = await addMonitor({ pageId: blockedPage, userId: 7, target: `http://h11.zz:${t.httpPort}/ok` });
  const selfPaused = await addMonitor({ target: `http://h11.zz:${t.httpPort}/ok` });
  await q("UPDATE status_monitors SET auto_paused = 'refused' WHERE id = ?", [selfPaused]);
  const real = await addMonitor({ target: `http://h11.zz:${t.httpPort}/ok` });
  const second = await addMonitor({ target: `http://h11.zz:${t.httpPort}/ok` });
  const c = await fresh(clock, { userChecks: 5 });
  try {
    assert.equal(c.snapshot(blocked)?.active, false, 'the blocked page does not check');
    assert.equal(c.snapshot(selfPaused)?.active, false);
    assert.equal(c.snapshot(real)?.active, true, 'the first check that runs gets the place');
    assert.equal(c.snapshot(second)?.active, false, 'the cap still holds');
  } finally {
    await c.stop();
    await statusSaveSettings({ components_max: 100 });
    await q(`DELETE FROM status_monitors WHERE id IN (${[blocked, selfPaused, real, second].join(',')})`);
    await q('DELETE FROM status_pages WHERE id = ?', [blockedPage]);
  }
});

// Prüfbericht: die tägliche Nachschau der wegen robots.txt ruhenden Prüfungen lief INNERHALB des Gesundheitseintrags –
// eine hängende robots.txt (10 s je Host) hielt status_worker an; nach drei Minuten hätte der Wächter „Status checks
// have stopped“ gemeldet, obwohl alles lief.
test('the daily robots.txt look-up never holds up the health record', { skip }, async () => {
  const clock = testClock();
  t.robots.set('h12.zz', { status: 0, body: '' });
  const id = await addMonitor({ target: `http://h12.zz:${t.httpPort}/ok` });
  await q("UPDATE status_monitors SET auto_paused = 'robots' WHERE id = ?", [id]);
  const c = await fresh(clock);
  try {
    const start = Date.now();
    await c.writeHealth();
    assert.ok(Date.now() - start < 2000, `the health record took ${Date.now() - start} ms`);
    const worker = JSON.parse(String((await q("SELECT meta_value FROM oys_meta WHERE meta_key = 'status_worker'"))[0].meta_value)) as { at: number };
    assert.ok(Math.abs(worker.at - Math.floor(clock.now() / 1000)) <= 2);
  } finally {
    await c.stop();
    t.robots.delete('h12.zz');
    await q('DELETE FROM status_monitors WHERE id = ?', [id]);
  }
});

// Prüfbericht: scheiterte das Anlegen des Prüfdienstes (z. B. os.networkInterfaces() in der Sandbox), brach runWorker()
// ab – das ganze Programm endete, systemd startete es alle 5 s neu. Jetzt: Protokoll, Sperre frei, neuer Versuch.
test('a checker that cannot be set up is logged and tried again, not a crash', { skip }, async () => {
  let calls = 0;
  const started: number[] = [];
  let stop = false;
  const lock = new LeaderLock('oys_status_test_setup');
  try {
    const run = runWorker({
      stop: () => stop,
      makeChecker: () => {
        calls++;
        if (calls === 1) throw new Error('uv_interface_addresses returned Unknown system error 97');
        return { start: async () => void started.push(calls), tick: () => Date.now() + 50, stop: async () => undefined } as unknown as Checker;
      },
      lock,
      waitMs: 300,
    });
    for (let i = 0; i < 100 && !started.length; i++) await new Promise((r) => setTimeout(r, 50));
    stop = true;
    await run;
  } finally {
    stop = true;
    await lock.release();
  }
  assert.deepEqual(started, [2], 'the second attempt runs');
});
