// Testschalter der Datenbank: OYS_DB_POOL_SIZE (Größe des Pools) und OYS_DB_STRICT=1 (eine zweite Verbindung im selben
// Ablauf wirft sofort NestedConnectionError, statt bei vollem Pool für immer zu warten).
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { NestedConnectionError, closePool, getPool, outsidePinned, q, transaction, value, withConnection } from '../src/db.js';

const saved = { size: process.env.OYS_DB_POOL_SIZE, strict: process.env.OYS_DB_STRICT };
const setEnv = (name: string, v: string | undefined): void => {
  if (v === undefined) delete process.env[name];
  else process.env[name] = v;
};

afterEach(async () => {
  await closePool();
  setEnv('OYS_DB_POOL_SIZE', saved.size);
  setEnv('OYS_DB_STRICT', saved.strict);
});
after(closePool);

const limit = (): number => (getPool() as unknown as { pool: { config: { connectionLimit: number } } }).pool.config.connectionLimit;

// Fehlschlag statt Hängen: eine Arbeit muss in dieser Zeit fertig sein
async function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still waiting after ${ms} ms (pool deadlock?)`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

test('OYS_DB_POOL_SIZE sets the pool size; invalid values keep the configured size', async () => {
  setEnv('OYS_DB_POOL_SIZE', '1');
  await closePool();
  assert.equal(limit(), 1);
  for (const bad of ['0', '-1', 'x', '1.5', '100', '']) {
    await closePool();
    setEnv('OYS_DB_POOL_SIZE', bad);
    assert.equal(limit(), 10, `value ${JSON.stringify(bad)}`);
  }
});

test('with a pool of one, nested sections reuse the held connection and finish', async () => {
  setEnv('OYS_DB_POOL_SIZE', '1');
  setEnv('OYS_DB_STRICT', '1');
  await closePool();
  const out = await within(2000, withConnection(async (db) => {
    const id = await db.value('SELECT CONNECTION_ID()');
    // Abfragen über den Pool, eine verschachtelte Transaktion und ein zweiter Abschnitt – alles auf derselben Verbindung
    const viaPool = await value('SELECT CONNECTION_ID()');
    const inTx = await transaction(async (_conn, tx) => tx.value('SELECT CONNECTION_ID()'));
    const nested = await withConnection((inner) => inner.value('SELECT CONNECTION_ID()'));
    const parallel = await Promise.all([q('SELECT CONNECTION_ID() AS c'), q('SELECT CONNECTION_ID() AS c')]);
    return [id, viaPool, inTx, nested, parallel[0][0].c, parallel[1][0].c];
  }));
  assert.equal(new Set(out).size, 1);
  // Zwei getrennte Abläufe warten beim Pool von eins aufeinander – ohne Fehler
  const both = await within(2000, Promise.all([
    withConnection(async (db) => {
      await sleep(50);
      return db.value('SELECT 1');
    }),
    value('SELECT 2'),
  ]));
  assert.deepEqual(both.map(Number), [1, 2]);
});

test('the strict guard fires when code that holds a connection asks the pool for another one', async () => {
  setEnv('OYS_DB_POOL_SIZE', '1');
  setEnv('OYS_DB_STRICT', '1');
  await closePool();
  await within(2000, withConnection(async () => {
    await assert.rejects(outsidePinned(() => q('SELECT 1')), NestedConnectionError);
    await assert.rejects(outsidePinned(() => transaction(async () => 1)), NestedConnectionError);
    assert.throws(() => getPool(), NestedConnectionError);
  }));
  await within(2000, transaction(async () => {
    await assert.rejects(outsidePinned(() => withConnection(async () => 1)), NestedConnectionError);
  }));
  // Außerhalb eines Abschnitts ist alles erlaubt
  assert.equal(Number(await value('SELECT 3')), 3);
  assert.equal(limit(), 1);
});

test('work that outlives its section may take a new connection, also in strict mode', async () => {
  setEnv('OYS_DB_STRICT', '1');
  await closePool();
  let later: Promise<unknown> = Promise.resolve();
  await withConnection(async () => {
    // Läuft weiter, nachdem der Abschnitt seine Verbindung zurückgegeben hat (z. B. Aufräumen nach einem Commit)
    later = (async () => {
      await sleep(30);
      return value('SELECT 4');
    })();
  });
  assert.equal(Number(await within(2000, later)), 4);
});

test('without the strict switch a deliberate second connection still works', async () => {
  setEnv('OYS_DB_POOL_SIZE', '2');
  delete process.env.OYS_DB_STRICT;
  await closePool();
  const ids = await within(2000, withConnection(async (db) => {
    const mine = await db.value('SELECT CONNECTION_ID()');
    const other = await outsidePinned(() => value('SELECT CONNECTION_ID()'));
    return [mine, other];
  }));
  assert.notEqual(ids[0], ids[1]);
});
