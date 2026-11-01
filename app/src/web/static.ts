// Dateien direkt ausliefern (das hat bisher Apache gemacht): /static/**, /robots.txt. Wie Apache mit ETag und
// Last-Modified, ohne Cache-Control – nur Schriften bekommen CORS und ein Jahr Cache (.htaccess). Teilbereiche (Range)
// wie Apache, denn Safari lädt Musik nur so.
//
// Sicherheit: Wie Apache wird die Adresse zuerst dekodiert und normalisiert (%2e%2e = ..), erst dann geprüft. Ausgeliefert
// wird nur, was danach noch in static/ liegt (oder robots.txt); die Sperrregeln gelten für den dekodierten Pfad.
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { posix } from 'node:path';
import { ROOT_DIR } from '../config.js';
import type { Ctx } from './ctx.js';

const TYPES: Record<string, string> = {
  '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.map': 'application/json',
  '.html': 'text/html', '.txt': 'text/plain', '.md': 'text/markdown', '.xml': 'application/xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.svg': 'image/svg+xml', '.ico': 'image/vnd.microsoft.icon', '.bmp': 'image/bmp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogg': 'audio/ogg', '.wav': 'audio/x-wav', '.pdf': 'application/pdf',
  '.zip': 'application/zip',
};
// Wie Apache: Texte mit Zeichensatz-Angabe nur, wenn AddDefaultCharset aktiv ist – das ist es auf Debian nicht
const DENY = [/^(lib|cron|email|PHPMailer|tests|views|discord-bot|server|app|node_modules)(\/|$)/, /(^|\/)\.env$/, /^config(\.example)?\.(php|json)$/, /(^|\/)\.git(\/|$)/, /(^|\/)\./];
// static/uploads/.htaccess: nie als Skript, HTML oder SVG ausliefern
const UPLOAD_DENY = /\.(php[0-9]?|phtml|phar|pl|py|cgi|sh|html?|svg|js)$/;

// .htaccess-Sperren: 403 für interne Ordner und Zugangsdaten (Pfad ohne führenden /, Groß-/Kleinschreibung zählt).
// Geprüft wird der rohe und der dekodierte Pfad (Apache prüft dekodiert).
export function isDenied(path: string): boolean {
  const check = (p: string) => {
    const rel = p.replace(/^\/+/, '');
    return DENY.some((re) => re.test(rel));
  };
  if (check(path)) return true;
  const decoded = decodePath(path);
  return decoded !== null && decoded !== path && check(decoded);
}

// %XX dekodieren und . / .. auflösen wie Apache; null bei ungültigen Escapes, Nullbytes oder einem Pfad über die Wurzel
export function decodePath(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || !decoded.startsWith('/')) return null;
  // Backslashes sind unter Linux normale Zeichen – trotzdem nie als Trenner zulassen
  if (decoded.includes('\\')) return null;
  const segments: string[] = [];
  for (const seg of decoded.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!segments.length) return null;
      segments.pop();
      continue;
    }
    segments.push(seg);
  }
  return '/' + segments.join('/') + (decoded.endsWith('/') && segments.length ? '/' : '');
}

// Gibt true zurück, wenn die Anfrage hier beantwortet wurde (Datei, 304, 206, 403 oder 416)
export async function serveStatic(ctx: Ctx): Promise<boolean> {
  if (!ctx.path.startsWith('/static/') && ctx.path !== '/robots.txt') return false;
  const path = decodePath(ctx.path);
  // Nach dem Dekodieren muss die Adresse noch in static/ liegen – sonst ist es keine Datei für diese Funktion
  if (path === null || (path !== '/robots.txt' && !path.startsWith('/static/'))) return false;
  // static/uploads/.htaccess gilt für den Namen – auch wenn die Datei gar nicht existiert
  if (isDenied(path) || (path.startsWith('/static/uploads/') && UPLOAD_DENY.test(path))) {
    ctx.status = 403;
    ctx.write('Forbidden');
    return true;
  }
  const file = ROOT_DIR + path;
  // Doppelte Absicherung: der fertige Dateipfad liegt in static/ (oder ist robots.txt)
  const staticRoot = ROOT_DIR + '/static/';
  if (file !== ROOT_DIR + '/robots.txt' && !file.startsWith(staticRoot)) return false;
  let st;
  try {
    st = await fs.stat(file);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  ctx.apacheStatic = true;
  const ext = posix.extname(path).toLowerCase();
  const etag = '"' + createHash('md5').update(`${st.size}-${st.mtimeMs}`).digest('hex').slice(0, 16) + '"';
  const lastModified = new Date(Math.floor(st.mtimeMs / 1000) * 1000).toUTCString();
  ctx.header('Content-Type', TYPES[ext] || 'application/octet-stream');
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
