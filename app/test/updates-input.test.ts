// Formular- und Adressfelder für /updates und die Admin-Formulare: Namen wie __proto__ oder constructor sind in PHP
// gewöhnliche Schlüssel. In Node durften sie nie Object.prototype verändern – sonst sah nach einer einzigen Anfrage
// wie /updates?__proto__[page]=3&__proto__[user_id]=3 jeder spätere Besucher Seite 3, und jede Sitzung ohne
// Anmeldung galt als Nutzer 3 (Session.get liest data[key]).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { parseStr, setPhpVar, type PhpArray } from '../src/php.js';
import { Ctx } from '../src/web/ctx.js';
import { PHP_SKIP } from './support/phpRef.js';

const HOSTILE = [
  '__proto__[polluted]=1', 'constructor[prototype][polluted]=2', 'x[__proto__][polluted]=3', '__proto__=plain', 'a[__proto__]=1&a[b]=2',
  'toString=t&valueOf[]=v&hasOwnProperty=h', '__proto__[]=1&__proto__[]=2', 'page=2&__proto__[page]=3&__proto__[user_id]=3', 'x[constructor][prototype][y]=1',
  'page%00x=2&__proto__%00=3', '__proto__%00[page]=4',
];

const polluted = (): string[] => ['polluted', 'page', 'user_id', 'y', 'oys_action'].filter((k) => k in {});

test('hostile field names are ordinary keys and never reach Object.prototype', () => {
  const ours = HOSTILE.map((s) => parseStr(s));
  assert.deepEqual(polluted(), []);
  assert.equal(JSON.stringify(ours[7]), '{"page":"2","__proto__":{"page":"3","user_id":"3"}}');
});

test('hostile field names are ordinary keys like in PHP', { skip: PHP_SKIP }, () => {
  const ours = HOSTILE.map(parseStr);
  const theirs = JSON.parse(execFileSync('php', ['-r', '$in = json_decode(stream_get_contents(STDIN), true); echo json_encode(array_map(function ($s) { parse_str($s, $o); return $o; }, $in));'],
    { input: JSON.stringify(HOSTILE) }).toString()) as unknown[];
  // PHP-Listen (0,1,…) kommen als JSON-Arrays – zum Vergleich in Objekte umwandeln
  const norm = (v: unknown): unknown => (Array.isArray(v) ? Object.fromEntries(v.map((x, i) => [String(i), norm(x)]))
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)])) : v);
  assert.deepEqual(ours.map(norm), theirs.map(norm));
});

test('multipart fields (setPhpVar into ctx.post) cannot change prototypes either', () => {
  const post: PhpArray = {};
  for (const [name, value] of [['__proto__[oys_action]', 'update_delete'], ['__proto__', 'x'], ['a[__proto__][oys_action]', 'y'], ['constructor[prototype][oys_action]', 'z']]) {
    setPhpVar(post, name, value);
  }
  assert.deepEqual(polluted(), []);
  assert.equal(Object.getPrototypeOf(post), Object.prototype);
  assert.deepEqual(Object.keys(post), ['__proto__', 'a', 'constructor']);
  assert.equal(post.__proto__, 'x');
});

test('a crafted /updates address does not change the next request', () => {
  const ctx = (url: string): Ctx => new Ctx({ method: 'GET', url, headers: { host: 'oys.test:8080' }, peer: '127.0.0.1' });
  const evil = ctx('/updates?__proto__%5Bpage%5D=3&__proto__%5Buser_id%5D=3&constructor%5Bprototype%5D%5Bpage%5D=4');
  assert.deepEqual(Object.keys(evil.get), ['__proto__', 'constructor']);
  const next = ctx('/updates');
  assert.equal(next.get.page, undefined);
  assert.deepEqual(polluted(), []);
  // Was die Seite selbst liest, bleibt wie in PHP: ?page[]=… ist ein Array, ?__proto__=… ein gewöhnliches Feld
  assert.deepEqual({ ...ctx('/updates?page[]=2').get.page as object }, { 0: '2' });
  assert.equal(ctx('/updates?__proto__=1').get.__proto__, '1');
});
