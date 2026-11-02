// Datenbank: dieselbe MariaDB wie bisher, mit denselben Werten wie PDO in PHP 8.3:
// - Datumswerte als Text ('2026-11-01 10:00:00'), ganze Zahlen (auch COUNT(*)) als Zahl, DECIMAL/SUM/AVG als Text
// - affectedRows wie PDO rowCount(): nur wirklich geänderte Zeilen (ohne FOUND_ROWS)
// - host 'localhost' heißt wie bei PDO: über den Unix-Socket
// - jede Verbindung hat die Zeitzone der Seite (wie db.php mit date('P')); nach einer Zeitumstellung wird sie vor der
//   nächsten Abfrage neu gesetzt, damit „heute“, Statistik und Zeitsteuerung in SQL und in Node übereinstimmen
import { AsyncLocalStorage } from 'node:async_hooks';
import mysql from 'mysql2/promise';
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { configInt, configString } from './config.js';

export type Row = Record<string, unknown>;
export type Param = string | number | bigint | boolean | null | Date | Buffer;

export interface ExecResult {
  affectedRows: number;
  insertId: number;
  changedRows: number;
}

// Abfragen auf einer festen Verbindung (Transaktion, Sperre, mehrere Schritte nacheinander)
export interface Db {
  q<T extends Row = Row>(sql: string, params?: Param[]): Promise<T[]>;
  one<T extends Row = Row>(sql: string, params?: Param[]): Promise<T | null>;
  value(sql: string, params?: Param[]): Promise<unknown>;
  exec(sql: string, params?: Param[]): Promise<ExecResult>;
}

// Datenbank nicht erreichbar (Verbindung, Zugangsdaten, Socket) – führt zur 503-Seite wie in PHP
export class DbUnavailableError extends Error {}
// GET_LOCK hat nicht geklappt (nur bei onBusy 'fail')
export class LockBusyError extends Error {}
// Nur mit OYS_DB_STRICT=1 (Tests): Code, der schon eine Verbindung hält, will eine zweite aus dem Pool
export class NestedConnectionError extends Error {}

// Testschalter (im Betrieb nicht gesetzt): OYS_DB_POOL_SIZE = Größe des Pools (1 deckt verschachtelte Anfragen auf,
// die bei einem vollen Pool hängen würden), OYS_DB_STRICT=1 = eine zweite Verbindung im selben Ablauf wirft sofort
const strictDb = (): boolean => process.env.OYS_DB_STRICT === '1';
function poolSize(): number {
  const env = process.env.OYS_DB_POOL_SIZE;
  if (env !== undefined && /^[1-9][0-9]?$/.test(env)) return Number(env);
  return configInt('db.pool', 10);
}

let pool: Pool | null = null;

// Abstand der Zeitzone zu UTC im Format +01:00 (wie date('P') in PHP) – zum angegebenen Zeitpunkt (Sommerzeit!)
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

// Aktueller Abstand, höchstens eine Minute alt
let tzCache = { minute: -1, zone: '', offset: '+00:00' };
function currentOffset(): string {
  const minute = Math.floor(Date.now() / 60000);
  const zone = timeZone();
  if (tzCache.minute !== minute || tzCache.zone !== zone) tzCache = { minute, zone, offset: tzOffset(zone) };
  return tzCache.offset;
}

// Der Pool selbst. Wer ihn direkt benutzt, umgeht die feste Verbindung des Ablaufs – im strengen Modus ist das
// innerhalb eines Abschnitts ein Fehler (sonst wartet der Abschnitt womöglich auf sich selbst).
export function getPool(): Pool {
  if (strictDb()) assertNoHeldConnection();
  return poolInstance();
}

function poolInstance(): Pool {
  if (pool) return pool;
  const host = configString('db.host', 'localhost');
  pool = mysql.createPool({
    // PDO: 'localhost' = Unix-Socket, alles andere TCP
    ...(host === 'localhost'
      ? { socketPath: configString('db.socket', '/run/mysqld/mysqld.sock') }
      : { host, port: Number(configString('db.port', '3306')) || 3306 }),
    user: configString('db.user', ''),
    password: configString('db.pass', ''),
    database: configString('db.name', ''),
    // wie PDO mit charset=utf8mb4
    charset: 'UTF8MB4_GENERAL_CI',
    connectionLimit: poolSize(),
    enableKeepAlive: true,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    decimalNumbers: false,
    // affectedRows = geänderte Zeilen wie PDO rowCount()
    flags: ['-FOUND_ROWS'],
    namedPlaceholders: false,
    multipleStatements: false,
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

const UNAVAILABLE = new Set(['ECONNREFUSED', 'ENOENT', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND', 'ER_ACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR', 'ER_DBACCESS_DENIED_ERROR', 'PROTOCOL_CONNECTION_LOST']);

// Verbindung holen und die Zeitzone prüfen (nach einer Zeitumstellung neu setzen)
async function acquire(): Promise<PoolConnection> {
  if (strictDb()) assertNoHeldConnection();
  let conn: PoolConnection;
  try {
    conn = await poolInstance().getConnection();
  } catch (err) {
    const code = (err as { code?: string }).code ?? '';
    if (UNAVAILABLE.has(code)) throw new DbUnavailableError(`database unavailable (${code})`);
    throw err;
  }
  const offset = currentOffset();
  const tagged = conn as PoolConnection & { oysOffset?: string };
  if (tagged.oysOffset !== offset) {
    try {
      await conn.query(`SET time_zone = '${offset}'`);
      tagged.oysOffset = offset;
    } catch (err) {
      conn.release();
      throw err;
    }
  }
  return conn;
}

function facade(conn: PoolConnection): Db {
  return {
    async q<T extends Row = Row>(sql: string, params: Param[] = []): Promise<T[]> {
      const [rows] = await conn.query<RowDataPacket[]>(sql, params);
      return rows as unknown as T[];
    },
    async one<T extends Row = Row>(sql: string, params: Param[] = []): Promise<T | null> {
      const [rows] = await conn.query<RowDataPacket[]>(sql, params);
      return ((rows as unknown as T[])[0] ?? null) as T | null;
    },
    async value(sql: string, params: Param[] = []): Promise<unknown> {
      const [rows] = await conn.query<RowDataPacket[]>({ sql, rowsAsArray: true }, params);
      const first = (rows as unknown as unknown[][])[0];
      return first ? first[0] : null;
    },
    async exec(sql: string, params: Param[] = []): Promise<ExecResult> {
      const [res] = await conn.query<ResultSetHeader>(sql, params);
      return { affectedRows: res.affectedRows, insertId: res.insertId, changedRows: (res as unknown as { changedRows?: number }).changedRows ?? 0 };
    },
  };
}

// Feste Verbindung des laufenden Abschnitts (Sperre, Transaktion, mehrere Schritte). PHP hat je Anfrage genau eine
// Verbindung: Alle Abfragen innerhalb eines solchen Abschnitts – auch tief in Hilfsfunktionen – laufen deshalb über
// dieselbe. Sonst hielte der Abschnitt eine Verbindung fest und wartete auf eine zweite aus dem Pool; unter Last sind
// dann alle Verbindungen belegt und nichts geht mehr (Verklemmung).
interface Pinned {
  db: Db;
  conn: PoolConnection;
  inTransaction: boolean;
  released: boolean;
}
const pinned = new AsyncLocalStorage<Pinned>();
// Wer gerade eine Verbindung hält – auch innerhalb von outsidePinned() (nur für den strengen Modus)
const holding = new AsyncLocalStorage<Pinned>();

function assertNoHeldConnection(): void {
  const held = holding.getStore();
  if (held && !held.released) {
    throw new NestedConnectionError('a second pool connection was requested while this code already holds one');
  }
}

// Eine Verbindung für mehrere Schritte (FOR UPDATE, Sperren, LAST_INSERT_ID …); verschachtelt: dieselbe Verbindung
export async function withConnection<T>(fn: (db: Db, conn: PoolConnection) => Promise<T>): Promise<T> {
  const current = pinned.getStore();
  // Noch laufender Abschnitt: weiterverwenden. Ein schon beendeter (z. B. von nachlaufender Hintergrundarbeit) nie.
  if (current && !current.released) return fn(current.db, current.conn);
  const conn = await acquire();
  const store: Pinned = { db: facade(conn), conn, inTransaction: false, released: false };
  try {
    return await holding.run(store, () => pinned.run(store, () => fn(store.db, conn)));
  } finally {
    store.released = true;
    conn.release();
  }
}

// db.php verbindet sich bei jeder Anfrage neu und zeigt ohne Datenbank vor allem anderen die 503-Seite. Node hält
// Verbindungen im Pool und merkt einen Ausfall sonst erst bei der ersten Abfrage – oder nie, wenn eine Seite gar keine
// braucht. Darum vor jeder Anfrage eine kurze Probe. Eine tote Verbindung aus dem Pool (Server neu gestartet, Leitung
// still getrennt) wirft mysql2 danach weg: dann mit der nächsten bzw. einer neuen Verbindung noch einmal versuchen.
export async function dbReachable(): Promise<void> {
  let lastCode = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await withConnection((db) => db.value('SELECT 1'));
      return;
    } catch (err) {
      if (err instanceof DbUnavailableError) throw err;
      const e = err as { fatal?: boolean; code?: string };
      if (!e.fatal) throw err;
      lastCode = e.code ?? 'fatal';
    }
  }
  throw new DbUnavailableError(`database unavailable (${lastCode})`);
}

// Bewusst außerhalb des laufenden Abschnitts arbeiten (eigene Verbindung), z. B. um eine fremde Sperre zu prüfen
export function outsidePinned<T>(fn: () => Promise<T>): Promise<T> {
  return pinned.exit(fn);
}

// Einzelne Abfragen über den Pool
export const q = <T extends Row = Row>(sql: string, params: Param[] = []): Promise<T[]> => withConnection((db) => db.q<T>(sql, params));
export const one = <T extends Row = Row>(sql: string, params: Param[] = []): Promise<T | null> => withConnection((db) => db.one<T>(sql, params));
export const value = (sql: string, params: Param[] = []): Promise<unknown> => withConnection((db) => db.value(sql, params));
export const exec = (sql: string, params: Param[] = []): Promise<ExecResult> => withConnection((db) => db.exec(sql, params));

// Transaktion: alles oder nichts. fn bekommt die Verbindung (wie bisher) und dieselben Abfragen als Db.
// Verschachtelt wirft sie wie PDO ("There is already an active transaction") statt still zu committen.
export async function transaction<T>(fn: (conn: PoolConnection, db: Db) => Promise<T>): Promise<T> {
  return withConnection(async (db, conn) => {
    const store = pinned.getStore() as Pinned;
    if (store.inTransaction) throw new Error('There is already an active transaction');
    await conn.beginTransaction();
    store.inTransaction = true;
    try {
      const out = await fn(conn, db);
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback().catch(() => undefined);
      throw err;
    } finally {
      store.inTransaction = false;
    }
  });
}

// GET_LOCK(name, timeout) … RELEASE_LOCK auf derselben Verbindung. onBusy 'run': weiter, auch wenn die Sperre nicht kam
// (so macht es PHP bei der Migration); 'fail': LockBusyError, wenn GET_LOCK nicht 1 liefert.
export async function withNamedLock<T>(name: string, timeoutSec: number, fn: (db: Db) => Promise<T>, onBusy: 'run' | 'fail' = 'fail'): Promise<T> {
  return withConnection(async (db) => {
    const got = await db.value('SELECT GET_LOCK(?, ?)', [name, timeoutSec]);
    if (Number(got) !== 1 && onBusy === 'fail') throw new LockBusyError(`lock ${name} is busy`);
    try {
      return await fn(db);
    } finally {
      await db.q('SELECT RELEASE_LOCK(?)', [name]).catch(() => undefined);
    }
  });
}
