// Admin: Konten löschen, Admin-Rechte umschalten, Passwort neu setzen (views/admin.php, Nutzerverwaltung)
import { exec, value, type Param } from '../db.js';
import { passwordHash } from '../crypto.js';
import { phpTruthy } from '../php.js';
import { deleteAccount } from './accountDeletion.js';

// Konto mit allem löschen – alles oder nichts (accountDeletion.ts). Wirft, wenn nichts gelöscht werden konnte.
export async function deleteUser(id: number): Promise<void> {
  await deleteAccount(null, id);
}

// Admin-Rolle umschalten; ein unbekanntes Konto gilt als „kein Admin“ (wird also „befördert“, ändert aber nichts).
// Gibt den neuen Stand zurück (1 = Admin).
export async function toggleAdmin(id: number): Promise<number> {
  const status = await value('SELECT is_admin FROM users WHERE id = ?', [id]);
  const next = phpTruthy(status) ? 0 : 1;
  await exec('UPDATE users SET is_admin = ? WHERE id = ?', [next, id]);
  return next;
}

// Neues Passwort ohne weitere Prüfung (Länge, Leerzeichen) – wie im Formular eingegeben. id als bigint, damit auch
// riesige Werte genau wie in PHP ankommen.
export async function resetPassword(id: number | bigint, password: string): Promise<void> {
  await exec('UPDATE users SET password = ? WHERE id = ?', [await passwordHash(password), id as Param]);
}
