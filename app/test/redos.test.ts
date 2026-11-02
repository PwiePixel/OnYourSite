// Reguläre Ausdrücke und Schleifen auf Eingaben von außen: V8 kennt keine Grenze für Rückverfolgung (PCRE schon) – ein
// Muster, das in PHP harmlos ist, kann den Server minutenlang blockieren. Jede gefundene Stelle ist ersetzt; hier:
// 1. feindliche Eingaben ab 100 KB brauchen nur Millisekunden (vorher Sekunden bis Minuten),
// 2. die neue Fassung liefert für Zufallseingaben genau dasselbe wie der frühere Ausdruck,
// 3. und dasselbe wie die PHP-Funktion, die sie nachbaut.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { ROOT_DIR } from '../src/config.js';
import { cleanText, cleanUrl, normalizeSlug, prettyUrl, initials } from '../src/helpers.js';
import * as compat from '../src/compat/core.js';
import { cleanCss, urlArg } from '../src/css.js';
import { emphasis, markdown, mdEmphasis, mdInline, mdPlain } from '../src/updates/markdown.js';
import { externLine, fileMime } from '../src/content/fileMime.js';
import { ogFit, ogFont, ogWidth } from '../src/content/share.js';
import { phpRtrim } from '../src/php.js';

// Kleinste Zeit aus fünf Läufen (die Maschine ist oft ausgelastet)
function fastest(fn: () => unknown): number {
  let best = Infinity;
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    fn();
    best = Math.min(best, performance.now() - t);
  }
  return best;
}
// Gemessen (ausgelastete Maschine): 1–35 ms je Aufruf mit 128 KB; vorher Sekunden bis Minuten
const LIMIT_MS = 100;
const KB128 = 128 * 1024;
const pump = (unit: string, size = KB128): string => unit.repeat(Math.ceil(size / unit.length));

// Fester Zufall (wiederholbar)
function rng(seed: number): (n: number) => number {
  let s = seed >>> 0;
  return (n: number) => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return (s >>> 8) % n;
  };
}
const randomStrings = (seed: number, count: number, alphabet: readonly string[], maxLen: number): string[] => {
  const r = rng(seed);
  return Array.from({ length: count }, () => Array.from({ length: r(maxLen + 1) }, () => alphabet[r(alphabet.length)]).join(''));
};

function php(code: string, input: unknown): unknown {
  const script = `require '${ROOT_DIR}/lib/config.php'; date_default_timezone_set(oys_config('timezone', 'Europe/Berlin')); mb_internal_encoding('UTF-8');`
    + `require '${ROOT_DIR}/blacklist.php'; require '${ROOT_DIR}/lib/helpers.php'; require '${ROOT_DIR}/lib/pages.php'; require '${ROOT_DIR}/lib/updates.php';`
    + `$in = json_decode(stream_get_contents(STDIN), true); $out = (function ($in) { ${code} })($in);`
    + 'echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);';
  return JSON.parse(execFileSync('php', ['-r', script], { input: JSON.stringify(input), cwd: ROOT_DIR, maxBuffer: 256 * 1024 * 1024 }).toString());
}
const phpEach = (fn: string, inputs: unknown[]): unknown => php(`return array_map(function ($v) { return ${fn}; }, $in);`, inputs);

// ---------------------------------------------------------------- trim(), rtrim('/') und mb_substr() (helpers.php)

// Frühere Fassungen als Bezug
const oldTrim = (s: string): string => s.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');
const oldSlashes = (s: string): string => s.replace(/\/+$/, '');
const oldMbSubstr = (s: string, start: number, len?: number): string => {
  const a = Array.from(s);
  const st = start < 0 ? Math.max(0, a.length + start) : start;
  if (len === undefined) return a.slice(st).join('');
  const en = len < 0 ? a.length + len : st + len;
  return a.slice(st, Math.max(st, en)).join('');
};

test('text and URL cleaning stay fast on 128 KB of whitespace or slashes', () => {
  const inputs = [
    'a' + pump(' ') + 'a', 'a' + pump('\t\n') + 'a', 'a' + pump(' \r\n\0\x0B') + 'b', pump(' ') + 'x' + pump(' '),
  ];
  for (const s of inputs) {
    assert.ok(fastest(() => cleanText(s)) < LIMIT_MS, 'cleanText ' + JSON.stringify(s.slice(0, 8)));
    assert.ok(fastest(() => cleanText(s, 2000, true)) < LIMIT_MS, 'cleanText multiline');
    assert.ok(fastest(() => cleanUrl(s)) < LIMIT_MS, 'cleanUrl');
    assert.ok(fastest(() => normalizeSlug(s)) < LIMIT_MS, 'normalizeSlug');
    assert.ok(fastest(() => initials(s)) < LIMIT_MS, 'initials');
  }
  for (const s of ['https://x.de/' + pump('/') + 'a', 'a' + pump('/') + 'a', pump('/')]) {
    assert.ok(fastest(() => prettyUrl(s)) < LIMIT_MS, 'prettyUrl');
  }
  // Ein großes Feld (8 MB, wie ein Formular mit post_max_size 20M) wird nur bis zur Höchstlänge gelesen
  const big = '日'.repeat(8 * 1024 * 1024);
  assert.ok(fastest(() => cleanText(big, 255)) < 2 * LIMIT_MS, 'cleanText of 8 MB');
  assert.ok(fastest(() => compat.mbSubstr(big, 0, 100)) < LIMIT_MS, 'compat mbSubstr of 8 MB');
});

test('trim, slash trimming and mb_substr give the same results as before', () => {
  for (const s of randomStrings(1, 20000, [' ', '\t', '\n', '\r', '\0', '\x0B', '\f', 'a', '\u00a0', '/', 'é'], 12)) {
    assert.equal(compat.phpTrim(s), oldTrim(s), JSON.stringify(s));
    assert.equal(prettyUrl(s), oldSlashes(s.replace(/^https?:\/\/(www\.)?/i, '')), JSON.stringify(s));
  }
  // Ersatzzeichen-Paare zählen als ein Zeichen, einzelne als eins
  const units = ['a', 'ü', '😀', '\ud83d', '\ude00', '\u2028', ''];
  const r = rng(2);
  for (const s of randomStrings(3, 4000, units, 10)) {
    const start = r(12);
    const len = r(12);
    assert.equal(compat.mbSubstr(s, start, len), oldMbSubstr(s, start, len), JSON.stringify([s, start, len]));
  }
});

test('long whitespace and slash runs are cleaned exactly like PHP', () => {
  const texts = ['a' + ' '.repeat(3000) + 'b', '  \t\n x \r\n\0 ', ' '.repeat(5000), '\x0B\x0Bx\x0B\x0B', 'x' + '\n'.repeat(4000) + 'y\n\n'];
  assert.deepEqual(texts.map((t) => cleanText(t, 9000)), phpEach('oys_clean_text($v, 9000)', texts));
  assert.deepEqual(texts.map((t) => cleanText(t, 9000, true)), phpEach('oys_clean_text($v, 9000, true)', texts));
  const urls = ['https://www.x.de/' + '/'.repeat(3000), 'http://x.de//a//', 'x.de' + '/'.repeat(10) + 'y' + '/'.repeat(10), '////', 'mailto:a@b.de//'];
  assert.deepEqual(urls.map(prettyUrl), phpEach('oys_pretty_url($v)', urls));
});

// ---------------------------------------------------------------- url(…) in eigenem CSS (oys_clean_css)

const OLD_URL_ARG = /\([ \t\n\x0B\f\r]*([^ \t\n\x0B\f\r"')][^)]*?)[ \t\n\x0B\f\r]*(?:\)|$)/y;
function oldUrlArg(css: string, i: number): [string, string] | null {
  OLD_URL_ARG.lastIndex = i;
  const m = OLD_URL_ARG.exec(css);
  return m ? [m[0], m[1]] : null;
}

test('url() in custom CSS stays fast with long whitespace (checked on every page view)', () => {
  const hostile = '(a' + pump(' ') + 'b';
  assert.ok(fastest(() => urlArg(hostile, 0)) < LIMIT_MS, 'urlArg');
  // Das Feld selbst ist auf 20 000 Zeichen begrenzt – der frühere Ausdruck brauchte dafür eine Sekunde
  for (const css of ['a{background:url(a' + pump(' ') + 'b}', 'a{background:url(x' + pump(' \t\n') + ')}', pump('url(a ')]) {
    assert.ok(fastest(() => cleanCss(css)) < LIMIT_MS, 'cleanCss ' + JSON.stringify(css.slice(0, 20)));
  }
});

test('url() arguments are found exactly like before', () => {
  const alphabet = ['(', ')', ' ', '\t', '\n', '\x0B', '\f', '\r', '"', "'", 'a', 'u', '\\', '/', ':', '\0'];
  for (const s of randomStrings(4, 30000, alphabet, 14)) {
    const css = '(' + s;
    assert.deepEqual(urlArg(css, 0), oldUrlArg(css, 0), JSON.stringify(css));
    // auch mitten im Text
    const at = css.length > 2 ? 2 : 0;
    if (css[at] === '(') assert.deepEqual(urlArg(css, at), oldUrlArg(css, at), JSON.stringify(css));
  }
});

test('custom CSS with whitespace in url() is cleaned exactly like PHP', () => {
  const inputs = [
    'a{background:url(  https://evil.example/x' + ' '.repeat(2000) + 'y  )}', 'a{background:url(/img/a.png' + '\n'.repeat(500) + ')}',
    'b{background:url( a b c )}', 'c{background:url(\t//evil.example/x\t', 'd{background:url(' + ' '.repeat(300) + ')}',
    'e{background:url(data:image/png;base64,AAAA' + '\f'.repeat(50) + ')}', 'f{x:url(a)url(b)url(  )url(//x)}',
  ];
  const theirs = php('return array_map(fn ($v) => oys_clean_css($v), $in);', inputs) as string[];
  assert.deepEqual(inputs.map(cleanCss), theirs);
});

// ---------------------------------------------------------------- Markdown der Updates (oys_md_emphasis, oys_md_plain)

const OLD = {
  strong: /\*\*(?=[^\t\n\v\f\r ])([^\n]+?)(?<=[^\t\n\v\f\r ])\*\*/g,
  del: /~~(?=[^\t\n\v\f\r ])([^\n]+?)(?<=[^\t\n\v\f\r ])~~/g,
  emStar: /(?<![A-Za-z0-9_*])\*(?=[^\t\n\v\f\r ])([^\n]+?)(?<=[^\t\n\v\f\r ])\*(?![A-Za-z0-9_*])/g,
  emUnderscore: /(?<![A-Za-z0-9_])_(?=[^\t\n\v\f\r ])([^\n]+?)(?<=[^\t\n\v\f\r ])_(?![A-Za-z0-9_])/g,
  plain: /(\*\*|~~)(?=[^\t\n\v\f\r ])([^\n]+?)(?<=[^\t\n\v\f\r ])\1/g,
};
const isWord = (c: number): boolean => /[A-Za-z0-9_]/.test(String.fromCharCode(c));
const isWordStar = (c: number): boolean => isWord(c) || c === 0x2a;

test('emphasis in update texts stays fast on 128 KB lines without closing marks', () => {
  for (const unit of ['**a\t', '~~a\v', '*a<', '_a.', '**^ ', '~~) ', '*_[', '_[ ', '**', '~~', '*a', '_a']) {
    const line = pump(unit);
    assert.ok(fastest(() => mdEmphasis(line)) < LIMIT_MS, 'mdEmphasis ' + JSON.stringify(unit));
    assert.ok(fastest(() => mdPlain(line)) < LIMIT_MS, 'mdPlain ' + JSON.stringify(unit));
    // [Text](Ziel) prüft von jedem „[“ aus höchstens 200 Bytes (linear, aber teuer) – dazu der Test unten
    if (unit.includes('[')) continue;
    assert.ok(fastest(() => mdInline(line)) < LIMIT_MS, 'mdInline ' + JSON.stringify(unit));
    assert.ok(fastest(() => markdown(line)) < LIMIT_MS, 'markdown ' + JSON.stringify(unit));
  }
  // Viele kurze Zeilen bleiben schnell (je Zeile nur Arbeit, wenn ein Trenner vorkommt)
  const lines = pump('**x\n', 64 * 1024);
  assert.ok(fastest(() => markdown(lines)) < 5 * LIMIT_MS, 'markdown with many lines');
});

test('a whole update text full of [ and emphasis marks renders quickly', () => {
  // Update-Texte haben höchstens 20 000 Zeichen (cleanText beim Speichern); jede Zeile läuft durch mdInline()
  for (const unit of ['[', '*_[', '_[ ', '[a](', '[a](b', '**[', '](']) {
    const body = pump(unit, 20000);
    assert.ok(fastest(() => markdown(body)) < LIMIT_MS, 'markdown ' + JSON.stringify(unit));
    assert.ok(fastest(() => mdPlain(body, 280)) < LIMIT_MS, 'mdPlain ' + JSON.stringify(unit));
  }
});

test('emphasis pairs are found exactly like the former expressions', () => {
  const alphabet = ['*', '*', '~', '~', '_', ' ', '\t', '\n', 'a', '1', '\r', '\v', '<', '\u2028', 'é', '&'];
  for (const s of randomStrings(5, 40000, alphabet, 16)) {
    assert.equal(emphasis(s, ['**'], null, (t) => '<b>' + t + '</b>'), s.replace(OLD.strong, '<b>$1</b>'), JSON.stringify(s));
    assert.equal(emphasis(s, ['~~'], null, (t) => '<d>' + t + '</d>'), s.replace(OLD.del, '<d>$1</d>'), JSON.stringify(s));
    assert.equal(emphasis(s, ['*'], isWordStar, (t) => '<i>' + t + '</i>'), s.replace(OLD.emStar, '<i>$1</i>'), JSON.stringify(s));
    assert.equal(emphasis(s, ['_'], isWord, (t) => '<i>' + t + '</i>'), s.replace(OLD.emUnderscore, '<i>$1</i>'), JSON.stringify(s));
    assert.equal(emphasis(s, ['**', '~~'], null, (t) => t), s.replace(OLD.plain, '$2'), JSON.stringify(s));
    assert.equal(mdEmphasis(s), s.replace(OLD.strong, '<strong>$1</strong>').replace(OLD.del, '<del>$1</del>')
      .replace(OLD.emStar, '<em>$1</em>').replace(OLD.emUnderscore, '<em>$1</em>'), JSON.stringify(s));
  }
});

test('emphasis-heavy update texts render exactly like PHP', () => {
  const alphabet = ['**', '~~', '*', '_', ' ', 'a', 'b', '1', '\n', '<', '&', 'ü', '`', '\t'];
  const inputs = randomStrings(6, 400, alphabet, 30);
  inputs.push(pump('**a ', 3000), pump('_a.', 3000), '**' + 'a '.repeat(1500) + '**', pump('*a<', 3000) + '*');
  const theirs = php('return array_map(fn ($s) => [oys_markdown($s), oys_md_plain($s, 280), oys_md_emphasis($s)], $in);', inputs) as string[][];
  const mismatches = inputs.map((s, i) => ({ s, node: [markdown(s), mdPlain(s, 280), mdEmphasis(s)], php: theirs[i] }))
    .filter((m) => JSON.stringify(m.node) !== JSON.stringify(m.php)).slice(0, 3);
  assert.deepEqual(mismatches, []);
});

// ---------------------------------------------------------------- Erkennung von Uploads (finfo, Regel „extern“ für C)

const OLD_EXTERN = /^[\t\n\v\f\r ]*extern[\t\n\v\f\r ]+/m;

test('file type detection stays fast on uploads full of line breaks', () => {
  for (const unit of ['\n', '\r\n', ' \n', '\t\n\v\f\r ']) {
    const data = Buffer.from(pump(unit, 1024 * 1024) + 'x', 'latin1');
    assert.ok(fastest(() => fileMime(data)) < LIMIT_MS, 'fileMime ' + JSON.stringify(unit));
    assert.ok(fastest(() => externLine(pump(unit))) < LIMIT_MS, 'externLine ' + JSON.stringify(unit));
  }
});

test('the extern rule matches exactly like the former expression', () => {
  const alphabet = ['\n', '\r', ' ', '\t', '\v', '\f', '\u2028', '\u2029', 'extern', 'extern', 'x', 'e', '#', '\u00a0'];
  for (const s of randomStrings(7, 40000, alphabet, 8)) assert.equal(externLine(s), OLD_EXTERN.test(s), JSON.stringify(s));
});

test('text uploads with C markers are detected like PHP', () => {
  const texts = ['\n\n\n  extern int x;\n', 'a\n \t extern void f(void);', 'externx', 'intern\nextern\n', ' \n\r\n extern\tx', 'x extern y\n',
    '\n'.repeat(9000) + 'extern x', '\r\rextern x', 'hello\n\n\textern  \n'];
  const theirs = php('$fi = finfo_open(FILEINFO_MIME_TYPE); return array_map(fn ($v) => finfo_buffer($fi, $v), $in);', texts) as string[];
  assert.deepEqual(texts.map((t) => fileMime(Buffer.from(t, 'utf8'))), theirs);
});

// ---------------------------------------------------------------- Vorschaubild (oys_og_fit)

// Frühere Fassung: jeder Versuch misst den ganzen Rest neu (quadratisch)
function oldOgFit(s: string, font: string, size: number, maxW: number): string {
  if (ogWidth(s, font, size) <= maxW) return s;
  const chars = Array.from(s);
  while (chars.length > 1 && ogWidth(chars.join('') + '…', font, size) > maxW) chars.pop();
  return phpRtrim(chars.join('')) + '…';
}

test('shortening text for the preview image stays fast for long words', () => {
  // Erste Zeile der Bio: bis 1000 Zeichen (vorher eine halbe Sekunde); 16 KB wären vorher Minuten gewesen
  for (const s of ['W'.repeat(1000), pump('Wi', 16 * 1024), 'ü'.repeat(1000) + '😀'.repeat(100)]) {
    assert.ok(fastest(() => ogFit(s, ogFont(false), 32, 1000)) < LIMIT_MS, 'ogFit ' + s.length);
  }
});

test('the preview text is shortened exactly like before', () => {
  const alphabet = ['W', 'i', 'a', ' ', 'ü', '😀', '́', '–', '…', 'Ж', '日', '\r', '\n', '&', ';', '#', '1', '\ud800'];
  for (const s of randomStrings(8, 600, alphabet, 40)) {
    for (const [bold, size, maxW] of [[true, 30, 200], [false, 32, 120], [false, 20, 40]] as const) {
      assert.equal(ogFit(s, ogFont(bold), size, maxW), oldOgFit(s, ogFont(bold), size, maxW), JSON.stringify([s, size, maxW]));
    }
  }
});
