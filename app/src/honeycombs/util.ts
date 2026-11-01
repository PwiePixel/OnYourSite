// Bausteine für Honigwaben und Code-Seiten: Abfragen über den Pool als Db (wie eine feste Verbindung aus db.ts) und
// json_decode()/(int) mit den Regeln von PHP (Zahlentypen, Tiefe, einzelne UTF-16-Ersatzzeichen, Überlauf).
import { exec, one, q, value, type Db } from '../db.js';
import { intval, isNumeric } from '../php.js';

// Einzelne Abfragen über den Pool – dieselbe Form wie die Verbindung in withConnection(), damit eine Funktion in
// einer Sperre oder Transaktion (feste Verbindung) und außerhalb (Pool) gleich laufen kann
export const poolDb: Db = { q, one, value, exec };

// ---------------------------------------------------------------- json_decode($raw, true)

// Zahl aus JSON mit PHP-Typ: ganze Zahlen im 64-Bit-Bereich bleiben int, alles andere wird float
export class PhpNumber {
  constructor(readonly source: string, readonly value: number, readonly isInt: boolean) {}
  // (int) $zahl: float außerhalb des Bereichs wird wie in PHP modulo 2^64 umgerechnet, INF/NAN → 0
  toInt(): number {
    return this.isInt ? Number(BigInt(this.source)) : phpInt(this.value);
  }
}

// (int) $v wie PHP 8.3 auch bei Überlauf (für Formular- und JSON-Werte): Kommazahlen außerhalb von 64 Bit modulo 2^64,
// Text bleibt bei ±2^63 stehen, „1e400“ (unendlich) wird 0, leeres Array 0. Sonst wie intval() aus php.ts.
export function phpInt(v: unknown): number {
  if (v instanceof PhpNumber) return v.toInt();
  if (typeof v === 'number') return !Number.isFinite(v) ? 0 : Math.abs(v) < 2 ** 63 ? Math.trunc(v) + 0 : Number(BigInt.asIntN(64, BigInt(v)));
  if (typeof v === 'string') {
    const m = /^[ \t\n\v\f\r]*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(v);
    const n = m ? Number(m[1]) : 0;
    // + 0: aus "-0" wird 0 (PHP kennt keine negative Null bei ganzen Zahlen)
    return Number.isFinite(n) ? Math.max(-(2 ** 63), Math.min(2 ** 63, Math.trunc(n))) + 0 : 0;
  }
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) return Object.keys(v).length ? 1 : 0;
  return intval(v);
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// Wie json_decode($raw, true): null bei leerem Text, Fehlern, einzelnen Ersatzzeichen (\ud800) und mehr als 511
// verschachtelten Ebenen. Mit numbers = true kommen Zahlen als PhpNumber (sonst als JS-Zahl).
export function phpJsonDecode(raw: string, numbers = false): unknown {
  if (raw === '') return null;
  let data: unknown;
  try {
    data = JSON.parse(raw, (_k, v, ctx?: { source?: string }) => {
      if (!numbers || typeof v !== 'number') return v;
      const src = ctx?.source ?? String(v);
      const isInt = /^-?\d+$/.test(src) && BigInt(src) >= INT64_MIN && BigInt(src) <= INT64_MAX;
      return new PhpNumber(src, v, isInt);
    });
  } catch {
    return null;
  }
  if (nestingDepth(raw) > 511 || hasLoneSurrogate(data)) return null;
  return data;
}

function hasLoneSurrogate(v: unknown): boolean {
  if (typeof v === 'string') return LONE_SURROGATE.test(v);
  if (Array.isArray(v)) return v.some(hasLoneSurrogate);
  if (v && typeof v === 'object' && !(v instanceof PhpNumber)) {
    return Object.entries(v).some(([k, x]) => LONE_SURROGATE.test(k) || hasLoneSurrogate(x));
  }
  return false;
}

// Tiefste Verschachtelung von [ und { (Text in Anführungszeichen zählt nicht)
function nestingDepth(raw: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === '[' || c === '{') {
      max = Math.max(max, ++depth);
    } else if (c === ']' || c === '}') {
      depth--;
    }
  }
  return max;
}

// is_numeric() für Werte aus json_decode (Zahlen sind immer numerisch, auch INF)
export function jsonIsNumeric(v: unknown): boolean {
  if (v instanceof PhpNumber || typeof v === 'number') return true;
  return typeof v === 'string' && isNumeric(v);
}

// (int) für Werte aus json_decode
export const jsonInt = phpInt;

// ---------------------------------------------------------------- Pfade

// pathinfo($path, PATHINFO_EXTENSION): Text nach dem letzten Punkt des letzten Pfad-Teils, sonst ''
export function pathExtension(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === '/') end--;
  const base = path.slice(path.lastIndexOf('/', end - 1) + 1, end);
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1) : '';
}
