// Verteilung der Anfragen – dieselbe Reihenfolge wie index.php (und davor die Regeln aus .htaccess)
import type { Ctx } from './web/ctx.js';
import { apacheError, apachePath, apacheRequestUri, isDenied, serveStatic } from './web/static.js';
import { configString } from './config.js';
import { strtolower, phpTrim } from './php.js';
import { serveUpload } from './content/storage.js';
import { api } from './public/api.js';
import { notFound } from './public/notFound.js';
import { pathProfile, publicRoutes, subdomain, trackClick } from './public/routes.js';
import { adminImpersonate, adminReturn } from './app/impersonate.js';
import { appRoutes } from './app/dispatch.js';
import { ensureSchemaOnce } from './schema.js';
import { domainsAvailable, hostRoute } from './domains/index.js';
import { dbReachable } from './db.js';
import { statusHealth, statusHeartbeat } from './status/endpoints.js';

export function baseAuthority(): string {
  return strtolower(configString('base_domain', 'on-your.site'));
}
export function baseHost(): string {
  return baseAuthority().split(':')[0];
}
export function scheme(): 'http' | 'https' {
  return configString('scheme', 'https') === 'http' ? 'http' : 'https';
}
export function mainUrl(path = '/'): string {
  return scheme() + '://' + baseAuthority() + path;
}
// oys_is_main_host(): die Domain selbst oder www.
export function isMainHost(host: string): boolean {
  const base = baseHost();
  return host === base || host === 'www.' + base;
}

// Eigene Seiten der Hauptdomain, deren Namen der Profil-Pfad sonst einer Profilseite gäbe
const OWN_PAGES = new Set(['updates', 'roadmap']);
const APP_ROUTES = new Set(['/', '/login', '/register', '/logout', '/dashboard', '/admin', '/challenge', '/imprint', '/privacy', '/terms', '/terms/code-pages', '/updates', '/updates/feed.xml', '/roadmap']);

export async function dispatch(ctx: Ctx): Promise<void> {
  // Apache prüft die Adresse vor allem anderen: kaputte %-Folge oder /../ über die Wurzel hinaus 400, kodierter
  // Schrägstrich (%2F) oder Nullbyte 404 – mit seiner eigenen Fehlerseite
  const target = apachePath(ctx.rawUrl);
  if ('status' in target) apacheError(ctx, target.status);
  // Interne Ordner und Zugangsdaten (<FilesMatch>/<DirectoryMatch> von install.sh und .htaccess): 403, geprüft wird
  // wie bei Apache der bereinigte Pfad – und zwar vor der https-Weiterleitung der .htaccess
  if (isDenied(target.path)) apacheError(ctx, 403);
  // .htaccess: immer https (auch hinter dem Tunnel: dort steht das Protokoll des Besuchers in X-Forwarded-Proto).
  // %{REQUEST_URI} ist bei Apache der bereinigte Pfad; die Anfrage-Parameter bleiben unverändert.
  if (scheme() === 'https' && String(ctx.headers['x-forwarded-proto'] ?? '') === 'http') {
    apacheError(ctx, 301, 'https://' + ctx.hostHeader + apacheRequestUri(ctx, target.path));
  }
  // Eigene Domains (Premium): nur wenn eingerichtet (sonst keine einzige Abfrage). Steht vor den Uploads, damit fremde
  // Dateien nie unter einer Kunden-Domain erscheinen; die Sperrliste davor gilt auch hier.
  if (domainsAvailable() && !isMainHost(ctx.host) && !ctx.host.endsWith('.' + baseHost())) return hostRoute(ctx, isAppPath);
  // 0. Hochgeladene Dateien (vor allem anderen, ohne Datenbank)
  if (ctx.path.startsWith('/static/uploads/')) {
    if (await serveStatic(ctx)) ctx.halt();
    await serveUpload(ctx, ctx.path.slice('/static/uploads/'.length));
    ctx.halt();
  }
  // Vorhandene Dateien (bisher Apache)
  if (await serveStatic(ctx)) ctx.halt();
  // Statusseiten: Gesundheit der Seite – antwortet auch ohne Datenbank (503 als JSON), daher vor dem Schema
  if (ctx.path === '/_/health') return statusHealth(ctx);
  // lib/bootstrap.php: Datenbank und Schema (meist schon beim Start erledigt). Wie db.php bei jeder Anfrage: ohne
  // Datenbank die 503-Seite, auch für Seiten, die sonst keine Abfrage bräuchten
  // Nur für die eigenen Adressen: ein fremder Host (eigene Domains nicht eingerichtet) bekommt die 404-Seite ohne jede
  // Abfrage (premium-domains PD-2)
  if (isMainHost(ctx.host) || ctx.host.endsWith('.' + baseHost())) {
    await ensureSchemaOnce();
    await dbReachable();
  }
  // Frühere PHP-Einstiege unter derselben Adresse
  if (ctx.path === '/api.php') return api(ctx);
  if (ctx.path === '/admin_impersonate.php') return adminImpersonate(ctx);
  if (ctx.path === '/admin_return.php') return adminReturn(ctx);

  const host = ctx.host;
  const path = ctx.path;
  const base = baseHost();

  // 1. Öffentliche Endpunkte ohne Cookies (auf jeder Adresse gleich)
  if (path.startsWith('/_/')) {
    ctx.header('X-Robots-Tag', 'noindex');
    // Statusseiten: Heartbeats (Token in der Adresse)
    if (path.startsWith('/_/hb/')) return statusHeartbeat(ctx);
    return publicRoutes(ctx);
  }
  // Alte Klick-Zählung
  if (path === '/track-click' && ctx.method === 'POST') return trackClick(ctx);

  // 2. Hauptdomain: App und Profile im Pfad-Modus
  if (isMainHost(host)) {
    if (APP_ROUTES.has(path) || path.startsWith('/dashboard/') || /^\/updates\/\d+$/.test(path)) return appRoutes(ctx);
    const m = /^\/([a-z0-9-]{1,63})(?:\/(kalender))?\/?$/.exec(strtolower(path));
    // Die eigenen Seiten in jeder anderen Schreibweise (Schrägstrich am Ende, Groß-/Kleinschreibung): zur richtigen
    // Adresse – sonst landete z. B. /updates/ oder /Updates bei einer Profilseite mit diesem Namen. Nur eine Stunde im
    // Cache, damit sich eine spätere Änderung nicht festsetzt. Einen Kalender haben sie nicht.
    if (m && OWN_PAGES.has(m[1])) {
      if (m[2] !== undefined) return notFound(ctx);
      ctx.header('Cache-Control', 'max-age=3600');
      ctx.redirect('/' + m[1] + (ctx.queryString !== '' ? '?' + ctx.queryString : ''), 301);
    }
    if (m) return pathProfile(ctx, m[1], m[2] ?? '');
    return notFound(ctx);
  }

  // 3. Subdomain: Profil oder Code-Seite
  if (host.endsWith('.' + base)) {
    const slug = host.slice(0, host.length - base.length - 1);
    return subdomain(ctx, slug, phpTrim(strtolower(path), '/'));
  }

  return notFound(ctx);
}

// Seiten der App auf der Hauptdomain (wie oben in dispatch) – auf eigenen Domains antworten sie nie
function isAppPath(path: string): boolean {
  return APP_ROUTES.has(path) || path.startsWith('/dashboard/') || /^\/updates\/\d+$/.test(path);
}
