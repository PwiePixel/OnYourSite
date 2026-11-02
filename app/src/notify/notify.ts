// Benachrichtigungen für die Glocke (früher oys_notify in lib/spam.php) – die EINZIGE Stelle, die `notifications`
// schreibt (ein Test sucht nach anderen). Regel für alle Funktionen: Die Zeile entsteht in derselben Transaktion wie
// die Änderung, über die sie berichtet ({ db }) – das macht sie „genau einmal“. notify() selbst entfernt keine
// Doppelten.
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { exec, q, type Db, type Param, type Row } from '../db.js';
import { date, mbSubstr } from '../php.js';
import { safeLink } from './links.js';

export { safeLink } from './links.js';

export interface NotifyOptions {
  // Verbindung oder Transaktion des Aufrufers: die Db aus transaction()/withConnection() oder die rohe Verbindung
  // eines Schema-Schritts (notify(…, { db: conn })); ohne Angabe der Pool
  db?: Db | PoolConnection;
}

// Db (q/exec) oder PoolConnection (query)? Eine PoolConnection hat kein exec.
function isDb(db: Db | PoolConnection): db is Db {
  return typeof (db as Partial<Db>).exec === 'function';
}

async function write(db: Db | PoolConnection | undefined, sql: string, params: Param[]): Promise<void> {
  if (!db) await exec(sql, params);
  else if (isDb(db)) await db.exec(sql, params);
  else await db.query(sql, params);
}

async function read(db: Db | PoolConnection | undefined, sql: string): Promise<Row[]> {
  if (!db) return q(sql);
  if (isDb(db)) return db.q(sql);
  const [rows] = await db.query<RowDataPacket[]>(sql);
  return rows as unknown as Row[];
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
  await write(opts.db, sql, params);
}

// Je Admin eine Zeile (z. B. „Something needs an admin“); Rückgabe: Anzahl der Zeilen
export async function notifyAdmins(type: string, title: string, body = '', link = '', opts: NotifyOptions = {}): Promise<number> {
  checkType(type);
  const admins = await read(opts.db, 'SELECT id FROM users WHERE is_admin = 1 ORDER BY id');
  for (const a of admins) await notify(Number(a.id), type, title, body, link, opts);
  return admins.length;
}
