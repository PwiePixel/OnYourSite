// Statusseiten: Namensauflösung über eigene Resolver (resolver.ts) mit einem kleinen DNS-Server auf einem zufälligen
// UDP-Port: gemischte Antworten, CNAME auf private Adressen, TTL und negatives Zwischenspeichern, IPv4 zuerst,
// SERVFAIL/Zeitüberschreitung als Ausfall des Resolvers (vorübergehend) und der Resolver-Kanarienvogel.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PublicResolver, dnsOutcome, resolverCanary } from '../src/status/resolver.js';
import { addressList, type GuardPolicy } from '../src/status/guard.js';
import { startDns, type FakeDns } from './helpers/dnsServer.js';

let dns: FakeDns;
let dead: FakeDns;
let clock = 1_800_000_000_000;
const now = (): number => clock;

const policy = (tunnel = false): GuardPolicy => ({ ports: [80, 443, 8080, 8443], tunnel, self: addressList(['93.184.216.34']) });

before(async () => {
  dns = await startDns({
    'public.zz': { A: ['8.8.8.8', '8.8.4.4'], AAAA: ['2606:4700:4700::1111'], ttl: 120 },
    'mixed.zz': { A: ['8.8.8.8', '10.0.0.7'] },
    'mixed6.zz': { A: ['8.8.8.8'], AAAA: ['::1'] },
    'alias.zz': { CNAME: 'inside.zz' },
    'inside.zz': { A: ['192.168.1.10'] },
    'alias-ok.zz': { CNAME: 'public.zz' },
    'six.zz': { AAAA: ['2606:4700:4700::1001'] },
    'long.zz': { A: ['1.1.1.1'], ttl: 3600 },
    'empty.zz': {},
    'broken.zz': { rcode: 2 },
    'slow.zz': { drop: true },
    'self.zz': { A: ['93.184.216.34'] },
    'meta.zz': { A: ['169.254.169.254'] },
    'nat64.zz': { AAAA: ['64:ff9b::a9fe:a9fe'] },
  });
  dead = await startDns({});
  await dead.stop();
});

after(async () => {
  await dns.stop();
});

const make = (servers = [dns.server], extra = {}): PublicResolver =>
  new PublicResolver({ servers, timeoutMs: 300, tries: 1, now, ...extra });

test('public answers: IPv4 first, every address checked, CNAMEs followed', async () => {
  const r = make();
  const ok = await r.resolvePublic('public.zz', 443, policy());
  assert.deepEqual(ok, { ok: true, family: 4, addresses: ['8.8.8.8', '8.8.4.4'], ttl: 120 });
  assert.deepEqual(await r.resolvePublic('six.zz', 443, policy()), { ok: true, family: 6, addresses: ['2606:4700:4700::1001'], ttl: 300 });
  const viaAlias = await r.resolvePublic('alias-ok.zz', 443, policy());
  assert.equal(viaAlias.ok, true);
  assert.equal(viaAlias.ok && viaAlias.family, 4);
});

test('one private address anywhere blocks the host', async () => {
  const r = make();
  assert.deepEqual(await r.resolvePublic('mixed.zz', 443, policy()), { ok: false, error: 'blocked', address: '10.0.0.7' });
  // auch in der Familie, die gar nicht benutzt würde
  assert.deepEqual(await r.resolvePublic('mixed6.zz', 443, policy()), { ok: false, error: 'blocked', address: '::1' });
  assert.deepEqual(await r.resolvePublic('alias.zz', 443, policy()), { ok: false, error: 'blocked', address: '192.168.1.10' });
  assert.deepEqual(await r.resolvePublic('meta.zz', 80, policy()), { ok: false, error: 'blocked', address: '169.254.169.254' });
  assert.deepEqual(await r.resolvePublic('nat64.zz', 80, policy()), { ok: false, error: 'blocked', address: '64:ff9b::a9fe:a9fe' });
  // eigene Adresse: ohne Tunnel auf 443 erlaubt, mit Tunnel nie, ohne Tunnel nicht auf 8080
  assert.equal((await r.resolvePublic('self.zz', 443, policy(false))).ok, true);
  assert.deepEqual(await r.resolvePublic('self.zz', 443, policy(true)), { ok: false, error: 'blocked', address: '93.184.216.34' });
  assert.deepEqual(await r.resolvePublic('self.zz', 8080, policy(false)), { ok: false, error: 'blocked', address: '93.184.216.34' });
});

test('IP literals are checked directly, without a query', async () => {
  const r = make([dead.server]);
  assert.deepEqual(await r.resolvePublic('8.8.8.8', 443, policy()), { ok: true, family: 4, addresses: ['8.8.8.8'], ttl: 0 });
  assert.deepEqual(await r.resolvePublic('2606:4700:4700::1111', 443, policy()), { ok: true, family: 6, addresses: ['2606:4700:4700::1111'], ttl: 0 });
  assert.deepEqual(await r.resolvePublic('127.0.0.1', 443, policy()), { ok: false, error: 'blocked', address: '127.0.0.1' });
});

test('answers are cached for min(TTL, 300 s), NXDOMAIN and empty answers for 60 s', async () => {
  const r = make();
  const count = (key: string): number => dns.queries.get(key) ?? 0;
  const base = count('long.zz/A');
  await r.resolvePublic('long.zz', 443, policy());
  await r.resolvePublic('long.zz', 443, policy());
  assert.equal(count('long.zz/A'), base + 1);
  clock += 299_000;
  await r.resolvePublic('long.zz', 443, policy());
  assert.equal(count('long.zz/A'), base + 1, 'still cached after 299 s');
  clock += 2_000;
  await r.resolvePublic('long.zz', 443, policy());
  assert.equal(count('long.zz/A'), base + 2, 'a TTL of one hour is capped at 300 s');

  const nx = await r.resolvePublic('missing.zz', 443, policy());
  assert.deepEqual(nx, { ok: false, error: 'dns', failure: 'nxdomain', transient: false });
  const nodata = await r.resolvePublic('empty.zz', 443, policy());
  assert.deepEqual(nodata, { ok: false, error: 'dns', failure: 'nodata', transient: false });
  const before = count('missing.zz/A');
  clock += 59_000;
  await r.resolvePublic('missing.zz', 443, policy());
  assert.equal(count('missing.zz/A'), before, 'negative answers stay 60 s');
  clock += 2_000;
  await r.resolvePublic('missing.zz', 443, policy());
  assert.equal(count('missing.zz/A'), before + 1);
});

test('SERVFAIL and timeouts are failures of the resolver: transient, cached only 10 s, counted in the health', async () => {
  const r = make();
  const sf = await r.resolvePublic('broken.zz', 443, policy());
  assert.deepEqual(sf, { ok: false, error: 'dns', failure: 'servfail', transient: true });
  assert.equal(r.health().failures, 1);
  const slow = await r.resolvePublic('slow.zz', 443, policy());
  assert.deepEqual(slow, { ok: false, error: 'dns', failure: 'timeout', transient: true });
  assert.equal(r.health().failures, 2);
  const before = dns.queries.get('broken.zz/A') ?? 0;
  clock += 9_000;
  await r.resolvePublic('broken.zz', 443, policy());
  assert.equal(dns.queries.get('broken.zz/A'), before, 'cached within 10 s');
  clock += 2_000;
  await r.resolvePublic('broken.zz', 443, policy());
  assert.equal(dns.queries.get('broken.zz/A'), before + 1);
  // eine Antwort setzt die Folge zurück
  await r.resolvePublic('public.zz', 443, policy());
  assert.equal(r.health().failures, 0);
  assert.ok(r.health().okAt !== null && r.health().failAt !== null);

  const gone = make([dead.server]);
  const down = await gone.resolvePublic('public.zz', 443, policy());
  assert.equal(down.ok, false);
  assert.equal(!down.ok && down.error === 'dns' && down.transient, true);
});

test('dnsOutcome: a resolver failure counts against the target only while the resolver canary answers', () => {
  assert.equal(dnsOutcome({ ok: false, error: 'dns', failure: 'timeout', transient: true }, true), 'dns');
  assert.equal(dnsOutcome({ ok: false, error: 'dns', failure: 'timeout', transient: true }, false), 'internal');
  assert.equal(dnsOutcome({ ok: false, error: 'dns', failure: 'servfail', transient: true }, false), 'internal');
  // NXDOMAIN ist eine Antwort – immer das Problem des Ziels
  assert.equal(dnsOutcome({ ok: false, error: 'dns', failure: 'nxdomain', transient: false }, false), 'dns');
});

test('concurrent lookups of one host share a query', async () => {
  const r = make();
  dns.zone.set('shared.zz', { A: ['9.9.9.9'] });
  const results = await Promise.all(Array.from({ length: 20 }, () => r.resolvePublic('shared.zz', 443, policy())));
  assert.ok(results.every((x) => x.ok));
  assert.equal(dns.queries.get('shared.zz/A'), 1);
});

test('the resolver canary asks every resolver on its own', async () => {
  assert.deepEqual(await resolverCanary([dns.server], ['public.zz', 'missing.zz'], 300), { ok: true, answered: 1, of: 1 });
  assert.deepEqual(await resolverCanary([dead.server, dns.server], ['public.zz'], 300), { ok: true, answered: 1, of: 2 });
  assert.deepEqual(await resolverCanary([dead.server], ['public.zz'], 300), { ok: false, answered: 0, of: 1 });
  // NXDOMAIN ist eine Antwort, SERVFAIL nicht
  assert.deepEqual(await resolverCanary([dns.server], ['missing.zz'], 300), { ok: true, answered: 1, of: 1 });
  assert.deepEqual(await resolverCanary([dns.server], ['broken.zz', 'slow.zz'], 300), { ok: false, answered: 0, of: 1 });
});
