// Konto löschen: alles oder nichts. Alle Haken laufen in einer Transaktion auf einer Verbindung (hier mit einem Pool
// von EINER Verbindung und dem strengen Schalter – eine zweite Verbindung würde sofort auffallen), die Dateien werden
// erst nach dem Commit entfernt, und ein fehlschlagender Haken lässt jede Zeile und jede Datei, wo sie war.
process.env.OYS_DB_POOL_SIZE = '1';
process.env.OYS_DB_STRICT = '1';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RowDataPacket } from 'mysql2/promise';
import { one } from '../src/db.js';
import { makeTestCtx } from '../src/web/ctx.js';
import { Session } from '../src/web/session.js';
import { adminPage } from '../src/admin/page.js';
import {
  AccountDeletionError, deleteAccount, registerUserDeletion, unregisterUserDeletionForTests, userDeletionHooks,
} from '../src/admin/accountDeletion.js';
import { deleteUser } from '../src/admin/users.js';
import { ensureSchema } from '../src/schema.js';
import { CSRF, loginSession, runRequest, testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
const NOW = '2026-11-01 10:00:00';
// Tabellen mit Daten eines Kontos (user_id) bzw. einer Seite (page_id)
const USER_TABLES = ['users:id', 'pages:user_id', 'notifications:user_id', 'messages:user_id', 'user_links:user_id', 'user_bookings:user_id',
  'user_certificates:user_id', 'code_sites:user_id', 'honeycomb_ledger:user_id'];
const PAGE_TABLES = ['page_blocks', 'stats_daily', 'block_clicks_daily'];

const file = (kind: string, uid: number, n: number, ext = 'webp'): string => `${kind}_${uid}_${1700000000 + n}_${(0xabcdef10 + n).toString(16)}.${ext}`;

// Ein Konto mit allem, was dazugehören kann; die Dateien liegen im Upload-Ordner des Tests
async function seed(uid: number, pageId: number): Promise<string[]> {
  const sql = (s: string, p: unknown[]) => t.admin.query(s.replace(/`DB`/g, '`' + t.name + '`'), p);
  const avatar = file('avatar', uid, 1);
  const image = file('img', uid, 2);
  const code = file('code', uid, 3, 'png');
  await sql('UPDATE `DB`.pages SET avatar = ? WHERE id = ?', [avatar, pageId]);
  await sql("INSERT INTO `DB`.page_blocks (page_id, type, position, data, created_at) VALUES (?, 'image', 0, ?, ?)", [pageId, JSON.stringify({ src: image }), NOW]);
  const [blocks] = await t.admin.query<RowDataPacket[]>(`SELECT id FROM \`${t.name}\`.page_blocks WHERE page_id = ?`, [pageId]);
  await sql("INSERT INTO `DB`.stats_daily (page_id, day, views, clicks) VALUES (?, '2026-10-30', 5, 1)", [pageId]);
  await sql("INSERT INTO `DB`.block_clicks_daily (block_id, item, day, page_id, clicks) VALUES (?, '', '2026-10-30', ?, 1)", [blocks[0].id, pageId]);
  await sql("INSERT INTO `DB`.messages (page_id, user_id, name, email, message, created_at) VALUES (?, ?, 'n', 'e', 'm', ?)", [pageId, uid, NOW]);
  await sql("INSERT INTO `DB`.notifications (user_id, type, title, body, link, created_at) VALUES (?, 'message', 'Hi', '', '/dashboard#messages', ?)", [uid, NOW]);
  await sql("INSERT INTO `DB`.user_links (user_id, title, url) VALUES (?, 'x', 'https://example.com')", [uid]);
  await sql("INSERT INTO `DB`.user_bookings (user_id, guest_name, guest_email, booking_date, booking_time) VALUES (?, 'g', 'e', '2026-12-01', '10:00')", [uid]);
  await sql("INSERT INTO `DB`.user_certificates (user_id, title) VALUES (?, 'c')", [uid]);
  await sql("INSERT INTO `DB`.code_sites (user_id, slug, title, created_at, updated_at) VALUES (?, ?, 't', ?, ?)", [uid, 'code' + uid, NOW, NOW]);
  const [sites] = await t.admin.query<RowDataPacket[]>(`SELECT id FROM \`${t.name}\`.code_sites WHERE user_id = ?`, [uid]);
  await sql("INSERT INTO `DB`.code_files (site_id, path, content, updated_at) VALUES (?, 'index.html', ?, ?)", [sites[0].id, `<img src="/static/uploads/${code}">`, NOW]);
  await sql("INSERT INTO `DB`.honeycomb_ledger (user_id, amount, reason, ref, created_at) VALUES (?, 100, 'grant', ?, ?)", [uid, 'g' + uid, NOW]);
  for (const f of [avatar, image, code]) writeFileSync(join(t.uploads, f), 'x');
  return [avatar, image, code];
}

async function counts(uid: number, pageId: number): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const spec of USER_TABLES) {
    const [table, col] = spec.split(':');
    const [[r]] = await t.admin.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${t.name}\`.${table} WHERE ${col} = ?`, [uid]);
    out[table] = Number(r.n);
  }
  for (const table of PAGE_TABLES) {
    const [[r]] = await t.admin.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${t.name}\`.${table} WHERE page_id = ?`, [pageId]);
    out[table] = Number(r.n);
  }
  const [[f]] = await t.admin.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${t.name}\`.code_files f JOIN \`${t.name}\`.code_sites s ON s.id = f.site_id WHERE s.user_id = ?`, [uid]);
  out.code_files = Number(f.n);
  return out;
}

let tomFiles: string[] = [];
let miaFiles: string[] = [];
let leaFiles: string[] = [];

before(async () => {
  t = await testDatabase('c1del');
  // Die Haken der Funktionen erwarten ihre Tabellen (z. B. die des Honigwaben-Shops)
  await ensureSchema();
  tomFiles = await seed(6, 3);
  miaFiles = await seed(5, 2);
  leaFiles = await seed(7, 4);
});

after(async () => {
  await t.done();
});

test('the core hooks run in the agreed order; names are unique', () => {
  assert.deepEqual(userDeletionHooks(), [
    { name: 'status', order: 20 }, { name: 'beta', order: 25 }, { name: 'code', order: 30 }, { name: 'honeycombs', order: 40 }, { name: 'pages', order: 50 }, { name: 'account data', order: 60 }, { name: 'addresses', order: 70 }, { name: 'user', order: 99 },
  ]);
  assert.throws(() => registerUserDeletion({ name: 'pages', order: 51, run: async () => undefined }), /registered twice/);
  assert.throws(() => registerUserDeletion({ name: 'Bad Name!', order: 1, run: async () => undefined }), /invalid/);
  assert.throws(() => registerUserDeletion({ name: 'half', order: 1.5, run: async () => undefined }), /integer order/);
  registerUserDeletion({ name: 'test-between', order: 40, run: async () => undefined });
  registerUserDeletion({ name: 'test-tie', order: 50, run: async () => undefined });
  try {
    assert.deepEqual(userDeletionHooks().map((h) => h.name), ['status', 'beta', 'code', 'honeycombs', 'test-between', 'pages', 'test-tie', 'account data', 'addresses', 'user']);
  } finally {
    unregisterUserDeletionForTests('test-between');
    unregisterUserDeletionForTests('test-tie');
  }
});

test('a failing hook leaves every row and every file in place', async () => {
  const before = await counts(6, 3);
  assert.ok(Object.values(before).every((n) => n >= 1), JSON.stringify(before));
  const ran: string[] = [];
  // Läuft nach den Seiten (die sind in der Transaktion schon gelöscht) und vor den Kontodaten
  registerUserDeletion({
    name: 'test-fails',
    order: 55,
    run: async (db, uid, deletion) => {
      ran.push('fails');
      assert.equal(Number(await db.value('SELECT COUNT(*) FROM pages WHERE user_id = ?', [uid])), 0);
      deletion.afterCommit(() => void ran.push('after-commit'));
      throw new Error('disk on fire');
    },
  });
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
  try {
    const err = await deleteAccount(null, 6).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof AccountDeletionError);
    assert.equal(err.hook, 'test-fails');
  } finally {
    console.error = orig;
    unregisterUserDeletionForTests('test-fails');
  }
  assert.deepEqual(ran, ['fails']);
  assert.deepEqual(await counts(6, 3), before);
  for (const f of tomFiles) assert.ok(existsSync(join(t.uploads, f)), f);
  assert.ok(logged.some((l) => l.includes('#6') && l.includes('rolled back') && l.includes('test-fails')), logged.join('\n'));
});

test('deleting an account removes all of its rows and files, after the commit, and nothing of anyone else', async () => {
  const mia = await counts(5, 2);
  const order: string[] = [];
  registerUserDeletion({
    name: 'test-observer',
    order: 98,
    run: async (db, uid, deletion) => {
      // Vor dem Commit sind die Dateien noch da, die Zeilen der früheren Haken aber schon weg
      assert.equal(Number(await db.value('SELECT COUNT(*) FROM code_sites WHERE user_id = ?', [uid])), 0);
      for (const f of tomFiles) assert.ok(existsSync(join(t.uploads, f)), f);
      deletion.afterCommit(() => void order.push('observer'));
    },
  });
  try {
    await deleteUser(6);
  } finally {
    unregisterUserDeletionForTests('test-observer');
  }
  assert.deepEqual(order, ['observer']);
  const after = await counts(6, 3);
  assert.deepEqual(Object.entries(after).filter(([, n]) => n !== 0), []);
  for (const f of tomFiles) assert.ok(!existsSync(join(t.uploads, f)), f);
  // Andere Konten bleiben unberührt
  assert.deepEqual(await counts(5, 2), mia);
  for (const f of [...miaFiles, ...leaFiles]) assert.ok(existsSync(join(t.uploads, f)), f);
  // Ein unbekanntes Konto ist kein Fehler
  await deleteAccount(null, 999999);
});

// POST /admin delete_user_id wie über den Server
async function adminDelete(id: number): Promise<Record<string, unknown>> {
  const sid = await loginSession(3);
  const ctx = makeTestCtx({ method: 'POST', url: '/admin', cookies: { PHPSESSID: sid }, post: { csrf: CSRF, delete_user_id: String(id) } });
  await Session.start(ctx);
  const user = (await one('SELECT * FROM users WHERE id = 3'))!;
  await runRequest(ctx, (c) => adminPage(c, user));
  assert.equal(ctx.status, 302);
  assert.equal(ctx.header('Location'), '/admin');
  return ctx.session!.data;
}

test('the admin sees an error and nothing is deleted when a hook fails; the next try works', async () => {
  registerUserDeletion({ name: 'test-admin-fails', order: 20, run: async () => { throw new Error('nope'); } });
  const orig = console.error;
  console.error = () => undefined;
  let data: Record<string, unknown>;
  try {
    data = await adminDelete(7);
  } finally {
    console.error = orig;
    unregisterUserDeletionForTests('test-admin-fails');
  }
  assert.equal(data.admin_error, 'The user couldn’t be deleted – please try again.');
  assert.equal(data.admin_success, undefined);
  assert.ok((await counts(7, 4)).users === 1);

  data = await adminDelete(7);
  assert.equal(data.admin_success, 'User successfully deleted.');
  assert.deepEqual(Object.entries(await counts(7, 4)).filter(([, n]) => n !== 0), []);
  for (const f of leaFiles) assert.ok(!existsSync(join(t.uploads, f)), f);
  // Das eigene Konto bleibt (unverändert)
  assert.equal((await adminDelete(3)).admin_error, 'You cannot delete your own admin account!');
});
