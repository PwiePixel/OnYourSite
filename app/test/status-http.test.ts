// Statusseiten, eine HTTP(S)-Prüfung (http.ts) gegen lokale Testserver: Namen löst ein Test-DNS nach 127.0.0.1 auf,
// die Test-Richtlinie erlaubt nur 127.0.0.1 auf den beiden Test-Ports (der Dienst selbst hat keine solche Ausnahme).
// Geprüft: 200/500/503/429/403, Zeitlimit, langsam, Stichwort (auch gepackt), kein Text, Gzip-Bombe, Weiterleitungen
// (Kette, 303, Schleife, zu viele, auf private Adressen), Zertifikate (gültig, bald ablaufend, abgelaufen, falscher
// Name, nicht vertrauenswürdig, tls_ignore), private Adressen aus dem DNS, nur IPv6, Eimer je IP, Abbruch, Kopfzeilen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { addressList, type GuardPolicy } from '../src/status/guard.js';
import { expectMatches, parseExpect, retryAfterSeconds, runHttpCheck, type HttpCheckInput, type HttpDeps } from '../src/status/http.js';
import { PublicResolver } from '../src/status/resolver.js';
import { startDns, type FakeDns } from './helpers/dnsServer.js';
import { hasOpenssl, testPki, type TestPki } from './helpers/certs.js';
import { startTargets, type Targets } from './helpers/targets.js';

let dns: FakeDns;
let pki: TestPki;
let t: Targets;
const UA = 'OnYourSite-Monitor/1.0 (+http://oys.test:8080/terms/status-pages#checks)';
const skip = !hasOpenssl();

before(async () => {
  if (skip) return;
  pki = testPki();
  const site = pki.leaf(['site.zz', '*.site.zz']);
  t = await startTargets({
    byName: new Map([
      ['site.zz', site], ['*.site.zz', site],
      ['soon.zz', pki.leaf(['soon.zz'], { days: 10 })],
      ['old.zz', pki.leaf(['old.zz'], { start: '20200101000000Z', end: '20200102000000Z' })],
    ]),
    fallback: site,
  });
  dns = await startDns({
    'site.zz': { A: ['127.0.0.1'] }, 'www.site.zz': { A: ['127.0.0.1'] }, 'soon.zz': { A: ['127.0.0.1'] }, 'old.zz': { A: ['127.0.0.1'] },
    'wrong.zz': { A: ['127.0.0.1'] }, 'evil.zz': { A: ['10.0.0.1'] }, 'six.zz': { AAAA: ['2606:4700:4700::1111'] },
  });
});

after(async () => {
  if (skip) return;
  await t.close();
  await dns.stop();
  pki.done();
});

function deps(o: Partial<HttpDeps> = {}): HttpDeps {
  const policy: GuardPolicy = {
    ports: [80, 443, t.httpPort, t.httpsPort],
    tunnel: false,
    self: addressList([]),
    testAllow: (ip, port) => ip === '127.0.0.1' && (port === t.httpPort || port === t.httpsPort),
  };
  return {
    policy,
    resolver: new PublicResolver({ servers: [dns.server], timeoutMs: 500, tries: 1 }),
    now: Date.now,
    ipv6: true,
    userAgent: UA,
    ca: pki.ca,
    ...o,
  };
}

const http = (path: string, host = 'site.zz'): string => `http://${host}:${t.httpPort}${path}`;
const https = (path: string, host = 'site.zz'): string => `https://${host}:${t.httpsPort}${path}`;
const input = (url: string, o: Partial<HttpCheckInput> = {}): HttpCheckInput => ({
  url, method: 'GET', expect: '200-299', keyword: '', keywordMode: 'contains', keywordCase: false, timeoutSec: 5, redirects: true,
  tlsIgnore: false, slowMs: 0, keywordKb: 512, ...o,
});

test('expected status codes and Retry-After', () => {
  assert.deepEqual(parseExpect('200-299,301, 401'), [[200, 299], [301, 301], [401, 401]]);
  for (const bad of ['', '200-', '99', '600', '300-200', 'abc', Array.from({ length: 11 }, () => '200').join(',')]) assert.equal(parseExpect(bad), null, bad);
  assert.equal(expectMatches(301, parseExpect('200-299,301') ?? []), true);
  assert.equal(expectMatches(302, parseExpect('200-299,301') ?? []), false);
  assert.equal(retryAfterSeconds('120', 0), 120);
  assert.equal(retryAfterSeconds(new Date(60_000).toUTCString(), 0), 60);
  assert.equal(retryAfterSeconds('soon', 0), null);
  assert.equal(retryAfterSeconds(undefined, 0), null);
});

test('status codes: 200 ok, 500 and 503 fail (503 with Retry-After), 429 delays, 403 counts as refused', { skip }, async () => {
  const ok = await runHttpCheck(input(http('/ok')), deps());
  assert.equal(ok.kind, 'ok');
  assert.equal(ok.code, 200);
  assert.ok(ok.ms !== null && ok.ms >= 0);
  assert.equal(ok.ip, '127.0.0.1');
  const e500 = await runHttpCheck(input(http('/500')), deps());
  assert.deepEqual([e500.kind, e500.error, e500.code], ['fail', 'status', 500]);
  const e503 = await runHttpCheck(input(http('/503')), deps());
  assert.deepEqual([e503.kind, e503.error, e503.code, e503.retryAfter], ['fail', 'status', 503, 600]);
  const e429 = await runHttpCheck(input(http('/429')), deps());
  assert.deepEqual([e429.kind, e429.code, e429.retryAfter, e429.refused], ['delayed', 429, 120, true]);
  const e403 = await runHttpCheck(input(http('/403')), deps());
  assert.deepEqual([e403.kind, e403.error, e403.refused], ['fail', 'status', true]);
  // erwartete Codes können auch Fehlercodes sein
  assert.equal((await runHttpCheck(input(http('/403'), { expect: '403' }), deps())).kind, 'ok');
  // HEAD bleibt HEAD
  const head = await runHttpCheck(input(http('/ok'), { method: 'HEAD' }), deps());
  assert.equal(head.kind, 'ok');
  assert.equal(t.seen[t.seen.length - 1].method, 'HEAD');
});

test('time limit, slow answers and the request headers', { skip }, async () => {
  const started = Date.now();
  const hang = await runHttpCheck(input(http('/hang'), { timeoutSec: 1 }), deps());
  assert.deepEqual([hang.kind, hang.error], ['fail', 'timeout']);
  assert.ok(Date.now() - started < 3000);
  // ein blockierter Takt bei uns: zählt nicht gegen das Ziel
  assert.equal((await runHttpCheck(input(http('/hang'), { timeoutSec: 1 }), deps({ loopBlocked: () => true }))).kind, 'internal');
  const slow = await runHttpCheck(input(http('/slow'), { slowMs: 100 }), deps());
  assert.deepEqual([slow.kind, slow.slow], ['ok', true]);
  assert.equal((await runHttpCheck(input(http('/slow'), { slowMs: 5000 }), deps())).slow, false);
  const seen = t.seen.filter((s) => s.path === '/slow').at(-1);
  assert.equal(seen?.headers['user-agent'], UA);
  assert.equal(seen?.headers['accept-encoding'], 'identity');
  assert.equal(seen?.headers.connection, 'close');
  assert.equal(seen?.headers['cache-control'], 'no-cache');
  assert.equal(seen?.headers.cookie, undefined);
  assert.equal(seen?.host, 'site.zz');
});

test('keywords: present, absent, case, packed, not text, and a gzip bomb stops at keyword_kb', { skip }, async () => {
  const k = (o: Partial<HttpCheckInput>, path = '/keyword') => runHttpCheck(input(http(path), o), deps());
  assert.equal((await k({ keyword: 'GREEN' })).kind, 'ok');
  assert.equal((await k({ keyword: 'green' })).kind, 'ok', 'case-insensitive by default');
  assert.equal((await k({ keyword: 'green', keywordCase: true })).error, 'keyword');
  assert.equal((await k({ keyword: 'RED' })).error, 'keyword');
  assert.equal((await k({ keyword: 'RED', keywordMode: 'absent' })).kind, 'ok');
  assert.equal((await k({ keyword: 'GREEN', keywordMode: 'absent' })).error, 'keyword_found');
  assert.equal((await k({ keyword: 'GREEN' }, '/keyword-gzip')).kind, 'ok');
  assert.equal((await k({ keyword: 'x' }, '/binary')).error, 'keyword_type');
  assert.equal(t.seen.filter((s) => s.path === '/keyword').at(-1)?.headers['accept-encoding'], 'gzip, deflate, br');
  const before = process.memoryUsage().rss;
  const started = Date.now();
  const bomb = await k({ keyword: 'never-there', keywordKb: 512 }, '/bomb');
  assert.equal(bomb.error, 'keyword');
  assert.ok(Date.now() - started < 3000, 'stops reading early');
  assert.ok(process.memoryUsage().rss - before < 64 * 1024 * 1024, 'does not unpack 30 MB');
});

test('redirects: a chain, 303 becomes GET, loops, too many, to a private or local address, and switched off', { skip }, async () => {
  assert.equal((await runHttpCheck(input(http('/redirect/3')), deps())).kind, 'ok');
  const seeOther = await runHttpCheck(input(http('/redirect/see-other'), { method: 'HEAD' }), deps());
  assert.equal(seeOther.kind, 'ok');
  assert.equal(t.seen.at(-1)?.method, 'GET');
  assert.equal((await runHttpCheck(input(http('/redirect/loop')), deps())).error, 'redirect');
  assert.equal((await runHttpCheck(input(http('/redirect/7')), deps())).error, 'redirect');
  assert.equal((await runHttpCheck(input(http('/redirect/5')), deps())).kind, 'ok', 'five hops are fine');
  assert.equal((await runHttpCheck(input(http('/redirect/private')), deps())).error, 'redirect_blocked');
  assert.equal((await runHttpCheck(input(http('/redirect/local')), deps())).error, 'redirect_blocked');
  const off = await runHttpCheck(input(http('/redirect/2'), { redirects: false }), deps());
  assert.deepEqual([off.error, off.code], ['status', 302]);
  assert.equal((await runHttpCheck(input(http('/redirect/2'), { redirects: false, expect: '302' }), deps())).kind, 'ok');
});

test('certificates: valid with expiry, soon expiring, expired, wrong name, not trusted, tls_ignore', { skip }, async () => {
  const now = Math.floor(Date.now() / 1000);
  const ok = await runHttpCheck(input(https('/ok')), deps());
  assert.equal(ok.kind, 'ok');
  assert.ok(ok.certExpires !== null && ok.certExpires > now + 80 * 86400);
  const sub = await runHttpCheck(input(https('/ok', 'www.site.zz')), deps());
  assert.equal(sub.kind, 'ok');
  const soon = await runHttpCheck(input(https('/ok', 'soon.zz')), deps());
  assert.ok(soon.certExpires !== null && soon.certExpires < now + 11 * 86400);
  assert.equal((await runHttpCheck(input(https('/ok', 'old.zz')), deps())).error, 'tls_expired');
  assert.equal((await runHttpCheck(input(https('/ok', 'wrong.zz')), deps())).error, 'tls_name');
  assert.equal((await runHttpCheck(input(https('/ok')), deps({ ca: undefined }))).error, 'tls_untrusted');
  const ignored = await runHttpCheck(input(https('/ok', 'old.zz'), { tlsIgnore: true }), deps());
  assert.equal(ignored.kind, 'ok');
  assert.ok(ignored.certExpires !== null && ignored.certExpires < now, 'the expiry is still read');
});

test('addresses: private answers from DNS, unknown names, IPv6 without IPv6, no allowance, the IP bucket, abort', { skip }, async () => {
  assert.equal((await runHttpCheck(input(`http://evil.zz:${t.httpPort}/`), deps())).error, 'blocked');
  const nx = await runHttpCheck(input(`http://missing.zz:${t.httpPort}/`), deps());
  assert.deepEqual([nx.error, nx.dnsTransient], ['dns', false]);
  assert.equal((await runHttpCheck(input(`http://six.zz:${t.httpPort}/`), deps({ ipv6: false }))).error, 'ipv6');
  // Ohne die Ausnahme der Tests ist 127.0.0.1 gesperrt – auch über einen Namen
  const strict = deps();
  strict.policy = { ...strict.policy, testAllow: undefined };
  assert.equal((await runHttpCheck(input(http('/ok')), strict)).error, 'blocked');
  assert.equal((await runHttpCheck(input(`http://127.0.0.1:${t.httpPort}/ok`), strict)).error, 'blocked');
  // Eimer je IP: warten statt prüfen
  const throttled = await runHttpCheck(input(http('/ok')), deps({ takeIp: () => 1500 }));
  assert.deepEqual([throttled.kind, throttled.wait], ['throttled', 1500]);
  // Abbruch von außen (Sperre verloren): unsere Seite
  const ctrl = new AbortController();
  const pending = runHttpCheck(input(http('/hang'), { timeoutSec: 10 }), deps({ signal: ctrl.signal }));
  setTimeout(() => ctrl.abort(), 100);
  assert.equal((await pending).kind, 'internal');
});

test('robots.txt reading: same host only, body capped', { skip }, async () => {
  t.robots.set('site.zz', { status: 200, body: 'User-agent: OnYourSite-Monitor\nDisallow: /private\n' });
  const r = await runHttpCheck(input(http('/robots.txt'), { expect: '100-599', readBody: 64 * 1024, sameHostOnly: true }), deps());
  assert.equal(r.kind, 'ok');
  assert.match(r.body ?? '', /Disallow: \/private/);
  const cross = await runHttpCheck(input(http('/redirect/private'), { expect: '100-599', readBody: 1024, sameHostOnly: true }), deps());
  assert.equal(cross.error, 'redirect_blocked');
});
