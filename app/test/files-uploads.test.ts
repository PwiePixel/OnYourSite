// Hochladen gegen PHP: dieselbe Datei geht als echter Upload an oys_handle_upload() (php -S, is_uploaded_file; aus der
// PHP-Version, siehe support/phpRef.ts) und an handleUpload(). Verglichen werden Annahme/Ablehnung mit der genauen
// Meldung, das Muster des gespeicherten Namens (Präfix_Konto_Zeit_Zufall.Endung), Format und Größe des gespeicherten
// Bildes und die Dateirechte. Die Bildpunkte selbst dürfen sich unterscheiden (GD gegen sharp).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import sharp from 'sharp';
import { loadConfig, setConfigForTests } from '../src/config.js';
import { handleUpload, uploadLimitMb } from '../src/content/uploads.js';
import { getImageSize } from '../src/content/imageSize.js';
import { startPhpServer, type PhpServer } from './filesHarness.js';
import { rng } from './modelHarness.js';
import { PHP_SKIP } from './support/phpRef.js';

const BASE = loadConfig();
let tmp = '';
let php: PhpServer;
const dirs = { php: '', node: '' };

before(async () => {
  if (PHP_SKIP) return;
  tmp = mkdtempSync(join(tmpdir(), 'oys-uploads-'));
  dirs.php = join(tmp, 'php');
  dirs.node = join(tmp, 'node');
  mkdirSync(dirs.php);
  php = await startPhpServer(18103, { ...BASE, uploads_dir: dirs.php });
});

after(async () => {
  await php?.stop();
  setConfigForTests(BASE);
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

interface Case {
  kind: string;
  name: string | null;
  data: Buffer;
  user?: number;
  // Node bekommt, was server.ts aus der Anfrage macht (16 MiB: Fehler 1, keine Datei: Fehler 4)
  error?: number;
}

function multipart(c: Case): { body: Buffer; type: string } {
  const boundary = '----oysfiles' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  const field = (n: string, v: string) => parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`));
  field('kind', c.kind);
  field('user', String(c.user ?? 5));
  if (c.name !== null) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${c.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), c.data, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
}

function postPhp(c: Case): Promise<{ res: Record<string, string>; img: unknown; colors: string | null; mode: string | null; limit: number }> {
  const { body, type } = multipart(c);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: 18103, path: '/upload', method: 'POST', headers: { 'Content-Type': type, 'Content-Length': body.length } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (x) => chunks.push(x));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch {
          reject(new Error('PHP answered: ' + Buffer.concat(chunks).toString().slice(0, 500)));
        }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

// Zeit und Zufall im Namen vereinheitlichen; die Form selbst wird geprüft
function normName(res: Record<string, string>): Record<string, string> {
  if (!('file' in res)) return res;
  const m = /^([a-z]+)_(\d+)_(\d{9,11})_([0-9a-f]{8})\.([a-z0-9]+)$/.exec(res.file);
  return { file: m ? `${m[1]}_${m[2]}_TIME_HEX.${m[5]}` : 'BAD:' + res.file };
}

async function cases(): Promise<Array<[string, Case]>> {
  const r = rng(7);
  const rnd = (n: number) => Buffer.from(Array.from({ length: n }, () => r.next(256)));
  const W = 90;
  const H = 50;
  const raw = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    const tl = x < 30 && y < 20;
    raw[i] = tl ? 230 : 20;
    raw[i + 1] = x >= 60 && y < 20 ? 230 : 20;
    raw[i + 2] = 200;
  }
  const asym = sharp(raw, { raw: { width: W, height: H, channels: 3 } });
  const alpha = sharp({ create: { width: 700, height: 500, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 0.3 } } });
  const out: Array<[string, Case]> = [];
  for (let o = 1; o <= 8; o++) out.push([`jpeg orientation ${o}`, { kind: 'image', name: `photo${o}.jpg`, data: await asym.clone().jpeg().withMetadata({ orientation: o }).toBuffer() }]);
  // Ein Byte zu viel hinter dem Exif-Abschnitt: GD liest das Bild, exif_read_data() scheitert aber am Kopf → keine Drehung
  const rotated = await asym.clone().jpeg().withMetadata({ orientation: 6 }).toBuffer();
  let app1End = 2;
  while (rotated[app1End + 1] !== 0xe1) app1End += 2 + rotated.readUInt16BE(app1End + 2);
  app1End += 2 + rotated.readUInt16BE(app1End + 2);
  out.push(['jpeg orientation 6 with a stray byte after the Exif segment', { kind: 'image', name: 'stray.jpg', data: Buffer.concat([rotated.subarray(0, app1End), Buffer.from([0]), rotated.subarray(app1End)]) }]);
  const png = await alpha.clone().png().toBuffer();
  const jpgBig = await sharp({ create: { width: 3000, height: 1700, channels: 3, background: '#336699' } }).jpeg().toBuffer();
  const tallPng = await sharp({ create: { width: 900, height: 2500, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0.5 } } }).png().toBuffer();
  const webp = await alpha.clone().webp().toBuffer();
  const animated = await sharp([await sharp({ create: { width: 20, height: 20, channels: 3, background: '#fff' } }).png().toBuffer(),
    await sharp({ create: { width: 20, height: 20, channels: 3, background: '#000' } }).png().toBuffer()], { join: { animated: true } });
  const hugeHeader = Buffer.from(png);
  hugeHeader.writeUInt32BE(8000, 16);
  hugeHeader.writeUInt32BE(5001, 20);
  const exactly40 = Buffer.from(png);
  exactly40.writeUInt32BE(8000, 16);
  exactly40.writeUInt32BE(5000, 20);
  const mp3 = Buffer.concat(Array.from({ length: 30 }, () => Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), rnd(413)])));
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.from([36 + 400, 1, 0, 0]), Buffer.from('WAVEfmt '), Buffer.from([16, 0, 0, 0, 1, 0, 2, 0, 0x44, 0xac, 0, 0, 0x10, 0xb1, 2, 0, 4, 0, 16, 0]), Buffer.from('data'), Buffer.from([0x90, 1, 0, 0]), rnd(400)]);
  const ogg = (codec: string) => Buffer.concat([Buffer.from('OggS'), Buffer.from([0, 2]), Buffer.alloc(22), Buffer.from(codec, 'latin1'), rnd(400)]);
  const ftyp = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftyp' + brand), Buffer.from([0, 0, 2, 0]), Buffer.from('isommp41'), Buffer.from([0, 0, 0, 16]), Buffer.from('mdat'), rnd(500)]);
  const zip = (first: string) => {
    const name = Buffer.from(first);
    const head = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.alloc(14), Buffer.from([1, 0, 0, 0, 1, 0, 0, 0]), Buffer.from([name.length, 0, 0, 0]), name, Buffer.from('x')]);
    return Buffer.concat([head, Buffer.alloc(40, 0x41)]);
  };
  out.push(
    ['png with alpha (avatar)', { kind: 'avatar', name: 'me.png', data: png }],
    ['palette png (thumb)', { kind: 'thumb', name: 'p.PNG', data: await alpha.clone().png({ palette: true }).toBuffer() }],
    ['webp (gallery)', { kind: 'gallery', name: 'g.webp', data: webp }],
    ['webp lossless (bg)', { kind: 'bg', name: 'g.webp', data: await alpha.clone().webp({ lossless: true }).toBuffer() }],
    ['animated webp stays', { kind: 'image', name: 'anim.webp', data: await animated.clone().webp().toBuffer() }],
    ['gif stays', { kind: 'image', name: 'x.gif', data: await animated.clone().gif().toBuffer() }],
    ['big jpeg (bg 2200)', { kind: 'bg', name: 'big.jpeg', data: jpgBig }],
    ['big jpeg (avatar 640)', { kind: 'avatar', name: 'big.JPG', data: jpgBig }],
    ['tall png (image 1600)', { kind: 'image', name: 'tall.png', data: tallPng }],
    ['tiny jpeg', { kind: 'image', name: 'tiny.jpg', data: await sharp({ create: { width: 1, height: 1, channels: 3, background: '#f00' } }).jpeg().toBuffer() }],
    ['thin webp', { kind: 'thumb', name: 't.webp', data: await sharp({ create: { width: 2000, height: 3, channels: 3, background: '#0f0' } }).webp().toBuffer() }],
    ['cmyk jpeg', { kind: 'image', name: 'c.jpg', data: await sharp({ create: { width: 64, height: 48, channels: 3, background: '#c84' } }).toColourspace('cmyk').jpeg().toBuffer() }],
    ['more than 40 MP header', { kind: 'image', name: 'huge.png', data: hugeHeader }],
    ['exactly 40 MP header (broken data)', { kind: 'image', name: 'huge40.png', data: exactly40 }],
    ['avif named jpg stays', { kind: 'image', name: 'a.jpg', data: await alpha.clone().avif().toBuffer() }],
    ['tiff named png stays', { kind: 'image', name: 't.png', data: await alpha.clone().tiff().toBuffer() }],
    ['png named jpg stays', { kind: 'image', name: 'p.jpg', data: png }],
    ['jpeg named webp stays', { kind: 'image', name: 'j.webp', data: jpgBig }],
    ['truncated png stays', { kind: 'image', name: 'cut.png', data: png.subarray(0, png.length >> 1) }],
    ['truncated jpeg', { kind: 'image', name: 'cut.jpg', data: jpgBig.subarray(0, jpgBig.length >> 1) }],
    ['text named png', { kind: 'image', name: 'notes.png', data: Buffer.from('just text') }],
    ['xbm text named png', { kind: 'image', name: 'x.png', data: Buffer.from('#define a_width 3\n#define a_height 2\n') }],
    ['double extension', { kind: 'image', name: 'photo.php.jpg', data: await asym.clone().jpeg().toBuffer() }],
    ['svg not allowed', { kind: 'image', name: 'logo.svg', data: Buffer.from('<svg/>') }],
    ['no extension', { kind: 'image', name: 'photo', data: png }],
    ['hidden name', { kind: 'avatar', name: '.png', data: png }],
    ['unknown kind', { kind: 'banner', name: 'b.png', data: png }],
    ['empty kind', { kind: '', name: 'b.png', data: png }],
    ['no file', { kind: 'image', name: null, data: Buffer.alloc(0), error: 4 }],
    ['empty file name', { kind: 'image', name: '', data: Buffer.alloc(0), error: 4 }],
    ['too big for the kind', { kind: 'avatar', name: 'big.png', data: Buffer.concat([png, Buffer.alloc(9 * 1024 * 1024)]) }],
    ['too big for the server', { kind: 'music', name: 'long.mp3', data: Buffer.alloc(17 * 1024 * 1024), error: 1 }],
    ['mp3', { kind: 'music', name: 'song.mp3', data: mp3 }],
    ['mp3 with id3', { kind: 'music', name: 'song.MP3', data: Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x0a', 'latin1'), Buffer.alloc(10), mp3]) }],
    ['wav named mp3', { kind: 'music', name: 'song.mp3', data: wav }],
    ['random bytes named mp3', { kind: 'music', name: 'noise.mp3', data: rnd(3000) }],
    ['empty mp3', { kind: 'music', name: 'empty.mp3', data: Buffer.alloc(0) }],
    ['text named mp3', { kind: 'music', name: 'readme.mp3', data: Buffer.from('hello world\n') }],
    ['wav', { kind: 'music', name: 'a.wav', data: wav }],
    ['ogg vorbis', { kind: 'music', name: 'a.ogg', data: ogg('\x01\x1e\x01vorbis') }],
    ['ogg unknown codec', { kind: 'music', name: 'a.ogg', data: ogg('\x01\x00nothing') }],
    ['m4a', { kind: 'music', name: 'a.m4a', data: ftyp('M4A ') }],
    ['mp4 video named m4a', { kind: 'music', name: 'a.m4a', data: ftyp('isom') }],
    ['quicktime named m4a', { kind: 'music', name: 'a.m4a', data: ftyp('qt  ') }],
    ['flac not allowed', { kind: 'music', name: 'a.flac', data: Buffer.from('fLaC') }],
    ['pdf', { kind: 'file', name: 'cv.pdf', data: Buffer.from('%PDF-1.4\n%%EOF\n') }],
    ['text named pdf', { kind: 'file', name: 'cv.pdf', data: Buffer.from('not a pdf') }],
    ['vcf', { kind: 'file', name: 'mia.vcf', data: Buffer.from('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Mia\r\nEND:VCARD\r\n') }],
    ['plain text vcf', { kind: 'file', name: 'mia.vcf', data: Buffer.from('Mia Sommer\nmia@test.de\n') }],
    ['html named vcf', { kind: 'file', name: 'x.vcf', data: Buffer.from('<html><body>x</body></html>') }],
    ['empty vcf', { kind: 'file', name: 'x.vcf', data: Buffer.alloc(0) }],
    ['zip', { kind: 'file', name: 'a.zip', data: zip('a.txt') }],
    ['docx named zip', { kind: 'file', name: 'a.zip', data: zip('word/document.xml') }],
    ['exe named zip', { kind: 'file', name: 'a.zip', data: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]) }],
    ['image as file', { kind: 'file', name: 'a.png', data: png }],
    ['other account', { kind: 'image', name: 'x.png', data: png, user: 6 }],
  );
  return out;
}

test('uploads are accepted, rejected, named and converted like PHP', { skip: PHP_SKIP }, async () => {
  setConfigForTests({ ...BASE, uploads_dir: dirs.node });
  const mismatches: unknown[] = [];
  let limit = 0;
  try {
    for (const [label, c] of await cases()) {
      const p = await postPhp(c);
      limit = p.limit;
      const upload = c.error !== undefined || c.name === null
        ? { name: c.name ?? '', type: '', size: 0, data: Buffer.alloc(0), error: c.error ?? 4 }
        : { name: c.name, type: 'application/octet-stream', size: c.data.length, data: c.data, error: 0 };
      const res = await handleUpload(c.name === null ? undefined : upload, c.kind, c.user ?? 5);
      let img: unknown = null;
      let mode: string | null = null;
      let colors: string | null = null;
      if ('file' in res) {
        const stored = join(dirs.node, res.file);
        const bytes = readFileSync(stored);
        const info = getImageSize(bytes);
        // Animierte WebP kann GD nicht lesen – dort gibt es auf der PHP-Seite keine Farben
        const animatedWebp = bytes.toString('latin1', 12, 16) === 'VP8X' && (bytes[20] & 2) !== 0;
        if (info?.type === 18 && !animatedWebp) {
          const { data, info: ri } = await sharp(stored).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
          colors = '';
          for (const [x, y] of [[0.15, 0.2], [0.85, 0.2], [0.15, 0.8], [0.85, 0.8]]) {
            const o = (Math.trunc(y * (ri.height - 1)) * ri.width + Math.trunc(x * (ri.width - 1))) * 4;
            colors += data[o] > 150 ? 'R' : data[o + 1] > 150 ? 'G' : data[o + 2] > 150 ? 'B' : '?';
          }
        }
        img = info ? [info.width, info.height, ({ 1: 'image/gif', 2: 'image/jpeg', 3: 'image/png', 7: 'image/tiff', 16: 'image/xbm', 18: 'image/webp', 19: 'image/avif' } as Record<number, string>)[info.type] ?? String(info.type)] : null;
        mode = (statSync(stored).mode & 0o777).toString(8);
      }
      const node = { res: normName(res as Record<string, string>), img, colors, mode };
      const ref = { res: normName(p.res), img: p.img, colors: p.colors, mode: p.mode };
      if (JSON.stringify(node) !== JSON.stringify(ref)) mismatches.push({ label, node, php: ref });
    }
  } finally {
    setConfigForTests(BASE);
  }
  assert.deepEqual(mismatches, []);
  // Grenze des Servers: PHP mit 16M/20M wie im Installer, Node mit den Grenzen aus server.ts
  assert.equal(uploadLimitMb(), limit);
});
