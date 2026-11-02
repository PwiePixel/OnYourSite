// markdown(text, { base, ugc }) für Texte von Nutzern (Vorfälle auf Statusseiten): eigene Pfade bleiben auf der Seite,
// fremde Links bekommen nofollow ugc und ihren Host in Klammern. Ohne Optionen bleibt alles wie bisher (die Updates-
// Seiten vergleichen ihre Ausgabe weiter Byte für Byte mit PHP, updates-markdown.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdown, mdLink } from '../src/updates/markdown.js';
import { mainUrl } from '../src/helpers.js';

const BASE = 'https://acme-status.on-your.site/';
const UGC = { base: BASE, ugc: true };

test('without options the output is unchanged', () => {
  assert.equal(markdown('[docs](/updates)'), `<p><a href="${mainUrl('/updates')}">docs</a></p>`);
  assert.equal(markdown('[top](#v2)'), `<p><a href="${mainUrl('/updates#v2')}">top</a></p>`);
  assert.equal(markdown('[x](https://example.com/a)'), '<p><a href="https://example.com/a" target="_blank" rel="noopener noreferrer">x</a></p>');
  assert.equal(markdown('see https://example.com/a.'),
    '<p>see <a href="https://example.com/a" target="_blank" rel="noopener noreferrer">example.com/a</a>.</p>');
  assert.equal(mdLink('https://example.com', 'l'), '<a href="https://example.com" target="_blank" rel="noopener noreferrer">l</a>');
  assert.equal(markdown('[x](https://example.com/a)', {}), markdown('[x](https://example.com/a)'));
});

test('base: own paths and anchors resolve against the status page', () => {
  assert.equal(markdown('[history](/history)', UGC), '<p><a href="https://acme-status.on-your.site/history">history</a></p>');
  assert.equal(markdown('[incident](/incidents/7?x=1)', UGC), '<p><a href="https://acme-status.on-your.site/incidents/7?x=1">incident</a></p>');
  assert.equal(markdown('[up](#components)', UGC), '<p><a href="https://acme-status.on-your.site/#components">up</a></p>');
  assert.equal(markdown('[up](#a)', { base: 'https://s.on-your.site/incidents/3#old' }), '<p><a href="https://s.on-your.site/incidents/3#a">up</a></p>');
  // //host und /\host sind keine eigenen Pfade
  assert.match(markdown('[x](//evil.example/a)', UGC), /href="https:\/\/evil\.example\/a"[^>]*rel="nofollow ugc noopener noreferrer"/);
  assert.match(markdown('[x](/\\evil.example)', UGC), /^<p>(?!<a href="https:\/\/acme)/);
});

test('ugc: external links get nofollow ugc and show their host after the text', () => {
  assert.equal(markdown('[Log in here](https://evil.example/login)', UGC),
    '<p><a href="https://evil.example/login" target="_blank" rel="nofollow ugc noopener noreferrer">Log in here</a> <span class="md-host">(evil.example)</span></p>');
  // Verwechselbare Zeichen werden als Punycode gezeigt
  assert.equal(markdown('[PayPal](https://pаypal.com/)', UGC),
    '<p><a href="https://pаypal.com/" target="_blank" rel="nofollow ugc noopener noreferrer">PayPal</a> <span class="md-host">(xn--pypal-4ve.com)</span></p>');
  // Eine nackte Adresse zeigt sich selbst – sie bekommt nur rel
  assert.equal(markdown('see https://example.com/x', UGC),
    '<p>see <a href="https://example.com/x" target="_blank" rel="nofollow ugc noopener noreferrer">example.com/x</a></p>');
  assert.equal(markdown('[mail us](mailto:help@evil.example)', UGC),
    '<p><a href="mailto:help@evil.example" target="_blank" rel="nofollow ugc noopener noreferrer">mail us</a> <span class="md-host">(evil.example)</span></p>');
  assert.equal(markdown('[call](tel:+49301234567)', UGC),
    '<p><a href="tel:+49301234567" target="_blank" rel="nofollow ugc noopener noreferrer">call</a></p>');
  // In Listen, Überschriften und Zitaten genauso
  assert.match(markdown('- [a](https://x.example)\n# [b](https://y.example)\n> [c](https://z.example)', UGC),
    /\(x\.example\).*\(y\.example\).*\(z\.example\)/);
  // Escaping bleibt: Text, Ziel und Host
  assert.equal(markdown('[<b>"x"</b>](https://example.com/?a=1&b=2)', UGC),
    '<p><a href="https://example.com/?a=1&amp;b=2" target="_blank" rel="nofollow ugc noopener noreferrer">&lt;b&gt;&quot;x&quot;&lt;/b&gt;</a> <span class="md-host">(example.com)</span></p>');
  assert.equal(markdown('[x](javascript:alert(1))', UGC), '<p>[x](javascript:alert(1))</p>');
});
