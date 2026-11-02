// Statusseiten, Schritt V_STATUS_TABLES: alle Tabellen (ohne Abonnenten und Rundmails), Tagespartitionen für
// status_checks, users.status_terms_at, OnYourSites eigene Seite mit ihren Bestandteilen – der Schritt zweimal ändert
// nichts, eine alte Seite auf „status“ hält die Statusseite offline, und ins Adressregister kommt sie nur, wenn es
// die Tabelle schon gibt.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { ensureSchema, stepsAfter, V_NOTIFICATIONS_INDEX, V_STATUS_TABLES } from '../src/schema.js';
import { partitionClauseFor, partitionDay, partitionName, partitionPlan } from '../src/status/partitions.js';
import { testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;

before(async () => {
  t = await testDatabase('st1schema', { empty: true });
});

after(async () => {
  await t.done();
});

const STATUS_TABLES = ['status_channels', 'status_checks', 'status_daily', 'status_events', 'status_host_meta', 'status_host_rules', 'status_hourly',
  'status_incident_monitors', 'status_incident_posts', 'status_incident_updates', 'status_incidents', 'status_monitors', 'status_outbox',
  'status_pages', 'status_purge', 'status_run_requests', 'status_slug_redirects', 'status_state'];

async function q(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  await t.admin.query(`USE \`${t.name}\``);
  return (await t.admin.query<RowDataPacket[]>(sql, params))[0];
}
const statusTables = async (): Promise<string[]> => (await q("SHOW TABLES LIKE 'status\\_%'")).map((r) => String(Object.values(r)[0])).sort();
const version = async (): Promise<string> => String((await q("SELECT meta_value FROM oys_meta WHERE meta_key = 'schema_version'"))[0]?.meta_value);

test('partition names and bounds are UTC days', () => {
  const at = Date.UTC(2026, 10, 1, 23, 30) / 1000; // 1. November, 23:30 UTC (schon der 2. in Berlin)
  assert.equal(partitionName(at), 'p20261101');
  const plan = partitionPlan(at);
  assert.deepEqual(plan.map((p) => p.name), ['p20261101', 'p20261102', 'p20261103', 'p20261104']);
  assert.equal(plan[0].lessThan, Date.UTC(2026, 10, 2) / 1000);
  assert.equal(plan[0].lessThan, 1793577600);
  assert.equal(partitionDay('p20261102'), Date.UTC(2026, 10, 2) / 1000);
  assert.equal(partitionDay('pmax'), null);
  assert.equal(partitionClauseFor(at, 0), `PARTITION BY RANGE (at) (PARTITION p20261101 VALUES LESS THAN (1793577600), PARTITION pmax VALUES LESS THAN MAXVALUE)`);
});

test('the step creates every status table, the column and OnYourSite\'s own page', async () => {
  assert.deepEqual(stepsAfter(V_STATUS_TABLES - 1, V_STATUS_TABLES).map((s) => s.name), ['statusTables']);
  await ensureSchema({ upTo: V_STATUS_TABLES });
  assert.equal(await version(), String(V_STATUS_TABLES));
  assert.deepEqual(await statusTables(), STATUS_TABLES);
  // Abonnenten kommen später (eigener Schritt)
  assert.equal((await q("SHOW TABLES LIKE 'status\\_subscribers'")).length, 0);
  assert.equal((await q("SHOW TABLES LIKE 'status\\_broadcasts'")).length, 0);
  assert.equal((await q("SHOW COLUMNS FROM users WHERE Field = 'status_terms_at'")).length, 1);
  assert.equal((await q("SHOW COLUMNS FROM status_pages WHERE Field = 'limit_paused'"))[0].Type, 'smallint(5) unsigned');

  // status_checks nach Tagen (UTC) unterteilt: heute, drei Tage voraus und der Rest
  const ddl = String((await q('SHOW CREATE TABLE status_checks'))[0]['Create Table']);
  assert.match(ddl, /PARTITION BY RANGE \(`at`\)/);
  const parts = (await q("SELECT PARTITION_NAME AS n FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'status_checks' ORDER BY PARTITION_ORDINAL_POSITION", [t.name])).map((r) => String(r.n));
  assert.deepEqual(parts, [...partitionPlan(Math.floor(Date.now() / 1000)).map((p) => p.name), 'pmax']);

  const pages = await q('SELECT * FROM status_pages');
  assert.equal(pages.length, 1);
  const page = pages[0];
  assert.equal(page.user_id, null);
  assert.equal(page.is_system, 1);
  assert.equal(page.slug, 'status');
  assert.equal(page.title, 'OnYourSite status');
  assert.equal(page.is_published, 1);
  assert.equal(page.theme, 'deep-dark');
  const settings = JSON.parse(String(page.settings)) as Record<string, unknown>;
  assert.deepEqual(settings, { accent: '#6366f1', show_uptime: true, history_days: 14, subscribe: true, auto_incident: 300,
    alerts: { owner: false, admins: true, events: ['down', 'up', 'degraded', 'cert', 'heartbeat'] } });

  const monitors = await q('SELECT type, target, name, group_name, is_public, position, interval_s, config, user_id FROM status_monitors WHERE page_id = ? ORDER BY position', [page.id]);
  assert.deepEqual(monitors.map((m) => m.target), ['web', 'pages', 'domains', 'bot', 'mail', 'db', 'tunnel', 'origin', 'disk', 'job:backup',
    'job:weekly', 'job:runner', 'job:domains']);
  assert.ok(monitors.every((m) => m.type === 'system' && m.user_id === null));
  assert.deepEqual(monitors.filter((m) => m.is_public === 0).map((m) => m.target), ['origin', 'disk', 'job:backup', 'job:weekly', 'job:runner', 'job:domains']);
  assert.deepEqual(monitors.filter((m) => m.group_name === 'Infrastructure').map((m) => m.name), ['Database', 'Cloudflare tunnel']);
  assert.deepEqual(JSON.parse(String(monitors.find((m) => m.target === 'job:backup')?.config)), { period: 86400, grace: 7200 });
  assert.deepEqual(monitors.map((m) => m.position), monitors.map((_m, i) => i));
  assert.equal(String((await q("SELECT meta_value FROM oys_meta WHERE meta_key = 'status_rev'"))[0].meta_value), '1');
});

test('the step twice changes nothing', async () => {
  const before = { pages: await q('SELECT * FROM status_pages'), monitors: await q('SELECT * FROM status_monitors ORDER BY id') };
  const ddlBefore = await Promise.all(STATUS_TABLES.map(async (tb) => String((await q(`SHOW CREATE TABLE ${tb}`))[0]['Create Table'])));
  await q("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('schema_version', ?)", [String(V_STATUS_TABLES - 1)]);
  await ensureSchema({ upTo: V_STATUS_TABLES });
  assert.equal(await version(), String(V_STATUS_TABLES));
  assert.deepEqual(await q('SELECT * FROM status_pages'), before.pages);
  assert.deepEqual(await q('SELECT * FROM status_monitors ORDER BY id'), before.monitors);
  const ddlAfter = await Promise.all(STATUS_TABLES.map(async (tb) => String((await q(`SHOW CREATE TABLE ${tb}`))[0]['Create Table'])));
  assert.deepEqual(ddlAfter, ddlBefore);
});

test('a legacy page on "status" keeps the system page offline; the registry gets it only when the table exists', async () => {
  // Frischer Stand bis vor den Schritt, dazu eine alte Seite mit der Adresse und schon ein Adressregister
  for (const tb of STATUS_TABLES) await q(`DROP TABLE ${tb}`);
  await q("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('schema_version', ?)", [String(V_STATUS_TABLES - 1)]);
  await q("INSERT INTO users (email, password, created_at) VALUES ('legacy@test.de', 'x', NOW())");
  const uid = (await q("SELECT id FROM users WHERE email = 'legacy@test.de'"))[0].id as number;
  await q("INSERT INTO pages (user_id, slug, created_at, updated_at) VALUES (?, 'status', NOW(), NOW())", [uid]);
  // Das Adressregister gibt es seit V_SITE_ADDRESSES schon – für diesen Fall leer neu anlegen
  await q('DROP TABLE IF EXISTS site_addresses');
  await q(`CREATE TABLE site_addresses (
      slug VARCHAR(63) NOT NULL PRIMARY KEY, kind VARCHAR(8) NOT NULL, ref_id INT NULL, user_id INT NULL, claimed_at DATETIME NOT NULL,
      released_at DATETIME NULL, hold_until DATETIME NULL, KEY idx_ref (kind, ref_id), KEY idx_user (user_id), KEY idx_hold (kind, hold_until)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
  try {
    await ensureSchema({ upTo: V_STATUS_TABLES });
  } finally {
    console.error = origError;
  }
  const page = (await q('SELECT * FROM status_pages WHERE is_system = 1'))[0];
  assert.equal(page.is_published, 0);
  assert.ok(errors.some((e) => e.includes('"status"') && e.includes('offline')), errors.join('\n'));
  const claimed = await q('SELECT slug, kind, ref_id, user_id, hold_until FROM site_addresses');
  assert.deepEqual(claimed.map((r) => ({ ...r })), [{ slug: 'status', kind: 'status', ref_id: page.id, user_id: null, hold_until: null }]);
});

// Prüfbericht: OnYourSites eigene Seite wurde Zeile für Zeile ohne Transaktion angelegt, der Schritt überspringt sie
// aber, sobald es die Seite gibt. Brach er mittendrin ab (Neustart, Fehler), fehlten die übrigen Bestandteile für immer.
test('an interrupted seed is completed on the next run (page and components in one transaction)', async () => {
  for (const tb of STATUS_TABLES) await q(`DROP TABLE IF EXISTS ${tb}`);
  await q('DROP TABLE IF EXISTS site_addresses');
  await q("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('schema_version', ?)", [String(V_STATUS_TABLES - 1)]);
  await q("DELETE FROM pages WHERE slug IN ('status', 'health')");
  // Ein Fehler beim sechsten Bestandteil (Database)
  await q(`CREATE TABLE status_monitors (
        id INT AUTO_INCREMENT PRIMARY KEY, page_id INT NOT NULL, user_id INT NULL, type VARCHAR(12) NOT NULL, name VARCHAR(80) NOT NULL,
        description VARCHAR(200) NOT NULL DEFAULT '', group_name VARCHAR(60) NOT NULL DEFAULT '', position SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        is_public TINYINT(1) NOT NULL DEFAULT 1, target VARCHAR(500) NOT NULL DEFAULT '', target_host VARCHAR(253) NOT NULL DEFAULT '',
        target_domain VARCHAR(253) NOT NULL DEFAULT '', config TEXT NULL, interval_s SMALLINT UNSIGNED NOT NULL DEFAULT 300,
        manual_status VARCHAR(12) NULL, manual_since INT UNSIGNED NULL, hb_token_hash CHAR(64) NULL, hb_token_enc VARCHAR(255) NULL,
        hb_last_ping_at INT UNSIGNED NULL, hb_last_fail_at INT UNSIGNED NULL, is_paused TINYINT(1) NOT NULL DEFAULT 0,
        admin_paused TINYINT(1) NOT NULL DEFAULT 0, admin_note VARCHAR(200) NULL, auto_paused VARCHAR(12) NULL, auto_paused_at INT UNSIGNED NULL,
        changed_at INT UNSIGNED NOT NULL DEFAULT 0, created_at DATETIME NULL, updated_at DATETIME NULL,
        CONSTRAINT ck_test_interrupt CHECK (target <> 'db')
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await assert.rejects(ensureSchema({ upTo: V_STATUS_TABLES }));
  assert.equal(await version(), String(V_STATUS_TABLES - 1), 'the step did not finish');
  await q('ALTER TABLE status_monitors DROP CONSTRAINT ck_test_interrupt');
  await ensureSchema({ upTo: V_STATUS_TABLES });
  assert.equal(await version(), String(V_STATUS_TABLES));
  const pages = await q('SELECT id FROM status_pages WHERE is_system = 1');
  assert.equal(pages.length, 1);
  const targets = (await q('SELECT target FROM status_monitors WHERE page_id = ? ORDER BY position', [pages[0].id])).map((r) => r.target);
  assert.deepEqual(targets, ['web', 'pages', 'domains', 'bot', 'mail', 'db', 'tunnel', 'origin', 'disk', 'job:backup', 'job:weekly', 'job:runner', 'job:domains']);
});
