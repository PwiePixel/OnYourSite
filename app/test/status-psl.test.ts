// Statusseiten: registrierbare Domain nach der Public Suffix List (psl.ts) – mit der echten Liste aus app/data und mit
// einer kleinen eigenen Liste für die Regeln (Platzhalter, Ausnahmen, Unicode-Regeln).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PSL_FILE, registrableDomain, setPslForTests } from '../src/status/psl.js';

after(() => setPslForTests(null));

test('the real list: subdomains of one site count together, hosting users stay apart', () => {
  setPslForTests(null);
  const text = readFileSync(PSL_FILE, 'utf8');
  assert.ok(text.includes('===BEGIN PRIVATE DOMAINS==='), 'the list includes the private section');
  const cases: Array<[string, string]> = [
    ['a.victim.com', 'victim.com'],
    ['b.victim.com', 'victim.com'],
    ['victim.com', 'victim.com'],
    ['deep.a.victim.com', 'victim.com'],
    ['A.Victim.COM.', 'victim.com'],
    ['alice.github.io', 'alice.github.io'],
    ['bob.github.io', 'bob.github.io'],
    ['x.alice.github.io', 'alice.github.io'],
    ['github.io', 'github.io'],
    ['x.co.uk', 'x.co.uk'],
    ['www.x.co.uk', 'x.co.uk'],
    ['co.uk', 'co.uk'],
    ['shop.example.com.au', 'example.com.au'],
    ['my-app.vercel.app', 'my-app.vercel.app'],
    ['foo.blogspot.com', 'foo.blogspot.com'],
    ['8.8.8.8', '8.8.8.8'],
    ['2606:4700::1111', '2606:4700::1111'],
    ['[2606:4700::1111]', '2606:4700::1111'],
    ['bücher.de', 'xn--bcher-kva.de'],
    ['shop.xn--bcher-kva.de', 'xn--bcher-kva.de'],
    ['www.пример.рф', 'xn--e1afmkfd.xn--p1ai'],
    ['www.xn--e1afmkfd.xn--p1ai', 'xn--e1afmkfd.xn--p1ai'],
    ['a.b.unknowntld', 'b.unknowntld'],
    ['localhost', 'localhost'],
  ];
  for (const [host, want] of cases) assert.equal(registrableDomain(host), want, host);
  assert.notEqual(registrableDomain('alice.github.io'), registrableDomain('bob.github.io'));
});

test('rules: longest match, wildcards, exceptions, Unicode rules and comments', () => {
  setPslForTests([
    '// comment line',
    'com',
    'uk',
    'co.uk',
    '*.ck',
    '!www.ck',
    '*.kawasaki.jp',
    '!city.kawasaki.jp',
    'jp',
    'рф',
    'blogspot.com   // trailing comment is not part of the rule',
    '',
  ].join('\n'));
  const cases: Array<[string, string]> = [
    ['a.b.ck', 'a.b.ck'],
    ['b.ck', 'b.ck'],
    ['www.ck', 'www.ck'],
    ['x.www.ck', 'www.ck'],
    ['a.b.kawasaki.jp', 'a.b.kawasaki.jp'],
    ['city.kawasaki.jp', 'city.kawasaki.jp'],
    ['a.city.kawasaki.jp', 'city.kawasaki.jp'],
    ['x.co.uk', 'x.co.uk'],
    ['x.uk', 'x.uk'],
    ['a.x.com', 'x.com'],
    ['me.blogspot.com', 'me.blogspot.com'],
    ['a.пример.рф', 'xn--e1afmkfd.xn--p1ai'],
    ['a.b.other', 'b.other'],
  ];
  for (const [host, want] of cases) assert.equal(registrableDomain(host), want, host);
});

test('the update script keeps the licence head, the section marks and the rules – no other comments', async () => {
  const { compactList } = (await import('../scripts/psl-update.mjs')) as { compactList: (t: string) => string };
  const rules = Array.from({ length: 6000 }, (_v, i) => `r${i}.example`);
  const source = [
    '// This Source Code Form is subject to the terms of the Mozilla Public',
    '// License, v. 2.0. If a copy of the MPL was not distributed with this',
    '// file, You can obtain one at https://mozilla.org/MPL/2.0/.',
    '', '// VERSION: 2026-11-01_00-00-00_UTC', '// COMMIT: abc', '',
    '// ===BEGIN ICANN DOMAINS===', '// a comment about a registry', 'com', '*.ck', '!www.ck', '// ===END ICANN DOMAINS===',
    '// ===BEGIN PRIVATE DOMAINS===', '// Some Company : https://company.example/', '// Submitted by Someone <a@company.example>',
    ...rules, '// ===END PRIVATE DOMAINS===', '',
  ].join('\n');
  const out = compactList(source);
  assert.match(out, /^\/\/ This Source Code Form/);
  assert.match(out, /\/\/ VERSION: 2026-11-01_00-00-00_UTC\n/);
  assert.ok(!out.includes('Submitted by') && !out.includes('a comment about'));
  assert.ok(out.includes('\n// ===BEGIN PRIVATE DOMAINS===\nr0.example\n'));
  assert.ok(out.includes('\ncom\n*.ck\n!www.ck\n'));
  // Die kompakte Fassung ergibt dieselben Regeln
  setPslForTests(out);
  assert.equal(registrableDomain('a.b.ck'), 'a.b.ck');
  assert.equal(registrableDomain('x.r5.example'), 'x.r5.example');
  setPslForTests(null);
  assert.throws(() => compactList(source.replace('// ===END PRIVATE DOMAINS===', '')), /incomplete/);
  assert.throws(() => compactList(source.replace(rules.join('\n'), 'one.example')), /only/);
});
