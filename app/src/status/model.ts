// Statusseiten: Seiten und Bestandteile lesen, Änderungen anzeigen (rev). Gemeinsam für Webseite, Prüfdienst und
// Benachrichtigungsdienst – jede Funktion nimmt die Verbindung des Aufrufers (Transaktion), nie eine zweite aus dem Pool.
// Jede Änderung an Seite, Bestandteilen oder Vorfällen erhöht status_pages.rev (Zwischenspeicher der öffentlichen Seite)
// und oys_meta.status_rev (der Prüfdienst gleicht dann ab) – in derselben Transaktion.
import type { Db, Row } from '../db.js';
import { baseAuthority, scheme } from '../helpers.js';
import { date } from '../php.js';

export const SYSTEM_SLUG = 'status';

export interface StatusPageRow {
  id: number;
  userId: number | null;
  isSystem: boolean;
  slug: string;
  title: string;
  description: string;
  theme: string;
  settings: string | null;
  published: boolean;
  blocked: boolean;
  blockedReason: string;
  reviewNote: string;
  reviewedAt: number | null;
  rev: number;
  createdAt: string | null;
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const truthy = (v: unknown): boolean => v === 1 || v === '1' || v === true;

export function pageFromRow(r: Row): StatusPageRow {
  return {
    id: Number(r.id),
    userId: num(r.user_id),
    isSystem: truthy(r.is_system),
    slug: String(r.slug ?? ''),
    title: String(r.title ?? ''),
    description: String(r.description ?? ''),
    theme: String(r.theme ?? 'deep-dark'),
    settings: r.settings === null || r.settings === undefined ? null : String(r.settings),
    published: truthy(r.is_published),
    blocked: truthy(r.is_blocked),
    blockedReason: String(r.blocked_reason ?? ''),
    reviewNote: String(r.review_note ?? ''),
    reviewedAt: num(r.reviewed_at),
    rev: Number(r.rev ?? 0),
    createdAt: r.created_at === null || r.created_at === undefined ? null : String(r.created_at),
  };
}

const PAGE_COLUMNS = 'id, user_id, is_system, slug, title, description, theme, settings, is_published, is_blocked, blocked_reason, review_note, reviewed_at, rev, created_at';

export async function statusPageBySlug(db: Db, slug: string): Promise<StatusPageRow | null> {
  const r = await db.one(`SELECT ${PAGE_COLUMNS} FROM status_pages WHERE slug = ?`, [slug]);
  return r ? pageFromRow(r) : null;
}

export async function statusPageById(db: Db, id: number): Promise<StatusPageRow | null> {
  const r = await db.one(`SELECT ${PAGE_COLUMNS} FROM status_pages WHERE id = ?`, [id]);
  return r ? pageFromRow(r) : null;
}

export async function systemStatusPage(db: Db): Promise<StatusPageRow | null> {
  const r = await db.one(`SELECT ${PAGE_COLUMNS} FROM status_pages WHERE is_system = 1 ORDER BY id LIMIT 1`);
  return r ? pageFromRow(r) : null;
}

export async function statusPageForUser(db: Db, userId: number): Promise<StatusPageRow | null> {
  const r = await db.one(`SELECT ${PAGE_COLUMNS} FROM status_pages WHERE user_id = ? AND is_system = 0`, [userId]);
  return r ? pageFromRow(r) : null;
}

// Adresse einer Statusseite: immer ihre eigene Subdomain (eigener Ursprung)
// Benutzt eine Profil- oder Code-Seite die Adresse der Statusseite? (Dann bleibt sie offline, Entwurf §3.1 – die
// Subdomain zeigt zuerst diese Seite)
export async function slugTaken(db: Db, slug: string): Promise<boolean> {
  return Number(await db.value('SELECT (SELECT COUNT(*) FROM pages WHERE slug = ?) + (SELECT COUNT(*) FROM code_sites WHERE slug = ?)', [slug, slug])) > 0;
}

export function statusPageUrl(slug: string, path = '/'): string {
  return scheme() + '://' + slug + '.' + baseAuthority() + path;
}

// Sperre der Seite für eine Änderung (Reihenfolge: Seite → Bestandteile/Vorfälle)
export async function lockStatusPage(db: Db, pageId: number): Promise<boolean> {
  return (await db.one('SELECT id FROM status_pages WHERE id = ? FOR UPDATE', [pageId])) !== null;
}

// Änderung sichtbar machen: rev der Seite (Zwischenspeicher), changed_at (Abgleich des Prüfdienstes) und status_rev
export async function bumpRev(db: Db, pageId: number, now = Math.floor(Date.now() / 1000)): Promise<void> {
  await db.exec('UPDATE status_pages SET rev = rev + 1, changed_at = ?, updated_at = ? WHERE id = ?', [now, date('Y-m-d H:i:s', now), pageId]);
  await bumpGlobalRev(db);
}

export async function bumpGlobalRev(db: Db): Promise<void> {
  await db.exec("INSERT INTO oys_meta (meta_key, meta_value) VALUES ('status_rev', '1') ON DUPLICATE KEY UPDATE meta_value = CAST(meta_value AS UNSIGNED) + 1");
}

// Ein Wert aus oys_meta als JSON-Objekt (fehlt oder kaputt: null)
export async function metaJson(db: Db, key: string): Promise<Record<string, unknown> | null> {
  const raw = await db.value('SELECT meta_value FROM oys_meta WHERE meta_key = ?', [key]);
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function parseObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw === '') return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export const numOrNull = num;
export const isTrue = truthy;
