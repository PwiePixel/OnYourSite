// Blöcke gegen PHP (lib/blocks.php der PHP-Version, siehe support/phpRef.ts): Prüfung der Eingaben mit gültigen,
// ungültigen, feindlichen und zufälligen Werten für jeden Blocktyp, Einbettungen, Zeitsteuerung rund um die
// Zeitumstellung und die Kalender-Schlüssel
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passwordHash, passwordVerify } from '../src/crypto.js';
import { brands } from '../src/content/social.js';
import {
  blockTypes, bookingIsInternal, calendarKey, pick, validUpload, IMAGE_EXTS, blockNormalize, scheduleNormalize, scheduleActive,
  parseEmbed, embedSrc, youtubeMusic, type Embed,
} from '../src/content/blocks.js';
import { jsonDecode, parseLocalDateTime, type PhpArr } from '../src/content/util.js';
import { runPhp, PHP_EACH, nodeEach, nodeEachAsync, diffs, jsonText, rng, O, Raw, enc } from './modelHarness.js';
import { PHP_SKIP } from './support/phpRef.js';

const UPLOADS = ['avatar_5_1700000000_abcdef12.png', 'thumb_5_1700000000_abcdef12.JPG', 'thumb_5_1700000000_abcdef12.jpg', 'img_5_x.webp', 'gal_5_1_a.gif',
  'file_5_1.pdf', 'file_5_1.vcf', 'file_5_1.zip', 'music_5_1.mp3', 'music_5_1.m4a', 'music_5_1.wav', 'x_6_1.png', 'avatar_05_1.png', '../avatar_5_1.png',
  'dir/avatar_5_1.png/', 'avatar_5_1.png\n/', ' avatar_5_1.png ', '\tavatar_5_1.png\n', 'avatar_5_1.exe', 'avatar_5_1.toolong', 'Avatar_5_1.png', 'avatar_5_.png',
  'avatar_5_1.png.php', 'avatar_5_1.p', 'avatar_5_1', '/', '', 'a/b/', '///', 'avatar_5_1_2_3.jpeg', 'avatar_99999999999999999999_1.png', 'avatar_5_ä.png',
  'avatar_5_1.PNG', 'avatar-5-1.png', 'avatar_5_1.png/x', 'file_5_1773643714.pdf'];

test('upload names are checked like PHP', { skip: PHP_SKIP }, () => {
  const extLists = [[], IMAGE_EXTS, ['pdf', 'vcf', 'zip'], ['mp3', 'm4a', 'ogg', 'wav'], ['PNG']];
  const values: unknown[] = [...UPLOADS, null, 5, true, ['avatar_5_1.png'], { a: 1 }];
  const cases = values.flatMap((f) => [5, 6, 0, new Raw('9223372036854775807')].flatMap((u) => extLists.map((x) => [f, u, x])));
  const php = JSON.parse(runPhp(PHP_EACH('oys_valid_upload($c[0], $c[1], $c[2])'), jsonText(cases))) as string[];
  const node = nodeEach(jsonDecode(jsonText(cases)) as unknown[], (c) => {
    const [f, u, x] = c as [unknown, number, string[]];
    return validUpload(f, u, x);
  });
  assert.deepEqual(diffs(cases, node, php), []);
  assert.ok(php.filter((r) => r !== 'null').length > 20, 'some names are valid');
});

test('oys_pick, booking addresses and calendar keys match PHP', { skip: PHP_SKIP }, () => {
  const picks = [['a', ['a', 'b'], 'x'], ['c', ['a', 'b'], 'x'], [null, ['', 'a'], 'd'], ['', ['', 'a'], 'd'], [1, ['1'], 'n'], ['1', [1], 'n'], [true, ['1'], 'n']];
  const phpPick = JSON.parse(runPhp(PHP_EACH('oys_pick($c[0], $c[1], $c[2])'), jsonText(picks))) as string[];
  assert.deepEqual(diffs(picks, nodeEach(picks, (c) => pick((c as unknown[])[0], (c as unknown[][])[1], (c as unknown[])[2])), phpPick), []);

  const pages = [{ slug: 'mia', address_mode: 'subdomain' }, { slug: 'mia', address_mode: 'path' }, { slug: 'Mia', address_mode: 'subdomain' }, { slug: 'tom', address_mode: null }];
  const urls: unknown[] = ['', '/kalender', '/kalender/', '/Kalender', '/kalender//', ' /kalender ', 'https://mia.oys.test:8080/kalender', 'http://mia.oys.test:8080/kalender/',
    'HTTP://MIA.OYS.TEST:8080/KALENDER', 'https://oys.test:8080/mia/kalender', 'http://oys.test:8080/MIA/kalender', 'mia.oys.test:8080/kalender', 'https://mia.oys.test/kalender',
    'https://evil.com/kalender', 'https://calendly.com/x', 'http://tom.oys.test:8080/kalender', null, 5, ['x'], '/kalender?x=1'];
  const datas: unknown[] = [...urls.map((u) => ({ url: u })), {}, [], ['/kalender'], { title: 'x' }];
  const cases = pages.flatMap((p) => datas.map((d) => [d, p]));
  const php = JSON.parse(runPhp(PHP_EACH('oys_booking_is_internal($c[0], $c[1])'), jsonText(cases))) as string[];
  const node = nodeEach(jsonDecode(jsonText(cases)) as unknown[], (c) => bookingIsInternal((c as unknown[])[0], (c as never[])[1]));
  assert.deepEqual(diffs(cases, node, php), []);

  const keys = [[{ id: 7 }, { id: 14, password_hash: '$2y$10$abc' }], [{ id: '7' }, { id: '14' }], [{ id: 7 }, { id: 14, password_hash: null }], [{ id: 1 }, { id: 2, password_hash: '' }]];
  const phpKeys = JSON.parse(runPhp(PHP_EACH('oys_calendar_key($c[0], $c[1])'), jsonText(keys))) as string[];
  assert.deepEqual(diffs(keys, nodeEach(keys, (c) => calendarKey((c as never[])[0], (c as never[])[1])), phpKeys), []);
});

// ---------------------------------------------------------------- oys_block_normalize

const TEXTS = ['', ' ', '0', 'a', 'Hello World', '  padded  ', 'x'.repeat(130), 'ä'.repeat(320), '🐝'.repeat(70), 'tab\there', 'line\nbreak\n\n\n\nend', 'cr\r\nlf',
  '‮bidi⁦', 'ctrl\u0007x\u0000', ' nbsp ', '<b>html</b>', '"quotes\'', 'x'.repeat(3100), 'line\n'.repeat(700)];
const URLS = ['', 'https://example.com', 'example.com/path', 'mailto:a@b.de', 'a@b.de', 'tel:+49123', '+49 170 1234567', '0049 170 1234567', 'javascript:alert(1)',
  '//evil.com', '/kalender', '/relative/path', 'https://', 'ftp://x.de', ' https://x.de/a b ', 'https://youtube.com/watch?v=dQw4w9WgXcQ', 'youtu.be/dQw4w9WgXcQ',
  'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', 'spotify:track:4uLU6hMCjMI75M1A2tKUQC', 'https://twitch.tv/somechannel', 'https://vimeo.com/123',
  'https://youtube.com/watch?v[]=x', 'https://youtube.com/watch?list[]=x', 'https://youtube.com/watch?v=dQw4w9WgXcQ%0A', 'https://youtube.com/watch?v%00=dQw4w9WgXcQ',
  'https://youtube.com/watch?__proto__[x]=1&v=dQw4w9WgXcQ', 'localhost', 'https://localhost/x', 'münchen.de', 'x'.repeat(1200)];
const ICONS = ['', 'none', 'auto', 'brand:instagram', 'brand:nope', 'brand:constructor', 'bx bx-music', 'bxl bxl-github', 'bx bx-Music', ' bx bx-heart ', 'fa fa-x'];
const CHOICES = ['icons', 'brand', 'pills', 'line', 'dots', 'space', 'wave', 's', 'm', 'l', 'xl', 'left', 'center', 'right', 'auto', 'square', 'wide', 'portrait',
  'youtube', 'twitch', 'spotify', 'vimeo', 'ICONS', '', 'none', 'shine', 'wobble', 'pulse', 'password', 'age', 'PASSWORD'];
const DATES = ['', '2026-12-24T18:00', '2026-12-24T18:00\n', '2026-13-45T25:61', '2026-12-24 18:00', '2026-12-24T18:00:00', '2026-12-24T18:00 ', 'tomorrow', '0000-00-00T00:00'];
const TIMES = ['', '00:00', '09:00', '09:00\n', '23:59', '24:00', '9:00', '09:60', '12:30', '22:00', '02:00', ' 09:00', '09:00 '];
const FLAGS_IN: unknown[] = [true, false, 1, 0, '0', '1', '', 'yes', null, [], [0], {}, 0.0, new Raw('-0'), new Raw('0.0'), ' '];
const NUMBERS: unknown[] = [0, 1, -1, 7, 45, 90, 91, 100, 101, -5, 1.5, 0.5, 2.5, new Raw('1e20'), new Raw('-1e19'), new Raw('1e19'), new Raw('-0'), new Raw('1.0'),
  '12abc', ' 12', '1e3', '0x1A', '-5.9', '', 'abc', '99999999999999999999', '1e400'];

type R = ReturnType<typeof rng>;

function anyValue(r: R, depth = 0): unknown {
  const k = r.next(100);
  if (k < 35) return r.pick(TEXTS);
  if (k < 50) return r.pick(URLS);
  if (k < 58) return r.pick(UPLOADS);
  if (k < 66) return r.pick(NUMBERS);
  if (k < 74) return r.pick(FLAGS_IN);
  if (k < 80) return r.pick(CHOICES);
  if (depth > 1) return null;
  if (k < 88) return Array.from({ length: r.next(4) }, () => anyValue(r, depth + 1));
  return new O(Array.from({ length: r.next(4) }, () => [r.pick(['a', 'p', 'v', 'src', '0', '1', '5', 'title', 'url', '__proto__']), anyValue(r, depth + 1)]));
}

function item(r: R): unknown {
  if (r.chance(0.1)) return anyValue(r);
  const pairs: Array<[string, unknown]> = [];
  if (r.chance(0.9)) pairs.push(['p', r.chance(0.8) ? r.pick(Object.keys(brands())) : r.pick(['Instagram', 'nope', '', 'constructor', '__proto__', 'toString', 5, null, ['x']] as unknown[])]);
  if (r.chance(0.85)) pairs.push(['v', r.chance(0.6) ? r.pick(['', 'user', '@user', 'https://instagram.com/x', 'a@b.de', '+49 170 1', ' x ']) : anyValue(r)]);
  if (r.chance(0.2)) pairs.push([r.pick(['x', '0', 'src', 'caption']), anyValue(r)]);
  if (r.chance(0.3)) pairs.reverse();
  return new O(pairs);
}

function image(r: R): unknown {
  if (r.chance(0.1)) return anyValue(r);
  const pairs: Array<[string, unknown]> = [];
  if (r.chance(0.9)) pairs.push(['src', r.chance(0.8) ? r.pick(UPLOADS) : anyValue(r)]);
  if (r.chance(0.7)) pairs.push(['caption', r.chance(0.7) ? r.pick(TEXTS) : anyValue(r)]);
  if (r.chance(0.3)) pairs.reverse();
  return new O(pairs);
}

// Liste – oder ein Objekt mit Zahlen-Schlüsseln in beliebiger Reihenfolge (PHP behält sie, JavaScript-Objekte nicht)
function list(r: R, make: (r: R) => unknown, max: number): unknown {
  const n = r.next(max);
  const items = Array.from({ length: n }, () => make(r));
  const k = r.next(10);
  if (k < 6) return items;
  if (k < 8) return new O(items.map((x, i) => [String(r.chance(0.5) ? n - i : i * 3), x] as [string, unknown]));
  if (k < 9) return new O(items.map((x, i) => [r.chance(0.5) ? 'k' + i : String(i), x] as [string, unknown]));
  return anyValue(r);
}

const DATA_KEYS: Record<string, string[]> = {
  link: ['title', 'url', 'subtitle', 'icon', 'thumb', 'featured'], socials: ['items', 'style'], heading: ['text', 'size', 'align'], text: ['text', 'align'],
  divider: ['style'], image: ['src', 'alt', 'caption', 'url', 'ratio'], gallery: ['images', 'ratio', 'autoplay'], embed: ['url', 'title', 'provider'],
  countdown: ['title', 'target', 'done_text', 'url', 'url_label'], contact: ['title', 'intro', 'button', 'success'], booking: ['title', 'url'], file: ['title', 'src'],
};

function goodValue(r: R, key: string): unknown {
  switch (key) {
    case 'url': return r.pick(URLS);
    case 'icon': return r.pick(ICONS);
    case 'thumb': case 'src': return r.pick(UPLOADS);
    case 'featured': case 'autoplay': return r.pick(FLAGS_IN);
    case 'items': return list(r, item, 36);
    case 'images': return list(r, image, 24);
    case 'style': case 'size': case 'align': case 'ratio': case 'provider': return r.pick(CHOICES);
    case 'target': return r.pick(DATES);
    default: return r.pick(TEXTS);
  }
}

function schedule(r: R): unknown {
  if (r.chance(0.3)) return r.chance(0.5) ? null : anyValue(r);
  const pairs: Array<[string, unknown]> = [['enabled', r.pick([true, true, true, 1, '1', 'yes', 0, '0', '', false, null, [], [0]] as unknown[])]];
  if (r.chance(0.8)) {
    const days = r.next(10) < 7
      ? Array.from({ length: r.next(9) }, () => r.pick([1, 2, 3, 4, 5, 6, 7, 7, 0, 8, -1, '3', '7x', 1.5, true, null, [5], '', ' 2'] as unknown[]))
      : r.pick([3, '1', null, {}, 'abc', true, new O([['b', 2], ['a', 6]])] as unknown[]);
    pairs.push(['days', days]);
  }
  for (const k of ['from', 'to']) if (r.chance(0.6)) pairs.push([k, r.chance(0.85) ? r.pick(TIMES) : anyValue(r)]);
  for (const k of ['start', 'end']) if (r.chance(0.4)) pairs.push([k, r.chance(0.85) ? r.pick(DATES) : anyValue(r)]);
  return new O(pairs);
}

const NO_HASH_PASSWORDS: unknown[] = [undefined, null, '', '   ', 'abc', 'äää', '12345', '  1234  ', 5, 123456, true, ['secret123'], { pw: 'x' }];

function blockCase(r: R): unknown {
  // Klickbare Typen (Schutz, Effekt) etwas häufiger
  const type = r.chance(0.3) ? r.pick(['link', 'booking', 'file']) : r.next(20) < 18 ? r.pick(Object.keys(blockTypes()))
    : r.pick(['', 'LINK', 'unknown', 5, null, ['link'], true, 'constructor', '__proto__', 'toString'] as unknown[]);
  const pairs: Array<[string, unknown]> = [];
  if (r.chance(0.97)) pairs.push(['type', type]);
  if (r.chance(0.92)) {
    const keys = typeof type === 'string' && Object.hasOwn(DATA_KEYS, type) ? DATA_KEYS[type] : ['title', 'url'];
    const data: Array<[string, unknown]> = [];
    for (const k of keys) if (r.chance(0.8)) data.push([k, r.chance(0.75) ? goodValue(r, k) : anyValue(r)]);
    if (r.chance(0.15)) data.push([r.pick(['items', 'images', 'url', 'x', '0', '__proto__', 'constructor']), anyValue(r)]);
    if (r.chance(0.3)) data.reverse();
    pairs.push(['data', r.chance(0.94) ? new O(data) : anyValue(r)]);
  }
  const preview = r.chance(0.5);
  if (r.chance(0.6)) pairs.push(['protection', r.pick(['none', 'password', 'password', 'age', 'PASSWORD', '', null, 5] as unknown[])]);
  const pw = preview && r.chance(0.6) ? r.pick(['secret123', '  spaced pw  ', 'äöüäöü', 'x'.repeat(150)] as unknown[]) : r.pick(NO_HASH_PASSWORDS);
  if (pw !== undefined) pairs.push(['password', pw]);
  if (r.chance(0.5)) pairs.push(['visible', r.pick(FLAGS_IN)]);
  if (r.chance(0.5)) pairs.push(['effect', r.pick(['none', 'shine', 'wobble', 'pulse', 'SHINE', '', null, 3] as unknown[])]);
  if (r.chance(0.5)) pairs.push(['schedule', schedule(r)]);
  if (r.chance(0.3)) pairs.push(['id', r.pick([1, 'n3', '5', null] as unknown[])]);
  if (r.chance(0.3)) pairs.reverse();
  const existing = r.pick([null, null, { id: 9, password_hash: 'EXISTING-HASH' }, { id: 9, password_hash: '' }, { id: 9, password_hash: null }, { id: 9 }] as unknown[]);
  return { in: new O(pairs), user: r.pick([5, 5, 5, 6]), existing, preview };
}

// Neue bcrypt-Hashes sind zufällig: beide Seiten prüfen ihren Hash selbst und melden nur das Ergebnis
const PHP_NORMALIZE = PHP_EACH(`(function ($c) {
  $r = oys_block_normalize($c['in'], $c['user'], $c['existing'], $c['preview']);
  if ($r && is_string($r['password_hash']) && str_starts_with($r['password_hash'], '$2y$10$')) {
    $r['password_hash'] = password_verify(mb_substr(trim($c['in']['password']), 0, 100), $r['password_hash']) ? 'BCRYPT_OK' : 'BCRYPT_BAD';
  }
  return $r;
})($c)`);

async function nodeNormalize(c: unknown): Promise<unknown> {
  const { in: input, user, existing, preview } = c as { in: PhpArr; user: number; existing: Record<string, unknown> | null; preview: boolean };
  const r = await blockNormalize(input, user, existing, preview);
  if (r && typeof r.password_hash === 'string' && r.password_hash.startsWith('$2y$10$')) {
    const pw = (input as Record<string, string>).password;
    r.password_hash = (await passwordVerify([...pw.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '')].slice(0, 100).join(''), r.password_hash)) ? 'BCRYPT_OK' : 'BCRYPT_BAD';
  }
  return r;
}

test('block normalization matches PHP for fixed cases, including new and kept passwords', { skip: PHP_SKIP }, async () => {
  const link = (extra: Array<[string, unknown]>) => new O([['type', 'link'], ['data', { title: 'My link', url: 'example.com' }], ...extra]);
  const cases = [
    // jeder Typ mit gültigen Daten
    { in: { type: 'link', data: { title: ' Shop ', url: 'shop.example/x', subtitle: 'Sub', icon: 'brand:instagram', thumb: 'thumb_5_1700000000_abcdef12.png', featured: true } }, user: 5, existing: null, preview: false },
    { in: { type: 'socials', data: { items: [{ p: 'instagram', v: '@mia' }, { p: 'nope', v: 'x' }, { p: 'email', v: 'a@b.de' }], style: 'brand' } }, user: 5, existing: null, preview: false },
    { in: { type: 'heading', data: { text: 'Hi', size: 'l', align: 'left' } }, user: 5, existing: null, preview: false },
    { in: { type: 'text', data: { text: 'a\r\nb\n\n\n\nc', align: 'right' } }, user: 5, existing: null, preview: false },
    { in: { type: 'divider', data: { style: 'wave' } }, user: 5, existing: null, preview: false },
    { in: { type: 'image', data: { src: 'img_5_1700000000_abcdef12.webp', alt: 'A', caption: 'C', url: 'x.de', ratio: 'wide' } }, user: 5, existing: null, preview: false },
    { in: { type: 'gallery', data: { images: [{ src: 'gal_5_1_a.png', caption: 'one' }, { src: 'gal_6_1_a.png' }, { src: 'gal_5_2_b.gif' }], ratio: 'portrait', autoplay: '1' } }, user: 5, existing: null, preview: false },
    { in: { type: 'embed', data: { url: 'https://youtu.be/dQw4w9WgXcQ?t=42', title: 'Video', provider: 'spotify' } }, user: 5, existing: null, preview: false },
    { in: { type: 'embed', data: { url: 'https://vimeo.com/1', provider: 'twitch' } }, user: 5, existing: null, preview: false },
    { in: { type: 'countdown', data: { title: 'Launch', target: '2026-12-24T18:00', done_text: 'Live!', url: 'x.de', url_label: 'Go' } }, user: 5, existing: null, preview: false },
    { in: { type: 'contact', data: { title: 'Write me', intro: 'Hi\n\n\n\nthere', button: 'Send', success: 'Thanks' } }, user: 5, existing: null, preview: false },
    { in: { type: 'booking', data: { title: 'Book' } }, user: 5, existing: null, preview: false },
    { in: { type: 'booking', data: { title: '0', url: 'javascript:x' } }, user: 5, existing: null, preview: false },
    { in: { type: 'file', data: { title: 'CV', src: 'file_5_1773643714.pdf' } }, user: 5, existing: null, preview: false },
    // Schutz und Sichtbarkeit
    { in: link([['protection', 'password'], ['password', 'secret123']]), user: 5, existing: null, preview: false },
    { in: link([['protection', 'password'], ['password', '  äöüäöü  ']]), user: 5, existing: null, preview: false },
    { in: link([['protection', 'password'], ['password', '🐝'.repeat(30) + 'x'.repeat(120)]]), user: 5, existing: null, preview: false },
    { in: link([['protection', 'password'], ['password', 'abc\u0000defgh']]), user: 5, existing: null, preview: false },
    { in: link([['protection', 'password'], ['password', 'short']]), user: 5, existing: { password_hash: 'EXISTING-HASH' }, preview: false },
    { in: link([['protection', 'password'], ['password', 'short']]), user: 5, existing: null, preview: false },
    { in: link([['protection', 'password'], ['password', '']]), user: 5, existing: { password_hash: '' }, preview: false },
    { in: link([['protection', 'password']]), user: 5, existing: null, preview: true },
    { in: link([['protection', 'password'], ['password', 'secret123']]), user: 5, existing: null, preview: true },
    { in: link([['protection', 'age'], ['effect', 'pulse'], ['visible', '0']]), user: 5, existing: null, preview: false },
    { in: new O([['type', 'heading'], ['data', { text: 'x' }], ['protection', 'password'], ['effect', 'shine'], ['visible', null]]), user: 5, existing: null, preview: false },
    { in: new O([['type', 'file'], ['data', { src: 'file_5_1.zip' }], ['protection', 'password'], ['password', 'zipzipzip']]), user: 5, existing: null, preview: false },
    // Zeitsteuerung aus der Beschreibung (PCRE-$ vor einem letzten \n)
    { in: new O([['type', 'text'], ['data', { text: 'x' }], ['schedule', { enabled: '1', days: ['7', '1', '1', 9, '3x'], from: '09:00\n', to: '24:00', start: '2026-01-01T10:00', end: 5 }]]), user: 5, existing: null, preview: false },
    // unbekannte Typen und kaputte Daten
    { in: { type: 'nope' }, user: 5, existing: null, preview: false },
    { in: { type: ['link'] }, user: 5, existing: null, preview: false },
    { in: { data: { title: 'x' } }, user: 5, existing: null, preview: false },
    { in: { type: 'link', data: 'string' }, user: 5, existing: null, preview: false },
    { in: { type: 'socials', data: { items: new O([['2', { p: 'x', v: '1' }], ['0', { p: 'github', v: 'b' }], ['a', { p: 'instagram', v: 'c' }]]) } }, user: 5, existing: null, preview: false },
  ];
  const text = jsonText(cases);
  const php = JSON.parse(runPhp(PHP_NORMALIZE, text)) as string[];
  const node = await nodeEachAsync(jsonDecode(text) as unknown[], nodeNormalize);
  assert.deepEqual(diffs(cases, node, php), []);
  assert.ok(php.filter((r) => r.includes('BCRYPT_OK')).length >= 4, 'new passwords were hashed and verified');
  assert.ok(php.includes('THROW'), 'a NUL byte in a new password fails like PHP');
});

test('random and hostile block input matches PHP', { skip: PHP_SKIP }, async () => {
  const r = rng(4242);
  const cases = Array.from({ length: 3000 }, () => blockCase(r));
  const text = jsonText(cases);
  const php = JSON.parse(runPhp(PHP_NORMALIZE, text)) as string[];
  const node = await nodeEachAsync(jsonDecode(text) as unknown[], nodeNormalize);
  assert.deepEqual(diffs(cases.map((c) => jsonText(c)), node, php), []);
  // Die Fälle decken die Typen, Warnungen und Fehler wirklich ab
  for (const type of Object.keys(blockTypes())) assert.ok(php.some((x) => x.startsWith(`{"type":"${type}"`)), type);
  for (const w of ['can’t be embedded', 'it’s been hidden', 'at least 6', '"password_hash":"preview"', '"password_hash":"EXISTING-HASH"', '"is_visible":0']) {
    assert.ok(php.filter((x) => x.includes(w)).length > 3, w);
  }
  assert.ok(php.filter((x) => x === 'null').length > 50, 'unknown types');
  assert.ok(php.filter((x) => x === 'THROW').length > 0, 'errors like PHP');
});

test('node and PHP accept each other’s link password hashes', { skip: PHP_SKIP }, async () => {
  const pws = ['secret123', 'äöüäöü', 'x'.repeat(100)];
  const nodeHashes = await Promise.all(pws.map((p) => passwordHash(p)));
  const phpOk = JSON.parse(runPhp('echo json_encode(array_map(fn($c) => password_verify($c[0], $c[1]), $in));', JSON.stringify(pws.map((p, i) => [p, nodeHashes[i]])))) as boolean[];
  assert.deepEqual(phpOk, [true, true, true]);
  const phpHashes = JSON.parse(runPhp('echo json_encode(array_map(fn($p) => password_hash($p, PASSWORD_DEFAULT), $in));', JSON.stringify(pws))) as string[];
  assert.deepEqual(await Promise.all(pws.map((p, i) => passwordVerify(p, phpHashes[i]))), [true, true, true]);
});

// ---------------------------------------------------------------- Zeitsteuerung

test('schedule normalization matches PHP', { skip: PHP_SKIP }, () => {
  const r = rng(77);
  const cases = Array.from({ length: 2000 }, () => schedule(r));
  const text = jsonText(cases);
  const php = JSON.parse(runPhp(PHP_EACH('oys_schedule_normalize($c)'), text)) as string[];
  const node = nodeEach(jsonDecode(text) as unknown[], scheduleNormalize);
  assert.deepEqual(diffs(cases.map((c) => jsonText(c)), node, php), []);
  assert.ok(php.filter((x) => x !== 'null').length > 500);
});

test('schedule activity matches PHP at many times, also across the time changes', { skip: PHP_SKIP }, () => {
  const r = rng(99);
  const day = (d: string, h: number, m: number): string => `${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const starts = ['', '2026-03-29T01:30', '2026-03-29T02:30', '2026-03-29T03:00', '2026-10-25T02:00', '2026-10-25T02:30', '2026-10-25T03:00', '2026-01-01T00:00',
    '2026-12-31T23:59', '2026-02-30T10:00', '2026-00-10T10:00', '2026-01-01T24:00', '2026-02-00T12:00', '2026-13-01T00:00', '2026-01-32T00:00', '2026-01-01T25:00',
    '2026-01-01T10:60', '0000-01-01T00:00', '0099-06-01T00:00', '9999-12-31T23:59', '2026-11-01T12:00\n', '2026-06-15T12:00', '2027-01-01T00:00', '2025-12-31T23:00'];
  const times = ['', '00:00', '01:00', '02:00', '02:30', '03:00', '06:30', '09:00', '12:00', '17:45', '22:00', '23:59', '09:00\n'];
  const schedules: unknown[] = [null, [], { enabled: false }, { enabled: true }, { enabled: '0', from: '09:00' }];
  for (let i = 0; i < 400; i++) {
    const days = r.next(10) < 7 ? [...new Set(Array.from({ length: r.next(8) }, () => 1 + r.next(7)))].sort() : r.pick([[], [1, 2, 3, 4, 5, 6, 7], ['5'], [5.5], [7, 7, 7, 7, 7, 7, 7]] as unknown[]);
    schedules.push({ enabled: true, days, from: r.pick(times), to: r.pick(times), start: r.chance(0.3) ? r.pick(starts) : '', end: r.chance(0.3) ? r.pick(starts) : '' });
  }
  // Zeitpunkte: rund um die Umstellungen (alle 15 Minuten), Grenzen der Starts/Enden und zufällige Zeiten im Jahr
  const instants: number[] = [];
  for (const base of [Date.UTC(2026, 2, 28, 22), Date.UTC(2026, 9, 24, 21)]) for (let k = 0; k <= 7 * 4; k++) instants.push(base / 1000 + k * 900);
  for (const s of starts) {
    try {
      const t = parseLocalDateTime(s, 'Europe/Berlin');
      instants.push(t - 1, t, t + 1);
    } catch {
      // ungültige Angaben haben keine Grenze
    }
  }
  for (let i = 0; i < 60; i++) instants.push(1767222000 + r.next(366 * 86400));
  const cases: Array<[number, number]> = [];
  for (let i = 0; i < schedules.length; i++) for (let k = 0; k < 14; k++) cases.push([i, r.pick(instants)]);
  const input = JSON.stringify({ s: schedules, c: cases });
  const php = JSON.parse(runPhp(`$tz = new DateTimeZone('Europe/Berlin'); $out = [];
    foreach ($in['c'] as [$i, $t]) { try { $out[] = json_encode(oys_schedule_active($in['s'][$i], (new DateTimeImmutable('@' . $t))->setTimezone($tz))); } catch (Throwable $e) { $out[] = 'THROW'; } }
    echo json_encode($out);`, input)) as string[];
  const decoded = jsonDecode(input) as { s: unknown[] };
  const node = nodeEach(cases, (c) => scheduleActive(decoded.s[(c as number[])[0]], (c as number[])[1], 'Europe/Berlin'));
  assert.deepEqual(diffs(cases.map(([i, t]) => jsonText([schedules[i], t])), node, php), []);
  assert.ok(php.filter((x) => x === 'true').length > 500 && php.filter((x) => x === 'false').length > 500 && php.includes('THROW'));
});

test('local date and time like new DateTimeImmutable($s, $tz), with PHP’s overflow and errors', { skip: PHP_SKIP }, () => {
  const r = rng(5);
  const years = ['0000', '0001', '0099', '0100', '1893', '1916', '1970', '2026', '2038', '9999'];
  const two = (n: number) => String(n).padStart(2, '0');
  const cases: string[] = [];
  for (let i = 0; i < 2500; i++) {
    const s = `${r.pick(years)}-${two(r.next(16))}-${two(r.next(34))}T${two(r.next(27))}:${two(r.next(62))}`;
    cases.push(r.chance(0.1) ? r.pick([' ', '\n', '\t']) + s : r.chance(0.1) ? s + r.pick([' ', '\n', '\t']) : s);
  }
  // Zeitumstellung (Lücke und doppelte Stunde) und Sommerzeit-Sonderfälle
  for (const d of ['2026-03-29', '2026-10-25', '1980-04-06', '1916-04-30', '1945-05-24']) for (let h = 0; h < 5; h++) for (const m of ['00', '30', '59']) cases.push(`${d}T${two(h)}:${m}`);
  const php = JSON.parse(runPhp(PHP_EACH(`(new DateTimeImmutable($c, new DateTimeZone('Europe/Berlin')))->getTimestamp()`), JSON.stringify(cases))) as string[];
  const node = nodeEach(cases, (c) => parseLocalDateTime(c as string, 'Europe/Berlin'));
  assert.deepEqual(diffs(cases, node, php), []);
  assert.ok(php.filter((x) => x === 'THROW').length > 100 && php.filter((x) => x !== 'THROW').length > 500);
});

// ---------------------------------------------------------------- Einbettungen

test('embeds (YouTube, Twitch, Spotify) match PHP', { skip: PHP_SKIP }, () => {
  const r = rng(31);
  const hosts = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com',
    'WWW.youtube.com', 'YouTube.com', 'youtube.com.evil.com', 'clips.twitch.tv', 'www.clips.twitch.tv', 'twitch.tv', 'www.twitch.tv', 'm.twitch.tv', 'TWITCH.TV',
    'open.spotify.com', 'www.open.spotify.com', 'spotify.com', 'evil.com', 'music.open.spotify.com', '', 'user@youtube.com', 'youtube.com:443'];
  const schemes = ['https://', 'http://', '//', '', 'HTTPS://', 'spotify:', 'ftp://'];
  const paths = ['', '/', '/watch', '/embed/dQw4w9WgXcQ', '/shorts/dQw4w9WgXcQ', '/live/dQw4w9WgXcQ', '/v/dQw4w9WgXcQ', '/embed/short', '/dQw4w9WgXcQ', '/dQw4w9WgXcQ/',
    '/dQw4w9WgXc', '/videos/123456', '/videos/abc', '/somechannel', '/somechannel/', '/somechannel/clip/FunnyClip-abc', '/ab', '/a_very_long_channel_name_over_25',
    '/Channel_Name', '/track/4uLU6hMCjMI75M1A2tKUQC', '/intl-de/track/4uLU6hMCjMI75M1A2tKUQC', '/embed/album/1A2B3C4D5E6F7G8H9I0J',
    '/intl-pt-BR/playlist/37i9dQZF1DXcBWIGoYBM5M', '/artist/short', '/show/0123456789', '/episode/x', '/user/x', '/playlist', '/FunnyClip_x-y', '//x'];
  const queries = ['', '?v=dQw4w9WgXcQ', '?v=dQw4w9WgXc', '?v=dQw4w9WgXcQ&t=1h2m3s', '?v=dQw4w9WgXcQ&t=90', '?v=dQw4w9WgXcQ&t=90s', '?v=dQw4w9WgXcQ&t=2m',
    '?v=dQw4w9WgXcQ&t=1h', '?v=dQw4w9WgXcQ&t=abc', '?v=dQw4w9WgXcQ&t=0', '?v=dQw4w9WgXcQ&t=99999999999999999999', '?v=dQw4w9WgXcQ&t=99999999999999999999h',
    '?v[]=dQw4w9WgXcQ', '?v%00=dQw4w9WgXcQ', '?v=dQw4w9WgXcQ%0A', '?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG', '?list[]=x', '?list=short', '?list=PLx0sYbCqOb8%0A',
    '?v=bad&list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG', '?v=dQw4w9WgXcQ&v=other', '?t=30&v=dQw4w9WgXcQ', '?v=dQw4w9WgXcQ&t[]=5', '?feature=share', '?si=abc',
    '?v=+dQw4w9WgXcQ', '?v=dQw4w9WgXcQ#t=5', '?t=1h&list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG', '?v= ', '?v=0', '?__proto__[v]=x&v=dQw4w9WgXcQ', '?V=dQw4w9WgXcQ',
    '?v=dQw4w9WgXcQ&t=1h2m3s4', '?v=dQw4w9WgXcQ&t=%31%32', '?v.x=1&v=dQw4w9WgXcQ'];
  const cases = ['spotify:track:4uLU6hMCjMI75M1A2tKUQC', 'spotify:track:4uLU6hMCjMI75M1A2tKUQC\n', 'spotify:artist:short', 'spotify:podcast:4uLU6hMCjMI75M1A2tKUQC',
    'SPOTIFY:track:4uLU6hMCjMI75M1A2tKUQC', '', 'not a url', 'youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ?t=1m5s', 'https:///watch?v=x'];
  for (let i = 0; i < 4000; i++) cases.push(r.pick(schemes) + r.pick(hosts) + r.pick(paths) + r.pick(queries));
  const php = JSON.parse(runPhp(PHP_EACH('(function ($p) use ($c) { return [$p, $p ? oys_embed_src($p) : null, oys_youtube_music($c)]; })(oys_parse_embed($c))'), JSON.stringify(cases))) as string[];
  const node = nodeEach(cases, (c) => {
    const p = parseEmbed(c as string);
    return [p, p ? embedSrc(p as Embed) : null, youtubeMusic(c as string)];
  });
  // Bekannte Grenze: start = PHP_INT_MAX (t=99999999999999999999) schreibt PHP als 9223372036854775807 ins JSON, JavaScript als
  // 9223372036854776000 (2^63). Die iframe-Adresse ist trotzdem genau gleich.
  const phpNorm = php.map((x) => x.replaceAll(':9223372036854775807', ':9223372036854776000'));
  assert.deepEqual(diffs(cases, node, phpNorm), []);
  for (const kind of ['"video"', '"playlist"', '"clip"', '"channel"', '"track"']) assert.ok(php.some((x) => x.includes(kind)), kind);
  assert.ok(php.includes('THROW'), 'v[] makes PHP fail – and Node too');
});

test('a YouTube start time beyond 64 bit becomes the largest number', () => {
  assert.equal(enc(parseEmbed('https://youtube.com/watch?v=dQw4w9WgXcQ&t=99999999999999999999')), enc({ provider: 'youtube', kind: 'video', id: 'dQw4w9WgXcQ', start: 2 ** 63 }));
});

// Prüfung des Pakets: parse_str() in oys_parse_embed() löscht Namen mit mehr als 64 Klammer-Ebenen ganz
// (max_input_nesting_level) – Node hat daraus vorher ein Array gemacht und ist mit einem TypeError abgebrochen
test('embeds with deeply nested query names match PHP', { skip: PHP_SKIP }, () => {
  const V = 'v=dQw4w9WgXcQ';
  const LIST = 'list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG';
  const cases: string[] = [];
  for (const n of [1, 63, 64, 65, 66, 80]) {
    for (const [name, inner] of [['v', '[a]'], ['v', '[]'], ['list', '[x]'], ['t', '[]'], ['v', '[ ]']]) {
      const deep = name + inner.repeat(n) + '=1';
      for (const q of [`${V}&${deep}`, `${deep}&${V}`, `${LIST}&${deep}`, `${V}&t=90&${deep}`, `${deep}&${LIST}&${V}`]) cases.push('https://www.youtube.com/watch?' + q);
    }
  }
  cases.push('https://youtu.be/dQw4w9WgXcQ?t' + '[a]'.repeat(65) + '=5', 'https://youtube.com/watch?v' + '[a]'.repeat(64) + '[b=1&' + LIST);
  const php = JSON.parse(runPhp(PHP_EACH('(function ($p) use ($c) { return [$p, $p ? oys_embed_src($p) : null, oys_youtube_music($c)]; })(oys_parse_embed($c))'), JSON.stringify(cases))) as string[];
  const node = nodeEach(cases, (c) => {
    const p = parseEmbed(c as string);
    return [p, p ? embedSrc(p as Embed) : null, youtubeMusic(c as string)];
  });
  assert.deepEqual(diffs(cases, node, php), []);
  // Beide Seiten liefern hier wirklich Videos, Playlists und Fehler (Array als v)
  assert.ok(php.some((x) => x.includes('"playlist"')) && php.some((x) => x.includes('"video"')) && php.includes('THROW'));
});

// Prüfung des Pakets: zufällige Upload-Namen rund um einen gültigen Kern (Ordner, Leerraum, Nullbyte, \n vor „/“ …)
// und zufällige Kalender-Adressen gegen PHP
test('random upload names and booking addresses match PHP', { skip: PHP_SKIP }, () => {
  const r = rng(4040);
  const noise = ['', '', '', '', '', '', '/', '//', 'a/', '../', ' ', '\t', '\n', '\r', '\0', '\u000b', 'x', 'ä', '/\n', '\n/', '.', '\\', ' '];
  const words = ['avatar', 'thumb', 'img', 'gal', 'music', 'file', 'a', 'Avatar', 'x1', ''];
  const nums = ['5', '5', '5', '6', '05', '0', '00005', '99999999999999999999', '', '5a', '-5'];
  const tails = ['1700000000_abcdef12', '1', 'a_b_c', 'ä', '', 'x.y', 'ABC'];
  const exts = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp3', 'm4a', 'pdf', 'zip', 'vcf', 'PNG', 'p', 'toolong', 'exe', 'png\n', 'png.php'];
  const uploads: unknown[] = [];
  for (let i = 0; i < 6000; i++) {
    // meist gültige Teile, damit auch der annehmende Zweig oft getroffen wird
    const part = (good: string, all: string[]) => (r.chance(0.75) ? good : r.pick(all));
    const name = part('', noise) + part('', noise) + part('thumb', words) + '_' + part('5', nums) + '_' + part('1700000000_abcdef12', tails) + '.'
      + part(r.pick(['png', 'jpg', 'mp3', 'pdf']), exts) + part('', noise) + part('', noise);
    uploads.push([name, r.pick([5, 6, 0]), r.pick([[], IMAGE_EXTS, ['mp3', 'm4a', 'ogg', 'wav'], ['pdf', 'vcf', 'zip']])]);
  }
  const phpUploads = JSON.parse(runPhp(PHP_EACH('oys_valid_upload($c[0], $c[1], $c[2])'), jsonText(uploads))) as string[];
  assert.deepEqual(diffs(uploads, nodeEach(uploads, (c) => validUpload(...(c as [string, number, string[]]))), phpUploads), []);
  assert.ok(phpUploads.filter((x) => x !== 'null').length > 400 && phpUploads.filter((x) => x.includes('\\n')).length > 5, 'valid names, also with a final \\n');

  const schemes = ['', 'http://', 'https://', 'HTTPS://', '//', 'ftp://', ' '];
  const hosts = ['mia.oys.test:8080', 'MIA.OYS.TEST:8080', 'oys.test:8080/mia', 'oys.test:8080/MIA', 'www.oys.test:8080/mia', 'mia.oys.test', 'tom.oys.test:8080', 'oys.test:8080/tom', 'evil.com', ''];
  const paths = ['/kalender', '/KALENDER', '/kalender/', '/kalender//', '/kalender/x', '', '/', '/kalender?x', '/kalender ', '/kalender\t', '/Kalender/'];
  const pages = [{ slug: 'mia', address_mode: 'subdomain' }, { slug: 'mia', address_mode: 'path' }, { slug: 'MIA', address_mode: 'path' }, { slug: 'tom', address_mode: 'PATH' }];
  const bookings: unknown[] = [];
  for (let i = 0; i < 4000; i++) bookings.push([{ url: r.pick(schemes) + r.pick(hosts) + r.pick(paths) + (r.chance(0.1) ? r.pick([' ', '/', '\n']) : '') }, r.pick(pages)]);
  const phpBookings = JSON.parse(runPhp(PHP_EACH('oys_booking_is_internal($c[0], $c[1])'), jsonText(bookings))) as string[];
  assert.deepEqual(diffs(bookings, nodeEach(bookings, (c) => bookingIsInternal((c as unknown[])[0], (c as never[])[1])), phpBookings), []);
  assert.ok(phpBookings.filter((x) => x === 'true').length > 500);
});
