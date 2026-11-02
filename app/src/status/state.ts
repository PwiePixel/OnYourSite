// Statusseiten: Zustand einer Prüfung (rein, ohne Datenbank). step() nimmt den bisherigen Zustand und ein Ergebnis und
// liefert den neuen Zustand und die Ereignisse (Entwurf §4.8.7):
// - erst nach 1 + retries Fehlschlägen in Folge „down“ (seit der ERSTEN fehlgeschlagenen Prüfung), ein Erfolg → „up“
// - mit slow_ms: drei langsame Antworten in Folge → „degraded“, eine schnelle → wieder „up“
// - ≥ 6 Wechsel up/down in 60 Minuten → „flapping“ (Alarme stumm), 30 Minuten ohne Wechsel → „stable“
// - „internal“ (unsere Seite) und eine geschlossene Plattform-Sperre ändern nichts; während „hold“ wartet der Wechsel
//   nach „down“ und geschieht später mit der Zeit des ersten Fehlschlags
// - Zertifikat: Warnung bei ≤ 14 und noch einmal bei ≤ 3 Tagen
// - 403/429 ohne Unterbrechung: refused_since (nach 24 h hält der Prüfdienst die Prüfung an)

export type MonitorState = 'unknown' | 'up' | 'degraded' | 'down';
export type GateState = 'ok' | 'hold' | 'frozen';

export interface StateRecord {
  state: MonitorState;
  since: number | null; // Beginn des Zustands (down: erster Fehlschlag)
  flapping: boolean;
  fails: number; // Fehlschläge in Folge (auch solange der Wechsel aussteht)
  firstFailAt: number | null; // erster Fehlschlag der laufenden Folge
  slows: number; // langsame Antworten in Folge
  transitions: number[]; // Zeiten der letzten Wechsel up ↔ down (höchstens 10)
  certWarned: number | null; // zuletzt gemeldete Schwelle (14 oder 3 Tage)
  refusedSince: number | null; // Beginn einer Folge von 403/429
  blocked: number; // Ergebnisse „blocked“ in Folge (3 → die Prüfung hält sich an)
}

export function initialState(): StateRecord {
  return { state: 'unknown', since: null, flapping: false, fails: 0, firstFailAt: null, slows: 0, transitions: [], certWarned: null, refusedSince: null, blocked: 0 };
}

export type ResultKind =
  | 'ok' // geantwortet wie erwartet
  | 'fail' // Fehlschlag des Ziels
  | 'internal' // unsere Seite – zählt nicht
  | 'delayed' // 429: kein Ergebnis, der Host pausiert
  | 'unknown'; // nichts bekannt (z. B. alte Messung des Sensors) – Zustand „unknown“, ohne Ereignis

export interface CheckResult {
  kind: ResultKind;
  at: number; // Unix-Sekunden
  ms?: number | null;
  code?: number | null;
  error?: string | null; // Fehlerschlüssel (errors.ts)
  slow?: boolean; // ok, aber langsamer als erlaubt (bei System-Bestandteilen: „degraded“)
  certExpires?: number | null;
  refused?: boolean; // 403 oder 429
}

export interface StepConfig {
  retries: number; // 0–3
  slowRun: number; // langsame Antworten in Folge bis „degraded“ (Prüfungen 3, System-Bestandteile 1)
  certWarn: boolean;
  gate: GateState;
  maintenance: boolean; // eine laufende Wartung deckt die Prüfung ab: Ereignisse ohne Alarm
}

export type EventKind = 'down' | 'up' | 'degraded' | 'recovered' | 'flapping' | 'stable' | 'cert';

export interface StateEvent {
  kind: EventKind;
  at: number;
  error: string | null;
  code: number | null;
  muted: boolean; // kein Alarm (flapping oder Wartung)
  downFor?: number; // Sekunden (bei up)
  certDays?: number; // Schwelle (bei cert)
  since?: number; // Beginn (bei down: erster Fehlschlag)
}

export interface StepOutcome {
  next: StateRecord;
  events: StateEvent[];
  pending: boolean; // ein Fehlschlag, der noch nicht als „down“ zählt (bald erneut prüfen)
  held: boolean; // der Wechsel nach „down“ wartet auf das Ende von „hold“
}

const HOUR = 3600;
const DAY = 86400;
export const FLAP_TRANSITIONS = 6;
export const FLAP_WINDOW = 60 * 60;
export const STABLE_AFTER = 30 * 60;

function clone(s: StateRecord): StateRecord {
  return { ...s, transitions: [...s.transitions] };
}

function event(kind: EventKind, at: number, s: StateRecord, cfg: StepConfig, extra: Partial<StateEvent> = {}): StateEvent {
  return { kind, at, error: null, code: null, muted: s.flapping || cfg.maintenance, ...extra };
}

// Wechsel up ↔ down merken und ggf. „flapping“ setzen (einmal)
function noteTransition(s: StateRecord, at: number, cfg: StepConfig, events: StateEvent[]): void {
  s.transitions = [...s.transitions, at].slice(-10);
  const recent = s.transitions.filter((t) => t > at - FLAP_WINDOW).length;
  if (!s.flapping && recent >= FLAP_TRANSITIONS) {
    s.flapping = true;
    events.push(event('flapping', at, s, cfg, { muted: false }));
  }
}

// Zertifikat: Warnung bei ≤ 14 und bei ≤ 3 Tagen; ein späteres Ablaufdatum setzt zurück
function certCheck(s: StateRecord, r: CheckResult, cfg: StepConfig, events: StateEvent[]): void {
  if (!cfg.certWarn || r.certExpires === undefined || r.certExpires === null) return;
  const left = r.certExpires - r.at;
  if (left > 14 * DAY) {
    s.certWarned = null;
    return;
  }
  const threshold = left <= 3 * DAY ? 3 : 14;
  if (s.certWarned === null || threshold < s.certWarned) {
    s.certWarned = threshold;
    events.push(event('cert', r.at, s, cfg, { certDays: threshold, muted: cfg.maintenance }));
  }
}

export function step(prev: StateRecord, r: CheckResult, cfg: StepConfig): StepOutcome {
  const s = clone(prev);
  const events: StateEvent[] = [];
  const at = r.at;
  // Folge von 403/429: auch eine Pause (429) zählt, jede andere Antwort beendet sie
  if (r.kind === 'ok' || r.kind === 'fail' || r.kind === 'delayed') {
    if (r.refused) s.refusedSince ??= at;
    else if (r.kind !== 'delayed') s.refusedSince = null;
  }
  // Nichts zählt: unsere Seite, geschlossene Sperre, 429
  if (r.kind === 'internal' || r.kind === 'delayed' || (cfg.gate === 'frozen' && r.kind !== 'unknown')) {
    return { next: s, events, pending: false, held: false };
  }
  if (r.kind === 'unknown') {
    if (s.state !== 'unknown') {
      s.state = 'unknown';
      s.since = at;
    }
    s.fails = 0;
    s.firstFailAt = null;
    s.slows = 0;
    return { next: s, events, pending: false, held: false };
  }
  s.blocked = r.kind === 'fail' && r.error === 'blocked' ? s.blocked + 1 : 0;

  if (r.kind === 'fail') {
    s.slows = 0;
    s.fails = Math.min(255, s.fails + 1);
    s.firstFailAt ??= at;
    let pending = false;
    let held = false;
    if (s.state !== 'down') {
      if (s.fails < 1 + cfg.retries) pending = true;
      else if (cfg.gate === 'hold') pending = held = true;
      else events.push(...goDown(s, at, r, cfg));
    }
    stableCheck(s, at, cfg, events);
    return { next: s, events, pending, held };
  }

  // Erfolg
  certCheck(s, r, cfg, events);
  const slow = r.slow === true;
  s.slows = slow ? Math.min(255, s.slows + 1) : 0;
  const wasDown = s.state === 'down';
  s.fails = 0;
  s.firstFailAt = null;
  if (wasDown) {
    const downFor = s.since === null ? 0 : Math.max(0, at - s.since);
    s.state = slow && s.slows >= cfg.slowRun ? 'degraded' : 'up';
    s.since = at;
    noteTransition(s, at, cfg, events);
    events.push(event('up', at, s, cfg, { downFor, code: r.code ?? null }));
  } else if (s.state === 'unknown') {
    s.state = slow && s.slows >= cfg.slowRun ? 'degraded' : 'up';
    s.since = at;
  } else if (s.state === 'up' && slow && s.slows >= cfg.slowRun) {
    s.state = 'degraded';
    s.since = at;
    events.push(event('degraded', at, s, cfg, { code: r.code ?? null }));
  } else if (s.state === 'degraded' && !slow) {
    s.state = 'up';
    s.since = at;
    events.push(event('recovered', at, s, cfg, { code: r.code ?? null }));
  }
  stableCheck(s, at, cfg, events);
  return { next: s, events, pending: false, held: false };
}

function goDown(s: StateRecord, at: number, r: { error?: string | null; code?: number | null }, cfg: StepConfig): StateEvent[] {
  const events: StateEvent[] = [];
  const since = s.firstFailAt ?? at;
  s.state = 'down';
  s.since = since;
  noteTransition(s, at, cfg, events);
  events.push(event('down', at, s, cfg, { error: r.error ?? null, code: r.code ?? null, since }));
  return events;
}

// 30 Minuten ohne Wechsel beenden „flapping“
export function stableCheck(s: StateRecord, at: number, cfg: Pick<StepConfig, 'maintenance'>, events: StateEvent[]): void {
  if (!s.flapping) return;
  const last = s.transitions.length ? s.transitions[s.transitions.length - 1] : 0;
  if (at - last >= STABLE_AFTER) {
    s.flapping = false;
    events.push({ kind: 'stable', at, error: null, code: null, muted: cfg.maintenance });
  }
}

// Ende von „hold“: wartende Wechsel geschehen jetzt, mit der Zeit des ersten Fehlschlags
export function releaseHeld(prev: StateRecord, at: number, retries: number, cfg: StepConfig, last: { error?: string | null; code?: number | null } = {}): StepOutcome {
  const s = clone(prev);
  if (s.state === 'down' || s.fails < 1 + retries) return { next: s, events: [], pending: false, held: false };
  return { next: s, events: goDown(s, at, last, cfg), pending: false, held: false };
}

// Die Sperre ist zugefroren: die wartenden Fehlschläge waren vermutlich unsere – sie zählen nicht mehr
export function discardHeld(prev: StateRecord): StateRecord {
  if (prev.state === 'down') return clone(prev);
  return { ...clone(prev), fails: 0, firstFailAt: null };
}

// Seit wann (Sekunden) antwortet die Seite ohne Unterbrechung mit 403/429? null = gar nicht
export const refusedFor = (s: StateRecord, now: number): number | null => (s.refusedSince === null ? null : Math.max(0, now - s.refusedSince));

export const REFUSED_PAUSE_AFTER = 24 * HOUR; // so lange 403/429 → die Prüfung hält sich an
export const RATE_LIMITED_AFTER = HOUR; // so lange 429 → „Rate-limited by the site“
export const BLOCKED_PAUSE_AFTER = 3; // so oft „blocked“ in Folge → die Prüfung hält sich an

// ---------------------------------------------------------------- Heartbeats

export interface HeartbeatInput {
  lastPingAt: number | null; // letzter Ping (Unix)
  lastFailAt: number | null; // letztes /fail
  period: number;
  grace: number;
  ingressRecoveredAt: number | null; // Ende der letzten Störung unseres Eingangs (gate.ts)
  ingressDown: boolean; // der Eingang ist gerade gestört: keine Frist läuft ab
}

// Frist eines Heartbeats: ab dem letzten Ping oder – später – dem Ende der letzten Störung bei uns. Die Uhr beginnt
// dann neu (eine Stunde Abstand, Ping um 11:00 fiel in unsere Störung 10:50–11:10 → erst 12:15 fehlt er).
export function heartbeatDeadline(h: HeartbeatInput): number | null {
  if (h.lastPingAt === null) return null;
  const from = Math.max(h.lastPingAt, h.ingressRecoveredAt ?? 0);
  return from + h.period + h.grace;
}

export type HeartbeatVerdict = { kind: 'ok'; at: number } | { kind: 'fail'; at: number; error: 'hb_missed' | 'hb_failed' } | { kind: 'none' };

// Was ist seit dem letzten Blick neu? seenPing/seenFail: zuletzt ausgewertete Zeiten; missedAt: Frist, für die schon
// „hb_missed“ gemeldet wurde (nur einmal je Frist)
export function heartbeatVerdict(h: HeartbeatInput, seen: { ping: number | null; fail: number | null; missedFor: number | null }, now: number): HeartbeatVerdict {
  if (h.lastFailAt !== null && (seen.fail === null || h.lastFailAt > seen.fail) && (h.lastPingAt === null || h.lastFailAt >= h.lastPingAt)) {
    return { kind: 'fail', at: h.lastFailAt, error: 'hb_failed' };
  }
  if (h.lastPingAt !== null && (seen.ping === null || h.lastPingAt > seen.ping)) return { kind: 'ok', at: h.lastPingAt };
  if (h.ingressDown) return { kind: 'none' };
  const deadline = heartbeatDeadline(h);
  if (deadline !== null && now > deadline && seen.missedFor !== deadline) return { kind: 'fail', at: now, error: 'hb_missed' };
  return { kind: 'none' };
}
