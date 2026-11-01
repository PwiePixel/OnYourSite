// getimagesize() wie PHP 8.3 (ext/standard/image.c mit libavifinfo): Typ an den ersten Bytes erkennen, dann Breite und
// Höhe aus dem Kopf lesen. Entscheidet beim Hochladen, ob eine Datei „ein gültiges Bild“ ist – auch für Formate, die
// die Seite gar nicht verarbeitet (BMP, TIFF, XBM, WBMP …): PHP nimmt sie an und speichert sie unverändert.
import { inflateSync } from 'node:zlib';

export const IMAGETYPE = {
  UNKNOWN: 0, GIF: 1, JPEG: 2, PNG: 3, SWF: 4, PSD: 5, BMP: 6, TIFF_II: 7, TIFF_MM: 8, JPC: 9, JP2: 10,
  JPX: 11, JB2: 12, SWC: 13, IFF: 14, WBMP: 15, XBM: 16, ICO: 17, WEBP: 18, AVIF: 19,
} as const;

export interface ImageSize {
  width: number;
  height: number;
  type: number;
}

// Datei als PHP-Datenstrom (plain file): Lesen liefert, was da ist; Springen hinter das Ende klappt, davor nicht
class Stream {
  pos = 0;
  eof = false;
  constructor(readonly buf: Buffer) {}

  read(n: number): Buffer {
    const start = Math.min(this.pos, this.buf.length);
    const end = Math.min(this.buf.length, start + Math.max(0, n));
    const out = this.buf.subarray(start, end);
    this.pos = this.pos + out.length;
    if (out.length < n) this.eof = true;
    return out;
  }

  getc(): number {
    if (this.pos >= this.buf.length) {
      this.eof = true;
      return -1;
    }
    return this.buf[this.pos++];
  }

  // php_stream_seek(): 0 = geklappt, -1 = Fehler (Position bleibt)
  seek(offset: number, whence: 'set' | 'cur'): number {
    const target = whence === 'cur' ? this.pos + offset : offset;
    if (target < 0 || !Number.isFinite(target)) return -1;
    this.pos = target;
    this.eof = false;
    return 0;
  }

  rewind(): number {
    return this.seek(0, 'set');
  }

  // php_stream_gets(): eine Zeile bis einschließlich \n, null am Ende
  gets(): Buffer | null {
    if (this.pos >= this.buf.length) {
      this.eof = true;
      return null;
    }
    const nl = this.buf.indexOf(0x0a, this.pos);
    const end = nl < 0 ? this.buf.length : nl + 1;
    const line = this.buf.subarray(this.pos, end);
    this.pos = end;
    return line;
  }
}

const be16 = (b: Buffer, i: number): number => (b[i] << 8) + b[i + 1];
const be32 = (b: Buffer, i: number): number => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const u32 = (n: number): number => n >>> 0;

const SIG_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SIG_JP2 = Buffer.from([0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a]);
const starts = (b: Buffer, sig: number[] | Buffer, len = sig.length): boolean => {
  for (let i = 0; i < len; i++) if (b[i] !== sig[i]) return false;
  return true;
};

// php_getimagetype()
function imageType(s: Stream): number {
  const ft = Buffer.alloc(12);
  let r = s.read(3);
  if (r.length !== 3) return IMAGETYPE.UNKNOWN;
  r.copy(ft, 0);
  if (starts(ft, [0x47, 0x49, 0x46])) return IMAGETYPE.GIF;
  if (starts(ft, [0xff, 0xd8, 0xff])) return IMAGETYPE.JPEG;
  if (starts(ft, [0x89, 0x50, 0x4e])) {
    r = s.read(5);
    if (r.length !== 5) return IMAGETYPE.UNKNOWN;
    r.copy(ft, 3);
    return starts(ft, SIG_PNG) ? IMAGETYPE.PNG : IMAGETYPE.UNKNOWN;
  }
  if (starts(ft, [0x46, 0x57, 0x53])) return IMAGETYPE.SWF;
  if (starts(ft, [0x43, 0x57, 0x53])) return IMAGETYPE.SWC;
  if (starts(ft, [0x38, 0x42, 0x50])) return IMAGETYPE.PSD;
  if (starts(ft, [0x42, 0x4d])) return IMAGETYPE.BMP;
  if (starts(ft, [0xff, 0x4f, 0xff])) return IMAGETYPE.JPC;
  if (starts(ft, [0x52, 0x49, 0x46])) {
    r = s.read(9);
    if (r.length !== 9) return IMAGETYPE.UNKNOWN;
    r.copy(ft, 3);
    return ft.subarray(8, 12).equals(Buffer.from('WEBP')) ? IMAGETYPE.WEBP : IMAGETYPE.UNKNOWN;
  }
  r = s.read(1);
  if (r.length !== 1) return IMAGETYPE.UNKNOWN;
  r.copy(ft, 3);
  if (starts(ft, [0x49, 0x49, 0x2a, 0x00])) return IMAGETYPE.TIFF_II;
  if (starts(ft, [0x4d, 0x4d, 0x00, 0x2a])) return IMAGETYPE.TIFF_MM;
  if (starts(ft, [0x46, 0x4f, 0x52, 0x4d])) return IMAGETYPE.IFF;
  if (starts(ft, [0x00, 0x00, 0x01, 0x00])) return IMAGETYPE.ICO;
  // WBMP kann kürzer als 12 Bytes sein – der Fehler kommt erst danach
  r = s.read(8);
  const twelve = r.length === 8;
  r.copy(ft, 4);
  if (twelve && starts(ft, SIG_JP2)) return IMAGETYPE.JP2;
  if (s.rewind() === 0 && avifIdentify(s)) return IMAGETYPE.AVIF;
  if (getWbmp(s) !== null) return IMAGETYPE.WBMP;
  if (!twelve) return IMAGETYPE.UNKNOWN;
  if (getXbm(s) !== null) return IMAGETYPE.XBM;
  return IMAGETYPE.UNKNOWN;
}

type Dim = { width: number; height: number } | null;

function handleGif(s: Stream): Dim {
  if (s.seek(3, 'cur')) return null;
  const d = s.read(5);
  if (d.length !== 5) return null;
  return { width: d[0] | (d[1] << 8), height: d[2] | (d[3] << 8) };
}

function handlePsd(s: Stream): Dim {
  if (s.seek(11, 'cur')) return null;
  const d = s.read(8);
  if (d.length !== 8) return null;
  return { height: be32(d, 0), width: be32(d, 4) };
}

function handleBmp(s: Stream): Dim {
  if (s.seek(11, 'cur')) return null;
  const d = s.read(16);
  if (d.length !== 16) return null;
  const size = d.readInt32LE(0);
  if (size === 12) return { width: (d[5] << 8) + d[4], height: (d[7] << 8) + d[6] };
  if (size > 12 && (size <= 64 || size === 108 || size === 124)) {
    const h = d.readInt32LE(8);
    // abs((int32_t) height) als unsigned int
    return { width: d.readUInt32LE(4), height: u32(Math.abs(h)) };
  }
  return null;
}

function swfBits(buf: Buffer, pos: number, count: number): number {
  let result = 0;
  for (let loop = pos; loop < pos + count; loop++) {
    const byte = buf[Math.floor(loop / 8)] ?? 0;
    result += ((byte >> (7 - (loop % 8))) & 1) * 2 ** (count - (loop - pos) - 1);
  }
  return result;
}

function swfDim(b: Buffer): Dim {
  const bits = swfBits(b, 0, 5);
  // (unsigned long − unsigned long) / 20 – Unterlauf wie in C (64 Bit), dann auf unsigned int gekürzt
  const diff = (a: number, z: number): number => {
    const v = BigInt.asUintN(64, BigInt(a) - BigInt(z)) / 20n;
    return Number(BigInt.asUintN(32, v));
  };
  return {
    width: diff(swfBits(b, 5 + bits, bits), swfBits(b, 5, bits)),
    height: diff(swfBits(b, 5 + 3 * bits, bits), swfBits(b, 5 + 2 * bits, bits)),
  };
}

function handleSwf(s: Stream): Dim {
  if (s.seek(5, 'cur')) return null;
  const a = s.read(32);
  if (a.length !== 32) return null;
  return swfDim(a);
}

// Komprimiertes SWF: die ersten 64 Bytes entpacken, sonst den ganzen Rest (wie uncompress() in PHP)
function handleSwc(s: Stream): Dim {
  if (s.seek(5, 'cur')) return null;
  const a = s.read(64);
  if (a.length !== 64) return null;
  let b: Buffer | null = null;
  try {
    const out = inflateSync(a);
    if (out.length <= 64) b = Buffer.concat([out, Buffer.alloc(65 - out.length)]);
  } catch {
    b = null;
  }
  if (!b) {
    if (s.seek(8, 'set')) return null;
    const rest = s.read(Number.MAX_SAFE_INTEGER);
    try {
      const out = inflateSync(rest);
      if (out.length > rest.length * 2 ** 15) return null;
      b = Buffer.concat([out.subarray(0, 64), Buffer.alloc(65)]);
    } catch {
      return null;
    }
  }
  return swfDim(b);
}

function handlePng(s: Stream): Dim {
  if (s.seek(8, 'cur')) return null;
  const d = s.read(9);
  if (d.length < 9) return null;
  return { width: be32(d, 0), height: be32(d, 4) };
}

// php_read2(): 0, wenn keine zwei Bytes mehr da sind
function read2(s: Stream): number {
  const a = s.read(2);
  return a.length < 2 ? 0 : (a[0] << 8) + a[1];
}

function nextMarker(s: Stream, ffRead: boolean): number {
  if (!ffRead) {
    let m: number;
    while ((m = s.getc()) !== 0xff) {
      if (m === -1) return 0xd9;
    }
  }
  let a = 1;
  let marker: number;
  do {
    if ((marker = s.getc()) === -1) return 0xd9;
    a++;
  } while (marker === 0xff);
  if (a < 2) return 0xd9;
  return marker;
}

function skipVariable(s: Stream): boolean {
  const length = read2(s);
  if (length < 2) return false;
  s.seek(length - 2, 'cur');
  return true;
}

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

// php_handle_jpeg() ohne $info: nach dem ersten SOFn ist Schluss
function handleJpeg(s: Stream): Dim {
  let ffRead = true;
  for (;;) {
    const marker = nextMarker(s, ffRead);
    ffRead = false;
    if (SOF.has(marker)) {
      read2(s);
      s.getc();
      const height = read2(s);
      const width = read2(s);
      return { width, height };
    }
    if (marker === 0xda || marker === 0xd9) return null;
    if (!skipVariable(s)) return null;
  }
}

function read4(s: Stream): number {
  const a = s.read(4);
  return a.length !== 4 ? 0 : be32(a, 0);
}

function handleJpc(s: Stream): Dim {
  if (s.getc() !== 0x51) return null;
  read2(s);
  read2(s);
  const width = read4(s);
  const height = read4(s);
  if (s.seek(24, 'cur')) return null;
  const channels = read2(s);
  if ((channels === 0 && s.eof) || channels > 256) return null;
  return { width, height };
}

function handleJp2(s: Stream): Dim {
  for (;;) {
    const boxLength = read4(s);
    const type = s.read(4);
    if (type.length !== 4) break;
    if (boxLength === 1) return null;
    if (type.equals(Buffer.from('jp2c'))) {
      s.seek(3, 'cur');
      return handleJpc(s);
    }
    if ((boxLength | 0) <= 0) break;
    // unsigned int − 8: kleine Längen laufen über (Sprung weit hinter das Ende)
    if (s.seek(u32(boxLength - 8), 'cur')) break;
  }
  return null;
}

function handleTiff(s: Stream, motorola: boolean): Dim {
  const ptr = s.read(4);
  if (ptr.length !== 4) return null;
  const ifdAddr = motorola ? ptr.readUInt32BE(0) : ptr.readUInt32LE(0);
  // size_t − 8 als vorzeichenbehafteter Abstand (zend_off_t)
  if (s.seek(Number(BigInt.asIntN(64, BigInt(ifdAddr) - 8n)), 'cur')) return null;
  const head = s.read(2);
  if (head.length !== 2) return null;
  const numEntries = motorola ? head.readUInt16BE(0) : head.readUInt16LE(0);
  const dirSize = 2 + 12 * numEntries + 4;
  const dir = s.read(dirSize - 2);
  if (dir.length !== dirSize - 2) return null;
  let width = 0n;
  let height = 0n;
  for (let i = 0; i < numEntries; i++) {
    const e = 12 * i;
    const tag = motorola ? dir.readUInt16BE(e) : dir.readUInt16LE(e);
    const type = motorola ? dir.readUInt16BE(e + 2) : dir.readUInt16LE(e + 2);
    let value: bigint;
    switch (type) {
      case 1: case 6: value = BigInt(dir[e + 8]); break;
      case 3: value = BigInt(motorola ? dir.readUInt16BE(e + 8) : dir.readUInt16LE(e + 8)); break;
      // signed short → size_t (negativ wird riesig)
      case 8: value = BigInt.asUintN(64, BigInt(motorola ? dir.readInt16BE(e + 8) : dir.readInt16LE(e + 8))); break;
      case 4: value = BigInt(motorola ? dir.readUInt32BE(e + 8) : dir.readUInt32LE(e + 8)); break;
      case 9: value = BigInt.asUintN(64, BigInt(motorola ? dir.readInt32BE(e + 8) : dir.readInt32LE(e + 8))); break;
      default: continue;
    }
    if (tag === 0x0100 || tag === 0xa002) width = value;
    else if (tag === 0x0101 || tag === 0xa003) height = value;
  }
  if (width && height) return { width: Number(BigInt.asUintN(32, width)), height: Number(BigInt.asUintN(32, height)) };
  return null;
}

function handleIff(s: Stream): Dim {
  let a = s.read(8);
  if (a.length !== 8) return null;
  const form = a.toString('latin1', 4, 8);
  if (form !== 'ILBM' && form !== 'PBM ') return null;
  for (;;) {
    a = s.read(8);
    if (a.length !== 8) return null;
    const chunkId = a.readInt32BE(0);
    let size = a.readInt32BE(4);
    if (size < 0) return null;
    if ((size & 1) === 1) size++;
    if (chunkId === 0x424d4844) {
      if (size < 9) return null;
      const d = s.read(9);
      if (d.length !== 9) return null;
      const width = d.readInt16BE(0);
      const height = d.readInt16BE(2);
      const bits = d[8] & 0xff;
      if (width > 0 && height > 0 && bits > 0 && bits < 33) return { width, height };
    } else if (s.seek(size, 'cur')) {
      return null;
    }
  }
}

// php_get_wbmp(): Typ 0, Kopf, Breite und Höhe als Mehrbyte-Zahlen (höchstens 2048)
function getWbmp(s: Stream): Dim {
  if (s.rewind()) return null;
  if (s.getc() !== 0) return null;
  let i: number;
  do {
    i = s.getc();
    if (i < 0) return null;
  } while (i & 0x80);
  let width = 0;
  do {
    i = s.getc();
    if (i < 0) return null;
    width = (width << 7) | (i & 0x7f);
    if (width > 2048) return null;
  } while (i & 0x80);
  let height = 0;
  do {
    i = s.getc();
    if (i < 0) return null;
    height = (height << 7) | (i & 0x7f);
    if (height > 2048) return null;
  } while (i & 0x80);
  if (!height || !width) return null;
  return { width, height };
}

const isCSpace = (c: number): boolean => c === 0x20 || (c >= 0x09 && c <= 0x0d);

// sscanf(line, "#define %s %d", name, &value) == 2 für eine C-Zeichenkette (bis zum ersten Nullbyte)
function scanDefine(line: Buffer): { name: string; value: number } | null {
  const nul = line.indexOf(0);
  const s = nul < 0 ? line : line.subarray(0, nul);
  const lit = Buffer.from('#define');
  if (s.length < lit.length || !s.subarray(0, lit.length).equals(lit)) return null;
  let i = lit.length;
  while (i < s.length && isCSpace(s[i])) i++;
  const nameStart = i;
  while (i < s.length && !isCSpace(s[i])) i++;
  if (i === nameStart) return null;
  const name = s.toString('latin1', nameStart, i);
  while (i < s.length && isCSpace(s[i])) i++;
  const m = /^[+-]?\d+/.exec(s.toString('latin1', i));
  if (!m) return null;
  // %d: Überlauf wie strtol (glibc) – auf long begrenzt, dann in int gekürzt
  let v = BigInt(m[0]);
  if (v > 0x7fffffffffffffffn) v = 0x7fffffffffffffffn;
  if (v < -0x8000000000000000n) v = -0x8000000000000000n;
  return { name, value: Number(BigInt.asIntN(32, v)) };
}

// php_get_xbm(): Zeilen "#define name_width 10" und "#define name_height 20"
function getXbm(s: Stream): Dim {
  if (s.rewind()) return null;
  let width = 0;
  let height = 0;
  let line: Buffer | null;
  while ((line = s.gets()) !== null) {
    const def = scanDefine(line);
    if (def) {
      const us = def.name.lastIndexOf('_');
      const type = us < 0 ? def.name : def.name.slice(us + 1);
      if (type === 'width') {
        width = u32(def.value);
        if (height) break;
      }
      if (type === 'height') {
        height = u32(def.value);
        if (width) break;
      }
    }
  }
  return width && height ? { width, height } : null;
}

function handleIco(s: Stream): Dim {
  let d = s.read(2);
  if (d.length !== 2) return null;
  let num = (d[1] << 8) + d[0];
  if (num < 1 || num > 255) return null;
  let width = 0;
  let height = 0;
  let bits = 0;
  while (num > 0) {
    d = s.read(16);
    if (d.length !== 16) break;
    const b = (d[7] << 8) + d[6];
    if (b >= bits) {
      width = d[0];
      height = d[1];
      bits = b;
    }
    num--;
  }
  return { width: width || 256, height: height || 256 };
}

function handleWebp(s: Stream): Dim {
  const b = s.read(18);
  if (b.length !== 18) return null;
  if (b[0] !== 0x56 || b[1] !== 0x50 || b[2] !== 0x38) return null;
  switch (b[3]) {
    case 0x20: return { width: b[14] + ((b[15] & 0x3f) << 8), height: b[16] + ((b[17] & 0x3f) << 8) };
    case 0x4c: return { width: b[9] + ((b[10] & 0x3f) << 8) + 1, height: (b[10] >> 6) + (b[11] << 2) + ((b[12] & 0xf) << 10) + 1 };
    case 0x58: return { width: b[12] + (b[13] << 8) + (b[14] << 16) + 1, height: b[15] + (b[16] << 8) + (b[17] << 16) + 1 };
    default: return null;
  }
}

// ---------------------------------------------------------------- AVIF (libavifinfo)

class AvifStop extends Error {
  constructor(readonly status: 'found' | 'notfound' | 'truncated' | 'aborted' | 'invalid') {
    super(status);
  }
}

// Lesen über den PHP-Datenstrom: zu wenig Bytes → abgeschnitten (und alle weiteren Lesevorgänge scheitern)
class AvifStream {
  dead = false;
  constructor(readonly s: Stream) {}
  read(n: number): Buffer {
    if (this.dead) throw new AvifStop('truncated');
    const r = this.s.read(n);
    if (r.length !== n) {
      this.dead = true;
      throw new AvifStop('truncated');
    }
    return Buffer.from(r);
  }
  skip(n: number): void {
    if (n <= 0 || this.dead) return;
    if (this.s.seek(n, 'cur')) this.dead = true;
  }
}

interface AvifBox { size: number; type: string; version: number; flags: number; content: number }

const FULLBOX = new Set(['meta', 'pitm', 'ipma', 'ispe', 'pixi', 'iref', 'auxC']);
const MAX_VERSION: Record<string, number> = { meta: 0, pitm: 1, ipma: 1, ispe: 0, pixi: 0, iref: 1, auxC: 0 };

function parseBox(st: AvifStream, remaining: number, count: { n: number }): AvifBox {
  let header = 8;
  if (header > remaining) throw new AvifStop('invalid');
  let d = st.read(8);
  let size = be32(d, 0);
  let type = d.toString('latin1', 4, 8);
  if (size === 1) {
    header += 8;
    if (header > remaining) throw new AvifStop('invalid');
    d = st.read(8);
    if (be32(d, 0) !== 0) throw new AvifStop('aborted');
    size = be32(d, 4);
  } else if (size === 0) {
    size = remaining;
  }
  if (size < header || size > remaining) throw new AvifStop('invalid');
  const full = FULLBOX.has(type);
  if (full) header += 4;
  if (size < header) throw new AvifStop('invalid');
  const content = size - header;
  if (++count.n >= 4096) throw new AvifStop('aborted');
  let version = 0;
  let flags = 0;
  if (full) {
    d = st.read(4);
    version = d[0];
    flags = (d[1] << 16) | (d[2] << 8) | d[3];
    if (version > MAX_VERSION[type]) type = '\0skp';
  }
  return { size, type, version, flags, content };
}

// AvifInfoIdentifyStream(): erster Kasten „ftyp“ mit der Marke avif oder avis
function avifIdentify(s: Stream): boolean {
  const st = new AvifStream(s);
  try {
    const box = parseBox(st, 0xffffffff, { n: 0 });
    if (box.type !== 'ftyp' || box.content < 8) return false;
    for (let i = 0; i + 4 <= box.content; i += 4) {
      const d = st.read(4);
      if (i === 4) continue;
      const brand = d.toString('latin1');
      if (brand === 'avif' || brand === 'avis') {
        st.skip(box.content - (i + 4));
        return true;
      }
      if (i > 32 * 4) return false;
    }
    return false;
  } catch (err) {
    if (err instanceof AvifStop) return false;
    throw err;
  }
}

interface AvifFeatures {
  hasPrimary: boolean; hasAlpha: boolean; primary: number; skipped: boolean;
  width: number; height: number; depth: number; channels: number;
  tiles: Array<[tile: number, parent: number]>; props: Array<[index: number, item: number]>;
  dims: Array<[index: number, w: number, h: number]>; chans: Array<[index: number, depth: number, channels: number]>;
}

function itemFeatures(f: AvifFeatures, target: number, depth: number): 'found' | 'notfound' {
  for (const [propIndex, item] of f.props) {
    if (item !== target) continue;
    if (target === f.primary && (f.width === 0 || f.height === 0)) {
      for (const [idx, w, h] of f.dims) {
        if (idx !== propIndex) continue;
        f.width = w;
        f.height = h;
        if (f.depth !== 0 && f.channels !== 0) return 'found';
        break;
      }
    }
    if (f.depth === 0 || f.channels === 0) {
      for (const [idx, d, c] of f.chans) {
        if (idx !== propIndex) continue;
        f.depth = d;
        f.channels = c;
        if (f.width !== 0 && f.height !== 0) return 'found';
        break;
      }
    }
  }
  for (const [tile, parent] of f.tiles) {
    if (depth >= 3) break;
    if (parent !== target) continue;
    const r = itemFeatures(f, tile, depth + 1);
    if (r !== 'notfound') return r;
  }
  return 'notfound';
}

function primaryFeatures(f: AvifFeatures): 'found' | 'notfound' {
  if (!f.hasPrimary) return 'notfound';
  if (!(f.dims.length > 0 && f.chans.length)) return 'notfound';
  const r = itemFeatures(f, f.primary, 0);
  if (r !== 'found') return r;
  if (f.hasAlpha) f.channels++;
  return 'found';
}

const checkNotFound = (r: 'found' | 'notfound'): void => {
  if (r !== 'notfound') throw new AvifStop(r);
};

function parseIpco(st: AvifStream, remaining: number, count: { n: number }, f: AvifFeatures): never {
  let index = 1;
  do {
    const box = parseBox(st, remaining, count);
    if (box.type === 'ispe') {
      if (box.content < 8) throw new AvifStop('invalid');
      const d = st.read(8);
      const w = be32(d, 0);
      const h = be32(d, 4);
      if (w === 0 || h === 0) throw new AvifStop('invalid');
      if (f.dims.length < 8 && index <= 255) f.dims.push([index, w, h]);
      else f.skipped = true;
      st.skip(box.content - 8);
    } else if (box.type === 'pixi') {
      if (box.content < 1) throw new AvifStop('invalid');
      const channels = st.read(1)[0];
      if (channels < 1) throw new AvifStop('invalid');
      if (box.content < 1 + channels) throw new AvifStop('invalid');
      const depth = st.read(1)[0];
      if (depth < 1) throw new AvifStop('invalid');
      for (let i = 1; i < channels; i++) {
        if (st.read(1)[0] !== depth) throw new AvifStop('invalid');
        if (i > 32) throw new AvifStop('aborted');
      }
      if (f.chans.length < 8 && index <= 255) f.chans.push([index, depth, channels]);
      else f.skipped = true;
      st.skip(box.content - (1 + channels));
    } else if (box.type === 'av1C') {
      if (box.content < 3) throw new AvifStop('invalid');
      const d = st.read(3);
      const high = (d[2] & 0x40) !== 0;
      const twelve = (d[2] & 0x20) !== 0;
      const mono = (d[2] & 0x10) !== 0;
      if (twelve && !high) throw new AvifStop('invalid');
      if (f.chans.length < 8 && index <= 255) f.chans.push([index, high ? (twelve ? 12 : 10) : 8, mono ? 1 : 3]);
      else f.skipped = true;
      st.skip(box.content - 3);
    } else if (box.type === 'auxC') {
      if (box.content >= 44) {
        const d = st.read(44);
        const nul = d.indexOf(0);
        if (nul >= 0 && d.toString('latin1', 0, nul) === 'urn:mpeg:mpegB:cicp:systems:auxiliary:alpha') f.hasAlpha = true;
        st.skip(box.content - 44);
      } else {
        st.skip(box.content);
      }
    } else {
      st.skip(box.content);
    }
    index++;
    remaining -= box.size;
  } while (remaining > 0);
  throw new AvifStop('notfound');
}

function parseIprp(st: AvifStream, remaining: number, count: { n: number }, f: AvifFeatures): never {
  do {
    const box = parseBox(st, remaining, count);
    if (box.type === 'ipco') {
      try {
        parseIpco(st, box.content, count, f);
      } catch (err) {
        if (!(err instanceof AvifStop) || err.status !== 'notfound') throw err;
      }
    } else if (box.type === 'ipma') {
      let read = 4;
      if (box.content < read) throw new AvifStop('invalid');
      const entryCount = be32(st.read(4), 0);
      const idBytes = box.version < 1 ? 2 : 4;
      const indexBytes = box.flags & 1 ? 2 : 1;
      const essential = box.flags & 1 ? 0x8000 : 0x80;
      for (let entry = 0; entry < entryCount; entry++) {
        if (entry >= 32 || f.props.length >= 32) {
          f.skipped = true;
          break;
        }
        read += idBytes + 1;
        if (box.content < read) throw new AvifStop('invalid');
        const d = st.read(idBytes + 1);
        const item = idBytes === 2 ? be16(d, 0) : be32(d, 0);
        const assoc = d[idBytes];
        let p: number;
        for (p = 0; p < assoc; p++) {
          if (p >= 32 || f.props.length >= 32) {
            f.skipped = true;
            break;
          }
          read += indexBytes;
          if (box.content < read) throw new AvifStop('invalid');
          const v = st.read(indexBytes);
          const value = indexBytes === 2 ? be16(v, 0) : v[0];
          const propIndex = value & ~essential;
          if (propIndex <= 255 && item <= 255) f.props.push([propIndex, item]);
          else f.skipped = true;
        }
        if (p < assoc) break;
      }
      checkNotFound(primaryFeatures(f));
      st.skip(box.content - read);
    } else {
      st.skip(box.content);
    }
    remaining -= box.size;
  } while (remaining !== 0);
  throw new AvifStop('notfound');
}

function parseIref(st: AvifStream, remaining: number, count: { n: number }, f: AvifFeatures): never {
  do {
    const box = parseBox(st, remaining, count);
    if (box.type === 'dimg') {
      const idBytes = box.version === 0 ? 2 : 4;
      let read = idBytes + 2;
      if (box.content < read) throw new AvifStop('invalid');
      const d = st.read(idBytes + 2);
      const from = idBytes === 2 ? be16(d, 0) : be32(d, 0);
      const refs = be16(d, idBytes);
      for (let i = 0; i < refs; i++) {
        if (i >= 16) {
          f.skipped = true;
          break;
        }
        read += idBytes;
        if (box.content < read) throw new AvifStop('invalid');
        const t = st.read(idBytes);
        const to = idBytes === 2 ? be16(t, 0) : be32(t, 0);
        if (from <= 255 && to <= 255 && f.tiles.length < 16) f.tiles.push([to, from]);
        else f.skipped = true;
      }
      checkNotFound(primaryFeatures(f));
      // Rest des Kastens: libavifinfo überspringt ihn hier nicht (die nächste Kastengrenze stimmt dann nicht mehr)
    } else {
      st.skip(box.content);
    }
    remaining -= box.size;
  } while (remaining > 0);
  throw new AvifStop('notfound');
}

function parseMeta(st: AvifStream, remaining: number, count: { n: number }, f: AvifFeatures): never {
  do {
    const box = parseBox(st, remaining, count);
    const sub = (fn: () => never) => {
      try {
        fn();
      } catch (err) {
        if (!(err instanceof AvifStop) || err.status !== 'notfound') throw err;
      }
    };
    if (box.type === 'pitm') {
      const idBytes = box.version === 0 ? 2 : 4;
      if (idBytes > remaining) throw new AvifStop('invalid');
      const d = st.read(idBytes);
      const id = idBytes === 2 ? be16(d, 0) : be32(d, 0);
      if (id > 255) throw new AvifStop('aborted');
      f.hasPrimary = true;
      f.primary = id;
      st.skip(box.content - idBytes);
    } else if (box.type === 'iprp') {
      sub(() => parseIprp(st, box.content, count, f));
    } else if (box.type === 'iref') {
      sub(() => parseIref(st, box.content, count, f));
    } else {
      st.skip(box.content);
    }
    remaining -= box.size;
  } while (remaining !== 0);
  throw new AvifStop(f.skipped ? 'aborted' : 'invalid');
}

// php_handle_avif(): AvifInfoGetFeaturesStream() ab der aktuellen Position (nach „ftyp“)
function handleAvif(s: Stream): Dim {
  const st = new AvifStream(s);
  const f: AvifFeatures = { hasPrimary: false, hasAlpha: false, primary: 0, skipped: false, width: 0, height: 0, depth: 0, channels: 0, tiles: [], props: [], dims: [], chans: [] };
  const count = { n: 0 };
  try {
    for (;;) {
      const box = parseBox(st, 0xffffffff, count);
      if (box.type === 'meta') parseMeta(st, box.content, count, f);
      st.skip(box.content);
    }
  } catch (err) {
    if (!(err instanceof AvifStop)) throw err;
    return err.status === 'found' ? { width: f.width, height: f.height } : null;
  }
}

// getimagesize($datei): Breite, Höhe, Typ – oder null (PHP: false)
export function getImageSize(data: Buffer): ImageSize | null {
  const s = new Stream(data);
  const type = imageType(s);
  let dim: Dim = null;
  switch (type) {
    case IMAGETYPE.GIF: dim = handleGif(s); break;
    case IMAGETYPE.JPEG: dim = handleJpeg(s); break;
    case IMAGETYPE.PNG: dim = handlePng(s); break;
    case IMAGETYPE.SWF: dim = handleSwf(s); break;
    case IMAGETYPE.SWC: dim = handleSwc(s); break;
    case IMAGETYPE.PSD: dim = handlePsd(s); break;
    case IMAGETYPE.BMP: dim = handleBmp(s); break;
    case IMAGETYPE.TIFF_II: dim = handleTiff(s, false); break;
    case IMAGETYPE.TIFF_MM: dim = handleTiff(s, true); break;
    case IMAGETYPE.JPC: dim = handleJpc(s); break;
    case IMAGETYPE.JP2: dim = handleJp2(s); break;
    case IMAGETYPE.IFF: dim = handleIff(s); break;
    case IMAGETYPE.WBMP: dim = getWbmp(s); break;
    case IMAGETYPE.XBM: dim = getXbm(s); break;
    case IMAGETYPE.ICO: dim = handleIco(s); break;
    case IMAGETYPE.WEBP: dim = handleWebp(s); break;
    case IMAGETYPE.AVIF: dim = handleAvif(s); break;
    default: dim = null;
  }
  return dim ? { width: u32(dim.width), height: u32(dim.height), type } : null;
}
