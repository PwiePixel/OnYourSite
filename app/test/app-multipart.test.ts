// multipart/form-data wie PHP (web/multipart.ts ↔ main/rfc1867.c): $_POST, $_FILES (mit MD5 des Inhalts statt tmp_name)
// und ob php://input leer bleibt – gegen PHPs eingebauten Server mit den Einstellungen des eigenen Servers. Feste Fälle
// (Feldnamen, max_file_uploads, MAX_FILE_SIZE, abgebrochene Inhalte, Kopfzeilen) und zufällig erzeugte Inhalte.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { phpMultipart } from '../src/web/multipart.js';
import { readBody } from '../src/server.js';
import { makeTestCtx } from '../src/web/ctx.js';
import type { PhpArray, PhpValue } from '../src/php.js';

const UPLOAD_MAX = 16 * 1024 * 1024;
const DUMP = `<?php
function s($v) { if (is_array($v)) { $o = []; foreach ($v as $k => $x) { $o[(string) $k] = s($x); } return $o; } return (string) $v; }
function t($v) { if (is_array($v)) { $o = []; foreach ($v as $k => $x) { $o[(string) $k] = t($x); } return $o; } return $v === '' ? '' : md5_file($v); }
$files = [];
foreach ($_FILES as $k => $f) { $files[(string) $k] = s($f); if (isset($f['tmp_name'])) { $files[(string) $k]['tmp_name'] = t($f['tmp_name']); } }
header('Content-Type: application/json');
echo json_encode(['files' => $files, 'post' => s($_POST), 'input' => strlen(file_get_contents('php://input'))], JSON_FORCE_OBJECT | JSON_INVALID_UTF8_SUBSTITUTE);
`;

let php: ChildProcess | null = null;
let dir = '';
let phpPort = 0;
after(() => {
  php?.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

function post(port: number, type: string, body: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/d.php', method: 'POST', agent: false, headers: { 'Content-Type': type, 'Content-Length': body.length } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function startPhp(): Promise<number> {
  if (phpPort) return phpPort;
  dir = mkdtempSync(join(tmpdir(), 'oys-multipart-'));
  writeFileSync(join(dir, 'd.php'), DUMP);
  const port = await freePort();
  php = spawn('php', ['-d', 'upload_max_filesize=16M', '-d', 'post_max_size=20M', '-d', 'display_errors=0', '-S', `127.0.0.1:${port}`, '-t', dir],
    { stdio: 'ignore' });
  for (let i = 0; ; i++) {
    try {
      await post(port, 'text/plain', Buffer.alloc(0));
      phpPort = port;
      return port;
    } catch (err) {
      if (i > 100) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

// Gleiche Form wie die PHP-Ausgabe: alle Werte Text, tmp_name als MD5 des Inhalts, Schlüssel sortiert
function canon(v: unknown): unknown {
  if (typeof v !== 'object' || v === null) return v;
  return Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, canon(x)]).sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1));
}
function nodeResult(type: string, body: Buffer): unknown {
  const form = phpMultipart(type, body, UPLOAD_MAX);
  const md5 = (v: PhpValue): PhpValue => (typeof v === 'string'
    ? (v === '' ? '' : createHash('md5').update(form?.uploads.get(v) ?? Buffer.alloc(0)).digest('hex'))
    : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, md5(x)])));
  const files: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(form?.filesVars ?? {})) {
    const entry = { ...(f as PhpArray) };
    if (entry.tmp_name !== undefined) entry.tmp_name = md5(entry.tmp_name);
    Object.defineProperty(files, k, { value: entry, enumerable: true, configurable: true, writable: true });
  }
  return canon({ files, post: form?.post ?? {}, input: form ? 0 : body.length });
}

// Unterschiedliche Stellen (Pfad: PHP ≠ Node) für eine lesbare Meldung
function diffs(a: unknown, b: unknown, path = ''): string[] {
  const map = (v: unknown): Map<string, unknown> | null => (Array.isArray(v) && v.every((x) => Array.isArray(x) && x.length === 2) ? new Map(v as Array<[string, unknown]>) : null);
  const ma = map(a);
  const mb = map(b);
  if (!ma || !mb) return JSON.stringify(a) === JSON.stringify(b) ? [] : [`${path}: ${JSON.stringify(a)?.slice(0, 120)} ≠ ${JSON.stringify(b)?.slice(0, 120)}`];
  const out: string[] = [];
  for (const k of new Set([...ma.keys(), ...mb.keys()])) out.push(...diffs(ma.get(k), mb.get(k), path + '/' + k));
  return out;
}

async function compare(port: number, cases: Array<[string, string, Buffer]>): Promise<unknown[]> {
  const bad: unknown[] = [];
  for (const [label, type, body] of cases) {
    const ref = canon(JSON.parse(await post(port, type, body)));
    const mine = nodeResult(type, body);
    if (JSON.stringify(ref) !== JSON.stringify(mine)) bad.push({ label, diff: diffs(ref, mine).slice(0, 4), body: JSON.stringify(body.toString('latin1').slice(0, 400)) });
  }
  return bad;
}

const B = 'XyZ';
const TYPE = `multipart/form-data; boundary=${B}`;
const field = (name: string, value = 'v') => `--${B}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
const file = (name: string, data = 'DATA', filename = 'a.png', type: string | null = 'image/png') =>
  `--${B}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\n${type === null ? '' : `Content-Type: ${type}\r\n`}\r\n${data}\r\n`;
const raw = (headers: string, data = 'DATA') => `--${B}\r\n${headers}\r\n\r\n${data}\r\n`;
const end = `--${B}--\r\n`;
const many = (n: number, mk: (i: number) => string) => Array.from({ length: n }, (_, i) => mk(i)).join('');

// Feste Fälle: was der Editor-Upload (/dashboard/api/upload) erreichen kann
const FIXED: Array<[string, string, string]> = [
  ['normal', TYPE, field('kind', 'image') + file('file') + end],
  ['leading spaces in name', TYPE, file(' file') + file('  other') + end],
  ['dot and space in name', TYPE, file('fi.le') + file('fi le') + file('.x') + end],
  ['array upload', TYPE, file('file[]') + file('file[]', 'B') + end],
  ['nested array upload', TYPE, file('file[a][b]') + file('a[b][]') + end],
  ['open bracket skips this and later files', TYPE, file('file[') + file('file') + field('kind', 'x') + end],
  ['text after ] skips', TYPE, file('file[a]b') + file('file') + end],
  ['] only skips', TYPE, file('file]') + file('file') + end],
  ['nested brackets skip', TYPE, file('file[a[b]]') + file('file') + end],
  ['leading bracket', TYPE, file('[file]') + file('file') + end],
  ['empty and space names', TYPE, file('') + file(' ') + file('file') + end],
  ['skipped file keeps fields', TYPE, field('a', '1') + file('x]') + field('b', '2') + file('file') + end],
  ['21 files', TYPE, many(20, (i) => file('f' + i)) + file('file') + end],
  ['20 files', TYPE, many(19, (i) => file('f' + i)) + file('file') + end],
  ['20 empty filenames do not count', TYPE, many(20, (i) => file('f' + i, '', '')) + file('file') + end],
  ['20 empty files count', TYPE, many(20, (i) => file('f' + i, '')) + file('file') + end],
  ['21 files with fields between', TYPE, many(20, (i) => field('x' + i) + file('f' + i)) + field('kind') + file('file') + end],
  ['same name twice, last wins', TYPE, file('file', 'ONE') + file('file', 'TWO', 'b.gif', 'image/gif') + end],
  ['single then array', TYPE, file('file', 'ONE') + file('file[]', 'TWO') + end],
  ['array then single', TYPE, file('file[]', 'ONE') + file('file', 'TWO') + end],
  ['MAX_FILE_SIZE smaller', TYPE, field('MAX_FILE_SIZE', '3') + file('file') + end],
  ['MAX_FILE_SIZE equal', TYPE, field('MAX_FILE_SIZE', '4') + file('file') + end],
  ['MAX_FILE_SIZE lowercase and spaces', TYPE, field('max_file_size', ' 2xyz') + file('file') + end],
  ['MAX_FILE_SIZE negative', TYPE, field('MAX_FILE_SIZE', '-1') + file('file') + file('empty', '') + end],
  ['MAX_FILE_SIZE after the file', TYPE, file('file') + field('MAX_FILE_SIZE', '1') + end],
  ['MAX_FILE_SIZE huge', TYPE, field('MAX_FILE_SIZE', '999999999999999999999999') + file('file') + end],
  ['field then file of the same name', TYPE, field('file', 'x') + file('file') + end],
  ['file then field of the same name (protected)', TYPE, file('file') + field('file', 'x') + field('file[tmp_name]', 'y') + field(' file', 'z') + end],
  ['empty filename', TYPE, file('file', 'IGNORED', '') + end],
  ['empty filename without type', TYPE, file('file', '', '', null) + end],
  ['no filename but octet-stream type', TYPE, raw('Content-Disposition: form-data; name="file"\r\nContent-Type: application/octet-stream') + end],
  ['field with octet-stream type', TYPE, raw('Content-Disposition: form-data; name="kind"\r\nContent-Type: application/octet-stream', 'avatar') + end],
  ['filename* only', TYPE, raw('Content-Disposition: form-data; name="file"; filename*=UTF-8\'\'b.png\r\nContent-Type: image/png') + end],
  ['filename* and filename', TYPE, raw('Content-Disposition: form-data; name="file"; filename="a.txt"; filename*=UTF-8\'\'b.png\r\nContent-Type: image/png') + end],
  ['filename . and ..', TYPE, file('a', 'D', '.') + file('b', 'D', '..') + file('c', 'D', 'x/..') + end],
  ['filename with paths', TYPE, file('a', 'D', 'a/') + file('b', 'D', 'a\\\\b\\\\c.png') + file('c', 'D', 'C:\\\\fake\\\\p.png') + file('d', 'D', 'dir/sub/p.png') + end],
  ['escapes in quoted values', TYPE, raw('Content-Disposition: form-data; name="fi\\"le"; filename="a\\\\b\\"c.png"') + raw("Content-Disposition: form-data; name='q'; filename='x\\'y.png'") + end],
  ['unquoted values', TYPE, raw('Content-Disposition: form-data; name=file; filename=b.png') + raw('Content-Disposition: form-data; name=a\\\\b c') + end],
  ['upper case keys and no space', TYPE, raw('Content-Disposition: form-data;NAME="file";FILENAME="b.png"') + end],
  ['spaces around =', TYPE, raw('Content-Disposition: form-data; name ="a"; name= "b"') + end],
  ['attachment disposition', TYPE, raw('Content-Disposition: attachment; name="file"; filename="b.png"\r\nContent-Type: image/png') + end],
  ['no disposition', TYPE, raw('Content-Type: image/png') + file('file') + end],
  ['no name, no filename (garbled stops all)', TYPE, field('a') + raw('Content-Disposition: form-data; x="y"') + field('b') + end],
  ['anonymous file', TYPE, raw('Content-Disposition: form-data; filename="b.png"\r\nContent-Type: image/png') + end],
  ['header continuation and junk', TYPE, `--${B}\r\njunk\r\nContent-Disposition: form-data;\r\n name="cont"\r\nX-A: b\r\n\r\nv\r\n` + end],
  ['header key with trailing space', TYPE, `--${B}\r\nContent-Disposition : form-data; name="a"\r\n\r\nv\r\n` + field('b') + end],
  ['type with parameters and spaces', TYPE, file('a', 'D', 'a.png', 'IMAGE/PNG ; charset=x') + file('b', 'D', 'b.png', '') + end],
  ['type on a continuation line', TYPE, `--${B}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type:\r\n image/png\r\n\r\nD\r\n` + end],
  ['no closing boundary', TYPE, field('kind', 'image') + file('file')],
  ['cut in the data', TYPE, field('kind', 'image') + file('file').slice(0, -6)],
  ['cut after the headers', TYPE, `--${B}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n`],
  ['cut in a field', TYPE, `--${B}\r\nContent-Disposition: form-data; name="a"\r\n\r\nval`],
  ['LF only', TYPE, `--${B}\nContent-Disposition: form-data; name="a"\n\nv1\n--${B}\nContent-Disposition: form-data; name="file"; filename="x.png"\n\nD\n--${B}--\n`],
  ['boundary text inside data', TYPE, file('file', `x\r\n--${B}X\r\nmore`) + field('a') + end],
  ['boundary prefix inside data', TYPE, file('file', `x\n--${B}`) + field('a') + end],
  ['CR LF CR before boundary', TYPE, file('file', 'x\r\n\r') + end],
  ['preamble and epilogue', TYPE, 'preamble\r\nmore\r\n' + field('a') + end + 'epilogue\r\n' + field('b')],
  ['boundary line with trailing space', TYPE, `--${B} \r\n` + field('a') + end],
  ['NUL in names', TYPE, field('a\0b') + file('f\0g') + end],
  ['proto names', TYPE, field('__proto__', 'x') + field('constructor[a]', 'y') + file('__proto__') + file('toString[]') + end],
  ['empty body', TYPE, ''],
  ['empty boundary', 'multipart/form-data; boundary=', `--\r\nContent-Disposition: form-data; name="a"\r\n\r\nv\r\n----\r\n`],
  ['quoted empty boundary', 'multipart/form-data; boundary=""', field('a') + end],
  ['unterminated quoted boundary', 'multipart/form-data; boundary="XyZ', field('a') + end],
  ['no boundary', 'multipart/form-data', field('a') + end],
  ['boundary keyword without =', 'multipart/form-data; boundary', field('a') + end],
  ['boundary with spaces', 'multipart/form-data; boundary= XyZ ;x', `-- XyZ \r\nContent-Disposition: form-data; name="a"\r\n\r\nv\r\n-- XyZ --\r\n`],
  ['upper case type and key', 'MULTIPART/FORM-DATA; BOUNDARY=XyZ', field('a') + end],
  ['json in the type', `multipart/form-data; boundary=${B}; x=application/json`, field('a') + file('file') + end],
  ['long header line', TYPE, raw(`Content-Disposition: form-data; name="file"; filename="${'n'.repeat(6000)}.png"\r\nContent-Type: image/png`) + end],
  ['long header line with colon', TYPE, raw(`Content-Disposition: form-data; name="file"; filename="${'n'.repeat(5100)}:x.png"`) + end],
  ['field over 1 MB', TYPE, field('big', 'y'.repeat(1100000)) + end],
  ['long field name', TYPE, field('n'.repeat(150), 'v') + end],
  ['file over the buffer with CR LF at the seams', TYPE, file('file', 'ab\r\n'.repeat(4000) + '\r') + end],
  // Zeilen über 5 KB liefert get_line() in Stücken von 5120 Bytes: die Grenze zählt nur am Anfang eines Stücks
  ['boundary as the second piece of a long line', TYPE, 'q'.repeat(5120) + field('a') + end],
  ['boundary one byte before a piece start', TYPE, 'q'.repeat(5119) + field('a') + field('b') + end],
  ['boundary one byte after a piece start', TYPE, 'q'.repeat(5121) + field('a') + field('b') + end],
  ['boundary as the third piece', TYPE, 'q'.repeat(10240) + field('a') + end],
  ['long line ending in CR before the boundary piece', TYPE, 'q'.repeat(5119) + '\r' + field('a') + end],
  ['boundary followed by NUL', TYPE, `--${B}\0junk\r\nContent-Disposition: form-data; name="a"\r\n\r\nv\r\n` + end],
  ['boundary text in the middle of a line', TYPE, `x--${B}\r\n` + field('a') + end],
  ['boundary at the end without LF', TYPE, field('a') + `--${B}`],
  ['long boundary-only line at the end', TYPE, field('a') + `--${B}` + 'z'.repeat(6000)],
  ['after a cancelled file, boundary text on a piece start', TYPE, field('MAX_FILE_SIZE', '1') + file('file', 'q'.repeat(12000) + `\n--${B}x` + 'w'.repeat(5000) + `--${B}`) + field('b') + end],
  ['after a cancelled file, boundary text mid-line', TYPE, field('MAX_FILE_SIZE', '1') + file('file', 'q'.repeat(7000) + `--${B}\r\n` + 'w'.repeat(100)) + field('b') + end],
  ['after a too large file the rest is skipped by lines', TYPE, field('MAX_FILE_SIZE', '10') + file('file', ('line\r\n'.repeat(3000)) + `--${B}\r\nContent-Disposition: form-data; name="inner"\r\n\r\nx`) + field('b') + end],
];

test('multipart bodies are read like PHP (rfc1867): fixed cases', async () => {
  const port = await startPhp();
  const cases: Array<[string, string, Buffer]> = FIXED.map(([label, type, body]) => [label, type, Buffer.from(body, 'latin1')]);
  // ein Upload über upload_max_filesize (16M) und einer knapp darunter
  cases.push(['too large', TYPE, Buffer.from(file('file', 'z'.repeat(UPLOAD_MAX + 1)) + file('after') + end, 'latin1')]);
  cases.push(['just small enough', TYPE, Buffer.from(file('file', 'z'.repeat(UPLOAD_MAX)) + end, 'latin1')]);
  assert.deepEqual(await compare(port, cases), []);
});

// Zufällige Inhalte (fester Startwert): Namen mit Klammern, Punkten, Leerzeichen; Dateien und Felder gemischt,
// MAX_FILE_SIZE, viele Dateien, LF statt CR LF, lange Daten über die Puffergrenze, abgeschnittene Enden
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('multipart bodies are read like PHP (rfc1867): random bodies', async () => {
  const port = await startPhp();
  // Mehr Fälle bzw. andere Startwerte: OYS_FUZZ_SEED=… OYS_FUZZ_COUNT=… npm test
  const rand = rng(Number(process.env.OYS_FUZZ_SEED) || 20261101);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rand() * a.length)];
  const NAMES = ['file', ' file', 'file[]', 'file[a]', 'file[', 'file]', 'file[a]b', 'a.b', 'a b', 'kind', 'x[y][z]', '[x]', '', 'file[tmp_name]',
    'f[ ]', 'f[\t]', 'f[]x', 'f[a][]', 'MAX_FILE_SIZE', 'max_file_size', 'page_id', 'ü', 'a[b[c]]', 'a]b', 'z[', '0', '5[]'];
  const FILES = ['a.png', '', 'b.gif', 'x/y.png', '..', 'C:\\\\p\\\\q.jpg', 'ü.png', 'a"b.png'];
  const TYPES = ['image/png', 'application/octet-stream', '', 'text/plain; charset=utf-8', null];
  const SIZES = ['0', '1', '5', '20', '-1', ' 3', '6000', 'abc'];
  const chunk = (): string => {
    const r = rand();
    if (r < 0.15) return '';
    if (r < 0.2) return 'q'.repeat(5000 + Math.floor(rand() * 400)) + pick(['\r', '\n', '\r\n', '-', '']);
    // Grenze an (oder neben) einem Vielfachen von 5120 Bytes in einer langen Zeile
    if (r < 0.24) return 'q'.repeat(5120 * (1 + Math.floor(rand() * 2)) + Math.floor(rand() * 5) - 2) + `--${B}` + pick(['', '\r\n', '\n', '\0', 'x', '--']);
    let s = '';
    const n = Math.floor(rand() * 30);
    for (let i = 0; i < n; i++) s += pick(['a', 'b', '\r', '\n', '\r\n', '-', '--', `--${B}`, ' ', 'Z']);
    return s;
  };
  const cases: Array<[string, string, Buffer]> = [];
  for (let c = 0; c < (Number(process.env.OYS_FUZZ_COUNT) || 400); c++) {
    const nl = rand() < 0.1 ? '\n' : '\r\n';
    let body = rand() < 0.1 ? 'pre' + nl : '';
    const parts = Math.floor(rand() * (rand() < 0.15 ? 26 : 6));
    for (let p = 0; p < parts; p++) {
      const name = pick(NAMES);
      body += `--${B}${nl}`;
      const isFile = rand() < 0.6;
      if (rand() < 0.05) body += `X-Junk: 1${nl}`;
      if (isFile) {
        const fn = pick(FILES);
        body += `Content-Disposition: form-data; name="${name}"; filename="${fn}"${nl}`;
        const type = pick(TYPES);
        if (type !== null) body += `Content-Type: ${type}${nl}`;
        body += nl + chunk() + nl;
      } else {
        body += `Content-Disposition: form-data; name="${name}"${nl}${nl}`;
        body += (/max_file_size/i.test(name) ? pick(SIZES) : chunk()) + nl;
      }
    }
    const tail = rand();
    if (tail < 0.8) body += `--${B}--${nl}`;
    else if (tail < 0.9) body = body.slice(0, Math.floor(rand() * body.length));
    cases.push([`random ${c}`, TYPE, Buffer.from(body, 'latin1')]);
  }
  assert.deepEqual(await compare(port, cases), []);
});

test('readBody empties php://input only when PHP reads the multipart body itself', async () => {
  const body = Buffer.from(field('a') + end, 'latin1');
  for (const [type, consumed] of [[TYPE, true], ['multipart/form-data; boundary=', true], ['multipart/form-data', false], ['multipart/form-data; boundary="x', false],
    ['application/json', false], ['multipart/mixed; boundary=XyZ', false]] as Array<[string, boolean]>) {
    const ctx = makeTestCtx({ method: 'POST', url: '/', headers: { 'content-type': type }, rawBody: body });
    await readBody(ctx, type, body);
    assert.equal(ctx.rawBody.length, consumed ? 0 : body.length, type);
  }
});

// Das Formular liest der Server vor jeder Anmeldung: auch feindliche 20 MB dürfen nicht quadratisch lange brauchen
// (eine Grenze aus 8000 gleichen Zeichen mit fast passenden Stellen dauerte mit indexOf() fast zwei Minuten)
test('hostile multipart bodies are read in linear time', () => {
  const n = 20 * 1024 * 1024 - 65536;
  const long = 'q'.repeat(8000);
  const cases: Array<[string, string]> = [
    [`multipart/form-data; boundary=${long}`, `--${long}\r\nContent-Disposition: form-data; name="file"; filename="a"\r\n\r\n${('\n--' + 'q'.repeat(7990) + 'X').repeat(2500)}\r\n--${long}--\r\n`],
    [`multipart/form-data; boundary=${'-'.repeat(300)}`, '-'.repeat(n)],
    [TYPE, `--${B}\r\nContent-Disposition: form-data; name="${'\\"'.repeat(n / 2)}"\r\n\r\nD\r\n` + end],
    [TYPE, `--${B}\r\nContent-Disposition: form-data; name="a"; filename="${'z'.repeat(n)}"\r\n\r\nD\r\n` + end],
    [TYPE, `--${B}\r\n${'X-A: b\r\n'.repeat(n / 8)}Content-Disposition: form-data; name="a"\r\n\r\nv\r\n` + end],
    [TYPE, '\n'.repeat(n)],
  ];
  for (const [type, body] of cases) {
    const t = performance.now();
    phpMultipart(type, Buffer.from(body, 'latin1'), UPLOAD_MAX);
    const ms = performance.now() - t;
    assert.ok(ms < 5000, `${type.slice(0, 60)}: ${Math.round(ms)} ms`);
  }
});
