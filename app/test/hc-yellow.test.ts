// Gelbe Honigwaben-Symbole (honeycomb-shop §5.1): die Regeln in editor.css nutzen die --hc-Werte aus ui.css mit
// Ersatzwerten (ohne ui.css bleibt alles gelb), die Stellen im Editor-Skript, die Bedingungen der Code-Seiten und
// das Logo, das in der Markenfarbe bleibt. Die berechneten Farben im Browser prüft tests/e2e/hc-yellow.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_DIR } from '../src/config.js';
import { termsCodePagesView } from '../src/code/terms.js';

const css = readFileSync(join(ROOT_DIR, 'static/css/editor.css'), 'utf8');
const js = readFileSync(join(ROOT_DIR, 'static/js/editor.js'), 'utf8');

// Deklarationen einer Regel auf oberster Ebene (genau ein Treffer für den Selektor; eingerückte Regeln stehen in @media)
function rule(selector: string): string {
  const hits = [...css.matchAll(/(^|\n)([^\s{}][^{}\n]*)\{([^}]*)\}/g)].filter((m) => m[2].trim() === selector);
  assert.equal(hits.length, 1, selector);
  return hits[0][3];
}

test('editor.css: honeycomb rules use the --hc tokens with yellow fallbacks', () => {
  const expect: Array<[string, RegExp[]]> = [
    ['.hc-icon', [/color: var\(--hc, #facc15\)/]],
    ['.bdg.hc', [/background: var\(--hc-soft, rgba\(250, 204, 21, \.12\)\)/, /color: var\(--hc, #facc15\)/]],
    ['.hc-pill', [/background: var\(--hc-soft, rgba\(250, 204, 21, \.12\)\)/, /border: 1px solid var\(--hc-line, rgba\(250, 204, 21, \.35\)\)/, /color: var\(--hc-text, #fef08a\)/]],
    ['.hc-pill i', [/color: var\(--hc, #facc15\)/]],
    ['.toast.hc', [/background: var\(--hc-soft, rgba\(250, 204, 21, \.12\)\)/, /border: 1px solid var\(--hc-line, rgba\(250, 204, 21, \.35\)\)/, /color: var\(--hc-2, #fde047\)/]],
    ['.hc-big', [/rgba\(250, 204, 21, \.24\)/, /border: 1px solid var\(--hc-line, rgba\(250, 204, 21, \.35\)\)/]],
    ['.hc-big > i', [/color: var\(--hc, #facc15\)/]],
    ['.hc-big small', [/color: var\(--hc-text, #fef08a\)/]],
    ['.hc-rule .ri', [/background: var\(--hc-soft, rgba\(250, 204, 21, \.12\)\)/, /color: var\(--hc, #facc15\)/]],
    ['.hc-rule .amt', [/color: var\(--hc, #facc15\)/]],
    ['.hc-bar span', [/linear-gradient\(90deg, #f59e0b, #facc15\)/]],
  ];
  for (const [selector, patterns] of expect) {
    const body = rule(selector);
    for (const p of patterns) assert.match(body, p, selector);
  }
  // Erledigte Regeln bleiben grün
  assert.match(rule('.hc-rule.done .ri'), /color: #4ade80/);
  // Kein Blau/Lila mehr in den Honigwaben-Regeln (inklusive Hover und Puls)
  const hcRules = [...css.matchAll(/(^|\n)([^{}\n]*(?:\.hc-|\.toast\.hc|hc-pop)[^{}\n]*)\{([^}]*(?:\{[^}]*\}[^}]*)?)\}/g)].map((m) => m[2] + '{' + m[3] + '}');
  assert.ok(hcRules.length >= 15, String(hcRules.length));
  for (const r of hcRules) assert.doesNotMatch(r, /99, 102, 241|#6366f1|#818cf8|#4f46e5|#a5b4fc|#c7d2fe|--e-brand/, r);
});

test('editor.js: the code page unlock and the honeycomb window use the yellow classes', () => {
  assert.ok(js.includes(`'<span class="bdg hc"><i class="bx bx-hive"></i> Unlock with honeycombs</span>'`));
  assert.ok(js.includes(`fmtNum(st.cost) + ' <i class="bx bx-hive hc-icon"></i></b></div>'`));
  assert.ok(js.includes(`data-action="honeycombs"><i class="bx bx-hive hc-icon"></i> How to earn honeycombs</button>`));
  assert.ok(js.includes(`fmtNum(r.code_page) + ' <i class="bx bx-hive hc-icon"></i>'`));
  // Jedes Honigwaben-Symbol ist gelb: über .hc-icon, .bdg.hc, .hc-big, .hc-pill oder den Hinweis .toast.hc
  for (const m of js.matchAll(/bx-hive[^'"]*/g)) assert.ok(/hc-icon|^bx-hive$/.test(m[0]), m[0]);
  assert.ok(!js.includes('bdg brand"><i class="bx bx-hive'));
  assert.ok(!/bx-hive text-brand/.test(js));
});

test('code page terms: the honeycomb heading icon is yellow, the logo keeps the brand colour', () => {
  const page = termsCodePagesView(100);
  assert.ok(page.includes(`<i class='bx bx-hive text-yellow-400 text-2xl'></i> 5. Honeycombs`));
  assert.ok(page.includes(`<i class='bx bx-hive text-3xl text-brand-500'></i>`));
  assert.equal(page.match(/bx-hive/g)?.length, 2);
});
