// Benachrichtigungen für die Glocke (früher oys_notify in lib/spam.php) – die EINZIGE Stelle, die `notifications`
// schreibt (ein Test sucht nach anderen). Regel für alle Funktionen: Die Zeile entsteht in derselben Transaktion wie
// die Änderung, über die sie berichtet ({ db }) – das macht sie „genau einmal“. notify() selbst entfernt keine
// Doppelten.
import { exec, q, type Db } from '../db.js';
import { date, mbSubstr } from '../php.js';
import { safeLink } from './links.js';

export { safeLink } from './links.js';

export interface NotifyOptions {
  // Verbindung oder Transaktion des Aufrufers (Migration, Job, Sperre); sonst der Pool
  db?: Db;
}

// Typen sind kurze Namen aus dem Katalog (types.ts) – ein anderer Wert ist ein Fehler im Code
function checkType(type: string): string {
  if (!/^[a-z][a-z0-9_]{0,23}$/.test(type)) throw new Error(`invalid notification type: ${type}`);
  return type;
}

// Eine Zeile für ein Konto: Titel ≤ 190, Text ≤ 255 Zeichen (Codepunkte wie die Spalten), Ziel nur ein eigener Pfad
export async function notify(userId: number, type: string, title: string, body = '', link = '', opts: NotifyOptions = {}): Promise<void> {
  const sql = 'INSERT INTO notifications (user_id, type, title, body, link, is_read, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)';
  const params = [userId, checkType(type), mbSubstr(title, 0, 190), mbSubstr(body, 0, 255), safeLink(link), date('Y-m-d H:i:s')];
  await (opts.db ? opts.db.exec(sql, params) : exec(sql, params));
}

// Je Admin eine Zeile (z. B. „Something needs an admin“); Rückgabe: Anzahl der Zeilen
export async function notifyAdmins(type: string, title: string, body = '', link = '', opts: NotifyOptions = {}): Promise<number> {
  checkType(type);
  const sql = 'SELECT id FROM users WHERE is_admin = 1 ORDER BY id';
  const admins = opts.db ? await opts.db.q(sql) : await q(sql);
  for (const a of admins) await notify(Number(a.id), type, title, body, link, opts);
  return admins.length;
}
