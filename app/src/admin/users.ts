// Admin: Konten löschen, Admin-Rechte umschalten, Passwort neu setzen (views/admin.php, Nutzerverwaltung)
import { unlinkSync } from 'node:fs';
import { exec, value, type Param } from '../db.js';
import { passwordHash } from '../crypto.js';
import { phpTruthy } from '../php.js';
import { deletePage, userPages } from '../content/pages.js';
import { codeDeleteUser } from '../code/sites.js';
import { userUploadFiles } from '../content/uploads.js';
import { uploadPath } from '../content/storage.js';

// Konto mit allem löschen: Seiten (samt Blöcken, Statistik, Nachrichten und Dateien), Benachrichtigungen, alte
// Tabellen, Code-Seite und Honigwaben, übrige Uploads, zuletzt das Konto. Community-Daten bleiben (wie in PHP).
export async function deleteUser(id: number): Promise<void> {
  for (const page of await userPages(id)) {
    await deletePage(page);
  }
  for (const table of ['notifications', 'messages', 'user_links', 'user_bookings', 'user_certificates']) {
    await exec(`DELETE FROM ${table} WHERE user_id = ?`, [id]);
  }
  await codeDeleteUser(id);
  // Was danach noch im Upload-Ordner liegt (z. B. Bilder der Code-Seite), gehört niemandem mehr
  for (const name of userUploadFiles(id).keys()) {
    try {
      unlinkSync(uploadPath(name));
    } catch {
      // wie @unlink: Fehler still übergehen
    }
  }
  await exec('DELETE FROM users WHERE id = ?', [id]);
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
