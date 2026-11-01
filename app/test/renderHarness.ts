// Gemeinsame Hilfen für die Vergleiche der Darstellung mit PHP (lib/render.php, lib/demo.php, lib/share.php):
// PHP lädt dieselben Bibliotheken wie im Betrieb (über runPhp aus modelHarness) und bekommt dieselben Eingaben als
// JSON-Text. Zeitpunkte (now) werden als Unix-Sekunden übergeben und in PHP zu DateTimeImmutable in der Zeitzone der Seite.
import { ROOT_DIR, type ConfigData } from '../src/config.js';
import { hmac } from '../src/crypto.js';
import { intval } from '../src/php.js';
import { runPhp } from './modelHarness.js';

export const PHP_RENDER_LIBS = `require_once '${ROOT_DIR}/lib/render.php'; require_once '${ROOT_DIR}/lib/demo.php';`;

// PHP: $opts['now'] (Unix-Sekunden, auch mit Bruchteil) → DateTimeImmutable in der Zeitzone der Seite
export const PHP_OPTS = `
  function test_opts(array $o): array {
    if (isset($o['now'])) {
      $o['now'] = DateTimeImmutable::createFromFormat('U.u', sprintf('%.6F', $o['now']))->setTimezone(new DateTimeZone(oys_config('timezone', 'Europe/Berlin')));
    }
    return $o;
  }`;

// PHP-Code ausführen, der in $out eine Liste von Texten sammelt (Fehler → "THROW")
export function runPhpList(body: string, input: string, opts: { config?: ConfigData; db?: boolean } = {}): string[] {
  const script = `${PHP_RENDER_LIBS}
    ${PHP_OPTS}
    $out = [];
    ${body}
    echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);`;
  return JSON.parse(runPhp(script, input, opts)) as string[];
}

// Kontakt-Token (Zeitstempel.HMAC) prüfen und durch einen festen Text ersetzen – der Zeitstempel ist time() beim
// Erzeugen und darf sich zwischen PHP und Node unterscheiden. Ungültige Tokens bleiben stehen (→ Vergleich schlägt fehl).
export function normalizeTokens(html: string, pageId: unknown): string {
  return html.replace(/<input type="hidden" name="b" value="([^"]*)"><input type="hidden" name="t" value="(\d+)\.([0-9a-f]{32})">/g,
    (m, blockEsc: string, ts: string, mac: string) => {
      const blockId = blockEsc.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      const ok = hmac(intval(pageId ?? 0) + '|' + blockId + '|' + ts).slice(0, 32) === mac && Math.abs(Number(ts) - Date.now() / 1000) < 600;
      return ok ? m.replace(`${ts}.${mac}`, 'TOKEN') : m;
    });
}

// Erste abweichende Stelle zweier Texte mit etwas Umgebung (für lesbare Fehlermeldungen)
export function firstDiff(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length && i === b.length) return '';
  return `at ${i}: php …${JSON.stringify(a.slice(Math.max(0, i - 80), i + 80))}… node …${JSON.stringify(b.slice(Math.max(0, i - 80), i + 80))}…`;
}
