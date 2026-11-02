// Admin-Panel mit der Datenbank: Newsletter (die HTTP-Vergleiche haben keinen SMTP-Server – hier wird geprüft, was an
// sendCustomEmail geht), Reihenfolge der POST-Aktionen und Meldungen wie in views/admin.php.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { configString, loadConfig, setConfigForTests } from '../src/config.js';
import { closePool, one, q } from '../src/db.js';
import { ensureSchema } from '../src/schema.js';
import { makeTestCtx, isHalt, type Ctx } from '../src/web/ctx.js';
import { Session } from '../src/web/session.js';
import { adminPage } from '../src/admin/page.js';
import { setEmailDirForTests, setNewsletterMailerForTests } from '../src/admin/newsletter.js';
import { phpTruthy, type PhpArray } from '../src/php.js';

const BASE = loadConfig();
const SOURCE = configString('db.name');
const DB = SOURCE + '_admindb';
let admin: Connection;
const mailDir = mkdtempSync(join(tmpdir(), 'oys-admin-mail-'));

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
  await closePool();
  setConfigForTests({ ...BASE, db: { ...(BASE.db as Record<string, string>), name: DB } });
  // Kopie auf den Stand dieses Codes (die Quelle ist vielleicht noch nicht migriert)
  await ensureSchema();
  mkdirSync(mailDir, { recursive: true });
  setEmailDirForTests(mailDir);
});

after(async () => {
  setNewsletterMailerForTests(undefined);
  setEmailDirForTests(null);
  await closePool();
  setConfigForTests(BASE);
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.end();
  rmSync(mailDir, { recursive: true, force: true });
});

// Angemeldete Sitzung des Admins (id 3) mit CSRF-Token
async function adminSession(): Promise<{ id: string; csrf: string }> {
  const ctx = makeTestCtx({ url: '/admin' });
  const s = await Session.start(ctx);
  s.set('user_id', 3);
  s.set('csrf', 'c'.repeat(64));
  await s.close();
  return { id: s.id, csrf: 'c'.repeat(64) };
}

// POST /admin wie über den Server: Ende mit exit (Halt), Sitzung danach speichern. Ohne session eine neue Sitzung.
async function post(form: PhpArray, withCsrf = true, session?: { id: string; csrf: string }): Promise<Ctx> {
  const s = session ?? (await adminSession());
  const ctx = makeTestCtx({ method: 'POST', url: '/admin', cookies: { PHPSESSID: s.id }, post: withCsrf ? { csrf: s.csrf, ...form } : form });
  await Session.start(ctx);
  const user = (await one('SELECT * FROM users WHERE id = 3'))!;
  try {
    await adminPage(ctx, user);
  } catch (err) {
    if (!isHalt(err)) throw err;
  } finally {
    await ctx.session?.close();
  }
  return ctx;
}

type Call = [unknown, string, Record<string, unknown>, unknown];
function capture(result: boolean | ((n: number) => boolean)): Call[] {
  const calls: Call[] = [];
  setNewsletterMailerForTests(async (to, template, vars, subject) => {
    calls.push([to, template, vars, subject]);
    return typeof result === 'function' ? result(calls.length) : result;
  });
  return calls;
}

test('newsletter to all users: raw values, subdomain fallback, one call per user in database order', async () => {
  await q("UPDATE users SET full_name = '<b>Mia</b> & \"Co\"' WHERE id = 5");
  const calls = capture(true);
  const ctx = await post({ send_newsletter: '1', template_file: 'welcome.json', email_subject: '  Hello  ', audience: 'all' });
  assert.equal(ctx.status, 302);
  assert.equal(ctx.header('Location'), '/admin');
  const users = await q('SELECT email, full_name, username FROM users');
  assert.deepEqual(calls, users.map((u) => [u.email, 'welcome', { full_name: u.full_name, subdomain: phpTruthy(u.username) ? u.username : 'yourname' }, 'Hello']));
  assert.ok(calls.some((c) => c[2].full_name === '<b>Mia</b> & "Co"'));
  assert.ok(calls.some((c) => c[2].subdomain === 'yourname'));
  assert.equal(ctx.session!.data.admin_success, `Successfully sent ${users.length} email(s)!`);
  // Reihenfolge der Platzhalter wie im PHP-Array
  assert.deepEqual(Object.keys(calls[0][2]), ['full_name', 'subdomain']);
});

test('newsletter audiences and the single address (case-insensitive, "0" counts as empty)', async () => {
  let calls = capture(true);
  await post({ send_newsletter: '1', template_file: 'a.json.json', audience: 'with_domain' });
  assert.deepEqual(calls.map((c) => c[0]), (await q("SELECT email FROM users WHERE username IS NOT NULL AND username != ''")).map((r) => r.email));
  // str_replace entfernt jedes ".json"; leerer Betreff → null
  assert.equal(calls[0][1], 'a');
  assert.equal(calls[0][3], null);

  calls = capture(true);
  await post({ send_newsletter: '1', template_file: 'x', audience: 'no_domain', email_subject: '0' });
  assert.deepEqual(calls.map((c) => c[0]), (await q("SELECT email FROM users WHERE username IS NULL OR username = ''")).map((r) => r.email));
  assert.equal(calls[0][3], null);

  calls = capture(true);
  const ctx = await post({ send_newsletter: '1', template_file: 'x.json', audience: 'single', single_email: ' MIA@TEST.DE ' });
  assert.deepEqual(calls.map((c) => c[0]), ['mia@test.de']);
  assert.equal(ctx.session!.data.admin_success, 'Successfully sent 1 email(s)!');

  for (const form of [{ audience: 'single', single_email: '0' }, { audience: 'single' }, { audience: 'bogus' }, { audience: { 0: 'all' } }, { audience: 'single', single_email: 'nobody@test.de' }]) {
    calls = capture(true);
    const res = await post({ send_newsletter: '1', template_file: 'x.json', ...form } as PhpArray);
    assert.deepEqual(calls, []);
    assert.equal(res.session!.data.admin_error, 'No users found for this audience. Mail aborted.');
  }
});

test('newsletter: failures count, an array as template name becomes "Array", trim(array) ends with 500', async () => {
  let calls = capture((n) => n === 2);
  let ctx = await post({ send_newsletter: '1', template_file: 'x.json', audience: 'all' });
  assert.equal(ctx.session!.data.admin_success, 'Successfully sent 1 email(s)!');
  calls = capture(false);
  ctx = await post({ send_newsletter: '1', template_file: { 0: 'welcome.json' }, audience: 'single', single_email: 'mia@test.de' });
  assert.equal(calls[0][1], 'Array');
  assert.equal(ctx.session!.data.admin_error, 'Failed to send emails. Check the mail server settings.');
  calls = capture(true);
  await assert.rejects(post({ send_newsletter: '1', template_file: 'x.json', audience: 'all', email_subject: { 0: 'x' } }), TypeError);
  await assert.rejects(post({ send_newsletter: '1', template_file: 'x.json', audience: 'all', single_email: { 0: 'x' } }), TypeError);
  assert.deepEqual(calls, []);
});

test('POST order: storage before community before honeycombs before updates; unknown actions render the page', async () => {
  // Mehrere Felder: das erste in der Reihenfolge von admin.php gewinnt
  let ctx = await post({ storage_action: 'nope', community_action: 'x', hc_action: 'settings', save_smtp: '1' });
  assert.equal(ctx.header('Location'), '/admin#storage');
  ctx = await post({ community_action: 'nope', hc_action: 'settings' });
  assert.equal(ctx.header('Location'), '/admin#community');
  ctx = await post({ oys_action: 'nope', toggle_admin_id: '3' });
  assert.equal(ctx.header('Location'), '/admin');
  assert.equal(ctx.session!.data.admin_error, 'You cannot change your own admin status here!');
  // Ohne passende Aktion: die Seite mit 200; ein Passwort-Reset ohne Passwort ebenso
  for (const form of [{ oys_action: 'nope' }, { reset_password_id: '5', new_password: '' }, { reset_password_id: '5', new_password: '0' }, {}]) {
    ctx = await post(form as PhpArray);
    assert.equal(ctx.status, 200);
    assert.match(String(ctx.body), /<title>Admin Panel \| OnYourSite<\/title>/);
    assert.ok(String(ctx.body).endsWith('</html>'));
  }
  // Ohne CSRF: Hinweis und zurück
  ctx = await post({ toggle_admin_id: '5' }, false);
  assert.equal(ctx.header('Location'), '/admin');
  assert.equal(ctx.session!.data.admin_error, 'Session expired – please try again.');
});

test('reset password: any id, raw password, message with the PHP (int) of the id', async () => {
  const ctx = await post({ reset_password_id: '99999999999999999999', new_password: ' x ' });
  assert.equal(ctx.session!.data.admin_success, 'Password for user #9223372036854775807 successfully changed.');
  const res = await post({ reset_password_id: '5abc', new_password: ' new pass ' });
  assert.equal(res.session!.data.admin_success, 'Password for user #5 successfully changed.');
  const row = (await one('SELECT password FROM users WHERE id = 5'))!;
  assert.match(String(row.password), /^\$2y\$10\$/);
  await assert.rejects(post({ reset_password_id: '5', new_password: { 0: 'x' } }), TypeError);
});

test('the SMTP form shows the saved values and a broken smtp.json shows empty fields', async () => {
  const s = await adminSession();
  let ctx = await post({ save_smtp: '1', smtp_host: ' mx.test ', smtp_port: '25', smtp_username: 'u', smtp_password: 'p"w', from_email: 'a@b.c', from_name: 'N' }, true, s);
  assert.equal(ctx.session!.data.admin_success, 'Mail Server settings successfully saved.');
  ctx = await post({}, true, s);
  assert.match(String(ctx.body), /name="smtp_host" value="mx\.test"/);
  assert.match(String(ctx.body), /name="smtp_password" value="p&quot;w"/);
  // Die Meldung erscheint genau einmal
  assert.match(String(ctx.body), /Mail Server settings successfully saved\./);
  ctx = await post({}, true, s);
  assert.doesNotMatch(String(ctx.body), /Mail Server settings successfully saved\./);
  writeFileSync(join(mailDir, 'smtp.json'), '{broken');
  ctx = await post({});
  assert.match(String(ctx.body), /name="smtp_host" value=""/);
});

test('a missing email/ folder is created (0755) before the mail server and user actions, not before the tab actions', async () => {
  const dir = join(mailDir, 'sub', 'email');
  setEmailDirForTests(dir);
  try {
    // Honigwaben kommen vor dem Anlegen des Ordners
    await post({ hc_action: 'nope' });
    assert.equal(existsSync(dir), false);
    const ctx = await post({});
    assert.equal(ctx.status, 200);
    assert.equal(statSync(dir).isDirectory(), true);
    assert.equal(statSync(dir).mode & 0o777, 0o755 & ~process.umask());
    // Ohne Vorlagen: der Hinweis in der Auswahl
    assert.match(String(ctx.body), /<option value="" disabled>No templates found!<\/option>/);
  } finally {
    setEmailDirForTests(mailDir);
  }
});

test('an array in a hand-edited smtp.json cuts the page off at that field with status 200, like PHP', async () => {
  writeFileSync(join(mailDir, 'smtp.json'), '{"host":"mx.example","port":["587"]}');
  // PHP schreibt den TypeError nur ins Protokoll
  const logged: unknown[] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    const ctx = await post({});
    assert.equal(ctx.status, 200);
    const body = String(ctx.body);
    assert.match(body, /name="smtp_host" value="mx\.example"/);
    assert.ok(body.endsWith('<input type="text" name="smtp_port" value="'), body.slice(-60));
    assert.equal(logged.length, 1);
  } finally {
    console.error = log;
    rmSync(join(mailDir, 'smtp.json'));
  }
});
