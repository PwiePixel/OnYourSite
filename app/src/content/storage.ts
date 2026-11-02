// Upload-Ordner (lib/storage.php). Standard: static/uploads im Code-Ordner. Mit uploads_dir in den Einstellungen
// liegt er außerhalb des Codes (übersteht Updates); die Adressen bleiben /static/uploads/…
import {
  accessSync, chownSync, constants as fsc, copyFileSync, createReadStream, createWriteStream, mkdirSync, openSync, closeSync,
  readdirSync, realpathSync, renameSync, statSync, unlinkSync, type Stats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import yazl from 'yazl';
import type { Ctx } from '../web/ctx.js';
import { ROOT_DIR, config } from '../config.js';
import { randomHex } from '../crypto.js';
import { date, gmdate, phpStr, phpTrim, phpRtrim, strlen, strtolower } from '../php.js';

// oys_uploads_default_dir() – Tests können einen anderen Code-Ordner vorgeben
let defaultDirForTests: string | null = null;
export const uploadsDefaultDir = (): string => defaultDirForTests ?? ROOT_DIR + '/static/uploads';
export function setUploadsDefaultDirForTests(dir: string | null): void {
  defaultDirForTests = dir;
}

// oys_uploads_dir(): relative Angaben gelten ab dem Code-Ordner (z. B. "../oys-uploads")
export function uploadsDir(): string {
  // (string) oys_config('uploads_dir', ''): true → "1", false → "", Arrays → "Array"
  const set = phpTrim(phpStr(config<unknown>('uploads_dir', '')));
  if (set === '') return uploadsDefaultDir();
  const absolute = set[0] === '/' || /^[A-Za-z]:[\\/]/.test(set);
  return phpRtrim(absolute ? set : ROOT_DIR + '/' + set, '/\\');
}

const real = (p: string): string | false => {
  try {
    return realpathSync(p);
  } catch {
    return false;
  }
};

// oys_uploads_external(): liegt der Ordner außerhalb des Codes?
export function uploadsExternal(): boolean {
  const a = real(uploadsDir());
  const b = real(uploadsDefaultDir());
  return (a !== false ? a : uploadsDir()) !== (b !== false ? b : uploadsDefaultDir());
}

// oys_uploads_suggested_dir(): Vorschlag neben dem Code-Ordner
export const uploadsSuggestedDir = (): string => dirname(ROOT_DIR) + '/oys-uploads';

// oys_upload_path()
export const uploadPath = (name: string): string => uploadsDir() + '/' + name;

export const isFile = (p: string | Buffer): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

// oys_upload_read_path(): nach dem Umzug liegen manche Dateien evtl. noch im alten Ordner
export function uploadReadPath(name: string): string {
  const path = uploadPath(name);
  if (!isFile(path) && uploadsExternal() && isFile(uploadsDefaultDir() + '/' + name)) return uploadsDefaultDir() + '/' + name;
  return path;
}

// oys_upload_name_ok(): nur einfache Namen, keine Ordner, nichts Verstecktes
export function uploadNameOk(name: string): boolean {
  return name !== '' && strlen(name) <= 200 && !name.includes('/') && !name.includes('\\') && name[0] !== '.' && !name.includes('\0') && !name.includes('..');
}

// Dasselbe auf den Bytes eines Namens (aus einer Adresse dekodiert, muss kein gültiges UTF-8 sein)
function uploadNameBytesOk(name: Buffer): boolean {
  return name.length > 0 && name.length <= 200 && !name.includes(0x2f) && !name.includes(0x5c) && name[0] !== 0x2e && !name.includes(0) && !name.includes('..');
}

// rawurldecode() auf Bytes: %XX wird zum Byte, alles andere (auch +) bleibt
function rawurldecodeBytes(s: string): Buffer {
  const src = Buffer.from(s, 'latin1');
  const out = Buffer.alloc(src.length);
  let n = 0;
  const hex = (c: number) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
  for (let i = 0; i < src.length; i++) {
    if (src[i] === 0x25 && i + 2 < src.length && hex(src[i + 1]) && hex(src[i + 2])) {
      out[n++] = parseInt(src.toString('latin1', i + 1, i + 3), 16);
      i += 2;
    } else {
      out[n++] = src[i];
    }
  }
  return out.subarray(0, n);
}

// pathinfo($name, PATHINFO_EXTENSION): alles nach dem letzten Punkt (ohne Punkt: '')
function extensionOf(name: Buffer): string {
  const dot = name.lastIndexOf(0x2e);
  return dot < 0 ? '' : name.toString('latin1', dot + 1);
}

// Inhaltstypen für /static/uploads/ (wie storage.php). PHP hängt an text/…-Typen ohne Zeichensatz selbst
// ";charset=UTF-8" an (default_charset) – daher steht das bei vcf hier ausgeschrieben.
const UPLOAD_TYPES: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', aac: 'audio/aac', flac: 'audio/flac',
  mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf', vcf: 'text/vcard;charset=UTF-8', zip: 'application/zip', txt: 'text/plain; charset=utf-8',
});
// Wie static/uploads/.htaccess: nie als Skript, HTML oder SVG ausliefern
const DENIED = new Set(['php', 'php3', 'php4', 'php5', 'php7', 'php8', 'phtml', 'phar', 'pl', 'py', 'cgi', 'sh', 'html', 'htm', 'xhtml', 'shtml', 'svg', 'svgz', 'js', 'mjs', 'xml', 'xsl']);

// oys_serve_upload(): /static/uploads/{datei} ausliefern, wenn der Ordner nicht im Web-Ordner liegt (läuft ohne
// Datenbank). Mit ETag/304, Teilbereichen (Range) und nur zum Herunterladen bei unbekannten Typen.
export async function serveUpload(ctx: Ctx, raw: string): Promise<void> {
  const name = rawurldecodeBytes(raw);
  const ext = strtolower(extensionOf(name));
  const path = Buffer.concat([Buffer.from(uploadsDir() + '/', 'utf8'), name]);
  let st: Stats | null = null;
  if (uploadNameBytesOk(name) && ext !== '' && !DENIED.has(ext)) {
    try {
      st = statSync(path);
    } catch {
      st = null;
    }
  }
  if (!st || !st.isFile()) {
    ctx.status = 404;
    ctx.header('Content-Type', 'text/plain; charset=utf-8');
    ctx.body = 'Not found';
    return;
  }
  const size = st.size;
  const mtime = Math.floor(st.mtimeMs / 1000);
  const etag = '"' + dechex(mtime) + '-' + dechex(size) + '"';
  const type = UPLOAD_TYPES[ext];
  ctx.header('Content-Type', type ?? 'application/octet-stream');
  if (type === undefined) ctx.header('Content-Disposition', 'attachment');
  ctx.header('X-Content-Type-Options', 'nosniff');
  // Browser: 30 Tage. Zwischenspeicher wie Cloudflare: 1 Stunde – gelöschte Dateien verschwinden dort bald
  ctx.header('Cache-Control', 'public, max-age=2592000, s-maxage=3600');
  ctx.header('Last-Modified', gmdate('D, d M Y H:i:s', mtime) + ' GMT');
  ctx.header('ETag', etag);
  ctx.header('Accept-Ranges', 'bytes');
  if (String(ctx.headers['if-none-match'] ?? '') === etag) {
    ctx.status = 304;
    ctx.body = '';
    return;
  }
  // Teilbereiche (Safari braucht das für Musik). (int) wie PHP: zu große Zahlen bleiben bei PHP_INT_MAX stehen.
  let start = 0;
  let end = size - 1;
  const m = /^bytes=(\d*)-(\d*)(?=\n?$)/.exec(String(ctx.headers.range ?? ''));
  if (m && (m[1] !== '' || m[2] !== '')) {
    if (m[1] === '') {
      start = Math.max(0, size - toInt(m[2]));
    } else {
      start = toInt(m[1]);
      end = m[2] !== '' ? Math.min(toInt(m[2]), size - 1) : size - 1;
    }
    if (start > end || start >= size) {
      ctx.status = 416;
      ctx.header('Content-Range', 'bytes */' + size);
      ctx.body = '';
      return;
    }
    ctx.status = 206;
    ctx.header('Content-Range', 'bytes ' + start + '-' + end + '/' + size);
  }
  ctx.header('Content-Length', String(end - start + 1));
  if (ctx.method === 'HEAD' || end < start) {
    ctx.body = '';
    return;
  }
  // fopen() schlägt fehl → Kopfzeilen ohne Inhalt (wie PHP)
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    ctx.body = '';
    return;
  }
  ctx.body = createReadStream(path, { fd, start, end, highWaterMark: 65536 });
}

// dechex(): negative Zahlen (Änderungszeit vor 1970) als 64-Bit-Zweierkomplement
const dechex = (n: number): string => (n < 0 ? BigInt.asUintN(64, BigInt(n)) : n).toString(16);

// (int) "123…" für Ziffernfolgen: über 2^63 bleibt PHP bei PHP_INT_MAX stehen
const toInt = (digits: string): number => Math.min(Number(digits), 2 ** 63);

// ---------------------------------------------------------------- Dateien im Ordner, Backup, Umzug

interface DirFile {
  // Name als Text (für Rückgaben) und als Bytes (für Zugriffe – auch Namen, die kein gültiges UTF-8 sind)
  name: string;
  raw: Buffer;
  size: number;
}

// glob($dir . '/*') + is_file: Einträge ohne führenden Punkt, nach Bytes sortiert (strcmp im C-Locale)
function dirFiles(dir: string, accept: (raw: Buffer) => boolean = () => true): DirFile[] {
  let names: Buffer[];
  try {
    names = readdirSync(dir, { encoding: 'buffer' });
  } catch {
    return [];
  }
  const out: DirFile[] = [];
  const base = Buffer.from(dir + '/', 'utf8');
  for (const raw of names.filter((n) => n[0] !== 0x2e && accept(n)).sort(Buffer.compare)) {
    try {
      const st = statSync(Buffer.concat([base, raw]));
      if (st.isFile()) out.push({ name: raw.toString('utf8'), raw, size: st.size });
    } catch {
      // verschwunden oder kaputter Link: wie is_file() → false
    }
  }
  return out;
}

// oys_storage_files(): alle Dateien im Upload-Ordner (ohne Unterordner und Hilfsdateien): Name → Bytes
export function storageFiles(dir: string | null = null): Map<string, number> {
  const files = new Map<string, number>();
  for (const f of dirFiles(dir ?? uploadsDir())) files.set(f.name, f.size);
  return files;
}

// Für die Uploads eines Kontos (oys_user_upload_files): glob(dir/*_{id}_*) – Name enthält „_{id}_“
export function dirFilesMatching(dir: string, part: string): DirFile[] {
  const needle = Buffer.from(part, 'utf8');
  return dirFiles(dir, (raw) => raw.includes(needle));
}

const RETRY = 'The backup couldn’t be finished – a file probably changed while it was being packed, or the temporary folder is full. Please try again.';

// oys_storage_download_zip(): alle Uploads als ZIP (Backup). Gibt eine Fehlermeldung zurück oder beendet die Anfrage
// mit dem ZIP. Wie PHP entsteht das Archiv erst ganz in einer Zwischendatei (Fehler → Meldung statt halbem Download).
export async function storageDownloadZip(ctx: Ctx): Promise<string> {
  const dir = uploadsDir();
  const files = dirFiles(dir);
  if (!files.length) return 'There are no uploads yet.';
  let tmp: string;
  try {
    tmp = tmpdir() + '/oys-backup' + randomHex(6);
    closeSync(openSync(tmp, 'wx', 0o600));
  } catch {
    return 'The backup file couldn’t be created (temporary folder not writable).';
  }
  const drop = () => {
    try {
      unlinkSync(tmp);
    } catch {
      // schon weg
    }
  };
  const ok = await new Promise<boolean>((resolve) => {
    const zip = new yazl.ZipFile();
    const out = createWriteStream(tmp);
    let failed = false;
    const fail = () => {
      if (failed) return;
      failed = true;
      zip.outputStream.unpipe(out);
      out.destroy();
      resolve(false);
    };
    zip.on('error', fail);
    out.on('error', fail);
    out.on('close', () => {
      if (!failed) resolve(true);
    });
    zip.outputStream.pipe(out);
    const base = Buffer.from(dir + '/', 'utf8');
    try {
      // Bilder und Musik sind schon komprimiert – nur speichern geht schneller. Ohne zusätzliches Zeitstempel-Feld
      // wie bei ZipArchive (sonst meldet unzip bei Umlauten in einer Umgebung ohne UTF-8 eine Warnung).
      for (const f of files) zip.addFile(Buffer.concat([base, f.raw]) as unknown as string, 'uploads/' + f.name, { compress: false, forceDosTimestamp: true });
      zip.end();
    } catch {
      fail();
    }
  });
  let size = 0;
  try {
    size = statSync(tmp).size;
  } catch {
    size = 0;
  }
  if (!ok || !size) {
    drop();
    return RETRY;
  }
  ctx.header('Content-Type', 'application/zip');
  ctx.header('Content-Disposition', 'attachment; filename="onyoursite-uploads-' + date('Y-m-d') + '.zip"');
  ctx.header('Content-Length', String(size));
  ctx.header('Cache-Control', 'no-store');
  // Die Zwischendatei verschwindet auch, wenn der Download abbricht
  const stream = createReadStream(tmp);
  stream.on('close', drop);
  ctx.send(stream);
}

export interface MoveResult {
  moved: number;
  skipped?: number;
  error: string | null;
}

// rename() wie PHP: über Dateisystemgrenzen kopieren, Besitzer und Rechte übernehmen, dann das Original löschen –
// ob das Löschen klappt, prüft PHP nicht mehr (die Datei gilt als verschoben)
function phpRename(from: Buffer, to: Buffer): boolean {
  try {
    renameSync(from, to);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') return false;
  }
  try {
    copyFileSync(from, to);
    const st = statSync(from);
    try {
      chownSync(to, st.uid, st.gid);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EPERM') return false;
    }
  } catch {
    return false;
  }
  try {
    unlinkSync(from);
  } catch {
    // wie VCWD_UNLINK() ohne Prüfung
  }
  return true;
}

// oys_storage_move_to_data_dir(): Dateien aus static/uploads in den eingestellten Ordner verschieben (einmalig)
export function storageMoveToDataDir(): MoveResult {
  const from = uploadsDefaultDir();
  const to = uploadsDir();
  if (!uploadsExternal()) return { moved: 0, error: 'Set “uploads_dir” in config.json and restart the website first.' };
  let dirOk = false;
  try {
    dirOk = statSync(to).isDirectory();
  } catch {
    dirOk = false;
  }
  if (!dirOk) {
    try {
      mkdirSync(to, { recursive: true, mode: 0o755 });
    } catch {
      return { moved: 0, error: 'The folder ' + to + ' couldn’t be created – create it in the file manager (permissions 755).' };
    }
  }
  try {
    accessSync(to, fsc.W_OK);
  } catch {
    return { moved: 0, error: 'The folder ' + to + ' isn’t writable (permissions 755).' };
  }
  let moved = 0;
  let skipped = 0;
  const src = Buffer.from(from + '/', 'utf8');
  const dst = Buffer.from(to + '/', 'utf8');
  for (const f of dirFiles(from)) {
    const target = Buffer.concat([dst, f.raw]);
    if (isFile(target)) {
      skipped++;
      continue;
    }
    const source = Buffer.concat([src, f.raw]);
    if (phpRename(source, target) || copyAndUnlink(source, target)) moved++;
  }
  return { moved, skipped, error: null };
}

// @copy(...) && @unlink(...)
function copyAndUnlink(from: Buffer, to: Buffer): boolean {
  try {
    copyFileSync(from, to);
  } catch {
    return false;
  }
  try {
    unlinkSync(from);
    return true;
  } catch {
    return false;
  }
}
