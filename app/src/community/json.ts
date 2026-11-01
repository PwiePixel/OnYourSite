// JSON genau wie PHP: json_decode($text, true) mit PHP-Typen und json_encode() mit den PHP-Optionen.
// Die Bot-Schnittstelle liest beliebige Eingaben – JSON.parse wäre hier nicht gleichwertig: große ganze Zahlen
// (Discord-IDs als Zahl), -0.0, einzelne UTF-16-Ersatzzeichen, die Verschachtelungstiefe und Objekte mit
// Schlüsseln "0", "1" … verhalten sich in PHP anders.

// ---------------------------------------------------------------- PHP-Werte

// int (64 Bit) aus PHP
export class PhpInt {
  constructor(readonly value: bigint) {}
}
// float aus PHP
export class PhpFloat {
  constructor(readonly value: number) {}
}
// PHP-Array: Schlüssel als Text in der Reihenfolge des Einfügens. Ganze Zahlen in Normalform ("5", nicht "05")
// sind in PHP int-Schlüssel – als Text sind beide gleich, also genügt eine Map mit Text-Schlüsseln.
export class PhpArr {
  readonly map = new Map<string, PhpJson>();
  get(key: string): PhpJson | undefined {
    return this.map.get(key);
  }
}
export type PhpJson = null | boolean | string | PhpInt | PhpFloat | PhpArr;

// $arr['key'] ?? null (fehlende Schlüssel und Nicht-Arrays → undefined)
export function jsonField(arr: unknown, key: string): PhpJson | undefined {
  return arr instanceof PhpArr ? arr.get(key) : undefined;
}

// (string) $v
export function phpCastString(v: unknown): string {
  if (v === null || v === undefined || v === false) return '';
  if (v === true) return '1';
  if (typeof v === 'string') return v;
  if (v instanceof PhpInt) return v.value.toString();
  if (v instanceof PhpFloat) return phpFloatString(v.value);
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) < 2 ** 63 ? String(v) : phpFloatString(v);
  // Arrays werden zu "Array" (PHP warnt dabei nur)
  return 'Array';
}

// !empty($v) – PHP-Wahrheitswert
export function phpJsonTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === '' || v === '0') return false;
  if (v instanceof PhpInt) return v.value !== 0n;
  if (v instanceof PhpFloat) return v.value !== 0;
  if (v instanceof PhpArr) return v.map.size > 0;
  if (typeof v === 'number') return v !== 0;
  return true;
}

// ---------------------------------------------------------------- Kommazahlen als Text

// Exakte Dezimalziffern einer Kommazahl (ohne Vorzeichen): Ziffern und Position des Kommas (wie decpt in zend_dtoa)
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
  const stripped = digits.replace(/0+$/, '');
  return { digits: stripped, decpt };
}

// Auf n gültige Stellen runden – bei genau der Hälfte zur geraden Ziffer (zend_dtoa, Modus 2)
function roundDigits(digits: string, decpt: number, n: number): { digits: string; decpt: number } {
  if (digits.length <= n) return { digits, decpt };
  const head = digits.slice(0, n);
  const rest = digits.slice(n);
  const first = rest.charCodeAt(0) - 48;
  const tie = first === 5 && /^5$/.test(rest);
  const up = first > 5 || (first === 5 && !tie) || (tie && (head.charCodeAt(n - 1) - 48) % 2 === 1);
  if (!up) return { digits: head.replace(/0+$/, ''), decpt };
  let carried = (BigInt(head) + 1n).toString();
  let newDecpt = decpt;
  if (carried.length > head.length) {
    newDecpt++;
    carried = carried.slice(0, n);
  }
  return { digits: carried.replace(/0+$/, ''), decpt: newDecpt };
}

// php_gcvt(): feste Schreibweise oder Exponent (1.0E+25), je nach Lage des Kommas
function gcvt(digits: string, decpt: number, precision: number, expChar: string): string {
  if (decpt < 0 ? decpt < -3 : decpt > precision) {
    const e = decpt - 1;
    return digits[0] + '.' + (digits.length > 1 ? digits.slice(1) : '0') + expChar + (e < 0 ? '-' : '+') + String(Math.abs(e));
  }
  if (decpt <= 0) return '0.' + '0'.repeat(-decpt) + digits;
  const int = digits.length >= decpt ? digits.slice(0, decpt) : digits + '0'.repeat(decpt - digits.length);
  const frac = digits.slice(decpt);
  return frac === '' ? int : int + '.' + frac;
}

// (string) $float – precision = 14 (php.ini), z. B. 0.1, 1.0E+25, 1.0E-5, -0
export function phpFloatString(f: number): string {
  if (Number.isNaN(f)) return 'NAN';
  if (!Number.isFinite(f)) return f > 0 ? 'INF' : '-INF';
  if (f === 0) return Object.is(f, -0) ? '-0' : '0';
  const exact = exactDigits(f);
  const r = roundDigits(exact.digits, exact.decpt, 14);
  return (f < 0 ? '-' : '') + gcvt(r.digits, r.decpt, 14, 'E');
}

// json_encode($float) – serialize_precision = -1: kürzeste eindeutige Ziffernfolge, z. B. 0.1, 1.0e+25;
// unendlich und NaN lassen sich nicht schreiben (null = Fehler)
export function phpJsonFloat(f: number): string | null {
  if (!Number.isFinite(f)) return null;
  if (f === 0) return Object.is(f, -0) ? '-0' : '0';
  const [mant, exp] = Math.abs(f).toExponential().split('e');
  const digits = mant.replace('.', '');
  return (f < 0 ? '-' : '') + gcvt(digits, Number(exp) + 1, 17, 'e');
}

// ---------------------------------------------------------------- json_decode($text, true)

const MAX_DEPTH = 512;

class JsonSyntaxError extends Error {}

class Parser {
  private i = 0;
  constructor(private readonly s: string) {}

  parse(): PhpJson {
    const v = this.value(0);
    this.ws();
    if (this.i !== this.s.length) throw new JsonSyntaxError();
    return v;
  }

  private ws(): void {
    const s = this.s;
    while (this.i < s.length) {
      const c = s.charCodeAt(this.i);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
      this.i++;
    }
  }

  private value(depth: number): PhpJson {
    this.ws();
    const c = this.s[this.i];
    if (c === '{') return this.object(depth + 1);
    if (c === '[') return this.array(depth + 1);
    if (c === '"') return this.string();
    if (c === '-' || (c >= '0' && c <= '9')) return this.number();
    for (const [word, v] of [['true', true], ['false', false], ['null', null]] as const) {
      if (this.s.startsWith(word, this.i)) {
        this.i += word.length;
        return v;
      }
    }
    throw new JsonSyntaxError();
  }

  private object(depth: number): PhpArr {
    // Tiefe wie PHP: mit der Vorgabe 512 sind höchstens 511 Ebenen erlaubt
    if (depth >= MAX_DEPTH) throw new JsonSyntaxError();
    this.i++;
    const out = new PhpArr();
    this.ws();
    if (this.s[this.i] === '}') {
      this.i++;
      return out;
    }
    for (;;) {
      this.ws();
      if (this.s[this.i] !== '"') throw new JsonSyntaxError();
      const key = this.string();
      this.ws();
      if (this.s[this.i] !== ':') throw new JsonSyntaxError();
      this.i++;
      // Doppelte Schlüssel: der letzte Wert gilt, die Stelle bleibt die des ersten (wie in PHP)
      out.map.set(key, this.value(depth));
      this.ws();
      const c = this.s[this.i++];
      if (c === '}') return out;
      if (c !== ',') throw new JsonSyntaxError();
    }
  }

  private array(depth: number): PhpArr {
    if (depth >= MAX_DEPTH) throw new JsonSyntaxError();
    this.i++;
    const out = new PhpArr();
    this.ws();
    if (this.s[this.i] === ']') {
      this.i++;
      return out;
    }
    for (let n = 0; ; n++) {
      out.map.set(String(n), this.value(depth));
      this.ws();
      const c = this.s[this.i++];
      if (c === ']') return out;
      if (c !== ',') throw new JsonSyntaxError();
    }
  }

  private hex4(): number {
    const h = this.s.slice(this.i, this.i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(h)) throw new JsonSyntaxError();
    this.i += 4;
    return parseInt(h, 16);
  }

  private string(): string {
    const s = this.s;
    this.i++;
    let out = '';
    let start = this.i;
    for (;;) {
      if (this.i >= s.length) throw new JsonSyntaxError();
      const c = s.charCodeAt(this.i);
      if (c === 0x22) {
        out += s.slice(start, this.i);
        this.i++;
        return out;
      }
      // Steuerzeichen nur maskiert
      if (c < 0x20) throw new JsonSyntaxError();
      if (c !== 0x5c) {
        this.i++;
        continue;
      }
      out += s.slice(start, this.i);
      const e = s[this.i + 1];
      this.i += 2;
      switch (e) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          const cu = this.hex4();
          if (cu >= 0xdc00 && cu <= 0xdfff) throw new JsonSyntaxError();
          if (cu >= 0xd800 && cu <= 0xdbff) {
            // Nur als Paar gültig – ein einzelnes Ersatzzeichen lehnt PHP ab
            if (s[this.i] !== '\\' || s[this.i + 1] !== 'u') throw new JsonSyntaxError();
            this.i += 2;
            const low = this.hex4();
            if (low < 0xdc00 || low > 0xdfff) throw new JsonSyntaxError();
            out += String.fromCharCode(cu, low);
          } else {
            out += String.fromCharCode(cu);
          }
          break;
        }
        default:
          throw new JsonSyntaxError();
      }
      start = this.i;
    }
  }

  private number(): PhpInt | PhpFloat {
    const re = /-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;
    re.lastIndex = this.i;
    const m = re.exec(this.s);
    if (!m) throw new JsonSyntaxError();
    this.i += m[0].length;
    const text = m[0];
    if (m[2] === undefined && m[3] === undefined) {
      // Ganze Zahl: bis 64 Bit bleibt sie int, darüber wird sie float (wie PHP ohne JSON_BIGINT_AS_STRING)
      const negative = text[0] === '-';
      const digits = negative ? text.slice(1) : text;
      let big = digits.length > 19;
      if (digits.length === 19) {
        const cmp = digits < '9223372036854775808' ? -1 : digits === '9223372036854775808' ? 0 : 1;
        big = !(cmp < 0 || (cmp === 0 && negative));
      }
      if (!big) return new PhpInt(BigInt(text));
    }
    return new PhpFloat(Number(text));
  }
}

// json_decode($text, true): bei jedem Fehler null (wie PHP). Bytes müssen gültiges UTF-8 sein.
export function phpJsonDecode(input: string | Buffer): PhpJson {
  let text: string;
  if (typeof input === 'string') {
    text = input;
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input);
    } catch {
      return null;
    }
  }
  try {
    return new Parser(text).parse();
  } catch (err) {
    if (err instanceof JsonSyntaxError || err instanceof RangeError) return null;
    throw err;
  }
}

// ---------------------------------------------------------------- json_encode()

export interface JsonEncodeFlags {
  unescapedUnicode?: boolean;
  unescapedSlashes?: boolean;
}

class JsonEncodeError extends Error {}

function encodeString(s: string, flags: JsonEncodeFlags): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    switch (c) {
      case 0x22: out += '\\"'; continue;
      case 0x5c: out += '\\\\'; continue;
      case 0x2f: out += flags.unescapedSlashes ? '/' : '\\/'; continue;
      case 0x08: out += '\\b'; continue;
      case 0x0c: out += '\\f'; continue;
      case 0x0a: out += '\\n'; continue;
      case 0x0d: out += '\\r'; continue;
      case 0x09: out += '\\t'; continue;
      // PHP maskiert U+2028/U+2029 immer (ohne JSON_UNESCAPED_LINE_TERMINATORS)
      case 0x2028: out += '\\u2028'; continue;
      case 0x2029: out += '\\u2029'; continue;
    }
    if (c < 0x20) {
      out += '\\u' + c.toString(16).padStart(4, '0');
      continue;
    }
    if (c >= 0xd800 && c <= 0xdfff) {
      // Ein einzelnes Ersatzzeichen wäre in PHP ungültiges UTF-8 → Fehler
      const pair = c <= 0xdbff && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff;
      if (!pair) throw new JsonEncodeError();
      out += flags.unescapedUnicode ? s[i] + s[i + 1] : '\\u' + c.toString(16) + '\\u' + s.charCodeAt(i + 1).toString(16);
      i++;
      continue;
    }
    if (c >= 0x80 && !flags.unescapedUnicode) {
      out += '\\u' + c.toString(16).padStart(4, '0');
      continue;
    }
    out += s[i];
  }
  return out + '"';
}

function encodeValue(v: unknown, flags: JsonEncodeFlags, depth: number): string {
  if (v === null || v === undefined) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'string') return encodeString(v, flags);
  if (v instanceof PhpInt) return v.value.toString();
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof PhpFloat || typeof v === 'number') {
    const n = v instanceof PhpFloat ? v.value : v;
    if (typeof v === 'number' && Number.isInteger(n) && Math.abs(n) < 2 ** 63) return String(n);
    const f = phpJsonFloat(n);
    if (f === null) throw new JsonEncodeError();
    return f;
  }
  // Arrays: Liste, wenn die Schlüssel genau 0, 1, 2 … sind, sonst Objekt; mehr als 512 Ebenen → Fehler
  const level = depth + 1;
  let entries: Array<[string, unknown]>;
  let list: boolean;
  if (v instanceof PhpArr) {
    entries = [...v.map.entries()];
    list = entries.every(([k], i) => k === String(i));
  } else if (Array.isArray(v)) {
    entries = v.map((x, i) => [String(i), x]);
    list = true;
  } else if (typeof v === 'object') {
    entries = Object.entries(v as Record<string, unknown>);
    list = false;
  } else {
    throw new JsonEncodeError();
  }
  const parts = entries.map(([k, x]) => (list ? '' : encodeString(k, flags) + ':') + encodeValue(x, flags, level));
  if (level > MAX_DEPTH) throw new JsonEncodeError();
  return list ? '[' + parts.join(',') + ']' : '{' + parts.join(',') + '}';
}

// json_encode($value, $flags): false bei einem Fehler (unendliche Zahl, zu tief, ungültiger Text)
export function phpJsonEncode(value: unknown, flags: JsonEncodeFlags = {}): string | false {
  try {
    return encodeValue(value, flags, 0);
  } catch (err) {
    if (err instanceof JsonEncodeError || err instanceof RangeError) return false;
    throw err;
  }
}

// oys_json(): JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES; ein Fehler ergibt (wie echo false) einen leeren Inhalt
export function oysJsonBody(value: unknown): string {
  const out = phpJsonEncode(value, { unescapedUnicode: true, unescapedSlashes: true });
  return out === false ? '' : out;
}
