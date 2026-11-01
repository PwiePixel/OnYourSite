// Gemeinsame Hilfen für die Vergleiche des Inhalts-Pakets mit den echten PHP-Funktionen (lib/themes.php, social.php,
// blocks.php, pages.php, share.php). PHP bekommt dieselben Eingaben als JSON-Text und eigene Einstellungen
// (oys_config() wird hier ersetzt), damit Datenbank und Upload-Ordner pro Test frei wählbar sind.
import { execFileSync } from 'node:child_process';
import { ROOT_DIR, loadConfig, type ConfigData } from '../src/config.js';
import { jsonUnescaped } from '../src/html.js';

const LIBS = ['lib/helpers.php', 'lib/storage.php', 'lib/themes.php', 'lib/social.php', 'lib/blocks.php', 'lib/pages.php', 'lib/share.php', 'lib/codesites.php'];

// PHP-Code ausführen: $in = json_decode(<input>, true); mit db: true steht $pdo bereit (wie db.php)
export function runPhp(body: string, input: string, opts: { config?: ConfigData; db?: boolean } = {}): string {
  const config = opts.config ?? loadConfig();
  const script = `
    function oys_config(?string $key = null, $default = null) {
      static $c = null;
      if ($c === null) $c = json_decode(getenv('OYS_TEST_CONFIG'), true);
      if ($key === null) return $c;
      $v = $c;
      foreach (explode('.', $key) as $p) { if (!is_array($v) || !array_key_exists($p, $v)) return $default; $v = $v[$p]; }
      return $v;
    }
    date_default_timezone_set(oys_config('timezone', 'Europe/Berlin'));
    mb_internal_encoding('UTF-8');
    ${LIBS.map((f) => `require '${ROOT_DIR}/${f}';`).join('\n')}
    ${opts.db ? `$pdo = new PDO('mysql:host=' . oys_config('db.host', 'localhost') . ';dbname=' . oys_config('db.name') . ';charset=utf8mb4', oys_config('db.user', ''), oys_config('db.pass', ''),
      [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
      $pdo->exec("SET time_zone = '" . date('P') . "'");` : ''}
    $in = json_decode(stream_get_contents(STDIN), true);
    if ($in === null && json_last_error() !== JSON_ERROR_NONE) { fwrite(STDERR, 'bad test input: ' . json_last_error_msg()); exit(1); }
    ${body}`;
  try {
    return execFileSync('php', ['-d', 'display_errors=stderr', '-d', 'memory_limit=1G', '-r', script], {
      input,
      env: { ...process.env, OYS_TEST_CONFIG: JSON.stringify(config) },
      maxBuffer: 512 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
  } catch (err) {
    const e = err as { stderr?: Buffer; stdout?: Buffer };
    throw new Error('PHP failed: ' + String(e.stderr ?? '').slice(-2000) + String(e.stdout ?? '').slice(-500));
  }
}

// Wie oys_json(): json_encode(…, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) – PHP und Node werden als Text verglichen
export const FLAGS = 'JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES';
export const enc = (v: unknown): string => jsonUnescaped(v);

// PHP-Seite: jeder Fall einzeln als JSON-Text (Fehler → "THROW"), damit Abweichungen pro Fall sichtbar werden
export const PHP_EACH = (expr: string) => `
  $out = [];
  foreach ($in as $i => $c) {
    try { $r = (function ($c) use (&$pdo) { return ${expr}; })($c); $out[] = json_encode($r, ${FLAGS}); }
    catch (Throwable $e) { $out[] = 'THROW'; }
  }
  echo json_encode($out);`;

export function nodeEach(cases: unknown[], fn: (c: unknown) => unknown): string[] {
  return cases.map((c) => {
    try {
      return enc(fn(c));
    } catch {
      return 'THROW';
    }
  });
}

export async function nodeEachAsync(cases: unknown[], fn: (c: unknown) => Promise<unknown>): Promise<string[]> {
  const out: string[] = [];
  for (const c of cases) {
    try {
      out.push(enc(await fn(c)));
    } catch {
      out.push('THROW');
    }
  }
  return out;
}

// Unterschiede (höchstens die ersten 10) mit dem jeweiligen Fall
export function diffs(cases: string[] | unknown[], node: string[], php: string[]): Array<{ i: number; input: string; node: string; php: string }> {
  const out: Array<{ i: number; input: string; node: string; php: string }> = [];
  for (let i = 0; i < Math.max(node.length, php.length) && out.length < 10; i++) {
    if (node[i] !== php[i]) out.push({ i, input: String(typeof cases[i] === 'string' ? cases[i] : JSON.stringify(cases[i])).slice(0, 300), node: String(node[i]).slice(0, 600), php: String(php[i]).slice(0, 600) });
  }
  return out;
}

// ---------------------------------------------------------------- JSON-Text mit fester Reihenfolge

// Objekt mit genau dieser Schlüssel-Reihenfolge (auch "5" nach "a" – das kann ein JavaScript-Objekt nicht)
export class O {
  constructor(public pairs: Array<[string, unknown]>) {}
}
// JSON-Text unverändert (z. B. -0, 1.0, 12345678901234567)
export class Raw {
  constructor(public text: string) {}
}
export function jsonText(v: unknown): string {
  if (v instanceof Raw) return v.text;
  if (v instanceof O) return '{' + v.pairs.map(([k, x]) => JSON.stringify(k) + ':' + jsonText(x)).join(',') + '}';
  if (Array.isArray(v)) return '[' + v.map(jsonText).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.entries(v).map(([k, x]) => JSON.stringify(k) + ':' + jsonText(x)).join(',') + '}';
  return JSON.stringify(v) ?? 'null';
}

// ---------------------------------------------------------------- Zufall (fester Startwert, wiederholbar)

// mulberry32: rechnet nur mit 32-Bit-Zahlen (ein klassischer LCG verliert in JavaScript-Zahlen Stellen und wiederholt sich)
export function rng(seed: number) {
  let s = seed >>> 0;
  const next = (n: number): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
  const pick = <T>(list: readonly T[]): T => list[next(list.length)];
  const chance = (p: number): boolean => next(1000) < p * 1000;
  return { next, pick, chance };
}

// Kommazahlen schreibt json_encode anders als JavaScript (1.0e+19, 1.0e-5, -0). Gespeicherte Werte, die unverändert
// durchgereicht werden, können solche Zahlen enthalten – zum Vergleich wird PHPs Schreibweise (außerhalb von Texten)
// in die von JavaScript umgesetzt. JavaScript kennt den Unterschied zwischen int und float nicht.
export function jsFloats(json: string): string {
  let out = '';
  for (let i = 0; i < json.length; ) {
    if (json[i] === '"') {
      let j = i + 1;
      while (j < json.length && json[j] !== '"') j += json[j] === '\\' ? 2 : 1;
      out += json.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(json.slice(i, i + 40));
    if (m && (m[1] !== undefined || m[2] !== undefined || m[0] === '-0')) {
      out += JSON.stringify(Number(m[0]));
      i += m[0].length;
      continue;
    }
    out += m ? m[0] : json[i];
    i += m ? m[0].length : 1;
  }
  return out;
}
