// Upload-Ordner gegen PHP: Liste der Dateien, Dateien eines Kontos, Aufräumen alter Uploads, ZIP-Backup, Umzug in den
// eingestellten Ordner, Upload-Grenze, round() – und das Ausliefern von /static/uploads/… über HTTP (PHP mit php -S,
// Node mit dem echten Server): Status, Kopfzeilen und Inhalt Byte für Byte, auch mit Range und If-None-Match.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { Readable } from 'node:stream';
import { ROOT_DIR, loadConfig, setConfigForTests } from '../src/config.js';
import { closePool, exec } from '../src/db.js';
import { time } from '../src/php.js';
import { makeTestCtx, isHalt } from '../src/web/ctx.js';
import { setUploadsDefaultDirForTests, storageDownloadZip, storageFiles, storageMoveToDataDir } from '../src/content/storage.js';
import { sweepUploads, uploadLimitMb, userUploadFiles } from '../src/content/uploads.js';
import { phpRound } from '../src/content/phpMath.js';
import { buildServer } from '../src/server.js';
import { PHP_PRELUDE, configWith, copyDatabase, runPhp, startPhpServer, type DbCopies } from './filesHarness.js';
import { rng } from './modelHarness.js';

const BASE = loadConfig();
let tmp = '';
let dbs: DbCopies;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'oys-files-'));
  dbs = await copyDatabase('s');
});

after(async () => {
  setConfigForTests(BASE);
  setUploadsDefaultDirForTests(null);
  await closePool();
  await dbs.drop();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

// Ordner mit schwierigen Namen: Punkte, Unterordner, Links, kein UTF-8, Sortierung nach Bytes
function makeUploads(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const old = time() - 3 * 86400;
  const files: Array<[string | Buffer, string]> = [
    [`avatar_5_${old}_abcdef12.png`, 'a'], [`img_5_${old}_0123abcd.webp`, 'bb'], [`gal_5_${time()}_0123abcd.webp`, 'new'],
    [`music_5_${old}_ffffffff.mp3`, 'm'.repeat(1000)], [`file_5_${old}_abcdef12.pdf`, 'pdf'], ['file_5_1773643714.pdf', 'legacy'],
    [`avatar_6_${old}_abcdef12.png`, 'tom'], [`avatar_15_${old}_abcdef12.png`, 'x'], [`img_05_${old}_abcdef12.png`, 'y'],
    [`img_5_${old}_ABCDEF12.png`, 'upper'], [`x_5_${old}_abcdef12.p`, 'shortext'], ['legacy name.png', 'l'], ['Zebra.png', 'z'], ['zebra.png', 'z2'],
    ['ümlaut_5_1.png', 'u'], [Buffer.from('raw\xff_5_x.png', 'latin1'), 'r'], ['.hidden_5_x.png', 'h'], ['empty.txt', ''],
    [`thumb_5_${old}_abcdef12.jpg\n`, 'nl'],
  ];
  for (const [name, data] of files) writeFileSync(Buffer.concat([Buffer.from(dir + '/'), Buffer.isBuffer(name) ? name : Buffer.from(name)]), data);
  mkdirSync(join(dir, 'sub_5_dir'));
  symlinkSync('zebra.png', join(dir, 'link_5_x.png'));
  symlinkSync('missing.png', join(dir, 'broken_5_x.png'));
}

const mapJson = (m: Map<string, number>) => JSON.stringify([...m.entries()]);
const phpMapJson = 'echo json_encode(array_map(null, array_map("strval", array_keys($r)), array_values($r)), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);';

test('storage listing and the files of an account match PHP', () => {
  const dir = join(tmp, 'list');
  makeUploads(dir);
  const config = { ...BASE, uploads_dir: dir };
  setConfigForTests(config);
  try {
    assert.equal(mapJson(storageFiles()), runPhp(`$r = oys_storage_files(); ${phpMapJson}`, '', { config }));
    assert.equal(mapJson(storageFiles(join(tmp, 'missing'))), runPhp(`$r = oys_storage_files('${join(tmp, 'missing')}'); ${phpMapJson}`, '', { config }));
    for (const uid of [5, 6, 15, 0, -1]) {
      assert.equal(mapJson(userUploadFiles(uid)), runPhp(`$r = oys_user_upload_files(${uid}); ${phpMapJson}`, '', { config }), `user ${uid}`);
    }
  } finally {
    setConfigForTests(BASE);
  }
});

test('sweeping unused uploads deletes the same files as PHP', async () => {
  const dirs = { php: join(tmp, 'sweep-php'), node: join(tmp, 'sweep-node') };
  for (const d of Object.values(dirs)) makeUploads(d);
  const old = time() - 3 * 86400;
  // Mia benutzt eine alte Datei auf ihrer Seite – die bleibt
  const setup = `UPDATE pages SET avatar = 'avatar_5_${old}_abcdef12.png' WHERE id = 2`;
  await dbs.admin.query(`USE \`${dbs.names.php}\``);
  await dbs.admin.query(setup);
  const phpOut = runPhp(`$r = oys_sweep_uploads($pdo, 5, oys_user_upload_files(5)); ${phpMapJson}`, '', { config: configWith(BASE, dbs.names.php, dirs.php), db: true });
  setConfigForTests(configWith(BASE, dbs.names.node, dirs.node));
  await closePool();
  try {
    await exec(setup);
    const nodeOut = mapJson(await sweepUploads(5, userUploadFiles(5)));
    assert.equal(nodeOut, phpOut);
  } finally {
    await closePool();
    setConfigForTests(BASE);
  }
  assert.deepEqual(readdirSync(dirs.node, { encoding: 'buffer' }).map(String).sort(), readdirSync(dirs.php, { encoding: 'buffer' }).map(String).sort());
  assert.ok(!readdirSync(dirs.php).includes(`img_5_${old}_0123abcd.webp`) && readdirSync(dirs.php).includes(`avatar_5_${old}_abcdef12.png`));
});

test('upload limit and round() match PHP', () => {
  for (const [u, p] of [['16M', '20M'], ['2M', '8M'], ['1G', '2G'], ['-1', '512M'], ['1.5M', '3M'], ['100K', '1M'], ['0', '20M'], ['300M', '-1'], ['999999', '20M']]) {
    const php = Number(runPhp('echo json_encode(oys_upload_limit_mb());', '', { ini: [`upload_max_filesize=${u}`, `post_max_size=${p}`] }));
    assert.equal(uploadLimitMb(u, p), php, `${u}/${p}`);
  }
  assert.equal(uploadLimitMb(), 16);
  const r = rng(11);
  const values: number[] = [23 / 80 * 100, 1 / 3 * 100, 2.5, -2.5, 0.285, 1.955, 5.055, 1e15 + 0.5, 0, -0.0001, 12345.6789];
  for (let i = 0; i < 3000; i++) values.push((r.next(100000) / (1 + r.next(997))) * 100, r.next(3000) * r.next(1600) / (1 + r.next(4000)));
  const places = [0, 1, 2];
  const php = JSON.parse(runPhp('$o = []; foreach ($in as [$v, $p]) $o[] = round($v, $p); echo json_encode($o);', JSON.stringify(values.flatMap((v) => places.map((p) => [v, p])))));
  const node = values.flatMap((v) => places.map((p) => phpRound(v, p)));
  assert.deepEqual(node, php);
});

// Zentralverzeichnis eines ZIP lesen: Name, Methode, CRC, Größen
function zipEntries(z: Buffer): Array<{ name: string; method: number; crc: number; size: number; csize: number }> {
  const eocd = z.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1'));
  const count = z.readUInt16LE(eocd + 10);
  let p = z.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    const n = z.readUInt16LE(p + 28);
    out.push({ name: z.toString('utf8', p + 46, p + 46 + n), method: z.readUInt16LE(p + 10), crc: z.readUInt32LE(p + 16), csize: z.readUInt32LE(p + 20), size: z.readUInt32LE(p + 24) });
    p += 46 + n + z.readUInt16LE(p + 30) + z.readUInt16LE(p + 32);
  }
  return out;
}

async function nodeZip(): Promise<{ error: string } | { headers: Array<[string, string]>; zip: Buffer }> {
  const ctx = makeTestCtx({ url: '/admin', method: 'POST' });
  try {
    return { error: await storageDownloadZip(ctx) };
  } catch (err) {
    if (!isHalt(err)) throw err;
  }
  const chunks: Buffer[] = [];
  for await (const c of ctx.body as Readable) chunks.push(c as Buffer);
  return { headers: ctx.headersOut(), zip: Buffer.concat(chunks) };
}

test('the ZIP backup has the same entries as PHP and passes unzip -t', async () => {
  const dir = join(tmp, 'zip');
  makeUploads(dir);
  writeFileSync(join(dir, 'big_5_x.bin'), Buffer.alloc(300000, 7));
  const config = { ...BASE, uploads_dir: dir };
  const php = execFileSync('php', ['-d', 'display_errors=stderr', '-r', `${PHP_PRELUDE} $e = oys_storage_download_zip(); echo 'ERR:' . $e;`], {
    env: { ...process.env, OYS_TEST_CONFIG: JSON.stringify(config) }, maxBuffer: 64 * 1024 * 1024,
  });
  setConfigForTests(config);
  let node;
  try {
    node = await nodeZip();
  } finally {
    setConfigForTests(BASE);
  }
  assert.ok('zip' in node);
  const phpEntries = zipEntries(php).map((e) => ({ ...e, csize: undefined }));
  const nodeEntries = zipEntries(node.zip).map((e) => ({ ...e, csize: undefined }));
  // Namen, die kein UTF-8 sind, schreibt Node als Ersatzzeichen (PHP: die rohen Bytes) – sonst identisch
  assert.deepEqual(nodeEntries.filter((e) => !e.name.includes('�')), phpEntries.filter((e) => !e.name.includes('�')));
  assert.equal(nodeEntries.length, phpEntries.length);
  assert.ok(nodeEntries.every((e) => e.method === 0));
  const file = join(tmp, 'node.zip');
  writeFileSync(file, node.zip);
  assert.match(execFileSync('unzip', ['-t', file]).toString(), /No errors detected/);
  const h = Object.fromEntries(node.headers.map(([k, v]) => [k.toLowerCase(), v]));
  assert.equal(h['content-type'], 'application/zip');
  assert.match(h['content-disposition'], /^attachment; filename="onyoursite-uploads-\d{4}-\d\d-\d\d\.zip"$/);
  assert.equal(h['content-length'], String(node.zip.length));
  assert.equal(h['cache-control'], 'no-store');

  // Leerer Ordner: dieselbe Meldung
  const empty = join(tmp, 'zip-empty');
  mkdirSync(empty);
  const cfg2 = { ...BASE, uploads_dir: empty };
  const phpEmpty = execFileSync('php', ['-d', 'display_errors=stderr', '-r', `${PHP_PRELUDE} echo oys_storage_download_zip();`], { env: { ...process.env, OYS_TEST_CONFIG: JSON.stringify(cfg2) } }).toString();
  setConfigForTests(cfg2);
  try {
    assert.deepEqual(await nodeZip(), { error: phpEmpty });
  } finally {
    setConfigForTests(BASE);
  }
});

test('moving uploads into the data folder works like PHP', () => {
  // PHP rechnet den Code-Ordner aus lib/storage.php: dafür eine Kopie mit eigenem static/uploads
  const cases: Array<{ name: string; external: boolean; prepare?: (code: string, target: string) => void }> = [
    { name: 'move', external: true, prepare: (_code, target) => {
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, 'zebra.png'), 'already there');
    } },
    { name: 'missing-target', external: true },
    { name: 'not-external', external: false },
    { name: 'blocked', external: true, prepare: (code) => writeFileSync(join(code, 'blocker'), 'file instead of a folder') },
  ];
  for (const c of cases) {
    const results: Record<string, unknown> = {};
    const listings: Record<string, unknown> = {};
    for (const side of ['php', 'node'] as const) {
      const code = join(tmp, `move-${c.name}-${side}`);
      mkdirSync(join(code, 'lib'), { recursive: true });
      writeFileSync(join(code, 'lib/storage.php'), readFileSync(join(ROOT_DIR, 'lib/storage.php')));
      makeUploads(join(code, 'static/uploads'));
      const target = c.name === 'blocked' ? join(code, 'blocker/uploads') : c.external ? join(code, 'data/uploads') : join(code, 'static/uploads');
      c.prepare?.(code, target);
      const config = { ...BASE, uploads_dir: target };
      if (side === 'php') {
        results.php = JSON.parse(execFileSync('php', ['-d', 'display_errors=stderr', '-r', `${PHP_PRELUDE.replace(`require_once '${ROOT_DIR}/lib/storage.php';`, `require_once '${code}/lib/storage.php';`)} echo json_encode(oys_storage_move_to_data_dir(), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);`], {
          env: { ...process.env, OYS_TEST_CONFIG: JSON.stringify(config) },
        }).toString().replaceAll(code, '<CODE>'));
      } else {
        setConfigForTests(config);
        setUploadsDefaultDirForTests(join(code, 'static/uploads'));
        try {
          results.node = JSON.parse(JSON.stringify(storageMoveToDataDir()).replaceAll(code, '<CODE>'));
        } finally {
          setConfigForTests(BASE);
          setUploadsDefaultDirForTests(null);
        }
      }
      const list = (d: string) => {
        try {
          return readdirSync(d, { encoding: 'buffer' }).map((n) => n.toString('latin1')).sort();
        } catch {
          return null;
        }
      };
      listings[side] = { from: list(join(code, 'static/uploads')), to: list(target) };
    }
    assert.deepEqual(results.node, results.php, c.name);
    assert.deepEqual(listings.node, listings.php, c.name);
  }
});

// ---------------------------------------------------------------- /static/uploads/… über HTTP

function request(port: number, method: string, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: string[]; body: Buffer }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { Host: 'oys.test:8080', ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.rawHeaders, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Kopfzeilen, die der jeweilige Server selbst setzt, zählen nicht; Content-Length nur, wenn PHP sie selbst setzt
const IGNORE = new Set(['date', 'connection', 'keep-alive', 'x-powered-by', 'transfer-encoding', 'host']);
function headerList(raw: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 2) if (!IGNORE.has(raw[i].toLowerCase())) out.push(raw[i].toLowerCase() + ': ' + raw[i + 1]);
  return out;
}

test('serving uploads matches PHP byte for byte (headers, ranges, 304, denied and missing files)', async () => {
  const dir = join(tmp, 'serve');
  makeUploads(dir);
  const big = Buffer.alloc(200000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7919) & 0xff;
  writeFileSync(join(dir, 'music_5_x.mp3'), big);
  for (const n of ['notes.txt', 'v.vcf', 'a.unknownext', 'UPPER.JPG', 'noext', 'evil.php', 'x.svg', 'x.HTML', 'x.Js', 'file.', 'per%cent.jpg', 'x..y.jpg',
    'a'.repeat(196) + '.jpg', 'a'.repeat(197) + '.jpg', 'pic.avif', 'clip.webm', 'doc.pdf', 's.m4a', 'arch.zip', 's.wav', 'x.phar', 'x.xml', 'x.mjs']) writeFileSync(join(dir, n), n);
  utimesSync(join(dir, 'notes.txt'), 1790000000, 1790000000);
  // Node liefert Dateien aus static/uploads im Code-Ordner zuerst selbst aus (wie Apache): dort darf nichts Gleichnamiges liegen
  const leftovers = readdirSync(dir).filter((n) => readdirSync(join(ROOT_DIR, 'static/uploads')).includes(n));
  assert.deepEqual(leftovers, [], 'remove these leftovers from static/uploads in the code folder first');
  const config = { ...BASE, uploads_dir: dir };
  const php = await startPhpServer(18103, config);
  setConfigForTests(config);
  const app = await buildServer();
  await app.listen({ port: 13103, host: '127.0.0.1' });
  const paths = ['notes.txt', 'empty.txt', 'legacy%20name.png', 'legacy name.png'.replace(' ', '%20'), '%C3%BCmlaut_5_1.png', 'raw%FF_5_x.png', 'v.vcf',
    'a.unknownext', 'UPPER.JPG', 'noext', 'evil.php', 'x.svg', 'x.HTML', 'x.Js', 'file.', 'sub_5_dir', 'link_5_x.png', 'broken_5_x.png',
    'a'.repeat(196) + '.jpg', 'a'.repeat(197) + '.jpg', 'x..y.jpg', 'per%25cent.jpg', 'per%cent.jpg', 'missing.jpg', '', '%2e%2e%2fconfig.php',
    '%00.jpg', 'notes.txt?x=1', 'notes.txt/', '/notes.txt', 'notes%252Etxt', 'pic.avif', 'clip.webm', 'doc.pdf', 's.m4a', 'arch.zip', 's.wav', 'x.phar',
    'x.xml', 'x.mjs', 'music_5_x.mp3', 'Zebra.png', 'zebra.png', '%5Cnotes.txt', 'notes.txt%00', 'per%2',
    // Aus dem Ordner heraus zu einer nicht gesperrten Datei: wie PHP 404
    '%2e%2e%2f%2e%2e%2findex.php', '%2E%2E/%2E%2E/README.md', '..%2F..%2Fconfig.json'];
  const reqs: Array<[string, string, Record<string, string>]> = [];
  for (const p of paths) reqs.push(['GET', '/static/uploads/' + p, {}]);
  for (const p of ['notes.txt', 'empty.txt', 'missing.jpg', 'evil.php', 'music_5_x.mp3']) reqs.push(['HEAD', '/static/uploads/' + p, {}], ['POST', '/static/uploads/' + p, {}]);
  for (const r of ['bytes=0-99', 'bytes=100-', 'bytes=-500', 'bytes=199990-300000', 'bytes=200000-', 'bytes=199999-', 'bytes=0-0', 'bytes=-0', 'bytes=5-4',
    'bytes=-300000', 'bytes=abc', 'bytes=0-1,5-6', 'bytes=', 'bytes=-', 'Bytes=0-1', 'bytes=99999999999999999999-', 'bytes=-99999999999999999999',
    'bytes=0-99999999999999999999', 'bytes=65535-65537', 'bytes=1-199999']) {
    reqs.push(['GET', '/static/uploads/music_5_x.mp3', { Range: r }], ['HEAD', '/static/uploads/music_5_x.mp3', { Range: r }]);
  }
  for (const r of ['bytes=0-', 'bytes=-1']) reqs.push(['GET', '/static/uploads/empty.txt', { Range: r }]);
  const mismatches: unknown[] = [];
  let compared = 0;
  try {
    for (const [method, path, headers] of reqs) {
      const variants: Array<Record<string, string>> = [headers];
      const first = await request(18103, method, path, headers);
      const ei = first.headers.findIndex((x, i) => i % 2 === 0 && x.toLowerCase() === 'etag');
      if (ei >= 0 && method === 'GET' && !headers.Range) {
        const etag = first.headers[ei + 1];
        variants.push({ 'If-None-Match': etag }, { 'If-None-Match': 'W/' + etag }, { 'If-None-Match': '"x", ' + etag }, { Range: 'bytes=0-1', 'If-None-Match': etag });
      }
      for (const h of variants) {
        const p = await request(18103, method, path, h);
        const n = await request(13103, method, path, h);
        const ph = headerList(p.headers);
        let nh = headerList(n.headers);
        if (!ph.some((x) => x.startsWith('content-length:'))) nh = nh.filter((x) => !x.startsWith('content-length:'));
        compared++;
        // Bekannt: der Router von Node sperrt Pfade mit einem Abschnitt, der mit einem Punkt beginnt, vorher mit 403
        // (web/static.ts: isDenied) – PHP antwortet hier 404
        if (path.includes('/..%2F')) continue;
        // Bekannt: static/uploads/.htaccess sperrt Skripte, HTML und SVG schon über den Namen – im Betrieb antwortet Apache
        // 403, auch wenn die Datei fehlt (Node genauso, web/static.ts). php -S kennt keine .htaccess: oys_serve_upload() → 404
        if (!path.includes('%') && /^\/static\/uploads\/[^/]*\.(php[0-9]?|phtml|phar|pl|py|cgi|sh|html?|svg|js)$/.test(path)) {
          if (n.status !== 403) mismatches.push({ method, path, h, expected: 403, node: n.status });
          continue;
        }
        if (p.status !== n.status || JSON.stringify(ph) !== JSON.stringify(nh) || !p.body.equals(n.body)) {
          mismatches.push({ method, path: path.slice(0, 80), h, php: [p.status, ph, p.body.length], node: [n.status, nh, n.body.length] });
        }
      }
    }
    // Dekodierte ../ zu gesperrten Dateien (config.json enthält alle Schlüssel): Node sperrt wie Apache nach dem Bereinigen
    // des Pfads mit 403 (web/static.ts) – php -S ohne diese Regeln kommt bis oys_serve_upload() und antwortet 404
    for (const path of ['/static/%2e%2e/config.json', '/static/%2E%2E/config.json', '/static/css/%2e%2e/%2e%2e/config.json',
      '/static/uploads/%2E%2E%2F%2E%2E%2Fconfig.json', '/static/uploads/%2e%2e%2f%2e%2e%2fconfig.json', '/static/uploads/%2e%2e/%2e%2e/config.json',
      '/static/uploads/%2E%2E/%2E%2E/config.php', '/static/%2e%2e/lib/storage.php', '/static/uploads/%2e%2e/%2e%2e/.git/config']) {
      const n = await request(13103, 'GET', path);
      assert.deepEqual([n.status, n.body.toString('latin1')], [403, 'Forbidden'], path);
    }
  } finally {
    await app.close();
    await php.stop();
    setConfigForTests(BASE);
  }
  assert.deepEqual(mismatches, []);
  assert.ok(compared > 150);
  assert.equal(statSync(join(dir, 'notes.txt')).mtimeMs, 1790000000 * 1000);
});
