// Beta-Bereich (beta/): Schema-Schritt und Reservierung der Adresse „beta“, Freischalten nur mit Discord, Aufträge an den
// Bot (beta.role) und seine Rückmeldungen, Wechsel der Discord-ID, beta.<domain> (Anmelden, Hinweis, Panel, Meldungen),
// <domain>/beta, Admin → Beta (eigene Test-Datenbank).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { makeTestCtx, type Ctx } from '../src/web/ctx.js';
import { dispatch } from '../src/router.js';
import { ensureSchema, V_BETA } from '../src/schema.js';
import { loadConfig, setConfigForTests } from '../src/config.js';
import { encryptData, passwordHash } from '../src/crypto.js';
import { transaction } from '../src/db.js';
import { slugProblem } from '../src/helpers.js';
import { botAction, knownFeatures, type OutboxJob } from '../src/community/outbox.js';
import { betaAccess, discordChanged, grantBeta, readReport, retryRole, revokeBeta } from '../src/beta/beta.js';
import { deleteAccount } from '../src/admin/accountDeletion.js';
import { CSRF, loginSession, runRequest, testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
const ADMIN = 3, MIA = 5, TOM = 6, LEA = 7;
const MIA_DISCORD = '111111111111111111', TOM_DISCORD = '222222222222222222';
const BETA = 'beta.oys.test:8080';
const PASSWORD = 'beta-test-1234';

async function sql(query: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [r] = await t.admin.query<RowDataPacket[]>(query.replace(/`DB`/g, '`' + t.name + '`'), params);
  return r;
}
async function req(url: string, o: { host?: string; method?: string; sid?: string; post?: Record<string, string> } = {}): Promise<Ctx> {
  return runRequest(makeTestCtx({ url, host: o.host, method: o.method ?? (o.post ? 'POST' : 'GET'), cookies: o.sid ? { PHPSESSID: o.sid } : undefined, post: o.post }), dispatch);
}
const jobs = async (): Promise<Array<{ action: string; ref: string; data: Record<string, unknown> }>> =>
  (await sql("SELECT action, ref, payload FROM `DB`.community_outbox WHERE action = 'beta.role' ORDER BY id")).map((r) => ({ action: String(r.action), ref: String(r.ref), data: JSON.parse(String(r.payload)) }));
const user = async (id: number): Promise<RowDataPacket> => (await sql('SELECT * FROM `DB`.users WHERE id = ?', [id]))[0];
const flash = async (sid: string): Promise<string> => {
  const html = String((await req('/admin', { sid })).body);
  return /<div data-flash="[a-z]+"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1].replace(/<[^>]+>/g, '').trim() ?? '';
};
// Rückmeldung des Bots auf den neuesten beta.role-Auftrag
async function botAnswers(result: Record<string, unknown> | null, error = '', final = true): Promise<void> {
  const [row] = await sql("SELECT * FROM `DB`.community_outbox WHERE action = 'beta.role' ORDER BY id DESC LIMIT 1");
  const job = { ...row, data: JSON.parse(String(row.payload)) } as unknown as OutboxJob;
  await transaction(async (_c, db) => botAction('beta.role')!.onResult!(db, job, result, error, final));
}

before(async () => {
  t = await testDatabase('beta', { empty: true });
  setConfigForTests({ ...loadConfig(), db: { ...(loadConfig().db as Record<string, string>), name: t.name }, base_domain: 'oys.test:8080', scheme: 'http' });
  await ensureSchema({ upTo: V_BETA - 1 });
  const hash = await passwordHash(PASSWORD);
  const add = 'INSERT INTO `DB`.users (id, email, password, full_name, username, is_admin, discord_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
  await sql(add, [ADMIN, 'admin@test.de', hash, 'Pixel Admin', 'pixel', 1, null, '2025-01-01 10:00:00']);
  await sql(add, [MIA, 'mia@test.de', hash, 'Mia Müller', 'mia', 0, encryptData(MIA_DISCORD), '2025-01-01 10:00:00']);
  await sql(add, [TOM, 'tom@test.de', hash, 'Tom', 'tom', 0, encryptData(TOM_DISCORD), '2025-01-01 10:00:00']);
  await sql(add, [LEA, 'lea@test.de', hash, 'Lea', 'lea', 0, null, '2025-01-01 10:00:00']);
  // Eine Link-Seite heißt schon „beta“ (Subdomain-Modus): sie zieht beim Schritt in den Pfad-Modus um
  await sql("INSERT INTO `DB`.pages (user_id, slug, title, address_mode, created_at) VALUES (?, 'beta', 'Lea beta', 'subdomain', '2025-01-01 10:00:00')", [LEA]);
  await ensureSchema();
});
after(async () => {
  await t.done();
});
beforeEach(async () => {
  await sql("DELETE FROM `DB`.community_outbox WHERE action = 'beta.role'");
});

test('the schema step: tester columns, the reports table, and the address "beta" reserved (a page called beta moves to the path)', async () => {
  const cols = (await sql("SHOW COLUMNS FROM `DB`.users LIKE 'beta%'")).map((c) => c.Field);
  assert.deepEqual(cols, ['beta_at', 'beta_by', 'beta_discord', 'beta_role', 'beta_role_error']);
  assert.equal((await sql("SHOW TABLES FROM `DB` LIKE 'beta_reports'")).length, 1);
  assert.equal((await sql("SELECT address_mode FROM `DB`.pages WHERE slug = 'beta'"))[0].address_mode, 'path');
  const note = await sql("SELECT title, body FROM `DB`.notifications WHERE user_id = ? AND type = 'system'", [LEA]);
  assert.equal(note.length, 1);
  assert.match(String(note[0].body), /beta\.oys\.test:8080 now opens OnYourSite’s beta area\. Your page moved to oys\.test:8080\/beta/);
  assert.match(String(await slugProblem('beta')), /reserved/i);
  assert.ok(knownFeatures().includes('beta.v1'), 'the website asks bots with beta.v1 for beta.role');
});

test('granting needs a linked Discord; it queues the role, notifies the tester; removing takes the role away', async () => {
  let r = await grantBeta(ADMIN, LEA);
  assert.deepEqual(r, { ok: false, error: 'This account has no Discord linked – beta testers need it for the Beta Tester role. Ask them to add their Discord ID in the editor under Settings.' });
  r = await grantBeta(ADMIN, MIA);
  assert.deepEqual(r, { ok: true });
  const mia = await user(MIA);
  assert.ok(mia.beta_at);
  assert.equal(mia.beta_by, ADMIN);
  assert.equal(mia.beta_discord, MIA_DISCORD);
  assert.equal(mia.beta_role, 'pending');
  assert.deepEqual(await jobs(), [{ action: 'beta.role', ref: 'beta:5', data: { user_id: MIA, discord_id: MIA_DISCORD, add: true } }]);
  const note = await sql("SELECT title, link FROM `DB`.notifications WHERE user_id = ? AND type = 'beta'", [MIA]);
  assert.deepEqual(note.map((n) => [n.title, n.link]), [['You’re a beta tester now', '/_/beta']]);
  assert.deepEqual(await grantBeta(ADMIN, MIA), { ok: false, error: 'This account is already a beta tester.' });
  // Der Bot hat die Rolle gegeben
  await botAnswers({ state: 'given', role_id: '9' });
  assert.equal((await user(MIA)).beta_role, 'given');
  // Entfernen: Auftrag zum Nehmen, nach der Rückmeldung keine Rolle mehr vermerkt
  assert.deepEqual(await revokeBeta(MIA), { ok: true });
  assert.equal((await user(MIA)).beta_at, null);
  assert.deepEqual((await jobs()).slice(-1), [{ action: 'beta.role', ref: 'beta:5', data: { user_id: MIA, discord_id: MIA_DISCORD, add: false } }]);
  await botAnswers({ state: 'removed' });
  const after = await user(MIA);
  assert.deepEqual([after.beta_role, after.beta_discord], ['removed', null]);
  assert.deepEqual(await revokeBeta(MIA), { ok: false, error: 'This account isn’t a beta tester.' });
});

test('the bot’s answers: not on the server, a final error, and a late answer for an old Discord ID changes nothing', async () => {
  await grantBeta(ADMIN, TOM);
  await botAnswers({ state: 'not_on_server' });
  assert.equal((await user(TOM)).beta_role, 'not_on_server');
  await botAnswers(null, 'Missing Permissions', false);
  assert.equal((await user(TOM)).beta_role, 'not_on_server', 'a retry later – nothing changes yet');
  await botAnswers(null, 'Missing Permissions', true);
  assert.deepEqual([(await user(TOM)).beta_role, (await user(TOM)).beta_role_error], ['error', 'Missing Permissions']);
  // Neue Discord-ID: alte ID verliert die Rolle, die neue bekommt sie
  const NEW = '333333333333333333';
  await sql('UPDATE `DB`.users SET discord_id = ? WHERE id = ?', [encryptData(NEW), TOM]);
  await discordChanged(TOM);
  assert.deepEqual((await jobs()).slice(-2).map((j) => [j.data.discord_id, j.data.add]), [[TOM_DISCORD, false], [NEW, true]]);
  assert.deepEqual([(await user(TOM)).beta_discord, (await user(TOM)).beta_role], [NEW, 'pending']);
  // Eine späte Antwort für die alte ID (Auftrag „geben“) ändert den Stand nicht
  const job = { id: 0, action: 'beta.role', payload: '', attempts: 1, ref: 'beta:6', created_at: '', claimed_at: null, done_at: null, data: { user_id: TOM, discord_id: TOM_DISCORD, add: true } } as OutboxJob;
  await transaction(async (_c, db) => botAction('beta.role')!.onResult!(db, job, { state: 'given' }, '', true));
  assert.equal((await user(TOM)).beta_role, 'pending');
  // Discord entfernt: der Zugang ruht, die Rolle wird genommen
  await sql("UPDATE `DB`.users SET discord_id = '' WHERE id = ?", [TOM]);
  await discordChanged(TOM);
  assert.equal(betaAccess(await user(TOM)), 'no_discord');
  assert.deepEqual((await jobs()).slice(-1).map((j) => [j.data.discord_id, j.data.add]), [[NEW, false]]);
  await revokeBeta(TOM);
});

test('beta.<domain>: log in with the OnYourSite account; testers see the panel, others a note', async () => {
  // Ohne Anmeldung: das Anmeldeformular
  let ctx = await req('/_beta/', { host: BETA });
  assert.equal(ctx.status, 200);
  assert.match(String(ctx.body), /<title>Log in \| OnYourSite Beta<\/title>/);
  assert.match(String(ctx.body), /<form action="\/_beta\/login" method="POST"/);
  assert.equal(ctx.header('X-Robots-Tag'), 'noindex, nofollow');
  // Falsches Passwort
  const anon = await loginSession(0);
  ctx = await req('/_beta/login', { host: BETA, sid: anon, post: { csrf: CSRF, email: 'lea@test.de', password: 'nope' } });
  assert.equal(ctx.header('Location'), '/_beta/');
  assert.match(String((await req('/_beta/', { host: BETA, sid: anon })).body), /Wrong email or password\./);
  // Richtig: neue Sitzung; Lea ist keine Testerin
  ctx = await req('/_beta/login', { host: BETA, sid: anon, post: { csrf: CSRF, email: 'LEA@test.de ', password: PASSWORD } });
  assert.equal(ctx.header('Location'), '/_beta/');
  const cookie = /PHPSESSID=([^;]+)/.exec(String(ctx.header('Set-Cookie')))?.[1] ?? '';
  assert.ok(cookie && cookie !== anon, 'a new session id');
  assert.match(String((await req('/_beta/', { host: BETA, sid: cookie })).body), /For beta testers only/);
  // Mia als Testerin: das Panel
  await grantBeta(ADMIN, MIA);
  await sql("REPLACE INTO `DB`.oys_meta (meta_key, meta_value) VALUES ('beta_notes', 'Try the new block picker.\n\nAnd the <b>winter</b> look.')");
  const mia = await loginSession(MIA);
  const html = String((await req('/_beta/', { host: BETA, sid: mia })).body);
  assert.match(html, /Hi Mia, thanks for testing!/);
  assert.match(html, /<p>Try the new block picker\.<\/p><p>And the &lt;b&gt;winter&lt;\/b&gt; look\.<\/p>/, 'notes as plain text');
  assert.match(html, /<form action="\/_beta\/report" method="POST"/);
  assert.match(html, /You haven’t sent a report yet\./);
  // Admins dürfen immer
  assert.match(String((await req('/_beta/', { host: BETA, sid: await loginSession(ADMIN) })).body), /thanks for testing!/);
  // Andere Pfade (ohne Beta-Webseite): zum Panel
  assert.equal((await req('/whatever', { host: BETA, sid: mia })).header('Location'), '/_beta/');
  assert.equal((await req('/', { host: BETA, sid: mia })).header('Location'), '/_beta/');
  assert.match(html, /There’s no pre-release to try right now\./, 'no beta website set up');
  // Abmelden
  ctx = await req('/_beta/logout', { host: BETA, sid: mia, post: { csrf: CSRF } });
  assert.equal(ctx.header('Location'), '/_beta/');
  assert.match(String((await req('/_beta/', { host: BETA, sid: mia })).body), /Welcome to the beta/);
  await revokeBeta(MIA);
});

test('reports: checked input, saved with type, area and browser; listed with status and the team’s reply; only for testers', async () => {
  assert.equal(readReport({ title: 'ab', body: 'long enough text' }, ''), 'Please give your report a short title.');
  assert.equal(readReport({ title: 'A title', body: 'short' }, ''), 'Please describe what happened (at least a few words).');
  assert.equal(readReport({ title: 'A title', body: 'long enough text', page_url: 'javascript:alert(1)' }, ''), 'The link must start with https://');
  const ok = readReport({ kind: 'party', area: 'nope', title: ' Line\nbreak ', body: 'Something\r\nbroke here' }, 'UA');
  assert.ok(typeof ok !== 'string');
  assert.deepEqual([ok.kind, ok.area, ok.title, ok.body], ['bug', 'other', 'Line break', 'Something\nbroke here']);

  await grantBeta(ADMIN, MIA);
  const mia = await loginSession(MIA);
  let ctx = await req('/_beta/report', { host: BETA, sid: mia, post: { csrf: CSRF, kind: 'idea', area: 'editor', title: 'Dark mode toggle', body: 'Please add a switch for it.', steps: '', page_url: 'https://oys.test/x' } });
  assert.equal(ctx.header('Location'), '/_beta/#reports');
  const [row] = await sql('SELECT * FROM `DB`.beta_reports WHERE user_id = ? ORDER BY id DESC LIMIT 1', [MIA]);
  assert.deepEqual([row.kind, row.area, row.title, row.status, row.page_url], ['idea', 'editor', 'Dark mode toggle', 'open', 'https://oys.test/x']);
  assert.match(String((await req('/_beta/', { host: BETA, sid: mia })).body), /Thanks! Your report was sent to the team\.[\s\S]*Dark mode toggle/);
  // Falsche Eingabe
  ctx = await req('/_beta/report', { host: BETA, sid: mia, post: { csrf: CSRF, title: 'x', body: '' } });
  assert.equal(ctx.header('Location'), '/_beta/#report');
  assert.match(String((await req('/_beta/', { host: BETA, sid: mia })).body), /Please give your report a short title\./);
  // Keine Testerin: nichts gespeichert
  const lea = await loginSession(LEA);
  const before = (await sql('SELECT COUNT(*) AS n FROM `DB`.beta_reports'))[0].n;
  await req('/_beta/report', { host: BETA, sid: lea, post: { csrf: CSRF, title: 'Sneaky report', body: 'should not be saved' } });
  assert.equal((await sql('SELECT COUNT(*) AS n FROM `DB`.beta_reports'))[0].n, before);
  await revokeBeta(MIA);
});

test('<domain>/beta opens the beta area – unless a page is called beta', async () => {
  assert.equal((await req('/beta')).status, 200, 'Lea’s page called beta (path mode)');
  await sql("UPDATE `DB`.pages SET slug = 'lea-beta' WHERE slug = 'beta'");
  const ctx = await req('/beta');
  assert.equal(ctx.status, 302);
  assert.equal(ctx.header('Location'), 'http://beta.oys.test:8080/');
  await sql("UPDATE `DB`.pages SET slug = 'beta' WHERE slug = 'lea-beta'");
});

test('Admin → Beta: add by email or username (Discord needed), retry, reply to a report, notes, remove', async () => {
  const sid = await loginSession(ADMIN);
  let html = String((await req('/admin', { sid })).body);
  assert.match(html, /id="nav-beta"/);
  assert.match(html, /<div id="tab-beta" class="admin-tab-content/);
  await req('/admin', { sid, post: { csrf: CSRF, beta_action: 'grant', who: 'nobody@test.de' } });
  assert.equal(await flash(sid), 'No account with this email or username.');
  await req('/admin', { sid, post: { csrf: CSRF, beta_action: 'grant', who: '@LEA' } });
  assert.match(await flash(sid), /^This account has no Discord linked/);
  await sql('UPDATE `DB`.users SET discord_id = ? WHERE id = ?', [encryptData(TOM_DISCORD), TOM]);
  await req('/admin', { sid, post: { csrf: CSRF, beta_action: 'grant', who: 'tom' } });
  assert.equal(await flash(sid), 'tom@test.de is a beta tester now. The Discord bot gives the Beta Tester role.');
  await botAnswers({ state: 'not_on_server' });
  html = String((await req('/admin', { sid })).body);
  assert.match(html, /data-tester="6"[\s\S]*?Not on the Discord server[\s\S]*?Try the role again/);
  await req('/admin', { sid, post: { csrf: CSRF, beta_action: 'retry', user_id: String(TOM) } });
  assert.equal(await flash(sid), 'The Discord bot tries again.');
  assert.equal((await user(TOM)).beta_role, 'pending');
  // Eine Meldung beantworten: Status und Antwort, die Testerin bekommt eine Nachricht
  const [res] = await t.admin.query(`INSERT INTO \`${t.name}\`.beta_reports (user_id, kind, area, title, body, status, created_at, updated_at) VALUES (?, 'bug', 'editor', 'Broken thing', 'It broke.', 'open', NOW(), NOW())`, [TOM]);
  const id = (res as unknown as { insertId: number }).insertId;
  await req('/admin', { sid, post: { csrf: CSRF, beta_action: 'answer', report_id: String(id), status: 'fixed', reply: 'Fixed in 3.5 – thanks!' } });
  assert.equal(await flash(sid), 'Report saved – the tester gets a notification.');
  const [saved] = await sql('SELECT status, reply, replied_by FROM `DB`.beta_reports WHERE id = ?', [id]);
  assert.deepEqual([saved.status, saved.reply, saved.replied_by], ['fixed', 'Fixed in 3.5 – thanks!', ADMIN]);
  assert.equal((await sql("SELECT COUNT(*) AS n FROM `DB`.notifications WHERE user_id = ? AND type = 'beta' AND title = 'Your beta report: Fixed'", [TOM]))[0].n, 1);
  await req('/admin', { sid, post: { csrf: CSRF, beta_action: 'answer', report_id: String(id), status: 'party', reply: '' } });
  assert.equal(await flash(sid), 'Unknown status.');
  // Text für das Panel
  await req('/admin', { sid, post: { csrf: CSRF, beta_action: 'notes', notes: 'Test the shop.' } });
  assert.equal((await sql("SELECT meta_value FROM `DB`.oys_meta WHERE meta_key = 'beta_notes'"))[0].meta_value, 'Test the shop.');
  // Entfernen
  await req('/admin', { sid, post: { csrf: CSRF, beta_action: 'revoke', user_id: String(TOM) } });
  assert.equal(await flash(sid), 'Removed from the beta. The Discord bot takes the Beta Tester role away.');
  assert.equal((await user(TOM)).beta_at, null);
  // Nur Admins
  const mia = await loginSession(MIA);
  await req('/admin', { sid: mia, post: { csrf: CSRF, beta_action: 'grant', who: 'lea' } });
  assert.equal((await user(LEA)).beta_at, null);
});

test('a failed removal stays visible and can be tried again; the old Discord ID keeps no role silently', async () => {
  await sql('UPDATE `DB`.users SET discord_id = ? WHERE id = ?', [encryptData(TOM_DISCORD), TOM]);
  assert.deepEqual(await grantBeta(ADMIN, TOM), { ok: true }, JSON.stringify(await user(TOM)));
  await botAnswers({ state: 'given' });
  await revokeBeta(TOM);
  await botAnswers(null, 'Missing permissions: give the bot "Manage Roles"', true);
  let tom = await user(TOM);
  assert.deepEqual([tom.beta_at, tom.beta_role, tom.beta_discord], [null, 'error', TOM_DISCORD]);
  const sid = await loginSession(ADMIN);
  const html = String((await req('/admin', { sid })).body);
  assert.match(html, /data-tester="6"[\s\S]*?Removed from the beta – the Discord role couldn’t be taken away[\s\S]*?Take the role away again/);
  assert.deepEqual(await retryRole(TOM), { ok: true });
  assert.deepEqual((await jobs()).slice(-1).map((j) => [j.data.discord_id, j.data.add]), [[TOM_DISCORD, false]]);
  await botAnswers({ state: 'removed' });
  tom = await user(TOM);
  assert.deepEqual([tom.beta_role, tom.beta_discord], ['removed', null]);
  // Wechsel der ID, das Entfernen bei der alten scheitert: im Admin sichtbar, „Try again“ nimmt sie dort weg
  await grantBeta(ADMIN, TOM);
  await botAnswers({ state: 'given' });
  const NEW = '444444444444444444';
  await discordChanged(TOM, encryptData(NEW) ?? '');
  const [oldJob] = await sql("SELECT * FROM `DB`.community_outbox WHERE action = 'beta.role' AND payload LIKE ? ORDER BY id DESC LIMIT 1", ['%' + TOM_DISCORD + '%false%']);
  const job = { ...oldJob, data: JSON.parse(String(oldJob.payload)) } as unknown as OutboxJob;
  await transaction(async (_c, db) => botAction('beta.role')!.onResult!(db, job, null, 'Missing Permissions', true));
  assert.match(String((await user(TOM)).beta_role_error), new RegExp('The role stayed on the old Discord ID ' + TOM_DISCORD));
  assert.deepEqual(await retryRole(TOM), { ok: true });
  assert.deepEqual((await jobs()).slice(-2).map((j) => [j.data.discord_id, j.data.add]), [[TOM_DISCORD, false], [NEW, true]]);
  await revokeBeta(TOM);
});

test('the Discord ID is saved together with the role jobs (one step from the editor)', async () => {
  await sql('UPDATE `DB`.users SET discord_id = ? WHERE id = ?', [encryptData(TOM_DISCORD), TOM]);
  await grantBeta(ADMIN, TOM);
  const tom = await loginSession(TOM);
  const ctx = await runRequest(makeTestCtx({ method: 'POST', url: '/dashboard/api/discord', cookies: { PHPSESSID: tom }, headers: { 'x-csrf-token': CSRF, 'content-type': 'application/json' }, rawBody: Buffer.from(JSON.stringify({ discord_id: '555555555555555555', csrf: CSRF })) }), dispatch);
  assert.equal(ctx.status, 200, String(ctx.body));
  const after = await user(TOM);
  assert.equal(after.beta_discord, '555555555555555555');
  assert.deepEqual((await jobs()).slice(-2).map((j) => [j.data.discord_id, j.data.add]), [[TOM_DISCORD, false], ['555555555555555555', true]]);
  await revokeBeta(TOM);
});

test('the bell link /_/beta always opens the beta area; a page called beta stays on the path', async () => {
  const ctx = await req('/_/beta');
  assert.equal(ctx.header('Location'), 'http://beta.oys.test:8080/_beta/');
  const lea = await loginSession(LEA);
  const [page] = await sql("SELECT id FROM `DB`.pages WHERE slug = 'beta'");
  const sub = await runRequest(makeTestCtx({ method: 'POST', url: '/dashboard/api/address', cookies: { PHPSESSID: lea }, headers: { 'x-csrf-token': CSRF, 'content-type': 'application/json' }, rawBody: Buffer.from(JSON.stringify({ page_id: page.id, slug: 'beta', mode: 'subdomain', csrf: CSRF })) }), dispatch);
  assert.match(String(sub.body), /is OnYourSite’s beta area – your page stays at oys\.test:8080\/beta/);
  assert.equal((await sql("SELECT address_mode FROM `DB`.pages WHERE slug = 'beta'"))[0].address_mode, 'path');
});

test('deleting an account removes its reports and has the bot take the role away', async () => {
  const GONE = 9;
  await sql("INSERT INTO `DB`.users (id, email, password, full_name, username, discord_id, created_at) VALUES (?, 'gone@test.de', 'x', 'Gone', 'gone', ?, '2025-01-01 10:00:00')", [GONE, encryptData('666666666666666666')]);
  await grantBeta(ADMIN, GONE);
  await botAnswers({ state: 'given' });
  await sql("INSERT INTO `DB`.beta_reports (user_id, kind, area, title, body, status, created_at, updated_at) VALUES (?, 'bug', 'other', 'Old report', 'Some text here', 'open', NOW(), NOW())", [GONE]);
  await deleteAccount(null, GONE);
  assert.equal((await sql('SELECT COUNT(*) AS n FROM `DB`.beta_reports WHERE user_id = ?', [GONE]))[0].n, 0);
  assert.deepEqual((await jobs()).slice(-1).map((j) => [j.data.discord_id, j.data.add]), [['666666666666666666', false]]);
  await botAnswers({ state: 'removed' });
  assert.equal((await sql('SELECT COUNT(*) AS n FROM `DB`.users WHERE id = ?', [GONE]))[0].n, 0);
});
