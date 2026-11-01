// Gemeinsame Werkzeuge für die Tests des Updates-Pakets: eine eigene Test-Datenbank, PHP mit denselben Einstellungen
// (eigene Datenbank und Discord-Adresse, ohne config.php anzufassen) und ein vergleichbarer Datenbankstand.
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { ROOT_DIR, configString, loadConfig, setConfigForTests, type ConfigData } from '../../../src/config.js';
import { closePool } from '../../../src/db.js';
import { decryptData } from '../../../src/crypto.js';
import { ensureSchema } from '../../../src/schema.js';
import { strtotime, time } from '../../../src/php.js';

export const BASE_CONFIG = loadConfig();

export interface TestEnv {
  db: string;
  apiBase: string;
  admin: Connection;
  // PHP-Code mit $pdo, $in (JSON von STDIN) und allen Funktionen aus lib/updates.php; Ergebnis per return.
  // apiBase: andere Discord-Adresse nur für diesen Aufruf. Läuft asynchron, damit die Discord-Attrappe im selben
  // Node-Prozess währenddessen antworten kann.
  php(code: string, input?: unknown, apiBase?: string): Promise<unknown>;
  close(): Promise<void>;
}

// Eigene Datenbank (Node legt das Schema an) und ein PHP-Bootstrap, das dieselbe Datenbank und Discord-Adresse nutzt.
// config.php von PHP liest seinen Pfad relativ zu lib/ – darum liegen Kopien von lib/config.php und security.php in
// einem eigenen Ordner neben einer config.php, die nur Datenbank und discord_api_base ersetzt.
export async function createTestEnv(db: string, apiBase: string): Promise<TestEnv> {
  const admin = await mysql.createConnection({
    host: configString('db.host', 'localhost'), user: configString('db.user', ''), password: configString('db.pass', ''),
    charset: 'utf8mb4_unicode_ci', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${db}\``);
  await admin.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  setConfigForTests({ ...BASE_CONFIG, db: { ...(BASE_CONFIG.db as ConfigData), name: db }, discord_api_base: apiBase });
  await closePool();
  await ensureSchema();

  const dir = mkdtempSync(join(tmpdir(), 'oys-updates-php-'));
  mkdirSync(join(dir, 'lib'));
  copyFileSync(join(ROOT_DIR, 'lib/config.php'), join(dir, 'lib/config.php'));
  copyFileSync(join(ROOT_DIR, 'security.php'), join(dir, 'security.php'));
  writeFileSync(join(dir, 'config.php'), `<?php
$c = require ${JSON.stringify(join(ROOT_DIR, 'config.php'))};
$c['db']['name'] = getenv('OYS_TEST_DB');
$c['discord_api_base'] = getenv('OYS_TEST_DISCORD');
return $c;
`);
  const boot = `require '${dir}/lib/config.php'; require '${dir}/security.php';
    date_default_timezone_set(oys_config('timezone', 'Europe/Berlin')); mb_internal_encoding('UTF-8');
    require '${ROOT_DIR}/lib/helpers.php'; require '${ROOT_DIR}/lib/updates.php';
    $pdo = new PDO('mysql:host=' . oys_config('db.host', 'localhost') . ';dbname=' . oys_config('db.name', '') . ';charset=utf8mb4', oys_config('db.user', ''), oys_config('db.pass', ''),
      [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
    $pdo->exec("SET time_zone = '" . date('P') . "'");`;

  return {
    db,
    apiBase,
    admin,
    async php(code: string, input: unknown = null, base: string = apiBase): Promise<unknown> {
      const script = boot + ` $in = json_decode(stream_get_contents(STDIN), true); $out = (function ($in) use ($pdo) { ${code} })($in);
        echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);`;
      const out = await runPhp(['-d', 'display_errors=stderr', '-r', script], JSON.stringify(input), { ...process.env, OYS_TEST_DB: db, OYS_TEST_DISCORD: base });
      return JSON.parse(out);
    },
    async close() {
      await closePool();
      setConfigForTests(BASE_CONFIG);
      await admin.query(`DROP DATABASE IF EXISTS \`${db}\``);
      await admin.end();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// php -r … mit Eingabe auf STDIN, ohne die Ereignisschleife anzuhalten
function runPhp(args: string[], input: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('php', args, { cwd: ROOT_DIR, env });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else reject(new Error(`php exited with ${code}: ${Buffer.concat(err).toString('utf8').slice(0, 2000)}`));
    });
    child.stdin.end(input);
  });
}

export const TABLES = ['updates', 'milestones', 'milestone_tasks'] as const;

// Tabellen leeren und mit festen Zeilen füllen (feste IDs → beide Seiten haben danach dieselben AUTO_INCREMENT-Werte)
export async function loadFixture(env: TestEnv, rows: Record<string, Array<Record<string, unknown>>>, meta: Record<string, string | null> = {}): Promise<void> {
  const c = env.admin;
  await c.query(`USE \`${env.db}\``);
  for (const t of [...TABLES, 'oys_sessions']) await c.query(`TRUNCATE TABLE \`${t}\``);
  await c.query("DELETE FROM oys_meta WHERE meta_key <> 'schema_version'");
  for (const [table, list] of Object.entries(rows)) {
    for (const row of list) {
      const keys = Object.keys(row);
      await c.query(`INSERT INTO \`${table}\` (${keys.map((k) => '`' + k + '`').join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, Object.values(row));
    }
  }
  for (const [key, value] of Object.entries(meta)) {
    if (value !== null) await c.query('INSERT INTO oys_meta (meta_key, meta_value) VALUES (?, ?)', [key, value]);
  }
}

// Zeitstempel, die während eines Laufs entstanden sind („jetzt“), unterscheiden sich zwischen PHP und Node um
// Sekunden – sie werden zu NOW. Alles andere bleibt, wie es ist.
export function normalizeNow(text: string, from: number, to: number): string {
  return text
    .replace(/\b(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)\b/g, (m) => {
      const t = strtotime(m);
      return t !== false && t >= from - 2 && t <= to + 2 ? 'NOW' : m;
    })
    .replace(/\b(\d{4}-\d\d-\d\d)T(\d\d:\d\d:\d\d)Z\b/g, (m) => {
      const t = Date.parse(m) / 1000;
      return t >= from - 2 && t <= to + 2 ? 'NOW' : m;
    })
    // Dauer in den Fehlertexten von curl
    .replace(/after \d+ ms/g, 'after N ms')
    .replace(/after \d+ milliseconds/g, 'after N milliseconds');
}

// Inhalt der Tabellen (verschlüsselte Discord-Einstellungen entschlüsselt) als Text
export async function snapshot(env: TestEnv): Promise<string> {
  const c = env.admin;
  const out: Record<string, unknown> = {};
  for (const t of TABLES) {
    const [rows] = await c.query<RowDataPacket[]>(`SELECT * FROM \`${env.db}\`.\`${t}\` ORDER BY id`);
    out[t] = rows;
  }
  const [meta] = await c.query<RowDataPacket[]>(`SELECT meta_key, meta_value FROM \`${env.db}\`.oys_meta WHERE meta_key <> 'schema_version' ORDER BY meta_key`);
  out.oys_meta = meta.map((r) => ({ key: r.meta_key, value: String(r.meta_value ?? '').startsWith('ENC:') ? 'DEC:' + decryptData(String(r.meta_value)) : r.meta_value }));
  const [ai] = await c.query<RowDataPacket[]>(`SELECT TABLE_NAME, AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('updates', 'milestones', 'milestone_tasks') ORDER BY TABLE_NAME`, [env.db]);
  out.auto_increment = ai;
  return JSON.stringify(out, null, 1);
}

export const now = (): number => time();
