// Statusseiten: Grenzen einer Seite – die EINZIGE Stelle, die entscheidet (Editor, Prüfdienst, Admin).
// Bis zur Freischaltung im Shop (ST-4) gilt: OnYourSites eigene Seite hat feste Grenzen, Seiten von Nutzern den Plan
// 'none' (keine Prüfungen) – ohne Lesen aus dem Shop. Danach liest diese Datei has()/entitlement()/premiumState() des
// Shops; die Form des Ergebnisses bleibt gleich.
import type { Db } from '../db.js';
import { statusSettings, type StatusSettings } from './settings.js';

export type StatusPlan = 'none' | 'free' | 'addons' | 'premium' | 'system';

export interface StatusLimits {
  plan: StatusPlan;
  checks: number; // Prüfungen (http + heartbeat), die laufen dürfen
  components: number; // Bestandteile insgesamt (auch manuelle)
  minInterval: number; // kürzester Abstand in Sekunden
  channels: number; // zusätzliche Alarm-Kanäle
  subscribers: number;
  broadcastsDay: number;
  until: string | null; // Ende eines Zusatzpakets oder von Premium (bis ST-7 immer null)
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

// userId null = OnYourSites eigene Seite (status_pages.user_id ist dort NULL)
export async function statusLimits(userId: number | null, db?: Db): Promise<StatusLimits> {
  const s = await statusSettings(db);
  if (userId === null) return systemLimits(s);
  // Seiten von Nutzern gibt es erst mit der Freischaltung (ST-4)
  return noLimits(s);
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
