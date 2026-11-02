// Schritte des Schemas: Hilfen für wiederholbare Schritte (jede zweimal), ensureSchema({ upTo }) für Ausgangsstände
// von Tests und der rein lesende Stand für Hintergrunddienste.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { withConnection } from '../src/db.js';
import {
  SCHEMA_VERSION, V_CODE_PAGES, V_PAGES, V_SESSIONS, V_UPDATES, addColumn, addIndex, columnIsNotNull, dropIndex, ensureSchema, hasIndex,
  hasTable, schemaAtLeast, stepsAfter,
} from '../src/schema.js';
import { testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;

before(async () => {
  t = await testDatabase('c1schema', { empty: true });
});

after(async () => {
  await t.done();
});

const tables = async (): Promise<string[]> =>
  ((await t.admin.query<RowDataPacket[]>(`SHOW TABLES FROM \`${t.name}\``))[0]).map((r) => String(Object.values(r)[0])).sort();
const version = async (): Promise<string | undefined> =>
  ((await t.admin.query<RowDataPacket[]>(`SELECT meta_value FROM \`${t.name}\`.oys_meta WHERE meta_key = 'schema_version'`))[0])[0]?.meta_value as string | undefined;

test('steps are listed in order with names, and the highest one is the schema version', () => {
  const all = stepsAfter(0);
  assert.ok(all.length >= V_SESSIONS);
  for (let i = 1; i < all.length; i++) assert.ok(all[i].version > all[i - 1].version, 'versions increase');
  assert.equal(all[all.length - 1].version, SCHEMA_VERSION);
  assert.deepEqual(all.slice(0, 5).map((s) => s.name), ['pages', 'updates', 'codePages', 'community', 'sessions']);
  assert.deepEqual(stepsAfter(SCHEMA_VERSION), []);
  assert.deepEqual(stepsAfter(V_UPDATES, V_CODE_PAGES).map((s) => s.version), [V_CODE_PAGES]);
  assert.ok(all.every((s) => /^[a-z][A-Za-z0-9]*$/.test(s.name)));
});

test('an empty database: upTo stops at a step, a second run continues from there', async () => {
  assert.deepEqual(await tables(), []);
  assert.equal(await schemaAtLeast(V_PAGES), false);

  await ensureSchema({ upTo: V_UPDATES });
  assert.equal(await version(), String(V_UPDATES));
  const mid = await tables();
  assert.ok(mid.includes('updates') && mid.includes('pages'));
  assert.ok(!mid.includes('code_sites') && !mid.includes('oys_sessions'));
  assert.equal(await schemaAtLeast(V_UPDATES), true);
  assert.equal(await schemaAtLeast(V_CODE_PAGES), false);

  // Ein kleineres upTo ändert nichts, ein größeres als der Code kennt wird auf den höchsten Schritt begrenzt
  await ensureSchema({ upTo: V_PAGES });
  assert.equal(await version(), String(V_UPDATES));
  await ensureSchema({ upTo: SCHEMA_VERSION + 100 });
  assert.equal(await version(), String(SCHEMA_VERSION));
  assert.ok((await tables()).includes('oys_sessions'));
  assert.equal(await schemaAtLeast(SCHEMA_VERSION), true);

  // Noch einmal: nichts passiert (die Seeds der Updates bleiben einmalig)
  const [[seeds]] = await t.admin.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${t.name}\`.updates`);
  await ensureSchema();
  const [[again]] = await t.admin.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${t.name}\`.updates`);
  assert.equal(again.n, seeds.n);
});

test('a database that is newer than the code stays as it is', async () => {
  await t.admin.query(`REPLACE INTO \`${t.name}\`.oys_meta (meta_key, meta_value) VALUES ('schema_version', ?)`, [String(SCHEMA_VERSION + 3)]);
  try {
    assert.equal(await schemaAtLeast(SCHEMA_VERSION + 3), true);
    await ensureSchema();
    assert.equal(await version(), String(SCHEMA_VERSION + 3));
  } finally {
    await t.admin.query(`REPLACE INTO \`${t.name}\`.oys_meta (meta_key, meta_value) VALUES ('schema_version', ?)`, [String(SCHEMA_VERSION)]);
  }
});

test('every helper can run twice (the second run changes nothing)', async () => {
  await t.admin.query(`CREATE TABLE \`${t.name}\`.oys_c1_helper (id INT PRIMARY KEY, a INT NOT NULL, b INT NULL) ENGINE=InnoDB`);
  await withConnection(async (_db, conn) => {
    assert.equal(await hasTable(conn, 'oys_c1_helper'), true);
    // _ ist in LIKE ein Platzhalter – hier zählt nur der genaue Name
    assert.equal(await hasTable(conn, 'oys_c1xhelper'), false);
    assert.equal(await hasTable(conn, 'oys_c1_missing'), false);

    for (let i = 0; i < 2; i++) await addColumn(conn, 'oys_c1_helper', 'c', 'VARCHAR(20) NULL');
    for (let i = 0; i < 2; i++) await addIndex(conn, 'oys_c1_helper', 'idx_ab', 'KEY idx_ab (a, b)');
    for (let i = 0; i < 2; i++) await addIndex(conn, 'oys_c1_helper', 'uq_c', 'UNIQUE KEY `uq_c` (c)');
    assert.equal(await hasIndex(conn, 'oys_c1_helper', 'idx_ab'), true);
    assert.equal(await hasIndex(conn, 'oys_c1_helper', 'uq_c'), true);
    assert.equal(await hasIndex(conn, 'oys_c1_helper', 'idx_none'), false);

    const [cols] = await conn.query<RowDataPacket[]>('SHOW COLUMNS FROM oys_c1_helper');
    assert.deepEqual(cols.map((c) => c.Field), ['id', 'a', 'b', 'c']);
    const [idx] = await conn.query<RowDataPacket[]>('SHOW INDEX FROM oys_c1_helper');
    assert.deepEqual([...new Set(idx.map((r) => r.Key_name))].sort(), ['PRIMARY', 'idx_ab', 'uq_c']);

    assert.equal(await columnIsNotNull(conn, 'oys_c1_helper', 'a'), true);
    assert.equal(await columnIsNotNull(conn, 'oys_c1_helper', 'b'), false);
    assert.equal(await columnIsNotNull(conn, 'oys_c1_helper', 'nope'), false);
    // Das typische Muster: MODIFY nur, solange die Spalte NOT NULL ist
    for (let i = 0; i < 2; i++) {
      if (await columnIsNotNull(conn, 'oys_c1_helper', 'a')) await conn.query('ALTER TABLE oys_c1_helper MODIFY a INT NULL');
    }
    assert.equal(await columnIsNotNull(conn, 'oys_c1_helper', 'a'), false);

    for (let i = 0; i < 2; i++) await dropIndex(conn, 'oys_c1_helper', 'idx_ab');
    assert.equal(await hasIndex(conn, 'oys_c1_helper', 'idx_ab'), false);
    assert.equal(await hasIndex(conn, 'oys_c1_helper', 'uq_c'), true);
  });
});

test('helpers refuse definitions that would not be repeatable and odd names', async () => {
  await withConnection(async (_db, conn) => {
    // Der Name in der Definition muss der geprüfte sein – sonst entstünde bei jedem Lauf ein neuer Index
    await assert.rejects(addIndex(conn, 'oys_c1_helper', 'idx_x', 'KEY idx_y (b)'), /must name idx_x/);
    await assert.rejects(addIndex(conn, 'oys_c1_helper', 'idx_x', 'ADD KEY idx_x (b)'), /must name idx_x/);
    await assert.rejects(hasIndex(conn, 'oys_c1_helper`; DROP TABLE x; --', 'idx'), /invalid identifier/);
    await assert.rejects(addColumn(conn, 'oys_c1_helper', 'd`', 'INT NULL'), /invalid identifier/);
    await assert.rejects(columnIsNotNull(conn, 'oys_c1_helper', 'a b'), /invalid identifier/);
    assert.equal(await hasIndex(conn, 'oys_c1_helper', 'idx_x'), false);
  });
});
