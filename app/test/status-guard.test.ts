// Statusseiten, Schutz gegen SSRF (guard.ts): Schemata, Zugangsdaten, Ports, IDN, Punkte am Ende, besondere Namen,
// alle Schreibweisen von IPv4 (2130706433, 0x7f.1, 0177.0.0.1, 127.1, Vollbreite), IPv6 (gemappt, NAT64, 6to4, Teredo,
// Zonen), Metadaten-Dienste, eigene Adressen mit und ohne Tunnel, Regeln je Host und Domain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRIVATE_TEXT, addressList, classifyIp, hostRule, ipVerdict, normalizeRuleHost, parseTarget, specialName, type GuardPolicy, type HostRule,
} from '../src/status/guard.js';
import { interfaceAddresses, runtimePolicy } from '../src/status/policy.js';
import { statusServerConfig, statusSettingsFrom } from '../src/status/settings.js';

const statusServerConfigDefaults = statusServerConfig;

const SELF_V4 = '93.184.216.34';
const SELF_V6 = '2a01:4f8:c0c:1234::1';
const policy = (tunnel = false, extra: Partial<GuardPolicy> = {}): GuardPolicy => ({
  ports: [80, 443, 8080, 8443],
  tunnel,
  self: addressList([SELF_V4, SELF_V6]),
  ...extra,
});

type Expect = { code: string } | { host: string; url?: string; port?: number; ip?: number };

// [Eingabe, Erwartung, Tunnel?]
const CASES: Array<[unknown, Expect, boolean?]> = [
  // leer, zu lang, kein Text
  ['', { code: 'empty' }],
  ['   \t', { code: 'empty' }],
  [null, { code: 'empty' }],
  [42, { code: 'empty' }],
  [{ url: 'https://example.com' }, { code: 'empty' }],
  ['https://example.com/' + 'a'.repeat(490), { code: 'long' }],
  ['a'.repeat(501), { code: 'long' }],
  // Schemata
  ['ftp://example.com/', { code: 'scheme' }],
  ['javascript:alert(1)', { code: 'scheme' }],
  ['JavaScript:alert(1)', { code: 'scheme' }],
  ['file:///etc/passwd', { code: 'scheme' }],
  ['gopher://example.com:70/', { code: 'scheme' }],
  ['data:text/html,hi', { code: 'scheme' }],
  ['mailto:a@example.com', { code: 'scheme' }],
  ['ws://example.com/', { code: 'scheme' }],
  // Zugangsdaten
  ['http://user:pw@example.com/', { code: 'userinfo' }],
  ['https://user@example.com/', { code: 'userinfo' }],
  ['https://:pw@example.com/', { code: 'userinfo' }],
  ['https://example.com@evil.example.org/', { code: 'userinfo' }],
  // Ports
  ['http://example.com:22/', { code: 'port' }],
  ['https://example.com:3306/', { code: 'port' }],
  ['example.com:6379', { code: 'port' }],
  ['https://example.com:65535/', { code: 'port' }],
  ['http://example.com:8080/x', { host: 'example.com', port: 8080, url: 'http://example.com:8080/x' }],
  ['https://example.com:8443', { host: 'example.com', port: 8443, url: 'https://example.com:8443/' }],
  ['http://example.com:443/', { host: 'example.com', port: 443, url: 'http://example.com:443/' }],
  ['https://example.com:80/', { host: 'example.com', port: 80, url: 'https://example.com:80/' }],
  ['https://example.com:443/', { host: 'example.com', port: 443, url: 'https://example.com/' }],
  // Normalisierung
  ['example.com', { host: 'example.com', port: 443, url: 'https://example.com/' }],
  ['  example.com/health  ', { host: 'example.com', url: 'https://example.com/health' }],
  ['//example.com/x', { host: 'example.com', url: 'https://example.com/x' }],
  ['HTTPS://EXAMPLE.COM/Path?Q=1#frag', { host: 'example.com', url: 'https://example.com/Path?Q=1' }],
  ['https://example.com./', { host: 'example.com', url: 'https://example.com/' }],
  ['https://example.com../x', { host: 'example.com', url: 'https://example.com/x' }],
  ['https://bücher.de/', { host: 'xn--bcher-kva.de', url: 'https://xn--bcher-kva.de/' }],
  ['https://BÜCHER.de/', { host: 'xn--bcher-kva.de' }],
  ['https://xn--bcher-kva.de/', { host: 'xn--bcher-kva.de' }],
  ['https://ex%61mple.com/', { host: 'example.com' }],
  ['https://exa_mple.com/', { host: 'exa_mple.com' }],
  ['http://example.com/a b', { host: 'example.com', url: 'http://example.com/a%20b' }],
  ['https://status.on-your.site/', { host: 'status.on-your.site' }],
  ['https://exa mple.com/', { code: 'invalid' }],
  ['https://a..b.com/', { code: 'invalid' }],
  ['https://-a.com/', { code: 'invalid' }],
  ['https://' + 'a'.repeat(64) + '.com/', { code: 'invalid' }],
  ['https://[::1/', { code: 'invalid' }],
  ['http://', { code: 'invalid' }],
  // besondere Namen und Namen ohne Punkt
  ['http://localhost/', { code: 'private' }],
  ['http://localhost:8080/', { code: 'private' }],
  ['http://LOCALHOST./', { code: 'private' }],
  ['http://foo.localhost/', { code: 'private' }],
  ['http://myhost.localdomain/', { code: 'private' }],
  ['http://printer.local/', { code: 'private' }],
  ['http://db.internal/', { code: 'private' }],
  ['http://wiki.intranet/', { code: 'private' }],
  ['http://nas.lan/', { code: 'private' }],
  ['http://router.home/', { code: 'private' }],
  ['http://x.corp/', { code: 'private' }],
  ['http://x.home.arpa/', { code: 'private' }],
  ['http://1.0.0.127.in-addr.arpa/', { code: 'private' }],
  ['http://site.test/', { code: 'private' }],
  ['http://site.invalid/', { code: 'private' }],
  ['http://site.example/', { code: 'private' }],
  ['http://abcdefghijklmnop.onion/', { code: 'private' }],
  ['http://x.alt/', { code: 'private' }],
  ['http://intranet/', { code: 'private' }],
  ['http://metadata/', { code: 'private' }],
  ['http://example.com/', { host: 'example.com' }],
  ['http://localhost.example.com/', { host: 'localhost.example.com' }],
  // IPv4 in allen Schreibweisen
  ['http://127.0.0.1/', { code: 'private' }],
  ['http://2130706433/', { code: 'private' }],
  ['http://0x7f.1/', { code: 'private' }],
  ['http://0177.0.0.1/', { code: 'private' }],
  ['http://127.1/', { code: 'private' }],
  ['http://①②⑦.0.0.1/', { code: 'private' }],
  ['http://１２７.０.０.１/', { code: 'private' }],
  ['http://%31%32%37.0.0.1/', { code: 'private' }],
  ['http://0.0.0.0/', { code: 'private' }],
  ['http://0/', { code: 'private' }],
  ['http://10.0.0.1/', { code: 'private' }],
  ['http://10.255.255.255:8080/', { code: 'private' }],
  ['http://172.16.0.1/', { code: 'private' }],
  ['http://172.31.255.255/', { code: 'private' }],
  ['http://192.168.1.1/', { code: 'private' }],
  ['http://100.64.0.1/', { code: 'private' }],
  ['http://100.127.255.254/', { code: 'private' }],
  ['http://100.100.100.200/', { code: 'private' }],
  ['http://169.254.169.254/latest/meta-data/', { code: 'private' }],
  ['http://169.254.170.2/v2/credentials', { code: 'private' }],
  ['http://168.63.129.16/', { code: 'private' }],
  ['http://192.0.0.1/', { code: 'private' }],
  ['http://192.0.2.1/', { code: 'private' }],
  ['http://192.88.99.1/', { code: 'private' }],
  ['http://198.18.0.1/', { code: 'private' }],
  ['http://198.19.255.1/', { code: 'private' }],
  ['http://198.51.100.7/', { code: 'private' }],
  ['http://203.0.113.9/', { code: 'private' }],
  ['http://224.0.0.1/', { code: 'private' }],
  ['http://239.255.255.250/', { code: 'private' }],
  ['http://240.0.0.1/', { code: 'private' }],
  ['http://255.255.255.255/', { code: 'private' }],
  ['http://256.1.1.1/', { code: 'invalid' }],
  ['http://8.8.8.8/', { host: '8.8.8.8', ip: 4 }],
  ['http://1.1.1.1:8080/', { host: '1.1.1.1', port: 8080, ip: 4 }],
  ['http://172.32.0.1/', { host: '172.32.0.1', ip: 4 }],
  ['http://168.63.129.17/', { host: '168.63.129.17', ip: 4 }],
  ['http://100.128.0.1/', { host: '100.128.0.1', ip: 4 }],
  ['http://1.2.3/', { host: '1.2.0.3', ip: 4 }],
  // IPv6
  ['http://[::1]/', { code: 'private' }],
  ['http://[::]/', { code: 'private' }],
  ['http://[::ffff:127.0.0.1]/', { code: 'private' }],
  ['http://[::ffff:8.8.8.8]/', { code: 'private' }],
  ['http://[::127.0.0.1]/', { code: 'private' }],
  ['http://[64:ff9b::7f00:1]/', { code: 'private' }],
  ['http://[64:ff9b:1::1]/', { code: 'private' }],
  ['http://[2002:7f00:1::]/', { code: 'private' }],
  ['http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/', { code: 'private' }],
  ['http://[2001:db8::1]/', { code: 'private' }],
  ['http://[3fff::1]/', { code: 'private' }],
  ['http://[100::1]/', { code: 'private' }],
  ['http://[fe80::1]/', { code: 'private' }],
  ['http://[fe80::1%25eth0]/', { code: 'invalid' }],
  ['http://[fd00:ec2::254]/', { code: 'private' }],
  ['http://[fc00::1]/', { code: 'private' }],
  ['http://[fec0::1]/', { code: 'private' }],
  ['http://[ff02::1]/', { code: 'private' }],
  ['http://[2606:4700:4700::1111]/', { host: '2606:4700:4700::1111', ip: 6, url: 'http://[2606:4700:4700::1111]/' }],
  ['https://[2606:4700:4700::1111]:8443/x', { host: '2606:4700:4700::1111', port: 8443, ip: 6 }],
  ['https://[2606:4700:4700::1111]:22/', { code: 'port' }],
  // eigene Adressen: ohne Tunnel nur 80/443, mit Tunnel nie
  [`http://${SELF_V4}/`, { host: SELF_V4, ip: 4 }, false],
  [`https://${SELF_V4}/`, { host: SELF_V4, ip: 4 }, false],
  [`http://${SELF_V4}:8080/`, { code: 'private' }, false],
  [`http://${SELF_V4}/`, { code: 'private' }, true],
  [`https://[${SELF_V6}]/`, { host: SELF_V6, ip: 6 }, false],
  [`https://[${SELF_V6}]:8443/`, { code: 'private' }, false],
  [`https://[${SELF_V6}]/`, { code: 'private' }, true],
  ['https://example.com/', { host: 'example.com' }, true],
];

test('parseTarget: every table case', () => {
  assert.ok(CASES.length >= 110, `${CASES.length} cases`);
  for (const [input, want, tunnel] of CASES) {
    const got = parseTarget(input, policy(tunnel ?? false));
    const label = JSON.stringify(input) + (tunnel ? ' (tunnel)' : '');
    if ('code' in want) {
      assert.equal(got.ok, false, label);
      if (!got.ok) {
        assert.equal(got.code, want.code, label);
        assert.equal(got.field, 'url');
      }
    } else {
      assert.equal(got.ok, true, label + ' → ' + JSON.stringify(got));
      if (got.ok) {
        assert.equal(got.host, want.host, label);
        if (want.url !== undefined) assert.equal(got.url, want.url, label);
        if (want.port !== undefined) assert.equal(got.port, want.port, label);
        if (want.ip !== undefined) assert.equal(got.ip, want.ip, label);
        // Was gespeichert wird, ergibt beim erneuten Prüfen dasselbe (Prüfung vor jeder Prüfung)
        const again = parseTarget(got.url, policy(tunnel ?? false));
        assert.equal(again.ok && again.url, got.url, label + ' (again)');
      }
    }
  }
});

test('parseTarget: the texts users see', () => {
  const msg = (input: string, p = policy()): string => {
    const r = parseTarget(input, p);
    return r.ok ? '' : r.error;
  };
  assert.equal(msg(''), 'Please enter the address to check.');
  assert.equal(msg('ftp://x.com'), 'Please enter an address starting with http:// or https://.');
  assert.equal(msg('https://u:p@x.com'), 'Addresses with a user name or password can’t be checked.');
  assert.equal(msg('https://x.com:22/'), 'Port 22 can’t be checked. Allowed ports: 80, 443, 8080, 8443.');
  assert.equal(msg('https://x.com:22/', policy(false, { ports: [443] })), 'Port 22 can’t be checked. Allowed ports: 443.');
  assert.equal(msg('http://localhost/'), PRIVATE_TEXT);
  assert.equal(PRIVATE_TEXT, 'This address points to a private or local network – only public websites can be checked.');
  assert.equal(msg('https://a..b/'), 'This doesn’t look like a web address.');
  assert.equal(msg('x'.repeat(600)), 'This address is too long – 500 characters at most.');
  // Der Pfad bleibt für die Anfrage und robots.txt
  const ok = parseTarget('https://example.com/a/b?c=1#d', policy());
  assert.ok(ok.ok && ok.path === '/a/b?c=1' && ok.scheme === 'https');
});

test('classifyIp and ipVerdict: ranges, own addresses and the test allowance', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '100.100.100.200', '168.63.129.16', '0.1.2.3', '::1', '::ffff:10.0.0.1',
    'fe80::abcd', 'fd00:ec2::254', '2001:db8::5', '2002:c000:0204::1', '64:ff9b::a00:1', 'ff05::2']) {
    assert.equal(classifyIp(ip), 'blocked', ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '76.76.21.21', '185.199.108.153', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e']) {
    assert.equal(classifyIp(ip), 'public', ip);
  }
  for (const bad of ['', 'example.com', '1.2.3.4.5', '::g', '[::1]']) assert.equal(classifyIp(bad), 'invalid', bad);

  assert.deepEqual(ipVerdict('8.8.8.8', 443, policy()), { ok: true });
  assert.deepEqual(ipVerdict('10.0.0.1', 443, policy()), { ok: false, reason: 'private' });
  assert.deepEqual(ipVerdict('nope', 443, policy()), { ok: false, reason: 'invalid' });
  assert.deepEqual(ipVerdict(SELF_V4, 80, policy(false)), { ok: true });
  assert.deepEqual(ipVerdict(SELF_V4, 8443, policy(false)), { ok: false, reason: 'self' });
  assert.deepEqual(ipVerdict(SELF_V4, 443, policy(true)), { ok: false, reason: 'self' });
  // Eine andere Schreibweise derselben eigenen IPv6-Adresse trifft auch
  assert.deepEqual(ipVerdict('2a01:04f8:0c0c:1234:0000:0000:0000:0001', 443, policy(true)), { ok: false, reason: 'self' });

  // Nur die Richtlinie der Tests erlaubt 127.0.0.1 – und nur auf ihrem Port
  const testPolicy = policy(false, { testAllow: (ip, port) => ip === '127.0.0.1' && port === 18080 });
  assert.deepEqual(ipVerdict('127.0.0.1', 18080, testPolicy), { ok: true });
  assert.deepEqual(ipVerdict('127.0.0.1', 18081, testPolicy), { ok: false, reason: 'private' });
  assert.deepEqual(ipVerdict('127.0.0.1', 18080, policy()), { ok: false, reason: 'private' });
});

test('special names and single labels', () => {
  for (const h of ['localhost', 'a.localhost', 'x.local', 'x.internal', 'x.lan', 'x.home.arpa', 'single', 'x.onion', 'x.test']) assert.equal(specialName(h), true, h);
  for (const h of ['example.com', 'local.example.com', 'test.de', 'home.example.org', 'onion.com']) assert.equal(specialName(h), false, h);
});

test('host rules: the exact host wins over a domain rule, a longer domain over a shorter one', () => {
  const rules: HostRule[] = [
    { host: '.victim.com', rule: 'block', max_monitors: null, note: 'Asked us to stop' },
    { host: 'api.victim.com', rule: 'allow', max_monitors: 50, note: '' },
    { host: '.shop.victim.com', rule: 'allow', max_monitors: 30, note: '' },
    { host: 'other.org', rule: 'block', max_monitors: null, note: '' },
  ];
  assert.equal(hostRule('victim.com', rules)?.rule, 'block');
  assert.equal(hostRule('www.victim.com', rules)?.rule, 'block');
  assert.equal(hostRule('api.victim.com', rules)?.max_monitors, 50);
  assert.equal(hostRule('a.shop.victim.com', rules)?.max_monitors, 30);
  assert.equal(hostRule('shop.victim.com', rules)?.max_monitors, 30);
  assert.equal(hostRule('notvictim.com', rules), null);
  assert.equal(hostRule('other.org', rules)?.rule, 'block');
  assert.equal(hostRule('www.other.org', rules), null, 'an exact rule does not cover subdomains');
  assert.equal(hostRule('example.com', []), null);
});

test('normalizeRuleHost: hosts and .domains for the admin form', () => {
  assert.equal(normalizeRuleHost('Example.COM'), 'example.com');
  assert.equal(normalizeRuleHost(' .Example.com. '), '.example.com');
  assert.equal(normalizeRuleHost('bücher.de'), 'xn--bcher-kva.de');
  assert.equal(normalizeRuleHost('8.8.8.8'), '8.8.8.8');
  assert.equal(normalizeRuleHost('[2606:4700::1111]'), '2606:4700::1111');
  for (const bad of ['', '.', '..', 'localhost', '.8.8.8.8', 'a..b', 'exa mple.com', 5, null, 'http://x.com/']) {
    assert.equal(normalizeRuleHost(bad), null, JSON.stringify(bad));
  }
});

// Prüfbericht: das Abschneiden von Leerraum lief als /…+$/ über die ganze Eingabe, BEVOR die Länge geprüft wurde –
// quadratisch (80.000 Leerzeichen in der Mitte: über 8 s). Der Editor gibt Eingaben der Nutzer hierher (bis 20 MB).
test('parseTarget: huge inputs are refused at once (no quadratic trimming)', () => {
  const start = Date.now();
  for (const s of ['x' + ' '.repeat(80_000) + 'x', ' '.repeat(200_000) + 'https://example.com/', 'https://example.com/' + '\t'.repeat(200_000) + '.']) {
    const r = parseTarget(s, policy());
    assert.equal(r.ok, false);
    assert.equal(r.ok ? '' : r.code, 'long');
  }
  assert.ok(Date.now() - start < 300, `took ${Date.now() - start} ms`);
  // Leerraum außen zählt nicht zur Länge
  const r = parseTarget(' '.repeat(600) + 'example.com\n', policy());
  assert.ok(r.ok && r.url === 'https://example.com/');
});

// Prüfbericht: os.networkInterfaces() wirft in einer Sandbox ohne Netlink (RestrictAddressFamilies) – die Richtlinie
// des Prüfdienstes darf daran nicht scheitern; dann gelten die eigenen Adressen aus config.json (status.self_ips).
test('own addresses: a failing interface list falls back to the configured addresses', () => {
  const failing = (): never => {
    throw new Error('uv_interface_addresses returned Unknown system error 97');
  };
  assert.deepEqual(interfaceAddresses(failing), []);
  assert.deepEqual(interfaceAddresses(() => ({
    lo: [{ address: '127.0.0.1', internal: true }], eth0: [{ address: '93.184.216.34', internal: false }, { address: 'fe80::1%eth0', internal: false }],
  })), ['93.184.216.34']);
  const p = runtimePolicy(statusSettingsFrom({}), { ...statusServerConfigDefaults(), self_ips: [SELF_V4] }, interfaceAddresses(failing));
  assert.equal(ipVerdict(SELF_V4, 8080, p).ok, false, 'the configured own address is still refused');
});
