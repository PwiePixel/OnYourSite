// HTTP: Admin-Rechte nur in der eigenen Sitzung des Admins (Entscheidung R1). Arbeitet Admin A über „Log in as“ als
// Admin B, ist er B ohne Admin-Rechte: /admin (Seite und Formulare), /admin/api/… und OnYourSites eigene Statusseite im
// Editor antworten wie für einen normalen Nutzer, und nichts wird geschrieben. In der eigenen Sitzung von A geht alles
// wie bisher; „Log in as“ geht für jedes Konto, „Back to admin panel“ beendet den Nutzer-Modus.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { makeTestCtx, type Ctx } from '../src/web/ctx.js';
import { appRoutes } from '../src/app/dispatch.js';
import { adminImpersonate, adminReturn } from '../src/app/impersonate.js';
import { ensureSchema } from '../src/schema.js';
import type { PhpArray } from '../src/php.js';
import { CSRF, jsonBody, loginSession, runRequest, testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
const OLD = '2026-01-01 10:00:00';
const ADMIN_A = 3;
const ADMIN_B = 4;
const USER = 5;

async function sql(query: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [r] = await t.admin.query<RowDataPacket[]>(query.replace(/`DB`/g, '`' + t.name + '`'), params);
  return r;
}
const count = async (query: string, params: unknown[] = []): Promise<number> => Number((await sql(query, params))[0].n);
// Was die beiden Formulare schreiben würden: Buchung, Protokoll, Discord-Einstellungen
const written = async (): Promise<number[]> => [
  await count('SELECT COUNT(*) AS n FROM `DB`.honeycomb_ledger WHERE user_id = ?', [USER]),
  await count('SELECT COUNT(*) AS n FROM `DB`.hc_audit'),
  await count("SELECT COUNT(*) AS n FROM `DB`.oys_meta WHERE meta_key = 'discord'"),
];

const GRANT: PhpArray = { hc_action: 'grant', user_id: String(USER), amount: '25', note: 'Thanks' };
const DISCORD: PhpArray = { oys_action: 'discord_defaults_save', invite_url: 'https://discord.gg/onyoursite', auto_post: '1' };

async function get(url: string, sid: string): Promise<Ctx> {
  return runRequest(makeTestCtx({ url, cookies: { PHPSESSID: sid } }), appRoutes);
}
async function post(url: string, sid: string, form: PhpArray): Promise<Ctx> {
  return runRequest(makeTestCtx({ method: 'POST', url, cookies: { PHPSESSID: sid }, post: { csrf: CSRF, ...form } }), appRoutes);
}
// Editor-API (JSON mit CSRF-Kopfzeile) wie über den Server
async function editor(action: string, sid: string, method: 'GET' | 'POST', json: Record<string, unknown> = {}): Promise<Ctx> {
  const ctx = makeTestCtx({
    method, url: '/dashboard/api/' + action + (method === 'GET' ? '?scope=system' : ''), cookies: { PHPSESSID: sid },
    headers: method === 'POST' ? { 'content-type': 'application/json', 'x-csrf-token': CSRF } : { 'x-csrf-token': CSRF },
    rawBody: method === 'POST' ? Buffer.from(JSON.stringify({ scope: 'system', ...json })) : undefined,
  });
  return runRequest(ctx, appRoutes);
}
const statusTitle = async (): Promise<string> => String((await sql('SELECT title FROM `DB`.status_pages WHERE is_system = 1'))[0]?.title);

before(async () => {
  t = await testDatabase('ownadm', { empty: true });
  await ensureSchema();
  const user = 'INSERT INTO `DB`.users (id, email, password, full_name, is_admin, created_at) VALUES (?, ?, \'x\', ?, ?, ?)';
  await sql(user, [ADMIN_A, 'a@test.de', 'Admin A', 1, OLD]);
  await sql(user, [ADMIN_B, 'b@test.de', 'Admin B', 1, OLD]);
  await sql(user, [USER, 'mia@test.de', 'Mia', 0, OLD]);
});

after(async () => {
  await t.done();
});

test('an admin working as another admin is that account without admin rights: /admin, its forms, /admin/api and the system status page are refused', async () => {
  const before = await written();
  const title = await statusTitle();
  for (const sid of [await loginSession(ADMIN_B, { impersonatedBy: ADMIN_A }), await loginSession(USER)]) {
    // Die Seite und jedes Formular: wie für einen normalen Nutzer zurück in den Editor
    let ctx = await get('/admin', sid);
    assert.equal(ctx.status, 302);
    assert.equal(ctx.header('Location'), '/dashboard');
    for (const form of [GRANT, DISCORD]) {
      ctx = await post('/admin', sid, form);
      assert.equal(ctx.status, 302, JSON.stringify(form));
      assert.equal(ctx.header('Location'), '/dashboard', JSON.stringify(form));
      assert.equal(ctx.session!.data.admin_success, undefined);
    }
    // JSON des Admin-Bereichs: 403 wie für Nutzer
    ctx = await get('/admin/api/discord-status', sid);
    assert.equal(ctx.status, 403);
    assert.deepEqual(jsonBody(ctx), { ok: false, error: 'Admins only.' });
    // OnYourSites eigene Statusseite im Editor
    ctx = await editor('status', sid, 'GET');
    assert.equal(ctx.status, 403);
    assert.deepEqual(jsonBody(ctx), { ok: false, error: 'Not allowed.' });
    ctx = await editor('status-page', sid, 'POST', { title: 'Taken over' });
    assert.equal(ctx.status, 403);
    assert.deepEqual(jsonBody(ctx), { ok: false, error: 'Not allowed.' });
  }
  assert.deepEqual(await written(), before, 'nothing is booked, logged or saved');
  assert.equal(await statusTitle(), title);

  // Der Editor zeigt im Nutzer-Modus weder den Weg in den Admin-Bereich noch den Bereich „Status“ – nur „Back to admin panel“
  const html = String((await get('/dashboard', await loginSession(ADMIN_B, { impersonatedBy: ADMIN_A }))).body);
  assert.ok(html.includes('action="/admin_return.php"'), 'the way back is shown');
  assert.ok(!html.includes('href="/admin"'), 'no link to the admin panel');
  assert.ok(!html.includes('data-tab="status"'), 'no Status tab');
});

test('in the admin’s own session the admin panel, its forms, /admin/api and the system status page work as before', async () => {
  const sid = await loginSession(ADMIN_A);
  let ctx = await get('/admin', sid);
  assert.equal(ctx.status, 200);
  ctx = await post('/admin', sid, GRANT);
  assert.equal(ctx.header('Location'), '/admin?hc_tab=users#honeycombs');
  assert.match(String(ctx.session!.data.admin_success), /^\+25 honeycombs for Mia\./);
  ctx = await post('/admin', sid, DISCORD);
  assert.equal(ctx.session!.data.admin_success, 'Discord settings saved.');
  assert.deepEqual(await written(), [1, 1, 1]);
  // Gebucht und protokolliert unter A
  assert.equal(Number((await sql('SELECT admin_id FROM `DB`.hc_audit ORDER BY id DESC LIMIT 1'))[0].admin_id), ADMIN_A);
  ctx = await get('/admin/api/discord-status', sid);
  assert.equal(ctx.status, 200);
  assert.equal(jsonBody(ctx).ok, true);
  ctx = await editor('status', sid, 'GET');
  assert.equal(ctx.status, 200);
  const html = String((await get('/dashboard', sid)).body);
  assert.ok(html.includes('href="/admin"') && html.includes('data-tab="status"'));
  assert.ok(!html.includes('action="/admin_return.php"'));
  // Admin B in der eigenen Sitzung ebenso
  assert.equal((await get('/admin', await loginSession(ADMIN_B))).status, 200);
});

test('“Log in as” works for an admin account, and “Back to admin panel” ends it and opens the admin panel again', async () => {
  // A meldet sich als B an (der Knopf gibt es für jedes Konto außer dem eigenen)
  let ctx = await runRequest(makeTestCtx({ method: 'POST', url: '/admin_impersonate.php', cookies: { PHPSESSID: await loginSession(ADMIN_A) },
    post: { csrf: CSRF, id: String(ADMIN_B), _confirmed: '1' } }), adminImpersonate);
  assert.equal(ctx.header('Location'), '/dashboard');
  assert.equal(ctx.session!.data.user_id, ADMIN_B);
  assert.equal(ctx.session!.data.original_admin_id, ADMIN_A);
  let sid = ctx.session!.id;
  assert.equal((await get('/admin', sid)).header('Location'), '/dashboard');
  // Zurück: wieder A mit Admin-Bereich
  ctx = await runRequest(makeTestCtx({ method: 'POST', url: '/admin_return.php', cookies: { PHPSESSID: sid }, post: { csrf: CSRF } }), adminReturn);
  assert.equal(ctx.header('Location'), '/admin');
  assert.equal(ctx.session!.data.user_id, ADMIN_A);
  assert.equal(ctx.session!.data.original_admin_id, undefined);
  sid = ctx.session!.id;
  ctx = await get('/admin', sid);
  assert.equal(ctx.status, 200);
  assert.ok(String(ctx.body).includes('Welcome back! You are no longer impersonating a user.'));
});
