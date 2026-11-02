// Dateien direkt ausliefern (das hat bisher Apache gemacht): /static/**, /robots.txt. Wie Apache mit ETag und
// Last-Modified, ohne Cache-Control – nur Schriften bekommen CORS und ein Jahr Cache (wie mit der .htaccess von 2.x).
// Teilbereiche (Range) wie Apache, denn Safari lädt Musik nur so.
//
// Sicherheit: Wie Apache (2.4, Einstellungen aus server/install.sh) wird die Adresse zuerst geprüft, dekodiert und
// normalisiert (apachePath: %2e%2e = .., // = /, kodierter Schrägstrich 404, über die Wurzel hinaus 400), erst dann
// gelten die Sperrregeln. Ausgeliefert wird nur, was danach noch in static/ liegt (oder robots.txt). Index.php (der
// Router) sieht dagegen wie in PHP die rohe Adresse.
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { posix } from 'node:path';
import { ROOT_DIR, configString } from '../config.js';
import { strtolower } from '../php.js';
import type { Ctx } from './ctx.js';

const TYPES: Record<string, string> = {
  '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.map': 'application/json',
  '.html': 'text/html', '.txt': 'text/plain', '.md': 'text/markdown', '.xml': 'application/xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.svg': 'image/svg+xml', '.ico': 'image/vnd.microsoft.icon', '.bmp': 'image/bmp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogg': 'audio/ogg', '.wav': 'audio/x-wav', '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  // Erlaubte Uploads (Musik, Kontaktkarte) wie /etc/mime.types unter Debian/Ubuntu
  '.m4a': 'audio/mp4', '.vcf': 'text/vcard',
};
// Wie Apache: Texte mit Zeichensatz-Angabe nur, wenn AddDefaultCharset aktiv ist – das ist es auf Debian nicht

// Interne Ordner und Zugangsdaten im Code-Ordner. Die Ordner der PHP-Version (lib, views, cron, tests, PHPMailer) gibt
// es seit 3.0 nicht mehr: unter diesen Namen antwortet die Seite wie unter jedem anderen Pfad (Code-Seiten dürfen solche
// Ordner haben). Ausgeliefert wird ohnehin nur, was in static/ liegt, und robots.txt.
const DENY = [/^(email|discord-bot|server|app|node_modules)(\/|$)/, /(^|\/)\.env$/, /^config(\.example)?\.(php|json)$/, /(^|\/)\.git(\/|$)/, /(^|\/)\./];
// static/uploads/.htaccess: nie als Skript, HTML oder SVG ausliefern
const UPLOAD_DENY = /\.(php[0-9]?|phtml|phar|pl|py|cgi|sh|html?|svg|js)$/;

// Sperren: 403 für interne Ordner und Zugangsdaten, in static/uploads/ auch für Skripte, HTML und SVG – über
// den Namen, auch wenn die Datei fehlt (Apache prüft den ersten Teil, den es nicht gibt: /static/uploads/x.php/y ist
// ebenso gesperrt). path ist der Pfad nach apachePath() (dekodiert und normalisiert, mit führendem /); Groß-/
// Kleinschreibung zählt.
export function isDenied(path: string): boolean {
  const rel = path.replace(/^\/+/, '');
  if (rel.startsWith('static/uploads/') && UPLOAD_DENY.test(rel.slice('static/uploads/'.length).split('/')[0])) return true;
  return DENY.some((re) => re.test(rel));
}

// ---------------------------------------------------------------- Adresse wie Apache

const isHex = (c: number): boolean => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
// RFC 3986 „unreserved“: Buchstaben, Ziffern, - . _ ~
const isUnreserved = (c: number): boolean =>
  (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x2d || c === 0x2e || c === 0x5f || c === 0x7e;
const hexValue = (a: number, b: number): number => parseInt(String.fromCharCode(a, b), 16);

// ap_normalize_path() mit NOT_ABOVE_ROOT | MERGE_SLASHES | DECODE_UNRESERVED (Apache 2.4.58, server/util.c), Zeichen
// für Zeichen wie dort: ok = false bei kaputten %-Folgen und bei /../ über die Wurzel hinaus (Apache: 400)
function normalizePath(raw: string): { ok: boolean; path: number[] } {
  const p: number[] = [];
  for (let i = 0; i < raw.length; i++) p.push(raw.charCodeAt(i));
  p.push(0);
  const slash = (c: number): boolean => c === 0x2f;
  const slashOrNul = (c: number): boolean => c === 0x2f || c === 0;
  if (!slash(p[0])) return { ok: false, path: p.slice(0, -1) };
  let ok = true;
  let l = 1;
  let w = 1;
  while (p[l] !== 0) {
    if (p[l] === 0x25) {
      if (isHex(p[l + 1]) && isHex(p[l + 2])) {
        const c = hexValue(p[l + 1], p[l + 2]);
        if (isUnreserved(c)) {
          l += 2;
          p[l] = c;
        }
      } else {
        ok = false;
      }
    }
    if (w === 0 || slash(p[w - 1])) {
      if (slash(p[l])) {
        do l++;
        while (slash(p[l]));
        continue;
      }
      if (p[l] === 0x2e) {
        // /./
        if (slashOrNul(p[l + 1])) {
          l++;
          if (p[l]) l++;
          continue;
        }
        // /x/../ (auch /x/.%2e/)
        let n = l + 1;
        if ((p[n] === 0x2e || (p[n] === 0x25 && p[++n] === 0x32 && (p[++n] === 0x65 || p[n] === 0x45))) && slashOrNul(p[n + 1])) {
          if (w > 1) {
            do w--;
            while (w && !slash(p[w - 1]));
          } else {
            ok = false;
          }
          l = n + 1;
          if (p[l]) l++;
          continue;
        }
      }
    }
    p[w++] = p[l++];
  }
  return { ok, path: p.slice(0, w) };
}

// Adresse (REQUEST_URI) so, wie Apache sie vor allem anderen prüft (ap_process_request_internal): normalisieren, dann
// den Rest dekodieren (ap_unescape_url_ex mit AllowEncodedSlashes Off). Fehler: 400 (kaputte %-Folge, über die Wurzel
// hinaus), 404 (%2F oder %00). Sonst der dekodierte Pfad als Text (UTF-8; ungültige Bytes als U+FFFD).
export function apachePath(rawUrl: string): { status: 400 | 404 } | { path: string } {
  // Pfad bis ? oder # (absolute Form „http://host/pfad“ wie apr_uri_parse)
  let target = rawUrl;
  const abs = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*/.exec(target);
  if (abs) target = target.slice(abs[0].length) || '/';
  const end = target.search(/[?#]/);
  if (end >= 0) target = target.slice(0, end);
  // „OPTIONS *“ ist die einzige Adresse ohne / am Anfang, die Apache annimmt
  if (target === '*') return { path: '*' };
  const norm = normalizePath(target);
  if (!norm.ok) return { status: 400 };
  const p = norm.path;
  const out: number[] = [];
  let badPath = false;
  for (let y = 0; y < p.length; y++) {
    if (p[y] !== 0x25) {
      out.push(p[y]);
      continue;
    }
    if (!isHex(p[y + 1]) || !isHex(p[y + 2])) return { status: 400 };
    const c = hexValue(p[y + 1], p[y + 2]);
    if (c === 0 || c === 0x2f) {
      badPath = true;
    } else if (isUnreserved(c)) {
      // schon beim Normalisieren dekodiert – bleibt wie Apache stehen (KEEP_UNRESERVED)
      out.push(p[y], p[y + 1], p[y + 2]);
    } else {
      out.push(c);
    }
    y += 2;
  }
  if (badPath) return { status: 404 };
  return { path: Buffer.from(out.map((c) => c & 0xff)).toString('utf8') };
}

// ---------------------------------------------------------------- Antworten von Apache

// Fehlerseiten von Apache 2.4 (ServerSignature Off, keine eigenen ErrorDocument), Zeichensatz iso-8859-1 wie dort
const APACHE_TITLES: Record<number, string> = {
  301: 'Moved Permanently', 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
};
const htmlEscape = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

function apacheText(status: number, ctx: Ctx, location: string): string {
  switch (status) {
    case 301: return `<p>The document has moved <a href="${htmlEscape(location)}">here</a>.</p>\n`;
    case 400: return '<p>Your browser sent a request that this server could not understand.<br />\n</p>\n';
    case 403: return "<p>You don't have permission to access this resource.</p>\n";
    case 405: return `<p>The requested method ${htmlEscape(ctx.method)} is not allowed for this URL.</p>\n`;
    default: return '<p>The requested URL was not found on this server.</p>\n';
  }
}

// Antwort, die im Betrieb Apache selbst gibt (vor PHP): Status, Fehlerseite, bei 301 Location, bei 405 Allow – dann Ende
export function apacheError(ctx: Ctx, status: 301 | 400 | 403 | 404 | 405, location = ''): never {
  const title = `${status} ${APACHE_TITLES[status]}`;
  ctx.apacheStatic = true;
  ctx.status = status;
  if (status === 301) ctx.header('Location', location);
  if (status === 405) ctx.header('Allow', ALLOW);
  ctx.header('Content-Type', 'text/html; charset=iso-8859-1');
  ctx.body = '<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">\n<html><head>\n<title>' + title + '</title>\n</head><body>\n<h1>'
    + APACHE_TITLES[status] + '</h1>\n' + apacheText(status, ctx, location) + '</body></html>\n';
  ctx.halt();
}

// Methoden, die Apache für eine Datei annimmt (default_handler: POST liefert die Datei wie GET)
const ALLOW = 'GET,POST,OPTIONS,HEAD';

// ap_escape_uri(): Zeichen außerhalb von Buchstaben, Ziffern und -_.~!$&'()*+,;=:@/ als %xx (Kleinbuchstaben wie Apache)
function escapeUri(path: string): string {
  let out = '';
  for (const b of Buffer.from(path, 'utf8')) {
    const c = String.fromCharCode(b);
    out += /[A-Za-z0-9\-_.~!$&'()*+,;=:@/]/.test(c) ? c : '%' + b.toString(16).padStart(2, '0');
  }
  return out;
}

// URL wie ap_construct_url() mit UseCanonicalName Off: Host aus der Anfrage, Port nur, wenn er nicht der übliche ist; das
// Schema aus den Einstellungen (im Betrieb immer https, der Router leitet vorher um)
export function apacheUrl(ctx: Ctx, path: string): string {
  const scheme = configString('scheme', 'https') === 'http' ? 'http' : 'https';
  const colon = ctx.hostHeader.lastIndexOf(':');
  const port = colon >= 0 && !ctx.hostHeader.endsWith(']') ? ctx.hostHeader.slice(colon + 1) : '';
  const authority = (ctx.host || strtolower(configString('base_domain', 'on-your.site')).split(':')[0])
    + (port !== '' && port !== (scheme === 'https' ? '443' : '80') ? ':' + port : '');
  return scheme + '://' + authority + apacheRequestUri(ctx, path);
}

// Pfad (dekodiert, wie ap_escape_uri() wieder kodiert) und die Anfrage-Parameter, wie sie kamen (auch ein leeres „?“)
export function apacheRequestUri(ctx: Ctx, path: string): string {
  const beforeHash = ctx.rawUrl.split('#')[0];
  const q = beforeHash.indexOf('?');
  return escapeUri(path) + (q >= 0 ? beforeHash.slice(q) : '');
}

// OPTIONS auf eine Datei oder einen Ordner: nur die erlaubten Methoden, ohne Inhalt
function apacheOptions(ctx: Ctx, type: string): true {
  ctx.apacheStatic = true;
  ctx.header('Allow', ALLOW);
  ctx.header('Content-Type', type);
  ctx.header('Content-Length', '0');
  ctx.body = '';
  return true;
}

// ---------------------------------------------------------------- Dateien

const typeOf = (path: string): string => TYPES[posix.extname(path).toLowerCase()] || 'application/octet-stream';

// Gibt true zurück, wenn die Anfrage hier beantwortet wurde (Datei, 304, 206, 416, OPTIONS). Was Apache selbst
// beantwortet (Sperre, Ordner, Datei mit Zusatz-Pfad, falsche Methode), endet hier mit seiner Antwort (apacheError).
export async function serveStatic(ctx: Ctx): Promise<boolean> {
  const target = apachePath(ctx.rawUrl);
  if (!('path' in target)) return false;
  const path = target.path;
  // Nach dem Normalisieren muss die Adresse in static/ liegen (oder robots.txt sein) – sonst ist es keine Datei für diese Funktion
  if (path !== '/robots.txt' && path !== '/static' && !path.startsWith('/static/') && !path.startsWith('/robots.txt/')) return false;
  // Sperren (auch static/uploads/.htaccess) – prüft der Router schon vorher, hier noch einmal für sich allein
  if (isDenied(path)) apacheError(ctx, 403);
  const file = ROOT_DIR + path;
  // Doppelte Absicherung: der fertige Dateipfad liegt in static/ (oder ist robots.txt)
  if (file !== ROOT_DIR + '/robots.txt' && file !== ROOT_DIR + '/static' && !file.startsWith(ROOT_DIR + '/static/') && !file.startsWith(ROOT_DIR + '/robots.txt/')) {
    return false;
  }
  // Methoden wie der default_handler von Apache: GET, HEAD und POST liefern die Datei, OPTIONS nennt die Methoden
  const method = ctx.method;
  const readable = method === 'GET' || method === 'HEAD' || method === 'POST';
  let st;
  try {
    st = await fs.stat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOTDIR') return false;
    // Ein Teil des Pfads ist eine Datei (/robots.txt/, /static/css/page.css/x): Apache antwortet selbst
    let prefix = path;
    while (prefix.includes('/', 1)) {
      prefix = prefix.slice(0, prefix.lastIndexOf('/'));
      if (await fs.stat(ROOT_DIR + prefix).then((s) => s.isFile(), () => false)) break;
    }
    if (method === 'OPTIONS') return apacheOptions(ctx, typeOf(prefix));
    apacheError(ctx, readable ? 404 : 405);
  }
  if (st.isDirectory()) {
    // Ordner: ohne / am Ende umleiten (mod_dir, jede Methode), sonst kein Verzeichnis-Listing (Options -Indexes, in static/
    // gibt es keine index-Datei): 403 – POST findet nichts (404), andere Methoden 405
    if (!path.endsWith('/')) apacheError(ctx, 301, apacheUrl(ctx, path + '/'));
    if (method === 'OPTIONS') return apacheOptions(ctx, 'httpd/unix-directory');
    apacheError(ctx, !readable ? 405 : method === 'POST' ? 404 : 403);
  }
  if (!st.isFile()) return false;
  if (method === 'OPTIONS') return apacheOptions(ctx, typeOf(path));
  if (!readable) apacheError(ctx, 405);
  ctx.apacheStatic = true;
  const ext = posix.extname(path).toLowerCase();
  const etag = '"' + createHash('md5').update(`${st.size}-${st.mtimeMs}`).digest('hex').slice(0, 16) + '"';
  const lastModified = new Date(Math.floor(st.mtimeMs / 1000) * 1000).toUTCString();
  ctx.header('Content-Type', typeOf(path));
  ctx.header('Last-Modified', lastModified);
  ctx.header('ETag', etag);
  ctx.header('Accept-Ranges', 'bytes');
  if (ext === '.woff' || ext === '.woff2' || ext === '.ttf') {
    ctx.header('Access-Control-Allow-Origin', '*');
    ctx.header('Cache-Control', 'public, max-age=31536000');
  }
  const inm = String(ctx.headers['if-none-match'] ?? '');
  const ims = String(ctx.headers['if-modified-since'] ?? '');
  if ((inm && inm === etag) || (!inm && ims && Date.parse(ims) >= Math.floor(st.mtimeMs / 1000) * 1000)) {
    ctx.status = 304;
    ctx.body = '';
    return true;
  }
  // Teilbereich (ein Bereich wie bei Apache; If-Range nur mit passendem ETag)
  const range = String(ctx.headers.range ?? '');
  const ifRange = String(ctx.headers['if-range'] ?? '');
  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (m && (m[1] !== '' || m[2] !== '') && (!ifRange || ifRange === etag)) {
    let start: number;
    let end: number;
    if (m[1] === '') {
      start = Math.max(0, st.size - Number(m[2]));
      end = st.size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] !== '' ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
    }
    if (start >= st.size || start > end) {
      ctx.status = 416;
      ctx.header('Content-Range', `bytes */${st.size}`);
      ctx.body = '';
      return true;
    }
    ctx.status = 206;
    ctx.header('Content-Range', `bytes ${start}-${end}/${st.size}`);
    ctx.header('Content-Length', String(end - start + 1));
    ctx.body = createReadStream(file, { start, end });
    return true;
  }
  ctx.header('Content-Length', String(st.size));
  ctx.body = st.size > 1024 * 1024 ? createReadStream(file) : await fs.readFile(file);
  return true;
}
