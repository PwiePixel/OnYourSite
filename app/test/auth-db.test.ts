// Registrierung mit der Datenbank: die Begrüßungs-Mail (in den HTTP-Vergleichen gibt es keinen SMTP-Server) bekommt
// dieselben Werte wie in PHP (e() auf Name und Adresse, in dieser Reihenfolge), ihr Ergebnis zählt nicht, und ein
// Fehler darin ist kein Datenbankfehler: die Anfrage endet wie in PHP mit 500, das Konto ist dann schon angelegt.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { ROOT_DIR, configString, loadConfig, setConfigForTests } from '../src/config.js';
import { closePool, q } from '../src/db.js';
import { makeTestCtx, isHalt, type Ctx } from '../src/web/ctx.js';
import { register, setAuthMailerForTests } from '../src/app/auth.js';
import type { PhpArray } from '../src/php.js';

const BASE = loadConfig();
const SOURCE = configString('db.name');
const DB = SOURCE + '_authmail';
let admin: Connection;

before(async () => {
  admin = await mysql.createConnection({ host: configString('db.host', 'localhost'), user: configString('db.user', ''), password: configString('db.pass', ''), charset: 'utf8mb4_unicode_ci' });
  const [tables] = await admin.query<RowDataPacket[]>(`SHOW TABLES FROM \`${SOURCE}\``);
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  for (const row of tables) {
    const t = String(Object.values(row)[0]);
    await admin.query(`CREATE TABLE \`${DB}\`.\`${t}\` LIKE \`${SOURCE}\`.\`${t}\``);
    await admin.query(`INSERT INTO \`${DB}\`.\`${t}\` SELECT * FROM \`${SOURCE}\`.\`${t}\``);
  }
  // Zähler der Begrenzungen aus früheren Läufen (z. B. 50 Registrierungen je Stunde) dürfen hier nichts sperren
  await admin.query(`DELETE FROM \`${DB}\`.rate_limits`);
  await closePool();
  setConfigForTests({ ...BASE, db: { ...(BASE.db as Record<string, string>), name: DB } });
});

after(async () => {
  setAuthMailerForTests(undefined);
  await closePool();
  setConfigForTests(BASE);
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.end();
});

// Eine Anfrage an register() wie über den Server: Ende mit exit (Halt), Sitzung danach speichern
async function call(ctx: Ctx): Promise<Ctx> {
  try {
    await register(ctx);
  } catch (err) {
    if (!isHalt(err)) throw err;
  } finally {
    await ctx.session?.close();
  }
  return ctx;
}

// Formular holen (Sitzung mit Token), dann absenden
async function signUp(post: PhpArray, ip: string): Promise<Ctx> {
  const page = await call(makeTestCtx({ url: '/register', ip }));
  const token = /name="csrf" value="([0-9a-f]{64})"/.exec(String(page.body))![1];
  return makeTestCtx({ method: 'POST', url: '/register', ip, cookies: { PHPSESSID: page.session!.id }, post: { ...post, csrf: token } });
}

// Eindeutige Namen: die Testdatenbank ist eine Kopie des aktuellen Stands (dort kann es max-page schon geben)
const RUN = String(Date.now() % 1e8);
const e = (s: string): string => execFileSync('php', ['-r', `require '${ROOT_DIR}/lib/helpers.php'; echo e(stream_get_contents(STDIN));`], { input: s }).toString();

test('register sends the welcome mail with escaped values and ignores its result', async () => {
  const calls: unknown[][] = [];
  setAuthMailerForTests(async (...args) => { calls.push(args); return false; });
  const fullname = `  <b>Zoë</b> & "Co" 'x'  `;
  const ctx = await call(await signUp({ fullname, email: ` Max${RUN}@Example.COM `, password: 'secret123', subdomain: `Max-${RUN}` }, '10.1.2.3'));
  assert.equal(ctx.header('Location'), '/dashboard', String(ctx.session?.data.error));
  assert.equal(ctx.status, 302);
  assert.deepEqual(calls, [[`max${RUN}@example.com`, 'register', { full_name: e(`<b>Zoë</b> & "Co" 'x'`), subdomain: `max-${RUN}` }]]);
  // Reihenfolge der Platzhalter wie im PHP-Array: erst full_name, dann subdomain
  assert.deepEqual(Object.keys(calls[0][2] as object), ['full_name', 'subdomain']);
  // Angemeldet als das neue Konto mit der neuen Seite
  const user = (await q('SELECT id, email, full_name, username FROM users WHERE email = ?', [`max${RUN}@example.com`]))[0];
  const page = (await q('SELECT id FROM pages WHERE user_id = ?', [user.id as number]))[0];
  assert.deepEqual(ctx.session!.data, { csrf: ctx.session!.data.csrf, user_id: user.id, page_id: page.id, success: 'Welcome! Your page is live.' });
});

test('an error inside the mail call ends the request like PHP (no PDOException, account already created)', async () => {
  setAuthMailerForTests(async () => { throw new TypeError('Cannot access offset of type string on string'); });
  const ctx = await signUp({ fullname: 'Typo Mail', email: `typo${RUN}@example.com`, password: 'secret123', subdomain: `typo-${RUN}` }, '10.1.2.4');
  await assert.rejects(call(ctx), TypeError);
  assert.equal((await q('SELECT COUNT(*) AS n FROM users WHERE email = ?', [`typo${RUN}@example.com`]))[0].n, 1);
  // Die Sitzung ist trotzdem gespeichert (wie PHP am Ende des Skripts): angemeldet als das neue Konto
  assert.equal(ctx.session!.data.user_id, (await q('SELECT id FROM users WHERE email = ?', [`typo${RUN}@example.com`]))[0].id);
});

test('without a mail module nothing is sent and the sign-up still succeeds', async () => {
  setAuthMailerForTests(null);
  const ctx = await call(await signUp({ fullname: 'No Mail', email: `nomail${RUN}@example.com`, password: 'secret123', subdomain: `nomail-${RUN}` }, '10.1.2.5'));
  assert.equal(ctx.header('Location'), '/dashboard', String(ctx.session?.data.error));
  assert.equal(ctx.status, 302);
});
