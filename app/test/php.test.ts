// Gegenprobe der PHP-Nachbauten mit echtem PHP (gleiche Zeitzone wie die Seite)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { date, gmdate, strtotime, parseStr, intval, numberFormat, strtolower, phpTrim, mbSubstr, nl2br, rawurlencode, urlencode, phpStr } from '../src/php.js';

const TZ = 'Europe/Berlin';
function php(code: string, input: unknown): unknown {
  const script = `date_default_timezone_set('${TZ}'); $in = json_decode(stream_get_contents(STDIN), true); $out = (function ($in) { ${code} })($in); echo json_encode($out);`;
  return JSON.parse(execFileSync('php', ['-r', script], { input: JSON.stringify(input) }).toString());
}

// Zeitpunkte rund um die Zeitumstellungen und Jahreswechsel
const STAMPS = [0, 1700000000, 1711846799, 1711846800, 1711850400, 1729990800, 1729994400, 1735689599, 1735689600, 1793534400, 1798761600];
const FORMATS = ['Y-m-d H:i:s', 'Y-m-d', 'M j, Y', 'Y-m-d\\TH:i:s\\Z', 'M j, Y H:i', 'F j, Y', 'D, d M Y H:i:s', 'P', 'O', 'N jS z W o t L g G h a A I U', 'l, F jS'];

test('date() matches PHP', () => {
  const ours = STAMPS.map((t) => FORMATS.map((f) => date(f, t, TZ)));
  const theirs = php('$r = []; foreach ($in[0] as $t) { $row = []; foreach ($in[1] as $f) { $row[] = date($f, $t); } $r[] = $row; } return $r;', [STAMPS, FORMATS]);
  assert.deepEqual(ours, theirs);
});

test('gmdate() matches PHP', () => {
  const ours = STAMPS.map((t) => gmdate('D, d M Y H:i:s', t) + ' GMT');
  assert.deepEqual(ours, php('return array_map(function ($t) { return gmdate("D, d M Y H:i:s", $t) . " GMT"; }, $in);', STAMPS));
});

test('strtotime() matches PHP for the forms the site uses', () => {
  const now = 1793534400;
  const inputs = ['2026-11-01 10:00:00', '2026-03-29 02:30:00', '2026-10-25 02:30:00', '2026-11-01', 'now', 'today', 'yesterday', 'tomorrow',
    '+1 year', '-6 days', '+9 days', '2026-01-31 +1 month', '2026-11-01T10:00:00Z', '2026-11-01T10:00:00+02:00', 'nonsense', ''];
  const ours = inputs.map((s) => strtotime(s, now, TZ));
  const theirs = php('return array_map(function ($s) use ($in) { return strtotime($s, ' + now + '); }, $in);', inputs);
  assert.deepEqual(ours, theirs);
});

test('parseStr() matches parse_str()', () => {
  const inputs = ['a=1&a=2', 'x[]=1&x[]=2&x[k]=3', 'a.b=1&c d=2', 'a[b=1', 'n=%E2%82%AC+%26', 'empty=&novalue', 'm[a][b]=deep&m[a][]=x', '%20lead=1', 'a[]=1&a=flat'];
  const ours = inputs.map(parseStr);
  const theirs = php('return array_map(function ($s) { parse_str($s, $o); return $o; }, $in);', inputs) as unknown[];
  // PHP-Listen (0,1,…) kommen als JSON-Arrays – zum Vergleich in Objekte umwandeln
  const norm = (v: unknown): unknown => Array.isArray(v) ? Object.fromEntries(v.map((x, i) => [String(i), norm(x)])) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)])) : v;
  assert.deepEqual(ours.map(norm), theirs.map(norm));
});

test('casts and text helpers match PHP', () => {
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
