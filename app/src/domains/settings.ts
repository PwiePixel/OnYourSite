// Eigene Domains: Einstellungen und Zustände in oys_meta.
//   custom_domains        Einstellungen des Admins (mit Grenzen gelesen; fehlt die Zeile oder ist sie kaputt: Standard)
//   custom_domains_state  Gesundheit des Domain-Dienstes – schreibt nur der Dienst (keine Geheimnisse)
//   custom_domains_req    Aufträge aus dem Admin (Verbindung testen, Selbsttest jetzt) – der Dienst liest und löscht sie
import type { Db } from '../db.js';
import { phpJson } from '../html.js';
import { intval, phpStr, phpTruthy } from '../php.js';
import { poolDb } from '../honeycombs/util.js';
import { jsonDecode, own } from '../content/util.js';

export interface DomainSettings {
  enabled: boolean; // neue Domains erlaubt
  per_user: number; // Domains je Konto (Team ausgenommen)
  max_total: number; // Domains mit Hostnamen bei Cloudflare insgesamt
  allow_paid: boolean; // über die 100 freien Hostnamen hinaus (kostet bei Cloudflare)
  grace_days: number; // so lange leitet eine pausierte Domain weiter
  pending_days: number; // so lange darf die Einrichtung bei Cloudflare dauern (Cloudflare löscht nach 7 Tagen)
  min_account_days: number; // Mindestalter des Kontos zum Verbinden
  slots: boolean; // jede Domain braucht einen Domain-Platz aus dem Shop
  mails_per_minute: number; // eigenes Mail-Budget des Dienstes (Q11)
}

export const DOMAIN_SETTINGS_DEFAULTS: Readonly<DomainSettings> = Object.freeze({
  enabled: false, per_user: 3, max_total: 100, allow_paid: false, grace_days: 30, pending_days: 7, min_account_days: 30, slots: false,
  mails_per_minute: 20,
});

// Zahlen mit Grenzen (Schlüssel → [kleinster, größter Wert])
const LIMITS: Record<'per_user' | 'max_total' | 'grace_days' | 'pending_days' | 'min_account_days' | 'mails_per_minute', [number, number]> = {
  per_user: [0, 10], max_total: [0, 50000], grace_days: [0, 90], pending_days: [1, 7], min_account_days: [0, 365], mails_per_minute: [1, 200],
};

const clamp = (v: number, [min, max]: [number, number]): number => Math.max(min, Math.min(max, v));

// Rohe Werte (gespeichertes JSON oder Formular) → gültige Einstellungen; Fehlendes bleibt beim Standard
export function normalizeDomainSettings(raw: unknown): DomainSettings {
  const d = DOMAIN_SETTINGS_DEFAULTS;
  const s: DomainSettings = { ...d };
  for (const key of Object.keys(LIMITS) as Array<keyof typeof LIMITS>) {
    const v = own(raw, key);
    if (v !== undefined && v !== null && v !== '') s[key] = clamp(intval(v), LIMITS[key]);
  }
  for (const key of ['enabled', 'allow_paid', 'slots'] as const) {
    const v = own(raw, key);
    if (v !== undefined) s[key] = phpTruthy(v);
  }
  return s;
}

async function readMeta(key: string, db: Db): Promise<unknown> {
  const v = await db.value('SELECT meta_value FROM oys_meta WHERE meta_key = ?', [key]);
  return v === null || v === undefined ? null : jsonDecode(phpStr(v));
}

async function writeMeta(key: string, value: unknown, db: Db): Promise<void> {
  await db.exec('REPLACE INTO oys_meta (meta_key, meta_value) VALUES (?, ?)', [key, phpJson(value, { unescapedUnicode: true, unescapedSlashes: true })]);
}

export async function domainSettings(db: Db = poolDb): Promise<DomainSettings> {
  return normalizeDomainSettings(await readMeta('custom_domains', db));
}

// Admin speichert (PD-5): mit denselben Grenzen
export async function saveDomainSettings(raw: unknown, db: Db = poolDb): Promise<DomainSettings> {
  const s = normalizeDomainSettings(raw);
  await writeMeta('custom_domains', s, db);
  return s;
}

// ---------------------------------------------------------------- Zustand des Dienstes

export interface Freeze {
  since: string;
  reason: 'control' | 'mass';
  detail: string;
}

export interface WorkerState {
  worker_at: string | null; // letzte Runde des Dienstes
  daily_at: string | null; // Tag der letzten Tagesaufgaben ('Y-m-d')
  list_at: string | null; // letzte Statusliste von Cloudflare (alle 10 Minuten)
  token: '' | 'ok' | 'error'; // zuletzt vom Dienst geprüft
  token_error: string;
  fallback: { origin: string; status: string; checked_at: string } | null;
  quota: { allocated: number; used: number; exceeded: boolean; hard_cap: number; checked_at: string } | null;
  probe_ok_at: string | null; // letzte erfolgreiche Prüfung einer Kunden-Domain über die Kante
  control: { ok: boolean; at: string; error: string } | null;
  freeze: Freeze | null; // Schutzschalter offen: keine Herabstufung, kein Löschen wegen DNS oder Prüfung
  alerts: Record<string, string>; // letzte Admin-Meldung je Art
  cf_ips: { v4: string[]; v6: string[]; fetched_at: string } | null;
  unmanaged: Array<{ hostname: string; id: string; status: string }>;
  test: { at: string; result: string } | null;
}

export const EMPTY_STATE: Readonly<WorkerState> = Object.freeze({
  worker_at: null, daily_at: null, list_at: null, token: '', token_error: '', fallback: null, quota: null, probe_ok_at: null, control: null,
  freeze: null, alerts: {}, cf_ips: null, unmanaged: [], test: null,
});

const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const objOrNull = <T>(v: unknown): T | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as T) : null);

// Gelesen wie gespeichert, aber nur bekannte Felder mit passendem Typ
export async function workerState(db: Db = poolDb): Promise<WorkerState> {
  const raw = await readMeta('custom_domains_state', db);
  const r = objOrNull<Record<string, unknown>>(raw) ?? {};
  const alerts: Record<string, string> = {};
  for (const [k, v] of Object.entries(objOrNull<Record<string, unknown>>(r.alerts) ?? {})) if (typeof v === 'string') alerts[k] = v;
  const token = r.token === 'ok' || r.token === 'error' ? r.token : '';
  return {
    worker_at: strOrNull(r.worker_at), daily_at: strOrNull(r.daily_at), list_at: strOrNull(r.list_at), token,
    token_error: typeof r.token_error === 'string' ? r.token_error : '',
    fallback: objOrNull(r.fallback), quota: objOrNull(r.quota), probe_ok_at: strOrNull(r.probe_ok_at), control: objOrNull(r.control),
    freeze: objOrNull(r.freeze), alerts, cf_ips: objOrNull(r.cf_ips),
    unmanaged: Array.isArray(r.unmanaged) ? (r.unmanaged as WorkerState['unmanaged']) : [], test: objOrNull(r.test),
  };
}

// Nur der Domain-Dienst schreibt (eine Instanz unter GET_LOCK) – Änderungen als Teil-Objekt
export async function updateWorkerState(change: Partial<WorkerState>, db: Db = poolDb): Promise<WorkerState> {
  const next = { ...(await workerState(db)), ...change };
  await writeMeta('custom_domains_state', next, db);
  return next;
}

// ---------------------------------------------------------------- Aufträge aus dem Admin

export type WorkerRequest = 'test' | 'control';

// Admin (PD-5): Auftrag an den Dienst (er sieht ihn in seiner nächsten Minute)
export async function requestWorker(kind: WorkerRequest, at: string, db: Db = poolDb): Promise<void> {
  const raw = objOrNull<Record<string, unknown>>(await readMeta('custom_domains_req', db)) ?? {};
  await writeMeta('custom_domains_req', { ...raw, [kind]: at }, db);
}

// Dienst: Aufträge lesen und löschen (in einer Transaktion des Aufrufers, damit keiner verloren geht)
export async function takeWorkerRequests(db: Db): Promise<WorkerRequest[]> {
  const v = await db.value("SELECT meta_value FROM oys_meta WHERE meta_key = 'custom_domains_req' FOR UPDATE");
  if (v === null || v === undefined) return [];
  const raw = objOrNull<Record<string, unknown>>(jsonDecode(phpStr(v))) ?? {};
  await db.exec("DELETE FROM oys_meta WHERE meta_key = 'custom_domains_req'");
  return (['test', 'control'] as const).filter((k) => typeof raw[k] === 'string' && raw[k] !== '');
}
