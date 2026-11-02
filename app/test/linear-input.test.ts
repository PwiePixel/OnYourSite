// Eingaben von außen in linearer Zeit: Jeder POST (urlencoded oder multipart) wird vor dem Routing und ohne Anmeldung
// gelesen, mb_strlen()/mb_substr() laufen auf ganzen Formularfeldern (Link-Passwort, eigenes CSS), oys_clean_text(),
// oys_normalize_slug() und strtolower() auf Feldern von Kontaktformular, Registrierung und Anmeldung, e() auf
// zurückgegebenen Werten. Mit 20 MB brauchten bestimmte Formen Sekunden bis
// eine halbe Minute oder sprengten den Speicher: replace() und parseInt() je Treffer, ein Teiltext je rohem Byte,
// Array.from() über den ganzen Text, Aufwand je Zeile und je Teil in multipart. Hier:
// 1. die neuen Fassungen liefern für feste, vollständig aufgezählte und zufällige Eingaben genau dasselbe wie die
//    früheren (unverändert in test/support/oldInput.ts, oldMultipart.ts und oldCore.js),
// 2. dasselbe wie PHP (parse_str, rawurldecode, mb_strlen, mb_substr),
// 3. jede Form braucht mit 20 MB deutlich unter einer Sekunde.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as now from '../src/php.js';
import * as before from './support/oldInput.js';
import { phpMultipart } from '../src/web/multipart.js';
import { phpMultipart as phpMultipartBefore } from './support/oldMultipart.js';
import * as compat from '../src/compat/core.js';
import * as compatBefore from './support/oldCore.js';
import { readBody } from '../src/server.js';
import { makeTestCtx } from '../src/web/ctx.js';
import { PHP_SKIP } from './support/phpRef.js';

// Fester Zufall (wiederholbar)
function rng(seed: number): (n: number) => number {
  let s = seed >>> 0;
  return (n: number) => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return (s >>> 8) % n;
  };
}

// Text als Folge der UTF-16-Einheiten (auch einzelne Surrogate bleiben sichtbar); Objekte mit ihren Schlüsseln in der
// Reihenfolge, in der sie stehen
const units = (s: string): string => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i).toString(16)).join('.');
const show = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === 'string' ? units(x) : x instanceof Map ? [...x.entries()] : x));

// PHP-Bezug: nur eingebaute Funktionen; Ein- und Ausgaben als JSON, Bytes als Hex
function php(code: string, input: unknown): unknown {
  const script = `mb_internal_encoding('UTF-8'); $in = json_decode(stream_get_contents(STDIN), true); $out = (function ($in) { ${code} })($in); echo json_encode($out);`;
  return JSON.parse(execFileSync('php', ['-r', script], { input: JSON.stringify(input), maxBuffer: 1 << 28 }).toString());
}

// Bausteine für Bytes: gültige Folgen aller Längen, abgeschnittene, zu lange Formen, Surrogate, > U+10FFFF, BOM, ASCII
// mit Bedeutung in Formularen (& = % + [ ] . Leerzeichen NUL) und Hex-Ziffern
const PIECES = [[0x61], [0x20], [0x0a], [0x25], [0x2b], [0x5b], [0x5d], [0x2e], [0x00], [0x3d], [0x26], [0x41], [0x66], [0x30], [0x39],
  [0xc3, 0xa4], [0xe2, 0x82, 0xac], [0xf0, 0x9f, 0x98, 0x80], [0xef, 0xbb, 0xbf], [0xef, 0xbf, 0xbd], [0xff], [0xfe], [0xc3], [0xe2, 0x82],
  [0xed, 0xa0, 0x80], [0xed, 0x9f, 0xbf], [0xf4, 0x90, 0x80, 0x80], [0xf4, 0x8f, 0xbf, 0xbf], [0xc0, 0xaf], [0xc1], [0xc2], [0x80], [0xbf],
  [0xe0, 0x80], [0xe0, 0xa0], [0xf0, 0x90], [0xf0, 0x80], [0xf5], [0xf1, 0x80, 0x80], [0xf3], [0xdf], [0xe1, 0xbf]];
const randomBytes = (r: (n: number) => number, count: number, max: number): Buffer[] =>
  Array.from({ length: count }, () => Buffer.from(Array.from({ length: r(max + 1) }, () => PIECES[r(PIECES.length)]).flat()));

// Bausteine für Texte (UTF-16): rohe Bytes U+DC80–U+DCFF, Paare, einzelne Surrogate, %-Folgen, Zeichen mit Bedeutung
const UNITS = ['a', '%', '+', '[', ']', '.', ' ', '\0', '=', '&', 'A', 'f', '0', '9', 'G', '%4', '%41', '%c3%a4', '%FF', '%E2%82', '%ED%A0%80',
  '%5B', '%2E', '%20', '%00', 'ä', '€', '😀', '\uDCFF', '\uDC80', '\uDCC3', '\uDCA4', '\uDCE2', '\uDC82', '\uD800', '\uDBFF', '\uDC00', '\uDC7F',
  '\uDD00', '\uDFFF', '\uD83D', '\uDE00', '\t', '\n', '\v', '\r', '\f', ' ', '_', '-', '1'];
const randomTexts = (r: (n: number) => number, count: number, max: number): string[] =>
  Array.from({ length: count }, () => Array.from({ length: r(max + 1) }, () => UNITS[r(UNITS.length)]).join(''));

// Alle Folgen aus ein und zwei Bytes (das zweite bei ASCII-Anfang in Stufen) und ausgewählte aus drei und vier
function enumeratedBytes(): Buffer[] {
  const out: Buffer[] = [];
  for (let a = 0; a < 256; a++) {
    out.push(Buffer.of(a));
    for (let b = 0; b < 256; b += a >= 0xc0 ? 1 : 17) out.push(Buffer.of(a, b));
  }
  const leads = [0x00, 0x7f, 0x80, 0xbf, 0xc0, 0xc1, 0xc2, 0xdf, 0xe0, 0xe1, 0xec, 0xed, 0xee, 0xef, 0xf0, 0xf1, 0xf3, 0xf4, 0xf5, 0xff];
  const tails = [0x00, 0x41, 0x7f, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc0, 0xc2, 0xe0, 0xf0, 0xff];
  for (const a of leads) {
    for (const b of tails) {
      for (const c of tails) {
        out.push(Buffer.of(a, b, c));
        for (const d of tails) out.push(Buffer.of(a, b, c, d));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- 1. genau wie früher

test('bytes to text and back: exactly as before, for every short byte sequence and random input', () => {
  const r = rng(1);
  for (const b of [...enumeratedBytes(), ...randomBytes(r, 20000, 14)]) {
    const s = before.phpText(b);
    assert.equal(units(now.phpText(b)), units(s), b.toString('hex'));
    assert.deepEqual(now.phpBytes(s), before.phpBytes(s), b.toString('hex'));
  }
  // Texte, die nicht aus phpText() kommen: Paare, einzelne Surrogate neben rohen Bytes (einzelne werden EF BF BD)
  for (const s of randomTexts(r, 30000, 12)) assert.deepEqual(now.phpBytes(s), before.phpBytes(s), units(s));
  for (const s of ['𐂀', '\uD800𐂀', '\uDC80\uDC80', '􏳿\uDCFF', 'a\uDCFF😀\uD83D', '\uDCFF\uDC00\uDFFF']) {
    assert.deepEqual(now.phpBytes(s), before.phpBytes(s), units(s));
  }
});

test('mb_strlen and mb_substr: exactly as before, for every kind of start and length', () => {
  const r = rng(2);
  // Texte aus Bytes (mit rohen Bytes), freie UTF-16-Texte und lange Texte, bei denen mb_substr() nur den Anfang liest
  const texts = [...randomBytes(r, 6000, 12).map((b) => before.phpText(b)), ...randomTexts(r, 12000, 12)];
  const long = ['\uDCFF', '\uDCC3', '\uDCA4', '\uDCE2', '\uDC82', '\uDCF0', '\uDC9F', 'a', 'ä', '😀', '\uD83D', '\uDE00', '\uD800', '€'];
  for (let i = 0; i < 4000; i++) texts.push(Array.from({ length: 30 + r(90) }, () => long[r(long.length)]).join(''));
  const odd = [NaN, Infinity, -Infinity, 0.5, 1.5, -0.5, -1.5, 2.7, -0, 1e20, -1e20];
  for (const s of texts) {
    assert.equal(now.mbStrlen(s), before.mbStrlen(s), units(s));
    for (let k = 0; k < 3; k++) {
      const start = r(24) - 12;
      const len = r(24) - 12;
      assert.equal(units(now.mbSubstr(s, start, len)), units(before.mbSubstr(s, start, len)), `${units(s)} ${start} ${len}`);
      // Anfang und Länge ab 0: mit rohen Bytes wird nur der Anfang des Texts gelesen
      const from = r(30);
      const count = r(12);
      assert.equal(units(now.mbSubstr(s, from, count)), units(before.mbSubstr(s, from, count)), `${units(s)} ${from} ${count}`);
    }
    const start = r(16);
    const len = r(8);
    assert.equal(units(now.mbSubstr(s, start, len)), units(before.mbSubstr(s, start, len)), `${units(s)} ${start} ${len}`);
    assert.equal(units(now.mbSubstr(s, start)), units(before.mbSubstr(s, start)), `${units(s)} ${start}`);
    const a = odd[r(odd.length)];
    const b = odd[r(odd.length)];
    for (const [x, y] of [[a, len], [start, b], [a, b], [a, undefined], [start, null]] as Array<[number, number | undefined]>) {
      assert.equal(units(now.mbSubstr(s, x, y)), units(before.mbSubstr(s, x, y)), `${units(s)} ${x} ${y}`);
    }
  }
});

test('ASCII case and HTML substitution of invalid UTF-8: exactly as before', () => {
  const r = rng(8);
  for (const s of [...randomTexts(r, 20000, 12), ...randomBytes(r, 3000, 10).map((b) => b.toString('latin1')), 'ÄÖÜ äöü ẞß', 'Ǆǅǆ', 'İı', 'ﬀ']) {
    assert.equal(units(now.strtolower(s)), units(before.strtolower(s)), units(s));
    assert.equal(units(now.strtoupper(s)), units(before.strtoupper(s)), units(s));
    assert.equal(units(now.ucfirst(s)), units(before.ucfirst(s)), units(s));
  }
  for (const b of [...enumeratedBytes(), ...randomBytes(r, 20000, 14)]) {
    assert.equal(units(now.phpUtf8Substitute(b)), units(before.phpUtf8Substitute(b)), b.toString('hex'));
  }
});

test('rawurldecode, form decoding and field names: exactly as before', () => {
  const r = rng(3);
  const texts = [...randomTexts(r, 40000, 14), ...randomBytes(r, 3000, 10).map((b) => b.toString('latin1'))];
  texts.push('a[b[c=1', 'a[b[c]=1', 'a[b]c[d=1', 'a.b[c.d=1', 'a b[c d=1', 'a[=1', ' a.b c[x. y]=1', '\0a=1', 'a\0b=1', 'a[]=1&a[]=2&a[5]=3&a[]=4',
    'a[x][y][]=1&a[x][y][]=2', '[a]=1', 'a]=1', '=1', '&&&', '%41%4=%3', '+%2B+=+%20+');
  for (const s of texts) {
    assert.equal(units(now.rawurldecode(s)), units(before.rawurldecode(s)), units(s));
    assert.equal(show(now.parseStr(s)), show(before.parseStr(s)), units(s));
    assert.equal(show(now.parseStr(s, true)), show(before.parseStr(s, true)), units(s));
    const mine = {};
    const theirs = {};
    now.setPhpVar(mine, s, 'v');
    before.setPhpVar(theirs, s, 'v');
    assert.equal(show(mine), show(theirs), units(s));
  }
  // Tiefe Namen (64 Ebenen), viele Variablen (1000 bzw. 1001 Stücke)
  for (const s of ['a' + '[]'.repeat(63) + '=1', 'a' + '[]'.repeat(64) + '=1', 'a' + '[x]'.repeat(70) + '=1', 'a=1&'.repeat(1003), '&'.repeat(5) + 'x[]=1&'.repeat(1100),
    'k%C3[]=%E2%82&&'.repeat(600)]) {
    assert.equal(show(now.parseStr(s)), show(before.parseStr(s)));
    assert.equal(show(now.parseStr(s, true)), show(before.parseStr(s, true)));
  }
});

test('form bodies read as bytes give exactly what parse_str gave on the text of the whole body', async () => {
  const r = rng(4);
  const form = [...PIECES, [0x26], [0x26], [0x3d], [0x25, 0x34, 0x31], [0x25, 0x46, 0x46], [0x25, 0x63, 0x33], [0x25, 0x41, 0x34], [0x25, 0x32, 0x42],
    [0x25, 0x35, 0x42], [0x25, 0x30, 0x30], [0x5b, 0x5d]];
  const bodies = Array.from({ length: 30000 }, () => Buffer.from(Array.from({ length: r(18) }, () => form[r(form.length)]).flat()));
  bodies.push(Buffer.from('a=1&'.repeat(1003), 'latin1'), Buffer.from('a[]=%FF&'.repeat(1001) + 'b=2', 'latin1'), Buffer.alloc(0),
    Buffer.concat([Buffer.from('%'), Buffer.alloc(100, 0xff), Buffer.from('=%41'), Buffer.from([0xe2, 0x82]), Buffer.from('&+=+')]));
  for (const b of bodies) {
    const ref = show(before.parseStr(before.phpText(b), true));
    assert.equal(show(now.parseFormBody(b)), ref, b.toString('hex'));
    const ctx = makeTestCtx({ method: 'POST', url: '/' });
    await readBody(ctx, 'application/x-www-form-urlencoded', b);
    assert.equal(show(ctx.post), ref, b.toString('hex'));
  }
});

// multipart: Inhalte aus Bausteinen, meist gültige Teile mit Feldern und Dateien, dazu kaputte Köpfe, Fortsetzungszeilen,
// Anführungszeichen und \ in Content-Disposition, Nullbytes, CR ohne LF, Grenzen mitten im Inhalt
function randomMultipart(r: (n: number) => number, bd: string): string {
  const pick = <T>(a: T[]): T => a[r(a.length)];
  const eol = (): string => pick(['\r\n', '\r\n', '\r\n', '\n', '\r', '']);
  const name = (): string => pick(['a', 'f[]', 'x[y]', 'a[', 'a]', 'MAX_FILE_SIZE', 'ä', '\xff\xfe', 'a b.c', '', 'f[][x]', 'n\0x', 'f[a][b]', '[x]', 'a\\"b', 'n;m', 'x=y']);
  const param = (): string => pick([`name="${name()}"`, `name="${name()}"`, `name=${name()}`, `filename="${pick(['a.txt', '', 'x/y\\z.png', 'ü.bin', 'a"b', 'c;d', 'e=f'])}"`,
    `NAME="${name()}"`, 'filename=x', "name='q'", 'name', '=x', 'name==a', 'foo="a;b"', 'name="a\\"b"', "name='a\\'b'", 'name="a\\\\"', 'x="=";name=z', 'name="unclosed']);
  const cd = (): string => 'Content-Disposition:' + pick([' ', '', '  ', '\t']) + pick(['form-data', 'form-data', 'FORM-DATA', 'attachment', ''])
    + Array.from({ length: 1 + r(3) }, () => pick([';', '; ', ';;', ' ;', ';\t']) + param()).join('');
  const header = (): string => pick([cd(), cd(), cd(), 'Content-Type: ' + pick(['text/plain', 'image/png; x=y', '']), 'content-type:a/b', 'X-Foo: bar', ' continued',
    '\tcont; name="c"', 'nocolon', ':', 'Content-Disposition', 'Content-Disposition: form-data; na', 'me="z"', 'CONTENT-DISPOSITION: form-data; name="u"']);
  const value = (): string => pick(['', 'v', 'hello world', '\r', '\n', '--' + bd, '\r\n--' + bd + 'x', '\xff\xc3', 'ä€', '123', '\0', 'x'.repeat(r(40)), '\n--', '\r\n-', '10']);
  let out = pick(['', '', 'preamble\r\n', '\r\n', '--' + bd + 'junk\r\n']);
  const parts = r(7);
  for (let p = 0; p < parts; p++) {
    out += '--' + bd + pick(['', '', '', ' ', '\0x']) + eol();
    const hs = r(4);
    for (let h = 0; h < hs; h++) out += header() + eol();
    out += eol() + value() + pick(['\r\n', '\r\n', '\n', '', '\r\n\r\n']);
  }
  return out + pick(['--' + bd + '--', '--' + bd + '--\r\n', '', '--' + bd, 'tail']);
}

test('multipart bodies give exactly what they gave before: fields, files, limits, buffer edges', () => {
  const r = rng(5);
  const check = (type: string, body: Buffer, max = 16 * 1024 * 1024): void => {
    assert.equal(show(phpMultipart(type, body, max)), show(phpMultipartBefore(type, body, max)), JSON.stringify([type, body.toString('latin1').slice(0, 300), max]));
  };
  let fields = 0;
  for (let i = 0; i < 25000; i++) {
    const bd = ['b', 'XyZ', 'a"b', 'ab\0c', '-', 'bb'][r(6)];
    const type = [`multipart/form-data; boundary=${bd}`, `multipart/form-data; boundary="${bd}"`, `multipart/form-data; boundary=${bd},x`][r(3)];
    const body = Buffer.from(randomMultipart(r, bd), 'latin1');
    const max = [16 * 1024 * 1024, 5, 30, 0][r(4)];
    check(type, body, max);
    const form = phpMultipart(type, body, max);
    if (form && Object.keys(form.post).length + Object.keys(form.filesVars).length > 0) fields++;
  }
  // Die Zufallsinhalte ergeben oft wirklich Felder und Dateien
  assert.ok(fields > 5000, String(fields));

  // Zeilen über die Puffergröße (5 KB), Grenzen beim Nachfüllen, lange Grenzen (andere Suche ab 251 Zeichen), Grenzen
  // mit Nullbyte, viele Teile ohne Kopf, viele Fortsetzungs- und Kopfzeilen, Grenzwerte (1000 Felder, 20 Dateien)
  const t = 'multipart/form-data; boundary=b';
  const part = (h: string, v: string): string => `--b\r\n${h}\r\n\r\n${v}\r\n`;
  const fixed = [
    part('Content-Disposition: form-data; name="a"', 'x'.repeat(5118)) + part('Content-Disposition: form-data; name="b"', 'y'.repeat(5119)) + '--b--',
    part('Content-Disposition: form-data; name="a"' + ' '.repeat(5200), 'v') + '--b--',
    part('X-Long: ' + 'x'.repeat(5200) + ':y', 'v') + part('Content-Disposition: form-data; name="b"', 'w') + '--b--',
    '--b' + 'x'.repeat(5200) + '\r\n--b\r\nContent-Disposition: form-data; name="a"\r\n\r\nv\r\n--b--',
    'x'.repeat(5117) + '\n--b\r\nContent-Disposition: form-data; name="a"\r\n\r\nv\r\n--b--',
    '--b\r\n\r\n'.repeat(3000) + part('Content-Disposition: form-data; name="a"', 'v') + '--b--',
    '--b\n\n'.repeat(3000) + '--b\nContent-Disposition: form-data; name="z"\n\nv\n--b--',
    '--b\r\nContent-Disposition: form-data; name="a"\r\n' + ' x\r\n'.repeat(3000) + '\r\nv\r\n--b--',
    '--b\r\nContent-Disposition: form-data' + ';a=b'.repeat(3000) + '; name="a"\r\n\r\nv\r\n--b--',
    '--b\r\n' + 'X: y\r\n'.repeat(3000) + 'Content-Disposition: form-data; name="q"\r\n\r\nv\r\n--b--',
    '--b\n' + ':\n'.repeat(3000) + 'Content-Disposition: form-data; name="q"\n\nv\n--b--',
    Array.from({ length: 1003 }, (_, i) => part(`Content-Disposition: form-data; name="f${i}"`, String(i))).join('') + '--b--',
    Array.from({ length: 23 }, (_, i) => part(`Content-Disposition: form-data; name="u[]"; filename="f${i}.txt"\r\nContent-Type: text/plain`, 'data' + i)).join('') + '--b--',
    part('Content-Disposition: form-data; name="MAX_FILE_SIZE"', '3') + part('Content-Disposition: form-data; name="f"; filename="a.txt"', 'four') + '--b--',
    part('Content-Disposition: form-data; name="a\0b"; filename="c\0d"', 'v') + '--b\0x\r\n' + part('Content-Disposition: form-data; name="n"', 'w') + '--b--',
    part('Content-Disposition: form-data; name="' + '\\"'.repeat(3000) + '"', 'v') + '--b--',
    part('Content-Disposition: form-data; x' + '";"'.repeat(3000) + '; name="a"', 'v') + '--b--',
  ];
  for (const body of fixed) check(t, Buffer.from(body, 'latin1'));
  const long = 'L'.repeat(300);
  const longFirst = 'Lx'.repeat(150);
  for (const bd of [long, longFirst]) {
    check(`multipart/form-data; boundary=${bd}`, Buffer.from(`--${bd}\r\nContent-Disposition: form-data; name="a"\r\n\r\n` + 'x'.repeat(6000) + `\r\n--${bd}\r\n`
      + `Content-Disposition: form-data; name="f"; filename="z"\r\n\r\n` + `\n--${bd.slice(0, 200)}`.repeat(40) + `\r\n--${bd}--`, 'latin1'));
  }
});

test('cleaning text, URLs and addresses: exactly as before', () => {
  const r = rng(7);
  const parts = ['a', 'A', 'Z', 'z', '0', '9', '-', '_', '.', '/', ':', '@', '+', '(', ')', ' ', '\t', '\n', '\r', '\r\n', '\n\n\n', '\v', '\f', '\0', '\x01', '\x1f',
    '\x7f', '\x85', '\x9f', '\xa0', '\u1680', '\u180e', '\u2000', '\u200a', '\u200b', '\u2028', '\u2029', '\u202a', '\u202e', '\u202f', '\u205f', '\u2066', '\u2069',
    '\u3000', 'ä', '€', '😀', '\uD800', '\uDC00', '\uDCFF', 'http://', 'https://', 'www.', 'mailto:', 'tel:', '00', 'x.de', 'a@b.de', '%20', '#', '?', '[', ']', '\\', '"'];
  const show = (v: unknown): string => JSON.stringify(v);
  for (let i = 0; i < 40000; i++) {
    const s = Array.from({ length: r(14) }, () => parts[r(parts.length)]).join('');
    const max = [255, 5, 0, 2000, 3][r(5)];
    for (const multiline of [false, true]) assert.equal(show(compat.oysCleanText(s, max, multiline)), show(compatBefore.oysCleanText(s, max, multiline)), show(s));
    for (const relative of [false, true]) assert.equal(show(compat.oysCleanUrl(s, relative)), show(compatBefore.oysCleanUrl(s, relative)), show(s));
    assert.equal(show(compat.oysNormalizeSlug(s)), show(compatBefore.oysNormalizeSlug(s)), show(s));
    assert.equal(show(compat.asciiLower(s)), show(compatBefore.asciiLower(s)), show(s));
    assert.equal(show(compat.phpParseUrl(s)), show(compatBefore.phpParseUrl(s)), show(s));
    assert.equal(show(compat.phpFilterValidateUrl(s)), show(compatBefore.phpFilterValidateUrl(s)), show(s));
  }
  for (const v of [null, undefined, 12, 1.5, true, false, [], {}, ['a'], 1e400, -0, '\r\n\r\n\r\n x \r\n\r\n', '+49 (0) 30-1234', '0049/30 12 34']) {
    assert.equal(show(compat.oysCleanText(v, 255, true)), show(compatBefore.oysCleanText(v, 255, true)));
    assert.equal(show(compat.oysCleanUrl(v)), show(compatBefore.oysCleanUrl(v)));
    assert.equal(show(compat.oysNormalizeSlug(v)), show(compatBefore.oysNormalizeSlug(v)));
  }
});

// ---------------------------------------------------------------- 2. wie PHP

const hex = (s: string): string => now.phpBytes(s).toString('hex');
// $_POST/$_GET als Hex, Schlüssel sortiert (PHP-Arrays und JavaScript-Objekte ordnen Zahlen-Schlüssel verschieden)
const hexTree = (v: now.PhpValue): unknown => (typeof v === 'string' ? hex(v)
  : Object.entries(v).map(([k, x]) => [hex(k), hexTree(x)]).sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1)));

test('the same as PHP: parse_str, rawurldecode, mb_strlen and mb_substr', { skip: PHP_SKIP }, () => {
  const r = rng(6);
  // parse_str() liest seinen Text wie PHP bis zum ersten Nullbyte (php_default_treat_data mit strtok), $_POST
  // (add_post_var) liest weiter – verglichen wird darum ohne rohes Nullbyte (als %00 schon)
  const form = [...PIECES.filter((p) => p[0] !== 0), [0x26], [0x3d], [0x25, 0x34, 0x31], [0x25, 0x46, 0x46], [0x25, 0x63, 0x33], [0x25, 0x41, 0x34], [0x25, 0x35, 0x42],
    [0x5b, 0x5d], [0x25, 0x30, 0x30]];
  const bodies = Array.from({ length: 3000 }, () => Buffer.from(Array.from({ length: r(14) }, () => form[r(form.length)]).flat()));
  // Lange Namen und Werte aus den Formen, die früher langsam waren (in kleiner Größe)
  for (const unit of ['[', '.', ' ', '+', '%41', '%FF', '%C3', '%00', '%5B']) {
    bodies.push(Buffer.from('a' + unit.repeat(500) + '=1&b=' + unit.repeat(500) + '&a[' + unit.repeat(300) + '=2', 'latin1'));
  }
  // rawurldecode(): gültige Texte mit %-Folgen (das Ergebnis liest die Seite wie bisher als UTF-8 – verglichen werden
  // also PHPs Bytes, als UTF-8 gelesen)
  const valid = ['a', '%', '+', '%4', '%41', '%c3%a4', '%FF', '%E2%82', '%ED%A0%80', '%2B', '%20', '%00', 'ä', '€', '😀', '%%', '%g1', ' ', '/'];
  const encoded = Array.from({ length: 3000 }, () => Array.from({ length: r(12) }, () => valid[r(valid.length)]).join(''));
  // mb_strlen()/mb_substr(): Bytes mit gültigen und ungültigen Folgen, Anfang und Länge auch negativ
  const texts = [...randomBytes(r, 2500, 10), ...randomTexts(r, 1500, 10).map((s) => now.phpBytes(s))];
  const cuts = texts.map(() => [r(24) - 12, r(24) - 12]);
  const ref = php(`function h($v) { if (!is_array($v)) return bin2hex($v); $o = []; foreach ($v as $k => $x) $o[] = [bin2hex((string) $k), h($x)];
      usort($o, fn ($a, $b) => strcmp($a[0], $b[0])); return $o; }
    return [array_map(function ($b) { parse_str(hex2bin($b), $o); return h($o); }, $in[0]),
      array_map(fn ($s) => bin2hex(rawurldecode($s)), $in[1]),
      array_map(fn ($s, $c) => [mb_strlen(hex2bin($s)), bin2hex(mb_substr(hex2bin($s), $c[0], $c[1])), bin2hex(mb_substr(hex2bin($s), abs($c[0])))], $in[2], $in[3])];`,
  [bodies.map((b) => b.toString('hex')), encoded, texts.map((b) => b.toString('hex')), cuts]) as [unknown[], string[], Array<[number, string, string]>];
  const diffs: unknown[] = [];
  bodies.forEach((b, i) => {
    const mine = hexTree(now.parseFormBody(b));
    if (JSON.stringify(mine) !== JSON.stringify(ref[0][i])) diffs.push({ parse_str: b.toString('hex'), node: mine, php: ref[0][i] });
  });
  encoded.forEach((s, i) => {
    const theirs = Buffer.from(ref[1][i], 'hex').toString('utf8');
    if (now.rawurldecode(s) !== theirs) diffs.push({ rawurldecode: s, node: now.rawurldecode(s), php: theirs });
  });
  texts.forEach((b, i) => {
    const s = now.phpText(b);
    const [start, len] = cuts[i];
    const mine = [now.mbStrlen(s), hex(now.mbSubstr(s, start, len)), hex(now.mbSubstr(s, Math.abs(start)))];
    if (JSON.stringify(mine) !== JSON.stringify(ref[2][i])) diffs.push({ mb: b.toString('hex'), start, len, node: mine, php: ref[2][i] });
  });
  assert.deepEqual(diffs.slice(0, 5), []);
});

// ---------------------------------------------------------------- 3. 20 MB in deutlich unter einer Sekunde

// Kleinste Zeit aus drei Läufen. Grenze: 1 s auf einer ruhigen Maschine (gemessen dort: höchstens etwa 0,7 s je Form,
// fast alle unter 0,45 s; vorher 1 s bis 29 s oder gar kein Ergebnis, weil 4 GB Speicher voll waren). Die Testmaschine
// ist oft ausgelastet: Braucht schon ein einfacher Durchgang über 20 MB länger als 100 ms, wächst die Grenze mit (zehnmal
// dieser Durchgang). Liegt eine Form darüber, wird sie mit frischem Bezug noch einmal gemessen (kurze Lastspitze).
// Quadratisches Verhalten bräuchte Stunden.
const LIMIT_MS = 1000;
const MB20 = 20 * 1024 * 1024;
const fill = (unit: string, size = MB20): string => unit.repeat(Math.ceil(size / unit.length));
const latin1 = (s: string): Buffer => Buffer.from(s, 'latin1');
async function fastest(fn: () => unknown): Promise<number> {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    await fn();
    best = Math.min(best, performance.now() - t);
  }
  return best;
}
// Bezug: ein einfacher Durchgang über 20 MB (jede Einheit gelesen und geschrieben)
const REFERENCE = fill('x');
async function limit(): Promise<number> {
  const pass = await fastest(() => {
    const u = new Uint16Array(REFERENCE.length);
    for (let i = 0; i < REFERENCE.length; i++) u[i] = REFERENCE.charCodeAt(i) ^ 1;
    return u;
  });
  return Math.max(LIMIT_MS, 10 * pass);
}
type Diagnose = { diagnostic: (message: string) => void };
async function within(t: Diagnose, max: { ms: number }, label: string, fn: () => unknown): Promise<void> {
  let ms = await fastest(fn);
  if (ms >= max.ms) {
    max.ms = await limit();
    ms = Math.min(ms, await fastest(fn));
  }
  t.diagnostic(`${label}: ${ms.toFixed(0)} ms (limit ${max.ms.toFixed(0)} ms)`);
  assert.ok(ms < max.ms, `${label}: ${ms.toFixed(0)} ms, limit ${max.ms.toFixed(0)} ms`);
}

test('urlencoded bodies of 20 MB are read in well under a second', async (t) => {
  const max = { ms: await limit() };
  const shapes: Array<[string, () => Buffer]> = [
    ['field name a[[[…', () => latin1('a' + fill('[') + '=1')],
    ['field name a[[[[…', () => latin1('a[' + fill('[') + '=1')],
    ['field name a....', () => latin1('a' + fill('.') + '=1')],
    ['field name with spaces', () => latin1('a' + fill(' ') + '=1')],
    ['field name with NUL bytes', () => latin1('a' + fill('\0') + '=1')],
    ['field name %5B%5B…', () => latin1('a' + fill('%5B') + '=1')],
    ['value +++…', () => latin1('a=' + fill('+'))],
    ['value %41%41…', () => latin1('a=' + fill('%41'))],
    ['value %FF%FF…', () => latin1('a=' + fill('%FF'))],
    ['raw bytes FF…', () => Buffer.alloc(MB20, 0xff)],
    ['raw bytes C3…', () => Buffer.alloc(MB20, 0xc3)],
    ['value % and raw bytes', () => Buffer.concat([latin1('a=%'), Buffer.alloc(MB20, 0xff)])],
    ['field name of raw bytes and %', () => Buffer.concat([latin1('%'), Buffer.alloc(MB20, 0xff), latin1('=1')])],
    ['1001 fields with names of 20 KB [', () => latin1(fill('a' + '['.repeat(20000) + '=1&'))],
    ['valid UTF-8 €€€…', () => Buffer.from('a=' + fill('€', MB20 / 3))],
  ];
  for (const [label, make] of shapes) {
    const body = make();
    await within(t, max, label, () => readBody(makeTestCtx({ method: 'POST', url: '/' }), 'application/x-www-form-urlencoded', body));
  }
});

test('text functions on a 20 MB field take well under a second', async (t) => {
  const max = { ms: await limit() };
  const fields: Array<[string, () => string, boolean]> = [
    ['ASCII', () => fill('a'), false],
    ['CJK', () => now.phpText(Buffer.from(fill('日', MB20 / 3))), false],
    ['emoji', () => now.phpText(Buffer.from(fill('😀', MB20 / 4))), false],
    ['raw bytes', () => now.phpText(Buffer.alloc(MB20, 0xff)), true],
    ['raw lead bytes', () => now.phpText(Buffer.alloc(MB20, 0xe2)), true],
    ['raw bytes and ASCII', () => now.phpText(latin1(fill('a\xff'))), true],
  ];
  for (const [label, make, raw] of fields) {
    const s = make();
    // mb_strlen() (Link-Passwort), mb_substr() mit Länge (eigenes CSS: 20 000, Link-Passwort: 100), mit negativem
    // Anfang (ganze Länge nötig) und ohne Länge; mit rohen Bytes auch strlen() und die Bytes selbst
    const calls: Array<[string, () => unknown]> = [['mb_strlen', () => now.mbStrlen(s)], ['mb_substr 0, 20000', () => now.mbSubstr(s, 0, 20000)],
      ['mb_substr 0, 100', () => now.mbSubstr(s, 0, 100)], ['mb_substr -5', () => now.mbSubstr(s, -5)], ['mb_substr 1', () => now.mbSubstr(s, 1)]];
    if (raw) calls.push(['strlen', () => now.strlen(s)], ['bytes', () => now.phpBytes(s)]);
    for (const [what, fn] of calls) await within(t, max, `${what} of ${label}`, fn);
  }
  for (const [label, s] of [['%41', fill('%41')], ['%FF', fill('%FF')], ['%%%', fill('%')]]) await within(t, max, `rawurldecode ${label}`, () => now.rawurldecode(s));
  // E-Mail-Adresse bei Anmeldung und Registrierung
  for (const [label, s] of [['A', fill('A')], ['aA', fill('aA')], ['AÄ', fill('AÄ')]]) {
    await within(t, max, `strtolower ${label}`, () => now.strtolower(s));
    await within(t, max, `strtoupper ${label}`, () => now.strtoupper(s));
  }
  // e() eines zurückgegebenen Felds mit rohen Bytes
  for (const [label, b] of [['FF', Buffer.alloc(MB20, 0xff)], ['E2 82', latin1(fill('\xe2\x82'))], ['ED A0 80', latin1(fill('\xed\xa0\x80'))], ['a FF', latin1(fill('a\xff'))]] as const) {
    await within(t, max, `HTML substitution of ${label}`, () => now.phpUtf8Substitute(b));
  }
  for (const [label, b] of [['FF', Buffer.alloc(MB20, 0xff)], ['C3', Buffer.alloc(MB20, 0xc3)], ['a FF', latin1(fill('a\xff'))],
    ['valid and one bad byte', Buffer.concat([Buffer.from(fill('ä€😀', MB20 - 1)), Buffer.of(0xff)])]] as const) {
    await within(t, max, `phpText ${label}`, () => now.phpText(b));
  }
});

test('multipart bodies of 20 MB are read in well under a second', async (t) => {
  const max = { ms: await limit() };
  const head = (h: string): string => '--b\r\nContent-Disposition: form-data' + h + '\r\n\r\nv\r\n--b--';
  const shapes: Array<[string, () => Buffer]> = [
    ['empty parts (CRLF)', () => latin1(fill('--b\r\n\r\n'))],
    ['empty parts (LF)', () => latin1(fill('--b\n\n'))],
    ['field name a[[[…', () => latin1(head('; name="a' + fill('[') + '"'))],
    ['field name a....', () => latin1(head('; name="a' + fill('.') + '"'))],
    ['value of raw bytes', () => Buffer.concat([latin1('--b\r\nContent-Disposition: form-data; name="a"\r\n\r\n'), Buffer.alloc(MB20, 0xff), latin1('\r\n--b--')])],
    ['header lines X: y', () => latin1('--b\r\n' + fill('X: y\r\n') + '\r\nv\r\n--b--')],
    ['header lines of a colon', () => latin1('--b\n' + fill(':\n') + '\nv\n--b--')],
    ['continuation lines " x"', () => latin1('--b\r\nContent-Disposition: form-data; name="a"\r\n' + fill(' x\r\n') + '\r\nv\r\n--b--')],
    ['continuation lines " "', () => latin1('--b\nContent-Disposition: form-data; name="a"\n' + fill(' \n') + '\nv\n--b--')],
    ['parameters ;;;', () => latin1(head(fill(';') + '; name="a"'))],
    ['parameters ;a=b', () => latin1(head(fill(';a=b') + '; name="a"'))],
    ['parameters ;name=', () => latin1(head(fill(';name=')))],
    ['quotes \\"', () => latin1(head('; name="' + fill('\\"') + '"'))],
    ['quotes ";"', () => latin1(head('; x' + fill('";"') + '; name="a"'))],
    ['boundary lines', () => latin1(fill('--b\n'))],
    ['value of line breaks', () => latin1('--b\r\nContent-Disposition: form-data; name="a"\r\n\r\n' + fill('\n') + '\r\n--b--')],
    ['value of almost boundaries', () => latin1('--b\r\nContent-Disposition: form-data; name="a"\r\n\r\n' + fill('\n--') + '\r\n--b--')],
    ['NUL bytes in every line', () => latin1(fill('--b\0\r\nContent-Disposition\0: form-data; name="a\0"\r\n\r\n\0\r\n'))],
  ];
  for (const [label, make] of shapes) {
    const body = make();
    await within(t, max, label, () => readBody(makeTestCtx({ method: 'POST', url: '/' }), 'multipart/form-data; boundary=b', body));
  }
});

test('cleaning a 20 MB field takes well under a second', async (t) => {
  const max = { ms: await limit() };
  // Kontaktformular und Anmeldung (ohne Anmeldung): Name, Nachricht, Adresse; Links im Editor (Leerraum und
  // Steuerzeichen, die früher je Treffer ersetzt wurden)
  const shapes: Array<[string, string[]]> = [
    ['clean_text', ['\r\n', 'a\x01', '\n\n\na', 'a\u202A']],
    ['clean_text multiline', ['\r\n', 'a\x01', '\n\n\na', 'a\u202A']],
    ['clean_url', [' a', 'a\x01', '\ta']],
    ['normalize_slug', ['aA', '_', 'a_']],
  ];
  for (const [what, units] of shapes) {
    for (const unit of units) {
      const s = fill(unit);
      const fn = what === 'clean_text' ? () => compat.oysCleanText(s, 120) : what === 'clean_text multiline' ? () => compat.oysCleanText(s, 2000, true)
        : what === 'clean_url' ? () => compat.oysCleanUrl(s) : () => compat.oysNormalizeSlug(s);
      await within(t, max, `${what} of ${JSON.stringify(unit)}`, fn);
    }
  }
  const path = 'https://x.de/' + fill('\x01');
  await within(t, max, 'clean_url with control characters in the path', () => compat.oysCleanUrl(path));
});
