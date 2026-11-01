// date()/gmdate()/strtotime() mit frühen Jahren gegen echtes PHP: Date.UTC() liest 0–99 als 1900–1999, Intl zählt
// Jahre vor Christus ohne Vorzeichen, und PHP schreibt "Y" mindestens vierstellig (0001, -0001). Anlass: der
// Zeitstempel 0000-00-00 00:00:00 in users.created_at (Admin-Panel, „Joined:“).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { date, gmdate, strtotime } from '../src/php.js';

const TZ = 'Europe/Berlin';
function php(code: string, input: unknown): unknown {
  const script = `date_default_timezone_set('${TZ}'); $in = json_decode(stream_get_contents(STDIN), true); $out = (function ($in) { ${code} })($in); echo json_encode($out);`;
  return JSON.parse(execFileSync('php', ['-r', script], { input: JSON.stringify(input) }).toString());
}

// Alles außer "T" (Kürzel der Zeitzone wie CET/LMT kennt date() hier nicht – die Seite benutzt es nicht)
const FORMAT = 'Y y L z t W o N w D M j n d m H i s U I O P Z';

// Feste Stichproben (Jahr -1, 0, 1, 99, 100, Ortszeit LMT vor 1893) und gleichmäßig verteilte Zeitpunkte bis 9999
const STAMPS = [-62169987208, -62167219200, -62135596800, -62135600008, -59011459200, -59011462409, -30610224000,
  -2208988800, -1, 0, 1, 951782400, 1711846800, 1793833200, 253402297199];
for (let i = 0; i < 200; i++) STAMPS.push(-62169987208 + Math.floor((i * (253402297199 + 62169987208)) / 199));

test('date() and gmdate() match PHP for every year from -1 to 9999', () => {
  const theirs = php('return [array_map(fn($t) => date($in[1], $t), $in[0]), array_map(fn($t) => gmdate($in[1], $t), $in[0])];', [STAMPS, FORMAT]) as string[][];
  assert.deepEqual(STAMPS.map((t) => date(FORMAT, t, TZ)), theirs[0]);
  assert.deepEqual(STAMPS.map((t) => gmdate(FORMAT, t)), theirs[1]);
});

test('strtotime() reads dates with years below 100 like PHP', () => {
  const inputs = ['0000-00-00 00:00:00', '0000-00-00', '0000-01-01 00:00:00', '0001-01-01 00:00:00', '0050-06-15 12:00:00', '0004-02-29 10:00:00',
    '0099-12-31 23:59:59', '0100-01-01 00:00:00', '1000-01-01 00:00:00', '1893-04-01 00:00:00', '0000-00-00 00:00:00 +1 day', '0000-00-00T00:00:00Z',
    '0012-06-01T10:00:00+02:00'];
  assert.deepEqual(inputs.map((s) => strtotime(s, 1793534400, TZ)), php('return array_map(fn($s) => strtotime($s, 1793534400), $in);', inputs));
});
