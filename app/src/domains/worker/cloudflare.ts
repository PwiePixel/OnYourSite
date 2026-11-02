// Kleiner Client für Cloudflare for SaaS (nur im Domain-Dienst): eigene Hostnamen der Zone, Kontingent, Rückfall-
// Ursprung und die IP-Bereiche. Das Token kommt aus dem systemd-Credential (cf_saas_token) und erreicht nie die
// Website; es steht in keiner Meldung und keinem Protokoll. Grenzen: 15 s je Aufruf, höchstens 400 Aufrufe in
// 5 Minuten (ein Drittel des Limits von Cloudflare), nach 429 Pause bis Retry-After.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configString } from '../../config.js';
import { phpTrim, strtolower } from '../../php.js';

export const CF_API_DEFAULT = 'https://api.cloudflare.com/client/v4';
const TIMEOUT_MS = 15_000;
const BUDGET = 400;
const BUDGET_WINDOW_MS = 5 * 60_000;

// Cloudflare (oder der Weg dorthin) gerade nicht erreichbar: 5xx, Netz, Zeitlimit, 429, eigenes Budget – später erneut
export class CfUnavailable extends Error {}
// Antwort mit Fehler (4xx): code und Text von Cloudflare
export class CfError extends Error {
  constructor(readonly status: number, readonly code: number, message: string) {
    super(message);
  }
}
// Das Token gilt nicht (mehr) oder darf das nicht (401/403, Fehler 10000)
export class CfAuthError extends CfError {}

export interface CfValidationRecord {
  txt_name?: string;
  txt_value?: string;
  cname?: string;
  cname_target?: string;
  http_url?: string;
  status?: string;
}

export interface CfHostname {
  id: string;
  hostname: string;
  status: string; // active, pending, active_redeploying, moved, deleted, blocked …
  created_at?: string;
  verification_errors?: string[];
  ownership_verification?: { type?: string; name?: string; value?: string };
  ssl?: {
    status?: string; // active, pending_validation, expired …
    method?: string;
    type?: string;
    expires_on?: string;
    validation_errors?: Array<{ message?: string }>;
    validation_records?: CfValidationRecord[];
    dcv_delegation_records?: CfValidationRecord[];
  };
}

export interface CfQuota {
  allocated: number;
  used: number;
  exceeded: boolean;
  hard_cap: number;
}

export interface CloudflareOptions {
  base: string; // ohne / am Ende, z. B. https://api.cloudflare.com/client/v4
  zone: string;
  token: string;
  fetchImpl?: typeof fetch;
  clock?: () => number;
  timeoutMs?: number;
}

// Token aus dem systemd-Credential ($CREDENTIALS_DIRECTORY/cf_saas_token); nur für Tests ein eigener Pfad
export function cfToken(env: NodeJS.ProcessEnv = process.env): string {
  const file = configString('custom_domains.token_file') !== ''
    ? configString('custom_domains.token_file')
    : env.CREDENTIALS_DIRECTORY ? join(env.CREDENTIALS_DIRECTORY, 'cf_saas_token') : '';
  if (file === '') return '';
  try {
    return phpTrim(readFileSync(file, 'utf8'));
  } catch {
    return '';
  }
}

export function cloudflareFromConfig(fetchImpl?: typeof fetch): Cloudflare {
  return new Cloudflare({
    base: (configString('cloudflare.api_base') || CF_API_DEFAULT).replace(/\/+$/, ''),
    zone: configString('cloudflare.zone_id'),
    token: cfToken(),
    fetchImpl,
  });
}

interface Envelope {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: unknown;
  result_info?: { page?: number; total_pages?: number; count?: number; total_count?: number };
}

export class Cloudflare {
  private calls: number[] = [];
  private pausedUntil = 0;
  calls5min = 0;

  constructor(private readonly o: CloudflareOptions) {}

  get configured(): boolean {
    return this.o.token !== '' && /^[0-9a-f]{32}$/.test(this.o.zone);
  }

  private now(): number {
    return (this.o.clock ?? Date.now)();
  }

  // Ein Aufruf. auth = false: öffentlich (IP-Bereiche), ohne Token
  private async call(method: string, path: string, body?: unknown, opts: { auth?: boolean; allow404?: boolean } = {}): Promise<Envelope | null> {
    const now = this.now();
    if (now < this.pausedUntil) throw new CfUnavailable('Cloudflare asked us to slow down');
    this.calls = this.calls.filter((t) => now - t < BUDGET_WINDOW_MS);
    if (this.calls.length >= BUDGET) throw new CfUnavailable('call budget for the last 5 minutes used up');
    this.calls.push(now);
    this.calls5min = this.calls.length;
    if (opts.auth !== false && this.o.token === '') throw new CfAuthError(0, 0, 'The Cloudflare token is missing.');
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.auth !== false) headers.Authorization = 'Bearer ' + this.o.token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await (this.o.fetchImpl ?? fetch)(this.o.base + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error',
        signal: AbortSignal.timeout(this.o.timeoutMs ?? TIMEOUT_MS),
      });
    } catch (err) {
      throw new CfUnavailable(`no answer from Cloudflare (${err instanceof Error ? err.name : 'error'})`);
    }
    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after'));
      this.pausedUntil = this.now() + (Number.isFinite(after) && after > 0 ? Math.min(after, 3600) : 60) * 1000;
      await res.body?.cancel().catch(() => undefined);
      throw new CfUnavailable('Cloudflare answered 429');
    }
    if (res.status >= 500) {
      await res.body?.cancel().catch(() => undefined);
      throw new CfUnavailable(`Cloudflare answered ${res.status}`);
    }
    let env: Envelope;
    try {
      // Antworten sind klein; mehr als 4 MB ist nie eine echte Antwort
      const text = await res.text();
      if (text.length > 4_000_000) throw new Error('too large');
      env = text === '' ? {} : (JSON.parse(text) as Envelope);
    } catch {
      throw new CfUnavailable(`unreadable answer from Cloudflare (${res.status})`);
    }
    if (res.status === 404 && opts.allow404) return null;
    if (res.status >= 400 || env.success === false) {
      const first = env.errors?.[0] ?? {};
      const code = Number(first.code ?? 0);
      const message = String(first.message ?? `Cloudflare answered ${res.status}`).slice(0, 300);
      if (res.status === 401 || res.status === 403 || code === 10000 || code === 9109) throw new CfAuthError(res.status, code, message);
      throw new CfError(res.status, code, message);
    }
    return env;
  }

  private zonePath(rest: string): string {
    return '/zones/' + encodeURIComponent(this.o.zone) + rest;
  }

  // Ein Hostname (null = gibt es nicht mehr; zählt wie „deleted“)
  async getHostname(id: string): Promise<CfHostname | null> {
    const env = await this.call('GET', this.zonePath('/custom_hostnames/' + encodeURIComponent(id)), undefined, { allow404: true });
    return env ? asHostname(env.result) : null;
  }

  // Hostname nach Namen (vor dem Anlegen: übernehmen statt doppelt anlegen)
  async findHostname(hostname: string): Promise<CfHostname | null> {
    const env = await this.call('GET', this.zonePath('/custom_hostnames?hostname=' + encodeURIComponent(hostname)));
    const list = Array.isArray(env?.result) ? env.result : [];
    for (const item of list) {
      const h = asHostname(item);
      if (h && h.hostname === hostname) return h;
    }
    return null;
  }

  // Eine Seite der Liste aller Hostnamen (bis 1000 je Aufruf)
  async listHostnames(page: number, perPage = 1000): Promise<{ items: CfHostname[]; totalPages: number }> {
    const env = await this.call('GET', this.zonePath(`/custom_hostnames?per_page=${perPage}&page=${page}`));
    const items = (Array.isArray(env?.result) ? env.result : []).map(asHostname).filter((h): h is CfHostname => h !== null);
    return { items, totalPages: Math.max(1, Number(env?.result_info?.total_pages ?? 1) || 1) };
  }

  // Alle Hostnamen (Seite für Seite)
  async allHostnames(): Promise<CfHostname[]> {
    const out: CfHostname[] = [];
    for (let page = 1; page <= 200; page++) {
      const { items, totalPages } = await this.listHostnames(page);
      out.push(...items);
      if (page >= totalPages || items.length === 0) break;
    }
    return out;
  }

  // Anlegen (HTTP-Prüfung des Zertifikats). Gibt es den Namen schon (z. B. ein abgebrochener früherer Versuch), wird er
  // übernommen – der Besitz ist zu diesem Zeitpunkt schon über den TXT-Eintrag bewiesen.
  async createHostname(hostname: string): Promise<{ hostname: CfHostname; adopted: boolean }> {
    const existing = await this.findHostname(hostname);
    if (existing) return { hostname: existing, adopted: true };
    try {
      const env = await this.call('POST', this.zonePath('/custom_hostnames'),
        { hostname, ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } } });
      const h = asHostname(env?.result);
      if (!h) throw new CfUnavailable('Cloudflare returned no hostname');
      return { hostname: h, adopted: false };
    } catch (err) {
      // Doppelt (gleichzeitig angelegt): übernehmen
      if (err instanceof CfError && !(err instanceof CfAuthError)) {
        const again = await this.findHostname(hostname);
        if (again) return { hostname: again, adopted: true };
      }
      throw err;
    }
  }

  // PATCH mit dem ssl-Objekt: dasselbe noch einmal (setzt die Wartezeit der Prüfung zurück) oder TXT statt HTTP (Apex)
  async patchSsl(id: string, ssl: Record<string, unknown>): Promise<CfHostname | null> {
    const env = await this.call('PATCH', this.zonePath('/custom_hostnames/' + encodeURIComponent(id)), { ssl });
    return asHostname(env?.result);
  }

  // Löschen (entzieht auch die Zertifikate); 404 heißt: schon weg
  async deleteHostname(id: string): Promise<void> {
    await this.call('DELETE', this.zonePath('/custom_hostnames/' + encodeURIComponent(id)), undefined, { allow404: true });
  }

  async quota(): Promise<CfQuota> {
    const env = await this.call('GET', this.zonePath('/custom_hostnames/quota'));
    const r = (env?.result ?? {}) as Record<string, unknown>;
    return { allocated: Number(r.allocated ?? 0) || 0, used: Number(r.used ?? 0) || 0, exceeded: r.exceeded === true, hard_cap: Number(r.hard_cap ?? 0) || 0 };
  }

  async fallbackOrigin(): Promise<{ origin: string; status: string; errors: string[] }> {
    const env = await this.call('GET', this.zonePath('/custom_hostnames/fallback_origin'), undefined, { allow404: true });
    const r = (env?.result ?? {}) as Record<string, unknown>;
    return { origin: String(r.origin ?? ''), status: String(r.status ?? ''), errors: Array.isArray(r.errors) ? r.errors.map(String) : [] };
  }

  // Öffentliche IP-Bereiche von Cloudflare (ohne Token)
  async ips(): Promise<{ v4: string[]; v6: string[] }> {
    const env = await this.call('GET', '/ips', undefined, { auth: false });
    const r = (env?.result ?? {}) as Record<string, unknown>;
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    return { v4: list(r.ipv4_cidrs), v6: list(r.ipv6_cidrs) };
  }
}

// Ergebnis → Hostname (nur Felder mit passendem Typ)
function asHostname(v: unknown): CfHostname | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.hostname !== 'string') return null;
  const ssl = r.ssl !== null && typeof r.ssl === 'object' ? (r.ssl as CfHostname['ssl']) : undefined;
  const errors = Array.isArray(r.verification_errors) ? r.verification_errors.filter((x): x is string => typeof x === 'string') : [];
  return {
    id: r.id, hostname: strtolower(r.hostname), status: typeof r.status === 'string' ? r.status : '',
    created_at: typeof r.created_at === 'string' ? r.created_at : undefined, verification_errors: errors,
    ownership_verification: r.ownership_verification as CfHostname['ownership_verification'], ssl,
  };
}
