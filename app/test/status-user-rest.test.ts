// Statusseiten für Nutzer, zweiter Teil (ST-4): Adresse ändern (Sperrfrist wie bei Link-Seiten, das Team ausgenommen;
// die alte Adresse bleibt 90 Tage für den Besitzer reserviert und leitet weiter), die Namensregel (der Name von
// OnYourSite nie, eine Marke im Namen markiert die Seite zur Prüfung, Admins geben sie frei), die Benachrichtigungen des
// Besitzers (E-Mail an/aus, Ereignisse), Vorfälle und Wartungen auf der eigenen Seite, der Notschalter „neue
// Freischaltungen“ und gleichzeitiges Anlegen von Bestandteilen an der Grenze.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { makeTestCtx, type Ctx } from '../src/web/ctx.js';
import { appRoutes } from '../src/app/dispatch.js';
import { ensureSchema } from '../src/schema.js';
import { nowStr } from '../src/honeycombs/clock.js';
import { buildServer } from '../src/server.js';
import { statusLimits } from '../src/status/limits.js';
import { alertRows } from '../src/status/alerts.js';
import { statusPageSettings } from '../src/status/settings.js';
import { statusTitleProblem } from '../src/status/names.js';
import '../src/status/shop.js';
import { CSRF, jsonBody, loginSession, runRequest, testDatabase, type TestDb } from './coreHarness.js';
import { randomHex } from '../src/crypto.js';

let t: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
const OLD = '2026-01-01 10:00:00';
const ADMIN = 3;
const MIA = 5;
const BEN = 6;
const LEA = 7;
const DAY = 86400;

async function sql(query: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [r] = await t.admin.query<RowDataPacket[]>(query.replace(/`DB`/g, '`' + t.name + '`'), params);
  return r;
}
async function unlock(uid: number): Promise<void> {
  await sql("INSERT INTO `DB`.honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (?, 300, 'admin', ?, '', ?)", [uid, 'st4r-' + randomHex(8), nowStr()]);
  const r = await api('shop-buy', { userId: uid, json: { item: 'status_page', request_id: randomHex(16), expected_price: 150 } });
  assert.equal(body(r).ok, true, JSON.stringify(body(r)));
}
async function api(action: string, o: { userId?: number; impersonatedBy?: number; json?: Record<string, unknown>; method?: string; query?: string } = {}): Promise<Ctx> {
  const sid = o.userId === undefined ? null : await loginSession(o.userId, { impersonatedBy: o.impersonatedBy });
  const method = o.method ?? 'POST';
  const headers: Record<string, string> = method === 'POST' ? { 'content-type': 'application/json', 'x-csrf-token': CSRF } : {};
  const ctx = makeTestCtx({ method, url: '/dashboard/api/' + action + (o.query ?? ''), headers, cookies: sid ? { PHPSESSID: sid } : undefined,
    rawBody: method === 'POST' ? Buffer.from(JSON.stringify(o.json ?? {})) : undefined });
  return runRequest(ctx, appRoutes);
}
const body = (ctx: Ctx): Record<string, any> => jsonBody(ctx) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const pageOf = async (uid: number) => (await sql('SELECT * FROM `DB`.status_pages WHERE user_id = ? AND is_system = 0', [uid]))[0];
const address = async (slug: string) => (await sql('SELECT slug, kind, ref_id, user_id, hold_until FROM `DB`.site_addresses WHERE slug = ?', [slug]))[0];
const unixNow = (): number => Math.floor(Date.now() / 1000);

before(async () => {
  t = await testDatabase('st4rest', { empty: true });
  await ensureSchema();
  const user = 'INSERT INTO `DB`.users (id, email, password, full_name, is_admin, created_at) VALUES (?, ?, \'x\', ?, ?, ?)';
  await sql(user, [ADMIN, 'admin@test.de', 'Pixel Admin', 1, OLD]);
  for (const id of [MIA, BEN, LEA]) await sql(user, [id, `u${id}@test.de`, 'User ' + id, 0, OLD]);
  for (const id of [MIA, BEN]) await unlock(id);
  app = await buildServer();
  await app.ready();
});

after(async () => {
  await app?.close();
  await t.done();
});

test('names: the OnYourSite name is refused, a brand is flagged for review, ordinary names pass', () => {
  for (const name of ['OnYourSite status', 'On Your Site uptime', 'on-your.site checks', 'OYS status', 'Status of 0nY0urS1te']) {
    assert.deepEqual(statusTitleProblem(name), { error: 'Status page names can’t use the OnYourSite name.' }, name);
  }
  assert.deepEqual(statusTitleProblem('Acme Discord bot status'), { review: 'Mentions Discord' });
  assert.deepEqual(statusTitleProblem('Our PayPal checkout'), { review: 'Mentions PayPal' });
  assert.deepEqual(statusTitleProblem('github mirror'), { review: 'Mentions GitHub' });
  // Gewöhnliche Wörter, die zufällig auch Marken sind, sind kein Fall für die Prüfung
  for (const name of ['Mia’s shop', 'Live status', 'Office printers', 'Teams and boxes', 'Signal strength', 'Boys club', 'Toys']) {
    assert.deepEqual(statusTitleProblem(name), {}, name);
  }
});

test('create and rename: the OnYourSite name is refused; a brand flags the page (noindex) until an admin approves the name', async () => {
  let r = await api('status-create', { userId: MIA, json: { title: 'OnYourSite uptime', slug: 'mia-status' } });
  assert.deepEqual(body(r), { ok: false, error: 'Status page names can’t use the OnYourSite name.', field: 'title' });
  assert.equal(await pageOf(MIA), undefined);
  r = await api('status-create', { userId: MIA, json: { title: 'Mia Discord bot', slug: 'mia-status' } });
  assert.equal(body(r).ok, true);
  let row = await pageOf(MIA);
  assert.equal(row.review_note, 'Mentions Discord');
  assert.equal(row.reviewed_at, null);
  assert.equal(body(r).page.review, 'Mentions Discord');
  // Die Seite ist für Suchmaschinen gesperrt, solange niemand den Namen freigegeben hat
  const page = await app.inject({ method: 'GET', url: '/', headers: { host: 'mia-status.oys.test:8080' } });
  assert.equal(page.statusCode, 200);
  assert.equal(page.headers['x-robots-tag'], 'noindex');
  // Umbenennen in den Namen von OnYourSite: abgelehnt, nichts geändert
  r = await api('status-page', { userId: MIA, json: { title: 'OYS mirror' } });
  assert.deepEqual(body(r), { ok: false, error: 'Status page names can’t use the OnYourSite name.', field: 'title' });
  assert.equal((await pageOf(MIA)).title, 'Mia Discord bot');
  // Ein Admin gibt den Namen frei (Formular mit Bestätigung)
  const sid = await loginSession(ADMIN);
  const post = (form: Record<string, string>) => runRequest(makeTestCtx({ method: 'POST', url: '/admin', cookies: { PHPSESSID: sid }, post: { csrf: CSRF, ...form } }), appRoutes);
  const html = String((await runRequest(makeTestCtx({ url: '/admin', cookies: { PHPSESSID: sid } }), appRoutes)).body);
  assert.match(html, /Name needs review[\s\S]*Mia Discord bot[\s\S]*Mentions Discord/);
  assert.match(html, /name="status_action" value="review_ok"/);
  let ctx = await post({ status_action: 'review_ok', page_id: String(row.id), _confirmed: '0' });
  assert.equal((await pageOf(MIA)).reviewed_at, null, 'nothing without the confirmation');
  ctx = await post({ status_action: 'review_ok', page_id: String(row.id), review_note: 'Mentions Discord', _confirmed: '1' });
  assert.equal(ctx.status, 302);
  assert.equal(ctx.header('Location'), '/admin#status');
  row = await pageOf(MIA);
  assert.ok(Number(row.reviewed_at) > 0);
  // Gleiche Marke nach dem Umbenennen: bleibt freigegeben; eine neue Marke markiert wieder
  r = await api('status-page', { userId: MIA, json: { title: 'Mia Discord helper' } });
  assert.equal(body(r).ok, true);
  assert.ok(Number((await pageOf(MIA)).reviewed_at) > 0);
  r = await api('status-page', { userId: MIA, json: { title: 'Mia Twitch helper' } });
  row = await pageOf(MIA);
  assert.equal(row.review_note, 'Mentions Twitch');
  assert.equal(row.reviewed_at, null);
  // Ohne Marke: keine Prüfung mehr nötig
  r = await api('status-page', { userId: MIA, json: { title: 'Mia’s services' } });
  row = await pageOf(MIA);
  assert.equal(row.review_note, '');
  // Nur Admins in der eigenen Sitzung geben frei
  await sql("UPDATE `DB`.status_pages SET review_note = 'Mentions Discord', reviewed_at = NULL WHERE id = ?", [row.id]);
  const asUser = await runRequest(makeTestCtx({ method: 'POST', url: '/admin', cookies: { PHPSESSID: await loginSession(BEN) }, post: { csrf: CSRF, status_action: 'review_ok', page_id: String(row.id), review_note: 'Mentions Discord', _confirmed: '1' } }), appRoutes);
  assert.equal(asUser.status, 302);
  assert.equal((await pageOf(MIA)).reviewed_at, null);
  await sql("UPDATE `DB`.status_pages SET review_note = '' WHERE id = ?", [row.id]);
});

test('address: change it, the old one forwards for 90 days and stays reserved for the owner; then once per 30 days', async () => {
  const before = await pageOf(MIA);
  assert.equal(before.slug, 'mia-status');
  // Regeln wie beim Anlegen: Marken, vergebene Adressen
  let r = await api('status-address', { userId: MIA, json: { slug: 'paypal-status' } });
  assert.equal(body(r).ok, false);
  assert.match(String(body(r).error), /contains a brand name/);
  r = await api('status-create', { userId: BEN, json: { title: 'Ben', slug: 'ben-status' } });
  assert.equal(body(r).ok, true);
  r = await api('status-address', { userId: MIA, json: { slug: 'ben-status' } });
  assert.deepEqual(body(r), { ok: false, error: 'Sorry, the address “ben-status” is already taken.', field: 'slug' });
  // Die erste Änderung geht sofort
  r = await api('status-address', { userId: MIA, json: { slug: 'Mia-Uptime' } });
  assert.equal(body(r).ok, true, JSON.stringify(body(r)));
  assert.equal(body(r).page.slug, 'mia-uptime');
  assert.equal(body(r).page.address.daysLeft, 30);
  const row = await pageOf(MIA);
  assert.equal(row.slug, 'mia-uptime');
  assert.ok(Math.abs(Number(row.slug_changed_at) - unixNow()) < 10);
  assert.deepEqual({ ...(await address('mia-uptime')), hold_until: null }, { slug: 'mia-uptime', kind: 'status', ref_id: row.id, user_id: MIA, hold_until: null });
  const held = await address('mia-status');
  assert.equal(held.kind, 'held');
  assert.equal(held.user_id, MIA);
  const holdDays = (Date.parse(String(held.hold_until).replace(' ', 'T') + 'Z') / 1000 - unixNow()) / DAY;
  assert.ok(holdDays > 89 && holdDays <= 90.1, 'held for 90 days: ' + holdDays);
  const redirect = (await sql('SELECT * FROM `DB`.status_slug_redirects WHERE slug = ?', ['mia-status']))[0];
  assert.equal(Number(redirect.page_id), Number(row.id));
  assert.ok(Math.abs(Number(redirect.until) - (unixNow() + 90 * DAY)) < 10);
  // Die alte Adresse leitet weiter, mit demselben Pfad
  const old = await app.inject({ method: 'GET', url: '/history', headers: { host: 'mia-status.oys.test:8080' } });
  assert.equal(old.statusCode, 302);
  assert.equal(old.headers.location, 'http://mia-uptime.oys.test:8080/history');
  // Niemand sonst bekommt die alte Adresse
  r = await api('status-address', { userId: BEN, json: { slug: 'mia-status' } });
  assert.equal(body(r).ok, false);
  // Die zweite Änderung erst nach 30 Tagen
  r = await api('status-address', { userId: MIA, json: { slug: 'mia-uptime-two' } });
  assert.equal(body(r).ok, false);
  assert.match(String(body(r).error), /^You can change the address again on [A-Z][a-z]{2} \d{1,2}, \d{4}\.$/);
  // Nach 30 Tagen zurück zur alten Adresse: die Weiterleitung dorthin endet, die von der zweiten beginnt
  await sql('UPDATE `DB`.status_pages SET slug_changed_at = ? WHERE id = ?', [unixNow() - 31 * DAY, row.id]);
  r = await api('status-address', { userId: MIA, json: { slug: 'mia-status' } });
  assert.equal(body(r).ok, true, JSON.stringify(body(r)));
  assert.equal((await sql('SELECT COUNT(*) AS n FROM `DB`.status_slug_redirects WHERE slug = ?', ['mia-status']))[0].n, 0);
  assert.equal((await sql('SELECT COUNT(*) AS n FROM `DB`.status_slug_redirects WHERE slug = ?', ['mia-uptime']))[0].n, 1);
  assert.equal((await address('mia-status')).kind, 'status');
  const back = await app.inject({ method: 'GET', url: '/', headers: { host: 'mia-status.oys.test:8080' } });
  assert.equal(back.statusCode, 200);
  // Dieselbe Adresse: nichts passiert, keine Sperrfrist verbraucht
  await sql('UPDATE `DB`.status_pages SET slug_changed_at = NULL WHERE id = ?', [row.id]);
  r = await api('status-address', { userId: MIA, json: { slug: 'mia-status' } });
  assert.equal(body(r).ok, true);
  assert.equal((await pageOf(MIA)).slug_changed_at, null);
});

test('address: the team has no waiting time; OnYourSite’s own page keeps its address', async () => {
  let r = await api('status-create', { userId: ADMIN, json: { title: 'Pixel', slug: 'pixel-status' } });
  assert.equal(body(r).ok, true, JSON.stringify(body(r)));
  r = await api('status-address', { userId: ADMIN, json: { slug: 'pixel-uptime' } });
  assert.equal(body(r).ok, true);
  assert.equal(body(r).page.address.daysLeft, 0);
  r = await api('status-address', { userId: ADMIN, json: { slug: 'pixel-checks' } });
  assert.equal(body(r).ok, true, 'no cooldown for staff');
  r = await api('status-address', { userId: ADMIN, json: { scope: 'system', slug: 'status-two' } });
  assert.equal(r.status, 403);
  assert.equal((await sql('SELECT slug FROM `DB`.status_pages WHERE is_system = 1'))[0].slug, 'status');
});

test('owner alerts: email on or off and the events; the bell always; only for the own page', async () => {
  let r = await api('status', { userId: MIA, method: 'GET' });
  assert.deepEqual(body(r).page.alerts, { email: true, events: ['down', 'up', 'degraded', 'cert', 'heartbeat'] });
  r = await api('status-owner-alerts', { userId: MIA, json: { email: false, events: ['down', 'up'] } });
  assert.equal(body(r).ok, true);
  assert.deepEqual(body(r).page.alerts, { email: false, events: ['down', 'up'] });
  r = await api('status-owner-alerts', { userId: MIA, json: { events: ['down', 'nope'] } });
  assert.deepEqual(body(r), { ok: false, error: 'Please choose the events again.', field: 'events' });
  // Was die Benachrichtigungen daraus machen: ohne E-Mail nur die Glocke, nur die gewählten Ereignisse
  const settings = statusPageSettings({ settings: String((await pageOf(MIA)).settings), is_system: 0 });
  const src = (kind: string) => ({ page: { id: 1, slug: 'mia-status', title: 'Mia', isSystem: false, userId: MIA }, monitor: { id: 1, name: 'Web', type: 'http', target: 'https://example.com', isPublic: true }, event: { kind, at: unixNow(), error: null } });
  assert.deepEqual(alertRows(src('down') as never, settings).map((x) => x.channel), ['bell']);
  assert.deepEqual(alertRows(src('degraded') as never, settings), []);
  await api('status-owner-alerts', { userId: MIA, json: { email: true } });
  const on = statusPageSettings({ settings: String((await pageOf(MIA)).settings), is_system: 0 });
  assert.deepEqual(alertRows(src('down') as never, on).map((x) => x.channel), ['owner', 'bell']);
  // OnYourSites Seite hat ihre eigenen Alarme (scope system, Admins); im Nutzerbereich gibt es diese Aktion dort nicht
  r = await api('status-owner-alerts', { userId: ADMIN, json: { scope: 'system', email: false } });
  assert.equal(r.status, 403);
});

test('incidents and maintenance on the own page: report, update, resolve, delete – never on another page', async () => {
  let r = await api('status-monitor-save', { userId: MIA, json: { type: 'manual', name: 'API', public: true } });
  assert.equal(body(r).ok, true, JSON.stringify(body(r)));
  const mon = Number((await sql('SELECT id FROM `DB`.status_monitors WHERE page_id = ?', [(await pageOf(MIA)).id]))[0].id);
  r = await api('status-incident-save', { userId: MIA, json: { kind: 'incident', title: 'API slow <b>', status: 'investigating', impact: 'minor', body: 'Looking into it.', monitors: [{ id: mon, effect: 'degraded' }], discord: false } });
  assert.equal(body(r).ok, true, JSON.stringify(body(r)));
  const inc = Number((await sql('SELECT id FROM `DB`.status_incidents WHERE page_id = ? ORDER BY id DESC LIMIT 1', [(await pageOf(MIA)).id]))[0].id);
  // Öffentlich sichtbar, der Titel als Text
  const pub = await app.inject({ method: 'GET', url: '/', headers: { host: 'mia-status.oys.test:8080' } });
  assert.ok(pub.body.includes('API slow &lt;b&gt;'));
  r = await api('status-incident-update', { userId: MIA, json: { id: inc, status: 'resolved', body: 'Fixed.' } });
  assert.equal(body(r).ok, true, JSON.stringify(body(r)));
  assert.equal((await sql('SELECT status FROM `DB`.status_incidents WHERE id = ?', [inc]))[0].status, 'resolved');
  // Wartung in der Zukunft
  const start = unixNow() + 3600;
  r = await api('status-incident-save', { userId: MIA, json: { kind: 'maintenance', title: 'Upgrade', starts_at: start, ends_at: start + 3600, body: 'New servers.', monitors: [{ id: mon }], discord: false } });
  assert.equal(body(r).ok, true, JSON.stringify(body(r)));
  // Eine fremde Seite: Ben kann Mias Vorfall weder ändern noch löschen
  for (const [action, json] of [['status-incident-update', { id: inc, status: 'investigating', body: 'x' }], ['status-incident-delete', { id: inc }], ['status-incident-edit', { id: inc, update_id: 1, body: 'x' }]] as const) {
    r = await api(action, { userId: BEN, json });
    assert.equal(body(r).ok, false, action);
  }
  assert.equal((await sql('SELECT COUNT(*) AS n FROM `DB`.status_incidents WHERE id = ?', [inc]))[0].n, 1);
  r = await api('status-incident-delete', { userId: MIA, json: { id: inc } });
  assert.equal(body(r).ok, true);
  assert.equal((await sql('SELECT COUNT(*) AS n FROM `DB`.status_incidents WHERE id = ?', [inc]))[0].n, 0);
});

test('the module switch “new unlocks” stops buying, not those who unlocked before', async () => {
  await sql("REPLACE INTO `DB`.oys_meta (meta_key, meta_value) VALUES ('status', ?)", [JSON.stringify({ allow_new: false })]);
  try {
    await sql("INSERT INTO `DB`.honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (?, 300, 'admin', ?, '', ?)", [LEA, 'st4r-' + randomHex(8), nowStr()]);
    const balance = async () => Number((await sql('SELECT COALESCE(SUM(amount), 0) AS n FROM `DB`.honeycomb_ledger WHERE user_id = ?', [LEA]))[0].n);
    const had = await balance();
    const r = await api('shop-buy', { userId: LEA, json: { item: 'status_page', request_id: randomHex(16), expected_price: 150 } });
    assert.equal(body(r).ok, false);
    assert.equal(body(r).error, 'New status pages aren’t available right now.');
    assert.equal(await balance(), had);
    assert.equal((await statusLimits(LEA)).plan, 'none');
    // Wer schon freigeschaltet hat, legt weiter an und ändert (Ben hat eine Seite, Mia auch)
    const ok = await api('status-page', { userId: BEN, json: { description: 'still works' } });
    assert.equal(body(ok).ok, true);
  } finally {
    await sql("DELETE FROM `DB`.oys_meta WHERE meta_key = 'status'");
  }
});

test('race: components added at the same time never pass the limit', async () => {
  const page = await pageOf(BEN);
  const limit = (await statusLimits(BEN)).components;
  assert.ok(limit > 0 && limit < 50);
  const results = await Promise.all(Array.from({ length: limit + 5 }, (_, i) => api('status-monitor-save', { userId: BEN, json: { type: 'manual', name: 'C' + i, public: true } })));
  const okCount = results.filter((r) => body(r).ok === true).length;
  const n = Number((await sql('SELECT COUNT(*) AS n FROM `DB`.status_monitors WHERE page_id = ?', [page.id]))[0].n);
  assert.equal(n, limit);
  assert.equal(okCount, limit);
});

test('review: look-alike letters, a second brand and the admin approving only the name shown', async () => {
  // Kyrillische und griechische Buchstaben, die wie lateinische aussehen, zählen wie diese
  assert.deepEqual(statusTitleProblem('OnYоurSite status'), { error: 'Status page names can’t use the OnYourSite name.' }, 'Cyrillic o');
  assert.deepEqual(statusTitleProblem('Pаypal status'), { review: 'Mentions PayPal' }, 'Cyrillic a');
  assert.deepEqual(statusTitleProblem('Dіscοrd bot'), { review: 'Mentions Discord' }, 'Cyrillic i, Greek o');
  assert.deepEqual(statusTitleProblem('O.Y.S. status'), { error: 'Status page names can’t use the OnYourSite name.' });
  // Mehrere Marken: alle in der Notiz (sortiert)
  assert.deepEqual(statusTitleProblem('Discord PayPal login'), { review: 'Mentions Discord, PayPal' });
  // Gewöhnliche Wörter, die eine Marke nur enthalten
  for (const name of ['Credit Union status', 'Accredited Labs', 'Goggles shop', 'Python Your Site', 'Weather outlook']) assert.deepEqual(statusTitleProblem(name), {}, name);

  const page = await pageOf(MIA);
  await api('status-page', { userId: MIA, json: { title: 'Acme Discord status' } });
  await sql('UPDATE `DB`.status_pages SET reviewed_at = ? WHERE id = ?', [unixNow(), page.id]);
  // Eine zweite Marke dazu: wieder zur Prüfung
  await api('status-page', { userId: MIA, json: { title: 'Discord PayPal login – verify your account' } });
  let row = await pageOf(MIA);
  assert.equal(row.review_note, 'Mentions Discord, PayPal');
  assert.equal(row.reviewed_at, null);
  // Der Admin sah „Mentions Discord, PayPal“; inzwischen heißt die Seite anders: die Freigabe gilt nicht
  const sid = await loginSession(ADMIN);
  const approve = (note: string) => runRequest(makeTestCtx({ method: 'POST', url: '/admin', cookies: { PHPSESSID: sid }, post: { csrf: CSRF, status_action: 'review_ok', page_id: String(page.id), review_note: note, _confirmed: '1' } }), appRoutes);
  await api('status-page', { userId: MIA, json: { title: 'Twitch support verify' } });
  await approve('Mentions Discord, PayPal');
  row = await pageOf(MIA);
  assert.equal(row.reviewed_at, null, 'a name the admin didn’t see stays in review');
  await approve('Mentions Twitch');
  assert.ok(Number((await pageOf(MIA)).reviewed_at) > 0);
  // Ein Admin im Nutzer-Modus gibt nichts frei
  await sql("UPDATE `DB`.status_pages SET review_note = 'Mentions Twitch', reviewed_at = NULL WHERE id = ?", [page.id]);
  await runRequest(makeTestCtx({ method: 'POST', url: '/admin', cookies: { PHPSESSID: await loginSession(BEN, { impersonatedBy: ADMIN }) }, post: { csrf: CSRF, status_action: 'review_ok', page_id: String(page.id), review_note: 'Mentions Twitch', _confirmed: '1' } }), appRoutes);
  assert.equal((await pageOf(MIA)).reviewed_at, null);
  await api('status-page', { userId: MIA, json: { title: 'Mia’s services' } });
});

test('address: the old address forwards on the main domain too; changes are rate limited', async () => {
  const page = await pageOf(MIA);
  await sql('UPDATE `DB`.status_pages SET slug_changed_at = NULL WHERE id = ?', [page.id]);
  let r = await api('status-address', { userId: MIA, json: { slug: 'mia-moved' } });
  assert.equal(body(r).ok, true, JSON.stringify(body(r)));
  const old = await app.inject({ method: 'GET', url: '/mia-status', headers: { host: 'oys.test:8080' } });
  assert.equal(old.statusCode, 302);
  assert.equal(old.headers.location, 'http://mia-moved.oys.test:8080/');
  // Viele Versuche in einer Stunde: Schluss (auch für das Team, das keine Sperrfrist hat)
  for (let i = 0; i < 10; i++) await api('status-address', { userId: ADMIN, json: { slug: 'pixel-r' + i } });
  r = await api('status-address', { userId: ADMIN, json: { slug: 'pixel-final' } });
  assert.deepEqual(body(r), { ok: false, error: 'You’re doing this very often – please wait a bit.' });
});
