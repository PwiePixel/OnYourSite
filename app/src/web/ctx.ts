// Eine Anfrage mit allem, was PHP-Code über $_GET, $_POST, $_FILES, $_COOKIE und $_SERVER gesehen hat, und die
// Antwort mit den Regeln von header(): gleicher Name ersetzt, Standard-Typ text/html; charset=UTF-8.
import type { IncomingHttpHeaders } from 'node:http';
import type { Readable } from 'node:stream';
import { parseStr, type PhpArray, field, strtolower } from '../php.js';
import { phpParseUrl } from '../compat/core.js';
import type { Session } from './session.js';

// exit; in PHP: beendet die Bearbeitung, die Antwort wird so gesendet, wie sie bis dahin aufgebaut ist
export class Halt {
  readonly halt = true;
}
export const isHalt = (err: unknown): err is Halt => !!err && typeof err === 'object' && (err as Halt).halt === true;

export interface UploadedFile {
  name: string;
  type: string;
  size: number;
  data: Buffer;
  // UPLOAD_ERR_*: 0 = OK, 1 = zu groß, 4 = keine Datei
  error: number;
}

export class Ctx {
  readonly method: string;
  readonly rawUrl: string;
  // REQUEST_URI bis zum ersten ?, nicht dekodiert
  readonly rawPath: string;
  // Pfad wie parse_url(REQUEST_URI, PHP_URL_PATH) ?: '/' – nie dekodiert
  readonly path: string;
  readonly queryString: string;
  readonly host: string;
  readonly hostHeader: string;
  readonly headers: IncomingHttpHeaders;
  readonly ip: string;
  readonly get: PhpArray;
  post: PhpArray = {};
  files: Record<string, UploadedFile> = {};
  rawBody: Buffer = Buffer.alloc(0);
  readonly cookies: Record<string, string>;
  session: Session | null = null;
  // Zwischenspeicher für diese Anfrage (z. B. der angemeldete Nutzer)
  readonly locals: Record<string, unknown> = {};

  status = 200;
  private resHeaders: Array<[string, string]> = [];
  // Antwort: Text, Bytes oder ein Datenstrom (große Dateien, ZIP)
  body: string | Buffer | Readable = '';

  constructor(opts: { method: string; url: string; headers: IncomingHttpHeaders; peer: string }) {
    this.method = opts.method.toUpperCase();
    this.rawUrl = opts.url || '/';
    this.rawPath = this.rawUrl.split('?')[0];
    this.headers = opts.headers;
    const parsed = phpParseUrl(this.rawUrl) as false | { path?: string; query?: string };
    this.path = parsed === false || !parsed.path ? '/' : parsed.path;
    const q = this.rawUrl.indexOf('?');
    const hashless = this.rawUrl.split('#')[0];
    this.queryString = q >= 0 ? hashless.slice(hashless.indexOf('?') + 1) : '';
    this.get = parseStr(this.queryString);
    this.hostHeader = String(opts.headers.host ?? '');
    // oys_request_host(): Host klein (nur ASCII), ohne :Port
    this.host = strtolower(this.hostHeader).split(':')[0];
    this.cookies = parseCookies(String(opts.headers.cookie ?? ''));
    this.ip = clientIp(opts.peer, opts.headers);
  }

  header(name: string): string | undefined;
  header(name: string, value: string, replace?: boolean): void;
  // header(): ein gleichnamiger Header wird ersetzt (Set-Cookie darf mehrfach vorkommen)
  header(name: string, value?: string, replace = true): string | undefined | void {
    const lower = name.toLowerCase();
    if (value === undefined) return this.resHeaders.find(([n]) => n.toLowerCase() === lower)?.[1];
    if (replace && lower !== 'set-cookie') this.resHeaders = this.resHeaders.filter(([n]) => n.toLowerCase() !== lower);
    this.resHeaders.push([name, value]);
  }

  removeHeader(name: string): void {
    const lower = name.toLowerCase();
    this.resHeaders = this.resHeaders.filter(([n]) => n.toLowerCase() !== lower);
  }

  // Ein früheres Set-Cookie für genau dieses Cookie entfernen (andere Cookies bleiben)
  removeCookieHeader(cookieName: string): void {
    this.resHeaders = this.resHeaders.filter(([n, v]) => n.toLowerCase() !== 'set-cookie' || !v.startsWith(cookieName + '='));
  }

  headersOut(): Array<[string, string]> {
    const out = [...this.resHeaders];
    if (!out.some(([n]) => n.toLowerCase() === 'content-type')) out.push(['Content-Type', 'text/html; charset=UTF-8']);
    return out;
  }

  // echo …
  write(chunk: string | { toString(): string }): void {
    const s = typeof chunk === 'string' ? chunk : chunk.toString();
    if (typeof this.body === 'string') this.body += s;
    else if (Buffer.isBuffer(this.body)) this.body = Buffer.concat([this.body, Buffer.from(s, 'utf8')]);
    else throw new Error('write() after a stream body');
  }

  // echo …; exit – mit optionalem Status
  send(body: string | { toString(): string } | Buffer | Readable, status?: number): never {
    if (status !== undefined) this.status = status;
    this.body = typeof body === 'string' || Buffer.isBuffer(body) || isReadable(body) ? body : body.toString();
    this.halt();
  }

  // exit
  halt(): never {
    throw new Halt();
  }

  // oys_redirect(): Location mit den UTF-8-Bytes, Status, leerer Inhalt
  redirect(url: string, code = 302): never {
    this.status = code;
    this.header('Location', Buffer.from(url, 'utf8').toString('latin1'));
    this.body = '';
    this.halt();
  }

  // oys_json(): JSON ohne maskierte Schrägstriche und Umlaute, nie im Cache
  json(data: unknown, code = 200, encode: (v: unknown) => string = defaultJson): never {
    this.status = code;
    this.header('Content-Type', 'application/json; charset=utf-8');
    this.header('Cache-Control', 'no-store');
    this.body = encode(data);
    this.halt();
  }

  // (string) ($_GET['x'] ?? '') bzw. ($_POST …)
  q(name: string, fallback = ''): string {
    return field(this.get, name, fallback);
  }
  p(name: string, fallback = ''): string {
    return field(this.post, name, fallback);
  }
  has(src: 'get' | 'post', name: string): boolean {
    return (src === 'get' ? this.get : this.post)[name] !== undefined;
  }

  cookie(name: string): string | undefined {
    return this.cookies[name];
  }

  userAgent(): string {
    return String(this.headers['user-agent'] ?? '');
  }
}

function isReadable(v: unknown): v is Readable {
  return !!v && typeof v === 'object' && typeof (v as Readable).pipe === 'function' && typeof (v as Readable).on === 'function';
}

// Für Tests: eine Anfrage ohne Server
export function makeTestCtx(o: { method?: string; url: string; host?: string; headers?: Record<string, string>; post?: PhpArray;
  files?: Record<string, UploadedFile>; cookies?: Record<string, string>; ip?: string; rawBody?: Buffer }): Ctx {
  const headers: IncomingHttpHeaders = { host: o.host ?? 'oys.test:8080', ...(o.headers ?? {}) };
  if (o.cookies) headers.cookie = Object.entries(o.cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
  const ctx = new Ctx({ method: o.method ?? 'GET', url: o.url, headers, peer: o.ip ?? '127.0.0.1' });
  if (o.post) ctx.post = o.post;
  if (o.files) ctx.files = o.files;
  if (o.rawBody) ctx.rawBody = o.rawBody;
  return ctx;
}

function defaultJson(v: unknown): string {
  return JSON.stringify(v).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

// $_COOKIE: bei doppelten Namen gilt der erste; Werte werden dekodiert
export function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (!name || name in out) continue;
    let value = part.slice(i + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      /* roh lassen */
    }
    out[name] = value;
  }
  return out;
}

// REMOTE_ADDR wie mit mod_remoteip: CF-Connecting-IP nur, wenn die Anfrage vom eigenen cloudflared kommt
function clientIp(peer: string, headers: IncomingHttpHeaders): string {
  let ip = peer || '';
  if (ip.startsWith('::ffff:') && /^::ffff:\d+\.\d+\.\d+\.\d+$/.test(ip)) ip = ip.slice(7);
  if (ip === '127.0.0.1' || ip === '::1') {
    const cf = headers['cf-connecting-ip'];
    const v = Array.isArray(cf) ? cf[0] : cf;
    if (v && /^[0-9a-fA-F:.]+$/.test(v.trim())) return v.trim();
  }
  return ip;
}
