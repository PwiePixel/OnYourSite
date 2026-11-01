// finfo_file($datei, FILEINFO_MIME_TYPE) wie PHP 8.3 (eingebautes libmagic 5.43) – für die Prüfung beim Hochladen,
// ob der Inhalt zur Endung passt. Nachgebaut sind der Ablauf von file_buffer() (leer, Textkodierung, tar, JSON, CSV,
// OLE2, Signaturen, Text) und die Regeln der Magic-Datenbank für alle Typen, die die Seite annimmt (MP3, M4A/MP4, Ogg,
// WAV, PDF, vCard, ZIP), sowie für die häufigen anderen Formate. Seltene Formate, die libmagic noch kennt, gelten
// hier als unbekannte Daten (application/octet-stream).

const BYTES_MAX = 1024 * 1024;
const ENCODING_MAX = 64 * 1024;

// ---------------------------------------------------------------- Textkodierung (encoding.c)

const F = 0;
const T = 1;
const I = 2;
const X = 3;
// prettier-ignore
const TEXT_CHARS = [
  F, F, F, F, F, F, F, T, T, T, T, T, T, T, F, F,
  F, F, F, F, F, F, F, F, F, F, F, T, F, F, F, F,
  ...Array<number>(0x60).fill(T).map((t, i) => (i === 0x5f ? F : t)),
  X, X, X, X, X, T, X, X, X, X, X, X, X, X, X, X,
  X, X, X, X, X, X, X, X, X, X, X, X, X, X, X, X,
  ...Array<number>(0x60).fill(I),
];

function looksWith(buf: Buffer, ok: (t: number) => boolean): number[] | null {
  const out: number[] = [];
  for (let i = 0; i < buf.length; i++) {
    if (!ok(TEXT_CHARS[buf[i]])) return null;
    out.push(buf[i]);
  }
  return out;
}

// file_looks_utf8(): -1 ungültig, 0 seltsame Steuerzeichen, 1 nur 7 Bit, 2 echtes UTF-8
const FIRST_ACCEPT: Record<number, [number, number]> = { 0xe0: [0xa0, 0xbf], 0xed: [0x80, 0x9f], 0xf0: [0x90, 0xbf], 0xf4: [0x80, 0x8f] };
export function looksUtf8(buf: Buffer, out: number[] | null = null): number {
  let gotone = false;
  let ctrl = false;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if ((b & 0x80) === 0) {
      if (TEXT_CHARS[b] !== T) ctrl = true;
      out?.push(b);
    } else if ((b & 0x40) === 0) {
      return -1;
    } else {
      if (b < 0xc2 || b > 0xf4) return -1;
      let following: number;
      let c: number;
      if ((b & 0x20) === 0) { c = b & 0x1f; following = 1; }
      else if ((b & 0x10) === 0) { c = b & 0x0f; following = 2; }
      else if ((b & 0x08) === 0) { c = b & 0x07; following = 3; }
      else return -1;
      const [lo, hi] = FIRST_ACCEPT[b] ?? [0x80, 0xbf];
      let done = false;
      for (let n = 0; n < following; n++) {
        i++;
        if (i >= buf.length) {
          done = true;
          break;
        }
        if (n === 0 && (buf[i] < lo || buf[i] > hi)) return -1;
        if ((buf[i] & 0x80) === 0 || (buf[i] & 0x40)) return -1;
        c = (c << 6) + (buf[i] & 0x3f);
      }
      if (done) break;
      out?.push(c);
      gotone = true;
    }
  }
  return ctrl ? 0 : gotone ? 2 : 1;
}

function looksUcs16(b: Buffer): number[] | null {
  if (b.length < 2) return null;
  let big: boolean;
  if (b[0] === 0xff && b[1] === 0xfe) big = false;
  else if (b[0] === 0xfe && b[1] === 0xff) big = true;
  else return null;
  const out: number[] = [];
  let hi = 0;
  for (let i = 2; i + 1 < b.length; i += 2) {
    let uc = big ? b[i + 1] | (b[i] << 8) : b[i] | (b[i + 1] << 8);
    if (uc === 0xfffe || uc === 0xffff || (uc >= 0xfdd0 && uc <= 0xfdef)) return null;
    if (hi) {
      if (!(uc >= 0xdc00 && uc <= 0xdfff)) return null;
      uc = 0x10000 + 0x400 * (hi - 1) + (uc - 0xdc00);
      hi = 0;
    }
    if (uc < 128 && TEXT_CHARS[uc] !== T) return null;
    out.push(uc);
    if (uc >= 0xd800 && uc <= 0xdbff) hi = uc - 0xd800 + 1;
    if (uc >= 0xdc00 && uc <= 0xdfff) return null;
  }
  return out;
}

function looksUcs32(b: Buffer): number[] | null {
  if (b.length < 4) return null;
  let big: boolean;
  if (b[0] === 0xff && b[1] === 0xfe && b[2] === 0 && b[3] === 0) big = false;
  else if (b[0] === 0 && b[1] === 0 && b[2] === 0xfe && b[3] === 0xff) big = true;
  else return null;
  const out: number[] = [];
  for (let i = 4; i + 3 < b.length; i += 4) {
    const v = big ? b.readUInt32BE(i) : b.readUInt32LE(i);
    out.push(v);
    if (v === 0xfffe) return null;
    if (v < 128 && TEXT_CHARS[v] !== T) return null;
  }
  return out;
}

// prettier-ignore
const EBCDIC = [
  0, 1, 2, 3, 156, 9, 134, 127, 151, 141, 142, 11, 12, 13, 14, 15, 16, 17, 18, 19, 157, 133, 8, 135, 24, 25, 146, 143, 28, 29, 30, 31,
  128, 129, 130, 131, 132, 10, 23, 27, 136, 137, 138, 139, 140, 5, 6, 7, 144, 145, 22, 147, 148, 149, 150, 4, 152, 153, 154, 155, 20, 21, 158, 26,
  32, 160, 161, 162, 163, 164, 165, 166, 167, 168, 213, 46, 60, 40, 43, 124, 38, 169, 170, 171, 172, 173, 174, 175, 176, 177, 33, 36, 42, 41, 59, 126,
  45, 47, 178, 179, 180, 181, 182, 183, 184, 185, 203, 44, 37, 95, 62, 63, 186, 187, 188, 189, 190, 191, 192, 193, 194, 96, 58, 35, 64, 39, 61, 34,
  195, 97, 98, 99, 100, 101, 102, 103, 104, 105, 196, 197, 198, 199, 200, 201, 202, 106, 107, 108, 109, 110, 111, 112, 113, 114, 94, 204, 205, 206, 207, 208,
  209, 229, 115, 116, 117, 118, 119, 120, 121, 122, 210, 211, 212, 91, 214, 215, 216, 217, 218, 219, 220, 221, 222, 223, 224, 225, 226, 227, 228, 93, 230, 231,
  123, 65, 66, 67, 68, 69, 70, 71, 72, 73, 232, 233, 234, 235, 236, 237, 125, 74, 75, 76, 77, 78, 79, 80, 81, 82, 238, 239, 240, 241, 242, 243,
  92, 159, 83, 84, 85, 86, 87, 88, 89, 90, 244, 245, 246, 247, 248, 249, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 250, 251, 252, 253, 254, 255,
];

// file_encoding(): Text in irgendeiner Kodierung? Liefert die Zeichen (für die Text-Regeln) oder null (binär)
function textChars(buf: Buffer): number[] | null {
  const b = buf.subarray(0, ENCODING_MAX);
  let u = looksWith(b, (t) => t === T);
  if (u) {
    // UTF-7 („+/v8“ …): erkannt, aber ohne Zeichen
    return b.length > 4 && b[0] === 0x2b && b[1] === 0x2f && b[2] === 0x76 && [0x38, 0x39, 0x2b, 0x2f].includes(b[3]) ? [] : u;
  }
  if (b.length > 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    const out: number[] = [];
    if (looksUtf8(b.subarray(3), out) > 0) return out;
  }
  const out: number[] = [];
  if (looksUtf8(b, out) > 1) return out;
  if ((u = looksUcs32(b))) return u;
  if ((u = looksUcs16(b))) return u;
  if ((u = looksWith(b, (t) => t === T || t === I))) return u;
  if ((u = looksWith(b, (t) => t !== F))) return u;
  const e = Buffer.from(b.map((c) => EBCDIC[c]));
  if ((u = looksWith(e, (t) => t === T))) return u;
  if ((u = looksWith(e, (t) => t === T || t === I))) return u;
  return null;
}

// ---------------------------------------------------------------- tar, JSON, CSV (is_tar.c, is_json.c, is_csv.c)

function isTar(b: Buffer): boolean {
  if (b.length < 512) return false;
  const h = b.subarray(0, 512);
  const nul = h.subarray(0, 100).indexOf(0);
  if (nul >= 7 && h.subarray(nul - 7, nul).toString('latin1') === '/gpkg-1') return false;
  // from_oct() über das Prüfsummenfeld (8 Bytes ab 148)
  const isSpace = (c: number) => c === 0x20 || (c >= 0x09 && c <= 0x0d);
  let p = 148;
  let digs = 8;
  while (isSpace(h[p])) {
    p++;
    if (digs-- === 0) return false;
  }
  let value = 0;
  while (digs > 0 && h[p] >= 0x30 && h[p] <= 0x37) {
    value = (value << 3) | (h[p++] - 0x30);
    digs--;
  }
  if (digs > 0 && h[p] && !isSpace(h[p])) value = -1;
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
  return sum === value;
}

// json_parse() mit den Eigenheiten von libmagic (Konstanten dürfen am Ende abgeschnitten sein, Zahlen locker)
function isJson(b: Buffer): string | null {
  const st = { arrayN: 0, object: 0 };
  let pos = 0;
  const end = b.length;
  const space = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
  const digit = (c: number) => c >= 0x30 && c <= 0x39;
  const xdigit = (c: number) => digit(c) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);
  const skip = (p: number) => {
    while (p < end && space(b[p])) p++;
    return p;
  };
  const parseString = (): boolean => {
    while (pos < end) {
      const c = b[pos++];
      if (c === 0) return false;
      if (c === 0x5c) {
        if (pos === end) return false;
        const e = b[pos++];
        if (e === 0) return false;
        if ([0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74].includes(e)) continue;
        if (e === 0x75) {
          if (end - pos < 4) {
            pos = end;
            return false;
          }
          for (let i = 0; i < 4; i++) if (!xdigit(b[pos++])) return false;
          continue;
        }
        return false;
      }
      if (c === 0x22) return true;
    }
    return false;
  };
  const parseNumber = (): boolean => {
    let got = false;
    if (pos === end) return false;
    if (b[pos] === 0x2d) pos++;
    for (; pos < end && digit(b[pos]); pos++) got = true;
    if (pos === end) return got;
    if (b[pos] === 0x2e) pos++;
    for (; pos < end && digit(b[pos]); pos++) got = true;
    if (pos === end) return got;
    if (got && (b[pos] === 0x65 || b[pos] === 0x45)) {
      pos++;
      got = false;
      if (pos === end) return got;
      if (b[pos] === 0x2b || b[pos] === 0x2d) pos++;
      for (; pos < end && digit(b[pos]); pos++) got = true;
    }
    return got;
  };
  const parseConst = (word: string): boolean => {
    // pos steht hinter dem ersten Buchstaben
    let uc = pos;
    pos = Math.min(end, pos + word.length - 1);
    for (let k = 1; uc < end && k < word.length; k++) if (b[uc++] !== word.charCodeAt(k)) return false;
    return true;
  };
  const parse = (lvl: number): number => {
    const ouc = (pos = skip(pos));
    let rv = false;
    if (pos === end) return lvl === 0 ? 0 : 0;
    if (lvl > 500) return 0;
    const c = b[pos++];
    if (c === 0x22) rv = parseString();
    else if (c === 0x5b) rv = parseArray(lvl + 1);
    else if (c === 0x7b) {
      rv = parseObject(lvl + 1);
      if (rv) st.object++;
    } else if (c === 0x74) rv = parseConst('true');
    else if (c === 0x66) rv = parseConst('false');
    else if (c === 0x6e) rv = parseConst('null');
    else {
      pos--;
      rv = parseNumber();
    }
    pos = skip(pos);
    if (lvl === 0) {
      if (!rv) return 0;
      if (pos === end) return st.arrayN || st.object ? 1 : 0;
      if (b[ouc] === b[pos] && parse(1)) return st.arrayN || st.object ? 2 : 0;
      return 0;
    }
    return rv ? 1 : 0;
  };
  const parseArray = (lvl: number): boolean => {
    while (pos < end) {
      pos = skip(pos);
      if (pos === end) return false;
      if (b[pos] === 0x5d) {
        st.arrayN++;
        pos++;
        return true;
      }
      if (!parse(lvl + 1)) return false;
      if (pos === end) return false;
      if (b[pos] === 0x2c) {
        pos++;
        continue;
      }
      if (b[pos] === 0x5d) {
        st.arrayN++;
        pos++;
        return true;
      }
      return false;
    }
    return false;
  };
  const parseObject = (lvl: number): boolean => {
    while (pos < end) {
      pos = skip(pos);
      if (pos === end) return false;
      if (b[pos] === 0x7d) {
        pos++;
        return true;
      }
      if (b[pos++] !== 0x22) return false;
      if (!parseString()) return false;
      pos = skip(pos);
      if (pos === end) return false;
      if (b[pos++] !== 0x3a) return false;
      if (!parse(lvl + 1)) return false;
      if (pos === end) return false;
      const c = b[pos++];
      if (c === 0x2c) continue;
      if (c === 0x7d) return true;
      pos--;
      return false;
    }
    return false;
  };
  const jt = parse(0);
  return jt === 0 ? null : jt === 1 ? 'application/json' : 'application/x-ndjason';
}

function isCsv(b: Buffer): boolean {
  let nf = 0;
  let tf = 0;
  let nl = 0;
  for (let p = 0; p < b.length; ) {
    const c = b[p++];
    if (c === 0x22) {
      // bis zum passenden Anführungszeichen ("" ist ein maskiertes)
      let quote = false;
      let found = false;
      while (p < b.length) {
        const q = b[p++];
        if (q !== 0x22) {
          if (quote) {
            p--;
            found = true;
            break;
          }
          continue;
        }
        quote = !quote;
      }
      if (!found) p = b.length;
    } else if (c === 0x2c) {
      nf++;
    } else if (c === 0x0a) {
      nl++;
      if (nl === 10) return tf !== 0 && tf === nf;
      if (tf === 0) {
        if (nf === 0) return false;
        tf = nf;
      } else if (tf !== nf) {
        return false;
      }
      nf = 0;
    }
  }
  return tf !== 0 && nl > 2;
}

// ---------------------------------------------------------------- Signaturen (Binärregeln der Magic-Datenbank)

const at = (b: Buffer, off: number, s: string): boolean => off + s.length <= b.length && b.toString('latin1', off, off + s.length) === s;
const atCI = (b: Buffer, off: number, s: string): boolean => off + s.length <= b.length && b.toString('latin1', off, off + s.length).toLowerCase() === s.toLowerCase();
const be16 = (b: Buffer, off: number): number => (off + 2 <= b.length ? b.readUInt16BE(off) : -1);
const le16 = (b: Buffer, off: number): number => (off + 2 <= b.length ? b.readUInt16LE(off) : -1);

// ftyp-Marken aus der Magic-Datenbank (animation) in ihrer Reihenfolge: die erste passende entscheidet, verglichen
// wird nur über die Länge der Marke („iso“ passt auf isom, iso2 …). Marken ohne MIME ergeben nur „ISO Media“.
const FTYP_ORDER: Array<[string, string | null]> = (
  'XAVC 3g2=video/3gpp2 3ge=video/3gpp 3gf 3gg=video/3gpp 3gh=video/3gpp 3gm=video/3gpp 3gp=video/3gpp 3gr=video/3gpp 3gs=video/3gpp 3gt=video/3gpp ARRI=video/mp4 avc1=video/mp4 bbxm=video/mp4 qt=video/quicktime CAEP caqv CDes caaa caac caqv ccea ccff cfhd cfsd chd1 chdf chhd chh1 clg1 cmfc cmff cmfl cmfs cud1 cud8 cwvt da0a da0b da1a da1b da2a da2b da3a da3b dash=video/mp4 dby1 dsms dts1 dts2 dts3 dxo$20 dmb1 dmpf drc1 dv1a dv1b dv2a dv2b dv3a dv3b dvr1=video/vnd.dvb.file dvt1 emsg=video/vnd.dvb.file F4V=video/mp4 F4P=video/mp4 F4A=audio/mp4 F4B=audio/mp4 ifrm im1i im1t isc2 iso=video/mp4 isml=video/mp4 J2P0 J2P1 jp2=image/jp2 JP2=image/jp2 JP20 jpm=image/jpm jpsi jpx=image/jpx KDDI=video/3gpp2 LCAG lmsg M4A=audio/x-m4a M4B=audio/mp4 M4P=video/mp4 M4V=video/x-m4v M4VH=video/x-m4v M4VP=video/x-m4v mj2s=video/mj2 mjp2 MFSM MGSV=video/mj2 mmp4=video/mp4 mobi=video/mp4 mp21 mp41=video/mp4 mp42=video/mp4 mp71 mp7t mp7b mpuf msdh msix mmp4=video/mp4 MPPI mqt=video/quicktime MSNV=audio/mp4 NDAS=audio/mp4 NDSC=video/mp4 NDSH=video/mp4 NDSM=video/mp4 NDSP=video/mp4 NDSS=video/mp4 NDXC=video/mp4 NDXH=video/mp4 NDXM=video/mp4 NDXP=video/mp4 NDXS niko=video/mp4 odcf opf2 opx2 pana piff pnvi qt=video/quicktime mif1=image/heif msf1=image/heif-sequence heic=image/heic heix=image/heic hevc=image/heic-sequence hevx=image/heic-sequence heim=image/heif heis=image/heif avic=image/heif hevm=image/heif-sequence hevs=image/heif-sequence avcs=image/heif-sequence avif=image/avif avis=image/avif risx ROSS sdv ssc1 ssc2 SEAU SEBK senv sims sisx ssss uvvu'
).split(' ').map((x) => {
  const [brand, mime] = x.split('=');
  return [brand, mime ?? null];
});

function ftypMime(b: Buffer): string | null {
  for (const [brand, mime] of FTYP_ORDER) if (at(b, 8, brand)) return mime;
  return null;
}

// MPEG-Audio-Rahmen (animation): Layer/Version aus den ersten zwei Bytes
function mpegAudio(b: Buffer): string | null | undefined {
  const w = be16(b, 0);
  if (w < 0) return undefined;
  const rate = b.length > 2 ? b[2] & 0xf0 : -1;
  if ((w & 0xfffe) === 0xfffa) {
    // Layer III v1: nur mit gültiger Bitrate
    if (rate > 0 && rate !== 0xf0) return 'audio/mpeg';
    return undefined;
  }
  if ((w & 0xfffe) === 0xfffc || (w & 0xfffe) === 0xfff2 || (w & 0xfffe) === 0xfff4 || (w & 0xfffe) === 0xfff6 || (w & 0xfffe) === 0xffe2) return 'audio/mpeg';
  if ((w & 0xfff6) === 0xfff0) return 'audio/x-hx-aac-adts';
  if ((w & 0xffe0) === 0x56e0) return 'audio/x-mp4a-latm';
  return undefined;
}

const OGG: Array<[string, string]> = [['\x7fFLAC', 'audio/ogg'], ['\x80theora', 'video/ogg'], ['\x80kate\0\0\0\0', 'application/ogg'], ['fishead\0', 'video/ogg'],
  ['Speex   ', 'audio/ogg'], ['\x01video\0\0\0', 'video/ogg'], ['\x01vorbis', 'audio/ogg'], ['OpusHead', 'audio/ogg']];

// msooxml: Name einer Datei im ZIP (ab Offset 30 eines lokalen Kopfes)
function ooxmlName(b: Buffer, off: number): string | null {
  if (at(b, off, 'word/')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (at(b, off, 'ppt/')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (at(b, off, 'xl/')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (at(b, off, 'visio/')) return 'application/vnd.ms-visio.drawing.main+xml';
  if (at(b, off, 'AppManifest.xaml')) return 'application/x-silverlight-app';
  return null;
}

const ODF: Array<[string, string]> = [
  ['vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.text'], ['vnd.oasis.opendocument.graphics', 'application/vnd.oasis.opendocument.graphics'],
  ['vnd.oasis.opendocument.presentation', 'application/vnd.oasis.opendocument.presentation'], ['vnd.oasis.opendocument.spreadsheet', 'application/vnd.oasis.opendocument.spreadsheet'],
  ['vnd.oasis.opendocument.chart', 'application/vnd.oasis.opendocument.chart'], ['vnd.oasis.opendocument.formula', 'application/vnd.oasis.opendocument.formula'],
  ['vnd.oasis.opendocument.database', 'application/vnd.oasis.opendocument.database'], ['vnd.oasis.opendocument.base', 'application/vnd.oasis.opendocument.database'],
  ['vnd.oasis.opendocument.image', 'application/vnd.oasis.opendocument.image'], ['vnd.sun.xml.', 'application/vnd.sun.xml'], ['vnd.openofficeorg.extension', 'application/vnd.openofficeorg.extension'],
  ['epub+zip', 'application/epub+zip'], ['x-vnd.corel.', 'application/x-vnd.corel'],
];

// msooxml (Stärke +10, also vor dem allgemeinen ZIP): Office-Dateien am Namen des ersten, dritten, vierten oder
// fünften Eintrags. Nur wenn es einen fünften Eintrag gibt und auch der nicht passt: „Microsoft OOXML“ ohne MIME.
function ooxmlMime(b: Buffer): string | null {
  const direct = ooxmlName(b, 30);
  if (direct) return direct;
  // regex (PCRE, mehrzeilig) über höchstens 8 KiB ab dem ersten Dateinamen
  if (!/\[Content_Types\]\.xml|_rels\/\.rels|docProps|customXml/.test(b.toString('latin1', 30, Math.min(b.length, 30 + 8192)))) return null;
  if (b.length < 22) return null;
  const search = (from: number): number => {
    if (from > b.length) return -1;
    const i = b.subarray(from, Math.min(b.length, from + 6000 + 3)).indexOf('PK\x03\x04', 0, 'latin1');
    return i < 0 ? -1 : from + i;
  };
  const second = search(b.readUInt32LE(18) + 49);
  if (second < 0) return null;
  const third = search(second + 4 + 26);
  if (third < 0) return null;
  const m3 = ooxmlName(b, third + 4 + 26);
  if (m3) return m3;
  const fourth = search(third + 4 + 26);
  if (fourth < 0) return null;
  const m4 = ooxmlName(b, fourth + 4 + 26);
  if (m4) return m4;
  const fifth = search(fourth + 4 + 26);
  if (fifth < 0) return null;
  return ooxmlName(b, fifth + 4 + 26) ?? 'NOMIME';
}

// ZIP (archive): OpenDocument & Co. über die Datei „mimetype“, JAR über das Zusatzfeld 0xCAFE, sonst Zip
function zipMime(b: Buffer): string | null {
  if (at(b, 26, '\x08\0\0\0mimetypeapplication/')) {
    for (const [prefix, mime] of ODF) if (at(b, 50, prefix)) return mime;
    if (at(b, 50, 'vnd.kde.')) return 'NOMIME';
    return /^[!-OQ-~]/.test(b.toString('latin1', 38, 39)) ? 'application/zip' : 'NOMIME';
  }
  const isMimetype = at(b, 26, '\x08\0\0\0mimetype');
  // „!application/“ trifft nur zu, wenn die 12 Bytes vorhanden sind
  if (isMimetype && b.length >= 50 && !at(b, 38, 'application/') && /^[!-OQ-~]/.test(b.toString('latin1', 38, 39))) return 'application/zip';
  // (26.s+30): Zusatzfeld des ersten Eintrags – liegt es außerhalb der Daten, greifen die folgenden Regeln nicht
  const n1 = le16(b, 26);
  const extra = n1 < 0 ? -1 : le16(b, 30 + n1);
  if (extra < 0) return null;
  if (extra === 0xcafe) return 'application/java-archive';
  if (!isMimetype && at(b, 30, 'Payload/') && b.subarray(38, 38 + 64 + 5).includes('.app/')) return 'application/x-ios-app';
  // search/100 nach „application/epub+zip“ braucht mindestens 20 Bytes ab Offset 30
  if (b.length < 50 || b.subarray(30, 30 + 100 + 20).includes('application/epub+zip')) return null;
  return isMimetype ? null : 'application/zip';
}

// Binärregeln wie in der Datenbank: geprüft nach Stärke (libmagic: 20 + 10 je Musterbyte, +10 für Gleichheit,
// dazu !:strength), die erste zutreffende entscheidet. Ergebnis: MIME, 'NOMIME' (erkannt ohne MIME – die Suche
// endet, PHP meldet application/octet-stream) oder null (Regel trifft nicht zu, weiter mit der nächsten).
interface Rule {
  s: number;
  // b: höchstens 1 MiB vom Anfang; full: die ganze Datei (für Regeln, die vom Ende aus lesen); text: sieht nach Text aus
  test: (b: Buffer, full: Buffer | null, text: boolean, depth: number) => string | null;
}

const ELF_TYPES: Record<number, string> = { 1: 'application/x-object', 2: 'application/x-executable', 3: 'application/x-sharedlib', 4: 'application/x-coredump' };

// filesystems: DOS/MBR-Bootsektor („0 ulelong&0x804000E9 0x000000E9“, !:strength +60) mit gültiger Sektorgröße und
// Media-Descriptor F0–FF. Die Regel hat keinen MIME-Typ und zählt erst, wenn eine Folgezeile mit Beschreibung zutrifft
// (Werte außerhalb der Daten treffen nie zu). Ab 26 Bytes ist das immer so („24 uleshort x sectors/track“).
// Trifft auch MPEG-Audio-Rahmen ohne ID3, deren Bytes zufällig so aussehen – PHP meldet dann application/octet-stream.
function fatBootSector(b: Buffer): boolean {
  if (b.length < 22 || (b.readUInt32LE(0) & 0x804000e9) >>> 0 !== 0xe9) return false;
  const sector = b.readUInt16LE(11);
  if ((sector & 0x1f) !== 0 || sector >= 32769 || sector <= 31 || (b[21] & 0xf0) !== 0xf0) return false;
  if (b.length >= 26) return true;
  const fats = b[16];
  const roots = b.readUInt16LE(17);
  const sectors = b.readUInt16LE(19);
  // Boot-Code, OEM-ID, Bytes/Sektor ≠ 512, Sektoren/Cluster, FATs, Wurzeleinträge, Sektoren, Media-Descriptor ≠ F0
  if (b[0] === 0xeb || b[0] === 0xe9 || b[3] !== 0 || sector !== 512 || b[13] > 1 || fats === 1 || fats > 2 || roots > 0 || sectors > 0
    || b[21] !== 0xf0) return true;
  // Sektoren/FAT oder (alles 0) „; NTFS“
  return b.length >= 24 && (b.readUInt16LE(22) > 0 || (fats === 0 && roots === 0 && sectors === 0));
}

// compress: zlib-Kopf („0 string/b x“, Stärke 1 – die letzte Binärregel; /b: nur, wenn die Daten nicht wie Text aussehen)
const zlibHeader = (b: Buffer): boolean => b.length >= 2 && b.readUInt16BE(0) % 31 === 0 && (b[0] & 0x0f) === 8 && (b[0] & 0x80) === 0;

const RULES: Rule[] = [
  { s: 190, test: (b) => (at(b, 0, '\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR') ? 'image/png' : null) },
  { s: 190, test: (b) => (at(b, 0, 'SQLite format 3\0') && b.length >= 18 ? 'application/vnd.sqlite3' : null) },
  { s: 180, test: (b) => (atCI(b, 0, 'BEGIN:VCALENDAR') ? 'text/calendar' : null) },
  { s: 170, test: (b) => (at(b, 0, '\xef\xbb\xbf%PDF-') ? 'application/pdf' : null) },
  { s: 150, test: (b) => (at(b, 0, '\n%PDF-') ? 'application/pdf' : null) },
  { s: 150, test: (b) => (at(b, 0, '\0\0\0\x0cjP  \r\n\x87\n') ? 'image/jp2' : at(b, 0, '\0\0\0\x0cJXL \r\n\x87\n') ? 'image/x-jxl' : null) },
  { s: 150, test: (b) => (at(b, 0, '\x89PNG\r\n\x1a\n\0\0\0\x04CgBI') && at(b, 24, '\0\0\0\x0dIHDR') ? 'image/png' : null) },
  { s: 140, test: (b) => (at(b, 0, '%PDF-') ? 'application/pdf' : at(b, 0, '%FDF-') ? 'application/vnd.fdf' : null) },
  // vCard (außer die 2. Zeile beginnt mit „VERSION:END“) – Groß/Klein egal
  { s: 140, test: (b) => (atCI(b, 0, 'begin:vcard') ? (at(b, 13, 'VERSION:END') ? 'NOMIME' : 'text/vcard') : null) },
  // Shell (#! /bin/sh, auch ohne Leerzeichen; danach Leerraum oder Ende) – gilt auch für Binärdaten
  { s: 130, test: (b) => (/^#! ?\/(usr\/(local\/)?)?bin\/(ba|k)?sh(?=[\t\n\v\f\r ]|$)/.test(b.toString('latin1', 0, 40)) ? 'text/x-shellscript' : null) },
  { s: 130, test: (b) => (fatBootSector(b) ? 'NOMIME' : null) },
  { s: 110, test: (b) => (at(b, 0, 'PK\x07\x08PK\x03\x04') || at(b, 0, 'PK00PK\x03\x04') ? 'application/zip' : null) },
  { s: 100, test: (b) => (at(b, 0, 'Rar!\x1a\x07') ? 'application/x-rar' : null) },
  { s: 90, test: (b) => (at(b, 0, '7z\xbc\xaf\x27\x1c') ? 'application/x-7z-compressed' : at(b, 0, '\xfd7zXZ\0') ? 'application/x-xz' : null) },
  { s: 80, test: (b) => (at(b, 0, 'PK\x03\x04') ? ooxmlMime(b) : null) },
  { s: 80, test: (b) => (at(b, 0, '{\\rtf') && b.length >= 6 && b[5] !== 0xab && b[5] !== 0x5c ? 'text/rtf' : null) },
  { s: 80, test: (b) => (at(b, 0, '#!AMR') ? 'audio/amr' : null) },
  { s: 71, test: (b) => (at(b, 0, 'PK\x03\x04') ? zipMime(b) : at(b, 0, 'PK\x05\x06') ? 'application/zip' : null) },
  // PCX: 0x0A, Version 0–5 (nicht 1), Kompression 0/1, Farbtiefe > 0
  { s: 70, test: (b) => (b.length >= 4 && (b.readUInt32BE(0) & 0xfff8fe00) >>> 0 === 0x0a000000 && b[3] > 0 && b[1] < 6 && b[1] !== 1 ? 'image/x-pcx' : null) },
  // Ende der Datei: Verzeichnis-Ende (PK\5\6) 22 Bytes vor Schluss, das auf ein Zentralverzeichnis (PK\1\2) zeigt
  {
    s: 70,
    test: (_b, full) => {
      if (!full || full.length < 22 || !at(full, full.length - 22, 'PK\x05\x06')) return null;
      return at(full, full.readUInt32LE(full.length - 22 + 16), 'PK\x01\x02') ? 'application/zip' : null;
    },
  },
  { s: 70, test: (b) => (at(b, 4, 'ftyp') ? (ftypMime(b) ?? 'NOMIME') : null) },
  {
    s: 70,
    test: (b) => {
      if (!at(b, 0, 'OggS')) return null;
      if (b.length > 4 && b[4] !== 0) return 'NOMIME';
      for (const [sig, mime] of OGG) if (at(b, 28, sig)) return mime;
      return 'NOMIME';
    },
  },
  { s: 70, test: (b) => (at(b, 0, 'RIFF') ? (at(b, 8, 'WAVE') ? 'audio/x-wav' : at(b, 8, 'AVI ') ? 'video/x-msvideo' : at(b, 8, 'WEBP') ? 'image/webp' : 'NOMIME') : null) },
  { s: 70, test: (b) => (at(b, 0, 'RIFX') || at(b, 0, 'RF64') ? 'NOMIME' : null) },
  { s: 70, test: (b) => (at(b, 0, 'fLaC') ? 'audio/flac' : at(b, 0, 'MThd') ? 'audio/midi' : null) },
  {
    s: 70,
    test: (b) => {
      if (!at(b, 0, '\x1a\x45\xdf\xa3')) return null;
      // DocType (0x42 0x82) in den ersten 4 KiB, dahinter eine Länge und „webm“/„matroska“
      const i = b.subarray(4, 4 + 4096 + 2).indexOf('\x42\x82', 0, 'latin1');
      if (i < 0) return null;
      const off = 4 + i + 2 + 1;
      return at(b, off, 'webm') ? 'video/webm' : at(b, off, 'matroska') ? 'video/x-matroska' : null;
    },
  },
  { s: 70, test: (b) => (at(b, 0, 'FORM') && (at(b, 8, 'AIFF') || at(b, 8, 'AIFC')) ? 'audio/x-aiff' : null) },
  { s: 70, test: (b) => (at(b, 0, 'FLV\x01') ? 'video/x-flv' : at(b, 0, '\0\0\x01\xba') || at(b, 0, '\0\0\x01\xb3') ? 'video/mpeg' : null) },
  { s: 70, test: (b) => (at(b, 0, '\x28\xb5\x2f\xfd') ? 'application/zstd' : null) },
  { s: 70, test: (b) => (at(b, 0, '\xff\xd8\xff') && b.length >= 4 ? (b[3] === 0xf7 ? 'image/jls' : 'image/jpeg') : null) },
  { s: 70, test: (b) => (at(b, 0, 'GIF8') ? 'image/gif' : at(b, 0, 'II*\0') || at(b, 0, 'MM\0*') ? 'image/tiff' : null) },
  { s: 70, test: (b) => (at(b, 0, '8BPS') ? (b.length >= 22 && b.readUInt32BE(18) > 0 ? 'image/vnd.adobe.photoshop' : null) : null) },
  { s: 70, test: (b) => (at(b, 0, '\xff\x4f\xff\x51') ? 'image/x-jp2-codestream' : null) },
  { s: 70, test: (b) => (at(b, 0, '\x7fELF') && b.length >= 18 ? (ELF_TYPES[b[5] === 2 ? b.readUInt16BE(16) : b.readUInt16LE(16)] ?? 'NOMIME') : null) },
  // MPEG-Audio-Rahmen (Layer III v1 mit gültiger Bitrate hat !:strength +20)
  { s: 70, test: (b) => (be16(b, 0) >= 0 && (be16(b, 0) & 0xfffe) === 0xfffa ? mpegAudio(b) ?? null : null) },
  // ID3v2: der Inhalt hinter dem Tag entscheidet („indirect“)
  {
    s: 60,
    test: (b, _full, text, depth) => {
      if (!at(b, 0, 'ID3')) return null;
      if (b.length < 10 || depth > 3) return 'NOMIME';
      const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
      const inner = binaryMagic(b.subarray(size + 10), null, text, depth + 1);
      return inner && inner !== 'NOMIME' ? inner : 'NOMIME';
    },
  },
  { s: 60, test: (b) => (at(b, 0, 'BZh') ? 'application/x-bzip2' : null) },
  { s: 50, test: (b) => (be16(b, 0) >= 0 && (be16(b, 0) & 0xfffe) !== 0xfffa ? mpegAudio(b) ?? null : null) },
  { s: 50, test: (b) => (at(b, 0, '\x1f\x8b') && b.length >= 4 ? ((b[3] & 0x18) === 0 && (at(b, 10, 'MCD') || at(b, 10, 'GXD')) ? 'NOMIME' : 'application/gzip') : null) },
  { s: 50, test: (b) => (at(b, 0, 'BM') && b.length >= 18 && [12, 40, 52, 56, 64, 108, 124].includes(b.readUInt32LE(14)) ? 'image/bmp' : null) },
  { s: 50, test: (b, _full, text) => (!text && at(b, 0, 'MZ') && b.length >= 0x1a ? 'application/x-dosexec' : null) },
  { s: 50, test: (b) => (at(b, 0, '%!') ? 'application/postscript' : null) },
  { s: 50, test: (b) => (at(b, 0, '\xff\x0a') ? 'image/x-jxl' : null) },
  // Atari DEGAS, gepackt (images: 0x8000 mit freien Bits im ersten Paletteneintrag, 0x8001, 0x8002)
  { s: 50, test: (b) => (b.length >= 2 && b[0] === 0x80 && (b[1] === 1 || b[1] === 2 || (b[1] === 0 && b.length >= 4 && (b[2] & 0xf0) === 0)) ? 'image/x-atari-degas' : null) },
  { s: 1, test: (b, _full, text) => (!text && zlibHeader(b) ? 'application/zlib' : null) },
];

function binaryMagic(b: Buffer, full: Buffer | null, text: boolean, depth = 0): string | null {
  for (const rule of RULES) {
    const r = rule.test(b, full, text, depth);
    if (r !== null) return r;
  }
  return null;
}

// ---------------------------------------------------------------- Textregeln (auf dem als UTF-8 gelesenen Text)

// #!-Zeilen (commands, varied.script, perl, python, ruby, javascript, lua, tcl) – Leerzeichen nach #! optional
const SCRIPTS: Array<[RegExp, string]> = [
  [/^#! ?\/(usr\/(local\/)?)?(bin\/)?(c|k|tc|z|a|ba|fi)?sh(?=[\t\n\v\f\r ]|$)/, 'text/x-shellscript'],
  [/^#! ?\/usr\/local\/(tcsh|bash)(?=[\t\n\v\f\r ]|$)/, 'text/x-shellscript'],
  [/^#! ?\/usr\/bin\/env (zsh|bash|fish)(?=[\t\n\v\f\r ]|$)/, 'text/x-shellscript'],
  [/^#! ?\/usr\/local\/bin\/ae(?=[\t\n\v\f\r ]|$)/, 'text/x-shellscript'],
  [/^#! ?\/(usr\/(local\/)?)?bin\/nawk(?=[\t\n\v\f\r ]|$)/, 'text/x-nawk'],
  [/^#! ?\/(usr\/(local\/)?)?bin\/gawk/, 'text/x-gawk'],
  [/^#! ?\/(usr\/)?bin\/awk(?=[\t\n\v\f\r ]|$)/, 'text/x-awk'],
  [/^#! ?\/usr\/(local\/)?bin\/php/, 'text/x-php'],
  [/^#! ?\/usr\/bin\/env perl/, 'text/x-perl'],
  [/^#! ?\/usr\/(local\/)?bin\/python/, 'text/x-script.python'],
  [/^#! ?\/usr\/bin\/env python/, 'text/x-script.python'],
  [/^#! ?\/usr\/(local\/)?bin\/ruby/, 'text/x-ruby'],
  [/^#! ?\/(usr\/)?bin\/nodejs?/, 'application/javascript'],
  [/^#! ?\/usr\/(local\/)?bin\/lua/, 'text/x-lua'],
  [/^#! ?\/usr\/bin\/tcl/, 'text/x-tcl'],
];

function textMagic(t: string): string | null {
  const lower = t.slice(0, 4096 + 16).toLowerCase();
  if (t.slice(0, 256 + 5).includes('%PDF-')) return 'application/pdf';
  if (/^<\?xml version=/.test(t)) {
    if (t.slice(19, 19 + 4096 + 4).includes('<svg')) return 'image/svg+xml';
    if (/^<\?xml version=["']/.test(t) && /<!doctype html|<html/.test(t.slice(19, 19 + 4096 + 16).toLowerCase())) return 'text/html';
    return 'text/xml';
  }
  if (t.startsWith('<svg')) return 'image/svg+xml';
  if (lower.includes('<!doctype svg')) return 'image/svg+xml';
  if (/<!doctype html|<head[> ]|<title[> ]|<html[> ]|<script[> ]|<style[> ]|<table[> ]|<a href=/.test(lower)) return 'text/html';
  if (/^<\?xml/i.test(t)) return 'text/xml';
  for (const [re, mime] of SCRIPTS) if (re.test(t)) return mime;
  // commands: „search/1/c =<?php“ nur ganz am Anfang; „search/1 =<?\n“ (ohne Schalter sucht libmagic mit memmem bis
  // Bereich + Musterlänge) auch ein Byte weiter hinten
  if (/^<\?php/i.test(t)) return 'text/x-php';
  const head = Buffer.from(t.slice(0, 4), 'utf8').subarray(0, 4);
  if (head.includes('<?\n') || head.includes('<?\r')) return 'text/x-php';
  if (/^(Relay-Version: |#! rnews|N#! rnews|Forward to |Pipe to |From:|Date:|Received:)/.test(t) || /^(delivered-to:|return-path:)/i.test(t)) return 'message/rfc822';
  if (/^(Path:|Xref:|Article )/.test(t)) return 'message/news';
  const c = t.slice(0, 8192);
  if (/^#include/m.test(c) || /^#[\t\n\v\f\r ]*pragma/m.test(c) || (/^#[\t\n\v\f\r ]*(if|ifn)def/m.test(c) && /^#[\t\n\v\f\r ]*(endif$|define)/m.test(c))
    || /^struct[\t\n\v\f\r ]+/m.test(c) || /^union[\t\n\v\f\r ]+/m.test(c) || /^[\t\n\v\f\r ]*extern[\t\n\v\f\r ]+/m.test(c)) return 'text/x-c';
  return null;
}

function nulTrimmed(b: Buffer): Buffer {
  let n = b.length;
  while (n > 0 && b[n - 1] === 0) n--;
  return b.subarray(0, n);
}

// finfo_buffer(finfo_open(FILEINFO_MIME_TYPE), $inhalt)
export function fileMime(data: Buffer): string {
  const b = data.subarray(0, BYTES_MAX);
  if (b.length === 0) return 'application/x-empty';
  if (b.length === 1) return 'application/octet-stream';
  const looksText = textChars(b) !== null;
  if (isTar(b)) return 'application/x-tar';
  const json = isJson(b);
  if (json) return json;
  if (looksText && isCsv(b)) return 'text/csv';
  // OLE2 (readcdf): mindestens ein ganzer Kopf (512 Bytes) mit gültigen Sektorgrößen – sonst greift nur die
  // Signatur-Regel „OLE 2 Compound Document“ (ohne MIME). Was readcdf darin genauer erkennt (Word, Excel …),
  // ist hier immer application/x-ole-storage: für keine erlaubte Endung ein Unterschied.
  if (at(b, 0, '\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1')) {
    if (b.length >= 512 && b.readUInt16LE(30) <= 20 && b.readUInt16LE(32) <= 20) return 'application/x-ole-storage';
    if (b.length >= 0x1c && b.readUInt16LE(0x1a) !== 0xabab) return 'application/octet-stream';
  }
  const bin = binaryMagic(b, data, looksText);
  if (bin && bin !== 'NOMIME') return bin;
  // Text: ohne Nullbytes am Ende, mindestens zwei Bytes, Regeln auf dem UTF-8-Text
  let trimmed = nulTrimmed(b);
  if (trimmed.length & 1 && !(b.length & 1)) trimmed = b.subarray(0, trimmed.length + 1);
  const chars = textChars(trimmed);
  if (!chars || nulTrimmed(trimmed).length <= 1) return 'application/octet-stream';
  let text = '';
  for (const c of chars) text += String.fromCodePoint(c > 0x10ffff ? 0xfffd : c);
  const m = textMagic(text);
  return m && m !== 'NOMIME' ? m : 'text/plain';
}
