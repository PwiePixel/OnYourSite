// Statusseiten: eine HTTP(S)-Prüfung (Entwurf §4.8.5). Jeder Schritt läuft über guard.ts und resolver.ts: Adresse
// prüfen, nur über die öffentlichen Resolver auflösen, JEDE Adresse prüfen, dann genau mit dieser Adresse verbinden
// (lookup fest vorgegeben, SNI und Zertifikat mit dem Namen) und nach dem Verbinden die Gegenstelle noch einmal prüfen.
// Weiterleitungen folgen wir selbst (höchstens 5, jeder Schritt wieder ganz geprüft). Es gibt eine Frist für alles, die
// Antwortzeit ist die Zeit bis zu den Kopfzeilen, den Inhalt lesen wir nur für ein Stichwort (höchstens keyword_kb,
// auch entpackt) – sonst wird die Verbindung nach den Kopfzeilen geschlossen. Was wir zurückgeben, ist nie Inhalt der
// Gegenseite, nur Status, Zeit, Ja/Nein und unser eigener Fehlerschlüssel.
import http, { type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import https from 'node:https';
import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import zlib from 'node:zlib';
import { ipVerdict, parseTarget, type GuardPolicy, type Target } from './guard.js';
import type { PublicResolver } from './resolver.js';

export interface HttpDeps {
  policy: GuardPolicy;
  resolver: PublicResolver;
  now: () => number; // ms
  ipv6: boolean; // erreicht dieser Server IPv6?
  userAgent: string;
  takeIp?: (ip: string, now: number) => number; // Eimer je IP (0 = ja, sonst Wartezeit in ms)
  loopBlocked?: () => boolean; // war die Ereignisschleife gerade blockiert (p99 > 1 s)?
  ca?: string | Buffer | Array<string | Buffer>; // nur Tests: eigene Zertifizierungsstelle
  signal?: AbortSignal; // Abbruch von außen (Sperre verloren, Ende des Dienstes)
}

export interface HttpCheckInput {
  url: string;
  method: 'GET' | 'HEAD';
  expect: string; // „200-299,301“
  keyword: string;
  keywordMode: 'contains' | 'absent';
  keywordCase: boolean;
  timeoutSec: number;
  redirects: boolean;
  tlsIgnore: boolean;
  slowMs: number;
  keywordKb: number;
  sameHostOnly?: boolean; // robots.txt: Weiterleitungen nur auf demselben Host
  readBody?: number; // robots.txt: so viele Bytes Inhalt lesen (ohne Stichwort)
}

export type HttpKind = 'ok' | 'fail' | 'internal' | 'delayed' | 'throttled';

export interface HttpOutcome {
  kind: HttpKind;
  ms: number | null; // bis zu den Kopfzeilen der letzten Antwort
  code: number | null;
  error: string | null; // Fehlerschlüssel (errors.ts)
  certExpires: number | null; // Unix
  retryAfter: number | null; // Sekunden (429, 503)
  refused: boolean; // 403/429
  slow: boolean;
  localError: boolean; // lokaler Socket-Fehler (für die Plattform-Sperre)
  dnsTransient: boolean; // DNS: der Resolver hat nicht geantwortet (unsere Seite, wenn auch der Kanarienvogel fällt)
  ip: string | null;
  host: string | null; // Host der letzten Anfrage
  wait: number | null; // throttled: Wartezeit in ms
  body?: string; // nur mit readBody
}

const LOCAL_ERRORS = new Set(['EMFILE', 'ENFILE', 'ENOBUFS', 'EADDRNOTAVAIL', 'ENETUNREACH', 'ENOMEM']);
const TLS_UNTRUSTED = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_UNTRUSTED', 'CERT_SIGNATURE_FAILURE', 'CERT_NOT_YET_VALID', 'CERT_REVOKED', 'INVALID_CA', 'CERT_REJECTED']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

// ---------------------------------------------------------------- erwartete Statuscodes

export type CodeRange = [number, number];

// „200-299,301,401“: bis zu 10 Codes oder Bereiche zwischen 100 und 599; sonst null
export function parseExpect(s: string): CodeRange[] | null {
  const parts = s.split(',').map((p) => p.trim()).filter((p) => p !== '');
  if (!parts.length || parts.length > 10) return null;
  const out: CodeRange[] = [];
  for (const p of parts) {
    const m = /^(\d{3})(?:-(\d{3}))?$/.exec(p);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (a < 100 || b > 599 || b < a) return null;
    out.push([a, b]);
  }
  return out;
}

export const expectMatches = (code: number, ranges: CodeRange[]): boolean => ranges.some(([a, b]) => code >= a && code <= b);

// Retry-After: Sekunden oder ein HTTP-Datum
export function retryAfterSeconds(v: string | string[] | undefined, nowMs: number): number | null {
  const s = Array.isArray(v) ? v[0] : v;
  if (s === undefined) return null;
  const t = s.trim();
  if (/^\d{1,9}$/.test(t)) return Number(t);
  const d = Date.parse(t);
  return Number.isFinite(d) ? Math.max(0, Math.ceil((d - nowMs) / 1000)) : null;
}

const isText = (ct: string): boolean => {
  const type = ct.split(';')[0].trim().toLowerCase();
  return type.startsWith('text/') || type === 'application/json' || type === 'application/xml' || /^[a-z0-9.+-]+\/[a-z0-9.+-]+\+(xml|json)$/.test(type);
};

// ---------------------------------------------------------------- ein einzelner Schritt

interface Hop {
  status: number;
  headers: IncomingMessage['headers'];
  ms: number;
  certExpires: number | null;
  body: string | null;
  bodyTooBig: boolean;
}

class HopError extends Error {
  constructor(readonly key: string, readonly local = false) {
    super(key);
  }
}

function classify(err: unknown): HopError {
  if (err instanceof HopError) return err;
  const code = (err as { code?: string }).code ?? '';
  if (LOCAL_ERRORS.has(code)) return new HopError('internal', true);
  if (code === 'CERT_HAS_EXPIRED') return new HopError('tls_expired');
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID' || code === 'HOSTNAME_MISMATCH') return new HopError('tls_name');
  if (TLS_UNTRUSTED.has(code)) return new HopError('tls_untrusted');
  if (code.startsWith('ERR_SSL') || code.startsWith('ERR_TLS')) return new HopError('tls');
  if (code === 'ABORT_ERR' || code === 'ERR_CANCELED') return new HopError('timeout');
  return new HopError('connect');
}

function oneHop(target: Target, address: string, method: string, input: HttpCheckInput, deps: HttpDeps, startMs: number, signal: AbortSignal): Promise<Hop> {
  const family = address.includes(':') ? 6 : 4;
  const wantBody = method === 'GET' && (input.keyword !== '' || (input.readBody ?? 0) > 0);
  const maxBytes = input.keyword !== '' ? input.keywordKb * 1024 : (input.readBody ?? 0);
  const headers: OutgoingHttpHeaders = {
    'User-Agent': deps.userAgent,
    Accept: '*/*',
    'Accept-Encoding': input.keyword !== '' && method === 'GET' ? 'gzip, deflate, br' : 'identity',
    Connection: 'close',
    'Cache-Control': 'no-cache',
  };
  const mod = target.scheme === 'https' ? https : http;
  return new Promise<Hop>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void): void => {
      if (!settled) {
        settled = true;
        fn();
      }
    };
    let certExpires: number | null = null;
    const req = mod.request({
      host: target.host,
      port: target.port,
      path: target.path,
      method,
      headers,
      agent: false,
      family,
      // Genau die geprüfte Adresse (Node fragt mit { all: true }, wenn autoSelectFamily an ist)
      lookup: (_name: string, opts: unknown, cb: (...args: unknown[]) => void) => {
        if (opts && typeof opts === 'object' && (opts as { all?: boolean }).all) cb(null, [{ address, family }]);
        else cb(null, address, family);
      },
      ...(target.scheme === 'https' ? {
        servername: target.ip ? undefined : target.host,
        rejectUnauthorized: !input.tlsIgnore,
        ca: deps.ca,
      } : {}),
      signal,
    } as http.RequestOptions & https.RequestOptions);

    req.on('socket', (sock: Socket) => {
      const verify = (): void => {
        const remote = (sock.remoteAddress ?? '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
        if (remote !== address || !ipVerdict(remote, target.port, deps.policy).ok) req.destroy(new HopError('blocked'));
      };
      sock.once('connect', verify);
      sock.once('secureConnect', () => {
        verify();
        try {
          const cert = (sock as TLSSocket).getPeerCertificate?.();
          if (cert && cert.valid_to) {
            const t = Date.parse(cert.valid_to);
            if (Number.isFinite(t)) certExpires = Math.floor(t / 1000);
          }
        } catch {
          certExpires = null;
        }
      });
    });
    req.on('error', (err) => done(() => reject(signal.aborted ? new HopError('timeout') : classify(err))));
    req.on('response', (res) => {
      const ms = deps.now() - startMs;
      const status = res.statusCode ?? 0;
      if (!wantBody || REDIRECTS.has(status)) {
        res.destroy();
        req.destroy();
        done(() => resolve({ status, headers: res.headers, ms, certExpires, body: null, bodyTooBig: false }));
        return;
      }
      const ct = String(res.headers['content-type'] ?? '');
      if (input.keyword !== '' && !isText(ct)) {
        res.destroy();
        req.destroy();
        done(() => resolve({ status, headers: res.headers, ms, certExpires, body: null, bodyTooBig: false }));
        return;
      }
      // Entpacken mit Grenze: mehr als maxBytes → aufhören und im Gelesenen suchen
      const enc = String(res.headers['content-encoding'] ?? '').trim().toLowerCase();
      let stream: NodeJS.ReadableStream = res;
      if (input.keyword !== '') {
        if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let tooBig = false;
      const finish = (): void => {
        res.destroy();
        req.destroy();
        const buf = Buffer.concat(chunks, Math.min(size, maxBytes));
        done(() => resolve({ status, headers: res.headers, ms, certExpires, body: buf.toString('utf8'), bodyTooBig: tooBig }));
      };
      stream.on('data', (c: Buffer) => {
        if (settled) return;
        chunks.push(c);
        size += c.length;
        if (size >= maxBytes) {
          tooBig = size > maxBytes;
          (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
          finish();
        }
      });
      stream.on('end', finish);
      stream.on('error', () => {
        // kaputte Kompression: was gelesen wurde, zählt
        finish();
      });
      res.on('aborted', finish);
    });
    req.end();
  });
}

// ---------------------------------------------------------------- die ganze Prüfung

const base = (o: Partial<HttpOutcome>): HttpOutcome => ({
  kind: 'fail', ms: null, code: null, error: null, certExpires: null, retryAfter: null, refused: false, slow: false, localError: false,
  dnsTransient: false, ip: null, host: null, wait: null, ...o,
});

export async function runHttpCheck(input: HttpCheckInput, deps: HttpDeps): Promise<HttpOutcome> {
  const start = deps.now();
  const deadline = Math.max(1, input.timeoutSec) * 1000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deadline);
  const onOuterAbort = (): void => ctrl.abort();
  deps.signal?.addEventListener('abort', onOuterAbort, { once: true });
  const ranges = parseExpect(input.expect) ?? [[200, 299]];
  let url = input.url;
  const visited = new Set<string>();
  let method: 'GET' | 'HEAD' = input.method;
  let certExpires: number | null = null;
  let lastIp: string | null = null;
  let lastHost: string | null = null;
  try {
    for (let hop = 0; ; hop++) {
      const target = parseTarget(url, deps.policy);
      if (!target.ok) return base({ error: hop === 0 ? 'blocked' : 'redirect_blocked', ms: null, host: lastHost });
      lastHost = target.host;
      const resolved = await deps.resolver.resolvePublic(target.host, target.port, deps.policy);
      if (ctrl.signal.aborted) throw new HopError('timeout');
      if (!resolved.ok) {
        if (resolved.error === 'blocked') return base({ error: hop === 0 ? 'blocked' : 'redirect_blocked', host: target.host });
        return base({ error: 'dns', dnsTransient: resolved.transient, host: target.host });
      }
      if (resolved.family === 6 && !deps.ipv6) return base({ error: 'ipv6', host: target.host });
      const ip = resolved.addresses[Math.floor(Math.random() * resolved.addresses.length)];
      lastIp = ip;
      if (deps.takeIp) {
        const wait = deps.takeIp(ip, deps.now());
        if (wait > 0) return base({ kind: 'throttled', wait, ip, host: target.host });
      }
      visited.add(target.url);
      const res = await oneHop(target, ip, method, input, deps, start, ctrl.signal);
      if (res.certExpires !== null) certExpires = res.certExpires;
      const location = res.headers.location;
      if (input.redirects && REDIRECTS.has(res.status) && typeof location === 'string' && location !== '') {
        let next: string;
        try {
          next = new URL(location, target.url).href;
        } catch {
          return base({ error: 'redirect_blocked', code: res.status, ms: res.ms, certExpires, ip, host: target.host });
        }
        const nextTarget = parseTarget(next, deps.policy);
        if (!nextTarget.ok || (input.sameHostOnly && nextTarget.host !== target.host)) {
          return base({ error: 'redirect_blocked', code: res.status, ms: res.ms, certExpires, ip, host: target.host });
        }
        if (hop + 1 > MAX_REDIRECTS || visited.has(nextTarget.url)) {
          return base({ error: 'redirect', code: res.status, ms: res.ms, certExpires, ip, host: target.host });
        }
        if (res.status === 303) method = 'GET';
        url = nextTarget.url;
        continue;
      }
      // Antwort der letzten Station
      const code = res.status;
      const retryAfter = retryAfterSeconds(res.headers['retry-after'], deps.now());
      const refused = code === 403 || code === 429;
      if (code === 429) return base({ kind: 'delayed', code, ms: res.ms, retryAfter: retryAfter ?? 60, refused, certExpires, ip, host: target.host });
      const out = { code, ms: res.ms, certExpires, ip, host: target.host, refused, retryAfter: code === 503 ? retryAfter : null };
      if (!expectMatches(code, ranges)) return base({ ...out, error: 'status' });
      if (input.keyword !== '' && method === 'GET') {
        if (res.body === null) return base({ ...out, error: 'keyword_type' });
        const hay = input.keywordCase ? res.body : res.body.toLowerCase();
        const needle = input.keywordCase ? input.keyword : input.keyword.toLowerCase();
        const found = hay.includes(needle);
        if (input.keywordMode === 'contains' && !found) return base({ ...out, error: 'keyword' });
        if (input.keywordMode === 'absent' && found) return base({ ...out, error: 'keyword_found' });
      }
      const slow = input.slowMs > 0 && res.ms > input.slowMs;
      return base({ ...out, kind: 'ok', slow, ...(input.readBody ? { body: res.body ?? '' } : {}) });
    }
  } catch (err) {
    const e = classify(err);
    if (deps.signal?.aborted) return base({ kind: 'internal', error: 'internal', ip: lastIp, host: lastHost });
    if (e.local) return base({ kind: 'internal', error: 'internal', localError: true, ip: lastIp, host: lastHost });
    if (e.key === 'timeout' && deps.loopBlocked?.()) return base({ kind: 'internal', error: 'internal', ip: lastIp, host: lastHost });
    return base({ error: e.key, certExpires, ip: lastIp, host: lastHost });
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', onOuterAbort);
  }
}
