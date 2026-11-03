// Statusseiten: Grenzen einer Seite – die EINZIGE Stelle, die entscheidet (Editor, Prüfdienst, Admin).
// OnYourSites eigene Seite hat feste Grenzen. Seiten von Nutzern: ohne die Freischaltung `status_page` der Plan 'none'
// (nichts prüft); mit ihr die kostenlosen Grenzen, dazu die Zusatzpakete des Shops (ST-7: je aktives Paket „Extra
// checks“ +10 Prüfungen, „Fast checks“ jede Minute) und Premium (30 Prüfungen, jede Minute, mehr Abonnenten – DECISIONS
// Q1 = b; Kanäle und Rundmails wie im kostenlosen Plan). Gelesen wird zur Laufzeit über has()/entitlement()/
// premiumState() des Shops – endet etwas, gilt sofort die kleinere Grenze.
import type { Db } from '../db.js';
import { statusSettings, type StatusSettings } from './settings.js';
import { entitlement, has } from '../honeycombs/entitlements.js';
import { premiumState } from '../honeycombs/premium.js';
import { FAST_CHECKS_KEY, MORE_CHECKS_KEY, STATUS_FEATURE_KEY } from './shop.js';

export type StatusPlan = 'none' | 'free' | 'addons' | 'premium' | 'system';

export interface StatusLimits {
  plan: StatusPlan;
  checks: number; // Prüfungen (http + heartbeat), die laufen dürfen
  components: number; // Bestandteile insgesamt (auch manuelle)
  minInterval: number; // kürzester Abstand in Sekunden
  channels: number; // zusätzliche Alarm-Kanäle
  subscribers: number;
  broadcastsDay: number;
  until: string | null; // frühestes Ende eines aktiven Zusatzpakets oder von Premium (null = nichts endet)
}

// Feste Grenzen von OnYourSites eigener Seite: alle Bestandteile dürfen prüfen, jede Minute
export function systemLimits(s: StatusSettings): StatusLimits {
  return {
    plan: 'system',
    checks: s.components_max,
    components: s.components_max,
    minInterval: s.intervals[0],
    channels: Math.max(s.free.channels, s.premium.channels),
    subscribers: s.premium.subscribers,
    broadcastsDay: Math.max(s.free.broadcasts_day, s.premium.broadcasts_day),
    until: null,
  };
}

// Ohne Freischaltung: nichts prüft, Daten bleiben erhalten
export function noLimits(s: StatusSettings): StatusLimits {
  return { plan: 'none', checks: 0, components: 0, minInterval: s.free.min_interval, channels: 0, subscribers: 0, broadcastsDay: 0, until: null };
}

// Freigeschaltet (status_page): die kostenlosen Grenzen der Einstellungen; Bestandteile höchstens components_max
export function freeLimits(s: StatusSettings): StatusLimits {
  return {
    plan: 'free',
    checks: s.free.checks,
    components: s.components_max,
    minInterval: s.free.min_interval,
    channels: s.free.channels,
    subscribers: s.free.subscribers,
    broadcastsDay: s.free.broadcasts_day,
    until: null,
  };
}

// userId null = OnYourSites eigene Seite (status_pages.user_id ist dort NULL)
export async function statusLimits(userId: number | null, db?: Db): Promise<StatusLimits> {
  const s = await statusSettings(db);
  if (userId === null) return systemLimits(s);
  if (!(await has(userId, STATUS_FEATURE_KEY, db))) return noLimits(s);
  const more = await entitlement(userId, MORE_CHECKS_KEY, db);
  const fast = await entitlement(userId, FAST_CHECKS_KEY, db);
  const prem = await premiumState(userId, db);
  return planLimits(s, {
    // Menge zählt (ein vom Team geschenktes Los kann 2 Pakete haben)
    packs: more.lots.filter((l) => l.active).reduce((sum, l) => sum + Math.max(1, l.quantity), 0),
    packsUntil: more.lots.filter((l) => l.active && !l.permanent && l.expiresAt).map((l) => String(l.expiresAt)),
    fast: fast.active, fastUntil: fast.active ? fast.until : null,
    premium: prem.active, premiumUntil: prem.active && !prem.forever ? prem.until : null,
  });
}

export interface PlanInput {
  packs: number; // aktive Pakete „Extra checks“ (höchstens 2)
  packsUntil: string[];
  fast: boolean;
  fastUntil: string | null;
  premium: boolean;
  premiumUntil: string | null; // null = dauerhaft (oder kein Premium)
}

// Rein: Grenzen aus den Einstellungen und dem, was das Konto besitzt
export function planLimits(s: StatusSettings, o: PlanInput): StatusLimits {
  const base = freeLimits(s);
  const packs = Math.max(0, Math.min(2, o.packs));
  let checks = base.checks + packs * s.addons.more_checks;
  let minInterval = o.fast ? Math.min(base.minInterval, s.addons.fast_interval) : base.minInterval;
  let subscribers = base.subscribers;
  let channels = base.channels;
  let broadcastsDay = base.broadcastsDay;
  // Mit Premium zählt dessen Ende (die Pakete ändern dann nichts mehr an den Grenzen)
  const ends: string[] = [];
  if (!o.premium && packs > 0) ends.push(...o.packsUntil);
  if (!o.premium && o.fast && o.fastUntil) ends.push(o.fastUntil);
  if (o.premium) {
    checks = Math.max(checks, s.premium.checks);
    minInterval = Math.min(minInterval, s.premium.min_interval);
    subscribers = Math.max(subscribers, s.premium.subscribers);
    channels = Math.max(channels, s.premium.channels);
    broadcastsDay = Math.max(broadcastsDay, s.premium.broadcasts_day);
    if (o.premiumUntil) ends.push(o.premiumUntil);
  }
  const plan: StatusPlan = o.premium ? 'premium' : packs > 0 || o.fast ? 'addons' : 'free';
  return {
    plan, checks, components: base.components, minInterval, channels, subscribers, broadcastsDay,
    until: ends.length ? ends.sort()[0] : null,
  };
}

// ---------------------------------------------------------------- welche Prüfungen laufen dürfen

export interface MonitorLike {
  id: number;
  type: string; // http | heartbeat | manual | system
  position: number;
  interval_s: number;
}

export type Effective<T> = T & { overLimit: boolean; effectiveInterval: number };

// Prüfungen zählen gegen die Grenze (http, heartbeat); manuelle und System-Bestandteile nie
export const countsAsCheck = (type: string): boolean => type === 'http' || type === 'heartbeat';

// Die ersten `checks` Prüfungen nach Position bleiben aktiv, der Rest ist „über der Grenze“ (pausiert, Daten bleiben).
// Abstände unter dem kürzesten erlaubten werden gestreckt. Pausierte Prüfungen belegen ihren Platz weiter.
export function effectiveMonitors<T extends MonitorLike>(rows: readonly T[], limits: StatusLimits): Array<Effective<T>> {
  const ordered = [...rows].sort((a, b) => a.position - b.position || a.id - b.id);
  const allowed = new Set<number>();
  let used = 0;
  for (const m of ordered) {
    if (!countsAsCheck(m.type)) continue;
    if (used < limits.checks) allowed.add(m.id);
    used++;
  }
  return ordered.map((m) => {
    const overLimit = countsAsCheck(m.type) && !allowed.has(m.id);
    const effectiveInterval = m.type === 'http' ? Math.max(m.interval_s, limits.minInterval) : m.interval_s;
    return { ...m, overLimit, effectiveInterval };
  });
}
