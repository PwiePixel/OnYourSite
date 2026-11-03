// HTTP: Admin, Bereich „Honeycombs“, Teil III (honeycomb-shop HC-6b) – Buchungen zurücknehmen (Reverse: nur
// Belohnungen und Gaben, je einmal, nie unter 0, Glocke), Konten anhalten und freigeben (Freeze: Grund nötig, Verdienen
// und Kaufen stoppen, Freischaltungen bleiben), Honigwaben an mehrere Nutzer (Liste prüfen → Vorschau aus der Sitzung →
// einmal buchen; unklare und fehlende Einträge, „unter 0“ übersprungen, 15 Minuten gültig, ein zweites Absenden bucht
// nichts) und der Unterbereich „Ledger“ mit Filtern. Dazu: nur Admins, CSRF, _confirmed, Texte maskiert.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { randomHex } from '../src/crypto.js';
import { makeTestCtx, type Ctx } from '../src/web/ctx.js';
import { appRoutes } from '../src/app/dispatch.js';
import { ensureSchema } from '../src/schema.js';
import { hcBackUrl } from '../src/honeycombs/admin.js';
import { nowStr } from '../src/honeycombs/clock.js';
import { earnOnVisit, resetEarnThrottleForTests } from '../src/honeycombs/earn.js';
import { bookBulk } from '../src/honeycombs/teamTools.js';
import { time, type PhpArray } from '../src/php.js';
import { UNCONFIRMED_MESSAGE } from '../src/views/partials/ui.js';
import { CSRF, loginSession, runRequest, testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
const OLD = '2026-01-01 10:00:00';

async function sql(query: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [r] = await t.admin.query<RowDataPacket[]>(query.replace(/`DB`/g, '`' + t.name + '`'), params);
  return r;
}
const num = async (query: string, params: unknown[] = []): Promise<number> => Number(Object.values((await sql(query, params))[0] ?? { n: 0 })[0] ?? 0);

// Eine Sitzung über mehrere Anfragen (die Vorschau der Sammel-Gabe steht in der Sitzung)
async function post(form: PhpArray, o: { sid?: string; userId?: number; confirmed?: boolean; csrf?: boolean } = {}): Promise<Ctx> {
  const sid = o.sid ?? await loginSession(o.userId ?? 3);
  const body: PhpArray = { ...(o.csrf === false ? {} : { csrf: CSRF }), ...(o.confirmed === false ? { _confirmed: '0' } : { _confirmed: '1' }), ...form };
  return runRequest(makeTestCtx({ method: 'POST', url: '/admin', cookies: { PHPSESSID: sid }, post: body }), appRoutes);
}
async function page(query = '', sid?: string): Promise<string> {
  const ctx = await runRequest(makeTestCtx({ url: '/admin' + query, cookies: { PHPSESSID: sid ?? await loginSession(3) } }), appRoutes);
  assert.equal(ctx.status, 200);
  return String(ctx.body);
}
const flash = (ctx: Ctx): { ok?: unknown; error?: unknown } => ({ ok: ctx.session!.data.admin_success, error: ctx.session!.data.admin_error });
const balance = (uid: number): Promise<number> => num('SELECT COALESCE(SUM(amount), 0) FROM `DB`.honeycomb_ledger WHERE user_id = ?', [uid]);
const lastBell = async (uid: number) => ({ ...(await sql('SELECT type, title, body FROM `DB`.notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1', [uid]))[0] });
async function entry(uid: number, amount: number, reason: string, ref: string): Promise<number> {
  await sql('INSERT INTO `DB`.honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (?, ?, ?, ?, \'\', ?)', [uid, amount, reason, ref, nowStr()]);
  return num('SELECT MAX(id) FROM `DB`.honeycomb_ledger');
}

before(async () => {
  t = await testDatabase('hcadmin3', { empty: true });
  await ensureSchema();
  const user = 'INSERT INTO `DB`.users (id, email, password, full_name, username, is_admin, created_at) VALUES (?, ?, \'x\', ?, ?, ?, ?)';
  await sql(user, [3, 'admin@test.de', 'Pixel Admin', 'pixel', 1, OLD]);
  await sql(user, [5, 'mia@test.de', 'Mia <img src=x onerror=alert(1)>', 'mia', 0, OLD]);
  await sql(user, [7, 'tom@test.de', 'Tom', 'tom', 0, OLD]);
  await sql(user, [8, 'lea@test.de', 'Lea', 'lea', 0, OLD]);
  await sql("INSERT INTO `DB`.pages (id, user_id, slug, created_at) VALUES (1, 8, 'leapage', ?)", [OLD]);
  await page();
});

after(async () => {
  await t.done();
});

test('reverse: rewards and gifts once, never below 0, with a bell; purchases and unlocks can’t be reversed; only after the dialog', async () => {
  const gift = await entry(5, 40, 'admin', 'a3-' + randomHex(8));
  const daily = await entry(5, 5, 'daily', '2026-05-01');
  const unlock = await entry(5, -10, 'unlock', 'code_page');
  // Ohne Bestätigung nichts
  assert.equal(flash(await post({ hc_action: 'reverse', ledger_id: String(gift), user_id: '5' }, { confirmed: false })).error, UNCONFIRMED_MESSAGE);
  assert.equal(await balance(5), 35);
  // −40 aus 35 → unter 0: abgelehnt
  let ctx = await post({ hc_action: 'reverse', ledger_id: String(gift), user_id: '5' });
  assert.equal(flash(ctx).error, 'That would take the balance below 0 (current: 35).');
  await entry(5, 100, 'admin', 'a3-' + randomHex(8));
  ctx = await post({ hc_action: 'reverse', ledger_id: String(gift), user_id: '5' });
  assert.equal(flash(ctx).ok, 'Reversed: −40 honeycombs for Mia <img src=x onerror=alert(1)>. New balance: 95.');
  assert.equal(hcBackUrl({ hc_action: 'reverse', user_id: '5' }), '/admin?hc_tab=users&hc_user=5#honeycombs');
  assert.equal(hcBackUrl({ hc_action: 'reverse', user_id: '5', from_tab: 'ledger' }), '/admin?hc_tab=ledger&hc_user=5#honeycombs');
  assert.deepEqual(await lastBell(5), { type: 'honeycombs', title: '−40 honeycombs (correction by the team)', body: 'Correction: Gift from the team' });
  assert.equal(flash(await post({ hc_action: 'reverse', ledger_id: String(gift), user_id: '5' })).error, 'This entry was already reversed.');
  assert.equal(await balance(5), 95);
  assert.equal(flash(await post({ hc_action: 'reverse', ledger_id: String(daily), user_id: '5', note: 'Bot visits' })).ok, 'Reversed: −5 honeycombs for Mia <img src=x onerror=alert(1)>. New balance: 90.');
  assert.equal((await lastBell(5)).body, 'Bot visits');
  assert.match(String(flash(await post({ hc_action: 'reverse', ledger_id: String(unlock), user_id: '5' })).error), /^This entry can’t be reversed/);
  assert.equal(flash(await post({ hc_action: 'reverse', ledger_id: '999999', user_id: '5' })).error, 'This entry no longer exists.');
  assert.equal(flash(await post({ hc_action: 'reverse', ledger_id: ['1'] as unknown as string, user_id: '5' })).error, 'Not all of the data arrived. Please try again.');
  assert.equal(await num("SELECT COUNT(*) FROM `DB`.hc_audit WHERE action = 'reverse' AND user_id = 5"), 2);
  // Nur Admins
  const notAdmin = await post({ hc_action: 'reverse', ledger_id: String(daily), user_id: '5' }, { userId: 7 });
  assert.notEqual(notAdmin.status, 200);
  assert.equal(await balance(5), 90);
  // Die Details zeigen „Reversed“ und für den Rest den Knopf, maskiert
  const html = await page('?hc_tab=users&hc_user=5');
  assert.match(html, new RegExp(`data-ledger="${gift}"[^\\n]*Reversed`));
  assert.ok(!html.includes('<img src=x onerror'), 'names are escaped');
});

test('freeze: a reason is needed, earning stops, unlocks keep working, unfreeze lets them earn again; one bell each', async () => {
  assert.equal(flash(await post({ hc_action: 'freeze', user_id: '7', reason: ' ' })).error, 'Please give a reason – the user sees it.');
  let ctx = await post({ hc_action: 'freeze', user_id: '7', reason: 'Checking unusual activity.' });
  assert.equal(flash(ctx).ok, 'Tom’s honeycombs are on hold now.');
  assert.equal(flash(await post({ hc_action: 'freeze', user_id: '7', reason: 'Again' })).ok, 'Tom’s honeycombs are already on hold.');
  assert.deepEqual(await lastBell(7), { type: 'honeycombs', title: 'Your honeycombs are on hold', body: 'Checking unusual activity. Earning and buying are paused – your unlocks keep working.' });
  resetEarnThrottleForTests();
  assert.deepEqual(await earnOnVisit(7), []);
  assert.match(await page('?hc_tab=users&hc_user=7'), /On hold since [^<]*: Checking unusual activity\./);
  ctx = await post({ hc_action: 'unfreeze', user_id: '7' });
  assert.equal(flash(ctx).ok, 'Tom’s honeycombs work again.');
  resetEarnThrottleForTests();
  assert.equal((await earnOnVisit(7)).length, 1);
  assert.equal(await num("SELECT COUNT(*) FROM `DB`.hc_audit WHERE user_id = 7 AND action IN ('freeze', 'unfreeze')"), 2);
  assert.equal(flash(await post({ hc_action: 'freeze', user_id: '99999', reason: 'x' })).error, 'Please choose a user.');
});

test('several users: check the list (email, #id, @name or page address; unclear and missing named), confirm once, skip “below 0”', async () => {
  const sid = await loginSession(3);
  const ref = randomHex(8);
  await sql('DELETE FROM `DB`.honeycomb_ledger WHERE user_id IN (5, 7, 8)');
  const list = 'MIA@test.de\n#7, @leapage\n1234\nnobody@test.de\n@ghost\n#7';
  let ctx = await post({ hc_action: 'grant_preview', user_list: list, amount: '25', note: 'Thanks <b>!</b>', grant_ref: ref }, { sid });
  assert.equal(flash(ctx).error, undefined);
  const html = await page('?hc_tab=users', sid);
  const preview = html.slice(html.indexOf('id="hcBulkPreview"'), html.indexOf('</details>', html.indexOf('id="hcBulkPreview"')));
  assert.match(preview, /\+25 honeycombs for 3 users/);
  assert.match(preview, /Not clear – use #id, @name or an email: 1234/);
  assert.match(preview, /Not found: nobody@test\.de, @ghost/);
  assert.ok(html.includes('value="Thanks &lt;b&gt;!&lt;/b&gt;"'), 'the note is escaped');
  // Bestätigen: genau einmal je Konto
  ctx = await post({ hc_action: 'grant_bulk', grant_ref: ref }, { sid });
  assert.equal(flash(ctx).ok, '+25 honeycombs for 3 users.');
  assert.deepEqual([await balance(5), await balance(7), await balance(8)], [25, 25, 25]);
  assert.equal((await lastBell(8)).title, '+25 honeycombs from the team');
  // Die Liste ist verbraucht: ein zweites Absenden bucht nichts
  assert.equal(flash(await post({ hc_action: 'grant_bulk', grant_ref: ref }, { sid })).error, 'This was already booked – the form was sent twice.');
  assert.deepEqual([await balance(5), await balance(7), await balance(8)], [25, 25, 25]);
  // Derselbe Schlüssel noch einmal gebucht (z. B. zwei Tabs): nichts doppelt
  assert.equal((await bookBulk(3, { ref, amount: 25, note: '', at: time(), ids: [5, 7, 8] }, time()) as { error?: string }).error, 'This was already booked – the form was sent twice.');

  // Abziehen: wer unter 0 käme, wird übersprungen; ohne Bestätigung nichts
  await sql("INSERT INTO `DB`.honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (5, 100, 'admin', 'a3-x1', '', ?)", [nowStr()]);
  const ref2 = randomHex(8);
  await post({ hc_action: 'grant_preview', user_list: 'mia@test.de\ntom@test.de', amount: '-50', grant_ref: ref2 }, { sid });
  const html2 = await page('?hc_tab=users', sid);
  assert.match(html2, /tom@test\.de<\/span><\/span><span class="text-xs text-red-400">Balance 25 – would go below 0, skipped/);
  assert.equal(flash(await post({ hc_action: 'grant_bulk', grant_ref: ref2 }, { sid, confirmed: false })).error, UNCONFIRMED_MESSAGE);
  ctx = await post({ hc_action: 'grant_bulk', grant_ref: ref2 }, { sid });
  assert.equal(flash(ctx).ok, '−50 honeycombs for 1 user. Skipped: tom@test.de (would go below 0).');
  assert.deepEqual([await balance(5), await balance(7)], [75, 25]);

  // Prüfungen der Eingabe
  assert.equal(flash(await post({ hc_action: 'grant_preview', user_list: 'mia@test.de', amount: '0', grant_ref: randomHex(8) }, { sid })).error, 'Enter an amount between −100,000 and 100,000 (not 0).');
  assert.equal(flash(await post({ hc_action: 'grant_preview', user_list: Array.from({ length: 201 }, (_, i) => '#' + (i + 1)).join('\n'), amount: '5', grant_ref: randomHex(8) }, { sid })).error, 'Up to 200 users at once.');
  assert.equal(flash(await post({ hc_action: 'grant_preview', user_list: '1234', amount: '5', grant_ref: randomHex(8) }, { sid })).error, 'None of these users were found – check the list below.');
  // Abbrechen verwirft die Liste; eine alte Liste (über 15 Minuten) wird nicht gebucht
  const ref3 = randomHex(8);
  await post({ hc_action: 'grant_preview', user_list: 'lea@test.de', amount: '5', grant_ref: ref3 }, { sid });
  assert.equal(flash(await post({ hc_action: 'grant_bulk_cancel' }, { sid })).ok, 'The list was dropped – nothing was booked.');
  assert.match(String(flash(await post({ hc_action: 'grant_bulk', grant_ref: ref3 }, { sid })).error), /older than 15 minutes/);
  assert.match(String((await bookBulk(3, { ref: randomHex(8), amount: 5, note: '', at: time() - 16 * 60, ids: [8] }, time()) as { error?: string }).error), /older than 15 minutes/);
  assert.equal(await balance(8), 25);
});

test('ledger tab: filters by reason, user and date, pages of 50, Reverse goes back to the ledger', async () => {
  const html = await page('?hc_tab=ledger');
  assert.ok(html.includes('id="hcLedger"') && html.includes('aria-current="page"><i class=\'bx bx-list-ul\'></i> Ledger'));
  const gifts = await page('?hc_tab=ledger&hc_reason=admin&hc_q=tom');
  const rows = gifts.slice(gifts.indexOf('id="hcLedgerRows"'), gifts.indexOf('</ul>', gifts.indexOf('id="hcLedgerRows"')));
  assert.ok(rows.includes('Tom') && !rows.includes('mia@test.de') && !rows.includes('Lea'), 'only Tom’s gifts');
  assert.match(rows, /name="from_tab" value="ledger"/);
  assert.ok((await page('?hc_tab=ledger&hc_from=2001-01-01&hc_to=2001-01-02')).includes('No entries found.'));
  // Ein unbekannter Grund filtert nichts
  assert.ok((await page('?hc_tab=ledger&hc_reason=nope')).includes('mia@test.de'));
});

test('review: a second reverse says “already reversed” even at 0; the second confirm and another tab get the right text; actions without the dialog field are refused', async () => {
  await sql('DELETE FROM `DB`.honeycomb_ledger WHERE user_id = 8');
  const gift = await entry(8, 30, 'admin', 'a3-' + randomHex(8));
  assert.match(String(flash(await post({ hc_action: 'reverse', ledger_id: String(gift), user_id: '8' })).ok), /^Reversed: −30/);
  assert.equal(flash(await post({ hc_action: 'reverse', ledger_id: String(gift), user_id: '8' })).error, 'This entry was already reversed.');
  // Ohne _confirmed (selbst gebautes Formular) nichts
  const raw = async (form: PhpArray) => runRequest(makeTestCtx({ method: 'POST', url: '/admin', cookies: { PHPSESSID: await loginSession(3) }, post: { csrf: CSRF, ...form } }), appRoutes);
  assert.equal(flash(await raw({ hc_action: 'freeze', user_id: '8', reason: 'x' })).error, UNCONFIRMED_MESSAGE);
  assert.equal(flash(await raw({ hc_action: 'reverse', ledger_id: String(gift), user_id: '8' })).error, UNCONFIRMED_MESSAGE);
  // Der Grund bekommt einen Punkt
  await post({ hc_action: 'freeze', user_id: '8', reason: 'Checking unusual activity' });
  assert.equal((await lastBell(8)).body, 'Checking unusual activity. Earning and buying are paused – your unlocks keep working.');
  await post({ hc_action: 'unfreeze', user_id: '8' });
  // Zweimal „Confirm“: die zweite Antwort sagt, dass es schon gebucht ist; ein älterer Tab nach einer neuen Prüfung auch
  const sid = await loginSession(3);
  const ref = randomHex(8);
  await post({ hc_action: 'grant_preview', user_list: 'lea@test.de', amount: '5', grant_ref: ref }, { sid });
  assert.equal(flash(await post({ hc_action: 'grant_bulk', grant_ref: ref }, { sid })).ok, '+5 honeycombs for 1 user.');
  assert.equal(flash(await post({ hc_action: 'grant_bulk', grant_ref: ref }, { sid })).error, 'This was already booked – the form was sent twice.');
  const a = randomHex(8);
  const b = randomHex(8);
  await post({ hc_action: 'grant_preview', user_list: 'lea@test.de', amount: '5', grant_ref: a }, { sid });
  await post({ hc_action: 'grant_preview', user_list: 'tom@test.de', amount: '5', grant_ref: b }, { sid });
  assert.equal(flash(await post({ hc_action: 'grant_bulk', grant_ref: a }, { sid })).error, 'Another list was checked since – please confirm the newest one.');
  assert.equal(flash(await post({ hc_action: 'grant_bulk_cancel' }, { sid })).ok, 'The list was dropped – nothing was booked.');
  assert.equal(await balance(8), 5);
});
