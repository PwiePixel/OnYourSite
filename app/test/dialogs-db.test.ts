// Bestätigungen im Admin (custom-dialogs CD-3) mit der Datenbank: Ein Formular mit _confirmed wird nur mit „1“
// ausgeführt (fehlt ui.js, passiert nichts), Formulare ohne das Feld bleiben wie bisher; dasselbe für „Log in as“.
// Dazu die fertige Admin-Seite: jedes Formular mit Folgen fragt mit eigenem Dialog, kein confirm() mehr.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { configString, loadConfig, setConfigForTests } from '../src/config.js';
import { closePool, exec, one, value } from '../src/db.js';
import { makeTestCtx, isHalt, type Ctx } from '../src/web/ctx.js';
import { Session } from '../src/web/session.js';
import { adminPage } from '../src/admin/page.js';
import { adminBackUrl } from '../src/admin/confirm.js';
import { adminImpersonate } from '../src/app/impersonate.js';
import { discordDefaults, discordStore } from '../src/updates/discord.js';
import { UNCONFIRMED_MESSAGE } from '../src/views/partials/ui.js';
import type { PhpArray } from '../src/php.js';
// @ts-ignore – reines ES-Modul ohne Typen
import { checkText } from '../../tools/check-native-dialogs.mjs';

const BASE = loadConfig();
const SOURCE = configString('db.name');
const DB = SOURCE + '_dialogsdb';
const CSRF = 'd'.repeat(64);
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
  await closePool();
  setConfigForTests({ ...BASE, db: { ...(BASE.db as Record<string, string>), name: DB } });
  // Daten, damit jedes bestätigte Formular erscheint: Code-Seite, Meilenstein mit Aufgabe, offenes Ticket, Discord
  await exec("INSERT INTO code_sites (id, user_id, slug, title, created_at, updated_at) VALUES (40, 6, 'tomcode', 'Tom', NOW(), NOW())");
  await exec("INSERT INTO milestones (id, title, status, position, created_at, updated_at) VALUES (50, 'Dialogs', 'planned', 0, NOW(), NOW())");
  await exec("INSERT INTO milestone_tasks (id, milestone_id, title, position) VALUES (60, 50, 'Write the library', 0)");
  await exec("INSERT INTO community_tickets (id, user_id, user_name, subject, channel_id, status, created_at, updated_at) VALUES (70, '123456789012345678', 'Tom', 'Help', '223456789012345678', 'open', NOW(), NOW())");
  await discordStore({ ...discordDefaults(), webhook_url: 'https://discord.com/api/webhooks/123456789012/' + 'w'.repeat(40) });
});

after(async () => {
  await closePool();
  setConfigForTests(BASE);
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.end();
});

// Angemeldete Sitzung des Admins (id 3); extra: weitere Sitzungswerte
async function adminSession(extra: Record<string, unknown> = {}): Promise<string> {
  const ctx = makeTestCtx({ url: '/admin' });
  const s = await Session.start(ctx);
  s.set('user_id', 3);
  s.set('csrf', CSRF);
  for (const [k, v] of Object.entries(extra)) s.set(k, v);
  await s.close();
  return s.id;
}

// Eine Anfrage wie über den Server: Ende mit exit (Halt), danach die Sitzung speichern
async function run(url: string, form: PhpArray | null, handler: (ctx: Ctx) => Promise<void>, sid?: string): Promise<Ctx> {
  const id = sid ?? (await adminSession());
  const ctx = makeTestCtx({ method: form ? 'POST' : 'GET', url, cookies: { PHPSESSID: id }, post: form ? { csrf: CSRF, ...form } : {} });
  await Session.start(ctx);
  try {
    await handler(ctx);
  } catch (err) {
    if (!isHalt(err)) throw err;
  } finally {
    await ctx.session?.close();
  }
  return ctx;
}
const adminPost = async (form: PhpArray, sid?: string) => run('/admin', form, async (ctx) => adminPage(ctx, (await one('SELECT * FROM users WHERE id = 3'))!), sid);
const exists = async (sql: string, params: Array<string | number> = []) => (await value(sql, params)) !== null;

test('admin forms with _confirmed: "0" changes nothing and says why; "1" runs; without the field nothing changes', async () => {
  // Konto löschen: nicht bestätigt → Mia bleibt, Hinweis, zurück zur Liste
  let ctx = await adminPost({ delete_user_id: '5', _confirmed: '0' });
  assert.equal(ctx.status, 302);
  assert.equal(ctx.header('Location'), '/admin');
  assert.equal(ctx.session!.data.admin_error, UNCONFIRMED_MESSAGE);
  assert.ok(await exists('SELECT id FROM users WHERE id = 5'));
  // Auch ein leerer oder fremder Wert und ein Array gelten nicht als bestätigt
  for (const bad of ['', 'yes', ' 1', { 0: '1' }] as const) {
    ctx = await adminPost({ delete_user_id: '5', _confirmed: bad as PhpArray[string] });
    assert.equal(ctx.session!.data.admin_error, UNCONFIRMED_MESSAGE, JSON.stringify(bad));
  }
  assert.ok(await exists('SELECT id FROM users WHERE id = 5'));
  // Bestätigt → gelöscht wie bisher
  ctx = await adminPost({ delete_user_id: '5', _confirmed: '1' });
  assert.equal(ctx.session!.data.admin_success, 'User successfully deleted.');
  assert.ok(!(await exists('SELECT id FROM users WHERE id = 5')));
  // Ohne das Feld (ältere Formulare, andere Werkzeuge): unverändert
  ctx = await adminPost({ toggle_admin_id: '6' });
  assert.equal(ctx.session!.data.admin_success, 'User successfully promoted to Admin.');
  assert.equal(Number(await value('SELECT is_admin FROM users WHERE id = 6')), 1);
});

test('the check runs after CSRF and before every handler, and sends the admin back to the form’s section', async () => {
  // Erst CSRF: falsches Token → die bisherige Meldung
  const sid = await adminSession();
  const bad = makeTestCtx({ method: 'POST', url: '/admin', cookies: { PHPSESSID: sid }, post: { csrf: 'x', delete_user_id: '6', _confirmed: '0' } });
  await Session.start(bad);
  try { await adminPage(bad, (await one('SELECT * FROM users WHERE id = 3'))!); } catch (err) { if (!isHalt(err)) throw err; } finally { await bad.session?.close(); }
  assert.equal(bad.session!.data.admin_error, 'Session expired – please try again.');
  const cases: Array<[PhpArray, string, string, Array<string | number>]> = [
    [{ code_action: 'block', site_id: '40', reason: 'spam' }, '/admin#code-pages', 'SELECT id FROM code_sites WHERE id = 40 AND is_blocked = 0', []],
    [{ code_action: 'unlock', item: 'code_page', user_id: '7' }, '/admin#code-pages', "SELECT 1 FROM users WHERE id = 7 AND NOT EXISTS (SELECT 1 FROM honeycomb_ledger WHERE user_id = 7 AND reason = 'unlock')", []],
    // Formulare von vor der Trennung (hc_action=code_*) sind genauso geschützt
    [{ hc_action: 'code_block', site_id: '40', reason: 'spam' }, '/admin#honeycombs', 'SELECT id FROM code_sites WHERE id = 40 AND is_blocked = 0', []],
    [{ hc_action: 'code_unlock', user_id: '7' }, '/admin#honeycombs', "SELECT 1 FROM users WHERE id = 7 AND NOT EXISTS (SELECT 1 FROM honeycomb_ledger WHERE user_id = 7 AND reason = 'unlock')", []],
    [{ oys_action: 'milestone_delete', id: '50' }, '/admin#roadmap', 'SELECT id FROM milestones WHERE id = 50', []],
    [{ oys_action: 'task_delete', id: '60' }, '/admin#roadmap', 'SELECT id FROM milestone_tasks WHERE id = 60', []],
    [{ oys_action: 'update_delete', id: '1' }, '/admin#updates', 'SELECT id FROM updates WHERE id = 1', []],
    [{ oys_action: 'discord_disconnect' }, '/admin#discord', "SELECT 1 FROM oys_meta WHERE meta_key = 'discord'", []],
    [{ community_action: 'ticket_close', id: '70' }, '/admin#community', "SELECT id FROM community_tickets WHERE id = 70 AND status = 'open'", []],
    [{ send_newsletter: '1', template_file: 'x.json', audience: 'all' }, '/admin#newsletter', 'SELECT 1', []],
  ];
  for (const [form, back, still] of cases) {
    const ctx = await adminPost({ ...form, _confirmed: '0' });
    assert.equal(ctx.header('Location'), back, JSON.stringify(form));
    assert.equal(ctx.session!.data.admin_error, UNCONFIRMED_MESSAGE, JSON.stringify(form));
    assert.ok(await exists(still), 'nothing changed: ' + JSON.stringify(form));
  }
  // Bestätigt: die Aktion läuft (Stichproben)
  let ctx = await adminPost({ code_action: 'block', site_id: '40', reason: 'spam', _confirmed: '1' });
  assert.equal(ctx.session!.data.admin_success, '“tomcode” is blocked.');
  ctx = await adminPost({ community_action: 'ticket_close', id: '70', _confirmed: '1' });
  assert.equal(ctx.session!.data.admin_success, 'Ticket #70 closed.');
  ctx = await adminPost({ oys_action: 'task_delete', id: '60', _confirmed: '1' });
  assert.ok(!(await exists('SELECT id FROM milestone_tasks WHERE id = 60')));
  ctx = await adminPost({ code_action: 'unlock', item: 'code_page', user_id: '7', _confirmed: '1' });
  assert.equal(ctx.session!.data.admin_success, 'Code page unlocked for Lea.');
});

test('adminBackUrl() maps each action field to its tab', () => {
  assert.equal(adminBackUrl({ storage_action: 'zip' }), '/admin#storage');
  assert.equal(adminBackUrl({ code_action: 'block' }), '/admin#code-pages');
  assert.equal(adminBackUrl({ oys_action: 'discord_save' }), '/admin#discord');
  assert.equal(adminBackUrl({ oys_action: 'update_save' }), '/admin#updates');
  assert.equal(adminBackUrl({ oys_action: { 0: 'x' } }), '/admin#updates');
  assert.equal(adminBackUrl({ save_smtp: '1' }), '/admin#mailserver');
  assert.equal(adminBackUrl({ delete_user_id: '5' }), '/admin');
  assert.equal(adminBackUrl({}), '/admin');
});

test('“Log in as”: unconfirmed stays the admin, confirmed switches, without the field it works as before', async () => {
  const imp = (form: PhpArray, sid?: string) => run('/admin_impersonate.php', form, adminImpersonate, sid);
  let ctx = await imp({ id: '6', _confirmed: '0' });
  assert.equal(ctx.header('Location'), '/admin');
  assert.equal(ctx.session!.data.user_id, 3);
  assert.equal(ctx.session!.data.original_admin_id, undefined);
  assert.equal(ctx.session!.data.admin_error, UNCONFIRMED_MESSAGE);
  ctx = await imp({ id: '6', _confirmed: '1' });
  assert.equal(ctx.header('Location'), '/dashboard');
  assert.equal(ctx.session!.data.user_id, 6);
  assert.equal(ctx.session!.data.original_admin_id, 3);
  ctx = await imp({ id: '7' });
  assert.equal(ctx.session!.data.user_id, 7);
  // Wer kein Admin ist, bekommt keinen Admin-Hinweis (die Admin-Prüfung kommt zuerst)
  const sid = await (async () => { const c = makeTestCtx({ url: '/' }); const s = await Session.start(c); s.set('user_id', 8); s.set('csrf', CSRF); await s.close(); return s.id; })();
  ctx = await imp({ id: '6', _confirmed: '0' }, sid);
  assert.equal(ctx.header('Location'), '/dashboard');
  assert.equal(ctx.session!.data.admin_error, undefined);
});

test('the admin page asks with own dialogs for every consequential form and has no native confirm left', async () => {
  // Die vorigen Tests haben gesperrt und gelöscht: wieder alle Formulare zeigen
  await exec("INSERT INTO milestone_tasks (id, milestone_id, title, position) VALUES (61, 50, 'Convert the admin', 1)");
  await exec('UPDATE code_sites SET is_blocked = 0, blocked_reason = NULL WHERE id = 40');
  await exec("UPDATE community_tickets SET status = 'open', closed_at = NULL WHERE id = 70");
  const sid = await adminSession({ admin_success: 'Saved <b>.</b>', admin_error: 'Nope & no' });
  const ctx = await run('/admin?ticket=70', null, async (c) => adminPage(c, (await one('SELECT * FROM users WHERE id = 3'))!), sid);
  const html = String(ctx.body);
  assert.deepEqual((checkText(html) as unknown[]).length, 0, 'no alert/confirm/prompt and no inline confirmations');
  // Jedes Formular mit Folgen: data-confirm (Formular oder Knopf) und das Feld _confirmed
  const forms = html.match(/<form[\s\S]*?<\/form>/g) ?? [];
  const needs = ['name="delete_user_id"', 'name="toggle_admin_id"', 'action="/admin_impersonate.php"', 'name="send_newsletter"', 'value="update_delete"',
    'value="task_delete"', 'value="milestone_delete"', 'name="code_action" value="block"', 'name="code_action" value="unlock"', 'value="ticket_close"'];
  // Den Discord-Bereich (Webhook entfernen, alter Bot-Token) prüft discord-admin.test.ts samt Server-Schutz
  for (const marker of needs) {
    const list = forms.filter((f) => f.includes(marker));
    assert.ok(list.length > 0, 'form present: ' + marker);
    for (const f of list) {
      assert.match(f, /data-confirm="[^"]+"/, 'data-confirm: ' + marker);
      assert.ok(f.includes('<input type="hidden" name="_confirmed" value="0" autocomplete="off">'), '_confirmed: ' + marker);
    }
  }
  // Texte mit Namen (maskiert) und Tönen
  assert.ok(html.includes('data-confirm="Delete this user?" data-confirm-text="Tom Weber (tom@test.de) and all their pages, stats, messages and uploads are deleted. This can’t be undone." data-confirm-ok="Delete user" data-confirm-tone="danger"'));
  assert.ok(html.includes('data-confirm="Log in as Tom Weber?"'));
  assert.ok(html.includes('data-confirm="Make Tom Weber an admin?"') || html.includes('data-confirm="Remove admin rights from Tom Weber?"'));
  assert.ok(html.includes('data-confirm="Close this ticket?" data-confirm-ok="Close ticket" data-confirm-tone="warn"'));
  // Hinweise als Banner mit data-flash (ui.js macht Toasts daraus), maskiert
  assert.ok(html.includes('data-flash="ok" role="status"') && html.includes('Saved &lt;b&gt;.&lt;/b&gt;'));
  assert.ok(html.includes('data-flash="err" role="alert"') && html.includes('Nope &amp; no'));
  // Passwort-Fenster: Rolle, Titel, Knöpfe ohne onclick, Daten statt addslashes
  assert.ok(html.includes('role="dialog" aria-modal="true" aria-labelledby="pwdModalTitle"') && html.includes('id="pwdModalTitle"'));
  assert.ok(!/openPwdModal|closePwdModal/.test(html));
  assert.ok(html.includes('data-pwd-reset="6" data-name="Tom Weber"'));
  // ui.js und ui.css sind geladen
  assert.match(html, /<script src="\/static\/js\/ui\.js\?v=[0-9a-f]+" defer><\/script>/);
});
