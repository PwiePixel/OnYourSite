// Erkennung beim Hochladen gegen PHP: getimagesize() (ist es ein Bild, welche Größe?) und finfo_file() (passt der
// Inhalt zur Endung?) – auf echten Bildern, Audio-, Dokument- und Textdateien, abgeschnittenen und zufällig
// veränderten Varianten. Verglichen wird das Ergebnis jeder Datei.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';
import sharp from 'sharp';
import { getImageSize } from '../src/content/imageSize.js';
import { fileMime } from '../src/content/fileMime.js';
import { rng } from './modelHarness.js';

let dir = '';
const r = rng(20261101);
const rnd = (n: number) => Buffer.from(Array.from({ length: n }, () => r.next(256)));
const b = (s: string) => Buffer.from(s, 'latin1');
const u32be = (n: number) => { const x = Buffer.alloc(4); x.writeUInt32BE(n >>> 0); return x; };
const u32le = (n: number) => { const x = Buffer.alloc(4); x.writeUInt32LE(n >>> 0); return x; };
const u16le = (n: number) => { const x = Buffer.alloc(2); x.writeUInt16LE(n); return x; };

// Kleines ZIP (gespeichert oder komprimiert) mit Einträgen in dieser Reihenfolge, optional mit Zusatzfeld am ersten
function zip(entries: Array<[string, string]>, opts: { deflate?: boolean; extra?: Buffer } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let off = 0;
  entries.forEach(([name, text], i) => {
    const data = Buffer.from(text);
    const body = opts.deflate ? deflateRawSync(data) : data;
    const nameB = Buffer.from(name);
    const extra = i === 0 && opts.extra ? opts.extra : Buffer.alloc(0);
    const head = Buffer.concat([b('PK\x03\x04'), u16le(20), u16le(0), u16le(opts.deflate ? 8 : 0), u16le(0), u16le(0x21), u32le(crc32(data)),
      u32le(body.length), u32le(data.length), u16le(nameB.length), u16le(extra.length), nameB, extra]);
    locals.push(head, body);
    centrals.push(Buffer.concat([b('PK\x01\x02'), u16le(0x31e), u16le(20), u16le(0), u16le(opts.deflate ? 8 : 0), u16le(0), u16le(0x21), u32le(crc32(data)),
      u32le(body.length), u32le(data.length), u16le(nameB.length), u16le(0), u16le(0), u16le(0), u16le(0), u32le(0), u32le(off), nameB]));
    off += head.length + body.length;
  });
  const cd = Buffer.concat(centrals);
  return Buffer.concat([...locals, cd, b('PK\x05\x06'), u16le(0), u16le(0), u16le(entries.length), u16le(entries.length), u32le(cd.length), u32le(off), u16le(0)]);
}

function riff(form: string, chunk = 'fmt ', body: Buffer = Buffer.from([1, 0, 2, 0, 0x44, 0xac, 0, 0, 0x10, 0xb1, 2, 0, 4, 0, 16, 0])): Buffer {
  const data = Buffer.concat([b(form + chunk), u32le(body.length), body, b('data'), u32le(400), rnd(400)]);
  return Buffer.concat([b('RIFF'), u32le(data.length), data]);
}

const mp3 = (hdr: string, n = 20) => Buffer.concat(Array.from({ length: n }, () => Buffer.concat([b(hdr), rnd(413)])));
const ftyp = (brand: string) => Buffer.concat([u32be(24), b('ftyp' + brand), Buffer.from([0, 0, 2, 0]), b('isommp41'), u32be(16), b('mdat'), rnd(508)]);

async function makeCorpus(d: string): Promise<void> {
  const w = (name: string, data: Buffer | string) => writeFileSync(join(d, name), data);
  // Audio
  w('mp3_frames', mp3('\xff\xfb\x90\x64'));
  w('mp3_id3', Buffer.concat([b('ID3\x03\x00\x00\x00\x00\x00\x0a'), Buffer.alloc(10), mp3('\xff\xfb\x90\x64')]));
  w('mp3_id3_only', Buffer.concat([b('ID3\x03\x00\x00\x00\x00\x00\x0a'), Buffer.alloc(10)]));
  for (const [n, h] of [['v2l3', '\xff\xf3\x90\x64'], ['v25', '\xff\xe3\x90\x64'], ['l2', '\xff\xfd\x90\x64'], ['rate0', '\xff\xfb\x00\x64'], ['ratef', '\xff\xfb\xf0\x64'],
    ['aac', '\xff\xf1\x50\x80'], ['aac2', '\xff\xf9\x50\x80'], ['loas', '\x56\xe0\x50\x80']]) w('mp3_' + n, mp3(h));
  w('mp3_garbage_first', Buffer.concat([rnd(300), mp3('\xff\xfb\x90\x64')]));
  for (const brand of ['M4A ', 'M4B ', 'M4P ', 'M4V ', 'isom', 'mp42', 'mp41', '3gp4', 'qt  ', 'dash', 'heic', 'avif', 'iso2', 'MSNV', 'XAVC', 'f4v ', 'F4A ', 'JP20', 'mmp4', 'zzzz'])
    w('mp4_' + brand.trim(), ftyp(brand));
  const ogg = (codec: string, rev = 0) => Buffer.concat([b('OggS'), Buffer.from([rev, 2]), Buffer.alloc(22), b(codec), rnd(400)]);
  for (const [n, c] of [['vorbis', '\x01\x1e\x01vorbis'], ['opus', '\x01\x13OpusHead'], ['flac', '\x01\x33\x7fFLAC'], ['theora', '\x01\x2a\x80theora'],
    ['speex', '\x01\x50Speex   '], ['other', '\x01\x00nothing']]) w('ogg_' + n, ogg(c));
  w('ogg_rev', ogg('\x01\x1e\x01vorbis', 1));
  w('wav', riff('WAVE'));
  w('wav_rifx', Buffer.concat([b('RIFX'), riff('WAVE').subarray(4)]));
  w('wav_rf64', Buffer.concat([b('RF64'), riff('WAVE').subarray(4)]));
  w('avi', riff('AVI ', 'LIST'));
  w('riff_other', riff('XXXX'));
  w('flac', Buffer.concat([b('fLaC\0\0\0\x22'), rnd(400)]));
  w('midi', Buffer.concat([b('MThd\0\0\0\x06\0\x01\0\x02\x01\xe0'), rnd(100)]));
  w('webm', Buffer.concat([Buffer.from('1a45dfa39f4286810142f7810142f2810442f381084282847765626d42878104428581021853', 'hex'), rnd(300)]));
  w('mkv', Buffer.concat([Buffer.from('1a45dfa39f4286810142f7810142f2810442f381084282886d6174726f736b6142878104428581021853', 'hex'), rnd(300)]));
  // Dokumente
  w('pdf', b('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n'));
  w('pdf_bom', Buffer.concat([b('\xef\xbb\xbf%PDF-1.4\n'), rnd(200)]));
  w('pdf_nl', Buffer.concat([b('\n%PDF-1.4\n'), rnd(200)]));
  w('pdf_text_later', 'hello world\n'.repeat(5) + '%PDF-1.4\n' + 'abc\n'.repeat(20));
  w('pdf_binary_later', Buffer.concat([Buffer.from(rnd(100).map((x) => (x === 0x25 ? 0x26 : x))), b('%PDF-1.4\n'), rnd(200)]));
  w('zip', zip([['a.txt', 'hello'], ['b/c.txt', 'x'.repeat(100)]]));
  w('zip_deflate', zip([['a.txt', 'hello '.repeat(100)]], { deflate: true }));
  w('zip_empty', Buffer.concat([b('PK\x05\x06'), Buffer.alloc(18)]));
  w('zip_docx', zip([['[Content_Types].xml', '<Types/>'], ['_rels/.rels', '<x/>'], ['word/document.xml', '<w/>']]));
  w('zip_xlsx', zip([['[Content_Types].xml', '<Types/>'], ['_rels/.rels', '<x/>'], ['xl/workbook.xml', '<w/>']]));
  w('zip_ooxml_other', zip([['[Content_Types].xml', '<Types/>'], ['_rels/.rels', '<x/>'], ['other/x.xml', '<w/>'], ['more.xml', '<y/>']]));
  w('zip_odt', zip([['mimetype', 'application/vnd.oasis.opendocument.text'], ['content.xml', '<x/>']]));
  w('zip_epub', zip([['mimetype', 'application/epub+zip'], ['META-INF/container.xml', '<x/>']]));
  w('zip_kde', zip([['mimetype', 'application/vnd.kde.kword'], ['x', 'y']]));
  w('zip_mime_other', zip([['mimetype', 'text/plain'], ['a', 'b']]));
  w('zip_jar', zip([['META-INF/', ''], ['META-INF/MANIFEST.MF', 'Manifest-Version: 1.0\n']], { extra: Buffer.from([0xfe, 0xca, 0, 0]) }));
  w('zip_ios', zip([['Payload/My.app/Info.plist', 'x'.repeat(80)]]));
  w('zip_bad_start', Buffer.concat([b('X'), zip([['a.txt', 'hello'], ['b.txt', 'world']]).subarray(1)]));
  w('zip_sfx', Buffer.concat([b('MZ'), Buffer.alloc(100), zip([['a.txt', 'hello']])]));
  w('rar', Buffer.concat([b('Rar!\x1a\x07\x00'), rnd(100)]));
  w('7z', Buffer.concat([b('7z\xbc\xaf\x27\x1c'), rnd(100)]));
  w('gzip', Buffer.concat([b('\x1f\x8b\x08\x00'), rnd(100)]));
  w('ole2', Buffer.concat([b('\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1'), rnd(600)]));
  // vCard und Text
  w('vcf', 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Mia Sommer\r\nEMAIL:mia@test.de\r\nEND:VCARD\r\n');
  w('vcf_lower', 'begin:vcard\nversion:3.0\nfn:Mia\nend:vcard\n');
  w('vcf_bom', '﻿BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Müller\r\nEND:VCARD\r\n');
  w('vcf_leading_nl', '\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nEND:VCARD\r\n');
  w('vcf_latin1', b('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:J\xfcrgen Gr\xf6\xdfe\r\nEND:VCARD\r\n'));
  w('vcf_utf16', Buffer.from('﻿BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Mia\r\nEND:VCARD\r\n', 'utf16le'));
  w('vcf_version_end', 'BEGIN:VCARD\r\nVERSION:END\r\n');
  w('ical', 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n');
  const texts = ['Hello, plain text.\nSecond line.\n', 'hello', 'Grüße aus München – schön 🐝\n', 'a,b\nc,d\n', 'a,b\nc,d\ne,f\ng,h\n', '"x,y",z\n1,2\n3,4\n5,6\n',
    'name;email\nMia;mia@test.de\nTom;tom@test.de\n', '{"a": 1, "b": [1, 2]}\n', '[1, 2, 3]', '{"a":1}\n{"b":2}\n', '[1, 2', 'tru', '"just a string"',
    '<!DOCTYPE html>\n<html><body>x</body></html>', '<html>\n<body>hi</body>\n</html>\n', '<?xml version="1.0"?>\n<root/>\n',
    '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>\n', '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n', '#!/bin/sh\necho hi\n',
    '#! /bin/bash\n', '#!/usr/bin/env bash\n', '#!/usr/bin/env python3\n', '#!/usr/bin/env foo\n', '#!/bin/shell\n', '#include <stdio.h>\nint x;\n',
    '  #include <x.h>\n', '#ifdef X\n#define Y 1\n#endif\n', 'struct x { int a; };\n', 'extern int a;\n', '<?php echo 1;', 'From: mia@test.de\nTo: x\n\nbody\n',
    'From mia@test.de Mon Jan  1 00:00:00 2024\n', 'Received: by x\n', 'Return-Path: <a@b>\n', '%!PS-Adobe-3.0\n', '{\\rtf1\\ansi hi}\n', '\x1b[1mbold\x1b[0m\n',
    'page1\fpage2\n', 'x'.repeat(70000), 'line\n'.repeat(20000), 'tab\tsep\tvalues\n', ['-----BEGIN', 'CERTIFICATE-----\nMIIB\n-----END', 'CERTIFICATE-----\n'].join(' '), // erfundenes Bruchstück, zur Laufzeit zusammengesetzt
    'a\x00', 'ab\x00\x00\x00', '\x00ab', 'hello\x00world', 'hello\x01world\n', '   \n  \n', '\r\n', 'x'];
  texts.forEach((t, i) => w(`text${String(i).padStart(2, '0')}`, t));
  w('text_latin1', b('Gr\xfc\xdfe aus M\xfcnchen\n'));
  w('text_cp1252', b('Quote \x93x\x94 and \x80 euro\n'));
  w('empty', '');
  w('nul', Buffer.alloc(50));
  w('random', rnd(2000));
  w('random_small', rnd(10));
  w('elf', Buffer.concat([b('\x7fELF\x02\x01\x01'), Buffer.alloc(9), Buffer.from([2, 0, 0x3e, 0]), rnd(200)]));
  w('mz', Buffer.concat([b('MZ'), rnd(200)]));
  w('sqlite', Buffer.concat([b('SQLite format 3\0'), rnd(100)]));
  // DOS-Bootsektor (Regel ohne MIME, sehr stark) und MPEG-Rahmen, die zufällig so aussehen – auch knapp zu kurz
  const fat = (head: number[], sector: number, media: number, len: number, fill = 0) => {
    const x = Buffer.alloc(len, fill);
    Buffer.from(head).copy(x);
    if (len >= 13) x.writeUInt16LE(sector, 11);
    if (len >= 22) x[21] = media;
    return x;
  };
  for (const len of [21, 22, 24, 25, 26, 62, 512]) {
    w(`fat_eb_${len}`, fat([0xeb, 0x3c, 0x90, 0x4d, 0x53, 0x44, 0x4f, 0x53], 512, 0xf0, len));
    w(`fat_mpeg_${len}`, fat([0xff, 0xfd, 0x90, 0x44], 0x4f80, 0xf5, len, 0x55));
    w(`fat_plain_${len}`, fat([0xff, 0xfb, 0x90, 0x00], 512, 0xf0, len));
  }
  w('fat_bad_sector', fat([0xff, 0xfb, 0x90, 0x44], 0x4f81, 0xf5, 100, 0x55));
  w('fat_bad_media', fat([0xff, 0xfb, 0x90, 0x44], 0x4f80, 0xe5, 100, 0x55));
  w('fat_bom_text', Buffer.concat([b('\xef\xbb\xbfHello World x'), Buffer.from('🐝 bees and more text\n')]));
  // Bilder (echte Dateien und Kopf-Varianten)
  const base = sharp({ create: { width: 40, height: 30, channels: 4, background: { r: 200, g: 50, b: 50, alpha: 0.5 } } });
  const images: Record<string, Buffer> = {
    jpg: await base.clone().jpeg().toBuffer(), jpg_prog: await base.clone().jpeg({ progressive: true }).toBuffer(), png: await base.clone().png().toBuffer(),
    png_pal: await base.clone().png({ palette: true }).toBuffer(), webp: await base.clone().webp().toBuffer(), webp_lossless: await base.clone().webp({ lossless: true }).toBuffer(),
    gif: await base.clone().gif().toBuffer(), tiff: await base.clone().tiff().toBuffer(), avif: await base.clone().avif().toBuffer(),
  };
  for (const [n, data] of Object.entries(images)) w('img_' + n, data);
  w('wbmp', Buffer.from([0, 0, 10, 20, 0xff, 0xff]));
  w('wbmp_big', Buffer.from([0, 0, 0x90, 0x01, 0x05]));
  w('xbm', '#define test_width 16\n#define test_height 7\nstatic char test_bits[] = {0};\n');
  w('xbm_neg', '#define a_width -3\n#define a_height 2\n');
  w('bmp_core', Buffer.concat([b('BM'), Buffer.alloc(12), Buffer.from([12, 0, 0, 0, 5, 0, 7, 0, 1, 0, 24, 0])]));
  w('bmp_neg', (() => { const x = Buffer.alloc(54); x.write('BM'); x.writeInt32LE(40, 14); x.writeInt32LE(10, 18); x.writeInt32LE(-20, 22); return x; })());
  w('psd', (() => { const x = Buffer.alloc(30); x.write('8BPS'); x.writeUInt32BE(30, 14); x.writeUInt32BE(40, 18); return x; })());
  w('ico', (() => { const x = Buffer.alloc(38); x.writeUInt16LE(1, 2); x.writeUInt16LE(2, 4); x[6] = 16; x[7] = 16; x.writeUInt16LE(8, 12); x.writeUInt16LE(32, 28); return x; })());
  w('swf', Buffer.concat([b('FWS'), Buffer.from([8, 0, 0, 0, 0, 0x78, 0x00, 0x05, 0x5f, 0x00, 0x00, 0x0f, 0xa0, 0x00]), Buffer.alloc(40)]));
  w('iff', (() => { const x = Buffer.alloc(40); x.write('FORM'); x.writeUInt32BE(32, 4); x.write('ILBM', 8); x.write('BMHD', 12); x.writeInt32BE(20, 16); x.writeInt16BE(320, 20); x.writeInt16BE(200, 22); x[28] = 8; return x; })());
  w('jpc', Buffer.concat([Buffer.from([0xff, 0x4f, 0xff, 0x51, 0, 41, 0, 0, 0, 0, 0, 77, 0, 0, 0, 66]), Buffer.alloc(24), Buffer.from([0, 1, 7, 1, 1])]));
  const png = Buffer.from(images.png);
  png.writeUInt32BE(9000, 16);
  png.writeUInt32BE(5000, 20);
  w('png_huge_header', png);
  // Abgeschnittene und zufällig veränderte Varianten aller bisherigen Dateien
  for (const f of readdirSync(d)) {
    const data = readFileSync(join(d, f));
    if (!data.length) continue;
    for (const cut of [1, 2, 3, 4, 8, 12, 16, 30, 40, 50, 64]) if (cut < data.length) w(`${f}.c${cut}`, data.subarray(0, cut));
    for (let k = 0; k < 4; k++) {
      const c = Buffer.from(data);
      for (let j = 0; j < 1 + r.next(3); j++) c[r.next(Math.min(c.length, 64))] = r.pick([0, 0x0a, 0x20, 0x41, 0x7f, 0x80, 0xff, r.next(256)]);
      w(`${f}.f${k}`, c);
    }
  }
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'oys-detect-'));
  await makeCorpus(dir);
});

after(() => {
  if (dir && !process.env.OYS_KEEP_CORPUS) rmSync(dir, { recursive: true, force: true });
  else if (dir) console.log('corpus kept in ' + dir);
});

test('getimagesize() decisions and sizes match PHP', () => {
  const files = readdirSync(dir).sort();
  const php = JSON.parse(execFileSync('php', ['-r', `$o = []; foreach (json_decode(stream_get_contents(STDIN), true) as $f) { $r = @getimagesize('${dir}/' . $f); $o[] = $r ? [$r[0], $r[1], $r[2]] : false; } echo json_encode($o);`],
    { input: JSON.stringify(files), maxBuffer: 1 << 26 }).toString()) as unknown[];
  const node = files.map((f) => {
    const s = getImageSize(readFileSync(join(dir, f)));
    return s ? [s.width, s.height, s.type] : false;
  });
  const mismatches = files.map((f, i) => ({ f, node: node[i], php: php[i] })).filter((m) => JSON.stringify(m.node) !== JSON.stringify(m.php));
  assert.deepEqual(mismatches, []);
  assert.ok(files.length > 1500 && php.filter(Boolean).length > 100);
});

// Bekannt (Datei → [Node, PHP]): die Regel für dBase-Memo-Dateien („16 ubyte <4“, Stärke 10, viele Unterbedingungen)
// ist nicht nachgebaut – Node meldet application/octet-stream. Für die erlaubten Endungen zählt das nur bei .mp3/.m4a
// (dort ließe Node eine solche Datei zu, PHP nicht); echte Musik hat diese Bytes nicht.
const KNOWN_MIME: Record<string, [node: string, php: string]> = { 'fat_eb_24.f1': ['application/octet-stream', 'application/x-dbt'] };

test('finfo MIME types match PHP for audio, documents, text and images', () => {
  const files = readdirSync(dir).sort();
  const php = JSON.parse(execFileSync('php', ['-r', `$fi = finfo_open(FILEINFO_MIME_TYPE); $o = []; foreach (json_decode(stream_get_contents(STDIN), true) as $f) { $o[] = finfo_file($fi, '${dir}/' . $f); } echo json_encode($o);`],
    { input: JSON.stringify(files), maxBuffer: 1 << 26 }).toString()) as string[];
  const mismatches = files.map((f, i) => ({ f, node: fileMime(readFileSync(join(dir, f))), php: php[i] })).filter((m) => m.node !== m.php && !Object.hasOwn(KNOWN_MIME, m.f));
  assert.deepEqual(mismatches, []);
  // Die bekannten Abweichungen sind tatsächlich noch welche (sonst gehören sie aus der Liste)
  for (const [f, [node, phpMime]] of Object.entries(KNOWN_MIME)) {
    assert.deepEqual([fileMime(readFileSync(join(dir, f))), php[files.indexOf(f)]], [node, phpMime], f);
  }
  assert.ok(new Set(php).size > 40);
});
