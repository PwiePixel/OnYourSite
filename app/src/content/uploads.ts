// Uploads aus dem Editor: Bilder (werden verkleinert und ohne Metadaten gespeichert), Musik, Dateien (lib/uploads.php).
// Bilder rechnet sharp statt GD um; welche Dateien GD lesen kann (und welche nicht), ist hier nachgebaut, damit dieselben
// Dateien als WebP bzw. unverändert gespeichert werden.
import { chmodSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import type { UploadedFile } from '../web/ctx.js';
import { randomHex } from '../crypto.js';
import { intval, phpTrim, strtolower, time } from '../php.js';
import { IMAGE_EXTS, validUpload } from './blocks.js';
import { usedFiles } from './pages.js';
import { dirFilesMatching, uploadsDir } from './storage.js';
import { getImageSize } from './imageSize.js';
import { fileMime } from './fileMime.js';
import { phpRound } from './phpMath.js';

export interface UploadKind {
  exts: readonly string[];
  maxMb: number;
  maxPx: number;
  prefix: string;
}

// oys_upload_kinds() (ohne Prototyp: "constructor" o. ä. ist keine Art)
const KINDS: Readonly<Record<string, UploadKind>> = Object.freeze(Object.assign(Object.create(null) as Record<string, UploadKind>, {
  avatar: { exts: IMAGE_EXTS, maxMb: 8, maxPx: 640, prefix: 'avatar' },
  bg: { exts: IMAGE_EXTS, maxMb: 10, maxPx: 2200, prefix: 'bg' },
  image: { exts: IMAGE_EXTS, maxMb: 10, maxPx: 1600, prefix: 'img' },
  thumb: { exts: IMAGE_EXTS, maxMb: 8, maxPx: 800, prefix: 'thumb' },
  gallery: { exts: IMAGE_EXTS, maxMb: 10, maxPx: 1600, prefix: 'gal' },
  music: { exts: ['mp3', 'm4a', 'ogg', 'wav'], maxMb: 15, maxPx: 0, prefix: 'music' },
  file: { exts: ['pdf', 'vcf', 'zip'], maxMb: 10, maxPx: 0, prefix: 'file' },
}));
export const uploadKinds = (): Readonly<Record<string, UploadKind>> => KINDS;

// Speicherplatz je Konto (Premium/Admin: mehr)
export const UPLOAD_QUOTA_MB = 200;
export const UPLOAD_QUOTA_PREMIUM_MB = 1000;

// oys_user_upload_files(): alle hochgeladenen Dateien eines Nutzers (Name → Bytes), wie glob(dir/*_{id}_*)
export function userUploadFiles(userId: number): Map<string, number> {
  const files = new Map<string, number>();
  for (const f of dirFilesMatching(uploadsDir(), '_' + userId + '_')) {
    if (validUpload(f.name, userId) !== null) files.set(f.name, f.size);
  }
  return files;
}

// oys_sweep_uploads(): räumt Dateien auf, die hochgeladen, aber nie gespeichert wurden (älter als 2 Tage, von keiner
// Seite benutzt). Betrifft nur Dateien dieser Version (name_ID_zeit_zufall.ext) – alte Uploads bleiben unangetastet.
export async function sweepUploads(userId: number, files: Map<string, number>): Promise<Map<string, number>> {
  const cutoff = time() - 2 * 86400;
  let used: Set<string> | null = null;
  const dir = uploadsDir() + '/';
  const out = new Map(files);
  for (const name of files.keys()) {
    const m = /^[a-z]+_\d+_(\d{9,11})_[0-9a-f]{8}\.[a-z0-9]{2,5}(?=\n?$)/.exec(name);
    if (!m || intval(m[1]) > cutoff) continue;
    used = used ?? (await usedFiles(userId));
    if (used.has(name)) continue;
    try {
      unlinkSync(dir + name);
      out.delete(name);
    } catch {
      // wie @unlink: bleibt in der Liste
    }
  }
  return out;
}

// Grenzen des Node-Servers (server.ts: Datei 16 MiB, Anfrage 20 MiB) in der Schreibweise der PHP-Einstellungen
const UPLOAD_MAX_FILESIZE = '16M';
const POST_MAX_SIZE = '20M';

// Wert wie in php.ini ("16M", "1G", "-1") in Bytes – die Rechnung aus oys_upload_limit_mb()
export function iniBytes(value: string): number {
  const v = phpTrim(value);
  if (v === '' || v === '-1') return Number.MAX_SAFE_INTEGER;
  const unit = strtolower(v.slice(-1));
  // (float) "1.5G" → 1.5 (Leerraum am Anfang wird übersprungen)
  const m = /^[ \t\n\r\v\f]*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(v);
  const n = m ? Number(m[0]) : 0;
  return Math.trunc(unit === 'g' ? n * 1073741824 : unit === 'm' ? n * 1048576 : unit === 'k' ? n * 1024 : n);
}

// oys_upload_limit_mb(): größte Datei, die der Server annimmt, in MB (eine Nachkommastelle; PHP liefert float)
export function uploadLimitMb(uploadMax = UPLOAD_MAX_FILESIZE, postMax = POST_MAX_SIZE): number {
  const bytes = Math.min(iniBytes(uploadMax), iniBytes(postMax));
  return phpRound(Math.min(bytes, 100 * 1048576) / 1048576, 1);
}

// Erlaubte Inhaltstypen (finfo) je Endung – Bilder prüft getimagesize()
const ALLOWED_MIMES: Record<string, readonly string[]> = Object.assign(Object.create(null) as Record<string, readonly string[]>, {
  mp3: ['audio/mpeg', 'audio/mp3', 'application/octet-stream'],
  m4a: ['audio/mp4', 'audio/x-m4a', 'audio/m4a', 'video/mp4', 'application/octet-stream'],
  ogg: ['audio/ogg', 'application/ogg', 'video/ogg'],
  wav: ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'],
  pdf: ['application/pdf'],
  vcf: ['text/vcard', 'text/x-vcard', 'text/plain', 'text/directory'],
  zip: ['application/zip', 'application/x-zip-compressed'],
});

// pathinfo($name, PATHINFO_EXTENSION): Text nach dem letzten Punkt des letzten Pfadteils
function extensionOf(name: string): string {
  let end = name.length;
  while (end > 0 && name[end - 1] === '/') end--;
  const base = name.slice(name.lastIndexOf('/', end - 1) + 1, end);
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot + 1);
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export type UploadResult = { file: string } | { error: string };

// oys_handle_upload(): gibt { file } oder { error } zurück
export async function handleUpload(upload: UploadedFile | undefined, kind: string, userId: number): Promise<UploadResult> {
  if (!Object.hasOwn(KINDS, kind)) return { error: 'Unknown upload type.' };
  const cfg = KINDS[kind];

  const err = upload ? upload.error : 4;
  if (err === 1 || err === 2) {
    return { error: 'The file is too large for the server (raise upload_max_filesize and post_max_size in the PHP settings).' };
  }
  if (err !== 0 || !upload || !Buffer.isBuffer(upload.data)) return { error: 'Upload failed (error code ' + intval(err) + ').' };
  if ((upload.size ?? 0) > cfg.maxMb * 1024 * 1024) return { error: 'The file is too large (max. ' + cfg.maxMb + ' MB).' };

  let ext = strtolower(extensionOf(upload.name ?? ''));
  if (ext === 'jpeg') ext = 'jpg';
  if (!cfg.exts.includes(ext)) return { error: 'This file type isn’t allowed (' + cfg.exts.join(', ') + ').' };

  // Inhalt prüfen, nicht nur die Endung (den Inhaltstyp braucht PHP nur für Nicht-Bilder – hier nur dann berechnet)
  const data = upload.data;
  const isImage = IMAGE_EXTS.includes(ext);
  if (isImage && !getImageSize(data)) return { error: 'That’s not a valid image.' };
  const mime = isImage ? '' : fileMime(data);
  if (!isImage && mime !== '' && Object.hasOwn(ALLOWED_MIMES, ext) && !ALLOWED_MIMES[ext].includes(mime)) {
    return { error: 'The file’s content doesn’t match its .' + ext + ' extension.' };
  }

  const dir = uploadsDir() + '/';
  if (!isDir(dir)) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o755 });
    } catch {
      // wie @mkdir – das Schreiben unten meldet den Fehler
    }
  }
  const base = cfg.prefix + '_' + userId + '_' + time() + '_' + randomHex(4);

  if (isImage && cfg.maxPx > 0) {
    if (await processImage(data, ext, cfg.maxPx, dir + base + '.webp')) return { file: base + '.webp' };
  }
  const name = base + '.' + ext;
  try {
    writeFileSync(dir + name, data, { mode: 0o644 });
  } catch {
    return { error: 'The upload folder isn’t writable (check that its permissions are 755).' };
  }
  try {
    chmodSync(dir + name, 0o644);
  } catch {
    // wie @chmod
  }
  return { file: name };
}

// ---------------------------------------------------------------- Bilder (wie GD)

// Wie libpng (in GD) die Datei liest: Fehler in Pflicht-Abschnitten (IHDR, PLTE, IDAT, IEND: Prüfsumme, Name,
// unbekannt) oder ein fehlendes Ende brechen ab (null); Zusatz-Abschnitte mit falscher Prüfsumme (z. B. tRNS)
// verwirft libpng nur – sie werden hier ebenfalls entfernt, bevor sharp das Bild bekommt.
function pngAsGdReads(b: Buffer): Buffer | null {
  const keep: Buffer[] = [b.subarray(0, 8)];
  let dropped = false;
  let p = 8;
  for (;;) {
    if (p + 8 > b.length) return null;
    const len = b.readUInt32BE(p);
    if (len > 0x7fffffff) return null;
    const type = b.subarray(p + 4, p + 8);
    if (!type.every((c) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a))) return null;
    if (p + 12 + len > b.length) return null;
    const name = type.toString('latin1');
    const critical = (type[0] & 0x20) === 0;
    if (critical && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(name)) return null;
    const crcOk = crc32(b.subarray(p + 4, p + 8 + len)) === b.readUInt32BE(p + 8 + len);
    if (critical && !crcOk) return null;
    if (crcOk) keep.push(b.subarray(p, p + 12 + len));
    else dropped = true;
    if (name === 'IEND') return dropped ? Buffer.concat(keep) : b;
    p += 12 + len;
  }
}

// Wie libjpeg in GD eine JPEG-Datei zu Ende liest: Nach den Bilddaten verarbeitet jpeg_finish_decompress() die übrigen
// Marker bis EOI – ein unbekannter Marker, ein zweites SOI/SOF/SOS oder eine kaputte Tabelle dort ist ein Fehler, und
// imagecreatefromjpeg() liefert false (sharp liest nicht so weit). Das betrifft nur Bilder mit einem einzigen Scan; mehrere
// Scans (progressiv) liest libjpeg schon beim Start ganz, dort scheitern beide gleich. Die Bilddaten selbst enden am ersten
// Marker; Restart-Marker dazwischen behandelt libjpeg wie read_restart_marker() und jpeg_resync_to_restart().
function jpegAsGdReads(b: Buffer): boolean {
  const size = b.length;
  // Quelle von GD: hinter dem Dateiende folgen endlos FF D9 (eingeschobenes EOI)
  const at = (i: number): number => (i < size ? b[i] : (i - size) % 2 === 0 ? 0xff : 0xd9);
  let p = 2;
  // next_marker(): Bytes bis FF überspringen, FF-Füllbytes und FF 00 (Daten) auch
  const nextMarker = (): number => {
    for (;;) {
      let c = at(p++);
      while (c !== 0xff) c = at(p++);
      do c = at(p++); while (c === 0xff);
      if (c !== 0) return c;
    }
  };
  const word = (): number => {
    const v = (at(p) << 8) | at(p + 1);
    p += 2;
    return v;
  };
  // Kopf bis zum ersten SOS (gültig – sharp hat ihn gelesen)
  let width = 0;
  let height = 0;
  let progressive = false;
  let restart = 0;
  let frame: Array<[number, number]> = [];
  let scanComps = 0;
  for (;;) {
    const m = nextMarker();
    if (m === 0xc0 || m === 0xc1 || m === 0xc2 || m === 0xc9 || m === 0xca) {
      p += 3;
      height = word();
      width = word();
      const n = at(p++);
      frame = [];
      for (let i = 0; i < n; i++, p += 3) frame.push([at(p + 1) >> 4, at(p + 1) & 15]);
      progressive = m === 0xc2 || m === 0xca;
    } else if (m === 0xdd) {
      p += 2;
      restart = word();
    } else if (m === 0xda) {
      p += 2;
      scanComps = at(p++);
      p += scanComps * 2 + 3;
      break;
    } else if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      continue;
    } else if (m === 0xc4 || m === 0xcc || m === 0xdb || m === 0xdc || (m >= 0xe0 && m <= 0xef) || m === 0xfe) {
      const len = word() - 2;
      if (len > 0) p += len;
    } else {
      return true;
    }
  }
  if (progressive || !frame.length || scanComps < frame.length) return true;
  // MCUs des Scans (ein Bauteil: Blöcke, sonst MCUs aus den größten Abtastfaktoren)
  const maxH = Math.max(...frame.map((c) => c[0]));
  const maxV = Math.max(...frame.map((c) => c[1]));
  const mcus = frame.length === 1
    ? Math.ceil((width * frame[0][0]) / (maxH * 8)) * Math.ceil((height * frame[0][1]) / (maxV * 8))
    : Math.ceil(width / (maxH * 8)) * Math.ceil(height / (maxV * 8));
  let unread = 0;
  if (restart > 0) {
    let next = 0;
    for (let k = Math.ceil(mcus / restart) - 1; k > 0; k--) {
      if (!unread) unread = nextMarker();
      if (unread === 0xd0 + next) {
        unread = 0;
      } else {
        for (;;) {
          const m = unread;
          let action: number;
          if (m < 0xc0) action = 2;
          else if (m < 0xd0 || m > 0xd7) action = 3;
          else if (m === 0xd0 + ((next + 1) & 7) || m === 0xd0 + ((next + 2) & 7)) action = 3;
          else if (m === 0xd0 + ((next - 1) & 7) || m === 0xd0 + ((next - 2) & 7)) action = 2;
          else action = 1;
          if (action === 1) unread = 0;
          if (action !== 2) break;
          unread = nextMarker();
        }
      }
      next = (next + 1) & 7;
    }
  }
  // jpeg_finish_decompress(): Marker bis EOI
  for (;;) {
    const m = unread || nextMarker();
    unread = 0;
    if (m === 0xd9) return true;
    if (m === 0xd8 || m === 0xda || (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xcc)) return false;
    if (m === 0xcc) {
      // get_dac()
      let len = word() - 2;
      while (len > 0) {
        const index = at(p++);
        const val = at(p++);
        len -= 2;
        if (index >= 32 || (index < 16 && (val & 15) > val >> 4)) return false;
      }
      if (len !== 0) return false;
    } else if (m === 0xc4) {
      // get_dht()
      let len = word() - 2;
      while (len > 16) {
        const index = at(p++);
        let count = 0;
        for (let i = 0; i < 16; i++) count += at(p++);
        len -= 17;
        if (count > 256 || count > len) return false;
        p += count;
        len -= count;
        if ((index & 0x10 ? index - 0x10 : index) >= 4) return false;
      }
      if (len !== 0) return false;
    } else if (m === 0xdb) {
      // get_dqt()
      let len = word() - 2;
      while (len > 0) {
        const n = at(p++);
        if ((n & 15) >= 4) return false;
        p += n >> 4 ? 128 : 64;
        len -= n >> 4 ? 129 : 65;
      }
      if (len !== 0) return false;
    } else if (m === 0xdd) {
      // get_dri()
      if (word() !== 4) return false;
      p += 2;
    } else if ((m >= 0xe0 && m <= 0xef) || m === 0xfe || m === 0xdc) {
      // APPn, COM, DNL: überspringen
      const len = word() - 2;
      if (len > 0) p += len;
    } else if (!((m >= 0xd0 && m <= 0xd7) || m === 0x01)) {
      return false;
    }
  }
}

// WebP mit Animation (VP8X, Bit 2): GD liest nur Einzelbilder
const webpAnimated = (b: Buffer): boolean => b.length > 20 && b.toString('latin1', 12, 16) === 'VP8X' && (b[20] & 0x02) !== 0;

// ---------------------------------------------------------------- EXIF-Ausrichtung (wie ext/exif in PHP 8.3)

// Bytes je Wert für die Formate 1–13 (13 = IFD, wird wie Bytes behandelt)
const TIFF_SIZES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 1];
const SECTION_IFD0 = 1;
const SECTION_EXIF = 2;
const SECTION_GPS = 3;
const SECTION_INTEROP = 4;
const SECTION_THUMBNAIL = 5;
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_INTEROP_IFD = 0xa005;
const M_SOS = 0xda;
const M_EOI = 0xd9;
const M_COM = 0xfe;
const M_PSEUDO = 0x123;
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
// Mit leerem Wert brechen diese Einträge das Lesen des Verzeichnisses ab (REQUIRE_NON_EMPTY)
const NOT_EMPTY = new Set([0x829d, 0xa002, 0xa20e, 0x9206, 0xa210]);

// Wert eines Eintrags, wie er in exif_read_data() landet: null (leer), Zahl, Text (Bytes) oder Liste
type ExifValue = null | number | string | number[];

// exif_read_data($datei)['Orientation'] ?? 1 als (int). Wie PHP: Die Kopfdaten werden bis zum Bildanfang (SOS) gelesen –
// scheitert das (abgeschnitten, Müll zwischen den Abschnitten), liefert exif_read_data() false (→ 1). Gelesen wird die erste
// gültige Exif-APP1 mit IFD0, der Exif-Unter-IFD (dessen Wert gewinnt) und den GPS/Interop-IFDs; ein Fehler in einem
// Eintrag beendet das Verzeichnis (und das übergeordnete). Herstellerdaten (MakerNote) werden nicht ausgewertet – sie
// stehen in sortierten Verzeichnissen hinter der Ausrichtung und ändern sie nicht.
export function exifOrientation(b: Buffer): number {
  const found = exifScan(b);
  if (!found) return 1;
  const v = found.has(SECTION_EXIF) ? found.get(SECTION_EXIF) : found.get(SECTION_IFD0);
  return v === undefined || v === null ? 1 : intval(v);
}

// exif_scan_JPEG_header(): null, wenn PHP abbricht (exif_read_data() → false); sonst die Ausrichtungen je Abschnitt
function exifScan(b: Buffer): Map<number, ExifValue> | null {
  const size = b.length;
  if (size < 2 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const s: ExifState = { b, values: new Map(), any: false, ifd0: false, ifdCount: 0, nesting: 0, mm: false, aperture: 0, exposure: 0 };
  let p = 2;
  let last = M_PSEUDO;
  let correction = 1;
  for (;;) {
    // Manche Programme zählen die Längen-Bytes eines Kommentars nicht mit: bis zu zwei Bytes danach überspringen
    if (last === M_COM && correction) correction = 2;
    let marker: number;
    do {
      if (p >= size) return null;
      marker = b[p++];
      if (last === M_COM && correction > 0) {
        if (marker !== 0xff) {
          marker = 0xff;
          correction--;
        } else {
          last = M_PSEUDO;
        }
      }
    } while (marker === 0xff);
    const fpos = p;
    if (p + 2 > size) return null;
    const itemlen = (b[p] << 8) | b[p + 1];
    if (itemlen < 2 || fpos + itemlen > size) return null;
    const data = b.subarray(fpos, fpos + itemlen);
    p = fpos + itemlen;
    if (marker === M_SOS) return s.values;
    if (marker === M_EOI) return s.any ? s.values : null;
    if (marker === M_COM) s.any = true;
    else if (marker === 0xe1) {
      if (!s.ifd0) exifApp1(s, data, fpos);
    } else if (marker === 0xec) {
      if (itemlen > 2 && data[2] !== 0) s.any = true;
    } else if (SOF_MARKERS.has(marker) && itemlen - 2 < 6) {
      return null;
    }
    last = marker;
  }
}

interface ExifState {
  b: Buffer;
  values: Map<number, ExifValue>;
  any: boolean;
  ifd0: boolean;
  ifdCount: number;
  nesting: number;
  mm: boolean;
  aperture: number;
  exposure: number;
}

interface Tiff {
  t: Buffer;
  displacement: number;
}

// exif_process_APP1() + exif_process_TIFF_in_JPEG()
function exifApp1(s: ExifState, data: Buffer, fpos: number): void {
  if (data.length <= 8 || data.toString('latin1', 2, 8) !== 'Exif\0\0') return;
  const t = data.subarray(8);
  if (t.length < 2) return;
  const order = t.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return;
  s.mm = order === 'MM';
  if (t.length < 8) return;
  const ifd = u32(s, t, 4);
  if (u16(s, t, 2) !== 0x2a || ifd < 8 || ifd > t.length) return;
  s.ifd0 = true;
  s.any = true;
  exifIfd(s, { t, displacement: fpos + 8 }, ifd, SECTION_IFD0, 0);
}

const u16 = (s: ExifState, t: Buffer, o: number): number => (s.mm ? t.readUInt16BE(o) : t.readUInt16LE(o));
const u32 = (s: ExifState, t: Buffer, o: number): number => (s.mm ? t.readUInt32BE(o) : t.readUInt32LE(o));
const s32 = (s: ExifState, t: Buffer, o: number): number => (s.mm ? t.readInt32BE(o) : t.readInt32LE(o));

// exif_process_IFD_in_JPEG()
function exifIfd(s: ExifState, x: Tiff, start: number, section: number, tag: number): boolean {
  const len = x.t.length;
  s.ifd0 = true;
  if (start + 2 > len) return false;
  const n = u16(s, x.t, start);
  if (start + 2 + n * 12 > len) return false;
  for (let i = 0; i < n; i++) {
    if (!exifTag(s, x, start + 2 + 12 * i, section)) return false;
  }
  if (section === SECTION_THUMBNAIL) return true;
  if (start + 2 + n * 12 + 4 > len) return false;
  const next = tag !== TAG_EXIF_IFD && tag !== TAG_GPS_IFD ? u32(s, x.t, start + 2 + n * 12) : 0;
  if (!next) return true;
  // Das nächste Verzeichnis ist das Vorschaubild (bzw. bei Interop ein weiteres)
  if (next > len) return false;
  return exifIfd(s, x, next, SECTION_THUMBNAIL, 0);
}

// exif_process_IFD_TAG(): höchstens 1000 Einträge, Verschachtelung bis 10
function exifTag(s: ExifState, x: Tiff, entry: number, section: number): boolean {
  if (s.ifdCount++ > 1000 || s.nesting > 10) return false;
  s.nesting++;
  try {
    return exifTagImpl(s, x, entry, section);
  } finally {
    s.nesting--;
  }
}

function exifTagImpl(s: ExifState, x: Tiff, entry: number, section: number): boolean {
  const t = x.t;
  const tag = u16(s, t, entry);
  let format = u16(s, t, entry + 2);
  const components = u32(s, t, entry + 4);
  if (!format || format > 13) format = 1;
  const bytes = components * TIFF_SIZES[format];
  if (bytes > 0x7fffffff) return false;
  let value: Buffer;
  if (bytes > 4) {
    const off = u32(s, t, entry + 8);
    if (off + bytes <= t.length) {
      value = t.subarray(off, off + bytes);
    } else {
      // Außerhalb der APP1: PHP liest an derselben Stelle in der Datei (ab dem TIFF-Kopf gezählt)
      const size = s.b.length;
      if (bytes > size || off > size - bytes) return false;
      const at = x.displacement + off;
      if (at + bytes > size) return false;
      value = s.b.subarray(at, at + bytes);
    }
  } else {
    value = t.subarray(entry + 8, entry + 8 + bytes);
  }
  s.any = true;
  if (section === SECTION_THUMBNAIL) {
    if (!bytes) return false;
  } else if (section === SECTION_IFD0 || section === SECTION_EXIF) {
    if (NOT_EMPTY.has(tag) && !bytes) return false;
    if (tag === 0x829d) {
      s.aperture = Math.fround(exifNumber(s, value, format));
    } else if ((tag === 0x9202 || tag === 0x9205) && s.aperture === 0) {
      if (!bytes) return false;
      s.aperture = Math.fround(Math.exp(Math.fround(exifNumber(s, value, format) * Math.fround(Math.LN2) * 0.5)));
    } else if (tag === 0x9201 && s.exposure === 0) {
      if (!bytes) return false;
      s.exposure = Math.fround(Math.exp(Math.fround(-exifNumber(s, value, format) * Math.fround(Math.LN2))));
    } else if (tag === 0x829a) {
      s.exposure = -1;
    } else if (tag === TAG_EXIF_IFD || tag === TAG_GPS_IFD || tag === TAG_INTEROP_IFD) {
      if (!bytes) return false;
      // Zeiger: immer vier Bytes ab dem Wert (bei kurzen Formaten aus dem Eintrag selbst)
      const off = u32(s, bytes > 4 ? value : t.subarray(entry + 8, entry + 12), 0);
      if (off > t.length) return false;
      const sub = tag === TAG_EXIF_IFD ? SECTION_EXIF : tag === TAG_GPS_IFD ? SECTION_GPS : SECTION_INTEROP;
      if (!exifIfd(s, x, off, sub, tag)) return false;
    }
    // exif_iif_add_tag(): der Name „Orientation“ gilt in IFD0 und im Exif-IFD
    if (tag === 0x0112) s.values.set(section, exifValue(s, value, format, components));
  }
  return true;
}

// exif_convert_any_format() (für Blende und Belichtung)
function exifNumber(s: ExifState, v: Buffer, format: number): number {
  switch (format) {
    case 6: return v.readInt8(0);
    case 1: return v[0];
    case 3: return u16(s, v, 0);
    case 4: return u32(s, v, 0);
    case 5: {
      const den = u32(s, v, 4);
      return den === 0 ? 0 : u32(s, v, 0) / den;
    }
    case 10: {
      const den = s32(s, v, 4);
      return den === 0 ? 0 : s32(s, v, 0) / den;
    }
    case 8: return (u16(s, v, 0) << 16) >> 16;
    case 9: return s32(s, v, 0);
    // Kommazahlen liest PHP immer als Little Endian
    case 11: return v.readFloatLE(0);
    case 12: return v.readDoubleLE(0);
    default: return 0;
  }
}

// exif_iif_add_value() + add_assoc_image_info(): Bytes und Texte werden Strings, Zahlen nur bei genau einem Wert
function exifValue(s: ExifState, v: Buffer, format: number, components: number): ExifValue {
  if (!components) return null;
  if (format === 2) {
    const nul = v.indexOf(0);
    const len = nul < 0 ? v.length : nul;
    return len ? v.toString('latin1', 0, len) : null;
  }
  if (format === 1 || format === 6 || format === 7 || format === 13) return v.toString('latin1');
  if (components > 1) return [components];
  switch (format) {
    case 3: return u16(s, v, 0);
    case 4: return u32(s, v, 0) | 0;
    case 5: return u32(s, v, 0) + '/' + u32(s, v, 4);
    case 8: return (u16(s, v, 0) << 16) >> 16;
    case 9: return s32(s, v, 0);
    case 10: return s32(s, v, 0) + '/' + s32(s, v, 4);
    case 11: return v.readFloatLE(0);
    default: return v.readDoubleLE(0);
  }
}

const SHARP_FORMAT: Record<string, string> = { jpg: 'jpeg', png: 'png', webp: 'webp' };
// Wie streng sharp liest: GD liest JPEG wie libjpeg mit ignorierten Warnungen (abgeschnittene Dateien werden grau
// aufgefüllt); PNG prüft pngAsGdReads() vorher wie libpng, WebP muss vollständig sein
const FAIL_ON: Record<string, 'none' | 'truncated'> = { jpg: 'none', png: 'truncated', webp: 'truncated' };

// oys_process_image(): verkleinert ein Bild, dreht es richtig (EXIF bei JPEG) und speichert es als WebP ohne
// Metadaten (z. B. GPS-Daten). GIFs und animierte WebPs bleiben unverändert (die Animation ginge sonst verloren).
// Wie GD: nie automatisch drehen, gespiegelte Ausrichtungen (2, 4, 5, 7) bleiben, wie sie sind.
export async function processImage(src: Buffer, ext: string, maxPx: number, target: string): Promise<boolean> {
  if (ext === 'gif') return false;
  if (ext === 'webp') {
    const head = src.subarray(0, 64);
    if (head.includes('ANIM') || head.includes('ANMF')) return false;
  }
  const info = getImageSize(src);
  if (!info || info.width * info.height > 40000000) return false;
  if (!Object.hasOwn(SHARP_FORMAT, ext)) return false;
  // imagecreatefromjpeg/png/webp: nur das passende Format; was GD nicht lesen kann, bleibt unverändert
  if (ext === 'png') {
    const png = pngAsGdReads(src);
    if (!png) return false;
    src = png;
  }
  if (ext === 'webp' && webpAnimated(src)) return false;
  if (ext === 'jpg' && !jpegAsGdReads(src)) return false;
  let width: number;
  let height: number;
  try {
    const meta = await sharp(src, { failOn: FAIL_ON[ext] }).metadata();
    if (meta.format !== SHARP_FORMAT[ext] || !meta.width || !meta.height) return false;
    width = meta.width;
    height = meta.height;
  } catch {
    return false;
  }
  // imagerotate() dreht gegen den Uhrzeigersinn (3 → 180°, 6 → −90°, 8 → 90°), sharp im Uhrzeigersinn
  const angle = ext === 'jpg' ? ({ 3: 180, 6: 90, 8: 270 } as Record<number, number>)[exifOrientation(src)] : undefined;
  if (angle === 90 || angle === 270) [width, height] = [height, width];
  const scale = Math.min(1, maxPx / Math.max(width, height));
  const nw = Math.max(1, Math.trunc(phpRound(width * scale)));
  const nh = Math.max(1, Math.trunc(phpRound(height * scale)));
  try {
    let img = sharp(src, { failOn: FAIL_ON[ext] });
    if (angle) img = img.rotate(angle);
    const out = await img.resize(nw, nh, { fit: 'fill' }).webp({ quality: 84 }).toBuffer();
    writeFileSync(target, out);
  } catch {
    return false;
  }
  try {
    chmodSync(target, 0o644);
  } catch {
    // wie @chmod
  }
  return true;
}
