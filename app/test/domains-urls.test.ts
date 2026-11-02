// Eigene Domains (PD-2), Adressen ohne Datenbank: URL-Hilfen mit und ohne Live-Domain, der Termin-Block mit der
// Adresse der Domain und der Hash des Vorschaubilds (bereits geteilte Karten behalten ihre Adresse).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, setConfigForTests, type ConfigData } from '../src/config.js';
import { addressUrl, onPageHost, pageDisplayUrl, pageOrigin, pageUrl, pageUrls } from '../src/helpers.js';
import { ogHash } from '../src/content/share.js';
import { bookingIsInternal, bookingPointsTo } from '../src/content/blocks.js';
import { makeTestCtx } from '../src/web/ctx.js';

const BASE = loadConfig();
const withConfig = (extra: ConfigData): void => setConfigForTests({ ...BASE, base_domain: 'oys.test:8080', scheme: 'http', ...extra });
after(() => setConfigForTests(BASE));

test('URL helpers: without a live domain nothing changes; with one it is the primary address', () => {
  withConfig({ custom_domains: { url_port: ':8080' } });
  const mia = { slug: 'mia', address_mode: 'subdomain' };
  for (const p of [mia, { ...mia, custom_domain: null }, { ...mia, custom_domain: '' }]) {
    assert.deepEqual(Object.keys(pageUrls(p)), ['subdomain', 'path']);
    assert.deepEqual(pageUrls(p), { subdomain: 'http://mia.oys.test:8080', path: 'http://oys.test:8080/mia' });
    assert.equal(pageUrl(p), 'http://mia.oys.test:8080');
    assert.equal(pageUrl(p, 'kalender'), 'http://mia.oys.test:8080/kalender');
    assert.equal(addressUrl(p, 'kalender'), 'http://mia.oys.test:8080/kalender');
    assert.equal(pageOrigin(p), 'http://mia.oys.test:8080');
    assert.equal(pageDisplayUrl(p), 'mia.oys.test:8080');
    assert.equal(onPageHost(makeTestCtx({ url: '/', host: 'mia.oys.test:8080' }), p), true);
  }
  const live = { ...mia, custom_domain: 'links.example.com' };
  assert.deepEqual(Object.keys(pageUrls(live)), ['subdomain', 'path', 'custom']);
  assert.equal(pageUrls(live).custom, 'http://links.example.com:8080');
  assert.equal(pageUrl(live), 'http://links.example.com:8080');
  assert.equal(pageUrl(live, 'kalender'), 'http://links.example.com:8080/kalender');
  assert.equal(pageUrl(live, '/kalender'), 'http://links.example.com:8080/kalender');
  assert.equal(addressUrl(live), 'http://mia.oys.test:8080');
  assert.equal(addressUrl({ ...live, address_mode: 'path' }, 'kalender'), 'http://oys.test:8080/mia/kalender');
  assert.equal(pageOrigin(live), 'http://links.example.com:8080');
  assert.equal(pageDisplayUrl(live), 'links.example.com:8080');
  assert.equal(onPageHost(makeTestCtx({ url: '/', host: 'links.example.com' }), live), true);
  assert.equal(onPageHost(makeTestCtx({ url: '/', host: 'mia.oys.test:8080' }), live), false);
  // Ohne Test-Port: https://<domain>
  setConfigForTests({ ...BASE, base_domain: 'on-your.site', scheme: 'https' });
  assert.equal(pageUrl(live), 'https://links.example.com');
  assert.equal(pageUrl(mia), 'https://mia.on-your.site');
});

test('booking blocks: the page’s own domain counts as its address only when it is passed in', () => {
  withConfig({ custom_domains: { url_port: ':8080' } });
  const page = { slug: 'mia', address_mode: 'subdomain' };
  const block = { url: 'http://Links.Example.com:8080/kalender/' };
  assert.equal(bookingIsInternal(block, page), false);
  assert.equal(bookingIsInternal(block, page, ['links.example.com']), true);
  assert.equal(bookingIsInternal(block, page, ['other.example.com']), false);
  assert.equal(bookingPointsTo(block, 'links.example.com'), true);
  assert.equal(bookingPointsTo({ url: 'http://links.example.com:8080/kalender/x' }, 'links.example.com'), false);
  // Mit Live-Domain gehört sie ohnehin zu den Adressen der Seite
  assert.equal(bookingIsInternal(block, { ...page, custom_domain: 'links.example.com' }), true);
  // Bisherige Fälle unverändert
  assert.equal(bookingIsInternal({ url: '/kalender' }, page), true);
  assert.equal(bookingIsInternal({ url: 'http://mia.oys.test:8080/kalender' }, page), true);
  assert.equal(bookingIsInternal({ url: 'https://calendly.com/mia' }, page, ['links.example.com']), false);
});

test('the preview card hash stays the same without a domain and changes with one', () => {
  withConfig({});
  const page = { id: 2, slug: 'mia', address_mode: 'subdomain', title: 'Mia', subtitle: 'Design', bio: 'Hi', avatar: 'avatar_5_1_ab.webp', theme: 'aurora', settings: '{"accent":"#ff0055"}' };
  const plain = ogHash(page);
  assert.match(plain, /^[0-9a-f]{12}$/);
  // Festgehaltene Werte (vor dieser Änderung berechnet): bereits geteilte Karten behalten ihre Adresse
  assert.equal(plain, 'cd6001bd20f1');
  assert.equal(ogHash({ ...page, custom_domain: null }), plain);
  assert.equal(ogHash({ ...page, custom_domain: '' }), plain);
  const withDomain = ogHash({ ...page, custom_domain: 'links.example.com' });
  assert.notEqual(withDomain, plain);
  assert.notEqual(ogHash({ ...page, custom_domain: 'www.example.com' }), withDomain);
});
