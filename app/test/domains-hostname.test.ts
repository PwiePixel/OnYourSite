// Eigene Domains (PD-2), reine Teile ohne Datenbank: Eingabe → Hostname, Wurzeldomain-Schätzung, Host-Felder,
// abgeleitete Werte (Besitznachweis, Prüfstelle) und die Werte der Einrichtung (vorhanden?, reservierte Namen).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, setConfigForTests, type ConfigData } from '../src/config.js';
import { displayHostname, guessZone, hostnameError, looksLikeApex, normalizeHostname, recordHosts, relativeName } from '../src/domains/hostname.js';
import { ownershipToken, probeAnswer } from '../src/domains/tokens.js';
import { domainsAvailable, reservedSlugs } from '../src/domains/config.js';
import { isForbiddenSubdomain } from '../src/helpers.js';

const BASE = loadConfig();
const withConfig = (extra: ConfigData): void => setConfigForTests({ ...BASE, base_domain: 'oys.test:8080', scheme: 'http', ...extra });
after(() => setConfigForTests(BASE));

const ok = (input: string, base = 'on-your.site'): { ascii: string; unicode: string } => {
  const r = normalizeHostname(input, base);
  assert.ok(r.ok, `${JSON.stringify(input)} should be accepted: ${r.ok ? '' : r.error}`);
  return { ascii: r.ascii, unicode: r.unicode };
};
const problem = (input: unknown, base = 'on-your.site'): string => {
  const r = normalizeHostname(input, base);
  assert.ok(!r.ok, `${JSON.stringify(input)} should be refused, got ${r.ok ? r.ascii : ''}`);
  return r.problem;
};

test('hostnames: pasted addresses, case, IDN and the trailing dot end up as one lower-case ASCII name', () => {
  assert.deepEqual(ok('links.example.com'), { ascii: 'links.example.com', unicode: 'links.example.com' });
  assert.equal(ok('Links.Example.COM').ascii, 'links.example.com');
  assert.equal(ok('links.example.com.').ascii, 'links.example.com');
  assert.equal(ok('https://Links.Example.com/path?x=1#top').ascii, 'links.example.com');
  assert.equal(ok('http://links.example.com:8443/').ascii, 'links.example.com');
  assert.equal(ok('//links.example.com').ascii, 'links.example.com');
  // Wie im Browser: ein Backslash beginnt den Pfad
  assert.equal(ok('links.example.com\\x').ascii, 'links.example.com');
  assert.equal(ok('  links.example.com\t').ascii, 'links.example.com');
  assert.equal(ok(' links.example.com​').ascii, 'links.example.com');
  assert.equal(ok('ＬＩＮＫＳ。example。com').ascii, 'links.example.com');
  assert.deepEqual(ok('bücher.de'), { ascii: 'xn--bcher-kva.de', unicode: 'bücher.de' });
  assert.deepEqual(ok('XN--BCHER-KVA.de'), { ascii: 'xn--bcher-kva.de', unicode: 'bücher.de' });
  assert.equal(ok('a.b.c.d.e.f.g.h.example.com').ascii, 'a.b.c.d.e.f.g.h.example.com');
  assert.equal(ok('x'.repeat(63) + '.com').ascii, 'x'.repeat(63) + '.com');
  assert.equal(ok('my-links.example.com').ascii, 'my-links.example.com');
  assert.equal(displayHostname('xn--bcher-kva.de'), 'bücher.de');
  assert.equal(displayHostname('links.example.com'), 'links.example.com');
});

test('hostnames: addresses, wildcards, underscores and reserved names are refused with the right message', () => {
  for (const s of ['', '   ', 'https://', '.', null, undefined, 42, ['links.example.com']]) assert.equal(problem(s), 'empty', String(s));
  for (const s of ['*.example.com', '*', 'links.*.com']) assert.equal(problem(s), 'wildcard', s);
  for (const s of ['on-your.site', 'www.on-your.site', 'mia.on-your.site', 'MIA.On-Your.Site', 'https://mia.on-your.site/x', 'edge.on-your.site', 'a.b.on-your.site']) {
    assert.equal(problem(s), 'base', s);
  }
  const invalid = ['127.0.0.1', '1.2.3.4', '[::1]', '::1', 'fe80::1', 'localhost', 'example', 'foo.localhost', 'site.test', 'x.example', 'x.invalid',
    'x.onion', 'x.local', 'x.internal', 'x.lan', 'x.home', 'x.corp', 'x.arpa', 'x.alt', '_x.com', 'a_b.example.com', '_onyoursite.example.com',
    'x'.repeat(64) + '.com', ('a'.repeat(60) + '.').repeat(5) + 'com', '-a.com', 'a-.com', 'foo.123', 'foo.c', 'user@links.example.com',
    'exa mple.com', 'example..com', 'a.b.c.d.e.f.g.h.i.example.com', 'xn--zz.com', 'links.example.com:abc'];
  for (const s of invalid) assert.equal(problem(s), 'invalid', s);
  // Die Fehlertexte nennen die Domain der Seite
  assert.equal(hostnameError('empty', 'on-your.site'), 'Please enter a domain, e.g. links.yourname.com.');
  assert.equal(hostnameError('invalid', 'on-your.site'), 'That doesn’t look like a valid domain.');
  assert.equal(hostnameError('wildcard', 'on-your.site'), 'Wildcard domains aren’t supported.');
  assert.equal(hostnameError('base', 'on-your.site'), 'Addresses on on-your.site can’t be used as a custom domain – choose them under Address above.');
  const r = normalizeHostname('mia.oys.test', 'oys.test');
  assert.ok(!r.ok && r.error.includes('Addresses on oys.test '));
});

test('hostnames are not run through the word filter of page addresses', () => {
  for (const s of ['something.com', 'grapes.io', 'crisis.org', 'torpedo.de', 'glockenspiel.de']) {
    assert.ok(isForbiddenSubdomain(s.split('.')[0]), `${s}: the address filter would refuse it`);
    assert.equal(ok(s).ascii, s);
  }
});

test('root domains are guessed without DNS, and the host fields follow the zone', () => {
  for (const s of ['example.com', 'example.co.uk', 'example.com.au', 'bücher.de']) assert.equal(looksLikeApex(ok(s).ascii), true, s);
  for (const s of ['links.example.com', 'www.example.com', 'links.example.co.uk', 'a.b.example.com']) assert.equal(looksLikeApex(s), false, s);
  assert.equal(guessZone('links.example.com'), 'example.com');
  assert.equal(guessZone('links.example.co.uk'), 'example.co.uk');
  assert.equal(guessZone('example.com'), 'example.com');
  assert.deepEqual(recordHosts('links.example.com', null), { cname: 'links', txt: '_onyoursite.links' });
  assert.deepEqual(recordHosts('example.com', null), { cname: '@', txt: '_onyoursite' });
  assert.deepEqual(recordHosts('example.co.uk', ''), { cname: '@', txt: '_onyoursite' });
  assert.deepEqual(recordHosts('a.b.example.com', 'example.com'), { cname: 'a.b', txt: '_onyoursite.a.b' });
  // Der Dienst hat die Zone aus dem DNS: links.example.com ist selbst eine Zone (Wurzeldomain)
  assert.deepEqual(recordHosts('links.example.com', 'links.example.com'), { cname: '@', txt: '_onyoursite' });
  assert.equal(relativeName('other.org', 'example.com'), 'other.org');
});

test('the ownership value and the probe answer are deterministic, bound to account and name, and short', () => {
  const t = ownershipToken(5, 'links.example.com');
  assert.match(t, /^onyoursite-verify=[0-9a-f]{32}$/);
  assert.equal(ownershipToken(5, 'links.example.com'), t);
  assert.notEqual(ownershipToken(6, 'links.example.com'), t);
  assert.notEqual(ownershipToken(5, 'www.example.com'), t);
  assert.match(probeAnswer('links.example.com'), /^[0-9a-f]{32}$/);
  assert.equal(probeAnswer('links.example.com'), probeAnswer('links.example.com'));
  assert.notEqual(probeAnswer('links.example.com'), probeAnswer('www.example.com'));
  assert.notEqual(probeAnswer('links.example.com'), t.slice('onyoursite-verify='.length));
});

test('the feature counts as set up only with zone, CNAME target and fallback origin; their names are reserved', () => {
  const full = { cloudflare: { zone_id: 'z'.repeat(32) }, custom_domains: { cname_target: 'edge.oys.test', fallback_origin: 'origin.oys.test' } };
  withConfig({});
  assert.equal(domainsAvailable(), false);
  assert.deepEqual(reservedSlugs('oys.test'), []);
  withConfig({ custom_domains: full.custom_domains });
  assert.equal(domainsAvailable(), false);
  withConfig({ cloudflare: full.cloudflare, custom_domains: { cname_target: 'edge.oys.test' } });
  assert.equal(domainsAvailable(), false);
  withConfig(full);
  assert.equal(domainsAvailable(), true);
  assert.deepEqual(reservedSlugs('oys.test'), ['edge', 'origin']);
  // Eigene Namen aus dem Installer; Namen tiefer unter der Domain oder unter einer anderen Domain belegen keine Adresse
  withConfig({ ...full, custom_domains: { cname_target: 'Customers.OYS.test', fallback_origin: 'a.b.oys.test' } });
  assert.deepEqual(reservedSlugs('oys.test'), ['customers']);
  withConfig({ ...full, custom_domains: { cname_target: 'edge.other.com', fallback_origin: 'oys.test' } });
  assert.deepEqual(reservedSlugs('oys.test'), []);
});
