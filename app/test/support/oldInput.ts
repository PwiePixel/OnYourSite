// Frühere Fassungen der Eingabe-Funktionen aus src/php.ts (Stand 1045957, vor der Umstellung auf einen Durchgang),
// unverändert übernommen – nur als Bezug für test/linear-input.test.ts: Die neuen Fassungen müssen für jede Eingabe
// genau dasselbe liefern. Nicht im Code der Seite benutzen (mehrere davon brauchen auf großen Eingaben Sekunden).
import { isUtf8 } from 'node:buffer';
import type { PhpArray, PhpValue } from '../../src/php.js';

// mb_* zählen Unicode-Zeichen (Codepoints), nicht UTF-16-Einheiten. Rohe Bytes (siehe phpText) zählen wie in PHP:
// jede ungültige Folge ist ein Zeichen und wird in mb_substr() zu "?"
export const mbStrlen = (s: string): number => mbChars(s).length;
export function mbSubstr(s: string, start: number, len?: number): string {
  const a = mbChars(s);
  const st = start < 0 ? Math.max(0, a.length + start) : start;
  if (len === undefined || len === null) return a.slice(st).join('');
  const en = len < 0 ? a.length + len : st + len;
  return a.slice(st, Math.max(st, en)).join('');
}

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

// PHP-Texte sind Bytes: Formularwerte mit ungültigem UTF-8 behält PHP unverändert – strlen() zählt die rohen Bytes,
// preg_* mit /u (oys_clean_text, oys_clean_url) liefert dann '' und password_hash() rechnet mit genau diesen Bytes.
// Node las sie früher als U+FFFD. Jetzt wird jedes Byte, das nicht zu gültigem UTF-8 gehört, als eigenes Zeichen
// U+DC80–U+DCFF gehalten: eine allein stehende Hälfte eines Surrogatpaars, die aus gültigem UTF-8 nie entsteht.
// Verlustfrei (phpBytes() ergibt wieder genau die Bytes der Anfrage); gültige Texte bleiben genau wie bisher.
const RAW_BYTE = /(?<![\uD800-\uDBFF])[\uDC80-\uDCFF]/;
export const hasRawBytes = (s: string): boolean => RAW_BYTE.test(s);

// Bytes → Text: gültiges UTF-8 wie Buffer.toString(), jedes andere Byte als U+DC80–U+DCFF
export function phpText(b: Buffer): string {
  if (isUtf8(b)) return b.toString('utf8');
  let out = '';
  let start = 0;
  let i = 0;
  while (i < b.length) {
    const n = utf8SeqLength(b, i);
    if (n > 0) {
      i += n;
      continue;
    }
    if (start < i) out += b.toString('utf8', start, i);
    out += String.fromCharCode(0xdc00 + b[i]);
    start = ++i;
  }
  return start < b.length ? out + b.toString('utf8', start) : out;
}

// Text → Bytes (Gegenstück zu phpText): U+DC80–U+DCFF wieder als einzelne Bytes, alles andere UTF-8
export function phpBytes(s: string): Buffer {
  if (!hasRawBytes(s)) return Buffer.from(s, 'utf8');
  const parts: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0xdc80 || c > 0xdcff) continue;
    const prev = i > 0 ? s.charCodeAt(i - 1) : 0;
    if (prev >= 0xd800 && prev <= 0xdbff) continue;
    if (start < i) parts.push(Buffer.from(s.slice(start, i), 'utf8'));
    parts.push(Buffer.of(c - 0xdc00));
    start = i + 1;
  }
  if (start < s.length) parts.push(Buffer.from(s.slice(start), 'utf8'));
  return Buffer.concat(parts);
}

// Länge einer gültigen UTF-8-Folge ab Stelle i (Unicode, Tabelle 3-7), 0 = ungültig
function utf8SeqLength(b: Buffer, i: number): number {
  const c = b[i];
  if (c < 0x80) return 1;
  const tail = (k: number, lo = 0x80, hi = 0xbf): boolean => i + k < b.length && b[i + k] >= lo && b[i + k] <= hi;
  if (c >= 0xc2 && c <= 0xdf) return tail(1) ? 2 : 0;
  if (c === 0xe0) return tail(1, 0xa0) && tail(2) ? 3 : 0;
  if (c === 0xed) return tail(1, 0x80, 0x9f) && tail(2) ? 3 : 0;
  if (c >= 0xe1 && c <= 0xef) return tail(1) && tail(2) ? 3 : 0;
  if (c === 0xf0) return tail(1, 0x90) && tail(2) && tail(3) ? 4 : 0;
  if (c === 0xf4) return tail(1, 0x80, 0x8f) && tail(2) && tail(3) ? 4 : 0;
  if (c >= 0xf1 && c <= 0xf3) return tail(1) && tail(2) && tail(3) ? 4 : 0;
  return 0;
}

// Zeichen wie mbstring sie sieht: Codepoints; mit rohen Bytes ist jede ungültige Folge (der längste Anfang einer
// gültigen Folge, sonst ein Byte – wie der UTF-8-Decoder von PHP 8.3) ein Zeichen "?"
function mbChars(s: string): string[] {
  if (!hasRawBytes(s)) return Array.from(s);
  const b = phpBytes(s);
  const out: string[] = [];
  let i = 0;
  while (i < b.length) {
    const n = utf8SeqLength(b, i);
    if (n > 0) {
      out.push(b.toString('utf8', i, i + n));
      i += n;
    } else {
      out.push('?');
      i += maximalSubpart(b, i);
    }
  }
  return out;
}

// Länge des ungültigen Stücks ab i: so viele Bytes, wie noch zu einer gültigen Folge passen könnten (mindestens 1)
function maximalSubpart(b: Buffer, i: number): number {
  const c = b[i];
  const [lo, need] = c === 0xe0 ? [0xa0, 2] : c === 0xed ? [0x80, 2] : c >= 0xe1 && c <= 0xef ? [0x80, 2]
    : c === 0xf0 ? [0x90, 3] : c >= 0xf1 && c <= 0xf3 ? [0x80, 3] : c === 0xf4 ? [0x80, 3] : c >= 0xc2 && c <= 0xdf ? [0x80, 1] : [0, 0];
  const hi = c === 0xed ? 0x9f : c === 0xf4 ? 0x8f : 0xbf;
  let n = 1;
  for (let k = 1; k <= need && i + k < b.length; k++) {
    const t = b[i + k];
    if (t < (k === 1 ? lo : 0x80) || t > (k === 1 ? hi : 0xbf)) break;
    n++;
  }
  return n;
}

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

// urldecode(): + wird Leerzeichen, %XX ein Byte, ungültige %-Folgen bleiben stehen (auch neben gültigem UTF-8).
// Ergibt das kein gültiges UTF-8, bleiben die Bytes erhalten wie in PHP (phpText) – auch schon rohe Bytes im Text
function decodeForm(s: string): string {
  if (!s.includes('%')) return s.includes('+') ? s.replace(/\+/g, ' ') : s;
  const src = phpBytes(s);
  const out = Buffer.alloc(src.length);
  let n = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === 0x25 && i + 2 < src.length && isHexByte(src[i + 1]) && isHexByte(src[i + 2])) {
      out[n++] = parseInt(src.toString('latin1', i + 1, i + 3), 16);
      i += 2;
    } else {
      out[n++] = src[i] === 0x2b ? 0x20 : src[i];
    }
  }
  return phpText(out.subarray(0, n));
}

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

// strtolower/strtoupper/ucfirst arbeiten in PHP 8.2+ nur auf ASCII
export const strtolower = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
export const strtoupper = (s: string): string => s.replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 32));
export const ucfirst = (s: string): string => (s === '' ? s : strtoupper(s[0]) + s.slice(1));

// htmlspecialchars(…, ENT_SUBSTITUTE) und json_encode(…, JSON_INVALID_UTF8_SUBSTITUTE) lesen UTF-8 mit eigenen Regeln
// (get_next_char() in ext/standard/html.c): jede ungültige Folge wird ein U+FFFD – ein kodiertes Surrogat (ED A0 80)
// oder eine zu lange Form ist dabei ein Fehler für die ganze Folge
export function phpUtf8Substitute(b: Buffer): string {
  const lead = (c: number | undefined): boolean => c !== undefined && (c < 0x80 || (c >= 0xc2 && c <= 0xf4));
  const trail = (c: number | undefined): boolean => c !== undefined && c >= 0x80 && c <= 0xbf;
  let out = '';
  let i = 0;
  const fail = (n: number): void => {
    out += '\uFFFD';
    i += n;
  };
  while (i < b.length) {
    const c = b[i];
    const left = b.length - i;
    if (c < 0x80) {
      out += String.fromCharCode(c);
      i++;
    } else if (c < 0xc2) {
      fail(1);
    } else if (c < 0xe0) {
      if (left < 2) fail(1);
      else if (!trail(b[i + 1])) fail(lead(b[i + 1]) ? 1 : 2);
      else {
        out += String.fromCharCode(((c & 0x1f) << 6) | (b[i + 1] & 0x3f));
        i += 2;
      }
    } else if (c < 0xf0) {
      if (left < 3 || !trail(b[i + 1]) || !trail(b[i + 2])) {
        if (left < 2 || lead(b[i + 1])) fail(1);
        else if (left < 3 || lead(b[i + 2])) fail(2);
        else fail(3);
        continue;
      }
      const cp = ((c & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f);
      if (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff)) fail(3);
      else {
        out += String.fromCharCode(cp);
        i += 3;
      }
    } else if (c < 0xf5) {
      if (left < 4 || !trail(b[i + 1]) || !trail(b[i + 2]) || !trail(b[i + 3])) {
        if (left < 2 || lead(b[i + 1])) fail(1);
        else if (left < 3 || lead(b[i + 2])) fail(2);
        else if (left < 4 || lead(b[i + 3])) fail(3);
        else fail(4);
        continue;
      }
      const cp = ((c & 0x07) << 18) | ((b[i + 1] & 0x3f) << 12) | ((b[i + 2] & 0x3f) << 6) | (b[i + 3] & 0x3f);
      if (cp < 0x10000 || cp > 0x10ffff) fail(4);
      else {
        out += String.fromCodePoint(cp);
        i += 4;
      }
    } else {
      fail(1);
    }
  }
  return out;
}
