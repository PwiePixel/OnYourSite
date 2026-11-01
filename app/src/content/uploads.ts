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

// WebP mit Animation (VP8X, Bit 2): GD liest nur Einzelbilder
const webpAnimated = (b: Buffer): boolean => b.length > 20 && b.toString('latin1', 12, 16) === 'VP8X' && (b[20] & 0x02) !== 0;

const TIFF_SIZES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

// exif_read_data($datei)['Orientation'] als (int) – wie PHP: erste Exif-APP1 vor den Bilddaten, IFD0 (und die
// Exif-Unter-IFD, deren Wert gewinnt), ein Fehler in einem Eintrag beendet das Lesen. Ohne Wert: 1.
export function exifOrientation(b: Buffer): number {
  if (b.length < 2 || b[0] !== 0xff || b[1] !== 0xd8) return 1;
  let p = 2;
  for (;;) {
    let marker: number;
    do {
      if (p >= b.length) return 1;
      marker = b[p++];
    } while (marker === 0xff);
    if (p + 2 > b.length) return 1;
    const itemlen = (b[p] << 8) | b[p + 1];
    if (itemlen < 2 || p + itemlen > b.length) return 1;
    const data = b.subarray(p, p + itemlen);
    p += itemlen;
    if (marker === 0xda || marker === 0xd9) return 1;
    if (marker === 0xe1) {
      if (itemlen <= 8 || data.toString('latin1', 2, 8) !== 'Exif\0\0') continue;
      const r = tiffOrientation(data.subarray(8), b.length);
      if (r === 'none') continue;
      return r;
    }
  }
}

// TIFF-Kopf in der APP1: 'none' = ungültig (weitersuchen), sonst der Wert (1, wenn keiner da ist)
function tiffOrientation(t: Buffer, fileSize: number): number | 'none' {
  if (t.length < 2) return 'none';
  const name = t.toString('latin1', 0, 2);
  if (name !== 'II' && name !== 'MM') return 'none';
  const mm = name === 'MM';
  if (t.length < 8) return 'none';
  const u16 = (o: number) => (mm ? t.readUInt16BE(o) : t.readUInt16LE(o));
  const u32 = (o: number) => (mm ? t.readUInt32BE(o) : t.readUInt32LE(o));
  const ifd = u32(4);
  if (u16(2) !== 0x2a || ifd < 8 || ifd > t.length) return 'none';
  const found: { ifd0?: unknown; exif?: unknown; other?: unknown } = {};
  // Ein IFD lesen; false = abgebrochen (dann auch das übergeordnete)
  const readIfd = (start: number, section: 'ifd0' | 'exif' | 'other', depth: number): boolean => {
    if (start + 2 > t.length) return false;
    const n = u16(start);
    if (start + 2 + n * 12 > t.length) return false;
    for (let i = 0; i < n; i++) {
      const e = start + 2 + i * 12;
      const tag = u16(e);
      let format = u16(e + 2);
      const count = u32(e + 4);
      if (!format || format > 12) format = 1;
      const bytes = count * TIFF_SIZES[format];
      if (bytes > 0x7fffffff) return false;
      let value: Buffer;
      if (bytes > 4) {
        const off = u32(e + 8);
        if (off + bytes <= t.length) value = t.subarray(off, off + bytes);
        // außerhalb der APP1: PHP liest dann aus der Datei – nur die Grenzen der Datei zählen
        else if (bytes > fileSize || off > fileSize - bytes) return false;
        else value = Buffer.alloc(0);
      } else {
        value = t.subarray(e + 8, e + 8 + Math.max(bytes, 0));
      }
      if (tag === 0x0112) found[section] = tagValue(value, format, count, mm);
      // Unter-IFDs (Exif, GPS, Interop): Zeiger als int32; ein Fehler darin beendet auch dieses IFD
      if ((tag === 0x8769 || tag === 0x8825 || tag === 0xa005) && depth < 3) {
        const raw = bytes > 4 ? value : t.subarray(e + 8, e + 12);
        if (raw.length < 4) return false;
        const sub = mm ? raw.readInt32BE(0) : raw.readInt32LE(0);
        if (sub < 0 || sub > t.length) return false;
        if (!readIfd(sub, tag === 0x8769 ? 'exif' : 'other', depth + 1)) return false;
      }
    }
    return true;
  };
  readIfd(ifd, 'ifd0', 0);
  const v = found.exif !== undefined ? found.exif : found.ifd0;
  return v === undefined ? 1 : intval(v);
}

// Wert eines Eintrags wie im Array von exif_read_data(): eine Zahl, Text oder (bei mehreren Werten) ein Array
function tagValue(v: Buffer, format: number, count: number, mm: boolean): unknown {
  if (count === 0) return null;
  if (format === 2) {
    const nul = v.indexOf(0);
    return v.toString('latin1', 0, nul < 0 ? v.length : nul);
  }
  if (format === 7 || ((format === 1 || format === 6) && count > 1)) return v.toString('latin1');
  if (count > 1) return [count];
  if (v.length < TIFF_SIZES[format]) return null;
  switch (format) {
    case 1: return v[0];
    case 6: return v.readInt8(0);
    case 3: return mm ? v.readUInt16BE(0) : v.readUInt16LE(0);
    case 8: return mm ? v.readInt16BE(0) : v.readInt16LE(0);
    case 4: return mm ? v.readUInt32BE(0) : v.readUInt32LE(0);
    case 9: return mm ? v.readInt32BE(0) : v.readInt32LE(0);
    case 5: case 10: {
      const num = format === 5 ? (mm ? v.readUInt32BE(0) : v.readUInt32LE(0)) : (mm ? v.readInt32BE(0) : v.readInt32LE(0));
      const den = format === 5 ? (mm ? v.readUInt32BE(4) : v.readUInt32LE(4)) : (mm ? v.readInt32BE(4) : v.readInt32LE(4));
      return num + '/' + den;
    }
    case 11: return mm ? v.readFloatBE(0) : v.readFloatLE(0);
    case 12: return mm ? v.readDoubleBE(0) : v.readDoubleLE(0);
    default: return null;
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
