// Release-System: VERSION passt zu CHANGELOG.md und app/package.json, die Version steht im Admin-Menü und im
// User-Agent an Discord, und der Schritt V_UPDATE_HISTORY lässt alles, was der Admin selbst eingetragen oder
// geändert hat, wie es ist (eigene Test-Datenbank).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { ROOT_DIR, loadConfig, setConfigForTests, configString, type ConfigData } from '../src/config.js';
import { closePool } from '../src/db.js';
import { ensureSchema, V_UPDATE_HISTORY } from '../src/schema.js';
import { appVersion } from '../src/version.js';
import { RELEASE_NOTES, seedReleaseNotes, shortVersion } from '../src/updates/releaseNotes.js';

const BASE = loadConfig();
const DB = configString('db.name', 'oys_test') + '_release';
let admin: Connection;

async function migrate(upTo?: number): Promise<void> {
  setConfigForTests({ ...BASE, db: { ...(BASE.db as ConfigData), name: DB } });
  await closePool();
  try {
    await ensureSchema(upTo === undefined ? {} : { upTo });
  } finally {
    await closePool();
    setConfigForTests(BASE);
  }
}
async function fresh(): Promise<void> {
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await migrate(V_UPDATE_HISTORY - 1);
}
const q = async (sql: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> =>
  (await admin.query<RowDataPacket[]>(sql.replaceAll('`db`', '`' + DB + '`'), params))[0] as Array<Record<string, unknown>>;

before(async () => {
  admin = await mysql.createConnection({
    host: configString('db.host', 'localhost'), user: configString('db.user', ''), password: configString('db.pass', ''),
    charset: 'utf8mb4_unicode_ci', dateStrings: true,
  });
});
after(async () => {
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.end();
});

test('VERSION is a version number with its own section in CHANGELOG.md and the same number in app/package.json', () => {
  const v = appVersion();
  assert.match(v, /^\d+\.\d+\.\d+$/);
  assert.equal(readFileSync(join(ROOT_DIR, 'VERSION'), 'utf8'), v + '\n');
  const changelog = readFileSync(join(ROOT_DIR, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, new RegExp('^## \\[' + v.replaceAll('.', '\\.') + '\\] - \\d{4}-\\d{2}-\\d{2}$', 'm'));
  assert.match(changelog, /^## \[Unreleased\]$/m);
  const pkg = JSON.parse(readFileSync(join(ROOT_DIR, 'app', 'package.json'), 'utf8')) as { version: string };
  const lock = JSON.parse(readFileSync(join(ROOT_DIR, 'app', 'package-lock.json'), 'utf8')) as { version: string; packages: Record<string, { version?: string }> };
  assert.equal(pkg.version, v);
  assert.equal(lock.version, v);
  assert.equal(lock.packages[''].version, v);
});

test('every version in CHANGELOG.md appears once, newest first, and none is empty', () => {
  const changelog = readFileSync(join(ROOT_DIR, 'CHANGELOG.md'), 'utf8');
  const sections = changelog.split(/^## /m).slice(1);
  const versions = sections.map((s) => /^\[([^\]]+)\]/.exec(s)?.[1]);
  assert.equal(versions[0], 'Unreleased');
  const numbers = versions.slice(1) as string[];
  assert.equal(new Set(numbers).size, numbers.length);
  const key = (v: string) => v.split('.').map((n) => n.padStart(4, '0')).join('.');
  assert.deepEqual([...numbers].sort((a, b) => key(b).localeCompare(key(a))), numbers);
  for (const s of sections.slice(1)) assert.match(s.split('\n').slice(1).join('\n'), /^- /m, s.split('\n')[0]);
});

test('the admin menu shows the installed version and Discord requests send it', async () => {
  const admin = readFileSync(join(ROOT_DIR, 'app', 'src', 'admin', 'views', 'admin.ts'), 'utf8');
  assert.match(admin, /OnYourSite v";\n  o \+= e\(appVersion\(\)\);/);
  const { adminView } = await import('../src/admin/views/admin.js');
  assert.equal(typeof adminView, 'function');
  const rest = readFileSync(join(ROOT_DIR, 'app', 'src', 'discord', 'rest.ts'), 'utf8');
  assert.match(rest, /'User-Agent: DiscordBot \(https:\/\/' \+ baseHost\(\) \+ ', ' \+ appVersion\(\) \+ '\)'/);
});

test('history: drafts the admin changed stay drafts, versions entered by hand are not published twice', async () => {
  await fresh();
  // 2.0: Entwurf bearbeitet · 2.1: selbst als eigenes Update veröffentlicht · 2.2 bleibt unverändert
  await q("UPDATE `db`.updates SET body = 'mine', updated_at = '2026-10-30 10:00:00' WHERE version = '2.0'");
  await q("INSERT INTO `db`.updates (title, body, version, category, is_published, published_at, created_at, updated_at) VALUES ('My 2.1', 'x', 'v2.1', 'new', 1, '2026-10-28 12:00:00', '2026-10-28 12:00:00', '2026-10-28 12:00:00')");
  await migrate();
  const rows = await q('SELECT id, title, version, is_published, published_at, milestone_id FROM `db`.updates ORDER BY id');
  const by = (v: string) => rows.filter((r) => r.version === v);
  assert.equal(by('2.0')[0].is_published, 0, 'changed draft stays a draft');
  assert.equal(by('2.0.1')[0].is_published, 1);
  assert.equal(by('2.1')[0].is_published, 0, 'the seed stays a draft');
  assert.equal(by('v2.1')[0].is_published, 1);
  assert.equal(by('2.2')[0].is_published, 1);
  // Die Roadmap war leer: vier Etappen, 2.1 zeigt auf das eigene Update
  const ms = await q('SELECT id, title FROM `db`.milestones ORDER BY position');
  assert.equal(ms.length, 4);
  assert.equal(by('v2.1')[0].milestone_id, ms[2].id);
  assert.equal(by('2.1')[0].milestone_id, null);
  assert.equal(by('2.0')[0].milestone_id, ms[0].id, 'the changed draft is linked, not published');
  assert.deepEqual(rows.filter((r) => r.is_published === 0).map((r) => r.version), ['2.0', '2.1', '3.0', '3.1']);
  // Ein zweiter Lauf ändert nichts
  await q("DELETE FROM `db`.oys_meta WHERE meta_key = 'schema_version'");
  await q("INSERT INTO `db`.oys_meta (meta_key, meta_value) VALUES ('schema_version', ?)", [String(V_UPDATE_HISTORY - 1)]);
  await migrate();
  assert.deepEqual(await q('SELECT id, title, version, is_published, published_at, milestone_id FROM `db`.updates ORDER BY id'), rows);
  assert.equal((await q('SELECT id FROM `db`.milestones')).length, 4, 'a second run adds no milestones (the roadmap is no longer empty)');
});

test('history: a roadmap with entries gets no milestones, and 3.0 or 3.1 written by hand gets no second draft', async () => {
  await fresh();
  await q("INSERT INTO `db`.milestones (title, status, position) VALUES ('Mine', 'now', 1)");
  await q("INSERT INTO `db`.updates (title, body, version, category, is_published, created_at, updated_at) VALUES ('Our 3.0', 'x', 'V3.0.0', 'new', 0, NOW(), NOW())");
  await migrate();
  assert.deepEqual((await q('SELECT title FROM `db`.milestones')).map((r) => r.title), ['Mine']);
  const rows = await q('SELECT version, is_published, milestone_id, discord_announce FROM `db`.updates ORDER BY id');
  assert.deepEqual(rows.map((r) => [r.version, r.is_published, r.milestone_id]),
    [['2.0', 1, null], ['2.0.1', 1, null], ['2.1', 1, null], ['2.2', 1, null], ['V3.0.0', 0, null], ['3.1', 0, null]]);
  assert.equal(rows[5].discord_announce, 1);
});

test('history: 2.2 keeps its release day, not the day of the update', async () => {
  await fresh();
  await migrate();
  const [u] = await q("SELECT published_at, milestone_id FROM `db`.updates WHERE version = '2.2'");
  assert.equal(u.published_at, '2026-10-29 12:00:00');
  const [m] = await q('SELECT done_at FROM `db`.milestones WHERE id = ?', [u.milestone_id]);
  assert.equal(m.done_at, '2026-10-29 12:00:00');
});

test('history: an own update that only shares the title of a seed (another version) does not count as that seed', async () => {
  await fresh();
  await q("INSERT INTO `db`.updates (title, body, version, category, is_published, published_at, created_at, updated_at) VALUES ('Security improvements', 'x', '3.0.2', 'improved', 1, '2026-11-02 12:00:00', '2026-11-02 12:00:00', '2026-11-02 12:00:00')");
  await migrate();
  const rows = await q("SELECT version, is_published, milestone_id FROM `db`.updates WHERE title = 'Security improvements' ORDER BY id");
  assert.deepEqual(rows.map((r) => [r.version, r.is_published, r.milestone_id === null]), [['2.0.1', 1, false], ['3.0.2', 1, true]]);
});

test('history: a step that fails half way leaves nothing behind, and the next start does all of it', async () => {
  await fresh();
  // Der dritte Meilenstein scheitert einmal (z. B. Datenbank weg)
  await q('CREATE TABLE `db`.fail_once (x INT)');
  await q('INSERT INTO `db`.fail_once VALUES (1)');
  await q("CREATE TRIGGER `db`.ms_fail BEFORE INSERT ON `db`.milestones FOR EACH ROW BEGIN IF NEW.title = 'English interface, new themes and phones' AND (SELECT COUNT(*) FROM `db`.fail_once) > 0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'boom'; END IF; END");
  await assert.rejects(migrate(), /boom/);
  assert.equal((await q('SELECT id FROM `db`.milestones')).length, 0);
  assert.equal((await q('SELECT id FROM `db`.updates WHERE is_published = 1')).length, 0);
  await q('DELETE FROM `db`.fail_once');
  await migrate();
  const rows = await q('SELECT version, is_published, milestone_id FROM `db`.updates ORDER BY id');
  assert.equal((await q('SELECT id FROM `db`.milestones')).length, 4);
  assert.deepEqual(rows.slice(0, 4).map((r) => [r.is_published, r.milestone_id !== null]), [[1, true], [1, true], [1, true], [1, true]]);
});

test('the Release workflow only publishes from main, also when started by hand', () => {
  const wf = readFileSync(join(ROOT_DIR, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(wf, /^\s+if: github\.ref == 'refs\/heads\/main'$/m);
});

// Jede Version ab 3.2 bringt ihren Text für /updates mit (updates/releaseNotes.ts)
test('every version from 3.2 on has its text for /updates, and VERSION has one', () => {
  const changelog = readFileSync(join(ROOT_DIR, 'CHANGELOG.md'), 'utf8');
  const versions = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
  const key = (v: string) => v.split('.').map((n) => n.padStart(4, '0')).join('.');
  const need = versions.filter((v) => key(v) >= key('3.2.0'));
  assert.ok(need.includes(appVersion()), 'VERSION is in CHANGELOG.md');
  for (const v of need) assert.ok(RELEASE_NOTES.some((n) => n.version === v), `release note for ${v} in app/src/updates/releaseNotes.ts`);
  for (const n of RELEASE_NOTES) {
    assert.ok(n.title.length > 0 && n.title.length <= 160, n.version);
    assert.match(n.body, /^- /m, n.version);
  }
  assert.equal(shortVersion('3.2.0'), '3.2');
  assert.equal(shortVersion('3.2.1'), '3.2.1');
});

async function seedIn(notes: Parameters<typeof seedReleaseNotes>[0]): Promise<string[]> {
  setConfigForTests({ ...BASE, db: { ...(BASE.db as ConfigData), name: DB } });
  await closePool();
  try {
    return await seedReleaseNotes(notes);
  } finally {
    await closePool();
    setConfigForTests(BASE);
  }
}

test('release notes: a draft once, never twice, not after it was deleted, not for a version written by hand', async () => {
  await fresh();
  await migrate();
  const notes = [
    { version: '9.1.0', category: 'new' as const, title: 'Nine one', body: '- a', announce: true },
    { version: '9.2.0', category: 'fixed' as const, title: 'Nine two', body: '- b', announce: false },
  ];
  // 9.2 hat der Admin schon selbst geschrieben
  await q("INSERT INTO `db`.updates (title, body, version, category, is_published, created_at, updated_at) VALUES ('Mine', 'x', 'v9.2', 'new', 1, NOW(), NOW())");
  assert.deepEqual(await seedIn(notes), ['9.1.0']);
  const rows = await q("SELECT title, version, is_published, published_at, discord_announce, category FROM `db`.updates WHERE version IN ('9.1', 'v9.2') ORDER BY id");
  assert.deepEqual(rows, [
    { title: 'Mine', version: 'v9.2', is_published: 1, published_at: null, discord_announce: 1, category: 'new' },
    { title: 'Nine one', version: '9.1', is_published: 0, published_at: null, discord_announce: 1, category: 'new' },
  ]);
  assert.deepEqual(await seedIn(notes), [], 'a second run adds nothing');
  // Gelöscht: kommt nicht wieder
  await q("DELETE FROM `db`.updates WHERE version = '9.1'");
  assert.deepEqual(await seedIn(notes), []);
  assert.equal((await q("SELECT id FROM `db`.updates WHERE version = '9.1'")).length, 0);
  const [meta] = await q("SELECT meta_value FROM `db`.oys_meta WHERE meta_key = 'release_notes'");
  assert.deepEqual(JSON.parse(String(meta.meta_value)), ['9.1.0', '9.2.0']);
  // Ein neuer Eintrag kommt dazu
  assert.deepEqual(await seedIn([...notes, { version: '9.3.0', category: 'improved', title: 'Nine three', body: '- c', announce: true }]), ['9.3.0']);
});
