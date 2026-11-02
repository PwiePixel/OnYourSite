// Gegenprobe der PHP-Nachbauten mit echtem PHP (gleiche Zeitzone wie die Seite; die Funktionen der Seite aus der
// PHP-Version, siehe support/phpRef.ts)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { date, gmdate, strtotime, parseStr, intval, numberFormat, strtolower, phpTrim, mbSubstr, nl2br, rawurlencode, urlencode, phpStr, phpFloatToString, phpBytes, type PhpValue } from '../src/php.js';
import { cleanText } from '../src/helpers.js';
import { PHP_SKIP, phpFile } from './support/phpRef.js';

const TZ = 'Europe/Berlin';
function php(code: string, input: unknown): unknown {
  const script = `date_default_timezone_set('${TZ}'); $in = json_decode(stream_get_contents(STDIN), true); $out = (function ($in) { ${code} })($in); echo json_encode($out);`;
  return JSON.parse(execFileSync('php', ['-r', script], { input: JSON.stringify(input) }).toString());
}

// Zeitpunkte rund um die Zeitumstellungen und Jahreswechsel
const STAMPS = [0, 1700000000, 1711846799, 1711846800, 1711850400, 1729990800, 1729994400, 1735689599, 1735689600, 1793534400, 1798761600];
const FORMATS = ['Y-m-d H:i:s', 'Y-m-d', 'M j, Y', 'Y-m-d\\TH:i:s\\Z', 'M j, Y H:i', 'F j, Y', 'D, d M Y H:i:s', 'P', 'O', 'N jS z W o t L g G h a A I U', 'l, F jS'];

test('date() matches PHP', { skip: PHP_SKIP }, () => {
  const ours = STAMPS.map((t) => FORMATS.map((f) => date(f, t, TZ)));
  const theirs = php('$r = []; foreach ($in[0] as $t) { $row = []; foreach ($in[1] as $f) { $row[] = date($f, $t); } $r[] = $row; } return $r;', [STAMPS, FORMATS]);
  assert.deepEqual(ours, theirs);
});

test('gmdate() matches PHP', { skip: PHP_SKIP }, () => {
  const ours = STAMPS.map((t) => gmdate('D, d M Y H:i:s', t) + ' GMT');
  assert.deepEqual(ours, php('return array_map(function ($t) { return gmdate("D, d M Y H:i:s", $t) . " GMT"; }, $in);', STAMPS));
});

test('strtotime() matches PHP for the forms the site uses', { skip: PHP_SKIP }, () => {
  const now = 1793534400;
  const inputs = ['2026-11-01 10:00:00', '2026-03-29 02:30:00', '2026-10-25 02:30:00', '2026-11-01', 'now', 'today', 'yesterday', 'tomorrow',
    '+1 year', '-6 days', '+9 days', '2026-01-31 +1 month', '2026-11-01T10:00:00Z', '2026-11-01T10:00:00+02:00', 'nonsense', ''];
  const ours = inputs.map((s) => strtotime(s, now, TZ));
  const theirs = php('return array_map(function ($s) use ($in) { return strtotime($s, ' + now + '); }, $in);', inputs);
  assert.deepEqual(ours, theirs);
});

test('parseStr() matches parse_str()', { skip: PHP_SKIP }, () => {
  const inputs = ['a=1&a=2', 'x[]=1&x[]=2&x[k]=3', 'a.b=1&c d=2', 'a[b=1', 'n=%E2%82%AC+%26', 'empty=&novalue', 'm[a][b]=deep&m[a][]=x', '%20lead=1', 'a[]=1&a=flat'];
  const ours = inputs.map(parseStr);
  const theirs = php('return array_map(function ($s) { parse_str($s, $o); return $o; }, $in);', inputs) as unknown[];
  // PHP-Listen (0,1,…) kommen als JSON-Arrays – zum Vergleich in Objekte umwandeln
  const norm = (v: unknown): unknown => Array.isArray(v) ? Object.fromEntries(v.map((x, i) => [String(i), norm(x)])) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)])) : v;
  assert.deepEqual(ours.map(norm), theirs.map(norm));
});

test('parseStr() names open brackets like PHP', () => {
  // Namensregeln von php_register_variable_ex
  assert.deepEqual(parseStr('a[b[c=1'), { a_b_c: '1' });
  assert.deepEqual(parseStr('a[b[c]=1'), { a: { 'b[c': '1' } });
});

test('parseStr() matches parse_str() byte for byte: open brackets, broken %-escapes next to non-ASCII, random input', { skip: PHP_SKIP }, () => {
  // Schlüssel und Werte als Hex (ungültiges UTF-8 bleibt als rohe Bytes erhalten), Reihenfolge der Schlüssel egal
  const tree = (v: PhpValue): unknown => (typeof v === 'string' ? phpBytes(v).toString('hex')
    : Object.entries(v).map(([k, x]) => [phpBytes(k).toString('hex'), tree(x)]).sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1)));
  const fixed = ['a[b[c=1', 'a[b[c]=1', 'a[b]c[d=1', 'a.b[c.d=1', 'a b[c d=1', 'a[=1', 'a[b[=1', 'a][b=1', 'x=ä%2', 'x=%ä', 'x=%%C3%A4', 'ä%=1', 'x=%C3%A4%',
    'x=%E2%82', 'x=%FF', 'x=ä%E2%82ä', '%C3[ä=%ZZä', 'k%FF[%E2%82]=%ED%A0%80', 'x=%c3%A4%C3', 'a[%FF[b=1'];
  let seed = 17;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const alpha = ['a', 'b', '[', ']', '.', ' ', '%', '2', 'E', 'C3', '%C3', '%A4', '%5B', '%5D', '%2E', '%20', 'ä', '€', '+', '=', '&', '%00', '%FF', '%E2%82', '0', '-', '_', '\t', '%09', '1'];
  const inputs = [...fixed, ...Array.from({ length: 3000 }, () => Array.from({ length: 1 + rnd(14) }, () => alpha[rnd(alpha.length)]).join(''))];
  const theirs = php(`function h($v) { if (!is_array($v)) return bin2hex($v); $o = []; foreach ($v as $k => $x) $o[] = [bin2hex((string) $k), h($x)]; usort($o, fn ($a, $b) => strcmp($a[0], $b[0])); return $o; }
    return array_map(function ($s) { parse_str($s, $o); return h($o); }, $in);`, inputs) as unknown[];
  const diffs = inputs.map((input, i) => ({ input, node: tree(parseStr(input)), php: theirs[i] })).filter((d) => JSON.stringify(d.node) !== JSON.stringify(d.php));
  assert.deepEqual(diffs.slice(0, 5), []);
});

test('casts and text helpers match PHP', { skip: PHP_SKIP }, () => {
  const ints = ['12abc', '  7', '1e3', '0x1A', '-5.9', '', 'abc', '+3'];
  assert.deepEqual(ints.map(intval), php('return array_map("intval", $in);', ints));
  const nums: Array<[number, number]> = [[1234567.891, 2], [0.5, 0], [1.5, 0], [2.5, 0], [-1234.5, 1], [1000, 0], [0.125, 2]];
  assert.deepEqual(nums.map(([n, d]) => numberFormat(n, d)), php('return array_map(function ($p) { return number_format($p[0], $p[1]); }, $in);', nums));
  const texts = ['ÄBC Straße', '  \t trim me \n', "a\nb\r\nc", 'a b&c=d/é~', '🐝 honey'];
  assert.deepEqual(texts.map(strtolower), php('return array_map("strtolower", $in);', texts));
  assert.deepEqual(texts.map((s) => phpTrim(s)), php('return array_map("trim", $in);', texts));
  assert.deepEqual(texts.map((s) => mbSubstr(s, 1, 3)), php('return array_map(function ($s) { return mb_substr($s, 1, 3); }, $in);', texts));
  assert.deepEqual(texts.map(nl2br), php('return array_map("nl2br", $in);', texts));
  assert.deepEqual(texts.map(rawurlencode), php('return array_map("rawurlencode", $in);', texts));
  assert.deepEqual(texts.map(urlencode), php('return array_map("urlencode", $in);', texts));
  const floats = [0.07, 0.1 + 0.2, 1.5, 100.0, 1e20, 1.23456789012345678];
  assert.deepEqual(floats.map(phpStr), php('return array_map(function ($f) { return (string) $f; }, $in);', floats));
});

test('(string) of floats: 1.0E-5, large numbers and -0 like PHP', () => {
  // phpStr nimmt für Kommazahlen dieselbe Fassung (ganze Zahlen unter 1e15 gelten als int)
  assert.deepEqual([1e-5, 0.5, 1e15, 2.5e15, -2.5e-7, 100000000000005].map(phpStr), ['1.0E-5', '0.5', '1.0E+15', '2.5E+15', '-2.5E-7', '100000000000005']);
  assert.deepEqual(['1e400', '-1e400', '-0.0'].map((s) => phpFloatToString(Number(s))), ['INF', '-INF', '-0']);
  assert.equal(phpFloatToString(NaN), 'NAN');
});

test('(string) of floats matches PHP exactly: 1.0E-5, ties at the 14th digit, INF', { skip: PHP_SKIP }, () => {
  let seed = 11;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  // Grenzfälle: Exponent ab 1e-5 (toPrecision erst unter 1e-6), genau die Hälfte an der 15. Stelle (PHP rundet zur
  // geraden Ziffer), große ganze Zahlen als Kommazahl, kleinste und größte Werte
  const vals: number[] = [1e-5, 1.5e-5, 9.9e-5, 1e-4, 1e-7, 3e-6, 0.00012345, 100000000000005, 100000000000015, 12345678901234.5, 12345678901233.5,
    1000000000000.25, 70368744177664.5, 1e14, 1e15, 99999999999999.95, 0.1 + 0.2, 5e-324, 1.7976931348623157e308, 2 ** 53 + 2, 1 / 3, 2 / 3];
  for (let i = 0; i < 3000; i++) {
    vals.push(Number(String(rnd(1e8)) + '.' + String(rnd(1e8)).padStart(8, '0') + 'e' + (rnd(40) - 20)));
    // Werte mit genau 15 Stellen und einer 5 am Ende (Gleichstand an der 14. Stelle)
    vals.push((rnd(2e9) * 10000 + rnd(10000)) * 10 + 5);
    vals.push((rnd(2e9) + 0.5) * 2 ** (rnd(30) - 10));
  }
  const all = vals.flatMap((v) => [v, -v]);
  const ref = php('return array_map(function ($s) { return (string) (float) $s; }, $in);', all.map((v) => v.toPrecision(17))) as string[];
  const mine = all.map((v) => phpFloatToString(Number(v.toPrecision(17))));
  const diffs = mine.map((m, i) => [all[i], m, ref[i]]).filter(([, m, r]) => m !== r);
  assert.deepEqual(diffs, []);
  // Unendlich und NaN wie PHP, -0 bleibt "-0"
  const special = ['1e400', '-1e400', '-0.0'];
  assert.deepEqual(special.map((s) => phpFloatToString(Number(s))), php('return array_map(function ($s) { return (string) (float) $s; }, $in);', special));
  assert.equal(phpFloatToString(NaN), php('return (string) NAN;', null));
});

test('cleanText() of a float writes INF like PHP', () => {
  assert.equal(cleanText(1e400), 'INF');
  assert.equal(cleanText(-1e400), '-INF');
});

test('cleanText() of a float uses the same text as PHP (INF, 1.0E-5)', { skip: PHP_SKIP }, () => {
  // oys_clean_text($v) mit einer Kommazahl (z. B. aus json_decode): (string) $v wie PHP
  const inputs = ['1e400', '-1e400', '1e-5', '0.30000000000000004', '1e15', '-0.0', '123456789.125'];
  const ref = execFileSync('php', ['-r', `require '${phpFile('lib/config.php')}'; require '${phpFile('blacklist.php')}'; require '${phpFile('lib/helpers.php')}';`
    + ' echo json_encode(array_map(function ($s) { return oys_clean_text((float) $s); }, json_decode(stream_get_contents(STDIN), true)));'], { input: JSON.stringify(inputs) }).toString();
  assert.deepEqual(inputs.map((s) => cleanText(Number(s))), JSON.parse(ref));
});
