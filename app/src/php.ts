// Kleine Nachbauten von PHP-Funktionen, deren Verhalten die Ausgabe der Seite bestimmt. JavaScript macht vieles
// anders (Wahrheitswerte, trim, Groß-/Kleinschreibung, Datumsformate, Formular-Felder) – hier steht es einmal richtig.
import { isUtf8 } from 'node:buffer';
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

// (string) $float wie PHP mit precision = 14 (zend_gcvt): aus den exakten Ziffern der Zahl gerechnet, nicht mit
// toPrecision() – PHP schreibt schon ab 1e-5 mit Exponent (1.0E-5, toPrecision erst unter 1e-6) und rundet bei genau
// der Hälfte an der 14. Stelle zur geraden Ziffer (toPrecision immer auf). -0 bleibt "-0", unendlich "INF"/"-INF".
// Die einzige Fassung: community/json.ts, content/phpValues.ts und compat/core.js nutzen sie.
export function phpFloatToString(f: number): string {
  if (Number.isNaN(f)) return 'NAN';
  if (!Number.isFinite(f)) return f > 0 ? 'INF' : '-INF';
  if (f === 0) return Object.is(f, -0) ? '-0' : '0';
  const exact = exactDigits(f);
  // Ganze Zahlen von 1e14 bis unter 1e15 mit genau der Hälfte an der 15. Stelle rechnet zend_dtoa auf einem eigenen
  // Weg, der die Nullen am Ende stehen lässt: 100000000000005 → 1.0000000000000E+14
  const keepZeros = Number.isInteger(f) && Math.abs(f) >= 1e14 && Math.abs(f) < 1e15;
  const r = roundDigits(exact.digits, exact.decpt, 14, keepZeros);
  return (f < 0 ? '-' : '') + phpGcvt(r.digits, r.decpt, 14, 'E');
}

// Exakte Dezimalziffern einer Kommazahl (ohne Vorzeichen und ohne Nullen am Ende) und die Lage des Kommas wie decpt
// in zend_dtoa (0.d1d2… × 10^decpt)
function exactDigits(f: number): { digits: string; decpt: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(f));
  const bits = view.getBigUint64(0);
  const expBits = Number((bits >> 52n) & 0x7ffn);
  let mant = bits & ((1n << 52n) - 1n);
  let exp: number;
  if (expBits === 0) {
    exp = -1074;
  } else {
    mant |= 1n << 52n;
    exp = expBits - 1075;
  }
  let digits: string;
  let decpt: number;
  if (exp >= 0) {
    digits = (mant << BigInt(exp)).toString();
    decpt = digits.length;
  } else {
    // mant / 2^-exp = mant * 5^-exp / 10^-exp
    digits = (mant * 5n ** BigInt(-exp)).toString();
    decpt = digits.length + exp;
  }
  return { digits: digits.replace(/0+$/, ''), decpt };
}

// Auf n gültige Stellen runden – bei genau der Hälfte zur geraden Ziffer (zend_dtoa, Modus 2)
function roundDigits(digits: string, decpt: number, n: number, keepZerosOnTie = false): { digits: string; decpt: number } {
  if (digits.length <= n) return { digits, decpt };
  const head = digits.slice(0, n);
  const rest = digits.slice(n);
  const first = rest.charCodeAt(0) - 48;
  // Ohne Nullen am Ende heißt "5" genau die Hälfte
  const tie = rest === '5';
  const up = first > 5 || (first === 5 && !tie) || (tie && (head.charCodeAt(n - 1) - 48) % 2 === 1);
  if (!up) return { digits: tie && keepZerosOnTie ? head : head.replace(/0+$/, ''), decpt };
  let carried = (BigInt(head) + 1n).toString();
  let newDecpt = decpt;
  if (carried.length > head.length) {
    newDecpt++;
    carried = carried.slice(0, n);
  }
  return { digits: carried.replace(/0+$/, ''), decpt: newDecpt };
}

// php_gcvt(): Ziffern (ohne Nullen am Ende) als feste Schreibweise oder mit Exponent (1.0E+25, 1.0E-5) – je nach Lage
// des Kommas und der Zahl der Stellen. Auch für json_encode() (17 Stellen, 'e') in community/json.ts
export function phpGcvt(digits: string, decpt: number, precision: number, expChar: string): string {
  if (decpt < 0 ? decpt < -3 : decpt > precision) {
    const e = decpt - 1;
    return digits[0] + '.' + (digits.length > 1 ? digits.slice(1) : '0') + expChar + (e < 0 ? '-' : '+') + String(Math.abs(e));
  }
  if (decpt <= 0) return '0.' + '0'.repeat(-decpt) + digits;
  const int = digits.length >= decpt ? digits.slice(0, decpt) : digits + '0'.repeat(decpt - digits.length);
  const frac = digits.slice(decpt);
  return frac === '' ? int : int + '.' + frac;
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

// mb_* zählen Unicode-Zeichen (Codepoints), nicht UTF-16-Einheiten. Rohe Bytes (siehe phpText) zählen wie in PHP:
// jede ungültige Folge ist ein Zeichen und wird in mb_substr() zu "?". Gezählt wird, ohne die Zeichen einzeln
// anzulegen (Array.from() über ein Feld von 20 MB kostete eine Sekunde und 400 MB); mb_substr() geht nur bis zum Ende
// des Stücks – die ganze Länge braucht es nur bei negativen Werten.
export function mbStrlen(s: string): number {
  return hasRawBytes(s) ? mbCountRaw(s) : cpCount(s);
}
export function mbSubstr(s: string, start: number, len?: number): string {
  if (hasRawBytes(s)) return mbSubstrRaw(s, start, len);
  const [from, to] = substrRange(start, len, () => cpCount(s));
  if (!(to > from)) return '';
  const a = cpOffset(s, 0, from);
  return s.slice(a, to === Infinity ? s.length : cpOffset(s, a, to - from));
}

// Anfang und Ende des Stücks in Zeichen, gerechnet wie früher mit der Liste der Zeichen a: a.slice(st) bzw.
// a.slice(st, Math.max(st, en)) – also auch mit NaN, unendlich und Kommazahlen wie Array.prototype.slice()
// (abgeschnitten, NaN = 0). Beide Werte sind nie negativ; über das Ende hinaus zählt das Ende. n(): Zahl der Zeichen.
function substrRange(start: number, len: number | undefined | null, n: () => number): [number, number] {
  const st = start < 0 ? Math.max(0, n() + start) : start;
  if (len === undefined || len === null) return [sliceIndex(st), Infinity];
  const en = len < 0 ? n() + len : st + len;
  return [sliceIndex(st), sliceIndex(Math.max(st, en))];
}
const sliceIndex = (x: number): number => Math.trunc(x) || 0;

// Codepoints ohne rohe Bytes: ein Paar aus hohem und tiefem Surrogat ist ein Zeichen, ein einzelnes Surrogat auch eins
const SURROGATE = /[\uD800-\uDFFF]/;
function cpCount(s: string): number {
  if (!SURROGATE.test(s)) return s.length;
  let n = s.length;
  for (let i = 0; i < s.length - 1; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n--;
        i++;
      }
    }
  }
  return n;
}
// Stelle (UTF-16) nach k weiteren Zeichen ab i, höchstens das Ende
function cpOffset(s: string, i: number, k: number): number {
  for (; k > 0 && i < s.length; k--) {
    const c = s.charCodeAt(i++);
    if (c >= 0xd800 && c <= 0xdbff && i < s.length) {
      const d = s.charCodeAt(i);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
  }
  return i;
}
// strlen(): Bytes (rohe Bytes zählen einzeln)
export const strlen = (s: string): number => (hasRawBytes(s) ? phpBytes(s).length : Buffer.byteLength(s, 'utf8'));

// strtolower/strtoupper/ucfirst arbeiten in PHP 8.2+ nur auf ASCII. Ein Durchgang statt replace() je Buchstabe
// (Anmeldung und Registrierung schreiben die E-Mail-Adresse aus dem Formular klein: 20 MB brauchten Sekunden)
const HAS_UPPER = /[A-Z]/;
const HAS_LOWER = /[a-z]/;
export const strtolower = (s: string): string => shiftAscii(s, HAS_UPPER, 0x41, 0x5a, 32);
export const strtoupper = (s: string): string => shiftAscii(s, HAS_LOWER, 0x61, 0x7a, -32);
export const ucfirst = (s: string): string => (s === '' ? s : strtoupper(s[0]) + s.slice(1));
// Die Zeichen lo bis hi um delta verschieben; ohne Treffer bleibt der Text, wie er ist. Als latin1 (ein Byte je
// Zeichen), wenn kein Zeichen über U+00FF vorkommt, sonst in UTF-16-Einheiten
function shiftAscii(s: string, has: RegExp, lo: number, hi: number, delta: number): string {
  if (!has.test(s)) return s;
  if (!NON_LATIN1.test(s)) {
    const b = Buffer.from(s, 'latin1');
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      if (c >= lo && c <= hi) b[i] = c + delta;
    }
    return b.toString('latin1');
  }
  const u = new Uint16Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    u[i] = c >= lo && c <= hi ? c + delta : c;
  }
  return unitsText(u, s.length);
}

// rawurlencode (RFC 3986) und urlencode (Leerzeichen als +). Mit rohen Bytes (phpText) oder einzelnen Surrogaten
// würde encodeURIComponent() werfen – dann Byte für Byte wie PHP (%FF)
export function rawurlencode(s: string): string {
  if (!/[\uD800-\uDFFF]/.test(s)) return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  let out = '';
  for (const b of phpBytes(s)) {
    const plain = (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x2d || b === 0x2e || b === 0x5f || b === 0x7e;
    out += plain ? String.fromCharCode(b) : '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}
// rawurldecode(): %XX → Byte, „+“ bleibt. Ungültige Folgen bleiben stehen; Bytes werden als UTF-8 gelesen.
// Gearbeitet wird auf den UTF-8-Bytes (Zeichen außerhalb der BMP wie 😀 bestehen aus zwei JavaScript-Einheiten).
export function rawurldecode(s: string): string {
  if (!s.includes('%')) return s;
  const src = Buffer.from(s, 'utf8');
  const out = Buffer.allocUnsafe(src.length);
  return out.toString('utf8', 0, percentDecode(src, out, false));
}

// Wert einer Hex-Ziffer (Byte), sonst -1
const HEX = new Int8Array(256).fill(-1);
for (let i = 0; i < 10; i++) HEX[0x30 + i] = i;
for (let i = 0; i < 6; i++) HEX[0x41 + i] = HEX[0x61 + i] = 10 + i;

// %XX (zwei Hex-Ziffern) → ein Byte, jedes andere Byte bleibt (plus: „+“ wird Leerzeichen). Ein Durchgang mit einer
// Tabelle für die Hex-Ziffern (früher parseInt() je %XX: 20 MB „%41“ brauchten Sekunden). Schreibt nach out (so lang
// wie src) und gibt die Länge zurück.
function percentDecode(src: Uint8Array, out: Uint8Array, plus: boolean): number {
  let n = 0;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const c = src[i];
    if (c === 0x25 && i + 2 < len) {
      const hi = HEX[src[i + 1]];
      const lo = HEX[src[i + 2]];
      if ((hi | lo) >= 0) {
        out[n++] = (hi << 4) | lo;
        i += 2;
        continue;
      }
    }
    out[n++] = plus && c === 0x2b ? 0x20 : c;
  }
  return n;
}

// Einzelne ASCII-Zeichen durch ein anderes ersetzen, ohne replace() mit /g (das kostet je Treffer: ein Feldname aus
// 20 MB Punkten brauchte 5 s, ein Wert aus 20 MB „+“ 4 s). Ob es überhaupt einen Treffer gibt, sucht ein Ausdruck
// ohne /g; dann ein Durchgang – als latin1 (ein Byte je Zeichen), wenn kein Zeichen über U+00FF vorkommt, sonst in
// UTF-16-Einheiten. Ohne Treffer bleibt der Text, wie er ist.
interface AsciiSwap { find: RegExp; set: Uint8Array; by: number }
function asciiSwap(chars: string, by: string): AsciiSwap {
  const set = new Uint8Array(128);
  let cls = '';
  for (let i = 0; i < chars.length; i++) {
    set[chars.charCodeAt(i)] = 1;
    cls += '\\x' + chars.charCodeAt(i).toString(16).padStart(2, '0');
  }
  return { find: new RegExp('[' + cls + ']'), set, by: by.charCodeAt(0) };
}
const NON_LATIN1 = /[^\x00-\xff]/;
function replaceAscii(s: string, swap: AsciiSwap): string {
  if (!swap.find.test(s)) return s;
  const { set, by } = swap;
  if (!NON_LATIN1.test(s)) {
    const b = Buffer.from(s, 'latin1');
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      if (c < 128 && set[c] === 1) b[i] = by;
    }
    return b.toString('latin1');
  }
  const u = new Uint16Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    u[i] = c < 128 && set[c] === 1 ? by : c;
  }
  return unitsText(u, s.length);
}

// Die ersten n UTF-16-Einheiten → Text in einem Schritt ('utf16le' liest das niedrige Byte zuerst; Uint16Array
// schreibt in der Byte-Reihenfolge des Rechners). Auch für compat/core.js.
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
export function unitsText(u: Uint16Array, n: number): string {
  const b = Buffer.from(u.buffer, u.byteOffset, n * 2);
  if (!LITTLE_ENDIAN) b.swap16();
  return b.toString('utf16le');
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

// ---------------------------------------------------------------- Rohe Bytes (ungültiges UTF-8 in Formularen)

// PHP-Texte sind Bytes: Formularwerte mit ungültigem UTF-8 behält PHP unverändert – strlen() zählt die rohen Bytes,
// preg_* mit /u (oys_clean_text, oys_clean_url) liefert dann '' und password_hash() rechnet mit genau diesen Bytes.
// Node las sie früher als U+FFFD. Jetzt wird jedes Byte, das nicht zu gültigem UTF-8 gehört, als eigenes Zeichen
// U+DC80–U+DCFF gehalten: eine allein stehende Hälfte eines Surrogatpaars, die aus gültigem UTF-8 nie entsteht.
// Verlustfrei (phpBytes() ergibt wieder genau die Bytes der Anfrage); gültige Texte bleiben genau wie bisher.
const RAW_BYTE = /(?<![\uD800-\uDBFF])[\uDC80-\uDCFF]/;
export const hasRawBytes = (s: string): boolean => RAW_BYTE.test(s);

// Bytes → Text: gültiges UTF-8 wie Buffer.toString(), jedes andere Byte als U+DC80–U+DCFF. Ein Durchgang, der die
// UTF-16-Einheiten selbst schreibt (früher ein angehängtes Stück je rohem Byte: 20 MB ungültiges UTF-8 brauchten 29 s)
export function phpText(b: Buffer): string {
  if (isUtf8(b)) return b.toString('utf8');
  // Höchstens eine Einheit je Byte
  const u = new Uint16Array(b.length);
  let n = 0;
  let i = 0;
  while (i < b.length) {
    const c = b[i];
    if (c < 0x80) {
      u[n++] = c;
      i++;
      continue;
    }
    // 80–C1 und F5–FF beginnen nie eine Folge, ebenso ein Anfang, dessen erstes Folgebyte nicht passt
    let len = 0;
    if (c >= 0xc2 && c <= 0xf4) {
      const t = i + 1 < b.length ? b[i + 1] : 0;
      if (t >= (c === 0xe0 ? 0xa0 : c === 0xf0 ? 0x90 : 0x80) && t <= (c === 0xed ? 0x9f : c === 0xf4 ? 0x8f : 0xbf)) len = utf8SeqLength(b, i);
    }
    if (len === 0) {
      u[n++] = 0xdc00 + c;
      i++;
    } else if (len === 2) {
      u[n++] = ((c & 0x1f) << 6) | (b[i + 1] & 0x3f);
      i += 2;
    } else if (len === 3) {
      u[n++] = ((c & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f);
      i += 3;
    } else {
      // Außerhalb der BMP: Surrogatpaar
      const cp = (((c & 0x07) << 18) | ((b[i + 1] & 0x3f) << 12) | ((b[i + 2] & 0x3f) << 6) | (b[i + 3] & 0x3f)) - 0x10000;
      u[n++] = 0xd800 + (cp >> 10);
      u[n++] = 0xdc00 + (cp & 0x3ff);
      i += 4;
    }
  }
  return unitsText(u, n);
}

// Text → Bytes (Gegenstück zu phpText): U+DC80–U+DCFF wieder als einzelne Bytes, alles andere UTF-8 wie
// Buffer.from() (ein einzelnes Surrogat wird EF BF BD). Ein Durchgang ohne Teilstücke (früher ein Buffer je rohem
// Byte: 20 Millionen rohe Bytes sprengten 4 GB Speicher). Ein U+DC80–U+DCFF gehört zu keinem Paar, wenn es beim
// Lesen von links allein ankommt – nach einem hohen Surrogat wäre es mit diesem schon als Paar verbraucht.
export function phpBytes(s: string): Buffer {
  if (!hasRawBytes(s)) return Buffer.from(s, 'utf8');
  // Obergrenze: Buffer.byteLength() zählt ein rohes Byte wie ein einzelnes Surrogat mit drei Bytes
  const out = Buffer.allocUnsafe(Buffer.byteLength(s, 'utf8'));
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) {
      out[n++] = c;
    } else if (c < 0x800) {
      out[n++] = 0xc0 | (c >> 6);
      out[n++] = 0x80 | (c & 0x3f);
    } else if (c >= 0xdc80 && c <= 0xdcff) {
      out[n++] = c - 0xdc00;
    } else {
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        const d = s.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          const cp = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
          out[n++] = 0xf0 | (cp >> 18);
          out[n++] = 0x80 | ((cp >> 12) & 0x3f);
          out[n++] = 0x80 | ((cp >> 6) & 0x3f);
          out[n++] = 0x80 | (cp & 0x3f);
          i++;
          continue;
        }
      }
      if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
      out[n++] = 0xe0 | (c >> 12);
      out[n++] = 0x80 | ((c >> 6) & 0x3f);
      out[n++] = 0x80 | (c & 0x3f);
    }
  }
  return n === out.length ? out : Buffer.from(out.subarray(0, n));
}

// Länge einer gültigen UTF-8-Folge ab Stelle i (Unicode, Tabelle 3-7), 0 = ungültig
function utf8SeqLength(b: Uint8Array, i: number): number {
  const c = b[i];
  if (c < 0x80) return 1;
  if (c < 0xc2 || c > 0xf4) return 0;
  const end = b.length;
  const t1 = i + 1 < end ? b[i + 1] : 0;
  if (c <= 0xdf) return t1 >= 0x80 && t1 <= 0xbf ? 2 : 0;
  // Erstes Folgebyte: nach E0 ab A0, nach ED bis 9F, nach F0 ab 90, nach F4 bis 8F (keine zu langen Formen, keine
  // Surrogate, nichts über U+10FFFF)
  const lo = c === 0xe0 ? 0xa0 : c === 0xf0 ? 0x90 : 0x80;
  const hi = c === 0xed ? 0x9f : c === 0xf4 ? 0x8f : 0xbf;
  if (t1 < lo || t1 > hi) return 0;
  const t2 = i + 2 < end ? b[i + 2] : 0;
  if (t2 < 0x80 || t2 > 0xbf) return 0;
  if (c <= 0xef) return 3;
  const t3 = i + 3 < end ? b[i + 3] : 0;
  return t3 >= 0x80 && t3 <= 0xbf ? 4 : 0;
}

// Länge des ungültigen Stücks ab i: so viele Bytes, wie noch zu einer gültigen Folge passen könnten (mindestens 1)
function maximalSubpart(b: Uint8Array, i: number): number {
  const c = b[i];
  // Folgebytes einer ganzen Folge mit diesem ersten Byte; Bereich des ersten Folgebytes wie in utf8SeqLength()
  const need = c >= 0xc2 && c <= 0xdf ? 1 : c >= 0xe0 && c <= 0xef ? 2 : c >= 0xf0 && c <= 0xf4 ? 3 : 0;
  const lo = c === 0xe0 ? 0xa0 : c === 0xf0 ? 0x90 : 0x80;
  const hi = c === 0xed ? 0x9f : c === 0xf4 ? 0x8f : 0xbf;
  let n = 1;
  for (let k = 1; k <= need && i + k < b.length; k++) {
    const t = b[i + k];
    if (t < (k === 1 ? lo : 0x80) || t > (k === 1 ? hi : 0xbf)) break;
    n++;
  }
  return n;
}

// Ein Zeichen ab i, wie mbstring es in Bytes sieht: eine gültige Folge (Länge > 0) oder ein ungültiges Stück (der
// längste Anfang einer gültigen Folge, sonst ein Byte – wie der UTF-8-Decoder von PHP 8.3; Länge < 0), das als "?"
// zählt. Bytes, mit denen keine Folge beginnen kann (80–C1, F5–FF), und ein Anfang, dessen erstes Folgebyte nicht passt,
// sind gleich ein Stück aus einem Byte.
function mbChar(b: Uint8Array, i: number): number {
  const c = b[i];
  if (c < 0x80) return 1;
  if (c < 0xc2 || c > 0xf4) return -1;
  const t = i + 1 < b.length ? b[i + 1] : 0;
  if (t < (c === 0xe0 ? 0xa0 : c === 0xf0 ? 0x90 : 0x80) || t > (c === 0xed ? 0x9f : c === 0xf4 ? 0x8f : 0xbf)) return -1;
  return utf8SeqLength(b, i) || -maximalSubpart(b, i);
}

// Mit rohen Bytes gezählt und gegangen wird auf den UTF-16-Einheiten, ohne den ganzen Text in Bytes zu wandeln: Ein
// Zeichen aus rohen Bytes kann nur rohe Bytes dahinter einschließen, denn jedes andere Zeichen beginnt in UTF-8 mit
// ASCII oder einem Anfangsbyte, nie mit einem Folgebyte (80–BF). Die übrigen Einheiten sind je ein Zeichen: ein Paar,
// ein einzelnes Surrogat (wird EF BF BD), alles andere. Länge in Einheiten wie mbChar(): > 0 gültig, < 0 ungültig.
function mbUnit(s: string, i: number): number {
  const c = s.charCodeAt(i);
  if (c >= 0xdc80 && c <= 0xdcff) {
    const b = c - 0xdc00;
    const need = b >= 0xc2 && b <= 0xdf ? 1 : b >= 0xe0 && b <= 0xef ? 2 : b >= 0xf0 && b <= 0xf4 ? 3 : 0;
    if (need === 0) return -1;
    const lo = b === 0xe0 ? 0xa0 : b === 0xf0 ? 0x90 : 0x80;
    const hi = b === 0xed ? 0x9f : b === 0xf4 ? 0x8f : 0xbf;
    // Folgebytes: nur rohe Bytes im passenden Bereich (wie utf8SeqLength und maximalSubpart)
    let k = 1;
    for (; k <= need; k++) {
      const u = i + k < s.length ? s.charCodeAt(i + k) : 0;
      const t = u >= 0xdc80 && u <= 0xdcff ? u - 0xdc00 : 0;
      if (t < (k === 1 ? lo : 0x80) || t > (k === 1 ? hi : 0xbf)) break;
    }
    return k > need ? k : -k;
  }
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
    const d = s.charCodeAt(i + 1);
    if (d >= 0xdc00 && d <= 0xdfff) return 2;
  }
  return 1;
}

// Stelle (UTF-16) nach k weiteren Zeichen ab i, höchstens das Ende
function mbOffsetRaw(s: string, i: number, k: number): number {
  for (; k > 0 && i < s.length; k--) {
    const len = mbUnit(s, i);
    i += len < 0 ? -len : len;
  }
  return i;
}
const mbCountRaw = (s: string): number => {
  let n = 0;
  for (let i = 0; i < s.length; n++) {
    const len = mbUnit(s, i);
    i += len < 0 ? -len : len;
  }
  return n;
};

// mb_substr() mit rohen Bytes: Anfang und Ende auf den Einheiten suchen, nur das Stück in Bytes wandeln. An den Grenzen
// eines Zeichens geschnitten, liest es sich für sich gelesen genau wie im ganzen Text.
function mbSubstrRaw(s: string, start: number, len: number | undefined | null): string {
  const [from, to] = substrRange(start, len, () => mbCountRaw(s));
  if (!(to > from)) return '';
  const a = mbOffsetRaw(s, 0, from);
  const b = to === Infinity ? s.length : mbOffsetRaw(s, a, to - from);
  return mbBytesText(phpBytes(s.slice(a, b)));
}

// Bytes als Text, wie mbstring sie liest: gültige Folgen bleiben, jedes ungültige Stück wird "?"
function mbBytesText(b: Buffer): string {
  // Jedes Zeichen hat mindestens ein Byte und wird zu höchstens so vielen
  const out = Buffer.allocUnsafe(b.length);
  let n = 0;
  for (let i = 0; i < b.length;) {
    const len = mbChar(b, i);
    if (len < 0) {
      out[n++] = 0x3f;
      i -= len;
    } else {
      for (const end = i + len; i < end; i++) out[n++] = b[i];
    }
  }
  return out.toString('utf8', 0, n);
}

// htmlspecialchars(…, ENT_SUBSTITUTE) und json_encode(…, JSON_INVALID_UTF8_SUBSTITUTE) lesen UTF-8 mit eigenen Regeln
// (get_next_char() in ext/standard/html.c): jede ungültige Folge wird ein U+FFFD – ein kodiertes Surrogat (ED A0 80)
// oder eine zu lange Form ist dabei ein Fehler für die ganze Folge. Ein Durchgang, der die UTF-16-Einheiten selbst
// schreibt (früher ein angehängtes Zeichen je Byte: Sekunden für ein Feld aus 20 MB rohen Bytes)
const isLead = (c: number | undefined): boolean => c !== undefined && (c < 0x80 || (c >= 0xc2 && c <= 0xf4));
const isTrail = (c: number | undefined): boolean => c !== undefined && c >= 0x80 && c <= 0xbf;
export function phpUtf8Substitute(b: Buffer): string {
  // Höchstens eine Einheit je Byte
  const u = new Uint16Array(b.length);
  let n = 0;
  let i = 0;
  while (i < b.length) {
    const c = b[i];
    const left = b.length - i;
    // bad > 0: so viele Bytes werden ein U+FFFD
    let bad = 0;
    if (c < 0x80) {
      u[n++] = c;
      i++;
      continue;
    } else if (c < 0xc2) {
      bad = 1;
    } else if (c < 0xe0) {
      if (left < 2) bad = 1;
      else if (!isTrail(b[i + 1])) bad = isLead(b[i + 1]) ? 1 : 2;
      else {
        u[n++] = ((c & 0x1f) << 6) | (b[i + 1] & 0x3f);
        i += 2;
        continue;
      }
    } else if (c < 0xf0) {
      if (left < 3 || !isTrail(b[i + 1]) || !isTrail(b[i + 2])) {
        bad = left < 2 || isLead(b[i + 1]) ? 1 : left < 3 || isLead(b[i + 2]) ? 2 : 3;
      } else {
        const cp = ((c & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f);
        if (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff)) bad = 3;
        else {
          u[n++] = cp;
          i += 3;
          continue;
        }
      }
    } else if (c < 0xf5) {
      if (left < 4 || !isTrail(b[i + 1]) || !isTrail(b[i + 2]) || !isTrail(b[i + 3])) {
        bad = left < 2 || isLead(b[i + 1]) ? 1 : left < 3 || isLead(b[i + 2]) ? 2 : left < 4 || isLead(b[i + 3]) ? 3 : 4;
      } else {
        const cp = ((c & 0x07) << 18) | ((b[i + 1] & 0x3f) << 12) | ((b[i + 2] & 0x3f) << 6) | (b[i + 3] & 0x3f);
        if (cp < 0x10000 || cp > 0x10ffff) bad = 4;
        else {
          u[n++] = 0xd800 + ((cp - 0x10000) >> 10);
          u[n++] = 0xdc00 + ((cp - 0x10000) & 0x3ff);
          i += 4;
          continue;
        }
      }
    } else {
      bad = 1;
    }
    u[n++] = 0xfffd;
    i += bad;
  }
  return unitsText(u, n);
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

// $_POST aus einem Formular-Inhalt: genau wie parseStr(phpText(body), true), aber auf den Bytes. „&“, „=“, „%“ und „+“
// sind ASCII und stehen in keiner UTF-8-Folge, also trennen Bytes und Text an denselben Stellen, und ein Stück für
// sich gelesen ergibt denselben Text wie im Ganzen (eine Folge endet spätestens vor einem ASCII-Byte). Jedes Stück
// wird erst nach dem Dekodieren einmal als Text gelesen – ohne den Umweg über den Text des ganzen Inhalts und zurück
// (bei ungültigem UTF-8 zwei Durchgänge mehr).
export function parseFormBody(body: Buffer): PhpArray {
  const out: PhpArray = {};
  let count = 0;
  for (let start = 0, end = 0; end < body.length; start = end + 1) {
    end = body.indexOf(0x26, start);
    if (end < 0) end = body.length;
    if (++count > MAX_INPUT_VARS + 1) break;
    if (end === start) continue;
    const pair = body.subarray(start, end);
    const eq = pair.indexOf(0x3d);
    const key = decodeFormBytes(eq >= 0 ? pair.subarray(0, eq) : pair);
    const val = decodeFormBytes(eq >= 0 ? pair.subarray(eq + 1) : pair.subarray(0, 0));
    setPhpVar(out, key, val);
  }
  return out;
}

// urldecode(): + wird Leerzeichen, %XX ein Byte, ungültige %-Folgen bleiben stehen (auch neben gültigem UTF-8).
// Ergibt das kein gültiges UTF-8, bleiben die Bytes erhalten wie in PHP (phpText) – auch schon rohe Bytes im Text.
// Ohne % bleibt der Text bis auf die Leerzeichen, wie er ist. Jeder Schritt ist ein Durchgang (das Formular liest der
// Server vor jeder Anmeldung).
const PLUS = asciiSwap('+', ' ');
function decodeForm(s: string): string {
  if (!s.includes('%')) return replaceAscii(s, PLUS);
  const src = phpBytes(s);
  const out = Buffer.allocUnsafe(src.length);
  return phpText(out.subarray(0, percentDecode(src, out, true)));
}
// Dasselbe auf Bytes (phpBytes() von dem Text, den decodeForm() bekäme)
function decodeFormBytes(b: Buffer): string {
  if (b.indexOf(0x25) < 0 && b.indexOf(0x2b) < 0) return phpText(b);
  const out = Buffer.allocUnsafe(b.length);
  return phpText(out.subarray(0, percentDecode(b, out, true)));
}

// max_input_nesting_level (Vorgabe von PHP)
const MAX_INPUT_NESTING = 64;

// Einen Feldnamen mit PHP-Regeln einsetzen (auch für multipart-Felder), wie php_register_variable_ex():
// Name bis zum ersten Nullbyte, führende Leerzeichen weg, vor der ersten [ werden Leerzeichen und Punkte zu _
// (leerer Name → verworfen). [] und [ ] (genau ein Leerraum-Zeichen) hängen an. Eine offene [ auf der ersten Ebene
// wird Teil des Namens (danach werden auch Leerzeichen, Punkte und [ zu _), tiefer fällt der Rest weg.
// Mehr als 64 Ebenen löschen die ganze Variable. Linear in der Länge des Namens (ohne split() und replace() je
// Treffer: ein Name aus 20 MB „[“ oder „.“ brauchte Sekunden).
const NAME_SWAP = asciiSwap('. ', '_');
const NAME_SWAP_OPEN = asciiSwap('. [', '_');
export function setPhpVar(target: PhpArray, name: string, value: PhpValue): void {
  const nul = name.indexOf('\0');
  const end = nul < 0 ? name.length : nul;
  let lead = 0;
  while (lead < end && name.charCodeAt(lead) === 0x20) lead++;
  const key = name.slice(lead, end);
  const open = key.indexOf('[');
  const base = replaceAscii(open >= 0 ? key.slice(0, open) : key, NAME_SWAP);
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
        putVar(target, base + '_' + replaceAscii(key.slice(i + 1), NAME_SWAP_OPEN), value);
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
    // era: Jahre vor Christus (z. B. der Zeitstempel 0000-00-00 → Nov 30, -0001) richtig zählen
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', era: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    dtfCache.set(tz, f);
  }
  return f;
}
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Date.UTC() ohne die Sonderregel für die Jahre 0–99 (sonst 1900–1999); 400 Jahre sind genau 146097 Tage
function utcMs(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  return y >= 0 && y <= 99 ? Date.UTC(y + 400, mo, d, h, mi, s) - 12622780800000 : Date.UTC(y, mo, d, h, mi, s);
}

export function wallTime(unix: number, tz = timeZone()): WallTime {
  const p: Record<string, string> = {};
  for (const x of dtf(tz).formatToParts(new Date(unix * 1000))) p[x.type] = x.value;
  // Astronomische Jahreszahl wie PHP: 1 v. Chr. = 0, 2 v. Chr. = -1
  const year = p.era === 'BC' ? 1 - Number(p.year) : Number(p.year);
  return {
    year, month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second), weekday: WEEKDAYS.indexOf(p.weekday),
  };
}

// Abstand zu UTC in Sekunden zu diesem Zeitpunkt
export function offsetAt(unix: number, tz = timeZone()): number {
  const w = wallTime(unix, tz);
  return (utcMs(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(unix) * 1000) / 1000;
}

// Ortszeit → Unix-Sekunden (wie mktime/strtotime in der Zeitzone; Überläufe wie in PHP erlaubt)
export function wallToUnix(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, tz = timeZone()): number {
  const naive = utcMs(y, mo - 1, d, h, mi, s) / 1000;
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
      // %s%04lld wie in PHP: mindestens vier Stellen, vor Christus mit "-" (0001, -0001)
      case 'Y': out += (w.year < 0 ? '-' : '') + pad(Math.abs(w.year), 4); break;
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
const daysInMonth = (y: number, m: number) => new Date(utcMs(y, m, 0)).getUTCDate();
const dayOfYear = (y: number, m: number, d: number) => (utcMs(y, m - 1, d) - utcMs(y, 0, 1)) / 86400000;
function isoWeek(y: number, m: number, d: number): { year: number; week: number } {
  const date0 = new Date(utcMs(y, m - 1, d));
  const day = date0.getUTCDay() || 7;
  date0.setUTCDate(date0.getUTCDate() + 4 - day);
  const yearStart = utcMs(date0.getUTCFullYear(), 0, 1);
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
  if (utcOffset !== null) return utcMs(y, mo - 1, d, h, mi, sec) / 1000 - utcOffset;
  return wallToUnix(y, mo, d, h, mi, sec, tz);
}
