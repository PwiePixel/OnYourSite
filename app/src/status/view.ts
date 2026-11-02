// Statusseiten: was eine öffentliche Seite zeigt (Entwurf §4.4, §4.8.8, §5.3) – aus wenigen Abfragen zu einem
// Ansichtsmodell, das render.ts (HTML) und summary.ts (JSON) gleichermaßen benutzen. Private Bestandteile
// (is_public = 0) und versteckte eigene Bestandteile (Funktion nicht eingerichtet) kommen nie hinein.
import type { Db } from '../db.js';
import { timeZone } from '../db.js';
import { botSecret } from '../community/community.js';
import { componentStatus, barColor, pageIndicator, uptimePercent, dayKey, worse, type BarColor, type ComponentStatus, type IncidentEffect } from './aggregate.js';
import { effectiveMonitors, statusLimits } from './limits.js';
import { loadIncidents, type Incident } from './incidents.js';
import { metaJson, numOrNull, parseObject, statusPageUrl, type StatusPageRow } from './model.js';
import { statusPageSettings, statusServerConfig, statusSettings, type PageSettings } from './settings.js';
import { smtpConfigured, systemHidden } from './system.js';
import { RATE_LIMITED_AFTER } from './state.js';
import { date, wallTime, wallToUnix } from '../php.js';

export const BAR_DAYS = 90;
const DAY = 86400;
const NEW_PAGE_NOINDEX = 14 * DAY;
const CHECKER_STALE = 180;

export interface DayBar {
  day: string; // YYYY-MM-DD (Zeitzone der Seite)
  color: BarColor;
  label: string; // für title und aria-label
}

export interface ComponentView {
  id: number;
  name: string;
  description: string;
  group: string;
  type: string;
  key: string; // eigene Bestandteile: Schlüssel der Prüfung (web, db …), sonst ''
  status: ComponentStatus;
  uptime: number | null; // 90 Tage
  bars: DayBar[];
  spark: number[]; // Antwortzeiten der letzten 24 Stunden (ms je Stunde, 0 = keine Daten)
  updatedAt: number | null;
  stale: boolean; // der Prüfdienst meldet sich nicht – letzter bekannter Stand, ausgegraut
}

export interface IncidentView extends Incident {
  affected: string[]; // öffentliche Bestandteile
}

export interface PageView {
  page: StatusPageRow;
  settings: PageSettings;
  url: string;
  indicator: ComponentStatus;
  components: ComponentView[];
  active: IncidentView[]; // offene Vorfälle und laufende Wartungen
  upcoming: IncidentView[]; // geplante Wartungen
  past: IncidentView[]; // abgeschlossen in den letzten history_days Tagen
  gate: { state: string; since: number | null };
  checker: { stale: boolean; at: number | null };
  modulePaused: boolean; // Prüfungen der Nutzer ruhen (Notschalter) – nur Seiten von Nutzern
  generatedAt: number;
  updatedAt: number | null;
  noindex: boolean;
  dbDown: number | null; // seit wann die Datenbank fehlt (nur in der Notfall-Ausgabe)
}

const isoDay = (t: number, tz: string): string => dayKey(t, tz);

// Die letzten n Tage (ältester zuerst) als YYYY-MM-DD in der Zeitzone der Seite, mit Beginn (Unix)
export function lastDays(now: number, n: number, tz: string): Array<{ day: string; start: number; end: number }> {
  const w = wallTime(now, tz);
  const out: Array<{ day: string; start: number; end: number }> = [];
  for (let i = n - 1; i >= 0; i--) {
    const start = wallToUnix(w.year, w.month, w.day - i, 0, 0, 0, tz);
    const end = wallToUnix(w.year, w.month, w.day - i + 1, 0, 0, 0, tz);
    out.push({ day: isoDay(start + 3600, tz), start, end });
  }
  return out;
}

let factsCache: { at: number; smtp: boolean } | null = null;
function smtpNow(): boolean {
  const now = Date.now();
  if (!factsCache || now - factsCache.at > 60_000) factsCache = { at: now, smtp: smtpConfigured() };
  return factsCache.smtp;
}

export function resetViewFactsForTests(): void {
  factsCache = null;
}

// Wirkung offener Vorfälle je Bestandteil (schwerste gewinnt)
function effectsOf(incidents: Incident[]): Map<number, IncidentEffect[]> {
  const out = new Map<number, IncidentEffect[]>();
  for (const inc of incidents) {
    if (inc.kind === 'maintenance' && inc.status !== 'in_progress') continue;
    for (const m of inc.monitors) {
      const list = out.get(m.id) ?? [];
      list.push(inc.kind === 'maintenance' ? 'maintenance' : m.effect);
      out.set(m.id, list);
    }
  }
  return out;
}

const SEVERITY: Record<IncidentEffect, number> = { maintenance: 1, degraded: 2, partial: 3, major: 4 };

export async function loadPageView(db: Db, page: StatusPageRow, now = Math.floor(Date.now() / 1000)): Promise<PageView> {
  const tz = timeZone();
  const settings = statusPageSettings({ settings: page.settings, is_system: page.isSystem ? 1 : 0 });
  const module = await statusSettings(db);
  const rows = await db.q(`SELECT m.id, m.type, m.name, m.description, m.group_name, m.position, m.is_public, m.target, m.interval_s, m.manual_status,
        m.is_paused, m.admin_paused, m.auto_paused, s.state, s.since, s.flapping, s.last_check_at, s.refused_since
      FROM status_monitors m LEFT JOIN status_state s ON s.monitor_id = m.id WHERE m.page_id = ? ORDER BY m.position, m.id`, [page.id]);
  // Grenzen (über der Grenze = „Not checked right now“) – für Nutzer erst mit der Freischaltung
  const limits = await statusLimits(page.isSystem ? null : page.userId, db);
  const eff = new Map(effectiveMonitors(rows.map((r) => ({ id: Number(r.id), type: String(r.type), position: Number(r.position ?? 0), interval_s: Number(r.interval_s ?? 300) })), limits)
    .map((e) => [e.id, e]));
  const jobs = await db.value("SELECT meta_value FROM oys_meta WHERE meta_key = 'jobs'");
  const facts = { botSecret: botSecret() !== '', smtp: smtpNow(), tunnel: statusServerConfig().tunnel };
  const visible = rows.filter((r) => Number(r.is_public) === 1 && !(r.type === 'system' && systemHidden(String(r.target), facts, typeof jobs === 'string' && jobs !== '')));

  // Vorfälle: offen, geplant, kürzlich abgeschlossen und die der letzten 90 Tage (Farben der Balken)
  const since90 = now - BAR_DAYS * DAY;
  const incidents = await loadIncidents(db, 'page_id = ? AND (resolved_at IS NULL OR resolved_at >= ?)', [page.id, since90], { order: 'starts_at DESC, id DESC', limit: 500 });
  const open = incidents.filter((i) => i.resolvedAt === null && !(i.kind === 'maintenance' && i.status === 'scheduled'));
  const effects = effectsOf(open);
  const maintenanceNow = new Set<number>();
  for (const i of open) if (i.kind === 'maintenance' && i.status === 'in_progress') for (const m of i.monitors) maintenanceNow.add(m.id);

  // Prüfdienst, Plattform-Sperre
  const worker = await metaJson(db, 'status_worker');
  const gateMeta = await metaJson(db, 'status_gate');
  const workerAt = numOrNull(worker?.at);
  const checkerStale = workerAt === null || now - workerAt > CHECKER_STALE;
  const gate = { state: typeof gateMeta?.state === 'string' ? gateMeta.state : 'ok', since: numOrNull(gateMeta?.since) };
  const modulePaused = !page.isSystem && !module.run_user_checks;

  // Tagessummen der letzten 90 Tage und Antwortzeiten der letzten 24 Stunden
  const ids = visible.map((r) => Number(r.id));
  const days = lastDays(now, BAR_DAYS, tz);
  const daily = new Map<string, { covered_s: number; down_s: number; degraded_s: number; maint_s: number }>();
  const hourly = new Map<string, number>();
  if (ids.length) {
    const marks = ids.map(() => '?').join(', ');
    for (const d of await db.q(`SELECT monitor_id, day, covered_s, down_s, degraded_s, maint_s FROM status_daily WHERE monitor_id IN (${marks}) AND day >= ?`, [...ids, days[0].day])) {
      daily.set(`${Number(d.monitor_id)}:${String(d.day).slice(0, 10)}`, { covered_s: Number(d.covered_s), down_s: Number(d.down_s), degraded_s: Number(d.degraded_s), maint_s: Number(d.maint_s) });
    }
    if (settings.show_response) {
      const from = Math.floor(now / 3600) * 3600 - 23 * 3600;
      for (const h of await db.q(`SELECT monitor_id, hour, ms_sum, ms_count FROM status_hourly WHERE monitor_id IN (${marks}) AND hour >= ?`, [...ids, from])) {
        const count = Number(h.ms_count);
        if (count > 0) hourly.set(`${Number(h.monitor_id)}:${Number(h.hour)}`, Math.round(Number(h.ms_sum) / count));
      }
    }
  }
  // Wirkung von Vorfällen je Bestandteil und Tag (auch abgeschlossene; geplante Wartungen zählen erst, wenn sie liefen)
  const dayEffect = new Map<string, IncidentEffect>();
  const dayIncidents = new Map<string, number>();
  for (const inc of incidents) {
    if (inc.kind === 'maintenance' && inc.status === 'scheduled') continue;
    const from = inc.startsAt;
    const to = inc.resolvedAt ?? now;
    for (const d of days) {
      if (d.end <= from || d.start > to) continue;
      for (const m of inc.monitors) {
        const key = `${m.id}:${d.day}`;
        const effect: IncidentEffect = inc.kind === 'maintenance' ? 'maintenance' : m.effect;
        const prev = dayEffect.get(key);
        if (!prev || SEVERITY[effect] > SEVERITY[prev]) dayEffect.set(key, effect);
        if (inc.kind === 'incident') dayIncidents.set(key, (dayIncidents.get(key) ?? 0) + 1);
      }
    }
  }

  const components: ComponentView[] = [];
  let updatedAt: number | null = null;
  for (const r of visible) {
    const id = Number(r.id);
    const type = String(r.type);
    const e = eff.get(id);
    const refused = numOrNull(r.refused_since);
    const paused = Number(r.is_paused) === 1 || Number(r.admin_paused) === 1 || (r.auto_paused !== null && r.auto_paused !== '');
    const notChecked = type !== 'manual' && (paused || !!e?.overLimit || modulePaused || (refused !== null && now - refused > RATE_LIMITED_AFTER) || page.blocked);
    const state = (['up', 'degraded', 'down'].includes(String(r.state)) ? String(r.state) : 'unknown') as 'unknown' | 'up' | 'degraded' | 'down';
    const status = componentStatus({
      type, manualStatus: r.manual_status === null ? null : String(r.manual_status), notChecked, state, flapping: Number(r.flapping) === 1,
      maintenance: maintenanceNow.has(id), incidentEffects: effects.get(id) ?? [],
    });
    let down = 0;
    let covered = 0;
    let maint = 0;
    const bars: DayBar[] = days.map((d) => {
      const b = daily.get(`${id}:${d.day}`) ?? null;
      if (b) {
        down += b.down_s;
        covered += b.covered_s;
        maint += b.maint_s;
      }
      const effect = dayEffect.get(`${id}:${d.day}`) ?? null;
      const color = barColor(b, effect);
      return { day: d.day, color, label: barLabel(d.start, b, dayIncidents.get(`${id}:${d.day}`) ?? 0, color, settings.show_uptime) };
    });
    const spark: number[] = [];
    if (settings.show_response) {
      const from = Math.floor(now / 3600) * 3600 - 23 * 3600;
      for (let h = 0; h < 24; h++) spark.push(hourly.get(`${id}:${from + h * 3600}`) ?? 0);
    }
    const checked = numOrNull(r.last_check_at);
    if (checked !== null && (updatedAt === null || checked > updatedAt)) updatedAt = checked;
    components.push({
      id, name: String(r.name ?? ''), description: String(r.description ?? ''), group: String(r.group_name ?? ''), type,
      key: type === 'system' ? String(r.target ?? '') : '', status,
      // „Show uptime“ aus: keine Zahl auf der Seite und in summary.json
      uptime: settings.show_uptime ? uptimePercent(down, covered, maint) : null, bars, spark, updatedAt: checked, stale: checkerStale && type !== 'manual',
    });
  }

  const withAffected = (i: Incident): IncidentView => ({ ...i, affected: i.monitors.filter((m) => m.isPublic).map((m) => m.name) });
  const historyFrom = now - settings.history_days * DAY;
  const created = page.createdAt ? Date.parse(page.createdAt.replace(' ', 'T') + 'Z') / 1000 : null;
  const noindex = settings.noindex || (!page.isSystem && (created === null || now - created < NEW_PAGE_NOINDEX))
    || (page.reviewNote !== '' && page.reviewedAt === null);
  return {
    page,
    settings,
    url: statusPageUrl(page.slug),
    indicator: pageIndicator(components.map((c) => c.status)),
    components,
    active: open.map(withAffected).sort((a, b) => b.startsAt - a.startsAt),
    upcoming: incidents.filter((i) => i.kind === 'maintenance' && i.status === 'scheduled' && i.resolvedAt === null).map(withAffected).sort((a, b) => a.startsAt - b.startsAt),
    past: incidents.filter((i) => i.resolvedAt !== null && i.resolvedAt >= historyFrom).map(withAffected),
    gate,
    checker: { stale: checkerStale, at: workerAt },
    modulePaused,
    generatedAt: now,
    updatedAt,
    noindex,
    dbDown: null,
  };
}

// „Nov 1, 2026: 99.2% uptime, 12 min down, 1 incident“
function barLabel(start: number, b: { covered_s: number; down_s: number; maint_s: number } | null, incidents: number, color: BarColor, showUptime = true): string {
  const day = date('M j, Y', start + 3600);
  if (!b || b.covered_s <= 0) return incidents ? `${day}: no data, ${incidents} ${incidents === 1 ? 'incident' : 'incidents'}` : `${day}: no data`;
  // Ohne „Show uptime“ nur der Tag (und was an ihm war)
  const parts = [showUptime ? `${day}: ${(uptimePercent(b.down_s, b.covered_s, b.maint_s) ?? 100).toFixed(2).replace(/\.?0+$/, '')}% uptime` : day];
  if (b.down_s > 0) parts.push(`${Math.max(1, Math.round(b.down_s / 60))} min down`);
  if (b.maint_s > 0 || color === 'd-maint') parts.push('maintenance');
  if (incidents) parts.push(`${incidents} ${incidents === 1 ? 'incident' : 'incidents'}`);
  return parts.join(', ');
}

// Statusseite einer Seite für die Notfall-Ausgabe (Datenbank weg): OnYourSites Seite zeigt Website und Datenbank als
// „Major outage“ – die Hauptseite antwortet in diesem Moment mit 503
export function dbDownView(view: PageView, since: number): PageView {
  const out: PageView = { ...view, dbDown: since, components: view.components.map((c) => ({ ...c })) };
  if (view.page.isSystem) {
    for (const c of out.components) if (c.key === 'web' || c.key === 'db') c.status = 'major';
    out.indicator = 'major';
  }
  return out;
}

// Ein Bestandteil-Status als Schwere, für die Sortierung von Gruppen
export const groupStatus = (list: ComponentView[]): ComponentStatus => list.reduce<ComponentStatus>((acc, c) => worse(acc, c.status), 'unknown');

export { parseObject };
