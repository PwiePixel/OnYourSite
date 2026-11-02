// app/scripts/config.mjs gegen PHP: config.php wird ohne PHP gelesen – das Ergebnis muss genau dem entsprechen, was
// include in PHP liefert (Typen, Bytes jedes Texts, Schlüssel und ihre Reihenfolge). PHP läuft hier nur zum Vergleich:
// handgeschriebene Grenzfälle, Dateien im Format des alten Installers (write_config mit var_export) mit Zufallswerten
// und Zufallstexte mit allen Escapes. Dazu: was abgelehnt wird, write wie write_config der PHP-Version, Dateirechte,
// get/set/reset-keys und from-php wie das frühere config-from-php.php (json_encode).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT_DIR } from '../src/config.js';
// @ts-expect-error – reines JavaScript ohne Typen (Installer-Werkzeug)
import { ConfigError, PhpArray, buildConfig, encodeJson, loadSettings, main, parsePhpConfig, phpToJson } from '../scripts/config.mjs';

const SCRIPT = join(ROOT_DIR, 'app', 'scripts', 'config.mjs');
const HAS_PHP = spawnSync('php', ['-v']).status === 0;
let dir = '';
let n = 0;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'oys-config-'));
});
after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function file(content: string | Buffer, name = `c${n++}.php`): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

// ---------------------------------------------------------------- PHP-Seite: Wert mit Typen, Bytes als hex

const PHP_TYPED = `
function t($v) {
  if (is_array($v)) { $o = []; foreach ($v as $k => $x) $o[] = [is_int($k) ? 'i' : 's', is_int($k) ? (string) $k : bin2hex($k), t($x)]; return ['a', $o]; }
  if (is_string($v)) return ['s', bin2hex($v)];
  if (is_int($v)) return ['i', (string) $v];
  if (is_float($v)) return ['f', bin2hex(pack('E', $v))];
  if (is_bool($v)) return ['b', $v];
  if ($v === null) return ['n'];
  return ['?', gettype($v)];
}
$out = [];
foreach (json_decode(stream_get_contents(STDIN), true) as $f) {
  $warn = [];
  set_error_handler(function ($no, $str) use (&$warn) { $warn[] = $str; return true; });
  ob_start();
  try { $v = include $f; $r = ['ok', t($v)]; } catch (\\Throwable $e) { $r = ['error', get_class($e) . ': ' . $e->getMessage()]; }
  ob_end_clean();
  restore_error_handler();
  $r[] = $warn;
  $out[] = $r;
}
echo json_encode($out, JSON_INVALID_UTF8_SUBSTITUTE);`;

type PhpResult = ['ok', unknown, string[]?] | ['error', string, string[]?];
function phpTypedBatch(files: string[]): PhpResult[] | null {
  const r = spawnSync('php', ['-d', 'display_errors=stderr', '-d', 'error_reporting=0', '-r', PHP_TYPED], { input: JSON.stringify(files), maxBuffer: 64 << 20 });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout.toString());
  } catch {
    return null;
  }
}
// Alle Dateien in einem PHP-Lauf; bricht PHP ab (Fehler beim Übersetzen, z. B. „next element is already occupied“),
// jede Datei einzeln – ein Abbruch zählt dann als Fehler
function phpTyped(files: string[]): PhpResult[] {
  return phpTypedBatch(files) ?? files.map((f) => phpTypedBatch([f])?.[0] ?? ['error', 'PHP stopped with a fatal error']);
}

type Typed = unknown;
function typed(v: unknown): Typed {
  if (v instanceof PhpArray) {
    return ['a', (v as { entries: Array<[bigint | Buffer, unknown]> }).entries.map(([k, x]) => [typeof k === 'bigint' ? 'i' : 's', typeof k === 'bigint' ? k.toString() : k.toString('hex'), typed(x)])];
  }
  if (Buffer.isBuffer(v)) return ['s', v.toString('hex')];
  if (typeof v === 'bigint') return ['i', v.toString()];
  if (typeof v === 'number') {
    const b = Buffer.alloc(8);
    b.writeDoubleBE(v);
    return ['f', b.toString('hex')];
  }
  if (typeof v === 'boolean') return ['b', v];
  if (v === null) return ['n'];
  return ['?', typeof v];
}

function nodeTyped(path: string): ['ok', Typed] | ['error', string] {
  try {
    return ['ok', typed(parsePhpConfig(readFileSync(path)))];
  } catch (err) {
    if (err instanceof ConfigError) return ['error', (err as Error).message];
    throw err;
  }
}

// Gleiches Ergebnis wie PHP – oder beide lehnen ab
// Gleiches Ergebnis wie PHP – oder beide lehnen ab. Variablen in "…" setzt PHP ein (mit der Warnung „Undefined
// variable“); config.mjs lehnt sie absichtlich ab. Gibt die Zahl dieser Fälle zurück.
function compare(files: string[], label: string): number {
  const php = phpTyped(files);
  let interpolated = 0;
  files.forEach((f, i) => {
    const node = nodeTyped(f);
    const src = readFileSync(f).toString('latin1');
    const [state, value, warnings = []] = php[i];
    if (state === 'error') {
      assert.equal(node[0], 'error', `${label}: PHP fails (${value}), Node must refuse too:\n${src}`);
    } else if (node[0] === 'error' && /variables in "…" texts/.test(node[1]) && warnings.some((w) => w.startsWith('Undefined variable'))) {
      interpolated++;
    } else {
      assert.deepEqual(node, [state, value], `${label}: differs from PHP for:\n${src}`);
    }
  });
  return interpolated;
}

// ---------------------------------------------------------------- Grenzfälle von Hand

const EDGE: string[] = [
  readFileSync(join(ROOT_DIR, 'config.example.php'), 'latin1'),
  "<?php\nreturn [];\n",
  "<?php return['a'=>1];",
  "<?php\r\nreturn [\r\n  'a' => 'b',\r\n];\r\n",
  "\xef\xbb\xbf<?php\nreturn ['bom' => true];\n",
  "  \n<?php\nreturn ['lead' => 1];\n",
  "<?php\nreturn ['x' => 1];\n?>\n",
  "<?php\nreturn ['x' => 1];\n?>",
  "<?PHP\nRETURN ARRAY('a' => TRUE, 'b' => False, 'c' => NuLl, 'd' => array (1, 2,),);\n",
  // Kommentare in allen Formen, auch mit ?> im Zeilenkommentar
  "<?php\n// eins\n# zwei\n/* drei\n vier */\n/** doc */\nreturn [ // nach\n  'a' /* mitten */ => # hier\n  'b', /* */ 'c' => 'd' // ?>\n];",
  "<?php\nreturn ['a' => 1]; // ?> rest\n",
  // Texte in '…': nur \\' und \\\\ sind Escapes
  String.raw`<?php return ['a' => 'it\'s', 'b' => 'back\\slash', 'c' => 'keep \n \t \x41 \$ \"', 'd' => '\\\'', 'e' => '\\', 'f' => '\a\\\\b'];`,
  // Texte in "…" mit allen Escapes
  String.raw`<?php return ["n\nt\tr\rv\ve\ef\f", "\\ \$ \"", "\101\60\0\7\400\777\1234", "\x41\x4\x4G\xZ\x", "\u{41}\u{e4}\u{1F600}\u{0000000041}\u{D800}", "\u \u0041 \q \' \{ {\$ a$ $ $1 \$x", "{ } {} ${'$'}"];`,
  "<?php return [\"multi\nline\"];",
  // var_export mit Nullbytes und der kleinsten Zahl
  "<?php return ['z' => '' . \"\\0\" . '', 'y' => 'a' . \"\\0\" . '' . \"\\0\" . 'b', 'min' => -9223372036854775807-1, 'max' => 9223372036854775807];",
  // Zahlen
  "<?php return [0, 7, -7, +7, - -7, 017, 0o17, 0O17, 0x1A, 0X1a, -0x10, 0b101, 0B1, 1_000, 0x1_F, 1.5, .5, 1., 1e3, 1E-3, 1.e3, 1_0.5_0, 2.5e+10, -0.0, 0.0, 1.0E+100, 7.0E-10, 0.30000000000000004];",
  "<?php return [9223372036854775807, 9223372036854775808, -9223372036854775808, 0x7FFFFFFFFFFFFFFF, 0xFFFFFFFFFFFFFFFF, 0b1111111111111111111111111111111111111111111111111111111111111111, 0777777777777777777777, 99999999999999999999999];",
  // Schlüssel: Umwandlung, Duplikate, nächster freier Index
  "<?php return ['8' => 'a', '08' => 'b', '-3' => 'c', '-0' => 'd', '1.5' => 'e', true => 'f', false => 'g', null => 'h', 1.7 => 'i', -2.9 => 'j', ' 1' => 'k', '9223372036854775808' => 'l', '9223372036854775807' => 'm'];",
  "<?php return ['x', 3 => 'y', 'z', '5' => 'w', 'v', 'a' => 1, 'b' => 2, 'a' => 3, 'b'];",
  "<?php return [-5 => 'a', 'b'];",
  "<?php return [5 => 'a', 2 => 'b', 'c', -9223372036854775808 => 'min'];",
  "<?php return ['db' => ['host' => 'localhost', 'name' => 'n', 'user' => 'u', 'pass' => 'p'], 'list' => [[1, [2, [3, []]]]], 'empty' => [], 'map' => ['k' => []]];",
  // Ungültiges UTF-8 bleibt Byte für Byte
  "<?php return ['bin' => '\xff\xfe\x80', 'latin' => 'caf\xe9'];",
  // Syntaxfehler (PHP lehnt ab, Node auch)
  "<?php return ['a' => 1,,];",
  "<?php return ['a' 1];",
  "<?php return ['a' => 08];",
  "<?php return ['a' => 1__0];",
  "<?php return ['a' => 1_];",
  "<?php return ['a' => \"\\u{110000}\"];",
  "<?php return ['a' => \"\\u{}\"];",
  "<?php return ['a' => \"\\u{12\"];",
  "<?php return ['a' => 'open];",
  "<?php return ['a' => \"open];",
  "<?php return [",
  "<?php return ['a' => 1]",
  "<?php return ['a' => 1]; /* open",
  "<?php return [9223372036854775807 => 'a', 'b'];",
  "<?php return ['a' => 1abc];",
  "<?php return ['a' => 0b2];",
  "<?php #[Attr]\nreturn [];",
  "<?php return ['a' => 1]; ?>\n<html> text after the closing tag is never printed\n",
  "<?php return [ // ?>\n 'a' => 1];",
];

test('config.php edge cases are read exactly like PHP include', { skip: !HAS_PHP && 'php is not installed' }, () => {
  compare(EDGE.map((s) => file(Buffer.from(s, 'latin1'))), 'edge');
});

// ---------------------------------------------------------------- Dateien wie write_config des alten Installers

// write_config() aus server/install.sh der PHP-Version (2.x), Wort für Wort – sie hat jede config.php der Server geschrieben
const WRITE_CONFIG_PHP = `<?php
[, $current, $old, $domain, $uploads, $dbName, $dbUser] = $argv;
$load = function (string $file): array {
    if ($file === '' || !is_file($file)) {
        return [];
    }
    $c = include $file;
    return is_array($c) ? $c : [];
};
$cfg = array_replace([
    'db' => [],
    'aes_key' => '',
    'app_secret' => '',
    'base_domain' => $domain,
    'scheme' => 'https',
    'timezone' => 'Europe/Berlin',
    'max_pages' => 3,
    'cron_secret' => '',
    'bot_secret' => '',
    'debug' => false,
], $load($current), $load($old));
if ((string) $cfg['aes_key'] === '') {
    $cfg['aes_key'] = bin2hex(random_bytes(16));
}
if ((string) $cfg['app_secret'] === '') {
    $cfg['app_secret'] = bin2hex(random_bytes(32));
}
if ((string) getenv('OYS_BOT_SECRET') !== '') {
    $cfg['bot_secret'] = getenv('OYS_BOT_SECRET');
}
$cfg['db'] = ['host' => 'localhost', 'name' => $dbName, 'user' => $dbUser, 'pass' => (string) getenv('OYS_DB_PASS')];
$cfg['base_domain'] = $domain;
$cfg['scheme'] = 'https';
$cfg['uploads_dir'] = $uploads;
$export = function ($value, string $indent = '') use (&$export): string {
    if (!is_array($value)) {
        return var_export($value, true);
    }
    $out = "[\\n";
    foreach ($value as $k => $v) {
        $out .= $indent . '    ' . var_export($k, true) . ' => ' . $export($v, $indent . '    ') . ",\\n";
    }
    return $out . $indent . ']';
};
echo "<?php\\n"
    . "// OnYourSite – settings. Written by server/install.sh, which keeps these values when it runs again.\\n"
    . "// What each setting means: config.example.php. Keep this file private: it holds the database password\\n"
    . "// and the key for encrypted data (aes_key) – without that key, encrypted data can’t be read.\\n"
    . 'return ' . $export($cfg) . ";\\n";
`;

// Zufällige Einstellungen (in PHP erzeugt) im Format von write_config: Texte mit allen heiklen Bytes, ganze Zahlen bis
// an die Grenzen, Kommazahlen, Wahrheitswerte, null, verschachtelte Listen mit Zahl- und Text-Schlüsseln
const RANDOM_CONFIGS_PHP = `
$writer = $argv[1]; $dir = $argv[2]; $count = (int) $argv[3]; mt_srand((int) $argv[4]); $GLOBALS['utf8only'] = ($argv[5] ?? '') === 'utf8';
function rstr() {
  $pool = ["'", "\\\\", '"', '$', '{', '}', "\\0", "\\n", "\\r", "\\t", 'a', 'Z', '0', ' ', "\\xc3\\xa4", "\\xe2\\x80\\x99", "\\xf0\\x9f\\x98\\x80",
    '?>', '<?php', '//', '#', '/*', '*/', '=>', ',', ']', '[', 'é', '\\\\\\'', '1', '-'];
  if (!$GLOBALS['utf8only']) array_push($pool, "\\xff", "\\x80");
  $s = ''; $n = mt_rand(0, 14);
  for ($i = 0; $i < $n; $i++) $s .= $pool[mt_rand(0, count($pool) - 1)];
  return $s;
}
function rval($d) {
  switch (mt_rand(0, $d > 2 ? 6 : 7)) {
    case 0: case 1: return rstr();
    case 2: return mt_rand(-1000, 1000) * (mt_rand(0, 1) ? 1 : 1000000007);
    case 3: return [PHP_INT_MAX, PHP_INT_MIN, 0, -1, 1][mt_rand(0, 4)];
    case 4: return [0.1, 1.0, -0.0, 1e100, 1.5e-7, 123456.789, 1 / 3, 2.5, 1e15, 1e16, 5e-324, -1.7976931348623157e308][mt_rand(0, 11)];
    case 5: return (bool) mt_rand(0, 1);
    case 6: return null;
    default:
      $a = []; $n = mt_rand(0, 5);
      for ($i = 0; $i < $n; $i++) {
        if (mt_rand(0, 2) === 0) $a[] = rval($d + 1);
        else $a[mt_rand(0, 1) ? rstr() : mt_rand(-5, 5)] = rval($d + 1);
      }
      return $a;
  }
}
for ($f = 0; $f < $count; $f++) {
  $cfg = [];
  $n = mt_rand(1, 8);
  for ($i = 0; $i < $n; $i++) $cfg[mt_rand(0, 3) ? rstr() : mt_rand(-3, 9)] = rval(0);
  $src = "$dir/src$f.php";
  file_put_contents($src, '<?php return ' . var_export($cfg, true) . ';');
  $out = shell_exec('OYS_DB_PASS=pw php ' . escapeshellarg($writer) . ' ' . escapeshellarg($src) . " '' example.test /var/lib/x db user");
  file_put_contents("$dir/written$f.php", $out);
}`;

test('files written by the PHP installer (write_config, var_export) are read exactly like PHP include', { skip: !HAS_PHP && 'php is not installed' }, () => {
  const sub = mkdtempSync(join(dir, 'w-'));
  const writer = file(WRITE_CONFIG_PHP, 'write_config.php');
  const count = 120;
  execFileSync('php', ['-d', 'display_errors=stderr', '-r', RANDOM_CONFIGS_PHP, writer, sub, String(count), '20261101'], { stdio: ['ignore', 'ignore', 'inherit'] });
  const files: string[] = [];
  for (let i = 0; i < count; i++) files.push(join(sub, `src${i}.php`), join(sub, `written${i}.php`));
  // var_export(array) selbst (array ( … )) und die Ausgabe von write_config
  compare(files, 'write_config');
  // Jede Datei ist lesbar (nichts davon wird abgelehnt)
  for (const f of files) assert.equal(nodeTyped(f)[0], 'ok', readFileSync(f, 'latin1'));
});

// Zufallstexte in "…" und '…' mit allen Escape-Arten und Zahlen in allen Schreibweisen
function randomLiteral(rand: () => number): string {
  const pick = <T>(a: T[]): T => a[Math.floor(rand() * a.length)];
  if (rand() < 0.4) {
    const parts = ['\\n', '\\t', '\\r', '\\v', '\\e', '\\f', '\\\\', '\\$', '\\"', '\\0', '\\7', '\\101', '\\400', '\\777', '\\x', '\\x4', '\\x41', '\\xfG',
      '\\u{41}', '\\u{1f600}', '\\u{0}', '\\u', '\\q', "\\'", '$', '$ ', '{', '}', '{ $', 'a', 'ä', '€', '\xff', "'", ' ', '\\{', '{\\$'];
    let s = '';
    for (let i = Math.floor(rand() * 8); i > 0; i--) s += pick(parts);
    return '"' + s + '"';
  }
  if (rand() < 0.6) {
    const parts = ["\\'", '\\\\', '\\', '\\n', '"', '$x', '{$y}', 'a', 'ü', '\x80', ' '];
    let s = '';
    for (let i = Math.floor(rand() * 8); i > 0; i--) s += pick(parts);
    // ein einzelner \ am Ende würde das ' schützen
    if (s.endsWith('\\') && !s.endsWith('\\\\')) s += '\\';
    return "'" + s + "'";
  }
  return pick(['', '-', '+', '- ', '-+']) + pick(['0', '1', '42', '017', '09', '0x1f', '0XFF_FF', '0b10', '0o7', '1_0', '1.5', '.5', '5.', '1e3', '1E+3', '2.5e-3',
    '1_000.000_1', '9223372036854775807', '9223372036854775808', '0x8000000000000000', '1e400', '0.1', '00', '0_7']);
}

test('random texts and numbers in every notation are read exactly like PHP', { skip: !HAS_PHP && 'php is not installed' }, () => {
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x80000000;
  };
  const files: string[] = [];
  for (let i = 0; i < 300; i++) {
    const items: string[] = [];
    for (let k = Math.floor(rand() * 6) + 1; k > 0; k--) items.push(rand() < 0.5 ? `${randomLiteral(rand)} => ${randomLiteral(rand)}` : randomLiteral(rand));
    files.push(file(Buffer.from(`<?php\nreturn [${items.join(', ')}];\n`, 'latin1')));
  }
  const interpolated = compare(files, 'random');
  // Ein paar Zufallstexte enthalten "$name" – die müssen abgelehnt worden sein (oben geprüft), der Rest ist gleich
  assert.ok(interpolated < 60, `${interpolated} of 300 had variables`);
});

// ---------------------------------------------------------------- Was nur PHP ausführen könnte, wird abgelehnt

const REFUSED: string[] = [
  "<?php return ['a' => getenv('X')];",
  "<?php return ['a' => __DIR__ . '/x'];",
  "<?php return ['a' => PHP_EOL];",
  "<?php return ['a' => INF];",
  "<?php $c = ['a' => 1]; return $c;",
  "<?php return ['a' => \"x$y\"];",
  "<?php return ['a' => \"{$y}\"];",
  "<?php return ['a' => \"${y}\"];",
  "<?php return ['a' => <<<EOT\nx\nEOT];",
  "<?php return ['a' => <<<'EOT'\nx\nEOT];",
  "<?php return ['a' => 1 + 2];",
  "<?php return ['a' => 'x' . 5];",
  "<?php return ['a' => -'5'];",
  "<?php declare(strict_types=1); return [];",
  "<?php return ['a' => \\true];",
  "<?php return [...['a' => 1]];",
  "<?php return []; echo 1;",
  "<?php return ['a' => (1)];",
  "<?php return ['a' => true ? 1 : 2];",
  "<?php return ['a' => [1, 2][0]];",
  "<?php return ['a' => 1]; ?>\n<?php echo 2;",
  "<?php\nif (true) { return ['a' => 1]; }",
  "<?php return ['a' => 1]; ?>\nok <?php echo 2;",
];

test('anything else is refused with a clear message (PHP itself accepts these)', { skip: !HAS_PHP && 'php is not installed' }, () => {
  const files = REFUSED.map((s) => file(s));
  const php = phpTyped(files);
  files.forEach((f, i) => {
    assert.equal(php[i][0], 'ok', `PHP should accept: ${REFUSED[i]} (${php[i][1]})`);
    const node = nodeTyped(f);
    assert.equal(node[0], 'error', `must be refused: ${REFUSED[i]}`);
    assert.match(String(node[1]), /line \d+: .*(without PHP|expected|no more PHP code)/, REFUSED[i]);
  });
});

test('refusals name the file, the line and what was found', () => {
  const f = file("<?php\n\nreturn [\n  'db' => ['pass' => getenv('DB_PASS')],\n];\n", 'config.php');
  assert.throws(() => main(['from-php', f], {}, { write() {} }), (err: Error) => {
    assert.ok(err instanceof ConfigError);
    assert.equal(err.message, 'config.php, line 4: this can’t be read without PHP (allowed are only \'text\', "text", numbers, true, false, null and [ … ] lists) – found: "getenv(\'DB_PASS\')],"');
    return true;
  });
});

// ---------------------------------------------------------------- from-php = json_encode wie config-from-php.php

const JSON_PHP = '$c = include $argv[1]; $j = json_encode($c, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE); if ($j === false) exit(3); echo $j, "\\n";';

function runScript(args: string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  // Ohne PHP im Suchpfad: das Werkzeug darf es nie brauchen
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { env: { PATH: '/nonexistent', ...env }, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('from-php prints the same JSON as PHP json_encode (and runs without PHP)', { skip: !HAS_PHP && 'php is not installed' }, () => {
  const sub = mkdtempSync(join(dir, 'j-'));
  const writer = file(WRITE_CONFIG_PHP, 'write_config2.php');
  execFileSync('php', ['-d', 'display_errors=stderr', '-r', RANDOM_CONFIGS_PHP, writer, sub, '60', '99', 'utf8'], { stdio: ['ignore', 'ignore', 'inherit'] });
  const files = [join(ROOT_DIR, 'config.example.php'), ...EDGE.slice(0, 22).map((s) => file(Buffer.from(s, 'latin1')))];
  for (let i = 0; i < 60; i++) files.push(join(sub, `written${i}.php`));
  let utf8 = 0;
  let broken = 0;
  for (const f of files) {
    const php = spawnSync('php', ['-d', 'display_errors=stderr', '-r', JSON_PHP, f], { encoding: 'utf8' });
    const node = runScript(['from-php', f]);
    if (php.status === 3) {
      // json_encode scheitert an ungültigem UTF-8 – config.mjs bricht mit einer Meldung ab (früher: leere Ausgabe)
      assert.equal(node.status, 1, f);
      assert.match(node.stderr, /isn’t valid UTF-8 text|is not a finite number/);
      broken++;
    } else if (php.status === 0 && (php.stdout.startsWith('{') || php.stdout.startsWith('['))) {
      assert.equal(node.status, 0, node.stderr);
      assert.equal(node.stdout, php.stdout, f);
      utf8++;
    }
  }
  assert.ok(utf8 >= 60 && broken >= 1, `${utf8} UTF-8 files, ${broken} with invalid UTF-8 or INF`);
});

// ---------------------------------------------------------------- write = write_config der PHP-Version (+ Node-Schlüssel)

function phpWrite(current: string, old: string, env: Record<string, string>): Map<string, unknown> {
  const writer = file(WRITE_CONFIG_PHP, `wc${n++}.php`);
  const out = execFileSync('php', [writer, current, old, 'example.test', '/var/lib/onyoursite/uploads', 'onyoursite', 'onyoursite'], { env: { ...process.env, ...env } });
  return loadSettings(file(out)) as Map<string, unknown>;
}

function nodeWrite(current: string, old: string, env: Record<string, string>): Map<string, unknown> {
  const target = join(mkdtempSync(join(dir, 'nw-')), 'config.json');
  const args = ['write', '--file', target, '--domain', 'example.test', '--uploads', '/var/lib/onyoursite/uploads', '--db-name', 'onyoursite', '--db-user', 'onyoursite', '--previous', join(dir, 'previous.json')];
  if (current) args.push('--current', current);
  if (old) args.push('--import', old);
  assert.equal(main(args, env, { write() {} }), 0);
  return loadSettings(target) as Map<string, unknown>;
}

test('write keeps, replaces and creates values exactly like write_config of the PHP installer', { skip: !HAS_PHP && 'php is not installed' }, () => {
  // Schlüssel erst zur Laufzeit zusammengesetzt (keine schlüsselartigen Texte im Repository)
  const curKey = 'current-' + 'c'.repeat(24);
  const oldKey = 'imported-' + 'i'.repeat(23);
  const cur = file(`<?php return ['db' => ['host' => 'db.old', 'name' => 'x', 'user' => 'y', 'pass' => 'z', 'socket' => '/s'], 'aes_key' => '${curKey}', 'app_secret' => '', 'timezone' => 'Europe/Vienna', 'max_pages' => 5, 'custom' => ['a' => [1, 2]], 'debug' => true, 'base_domain' => 'old.test', 'scheme' => 'http', 'uploads_dir' => '../up', 'bot_secret' => 'b0t'];`);
  const old = file(`<?php return ['aes_key' => '${oldKey}', 'cron_secret' => 'c', 'extra' => "t\\u{e4}xt", 'max_pages' => '7'];`);
  const falsy = file("<?php return ['aes_key' => false, 'app_secret' => 0, 'bot_secret' => null];");
  const zero = file("<?php return ['aes_key' => '0', 'app_secret' => [], 'cron_secret' => 1.5];");
  const cases: Array<[string, string, Record<string, string>]> = [
    ['', '', { OYS_DB_PASS: 'secretpass' }],
    [cur, '', { OYS_DB_PASS: 'p' }],
    [cur, old, { OYS_DB_PASS: 'p', OYS_BOT_SECRET: 'new-bot-secret' }],
    ['', old, {}],
    [falsy, '', { OYS_DB_PASS: '' }],
    [zero, '', { OYS_DB_PASS: 'q' }],
  ];
  for (const [c, o, env] of cases) {
    const php = phpWrite(c, o, env);
    const node = nodeWrite(c, o, env);
    // Neue Schlüssel sind zufällig: nur ihr Format zählt
    for (const k of ['aes_key', 'app_secret']) {
      if (typeof php.get(k) === 'string' && /^[0-9a-f]+$/.test(php.get(k) as string) && (php.get(k) as string).length >= 32 && php.get(k) !== node.get(k)) {
        assert.match(String(node.get(k)), k === 'aes_key' ? /^[0-9a-f]{32}$/ : /^[0-9a-f]{64}$/);
        node.set(k, php.get(k));
      }
    }
    // Neu in Node: Port und der Kopf mit der Besucher-Adresse
    assert.equal(node.get('node_port'), 3000);
    assert.equal(node.get('client_ip_header'), 'x-oys-client-ip');
    node.delete('node_port');
    node.delete('client_ip_header');
    assert.equal(encodeJson(node), encodeJson(php), `current=${c} old=${o}`);
  }
});

test('write keeps an own node_port and only generates missing keys', () => {
  const target = join(mkdtempSync(join(dir, 'p-')), 'config.json');
  writeFileSync(target, JSON.stringify({ aes_key: 'a'.repeat(32), app_secret: 'b'.repeat(64), node_port: 3100, other: { x: [1, 'zwei'] } }));
  main(['write', '--file', target, '--domain', 'd.test', '--uploads', '/u', '--db-name', 'n', '--db-user', 'u', '--previous', join(dir, 'prev-p.json')], { OYS_DB_PASS: 'pw' }, { write() {} });
  const cfg = JSON.parse(readFileSync(target, 'utf8'));
  assert.equal(cfg.aes_key, 'a'.repeat(32));
  assert.equal(cfg.app_secret, 'b'.repeat(64));
  assert.equal(cfg.node_port, 3100);
  assert.deepEqual(cfg.other, { x: [1, 'zwei'] });
  assert.deepEqual(cfg.db, { host: 'localhost', name: 'n', user: 'u', pass: 'pw' });
  assert.equal(cfg.uploads_dir, '/u');
  assert.equal(cfg.client_ip_header, 'x-oys-client-ip');
});

test('write converts the config.php next to it when there is no config.json yet', () => {
  const sub = mkdtempSync(join(dir, 'conv-'));
  const key = "it's " + 'kept'.repeat(6) + ' !';
  writeFileSync(join(sub, 'config.php'), `<?php\nreturn ['aes_key' => '${key.replace("'", "\\'")}', 'app_secret' => "s\\x41", 'timezone' => 'UTC'];\n`);
  main(['write', '--file', join(sub, 'config.json'), '--domain', 'd.test', '--uploads', '/u', '--db-name', 'n', '--db-user', 'u', '--previous', join(dir, 'prev-c.json')], {}, { write() {} });
  const cfg = JSON.parse(readFileSync(join(sub, 'config.json'), 'utf8'));
  assert.equal(cfg.aes_key, key);
  assert.equal(cfg.app_secret, 'sA');
  assert.equal(cfg.timezone, 'UTC');
  // config.php bleibt unverändert liegen
  assert.ok(existsSync(join(sub, 'config.php')));
});

test('write refuses a config.php it can’t read and leaves everything as it was', () => {
  const sub = mkdtempSync(join(dir, 'ref-'));
  writeFileSync(join(sub, 'config.php'), "<?php\nreturn ['aes_key' => AES_KEY];\n");
  assert.throws(() => main(['write', '--file', join(sub, 'config.json'), '--domain', 'd', '--uploads', '/u', '--db-name', 'n', '--db-user', 'u'], {}, { write() {} }), /config\.php, line 2: this can’t be read without PHP/);
  assert.equal(existsSync(join(sub, 'config.json')), false);
  const r = runScript(['write', '--file', join(sub, 'config.json'), '--domain', 'd', '--uploads', '/u', '--db-name', 'n', '--db-user', 'u']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^config\.mjs: config\.php, line 2: /);
});

test('writes are atomic, root:www-data 0640, and the previous version is kept for root only', { skip: process.getuid?.() !== 0 && 'needs root' }, () => {
  const sub = mkdtempSync(join(dir, 'perm-'));
  const target = join(sub, 'config.json');
  const prev = join(sub, 'etc', 'config.json.previous');
  const args = ['write', '--file', target, '--domain', 'd.test', '--uploads', '/u', '--db-name', 'n', '--db-user', 'u', '--previous', prev];
  main(args, { OYS_DB_PASS: 'one' }, { write() {} });
  const wwwData = Number(execFileSync('getent', ['group', 'www-data']).toString().split(':')[2]);
  let st = statSync(target);
  assert.equal(st.mode & 0o777, 0o640);
  assert.equal(st.uid, 0);
  assert.equal(st.gid, wwwData);
  // Erste Fassung: noch keine vorige
  assert.equal(existsSync(prev), false);
  const first = readFileSync(target, 'utf8');
  // Gleicher Inhalt: keine vorige Fassung
  main(args, { OYS_DB_PASS: 'one' }, { write() {} });
  assert.equal(existsSync(prev), false);
  // Geändert: die alte Fassung liegt nur für root lesbar daneben
  main(args, { OYS_DB_PASS: 'two' }, { write() {} });
  assert.equal(readFileSync(prev, 'utf8'), first);
  assert.equal(statSync(prev).mode & 0o777, 0o600);
  assert.equal(statSync(join(sub, 'etc')).mode & 0o777, 0o700);
  st = statSync(target);
  assert.equal(st.mode & 0o777, 0o640);
  assert.equal(JSON.parse(readFileSync(target, 'utf8')).db.pass, 'two');
  // Keine Reste von Zwischendateien
  assert.deepEqual(execFileSync('ls', ['-A', sub]).toString().split('\n').filter(Boolean).sort(), ['config.json', 'etc']);
});

// ---------------------------------------------------------------- get, set, reset-keys

test('get reads config.json and config.php like the old php_cfg (scalars only, missing = empty)', () => {
  const json = file(JSON.stringify({ db: { pass: 'p"w', port: 3306 }, debug: false, on: true, list: [1], timezone: 'Europe/Berlin' }), 'g.json');
  const php = file("<?php return ['db' => ['pass' => 'p\"w', 'port' => 3306], 'debug' => false, 'on' => true, 'list' => [1], 'timezone' => 'Europe/Berlin'];");
  for (const f of [json, php]) {
    const get = (k: string) => runScript(['get', k, '--file', f]);
    assert.equal(get('db.pass').stdout, 'p"w');
    assert.equal(get('db.port').stdout, '3306');
    assert.equal(get('debug').stdout, '');
    assert.equal(get('on').stdout, '1');
    assert.equal(get('list').stdout, '');
    assert.equal(get('db').stdout, '');
    assert.equal(get('missing.key').stdout, '');
    assert.equal(get('timezone').status, 0);
  }
  assert.equal(runScript(['get', 'x', '--file', join(dir, 'nothing.json')]).stdout, '');
});

test('set and reset-keys change only what they should (secrets come from the environment)', () => {
  const sub = mkdtempSync(join(dir, 'set-'));
  const target = join(sub, 'config.json');
  writeFileSync(target, JSON.stringify({ aes_key: 'k', app_secret: 's', cron_secret: 'c', bot_secret: 'b', db: { name: 'n' } }));
  const env = { OYS_CONFIG_PREVIOUS: join(sub, 'prev.json') };
  assert.equal(runScript(['set', 'bot_secret', '--file', target], { ...env, OYS_VALUE: 'from-env' }).status, 0);
  assert.equal(runScript(['set', 'db.pool', '5', '--json', '--file', target], env).status, 0);
  assert.equal(runScript(['set', 'new.nested.key', 'v', '--file', target], env).status, 0);
  let cfg = JSON.parse(readFileSync(target, 'utf8'));
  assert.equal(cfg.bot_secret, 'from-env');
  assert.deepEqual(cfg.db, { name: 'n', pool: 5 });
  assert.deepEqual(cfg.new, { nested: { key: 'v' } });
  assert.equal(runScript(['set', 'x', '--file', target], env).status, 1);
  assert.equal(runScript(['reset-keys', '--file', target], env).status, 0);
  cfg = JSON.parse(readFileSync(target, 'utf8'));
  assert.equal(cfg.aes_key, undefined);
  assert.equal(cfg.app_secret, undefined);
  assert.equal(cfg.cron_secret, undefined);
  assert.equal(cfg.bot_secret, 'from-env');
  // set auf eine fehlende Datei: Meldung statt einer neuen Datei
  const missing = runScript(['set', 'a', 'b', '--file', join(sub, 'none.json')], env);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /doesn’t exist yet/);
});

test('the JSON model keeps PHP lists as arrays and maps in their order', () => {
  const v = parsePhpConfig(Buffer.from("<?php return ['b' => 1, 'a' => [3 => 'x', 1 => 'y'], 'l' => ['p', 'q'], 9 => true];"));
  assert.equal(encodeJson(phpToJson(v)), '{\n    "b": 1,\n    "a": {\n        "3": "x",\n        "1": "y"\n    },\n    "l": [\n        "p",\n        "q"\n    ],\n    "9": true\n}');
  const cfg = buildConfig({ current: null, imported: null, domain: 'd', uploads: '/u', dbName: 'n', dbUser: 'u' });
  assert.deepEqual([...cfg.keys()], ['db', 'aes_key', 'app_secret', 'base_domain', 'scheme', 'timezone', 'max_pages', 'cron_secret', 'bot_secret', 'debug', 'uploads_dir', 'node_port', 'client_ip_header']);
});
