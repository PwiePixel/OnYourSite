// Paket public gegen PHP: checkdate(), Ziel-Adressen geschützter Blöcke (oys_block_target), die Zwischenseite für
// geschützte Links (oys_render_gate), Accept-Erkennung (oys_wants_json), die 404-Seite (views/404.php) und die
// Termin-Seite (views/kalender.php) – jeweils Byte für Byte mit den echten PHP-Dateien der PHP-Version (siehe
// support/phpRef.ts). Die Funktionen aus lib/routes_public.php werden dafür aus der Datei gelesen (die Datei selbst
// beantwortet beim Einbinden eine Anfrage). Dazu Node-Prüfungen der Wege durch die Routen ohne Server (Weiterleitungen,
// Status, 404 für alle /_/-Reste).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool } from '../src/db.js';
import { hmac } from '../src/crypto.js';
import { parseStr } from '../src/php.js';
import { isHalt, makeTestCtx, type Ctx } from '../src/web/ctx.js';
import { blockFromRow } from '../src/content/pages.js';
import { blockTarget, publicRoutes, renderGate, wantsJson } from '../src/public/routes.js';
import { notFoundData, notFoundView } from '../src/public/notFound.js';
import { ensureSchema } from '../src/schema.js';
import { checkdate, kalender } from '../src/public/views/kalender.js';
import { diffs, rng, runPhp } from './modelHarness.js';
import { firstDiff, runPhpList } from './renderHarness.js';
import { withoutDialogs } from './support/dialogParity.js';
import { PHP_SKIP, phpFile } from './support/phpRef.js';

after(() => closePool());

// Funktion aus lib/routes_public.php lesen und in PHP bekannt machen
const PHP_FROM_ROUTES = (name: string) => `
  (function () {
    $src = file_get_contents('${phpFile('lib/routes_public.php')}');
    if (!preg_match('/^function ${name}\\(.*?^}$/ms', $src, $m)) { fwrite(STDERR, 'missing ${name}'); exit(1); }
    eval($m[0]);
  })();`;

// Antwort einer Route ohne Server: Status, Kopfzeilen und Inhalt (exit → Halt)
async function run(ctx: Ctx, fn: (c: Ctx) => Promise<void>): Promise<Ctx> {
  try {
    await fn(ctx);
  } catch (err) {
    if (!isHalt(err)) throw err;
  }
  return ctx;
}

const HASH = '$2y$10$wTrscK.WaG22eq5whSC/5uUBtskLFCfrfgCArmJWiQfd/OLfY0VG2';

test('checkdate() matches PHP for edge and random dates', { skip: PHP_SKIP }, () => {
  const r = rng(7);
  const cases: Array<[number, number, number]> = [];
  for (const m of [-1, 0, 1, 2, 3, 4, 6, 9, 11, 12, 13]) {
    for (const d of [-1, 0, 1, 28, 29, 30, 31, 32]) {
      for (const y of [-1, 0, 1, 4, 100, 400, 1900, 2000, 2023, 2024, 2100, 9999, 32767, 32768]) cases.push([m, d, y]);
    }
  }
  for (let i = 0; i < 3000; i++) cases.push([r.next(15) - 1, r.next(34) - 1, r.next(3000)]);
  const php = JSON.parse(runPhp(`echo json_encode(array_map(fn($c) => checkdate($c[0], $c[1], $c[2]), $in));`, JSON.stringify(cases))) as boolean[];
  const node = cases.map(([m, d, y]) => checkdate(m, d, y));
  assert.deepEqual(diffs(cases, node.map(String), php.map(String)), []);
});

// Seiten und Block-Zeilen für oys_block_target()/oys_render_gate()
const PAGES = [
  { id: 2, user_id: 5, slug: 'mia', title: 'Mia Müller', address_mode: 'subdomain', theme: 'cyberpunk', settings: '{"accent":"#ff5500","font":"outfit","button":"pill"}' },
  { id: 4, user_id: 7, slug: 'lea', title: '', address_mode: 'path', theme: 'deep-dark', settings: '' },
  { id: 9, user_id: 7, slug: 'x-y', title: '0', address_mode: 'subdomain', theme: 'nope', settings: '{"accent":"\\"><b>","font":"","button":"ghost"}' },
  { id: 11, user_id: 7, slug: 'Upper', title: '<Tom & "Jerry">', address_mode: 'path', theme: 'glass', settings: 'not json' },
];
const DATA = [
  '{"title":"Secret","url":"https:\\/\\/example.org\\/secret"}', '{"title":"Rel","url":"\\/x?y=1"}', '{"title":"Rel2","url":"\\/\\/evil.com"}',
  '{"url":"example.com\\/a b"}', '{"url":""}', '{}', '[]', '["x"]', 'not json', '{"url":["a"]}', '{"url":5}', '{"url":null}',
  '{"title":"Book","url":"\\/kalender"}', '{"title":"Book","url":"\\/KALENDER\\/"}', '{"title":"Book","url":"http:\\/\\/mia.oys.test:8080\\/kalender"}',
  '{"title":"Book","url":"https:\\/\\/oys.test:8080\\/lea\\/kalender"}', '{"title":"Book","url":"https:\\/\\/calendly.com\\/x"}', '{"title":"Book","url":" \\/kalender "}',
  '{"title":"File","src":"file_5_1773643714.pdf"}', '{"title":"File","src":"a b&c.pdf"}', '{"title":"File","src":""}', '{"title":"File","src":"0"}',
  '{"title":"File","src":["a"]}', '{"title":"File","src":5}', '{"title":"File","src":true}', '{"title":0,"url":"mailto:a@b.de"}',
  '{"title":["x"],"url":"+49 170 1234567"}', '{"title":"\\u202eevil","url":"javascript:alert(1)"}', '{"title":"<b>\\"q\\"<\\/b>","url":"tel:123"}',
];

test('blockTarget() matches oys_block_target() for every block type, URL form and page address mode', { skip: PHP_SKIP }, () => {
  const cases: Array<{ row: Record<string, unknown>; page: Record<string, unknown> }> = [];
  let id = 100;
  for (const page of PAGES) {
    for (const type of ['link', 'booking', 'file', 'socials']) {
      for (const data of DATA) {
        for (const protection of ['none', 'password', 'age', '']) {
          cases.push({ row: { id: id++, page_id: page.id, type, is_visible: 1, data, schedule: null, protection, password_hash: protection === 'password' ? HASH : null, effect: 'none', clicks: 0 }, page });
        }
      }
    }
  }
  const php = JSON.parse(runPhp(`${PHP_FROM_ROUTES('oys_block_target')}
    $out = [];
    foreach ($in as $c) { try { $out[] = oys_block_target(oys_block_from_row($c['row']), $c['page']); } catch (Throwable $e) { $out[] = 'THROW'; } }
    echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);`, JSON.stringify(cases))) as string[];
  const node = cases.map((c) => {
    try {
      return blockTarget(blockFromRow(c.row), c.page);
    } catch {
      return 'THROW';
    }
  });
  assert.ok(php.includes('THROW') && php.some((x) => x.includes('?k=')), 'the cases reach the error and the calendar key branch');
  assert.deepEqual(diffs(cases, node, php), []);
});

test('renderGate() matches oys_render_gate() byte for byte (age, password, with and without error)', { skip: PHP_SKIP }, () => {
  const cases: Array<{ row: Record<string, unknown>; page: Record<string, unknown>; kind: string; error: string | null }> = [];
  let id = 7;
  for (const page of PAGES) {
    for (const data of ['{"title":"Secret link","url":"https:\\/\\/example.org"}', '{"title":"","url":"x.de"}', '{"title":"0"}', '{"title":5}',
      '{"title":["a"]}', '[]', '{"title":"<script>\\"&\'"}', '{"title":"🎧 Ä ‮x"}']) {
      for (const kind of ['age', 'password']) {
        for (const error of [null, '', 'Wrong password.', 'Too many attempts. Please wait a few minutes.', '<b>&"\'</b>']) {
          cases.push({ row: { id: id++, page_id: page.id, type: 'link', is_visible: 1, data, schedule: null, protection: kind, password_hash: HASH, effect: 'none', clicks: 0 }, page, kind, error });
        }
      }
    }
  }
  const php = runPhpList(`${PHP_FROM_ROUTES('oys_render_gate')}
    foreach ($in as $c) { $out[] = oys_render_gate($c['page'], oys_block_from_row($c['row']), $c['kind'], $c['error']); }`, JSON.stringify(cases));
  cases.forEach((c, i) => {
    const node = withoutDialogs(renderGate(c.page, blockFromRow(c.row), c.kind as 'age' | 'password', c.error));
    assert.equal(node, php[i], `case ${i} ${JSON.stringify(c).slice(0, 200)}: ${firstDiff(php[i], node)}`);
  });
});

test('wantsJson() matches stripos() on the Accept header (ASCII case folding only)', { skip: PHP_SKIP }, () => {
  const values = ['', 'application/json', 'Application/JSON', 'APPLICATION/JSON', 'text/html, application/json;q=0.9', 'application/jsonp', 'application/ json',
    'APPLİCATION/JSON', 'application/jsonİ', 'text/*', '*/*', 'application/x-json', 'ＡＰＰＬＩＣＡＴＩＯＮ/JSON'];
  const php = JSON.parse(runPhp(`echo json_encode(array_map(fn($a) => stripos($a, 'application/json') !== false, $in));`, JSON.stringify(values))) as boolean[];
  const node = values.map((v) => wantsJson(makeTestCtx({ url: '/_/contact', headers: v === '' ? {} : { accept: v } })));
  assert.deepEqual(node, php.map((x, i) => (values[i] === '' ? false : x)));
});

test('the 404 page matches views/404.php for every host and path form (taken, free, reserved, www, foreign)', { skip: PHP_SKIP }, async () => {
  // Die Liste aller Adressen gehört zur Prüfung „Adresse frei?“ – die Datenbank dieses Arbeitsordners braucht sie
  await ensureSchema();
  const hosts = ['oys.test:8080', 'OYS.TEST:8080', 'www.oys.test:8080', 'mia.oys.test:8080', 'free-name.oys.test:8080', 'admin.oys.test:8080',
    'a--b.oys.test:8080', '.oys.test:8080', 'x.y.oys.test:8080', 'example.com', 'evil-oys.test:8080', 'tomcode.oys.test'];
  const uris = ['/', '/free-name', '/Free-Name/', '/mia', '/a', '/' + 'a'.repeat(30), '/' + 'b'.repeat(31), '/kalender', '/x/y', '/%3Cscript%3E',
    '//evil', '/a:80/x', '/free-name?x=1', '/_/nope', '/www', '/-ab', '/ab-'];
  const cases: Array<{ host: string; uri: string }> = [];
  for (const host of hosts) for (const uri of uris) cases.push({ host, uri });
  const php = runPhpList(`require_once '${phpFile('blacklist.php')}';
    foreach ($in as $c) {
      $_SERVER['HTTP_HOST'] = $c['host']; $_SERVER['REQUEST_URI'] = $c['uri'];
      ob_start(); include '${phpFile('views/404.php')}'; $out[] = ob_get_clean();
    }`, JSON.stringify(cases), { db: true });
  let free = 0;
  for (let i = 0; i < cases.length; i++) {
    const data = await notFoundData(makeTestCtx({ url: cases[i].uri, host: cases[i].host }));
    if (data.isFree) free++;
    const node = withoutDialogs(notFoundView(data));
    assert.equal(node, php[i], `case ${JSON.stringify(cases[i])}: ${firstDiff(php[i], node)}`);
  }
  assert.ok(free > 0 && free < cases.length, 'both variants of the page are compared');
});

// Termin-Seite: Token (time()) nach der Prüfung durch einen festen Text ersetzen
function bookingTokens(html: string, pageId: number): string {
  return html.replace(/name="t" value="(\d+)\.([0-9a-f]{32})"/g, (m, ts: string, mac: string) =>
    hmac('booking|' + pageId + '|' + ts).slice(0, 32) === mac && Math.abs(Number(ts) - Date.now() / 1000) < 600 ? 'name="t" value="TOKEN"' : m);
}

test('the calendar page matches views/kalender.php (form, success notice, every error, refilled values)', { skip: PHP_SKIP }, async () => {
  const ts = Math.floor(Date.now() / 1000);
  const pages = [
    { id: 2, user_id: 5, slug: 'mia', title: 'Mia Müller', avatar: null, address_mode: 'subdomain', theme: 'cyberpunk', settings: '{"accent":"#ff5500"}' },
    { id: 4, user_id: 7, slug: 'lea', title: '', avatar: 'avatar_7_1_a.webp', address_mode: 'path', theme: 'deep-dark', settings: '' },
    { id: 5, user_id: 5, slug: 'mia-shop', title: '<Shop & "Co">', avatar: 'a b&c.png', address_mode: 'subdomain', theme: 'glass', settings: '{"font":"lora"}' },
  ];
  const valid = (pageId: number) => ts + '.' + hmac('booking|' + pageId + '|' + ts).slice(0, 32);
  const posts = (pageId: number): string[] => {
    const t = encodeURIComponent(valid(pageId));
    return [
      `t=${t}&website=&guest_name=&guest_email=a%40b.de&booking_date=2030-01-01&booking_time=10%3A00`,
      `t=${t}&website=&guest_name=Guest&guest_email=nope&booking_date=2030-01-01&booking_time=10%3A00`,
      `t=${t}&website=&guest_name=%22%3E%3Cscript%3E&guest_email=bad&booking_date=%3Cx%3E&booking_time=14%3A00`,
      `t=${t}&website=&guest_name=Guest&guest_email=a%40b.de&booking_date=2020-01-01&booking_time=10%3A00`,
      `t=${t}&website=&guest_name=Guest&guest_email=a%40b.de&booking_date=2099-01-01&booking_time=10%3A00`,
      `t=${t}&website=&guest_name=Guest&guest_email=a%40b.de&booking_date=2027-02-29&booking_time=10%3A00`,
      `t=${t}&website=&guest_name=Guest&guest_email=a%40b.de&booking_date=01.12.2026&booking_time=10%3A00`,
      `t=${t}&website=&guest_name=Guest&guest_email=a%40b.de&booking_date=${encodeURIComponent(new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10))}&booking_time=12%3A00`,
      `t=${t}&website=&guest_name[]=x&guest_email[]=y&booking_date[]=z&booking_time[]=10%3A00`,
      `t=${t}&website=&guest_name=G&guest_email=a%40b.de&booking_date=2030-01-01&booking_time=`,
    ];
  };
  const cases: Array<{ page: Record<string, unknown>; key: string; method: string; query: string; body: string }> = [];
  for (const page of pages) {
    for (const key of ['', '0123456789abcdef01234567', 'a b+c']) {
      for (const query of ['', 'ok=1', 'ok', 'ok[]=1', 'k=x']) cases.push({ page, key, method: 'GET', query, body: '' });
      for (const body of posts(page.id)) cases.push({ page, key, method: 'POST', query: '', body });
      cases.push({ page, key, method: 'POST', query: 'ok=1', body: posts(page.id)[1] });
      cases.push({ page, key, method: 'PUT', query: '', body: posts(page.id)[0] });
    }
  }
  // Nur Fälle, die vor der Begrenzung enden: security.php, mail.php und die Datenbank werden nicht gebraucht
  const php = runPhpList(`
    foreach ($in as $c) {
      $_SERVER['REQUEST_METHOD'] = $c['method'];
      $_GET = []; parse_str($c['query'], $_GET);
      $_POST = []; if ($c['method'] === 'POST') parse_str($c['body'], $_POST);
      $page = $c['page']; $calendarKey = $c['key'];
      ob_start(); include '${phpFile('views/kalender.php')}'; $out[] = ob_get_clean();
    }`, JSON.stringify(cases), { db: true });
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const ctx = await run(makeTestCtx({ method: c.method, url: '/kalender' + (c.query !== '' ? '?' + c.query : ''), host: 'mia.oys.test:8080',
      post: c.method === 'POST' ? parseStr(c.body, true) : {} }), (x) => kalender(x, c.page, c.key));
    assert.equal(ctx.status, 200, `case ${i}`);
    const node = bookingTokens(withoutDialogs(String(ctx.body)), Number(c.page.id));
    const want = bookingTokens(php[i], Number(c.page.id));
    assert.equal(node, want, `case ${i} ${JSON.stringify(c).slice(0, 300)}: ${firstDiff(want, node)}`);
  }
});

test('a calendar POST with an invalid token or a filled honeypot only redirects to the success notice', async () => {
  const page = { id: 2, user_id: 5, slug: 'mia', title: 'Mia', address_mode: 'subdomain', settings: '' };
  for (const [key, body] of [['', 't=nope&guest_name=G'], ['k1', 'website=x&guest_name=G'], ['', 't=' + (Math.floor(Date.now() / 1000) - 90000) + '.' + 'a'.repeat(32)]]) {
    const ctx = await run(makeTestCtx({ method: 'POST', url: '/kalender', host: 'mia.oys.test:8080', post: parseStr(body, true) }), (x) => kalender(x, page, key));
    assert.equal(ctx.status, 303);
    assert.equal(ctx.header('Location'), 'http://mia.oys.test:8080/kalender' + (key !== '' ? '?k=' + key + '&ok=1' : '?ok=1'));
  }
});

test('the public routes answer like routes_public.php without a database where none is needed', async () => {
  // Unbekannte Demo: 404 ohne Inhalt; Demo mit Cache-Kopfzeile
  let ctx = await run(makeTestCtx({ url: '/_/demo/nope' }), publicRoutes);
  assert.equal(ctx.status, 404);
  assert.equal(ctx.body, '');
  ctx = await run(makeTestCtx({ url: '/_/demo/neon?layout=cards' }), publicRoutes);
  assert.equal(ctx.status, 200);
  assert.equal(ctx.header('Cache-Control'), 'public, max-age=600');
  assert.match(String(ctx.body), /l-cards/);
  // Web-Cron ohne passenden Schlüssel: 403 „Forbidden“ (mit HTML-Typ wie PHP)
  for (const url of ['/_/cron/weekly-report', '/_/cron/weekly-report?key=nope', '/_/cron/weekly-report?key[]=x']) {
    ctx = await run(makeTestCtx({ url }), publicRoutes);
    assert.equal(ctx.status, 403);
    assert.equal(ctx.body, 'Forbidden');
    assert.equal(ctx.header('Content-Type'), undefined);
  }
});
