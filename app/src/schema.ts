// Datenbank-Schema und automatische Migration (wie lib/schema.php). Läuft beim Start einmal auf einer eigenen
// Verbindung (GET_LOCK gilt je Verbindung). Alte Tabellen werden NICHT gelöscht. Die Versionsnummer steht wie bisher
// in oys_meta.schema_version – PHP hat bis 4 gezählt, die Node-Version macht dort weiter.
//
// Schritte (ab 6: Funktionen nach dem Umstieg): je Schritt eine Funktion `async function name(conn)` hier in dieser Datei
// und eine Konstante `export const V_NAME = n` – n ist beim Zusammenführen die nächste freie Zahl. Neue Schritte
// kommen ans Ende von STEPS; ensureSchema() führt jeden Schritt mit version < V_NAME genau in dieser Reihenfolge aus und
// speichert die Version erst nach dem letzten. Jede Anweisung eines Schritts muss deshalb wiederholbar sein
// (CREATE TABLE IF NOT EXISTS, addColumn, addIndex, dropIndex …). Der Kopfkommentar eines Schritts nennt die
// Schritte, die er braucht. Tests benutzen nur die Konstanten, nie Zahlen. Benachrichtigungen schreibt ein Schritt nur
// über notify(…, { db: conn }). Hintergrunddienste migrieren nie – sie warten mit schemaAtLeast(V_…) auf ihren Schritt.
import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { withConnection } from './db.js';
import { date, intval, mbSubstr, phpStr, phpTrim, phpTruthy, strtolower, strtotime, time } from './php.js';
import { phpJson } from './html.js';
import { decryptData } from './crypto.js';
import { cleanCss } from './css.js';
import { partitionClauseFor } from './status/partitions.js';
import { decodeStored, discordSettingsFromV1, encodeSettings, normalizeV1 } from './discord/settings.js';
import { legacyPostRow } from './discord/legacy.js';
import { botSecret } from './community/community.js';
import { baseAuthority } from './helpers.js';
import { notify } from './notify/notify.js';
import { cssHides } from './content/brandingCss.js';
import { isArr, jsonDecode, own } from './content/util.js';
import { configString } from './config.js';

// Stand der portierten Seite (Release 3.0 migriert genau bis hier)
export const V_PAGES = 1; // Profilseiten + Übernahme der alten Profile
export const V_UPDATES = 2; // Updates, Roadmap, Discord
export const V_CODE_PAGES = 3; // Honigwaben und Code-Seiten
export const V_COMMUNITY = 4; // Discord-Bot (Vorschläge, Support-Tickets)
export const V_SESSIONS = 5; // Sitzungen in der Datenbank (Node-Version)
// Funktionen nach dem Umstieg (Nummer = Reihenfolge des Zusammenführens)
export const V_NOTIFICATIONS_INDEX = 6; // Glocke: neueste zuerst und „gelesen bis“
export const V_CUSTOM_DOMAINS = 7; // Eigene Domains (Premium): Domains, Verlauf, Hauptadresse der Seite
export const V_SITE_ADDRESSES = 8; // Adressen aller Seiten in einer Tabelle, freigegebene bleiben reserviert
export const V_CODE_SLOTS = 9; // Code-Seiten auch auf Seitenadressen (Plätze), Zähler, Moderation
export const V_STATUS_TABLES = 10; // Statusseiten: Tabellen, eigene Seite von OnYourSite
export const V_SHOP_CORE = 11; // Honigwaben: Konten, Berechtigungen, Premium-Status, Admin-Protokoll
export const V_SHOP_CATALOGUE = 12; // Honigwaben: Katalog mit Preisen, Angebote, Käufe
export const V_DISCORD_DELIVERY = 13; // Discord: Beiträge je Ziel, Aufträge des Bots mit ref und Pausen, Einstellungen v2
export const V_PUBLIC_PAGES = 14; // Öffentliche Vorschlagsseite: Sichtbarkeit je Vorschlag, Adresse „suggestions“ reserviert
export const V_BRANDING_LEGACY = 15; // Premium: Seiten, die den Hinweis heute ausblenden, behalten das (Q9)
export const V_DOMAIN_RECORDS = 16; // Eigene Domains: Zusatz-Einträge von Cloudflare (Apex: Besitz-TXT, DCV) je Domain
export const V_DOMAIN_BLOCKS = 17; // Eigene Domains: vom Team gesperrte Hostnamen bleiben gesperrt, auch nach „Entfernen“ (R2)
export const V_CODE_SLOTS_LIVE = 18; // Code-Seiten-Plätze live (CS-6): gespeichertes max_on_pages 0 aus der dunklen Phase wird 1
export const V_SHOP_STREAKS = 19; // Honigwaben: Serie je Konto (streak, streak_day, best_streak), aus den Tagesbuchungen nachgetragen

const OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
type Row = Record<string, unknown>;

async function rows(conn: PoolConnection, sql: string, params: unknown[] = []): Promise<Row[]> {
  const [r] = await conn.query<RowDataPacket[]>(sql, params);
  return r as unknown as Row[];
}
async function run(conn: PoolConnection, sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
  const [r] = await conn.query<ResultSetHeader>(sql, params);
  return r;
}

export interface SchemaStep {
  version: number;
  name: string;
  run: (conn: PoolConnection) => Promise<void>;
}

// Alle Schritte in Merge-Reihenfolge (aufsteigende Versionen, keine doppelt)
const STEPS: readonly SchemaStep[] = [
  { version: V_PAGES, name: 'pages', run: async (conn) => {
    await createTables(conn);
    await migrateLegacyUsers(conn);
  } },
  { version: V_UPDATES, name: 'updates', run: createUpdateTables },
  { version: V_CODE_PAGES, name: 'codePages', run: createCodeTables },
  { version: V_COMMUNITY, name: 'community', run: createCommunityTables },
  { version: V_SESSIONS, name: 'sessions', run: createSessionTable },
  { version: V_NOTIFICATIONS_INDEX, name: 'notificationsIndex', run: notificationsIndex },
  { version: V_CUSTOM_DOMAINS, name: 'customDomains', run: customDomains },
  { version: V_SITE_ADDRESSES, name: 'siteAddresses', run: siteAddresses },
  { version: V_CODE_SLOTS, name: 'codeSlots', run: codeSlots },
  { version: V_STATUS_TABLES, name: 'statusTables', run: statusTables },
  { version: V_SHOP_CORE, name: 'shopCore', run: shopCore },
  { version: V_SHOP_CATALOGUE, name: 'shopCatalogue', run: shopCatalogue },
  { version: V_DISCORD_DELIVERY, name: 'discordDelivery', run: discordDelivery },
  { version: V_PUBLIC_PAGES, name: 'publicPages', run: publicPages },
  { version: V_BRANDING_LEGACY, name: 'brandingLegacy', run: brandingLegacy },
  { version: V_DOMAIN_RECORDS, name: 'domainRecords', run: domainRecords },
  { version: V_DOMAIN_BLOCKS, name: 'domainBlocks', run: domainBlocks },
  { version: V_CODE_SLOTS_LIVE, name: 'codeSlotsLive', run: codeSlotsLive },
  { version: V_SHOP_STREAKS, name: 'shopStreaks', run: shopStreaks },
];

for (let i = 1; i < STEPS.length; i++) {
  if (!(STEPS[i].version > STEPS[i - 1].version)) throw new Error(`schema step ${STEPS[i].name} is out of order`);
}

// Höchster Schritt = Version einer vollständig migrierten Datenbank
export const SCHEMA_VERSION = STEPS[STEPS.length - 1].version;

// Fehlt die Tabelle oder die Zeile, gilt Version 0
export async function schemaVersion(conn: PoolConnection): Promise<number> {
  try {
    const r = await rows(conn, "SELECT meta_value FROM oys_meta WHERE meta_key = 'schema_version'");
    return r.length ? intval(r[0].meta_value) : 0;
  } catch {
    return 0;
  }
}

// Nur lesen: ist die Datenbank mindestens auf diesem Schritt? (für Hintergrunddienste, die nie selbst migrieren)
export async function schemaAtLeast(version: number): Promise<boolean> {
  return withConnection(async (_db, conn) => (await schemaVersion(conn)) >= version);
}

// Schritte, die eine Datenbank auf diesem Stand noch braucht (rein, ohne Datenbank; Tests und Fehlersuche).
// Ob install.sh --update sichert, hängt davon nicht ab: Es sichert vor jedem Update (ROADMAP §2.4).
export function stepsAfter(version: number, upTo: number = SCHEMA_VERSION): Array<{ version: number; name: string }> {
  return STEPS.filter((s) => s.version > version && s.version <= upTo).map((s) => ({ version: s.version, name: s.name }));
}

// Einmal je Prozess: beim Start und – falls die Datenbank da nicht erreichbar war – mit der nächsten Anfrage
// (wie PHP, das bei jeder Anfrage prüft). Gleichzeitige Aufrufe warten auf denselben Versuch.
let schemaReady = false;
let schemaTry: Promise<void> | null = null;
export async function ensureSchemaOnce(): Promise<void> {
  if (schemaReady) return;
  schemaTry ??= ensureSchema()
    .then(() => {
      schemaReady = true;
    })
    .finally(() => {
      schemaTry = null;
    });
  await schemaTry;
}

// upTo (nur für Tests): bis zu diesem Schritt migrieren, z. B. { upTo: V_FEATURE - 1 } als Ausgangsstand eines Tests
export async function ensureSchema(opts: { upTo?: number } = {}): Promise<void> {
  const target = Math.min(opts.upTo ?? SCHEMA_VERSION, SCHEMA_VERSION);
  // Eigene Verbindung mit der Zeitzone der Seite (TIMESTAMP-Werte der alten Profile werden übernommen)
  await withConnection(async (_db, conn) => {
    if ((await schemaVersion(conn)) >= target) return;
    // Nur ein Prozess migriert gleichzeitig
    await conn.query("SELECT GET_LOCK('oys_migrate', 60)");
    try {
      const version = await schemaVersion(conn);
      if (version >= target) return;
      // Jeder Schritt läuft genau einmal
      for (const step of STEPS) {
        if (version < step.version && step.version <= target) await step.run(conn);
      }
      await run(conn, "REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('schema_version', ?)", [String(target)]);
    } finally {
      await conn.query("SELECT RELEASE_LOCK('oys_migrate')");
    }
  });
}

// ---------------------------------------------------------------- Hilfen für wiederholbare Schritte

// Namen von Tabellen, Spalten und Indizes stehen im Code, nie aus Eingaben – trotzdem nur einfache Namen
function ident(name: string): string {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) throw new Error(`invalid identifier for a schema step: ${name}`);
  return name;
}

// Tabelle vorhanden? (z. B. Rückfüllen aus der Tabelle eines anderen Schritts, falls es sie schon gibt)
export async function hasTable(conn: PoolConnection, table: string): Promise<boolean> {
  return (await rows(conn, 'SHOW TABLES LIKE ?', [ident(table).replace(/_/g, '\\_')])).length > 0;
}

// Index vorhanden?
export async function hasIndex(conn: PoolConnection, table: string, name: string): Promise<boolean> {
  return (await rows(conn, `SHOW INDEX FROM \`${ident(table)}\` WHERE Key_name = ?`, [ident(name)])).length > 0;
}

// Index anlegen, falls es ihn noch nicht gibt. definition nennt den Namen selbst, z. B. 'KEY idx_user_id (user_id, id)'
// oder 'UNIQUE KEY uq_slug (slug)' – sonst wäre der Schritt nicht wiederholbar.
export async function addIndex(conn: PoolConnection, table: string, name: string, definition: string): Promise<void> {
  if (!new RegExp(`^(UNIQUE |FULLTEXT )?(KEY|INDEX) \`?${ident(name)}\`? \\(`, 'i').test(definition)) {
    throw new Error(`index definition must name ${name}: ${definition}`);
  }
  if (!(await hasIndex(conn, table, name))) await run(conn, `ALTER TABLE \`${ident(table)}\` ADD ${definition}`);
}

// Index entfernen, falls vorhanden
export async function dropIndex(conn: PoolConnection, table: string, name: string): Promise<void> {
  if (await hasIndex(conn, table, name)) await run(conn, `ALTER TABLE \`${ident(table)}\` DROP INDEX \`${ident(name)}\``);
}

// Spalte vorhanden und NOT NULL? (z. B. ein MODIFY … NULL nur einmal ausführen)
export async function columnIsNotNull(conn: PoolConnection, table: string, column: string): Promise<boolean> {
  const r = await rows(conn, `SHOW COLUMNS FROM \`${ident(table)}\` WHERE Field = ?`, [ident(column)]);
  return r.length > 0 && r[0].Null === 'NO';
}

// Spalte anlegen, falls es sie noch nicht gibt
export async function addColumn(conn: PoolConnection, table: string, column: string, definition: string): Promise<void> {
  const r = await rows(conn, `SHOW COLUMNS FROM \`${ident(table)}\` WHERE Field = ?`, [ident(column)]);
  if (!r.length) await run(conn, `ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
}

async function createTables(conn: PoolConnection): Promise<void> {
  await run(conn, `CREATE TABLE IF NOT EXISTS oys_meta (
        meta_key VARCHAR(64) NOT NULL PRIMARY KEY,
        meta_value TEXT NULL
    ) ${OPTS}`);

  // Bestehende Tabellen (nur für Neuinstallationen – existieren sie schon, passiert nichts)
  await run(conn, `CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        password VARCHAR(255) NOT NULL,
        full_name VARCHAR(255) NULL,
        username VARCHAR(100) NULL,
        layout_type VARCHAR(50) NULL,
        last_ip TEXT NULL,
        bio TEXT NULL,
        profession VARCHAR(255) NULL,
        detailed_bio TEXT NULL,
        booking_url TEXT NULL,
        theme VARCHAR(50) NULL,
        custom_css TEXT NULL,
        discord_id TEXT NULL,
        seo_title VARCHAR(255) NULL,
        seo_description TEXT NULL,
        seo_keywords TEXT NULL,
        hide_branding TINYINT(1) NOT NULL DEFAULT 0,
        last_layout_change DATETIME NULL,
        bg_image VARCHAR(255) NULL,
        cv_file VARCHAR(255) NULL,
        profile_image VARCHAR(255) NULL,
        last_subdomain_change DATETIME NULL,
        profile_views INT NOT NULL DEFAULT 0,
        is_admin TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_email (email),
        UNIQUE KEY uq_username (username)
    ) ${OPTS}`);

  await run(conn, `CREATE TABLE IF NOT EXISTS user_links (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        title VARCHAR(255) NULL,
        url TEXT NULL,
        icon_class VARCHAR(100) NULL,
        sort_order INT NOT NULL DEFAULT 0,
        clicks INT NOT NULL DEFAULT 0,
        KEY idx_user (user_id)
    ) ${OPTS}`);

  await run(conn, `CREATE TABLE IF NOT EXISTS user_bookings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        guest_name TEXT NULL,
        guest_email TEXT NULL,
        booking_date DATE NULL,
        booking_time VARCHAR(10) NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_user (user_id)
    ) ${OPTS}`);

  await run(conn, `CREATE TABLE IF NOT EXISTS user_certificates (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        cert_id VARCHAR(50) NULL,
        title VARCHAR(255) NULL,
        issuer VARCHAR(255) NULL,
        issue_date DATE NULL,
        credential_url TEXT NULL,
        KEY idx_user (user_id)
    ) ${OPTS}`);

  // Neue Tabellen
  await run(conn, `CREATE TABLE IF NOT EXISTS pages (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        slug VARCHAR(63) NOT NULL,
        position TINYINT UNSIGNED NOT NULL DEFAULT 0,
        title VARCHAR(120) NOT NULL DEFAULT '',
        subtitle VARCHAR(160) NOT NULL DEFAULT '',
        bio TEXT NULL,
        avatar VARCHAR(255) NULL,
        bg_image VARCHAR(255) NULL,
        theme VARCHAR(40) NOT NULL DEFAULT 'deep-dark',
        layout VARCHAR(40) NOT NULL DEFAULT 'buttons',
        address_mode VARCHAR(12) NOT NULL DEFAULT 'subdomain',
        settings MEDIUMTEXT NULL,
        views INT UNSIGNED NOT NULL DEFAULT 0,
        slug_changed_at DATETIME NULL,
        created_at DATETIME NULL,
        updated_at DATETIME NULL,
        UNIQUE KEY uq_slug (slug),
        KEY idx_user (user_id)
    ) ${OPTS}`);

  await run(conn, `CREATE TABLE IF NOT EXISTS page_blocks (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        page_id INT UNSIGNED NOT NULL,
        type VARCHAR(24) NOT NULL,
        position SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        is_visible TINYINT(1) NOT NULL DEFAULT 1,
        data MEDIUMTEXT NULL,
        schedule TEXT NULL,
        protection VARCHAR(12) NOT NULL DEFAULT 'none',
        password_hash VARCHAR(255) NULL,
        effect VARCHAR(12) NOT NULL DEFAULT 'none',
        clicks INT UNSIGNED NOT NULL DEFAULT 0,
        legacy_link_id INT NULL,
        created_at DATETIME NULL,
        KEY idx_page (page_id, position),
        KEY idx_legacy (legacy_link_id)
    ) ${OPTS}`);

  // Statistik ohne Cookies und ohne IP-Adressen: nur Zähler pro Tag
  await run(conn, `CREATE TABLE IF NOT EXISTS stats_daily (
        page_id INT UNSIGNED NOT NULL,
        day DATE NOT NULL,
        views INT UNSIGNED NOT NULL DEFAULT 0,
        clicks INT UNSIGNED NOT NULL DEFAULT 0,
        PRIMARY KEY (page_id, day)
    ) ${OPTS}`);

  // item = Plattform bei Social-Icons (z. B. "instagram"), sonst leer
  await run(conn, `CREATE TABLE IF NOT EXISTS block_clicks_daily (
        block_id INT UNSIGNED NOT NULL,
        item VARCHAR(24) NOT NULL DEFAULT '',
        day DATE NOT NULL,
        page_id INT UNSIGNED NOT NULL,
        clicks INT UNSIGNED NOT NULL DEFAULT 0,
        PRIMARY KEY (block_id, item, day),
        KEY idx_page_day (page_id, day)
    ) ${OPTS}`);

  await run(conn, `CREATE TABLE IF NOT EXISTS messages (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        page_id INT UNSIGNED NOT NULL,
        user_id INT NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        message TEXT NOT NULL,
        is_read TINYINT(1) NOT NULL DEFAULT 0,
        created_at DATETIME NULL,
        KEY idx_user (user_id, is_read),
        KEY idx_page (page_id)
    ) ${OPTS}`);

  await run(conn, `CREATE TABLE IF NOT EXISTS notifications (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        type VARCHAR(24) NOT NULL,
        title VARCHAR(190) NOT NULL,
        body VARCHAR(255) NULL,
        link VARCHAR(255) NULL,
        is_read TINYINT(1) NOT NULL DEFAULT 0,
        created_at DATETIME NULL,
        KEY idx_user (user_id, is_read)
    ) ${OPTS}`);

  await run(conn, `CREATE TABLE IF NOT EXISTS rate_limits (
        rl_key VARCHAR(100) NOT NULL PRIMARY KEY,
        hits INT UNSIGNED NOT NULL DEFAULT 0,
        window_start DATETIME NOT NULL
    ) ${OPTS}`);

  // Neue Spalten in users
  await addColumn(conn, 'users', 'weekly_report', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addColumn(conn, 'users', 'weekly_report_sent_at', 'DATETIME NULL');
}

// Updates (Changelog) und Roadmap
async function createUpdateTables(conn: PoolConnection): Promise<void> {
  await run(conn, `CREATE TABLE IF NOT EXISTS updates (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(160) NOT NULL,
        body MEDIUMTEXT NULL,
        version VARCHAR(40) NULL,
        category VARCHAR(20) NOT NULL DEFAULT 'new',
        milestone_id INT NULL,
        is_published TINYINT(1) NOT NULL DEFAULT 0,
        published_at DATETIME NULL,
        discord_announce TINYINT(1) NOT NULL DEFAULT 1,
        discord_message_id VARCHAR(32) NULL,
        discord_target VARCHAR(64) NULL,
        created_at DATETIME NULL,
        updated_at DATETIME NULL,
        KEY idx_published (is_published, published_at)
    ) ${OPTS}`);
  await run(conn, `CREATE TABLE IF NOT EXISTS milestones (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(160) NOT NULL,
        description TEXT NULL,
        status VARCHAR(12) NOT NULL DEFAULT 'planned',
        target VARCHAR(40) NULL,
        position INT NOT NULL DEFAULT 0,
        is_public TINYINT(1) NOT NULL DEFAULT 1,
        started_at DATETIME NULL,
        done_at DATETIME NULL,
        created_at DATETIME NULL,
        updated_at DATETIME NULL,
        KEY idx_status (status, position)
    ) ${OPTS}`);
  await run(conn, `CREATE TABLE IF NOT EXISTS milestone_tasks (
        id INT AUTO_INCREMENT PRIMARY KEY,
        milestone_id INT NOT NULL,
        title VARCHAR(200) NOT NULL,
        is_done TINYINT(1) NOT NULL DEFAULT 0,
        position INT NOT NULL DEFAULT 0,
        done_at DATETIME NULL,
        KEY idx_milestone (milestone_id, position)
    ) ${OPTS}`);

  // Bisheriger Verlauf als Entwürfe – im Admin prüfen und veröffentlichen.
  // Ältere Einträge werden beim Veröffentlichen nicht in Discord angekündigt (sonst mehrere Pings auf einmal).
  const count = await rows(conn, 'SELECT COUNT(*) AS n FROM updates');
  if (intval(count[0]?.n) === 0) {
    const now = date('Y-m-d H:i:s');
    for (const [day, version, category, title, body] of UPDATE_SEEDS) {
      await run(conn, 'INSERT INTO updates (title, body, version, category, is_published, published_at, discord_announce, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)',
        [title, body, version, category, day, day === null ? 1 : 0, now, now]);
    }
  }

  // /updates und /roadmap gehören jetzt zur Hauptseite: Seiten mit diesem Namen bleiben über ihre Subdomain erreichbar
  await run(conn, "UPDATE pages SET address_mode = 'subdomain' WHERE slug IN ('updates', 'roadmap') AND address_mode = 'path'");
}

// Honigwaben (Buchungen) und Code-Seiten (eigene Websites aus HTML/CSS/JS)
async function createCodeTables(conn: PoolConnection): Promise<void> {
  await run(conn, `CREATE TABLE IF NOT EXISTS honeycomb_ledger (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        amount INT NOT NULL,
        reason VARCHAR(20) NOT NULL,
        ref VARCHAR(80) NOT NULL DEFAULT '',
        note VARCHAR(200) NOT NULL DEFAULT '',
        created_at DATETIME NOT NULL,
        UNIQUE KEY uq_entry (user_id, reason, ref),
        KEY idx_user (user_id, id)
    ) ${OPTS}`);
  await run(conn, `CREATE TABLE IF NOT EXISTS code_sites (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        slug VARCHAR(63) NOT NULL,
        title VARCHAR(120) NOT NULL DEFAULT '',
        is_published TINYINT(1) NOT NULL DEFAULT 1,
        is_blocked TINYINT(1) NOT NULL DEFAULT 0,
        blocked_reason VARCHAR(200) NULL,
        views INT UNSIGNED NOT NULL DEFAULT 0,
        created_at DATETIME NULL,
        updated_at DATETIME NULL,
        UNIQUE KEY uq_user (user_id),
        UNIQUE KEY uq_slug (slug)
    ) ${OPTS}`);
  await run(conn, `CREATE TABLE IF NOT EXISTS code_files (
        id INT AUTO_INCREMENT PRIMARY KEY,
        site_id INT NOT NULL,
        path VARCHAR(120) NOT NULL,
        content MEDIUMTEXT NOT NULL,
        updated_at DATETIME NULL,
        UNIQUE KEY uq_path (site_id, path)
    ) ${OPTS}`);
  await addColumn(conn, 'users', 'code_terms_at', 'DATETIME NULL');
}

// Discord-Bot: Vorschläge aus dem Forum-Kanal, Support-Tickets und Aufträge der Webseite an den Bot
async function createCommunityTables(conn: PoolConnection): Promise<void> {
  await run(conn, `CREATE TABLE IF NOT EXISTS community_suggestions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        thread_id VARCHAR(22) NOT NULL,
        author_id VARCHAR(22) NOT NULL,
        author_name VARCHAR(100) NOT NULL DEFAULT '',
        title VARCHAR(200) NOT NULL,
        body TEXT NOT NULL,
        status VARCHAR(10) NOT NULL DEFAULT 'open',
        reason VARCHAR(500) NOT NULL DEFAULT '',
        decided_by VARCHAR(100) NOT NULL DEFAULT '',
        decided_via VARCHAR(10) NOT NULL DEFAULT '',
        decided_at DATETIME NULL,
        status_message_id VARCHAR(22) NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        UNIQUE KEY uq_thread (thread_id),
        KEY idx_status (status, id)
    ) ${OPTS}`);
  await run(conn, `CREATE TABLE IF NOT EXISTS community_tickets (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(22) NOT NULL,
        user_name VARCHAR(100) NOT NULL DEFAULT '',
        subject VARCHAR(100) NOT NULL,
        channel_id VARCHAR(22) NULL,
        status VARCHAR(10) NOT NULL DEFAULT 'open',
        closed_by VARCHAR(100) NOT NULL DEFAULT '',
        closed_via VARCHAR(10) NOT NULL DEFAULT '',
        closed_at DATETIME NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        UNIQUE KEY uq_channel (channel_id),
        KEY idx_user (user_id, status),
        KEY idx_status (status, updated_at)
    ) ${OPTS}`);
  await run(conn, `CREATE TABLE IF NOT EXISTS community_ticket_messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ticket_id INT NOT NULL,
        discord_message_id VARCHAR(22) NULL,
        author_id VARCHAR(22) NULL,
        author_name VARCHAR(100) NOT NULL DEFAULT '',
        is_team TINYINT(1) NOT NULL DEFAULT 0,
        source VARCHAR(10) NOT NULL DEFAULT 'discord',
        body MEDIUMTEXT NOT NULL,
        created_at DATETIME NOT NULL,
        UNIQUE KEY uq_message (discord_message_id),
        KEY idx_ticket (ticket_id, id)
    ) ${OPTS}`);
  await run(conn, `CREATE TABLE IF NOT EXISTS community_outbox (
        id INT AUTO_INCREMENT PRIMARY KEY,
        action VARCHAR(30) NOT NULL,
        payload MEDIUMTEXT NOT NULL,
        attempts INT NOT NULL DEFAULT 0,
        last_error VARCHAR(200) NULL,
        created_at DATETIME NOT NULL,
        done_at DATETIME NULL,
        KEY idx_pending (done_at, id)
    ) ${OPTS}`);
}

// Sitzungen (PHP hatte Dateien): Inhalt als JSON, nach 24 Minuten ohne Aufruf abgelaufen
async function createSessionTable(conn: PoolConnection): Promise<void> {
  await run(conn, `CREATE TABLE IF NOT EXISTS oys_sessions (
        id VARCHAR(64) NOT NULL PRIMARY KEY,
        data MEDIUMTEXT NOT NULL,
        last_seen INT UNSIGNED NOT NULL,
        KEY idx_seen (last_seen)
    ) ${OPTS}`);
}

// V_NOTIFICATIONS_INDEX (braucht nur die Tabelle aus V_PAGES): Index für die Glocke – die letzten Einträge eines
// Kontos und „gelesen bis id“. idx_user (user_id, is_read) bleibt für die Zahl der ungelesenen.
async function notificationsIndex(conn: PoolConnection): Promise<void> {
  await addIndex(conn, 'notifications', 'idx_user_id', 'KEY idx_user_id (user_id, id)');
}

// V_DOMAIN_RECORDS (braucht custom_domains aus V_CUSTOM_DOMAINS): Einträge, die Cloudflare zusätzlich verlangt
// (Apex-Domains: Besitz-TXT „_cf-custom-hostname“, DCV-TXT oder delegierter DCV-CNAME). Der Domain-Dienst schreibt sie
// als JSON-Liste [{type, name, value}] bei jeder Abfrage bei Cloudflare neu; NULL = keine nötig. Der Editor zeigt sie
// unter „Additional records“.
async function domainRecords(conn: PoolConnection): Promise<void> {
  await addColumn(conn, 'custom_domains', 'extra_records', 'TEXT NULL');
}

// V_DOMAIN_BLOCKS (braucht custom_domains aus V_CUSTOM_DOMAINS): vom Team gesperrte Hostnamen (Entscheidung R2).
// Solange die gesperrte Domain an ihrer Seite hängt, sperrt ihre Zeile (Zustand blocked) den Hostnamen. Entfernt der
// Besitzer sie (oder gehen Seite oder Konto), verschwindet die Zeile wie sonst – die Sperre bleibt hier stehen, für
// jedes Konto, bis ein Admin sie aufhebt (releaseBlock in domains/store.ts).
async function domainBlocks(conn: PoolConnection): Promise<void> {
  await run(conn, `CREATE TABLE IF NOT EXISTS custom_domain_blocks (
        hostname VARCHAR(253) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
        reason VARCHAR(200) NULL,
        created_at DATETIME NOT NULL
    ) ${OPTS}`);
}

// V_CUSTOM_DOMAINS (braucht nur pages aus V_PAGES): eigene Domains (Premium). Eine Zeile je Domain, Ziel ist (vorerst)
// eine Profilseite; Hostnamen immer klein in ASCII/Punycode. Jede Änderung zählt version hoch (Compare-and-set).
// Der Verlauf ist zugleich die Mail-Warteschlange des Domain-Dienstes und die Liste aller Cloudflare-IDs, die er
// angelegt hat. pages.custom_domain ist die Hauptadresse, solange die Domain live ist (mehrfach NULL erlaubt).
async function customDomains(conn: PoolConnection): Promise<void> {
  await run(conn, `CREATE TABLE IF NOT EXISTS custom_domains (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        hostname VARCHAR(253) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        target_type VARCHAR(8) NOT NULL DEFAULT 'page',
        target_id INT UNSIGNED NOT NULL,
        user_id INT NOT NULL,
        state VARCHAR(12) NOT NULL DEFAULT 'verifying',
        version INT UNSIGNED NOT NULL DEFAULT 0,
        state_at DATETIME NOT NULL,
        is_apex TINYINT(1) NOT NULL DEFAULT 0,
        zone_name VARCHAR(253) CHARACTER SET ascii COLLATE ascii_bin NULL,
        redirect TINYINT(1) NOT NULL DEFAULT 1,
        cf_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
        cf_status VARCHAR(32) NOT NULL DEFAULT '',
        cf_ssl_status VARCHAR(32) NOT NULL DEFAULT '',
        cf_created_at DATETIME NULL,
        problem VARCHAR(32) NOT NULL DEFAULT '',
        problem_detail VARCHAR(255) NOT NULL DEFAULT '',
        fail_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        fail_since DATETIME NULL,
        dns_unknown_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        dns_unknown_since DATETIME NULL,
        checked_at DATETIME NULL,
        next_check_at DATETIME NULL,
        fast_until DATETIME NULL,
        manual_at DATETIME NULL,
        patched_at DATETIME NULL,
        verified_at DATETIME NULL,
        activated_at DATETIME NULL,
        suspended_at DATETIME NULL,
        notice_state TINYINT UNSIGNED NOT NULL DEFAULT 0,
        notice_at DATETIME NULL,
        blocked_reason VARCHAR(200) NULL,
        cert_expires_at DATETIME NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        UNIQUE KEY uq_hostname (hostname),
        UNIQUE KEY uq_target (target_type, target_id),
        KEY idx_user (user_id, state),
        KEY idx_due (next_check_at),
        KEY idx_state (state, state_at),
        KEY idx_cf (cf_id)
    ) ${OPTS}`);
  await run(conn, `CREATE TABLE IF NOT EXISTS custom_domain_log (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        domain_id INT UNSIGNED NULL,
        hostname VARCHAR(253) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        user_id INT NULL,
        event VARCHAR(24) NOT NULL,
        detail VARCHAR(255) NOT NULL DEFAULT '',
        cf_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
        mail TINYINT UNSIGNED NOT NULL DEFAULT 0,
        mail_tries TINYINT UNSIGNED NOT NULL DEFAULT 0,
        mailed_at DATETIME NULL,
        created_at DATETIME NOT NULL,
        KEY idx_domain (domain_id, id),
        KEY idx_host (hostname, id),
        KEY idx_cf (cf_id),
        KEY idx_mail (mail, mailed_at)
    ) ${OPTS}`);
  await addColumn(conn, 'pages', 'custom_domain', 'VARCHAR(253) CHARACTER SET ascii COLLATE ascii_bin NULL');
  await addIndex(conn, 'pages', 'uq_custom_domain', 'UNIQUE KEY uq_custom_domain (custom_domain)');
}

// V_SITE_ADDRESSES (braucht V_PAGES und V_CODE_PAGES; status_pages aus V_STATUS_TABLES nur, wenn es die Tabelle schon
// gibt): eine Zeile je Adresse – Link-Seite, Code-Seite, Statusseite oder reserviert (kind = 'held'). Der Primärschlüssel
// hält jede Adresse über alle Arten eindeutig. Regeln und Schreibzugriffe stehen in content/addresses.ts.
async function siteAddresses(conn: PoolConnection): Promise<void> {
  await run(conn, `CREATE TABLE IF NOT EXISTS site_addresses (
        slug VARCHAR(63) NOT NULL PRIMARY KEY,
        kind VARCHAR(8) NOT NULL,
        ref_id INT NULL,
        user_id INT NULL,
        claimed_at DATETIME NOT NULL,
        released_at DATETIME NULL,
        hold_until DATETIME NULL,
        KEY idx_ref (kind, ref_id),
        KEY idx_user (user_id),
        KEY idx_hold (kind, hold_until)
    ) ${OPTS}`);
  // Bestand übernehmen. Bei alten Doppelungen (Wettlauf vor dieser Version) gewinnt die Link-Seite – sie wird auch auf
  // der Subdomain ausgeliefert. INSERT IGNORE: ein abgebrochener Schritt läuft einfach noch einmal.
  await run(conn, `INSERT IGNORE INTO site_addresses (slug, kind, ref_id, user_id, claimed_at)
        SELECT slug, 'page', id, user_id, COALESCE(slug_changed_at, created_at, NOW()) FROM pages ORDER BY id`);
  await run(conn, `INSERT IGNORE INTO site_addresses (slug, kind, ref_id, user_id, claimed_at)
        SELECT slug, 'code', id, user_id, COALESCE(created_at, NOW()) FROM code_sites WHERE slug IS NOT NULL AND slug <> '' ORDER BY id`);
  // Statusseiten, falls ihr Schritt schon gelaufen ist (die Seite von OnYourSite hat kein Konto: user_id NULL)
  if (await hasTable(conn, 'status_pages')) {
    const cols = (await rows(conn, 'SHOW COLUMNS FROM status_pages')).map((c) => String(c.Field));
    const since = cols.includes('created_at') ? 'COALESCE(created_at, NOW())' : 'NOW()';
    await run(conn, `INSERT IGNORE INTO site_addresses (slug, kind, ref_id, user_id, claimed_at)
        SELECT slug, 'status', id, user_id, ${since} FROM status_pages WHERE slug IS NOT NULL AND slug <> '' ORDER BY id`);
  }
}

// V_CODE_SLOTS (braucht V_CODE_PAGES und V_SITE_ADDRESSES): eine Code-Seite kann statt der Link-Seite auf einem der
// Seitenplätze eines Kontos stehen (pages.code_site_id; die Link-Seite bleibt gespeichert) und hat dann keine eigene
// Adresse (code_sites.slug NULL). Der einzige Schritt, der etwas entfernt: uq_user (eine Code-Seite je Konto) weicht
// uq_own – höchstens EINE Code-Seite mit eigener Adresse je Konto, auch bei gleichzeitigen Anfragen. Dazu Zähler für
// Dateien und Größe, die Sperre der Code-Funktion je Konto und das Protokoll der Team-Aktionen. Jede Anweisung ist
// wiederholbar (ein abgebrochener Schritt läuft einfach noch einmal).
async function codeSlots(conn: PoolConnection): Promise<void> {
  // Mehrere Code-Seiten je Konto: erst den einfachen Index anlegen, dann den eindeutigen entfernen
  await addIndex(conn, 'code_sites', 'idx_user', 'KEY idx_user (user_id)');
  await dropIndex(conn, 'code_sites', 'uq_user');
  // Eine Code-Seite auf einer Seitenadresse hat keine eigene Adresse (nur ändern, solange die Spalte NOT NULL ist)
  if (await columnIsNotNull(conn, 'code_sites', 'slug')) await run(conn, 'ALTER TABLE code_sites MODIFY slug VARCHAR(63) NULL');
  // Höchstens eine Code-Seite mit eigener Adresse je Konto – die Datenbank prüft das auch bei gleichzeitigen Anfragen
  await addColumn(conn, 'code_sites', 'own_user_id', 'INT AS (IF(slug IS NULL, NULL, user_id)) PERSISTENT');
  await addIndex(conn, 'code_sites', 'uq_own', 'UNIQUE KEY uq_own (own_user_id)');
  // Anzahl und Größe der Dateien (Admin-Liste und Grenzen, ohne bei jedem Aufruf alle Dateien zu summieren)
  await addColumn(conn, 'code_sites', 'file_count', 'SMALLINT UNSIGNED NOT NULL DEFAULT 0');
  await addColumn(conn, 'code_sites', 'bytes', 'INT UNSIGNED NOT NULL DEFAULT 0');
  await run(conn, `UPDATE code_sites s SET
        s.file_count = (SELECT COUNT(*) FROM code_files f WHERE f.site_id = s.id),
        s.bytes = (SELECT COALESCE(SUM(LENGTH(f.content)), 0) FROM code_files f WHERE f.site_id = s.id)`);
  // Der Platz zeigt eine Code-Seite statt seiner Link-Seite (die Link-Seite bleibt gespeichert)
  await addColumn(conn, 'pages', 'code_site_id', 'INT NULL');
  await addIndex(conn, 'pages', 'uq_code_site', 'UNIQUE KEY uq_code_site (code_site_id)');
  // Moderation: Code-Funktion für ein Konto abschalten, Protokoll der Team-Aktionen (user_id NULL bei Grenzen)
  await addColumn(conn, 'users', 'code_banned_at', 'DATETIME NULL');
  await addColumn(conn, 'users', 'code_ban_reason', 'VARCHAR(200) NULL');
  await run(conn, `CREATE TABLE IF NOT EXISTS code_moderation (
        id INT AUTO_INCREMENT PRIMARY KEY,
        site_id INT NULL,
        user_id INT NULL,
        admin_id INT NOT NULL,
        action VARCHAR(12) NOT NULL,
        address VARCHAR(100) NOT NULL DEFAULT '',
        reason VARCHAR(200) NOT NULL DEFAULT '',
        created_at DATETIME NOT NULL,
        KEY idx_user (user_id, id),
        KEY idx_site (site_id, id)
    ) ${OPTS}`);
}

// V_STATUS_TABLES (braucht nur die Tabellen aus V_PAGES und V_CODE_PAGES): Statusseiten – OnYourSites eigene Seite
// und die der Nutzer mit Prüfungen, Vorfällen und Benachrichtigungen. Abonnenten und Rundmails kommen später mit einem
// eigenen Schritt (V_STATUS_SUBSCRIBERS). Zeiten für Vergleiche und Dauern sind Unix-Sekunden (UTC), weil DATETIME hier
// Ortszeit ist und in der Stunde der Zeitumstellung doppelt vorkommt; Tage sind DATE in der Zeitzone der Seite.
async function statusTables(conn: PoolConnection): Promise<void> {
  await run(conn, `CREATE TABLE IF NOT EXISTS status_pages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NULL,                                  -- NULL = Seite von OnYourSite (is_system = 1)
        is_system TINYINT(1) NOT NULL DEFAULT 0,
        slug VARCHAR(63) NOT NULL,
        title VARCHAR(120) NOT NULL DEFAULT '',
        description VARCHAR(300) NOT NULL DEFAULT '',
        theme VARCHAR(40) NOT NULL DEFAULT 'deep-dark',
        settings MEDIUMTEXT NULL,                          -- JSON (status/settings.ts: statusPageSettings)
        is_published TINYINT(1) NOT NULL DEFAULT 1,
        is_blocked TINYINT(1) NOT NULL DEFAULT 0,
        blocked_reason VARCHAR(200) NULL,
        review_note VARCHAR(80) NULL,                      -- Name nennt eine Marke: noindex bis zur Freigabe
        reviewed_at INT UNSIGNED NULL,                     -- Freigabe des Namens durch das Team
        rev INT UNSIGNED NOT NULL DEFAULT 0,               -- steigt bei jeder Änderung (Zwischenspeicher der Seite)
        changed_at INT UNSIGNED NOT NULL DEFAULT 0,        -- letzte Änderung (Unix-Zeit) für den Abgleich des Prüfdienstes
        limit_paused SMALLINT UNSIGNED NOT NULL DEFAULT 0, -- Prüfungen über der Grenze beim letzten Abgleich (Hinweis einmal je Wechsel)
        slug_changed_at INT UNSIGNED NULL,                 -- letzter Adresswechsel (Sperrfrist)
        owner_seen_at DATE NULL,                           -- letzter Besuch des Besitzers im Editor (Inaktivität)
        created_at DATETIME NULL,
        updated_at DATETIME NULL,
        UNIQUE KEY uq_slug (slug),
        UNIQUE KEY uq_user (user_id),
        KEY idx_changed (changed_at)
    ) ${OPTS}`);

  // Bestandteile einer Seite – mit automatischer Prüfung (http, heartbeat, system) oder von Hand (manual)
  await run(conn, `CREATE TABLE IF NOT EXISTS status_monitors (
        id INT AUTO_INCREMENT PRIMARY KEY,
        page_id INT NOT NULL,
        user_id INT NULL,                                  -- Besitzer (doppelt gespeichert für Grenzen und Admin)
        type VARCHAR(12) NOT NULL,                         -- http | heartbeat | manual | system
        name VARCHAR(80) NOT NULL,
        description VARCHAR(200) NOT NULL DEFAULT '',
        group_name VARCHAR(60) NOT NULL DEFAULT '',
        position SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        is_public TINYINT(1) NOT NULL DEFAULT 1,
        target VARCHAR(500) NOT NULL DEFAULT '',           -- http: bereinigte Adresse · system: Name der Prüfung
        target_host VARCHAR(253) NOT NULL DEFAULT '',      -- http: Host in ASCII, klein, ohne Punkt am Ende
        target_domain VARCHAR(253) NOT NULL DEFAULT '',    -- http: registrierbare Domain (Public Suffix List)
        config TEXT NULL,                                  -- JSON je Typ
        interval_s SMALLINT UNSIGNED NOT NULL DEFAULT 300,
        manual_status VARCHAR(12) NULL,                    -- manual: operational|degraded|partial|major|maintenance
        manual_since INT UNSIGNED NULL,
        hb_token_hash CHAR(64) NULL,                       -- sha256 des geheimen Heartbeat-Links
        hb_token_enc VARCHAR(255) NULL,                    -- derselbe Link verschlüsselt (zum erneuten Anzeigen)
        hb_last_ping_at INT UNSIGNED NULL,
        hb_last_fail_at INT UNSIGNED NULL,
        is_paused TINYINT(1) NOT NULL DEFAULT 0,
        admin_paused TINYINT(1) NOT NULL DEFAULT 0,
        admin_note VARCHAR(200) NULL,
        auto_paused VARCHAR(12) NULL,                      -- vom Prüfdienst angehalten: private_ip | refused | robots
        auto_paused_at INT UNSIGNED NULL,
        changed_at INT UNSIGNED NOT NULL DEFAULT 0,        -- letzte Änderung (Unix-Zeit) für den Abgleich des Prüfdienstes
        created_at DATETIME NULL,
        updated_at DATETIME NULL,
        KEY idx_page (page_id, position),
        KEY idx_user (user_id),
        KEY idx_host (target_host),
        KEY idx_domain (target_domain),
        KEY idx_changed (changed_at),
        UNIQUE KEY uq_hb (hb_token_hash)
    ) ${OPTS}`);

  // Laufender Zustand je Prüfung – schreibt nur der Prüfdienst
  await run(conn, `CREATE TABLE IF NOT EXISTS status_state (
        monitor_id INT NOT NULL PRIMARY KEY,
        state VARCHAR(10) NOT NULL DEFAULT 'unknown',      -- unknown|up|degraded|down
        since INT UNSIGNED NULL,
        flapping TINYINT(1) NOT NULL DEFAULT 0,
        fails TINYINT UNSIGNED NOT NULL DEFAULT 0,
        last_check_at INT UNSIGNED NULL,
        last_ok_at INT UNSIGNED NULL,
        last_ms INT UNSIGNED NULL,
        last_code SMALLINT UNSIGNED NULL,
        last_error VARCHAR(20) NULL,                       -- Fehlerschlüssel, nie Text der Gegenseite
        cert_expires_at INT UNSIGNED NULL,
        cert_warned TINYINT UNSIGNED NULL,                 -- zuletzt gemeldete Schwelle in Tagen (14 oder 3)
        throttled_at INT UNSIGNED NULL,                    -- zuletzt wegen Grenzen je Website verschoben
        refused_since INT UNSIGNED NULL,                   -- Beginn einer ununterbrochenen Folge von 403/429
        updated_at INT UNSIGNED NOT NULL DEFAULT 0
    ) ${OPTS}`);

  // Einzelne Prüfungen (zwei Tage). Tagespartitionen nach UTC: alte Tage fallen als Ganzes weg (status/partitions.ts).
  // Ohne Partitionierung (Erweiterung fehlt) löscht der Prüfdienst in Schritten nach dem Primärschlüssel.
  await run(conn, `CREATE TABLE IF NOT EXISTS status_checks (
        monitor_id INT NOT NULL,
        at INT UNSIGNED NOT NULL,
        ok TINYINT(1) NOT NULL,
        ms INT UNSIGNED NULL,
        code SMALLINT UNSIGNED NULL,
        error VARCHAR(20) NULL,
        PRIMARY KEY (monitor_id, at)
    ) ${OPTS} ${await partitionClause(conn)}`);

  // Zustandswechsel je Prüfung (90 Tage) – Verlauf im Editor
  await run(conn, `CREATE TABLE IF NOT EXISTS status_events (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        monitor_id INT NOT NULL,
        at INT UNSIGNED NOT NULL,
        kind VARCHAR(10) NOT NULL,                         -- down|up|degraded|recovered|flapping|stable|paused|resumed
        error VARCHAR(20) NULL,
        code SMALLINT UNSIGNED NULL,
        KEY idx_monitor (monitor_id, id),
        KEY idx_at (at)
    ) ${OPTS}`);

  // Zusammenfassung je Stunde (14 Tage) – Antwortzeiten-Diagramme
  await run(conn, `CREATE TABLE IF NOT EXISTS status_hourly (
        monitor_id INT NOT NULL,
        hour INT UNSIGNED NOT NULL,                        -- Beginn der Stunde (Unix-Zeit, UTC)
        checks SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        fails SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        ms_sum INT UNSIGNED NOT NULL DEFAULT 0,
        ms_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        ms_min INT UNSIGNED NULL,
        ms_max INT UNSIGNED NULL,
        covered_s SMALLINT UNSIGNED NOT NULL DEFAULT 0,    -- Sekunden mit Daten
        down_s SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        degraded_s SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        maint_s SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        PRIMARY KEY (monitor_id, hour)
    ) ${OPTS}`);

  // Zusammenfassung je Tag in der Zeitzone der Seite (120 Tage) – 90-Tage-Balken und Verfügbarkeit
  await run(conn, `CREATE TABLE IF NOT EXISTS status_daily (
        monitor_id INT NOT NULL,
        day DATE NOT NULL,
        checks MEDIUMINT UNSIGNED NOT NULL DEFAULT 0,
        fails MEDIUMINT UNSIGNED NOT NULL DEFAULT 0,
        ms_sum BIGINT UNSIGNED NOT NULL DEFAULT 0,
        ms_count MEDIUMINT UNSIGNED NOT NULL DEFAULT 0,
        ms_max INT UNSIGNED NULL,
        covered_s MEDIUMINT UNSIGNED NOT NULL DEFAULT 0,
        down_s MEDIUMINT UNSIGNED NOT NULL DEFAULT 0,
        degraded_s MEDIUMINT UNSIGNED NOT NULL DEFAULT 0,
        maint_s MEDIUMINT UNSIGNED NOT NULL DEFAULT 0,
        PRIMARY KEY (monitor_id, day)
    ) ${OPTS}`);

  // Vorfälle und geplante Wartungen mit ihrem Verlauf
  await run(conn, `CREATE TABLE IF NOT EXISTS status_incidents (
        id INT AUTO_INCREMENT PRIMARY KEY,
        page_id INT NOT NULL,
        kind VARCHAR(12) NOT NULL DEFAULT 'incident',      -- incident | maintenance
        title VARCHAR(160) NOT NULL,
        status VARCHAR(16) NOT NULL,                       -- investigating|identified|monitoring|resolved · scheduled|in_progress|completed
        impact VARCHAR(10) NOT NULL DEFAULT 'minor',       -- none|minor|major|critical (Wartung: maintenance)
        is_auto TINYINT(1) NOT NULL DEFAULT 0,             -- vom Prüfdienst eröffnet
        auto_edited TINYINT(1) NOT NULL DEFAULT 0,         -- Besitzer hat eingegriffen → nicht automatisch schließen
        starts_at INT UNSIGNED NOT NULL,
        ends_at INT UNSIGNED NULL,                         -- Wartung: geplantes Ende
        resolved_at INT UNSIGNED NULL,
        notify TINYINT(1) NOT NULL DEFAULT 1,
        sub_mails TINYINT UNSIGNED NOT NULL DEFAULT 0,     -- schon verschickte Mails an Abonnenten (höchstens 10)
        created_by INT NULL,
        created_at DATETIME NULL,
        updated_at DATETIME NULL,
        KEY idx_page (page_id, resolved_at, starts_at),
        KEY idx_open (kind, status, starts_at)
    ) ${OPTS}`);
  await run(conn, `CREATE TABLE IF NOT EXISTS status_incident_monitors (
        incident_id INT NOT NULL,
        monitor_id INT NOT NULL,
        effect VARCHAR(12) NOT NULL DEFAULT 'partial',     -- degraded|partial|major|maintenance
        PRIMARY KEY (incident_id, monitor_id),
        KEY idx_monitor (monitor_id)
    ) ${OPTS}`);
  await run(conn, `CREATE TABLE IF NOT EXISTS status_incident_updates (
        id INT AUTO_INCREMENT PRIMARY KEY,
        incident_id INT NOT NULL,
        status VARCHAR(16) NOT NULL,
        body TEXT NOT NULL,                                -- einfaches Markdown (wie Updates)
        is_auto TINYINT(1) NOT NULL DEFAULT 0,
        created_by INT NULL,
        created_at INT UNSIGNED NOT NULL,
        edited_at INT UNSIGNED NULL,
        KEY idx_incident (incident_id, id)
    ) ${OPTS}`);
  // Discord-Nachrichten eines Vorfalls – eine Zeile je Ziel (Bot-Kanal #status oder Webhook-Kanal), wird bei jedem
  // Update bearbeitet
  await run(conn, `CREATE TABLE IF NOT EXISTS status_incident_posts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        incident_id INT NOT NULL,
        target VARCHAR(40) NOT NULL,                       -- 'bot:<channel_id>' | 'channel:<status_channels.id>'
        channel_id VARCHAR(22) NULL,
        message_id VARCHAR(22) NULL,                       -- NULL, solange der erste Beitrag aussteht
        state VARCHAR(12) NOT NULL DEFAULT 'queued',       -- queued | posted | failed
        dirty TINYINT(1) NOT NULL DEFAULT 0,               -- geändert, während der erste Beitrag noch aussteht
        error VARCHAR(160) NULL,
        updated_at INT UNSIGNED NOT NULL,
        UNIQUE KEY uq_target (incident_id, target)
    ) ${OPTS}`);

  // Wohin Benachrichtigungen gehen (zusätzlich zur E-Mail des Kontos): E-Mail, Discord-Webhook, eigener Bot (nur OnYourSite)
  await run(conn, `CREATE TABLE IF NOT EXISTS status_channels (
        id INT AUTO_INCREMENT PRIMARY KEY,
        page_id INT NOT NULL,
        type VARCHAR(10) NOT NULL,                         -- email | discord | bot
        target_enc TEXT NOT NULL,                          -- verschlüsselt: Adresse, Webhook-Link oder Bot-Kanal
        target_hash CHAR(64) NOT NULL,                     -- hmac(Typ|Ziel): jedes Ziel nur einmal je Seite
        label VARCHAR(120) NOT NULL DEFAULT '',            -- gekürzt zum Anzeigen
        events VARCHAR(120) NOT NULL DEFAULT 'down,up,degraded,cert,heartbeat', -- Discord: zusätzlich 'incident'
        verify_hash CHAR(64) NULL,                         -- sha256 des Bestätigungslinks, erst beim Versand erzeugt
        verify_sent_at INT UNSIGNED NULL,
        verified_at INT UNSIGNED NULL,
        is_enabled TINYINT(1) NOT NULL DEFAULT 1,
        fail_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
        last_error VARCHAR(160) NULL,
        last_sent_at INT UNSIGNED NULL,
        created_at DATETIME NULL,
        UNIQUE KEY uq_target (page_id, target_hash),
        KEY idx_page (page_id)
    ) ${OPTS}`);

  // Ausgehende Nachrichten (Alarme, Bestätigungsmails, Bot) – mit Wiederholung und Verlauf (30 Tage).
  // Die Nutzdaten enthalten nie Geheimnisse: Bestätigungslinks erzeugt erst der Versand.
  await run(conn, `CREATE TABLE IF NOT EXISTS status_outbox (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        page_id INT NOT NULL,
        monitor_id INT NULL,
        kind VARCHAR(20) NOT NULL,                         -- alert|channel_verify|inactive_warning|channel_broken|muted
        class VARCHAR(8) NOT NULL DEFAULT 'owner',         -- Mail-Budget: system | confirm | owner
        channel VARCHAR(20) NOT NULL,                      -- owner|admins|bell|bot|channel:<id>
        event VARCHAR(16) NOT NULL DEFAULT '',             -- down|up|degraded|recovered|flapping|stable|cert|heartbeat|incident|test
        payload TEXT NOT NULL,                             -- JSON mit allem, was die Nachricht braucht (ohne Geheimnisse)
        state VARCHAR(10) NOT NULL DEFAULT 'pending',      -- pending|sent|failed|merged|skipped
        attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
        next_at INT UNSIGNED NOT NULL,
        error VARCHAR(160) NULL,
        created_at INT UNSIGNED NOT NULL,
        sent_at INT UNSIGNED NULL,
        KEY idx_due (state, next_at),
        KEY idx_page (page_id, id)
    ) ${OPTS}`);

  // Regeln je Website (Admin): sperren oder mehr Prüfungen erlauben
  await run(conn, `CREATE TABLE IF NOT EXISTS status_host_rules (
        host VARCHAR(253) NOT NULL PRIMARY KEY,            -- genauer Host oder „.example.com“ für die Domain und alle Subdomains
        rule VARCHAR(8) NOT NULL,                          -- block | allow
        max_monitors SMALLINT UNSIGNED NULL,
        note VARCHAR(200) NOT NULL DEFAULT '',
        created_by INT NULL,
        created_at DATETIME NULL
    ) ${OPTS}`);

  // robots.txt je Host (höchstens einmal am Tag geholt) – nur Gruppen für „OnYourSite-Monitor“ zählen
  await run(conn, `CREATE TABLE IF NOT EXISTS status_host_meta (
        host VARCHAR(253) NOT NULL PRIMARY KEY,
        robots_at INT UNSIGNED NULL,
        robots_rules TEXT NULL,                            -- JSON: [["allow"|"disallow", "/pfad"], …] der eigenen Gruppe
        robots_error VARCHAR(20) NULL
    ) ${OPTS}`);

  // „Jetzt prüfen“: kleine Warteschlange statt eines vollständigen Neuladens im Prüfdienst
  await run(conn, `CREATE TABLE IF NOT EXISTS status_run_requests (
        monitor_id INT NOT NULL PRIMARY KEY,
        requested_at INT UNSIGNED NOT NULL
    ) ${OPTS}`);

  // Daten gelöschter Prüfungen und Seiten räumt der Prüfdienst in Teilen weg (statt im Web-Request)
  await run(conn, `CREATE TABLE IF NOT EXISTS status_purge (
        id INT AUTO_INCREMENT PRIMARY KEY,
        kind VARCHAR(8) NOT NULL,                          -- monitor | page
        ref_id INT NOT NULL,
        created_at INT UNSIGNED NOT NULL
    ) ${OPTS}`);

  // Alte Adresse nach einem Adresswechsel: 90 Tage Weiterleitung (die Adresse selbst hält site_addresses fest)
  await run(conn, `CREATE TABLE IF NOT EXISTS status_slug_redirects (
        slug VARCHAR(63) NOT NULL PRIMARY KEY,
        page_id INT NOT NULL,
        until INT UNSIGNED NOT NULL,
        KEY idx_page (page_id)
    ) ${OPTS}`);

  await addColumn(conn, 'users', 'status_terms_at', 'DATETIME NULL');
  await seedSystemStatusPage(conn);
}

// Tagespartitionen für status_checks, wenn MariaDB sie kann (Debian/Ubuntu: eingebaut) – sonst ''
async function partitionClause(conn: PoolConnection): Promise<string> {
  const r = await rows(conn, "SELECT PLUGIN_STATUS FROM information_schema.PLUGINS WHERE PLUGIN_NAME = 'partition'");
  return r.length && r[0].PLUGIN_STATUS === 'ACTIVE' ? partitionClauseFor(Math.floor(Date.now() / 1000)) : '';
}

// Bestandteile von OnYourSites eigener Seite (Stand dieses Schritts): Schlüssel der Prüfung, Name, Gruppe, öffentlich,
// Abstand, Einstellungen. Was ein Teil prüft und wann er zu sehen ist (z. B. erst mit Bot oder Mail-Server), entscheidet
// der Prüfdienst (status/system.ts).
const SYSTEM_COMPONENTS: Array<[string, string, string, number, number, Record<string, number>]> = [
  ['web', 'Website', '', 1, 60, {}],
  ['pages', 'Profile & code pages', '', 1, 60, {}],
  ['domains', 'Custom domains', '', 1, 120, {}],
  ['bot', 'Discord bot', '', 1, 60, {}],
  ['mail', 'Email', '', 1, 600, {}],
  ['db', 'Database', 'Infrastructure', 1, 60, {}],
  ['tunnel', 'Cloudflare tunnel', 'Infrastructure', 1, 60, {}],
  ['origin', 'Web server (internal)', 'Internal', 0, 60, {}],
  ['disk', 'Disk space (internal)', 'Internal', 0, 60, {}],
  ['job:backup', 'Nightly backup', 'Internal', 0, 60, { period: 86400, grace: 7200 }],
  ['job:weekly', 'Weekly report', 'Internal', 0, 60, { period: 604800, grace: 21600 }],
  ['job:runner', 'Background jobs', 'Internal', 0, 60, {}],
  ['job:domains', 'Custom domain worker', 'Internal', 0, 60, {}],
];

// OnYourSites eigene Statusseite (status.<domain>) – einmalig. Die Adresse ist seit jeher als Subdomain verboten; liegt
// trotzdem eine Seite darauf (Import), bleibt die Statusseite offline, bis das Team entscheidet. In das gemeinsame
// Adressregister (site_addresses) kommt sie nur, wenn es die Tabelle schon gibt – sonst trägt sie dessen eigener
// Schritt aus status_pages nach.
// Seite und Bestandteile in EINER Transaktion: der Schritt überspringt die Seite, sobald es sie gibt – bräche er
// dazwischen ab, fehlten die übrigen Bestandteile sonst für immer.
async function seedSystemStatusPage(conn: PoolConnection): Promise<void> {
  await conn.beginTransaction();
  try {
    await seedSystemStatusRows(conn);
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => undefined);
    throw err;
  }
}

async function seedSystemStatusRows(conn: PoolConnection): Promise<void> {
  if ((await rows(conn, 'SELECT id FROM status_pages WHERE is_system = 1 LIMIT 1')).length) return;
  const clash = await rows(conn, "SELECT 'page' AS kind, id FROM pages WHERE slug IN ('status', 'health') UNION SELECT 'code', id FROM code_sites WHERE slug IN ('status', 'health')");
  if (clash.length) {
    console.error(`Status page: the address "status" or "health" is used by ${clash.map((c) => `${String(c.kind)} #${String(c.id)}`).join(', ')} – OnYourSite's status page stays offline until an admin decides.`);
  }
  const now = Math.floor(Date.now() / 1000);
  const stamp = date('Y-m-d H:i:s');
  const settings = '{"accent":"#6366f1","show_uptime":true,"history_days":14,"subscribe":true,"auto_incident":300,'
    + '"alerts":{"owner":false,"admins":true,"events":["down","up","degraded","cert","heartbeat"]}}';
  const page = await run(conn, `INSERT INTO status_pages (user_id, is_system, slug, title, description, theme, settings, is_published, changed_at, created_at, updated_at)
    VALUES (NULL, 1, 'status', 'OnYourSite status', 'Live status of on-your.site, profile pages, code pages and our Discord bot.', 'deep-dark', ?, ?, ?, ?, ?)`,
  [settings, clash.length ? 0 : 1, now, stamp, stamp]);
  let position = 0;
  for (const [key, name, group, isPublic, interval, config] of SYSTEM_COMPONENTS) {
    await run(conn, `INSERT INTO status_monitors (page_id, user_id, type, name, group_name, position, is_public, target, config, interval_s, changed_at, created_at, updated_at)
      VALUES (?, NULL, 'system', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [page.insertId, name, group, position++, isPublic, key, JSON.stringify(config), interval, now, stamp, stamp]);
  }
  if (await hasTable(conn, 'site_addresses')) {
    // claimAddress(db, 'status', 'status', id, null) des Adressregisters: ohne Besitzer, ein vorhandener Eintrag bleibt
    await run(conn, "INSERT IGNORE INTO site_addresses (slug, kind, ref_id, user_id, claimed_at) VALUES ('status', 'status', ?, NULL, ?)", [page.insertId, stamp]);
  }
  await run(conn, "REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('status_rev', '1')");
}

// V_SHOP_CORE (braucht die Tabellen aus V_PAGES und V_CODE_PAGES): Kern des Honigwaben-Shops. Das Buch bleibt die
// einzige Quelle für Kontostände; dazu kommen je Konto eine Sperrzeile, die Berechtigungen (was ein Konto besitzt),
// users.premium_until und das Protokoll der Admin-Aktionen. Bisherige Freischaltungen werden zu Berechtigungen.
async function shopCore(conn: PoolConnection): Promise<void> {
  // Wer eine Buchung ausgelöst hat (Admin-ID); NULL = Nutzer oder System
  await addColumn(conn, 'honeycomb_ledger', 'actor_id', 'INT NULL');
  await addIndex(conn, 'honeycomb_ledger', 'idx_reason_time', 'KEY idx_reason_time (reason, created_at)');
  await addIndex(conn, 'honeycomb_ledger', 'idx_time', 'KEY idx_time (created_at)');
  // Premium-Status für SQL-Verknüpfungen anderer Bereiche: NULL = keins, Datum = bis dahin,
  // '9999-12-31 23:59:59' = dauerhaft (nie NULL für „dauerhaft“)
  await addColumn(conn, 'users', 'premium_until', 'DATETIME NULL');
  await addIndex(conn, 'users', 'idx_premium_until', 'KEY idx_premium_until (premium_until)');

  // Eine Zeile je Konto: Sperrzeile für Buchungen, Sperre durch das Team, ausstehender Abgleich
  await run(conn, `CREATE TABLE IF NOT EXISTS hc_accounts (
        user_id INT NOT NULL PRIMARY KEY,
        frozen_at DATETIME NULL,
        frozen_reason VARCHAR(200) NULL,
        reconcile_at DATETIME NULL,
        reconcile_gen INT UNSIGNED NOT NULL DEFAULT 0,
        reconcile_tries SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        reconcile_error VARCHAR(200) NOT NULL DEFAULT '',
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        KEY idx_reconcile (reconcile_at)
    ) ${OPTS}`);
  // Was ein Konto besitzt: je Funktion eine Zeile, bei stapelbaren Zeitpaketen eine je Paket (lot)
  await run(conn, `CREATE TABLE IF NOT EXISTS hc_entitlements (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        feature VARCHAR(40) NOT NULL,
        lot TINYINT UNSIGNED NOT NULL DEFAULT 0,
        quantity INT UNSIGNED NOT NULL DEFAULT 1,
        permanent TINYINT(1) NOT NULL DEFAULT 0,
        expires_at DATETIME NULL,
        source VARCHAR(10) NOT NULL DEFAULT 'purchase',
        reminded TINYINT UNSIGNED NOT NULL DEFAULT 0,
        expiry_done_at DATETIME NULL,
        note VARCHAR(200) NOT NULL DEFAULT '',
        granted_by INT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        UNIQUE KEY uq_feature (user_id, feature, lot),
        KEY idx_expiry (expires_at)
    ) ${OPTS}`);
  // Jede Admin-Aktion rund um Honigwaben – details nur mit IDs, Beträgen und Schlüsseln, nie Namen oder Notizen
  await run(conn, `CREATE TABLE IF NOT EXISTS hc_audit (
        id INT AUTO_INCREMENT PRIMARY KEY,
        admin_id INT NOT NULL,
        action VARCHAR(30) NOT NULL,
        user_id INT NULL,
        target VARCHAR(80) NOT NULL DEFAULT '',
        details TEXT NULL,
        created_at DATETIME NOT NULL,
        KEY idx_time (created_at),
        KEY idx_user (user_id, id)
    ) ${OPTS}`);

  const now = date('Y-m-d H:i:s');
  await run(conn, 'INSERT IGNORE INTO hc_accounts (user_id, created_at, updated_at) SELECT id, ?, ? FROM users', [now, now]);
  // Alle bisherigen Freischaltungen (unlock/<Funktion>) werden dauerhafte Berechtigungen – Schlüssel genau in
  // Kleinbuchstaben (BINARY: REGEXP folgt sonst der Sortierung und ignoriert Groß/klein)
  await run(conn, `INSERT IGNORE INTO hc_entitlements (user_id, feature, lot, quantity, permanent, expires_at, source, note, created_at, updated_at)
        SELECT l.user_id, l.ref, 0, 1, 1, NULL, IF(l.amount = 0, 'admin', 'legacy'), '', l.created_at, l.created_at
        FROM honeycomb_ledger l WHERE l.reason = 'unlock' AND CAST(l.ref AS BINARY) REGEXP '^[a-z][a-z0-9_]{1,39}$'`);
  // Sicherheitsnetz: wer schon eine Code-Seite hat, behält sie
  await run(conn, `INSERT IGNORE INTO hc_entitlements (user_id, feature, lot, quantity, permanent, expires_at, source, note, created_at, updated_at)
        SELECT s.user_id, 'code_page', 0, 1, 1, NULL, 'legacy', '', COALESCE(s.created_at, ?), ? FROM code_sites s`, [now, now]);
  // Admin-Gutschriften: den Admin aus dem Bezug a<id>-<16 hex> übernehmen
  await run(conn, `UPDATE honeycomb_ledger SET actor_id = CAST(SUBSTRING_INDEX(SUBSTRING(ref, 2), '-', 1) AS UNSIGNED)
        WHERE reason = 'admin' AND actor_id IS NULL AND ref REGEXP '^a[0-9]{1,9}-[0-9a-f]{16}$'`);
}

// V_SHOP_CATALOGUE (braucht V_SHOP_CORE): Optionen mit Preisen (das Verhalten steht im Code der Bereiche), Rabatt-
// aktionen und jeder Kauf. Die Standard-Optionen legt der Shop beim ersten Lesen des Katalogs an (seedItems), denn
// welche es gibt, melden die Bereiche erst beim Start an.
async function shopCatalogue(conn: PoolConnection): Promise<void> {
  await run(conn, `CREATE TABLE IF NOT EXISTS hc_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        item_key VARCHAR(40) NOT NULL,
        feature VARCHAR(40) NOT NULL,
        days SMALLINT UNSIGNED NULL,
        units SMALLINT UNSIGNED NOT NULL DEFAULT 1,
        price INT UNSIGNED NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 0,
        position INT NOT NULL DEFAULT 0,
        available_from DATETIME NULL,
        available_until DATETIME NULL,
        min_account_days SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        min_active_days SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        UNIQUE KEY uq_item (item_key),
        KEY idx_feature (feature, position)
    ) ${OPTS}`);
  // Rabattaktionen mit Start und Ende; uses sinkt bei Erstattungen nicht
  await run(conn, `CREATE TABLE IF NOT EXISTS hc_offers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        label VARCHAR(60) NOT NULL,
        scope VARCHAR(60) NOT NULL,
        percent_off TINYINT UNSIGNED NULL,
        fixed_price INT UNSIGNED NULL,
        starts_at DATETIME NOT NULL,
        ends_at DATETIME NOT NULL,
        max_uses INT UNSIGNED NULL,
        uses INT UNSIGNED NOT NULL DEFAULT 0,
        per_user_max SMALLINT UNSIGNED NULL,
        min_account_days SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        min_active_days SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        cancelled_at DATETIME NULL,
        form_ref CHAR(16) NULL,
        created_by INT NOT NULL,
        created_at DATETIME NOT NULL,
        UNIQUE KEY uq_form (created_by, form_ref),
        KEY idx_window (ends_at, starts_at)
    ) ${OPTS}`);
  // Jeder Kauf, unveränderlich bis auf die Erstattung (und das Verschieben späterer Zeiträume bei einer Erstattung)
  await run(conn, `CREATE TABLE IF NOT EXISTS hc_purchases (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        request_id VARCHAR(40) NOT NULL,
        item_key VARCHAR(40) NOT NULL,
        feature VARCHAR(40) NOT NULL,
        lot TINYINT UNSIGNED NOT NULL DEFAULT 0,
        units SMALLINT UNSIGNED NOT NULL DEFAULT 1,
        days SMALLINT UNSIGNED NULL,
        list_price INT UNSIGNED NOT NULL,
        price INT UNSIGNED NOT NULL,
        offer_id INT NULL,
        ledger_id INT NOT NULL,
        via VARCHAR(10) NOT NULL DEFAULT 'shop',
        period_start DATETIME NULL,
        period_end DATETIME NULL,
        refunded_at DATETIME NULL,
        refund_amount INT UNSIGNED NULL,
        refund_units SMALLINT UNSIGNED NULL,
        refund_cut_sec INT UNSIGNED NULL,
        refund_removed TINYINT(1) NULL,
        refunded_by INT NULL,
        created_at DATETIME NOT NULL,
        UNIQUE KEY uq_request (user_id, request_id),
        KEY idx_user (user_id, id),
        KEY idx_lot (user_id, feature, lot, period_start),
        KEY idx_item_time (item_key, created_at),
        KEY idx_offer (offer_id, user_id),
        KEY idx_time (created_at)
    ) ${OPTS}`);
}

// V_BRANDING_LEGACY (braucht V_PAGES und V_SHOP_CORE: users.premium_until): Bestandsschutz (Q9). Wer „Made with
// OnYourSite“ heute ohne Premium ausblendet – mit dem alten Schalter oder mit eigenem CSS, das ihn ausblendet –, behält
// das: hide_branding und branding_legacy, bis der Besitzer den Schalter ausschaltet. Seiten von Admins und von
// Besitzern mit Premium bleiben, wie sie sind (endet deren Premium, kommt der Hinweis zurück). Nur Daten, kein DDL.
// Gelesen mit dem JSON-Decoder von PHP, geschrieben wie beim Speichern; jede Seite einzeln per Compare-and-set (eine
// Seite, die gerade jemand speichert, wird neu gelesen).
async function brandingLegacy(conn: PoolConnection): Promise<void> {
  const now = date('Y-m-d H:i:s');
  const base = strtolower(configString('base_domain', '')).split(':')[0];
  let after = 0;
  for (;;) {
    const batch = await rows(conn, `SELECT p.id FROM pages p JOIN users u ON u.id = p.user_id
        WHERE p.id > ? AND u.is_admin = 0 AND (u.premium_until IS NULL OR u.premium_until <= ?) ORDER BY p.id LIMIT 500`, [after, now]);
    if (!batch.length) break;
    for (const { id } of batch) {
      after = intval(id);
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = await rows(conn, 'SELECT settings FROM pages WHERE id = ?', [after]);
        if (!r.length) break;
        const raw = phpStr(r[0].settings ?? '');
        const settings = jsonDecode(raw);
        // Nur Objekte haben Schlüssel (eine leere Liste [] hat nichts auszublenden)
        if (!isArr(settings) || Array.isArray(settings) || phpTruthy(own(settings, 'branding_legacy'))) break;
        const stored = phpTruthy(own(settings, 'hide_branding'));
        if (!stored && !cssHides(cleanCss(phpStr(own(settings, 'custom_css') ?? '')), base)) break;
        const s = settings as Record<string, unknown>;
        if (!stored) s.hide_branding = true;
        s.branding_legacy = true;
        const res = await run(conn, 'UPDATE pages SET settings = ? WHERE id = ? AND BINARY settings = ?', [phpJson(s, { unescapedUnicode: true }), after, raw]);
        if (res.affectedRows > 0) break;
      }
    }
  }
}

type Seed = [string | null, string, string, string, string];
const UPDATE_SEEDS: Seed[] = [
  ['2026-10-27 18:00:00', '2.0', 'new', 'OnYourSite 2.0 – rebuilt from the ground up',
    'Your page got a complete makeover:\n\n'
    + '- **Live preview** – see every change on a phone right next to the editor\n'
    + '- **25 themes and 13 layouts**, from Glass and Brutal to Galaxy and Comic\n'
    + '- **Stats without cookies** – views and clicks per link, no cookie banner needed\n'
    + '- **Two addresses** – name.on-your.site or on-your.site/name\n'
    + '- **Scheduling** – links that appear and disappear automatically\n'
    + '- **Protected links** with a password or an 18+ confirmation\n'
    + '- **Up to 3 pages** per account, each with its own address and stats\n'
    + '- Entrance with music, countdown, gallery, contact form and a weekly report by email'],
  ['2026-10-27 22:00:00', '2.0.1', 'improved', 'Security improvements',
    '- Protected links never reveal their target – not even in the public API\n'
    + '- Custom CSS can’t load anything from other servers\n'
    + '- Password, login and spam limits per visitor – without storing IP addresses\n'
    + '- Storage limit per account and automatic clean-up of unused uploads'],
  ['2026-10-28 09:45:00', '2.1', 'new', 'English interface, 6 new themes and a better mobile editor',
    '- The whole site is now in English\n'
    + '- New themes: **Noir**, **Holo**, **Dune** and the templates **Blueprint**, **Chalkboard** and **Sakura** – 30 themes in total\n'
    + '- On phones, the editor now has a bottom navigation bar and larger inputs\n'
    + '- Booking and contact forms work better on small screens'],
  [null, '2.2', 'new', 'Updates page, roadmap and Discord announcements',
    '- Follow along on the new **Updates** page – every change in one place\n'
    + '- The **roadmap** shows what we’re working on now, what’s up next and what’s planned\n'
    + '- New updates are announced on our Discord'],
];

// pathinfo($p, PATHINFO_EXTENSION): Teil nach dem letzten Punkt des Dateinamens
function pathExtension(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1);
}

const LAYOUT_MAP: Record<string, string> = {
  'link-tree': 'buttons',
  'about-me': 'cards',
  'bento-grid': 'bento',
  'minimal-cv': 'magazine',
};

// Übernimmt alte Profile (users + user_links) als erste Seite mit Blöcken
async function migrateLegacyUsers(conn: PoolConnection): Promise<void> {
  const now = date('Y-m-d H:i:s');
  // Feste Reihenfolge (nach id): sonst hinge die Nummer jeder Seite und jedes Blocks vom Plan der Datenbank ab
  const users = await rows(conn, "SELECT * FROM users WHERE username IS NOT NULL AND username <> '' ORDER BY id");

  for (const user of users) {
    // Alte Installationen haben evtl. nicht alle Spalten – daher defensiv lesen
    const col = (name: string, fallback: unknown = null): unknown => (name in user ? user[name] : fallback);
    if ((await rows(conn, 'SELECT id FROM pages WHERE user_id = ? LIMIT 1', [user.id])).length) continue;
    const slug = strtolower(phpStr(user.username));
    if ((await rows(conn, 'SELECT id FROM pages WHERE slug = ? LIMIT 1', [slug])).length) continue;

    await conn.beginTransaction();
    try {
      const settings = {
        seo: {
          title: phpStr(col('seo_title', '')),
          description: phpStr(col('seo_description', '')),
          keywords: phpStr(col('seo_keywords', '')),
        },
        custom_css: cleanCss(phpStr(col('custom_css', ''))),
        hide_branding: phpTruthy(col('hide_branding', 0)),
      };
      const theme = phpTruthy(col('theme')) ? phpStr(col('theme')) : 'deep-dark';
      const layout = LAYOUT_MAP[phpStr(col('layout_type', ''))] ?? 'buttons';
      const created = phpTruthy(col('created_at')) ? col('created_at') : now;
      const orNull = (v: unknown) => (phpTruthy(v) ? v : null);

      const page = await run(conn, `INSERT INTO pages (user_id, slug, position, title, subtitle, bio, avatar, bg_image, theme, layout, address_mode, settings, views, slug_changed_at, created_at, updated_at)
        VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 'subdomain', ?, ?, ?, ?, ?)`, [
        user.id,
        slug,
        mbSubstr(phpStr(col('full_name', '')), 0, 120),
        mbSubstr(phpStr(col('profession', '')), 0, 160),
        phpStr(col('bio', '')),
        orNull(col('profile_image')),
        orNull(col('bg_image')),
        theme,
        layout,
        phpJson(settings, { unescapedUnicode: true }),
        Math.max(0, intval(col('profile_views', 0))),
        orNull(col('last_subdomain_change')),
        created,
        now,
      ]);
      const pageId = page.insertId;
      let pos = 0;
      const add = (type: string, data: Record<string, unknown>, clicks = 0, legacyId: number | null = null) =>
        run(conn, `INSERT INTO page_blocks (page_id, type, position, is_visible, data, clicks, legacy_link_id, created_at)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?)`, [pageId, type, pos++, phpJson(data, { unescapedUnicode: true }), clicks, legacyId, now]);

      // Termin-Button und Datei standen früher über den Links
      const booking = phpStr(decryptData(phpStr(col('booking_url', ''))));
      if (booking !== '' && !booking.startsWith('ENC:')) await add('booking', { title: 'Book a meeting', url: booking });
      const cv = phpStr(col('cv_file', ''));
      if (cv !== '') {
        const ext = strtolower(pathExtension(cv));
        const title = ext === 'pdf' ? 'Download CV' : ext === 'vcf' ? 'Save contact' : 'Download file';
        await add('file', { title, src: cv });
      }

      const about = phpTrim(phpStr(col('detailed_bio', '')));
      const aboutAfterLinks = col('layout_type') === 'bento-grid';
      if (about !== '' && !aboutAfterLinks) {
        await add('heading', { text: 'About me', size: 'm', align: 'center' });
        await add('text', { text: about, align: 'center' });
      }

      for (const link of await rows(conn, 'SELECT * FROM user_links WHERE user_id = ? ORDER BY sort_order ASC, id ASC', [user.id])) {
        if (phpTrim(phpStr(link.title)) === '' && phpTrim(phpStr(link.url)) === '') continue;
        await add('link', {
          title: mbSubstr(phpStr(link.title), 0, 120),
          url: phpStr(link.url),
          icon: phpStr(link.icon_class ?? ''),
        }, Math.max(0, intval(link.clicks)), intval(link.id));
      }

      if (about !== '' && aboutAfterLinks) {
        await add('heading', { text: 'Story', size: 'm', align: 'center' });
        await add('text', { text: about, align: 'center' });
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => undefined);
      console.error(`Migration for user #${phpStr(user.id)} failed: ${(err as Error).message}`);
    }
  }
}

// V_DISCORD_DELIVERY (braucht V_UPDATES und V_COMMUNITY): je Update und Ziel eine Zeile für seinen Beitrag in Discord
// (bot, webhook oder token = alter Bot-Token), Aufträge an den Bot mit ref (Reihenfolge), Pause nach Fehlern und
// Abholzeit, die Discord-Einstellungen in Form v2 (ohne Kopie der alten Form) und die schon geposteten Updates als
// Zeilen. updates.discord_message_id/discord_target bleiben stehen und werden nur hier gelesen.
async function discordDelivery(conn: PoolConnection): Promise<void> {
  await run(conn, `CREATE TABLE IF NOT EXISTS update_discord_posts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        update_id INT NOT NULL,
        via VARCHAR(10) NOT NULL,
        target VARCHAR(80) NOT NULL,
        kind VARCHAR(12) NOT NULL DEFAULT 'message',
        channel_id VARCHAR(22) NULL,
        message_id VARCHAR(22) NULL,
        state VARCHAR(16) NOT NULL DEFAULT 'queued',
        dirty TINYINT(1) NOT NULL DEFAULT 0,
        legacy TINYINT(1) NOT NULL DEFAULT 0,
        error VARCHAR(300) NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        UNIQUE KEY uq_update_via (update_id, via),
        KEY idx_state (state, updated_at)
    ) ${OPTS}`);
  await addColumn(conn, 'community_outbox', 'ref', 'VARCHAR(40) NULL');
  await addColumn(conn, 'community_outbox', 'next_try_at', 'DATETIME NULL');
  await addColumn(conn, 'community_outbox', 'claimed_at', 'DATETIME NULL');
  await addIndex(conn, 'community_outbox', 'idx_ref', 'KEY idx_ref (ref, done_at)');

  // Einstellungen v1 → v2. Ein falscher Schlüssel oder kaputter Wert: nichts speichern (es gelten die Vorgaben).
  const meta = await rows(conn, "SELECT meta_value FROM oys_meta WHERE meta_key = 'discord'");
  let tokenStored = false;
  if (meta.length) {
    const data = decodeStored(phpStr(meta[0].meta_value));
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
      if ((data as Record<string, unknown>).v === 2) {
        tokenStored = phpStr((data as Record<string, unknown>).bot_token ?? '') !== '';
      } else {
        const v2 = discordSettingsFromV1(normalizeV1(data));
        tokenStored = v2.bot_token !== '';
        await run(conn, "REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('discord', ?)", [encodeSettings(v2)]);
      }
    }
  }
  await convertLegacyPosts(conn, { tokenStored, botInstalled: botSecret() !== '' });
}

// Schon gepostete Updates (Spalten in updates) als Zeilen – wiederholbar (INSERT IGNORE)
export async function convertLegacyPosts(conn: PoolConnection, opts: { tokenStored: boolean; botInstalled: boolean }): Promise<number> {
  const now = date('Y-m-d H:i:s');
  let added = 0;
  const posted = await rows(conn, "SELECT id, discord_message_id, discord_target FROM updates WHERE discord_message_id IS NOT NULL AND discord_message_id <> '' AND discord_target IS NOT NULL ORDER BY id");
  for (const u of posted) {
    const messageId = phpStr(u.discord_message_id);
    const p = legacyPostRow(phpStr(u.discord_target), messageId, opts);
    if (!p) continue;
    const res = await run(conn, `INSERT IGNORE INTO update_discord_posts (update_id, via, target, kind, channel_id, message_id, state, legacy, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?)`, [u.id, p.via, p.target, p.kind, p.channel_id, messageId.slice(0, 22), p.legacy, now, now]);
    added += res.affectedRows;
  }
  return added;
}

// V_PUBLIC_PAGES (braucht V_COMMUNITY und V_NOTIFICATIONS_INDEX): für die öffentliche Vorschlagsseite je Vorschlag, ob
// das Team ihn zeigt oder verbirgt (web_state), ob der Bot dem Autor im Beitrag gesagt hat, dass er auf der Webseite
// erscheinen kann (web_notice – bei allen bisherigen 0, so erscheint keiner von selbst), und ob der Beitrag in Discord
// gelöscht ist (removed_at). Dazu wird „suggestions“ eine Adresse der Hauptseite (reserveSuggestions).
async function publicPages(conn: PoolConnection): Promise<void> {
  await addColumn(conn, 'community_suggestions', 'web_state', "VARCHAR(8) NOT NULL DEFAULT 'auto'");
  await addColumn(conn, 'community_suggestions', 'web_notice', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addColumn(conn, 'community_suggestions', 'removed_at', 'DATETIME NULL');
  await addIndex(conn, 'community_suggestions', 'idx_web', 'KEY idx_web (removed_at, web_state, status, id)');
  await reserveSuggestions(conn);
}

// {base}/suggestions gehört jetzt der Vorschlagsseite: Link-Seiten mit diesem Namen im Pfad-Modus ziehen auf ihre
// Subdomain um; ihre Besitzer und die einer Code-Seite mit diesem Namen (deren Kurzlink {base}/suggestions endet)
// bekommen vorher eine Nachricht. Alles in einer Transaktion; die Markierung reserved_suggestions lässt es nur einmal
// laufen (auch wenn ein früherer Lauf nach den Spalten abbrach).
export async function reserveSuggestions(conn: PoolConnection): Promise<void> {
  await conn.beginTransaction();
  try {
    if ((await rows(conn, "SELECT meta_value FROM oys_meta WHERE meta_key = 'reserved_suggestions'")).length) {
      await conn.commit();
      return;
    }
    const base = baseAuthority();
    for (const r of await rows(conn, "SELECT DISTINCT user_id FROM pages WHERE slug = 'suggestions' AND address_mode = 'path' ORDER BY user_id")) {
      await notify(intval(r.user_id), 'system', 'Your page address changed',
        `${base}/suggestions now opens OnYourSite’s suggestions page. Your page stays at suggestions.${base} – please update links and printed QR codes that use the old address.`,
        '/dashboard', { db: conn });
    }
    for (const r of await rows(conn, "SELECT DISTINCT user_id FROM code_sites WHERE slug = 'suggestions' ORDER BY user_id")) {
      await notify(intval(r.user_id), 'system', 'A short link to your code page changed',
        `${base}/suggestions no longer forwards to your code page – it now opens OnYourSite’s suggestions page. Your code page stays at suggestions.${base}.`,
        '/dashboard', { db: conn });
    }
    await run(conn, "UPDATE pages SET address_mode = 'subdomain' WHERE slug = 'suggestions' AND address_mode = 'path'");
    await run(conn, "INSERT INTO oys_meta (meta_key, meta_value) VALUES ('reserved_suggestions', ?)", [date('Y-m-d H:i:s')]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  }
}

// V_CODE_SLOTS_LIVE (CS-6): Einstellungen der Code-Seiten, die in der dunklen Phase gespeichert wurden, enthalten
// max_on_pages 0 – damals der feste Standard, keine Wahl des Teams. Einmal auf 1 heben (der Standard ab CS-6), damit
// „More code pages“ einen nutzbaren Platz gibt; alle anderen Werte bleiben. Ohne gespeicherte Einstellungen gilt der
// neue Standard ohnehin. Kaputtes JSON bleibt unverändert (codeSettingsFrom liest dann die Standards).
async function codeSlotsLive(conn: PoolConnection): Promise<void> {
  const r = await rows(conn, "SELECT meta_value FROM oys_meta WHERE meta_key = 'code_pages'");
  if (!r.length) return;
  let obj: unknown;
  try { obj = JSON.parse(String(r[0].meta_value)); } catch { return; }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return;
  const o = obj as Record<string, unknown>;
  if (o.max_on_pages === undefined || Number(o.max_on_pages) !== 0) return;
  o.max_on_pages = 1;
  await run(conn, "UPDATE oys_meta SET meta_value = ? WHERE meta_key = 'code_pages'", [JSON.stringify(o)]);
}

// HC-8: Serie je Konto. Nachtragen aus den Tagesbuchungen der letzten 60 Tage (ref = Y-m-d): die Tage in Folge, die
// heute oder gestern enden, werden die laufende Serie; die längste Folge in diesem Zeitraum die beste. Konten ohne
// Zeile in hc_accounts bekommen eine. Läuft der Schritt noch einmal, bleibt eine Serie, die schon weiterlief.
export async function shopStreaks(conn: PoolConnection): Promise<void> {
  await addColumn(conn, 'hc_accounts', 'streak', 'SMALLINT UNSIGNED NOT NULL DEFAULT 0');
  await addColumn(conn, 'hc_accounts', 'streak_day', 'DATE NULL');
  await addColumn(conn, 'hc_accounts', 'best_streak', 'SMALLINT UNSIGNED NOT NULL DEFAULT 0');
  const today = date('Y-m-d');
  const from = date('Y-m-d', time() - 61 * 86400);
  // created_at schränkt über idx_reason_time ein; ref ist der Tag der Buchung
  const list = await rows(conn, `SELECT user_id, ref FROM honeycomb_ledger WHERE reason = 'daily' AND created_at >= ? AND ref >= ? AND ref <= ?
      AND ref REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' ORDER BY user_id, ref`, [date('Y-m-d', time() - 62 * 86400) + ' 00:00:00', from, today]);
  const now0 = date('Y-m-d H:i:s');
  await run(conn, `INSERT IGNORE INTO hc_accounts (user_id, created_at, updated_at) SELECT DISTINCT l.user_id, ?, ? FROM honeycomb_ledger l
      JOIN users u ON u.id = l.user_id WHERE l.reason = 'daily' AND l.created_at >= ?`, [now0, now0, date('Y-m-d', time() - 62 * 86400) + ' 00:00:00']);
  const byUser = new Map<number, string[]>();
  for (const r of list) {
    const uid = Number(r.user_id);
    const days = byUser.get(uid) ?? [];
    days.push(String(r.ref));
    byUser.set(uid, days);
  }
  const next = (d: string): string => date('Y-m-d', (strtotime(d + ' +1 day') as number));
  const yesterday = date('Y-m-d', (strtotime(today + ' -1 day') as number));
  for (const [uid, days] of byUser) {
    let len = 0;
    let best = 0;
    let prev = '';
    for (const d of days) {
      len = prev !== '' && next(prev) === d ? len + 1 : 1;
      best = Math.max(best, len);
      prev = d;
    }
    const current = prev === today || prev === yesterday ? len : 0;
    // Nur Konten ohne gezählte Serie (ein zweiter Lauf überschreibt nichts, was der Editor schon gezählt hat)
    await run(conn, `UPDATE hc_accounts SET streak = ?, streak_day = ?, best_streak = GREATEST(best_streak, ?)
        WHERE user_id = ? AND streak_day IS NULL`, [Math.min(65535, current), current > 0 ? prev : null, Math.min(65535, best), uid]);
  }
}
