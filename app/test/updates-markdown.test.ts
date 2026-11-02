// Markdown der Updates (oys_markdown, oys_md_plain, oys_md_link, oys_md_emphasis) gegen die echten PHP-Funktionen der
// PHP-Version (siehe support/phpRef.ts): feste Fälle, gezielt feindliche Links und Zufallstexte – Byte für Byte gleich.
// Dazu die Zeichenklassen von PCRE2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { markdown, mdEmphasis, mdLink, mdPlain } from '../src/updates/markdown.js';
import { ASCII_WS, UCP_DIGIT, UCP_WORD, UCP_WS, ucpRanges } from '../src/updates/pcre.js';
import { random } from './fixtures/updates/random.js';
import { PHP_SKIP, phpFile, phpRoot } from './support/phpRef.js';

function php(code: string, input: unknown): unknown {
  const script = `require '${phpFile('lib/config.php')}'; date_default_timezone_set(oys_config('timezone', 'Europe/Berlin')); mb_internal_encoding('UTF-8');`
    + `require '${phpFile('lib/helpers.php')}'; require '${phpFile('lib/updates.php')}';`
    + `$in = json_decode(stream_get_contents(STDIN), true); $out = (function ($in) { ${code} })($in);`
    + 'echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);';
  return JSON.parse(execFileSync('php', ['-r', script], { input: JSON.stringify(input), cwd: phpRoot(), maxBuffer: 256 * 1024 * 1024 }).toString());
}

type Rendered = [string, string, string, string];
const render = (s: string): Rendered => [markdown(s), mdPlain(s, 280), mdPlain(s, 20), mdPlain(s, 1)];
const phpRender = (inputs: string[]): Rendered[] =>
  php('return array_map(function ($s) { return [oys_markdown($s), oys_md_plain($s, 280), oys_md_plain($s, 20), oys_md_plain($s, 1)]; }, $in);', inputs) as Rendered[];

// Lange Texte in der Fehlermeldung kürzen
const short = (s: string): string => (s.length > 160 ? s.slice(0, 120) + `…(${s.length})…` + s.slice(-30) : s);

function compare(inputs: string[]): void {
  const theirs = phpRender(inputs);
  const mismatches = inputs
    .map((s, i) => ({ input: short(JSON.stringify(s)), node: render(s), php: theirs[i] }))
    .filter((m) => JSON.stringify(m.node) !== JSON.stringify(m.php))
    .map((m) => ({ input: m.input, node: m.node.map(short), php: m.php.map(short) }))
    .slice(0, 5);
  assert.deepEqual(mismatches, []);
}

// Die Fälle aus der Spezifikation (md_golden.json) und weitere Grenzfälle
const CASES = [
  'Hello **bold** and *it* and _it2_ and ~~del~~ and `co*de*`', '# H1\n## H2\n### H3\n#### H4\n#nospace', '- a\n- b\n1. one\n2) two\n* star\n\u{2022} dot',
  'line1\nline2\n\nline3', '> quote\n>\n>no space', "```js\nlet a = '<b>';\n```\nafter", '```\nunclosed <x>',
  '[label](https://example.com/a_(b)) and [x](/dashboard) and [y](#roadmap) and [z](javascript:alert(1)) and [m](someone@example.com)',
  'see https://example.com/path. and (https://x.org/a_(b)) end, http://www.foo.com/!', '[**bold label**](https://a.b) [`code`](https://c.d)',
  'snake_case_word and 2 * 3 * 4 and *a* b', '  leading spaces\n\ttab line', 'a & b < c > d " e \' f', '1. x\n- y\n\n2. z',
  '[x](//evil.com) [y](example.org) [z](ftp://a.b)', '**unterminated and *one', '<script>alert(1)</script>', '*a*b *c* d*e*', '***both***', '__dunder__',
  '**\u{A0}x\u{A0}** and *\u{A0}y*', '# Title\u{2028}more', '\u{661}. arabic\n\u{663}) three', '>\u{A0}q', '-\u{A0}item',
  '[' + 'a'.repeat(200) + '](https://a.b)', '[' + 'a'.repeat(201) + '](https://a.b)', '[' + '\u{E4}'.repeat(100) + '](https://a.b)', '[' + '\u{E4}'.repeat(101) + '](https://a.b)',
  '[x](https://a.b/' + 'c'.repeat(470) + ')', '[x](https://a.b/' + 'c'.repeat(490) + ')', '[x](https://a.b/' + '\u{F6}'.repeat(240) + ')', '[x](https://a.b/' + '\u{F6}'.repeat(250) + ')',
  'a\x010\x02b', 'https://a.b/x\u{A0}y z', 'https://\u{E4}.de/\u{F6}?q=1&r=2', "https://a.b/it's", '[x](https://a.b/`c`)', '`[x](https://a.b)`', '[https://a.b](https://c.d)',
  '*https://a.b/x*', '_https://a.b/x_', '   ```\ncode\n   ```', '#   spaced   ', '#\tTab', '-item', '2026. Jahr', '~~ x ~~ ~~y~~', '**a *b* c**', '&amp; &lt;',
  '\u{FEFF}# not heading', 'a\n\u{A0}\nb', 'a\n\f\nb', 'a\rb\r\rc', 'a\r\nb\r\n\r\nc', 'https://a.b/x(y', 'mail me@a.b', '[x](/\\evil.com) [y](/ok)', '[top](#)',
  '[x](https://a.b "title")', 'Some **bold** and [link](https://a.b/c_(d)).\n- item one\n> quote\n```\nblock\n```\n1) last', '', ' ', '\n\n', 'x'.repeat(5000),
  '# Title\n\nSome **bold** and *it* and _u_ and ~~d~~ and `code` and [link](https://a.b/c_(d)).\n- item one\n> quote\n```\nblock\n```\n1) last',
  '\u{661}. arabic digit list\n  - indented bullet', 'word '.repeat(100), '\u{E4}'.repeat(300), 'a\u{A0}\u{A0}b\u{2028}c', '**a\nb**', '```unclosed\nfoo',
  // Ziffern, die Node (Unicode 16) kennt, PCRE2 10.42 aber nicht
  '\u{1E4F0}. Nag Mundari', '\u{11F50}) Kawi', '\u{1E950}. Adlam', '\u{FF11}. fullwidth',
  // Feindliche oder seltsame Ziele
  '[a](javascript:alert(document.cookie))', '[a](JaVaScRiPt:alert(1))', '[a]( javascript:alert(1))', '[a](java\tscript:x)', '[a](data:text/html;base64,PHNjcmlwdD4=)',
  '[a](vbscript:msgbox)', '[a](file:///etc/passwd)', '[a](//evil.com/x)', '[a](\\\\evil.com)', '[a](/\\evil.com)', '[a](/%2F/evil.com)', '[a](https:evil.com)',
  '[a](https://evil.com\\@good.com)', '[a](https://good.com@evil.com)', '[a](http://[::1]/)', '[a](https://localhost:8080/x)', '[a](localhost:8080)',
  '[a](mailto:x@y.z?subject=hi)', '[a](tel:+49 30 123)', '[a](+49 (30) 123-456)', '[a](00491234567)', '[a](HTTPS://X.Y)', '[a](#"onmouseover="alert(1))',
  '[a](/"onmouseover="x)', '[a](https://x.y/"><script>)', '[<img src=x onerror=alert(1)>](https://a.b)', '[a](https://x.y/a b)', '[a](https://x.y/a)b)',
  'https://x.y/"><script>alert(1)</script>', 'javascript:alert(1)', 'http://x.y/<b>', 'https://x.y/a_b_c_', 'https://x.y/**x**', 'https://x.y/~~a~~',
  'ftp://x.y/', 'www.example.com', 'https://', 'http://a', '[](https://a.b)', '[a]()', '[a](())', '[a]((x))', '[a](a(b)c(d)e)', '[a](a((b)))',
  // Rohes HTML, Entities, Emoji, Steuerzeichen
  '<img src=x onerror=alert(1)>', '<a href="javascript:x">y</a>', '&lt;script&gt;', '&#x3C;', '\u{1F41D} **\u{1F41D}** *\u{1F600}* _\u{1F44D}_', '\u{1F468}\u{200D}\u{1F4BB} dev',
  'e\u{301}t\u{E9} *e\u{301}*', 'a\x00b', 'tab\there', 'v\vt', '\x85line', 'x\x85y', '**\x85**', '* \x85 *', '>\x85q', '#\x85x',
  // Verschachtelte Platzhalter und Hervorhebungen
  '[`a` and `b`](https://x.y) `c`', '[**`x`**](/y)', '`a` `b` `c` [d](e.f)', '**[a](https://b.c)**', '*[a](https://b.c)*', '_[a](https://b.c)_', '~~`x`~~',
  '***a** b*', '*a **b***', '_a *b* c_', '**a**b**c**', '*a*b*', 'a*b*c', 'a_b_c', '*_a_*', '_*a*_', '~~~a~~~', '****', '**', '* *', '_ _',
  // Die Fälle aus tests/unit.php
  '**Hi** <img src=x onerror=alert(1)>', '[x](javascript:alert(1))', '[OnYourSite](https://on-your.site)', '[x](https://a.de/"onmouseover=alert(1))',
  '## New\n- a\n- b', '`**<b>**`', 'See https://a.de/x.', '*https://a.de/x_y_z*', '**https://a.de/x**', 'https://en.wikipedia.org/wiki/Foo_(bar)',
  '(see https://a.de/x)', '[wiki](https://en.wikipedia.org/wiki/Foo_(bar))', '[editor](/dashboard)', '[roadmap](#roadmap)', '[a](https://x.com/`b`)',
  'Use snake_case and /updates#roadmap, **bold** and _it_', '**Bold** [link](https://x.de)\n`code`',
];

test('markdown: fixed cases match PHP byte for byte', { skip: PHP_SKIP }, () => {
  compare(CASES);
});

test('markdown: random documents match PHP byte for byte', { skip: PHP_SKIP }, () => {
  const parts = ['# ', '## ', '### ', '#### ', '#', '- ', '* ', '\u{2022} ', '1. ', '2) ', '10. ', '\u{661}. ', '\u{1E950}) ', '\u{1E4F0}. ', '> ', '>', '```', '```js',
    '`', '**', '*', '_', '__', '~~', '~', '[', ']', '(', ')', '](', '[x](https://a.b/c)', '[lbl](/path)', '[top](#)', '[m](mail@x.de)', '[j](javascript:alert(1))',
    '[e](//evil.com)', '[b](/\\evil.com)', '[d](data:text/html,x)', '[t](tel:+491234567)', '[f](ftp://x.y)', 'https://example.com/a_(b)', 'http://www.foo.com/!',
    'HTTPS://X.Y/', 'https://\u{E4}.de/\u{F6}', 'www.x.de', '<script>', '</b>', '&amp;', '&', '"', "'", '\n', '\n', '\n', '\r\n', '\r', ' ', ' ', '  ', '\t',
    '\u{A0}', '\u{2028}', '\x85', '\u{FEFF}', '\u{180E}', '\u{3000}', '\f', '\v', '\x01', '\x02', '\0', '\u{E4}', '\u{F6}', '\u{105}', '\u{C5}', '\u{1F41D}', '\u{1F600}',
    'x', 'word', 'snake_case', '2 * 3', 'a', 'b', '.', ',', '!', '?', ':', ';', '|', '\\', '\u{301}', '0', '9', '@', 'mail@x.de'];
  const rnd = random(20261101);
  const inputs: string[] = [];
  for (let k = 0; k < 4000; k++) {
    let s = '';
    const n = 1 + rnd(k % 10 === 0 ? 120 : 24);
    for (let i = 0; i < n; i++) s += parts[rnd(parts.length)];
    inputs.push(s);
  }
  compare(inputs);
});

test('markdown: random emphasis, code and link soup matches PHP byte for byte', { skip: PHP_SKIP }, () => {
  // Kleiner Vorrat, damit Paare von *, **, _, ~~, ` und Klammern oft aufeinandertreffen
  const parts = ['*', '**', '_', '__', '~~', '`', 'a', 'b', ' ', ' ', '\u{A0}', '[', ']', '(', ')', 'https://x.y', '/p', '#t', '\u{E4}', '\n', '\x01', '1', '&', '<'];
  const rnd = random(777);
  const inputs: string[] = [];
  for (let k = 0; k < 4000; k++) {
    let s = '';
    const n = 2 + rnd(30);
    for (let i = 0; i < n; i++) s += parts[rnd(parts.length)];
    inputs.push(s);
  }
  compare(inputs);
});

test('markdown: very long links fail like the JIT stack of PCRE in PHP', { skip: PHP_SKIP }, () => {
  // PHP bricht bei sehr langen Adressen mit „JIT stack limit exhausted“ ab: die Zeile bzw. der Klartext wird leer.
  // Gezählt wird je Durchlauf der Gruppe (Byte oder (…)-Gruppe) – hier genau an den Grenzen und knapp darüber.
  const x = (n: number): string => 'x'.repeat(n);
  const inputs = [
    'https://a.b/' + x(8187), 'https://a.b/' + x(8188), 'https://' + '.'.repeat(8191), 'https://' + '.'.repeat(8192), 'https://a.b/' + x(8186) + '.',
    'https://a.b/' + x(8187) + '.', 'https://a.b/' + '\u{E4}'.repeat(4093), 'https://a.b/' + '\u{E4}'.repeat(4094), 'https://a.b/' + '(x)'.repeat(8187),
    'https://a.b/' + '(x)'.repeat(8188), 'https://a.b/' + '\u{1F41D}'.repeat(2047) + 'xxx', 'https://a.b/' + '\u{1F41D}'.repeat(2047) + 'xxxx',
    'HTTP://' + x(8185), 'HTTP://' + x(8192), 'xhttps://' + x(9000), 'https:' + x(9000), 'see https://a.b/' + x(9000) + ' and more\nnext **line**',
    '`code` [a](https://b.c) https://a.b/' + x(9000), '- https://a.b/' + x(9000) + '\n- two', '# https://a.b/' + x(9000), '> https://a.b/' + x(9000),
    'https://a.b https://' + x(9000), 'https://a.b/' + x(5000) + ' https://c.d/' + x(5000), '_https://a.b/' + x(9000) + '_',
    '[a](' + x(8190) + ')', '[a](' + x(8191) + ')', '[a](' + x(8190) + ' )', '[a](' + x(8191) + ' )', '[a](' + x(9000), ')[a](' + x(9000),
    '[a](' + x(9000) + '\n)', '[a](b) [c](' + x(9000) + ')', '[' + 'l'.repeat(150) + '](' + x(8191) + ')', '[a](' + '(x)'.repeat(8191) + ')',
    '[a](' + '\u{F6}'.repeat(4095) + ')', '[a](' + '\u{F6}'.repeat(4096) + ')', '```\n[a](' + x(9000) + ')\n```', '`[a](' + x(9000) + ')`',
    '**bold** [a](' + x(9000) + ') more', 'z'.repeat(9000) + '[a](' + x(9000) + ')',
  ];
  compare(inputs);
});

test('markdown: random long links around the JIT limit match PHP', { skip: PHP_SKIP }, () => {
  // Läufe aus 1- bis 4-Byte-Zeichen, (…)-Gruppen und Satzzeichen am Ende, knapp unter und über den Grenzen
  const parts = ['x', 'x', 'x', '\u{E4}', '\u{20AC}', '\u{1F41D}', '(y)', '()', '.', '_', '-', '/', '?', '&', '=', '[', ']'];
  // Für nackte Adressen ohne [ und ] – sonst entstehen darin [Links](…), deren Platzhalter den Lauf teilen
  const urlParts = parts.filter((p) => p !== '[' && p !== ']');
  const rnd = random(8191);
  const run = (bytes: number, from = parts): string => {
    let s = '';
    let n = 0;
    while (n < bytes) {
      const p = from[rnd(from.length)];
      s += p;
      n += p.startsWith('(') ? 1 : Buffer.byteLength(p);
    }
    return s;
  };
  const inputs: string[] = [];
  for (let k = 0; k < 120; k++) {
    const len = 8180 + rnd(24);
    const tail = ['', '.', '..', ' end', ')', ' )', '\nnext'][rnd(7)];
    const pre = ['', 'see ', '[a](https://b.c) ', '`c` ', 'https://a.b ', '[x](y) ', ')'][rnd(7)];
    inputs.push(k % 2 ? pre + 'https://a.b/' + run(len - 4, urlParts) + tail : pre + '[lbl](' + run(len) + tail);
  }
  compare(inputs);
});

// JavaScript verfolgte /\[([^\]\n]+)\]\(/ von jedem „[“ aus zurück – bei 20 000 Zeichen fast zwei Sekunden (PHP: 1 ms)
const FLOODS = (): string[] => {
  const n = 20000;
  return ['['.repeat(n - 1) + ')', '['.repeat(n), '[a'.repeat(n / 2 - 1) + ')', ('['.repeat(99) + '\n').repeat(n / 100) + ')',
    ('[' + 'a'.repeat(300)).repeat(n / 301) + ')', '](' .repeat(n / 2), '[a](' + '('.repeat(n - 6) + ')', '[a](x' + '[b](y)'.repeat(n / 6) + ' )'];
};

test('markdown: floods of [ stay fast in the plain text', () => {
  for (const s of FLOODS()) {
    const t = performance.now();
    mdPlain(s, 280);
    assert.ok(performance.now() - t < 500, `too slow for ${JSON.stringify(s.slice(0, 20))}`);
  }
});

test('markdown: floods of [ match PHP', { skip: PHP_SKIP }, () => {
  compare(FLOODS());
});

test('markdown: links and emphasis on their own match PHP', { skip: PHP_SKIP }, () => {
  const urls = ['/', '/dashboard', '//evil.com', '/\\evil.com', '#', '#roadmap', '#"x', 'https://a.b', 'example.org', 'someone@example.com', 'javascript:alert(1)',
    'ftp://a.b', 'mailto:a@b.c', 'tel:+4912345', '+49 123 4567', 'data:x', 'https://a.b/\u{E4}', 'HTTP://A.B', '', ' ', 'https://a.b/"<>', '\u{FF0F}x'];
  const labels = ['x', '<b>&amp;', '**y**'];
  const ours = urls.flatMap((u) => labels.map((l) => mdLink(u, l)));
  assert.deepEqual(ours, php('$r = []; foreach ($in[0] as $u) foreach ($in[1] as $l) $r[] = oys_md_link($u, $l); return $r;', [urls, labels]));
  const texts = CASES.filter((c) => !c.includes('\n'));
  assert.deepEqual(texts.map(mdEmphasis), php('return array_map("oys_md_emphasis", $in);', texts));
});

test('the Unicode classes are exactly those of PCRE2 in PHP', { skip: PHP_SKIP }, () => {
  const theirs = php(`$sets = []; foreach (['d' => '/^\\d$/u', 'w' => '/^\\w$/u', 's' => '/^\\s$/u'] as $name => $re) {
      $r = []; $start = null; $prev = null;
      for ($cp = 0; $cp <= 0x10FFFF; $cp++) { if ($cp >= 0xD800 && $cp <= 0xDFFF) continue;
        if (preg_match($re, mb_chr($cp, 'UTF-8'))) { if ($start === null) $start = $cp; $prev = $cp; } elseif ($start !== null) { $r[] = [$start, $prev]; $start = null; } }
      if ($start !== null) $r[] = [$start, $prev]; $sets[$name] = $r; } return $sets;`, null) as Record<string, Array<[number, number]>>;
  assert.deepEqual(ucpRanges('d'), theirs.d);
  assert.deepEqual(ucpRanges('w'), theirs.w);
  // Und die daraus gebauten Muster treffen genau diese Zeichen
  const ranges = (re: RegExp): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      if (!re.test(String.fromCodePoint(cp))) continue;
      const last = out[out.length - 1];
      if (last && last[1] === cp - 1) last[1] = cp;
      else out.push([cp, cp]);
    }
    return out;
  };
  assert.deepEqual(ranges(new RegExp(`^[${UCP_DIGIT}]$`, 'u')), theirs.d);
  assert.deepEqual(ranges(new RegExp(`^[${UCP_WORD}]$`, 'u')), theirs.w);
  assert.deepEqual(ranges(new RegExp(`^[${UCP_WS}]$`, 'u')), theirs.s);
  assert.deepEqual(ranges(new RegExp(`^[${ASCII_WS}]$`)), [[9, 13], [32, 32]]);
});
