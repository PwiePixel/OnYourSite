// Profilseiten laden (lib/pages.php). Einstellungen, Blöcke und Speichern kommen mit dem Inhalts-Paket dazu.
import { q, one, type Row } from '../db.js';

// oys_load_page()
export const loadPage = (id: number): Promise<Row | null> => one('SELECT * FROM pages WHERE id = ?', [id]);
// oys_load_page_by_slug()
export const loadPageBySlug = (slug: string): Promise<Row | null> => one('SELECT * FROM pages WHERE slug = ? LIMIT 1', [slug]);
// oys_user_pages(): Reihenfolge wie im Editor
export const userPages = (userId: number): Promise<Row[]> => q('SELECT * FROM pages WHERE user_id = ? ORDER BY position ASC, id ASC', [userId]);
