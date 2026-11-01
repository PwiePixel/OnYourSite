// Code-Seiten gegen PHP (lib/codesites.php): Dateinamen, Startdateien, Hinweis-Seite und Plakette, Vorschau-Schlüssel,
// Anlegen, Speichern mit allen Grenzen, Löschen. Die Aufrufe mit Datenbank laufen wie in honeycombs.test.ts doppelt.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import type { Connection } from 'mysql2/promise';
import { ROOT_DIR } from '../src/config.js';
import { closePool } from '../src/db.js';
import { time } from '../src/php.js';
import { CODE_MAX_FILES, CODE_MAX_FILE_BYTES, CODE_MAX_TOTAL_BYTES, CODE_SANDBOX, CODE_TYPES, codePreviewToken, codePreviewValid, codeStarterFiles, codeValidPath,
  codeWrite, usedUploadsIn } from '../src/code/sites.js';
import { codeAddBadge, codeNotice } from '../src/code/serve.js';
import { pathExtension } from '../src/honeycombs/util.js';
import { Ctx } from '../src/web/ctx.js';
import { PHP_BOOT, adminConnection, dump, freshDb, nodeRun, normalize, phpRun, restoreDb, useDb, type Op } from './hcHarness.js';

const DB = { php: 'oys_test_hcu_code_php', node: 'oys_test_hcu_code_node' };
let admin: Connection;

// Reine Funktion mit JSON-Ein- und Ausgabe in PHP aufrufen
function php(code: string, input: unknown): unknown {
  return JSON.parse(execFileSync('php', ['-r', `${PHP_BOOT} $in = json_decode(stream_get_contents(STDIN), true); $out = (function ($in) { ${code} })($in); echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);`],
    { input: JSON.stringify(input), env: { ...process.env, OYS_TEST_DB: DB.php }, cwd: ROOT_DIR, maxBuffer: 256 * 1024 * 1024 }).toString());
}

function fixture(): Array<[string, unknown[]]> {
  const user = 'INSERT INTO users (id, email, password, full_name, username, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)';
  const page = 'INSERT INTO pages (id, user_id, slug, position, title, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)';
  const ledger = 'INSERT INTO honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (?, ?, ?, ?, ?, ?)';
  const site = 'INSERT INTO code_sites (id, user_id, slug, title, is_published, is_blocked, blocked_reason, views, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
  const file = 'INSERT INTO code_files (site_id, path, content, updated_at) VALUES (?, ?, ?, ?)';
  const t = '2026-10-01 10:00:00';
  return [
    ...[[3, 'admin@test.de', 'Pixel Admin', 'pixel', 1], [5, 'mia@test.de', 'Mia', 'mia', 0], [6, 'tom@test.de', 'Tom', 'tom', 0], [7, 'lea@test.de', 'Lea', 'lea', 0],
      [8, 'n@test.de', 'N', null, 0], [9, 'nine@test.de', 'Nine', null, 0], [10, 'ten@test.de', 'Ten', null, 0], [11, 'eleven@test.de', 'Eleven', null, 0]]
      .map(([id, email, name, slug, isAdmin]): [string, unknown[]] => [user, [id, email, 'h', name, slug, isAdmin, t]]),
    [page, [1, 3, 'pixel', 'Pixel', t, t]], [page, [2, 5, 'mia', 'Mia', t, t]],
    [ledger, [5, -100, 'unlock', 'code_page', '', t]], [ledger, [5, 500, 'admin', 'a3-1111111111111111', '', t]], [ledger, [9, 0, 'unlock', 'code_page', '', t]],
    [site, [1, 5, 'miacode', 'Mia <Code>', 1, 0, null, 12, t, '2026-10-05 10:00:00']],
    [site, [2, 6, 'tomcode', 'Tom', 0, 1, 'Spam <b>', 3, t, null]],
    [file, [1, 'index.html', '<p>Mia</p><img src="/static/uploads/avatar_5_1700000000_abcdef12.png">', t]],
    [file, [1, 'style.css', 'a{background:url(static/uploads/old%20file.jpg)} b{x:url(bg_5_17000000001_0123abcd.webp)} c{x:url(x_6_1700000000_abcdef12.png)}', t]],
    [file, [1, 'docs/a.md', '# A', t]],
    [file, [2, 'index.html', '<p>Tom</p>', t]],
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

async function same(ops: Op[], label: string): Promise<unknown[]> {
  const p = await phpRun(DB.php, ops);
  const n = await nodeRun(DB.node, ops);
  if (process.env.HC_DEBUG) ops.forEach((op, i) => console.log(label, i, JSON.stringify(op).slice(0, 90), '→', JSON.stringify(normalize(p[i])).slice(0, 160)));
  const diffs = ops.map((op, i) => ({ i, op: JSON.stringify(op).slice(0, 200), php: normalize(p[i]), node: normalize(n[i]) }))
    .filter((d) => JSON.stringify(d.php) !== JSON.stringify(d.node));
  assert.deepEqual(diffs, [], `${label}: results differ`);
  assert.deepEqual(await dump(admin, DB.node), await dump(admin, DB.php), `${label}: tables differ`);
  return p;
}

// Zufallsfolgen aus heiklen Bausteinen (fester Startwert)
function fuzz(parts: string[], count: number, maxLen: number, seed = 11): string[] {
  const out: string[] = [];
  // mulberry32: gleichmäßig auch in den unteren Bits
  const rnd = (n: number) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) % n;
  };
  for (let k = 0; k < count; k++) {
    let s = '';
    const n = rnd(maxLen + 1);
    for (let i = 0; i < n; i++) s += parts[rnd(parts.length)];
    out.push(s);
  }
  return out;
}

const PATHS = ['', '/', 'index.html', 'INDEX.HTML', ' index.html ', '/index.html/', '//a.css//', '\\a.css', 'a\\b.css', 'sub/index.html', 'a/b/c/d.html', 'a/b/c/d/e.html',
  'a//b.html', './a.html', '../a.html', 'a/../b.html', '.htaccess', '.html', 'a.', 'a..html', 'a.b.c.html', 'a.HTML', 'a.Html', 'x.php', 'x.phtml', 'x.html.php', 'x',
  'x.htm', 'x.css', 'x.js', 'x.mjs', 'x.json', 'x.txt', 'x.md', 'x.svg', 'x.xml', 'x.webmanifest', 'x.png', 'x.svgz', 'x.jsx', 'index.html\n', 'index.html\r\n', 'a\nb.html',
  "index.html\0", 'in dex.html', 'a b/c.html', 'ä.html', 'a/ä.html', 'İ.html', 'K.html', '🐝.html', 'a_b-c.html', '-.html', '_.html', '-/-.css', 'a/-b/_c.css',
  'x'.repeat(115) + '.html', 'x'.repeat(116) + '.html', 'x'.repeat(117) + '.html', ' '.repeat(10) + 'a.css', '/ /a.css', 'a/ /b.css', 'a.css/ ', 'a.css /', '\ta.css',
  'constructor.html', 'x.constructor', 'x.__proto__', 'x.toString', 'x.hasOwnProperty', 'a/b.c/d.html', 'a.b/c', 'a.html/', 'a.html//', 'A/B/C.CSS', '%2e.html', 'a%2Fb.html'];

test('valid_path: fixed hostile paths and random input match PHP', () => {
  const random = fuzz(['a', 'B', '0', '.', '/', '\\', ' ', '-', '_', '\n', '\t', 'ä', '%', '..', 'html', 'css', 'HTML', 'json', 'x', '\0', '🐝', 'İ'], 4000, 12);
  // Aufgebaute Pfade (Ordner/Name.Endung) mit gelegentlichen Störungen – damit beide Ergebnisse oft vorkommen
  const seg = fuzz(['a', 'b-c', 'x_y', 'Index', 'é', '0', 'A.B', '', ' ', '.'], 3000, 2, 3);
  const ext = fuzz(['html', 'css', 'HTML', 'php', 'webmanifest', 'md', 'js', 'Js', 'mjs', '', '.', '\n'], 3000, 1, 4);
  const sep = fuzz(['/', '/', '/', '\\', '//', ' /'], 3000, 1, 9);
  const built = seg.map((s0, i) => [s0, seg[(i * 7) % seg.length], seg[(i * 13) % seg.length]].slice(0, 1 + (i % 4)).join(sep[i] || '/') + '.' + ext[i]);
  const all = [...PATHS, ...random, ...built];
  const theirs = php('return array_map("oys_code_valid_path", $in);', all) as Array<string | null>;
  const mismatches = all.map((p, i) => [p, codeValidPath(p), theirs[i]]).filter(([, a, b]) => a !== b);
  assert.deepEqual(mismatches, []);
  assert.ok(theirs.filter((x) => x !== null).length > 200, 'enough valid paths in the sample');
});

test('pathinfo extension matches PHP', () => {
  const all = [...PATHS, ...fuzz(['a', '.', '/', '\\', ' ', 'x', 'ä', '\n', '..', '//'], 3000, 8, 5)];
  const theirs = php('return array_map(function ($p) { return pathinfo($p, PATHINFO_EXTENSION); }, $in);', all);
  assert.deepEqual(all.map(pathExtension), theirs);
});

test('constants match PHP', () => {
  const theirs = php('return [OYS_CODE_MAX_FILES, OYS_CODE_MAX_FILE_BYTES, OYS_CODE_MAX_TOTAL_BYTES, array_keys(OYS_CODE_TYPES), array_values(OYS_CODE_TYPES), OYS_CODE_SANDBOX];', null);
  assert.deepEqual([CODE_MAX_FILES, CODE_MAX_FILE_BYTES, CODE_MAX_TOTAL_BYTES, [...CODE_TYPES.keys()], [...CODE_TYPES.values()], CODE_SANDBOX], theirs);
});

test('starter files, badge and notice are byte-identical', () => {
  const titles = ['', 'My site', '<b>"Bold" & \'quoted\'</b>', 'Grüße – 🐝 “Co”', '0', 'x'.repeat(130), '&amp;', ' '];
  assert.deepEqual(titles.map(codeStarterFiles), php('return array_map("oys_code_starter_files", $in);', titles));
  const html = ['', 'no body', '</body>', '<html><body>x</body></html>', '</BODY>', '</Body>', '</body >', '</body', 'a</body>b</body>c', '</body></BODY>tail',
    'İİİ</body>', 'ẞ</BODY>ß', '🐝</body>🐝', '<!-- </body> --></body>', '</bodyx>', '</BoDy>\n', 'x'.repeat(10000) + '</body>'];
  assert.deepEqual(html.map((h) => codeAddBadge(h, {})), php('return array_map(function ($h) { return oys_code_add_badge($h, []); }, $in);', html));
  const notices: Array<[string, string]> = [['Page not found', 'This page doesn’t exist on mia.on-your.site.'], ['<script>', '"quotes" & \'apos\''], ['', ''], ['Grüße 🐝', 'ä']];
  const ctx = new Ctx({ method: 'GET', url: '/', headers: {}, peer: '127.0.0.1' });
  assert.deepEqual(notices.map(([t, x]) => codeNotice(ctx, t, x)), php('return array_map(function ($n) { return oys_code_notice($n[0], $n[1]); }, $in);', notices));
  assert.equal(ctx.header('Content-Type'), 'text/html; charset=utf-8');
});

test('preview token: fixed times match PHP; validation window', () => {
  const sites = [{ id: 1, slug: 'miacode' }, { id: 2, slug: 'tomcode' }, { id: '7', slug: 'Ab-c' }];
  const times = [1700000000, 123456789, 99999999999, 0, 1];
  const mine = sites.flatMap((s) => times.map((t) => codePreviewToken(s, t)));
  assert.deepEqual(mine, php('$o = []; foreach ($in[0] as $s) foreach ($in[1] as $t) $o[] = oys_code_preview_token($s, $t); return $o;', [sites, times]));
  // Gültigkeit (weit weg von den Grenzen, damit die Sekunde zwischen beiden Läufen nichts ändert)
  const now = time();
  const site = sites[1];
  const ok = codePreviewToken(site, now - 100);
  const tokens = [ok, codePreviewToken(site, now - 43000), codePreviewToken(site, now - 43400), codePreviewToken(site, now + 30), codePreviewToken(site, now + 300),
    codePreviewToken(sites[0], now - 100), ok + '\n', ok + 'x', ok.toUpperCase(), ' ' + ok, '', '123-abc', ok.replace(/^\d+/, (d) => String(Number(d) + 1)),
    '12345678-' + ok.split('-')[1], '123456789012-' + ok.split('-')[1], ok.slice(0, -1), codePreviewToken(site, now - 100).replace(/-/, '_')];
  assert.deepEqual(tokens.map((tk) => codePreviewValid(site, tk)), php('return array_map(function ($t) use ($in) { return oys_code_preview_valid($in[0], $t); }, $in[1]);', [site, tokens]));
  // Grenzen (nur Node, die Zeit läuft sonst zwischen den Prozessen weiter): 12 Stunden zurück, 60 Sekunden voraus
  assert.equal(codePreviewValid(site, codePreviewToken(site, now - 43190)), true);
  assert.equal(codePreviewValid(site, codePreviewToken(site, now - 43210)), false);
  assert.equal(codePreviewValid(site, codePreviewToken(site, now + 50)), true);
  assert.equal(codePreviewValid(site, codePreviewToken(site, now + 70)), false);
});

test('lookups, editor data and used uploads', async () => {
  await same([['code_site', 5], ['code_site', 9], ['code_site_by_id', 1], ['code_site_by_id', 999], ['code_site_by_slug', 'miacode'], ['code_site_by_slug', 'MIACODE'],
    ['code_site_by_slug', 'miacode '], ['code_site_by_slug', 'nope'], ['code_url', 1], ['code_url', 2], ['code_unlocked', 5], ['code_unlocked', 8], ['code_unlocked', 9],
    ['code_files', 1], ['code_files', 2], ['code_files', 999], ['code_for_editor', 1], ['code_for_editor', 2], ['code_used_uploads', 5], ['code_used_uploads', 6],
    ['code_used_uploads', 999], ['preview_token', 1, 1700000000],
    ['code_state', 5], ['code_state', 6], ['code_state', 9], ['code_state', 999], ['sql', "UPDATE users SET code_terms_at = '2026-10-10 10:00:00' WHERE id = 5"],
    ['sql', "REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('honeycombs', '{\"code_page\":\"250\"}')"], ['code_state', 5],
    ['sql', "DELETE FROM oys_meta WHERE meta_key = 'honeycombs'"]], 'lookups');
});

test('create: slug rules, title cleaning and starter files', async () => {
  const p = await same([
    ['code_create', 5, 'newslug', 'x'], ['code_create', 9, '', 'T'], ['code_create', 9, 'a', 'T'], ['code_create', 9, 'a'.repeat(31), 'T'], ['code_create', 9, 'ä', 'T'],
    ['code_create', 9, '-ab', 'T'], ['code_create', 9, 'ab-', 'T'], ['code_create', 9, 'a--b', 'T'], ['code_create', 9, 'Ab', 'T'], ['code_create', 9, 'a_b', 'T'],
    ['code_create', 9, 'admin', 'T'], ['code_create', 9, 'updates', 'T'], ['code_create', 9, 'kalender', 'T'], ['code_create', 9, 'xxx', 'T'], ['code_create', 9, 'g00gle', 'T'],
    ['code_create', 9, 'mia', 'T'], ['code_create', 9, 'miacode', 'T'], ['code_create', 9, 'tomcode', 'T'],
    ['code_create', 9, 'nine-site', '  <b>Nine</b> & “Co”\t‮'], ['code_create', 9, 'nine-two', 'again'],
    ['code_create', 10, 'ten-site', '0'], ['code_create', 11, 'ab'.repeat(15), ''], ['code_create', 8, 'eight-site', 'x'.repeat(130)], ['code_create', 7, 'nine-site', 'taken'],
    ['code_create', 7, 'Seven', 'T'],
    ['code_files', 3], ['code_files', 4], ['code_for_editor', 3], ['code_for_editor', 5]], 'create');
  // Jede Regel wurde wirklich geprüft (nicht nur „You already have a code page.“)
  const errors = p.slice(1, 18).map((r) => (r as unknown[])[1]);
  assert.equal(errors.filter((x) => x === 'You already have a code page.').length, 0, JSON.stringify(errors));
  assert.equal(errors[0], 'Please enter an address.');
});

test('save and write: names, types, sizes, counts, index.html, deletions and order', async () => {
  const big = (n: number, ch = 'a') => ch.repeat(n);
  const files = (n: number, size = 1, prefix = 'f') => Object.fromEntries(Array.from({ length: n }, (_v, i) => [`${prefix}${i}.txt`, big(size)]));
  const onlyIndex: Op = ['sql', "DELETE FROM code_files WHERE site_id = 3 AND path <> 'index.html'"];
  const p = await same([
    ['code_save', 3, { 'index.html': '<p>new</p>' }, []], ['code_save', 3, { 'index.html': '<p>new</p>' }, []],
    ['code_save', 3, { 'Docs\\Page.HTML': 'x', ' /sub/a.css/ ': 'y', 'A/B/C/D.MD': 'z' }, []],
    ['code_save', 3, { 'bad path.html': 'x' }, []], ['code_save', 3, { ['a'.repeat(70) + '!.html']: 'x' }, []], ['code_save', 3, { ['ü'.repeat(70)]: 'x' }, []],
    ['code_save', 3, { 'x.php': 'x' }, []], ['code_save', 3, { x: 'x' }, []], ['code_save', 3, { '.htaccess': 'x' }, []], ['code_save', 3, { 'a/b/c/d/e.html': 'x' }, []],
    ['code_save', 3, { 'a/b/c/e.html': 'x' }, []], ['code_save', 3, { 'ok.css': 'fine', 'then bad.css': 'x' }, []],
    ['code_save', 3, { 'x.html': 5 }, []], ['code_save', 3, { 'x.html': null }, []], ['code_save', 3, { 'x.html': ['a'] }, []], ['code_save', 3, { 'x.html': true }, []],
    ['code_save', 3, { 'x.html': { a: 'b' } }, []], ['code_save', 3, { 'x.html': 1.5 }, []],
    ['code_save', 3, { 'big.txt': big(262145) }, []], ['code_save', 3, { 'big.txt': big(262144) }, []], ['code_save', 3, { 'big.txt': big(131073, 'ä') }, []],
    ['code_save', 3, { 'big.txt': big(65536, '🐝') }, []], ['code_save', 3, { 'nul.txt': 'a\0b'.repeat(87382) }, []], ['code_save', 3, { 'nul.txt': 'a\0b'.repeat(87381) + '\0' }, []],
    ['code_save', 3, { 'index.html': 'x' }, ['index.html']], ['code_save', 3, {}, ['index.html']], ['code_save', 3, { 'INDEX.HTML': 'y' }, ['index.html']],
    ['code_save', 3, {}, ['style.css', 'nonexistent.css', 5, null, ['x'], 'big.txt', 'nul.txt']],
    // 30 Dateien sind erlaubt, 31 nicht; 2 MB insgesamt (gezählt vor dem Entfernen der Nullbytes)
    onlyIndex, ['code_save', 3, files(30), []], ['code_save', 3, files(29), []], ['code_save', 3, { 'one-more.txt': 'x' }, []], ['code_save', 3, files(29), ['index.html']],
    onlyIndex, ['code_save', 3, files(9, 240000, 'b'), []], ['code_save', 3, files(8, 262144, 'b'), []], ['code_save', 3, files(7, 262144, 'b'), []],
    ['code_save', 3, { 'b7.txt': big(262143) + '\0' }, []], ['code_save', 3, { 'b7.txt': big(262144) }, []], ['code_save', 3, { 'b7.txt': big(262000) }, []],
    ['code_save', 3, ['a'], []], ['code_save', 3, [], []], ['code_save', 3, { __pairs: [['5', 'x'], ['bad name', 'y']] }, []],
    ['code_save', 3, { __pairs: [['bad name', 'y'], ['5', 'x']] }, []], ['code_save', 3, { __pairs: [['b.css', 'B'], ['a.css', 'A'], ['B.CSS', 'b2']] }, []],
    ['code_save', 3, { 'same.css': 'one', 'SAME.css': 'two', ' same.css': 'three' }, []],
    ['code_write', 3, { 'w.css': 'written outside a transaction' }, []], ['code_write', 3, { 'bad file': 'x' }, []],
    ['code_files', 3]], 'save');
  assert.equal(p[0], null);
  assert.equal(p[3], '“bad path.html” isn’t an allowed file name. Use lowercase letters, numbers, - and _, and one of: html, htm, css, js, mjs, json, txt, md, svg, xml, webmanifest.');
});

test('delete user: site, files and honeycombs', async () => {
  await same([['code_delete_user', 9], ['code_delete_user', 999], ['code_delete_user', 6], ['code_site', 9], ['code_files', 3], ['balance', 9]], 'delete');
});

test('save: text with a lone UTF-16 surrogate is rejected (only reachable in Node)', async () => {
  // PHP bekommt so etwas nie (json_decode lehnt \ud800 ab); Node prüft den Text trotzdem wie mb_check_encoding
  await useDb(DB.node);
  try {
    const site = { id: 1, slug: 'miacode' };
    assert.equal(await codeWrite(site, { 'x.html': 'a\ud800b' }, []), 'x.html: only text files (UTF-8) can be saved.');
    assert.equal(await codeWrite(site, new Map([['y.html', '\udc00']]), []), 'y.html: only text files (UTF-8) can be saved.');
  } finally {
    await restoreDb();
  }
});

// oys_code_used_uploads() mit einer Datei je Aufruf: die echte PHP-Funktion auf einer SQLite-Datenbank im Speicher
function phpUsedUploads(contents: string[], userId: number): string[][] {
  return php(`$pdo = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
    $pdo->exec('CREATE TABLE code_sites (id INTEGER PRIMARY KEY, user_id INT)'); $pdo->exec('CREATE TABLE code_files (site_id INT, path TEXT, content TEXT)');
    $pdo->exec('INSERT INTO code_sites VALUES (1, ${userId})'); $ins = $pdo->prepare("INSERT INTO code_files VALUES (1, 'a.txt', ?)"); $out = [];
    foreach ($in as $c) { $pdo->exec('DELETE FROM code_files'); $ins->execute([$c]); $out[] = array_map('strval', array_keys(oys_code_used_uploads($pdo, ${userId}))); }
    return $out;`, contents) as string[][];
}

test('used uploads: random and hostile code files match PHP and stay fast', () => {
  const names = ['img_5_1700000000_abcdef12.png', 'aimg_5_1700000000_abcdef12.pngabc_5_1700000000_abcdef12.css', 'x_5_123456789_abcdef01.pngab_5_123456789_abcdef01.png',
    'A_5_1700000000_abcdef12.png', 'é_5_1700000000_abcdef12.png', 'ab__5_1700000000_abcdef12.png', 'a_55_1700000000_abcdef12.png', 'a_5_12345678_abcdef12.png',
    'a_5_12345678901_abcdef12.webp', 'a_5_123456789012_abcdef12.png', 'a_5_1700000000_abcdef1.png', 'a_5_1700000000_ABCDEF12.png', 'a_5_1700000000_abcdef12.p',
    'a_5_1700000000_abcdef12.jpeg12', 'bg_5_1700000000_abcdef12.webp" static/uploads/bg_5_1700000000_abcdef12.webp', 'static/uploads/a%20b.png static/uploads/%C3%A4.png',
    'xstatic/uploads/a.b-c_d%25.mp3?x static/uploads/ static/uploadsx', 'a_5_1700000000_abcdef12.png_5_1700000000_abcdef12.png', ''];
  const tokens = ['a', 'bc', 'xyz', 'Q', '_', '5', '55', '_5_', '_55_', '123456789', '1234567890', '12345678901', '123456789012', 'abcdef01', 'ABCDEF01', 'abcdef0',
    'abcdef012', '.', '.png', '.webp', '.pngab', '.p', '.jpeg1', 'é', '🐝', ' ', '/', 'static/uploads/', 'static/uploads', '%20', '%C3%A4', '-', '\n'];
  const random = fuzz(tokens, 3000, 14, 21);
  // Lange Buchstabenfolgen ohne Treffer (in V8 als ein Ausdruck quadratisch) und viele kurze Folgen
  const hostile = ['a'.repeat(262144), 'a'.repeat(200000) + '_5_1700000000_abcdef12.png', ('a'.repeat(5000) + '_5_1.').repeat(50),
    'ab_'.repeat(87000), ('img_5_1700000000_abcdef12.png ' + 'z'.repeat(3000)).repeat(80), 'static/uploads/' + 'a'.repeat(262000)];
  const all = [...names, ...random, ...hostile];
  const theirs = phpUsedUploads(all, 5);
  const started = Date.now();
  const mine = all.map((c) => [...usedUploadsIn([c], 5)]);
  const ms = Date.now() - started;
  const mismatches = all.map((c, i) => ({ c: c.slice(0, 120), mine: mine[i], php: theirs[i] })).filter((d) => JSON.stringify(d.mine) !== JSON.stringify(d.php));
  assert.deepEqual(mismatches, []);
  assert.ok(theirs.filter((x) => x.length).length > 100, 'enough contents with names in the sample');
  // Mehrere Dateien zusammen wie oys_code_used_uploads() (Reihenfolge der Namen wie die Schlüssel in PHP)
  assert.deepEqual([...usedUploadsIn(names, 5)], [...new Set(theirs.slice(0, names.length).flat())]);
  assert.ok(ms < 3000, `usedUploadsIn took ${ms} ms`);
});
