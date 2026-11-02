// Konto löschen, Teil „honeycombs“ (Haken 40 in admin/accountDeletion.ts): alle Buchungen und Shop-Zeilen des Kontos.
// Das Admin-Protokoll bleibt, verliert aber den Bezug zum Konto (es enthält nur IDs, Beträge und Schlüssel – nie Namen
// oder Notizen). users.premium_until verschwindet mit der Zeile des Kontos.
import type { Db } from '../db.js';

export async function hcDeleteUser(uid: number, db: Db): Promise<void> {
  await db.exec('DELETE FROM hc_entitlements WHERE user_id = ?', [uid]);
  await db.exec('DELETE FROM hc_purchases WHERE user_id = ?', [uid]);
  await db.exec('DELETE FROM hc_accounts WHERE user_id = ?', [uid]);
  await db.exec('UPDATE hc_audit SET user_id = NULL WHERE user_id = ?', [uid]);
  await db.exec('DELETE FROM honeycomb_ledger WHERE user_id = ?', [uid]);
}
