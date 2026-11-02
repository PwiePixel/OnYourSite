// Statusseiten, Plattform-Sperre (gate.ts, rein): jede Zeile aus Entwurf §4.8.15 – Kanarienvögel 3/3 und 1/3,
// Erholung nach zwei guten Runden, Anteil scheiternder Hosts (hold, frühestens 20 Hosts, nach 3 Minuten gesunder
// Kanarienvögel wieder ok, eingefroren, wenn sie dabei scheitern), lokale Socket-Fehler, Resolver, und das Ende der
// letzten Störung unseres Eingangs aus jedem Signal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateRecordJson, gateStep, initialGate, type GateRecord, type IngressSignals } from '../src/status/gate.js';

const round = (ok: number, of = 3, resolverOk = true) => ({ canaryRound: { ok, of, resolverOk } });
const T = 1_800_000_000;

function after(g: GateRecord, steps: Array<[number, Parameters<typeof gateStep>[1]]>): GateRecord {
  for (const [t, s] of steps) g = gateStep(g, s, t);
  return g;
}

test('canaries: 3/3 stays ok, one bad round stays ok, two bad rounds freeze', () => {
  let g = initialGate(T);
  g = gateStep(g, round(3), T + 30);
  assert.equal(g.state, 'ok');
  g = gateStep(g, round(1), T + 60);
  assert.equal(g.state, 'ok', 'one bad round is not enough');
  g = gateStep(g, round(1), T + 90);
  assert.equal(g.state, 'frozen');
  assert.equal(g.reason, 'canaries');
  assert.equal(g.since, T + 90);
  // 2 von 3 gesund ist eine gute Runde
  assert.equal(after(initialGate(T), [[T + 30, round(2)], [T + 60, round(2)]]).state, 'ok');
});

test('recovery needs two healthy rounds in a row and no local socket error in the last 60 s', () => {
  let g = after(initialGate(T), [[T + 30, round(0)], [T + 60, round(0)]]);
  assert.equal(g.state, 'frozen');
  g = gateStep(g, round(3), T + 90);
  assert.equal(g.state, 'frozen', 'one good round is not enough');
  g = gateStep(g, round(1), T + 120);
  g = gateStep(g, round(3), T + 150);
  assert.equal(g.state, 'frozen', 'the good rounds must be in a row');
  g = gateStep(g, { localErrors: 1 }, T + 160);
  g = gateStep(g, round(3), T + 180);
  assert.equal(g.state, 'frozen', 'a local error within 60 s keeps it closed');
  g = gateStep(g, round(3), T + 230);
  assert.equal(g.state, 'ok');
  assert.equal(g.reason, '');
});

test('the resolver canary failing freezes at once', () => {
  const g = gateStep(initialGate(T), round(3, 3, false), T + 30);
  assert.equal(g.state, 'frozen');
  assert.equal(g.reason, 'resolver');
});

test('local socket errors: more than 5 within 30 s freeze', () => {
  let g = initialGate(T);
  g = gateStep(g, { localErrors: 5 }, T + 1);
  assert.equal(g.state, 'ok');
  g = gateStep(g, { localErrors: 1 }, T + 20);
  assert.equal(g.state, 'frozen');
  assert.equal(g.reason, 'local');
  // verteilt über mehr als 30 s: nicht
  let h = initialGate(T);
  for (let i = 0; i < 10; i++) h = gateStep(h, { localErrors: 1 }, T + i * 10);
  assert.equal(h.state, 'ok');
});

test('many failing hosts with healthy canaries hold; after 3 minutes of healthy canaries the hold ends', () => {
  let g = gateStep(initialGate(T), round(3), T);
  // weniger als 20 Hosts halten nie
  assert.equal(gateStep(g, { hosts: { failed: 19, total: 19 } }, T + 5).state, 'ok');
  // 30 % sind nicht mehr als 30 %
  assert.equal(gateStep(g, { hosts: { failed: 6, total: 20 } }, T + 5).state, 'ok');
  g = gateStep(g, { hosts: { failed: 20, total: 50 } }, T + 10);
  assert.equal(g.state, 'hold');
  assert.equal(g.reason, 'ratio');
  g = after(g, [[T + 20, round(3)], [T + 30, round(3)], [T + 100, round(3)]]);
  g = gateStep(g, { hosts: { failed: 20, total: 50 } }, T + 189);
  assert.equal(g.state, 'hold', 'just under 3 minutes');
  g = gateStep(g, round(3), T + 190);
  assert.equal(g.state, 'ok');
  // Danach beginnt nicht sofort wieder ein hold für dieselben Ausfälle
  assert.equal(gateStep(g, { hosts: { failed: 20, total: 50 } }, T + 200).state, 'ok');
  assert.equal(gateStep(g, { hosts: { failed: 20, total: 50 } }, T + 190 + 601).state, 'hold');
});

test('a hold turns frozen when the canaries fail meanwhile', () => {
  let g = gateStep(gateStep(initialGate(T), round(3), T), { hosts: { failed: 30, total: 40 } }, T + 10);
  assert.equal(g.state, 'hold');
  g = after(g, [[T + 20, round(1)], [T + 30, round(0)]]);
  assert.equal(g.state, 'frozen');
});

test('ingress: recovered at the end of each disturbance – checks, probes, database, planned window, web start, checker gap', () => {
  const quiet: IngressSignals = { unhealthy: false, plannedUntil: null, webStart: null, resumedAt: null };
  let g = initialGate(T);
  g = gateStep(g, { ingress: { ...quiet, unhealthy: true } }, T + 100);
  assert.equal(g.ingressDownSince, T + 100);
  g = gateStep(g, { ingress: { ...quiet, unhealthy: true } }, T + 200);
  assert.equal(g.ingressDownSince, T + 100, 'the start stays');
  g = gateStep(g, { ingress: quiet }, T + 300);
  assert.equal(g.ingressDownSince, null);
  assert.equal(g.ingressRecoveredAt, T + 300);
  // geplantes Fenster: gestört bis zu seinem Ende
  g = gateStep(g, { ingress: { ...quiet, plannedUntil: T + 900 } }, T + 400);
  assert.equal(g.ingressDownSince, T + 400);
  g = gateStep(g, { ingress: { ...quiet, plannedUntil: T + 900 } }, T + 950);
  assert.equal(g.ingressDownSince, null);
  assert.equal(g.ingressRecoveredAt, T + 950);
  // Start der Webseite und Rückkehr des Prüfdienstes zählen als Ende einer Störung
  g = gateStep(g, { ingress: { ...quiet, webStart: T + 1000 } }, T + 1010);
  assert.equal(g.ingressRecoveredAt, T + 1000 > T + 950 ? T + 1000 : T + 950);
  g = gateStep(g, { ingress: { ...quiet, resumedAt: T + 1500 } }, T + 1510);
  assert.equal(g.ingressRecoveredAt, T + 1500);
  // Zugefrorene Sperre = Eingang unbekannt
  g = after(g, [[T + 1600, round(0)], [T + 1630, round(0)]]);
  g = gateStep(g, { ingress: quiet }, T + 1640);
  assert.equal(g.ingressDownSince, T + 1640);
  // JSON für oys_meta
  assert.deepEqual(Object.keys(gateRecordJson(g)), ['state', 'since', 'reason', 'canaries', 'ingress_recovered_at', 'ingress_down_since']);
});
