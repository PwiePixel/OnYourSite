// Sicherheit: Namen wie __proto__[x] in Adresse oder Formular dürfen nie Object.prototype verändern
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStr, setPhpVar, type PhpArray } from '../src/php.js';
import { makeTestCtx } from '../src/web/ctx.js';

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
