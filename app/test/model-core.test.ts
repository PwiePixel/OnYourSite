// Die Korrekturen am Kern, die das Inhalts-Paket braucht: (int) mit Überlauf wie PHP und Feldnamen aus
// Formularen/Adressen wie parse_str() (nie Object.prototype, Nullbyte, Klammern, Ebenen, max_input_vars)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { intval, parseStr, rawurldecode, setPhpVar, type PhpArray } from '../src/php.js';
import { jsonDecode } from '../src/content/util.js';
import { runPhp, jsonText, Raw, rng } from './modelHarness.js';

test('(int) overflows like PHP on 64 bit', () => {
  const values: unknown[] = [new Raw('1e19'), new Raw('-1e19'), new Raw('1e20'), new Raw('3.3e22'), new Raw('-3.3e22'), new Raw('1e300'), new Raw('9223372036854775807'),
    new Raw('9223372036854775808'), new Raw('-9223372036854775808'), new Raw('1.5'), new Raw('-0.5'), '1e19', '-1e19', '9999999999999999999', '-9999999999999999999',
    '1e400', '-1e400', '1e3', ' 12', '12abc', '0x1A', '1.9e1', '.5', '5.', '+7', '\n8', '\f9', '1e', '-', '', 'abc', true, false, null, [], [0], {}, { a: 1 }];
  const text = jsonText(values);
  // PHP schreibt ganze Zahlen genau, JavaScript-Zahlen runden ab 2^53 – verglichen werden die gelesenen Zahlen
  const php = (JSON.parse(runPhp('echo json_encode(array_map(fn($v) => (int) $v, $in));', text)) as number[]);
  const node = (jsonDecode(text) as unknown[]).map(intval);
  // Bekannte Grenze: 9223372036854775808 ist in PHP eine Kommazahl (→ PHP_INT_MIN), als JavaScript-Zahl aber nicht von
  // PHP_INT_MAX (9223372036854775807) zu unterscheiden – Node nimmt PHP_INT_MAX (so bleibt z. B. YouTubes t=… genau)
  const AMBIGUOUS = values.findIndex((v) => v instanceof Raw && v.text === '9223372036854775808');
  assert.equal(node[AMBIGUOUS], 2 ** 63);
  assert.deepEqual(node.filter((_, i) => i !== AMBIGUOUS), php.filter((_, i) => i !== AMBIGUOUS));
  // Geprüft sind auch die Grenzen selbst
  assert.equal(intval(1e19), -8446744073709551616);
  assert.equal(intval('1e400'), 0);
  assert.equal(intval({}), 0);
});

test('form and query names never touch Object.prototype and stop at a NUL byte like parse_str', () => {
  const inputs = ['__proto__[polluted]=yes', 'a[__proto__][b]=1&__proto__=str', 'constructor[prototype][x]=1&toString=2', 'v%00=abc&w%00x=1', 'x[%00]=1',
    '__proto__[]=1&__proto__[]=2', 'hasOwnProperty=1&a=2'];
  const php = JSON.parse(runPhp('echo json_encode(array_map(function ($s) { parse_str($s, $o); return $o; }, $in));', JSON.stringify(inputs))) as unknown[];
  // PHP-Listen (0, 1, …) kommen als JSON-Arrays – zum Vergleich in Objekte umwandeln
  const norm = (v: unknown): unknown => Array.isArray(v) ? Object.fromEntries(v.map((x, i) => [String(i), norm(x)]))
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)])) : v;
  const node = inputs.map((s) => JSON.parse(JSON.stringify(parseStr(s))));
  assert.deepEqual(node.map(norm), php.map(norm));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(({} as Record<string, unknown>).x, undefined);
});

// ---------------------------------------------------------------- parse_str(), $_GET, $_POST (Prüfung des Pakets)

// PHP-Listen (0, 1, …) kommen als JSON-Arrays – zum Vergleich in Objekte umwandeln (die Reihenfolge zählt hier nicht)
const asObjects = (v: unknown): unknown => Array.isArray(v) ? Object.fromEntries(v.map((x, i) => [String(i), asObjects(x)]))
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, asObjects(x)])) : v;

test('parse_str: names, brackets, nesting and appends match PHP 8.3', () => {
  const r = rng(5);
  // Nur Teile, die gültiges UTF-8 ergeben: ungültige Bytes (%E9) kann ein JavaScript-Text nicht wie PHP halten
  const parts = ['a', 'v', '0', '1', '-1', '-5', '05', '9223372036854775807', '9223372036854775806', '99999999999999999999', '[', ']', '[]', '[a]', '[0]',
    '[-3]', '[ ]', '[  ]', '[\t]', '[%0A]', '[%0B]', '[%0C]', '[ a]', '.', ' ', '+', '%5B', '%5D', '%20', '%2E', '%00', '%zz', '%C3%A9', '=', '&', '&&', 'x',
    '__proto__', 'é', '[[', ']]', '[.]', '[9223372036854775807]', '[-9223372036854775808]'];
  const cases: string[] = [];
  for (let i = 0; i < 4000; i++) {
    let s = '';
    for (let k = 1 + r.next(9); k > 0; k--) s += r.pick(parts);
    cases.push(s);
  }
  // Mehr als 64 Ebenen löschen die ganze Variable; eine offene [ wird Teil des Namens; [ ] hängt an; negative und
  // sehr große Schlüssel beim Anhängen; %-Folgen neben gültigem UTF-8
  for (const n of [63, 64, 65, 66]) {
    cases.push('v=1&v' + '[a]'.repeat(n) + '=x', 'v' + '[a]'.repeat(n) + '=x&v=2', 'v' + '[]'.repeat(n) + '=x&w=1', 'v' + '[a]'.repeat(n - 1) + '[b=1', 'v' + '[ ]'.repeat(n) + '=2');
  }
  cases.push('[a]=1', ' [a]=1', '%5Bv=1', '.[a]=1', 'v[a[b=1', 'v[a][b[c=1', 'a b[c d]=1', 'v][=1', 'v[[a]]=1', 'v[a[b]c]=1', 'v[a]b[c]=1', 'v[ ', 'v[a][ ',
    'v[]=1&v[ ]=2&v[  ]=3', 'v[-5]=a&v[]=b', 'v[0]=a&v[-1]=b&v[]=c', 'v[9223372036854775806]=a&v[]=b&v[]=c', 'v[9223372036854775807]=a&v[]=b',
    'v[99999999999999999999]=a&v[]=b', 'v[05]=a&v[]=b', 'v[5]=a&v[2]=b&v[]=c', 'q=caf%C3%A9+100%25&r=caf%C3%A9+100%', 'n=%E2%82%AC%zz%C3%A9',
    'a=😀%20x&b=😀&c=%F0%9F%98%80%zz%', '😀[%F0%9F%90%9D]=🐝%');
  const php = JSON.parse(runPhp('echo json_encode(array_map(function ($s) { parse_str($s, $o); return $o; }, $in));', JSON.stringify(cases))) as unknown[];
  const node = cases.map((s) => JSON.parse(JSON.stringify(parseStr(s))));
  const bad = cases.map((s, i) => ({ s, php: JSON.stringify(asObjects(php[i])), node: JSON.stringify(asObjects(node[i])) }))
    .filter((x) => { try { assert.deepEqual(JSON.parse(x.node), JSON.parse(x.php)); return false; } catch { return true; } });
  assert.deepEqual(bad.slice(0, 5), []);
  // Stichproben: 65 Ebenen löschen v, eine „100 %“ neben einem Umlaut bleibt erhalten
  assert.deepEqual(parseStr('v=1&v' + '[a]'.repeat(65) + '=x'), {});
  assert.equal(parseStr('r=caf%C3%A9+100%').r, 'café 100%');
  // rawurldecode() selbst: Zeichen außerhalb der BMP neben %-Folgen bleiben ganz
  const raw = ['😀%20x', '%F0%9F%98%80%zz%', '🐝%41%4g%', 'ä%C3%A4😀', '%', '%4', '%%41', '😀+%2B'];
  assert.deepEqual(raw.map(rawurldecode), JSON.parse(runPhp('echo json_encode(array_map("rawurldecode", $in));', JSON.stringify(raw))));
});

// $_GET und $_POST über PHPs eingebauten Server: dort gelten max_input_vars und die Regeln von php_default_treat_data
// (Adresse: die ersten 1000 nicht leeren Stücke) bzw. des POST-Lesers (die ersten 1001 Stücke, leere zählen mit)
test('query strings and form posts keep as many variables as PHP (max_input_vars)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oys-probe-'));
  writeFileSync(join(dir, 'p.php'), '<?php header("Content-Type: application/json"); echo json_encode(["get" => $_GET, "post" => $_POST]);');
  const port = await new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
  const server = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', dir], { stdio: 'ignore' });
  try {
    const ask = async (query: string, body: string): Promise<{ get: unknown; post: unknown }> => {
      for (let i = 0; ; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/p.php?${query}`, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
          return (await res.json()) as { get: unknown; post: unknown };
        } catch (err) {
          if (i > 80) throw err;
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    };
    const vars = (n: number, sep = '&', name = (i: number) => `v${i}=${i}`) => Array.from({ length: n }, (_, i) => name(i)).join(sep);
    const bodies = [vars(999), vars(1000), vars(1001), vars(1002), vars(1500), vars(1002, '&&'), '&&&' + vars(1002) + '&&', vars(1005, '&', () => 'a[]=1'),
      vars(1003, '&', (i) => (i % 2 ? `x${i}` : `=${i}`)), 'csrf=1&' + vars(1000), vars(1000) + '&csrf=1', vars(1001) + '&csrf=1',
      'v=1&v' + '[a]'.repeat(65) + '=x&w=2', 'q=caf%C3%A9+100%25&r=caf%C3%A9+100%', 'a=😀%20x&b=%F0%9F%98%80%zz%'];
    for (const body of bodies) {
      const php = await ask(body, body);
      assert.deepEqual(asObjects(JSON.parse(JSON.stringify(parseStr(body)))), asObjects(php.get), 'GET ' + body.slice(0, 60));
      assert.deepEqual(asObjects(JSON.parse(JSON.stringify(parseStr(body, true)))), asObjects(php.post), 'POST ' + body.slice(0, 60));
    }
  } finally {
    server.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('many name[]=… appends stay fast (no quadratic work per request)', () => {
  const body = Array(200000).fill('a[]=1').join('&');
  const t = Date.now();
  assert.equal(Object.keys(parseStr(body, true).a).length, 1001);
  // Ohne Grenze und mit dem alten Suchen nach dem größten Schlüssel dauerte das Minuten
  const all: PhpArray = {};
  for (let i = 0; i < 100000; i++) setPhpVar(all, 'a[]', '1');
  assert.equal(Object.keys(all.a).length, 100000);
  assert.ok(Date.now() - t < 5000, `took ${Date.now() - t} ms`);
});
