// Nachgebautes Cloudflare for SaaS für die Tests des Domain-Dienstes (node:http, zufälliger Port): eigene Hostnamen
// (anlegen, lesen, Liste, PATCH, löschen), Kontingent, Rückfall-Ursprung und die IP-Bereiche – mit Schaltern für
// Fehler (5xx, 429 mit Retry-After, ungültiges Token) und einem Zähler aller Aufrufe. Nichts geht an Cloudflare.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';

export interface MockHostname {
  id: string;
  hostname: string;
  status: string;
  ssl: { status: string; method: string; type: string; validation_errors?: Array<{ message: string }>; dcv_delegation_records?: unknown[] };
  verification_errors: string[];
  created_at: string;
}

export interface CfCall {
  method: string;
  path: string;
  body: unknown;
}

export interface CfSaasMock {
  base: string; // http://127.0.0.1:<port>/client/v4
  zone: string;
  token: string;
  hostnames: Map<string, MockHostname>;
  calls: CfCall[];
  quota: { allocated: number; hard_cap: number };
  fallback: { origin: string; status: string };
  ips: { v4: string[]; v6: string[] };
  // Die nächsten n Antworten mit diesem Status (429 mit Retry-After: 1)
  failNext(status: number, times?: number): void;
  // Ungültiges Token ab jetzt (403, Fehler 10000)
  rejectToken: boolean;
  // Wird beim Anlegen aufgerufen (z. B. um die Zeile im Test zu ändern, während der Dienst anlegt)
  onCreate: ((h: MockHostname) => Promise<void> | void) | null;
  // Zustand eines Hostnamens setzen (Cloudflare-Seite)
  set(hostname: string, change: { status?: string; ssl?: string; errors?: string[]; sslErrors?: string[] }): void;
  count(method: string, pathPart?: string): number;
  close(): Promise<void>;
}

const now = (): string => new Date().toISOString();

export async function startCfSaasMock(): Promise<CfSaasMock> {
  const zone = randomBytes(16).toString('hex');
  // Token zur Laufzeit erzeugt (kein fester Wert im Repository)
  const token = 'tok-' + randomBytes(12).toString('hex');
  const hostnames = new Map<string, MockHostname>();
  const calls: CfCall[] = [];
  let failStatus = 0;
  let failTimes = 0;
  const mock: Omit<CfSaasMock, 'base' | 'close'> & { base: string; close: () => Promise<void> } = {
    base: '', zone, token, hostnames, calls, quota: { allocated: 100, hard_cap: 200 }, fallback: { origin: 'origin.oys.test', status: 'active' },
    ips: { v4: ['173.245.48.0/20', '104.16.0.0/13'], v6: ['2606:4700::/32'] },
    rejectToken: false, onCreate: null,
    failNext(status, times = 1) {
      failStatus = status;
      failTimes = times;
    },
    set(hostname, change) {
      for (const h of hostnames.values()) {
        if (h.hostname !== hostname) continue;
        if (change.status !== undefined) h.status = change.status;
        if (change.ssl !== undefined) h.ssl.status = change.ssl;
        if (change.errors !== undefined) h.verification_errors = change.errors;
        if (change.sslErrors !== undefined) h.ssl.validation_errors = change.sslErrors.map((message) => ({ message }));
      }
    },
    count(method, pathPart = '') {
      return calls.filter((c) => c.method === method && c.path.includes(pathPart)).length;
    },
    close: async () => undefined,
  };

  const send = (res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void => {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers });
    res.end(body);
  };
  const ok = (res: ServerResponse, result: unknown, extra: Record<string, unknown> = {}): void =>
    send(res, 200, { success: true, errors: [], messages: [], result, ...extra });
  const err = (res: ServerResponse, status: number, code: number, message: string): void =>
    send(res, status, { success: false, errors: [{ code, message }], messages: [], result: null });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    const method = req.method ?? 'GET';
    calls.push({ method, path: url.pathname + url.search, body });
    if (failTimes > 0) {
      failTimes--;
      if (failStatus === 429) return send(res, 429, { success: false, errors: [{ code: 10100, message: 'rate limited' }] }, { 'Retry-After': '1' });
      return send(res, failStatus, { success: false, errors: [{ code: 1000, message: 'upstream error' }] });
    }
    const p = url.pathname.split('/').filter(Boolean); // client, v4, …
    if (p[0] !== 'client' || p[1] !== 'v4') return err(res, 404, 7000, 'No route for that URI');
    const rest = p.slice(2);
    if (rest.length === 1 && rest[0] === 'ips' && method === 'GET') return ok(res, { ipv4_cidrs: mock.ips.v4, ipv6_cidrs: mock.ips.v6, etag: 'x' });
    if (req.headers.authorization !== 'Bearer ' + token || mock.rejectToken) return err(res, 403, 10000, 'Authentication error');
    if (rest[0] !== 'zones' || rest[1] !== zone || rest[2] !== 'custom_hostnames') return err(res, 404, 7000, 'No route for that URI');
    const sub = rest.slice(3);
    if (sub.length === 0 && method === 'GET') {
      const want = url.searchParams.get('hostname');
      const all = [...hostnames.values()].filter((h) => want === null || h.hostname === want);
      const per = Math.max(5, Math.min(1000, Number(url.searchParams.get('per_page') ?? 20) || 20));
      const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
      return ok(res, all.slice((page - 1) * per, page * per), { result_info: { page, per_page: per, total_count: all.length, total_pages: Math.max(1, Math.ceil(all.length / per)) } });
    }
    if (sub.length === 0 && method === 'POST') {
      const b = (body ?? {}) as { hostname?: string; ssl?: { method?: string; type?: string } };
      const name = String(b.hostname ?? '');
      if ([...hostnames.values()].some((h) => h.hostname === name)) return err(res, 409, 1406, 'Duplicate custom hostname found.');
      if (hostnames.size >= mock.quota.hard_cap) return err(res, 400, 1442, 'Custom hostname quota reached.');
      const h: MockHostname = {
        id: randomBytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'), hostname: name, status: 'pending',
        ssl: { status: 'pending_validation', method: b.ssl?.method ?? 'http', type: b.ssl?.type ?? 'dv' }, verification_errors: [], created_at: now(),
      };
      hostnames.set(h.id, h);
      if (mock.onCreate) await mock.onCreate(h);
      return ok(res, h);
    }
    if (sub.length === 1 && sub[0] === 'quota' && method === 'GET') {
      const used = hostnames.size;
      return ok(res, { allocated: mock.quota.allocated, used, exceeded: used > mock.quota.allocated, hard_cap: mock.quota.hard_cap });
    }
    if (sub.length === 1 && sub[0] === 'fallback_origin' && method === 'GET') {
      return ok(res, { origin: mock.fallback.origin, status: mock.fallback.status, errors: [] });
    }
    if (sub.length === 1) {
      const h = hostnames.get(sub[0]);
      if (!h) return err(res, 404, 1436, 'The custom hostname was not found.');
      if (method === 'GET') return ok(res, h);
      if (method === 'DELETE') {
        hostnames.delete(h.id);
        return ok(res, { id: h.id });
      }
      if (method === 'PATCH') {
        const ssl = ((body ?? {}) as { ssl?: { method?: string; type?: string } }).ssl ?? {};
        if (ssl.method) h.ssl.method = ssl.method;
        if (ssl.type) h.ssl.type = ssl.type;
        return ok(res, h);
      }
    }
    return err(res, 404, 7000, 'No route for that URI');
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => err(res, 500, 1000, 'mock error'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  mock.base = `http://127.0.0.1:${port}/client/v4`;
  mock.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return mock as CfSaasMock;
}
