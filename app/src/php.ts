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
export function intval(v: unknown): number {
  if (v === null || v === undefined || v === false) return 0;
  if (v === true) return 1;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : 0;
  if (Array.isArray(v)) return v.length ? 1 : 0;
  if (typeof v === 'object') return 1;
  const s = String(v).replace(/^[ \t\n\v\f\r]+/, '');
  const m = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(s);
  if (!m) return 0;
  const n = Number(m[0]);
  if (!Number.isFinite(n)) return n > 0 ? Number.MAX_SAFE_INTEGER : Number.MIN_SAFE_INTEGER;
  return Math.trunc(n);
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

// parse_str()/$_GET/$_POST: der letzte gleichnamige Wert gewinnt, name[] und name[x] werden Arrays,
// Punkte und Leerzeichen im Namen werden zu _, ein offenes [ wird zu _
export function parseStr(input: string): PhpArray {
  const out: PhpArray = {};
  if (!input) return out;
  for (const pair of input.split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const rawKey = eq >= 0 ? pair.slice(0, eq) : pair;
    const rawVal = eq >= 0 ? pair.slice(eq + 1) : '';
    const key = decodeForm(rawKey);
    const val = decodeForm(rawVal);
    setPhpVar(out, key, val);
  }
  return out;
}

function decodeForm(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    // PHP dekodiert ungültige %-Folgen einzeln; Ersatz: nur gültige Teile dekodieren
    return s.replace(/\+/g, ' ').replace(/%([0-9a-fA-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
  }
}

// Einen Feldnamen mit PHP-Regeln einsetzen (auch für multipart-Felder)
export function setPhpVar(target: PhpArray, name: string, value: PhpValue): void {
  let key = name.replace(/^ +/, '');
  if (key === '') return;
  const bracket = key.indexOf('[');
  let base = bracket >= 0 ? key.slice(0, bracket) : key;
  let rest = bracket >= 0 ? key.slice(bracket) : '';
  // Unvollständige Klammer: wird Teil des Namens (mit _)
  if (rest !== '' && !/^(\[[^\]]*\])+/.test(rest)) {
    base = key.replace(/\[/, '_');
    rest = '';
  }
  base = base.replace(/[. ]/g, '_');
  if (base === '') return;
  const subs: string[] = [];
  if (rest !== '') {
    const re = /\[([^\]]*)\]/y;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rest)) !== null) subs.push(m[1]);
  }
  if (!subs.length) {
    target[base] = value;
    return;
  }
  let cur: PhpArray;
  if (typeof target[base] !== 'object') target[base] = {};
  cur = target[base] as PhpArray;
  for (let i = 0; i < subs.length; i++) {
    let k = subs[i];
    if (k === '') k = String(nextIndex(cur));
    if (i === subs.length - 1) {
      cur[k] = value;
    } else {
      if (typeof cur[k] !== 'object') cur[k] = {};
      cur = cur[k] as PhpArray;
    }
  }
}

function nextIndex(arr: PhpArray): number {
  let max = -1;
  for (const k of Object.keys(arr)) if (/^(0|[1-9]\d*)$/.test(k)) max = Math.max(max, Number(k));
  return max + 1;
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
