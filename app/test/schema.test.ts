// Datenbank-Schema gegen PHP: Neuinstallation und Übernahme alter Profile (users + user_links) müssen in Node
// dieselben Tabellen und Daten ergeben wie oys_ensure_schema(). Jede Seite bekommt eine eigene Test-Datenbank.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import mysql from 'mysql2/promise';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { ROOT_DIR, loadConfig, setConfigForTests, configString, type ConfigData } from '../src/config.js';
import { closePool } from '../src/db.js';
import { encryptData } from '../src/crypto.js';
import { strtotime, time } from '../src/php.js';
import { ensureSchema, SCHEMA_VERSION, V_SESSIONS } from '../src/schema.js';

const BASE = loadConfig();
// Namen aus der Datenbank dieses Arbeitsordners: andere Arbeitsordner auf demselben Server stören sich so nicht
const SOURCE = String((BASE.db as ConfigData).name);
const DBS = { phpFresh: SOURCE + '_schema_pf', nodeFresh: SOURCE + '_schema_nf', phpLegacy: SOURCE + '_schema_pl', nodeLegacy: SOURCE + '_schema_nl' };
let admin: Connection;
let started = 0;

const LEGACY_DDL = [
  `CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(255) NOT NULL UNIQUE, password VARCHAR(255) NOT NULL, full_name VARCHAR(255),
    username VARCHAR(100) UNIQUE, layout_type VARCHAR(50) DEFAULT NULL, last_ip TEXT, bio TEXT, profession VARCHAR(255), detailed_bio TEXT,
    booking_url TEXT, theme VARCHAR(50) DEFAULT 'deep-dark', custom_css TEXT, discord_id TEXT, seo_title VARCHAR(255), seo_description TEXT,
    seo_keywords TEXT, hide_branding TINYINT(1) DEFAULT 0, last_layout_change DATETIME NULL, bg_image VARCHAR(255), cv_file VARCHAR(255),
    profile_image VARCHAR(255), last_subdomain_change DATETIME NULL, profile_views INT DEFAULT 0, is_admin TINYINT(1) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  'CREATE TABLE user_links (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, title VARCHAR(255), url TEXT, icon_class VARCHAR(100), sort_order INT DEFAULT 0, clicks INT DEFAULT 0) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
  'CREATE TABLE user_bookings (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, guest_name TEXT, guest_email TEXT, booking_date DATE, booking_time VARCHAR(10), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
  'CREATE TABLE user_certificates (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, cert_id VARCHAR(50), title VARCHAR(255), issuer VARCHAR(255), issue_date DATE, credential_url TEXT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
];

// Alte Profile mit allen Sonderfällen der Übernahme
function legacyRows(): Array<[string, unknown[]]> {
  const user = 'INSERT INTO users (id, email, password, full_name, username, layout_type, bio, profession, detailed_bio, booking_url, theme, custom_css, seo_title, seo_description, seo_keywords, hide_branding, bg_image, cv_file, profile_image, last_subdomain_change, profile_views, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)';
  const link = 'INSERT INTO user_links (user_id, title, url, icon_class, sort_order, clicks) VALUES (?,?,?,?,?,?)';
  return [
    [user, [3, 'a@x.de', 'h', 'Pixel Admin', 'Pixel', 'link-tree', 'Hallo!', 'Dev', '', encryptData('https://cal.com/pixel'), 'glass',
      'body{background:url(https://evil.com/x.png)} @import "x.css"; a{color:red}</style>', 'Pixel | Site', 'desc', 'k1,k2', 1, 'bg_3.jpg', null, 'avatar_3.png',
      '2026-01-02 03:04:05', 42, '2025-05-05 10:00:00']],
    [user, [5, 'mia@x.de', 'h', 'Mia Müller ' + 'ä'.repeat(130), 'mia', 'about-me', 'Design & Illustration', 'Designerin ' + 'ö'.repeat(170),
      'Ich gestalte.\nSeit 2015.', encryptData('/kalender'), '', '', null, null, null, 0, null, 'file_5_1.pdf', '0', null, -5, '2024-02-29 23:30:00']],
    [user, [6, 'tom@x.de', 'h', 'Tom', 'tom', 'bento-grid', 'Foto', 'Fotograf', '  Meine Story.  ', encryptData('https://calendly.com/tom'), 'midnight',
      '', '', '', '', 0, null, 'card.vcf', null, null, 5, '2025-06-06 12:00:00']],
    [user, [7, 'lea@x.de', 'h', 'Lea', 'LEA', 'minimal-cv', '', '', '', 'ENC:!!!', '0', 'a{}', '', '', '', null, '', 'docs/file.tar.GZ', null, null, null, '2025-07-07 07:07:07']],
    [user, [8, 'noname@x.de', 'h', 'Ohne Domain', null, null, '', '', 'Bio', null, null, '', null, null, null, 0, null, null, null, null, 0, '2025-01-01 00:00:00']],
    [user, [9, 'empty@x.de', 'h', 'Leer', '', null, '', '', '', null, null, '', null, null, null, 0, null, null, null, null, 0, '2025-01-01 00:00:00']],
    [user, [11, 'bee@x.de', 'h', '🐝 Bee', 'bee', 'unknown', '', '', 'Über mich', 'https://plain.example/?a=1&b=2', 'noir',
      'a{content:"😀"} b{background:u\\72l(//evil.com)}', 'A/B "q"', "it's", '', 0, '', 'cv.PDF', '', null, 7, '2025-08-08 08:08:08']],
    [link, [3, 'Instagram', 'https://instagram.com/pixel', 'bx bxl-instagram', 0, 5]],
    [link, [3, '', '', 'x', 1, 9]],
    [link, [3, '  ', ' ', null, 1, 0]],
    [link, [3, ' ', 'https://only.url', null, 3, 3]],
    [link, [3, 'Long ' + 'ü'.repeat(200), 'https://long.example/a/b?c=d&e=f', 'bx bx-link', 2, -3]],
    [link, [6, 'Twitch', 'https://twitch.tv/tom', 'bx bxl-twitch', 0, 2]],
    [link, [11, 'Mail', 'mailto:bee@x.de', null, null, null]],
    [link, [11, 'Web', 'https://bee.example', 'bx bx-globe', null, 1]],
  ];
}

// PHP-Version mit eigener Verbindung auf die Test-Datenbank migrieren lassen
function phpEnsure(db: string): void {
  const script = `require '${ROOT_DIR}/lib/config.php';
    date_default_timezone_set(oys_config('timezone', 'Europe/Berlin'));
    $pdo = new PDO('mysql:host=' . oys_config('db.host', 'localhost') . ';dbname=' . getenv('OYS_TEST_DB') . ';charset=utf8mb4', oys_config('db.user', ''), oys_config('db.pass', ''),
      [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
    $pdo->exec("SET time_zone = '" . date('P') . "'");
    require '${ROOT_DIR}/security.php'; require '${ROOT_DIR}/lib/helpers.php'; require '${ROOT_DIR}/lib/pages.php'; require '${ROOT_DIR}/lib/schema.php';
    oys_ensure_schema($pdo); echo 'ok';`;
  assert.equal(execFileSync('php', ['-r', script], { env: { ...process.env, OYS_TEST_DB: db }, cwd: ROOT_DIR }).toString(), 'ok');
}

// upTo: bis zu diesem Schritt (der Vergleich mit PHP gilt für den Stand der portierten Seite, V_SESSIONS)
async function nodeEnsure(db: string, upTo?: number): Promise<void> {
  setConfigForTests({ ...BASE, db: { ...(BASE.db as ConfigData), name: db } });
  await closePool();
  try {
    await ensureSchema(upTo === undefined ? {} : { upTo });
  } finally {
    await closePool();
    setConfigForTests(BASE);
  }
}

// Einmal erzeugen (Verschlüsselung ist zufällig) und in beide Datenbanken schreiben
let LEGACY_ROWS: Array<[string, unknown[]]> | null = null;

async function freshDb(name: string, legacy: boolean): Promise<void> {
  await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  if (!legacy) return;
  await admin.query(`USE \`${name}\``);
  for (const ddl of LEGACY_DDL) await admin.query(ddl);
  LEGACY_ROWS ??= legacyRows();
  for (const [sql, params] of LEGACY_ROWS) await admin.query(sql, params);
}

const tables = async (db: string): Promise<string[]> =>
  ((await admin.query<RowDataPacket[]>(`SHOW TABLES FROM \`${db}\``))[0]).map((r) => String(Object.values(r)[0])).sort();

async function ddl(db: string, table: string): Promise<string> {
  const [r] = await admin.query<RowDataPacket[]>(`SHOW CREATE TABLE \`${db}\`.\`${table}\``);
  return String(r[0]['Create Table']).replace(/ AUTO_INCREMENT=\d+/, '');
}

// Zeitstempel der Migration selbst („jetzt“) unterscheiden sich um Sekunden – sie werden vereinheitlicht
function normalize(v: unknown): unknown {
  if (typeof v === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(v)) {
    const t = strtotime(v);
    if (t !== false && t >= started - 2 && t <= time() + 2) return 'NOW';
  }
  return v;
}
async function dump(db: string, table: string): Promise<unknown[]> {
  const [r] = await admin.query<RowDataPacket[]>(`SELECT * FROM \`${db}\`.\`${table}\` ORDER BY 1, 2`);
  return r.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, normalize(v)])));
}
async function version(db: string): Promise<string> {
  const [r] = await admin.query<RowDataPacket[]>(`SELECT meta_value FROM \`${db}\`.oys_meta WHERE meta_key = 'schema_version'`);
  return String(r[0]?.meta_value);
}

const DATA_TABLES = ['users', 'user_links', 'pages', 'page_blocks', 'updates', 'milestones', 'milestone_tasks', 'honeycomb_ledger', 'code_sites',
  'community_suggestions', 'community_tickets', 'community_outbox'];

async function assertSame(phpDb: string, nodeDb: string): Promise<void> {
  const phpTables = await tables(phpDb);
  assert.deepEqual(await tables(nodeDb), [...phpTables, 'oys_sessions'].sort());
  for (const t of phpTables) assert.equal(await ddl(nodeDb, t), await ddl(phpDb, t), `table ${t}`);
  for (const t of DATA_TABLES) assert.deepEqual(await dump(nodeDb, t), await dump(phpDb, t), `data in ${t}`);
  const meta = async (db: string) => (await dump(db, 'oys_meta')).filter((r) => (r as { meta_key: string }).meta_key !== 'schema_version');
  assert.deepEqual(await meta(nodeDb), await meta(phpDb));
  assert.equal(await version(phpDb), '4');
  assert.equal(await version(nodeDb), String(V_SESSIONS));
}

before(async () => {
  admin = await mysql.createConnection({
    host: configString('db.host', 'localhost'), user: configString('db.user', ''), password: configString('db.pass', ''),
    charset: 'utf8mb4_unicode_ci', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
  });
  started = time();
});

after(async () => {
  for (const db of Object.values(DBS)) await admin.query(`DROP DATABASE IF EXISTS \`${db}\``);
  await admin.end();
});

test('a fresh install creates the same tables and seeds as PHP', async () => {
  await freshDb(DBS.phpFresh, false);
  await freshDb(DBS.nodeFresh, false);
  phpEnsure(DBS.phpFresh);
  await nodeEnsure(DBS.nodeFresh, V_SESSIONS);
  await assertSame(DBS.phpFresh, DBS.nodeFresh);
  assert.equal((await dump(DBS.nodeFresh, 'updates')).length, 4);
});

test('old profiles are taken over exactly like PHP does it', async () => {
  await freshDb(DBS.phpLegacy, true);
  await freshDb(DBS.nodeLegacy, true);
  phpEnsure(DBS.phpLegacy);
  await nodeEnsure(DBS.nodeLegacy, V_SESSIONS);
  await assertSame(DBS.phpLegacy, DBS.nodeLegacy);
  // Stichproben: Seiten nur für Nutzer mit Adresse, „Story“ nach den Links bei bento-grid, fremde Adressen im CSS entfernt
  const pages = (await dump(DBS.nodeLegacy, 'pages')) as Array<Record<string, unknown>>;
  assert.deepEqual(pages.map((p) => p.slug), ['pixel', 'mia', 'tom', 'lea', 'bee']);
  assert.ok(!String(pages[0].settings).includes('evil.com'));
  const tomBlocks = ((await dump(DBS.nodeLegacy, 'page_blocks')) as Array<Record<string, unknown>>).filter((b) => b.page_id === pages[2].id);
  assert.deepEqual(tomBlocks.map((b) => b.type), ['booking', 'file', 'link', 'heading', 'text']);
});

test('Node upgrades a database PHP has migrated, and a second run changes nothing', async () => {
  const before = await Promise.all(DATA_TABLES.map((t) => dump(DBS.phpLegacy, t)));
  // Spalten, die spätere Schritte anfügen (z. B. pages.custom_domain), sind bei bestehenden Zeilen leer; alle bisherigen
  // Werte bleiben, wie sie waren
  const known = async (): Promise<unknown[][]> => (await Promise.all(DATA_TABLES.map((t) => dump(DBS.phpLegacy, t)))).map((rows, i) =>
    (rows as Array<Record<string, unknown>>).map((row, j) => {
      const old = (before[i] as Array<Record<string, unknown>>)[j] ?? {};
      for (const [k, v] of Object.entries(row)) if (!(k in old)) assert.equal(v, null, `${DATA_TABLES[i]}.${k} of an existing row`);
      return Object.fromEntries(Object.entries(row).filter(([k]) => k in old));
    }));
  await nodeEnsure(DBS.phpLegacy);
  assert.equal(await version(DBS.phpLegacy), String(SCHEMA_VERSION));
  assert.ok((await tables(DBS.phpLegacy)).includes('oys_sessions'));
  assert.deepEqual(await known(), before);
  // PHP kommt mit der höheren Version zurecht (nichts wird erneut ausgeführt)
  phpEnsure(DBS.phpLegacy);
  await nodeEnsure(DBS.phpLegacy);
  assert.deepEqual(await known(), before);
});

test('the feature steps give a database PHP installed the same tables as a fresh Node install', async () => {
  // Beide bis zum letzten Schritt: PHP-Neuinstallation (Version 4) + Node gegen Node allein
  await nodeEnsure(DBS.phpFresh);
  await nodeEnsure(DBS.nodeFresh);
  assert.equal(await version(DBS.phpFresh), String(SCHEMA_VERSION));
  assert.equal(await version(DBS.nodeFresh), String(SCHEMA_VERSION));
  const all = await tables(DBS.nodeFresh);
  assert.deepEqual(await tables(DBS.phpFresh), all);
  for (const t of all) assert.equal(await ddl(DBS.phpFresh, t), await ddl(DBS.nodeFresh, t), `table ${t}`);
  assert.match(await ddl(DBS.nodeFresh, 'notifications'), /KEY `idx_user_id` \(`user_id`,`id`\)/);
});
