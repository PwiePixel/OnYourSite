// Code-Seiten (lib/codesites.php): eigene Websites aus HTML/CSS/JS unter name.on-your.site
import { q, one, type Row } from '../db.js';
import { rawurldecode } from '../php.js';

// oys_code_site(): die Code-Seite eines Kontos
export const codeSite = (userId: number): Promise<Row | null> => one('SELECT * FROM code_sites WHERE user_id = ? LIMIT 1', [userId]);
// oys_code_site_by_id()
export const codeSiteById = (id: number): Promise<Row | null> => one('SELECT * FROM code_sites WHERE id = ?', [id]);
// oys_code_site_by_slug()
export const codeSiteBySlug = (slug: string): Promise<Row | null> => one('SELECT * FROM code_sites WHERE slug = ? LIMIT 1', [slug]);

// oys_code_files(): Pfad → Inhalt, nach Pfad sortiert (Map behält die Reihenfolge wie ein PHP-Array)
export async function codeFiles(siteId: number): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const row of await q('SELECT path, content FROM code_files WHERE site_id = ? ORDER BY path', [siteId])) files.set(String(row.path), String(row.content ?? ''));
  return files;
}

// oys_code_used_uploads(): Uploads, die in den Dateien der Code-Seite vorkommen (zählen nicht als ungenutzt)
export async function codeUsedUploads(userId: number): Promise<Set<string>> {
  const site = await codeSite(userId);
  return site ? usedUploadsIn((await codeFiles(Number(site.id))).values(), userId) : new Set();
}

export function usedUploadsIn(contents: Iterable<string>, userId: number): Set<string> {
  const used = new Set<string>();
  const own = new RegExp(`[a-z]+_${userId}_\\d{9,11}_[0-9a-f]{8}\\.[a-z0-9]{2,5}`, 'g');
  for (const content of contents) {
    // Dateinamen dieser Version (name_ID_zeit_zufall.ext), egal wie sie eingebunden sind
    for (const m of content.matchAll(own)) used.add(m[0]);
    // ältere Dateinamen über ihre Adresse (auch ohne / am Anfang)
    for (const m of content.matchAll(/static\/uploads\/([A-Za-z0-9._%-]+)/g)) used.add(rawurldecode(m[1]));
  }
  return used;
}
