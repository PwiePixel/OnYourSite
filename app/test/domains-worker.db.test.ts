// Domain-Dienst gegen nachgebaute Dienste (premium-domains PD-3): echte Datenbank, Cloudflare for SaaS als Nachbau
// (support/cfSaasMock), DoH mit zwei Resolvern (support/dohMock) und eine HTTPS-„Kante“ mit Test-CA, die jede Anfrage
// mit unverändertem Host an die echte App weiterleitet (support/testEdge) – die Prüfung läuft bis zur Antwort von
// /_/domain-check. Geprüft: TXT → Hostname → live mit genau einer Glocke und einer Mail, Wegzeigen (sofort gelöscht,
// nie an die Adresse des Nutzers verbunden) und „wieder da“, DNS-Fehler (20 und 35 Minuten), der Schutzschalter (eigener
// Ausfall, Massenfehler), Premium-Ende mit und ohne Weiterleitung, die Frist, Admin-Rolle weg, das Mail-Budget, 429 und
// Ausfälle bei Cloudflare, Warteschlange und Kontingent, fremder Nachweis, Entfernen während des Anlegens, die Liste
// alle 10 Minuten, verwaiste Hostnamen, das Token, nur ein Dienst gleichzeitig und die Gesundheit. Jede Anfrage über
// fetch muss an die Nachbauten gehen – nie an Cloudflare oder einen öffentlichen Resolver.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, setConfigForTests, type ConfigData } from '../src/config.js';
import { exec, q, transaction, value } from '../src/db.js';
import { buildServer } from '../src/server.ts';
import { nowStr, toUnix } from '../src/honeycombs/clock.js';
import { poolDb } from '../src/honeycombs/util.js';
import { toggleAdmin } from '../src/admin/users.js';
import { LeaderLock } from '../src/status/lock.js';
import {
  capacity, createDomain, domainById, health, ownershipToken, reconcileUser, removeDomain, requestWorker, saveDomainSettings, transition, workerState,
  type DomainRow,
} from '../src/domains/index.js';
import { logEvent } from '../src/domains/store.js';
import { adminAlert } from '../src/domains/notify.js';
import { DOMAIN_SETTINGS_DEFAULTS, type DomainSettings } from '../src/domains/settings.js';
import { DomainWorker } from '../src/domains/worker/worker.js';
import { runDomainWorker } from '../src/domains/worker/main.js';
import { cloudflareFromConfig } from '../src/domains/worker/cloudflare.js';
import { dohFromConfig } from '../src/domains/worker/dns.js';
import type { DomainMail } from '../src/domains/worker/mail.js';
import { hasOpenssl, testPki, type TestPki } from './helpers/certs.js';
import { startCfSaasMock, type CfSaasMock } from './support/cfSaasMock.js';
import { startDohMock, type DohMock } from './support/dohMock.js';
import { startTestEdge, type Forwarded, type TestEdge } from './support/testEdge.js';
import { testDatabase, type TestDb } from './coreHarness.js';

const skip = !hasOpenssl();
let t: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let cf: CfSaasMock;
let dns: DohMock;
let edge: TestEdge;
let pki: TestPki;
let dir: string;
let w: DomainWorker;
let trap: NetServer | null = null;
let trapHits = 0;
let sendOk = true;
// Läuft, nachdem die App eine Anfrage über die Kante beantwortet hat (für Änderungen während einer Prüfung)
let afterForward: ((host: string, path: string) => Promise<void>) | null = null;
const mails: DomainMail[] = [];
const logs: string[] = [];
const foreign: string[] = [];
const realFetch = globalThis.fetch;

const HOST = 'links.example.com'; // mia (Konto 5, Seite 2)
const TOM = 'go.example.org'; // tom (6, Seite 3)
const LEA = 'lea.example.net'; // lea (7, Seite 4)
const PIXEL = 'pixel.example.com'; // Admin (3, Seite 1)
const ids = { mia: 0, tom: 0, lea: 0, pixel: 0 };
const DAY = 86400;

const nowSec = (): number => Math.floor(Date.now() / 1000);
const ago = (sec: number): string => nowStr(nowSec() - sec);
const later = (sec: number): string => nowStr(nowSec() + sec);
const untilNext = (r: DomainRow): number => toUnix(String(r.next_check_at)) - nowSec();

async function row(id: number): Promise<DomainRow> {
  const r = await domainById(id);
  assert.ok(r, `domain #${id} exists`);
  return r;
}
const gone = async (id: number): Promise<boolean> => (await domainById(id)) === null;
const events = async (id: number): Promise<string[]> =>
  (await q('SELECT event FROM custom_domain_log WHERE domain_id = ? ORDER BY id', [id])).map((r) => String(r.event));
const bells = async (uid: number, type: string): Promise<number> =>
  Number(await value('SELECT COUNT(*) FROM notifications WHERE user_id = ? AND type = ?', [uid, type]));
const pageDomain = (pageId: number): Promise<unknown> => value('SELECT custom_domain FROM pages WHERE id = ?', [pageId]);
const pendingMails = async (): Promise<number> => Number(await value('SELECT COUNT(*) FROM custom_domain_log WHERE mail = 1 AND mailed_at IS NULL AND mail_tries < 5'));
const mailed = (to: string, title: string): DomainMail[] => mails.filter((m) => m.to === to && m.title === title);
const onCf = (hostname: string): { id: string } | null => [...cf.hostnames.values()].find((h) => h.hostname === hostname) ?? null;
const settings = (change: Partial<DomainSettings>): Promise<DomainSettings> => saveDomainSettings({ ...DOMAIN_SETTINGS_DEFAULTS, enabled: true, ...change });

// Spalten direkt setzen (Zeit „vorspulen“, ohne die Uhr zu fälschen); version bleibt
async function setRow(id: number, set: Record<string, string | number | null>): Promise<void> {
  await exec(`UPDATE custom_domains SET ${Object.keys(set).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...Object.values(set), id]);
}

async function newPage(uid: number, slug: string): Promise<number> {
  const res = await exec('INSERT INTO pages (user_id, slug, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [uid, slug, slug, nowStr(), nowStr()]);
  return res.insertId;
}

// Der Name zeigt auf uns (CNAME auf das Ziel) und trägt den TXT-Nachweis des Kontos
function pointToUs(hostname: string, uid: number): void {
  dns.records.set(hostname, { CNAME: 'edge.oys.test' });
  dns.records.set('_onyoursite.' + hostname, { TXT: [ownershipToken(uid, hostname)] });
}

// Die Kante leitet an die echte App weiter (Fastify inject, Host unverändert)
async function forward(host: string, path: string, method: string): Promise<Forwarded> {
  const res = await app.inject({ method: method as 'GET', url: path, headers: { host } });
  const hook = afterForward;
  if (hook) await hook(host, path);
  const headers: Record<string, string> = {};
  for (const k of ['content-type', 'location', 'cache-control', 'x-robots-tag']) {
    const v = res.headers[k];
    if (typeof v === 'string') headers[k] = v;
  }
  return { status: res.statusCode, headers, body: res.body };
}

const newWorker = (): DomainWorker => new DomainWorker({
  cf: cloudflareFromConfig(), doh: dohFromConfig(),
  send: async (m) => {
    if (!sendOk) return false;
    mails.push(m);
    return true;
  },
  log: (line) => void logs.push(line),
});

// Hinzufügen und bis live bringen (wie im Betrieb, nur ohne auf den Zeitplan zu warten)
async function bringLive(hostname: string, pageId: number, uid: number): Promise<number> {
  pointToUs(hostname, uid);
  const id = await createDomain({ hostname, targetId: pageId, userId: uid });
  await w.check(id);
  assert.equal((await row(id)).state, 'pending', hostname);
  cf.set(hostname, { status: 'active', ssl: 'active' });
  await w.check(id);
  const r = await row(id);
  assert.equal(r.state, 'active', `${hostname}: ${String(r.problem)} ${String(r.problem_detail)}`);
  return id;
}

before(async () => {
  if (skip) return;
  t = await testDatabase('pd3worker');
  cf = await startCfSaasMock();
  dns = await startDohMock();
  pki = testPki();
  dir = mkdtempSync(join(tmpdir(), 'oys-pd3-'));
  writeFileSync(join(dir, 'ca.pem'), pki.ca);
  // Das Token nur in einer Datei (wie das systemd-Credential), zur Laufzeit vom Nachbau erzeugt
  writeFileSync(join(dir, 'cf_saas_token'), cf.token + '\n', { mode: 0o600 });
  edge = await startTestEdge(pki, forward);
  const cfg: ConfigData = {
    ...loadConfig(), base_domain: 'oys.test:8080', scheme: 'http',
    cloudflare: { zone_id: cf.zone, api_base: cf.base },
    custom_domains: {
      cname_target: 'edge.oys.test', fallback_origin: 'origin.oys.test', url_port: ':8080', doh: dns.urls, edge_ips: ['127.0.0.1'],
      probe_port: edge.port, probe_ca: join(dir, 'ca.pem'), token_file: join(dir, 'cf_saas_token'),
    },
  };
  setConfigForTests(cfg);
  // Jede Anfrage über fetch (Cloudflare, DoH) muss an einen Nachbau auf 127.0.0.1 gehen
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('http://127.0.0.1:')) foreign.push(url);
    return realFetch(input, init);
  }) as typeof fetch;
  app = await buildServer();
  for (const z of ['example.com', 'example.org', 'example.net', 'oys.test']) dns.zones.add(z);
  dns.records.set('edge.oys.test', { A: ['127.0.0.1'] });
  await settings({});
  await exec('UPDATE users SET premium_until = ? WHERE id IN (5, 6, 7, 8)', [later(30 * DAY)]);
  w = newWorker();
});

after(async () => {
  if (skip) return;
  globalThis.fetch = realFetch;
  await app.close();
  await edge.close();
  await cf.close();
  await dns.close();
  const tr = trap;
  if (tr) await new Promise<void>((resolve) => tr.close(() => resolve()));
  pki.done();
  rmSync(dir, { recursive: true, force: true });
  await t.done();
});

test('TXT found → hostname at Cloudflare → live: one bell, one mail, the page’s main address; nothing twice', { skip }, async () => {
  pointToUs(HOST, 5);
  const id = (ids.mia = await createDomain({ hostname: HOST, targetId: 2, userId: 5 }));
  // Noch nicht fällig (erste Prüfung nach 10 Minuten)
  assert.equal(await w.runDue(), 0);
  // Selbsttest: unsere eigene Domain antwortet über dieselbe Kante
  await w.minute();
  const st = await workerState();
  assert.equal(st.control?.ok, true, JSON.stringify(st.control));
  assert.equal(st.freeze, null);
  assert.ok(edge.requests.some((r) => r.host === 'oys.test' && r.path === '/_/domain-check'));

  await setRow(id, { next_check_at: ago(1) });
  assert.equal(await w.runDue(), 1);
  let r = await row(id);
  assert.equal(r.state, 'pending', String(r.problem));
  assert.deepEqual([r.zone_name, Number(r.is_apex), r.problem], ['example.com', 0, '']);
  assert.equal(onCf(HOST)?.id, r.cf_id, 'the hostname exists at Cloudflare and its ID is stored');
  const post = cf.calls.find((c) => c.method === 'POST');
  assert.deepEqual((post?.body as { ssl?: unknown }).ssl, { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } });
  assert.ok(untilNext(r) >= 5 && untilNext(r) <= 11, `read again 10 s after creating (${untilNext(r)} s)`);
  assert.equal(await pageDomain(2), null, 'no main address before it is live');

  // Noch kein Zertifikat: pending, keine Prüfung über die Kante; danach jede Minute
  const probes = edge.requests.filter((x) => x.host === HOST).length;
  await w.check(id);
  r = await row(id);
  assert.deepEqual([r.state, r.problem], ['pending', 'cf_pending']);
  assert.ok(untilNext(r) >= 50 && untilNext(r) <= 61, `checks every minute while it is set up (${untilNext(r)} s)`);
  assert.equal(edge.requests.filter((x) => x.host === HOST).length, probes, 'no probe before the certificate is active');

  // Zertifikat ausgestellt → live
  cf.set(HOST, { status: 'active', ssl: 'active' });
  await w.check(id);
  r = await row(id);
  assert.equal(r.state, 'active', `${String(r.problem)} ${String(r.problem_detail)}`);
  assert.equal(await pageDomain(2), HOST);
  assert.ok(edge.requests.some((x) => x.host === HOST && x.path === '/_/domain-check'), 'probed through the edge with the domain as Host and SNI');
  assert.match(String(r.cert_expires_at), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.ok(untilNext(r) > 0 && untilNext(r) <= 600, 'live: every 10 minutes');
  assert.equal(await bells(5, 'domain_live'), 1);

  // Nichts doppelt: weitere Prüfungen und Minuten
  await w.check(id);
  await w.minute();
  await w.minute();
  assert.equal(await bells(5, 'domain_live'), 1);
  const live = mailed('mia@test.de', 'Your domain is live');
  assert.equal(live.length, 1);
  assert.match(live[0].text, /^links\.example\.com now shows your page “Mia/);
  assert.match(live[0].url, /\/dashboard\?page=2#settings\/domain$/);
  assert.equal(live[0].button, 'Open the editor');
  assert.deepEqual(await events(id), ['added', 'cf_created', 'txt_ok', 'active', 'domain_live']);
  assert.equal(await pendingMails(), 0);
  assert.ok(!logs.join('\n').includes(cf.token), 'the token is never logged');
});

test('pointing elsewhere: never probed at that address; two definite failures 10 minutes apart → broken, the hostname goes at once; back → a new hostname and “back online”', { skip }, async () => {
  const id = ids.mia;
  // Falle auf der Adresse aus dem DNS des Nutzers (Port der Kante): die Prüfung verbindet sich nie dorthin
  trap = await new Promise<NetServer | null>((resolve) => {
    const s = createNetServer((sock) => {
      trapHits++;
      sock.destroy();
    });
    s.once('error', () => resolve(null));
    s.listen(edge.port, '127.0.0.2', () => resolve(s));
  });
  dns.records.set(HOST, { A: ['127.0.0.2'] });
  await w.check(id);
  let r = await row(id);
  assert.deepEqual([r.state, Number(r.fail_count), r.problem], ['active', 1, 'a_records']);
  // Zweiter Fehler zu früh (unter 10 Minuten): bleibt live
  await w.check(id);
  r = await row(id);
  assert.deepEqual([r.state, Number(r.fail_count)], ['active', 2]);
  await setRow(id, { fail_since: ago(11 * 60) });
  const oldCf = String(r.cf_id);
  await w.check(id);
  r = await row(id);
  assert.deepEqual([r.state, r.cf_id, r.problem], ['broken', null, 'a_records']);
  assert.equal(cf.hostnames.has(oldCf), false, 'deleted at once (it would keep catching the domain)');
  assert.equal(await pageDomain(2), null);
  assert.equal(await bells(5, 'domain_problem'), 1);
  await w.check(id);
  await w.minute();
  assert.equal(await bells(5, 'domain_problem'), 1);
  const problem = mailed('mia@test.de', 'Your domain needs attention');
  assert.equal(problem.length, 1);
  assert.match(problem[0].text, /^links\.example\.com doesn’t point to OnYourSite any more\. Your page is shown at mia\.oys\.test/);
  if (trap) assert.equal(trapHits, 0, 'the probe never connected to the address from the domain’s DNS');

  // Zurück auf uns: neuer Hostname (der TXT-Eintrag steht noch), dann live mit „back online“ (ohne Mail)
  pointToUs(HOST, 5);
  await w.check(id);
  r = await row(id);
  assert.equal(r.state, 'pending', String(r.problem));
  assert.ok(r.cf_id && r.cf_id !== oldCf);
  cf.set(HOST, { status: 'active', ssl: 'active' });
  await w.check(id);
  r = await row(id);
  assert.equal(r.state, 'active');
  assert.equal(await pageDomain(2), HOST);
  assert.equal(await bells(5, 'domain_back'), 1);
  assert.equal(await bells(5, 'domain_live'), 1, 'not “live” a second time');
  await w.minute();
  assert.equal(mails.filter((m) => m.title === 'Your domain is back online').length, 0, 'back online comes without a mail');
  assert.deepEqual((await events(id)).slice(-6), ['cf_deleted', 'broken', 'domain_problem', 'cf_created', 'active', 'domain_back']);
});

test('DNS errors: one resolver failing never counts; both failing count only after 3 checks and 30 minutes (20 minutes: nothing)', { skip }, async () => {
  const id = ids.mia;
  dns.only.b.set(HOST, { rcode: 2 });
  await w.check(id);
  let r = await row(id);
  assert.deepEqual([r.state, Number(r.dns_unknown_count), Number(r.fail_count)], ['active', 0, 0]);
  dns.only.b.delete(HOST);

  dns.records.set(HOST, { rcode: 2 });
  for (let i = 0; i < 3; i++) await w.check(id);
  r = await row(id);
  assert.deepEqual([r.state, Number(r.dns_unknown_count), Number(r.fail_count)], ['active', 3, 0]);
  assert.ok(untilNext(r) <= 300, 'unknown: checked again within 5 minutes');
  await setRow(id, { dns_unknown_since: ago(20 * 60) });
  await w.check(id);
  assert.equal(Number((await row(id)).fail_count), 0, '20 minutes of errors: nothing yet');
  await setRow(id, { dns_unknown_since: ago(35 * 60) });
  await w.check(id);
  r = await row(id);
  assert.deepEqual([r.state, Number(r.fail_count), r.problem], ['active', 1, 'dns_unknown']);
  await setRow(id, { fail_since: ago(11 * 60) });
  const cfId = r.cf_id;
  await w.check(id);
  r = await row(id);
  assert.deepEqual([r.state, r.cf_id, r.problem], ['broken', cfId, 'dns_unknown'], 'DNS errors keep the hostname');
  assert.equal(await bells(5, 'domain_problem'), 1, 'no second “needs attention” within 24 hours');

  pointToUs(HOST, 5);
  await w.check(id);
  r = await row(id);
  assert.deepEqual([r.state, Number(r.dns_unknown_count), r.dns_unknown_since], ['active', 0, null]);
  assert.equal(await bells(5, 'domain_back'), 1, '“back online” only after a reported problem');
  assert.equal(await pageDomain(2), HOST);
});

test('the breaker: our own outage or mass failures pause every downgrade; the admins hear it once', { skip }, async () => {
  ids.tom = await bringLive(TOM, 3, 6);
  ids.lea = await bringLive(LEA, 4, 7);
  const team = await bells(3, 'team');

  // 1. Eigener Ausfall: unsere Domain antwortet über die Kante mit 530
  edge.modes.set('oys.test', { kind: 'status', status: 530, body: 'error 1033' });
  await w.minute();
  let st = await workerState();
  assert.deepEqual([st.control?.ok, st.freeze?.reason], [false, 'control']);
  assert.match(String(st.freeze?.detail), /^Our own site didn’t answer through Cloudflare \(http_530\)\.$/);
  assert.equal(await bells(3, 'team'), team + 1);
  assert.equal((await health()).frozen, true);
  // Ein eindeutiger Fehler zählt, stuft aber nicht herab – auch nach 10 Minuten nicht
  edge.modes.set(HOST, { kind: 'status', status: 404, body: 'not found' });
  await w.check(ids.mia);
  await setRow(ids.mia, { fail_since: ago(11 * 60) });
  await w.check(ids.mia);
  let r = await row(ids.mia);
  assert.deepEqual([r.state, Number(r.fail_count), r.problem], ['active', 2, 'probe_failed']);
  await w.minute();
  assert.equal(await bells(3, 'team'), team + 1, 'one alert while it stays open');

  // Wieder in Ordnung: der Schalter schließt sich; der bestätigte Fehler stuft jetzt herab (Hostname bleibt)
  edge.modes.delete('oys.test');
  await w.minute();
  assert.equal((await workerState()).freeze, null);
  assert.ok(logs.includes('Domains: checks running again.'));
  await w.check(ids.mia);
  r = await row(ids.mia);
  assert.deepEqual([r.state, r.problem], ['broken', 'probe_failed']);
  assert.ok(r.cf_id, 'a failing probe keeps the hostname');
  edge.modes.delete(HOST);
  await w.check(ids.mia);
  assert.equal((await row(ids.mia)).state, 'active');

  // 2. Massenfehler: alle drei Live-Domains scheitern eindeutig zur selben Zeit
  const live = [ids.mia, ids.tom, ids.lea];
  for (const h of [HOST, TOM, LEA]) edge.modes.set(h, { kind: 'status', status: 404, body: 'not found' });
  for (const id of live) await w.check(id);
  await w.minute();
  st = await workerState();
  assert.deepEqual([st.control?.ok, st.freeze?.reason, st.freeze?.detail], [true, 'mass', '3 of 3 live domains failed at the same time.']);
  for (const id of live) await setRow(id, { fail_since: ago(11 * 60) });
  for (const id of live) await w.check(id);
  for (const id of live) assert.equal((await row(id)).state, 'active');
  assert.equal(await bells(3, 'team'), team + 1, 'no second alert within 6 hours');
  for (const h of [HOST, TOM, LEA]) edge.modes.delete(h);
  for (const id of live) await w.check(id);
  await w.minute();
  assert.equal((await workerState()).freeze, null);
  for (const id of live) {
    r = await row(id);
    assert.deepEqual([r.state, Number(r.fail_count), r.problem], ['active', 0, '']);
  }
});

test('Premium ends: under 14 days live → released at once; 14 days live → forwards until the grace period ends; renewing reconnects', { skip }, async () => {
  // Premium aus dem Shop läuft ab (der Shop meldet das Ende selbst – die Domains schreiben dazu keinen Hinweis)
  await exec(`INSERT INTO hc_entitlements (user_id, feature, lot, quantity, permanent, expires_at, source, created_at, updated_at)
      VALUES (5, 'premium', 0, 1, 0, ?, 'purchase', ?, ?), (6, 'premium', 0, 1, 0, ?, 'purchase', ?, ?)`, [ago(60), ago(DAY), ago(DAY), ago(60), ago(DAY), ago(DAY)]);
  await exec('UPDATE users SET premium_until = ? WHERE id IN (5, 6)', [ago(60)]);
  await setRow(ids.tom, { activated_at: ago(15 * DAY) });
  await w.minute(); // Sicherheitsnetz: Abgleich für beide Konten
  let mia = await row(ids.mia);
  let tom = await row(ids.tom);
  assert.deepEqual([mia.state, mia.problem, mia.problem_detail], ['suspended', 'premium_ended', 'release']);
  assert.deepEqual([tom.state, tom.problem, tom.problem_detail], ['suspended', 'premium_ended', 'forward']);
  assert.deepEqual([await pageDomain(2), await pageDomain(3)], [null, null]);
  assert.equal((await bells(5, 'domain_paused')) + (await bells(6, 'domain_paused')), 0);

  // Fällig: mias Hostname geht sofort, toms bleibt für die Weiterleitung
  await w.runDue();
  mia = await row(ids.mia);
  tom = await row(ids.tom);
  assert.equal(mia.cf_id, null);
  assert.equal(onCf(HOST), null);
  assert.ok(tom.cf_id && onCf(TOM));
  const res = await forward(TOM, '/', 'GET');
  assert.equal(res.status, 302);
  assert.match(String(res.headers.location), /^http:\/\/tom\.oys\.test:8080\/?$/);
  assert.equal((await forward(TOM, '/_/domain-check', 'GET')).status, 200, 'the probe still answers while it forwards');

  // Frist vorbei (30 Tage): Hostname weg, Hinweis mit Mail – genau einmal
  await setRow(ids.tom, { suspended_at: ago(31 * DAY), next_check_at: later(6 * 3600) });
  await w.minute(); // fällige Fristen werden sofort geprüft
  assert.ok(untilNext(await row(ids.tom)) <= 0);
  await w.runDue();
  tom = await row(ids.tom);
  assert.deepEqual([tom.state, tom.cf_id, tom.problem_detail], ['suspended', null, 'released']);
  assert.equal(onCf(TOM), null);
  await w.check(ids.tom);
  await w.minute();
  assert.equal(await bells(6, 'domain_removed'), 1);
  const removed = mailed('tom@test.de', 'Your custom domain was disconnected');
  assert.equal(removed.length, 1);
  assert.equal(removed[0].text, 'Premium ended, so go.example.org was disconnected. Renew Premium to connect it again.');

  // mia verlängert: der TXT-Eintrag steht noch → neu eingerichtet und wieder live
  await exec("UPDATE hc_entitlements SET expires_at = ? WHERE user_id = 5 AND feature = 'premium'", [later(30 * DAY)]);
  await exec('UPDATE users SET premium_until = ? WHERE id = 5', [later(30 * DAY)]);
  await w.minute();
  mia = await row(ids.mia);
  assert.deepEqual([mia.state, mia.problem], ['verifying', '']);
  assert.ok(untilNext(mia) <= 0, 'checked at once');
  await w.runDue();
  assert.equal((await row(ids.mia)).state, 'pending');
  cf.set(HOST, { status: 'active', ssl: 'active' });
  await w.check(ids.mia);
  assert.equal((await row(ids.mia)).state, 'active');
  assert.equal(await pageDomain(2), HOST);
});

test('the admin role goes: the domain pauses with its own notice (once); the role back reconnects', { skip }, async () => {
  ids.pixel = await bringLive(PIXEL, 1, 3);
  assert.equal(await toggleAdmin(3), 0);
  let r = await row(ids.pixel);
  assert.deepEqual([r.state, r.problem, r.problem_detail], ['suspended', 'premium_ended', 'release']);
  assert.equal(await pageDomain(1), null);
  assert.equal(await bells(3, 'domain_paused'), 1);
  await reconcileUser(3);
  assert.equal(await bells(3, 'domain_paused'), 1, 'a second run changes nothing');
  await w.minute();
  const paused = mailed('admin@test.de', 'Your custom domain is paused');
  assert.equal(paused.length, 1);
  assert.equal(paused[0].text, 'You’re no longer an admin, so pixel.example.com is disconnected until you have Premium again.');

  assert.equal(await toggleAdmin(3), 1);
  r = await row(ids.pixel);
  assert.deepEqual([r.state, r.problem], ['pending', '']);
  await w.check(ids.pixel);
  assert.equal((await row(ids.pixel)).state, 'active');
  assert.equal(await pageDomain(1), PIXEL);
});

test('mails: at most the budget per minute; a failing send is tried 5 times, then left alone', { skip }, async () => {
  // Alles Offene verschicken; danach zählt das Budget auch diese Mails (gesendet in der letzten Minute)
  const minuteLater = (): Promise<unknown> => exec('UPDATE custom_domain_log SET mailed_at = ? WHERE mailed_at >= ?', [ago(120), ago(60)]);
  await settings({ mails_per_minute: 200 });
  await w.minute();
  assert.equal(await pendingMails(), 0);
  await settings({ mails_per_minute: 2 });
  const start = mails.length;
  await transaction(async (_c, db) => {
    for (let i = 1; i <= 5; i++) await adminAlert(db, `Test alert ${i}`);
  });
  await w.minute();
  assert.equal(mails.length - start, 0, 'the mails of the last minute count');
  await minuteLater();
  await w.minute();
  assert.equal(mails.length - start, 2);
  await w.minute();
  assert.equal(mails.length - start, 2, 'the budget of this minute is used up');
  await minuteLater();
  await w.minute();
  assert.equal(mails.length - start, 4);
  await minuteLater();
  await w.minute();
  assert.deepEqual(mails.slice(start).map((m) => m.text), [1, 2, 3, 4, 5].map((i) => `Test alert ${i}`));
  for (const m of mails.slice(start)) {
    assert.deepEqual([m.to, m.title, m.button], ['admin@test.de', 'Custom domains need attention', 'Open Admin → Custom domains']);
    assert.match(m.url, /\/admin#domains$/);
  }
  await minuteLater();
  sendOk = false;
  await transaction((_c, db) => adminAlert(db, 'Undeliverable'));
  try {
    for (let i = 0; i < 7; i++) await w.minute();
  } finally {
    sendOk = true;
  }
  assert.equal(Number(await value("SELECT mail_tries FROM custom_domain_log WHERE detail = 'Undeliverable'")), 5);
  await w.minute();
  assert.equal(mails.filter((m) => m.text === 'Undeliverable').length, 0, 'not tried again after 5 failures');
  await settings({});
});

test('Cloudflare trouble: removing waits and tries again; 429 pauses every call until Retry-After', { skip }, async () => {
  const leaCf = String((await row(ids.lea)).cf_id);
  assert.equal(await transaction((_c, db) => removeDomain(db, ids.lea, 'removed by the user')), 'removing');
  assert.equal(await pageDomain(4), null, 'the main address goes at once');
  cf.failNext(500, 1);
  await w.check(ids.lea);
  const r = await row(ids.lea);
  assert.equal(r.state, 'removing');
  assert.ok(onCf(LEA), 'still at Cloudflare');
  assert.ok(untilNext(r) > 0, 'tried again later');
  await w.check(ids.lea);
  assert.equal(await gone(ids.lea), true);
  assert.equal(cf.hostnames.has(leaCf), false);
  assert.equal((await q("SELECT id FROM custom_domain_log WHERE event = 'cf_deleted' AND cf_id = ?", [leaCf])).length, 1);
  const res = await forward(LEA, '/', 'GET');
  assert.equal(res.status, 404);
  assert.match(res.body, /This domain isn’t connected to a page right now\./);

  const SHOP = 'shop.example.net';
  pointToUs(SHOP, 7);
  const id = await createDomain({ hostname: SHOP, targetId: 4, userId: 7 });
  cf.failNext(429, 1);
  await w.check(id);
  let x = await row(id);
  assert.deepEqual([x.state, x.problem, x.cf_id], ['verifying', 'api_error', null]);
  assert.ok(untilNext(x) <= 300, 'tried again within 5 minutes');
  const calls = cf.calls.length;
  await w.check(id);
  assert.equal(cf.calls.length, calls, 'no call to Cloudflare while paused');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await w.check(id);
  x = await row(id);
  assert.equal(x.state, 'pending', String(x.problem));
  assert.ok(onCf(SHOP));
});

test('places: a confirmed domain waits in line (oldest first) and Cloudflare’s quota counts; another account’s TXT value never counts', { skip }, async () => {
  const used = Number(await value('SELECT COUNT(*) FROM custom_domains WHERE cf_id IS NOT NULL'));
  await settings({ max_total: used });
  const A = 'wait.example.org';
  const B = 'line.example.com';
  pointToUs(A, 8);
  pointToUs(B, 3);
  const a = await createDomain({ hostname: A, targetId: await newPage(8, 'noname-a'), userId: 8 });
  const b = await createDomain({ hostname: B, targetId: await newPage(3, 'pixel-b'), userId: 3 });
  await w.check(a);
  await w.check(a);
  await w.check(b);
  for (const id of [a, b]) assert.deepEqual([(await row(id)).state, (await row(id)).problem, (await row(id)).cf_id], ['verifying', 'quota', null]);
  assert.equal((await events(a)).filter((e) => e === 'waiting').length, 1, 'one “waiting” entry, not one per check');
  assert.deepEqual(await capacity(), { available: true, full: true, free: 0, waiting: 2 });

  // Ein Platz mehr: nur die länger wartende kommt dran
  await settings({ max_total: used + 1 });
  await w.minute();
  assert.ok(untilNext(await row(a)) <= 0);
  assert.ok(untilNext(await row(b)) > 0);
  await w.check(a);
  assert.equal((await row(a)).state, 'pending');
  await w.check(b);
  assert.equal((await row(b)).problem, 'quota', 'full again');

  // Kontingent bei Cloudflare ausgeschöpft (ohne bezahlte Hostnamen): auch mit Platz hier wartet B
  await settings({ max_total: used + 5 });
  cf.quota.allocated = cf.hostnames.size;
  assert.match(await w.testConnection(), /^Token works\./);
  await w.minute();
  assert.ok(untilNext(await row(b)) > 0);
  await w.check(b);
  assert.equal((await row(b)).problem, 'quota');
  assert.equal((await capacity()).full, true);
  await settings({ max_total: used + 5, allow_paid: true });
  await w.minute();
  await w.check(b);
  assert.equal((await row(b)).state, 'pending');
  cf.quota.allocated = 100;
  await w.testConnection();
  await settings({});

  // Fremder Nachweis: der Wert eines anderen Kontos verbindet die Domain nie
  const C = 'claimed.example.com';
  dns.records.set(C, { CNAME: 'edge.oys.test' });
  dns.records.set('_onyoursite.' + C, { TXT: [ownershipToken(5, C)] });
  const c = await createDomain({ hostname: C, targetId: await newPage(8, 'noname-c'), userId: 8 });
  await w.check(c);
  const rc = await row(c);
  assert.deepEqual([rc.state, rc.problem, rc.cf_id], ['verifying', 'txt_wrong', null]);
  assert.equal(onCf(C), null);
});

test('removed while its hostname is being created: the new hostname is deleted again, nothing stays', { skip }, async () => {
  const RACE = 'race.example.com';
  pointToUs(RACE, 5);
  const id = await createDomain({ hostname: RACE, targetId: await newPage(5, 'mia-race'), userId: 5 });
  let removed = '';
  cf.onCreate = async (h) => {
    if (h.hostname === RACE) removed = await transaction((_c, db) => removeDomain(db, id, 'removed by the user'));
  };
  try {
    await w.check(id);
  } finally {
    cf.onCreate = null;
  }
  assert.equal(removed, 'deleted', 'no hostname stored yet: the row goes at once');
  assert.equal(await gone(id), true);
  assert.equal(onCf(RACE), null, 'the new hostname was deleted again');
  const log = await q('SELECT event, detail, cf_id FROM custom_domain_log WHERE hostname = ? ORDER BY id', [RACE]);
  assert.deepEqual(log.map((l) => l.event), ['added', 'removed', 'cf_created', 'cf_deleted']);
  assert.equal(log[3].detail, 'removed while it was being set up');
  assert.equal(log[2].cf_id, log[3].cf_id);
});

test('a change during a check wins: removed while the probe answers → no “live”, no bell; the hostname goes with the next check', { skip }, async () => {
  const H = 'during.example.org';
  const page = await newPage(5, 'mia-during');
  pointToUs(H, 5);
  const id = await createDomain({ hostname: H, targetId: page, userId: 5 });
  await w.check(id);
  assert.equal((await row(id)).state, 'pending');
  cf.set(H, { status: 'active', ssl: 'active' });
  const liveBells = await bells(5, 'domain_live');
  let removed = '';
  afterForward = async (host, path) => {
    if (host !== H || path !== '/_/domain-check') return;
    afterForward = null;
    removed = await transaction((_c, db) => removeDomain(db, id, 'removed by the user'));
  };
  try {
    await w.check(id);
  } finally {
    afterForward = null;
  }
  assert.equal(removed, 'removing');
  assert.equal((await row(id)).state, 'removing', 'the check’s “active” was not written over the removal');
  assert.equal(await pageDomain(page), null);
  assert.equal(await bells(5, 'domain_live'), liveBells, 'no bell for a change that was not written');
  await w.check(id);
  assert.equal(await gone(id), true);
  assert.equal(onCf(H), null);
});

test('the 10-minute list makes a changed hostname due at once; the daily sweep deletes our orphans, lists others, cleans up and alerts once', { skip }, async () => {
  cf.set(HOST, { status: 'moved' });
  await setRow(ids.mia, { next_check_at: later(600) });
  await w.statusList();
  let r = await row(ids.mia);
  assert.equal(r.cf_status, 'moved');
  assert.ok(untilNext(r) <= 0, 'due at once');
  await w.check(ids.mia);
  r = await row(ids.mia);
  assert.deepEqual([r.state, Number(r.fail_count), r.problem], ['active', 1, 'cf_moved']);
  cf.set(HOST, { status: 'active' });
  await w.check(ids.mia);
  r = await row(ids.mia);
  assert.deepEqual([r.state, Number(r.fail_count), r.cf_status], ['active', 0, 'active']);
  assert.ok((await workerState()).list_at);

  const client = cloudflareFromConfig();
  const orphan = (await client.createHostname('orphan.example.org')).hostname;
  const manual = (await client.createHostname('manual.example.org')).hostname;
  try {
    await sweep(orphan.id, manual.id);
  } finally {
    cf.hostnames.delete(manual.id);
    cf.fallback.status = 'active';
    cf.quota.allocated = 100;
  }
});

async function sweep(orphanId: string, manualId: string): Promise<void> {
  const orphan = { id: orphanId };
  const manual = { id: manualId };
  await logEvent(poolDb, { id: 999999, hostname: 'orphan.example.org', user_id: null }, 'cf_created', '', { cfId: orphan.id });
  cf.fallback.status = 'pending_deployment';
  cf.quota.allocated = cf.hostnames.size;
  // Aufzuräumen: alter Verlauf (IDs angelegter Hostnamen ohne Löschung bleiben) und eine seit 31 Tagen gescheiterte Domain
  const old = ago(91 * DAY);
  await exec(`INSERT INTO custom_domain_log (domain_id, hostname, user_id, event, detail, cf_id, mail, created_at)
      VALUES (NULL, 'old.example.com', NULL, 'check', '', NULL, 0, ?), (NULL, 'old.example.com', NULL, 'cf_created', '', 'kept-id', 0, ?),
      (NULL, 'old.example.com', NULL, 'cf_created', '', 'done-id', 0, ?), (NULL, 'old.example.com', NULL, 'cf_deleted', '', 'done-id', 0, ?)`, [old, old, old, old]);
  const stale = await createDomain({ hostname: 'stale.example.com', targetId: await newPage(8, 'noname-stale'), userId: 8 });
  assert.equal(await transition(await row(stale), { state: 'failed', set: { problem: 'verify_timeout' } }), true);
  await setRow(stale, { state_at: ago(31 * DAY) });
  const team = await bells(3, 'team');

  await w.daily();
  assert.equal(cf.hostnames.has(orphan.id), false, 'our orphan is deleted');
  assert.equal(cf.hostnames.has(manual.id), true, 'one made by hand is only listed');
  const st = await workerState();
  assert.deepEqual(st.unmanaged.map((u) => u.hostname), ['manual.example.org']);
  assert.equal(st.fallback?.status, 'pending_deployment');
  assert.equal(st.quota?.allocated, cf.quota.allocated);
  assert.equal(await bells(3, 'team'), team + 2, 'quota and fallback');
  assert.equal(await gone(stale), true);
  assert.deepEqual((await q("SELECT event, cf_id FROM custom_domain_log WHERE hostname = 'old.example.com' ORDER BY id")).map((x) => [x.event, x.cf_id]),
    [['cf_created', 'kept-id']]);
  assert.equal((await q("SELECT id FROM custom_domain_log WHERE event = 'cf_deleted' AND detail = 'orphan' AND cf_id = ?", [orphan.id])).length, 1);
  await w.daily();
  assert.equal(await bells(3, 'team'), team + 2, 'not again on the same day (also not “80 %” after “all in use”)');
}

test('a token that stops working: the admins hear it once a day; “Test connection” shows it works again', { skip }, async () => {
  const team = await bells(3, 'team');
  cf.rejectToken = true;
  await w.statusList();
  await w.minute();
  let st = await workerState();
  assert.equal(st.token, 'error');
  assert.equal(await bells(3, 'team'), team + 1);
  await w.statusList();
  await w.minute();
  assert.equal(await bells(3, 'team'), team + 1, 'once a day');
  cf.rejectToken = false;
  await requestWorker('test', nowStr());
  await w.minute();
  st = await workerState();
  assert.equal(st.token, 'ok');
  assert.match(String(st.test?.result), /^Token works\. \d+ of 100 hostnames used; fallback origin origin\.oys\.test is active\.$/);
  const stored = String(await value("SELECT meta_value FROM oys_meta WHERE meta_key = 'custom_domains_state'"));
  assert.ok(!stored.includes(cf.token), 'the token is never stored');
});

test('one worker at a time: a second one waits for the lock and takes over when the first stops', { skip }, async () => {
  const name = 'oys_domains_worker_test_' + randomBytes(4).toString('hex');
  const stub = (n: { ticks: number }): DomainWorker => ({ tick: async () => (n.ticks++, 0) }) as unknown as DomainWorker;
  const a = { ticks: 0 };
  const b = { ticks: 0 };
  let stopA = false;
  let stopB = false;
  const logA: string[] = [];
  const logB: string[] = [];
  const waitFor = async (cond: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(cond());
  };
  const runA = runDomainWorker({ stop: () => stopA, worker: stub(a), lock: new LeaderLock(name), loopMs: 20, waitMs: 50, log: (l) => void logA.push(l) });
  await waitFor(() => a.ticks > 0);
  const runB = runDomainWorker({ stop: () => stopB, worker: stub(b), lock: new LeaderLock(name), loopMs: 20, waitMs: 50, log: (l) => void logB.push(l) });
  await waitFor(() => logB.includes('Domains: another domain worker is running – waiting.'));
  assert.equal(b.ticks, 0);
  stopA = true;
  await runA;
  await waitFor(() => b.ticks > 0);
  stopB = true;
  await runB;
  assert.ok(logA.includes('Domains: worker stopped.') && logB.includes('Domains: worker started.'));
});

test('health for the status page: worker seen, last good probe through Cloudflare, nothing went to the real services', { skip }, async () => {
  const h = await health();
  assert.deepEqual([h.configured, h.workerOk, h.frozen, h.ok], [true, true, false, true], h.reason);
  assert.ok(h.activeDomains >= 2);
  assert.ok(h.probeOkAt);
  const lateCheck = await health(poolDb, nowSec() + 400);
  assert.equal(lateCheck.workerOk, false);
  assert.match(lateCheck.reason, /^The domain worker was last seen at /);
  assert.deepEqual(foreign, [], 'every request went to the stand-ins');
  assert.ok(dns.queries.length > 0 && cf.calls.length > 0);
});
