// Code-Seiten (lib/codesites.php): eigene Websites aus HTML/CSS/JS unter name.on-your.site
//
// Sicherheit: Es wird kein Code auf dem Server ausgeführt – die Dateien werden nur ausgeliefert (code/serve.ts).
// Jede Antwort hat „Content-Security-Policy: sandbox …“ ohne allow-same-origin: Die Seite läuft damit in einem
// eigenen, anonymen Ursprung und kommt weder an Cookies noch an Speicher oder andere Seiten von OnYourSite.
import { one, withConnection, type Db, type Row } from '../db.js';
import { date, intval, mbSubstr, phpStr, phpTrim, phpTruthy, rawurldecode, strlen, strtolower, time } from '../php.js';
import { e } from '../html.js';
import { hmac, safeEqual } from '../crypto.js';
import { baseAuthority, cleanText, scheme, slugProblem } from '../helpers.js';
import { hcBalance, hcHas, hcSettings } from '../honeycombs/honeycombs.js';
import { pathExtension, poolDb } from '../honeycombs/util.js';

export const CODE_MAX_FILES = 30;
export const CODE_MAX_FILE_BYTES = 262144; // 256 KB je Datei
export const CODE_MAX_TOTAL_BYTES = 2097152; // 2 MB je Seite
// Erlaubte Endungen → Typ (Reihenfolge wie in PHP, sie steht auch in Meldungen und im Editor)
export const CODE_TYPES: ReadonlyMap<string, string> = new Map([
  ['html', 'text/html'], ['htm', 'text/html'], ['css', 'text/css'], ['js', 'text/javascript'], ['mjs', 'text/javascript'],
  ['json', 'application/json'], ['txt', 'text/plain'], ['md', 'text/plain'], ['svg', 'image/svg+xml'],
  ['xml', 'application/xml'], ['webmanifest', 'application/manifest+json'],
]);
export const CODE_SANDBOX = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock';

// Dateien zum Speichern wie ein PHP-Array aus json_decode: Map (Reihenfolge exakt), Objekt oder Liste
export type CodeFileInput = Map<string, unknown> | Record<string, unknown> | unknown[];

export interface CodeSiteForEditor {
  id: number;
  slug: string;
  title: string;
  online: boolean;
  blocked: boolean;
  blocked_reason: string;
  url: string;
  preview: string;
  views: number;
  files: Record<string, string> | [];
  limits: { files: number; file: number; total: number; types: string[] };
}

// oys_code_site(): die Code-Seite eines Kontos
export const codeSite = (userId: number): Promise<Row | null> => one('SELECT * FROM code_sites WHERE user_id = ? LIMIT 1', [userId]);
// oys_code_site_by_id()
export const codeSiteById = (id: number, sql: Db = poolDb): Promise<Row | null> => sql.one('SELECT * FROM code_sites WHERE id = ?', [id]);
// oys_code_site_by_slug()
export const codeSiteBySlug = (slug: string): Promise<Row | null> => one('SELECT * FROM code_sites WHERE slug = ? LIMIT 1', [slug]);

// oys_code_url(): eigene Subdomain (eigener Ursprung)
export const codeUrl = (site: Row): string => scheme() + '://' + phpStr(site.slug) + '.' + baseAuthority();

// oys_code_unlocked()
export const codeUnlocked = (userId: number): Promise<boolean> => hcHas(userId, 'unlock', 'code_page');

// oys_code_files(): Pfad → Inhalt, nach Pfad sortiert (Map behält die Reihenfolge wie ein PHP-Array)
export async function codeFiles(siteId: number, sql: Db = poolDb): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const row of await sql.q('SELECT path, content FROM code_files WHERE site_id = ? ORDER BY path', [siteId])) files.set(String(row.path), String(row.content ?? ''));
  return files;
}

// oys_code_valid_path(): erlaubter Dateipfad (klein geschrieben, bis zu 3 Ordner, bekannte Endung) oder null.
// $ ohne D erlaubt in PCRE ein \n am Ende – dann gehört es zur Endung, und die ist nie erlaubt.
export function codeValidPath(path: string): string | null {
  const p = strtolower(phpTrim(path.replaceAll('\\', '/'), '/ '));
  if (strlen(p) > 120 || !/^[a-z0-9_-]+(?:[.][a-z0-9_-]+)*(?:\/[a-z0-9_-]+(?:[.][a-z0-9_-]+)*){0,3}\n?$/.test(p)) return null;
  return CODE_TYPES.has(pathExtension(p)) ? p : null;
}

// oys_code_for_editor()
export async function codeForEditor(site: Row): Promise<CodeSiteForEditor> {
  const files = await codeFiles(intval(site.id));
  return {
    id: intval(site.id),
    slug: phpStr(site.slug),
    title: phpStr(site.title),
    online: phpTruthy(site.is_published),
    blocked: phpTruthy(site.is_blocked),
    blocked_reason: phpStr(site.blocked_reason ?? ''),
    url: codeUrl(site),
    preview: codeUrl(site) + '/?oys-preview=' + codePreviewToken(site),
    views: intval(site.views),
    // Leeres PHP-Array wird zu [], sonst ein Objekt in Pfad-Reihenfolge
    files: files.size ? Object.fromEntries(files) : [],
    limits: { files: CODE_MAX_FILES, file: CODE_MAX_FILE_BYTES, total: CODE_MAX_TOTAL_BYTES, types: [...CODE_TYPES.keys()] },
  };
}

export interface CodeEditorState {
  unlocked: boolean;
  terms: boolean;
  cost: number;
  balance: number;
  site: CodeSiteForEditor | null;
}

// Zustand für /dashboard/api/code* ($state in lib/routes_app.php): Antwort ist {ok: true, ...codeEditorState(userId)}
export async function codeEditorState(userId: number): Promise<CodeEditorState> {
  const site = await codeSite(userId);
  const terms = phpTruthy(await poolDb.value('SELECT code_terms_at FROM users WHERE id = ?', [userId]));
  return {
    unlocked: await codeUnlocked(userId),
    terms,
    cost: (await hcSettings()).code_page,
    balance: await hcBalance(userId),
    site: site ? await codeForEditor(site) : null,
  };
}

// oys_code_create(): neue Code-Seite mit Startdateien → [Seite, Fehler]
export async function codeCreate(userId: number, slug: string, title: string): Promise<[Row | null, string | null]> {
  if (await codeSite(userId)) return [null, 'You already have a code page.'];
  const problem = await slugProblem(slug);
  if (problem) return [null, problem];
  const clean = cleanText(title, 120);
  title = phpTruthy(clean) ? clean : slug;
  const now = date('Y-m-d H:i:s');
  const res = await poolDb.exec('INSERT INTO code_sites (user_id, slug, title, is_published, is_blocked, views, created_at, updated_at) VALUES (?, ?, ?, 1, 0, 0, ?, ?)',
    [userId, slug, title, now, now]);
  const site = await codeSiteById(res.insertId);
  for (const [path, content] of Object.entries(codeStarterFiles(title))) {
    await poolDb.exec('INSERT INTO code_files (site_id, path, content, updated_at) VALUES (?, ?, ?, ?)', [intval(site?.id), path, content, now]);
  }
  return [site, null];
}

// oys_code_starter_files(): Startseite, Stil und Skript (Text genau wie in PHP)
export function codeStarterFiles(title: string): Record<string, string> {
  const t = e(title);
  return {
    'index.html': `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${t}</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <main class="card">\n    <h1>${t}</h1>\n    <p>This is your own website – edit <code>index.html</code>, <code>style.css</code> and <code>script.js</code> in the editor.</p>\n    <button id="hello">Click me</button>\n  </main>\n  <script src="script.js"></script>\n</body>\n</html>\n`,
    'style.css': '* { box-sizing: border-box; }\nbody {\n  margin: 0;\n  min-height: 100vh;\n  display: grid;\n  place-items: center;\n  font-family: system-ui, sans-serif;\n  background: radial-gradient(circle at 20% 20%, #312e81, #09090b 60%);\n  color: #fafafa;\n}\n.card {\n  max-width: 520px;\n  margin: 24px;\n  padding: 32px;\n  border-radius: 20px;\n  background: rgba(255, 255, 255, .06);\n  border: 1px solid rgba(255, 255, 255, .12);\n}\nbutton {\n  padding: 10px 18px;\n  border: 0;\n  border-radius: 999px;\n  background: #6366f1;\n  color: #fff;\n  font-weight: 600;\n  cursor: pointer;\n}\n',
    'script.js': "document.getElementById('hello').addEventListener('click', () => {\n  alert('Hello from your own website!');\n});\n",
  };
}

// oys_code_save(): geänderte/neue Dateien (Pfad → Inhalt) und gelöschte Pfade speichern. Fehlermeldung oder null.
// Gleichzeitige Speichervorgänge (z. B. zwei Tabs) laufen nacheinander – sonst ließen sich die Grenzen umgehen.
export async function codeSave(site: Row, files: CodeFileInput, deleted: unknown[]): Promise<string | null> {
  return withConnection(async (sql, conn) => {
    await conn.beginTransaction();
    try {
      await sql.q('SELECT id FROM code_sites WHERE id = ? FOR UPDATE', [intval(site.id)]);
      const error = await codeWrite(site, files, deleted, sql);
      if (error !== null) {
        await conn.rollback();
        return error;
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => undefined);
      throw err;
    }
    return null;
  });
}

// Einträge eines PHP-Arrays in seiner Reihenfolge
function entriesOf(files: CodeFileInput): Array<[string, unknown]> {
  if (files instanceof Map) return [...files.entries()];
  return Object.entries(files);
}
const sizeOf = (files: CodeFileInput): number => (files instanceof Map ? files.size : Object.keys(files).length);
export const codeFileCount = sizeOf;

// Text, den PHP als gültiges UTF-8 sieht (keine einzelnen Ersatzzeichen aus \ud800-Escapes)
const validUtf8 = (s: string): boolean => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

// oys_code_write(): prüft und schreibt die Änderungen (innerhalb der Transaktion von codeSave)
export async function codeWrite(site: Row, files: CodeFileInput, deleted: unknown[], sql: Db = poolDb): Promise<string | null> {
  const siteId = intval(site.id);
  const current = await codeFiles(siteId, sql);
  const next = new Map(current);
  for (const path of deleted) next.delete(phpStr(path));
  for (const [path, content] of entriesOf(files)) {
    const clean = codeValidPath(path);
    if (clean === null) {
      return '“' + mbSubstr(path, 0, 60) + '” isn’t an allowed file name. Use lowercase letters, numbers, - and _, and one of: ' + [...CODE_TYPES.keys()].join(', ') + '.';
    }
    if (typeof content !== 'string' || !validUtf8(content)) return clean + ': only text files (UTF-8) can be saved.';
    if (strlen(content) > CODE_MAX_FILE_BYTES) return clean + ' is larger than ' + CODE_MAX_FILE_BYTES / 1024 + ' KB.';
    next.set(clean, content.replaceAll('\0', ''));
  }
  if (next.size > CODE_MAX_FILES) return 'A code page can have up to ' + CODE_MAX_FILES + ' files.';
  let total = 0;
  for (const content of next.values()) total += strlen(content);
  if (total > CODE_MAX_TOTAL_BYTES) return 'All files together may be up to ' + CODE_MAX_TOTAL_BYTES / 1048576 + ' MB.';
  if (!next.has('index.html')) return 'Your page needs an index.html – it’s the first file visitors see.';
  const now = date('Y-m-d H:i:s');
  for (const path of current.keys()) {
    if (!next.has(path)) await sql.exec('DELETE FROM code_files WHERE site_id = ? AND path = ?', [siteId, path]);
  }
  for (const [path, content] of next) {
    if (!current.has(path) || current.get(path) !== content) {
      await sql.exec('INSERT INTO code_files (site_id, path, content, updated_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE content = VALUES(content), updated_at = VALUES(updated_at)',
        [siteId, path, content, now]);
    }
  }
  await sql.exec('UPDATE code_sites SET updated_at = ? WHERE id = ?', [now, siteId]);
  return null;
}

// oys_code_delete_user(): Konto gelöscht – Code-Seite, Dateien und Honigwaben entfernen
// sql: die Verbindung des Aufrufers (Konto löschen: alles in einer Transaktion)
export async function codeDeleteUser(userId: number, sql: Db = poolDb): Promise<void> {
  const site = await sql.one('SELECT * FROM code_sites WHERE user_id = ? LIMIT 1', [userId]);
  if (site) {
    await sql.exec('DELETE FROM code_files WHERE site_id = ?', [intval(site.id)]);
    await sql.exec('DELETE FROM code_sites WHERE id = ?', [intval(site.id)]);
  }
  await sql.exec('DELETE FROM honeycomb_ledger WHERE user_id = ?', [userId]);
}

// oys_code_used_uploads(): Uploads, die in den Dateien der Code-Seite vorkommen (zählen nicht als ungenutzt)
export async function codeUsedUploads(userId: number): Promise<Set<string>> {
  const site = await codeSite(userId);
  return site ? usedUploadsIn((await codeFiles(Number(site.id))).values(), userId) : new Set();
}

export function usedUploadsIn(contents: Iterable<string>, userId: number): Set<string> {
  const used = new Set<string>();
  // preg_match_all('#[a-z]+_ID_\d{9,11}_[0-9a-f]{8}\.[a-z0-9]{2,5}#') in linearer Zeit: Als ein Ausdruck braucht V8 für
  // lange Buchstabenfolgen ohne Treffer quadratische Zeit (256 KB → über eine Minute, der Server stünde still).
  // [a-z]+ kann nicht kürzer werden (danach muss „_“ kommen) – ein Treffer beginnt also an der ersten Stelle einer
  // Buchstabenfolge (bzw. am Ende des vorigen Treffers) und hängt nur davon ab, was nach ihrem Ende steht.
  const letters = /[a-z]+/g;
  const rest = new RegExp(`_${userId}_\\d{9,11}_[0-9a-f]{8}\\.[a-z0-9]{2,5}`, 'y');
  for (const content of contents) {
    // Dateinamen dieser Version (name_ID_zeit_zufall.ext), egal wie sie eingebunden sind
    for (let pos = 0; ;) {
      letters.lastIndex = pos;
      const run = letters.exec(content);
      if (!run) break;
      rest.lastIndex = pos = run.index + run[0].length;
      if (rest.test(content)) {
        used.add(content.slice(run.index, rest.lastIndex));
        pos = rest.lastIndex;
      }
    }
    // ältere Dateinamen über ihre Adresse (auch ohne / am Anfang)
    for (const m of content.matchAll(/static\/uploads\/([A-Za-z0-9._%-]+)/g)) used.add(rawurldecode(m[1]));
  }
  return used;
}

// oys_code_preview_token(): Vorschau des Besitzers im Editor – zeigt die Seite auch offline (12 Stunden gültig)
export function codePreviewToken(site: Row, at: number | null = null): string {
  const t = at ?? time();
  return t + '-' + hmac('code-preview|' + phpStr(site.id) + '|' + phpStr(site.slug) + '|' + t).slice(0, 24);
}

// oys_code_preview_valid()
export function codePreviewValid(site: Row, token: string): boolean {
  const m = /^(\d{9,11})-[0-9a-f]{24}\n?$/.exec(token);
  if (!m) return false;
  const age = time() - intval(m[1]);
  return age >= -60 && age <= 43200 && safeEqual(codePreviewToken(site, intval(m[1])), token);
}
