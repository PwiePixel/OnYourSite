// HTTP: Admin, Bereich „Honeycombs“ (honeycomb-shop HC-5) – Unterbereiche Übersicht, Katalog & Preise, Angebote,
// Regeln zum Verdienen und Nutzer. Jede Aktion (settings, item_save, item_add, offer_create, offer_cancel) mit gültigen
// und ungültigen Eingaben, Weiterleitung zum Unterbereich, Meldung und Protokollzeile (hc_audit, nur IDs, Beträge,
// Schlüssel); mit _confirmed=0 ändert sich nichts; nur Admins (auch nicht im Nutzer-Modus); CSRF; Texte maskiert.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { randomHex } from '../src/crypto.js';
import { makeTestCtx, type Ctx } from '../src/web/ctx.js';
import { appRoutes } from '../src/app/dispatch.js';
import { ensureSchema } from '../src/schema.js';
import { addDays, nowStr } from '../src/honeycombs/clock.js';
import { registerFeature, setLifecycleReadyForTests, unregisterFeatureForTests, type Feature } from '../src/honeycombs/features.js';
import { hcBackUrl, hcTab } from '../src/honeycombs/admin.js';
import { premiumReady } from '../src/honeycombs/premium.js';
import { UNCONFIRMED_MESSAGE } from '../src/views/partials/ui.js';
import type { PhpArray } from '../src/php.js';
import '../src/code/shop.js';
import { CSRF, loginSession, runRequest, testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
const OLD = '2026-01-01 10:00:00';

async function sql(query: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [r] = await t.admin.query<RowDataPacket[]>(query.replace(/`DB`/g, '`' + t.name + '`'), params);
  return r;
}
const rows = async (query: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> => (await sql(query, params)).map((r) => ({ ...r }));

// POST /admin als Admin (id 3, oder ein anderes Konto); csrf: false = ohne Feld
async function post(form: PhpArray, o: { userId?: number; impersonatedBy?: number; csrf?: boolean } = {}): Promise<Ctx> {
  const sid = await loginSession(o.userId ?? 3, { impersonatedBy: o.impersonatedBy });
  const ctx = makeTestCtx({ method: 'POST', url: '/admin', cookies: { PHPSESSID: sid }, post: o.csrf === false ? form : { csrf: CSRF, ...form } });
  return runRequest(ctx, appRoutes);
}
async function page(query = '', userId = 3): Promise<string> {
  const ctx = await runRequest(makeTestCtx({ url: '/admin' + query, cookies: { PHPSESSID: await loginSession(userId) } }), appRoutes);
  assert.equal(ctx.status, 200);
  return String(ctx.body);
}
const flash = (ctx: Ctx): { ok?: unknown; error?: unknown } => ({ ok: ctx.session!.data.admin_success, error: ctx.session!.data.admin_error });
const lastAudit = async (): Promise<Record<string, unknown> | undefined> =>
  (await rows('SELECT admin_id, action, user_id, target, details FROM `DB`.hc_audit ORDER BY id DESC LIMIT 1'))[0];
const auditCount = async (): Promise<number> => Number((await sql('SELECT COUNT(*) AS n FROM `DB`.hc_audit'))[0].n);
const item = async (key: string) => (await rows('SELECT price, is_active, position, available_from, available_until, min_account_days, min_active_days FROM `DB`.hc_items WHERE item_key = ?', [key]))[0];
const itemId = async (key: string): Promise<number> => Number((await sql('SELECT id FROM `DB`.hc_items WHERE item_key = ?', [key]))[0].id);
const meta = async (): Promise<unknown> => JSON.parse(String((await sql("SELECT meta_value FROM `DB`.oys_meta WHERE meta_key = 'honeycombs'"))[0]?.meta_value ?? 'null'));
// Abschnitt der Admin-Seite: Bereich Honeycombs
const section = (html: string): string => html.slice(html.indexOf('<div id="tab-honeycombs"'), html.indexOf('<div id="tab-code-pages"'));

const TEST_FEATURES: Feature[] = [
  { key: 'test_checks', owner: 'test', title: 'Extra checks', icon: 'bx-pulse', description: 'Packs for tests.', kind: 'timed', stack: 2,
    items: { test_checks_30: { days: 30, price: 60, active: false, minActiveDays: 2 } } },
  { key: 'test_passes', owner: 'test', title: 'Address pass', icon: 'bx-transfer', description: 'Passes for tests.', kind: 'consumable', max: 3,
    items: { test_passes_x1: { units: 1, price: 40, active: false } } },
  { key: 'test_later', owner: 'test', title: 'Later thing', icon: 'bx-time', description: 'Not ready.', kind: 'count', max: 5, ready: () => false,
    items: { test_later_x1: { units: 1, price: 10, active: false } } },
];

before(async () => {
  // Diese Abläufe prüfen zuerst den Stand vor HC-7a (zeitlich begrenzt gesperrt) und schalten es selbst ein
  setLifecycleReadyForTests(false);
  t = await testDatabase('hcadmin', { empty: true });
  await ensureSchema();
  const user = 'INSERT INTO `DB`.users (id, email, password, full_name, is_admin, created_at) VALUES (?, ?, \'x\', ?, ?, ?)';
  await sql(user, [3, 'admin@test.de', 'Pixel Admin', 1, OLD]);
  await sql(user, [5, 'mia@test.de', 'Mia <img src=x onerror=alert(1)>', 0, OLD]);
  await sql(user, [6, 'staff@test.de', 'Second Admin', 1, OLD]);
  for (const f of TEST_FEATURES) registerFeature(f);
  // Katalog anlegen (wie beim ersten Lesen)
  await page();
});

after(async () => {
  setLifecycleReadyForTests(true);
  for (const f of TEST_FEATURES) unregisterFeatureForTests(f.key);
  await t.done();
});

test('sub-tabs: the tab from ?hc_tab, unknown values show the overview, and every action goes back to its tab', async () => {
  assert.deepEqual(['overview', 'catalogue', 'offers', 'rules', 'users', 'purchases', 'ledger', 'codes', 'x', '', undefined, ['users']].map(hcTab),
    ['overview', 'catalogue', 'offers', 'rules', 'users', 'purchases', 'ledger', 'codes', 'overview', 'overview', 'overview', 'overview']);
  assert.deepEqual(['settings', 'item_save', 'item_add', 'offer_create', 'offer_cancel', 'grant', 'code_block', 'nope'].map((a) => hcBackUrl({ hc_action: a })), [
    '/admin?hc_tab=rules#honeycombs', '/admin?hc_tab=catalogue#honeycombs', '/admin?hc_tab=catalogue#honeycombs', '/admin?hc_tab=offers#honeycombs',
    '/admin?hc_tab=offers#honeycombs', '/admin?hc_tab=users#honeycombs', '/admin#honeycombs', '/admin#honeycombs',
  ]);
  assert.equal(hcBackUrl({ hc_action: ['settings'] }), '/admin#honeycombs');
  const overview = section(await page());
  assert.match(overview, /<a href="\/admin\?hc_tab=overview#honeycombs" class="[^"]*!bg-white\/10 !text-white" aria-current="page">/);
  for (const title of ['In circulation', 'Earned · 30 days', 'Spent · 30 days', 'Active Premium', 'Ending in 7 days', 'Top options · 30 days', 'Earned by reason · 30 days', 'Needs attention', 'Latest activity']) {
    assert.ok(overview.includes(title), title);
  }
  assert.ok(!overview.includes('hcCatalogue') && !overview.includes('hcGrantForm'), 'only the chosen tab is rendered');
  const catalogue = section(await page('?hc_tab=catalogue'));
  assert.match(catalogue, /aria-current="page"><i class='bx bx-purchase-tag'><\/i> Catalogue &amp; prices <span class="text-gray-500">\d+<\/span><\/a>/);
  assert.ok(catalogue.includes('data-item="code_page"') && catalogue.includes('data-item="premium_30"'));
  assert.ok((section(await page('?hc_tab=offers'))).includes('id="hcOfferForm"'));
  assert.ok((section(await page('?hc_tab=rules'))).includes('How users earn them'));
  const users = section(await page('?hc_tab=users'));
  assert.ok(users.includes('Give honeycombs') && users.includes('Balances') && users.includes('id="hcGrantForm"'));
  // Namen maskiert
  assert.ok(users.includes('Mia &lt;img src=x onerror=alert(1)&gt;') && !users.includes('<img src=x'));
  assert.equal(section(await page('?hc_tab=nope')), overview);
});

test('only admins: a user and an admin working as a user are sent away and nothing changes; without CSRF nothing changes', async () => {
  const before = await item('code_page');
  for (const o of [{ userId: 5 }, { userId: 5, impersonatedBy: 3 }]) {
    const ctx = await post({ hc_action: 'item_save', item_id: String(await itemId('code_page')), price: '1', position: '0' }, o);
    assert.equal(ctx.status, 302);
    assert.equal(ctx.header('Location'), '/dashboard');
    const get = await runRequest(makeTestCtx({ url: '/admin?hc_tab=catalogue', cookies: { PHPSESSID: await loginSession(o.userId, { impersonatedBy: o.impersonatedBy }) } }), appRoutes);
    assert.equal(get.header('Location'), '/dashboard');
  }
  const ctx = await post({ hc_action: 'item_save', item_id: String(await itemId('code_page')), price: '1', position: '0' }, { csrf: false });
  assert.equal(ctx.header('Location'), '/admin');
  assert.equal(flash(ctx).error, 'Session expired – please try again.');
  assert.deepEqual(await item('code_page'), before);
  assert.equal(await auditCount(), 0);
});

test('settings: the earning rules are saved within their limits, other keys stay, and the changed values are logged', async () => {
  await sql("REPLACE INTO `DB`.oys_meta (meta_key, meta_value) VALUES ('honeycombs', ?)", ['{"daily":5,"profile":20,"views":10,"views_step":100,"code_page":150,"later_key":"keep me"}']);
  let ctx = await post({ hc_action: 'settings', daily: '7', profile: '-5', views: '200000', views_step: '0' });
  assert.equal(ctx.header('Location'), '/admin?hc_tab=rules#honeycombs');
  assert.deepEqual(flash(ctx), { ok: 'Honeycomb settings saved.', error: undefined });
  assert.deepEqual(await meta(), { daily: 7, profile: 0, views: 100000, views_step: 1, code_page: 150, later_key: 'keep me' });
  assert.deepEqual(await lastAudit(), { admin_id: 3, action: 'settings', user_id: null, target: 'honeycombs', details: '{"daily":7,"profile":0,"views":100000,"views_step":1}' });
  // Was das Formular nicht schickt, bleibt; gleiche Werte: keine neue Protokollzeile
  const n = await auditCount();
  ctx = await post({ hc_action: 'settings', daily: '7' });
  assert.deepEqual(await meta(), { daily: 7, profile: 0, views: 100000, views_step: 1, code_page: 150, later_key: 'keep me' });
  assert.equal(await auditCount(), n);
  // Arrays: abgelehnt, nichts geändert
  ctx = await post({ hc_action: 'settings', daily: ['9'] });
  assert.equal(flash(ctx).error, 'Not all of the data arrived. Please try again.');
  assert.equal((await meta() as { daily: number }).daily, 7);
  // Die Seite zeigt die Werte und kein Preisfeld mehr
  const rules = section(await page('?hc_tab=rules'));
  assert.match(rules, /name="daily" min="0" max="100000" step="1" value="7"/);
  assert.ok(!rules.includes('name="code_page"'));
  await post({ hc_action: 'settings', daily: '5', profile: '20', views: '10', views_step: '100' });
});

test('item_save: price, switch, position, window and minimums with their checks; Premium and timed options can’t be switched on yet', async () => {
  const id = await itemId('code_page');
  const save = (o: Record<string, string>, itemIdValue = id) => post({ hc_action: 'item_save', item_id: String(itemIdValue), price: '100', is_active: '1', position: '0',
    available_from: '', available_until: '', min_account_days: '0', min_active_days: '0', ...o });
  let ctx = await save({ price: '120', position: '-5', available_from: '2026-12-01T10:00', available_until: '2026-12-24T18:30', min_active_days: '3' });
  assert.equal(ctx.header('Location'), '/admin?hc_tab=catalogue#honeycombs');
  assert.deepEqual(flash(ctx), { ok: 'Saved “Code page”.', error: undefined });
  assert.deepEqual(await item('code_page'), { price: 120, is_active: 1, position: -5, available_from: '2026-12-01 10:00:00', available_until: '2026-12-24 18:30:00', min_account_days: 0, min_active_days: 3 });
  assert.deepEqual(await lastAudit(), { admin_id: 3, action: 'item_save', user_id: null, target: 'code_page',
    details: '{"price":120,"price_was":100,"position":-5,"position_was":0,"available_from":"2026-12-01 10:00:00","available_from_was":null,"available_until":"2026-12-24 18:30:00","available_until_was":null,"min_active_days":3,"min_active_days_was":0}' });
  // Nichts geändert: Meldung, aber keine Protokollzeile
  const n = await auditCount();
  await save({ price: '120', position: '-5', available_from: '2026-12-01T10:00', available_until: '2026-12-24T18:30', min_active_days: '3' });
  assert.equal(await auditCount(), n);
  // Ungültige Eingaben ändern nichts
  const cases: Array<[Record<string, string>, string]> = [
    [{ price: '-1' }, 'Enter a price between 0 and 1,000,000.'], [{ price: '1000001' }, 'Enter a price between 0 and 1,000,000.'], [{ price: 'abc' }, 'Enter a price between 0 and 1,000,000.'],
    [{ price: '' }, 'Enter a price between 0 and 1,000,000.'], [{ price: '1.5' }, 'Enter a price between 0 and 1,000,000.'],
    [{ position: '1001' }, 'Position: enter a whole number from −1,000 to 1,000.'],
    [{ available_from: '2026-02-31T10:00' }, 'Please enter “Available from” and “until” as a date and time.'], [{ available_until: 'tomorrow' }, 'Please enter “Available from” and “until” as a date and time.'],
    [{ available_from: '2026-12-24T10:00', available_until: '2026-12-24T10:00' }, '“Available until” must be after “Available from”.'],
    [{ min_account_days: '3651' }, 'Minimum days: enter 0 to 3,650.'], [{ min_active_days: '-1' }, 'Minimum days: enter 0 to 3,650.'],
    [{ item_id: '999999' }, 'Option not found.'], [{ item_id: 'x' }, 'Option not found.'],
  ];
  for (const [o, error] of cases) {
    ctx = await save({ price: '130', ...o });
    assert.equal(flash(ctx).error, error, JSON.stringify(o));
  }
  ctx = await post({ hc_action: 'item_save', item_id: String(id), price: ['1'] });
  assert.equal(flash(ctx).error, 'Not all of the data arrived. Please try again.');
  assert.equal((await item('code_page')).price, 120);
  // Premium: Mindestalter nie unter 30 Tagen; einschalten erst, wenn Premium bereit ist und der Ablauf steht
  const p30 = await itemId('premium_30');
  ctx = await save({ price: '350', is_active: '', min_account_days: '29', min_active_days: '10' }, p30);
  assert.equal(flash(ctx).error, 'Premium needs accounts that are at least 30 days old.');
  ctx = await save({ price: '300', is_active: '1', min_account_days: '30', min_active_days: '10' }, p30);
  assert.equal(flash(ctx).error, 'This option can’t be switched on yet.');
  assert.equal((await item('premium_30')).is_active, 0);
  ctx = await save({ price: '300', is_active: '', min_account_days: '45', min_active_days: '10' }, p30);
  assert.deepEqual(flash(ctx), { ok: 'Saved “Premium · 30 days”.', error: undefined });
  assert.deepEqual([(await item('premium_30')).price, (await item('premium_30')).min_account_days], [300, 45]);
  // Zeitpakete einer bereiten Funktion: erst mit dem Ablauf (HC-7a)
  const checks = await itemId('test_checks_30');
  ctx = await save({ price: '60', is_active: '1' }, checks);
  assert.equal(flash(ctx).error, 'This option can’t be switched on yet.');
  setLifecycleReadyForTests(true);
  ctx = await save({ price: '60', is_active: '1' }, checks);
  assert.deepEqual(flash(ctx), { ok: 'Saved “Extra checks · 30 days”.', error: undefined });
  setLifecycleReadyForTests(false);
  // Ausschalten geht immer
  ctx = await save({ price: '60', is_active: '' }, checks);
  assert.equal((await item('test_checks_30')).is_active, 0);
  // Die Seite: Schalter, die noch nicht gehen, sind aus und sagen warum
  const cat = section(await page('?hc_tab=catalogue'));
  assert.match(cat, /data-item="premium_30"[\s\S]*?<label class="[^"]*" title="This option can’t be switched on yet\."><input type="checkbox" name="is_active" value="1" disabled/);
  assert.match(cat, /data-item="code_page"[\s\S]*?name="price" required min="0" max="1000000" step="1" value="120"[\s\S]*?name="is_active" value="1" checked class/);
  assert.match(cat, /name="available_from" value="2026-12-01T10:00"/);
  await save({ price: '100', position: '0' });
});

test('item_add: a duration or pack size for a ready feature, off until switched on; duplicates and wrong features are refused', async () => {
  let ctx = await post({ hc_action: 'item_add', feature: 'test_checks', days: '7', price: '20' });
  assert.equal(ctx.header('Location'), '/admin?hc_tab=catalogue#honeycombs');
  assert.deepEqual(flash(ctx), { ok: 'Added “Extra checks · 7 days”. It stays off until you switch it on.', error: undefined });
  assert.deepEqual((await rows('SELECT feature, days, units, price, is_active, position, min_account_days, min_active_days FROM `DB`.hc_items WHERE item_key = ?', ['test_checks_7']))[0],
    { feature: 'test_checks', days: 7, units: 1, price: 20, is_active: 0, position: 10, min_account_days: 0, min_active_days: 2 });
  assert.deepEqual(await lastAudit(), { admin_id: 3, action: 'item_add', user_id: null, target: 'test_checks_7', details: '{"price":20,"days":7,"units":null}' });
  ctx = await post({ hc_action: 'item_add', feature: 'test_checks', days: '7', price: '25' });
  assert.equal(flash(ctx).error, 'This option already exists.');
  ctx = await post({ hc_action: 'item_add', feature: 'test_passes', units: '3', price: '100' });
  assert.equal(flash(ctx).ok, 'Added “Address pass · 3 passes”. It stays off until you switch it on.');
  assert.equal((await rows('SELECT units FROM `DB`.hc_items WHERE item_key = ?', ['test_passes_x3']))[0].units, 3);
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ feature: 'code_page', price: '10' }, 'Please choose a feature that can have more options.'],
    [{ feature: 'test_later', units: '2', price: '10' }, 'Please choose a feature that can have more options.'],
    [{ feature: 'nope', days: '7', price: '100' }, 'Please choose a feature that can have more options.'],
    [{ feature: 'test_checks', days: '0', price: '10' }, 'Enter a duration of 1 to 365 days.'],
    [{ feature: 'test_checks', days: '366', price: '10' }, 'Enter a duration of 1 to 365 days.'],
    [{ feature: 'test_passes', units: '11', price: '10' }, 'Enter a pack size of 1 to 10.'],
    [{ feature: 'test_checks', days: '8', price: '-3' }, 'Enter a price between 0 and 1,000,000.'],
    [{ feature: ['test_checks'], days: '8', price: '3' }, 'Not all of the data arrived. Please try again.'],
  ];
  for (const [o, error] of cases) {
    ctx = await post({ hc_action: 'item_add', ...o } as PhpArray);
    assert.equal(flash(ctx).error, error, JSON.stringify(o));
  }
  assert.equal(Number((await sql("SELECT COUNT(*) AS n FROM `DB`.hc_items WHERE feature IN ('test_checks', 'test_passes', 'test_later', 'premium')"))[0].n), 7);
  // Premium ist bereit (premium-domains): eine weitere Laufzeit erbt das Mindestalter von 30 Tagen und 10 aktive Tage
  assert.equal(premiumReady(), true);
  ctx = await post({ hc_action: 'item_add', feature: 'premium', days: '7', price: '100' });
  assert.equal(flash(ctx).ok, 'Added “Premium · 7 days”. It stays off until you switch it on.');
  assert.deepEqual((await rows("SELECT is_active, min_account_days, min_active_days FROM `DB`.hc_items WHERE item_key = 'premium_7'"))[0], { is_active: 0, min_account_days: 30, min_active_days: 10 });
  // Das Formular bietet nur Funktionen an, die weitere Optionen haben können
  const cat = section(await page('?hc_tab=catalogue'));
  assert.match(cat, /<select id="hcAddFeature" name="feature"[^>]*><option value="premium">Premium \(days\)<\/option><option value="status_more_checks">Extra checks \(days\)<\/option><option value="status_fast_checks">Fast checks \(days\)<\/option><option value="test_checks">Extra checks \(days\)<\/option><option value="test_passes">Address pass \(pack size\)<\/option><\/select>/);
});

test('offer_create and offer_cancel: checks, the double submit, the limit of 20, labels as text, the confirmation and the audit', async () => {
  const start = addDays(nowStr(), -1).slice(0, 16).replace(' ', 'T');
  const end = addDays(nowStr(), 5).slice(0, 16).replace(' ', 'T');
  const form = (o: Record<string, unknown> = {}): PhpArray => ({ hc_action: 'offer_create', label: 'Launch <script>alert(1)</script>', scope: 'item:code_page', discount: 'percent',
    percent_off: '30', fixed_price: '', starts_at: start, ends_at: end, max_uses: '500', per_user_max: '1', min_account_days: '0', min_active_days: '0', form_ref: randomHex(8), ...o } as PhpArray);
  const ref = randomHex(8);
  let ctx = await post(form({ form_ref: ref }));
  assert.equal(ctx.header('Location'), '/admin?hc_tab=offers#honeycombs');
  assert.deepEqual(flash(ctx), { ok: 'Offer “Launch <script>alert(1)</script>” created.', error: undefined });
  const offer = (await rows('SELECT id, label, scope, percent_off, fixed_price, max_uses, per_user_max, created_by FROM `DB`.hc_offers ORDER BY id DESC LIMIT 1'))[0];
  assert.deepEqual({ ...offer, id: 0 }, { id: 0, label: 'Launch <script>alert(1)</script>', scope: 'item:code_page', percent_off: 30, fixed_price: null, max_uses: 500, per_user_max: 1, created_by: 3 });
  assert.deepEqual(await lastAudit(), { admin_id: 3, action: 'offer_create', user_id: null, target: 'offer:' + offer.id, details: `{"offer":${offer.id},"percent":30,"fixed":null}` });
  ctx = await post(form({ form_ref: ref }));
  assert.equal(flash(ctx).error, 'This offer was already created – the form was sent twice.');
  // Fester Preis: das Prozentfeld zählt dann nicht; nur für eine einzelne Option
  ctx = await post(form({ label: 'Fixed', discount: 'fixed', percent_off: '30', fixed_price: '80' }));
  assert.equal(flash(ctx).ok, 'Offer “Fixed” created.');
  assert.deepEqual((await rows("SELECT percent_off, fixed_price FROM `DB`.hc_offers WHERE label = 'Fixed'"))[0], { percent_off: null, fixed_price: 80 });
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ label: '' }, 'Please give the offer a name (up to 60 characters).'],
    [{ scope: 'feature:code_page', discount: 'fixed', fixed_price: '50' }, 'A fixed price is only possible for a single option.'],
    [{ scope: 'item:nope' }, 'Please choose what the offer is for.'],
    [{ percent_off: '101' }, 'Enter a discount between 1 and 100 %.'],
    [{ discount: 'fixed', fixed_price: '101' }, 'The fixed price can be 0 to 100 (the list price).'],
    [{ ends_at: start }, 'Please enter a start and an end after it.'],
    [{ starts_at: addDays(nowStr(), -20).slice(0, 16).replace(' ', 'T'), ends_at: addDays(nowStr(), -2).slice(0, 16).replace(' ', 'T') }, 'The end must be in the future.'],
    [{ ends_at: addDays(nowStr(), 95).slice(0, 16).replace(' ', 'T') }, 'An offer can run for up to 90 days.'],
    [{ scope: 'all', min_account_days: '10' }, 'Offers that include Premium need accounts that are at least 30 days old.'],
    [{ max_uses: '0' }, 'Maximum uses: leave it empty or enter 1 to 1,000,000.'],
    [{ form_ref: 'nope' }, 'The form is out of date. Please reload the page.'],
    [{ label: ['x'] }, 'Not all of the data arrived. Please try again.'],
  ];
  for (const [o, error] of cases) {
    ctx = await post(form(o));
    assert.equal(flash(ctx).error, error, JSON.stringify(o));
  }
  // Höchstens 20 laufende oder geplante Angebote
  for (let i = 0; i < 18; i++) await post(form({ label: 'Bulk ' + i }));
  ctx = await post(form({ label: 'One too many' }));
  assert.equal(flash(ctx).error, 'There are already 20 active or upcoming offers.');
  // Liste: Name als Text, Nutzungen, Status, Absagen mit Bestätigung
  const list = section(await page('?hc_tab=offers'));
  assert.ok(list.includes('Launch &lt;script&gt;alert(1)&lt;/script&gt;') && !list.includes('<script>alert(1)'));
  assert.match(list, new RegExp(`<tr data-offer="${offer.id}">[\\s\\S]*?Only Code page · 1 per account[\\s\\S]*?−30 %[\\s\\S]*?0 / 500[\\s\\S]*?>Running</span>`));
  assert.match(list, new RegExp(`<form action="/admin" method="POST" class="m-0" data-confirm="Cancel the offer “Launch &lt;script&gt;alert\\(1\\)&lt;/script&gt;”\\?" data-confirm-text="It ends right away\\. Purchases made with it keep their price\\." data-confirm-ok="Cancel offer" data-confirm-tone="danger">[^]*?<input type="hidden" name="_confirmed" value="0" autocomplete="off"><input type="hidden" name="hc_action" value="offer_cancel"><input type="hidden" name="offer_id" value="${offer.id}">`));
  // Ohne Bestätigung: nichts geändert, zurück zu den Angeboten
  const n = await auditCount();
  ctx = await post({ hc_action: 'offer_cancel', offer_id: String(offer.id), _confirmed: '0' });
  assert.equal(ctx.header('Location'), '/admin?hc_tab=offers#honeycombs');
  assert.equal(flash(ctx).error, UNCONFIRMED_MESSAGE);
  assert.equal((await rows('SELECT cancelled_at FROM `DB`.hc_offers WHERE id = ?', [offer.id]))[0].cancelled_at, null);
  assert.equal(await auditCount(), n);
  // Ohne das Feld (selbst gebautes Formular): ebenso nichts – wie refund und feature_revoke
  ctx = await post({ hc_action: 'offer_cancel', offer_id: String(offer.id) });
  assert.equal(flash(ctx).error, UNCONFIRMED_MESSAGE);
  assert.equal((await rows('SELECT cancelled_at FROM `DB`.hc_offers WHERE id = ?', [offer.id]))[0].cancelled_at, null);
  assert.equal(await auditCount(), n);
  ctx = await post({ hc_action: 'offer_cancel', offer_id: String(offer.id), _confirmed: '1' });
  assert.deepEqual(flash(ctx), { ok: 'Offer cancelled. Purchases made with it keep their price.', error: undefined });
  assert.notEqual((await rows('SELECT cancelled_at FROM `DB`.hc_offers WHERE id = ?', [offer.id]))[0].cancelled_at, null);
  assert.deepEqual(await lastAudit(), { admin_id: 3, action: 'offer_cancel', user_id: null, target: 'offer:' + offer.id, details: `{"offer":${offer.id}}` });
  ctx = await post({ hc_action: 'offer_cancel', offer_id: '999999', _confirmed: '1' });
  assert.equal(flash(ctx).error, 'Offer not found.');
  assert.match(section(await page('?hc_tab=offers')), new RegExp(`<tr data-offer="${offer.id}">[\\s\\S]*?>Cancelled</span></td><td class="px-5 py-3 text-right"></td>`));
  await sql('DELETE FROM `DB`.hc_offers');
});

test('_confirmed=0 changes nothing for any honeycomb action', async () => {
  const before = { meta: await meta(), items: await rows('SELECT * FROM `DB`.hc_items ORDER BY id'), offers: await rows('SELECT * FROM `DB`.hc_offers'), audit: await auditCount() };
  const forms: PhpArray[] = [
    { hc_action: 'settings', daily: '9' },
    { hc_action: 'item_save', item_id: String(await itemId('code_page')), price: '5', position: '0' },
    { hc_action: 'item_add', feature: 'test_checks', days: '14', price: '5' },
    { hc_action: 'offer_create', label: 'X', scope: 'all', discount: 'percent', percent_off: '10', starts_at: '2026-12-01T00:00', ends_at: '2026-12-02T00:00', min_account_days: '30', form_ref: randomHex(8) },
    { hc_action: 'grant', user_id: '5', amount: '50', grant_ref: randomHex(8) },
  ];
  for (const form of forms) {
    const ctx = await post({ ...form, _confirmed: '0' });
    assert.equal(ctx.header('Location'), hcBackUrl(form), JSON.stringify(form));
    assert.equal(flash(ctx).error, UNCONFIRMED_MESSAGE);
  }
  assert.deepEqual({ meta: await meta(), items: await rows('SELECT * FROM `DB`.hc_items ORDER BY id'), offers: await rows('SELECT * FROM `DB`.hc_offers'), audit: await auditCount() }, before);
  assert.equal(Number((await sql('SELECT COUNT(*) AS n FROM `DB`.honeycomb_ledger WHERE user_id = 5'))[0].n), 0);
});

test('overview: circulation, 30-day flows, Premium, what ends soon, top options, earned by reason, accounts waiting, latest activity', async () => {
  const now = nowStr();
  const ledger = 'INSERT INTO `DB`.honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (?, ?, ?, ?, ?, ?)';
  await sql(ledger, [5, 300, 'admin', 'a3-' + randomHex(8), 'Welcome <b>gift</b>', now]);
  await sql(ledger, [5, 5, 'daily', '2026-11-01', '', now]);
  await sql(ledger, [5, -100, 'unlock', 'code_page', 'Code page', now]);
  await sql(ledger, [6, 50, 'admin', 'a3-' + randomHex(8), 'Old gift', '2025-01-01 10:00:00']);
  await sql(`INSERT INTO \`DB\`.hc_purchases (user_id, request_id, item_key, feature, lot, units, days, list_price, price, offer_id, ledger_id, via, created_at)
      VALUES (5, ?, 'code_page', 'code_page', 0, 1, NULL, 100, 100, NULL, 3, 'shop', ?)`, [randomHex(16), now]);
  await sql('UPDATE `DB`.users SET premium_until = ? WHERE id = 5', [addDays(now, 3)]);
  await sql(`INSERT INTO \`DB\`.hc_entitlements (user_id, feature, lot, quantity, permanent, expires_at, source, note, created_at, updated_at)
      VALUES (5, 'premium', 0, 1, 0, ?, 'admin', '', ?, ?)`, [addDays(now, 3), now, now]);
  await sql(`INSERT INTO \`DB\`.hc_accounts (user_id, reconcile_at, reconcile_gen, reconcile_error, created_at, updated_at) VALUES (5, ?, 2, 'domains: Cloudflare said no', ?, ?)
      ON DUPLICATE KEY UPDATE reconcile_at = VALUES(reconcile_at), reconcile_error = VALUES(reconcile_error)`, [addDays(now, -1), now, now]);
  const html = section(await page());
  const kpi = (label: string): string => (new RegExp(`${label}</p><h3 class="text-2xl font-bold text-white">([^<]*)</h3>`).exec(html) ?? [])[1];
  assert.deepEqual([kpi('In circulation'), kpi('Earned · 30 days'), kpi('Spent · 30 days'), kpi('Active Premium')], ['255', '305', '100', '1']);
  assert.match(html, /id="hcEnding"[\s\S]*?Mia &lt;img src=x onerror=alert\(1\)&gt;<\/span> <span class="text-gray-400">– Premium<\/span>/);
  assert.match(html, /id="hcTop"[\s\S]*?<td class="px-5 py-2\.5 text-white">Code page<\/td><td class="px-4 py-2\.5 text-right text-gray-300">1<\/td><td[^>]*>100 <i class='bx bx-hive text-yellow-400'><\/i>/);
  assert.match(html, /id="hcEarned"[\s\S]*?Gifts from the team<\/span><span class="text-white font-medium">300<\/span>[\s\S]*?Active days<\/span><span class="text-white font-medium">5<\/span>/);
  assert.ok(!/id="hcEarned"[\s\S]*?Unlocks/.test(html.slice(0, html.indexOf('id="hcAttention"'))), 'only positive entries count as earned');
  assert.match(html, /1 account is waiting to be updated \(oldest since [A-Z][a-z]{2} \d{1,2}, \d\d:\d\d\): domains: Cloudflare said no/);
  assert.match(html, /id="hcRecent"[\s\S]*?Welcome &lt;b&gt;gift&lt;\/b&gt;/);
  assert.ok(!html.includes('<b>gift</b>'));
  // Höchstens 10 letzte Buchungen
  for (let i = 0; i < 12; i++) await sql(ledger, [6, 1, 'admin', 'a3-' + randomHex(8), 'Tiny ' + i, now]);
  const recent = section(await page()).split('id="hcRecent"')[1];
  assert.equal(recent.match(/<li class="py-2\.5/g)?.length, 10);
});
