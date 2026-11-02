// Öffentliche Vorschlagsseite mit Datenbank und dem ganzen Server: visible() für jede Kombination, die Seite (404 aus,
// kein Cookie, nur sichtbare Vorschläge ohne Namen, Filter, Seiten, Dauerlinks, Schrägstrich), die Pillen und Links der
// anderen Seiten, das Admin (Seite an/aus mit Rückfrage, Zeigen/Verbergen mit Warnung, CSRF), die Schnittstelle des Bots
// (web, web_notice, gelöschte Beiträge, Liste für die tägliche Prüfung, suggestions.notice nur für suggestions.v2), der
// Schritt V_PUBLIC_PAGES (eine Nachricht je Besitzer, genau einmal) und die Adressregel im Editor.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { configString, setConfigForTests, type ConfigData } from '../src/config.js';
import { exec, one, q, value, withConnection } from '../src/db.js';
import { date, time } from '../src/php.js';
import { buildServer } from '../src/server.js';
import { V_PUBLIC_PAGES, ensureSchema, hasIndex } from '../src/schema.js';
import { suggestionsPageOn, visible } from '../src/community/suggestions.js';
import { slugProblem } from '../src/helpers.js';
import { adminPage } from '../src/admin/page.js';
import { appRoutes } from '../src/app/dispatch.js';
import { isHalt, makeTestCtx } from '../src/web/ctx.js';
import { Session } from '../src/web/session.js';
import { UNCONFIRMED_MESSAGE } from '../src/views/partials/ui.js';
import { BASE, CSRF, jsonBody, loginSession, runRequest, testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
let app: FastifyInstance;
const HOST = 'oys.test:8080';
const SECRET = configString('bot_secret');
const ID = (n: number): string => String(1400000000000000000n + BigInt(n));
const ADMIN = 3;

function useConfig(extra: ConfigData = {}): void {
  setConfigForTests({ ...BASE, db: { ...(BASE.db as ConfigData), name: t.name }, ...extra });
}

before(async () => {
  assert.ok(SECRET.length >= 32, 'the test settings need a bot_secret');
  t = await testDatabase('sugg');
  useConfig();
  app = await buildServer();
  await app.ready();
});

after(async () => {
  await app?.close();
  await t?.done();
});

beforeEach(async () => {
  useConfig();
  for (const sql of ['DELETE FROM community_suggestions', 'DELETE FROM community_outbox', "DELETE FROM oys_meta WHERE meta_key IN ('community_pages', 'discord_bot_report')",
    "DELETE FROM pages WHERE slug = 'suggestions'", 'DELETE FROM rate_limits']) await exec(sql);
});

// ------------------------------------------------------------------ Hilfen

const setPage = (mode: 'on' | 'off' | null): Promise<unknown> => (mode === null
  ? exec("DELETE FROM oys_meta WHERE meta_key = 'community_pages'")
  : exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('community_pages', ?)", [JSON.stringify({ suggestions: mode })]));

let threadNo = 0;
interface Sug { status?: string; web_state?: string; web_notice?: number; removed?: boolean; title?: string; body?: string; reason?: string }
async function addSuggestion(s: Sug = {}): Promise<number> {
  const res = await exec(`INSERT INTO community_suggestions (thread_id, author_id, author_name, title, body, status, reason, decided_by, decided_via, decided_at,
      web_state, web_notice, removed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    ID(++threadNo), ID(900), 'Secret Author Name', s.title ?? 'Idea ' + threadNo, s.body ?? 'Text ' + threadNo, s.status ?? 'accepted', s.reason ?? '',
    s.status === 'open' ? '' : 'Secret Team Name', s.status === 'open' ? '' : 'discord', s.status === 'open' ? null : date('Y-m-d H:i:s'),
    s.web_state ?? 'auto', s.web_notice ?? 1, s.removed ? date('Y-m-d H:i:s') : null, date('Y-m-d H:i:s'), date('Y-m-d H:i:s'),
  ]);
  return res.insertId;
}

interface Res { status: number; headers: Record<string, unknown>; body: string }
async function get(path: string): Promise<Res> {
  const res = await app.inject({ method: 'GET', url: path, headers: { host: HOST } });
  return { status: res.statusCode, headers: res.headers, body: res.body };
}

// Signierte Anfrage wie der Bot (site.js)
async function bot(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const ts = String(time());
  const sig = createHmac('sha256', SECRET).update(`${ts}\n${method}\n${path}\n${method === 'GET' ? '' : payload}`).digest('hex');
  const headers: Record<string, string> = { host: HOST, 'x-oys-timestamp': ts, 'x-oys-signature': sig };
  if (payload !== '') headers['content-type'] = 'application/json';
  const res = await app.inject({ method, url: path, headers, payload: payload === '' ? undefined : payload });
  return { status: res.statusCode, json: res.body === '' ? {} : (JSON.parse(res.body) as Record<string, unknown>) };
}

// POST /admin wie über den Server (Sitzung des Admins, CSRF)
async function adminPost(form: Record<string, unknown>, opts: { csrf?: boolean } = {}): Promise<{ location: string; ok?: string; error?: string }> {
  const pre = makeTestCtx({ url: '/admin' });
  const s = await Session.start(pre);
  s.set('user_id', ADMIN);
  s.set('csrf', CSRF);
  await s.close();
  const ctx = makeTestCtx({ method: 'POST', url: '/admin', cookies: { PHPSESSID: s.id }, post: opts.csrf === false ? form : { csrf: CSRF, ...form } });
  await Session.start(ctx);
  try {
    await adminPage(ctx, (await one('SELECT * FROM users WHERE id = ?', [ADMIN]))!);
  } catch (err) {
    if (!isHalt(err)) throw err;
  } finally {
    await ctx.session?.close();
  }
  const data = ctx.session!.data;
  return { location: String(ctx.header('Location') ?? ''), ok: data.admin_success as string | undefined, error: data.admin_error as string | undefined };
}

// ------------------------------------------------------------------ visible()

test('visible() decides alike for every combination of page, bot secret, web_state, web_notice, status and removed_at', async () => {
  const rows: Array<{ id: number; web_state: string; web_notice: number; status: string; removed: boolean }> = [];
  for (const web_state of ['auto', 'shown', 'hidden']) for (const web_notice of [0, 1]) for (const status of ['open', 'accepted', 'declined']) for (const removed of [false, true]) {
    rows.push({ id: await addSuggestion({ web_state, web_notice, status, removed }), web_state, web_notice, status, removed });
  }
  const rule = (r: (typeof rows)[number], on: boolean): boolean =>
    on && !r.removed && (r.web_state === 'shown' || (r.web_state === 'auto' && r.web_notice === 1 && r.status !== 'open'));
  const cases: Array<[string, () => Promise<unknown>, boolean]> = [
    ['on', () => setPage('on'), true], ['off', () => setPage('off'), false], ['never saved', () => setPage(null), false],
    ['broken JSON', () => exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('community_pages', '{oops')"), false],
  ];
  for (const secret of [SECRET, '']) {
    useConfig({ bot_secret: secret });
    for (const [name, prepare, wanted] of cases) {
      await prepare();
      const on = await suggestionsPageOn();
      assert.equal(on, wanted && secret !== '', `${name}, secret ${secret ? 'set' : 'empty'}`);
      const got = (await q(`SELECT id FROM community_suggestions WHERE ${visible(on)} ORDER BY id`)).map((r) => Number(r.id));
      assert.deepEqual(got, rows.filter((r) => rule(r, on)).map((r) => r.id), `${name}, secret ${secret ? 'set' : 'empty'}`);
    }
  }
});

// ------------------------------------------------------------------ öffentliche Seite

test('/suggestions answers 404 while off or without the bot; on, it lists only visible ones – no names, no cookie', async () => {
  const s1 = await addSuggestion({ title: 'Accepted and told', reason: 'Great idea' });
  const s2 = await addSuggestion({ status: 'declined', title: 'Declined and told' });
  const s3 = await addSuggestion({ status: 'open', title: 'Open and told' });
  const s4 = await addSuggestion({ web_notice: 0, title: 'Accepted, never told' });
  const s5 = await addSuggestion({ status: 'open', web_state: 'shown', title: 'Open, shown by the team' });
  const s6 = await addSuggestion({ web_state: 'hidden', title: 'Hidden by the team' });
  const s7 = await addSuggestion({ web_state: 'shown', removed: true, title: 'Deleted in Discord' });
  assert.equal((await get('/suggestions')).status, 404, 'off by default');
  assert.equal((await get('/suggestions/' + s1)).status, 404);
  await setPage('on');
  useConfig({ bot_secret: '' });
  assert.equal((await get('/suggestions')).status, 404, 'off while the bot isn’t set up');
  useConfig();
  const r = await get('/suggestions');
  assert.equal(r.status, 200);
  assert.equal(r.headers['set-cookie'], undefined, 'no cookie for visitors');
  for (const title of ['Accepted and told', 'Declined and told', 'Open, shown by the team']) assert.match(r.body, new RegExp(title));
  for (const title of ['Open and told', 'Accepted, never told', 'Hidden by the team', 'Deleted in Discord']) assert.doesNotMatch(r.body, new RegExp(title));
  assert.doesNotMatch(r.body, /Secret Author Name|Secret Team Name|1400000000000000900/, 'never a name or a member’s Discord ID');
  assert.match(r.body, /Note from the team<\/p>\s*<p class="mt-1 whitespace-pre-line break-words">Great idea/);
  assert.match(r.body, />All <span class="text-gray-500">3<\/span>/);
  assert.match(r.body, />Open <span class="text-gray-500">1<\/span>/);
  assert.doesNotMatch(r.body, /name="robots"/);
  // Filter (unbekannte zählen als alle), gefiltert nicht in Suchmaschinen
  const accepted = await get('/suggestions?status=accepted');
  assert.match(accepted.body, /Accepted and told/);
  assert.doesNotMatch(accepted.body, /Declined and told/);
  assert.match(accepted.body, /<meta name="robots" content="noindex, follow">/);
  assert.match((await get('/suggestions?status=%3Cscript%3E')).body, /Declined and told/);
  assert.match((await get('/suggestions?page=999&status[]=x')).body, /Accepted and told/, 'pages are clamped');
  // Dauerlinks: sichtbar → Seite und Anker, sonst zur Liste
  const link = await app.inject({ method: 'GET', url: '/suggestions/' + s2, headers: { host: HOST } });
  assert.deepEqual([link.statusCode, link.headers.location], [302, '/suggestions#suggestion-' + s2]);
  for (const hidden of [s3, s4, s6, s7, 999999]) {
    const h = await app.inject({ method: 'GET', url: '/suggestions/' + hidden, headers: { host: HOST } });
    assert.deepEqual([h.statusCode, h.headers.location], [302, '/suggestions']);
  }
  assert.ok(s5 > 0);
});

test('paging keeps 20 per page; a permalink finds the right page; the trailing slash is forwarded even with a path page of that name', async () => {
  await setPage('on');
  const ids: number[] = [];
  for (let i = 0; i < 25; i++) ids.push(await addSuggestion({ title: 'Paged idea ' + i }));
  const first = await get('/suggestions');
  assert.match(first.body, /Page 1 of 2/);
  assert.match(first.body, /href="\/suggestions\?page=2#list"/);
  const second = await get('/suggestions?page=2');
  assert.match(second.body, /Paged idea 0\b/);
  assert.doesNotMatch(second.body, /Paged idea 24\b/);
  assert.match(second.body, /<link rel="canonical" href="http:\/\/oys\.test:8080\/suggestions\?page=2">/);
  const link = await app.inject({ method: 'GET', url: '/suggestions/' + ids[0], headers: { host: HOST } });
  assert.equal(link.headers.location, '/suggestions?page=2#suggestion-' + ids[0]);
  // Eine Link-Seite namens „suggestions“ im Pfad-Modus (z. B. von Hand zurückgestellt): die Adressen bleiben die der Seite
  await exec("INSERT INTO pages (user_id, slug, address_mode, title, created_at, updated_at) VALUES (5, 'suggestions', 'path', 'Not the real page', NOW(), NOW())");
  for (const path of ['/suggestions/', '/Suggestions', '/suggestions/?x=1']) {
    const res = await app.inject({ method: 'GET', url: path, headers: { host: HOST } });
    assert.equal(res.statusCode, 301, path);
    assert.equal(res.headers['cache-control'], 'max-age=3600');
    assert.match(String(res.headers.location), /^\/suggestions(\?x=1)?$/);
  }
  assert.equal((await get('/suggestions/kalender')).status, 404);
  assert.doesNotMatch((await get('/suggestions')).body, /Not the real page/);
});

test('the Suggestions pill and the landing page link appear only while the page is on', async () => {
  for (const path of ['/updates', '/roadmap', '/']) assert.doesNotMatch((await get(path)).body, /href="\/suggestions"/, path);
  await setPage('on');
  for (const path of ['/updates', '/roadmap']) assert.match((await get(path)).body, /<a href="\/suggestions" class="[^"]*"><i class='bx bx-bulb hidden sm:inline-block'><\/i> Suggestions<\/a>/, path);
  assert.match((await get('/')).body, /<a href="\/suggestions" class="inline-block py-2 hover:text-white transition-colors">Suggestions<\/a>/);
});

// ------------------------------------------------------------------ Admin

test('admin: the page is turned on only with the bot and after the confirmation; the bot gets the guideline sentence', async () => {
  useConfig({ bot_secret: '' });
  assert.equal((await adminPost({ community_action: 'suggestions_page', suggestions: 'on', _confirmed: '1' })).error, 'The suggestions page needs the Discord bot.');
  useConfig();
  assert.equal((await adminPost({ community_action: 'suggestions_page', suggestions: 'on' })).error, 'Please confirm turning on the suggestions page.');
  assert.equal((await adminPost({ community_action: 'suggestions_page', suggestions: 'on', _confirmed: '0' })).error, UNCONFIRMED_MESSAGE);
  assert.equal((await adminPost({ community_action: 'suggestions_page', suggestions: 'on', _confirmed: '1' }, { csrf: false })).error, 'Session expired – please try again.');
  assert.equal((await adminPost({ community_action: 'suggestions_page', suggestions: 'maybe' })).error, 'Please choose on or off.');
  assert.equal(await suggestionsPageOn(), false);
  const on = await adminPost({ community_action: 'suggestions_page', suggestions: 'on', _confirmed: '1' });
  assert.deepEqual([on.ok, on.location], ['The suggestions page is on.', '/admin#community']);
  assert.equal(await suggestionsPageOn(), true);
  const jobs = async () => q("SELECT payload, ref, done_at, last_error FROM community_outbox WHERE action = 'suggestions.notice' ORDER BY id");
  assert.deepEqual((await jobs()).map((j) => [JSON.parse(String(j.payload)), j.ref, j.done_at]), [[{ on: true, text: 'Decided ideas are shown on oys.test:8080/suggestions without your name.' }, 'notice', null]]);
  // Aus: der noch nicht abgeholte Auftrag wird ersetzt
  assert.equal((await adminPost({ community_action: 'suggestions_page', suggestions: 'off' })).ok, 'The suggestions page is off.');
  const after2 = await jobs();
  assert.equal(after2[0].last_error, 'superseded');
  assert.deepEqual(JSON.parse(String(after2[1].payload)), { on: false, text: 'Decided ideas are shown on oys.test:8080/suggestions without your name.' });
  assert.equal(await suggestionsPageOn(), false);
});

test('admin: show and hide one suggestion; an author who wasn’t told needs the warning; a deleted post can’t be shown', async () => {
  await setPage('on');
  const told = await addSuggestion();
  const untold = await addSuggestion({ web_notice: 0 });
  const removed = await addSuggestion({ removed: true });
  const hide = await adminPost({ community_action: 'suggestion_web', id: String(told), state: 'hidden', filter: 'accepted' });
  assert.deepEqual([hide.ok, hide.location], [`Suggestion #${told} is now hidden on the website.`, '/admin?suggestions=accepted#community']);
  assert.equal((await one('SELECT web_state FROM community_suggestions WHERE id = ?', [told]))!.web_state, 'hidden');
  assert.equal((await adminPost({ community_action: 'suggestion_web', id: String(untold), state: 'shown' })).error,
    'Please confirm showing this suggestion – its author wasn’t told it could appear on the website.');
  assert.equal((await one('SELECT web_state FROM community_suggestions WHERE id = ?', [untold]))!.web_state, 'auto');
  assert.equal((await adminPost({ community_action: 'suggestion_web', id: String(untold), state: 'shown', _confirmed: '1' })).ok, `Suggestion #${untold} is now shown on the website.`);
  assert.match((await get('/suggestions')).body, new RegExp(`id="suggestion-${untold}"`));
  assert.equal((await adminPost({ community_action: 'suggestion_web', id: String(removed), state: 'shown', _confirmed: '1' })).error,
    'This suggestion was deleted in Discord – it can’t be shown on the website.');
  assert.equal((await adminPost({ community_action: 'suggestion_web', id: '999999', state: 'shown' })).error, 'Suggestion not found.');
  assert.equal((await adminPost({ community_action: 'suggestion_web', id: String(told), state: 'public' })).error, 'Suggestion not found.');
  assert.equal((await adminPost({ community_action: 'suggestion_web', id: String(told), state: 'shown' }, { csrf: false })).error, 'Session expired – please try again.');
  assert.equal((await one('SELECT web_state FROM community_suggestions WHERE id = ?', [told]))!.web_state, 'hidden');
  // Die Ansicht: Karte mit Zahlen, Abzeichen mit Grund, Knöpfe
  const sid = await loginSession(ADMIN);
  const view = await app.inject({ method: 'GET', url: '/admin?suggestions=all', headers: { host: HOST, cookie: 'PHPSESSID=' + sid } });
  assert.match(view.body, /On the website: 1 · Waiting for a decision: 0 · Not shown: 2/);
  assert.match(view.body, /title="hidden by the team">Not on the website<\/span>/);
  assert.match(view.body, />Deleted in Discord<\/span>/);
  assert.match(view.body, /value="suggestion_web"><input type="hidden" name="id" value="\d+"><input type="hidden" name="state" value="shown"/);
  assert.match(view.body, /data-confirm="Turn on the suggestions page\?"/);
});

test('a decision tells the bot whether new posts get the website note (web on the suggestion)', async () => {
  const id = await addSuggestion({ status: 'open' });
  await adminPost({ community_action: 'suggestion_decide', id: String(id), status: 'accepted' });
  await setPage('on');
  const other = await addSuggestion({ status: 'open' });
  await adminPost({ community_action: 'suggestion_decide', id: String(other), status: 'declined' });
  const jobs = await q("SELECT payload FROM community_outbox WHERE action = 'suggestion.decided' ORDER BY id");
  assert.deepEqual(jobs.map((j) => (JSON.parse(String(j.payload)) as Record<string, unknown>).web), [{ notice: false, host: HOST }, { notice: true, host: HOST }]);
});

// ------------------------------------------------------------------ Bot

test('bot API: web on every suggestion answer, web_notice only for exactly true, ping lists suggestions.v2', async () => {
  const ping = await bot('GET', '/_/bot/ping');
  assert.ok((ping.json.features as string[]).includes('suggestions.v2'));
  await setPage('on');
  const created = await bot('POST', '/_/bot/suggestions', { thread_id: ID(500), author_id: ID(501), author_name: 'Mia', title: 'New idea', body: 'Text' });
  const s = created.json.suggestion as Record<string, unknown>;
  assert.deepEqual(s.web, { notice: true, host: HOST });
  for (const weird of ['true', 1, null]) {
    await bot('POST', `/_/bot/suggestions/${s.id}`, { status_message_id: ID(502), web_notice: weird });
    assert.equal(Number((await one('SELECT web_notice FROM community_suggestions WHERE id = ?', [s.id as number]))!.web_notice), 0, JSON.stringify(weird));
  }
  const noted = await bot('POST', `/_/bot/suggestions/${s.id}`, { status_message_id: ID(502), web_notice: true });
  assert.equal(noted.status, 200);
  assert.equal(Number((await one('SELECT web_notice FROM community_suggestions WHERE id = ?', [s.id as number]))!.web_notice), 1);
  const decided = await bot('POST', `/_/bot/suggestions/${s.id}/decision`, { thread_id: ID(500), status: 'accepted', by_name: 'Team' });
  assert.deepEqual((decided.json.suggestion as Record<string, unknown>).web, { notice: true, host: HOST });
  // Jetzt sichtbar: entschieden und der Autor weiß Bescheid
  assert.match((await get('/suggestions')).body, /New idea/);
});

test('bot API: a deleted post erases the text (the title stays for the admin), only its first message erases the text; unknown is 404', async () => {
  await setPage('on');
  const id = await addSuggestion({ title: 'To be deleted', body: 'Private words' });
  const thread = String((await one('SELECT thread_id FROM community_suggestions WHERE id = ?', [id]))!.thread_id);
  const other = await addSuggestion({ title: 'Only the text', body: 'More words' });
  const otherThread = String((await one('SELECT thread_id FROM community_suggestions WHERE id = ?', [other]))!.thread_id);
  assert.deepEqual(await bot('POST', `/_/bot/suggestions/thread/${otherThread}`, { body_deleted: true }), { status: 200, json: { ok: true } });
  let row = (await one('SELECT body, removed_at, title FROM community_suggestions WHERE id = ?', [other]))!;
  assert.deepEqual([row.body, row.removed_at, row.title], ['', null, 'Only the text']);
  assert.deepEqual(await bot('POST', `/_/bot/suggestions/thread/${thread}`, { deleted: true }), { status: 200, json: { ok: true } });
  row = (await one('SELECT body, removed_at, title FROM community_suggestions WHERE id = ?', [id]))!;
  assert.equal(row.body, '');
  assert.notEqual(row.removed_at, null);
  assert.equal(row.title, 'To be deleted');
  const removedAt = row.removed_at;
  // Noch einmal: der Zeitpunkt bleibt
  await exec('UPDATE community_suggestions SET removed_at = ? WHERE id = ?', ['2026-01-01 00:00:00', id]);
  await bot('POST', `/_/bot/suggestions/thread/${thread}`, { deleted: true });
  assert.equal(String((await one('SELECT removed_at FROM community_suggestions WHERE id = ?', [id]))!.removed_at), '2026-01-01 00:00:00');
  assert.ok(removedAt);
  const page = await get('/suggestions');
  assert.doesNotMatch(page.body, /To be deleted|Private words/);
  assert.match(page.body, /Only the text/);
  assert.deepEqual(await bot('POST', `/_/bot/suggestions/thread/${ID(999)}`, { deleted: true }), { status: 404, json: { ok: false, error: 'Suggestion not found.' } });
  assert.equal((await bot('POST', `/_/bot/suggestions/thread/${thread}`, {})).status, 400);
  assert.equal((await bot('POST', `/_/bot/suggestions/thread/${thread}`, { deleted: 'yes' })).status, 400);
  assert.equal((await bot('POST', '/_/bot/suggestions/thread/12', { deleted: true })).status, 404);
});

test('bot API: the threads listing for the daily check pages by 100 and leaves out deleted posts', async () => {
  const ids: number[] = [];
  for (let i = 0; i < 103; i++) ids.push(await addSuggestion({ body: i === 1 ? '' : 'x' }));
  await exec('UPDATE community_suggestions SET removed_at = NOW() WHERE id = ?', [ids[0]]);
  const first = await bot('GET', '/_/bot/suggestions/threads?after=0');
  const items = first.json.items as Array<{ id: number; thread_id: string; has_body: boolean }>;
  assert.equal(items.length, 100);
  assert.equal(items[0].id, ids[1]);
  assert.equal(items[0].has_body, false);
  assert.equal(items[1].has_body, true);
  assert.match(items[0].thread_id, /^\d{19}$/);
  assert.equal(first.json.next, items[99].id);
  const second = await bot('GET', `/_/bot/suggestions/threads?after=${first.json.next}`);
  assert.deepEqual((second.json.items as Array<{ id: number }>).map((i) => i.id), ids.slice(101));
  assert.equal(second.json.next, null);
  assert.equal(((await bot('GET', '/_/bot/suggestions/threads?after=abc')).json.items as unknown[]).length, 100, 'a broken after starts at the beginning');
});

test('suggestions.notice goes only to a bot that names suggestions.v2', async () => {
  await adminPost({ community_action: 'suggestions_page', suggestions: 'on', _confirmed: '1' });
  assert.deepEqual((await bot('GET', '/_/bot/outbox')).json.items, []);
  assert.deepEqual((await bot('GET', '/_/bot/outbox?f=updates.v1')).json.items, []);
  const items = (await bot('GET', '/_/bot/outbox?f=updates.v1,suggestions.v2')).json.items as Array<{ action: string; data: Record<string, unknown> }>;
  assert.deepEqual(items.map((i) => [i.action, i.data.on]), [['suggestions.notice', true]]);
});

// ------------------------------------------------------------------ Adressen

test('the name suggestions is reserved, and a page with a reserved name can’t switch to the main-domain address', async () => {
  assert.equal(await slugProblem('suggestions'), 'The address “suggestions” is reserved.');
  await exec("UPDATE pages SET slug = 'suggestions', address_mode = 'subdomain' WHERE id = 2");
  try {
    const sid = await loginSession(5);
    const ctx = makeTestCtx({
      method: 'POST', url: '/dashboard/api/address', headers: { 'content-type': 'application/json', 'x-csrf-token': CSRF }, cookies: { PHPSESSID: sid },
      rawBody: Buffer.from(JSON.stringify({ page_id: 2, slug: 'suggestions', mode: 'path' })),
    });
    await runRequest(ctx, appRoutes);
    assert.deepEqual(jsonBody(ctx), { ok: false, error: 'This address is used by OnYourSite on the main domain – your page stays at suggestions.oys.test:8080.' });
    assert.equal((await one('SELECT address_mode FROM pages WHERE id = 2'))!.address_mode, 'subdomain');
  } finally {
    await exec("UPDATE pages SET slug = 'mia', address_mode = 'subdomain' WHERE id = 2");
  }
});

// ------------------------------------------------------------------ Schritt V_PUBLIC_PAGES

test('migration: columns and index, existing suggestions stay hidden, a path page moves and both owners get one notice – once', async () => {
  const m = await testDatabase('sugmig', { empty: true });
  try {
    setConfigForTests({ ...BASE, db: { ...(BASE.db as ConfigData), name: m.name } });
    await ensureSchema({ upTo: V_PUBLIC_PAGES - 1 });
    const db = '`' + m.name + '`';
    const sql = async (s: string, p: unknown[] = []) => (await m.admin.query<RowDataPacket[]>(s, p))[0];
    for (const [id, email] of [[11, 'page@x.de'], [12, 'code@x.de'], [13, 'other@x.de']] as const) {
      await sql(`INSERT INTO ${db}.users (id, email, password, created_at) VALUES (?, ?, 'x', NOW())`, [id, email]);
    }
    await sql(`INSERT INTO ${db}.pages (user_id, slug, address_mode, title, created_at, updated_at) VALUES (11, 'suggestions', 'path', 'Mine', NOW(), NOW()), (13, 'other', 'path', 'Other', NOW(), NOW())`);
    await sql(`INSERT INTO ${db}.code_sites (user_id, slug, created_at, updated_at) VALUES (12, 'suggestions', NOW(), NOW())`);
    await sql(`INSERT INTO ${db}.community_suggestions (thread_id, author_id, title, body, status, created_at, updated_at) VALUES (?, ?, 'Old', 'Old text', 'accepted', NOW(), NOW())`, [ID(1), ID(2)]);
    // Abbruch nach den Spalten (vor der Transaktion): der nächste Lauf macht weiter
    await withConnection(async (_d, conn) => {
      await conn.query(`ALTER TABLE ${db}.community_suggestions ADD COLUMN web_state VARCHAR(8) NOT NULL DEFAULT 'auto'`);
    });
    await ensureSchema();
    const cols = (await sql(`SHOW COLUMNS FROM ${db}.community_suggestions`)).map((c) => c.Field);
    for (const c of ['web_state', 'web_notice', 'removed_at']) assert.ok(cols.includes(c), c);
    await withConnection(async (_d, conn) => assert.equal(await hasIndex(conn, 'community_suggestions', 'idx_web'), true));
    const old = (await sql(`SELECT web_state, web_notice, removed_at FROM ${db}.community_suggestions`))[0];
    assert.deepEqual([old.web_state, old.web_notice, old.removed_at], ['auto', 0, null], 'existing suggestions don’t appear by themselves');
    assert.deepEqual((await sql(`SELECT slug, address_mode FROM ${db}.pages ORDER BY id`)).map((p) => [p.slug, p.address_mode]), [['suggestions', 'subdomain'], ['other', 'path']]);
    const notices = async () => (await sql(`SELECT user_id, type, title, body, link FROM ${db}.notifications ORDER BY user_id`)).map((n) => [n.user_id, n.type, n.title, n.body, n.link]);
    const first = await notices();
    assert.deepEqual(first, [
      [11, 'system', 'Your page address changed', 'oys.test:8080/suggestions now opens OnYourSite’s suggestions page. Your page stays at suggestions.oys.test:8080 – please update links and printed QR codes that use the old address.', '/dashboard'],
      [12, 'system', 'A short link to your code page changed', 'oys.test:8080/suggestions no longer forwards to your code page – it now opens OnYourSite’s suggestions page. Your code page stays at suggestions.oys.test:8080.', '/dashboard'],
    ]);
    assert.equal((await sql(`SELECT COUNT(*) AS n FROM ${db}.oys_meta WHERE meta_key = 'reserved_suggestions'`))[0].n, 1);
    // Noch einmal: keine zweite Nachricht
    await sql(`REPLACE INTO ${db}.oys_meta (meta_key, meta_value) VALUES ('schema_version', ?)`, [String(V_PUBLIC_PAGES - 1)]);
    await sql(`UPDATE ${db}.pages SET address_mode = 'path' WHERE slug = 'suggestions'`);
    await ensureSchema();
    assert.deepEqual(await notices(), first);
    assert.equal((await sql(`SELECT address_mode FROM ${db}.pages WHERE slug = 'suggestions'`))[0].address_mode, 'path', 'the marker skips the whole move');
  } finally {
    useConfig();
    await m.done();
    useConfig();
  }
});
