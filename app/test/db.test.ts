// Datenbank-Regeln gegen PDO: geänderte Zeilen, Typen, Zeitzone je Verbindung, Sperren, Socket für 'localhost'
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { ROOT_DIR, loadConfig, setConfigForTests, type ConfigData } from '../src/config.js';
import { closePool, exec, one, q, value, withNamedLock, withConnection, transaction, outsidePinned, LockBusyError, DbUnavailableError, tzOffset } from '../src/db.js';

const BASE = loadConfig();
const withDb = (patch: Record<string, unknown>) => setConfigForTests({ ...BASE, db: { ...(BASE.db as ConfigData), ...patch } as ConfigData });

after(async () => {
  setConfigForTests(BASE);
  await closePool();
});

// Dieselben Anweisungen in PHP (PDO wie db.php) – rowCount() nach jeder
function phpRowCounts(statements: string[]): number[] {
  const script = `require '${ROOT_DIR}/lib/config.php'; date_default_timezone_set(oys_config('timezone', 'Europe/Berlin'));
    $pdo = new PDO('mysql:host=' . oys_config('db.host') . ';dbname=' . oys_config('db.name') . ';charset=utf8mb4', oys_config('db.user'), oys_config('db.pass'),
      [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $out = []; foreach (json_decode(stream_get_contents(STDIN), true) as $sql) { $out[] = $pdo->exec($sql); } echo json_encode($out);`;
  return JSON.parse(execFileSync('php', ['-r', script], { input: JSON.stringify(statements), cwd: ROOT_DIR }).toString());
}

test('affected rows count only changed rows, like PDO rowCount()', async () => {
  const steps = [
    'CREATE TEMPORARY TABLE oys_t (id INT PRIMARY KEY, v INT)',
    'INSERT INTO oys_t VALUES (1, 1), (2, 2), (3, 3)',
    'UPDATE oys_t SET v = 1 WHERE id = 1',
    'UPDATE oys_t SET v = 5 WHERE id IN (1, 2)',
    'UPDATE oys_t SET v = v WHERE id > 0',
    'INSERT INTO oys_t VALUES (1, 9) ON DUPLICATE KEY UPDATE v = VALUES(v)',
    'INSERT IGNORE INTO oys_t VALUES (1, 9)',
    'DELETE FROM oys_t WHERE id = 3',
  ];
  const php = phpRowCounts(steps);
  // Temporäre Tabellen gelten je Verbindung: alles auf einer Verbindung ausführen
  const { withConnection } = await import('../src/db.js');
  const node = await withConnection(async (db) => {
    const out: number[] = [];
    for (const sql of steps) out.push((await db.exec(sql)).affectedRows);
    return out;
  });
  assert.deepEqual(node, php);
});

test('value types match PDO', async () => {
  const row = await one("SELECT 5 AS i, COUNT(*) AS c, SUM(1) AS s, AVG(2) AS a, 1.5 AS f, NOW() AS d, CAST('2026-01-02' AS DATE) AS day, NULL AS n FROM oys_meta");
  assert.equal(typeof row?.i, 'number');
  assert.equal(typeof row?.c, 'number');
  assert.equal(typeof row?.s, 'string');
  assert.equal(typeof row?.a, 'string');
  assert.equal(row?.f, '1.5');
  assert.match(String(row?.d), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.equal(row?.day, '2026-01-02');
  assert.equal(row?.n, null);
});

test('every query runs in the site time zone, also after the zone changes', async () => {
  assert.equal(await value('SELECT @@session.time_zone'), tzOffset('Europe/Berlin'));
  setConfigForTests({ ...BASE, timezone: 'America/New_York' });
  try {
    // Dieselbe Verbindung aus dem Pool bekommt vor der nächsten Abfrage die neue Zone
    assert.equal(await value('SELECT @@session.time_zone'), tzOffset('America/New_York'));
    const rows = await q('SELECT @@session.time_zone AS tz');
    assert.equal(rows[0].tz, tzOffset('America/New_York'));
  } finally {
    setConfigForTests(BASE);
  }
  assert.equal(await value('SELECT @@session.time_zone'), tzOffset('Europe/Berlin'));
});

test('named locks: a busy lock fails or runs as asked', async () => {
  let inner: unknown = null;
  await withNamedLock('oys_test_lock', 1, async () => {
    // Eine zweite Verbindung (bewusst außerhalb des Abschnitts) bekommt dieselbe Sperre nicht
    await outsidePinned(() => assert.rejects(withNamedLock('oys_test_lock', 0, async () => 'never', 'fail'), LockBusyError));
    inner = await outsidePinned(() => withNamedLock('oys_test_lock', 0, async () => 'ran anyway', 'run'));
  });
  assert.equal(inner, 'ran anyway');
  assert.equal(await withNamedLock('oys_test_lock', 1, async () => 'free again', 'fail'), 'free again');
});

test('queries inside a locked section reuse its connection – no deadlock when the pool is full', async () => {
  setConfigForTests({ ...BASE, db: { ...(BASE.db as ConfigData), pool: 2 } as ConfigData });
  await closePool();
  try {
    // 6 Abschnitte gleichzeitig bei nur 2 Verbindungen; jeder fragt innen über die Pool-Funktionen ab
    const runs = Array.from({ length: 6 }, (_, i) => withNamedLock(`oys_test_dl_${i}`, 5, async () => {
      const own = await value('SELECT CONNECTION_ID()');
      const again = await q('SELECT CONNECTION_ID() AS id');
      assert.equal(again[0].id, own, 'inner query runs on the section\'s connection');
      return own;
    }));
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('deadlock')), 15000));
    const ids = (await Promise.race([Promise.all(runs), timeout])) as unknown[];
    assert.equal(ids.length, 6);
  } finally {
    setConfigForTests(BASE);
    await closePool();
  }
});

test('transactions cover nested helper queries and refuse to nest', async () => {
  await withConnection(async (db) => {
    await db.exec('CREATE TEMPORARY TABLE oys_tx (id INT PRIMARY KEY)');
    await assert.rejects(transaction(async () => {
      // Pool-Funktion innerhalb der Transaktion: dieselbe Verbindung, also mit zurückgerollt
      await exec('INSERT INTO oys_tx VALUES (1)');
      throw new Error('stop');
    }), /stop/);
    assert.equal(await value('SELECT COUNT(*) FROM oys_tx'), 0);
    await transaction(async () => {
      await assert.rejects(transaction(async () => undefined), /already an active transaction/);
      await exec('INSERT INTO oys_tx VALUES (2)');
    });
    assert.equal(await value('SELECT COUNT(*) FROM oys_tx'), 1);
  });
});

test('work that outlives its section gets a fresh connection', async () => {
  let later: Promise<unknown> | null = null;
  await withConnection(async () => {
    later = new Promise((resolve) => setTimeout(() => resolve(value('SELECT 7')), 50));
  });
  assert.equal(await later, 7);
});

test("host 'localhost' uses the unix socket like PDO", async () => {
  withDb({ host: 'localhost' });
  await closePool();
  try {
    assert.equal(await value('SELECT 1'), 1);
    // Über den Socket meldet der Server keinen TCP-Port der Gegenseite
    assert.equal(await value("SELECT SUBSTRING_INDEX(USER(), '@', -1)"), 'localhost');
  } finally {
    setConfigForTests(BASE);
    await closePool();
  }
});

test('an unreachable database gives DbUnavailableError', async () => {
  withDb({ host: '127.0.0.1', port: '1' });
  await closePool();
  try {
    await assert.rejects(exec('SELECT 1'), DbUnavailableError);
  } finally {
    setConfigForTests(BASE);
    await closePool();
  }
});
