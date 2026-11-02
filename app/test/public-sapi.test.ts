// Paket public gegen den Webserver von PHP (php -S): was nur mit echter SAPI sichtbar ist. header('Location: …') aus
// oys_redirect() (Leerraum am Ende, CR/LF/NUL, andere Steuerzeichen) und php://input bei multipart/form-data (POST
// /track-click liest den Inhalt selbst). Die Antworten werden roh gelesen: Node als Client lehnt PHPs Steuerzeichen im
// Header ab. Die Vergleiche laufen nur mit OYS_PHP_REF (siehe support/phpRef.ts).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type AddressInfo } from 'node:net';
import { validateHeaderValue } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isHalt, makeTestCtx } from '../src/web/ctx.js';
import { phpInput } from '../src/public/routes.js';
import { PHP_SKIP } from './support/phpRef.js';

let dir = '';
let port = 0;
let server: ChildProcess | null = null;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

// Rohe Anfrage; Antwort als latin1-Text (jedes Byte ein Zeichen), aufgeteilt in Status, Kopfzeilen und Inhalt
function raw(request: Buffer): Promise<{ status: number; headers: Array<[string, string]>; body: string }> {
  return new Promise((resolve, reject) => {
    const s = connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    s.on('data', (c: Buffer) => chunks.push(c));
    s.on('error', reject);
    s.on('end', () => {
      const text = Buffer.concat(chunks).toString('latin1');
      const i = text.indexOf('\r\n\r\n');
      const lines = text.slice(0, i).split('\r\n');
      const headers = lines.slice(1).map((l): [string, string] => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).replace(/^ /, '')]);
      resolve({ status: Number(lines[0].split(' ')[1]), headers, body: text.slice(i + 4) });
    });
    s.end(request);
  });
}

before(async () => {
  if (PHP_SKIP) return;
  dir = mkdtempSync(join(tmpdir(), 'oys-public-sapi-'));
  // oys_redirect() aus lib/helpers.php mit einem Ziel aus der Anfrage (hex, damit jedes Byte ankommt)
  writeFileSync(join(dir, 'loc.php'), "<?php header('Location: ' . hex2bin($_GET['u']), true, (int) $_GET['c']); exit;");
  writeFileSync(join(dir, 'input.php'), "<?php echo file_get_contents('php://input');");
  port = await freePort();
  server = spawn('php', ['-d', 'display_errors=0', '-d', 'post_max_size=20M', '-S', `127.0.0.1:${port}`, '-t', dir], { stdio: 'ignore' });
  for (let i = 0; ; i++) {
    try {
      await raw(Buffer.from('GET /input.php HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
      break;
    } catch (err) {
      if (i > 100) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
});

after(() => {
  server?.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('redirect targets with control characters are sent %-encoded and stay valid headers', () => {
  for (const url of ['/a\u0001b', 'https://example.com/a\u007fb', '/a\nb', '/a\rb']) {
    const ctx = makeTestCtx({ url: '/_/go/1' });
    try {
      ctx.redirect(url, 302);
    } catch (err) {
      if (!isHalt(err)) throw err;
    }
    const location = ctx.header('Location');
    if (location !== undefined) assert.doesNotThrow(() => validateHeaderValue('Location', location), JSON.stringify(url));
  }
  // php://input bei anderen Methoden: immer der Inhalt
  const put = makeTestCtx({ method: 'PUT', url: '/track-click', headers: { 'content-type': 'multipart/form-data; boundary=x' }, rawBody: Buffer.from('{"link_id":1}') });
  assert.equal(phpInput(put).toString(), '{"link_id":1}');
});

test('redirects follow header() of PHP: trailing whitespace, CR/LF/NUL and other control characters', { skip: PHP_SKIP }, async () => {
  const urls = ['/a', 'https://example.com/a?b=1#c', 'https://münchen.example/ä?x=ü', 'http://mia.oys.test:8080/rel\u0001x',
    'https://example.com/a\u0001b', 'https://example.com/a\u007fb', '/a\u001fb\u0008c', '/a\tb', '/a\u000bb', '/a\u000cb',
    '/a\u0000b', '/a\nb', '/a\rb', '/a\r\nb', '/a\n', '/a  \t', '/a \u000b\u000c\r\n', '/a\u0000', ' /a', '/a '];
  for (const code of [302, 303]) {
    for (const url of urls) {
      const php = await raw(Buffer.from(`GET /loc.php?u=${Buffer.from(url, 'utf8').toString('hex')}&c=${code} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
      const ctx = makeTestCtx({ url: '/_/go/1' });
      try {
        ctx.redirect(url, code);
      } catch (err) {
        if (!isHalt(err)) throw err;
      }
      const phpLocation = php.headers.find(([n]) => n === 'location')?.[1];
      const nodeLocation = ctx.header('Location');
      const label = `${code} ${JSON.stringify(url)}`;
      assert.equal(ctx.status, php.status, label);
      assert.equal(ctx.body, '', label);
      if (phpLocation === undefined) {
        assert.equal(nodeLocation, undefined, label);
        continue;
      }
      // Node kann diese Bytes nicht senden: dieselben als %XX (so kodiert sie auch der Browser beim Folgen)
      const expected = phpLocation.replace(/[\u0000-\u0008\u000a-\u001f\u007f]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
      assert.equal(nodeLocation, expected, label);
      assert.doesNotThrow(() => validateHeaderValue('Location', nodeLocation!), label);
    }
  }
});

test('php://input of POST /track-click is empty exactly when PHP reads the body as multipart/form-data', { skip: PHP_SKIP }, async () => {
  const body = '{"link_id":1}';
  const types = ['application/json', 'text/plain', '', 'multipart/form-data', 'multipart/form-data;', 'multipart/form-data; charset=utf-8',
    'multipart/form-data; boundary', 'multipart/form-data; Boundary', 'multipart/form-data; boundary=', 'multipart/form-data; boundary=""',
    'multipart/form-data; boundary="xyz', 'multipart/form-data; boundary="xyz"', 'multipart/form-data; boundary=xyz',
    'multipart/form-data;boundary=x', 'multipart/form-data; BOUNDARY=xyz', 'Multipart/Form-Data; boundary=xyz',
    'multipart/form-data, boundary=xyz', 'multipart/form-data; xboundary', 'multipart/form-data; foo=boundary',
    'multipart/form-data; boundaryx=1', 'multipart/form-data; boundary2; x=1', 'multipart/form-data; x="a"; boundary',
    'multipart/form-data\t; boundary=x', 'multipart/form-datax; boundary=x', 'multipart/mixed; boundary=xyz',
    'application/x-www-form-urlencoded'];
  let empty = 0;
  for (const type of types) {
    const head = `POST /input.php HTTP/1.1\r\nHost: x\r\nConnection: close\r\n${type !== '' ? `Content-Type: ${type}\r\n` : ''}Content-Length: ${body.length}\r\n\r\n`;
    const php = await raw(Buffer.from(head + body));
    const ctx = makeTestCtx({ method: 'POST', url: '/track-click', headers: type !== '' ? { 'content-type': type } : {}, rawBody: Buffer.from(body) });
    assert.equal(phpInput(ctx).toString(), php.body, JSON.stringify(type));
    if (php.body === '') empty++;
  }
  assert.ok(empty > 5 && empty < types.length - 5, 'both kinds of answers are compared');
  // Andere Methoden: php://input ist immer der Inhalt
  const put = makeTestCtx({ method: 'PUT', url: '/track-click', headers: { 'content-type': 'multipart/form-data; boundary=x' }, rawBody: Buffer.from(body) });
  assert.equal(phpInput(put).toString(), body);
});
