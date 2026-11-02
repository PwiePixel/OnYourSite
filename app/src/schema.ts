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
import { date, intval, mbSubstr, phpStr, phpTrim, phpTruthy, strtolower } from './php.js';
import { phpJson } from './html.js';
import { decryptData } from './crypto.js';
import { cleanCss } from './css.js';

// Stand der portierten Seite (Release 3.0 migriert genau bis hier)
export const V_PAGES = 1; // Profilseiten + Übernahme der alten Profile
export const V_UPDATES = 2; // Updates, Roadmap, Discord
export const V_CODE_PAGES = 3; // Honigwaben und Code-Seiten
export const V_COMMUNITY = 4; // Discord-Bot (Vorschläge, Support-Tickets)
export const V_SESSIONS = 5; // Sitzungen in der Datenbank (Node-Version)
// Funktionen nach dem Umstieg (Nummer = Reihenfolge des Zusammenführens)
export const V_NOTIFICATIONS_INDEX = 6; // Glocke: neueste zuerst und „gelesen bis“
export const V_CUSTOM_DOMAINS = 7; // Eigene Domains (Premium): Domains, Verlauf, Hauptadresse der Seite

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
  const users = await rows(conn, "SELECT * FROM users WHERE username IS NOT NULL AND username <> ''");

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
