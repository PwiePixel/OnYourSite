// Die Beta-Webseite: eine zweite Installation von OnYourSite (Branch beta, Pre-Releases) auf einem eigenen Port neben
// der Hauptseite, mit derselben Datenbank und denselben Uploads (server/beta.sh richtet sie ein).
//
// Auf beta.<domain> antwortet immer zuerst die Hauptseite – das Tor:
//   /_beta/…           das Beta-Panel der Hauptseite (Anmelden, Meldungen, Knopf „Website“) – beta/routes.ts
//   alles andere       angemeldete Tester: weitergereicht an die Beta-Webseite (beta_site.port), jede Antwort mit HTML
//                      bekommt unten links einen Hinweis „Beta x.y.z · Panel“; alle anderen: zum Panel
// Die Sitzung liegt in oys_sessions (gemeinsame Datenbank, Cookie auf beta.<domain>): wer sich am Tor anmeldet, ist auf
// der Beta-Webseite schon angemeldet – und umgekehrt. Das Tor liest die Sitzung nur, es schreibt sie nie (sonst
// überschrieben sich die beiden Prozesse gegenseitig).
//
// Die Beta-Webseite selbst läuft mit beta_build: true und base_domain beta.<domain>: für sie ist beta.<domain> die
// Hauptadresse; Hintergrundaufgaben (Aufräumen der Bot-Aufträge, Neustart-Meldung der Statusseiten) laufen nur in der
// Hauptseite.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { configInt, configString, isBetaBuild } from '../config.js';
import { one, type Row } from '../db.js';
import { e } from '../html.js';
import { intval } from '../php.js';
import { SESSION_COOKIE } from '../web/session.js';
import type { Ctx } from '../web/ctx.js';
import { betaAccess, isBetaHost } from './beta.js';

export const PANEL = '/_beta/';

export { isBetaBuild };

// Port der Beta-Webseite auf 127.0.0.1 – 0 = keine eingerichtet
export function betaSitePort(): number {
  const p = configInt('beta_site.port', 0);
  return p > 0 && p < 65536 ? p : 0;
}

// Version der Beta-Webseite (VERSION in ihrem Code-Ordner), höchstens 30 Sekunden alt – '' = unbekannt
let versionCache: { at: number; v: string } | null = null;
export function betaSiteVersion(): string {
  const dir = configString('beta_site.dir', '');
  if (dir === '') return '';
  if (versionCache && Date.now() - versionCache.at < 30_000) return versionCache.v;
  let v = '';
  try {
    v = readFileSync(join(dir, 'VERSION'), 'utf8').trim().slice(0, 40);
  } catch {
    v = '';
  }
  if (!/^[0-9A-Za-z.+-]*$/.test(v)) v = '';
  versionCache = { at: Date.now(), v };
  return v;
}
export function forgetBetaSiteVersion(): void {
  versionCache = null;
}

// Angemeldetes Konto der Sitzung, nur gelesen (ohne Sperre, ohne Schreiben) – null = niemand
async function sessionUser(ctx: Ctx): Promise<Row | null> {
  const id = ctx.cookie(SESSION_COOKIE);
  if (!id || !/^[0-9a-zA-Z,-]{22,64}$/.test(id)) return null;
  const row = await one<{ data: string; last_seen: number }>('SELECT data, last_seen FROM oys_sessions WHERE id = ?', [id]);
  if (!row || Math.floor(Date.now() / 1000) - Number(row.last_seen) > configInt('session_idle_seconds', 1440)) return null;
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(row.data) as Record<string, unknown>;
  } catch {
    return null;
  }
  const uid = intval(data.user_id);
  return uid > 0 ? await one('SELECT * FROM users WHERE id = ?', [uid]) : null;
}

// Das Tor (router.ts, vor allem anderen auf beta.<domain>): true = die Anfrage ging an die Beta-Webseite (ctx ist
// fertig), false = die Hauptseite antwortet (Panel, Anmelden, ihre Dateien – oder die Weiterleitung zum Panel)
export async function betaGate(ctx: Ctx): Promise<boolean> {
  if (isBetaBuild() || !isBetaHost(ctx.host)) return false;
  if (ctx.path === '/_beta' || ctx.path.startsWith(PANEL)) return false;
  const port = betaSitePort();
  if (port === 0) return false;
  const user = await sessionUser(ctx);
  if (!user || betaAccess(user) !== 'ok') return false;
  await proxy(ctx, port);
  return true;
}

// Kopfzeilen, die nur für eine Verbindung gelten (RFC 9110 7.6.1) – nie weiterreichen
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate']);
// HTML bis zu dieser Größe bekommt den Hinweis (größer: unverändert weitergereicht)
const HTML_MAX = 5 * 1024 * 1024;

export function betaPill(version: string): string {
  return '<a href="' + PANEL + '" id="oys-beta-pill" title="Back to the beta panel" style="position:fixed;left:12px;bottom:12px;z-index:2147483000;'
    + 'display:flex;align-items:center;gap:6px;padding:6px 12px;border-radius:9999px;background:rgba(9,9,11,.92);color:#bae6fd;'
    + 'border:1px solid rgba(56,189,248,.35);font:600 12px/1.2 Inter,system-ui,sans-serif;text-decoration:none;box-shadow:0 6px 24px rgba(0,0,0,.35)">'
    + '<span style="text-transform:uppercase;letter-spacing:.06em">Beta</span>' + (version ? '<span>' + e(version) + '</span>' : '')
    + '<span style="color:#71717a">·</span><span style="color:#e4e4e7">Panel</span></a>';
}

// Hinweis vor das letzte </body> (ohne </body>: ans Ende)
export function withPill(html: string, version: string): string {
  const i = html.toLowerCase().lastIndexOf('</body>');
  const pill = betaPill(version);
  return i === -1 ? html + pill : html.slice(0, i) + pill + html.slice(i);
}

// Dasselbe auf den Bytes: HTML in jedem Zeichensatz bleibt, wie es war (der Hinweis selbst ist reines ASCII)
export function withPillBytes(html: Buffer, version: string): Buffer {
  const i = html.toString('latin1').toLowerCase().lastIndexOf('</body>');
  const pill = Buffer.from(betaPill(version), 'utf8');
  return i === -1 ? Buffer.concat([html, pill]) : Buffer.concat([html.subarray(0, i), pill, html.subarray(i)]);
}

function unavailable(ctx: Ctx): never {
  ctx.status = 502;
  ctx.removeHeader('Content-Length');
  ctx.header('Content-Type', 'text/html; charset=UTF-8');
  ctx.header('Cache-Control', 'no-store');
  ctx.header('Retry-After', '30');
  ctx.body = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">'
    + '<meta name="robots" content="noindex, nofollow"><title>Beta website | OnYourSite Beta</title></head>'
    + '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#09090b;color:#d4d4d8;font-family:Inter,system-ui,sans-serif;padding:16px">'
    + '<main style="max-width:420px;background:#18181b;border:1px solid rgba(255,255,255,.08);border-radius:24px;padding:32px;text-align:center">'
    + '<h1 style="color:#fff;font-size:22px;margin:0 0 8px">The beta website is starting</h1>'
    + '<p style="color:#a1a1aa;margin:0 0 24px">It may be getting a new version right now. Please try again in a minute.</p>'
    + '<a href="' + PANEL + '" style="display:inline-block;background:#fff;color:#000;font-weight:700;padding:10px 20px;border-radius:12px;text-decoration:none">Back to the beta panel</a>'
    + '</main></body></html>';
  ctx.halt();
}

// Anfrage an die Beta-Webseite weiterreichen: gleiche Methode, Adresse, Kopfzeilen und Inhalt; die Antwort kommt als
// Datenstrom zurück (HTML bis 5 MB – laut Content-Length – ganz gelesen, um den Hinweis einzusetzen)
async function proxy(ctx: Ctx, port: number): Promise<void> {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(ctx.headers)) {
    if (value !== undefined && !HOP.has(name.toLowerCase())) headers[name] = value;
  }
  // Die Länge immer aus dem Inhalt, der wirklich mitgeht – eine Angabe des Besuchers ohne Inhalt (GET mit Content-Length)
  // ließe die Beta-Webseite sonst die nächste Anfrage auf derselben Verbindung als Inhalt lesen
  const body = ctx.requestBody;
  delete headers['content-length'];
  if (body.length > 0 || !['GET', 'HEAD'].includes(ctx.method)) headers['content-length'] = String(body.length);
  const res = await new Promise<http.IncomingMessage | null>((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: ctx.method, path: ctx.rawUrl, headers, timeout: 120_000 }, resolve);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(null));
    req.end(body);
  });
  ctx.apacheStatic = true;
  if (!res) unavailable(ctx);
  ctx.status = res.statusCode ?? 502;
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined || HOP.has(name.toLowerCase())) continue;
    for (const v of Array.isArray(value) ? value : [value]) ctx.header(name, v, name.toLowerCase() === 'set-cookie' ? false : true);
  }
  ctx.header('X-Robots-Tag', 'noindex, nofollow');
  const type = String(res.headers['content-type'] ?? '');
  const length = Number(res.headers['content-length'] ?? 0);
  const html = /^text\/html\b/i.test(type) && !res.headers['content-encoding'] && ctx.method !== 'HEAD' && length <= HTML_MAX;
  if (!html) {
    ctx.body = res as Readable;
    return;
  }
  // Länge vorher weg: bricht die Beta-Webseite mitten im Inhalt ab, stimmt sonst die Angabe der Fehlerantwort nicht
  ctx.removeHeader('Content-Length');
  const chunks: Buffer[] = [];
  for await (const c of res) chunks.push(c as Buffer);
  ctx.body = withPillBytes(Buffer.concat(chunks), betaSiteVersion());
}
