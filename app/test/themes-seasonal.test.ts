// Designs für Winter und Weihnachten (Gruppe „seasonal“, seit 3.3): Daten, CSS mit allen Farben, lesbare Kontraste,
// Demo-Seite und Mini-Vorschau. PHP kannte sie nicht – die Vergleiche mit PHP lassen sie aus (support/phpThemes.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_DIR } from '../src/config.js';
import { fontChoices, themeKey, themes } from '../src/content/themes.js';
import { demoPage, miniHtml } from '../src/content/demo.js';
import { renderPage } from '../src/content/render.js';
import { baseHost } from '../src/helpers.js';
import { seasonalThemeKeys } from './support/phpThemes.js';

const CSS = readFileSync(join(ROOT_DIR, 'static', 'css', 'themes.css'), 'utf8');
const WINTER = ['snowy-night', 'candy-cane', 'gingerbread', 'christmas-market', 'frost'];

// Variablen des Blocks .t-<key> { … }
function vars(key: string): Record<string, string> {
  const m = new RegExp('\\n\\.t-' + key + ' \\{\\n([\\s\\S]*?)\\n\\}').exec(CSS);
  assert.ok(m, `CSS block for .t-${key}`);
  return Object.fromEntries([...m[1].matchAll(/^\s*(--[a-z-]+):\s*(.+?);\s*$/gm)].map((v) => [v[1], v[2]]));
}

type Rgb = [number, number, number];
function hex(c: string): Rgb {
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  assert.ok(m, `a #rgb or #rrggbb colour: ${c}`);
  const h = m[1].length === 3 ? m[1].split('').map((x) => x + x).join('') : m[1];
  m = null;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
}
// #rrggbb oder rgba(r, g, b, a) – halbdurchsichtig über dem Hintergrund
function color(c: string, over: Rgb): Rgb {
  const m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(c.trim());
  if (!m) return hex(c);
  const a = Number(m[4]);
  return [1, 2, 3].map((i, j) => Number(m[i]) * a + over[j] * (1 - a)) as Rgb;
}
function lum([r, g, b]: Rgb): number {
  const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
const contrast = (a: Rgb, b: Rgb): number => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('five winter and Christmas themes in their own group, with a known font and a matching accent', () => {
  assert.deepEqual(seasonalThemeKeys(), WINTER);
  for (const k of WINTER) {
    const t = themes()[k];
    assert.equal(t.group, 'seasonal', k);
    assert.equal(themeKey(k), k);
    // Eine Schrift, die es schon gibt (Auswahl im Feinschliff oder eines der bisherigen Designs)
    const known = new Set([...Object.keys(fontChoices()), ...Object.values(themes()).filter((x) => x.group !== 'seasonal').map((x) => x.font)]);
    assert.ok(known.has(t.font), `${k}: font ${t.font}`);
    assert.ok(t.name && t.desc.length <= 60, k);
    assert.equal(vars(k)['--accent'].toLowerCase(), t.accent.toLowerCase(), `${k}: accent in themes.ts and themes.css`);
    // dark = heller Text auf dunklem Grund
    assert.equal(lum(hex(vars(k)['--bg-solid'])) < 0.18, t.dark, `${k}: dark`);
  }
});

test('winter themes set every colour and stay readable (text, muted text, buttons, accent)', () => {
  const need = ['--bg', '--bg-solid', '--text', '--muted', '--accent', '--on-accent', '--btn-bg', '--btn-border', '--btn-hover-bg', '--icon-bg', '--icon-fg', '--surface',
    '--card-bg', '--card-border', '--input-bg', '--divider', '--overlay-rgb'];
  for (const k of WINTER) {
    const v = vars(k);
    for (const n of need) assert.ok(v[n], `${k}: ${n}`);
    const bg = hex(v['--bg-solid']);
    assert.ok(contrast(hex(v['--text']), bg) >= 7, `${k}: text ${contrast(hex(v['--text']), bg).toFixed(2)}`);
    assert.ok(contrast(color(v['--muted'], bg), bg) >= 4.5, `${k}: muted ${contrast(color(v['--muted'], bg), bg).toFixed(2)}`);
    assert.ok(contrast(hex(v['--on-accent']), hex(v['--accent'])) >= 4.5, `${k}: on accent`);
    const btnBg = color(v['--btn-bg'], bg);
    const btnText = v['--btn-text'] ? hex(v['--btn-text']) : hex(v['--text']);
    assert.ok(contrast(btnText, btnBg) >= 4.5, `${k}: button ${contrast(btnText, btnBg).toFixed(2)}`);
    // Initialen im Profilbild und Zahlen im Countdown: Akzentfarbe auf --avatar-bg bzw. --icon-bg
    const iconBg = color(v['--icon-bg'], bg);
    const avatarBg = v['--avatar-bg'] ? color(v['--avatar-bg'], bg) : iconBg;
    assert.ok(contrast(hex(v['--accent']), iconBg) >= 3, `${k}: countdown numbers ${contrast(hex(v['--accent']), iconBg).toFixed(2)}`);
    assert.ok(contrast(hex(v['--accent']), avatarBg) >= 3, `${k}: initials ${contrast(hex(v['--accent']), avatarBg).toFixed(2)}`);
    assert.ok(contrast(color(v['--icon-fg'], iconBg), iconBg) >= 3, `${k}: icons`);
    // Eingaben (Kontaktformular, Passwort, Dialoge): --input-text (sonst --text) auf --input-bg
    const inputBg = color(v['--input-bg'], bg);
    const inputText = hex(v['--input-text'] ?? v['--text']);
    assert.ok(contrast(inputText, inputBg) >= 4.5, `${k}: input text ${contrast(inputText, inputBg).toFixed(2)}`);
    // overlay-rgb ist --bg-solid als „r, g, b“
    assert.deepEqual(v['--overlay-rgb'].split(',').map((x) => Number(x.trim())), bg, `${k}: overlay-rgb`);
  }
});

test('every winter theme has its demo page and its mini preview', () => {
  const now = Math.floor(Date.now() / 1000);
  for (const k of WINTER) {
    const demo = demoPage(k, now);
    assert.ok(demo, k);
    assert.equal(demo.page.theme, k);
    const html = renderPage(demo.page, demo.blocks, { mode: 'demo', entrance: 'skip', host: baseHost(), now });
    assert.match(html, new RegExp('<body class="oys t-' + k + ' '), k);
    assert.match(miniHtml(k), new RegExp('t-' + k), k);
  }
});

test('winter animations have their own names (page.css is loaded after themes.css and would win)', () => {
  const page = readFileSync(join(ROOT_DIR, 'static', 'css', 'page.css'), 'utf8');
  const names = (css: string) => [...css.matchAll(/@keyframes ([a-z0-9-]+)/g)].map((m) => m[1]);
  const theirs = new Set(names(page));
  const all = names(CSS);
  assert.deepEqual(all.filter((n) => theirs.has(n)), [], 'no keyframes in themes.css share a name with page.css');
  assert.equal(new Set(all).size, all.length, 'no keyframes are defined twice in themes.css');
});
