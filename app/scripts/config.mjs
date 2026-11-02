#!/usr/bin/env node
// Einstellungen der Seite (config.json) für server/install.sh – reines Node.js, ohne Pakete und ohne PHP.
//
//   node app/scripts/config.mjs write --domain D --uploads U --db-name N --db-user U [--file F] [--current F] [--import F]
//        Schreibt config.json: bisherige Werte bleiben (aus config.json, sonst aus der alten config.php), Datenbank, Domain
//        und Upload-Ordner setzt der Installer. Passwort und Bot-Geheimnis kommen über die Umgebung (OYS_DB_PASS,
//        OYS_BOT_SECRET), nie über die Befehlszeile. Schlüssel (aes_key, app_secret) entstehen nur, wenn sie fehlen.
//   node app/scripts/config.mjs get <schlüssel.mit.punkten> [--file F]      Wert ausgeben (config.json oder config.php)
//   node app/scripts/config.mjs set <schlüssel> [wert] [--json] [--file F]  Wert setzen (ohne Wert: aus OYS_VALUE)
//   node app/scripts/config.mjs set <schlüssel> --stdin [--file F]          Wert als eine Zeile von der Eingabe (für
//                                                                          Geheimnisse, die von Hand kommen: so stehen
//                                                                          sie weder in der Prozessliste noch im Verlauf)
//   node app/scripts/config.mjs reset-keys [--file F]                       aes_key, app_secret, cron_secret löschen
//   node app/scripts/config.mjs from-php <config.php>                       config.php als JSON ausgeben
//
// config.php wird nicht ausgeführt, sondern gelesen: erlaubt ist genau das, was config.example.php und der Installer
// der PHP-Version schreiben – return [ … ]; mit Texten in '…' und "…" (samt ihren Escapes), Zahlen, true/false/null,
// verschachtelten Listen und Kommentaren. Alles andere (Variablen, Konstanten, Funktionen …) wird mit einer Meldung
// abgelehnt. Geschrieben wird immer atomar (neue Datei, dann umbenennen) als root:www-data 0640; die vorige Fassung
// kommt nach /etc/onyoursite/config.json.previous (nur root).
import { randomBytes } from 'node:crypto';
import { closeSync, chmodSync, chownSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PREVIOUS = '/etc/onyoursite/config.json.previous';

export class ConfigError extends Error {}

// ---------------------------------------------------------------- PHP-Werte

// Ganze Zahlen aus PHP als BigInt (64 Bit wie PHP), Kommazahlen als Number, Texte als Bytes (Buffer)
const LONG_MAX = 2n ** 63n - 1n;
const LONG_MIN = -(2n ** 63n);

// Ein PHP-Array: Schlüssel (BigInt oder Buffer) in der Reihenfolge des Einfügens
export class PhpArray {
  constructor() {
    this.entries = [];
    this.index = new Map();
    // nNextFreeElement wie PHP 8.3 (der erste negative Schlüssel zählt mit)
    this.next = LONG_MIN;
  }

  static id(key) {
    return typeof key === 'bigint' ? 'i' + key.toString() : 's' + key.toString('latin1');
  }

  set(key, value) {
    const id = PhpArray.id(key);
    const at = this.index.get(id);
    if (at !== undefined) {
      // Doppelte Schlüssel: der letzte Wert gilt, die Stelle bleibt die des ersten
      this.entries[at][1] = value;
    } else {
      this.index.set(id, this.entries.length);
      this.entries.push([key, value]);
    }
    if (typeof key === 'bigint' && key >= this.next) this.next = key < LONG_MAX ? key + 1n : LONG_MAX;
  }

  push(value) {
    const key = this.next === LONG_MIN ? 0n : this.next;
    if (this.index.has(PhpArray.id(key))) return false;
    this.set(key, value);
    return true;
  }

  // Liste im Sinne von json_encode: Schlüssel genau 0, 1, 2, … in dieser Reihenfolge
  isList() {
    return this.entries.every(([k], i) => typeof k === 'bigint' && k === BigInt(i));
  }
}

// ---------------------------------------------------------------- config.php lesen (ohne PHP)

const IDENT = /[A-Za-z_\x80-\xff][A-Za-z0-9_\x80-\xff]*/y;
// Zahlen wie der PHP-Lexer (mit _ als Trenner)
const LNUM = '[0-9]+(?:_[0-9]+)*';
const DNUM = `(?:(?:${LNUM})?\\.${LNUM}|${LNUM}\\.(?:${LNUM})?)`;
const EXP_DNUM = new RegExp(`(?:${LNUM}|${DNUM})[eE][+-]?${LNUM}`, 'y');
const DNUM_RE = new RegExp(DNUM, 'y');
const HNUM = /0[xX][0-9a-fA-F]+(?:_[0-9a-fA-F]+)*/y;
const BNUM = /0[bB][01]+(?:_[01]+)*/y;
const ONUM = /0[oO][0-7]+(?:_[0-7]+)*/y;
const LNUM_RE = new RegExp(LNUM, 'y');

const SIMPLE_ESCAPES = { n: 0x0a, t: 0x09, r: 0x0d, v: 0x0b, e: 0x1b, f: 0x0c, '\\': 0x5c, $: 0x24, '"': 0x22 };

class PhpReader {
  constructor(buf, name) {
    // Ein Zeichen je Byte: so bleiben Texte Byte für Byte erhalten
    this.s = buf.toString('latin1');
    this.i = 0;
    this.name = name;
  }

  line(at) {
    let n = 1;
    for (let k = 0; k < at && k < this.s.length; k++) if (this.s.charCodeAt(k) === 10) n++;
    return n;
  }

  fail(message, at = this.i) {
    throw new ConfigError(`${this.name}, line ${this.line(at)}: ${message}`);
  }

  unsupported(at = this.i) {
    const found = this.s.slice(at, at + 30).split('\n')[0];
    this.fail(`this can’t be read without PHP (allowed are only 'text', "text", numbers, true, false, null and [ … ] lists) – found: ${JSON.stringify(Buffer.from(found, 'latin1').toString('utf8'))}`, at);
  }

  peek(text) {
    return this.s.startsWith(text, this.i);
  }

  file() {
    // UTF-8-BOM und Leerraum vor <?php gibt PHP nur aus – der Rückgabewert bleibt derselbe
    if (this.s.startsWith('\xef\xbb\xbf')) this.i = 3;
    while (this.i < this.s.length && ' \t\r\n'.includes(this.s[this.i])) this.i++;
    if (this.s.slice(this.i, this.i + 5).toLowerCase() !== '<?php' || (this.i + 5 < this.s.length && !' \t\r\n'.includes(this.s[this.i + 5]))) {
      this.fail('the file has to start with <?php');
    }
    this.i += 5;
    this.space();
    const at = this.i;
    IDENT.lastIndex = this.i;
    const word = IDENT.exec(this.s);
    if (!word || word[0].toLowerCase() !== 'return') this.fail('expected return [ … ]; – a config.php that does more can’t be read without PHP', at);
    this.i = IDENT.lastIndex;
    this.space();
    const value = this.expr();
    this.space();
    if (!this.peek(';')) this.fail('expected ; after the settings');
    this.i++;
    this.space();
    if (this.peek('?>')) {
      // Text hinter ?> gibt PHP nie aus (return kam vorher) – nur ein weiteres <?php darf nicht folgen
      this.i += 2;
      if (this.s.indexOf('<?', this.i) >= 0) this.fail('there must be no more PHP code after ?>', this.s.indexOf('<?', this.i));
      this.i = this.s.length;
    }
    if (this.i < this.s.length) this.unsupported();
    return value;
  }

  // Leerraum und Kommentare (// und # enden wie im PHP-Lexer am Zeilenende – \n oder ein einzelnes \r – oder vor ?>)
  space() {
    for (;;) {
      const c = this.s[this.i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        this.i++;
      } else if (this.peek('#[')) {
        // Attribute (PHP 8) sind kein Kommentar
        this.unsupported();
      } else if (this.peek('//') || c === '#') {
        while (this.i < this.s.length && this.s[this.i] !== '\n' && this.s[this.i] !== '\r' && !this.peek('?>')) this.i++;
      } else if (this.peek('/*')) {
        const end = this.s.indexOf('*/', this.i + 2);
        if (end < 0) this.fail('a /* comment */ isn’t closed');
        this.i = end + 2;
      } else {
        return;
      }
    }
  }

  // Ausdruck: Wert mit Vorzeichen (+/-) bei Zahlen, Texte mit . verbunden ('a' . "\0" . 'b' wie var_export)
  expr() {
    const at = this.i;
    let negative = false;
    let signed = false;
    while ((this.peek('-') && !this.peek('--')) || (this.peek('+') && !this.peek('++'))) {
      if (this.s[this.i] === '-') negative = !negative;
      signed = true;
      this.i++;
      this.space();
    }
    const value = this.primary();
    if (signed) {
      // Vorzeichen nur vor Zahlen (-9223372036854775808 ist in PHP eine Kommazahl: ohne Minus passt sie nicht in 64 Bit)
      if (typeof value !== 'bigint' && typeof value !== 'number') this.unsupported(at);
      const result = negative ? -value : value;
      // Die kleinste ganze Zahl schreibt var_export() als -9223372036854775807-1
      if (result === -LONG_MAX) {
        const save = this.i;
        this.space();
        if (this.peek('-1') && !/[0-9A-Za-z_.\x80-\xff]/.test(this.s[this.i + 2] ?? '')) {
          this.i += 2;
          return LONG_MIN;
        }
        this.i = save;
      }
      return result;
    }
    if (!Buffer.isBuffer(value)) return value;
    const parts = [value];
    for (;;) {
      const save = this.i;
      this.space();
      if (!this.peek('.') || /[0-9]/.test(this.s[this.i + 1] ?? '') || this.peek('...') || this.peek('.=')) {
        this.i = save;
        return Buffer.concat(parts);
      }
      this.i++;
      this.space();
      const next = this.primary();
      if (!Buffer.isBuffer(next)) this.unsupported(save);
      parts.push(next);
    }
  }

  primary() {
    const at = this.i;
    const c = this.s[this.i];
    if (c === '[') {
      this.i++;
      return this.array(']');
    }
    if (c === "'") return this.single();
    if (c === '"') return this.double();
    if (c !== undefined && (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(this.s[this.i + 1] ?? '')))) return this.number();
    IDENT.lastIndex = this.i;
    const word = IDENT.exec(this.s);
    if (word) {
      const lower = word[0].toLowerCase();
      this.i = IDENT.lastIndex;
      const save = this.i;
      this.space();
      const callLike = this.peek('(') || this.peek('::') || this.peek('\\');
      if (lower === 'array' && this.peek('(')) {
        this.i++;
        return this.array(')');
      }
      if (!callLike && (lower === 'true' || lower === 'false' || lower === 'null')) {
        this.i = save;
        return lower === 'null' ? null : lower === 'true';
      }
    }
    this.unsupported(at);
  }

  array(close) {
    const arr = new PhpArray();
    for (;;) {
      this.space();
      if (this.peek(close)) {
        this.i++;
        return arr;
      }
      if (this.peek('...') || this.peek('&')) this.unsupported();
      const at = this.i;
      const first = this.expr();
      this.space();
      if (this.peek('=>')) {
        this.i += 2;
        this.space();
        if (this.peek('&')) this.unsupported();
        const value = this.expr();
        arr.set(this.key(first, at), value);
      } else if (!arr.push(first)) {
        this.fail('Cannot add element to the array as the next element is already occupied', at);
      }
      this.space();
      if (this.peek(',')) {
        this.i++;
      } else if (!this.peek(close)) {
        this.fail(`expected , or ${close}`);
      }
    }
  }

  // Schlüssel wie PHP: "8" wird 8 (aber nicht "08", "-0" oder zu große Zahlen), true/false 1/0, null "", Kommazahlen abgeschnitten
  key(value, at) {
    if (typeof value === 'bigint') return value;
    if (Buffer.isBuffer(value)) {
      const text = value.toString('latin1');
      if (/^(0|-?[1-9][0-9]*)$/.test(text) && text !== '-0') {
        const n = BigInt(text);
        if (n >= LONG_MIN && n <= LONG_MAX) return n;
      }
      return value;
    }
    if (typeof value === 'boolean') return value ? 1n : 0n;
    if (value === null) return Buffer.alloc(0);
    // Kommazahl als Schlüssel: abgeschnitten, außerhalb von 64 Bit modulo 2^64 (zend_dval_to_lval), INF/NAN = 0
    if (typeof value === 'number') return Number.isFinite(value) ? BigInt.asIntN(64, BigInt(Math.trunc(value))) : 0n;
    this.fail('this kind of key can’t be used here', at);
  }

  single() {
    const out = [];
    this.i++;
    for (;;) {
      if (this.i >= this.s.length) this.fail('a text in \'…\' isn’t closed');
      const c = this.s[this.i];
      if (c === "'") {
        this.i++;
        return Buffer.from(out.join(''), 'latin1');
      }
      if (c === '\\' && (this.s[this.i + 1] === "'" || this.s[this.i + 1] === '\\')) {
        out.push(this.s[this.i + 1]);
        this.i += 2;
      } else {
        out.push(c);
        this.i++;
      }
    }
  }

  double() {
    const out = [];
    const start = this.i;
    this.i++;
    for (;;) {
      if (this.i >= this.s.length) this.fail('a text in "…" isn’t closed', start);
      const c = this.s[this.i];
      if (c === '"') {
        this.i++;
        return Buffer.from(out.join(''), 'latin1');
      }
      if (c === '$' && /[A-Za-z_\x80-\xff{]/.test(this.s[this.i + 1] ?? '')) {
        this.fail('variables in "…" texts can’t be read without PHP – use \'…\' or write \\$');
      }
      if (c === '{' && this.s[this.i + 1] === '$') this.fail('variables in "…" texts can’t be read without PHP – use \'…\' or write \\$');
      if (c !== '\\') {
        out.push(c);
        this.i++;
        continue;
      }
      const n = this.s[this.i + 1];
      if (n !== undefined && Object.hasOwn(SIMPLE_ESCAPES, n)) {
        out.push(String.fromCharCode(SIMPLE_ESCAPES[n]));
        this.i += 2;
      } else if (n !== undefined && /[0-7]/.test(n)) {
        const m = /[0-7]{1,3}/y;
        m.lastIndex = this.i + 1;
        const digits = m.exec(this.s)[0];
        // Über \377 läuft PHP über (mit Warnung) – nur das untere Byte bleibt
        out.push(String.fromCharCode(parseInt(digits, 8) & 0xff));
        this.i += 1 + digits.length;
      } else if (n === 'x' && /[0-9A-Fa-f]/.test(this.s[this.i + 2] ?? '')) {
        const m = /[0-9A-Fa-f]{1,2}/y;
        m.lastIndex = this.i + 2;
        const digits = m.exec(this.s)[0];
        out.push(String.fromCharCode(parseInt(digits, 16)));
        this.i += 2 + digits.length;
      } else if (n === 'u' && this.s[this.i + 2] === '{') {
        const m = /\{([0-9A-Fa-f]*)\}/y;
        m.lastIndex = this.i + 2;
        const hit = m.exec(this.s);
        if (!hit || hit[1] === '') this.fail('Invalid UTF-8 codepoint escape sequence');
        // Führende Nullen zählen nicht (strtoul)
        const hex = hit[1].replace(/^0+(?=.)/, '');
        const cp = hex.length > 8 ? Infinity : parseInt(hex, 16);
        if (cp > 0x10ffff) this.fail('Invalid UTF-8 codepoint escape sequence: Codepoint too large');
        out.push(utf8Bytes(cp));
        this.i += 2 + hit[0].length;
      } else {
        // Unbekannte Escapes bleiben wie geschrieben (\q, \u ohne {, \x ohne Ziffer). Das Zeichen nach \ gehört
        // dazu: "\{$" ist für PHP keine Variable
        out.push('\\');
        this.i++;
        if (this.i < this.s.length && this.s[this.i] !== '"') {
          out.push(this.s[this.i]);
          this.i++;
        }
      }
    }
  }

  number() {
    const at = this.i;
    const take = (re) => {
      re.lastIndex = this.i;
      const m = re.exec(this.s);
      return m ? m[0] : null;
    };
    let text;
    let value;
    if ((text = take(HNUM)) !== null) {
      value = radix(text.slice(2), 16n);
    } else if ((text = take(BNUM)) !== null) {
      value = radix(text.slice(2), 2n);
    } else if ((text = take(ONUM)) !== null) {
      value = radix(text.slice(2), 8n);
    } else if ((text = take(EXP_DNUM)) !== null || (text = take(DNUM_RE)) !== null) {
      value = Number(text.replace(/_/g, ''));
    } else if ((text = take(LNUM_RE)) !== null) {
      const digits = text.replace(/_/g, '');
      if (digits.length > 1 && digits[0] === '0') {
        // Alte Schreibweise für Oktalzahlen: 017 = 15
        if (/[89]/.test(digits)) this.fail('Invalid numeric literal');
        value = radix(digits.slice(1), 8n);
      } else {
        const n = BigInt(digits);
        value = n <= LONG_MAX ? n : Number(digits);
      }
    } else {
      this.unsupported(at);
    }
    this.i += text.length;
    // Direkt danach ein Name (z. B. 1abc) ist in PHP ein Syntaxfehler
    if (/[A-Za-z_\x80-\xff0-9]/.test(this.s[this.i] ?? '')) this.unsupported(at);
    return value;
  }
}

// Ziffern zur Basis: zu große Zahlen werden wie in PHP zur Kommazahl – Ziffer für Ziffer aufaddiert wie
// zend_hex_strtod (value * 16 + c) und zend_oct_strtod/zend_bin_strtod (value * 8 + c - '0': erst das Zeichen dazu,
// dann 48 weg – zweimal gerundet, wie in C)
function radix(digits, base) {
  const chars = digits.replace(/_/g, '');
  let n = 0n;
  for (const d of chars) n = n * base + BigInt(parseInt(d, 16));
  if (n <= LONG_MAX) return n;
  let f = 0;
  for (const d of chars) f = base === 16n ? f * 16 + parseInt(d, 16) : f * Number(base) + d.charCodeAt(0) - 48;
  return f;
}

// Codepoint → UTF-8 (wie PHP auch für Ersatzzeichen D800–DFFF)
function utf8Bytes(cp) {
  let bytes;
  if (cp < 0x80) bytes = [cp];
  else if (cp < 0x800) bytes = [0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)];
  else if (cp < 0x10000) bytes = [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
  else bytes = [0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
  return String.fromCharCode(...bytes);
}

// config.php lesen: der Wert hinter return (PHP-Werte: BigInt, Number, Buffer, Boolean, null, PhpArray)
export function parsePhpConfig(buf, name = 'config.php') {
  return new PhpReader(Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf8'), name).file();
}

// ---------------------------------------------------------------- PHP-Werte → JSON-Werte

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

function utf8(buf, what, name) {
  try {
    return STRICT_UTF8.decode(buf);
  } catch {
    throw new ConfigError(`${name}: ${what} isn’t valid UTF-8 text – save the file as UTF-8 and try again.`);
  }
}

// Listen werden zu Arrays, alles andere zu Map (die Reihenfolge der Schlüssel bleibt), Texte zu Strings
export function phpToJson(value, name = 'config.php', path = '') {
  if (value === null || typeof value === 'boolean' || typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ConfigError(`${name}: the value of “${path || 'the settings'}” is not a finite number.`);
    return value;
  }
  if (Buffer.isBuffer(value)) return utf8(value, `the value of “${path}”`, name);
  if (value instanceof PhpArray) {
    if (value.isList()) return value.entries.map(([, v], i) => phpToJson(v, name, path ? `${path}.${i}` : String(i)));
    const out = new Map();
    for (const [k, v] of value.entries) {
      const key = typeof k === 'bigint' ? k.toString() : utf8(k, `a key in “${path || 'the settings'}”`, name);
      out.set(key, phpToJson(v, name, path ? `${path}.${key}` : key));
    }
    return out;
  }
  throw new ConfigError(`${name}: unexpected value`);
}

// JSON.parse-Ergebnis → dieselbe Darstellung (Objekte als Map)
function fromParsed(value) {
  if (Array.isArray(value)) return value.map(fromParsed);
  if (value && typeof value === 'object') return new Map(Object.entries(value).map(([k, v]) => [k, fromParsed(v)]));
  return value;
}

// ---------------------------------------------------------------- JSON schreiben wie json_encode(JSON_PRETTY_PRINT |
// JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) in PHP

function jsonString(s) {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (c === 0x08) out += '\\b';
    else if (c === 0x0c) out += '\\f';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0d) out += '\\r';
    else if (c === 0x09) out += '\\t';
    else if (c < 0x20 || c === 0x2028 || c === 0x2029) out += '\\u' + c.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

// Kommazahlen wie PHP (serialize_precision -1): kürzeste Ziffern; ab 10^17 und unter 10^-4 mit Exponent (1.0e+20)
export function phpJsonFloat(x) {
  if (x === 0) return Object.is(x, -0) ? '-0' : '0';
  const sign = x < 0 ? '-' : '';
  const [mant, exp] = Math.abs(x).toExponential().split('e');
  const digits = mant.replace('.', '');
  const e = Number(exp);
  const decpt = e + 1;
  if (decpt < 0 ? decpt < -3 : decpt > 17) {
    return sign + digits[0] + '.' + (digits.slice(1) || '0') + 'e' + (e < 0 ? '-' : '+') + Math.abs(e);
  }
  if (decpt <= 0) return sign + '0.' + '0'.repeat(-decpt) + digits;
  if (digits.length <= decpt) return sign + digits + '0'.repeat(decpt - digits.length);
  return sign + digits.slice(0, decpt) + '.' + digits.slice(decpt);
}

export function encodeJson(value, indent = '') {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isSafeInteger(value) && !Object.is(value, -0) ? String(value) : phpJsonFloat(value);
  if (typeof value === 'string') return jsonString(value);
  const inner = indent + '    ';
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return '[\n' + value.map((v) => inner + encodeJson(v, inner)).join(',\n') + '\n' + indent + ']';
  }
  if (value instanceof Map) {
    if (!value.size) return '{}';
    return '{\n' + [...value].map(([k, v]) => inner + jsonString(k) + ': ' + encodeJson(v, inner)).join(',\n') + '\n' + indent + '}';
  }
  throw new ConfigError('unexpected value');
}

// ---------------------------------------------------------------- Dateien

function isPhpSource(buf) {
  return /^(\xef\xbb\xbf)?[ \t\r\n]*<\?php/i.test(buf.subarray(0, 64).toString('latin1'));
}

// Einstellungen aus config.json oder config.php (als Map); fehlt die Datei: null
export function loadSettings(file) {
  if (!existsSync(file)) return null;
  const buf = readFileSync(file);
  if (isPhpSource(buf)) {
    const value = parsePhpConfig(buf, basename(file));
    // Wie $load() im alten Installer: kein Array → keine Werte
    if (!(value instanceof PhpArray)) return new Map();
    const json = phpToJson(value, basename(file));
    return json instanceof Map ? json : new Map(json.map((v, i) => [String(i), v]));
  }
  let data;
  try {
    data = JSON.parse(utf8(buf, 'the file', basename(file)));
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`${basename(file)}: this isn’t valid JSON (${err.message}).`);
  }
  const value = fromParsed(data);
  return value instanceof Map ? value : new Map();
}

function groupId(name) {
  try {
    for (const line of readFileSync('/etc/group', 'utf8').split('\n')) {
      const [group, , gid] = line.split(':');
      if (group === name && /^\d+$/.test(gid ?? '')) return Number(gid);
    }
  } catch {
    // keine Gruppenliste
  }
  return null;
}

// Atomar schreiben: neue Datei im selben Ordner, Rechte setzen, auf die Platte, dann umbenennen.
// Als root gehört sie root:<group> (0640) – so liest sie nur der Webserver mit.
export function writeAtomic(file, text, { group = 'www-data', mode = 0o640, previous = PREVIOUS, current = file } = {}) {
  const dir = dirname(file);
  const tmp = join(dir, '.' + basename(file) + '.' + randomBytes(6).toString('hex'));
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    if (process.getuid && process.getuid() === 0) {
      const gid = group ? groupId(group) : 0;
      if (gid === null) throw new ConfigError(`the group ${group} doesn’t exist on this server.`);
      chownSync(tmp, 0, gid);
    }
    chmodSync(tmp, mode);
    if (previous && current) keepPrevious(current, previous, text);
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // schon weg
    }
    throw err;
  }
}

// Die vorige Fassung (nur wenn sie sich ändert) für den Notfall aufheben – nur root darf sie lesen. Klappt das nicht
// (z. B. ohne root beim Entwickeln), nur ein Hinweis: die neuen Einstellungen werden trotzdem geschrieben.
function keepPrevious(current, previous, text) {
  try {
    if (!existsSync(current)) return;
    const old = readFileSync(current);
    if (isPhpSource(old) || old.equals(Buffer.from(text, 'utf8'))) return;
    mkdirSync(dirname(previous), { recursive: true, mode: 0o700 });
    const keep = previous + '.' + randomBytes(6).toString('hex');
    writeFileSync(keep, old, { mode: 0o600, flag: 'wx' });
    renameSync(keep, previous);
  } catch (err) {
    process.stderr.write(`config.mjs: the previous settings couldn’t be kept in ${previous} (${err.code ?? err.message}).\n`);
  }
}

// Wert unter einem Punkt-Schlüssel (db.pass)
function getPath(map, key) {
  let value = map;
  for (const part of key.split('.')) {
    if (!(value instanceof Map) || !value.has(part)) return undefined;
    value = value.get(part);
  }
  return value;
}

function setPath(map, key, value) {
  const parts = key.split('.');
  let node = map;
  for (const part of parts.slice(0, -1)) {
    if (!(node.get(part) instanceof Map)) node.set(part, new Map());
    node = node.get(part);
  }
  node.set(parts[parts.length - 1], value);
}

// (string) $value wie PHP für die Prüfung „leer?“
function phpStringish(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value === true) return '1';
  if (typeof value === 'object') return 'Array';
  return String(value);
}

// Ausgabe eines Werts wie echo in PHP (true = 1, false/null = leer); Listen und Objekte: leer
function echoValue(value) {
  if (value === null || value === undefined || value === false || typeof value === 'object') return '';
  if (value === true) return '1';
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return phpJsonFloat(value).replace('e', 'E');
  return String(value);
}

// ---------------------------------------------------------------- Befehle

// Die Einstellungen, die der Installer schreibt (write_config der PHP-Version + node_port, client_ip_header)
export function buildConfig({ current = null, imported = null, domain, uploads, dbName, dbUser, dbPass = '', botSecret = '' }) {
  const cfg = new Map([
    ['db', new Map()],
    ['aes_key', ''],
    ['app_secret', ''],
    ['base_domain', domain],
    ['scheme', 'https'],
    ['timezone', 'Europe/Berlin'],
    ['max_pages', 3],
    ['cron_secret', ''],
    ['bot_secret', ''],
    ['debug', false],
  ]);
  // array_replace(): oberste Ebene, spätere Quellen gewinnen
  for (const source of [current, imported]) {
    if (source) for (const [k, v] of source) cfg.set(k, v);
  }
  if (phpStringish(cfg.get('aes_key')) === '') cfg.set('aes_key', randomBytes(16).toString('hex'));
  if (phpStringish(cfg.get('app_secret')) === '') cfg.set('app_secret', randomBytes(32).toString('hex'));
  if (botSecret !== '') cfg.set('bot_secret', botSecret);
  cfg.set('db', new Map([['host', 'localhost'], ['name', dbName], ['user', dbUser], ['pass', dbPass]]));
  cfg.set('base_domain', domain);
  cfg.set('scheme', 'https');
  cfg.set('uploads_dir', uploads);
  // Node: Port hinter Apache (ein eigener Wert bleibt) und der Kopf mit der Besucher-Adresse, den Apache setzt
  const port = cfg.get('node_port');
  if (!(typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536)) cfg.set('node_port', 3000);
  cfg.set('client_ip_header', 'x-oys-client-ip');
  return cfg;
}

function parseArgs(argv, flags, valueFlags) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valueFlags.includes(a)) {
      if (i + 1 >= argv.length) throw new ConfigError(`${a} needs a value.`);
      out[a.slice(2)] = argv[++i];
    } else if (flags.includes(a)) {
      out[a.slice(2)] = true;
    } else if (a.startsWith('--')) {
      throw new ConfigError(`unknown option ${a}`);
    } else {
      out._.push(a);
    }
  }
  return out;
}

// Eine Zeile von der Eingabe (Terminal oder Pipe), ohne Zeilenende und Leerraum außen; nichts davon wird ausgegeben
function stdinLine() {
  const buf = Buffer.alloc(4096);
  let line = Buffer.alloc(0);
  for (;;) {
    let n;
    try {
      n = readSync(0, buf, 0, buf.length, null);
    } catch (err) {
      if (err.code === 'EAGAIN') continue;
      if (err.code === 'EOF') break;
      throw err;
    }
    if (n === 0) break;
    line = Buffer.concat([line, buf.subarray(0, n)]);
    const nl = line.indexOf(10);
    if (nl >= 0) {
      line = line.subarray(0, nl);
      break;
    }
  }
  return line.toString('utf8').replace(/^[ \t\r]+|[ \t\r]+$/g, '');
}

function loadExisting(file) {
  const settings = loadSettings(file);
  if (!settings) throw new ConfigError(`${file} doesn’t exist.`);
  return settings;
}

function defaultFile() {
  const json = join(ROOT, 'config.json');
  const php = join(ROOT, 'config.php');
  return !existsSync(json) && existsSync(php) ? php : json;
}

export function main(argv, env = process.env, out = process.stdout) {
  const [command, ...rest] = argv;
  switch (command) {
    case 'write': {
      const a = parseArgs(rest, [], ['--file', '--current', '--import', '--domain', '--uploads', '--db-name', '--db-user', '--previous', '--group']);
      for (const need of ['domain', 'uploads', 'db-name', 'db-user']) if (!a[need]) throw new ConfigError(`write needs --${need}.`);
      const file = resolve(a.file ?? join(ROOT, 'config.json'));
      // Bisherige Werte: config.json, sonst die config.php daneben
      let currentFile = a.current ? resolve(a.current) : file;
      if (!a.current && !existsSync(file) && existsSync(join(dirname(file), 'config.php'))) currentFile = join(dirname(file), 'config.php');
      const cfg = buildConfig({
        current: loadSettings(currentFile),
        imported: a.import ? loadExisting(resolve(a.import)) : null,
        domain: a.domain,
        uploads: a.uploads,
        dbName: a['db-name'],
        dbUser: a['db-user'],
        dbPass: env.OYS_DB_PASS ?? '',
        botSecret: env.OYS_BOT_SECRET ?? '',
      });
      writeAtomic(file, encodeJson(cfg) + '\n', { group: a.group ?? 'www-data', previous: a.previous ?? env.OYS_CONFIG_PREVIOUS ?? PREVIOUS, current: currentFile });
      return 0;
    }
    case 'get': {
      const a = parseArgs(rest, [], ['--file']);
      if (a._.length !== 1) throw new ConfigError('usage: config.mjs get <key> [--file F]');
      const settings = loadSettings(resolve(a.file ?? defaultFile()));
      out.write(settings ? echoValue(getPath(settings, a._[0])) : '');
      return 0;
    }
    case 'set': {
      const a = parseArgs(rest, ['--json', '--stdin'], ['--file', '--group']);
      if (a._.length < 1 || a._.length > 2 || (a.stdin && a._.length !== 1)) throw new ConfigError('usage: config.mjs set <key> [value | --stdin] [--json] [--file F]');
      const file = resolve(a.file ?? join(ROOT, 'config.json'));
      const settings = existsSync(file) && !isPhpSource(readFileSync(file)) ? loadSettings(file) : null;
      if (!settings) throw new ConfigError(`${file} doesn’t exist yet – run the installer first.`);
      const raw = a.stdin ? stdinLine() : a._.length === 2 ? a._[1] : env.OYS_VALUE;
      if (raw === undefined || (a.stdin && raw === '')) throw new ConfigError('no value given (argument, --stdin or OYS_VALUE).');
      let value = raw;
      if (a.json) {
        try {
          value = fromParsed(JSON.parse(raw));
        } catch {
          throw new ConfigError('the value isn’t valid JSON.');
        }
      }
      setPath(settings, a._[0], value);
      writeAtomic(file, encodeJson(settings) + '\n', { group: a.group ?? 'www-data', previous: env.OYS_CONFIG_PREVIOUS ?? PREVIOUS });
      return 0;
    }
    case 'reset-keys': {
      const a = parseArgs(rest, [], ['--file', '--group']);
      const file = resolve(a.file ?? join(ROOT, 'config.json'));
      const settings = loadSettings(file);
      if (!settings) throw new ConfigError(`${file} doesn’t exist.`);
      // Neue Schlüssel macht der Installer gleich danach – bot_secret bleibt (den hat der Bot auch)
      for (const k of ['aes_key', 'app_secret', 'cron_secret']) settings.delete(k);
      writeAtomic(file, encodeJson(settings) + '\n', { group: a.group ?? 'www-data', previous: env.OYS_CONFIG_PREVIOUS ?? PREVIOUS });
      return 0;
    }
    case 'from-php': {
      const a = parseArgs(rest, [], []);
      if (a._.length !== 1) throw new ConfigError('usage: config.mjs from-php <config.php>');
      const file = resolve(a._[0]);
      if (!existsSync(file)) throw new ConfigError(`${a._[0]} doesn’t exist.`);
      const value = parsePhpConfig(readFileSync(file), basename(file));
      if (!(value instanceof PhpArray)) throw new ConfigError(`No settings in ${a._[0]}`);
      out.write(encodeJson(phpToJson(value, basename(file))) + '\n');
      return 0;
    }
    default:
      throw new ConfigError('usage: config.mjs write | get | set | reset-keys | from-php (see the top of this file)');
  }
}

// Als Befehl aufgerufen (nicht beim Import in Tests)
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    process.stderr.write(`config.mjs: ${err.message}\n`);
    process.exitCode = 1;
  }
}
