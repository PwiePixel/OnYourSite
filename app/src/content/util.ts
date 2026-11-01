// PHP-Arrays aus json_decode(…, true) und was dazugehört: feste Reihenfolge der Schlüssel, Zugriff nur auf eigene
// Schlüssel, basename() und Ortszeit wie new DateTimeImmutable($s, $tz). Gebraucht von Blöcken, Seiten und Teilen.
import { timeZone } from '../db.js';
import { intval } from '../php.js';

// Ein PHP-Array: Liste (Schlüssel 0, 1, 2 …) oder Objekt
export type PhpArr = Record<string, unknown> | unknown[];

// is_array()
export const isArr = (v: unknown): v is PhpArr => typeof v === 'object' && v !== null && !Buffer.isBuffer(v);

// $a['key'] (bzw. ?? null): nur eigene Schlüssel – nie "constructor", "length" o. ä. aus dem Prototyp
export function own(v: unknown, key: string): unknown {
  return isArr(v) && Object.hasOwn(v, key) ? (v as Record<string, unknown>)[key] : undefined;
}

// foreach ($a as $v)
export const values = (v: unknown): unknown[] => (Array.isArray(v) ? v : isArr(v) ? Object.values(v) : []);

// foreach ($a as $k => $v)
export const entries = (v: unknown): Array<[string, unknown]> =>
  Array.isArray(v) ? v.map((x, i): [string, unknown] => [String(i), x]) : isArr(v) ? Object.entries(v) : [];

// Eigenschaft anlegen, auch "__proto__" (eine Zuweisung würde dort den Prototyp ändern)
function put(o: Record<string, unknown>, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });
}

// Schlüssel, die JavaScript in Objekten immer nach vorn sortiert (0 … 2^32-2)
const isIndexKey = (k: string): boolean => /^(?:0|[1-9]\d{0,9})$/.test(k) && Number(k) < 4294967295;

// Objekt, das seine Schlüssel in der gegebenen Reihenfolge aufzählt (JSON.stringify, Object.keys, for … in)
function ordered(target: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return new Proxy(target, {
    ownKeys: () => [...keys],
    defineProperty(t, k, desc) {
      if (typeof k === 'string' && !Object.hasOwn(t, k)) keys.push(k);
      return Reflect.defineProperty(t, k, desc);
    },
    deleteProperty(t, k) {
      const i = typeof k === 'string' ? keys.indexOf(k) : -1;
      if (i >= 0) keys.splice(i, 1);
      return Reflect.deleteProperty(t, k);
    },
  });
}

// PHP-Array aus Schlüssel/Wert-Paaren: 0, 1, 2 … in dieser Reihenfolge wird eine Liste (wie bei json_encode),
// sonst ein Objekt in PHP-Reihenfolge. Doppelte Schlüssel: der letzte Wert an der ersten Stelle.
export function phpArray(pairs: Iterable<readonly [string, unknown]>): PhpArr {
  const keys: string[] = [];
  const target: Record<string, unknown> = {};
  for (const [k, v] of pairs) {
    if (!Object.hasOwn(target, k)) keys.push(k);
    put(target, k, v);
  }
  if (keys.every((k, i) => k === String(i))) return keys.map((k) => target[k]);
  // Ein normales Objekt nur, wenn JavaScript die Reihenfolge nicht umstellt
  let other = false;
  let last = -1;
  for (const k of keys) {
    if (!isIndexKey(k)) other = true;
    else if (other || Number(k) < last) return ordered(target, keys);
    else last = Number(k);
  }
  return target;
}

// (object) $a: Listen werden Objekte mit den Schlüsseln "0", "1" …
export function toObject(v: unknown): Record<string, unknown> {
  if (Array.isArray(v)) return Object.fromEntries(v.map((x, i) => [String(i), x]));
  return isArr(v) ? (v as Record<string, unknown>) : {};
}

// array_replace(): vorhandene Schlüssel bekommen den neuen Wert an ihrer Stelle, neue kommen hinten dazu
export function arrayReplace(base: PhpArr, ...replacements: PhpArr[]): PhpArr {
  const pairs = entries(base);
  const index = new Map(pairs.map(([k], i) => [k, i]));
  for (const r of replacements) {
    for (const [k, v] of entries(r)) {
      const i = index.get(k);
      if (i !== undefined) {
        pairs[i] = [k, v];
      } else {
        index.set(k, pairs.length);
        pairs.push([k, v]);
      }
    }
  }
  return phpArray(pairs);
}

// Schlüssel eines PHP-Arrays ($a[$v] = …) als Text; ein Array als Schlüssel ist in PHP ein Fehler
export function arrayKey(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(intval(v));
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v === null || v === undefined) return '';
  throw new TypeError('Illegal offset type');
}

// ---------------------------------------------------------------- json_decode($text, true)

class JsonError extends Error {}

// null bei jedem Fehler. Wie PHP: Objekte werden PHP-Arrays (Reihenfolge bleibt; {} und {"0":…,"1":…} sind Listen),
// höchstens 511 Ebenen, einzelne UTF-16-Ersatzzeichen (\ud800) sind ungültig, ganze Zahlen sind int ("-0" → 0).
// Ganze Zahlen über 2^53 verlieren wie jede JavaScript-Zahl Stellen. Auch für Anfragen an den Editor gedacht
// ($input = json_decode($raw, true)), damit blockNormalize()/savePage() dieselben Werte sehen wie in PHP –
// dafür die Bytes der Anfrage übergeben: ungültiges UTF-8 ist dann wie in PHP ein Fehler (Buffer.toString() würde
// es still durch U+FFFD ersetzen), ein BOM am Anfang bleibt stehen und ist wie in PHP ein Syntaxfehler.
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export function jsonDecode(text: string | Uint8Array): unknown {
  let s: string;
  try {
    s = typeof text === 'string' ? text : strictUtf8.decode(text);
  } catch {
    return null;
  }
  try {
    return parseJson(s);
  } catch (err) {
    if (err instanceof JsonError || err instanceof RangeError) return null;
    throw err;
  }
}

const MAX_NESTING = 511;
const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
const NUMBER = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;

function parseJson(s: string): unknown {
  let i = 0;
  const fail = (): never => {
    throw new JsonError();
  };
  const ws = (): void => {
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
      i++;
    }
  };
  const hex4 = (): number => {
    const h = s.slice(i, i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(h)) fail();
    i += 4;
    return parseInt(h, 16);
  };
  const str = (): string => {
    i++; // "
    let out = '';
    let start = i;
    for (;;) {
      if (i >= s.length) fail();
      const c = s.charCodeAt(i);
      if (c === 0x22) {
        out += s.slice(start, i);
        i++;
        return out;
      }
      if (c === 0x5c) {
        out += s.slice(start, i);
        const e = s[i + 1];
        i += 2;
        if (e === 'u') {
          const u = hex4();
          if (u >= 0xd800 && u <= 0xdbff) {
            if (s[i] !== '\\' || s[i + 1] !== 'u') fail();
            i += 2;
            const low = hex4();
            if (low < 0xdc00 || low > 0xdfff) fail();
            out += String.fromCharCode(u, low);
          } else if (u >= 0xdc00 && u <= 0xdfff) {
            fail();
          } else {
            out += String.fromCharCode(u);
          }
        } else {
          if (e === undefined || !Object.hasOwn(ESCAPES, e)) fail();
          out += ESCAPES[e];
        }
        start = i;
        continue;
      }
      if (c < 0x20) fail();
      // Ersatzzeichen nur als Paar (sonst wäre es in PHP ungültiges UTF-8)
      if (c >= 0xd800 && c <= 0xdfff) {
        const d = s.charCodeAt(i + 1);
        if (c > 0xdbff || !(d >= 0xdc00 && d <= 0xdfff)) fail();
        i += 2;
        continue;
      }
      i++;
    }
  };
  const value = (depth: number): unknown => {
    ws();
    const c = s[i];
    if (c === '{' || c === '[') {
      if (depth > MAX_NESTING) fail();
      i++;
      ws();
      const close = c === '{' ? '}' : ']';
      const pairs: Array<[string, unknown]> = [];
      const list: unknown[] = [];
      if (s[i] === close) {
        i++;
        return c === '{' ? phpArray(pairs) : list;
      }
      for (;;) {
        if (c === '{') {
          ws();
          if (s[i] !== '"') fail();
          const k = str();
          ws();
          if (s[i] !== ':') fail();
          i++;
          pairs.push([k, value(depth + 1)]);
        } else {
          list.push(value(depth + 1));
        }
        ws();
        if (s[i] === ',') {
          i++;
          continue;
        }
        if (s[i] === close) {
          i++;
          return c === '{' ? phpArray(pairs) : list;
        }
        fail();
      }
    }
    if (c === '"') return str();
    if (s.startsWith('true', i)) {
      i += 4;
      return true;
    }
    if (s.startsWith('false', i)) {
      i += 5;
      return false;
    }
    if (s.startsWith('null', i)) {
      i += 4;
      return null;
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(s);
    if (!m) fail();
    i += m![0].length;
    const n = Number(m![0]);
    // Ganze Zahl: in PHP int, ein „-0“ gibt es dort nicht
    return m![1] === undefined && m![2] === undefined && n === 0 ? 0 : n;
  };
  const out = value(1);
  ws();
  if (i !== s.length) fail();
  return out;
}

// ---------------------------------------------------------------- Dateinamen und Zeit

// basename(): letzter Teil nach „/“ (Schrägstriche am Ende zählen nicht)
export function basename(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === '/') end--;
  return s.slice(s.lastIndexOf('/', end - 1) + 1, end);
}

const eraFormats = new Map<string, Intl.DateTimeFormat>();

// Zeitpunkt (ms) als Ortszeit, zurückgerechnet in ms „als wäre es UTC“ – mit Jahr 0 (1 v. Chr.) wie PHP
function wallMs(ms: number, tz: string): number {
  let f = eraFormats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', era: 'short', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    eraFormats.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  const year = p.era === 'BC' ? 1 - Number(p.year) : Number(p.year);
  return utcMs(year, Number(p.month), Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
}

// Date.UTC für alle Jahre (Date.UTC macht aus 0–99 die Jahre 1900–1999); Überläufe wie mktime
function utcMs(y: number, mo: number, d: number, h: number, mi: number, sec: number): number {
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  t.setUTCHours(h, mi, sec, 0);
  return t.getTime();
}

const offsetMs = (ms: number, tz: string): number => wallMs(ms, tz) - Math.floor(ms / 1000) * 1000;

// Ortszeit → Unix-Sekunden wie PHP: in der Lücke der Zeitumstellung gilt der Abstand davor (02:30 → 03:30 Sommerzeit),
// in der doppelten Stunde der danach; vor 1893 die Ortszeit (LMT) der Zeitzone
export function localToUnix(y: number, mo: number, d: number, h = 0, mi = 0, sec = 0, tz = timeZone()): number {
  const naive = utcMs(y, mo, d, h, mi, sec);
  const o1 = offsetMs(naive, tz);
  const o2 = offsetMs(naive - o1, tz);
  return (naive - (o1 === o2 ? o1 : o2)) / 1000;
}

// new DateTimeImmutable('2026-05-01T18:00', $tz) → Unix-Sekunden. Nur diese Form wird gespeichert (Zeitsteuerung,
// Countdown). PHP rechnet Monat 00, Tag 00–31 und Stunde 24 weiter und wirft bei größeren Werten – wir auch.
export function parseLocalDateTime(s: string, tz = timeZone()): number {
  const m = /^[ \t\n]*(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})[ \t\n]*$/.exec(s);
  const [y, mo, d, h, mi] = m ? m.slice(1).map(Number) : [];
  if (!m || mo > 12 || d > 31 || h > 24 || mi > 59) throw new Error(`Failed to parse time string (${s})`);
  return localToUnix(y, mo, d, h, mi, 0, tz);
}
