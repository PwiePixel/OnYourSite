// Beispielseiten gegen PHP (lib/demo.php): Daten von oys_demo_page() für jedes Design, die damit gezeichnete
// Seite (wie /_/demo/{design}, auch mit ?layout=) und die kleinen Vorschauen von oys_mini_html()
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseHost } from '../src/helpers.js';
import { demoPage, miniHtml } from '../src/content/demo.js';
import { renderPage } from '../src/content/render.js';
import { layouts, themes } from '../src/content/themes.js';
import { enc, jsonText } from './modelHarness.js';
import { firstDiff, runPhpList } from './renderHarness.js';

const THEMES = [...Object.keys(themes()), 'unknown', '', 'TRS', 'constructor', '__proto__', 'Deep-Dark'];
const LAYOUTS = [...Object.keys(layouts()), 'zigzag', '"x'];

test('demo page data matches oys_demo_page() for every theme', () => {
  const php = runPhpList('foreach ($in as $t) { $out[] = json_encode(oys_demo_page($t), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES); }', jsonText(THEMES));
  assert.deepEqual(THEMES.map((t) => enc(demoPage(t))), php);
});

test('demo pages render like /_/demo/{theme} in PHP – every theme with its own and with every other layout', () => {
  const now = Math.floor(Date.now() / 1000);
  const cases: Array<{ theme: string; layout: string | null }> = [];
  for (const theme of Object.keys(themes())) {
    cases.push({ theme, layout: null });
    for (const layout of Object.keys(layouts())) cases.push({ theme, layout });
  }
  const input = cases.map((c) => ({ ...c, now, host: baseHost() }));
  const php = runPhpList(`foreach ($in as $c) {
      $demo = oys_demo_page($c['theme']);
      if ($c['layout'] !== null) $demo['page']['layout'] = $c['layout'];
      $out[] = oys_render_page($demo['page'], $demo['blocks'], test_opts(['mode' => 'demo', 'entrance' => 'skip', 'host' => $c['host'], 'now' => $c['now']]));
    }`, jsonText(input));
  const node = cases.map((c) => {
    const demo = demoPage(c.theme, now)!;
    if (c.layout !== null) demo.page.layout = c.layout;
    return renderPage(demo.page, demo.blocks, { mode: 'demo', entrance: 'skip', host: baseHost(), now });
  });
  assert.deepEqual(node.map((x, i) => (x === php[i] ? '' : `${cases[i].theme}/${cases[i].layout}: ${firstDiff(php[i], x)}`)).filter(Boolean), []);
  assert.ok(php.every((x) => x.includes('oys-cd-num') && x.includes('mode-demo')), 'countdown and demo mode');
});

test('mini previews match oys_mini_html() for every theme and layout', () => {
  const cases: Array<[string, string | null]> = [];
  for (const t of THEMES) cases.push([t, null]);
  for (const l of LAYOUTS) cases.push(['galaxy', l]);
  cases.push(['<b>"x"</b>', "o'brien"]);
  const php = runPhpList("foreach ($in as [$t, $l]) { $out[] = $l === null ? oys_mini_html($t) : oys_mini_html($t, $l); }", jsonText(cases));
  assert.deepEqual(cases.map(([t, l]) => (l === null ? miniHtml(t) : miniHtml(t, l))), php);
});

// Der Countdown der Beispielseite endet in 9 Tagen um 18 Uhr Ortszeit – wie (new DateTimeImmutable('today', $tz))
// ->modify('+9 days')->setTime(18, 0), hier mit festem „jetzt“ (Mitternacht, Zeitumstellung, Jahres- und Monatsende)
test('the demo countdown target is today + 9 days at 18:00 local time for any moment', () => {
  const nows: number[] = [];
  for (const day of ['2026-03-20', '2026-03-29', '2026-10-16', '2026-10-25', '2026-12-22', '2026-12-31', '2028-02-20', '2027-01-31']) {
    const midnight = Date.parse(day + 'T00:00:00Z') / 1000;
    for (const off of [-7201, -3601, -3600, -1, 0, 1, 3599, 3600, 7199, 7200, 43200, 82799, 82800, 86399]) nows.push(midnight + off);
  }
  const php = runPhpList(`$tz = new DateTimeZone(oys_config('timezone', 'Europe/Berlin'));
    foreach ($in as $n) { $out[] = (new DateTimeImmutable('@' . $n))->setTimezone($tz)->setTime(0, 0)->modify('+9 days')->setTime(18, 0)->format('Y-m-d\\TH:i'); }`, jsonText(nows));
  assert.deepEqual(nows.map((n) => demoPage('galaxy', n)!.blocks[5].data.target), php);
  // Und so rechnet oys_demo_page() selbst: 'today' ist derselbe Tag wie oben (vorher und nachher gemessen, falls
  // gerade Mitternacht ist)
  const today = runPhpList(`$tz = new DateTimeZone(oys_config('timezone', 'Europe/Berlin'));
    $f = fn() => (new DateTimeImmutable('now', $tz))->setTime(0, 0)->format('Y-m-d H:i');
    $before = $f(); $t = (new DateTimeImmutable('today', $tz))->format('Y-m-d H:i'); $after = $f();
    $out[] = $t === $before || $t === $after ? 'same' : $t;`, '[]');
  assert.deepEqual(today, ['same']);
});
