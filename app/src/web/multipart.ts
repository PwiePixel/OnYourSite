// multipart/form-data genau wie PHP lesen (main/rfc1867.c, PHP 8.3): derselbe Puffer von 5 KB, Zeilen bis LF, Kopfzeilen,
// Teile bis "\n--Grenze", Feld- und Dateinamen über php_register_variable_ex() (setPhpVar), dazu die Grenzen
// max_input_vars, max_file_uploads, max_multipart_body_parts, upload_max_filesize und das Formularfeld MAX_FILE_SIZE.
// Wichtig für $_FILES: Nach einem verworfenen Datei-Teil (Klammern im Namen kaputt, mehr als 20 Dateien) verwirft PHP
// auch alle folgenden Dateien. Gearbeitet wird auf Bytes (latin1-Text: ein Zeichen = ein Byte), Namen und Werte
// werden erst am Ende als UTF-8 gelesen (Formularfelder mit ungültigem UTF-8 als rohe Bytes, siehe phpText). Jeder
// Schritt ist linear in der Länge des Inhalts (das Formular liest der Server vor jeder Anmeldung).
import { phpText, setPhpVar, strtolower, type PhpArray } from '../php.js';
import type { UploadedFile } from './ctx.js';

const FILLUNIT = 1024 * 5;
// Vorgaben von PHP (php.ini ohne Änderung; server/install.sh setzt nur upload_max_filesize und post_max_size)
const MAX_INPUT_VARS = 1000;
const MAX_FILE_UPLOADS = 20;

// isspace() im C-Gebietsschema (Zeichencode)
const isSpace = (c: number): boolean => c === 32 || (c >= 9 && c <= 13);
// C-Text: endet am ersten Nullbyte
const cstr = (s: string): string => {
  const z = s.indexOf('\0');
  return z < 0 ? s : s.slice(0, z);
};
const utf8 = (latin1: string): string => Buffer.from(latin1, 'latin1').toString('utf8');
// Formularfelder: ungültiges UTF-8 bleibt wie in PHP als rohe Bytes erhalten (phpText; strlen, oys_clean_text und
// password_hash hängen davon ab)
const text = (latin1: string): string => phpText(Buffer.from(latin1, 'latin1'));

// Grenze wie rfc1867_post_handler(): das erste "boundary" (sonst ohne Rücksicht auf Groß-/Kleinschreibung), ab dem
// nächsten '=' der Wert in Anführungszeichen oder bis ',' bzw. ';'. Auch leer möglich. null = PHP liest gar nicht
// (kein "boundary", kein '=', Anführungszeichen ohne Ende) – dann bleibt php://input gefüllt.
export function rfc1867Boundary(contentType: string): string | null {
  let at = contentType.indexOf('boundary');
  if (at < 0) at = strtolower(contentType).indexOf('boundary');
  const eq = at < 0 ? -1 : contentType.indexOf('=', at);
  if (eq < 0) return null;
  const rest = contentType.slice(eq + 1);
  if (rest.startsWith('"')) {
    const end = rest.indexOf('"', 1);
    return end < 0 ? null : rest.slice(1, end);
  }
  const end = rest.search(/[,;]/);
  return end >= 0 ? rest.slice(0, end) : rest;
}

// Suche nach einem festen Text: find(from) liefert den ersten Treffer ab from (text.length = keiner); wiederholte Fragen
// mit wachsendem from kosten zusammen nur einen Durchlauf. Muster über 250 Zeichen (eine absichtlich lange Grenze)
// prüft indexOf() von V8 nur am Ende schnell – an fast passenden Stellen wird es quadratisch langsam. Dann: kommt das
// erste Zeichen im Muster nur einmal vor ("\n--Grenze"), von Kandidat zu Kandidat mit startsWith() (zwischen zwei
// Kandidaten wird nichts doppelt verglichen), sonst Knuth-Morris-Pratt.
class Finder {
  private readonly mode: 'native' | 'first' | 'kmp';
  private readonly pi: Int32Array | null = null;
  private cacheFrom = -1;
  private cacheAt = -1;

  constructor(private readonly text: string, private readonly pat: string) {
    const m = pat.length;
    this.mode = m <= 250 ? 'native' : pat.indexOf(pat[0], 1) < 0 ? 'first' : 'kmp';
    if (this.mode !== 'kmp') return;
    this.pi = new Int32Array(m);
    for (let i = 1, k = 0; i < m; i++) {
      while (k > 0 && pat.charCodeAt(i) !== pat.charCodeAt(k)) k = this.pi[k - 1];
      if (pat.charCodeAt(i) === pat.charCodeAt(k)) k++;
      this.pi[i] = k;
    }
  }

  find(from: number): number {
    if (from >= this.cacheFrom && from <= this.cacheAt) return this.cacheAt;
    this.cacheFrom = from;
    this.cacheAt = this.mode === 'native' ? this.text.indexOf(this.pat, from) : this.mode === 'first' ? this.first(from) : this.kmp(from);
    if (this.cacheAt < 0) this.cacheAt = this.text.length;
    return this.cacheAt;
  }

  private first(from: number): number {
    const c = this.pat[0];
    for (let p = this.text.indexOf(c, from); p >= 0; p = this.text.indexOf(c, p + 1)) {
      if (this.text.startsWith(this.pat, p)) return p;
    }
    return -1;
  }

  private kmp(from: number): number {
    const t = this.text;
    const p = this.pat;
    const pi = this.pi!;
    const m = p.length;
    const first = p[0];
    for (let i = from, q = 0; i < t.length; i++) {
      // Ohne Teiltreffer gleich zum nächsten passenden ersten Zeichen
      if (q === 0) {
        i = t.indexOf(first, i);
        if (i < 0) return -1;
      }
      const c = t.charCodeAt(i);
      while (q > 0 && c !== p.charCodeAt(q)) q = pi[q - 1];
      if (c === p.charCodeAt(q)) q++;
      if (q === m) return i - m + 1;
    }
    return -1;
  }
}

// multipart_buffer: der Puffer ist immer ein zusammenhängendes Stück des Inhalts (input[start, start + len)), höchstens
// bufsize lang und nachgefüllt wie fill_buffer() – darum ohne Kopien
class MultipartBuffer {
  private start = 0;
  private len = 0;
  // Anfang der zuletzt gelesenen Zeile
  private lineStart = 0;
  // Nächstes \n ab lfFrom (gemerkt, damit die Suche über den ganzen Inhalt linear bleibt)
  private lfFrom = 0;
  private lfAt = -1;
  // Nächster ':' und nächstes Nullbyte ab …From (für die Kopfzeilen)
  private colonFrom = 0;
  private colonAt = -1;
  private nulFrom = 0;
  private nulAt = -1;
  readonly boundary: string;
  readonly boundaryNext: string;
  private readonly bufsize: number;
  private readonly lineFinder: Finder;
  private readonly nextFinder: Finder;

  constructor(private readonly input: string, boundary: string) {
    // spprintf("--%s"): die Grenze als C-Text
    this.boundary = '--' + cstr(boundary);
    this.boundaryNext = '\n--' + cstr(boundary);
    this.bufsize = Math.max(FILLUNIT, boundary.length + 6);
    this.lineFinder = new Finder(input, this.boundary);
    this.nextFinder = new Finder(input, this.boundaryNext);
  }

  // Erstes Vorkommen eines einzelnen Zeichens ab from (input.length = keins), gemerkt
  private nextColon(from: number): number {
    if (from < this.colonFrom || from > this.colonAt) {
      const i = this.input.indexOf(':', from);
      this.colonFrom = from;
      this.colonAt = i < 0 ? this.input.length : i;
    }
    return this.colonAt;
  }

  private nextNul(from: number): number {
    if (from < this.nulFrom || from > this.nulAt) {
      const i = this.input.indexOf('\0', from);
      this.nulFrom = from;
      this.nulAt = i < 0 ? this.input.length : i;
    }
    return this.nulAt;
  }

  // Erstes \n ab from (input.length = keins)
  private nextLf(from: number): number {
    if (from < this.lfFrom || from > this.lfAt) {
      const i = this.input.indexOf('\n', from);
      this.lfFrom = from;
      this.lfAt = i < 0 ? this.input.length : i;
    }
    return this.lfAt;
  }

  // fill_buffer(): bis bufsize auffüllen
  private fill(): number {
    const n = Math.min(this.bufsize - this.len, this.input.length - this.start - this.len);
    if (n <= 0) return 0;
    this.len += n;
    return n;
  }

  // multipart_buffer_eof()
  eof(): boolean {
    return this.len === 0 && this.fill() < 1;
  }

  // next_line(): Zeile bis LF (ein CR davor fällt weg); ohne LF in vollem Puffer der ganze Puffer, sonst -1.
  // Liefert das Ende der Zeile, der Anfang steht in lineStart.
  private nextLine(): number {
    const end = this.start + this.len;
    const lf = this.nextLf(this.start);
    this.lineStart = this.start;
    if (lf < end) {
      const stop = lf > this.start && this.input.charCodeAt(lf - 1) === 13 ? lf - 1 : lf;
      this.len -= lf + 1 - this.start;
      this.start = lf + 1;
      return stop;
    }
    if (this.len < this.bufsize) return -1;
    this.start = end;
    this.len = 0;
    return end;
  }

  // get_line()
  private getLineEnd(): number {
    let end = this.nextLine();
    if (end < 0) {
      this.fill();
      end = this.nextLine();
    }
    return end;
  }

  getLine(): string | null {
    const end = this.getLineEnd();
    return end < 0 ? null : cstr(this.input.slice(this.lineStart, end));
  }

  // find_boundary(): Zeilen überspringen bis genau "--Grenze" (als C-Text: danach Ende oder ein Nullbyte). Statt jede
  // Zeile anzusehen, nur die Stellen, an denen der Text der Grenze steht: Sie zählen, wenn dort ein Stück beginnt, das
  // get_line() liefern würde – am Zeilenanfang oder, bei Zeilen über bufsize, bei Vielfachen von bufsize ab dem Anfang
  // (ein Rest am Ende ohne LF kommt nie zurück). Danach steht der Puffer hinter dieser Zeile.
  findBoundary(): boolean {
    const input = this.input;
    const b = this.boundary;
    const bs = this.bufsize;
    const origin = this.start;
    let lineStart = origin;
    let lineLf = -1;
    for (let c = this.lineFinder.find(origin); c < input.length;) {
      if (c > lineLf) {
        // Neue Zeile: Anfang rückwärts suchen (nicht vor origin), Ende vorwärts
        let i = c - 1;
        while (i >= origin && input.charCodeAt(i) !== 10) i--;
        lineStart = i + 1;
        lineLf = this.nextLf(c);
      }
      const offset = (c - lineStart) % bs;
      if (offset === 0) {
        const whole = lineLf - c >= bs;
        if (whole || lineLf < input.length) {
          const stop = whole ? c + bs : lineLf > c && input.charCodeAt(lineLf - 1) === 13 ? lineLf - 1 : lineLf;
          if (stop - c === b.length || (stop - c > b.length && input.charCodeAt(c + b.length) === 0)) {
            this.start = whole ? c + bs : lineLf + 1;
            this.len = 0;
            return true;
          }
        }
      }
      // Weiter beim nächsten Stück dieser Zeile oder bei der nächsten Zeile
      c = this.lineFinder.find(Math.min(c - offset + bs, lineLf + 1));
    }
    this.start = input.length;
    this.len = 0;
    return false;
  }

  // multipart_buffer_headers() und php_mime_get_hdr_value(): Kopfzeilen bis zur Leerzeile, Fortsetzungen (Leerraum vorn
  // oder ohne ':') hängen am vorigen Wert. Gebraucht wird nur der jeweils erste Content-Disposition- und Content-Type-Kopf
  // (Name ohne Rücksicht auf Groß-/Kleinschreibung).
  headers(): { cd: string | null; ct: string | null } | null {
    if (!this.findBoundary()) return null;
    const input = this.input;
    let cd: string | null = null;
    let ct: string | null = null;
    // Der laufende Kopf: gibt es einen (buf_value), und wird sein Wert gebraucht (cd/ct)?
    let open = false;
    let want: 'cd' | 'ct' | null = null;
    let parts: string[] = [];
    const done = (): void => {
      if (want === 'cd' && cd === null) cd = parts.join('');
      else if (want === 'ct' && ct === null) ct = parts.join('');
    };
    for (let end = this.getLineEnd(); end >= 0; end = this.getLineEnd()) {
      const s = this.lineStart;
      // als C-Text: am ersten Nullbyte zu Ende; eine leere Zeile beendet die Köpfe
      const e = Math.min(end, this.nextNul(s));
      if (e === s) break;
      const colon = isSpace(input.charCodeAt(s)) ? -1 : this.nextColon(s);
      if (colon >= 0 && colon < e) {
        done();
        open = true;
        const len = colon - s;
        const key = len === 19 || len === 12 ? strtolower(input.slice(s, colon)) : '';
        want = key === 'content-disposition' && cd === null ? 'cd' : key === 'content-type' && ct === null ? 'ct' : null;
        if (want) {
          let v = colon + 1;
          while (v < e && isSpace(input.charCodeAt(v))) v++;
          parts = [input.slice(v, e)];
        }
      } else if (open && want) {
        parts.push(input.slice(s, e));
      }
    }
    done();
    return { cd, ct };
  }

  // php_ap_memstr() im Puffer: erste Stelle, an der "\n--Grenze" beginnt; partial: auch nur angeschnitten am Ende des
  // Puffers (das kann nur in den letzten needle-1 Bytes sein, vor jedem ganzen Treffer im Puffer kommt keiner)
  private memstr(partial: boolean): number {
    const needle = this.boundaryNext;
    const end = this.start + this.len;
    const full = this.nextFinder.find(this.start);
    if (full + needle.length <= end) return full;
    if (!partial) return -1;
    for (let p = Math.max(this.start, end - needle.length + 1); p < end; p++) {
      if (this.input.charCodeAt(p) === 10 && needle.startsWith(this.input.slice(p, end))) return p;
    }
    return -1;
  }

  // multipart_buffer_read(): Daten bis vor die (mögliche) nächste Grenze, höchstens bytes - 1 auf einmal; ein CR
  // direkt davor bleibt für den nächsten Aufruf liegen. end: die ganze Grenze steht im Puffer.
  read(bytes: number, state?: { end: boolean }): string {
    if (bytes > this.len) this.fill();
    const bound = this.memstr(true);
    let max = this.len;
    if (bound >= 0) {
      max = bound - this.start;
      if (state && !state.end && this.memstr(false) >= 0) state.end = true;
    }
    let len = Math.min(max, bytes - 1);
    if (len <= 0) return '';
    if (bound >= 0 && this.input.charCodeAt(this.start + len - 1) === 13) len--;
    const out = this.input.slice(this.start, this.start + len);
    this.start += len;
    this.len -= len;
    return out;
  }

  // multipart_buffer_read_body()
  readBody(): string {
    const parts: string[] = [];
    for (let chunk = this.read(FILLUNIT); chunk !== ''; chunk = this.read(FILLUNIT)) parts.push(chunk);
    return parts.join('');
  }
}

// php_ap_getword(): bis zum Trennzeichen (Anführungszeichen mit \-Maskierung werden übersprungen); danach alle
// folgenden Trennzeichen weg
function getword(s: string, at: number, stop: number): [string, number] {
  const n = s.length;
  let pos = at;
  while (pos < n) {
    const c = s.charCodeAt(pos);
    if (c === stop) break;
    if (c === 34 || c === 39) {
      pos++;
      while (pos < n) {
        const d = s.charCodeAt(pos);
        if (d === c) break;
        pos += d === 92 && s.charCodeAt(pos + 1) === c ? 2 : 1;
      }
      if (pos < n) pos++;
    } else {
      pos++;
    }
  }
  if (pos >= n) return [s.slice(at), n];
  const word = s.slice(at, pos);
  while (s.charCodeAt(pos) === stop) pos++;
  return [word, pos];
}

// php_ap_getword_conf() mit substring_conf(): Wert in Anführungszeichen (\\ und \" bzw. \' maskiert) oder bis zum
// Leerraum (nur \\ maskiert)
function getwordConf(s: string): string {
  let i = 0;
  while (isSpace(s.charCodeAt(i))) i++;
  if (i >= s.length) return '';
  const quote = s.charCodeAt(i);
  const quoted = quote === 34 || quote === 39;
  let end = s.length;
  if (quoted) {
    i++;
    // Meist ohne \: dann bis zum Anführungszeichen
    const close = s.indexOf(s[i - 1], i);
    const slash = s.indexOf('\\', i);
    if (slash < 0 || (close >= 0 && close < slash)) return s.slice(i, close < 0 ? s.length : close);
  } else {
    end = i;
    while (end < s.length && !isSpace(s.charCodeAt(end))) end++;
    const slash = s.indexOf('\\', i);
    if (slash < 0 || slash >= end) return s.slice(i, end);
  }
  // substring_conf(): bis zum Anführungszeichen; \\ und (in Anführungszeichen) \" bzw. \' stehen für das zweite Zeichen
  const out = Buffer.allocUnsafe(end - i);
  let n = 0;
  for (; i < end; i++) {
    let c = s.charCodeAt(i);
    if (quoted && c === quote) break;
    if (c === 92) {
      const next = s.charCodeAt(i + 1);
      if (next === 92 || (quoted && next === quote)) {
        c = next;
        i++;
      }
    }
    out[n++] = c;
  }
  return out.toString('latin1', 0, n);
}

// php_ap_basename(): alles nach dem letzten / oder \
function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
}

// strtoll(s, NULL, 10) für MAX_FILE_SIZE (Überlauf bleibt an der Grenze stehen)
function strtoll(s: string): bigint {
  const m = /^[ \t\n\v\f\r]*([+-]?)([0-9]+)/.exec(s);
  if (!m) return 0n;
  const n = BigInt(m[1] + m[2]);
  const max = 2n ** 63n - 1n;
  return n > max ? max : n < -max - 1n ? -max - 1n : n;
}

// „never repair potential malicious user input“: jede [ schließt, nach ] folgt nur [ oder das Ende
function bracketsOk(param: string): boolean {
  let depth = 0;
  for (let i = 0; i < param.length; i++) {
    const c = param.charCodeAt(i);
    if (c === 91) {
      depth++;
    } else if (c === 93) {
      depth--;
      if (i + 1 < param.length && param.charCodeAt(i + 1) !== 91) return false;
    }
    if (depth < 0) return false;
  }
  return depth === 0;
}

export interface PhpForm {
  // $_POST
  post: PhpArray;
  // $_FILES wie PHP es aufbaut (tmp_name ist ein Kennzeichen für den Inhalt in uploads)
  filesVars: PhpArray;
  // ctx.files: je Schlüssel von $_FILES eine Datei; Arrays von Dateien (name[…]) nur als multiple markiert
  files: Record<string, UploadedFile>;
  // tmp_name → Inhalt jeder angenommenen Datei
  uploads: Map<string, Buffer>;
}

// rfc1867_post_handler(): null, wenn PHP den Inhalt nicht liest (dann bleibt php://input gefüllt). uploadMax =
// upload_max_filesize in Bytes. Die Länge des ganzen Inhalts (post_max_size) prüft der Aufrufer.
export function phpMultipart(contentType: string, body: Buffer, uploadMax: number): PhpForm | null {
  const boundary = rfc1867Boundary(contentType);
  if (boundary === null) return null;
  const mbuff = new MultipartBuffer(body.toString('latin1'), boundary);
  const post: PhpArray = {};
  const filesVars: PhpArray = {};
  const uploads = new Map<string, Buffer>();
  let uploadCnt = MAX_FILE_UPLOADS;
  let bodyParts = MAX_INPUT_VARS + MAX_FILE_UPLOADS;
  let count = 0;
  let skipUpload = false;
  let anonymousIndex = 0;
  let maxFileSize = 0n;

  // php_register_variable_safe(): Namen als UTF-8 wie bei allen Formularen
  const register = (target: PhpArray, name: string, value: string): void => setPhpVar(target, utf8(name), value);

  while (!mbuff.eof()) {
    const headers = mbuff.headers();
    if (headers === null) break;
    const cd = headers.cd;
    if (cd === null) continue;
    if (--bodyParts < 0) break;

    let param: string | null = null;
    let filename: string | null = null;
    let at = 0;
    while (isSpace(cd.charCodeAt(at))) at++;
    while (at < cd.length) {
      const [pair, next] = getword(cd, at, 59);
      at = next;
      while (isSpace(cd.charCodeAt(at))) at++;
      if (pair.includes('=')) {
        const [key, rest] = getword(pair, 0, 61);
        if (key.length === 4 && strtolower(key) === 'name') param = getwordConf(pair.slice(rest));
        else if (key.length === 8 && strtolower(key) === 'filename') filename = getwordConf(pair.slice(rest));
      }
    }

    // Normales Formularfeld
    if (filename === null && param !== null) {
      const value = mbuff.readBody();
      if (++count <= MAX_INPUT_VARS) setPhpVar(post, text(param), text(value));
      if (param.length === 13 && strtolower(param) === 'max_file_size') maxFileSize = strtoll(cstr(value));
      continue;
    }

    // Datei
    if (uploadCnt <= 0) skipUpload = true;
    if (param === null && filename === null) break;
    if (param === null) param = String(anonymousIndex++);
    if (!skipUpload && !bracketsOk(param)) skipUpload = true;
    if (skipUpload) continue;

    let cancel = filename === '' ? 4 : 0;
    const content: string[] = [];
    let total = 0;
    const state = { end: false };
    if (!cancel) {
      let chunk = mbuff.read(FILLUNIT, state);
      uploadCnt--;
      while (!cancel && chunk !== '') {
        if (uploadMax > 0 && total + chunk.length > uploadMax) {
          cancel = 1;
        } else if (maxFileSize !== 0n && BigInt(total + chunk.length) > maxFileSize) {
          cancel = 2;
        } else {
          content.push(chunk);
          total += chunk.length;
        }
        // PHP liest auch nach dem Abbruch noch einmal (der Rest bleibt dann für find_boundary())
        chunk = mbuff.read(FILLUNIT, state);
      }
    }
    if (!cancel && !state.end) cancel = 3;

    // name[…] (mit ] am Ende) ist ein Array von Dateien: abuf[name][index]
    const p = param;
    const open = p.indexOf('[');
    const isArray = open >= 0 && p.endsWith(']');
    const varName = (sub: string): string => (isArray ? `${p.slice(0, open)}[${sub}][${p.slice(open + 1, -1)}]` : `${p}[${sub}]`);
    // Bei jedem Fehler (auch 3 = nur teilweise angekommen) bleibt der Typ leer
    const type = cancel ? '' : (headers.ct ?? '').split(';')[0];
    const token = `\0upload${uploads.size}`;
    uploads.set(token, cancel ? Buffer.alloc(0) : Buffer.from(content.join(''), 'latin1'));
    register(filesVars, varName('name'), utf8(basename(filename!)));
    register(filesVars, varName('full_path'), utf8(filename!));
    register(filesVars, varName('type'), utf8(type));
    register(filesVars, varName('tmp_name'), cancel ? '' : token);
    register(filesVars, varName('error'), String(cancel));
    register(filesVars, varName('size'), String(cancel ? 0 : total));
  }

  // ctx.files: eine Datei je Schlüssel, wenn PHP dort einzelne Werte hat; sonst ein Array von Dateien
  const files: Record<string, UploadedFile> = {};
  for (const [key, entry] of Object.entries(filesVars)) {
    if (typeof entry !== 'object') continue;
    const s = (k: string): string | null => (typeof entry[k] === 'string' ? (entry[k] as string) : null);
    const [name, type, tmp, error, size] = [s('name'), s('type'), s('tmp_name'), s('error'), s('size')];
    const file: UploadedFile = name !== null && type !== null && tmp !== null && error !== null && size !== null
      ? { name, type, size: Number(size), data: uploads.get(tmp) ?? Buffer.alloc(0), error: Number(error) }
      : { name: '', type: '', size: 0, data: Buffer.alloc(0), error: 0, multiple: true };
    Object.defineProperty(files, key, { value: file, writable: true, enumerable: true, configurable: true });
  }
  return { post, filesVars, files, uploads };
}
