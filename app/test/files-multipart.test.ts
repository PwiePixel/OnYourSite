// $_FILES wie PHP (rfc1867): server.ts liest Formulare mit Dateien. Ein abgebrochener Upload darf den Server nicht
// beenden; PHP meldet ihn als UPLOAD_ERR_PARTIAL (3). Dateinamen kürzt PHP auf den Teil nach dem letzten / oder \ –
// „.“ und „..“ bleiben stehen (busboy machte daraus einen leeren Namen und damit „keine Datei“).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { buildServer, readBody } from '../src/server.js';
import { closePool } from '../src/db.js';
import { makeTestCtx } from '../src/web/ctx.js';

const TYPE = 'multipart/form-data; boundary=B';

after(async () => {
  await closePool();
});
const part = (head: string, data = 'DATA') => `--B\r\nContent-Disposition: form-data; ${head}\r\nContent-Type: image/png\r\n\r\n${data}\r\n`;
const kind = '--B\r\nContent-Disposition: form-data; name="kind"\r\n\r\nimage\r\n';
const BODIES: Record<string, string> = {
  normal: kind + part('name="file"; filename="x.png"') + '--B--\r\n',
  'no closing boundary': kind + part('name="file"; filename="x.png"'),
  'cut in the data': kind + part('name="file"; filename="x.png"').slice(0, -6),
  dot: part('name="file"; filename="."') + '--B--\r\n',
  'two dots': part('name="file"; filename=".."') + '--B--\r\n',
  'dots after a folder': part('name="file"; filename="a/.."') + '--B--\r\n',
  'trailing slash': part('name="file"; filename="a/"') + '--B--\r\n',
  'trailing backslash': part('name="file"; filename="a\\\\"') + '--B--\r\n',
  'windows path': part('name="file"; filename="C:\\\\fakepath\\\\photo.png"') + '--B--\r\n',
  'unix path': part('name="file"; filename="dir/sub/photo.png"') + '--B--\r\n',
};

function post(port: number, body: string): Promise<string> {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'POST', agent: false, headers: { 'Content-Type': TYPE, 'Content-Length': Buffer.byteLength(body), Host: 'oys.test:8080' } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
    });
    req.on('error', (e) => resolve('ERROR ' + e.message));
    req.end(body);
  });
}

test('a broken upload does not stop the server', async () => {
  const app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  try {
    await post(port, BODIES['no closing boundary']);
    await post(port, BODIES['cut in the data']);
    const after = await new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/robots.txt', agent: false, headers: { Host: 'oys.test:8080' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on('error', () => resolve(0));
    });
    assert.equal(after, 200);
  } finally {
    await app.close();
  }
});

test('$_FILES and $_POST from multipart bodies match PHP (partial uploads, path parts in names)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oys-mp-'));
  writeFileSync(join(dir, 'router.php'), `<?php header('Content-Type: application/json'); $f = $_FILES['file'] ?? null;
    echo json_encode(['file' => $f === null ? null : [$f['name'], $f['type'], $f['size'], $f['error']], 'post' => $_POST], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);`);
  // Eigener PHP-Server auf einem freien Port (den sucht der Server selbst nicht – darum ab 18190 probieren)
  let php: ReturnType<typeof spawn> | null = null;
  let port = 18190;
  for (; port < 18240 && !php; port++) {
    const child = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', dir, join(dir, 'router.php')], { stdio: ['ignore', 'ignore', 'pipe'] });
    const started = await new Promise<boolean>((resolve) => {
      let log = '';
      child.stderr!.on('data', (c: Buffer) => {
        log += c;
        if (/started/.test(log)) resolve(true);
      });
      child.once('exit', () => resolve(false));
    });
    if (started) php = child;
  }
  port--;
  try {
    assert.ok(php, 'PHP test server did not start');
    const mismatches: unknown[] = [];
    for (const [label, body] of Object.entries(BODIES)) {
      const ref = JSON.parse(await post(port, body)) as { file: unknown; post: unknown };
      const ctx = makeTestCtx({ url: '/', method: 'POST' });
      await readBody(ctx, TYPE, Buffer.from(body));
      const f = ctx.files.file;
      const node = { file: f ? [f.name, f.type, f.size, f.error] : null, post: Object.keys(ctx.post).length ? ctx.post : [] };
      if (JSON.stringify(node) !== JSON.stringify(ref)) mismatches.push({ label, node, php: ref });
    }
    assert.deepEqual(mismatches, []);
  } finally {
    php?.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
