// Seiten gegen PHP (lib/pages.php, lib/share.php): Einstellungen prüfen und lesen, Blöcke und Seiten für den Editor
// (mit den Zeilen der Test-Datenbank und erfundenen Zeilen), verwendete Dateien, Kennung und Adresse des Vorschaubilds
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { q, closePool } from '../src/db.js';
import { fontChoices, themes, layouts } from '../src/content/themes.js';
import {
  defaultSettings, pageSettings, settingsNormalize, loadBlocks, blockFromRow, blockForEditor, pageForEditor, pageFiles, userPages, type Block,
} from '../src/content/pages.js';
import { ogHash, ogUrl } from '../src/content/share.js';
import { jsonDecode, type PhpArr } from '../src/content/util.js';
import { runPhp, PHP_EACH, nodeEach, diffs, jsonText, rng, O, Raw, enc, jsFloats } from './modelHarness.js';

after(() => closePool());

type R = ReturnType<typeof rng>;

const TEXTS = ['', ' ', '0', 'Mia', '  Tom Weber  ', 'x'.repeat(400), 'ä'.repeat(130), '🐝 Bee', 'a\tb\nc\r\nd', '‮evil', '<b>"\'&', 'line\n\n\n\nbreak', ' nbsp'];
const NUMBERS: unknown[] = [0, 1, -1, 45, 70, 89, 90, 91, 99, 100, 101, -5, 1.5, 99.9, new Raw('1e20'), new Raw('-1e19'), new Raw('1e19'), new Raw('-0'), new Raw('1.0'),
  '12abc', ' 30', '1e3', '0x1A', '-5.9', '', 'abc', '99999999999999999999', '1e400', null, true, false, [], [5]];
const FLAGS_IN: unknown[] = [true, false, 1, 0, '0', '1', '', 'yes', null, [], [0], {}, new Raw('0.0'), ' '];
const UPLOADS = ['music_5_1700000000_abcdef12.mp3', 'music_5_1.m4a', 'music_5_1.ogg', 'music_5_1.wav', 'music_5_1.flac', 'music_6_1.mp3', '../music_5_1.mp3',
  'avatar_5_1700000000_abcdef12.png', 'bg_5_1.jpg', 'img_5_1.webp', 'file_5_1.pdf', '', '0', 'x'];

function anyValue(r: R, depth = 0): unknown {
  const k = r.next(10);
  if (k < 4) return r.pick(TEXTS);
  if (k < 6) return r.pick(NUMBERS);
  if (k < 7) return r.pick(FLAGS_IN);
  if (k < 8) return r.pick(UPLOADS);
  if (depth > 1) return null;
  if (k < 9) return Array.from({ length: r.next(3) }, () => anyValue(r, depth + 1));
  return new O(Array.from({ length: r.next(3) }, () => [r.pick(['a', '0', '5', 'music', 'title', '__proto__']), anyValue(r, depth + 1)]));
}

const CHOICE: Record<string, unknown[]> = {
  accent: ['#AABBCC', '#aabbcc', '#abc', '#aabbcc\n', 'aabbcc', '#GGGGGG', '#AaBbCc', ' #aabbcc', '#aabbccdd'],
  font: [...Object.keys(fontChoices()), 'Inter', 'comic-sans', '0', 'constructor', 'toString'],
  button: ['', 'rounded', 'pill', 'square', 'Pill'],
  avatar_shape: ['circle', 'rounded', 'square', 'oval'],
  avatar_ring: ['none', 'accent', 'rainbow', 'story', 'pulse', 'glow'],
  particles: ['none', 'snow', 'confetti', 'fireflies', 'rain'],
  cursor_sparks: FLAGS_IN, bg_overlay: NUMBERS, hide_branding: FLAGS_IN, notify_email: FLAGS_IN, share_button: FLAGS_IN,
  custom_css: ['', 'body{color:red}', 'a{background:url(https://evil.com/x.png)}', '</style><script>x</script>', 'a{b:u\\72l(//evil.com)}', '@import "x.css"; a{}'],
  enabled: FLAGS_IN, text: TEXTS, animation: ['fade', 'zoom', 'curtain', 'blur', 'flip', 'spin', ''], music: UPLOADS,
  music_url: ['https://example.com/a.mp3', 'http://example.com/a.mp3', 'youtube.com/watch?v=dQw4w9WgXcQ', 'HTTPS://X.DE/a', 'ftp://x', '', 'javascript:x', 'mailto:a@b.de', ' https://a.de '],
  volume: NUMBERS, loop: FLAGS_IN, title: TEXTS, description: TEXTS, keywords: TEXTS,
};

function obj(r: R, keys: string[], nested: Record<string, (r: R) => unknown> = {}): O {
  const pairs: Array<[string, unknown]> = [];
  for (const k of keys) {
    if (!r.chance(0.7)) continue;
    pairs.push([k, Object.hasOwn(nested, k) && r.chance(0.8) ? nested[k](r) : r.chance(0.8) && Object.hasOwn(CHOICE, k) ? r.pick(CHOICE[k]) : anyValue(r)]);
  }
  if (r.chance(0.2)) pairs.push([r.pick(['zzz', '5', '0', 'extra', '__proto__', 'constructor']), anyValue(r)]);
  if (r.chance(0.3)) pairs.reverse();
  return new O(pairs);
}

const ENTRANCE_KEYS = ['enabled', 'text', 'animation', 'music', 'music_url', 'volume', 'loop'];
const SEO_KEYS = ['title', 'description', 'keywords'];
const SETTINGS_KEYS = ['accent', 'font', 'button', 'avatar_shape', 'avatar_ring', 'particles', 'cursor_sparks', 'bg_overlay', 'entrance', 'seo', 'custom_css',
  'hide_branding', 'notify_email', 'share_button'];

const settingsInput = (r: R): unknown => (r.chance(0.95)
  ? obj(r, SETTINGS_KEYS, { entrance: (x) => obj(x, ENTRANCE_KEYS), seo: (x) => obj(x, SEO_KEYS) })
  : anyValue(r));

test('editor settings are checked exactly like PHP (premium and free)', () => {
  const r = rng(808);
  const cases: unknown[] = [
    // Testvektor aus der Beschreibung
    { in: new O([['accent', '#AABBCC'], ['entrance', { enabled: 1, text: '0', volume: -5, loop: null, music_url: 'youtube.com/watch?v=dQw4w9WgXcQ' }],
      ['seo', { title: ' T  ' }], ['cursor_sparks', '0'], ['bg_overlay', '95'], ['share_button', ''], ['hide_branding', true]]), user: 5, premium: false, old: { hide_branding: true } },
    { in: { hide_branding: true }, user: 5, premium: true, old: { hide_branding: false } },
    { in: { hide_branding: true }, user: 5, premium: false, old: { hide_branding: false } },
    { in: [], user: 5, premium: false, old: [] },
    { in: 'nope', user: 5, premium: true, old: {} },
    { in: null, user: 5, premium: false, old: { hide_branding: '1' } },
  ];
  for (let i = 0; i < 2500; i++) {
    cases.push({ in: settingsInput(r), user: r.pick([5, 6]), premium: r.chance(0.5), old: r.chance(0.8) ? new O([['hide_branding', r.pick(FLAGS_IN)]]) : anyValue(r) });
  }
  const text = jsonText(cases);
  const php = JSON.parse(runPhp(PHP_EACH(`oys_settings_normalize($c['in'], $c['user'], $c['premium'], is_array($c['old']) ? $c['old'] : [])`), text)) as string[];
  const node = nodeEach(jsonDecode(text) as unknown[], (c) => {
    const { in: input, user, premium, old } = c as { in: unknown; user: number; premium: boolean; old: unknown };
    return settingsNormalize(input, user, premium, old !== null && typeof old === 'object' ? old : []);
  });
  assert.deepEqual(diffs(cases.map((c) => jsonText(c)), node, php), []);
  assert.ok(new Set(php).size > 2000, 'many different results');
});

function storedSettings(r: R): unknown {
  const k = r.next(20);
  if (k === 0) return r.pick(['', 'null', '[]', '{}', '{', '"str"', '5', 'true', '[1,2]', '{"seo":"bad"}', '{"entrance":[]}', '{"entrance":{"0":1}}', ' {} ', 'nul']);
  if (k === 1) return r.pick([null, 5, true, 1.5]);
  return jsonText(settingsInput(r));
}

test('stored settings are read like PHP, with unknown keys kept in their order', () => {
  const r = rng(909);
  const cases: unknown[] = ['{"zzz":1,"entrance":{"volume":"30","foo":2},"accent":"#fff","seo":"bad"}', '{"b":1,"5":2,"accent":"#000000","3":{"x":[]}}',
    '{"custom_css":"a{background:url(https://evil.com/x)}","entrance":{"music":"music_5_1.mp3"}}', '{"entrance":{"loop":false,"zz":1,"0":2},"seo":{"keywords":null}}',
    '{"seo":{"title":"Pixel | OnYourSite","description":"","keywords":""},"custom_css":"","hide_branding":true}'];
  for (let i = 0; i < 1500; i++) cases.push(storedSettings(r));
  const text = jsonText(cases);
  // Gespeicherte Werte gehen ungeprüft durch – auch Kommazahlen (Schreibweise siehe jsFloats)
  const php = (JSON.parse(runPhp(PHP_EACH(`oys_page_settings(['settings' => $c])`), text)) as string[]).map(jsFloats);
  const node = nodeEach(jsonDecode(text) as unknown[], (c) => pageSettings({ settings: c }));
  assert.deepEqual(diffs(cases, node, php), []);
  // Fehlende Einstellungen = Vorgaben
  assert.equal(enc(pageSettings({})), enc(defaultSettings()));
});

function pageRow(r: R): O {
  const pairs: Array<[string, unknown]> = [
    ['id', r.pick([7, '12', 3, 0, '0'] as unknown[])], ['user_id', 5], ['slug', r.pick(['mia', 'tom', 'Mia', 'a-b', '', null] as unknown[])],
    ['position', 0], ['title', r.pick(TEXTS)], ['subtitle', r.pick(TEXTS)], ['bio', r.chance(0.3) ? null : r.pick(TEXTS)],
    ['avatar', r.pick([null, '', 'avatar_5_1700000000_abcdef12.png', 'avatar_5_1.webp', '0', 'x_6_1.png'] as unknown[])],
    ['bg_image', r.pick([null, '', 'bg_5_1.jpg', 'avatar_5_1700000000_abcdef12.png'] as unknown[])],
    ['theme', r.pick([...Object.keys(themes()), 'unknown', '', null, 'constructor'] as unknown[])],
    ['layout', r.pick([...Object.keys(layouts()), 'unknown', '', null, 'toString'] as unknown[])],
    ['address_mode', r.pick(['subdomain', 'path', 'PATH', '', null] as unknown[])], ['settings', storedSettings(r)],
    ['views', 3], ['slug_changed_at', null], ['created_at', '2026-11-01 20:23:13'], ['updated_at', '2026-11-01 20:23:14'],
  ];
  // Manche Aufrufer geben nur einen Teil der Spalten
  return new O(r.chance(0.15) ? pairs.filter(() => r.chance(0.7)) : pairs);
}

function blockData(r: R): string {
  const k = r.next(12);
  if (k === 0) return r.pick(['', 'null', '[]', '{}', '{', '"x"', '5', '[1,2]', '{"1":"a","0":"b"}', '{"0":"a","1":"b"}', '{"b":1,"5":2}']);
  const pairs: Array<[string, unknown]> = [];
  for (const key of ['title', 'url', 'thumb', 'src', 'images', 'text', 'items']) {
    if (!r.chance(0.4)) continue;
    if (key === 'images') {
      pairs.push([key, r.chance(0.8) ? Array.from({ length: r.next(4) }, () => (r.chance(0.8) ? new O([['src', r.pick(UPLOADS)], ['caption', 'c']]) : anyValue(r))) : anyValue(r)]);
    } else pairs.push([key, r.chance(0.7) && (key === 'thumb' || key === 'src') ? r.pick(UPLOADS) : anyValue(r)]);
  }
  return jsonText(new O(pairs));
}

function blockRow(r: R): O {
  return new O([
    ['id', r.pick([7, '7', 14, 0] as unknown[])], ['page_id', 3], ['type', r.pick(['link', 'socials', 'booking', 'file', 'image', 'gallery', 'text'])],
    ['position', 0], ['is_visible', r.pick([1, 0, '1', '0'] as unknown[])], ['data', blockData(r)],
    ['schedule', r.pick([null, '', 'null', '[]', '{}', '{"enabled":true,"days":[1,2],"from":"09:00","to":"","start":"","end":""}', '{"enabled":false}', '{', '"x"'] as unknown[])],
    ['protection', r.pick(['none', 'password', 'age', '', null, '0'] as unknown[])], ['password_hash', r.pick([null, '', '0', '$2y$10$abc', 'preview'] as unknown[])],
    ['effect', r.pick(['none', 'shine', '', null, '0'] as unknown[])], ['clicks', r.pick([3, '3', 0, null, '12abc'] as unknown[])], ['legacy_link_id', null], ['created_at', null],
  ]);
}

test('blocks for the editor match PHP for test-database rows and odd rows', async () => {
  const r = rng(1234);
  const rows: unknown[] = [new O([['id', '7'], ['type', 'link'], ['is_visible', 1], ['data', '[]'], ['schedule', null], ['protection', ''], ['password_hash', null],
    ['effect', null], ['clicks', 3]])];
  for (let i = 0; i < 1200; i++) rows.push(blockRow(r));
  const text = jsonText(rows);
  const php = (JSON.parse(runPhp(PHP_EACH('[oys_block_from_row($c), oys_block_for_editor(oys_block_from_row($c))]'), text)) as string[]).map(jsFloats);
  const node = nodeEach(jsonDecode(text) as unknown[], (c) => [blockFromRow(c as never), blockForEditor(blockFromRow(c as never))]);
  assert.deepEqual(diffs(rows.map((x) => jsonText(x)), node, php), []);
  assert.equal(php[0], enc([{ id: 7, type: 'link', is_visible: 1, data: [], schedule: null, protection: 'none', has_password: false, password_hash: null, effect: 'none', clicks: 3 },
    { id: 7, type: 'link', visible: true, data: {}, schedule: { enabled: false, days: [], from: '', to: '', start: '', end: '' }, protection: 'none', has_password: false, password: '', effect: 'none', clicks: 3 }]));

  // Die echten Zeilen: PHP liest mit PDO, Node mit mysql2
  const phpDb = JSON.parse(runPhp(`$out = [];
    foreach ($pdo->query('SELECT id FROM pages ORDER BY id')->fetchAll() as $p) {
      $page = oys_load_page($pdo, (int) $p['id']);
      $out[] = json_encode([oys_page_for_editor($page), array_map('oys_block_for_editor', oys_load_blocks($pdo, (int) $p['id'])), oys_load_blocks($pdo, (int) $p['id']),
        oys_page_files($page, oys_load_blocks($pdo, (int) $p['id'])), oys_og_hash($page), oys_og_url($page), array_map(fn($x) => $x['id'], oys_user_pages($pdo, (int) $page['user_id']))], ${'JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES'});
    }
    echo json_encode($out);`, 'null', { db: true })) as string[];
  const nodeDb: string[] = [];
  for (const { id } of await q('SELECT id FROM pages ORDER BY id')) {
    const page = (await q('SELECT * FROM pages WHERE id = ?', [id as number]))[0];
    const blocks = await loadBlocks(id as number);
    nodeDb.push(enc([pageForEditor(page), blocks.map(blockForEditor), blocks, pageFiles(page, blocks), ogHash(page), ogUrl(page), (await userPages(page.user_id as number)).map((x) => x.id)]));
  }
  assert.ok(phpDb.length >= 4);
  assert.deepEqual(nodeDb, phpDb);
});

test('pages for the editor, page files and preview image addresses match PHP for odd rows', () => {
  const r = rng(4711);
  const cases: unknown[] = [
    // aus reference/php-generators/hash.php
    { page: { id: 7, slug: 'mia', address_mode: 'subdomain', title: 'Mia 🎧', subtitle: '', bio: null, avatar: null, theme: 'galaxy', settings: '{}' }, blocks: [] },
    { page: { id: '12', slug: 'tom', address_mode: 'path', title: 'Tom', subtitle: 'Sub', bio: 'a\nb', avatar: 'avatar_1_1_ab.webp', theme: 'unknown', settings: '{"accent":"#ff0000","hide_branding":true}' }, blocks: [] },
  ];
  for (let i = 0; i < 800; i++) {
    cases.push({ page: pageRow(r), blocks: Array.from({ length: r.next(5) }, () => new O([['data', jsonDecode(blockData(r)) ?? []]])) });
  }
  const text = jsonText(cases);
  const php = (JSON.parse(runPhp(PHP_EACH(`[isset($c['page']['slug'], $c['page']['title'], $c['page']['subtitle'], $c['page']['theme'], $c['page']['layout'], $c['page']['address_mode']) && array_key_exists('bio', $c['page']) && array_key_exists('avatar', $c['page']) && array_key_exists('bg_image', $c['page']) ? oys_page_for_editor($c['page']) : null,
    oys_page_files($c['page'], array_map(fn($b) => ['data' => is_array($b['data']) ? $b['data'] : []], $c['blocks'])), oys_og_hash($c['page']), isset($c['page']['id']) ? oys_og_url($c['page']) : null]`), text)) as string[]).map(jsFloats);
  const node = nodeEach(jsonDecode(text) as unknown[], (c) => {
    const { page, blocks } = c as { page: Record<string, unknown>; blocks: Array<{ data: unknown }> };
    const full = ['slug', 'title', 'subtitle', 'theme', 'layout', 'address_mode'].every((k) => page[k] !== undefined && page[k] !== null) && ['bio', 'avatar', 'bg_image'].every((k) => Object.hasOwn(page, k));
    return [full ? pageForEditor(page) : null, pageFiles(page, blocks.map((b) => ({ data: b.data !== null && typeof b.data === 'object' ? b.data : [] }) as Block)),
      ogHash(page), page.id !== undefined && page.id !== null ? ogUrl(page) : null];
  });
  assert.deepEqual(diffs(cases.map((c) => jsonText(c)), node, php), []);
  const phpPages = php.map((x) => JSON.parse(x) as unknown[]);
  assert.ok(phpPages.filter((x) => x[0] !== null).length > 300 && phpPages.filter((x) => (x[1] as unknown[]).length > 1).length > 100);
});

test('default settings are a fresh copy each time', () => {
  const a = defaultSettings();
  a.entrance.volume = 5;
  (a.seo as Record<string, string>).title = 'changed';
  assert.equal(defaultSettings().entrance.volume, 70);
  assert.equal(defaultSettings().seo.title, '');
  const s = pageSettings({ settings: '{"5":1,"b":2}' }) as PhpArr;
  assert.deepEqual(Object.keys(s).slice(-2), ['5', 'b']);
});
