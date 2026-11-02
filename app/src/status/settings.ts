// Statusseiten: Einstellungen des Moduls (oys_meta 'status', vom Admin änderbar), die Einstellungen einer Seite
// (status_pages.settings) und die Server-Fakten aus config.json → status (schreibt der Installer, nicht der Admin).
// Alle Werte werden beim Lesen auf erlaubte Bereiche begrenzt – ein kaputter oder alter Eintrag ergibt die Vorgaben.
import { config } from '../config.js';
import { exec, value, type Db } from '../db.js';
import { numberFormat } from '../php.js';

// ---------------------------------------------------------------- Modul (oys_meta 'status')

export interface PlanValues {
  checks: number; // Prüfungen (http + heartbeat)
  min_interval: number; // kürzester Abstand in Sekunden
  channels: number; // zusätzliche Alarm-Kanäle
  subscribers: number; // Abonnenten (erst mit den Abonnements, ST-6)
  broadcasts_day: number; // Rundmails an Abonnenten je Tag
}

export interface StatusSettings {
  allow_new: boolean; // neue Freischaltungen erlaubt (bestehende Seiten laufen weiter)
  run_user_checks: boolean; // Notschalter: Prüfungen der Nutzer laufen
  free: PlanValues;
  addons: { more_checks: number; fast_interval: number };
  premium: PlanValues;
  components_max: number;
  intervals: number[];
  ports: number[];
  host_cap: number;
  domain_cap: number;
  host_per_min: number;
  domain_per_min: number;
  ip_per_min: number;
  timeout_max: number;
  keyword_kb: number;
  raw_days: number;
  hourly_days: number;
  daily_days: number;
  events_days: number;
  mail_per_min: number;
  mail_per_day: number;
  confirm_share: number;
  owner_share: number;
  owner_mails_hour: number;
  owner_mails_day: number;
  updates_per_hour: number;
  inactive_days: number;
}

// Vorgaben (Entwurf §3.3; Premium nur mit den drei Vorteilen aus Q1 = b: Alarm-Kanäle und Rundmails wie kostenlos)
export function statusDefaults(): StatusSettings {
  return {
    allow_new: true,
    run_user_checks: true,
    free: { checks: 10, min_interval: 180, channels: 3, subscribers: 50, broadcasts_day: 3 },
    addons: { more_checks: 10, fast_interval: 60 },
    premium: { checks: 30, min_interval: 60, channels: 3, subscribers: 250, broadcasts_day: 3 },
    components_max: 40,
    intervals: [60, 120, 180, 300],
    ports: [80, 443, 8080, 8443],
    host_cap: 20,
    domain_cap: 60,
    host_per_min: 30,
    domain_per_min: 60,
    ip_per_min: 3000,
    timeout_max: 30,
    keyword_kb: 512,
    raw_days: 2,
    hourly_days: 14,
    daily_days: 120,
    events_days: 90,
    mail_per_min: 30,
    mail_per_day: 1000,
    confirm_share: 10,
    owner_share: 30,
    owner_mails_hour: 12,
    owner_mails_day: 50,
    updates_per_hour: 20,
    inactive_days: 90,
  };
}

// Erlaubte Bereiche je Zahl [min, max]
const RANGES: Record<string, [number, number]> = {
  'checks': [0, 500],
  'min_interval': [60, 3600],
  'channels': [0, 20],
  'subscribers': [0, 100000],
  'broadcasts_day': [0, 50],
  'addons.more_checks': [0, 100],
  'addons.fast_interval': [60, 3600],
  'components_max': [1, 200],
  'host_cap': [1, 10000],
  'domain_cap': [1, 100000],
  'host_per_min': [1, 600],
  'domain_per_min': [1, 6000],
  'ip_per_min': [1, 100000],
  'timeout_max': [5, 30],
  'keyword_kb': [16, 2048],
  'raw_days': [1, 30],
  'hourly_days': [1, 90],
  'daily_days': [30, 400],
  'events_days': [7, 365],
  'mail_per_min': [1, 1000],
  'mail_per_day': [1, 1000000],
  'confirm_share': [0, 100],
  'owner_share': [0, 100],
  'owner_mails_hour': [0, 1000],
  'owner_mails_day': [0, 10000],
  'updates_per_hour': [1, 1000],
  'inactive_days': [30, 3650],
};

// Ganze Zahl aus JSON oder Formular ('12', 12, 12.0); alles andere → undefined
function wholeNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^[ \t]*-?\d{1,9}[ \t]*$/.test(v)) return Number(v.replace(/[ \t]/g, ''));
  return undefined;
}

function clampTo(range: [number, number], v: number): number {
  return Math.min(range[1], Math.max(range[0], v));
}

function num(input: unknown, range: [number, number], fallback: number): number {
  const v = wholeNumber(input);
  return v === undefined ? fallback : clampTo(range, v);
}

// true/false aus JSON oder Formular ('1', 'on', 'true' / '0', '', 'off', 'false')
function bool(input: unknown, fallback: boolean): boolean {
  if (typeof input === 'boolean') return input;
  if (typeof input === 'number') return input !== 0;
  if (typeof input === 'string') {
    if (['1', 'on', 'true', 'yes'].includes(input)) return true;
    if (['0', '', 'off', 'false', 'no'].includes(input)) return false;
  }
  return fallback;
}

// Liste ganzer Zahlen: JSON-Liste oder „60, 120, 180“ – sortiert, ohne Doppelte, im Bereich, höchstens max Einträge
function numberList(input: unknown, range: [number, number], max: number, fallback: number[]): number[] {
  let parts: unknown[];
  if (Array.isArray(input)) parts = input;
  else if (typeof input === 'string') parts = input.split(/[,; \t]+/).filter((p) => p !== '');
  else return [...fallback];
  const out: number[] = [];
  for (const p of parts) {
    const v = wholeNumber(p);
    if (v === undefined || v < range[0] || v > range[1]) continue;
    if (!out.includes(v)) out.push(v);
  }
  out.sort((a, b) => a - b);
  return out.length ? out.slice(0, max) : [...fallback];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const field = (o: unknown, k: string): unknown => (isObject(o) && Object.hasOwn(o, k) ? o[k] : undefined);

function plan(input: unknown, d: PlanValues): PlanValues {
  return {
    checks: num(field(input, 'checks'), RANGES.checks, d.checks),
    min_interval: num(field(input, 'min_interval'), RANGES.min_interval, d.min_interval),
    channels: num(field(input, 'channels'), RANGES.channels, d.channels),
    subscribers: num(field(input, 'subscribers'), RANGES.subscribers, d.subscribers),
    broadcasts_day: num(field(input, 'broadcasts_day'), RANGES.broadcasts_day, d.broadcasts_day),
  };
}

// Werte begrenzen (gespeicherter Eintrag oder Formular) – unbekannte Schlüssel fallen weg
export function statusSettingsFrom(input: unknown): StatusSettings {
  const d = statusDefaults();
  const s: StatusSettings = {
    ...d,
    allow_new: bool(field(input, 'allow_new'), d.allow_new),
    run_user_checks: bool(field(input, 'run_user_checks'), d.run_user_checks),
    free: plan(field(input, 'free'), d.free),
    addons: {
      more_checks: num(field(field(input, 'addons'), 'more_checks'), RANGES['addons.more_checks'], d.addons.more_checks),
      fast_interval: num(field(field(input, 'addons'), 'fast_interval'), RANGES['addons.fast_interval'], d.addons.fast_interval),
    },
    premium: plan(field(input, 'premium'), d.premium),
    intervals: numberList(field(input, 'intervals'), [60, 3600], 8, d.intervals),
    ports: numberList(field(input, 'ports'), [1, 65535], 20, d.ports),
  };
  for (const key of ['components_max', 'host_cap', 'domain_cap', 'host_per_min', 'domain_per_min', 'ip_per_min', 'timeout_max', 'keyword_kb',
    'raw_days', 'hourly_days', 'daily_days', 'events_days', 'mail_per_min', 'mail_per_day', 'confirm_share', 'owner_share',
    'owner_mails_hour', 'owner_mails_day', 'updates_per_hour', 'inactive_days'] as const) {
    s[key] = num(field(input, key), RANGES[key], d[key]);
  }
  // Mindestabstände gibt es nur als erlaubten Abstand
  const smallest = s.intervals[0];
  for (const p of [s.free, s.premium]) {
    if (!s.intervals.includes(p.min_interval)) p.min_interval = s.intervals.find((i) => i >= p.min_interval) ?? s.intervals[s.intervals.length - 1];
  }
  if (!s.intervals.includes(s.addons.fast_interval)) s.addons.fast_interval = smallest;
  return s;
}

// Aktuelle Einstellungen (fehlt der Eintrag: die Vorgaben)
export async function statusSettings(db?: Db): Promise<StatusSettings> {
  const sql = "SELECT meta_value FROM oys_meta WHERE meta_key = 'status'";
  const raw = db ? await db.value(sql) : await value(sql);
  let data: unknown = null;
  if (typeof raw === 'string' && raw !== '') {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }
  return statusSettingsFrom(data);
}

export type SaveResult = { ok: true; settings: StatusSettings } | { ok: false; error: string };

// Speichern (Admin): begrenzen, dann prüfen, ob die Abonnenten zum Mail-Budget passen – eine Rundmail an alle
// Abonnenten einer Seite darf höchstens ein Viertel des Tagesbudgets brauchen
export async function statusSaveSettings(input: unknown, db?: Db): Promise<SaveResult> {
  const s = statusSettingsFrom(input);
  const biggest = Math.max(s.free.subscribers, s.premium.subscribers);
  if (biggest * 4 > s.mail_per_day) {
    return {
      ok: false,
      error: `One update to ${numberFormat(biggest)} subscribers would use more than a quarter of the daily email budget (${numberFormat(s.mail_per_day)}).`,
    };
  }
  const sql = "REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('status', ?)";
  const params = [JSON.stringify(s)];
  await (db ? db.exec(sql, params) : exec(sql, params));
  return { ok: true, settings: s };
}

// ---------------------------------------------------------------- Einstellungen einer Seite (status_pages.settings)

export const ALERT_EVENTS = ['down', 'up', 'degraded', 'cert', 'heartbeat'] as const;
export type AlertEvent = (typeof ALERT_EVENTS)[number];

export interface PageSettings {
  accent: string; // '' = Farbe des Designs, sonst #rrggbb
  logo_page_id: number;
  back_page_id: number;
  show_uptime: boolean;
  show_response: boolean;
  history_days: number;
  subscribe: boolean;
  hide_branding: boolean;
  noindex: boolean;
  auto_incident: number; // 0 = aus, 300, 900
  notify_auto: boolean;
  alerts: { owner: boolean; admins: boolean; events: AlertEvent[] };
  // nur OnYourSites eigene Seite: Kanäle des Bots (aus seinem Bericht gewählt)
  bot?: { status_channel_id: string; alerts_channel_id: string };
}

export function pageSettingsDefaults(): PageSettings {
  return {
    accent: '',
    logo_page_id: 0,
    back_page_id: 0,
    show_uptime: true,
    show_response: false,
    history_days: 7,
    subscribe: true,
    hide_branding: false,
    noindex: false,
    auto_incident: 300,
    notify_auto: true,
    alerts: { owner: true, admins: false, events: [...ALERT_EVENTS] },
  };
}

const snowflake = (v: unknown): string => (typeof v === 'string' && /^\d{17,20}$/.test(v) ? v : '');

// Einstellungen einer Seite mit Vorgaben; unbekannte Schlüssel fallen weg (row: Zeile aus status_pages)
export function statusPageSettings(row: { settings?: unknown; is_system?: unknown } | null): PageSettings {
  const d = pageSettingsDefaults();
  let data: unknown = null;
  const raw = row?.settings;
  if (typeof raw === 'string' && raw !== '') {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  } else if (isObject(raw)) {
    data = raw;
  }
  const accent = field(data, 'accent');
  const autoIncident = wholeNumber(field(data, 'auto_incident'));
  const alerts = field(data, 'alerts');
  const events = field(alerts, 'events');
  const s: PageSettings = {
    accent: typeof accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(accent) ? accent.toLowerCase() : '',
    logo_page_id: Math.max(0, wholeNumber(field(data, 'logo_page_id')) ?? 0),
    back_page_id: Math.max(0, wholeNumber(field(data, 'back_page_id')) ?? 0),
    show_uptime: bool(field(data, 'show_uptime'), d.show_uptime),
    show_response: bool(field(data, 'show_response'), d.show_response),
    history_days: clampTo([0, 30], wholeNumber(field(data, 'history_days')) ?? d.history_days),
    subscribe: bool(field(data, 'subscribe'), d.subscribe),
    hide_branding: bool(field(data, 'hide_branding'), d.hide_branding),
    noindex: bool(field(data, 'noindex'), d.noindex),
    auto_incident: autoIncident !== undefined && [0, 300, 900].includes(autoIncident) ? autoIncident : d.auto_incident,
    notify_auto: bool(field(data, 'notify_auto'), d.notify_auto),
    alerts: {
      owner: bool(field(alerts, 'owner'), d.alerts.owner),
      admins: bool(field(alerts, 'admins'), d.alerts.admins),
      events: Array.isArray(events) ? ALERT_EVENTS.filter((ev) => events.includes(ev)) : [...d.alerts.events],
    },
  };
  if (row && (row.is_system === 1 || row.is_system === '1' || row.is_system === true)) {
    const bot = field(data, 'bot');
    s.bot = { status_channel_id: snowflake(field(bot, 'status_channel_id')), alerts_channel_id: snowflake(field(bot, 'alerts_channel_id')) };
  }
  return s;
}

// ---------------------------------------------------------------- Server-Fakten (config.json → status)

export interface StatusServerConfig {
  dns: string[]; // öffentliche Resolver (nie der des Systems)
  canaries: string[]; // feste HTTPS-Adressen für die Plattform-Sperre
  concurrency: number;
  keyword_concurrency: number;
  user_inflight: number;
  tunnel: boolean; // Cloudflare-Tunnel: eigene Adressen sind dann immer gesperrt
  self_ips: string[]; // alle globalen Adressen des Servers
  egress_ips: string[]; // Absender-Adressen der Prüfungen (Bedingungsseite)
  kernel_guard: boolean | null; // Ergebnis des Installer-Tests (null = nicht geprüft)
}

export const DEFAULT_DNS = ['1.1.1.1', '1.0.0.1', '9.9.9.9'];
export const DEFAULT_CANARIES = [
  'https://www.gstatic.com/generate_204',
  'https://www.cloudflare.com/cdn-cgi/trace',
  'https://detectportal.firefox.com/success.txt',
];

// Resolver: IP-Adresse, optional mit Port (1.1.1.1, 1.1.1.1:53, [2606:4700::1111]:53)
const RESOLVER = /^(?:\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?|[0-9a-fA-F:]+|\[[0-9a-fA-F:]+\](?::\d{1,5})?)$/;
const IP_TEXT = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:.]+)$/;

function stringList(v: unknown, ok: (s: string) => boolean, fallback: string[], max = 64): string[] {
  if (!Array.isArray(v)) return [...fallback];
  const out = v.filter((x): x is string => typeof x === 'string' && ok(x)).slice(0, max);
  return out;
}

export function statusServerConfig(): StatusServerConfig {
  const c = config<unknown>('status', null);
  const dns = stringList(field(c, 'dns'), (s) => RESOLVER.test(s), DEFAULT_DNS);
  const canaries = stringList(field(c, 'canaries'), (s) => /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/[^\s]*$/.test(s), DEFAULT_CANARIES);
  const kg = field(c, 'kernel_guard');
  return {
    dns: dns.length ? dns : [...DEFAULT_DNS],
    canaries: canaries.length ? canaries : [...DEFAULT_CANARIES],
    concurrency: clampTo([1, 5000], wholeNumber(field(c, 'concurrency')) ?? 1000),
    keyword_concurrency: clampTo([1, 1000], wholeNumber(field(c, 'keyword_concurrency')) ?? 64),
    user_inflight: clampTo([1, 1000], wholeNumber(field(c, 'user_inflight')) ?? 32),
    tunnel: bool(field(c, 'tunnel'), false),
    self_ips: stringList(field(c, 'self_ips'), (s) => IP_TEXT.test(s), []),
    egress_ips: stringList(field(c, 'egress_ips'), (s) => IP_TEXT.test(s), []),
    kernel_guard: typeof kg === 'boolean' ? kg : null,
  };
}
