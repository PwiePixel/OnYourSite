// Statusseiten: Vorfälle und geplante Wartungen (Entwurf §4.6, §4.8.10). Lesen, prüfen, anlegen, ergänzen, ändern,
// löschen – für die Webseite (Besitzer bzw. Admins) und den Prüfdienst (automatische Vorfälle, Beginn und Ende von
// Wartungen). Jede Funktion arbeitet auf der Verbindung des Aufrufers (Transaktion mit gesperrter Seite); den Rest
// (rev, Discord-Beiträge) erledigt der Aufrufer bzw. syncIncidentPosts() in derselben Transaktion.
// Regel für automatische Vorfälle: schreibt der Besitzer darin, setzt dieselbe Anweisung auto_edited = 1 – der
// Prüfdienst schließt ihn dann nicht mehr selbst (seine Schreibzugriffe prüfen auto_edited = 0 und resolved_at IS NULL).
import type { Db, Row } from '../db.js';
import { cleanText } from '../helpers.js';
import { date } from '../php.js';
import { numOrNull } from './model.js';

export const INCIDENT_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'] as const;
export const MAINTENANCE_STATUSES = ['scheduled', 'in_progress', 'completed'] as const;
export const IMPACTS = ['none', 'minor', 'major', 'critical'] as const;
export const EFFECTS = ['degraded', 'partial', 'major', 'maintenance'] as const;
export type IncidentKind = 'incident' | 'maintenance';
export type Effect = (typeof EFFECTS)[number];

export const STATUS_LABEL: Readonly<Record<string, string>> = {
  investigating: 'Investigating', identified: 'Identified', monitoring: 'Monitoring', resolved: 'Resolved',
  scheduled: 'Scheduled', in_progress: 'In progress', completed: 'Completed',
};
export const IMPACT_LABEL: Readonly<Record<string, string>> = { none: 'None', minor: 'Minor', major: 'Major', critical: 'Critical', maintenance: 'Maintenance' };
export const EFFECT_LABEL: Readonly<Record<string, string>> = {
  degraded: 'Degraded performance', partial: 'Partial outage', major: 'Major outage', maintenance: 'Under maintenance',
};

export const isFinal = (status: string): boolean => status === 'resolved' || status === 'completed';
export const statusesOf = (kind: IncidentKind): readonly string[] => (kind === 'maintenance' ? MAINTENANCE_STATUSES : INCIDENT_STATUSES);

export const TITLE_MAX = 160;
export const BODY_MAX = 5000;
export const MAINTENANCE_MAX = 7 * 86400;

export interface IncidentUpdate {
  id: number;
  status: string;
  body: string;
  isAuto: boolean;
  createdAt: number;
  editedAt: number | null;
}

export interface IncidentMonitor {
  id: number;
  name: string;
  effect: Effect;
  isPublic: boolean;
}

export interface Incident {
  id: number;
  pageId: number;
  kind: IncidentKind;
  title: string;
  status: string;
  impact: string;
  isAuto: boolean;
  autoEdited: boolean;
  startsAt: number;
  endsAt: number | null;
  resolvedAt: number | null;
  notify: boolean;
  monitors: IncidentMonitor[];
  updates: IncidentUpdate[]; // älteste zuerst
}

function incidentFrom(r: Row): Incident {
  return {
    id: Number(r.id),
    pageId: Number(r.page_id),
    kind: r.kind === 'maintenance' ? 'maintenance' : 'incident',
    title: String(r.title ?? ''),
    status: String(r.status ?? ''),
    impact: String(r.impact ?? 'minor'),
    isAuto: Number(r.is_auto) === 1,
    autoEdited: Number(r.auto_edited) === 1,
    startsAt: Number(r.starts_at ?? 0),
    endsAt: numOrNull(r.ends_at),
    resolvedAt: numOrNull(r.resolved_at),
    notify: Number(r.notify ?? 1) === 1,
    monitors: [],
    updates: [],
  };
}

const COLUMNS = 'id, page_id, kind, title, status, impact, is_auto, auto_edited, starts_at, ends_at, resolved_at, notify';

// Vorfälle mit Bestandteilen und Updates. where: Bedingung auf status_incidents (ohne „WHERE“), Parameter dazu
export async function loadIncidents(db: Db, where: string, params: Array<string | number>, opts: { order?: string; limit?: number; offset?: number; updates?: 'all' | 'last' } = {}): Promise<Incident[]> {
  const limit = opts.limit ? ` LIMIT ${Math.max(1, Math.floor(opts.limit))}${opts.offset ? ` OFFSET ${Math.max(0, Math.floor(opts.offset))}` : ''}` : '';
  const rows = await db.q(`SELECT ${COLUMNS} FROM status_incidents WHERE ${where} ORDER BY ${opts.order ?? 'starts_at DESC, id DESC'}${limit}`, params);
  const list = rows.map(incidentFrom);
  if (!list.length) return list;
  const byId = new Map(list.map((i) => [i.id, i]));
  const ids = list.map((i) => i.id);
  const marks = ids.map(() => '?').join(', ');
  for (const r of await db.q(`SELECT im.incident_id, im.monitor_id, im.effect, m.name, m.is_public FROM status_incident_monitors im
      JOIN status_monitors m ON m.id = im.monitor_id WHERE im.incident_id IN (${marks}) ORDER BY m.position, m.id`, ids)) {
    const effect = (EFFECTS as readonly string[]).includes(String(r.effect)) ? (String(r.effect) as Effect) : 'partial';
    byId.get(Number(r.incident_id))?.monitors.push({ id: Number(r.monitor_id), name: String(r.name ?? ''), effect, isPublic: Number(r.is_public) === 1 });
  }
  const updates = opts.updates ?? 'all';
  const sql = updates === 'last'
    ? `SELECT u.id, u.incident_id, u.status, u.body, u.is_auto, u.created_at, u.edited_at FROM status_incident_updates u
        JOIN (SELECT incident_id, MAX(id) AS id FROM status_incident_updates WHERE incident_id IN (${marks}) GROUP BY incident_id) l ON l.id = u.id`
    : `SELECT id, incident_id, status, body, is_auto, created_at, edited_at FROM status_incident_updates WHERE incident_id IN (${marks}) ORDER BY id`;
  for (const r of await db.q(sql, ids)) {
    byId.get(Number(r.incident_id))?.updates.push({
      id: Number(r.id), status: String(r.status ?? ''), body: String(r.body ?? ''), isAuto: Number(r.is_auto) === 1,
      createdAt: Number(r.created_at ?? 0), editedAt: numOrNull(r.edited_at),
    });
  }
  return list;
}

export async function loadIncident(db: Db, pageId: number, id: number, lock = false): Promise<Incident | null> {
  if (lock) await db.q('SELECT id FROM status_incidents WHERE id = ? AND page_id = ? FOR UPDATE', [id, pageId]);
  const list = await loadIncidents(db, 'id = ? AND page_id = ?', [id, pageId]);
  return list[0] ?? null;
}

// ---------------------------------------------------------------- Eingaben prüfen

export interface MonitorChoice {
  id: number;
  effect: Effect;
}

export interface IncidentInput {
  kind: IncidentKind;
  title: string;
  status: string;
  impact: string;
  startsAt: number;
  endsAt: number | null;
  monitors: MonitorChoice[];
  body: string;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string; field: string };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const intOf = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^-?\d{1,12}$/.test(v.trim())) return Number(v.trim());
  return null;
};

export function cleanBody(v: unknown): string {
  return cleanText(typeof v === 'string' ? v : '', BODY_MAX, true);
}

// Bestandteile eines Vorfalls: nur solche dieser Seite, je einmal, mit gültiger Wirkung (Wartung: immer „maintenance“)
export function monitorChoices(raw: unknown, allowed: ReadonlySet<number>, kind: IncidentKind): Checked<MonitorChoice[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw) || raw.length > 200) return { ok: false, error: 'Please choose the affected components again.', field: 'monitors' };
  const out: MonitorChoice[] = [];
  for (const item of raw) {
    const id = intOf(isObj(item) ? item.id : item);
    if (id === null || !allowed.has(id)) return { ok: false, error: 'One of the components doesn’t belong to this status page.', field: 'monitors' };
    if (out.some((m) => m.id === id)) continue;
    let effect: Effect = kind === 'maintenance' ? 'maintenance' : 'partial';
    if (kind === 'incident' && isObj(item) && item.effect !== undefined) {
      if (!(['degraded', 'partial', 'major'] as unknown[]).includes(item.effect)) return { ok: false, error: 'Please choose how each component is affected.', field: 'monitors' };
      effect = item.effect as Effect;
    }
    out.push({ id, effect });
  }
  return { ok: true, value: out };
}

// Neuer Vorfall oder neue Wartung (mit erstem Update)
export function checkNewIncident(input: Record<string, unknown>, allowed: ReadonlySet<number>, now: number): Checked<IncidentInput> {
  const kind: IncidentKind | null = input.kind === 'maintenance' ? 'maintenance' : input.kind === undefined || input.kind === 'incident' ? 'incident' : null;
  if (kind === null) return { ok: false, error: 'Please choose an incident or a maintenance.', field: 'kind' };
  const title = cleanText(typeof input.title === 'string' ? input.title : '', TITLE_MAX);
  if (title === '') return { ok: false, error: 'Please give it a title.', field: 'title' };
  let startsAt = now;
  let endsAt: number | null = null;
  let status: string;
  let impact: string;
  if (kind === 'maintenance') {
    const s = intOf(input.starts_at);
    const e2 = intOf(input.ends_at);
    if (s === null || e2 === null) return { ok: false, error: 'Please enter when the maintenance starts and ends.', field: 'starts_at' };
    if (s < now - 3600) return { ok: false, error: 'The start can’t be in the past.', field: 'starts_at' };
    if (e2 <= s) return { ok: false, error: 'The maintenance has to end after it starts.', field: 'ends_at' };
    if (e2 - s > MAINTENANCE_MAX) return { ok: false, error: 'A maintenance can last at most 7 days.', field: 'ends_at' };
    startsAt = s;
    endsAt = e2;
    status = s <= now ? 'in_progress' : 'scheduled';
    // Eine Wartung erkennt man an kind; impact (VARCHAR(10)) bleibt 'none' – die Ausgaben zeigen „maintenance“
    impact = 'none';
  } else {
    status = typeof input.status === 'string' ? input.status : 'investigating';
    if (!(INCIDENT_STATUSES as readonly string[]).includes(status)) return { ok: false, error: 'Please choose a status.', field: 'status' };
    impact = typeof input.impact === 'string' ? input.impact : 'minor';
    if (!(IMPACTS as readonly string[]).includes(impact)) return { ok: false, error: 'Please choose the impact.', field: 'impact' };
  }
  const monitors = monitorChoices(input.monitors, allowed, kind);
  if (!monitors.ok) return monitors;
  const body = cleanBody(input.body);
  if (body === '') return { ok: false, error: kind === 'maintenance' ? 'Please write what the maintenance is about.' : 'Please write what’s going on.', field: 'body' };
  return { ok: true, value: { kind, title, status, impact, startsAt, endsAt, monitors: monitors.value, body } };
}

// ---------------------------------------------------------------- Schreiben (Webseite)

const stamp = (now: number): string => date('Y-m-d H:i:s', now);

export async function createIncident(db: Db, pageId: number, input: IncidentInput, userId: number | null, now: number, opts: { auto?: boolean } = {}): Promise<number> {
  const resolved = isFinal(input.status) ? now : null;
  const res = await db.exec(`INSERT INTO status_incidents (page_id, kind, title, status, impact, is_auto, starts_at, ends_at, resolved_at, notify, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  [pageId, input.kind, input.title, input.status, input.impact, opts.auto ? 1 : 0, input.startsAt, input.endsAt, resolved, userId, stamp(now), stamp(now)]);
  const id = res.insertId;
  for (const m of input.monitors) {
    await db.exec('INSERT IGNORE INTO status_incident_monitors (incident_id, monitor_id, effect) VALUES (?, ?, ?)', [id, m.id, m.effect]);
  }
  await db.exec('INSERT INTO status_incident_updates (incident_id, status, body, is_auto, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, input.status, input.body, opts.auto ? 1 : 0, userId, now]);
  return id;
}

// Felder ändern (Titel, Wirkung, Bestandteile, bei Wartungen Beginn und Ende). Ein automatischer Vorfall gilt danach als
// bearbeitet.
export async function editIncidentFields(db: Db, inc: Incident, input: Record<string, unknown>, allowed: ReadonlySet<number>, now: number): Promise<Checked<true>> {
  const title = input.title === undefined ? inc.title : cleanText(typeof input.title === 'string' ? input.title : '', TITLE_MAX);
  if (title === '') return { ok: false, error: 'Please give it a title.', field: 'title' };
  let impact = inc.impact;
  if (inc.kind === 'incident' && input.impact !== undefined) {
    if (!(IMPACTS as readonly unknown[]).includes(input.impact)) return { ok: false, error: 'Please choose the impact.', field: 'impact' };
    impact = String(input.impact);
  }
  let startsAt = inc.startsAt;
  let endsAt = inc.endsAt;
  if (inc.kind === 'maintenance' && (input.starts_at !== undefined || input.ends_at !== undefined)) {
    const s = input.starts_at === undefined ? inc.startsAt : intOf(input.starts_at);
    const e2 = input.ends_at === undefined ? inc.endsAt : intOf(input.ends_at);
    if (s === null || e2 === null) return { ok: false, error: 'Please enter when the maintenance starts and ends.', field: 'starts_at' };
    // Hat sie schon begonnen, bleibt der Beginn; nur das Ende lässt sich noch verschieben
    if (inc.status !== 'scheduled' && s !== inc.startsAt) return { ok: false, error: 'The maintenance has already started – only its end can change.', field: 'starts_at' };
    if (inc.status === 'scheduled' && s !== inc.startsAt && s < now - 3600) return { ok: false, error: 'The start can’t be in the past.', field: 'starts_at' };
    if (e2 <= s) return { ok: false, error: 'The maintenance has to end after it starts.', field: 'ends_at' };
    if (e2 - s > MAINTENANCE_MAX) return { ok: false, error: 'A maintenance can last at most 7 days.', field: 'ends_at' };
    if (isFinal(inc.status)) return { ok: false, error: 'This maintenance is already complete.', field: 'ends_at' };
    startsAt = s;
    endsAt = e2;
  }
  let monitors: MonitorChoice[] | null = null;
  if (input.monitors !== undefined) {
    const m = monitorChoices(input.monitors, allowed, inc.kind);
    if (!m.ok) return m;
    monitors = m.value;
  }
  await db.exec('UPDATE status_incidents SET title = ?, impact = ?, starts_at = ?, ends_at = ?, auto_edited = IF(is_auto = 1, 1, auto_edited), updated_at = ? WHERE id = ?',
    [title, impact, startsAt, endsAt, stamp(now), inc.id]);
  if (monitors !== null) {
    await db.exec('DELETE FROM status_incident_monitors WHERE incident_id = ?', [inc.id]);
    for (const m of monitors) await db.exec('INSERT INTO status_incident_monitors (incident_id, monitor_id, effect) VALUES (?, ?, ?)', [inc.id, m.id, m.effect]);
  }
  return { ok: true, value: true };
}

// Ein Update anfügen; ein abschließender Status setzt resolved_at. auto: vom Prüfdienst (ändert auto_edited nicht)
export async function addIncidentUpdate(db: Db, inc: Incident, status: string, body: string, userId: number | null, now: number, auto = false): Promise<number> {
  const res = await db.exec('INSERT INTO status_incident_updates (incident_id, status, body, is_auto, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [inc.id, status, body, auto ? 1 : 0, userId, now]);
  const resolvedAt = isFinal(status) ? (inc.resolvedAt ?? now) : null;
  await db.exec(`UPDATE status_incidents SET status = ?, resolved_at = ?, ${auto ? '' : 'auto_edited = IF(is_auto = 1, 1, auto_edited), '}updated_at = ? WHERE id = ?`,
    [status, resolvedAt, stamp(now), inc.id]);
  return res.insertId;
}

// Status und Ende folgen dem jüngsten verbliebenen Update (ein versehentliches „Resolved“ zu löschen öffnet ihn wieder)
export async function followLatestUpdate(db: Db, incidentId: number, now: number): Promise<void> {
  const last = await db.one('SELECT status, created_at FROM status_incident_updates WHERE incident_id = ? ORDER BY id DESC LIMIT 1', [incidentId]);
  if (!last) return;
  const status = String(last.status);
  await db.exec('UPDATE status_incidents SET status = ?, resolved_at = IF(? = 1, COALESCE(resolved_at, ?), NULL), auto_edited = IF(is_auto = 1, 1, auto_edited), updated_at = ? WHERE id = ?',
    [status, isFinal(status) ? 1 : 0, Number(last.created_at), stamp(now), incidentId]);
}

export async function deleteIncidentRows(db: Db, incidentId: number): Promise<void> {
  await db.exec('DELETE FROM status_incident_updates WHERE incident_id = ?', [incidentId]);
  await db.exec('DELETE FROM status_incident_monitors WHERE incident_id = ?', [incidentId]);
  await db.exec('DELETE FROM status_incidents WHERE id = ?', [incidentId]);
}

// Bestandteile einer Seite (für die Auswahl in Vorfällen)
export async function pageMonitorIds(db: Db, pageId: number): Promise<Set<number>> {
  return new Set((await db.q('SELECT id FROM status_monitors WHERE page_id = ?', [pageId])).map((r) => Number(r.id)));
}

// ---------------------------------------------------------------- Texte

// Dauer für Menschen: „40 s“, „12 min“, „2 h 5 min“, „3 days“
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.round(s / 86400);
  return d === 1 ? '1 day' : `${d} days`;
}

export const autoTexts = {
  title: (name: string): string => `${name} is unavailable`,
  several: 'Several components are unavailable',
  opened: (name: string): string => `We’re aware that ${name} isn’t responding and we’re looking into it.`,
  joined: (name: string): string => `${name} isn’t responding either.`,
  back: (name: string): string => `${name} is responding again.`,
  allBack: 'All affected components are responding again.',
  unmonitored: (name: string): string => `${name} is no longer monitored.`,
  mixedBack: 'The affected components are responding again or are no longer monitored.',
  closedUnmonitored: 'None of the affected components is monitored any more, so this incident is closed.',
  maintenanceStarted: 'The scheduled maintenance has started.',
  maintenanceDone: 'The scheduled maintenance is complete.',
};
