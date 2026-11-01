// Formular-Inhalte wie PHP lesen: welcher Content-Type $_POST füllt (SAPI: Typ klein geschrieben bis zum ersten ';', ','
// oder Leerzeichen) und welche Grenze ein multipart-Inhalt hat (rfc1867.c). Verglichen mit PHPs eingebautem Server;
// dazu, dass Fastify ungewöhnliche Werte nicht selbst mit 415 ablehnt (PHP liest sie, z. B. beim Anmelden).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer, phpBoundary, phpPostType, readBody } from '../src/server.js';
import { makeTestCtx } from '../src/web/ctx.js';
import { closePool } from '../src/db.js';


const multipart = (boundary: string): string =>
  `--${boundary}\r\nContent-Disposition: form-data; name="email"\r\n\r\nmia@test.de\r\n`
  + `--${boundary}\r\nContent-Disposition: form-data; name="list[]"\r\n\r\na\r\n`
  + `--${boundary}\r\nContent-Disposition: form-data; name="list[]"\r\n\r\nb\r\n--${boundary}--\r\n`;

// [Content-Type, Inhalt]
const CASES: Array<[string, string]> = [
  ['application/x-www-form-urlencoded', 'a=1&b[]=2&b[]=3'],
  ['APPLICATION/X-WWW-FORM-URLENCODED', 'a=1'],
  ['application/x-www-form-urlencoded; charset=UTF-8', 'a=1'],
  ['application/x-www-form-urlencoded;', 'a=1'],
  ['application/x-www-form-urlencoded, text/plain', 'a=1'],
  ['application/x-www-form-urlencoded charset=utf-8', 'a=1'],
  ['application/x-www-form-urlencoded\t; charset=utf-8', 'a=1'],
  ['application/x-www-form-urlencodedx', 'a=1'],
  ['text/plain', 'a=1'],
  ['foo', 'a=1'],
  ['', 'a=1'],
  ['multipart/form-data; boundary=XyZ', multipart('XyZ')],
  ['Multipart/Form-Data; BOUNDARY=XyZ', multipart('XyZ')],
  ['multipart/form-data, boundary=XyZ', multipart('XyZ')],
  ['multipart/form-data; charset=utf-8; boundary="XyZ"', multipart('XyZ')],
  ['multipart/form-data; boundary=XyZ,foo', multipart('XyZ')],
  ['multipart/form-data; boundary=XyZ; charset=utf-8', multipart('XyZ')],
  ['multipart/form-data;boundary=a"b', multipart('a"b')],
  ['multipart/form-data; boundary="a\\b"', multipart('a\\b')],
  ['multipart/form-data; boundary2=abc; boundary=XyZ', multipart('XyZ')],
  ['multipart/form-data; boundary2=abc; boundary=XyZ', multipart('abc')],
  ['multipart/form-data; boundary="XyZ', multipart('XyZ')],
  ['multipart/form-data; boundary=', multipart('XyZ')],
  ['multipart/form-data', multipart('XyZ')],
  ['multipart/form-data\t; boundary=XyZ', multipart('XyZ')],
  ['multipart/mixed; boundary=XyZ', multipart('XyZ')],
];

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

// Roh senden (fetch würde Header prüfen bzw. ändern)
function post(port: number, contentType: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/p.php', method: 'POST', headers: { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('form bodies are read for the same Content-Type values as in PHP', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oys-body-'));
  writeFileSync(join(dir, 'p.php'), '<?php echo json_encode($_POST, JSON_FORCE_OBJECT);');
  const port = await freePort();
  const server = spawn('php', ['-d', 'post_max_size=20M', '-d', 'upload_max_filesize=16M', '-d', 'display_errors=0', '-S', `127.0.0.1:${port}`, '-t', dir], { stdio: 'ignore' });
  try {
    for (let i = 0; ; i++) {
      try {
        await post(port, 'text/plain', '');
        break;
      } catch (err) {
        if (i > 80) throw err;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    for (const [type, body] of CASES) {
      const php = JSON.parse(await post(port, type, body)) as unknown;
      const ctx = makeTestCtx({ method: 'POST', url: '/', headers: { 'content-type': type } });
      await readBody(ctx, type, Buffer.from(body));
      assert.deepEqual(JSON.parse(JSON.stringify(ctx.post)), php, `${JSON.stringify(type)} → ${JSON.stringify(php)}`);
    }
  } finally {
    server.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('type and boundary rules of PHP', () => {
  assert.equal(phpPostType('application/x-www-form-urlencoded, text/plain'), 'application/x-www-form-urlencoded');
  assert.equal(phpPostType('Application/X-WWW-Form-Urlencoded charset=x'), 'application/x-www-form-urlencoded');
  assert.equal(phpPostType('application/x-www-form-urlencoded\t;x'), 'application/x-www-form-urlencoded\t');
  assert.equal(phpBoundary('multipart/form-data; BOUNDARY=XyZ'), 'XyZ');
  assert.equal(phpBoundary('multipart/form-data; boundary="X;y,Z"; charset=a'), 'X;y,Z');
  assert.equal(phpBoundary('multipart/form-data; boundary2=abc; boundary=XyZ'), 'abc');
  assert.equal(phpBoundary('multipart/form-data; boundary="XyZ'), null);
  assert.equal(phpBoundary('multipart/form-data'), null);
});

// Fastify prüft den Content-Type nicht mehr selbst: kein 415 mit eigener JSON-Fehlerseite, der Header bleibt für den
// Code der Seite unverändert lesbar
test('unusual Content-Type values reach the page instead of a 415 from Fastify', async () => {
  const app = await buildServer();
  try {
    for (const type of ['application/x-www-form-urlencoded, text/plain', 'application/x-www-form-urlencoded charset=utf-8', 'foo', 'multipart/form-data, boundary=XyZ', '']) {
      const res = await app.inject({ method: 'POST', url: '/imprint', headers: { host: 'oys.test:8080', 'content-type': type }, payload: 'a=1' });
      assert.equal(res.statusCode, 200, type);
      assert.equal(res.headers['content-type'], 'text/html; charset=UTF-8', type);
      assert.match(res.body, /<title>Legal Notice \| OnYourSite<\/title>/, type);
    }
  } finally {
    await app.close();
    await closePool();
  }
});
