// Benachrichtigungen: notify()/notifyAdmins() (Kürzen nach Codepunkten, sichere Ziele, eigene Transaktion des
// Aufrufers), der Katalog der Typen, Hinweise in Antworten und die Glocke der Editor-API (Schlüssel, „gelesen bis“,
// Nutzer-Modus eines Admins nur lesend, 401/419) – auch für Konten ohne Profilseite. Dazu der Index-Schritt.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { transaction } from '../src/db.js';
import { date, mbStrlen, strtotime, time } from '../src/php.js';
import { makeTestCtx, type Ctx } from '../src/web/ctx.js';
import { appRoutes } from '../src/app/dispatch.js';
import { NOTIFY_TYPES, notice, notices, notifyType, type Notice } from '../src/notify/types.js';
import { notify, notifyAdmins, safeLink } from '../src/notify/notify.js';
import { notify as legacyNotify } from '../src/content/messages.js';
import { ensureSchema, SCHEMA_VERSION, V_NOTIFICATIONS_INDEX, hasIndex } from '../src/schema.js';
import { withConnection } from '../src/db.js';
import { CSRF, jsonBody, loginSession, runRequest, testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;

before(async () => {
  t = await testDatabase('c1notify');
  await ensureSchema();
});

after(async () => {
  await t.done();
});

// Zeilen direkt lesen bzw. für Tests direkt anlegen (die Prüfregel gilt nur für app/src)
async function rowsOf(userId: number): Promise<RowDataPacket[]> {
  const [r] = await t.admin.query<RowDataPacket[]>(`SELECT * FROM \`${t.name}\`.notifications WHERE user_id = ? ORDER BY id`, [userId]);
  return r;
}
async function rawRow(userId: number, type: string, title: string, link: string | null, read = 0): Promise<number> {
  const [r] = await t.admin.query<{ insertId: number } & RowDataPacket[]>(
    `INSERT INTO \`${t.name}\`.notifications (user_id, type, title, body, link, is_read, created_at) VALUES (?, ?, ?, '', ?, ?, ?)`,
    [userId, type, title, link, read, date('Y-m-d H:i:s')]);
  return (r as unknown as { insertId: number }).insertId;
}
async function clear(userId: number): Promise<void> {
  await t.admin.query(`DELETE FROM \`${t.name}\`.notifications WHERE user_id = ?`, [userId]);
}

// ---------------------------------------------------------------- reine Regeln

test('safeLink keeps own relative paths and drops everything else', () => {
  const ok = ['/dashboard#messages', '/dashboard#honeycombs/premium', '/suggestions?x=1', '/dashboard?page=12#settings/domain',
    '/dashboard?site=4#code', '/admin#honeycombs', '/dashboard#status/system', '/', '/a/b.c~d_e-f%20?q=1&r=2', '/x?u=//host'];
  for (const l of ok) assert.equal(safeLink(l), l, l);
  const bad = ['', 'dashboard', '//evil.test', '///evil.test', 'https://x', 'http://on-your.site/dashboard', 'javascript:alert(1)',
    '/\\evil.example', '/\\\\evil', '/dash board', '/a\nb', '/a\rb', '/a\tb', '/a\u0000', '/ä', '/dashboard#status:system',
    '/.//evil.example', '/a//b', '/./x', '/../x', '/a/..', '/a/.', '/%2e%2e/x', '/%2E./x', '/x/.%2e', '/x"y', "/x'y", '/x<y', '/x(y)',
    '/' + 'a'.repeat(255), 5, null, undefined, ['/a'], { toString: () => '/a' }];
  for (const l of bad) assert.equal(safeLink(l), '', JSON.stringify(l));
  assert.equal(safeLink('/' + 'a'.repeat(254)), '/' + 'a'.repeat(254));
  // Drei Punkte sind kein Punkt-Segment
  assert.equal(safeLink('/a/.../b'), '/a/.../b');
});

test('the type catalogue has every agreed row; lookup is exact, then the prefix, then the bell', () => {
  const expected: Record<string, [string, string, string]> = {
    message: ['bx-envelope', 'info', '/dashboard#messages'],
    booking: ['bx-calendar-check', 'info', '/dashboard#messages'],
    honeycombs: ['bx-hive', 'hc', '/dashboard#honeycombs'],
    unlock: ['bx-hive', 'hc', '/dashboard#honeycombs'],
    code: ['bx-code-alt', 'warn', '/dashboard#code'],
    domain: ['bx-globe', 'info', '/dashboard#settings'],
    domain_live: ['bx-globe', 'ok', '/dashboard#settings'],
    domain_back: ['bx-globe', 'ok', '/dashboard#settings'],
    domain_problem: ['bx-globe', 'warn', '/dashboard#settings'],
    domain_paused: ['bx-globe', 'warn', '/dashboard#settings'],
    domain_removed: ['bx-globe', 'warn', '/dashboard#settings'],
    status: ['bx-pulse', 'warn', '/dashboard#status'],
    status_down: ['bx-pulse', 'err', '/dashboard#status'],
    status_up: ['bx-pulse', 'ok', '/dashboard#status'],
    status_team: ['bx-shield-quarter', 'warn', '/dashboard#status'],
    team: ['bx-shield-quarter', 'warn', '/admin'],
    system: ['bx-bell', 'info', ''],
  };
  assert.deepEqual(Object.keys(NOTIFY_TYPES).sort(), Object.keys(expected).sort());
  for (const [type, [icon, tone, link]] of Object.entries(expected)) {
    assert.deepEqual(notifyType(type), { icon, tone, link }, type);
    // Jedes Standard-Ziel besteht selbst die Prüfung (oder ist leer)
    assert.equal(safeLink(link), link);
    assert.match(icon, /^bx[sl]?-[a-z0-9-]+$/);
  }
  assert.deepEqual(notifyType('domain_new'), NOTIFY_TYPES.domain);
  assert.deepEqual(notifyType('status_whatever'), NOTIFY_TYPES.status);
  for (const unknown of ['nothing', 'toString', '__proto__', 'constructor', '', 'message_', null, 7]) {
    const look = notifyType(unknown);
    if (unknown === 'message_') assert.deepEqual(look, NOTIFY_TYPES.message);
    else assert.deepEqual(look, { icon: 'bx-bell', tone: 'info', link: '' }, String(unknown));
  }
});

test('notices are cut by code points, checked and limited per answer', () => {
  const long = '🐝'.repeat(250);
  const n = notice({ tone: 'hc', text: long, title: 'é'.repeat(100), amount: 50, action: { label: 'x'.repeat(60), link: '/dashboard#honeycombs/premium' } });
  assert.ok(n);
  assert.equal(mbStrlen(n.text), 200);
  assert.equal(mbStrlen(n.title ?? ''), 80);
  assert.equal(n.amount, 50);
  assert.deepEqual(n.action, { label: 'x'.repeat(40), link: '/dashboard#honeycombs/premium' });
  assert.deepEqual(notice({ tone: 'nope' as never, text: ' Saved ', action: { label: 'Open', link: 'https://evil.test' } }), { tone: 'info', text: 'Saved' });
  assert.deepEqual(notice({ tone: 'ok', text: 'a', amount: 1.5 }), { tone: 'ok', text: 'a' });
  assert.equal(notice({ tone: 'ok', text: '   ' }), null);
  const many: Notice[] = Array.from({ length: 6 }, (_, i) => ({ tone: 'ok', text: i === 0 ? '' : 'n' + i }));
  assert.deepEqual(notices(many).map((x) => x.text), ['n1', 'n2', 'n3']);
  assert.equal(notices(many, 12).length, 5);
});

// ---------------------------------------------------------------- Schreiben

test('notify() cuts title and body by code points, keeps an empty body, checks the link and stamps local time', async () => {
  await clear(6);
  const title = '🐝'.repeat(189) + 'éxyz'; // 189 Emojis + e + kombinierender Akzent + …
  const body = 'ü'.repeat(254) + '😀😀';
  await notify(6, 'honeycombs', title, body, '/dashboard#honeycombs/premium');
  await notify(6, 'system', 'Address changed', '', '//evil.test/phish');
  await legacyNotify(6, 'message', 'From the contact form', 'Hi', '/dashboard#messages');
  const rows = await rowsOf(6);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].title, '🐝'.repeat(189) + 'e');
  assert.equal(rows[0].body, 'ü'.repeat(254) + '😀');
  assert.equal(rows[0].link, '/dashboard#honeycombs/premium');
  assert.equal(rows[0].is_read, 0);
  assert.equal(rows[1].body, '');
  assert.equal(rows[1].link, '');
  assert.equal(rows[2].type, 'message');
  // created_at in der Zeitzone der Seite (wie date('Y-m-d H:i:s'))
  const at = strtotime(String(rows[0].created_at));
  assert.ok(at !== false && Math.abs(at - time()) < 5, String(rows[0].created_at));
  for (const type of ['', 'Bad', 'x'.repeat(25), 'a-b', 'a b']) {
    await assert.rejects(notify(6, type, 't'), /invalid notification type/, type);
  }
  assert.equal((await rowsOf(6)).length, 3);
});

test('notify({db}) belongs to the caller’s transaction: rolled back means no row', async () => {
  await clear(5);
  await assert.rejects(transaction(async (_conn, db) => {
    await notify(5, 'unlock', 'Premium ended', '', '/dashboard#honeycombs/premium', { db });
    assert.equal(Number(await db.value('SELECT COUNT(*) FROM notifications WHERE user_id = 5')), 1);
    throw new Error('state change failed');
  }), /state change failed/);
  assert.equal((await rowsOf(5)).length, 0);
  await transaction(async (_conn, db) => {
    await notify(5, 'unlock', 'Premium ended', '', '/dashboard#honeycombs/premium', { db });
  });
  assert.equal((await rowsOf(5)).length, 1);
});

test('a data step writes its notices with notify(…, { db: conn }) on the step’s own connection', async () => {
  // Wie ein Schritt in ensureSchema(): nur die rohe Verbindung (PoolConnection), eine eigene Transaktion darauf
  await clear(6);
  await clear(3);
  const step = (finish: 'commit' | 'rollback') => withConnection(async (_db, conn) => {
    await conn.beginTransaction();
    await notify(6, 'system', 'Your page address changed', 'Please update your links.', '/dashboard', { db: conn });
    assert.equal(await notifyAdmins('team', 'A step needs a look', '', '/admin', { db: conn }), 1);
    await (finish === 'commit' ? conn.commit() : conn.rollback());
  });
  await step('rollback');
  assert.equal((await rowsOf(6)).length, 0);
  assert.equal((await rowsOf(3)).length, 0);
  await step('commit');
  const rows = await rowsOf(6);
  assert.deepEqual(rows.map((r) => [r.type, r.title, r.body, r.link]), [['system', 'Your page address changed', 'Please update your links.', '/dashboard']]);
  assert.equal((await rowsOf(3)).length, 1);
});

test('notifyAdmins() writes one row per admin and returns the count', async () => {
  await t.admin.query(`UPDATE \`${t.name}\`.users SET is_admin = 1 WHERE id = 7`);
  try {
    await clear(3);
    await clear(7);
    const before5 = (await rowsOf(5)).length;
    assert.equal(await notifyAdmins('team', 'Integrity check found 2 problems', 'Open the honeycomb admin.', '/admin#honeycombs'), 2);
    for (const id of [3, 7]) {
      const rows = await rowsOf(id);
      assert.equal(rows.length, 1);
      assert.deepEqual([rows[0].type, rows[0].title, rows[0].link], ['team', 'Integrity check found 2 problems', '/admin#honeycombs']);
    }
    assert.equal((await rowsOf(5)).length, before5);
    // In einer Transaktion, die zurückgerollt wird: keine Zeile
    await assert.rejects(transaction(async (_conn, db) => {
      assert.equal(await notifyAdmins('team', 'x', '', '', { db }), 2);
      throw new Error('rollback');
    }));
    assert.equal((await rowsOf(3)).length, 1);
  } finally {
    await t.admin.query(`UPDATE \`${t.name}\`.users SET is_admin = 0 WHERE id = 7`);
  }
});

// ---------------------------------------------------------------- Glocke (über die Routen der Hauptseite)

async function api(o: { action: string; userId?: number | null; impersonatedBy?: number; json?: unknown; csrf?: string | null; method?: string }): Promise<Ctx> {
  const sid = o.userId === null ? null : await loginSession(o.userId ?? 8, { impersonatedBy: o.impersonatedBy });
  const post = o.method === 'POST' || o.json !== undefined;
  const headers: Record<string, string> = {};
  if (post) headers['content-type'] = 'application/json';
  if (o.csrf !== null) headers['x-csrf-token'] = o.csrf ?? CSRF;
  const ctx = makeTestCtx({
    method: post ? 'POST' : (o.method ?? 'GET'),
    url: '/dashboard/api/' + o.action,
    headers,
    cookies: sid ? { PHPSESSID: sid } : undefined,
    rawBody: post ? Buffer.from(JSON.stringify(o.json ?? {})) : undefined,
  });
  return runRequest(ctx, appRoutes);
}

test('the bell list keeps the old keys first, adds link, icon, tone and latest, and works without a page', async () => {
  // noname@test.de (8) hat keine Profilseite
  await clear(8);
  const a = await rawRow(8, 'message', 'New message from Ann', '/dashboard#messages');
  const b = await rawRow(8, 'domain_live', 'Your domain is live', 'javascript:alert(1)');
  const c = await rawRow(8, 'brand_new_kind', 'Something', '/\\evil.example', 1);
  const d = await rawRow(8, 'unlock', 'Premium ends soon', '/dashboard#honeycombs/premium');
  await rawRow(5, 'message', 'Not yours', '/dashboard#messages');
  const ctx = await api({ action: 'notifications' });
  assert.equal(ctx.status, 200);
  assert.equal(ctx.header('Cache-Control'), 'no-store');
  const res = jsonBody(ctx);
  assert.deepEqual(Object.keys(res), ['ok', 'unread', 'messages_unread', 'items', 'latest']);
  assert.equal(res.ok, true);
  assert.equal(res.unread, 3);
  assert.equal(res.messages_unread, 0);
  assert.equal(res.latest, d);
  const items = res.items as Array<Record<string, unknown>>;
  assert.deepEqual(items.map((i) => i.id), [d, c, b, a]);
  assert.deepEqual(Object.keys(items[0]), ['id', 'type', 'title', 'body', 'read', 'ago', 'link', 'icon', 'tone']);
  assert.deepEqual(items.map((i) => [i.link, i.icon, i.tone, i.read]), [
    ['/dashboard#honeycombs/premium', 'bx-hive', 'hc', false],
    ['', 'bx-bell', 'info', true], // unbekannter Typ, unsicheres Ziel
    ['/dashboard#settings', 'bx-globe', 'ok', false], // unsicheres Ziel → Ziel des Typs
    ['/dashboard#messages', 'bx-envelope', 'info', false],
  ]);
  assert.equal(typeof items[0].ago, 'string');

  // Höchstens 15, neueste zuerst; ohne Einträge latest 0
  for (let i = 0; i < 16; i++) await rawRow(8, 'system', 'n' + i, '');
  const full = jsonBody(await api({ action: 'notifications' }));
  assert.equal((full.items as unknown[]).length, 15);
  assert.equal((full.items as Array<Record<string, unknown>>)[0].title, 'n15');
  await clear(8);
  const empty = jsonBody(await api({ action: 'notifications' }));
  assert.deepEqual([empty.unread, empty.items, empty.latest], [0, [], 0]);
});

test('notifications-read: one, up to the newest seen, or all – only the own rows', async () => {
  await clear(8);
  await clear(5);
  const n1 = await rawRow(8, 'message', 'one', '');
  const n2 = await rawRow(8, 'message', 'two', '');
  const n3 = await rawRow(8, 'message', 'three', '');
  const foreign = await rawRow(5, 'message', 'foreign', '');
  const read = async (): Promise<number[]> => (await rowsOf(8)).map((r) => Number(r.is_read));

  let ctx = await api({ action: 'notifications-read', json: { id: n2 } });
  assert.deepEqual(jsonBody(ctx), { ok: true });
  assert.deepEqual(await read(), [0, 1, 0]);
  // Eine fremde Benachrichtigung bleibt ungelesen
  await api({ action: 'notifications-read', json: { id: foreign } });
  assert.equal(Number((await rowsOf(5))[0].is_read), 0);
  // „bis hier gesehen“: was danach kam, bleibt ungelesen
  const n4 = await rawRow(8, 'message', 'four (arrived after the last poll)', '');
  ctx = await api({ action: 'notifications-read', json: { upTo: n3 } });
  assert.deepEqual(jsonBody(ctx), { ok: true });
  assert.deepEqual(await read(), [1, 1, 1, 0]);
  assert.equal(Number((await rowsOf(5))[0].is_read), 0);
  // Ohne Angabe (Editor-Tabs von vor dem Update schicken nur page_id): alles
  ctx = await api({ action: 'notifications-read', json: { page_id: 1 } });
  assert.equal(ctx.status, 409); // fremde Seite: wie jede Aktion mit falscher Seite
  ctx = await api({ action: 'notifications-read', json: {} });
  assert.deepEqual(jsonBody(ctx), { ok: true });
  assert.deepEqual(await read(), [1, 1, 1, 1]);
  assert.equal(Number((await rowsOf(5))[0].is_read), 0);
  assert.ok(n1 < n4);
});

test('notifications-read refuses ids that are not positive whole numbers', async () => {
  await clear(8);
  const id = await rawRow(8, 'message', 'x', '');
  for (const json of [{ id: 0 }, { id: -1 }, { id: 1.5 }, { id: 'x' }, { id: '01' }, { id: '' }, { id: null }, { id: true }, { id: [] }, { id: {} },
    { id: 4294967296 }, { upTo: 0 }, { upTo: '1e3' }, { upTo: [id] }]) {
    const ctx = await api({ action: 'notifications-read', json });
    assert.equal(ctx.status, 400, JSON.stringify(json));
    assert.deepEqual(jsonBody(ctx), { ok: false, error: 'Unknown notification.' });
  }
  assert.equal(Number((await rowsOf(8))[0].is_read), 0);
  // Ziffern als Text gehen
  assert.deepEqual(jsonBody(await api({ action: 'notifications-read', json: { id: String(id) } })), { ok: true });
  assert.equal(Number((await rowsOf(8))[0].is_read), 1);
});

test('an admin in user mode only reads: nothing is marked as read', async () => {
  await clear(8);
  await rawRow(8, 'message', 'x', '');
  for (const json of [{}, { upTo: 999999 }]) {
    const ctx = await api({ action: 'notifications-read', json, impersonatedBy: 3 });
    assert.deepEqual(jsonBody(ctx), { ok: true, readonly: true });
  }
  assert.equal(Number((await rowsOf(8))[0].is_read), 0);
  // Lesen geht auch im Nutzer-Modus
  assert.equal(jsonBody(await api({ action: 'notifications', impersonatedBy: 3 })).unread, 1);
});

test('logged out → 401, wrong CSRF token → 419, GET on notifications-read → unknown action', async () => {
  let ctx = await api({ action: 'notifications', userId: null });
  assert.equal(ctx.status, 401);
  assert.deepEqual(jsonBody(ctx), { ok: false, error: 'Please log in again.' });
  ctx = await api({ action: 'notifications-read', userId: null, json: {} });
  assert.equal(ctx.status, 401);
  for (const csrf of [null, 'x', 'c'.repeat(63)]) {
    ctx = await api({ action: 'notifications-read', json: {}, csrf });
    assert.equal(ctx.status, 419, String(csrf));
    assert.deepEqual(jsonBody(ctx), { ok: false, error: 'Session expired – please reload the page.' });
  }
  ctx = await api({ action: 'notifications-read', method: 'GET' });
  // Ohne Profilseite kommt wie bisher zuerst „Create a page first.“, mit Seite „Unknown action.“
  assert.equal(ctx.status, 404);
  assert.deepEqual(jsonBody(ctx), { ok: false, error: 'Create a page first.' });
  ctx = await api({ action: 'notifications-read', method: 'GET', userId: 6 });
  assert.equal(ctx.status, 404);
  assert.deepEqual(jsonBody(ctx), { ok: false, error: 'Unknown action.' });
});

test('messages, message and booking-delete work without a page and only on the own rows', async () => {
  const q = (s: string, p: unknown[] = []) => t.admin.query<RowDataPacket[]>(s.replace(/`DB`/g, '`' + t.name + '`'), p);
  await q("INSERT INTO `DB`.messages (page_id, user_id, name, email, message, created_at) VALUES (0, 8, 'n', 'e', 'm', ?)", [date('Y-m-d H:i:s')]);
  await q("INSERT INTO `DB`.messages (page_id, user_id, name, email, message, created_at) VALUES (2, 5, 'n', 'e', 'm', ?)", [date('Y-m-d H:i:s')]);
  await q("INSERT INTO `DB`.user_bookings (user_id, guest_name, guest_email, booking_date, booking_time) VALUES (8, 'g', 'e', '2026-12-01', '10:00')");
  await q("INSERT INTO `DB`.user_bookings (user_id, guest_name, guest_email, booking_date, booking_time) VALUES (5, 'g', 'e', '2026-12-01', '10:00')");
  const [[mine]] = await q('SELECT id FROM `DB`.messages WHERE user_id = 8');
  const [[theirs]] = await q('SELECT id FROM `DB`.messages WHERE user_id = 5');
  const [[myBooking]] = await q('SELECT id FROM `DB`.user_bookings WHERE user_id = 8');
  const [[theirBooking]] = await q('SELECT id FROM `DB`.user_bookings WHERE user_id = 5');

  const list = jsonBody(await api({ action: 'messages' }));
  assert.equal(list.ok, true);
  assert.deepEqual((list.messages as Array<Record<string, unknown>>).map((m) => m.id), [mine.id]);
  assert.deepEqual((list.bookings as Array<Record<string, unknown>>).map((b) => b.id), [myBooking.id]);
  // Unread count der Glocke zählt die Nachricht mit
  assert.equal(jsonBody(await api({ action: 'notifications' })).messages_unread, 1);

  assert.deepEqual(jsonBody(await api({ action: 'message', json: { id: mine.id, action: 'read' } })), { ok: true });
  assert.deepEqual(jsonBody(await api({ action: 'message', json: { id: theirs.id, action: 'delete' } })), { ok: true });
  assert.deepEqual(jsonBody(await api({ action: 'booking-delete', json: { id: theirBooking.id } })), { ok: true });
  assert.equal((await q('SELECT is_read FROM `DB`.messages WHERE id = ?', [mine.id]))[0][0].is_read, 1);
  assert.equal((await q('SELECT COUNT(*) AS n FROM `DB`.messages WHERE id = ?', [theirs.id]))[0][0].n, 1);
  assert.equal((await q('SELECT COUNT(*) AS n FROM `DB`.user_bookings WHERE id = ?', [theirBooking.id]))[0][0].n, 1);
  assert.deepEqual(jsonBody(await api({ action: 'booking-delete', json: { id: myBooking.id } })), { ok: true });
  assert.deepEqual(jsonBody(await api({ action: 'message', json: { id: mine.id, action: 'delete' } })), { ok: true });
  assert.equal((await q('SELECT COUNT(*) AS n FROM `DB`.user_bookings WHERE id = ?', [myBooking.id]))[0][0].n, 0);
  assert.equal((await q('SELECT COUNT(*) AS n FROM `DB`.messages WHERE id = ?', [mine.id]))[0][0].n, 0);
  // Seitenbezogene Aktionen brauchen weiterhin eine Seite
  assert.deepEqual(jsonBody(await api({ action: 'stats' })), { ok: false, error: 'Create a page first.' });
});

// ---------------------------------------------------------------- Index-Schritt

test('the index step adds idx_user_id once; running it again changes nothing and keeps the rows', async () => {
  const has = (): Promise<boolean> => withConnection((_db, conn) => hasIndex(conn, 'notifications', 'idx_user_id'));
  assert.equal(await has(), true);
  const [[before]] = await t.admin.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${t.name}\`.notifications`);
  // Den Schritt noch einmal laufen lassen (Version zurückgesetzt, Index schon da)
  await t.admin.query(`REPLACE INTO \`${t.name}\`.oys_meta (meta_key, meta_value) VALUES ('schema_version', ?)`, [String(V_NOTIFICATIONS_INDEX - 1)]);
  await ensureSchema();
  await ensureSchema();
  assert.equal(await has(), true);
  const [idx] = await t.admin.query<RowDataPacket[]>(`SHOW INDEX FROM \`${t.name}\`.notifications WHERE Key_name = 'idx_user_id'`);
  assert.deepEqual(idx.map((r) => r.Column_name), ['user_id', 'id']);
  const [[after]] = await t.admin.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${t.name}\`.notifications`);
  assert.equal(after.n, before.n);
  const [[v]] = await t.admin.query<RowDataPacket[]>(`SELECT meta_value FROM \`${t.name}\`.oys_meta WHERE meta_key = 'schema_version'`);
  assert.equal(v.meta_value, String(SCHEMA_VERSION));
  // Ohne den Index (Datenbank auf dem Stand davor) legt der Schritt ihn an
  await t.admin.query(`ALTER TABLE \`${t.name}\`.notifications DROP INDEX idx_user_id`);
  await t.admin.query(`REPLACE INTO \`${t.name}\`.oys_meta (meta_key, meta_value) VALUES ('schema_version', ?)`, [String(V_NOTIFICATIONS_INDEX - 1)]);
  await ensureSchema();
  assert.equal(await has(), true);
});
