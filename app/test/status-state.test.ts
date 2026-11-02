// Statusseiten, Zustand einer Prüfung (state.ts): jede Zeile der Tabelle aus Entwurf §4.8.7 – Wiederholungen 0–3,
// langsam/eingeschränkt, Erholung, flapping an und aus, Wartung, Zertifikat 14/3 Tage, geschlossene und wartende
// Plattform-Sperre, 403/429, Heartbeat-Fristen mit Neustart der Uhr nach einer Störung bei uns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REFUSED_PAUSE_AFTER, discardHeld, heartbeatDeadline, heartbeatVerdict, initialState, refusedFor, releaseHeld, step, type CheckResult,
  type StateRecord, type StepConfig,
} from '../src/status/state.js';

const cfg = (o: Partial<StepConfig> = {}): StepConfig => ({ retries: 1, slowRun: 3, certWarn: true, gate: 'ok', maintenance: false, ...o });
const ok = (at: number, o: Partial<CheckResult> = {}): CheckResult => ({ kind: 'ok', at, ms: 100, code: 200, ...o });
const fail = (at: number, o: Partial<CheckResult> = {}): CheckResult => ({ kind: 'fail', at, error: 'timeout', ...o });

function run(results: CheckResult[], c: StepConfig, start: StateRecord = initialState()): { s: StateRecord; events: string[]; pending: boolean[] } {
  let s = start;
  const events: string[] = [];
  const pending: boolean[] = [];
  for (const r of results) {
    const out = step(s, r, c);
    s = out.next;
    events.push(...out.events.map((e) => e.kind));
    pending.push(out.pending);
  }
  return { s, events, pending };
}

test('unknown → up on the first success, without an event', () => {
  const { s, events } = run([ok(1000)], cfg());
  assert.equal(s.state, 'up');
  assert.equal(s.since, 1000);
  assert.deepEqual(events, []);
});

test('down only after 1 + retries failures, since = the first failure; one success brings it back with the downtime', () => {
  for (const retries of [0, 1, 2, 3]) {
    const fails = Array.from({ length: retries + 1 }, (_v, i) => fail(1100 + i * 20));
    const { s, events, pending } = run([ok(1000), ...fails], cfg({ retries }));
    assert.equal(s.state, 'down', `retries ${retries}`);
    assert.equal(s.since, 1100, 'down counts from the first failed check');
    assert.deepEqual(events, ['down']);
    assert.deepEqual(pending, [false, ...Array.from({ length: retries }, () => true), false]);
    const back = step(s, ok(2000), cfg({ retries }));
    assert.equal(back.next.state, 'up');
    assert.deepEqual(back.events.map((e) => [e.kind, e.downFor]), [['up', 900]]);
  }
  // Ein Erfolg zwischen den Fehlschlägen setzt den Zähler zurück
  const { s } = run([ok(1000), fail(1060), ok(1080), fail(1140)], cfg({ retries: 1 }));
  assert.equal(s.state, 'up');
  assert.equal(s.fails, 1);
  // Auch aus „unknown“ (nie erreicht) wird „down“
  assert.equal(run([fail(1), fail(2)], cfg()).s.state, 'down');
});

test('slow answers: three in a row → degraded, a fast one → recovered; after down a slow success is degraded', () => {
  const c = cfg({ retries: 0, slowRun: 3 });
  const { s, events } = run([ok(1), ok(2, { slow: true }), ok(3, { slow: true }), ok(4, { slow: true })], c);
  assert.equal(s.state, 'degraded');
  assert.deepEqual(events, ['degraded']);
  const r = step(s, ok(5), c);
  assert.equal(r.next.state, 'up');
  assert.deepEqual(r.events.map((e) => e.kind), ['recovered']);
  // zwei langsame genügen nicht
  assert.equal(run([ok(1), ok(2, { slow: true }), ok(3, { slow: true }), ok(4)], c).s.state, 'up');
  // System-Bestandteile: einmal eingeschränkt genügt
  assert.equal(run([ok(1), ok(2, { slow: true })], cfg({ slowRun: 1 })).s.state, 'degraded');
});

test('flapping: six up/down changes within 60 minutes mute alerts; 30 minutes without a change → stable', () => {
  const c = cfg({ retries: 0 });
  const seq: CheckResult[] = [ok(0)];
  for (let i = 0; i < 6; i++) seq.push(fail(100 + i * 200), ok(200 + i * 200));
  const { s, events } = run(seq, c);
  assert.equal(s.flapping, true);
  assert.equal(events.filter((e) => e === 'flapping').length, 1, 'flapping is reported once');
  // Ereignisse während flapping sind stumm
  const muted = step(s, fail(5000), c);
  assert.equal(muted.events[0].kind, 'down');
  assert.equal(muted.events[0].muted, true);
  // 30 Minuten ohne Wechsel
  const still = step(muted.next, fail(5000 + 1799), c);
  assert.equal(still.next.flapping, true);
  const stable = step(still.next, fail(5000 + 1800), c);
  assert.equal(stable.next.flapping, false);
  assert.deepEqual(stable.events.map((e) => e.kind), ['stable']);
  // fünf Wechsel reichen nicht
  const five: CheckResult[] = [ok(0)];
  for (let i = 0; i < 2; i++) five.push(fail(100 + i * 200), ok(200 + i * 200));
  five.push(fail(1000));
  assert.equal(run(five, c).s.flapping, false);
});

test('maintenance: events are recorded but muted', () => {
  const r = run([ok(0), fail(10), fail(20)], cfg({ maintenance: true }));
  assert.equal(r.s.state, 'down');
  const out = step(initialState(), ok(0), cfg());
  const down = step(step(out.next, fail(10), cfg({ maintenance: true })).next, fail(20), cfg({ maintenance: true }));
  assert.equal(down.events[0].muted, true);
});

test('certificates: a warning at ≤ 14 days and again at ≤ 3 days; a renewed certificate resets', () => {
  const day = 86400;
  const c = cfg();
  let s = step(initialState(), ok(0, { certExpires: 30 * day }), c).next;
  let r = step(s, ok(1, { certExpires: 14 * day }), c);
  assert.deepEqual(r.events.map((e) => [e.kind, e.certDays]), [['cert', 14]]);
  s = r.next;
  r = step(s, ok(2, { certExpires: 10 * day }), c);
  assert.deepEqual(r.events, [], 'only once per threshold');
  r = step(r.next, ok(3, { certExpires: 3 * day }), c);
  assert.deepEqual(r.events.map((e) => [e.kind, e.certDays]), [['cert', 3]]);
  r = step(r.next, ok(4, { certExpires: 90 * day }), c);
  assert.equal(r.next.certWarned, null, 'renewed');
  r = step(r.next, ok(5, { certExpires: 13 * day }), c);
  assert.deepEqual(r.events.map((e) => e.kind), ['cert']);
  // ohne cert_warn keine Warnung
  assert.deepEqual(step(initialState(), ok(0, { certExpires: 2 * day }), cfg({ certWarn: false })).events, []);
});

test('internal results and a frozen gate change nothing; hold keeps the down transition waiting', () => {
  const up = run([ok(0)], cfg()).s;
  for (const r of [{ kind: 'internal', at: 10 } as CheckResult, fail(10)]) {
    const out = step(up, r, cfg({ gate: r.kind === 'internal' ? 'ok' : 'frozen' }));
    assert.equal(out.next.state, 'up');
    assert.equal(out.next.fails, 0);
    assert.deepEqual(out.events, []);
  }
  // hold: der Wechsel wartet, der erste Fehlschlag bleibt gemerkt
  let s = step(up, fail(100), cfg({ gate: 'hold' })).next;
  const held = step(s, fail(120), cfg({ gate: 'hold' }));
  assert.equal(held.next.state, 'up');
  assert.equal(held.held, true);
  assert.equal(held.next.firstFailAt, 100);
  s = held.next;
  // Ende von hold: down mit der Zeit des ersten Fehlschlags
  const released = releaseHeld(s, 300, 1, cfg(), { error: 'timeout', code: null });
  assert.equal(released.next.state, 'down');
  assert.equal(released.next.since, 100);
  assert.deepEqual(released.events.map((e) => [e.kind, e.since]), [['down', 100]]);
  // Zugefroren: die wartenden Fehlschläge zählen nicht mehr
  const discarded = discardHeld(s);
  assert.equal(discarded.fails, 0);
  assert.equal(discarded.firstFailAt, null);
  assert.equal(releaseHeld(discarded, 300, 1, cfg()).events.length, 0);
});

test('503 is a normal failure; 429 is no result but keeps refused_since; other codes end it', () => {
  const c = cfg({ retries: 0 });
  let s = run([ok(0)], c).s;
  // 503 mit Retry-After: Fehlschlag
  assert.equal(step(s, fail(10, { code: 503, error: 'status' }), c).next.state, 'down');
  // 429: kein Ergebnis
  const delayed = step(s, { kind: 'delayed', at: 20, code: 429, refused: true }, c);
  assert.equal(delayed.next.state, 'up');
  assert.equal(delayed.next.refusedSince, 20);
  s = delayed.next;
  s = step(s, fail(60, { code: 403, error: 'status', refused: true }), c).next;
  assert.equal(s.refusedSince, 20, 'a 403 continues the series');
  assert.equal(refusedFor(s, 20 + REFUSED_PAUSE_AFTER), REFUSED_PAUSE_AFTER);
  s = step(s, ok(100), c).next;
  assert.equal(s.refusedSince, null, 'any other answer ends it');
  // „blocked“ in Folge wird gezählt (3 → die Prüfung hält sich an)
  let b = run([ok(0)], c).s;
  for (let i = 1; i <= 3; i++) b = step(b, fail(i, { error: 'blocked' }), c).next;
  assert.equal(b.blocked, 3);
  assert.equal(step(b, fail(9, { error: 'timeout' }), c).next.blocked, 0);
});

test('system probes can report "unknown" (stale sensor): state unknown, no event', () => {
  const up = run([ok(0)], cfg()).s;
  const out = step(up, { kind: 'unknown', at: 50 }, cfg());
  assert.equal(out.next.state, 'unknown');
  assert.deepEqual(out.events, []);
});

test('heartbeats: the deadline restarts after an outage on our side', () => {
  const h = (at: string): number => Date.UTC(2026, 10, 2, Number(at.slice(0, 2)), Number(at.slice(3))) / 1000;
  const base = { lastPingAt: h('10:00'), lastFailAt: null, period: 3600, grace: 300 };
  // Unser Eingang war 10:50–11:10 gestört → die Frist beginnt um 11:10 neu
  assert.equal(heartbeatDeadline({ ...base, ingressRecoveredAt: h('11:10'), ingressDown: false }), h('12:15'));
  const seen = { ping: h('10:00'), fail: null, missedFor: null };
  assert.deepEqual(heartbeatVerdict({ ...base, ingressRecoveredAt: h('11:10'), ingressDown: false }, seen, h('12:14')), { kind: 'none' });
  assert.deepEqual(heartbeatVerdict({ ...base, ingressRecoveredAt: h('11:10'), ingressDown: false }, seen, h('12:16')), { kind: 'fail', at: h('12:16'), error: 'hb_missed' });
  // Ohne Störung wäre es 11:05 gewesen
  assert.equal(heartbeatDeadline({ ...base, ingressRecoveredAt: null, ingressDown: false }), h('11:05'));
  // Während unser Eingang gestört ist, läuft keine Frist ab
  assert.deepEqual(heartbeatVerdict({ ...base, ingressRecoveredAt: null, ingressDown: true }, seen, h('13:00')), { kind: 'none' });
  // Nur einmal je Frist
  assert.deepEqual(heartbeatVerdict({ ...base, ingressRecoveredAt: null, ingressDown: false }, { ...seen, missedFor: h('11:05') }, h('11:30')), { kind: 'none' });
  // Ein neuer Ping zählt, /fail sofort
  assert.deepEqual(heartbeatVerdict({ ...base, lastPingAt: h('11:00'), ingressRecoveredAt: null, ingressDown: false }, seen, h('11:00')), { kind: 'ok', at: h('11:00') });
  assert.deepEqual(heartbeatVerdict({ ...base, lastFailAt: h('10:30'), ingressRecoveredAt: null, ingressDown: false }, seen, h('10:31')), { kind: 'fail', at: h('10:30'), error: 'hb_failed' });
  // Vor dem ersten Ping: nichts (Zustand bleibt „unknown“)
  assert.equal(heartbeatDeadline({ ...base, lastPingAt: null, ingressRecoveredAt: null, ingressDown: false }), null);
  assert.deepEqual(heartbeatVerdict({ ...base, lastPingAt: null, ingressRecoveredAt: null, ingressDown: false }, { ping: null, fail: null, missedFor: null }, h('23:00')), { kind: 'none' });
});
