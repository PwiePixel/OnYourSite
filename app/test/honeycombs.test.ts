// Honigwaben gegen PHP: Einstellungen, Kontostand, Buchungen, Verdienen, Bezahlen, Editor-Daten und der Admin-Teil.
// Dieselben Aufrufe laufen mit lib/honeycombs.php (PHP-Version, siehe support/phpRef.ts) auf Datenbank A und mit der
// Node-Version auf Datenbank B; nach jedem Abschnitt müssen Ergebnisse und Tabellen gleich sein. Seit der Trennung im
// Admin stehen die Aktionen und die Liste der Code-Seiten im Bereich „Code pages“ (code/admin.ts, code/adminView.ts) –
// verglichen wird mit denselben Teilen von PHP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { closePool, q } from '../src/db.js';
import { date, time } from '../src/php.js';
import { HC_BUSY, hcDefaults, hcDescribe, hcLocked, hcSettingsFrom, hcSpend } from '../src/honeycombs/honeycombs.js';
import { phpInt, phpJsonDecode } from '../src/honeycombs/util.js';
import { adminHoneycombsView } from '../src/honeycombs/adminView.js';
import { adminCodePagesView, kb } from '../src/code/adminView.js';
import { Ctx } from '../src/web/ctx.js';
import { phpBoot, adminConnection, dump, freshDb, nodeRun, normalize, phpRun, restoreDb, testDbName, useDb, type Op } from './hcHarness.js';
import { withoutDialogs, withoutNativeConfirms } from './support/dialogParity.js';
import { PHP_SKIP, phpFile, phpRoot } from './support/phpRef.js';

const DB = { php: testDbName('hcu_hc_php'), node: testDbName('hcu_hc_node') };
let admin: Connection;

function fixture(): Array<[string, unknown[]]> {
  const user = 'INSERT INTO users (id, email, password, full_name, username, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)';
  const page = 'INSERT INTO pages (id, user_id, slug, position, title, subtitle, bio, avatar, views, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
  const block = 'INSERT INTO page_blocks (page_id, type, position, is_visible, data) VALUES (?, ?, ?, ?, ?)';
  const ledger = 'INSERT INTO honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (?, ?, ?, ?, ?, ?)';
  const site = 'INSERT INTO code_sites (id, user_id, slug, title, is_published, is_blocked, blocked_reason, views, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
  const file = 'INSERT INTO code_files (site_id, path, content, updated_at) VALUES (?, ?, ?, ?)';
  const t = '2026-10-01 10:00:00';
  return [
    [user, [3, 'admin@test.de', 'h', 'Pixel Admin', 'pixel', 1, t]],
    [user, [5, 'mia@test.de', 'h', 'Mia Müller', 'mia', 0, t]],
    [user, [6, 'tom@test.de', 'h', null, 'tom', 0, t]],
    [user, [7, 'lea@test.de', 'h', '', 'lea', 0, t]],
    [user, [8, 'noname@test.de', 'h', 'Ohne Domain', null, 0, t]],
    [user, [9, 'nopage@test.de', 'h', 'No Page', null, 0, t]],
    [user, [10, 'Quote@Test.de', 'h', "O'Brien <b>& “Co”", 'Quote', 0, t]],
    [page, [1, 3, 'pixel', 0, 'Pixel', '', 'Hallo', 'avatar_3_1700000000_abcdef12.png', 42, t, t]],
    [page, [2, 5, 'mia', 0, 'Mia', 'Designerin', 'Design', 'a.png', 200, t, t]],
    [page, [3, 5, 'mia2', 1, 'Mia 2', '', '', null, 50, t, t]],
    [page, [4, 6, 'tom', 0, 'Tom', 'Fotograf', null, 't.png', 5, t, t]],
    [page, [5, 7, 'lea', 0, 'Lea', '', 'Bio', null, 0, t, t]],
    [page, [6, 8, 'noname', 0, 'No', '', 'x', '', 99, t, t]],
    ...[1, 2, 3].map((i): [string, unknown[]] => [block, [2, 'link', i, 1, '{}']]),
    ...[1, 2, 3].map((i): [string, unknown[]] => [block, [1, 'link', i, 1, '{}']]),
    [block, [4, 'link', 1, 1, '{}']], [block, [4, 'link', 2, 0, '{}']], [block, [4, 'link', 3, 1, '{}']], [block, [4, 'text', 4, 1, '{}']],
    ...[1, 2, 3].map((i): [string, unknown[]] => [block, [6, 'link', i, 1, '{}']]),
    [ledger, [5, 50, 'admin', 'a3-1111111111111111', 'Welcome', '2026-10-02 09:00:00']],
    [ledger, [6, 30, 'admin', 'a3-2222222222222222', '', '2026-10-02 09:01:00']],
    [ledger, [3, 500, 'admin', 'a3-3333333333333333', 'Start', '2026-10-02 09:02:00']],
    [ledger, [7, 4, 'bonus', 'b1', '', '2026-10-02 09:03:00']],
    [site, [1, 5, 'miacode', 'Mia Code', 1, 0, null, 12, t, '2026-10-05 10:00:00']],
    [site, [2, 6, 'tomcode', 'Tom', 0, 1, 'Spam <b>', 3, t, '2026-10-04 10:00:00']],
    [site, [3, 3, 'pixelcode', 'Pixel', 1, 0, '', 1234567, t, null]],
    [file, [1, 'index.html', '<p>Mia</p><img src="/static/uploads/avatar_5_1700000000_abcdef12.png">', t]],
    [file, [1, 'style.css', 'a{background:url(static/uploads/old%20file.jpg)} b{x:url(bg_5_17000000001_0123abcd.webp)} c{x:url(x_6_1700000000_abcdef12.png)}', t]],
    [file, [2, 'index.html', 'x'.repeat(1536), t]],
    [file, [2, 'big.txt', 'y'.repeat(1101005), t]],
  ];
}

before(async () => {
  admin = await adminConnection();
  await freshDb(admin, DB.php, fixture());
  await freshDb(admin, DB.node, fixture());
  await restoreDb();
});
after(async () => {
  for (const name of Object.values(DB)) await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await admin.end();
  await closePool();
});

// Feste Formular-Schlüssel der Tests werden genau verglichen – nur zufällige werden vereinheitlicht
const KNOWN_REFS = ['a3-1111111111111111', 'a3-2222222222222222', 'a3-3333333333333333', 'a3-0123456789abcdef',
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => 'a3-aaaaaaaaaaaaaaa' + i), 'a7-aaaaaaaaaaaaaaa9', ...[1, 2, 3].map((i) => 'a3-bbbbbbbbbbbbbbb' + i)];

// Beide Seiten laufen lassen; Ergebnisse und Tabellen vergleichen
async function same(ops: Op[], label: string): Promise<unknown[]> {
  const php = await phpRun(DB.php, ops);
  const node = await nodeRun(DB.node, ops);
  if (process.env.HC_DEBUG) ops.forEach((op, i) => console.log(label, i, JSON.stringify(op).slice(0, 90), '→', JSON.stringify(normalize(php[i])).slice(0, 160)));
  const diffs = ops.map((op, i) => ({ i, op: JSON.stringify(op).slice(0, 160), php: normalize(php[i], KNOWN_REFS), node: normalize(node[i], KNOWN_REFS) }))
    .filter((d) => JSON.stringify(d.php) !== JSON.stringify(d.node));
  assert.deepEqual(diffs, [], `${label}: results differ`);
  assert.deepEqual(await dump(admin, DB.node, KNOWN_REFS), await dump(admin, DB.php, KNOWN_REFS), `${label}: tables differ`);
  return php;
}

const deep = (n: number, inner: string) => '['.repeat(n) + inner + ']'.repeat(n);

test('settings without stored values are the defaults; broken JSON reads as null', () => {
  assert.deepEqual(hcSettingsFrom(''), hcDefaults());
  assert.equal(phpJsonDecode('{"a":"\\ud800"}'), null);
});

test('settings: defaults and merging of stored values', { skip: PHP_SKIP }, async () => {
  const metas = ['', 'null', '[]', '[1,2,3]', '5', '"str"', '{}', '{"daily":7}', ' {"daily":4} ',
    '{"daily":"7","profile":" 30","views":"1e1","views_step":"0","code_page":"12.9"}',
    '{"daily":-5,"profile":100001,"views":1e400,"views_step":-1,"code_page":9223372036854775807}',
    '{"daily":9223372036854775808,"profile":1e19,"views":-1e19,"views_step":1.5e300,"code_page":"1e400"}',
    '{"daily":-9223372036854775808,"profile":-9223372036854775809,"views":9.9e18,"views_step":"9999999999999999999","code_page":"-1e400"}',
    '{"daily":true,"profile":null,"views":[5],"views_step":{"a":1},"code_page":"0x1A"}',
    '{"daily":"12 ","profile":"\\t7","views":".5","views_step":"5.","code_page":"+7"}',
    '{"daily":"\\ud800","profile":1}', '{"daily":"\\udc00\\ud800"}', '{"daily":"\\ud83d\\ude00","profile":2}', '{"\\ud800":1,"daily":3}',
    '{"daily":"5","daily":"9"}', '{"daily":1,}', '{daily:1}', '{"daily":1e2,"views":1E1,"views_step":-0,"code_page":-0.0}',
    '{"daily":"1e3","views_step":"100000.9","code_page":"1 000"}', '{"daily":"-0","views_step":"-1","profile":"","views":" "}',
    '{"daily":3,"x":' + deep(509, '1') + '}', '{"daily":3,"x":' + deep(510, '1') + '}', '{"daily":3,"x":' + deep(511, '') + '}',
    '{"daily":2,"x":"[[[[{{{{"}', '﻿{"daily":1}', '{"daily":"٣"}', '{"daily":"１２"}', '{"0":5,"daily":6}', '[{"daily":1}]'];
  const ops: Op[] = [['settings'], ...metas.map((m): Op => ['meta', m]), ['meta_delete'],
    ['save_settings', {}], ['save_settings', { daily: '10', profile: '-5', views: '200000', views_step: '0', code_page: '1e3' }],
    ['save_settings', { daily: 'abc', profile: '', views: ' 12', views_step: '1e400', code_page: '0x1A' }],
    ['save_settings', { daily: ['1'], profile: { a: 'b' }, views: '12.9', views_step: '-1e400', code_page: '99999999999999999999' }],
    ['save_settings', { daily: '\t7 ', profile: '+3', views: '-0', views_step: '.9', code_page: '100000', extra: '1' }],
    ['meta_delete']];
  await same(ops, 'settings');
});

test('balance, add (unique key), history and describe', { skip: PHP_SKIP }, async () => {
  const rows = [
    { reason: 'daily', ref: '2026-10-01', note: '', amount: 5 }, { reason: 'profile', ref: 'complete', note: '', amount: 20 },
    { reason: 'views', note: '1000', amount: 10 }, { reason: 'views', note: 'abc', amount: 10 }, { reason: 'views', note: '1234567', amount: 10 },
    { reason: 'views', note: '', amount: 10 }, { reason: 'views', note: '12.7', amount: 1 }, { reason: 'unlock', ref: 'code_page', note: '', amount: -100 },
    { reason: 'unlock', ref: 'theme', note: '', amount: 0 }, { reason: 'unlock', ref: 'CODE_PAGE', note: 'x', amount: 0 },
    { reason: 'admin', note: 'Hi', amount: 5 }, { reason: 'admin', note: '', amount: 5 }, { reason: 'admin', note: '', amount: 0 },
    { reason: 'admin', note: '', amount: -3 }, { reason: 'admin', note: '', amount: '-3' }, { reason: 'bonus', note: '' }, { reason: 'bonus', note: 'x' },
    { reason: 'élan', note: '' }, { reason: '', note: '' }, { reason: '0', note: '' }, { reason: 'Daily', note: '' }, { reason: 'unlock', ref: 'code_page ', note: '' }];
  const ops: Op[] = [
    ['balance', 5], ['balance', 9], ['balance', 999], ['balance', 0],
    ['has', 5, 'admin', 'a3-1111111111111111'], ['has', 5, 'admin', 'A3-1111111111111111'], ['has', 5, 'admin', 'a3-1111111111111111 '], ['has', 5, 'admin', 'nope'],
    ['add', 5, 10, 'bonus', 'r1', 'note'], ['add', 5, 10, 'bonus', 'r1', 'again'], ['add', 5, 10, 'BONUS', 'R1'], ['add', 5, 10, 'bonus', 'r1 '],
    ['add', 6, -5, 'fine', 'x'.repeat(100), 'n'.repeat(300)], ['add', 6, 1, 'emoji', '🐝'.repeat(90), '🍯'.repeat(250)], ['add', 7, 0, 'zero', '', ''],
    ['add', 7, 3, 'tab', 'a\tb', 'line\nbreak'],
    ['balance', 5], ['balance', 6], ['balance', 7],
    ['history', 5], ['history', 6, 1], ['history', 7, 0], ['history', 7, -5], ['history', 999], ['history', 5, 2],
    ...rows.map((r): Op => ['describe', r]),
    ['profile_complete', 3], ['profile_complete', 5], ['profile_complete', 6], ['profile_complete', 7], ['profile_complete', 8], ['profile_complete', 9]];
  await same(ops, 'ledger');
  // describe() ohne Datenbank: dieselben Texte wie die echte Funktion
  const php = JSON.parse(execFileSync('php', ['-r', `${phpBoot()} echo json_encode(array_map('oys_hc_describe', json_decode(stream_get_contents(STDIN), true)), JSON_UNESCAPED_UNICODE);`],
    { input: JSON.stringify(rows), env: { ...process.env, OYS_TEST_DB: DB.php }, cwd: phpRoot() }).toString());
  assert.deepEqual(rows.map((r) => hcDescribe(r)), php);
});

test('earn: daily, profile and views (one level a day, at most 20)', { skip: PHP_SKIP }, async () => {
  const ops: Op[] = [
    ['earn', 5], ['earn', 5], ['for_editor', 5], ['for_editor', 5, [{ amount: 5, text: 'for being active today' }]],
    ['earn', 6], ['earn', 3], ['earn', 9],
    ['sql', 'UPDATE pages SET views = 5000 WHERE id = 4'], ['sql', "INSERT INTO page_blocks (page_id, type, position, is_visible) VALUES (4, 'link', 9, 1)"],
    ['earn', 6], ['earn', 6], ['for_editor', 6],
    ['meta', '{"daily":0,"profile":0,"views":0}'], ['earn', 7], ['for_editor', 7],
    ['meta', '{"views_step":1,"daily":2}'],
    ...Array.from({ length: 20 }, (_v, i): Op => ['add', 8, 1, 'views', 'd' + i, String(i + 1)]),
    ['earn', 8], ['for_editor', 8],
    ['meta', '{"views_step":100000,"profile":100000}'], ['earn', 10], ['for_editor', 10],
    ['meta_delete'], ['for_editor', 9], ['for_editor', 999], ['history', 5, 15]];
  const php = await same(ops, 'earn');
  // Plausibel: erster Besuch bringt Tag, Profil und Aufrufe
  assert.deepEqual(php[0], [{ amount: 5, text: 'for being active today' }, { amount: 20, text: 'for completing your profile' }, { amount: 10, text: 'for 100 page views' }]);
  assert.deepEqual(php[1], []);
});

test('spend: price, once per ref, not below 0', { skip: PHP_SKIP }, async () => {
  const ops: Op[] = [
    ['spend', 9, 100, 'code_page'], ['spend', 5, 50, 'theme'], ['spend', 5, 50, 'theme'], ['spend', 5, 0, 'free'], ['spend', 5, 100000, 'big'],
    ['spend', 999, 0, 'code_page'], ['spend', 7, -5, 'neg'], ['spend', 5, 1, 'THEME'], ['spend', 6, 1000, 'code_page'],
    ['balance', 5], ['balance', 7], ['history', 5, 4], ['has', 999, 'unlock', 'code_page']];
  const php = await same(ops, 'spend');
  assert.match(String(php[0]), /^You need 100 honeycombs – you have \d+\.$/);
});

test('admin handler: every action incl. invalid input', { skip: PHP_SKIP }, async () => {
  const g = (o: Record<string, unknown>) => ({ hc_action: 'grant', ...o });
  const ops: Op[] = [
    ['admin', {}, 3], ['admin', { hc_action: 'nope' }, 3], ['admin', { hc_action: ['settings'] }, 3], ['admin', { hc_action: 'Settings' }, 3], ['admin', { hc_action: '' }, 3],
    ['admin', { hc_action: 'settings', daily: '3', profile: '15', views: '8', views_step: '50', code_page: '250' }, 3], ['settings'],
    ['admin', { hc_action: 'settings' }, 3], ['settings'],
    ['admin', { hc_action: 'settings', daily: '1e400', views_step: '0', code_page: '-1', profile: '1e5', views: '100001' }, 3], ['settings'],
    ['admin', { hc_action: 'settings', daily: ['5'], profile: '', views: 'abc', views_step: ' 7 ', code_page: '0x10' }, 3], ['settings'],
    ['admin', g({ user_id: '0', amount: '5' }), 3], ['admin', g({ user_id: 'abc', amount: '5' }), 3], ['admin', g({ user_id: '999', amount: '5' }), 3],
    ['admin', g({ amount: '5' }), 3], ['admin', g({ user_id: '1e400', amount: '5' }), 3],
    ['admin', g({ user_id: '5', amount: '0' }), 3], ['admin', g({ user_id: '5', amount: '100001' }), 3], ['admin', g({ user_id: '5', amount: '-100001' }), 3],
    ['admin', g({ user_id: '5', amount: 'abc' }), 3], ['admin', g({ user_id: '5', amount: '1e400' }), 3], ['admin', g({ user_id: '5' }), 3],
    ['admin', g({ user_id: '5', amount: '99999999999999999999' }), 3],
    ['admin', g({ user_id: '5', amount: '25', note: '  Thanks!\t ', grant_ref: '0123456789abcdef' }), 3],
    ['admin', g({ user_id: '5', amount: '25', note: 'again', grant_ref: '0123456789abcdef' }), 3],
    ['admin', g({ user_id: '5', amount: '25', grant_ref: '0123456789ABCDEF' }), 3],
    ['admin', g({ user_id: '5', amount: '7', grant_ref: '0123456789abcdee\n' }), 3],
    ['admin', g({ user_id: '5', amount: '7', grant_ref: '0123456789abcdee\n' }), 3],
    ['admin', g({ user_id: '5', amount: '7', grant_ref: ['0123456789abcdef'] }), 3],
    ['admin', g({ user_id: '5', amount: '7', grant_ref: '0123456789abcde' }), 3],
    ['admin', g({ user_id: '6', amount: '-1000', grant_ref: 'aaaaaaaaaaaaaaa1' }), 3],
    ['admin', g({ user_id: '6', amount: '-5', grant_ref: 'aaaaaaaaaaaaaaa2' }), 3],
    ['admin', g({ user_id: '7', amount: ' 12.9abc', note: 'x'.repeat(200), grant_ref: 'aaaaaaaaaaaaaaa3' }), 3],
    ['admin', g({ user_id: '10', amount: '100000', note: '<b>"bidi‮"</b>\u0000', grant_ref: 'aaaaaaaaaaaaaaa4' }), 3],
    ['admin', g({ user_id: '5', amount: '-100000', grant_ref: 'aaaaaaaaaaaaaaa5' }), 3],
    ['admin', g({ user_id: ['5'], amount: '3', grant_ref: 'aaaaaaaaaaaaaaa6' }), 3],
    ['admin', g({ user_id: '5', amount: ['3'], grant_ref: 'aaaaaaaaaaaaaaa7' }), 3],
    ['admin', g({ user_id: '5', amount: '2', note: ['x'], grant_ref: 'aaaaaaaaaaaaaaa8' }), 3],
    ['admin', g({ user_id: '5', amount: '1', grant_ref: 'aaaaaaaaaaaaaaa9' }), 7],
    ['admin', g({ user_id: ' 9', amount: '+15', note: 'Für dich 🐝', grant_ref: 'bbbbbbbbbbbbbbb1' }), 3],
    ['admin', g({ user_id: '9', amount: '-15', grant_ref: 'bbbbbbbbbbbbbbb2' }), 3],
    ['admin', g({ user_id: '9', amount: '-1', grant_ref: 'bbbbbbbbbbbbbbb3' }), 3],
    ['admin', { hc_action: 'code_block', site_id: '999' }, 3], ['admin', { hc_action: 'code_block' }, 3],
    ['admin', { hc_action: 'code_block', site_id: '1', reason: '  Selling\tstuff  ' + 'y'.repeat(250) }, 3],
    ['admin', { hc_action: 'code_block', site_id: '1', reason: '' }, 3],
    ['admin', { hc_action: 'code_block', site_id: '1', reason: ['x'] }, 3],
    ['admin', { hc_action: 'code_block', site_id: '1', reason: '0' }, 3],
    ['admin', { hc_action: 'code_unblock', site_id: '2', reason: 'ignored' }, 3],
    ['admin', { hc_action: 'code_block', site_id: ' 3x', reason: '“Bad” <i>' }, 3],
    ['admin', { hc_action: 'code_unblock', site_id: '999' }, 3],
    ['admin', { hc_action: 'code_unlock', user_id: '0' }, 3], ['admin', { hc_action: 'code_unlock' }, 3],
    ['admin', { hc_action: 'code_unlock', user_id: '9' }, 3], ['admin', { hc_action: 'code_unlock', user_id: '9' }, 3],
    ['admin', { hc_action: 'code_unlock', user_id: '6' }, 3], ['admin', { hc_action: 'code_unlock', user_id: '7' }, 3],
    ['admin', { hc_action: 'code_unlock', user_id: '10' }, 3], ['admin', { hc_action: 'code_unlock', user_id: ['10'] }, 3],
    // Dieselben Aktionen als code_action (Bereich Code-Seiten): Ergebnis und Tabellen wie die alten PHP-Aktionen
    ['code_admin', {}, 3], ['code_admin', { code_action: 'nope' }, 3], ['code_admin', { code_action: ['block'] }, 3], ['code_admin', { code_action: 'Block', site_id: '1' }, 3],
    ['code_admin', { code_action: 'block', site_id: '999' }, 3], ['code_admin', { code_action: 'block' }, 3],
    ['code_admin', { code_action: 'block', site_id: '2', reason: '  Phishing\t<b>x</b>  ' + 'z'.repeat(250) }, 3],
    ['code_admin', { code_action: 'block', site_id: '3', reason: '' }, 3],
    ['code_admin', { code_action: 'unblock', site_id: '2', reason: 'ignored' }, 3], ['code_admin', { code_action: 'unblock', site_id: ' 1x' }, 3],
    ['code_admin', { code_action: 'unblock', site_id: '999' }, 3],
    ['code_admin', { code_action: 'unlock', user_id: '0', item: 'code_page' }, 3], ['code_admin', { code_action: 'unlock' }, 3],
    ['code_admin', { code_action: 'unlock', user_id: '8', item: 'code_page' }, 3], ['code_admin', { code_action: 'unlock', user_id: '8', item: 'code_page' }, 3],
    ['code_admin', { code_action: 'unlock', user_id: '5' }, 3], ['code_admin', { code_action: 'unlock', user_id: ['8'] }, 3],
    ['balance', 5], ['balance', 6], ['balance', 9], ['history', 5, 30], ['history', 8, 5]];
  const php = await same(ops, 'admin');
  assert.deepEqual(php[0], null);
  assert.deepEqual(php[5], { ok: 'Honeycomb settings saved.' });
  // Nur Node: jede Gutschrift des Teams nennt den Admin (actor_id = die ID aus dem Bezug a<id>-…)
  const [grants] = await admin.query<RowDataPacket[]>(`SELECT ref, actor_id FROM \`${DB.node}\`.honeycomb_ledger WHERE reason = 'admin' AND id > 4 ORDER BY id`);
  assert.ok(grants.length >= 5);
  for (const g of grants) assert.equal(g.actor_id, Number(/^a(\d+)-/.exec(String(g.ref))?.[1]), String(g.ref));
});

test('locked: busy message while the account is locked, and parallel spends never overdraw (Node only)', async () => {
  // PHP wartete auf GET_LOCK('oys_hc_<id>', 10). Node sperrt seit dem Shop-Kern die Zeile des Kontos in hc_accounts
  // (höchstens 5 Sekunden) – eine zweite Sperrart gibt es nicht mehr, deshalb ohne Vergleich mit PHP.
  await useDb(DB.node);
  const holder = await adminConnection();
  try {
    await holder.query(`USE \`${DB.node}\``);
    await holder.query('INSERT IGNORE INTO hc_accounts (user_id, created_at, updated_at) VALUES (99999, NOW(), NOW())');
    await holder.query('START TRANSACTION');
    await holder.query('SELECT * FROM hc_accounts WHERE user_id = 99999 FOR UPDATE');
    assert.equal(await hcSpend(99999, 0, 'busy_test'), HC_BUSY);
    assert.equal(await hcLocked(99999, async () => 'ran'), HC_BUSY);
    await holder.query('ROLLBACK');
  } finally {
    await holder.end();
  }
  // Zwei gleichzeitige Käufe mit Geld für nur einen: genau einer klappt
  await admin.query(`INSERT INTO \`${DB.node}\`.honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (99998, 100, 'admin', 'p', '', NOW())`);
  const results = await Promise.all([hcSpend(99998, 60, 'xx'), hcSpend(99998, 60, 'yy'), hcSpend(99998, 60, 'zz')]);
  assert.equal(results.filter((r) => r === null).length, 1);
  assert.deepEqual(results.filter((r) => r !== null), ['You need 60 honeycombs – you have 40.', 'You need 60 honeycombs – you have 40.']);
  // Fehler in fn: zurückgerollt, die Sperre ist danach frei
  await assert.rejects(hcLocked(99998, async () => { throw new Error('boom'); }));
  assert.equal(await hcLocked(99998, async () => 'free'), 'free');
  await restoreDb();
});

test('(int) of form and JSON values matches PHP 8.3', { skip: PHP_SKIP }, () => {
  const inputs: unknown[] = ['1e400', '-1e400', '1e300', '-1e300', '99999999999999999999', '9223372036854775807', '12abc', ' 12', '\n-7', '0x1A', '.5', '5.', '-0', '',
    'abc', '+3', '1e3', '1.9e2', 9.9e18, -9.9e18, 1e19, 2 ** 63, -(2 ** 63), 1e300, 12.7, -12.7, true, false, null, ['a'], [], { a: 1 }];
  const php = JSON.parse(execFileSync('php', ['-r', 'echo json_encode(array_map(function ($v) { return (int) $v; }, json_decode(stream_get_contents(STDIN), true)));'],
    { input: JSON.stringify(inputs) }).toString()) as number[];
  // PHP liest {"a":1} als Array → 1; [] → 0
  assert.deepEqual(inputs.map((v) => phpInt(v)), php.map((n) => Number(n)));
});

test('kb() rounds like the PHP view', { skip: PHP_SKIP }, () => {
  const sizes = [0, 1, 511, 512, 1023, 1024, 1535, 1536, 2047, 2048, 1048575, 1048576, 1101004, 1101005, 1310720, 1572864, 2097152, 5242879, 10485760, 123456789];
  const php = JSON.parse(execFileSync('php', ['-r', '$kb = function (int $b) { return $b >= 1048576 ? round($b / 1048576, 1) . \' MB\' : max(1, round($b / 1024)) . \' KB\'; };'
    + 'echo json_encode(array_map($kb, json_decode(stream_get_contents(STDIN), true)));'], { input: JSON.stringify(sizes) }).toString());
  assert.deepEqual(sizes.map(kb), php);
});

// views/admin_honeycombs.php mit den Variablen aus views/admin.php
async function phpView(db: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('php', ['-r', `${phpBoot()} $_SESSION = ['csrf' => 'CSRFTOKEN'];
      $all_users = $pdo->query("SELECT id, full_name, email, username, discord_id, is_admin, created_at FROM users ORDER BY id DESC")->fetchAll(PDO::FETCH_ASSOC);
      foreach ($all_users as &$u) { $u['discord_id'] = decryptData($u['discord_id']); } unset($u);
      ob_start(); require '${phpFile('views/admin_honeycombs.php')}'; echo ob_get_clean();`],
    { env: { ...process.env, OYS_TEST_DB: db }, cwd: phpRoot(), maxBuffer: 64 * 1024 * 1024 }, (err, out, errOut) => (err ? reject(new Error(errOut || err.message)) : resolve(out)));
    child.stdin?.end();
  });
}
async function nodeView(db: string): Promise<string> {
  await useDb(db);
  try {
    const ctx = new Ctx({ method: 'GET', url: '/admin', headers: { host: 'oys.test:8080' }, peer: '127.0.0.1' });
    // Sitzung mit festem CSRF-Wert (wie $_SESSION im PHP-Aufruf)
    ctx.session = { get: (k: string) => (k === 'csrf' ? 'CSRFTOKEN' : undefined), set: () => undefined } as unknown as Ctx['session'];
    const users = await q('SELECT id, full_name, email, username, discord_id, is_admin, created_at FROM users ORDER BY id DESC');
    return await adminHoneycombsView(ctx, users);
  } finally {
    await restoreDb();
  }
}
async function nodeCodeView(db: string): Promise<string> {
  await useDb(db);
  try {
    const ctx = new Ctx({ method: 'GET', url: '/admin', headers: { host: 'oys.test:8080' }, peer: '127.0.0.1' });
    ctx.session = { get: (k: string) => (k === 'csrf' ? 'CSRFTOKEN' : undefined), set: () => undefined } as unknown as Ctx['session'];
    const users = await q('SELECT id, full_name, email, username, discord_id, is_admin, created_at FROM users ORDER BY id DESC');
    return await adminCodePagesView(ctx, users);
  } finally {
    await restoreDb();
  }
}
const viewNorm = (s: string) => s.replace(/name="grant_ref" value="[0-9a-f]{16}"/, 'name="grant_ref" value="REF"');

// Die Ausgabe von views/admin_honeycombs.php geteilt wie im Admin seit der Trennung: die Karte mit der Liste der
// Code-Seiten und die Spalte „Code page“ (Kopf und je Zeile eine Zelle) gehören zum Bereich Code-Seiten
const CARD = '                <div class="bg-card border border-bordercolor rounded-xl shadow-xl overflow-hidden">\n';
const CODE_CARD = CARD + '                    <div class="flex flex-wrap items-center justify-between gap-3 p-5 sm:p-6 border-b border-bordercolor">\n'
  + '                        <h2 class="text-base font-semibold text-white flex items-center gap-2"><i class=\'bx bx-code-alt';
function splitPhpView(php: string): { honeycombs: string; codeList: string } {
  const start = php.indexOf(CODE_CARD);
  assert.ok(start > 0, 'code pages card in the PHP view');
  const end = php.indexOf(CARD, start + CARD.length);
  const rest = php.slice(0, start) + php.slice(end);
  assert.equal(rest.split('<th class="px-4 py-3 font-medium">Code page</th>').length, 2, 'one "Code page" column');
  return {
    honeycombs: rest.replace('<th class="px-4 py-3 font-medium">Code page</th>', '').replace(/ {36}<td class="px-4 py-3">\n[\s\S]*? {36}<\/td>\n/g, ''),
    codeList: php.slice(start, end),
  };
}
// Die Liste im Bereich Code-Seiten (bis zur nächsten Karte „Access“)
function nodeCodeList(node: string): string {
  const start = node.indexOf(CODE_CARD);
  assert.ok(start > 0, 'code pages card in the Node section');
  return node.slice(start, node.indexOf(CARD, start + CARD.length));
}
// Die Formulare senden jetzt code_action statt hc_action=code_*
const asCodeAction = (s: string) => s.replace(/name="hc_action" value="code_(block|unblock)"/g, 'name="code_action" value="$1"');
// Gelbe Honigwaben-Symbole (honeycomb-shop §5.1): Kopf von „Give honeycombs“ und das Symbol bei jedem Kontostand
const yellowIcons = (s: string) => s.replace("<i class='bx bx-hive text-2xl text-brand-400'></i>", "<i class='bx bx-hive text-2xl text-yellow-400'></i>")
  .replace(/<i class='bx bx-hive text-brand-400'><\/i><\/td>/g, "<i class='bx bx-hive text-yellow-400'></i></td>");

test('admin view: Honeycombs identical apart from the moved parts and the yellow icons, the moved list unchanged (with data, after changes, and empty)', { skip: PHP_SKIP }, async () => {
  // Beide Datenbanken bekommen dieselben Aufrufe nacheinander: lag eine Minutengrenze dazwischen, zeigten die letzten
  // Buchungen verschiedene Uhrzeiten. Die Dumps werten „jetzt“ ohnehin gleich (normalize) – hier bekommt jede
  // Node-Buchung die Zeit der PHP-Buchung an derselben Stelle (Inhalt und Reihenfolge sind gleich, die IDs und die
  // zufälligen Bezüge der Gutschriften nicht).
  const [phpTimes] = await admin.query<RowDataPacket[]>(`SELECT DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS t FROM \`${DB.php}\`.honeycomb_ledger ORDER BY id`);
  const [nodeRows] = await admin.query<RowDataPacket[]>(`SELECT id FROM \`${DB.node}\`.honeycomb_ledger ORDER BY id`);
  for (const [i, r] of nodeRows.entries()) {
    if (phpTimes[i]) await admin.query(`UPDATE \`${DB.node}\`.honeycomb_ledger SET created_at = ? WHERE id = ?`, [phpTimes[i].t, r.id]);
  }
  // Die Code-Seiten stehen nach updated_at DESC (ohne zweites Sortierfeld, wie in PHP). Die Admin-Aktionen oben setzen
  // drei Seiten in derselben Sekunde auf „jetzt“ – bei Gleichstand wählt MariaDB die Reihenfolge selbst, in beiden
  // Datenbanken womöglich verschieden. Darum vorher eindeutige Zeiten (gleicher Tag, angezeigt wird nur das Datum).
  const unambiguous = 'UPDATE code_sites SET updated_at = DATE(updated_at) + INTERVAL id SECOND WHERE updated_at IS NOT NULL';
  for (const [label, prep] of [['current data', unambiguous], ['blocked with reason 0', "UPDATE code_sites SET is_blocked = 1, blocked_reason = '0' WHERE id = 3"],
    ['ledger only', 'DELETE FROM code_sites'], ['empty', 'DELETE FROM honeycomb_ledger']] as const) {
    if (prep) for (const db of Object.values(DB)) await admin.query(`USE \`${db}\``).then(() => admin.query(prep));
    const php = splitPhpView(viewNorm(await phpView(DB.php)));
    const node = viewNorm(await nodeView(DB.node));
    assert.ok(php.honeycombs.length > 1000, label);
    // Eigene Dialoge (custom-dialogs): Node ohne data-confirm/_confirmed/data-error-*, PHP ohne confirm()
    assert.equal(withoutDialogs(node), withoutNativeConfirms(yellowIcons(php.honeycombs)), label);
    assert.doesNotMatch(node, /bx-hive[^']*text-brand/, label);
    assert.doesNotMatch(node, /code_action|hc_action" value="code_|bx-code-alt|Code page/, label);
    assert.equal(withoutDialogs(nodeCodeList(await nodeCodeView(DB.node))), withoutNativeConfirms(asCodeAction(php.codeList)), label);
  }
});

test('date() of today matches (earn refs use the site time zone)', { skip: PHP_SKIP }, () => {
  const php = execFileSync('php', ['-r', `${phpBoot()} echo date('Y-m-d');`], { env: { ...process.env, OYS_TEST_DB: DB.php }, cwd: phpRoot() }).toString();
  assert.equal(date('Y-m-d', time()), php);
});
