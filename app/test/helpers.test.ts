// Gemeinsame Hilfsfunktionen gegen die echten PHP-Funktionen (PHP-Version, siehe support/phpRef.ts)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cleanUrl, cleanText, prettyUrl, normalizeSlug, initials, isForbiddenSubdomain, isBot, pageUrls, pageUrl, asset, timeAgo, uploadUrl, looksLikeSpam, validateEmail } from '../src/helpers.js';
import { date, time } from '../src/php.js';
import { PHP_SKIP, phpFile, phpRoot } from './support/phpRef.js';

function php(code: string, input: unknown): unknown {
  const script = `require '${phpFile('lib/config.php')}'; date_default_timezone_set(oys_config('timezone', 'Europe/Berlin')); require '${phpFile('blacklist.php')}'; require '${phpFile('lib/helpers.php')}'; require '${phpFile('lib/spam.php')}';`
    + `$in = json_decode(stream_get_contents(STDIN), true); $out = (function ($in) { ${code} })($in); echo json_encode($out);`;
  return JSON.parse(execFileSync('php', ['-r', script], { input: JSON.stringify(input), cwd: phpRoot() }).toString());
}
const each = (fn: string, inputs: unknown[]) => php(`return array_map(function ($v) { return ${fn}; }, $in);`, inputs);

test('URL and text cleaning match PHP', { skip: PHP_SKIP }, () => {
  const urls = ['instagram.com/abc', '  https://Example.com/a b  ', 'max@test.de', '0049 (170) 123-4567', '+49 12', '/kalender', '//evil.com', 'localhost:8080',
    'instagram.com:443/x', 'https://localhost/x', 'münchen.de', 'https://foo_bar.com', 'https://foo', 'mailto:', 'tel:abc', 'ftp://x.de', 'https://', 'a@b', '@foo', 'javascript:alert(1)', 'HTTP://X.DE'];
  assert.deepEqual(urls.map((u) => cleanUrl(u)), each('oys_clean_url($v)', urls));
  assert.deepEqual(urls.map((u) => cleanUrl(u, true)), each('oys_clean_url($v, true)', urls));
  const pretty = ['MAILTO:a@b.de', 'https://www.Insta.com/x/', 'HTTP://WWW.a.de//', 'ftp://a.de/', 'tel:+4912345'];
  assert.deepEqual(pretty.map(prettyUrl), each('oys_pretty_url($v)', pretty));
  const texts = ['a\tb\nc\r\nd\re', 'x\n \n\n\ny', ' nbsp ', '  spaced  ', 'bidi‮text', 'x'.repeat(300)];
  assert.deepEqual(texts.map((t) => cleanText(t)), each('oys_clean_text($v)', texts));
  assert.deepEqual(texts.map((t) => cleanText(t, 255, true)), each('oys_clean_text($v, 255, true)', texts));
});

test('slugs, names and bots match PHP', { skip: PHP_SKIP }, () => {
  const slugs = [' My-Page ', 'ÄBC', 'a_b.c', 'İstanbul', 'x--y'];
  assert.deepEqual(slugs.map(normalizeSlug), each('oys_normalize_slug($v)', slugs));
  const names = ['Mia Müller', '  ', 'ßtraße weg', '🐝 Bee Keeper', 'élan vital', '123 abc'];
  assert.deepEqual(names.map(initials), each('oys_initials($v)', names));
  const subs = ['admin', 'admin1', 'adm1n', 'g00gle', 'therapeutic', 'wwww', 'xxx', '12345', 'xn--abc', 'helpdesk2', 'api2', 'supp0rt', 'shop2',
    'abc', 'my-page', 'a--b', 's3x', 'hello', 'pixel', 'essex', 'classic', 'assassin', 'analytics', 'updates', 'suggestions', '-x', 'x-'];
  assert.deepEqual(subs.map(isForbiddenSubdomain), each('is_forbidden_subdomain($v)', subs));
  const uas = ['', 'Mozilla/5.0 (Windows NT 10.0) Chrome/120', 'Googlebot/2.1', 'curl/8.0', 'Discordbot/2.0', 'WhatsApp/2.23'];
  assert.deepEqual(uas.map(isBot), each('oys_is_bot($v)', uas));
});

test('page URLs, uploads and assets match PHP', { skip: PHP_SKIP }, () => {
  const pages = [{ slug: 'mia', address_mode: 'subdomain' }, { slug: 'tom', address_mode: 'path' }, { slug: 'x', address_mode: null }];
  assert.deepEqual(pages.map(pageUrls), each('oys_page_urls($v)', pages));
  assert.deepEqual(pages.map((p) => pageUrl(p, 'kalender')), each('oys_page_url($v, "kalender")', pages));
  const files = ['file_5_1.pdf', 'a b+c.png', '0', ''];
  assert.deepEqual(files.map(uploadUrl), each('oys_upload_url($v)', files));
  const assets = ['/static/css/page.css', '/static/js/page.js', '/static/missing.css'];
  assert.deepEqual(assets.map(asset), each('oys_asset($v)', assets));
});

test('time ago and spam check match PHP', { skip: PHP_SKIP }, () => {
  const now = time();
  // Abstand zu den Grenzen (60 s, 1 h, 1 Tag): PHP startet unter Last ein paar Sekunden später
  const stamps = [now - 5, now - 61, now - 3570, now - 3600, now - 7200, now - 86400, now - 3 * 86400, now - 30 * 86400].map((t) => date('Y-m-d H:i:s', t));
  assert.deepEqual(stamps.map(timeAgo), each('oys_time_ago($v)', stamps));
  const msgs = ['Hello, I like your page!', 'Buy cheap followers now', 'see http://a.com http://b.com http://c.com', '<a href="x">x</a>', 'Привет как дела это тест сообщения на русском языке'];
  assert.deepEqual(msgs.map(looksLikeSpam), each('oys_looks_like_spam($v)', msgs));
  const mails = ['max@test.de', 'a.b+c@example.co.uk', 'no-at-sign', 'x@y', '"quoted"@example.com', 'a@[127.0.0.1]'];
  assert.deepEqual(mails.map(validateEmail), each('filter_var($v, FILTER_VALIDATE_EMAIL) !== false', mails));
});
