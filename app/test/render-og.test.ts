// Vorschaubilder gegen PHP (lib/share.php mit GD, aus der PHP-Version – siehe support/phpRef.ts): Textbreiten wie
// imagettfbbox, Umbrüche und Kürzungen wie oys_og_wrap/oys_og_fit, Farben, das fertige PNG (Größe, Format, Pixel) und
// die Auslieferung unter /_/og/ mit Zwischenspeicher, Aufräumen und Kopfzeilen – PHP läuft dafür als echter Server
// (php -S mit index.php). Ohne PHP prüfen eigene Tests die Auslieferung und die Grenzen der Bilder in Node.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import http from 'node:http';
import net from 'node:net';
import sharp from 'sharp';
import { closePool, one } from '../src/db.js';
import { ensureSchema } from '../src/schema.js';
import { makeTestCtx, isHalt } from '../src/web/ctx.js';
import { ogClean, ogContrast, ogFit, ogFont, ogHash, ogLoadImage, ogMix, ogRender, ogRgb, ogServe, ogWidth, ogWrap } from '../src/content/share.js';
import { themes } from '../src/content/themes.js';
import { uploadsDir } from '../src/content/storage.js';
import { jsonDecode } from '../src/content/util.js';
import { jsonText, rng, runPhp } from './modelHarness.js';
import { PHP_SKIP, phpRoot } from './support/phpRef.js';
import { storedHidden } from './support/brandingParity.js';

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

test('text widths match imagettfbbox for both fonts and every size the card uses', { skip: PHP_SKIP }, () => {
  const list = titles(1, 600).flatMap((t, i) => [[t, i % 2 === 0, [72, 68, 64, 60, 56, 52, 48, 164, 32, 30, 24][i % 11]]]) as Array<[string, boolean, number]>;
  const fonts = [ogFont(true), ogFont(false)];
  const expected = php('foreach ($in as [$s, $bold, $pt]) { $out[] = oys_og_width($s, oys_og_font($bold), $pt); }', list) as number[];
  const actual = list.map(([s, bold, pt]) => ogWidth(s, fonts[bold ? 0 : 1], pt));
  assert.deepEqual(actual.map((w, i) => (w === expected[i] ? '' : `${JSON.stringify(list[i])}: php ${expected[i]} node ${w}`)).filter(Boolean), []);
});

test('line breaks and shortening match oys_og_wrap/oys_og_fit for typical titles, subtitles and addresses', { skip: PHP_SKIP }, () => {
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

test('cleaning, colours, mixing and contrast match PHP', { skip: PHP_SKIP }, () => {
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

test('OG cards have the same size, format and picture as the GD version', { skip: PHP_SKIP }, async () => {
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
    const ours = await ogRender(jsonDecode(jsonText(p)) as object, storedHidden(p));
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

// ---------------------------------------------------------------- GIF-Profilbilder wie imagecreatefromgif()

// GIFs werden beim Hochladen nicht umgewandelt (Animation bleibt) – GD liest davon nur das erste Einzelbild, in
// dessen eigener Größe. Varianten aus einem GD-GIF: Versatz und größere Fläche, Einzelbild außerhalb, andere Version,
// fremde Bytes und Erweiterungen vor dem Bild, eigene/fehlende Farbtabellen, durchsichtige Farbe, abgeschnittene Köpfe
const PHP_GIFS = `
  function gif_gd(int $w, int $h, bool $interlace): string {
    $im = imagecreate($w, $h);
    $bg = imagecolorallocate($im, 10, 200, 30);
    for ($i = 0; $i < 60; $i++) { $c = imagecolorallocate($im, ($i * 6) % 256, 255 - ($i * 4) % 256, ($i * 37) % 256); imagefilledrectangle($im, $i, ($i * 7) % $h, $i + 20, ($i * 7) % $h + 5, $c); }
    if ($interlace) { imagecolortransparent($im, $bg); imageinterlace($im, true); }
    ob_start(); imagegif($im); return ob_get_clean();
  }
  function gif_read(string $name): ?array {
    $img = oys_og_load_image($name);
    if (!$img) return null;
    $t = imagecolortransparent($img);
    $s = '';
    for ($y = 0; $y < imagesy($img); $y++) for ($x = 0; $x < imagesx($img); $x++) {
      $c = imagecolorat($img, $x, $y);
      if ($c === $t) { $s .= 'T,'; continue; }
      $k = imagecolorsforindex($img, $c);
      $s .= $k['red'] . ' ' . $k['green'] . ' ' . $k['blue'] . ',';
    }
    return [imagesx($img), imagesy($img), sha1($s)];
  }`;

function gifPixels(img: { width: number; height: number; px: Int32Array } | null): unknown {
  if (!img) return null;
  let s = '';
  for (const c of img.px) s += ((c >> 24) & 0x7f) === 127 ? 'T,' : `${(c >> 16) & 255} ${(c >> 8) & 255} ${c & 255},`;
  return [img.width, img.height, createHash('sha1').update(s).digest('hex')];
}

test('GIF avatars load like imagecreatefromgif: first frame in its own size, same failures and transparency', { skip: PHP_SKIP }, async () => {
  const base = (JSON.parse(runPhp(`${PHP_GIFS} echo json_encode([base64_encode(gif_gd(100, 80, false)), base64_encode(gif_gd(64, 48, true))]);`, '[]')) as string[])
    .map((x) => Buffer.from(x, 'base64'));
  const files = new Map<string, Buffer>();
  const at = (b: Buffer): number => 13 + (b[10] & 0x80 ? 3 * (2 << (b[10] & 7)) : 0);
  for (const [n, g] of base.entries()) {
    // Ende der globalen Farbtabelle und Beginn der Bildbeschreibung
    const plainEnd = at(g);
    const d = g.indexOf(0x2c, plainEnd);
    const cat = (...parts: Array<Buffer | string | number[]>): Buffer => Buffer.concat(parts.map((x) => (Buffer.isBuffer(x) ? x : typeof x === 'string' ? Buffer.from(x, 'latin1') : Buffer.from(x))));
    const set16 = (b: Buffer, pos: number, v: number): Buffer => {
      const c = Buffer.from(b);
      c.writeUInt16LE(v, pos);
      return c;
    };
    const w = g.readUInt16LE(6);
    const h = g.readUInt16LE(8);
    files.set(`${n}plain`, g);
    files.set(`${n}offset`, set16(set16(set16(set16(g, 6, w + 200), 8, h + 120), d + 1, 50), d + 3, 40));
    files.set(`${n}wide`, set16(g, 6, w + 200));
    files.set(`${n}outside`, set16(set16(g, d + 1, 10), d + 3, 10));
    files.set(`${n}v88a`, cat(g.subarray(0, 3), '88a', g.subarray(6)));
    files.set(`${n}v89a`, cat(g.subarray(0, 3), '89a', g.subarray(6)));
    files.set(`${n}junk`, cat(g.subarray(0, d), 'xyz', g.subarray(d)));
    files.set(`${n}comment`, cat(g.subarray(0, d), [0x21, 0xfe, 3, 0x61, 0x62, 0x63, 0], g.subarray(d)));
    files.set(`${n}gce`, cat(g.subarray(0, d), [0x21, 0xf9, 4, 1, 0, 0, 5, 0], g.subarray(d)));
    files.set(`${n}gce2`, cat(g.subarray(0, d), [0x21, 0xf9, 4, 1, 0, 0, 2, 0, 0x21, 0xf9, 4, 0, 0, 0, 7, 0], g.subarray(d)));
    files.set(`${n}gceshort`, cat(g.subarray(0, d), [0x21, 0xf9, 2, 1, 0, 0], g.subarray(d)));
    files.set(`${n}gceempty`, cat(g.subarray(0, d), [0x21, 0xf9, 0], g.subarray(d)));
    files.set(`${n}gcebare`, cat(g.subarray(0, d), [0x21, 0xf9], g.subarray(d)));
    files.set(`${n}term`, cat(g.subarray(0, d), ';', g.subarray(d)));
    files.set(`${n}width0`, set16(g, d + 5, 0));
    files.set(`${n}lzw13`, (() => { const c = Buffer.from(g); c[d + 10] = 13; return c; })());
    files.set(`${n}noglobal`, cat([...g.subarray(0, 10)], [g[10] & 0x7f], g.subarray(11, 13), g.subarray(plainEnd)));
    const local = Buffer.from(g);
    local[d + 9] |= 0x87;
    files.set(`${n}local`, cat(local.subarray(0, d + 10), Buffer.alloc(768, 0x7b), local.subarray(d + 10)));
    files.set(`${n}localshort`, cat(local.subarray(0, d + 10), Buffer.alloc(300, 0x7b)));
    for (const cut of [5, 12, plainEnd - 1, d + 9, d + 10]) files.set(`${n}cut${cut}`, g.subarray(0, cut));
    // Zufällige Köpfe: Version, Flächen- und Bildgröße, Versatz, Flags, Erweiterungen und fremde Bytes vor dem Bild
    // (nicht die LZW-Daten – kaputte Bilddaten liest GD auf seine eigene Weise)
    const r = rng(40 + n);
    for (let i = 0; i < 80; i++) {
      let c = Buffer.from(g);
      const k = r.next(7);
      if (k === 0) c.write(r.pick(['87a', '89a', '88a', '90a', '89b']), 3, 'latin1');
      else if (k === 1) c = set16(set16(c, 6, r.pick([0, 1, w - 1, w, w + 1, w + 99, 65535])), 8, r.pick([0, 1, h - 1, h, h + 1, h + 50, 65535]));
      else if (k === 2) c = set16(set16(set16(set16(c, d + 1, r.pick([0, 1, 2, 30])), d + 3, r.pick([0, 1, 2, 30])), 6, w + r.pick([0, 1, 30, 200])), 8, h + r.pick([0, 1, 30, 100]));
      else if (k === 3) c = cat(c.subarray(0, d), Array.from({ length: 1 + r.next(5) }, () => r.pick([0x00, 0x01, 0x21, 0x3b, 0x2b, 0xff, 0x2c])), c.subarray(d));
      else if (k === 4) c = cat(c.subarray(0, d), [0x21, r.pick([0xf9, 0xfe, 0xff, 0x01]), ...r.pick([[4, r.next(2), 0, 0, r.next(256), 0], [0], [1, 1, 0], [3, 1, 2, 3, 0], [2, 1, 9, 0, 0], [0, 4, 1, 0, 0, 3, 0]])], c.subarray(d));
      else if (k === 5) c[10] = r.next(256);
      else c[d + 9] = r.pick([0x00, 0x40, 0x80, 0x87, 0xc7, 0x81, 0x20]);
      files.set(`${n}fuzz${i}`, c);
    }
  }
  // Animiert (sharp): verschiedene Einzelbilder mit durchsichtigen Pixeln
  const fw = 60;
  const fh = 40;
  const frames = Buffer.alloc(fw * fh * 4 * 3);
  for (let f = 0; f < 3; f++) {
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        const i = ((f * fh + y) * fw + x) * 4;
        frames.set([(x * 4 + f * 80) & 255, (y * 6) & 255, f * 100, (x + y + f * 10) % 17 === 0 ? 0 : 255], i);
      }
    }
  }
  files.set('animated', await sharp(frames, { raw: { width: fw, height: fh * 3, channels: 4, pageHeight: fh } }).gif({ loop: 0 }).toBuffer());

  // Beide lesen dieselben Dateien aus dem Upload-Ordner (oys_og_load_image ↔ ogLoadImage, mit Größenprüfung)
  const names = [...files.keys()].map((k) => `avatar_5_1700000000_gif${k}.gif`);
  const bad: string[] = [];
  let expected: unknown[] = [];
  try {
    for (const [i, k] of [...files.keys()].entries()) writeFileSync(UPLOADS + '/' + names[i], files.get(k)!);
    expected = JSON.parse(runPhp(`${PHP_GIFS} $out = []; foreach ($in as $n) $out[] = gif_read($n); echo json_encode($out);`, JSON.stringify(names))) as unknown[];
    for (const [i, name] of names.entries()) {
      const got = gifPixels(await ogLoadImage(name));
      if (JSON.stringify(got) !== JSON.stringify(expected[i])) bad.push(`${name}: php ${JSON.stringify(expected[i])} node ${JSON.stringify(got)}`);
    }
  } finally {
    for (const name of names) rmSync(UPLOADS + '/' + name, { force: true });
  }
  assert.deepEqual(bad, []);
  assert.ok(expected.filter(Boolean).length >= 60 && expected.filter((x) => x === null).length >= 40, 'both outcomes are covered');

  // Auf der Karte: das Profilbild aus einem versetzten Einzelbild ist dasselbe wie mit GD
  const offset = `avatar_5_1700000000_gifcard.gif`;
  writeFileSync(UPLOADS + '/' + offset, files.get('0offset')!);
  try {
    const page = { id: 40, slug: 'gif', address_mode: 'subdomain', title: 'Gif', subtitle: '', bio: '', avatar: offset, theme: 'galaxy', settings: '{}' };
    const php = Buffer.from(JSON.parse(runPhp(`echo json_encode(base64_encode(oys_og_render($in)));`, jsonText(page))) as string, 'base64');
    const a = await pixels(php);
    const b = await pixels(await ogRender(jsonDecode(jsonText(page)) as object, false));
    let diff = 0;
    for (let y = 165; y < 465; y++) {
      for (let x = 96; x < 396; x++) {
        const k = (y * 1200 + x) * a.channels;
        if (a.data[k] !== b.data[k] || a.data[k + 1] !== b.data[k + 1] || a.data[k + 2] !== b.data[k + 2]) diff++;
      }
    }
    assert.equal(diff, 0, 'avatar pixels');
  } finally {
    rmSync(UPLOADS + '/' + offset, { force: true });
  }
});

// ---------------------------------------------------------------- PNG, JPEG und WebP wie GD

// Profilbild-Pixel nach dem Laden: r g b a (7 Bit), durchsichtig (127) ohne Farbe – auch Palettenbilder von GD
const PHP_PIXELS = `
  function og_pixels(string $name): ?array {
    $img = oys_og_load_image($name);
    if (!$img) return null;
    $t = imagecolortransparent($img);
    $s = '';
    for ($y = 0; $y < imagesy($img); $y++) for ($x = 0; $x < imagesx($img); $x++) {
      $c = imagecolorat($img, $x, $y);
      if (imageistruecolor($img)) { $a = ($c >> 24) & 127; $s .= $a === 127 ? 'T,' : (($c >> 16) & 255) . ' ' . (($c >> 8) & 255) . ' ' . ($c & 255) . ' ' . $a . ','; continue; }
      $k = imagecolorsforindex($img, $c);
      $s .= $c === $t || $k['alpha'] === 127 ? 'T,' : $k['red'] . ' ' . $k['green'] . ' ' . $k['blue'] . ' ' . $k['alpha'] . ',';
    }
    return [imagesx($img), imagesy($img), sha1($s)];
  }`;

function rgbaPixels(img: { width: number; height: number; px: Int32Array } | null): unknown {
  if (!img) return null;
  let s = '';
  for (const c of img.px) {
    const a = (c >> 24) & 0x7f;
    s += a === 127 ? 'T,' : `${(c >> 16) & 255} ${(c >> 8) & 255} ${c & 255} ${a},`;
  }
  return [img.width, img.height, createHash('sha1').update(s).digest('hex')];
}

// PNG von Hand (jede Farbart und Bittiefe, ohne Filter)
function handPng(w: number, h: number, colorType: number, depth: number, pixel: (x: number, y: number) => number[], extra: Buffer[] = []): Buffer {
  const ch = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const values: number[] = [];
    for (let x = 0; x < w; x++) values.push(...pixel(x, y).slice(0, ch));
    const line = Buffer.alloc(Math.ceil((w * ch * depth) / 8));
    values.forEach((v, i) => {
      if (depth === 16) line.writeUInt16BE(v, i * 2);
      else if (depth === 8) line[i] = v;
      else line[(i * depth) >> 3] |= v << (8 - depth - ((i * depth) & 7));
    });
    rows.push(Buffer.concat([Buffer.from([0]), line]));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = depth;
  ihdr[9] = colorType;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), ...extra, pngChunk('IDAT', deflateSync(Buffer.concat(rows))), pngChunk('IEND', Buffer.alloc(0))]);
}
function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

// JPEG ohne Adobe-Kennung (APP14 entfernt)
function withoutApp14(b: Buffer): Buffer {
  const parts = [b.subarray(0, 2)];
  let p = 2;
  while (p < b.length && b[p] === 0xff) {
    if (b[p + 1] === 0xda) break;
    const length = b.readUInt16BE(p + 2);
    if (b[p + 1] !== 0xee) parts.push(b.subarray(p, p + 2 + length));
    p += 2 + length;
  }
  parts.push(b.subarray(p));
  return Buffer.concat(parts);
}

test('photo avatars of every PNG, JPEG and WebP kind load like oys_og_load_image (tRNS, 16 bit, palettes, CMYK)', { skip: PHP_SKIP }, async () => {
  const w = 40;
  const h = 30;
  const plte = pngChunk('PLTE', Buffer.from(Array.from({ length: 16 * 3 }, (_v, i) => (i * 53) % 256)));
  const files: Record<string, Buffer> = {
    'rgb16.png': handPng(w, h, 2, 16, (x, y) => [x * 1600 + 37, y * 2100 + 255, (x * y * 97) % 65536]),
    'rgba16.png': handPng(w, h, 6, 16, (x, y) => [x * 1600 + 200, y * 2100 + 128, (x * y * 97) % 65536, (x * 1700) % 65536]),
    'grey8.png': handPng(w, h, 0, 8, (x, y) => [(x * 6 + y) % 256]),
    'grey16.png': handPng(w, h, 0, 16, (x, y) => [(x * 1600 + y * 7) % 65536]),
    'grey4.png': handPng(w, h, 0, 4, (x, y) => [(x + y) % 16]),
    'grey1.png': handPng(w, h, 0, 1, (x, y) => [(x + y) % 2]),
    'greyalpha.png': handPng(w, h, 4, 8, (x, y) => [(x * 6) % 256, (y * 9) % 256]),
    'palette4.png': handPng(w, h, 3, 4, (x, y) => [(x + 2 * y) % 16], [plte]),
    'palette-trns.png': handPng(w, h, 3, 8, (x, y) => [(x * 3 + y) % 16], [plte, pngChunk('tRNS', Buffer.from([255, 200, 100, 50, 1, 2, 254, 0, 128, 0]))]),
    'grey-trns.png': handPng(w, h, 0, 8, (x) => [(x * 6) % 256], [pngChunk('tRNS', Buffer.from([0, 12]))]),
    'grey16-trns.png': handPng(w, h, 0, 16, (x) => [(x * 1600 + 37) % 65536], [pngChunk('tRNS', Buffer.from([0x06, 0x65]))]),
    // RGB mit tRNS: GD merkt sich die Farbe nur, die Pixel bleiben deckend
    'rgb-trns.png': handPng(w, h, 2, 8, (x) => [(x * 6) % 256, 0, 0], [pngChunk('tRNS', Buffer.from([0, 12, 0, 0, 0, 0]))]),
    'rgb16-trns.png': handPng(w, h, 2, 16, (x) => [x * 1600 + 37, 0, 0], [pngChunk('tRNS', Buffer.from([0x06, 0x65, 0, 0, 0, 0]))]),
    'gamma.png': handPng(w, h, 2, 8, (x, y) => [(x * 6) % 256, (y * 8) % 256, 100], [pngChunk('gAMA', Buffer.from([0, 0, 0x5b, 0x8f]))]),
  };
  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) rgb.set([(i * 7) % 256, (i * 13) % 256, (i * 3) % 256], i * 3);
  const raw = { raw: { width: w, height: h, channels: 3 as const } };
  files['420.jpg'] = await sharp(rgb, raw).jpeg({ quality: 80 }).toBuffer();
  files['444.jpg'] = await sharp(rgb, raw).jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer();
  files['progressive.jpg'] = await sharp(rgb, raw).jpeg({ quality: 85, progressive: true }).toBuffer();
  files['grey.jpg'] = await sharp(rgb, raw).greyscale().jpeg({ quality: 85 }).toBuffer();
  // CMYK: mit Adobe-Kennung (invertiert gespeichert) und ohne
  files['cmyk-adobe.jpg'] = await sharp(rgb, raw).toColourspace('cmyk').jpeg({ quality: 90 }).toBuffer();
  files['cmyk-plain.jpg'] = withoutApp14(files['cmyk-adobe.jpg']);
  files['interlaced.png'] = await sharp(rgb, raw).png({ progressive: true }).toBuffer();
  files['lossless.webp'] = await sharp(rgb, raw).webp({ lossless: true }).toBuffer();
  files['lossy.webp'] = await sharp(rgb, raw).webp({ quality: 70 }).toBuffer();
  assert.ok(files['cmyk-adobe.jpg'].includes('Adobe') && !files['cmyk-plain.jpg'].includes('Adobe'));

  const names = Object.keys(files).map((k) => `avatar_5_1700000000_kind-${k}`);
  const bad: string[] = [];
  try {
    for (const [i, k] of Object.keys(files).entries()) writeFileSync(UPLOADS + '/' + names[i], files[k]);
    const expected = JSON.parse(runPhp(`${PHP_PIXELS} $out = []; foreach ($in as $n) $out[] = og_pixels($n); echo json_encode($out);`, JSON.stringify(names))) as unknown[];
    for (const [i, name] of names.entries()) {
      const got = rgbaPixels(await ogLoadImage(name));
      if (JSON.stringify(got) !== JSON.stringify(expected[i])) bad.push(`${name}: php ${JSON.stringify(expected[i])} node ${JSON.stringify(got)}`);
    }
    assert.ok(expected.every(Boolean), 'GD reads every file');
  } finally {
    for (const name of names) rmSync(UPLOADS + '/' + name, { force: true });
  }
  assert.deepEqual(bad, []);
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
  const root = phpRoot();
  server = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', root, root + '/index.php'], { cwd: root, stdio: 'ignore' });
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

test('/_/og/ serves, caches and cleans up (status, headers, files)', async () => {
  // Node liest für das wirksame Branding den Premium-Stand des Besitzers (users.premium_until) – wie im Betrieb erst
  // nach der Migration
  await ensureSchema();
  const page = (await one('SELECT * FROM pages WHERE id = 1'))!;
  // Seite des Admins: Premium – wirksam wie gespeichert
  const hash = ogHash(page, storedHidden(page));
  try {
    // Unbekannte Seite: nichts; alte Kennung: weiter zum aktuellen Bild
    assert.equal((await nodeGet(99999, hash)).status, 404);
    const old = await nodeGet(1, '000000000000');
    assert.equal(old.status, 302);
    assert.match(old.headers.location, new RegExp(`/_/og/1-${hash}\\.png$`));
    // Erster Abruf: Bild erzeugen, speichern, ältere Bilder dieser Seite löschen (andere Seiten bleiben)
    prepareCache(1);
    const b = await nodeGet(1, hash);
    assert.deepEqual(listCache(), ['1-cccccccccccc.png.tmp', `1-${hash}.png`, '10-bbbbbbbbbbbb.png', 'x1-a.png'].sort());
    assert.equal(b.status, 200);
    assert.equal(b.headers['content-type'], 'image/png');
    assert.equal(Number(b.headers['content-length']), b.body.length);
    assert.ok(b.body.equals(readFileSync(`${OG_DIR()}/1-${hash}.png`)), 'the response is the cached file');
    assert.deepEqual(pngHeader(b.body).width, 1200);
    // Weitere Abrufe kommen aus dem Zwischenspeicher
    writeFileSync(`${OG_DIR()}/1-${hash}.png`, b.body.subarray(0, 100));
    assert.equal((await nodeGet(1, hash)).body.length, 100);
    // Ordner og/ lässt sich nicht anlegen (eine Datei gleichen Namens): das Bild kommt trotzdem, gespeichert wird nichts
    rmSync(OG_DIR(), { recursive: true, force: true });
    writeFileSync(OG_DIR(), 'not a folder');
    const blocked = await nodeGet(1, hash);
    assert.equal(readFileSync(OG_DIR(), 'utf8'), 'not a folder');
    assert.equal(blocked.status, 200);
    assert.equal(Number(blocked.headers['content-length']), blocked.body.length);
  } finally {
    rmSync(OG_DIR(), { recursive: true, force: true });
  }
});

test('/_/og/ serves, caches and cleans up like oys_og_serve (status, headers, files)', { skip: PHP_SKIP }, async () => {
  // Node liest für das wirksame Branding den Premium-Stand des Besitzers (users.premium_until) – wie im Betrieb erst
  // nach der Migration
  await ensureSchema();
  await startPhp();
  const page = (await one('SELECT * FROM pages WHERE id = 1'))!;
  // Seite des Admins: Premium – wirksam wie gespeichert
  const hash = ogHash(page, storedHidden(page));
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

    // Ordner og/ lässt sich nicht anlegen (eine Datei gleichen Namens): das Bild kommt trotzdem, gespeichert wird nichts
    rmSync(OG_DIR(), { recursive: true, force: true });
    writeFileSync(OG_DIR(), 'not a folder');
    const blockedPhp = await phpGet(`/_/og/1-${hash}.png`);
    const blockedNode = await nodeGet(1, hash);
    assert.equal(readFileSync(OG_DIR(), 'utf8'), 'not a folder');
    assert.deepEqual(blockedNode.status, blockedPhp.status);
    assert.equal(blockedNode.headers['cache-control'], blockedPhp.headers['cache-control']);
    assert.equal(blockedNode.headers['content-type'], blockedPhp.headers['content-type']);
    assert.equal(Number(blockedNode.headers['content-length']), blockedNode.body.length);
    assert.deepEqual(pngHeader(blockedNode.body), pngHeader(blockedPhp.body));
  } finally {
    rmSync(OG_DIR(), { recursive: true, force: true });
  }
});

// Grenzen von oys_og_load_image: höchstens 15 MiB, nur der Dateiname zählt (Ordner davor werden ignoriert)
// Grenze 15 MiB und Namen: die Datei, die geladen wird (oder nicht), und das Ergebnis von PHP (nur mit OYS_PHP_REF)
async function avatarLimits(compare: boolean): Promise<void> {
  const png = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#3366cc' } }).png().toBuffer();
  const limit = 15 * 1024 * 1024;
  const files: Record<string, Buffer> = {
    'avatar_5_1700000000_limit.png': Buffer.concat([png, Buffer.alloc(limit - png.length)]),
    'avatar_5_1700000000_over.png': Buffer.concat([png, Buffer.alloc(limit - png.length + 1)]),
    'avatar_5_1700000000_small.png': png,
  };
  const names = ['avatar_5_1700000000_limit.png', 'avatar_5_1700000000_over.png', 'avatar_5_1700000000_small.png', '../x/avatar_5_1700000000_small.png',
    'avatar_5_1700000000_small.png/', '', '/', '.', '..', 'avatar_5_1700000000_missing.png'];
  try {
    for (const [k, v] of Object.entries(files)) writeFileSync(UPLOADS + '/' + k, v);
    const got: unknown[] = [];
    for (const n of names) got.push(rgbaPixels(await ogLoadImage(n)));
    assert.deepEqual(got.map(Boolean), [true, false, true, true, true, false, false, false, false, false]);
    if (compare) assert.deepEqual(got, JSON.parse(runPhp(`${PHP_PIXELS} $out = []; foreach ($in as $n) $out[] = og_pixels($n); echo json_encode($out);`, JSON.stringify(names))));
  } finally {
    for (const k of Object.keys(files)) rmSync(UPLOADS + '/' + k, { force: true });
  }
}

test('avatar files up to exactly 15 MiB load, larger ones and odd names do not', () => avatarLimits(false));

test('avatar files up to exactly 15 MiB load, larger ones and odd names do not – like oys_og_load_image', { skip: PHP_SKIP }, () => avatarLimits(true));
