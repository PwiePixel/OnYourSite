// Statusseiten im Editor: /dashboard/api/status* (Entwurf §4.6). Der Vorspann von editorApi.ts ist schon gelaufen
// (Anmeldung 401, CSRF 419 bei POST, kaputtes JSON 400); jede Antwort ist JSON ohne Zwischenspeicher.
// Bereich (scope): „system“ (Text im JSON oder ?scope=system) = OnYourSites eigene Seite – nur für Admins, nicht im
// Admin-Modus (ein Admin, der als Nutzer angemeldet ist, IST dieser Nutzer) → sonst 403 „Not allowed.“. Die eigene
// Statusseite eines Kontos kommt mit der Freischaltung im Shop (ST-4); bis dahin antwortet der Nutzer-Bereich mit
// „Unlock status pages with honeycombs first.“.
// Jede Änderung an Seite, Bestandteilen oder Vorfällen läuft in einer Transaktion mit gesperrter Seite und erhöht
// rev/status_rev (der Prüfdienst gleicht dann binnen 5 s ab, die öffentliche Seite zeigt es sofort).
import type { Ctx } from '../web/ctx.js';
import { transaction, withConnection, type Db, type Row } from '../db.js';
import { rateLimit } from '../web/security.js';
import { adminMode } from '../honeycombs/shop.js';
import { intval, phpTruthy } from '../php.js';
import { cleanText } from '../helpers.js';
import { report } from '../discord/botReport.js';
import { INDICATOR_TEXT } from './aggregate.js';
import { ALERT_EVENTS, statusPageSettings, statusServerConfig, statusSettings, type AlertEvent } from './settings.js';
import { statusLimits } from './limits.js';
import { runtimePolicy } from './policy.js';
import { PublicResolver } from './resolver.js';
import { bumpRev, lockStatusPage, metaJson, numOrNull, slugTaken, statusPageUrl, systemStatusPage, type StatusPageRow } from './model.js';
import {
  capacityProblem, checkDns, checkMonitorInput, checkSite, loadMonitorRows, maintenanceMonitors, monitorViews, newHeartbeatToken, stamp, MANUAL_STATUSES,
} from './monitors.js';
import {
  addIncidentUpdate, checkNewIncident, cleanBody, createIncident, deleteIncidentRows, editIncidentFields, followLatestUpdate, isFinal, loadIncident,
  loadIncidents, pageMonitorIds, statusesOf, STATUS_LABEL, type Incident,
} from './incidents.js';
import { alertsChannelProblem, botChannels, pagePostable, postableChannel, removeIncidentPosts, syncIncidentPosts, STATUS_FEATURE } from './posts.js';
import { statusPreviewToken } from './routes.js';
import { alertMessage, type AlertPayload } from './alerts.js';
import { loadPageView } from './view.js';

type Input = Record<string, unknown>;
const NOT_ALLOWED = { ok: false, error: 'Not allowed.' };
const LOCKED = { ok: false, error: 'Unlock status pages with honeycombs first.' };
const GONE = { ok: false, error: 'This component no longer exists. Please reload.' };

// Öffentliche Resolver für die Probe beim Speichern (Tests setzen einen eigenen)
let resolver: PublicResolver | null = null;
export function setStatusResolverForTests(r: PublicResolver | null): void {
  resolver = r;
}
function dnsResolver(): PublicResolver {
  resolver ??= new PublicResolver({ servers: statusServerConfig().dns });
  return resolver;
}

const now = (): number => Math.floor(Date.now() / 1000);

function scopeOf(ctx: Ctx, input: Input): 'system' | 'user' {
  return input.scope === 'system' || ctx.get.scope === 'system' ? 'system' : 'user';
}

// Darf dieser Nutzer OnYourSites eigene Seite verwalten? Admin – aber nicht im Admin-Modus
export function statusAdmin(ctx: Ctx, user: Row): boolean {
  return phpTruthy(user.is_admin) && !adminMode(ctx);
}

export async function statusEditorApi(ctx: Ctx, user: Row, action: string, isPost: boolean, raw: unknown): Promise<void> {
  const input: Input = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Input) : {};
  const scope = scopeOf(ctx, input);
  if (scope !== 'system') ctx.json(LOCKED, 403);
  if (!statusAdmin(ctx, user)) ctx.json(NOT_ALLOWED, 403);
  const page = await withConnection((db) => systemStatusPage(db));
  if (!page) ctx.json({ ok: false, error: 'OnYourSite’s status page doesn’t exist yet – the database update hasn’t run.' }, 404);
  const uid = intval(user.id);
  const reads: Record<string, () => Promise<never>> = {
    'status': () => stateOf(ctx, page),
    'status-monitors': () => monitorsOf(ctx, page),
    'status-monitor': () => monitorDetail(ctx, page, intval(ctx.get.id ?? 0)),
    'status-incidents': () => incidentsOf(ctx, page, intval(ctx.get.before ?? 0)),
    'status-alerts': () => alertsOf(ctx, page),
  };
  if (Object.hasOwn(reads, action)) await reads[action]();
  if (!isPost) ctx.json({ ok: false, error: 'Unknown action.' }, 404);
  switch (action) {
    case 'status-page': return savePage(ctx, page, input);
    case 'status-monitor-save': return saveMonitor(ctx, page, uid, input);
    case 'status-monitor-delete': return deleteMonitor(ctx, page, intval(input.id ?? 0));
    case 'status-monitor-pause': return pauseMonitor(ctx, page, intval(input.id ?? 0), input.paused === true);
    case 'status-monitor-order': return orderMonitors(ctx, page, input.ids);
    case 'status-monitor-run': return runMonitor(ctx, page, uid, intval(input.id ?? 0));
    case 'status-monitor-token': return newToken(ctx, page, intval(input.id ?? 0));
    case 'status-monitor-manual': return setManual(ctx, page, intval(input.id ?? 0), input.status);
    case 'status-incident-save': return saveIncident(ctx, page, uid, input);
    case 'status-incident-update': return addUpdate(ctx, page, uid, input);
    case 'status-incident-edit': return editUpdate(ctx, page, input);
    case 'status-incident-delete': return deleteIncident(ctx, page, intval(input.id ?? 0));
    case 'status-alerts-owner': return saveAlerts(ctx, page, input);
    case 'status-bot-channels': return saveBotChannels(ctx, page, input);
  }
  ctx.json({ ok: false, error: 'Unknown action.' }, 404);
}

// ---------------------------------------------------------------- Lesen

async function stateOf(ctx: Ctx, page: StatusPageRow): Promise<never> {
  const t = now();
  const out = await withConnection(async (db) => {
    const view = await loadPageView(db, page, t);
    const settings = statusPageSettings({ settings: page.settings, is_system: 1 });
    const module = await statusSettings(db);
    const limits = await statusLimits(null, db);
    const ids = view.components.map((c) => c.id);
    let uptime30: number | null = null;
    let avgMs: number | null = null;
    if (ids.length) {
      const from = new Date((t - 30 * 86400) * 1000).toISOString().slice(0, 10);
      const sums = await db.one(`SELECT SUM(down_s) AS down_s, SUM(covered_s) AS covered_s, SUM(maint_s) AS maint_s, SUM(ms_sum) AS ms_sum, SUM(ms_count) AS ms_count
          FROM status_daily WHERE monitor_id IN (${ids.map(() => '?').join(', ')}) AND day >= ?`, [...ids, from]);
      const covered = Number(sums?.covered_s ?? 0);
      const base = covered - Number(sums?.maint_s ?? 0);
      if (base > 0) uptime30 = Math.floor((1 - Math.min(1, Number(sums?.down_s ?? 0) / base)) * 10000) / 100;
      const count = Number(sums?.ms_count ?? 0);
      if (count > 0) avgMs = Math.round(Number(sums?.ms_sum ?? 0) / count);
    }
    const worker = await metaJson(db, 'status_worker');
    const notifier = await metaJson(db, 'status_notify');
    const clash = await slugTaken(db, page.slug);
    return {
      ok: true,
      scope: 'system',
      page: {
        id: page.id, slug: page.slug, title: page.title, description: page.description, url: statusPageUrl(page.slug), online: page.published,
        preview: page.published ? '' : statusPageUrl(page.slug, '/?preview=' + statusPreviewToken(page)),
        clash,
        status: view.indicator, statusText: INDICATOR_TEXT[view.indicator],
        settings: { show_uptime: settings.show_uptime, show_response: settings.show_response, history_days: settings.history_days, auto_incident: settings.auto_incident },
        kpis: { uptime30, avgMs, openIncidents: view.active.filter((i) => i.kind === 'incident').length, components: view.components.length },
      },
      limits: { checks: limits.checks, components: limits.components, minInterval: limits.minInterval, intervals: module.intervals, timeoutMax: module.timeout_max },
      gate: view.gate,
      worker: { ok: !view.checker.stale, at: numOrNull(worker?.at) },
      notifier: { ok: numOrNull(notifier?.at) !== null && t - Number(notifier?.at) <= 180, at: numOrNull(notifier?.at) },
    };
  });
  ctx.json(out);
}

async function monitorsOf(ctx: Ctx, page: StatusPageRow): Promise<never> {
  const out = await withConnection(async (db) => {
    const rows = await loadMonitorRows(db, page.id);
    const limits = await statusLimits(null, db);
    const monitors = await monitorViews(db, rows, limits, await maintenanceMonitors(db, page.id));
    const worker = await metaJson(db, 'status_worker');
    const gate = await metaJson(db, 'status_gate');
    const workerAt = numOrNull(worker?.at);
    return {
      ok: true,
      monitors,
      usage: { checks: rows.filter((r) => r.type === 'http' || r.type === 'heartbeat').length, checksMax: limits.checks, components: rows.length, componentsMax: limits.components },
      worker: { ok: workerAt !== null && now() - workerAt <= 180, since: numOrNull(worker?.started) },
      gate: { state: typeof gate?.state === 'string' ? gate.state : 'ok', since: numOrNull(gate?.since) },
    };
  });
  ctx.json(out);
}

async function monitorDetail(ctx: Ctx, page: StatusPageRow, id: number): Promise<never> {
  const out = await withConnection(async (db) => {
    const rows = await loadMonitorRows(db, page.id);
    const row = rows.find((r) => Number(r.id) === id);
    if (!row) return null;
    const limits = await statusLimits(null, db);
    const [monitor] = (await monitorViews(db, rows, limits, await maintenanceMonitors(db, page.id))).filter((m) => m.id === id);
    const t = now();
    const checks = (await db.q('SELECT at, ok, ms, code, error FROM status_checks WHERE monitor_id = ? ORDER BY at DESC LIMIT 50', [id]))
      .map((c) => ({ at: Number(c.at), ok: Number(c.ok) === 1, ms: numOrNull(c.ms), code: numOrNull(c.code), error: c.error === null ? null : String(c.error) }));
    const hourly = (await db.q('SELECT hour, ms_sum, ms_count, ms_min, ms_max, covered_s, down_s, maint_s FROM status_hourly WHERE monitor_id = ? AND hour >= ? ORDER BY hour', [id, Math.floor(t / 3600) * 3600 - 47 * 3600]))
      .map((h) => ({
        hour: Number(h.hour), avg: Number(h.ms_count) > 0 ? Math.round(Number(h.ms_sum) / Number(h.ms_count)) : null, min: numOrNull(h.ms_min), max: numOrNull(h.ms_max),
        uptime: Number(h.covered_s) - Number(h.maint_s) > 0 ? Math.floor((1 - Number(h.down_s) / (Number(h.covered_s) - Number(h.maint_s))) * 10000) / 100 : null,
      }));
    const events = (await db.q('SELECT at, kind, error, code FROM status_events WHERE monitor_id = ? AND at >= ? ORDER BY id DESC LIMIT 50', [id, t - 90 * 86400]))
      .map((ev) => ({ at: Number(ev.at), kind: String(ev.kind), error: ev.error === null ? null : String(ev.error), code: numOrNull(ev.code) }));
    return { ok: true, monitor, checks, hourly, events };
  });
  if (!out) ctx.json(GONE, 404);
  ctx.json(out);
}

function incidentJson(inc: Incident, posts: Row[] = []): Record<string, unknown> {
  return {
    id: inc.id, kind: inc.kind, title: inc.title, status: inc.status, statusLabel: STATUS_LABEL[inc.status] ?? inc.status, impact: inc.impact,
    isAuto: inc.isAuto, startsAt: inc.startsAt, endsAt: inc.endsAt, resolvedAt: inc.resolvedAt,
    monitors: inc.monitors.map((m) => ({ id: m.id, name: m.name, effect: m.effect })),
    updates: inc.updates.map((u) => ({ id: u.id, status: u.status, body: u.body, isAuto: u.isAuto, createdAt: u.createdAt, editedAt: u.editedAt })),
    discord: posts.filter((p) => Number(p.incident_id) === inc.id).map((p) => ({ state: String(p.state), error: String(p.error ?? '') })),
  };
}

async function postsOf(db: Db, ids: number[]): Promise<Row[]> {
  if (!ids.length) return [];
  return db.q(`SELECT incident_id, state, error FROM status_incident_posts WHERE incident_id IN (${ids.map(() => '?').join(', ')})`, ids);
}

async function incidentsOf(ctx: Ctx, page: StatusPageRow, before: number): Promise<never> {
  const out = await withConnection(async (db) => {
    const open = await loadIncidents(db, "page_id = ? AND resolved_at IS NULL AND NOT (kind = 'maintenance' AND status = 'scheduled')", [page.id], { order: 'starts_at DESC, id DESC' });
    const upcoming = await loadIncidents(db, "page_id = ? AND kind = 'maintenance' AND status = 'scheduled' AND resolved_at IS NULL", [page.id], { order: 'starts_at, id' });
    const past = await loadIncidents(db, `page_id = ? AND resolved_at IS NOT NULL${before > 0 ? ' AND id < ?' : ''}`, before > 0 ? [page.id, before] : [page.id], { order: 'id DESC', limit: 21 });
    const posts = await postsOf(db, [...open, ...upcoming, ...past].map((i) => i.id));
    const bot = await botChannels(db, page.settings);
    return {
      ok: true,
      open: open.map((i) => incidentJson(i, posts)),
      upcoming: upcoming.map((i) => incidentJson(i, posts)),
      past: past.slice(0, 20).map((i) => incidentJson(i, posts)),
      more: past.length > 20,
      // Der Schalter „Post to Discord“ nur, solange die Seite erreichbar ist (offline wird nichts gepostet)
      discord: bot.supported && bot.statusChannel !== '' && (await pagePostable(db, page)),
    };
  });
  ctx.json(out);
}

async function alertsOf(ctx: Ctx, page: StatusPageRow): Promise<never> {
  ctx.json(await withConnection((db) => alertsState(db, page)));
}

async function alertsState(db: Db, page: StatusPageRow): Promise<Record<string, unknown>> {
  const fresh = (await systemStatusPage(db)) ?? page;
  const s = statusPageSettings({ settings: fresh.settings, is_system: 1 });
  const ch = await botChannels(db, fresh.settings);
  const rep = ch.report;
  const choices = (rep?.channels ?? []).filter((c) => c.type !== 'forum').map((c) => ({ id: c.id, name: c.name, canPost: c.can_post, type: c.type }));
  const recent = (await db.q("SELECT id, monitor_id, channel, event, state, error, payload, created_at, sent_at FROM status_outbox WHERE page_id = ? AND kind IN ('alert', 'muted') ORDER BY id DESC LIMIT 20", [fresh.id]))
    .map((r) => {
      let title = '';
      try {
        title = alertMessage(JSON.parse(String(r.payload)) as AlertPayload).title;
      } catch {
        title = String(r.event);
      }
      return { id: Number(r.id), channel: String(r.channel), event: String(r.event), state: String(r.state), error: String(r.error ?? ''), title, at: Number(r.created_at), sentAt: numOrNull(r.sent_at) };
    });
  const admins = Number(await db.value('SELECT COUNT(*) FROM users WHERE is_admin = 1'));
  return {
    ok: true,
    admins: { enabled: s.alerts.admins, events: s.alerts.events, count: admins },
    bot: {
      installed: ch.installed, supported: ch.supported, ready: ch.ready, reportedAt: ch.reportedAt, version: ch.version,
      statusChannel: ch.statusChannel, alertsChannel: ch.alertsChannel, alertsNote: ch.alertsNote, saved: ch.saved,
      suggested: { status: rep?.status_channel_id ?? '', alerts: rep?.alerts_channel_id ?? '' }, choices,
    },
    recent,
  };
}

// ---------------------------------------------------------------- Seite

async function savePage(ctx: Ctx, page: StatusPageRow, input: Input): Promise<never> {
  const res = await transaction(async (_conn, db) => {
    if (!(await lockStatusPage(db, page.id))) return { ok: false, error: 'This status page no longer exists.' };
    const cur = (await systemStatusPage(db))!;
    const raw: Record<string, unknown> = cur.settings ? (JSON.parse(cur.settings) as Record<string, unknown>) : {};
    let title = cur.title;
    let description = cur.description;
    if (input.title !== undefined) {
      title = cleanText(input.title, 120);
      if (title === '') return { ok: false, error: 'Please give the page a name.', field: 'title' };
    }
    if (input.description !== undefined) description = cleanText(input.description, 300);
    const bool = (k: 'show_uptime' | 'show_response'): void => {
      if (typeof input[k] === 'boolean') raw[k] = input[k];
    };
    bool('show_uptime');
    bool('show_response');
    if (input.history_days !== undefined) {
      const d = Number(input.history_days);
      if (!Number.isInteger(d) || d < 0 || d > 30) return { ok: false, error: 'Past incidents can show 0 to 30 days.', field: 'history_days' };
      raw.history_days = d;
    }
    if (input.auto_incident !== undefined) {
      const a = Number(input.auto_incident);
      if (![0, 300, 900].includes(a)) return { ok: false, error: 'Please choose when an incident opens by itself.', field: 'auto_incident' };
      raw.auto_incident = a;
    }
    let published = cur.published;
    if (typeof input.online === 'boolean') {
      if (input.online && !cur.published) {
        if (await slugTaken(db, cur.slug)) return { ok: false, error: `The address ${cur.slug} is used by another page – decide what to do before publishing.`, field: 'online' };
      }
      published = input.online;
    }
    await db.exec('UPDATE status_pages SET title = ?, description = ?, settings = ?, is_published = ? WHERE id = ?',
      [title, description, JSON.stringify(raw), published ? 1 : 0, cur.id]);
    await bumpRev(db, cur.id);
    return { ok: true };
  });
  if (!res.ok) ctx.json(res);
  const fresh = await withConnection((db) => systemStatusPage(db));
  return stateOf(ctx, fresh ?? page);
}

// ---------------------------------------------------------------- Bestandteile

async function saveMonitor(ctx: Ctx, page: StatusPageRow, uid: number, input: Input): Promise<never> {
  if (!(await rateLimit('statussave:' + uid, 60, 3600))) ctx.json({ ok: false, error: 'You’re changing checks very often – please wait a bit.' });
  const id = intval(input.id ?? 0);
  const settings = await statusSettings();
  const limits = await statusLimits(null);
  const policy = runtimePolicy(settings, statusServerConfig());
  const existing = id > 0 ? (await withConnection((db) => db.one('SELECT * FROM status_monitors WHERE id = ? AND page_id = ?', [id, page.id]))) : null;
  if (id > 0 && !existing) ctx.json(GONE, 404);
  const checked = checkMonitorInput(input, existing, { settings, limits, policy });
  if (!checked.ok) ctx.json(checked);
  const w = checked.value;
  let warning: string | undefined;
  // Netz (Namensauflösung) nie in einer Transaktion
  if (w.type === 'http' && checked.url && checked.url.ok && (!existing || existing.target !== w.target)) {
    const dns = await checkDns(w, checked.url.port, { resolver: dnsResolver(), policy });
    if (!dns.ok) ctx.json(dns);
    warning = dns.warning;
  }
  const rules = (await withConnection((db) => db.q('SELECT host, rule, max_monitors, note FROM status_host_rules'))).map((r) => ({
    host: String(r.host), rule: r.rule === 'allow' ? 'allow' as const : 'block' as const, max_monitors: numOrNull(r.max_monitors), note: String(r.note ?? ''),
  }));
  const t = now();
  const res = await transaction(async (_conn, db) => {
    if (!(await lockStatusPage(db, page.id))) return { ok: false, error: 'This status page no longer exists.' };
    const cap = await capacityProblem(db, page.id, w.type, !existing, { settings, limits });
    if (cap) return { ok: false, ...cap };
    if (w.type === 'http' && checked.url && checked.url.ok) {
      const site = await checkSite(db, w, existing ? Number(existing.id) : 0, { settings, limits, policy, resolver: dnsResolver(), rules, now: t }, checked.url.path);
      if (!site.ok) return site;
    }
    let monitorId = existing ? Number(existing.id) : 0;
    if (existing) {
      await db.exec(`UPDATE status_monitors SET name = ?, description = ?, group_name = ?, is_public = ?, target = ?, target_host = ?, target_domain = ?, config = ?,
          interval_s = ?, manual_status = ?, manual_since = IF(manual_status <=> ?, manual_since, ?), changed_at = ?, updated_at = ? WHERE id = ?`,
      [w.name, w.description, w.group, w.isPublic ? 1 : 0, w.target, w.host, w.domain || (existing.target_domain as string ?? ''), JSON.stringify(w.config), w.interval,
        w.manualStatus, w.manualStatus, t, t, stamp(t), monitorId]);
    } else {
      const pos = Number(await db.value('SELECT COALESCE(MAX(position), -1) + 1 FROM status_monitors WHERE page_id = ?', [page.id]));
      const hb = w.type === 'heartbeat' ? newHeartbeatToken() : null;
      const ins = await db.exec(`INSERT INTO status_monitors (page_id, user_id, type, name, description, group_name, position, is_public, target, target_host, target_domain,
          config, interval_s, manual_status, manual_since, hb_token_hash, hb_token_enc, changed_at, created_at, updated_at)
          VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [page.id, w.type, w.name, w.description, w.group, pos, w.isPublic ? 1 : 0, w.target, w.host, w.domain, JSON.stringify(w.config), w.interval, w.manualStatus,
        w.manualStatus === null ? null : t, hb?.hash ?? null, hb?.enc ?? null, t, stamp(t), stamp(t)]);
      monitorId = ins.insertId;
    }
    await bumpRev(db, page.id, t);
    return { ok: true, id: monitorId };
  });
  if (!res.ok) ctx.json(res);
  return monitorResult(ctx, page, (res as { id: number }).id, warning);
}

async function monitorResult(ctx: Ctx, page: StatusPageRow, id: number, warning?: string): Promise<never> {
  const out = await withConnection(async (db) => {
    const rows = await loadMonitorRows(db, page.id);
    const [monitor] = (await monitorViews(db, rows.filter((r) => Number(r.id) === id), await statusLimits(null, db), await maintenanceMonitors(db, page.id), { strip: false }));
    return monitor ?? null;
  });
  if (!out) ctx.json(GONE, 404);
  ctx.json(warning ? { ok: true, monitor: out, warning } : { ok: true, monitor: out });
}

// Ein Bestandteil dieser Seite, gesperrt; null = gibt es nicht (mehr)
async function lockMonitor(db: Db, page: StatusPageRow, id: number): Promise<Row | null> {
  if (!(await lockStatusPage(db, page.id))) return null;
  return db.one('SELECT * FROM status_monitors WHERE id = ? AND page_id = ? FOR UPDATE', [id, page.id]);
}

async function deleteMonitor(ctx: Ctx, page: StatusPageRow, id: number): Promise<never> {
  const res = await transaction(async (_conn, db) => {
    const m = await lockMonitor(db, page, id);
    if (!m) return GONE;
    if (m.type === 'system') return { ok: false, error: 'OnYourSite’s own components can’t be deleted – hide them instead.' };
    const t = now();
    await db.exec('DELETE FROM status_incident_monitors WHERE monitor_id = ?', [id]);
    await db.exec('DELETE FROM status_run_requests WHERE monitor_id = ?', [id]);
    await db.exec('DELETE FROM status_monitors WHERE id = ?', [id]);
    // Zustand, Summen und Ereignisse räumt der Prüfdienst in Teilen weg
    await db.exec("INSERT INTO status_purge (kind, ref_id, created_at) VALUES ('monitor', ?, ?)", [id, t]);
    await bumpRev(db, page.id, t);
    return { ok: true };
  });
  ctx.json(res, res === GONE ? 404 : 200);
}

async function pauseMonitor(ctx: Ctx, page: StatusPageRow, id: number, paused: boolean): Promise<never> {
  const res = await transaction(async (_conn, db) => {
    const m = await lockMonitor(db, page, id);
    if (!m) return GONE;
    if (m.type === 'manual') return { ok: false, error: 'A component you set by hand isn’t checked, so it can’t be paused.' };
    const t = now();
    // Fortsetzen hebt auch eine Pause des Prüfdienstes auf (er hält sie wieder an, wenn die Seite weiter ablehnt)
    await db.exec(`UPDATE status_monitors SET is_paused = ?${paused ? '' : ', auto_paused = NULL, auto_paused_at = NULL'}, changed_at = ?, updated_at = ? WHERE id = ?`,
      [paused ? 1 : 0, t, stamp(t), id]);
    await bumpRev(db, page.id, t);
    return { ok: true };
  });
  if (!res.ok) ctx.json(res, res === GONE ? 404 : 200);
  return monitorResult(ctx, page, id);
}

async function orderMonitors(ctx: Ctx, page: StatusPageRow, ids: unknown): Promise<never> {
  if (!Array.isArray(ids) || ids.length > 500 || !ids.every((x) => typeof x === 'number' && Number.isInteger(x))) ctx.json({ ok: false, error: 'Please reload and try again.' });
  const list = ids as number[];
  const res = await transaction(async (_conn, db) => {
    if (!(await lockStatusPage(db, page.id))) return GONE;
    const mine = new Set((await db.q('SELECT id FROM status_monitors WHERE page_id = ?', [page.id])).map((r) => Number(r.id)));
    if (new Set(list).size !== list.length || !list.every((x) => mine.has(x))) return { ok: false, error: 'The list changed meanwhile – please reload.' };
    const t = now();
    for (let i = 0; i < list.length; i++) await db.exec('UPDATE status_monitors SET position = ?, changed_at = ? WHERE id = ?', [i, t, list[i]]);
    await bumpRev(db, page.id, t);
    return { ok: true };
  });
  ctx.json(res);
}

async function runMonitor(ctx: Ctx, page: StatusPageRow, uid: number, id: number): Promise<never> {
  const m = await withConnection((db) => db.one('SELECT id, type FROM status_monitors WHERE id = ? AND page_id = ?', [id, page.id]));
  if (!m) ctx.json(GONE, 404);
  if (m.type !== 'http' && m.type !== 'system') ctx.json({ ok: false, error: 'Only checks we run ourselves can be checked now.' });
  if (!(await rateLimit('statusrun:' + uid, 10, 600))) ctx.json({ ok: false, error: 'You’re checking very often – please wait a bit.' });
  // Nur die Warteschlange – kein status_rev (der Prüfdienst lädt dafür nicht alles neu)
  await withConnection((db) => db.exec('INSERT INTO status_run_requests (monitor_id, requested_at) VALUES (?, ?) ON DUPLICATE KEY UPDATE requested_at = VALUES(requested_at)', [id, now()]));
  ctx.json({ ok: true });
}

async function newToken(ctx: Ctx, page: StatusPageRow, id: number): Promise<never> {
  const res = await transaction(async (_conn, db) => {
    const m = await lockMonitor(db, page, id);
    if (!m) return GONE;
    if (m.type !== 'heartbeat') return { ok: false, error: 'Only heartbeats have a link.' };
    const hb = newHeartbeatToken();
    const t = now();
    await db.exec('UPDATE status_monitors SET hb_token_hash = ?, hb_token_enc = ?, changed_at = ?, updated_at = ? WHERE id = ?', [hb.hash, hb.enc, t, stamp(t), id]);
    await bumpRev(db, page.id, t);
    return { ok: true };
  });
  if (!res.ok) ctx.json(res, res === GONE ? 404 : 200);
  return monitorResult(ctx, page, id);
}

async function setManual(ctx: Ctx, page: StatusPageRow, id: number, status: unknown): Promise<never> {
  if (typeof status !== 'string' || !(MANUAL_STATUSES as readonly string[]).includes(status)) ctx.json({ ok: false, error: 'Please choose a status.', field: 'status' });
  const res = await transaction(async (_conn, db) => {
    const m = await lockMonitor(db, page, id);
    if (!m) return GONE;
    if (m.type !== 'manual') return { ok: false, error: 'Only components you set by hand have a status to choose.' };
    const t = now();
    await db.exec('UPDATE status_monitors SET manual_status = ?, manual_since = IF(manual_status <=> ?, manual_since, ?), changed_at = ?, updated_at = ? WHERE id = ?',
      [status as string, status as string, t, t, stamp(t), id]);
    await bumpRev(db, page.id, t);
    return { ok: true };
  });
  if (!res.ok) ctx.json(res, res === GONE ? 404 : 200);
  return monitorResult(ctx, page, id);
}

// ---------------------------------------------------------------- Vorfälle

const INC_GONE = { ok: false, error: 'This incident no longer exists. Please reload.' };

async function incidentResult(ctx: Ctx, page: StatusPageRow, id: number, extra: Record<string, unknown> = {}): Promise<never> {
  const out = await withConnection(async (db) => {
    const inc = await loadIncident(db, page.id, id);
    return inc ? incidentJson(inc, await postsOf(db, [inc.id])) : null;
  });
  if (!out) ctx.json(INC_GONE, 404);
  ctx.json({ ok: true, incident: out, ...extra });
}

async function incidentRate(ctx: Ctx, page: StatusPageRow): Promise<void> {
  const settings = await statusSettings();
  if (!(await rateLimit('statusinc:' + page.id, settings.updates_per_hour, 3600))) {
    ctx.json({ ok: false, error: 'That’s a lot of updates – please wait a bit before posting again.' });
  }
}

async function saveIncident(ctx: Ctx, page: StatusPageRow, uid: number, input: Input): Promise<never> {
  const id = intval(input.id ?? 0);
  const t = now();
  if (id > 0) {
    // Felder eines bestehenden Vorfalls ändern
    const res = await transaction(async (_conn, db) => {
      if (!(await lockStatusPage(db, page.id))) return INC_GONE;
      const inc = await loadIncident(db, page.id, id, true);
      if (!inc) return INC_GONE;
      const r = await editIncidentFields(db, inc, input, await pageMonitorIds(db, page.id), t);
      if (!r.ok) return r;
      await syncIncidentPosts(db, page, inc.id);
      await bumpRev(db, page.id, t);
      return { ok: true };
    });
    if (!res.ok) ctx.json(res, res === INC_GONE ? 404 : 200);
    return incidentResult(ctx, page, id);
  }
  await incidentRate(ctx, page);
  const res = await transaction(async (_conn, db) => {
    if (!(await lockStatusPage(db, page.id))) return INC_GONE;
    const checked = checkNewIncident(input, await pageMonitorIds(db, page.id), t);
    if (!checked.ok) return checked;
    const newId = await createIncident(db, page.id, checked.value, uid, t);
    await syncIncidentPosts(db, page, newId, { post: input.discord !== false });
    await bumpRev(db, page.id, t);
    return { ok: true, id: newId };
  });
  if (!res.ok) ctx.json(res);
  return incidentResult(ctx, page, (res as { id: number }).id);
}

async function addUpdate(ctx: Ctx, page: StatusPageRow, uid: number, input: Input): Promise<never> {
  const id = intval(input.id ?? 0);
  const body = cleanBody(input.body);
  if (body === '') ctx.json({ ok: false, error: 'Please write what’s going on.', field: 'body' });
  await incidentRate(ctx, page);
  const t = now();
  const res = await transaction(async (_conn, db) => {
    if (!(await lockStatusPage(db, page.id))) return INC_GONE;
    const inc = await loadIncident(db, page.id, id, true);
    if (!inc) return INC_GONE;
    const status = typeof input.status === 'string' ? input.status : inc.status;
    if (!statusesOf(inc.kind).includes(status)) return { ok: false, error: 'Please choose a status.', field: 'status' };
    if (inc.kind === 'maintenance' && status === 'scheduled' && inc.status !== 'scheduled') return { ok: false, error: 'A maintenance that has started can’t be scheduled again.', field: 'status' };
    await addIncidentUpdate(db, inc, status, body, uid, t);
    // Eine Wartung, die jetzt von Hand beginnt oder endet, folgt dem Status (Beginn bzw. Ende = jetzt)
    if (inc.kind === 'maintenance' && status === 'in_progress' && inc.status === 'scheduled') await db.exec('UPDATE status_incidents SET starts_at = LEAST(starts_at, ?) WHERE id = ?', [t, inc.id]);
    if (inc.kind === 'maintenance' && isFinal(status)) await db.exec('UPDATE status_incidents SET ends_at = LEAST(COALESCE(ends_at, ?), ?) WHERE id = ?', [t, t, inc.id]);
    await syncIncidentPosts(db, page, inc.id, { post: input.discord === true });
    await bumpRev(db, page.id, t);
    return { ok: true };
  });
  if (!res.ok) ctx.json(res, res === INC_GONE ? 404 : 200);
  return incidentResult(ctx, page, id);
}

async function editUpdate(ctx: Ctx, page: StatusPageRow, input: Input): Promise<never> {
  const id = intval(input.id ?? 0);
  const updateId = intval(input.update_id ?? 0);
  const del = input.delete === true;
  const body = del ? '' : cleanBody(input.body);
  if (!del && body === '') ctx.json({ ok: false, error: 'Please write what’s going on.', field: 'body' });
  const t = now();
  const res = await transaction(async (_conn, db) => {
    if (!(await lockStatusPage(db, page.id))) return INC_GONE;
    const inc = await loadIncident(db, page.id, id, true);
    if (!inc) return INC_GONE;
    const u = inc.updates.find((x) => x.id === updateId);
    if (!u) return { ok: false, error: 'This update no longer exists. Please reload.' };
    if (del) {
      if (inc.updates.length <= 1) return { ok: false, error: 'An incident needs at least one update – delete the whole incident instead.' };
      await db.exec('DELETE FROM status_incident_updates WHERE id = ? AND incident_id = ?', [updateId, inc.id]);
      await followLatestUpdate(db, inc.id, t);
    } else {
      await db.exec('UPDATE status_incident_updates SET body = ?, edited_at = ? WHERE id = ? AND incident_id = ?', [body, t, updateId, inc.id]);
      await db.exec('UPDATE status_incidents SET auto_edited = IF(is_auto = 1, 1, auto_edited), updated_at = ? WHERE id = ?', [stamp(t), inc.id]);
    }
    await syncIncidentPosts(db, page, inc.id);
    await bumpRev(db, page.id, t);
    return { ok: true };
  });
  if (!res.ok) ctx.json(res, res === INC_GONE ? 404 : 200);
  return incidentResult(ctx, page, id);
}

async function deleteIncident(ctx: Ctx, page: StatusPageRow, id: number): Promise<never> {
  const res = await transaction(async (_conn, db) => {
    if (!(await lockStatusPage(db, page.id))) return INC_GONE;
    const inc = await loadIncident(db, page.id, id, true);
    if (!inc) return INC_GONE;
    await removeIncidentPosts(db, inc.id);
    await deleteIncidentRows(db, inc.id);
    await bumpRev(db, page.id);
    return { ok: true };
  });
  ctx.json(res, res === INC_GONE ? 404 : 200);
}

// ---------------------------------------------------------------- Alarme und Bot

async function saveAlerts(ctx: Ctx, page: StatusPageRow, input: Input): Promise<never> {
  const events = input.events;
  if (events !== undefined && (!Array.isArray(events) || !events.every((x) => typeof x === 'string' && (ALERT_EVENTS as readonly string[]).includes(x)))) {
    ctx.json({ ok: false, error: 'Please choose the events again.', field: 'events' });
  }
  const res = await transaction(async (_conn, db) => {
    if (!(await lockStatusPage(db, page.id))) return GONE;
    const cur = (await systemStatusPage(db))!;
    const raw: Record<string, unknown> = cur.settings ? (JSON.parse(cur.settings) as Record<string, unknown>) : {};
    const alerts = raw.alerts && typeof raw.alerts === 'object' && !Array.isArray(raw.alerts) ? { ...(raw.alerts as Record<string, unknown>) } : {};
    if (typeof input.admins === 'boolean') alerts.admins = input.admins;
    if (Array.isArray(events)) alerts.events = ALERT_EVENTS.filter((ev) => (events as AlertEvent[]).includes(ev));
    alerts.owner = false;
    raw.alerts = alerts;
    await db.exec('UPDATE status_pages SET settings = ? WHERE id = ?', [JSON.stringify(raw), cur.id]);
    await bumpRev(db, cur.id);
    return { ok: true };
  });
  if (!res.ok) ctx.json(res);
  return alertsOf(ctx, page);
}

async function saveBotChannels(ctx: Ctx, page: StatusPageRow, input: Input): Promise<never> {
  const statusId = typeof input.status_channel_id === 'string' ? input.status_channel_id : '';
  const alertsId = typeof input.alerts_channel_id === 'string' ? input.alerts_channel_id : '';
  const res = await transaction(async (_conn, db) => {
    if (!(await lockStatusPage(db, page.id))) return GONE;
    const rep = await report(db);
    for (const [id, field] of [[statusId, 'status_channel_id'], [alertsId, 'alerts_channel_id']] as const) {
      if (id !== '' && !postableChannel(rep, id)) return { ok: false, error: 'That channel isn’t in the bot’s latest report – refresh the list.', field };
    }
    if (statusId !== '' && statusId === alertsId) return { ok: false, error: 'Public incident posts and team alerts need two different channels.', field: 'alerts_channel_id' };
    // Auch nicht in den öffentlichen Kanal #status des Bots, wenn die Beiträge dort aus sind
    if (alertsId !== '' && alertsId === (rep?.status_channel_id ?? '')) return { ok: false, error: 'Team alerts can’t go to the public #status channel – choose a private channel.', field: 'alerts_channel_id' };
    const problem = alertsChannelProblem(rep, alertsId);
    if (problem !== '') return { ok: false, error: problem, field: 'alerts_channel_id' };
    const cur = (await systemStatusPage(db))!;
    const raw: Record<string, unknown> = cur.settings ? (JSON.parse(cur.settings) as Record<string, unknown>) : {};
    raw.bot = { status_channel_id: statusId, alerts_channel_id: alertsId, saved: true };
    await db.exec('UPDATE status_pages SET settings = ? WHERE id = ?', [JSON.stringify(raw), cur.id]);
    await bumpRev(db, cur.id);
    return { ok: true };
  });
  if (!res.ok) ctx.json(res);
  return alertsOf(ctx, page);
}

export { STATUS_FEATURE, MANUAL_STATUSES };
