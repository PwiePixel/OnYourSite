// HTTP: Admin, Bereich „Honeycombs“, Teil II (honeycomb-shop HC-6a) – Details eines Nutzers, Freischaltungen schenken
// und entziehen (feature_grant/feature_revoke mit form_ref), Erstattungen (refund) und die Glocke (genau einmal).
// Dazu: nur Admins, CSRF, _confirmed, gleichzeitige Erstattungen buchen nur einmal, Namen maskiert.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { randomHex } from '../src/crypto.js';
import { makeTestCtx, type Ctx } from '../src/web/ctx.js';
import { appRoutes } from '../src/app/dispatch.js';
import { ensureSchema } from '../src/schema.js';
import { registerFeature, setLifecycleReadyForTests, unregisterFeatureForTests, type Feature } from '../src/honeycombs/features.js';
import { hcBackUrl } from '../src/honeycombs/admin.js';
import { buy, refund } from '../src/honeycombs/shop.js';
import { grantFeature } from '../src/honeycombs/grants.js';
import { UNCONFIRMED_MESSAGE } from '../src/views/partials/ui.js';
import { GRANT_ASK_ABOVE } from '../src/honeycombs/honeycombs.js';
import type { PhpArray } from '../src/php.js';
import '../src/code/shop.js';
import { CSRF, loginSession, runRequest, testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
const OLD = '2026-01-01 10:00:00';

async function sql(query: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [r] = await t.admin.query<RowDataPacket[]>(query.replace(/`DB`/g, '`' + t.name + '`'), params);
  return r;
}
const num = async (query: string, params: unknown[] = []): Promise<number> => Number(Object.values((await sql(query, params))[0] ?? { n: 0 })[0] ?? 0);

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
const section = (html: string): string => html.slice(html.indexOf('<div id="tab-honeycombs"'), html.indexOf('<div id="tab-code-pages"'));
const balance = (uid: number): Promise<number> => num('SELECT COALESCE(SUM(amount), 0) FROM `DB`.honeycomb_ledger WHERE user_id = ?', [uid]);
const bells = (uid: number, type: string): Promise<number> => num('SELECT COUNT(*) FROM `DB`.notifications WHERE user_id = ? AND type = ?', [uid, type]);
async function ent(uid: number, key: string, lot = 0): Promise<Record<string, unknown> | undefined> {
  const r = (await sql('SELECT quantity, permanent, expires_at, source FROM `DB`.hc_entitlements WHERE user_id = ? AND feature = ? AND lot = ?', [uid, key, lot]))[0];
  return r ? { ...r } : undefined;
}
// Guthaben über die heutige Aktion „grant“
async function give(uid: number, amount: number): Promise<void> {
  const ctx = await post({ hc_action: 'grant', user_id: String(uid), amount: String(amount), grant_ref: randomHex(8) });
  assert.ok(String(flash(ctx).ok).startsWith('+'), String(flash(ctx).error));
}
async function buyItem(uid: number, key: string): Promise<number> {
  const price = await num('SELECT price FROM `DB`.hc_items WHERE item_key = ?', [key]);
  const r = await buy(null, uid, key, randomHex(16), price, { via: 'shop', terms: true });
  assert.ok(r.ok, JSON.stringify(r));
  return num('SELECT MAX(id) FROM `DB`.hc_purchases WHERE user_id = ?', [uid]);
}

const TEST_FEATURES: Feature[] = [
  { key: 'test_checks', owner: 'test', title: 'Extra checks', icon: 'bx-pulse', description: 'Packs for tests.', kind: 'timed', stack: 2,
    items: { test_checks_30: { days: 30, price: 60, active: false } } },
  { key: 'test_passes', owner: 'test', title: 'Address pass', icon: 'bx-transfer', description: 'Passes for tests.', kind: 'consumable', max: 3,
    items: { test_passes_x1: { units: 1, price: 40, active: false } } },
];

before(async () => {
  // Diese Abläufe prüfen zuerst den Stand vor HC-7a (zeitlich begrenzt gesperrt) und schalten es selbst ein
  setLifecycleReadyForTests(false);
  t = await testDatabase('hcadmin2', { empty: true });
  await ensureSchema();
  const user = 'INSERT INTO `DB`.users (id, email, password, full_name, is_admin, created_at) VALUES (?, ?, \'x\', ?, ?, ?)';
  await sql(user, [3, 'admin@test.de', 'Pixel Admin', 1, OLD]);
  await sql(user, [5, 'mia@test.de', 'Mia <img src=x onerror=alert(1)>', 0, OLD]);
  await sql(user, [7, 'tom@test.de', 'Tom', 0, OLD]);
  await sql(user, [8, 'lea@test.de', 'Lea', 0, OLD]);
  for (const f of TEST_FEATURES) registerFeature(f);
  await page();
  await sql("UPDATE `DB`.hc_items SET is_active = 1 WHERE item_key IN ('code_page', 'test_passes_x1')");
});

after(async () => {
  setLifecycleReadyForTests(true);
  for (const f of TEST_FEATURES) unregisterFeatureForTests(f.key);
  await t.done();
});

test('back links: grant, revoke and refund go back to the details of the user', () => {
  assert.equal(hcBackUrl({ hc_action: 'feature_grant', user_id: '5' }), '/admin?hc_tab=users&hc_user=5#honeycombs');
  assert.equal(hcBackUrl({ hc_action: 'refund', user_id: '7' }), '/admin?hc_tab=users&hc_user=7#honeycombs');
  assert.equal(hcBackUrl({ hc_action: 'feature_revoke', user_id: '0' }), '/admin?hc_tab=users#honeycombs');
  assert.equal(hcBackUrl({ hc_action: 'feature_revoke', user_id: ['5'] }), '/admin?hc_tab=users#honeycombs');
  assert.equal(hcBackUrl({ hc_action: 'grant', user_id: '5' }), '/admin?hc_tab=users#honeycombs');
});

test('feature_grant for good: the code page once, a second grant books nothing, the bell rings exactly once', async () => {
  const ctx = await post({ hc_action: 'feature_grant', user_id: '7', feature: 'code_page', mode: 'permanent', note: 'Welcome', form_ref: randomHex(8) });
  assert.equal(ctx.header('Location'), '/admin?hc_tab=users&hc_user=7#honeycombs');
  assert.equal(flash(ctx).ok, 'Code page given to Tom.');
  assert.deepEqual(await ent(7, 'code_page'), { quantity: 1, permanent: 1, expires_at: null, source: 'admin' });
  assert.equal(await num("SELECT COUNT(*) FROM `DB`.honeycomb_ledger WHERE user_id = 7 AND reason = 'unlock' AND amount = 0"), 1);
  const again = await post({ hc_action: 'feature_grant', user_id: '7', feature: 'code_page', mode: 'permanent', form_ref: randomHex(8) });
  assert.equal(flash(again).error, 'Tom already has this.');
  // ohne form_ref (ST-4 ruft so auf): weiterhin einmalig
  assert.deepEqual(await grantFeature(3, 7, 'code_page', { permanent: true }, ''), { error: 'Tom already has this.' });
  assert.equal(await bells(7, 'unlock'), 1);
  assert.equal(await num("SELECT COUNT(*) FROM `DB`.hc_audit WHERE action = 'feature_grant' AND user_id = 7"), 1);
  assert.equal(await balance(7), 0);
});

test('feature_grant with one form_ref twice books once; packs up to the maximum; time-limited grants wait for the lifecycle', async () => {
  const ref = randomHex(8);
  const form = { hc_action: 'feature_grant', user_id: '8', feature: 'test_passes', mode: 'units', days: '', units: '2', form_ref: ref };
  assert.equal(flash(await post(form)).ok, '2 × Address pass given to Lea.');
  assert.equal(flash(await post(form)).error, 'This was already booked – the form was sent twice.');
  assert.equal((await ent(8, 'test_passes'))?.quantity, 2);
  assert.equal(await bells(8, 'unlock'), 1);
  assert.equal(flash(await post({ ...form, form_ref: randomHex(8) })).error, 'Lea already has the maximum (3).');
  assert.equal(flash(await post({ ...form, units: '11', form_ref: randomHex(8) })).error, 'Enter a number from 1 to 10.');
  assert.equal(flash(await post({ ...form, form_ref: 'nope' })).error, 'Please reload the page and try again.');
  // Tage: erst mit dem Ablauf (HC-7a)
  const days = { hc_action: 'feature_grant', user_id: '8', feature: 'test_checks', mode: 'days', days: '10', form_ref: randomHex(8) };
  assert.equal(flash(await post(days)).error, 'Time-limited grants can’t be given yet – give it for good instead.');
  setLifecycleReadyForTests(true);
  try {
    assert.match(String(flash(await post(days)).ok), /^Extra checks given to Lea until [A-Z][a-z]{2} \d{1,2}, \d{4}\.$/);
    assert.equal(flash(await post(days)).error, 'This was already booked – the form was sent twice.');
    const first = String((await ent(8, 'test_checks'))?.expires_at);
    // ein zweites Geschenk verlängert ab dem bisherigen Ende
    await post({ ...days, form_ref: randomHex(8) });
    const second = String((await ent(8, 'test_checks'))?.expires_at);
    assert.equal(Date.parse(second.replace(' ', 'T') + 'Z') - Date.parse(first.replace(' ', 'T') + 'Z'), 10 * 86400000);
    assert.equal(flash(await post({ ...days, days: '3651', form_ref: randomHex(8) })).error, 'Enter 1 to 3,650 days.');
    // für immer
    assert.equal(flash(await post({ ...days, mode: 'permanent', form_ref: randomHex(8) })).ok, 'Extra checks given to Lea for good.');
    assert.equal((await ent(8, 'test_checks'))?.permanent, 1);
    assert.equal(flash(await post({ ...days, form_ref: randomHex(8) })).error, 'Lea already has this.');
  } finally {
    setLifecycleReadyForTests(false);
  }
  // Premium für immer (bis HC-7a die einzige Art); users.premium_until in derselben Transaktion
  assert.equal(flash(await post({ hc_action: 'feature_grant', user_id: '8', feature: 'premium', mode: 'permanent', form_ref: randomHex(8) })).ok, 'Premium given to Lea for good.');
  assert.equal(String((await sql('SELECT premium_until FROM `DB`.users WHERE id = 8'))[0].premium_until), '9999-12-31 23:59:59');
  assert.equal(flash(await post({ hc_action: 'feature_grant', user_id: '8', feature: 'premium', mode: 'days', days: '30', form_ref: randomHex(8) })).error,
    'Time-limited grants can’t be given yet – give it for good instead.');
  assert.equal(flash(await post({ hc_action: 'feature_grant', user_id: '8', feature: 'nope', mode: 'permanent', form_ref: randomHex(8) })).error, 'This feature can’t be given yet.');
  assert.equal(flash(await post({ hc_action: 'feature_grant', user_id: '999', feature: 'premium', mode: 'permanent', form_ref: randomHex(8) })).error, 'Please choose a user.');
  assert.equal(await bells(8, 'unlock'), 5);
  const off = await post({ hc_action: 'feature_revoke', user_id: '8', feature: 'premium', lot: '', form_ref: randomHex(8), _confirmed: '1' });
  assert.equal(flash(off).ok, 'Premium removed from Lea.');
  assert.equal((await sql('SELECT premium_until FROM `DB`.users WHERE id = 8'))[0].premium_until, null);
});

test('feature_revoke: only confirmed, one form_ref books once, the bell rings once, nothing left → a clear message', async () => {
  const ref = randomHex(8);
  const form = { hc_action: 'feature_revoke', user_id: '8', feature: 'test_passes', lot: '', note: '', form_ref: ref };
  // ohne Bestätigung (Feld fehlt oder 0): nichts
  assert.equal(flash(await post(form)).error, UNCONFIRMED_MESSAGE);
  assert.equal(flash(await post({ ...form, _confirmed: '0' })).error, UNCONFIRMED_MESSAGE);
  assert.equal((await ent(8, 'test_passes'))?.quantity, 2);
  const bellsBefore = await bells(8, 'unlock');
  const ctx = await post({ ...form, _confirmed: '1' });
  assert.equal(ctx.header('Location'), '/admin?hc_tab=users&hc_user=8#honeycombs');
  assert.equal(flash(ctx).ok, 'Address pass removed from Lea.');
  assert.equal((await ent(8, 'test_passes'))?.quantity, 0);
  assert.equal(flash(await post({ ...form, _confirmed: '1' })).error, 'This was already booked – the form was sent twice.');
  assert.equal(flash(await post({ ...form, form_ref: randomHex(8), _confirmed: '1' })).error, 'Lea doesn’t have this.');
  assert.equal(await bells(8, 'unlock'), bellsBefore + 1);
  // ein zweites Geschenk und derselbe Entzug-Schlüssel noch einmal: entzogen wird nicht
  await post({ hc_action: 'feature_grant', user_id: '8', feature: 'test_passes', mode: 'units', units: '1', form_ref: randomHex(8) });
  assert.equal(flash(await post({ ...form, _confirmed: '1' })).error, 'This was already booked – the form was sent twice.');
  assert.equal((await ent(8, 'test_passes'))?.quantity, 1);
});

test('refund: full and partial, remove or keep, at most the refundable value, never twice, bell once, confirmed only', async () => {
  await give(5, 500);
  const pid = await buyItem(5, 'code_page');
  const price = await num('SELECT price FROM `DB`.hc_purchases WHERE id = ?', [pid]);
  assert.ok(price > 0);
  const base = { hc_action: 'refund', user_id: '5', purchase_id: String(pid), amount: '', note: '' };
  assert.equal(flash(await post({ ...base, remove: '1' })).error, UNCONFIRMED_MESSAGE);
  assert.equal(flash(await post({ ...base, _confirmed: '1' })).error, 'Please choose whether to remove what was bought.');
  assert.equal(flash(await post({ ...base, remove: '1', amount: String(price + 1), _confirmed: '1' })).error, 'Refund at most ' + price + ' honeycombs (the unused part).');
  assert.equal(flash(await post({ ...base, remove: '1', amount: '-1', _confirmed: '1' })).error, 'Enter the refund as a whole number of honeycombs.');
  const before = await balance(5);
  const ctx = await post({ ...base, remove: '1', _confirmed: '1' });
  assert.equal(ctx.header('Location'), '/admin?hc_tab=users&hc_user=5#honeycombs');
  assert.equal(flash(ctx).ok, 'Refunded ' + price + ' honeycombs to Mia <img src=x onerror=alert(1)>. The code page is locked again.');
  assert.equal(await balance(5), before + price);
  assert.equal((await ent(5, 'code_page'))?.quantity, 0);
  assert.equal(await bells(5, 'honeycombs'), 2); // Geschenk + Erstattung
  assert.equal(await num("SELECT COUNT(*) FROM `DB`.notifications WHERE user_id = 5 AND type = 'honeycombs' AND title = '+500 honeycombs from the team'"), 1);
  assert.equal(flash(await post({ ...base, remove: '0', _confirmed: '1' })).error, 'This purchase was already refunded.');
  assert.equal(await balance(5), before + price);
  assert.equal(await bells(5, 'honeycombs'), 2);
  // erneut gekauft, teilweise erstattet, Freischaltung bleibt
  const again = await buyItem(5, 'code_page');
  assert.equal(flash(await post({ ...base, purchase_id: String(again), amount: '10', remove: '0', _confirmed: '1' })).ok,
    'Refunded 10 honeycombs to Mia <img src=x onerror=alert(1)>. The code page stays unlocked.');
  assert.equal((await ent(5, 'code_page'))?.quantity, 1);
  assert.equal(flash(await post({ ...base, purchase_id: '999999', remove: '1', _confirmed: '1' })).error, 'Purchase not found.');
});

test('refund race: two refunds of one purchase at the same time pay out once', async () => {
  await give(7, 200);
  const pid = await buyItem(7, 'test_passes_x1');
  const before = await balance(7);
  const results = await Promise.all([refund(3, pid, null, true, ''), refund(3, pid, null, true, ''), refund(3, pid, null, false, '')]);
  assert.equal(results.filter((r) => 'ok' in r).length, 1, JSON.stringify(results));
  for (const r of results.filter((x) => 'error' in x)) {
    assert.ok(['This purchase was already refunded.', 'Honeycombs are busy right now – please try again in a moment.'].includes((r as { error: string }).error), JSON.stringify(r));
  }
  assert.equal(await balance(7), before + 40);
  assert.equal(await num("SELECT COUNT(*) FROM `DB`.honeycomb_ledger WHERE user_id = 7 AND reason = 'refund'"), 1);
  // auch über zwei gleichzeitige Formulare
  const pid2 = await buyItem(7, 'test_passes_x1');
  const form = { hc_action: 'refund', user_id: '7', purchase_id: String(pid2), amount: '', remove: '1', note: '', _confirmed: '1' };
  const ctxs = await Promise.all([post(form), post(form)]);
  assert.equal(ctxs.filter((c) => flash(c).ok !== undefined).length, 1);
  assert.equal(await num("SELECT COUNT(*) FROM `DB`.honeycomb_ledger WHERE user_id = 7 AND reason = 'refund'"), 2);
  assert.equal(await num("SELECT COUNT(*) FROM `DB`.notifications WHERE user_id = 7 AND type = 'honeycombs' AND title LIKE '%refunded%'"), 2);
});

test('only admins, CSRF and arrays: nothing changes for users, admins working as a user, missing CSRF or array fields', async () => {
  await give(8, 300);
  const pid = await buyItem(8, 'code_page');
  const forms: PhpArray[] = [
    { hc_action: 'feature_grant', user_id: '8', feature: 'test_passes', mode: 'units', units: '1', form_ref: randomHex(8) },
    { hc_action: 'feature_revoke', user_id: '8', feature: 'code_page', lot: '', form_ref: randomHex(8), _confirmed: '1' },
    { hc_action: 'refund', user_id: '8', purchase_id: String(pid), amount: '', remove: '1', _confirmed: '1' },
  ];
  const snapshot = async (): Promise<unknown> => ({ l: await balance(8), e: await sql('SELECT feature, lot, quantity FROM `DB`.hc_entitlements WHERE user_id = 8 ORDER BY feature, lot'), b: await bells(8, 'unlock') });
  const state = await snapshot();
  for (const form of forms) {
    for (const o of [{ userId: 8 }, { userId: 8, impersonatedBy: 3 }]) {
      const ctx = await post(form, o);
      assert.equal(ctx.header('Location'), '/dashboard');
    }
    const ctx = await post(form, { csrf: false });
    assert.equal(flash(ctx).error, 'Session expired – please try again.');
    assert.equal(flash(await post({ ...form, user_id: ['8'], purchase_id: [String(pid)], feature: ['code_page'] })).error === undefined, false);
  }
  assert.deepEqual(await snapshot(), state);
  // ein GET der Details als Nutzer: weg
  const get = await runRequest(makeTestCtx({ url: '/admin?hc_tab=users&hc_user=8', cookies: { PHPSESSID: await loginSession(8) } }), appRoutes);
  assert.equal(get.header('Location'), '/dashboard');
});

test('users tab: server-side search, Premium column, details with unlocks, purchases, refund form, history and team actions – all escaped', async () => {
  const list = section(await page('?hc_tab=users&hc_q=tom'));
  const rowsPart = list.slice(list.indexOf('id="hcRows"'));
  assert.ok(rowsPart.includes('tom@test.de') && !rowsPart.includes('lea@test.de'), 'search filters on the server');
  assert.ok(list.includes('name="hc_q"') && list.includes('value="tom"'));
  assert.ok(list.includes('href="/admin?hc_tab=users&amp;hc_user=7#honeycombs"'));
  const xss = section(await page('?hc_tab=users&hc_q=' + encodeURIComponent('"><script>x</script>')));
  assert.ok(!xss.includes('<script>x</script>') && xss.includes('&quot;&gt;&lt;script&gt;x&lt;/script&gt;'));
  await buyItem(5, 'test_passes_x1');
  const d = section(await page('?hc_tab=users&hc_user=5'));
  assert.ok(d.includes('id="hcUserDetails"'));
  assert.ok(d.includes('Mia &lt;img src=x onerror=alert(1)&gt;') && !d.includes('<img src=x'));
  assert.ok(d.includes('id="hcUserUnlocks"') && d.includes('id="hcUserPurchases"') && d.includes('id="hcUserLedger"') && d.includes('id="hcUserAudit"'));
  assert.ok(d.includes('id="hcGiveUnlock"') && d.includes('name="form_ref"'));
  // Erstattete Käufe zeigen den Betrag, offene ein Formular mit Bestätigung
  assert.match(d, /Refunded \+\d+/);
  assert.match(d, /data-confirm="Refund “[^”]+” to Mia &lt;img src=x onerror=alert\(1\)&gt;\?"/);
  assert.match(d, /max 40 – the unused part/);
  assert.ok(d.includes('<input type="hidden" name="_confirmed" value="0" autocomplete="off"><input type="hidden" name="hc_action" value="refund">'));
  assert.match(d, /data-confirm="Remove Code page from Mia &lt;img src=x onerror=alert\(1\)&gt;\?"/);
  assert.ok(section(await page('?hc_tab=users&hc_user=424242')).includes('This user no longer exists.'));
  // ungültige IDs zeigen keine Details
  assert.ok(!section(await page('?hc_tab=users&hc_user=abc')).includes('id="hcUserDetails"'));
});

test('purchases tab: filters by option, user, date and status, refund forms only for open purchases, links to the details, all escaped', async () => {
  const all = section(await page('?hc_tab=purchases'));
  assert.match(all, /aria-current="page"><i class='bx bx-receipt'><\/i> Purchases<\/a>/);
  assert.ok(all.includes('id="hcPurchases"') && all.includes('id="hcPurchaseRows"'));
  assert.ok(all.includes('Mia &lt;img src=x onerror=alert(1)&gt;') && !all.includes('<img src=x'));
  assert.ok(all.includes('href="/admin?hc_tab=users&amp;hc_user=5#honeycombs"'));
  const purchases = await num('SELECT COUNT(*) FROM `DB`.hc_purchases');
  assert.equal(all.split('data-purchase="').length - 1, purchases);
  const refunded = section(await page('?hc_tab=purchases&hc_status=refunded'));
  const refundedCount = await num('SELECT COUNT(*) FROM `DB`.hc_purchases WHERE refunded_at IS NOT NULL');
  assert.equal(refunded.split('data-purchase="').length - 1, refundedCount);
  assert.ok(!refunded.includes('name="hc_action" value="refund"'));
  const open = section(await page('?hc_tab=purchases&hc_status=open'));
  assert.equal(open.split('name="hc_action" value="refund"').length - 1, purchases - refundedCount);
  const tom = section(await page('?hc_tab=purchases&hc_q=tom'));
  assert.equal(tom.split('data-purchase="').length - 1, await num('SELECT COUNT(*) FROM `DB`.hc_purchases WHERE user_id = 7'));
  const passes = section(await page('?hc_tab=purchases&hc_item=test_passes_x1'));
  assert.equal(passes.split('data-purchase="').length - 1, await num("SELECT COUNT(*) FROM `DB`.hc_purchases WHERE item_key = 'test_passes_x1'"));
  assert.ok(section(await page('?hc_tab=purchases&hc_from=2000-01-01&hc_to=2000-01-02')).includes('No purchases found.'));
  // ungültige Filter zählen nicht; Suchtext maskiert, % und _ sind keine Platzhalter
  assert.equal(section(await page('?hc_tab=purchases&hc_from=x&hc_item=%27')).split('data-purchase="').length - 1, purchases);
  const xss = section(await page('?hc_tab=purchases&hc_q=' + encodeURIComponent('"><b>x</b>%_')));
  assert.ok(!xss.includes('<b>x</b>') && xss.includes('No purchases found.'));
});

test('give honeycombs writes one audit line (amount only) that the details list under team actions; a second send writes none', async () => {
  const lines = async (): Promise<Array<Record<string, unknown>>> =>
    (await sql("SELECT admin_id, target, details FROM `DB`.hc_audit WHERE action = 'grant' AND user_id = 8 ORDER BY id")).map((r) => ({ ...r }));
  const before = await lines();
  const form = { hc_action: 'grant', user_id: '8', amount: '12', note: 'Private note', grant_ref: randomHex(8) };
  assert.ok(String(flash(await post(form)).ok).startsWith('+12 honeycombs for Lea.'));
  assert.equal(flash(await post(form)).error, 'This was already booked – the form was sent twice.');
  assert.ok(String(flash(await post({ ...form, amount: '-2', grant_ref: randomHex(8), _confirmed: '1' })).ok).startsWith('−2 honeycombs for Lea.'));
  assert.deepEqual((await lines()).slice(before.length), [{ admin_id: 3, target: '', details: '{"amount":12}' }, { admin_id: 3, target: '', details: '{"amount":-2}' }]);
  const audit = section(await page('?hc_tab=users&hc_user=8'));
  assert.match(audit.slice(audit.indexOf('id="hcUserAudit"')), /<li>[^<]* · Pixel Admin · grant · <\/li>/);
});

test('grants and removals for an account that doesn’t exist book nothing and leave no empty honeycomb account behind', async () => {
  const accounts = await num('SELECT COUNT(*) FROM `DB`.hc_accounts');
  const grant = await post({ hc_action: 'feature_grant', user_id: '4242', feature: 'code_page', mode: 'permanent', form_ref: randomHex(8) });
  assert.equal(flash(grant).error, 'Please choose a user.');
  const units = await post({ hc_action: 'feature_grant', user_id: '4243', feature: 'test_passes', mode: 'units', units: '1', form_ref: randomHex(8) });
  assert.equal(flash(units).error, 'Please choose a user.');
  const revoke = await post({ hc_action: 'feature_revoke', user_id: '4244', feature: 'code_page', lot: '', form_ref: randomHex(8), _confirmed: '1' });
  assert.equal(flash(revoke).error, 'Please choose a user.');
  assert.deepEqual(await grantFeature(3, 4245, 'code_page', { permanent: true }, ''), { error: 'Please choose a user.' });
  assert.equal(await num('SELECT COUNT(*) FROM `DB`.hc_accounts WHERE user_id BETWEEN 4242 AND 4245'), 0);
  assert.equal(await num('SELECT COUNT(*) FROM `DB`.hc_accounts'), accounts);
  assert.equal(await num('SELECT COUNT(*) FROM `DB`.honeycomb_ledger WHERE user_id BETWEEN 4242 AND 4245'), 0);
});

test('grants at the same time: one form_ref books once, the bell rings once', async () => {
  const bellsBefore = await bells(7, 'unlock');
  const quantityBefore = Number((await ent(7, 'test_passes'))?.quantity ?? 0);
  const ref = randomHex(8);
  const results = await Promise.all([1, 2, 3].map(() => grantFeature(3, 7, 'test_passes', { units: 1, formRef: ref }, '')));
  assert.equal(results.filter((r) => 'ok' in r).length, 1, JSON.stringify(results));
  for (const r of results.filter((x) => 'error' in x)) {
    assert.ok(['This was already booked – the form was sent twice.', 'Honeycombs are busy right now – please try again in a moment.'].includes((r as { error: string }).error), JSON.stringify(r));
  }
  assert.equal(Number((await ent(7, 'test_passes'))?.quantity), quantityBefore + 1);
  assert.equal(await bells(7, 'unlock'), bellsBefore + 1);
  assert.equal(await num("SELECT COUNT(*) FROM `DB`.honeycomb_ledger WHERE user_id = 7 AND reason = 'grant' AND ref = ?", ['g3-' + ref]), 1);
});

test('give honeycombs: deductions and large gifts only after the dialog (_confirmed=1), normal gifts as before', async () => {
  const form = (amount: string, extra: PhpArray = {}): PhpArray => ({ hc_action: 'grant', user_id: '7', amount, note: '', grant_ref: randomHex(8), ...extra });
  // Normale Gabe ohne Feld (altes Formular) und mit _confirmed=1 (ui.js ohne Dialog): gebucht wie bisher
  assert.ok(String(flash(await post(form('50'))).ok).startsWith('+50 honeycombs for Tom.'));
  assert.ok(String(flash(await post(form(String(GRANT_ASK_ABOVE), { _confirmed: '1' }))).ok).startsWith('+' + GRANT_ASK_ABOVE + ' honeycombs for Tom.'));
  const before = await balance(7);
  const audits = await num("SELECT COUNT(*) FROM `DB`.hc_audit WHERE action = 'grant' AND user_id = 7");
  // Abziehen und große Gaben ohne bestätigten Dialog (selbst gebautes Formular, ui.js fehlt): nichts gebucht
  for (const f of [form('-20'), form(String(GRANT_ASK_ABOVE + 1)), form('-20', { _confirmed: '0' }), form('100000', { _confirmed: '0' }), form('-1', { _confirmed: ['1'] })]) {
    assert.equal(flash(await post(f)).error, UNCONFIRMED_MESSAGE, JSON.stringify(f));
  }
  assert.equal(await balance(7), before);
  assert.equal(await num("SELECT COUNT(*) FROM `DB`.hc_audit WHERE action = 'grant' AND user_id = 7"), audits);
  // Bestätigt: gebucht
  assert.ok(String(flash(await post(form('-20', { _confirmed: '1' }))).ok).startsWith('−20 honeycombs for Tom.'));
  assert.ok(String(flash(await post(form(String(GRANT_ASK_ABOVE + 1), { _confirmed: '1' }))).ok).startsWith('+' + (GRANT_ASK_ABOVE + 1) + ' honeycombs for Tom.'));
  assert.equal(await balance(7), before + GRANT_ASK_ABOVE - 19);
  // Das Formular fragt über den eigenen Dialog: confirmField, Rückfrage-Attribute, Grenze und Namen für beforeSubmit
  const list = section(await page('?hc_tab=users'));
  const start = list.lastIndexOf('<form', list.indexOf('id="hcGrantForm"'));
  const grantForm = list.slice(start, list.indexOf('</form>', start));
  assert.ok(grantForm.includes('<input type="hidden" name="_confirmed" value="0" autocomplete="off">'), grantForm.slice(0, 400));
  assert.match(grantForm, / data-confirm="[^"]+"/);
  assert.ok(grantForm.includes('data-hc-ask-above="' + GRANT_ASK_ABOVE + '"'));
  assert.ok(grantForm.includes('<option value="5" data-name="Mia &lt;img src=x onerror=alert(1)&gt;">'));
  assert.ok(list.includes("OYSUI.beforeSubmit(grant, (form) => {"));
});

test('notes that reach the user say so: refund and give unlock', async () => {
  await give(5, 50);
  await buyItem(5, 'test_passes_x1');
  const d = section(await page('?hc_tab=users&hc_user=5'));
  const seen = 'Note <span class="text-gray-500 font-normal">(the user sees it)</span></label>';
  const refundForm = d.slice(d.indexOf('name="hc_action" value="refund"'));
  assert.ok(refundForm.slice(0, refundForm.indexOf('</form>')).includes(seen), 'refund note');
  assert.ok(d.includes('for="hcGiveNote">' + seen), 'give unlock note');
  assert.ok(!d.includes('>Note</label>'));
});
