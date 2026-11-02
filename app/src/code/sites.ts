// Code-Seiten (lib/codesites.php): eigene Websites aus HTML/CSS/JS unter name.on-your.site
//
// Sicherheit: Es wird kein Code auf dem Server ausgeführt – die Dateien werden nur ausgeliefert (code/serve.ts).
// Jede Antwort hat „Content-Security-Policy: sandbox …“ ohne allow-same-origin: Die Seite läuft damit in einem
// eigenen, anonymen Ursprung und kommt weder an Cookies noch an Speicher oder andere Seiten von OnYourSite.
import { one, transaction, withConnection, type Db, type Row } from '../db.js';
import { date, intval, mbSubstr, phpStr, phpTrim, phpTruthy, rawurldecode, strlen, strtolower, time } from '../php.js';
import { e } from '../html.js';
import { hmac, safeEqual } from '../crypto.js';
import { baseAuthority, cleanText, scheme, slugProblem } from '../helpers.js';
import { hcBalance } from '../honeycombs/honeycombs.js';
import { has } from '../honeycombs/entitlements.js';
import { shopPrice } from '../honeycombs/catalogue.js';
import { pathExtension, poolDb } from '../honeycombs/util.js';
import { claimAddress, duplicateKey, isTakenError, releaseAddress } from '../content/addresses.js';
import './shop.js';

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

// Ein Konto kann mehrere Code-Seiten haben: höchstens eine mit eigener Adresse (code_sites.slug) und weitere auf
// seinen Seitenplätzen (pages.code_site_id; die Code-Seite hat dann keine eigene Adresse, slug NULL).

// oys_code_site(): die Code-Seite eines Kontos mit eigener Adresse (wie bisher die eine Code-Seite)
export const codeSite = (userId: number): Promise<Row | null> =>
  one('SELECT * FROM code_sites WHERE user_id = ? AND slug IS NOT NULL ORDER BY id LIMIT 1', [userId]);
// oys_code_site_by_id()
export const codeSiteById = (id: number, sql: Db = poolDb): Promise<Row | null> => sql.one('SELECT * FROM code_sites WHERE id = ?', [id]);
// oys_code_site_by_slug(): nur Code-Seiten mit eigener Adresse (NULL passt nie)
export const codeSiteBySlug = (slug: string): Promise<Row | null> => one('SELECT * FROM code_sites WHERE slug = ? LIMIT 1', [slug]);
// Alle Code-Seiten eines Kontos (älteste zuerst)
export const codeSites = (userId: number, sql: Db = poolDb): Promise<Row[]> => sql.q('SELECT * FROM code_sites WHERE user_id = ? ORDER BY id', [userId]);
// Eine Code-Seite dieses Kontos (sonst null); forUpdate sperrt die Zeile bis zum Ende der Transaktion
export const codeSiteOfUser = (userId: number, id: number, sql: Db = poolDb, forUpdate = false): Promise<Row | null> =>
  sql.one('SELECT * FROM code_sites WHERE id = ? AND user_id = ?' + (forUpdate ? ' FOR UPDATE' : ''), [id, userId]);
// Der Seitenplatz, der diese Code-Seite zeigt (sonst null)
export const slotOfSite = (siteId: number, sql: Db = poolDb): Promise<Row | null> => sql.one('SELECT * FROM pages WHERE code_site_id = ?', [siteId]);

export type CodeKind = 'own' | 'page';
export interface CodeAddress { kind: CodeKind; slug: string; slot: Row | null }

// Wo die Code-Seite zu sehen ist: unter ihrer eigenen Adresse oder unter der des Platzes, der sie zeigt. null: nirgends
// (nur nach Handarbeit in der Datenbank möglich – die Admin-Liste zeigt das als „No address“).
export function codeAddress(site: Row, slot: Row | null = null): CodeAddress | null {
  if (phpTruthy(site.slug)) return { kind: 'own', slug: phpStr(site.slug), slot: null };
  if (slot && intval(slot.code_site_id) === intval(site.id) && intval(slot.user_id) === intval(site.user_id)) return { kind: 'page', slug: phpStr(slot.slug), slot };
  return null;
}

// oys_code_url(): eigene Subdomain (eigener Ursprung) – für eine Code-Seite (ihre eigene Adresse) oder eine Adresse
export const codeUrl = (site: Row | string): string => scheme() + '://' + (typeof site === 'string' ? site : phpStr(site.slug)) + '.' + baseAuthority();

// oys_code_unlocked(): die Berechtigung code_page (gekauft, geschenkt oder eine alte Freischaltung im Buch)
export const codeUnlocked = (userId: number, sql: Db = poolDb): Promise<boolean> => has(userId, 'code_page', sql);

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
    // Preis aus dem Katalog, mit einem Angebot, das für dieses Konto gilt
    cost: await shopPrice('code_page', userId),
    balance: await hcBalance(userId),
    site: site ? await codeForEditor(site) : null,
  };
}

// oys_code_create(): neue Code-Seite mit Startdateien → [Seite, Fehler]. Seite, Dateien und der Eintrag in der Liste
// aller Adressen (content/addresses.ts) entstehen in einer Transaktion – war die Adresse inzwischen vergeben, bleibt
// nichts zurück.
export async function codeCreate(userId: number, slug: string, title: string): Promise<[Row | null, string | null]> {
  if (await codeSite(userId)) return [null, 'You already have a code page.'];
  const problem = await slugProblem(slug, null, null, { userId, kind: 'code' });
  if (problem) return [null, problem];
  const clean = cleanText(title, 120);
  title = phpTruthy(clean) ? clean : slug;
  const now = date('Y-m-d H:i:s');
  let siteId: number;
  try {
    siteId = await transaction(async (_conn, db) => {
      const res = await db.exec('INSERT INTO code_sites (user_id, slug, title, is_published, is_blocked, views, created_at, updated_at) VALUES (?, ?, ?, 1, 0, 0, ?, ?)',
        [userId, slug, title, now, now]);
      const starter = Object.entries(codeStarterFiles(title));
      for (const [path, content] of starter) {
        await db.exec('INSERT INTO code_files (site_id, path, content, updated_at) VALUES (?, ?, ?, ?)', [res.insertId, path, content, now]);
      }
      await db.exec('UPDATE code_sites SET file_count = ?, bytes = ? WHERE id = ?', [starter.length, starter.reduce((n, [, c]) => n + strlen(c), 0), res.insertId]);
      await claimAddress(db, slug, 'code', res.insertId, userId);
      return res.insertId;
    });
  } catch (err) {
    if (isTakenError(err)) return [null, `Sorry, the address “${slug}” is already taken.`];
    // Zwei gleichzeitige Anfragen: die Datenbank lässt nur eine Code-Seite mit eigener Adresse je Konto zu
    if (['uq_own', 'uq_user'].includes(duplicateKey(err) ?? '')) return [null, 'You already have a code page.'];
    throw err;
  }
  return [await codeSiteById(siteId), null];
}

// Adresse einer Code-Seite ändern (Editor „code-address“): neue Adresse belegen, alte für den Besitzer reservieren –
// zusammen mit der Code-Seite in einer Transaktion. Die Code-Seite wird dafür gesperrt neu gelesen: Eine Änderung aus
// einem anderen Tab gilt (freigegeben wird die Adresse, die sie jetzt hat), und eine inzwischen gesperrte oder
// gelöschte Code-Seite bekommt keine neue Adresse. Fehlermeldung oder null.
export async function codeChangeAddress(site: Row, slug: string, userId: number): Promise<string | null> {
  const problem = await slugProblem(slug, null, intval(site.id), { userId, kind: 'code' });
  if (problem !== null) return problem;
  try {
    return await transaction(async (_conn, db) => {
      const cur = await db.one('SELECT slug, is_blocked, blocked_reason FROM code_sites WHERE id = ? AND user_id = ? FOR UPDATE', [intval(site.id), userId]);
      if (!cur || !phpTruthy(cur.slug)) return 'This code page no longer exists. Please reload the editor.';
      if (phpTruthy(cur.is_blocked)) {
        return 'Your code page has been blocked by the team' + (phpTruthy(cur.blocked_reason) ? ': ' + phpStr(cur.blocked_reason) : '.');
      }
      if (phpStr(cur.slug) === slug) return null;
      await db.exec('UPDATE code_sites SET slug = ?, updated_at = ? WHERE id = ?', [slug, date('Y-m-d H:i:s'), intval(site.id)]);
      await claimAddress(db, slug, 'code', intval(site.id), userId);
      await releaseAddress(db, phpStr(cur.slug), userId, 'owner', { kind: 'code', refId: intval(site.id) });
      return null;
    });
  } catch (err) {
    if (!isTakenError(err)) throw err;
    return `Sorry, the address “${slug}” is already taken.`;
  }
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
  // Zähler für die Admin-Liste und die Grenzen (dieselbe Transaktion)
  await sql.exec('UPDATE code_sites SET updated_at = ?, file_count = ?, bytes = ? WHERE id = ?', [now, next.size, total, siteId]);
  return null;
}

// Code-Seite mit ihren Dateien löschen, auf der Verbindung des Aufrufers (ohne eigene Transaktion): ein Platz, der sie
// zeigt, zeigt wieder seine Link-Seite; eine eigene Adresse bleibt für den Besitzer reserviert. Gibt die Uploads zurück,
// die ihre Dateien benutzt haben – der Aufrufer räumt sie nach seinem Commit mit cleanupFiles() auf.
// Sperrreihenfolge: pages → code_sites → site_addresses.
export async function codeDeleteRows(db: Db, site: Row): Promise<Set<string>> {
  const id = intval(site.id);
  const used = usedUploadsIn((await codeFiles(id, db)).values(), intval(site.user_id));
  await db.exec('UPDATE pages SET code_site_id = NULL WHERE code_site_id = ?', [id]);
  await db.exec('DELETE FROM code_files WHERE site_id = ?', [id]);
  await db.exec('DELETE FROM code_sites WHERE id = ?', [id]);
  if (phpTruthy(site.slug)) await releaseAddress(db, phpStr(site.slug), intval(site.user_id), 'owner', { kind: 'code', refId: id });
  return used;
}

// oys_code_delete_user(): Konto gelöscht – alle Code-Seiten mit Dateien und das Protokoll der Team-Aktionen zum Konto
// (die Honigwaben-Buchungen löscht der eigene Haken „honeycombs“, honeycombs/deletion.ts). sql: die Verbindung des
// Aufrufers (Konto löschen: alles in einer Transaktion)
export async function codeDeleteUser(userId: number, sql: Db = poolDb): Promise<void> {
  for (const site of await codeSites(userId, sql)) await codeDeleteRows(sql, site);
  await sql.exec('DELETE FROM code_moderation WHERE user_id = ?', [userId]);
}

// Für sites:repair: Zähler neu zählen (nur wo sie nicht stimmen) und melden, was nur durch Handarbeit in der Datenbank
// entstehen kann – eine Code-Seite ohne Adresse (weder eigene noch ein Platz zeigt sie) und ein Platz, der auf eine
// fehlende oder fremde Code-Seite zeigt (Besucher sehen dort „Page not found“). Geändert wird daran nichts.
export async function codeRepair(db: Db): Promise<{ recounted: number; anomalies: string[] }> {
  const res = await db.exec(`UPDATE code_sites s
      JOIN (SELECT s2.id, COUNT(f.id) AS n, COALESCE(SUM(LENGTH(f.content)), 0) AS b FROM code_sites s2 LEFT JOIN code_files f ON f.site_id = s2.id GROUP BY s2.id) c ON c.id = s.id
    SET s.file_count = c.n, s.bytes = c.b
    WHERE s.file_count <> c.n OR s.bytes <> c.b`);
  const anomalies: string[] = [];
  for (const r of await db.q(`SELECT s.id, s.user_id FROM code_sites s LEFT JOIN pages p ON p.code_site_id = s.id AND p.user_id = s.user_id
      WHERE (s.slug IS NULL OR s.slug = '') AND p.id IS NULL ORDER BY s.id`)) {
    anomalies.push(`No address: code page #${intval(r.id)} of user #${intval(r.user_id)} has neither its own address nor a page that shows it`);
  }
  for (const r of await db.q(`SELECT p.id, p.slug, p.code_site_id, s.user_id AS site_user, p.user_id FROM pages p LEFT JOIN code_sites s ON s.id = p.code_site_id
      WHERE p.code_site_id IS NOT NULL AND (s.id IS NULL OR s.user_id <> p.user_id) ORDER BY p.id`)) {
    anomalies.push(`Broken page: link page #${intval(r.id)} (${phpStr(r.slug)}) shows code page #${intval(r.code_site_id)}, which `
      + (r.site_user === null ? 'doesn’t exist' : 'belongs to another account') + ' – visitors see “Page not found”');
  }
  return { recounted: res.affectedRows, anomalies };
}

// oys_code_used_uploads(): Uploads, die in den Dateien einer Code-Seite des Kontos vorkommen (zählen nicht als
// ungenutzt) – über ALLE Code-Seiten, sonst löschte das Aufräumen Bilder, die nur die zweite Code-Seite benutzt
export async function codeUsedUploads(userId: number, sql: Db = poolDb): Promise<Set<string>> {
  const used = new Set<string>();
  for (const site of await codeSites(userId, sql)) {
    for (const f of usedUploadsIn((await codeFiles(intval(site.id), sql)).values(), userId)) used.add(f);
  }
  return used;
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

// oys_code_preview_token(): Vorschau des Besitzers im Editor – zeigt die Seite auch offline (12 Stunden gültig). slug:
// die Adresse, unter der die Seite gezeigt wird (auf einem Seitenplatz dessen Adresse); für die eigene Adresse ist der
// Schlüssel derselbe wie bisher.
export function codePreviewToken(site: Row, at: number | null = null, slug: string = phpStr(site.slug)): string {
  const t = at ?? time();
  return t + '-' + hmac('code-preview|' + phpStr(site.id) + '|' + slug + '|' + t).slice(0, 24);
}

// oys_code_preview_valid(): nur für die Adresse, für die der Schlüssel ausgestellt wurde
export function codePreviewValid(site: Row, token: string, slug: string = phpStr(site.slug)): boolean {
  const m = /^(\d{9,11})-[0-9a-f]{24}\n?$/.exec(token);
  if (!m) return false;
  const age = time() - intval(m[1]);
  return age >= -60 && age <= 43200 && safeEqual(codePreviewToken(site, intval(m[1]), slug), token);
}
