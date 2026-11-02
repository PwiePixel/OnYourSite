// Listen und Konstanten des Inhalts-Pakets gegen PHP (PHP-Version, siehe support/phpRef.ts): Designs, Anordnungen,
// Schriften, Plattformen (mit SVG), Blocktypen, Symbole, Vorgaben und die Adressen zum Teilen – jeweils als ganzes JSON
// verglichen; dazu feste Werte ohne PHP
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THEME, themes, themeKey, fontChoices, layouts, layoutKey } from '../src/content/themes.js';
import { brands, bxIcons, uiIcon } from '../src/content/social.js';
import { blockTypes, blockIsClickable, EFFECTS, PROTECTIONS, LINK_PASSWORD_MIN, IMAGE_EXTS } from '../src/content/blocks.js';
import { defaultSettings } from '../src/content/pages.js';
import { OG_WIDTH, OG_HEIGHT, shareLinks, ogFont, ogSupported } from '../src/content/share.js';
import { jsonDecode } from '../src/content/util.js';
import { runPhp, enc, FLAGS, PHP_EACH, nodeEach, diffs, jsonText, Raw, O, rng } from './modelHarness.js';
import { PHP_SKIP, fromPhpTree } from './support/phpRef.js';

test('registries have their sizes; the JSON decoder keeps -0, big numbers, key order and the prototype', () => {
  // 30 Designs, 13 Anordnungen, 27 Plattformen, 12 Blocktypen, 64 Boxicons
  assert.deepEqual([Object.keys(themes()).length, Object.keys(layouts()).length, Object.keys(brands()).length, Object.keys(blockTypes()).length, bxIcons().length], [30, 13, 27, 12, 64]);
  assert.ok(Object.is(jsonDecode('-0.0'), -0) && Object.is(jsonDecode('-0'), 0));
  assert.equal(jsonDecode('12345678901234567890'), 12345678901234567890);
  // Ein einzelnes rohes Ersatzzeichen wäre in PHP ungültiges UTF-8
  assert.equal(jsonDecode('"\ud83d"'), null);
  assert.equal(jsonDecode('["\ude00x"]'), null);
  // Objekte mit Zahlen-Schlüsseln behalten ihre Reihenfolge auch für Object.keys
  assert.deepEqual(Object.keys(jsonDecode('{"b":1,"5":2,"a":3}') as object), ['b', '5', 'a']);
  // Kein Prototyp wird verändert
  const proto = jsonDecode('{"__proto__":{"polluted":1}}') as Record<string, unknown>;
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.deepEqual(Object.keys(proto), ['__proto__']);
  assert.deepEqual(jsonDecode(jsonText(new O([['z', 1], ['10', 2], ['2', 3]]))), jsonDecode('{"z":1,"10":2,"2":3}'));
  // Ein Text aus Buffer.toString() hätte das ungültige Byte still ersetzt
  assert.deepEqual(jsonDecode(Buffer.from('7b2261223a22ff227d', 'hex').toString('utf8')), { a: '�' });
  assert.equal(jsonDecode(Buffer.from('7b2261223a22ff227d', 'hex')), null);
});

test('registries and constants are identical to PHP', { skip: PHP_SKIP }, () => {
  const php = JSON.parse(runPhp(`echo json_encode(array_map(fn($v) => json_encode($v, ${FLAGS}), [
    OYS_DEFAULT_THEME, oys_themes(), oys_font_choices(), oys_layouts(), oys_brands(), oys_block_types(), OYS_EFFECTS, OYS_PROTECTIONS,
    OYS_LINK_PASSWORD_MIN, OYS_IMAGE_EXTS, oys_bx_icons(), oys_default_settings(), OYS_OG_WIDTH, OYS_OG_HEIGHT,
    oys_og_font(true), oys_og_font(false), oys_og_supported(),
  ]));`, 'null')) as string[];
  // Die Schriften liegen in PHP unter dem eigenen Code-Ordner – umgeschrieben auf den dieses Repositorys
  php.forEach((v, i) => (php[i] = fromPhpTree(v)));
  const node = [DEFAULT_THEME, themes(), fontChoices(), layouts(), brands(), blockTypes(), EFFECTS, PROTECTIONS,
    LINK_PASSWORD_MIN, IMAGE_EXTS, bxIcons(), defaultSettings(), OG_WIDTH, OG_HEIGHT, ogFont(true), ogFont(false), ogSupported()].map(enc);
  assert.deepEqual(node, php);
});

test('registries cannot be changed by callers', () => {
  assert.throws(() => {
    (themes()['deep-dark'] as { name: string }).name = 'x';
  });
  assert.throws(() => {
    (brands().instagram.domains as string[]).push('evil.com');
  });
  assert.equal(themes()['deep-dark'].name, 'Deep Dark');
});

const KEYS = ['deep-dark', 'minimal', 'galaxy', 'sakura', 'DEEP-DARK', 'Galaxy', '', ' glass', 'glass ', 'trs', 'buttons', 'cards', 'stack', 'Stack', 'bento ',
  'constructor', '__proto__', 'toString', 'hasOwnProperty', 'length', 'inter', 'lora', 'caveat', '0', 'Array'];

test('theme, layout and click keys match PHP for any input', { skip: PHP_SKIP }, () => {
  const cases = [...KEYS, 0, 1, 1.5, true, false, null, [], ['glass'], { x: 1 }, new Raw('-0'), new Raw('1.0')];
  const text = jsonText(cases);
  const php = JSON.parse(runPhp(PHP_EACH('[oys_theme_key($c), oys_layout_key($c), is_string($c) ? oys_block_is_clickable($c) : null, is_string($c) ? array_key_exists($c, oys_font_choices()) : null]'), text)) as string[];
  const node = nodeEach(jsonDecode(text) as unknown[], (c) => [themeKey(c), layoutKey(c), typeof c === 'string' ? blockIsClickable(c) : null,
    typeof c === 'string' ? Object.hasOwn(fontChoices(), c) : null]);
  assert.deepEqual(diffs(cases, node, php), []);
});

test('UI icons match PHP, also with unknown names and odd classes', { skip: PHP_SKIP }, () => {
  const names = ['arrow', 'external', 'lock', 'link', 'calendar', 'download', 'file', 'mail', 'phone', 'play', 'volume', 'mute', 'close', 'left', 'right',
    'send', 'check', 'clock', 'eye-off', 'image', 'user', 'sparkle', 'share', 'nope', '', 'constructor', '__proto__', 'toString', 'LINK'];
  const classes = ['oys-ico', 'oys-ico on', '"><script>alert(1)</script>', "a'b&c", ''];
  const cases = names.flatMap((n) => classes.map((c) => [n, c]));
  const text = jsonText(cases);
  const php = JSON.parse(runPhp(PHP_EACH('[oys_ui_icon($c[0]), oys_ui_icon($c[0], $c[1])]'), text)) as string[];
  const node = nodeEach(cases, (c) => [uiIcon((c as string[])[0]), uiIcon((c as string[])[0], (c as string[])[1])]);
  assert.deepEqual(diffs(cases, node, php), []);
});

test('share links match PHP', { skip: PHP_SKIP }, () => {
  const urls = ['https://mia.oys.test:8080', 'http://oys.test:8080/tom', 'https://x.de/a b?c=d&e=f#g', 'ä/ö', "a'b(c)*!~", ''];
  const titles = ['', 'Mia', 'Mia & Tom', '🐝 Bee', '0', ' ', 'a+b=c', '"quoted"'];
  const cases = urls.flatMap((u) => titles.map((t) => [u, t]));
  const text = jsonText(cases);
  const php = JSON.parse(runPhp(PHP_EACH('oys_share_links($c[0], $c[1])'), text)) as string[];
  const node = nodeEach(cases, (c) => shareLinks((c as string[])[0], (c as string[])[1]));
  assert.deepEqual(diffs(cases, node, php), []);
});

test('the PHP-style JSON decoder reads JSON exactly like json_decode(…, true)', { skip: PHP_SKIP }, () => {
  const texts = ['{}', '[]', '{"0":"a","1":"b"}', '{"1":"a","0":"b"}', '{"b":1,"5":2}', '{"a":1,"b":2,"a":3}', '{"5":1,"a":2,"5":3}', '{"":1}',
    '{"__proto__":{"x":1}}', '{"constructor":1}', '"\\ud800"', '"\\ud83d\\ude00"', '"\\udc00\\ud800"', '"\\ud800\\u0041"', '-0', '-0.0', '1.0', '1e2',
    '12345678901234567890', ' [1] ', '\t\n\r[1]', '[1,]', '01', '"\\u0000"', '{"\\u0000a":1}', '"\u007f"', 'nul', 'true', 'false', 'null', '"a" x', '',
    ' ', '[1 2]', '{"a" 1}', '{"a":}', '{a:1}', "'a'", '"\\x"', '"\\u12"', '"tab\there"', '" "', '[[[]]]', '{"x":{},"y":[],"z":{"0":1}}',
    '{"4294967294":1,"4294967295":2,"a":3,"3":4}', '{"-1":1,"0":2}', '{"01":1,"1":2}', '[' + '['.repeat(509) + ']'.repeat(509) + ']',
    '['.repeat(511) + ']'.repeat(511), '['.repeat(512) + ']'.repeat(512), '{"a":'.repeat(511) + '1' + '}'.repeat(511), '{"a":'.repeat(512) + '1' + '}'.repeat(512),
    '"😀 raw"', '1E400', '-1E400', '0.1e1', '-', '.5', '+1', '"\\/"', '"a\\"b"', '{"x":1}{', '[true,false,null,1.5,"s"]',
    '{"items":{"2":{"p":"x"},"0":{"p":"y"}}}', '[{"a":1},{"b":[]}]', '﻿{}'];
  const php = JSON.parse(runPhp(`$out = []; foreach ($in as $t) { $v = json_decode($t, true); $out[] = ($v === null && json_last_error() !== JSON_ERROR_NONE) ? 'ERROR' : json_encode($v, ${FLAGS} | JSON_PARTIAL_OUTPUT_ON_ERROR); } echo json_encode($out);`, JSON.stringify(texts))) as string[];
  const node = texts.map((t) => {
    const v = jsonDecode(t);
    if (v === null && t.trim() !== 'null') return 'ERROR';
    return Number.isFinite(v as number) || typeof v !== 'number' ? enc(v) : '0';
  });
  // json_encode schreibt Kommazahlen anders (-0, 1.2345678901234567e+19) – JavaScript kennt keinen Unterschied
  // zwischen int und float. Gelesen wird richtig, das prüfen die Zeilen danach.
  const FLOAT_OUTPUT = ['-0.0', '12345678901234567890'];
  assert.deepEqual(diffs(texts, node, php).filter((d) => !FLOAT_OUTPUT.includes(d.input)), []);
});

// Prüfung des Pakets: der Editor schickt JSON als Bytes. PHP lehnt ungültiges UTF-8 ab (überall im Text, auch
// überlange Formen, Ersatzzeichen und Werte über U+10FFFF); jsonDecode(Bytes) muss das genauso tun
test('JSON as raw bytes is rejected for invalid UTF-8 exactly like json_decode', { skip: PHP_SKIP }, () => {
  const r = rng(2026);
  const pieces = [[0x61], [0xc3, 0xa9], [0xe2, 0x82, 0xac], [0xf0, 0x9f, 0x98, 0x80], [0xff], [0xc3], [0xa9], [0xc0, 0x80], [0xe0, 0x80, 0x80],
    [0xed, 0xa0, 0x80], [0xed, 0x9f, 0xbf], [0xf4, 0x8f, 0xbf, 0xbf], [0xf4, 0x90, 0x80, 0x80], [0xf5, 0x80, 0x80, 0x80], [0xef, 0xbb, 0xbf], [0x5c, 0x6e], [0x20], [0x00]];
  const cases: Buffer[] = [];
  for (let i = 0; i < 3000; i++) {
    const body: number[] = [];
    for (let k = r.next(5); k > 0; k--) body.push(...r.pick(pieces));
    const bytes = Buffer.from(body);
    // als Wert, als Schlüssel, außerhalb eines Textes oder als ganzer Text
    const k = r.next(4);
    cases.push(k === 0 ? Buffer.concat([Buffer.from('{"a":"'), bytes, Buffer.from('"}')]) : k === 1 ? Buffer.concat([Buffer.from('{"'), bytes, Buffer.from('":1}')])
      : k === 2 ? Buffer.concat([Buffer.from('['), bytes, Buffer.from(']')]) : bytes);
  }
  cases.push(Buffer.from('﻿{}'), Buffer.from('{"a":"é"}'), Buffer.from('{}'));
  const php = JSON.parse(runPhp(`$out = []; foreach ($in as $b) { $v = json_decode(base64_decode($b), true); $out[] = ($v === null && json_last_error() !== JSON_ERROR_NONE) ? 'ERROR' : json_encode($v, ${FLAGS}); } echo json_encode($out);`,
    JSON.stringify(cases.map((b) => b.toString('base64'))))) as string[];
  const node = cases.map((b) => {
    const v = jsonDecode(b);
    return v === null && b.toString('latin1').trim() !== 'null' ? 'ERROR' : enc(v);
  });
  assert.deepEqual(diffs(cases.map((b) => b.toString('hex')), node, php), []);
  assert.ok(php.filter((x) => x === 'ERROR').length > 500 && php.filter((x) => x !== 'ERROR').length > 300);
});
