// Admin: Konten löschen, Admin-Rechte umschalten, Passwort neu setzen (views/admin.php, Nutzerverwaltung)
import { exec, transaction, type Param } from '../db.js';
import { passwordHash } from '../crypto.js';
import { phpTruthy } from '../php.js';
import { markReconcile, reconcileNow } from '../honeycombs/reconcile.js';
import { deleteAccount } from './accountDeletion.js';

// Konto mit allem löschen – alles oder nichts (accountDeletion.ts). Wirft, wenn nichts gelöscht werden konnte.
export async function deleteUser(id: number): Promise<void> {
  await deleteAccount(null, id);
}

// Admin-Rolle umschalten; ein unbekanntes Konto gilt als „kein Admin“ (wird also „befördert“, ändert aber nichts).
// Gibt den neuen Stand zurück (1 = Admin). Admins haben Premium und manches mehr (includedFor): Die Rolle und der
// Abgleich-Merker der Honigwaben ändern sich in einer Transaktion, danach läuft der Abgleich (Domains, Statusseiten …).
export async function toggleAdmin(id: number): Promise<number> {
  const { next, exists } = await transaction(async (_conn, db) => {
    // Erst die Zeile des Honigwaben-Kontos (der Merker sperrt sie), dann users – dieselbe Reihenfolge wie jeder Kauf
    // (withAccount: hc_accounts, danach z. B. users.premium_until). Andersherum verklemmen sich Kauf und Rollenwechsel.
    if ((await db.value('SELECT 1 FROM users WHERE id = ?', [id])) !== null) await markReconcile(db, id);
    const user = await db.one('SELECT id, is_admin FROM users WHERE id = ? FOR UPDATE', [id]);
    const next = phpTruthy(user?.is_admin) ? 0 : 1;
    await db.exec('UPDATE users SET is_admin = ? WHERE id = ?', [next, id]);
    return { next, exists: user !== null };
  });
  // Das ist eine Anfrage: nur die schnellen Abgleiche – langsame (z. B. Aufrufe bei Cloudflare) übernimmt der Job
  if (exists) await reconcileNow(id, { inlineOnly: true });
  return next;
}

// Neues Passwort ohne weitere Prüfung (Länge, Leerzeichen) – wie im Formular eingegeben. id als bigint, damit auch
// riesige Werte genau wie in PHP ankommen.
export async function resetPassword(id: number | bigint, password: string): Promise<void> {
  await exec('UPDATE users SET password = ? WHERE id = ?', [await passwordHash(password), id as Param]);
}
