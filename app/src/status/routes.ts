// Statusseiten: Adressen auf einem Status-Host (status.on-your.site, name.on-your.site) – Entwurf §4.3/§4.4:
//   GET/HEAD /             die Seite (offline nur mit ?preview=<Schlüssel>)
//   GET/HEAD /incidents/N  ein Vorfall · /history?page=N der Verlauf · /summary.json (CORS *)
//   alles andere: Hinweis „Page not found“ (404), andere Methoden 405 (Allow: GET, HEAD)
// Keine Sitzung, kein Cookie; strenge CSP, nur Dateien vom eigenen Ursprung. Ausgaben bleiben 30 s im Speicher
// (Schlüssel Seite:rev:Adresse – eine Änderung durch den Besitzer gilt sofort), mit schwachem ETag und 304.
// Ohne Datenbank: die letzte gute Ansicht (höchstens 1 Stunde alt) mit rotem Hinweis und no-store; OnYourSites eigene
// Seite zeigt dann Website und Datenbank als „Major outage“ (die Hauptseite antwortet 503). Ohne gespeicherte Ansicht:
// OnYourSites Seite eine feste Notfall-Seite (200), eine Seite eines Nutzers 503 mit Retry-After.
import type { Ctx } from '../web/ctx.js';
import { DbUnavailableError, withConnection, type Db } from '../db.js';
import { hmac, safeEqual, sha1Hex } from '../crypto.js';
import { invite } from '../updates/pages.js';
import { loadIncident, loadIncidents } from './incidents.js';
import { SYSTEM_SLUG, statusPageBySlug, statusPageUrl, type StatusPageRow } from './model.js';
import { renderHistoryPage, renderIncidentPage, renderNotice, renderStatusPage, renderSystemFallback, type RenderLinks } from './render.js';
import { summaryJson } from './summary.js';
import { statusLimits } from './limits.js';
import { dbDownView, loadPageView, type IncidentView, type PageView } from './view.js';

export const CSP = "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
export const CACHE_PUBLIC = 'public, max-age=30, stale-while-revalidate=60, stale-if-error=86400';
const TTL = 30_000;
const LAST_GOOD = 3600_000;
const HISTORY_PER_PAGE = 20;

// ---------------------------------------------------------------- Speicher

class Lru<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(k: string): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: string, v: V): void {
    this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
  delete(k: string): void {
    this.map.delete(k);
  }
  values(): V[] {
    return [...this.map.values()];
  }
  clear(): void {
    this.map.clear();
  }
}

interface Cached {
  at: number;
  status: number;
  body: string;
  type: string;
  noindex: boolean;
}

const outputs = new Lru<Cached>(500);
// Letzte gute Ansicht je Seite (für den Ausfall der Datenbank; begrenzt, nur öffentliche Ansichten – keine Vorschau,
// und eine Seite, die offline oder gesperrt ist, verliert ihre) und welche Adressen Statusseiten sind
const lastViews = new Lru<{ at: number; view: PageView; links: RenderLinks }>(200);
const knownSlugs = new Lru<{ id: number; system: boolean; title: string }>(5000);
let linksCache: { at: number; links: RenderLinks } | null = null;
let dbDownSince: number | null = null;

export function resetStatusRoutesForTests(): void {
  outputs.clear();
  lastViews.clear();
  knownSlugs.clear();
  linksCache = null;
  dbDownSince = null;
}

function isDbDown(err: unknown): boolean {
  return err instanceof DbUnavailableError || (!!err && typeof err === 'object' && (err as { fatal?: unknown }).fatal === true);
}

function dbDown(): number {
  dbDownSince ??= Math.floor(Date.now() / 1000);
  return dbDownSince;
}

async function renderLinks(): Promise<RenderLinks> {
  const now = Date.now();
  if (linksCache && now - linksCache.at < 300_000) return linksCache.links;
  const links = { discord: await invite().catch(() => linksCache?.links.discord ?? '') };
  linksCache = { at: now, links };
  return links;
}

// ---------------------------------------------------------------- Vorschau offline

// Schlüssel für die Vorschau einer Seite, die offline ist (12 Stunden gültig) – wie bei den Code-Seiten
export function statusPreviewToken(page: Pick<StatusPageRow, 'id' | 'slug'>, at = Math.floor(Date.now() / 1000)): string {
  return at + '-' + hmac('status-preview|' + page.id + '|' + page.slug + '|' + at).slice(0, 24);
}

export function statusPreviewValid(page: Pick<StatusPageRow, 'id' | 'slug'>, token: string): boolean {
  const m = /^(\d{9,11})-[0-9a-f]{24}$/.exec(token);
  if (!m) return false;
  const age = Math.floor(Date.now() / 1000) - Number(m[1]);
  return age >= -60 && age <= 43200 && safeEqual(statusPreviewToken(page, Number(m[1])), token);
}

// ---------------------------------------------------------------- Antworten

function baseHeaders(ctx: Ctx): void {
  ctx.header('X-Content-Type-Options', 'nosniff');
  ctx.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  ctx.header('Content-Security-Policy', CSP);
}

function notice(ctx: Ctx, page: StatusPageRow, status: number, title: string, text: string): never {
  baseHeaders(ctx);
  ctx.header('Cache-Control', 'no-store');
  ctx.header('X-Robots-Tag', 'noindex');
  ctx.header('Content-Type', 'text/html; charset=UTF-8');
  ctx.send(renderNotice(page, title, text), status);
}

// Schwaches ETag: gleiche Ausgabe → 304 ohne Inhalt
function etagMatches(ctx: Ctx, etag: string): boolean {
  const inm = String(ctx.headers['if-none-match'] ?? '');
  if (inm === '') return false;
  const bare = etag.replace(/^W\//, '');
  return inm.split(',').some((t) => t.trim() === '*' || t.trim().replace(/^W\//, '') === bare);
}

function send(ctx: Ctx, out: Cached, cacheControl: string): never {
  baseHeaders(ctx);
  ctx.header('Cache-Control', cacheControl);
  ctx.header('Content-Type', out.type);
  if (out.noindex) ctx.header('X-Robots-Tag', 'noindex');
  if (out.type.startsWith('application/json')) ctx.header('Access-Control-Allow-Origin', '*');
  const etag = 'W/"' + sha1Hex(out.body).slice(0, 20) + '"';
  ctx.header('ETag', etag);
  if (out.status === 200 && etagMatches(ctx, etag)) ctx.send('', 304);
  ctx.send(out.body, out.status);
}

type Route = { kind: 'home' } | { kind: 'incident'; id: number } | { kind: 'history'; page: number } | { kind: 'summary' } | { kind: 'none' };

function routeOf(ctx: Ctx): Route {
  const path = ctx.path.length > 1 ? ctx.path.replace(/\/+$/, '') : ctx.path;
  if (path === '/' || path === '') return { kind: 'home' };
  if (path === '/summary.json') return { kind: 'summary' };
  if (path === '/history') {
    const n = /^[1-9][0-9]{0,4}$/.test(String(ctx.get.page ?? '')) ? Number(ctx.get.page) : 1;
    return { kind: 'history', page: n };
  }
  const m = /^\/incidents\/([1-9][0-9]{0,9})$/.exec(path);
  if (m) return { kind: 'incident', id: Number(m[1]) };
  return { kind: 'none' };
}

const routeKey = (r: Route): string => (r.kind === 'incident' ? 'i' + r.id : r.kind === 'history' ? 'h' + r.page : r.kind);

// Darf die Seite gezeigt werden? Gesperrt → 451, offline (ohne Vorschau) oder ohne Freischaltung → 404
async function gate(ctx: Ctx, db: Db, page: StatusPageRow): Promise<{ preview: boolean }> {
  const preview = typeof ctx.get.preview === 'string' && statusPreviewValid(page, ctx.get.preview);
  const unpaid = !page.isSystem && (await statusLimits(page.userId, db)).plan === 'none';
  // Nicht öffentlich: die gemerkte Ansicht darf auch ohne Datenbank niemand mehr sehen
  if (page.blocked || !page.published || unpaid) lastViews.delete(String(page.id));
  if (page.blocked) notice(ctx, page, 451, 'This status page has been blocked', 'It broke the rules for status pages on OnYourSite.');
  if (!page.published && !preview) notice(ctx, page, 404, 'This status page is offline', 'It isn’t available right now.');
  if (unpaid && !preview) notice(ctx, page, 404, 'This status page is offline', 'It isn’t available right now.');
  return { preview };
}

// Eine Statusseite ausliefern (Seite schon geladen)
export async function statusServe(ctx: Ctx, page: StatusPageRow): Promise<void> {
  knownSlugs.set(page.slug, { id: page.id, system: page.isSystem, title: page.title });
  if (ctx.method !== 'GET' && ctx.method !== 'HEAD') {
    ctx.header('Allow', 'GET, HEAD');
    notice(ctx, page, 405, 'Method not allowed', 'This address only answers GET and HEAD requests.');
  }
  const route = routeOf(ctx);
  if (route.kind === 'none') notice(ctx, page, 404, 'Page not found', 'There is nothing at this address of the status page.');
  let preview = false;
  try {
    preview = (await withConnection((db) => gate(ctx, db, page))).preview;
  } catch (err) {
    if (isDbDown(err)) return serveDown(ctx, page.slug, route);
    throw err;
  }
  const key = `${page.id}:${page.rev}:${routeKey(route)}`;
  if (!preview) {
    const hit = outputs.get(key);
    if (hit && Date.now() - hit.at < TTL) send(ctx, hit, CACHE_PUBLIC);
  }
  let out: Cached;
  try {
    out = await withConnection((db) => build(db, page, route, preview));
    dbDownSince = null;
  } catch (err) {
    if (isDbDown(err)) return serveDown(ctx, page.slug, route);
    throw err;
  }
  if (preview) {
    out.noindex = true;
    send(ctx, out, 'no-store');
  }
  if (out.status === 200) outputs.set(key, out);
  if (out.status !== 200) notice(ctx, page, out.status, 'Page not found', 'There is nothing at this address of the status page.');
  send(ctx, out, CACHE_PUBLIC);
}

// Gibt es die Adresse? Erst billig nachsehen (eine Abfrage), dann die ganze Seite bauen – sonst kostete jede
// unbekannte Vorfall-Nummer oder Verlaufsseite hinter der letzten den vollen Aufbau
async function exists(db: Db, page: StatusPageRow, route: Route): Promise<boolean> {
  if (route.kind === 'incident') return (await db.one('SELECT id FROM status_incidents WHERE id = ? AND page_id = ?', [route.id, page.id])) !== null;
  if (route.kind === 'history' && route.page > 1) {
    return (await db.one(`SELECT id FROM status_incidents WHERE page_id = ? ORDER BY starts_at DESC, id DESC LIMIT 1 OFFSET ${(route.page - 1) * HISTORY_PER_PAGE}`, [page.id])) !== null;
  }
  return true;
}

async function build(db: Db, page: StatusPageRow, route: Route, preview: boolean): Promise<Cached> {
  const now = Math.floor(Date.now() / 1000);
  if (!(await exists(db, page, route))) return { at: Date.now(), status: 404, body: '', type: 'text/html; charset=UTF-8', noindex: true };
  const view = await loadPageView(db, page, now);
  const links = page.isSystem ? await renderLinks() : { discord: '' };
  if (!preview) lastViews.set(String(page.id), { at: Date.now(), view, links });
  const noindex = view.noindex || preview;
  const html = (body: string): Cached => ({ at: Date.now(), status: 200, body, type: 'text/html; charset=UTF-8', noindex });
  if (route.kind === 'summary') return { at: Date.now(), status: 200, body: JSON.stringify(summaryJson(view)), type: 'application/json; charset=utf-8', noindex };
  if (route.kind === 'incident') {
    const inc = await loadIncident(db, page.id, route.id);
    if (!inc) return { at: Date.now(), status: 404, body: '', type: 'text/html; charset=UTF-8', noindex: true };
    const iv: IncidentView = { ...inc, affected: inc.monitors.filter((m) => m.isPublic).map((m) => m.name) };
    return html(renderIncidentPage({ ...view, noindex }, iv, links));
  }
  if (route.kind === 'history') {
    // Der Verlauf zeigt keine Updates – nur das letzte laden
    const list = await loadIncidents(db, 'page_id = ?', [page.id], { order: 'starts_at DESC, id DESC', limit: HISTORY_PER_PAGE + 1, offset: (route.page - 1) * HISTORY_PER_PAGE, updates: 'last' });
    const items = list.slice(0, HISTORY_PER_PAGE).map((i) => ({ ...i, affected: i.monitors.filter((m) => m.isPublic).map((m) => m.name) }));
    if (route.page > 1 && !items.length) return { at: Date.now(), status: 404, body: '', type: 'text/html; charset=UTF-8', noindex: true };
    return html(renderHistoryPage({ ...view, noindex }, { items, page: route.page, more: list.length > HISTORY_PER_PAGE }, links));
  }
  return html(renderStatusPage({ ...view, noindex }, links));
}

// Ohne Datenbank: letzte gute Ansicht (≤ 1 h) mit rotem Hinweis, sonst die Notfall-Ausgabe
function serveDown(ctx: Ctx, slug: string, route: Route): never {
  const since = dbDown();
  const known = knownSlugs.get(slug);
  const system = known?.system ?? slug === SYSTEM_SLUG;
  const last = known ? lastViews.get(String(known.id)) : lastViews.values().find((v) => v.view.page.isSystem && v.view.page.slug === slug);
  baseHeaders(ctx);
  ctx.header('Cache-Control', 'no-store');
  if (last && Date.now() - last.at <= LAST_GOOD && (route.kind === 'home' || route.kind === 'summary')) {
    const view = dbDownView(last.view, since);
    if (route.kind === 'summary') {
      ctx.header('Content-Type', 'application/json; charset=utf-8');
      ctx.header('Access-Control-Allow-Origin', '*');
      ctx.send(JSON.stringify(summaryJson(view)), 200);
    }
    ctx.header('Content-Type', 'text/html; charset=UTF-8');
    if (view.noindex) ctx.header('X-Robots-Tag', 'noindex');
    ctx.send(renderStatusPage(view, last.links), 200);
  }
  ctx.header('Content-Type', 'text/html; charset=UTF-8');
  if (system && route.kind === 'home') ctx.send(renderSystemFallback({ slug, title: known?.title || 'OnYourSite status' }, since, linksCache?.links ?? { discord: '' }), 200);
  ctx.header('Retry-After', '60');
  ctx.header('X-Robots-Tag', 'noindex');
  const page = { slug, title: known?.title ?? '', theme: 'deep-dark', settings: null, isSystem: system };
  ctx.send(renderNotice(page, 'This status page can’t be loaded right now', 'Please try again in a few minutes.'), 503);
}

// ---------------------------------------------------------------- Einstiege aus dem Router

// Subdomain ohne Link- und Code-Seite: eine Statusseite, sonst eine alte Adresse (90 Tage Weiterleitung), sonst zurück
export async function statusSubdomain(ctx: Ctx, slug: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const found = await withConnection(async (db) => {
    const page = await statusPageBySlug(db, slug);
    if (page) return { page, to: null as string | null };
    const r = await db.one('SELECT p.slug FROM status_slug_redirects r JOIN status_pages p ON p.id = r.page_id WHERE r.slug = ? AND r.until > ?', [slug, now]);
    return { page: null, to: r ? String(r.slug) : null };
  });
  if (found.page) return statusServe(ctx, found.page);
  if (found.to !== null) {
    ctx.header('Cache-Control', 'no-store');
    ctx.redirect(statusPageUrl(found.to, ctx.rawUrl.startsWith('/') ? ctx.rawUrl : '/'), 302);
  }
}

// Hauptdomain on-your.site/<adresse>: eine Statusseite gibt es nur unter ihrer eigenen Subdomain
export async function statusPathRedirect(ctx: Ctx, slug: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const to = await withConnection(async (db) => {
    const page = await statusPageBySlug(db, slug);
    if (page) return page.slug;
    // Eine alte Adresse (90 Tage nach dem Wechsel) leitet auch hier zur neuen
    const r = await db.one('SELECT p.slug FROM status_slug_redirects r JOIN status_pages p ON p.id = r.page_id WHERE r.slug = ? AND r.until > ?', [slug, now]);
    return r ? String(r.slug) : null;
  });
  if (to !== null) ctx.redirect(statusPageUrl(to), 302);
}

// Router: die Datenbank fehlt schon vor dem Abfragen der Adresse – bekannte Statusseiten bekommen ihre Notfall-Ausgabe
export function statusDbDownHost(ctx: Ctx, slug: string): void {
  if (!knownSlugs.get(slug) && slug !== SYSTEM_SLUG) return;
  if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return;
  const route = routeOf(ctx);
  if (route.kind === 'none') return;
  serveDown(ctx, slug, route);
}
