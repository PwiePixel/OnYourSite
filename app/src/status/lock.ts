// Statusseiten: Leitsperre der Hintergrunddienste – GET_LOCK auf einer eigenen Verbindung, die der Dienst sein Leben
// lang hält (nicht aus dem Pool). So läuft nie ein zweiter Prüfdienst gleichzeitig, auch nicht während eines Neustarts.
// Antwortet die Verbindung nicht mehr, ist die Sperre weg: der Dienst hört auf zu schreiben und holt sie sich neu.
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { configString } from '../config.js';

export async function lockConnection(): Promise<Connection> {
  const host = configString('db.host', 'localhost');
  return mysql.createConnection({
    ...(host === 'localhost'
      ? { socketPath: configString('db.socket', '/run/mysqld/mysqld.sock') }
      : { host, port: Number(configString('db.port', '3306')) || 3306 }),
    user: configString('db.user', ''),
    password: configString('db.pass', ''),
    database: configString('db.name', ''),
    connectTimeout: 10_000,
  });
}

export class LeaderLock {
  private conn: Connection | null = null;
  constructor(readonly name: string, private readonly connect: () => Promise<Connection> = lockConnection) {}

  get held(): boolean {
    return this.conn !== null;
  }

  // Sperre holen, ohne zu warten; false = ein anderer hat sie
  async acquire(): Promise<boolean> {
    await this.release();
    const conn = await this.connect();
    try {
      const [rows] = await conn.query<RowDataPacket[]>('SELECT GET_LOCK(?, 0) AS got', [this.name]);
      if (Number(rows[0]?.got) === 1) {
        this.conn = conn;
        conn.on('error', () => {
          this.conn = null;
        });
        return true;
      }
    } catch {
      // keine Sperre
    }
    await conn.end().catch(() => undefined);
    return false;
  }

  // Hält diese Verbindung die Sperre noch?
  async alive(): Promise<boolean> {
    const conn = this.conn;
    if (!conn) return false;
    try {
      const [rows] = await conn.query<RowDataPacket[]>('SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS mine', [this.name]);
      return Number(rows[0]?.mine) === 1;
    } catch {
      this.conn = null;
      return false;
    }
  }

  async release(): Promise<void> {
    const conn = this.conn;
    this.conn = null;
    if (!conn) return;
    await conn.query('SELECT RELEASE_LOCK(?)', [this.name]).catch(() => undefined);
    await conn.end().catch(() => undefined);
  }
}
