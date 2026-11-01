// Dateien direkt ausliefern (das hat bisher Apache gemacht): /static/**, /robots.txt. Wie Apache mit ETag und
// Last-Modified, ohne Cache-Control – nur Schriften bekommen CORS und ein Jahr Cache (.htaccess).
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join, normalize, extname } from 'node:path';
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

// .htaccess-Sperren: 403 für interne Ordner und Zugangsdaten (Pfad ohne führenden /, Groß-/Kleinschreibung zählt)
export function isDenied(path: string): boolean {
  const rel = path.replace(/^\/+/, '');
  return DENY.some((re) => re.test(rel));
}

// Gibt true zurück, wenn eine Datei ausgeliefert wurde
export async function serveStatic(ctx: Ctx): Promise<boolean> {
  if (!ctx.path.startsWith('/static/') && ctx.path !== '/robots.txt') return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(ctx.path);
  } catch {
    return false;
  }
  const file = normalize(join(ROOT_DIR, decoded));
  if (!file.startsWith(ROOT_DIR + '/') || decoded.includes('\0')) return false;
  let st;
  try {
    st = await fs.stat(file);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  // Hochgeladene Dateien im Code-Ordner: nie als Skript, HTML oder SVG (static/uploads/.htaccess)
  if (ctx.path.startsWith('/static/uploads/') && /\.(php[0-9]?|phtml|phar|pl|py|cgi|sh|html?|svg|js)$/.test(ctx.path)) {
    ctx.status = 403;
    ctx.write('Forbidden');
    return true;
  }
  const ext = extname(file).toLowerCase();
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
  ctx.header('Content-Length', String(st.size));
  ctx.body = await fs.readFile(file);
  return true;
}
