// Dateiauslieferung: keine Wege aus static/ heraus (auch nicht mit %2e%2e, ..%2f, Großbuchstaben, doppelten Schrägstrichen),
// Sperren für interne Ordner und Zugangsdaten, Teilbereiche wie Apache. Echte HTTP-Anfragen mit unveränderter Adresse.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { statSync, readFileSync } from 'node:fs';
import { ROOT_DIR, configString } from '../src/config.js';
import { closePool } from '../src/db.js';
import { buildServer } from '../src/server.ts';

type Res = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };
let port = 0;
let app: Awaited<ReturnType<typeof buildServer>>;

function get(path: string, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: { Host: 'oys.test:8080', ...headers } }, (res) => {
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
    '/static/%2e%2e/config.php', '/static/%2e%2e/lib/helpers.php', '/static/%2e%2e/app/src/config.ts', '/static/%2e%2e/.git/HEAD',
    '/static/%2e%2e/email/smtp.json', '/static/%2e%2e%2f%2e%2e%2fetc/passwd', '/static/%2e%2e/%2e%2e/%2e%2e/etc/passwd',
    '/static/..\\config.json', '/static/%5c..%5cconfig.json', '/static/%00/../config.json', '/robots.txt/../config.json',
    '/%2e%2e/config.json', '/config.json', '/config.php', '/%63onfig.json', '/lib/helpers.php', '/%6Cib/helpers.php', '/.git/HEAD',
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
  for (const path of ['/lib/helpers.php', '/%6Cib/helpers.php', '/static/.htaccess', '/static/%2ehtaccess', '/config.php', '/.env', '/static/uploads/x.php']) {
    assert.equal((await get(path)).status, 403, path);
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
