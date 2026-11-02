// Zweitprüfung des Datei-Pakets: Fälle, die die ersten Vergleiche nicht abgedeckt haben – jeweils gegen die echte
// PHP-Funktion der PHP-Version (support/phpRef.ts; Spam-Filter mit Schrift-Erweiterungen, EXIF-Ausrichtung wie
// exif_read_data(), …).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { loadConfig, setConfigForTests } from '../src/config.js';
import { looksLikeSpam } from '../src/helpers.js';
import { PCRE_CYRILLIC_HAN, PCRE_LETTER } from '../src/compat/pcre14.js';
import sharp from 'sharp';
import { exifOrientation, processImage } from '../src/content/uploads.js';
import { fileMime } from '../src/content/fileMime.js';
import { setUploadsDefaultDirForTests, storageMoveToDataDir, uploadsDir } from '../src/content/storage.js';
import { buildServer } from '../src/server.js';
import { closePool } from '../src/db.js';
import { startPhpServer } from './filesHarness.js';
import { rng } from './modelHarness.js';
import { PHP_SKIP, fromPhpTree, phpFile, phpRef } from './support/phpRef.js';

// PHP-Code mit $in (JSON von stdin) ausführen, Ergebnis als JSON
function php(code: string, input: unknown, libs: string[] = []): unknown {
  const script = libs.map((f) => `require '${phpFile(f)}';`).join('') + `$in = json_decode(stream_get_contents(STDIN), true); echo json_encode((function ($in) { ${code} })($in));`;
  return JSON.parse(execFileSync('php', ['-d', 'display_errors=stderr', '-d', 'memory_limit=1G', '-r', script], { input: JSON.stringify(input), maxBuffer: 1 << 28 }).toString());
}

// ---------------------------------------------------------------- oys_looks_like_spam()

test('the fixed PCRE classes of the spam check match PHP for every code point', { skip: PHP_SKIP }, () => {
  // Je Codepoint (ohne Surrogate) „1“ oder „0“: \p{L} und [\p{Cyrillic}\p{Han}] mit /u
  const phpBits = php(`$o = ['', ''];
    for ($cp = 0; $cp <= 0x10FFFF; $cp++) { if ($cp >= 0xD800 && $cp <= 0xDFFF) continue; $c = mb_chr($cp, 'UTF-8');
      $o[0] .= preg_match('/\\p{L}/u', $c) ? '1' : '0'; $o[1] .= preg_match('/[\\p{Cyrillic}\\p{Han}]/u', $c) ? '1' : '0'; }
    return $o;`, null) as [string, string];
  const res = [new RegExp('^[' + PCRE_LETTER + ']$', 'u'), new RegExp('^[' + PCRE_CYRILLIC_HAN + ']$', 'u')];
  res.forEach((re, k) => {
    let bits = '';
    for (let cp = 0; cp <= 0x10ffff; cp++) if (cp < 0xd800 || cp > 0xdfff) bits += re.test(String.fromCodePoint(cp)) ? '1' : '0';
    const first = [...bits].findIndex((b, i) => b !== phpBits[k][i]);
    assert.equal(first, -1, `class ${k}: first difference at index ${first}`);
  });
});

test('spam check counts Cyrillic and Han like PCRE2 (script extensions)', { skip: PHP_SKIP }, () => {
  const r = rng(424242);
  // Zeichen, bei denen Schrift (sc) und Schrift-Erweiterung (scx) auseinandergehen: CJK-Satzzeichen, Kana-Längenstrich,
  // Wiederholungszeichen, kyrillische Kombinationszeichen
  const pools = [
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', '     ', '0123456789.,!?',
    '你好世界中文测试数据我们他们', '、。，！？「」『』〈〉《》【】〔〕・ー々〆〇〜',
    'ぁあいうえおかがきぎくぐけげこごさざ', 'ァアィイゥウェエォオカガキギクグケゲ', 'абвгдежзийклмнопрстуфхцчшщъыьэюя',
    '҃҄҅҆҇҈҉᷸⹃꙯̀́̂', 'αβγδεζηθικλμνξοπρστυφχψω', '🐝😀👍',
  ];
  const texts: string[] = [
    'Привет, как дела? Это тест сообщения на русском языке', '你好，世界。这是一个测试消息，我们看看会怎么样。Hello there friend',
    'Hello my friend, this is a message 你好世界、、、、、、、、、、、', 'abcdefghijklmnopqrstu 你好世界你好世界你好世界你好、、、。。。',
    'abcdefghijklmnopqrstuvwxyzab 中文中文中文中文中文中文中文中文中文中文中文中文、、、、', 'а҃҄҅҆б҅҆ abcdefghijklmnopqrstuvwxyz᷸⹃꙯',
    'BACKLINKS here', 'baKclinKs', 'CASİNO night', 'ViAgRa', 'see WWW.a.de www.b.de Www.c.de', '<A\tHREF="x">', '[URL=x]', '[link=y]',
  ];
  for (let i = 0; i < 1500; i++) {
    const len = 10 + r.next(60);
    const mix = [r.pick(pools), r.pick(pools), r.pick(pools)].map((p) => Array.from(p));
    let t = '';
    for (let k = 0; k < len; k++) {
      const chars = mix[r.next(3)];
      t += chars[r.next(chars.length)];
    }
    texts.push(t);
  }
  const phpOut = php('return array_map(fn ($t) => oys_looks_like_spam($t), $in);', texts, ['lib/spam.php']) as boolean[];
  const mismatches = texts.map((t, i) => ({ t, node: looksLikeSpam(t), php: phpOut[i] })).filter((m) => m.node !== m.php);
  assert.deepEqual(mismatches, []);
  assert.ok(phpOut.filter(Boolean).length > 50 && phpOut.filter((x) => !x).length > 50);
});

// ---------------------------------------------------------------- exif_read_data()['Orientation'] (Drehung beim Hochladen)

interface ExifEntry { tag: number; format: number; count: number; value: Buffer; sub?: 'exif' | 'gps' | 'interop' }
const SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 1 };

// JPEG-Köpfe mit zufälligem, oft fehlerhaftem Exif-Aufbau: Byte-Reihenfolge, Formate und Anzahl der Ausrichtung,
// Unter-IFDs (Exif, GPS, Interop), Vorschau-IFD, Werte außerhalb der APP1, leere Pflichtwerte, unsortierte und doppelte
// Einträge, abgeschnittene Abschnitte, Müll zwischen den Abschnitten, Kommentare mit falscher Länge, kurze SOF, EOI vor SOS
function exifJpeg(r: ReturnType<typeof rng>): Buffer {
  const mm = r.chance(0.5);
  const u16 = (n: number) => { const x = Buffer.alloc(2); if (mm) x.writeUInt16BE(n & 0xffff); else x.writeUInt16LE(n & 0xffff); return x; };
  const u32 = (n: number) => { const x = Buffer.alloc(4); if (mm) x.writeUInt32BE(n >>> 0); else x.writeUInt32LE(n >>> 0); return x; };
  const fill = (n: number, f: (i: number) => number) => Buffer.from(Array.from({ length: n }, (_, i) => f(i) & 0xff));
  const value = (format: number, count: number, v: number): Buffer => {
    const size = SIZES[format] ?? 1;
    const parts: Buffer[] = [];
    for (let i = 0; i < count; i++) {
      const x = i === 0 ? v : r.next(9);
      if (format === 2) parts.push(Buffer.from(r.pick(['6', '8', '3', ' ', '\0', 'x', '1'])));
      else if (size === 1) parts.push(Buffer.from([r.chance(0.2) ? 0x30 + x : x]));
      else if (format === 3 || format === 8) parts.push(u16(x));
      else if (format === 4 || format === 9) parts.push(u32(r.chance(0.1) ? x * 65536 + x : x));
      else if (format === 5 || format === 10) parts.push(u32(r.chance(0.2) ? -x : x), u32(r.pick([1, 1, 0, 2])));
      else if (format === 11) { const f = Buffer.alloc(4); if (r.chance(0.5)) f.writeFloatLE(x + r.pick([0, 0.5, 0.99])); else f.writeFloatBE(x); parts.push(f); }
      else { const d = Buffer.alloc(8); if (r.chance(0.5)) d.writeDoubleLE(x + r.pick([0, 0.5])); else d.writeDoubleBE(x); parts.push(d); }
    }
    return Buffer.concat(parts).subarray(0, count * size);
  };
  const orientation = (): ExifEntry => {
    const format = r.pick([3, 3, 3, 3, 3, 4, 1, 6, 7, 2, 5, 10, 8, 9, 11, 12, 13, 0, 14]);
    const count = r.pick([1, 1, 1, 1, 1, 1, 0, 2, 3]);
    return { tag: 0x0112, format, count, value: value(format === 0 || format === 14 ? 1 : format, count, r.pick([1, 3, 6, 8, 6, 3, 8, 2, 5, 0, 9])) };
  };
  const ascii = (tag: number, s: string): ExifEntry => ({ tag, format: 2, count: s.length + 1, value: Buffer.from(s + '\0') });
  const rational = (tag: number, a: number, b: number, count = 1): ExifEntry => ({ tag, format: 5, count, value: count ? Buffer.concat([u32(a), u32(b)]) : Buffer.alloc(0) });
  const short = (tag: number, v: number, count = 1): ExifEntry => ({ tag, format: 3, count, value: count ? u16(v) : Buffer.alloc(0) });
  const maybe = (p: number, e: () => ExifEntry): ExifEntry[] => (r.chance(p) ? [e()] : []);
  const ifd0: ExifEntry[] = [ascii(0x010f, 'TestCam'), ascii(0x0110, 'Model X'), ...maybe(0.85, orientation), rational(0x011a, 72, 1), rational(0x011b, 72, 1),
    short(0x0128, 2), ascii(0x0131, 'Editor 1.0'), ...maybe(0.1, () => short(0x829d, 4, 0)), ...maybe(0.1, orientation),
    ...maybe(0.8, () => ({ tag: 0x8769, format: r.pick([4, 4, 4, 3, 13, 7]), count: r.pick([1, 1, 1, 0, 2]), value: Buffer.alloc(0), sub: 'exif' as const })),
    ...maybe(0.3, () => ({ tag: 0x8825, format: 4, count: 1, value: Buffer.alloc(0), sub: 'gps' as const }))];
  const exif: ExifEntry[] = [rational(0x829a, 1, 125), ...maybe(0.9, () => rational(0x829d, 28, 10, r.chance(0.1) ? 0 : 1)), ...maybe(0.25, orientation),
    { tag: 0x9000, format: 7, count: 4, value: Buffer.from('0232') }, ...maybe(0.2, () => rational(0x9201, 7, 1, r.chance(0.2) ? 0 : 1)),
    ...maybe(0.2, () => rational(0x9202, 3, 1, r.chance(0.3) ? 0 : 1)), ...maybe(0.1, () => short(0x9206, 1, 0)),
    { tag: 0x927c, format: 7, count: 12, value: Buffer.from('XYZnote data') }, ...maybe(0.5, () => short(0xa002, 640, r.chance(0.1) ? 0 : 1)),
    ...maybe(0.3, () => ({ tag: 0xa005, format: 4, count: 1, value: Buffer.alloc(0), sub: 'interop' as const }))];
  const gps: ExifEntry[] = [{ tag: 0x0000, format: 1, count: 4, value: Buffer.from([2, 3, 0, 0]) }, ...maybe(0.5, orientation),
    ...maybe(0.3, () => ({ tag: 0x8769, format: 4, count: 1, value: Buffer.alloc(0), sub: 'exif' as const }))];
  const interop: ExifEntry[] = [ascii(0x0001, 'R98'), { tag: 0x0002, format: 7, count: 4, value: Buffer.from('0100') }, ...maybe(0.3, orientation)];
  const ifd1: ExifEntry[] = r.chance(0.5) ? [short(0x0103, 6), ...maybe(0.5, orientation), { tag: 0x0201, format: 4, count: 1, value: u32(1000) }, ...maybe(0.2, () => short(0x0128, 2, 0))] : [];
  const lists: Record<string, ExifEntry[]> = { ifd0, exif, gps, interop, ifd1 };
  for (const l of Object.values(lists)) if (r.chance(0.15)) l.sort(() => r.next(3) - 1);
  // Aufbau: Kopf, IFD0, Exif, GPS, Interop, IFD1 – jeweils Verzeichnis und danach die langen Werte
  const order = ['ifd0', 'exif', 'gps', 'interop', 'ifd1'].filter((k) => k === 'ifd0' || lists[k].length && (k !== 'gps' || ifd0.some((e) => e.sub === 'gps')));
  const at: Record<string, number> = {};
  let pos = 8;
  for (const k of order) {
    at[k] = pos;
    pos += 2 + lists[k].length * 12 + 4;
    for (const e of lists[k]) if (!e.sub && e.value.length > 4) pos += e.value.length;
  }
  const total = pos;
  const outside = () => total + r.next(40);
  const parts: Buffer[] = [Buffer.from(mm ? 'MM' : 'II'), u16(r.chance(0.03) ? 0x2b : 0x2a), u32(r.chance(0.03) ? r.pick([0, 4, total + 5]) : 8)];
  for (const k of order) {
    const list = lists[k];
    let valuePos = at[k] + 2 + list.length * 12 + 4;
    const longValues: Buffer[] = [];
    parts.push(u16(list.length));
    for (const e of list) {
      let field: Buffer;
      if (e.sub) {
        const target = at[e.sub] ?? r.next(total + 10);
        field = e.format === 3 ? Buffer.concat([u16(target), u16(0)]) : u32(r.chance(0.05) ? target + total : target);
      } else if (e.value.length > 4) {
        field = u32(r.chance(0.1) ? outside() : valuePos);
        longValues.push(e.value);
        valuePos += e.value.length;
      } else {
        field = Buffer.concat([e.value, Buffer.alloc(4 - e.value.length)]);
      }
      parts.push(u16(e.tag), u16(e.format), u32(r.chance(0.02) ? r.pick([0x7fffffff, 0x10000000, 300]) : e.count), field);
    }
    const next = k === 'ifd0' && lists.ifd1.length ? at.ifd1 : k === 'interop' && r.chance(0.3) ? r.pick([at.ifd1 ?? 0, 3, total + 100]) : r.chance(0.05) ? 0xffffffff : 0;
    parts.push(u32(next), ...longValues);
  }
  let tiff = Buffer.concat(parts);
  if (r.chance(0.1)) tiff = tiff.subarray(0, r.next(tiff.length + 1));
  if (r.chance(0.1)) for (let k = 0; k < 1 + r.next(3); k++) tiff[r.next(tiff.length || 1)] = r.next(256);
  const seg = (marker: number, body: Buffer) => Buffer.concat([Buffer.from([0xff, marker]), Buffer.from([(body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
  const segments: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (r.chance(0.5)) segments.push(seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')));
  if (r.chance(0.15)) segments.push(seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>', 'latin1')));
  if (r.chance(0.1)) segments.push(seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from(r.pick(['XX', 'II\x2b\0', 'MM\0\x2a\0\0\0\x04', 'I']), 'latin1')])));
  if (r.chance(0.08)) segments.push(seg(0xfe, Buffer.from('early comment')));
  segments.push(seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), tiff])));
  if (r.chance(0.1)) segments.push(seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from('II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0\x06\0\0\0\0\0\0\0', 'latin1')])));
  if (r.chance(0.1)) segments.push(Buffer.from(fill(1 + r.next(3), () => r.pick([0, 1, 0x41, 0xd8]))));
  if (r.chance(0.1)) {
    // Kommentar, dessen Länge die zwei Längen-Bytes nicht mitzählt (PHP überspringt bis zu zwei Bytes danach)
    const text = Buffer.from('comment!');
    segments.push(Buffer.from([0xff, 0xfe, 0, text.length]), text);
  }
  if (r.chance(0.05)) segments.push(seg(0xec, Buffer.from(r.pick(['Ducky\0x', '\0\0', 'OLYMPUS\0info']), 'latin1')));
  segments.push(seg(0xdb, fill(65, (i) => i + 1)));
  segments.push(seg(0xc0, r.chance(0.05) ? Buffer.from([8, 0, 1, 0]) : Buffer.from([8, 0, 16, 0, 16, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])));
  if (r.chance(0.05)) segments.push(Buffer.from([0xff, 0xd9]));
  segments.push(seg(0xc4, fill(30, (i) => i)));
  segments.push(seg(0xda, Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0])), fill(200, (i) => (i * 37) & 0x7f), Buffer.from([0xff, 0xd9]));
  let file = Buffer.concat(segments);
  if (r.chance(0.08)) file = file.subarray(0, 2 + r.next(file.length - 2));
  return file;
}

test('the EXIF orientation is read like exif_read_data() (header scan, formats, sub-IFDs, broken files)', { skip: PHP_SKIP }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'oys-exif-'));
  try {
    const r = rng(20261102);
    const files: string[] = [];
    for (let i = 0; i < 4000; i++) {
      const f = join(dir, `${i}.jpg`);
      writeFileSync(f, exifJpeg(r));
      files.push(f);
    }
    const phpOut = php('return array_map(fn ($f) => (int) (@exif_read_data($f)[\'Orientation\'] ?? 1), $in);', files) as number[];
    const mismatches = files.map((f, i) => ({ f, node: exifOrientation(readFileSync(f)), php: phpOut[i] })).filter((m) => m.node !== m.php);
    assert.deepEqual(mismatches.slice(0, 10), []);
    // Die Fälle treffen die Drehungen und die Fehlerwege
    for (const o of [1, 3, 6, 8, 0]) assert.ok(phpOut.filter((x) => x === o).length > 20, `orientation ${o}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- imagecreatefromjpeg(): Marker nach den Bilddaten

// JPEG mit einem Scan, in dessen Bilddaten Marker stehen (wie nach Bitfehlern): libjpeg liest sie in GD am Ende mit
// jpeg_finish_decompress() – ein ungültiger dort lässt imagecreatefromjpeg() scheitern, und PHP speichert das Original.
// Die Restart-Bilder (test/fixtures/files) stammen aus einem anderen Encoder, denn sharp schreibt keine Restart-Marker.
test('JPEG files that GD cannot finish reading stay unconverted like in PHP (markers in the image data, restarts)', { skip: PHP_SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oys-gdjpeg-'));
  try {
    const r = rng(77001);
    const W = 96;
    const H = 72;
    const raw = Buffer.alloc(W * H * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (i % 3 === 2 ? r.next(256) : (i * 7) & 0xff);
    const img = () => sharp(raw, { raw: { width: W, height: H, channels: 3 } });
    const bases: Array<[string, Buffer]> = [
      ['baseline', await img().jpeg({ quality: 85 }).toBuffer()], ['baseline-444', await img().jpeg({ chromaSubsampling: '4:4:4' }).toBuffer()],
      ['gray', await img().greyscale().jpeg().toBuffer()], ['progressive', await img().jpeg({ progressive: true }).toBuffer()],
      ...readdirSync(join(import.meta.dirname, 'fixtures/files')).sort().map((f): [string, Buffer] => [f, readFileSync(join(import.meta.dirname, 'fixtures/files', f))]),
    ];
    const injections: Array<() => number[]> = [
      () => [0xff, 0x37], () => [0xff, 0x01], () => [0xff, 0xd0 + r.next(8)], () => [0xff, 0xd8], () => [0xff, 0xd9], () => [0xff, 0xc0, 0, 11, 8, 0, 8, 0, 8, 1, 1, 0x11, 0],
      () => [0xff, r.pick([0xc1, 0xc2, 0xc3, 0xc5, 0xc8, 0xcf])], () => [0xff, 0xc4, 0, r.next(40), ...Array.from({ length: r.next(30) }, () => r.next(4))],
      () => [0xff, 0xc4, 0, 19, 0x10, ...Array(16).fill(0)], () => [0xff, 0xcc, 0, r.pick([4, 6, 5, 2]), r.next(40), r.next(256), r.next(20), r.next(256)],
      () => [0xff, 0xdb, 0, r.pick([67, 2, 3, 132]), r.next(20)], () => [0xff, 0xdd, 0, r.pick([4, 5]), 0, 1], () => [0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0],
      () => [0xff, r.pick([0xe1, 0xe5, 0xee, 0xfe]), 0, r.next(30)], () => [0xff, r.pick([0xf0, 0xf7, 0xfd, 0xde, 0xdf, 0x02, 0xbf])], () => [0xff, 0xdc, 0, 4, 0, 8],
      () => [0xff, 0xff, 0x00], () => [0xff, 0xff, 0x37], () => [r.next(256), r.next(256), r.next(256)],
    ];
    const files: string[] = [];
    const add = (name: string, b: Buffer) => {
      const f = join(dir, name);
      writeFileSync(f, b);
      files.push(f);
    };
    for (const [name, base] of bases) {
      let start = 2;
      while (base[start + 1] !== 0xda) start += 2 + base.readUInt16BE(start + 2);
      start += 2 + base.readUInt16BE(start + 2);
      add(name, base);
      for (let k = 0; k < 45; k++) {
        let b = Buffer.from(base);
        for (let j = 1 + r.next(3); j > 0; j--) {
          const at = start + r.next(Math.max(1, b.length - 2 - start));
          const ins = Buffer.from(r.pick(injections)());
          b = Buffer.concat([b.subarray(0, at), ins, b.subarray(r.chance(0.3) ? at + ins.length : at)]);
        }
        if (r.chance(0.12)) b = b.subarray(0, start + r.next(b.length - start));
        add(`${name}-${k}`, b);
      }
      // Restart-Marker mit falscher Nummer oder als Daten
      const rst: number[] = [];
      for (let i = start; i < base.length - 1; i++) if (base[i] === 0xff && base[i + 1] >= 0xd0 && base[i + 1] <= 0xd7) rst.push(i);
      for (let k = 0; k < Math.min(rst.length, 8); k++) {
        const b = Buffer.from(base);
        b[r.pick(rst) + 1] = r.chance(0.5) ? 0xd0 + r.next(8) : 0;
        add(`${name}-rst${k}`, b);
      }
    }
    const out = join(dir, 'out');
    mkdirSync(out);
    const phpOk = php(`require '${phpFile('lib/uploads.php')}'; $o = []; foreach ($in as $i => $f) $o[] = @oys_process_image($f, 'jpg', 640, '${out}/php' . $i . '.webp'); return $o;`, files) as boolean[];
    const mismatches: unknown[] = [];
    for (let i = 0; i < files.length; i++) {
      const ok = await processImage(readFileSync(files[i]), 'jpg', 640, join(out, `node${i}.webp`));
      if (ok !== phpOk[i]) mismatches.push({ file: files[i].split('/').pop(), node: ok, php: phpOk[i] });
    }
    assert.deepEqual(mismatches, []);
    assert.ok(phpOk.filter(Boolean).length > 100 && phpOk.filter((x) => !x).length > 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- imagecreatefrompng()/imagecreatefromwebp(): beschädigte Dateien

// Bekannt (Datei → GD liest, sharp nicht): WebP im erweiterten Format (VP8X) mit Metadaten hinter dem Bild, deren
// RIFF-Größe zu klein ist oder deren VP8-Abschnitt zu kurz angegeben ist. libwebp in GD dekodiert nur bis zum Bild und
// liest dabei über das Abschnittsende hinaus; sharp prüft den ganzen Container (WebPDemux) und scheitert. Node speichert
// solche Dateien unverändert, PHP wandelt sie um.
const KNOWN_WEBP = new Set(['webp-meta-short', 'webp-meta-riffsmall']);

test('PNG and WebP files are converted or kept like GD (damaged zlib data, chunks, filters, sizes)', { skip: PHP_SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oys-gdimg-'));
  try {
    const r = rng(5150);
    const W = 60;
    const H = 40;
    const raw = Buffer.alloc(W * H * 4);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 13 + r.next(7)) & 0xff;
    const img = () => sharp(raw, { raw: { width: W, height: H, channels: 4 } });
    const cases: Array<[string, string]> = [];
    const add = (name: string, ext: string, b: Buffer) => {
      writeFileSync(join(dir, name), b);
      cases.push([name, ext]);
    };
    // PNG: Abschnitte neu zusammensetzen (Prüfsummen stimmen, außer gewollt)
    type Chunk = [string, Buffer];
    const pngChunks = (b: Buffer): Chunk[] => {
      const out: Chunk[] = [];
      for (let p = 8; p + 12 <= b.length; p += 12 + b.readUInt32BE(p)) out.push([b.toString('latin1', p + 4, p + 8), b.subarray(p + 8, p + 8 + b.readUInt32BE(p))]);
      return out;
    };
    const png = (cs: Chunk[], bad = -1) => Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), ...cs.map(([t, d], i) => {
      const body = Buffer.concat([Buffer.from(t, 'latin1'), d]);
      const len = Buffer.alloc(4);
      len.writeUInt32BE(d.length);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE((crc32(body) ^ (i === bad ? 1 : 0)) >>> 0);
      return Buffer.concat([len, body, crc]);
    })]);
    const pngs: Record<string, Buffer> = {
      rgba: await img().png().toBuffer(), rgb: await img().removeAlpha().png().toBuffer(), pal: await img().png({ palette: true }).toBuffer(),
      gray: await img().greyscale().png().toBuffer(), inter: await img().png({ progressive: true }).toBuffer(), b16: await img().png().toColourspace('rgb16').toBuffer(),
    };
    for (const [n, b] of Object.entries(pngs)) {
      const cs = pngChunks(b);
      const idat = Buffer.concat(cs.filter(([t]) => t === 'IDAT').map(([, d]) => d));
      const head = cs.filter(([t]) => t !== 'IDAT' && t !== 'IEND');
      const iend: Chunk = ['IEND', Buffer.alloc(0)];
      const withIdat = (data: Buffer[], extra: Chunk[] = []) => png([...head, ...extra, ...data.map((d): Chunk => ['IDAT', d]), iend]);
      const inflated = inflateSync(idat);
      const p = (name: string, data: Buffer) => add(`png-${n}-${name}`, 'png', data);
      p('orig', b);
      for (let k = 0; k < 8; k++) {
        const d = Buffer.from(idat);
        for (let j = 1 + r.next(3); j > 0; j--) d[2 + r.next(d.length - 6)] = r.next(256);
        p(`zflip${k}`, withIdat([d]));
      }
      p('adler', withIdat([Buffer.concat([idat.subarray(0, -4), Buffer.from([1, 2, 3, 4])])]));
      p('ztrunc', withIdat([idat.subarray(0, idat.length >> 1)]));
      p('toomuch', withIdat([deflateSync(Buffer.concat([inflated, Buffer.alloc(200, 7)]))]));
      p('toolittle', withIdat([deflateSync(inflated.subarray(0, inflated.length - 30))]));
      p('split', withIdat(Array.from({ length: 7 }, (_, i) => idat.subarray(Math.floor((i * idat.length) / 7), Math.floor(((i + 1) * idat.length) / 7)))));
      p('empty-idat', withIdat([Buffer.alloc(0), idat, Buffer.alloc(0)]));
      for (const fb of [5, 255]) {
        const inf = Buffer.from(inflated);
        inf[0] = fb;
        p(`filter${fb}`, withIdat([deflateSync(inf)]));
      }
      for (const [t, d] of [['tRNS', Buffer.alloc(300)], ['gAMA', Buffer.alloc(2)], ['sRGB', Buffer.from([9])], ['iCCP', Buffer.from('x\0\0garbage')],
        ['zTXt', Buffer.from('k\0\0zz')], ['pHYs', Buffer.alloc(3)], ['sBIT', Buffer.alloc(4)], ['PLTE', Buffer.alloc(10)], ['vpAg', Buffer.alloc(9)]] as Chunk[]) {
        p(`extra-${t}`, withIdat([idat], [[t, d]]));
        p(`extra-${t}-badcrc`, png([...head, [t, d], ['IDAT', idat], iend], head.length));
      }
      p('after-badcrc', png([...head, ['IDAT', idat], ['tEXt', Buffer.from('a\0b')], iend], head.length + 1));
      p('after-idat', png([...head, ['IDAT', idat], ['IDAT', Buffer.from('xx')], iend]));
      p('iend-data', png([...head, ['IDAT', idat], ['IEND', Buffer.from('x')]]));
    }
    // WebP: RIFF-Abschnitte neu zusammensetzen
    const riffChunks = (b: Buffer): Chunk[] => {
      const out: Chunk[] = [];
      for (let p = 12; p + 8 <= b.length; p += 8 + b.readUInt32LE(p + 4) + (b.readUInt32LE(p + 4) & 1)) out.push([b.toString('latin1', p, p + 4), b.subarray(p + 8, p + 8 + b.readUInt32LE(p + 4))]);
      return out;
    };
    const riff = (cs: Chunk[], delta = 0) => {
      const body = Buffer.concat(cs.map(([t, d]) => {
        const h = Buffer.alloc(8);
        h.write(t, 0, 'latin1');
        h.writeUInt32LE(d.length, 4);
        return Buffer.concat([h, d, Buffer.alloc(d.length & 1)]);
      }));
      const h = Buffer.alloc(12);
      h.write('RIFF', 0);
      h.writeUInt32LE(body.length + 4 + delta, 4);
      h.write('WEBP', 8);
      return Buffer.concat([h, body]);
    };
    const webps: Record<string, Buffer> = {
      lossy: await img().webp({ quality: 80 }).toBuffer(), alpha: await img().webp({ alphaQuality: 50 }).toBuffer(), lossless: await img().webp({ lossless: true }).toBuffer(),
      opaque: await img().removeAlpha().webp().toBuffer(), meta: await img().webp().withMetadata({ orientation: 6 }).toBuffer(), icc: await img().webp().withIccProfile('p3').toBuffer(),
    };
    for (const [n, b] of Object.entries(webps)) {
      const cs = riffChunks(b);
      const at = cs.findIndex(([t]) => t === 'VP8 ' || t === 'VP8L');
      const copy = () => cs.map(([t, d]): Chunk => [t, Buffer.from(d)]);
      const w = (name: string, data: Buffer) => add(`webp-${n}-${name}`, 'webp', data);
      w('orig', b);
      for (let k = 0; k < 12; k++) {
        const c = copy();
        for (let j = 1 + r.next(4); j > 0; j--) c[at][1][10 + r.next(c[at][1].length - 10)] = r.next(256);
        w(`dflip${k}`, riff(c));
      }
      for (let k = 0; k < 4; k++) {
        const c = copy();
        c[at][1][r.next(10)] = r.next(256);
        w(`hflip${k}`, riff(c));
      }
      const alph = cs.findIndex(([t]) => t === 'ALPH');
      if (alph >= 0) for (let k = 0; k < 4; k++) {
        const c = copy();
        c[alph][1][r.next(c[alph][1].length)] = r.next(256);
        w(`aflip${k}`, riff(c));
      }
      w('short', riff(cs.map(([t, d], i): Chunk => [t, i === at ? d.subarray(0, d.length - 20) : d])));
      w('long', riff(cs.map(([t, d], i): Chunk => [t, i === at ? Buffer.concat([d, Buffer.alloc(30, 9)]) : d])));
      w('riffbig', riff(cs, 100));
      w('riffsmall', riff(cs, -10));
      w('extra', riff([...cs, ['XXXX', Buffer.alloc(5)]]));
      w('extra-first', riff([['XXXX', Buffer.alloc(5)], ...cs]));
      for (const f of [0.3, 0.7, 0.95]) w(`cut${f}`, b.subarray(0, Math.floor(b.length * f)));
    }
    const out = join(dir, 'out');
    mkdirSync(out);
    // PHP: false = kein Bild für getimagesize() (das lehnt der Upload vorher ab), sonst das Ergebnis von oys_process_image()
    const phpOut = php(`require '${phpFile('lib/uploads.php')}'; $o = []; foreach ($in as $i => [$f, $ext]) {
      $o[] = @getimagesize('${dir}/' . $f) ? @oys_process_image('${dir}/' . $f, $ext, 640, '${out}/php' . $i . '.webp') : null; } return $o;`, cases) as Array<boolean | null>;
    const mismatches: unknown[] = [];
    for (let i = 0; i < cases.length; i++) {
      if (phpOut[i] === null) continue;
      const node = await processImage(readFileSync(join(dir, cases[i][0])), cases[i][1], 640, join(out, `node${i}.webp`));
      if (KNOWN_WEBP.has(cases[i][0])) assert.deepEqual([node, phpOut[i]], [false, true], `known difference ${cases[i][0]} no longer differs`);
      else if (node !== phpOut[i]) mismatches.push({ file: cases[i][0], node, php: phpOut[i] });
    }
    assert.deepEqual(mismatches, []);
    assert.ok(phpOut.filter((x) => x === true).length > 200 && phpOut.filter((x) => x === false).length > 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- oys_storage_move_to_data_dir(): über Dateisystemgrenzen

// rename() über zwei Dateisysteme kopiert in PHP, übernimmt Besitzer und Rechte und löscht dann das Original – ob das
// Löschen klappt, prüft PHP nicht (die Datei zählt als verschoben). Der alte Ordner verweigert hier das Löschen
// (chattr +a), das Ziel liegt in /dev/shm (anderes Dateisystem).
test('moving uploads to another file system counts files like PHP when the old folder refuses deletion', { skip: PHP_SKIP }, (t) => {
  const base = mkdtempSync(join(tmpdir(), 'oys-xdev-'));
  const targets: string[] = [];
  const locked: string[] = [];
  try {
    const BASE = loadConfig();
    const results: Record<string, unknown> = {};
    for (const side of ['php', 'node'] as const) {
      const code = join(base, side);
      const from = join(code, 'static/uploads');
      mkdirSync(join(code, 'lib'), { recursive: true });
      mkdirSync(from, { recursive: true });
      writeFileSync(join(code, 'lib/storage.php'), readFileSync(phpRef('lib/storage.php')));
      for (const n of ['avatar_5_1730000000_a1b2c3d4.webp', 'file_5_1730000000_a1b2c3d4.pdf', 'music_6_1730000000_a1b2c3d4.mp3']) writeFileSync(join(from, n), n);
      const target = mkdtempSync('/dev/shm/oys-xdev-');
      targets.push(target);
      try {
        execFileSync('chattr', ['+a', from]);
      } catch {
        t.skip('chattr +a is not available here');
        return;
      }
      locked.push(from);
      const config = { ...BASE, uploads_dir: join(target, 'uploads') };
      if (side === 'php') {
        results.php = JSON.parse(execFileSync('php', ['-d', 'display_errors=stderr', '-r', `
          function oys_config($k = null, $d = null) { $c = json_decode(getenv('OYS_TEST_CONFIG'), true); return $k === null ? $c : ($c[$k] ?? $d); }
          require '${code}/lib/storage.php'; echo json_encode(oys_storage_move_to_data_dir(), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);`], {
          env: { ...process.env, OYS_TEST_CONFIG: JSON.stringify(config) }, stdio: ['ignore', 'pipe', 'ignore'],
        }).toString().replaceAll(target, '<TARGET>'));
      } else {
        setConfigForTests(config);
        setUploadsDefaultDirForTests(from);
        try {
          results.node = JSON.parse(JSON.stringify(storageMoveToDataDir()).replaceAll(target, '<TARGET>'));
        } finally {
          setConfigForTests(BASE);
          setUploadsDefaultDirForTests(null);
        }
      }
      results[side + 'Files'] = [readdirSync(from).sort(), readdirSync(join(target, 'uploads')).sort()];
    }
    assert.deepEqual(results.node, results.php);
    assert.deepEqual(results.nodeFiles, results.phpFiles);
    assert.deepEqual(results.php, { moved: 3, skipped: 0, error: null });
  } finally {
    for (const d of locked) execFileSync('chattr', ['-a', d]);
    for (const d of targets) rmSync(d, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- oys_uploads_dir() und oys_serve_upload(): Randfälle

test('the upload folder setting is read with PHP (string) casts', { skip: PHP_SKIP }, () => {
  const BASE = loadConfig();
  const values: unknown[] = [true, false, 0, '0', '  /srv/up/  ', [], { a: 1 }, 1.5, null, '/', '../oys-uploads', 'C:\\up\\'];
  const mismatches: unknown[] = [];
  try {
    for (const v of values) {
      const ref = execFileSync('php', ['-r', `$c = json_decode($argv[1], true); function oys_config($k, $d = null) { global $c; return $c; }
        require '${phpFile('lib/storage.php')}'; echo json_encode(oys_uploads_dir(), JSON_UNESCAPED_SLASHES);`, JSON.stringify(v)], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      // Relative Angaben rechnet PHP vom eigenen Code-Ordner aus – umgeschrieben auf den dieses Repositorys
      const phpDir = fromPhpTree(ref);
      setConfigForTests({ ...BASE, uploads_dir: v as never });
      const node = JSON.stringify(uploadsDir());
      if (node !== phpDir) mismatches.push({ value: v, node, php: phpDir });
    }
  } finally {
    setConfigForTests(BASE);
  }
  assert.deepEqual(mismatches, []);
});

test('uploads with modification times before 1970 or after 2038 get the same ETag as in PHP', { skip: PHP_SKIP }, async () => {
  const BASE = loadConfig();
  const dir = mkdtempSync(join(tmpdir(), 'oys-mtime-'));
  const times: Record<string, number> = { 'old.txt': -100000, 'epoch.txt': 0, 'second.txt': -1, 'future.txt': 4102444800 };
  for (const [n, t] of Object.entries(times)) {
    writeFileSync(join(dir, n), n);
    // utimesSync() setzt negative Zeiten auf „jetzt“ – touch kann sie
    execFileSync('touch', ['-m', '-d', '@' + t, join(dir, n)]);
    assert.equal(Math.floor(statSync(join(dir, n)).mtimeMs / 1000), t);
  }
  const config = { ...BASE, uploads_dir: dir };
  const phpServer = await startPhpServer(18103, config);
  setConfigForTests(config);
  const app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const nodePort = (app.server.address() as AddressInfo).port;
  const get = (port: number, path: string) => new Promise<[number, string, string, string]>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, agent: false, headers: { Host: 'oys.test:8080' } }, (res) => {
      res.resume();
      res.on('end', () => resolve([res.statusCode ?? 0, String(res.headers.etag), String(res.headers['last-modified']), String(res.headers['content-type'])]));
    }).on('error', reject);
  });
  try {
    for (const n of Object.keys(times)) assert.deepEqual(await get(nodePort, '/static/uploads/' + n), await get(18103, '/static/uploads/' + n), n);
  } finally {
    await app.close();
    await phpServer.stop();
    setConfigForTests(BASE);
    await closePool();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- finfo_file(): Audio, wie es Programme wirklich schreiben

test('finfo MIME types match PHP for RF64 WAV files (as ffmpeg and recorders write them)', { skip: PHP_SKIP }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'oys-rf64-'));
  try {
    const fmt = Buffer.from([0x66, 0x6d, 0x74, 0x20, 16, 0, 0, 0, 1, 0, 1, 0, 0x44, 0xac, 0, 0, 0x88, 0x58, 1, 0, 2, 0, 16, 0]);
    const ds64 = Buffer.concat([Buffer.from('ds64'), Buffer.from([28, 0, 0, 0]), Buffer.alloc(28, 1)]);
    const data = Buffer.concat([Buffer.from('data'), Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.alloc(400, 3)]);
    const files: Record<string, Buffer> = {
      rf64: Buffer.concat([Buffer.from('RF64'), Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from('WAVE'), ds64, fmt, data]),
      rf64_size: Buffer.concat([Buffer.from('RF64'), Buffer.from([0x10, 0, 0, 0]), Buffer.from('WAVE'), ds64, fmt, data]),
      rf64_no_ds64: Buffer.concat([Buffer.from('RF64'), Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from('WAVE'), fmt, data]),
      rf64_short: Buffer.from('RF64\xff\xff\xff\xffWAVEds6', 'latin1'),
      bw64: Buffer.concat([Buffer.from('BW64'), Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from('WAVE'), ds64, fmt, data]),
    };
    for (const [n, b] of Object.entries(files)) writeFileSync(join(dir, n), b);
    const names = Object.keys(files);
    const phpOut = php(`$fi = finfo_open(FILEINFO_MIME_TYPE); return array_map(fn ($f) => finfo_file($fi, '${dir}/' . $f), $in);`, names) as string[];
    assert.deepEqual(names.map((n) => fileMime(files[n])), phpOut);
    assert.equal(phpOut[0], 'audio/x-wav');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
