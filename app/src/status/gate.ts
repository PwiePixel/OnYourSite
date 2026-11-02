// Statusseiten: Plattform-Sperre (rein). Eigene Störungen (Leitung, Resolver, Sockets, Neustarts) dürfen nie wie ein
// Ausfall der Seite eines Nutzers aussehen (Entwurf §4.8.15):
// - ok:     normal
// - hold:   mehr als 30 % der Hosts der letzten 2 Minuten scheitern (mindestens 20 Hosts), die Kanarienvögel sind
//           gesund → neue Wechsel nach „down“ warten bis zu 3 Minuten; bleiben die Kanarienvögel gesund, sind die
//           Ausfälle echt (großes CDN) und die Wechsel geschehen mit ihrer echten Anfangszeit
// - frozen: 2 von 3 Kanarienvögeln scheitern in zwei Runden hintereinander, oder der Resolver-Kanarienvogel scheitert,
//           oder mehr als 5 lokale Socket-Fehler in 30 s → nichts zählt (Ergebnisse „internal“, keine Wechsel,
//           keine Alarme); wieder offen nach zwei gesunden Runden ohne lokalen Fehler in den letzten 60 s
// Dazu der Eingang (für Heartbeats): Ende der letzten Störung unseres Eingangs (ingressRecoveredAt).
import type { GateState } from './state.js';

export type { GateState } from './state.js';
export type GateReason = '' | 'canaries' | 'resolver' | 'local' | 'ratio';

export interface GateRecord {
  state: GateState;
  since: number; // Beginn des Zustands (Unix)
  reason: GateReason;
  canaries: { ok: number; of: number; at: number | null; resolverOk: boolean }; // letzte Runde
  badRounds: number; // Runden in Folge mit mindestens 2 gescheiterten Kanarienvögeln
  goodRounds: number; // gesunde Runden in Folge
  holdHealthySince: number | null; // seit wann die Kanarienvögel während „hold“ gesund sind
  holdCooldownUntil: number; // nach dem Ende eines „hold“ beginnt so lange kein neuer
  localErrors: number[]; // Zeiten lokaler Socket-Fehler (letzte 60 s)
  ingressRecoveredAt: number | null; // Ende der letzten Störung unseres Eingangs
  ingressDownSince: number | null; // der Eingang ist seit … gestört (null = gesund)
}

export const HOLD_MIN_HOSTS = 20;
export const HOLD_RATIO = 0.3;
export const HOLD_MAX = 180; // Sekunden gesunde Kanarienvögel bis zum Ende von „hold“
export const HOLD_COOLDOWN = 600;
export const LOCAL_WINDOW = 30;
export const LOCAL_MAX = 5;
export const LOCAL_QUIET = 60;

export function initialGate(now: number): GateRecord {
  return {
    state: 'ok', since: now, reason: '', canaries: { ok: 0, of: 0, at: null, resolverOk: true }, badRounds: 0, goodRounds: 0,
    holdHealthySince: null, holdCooldownUntil: 0, localErrors: [], ingressRecoveredAt: null, ingressDownSince: null,
  };
}

export interface IngressSignals {
  unhealthy: boolean; // web/pages-Prüfung, Tunnel/Ursprung (Sensor) oder die Datenbank gestört
  plannedUntil: number | null; // geplantes Fenster des Installers (status_planned)
  webStart: number | null; // letzter Start der Webseite (status_web_start)
  resumedAt: number | null; // der Prüfdienst war länger als 2 Minuten weg und läuft seit …
}

export interface GateSignals {
  canaryRound?: { ok: number; of: number; resolverOk: boolean }; // eine neue Runde jetzt
  localErrors?: number; // neue lokale Socket-Fehler jetzt
  hosts?: { failed: number; total: number }; // verschiedene Hosts der letzten 2 Minuten und wie viele scheitern
  ingress?: IngressSignals;
}

// Eine gesunde Runde: höchstens ein Kanarienvogel gescheitert und der Resolver antwortet
const healthy = (c: { ok: number; of: number; resolverOk: boolean }): boolean => c.resolverOk && c.of - c.ok <= 1;
const badCanaries = (c: { ok: number; of: number }): boolean => c.of > 0 && c.of - c.ok >= 2;

function enter(g: GateRecord, state: GateState, reason: GateReason, now: number): void {
  if (g.state === state) return;
  g.state = state;
  g.since = now;
  g.reason = state === 'ok' ? '' : reason;
  if (state !== 'hold') g.holdHealthySince = null;
}

export function gateStep(prev: GateRecord, signals: GateSignals, now: number): GateRecord {
  const g: GateRecord = { ...prev, canaries: { ...prev.canaries }, localErrors: prev.localErrors.filter((t) => t > now - LOCAL_QUIET) };
  for (let i = 0; i < (signals.localErrors ?? 0); i++) g.localErrors.push(now);
  const recentLocal = g.localErrors.filter((t) => t > now - LOCAL_WINDOW).length;

  // 1. Lokale Fehler frieren sofort ein
  if (recentLocal > LOCAL_MAX && g.state !== 'frozen') enter(g, 'frozen', 'local', now);

  // 2. Kanarienvögel
  const round = signals.canaryRound;
  if (round) {
    g.canaries = { ...round, at: now };
    g.badRounds = badCanaries(round) ? g.badRounds + 1 : 0;
    g.goodRounds = healthy(round) ? g.goodRounds + 1 : 0;
    if (g.state !== 'frozen') {
      if (!round.resolverOk) enter(g, 'frozen', 'resolver', now);
      else if (g.badRounds >= 2) enter(g, 'frozen', 'canaries', now);
    } else if (g.goodRounds >= 2 && !g.localErrors.some((t) => t > now - LOCAL_QUIET)) {
      enter(g, 'ok', '', now);
    }
    if (g.state === 'hold') {
      if (healthy(round)) g.holdHealthySince ??= now;
      else g.holdHealthySince = null;
    }
  }

  // 3. Viele Hosts scheitern bei gesunden Kanarienvögeln → warten (höchstens 3 Minuten gesunde Kanarienvögel)
  const hosts = signals.hosts;
  if (g.state === 'ok' && hosts && now >= g.holdCooldownUntil && hosts.total >= HOLD_MIN_HOSTS && hosts.failed / hosts.total > HOLD_RATIO) {
    enter(g, 'hold', 'ratio', now);
    g.holdHealthySince = g.canaries.at !== null && healthy(g.canaries) ? now : null;
  }
  if (g.state === 'hold' && g.holdHealthySince !== null && now - g.holdHealthySince >= HOLD_MAX) {
    enter(g, 'ok', '', now);
    g.holdCooldownUntil = now + HOLD_COOLDOWN;
  }

  // 4. Eingang: gestört, solange ein Signal es sagt, die Sperre zu ist oder ein geplantes Fenster läuft
  const ing = signals.ingress;
  if (ing) {
    const down = ing.unhealthy || g.state === 'frozen' || (ing.plannedUntil !== null && now < ing.plannedUntil);
    if (down) {
      g.ingressDownSince ??= now;
    } else if (g.ingressDownSince !== null) {
      g.ingressDownSince = null;
      g.ingressRecoveredAt = Math.max(g.ingressRecoveredAt ?? 0, now);
    }
    for (const t of [ing.plannedUntil, ing.webStart, ing.resumedAt]) {
      if (t !== null && t <= now) g.ingressRecoveredAt = Math.max(g.ingressRecoveredAt ?? 0, t);
    }
  }
  return g;
}

// Für oys_meta.status_gate und die Anzeigen
export function gateRecordJson(g: GateRecord): Record<string, unknown> {
  return {
    state: g.state,
    since: g.since,
    reason: g.reason,
    canaries: { ok: g.canaries.ok, of: g.canaries.of, at: g.canaries.at, resolver: g.canaries.resolverOk },
    ingress_recovered_at: g.ingressRecoveredAt,
    ingress_down_since: g.ingressDownSince,
  };
}
