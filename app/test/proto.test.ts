// Sicherheit: Namen wie __proto__[x] in Adresse oder Formular dürfen nie Object.prototype verändern
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStr, setPhpVar, type PhpArray } from '../src/php.js';
import { makeTestCtx } from '../src/web/ctx.js';
import { phpMultipart } from '../src/web/multipart.js';
import { readBody } from '../src/server.js';
import { jsonDecode, arrayReplace } from '../src/content/util.js';
import { phpJsonDecode as hcJsonDecode } from '../src/honeycombs/util.js';
import { hcSettingsFrom, hcDefaults } from '../src/honeycombs/honeycombs.js';
import { PhpArr, jsonField, phpJsonDecode as botJsonDecode } from '../src/community/json.js';
import { pageSettings, settingsNormalize } from '../src/content/pages.js';
import { blockNormalize } from '../src/content/blocks.js';
import { registerOld } from '../src/app/auth.js';

test('query and form names cannot pollute Object.prototype', () => {
  const inputs = ['__proto__[is_admin]=1', '__proto__[x][y]=1', 'a[__proto__][is_admin]=1', 'constructor[prototype][is_admin]=1', '__proto__=1', 'a[b][__proto__][c]=1'];
  for (const q of inputs) {
    parseStr(q);
    makeTestCtx({ url: '/x?' + q });
    const post: PhpArray = {};
    setPhpVar(post, q.split('=')[0], '1');
    assert.equal(({} as Record<string, unknown>).is_admin, undefined, q);
    assert.equal(({} as Record<string, unknown>).x, undefined, q);
    assert.equal(({} as Record<string, unknown>).c, undefined, q);
  }
  // PHP behält __proto__ als normalen Schlüssel
  const r = parseStr('__proto__[a]=1');
  assert.ok(Object.hasOwn(r, '__proto__'));
  assert.deepEqual(Object.keys(r), ['__proto__']);
});

// ---------------------------------------------------------------- alle Stellen, an denen Eingaben zu Schlüsseln werden

const PROTO_NAMES = Object.getOwnPropertyNames(Object.prototype).sort();
// Nichts darf auf Object.prototype landen – weder neue Namen noch geänderte Werte
function assertClean(where: string): void {
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), PROTO_NAMES, where);
  for (const k of ['polluted', 'is_admin', 'x', 'y', 'url', 'type', 'custom_css', 'subdomain', 'enabled', 'daily']) {
    assert.equal(({} as Record<string, unknown>)[k], undefined, `${where}: Object.prototype.${k}`);
  }
  assert.equal(typeof ({} as { toString: unknown }).toString, 'function', where);
}

const HOSTILE_NAMES = ['__proto__[polluted]', '__proto__', 'constructor[prototype][polluted]', 'a[__proto__][polluted]', 'prototype[polluted]',
  'x[constructor][prototype][polluted]', '__proto__[]', 'toString', 'hasOwnProperty[x]'];

test('multipart field and file names cannot pollute Object.prototype', async () => {
  const parts = HOSTILE_NAMES.map((n) => `--b\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n1\r\n`).join('')
    + HOSTILE_NAMES.map((n) => `--b\r\nContent-Disposition: form-data; name="${n}"; filename="x.txt"\r\nContent-Type: text/plain\r\n\r\nfile\r\n`).join('') + '--b--\r\n';
  const form = phpMultipart('multipart/form-data; boundary=b', Buffer.from(parts), 16 * 1024 * 1024);
  assert.ok(form);
  assertClean('phpMultipart');
  // PHP behält die Namen als gewöhnliche Schlüssel
  assert.ok(Object.hasOwn(form.post, '__proto__') && Object.hasOwn(form.post, 'constructor') && Object.hasOwn(form.post, 'toString'));
  assert.equal(Object.getPrototypeOf(form.post), Object.prototype);
  assert.ok(Object.hasOwn(form.files, '__proto__'));
  // Über den Server-Weg (readBody) ebenso, auch urlencoded
  const ctx = makeTestCtx({ method: 'POST', url: '/x' });
  await readBody(ctx, 'multipart/form-data; boundary=b', Buffer.from(parts));
  await readBody(makeTestCtx({ method: 'POST', url: '/x' }), 'application/x-www-form-urlencoded', Buffer.from(HOSTILE_NAMES.map((n) => n + '=1').join('&')));
  assertClean('readBody');
  assert.equal(ctx.p('constructor'), 'Array');
});

test('cookies named like Object.prototype members are ordinary cookies', () => {
  const ctx = makeTestCtx({ url: '/', headers: { cookie: '__proto__=a; constructor=b; toString=c; hasOwnProperty=d; prototype=e; oys=f; constructor=g' } });
  assertClean('cookies');
  // Wie PHP: jeder Name ist ein Cookie, bei doppelten gilt der erste
  assert.deepEqual([ctx.cookie('__proto__'), ctx.cookie('constructor'), ctx.cookie('toString'), ctx.cookie('hasOwnProperty'), ctx.cookie('prototype'), ctx.cookie('oys')],
    ['a', 'b', 'c', 'd', 'e', 'f']);
  // Ohne Cookie: nie etwas aus dem Prototyp
  const none = makeTestCtx({ url: '/' });
  assert.deepEqual([none.cookie('constructor'), none.cookie('toString'), none.cookie('__proto__')], [undefined, undefined, undefined]);
});

test('JSON bodies keep __proto__ and constructor as ordinary keys in every decoder', () => {
  const json = '{"__proto__":{"polluted":1,"is_admin":true},"constructor":{"prototype":{"polluted":2}},"a":[{"__proto__":{"x":1}}],"prototype":{"y":1}}';
  for (const [name, value] of [['jsonDecode', jsonDecode(json)], ['jsonDecode (bytes)', jsonDecode(Buffer.from(json))], ['honeycombs', hcJsonDecode(json)],
    ['honeycombs (numbers)', hcJsonDecode(json, true)]] as const) {
    assertClean(name);
    const o = value as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(o), Object.prototype, name);
    assert.ok(Object.hasOwn(o, '__proto__') && Object.hasOwn(o, 'constructor'), name);
    assert.equal((o as { is_admin?: unknown }).is_admin, undefined, name);
  }
  // Bot-Schnittstelle: eigene Map statt Objekt
  const bot = botJsonDecode(json);
  assert.ok(bot instanceof PhpArr);
  assert.ok(jsonField(bot, '__proto__') instanceof PhpArr);
  assert.equal(jsonField(bot, 'polluted'), undefined);
  assertClean('community json');
});

test('page settings, blocks, honeycomb settings and the register form ignore inherited names', async () => {
  // Gespeicherte Einstellungen mit __proto__: nur eigene Schlüssel zählen
  const stored = '{"__proto__":{"custom_css":"body{color:red}","hide_branding":true},"constructor":{"prototype":{"polluted":1}},'
    + '"entrance":{"__proto__":{"enabled":true}},"seo":{"constructor":{"title":"x"}}}';
  const s = pageSettings({ settings: stored });
  assertClean('pageSettings');
  assert.equal(s.custom_css, '');
  assert.equal(s.hide_branding, false);
  assert.equal(s.entrance.enabled, false);
  // array_replace() mit __proto__: ein Eintrag wie jeder andere
  const merged = arrayReplace({ a: 1 }, jsonDecode('{"__proto__":{"polluted":1},"a":2}') as Record<string, unknown>) as Record<string, unknown>;
  assertClean('arrayReplace');
  assert.deepEqual(Object.keys(merged), ['a', '__proto__']);
  // Aus dem Editor: unbekannte Namen fallen weg, geerbte werden nie gelesen
  const normalized = settingsNormalize(jsonDecode('{"__proto__":{"custom_css":"x","hide_branding":1},"accent":"#112233","entrance":{"__proto__":{"enabled":1}}}'),
    5, true, jsonDecode('{"__proto__":{"hide_branding":true}}'));
  assertClean('settingsNormalize');
  assert.deepEqual([normalized.custom_css, normalized.hide_branding, normalized.entrance.enabled, normalized.accent], ['', false, false, '#112233']);
  assert.ok(!Object.hasOwn(normalized, '__proto__'));
  // Block mit __proto__ im Typ oder in den Daten
  const evilType = await blockNormalize(jsonDecode('{"__proto__":{"type":"link"},"data":{"url":"https://a.de"}}') as Record<string, unknown>, 5);
  assert.equal(evilType, null);
  for (const t of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(await blockNormalize({ type: t, data: {} }, 5), null, t);
  }
  const link = await blockNormalize(jsonDecode('{"type":"link","data":{"__proto__":{"url":"https://evil.example"},"title":"T"}}') as Record<string, unknown>, 5);
  assertClean('blockNormalize');
  assert.equal(link?.data.url, '');
  // Honigwaben-Einstellungen aus oys_meta
  const hc = hcSettingsFrom('{"__proto__":{"daily":99},"constructor":{"prototype":{"daily":98}}}');
  assertClean('hcSettingsFrom');
  assert.deepEqual(hc, hcSettingsFrom(''));
  assert.deepEqual(Object.keys(hc), Object.keys(hcDefaults()));
  // Registrierung: alte Eingaben aus der Sitzung (JSON) mit __proto__
  const old = registerOld(JSON.parse('{"__proto__":{"subdomain":"evil"},"email":"a@b.de"}'), {});
  assertClean('registerOld');
  assert.equal(old.subdomain, undefined);
  assert.equal(old.email, 'a@b.de');
});
