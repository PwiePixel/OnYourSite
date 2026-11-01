// Kleine Regeln der Editor-API (lib/routes_app.php) gegen PHP mit erzeugten Eingaben: welche Seite eine Anfrage meint,
// die Block-IDs der Vorschau, array_slice() mit Schlüsseln und der Text einer Discord-ID aus dem JSON. Die Antworten
// der Schnittstelle selbst vergleicht die Golden-Master-Suite (gm/requests/full/app.json und gm/requests/app.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonDecode, isArr, type PhpArr } from '../src/content/util.js';
import { parseStr } from '../src/php.js';
import { jsonValueText, previewBlockId, requestedPageId, sliceEntries } from '../src/app/editorApi.js';
import { O, Raw, diffs, jsonText, rng, runPhp } from './modelHarness.js';

const r = rng(4242);

// Werte, wie sie im JSON einer Anfrage stehen können (als JSON-Text, damit PHP genau dieselben Typen sieht)
const SCALARS = ['null', '0', '-1', '1', '2', '2.9', '-0', '-0.0', '1e3', '1E2', '"5x"', '" 7"', '"\\t8"', '"1e3"', '"0x1A"', 'true', 'false', '""', '"0"', '"abc"',
  '1e30', '-1e30', '9223372036854775807', '9223372036854775808', '"9223372036854775808"', '12345678901234567', '0.5', '"2.9"', '"+3"', '"-3"', '[]', '[1]', '{}', '{"a":1}', '"5\\n"'];

// Ganze Zahlen ab 2^53 kennt JavaScript nicht genau (12345678901234567 wird …568, PHP_INT_MAX wird 2^63) – solche
// Seiten gibt es nie, beide Versionen antworten gleich (409). Sie heißen hier BIG. Die JSON-Zahl 9223372036854775808
// ist in PHP eine Kommazahl, (int) davon PHP_INT_MIN (keine Seite angegeben) – in Node dieselbe JavaScript-Zahl wie
// 9223372036854775807 (PHP_INT_MAX, Seite angegeben): bekannte Grenze von jsonDecode()/intval(), hier ausgelassen.
const maxed = (json: string): string => (/^-?\d+$/.test(json) && Math.abs(Number(json)) >= 2 ** 53 ? 'BIG' : json);

test('the requested page id follows PHP ?? and (int) rules', () => {
  const SCALARS_ = SCALARS.filter((x) => x !== '9223372036854775808');
  const cases: Array<{ json: string; post: string; get: string }> = [];
  for (let i = 0; i < 1500; i++) {
    const parts: string[] = [];
    if (r.chance(0.6)) {
      const page = r.chance(0.7) ? `{"id":${r.pick(SCALARS_)}${r.chance(0.2) ? ',"x":1' : ''}}` : r.pick(['"x"', '5', '[]', '[5]', 'null', '{"ID":5}']);
      parts.push(`"page":${page}`);
    }
    if (r.chance(0.6)) parts.push(`"page_id":${r.pick(SCALARS_)}`);
    const json = r.chance(0.1) ? r.pick(['[]', '[1,2]', '{}']) : '{' + parts.join(',') + '}';
    const val = () => r.pick(['5', '0', '-2', 'x', '3x', '', '1e2', '%20%207', '2.5', '99999999999999999999']);
    const post = r.chance(0.3) ? (r.chance(0.2) ? 'page_id[]=5' : 'page_id=' + val()) : '';
    const get = r.chance(0.4) ? (r.chance(0.2) ? 'page[a]=1' : 'page=' + val()) : '';
    cases.push({ json, post, get });
  }
  const php = JSON.parse(runPhp(`
    $out = [];
    foreach ($in as $c) {
      $input = json_decode($c['json'], true);
      parse_str($c['post'], $_POST);
      parse_str($c['get'], $_GET);
      $requestedPage = $input['page']['id'] ?? ($input['page_id'] ?? ($_POST['page_id'] ?? ($_GET['page'] ?? null)));
      $requestedPage = is_scalar($requestedPage) && (int) $requestedPage > 0 ? (int) $requestedPage : null;
      $out[] = json_encode($requestedPage);
    }
    echo json_encode($out);`, JSON.stringify(cases))).map(maxed) as string[];
  const node = cases.map((c) => {
    const input = jsonDecode(c.json);
    assert.ok(isArr(input));
    return maxed(JSON.stringify(requestedPageId(input as PhpArr, parseStr(c.post, true), parseStr(c.get))));
  });
  assert.deepEqual(diffs(cases, node, php), []);
  assert.ok(node.includes('null') && node.includes('1000') && node.includes('7') && node.includes('2'));
});

// Ganze Zahlen ab 1e15 schreibt phpStr() wie Kommazahlen (JavaScript kennt kein int) – in PHP sind sie aus dem JSON ein
// int mit allen Stellen. Als Block-ID kommt so etwas aus dem Editor nie vor (IDs der Datenbank oder n1, n2 …); hier
// ausgelassen und im Bericht genannt.
const NO_BIG = SCALARS.filter((x) => !/^-?\d{16,}$/.test(x));

test('preview block ids keep only letters and digits like preg_match without /u (and a final newline)', () => {
  const ALPHA = ['a', 'Z', '0', '9', '-', '_', ' ', '\n', '\r', 'ä', 'ſ', 'K', 'İ', 'ı', '😀', '\u0000', 'x'];
  const cases: Array<{ key: string; block: string }> = [];
  for (let i = 0; i < 2000; i++) {
    let id: string;
    const kind = r.next(10);
    if (kind < 5) {
      let s = '';
      for (let k = r.next(6); k > 0; k--) s += r.pick(ALPHA);
      id = JSON.stringify(s);
    } else if (kind < 9) {
      id = r.pick(NO_BIG);
    } else {
      id = '';
    }
    const key = r.pick(['0', '7', 'x', 'ab', '-1', '']);
    cases.push({ key, block: id === '' ? '{"type":"text"}' : `{"type":"text","id":${id}}` });
  }
  const php = JSON.parse(runPhp(`
    $out = [];
    foreach ($in as $c) {
      $b = json_decode($c['block'], true);
      $i = $c['key'];
      $id = $b['id'] ?? ('n' . $i);
      $out[] = json_encode(@preg_match('/^[a-z0-9]+$/i', (string) $id) ? (string) $id : 'n' . $i, JSON_UNESCAPED_UNICODE);
    }
    echo json_encode($out);`, JSON.stringify(cases))) as string[];
  const node = cases.map((c) => JSON.stringify(previewBlockId(jsonDecode(c.block) as PhpArr, c.key)));
  assert.deepEqual(diffs(cases, node, php), []);
  assert.ok(node.some((x) => x === '"Array"') && node.some((x) => x.endsWith('\\n"') && !x.startsWith('"n')));
});

test('array_slice keeps text keys and renumbers integer keys', () => {
  const KEYS = ['0', '1', '2', '5', '-3', '05', '-0', 'x', 'a b', '9223372036854775807', '9223372036854775808', '-9223372036854775808', '1.5', '', '00', '__proto__'];
  const cases: Array<{ json: string; len: number }> = [];
  for (let i = 0; i < 1000; i++) {
    const pairs: Array<[string, unknown]> = [];
    for (let k = r.next(8); k > 0; k--) pairs.push([r.pick(KEYS), new Raw(String(r.next(100)))]);
    const asList = r.chance(0.1);
    cases.push({ json: asList ? '[1,2,3]' : jsonText(new O(pairs)), len: r.pick([0, 1, 2, 3, 150]) });
  }
  const php = JSON.parse(runPhp(`
    $out = [];
    foreach ($in as $c) {
      $a = json_decode($c['json'], true);
      $s = array_slice($a, 0, $c['len']);
      $out[] = json_encode(array_map(fn($k, $v) => [(string) $k, $v], array_keys($s), array_values($s)));
    }
    echo json_encode($out);`, JSON.stringify(cases))) as string[];
  const node = cases.map((c) => JSON.stringify(sliceEntries(jsonDecode(c.json) as PhpArr, c.len)));
  assert.deepEqual(diffs(cases, node, php), []);
});

test('a discord id sent as a JSON number keeps every digit like PHP (string) on json_decode', () => {
  const cases: string[] = [];
  const digits = (n: number): string => {
    let s = String(1 + r.next(9));
    for (let k = 1; k < n; k++) s += String(r.next(10));
    return s;
  };
  for (let i = 0; i < 1500; i++) {
    const n = 1 + r.next(24);
    let num = (r.chance(0.2) ? '-' : '') + digits(n);
    if (r.chance(0.15)) num += '.' + digits(1 + r.next(3));
    if (r.chance(0.1)) num += 'e' + r.pick(['', '+', '-']) + r.next(20);
    const shape = r.next(4);
    cases.push(shape === 0 ? `{"discord_id":${num}}`
      : shape === 1 ? `{"discord_id":1,"discord_id":${num}}`
        : shape === 2 ? `{"x":{"discord_id":5},"discord_id":${num},"y":[${num}]}`
          : `{"discord_id":"${num}"}`);
  }
  cases.push('{"discord_id":9223372036854775807}', '{"discord_id":9223372036854775808}', '{"discord_id":-9223372036854775808}', '{"discord_id":-0}', '{"discord_id":1000000000000000}');
  const php = JSON.parse(runPhp(`
    $out = [];
    foreach ($in as $c) {
      $input = json_decode($c, true);
      $out[] = (string) ($input['discord_id'] ?? '');
    }
    echo json_encode($out);`, JSON.stringify(cases))) as string[];
  const node = cases.map((c) => {
    const input = jsonDecode(Buffer.from(c)) as PhpArr;
    return jsonValueText(Buffer.from(c), 'discord_id', (input as Record<string, unknown>).discord_id ?? '');
  });
  assert.deepEqual(diffs(cases, node, php), []);
});
