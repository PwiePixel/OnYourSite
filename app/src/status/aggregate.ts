// Statusseiten: Rechnen mit Zeitspannen (rein). Ein Ergebnis schreibt die Zeit seit dem vorigen Ergebnis dem Zustand
// VOR ihm gut – höchstens 2 × Abstand + Zeitlimit, der Rest gilt als nicht abgedeckt. Stunden enden an UTC-Grenzen,
// Tage um Mitternacht in der Zeitzone der Seite (Tage der Zeitumstellung haben 23 oder 25 Stunden). Dazu Verfügbarkeit
// in Prozent, die Farben der 90 Tagesbalken, der öffentliche Status eines Bestandteils und der Status der Seite.
import { wallTime, wallToUnix } from '../php.js';

export interface Bucket {
  checks: number;
  fails: number;
  ms_sum: number;
  ms_count: number;
  ms_min: number | null;
  ms_max: number | null;
  covered_s: number;
  down_s: number;
  degraded_s: number;
  maint_s: number;
}

export const emptyBucket = (): Bucket => ({ checks: 0, fails: 0, ms_sum: 0, ms_count: 0, ms_min: null, ms_max: null, covered_s: 0, down_s: 0, degraded_s: 0, maint_s: 0 });

const HOUR = 3600;

// Beginn der UTC-Stunde
export const hourOf = (t: number): number => Math.floor(t / HOUR) * HOUR;

const pad = (n: number): string => String(n).padStart(2, '0');

// Tag (YYYY-MM-DD) in der Zeitzone der Seite
export function dayKey(t: number, tz: string): string {
  const w = wallTime(t, tz);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

// Nächste Mitternacht (Ortszeit) nach t
export function nextMidnight(t: number, tz: string): number {
  const w = wallTime(t, tz);
  return wallToUnix(w.year, w.month, w.day + 1, 0, 0, 0, tz);
}

// [from, to) an UTC-Stundengrenzen teilen
export function splitHours(from: number, to: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let t = from; t < to; ) {
    const end = Math.min(to, hourOf(t) + HOUR);
    out.push([hourOf(t), end - t]);
    t = end;
  }
  return out;
}

// [from, to) an Mitternacht (Ortszeit) teilen
export function splitDays(from: number, to: number, tz: string): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (let t = from; t < to; ) {
    const end = Math.min(to, nextMidnight(t, tz));
    out.push([dayKey(t, tz), end - t]);
    t = end;
  }
  return out;
}

export type SpanKind = 'up' | 'down' | 'degraded' | 'maint';

// Gutzuschreibende Spanne vor einem Ergebnis: [prevAt, prevAt + min(Abstand, 2 × interval + timeout))
export function creditWindow(prevAt: number | null, at: number, interval: number, timeout: number): [number, number] | null {
  if (prevAt === null || at <= prevAt) return null;
  return [prevAt, Math.min(at, prevAt + 2 * interval + timeout)];
}

// Sammelt Änderungen je (Prüfung, Stunde) und (Prüfung, Tag) bis zum nächsten Schreiben
export class Aggregator {
  readonly hourly = new Map<string, Bucket>();
  readonly daily = new Map<string, Bucket>();
  constructor(private readonly tz: string) {}

  private bucket(map: Map<string, Bucket>, key: string): Bucket {
    let b = map.get(key);
    if (!b) {
      b = emptyBucket();
      map.set(key, b);
    }
    return b;
  }

  // Ein Ergebnis zählt in seiner Stunde und an seinem Tag; Antwortzeiten nur von erfolgreichen Prüfungen
  addResult(monitorId: number, at: number, ok: boolean, ms: number | null): void {
    for (const b of [this.bucket(this.hourly, `${monitorId}:${hourOf(at)}`), this.bucket(this.daily, `${monitorId}:${dayKey(at, this.tz)}`)]) {
      b.checks++;
      if (!ok) b.fails++;
      if (ok && ms !== null) {
        b.ms_sum += ms;
        b.ms_count++;
        b.ms_min = b.ms_min === null ? ms : Math.min(b.ms_min, ms);
        b.ms_max = b.ms_max === null ? ms : Math.max(b.ms_max, ms);
      }
    }
  }

  // Eine abgedeckte Spanne in einem Zustand (Wartung zählt als Wartung, nicht als Ausfall)
  addSpan(monitorId: number, from: number, to: number, kind: SpanKind): void {
    if (to <= from) return;
    const apply = (b: Bucket, s: number): void => {
      b.covered_s += s;
      if (kind === 'down') b.down_s += s;
      else if (kind === 'degraded') b.degraded_s += s;
      else if (kind === 'maint') b.maint_s += s;
    };
    for (const [hour, s] of splitHours(from, to)) apply(this.bucket(this.hourly, `${monitorId}:${hour}`), s);
    for (const [day, s] of splitDays(from, to, this.tz)) apply(this.bucket(this.daily, `${monitorId}:${day}`), s);
  }

  // „down“ bestätigt: die Zeit seit dem ersten Fehlschlag war schon als abgedeckt gezählt und wird zu Ausfallzeit
  addDownBackdate(monitorId: number, from: number, to: number): void {
    if (to <= from) return;
    for (const [hour, s] of splitHours(from, to)) this.bucket(this.hourly, `${monitorId}:${hour}`).down_s += s;
    for (const [day, s] of splitDays(from, to, this.tz)) this.bucket(this.daily, `${monitorId}:${day}`).down_s += s;
  }

  get size(): number {
    return this.hourly.size + this.daily.size;
  }

  // Alles Gesammelte herausnehmen (für ein Schreiben; schlägt es fehl, kommt es mit merge() zurück)
  take(): { hourly: Array<[number, number, Bucket]>; daily: Array<[number, string, Bucket]> } {
    const hourly = [...this.hourly].map(([k, b]): [number, number, Bucket] => {
      const [id, hour] = k.split(':');
      return [Number(id), Number(hour), b];
    });
    const daily = [...this.daily].map(([k, b]): [number, string, Bucket] => {
      const at = k.indexOf(':');
      return [Number(k.slice(0, at)), k.slice(at + 1), b];
    });
    this.hourly.clear();
    this.daily.clear();
    return { hourly, daily };
  }

  merge(data: { hourly: Array<[number, number, Bucket]>; daily: Array<[number, string, Bucket]> }): void {
    for (const [id, hour, b] of data.hourly) mergeInto(this.bucket(this.hourly, `${id}:${hour}`), b);
    for (const [id, day, b] of data.daily) mergeInto(this.bucket(this.daily, `${id}:${day}`), b);
  }
}

function mergeInto(t: Bucket, b: Bucket): void {
  t.checks += b.checks;
  t.fails += b.fails;
  t.ms_sum += b.ms_sum;
  t.ms_count += b.ms_count;
  t.ms_min = t.ms_min === null ? b.ms_min : b.ms_min === null ? t.ms_min : Math.min(t.ms_min, b.ms_min);
  t.ms_max = t.ms_max === null ? b.ms_max : b.ms_max === null ? t.ms_max : Math.max(t.ms_max, b.ms_max);
  t.covered_s += b.covered_s;
  t.down_s += b.down_s;
  t.degraded_s += b.degraded_s;
  t.maint_s += b.maint_s;
}

// ---------------------------------------------------------------- Verfügbarkeit, Balken, Status

// 100 × (1 − Ausfall / (abgedeckt − Wartung)), abgerundet auf 2 Stellen (99,999 → 99,99); ohne Daten null („—“)
export function uptimePercent(down: number, covered: number, maint: number): number | null {
  const base = covered - maint;
  if (base <= 0) return null;
  const ratio = Math.max(0, Math.min(1, 1 - down / base));
  return Math.floor(ratio * 10000 + 1e-9) / 100;
}

export type IncidentEffect = 'major' | 'partial' | 'degraded' | 'maintenance';
export type BarColor = 'd-ok' | 'd-minor' | 'd-partial' | 'd-major' | 'd-maint' | 'd-none';

// Farbe eines Tagesbalkens: rot ≥ 30 min Ausfall oder schwerer Vorfall, orange Ausfall unter 30 min, gelb ≥ 30 min
// eingeschränkt oder ein leichter Vorfall, blau nur Wartung, grün ohne Ausfall, grau ohne Daten
export function barColor(day: Pick<Bucket, 'covered_s' | 'down_s' | 'degraded_s' | 'maint_s'> | null, incident: IncidentEffect | null = null): BarColor {
  const covered = day?.covered_s ?? 0;
  if (incident === 'major' || (day && day.down_s >= 1800)) return 'd-major';
  if (day && day.down_s > 0) return 'd-partial';
  if (incident === 'partial' || incident === 'degraded' || (day && day.degraded_s >= 1800)) return 'd-minor';
  if (covered <= 0 && incident !== 'maintenance') return 'd-none';
  if (incident === 'maintenance' || (day && day.maint_s > 0)) return 'd-maint';
  return 'd-ok';
}

export type ComponentStatus = 'operational' | 'degraded' | 'partial' | 'major' | 'maintenance' | 'unknown';

const SEVERITY: Record<ComponentStatus, number> = { unknown: 0, operational: 1, maintenance: 2, degraded: 3, partial: 4, major: 5 };

export const worse = (a: ComponentStatus, b: ComponentStatus): ComponentStatus => (SEVERITY[b] > SEVERITY[a] ? b : a);

export interface ComponentInput {
  type: string; // http | heartbeat | manual | system
  manualStatus?: string | null;
  notChecked: boolean; // pausiert (Besitzer, Team, selbst), über der Grenze, Modul pausiert, inaktiv, > 1 h 429
  state: 'unknown' | 'up' | 'degraded' | 'down';
  flapping: boolean;
  maintenance: boolean; // eine laufende Wartung deckt ihn ab
  incidentEffects: IncidentEffect[]; // Wirkungen offener Vorfälle
}

// Öffentlicher Status eines Bestandteils (Entwurf §4.8.8)
export function componentStatus(c: ComponentInput): ComponentStatus {
  let base: ComponentStatus;
  if (c.type === 'manual') {
    const m = c.manualStatus ?? '';
    base = (['operational', 'degraded', 'partial', 'major', 'maintenance'] as string[]).includes(m) ? (m as ComponentStatus) : 'unknown';
  } else if (c.notChecked) {
    base = 'unknown';
  } else {
    base = c.state === 'up' ? (c.flapping ? 'degraded' : 'operational') : c.state === 'degraded' ? 'degraded' : c.state === 'down' ? 'major' : 'unknown';
    if (c.flapping && base === 'major') base = 'degraded';
  }
  if (c.maintenance && c.type !== 'manual' && base !== 'unknown') base = 'maintenance';
  for (const e of c.incidentEffects) base = worse(base, e === 'maintenance' ? 'maintenance' : e);
  return base;
}

export const STATUS_TEXT: Record<ComponentStatus, string> = {
  operational: 'Operational',
  degraded: 'Degraded performance',
  partial: 'Partial outage',
  major: 'Major outage',
  maintenance: 'Under maintenance',
  unknown: 'Not checked right now',
};

export const INDICATOR_TEXT: Record<ComponentStatus, string> = {
  operational: 'All systems operational',
  degraded: 'Degraded performance',
  partial: 'Partial outage',
  major: 'Major outage',
  maintenance: 'Maintenance in progress',
  unknown: 'No data yet',
};

// Status der ganzen Seite aus den öffentlichen Bestandteilen
export function pageIndicator(statuses: ComponentStatus[]): ComponentStatus {
  const known = statuses.filter((s) => s !== 'unknown');
  if (!known.length) return 'unknown';
  if (known.every((s) => s === 'major')) return 'major';
  if (known.some((s) => s === 'major' || s === 'partial')) return 'partial';
  if (known.some((s) => s === 'degraded')) return 'degraded';
  if (known.some((s) => s === 'maintenance')) return 'maintenance';
  return 'operational';
}
