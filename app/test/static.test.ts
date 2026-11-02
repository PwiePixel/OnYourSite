// Dateiauslieferung: keine Wege aus static/ heraus (auch nicht mit %2e%2e, ..%2f, Großbuchstaben, doppelten Schrägstrichen),
// Sperren für interne Ordner und Zugangsdaten, Teilbereiche wie Apache. Echte HTTP-Anfragen mit unveränderter Adresse.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { statSync, readFileSync } from 'node:fs';
import { ROOT_DIR, configString, loadConfig, setConfigForTests } from '../src/config.js';
import { closePool } from '../src/db.js';
import { buildServer } from '../src/server.ts';

type Res = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };
let port = 0;
let app: Awaited<ReturnType<typeof buildServer>>;

function get(path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { Host: 'oys.test:8080', ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as { port: number }).port;
});
after(async () => {
  await app.close();
  await closePool();
});

test('no way out of static/ and no secrets, however the address is written', async () => {
  const secrets = [configString('db.pass', ''), configString('aes_key', ''), configString('app_secret', '')].filter((s) => s.length >= 6);
  const attacks = [
    '/static/%2e%2e/config.json', '/static/%2E%2E/config.json', '/static/uploads/%2e%2e/%2e%2e/config.json', '/static/..%2fconfig.json',
    '/static/%2e%2e%2fconfig.json', '/static/css/../../config.json', '/static/./../config.json', '/static//..//config.json',
    '/static/%2e%2e/config.php', '/static/%2e%2e/server/backup.sh', '/static/%2e%2e/app/src/config.ts', '/static/%2e%2e/.git/HEAD',
    '/static/%2e%2e/email/smtp.json', '/static/%2e%2e%2f%2e%2e%2fetc/passwd', '/static/%2e%2e/%2e%2e/%2e%2e/etc/passwd',
    '/static/..\\config.json', '/static/%5c..%5cconfig.json', '/static/%00/../config.json', '/robots.txt/../config.json',
    '/%2e%2e/config.json', '/config.json', '/config.php', '/%63onfig.json', '/server/backup.sh', '/%73erver/backup.sh', '/.git/HEAD',
    '/static/.htaccess', '/static/uploads/.htaccess', '/static/%2ehtaccess', '/app/src/config.ts', '/email/smtp.json',
  ];
  for (const path of attacks) {
    const res = await get(path);
    assert.notEqual(res.status, 200, `${path} must not be served`);
    const text = res.body.toString('latin1');
    for (const s of secrets) assert.ok(!text.includes(s), `${path} leaked a secret`);
    assert.ok(!text.includes('"aes_key"') && !text.includes('<?php'), `${path} leaked a file`);
  }
});

test('denied folders and dotfiles answer 403, also when encoded', async () => {
  for (const path of ['/server/install.sh', '/%73erver/install.sh', '/email/smtp.example.json', '/discord-bot/.env.example', '/app/package.json',
    '/static/.htaccess', '/static/%2ehtaccess', '/config.php', '/.env', '/static/uploads/x.php']) {
    assert.equal((await get(path)).status, 403, path);
  }
});

test('the folder names of the PHP version are ordinary addresses now', async () => {
  // lib/, views/, cron/, tests/ und PHPMailer/ gibt es nicht mehr – keine Sperre, die 404-Seite der Website
  for (const path of ['/lib/helpers.php', '/%6Cib/helpers.php', '/views/admin.php', '/cron/weekly_report.php', '/tests/unit.php', '/PHPMailer/src/SMTP.php']) {
    const res = await get(path);
    assert.deepEqual([res.status, res.headers['content-type']], [404, 'text/html; charset=UTF-8'], path);
  }
});

test('normal static files keep working, with Apache headers and ranges', async () => {
  const css = await get('/static/css/page.css');
  assert.equal(css.status, 200);
  assert.equal(css.headers['content-type'], 'text/css');
  assert.ok(css.headers.etag && css.headers['last-modified']);
  const fontPath = ROOT_DIR + '/static/fonts/inter-400.ttf';
  const size = statSync(fontPath).size;
  const font = await get('/static/fonts/inter-400.ttf');
  assert.equal(font.status, 200);
  assert.equal(font.headers['access-control-allow-origin'], '*');
  assert.equal(font.body.length, size);
  const part = await get('/static/fonts/inter-400.ttf', { Range: 'bytes=10-109' });
  assert.equal(part.status, 206);
  assert.equal(part.headers['content-range'], `bytes 10-109/${size}`);
  assert.deepEqual(part.body, readFileSync(fontPath).subarray(10, 110));
  const tail = await get('/static/fonts/inter-400.ttf', { Range: 'bytes=-20' });
  assert.equal(tail.status, 206);
  assert.equal(tail.body.length, 20);
  const bad = await get('/static/fonts/inter-400.ttf', { Range: `bytes=${size + 5}-` });
  assert.equal(bad.status, 416);
  assert.equal(bad.headers['content-range'], `bytes */${size}`);
  const again = await get('/static/css/page.css', { 'If-None-Match': String(css.headers.etag) });
  assert.equal(again.status, 304);
  assert.equal((await get('/robots.txt')).status, 200);
});

// ---------------------------------------------------------------- wie Apache vor PHP (server/install.sh)

// Die erwarteten Antworten sind mit Apache 2.4.58 gemessen (Ubuntu, Module und vhost wie write_apache() in
// server/install.sh, .htaccess des Repositorys, PHP-FPM dahinter). Fehlerseiten von Apache selbst:
const page = (status: number, title: string, text: string): string =>
  `<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">\n<html><head>\n<title>${status} ${title}</title>\n</head><body>\n<h1>${title}</h1>\n${text}</body></html>\n`;
const FORBIDDEN = page(403, 'Forbidden', "<p>You don't have permission to access this resource.</p>\n");
const NOT_FOUND = page(404, 'Not Found', '<p>The requested URL was not found on this server.</p>\n');
const BAD_REQUEST = page(400, 'Bad Request', '<p>Your browser sent a request that this server could not understand.<br />\n</p>\n');
const moved = (url: string): string => page(301, 'Moved Permanently', `<p>The document has moved <a href="${url.replace(/&/g, '&amp;')}">here</a>.</p>\n`);
const notAllowed = (m: string): string => page(405, 'Method Not Allowed', `<p>The requested method ${m} is not allowed for this URL.</p>\n`);
const ISO = 'text/html; charset=iso-8859-1';

test('Apache error pages have the measured sizes', () => {
  // Content-Length bei Apache: 403 → 199, 404 → 196, 400 → 226, 301 (…/static/css/) → 241, 405 PUT → 220, DELETE → 223
  assert.deepEqual([FORBIDDEN.length, NOT_FOUND.length, BAD_REQUEST.length, moved('https://oys.test:8080/static/css/').length,
    notAllowed('PUT').length, notAllowed('DELETE').length], [199, 196, 226, 241, 220, 223]);
});

test('folders answer like Apache: redirect without a slash, 403 with one', async () => {
  const base = `${configString('scheme', 'https') === 'http' ? 'http' : 'https'}://oys.test:8080`;
  for (const [path, location] of [['/static', '/static/'], ['/static/css', '/static/css/'], ['/static/uploads', '/static/uploads/'],
    ['/static/css?a=1&b=%20', '/static/css/?a=1&b=%20'], ['/static/css?', '/static/css/?'], ['/stat%69c//css', '/static/css/']]) {
    const res = await get(path);
    assert.deepEqual([res.status, res.headers.location, res.headers['content-type'], res.body.toString('latin1')],
      [301, base + location, ISO, moved(base + location)], path);
  }
  for (const path of ['/static/', '/static/css/', '/static/vendor/', '/static/uploads/', '/static/./', '/static/css/./', '/static/.']) {
    const res = await get(path);
    assert.deepEqual([res.status, res.headers['content-type'], res.body.toString('latin1')], [403, ISO, FORBIDDEN], path);
  }
  // Andere Methoden: POST findet im Ordner nichts, PUT/PATCH/DELETE sind nicht erlaubt, OPTIONS nennt die Methoden
  assert.deepEqual([(await get('/static/css/', {}, 'POST')).status, (await get('/static/css/', {}, 'POST')).body.toString('latin1')], [404, NOT_FOUND]);
  for (const m of ['PUT', 'PATCH', 'DELETE']) {
    const res = await get('/static/css/', {}, m);
    assert.deepEqual([res.status, res.headers.allow, res.body.toString('latin1')], [405, 'GET,POST,OPTIONS,HEAD', notAllowed(m)], m);
    assert.equal((await get('/static/css', {}, m)).status, 301, m);
  }
  const opt = await get('/static/css/', {}, 'OPTIONS');
  assert.deepEqual([opt.status, opt.headers.allow, opt.headers['content-type'], opt.body.length], [200, 'GET,POST,OPTIONS,HEAD', 'httpd/unix-directory', 0]);
});

test('dot segments and encoded dots are resolved before the rules, like Apache', async () => {
  const robots = readFileSync(ROOT_DIR + '/robots.txt');
  const css = readFileSync(ROOT_DIR + '/static/css/page.css');
  for (const path of ['/static/../robots.txt', '/static/%2e%2e/robots.txt', '/static/%2E%2E/robots.txt', '/x/../robots.txt', '/x/%2e%2e/robots.txt',
    '/%72obots.txt', '/static/css/../../robots.txt']) {
    const res = await get(path);
    assert.deepEqual([res.status, res.headers['content-type']], [200, 'text/plain'], path);
    assert.deepEqual(res.body, robots, path);
  }
  for (const path of ['/static/./css/page.css', '/static//css//page.css', '/static/css/../css/page.css', '/stat%69c/css/page.css',
    '/static/uploads/../css/page.css', '/static/uploads/%2e%2e/css/page.css', '/mia/../static/css/page.css', '/static/css/page%2ecss']) {
    const res = await get(path);
    assert.deepEqual([res.status, res.headers['content-type']], [200, 'text/css'], path);
    assert.deepEqual(res.body, css, path);
  }
  // Nach dem Bereinigen gesperrt: 403 wie Apache
  for (const path of ['/static/../config.php', '/static/../server/backup.sh', '/static/../.env', '/static/uploads/../../config.php',
    '/static/%2e%2e/config.json', '/%73erver/backup.sh', '/static/%2ehtaccess', '/static/uploads/x.php/y', '/.well-known/x']) {
    const res = await get(path);
    assert.deepEqual([res.status, res.headers['content-type'], res.body.toString('latin1')], [403, ISO, FORBIDDEN], path);
  }
});

test('encoded slashes, NUL bytes, bad escapes and paths above the root are refused like Apache', async () => {
  // AllowEncodedSlashes Off: %2F (auch aus ..%2f) und ein Nullbyte → 404 von Apache selbst, auch außerhalb von static/
  for (const path of ['/static/..%2frobots.txt', '/static/..%2Frobots.txt', '/static/%2e%2e%2frobots.txt', '/static/..%2fconfig.php',
    '/static/..%2f..%2fetc%2fpasswd', '/static/css%2fpage.css', '/static/x%00y', '/mia%2fx', '/static/uploads/..%2f..%2fconfig.json']) {
    const res = await get(path);
    assert.deepEqual([res.status, res.headers['content-type'], res.body.toString('latin1')], [404, ISO, NOT_FOUND], path);
  }
  // Kaputte %-Folge oder über die Wurzel hinaus → 400
  for (const path of ['/static/%zz', '/static/%', '/static/%2', '/../robots.txt', '/%2e%2e/robots.txt', '/static/../../robots.txt', '/x/../..', '/mia%zz?x=1']) {
    const res = await get(path);
    assert.deepEqual([res.status, res.headers['content-type'], res.body.toString('latin1')], [400, ISO, BAD_REQUEST], path);
  }
  // Kein Fehler von Apache: %25 ist ein Prozentzeichen (kein Schrägstrich), /x/..%2E/.. endet bei /x/ – die Datei gibt
  // es nicht, also die 404-Seite der Website
  for (const path of ['/static/x%252fy', '/x/..%2E/..']) {
    const res = await get(path);
    assert.deepEqual([res.status, res.headers['content-type']], [404, 'text/html; charset=UTF-8'], path);
  }
});

test('a file with more path behind it is a 404 from Apache, methods like its default handler', async () => {
  for (const path of ['/robots.txt/', '/robots.txt/.', '/static/css/page.css/', '/static/css/page.css/x']) {
    const res = await get(path);
    assert.deepEqual([res.status, res.body.toString('latin1')], [404, NOT_FOUND], path);
    assert.equal((await get(path, {}, 'POST')).status, 404, path);
    assert.deepEqual([(await get(path, {}, 'PUT')).status, (await get(path, {}, 'PUT')).headers.allow], [405, 'GET,POST,OPTIONS,HEAD'], path);
  }
  const opt = await get('/robots.txt/', {}, 'OPTIONS');
  assert.deepEqual([opt.status, opt.headers.allow, opt.headers['content-type']], [200, 'GET,POST,OPTIONS,HEAD', 'text/plain']);
  // Die Datei selbst: GET, HEAD und POST liefern sie, OPTIONS nennt die Methoden, PUT/PATCH/DELETE → 405
  const css = readFileSync(ROOT_DIR + '/static/css/page.css');
  assert.deepEqual((await get('/static/css/page.css', {}, 'POST')).body, css);
  const o = await get('/static/css/page.css', {}, 'OPTIONS');
  assert.deepEqual([o.status, o.headers.allow, o.headers['content-type'], o.body.length], [200, 'GET,POST,OPTIONS,HEAD', 'text/css', 0]);
  for (const m of ['PUT', 'PATCH', 'DELETE']) {
    const res = await get('/static/css/page.css', {}, m);
    assert.deepEqual([res.status, res.headers.allow, res.headers['content-type'], res.body.toString('latin1')],
      [405, 'GET,POST,OPTIONS,HEAD', ISO, notAllowed(m)], m);
  }
});

test('behind the proxy: locked paths answer 403 before the https redirect, which uses the cleaned path', async () => {
  const base = loadConfig();
  setConfigForTests({ ...base, scheme: 'https' });
  try {
    const xfp = { 'X-Forwarded-Proto': 'http' };
    for (const path of ['/server/install.sh', '/config.php', '/.env', '/static/uploads/x.svg', '/email/smtp.json']) {
      assert.equal((await get(path, xfp)).status, 403, path);
    }
    for (const [path, location] of [['/static/css/page.css', '/static/css/page.css'], ['/static/../robots.txt', '/robots.txt'],
      ['/static/css', '/static/css'], ['/%7Emia?x=%20', '/~mia?x=%20'], ['/caf%C3%A9?q', '/caf%c3%a9?q'], ['/login?x=1&y=%20z', '/login?x=1&y=%20z']]) {
      const res = await get(path, xfp);
      assert.deepEqual([res.status, res.headers.location, res.body.toString('latin1')],
        [301, 'https://oys.test:8080' + location, moved('https://oys.test:8080' + location)], path);
    }
    // Die Fehler beim Prüfen der Adresse kommen noch vor der Weiterleitung
    assert.equal((await get('/../x', xfp)).status, 400);
    assert.equal((await get('/static/..%2fx', xfp)).status, 404);
  } finally {
    setConfigForTests(base);
  }
});
