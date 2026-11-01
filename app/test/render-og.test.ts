// Vorschaubilder gegen PHP (lib/share.php mit GD): Textbreiten wie imagettfbbox, Umbrüche und Kürzungen wie
// oys_og_wrap/oys_og_fit, Farben, das fertige PNG (Größe, Format, Pixel) und die Auslieferung unter /_/og/ mit
// Zwischenspeicher, Aufräumen und Kopfzeilen – PHP läuft dafür als echter Server (php -S mit index.php).
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import sharp from 'sharp';
import { ROOT_DIR } from '../src/config.js';
import { closePool, one } from '../src/db.js';
import { makeTestCtx, isHalt } from '../src/web/ctx.js';
import { ogClean, ogContrast, ogFit, ogFont, ogHash, ogMix, ogRender, ogRgb, ogServe, ogWidth, ogWrap } from '../src/content/share.js';
import { themes } from '../src/content/themes.js';
import { uploadsDir } from '../src/content/storage.js';
import { jsonDecode } from '../src/content/util.js';
import { jsonText, rng, runPhp } from './modelHarness.js';

after(() => closePool());

const php = (body: string, input: unknown): unknown[] => JSON.parse(runPhp(`$out = []; ${body} echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);`, jsonText(input))) as unknown[];

// Namen und Texte, wie sie auf Karten landen: Sprachen, Bindestriche, lange Wörter, Emoji, Zeichen ohne Glyphe
const FIRST = ['Mia', 'Tom', 'Lea', 'Jürgen', 'Zoë', 'François', 'Łukasz', 'Søren', 'Αλέξανδρος', 'Анастасия', 'محمد', 'שירה', '陈', 'Ngọc', 'Ólafur', 'Ñandú', 'Pixel', 'DJ', 'The'];
const LAST = ['Sommer', 'Müller', 'Weber', 'Wolfeschlegelsteinhausenbergerdorff', "O'Brien", 'van der Berg', 'Smith-Jones', 'Ødegård', 'Nguyễn', 'Иванова', '🎧', '& Co', '™', '(official)', '#1', '…', 'Ångström'];
const WORDS = ['Music', '&', 'livestreams', 'Photographer', 'based', 'in', 'Berlin', '–', 'every', 'Friday', 'from', '6', 'pm', 'Designer/Illustrator', 'https://example.com',
  'Café', 'naïve', 'résumé', 'straße', 'WWWWWWWWWWWW', 'iiiiiiiiiiiiiiii', '🐝', '✨', '&amp;', '&#65;', '&eacute;', 'fi', 'ﬁ', 'x́', ' ', 'Tab\there'];

function titles(seed: number, n: number): string[] {
  const r = rng(seed);
  const out = ['', 'Mia Sommer', 'A really long name that will never fit on one single line of the card', 'Wolfeschlegelsteinhausenbergerdorff',
    'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW', 'x', 'Art 🎨 & Design  ✨', '0', '   spaced    out   '];
  for (let i = 0; i < n; i++) {
    const k = r.next(3);
    if (k === 0) out.push(r.pick(FIRST) + ' ' + r.pick(LAST));
    else if (k === 1) out.push(Array.from({ length: 1 + r.next(14) }, () => r.pick([...WORDS, ...FIRST, ...LAST])).join(' '));
    else out.push(Array.from({ length: 2 + r.next(6) }, () => r.pick(FIRST)).join(r.pick([' ', '-', ' & ', ''])));
  }
  return out;
}

test('text widths match imagettfbbox for both fonts and every size the card uses', () => {
  const list = titles(1, 600).flatMap((t, i) => [[t, i % 2 === 0, [72, 68, 64, 60, 56, 52, 48, 164, 32, 30, 24][i % 11]]]) as Array<[string, boolean, number]>;
  const fonts = [ogFont(true), ogFont(false)];
  const expected = php('foreach ($in as [$s, $bold, $pt]) { $out[] = oys_og_width($s, oys_og_font($bold), $pt); }', list) as number[];
  const actual = list.map(([s, bold, pt]) => ogWidth(s, fonts[bold ? 0 : 1], pt));
  assert.deepEqual(actual.map((w, i) => (w === expected[i] ? '' : `${JSON.stringify(list[i])}: php ${expected[i]} node ${w}`)).filter(Boolean), []);
});

test('line breaks and shortening match oys_og_wrap/oys_og_fit for typical titles, subtitles and addresses', () => {
  const ts = titles(2, 400);
  const cases: Array<[string, boolean, number, number, number]> = [];
  for (const [i, t] of ts.entries()) {
    const size = [72, 68, 64, 60, 56, 52, 48][i % 7];
    cases.push([t, true, size, 654, 99], [t, true, size, 654, 2], [t, false, 32, 654, 2], [t, true, 30, 654, 1], [t, i % 2 === 0, 24 + (i % 50), 100 + (i % 600), 1 + (i % 3)]);
  }
  const expectWrap = php('foreach ($in as [$s, $bold, $pt, $w, $n]) { $out[] = oys_og_wrap($s, oys_og_font($bold), $pt, $w, $n); }', cases) as string[][];
  const expectFit = php('foreach ($in as [$s, $bold, $pt, $w, $n]) { $out[] = oys_og_fit($s, oys_og_font($bold), $pt, $w); }', cases) as string[];
  const bad: string[] = [];
  for (const [i, [s, bold, pt, w, n]] of cases.entries()) {
    const wrap = ogWrap(s, ogFont(bold), pt, w, n);
    const fit = ogFit(s, ogFont(bold), pt, w);
    if (JSON.stringify(wrap) !== JSON.stringify(expectWrap[i])) bad.push(`wrap ${JSON.stringify(cases[i])}: php ${JSON.stringify(expectWrap[i])} node ${JSON.stringify(wrap)}`);
    if (fit !== expectFit[i]) bad.push(`fit ${JSON.stringify(cases[i])}: php ${JSON.stringify(expectFit[i])} node ${JSON.stringify(fit)}`);
  }
  assert.deepEqual(bad.slice(0, 5), []);
  assert.ok(expectWrap.filter((l) => l.length === 2 && l[1].endsWith('…')).length > 50, 'long titles are shortened on the second line');
});

test('cleaning, colours, mixing and contrast match PHP', () => {
  const clean = ['', 'Art 🎨 & Design  ✨', ' a\tb\nc\r\nd ', ' nbsp em　', 'zero​width‏', 'var️sel', '﻿bom', 'tag\u{e0041}x', '☕ coffee ⭐', '🀄🃏',
    'ok', '0', 'a\u0085b', 'a᠎b', 'mixed \u{1F600}\u{1F64F}\u{1FAFF} end', '☀➿⬀⯿'];
  assert.deepEqual(clean.map(ogClean), php('foreach ($in as $s) { $out[] = oys_og_clean($s); }', clean));

  const hex = ['#aabbcc', 'AABBCC', '##aabbcc', '#aabbcc\n', '#abc', '#aabbccdd', '', '#GGGGGG', ' #aabbcc', '#AaBbCc', '#a1a1aa', ...Object.values(themes()).map((t) => t.accent)];
  assert.deepEqual(hex.map(ogRgb), php('foreach ($in as $s) { $out[] = oys_og_rgb($s); }', hex));

  const r = rng(5);
  const mixes: Array<[number[], number[], number]> = [];
  for (let a = 0; a < 256; a += 1) for (const [b, t] of [[0, 0.55], [255, 0.75], [0, 0.35]] as Array<[number, number]>) mixes.push([[a, 255 - a, (a * 7) % 256], [b, b, b], t]);
  for (let i = 0; i < 500; i++) mixes.push([[r.next(256), r.next(256), r.next(256)], [r.next(256), r.next(256), r.next(256)], r.next(1000) / 1000]);
  assert.deepEqual(mixes.map(([a, b, t]) => ogMix(a, b, t)), php('foreach ($in as [$a, $b, $t]) { $out[] = oys_og_mix($a, $b, (float) $t); }', mixes));

  // Kontrast: Schwelle 2.2 entscheidet über die Farbe der Adresse
  const pairs: Array<[number[], number[]]> = [];
  for (const t of Object.values(themes())) for (const base of [[11, 11, 15], [248, 248, 251]]) pairs.push([ogRgb(t.accent), base]);
  for (let i = 0; i < 3000; i++) pairs.push([[r.next(256), r.next(256), r.next(256)], r.chance(0.5) ? [11, 11, 15] : [248, 248, 251]]);
  const contrast = php('foreach ($in as [$a, $b]) { $out[] = oys_og_contrast($a, $b); }', pairs) as number[];
  const node = pairs.map(([a, b]) => ogContrast(a, b));
  assert.deepEqual(node.map((v) => v >= 2.2), contrast.map((v) => v >= 2.2));
  assert.ok(node.every((v, i) => Math.abs(v - contrast[i]) <= 1e-12 * contrast[i]), 'same values (up to the last bit of pow)');
});

// ---------------------------------------------------------------- Bilder

const UPLOADS = uploadsDir();
const AV = 'avatar_5_1700000000_ogtest';
const created: string[] = [];

async function makeImages(): Promise<void> {
  mkdirSync(UPLOADS, { recursive: true });
  const w = 400;
  const h = 260;
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = (x * 255) / w;
      rgba[i + 1] = (y * 255) / h;
      rgba[i + 2] = ((x + y) * 3) % 256;
      rgba[i + 3] = x < 40 ? 0 : x < 80 ? 128 : 255;
    }
  }
  const raw = { raw: { width: w, height: h, channels: 4 as const } };
  const files: Array<[string, Promise<Buffer>]> = [
    [AV + '1.webp', sharp(rgba, raw).webp({ quality: 80 }).toBuffer()],
    [AV + '2.png', sharp(rgba, raw).png().toBuffer()],
    [AV + '3.jpg', sharp(rgba, raw).flatten({ background: '#336699' }).jpeg({ quality: 85 }).toBuffer()],
    [AV + '4.gif', sharp(rgba, raw).gif().toBuffer()],
    [AV + '5.webp', sharp(rgba, raw).resize(120, 300).webp({ lossless: true }).toBuffer()],
    [AV + '6.png', sharp(rgba, raw).greyscale().png().toBuffer()],
  ];
  for (const [name, data] of files) {
    writeFileSync(UPLOADS + '/' + name, await data);
    created.push(name);
  }
  // Animiertes WebP (GD kann es nicht lesen), Text statt Bild, angeblich riesiges PNG
  const frames = Buffer.concat([rgba, Buffer.from(rgba.map((v, i) => (i % 4 === 3 ? 255 : 255 - v)))]);
  writeFileSync(UPLOADS + '/' + AV + '7.webp', await sharp(frames, { raw: { width: w, height: h * 2, channels: 4, pageHeight: h } }).webp({ loop: 0 }).toBuffer());
  writeFileSync(UPLOADS + '/' + AV + '8.png', 'not an image');
  const fake = await sharp(rgba, raw).png().toBuffer();
  fake.writeUInt32BE(9000, 16);
  fake.writeUInt32BE(5000, 20);
  writeFileSync(UPLOADS + '/' + AV + '9.png', fake);
  created.push(AV + '7.webp', AV + '8.png', AV + '9.png');
}

before(makeImages);
after(() => {
  for (const f of created) rmSync(UPLOADS + '/' + f, { force: true });
});

async function pixels(png: Buffer): Promise<{ data: Buffer; width: number; height: number; channels: number }> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function pngHeader(png: Buffer): { width: number; height: number; depth: number; colorType: number } {
  assert.equal(png.toString('latin1', 1, 4), 'PNG');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), depth: png[24], colorType: png[25] };
}

test('OG cards have the same size, format and picture as the GD version', async () => {
  const pages = [
    { id: 7, slug: 'mia', address_mode: 'subdomain', title: 'Mia Sommer', subtitle: 'Music & livestreams', bio: '', avatar: '', theme: 'galaxy', settings: '{}' },
    { id: 8, slug: 'tom', address_mode: 'path', title: 'A really long name that will never fit on one single line of the card', subtitle: '', bio: '\n\n0\nsecond', avatar: AV + '1.webp', theme: 'minimal', settings: '{"accent":"#ffffff","hide_branding":true}' },
    { id: 9, slug: 'zed', address_mode: 'subdomain', title: '', subtitle: '0', bio: 'Bio line\nnext', avatar: AV + '2.png', theme: 'sakura', settings: '{"accent":"#e75480"}' },
    { id: 10, slug: 'lea', address_mode: 'subdomain', title: 'Léa Ødegård 🎧', subtitle: 'Fotografin aus Köln – Hochzeiten & Porträts', bio: '', avatar: AV + '3.jpg', theme: 'noir', settings: '' },
    { id: 11, slug: 'gif', address_mode: 'subdomain', title: 'Gif', subtitle: '', bio: '', avatar: AV + '4.gif', theme: 'brutal', settings: '{"accent":"#000000"}' },
    { id: 12, slug: 'tall', address_mode: 'subdomain', title: 'Tall', subtitle: '', bio: '', avatar: AV + '5.webp', theme: 'retro', settings: '{}' },
    { id: 13, slug: 'grey', address_mode: 'subdomain', title: 'Grey', subtitle: '', bio: '', avatar: AV + '6.png', theme: 'cafe', settings: '{}' },
    { id: 14, slug: 'anim', address_mode: 'subdomain', title: 'Animated', subtitle: '', bio: '', avatar: AV + '7.webp', theme: 'ocean', settings: '{}' },
    { id: 15, slug: 'text', address_mode: 'subdomain', title: 'Not an image', subtitle: '', bio: '', avatar: AV + '8.png', theme: 'zen', settings: '{}' },
    { id: 16, slug: 'huge', address_mode: 'subdomain', title: 'Huge', subtitle: '', bio: '', avatar: AV + '9.png', theme: 'hacker', settings: '{}' },
    { id: 17, slug: 'gone', address_mode: 'subdomain', title: 'Missing', subtitle: '', bio: '', avatar: 'avatar_5_1_missing.webp', theme: 'unknown', settings: '{"accent":"#ff00aa"}' },
    { id: 18, slug: 'cjk', address_mode: 'subdomain', title: '陈静 東京', subtitle: 'Ελληνικά Кириллица', bio: '', avatar: '', theme: 'holo', settings: '{}' },
  ];
  const expected = (php('foreach ($in as $p) { $out[] = base64_encode(oys_og_render($p)); }', pages) as string[]).map((b) => Buffer.from(b, 'base64'));
  const problems: string[] = [];
  for (const [i, p] of pages.entries()) {
    const ours = await ogRender(jsonDecode(jsonText(p)) as object);
    assert.deepEqual(pngHeader(ours), pngHeader(expected[i]));
    assert.deepEqual(pngHeader(ours), { width: 1200, height: 630, depth: 8, colorType: 2 });
    const a = await pixels(expected[i]);
    const b = await pixels(ours);
    let differing = 0;
    let avatarDiff = 0;
    let max = 0;
    let squares = 0;
    for (let k = 0; k < 1200 * 630; k++) {
      let d = 0;
      for (let c = 0; c < 3; c++) {
        const x = a.data[k * a.channels + c] - b.data[k * b.channels + c];
        squares += x * x;
        d = Math.max(d, Math.abs(x));
      }
      if (!d) continue;
      differing++;
      max = Math.max(max, d);
      const x = k % 1200;
      const y = Math.floor(k / 1200);
      if (x >= 96 && x < 396 && y >= 165 && y < 465) avatarDiff++;
    }
    // Nur die Kantenglättung der Schrift weicht ab (FreeType ↔ Skia): wenige Pixel; Hintergrund, Ring und Fotos sind gleich
    const photo = created.includes(p.avatar) && ![AV + '7.webp', AV + '8.png', AV + '9.png'].includes(p.avatar);
    const psnr = squares ? 10 * Math.log10((255 * 255) / (squares / (1200 * 630 * 3))) : Infinity;
    if (differing > 1200 * 630 * 0.015 || psnr < 40) problems.push(`${p.slug}: ${differing} differing pixels (max ${max}), PSNR ${psnr.toFixed(1)} dB`);
    if (photo && avatarDiff > 0) problems.push(`${p.slug}: the photo avatar differs in ${avatarDiff} pixels`);
  }
  assert.deepEqual(problems, []);
});

// ---------------------------------------------------------------- /_/og/{id}-{hash}.png gegen PHP als Server

let server: ChildProcess | null = null;
let port = 0;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

async function startPhp(): Promise<void> {
  port = await freePort();
  server = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', ROOT_DIR, ROOT_DIR + '/index.php'], { cwd: ROOT_DIR, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise<boolean>((resolve) => {
      const c = net.connect(port, '127.0.0.1', () => {
        c.end();
        resolve(true);
      });
      c.on('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('php -S did not start');
}

after(() => {
  server?.kill();
});

interface Res { status: number; headers: Record<string, string>; body: Buffer }

function phpGet(path: string, method = 'GET'): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { Host: 'oys.test:8080' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const h: Record<string, string> = {};
        for (const k of ['content-type', 'content-length', 'cache-control', 'location']) if (res.headers[k] !== undefined) h[k] = String(res.headers[k]);
        resolve({ status: res.statusCode ?? 0, headers: h, body: Buffer.concat(chunks) });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function nodeGet(id: number, hash: string, method = 'GET'): Promise<Res> {
  const ctx = makeTestCtx({ method, url: `/_/og/${id}-${hash}.png` });
  try {
    await ogServe(ctx, id, hash);
  } catch (err) {
    if (!isHalt(err)) throw err;
  }
  const h: Record<string, string> = {};
  for (const [k, v] of ctx.headersOut()) if (['content-type', 'content-length', 'cache-control', 'location'].includes(k.toLowerCase())) h[k.toLowerCase()] = v;
  const body = Buffer.isBuffer(ctx.body) ? ctx.body : Buffer.from(String(ctx.body));
  return { status: ctx.status, headers: h, body: method === 'HEAD' ? Buffer.alloc(0) : body };
}

const OG_DIR = (): string => uploadsDir() + '/og';
const JUNK = ['aaaaaaaaaaaa.png', '.png', 'cccccccccccc.png.tmp'];

function prepareCache(id: number): void {
  rmSync(OG_DIR(), { recursive: true, force: true });
  mkdirSync(OG_DIR(), { recursive: true });
  for (const j of JUNK) writeFileSync(`${OG_DIR()}/${id}-${j}`, 'old');
  writeFileSync(`${OG_DIR()}/${id}0-bbbbbbbbbbbb.png`, 'other page');
  writeFileSync(`${OG_DIR()}/x${id}-a.png`, 'other');
}

const listCache = (): string[] => (existsSync(OG_DIR()) ? readdirSync(OG_DIR()).sort() : []);

test('/_/og/ serves, caches and cleans up like oys_og_serve (status, headers, files)', async () => {
  await startPhp();
  const page = (await one('SELECT * FROM pages WHERE id = 1'))!;
  const hash = ogHash(page);
  try {
    // Unbekannte Seite und alte Kennung
    for (const [id, h] of [[99999, hash], [1, '000000000000'], [1, hash === 'abcdefabcdef' ? '111111111111' : 'abcdefabcdef']] as Array<[number, string]>) {
      const a = await phpGet(`/_/og/${id}-${h}.png`);
      const b = await nodeGet(id, h);
      assert.deepEqual({ ...b, body: b.body.toString('latin1') }, { ...a, body: a.body.toString('latin1') }, `${id}-${h}`);
    }

    // Erster Abruf: Bild erzeugen, speichern, ältere Bilder dieser Seite löschen (andere Seiten bleiben)
    prepareCache(1);
    const a = await phpGet(`/_/og/1-${hash}.png`);
    const phpFiles = listCache();
    const phpCached = readFileSync(`${OG_DIR()}/1-${hash}.png`);
    prepareCache(1);
    const b = await nodeGet(1, hash);
    const nodeFiles = listCache();
    const nodeCached = readFileSync(`${OG_DIR()}/1-${hash}.png`);
    assert.deepEqual(nodeFiles, phpFiles);
    assert.deepEqual(phpFiles, ['1-cccccccccccc.png.tmp', `1-${hash}.png`, '10-bbbbbbbbbbbb.png', 'x1-a.png'].sort());
    assert.equal(a.status, 200);
    assert.deepEqual(Object.keys(b.headers).sort(), Object.keys(a.headers).sort());
    assert.equal(b.status, a.status);
    assert.equal(b.headers['content-type'], a.headers['content-type']);
    assert.equal(b.headers['cache-control'], a.headers['cache-control']);
    assert.equal(Number(a.headers['content-length']), a.body.length);
    assert.equal(Number(b.headers['content-length']), b.body.length);
    assert.ok(a.body.equals(phpCached) && b.body.equals(nodeCached), 'the response is the cached file');
    assert.deepEqual(pngHeader(b.body), pngHeader(a.body));

    // Weitere Abrufe kommen aus dem Zwischenspeicher – auch ein von PHP erzeugtes Bild in Node und umgekehrt
    writeFileSync(`${OG_DIR()}/1-${hash}.png`, phpCached);
    const fromNode = await nodeGet(1, hash);
    assert.ok(fromNode.body.equals(phpCached));
    assert.equal(fromNode.headers['content-length'], String(phpCached.length));
    writeFileSync(`${OG_DIR()}/1-${hash}.png`, nodeCached);
    const fromPhp = await phpGet(`/_/og/1-${hash}.png`);
    assert.ok(fromPhp.body.equals(nodeCached));
    const headPhp = await phpGet(`/_/og/1-${hash}.png`, 'HEAD');
    const headNode = await nodeGet(1, hash, 'HEAD');
    assert.deepEqual(headNode, headPhp);
  } finally {
    rmSync(OG_DIR(), { recursive: true, force: true });
  }
});
