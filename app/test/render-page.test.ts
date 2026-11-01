// Profilseite gegen PHP (lib/render.php): dieselbe Seite, dieselben Blöcke und Optionen gehen in oys_render_page()
// und renderPage(); die Ausgabe muss Byte für Byte gleich sein. Nur das Kontakt-Token (time()) wird nach der Prüfung
// ersetzt. Geprüft werden alle Seiten der Test-Datenbank, erzeugte Seiten mit jedem Blocktyp, jeder Option, jedem
// Design und jeder Anordnung, allen Modi, Zeitsteuerung, geschützten und ausgeblendeten Blöcken, leeren und
// feindlichen Werten – einmal direkt übergeben (wie Vorschau und Demo) und einmal über die Datenbank geladen.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, exec, q } from '../src/db.js';
import { phpJson } from '../src/html.js';
import { mbSubstr } from '../src/php.js';
import { baseHost } from '../src/helpers.js';
import { formatText, renderPage, renderSimple, type RenderOptions } from '../src/content/render.js';
import { loadBlocks, loadPage } from '../src/content/pages.js';
import { layouts, themes, fontChoices } from '../src/content/themes.js';
import { brands } from '../src/content/social.js';
import { jsonDecode } from '../src/content/util.js';
import { phpJsonFloat, phpNumber, phpRound } from '../src/content/phpValues.js';
import { jsonText, rng, O, Raw } from './modelHarness.js';
import { firstDiff, normalizeTokens, runPhpList } from './renderHarness.js';

after(() => closePool());

type R = ReturnType<typeof rng>;

// Feindliche und besondere Texte: HTML, Anführungszeichen, Emoji, RTL, sehr lang, Steuerzeichen, Entities
const TEXTS: unknown[] = ['', ' ', '0', 'Mia', 'Mia Müller', '  padded  ', '<b>bold</b> & "q" \'s', '🎧 Emoji 🐝 👨‍💻', 'עברית RTL שלום', 'العربية نص',
  '‮evil‬', 'x'.repeat(300), 'ä'.repeat(170), 'line1\nline2\r\nline3\n\n\nend', 'tab\there', '&amp; &lt; &#039; &quot;', 'a\\b', 'ends with backslash\\',
  '</script><script>alert(1)</script>', 'Mia "Sommer" & Co', ' sep ', 'nbsp x', 'combining é', 'ß straße', 'zero​width', '﻿bom',
  "it's", '{u}', '$1 \\1', 'https://example.com/path?a=1&b=2', 'See https://a.de/x_(y). and www.b.de\nnext'];
const SHORT: unknown[] = ['', '0', 'Hi', 'Tom & Jerry', '<i>x</i>', '"quoted"', "o'brien", '🎉', 'שלום', 'x'.repeat(130)];
const FLAGS: unknown[] = [true, false, 1, 0, '0', '1', '', 'yes', null];
const URLS: unknown[] = ['', 'https://example.com', 'https://www.example.com/', 'example.com/path?x=1&y="2"', 'mailto:a@b.de', 'a@b.de', 'tel:+49 170 1234567',
  '+49 170 1234567', 'javascript:alert(1)', '//evil.com', '/kalender', '/relative/path', 'https://', 'ftp://x.de', ' https://x.de/a b ',
  'https://discord.gg/abc', 'https://instagram.com/mia', 'https://youtube.com/@mia', 'https://twitch.tv/mia', 'https://open.spotify.com/artist/0',
  'HTTPS://EXAMPLE.COM/UPPER', 'münchen.de', 'https://x.de/<script>', 'https://x.de/"onmouseover="x', 'x'.repeat(1100), null, 0];
const UPLOADS: unknown[] = ['', 'thumb_5_1700000000_abcdef12.webp', 'a b+c&d.png', "o'brien.jpg", 'file_5_1.pdf', 'file_5_1.VCF', 'file_5_1.zip', 'noext',
  'dir/file.pdf', 'x.tar.gz', '.hidden', 'file.', '0', null];
const ICONS: unknown[] = ['', 'auto', 'none', 'brand:instagram', 'brand:nope', 'bx bx-music', 'bxl bxl-github', ' bx bx-heart ', 'bx bx-"x', 'fa fa-x', null];
const EMBED_URLS: unknown[] = ['', 'https://youtu.be/dQw4w9WgXcQ?t=1m30s', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/shorts/dQw4w9WgXcQ',
  'https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG', 'https://twitch.tv/somechannel', 'https://www.twitch.tv/videos/12345',
  'https://clips.twitch.tv/SomeClip-abc', 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', 'https://open.spotify.com/episode/4uLU6hMCjMI75M1A2tKUQC',
  'https://open.spotify.com/album/4uLU6hMCjMI75M1A2tKUQC', 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', 'https://vimeo.com/1', 'not a url'];
const THEME_KEYS: unknown[] = [...Object.keys(themes()), 'unknown', '', null, 'TRS'];
const LAYOUT_KEYS: unknown[] = [...Object.keys(layouts()), 'zigzag', '', null];
const BRAND_KEYS = Object.keys(brands());

// Zeitpunkte: normaler Tag, Sommerzeit-Wechsel, Mitternacht, Bruchteile
const NOWS = [1793530800, 1774746000 - 60, 1774746000 + 1, 1792890000, 1798124399.5, 1767222000, 1782000123.25, 1790000000];
const pad = (n: number): string => String(n).padStart(2, '0');
function localStamp(unix: number, offsetDays: number, hour: number, minute: number): string {
  const d = new Date((unix + offsetDays * 86400) * 1000);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t: string): string => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}T${pad(hour)}:${pad(minute)}`;
}

function schedule(r: R, now: number): unknown {
  if (r.chance(0.6)) return null;
  const pairs: Array<[string, unknown]> = [['enabled', r.pick([true, true, false, 1, '1', 0])]];
  if (r.chance(0.8)) pairs.push(['days', r.pick([[], [1, 2, 3, 4, 5], [6, 7], [1, 2, 3, 4, 5, 6, 7], ['5'], [r.next(7) + 1]])]);
  if (r.chance(0.7)) pairs.push(['from', r.pick(['', '00:00', '09:00', '12:30', '22:00', '23:59'])]);
  if (r.chance(0.7)) pairs.push(['to', r.pick(['', '02:00', '13:00', '18:00', '23:59'])]);
  if (r.chance(0.5)) pairs.push(['start', r.pick(['', localStamp(now, -2, 10, 0), localStamp(now, 3, 0, 0), localStamp(now, 0, 0, 0)])]);
  if (r.chance(0.5)) pairs.push(['end', r.pick(['', localStamp(now, -1, 0, 0), localStamp(now, 5, 12, 0)])]);
  return new O(pairs);
}

function blockData(r: R, type: string, now: number): O {
  const P: Array<[string, unknown]> = [];
  const maybe = (k: string, list: unknown[], p = 0.85): void => {
    if (r.chance(p)) P.push([k, r.pick(list)]);
  };
  switch (type) {
    case 'link':
      maybe('title', [...SHORT, ...TEXTS]);
      maybe('url', URLS, 0.95);
      maybe('subtitle', SHORT);
      maybe('icon', ICONS);
      maybe('thumb', UPLOADS, 0.5);
      maybe('featured', FLAGS, 0.5);
      break;
    case 'socials': {
      const items = Array.from({ length: r.next(5) }, () => new O([['p', r.chance(0.9) ? r.pick(BRAND_KEYS) : r.pick(['nope', 'website'])],
        ['v', r.pick(['', 'mia', '@mia', 'https://example.com/me', 'a@b.de', 'mailto:a@b.de', '+49 170 1234567', 'mia@mastodon.social', 'x y', '<b>', 'ü'])]]));
      P.push(['items', items]);
      maybe('style', ['icons', 'brand', 'pills', '"x']);
      break;
    }
    case 'heading':
      P.push(['text', r.pick(TEXTS)]);
      maybe('size', ['s', 'm', 'l', 'xl']);
      maybe('align', ['left', 'center', 'right']);
      break;
    case 'text':
      P.push(['text', r.pick([...TEXTS, 'Visit https://example.com/a?b="2" now', 'Link: http://x.de/(y)! and https://a.de/x_(y).', 'https://x.de/&amp;q;',
        'Mail me at https://example.com/a,b; ok', 'A https://x.de/ä?q=ü. end', 'HTTPS://LOUD.DE/X', 'xhttps://no.de', 'https://x.de/a<b'])]);
      maybe('align', ['left', 'center']);
      break;
    case 'divider':
      maybe('style', ['line', 'dots', 'space', 'wave', '<x>']);
      break;
    case 'image':
      P.push(['src', r.pick(UPLOADS)]);
      maybe('alt', SHORT);
      maybe('caption', SHORT);
      maybe('url', URLS);
      maybe('ratio', ['auto', 'square', 'wide', 'portrait']);
      break;
    case 'gallery': {
      const n = r.pick([0, 1, 2, 3, 5]);
      P.push(['images', Array.from({ length: n }, () => new O([['src', r.pick(UPLOADS)], ['caption', r.pick(SHORT)]]))]);
      maybe('ratio', ['square', 'portrait', 'wide']);
      maybe('autoplay', FLAGS);
      break;
    }
    case 'embed':
      P.push(['url', r.pick(EMBED_URLS)]);
      maybe('title', SHORT);
      maybe('provider', ['youtube', 'twitch', 'spotify', '']);
      break;
    case 'countdown':
      P.push(['target', r.pick(['', localStamp(now, 9, 18, 0), localStamp(now, -1, 18, 0), localStamp(now, 0, 23, 59), localStamp(now, 400, 0, 0),
        '2026-03-29T02:30', '2026-10-25T02:30', '2026-02-30T24:00', '0001-01-01T00:00', '0000-00-00T00:00', '9999-12-31T24:00', '2026-13-01T00:00',
        '2026-12-24T18:00\n', ' 2026-12-24T18:00 ', '2026-12-24t18:00'])]);
      maybe('title', SHORT);
      maybe('done_text', SHORT);
      maybe('url', URLS);
      maybe('url_label', SHORT);
      break;
    case 'contact':
      maybe('title', SHORT);
      maybe('intro', [...SHORT, 'Hello\nthere\r\nfriend']);
      maybe('button', SHORT);
      maybe('success', SHORT);
      break;
    case 'booking':
      maybe('title', SHORT);
      maybe('url', ['/kalender', '', '/kalender/', 'https://calendly.com/x', '/other', 'calendly.com/y', null, 'javascript:x']);
      break;
    case 'file':
      maybe('title', SHORT);
      P.push(['src', r.pick(UPLOADS)]);
      break;
  }
  if (r.chance(0.05)) P.push(['zzz', 'extra']);
  return new O(P);
}

const TYPES = ['link', 'link', 'link', 'socials', 'heading', 'text', 'divider', 'image', 'gallery', 'embed', 'countdown', 'contact', 'booking', 'file', 'booking', 'file'];

function block(r: R, i: number, now: number, type = r.pick(TYPES), dbIds = true): O {
  return new O([
    ['id', dbIds || r.chance(0.5) ? 100 + i : r.pick(['n' + i, 'demo' + i, 'x' + i])],
    ['type', type],
    ['is_visible', r.pick([1, 1, 1, 1, 0])],
    ['data', blockData(r, type, now)],
    ['schedule', schedule(r, now)],
    ['protection', r.chance(0.75) ? 'none' : r.pick(['password', 'age'])],
    ['effect', r.chance(0.6) ? 'none' : r.pick(['shine', 'wobble', 'pulse'])],
  ]);
}

function settings(r: R): unknown {
  if (r.chance(0.04)) return r.pick([null, '', '{', '[]', '"x"', '{"seo":"bad"}', '{"entrance":[]}']);
  const P: Array<[string, unknown]> = [];
  const maybe = (k: string, list: unknown[], p = 0.6): void => {
    if (r.chance(p)) P.push([k, r.pick(list)]);
  };
  maybe('accent', ['', '#ff00aa', '#aabbcc', '#123456"><x>', 'red']);
  maybe('font', [...Object.keys(fontChoices()), 'comic-neue', 0]);
  maybe('button', ['', 'pill', 'rounded', 'square', 'x y']);
  maybe('avatar_shape', ['circle', 'rounded', 'square', '"><b>']);
  maybe('avatar_ring', ['none', 'accent', 'rainbow', 'story', 'pulse']);
  maybe('particles', ['none', 'snow', 'confetti', 'fireflies', '', 0, null, ['a'], new O([['x', 1]]), '<&>\'"']);
  maybe('cursor_sparks', FLAGS);
  maybe('bg_overlay', [45, 0, 90, 7, 33, '50', 100, -5, 12.5, 28.5, null, true, new Raw('1.0')]);
  if (r.chance(0.7)) {
    const E: Array<[string, unknown]> = [];
    const em = (k: string, list: unknown[], p = 0.7): void => {
      if (r.chance(p)) E.push([k, r.pick(list)]);
    };
    em('enabled', [true, true, false, 1, '0']);
    em('text', [...SHORT, 'Tap to enter', 'Tap "in"']);
    em('animation', ['fade', 'zoom', 'curtain', 'blur', 'flip', '<x>']);
    em('music', ['', '', 'music_5_1700000000_abcdef12.mp3', 'a b.mp3', 5]);
    em('music_url', ['', 'https://example.com/a.mp3', 'https://youtu.be/dQw4w9WgXcQ?t=65', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG', 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', 'https://x.de/"q"&a<b>']);
    em('volume', [70, 0, 100, 33, 50, '80', 7]);
    em('loop', FLAGS);
    P.push(['entrance', new O(E)]);
  }
  if (r.chance(0.6)) {
    P.push(['seo', new O([['title', r.pick(['', '', ...SHORT, 'Custom | Title'])], ['description', r.pick(['', '', ...SHORT])], ['keywords', r.pick(['', 'a, b', '<k>', null])]])]);
  }
  maybe('custom_css', ['', 'body{color:red}', 'a{background:url(https://evil.com/x.png)}', '</style><script>alert(1)</script>', '.oys-name{font-size:2em} /* c */',
    '@import "x.css"; a{}', 'a{content:"\\3c"}'], 0.4);
  maybe('hide_branding', FLAGS);
  maybe('notify_email', FLAGS, 0.2);
  maybe('share_button', FLAGS);
  if (r.chance(0.3)) P.reverse();
  return jsonText(new O(P));
}

function page(r: R, id: unknown): O {
  const P: Array<[string, unknown]> = [];
  if (r.chance(0.95)) P.push(['id', id]);
  P.push(['user_id', 5]);
  if (r.chance(0.97)) P.push(['slug', r.pick(['mia', 'tom', 'a-b', 'x1', 'Mia', '', 'zed'])]);
  P.push(['position', 0], ['title', r.pick(TEXTS)], ['subtitle', r.pick([...SHORT, ...TEXTS])], ['bio', r.pick([...TEXTS, null])]);
  P.push(['avatar', r.pick(['', null, null, 'avatar_5_1700000000_abcdef12.webp', 'a b+c&d.png', '0', "x'y.png"])]);
  P.push(['bg_image', r.pick(['', null, null, 'bg_5_1_x.webp', "o'brien.png"])]);
  P.push(['theme', r.pick(THEME_KEYS)], ['layout', r.pick(LAYOUT_KEYS)], ['address_mode', r.pick(['subdomain', 'subdomain', 'path', 'PATH'])]);
  P.push(['settings', settings(r)], ['views', 5]);
  return new O(P);
}

function options(r: R, now: number): RenderOptions {
  const o: Record<string, unknown> = { now };
  const mode = r.pick(['public', 'public', 'public', 'preview', 'preview', 'demo', undefined, 'simple']);
  if (mode !== undefined) o.mode = mode;
  const entrance = r.pick([undefined, undefined, 'auto', 'show', 'skip']);
  if (entrance !== undefined) o.entrance = entrance;
  const host = r.pick([undefined, '', 'mia.' + baseHost(), baseHost(), '0', 'other.example']);
  if (host !== undefined) o.host = host;
  const notice = r.pick([undefined, null, 'sent:100', 'sent:101', 'sent:n1', 'sent:x']);
  if (notice !== undefined) o.notice = notice;
  return o as RenderOptions;
}

// Fälle mit allen Werten jeder Liste wenigstens einmal (deterministisch) plus Zufall
function cases(seed: number, n: number): unknown[] {
  const r = rng(seed);
  const out: unknown[] = [];
  // Jedes Design und jede Anordnung, jeder Blocktyp, jeder Modus
  for (const [i, theme] of THEME_KEYS.entries()) {
    const now = NOWS[i % NOWS.length];
    const p = page(r, 7);
    p.pairs = p.pairs.map(([k, v]) => (k === 'theme' ? [k, theme] : k === 'layout' ? [k, LAYOUT_KEYS[i % LAYOUT_KEYS.length]] : [k, v]));
    const types = ['link', 'socials', 'heading', 'text', 'divider', 'image', 'gallery', 'embed', 'countdown', 'contact', 'booking', 'file'];
    out.push({ page: p, blocks: types.map((t, j) => block(r, j, now, t, i % 2 === 0)), opts: { ...options(r, now), mode: ['public', 'preview', 'demo'][i % 3] } });
  }
  for (let i = 0; i < n; i++) {
    const now = r.pick(NOWS);
    const count = r.pick([0, 1, 3, 6, 10, 16]);
    out.push({ page: page(r, r.pick([7, 12, '9', 0, null, '0'])), blocks: Array.from({ length: count }, (_x, j) => block(r, j, now, r.pick(TYPES), r.chance(0.6))), opts: options(r, now) });
  }
  return out;
}

// Ein Fehler mitten in der Vorlage lässt den Ausgabepuffer von oys_render_page() offen – wegräumen
const PHP_RENDER_EACH = `
  $level = ob_get_level();
  foreach ($in as $c) {
    try { $out[] = oys_render_page($c['page'], $c['blocks'], test_opts($c['opts'])); }
    catch (Throwable $e) { while (ob_get_level() > $level) ob_end_clean(); $out[] = 'THROW'; }
  }`;

function compare(list: unknown[], decoded: Array<{ page: Record<string, unknown> }>, php: string[], node: string[]): string[] {
  const problems: string[] = [];
  list.forEach((c, i) => {
    const pageId = decoded[i].page.id;
    const a = normalizeTokens(php[i], pageId);
    const b = normalizeTokens(node[i], pageId);
    if (a !== b && problems.length < 5) problems.push(`case ${i}: ${firstDiff(a, b)}\n  input: ${JSON.stringify(c).slice(0, 1500)}`);
  });
  return problems;
}

test('pages passed directly (preview, demo, generated) render byte for byte like PHP', () => {
  const list = cases(Number(process.env.RENDER_SEED ?? 4242), Number(process.env.RENDER_CASES ?? 1400));
  const text = jsonText(list);
  const php = runPhpList(PHP_RENDER_EACH, text);
  const decoded = jsonDecode(text) as Array<{ page: Record<string, unknown>; blocks: object[]; opts: RenderOptions }>;
  const node = decoded.map((c) => {
    try {
      return renderPage(c.page, c.blocks, c.opts);
    } catch {
      return 'THROW';
    }
  });
  assert.equal(php.length, list.length);
  assert.deepEqual(compare(list, decoded, php, node), []);
  // Die Fälle decken auch Fehler ab, aber nicht nur
  assert.ok(php.filter((x) => x !== 'THROW').length > list.length * 0.9, 'most pages render');
  assert.ok(php.some((x) => x.includes('oys-contact-status ok')), 'a sent notice is shown');
  assert.ok(php.some((x) => x.includes('oys-off-badge')), 'scheduled blocks are marked in the preview');
  assert.ok(php.some((x) => x.includes('data-protect="age"')) && php.some((x) => x.includes('data-protect="password"')), 'protected links');
  assert.ok(php.some((x) => x.includes('<audio id="oys-audio"')) && php.some((x) => x.includes('<div class="oys-yt"')), 'entrance music (file and YouTube)');
  assert.ok(php.some((x) => x.includes('oys-cd-num')) && php.some((x) => x.includes('is-invalid')), 'countdowns and invalid embeds');
  // Jede Variante kommt in den verglichenen Seiten vor
  const marks = ['oys-links lay-', 'oys-entrance anim-', 'oys-yt', 'oys-audio', 'oys-share-tpl', 'og:image:width', 'boxicons', 'oys-custom-css', '--bg-overlay', 'oys-off-badge',
    'oys-empty', 'is-done', 'oys-gal-dots', 'data-autoplay', 'provider-youtube', 'provider-twitch', 'provider-spotify', 'style-pills', 'size-l', 'oys-divider', 'oys-image ratio-',
    '<figcaption>', 'type-file', 'type-booking', ' download>', 'is-protected', 'fx-shine', 'is-featured', 'has-thumb', 'no-icon', 'is-empty', 'mode-demo', 'mode-preview',
    'mode-public', 'noindex', 'rel="canonical"', 'twitter:image', 'f-', 'btn-', 'has-bgimg', 'oys-bio', 'oys-sub', 'oys-name', 'oys-foot', 'oys-badge18', 'oys-cd-link',
    'oys-contact-intro', 'nofollow', 'class="oys-mute"', 'data-protect'];
  assert.deepEqual(marks.filter((m) => !php.some((x) => x.includes(m))), []);
});

test('every page in the test database renders like PHP, also after loading generated pages from the database', async () => {
  const r = rng(777);
  const inserted: number[] = [];
  try {
    // Erzeugte Seiten mit Blöcken als echte Zeilen (JSON-Text wie oys_save_page bzw. alte Daten ihn schreiben)
    for (let i = 0; i < 60; i++) {
      const now = NOWS[i % NOWS.length];
      const p = jsonDecode(jsonText(page(r, 0))) as Record<string, unknown>;
      const res = await exec('INSERT INTO pages (user_id, slug, position, title, subtitle, bio, avatar, bg_image, theme, layout, address_mode, settings) VALUES (5, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['gen' + i + 'x' + Date.now().toString(36), mbSubstr(String(p.title ?? ''), 0, 120), mbSubstr(String(p.subtitle ?? ''), 0, 160), p.bio as string | null, p.avatar as string | null, p.bg_image as string | null,
          String(p.theme ?? 'deep-dark'), String(p.layout ?? 'buttons'), String(p.address_mode ?? 'subdomain'), p.settings as string | null]);
      inserted.push(res.insertId);
      const n = r.pick([0, 2, 5, 9]);
      for (let j = 0; j < n; j++) {
        const b = jsonDecode(jsonText(block(r, j, now))) as Record<string, unknown>;
        const data = r.chance(0.05) ? r.pick(['{', 'null', '"x"', '[]']) : jsonText(b.data);
        const sched = b.schedule === null ? null : r.chance(0.05) ? '{' : jsonText(b.schedule);
        await exec('INSERT INTO page_blocks (page_id, type, position, is_visible, data, schedule, protection, password_hash, effect) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [res.insertId, b.type as string, j, Number(b.is_visible) ? 1 : 0, data as string, sched as string | null, b.protection as string,
            b.protection === 'password' ? '$2y$10$abcdefghijklmnopqrstuuJ8vGdWw8T7uZ8eB0Pq3lJ2cXnDZq9yW' : null, b.effect as string]);
      }
    }
    const ids = (await q('SELECT id FROM pages ORDER BY id')).map((row) => Number(row.id));
    const list: unknown[] = [];
    for (const [i, id] of ids.entries()) {
      for (const mode of ['public', 'preview', 'demo']) {
        list.push({ id, opts: { now: NOWS[(i + mode.length) % NOWS.length], mode, host: i % 2 ? 'mia.' + baseHost() : baseHost(), notice: i % 3 ? null : 'sent:' + (i + 3), entrance: mode === 'preview' && i % 2 ? 'show' : undefined } });
      }
    }
    const text = jsonText(list);
    const php = runPhpList(`
      $level = ob_get_level();
      foreach ($in as $c) {
        try { $out[] = oys_render_page(oys_load_page($pdo, $c['id']), oys_load_blocks($pdo, $c['id']), test_opts($c['opts'])); }
        catch (Throwable $e) { while (ob_get_level() > $level) ob_end_clean(); $out[] = 'THROW'; }
      }`, text, { db: true });
    const node: string[] = [];
    for (const c of jsonDecode(text) as Array<{ id: number; opts: RenderOptions }>) {
      try {
        node.push(renderPage((await loadPage(c.id))!, await loadBlocks(c.id), c.opts));
      } catch {
        node.push('THROW');
      }
    }
    const problems: string[] = [];
    list.forEach((c, i) => {
      const id = (c as { id: number }).id;
      const a = normalizeTokens(php[i], id);
      const b = normalizeTokens(node[i], id);
      if (a !== b && problems.length < 5) problems.push(`page ${id} ${JSON.stringify((c as { opts: unknown }).opts)}: ${firstDiff(a, b)}`);
    });
    assert.deepEqual(problems, []);
    assert.ok(ids.length >= 64 && php.filter((x) => x !== 'THROW').length > list.length * 0.9);
  } finally {
    if (inserted.length) {
      await exec(`DELETE FROM page_blocks WHERE page_id IN (${inserted.join(',')})`);
      await exec(`DELETE FROM pages WHERE id IN (${inserted.join(',')})`);
    }
  }
});

test('oys_render_simple and oys_format_text match PHP', () => {
  const r = rng(99);
  const simple: unknown[] = [];
  for (let i = 0; i < 150; i++) simple.push({ page: page(r, 7), title: r.pick(SHORT), body: r.pick(['', '<p>x</p>', '<div class="oys-card">ü</div>']) });
  const text = jsonText(simple);
  const php = runPhpList(`foreach ($in as $c) { try { $out[] = oys_render_simple($c['page'], (string) $c['title'], $c['body']); } catch (Throwable $e) { $out[] = 'THROW'; } }`, text);
  const node = (jsonDecode(text) as Array<{ page: object; title: unknown; body: string }>).map((c) => {
    try {
      return renderSimple(c.page, String(c.title ?? ''), c.body);
    } catch {
      return 'THROW';
    }
  });
  assert.deepEqual(node.map((x, i) => (x === php[i] ? '' : firstDiff(php[i], x))).filter(Boolean).slice(0, 3), []);

  // Klickbare Adressen: auch mit Entities, Klammern, Satzzeichen, Großbuchstaben, Umlauten und Zufallstext
  const texts: string[] = TEXTS.map(String);
  const parts = ['https://', 'http://', 'HTTP://', 'www.', 'x.de', '/a', '?b=', '"', "'", '&', '<', '>', ';', '.', ',', ')', ']', '(', ' ', '\n', '\t', '\f', '\v', 'ä', '🎧', ':', '!', '?', '#'];
  for (let i = 0; i < 3000; i++) texts.push(Array.from({ length: 1 + r.next(12) }, () => r.pick(parts)).join(''));
  const t2 = jsonText(texts);
  const phpText = runPhpList('foreach ($in as $t) { $out[] = oys_format_text($t); }', t2);
  const nodeText = (jsonDecode(t2) as string[]).map((t) => formatText(t));
  const bad = nodeText.map((x, i) => (x === phpText[i] ? null : { input: texts[i], php: phpText[i], node: x })).filter(Boolean);
  assert.deepEqual(bad.slice(0, 3), []);
  assert.ok(phpText.filter((x) => x.includes('<a href=')).length > 500, 'many links');
});

test('the config JSON escapes like json_encode with JSON_HEX_* (also a backslash at the end of a text)', () => {
  const vals = ['a\\', 'x"y', 'a\\"b', '\\\\', '</script>', "it's & co", 'é🎧', ' ', '\u007f', 'a/b'];
  const php = runPhpList('foreach ($in as $v) { $out[] = json_encode(["t" => $v], JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_UNESCAPED_SLASHES); }', jsonText(vals));
  assert.deepEqual(vals.map((v) => phpJson({ t: v }, { hexTag: true, hexAmp: true, hexApos: true, hexQuot: true, unescapedSlashes: true })), php);
});

test('unusual stored values behave like PHP, including the cases where PHP stops with an error', () => {
  const base = { id: 7, slug: 'mia', title: 'Mia', subtitle: '', bio: '', avatar: '', bg_image: 'bg.webp', theme: 'galaxy', layout: 'cards', address_mode: 'subdomain' };
  const blk = (type: string, data: unknown, extra: Record<string, unknown> = {}): unknown => ({ id: 5, type, is_visible: 1, data, schedule: null, protection: 'none', effect: 'none', ...extra });
  const pages: unknown[] = [
    { ...base, settings: '{"entrance":{"enabled":true,"music":"","music_url":null}}' },
    { ...base, settings: '{"entrance":{"enabled":true,"music":"","music_url":5}}' },
    { ...base, settings: '{"entrance":{"enabled":true,"music":["x"]}}' },
    { ...base, settings: '{"entrance":{"enabled":true,"music":true}}' },
    { ...base, settings: '{"entrance":{"volume":"abc"}}' },
    { ...base, settings: '{"entrance":{"volume":"12abc"}}' },
    { ...base, settings: '{"entrance":{"volume":null}}' },
    { ...base, settings: '{"entrance":{"volume":""}}' },
    { ...base, settings: '{"bg_overlay":[]}' },
    { ...base, settings: '{"bg_overlay":"1e1"}' },
    { ...base, settings: '{"bg_overlay":" 33 "}' },
    { ...base, settings: '{"bg_overlay":28.5}' },
    { ...base, settings: '{"seo":{"title":["a"],"description":{"x":1},"keywords":5}}' },
    { ...base, settings: '{"font":["a"],"button":{"b":1},"accent":7}' },
    { ...base, settings: '{"entrance":{"enabled":true,"music_url":"https://youtube.com/watch?v[]=x"}}' },
    { ...base, settings: '{"particles":1e21}' },
    { id: '12', slug: 7, title: 5, subtitle: 0.5, bio: 0, avatar: 0, theme: 3, layout: false, address_mode: true, settings: 5 },
    {},
  ];
  const blocks: unknown[][] = [
    [blk('socials', { items: [{ v: 'x' }] })],
    [blk('socials', { items: ['str'] })],
    [blk('socials', { items: [5, null] })],
    [blk('socials', { items: 'str' })],
    [blk('socials', { items: [{ p: 5, v: 'https://x.de' }, { p: 'instagram', v: ['a'] }, { p: 'nope', v: 'https://y.de' }] })],
    [blk('image', { src: ['x'] })],
    [blk('image', { src: 5, alt: ['a'], caption: 7, url: ['u'] })],
    [blk('gallery', { images: 'str' })],
    [blk('gallery', { images: { a: { src: 'a.webp' }, b: { src: 'b.webp' } } })],
    [blk('gallery', { images: { 5: { src: 'a.webp' }, 2: { src: 'b.webp' } } })],
    [blk('gallery', { images: { '05': { src: 'a.webp' }, '0.5': { src: 'b.webp' }, ' 1': { src: 'c.webp' } } })],
    [blk('gallery', { images: ['str', 5, null] })],
    [blk('gallery', { images: [5, null] })],
    [blk('text', { text: ['a'] })],
    [blk('heading', { text: 5, size: ['l'] })],
    [blk('embed', { url: ['x'] })],
    [blk('embed', { url: ['x'] })],
    [blk('countdown', { target: ['x'] })],
    [blk('countdown', { target: ' 2026-12-24T18:00', title: ['t'], done_text: 5, url: ['u'] })],
    [blk('link', { url: ['x'], title: ['t'], icon: ['i'], subtitle: ['s'] })],
    [blk('link', { url: 'https://x.de', title: 5 }, { schedule: 'yes' })],
    [blk('booking', { url: ['x'], title: 0 }), blk('file', { src: ['x'], title: '0' })],
    [blk('file', { src: 5 }), blk('booking', { url: 7 })],
    [blk('contact', { title: ['x'], intro: 5, button: 0, success: ['s'] })],
    [{ id: null, type: 'link', is_visible: 1, data: 'str', schedule: null }],
    [{ type: 'divider', is_visible: 1 }],
    [blk('unknown-type', {}), blk('link', { url: 'https://x.de' }, { protection: null, effect: null })],
    [null, 'str', 5, [], blk('heading', { text: 'still here' })],
  ];
  const list: unknown[] = [];
  for (const [i, p] of pages.entries()) list.push({ page: p, blocks: blocks[i % blocks.length], opts: { now: 1793530800, mode: i % 2 ? 'public' : 'preview', entrance: 'show' } });
  for (const [i, b] of blocks.entries()) list.push({ page: base, blocks: b, opts: { now: 1793530800, mode: i % 2 ? 'preview' : 'public', entrance: 'show' } });
  const text = jsonText(list);
  const php = runPhpList(PHP_RENDER_EACH, text);
  const decoded = jsonDecode(text) as Array<{ page: Record<string, unknown>; blocks: object[]; opts: RenderOptions }>;
  const node = decoded.map((c) => {
    try {
      return renderPage(c.page, c.blocks, c.opts);
    } catch {
      return 'THROW';
    }
  });
  assert.deepEqual(compare(list, decoded, php, node), []);
  // Beides kommt vor: PHP bricht ab (500) – Node auch –, und PHP gibt Warnungen aus, rendert aber weiter
  assert.ok(php.filter((x) => x === 'THROW').length >= 10, 'PHP errors are covered');
  assert.ok(php.filter((x) => x !== 'THROW').length >= 15, 'PHP warnings are covered');
});

test('round() and number casts used by the page match PHP', () => {
  const r = rng(31);
  const values: number[] = [0, 0.5, 1.5, 2.5, -0.5, -2.5, 0.285, 1.005, 2.675, 0.045, 1.16 * 72, 0.92 * 52, 28.499999999999996, 1e15 + 0.5, 1e-9, 123456.785];
  for (let i = 0; i < 4000; i++) values.push((r.next(2000000) - 1000000) / [1, 10, 100, 1000, 7, 3][r.next(6)]);
  for (let a = 0; a < 256; a += 5) for (const t of [0.55, 0.75, 0.35]) values.push(a + (255 - a) * t, a * (1 - t));
  const cases = values.flatMap((v) => [[v, 0], [v, 2]]);
  const expected = runPhpList('foreach ($in as [$v, $p]) { $out[] = json_encode(round((float) $v, $p)); }', jsonText(cases));
  assert.deepEqual(cases.map(([v, p]) => JSON.stringify(phpRound(v, p))).map((x, i) => (x === expected[i] ? '' : `${JSON.stringify(cases[i])}: php ${expected[i]} node ${x}`)).filter(Boolean).slice(0, 5), []);

  // $x / 100 mit Text, null und Wahrheitswerten (Fehler wie PHP 8)
  const operands: unknown[] = ['45', ' 12 ', '12abc', '1e3', '.5', '5.', '0x1A', '-0', null, true, false, 7, 2.5, 'abc', '', ' ', [], ['1']];
  const php = runPhpList('foreach ($in as $v) { try { $out[] = json_encode($v / 100); } catch (Throwable $e) { $out[] = "THROW"; } }', jsonText(operands));
  assert.deepEqual(operands.map((v) => {
    try {
      return JSON.stringify(phpNumber(v) / 100);
    } catch {
      return 'THROW';
    }
  }), php);
});

// Gespeicherte Einstellungen mit Kommazahlen (alte oder von Hand geänderte Daten): round() und (string) behalten -0,
// json_encode() schreibt Exponenten wie PHP (1.0e-5, 1.0e+21) und scheitert an INF – dann bleibt die Konfiguration leer
test('floats in stored settings are written like PHP: -0, json_encode exponents and INF', () => {
  const base = { id: 7, slug: 'mia', title: 'Mia', subtitle: '', bio: '', avatar: '', bg_image: 'bg.webp', theme: 'galaxy', layout: 'cards', address_mode: 'subdomain' };
  const list: unknown[] = [];
  const add = (settings: string): void => {
    list.push({ page: { ...base, settings }, blocks: [], opts: { now: 1793530800, mode: 'public', entrance: 'show' } });
  };
  for (const v of ['-0.4', '-0.0', '-0', '0.0', '-0.3', '-1', '45.0', '1e2', '-1e-9', '0.004', '0.005', '-0.005', '1e-7', '1e300', '"-0"', '"-0.0"', '" -0 "',
    '"-0abc"', '"-0.3"', '"-.3"', '"-0e5"', '"+0"', '1e16', '12345678901234600', '-1e16', '9.99e15', '1e21']) {
    add('{"bg_overlay":' + v + '}');
  }
  for (const v of ['100.0', '70', '70.0', '1e999', '-1e999', '-0.0', '0.0', '"1e999"', '1e-5', '0.1', '7', '1e300', '-1e300', '"-0"', '"-0.0"', '1e19', '0.001',
    '12345678901234567890', '-0', '"7"', '" 33 "']) {
    add('{"entrance":{"enabled":true,"volume":' + v + '}}');
  }
  for (const v of ['1.0', '-0.0', '1e-5', '0.1', '1e21', '1.5e300', '12345678901234567890', '[1.0,-0.0,1e-7]', '{"a":-0.0,"5":1e-5}', '1e999', '[1e999]',
    '{"x":[0.5,{"y":-1e-300}]}', '0.0001', '0.00001', '123456.789e3', '-9.999999999999999e-5', '1e16', '99999999999999999999.5']) {
    add('{"particles":' + v + '}');
  }
  const text = jsonText(list);
  const php = runPhpList(PHP_RENDER_EACH, text);
  const decoded = jsonDecode(text) as Array<{ page: Record<string, unknown>; blocks: object[]; opts: RenderOptions }>;
  const node = decoded.map((c) => {
    try {
      return renderPage(c.page, c.blocks, c.opts);
    } catch {
      return 'THROW';
    }
  });
  assert.deepEqual(compare(list, decoded, php, node), []);
  assert.ok(php.some((x) => x.includes('--bg-overlay:-0"')), 'round() keeps -0');
  assert.ok(php.some((x) => x.includes('"volume":-0,')) && php.some((x) => x.includes('"particles":1.0e-5')), 'json_encode floats');
  assert.ok(php.some((x) => x.includes('<script id="oys-config" type="application/json"></script>')), 'json_encode fails on INF');
});

test('json_encode() of a float matches phpJsonFloat for random and boundary values', () => {
  const r = rng(17);
  const values: number[] = [0, -0, 1, -1, 0.1, 0.5, 1.5, 1e-4, 9.999e-5, 1e-5, 1.5e-7, 5e-324, -5e-324, 2.2250738585072014e-308, 1.7976931348623157e308, 1e15, 1e16, 1e17,
    9.999999999999999e16, 1.0000000000000002e17, 2 ** 53, 2 ** 63, 2 ** 64, 123456789.123, 0.30000000000000004, 1 / 3, -2 / 3, 1e21, 1e22, 1e-300];
  const buf = Buffer.alloc(8);
  for (let i = 0; i < 3000; i++) {
    // Zufällige Bitmuster (alle Größenordnungen) und Zahlen mit wenigen Stellen
    buf.writeUInt32LE(r.next(2 ** 32), 0);
    buf.writeUInt32LE(r.next(2 ** 32), 4);
    const bits = buf.readDoubleLE(0);
    if (Number.isFinite(bits)) values.push(bits);
    values.push((r.next(2000001) - 1000000) * 10 ** (r.next(50) - 25));
  }
  // Exakter Wert für PHP: kürzeste Darstellung (rundet beim Einlesen genau zurück), -0 als -0.0
  const php = runPhpList('foreach ($in as $v) { $out[] = json_encode((float) $v); }', '[' + values.map((v) => (Object.is(v, -0) ? '-0.0' : JSON.stringify(v))).join(',') + ']');
  const bad = values.map((v, i) => (phpJsonFloat(v) === php[i] ? '' : `${v}: php ${php[i]} node ${phpJsonFloat(v)}`)).filter(Boolean);
  assert.deepEqual(bad.slice(0, 5), []);
});

// Countdown-Ziele in jeder Form, die oys_block_normalize speichern kann (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}, auch mit "\n"
// dahinter): übergelaufene Monate, Tage und Stunden, Jahr 0, Zeiten vor 1893 (Ortszeit), Lücke und doppelte Stunde
// der Zeitumstellung – Datum im data-target, verbleibende Zeit und leere Blöcke wie PHP
test('countdown targets in every stored form give the same date and remaining time as PHP', () => {
  const r = rng(2024);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  const range = (a: number, b: number): string[] => Array.from({ length: b - a + 1 }, (_x, i) => p2(a + i));
  const years = ['0000', '0001', '0099', '0999', '1582', '1847', '1892', '1893', '1916', '1945', '1947', '1970', '1980', '2000', '2026', '2027', '2038', '2100', '9999'];
  const targets: string[] = [];
  for (let i = 0; i < 1500; i++) {
    targets.push(`${r.pick(years)}-${r.pick([...range(0, 13), '19', '99'])}-${r.pick([...range(0, 32), '39', '99'])}T${r.pick([...range(0, 25), '29', '99'])}:${r.pick([...range(0, 61), '99'])}` + (r.chance(0.1) ? '\n' : ''));
  }
  for (const day of ['2026-03-29', '2026-10-25', '1980-04-06', '1945-05-24', '1947-06-29', '2038-03-28']) {
    for (const h of ['01', '02', '03']) for (const m of ['00', '30', '59']) targets.push(`${day}T${h}:${m}`);
  }
  const page = { id: 7, slug: 'mia', title: 'Mia', subtitle: '', bio: '', avatar: '', bg_image: '', theme: 'galaxy', layout: 'cards', address_mode: 'subdomain', settings: '{"share_button":false}' };
  const list = targets.map((t, i) => ({
    page,
    blocks: [{ id: 5, type: 'countdown', is_visible: 1, data: { title: 'T', target: t, done_text: '', url: '', url_label: '' }, schedule: null, protection: 'none', effect: 'none' }],
    opts: { now: NOWS[i % NOWS.length], mode: 'public' },
  }));
  const text = jsonText(list);
  const php = runPhpList(PHP_RENDER_EACH, text);
  const decoded = jsonDecode(text) as Array<{ page: Record<string, unknown>; blocks: object[]; opts: RenderOptions }>;
  const node = decoded.map((c) => renderPage(c.page, c.blocks, c.opts));
  assert.deepEqual(compare(list, decoded, php, node), []);
  const shown = php.filter((x) => x.includes('oys-countdown')).length;
  assert.ok(shown > 300 && shown < targets.length - 300, 'readable and unreadable targets');
});
