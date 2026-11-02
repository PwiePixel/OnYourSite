// Anfragen auf eigenen Domains (Premium). Erreichbar sind nur: die Seite der Domain (und ihr Kalender), die Dateien
// ihres Besitzers, die /_/-Endpunkte dieser Seite und die Prüfstelle des Domain-Dienstes. Nie eine Sitzung, nie die
// App, nie die OnYourSite-404 – alles andere bekommt die neutrale Seite „Not connected“. Weiterleitungsziele kommen nur
// aus der Datenbank (Hostname der Zeile, Adresse der Seite), nie aus der Anfrage.
import type { Ctx } from '../web/ctx.js';
import { decodePath, serveStatic } from '../web/static.js';
import { ensureSchemaOnce } from '../schema.js';
import { one } from '../db.js';
import { customOrigin } from '../helpers.js';
import { ctypeDigit, intval, phpStr, phpTrim, strtolower } from '../php.js';
import { serveUpload } from '../content/storage.js';
import { own } from '../content/util.js';
import { publicRoutes } from '../public/routes.js';
import { neutralNotFound, probeResponse } from './answers.js';
import { lookupHost, SERVING_STATES } from './store.js';
import { CUSTOM_HOST_ENDPOINTS, domainTarget, type EndpointRule } from './targets.js';

// Alte PHP-Einstiege und die alte Klick-Zählung – auf eigenen Domains nie
const ENTRY_POINTS = new Set(['/api.php', '/admin_impersonate.php', '/admin_return.php', '/track-click']);
// Dateiname eines Uploads: <art>_<konto>_<rest>.<endung> (lib/blocks.php) – ohne Ordner, ohne Kodierung
const UPLOAD_NAME = /^[a-z]+_(\d+)_[A-Za-z0-9_]+\.[a-z0-9]{2,5}$/;

// isAppPath: App-Seiten der Hauptdomain (vom Router, damit beide dieselbe Liste benutzen)
export async function hostRoute(ctx: Ctx, isAppPath: (path: string) => boolean): Promise<void> {
  const path = ctx.path;
  // 1. Statische Dateien (Designs, Schriften, Skripte) und robots.txt wie auf jeder Adresse – ohne Datenbank.
  // Uploads erst nach dem Blick in die Datenbank (nur die des Besitzers); geprüft wird der dekodierte Pfad.
  const decoded = path.startsWith('/static/') ? decodePath(path) : null;
  const upload = decoded !== null && decoded.startsWith('/static/uploads/') ? decoded.slice('/static/uploads/'.length) : null;
  if (path === '/robots.txt' || (path.startsWith('/static/') && upload === null)) {
    if (await serveStatic(ctx)) ctx.halt();
    neutralNotFound(ctx);
  }

  // 2. Zeile zum Host (bekannte Hosts immer frisch, unbekannte 10 s gemerkt)
  await ensureSchemaOnce();
  const host = ctx.host.endsWith('.') ? ctx.host.slice(0, -1) : ctx.host;
  const row = await lookupHost(host);
  // 3. Nicht (mehr) verbunden: verifying, failed, blocked, removing – oder gar keine Zeile
  if (!row || !SERVING_STATES.has(row.state)) neutralNotFound(ctx);
  ctx.customDomain = {
    id: intval(row.id), hostname: row.hostname, state: row.state, targetType: row.target_type, targetId: intval(row.target_id), userId: intval(row.user_id),
  };

  // 4. Prüfstelle des Domain-Dienstes
  if (matches(CUSTOM_HOST_ENDPOINTS['*'], ctx) !== null) probeResponse(ctx, row.hostname);

  // 5. Uploads nur vom Besitzer der Domain (eine Seite verwendet nur Dateien ihres Besitzers)
  if (upload !== null) {
    const m = UPLOAD_NAME.exec(upload);
    if (!m || intval(m[1]) !== intval(row.user_id)) neutralNotFound(ctx);
    if (await serveStatic(ctx)) ctx.halt();
    await serveUpload(ctx, upload);
    if (ctx.status === 404) neutralNotFound(ctx);
    ctx.halt();
  }

  // 6. Das Ziel der Domain (gelöscht, einem anderen Konto gehörend oder gerade eine Code-Seite → neutrale 404)
  const target = domainTarget(row.target_type);
  const t = target ? await target.load(intval(row.target_id)) : null;
  if (!target || !t || target.ownerId(t) !== intval(row.user_id)) neutralNotFound(ctx);

  const sub = phpTrim(strtolower(path), '/');
  const query = ctx.queryString !== '' ? '?' + ctx.queryString : '';
  // 7. Pausiert (Premium endete): Besucher zur OnYourSite-Adresse (Kalender und Abfrage bleiben)
  if (row.state === 'suspended') {
    ctx.header('Cache-Control', 'no-store');
    if (sub === '' || sub === 'kalender') ctx.redirect(target.fallbackUrl(t, sub) + query, 302);
    ctx.redirect(target.fallbackUrl(t), 302);
  }

  // 8. /_/…: nur die Endpunkte dieser Zielart, und nur für Kennungen dieses Ziels
  if (path.startsWith('/_/')) {
    ctx.header('X-Robots-Tag', 'noindex');
    const hit = matches(target.endpoints, ctx);
    if (hit === null || !(await ownsTarget(ctx, hit.rule, hit.m, row.target_type, intval(row.target_id)))) neutralNotFound(ctx);
    return publicRoutes(ctx);
  }

  // 9. App, Anmeldung und alte Einstiege gibt es nur auf der Hauptdomain
  if ((path !== '/' && isAppPath(path)) || ENTRY_POINTS.has(path)) neutralNotFound(ctx);

  // 10. Die Seite (oder ihr Kalender) – sonst zur Startseite der Domain
  if (sub === '' || sub === 'kalender') return target.serve(ctx, t, sub);
  ctx.redirect(customOrigin(row.hostname) + '/', 302);
}

// Erste passende Regel (Methode und Pfad) mit den Gruppen des Pfads, sonst null
function matches(rules: readonly EndpointRule[], ctx: Ctx): { rule: EndpointRule; m: RegExpExecArray } | null {
  for (const rule of rules) {
    const methodOk = rule.method === 'ANY' || ctx.method === rule.method || (rule.method === 'GET' && ctx.method === 'HEAD');
    const m = methodOk ? rule.path.exec(ctx.path) : null;
    if (m) return { rule, m };
  }
  return null;
}

// Gehört die Kennung der Anfrage zum Ziel der Domain? Gelesen wie von den Endpunkten selbst (POST-Feld oder Pfad)
async function ownsTarget(ctx: Ctx, rule: EndpointRule, m: RegExpExecArray, type: string, targetId: number): Promise<boolean> {
  const at = (where: string | number): unknown => (typeof where === 'number' ? m[where] : own(ctx.post, where));
  if (rule.owns?.page !== undefined) {
    // /_/v liest intval($_POST['p'] ?? 0), /_/og die Zahl aus dem Pfad
    if (type !== 'page' || intval(at(rule.owns.page) ?? 0) !== targetId) return false;
  }
  if (rule.owns?.block !== undefined) {
    // Wie oys_public_block(): nur Ziffern; der Block muss auf dieser Seite liegen
    const id = phpStr(at(rule.owns.block) ?? '');
    if (type !== 'page' || !ctypeDigit(id)) return false;
    const block = await one('SELECT page_id FROM page_blocks WHERE id = ?', [intval(id)]);
    if (!block || intval(block.page_id) !== targetId) return false;
  }
  return true;
}
