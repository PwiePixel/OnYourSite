// Anfragen an die Discord-API (Webhook und alter Bot-Token) und Discords Fehler als verständlicher Text.
// Gesendet wird nur an die feste Adresse (discord.com oder discord_api_base aus den Einstellungen): 10 s Zeitlimit,
// 5 s für den Verbindungsaufbau, keine Weiterleitungen, Antworten höchstens 1 MB.
import http from 'node:http';
import https from 'node:https';
import { config } from '../config.js';
import { baseHost, cleanText } from '../helpers.js';
import { jsonUnescaped } from '../html.js';
import { intval, phpRtrim, phpStr } from '../php.js';

export type Payload = Record<string, unknown>;
// status 0 = keine Antwort; dann steht der Grund in error (Text wie curl)
export interface DiscordResponse { status: number; data: Record<string, unknown> | null; code: number | null; error: string }
// webhook: Webhook-Link · token: alter Bot-Token, der noch auf der Website gespeichert ist
export type Via = 'webhook' | 'token';

const MAX_BODY = 1024 * 1024;

// oys_discord_base(): für Tests umstellbar (discord_api_base)
export function discordBase(): string {
  return phpRtrim(phpStr(config<unknown>('discord_api_base', 'https://discord.com/api')), '/');
}

// oys_discord_request()
export async function discordRequest(method: string, url: string, json: Payload | null = null, headers: string[] = []): Promise<DiscordResponse> {
  const body = json === null ? null : jsonUnescaped(json);
  // Discord verlangt dieses Format für den User-Agent
  const all = ['Content-Type: application/json', 'User-Agent: DiscordBot (https://' + baseHost() + ', 2.2)', ...headers];
  const res = await curlRequest(method, url, body, all);
  const data = res.body !== null && res.body.length ? jsonDecode(res.body) : null;
  const obj = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  const code = obj && obj.code !== undefined && obj.code !== null ? intval(obj.code) : null;
  return { status: res.status, data: obj, code, error: res.error };
}

// Kurzer Grund für „keine Antwort“ aus dem Fehlertext (für die Meldung an den Admin)
export function reasonOf(error: string): string {
  if (/timed out|Timeout was reached|connection timeout/i.test(error)) return 'timeout';
  if (/Could not resolve host/.test(error)) return 'DNS lookup failed';
  if (/Couldn't connect to server/.test(error)) return 'connection refused';
  if (/SSL|certificate|TLS/i.test(error)) return 'TLS error';
  if (/reset by peer|Empty reply|transfer closed|Weird server reply|HTTP\/0\.9/.test(error)) return 'the connection broke off';
  if (/too large/.test(error)) return 'the answer was too large';
  return 'no answer';
}

// json_decode(): ungültiges UTF-8 oder JSON → null
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function jsonDecode(raw: Buffer): unknown {
  try {
    return JSON.parse(UTF8.decode(raw));
  } catch {
    return null;
  }
}

// Eine Anfrage mit 10 s Zeitlimit, 5 s für den Verbindungsaufbau und ohne Weiterleitungen. Die Fehlertexte folgen curl.
function curlRequest(method: string, url: string, body: string | null, headers: string[]): Promise<{ status: number; body: Buffer | null; error: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    // Steuer- und Leerzeichen in der Adresse: nie senden (new URL() würde sie still entfernen oder kodieren)
    if (/[\x00-\x20\x7f]/.test(url)) {
      resolve({ status: 0, body: null, error: 'URL rejected: Malformed input to a URL function' });
      return;
    }
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      resolve({ status: 0, body: null, error: 'URL rejected: Malformed input to a URL function' });
      return;
    }
    const secure = target.protocol === 'https:';
    if (!secure && target.protocol !== 'http:') {
      resolve({ status: 0, body: null, error: `Protocol "${target.protocol.slice(0, -1)}" not supported` });
      return;
    }
    const host = target.hostname.replace(/^\[|\]$/g, '');
    const port = target.port || (secure ? '443' : '80');
    const out: Record<string, string> = { Accept: '*/*' };
    for (const h of headers) {
      const i = h.indexOf(':');
      if (i > 0) out[h.slice(0, i)] = h.slice(i + 1).replace(/^[ \t]+/, '');
    }
    if (body !== null) out['Content-Length'] = String(Buffer.byteLength(body, 'utf8'));

    let status = 0;
    let received = 0;
    let expected: number | null = null;
    let reason: string | null = null;
    let settled = false;
    let tcpUp = false;
    let response: http.IncomingMessage | null = null;
    const chunks: Buffer[] = [];
    const finish = (result: { status: number; body: Buffer | null; error: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(totalTimer);
      resolve(result);
    };
    const fail = (err: NodeJS.ErrnoException): void => finish({ status: 0, body: null, error: reason ?? curlError(err, host, port, Date.now() - started, status !== 0) });

    const req = (secure ? https : http).request(target, { method, headers: out, agent: false });
    const connectTimer = setTimeout(() => {
      reason = tcpUp ? 'SSL connection timeout' : `Failed to connect to ${host} port ${port} after ${Date.now() - started} ms: Timeout was reached`;
      req.destroy();
    }, 5000);
    const totalTimer = setTimeout(() => {
      reason = `Operation timed out after ${Date.now() - started} milliseconds with ${expected !== null ? `${received} out of ${expected}` : received} bytes received`;
      req.destroy();
    }, 10000);
    req.on('socket', (socket) => {
      socket.once('connect', () => (tcpUp = true));
      socket.once(secure ? 'secureConnect' : 'connect', () => clearTimeout(connectTimer));
    });
    req.on('response', (res) => {
      response = res;
      status = res.statusCode ?? 0;
      const len = res.headers['content-length'];
      expected = len !== undefined && /^\d+$/.test(len) ? Number(len) : null;
      res.on('data', (c: Buffer) => {
        received += c.length;
        if (received > MAX_BODY) {
          reason = 'Answer too large';
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => finish({ status, body: Buffer.concat(chunks), error: '' }));
      const cut = (): void => fail(new Error(expected !== null
        ? `transfer closed with ${expected - received} bytes remaining to read`
        : 'transfer closed with outstanding read data remaining'));
      res.on('error', (err: NodeJS.ErrnoException) => (err.message === 'aborted' ? cut() : fail(err)));
      res.on('close', () => {
        if (!res.complete) cut();
      });
    });
    req.on('error', (err) => {
      if (!response?.complete) fail(err);
    });
    req.on('close', () => {
      if (reason !== null) fail(new Error(reason));
    });
    if (body !== null) req.write(body, 'utf8');
    req.end();
  });
}

// Node-Fehler → Text wie curl_error()
function curlError(err: NodeJS.ErrnoException, host: string, port: string, ms: number, answered: boolean): string {
  switch (err.code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'EAI_NONAME':
    case 'EAI_FAIL':
      return `Could not resolve host: ${host}`;
    case 'ECONNREFUSED':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'EADDRNOTAVAIL':
      return `Failed to connect to ${host} port ${port} after ${ms} ms: Couldn't connect to server`;
    case 'ECONNRESET':
    case 'EPIPE':
      return !answered && err.message === 'socket hang up' ? 'Empty reply from server' : 'Recv failure: Connection reset by peer';
    case 'CERT_HAS_EXPIRED':
      return 'SSL certificate problem: certificate has expired';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
      return 'SSL certificate problem: self-signed certificate';
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return 'SSL certificate problem: self-signed certificate in certificate chain';
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return 'SSL certificate problem: unable to get local issuer certificate';
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return `SSL: no alternative certificate subject name matches target host name '${host}'`;
  }
  if (err.code === 'HPE_INVALID_CONSTANT' && !answered) return 'Received HTTP/0.9 when not allowed';
  if (typeof err.code === 'string' && err.code.startsWith('HPE_')) return 'Weird server reply';
  return err.message;
}

// Discords eigene Meldung (bei 400 Invalid Form Body: der erste Fehler aus „errors“ mit seinem Pfad)
export function walkErrors(errors: unknown, path: string[] = []): { path: string; message: string } | null {
  if (errors === null || typeof errors !== 'object') return null;
  const list = (errors as Record<string, unknown>)._errors;
  if (Array.isArray(list) && list.length) {
    const first = list[0] as Record<string, unknown> | null;
    const message = first && typeof first.message === 'string' ? first.message : '';
    if (message !== '') return { path: path.join('.'), message };
  }
  for (const [key, inner] of Object.entries(errors as Record<string, unknown>)) {
    if (key === '_errors') continue;
    const found = walkErrors(inner, [...path, key]);
    if (found) return found;
  }
  return null;
}

// Discords Meldung in Kurzform, z. B. „Discord said: “Unknown Webhook” (10015).“ – leer, wenn Discord nichts sagt
export function discordSaid(res: DiscordResponse): string {
  const message = cleanText(typeof res.data?.message === 'string' ? res.data.message : '', 200);
  if (message === '') return '';
  return ' Discord said: “' + message + '”' + (res.code ? ' (' + res.code + ')' : '') + '.';
}

// oys_discord_error(), erweitert: jeder bekannte Fehler mit einem Satz, was zu tun ist, dazu Discords eigene Meldung
// hint: ein Satz, was zu tun ist – steht vor Discords eigener Meldung (nur bei 401/404)
export function discordError(res: DiscordResponse, via: Via, hint = ''): string {
  const { status, code } = res;
  const said = (hint !== '' && (status === 401 || status === 404) ? ' ' + hint : '') + discordSaid(res);
  if (status === 0) return 'Couldn’t reach Discord (' + reasonOf(res.error) + ').';
  if (status === 429) {
    const after = Number(res.data?.retry_after);
    return 'Discord is rate limiting us – try again in ' + (Number.isFinite(after) && after > 0 ? Math.ceil(after) + ' s.' : 'a moment.');
  }
  if (status >= 500) return 'Discord had a problem (' + status + ') – please try again in a moment.';
  if (code === 50035) {
    const found = walkErrors(res.data?.errors);
    const detail = found ? (found.path !== '' ? found.path + ': ' : '') + found.message : cleanText(phpStr(res.data?.message ?? 'Invalid Form Body'), 200);
    return 'Discord rejected the message – ' + cleanText(detail, 300) + (/[.!?]$/.test(detail) ? '' : '.');
  }
  if (code === 220001) return 'This webhook belongs to a forum channel. Choose “As a new forum post for each update” or “In a thread”, then save again.';
  if (code === 220003) return 'Threads can only be created in forum channels – choose “In the channel” for this webhook.' + said;
  if (code === 50008) return 'This isn’t a text channel – choose a text, announcement or forum channel.' + said;
  if (status === 401) {
    // Mit Hinweis (beim Speichern) steht „Copy it again …“ schon im Hinweis – nicht zweimal
    return (via === 'webhook'
      ? 'Discord doesn’t accept this webhook link any more' + (hint !== '' ? '.' : ' – copy it again in Discord.')
      : 'Discord doesn’t accept the old bot token any more – delete it and use a webhook.') + said;
  }
  if (status === 403) {
    return (via === 'webhook'
      ? 'Discord refused the webhook (403) – please check it in the channel settings.'
      : 'The bot isn’t allowed to post in this channel. It needs “View Channel”, “Send Messages” and “Embed Links”.') + said;
  }
  if (status === 404) {
    if (code === 10015) return 'Discord doesn’t know this webhook – it was deleted or the link is incomplete.' + said;
    if (code === 10003) return 'Discord can’t find this channel or thread – it may have been deleted.' + said;
    if (code === 10008) return 'Discord can’t find this message – it may have been deleted.' + said;
    return (via === 'webhook' ? 'Discord couldn’t find this webhook – it may have been deleted.' : 'Discord couldn’t find the channel or message.') + said;
  }
  const message = cleanText(phpStr(typeof res.data?.message === 'string' ? res.data.message : ''), 200);
  return 'Discord error ' + status + (message !== '' ? ': ' + message : '') + (code ? ' (' + code + ')' : '') + '.';
}
