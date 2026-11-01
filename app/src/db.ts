// Datenbank: dieselbe MariaDB wie bisher. Jede Verbindung bekommt die Zeitzone der Seite (wie db.php mit date('P')),
// damit „heute“, Statistik und Zeitsteuerung in SQL und in Node übereinstimmen.
import mysql from 'mysql2/promise';
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { configString } from './config.js';

export type Row = Record<string, unknown>;
export type Param = string | number | boolean | null | Date | Buffer;

let pool: Pool | null = null;

// Abstand der Zeitzone zu UTC im Format +01:00 (wie date('P') in PHP) – zum jetzigen Zeitpunkt (Sommerzeit!)
export function tzOffset(timeZone: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const minutes = Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

export function timeZone(): string {
  return configString('timezone', 'Europe/Berlin') || 'Europe/Berlin';
}

export function getPool(): Pool {
  if (pool) return pool;
  pool = mysql.createPool({
    host: configString('db.host', 'localhost'),
    port: Number(configString('db.port', '3306')) || 3306,
    user: configString('db.user', ''),
    password: configString('db.pass', ''),
    database: configString('db.name', ''),
    charset: 'utf8mb4_unicode_ci',
    connectionLimit: 10,
    // Datumswerte als Text wie bei PDO ('2026-11-01 10:00:00'), keine JS-Date-Objekte
    dateStrings: true,
    // Große Zahlen (BIGINT) als Text, damit nichts gerundet wird; DECIMAL ebenso
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    namedPlaceholders: false,
    multipleStatements: false,
  });
  // Neue Verbindungen: Zeitzone wie PHP (date('P') beim Verbinden)
  (pool as unknown as { pool: { on(event: string, cb: (c: { query(sql: string): void }) => void): void } }).pool.on('connection', (conn) => {
    conn.query(`SET time_zone = '${tzOffset(timeZone())}'`);
  });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

// SELECT … → Zeilen
export async function q<T extends Row = Row>(sql: string, params: Param[] = []): Promise<T[]> {
  const [rows] = await getPool().query<RowDataPacket[]>(sql, params);
  return rows as unknown as T[];
}

// Erste Zeile oder null
export async function one<T extends Row = Row>(sql: string, params: Param[] = []): Promise<T | null> {
  const rows = await q<T>(sql, params);
  return rows[0] ?? null;
}

// Erster Wert der ersten Zeile (wie fetchColumn) oder null
export async function value(sql: string, params: Param[] = []): Promise<unknown> {
  const [rows] = await getPool().query<RowDataPacket[]>({ sql, rowsAsArray: true }, params);
  const first = (rows as unknown as unknown[][])[0];
  return first ? first[0] : null;
}

// INSERT/UPDATE/DELETE → betroffene Zeilen und neue ID
export async function exec(sql: string, params: Param[] = []): Promise<{ affectedRows: number; insertId: number }> {
  const [res] = await getPool().query<ResultSetHeader>(sql, params);
  return { affectedRows: res.affectedRows, insertId: res.insertId };
}

// Transaktion: alles oder nichts
export async function transaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (err) {
    await conn.rollback().catch(() => undefined);
    throw err;
  } finally {
    conn.release();
  }
}
