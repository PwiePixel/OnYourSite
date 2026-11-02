// Eigenes CSS der Nutzer (lib/pages.php: oys_clean_css) – kann nicht aus <style> ausbrechen und lädt nichts von
// fremden Servern (url(), @import, image-set() nur mit eigenen Pfaden oder data:), auch nicht mit Escapes wie u\72l(.
// Wie in PHP wird byteweise gearbeitet: Der Text läuft als „Binärtext“ (ein Zeichen = ein Byte) durch die Schleife.
import { mbSubstr, phpTrim } from './php.js';

const URL_FUNCTIONS = ['url', 'image', 'image-set', '-webkit-image-set', 'cross-fade', '-webkit-cross-fade', 'src'];
// \s von PCRE ohne /u: nur ASCII-Leerraum (JS-\s würde auch das Byte 0xA0 erfassen)
const isWs = (c: number): boolean => c === 0x20 || (c >= 0x09 && c <= 0x0d);

// url(…) ohne Anführungszeichen ab der „(“ an Stelle i – dieselben Treffer wie das PHP-Muster
// /\G\(\s*([^\s"')][^)]*?)\s*(?:\)|\z)/: Wert vom ersten Zeichen ohne Leerraum bis vor den Leerraum vor der ersten „)“
// (ohne „)“: bis zum Ende des Texts). Als regulärer Ausdruck brauchte V8 für eine lange Leerraum-Folge im Wert
// quadratische Zeit (20 000 Leerzeichen: eine Sekunde – bei jedem Speichern und bei jedem Aufruf der Seite, denn das
// CSS wird auch bei der Ausgabe geprüft). Ergebnis: [ganzer Treffer, Wert] oder null.
export function urlArg(css: string, i: number): [string, string] | null {
  const len = css.length;
  let a = i + 1;
  while (a < len && isWs(css.charCodeAt(a))) a++;
  if (a >= len || css[a] === '"' || css[a] === "'" || css[a] === ')') return null;
  let r = css.indexOf(')', a + 1);
  if (r < 0) r = len;
  let e = r;
  while (e > a + 1 && isWs(css.charCodeAt(e - 1))) e--;
  return [css.slice(i, r < len ? r + 1 : len), css.slice(a, e)];
}
const HEX = /[0-9a-fA-F]/;
const ALNUM = /^[a-zA-Z0-9]$/;

const toBin = (s: string): string => Buffer.from(s, 'utf8').toString('latin1');
const fromBin = (s: string): string => Buffer.from(s, 'latin1').toString('utf8');

// Länge eines UTF-8-Zeichens am Leitbyte (wie „.“ mit /u)
function charLen(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead >= 0xf0) return 4;
  if (lead >= 0xe0) return 3;
  if (lead >= 0xc0) return 2;
  return 1;
}

// mb_chr(hexdec(x) ?: 0xFFFD) – null, wenn PHP false liefert (Ersatzzeichen-Bereich oder über U+10FFFF)
function codePointChar(hex: string): string | null {
  const cp = parseInt(hex, 16) || 0xfffd;
  if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
  return String.fromCodePoint(cp);
}

// oys_css_unescape(): löst \72, \" und Zeilenfortsetzungen auf (auf normalem Text)
export function cssUnescape(value: string): string {
  return value.replace(/\\([0-9a-fA-F]{1,6})[ \t\n\f]?|\\(\n)|\\([\s\S])/gu, (_m, hex?: string, nl?: string, ch?: string) => {
    if (hex !== undefined) return codePointChar(hex) ?? '';
    if (nl !== undefined) return '';
    return ch ?? '';
  });
}

// oys_css_external(): zeigt die Adresse auf einen fremden Server? Erlaubt sind /pfad, relativ, #id und data:
export function cssExternal(url: string): boolean {
  const u = url.replace(/[\x00-\x20\x7f]+/g, '');
  // Ohne u-Flag vergleicht /i nur ASCII-Buchstaben (wie stripos)
  if (u === '' || u[0] === '#' || /^data:/i.test(u)) return false;
  return /^([a-z][a-z0-9+.-]*:|[/\\]{2})/i.test(u);
}

// Teil des Binärtexts als normaler Text. Ungültiges UTF-8 (nur bei einer offenen Zeichenkette ganz am Ende möglich)
// prüft PHP gar nicht – hier wird es mit Ersatzzeichen gelesen und trotzdem geprüft (sicherer, sonst gleich).
const binToText = (bin: string): string => fromBin(bin);

export function cleanCss(input: unknown): string {
  const text = mbSubstr(typeof input === 'string' ? input.replace(/\0/g, '') : '', 0, 20000);
  if (phpTrim(text) === '') return '';
  const css = toBin(text);
  const len = css.length;
  let out = '';
  let word = ''; // Bezeichner direkt vor der aktuellen Stelle (für Funktionsnamen)
  const stack: string[] = []; // offene Funktionen, z. B. ['image-set']
  let inUrl = 0; // wie viele davon laden Adressen (url, image-set …)

  for (let i = 0; i < len; i++) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') {
      // Kommentare entfernen (sie trennen Wörter: u/**/rl ist kein url)
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? len : end + 1;
      out += ' ';
      word = '';
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < len && css[j] !== c && css[j] !== '\n') j += css[j] === '\\' ? 2 : 1;
      const str = css.substring(i, Math.min(j, len - 1) + 1);
      const inner = str.length > 2 ? str.slice(1, -1) : '';
      out += inUrl > 0 && cssExternal(cssUnescape(binToText(inner))) ? c + c : str;
      i = j;
      word = '';
    } else if (c === '\\') {
      // Escapes außerhalb von Zeichenketten: Buchstaben/Ziffern auflösen, damit Tarnungen wie u\72l( auffallen
      if (i + 1 >= len) {
        out += c;
        word = '';
        continue;
      }
      let m0: string;
      let ch: string | null;
      if (HEX.test(css[i + 1])) {
        let k = i + 1;
        while (k < len && k < i + 7 && HEX.test(css[k])) k++;
        const hex = css.substring(i + 1, k);
        if (k < len && ' \t\n\f'.includes(css[k])) k++;
        m0 = css.substring(i, k);
        ch = codePointChar(hex);
      } else {
        const n = charLen(css.charCodeAt(i + 1));
        m0 = css.substring(i, Math.min(len, i + 1 + n));
        ch = n === 1 ? css[i + 1] : null; // Mehrbyte-Zeichen sind nie Buchstaben/Ziffern im Sinne der Prüfung
      }
      if (ch !== null && (ALNUM.test(ch) || ch === '-')) {
        out += ch;
        word += ch;
      } else {
        out += m0;
        word = '';
      }
      i += m0.length - 1;
    } else if (c === '(') {
      const name = word.toLowerCase();
      word = '';
      if (name === 'url') {
        const m = urlArg(css, i);
        if (m) {
          // url(ohne Anführungszeichen) – auch ohne schließende Klammer am Ende
          out += cssExternal(cssUnescape(binToText(m[1]))) ? '("")' : m[0];
          i += m[0].length - 1;
          continue;
        }
      }
      stack.push(name);
      inUrl += URL_FUNCTIONS.includes(name) ? 1 : 0;
      out += c;
    } else {
      if (c === ')' && stack.length) inUrl -= URL_FUNCTIONS.includes(stack.pop() as string) ? 1 : 0;
      word = ALNUM.test(c) || c === '-' ? word + c : '';
      out += c;
    }
  }
  out = out.replace(/@import\b[^;{}]*;?/gi, '');
  return phpTrim(fromBin(out.replace(/</g, '')));
}
