// Einfaches, sicheres Markdown für Updates und Roadmap (lib/updates.php: oys_markdown, oys_md_*) – Byte für Byte
// wie PHP. Die PHP-Muster ohne /u arbeiten auf Bytes mit ASCII-Klassen, die mit /u auf Unicode-Zeichen (pcre.ts).
// „.“ trifft in PHP alles außer \n (in JS fehlen sonst \r, U+2028 und U+2029) – darum überall [^\n].
import { e } from '../html.js';
import { cleanUrl, mainUrl, prettyUrl } from '../helpers.js';
import { intval, mbStrlen, mbSubstr, phpRtrim, phpTrim } from '../php.js';
import { UCP_DIGIT, UCP_WS } from './pcre.js';

// Zeilen (oys_markdown)
const FENCE = /^[\t\n\v\f\r ]*```/;
const HEADING = /^(#{1,3})[\t\n\v\f\r ]+([^\n]+)$/;
const LIST = new RegExp(`^[${UCP_WS}]*(?:[-*\\u{2022}]|([${UCP_DIGIT}]+)[.)])[${UCP_WS}]+([^\\n]+)$`, 'u');
const QUOTE = /^>[\t\n\v\f\r ]?([^\n]*)$/;

// Innerhalb einer Zeile (oys_md_inline)
const CODE_SPAN = /`([^`]+)`/g;
// [Text](Ziel): die Grenzen 200 und 500 zählen Bytes – das Muster läuft auf den UTF-8-Bytes (als latin1-Text)
const LINK_BYTES = /\[([^\]\n]{1,200})\]\(((?:[^()\t\n\v\f\r \x01\x02]|\([^()\t\n\v\f\r \x01\x02]*\)){1,500})\)/g;
const BARE_URL = /\bhttps?:\/\/(?:[^\t\n\v\f\r <>"()\x01\x02]|\([^\t\n\v\f\r <>"()\x01\x02]*\))+(?<![.,;:!?\]"'*_~])/gi;
const PLACEHOLDER = /\x01(\d+)\x02/g;

// Hervorhebungen (oys_md_emphasis, oys_md_plain): die PHP-Muster
//   /\*\*(?=\S)(.+?)(?<=\S)\*\*/  /~~(?=\S)(.+?)(?<=\S)~~/  /(\*\*|~~)(?=\S)(.+?)(?<=\S)\1/
//   /(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])/  /(?<![\w_])_(?=\S)(.+?)(?<=\S)_(?![\w_])/  (ohne /u: \w und \s ASCII, . ohne \n)
// sucht emphasis() von Hand: Als regulärer Ausdruck lief V8 von jedem öffnenden Zeichen ohne passendes schließendes bis
// zum Zeilenende (eine 30-KB-Zeile „**a **a …“: über eine Sekunde, auf /updates bei jedem Aufruf).
const isMdSpace = (c: number): boolean => c === 0x20 || (c >= 0x09 && c <= 0x0d);
const isWordChar = (c: number): boolean => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f;
const isWordOrStar = (c: number): boolean => isWordChar(c) || c === 0x2a;

// Paare aus einem der Trenner (bei mehreren: hinten derselbe wie vorn) in linearer Zeit, dieselben Treffer wie die Muster
// oben: Vorn folgt kein Leerraum, hinten steht keiner davor, dazwischen mindestens ein Zeichen und kein \n; mit word dürfen
// davor und danach keine solchen Zeichen stehen. Ein Treffer endet am ersten passenden Trenner der Zeile (wie .+?), danach
// geht es dahinter weiter, ohne Treffer ein Zeichen weiter – wie preg_replace. wrap bekommt den Text dazwischen.
export function emphasis(text: string, delims: readonly string[], word: ((c: number) => boolean) | null, wrap: (inner: string) => string): string {
  if (!delims.some((d) => text.includes(d))) return text;
  const len = text.length;
  const firsts = delims.map((d) => d.charCodeAt(0));
  // Erstes \n ab i
  const nl = new Int32Array(len + 1);
  nl[len] = len;
  for (let i = len - 1; i >= 0; i--) nl[i] = text.charCodeAt(i) === 10 ? i : nl[i + 1];
  // Je Trenner: erste Stelle ab q, an der er schließen kann
  const close = delims.map((d, j) => {
    const next = new Int32Array(len + 1);
    next[len] = len;
    for (let q = len - 1; q >= 0; q--) {
      next[q] = q > 0 && text.charCodeAt(q) === firsts[j] && text.startsWith(d, q) && !isMdSpace(text.charCodeAt(q - 1))
        && (word === null || q + d.length >= len || !word(text.charCodeAt(q + d.length))) ? q : next[q + 1];
    }
    return next;
  });
  let out = '';
  let last = 0;
  for (let p = 0; p < len; p++) {
    const c = text.charCodeAt(p);
    let k = 0;
    while (k < delims.length && (c !== firsts[k] || !text.startsWith(delims[k], p))) k++;
    if (k === delims.length || (word !== null && p > 0 && word(text.charCodeAt(p - 1)))) continue;
    const s = p + delims[k].length;
    if (s >= len || isMdSpace(text.charCodeAt(s))) continue;
    const q = close[k][s + 1];
    if (q >= nl[s]) continue;
    out += text.slice(last, p) + wrap(text.slice(s, q));
    last = q + delims[k].length;
    p = last - 1;
  }
  return out + text.slice(last);
}

// Klartext (oys_md_plain)
const PLAIN_CODE_BLOCK = /```[\s\S]*?```/g;
const PLAIN_CODE = /`([^`\n]+)`/g;
// ^ mit /m: Anfang oder nach \n (in JS träfe ^ mit /m auch nach \r und U+2028)
const PLAIN_LINE_MARK = new RegExp(`(?<![^\\n])[ \\t]*(?:#{1,6}[ \\t]+|>[ \\t]?|[-*\\u{2022}][ \\t]+|[${UCP_DIGIT}]+[.)][ \\t]+)`, 'gu');
const PLAIN_SPACES = new RegExp(`[${UCP_WS}]+`, 'gu');

// Text ↔ UTF-8-Bytes (ein Zeichen je Byte), für Muster, die in PHP Bytes zählen
const toBytes = (s: string): string => Buffer.from(s, 'utf8').toString('latin1');
const fromBytes = (b: string): string => Buffer.from(b, 'latin1').toString('utf8');

// Grenze von PCRE-JIT in PHP: eine Gruppe (…|…)+ legt je Durchlauf einen Rücksprungpunkt auf einen Stapel fester
// Größe. Läuft er über, gibt preg_* null zurück („JIT stack limit exhausted“) – nachgemessen mit PHP 8.3 und
// PCRE2 10.42: ab 8192 Durchläufen bei der nackten Adresse, ab 8191 beim Link im Klartext. Ein Durchlauf ist ein Byte
// oder eine ganze (…)-Gruppe. Gezählt wird der gierige Lauf jedes Versuchs, auch wenn der Treffer danach kürzer wird.
const JIT_URL_MAX = 8191;
const JIT_PLAIN_LINK_MAX = 8190;
const URL_RUN = /\bhttps?:\/\/((?:[^\t\n\v\f\r <>"()\x01\x02]|\([^\t\n\v\f\r <>"()\x01\x02]*\))+)/gi;
const PLAIN_LINK_RUN = /(?:[^()\t\n\v\f\r ]|\([^()\t\n\v\f\r ]*\))+/y;

// Durchläufe einer Gruppe: jedes Byte einzeln, eine (…)-Gruppe einmal (sie ist im Lauf immer vollständig)
function jitRuns(run: string): number {
  let n = 0;
  for (let i = 0; i < run.length; ) {
    if (run[i] === '(') {
      n++;
      i = run.indexOf(')', i) + 1;
      continue;
    }
    const cp = run.codePointAt(i) as number;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    i += cp > 0xffff ? 2 : 1;
  }
  return n;
}

// Nackte Adressen (oys_md_inline): dieselben Versuche wie preg_replace_callback – nach einem Lauf geht es dahinter weiter
function urlStackExhausted(text: string): boolean {
  URL_RUN.lastIndex = 0;
  for (let m = URL_RUN.exec(text); m; m = URL_RUN.exec(text)) {
    if (jitRuns(m[1]) > JIT_URL_MAX) return true;
  }
  return false;
}

// [Text](Link) → Text im Klartext (oys_md_plain, Muster /\[([^\]\n]+)\]\((?:[^()\s]|\([^()\s]*\))+\)/) – von Hand, weil
// JavaScript bei vielen „[“ ohne „]“ von jedem „[“ aus bis zum Zeilenende zurückverfolgt (PCRE nicht). Je „[“ gibt es
// genau einen möglichen Treffer: die Beschriftung reicht bis zum ersten „]“ (vorher kein \n), dann „(“, der ganze gierige
// Lauf und ein „)“. Ein Versuch beginnt wie in PCRE nur, wenn danach noch ein „)“ steht (Pflichtzeichen); nach einem
// Treffer geht es dahinter weiter. null = PCRE gibt mit vollem JIT-Stapel auf (siehe oben).
function plainLinks(text: string): string | null {
  // Für jede Stelle das nächste „]“ oder „\n“ (Ende einer Beschriftung)
  const stop = new Int32Array(text.length + 1).fill(text.length);
  for (let i = text.length - 1; i >= 0; i--) stop[i] = text[i] === ']' || text[i] === '\n' ? i : stop[i + 1];
  let out = '';
  let last = 0;
  let close = -1;
  for (let at = text.indexOf('['); at >= 0; ) {
    if (close <= at && (close = text.indexOf(')', at + 1)) < 0) break;
    const end = stop[at + 1];
    let next = at + 1;
    if (end > at + 1 && text[end] === ']' && text[end + 1] === '(') {
      PLAIN_LINK_RUN.lastIndex = end + 2;
      const run = PLAIN_LINK_RUN.exec(text);
      if (run && jitRuns(run[0]) > JIT_PLAIN_LINK_MAX) return null;
      const after = end + 2 + (run ? run[0].length : 0);
      if (run && text[after] === ')') {
        out += text.slice(last, at) + text.slice(at + 1, end);
        last = next = after + 1;
      }
    }
    at = text.indexOf('[', next);
  }
  return out + text.slice(last);
}

// oys_markdown(): zeilenweise, ohne Zeilenumbrüche zwischen den Elementen
export function markdown(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let html = '';
  let para: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let inCode = false;
  let code: string[] = [];
  const flushPara = (): void => {
    if (para.length) {
      html += '<p>' + para.map(mdInline).join('<br>') + '</p>';
      para = [];
    }
  };
  const closeList = (): void => {
    if (list) {
      html += '</' + list + '>';
      list = null;
    }
  };
  for (const line of lines) {
    if (FENCE.test(line)) {
      if (inCode) {
        html += '<pre><code>' + e(code.join('\n')) + '</code></pre>';
        code = [];
        inCode = false;
      } else {
        flushPara();
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    // Leerzeile nur mit den Zeichen von trim() (NBSP oder \f zählen nicht)
    if (phpTrim(line) === '') {
      flushPara();
      closeList();
      continue;
    }
    let m = HEADING.exec(line);
    if (m) {
      flushPara();
      closeList();
      const tag = m[1].length === 3 ? 'h5' : 'h4';
      html += '<' + tag + '>' + mdInline(m[2]) + '</' + tag + '>';
      continue;
    }
    m = LIST.exec(line);
    if (m) {
      flushPara();
      // In PHP ist die nicht getroffene Gruppe '', in JS undefined
      const want = m[1] !== undefined ? 'ol' : 'ul';
      if (list !== want) {
        closeList();
        html += '<' + want + '>';
        list = want;
      }
      html += '<li>' + mdInline(m[2]) + '</li>';
      continue;
    }
    m = QUOTE.exec(line);
    if (m) {
      flushPara();
      closeList();
      html += '<blockquote>' + mdInline(m[1]) + '</blockquote>';
      continue;
    }
    closeList();
    para.push(line);
  }
  if (inCode) html += '<pre><code>' + e(code.join('\n')) + '</code></pre>';
  flushPara();
  closeList();
  return html;
}

// oys_md_inline(): Code und Links zuerst beiseitelegen, den Rest maskieren, dann nur bekannte Muster in Tags verwandeln
export function mdInline(input: string): string {
  let text = input.replace(/[\x01\x02]/g, '');
  const keep: string[] = [];
  const stash = (h: string): string => {
    keep.push(h);
    return '\x01' + (keep.length - 1) + '\x02';
  };
  text = text.replace(CODE_SPAN, (_m, c: string) => stash('<code>' + e(c) + '</code>'));
  // Adressen dürfen ausgeglichene Klammern enthalten, z. B. …/wiki/Foo_(bar)
  text = fromBytes(toBytes(text).replace(LINK_BYTES, (m0: string, label: string, url: string) => {
    const link = mdLink(fromBytes(url), mdEmphasis(e(fromBytes(label))));
    return link === '' ? m0 : stash(link);
  }));
  // Nackte Adressen: Satzzeichen und Markdown-Zeichen am Ende gehören nicht dazu. Ist eine zu lang für PCRE, liefert
  // PHP hier null – die ganze Zeile wird leer (auch Code und Links, die schon beiseitegelegt waren).
  if (urlStackExhausted(text)) return '';
  text = text.replace(BARE_URL, (m0: string) =>
    stash('<a href="' + e(m0) + '" target="_blank" rel="noopener noreferrer">' + e(prettyUrl(m0)) + '</a>'));
  text = mdEmphasis(e(text));
  // Platzhalter einsetzen (auch verschachtelte, z. B. Code in einem Link)
  for (let i = 0; i < 3 && text.includes('\x01'); i++) {
    text = text.replace(PLACEHOLDER, (_m, n: string) => keep[intval(n)] ?? '');
  }
  return text.replace(/[\x01\x02]/g, '');
}

// oys_md_link(): eigene Pfade (/…, #…) werden zu vollen Adressen, weil der Text auch im Feed steht
export function mdLink(url: string, labelHtml: string): string {
  if (/^\/(?![/\\])/.test(url) || (url !== '' && url[0] === '#')) {
    return '<a href="' + e(mainUrl(url[0] === '#' ? '/updates' + url : url)) + '">' + labelHtml + '</a>';
  }
  const clean = cleanUrl(url);
  return clean === '' ? '' : '<a href="' + e(clean) + '" target="_blank" rel="noopener noreferrer">' + labelHtml + '</a>';
}

// oys_md_emphasis(): der Reihe nach **, ~~, *, _ (falsch verschachtelte Paare bleiben wie in PHP)
export function mdEmphasis(escaped: string): string {
  let text = emphasis(escaped, ['**'], null, (t) => '<strong>' + t + '</strong>');
  text = emphasis(text, ['~~'], null, (t) => '<del>' + t + '</del>');
  text = emphasis(text, ['*'], isWordOrStar, (t) => '<em>' + t + '</em>');
  return emphasis(text, ['_'], isWordChar, (t) => '<em>' + t + '</em>');
}

// oys_md_plain(): kurzer Klartext (Feed, Vorschauen)
export function mdPlain(md: string, max = 200): string {
  // Ein zu langer Link sprengt den JIT-Stapel: preg_replace liefert null, der Klartext ist dann leer
  const linked = plainLinks(md.replace(PLAIN_CODE_BLOCK, ''));
  if (linked === null) return '';
  let text = emphasis(linked.replace(PLAIN_CODE, '$1').replace(PLAIN_LINE_MARK, ''), ['**', '~~'], null, (t) => t);
  text = emphasis(text, ['*'], isWordOrStar, (t) => t);
  text = emphasis(text, ['_'], isWordChar, (t) => t);
  text = phpTrim(text.replace(PLAIN_SPACES, ' '));
  return mbStrlen(text) > max ? phpRtrim(mbSubstr(text, 0, max - 1)) + '…' : text;
}
