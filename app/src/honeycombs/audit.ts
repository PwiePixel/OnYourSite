// Protokoll der Admin-Aktionen rund um Honigwaben (hc_audit): wer, was, wann. details enthält nur IDs, Beträge und
// Schlüssel – nie Namen oder Notizen –, damit nach dem Löschen eines Kontos nichts Persönliches übrig bleibt.
import type { Db } from '../db.js';
import { phpJson } from '../html.js';
import { mbSubstr } from '../php.js';
import { nowStr } from './clock.js';

export type AuditDetails = Record<string, number | string | boolean | null>;

export async function audit(db: Db, adminId: number, action: string, userId: number | null, target: string, details: AuditDetails = {}): Promise<void> {
  await db.exec('INSERT INTO hc_audit (admin_id, action, user_id, target, details, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [adminId, mbSubstr(action, 0, 30), userId, mbSubstr(target, 0, 80), phpJson(details, { unescapedUnicode: true, unescapedSlashes: true }), nowStr()]);
}
