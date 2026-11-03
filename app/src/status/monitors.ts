// Statusseiten: Bestandteile im Editor – Ansicht (Zustand, letzte Prüfungen) und Speichern mit allen Prüfungen aus
// Entwurf §4.6 (status-monitor-save). Die Webseite verbindet sich nie mit dem Ziel: sie löst den Namen nur über die
// öffentlichen Resolver auf (5 s), um private Adressen schon beim Speichern abzulehnen; geprüft wird im Prüfdienst.
import { randomBytes } from 'node:crypto';
import type { Db, Row } from '../db.js';
import { decryptData, encryptData, sha256Hex } from '../crypto.js';
import { cleanText, mainUrl, prettyUrl } from '../helpers.js';
import { date } from '../php.js';
import { errorText } from './errors.js';
import { hostRule, parseTarget, PRIVATE_TEXT, type GuardPolicy, type HostRule } from './guard.js';
import { parseExpect } from './http.js';
import { countsAsCheck, effectiveMonitors, type StatusLimits } from './limits.js';
import { numOrNull, parseObject } from './model.js';
import { registrableDomain } from './psl.js';
import type { PublicResolver } from './resolver.js';
import { robotsAllows, rulesFromJson } from './robots.js';
import { REFUSED_PAUSE_AFTER, RATE_LIMITED_AFTER } from './state.js';
import type { StatusSettings } from './settings.js';

export const MANUAL_STATUSES = ['operational', 'degraded', 'partial', 'major', 'maintenance'] as const;
export const TIMEOUTS = [5, 10, 15, 20, 30];

export interface MonitorView {
  id: number;
  type: string;
  name: string;
  description: string;
  group: string;
  position: number;
  public: boolean;
  target: string;
  prettyTarget: string;
  interval: number;
  effectiveInterval: number;
  config: Record<string, unknown>;
  paused: boolean;
  adminPaused: boolean;
  adminNote: string;
  overLimit: boolean;
  autoPaused: string;
  heartbeatUrl: string | null;
  manualStatus: string | null;
  state: {
    status: 'up' | 'down' | 'degraded' | 'unknown' | 'paused' | 'maintenance';
    since: number | null;
    lastCheck: number | null;
    lastMs: number | null;
    lastCode: number | null;
    error: string | null;
    errorText: string;
    flapping: boolean;
    throttled: boolean;
    certExpires: number | null;
    refusedSince: number | null;
  };
  strip: Array<{ at: number; ok: boolean; ms: number | null }>;
}

export const heartbeatUrl = (token: string): string => mainUrl('/_/hb/' + token);

export const MONITOR_COLUMNS = `m.id, m.page_id, m.type, m.name, m.description, m.group_name, m.position, m.is_public, m.target, m.target_host, m.config, m.interval_s,
  m.manual_status, m.hb_token_enc, m.is_paused, m.admin_paused, m.admin_note, m.auto_paused, s.state, s.since, s.flapping, s.last_check_at, s.last_ms,
  s.last_code, s.last_error, s.cert_expires_at, s.throttled_at, s.refused_since`;

export async function loadMonitorRows(db: Db, pageId: number, id?: number): Promise<Row[]> {
  return db.q(`SELECT ${MONITOR_COLUMNS} FROM status_monitors m LEFT JOIN status_state s ON s.monitor_id = m.id
      WHERE m.page_id = ?${id !== undefined ? ' AND m.id = ?' : ''} ORDER BY m.position, m.id`, id !== undefined ? [pageId, id] : [pageId]);
}

// Ansicht für den Editor (rows: alle Bestandteile der Seite – für „über der Grenze“)
export async function monitorViews(db: Db, rows: Row[], limits: StatusLimits, maintenance: ReadonlySet<number>, opts: { strip?: boolean } = {}): Promise<MonitorView[]> {
  const eff = new Map(effectiveMonitors(rows.map((r) => ({ id: Number(r.id), type: String(r.type), position: Number(r.position ?? 0), interval_s: Number(r.interval_s ?? 300) })), limits)
    .map((e) => [e.id, e]));
  const now = Math.floor(Date.now() / 1000);
  const out: MonitorView[] = [];
  for (const r of rows) {
    const id = Number(r.id);
    const type = String(r.type);
    const config = parseObject(r.config);
    const e = eff.get(id);
    const paused = Number(r.is_paused) === 1;
    const adminPaused = Number(r.admin_paused) === 1;
    const autoPaused = r.auto_paused === null || r.auto_paused === undefined ? '' : String(r.auto_paused);
    const stateRaw = ['up', 'down', 'degraded'].includes(String(r.state)) ? String(r.state) as 'up' | 'down' | 'degraded' : 'unknown';
    const status = paused || adminPaused || autoPaused !== '' || e?.overLimit ? 'paused' : maintenance.has(id) ? 'maintenance' : stateRaw;
    const error = r.last_error === null || r.last_error === undefined ? null : String(r.last_error);
    let hb: string | null = null;
    if (type === 'heartbeat' && typeof r.hb_token_enc === 'string' && r.hb_token_enc !== '') {
      const token = decryptData(r.hb_token_enc);
      if (typeof token === 'string' && /^[A-Za-z0-9_-]{32}$/.test(token)) hb = heartbeatUrl(token);
    }
    const throttledAt = numOrNull(r.throttled_at);
    const refusedSince = numOrNull(r.refused_since);
    let strip: Array<{ at: number; ok: boolean; ms: number | null }> = [];
    if (opts.strip !== false && (type === 'http' || type === 'system' || type === 'heartbeat')) {
      strip = (await db.q('SELECT at, ok, ms FROM status_checks WHERE monitor_id = ? ORDER BY at DESC LIMIT 30', [id]))
        .map((c) => ({ at: Number(c.at), ok: Number(c.ok) === 1, ms: numOrNull(c.ms) })).reverse();
    }
    out.push({
      id, type, name: String(r.name ?? ''), description: String(r.description ?? ''), group: String(r.group_name ?? ''), position: Number(r.position ?? 0),
      public: Number(r.is_public) === 1, target: String(r.target ?? ''), prettyTarget: type === 'http' ? prettyUrl(String(r.target ?? '')) : '',
      interval: Number(r.interval_s ?? 300), effectiveInterval: e?.effectiveInterval ?? Number(r.interval_s ?? 300), config, paused, adminPaused,
      adminNote: String(r.admin_note ?? ''), overLimit: !!e?.overLimit, autoPaused, heartbeatUrl: hb, manualStatus: r.manual_status === null ? null : String(r.manual_status ?? ''),
      state: {
        status, since: numOrNull(r.since), lastCheck: numOrNull(r.last_check_at), lastMs: numOrNull(r.last_ms), lastCode: numOrNull(r.last_code), error,
        errorText: errorText(error, { timeout: typeof config.timeout === 'number' ? config.timeout : 10, code: numOrNull(r.last_code) }),
        flapping: Number(r.flapping) === 1, throttled: throttledAt !== null && now - throttledAt < 600, certExpires: numOrNull(r.cert_expires_at),
        refusedSince: refusedSince !== null && now - refusedSince > RATE_LIMITED_AFTER ? refusedSince : null,
      },
      strip,
    });
  }
  return out;
}

export async function maintenanceMonitors(db: Db, pageId: number): Promise<Set<number>> {
  const rows = await db.q(`SELECT im.monitor_id FROM status_incidents i JOIN status_incident_monitors im ON im.incident_id = i.id
      WHERE i.page_id = ? AND i.kind = 'maintenance' AND i.status = 'in_progress' AND i.resolved_at IS NULL`, [pageId]);
  return new Set(rows.map((r) => Number(r.monitor_id)));
}

// ---------------------------------------------------------------- Speichern

export type SaveCheck = { ok: true; warning?: string } | { ok: false; error: string; field: string };

export interface SaveDeps {
  settings: StatusSettings;
  limits: StatusLimits;
  policy: GuardPolicy;
  resolver: PublicResolver;
  rules: HostRule[];
  now: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const intOf = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^-?\d{1,9}$/.test(v.trim())) return Number(v.trim());
  return null;
};
const boolOf = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : v === 1 || v === '1' ? true : v === 0 || v === '0' ? false : d);

export interface MonitorWrite {
  type: string;
  name: string;
  description: string;
  group: string;
  isPublic: boolean;
  target: string;
  host: string;
  domain: string;
  interval: number;
  config: Record<string, unknown>;
  manualStatus: string | null;
}

const fail = (error: string, field: string): { ok: false; error: string; field: string } => ({ ok: false, error, field });

// Felder prüfen (ohne Zählung und ohne Netz); existing: der Bestandteil vor der Änderung (oder null)
export function checkMonitorInput(input: Record<string, unknown>, existing: Row | null, deps: Pick<SaveDeps, 'settings' | 'limits' | 'policy'>):
  { ok: true; value: MonitorWrite; url: ReturnType<typeof parseTarget> | null } | { ok: false; error: string; field: string } {
  const type = existing ? String(existing.type) : String(input.type ?? '');
  if (!['http', 'heartbeat', 'manual', 'system'].includes(type) || (!existing && type === 'system')) return fail('Please choose what kind of component this is.', 'type');
  if (existing && input.type !== undefined && input.type !== type) return fail('The kind of a component can’t change – add a new one instead.', 'type');
  const name = cleanText(input.name ?? (existing ? existing.name : ''), 80);
  if (name === '') return fail('Please give the component a name.', 'name');
  const description = cleanText(input.description ?? (existing ? existing.description : ''), 200);
  const group = cleanText(input.group ?? (existing ? existing.group_name : ''), 60);
  const isPublic = boolOf(input.public, existing ? Number(existing.is_public) === 1 : true);
  const prevConfig = existing ? parseObject(existing.config) : {};
  const base: MonitorWrite = {
    type, name, description, group, isPublic, target: existing ? String(existing.target ?? '') : '', host: existing ? String(existing.target_host ?? '') : '',
    domain: '', interval: existing ? Number(existing.interval_s ?? 300) : 300, config: prevConfig, manualStatus: existing && existing.manual_status !== null ? String(existing.manual_status) : null,
  };
  // Eigene Bestandteile: nur Name, Beschreibung, Gruppe, sichtbar
  if (type === 'system') return { ok: true, value: base, url: null };
  const s = deps.settings;
  if (type === 'manual') {
    const status = String(input.status ?? base.manualStatus ?? 'operational');
    if (!(MANUAL_STATUSES as readonly string[]).includes(status)) return fail('Please choose a status.', 'status');
    return { ok: true, value: { ...base, manualStatus: status, config: {} }, url: null };
  }
  if (type === 'heartbeat') {
    const period = intOf(input.period ?? prevConfig.period ?? 3600);
    const grace = intOf(input.grace ?? prevConfig.grace ?? 300);
    if (period === null || period < 60 || period > 86400) return fail('The period has to be between 1 minute and 24 hours.', 'period');
    if (grace === null || grace < 60 || grace > 3600) return fail('The grace time has to be between 1 minute and 1 hour.', 'grace');
    return { ok: true, value: { ...base, interval: Math.min(period, 65535), config: { period, grace } }, url: null };
  }
  // Website
  const url = parseTarget(input.url ?? (existing ? existing.target : ''), deps.policy);
  if (!url.ok) return fail(url.error, 'url');
  const interval = intOf(input.interval ?? base.interval);
  if (interval === null || !s.intervals.includes(interval)) return fail(`Please choose how often to check (${s.intervals.map((i) => i / 60).join(', ')} minutes).`, 'interval');
  // Kürzer als erlaubt – außer die gespeicherte Prüfung hatte schon diesen Abstand (z. B. nach dem Ende von „Fast checks“:
  // der Prüfdienst streckt ihn, Bearbeiten soll weiter gehen)
  if (interval < deps.limits.minInterval && !(existing && Number(existing.interval_s) === interval)) {
    return fail(`You can check every ${deps.limits.minInterval / 60} minutes at most. “Fast checks” or Premium check every minute.`, 'interval');
  }
  const timeout = intOf(input.timeout ?? prevConfig.timeout ?? 10);
  if (timeout === null || !TIMEOUTS.includes(timeout) || timeout > s.timeout_max) return fail(`The timeout can be ${TIMEOUTS.filter((t) => t <= s.timeout_max).join(', ')} seconds.`, 'timeout');
  if (timeout >= interval) return fail('The timeout has to be shorter than the check interval.', 'timeout');
  const method = String(input.method ?? prevConfig.method ?? 'GET');
  if (method !== 'GET' && method !== 'HEAD') return fail('Please choose GET or HEAD.', 'method');
  const expect = String(input.expect ?? prevConfig.expect ?? '200-299').replace(/\s+/g, '');
  if (expect.length > 60 || parseExpect(expect) === null) return fail('Expected status codes look like 200-299,301.', 'expect');
  const keyword = cleanText(input.keyword ?? prevConfig.keyword ?? '', 100);
  const keywordMode = String(input.keyword_mode ?? prevConfig.keyword_mode ?? 'contains');
  if (keywordMode !== 'contains' && keywordMode !== 'absent') return fail('Please choose whether the keyword must be there or not.', 'keyword_mode');
  const retries = intOf(input.retries ?? prevConfig.retries ?? 1);
  if (retries === null || retries < 0 || retries > 3) return fail('Retries can be 0 to 3.', 'retries');
  const slow = intOf(input.slow_ms ?? prevConfig.slow_ms ?? 0);
  if (slow === null || (slow !== 0 && (slow < 500 || slow > 20000))) return fail('“Slow above” is off (0) or between 500 and 20000 ms.', 'slow_ms');
  const config = {
    method, expect, keyword, keyword_mode: keywordMode, keyword_case: boolOf(input.keyword_case, prevConfig.keyword_case === true), timeout, retries,
    slow_ms: slow, redirects: boolOf(input.redirects, prevConfig.redirects !== false), cert_warn: boolOf(input.cert_warn, prevConfig.cert_warn !== false),
    tls_ignore: boolOf(input.tls_ignore, prevConfig.tls_ignore === true),
  };
  return {
    ok: true,
    value: { ...base, target: url.url, host: url.host, domain: url.ip ? url.host : registrableDomain(url.host), interval, config },
    url,
  };
}

// Regeln je Website, robots.txt und die Grenzen je Host und Domain; dann der Name über die öffentlichen Resolver
export async function checkSite(db: Db, w: MonitorWrite, exceptId: number, deps: SaveDeps, path: string): Promise<SaveCheck> {
  const rule = hostRule(w.host, deps.rules);
  if (rule?.rule === 'block') return fail('Monitoring this site isn’t allowed. The site owner asked us not to check it.', 'url');
  const meta = await db.one('SELECT robots_rules FROM status_host_meta WHERE host = ?', [w.host]);
  if (meta && !robotsAllows(rulesFromJson(meta.robots_rules), path)) return fail('The site’s robots.txt asks us not to check this address.', 'url');
  const hostMax = rule?.rule === 'allow' && rule.max_monitors !== null ? rule.max_monitors : deps.settings.host_cap;
  const domainMax = rule?.rule === 'allow' && rule.max_monitors !== null ? Math.max(rule.max_monitors, deps.settings.domain_cap) : deps.settings.domain_cap;
  const onHost = Number(await db.value("SELECT COUNT(*) FROM status_monitors WHERE target_host = ? AND type = 'http' AND id <> ?", [w.host, exceptId]));
  const onDomain = Number(await db.value("SELECT COUNT(*) FROM status_monitors WHERE target_domain = ? AND type = 'http' AND id <> ?", [w.domain, exceptId]));
  if (onHost >= hostMax || onDomain >= domainMax) return fail('This site is already checked by many accounts – please contact us if you need it.', 'url');
  return { ok: true };
}

// Nur auflösen, nie verbinden: eine private Adresse → abgelehnt; nicht auflösbar → gespeichert mit Hinweis
export async function checkDns(w: MonitorWrite, port: number, deps: Pick<SaveDeps, 'resolver' | 'policy'>): Promise<SaveCheck> {
  if (/^[0-9.]+$/.test(w.host) || w.host.includes(':')) return { ok: true };
  const res = await Promise.race([
    deps.resolver.resolvePublic(w.host, port, deps.policy),
    new Promise<null>((r) => setTimeout(() => r(null), 5000)),
  ]);
  if (res && !res.ok && res.error === 'blocked') return fail(PRIVATE_TEXT, 'url');
  if (!res || !res.ok) return { ok: true, warning: 'We couldn’t find this address yet – the first check will tell.' };
  return { ok: true };
}

// Neues Geheimnis eines Heartbeats: 32 Zeichen base64url (24 Zufallsbytes)
export function newHeartbeatToken(): { token: string; hash: string; enc: string } {
  const token = randomBytes(24).toString('base64url');
  return { token, hash: sha256Hex(token), enc: String(encryptData(token)) };
}

// Zählen innerhalb der Sperre der Seite: Bestandteile insgesamt und Prüfungen
export async function capacityProblem(db: Db, pageId: number, type: string, isNew: boolean, deps: Pick<SaveDeps, 'settings' | 'limits'>): Promise<{ error: string; field: string } | null> {
  if (!isNew) return null;
  const rows = await db.q('SELECT type FROM status_monitors WHERE page_id = ?', [pageId]);
  if (rows.length >= deps.settings.components_max) return { error: `A status page can have up to ${deps.settings.components_max} components.`, field: 'type' };
  if (countsAsCheck(type) && rows.filter((r) => countsAsCheck(String(r.type))).length >= deps.limits.checks) {
    return { error: `You’ve used all ${deps.limits.checks} checks. Remove one, or get more checks in the shop.`, field: 'type' };
  }
  return null;
}

export const stamp = (now: number): string => date('Y-m-d H:i:s', now);

// Für Tests und Anzeigen: wann eine 24-h-Folge von 403/429 die Prüfung anhält
export const REFUSED_LIMIT = REFUSED_PAUSE_AFTER;

export { isObj };
