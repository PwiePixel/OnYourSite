// HTTP: Event-Codes (honeycomb-shop HC-9). Admin: Code anlegen (Prüfungen, doppelt, Protokoll), Liste mit Stand, Abschalten
// nur nach dem Dialog. Einlösen über die Editor-API: Schreibweise egal, einmal je Konto, aufgebraucht (zwei Konten
// gleichzeitig um den letzten Platz → genau eins), abgeschaltet, noch nicht/nicht mehr gültig, Mindestalter, angehaltenes
// Konto, Admin-Modus (403), falsche Codes zählen (nach 5 gesperrt), Methode und Eingabe. Dazu die Regel „Event codes“.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { makeTestCtx, type Ctx } from '../src/web/ctx.js';
import { appRoutes } from '../src/app/dispatch.js';
import { ensureSchema } from '../src/schema.js';
import { addDays, nowStr } from '../src/honeycombs/clock.js';
import { normalizeCode } from '../src/honeycombs/codes.js';
import type { PhpArray } from '../src/php.js';
import { UNCONFIRMED_MESSAGE } from '../src/views/partials/ui.js';
import { CSRF, jsonBody, loginSession, runRequest, testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
const OLD = '2026-01-01 10:00:00';
let ip = 1;

async function sql(query: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [r] = await t.admin.query<RowDataPacket[]>(query.replace(/`DB`/g, '`' + t.name + '`'), params);
  return r;
}
const num = async (query: string, params: unknown[] = []): Promise<number> => Number(Object.values((await sql(query, params))[0] ?? { n: 0 })[0] ?? 0);
const balance = (uid: number): Promise<number> => num('SELECT COALESCE(SUM(amount), 0) FROM `DB`.honeycomb_ledger WHERE user_id = ?', [uid]);

async function admin(form: PhpArray, confirmed = true): Promise<Ctx> {
  const sid = await loginSession(3);
  return runRequest(makeTestCtx({ method: 'POST', url: '/admin', cookies: { PHPSESSID: sid }, post: { csrf: CSRF, ...(confirmed ? { _confirmed: '1' } : {}), ...form } }), appRoutes);
}
const flash = (ctx: Ctx): { ok?: unknown; error?: unknown } => ({ ok: ctx.session!.data.admin_success, error: ctx.session!.data.admin_error });
async function page(query: string): Promise<string> {
  const ctx = await runRequest(makeTestCtx({ url: '/admin' + query, cookies: { PHPSESSID: await loginSession(3) } }), appRoutes);
  return String(ctx.body);
}
// Einlösen wie aus dem Editor (eigene Adresse je Aufruf, außer peer ist gesetzt)
async function redeem(uid: number, body: unknown, o: { method?: string; impersonatedBy?: number; peer?: string } = {}): Promise<Ctx> {
  const sid = await loginSession(uid, { impersonatedBy: o.impersonatedBy });
  const method = o.method ?? 'POST';
  const ctx = makeTestCtx({ method, url: '/dashboard/api/hc-redeem', ip: o.peer ?? `10.0.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`,
    headers: { 'content-type': 'application/json', 'x-csrf-token': CSRF }, cookies: { PHPSESSID: sid }, rawBody: method === 'POST' ? Buffer.from(JSON.stringify(body)) : undefined });
  return runRequest(ctx, appRoutes);
}
async function code(o: { code: string; amount?: number; max?: number | null; starts?: string | null; ends?: string | null; age?: number; note?: string; off?: boolean }): Promise<number> {
  await sql(`INSERT INTO \`DB\`.hc_codes (code, amount, note, starts_at, ends_at, max_uses, uses, min_account_days, disabled_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 3, ?)`,
    [o.code, o.amount ?? 50, o.note ?? '', o.starts ?? null, o.ends ?? null, o.max ?? null, o.age ?? 0, o.off ? nowStr() : null, nowStr()]);
  return num('SELECT id FROM `DB`.hc_codes WHERE code = ?', [o.code]);
}

before(async () => {
  t = await testDatabase('hccodes', { empty: true });
  await ensureSchema();
  const user = 'INSERT INTO `DB`.users (id, email, password, full_name, is_admin, created_at) VALUES (?, ?, \'x\', ?, ?, ?)';
  await sql(user, [3, 'admin@test.de', 'Pixel Admin', 1, OLD]);
  for (const id of [5, 6, 7]) await sql(user, [id, `u${id}@test.de`, 'User ' + id, 0, OLD]);
  await sql(user, [9, 'new@test.de', 'New user', 0, nowStr()]);
  for (const id of [5, 6]) await sql('INSERT INTO `DB`.pages (user_id, slug, created_at) VALUES (?, ?, ?)', [id, 'p' + id, OLD]);
});

beforeEach(async () => {
  await sql('DELETE FROM `DB`.hc_codes');
  await sql('DELETE FROM `DB`.honeycomb_ledger');
  await sql('DELETE FROM `DB`.rate_limits');
  await sql('UPDATE `DB`.hc_accounts SET frozen_at = NULL, frozen_reason = NULL');
});

after(async () => {
  await t.done();
});

test('admin: create a code with its checks, the list with uses and status, disable only after the dialog', async () => {
  const base = { hc_action: 'code_create', code: ' halloween-2026 ', amount: '50', note: 'Halloween <b>2026</b>', starts_at: '', ends_at: '', max_uses: '100', min_account_days: '7' };
  assert.equal(flash(await admin({ ...base, code: 'abc' })).error, 'A code has 4–32 letters, digits or dashes.');
  assert.equal(flash(await admin({ ...base, code: 'BAD CODE!' })).error, 'A code has 4–32 letters, digits or dashes.');
  assert.equal(flash(await admin({ ...base, amount: '0' })).error, 'The amount can be 1 to 10,000 honeycombs.');
  assert.equal(flash(await admin({ ...base, amount: '10001' })).error, 'The amount can be 1 to 10,000 honeycombs.');
  assert.equal(flash(await admin({ ...base, max_uses: '0' })).error, 'Max. uses is empty (no limit) or at least 1.');
  assert.equal(flash(await admin({ ...base, ends_at: '2020-01-01T10:00' })).error, 'The end must be in the future.');
  assert.equal(flash(await admin({ ...base, starts_at: '2030-02-01T10:00', ends_at: '2030-01-01T10:00' })).error, 'The end must be after the start.');
  assert.equal(flash(await admin({ ...base, starts_at: 'soon' })).error, 'Please enter the dates as date and time.');
  assert.equal(flash(await admin(base)).ok, 'Code HALLOWEEN-2026 created.');
  assert.equal(flash(await admin(base)).error, 'This code already exists.');
  // Ohne Code: ein zufälliger aus 10 Zeichen
  const auto = flash(await admin({ ...base, code: '' })).ok;
  assert.match(String(auto), /^Code [A-Z0-9]{10} created\.$/);
  assert.equal(await num('SELECT COUNT(*) FROM `DB`.hc_codes WHERE code = ?', [String(auto).split(' ')[1]]), 1);
  assert.equal(flash(await admin({ ...base, code: ['X'] as unknown as string })).error, 'Not all of the data arrived. Please try again.');
  assert.equal(await num("SELECT COUNT(*) FROM `DB`.hc_audit WHERE action = 'code_create'"), 2);
  const html = await page('?hc_tab=codes');
  const list = html.slice(html.indexOf('id="hcCodeRows"'), html.indexOf('</ul>', html.indexOf('id="hcCodeRows"')));
  assert.match(list, /HALLOWEEN-2026<\/span> <span class="[^"]*">running<\/span>/);
  assert.match(list, /50 honeycombs · 0 \/ 100 uses · accounts ≥ 7 days · Halloween &lt;b&gt;2026&lt;\/b&gt;/);
  const id = await num("SELECT id FROM `DB`.hc_codes WHERE code = 'HALLOWEEN-2026'");
  assert.equal(flash(await admin({ hc_action: 'code_disable', code_id: String(id) }, false)).error, UNCONFIRMED_MESSAGE);
  assert.equal(flash(await admin({ hc_action: 'code_disable', code_id: String(id) })).ok, 'Code disabled.');
  assert.match(await page('?hc_tab=codes'), /HALLOWEEN-2026<\/span> <span class="[^"]*">off<\/span>/);
  assert.equal(flash(await admin({ hc_action: 'code_disable', code_id: '99999' })).error, 'This code no longer exists.');
});

test('redeem: any spelling, once per account, a notice and the history text; the rule “Event codes” is listed', async () => {
  assert.equal(normalizeCode(' halloween - 2026 '), 'HALLOWEEN-2026');
  // Unsichtbare Zeichen aus Chats (Nullbreite, BOM) zählen nicht
  assert.equal(normalizeCode('\u200bHALLO\u200dWEEN\ufeff'), 'HALLOWEEN');
  const id = await code({ code: 'HALLOWEEN-2026', amount: 50, note: 'Halloween 2026' });
  let ctx = await redeem(5, { code: ' halloween-2026' });
  assert.deepEqual(jsonBody(ctx), { ok: true, amount: 50, balance: 50, notices: [{ tone: 'hc', amount: 50, text: 'Halloween 2026' }] });
  assert.deepEqual({ ...(await sql("SELECT reason, ref, note FROM `DB`.honeycomb_ledger WHERE user_id = 5"))[0] }, { reason: 'code', ref: 'c' + id, note: 'Halloween 2026' });
  ctx = await redeem(5, { code: 'HALLOWEEN-2026' });
  assert.deepEqual(jsonBody(ctx), { ok: false, error: 'You’ve already used this code.' });
  assert.equal(await num('SELECT uses FROM `DB`.hc_codes WHERE id = ?', [id]), 1);
  // Ohne Notiz: „Code redeemed“ (im Verlauf und in der Meldung)
  await code({ code: 'PLAIN', amount: 5 });
  assert.equal((jsonBody(await redeem(5, { code: 'plain' })).notices as Array<{ text: string }>)[0].text, 'Code redeemed');
  assert.equal(await num("SELECT COUNT(*) FROM `DB`.honeycomb_ledger WHERE user_id = 5 AND reason = 'code' AND note = ''"), 1);
  const shop = jsonBody(await runRequest(makeTestCtx({ url: '/dashboard/api/shop', cookies: { PHPSESSID: await loginSession(5) }, headers: { 'x-csrf-token': CSRF } }), appRoutes)).shop as { earn: { rules: Array<{ key: string }> } };
  assert.ok(shop.earn.rules.some((r) => r.key === 'codes'));
});

test('redeem refuses: used up (two at once → one), off, not yet / no longer valid, too new, frozen, admin mode, method and input', async () => {
  await code({ code: 'ONLYONE', max: 1, amount: 20 });
  const [a, b] = await Promise.all([redeem(5, { code: 'ONLYONE' }), redeem(6, { code: 'ONLYONE' })]);
  const results = [jsonBody(a), jsonBody(b)];
  assert.equal(results.filter((r) => r.ok === true).length, 1);
  assert.deepEqual(results.find((r) => r.ok !== true), { ok: false, error: 'This code has been used up.' });
  assert.equal((await balance(5)) + (await balance(6)), 20, 'the loser’s entry was rolled back');
  await code({ code: 'GONE', off: true });
  await code({ code: 'LATER', starts: addDays(nowStr(), 1) });
  await code({ code: 'OVER', ends: addDays(nowStr(), -1) });
  for (const c of ['GONE', 'LATER', 'OVER']) assert.deepEqual(jsonBody(await redeem(7, { code: c })), { ok: false, error: 'This code doesn’t exist or has expired.' });
  await code({ code: 'VETERANS', age: 7 });
  assert.deepEqual(jsonBody(await redeem(9, { code: 'VETERANS' })), { ok: false, error: 'This code is for accounts that are at least 7 days old.' });
  assert.equal(jsonBody(await redeem(7, { code: 'VETERANS' })).ok, true);
  await code({ code: 'HOLD' });
  await sql("INSERT INTO `DB`.hc_accounts (user_id, frozen_at, frozen_reason, created_at, updated_at) VALUES (6, ?, 'x', ?, ?) ON DUPLICATE KEY UPDATE frozen_at = VALUES(frozen_at)", [nowStr(), nowStr(), nowStr()]);
  assert.deepEqual(jsonBody(await redeem(6, { code: 'HOLD' })), { ok: false, error: 'Your honeycombs are on hold – redeeming is paused.' });
  const am = await redeem(5, { code: 'HOLD' }, { impersonatedBy: 3 });
  assert.equal(am.status, 403);
  assert.deepEqual(jsonBody(am), { ok: false, code: 'admin_mode', error: 'Redeeming is turned off in admin mode.' });
  assert.equal((await redeem(5, { code: 'HOLD' }, { method: 'GET' })).status, 404);
  assert.equal((await redeem(5, { code: 123 })).status, 400);
  assert.equal((await redeem(5, { code: 'x'.repeat(41) })).status, 400);
  assert.deepEqual(jsonBody(await redeem(5, { code: '   ' })), { ok: false, error: 'Please enter a code.' });
  assert.equal(await num("SELECT COUNT(*) FROM `DB`.honeycomb_ledger WHERE ref = (SELECT CONCAT('c', id) FROM `DB`.hc_codes WHERE code = 'HOLD')"), 0);
});

test('wrong codes count: after 5 tries in 15 minutes nothing is looked up (also a right code)', async () => {
  await code({ code: 'RIGHT' });
  for (let i = 0; i < 5; i++) assert.deepEqual(jsonBody(await redeem(5, { code: 'WRONG-' + i }, { peer: '10.9.9.9' })), { ok: false, error: 'This code doesn’t exist or has expired.' });
  assert.deepEqual(jsonBody(await redeem(5, { code: 'RIGHT' }, { peer: '10.9.9.9' })), { ok: false, error: 'Too many tries. Please wait 15 minutes.' });
  assert.equal(await balance(5), 0);
  // Ein anderes Konto ist davon nicht betroffen
  assert.equal(jsonBody(await redeem(6, { code: 'RIGHT' }, { peer: '10.9.9.9' })).ok, true);
});
