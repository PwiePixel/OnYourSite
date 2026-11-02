// Seitenplätze mit einem Pool von EINER Verbindung und dem strengen Schalter: Wer innerhalb der Platz-Sperre eine
// zweite Verbindung verlangt, fällt sofort auf (mit einer Verbindung hinge er sonst für immer). Jede Änderung muss in
// unter 2 s fertig sein; die Wartezeit für Sperren (3 s) ist danach wieder die übliche.
process.env.OYS_DB_POOL_SIZE = '1';
process.env.OYS_DB_STRICT = '1';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { value } from '../src/db.js';
import { makeTestCtx } from '../src/web/ctx.js';
import { dispatch } from '../src/router.js';
import { appRoutes } from '../src/app/dispatch.js';
import { createPage } from '../src/content/pages.js';
import { deleteAccount } from '../src/admin/accountDeletion.js';
import { SLOT_BUSY_TEXT } from '../src/code/slots.js';
import { CSRF, adminConnection, loginSession, runRequest, testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
const q = async (s: string, p: unknown[] = []): Promise<RowDataPacket[]> => (await t.admin.query<RowDataPacket[]>(s, p))[0];
const HOST = 'oys.test:8080';

before(async () => {
  t = await testDatabase('cs3pool');
  await t.admin.query('USE `' + t.name + '`');
});

after(async () => {
  await t.done();
});

async function api(userId: number, action: string, json: unknown): Promise<Record<string, unknown>> {
  const sid = await loginSession(userId);
  const ctx = makeTestCtx({
    method: 'POST', url: '/dashboard/api/' + action, host: HOST, cookies: { PHPSESSID: sid },
    headers: { 'content-type': 'application/json', 'x-csrf-token': CSRF }, rawBody: Buffer.from(JSON.stringify(json)),
  });
  await runRequest(ctx, appRoutes);
  return JSON.parse(String(ctx.body)) as Record<string, unknown>;
}

// Dauer einer Anfrage in ms
async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const started = Date.now();
  const out = await fn();
  return [out, Date.now() - started];
}

test('page-create, serving a code slot and deleting it run on one connection in well under 2 s', async () => {
  const [created, ms1] = await timed(() => api(6, 'page-create', { slug: 'tom-pool', title: 'Pool' }));
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.ok(ms1 < 2000, 'page-create took ' + ms1 + ' ms');
  const pageId = Number(created.id);

  // Der neue Platz zeigt eine Code-Seite (mit einem Bild aus den Uploads)
  const img = 'img_6_1700000200_abcdef01.png';
  writeFileSync(join(t.uploads, img), 'x');
  const site = ((await t.admin.query("INSERT INTO code_sites (user_id, slug, title, file_count, bytes, created_at, updated_at) VALUES (6, NULL, 'Pool', 1, 30, NOW(), NOW())"))[0] as { insertId: number }).insertId;
  await q("INSERT INTO code_files (site_id, path, content, updated_at) VALUES (?, 'index.html', ?, NOW())", [site, `<p>pool</p><img src="${img}">`]);
  await q('UPDATE pages SET code_site_id = ? WHERE id = ?', [site, pageId]);

  const [served, ms2] = await timed(() => runRequest(makeTestCtx({ url: '/', host: 'tom-pool.' + HOST }), dispatch));
  assert.equal(served.status, 200);
  assert.match(String(served.body), /<p>pool<\/p>/);
  assert.ok(ms2 < 2000, 'serving took ' + ms2 + ' ms');

  const [deleted, ms3] = await timed(() => api(6, 'page-delete', { id: pageId, confirm: 'tom-pool' }));
  assert.deepEqual(deleted, { ok: true });
  assert.ok(ms3 < 2000, 'page-delete took ' + ms3 + ' ms');
  assert.equal(Number((await q('SELECT COUNT(*) AS n FROM code_sites WHERE id = ?', [site]))[0].n), 0);
  assert.ok(!existsSync(join(t.uploads, img)), 'the upload only the deleted code page used is gone');
});

test('deleting an account with code slots runs on one connection', async () => {
  const pageId = await createPage(7, 'lea-pool', 'Lea pool');
  const site = ((await t.admin.query("INSERT INTO code_sites (user_id, slug, title, created_at, updated_at) VALUES (7, NULL, 'L', NOW(), NOW())"))[0] as { insertId: number }).insertId;
  await q('UPDATE pages SET code_site_id = ? WHERE id = ?', [site, pageId]);
  await q("INSERT INTO code_sites (user_id, slug, title, created_at, updated_at) VALUES (7, 'lea-own', 'L2', NOW(), NOW())");
  const [, ms] = await timed(() => deleteAccount(null, 7));
  assert.ok(ms < 2000, 'deleting took ' + ms + ' ms');
  assert.equal(Number((await q('SELECT COUNT(*) AS n FROM code_sites WHERE user_id = 7'))[0].n), 0);
  assert.equal(Number((await q('SELECT COUNT(*) AS n FROM users WHERE id = 7'))[0].n), 0);
});

test('a busy account lock answers after about 3 s, and the one connection gets its normal lock wait back', async () => {
  const before = Number(await value('SELECT @@SESSION.innodb_lock_wait_timeout'));
  const other: Connection = await adminConnection();
  try {
    await other.query('USE `' + t.name + '`');
    await other.query('START TRANSACTION');
    await other.query('SELECT id FROM users WHERE id = 6 FOR UPDATE');
    const [res, ms] = await timed(() => api(6, 'page-create', { slug: 'tom-wait', title: 'x' }));
    assert.deepEqual(res, { ok: false, error: SLOT_BUSY_TEXT, busy: true });
    assert.ok(ms >= 2500 && ms < 15000, 'waited ' + ms + ' ms');
    await other.query('ROLLBACK');
  } finally {
    await other.end();
  }
  assert.equal(Number(await value('SELECT @@SESSION.innodb_lock_wait_timeout')), before);
  assert.notEqual(before, 3);
});
