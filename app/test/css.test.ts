// Eigenes CSS: cleanCss() muss Byte für Byte wie oys_clean_css() arbeiten – feste Fälle und Zufallseingaben
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { ROOT_DIR } from '../src/config.js';
import { cleanCss } from '../src/css.js';

function phpClean(inputs: string[]): string[] {
  const script = `require '${ROOT_DIR}/lib/config.php'; require '${ROOT_DIR}/lib/helpers.php'; require '${ROOT_DIR}/lib/pages.php';`
    + '$in = json_decode(stream_get_contents(STDIN), true); echo json_encode(array_map("oys_clean_css", $in));';
  return JSON.parse(execFileSync('php', ['-r', script], { input: JSON.stringify(inputs), cwd: ROOT_DIR, maxBuffer: 64 * 1024 * 1024 }).toString());
}

const CASES = [
  '', '   ', 'body{color:red}', 'a{background:url(https://evil.com/x.png)}', 'a{background:url( //evil.com/x )}',
  'a{background:url("https://evil.com/x")}', "a{background:url('/static/x.png')}", 'a{background:url(data:image/png;base64,AAAA)}',
  'a{background:u\\72l(https://evil.com)}', 'a{background:u\\72 l(https://evil.com)}', 'a{background:\\75\\72\\6c(//evil.com)}',
  'a{background:u/**/rl(https://evil.com)}', '@import url(https://evil.com/a.css); body{}', '@IMPORT "x.css"', '@import',
  'a{background:image-set("https://evil.com/a.png" 1x, url(/ok.png) 2x)}', 'a{b:cross-fade(url(//x.de/a), "https://y")}',
  '</style><script>alert(1)</script>', 'a{content:"<b>"}', 'a{content:"unterminated', "a{content:'line\nbreak'}",
  'a{background:url("https:\\2f\\2f evil.com")}', 'a{background:url("\\68ttps://evil.com")}', 'a{x:url(  )}', 'a{x:url()}',
  'a{x:url(/a b c)}', 'a{x:url(https://evil.com', 'a{x:url("https://evil.com', 'a{x:url(\'https://evil.com/é', 'é{x:"ü"} \\é \\',
  '/* comment */a{}/* open', 'a{x:src("https://evil.com/font.woff")}', 'a{x:-webkit-image-set("//evil.com" 1x)}', 'a{x:IMAGE("HTTPS://E.COM")}',
  'a{x:url(#frag)}', 'a{x:url(  DATA:abc  )}', 'a{x:url(\\#x)}', 'a{x:"\\"https://evil"}', '\\0 \\000000 \\110000 \\d800x \\FFFFFF',
  'a{font-family:"Font\\\nName"}', 'a{x:url("java\nscript:x")}', 'a{x:url(java\tscript:x)}', 'a{}'.repeat(10),
  'x'.repeat(25000), '\0a{}\0', 'a{x:url(ftp://x)}', 'a{x:url(mailto:x)}', 'a{x:url(./rel.png)}', 'a{x:url(\\\\evil.com/x)}',
];

// Bewusste Abweichung: Eine offene Zeichenkette ganz am Ende, deren letztes Zeichen kein ASCII ist, prüft PHP nicht
// (ungültiges UTF-8 nach dem Abschneiden) – die fremde Adresse bliebe stehen. Node prüft sie und entfernt sie.
const SAFER_IN_NODE: Record<string, string> = { "a{x:url('https://evil.com/é": "a{x:url(''" };

test('fixed cases match PHP', () => {
  const php = phpClean(CASES);
  const mismatches = CASES.map((s, i) => ({ i, input: s.slice(0, 80), node: cleanCss(s), php: php[i] }))
    .filter((m) => m.node !== (SAFER_IN_NODE[CASES[m.i]] ?? m.php))
    .map((m) => ({ ...m, node: m.node.slice(0, 80), php: m.php.slice(0, 80) }));
  assert.deepEqual(mismatches, []);
  for (const input of Object.keys(SAFER_IN_NODE)) assert.equal(phpClean([input])[0], input, 'PHP still lets this through');
});

test('random CSS matches PHP', () => {
  // Bausteine, die den Filter fordern: Funktionen, Escapes, Anführungszeichen, Kommentare, Umlaute, Emoji
  const parts = ['url', 'URL', 'image-set', 'src', 'cross-fade', 'calc', 'var', '(', ')', '"', "'", '\\', '\\72', '\\75 ', '\\6c', '/*', '*/', '/', '//',
    'https:', 'data:', '#', 'evil.com', ' ', '\n', '\t', '@import', ';', '{', '}', '<', 'é', '🐝', 'a', 'u', 'r', 'l', '-', ':', ',', '\0', '\\\n', '\x0B', '\xA0'];
  let seed = 7;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const inputs: string[] = [];
  for (let k = 0; k < 3000; k++) {
    let s = '';
    const n = 1 + rnd(14);
    for (let i = 0; i < n; i++) s += parts[rnd(parts.length)];
    inputs.push(s);
  }
  const php = phpClean(inputs);
  const mismatches = inputs.map((s, i) => [s, cleanCss(s), php[i]]).filter(([, a, b]) => a !== b);
  assert.deepEqual(mismatches, []);
});
