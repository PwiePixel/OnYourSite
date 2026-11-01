// Kleine Nachbauten von PHP-Funktionen, deren Verhalten die Ausgabe der Seite bestimmt. JavaScript macht vieles
// anders (Wahrheitswerte, trim, Groß-/Kleinschreibung, Datumsformate, Formular-Felder) – hier steht es einmal richtig.
import { timeZone } from './db.js';

// ---------------------------------------------------------------- Werte

// PHP-Wahrheitswert: falsch sind null, false, 0, 0.0, '', '0' und leere Arrays/Objekte
export function phpTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '' || v === '0') return false;
  if (typeof v === 'number' && Number.isNaN(v)) return true;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true;
}
export const phpEmpty = (v: unknown): boolean => !phpTruthy(v);

// (string) $v
export function phpStr(v: unknown): string {
  if (v === null || v === undefined || v === false) return '';
  if (v === true) return '1';
  // Ganze Zahlen bis 1e15 wie int; größere kommen nur aus Kommazahlen (BIGINT liefert die Datenbank als Text)
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) < 1e15 ? String(v) : phpFloatToString(v);
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v) || typeof v === 'object') return (v as object) instanceof Buffer ? (v as Buffer).toString('utf8') : 'Array';
  return String(v);
}

// Gleitkommazahl als Text wie PHP (precision = 14)
export function phpFloatToString(f: number): string {
  if (!Number.isFinite(f)) return f > 0 ? 'INF' : f < 0 ? '-INF' : 'NAN';
  const s = f.toPrecision(14);
  if (s.includes('e')) {
    let [m, ex] = s.split('e');
    m = m.includes('.') ? m.replace(/\.?0+$/, '') : m;
    const n = parseInt(ex, 10);
    return m + (m.includes('.') ? '' : '.0') + 'E' + (n < 0 ? '-' : '+') + Math.abs(n);
  }
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

// (int) $v: Leerraum am Anfang, Vorzeichen, Ziffern; "1e3" → 1000, "12abc" → 12, Arrays → 0/1
// Überlauf wie PHP (64 Bit): Kommazahlen modulo 2^64, Text bleibt bei ±2^63 stehen, unendlich wird 0.
// Genau 2^63 gilt als PHP_INT_MAX (2^63-1 gibt es als JavaScript-Zahl nicht).
export function intval(v: unknown): number {
  if (v === null || v === undefined || v === false) return 0;
  if (v === true) return 1;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 0;
    const t = Math.trunc(v) || 0;
    return Math.abs(t) < 2 ** 63 || t === 2 ** 63 ? t : Number(BigInt.asIntN(64, BigInt(t)));
  }
  if (Array.isArray(v)) return v.length ? 1 : 0;
  // JSON-Objekte sind in PHP Arrays: leer → 0
  if (typeof v === 'object') return Object.keys(v as object).length ? 1 : 0;
  const s = String(v).replace(/^[ \t\n\v\f\r]+/, '');
  const m = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(s);
  if (!m) return 0;
  const n = Number(m[0]);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-(2 ** 63), Math.min(2 ** 63, Math.trunc(n) || 0));
}

export const ctypeDigit = (s: unknown): boolean => typeof s === 'string' && /^[0-9]+$/.test(s);
export const isNumeric = (s: unknown): boolean =>
  typeof s === 'number' ? Number.isFinite(s) : typeof s === 'string' && /^[ \t\n\r\v\f]*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?[ \t\n\r\v\f]*$/.test(s);

// ---------------------------------------------------------------- Text

const TRIM = ' \t\n\r\0\x0B';
export function phpTrim(s: string, chars = TRIM): string {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}
export function phpRtrim(s: string, chars = TRIM): string {
  let b = s.length;
  while (b > 0 && chars.includes(s[b - 1])) b--;
  return s.slice(0, b);
}
export function phpLtrim(s: string, chars = TRIM): string {
  let a = 0;
  while (a < s.length && chars.includes(s[a])) a++;
  return s.slice(a);
}

// mb_* zählen Unicode-Zeichen (Codepoints), nicht UTF-16-Einheiten
export const mbStrlen = (s: string): number => Array.from(s).length;
export function mbSubstr(s: string, start: number, len?: number): string {
  const a = Array.from(s);
  const st = start < 0 ? Math.max(0, a.length + start) : start;
  if (len === undefined || len === null) return a.slice(st).join('');
  const en = len < 0 ? a.length + len : st + len;
  return a.slice(st, Math.max(st, en)).join('');
}
// strlen(): Bytes
export const strlen = (s: string): number => Buffer.byteLength(s, 'utf8');

// strtolower/strtoupper/ucfirst arbeiten in PHP 8.2+ nur auf ASCII
export const strtolower = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
export const strtoupper = (s: string): string => s.replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 32));
export const ucfirst = (s: string): string => (s === '' ? s : strtoupper(s[0]) + s.slice(1));

// rawurlencode (RFC 3986) und urlencode (Leerzeichen als +)
export const rawurlencode = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
// rawurldecode(): %XX → Byte, „+“ bleibt. Ungültige Folgen bleiben stehen; Bytes werden als UTF-8 gelesen.
// Gearbeitet wird auf den UTF-8-Bytes (Zeichen außerhalb der BMP wie 😀 bestehen aus zwei JavaScript-Einheiten).
const isHexByte = (b: number): boolean => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);
export function rawurldecode(s: string): string {
  if (!s.includes('%')) return s;
  const src = Buffer.from(s, 'utf8');
  const out = Buffer.alloc(src.length);
  let n = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === 0x25 && i + 2 < src.length && isHexByte(src[i + 1]) && isHexByte(src[i + 2])) {
      out[n++] = parseInt(src.toString('latin1', i + 1, i + 3), 16);
      i += 2;
    } else {
      out[n++] = src[i];
    }
  }
  return out.toString('utf8', 0, n);
}
export const urlencode = (s: string): string => rawurlencode(s).replace(/%20/g, '+').replace(/~/g, '%7E');

export const nl2br = (s: string): string => s.replace(/\r\n|\n\r|\n|\r/g, (m) => '<br />' + m);

// number_format($n, $decimals, $dec, $thousands) – rundet „half up“ wie PHP
export function numberFormat(n: number, decimals = 0, dec = '.', thousands = ','): string {
  const factor = 10 ** decimals;
  const rounded = Math.round(Math.abs(n) * factor + Number.EPSILON) / factor;
  const [int, frac = ''] = rounded.toFixed(decimals).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, thousands);
  const sign = n < 0 && rounded !== 0 ? '-' : '';
  return sign + grouped + (decimals > 0 ? dec + frac : '');
}

// ---------------------------------------------------------------- Formular- und Adress-Daten (parse_str)

export type PhpValue = string | PhpArray;
export interface PhpArray { [key: string]: PhpValue }

// max_input_vars (Vorgabe von PHP)
const MAX_INPUT_VARS = 1000;

// parse_str()/$_GET/$_POST: der letzte gleichnamige Wert gewinnt, name[] und name[x] werden Arrays,
// Punkte und Leerzeichen im Namen werden zu _, ein offenes [ wird zu _ (Namensregeln: setPhpVar).
// Wie PHP höchstens max_input_vars Variablen: parse_str() und $_GET nehmen die ersten 1000 Stücke (leere zwischen &&
// zählen nicht), ein Formular-Text für $_POST (post = true) die ersten 1001 Stücke, leere mitgezählt.
export function parseStr(input: string, post = false): PhpArray {
  const out: PhpArray = {};
  if (!input) return out;
  let count = 0;
  // Stück für Stück lesen (kein split: ein großer Text würde sonst ganz zerlegt, obwohl nach 1000 Schluss ist)
  for (let start = 0, end = 0; end < input.length; start = end + 1) {
    end = input.indexOf('&', start);
    if (end < 0) end = input.length;
    const pair = input.slice(start, end);
    if (post && ++count > MAX_INPUT_VARS + 1) break;
    if (pair === '') continue;
    if (!post && ++count > MAX_INPUT_VARS) break;
    const eq = pair.indexOf('=');
    const rawKey = eq >= 0 ? pair.slice(0, eq) : pair;
    const rawVal = eq >= 0 ? pair.slice(eq + 1) : '';
    const key = decodeForm(rawKey);
    const val = decodeForm(rawVal);
    setPhpVar(out, key, val);
  }
  return out;
}

// urldecode(): + wird Leerzeichen, %XX ein Byte, ungültige %-Folgen bleiben stehen (auch neben gültigem UTF-8)
const decodeForm = (s: string): string => rawurldecode(s.replace(/\+/g, ' '));

// max_input_nesting_level (Vorgabe von PHP)
const MAX_INPUT_NESTING = 64;

// Einen Feldnamen mit PHP-Regeln einsetzen (auch für multipart-Felder), wie php_register_variable_ex():
// Name bis zum ersten Nullbyte, führende Leerzeichen weg, vor der ersten [ werden Leerzeichen und Punkte zu _
// (leerer Name → verworfen). [] und [ ] (genau ein Leerraum-Zeichen) hängen an. Eine offene [ auf der ersten Ebene
// wird Teil des Namens (danach werden auch Leerzeichen, Punkte und [ zu _), tiefer fällt der Rest weg.
// Mehr als 64 Ebenen löschen die ganze Variable.
export function setPhpVar(target: PhpArray, name: string, value: PhpValue): void {
  const key = name.split('\0')[0].replace(/^ +/, '');
  const open = key.indexOf('[');
  const base = (open >= 0 ? key.slice(0, open) : key).replace(/[. ]/g, '_');
  if (base === '') return;
  if (open < 0) {
    putVar(target, base, value);
    return;
  }
  // Schlüssel der Ebenen; null = anhängen
  const path: Array<string | null> = [];
  let i = open;
  for (;;) {
    if (path.length >= MAX_INPUT_NESTING) {
      if (Object.hasOwn(target, base)) delete target[base];
      return;
    }
    let j = i + 1;
    if (/^[ \t\n\v\f\r]$/.test(key[j] ?? '')) j++;
    if (key[j] === ']') {
      path.push(null);
      i = j;
    } else {
      const close = key.indexOf(']', j);
      if (close < 0) {
        if (path.length) break;
        putVar(target, base + '_' + key.slice(i + 1).replace(/[. []/g, '_'), value);
        return;
      }
      path.push(key.slice(i + 1, close));
      i = close;
    }
    if (key[i + 1] !== '[') break;
    i++;
  }
  if (!isOwnArray(target, base)) putVar(target, base, {});
  let cur = target[base] as PhpArray;
  for (let k = 0; k < path.length; k++) {
    const sub = path[k] ?? nextIndex(cur);
    // Kein freier Index mehr (PHP_INT_MAX belegt): der Wert fällt wie in PHP weg
    if (sub === null) return;
    if (k === path.length - 1) {
      putVar(cur, sub, value);
    } else {
      if (!isOwnArray(cur, sub)) putVar(cur, sub, {});
      cur = cur[sub] as PhpArray;
    }
  }
}

// Nur eigene Einträge lesen und schreiben: Namen wie "__proto__[x]" dürfen nie Object.prototype verändern
const isOwnArray = (o: PhpArray, k: string): boolean => Object.hasOwn(o, k) && typeof o[k] === 'object';
function putVar(o: PhpArray, k: string, v: PhpValue): void {
  Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });
  const next = nextFree.get(o);
  const n = next === undefined ? null : intKey(k);
  if (n !== null && n >= next!) nextFree.set(o, n < INT_MAX ? n + 1n : INT_MAX);
}

// Ganzzahliger Array-Schlüssel wie in PHP ("05", "-0" und Zahlen außerhalb von 64 Bit bleiben Text)
const INT_MAX = 2n ** 63n - 1n;
const INT_MIN = -INT_MAX - 1n;
function intKey(k: string): bigint | null {
  if (k.length > 20 || !/^(?:0|-?[1-9][0-9]*)$/.test(k)) return null;
  const n = BigInt(k);
  return n <= INT_MAX && n >= INT_MIN ? n : null;
}

// Nächster freier Index je Array wie nNextFreeElement in PHP 8.3 (INT_MIN = noch kein ganzzahliger Schlüssel).
// Einmal aus den Schlüsseln bestimmt und danach bei jedem Eintrag nachgeführt – viele name[]=… bleiben so linear.
const nextFree = new WeakMap<PhpArray, bigint>();

// Index für name[]: größter ganzzahliger Schlüssel + 1 (auch negativ), sonst 0; null = PHP_INT_MAX ist belegt
function nextIndex(arr: PhpArray): string | null {
  let next = nextFree.get(arr);
  if (next === undefined) {
    next = INT_MIN;
    for (const k of Object.keys(arr)) {
      const n = intKey(k);
      if (n !== null && n >= next) next = n < INT_MAX ? n + 1n : INT_MAX;
    }
    nextFree.set(arr, next);
  }
  const index = String(next === INT_MIN ? 0n : next);
  return Object.hasOwn(arr, index) ? null : index;
}

// Wert aus $_GET/$_POST als Text, wie (string) ($_POST['x'] ?? '')
export function field(src: PhpArray, name: string, fallback = ''): string {
  const v = src[name];
  if (v === undefined) return fallback;
  return typeof v === 'string' ? v : 'Array';
}

// ---------------------------------------------------------------- Zeit (in der Zeitzone der Seite)

interface WallTime { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number }

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    dtfCache.set(tz, f);
  }
  return f;
}
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function wallTime(unix: number, tz = timeZone()): WallTime {
  const p: Record<string, string> = {};
  for (const x of dtf(tz).formatToParts(new Date(unix * 1000))) p[x.type] = x.value;
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second), weekday: WEEKDAYS.indexOf(p.weekday),
  };
}

// Abstand zu UTC in Sekunden zu diesem Zeitpunkt
export function offsetAt(unix: number, tz = timeZone()): number {
  const w = wallTime(unix, tz);
  return (Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(unix) * 1000) / 1000;
}

// Ortszeit → Unix-Sekunden (wie mktime/strtotime in der Zeitzone; Überläufe wie in PHP erlaubt)
export function wallToUnix(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, tz = timeZone()): number {
  const naive = Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
  const o1 = offsetAt(naive, tz);
  const o2 = offsetAt(naive - o1, tz);
  return naive - (o1 === o2 ? o1 : o2);
}

export const time = (): number => Math.floor(Date.now() / 1000);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n: number, l = 2) => String(n).padStart(l, '0');

// date($format, $timestamp) in der Zeitzone der Seite; gmdate() mit tz = 'UTC'
export function date(format: string, unix: number = time(), tz = timeZone()): string {
  const w = wallTime(unix, tz);
  const off = offsetAt(unix, tz);
  let out = '';
  for (let i = 0; i < format.length; i++) {
    const c = format[i];
    if (c === '\\') {
      i++;
      if (i < format.length) out += format[i];
      continue;
    }
    switch (c) {
      case 'd': out += pad(w.day); break;
      case 'D': out += DAYS[w.weekday].slice(0, 3); break;
      case 'j': out += String(w.day); break;
      case 'l': out += DAYS[w.weekday]; break;
      case 'N': out += String(w.weekday === 0 ? 7 : w.weekday); break;
      case 'S': out += ordinalSuffix(w.day); break;
      case 'w': out += String(w.weekday); break;
      case 'z': out += String(dayOfYear(w.year, w.month, w.day)); break;
      case 'W': out += pad(isoWeek(w.year, w.month, w.day).week); break;
      case 'F': out += MONTHS[w.month - 1]; break;
      case 'm': out += pad(w.month); break;
      case 'M': out += MONTHS[w.month - 1].slice(0, 3); break;
      case 'n': out += String(w.month); break;
      case 't': out += String(daysInMonth(w.year, w.month)); break;
      case 'L': out += isLeap(w.year) ? '1' : '0'; break;
      case 'o': out += String(isoWeek(w.year, w.month, w.day).year); break;
      case 'Y': out += String(w.year); break;
      case 'y': out += pad(w.year % 100); break;
      case 'a': out += w.hour < 12 ? 'am' : 'pm'; break;
      case 'A': out += w.hour < 12 ? 'AM' : 'PM'; break;
      case 'g': out += String(w.hour % 12 || 12); break;
      case 'G': out += String(w.hour); break;
      case 'h': out += pad(w.hour % 12 || 12); break;
      case 'H': out += pad(w.hour); break;
      case 'i': out += pad(w.minute); break;
      case 's': out += pad(w.second); break;
      case 'u': out += '000000'; break;
      case 'v': out += '000'; break;
      case 'e': out += tz; break;
      case 'I': out += off !== offsetAt(wallToUnix(w.year, 1, 1, 12, 0, 0, tz), tz) ? '1' : '0'; break;
      case 'O': out += offsetString(off, false); break;
      case 'P': out += offsetString(off, true); break;
      case 'p': out += off === 0 ? 'Z' : offsetString(off, true); break;
      case 'T': out += tz === 'UTC' ? 'UTC' : offsetString(off, true); break;
      case 'Z': out += String(off); break;
      case 'c': out += date('Y-m-d\\TH:i:sP', unix, tz); break;
      case 'r': out += date('D, d M Y H:i:s O', unix, tz); break;
      case 'U': out += String(Math.floor(unix)); break;
      default: out += c;
    }
  }
  return out;
}
export const gmdate = (format: string, unix: number = time()): string => date(format, unix, 'UTC');

function offsetString(off: number, colon: boolean): string {
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return sign + pad(Math.floor(a / 3600)) + (colon ? ':' : '') + pad(Math.floor((a % 3600) / 60));
}
function ordinalSuffix(d: number): string {
  if (d % 100 >= 11 && d % 100 <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][d % 10] || 'th';
}
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dayOfYear = (y: number, m: number, d: number) => (Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000;
function isoWeek(y: number, m: number, d: number): { year: number; week: number } {
  const date0 = new Date(Date.UTC(y, m - 1, d));
  const day = date0.getUTCDay() || 7;
  date0.setUTCDate(date0.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(date0.getUTCFullYear(), 0, 1);
  return { year: date0.getUTCFullYear(), week: Math.ceil(((date0.getTime() - yearStart) / 86400000 + 1) / 7) };
}

// strtotime() für die Formen, die die Seite nutzt: Datum/Zeit aus der Datenbank, ISO 8601, now/today/yesterday/
// tomorrow und relative Angaben wie '+1 year', '-6 days' (auch hinter einem Datum). Unbekanntes → false
export function strtotime(input: string, now: number = time(), tz = timeZone()): number | false {
  let s = phpTrim(String(input)).toLowerCase();
  if (s === '') return false;
  const base = wallTime(now, tz);
  let y = base.year, mo = base.month, d = base.day, h = base.hour, mi = base.minute, sec = base.second;
  let utcOffset: number | null = null;
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})(?:[ t](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(z|[+-]\d{2}:?\d{2})?/.exec(s))) {
    y = +m[1]; mo = +m[2]; d = +m[3];
    h = m[4] !== undefined ? +m[4] : 0; mi = m[5] !== undefined ? +m[5] : 0; sec = m[6] !== undefined ? +m[6] : 0;
    if (m[7]) utcOffset = m[7] === 'z' ? 0 : (m[7][0] === '-' ? -1 : 1) * (parseInt(m[7].slice(1, 3), 10) * 3600 + parseInt(m[7].slice(-2), 10) * 60);
    s = s.slice(m[0].length).trim();
  } else if (/^(now|today|midnight|yesterday|tomorrow)\b/.test(s)) {
    const word = /^(\w+)/.exec(s)![1];
    if (word !== 'now') { h = 0; mi = 0; sec = 0; }
    if (word === 'yesterday') d -= 1;
    if (word === 'tomorrow') d += 1;
    s = s.slice(word.length).trim();
  } else if (/^@-?\d+$/.test(s)) {
    return Number(s.slice(1));
  }
  // Relative Teile: '+1 year', '-6 days', '+9 days 2 hours'
  const rel = /^([+-]?\s*\d+)\s*(sec|second|min|minute|hour|day|week|fortnight|month|year)s?\b\s*/;
  while (s !== '' && (m = rel.exec(s))) {
    const n = parseInt(m[1].replace(/\s+/g, ''), 10);
    switch (m[2]) {
      case 'sec': case 'second': sec += n; break;
      case 'min': case 'minute': mi += n; break;
      case 'hour': h += n; break;
      case 'day': d += n; break;
      case 'week': d += 7 * n; break;
      case 'fortnight': d += 14 * n; break;
      case 'month': mo += n; break;
      case 'year': y += n; break;
    }
    s = s.slice(m[0].length);
  }
  if (s !== '') return false;
  if (utcOffset !== null) return Date.UTC(y, mo - 1, d, h, mi, sec) / 1000 - utcOffset;
  return wallToUnix(y, mo, d, h, mi, sec, tz);
}
