// Code-Seite unter name.on-your.site ausliefern (oys_code_serve, oys_code_add_badge, oys_code_notice in lib/codesites.php)
import type { Ctx } from '../web/ctx.js';
import type { Row } from '../db.js';
import { intval, phpStr, phpTrim, phpTruthy, rawurldecode, strtolower } from '../php.js';
import { e } from '../html.js';
import { md5Hex } from '../crypto.js';
import { baseAuthority, isBot, mainUrl } from '../helpers.js';
import { poolDb, pathExtension } from '../honeycombs/util.js';
import { CODE_SANDBOX, CODE_TYPES, codePreviewValid, codeValidPath } from './sites.js';

// oys_code_serve(): Datei einer Code-Seite ausliefern (path = Pfad der Anfrage, nicht dekodiert). slug: die Adresse, unter
// der sie gerade ausgeliefert wird – ihre eigene oder die des Seitenplatzes, der sie zeigt (Vorschau-Schlüssel, Hinweise).
export async function codeServe(ctx: Ctx, site: Row, path: string, slug: string = phpStr(site.slug)): Promise<void> {
  ctx.header('Content-Security-Policy', CODE_SANDBOX);
  ctx.header('X-Content-Type-Options', 'nosniff');
  ctx.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  ctx.header('Access-Control-Allow-Origin', '*');
  // Für jede Antwort, auch Hinweise wie „Page not found“ – sonst hielte Cloudflare sie ein paar Minuten fest
  ctx.header('Cache-Control', 'no-cache, no-transform');
  const method = ctx.method;
  // Code-Seiten sind reine Dateien: nur ansehen (auch keine POST-Anfragen wie die der Mail-Autokonfiguration)
  if (method !== 'GET' && method !== 'HEAD') {
    ctx.header('Allow', 'GET, HEAD');
    ctx.status = 405;
    ctx.write(codeNotice(ctx, 'Not allowed', 'Code pages can only be viewed.'));
    return;
  }
  if (phpTruthy(site.is_blocked)) {
    ctx.status = 451;
    ctx.write(codeNotice(ctx, 'This page has been blocked', 'It broke the rules for code pages on OnYourSite.'));
    return;
  }
  const preview = ctx.get['oys-preview'];
  const urlToken = typeof preview === 'string' ? preview : '';
  const rel = strtolower(phpTrim(rawurldecode(path), '/'));
  // Offline sehen Besucher nur einen Hinweis. Der Besitzer sieht Seiten mit Vorschau-Schlüssel (Editor) –
  // Dateien wie CSS, JS und Bilder werden dafür auch offline ausgeliefert, die Sandbox gibt keinen Referer mit.
  const hidden = !phpTruthy(site.is_published) && !codePreviewValid(site, urlToken, slug);
  const askedExt = pathExtension(rel);
  if (hidden && (askedExt === '' || askedExt === 'html' || askedExt === 'htm' || !CODE_TYPES.has(askedExt))) {
    ctx.status = 404;
    ctx.write(codeNotice(ctx, 'This page is offline', 'Its owner has switched it off for now.'));
    return;
  }
  const candidates = rel === '' ? ['index.html'] : [rel, rel + '.html', rel + '/index.html'];
  const lookup = (p: string) => poolDb.one('SELECT path, content, updated_at FROM code_files WHERE site_id = ? AND path = ?', [intval(site.id), p]);
  let file: Row | null = null;
  for (const candidate of candidates) {
    // Geprüft wird der Name, gesucht aber genau der angefragte (wie in PHP)
    if (codeValidPath(candidate) === null) continue;
    file = await lookup(candidate);
    if (file) break;
  }
  let status = 200;
  if (!file) {
    status = 404;
    file = await lookup('404.html');
    if (!file) {
      ctx.status = 404;
      ctx.write(codeNotice(ctx, 'Page not found', 'This page doesn’t exist on ' + slug + '.' + baseAuthority() + '.'));
      return;
    }
  }
  const filePath = phpStr(file.path);
  const ext = pathExtension(filePath);
  const type = CODE_TYPES.get(ext) ?? '';
  const isHtml = type === 'text/html';
  if (hidden && isHtml) {
    ctx.status = 404;
    ctx.write(codeNotice(ctx, 'This page is offline', 'Its owner has switched it off for now.'));
    return;
  }
  const qs = ctx.queryString;
  // Ordner immer mit / am Ende, damit relative Links in ordner/index.html stimmen
  if (status === 200 && filePath === rel + '/index.html' && path.slice(-1) !== '/') {
    ctx.redirect('/' + rel + '/' + (qs !== '' ? '?' + qs : ''), 302);
  }
  let body = phpStr(file.content);
  if (isHtml) body = codeAddBadge(body, site);
  const etag = '"' + md5Hex(Buffer.from(body, 'utf8')).slice(0, 16) + '"';
  ctx.status = status;
  ctx.header('Content-Type', type + (type.startsWith('text/') || ['json', 'svg', 'xml', 'webmanifest'].includes(ext) ? '; charset=utf-8' : ''));
  // Immer kurz nachfragen (304 bei gleichem Stand), damit Änderungen sofort sichtbar sind.
  // no-transform: Cloudflare ändert die Dateien nicht (keine E-Mail-Verschleierung, keine eingefügten Skripte)
  ctx.header('Cache-Control', 'no-cache, no-transform');
  ctx.header('ETag', etag);
  if (status === 200 && String(ctx.headers['if-none-match'] ?? '') === etag) {
    ctx.status = 304;
    return;
  }
  // Aufrufe zählen – nicht die Vorschau im Editor (?oys-preview=…) und keine HEAD-Anfragen
  if (method === 'GET' && isHtml && status === 200 && urlToken === '' && !isBot(ctx.userAgent())) {
    await poolDb.exec('UPDATE code_sites SET views = views + 1 WHERE id = ?', [intval(site.id)]);
  }
  ctx.write(body);
}

// oys_code_add_badge(): kleiner Hinweis „Hosted on OnYourSite“ unten rechts (mit Link zu den Regeln und zum Melden)
export function codeAddBadge(html: string, _site: Row): string {
  const badge = '<a href="' + e(mainUrl('/terms/code-pages')) + '#report" target="_blank" rel="noopener" '
    + 'style="position:fixed;right:10px;bottom:10px;z-index:2147483647;display:inline-flex;align-items:center;gap:5px;'
    + 'padding:6px 10px;border-radius:999px;background:rgba(15,15,20,.78);color:#fff;font:600 11px/1 system-ui,sans-serif;'
    + 'text-decoration:none;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)" title="Hosted on OnYourSite – report this page">'
    + '<span style="color:#818cf8">&#x2B21;</span> OnYourSite</a>';
  // strripos(): letztes </body>, Groß-/Kleinschreibung nur bei ASCII egal (gleiche Länge, gleiche Stellen)
  const pos = strtolower(html).lastIndexOf('</body>');
  return pos === -1 ? html + badge : html.slice(0, pos) + badge + html.slice(pos);
}

// oys_code_notice(): schlichte Hinweisseite (setzt den Typ wie PHP)
export function codeNotice(ctx: Ctx, title: string, text: string): string {
  ctx.header('Content-Type', 'text/html; charset=utf-8');
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>' + e(title) + '</title><meta name="robots" content="noindex"></head>'
    + '<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#09090b;color:#e4e4e7;font-family:system-ui,sans-serif;text-align:center;padding:24px">'
    + '<div><div style="font-size:40px;color:#818cf8">&#x2B21;</div><h1 style="font-size:22px;margin:12px 0 6px">' + e(title) + '</h1>'
    + '<p style="color:#a1a1aa;margin:0 0 18px">' + e(text) + '</p>'
    + '<a href="' + e(mainUrl('/')) + '" style="color:#818cf8">OnYourSite</a></div></body></html>';
}
