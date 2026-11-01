// Social-Plattformen gegen PHP: Erkennung der Plattform, Profil-Adressen, Symbole (viele und zufällige Eingaben)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brands, brandSvg, detectBrand, socialUrl, iconHtml, iconUsesBoxicons } from '../src/content/social.js';
import { cleanIcon } from '../src/content/blocks.js';
import { runPhp, PHP_EACH, nodeEach, diffs, jsonText, rng } from './modelHarness.js';

const SCHEMES = ['https://', 'http://', 'HTTPS://', 'Http://', '', '//', 'mailto:', 'MAILTO:', 'tel:', 'TEL:', 'ftp://', 'javascript:'];
const PREFIXES = ['', 'www.', 'm.', 'mobile.', 'open.', 'music.', 'vm.', 'WWW.', 'sub.', 'www.www.'];
const HOSTS = [...Object.values(brands()).flatMap((b) => b.domains), 'evil-instagram.com', 'instagram.com.evil.com', 'xinstagram.com', 'mastodon.example',
  'my-mastodon.de', 'MASTODON.social', 'INSTAGRAM.COM', 'ïnstagram.com', 'music.apple.com', 'apple.com', 'localhost', 'x', '', 'a@b.de', 'user:pw@instagram.com',
  'instagram.com:8080', '[::1]'];
const PATHS = ['', '/', '/user', '/@name', '/@Name_1', '/@name/', '/@na-me', '/x?y=1', '/@name\n', '/@ä', '#frag', '?q=1', '/@name?x', '/@'];

function urls(r: ReturnType<typeof rng>, n: number): string[] {
  const out = ['', ' ', 'instagram', 'mailto:', 'mailto:x@y.de', 'tel:+4912345', 'https://mastodon.social/@pixel', 'https://example.mastodon.host/@a_b',
    'https://foo.de/@user', 'HTTPS://MASTODON.SOCIAL/@PIXEL', 'https://music.apple.com/de/album/x', 'https://open.spotify.com/artist/x', 'https://vm.tiktok.com/x',
    'https://m.youtube.com/@x', 'https://youtu.be/abc', 'https://wa.me/49123', 'https://x.com', 'https://twitter.com/x', 'https://t.me/x', 'http://[::1]/@x'];
  for (let i = 0; i < n; i++) out.push(r.pick(SCHEMES) + r.pick(PREFIXES) + r.pick(HOSTS) + r.pick(PATHS));
  return out;
}

test('brand detection matches PHP', () => {
  const cases = urls(rng(11), 1500);
  const php = JSON.parse(runPhp(PHP_EACH('oys_detect_brand($c)'), jsonText(cases))) as string[];
  assert.deepEqual(diffs(cases, nodeEach(cases, (c) => detectBrand(c as string)), php), []);
  assert.ok(new Set(php).size > 25 && !php.includes('THROW'), 'the cases cover many platforms');
});

const VALUES = ['', '  ', 'user', '@user', '@@user', ' @user ', 'user.name', 'user name', 'ü-ser', 'Üser_1', 'https://instagram.com/x', 'HTTP://x.de', 'instagram.com/x',
  'x.com', 'x.co', 'ab.c', 'ab.cd/', 'ab.cd/x', 'éé.com', 'a@b.de', 'a.b+c@example.co.uk', 'not-an-email', '+49 170 123', '0049 170 1234567', '00 12', '0012',
  '00', 'abc', '@user@mastodon.social', 'user@mstdn.social', 'user.x@sub.host.io', '@a@b', 'tel:+49123', 'mailto:x@y.de', 'javascript:alert(1)', "o'brien",
  'a/b', '%20', '🐝bee', 'x'.repeat(250), 'name\n', '\tname', 'a{u}b', '{u}', 'user?x=1', 'user#x', 'x&y', 'Ω', '٣', 'a b'];
const PLATFORMS = [...Object.keys(brands()), 'unknown', '', 'Instagram', 'constructor', '__proto__', 'toString'];

test('profile addresses match PHP for every platform', () => {
  const cases = PLATFORMS.flatMap((p) => VALUES.map((v) => [p, v]));
  const php = JSON.parse(runPhp(PHP_EACH('oys_social_url($c[0], $c[1])'), jsonText(cases))) as string[];
  assert.deepEqual(diffs(cases, nodeEach(cases, (c) => socialUrl((c as string[])[0], (c as string[])[1])), php), []);
  assert.ok(new Set(php).size > 500, 'the cases produce many different addresses');
});

test('random profile addresses match PHP', () => {
  const r = rng(23);
  const parts = ['@', 'user', '.', 'com', 'de', '/', ' ', 'https://', 'mailto:', 'tel:', '+', '00', '49', '1', 'mastodon.social', 'ä', '🐝', '_', '-', '{u}', 'x', 'é', '\n'];
  const cases: string[][] = [];
  for (let i = 0; i < 2000; i++) {
    let v = '';
    for (let k = 1 + r.next(6); k > 0; k--) v += r.pick(parts);
    cases.push([r.pick(PLATFORMS), v]);
  }
  const php = JSON.parse(runPhp(PHP_EACH('oys_social_url($c[0], $c[1])'), jsonText(cases))) as string[];
  assert.deepEqual(diffs(cases, nodeEach(cases, (c) => socialUrl((c as string[])[0], (c as string[])[1])), php), []);
});

const ICONS = ['', 'auto', 'none', ' auto ', 'brand:instagram', 'brand:', 'brand:nope', 'brand:constructor', 'brand:__proto__', 'brand:email', ' brand:x ',
  'bx bx-music', 'bxl bxl-github', 'bxs bxs-heart', 'bxl bx-x', 'bx bx-Music', 'bx bx-music ', ' bx bx-music', 'bx  bx-music', 'bx bx-mu"sic', 'bx bx-a<b',
  'fa fa-x', 'bx', 'bx ', 'bxx bx-a', 'bx bx-', 'bx bx-a-1-b', 'BX BX-A', 'bx bx-music\n', 'brand:Instagram', 'auto ', 'None'];

test('link icons match PHP', () => {
  const linkUrls = ['', 'tel:+49', 'TEL:+49', 'Tel:0', ' tel:1', 'https://instagram.com/x', 'mailto:a@b.de', 'https://unknown.example', 'https://mastodon.example/@me', 'x.com/y'];
  const cases = ICONS.flatMap((i) => linkUrls.map((u) => [i, u]));
  const php = JSON.parse(runPhp(PHP_EACH('[oys_icon_html($c[0], $c[1]), oys_icon_html($c[0]), oys_icon_uses_boxicons($c[0]), oys_clean_icon($c[0])]'), jsonText(cases))) as string[];
  const node = nodeEach(cases, (c) => {
    const [i, u] = c as string[];
    return [iconHtml(i, u), iconHtml(i), iconUsesBoxicons(i), cleanIcon(i)];
  });
  assert.deepEqual(diffs(cases, node, php), []);
});

test('brand icons and the cleaning of icon values match PHP', () => {
  const keys = [...Object.keys(brands()), 'nope', '', 'constructor', '__proto__', 'Instagram'];
  const cases = keys.flatMap((k) => [[k, 'oys-ico'], [k, 'x"y'], [k, '']]);
  const php = JSON.parse(runPhp(PHP_EACH('oys_brand_svg($c[0], $c[1])'), jsonText(cases))) as string[];
  assert.deepEqual(diffs(cases, nodeEach(cases, (c) => brandSvg((c as string[])[0], (c as string[])[1])), php), []);
  // oys_clean_icon() bekommt auch Nicht-Texte
  const odd = [null, 5, true, ['bx bx-a'], { a: 1 }, 1.5, 'bx bx-a'];
  const phpOdd = JSON.parse(runPhp(PHP_EACH('oys_clean_icon($c)'), jsonText(odd))) as string[];
  assert.deepEqual(diffs(odd, nodeEach(odd, cleanIcon), phpOdd), []);
});

// Prüfung des Pakets: [^\p{L}\p{N}._\-] kennt in PHP (PCRE2 10.42) die Zeichen bis Unicode 14, in JavaScript bis
// Unicode 16. Verglichen wird jeder Codepoint (in Stücken, 'x' davor und danach: weder trim() noch die Domain-Erkennung
// greifen), auch neue Schriften wie Kawi, Garay oder CJK-Erweiterung H.
test('profile handles keep exactly the letters and digits PHP keeps (all code points)', () => {
  const cases: string[][] = [];
  let chunk = '';
  for (let c = 0; c <= 0x10ffff; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue;
    chunk += String.fromCodePoint(c);
    if (chunk.length >= 4000 || c === 0x10ffff) {
      cases.push(['github', 'x' + chunk + 'x']);
      chunk = '';
    }
  }
  const php = JSON.parse(runPhp(PHP_EACH('oys_social_url($c[0], $c[1])'), jsonText(cases))) as string[];
  const node = nodeEach(cases, (c) => socialUrl((c as string[])[0], (c as string[])[1]));
  assert.deepEqual(diffs(cases.map((c) => c[1].slice(0, 12)), node, php), []);
  // Stichproben aus Unicode 15/16: PHP entfernt sie
  const fresh = [['instagram', 'mia\u{31350}'], ['instagram', '\u{1E030}'], ['tiktok', 'x\u{A7CB}y'], ['github', '\u{11F50}\u{11F51}']];
  assert.deepEqual(fresh.map(([p, v]) => socialUrl(p, v)), ['https://instagram.com/mia', '', 'https://www.tiktok.com/@xy', '']);
});
