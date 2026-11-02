// Gemeinsame Hilfen der Kern-Tests: eine eigene Kopie der Test-Datenbank je Testdatei (Name = Datenbank dieses
// Arbeitsordners + Endung, damit parallele Läufe sich nicht stören), ein eigener Upload-Ordner und Sitzungen mit Login.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { configString, loadConfig, setConfigForTests, type ConfigData } from '../src/config.js';
import { closePool } from '../src/db.js';
import { makeTestCtx, isHalt, type Ctx } from '../src/web/ctx.js';
import { Session } from '../src/web/session.js';

export const BASE = loadConfig();
export const SOURCE = configString('db.name');

export async function adminConnection(): Promise<Connection> {
  return mysql.createConnection({
    host: configString('db.host', 'localhost'), user: configString('db.user', ''), password: configString('db.pass', ''),
    charset: 'utf8mb4_unicode_ci', dateStrings: true, supportBigNumbers: true,
  });
}

export interface TestDb {
  name: string;
  admin: Connection;
  uploads: string;
  done(): Promise<void>;
}

// Kopie der Datenbank (oder eine leere mit empty: true) und ein leerer Upload-Ordner; die Seite benutzt beides
export async function testDatabase(suffix: string, opts: { empty?: boolean } = {}): Promise<TestDb> {
  const admin = await adminConnection();
  const name = SOURCE + '_' + suffix;
  await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  if (!opts.empty) {
    const [tables] = await admin.query<RowDataPacket[]>(`SHOW TABLES FROM \`${SOURCE}\``);
    for (const row of tables) {
      const t = String(Object.values(row)[0]);
      await admin.query(`CREATE TABLE \`${name}\`.\`${t}\` LIKE \`${SOURCE}\`.\`${t}\``);
      await admin.query(`INSERT INTO \`${name}\`.\`${t}\` SELECT * FROM \`${SOURCE}\`.\`${t}\``);
    }
  }
  const uploads = mkdtempSync(join(tmpdir(), 'oys-core-uploads-'));
  await closePool();
  setConfigForTests({ ...BASE, db: { ...(BASE.db as ConfigData), name }, uploads_dir: uploads });
  return {
    name,
    admin,
    uploads,
    async done() {
      await closePool();
      setConfigForTests(BASE);
      await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
      await admin.end();
      rmSync(uploads, { recursive: true, force: true });
    },
  };
}

// Angemeldete Sitzung (optional als Admin im Nutzer-Modus) mit festem CSRF-Token
export const CSRF = 'c'.repeat(64);
export async function loginSession(userId: number, opts: { impersonatedBy?: number } = {}): Promise<string> {
  const ctx = makeTestCtx({ url: '/dashboard' });
  const s = await Session.start(ctx);
  s.set('user_id', userId);
  s.set('csrf', CSRF);
  if (opts.impersonatedBy !== undefined) s.set('original_admin_id', opts.impersonatedBy);
  await s.close();
  return s.id;
}

// Eine Anfrage wie über den Server: Ende mit exit (Halt), Sitzung danach speichern
export async function runRequest(ctx: Ctx, handler: (ctx: Ctx) => Promise<void>): Promise<Ctx> {
  try {
    await handler(ctx);
  } catch (err) {
    if (!isHalt(err)) throw err;
  } finally {
    await ctx.session?.close();
  }
  return ctx;
}

// JSON-Antwort lesen
export function jsonBody(ctx: Ctx): Record<string, unknown> {
  return JSON.parse(String(ctx.body)) as Record<string, unknown>;
}
