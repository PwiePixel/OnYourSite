// PHP-Regeln für Werte unbekannten Typs (Daten aus json_decode, Einstellungen) – gebraucht von render.ts und share.ts:
// Zugriff ohne ??, Typumwandlung bei string-Parametern, Rechnen mit Text, round() von PHP 8.3 und Kommazahlen in
// json_encode()
import { phpFloatToString, phpStr } from '../php.js';
import { entries, isArr, own, phpArray } from './util.js';

// $a['key'] ohne ??: Arrays liefern den Wert (fehlt er: null), Text wirft wie PHP 8 einen TypeError, alles andere null
export function idx(v: unknown, key: string): unknown {
  if (typeof v === 'string') throw new TypeError('Cannot access offset of type string on string');
  return own(v, key) ?? null;
}

// Wert für einen string-Parameter einer PHP-Funktion (ohne strict_types): Zahlen und Wahrheitswerte werden Text,
// null und Arrays sind ein TypeError
export function strArg(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return phpStr(v);
  throw new TypeError('Argument must be of type string, ' + (v === null || v === undefined ? 'null' : 'array') + ' given');
}

// Dasselbe für ?string: null bleibt erlaubt
export const nullableStrArg = (v: unknown): string | null => (v === null || v === undefined ? null : strArg(v));

// Wert in einer Rechnung wie PHP 8: Zahl, null/false → 0, true → 1, Text mit Zahl am Anfang (Rest wird ignoriert),
// sonst (anderer Text, Arrays) TypeError. "-0" ist in PHP die ganze Zahl 0 (nur "-0.0" o. ä. ist die Kommazahl -0).
export function phpNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (v === null || v === undefined || v === false) return 0;
  if (v === true) return 1;
  if (typeof v === 'string') {
    const m = /^[ \t\n\r\v\f]*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(v);
    if (m) return m[2] === undefined && m[3] === undefined && !m[1].startsWith('.') ? Number(m[0]) || 0 : Number(m[0]);
  }
  throw new TypeError('Unsupported operand types');
}

// (string) einer Kommazahl (z. B. das Ergebnis von round()): auch ganzzahlige Werte mit 14 Stellen (1.0E+14), -0 bleibt "-0"
export const phpFloatStr = (v: number): string => phpFloatToString(v);

// ---------------------------------------------------------------- json_encode() mit Kommazahlen wie PHP

// Kommazahl in json_encode() (serialize_precision = -1, php_gcvt mit 17 Stellen): dieselbe kürzeste Ziffernfolge
// wie JavaScript, aber mit Exponent schon unter 1e-4 und ab 1e17, immer mit Nachkommastelle („1.0e-5“, „1.0e+21“),
// und -0 bleibt „-0“
export function phpJsonFloat(v: number): string {
  const [mant, exp] = Math.abs(v).toExponential().split('e');
  const digits = mant.replace('.', '');
  let decpt = Number(exp) + 1;
  const sign = v < 0 || Object.is(v, -0) ? '-' : '';
  if (decpt < 0 ? decpt < -3 : decpt > 17) {
    decpt--;
    return sign + digits[0] + '.' + (digits.length > 1 ? digits.slice(1) : '0') + 'e' + (decpt < 0 ? '-' : '+') + Math.abs(decpt);
  }
  if (decpt < 0) return sign + '0.' + '0'.repeat(-decpt) + digits;
  if (digits.length <= decpt) return sign + digits + '0'.repeat(decpt - digits.length);
  return sign + (decpt === 0 ? '0' : digits.slice(0, decpt)) + '.' + digits.slice(decpt);
}

// json_encode() scheitert an INF und NAN (gibt false zurück)
export class JsonEncodeError extends Error {}

// Zahl, die in PHP sicher eine Kommazahl ist, auch wenn sie ganzzahlig ist (z. B. ein Ergebnis von / ab 1e17)
export class PhpFloat {
  constructor(readonly value: number) {}
}

const rawJson = (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON;

// Wert für phpJson(), in dem Kommazahlen wie bei json_encode() stehen. Als Kommazahl gilt PhpFloat und, was in PHP
// keine ganze Zahl sein kann: nicht ganzzahlig, -0 oder ab 2^63. Ganze Zahlen darunter bleiben, wie sie sind (aus
// json_decode() kommt dort nur selten eine Kommazahl, z. B. 1e17 – die schreibt PHP als „1.0e+17“).
// Reihenfolge der Schlüssel bleibt; bei INF/NAN JsonEncodeError.
export function withPhpFloats(v: unknown): unknown {
  if (typeof v === 'number' || v instanceof PhpFloat) {
    const n = typeof v === 'number' ? v : v.value;
    if (!Number.isFinite(n)) throw new JsonEncodeError('Inf and NaN cannot be JSON encoded');
    return v instanceof PhpFloat || Object.is(n, -0) || !Number.isInteger(n) || Math.abs(n) >= 2 ** 63 ? rawJson(phpJsonFloat(n)) : n;
  }
  if (Array.isArray(v)) return v.map(withPhpFloats);
  if (isArr(v)) return phpArray(entries(v).map(([k, x]): [string, unknown] => [k, withPhpFloats(x)]));
  return v;
}

// ---------------------------------------------------------------- round() aus PHP 8.3 (ext/standard/math.c)

const POW10 = [1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22];
const LOG_STEPS = [1e-8, 1e-7, 1e-6, 1e-5, 1e-4, 1e-3, 1e-2, 1e-1, 1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14,
  1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22];

// php_intlog10abs(): floor(log10(|v|)) per binärer Suche
function intlog10abs(value: number): number {
  const v = Math.abs(value);
  if (v < 1e-8 || v > 1e22) return Math.floor(Math.log10(v));
  let r = 15;
  r += v < LOG_STEPS[r] ? -8 : 8;
  r += v < LOG_STEPS[r] ? -4 : 4;
  r += v < LOG_STEPS[r] ? -2 : 2;
  r += v < LOG_STEPS[r] ? -1 : 1;
  if (v < LOG_STEPS[r]) r -= 1;
  return r - 8;
}

const intpow10 = (p: number): number => (p < 0 || p > 22 ? Math.pow(10, p) : POW10[p]);

// php_round_helper() mit PHP_ROUND_HALF_UP
const roundHelper = (v: number): number => (v >= 0 ? Math.floor(v + 0.5) : Math.ceil(v - 0.5));

// _php_math_round(): erst auf 15 gültige Stellen vorrunden, dann runden (0.285 → 0.29, 2.5 → 3, -2.5 → -3)
export function phpRound(value: number, places = 0): number {
  if (!Number.isFinite(value) || value === 0) return value;
  const precisionPlaces = 14 - intlog10abs(value);
  const f1 = intpow10(Math.abs(places));
  let tmp: number;
  if (precisionPlaces > places && precisionPlaces - 15 < places) {
    let f2 = intpow10(Math.abs(precisionPlaces));
    tmp = roundHelper(precisionPlaces >= 0 ? value * f2 : value / f2);
    f2 = intpow10(Math.abs(places - precisionPlaces));
    tmp = tmp / f2;
  } else {
    tmp = places >= 0 ? value * f1 : value / f1;
    if (Math.abs(tmp) >= 1e15) return value;
  }
  tmp = roundHelper(tmp);
  return places > 0 ? tmp / f1 : tmp * f1;
}
