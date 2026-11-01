// HTML sicher zusammensetzen: html`…${wert}…` maskiert jeden eingesetzten Wert wie e() in PHP
// (htmlspecialchars mit ENT_QUOTES). Fertiges HTML (andere Vorlagen, raw()) wird unverändert eingesetzt.

export class SafeHtml {
  constructor(public readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };

// e(): wie htmlspecialchars((string) $v, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8')
export function e(value: unknown): string {
  return phpString(value).replace(/[&<>"']/g, (c) => ESC[c]);
}

// (string) $v in PHP: null → '', true → '1', false → '', Zahlen ohne Exponent wie PHP
export function phpString(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  if (value === true) return '1';
  if (typeof value === 'number') return phpNumberString(value);
  if (value instanceof SafeHtml) return value.value;
  return String(value);
}

export function phpNumberString(n: number): string {
  if (Number.isInteger(n)) return String(n);
  // PHP 8: Gleitkommazahlen mit bis zu 17 signifikanten Stellen, kürzeste Darstellung
  return String(n);
}

export function raw(value: string): SafeHtml {
  return new SafeHtml(value);
}

type Part = SafeHtml | string | number | boolean | null | undefined | Part[];

function render(part: Part): string {
  if (part === null || part === undefined || part === false) return '';
  if (part instanceof SafeHtml) return part.value;
  if (Array.isArray(part)) return part.map(render).join('');
  return e(part);
}

export function html(strings: TemplateStringsArray, ...values: Part[]): SafeHtml {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

// Liste von Teilen ohne Trenner (z. B. aus .map())
export function join(parts: Part[], separator = ''): SafeHtml {
  return new SafeHtml(parts.map(render).join(separator));
}

// json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
export function jsonUnescaped(value: unknown): string {
  return phpJson(value, { unescapedSlashes: true, unescapedUnicode: true });
}

// json_encode() mit den PHP-Optionen: ohne JSON_UNESCAPED_SLASHES wird / zu \/, ohne JSON_UNESCAPED_UNICODE
// werden alle Zeichen über 0x7F zu \uXXXX; JSON_HEX_TAG/AMP/APOS/QUOT für Daten in HTML
export interface JsonFlags {
  unescapedSlashes?: boolean;
  unescapedUnicode?: boolean;
  hexTag?: boolean;
  hexAmp?: boolean;
  hexApos?: boolean;
  hexQuot?: boolean;
}

export function phpJson(value: unknown, flags: JsonFlags = {}): string {
  let s = JSON.stringify(value, (_k, v) => (v === undefined ? null : v));
  if (s === undefined) s = 'null';
  if (!flags.unescapedSlashes) s = s.replace(/\//g, '\\/');
  if (!flags.unescapedUnicode) {
    s = s.replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  } else {
    // PHP maskiert U+2028/U+2029 auch mit JSON_UNESCAPED_UNICODE (außer mit JSON_UNESCAPED_LINE_TERMINATORS)
    s = s.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  }
  if (flags.hexTag) s = s.replace(/</g, '\\u003C').replace(/>/g, '\\u003E');
  if (flags.hexAmp) s = s.replace(/&/g, '\\u0026');
  if (flags.hexApos) s = s.replace(/'/g, '\\u0027');
  if (flags.hexQuot) s = s.replace(/\\"/g, '\\u0022');
  // PHP schreibt Steuerzeichen wie JSON.stringify (\n, \t, \u0000 …) – nur \u007f wird oben behandelt
  return s;
}
