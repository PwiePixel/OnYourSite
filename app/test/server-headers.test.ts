// Kopfzeilen auf der Leitung: Namen so, wie der Code sie schreibt (PHP: header('Location: …') sendet „Location“),
// nicht klein geschrieben wie bei Fastify üblich. Werte, Reihenfolge, Content-Length bei HEAD und 304 bleiben wie zuvor.
// Echte HTTP-Anfragen, damit die rohen Namen (rawHeaders) sichtbar sind.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { statSync } from 'node:fs';
import { ROOT_DIR } from '../src/config.js';
import { closePool } from '../src/db.js';
import { buildServer } from '../src/server.ts';

type Res = { status: number; names: string[]; headers: http.IncomingHttpHeaders; body: Buffer };
let port = 0;
let app: Awaited<ReturnType<typeof buildServer>>;

function request(method: string, path: string, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { Host: 'oys.test:8080', ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const names: string[] = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) {
          if (!['Date', 'Connection', 'Keep-Alive'].includes(res.rawHeaders[i])) names.push(res.rawHeaders[i]);
        }
        resolve({ status: res.statusCode ?? 0, names, headers: res.headers, body: Buffer.concat(chunks) });
      });
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

test('header names keep the case the code writes, like PHP header()', async () => {
  // PHP: oys_redirect() → header('Location: /updates#roadmap', true, 301)
  const roadmap = await request('GET', '/roadmap');
  assert.equal(roadmap.status, 301);
  assert.deepEqual(roadmap.names, ['Location', 'Content-Type', 'content-length']);
  assert.equal(roadmap.headers.location, '/updates#roadmap');
  // Öffentliche Endpunkte: X-Robots-Tag aus dem Router zuerst, dann der Typ (wie index.php)
  const nope = await request('GET', '/_/nope');
  assert.equal(nope.status, 404);
  assert.deepEqual(nope.names.slice(0, 2), ['X-Robots-Tag', 'Content-Type']);
  // Sitzung: Set-Cookie bleibt ein eigener Header (Fastify), die Kopfzeilen von session_start() behalten ihre Namen
  const login = await request('GET', '/login');
  assert.equal(login.status, 200);
  assert.deepEqual(login.names.filter((n) => n !== 'set-cookie' && n !== 'content-length'), ['Expires', 'Cache-Control', 'Pragma', 'Content-Type']);
  assert.equal(login.names.filter((n) => n.toLowerCase() === 'set-cookie').length, 1);
  assert.match(String(login.headers['set-cookie']), /^PHPSESSID=[0-9a-v]+; path=\/; HttpOnly; SameSite=Lax/);
});

test('static files: same order, Content-Length also for HEAD, 304 without a body', async () => {
  const size = statSync(ROOT_DIR + '/static/fonts/inter-400.ttf').size;
  const css = await request('GET', '/static/css/page.css');
  assert.equal(css.status, 200);
  assert.deepEqual(css.names, ['Content-Type', 'Last-Modified', 'ETag', 'Accept-Ranges', 'content-length']);
  assert.equal(Number(css.headers['content-length']), css.body.length);
  const head = await request('HEAD', '/static/fonts/inter-400.ttf');
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-length'], String(size));
  assert.equal(head.body.length, 0);
  assert.deepEqual(head.names, ['Content-Type', 'Last-Modified', 'ETag', 'Accept-Ranges', 'Access-Control-Allow-Origin', 'Cache-Control', 'content-length']);
  const part = await request('GET', '/static/fonts/inter-400.ttf', { Range: 'bytes=10-19' });
  assert.equal(part.status, 206);
  assert.equal(part.headers['content-length'], '10');
  assert.equal(part.body.length, 10);
  const again = await request('GET', '/static/css/page.css', { 'If-None-Match': String(css.headers.etag) });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
  assert.equal(again.headers['content-length'], undefined);
});
