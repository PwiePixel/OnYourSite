// Domain-Dienst ohne Datenbank (premium-domains PD-3): die Entscheidung evaluate() für alle Übergänge des
// Zustandsautomaten, „zeigt auf uns“ je Resolver und für beide, der Schutzschalter, der Zeitplan, TXT-Werte, die
// IP-Bereiche von Cloudflare, die Zuordnung der Antworten von Cloudflare (Fehler, Token, 429, Budget, Übernahme statt
// doppelt anlegen, PATCH auf TXT) und das Finden der Zone über SOA – alles mit nachgebautem fetch, ohne Netz.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, NO_FACTS, type EvalInput, type Facts, type Obs } from '../src/domains/worker/evaluate.js';
import { judgeDns, judgeResolver, txtData, txtView, detectZone, Doh, type DohReply, type DnsVerdict, type JudgeOptions } from '../src/domains/worker/dns.js';
import { breaker } from '../src/domains/worker/control.js';
import { nextDelay } from '../src/domains/worker/schedule.js';
import { CfRanges } from '../src/domains/worker/cfips.js';
import { Cloudflare, CfAuthError, CfError, CfUnavailable } from '../src/domains/worker/cloudflare.js';
import { classifyError, classifyResponse } from '../src/domains/worker/probe.js';
import { DOMAIN_SETTINGS_DEFAULTS, normalizeDomainSettings } from '../src/domains/settings.js';
import { forwardEligible } from '../src/domains/lifecycle.js';
import type { DomainRow } from '../src/domains/store.js';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setMailDirForTests, setMailTransportForTests, type CapturedMail } from '../src/mail.js';
import { defaultSender } from '../src/domains/worker/mail.js';
import { header, leaves, parseMessage } from './support/mime.js';

// Feste Uhr: Unix-Sekunden ↔ 'Y-m-d H:i:s' in UTC (für die reine Entscheidung genügt das)
const T0 = Date.UTC(2026, 10, 2, 12, 0, 0) / 1000;
const at = (u: number): string => new Date(u * 1000).toISOString().slice(0, 19).replace('T', ' ');
const toUnix = (s: string): number => Date.parse(s.replace(' ', 'T') + 'Z') / 1000;
const ago = (sec: number): string => at(T0 - sec);
const MIN = 60;
const DAY = 86400;

function row(over: Partial<DomainRow> & Record<string, unknown> = {}): DomainRow {
  return {
    id: 7, hostname: 'links.example.com', target_type: 'page', target_id: 2, user_id: 5, state: 'verifying', version: 3, redirect: 1,
    state_at: ago(60), is_apex: 0, zone_name: null, cf_id: null, cf_status: '', cf_ssl_status: '', cf_created_at: null, problem: '', problem_detail: '',
    fail_count: 0, fail_since: null, dns_unknown_count: 0, dns_unknown_since: null, checked_at: null, next_check_at: null, fast_until: null, manual_at: null,
    patched_at: null, verified_at: null, activated_at: null, suspended_at: null, notice_state: 0, notice_at: null, blocked_reason: null, cert_expires_at: null,
    created_at: ago(20 * MIN), updated_at: ago(60), ...over,
  } as DomainRow;
}

const TXT_MINE = { values: ['onyoursite-verify=mine'], mine: true, others: [], answered: 2, unknown: false };
const TXT_NONE = { values: [], mine: false, others: [], answered: 2, unknown: false };
const OK_DNS: DnsVerdict = { verdict: 'ok', problem: '', found: '' };
const CF_ACTIVE = { kind: 'ok' as const, status: 'active', sslStatus: 'active', host: null };
const PROBE_OK = { result: 'ok' as const, reason: '', certValidTo: at(T0 + 60 * DAY) };

function ev(r: DomainRow, obs: Obs, o: Partial<EvalInput> & { facts?: Facts } = {}) {
  return evaluate({ row: r, obs, settings: { ...DOMAIN_SETTINGS_DEFAULTS }, frozen: false, now: T0, at, toUnix, manual: false, facts: NO_FACTS, ...o });
}

test('verifying: TXT found → create the hostname; waits for a place or the own other domain; times out after 7 days only without TXT', () => {
  let d = ev(row(), { txt: TXT_MINE, zone: { zone: 'example.com', apex: false } });
  assert.equal(d.state, 'pending');
  assert.equal(d.cfAction, 'create');
  assert.equal(d.event, 'txt_ok');
  assert.equal(d.set.zone_name, 'example.com');
  assert.equal(d.set.verified_at, at(T0));
  d = ev(row(), { txt: TXT_MINE }, { facts: { ...NO_FACTS, placeFree: false } });
  assert.deepEqual([d.state, d.cfAction, d.set.problem, d.event], ['verifying', 'none', 'quota', 'waiting']);
  d = ev(row(), { txt: TXT_MINE }, { facts: { ...NO_FACTS, ownPending: true } });
  assert.deepEqual([d.state, d.set.problem], ['verifying', 'waiting_own']);
  d = ev(row(), { txt: TXT_MINE }, { facts: { ...NO_FACTS, olderWaiting: true } });
  assert.equal(d.set.problem, 'quota', 'the oldest verified domain gets the next place');
  d = ev(row(), { txt: TXT_MINE }, { facts: { ...NO_FACTS, recentCreates: 3 } });
  assert.deepEqual([d.cfAction, d.set.problem], ['none', 'api_error'], 'at most 3 hostnames per domain and day');
  // Fehlt der Eintrag: Hinweis; ein anderer Wert: „falscher Wert“; DNS-Fehler zählen nicht
  assert.equal(ev(row(), { txt: TXT_NONE }).set.problem, 'txt_missing');
  assert.equal(ev(row(), { txt: { ...TXT_NONE, values: ['onyoursite-verify=other'], others: ['onyoursite-verify=other'] } }).set.problem, 'txt_wrong');
  d = ev(row(), { txt: { ...TXT_NONE, answered: 0, unknown: true } });
  assert.deepEqual([d.state, d.set.problem, d.unknown], ['verifying', 'dns_error', true]);
  // 7 Tage ohne Eintrag → gescheitert (nicht beim Warten auf einen Platz, nie mit gefundenem Eintrag)
  const old = row({ created_at: ago(7 * DAY + 1) });
  d = ev(old, { txt: TXT_NONE });
  assert.deepEqual([d.state, d.set.problem, d.event], ['failed', 'verify_timeout', 'failed']);
  assert.equal(ev(row({ created_at: ago(7 * DAY + 1), problem: 'quota' }), { txt: TXT_NONE }).state, 'verifying');
  assert.equal(ev(old, { txt: TXT_MINE }).cfAction, 'create', 'Premium back after weeks: the old record reconnects');
  // Schon mit Hostnamen (Premium zurück, Übernahme): weiter zu pending ohne neuen Hostnamen
  d = ev(row({ cf_id: 'cf-1' }), { txt: TXT_MINE });
  assert.deepEqual([d.state, d.cfAction], ['pending', 'none']);
  // Hostname ohne Nachweis dieses Kontos (beide Resolver haben geantwortet) → löschen
  assert.equal(ev(row({ cf_id: 'cf-1' }), { txt: TXT_NONE }).cfAction, 'delete');
});

test('failed: only on request, the ages are not reset, the reason stays; a leftover hostname is deleted', () => {
  const failed = row({ state: 'failed', problem: 'verify_timeout', created_at: ago(30 * DAY) });
  assert.deepEqual(ev(failed, { txt: TXT_MINE }), { ...ev(failed, {}), set: { checked_at: at(T0) } });
  let d = ev(failed, { txt: TXT_MINE }, { manual: true });
  assert.deepEqual([d.state, d.cfAction], ['pending', 'create']);
  d = ev(failed, { txt: TXT_NONE }, { manual: true });
  assert.deepEqual([d.state, d.set.problem], ['failed', undefined], 'keeps verify_timeout');
  assert.equal(ev(row({ state: 'failed', cf_id: 'cf-1' }), {}).cfAction, 'delete');
});

test('pending → active only with Cloudflare active, SSL active, DNS to us and the probe; setup timeout deletes and tells the user', () => {
  const p = row({ state: 'pending', cf_id: 'cf-1', cf_created_at: ago(5 * MIN) });
  let d = ev(p, { cf: CF_ACTIVE, dns: OK_DNS, probe: PROBE_OK });
  assert.deepEqual([d.state, d.event, d.notice?.type], ['active', 'active', 'domain_live']);
  assert.equal(d.set.cert_expires_at, at(T0 + 60 * DAY));
  d = ev(p, { cf: { ...CF_ACTIVE, sslStatus: 'pending_validation' }, dns: OK_DNS });
  assert.deepEqual([d.state, d.set.problem], ['pending', 'ssl_pending']);
  d = ev(p, { cf: { kind: 'ok', status: 'pending', sslStatus: 'pending_validation', host: null }, dns: { verdict: 'wrong', problem: 'cname_missing', found: '' } });
  assert.equal(d.set.problem, 'cname_missing');
  d = ev(p, { cf: { kind: 'ok', status: 'pending', sslStatus: 'pending_validation', host: { id: 'cf-1', hostname: 'links.example.com', status: 'pending', ssl: { validation_errors: [{ message: 'caa_error: blocked by CAA' }] } } }, dns: OK_DNS });
  assert.equal(d.set.problem, 'caa');
  // DNS-Antwort in Cloudflare-Adressen für eine Wurzeldomain (aus judgeResolver) zählt wie der CNAME
  assert.equal(ev(row({ state: 'pending', cf_id: 'cf-1', is_apex: 1, cf_created_at: ago(MIN) }), { cf: CF_ACTIVE, dns: { verdict: 'cf_ips', problem: '', found: '' }, probe: PROBE_OK }).state, 'active');
  // Bei Cloudflare verschwunden: neu nachweisen
  d = ev(p, { cf: { kind: 'gone' } });
  assert.deepEqual([d.state, d.set.cf_id], ['verifying', null]);
  // Frist (pending_days) ab cf_created_at
  d = ev(row({ state: 'pending', cf_id: 'cf-1', cf_created_at: ago(7 * DAY + 5) }), { cf: CF_ACTIVE });
  assert.deepEqual([d.state, d.cfAction, d.set.problem, d.notice?.type, d.notice?.reason], ['failed', 'delete', 'setup_timeout', 'domain_removed', 'setup_timeout']);
  d = ev(row({ state: 'pending', cf_id: 'cf-1', cf_created_at: ago(3 * DAY) }), { cf: CF_ACTIVE }, { settings: { ...DOMAIN_SETTINGS_DEFAULTS, pending_days: 2 } });
  assert.equal(d.state, 'failed');
  // Check now: dieselbe Anfrage noch einmal, höchstens alle 5 Minuten; Wurzeldomain ohne Delegation nach 30 Minuten auf TXT
  const host = { id: 'cf-1', hostname: 'links.example.com', status: 'pending', ssl: { status: 'pending_validation', method: 'http' } };
  assert.equal(ev(p, { cf: { kind: 'ok', status: 'pending', sslStatus: 'pending_validation', host }, dns: OK_DNS }, { manual: true }).cfAction, 'patch');
  assert.equal(ev(row({ ...p, patched_at: ago(2 * MIN) }), { cf: { kind: 'ok', status: 'pending', sslStatus: 'pending_validation', host }, dns: OK_DNS }, { manual: true }).cfAction, 'none');
  assert.equal(ev(row({ ...p, is_apex: 1, cf_created_at: ago(31 * MIN) }), { cf: { kind: 'ok', status: 'pending', sslStatus: 'pending_validation', host }, dns: OK_DNS }).cfAction, 'txt_fallback');
  assert.equal(ev(row({ ...p, is_apex: 1, cf_created_at: ago(31 * MIN) }), { cf: { kind: 'ok', status: 'pending', sslStatus: 'pending_validation', host: { ...host, ssl: { ...host.ssl, dcv_delegation_records: [{ cname: 'x' }] } } }, dns: OK_DNS }).cfAction, 'none');
});

test('active: unknown never flips; two definite failures 10 minutes apart; leaving deletes the hostname, other causes keep it', () => {
  const a = row({ state: 'active', cf_id: 'cf-1', cf_status: 'active', cf_ssl_status: 'active', activated_at: ago(DAY) });
  const unknown = { result: 'unknown' as const, reason: 'http_530', certValidTo: null };
  let d = ev(a, { cf: CF_ACTIVE, dns: { verdict: 'unknown', problem: 'dns_error', found: '' }, probe: unknown });
  assert.deepEqual([d.state, d.set.fail_count, d.unknown], ['active', 0, true]);
  const away: Obs = { cf: CF_ACTIVE, dns: { verdict: 'wrong', problem: 'cname_wrong', found: 'other.host' }, probe: PROBE_OK };
  d = ev(a, away);
  assert.deepEqual([d.state, d.set.fail_count, d.set.fail_since, d.cfAction], ['active', 1, at(T0), 'none']);
  d = ev(row({ ...a, fail_count: 1, fail_since: ago(9 * MIN) }), away);
  assert.deepEqual([d.state, d.cfAction], ['active', 'none'], 'not yet 10 minutes apart');
  d = ev(row({ ...a, fail_count: 1, fail_since: ago(10 * MIN) }), away);
  assert.deepEqual([d.state, d.event, d.cfAction, d.notice?.type, d.set.problem], ['broken', 'broken', 'delete', 'domain_problem', 'cname_wrong']);
  // Probe falsch (z. B. fremder Dienst): kaputt, Hostname bleibt
  d = ev(row({ ...a, fail_count: 1, fail_since: ago(11 * MIN) }), { cf: CF_ACTIVE, dns: OK_DNS, probe: { result: 'wrong', reason: 'not_ours_404', certValidTo: null } });
  assert.deepEqual([d.state, d.cfAction, d.set.problem], ['broken', 'none', 'probe_failed']);
  // Cloudflare meldet moved oder der Hostname fehlt: freigeben
  d = ev(row({ ...a, fail_count: 1, fail_since: ago(11 * MIN) }), { cf: { kind: 'gone' }, dns: OK_DNS, probe: PROBE_OK });
  assert.deepEqual([d.state, d.cfAction, d.set.problem], ['broken', 'delete', 'cf_moved']);
  // Ein guter Lauf setzt die Zähler zurück
  d = ev(row({ ...a, fail_count: 1, fail_since: ago(5 * MIN), problem: 'cname_wrong' }), { cf: CF_ACTIVE, dns: OK_DNS, probe: PROBE_OK });
  assert.deepEqual([d.set.fail_count, d.set.fail_since, d.set.problem], [0, null, '']);
});

test('active: DNS errors on both resolvers count only after 3 checks and 30 minutes', () => {
  const a = row({ state: 'active', cf_id: 'cf-1', cf_status: 'active', cf_ssl_status: 'active' });
  const servfail: Obs = { cf: CF_ACTIVE, dns: { verdict: 'unknown', problem: 'dns_error', found: '' }, probe: PROBE_OK };
  let d = ev(row({ ...a, dns_unknown_count: 1, dns_unknown_since: ago(20 * MIN) }), servfail);
  assert.deepEqual([d.set.dns_unknown_count, d.set.fail_count], [2, 0], '20 minutes: still nothing');
  d = ev(row({ ...a, dns_unknown_count: 2, dns_unknown_since: ago(20 * MIN) }), servfail);
  assert.equal(d.set.fail_count, 0, '3 checks but only 20 minutes');
  d = ev(row({ ...a, dns_unknown_count: 3, dns_unknown_since: ago(35 * MIN) }), servfail);
  assert.deepEqual([d.set.fail_count, d.set.problem, d.cfAction], [1, 'dns_unknown', 'none']);
  d = ev(row({ ...a, dns_unknown_count: 4, dns_unknown_since: ago(45 * MIN), fail_count: 1, fail_since: ago(10 * MIN) }), servfail);
  assert.deepEqual([d.state, d.cfAction], ['broken', 'none'], 'DNS errors keep the hostname');
});

test('breaker open: failures are counted but nothing is downgraded or deleted; upgrades still happen', () => {
  const a = row({ state: 'active', cf_id: 'cf-1', cf_status: 'active', cf_ssl_status: 'active', fail_count: 1, fail_since: ago(20 * MIN) });
  const d = ev(a, { cf: CF_ACTIVE, dns: { verdict: 'wrong', problem: 'cname_missing', found: '' }, probe: PROBE_OK }, { frozen: true });
  assert.deepEqual([d.state, d.cfAction, d.set.fail_count], ['active', 'none', 2]);
  const p = row({ state: 'pending', cf_id: 'cf-1', cf_created_at: ago(MIN) });
  assert.equal(ev(p, { cf: CF_ACTIVE, dns: OK_DNS, probe: PROBE_OK }, { frozen: true }).state, 'active');
  // Pausiert: kein Löschen wegen DNS bei offenem Schalter
  const s = row({ state: 'suspended', cf_id: 'cf-1', suspended_at: ago(DAY), problem_detail: 'forward', fail_count: 1 });
  assert.equal(ev(s, { cf: CF_ACTIVE, dns: { verdict: 'wrong', problem: 'cname_wrong', found: 'x' } }, { frozen: true }).cfAction, 'none');
});

test('broken: back online with a notice; without a hostname a new one once the CNAME is back; 7 days → failed', () => {
  const b = row({ state: 'broken', cf_id: 'cf-1', state_at: ago(HOUR()), notice_state: 1, problem: 'probe_failed' });
  let d = ev(b, { cf: CF_ACTIVE, dns: OK_DNS, probe: PROBE_OK });
  assert.deepEqual([d.state, d.event, d.notice?.type], ['active', 'recovered', 'domain_back']);
  d = ev(row({ state: 'broken', cf_id: null, state_at: ago(HOUR()) }), { dns: OK_DNS, txt: TXT_MINE });
  assert.deepEqual([d.state, d.cfAction], ['pending', 'create']);
  d = ev(row({ state: 'broken', cf_id: null, state_at: ago(HOUR()) }), { dns: { verdict: 'wrong', problem: 'cname_wrong', found: 'x' } });
  assert.deepEqual([d.state, d.cfAction, d.set.problem], ['broken', 'none', 'cname_wrong']);
  d = ev(row({ state: 'broken', cf_id: 'cf-1', state_at: ago(7 * DAY + 1) }), { cf: CF_ACTIVE });
  assert.deepEqual([d.state, d.cfAction, d.notice?.reason], ['failed', 'delete', 'broken_timeout']);
  d = ev(row({ state: 'broken', cf_id: null, state_at: ago(7 * DAY + 1) }), { dns: OK_DNS });
  assert.deepEqual([d.state, d.cfAction, d.notice?.reason], ['failed', 'none', 'broken_timeout']);
});

function HOUR(): number {
  return 3600;
}

test('suspended: forwarding until the grace period ends; released at once without 14 days live; moves delete', () => {
  const s = row({ state: 'suspended', cf_id: 'cf-1', suspended_at: ago(DAY), problem: 'premium_ended', problem_detail: 'forward' });
  assert.equal(ev(s, { cf: CF_ACTIVE, dns: OK_DNS }).cfAction, 'none');
  let d = ev(row({ ...s, suspended_at: ago(30 * DAY + 1) }), { cf: CF_ACTIVE, dns: OK_DNS });
  assert.deepEqual([d.cfAction, d.notice?.reason], ['delete', 'grace_over']);
  d = ev(row({ ...s, problem_detail: 'release' }), {});
  assert.deepEqual([d.cfAction, d.notice], ['delete', null], 'the shop’s notice already said “will be disconnected”');
  assert.equal(ev(s, { cf: { kind: 'gone' } }).cfAction, 'delete');
  d = ev(s, { cf: CF_ACTIVE, dns: { verdict: 'wrong', problem: 'cname_wrong', found: 'x' } });
  assert.deepEqual([d.cfAction, d.set.fail_count], ['none', 1]);
  d = ev(row({ ...s, fail_count: 1 }), { cf: CF_ACTIVE, dns: { verdict: 'wrong', problem: 'cname_wrong', found: 'x' } });
  assert.equal(d.cfAction, 'delete', 'pointing elsewhere twice');
  assert.equal(ev(row({ ...s, cf_id: null }), {}).cfAction, 'none');
});

test('removing, blocked: the hostname goes (removing then deletes the row)', () => {
  assert.deepEqual(pick(ev(row({ state: 'removing', cf_id: 'cf-1' }), {})), ['delete', true]);
  assert.deepEqual(pick(ev(row({ state: 'removing', cf_id: null }), {})), ['none', true]);
  assert.deepEqual(pick(ev(row({ state: 'blocked', cf_id: 'cf-1' }), {})), ['delete', false]);
  assert.deepEqual(pick(ev(row({ state: 'blocked', cf_id: null }), {})), ['none', false]);
});
const pick = (d: ReturnType<typeof ev>): [string, boolean] => [d.cfAction, d.deleteRow];

test('live certificate: expired counts as a definite failure, expiring soon without renewal tells the owner and the admins once', () => {
  const a = row({ state: 'active', cf_id: 'cf-1', cf_status: 'active', cf_ssl_status: 'active' });
  let d = ev(a, { cf: CF_ACTIVE, dns: OK_DNS, probe: { result: 'ok', reason: '', certValidTo: at(T0 - 60) } });
  assert.deepEqual([d.set.fail_count, d.set.problem], [1, 'ssl_expired']);
  d = ev(row({ ...a, cert_expires_at: at(T0 + 10 * DAY) }), { cf: { ...CF_ACTIVE, sslStatus: 'pending_validation' }, dns: OK_DNS, probe: { result: 'ok', reason: '', certValidTo: at(T0 + 10 * DAY) } });
  assert.deepEqual([d.set.problem, d.notice?.type, d.notice?.reason, typeof d.adminAlert], ['cert_expiring', 'domain_problem', 'cert_expiring', 'string']);
  d = ev(row({ ...a, problem: 'cert_expiring' }), { cf: { ...CF_ACTIVE, sslStatus: 'pending_validation' }, dns: OK_DNS, probe: { result: 'ok', reason: '', certValidTo: at(T0 + 10 * DAY) } });
  assert.equal(d.notice, null, 'only once');
  // Ein alter gespeicherter Ablauf zählt nicht, wenn die Prüfung kein Zertifikat sah
  d = ev(row({ ...a, cert_expires_at: at(T0 - DAY) }), { cf: CF_ACTIVE, dns: OK_DNS, probe: { result: 'unknown', reason: 'timeout', certValidTo: null } });
  assert.equal(d.set.fail_count, 0);
});

const judgeOpts = (o: Partial<JudgeOptions> = {}): JudgeOptions => ({
  target: 'edge.on-your.site', base: 'on-your.site', apex: false, cfActive: false, isCloudflare: (ip) => new CfRanges().has(ip), edgeAddrs: new Set(['104.16.1.1']), ...o,
});

test('“points to us” per resolver and for both', () => {
  const v = (cnames: string[], addrs: string[], rcode: number | null = 0) => ({ rcode, cnames, addrs });
  assert.equal(judgeResolver(v(['edge.on-your.site'], ['104.16.1.1']), judgeOpts()).verdict, 'ok');
  assert.equal(judgeResolver(v(['mia.on-your.site'], ['104.16.1.1']), judgeOpts()).verdict, 'ok', 'a chain ending under the base domain');
  assert.deepEqual(judgeResolver(v(['other.host'], ['1.2.3.4']), judgeOpts()), { verdict: 'wrong', problem: 'cname_wrong', found: 'other.host' });
  assert.deepEqual(judgeResolver(v([], ['104.16.9.9']), judgeOpts()), { verdict: 'wrong', problem: 'cname_proxied', found: '104.16.9.9' });
  assert.deepEqual(judgeResolver(v([], ['203.0.113.7']), judgeOpts()), { verdict: 'wrong', problem: 'a_records', found: '203.0.113.7' });
  assert.deepEqual(judgeResolver(v([], [], 3), judgeOpts()), { verdict: 'wrong', problem: 'cname_missing', found: '' });
  assert.deepEqual(judgeResolver(v([], []), judgeOpts()), { verdict: 'wrong', problem: 'cname_missing', found: '' }, 'NODATA');
  assert.equal(judgeResolver(v([], [], 2), judgeOpts()).verdict, 'unknown');
  assert.equal(judgeResolver(v([], [], null), judgeOpts()).verdict, 'unknown');
  // Wurzeldomain: Cloudflare-Adressen zählen nur mit Cloudflare active UND einer Adresse unserer Kante
  assert.equal(judgeResolver(v([], ['104.16.1.1']), judgeOpts({ apex: true, cfActive: false })).problem, 'apex_ips');
  assert.equal(judgeResolver(v([], ['104.16.9.9']), judgeOpts({ apex: true, cfActive: true })).problem, 'apex_ips');
  assert.equal(judgeResolver(v([], ['104.16.1.1', '2606:4700::1']), judgeOpts({ apex: true, cfActive: true })).verdict, 'cf_ips');
  // Beide: einer passt → passt; beide falsch → falsch; einer unbekannt → unbekannt
  const ok: DnsVerdict = { verdict: 'ok', problem: '', found: '' };
  const wrong: DnsVerdict = { verdict: 'wrong', problem: 'cname_missing', found: '' };
  const unk: DnsVerdict = { verdict: 'unknown', problem: 'dns_error', found: '' };
  assert.equal(judgeDns([wrong, ok]).verdict, 'ok');
  assert.equal(judgeDns([wrong, wrong]).verdict, 'wrong');
  assert.equal(judgeDns([wrong, unk]).verdict, 'unknown');
  assert.equal(judgeDns([unk, unk]).verdict, 'unknown');
});

test('TXT values: quoted, split into parts, escapes; several accounts in one set', () => {
  assert.equal(txtData('"onyoursite-verify=abc"'), 'onyoursite-verify=abc');
  assert.equal(txtData('"onyoursite-" "verify=abc"'), 'onyoursite-verify=abc');
  assert.equal(txtData('"a\\"b\\065"'), 'a"bA');
  assert.equal(txtData('plain'), 'plain');
  const name = '_onyoursite.links.example.com';
  const rep = (rcode: number | null, values: string[]): DohReply => ({ rcode, answer: values.map((v) => ({ name, type: 16, data: '"' + v + '"' })), authority: [] });
  let t = txtView([rep(0, ['onyoursite-verify=mine', 'onyoursite-verify=theirs']), rep(0, ['onyoursite-verify=mine'])], name, 'onyoursite-verify=mine');
  assert.deepEqual([t.mine, t.others, t.answered], [true, ['onyoursite-verify=theirs'], 2]);
  t = txtView([rep(2, []), rep(null, [])], name, 'onyoursite-verify=mine');
  assert.deepEqual([t.mine, t.unknown], [false, true]);
  t = txtView([rep(3, []), rep(2, [])], name, 'x');
  assert.deepEqual([t.answered, t.unknown], [1, false]);
});

test('the breaker opens on a failed control or mass failures and closes by itself', () => {
  const base = { controlOk: true, controlError: '', live: 10, failing: 0, freeze: null, now: '2026-11-02 12:00:00' };
  assert.deepEqual(breaker(base), { freeze: null, opened: false, closed: false });
  let b = breaker({ ...base, controlOk: false, controlError: 'down' });
  assert.deepEqual([b.freeze?.reason, b.opened], ['control', true]);
  assert.equal(breaker({ ...base, controlOk: false, controlError: 'down', freeze: b.freeze }).opened, false, 'no second alert');
  b = breaker({ ...base, failing: 3, live: 10 });
  assert.equal(b.freeze?.reason, 'mass', '3 of 10 is more than 20 %');
  assert.equal(breaker({ ...base, failing: 2, live: 5 }).freeze, null, 'at least 3');
  assert.equal(breaker({ ...base, failing: 3, live: 20 }).freeze, null, '15 % is fine');
  const closed = breaker({ ...base, freeze: { since: 'x', reason: 'control', detail: '' } });
  assert.deepEqual([closed.freeze, closed.closed], [null, true]);
});

test('schedule: verifying steps, pending by age, active offset by id, removing doubles, only on request for failed', () => {
  const r = (state: string, o: Partial<Parameters<typeof nextDelay>[0]> = {}) => ({ id: 1, state, cf_id: 'x', created: T0, cfCreated: T0, stateAt: T0, fastUntil: null, ...o });
  assert.equal(nextDelay(r('verifying'), T0), 10 * MIN, 'first check 10 minutes after adding');
  assert.equal(nextDelay(r('verifying'), T0 + 10 * MIN), 5 * MIN);
  assert.equal(nextDelay(r('verifying'), T0 + 46 * MIN), 14 * MIN);
  assert.equal(nextDelay(r('verifying'), T0 + 2 * 3600 + 5), 3600 - 5);
  assert.equal(nextDelay(r('verifying'), T0 + 2 * DAY), 6 * 3600);
  assert.equal(nextDelay(r('verifying', { fastUntil: T0 + 15 * MIN }), T0 + MIN), MIN);
  assert.equal(nextDelay(r('pending'), T0 + 10 * MIN), 5 * MIN);
  assert.equal(nextDelay(r('pending'), T0 + 2 * 3600), 15 * MIN);
  assert.equal(nextDelay(r('pending'), T0 + 2 * DAY), 3600);
  assert.equal(nextDelay(r('pending'), T0 + 4 * DAY), 6 * 3600);
  const a1 = nextDelay(r('active', { id: 1 }), T0)!;
  const a2 = nextDelay(r('active', { id: 2 }), T0)!;
  assert.ok(a1 >= MIN && a1 <= 600 && a2 >= MIN && a2 <= 600 && a1 !== a2, `${a1} ${a2}`);
  assert.equal(nextDelay(r('broken'), T0 + 10 * MIN), 5 * MIN);
  assert.equal(nextDelay(r('broken', { cf_id: null }), T0), 15 * MIN);
  assert.equal(nextDelay(r('suspended'), T0), 6 * 3600);
  assert.equal(nextDelay(r('suspended', { cf_id: null }), T0), DAY);
  assert.equal(nextDelay(r('removing'), T0), MIN);
  assert.equal(nextDelay(r('removing'), T0 + 10 * MIN), 10 * MIN);
  assert.equal(nextDelay(r('removing'), T0 + 5 * 3600), 3600);
  assert.equal(nextDelay(r('failed', { cf_id: null }), T0), null);
  assert.equal(nextDelay(r('blocked', { cf_id: null }), T0), null);
});

test('Cloudflare IP ranges (v4 and v6) and the updated list', () => {
  const ranges = new CfRanges();
  assert.equal(ranges.has('104.16.1.1'), true);
  assert.equal(ranges.has('2606:4700::1'), true);
  assert.equal(ranges.has('203.0.113.7'), false);
  assert.equal(ranges.has('not-an-ip'), false);
  ranges.set({ v4: ['198.51.100.0/24', 'nonsense'], v6: [] });
  assert.equal(ranges.has('198.51.100.9'), true);
  assert.equal(ranges.has('104.16.1.1'), false);
  ranges.set({ v4: [], v6: [] });
  assert.equal(ranges.has('198.51.100.9'), true, 'an empty answer changes nothing');
});

test('settings are clamped (pending_days 30 → 7, mails per minute) and broken values fall back to the defaults', () => {
  assert.deepEqual(normalizeDomainSettings(null), DOMAIN_SETTINGS_DEFAULTS);
  const s = normalizeDomainSettings({ pending_days: 30, per_user: -5, max_total: '99999999', grace_days: 'x', enabled: '1', slots: 0, mails_per_minute: 0 });
  assert.deepEqual([s.pending_days, s.per_user, s.max_total, s.grace_days, s.enabled, s.slots, s.mails_per_minute], [7, 0, 50000, 0, true, false, 1]);
  assert.equal(normalizeDomainSettings({ mails_per_minute: 500 }).mails_per_minute, 200);
  assert.equal(normalizeDomainSettings({}).mails_per_minute, 20);
});

test('forwarding after Premium ends needs the last 14 days live', () => {
  const now = Math.floor(Date.now() / 1000);
  const t = (s: number) => new Date((now - s) * 1000).toISOString().slice(0, 19).replace('T', ' ');
  // forwardEligible liest Zeiten in der Zeitzone der Seite; 15 bzw. 13 Tage genügen als Abstand
  assert.equal(forwardEligible({ state: 'active', cf_id: 'x', activated_at: t(15 * DAY) }, now), true);
  assert.equal(forwardEligible({ state: 'active', cf_id: 'x', activated_at: t(13 * DAY) }, now), false);
  assert.equal(forwardEligible({ state: 'broken', cf_id: 'x', activated_at: t(30 * DAY) }, now), false);
  assert.equal(forwardEligible({ state: 'active', cf_id: null, activated_at: t(30 * DAY) }, now), false);
});

test('probe answers: ok, not ours, unknown for 5xx, 429 and challenges; TLS errors are definite', () => {
  assert.equal(classifyResponse(200, false, 'abc', 'abc').result, 'ok');
  assert.equal(classifyResponse(200, false, ' abc\n', 'abc').result, 'ok');
  assert.deepEqual([classifyResponse(200, false, 'other', 'abc').result, classifyResponse(404, false, '', 'abc').result], ['wrong', 'wrong']);
  for (const s of [500, 502, 521, 530, 429]) assert.equal(classifyResponse(s, false, '', 'abc').result, 'unknown', String(s));
  assert.equal(classifyResponse(403, true, '', 'abc').result, 'unknown');
  assert.deepEqual(classifyError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }), { result: 'wrong', reason: 'cert_invalid', certValidTo: null });
  assert.equal(classifyError({ code: 'CERT_HAS_EXPIRED' }).reason, 'cert_expired');
  assert.equal(classifyError({ code: 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE' }).result, 'wrong');
  // Ohne passenden Code entscheidet der Text der Meldung
  assert.deepEqual(classifyError({ code: 'EPROTO', message: 'SSL routines:ssl3_read_bytes:sslv3 alert handshake failure' }), { result: 'wrong', reason: 'no_certificate', certValidTo: null });
  assert.deepEqual(classifyError(new Error('tlsv1 Alert Unrecognized Name')), { result: 'wrong', reason: 'no_certificate', certValidTo: null });
  assert.equal(classifyError({ code: 'ECONNREFUSED' }).result, 'unknown');
  assert.equal(classifyError({ code: 'ECONNRESET' }).result, 'unknown');
  assert.equal(classifyError(new Error('socket timeout')).result, 'unknown');
});

// ---------------------------------------------------------------- Cloudflare-Client mit nachgebautem fetch

type Handler = (url: string, init: RequestInit) => { status: number; body?: unknown; headers?: Record<string, string> };
function fakeFetch(h: Handler, log: Array<{ url: string; init: RequestInit }> = []): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    log.push({ url, init });
    const r = h(url, init);
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as typeof fetch;
}
const zone = 'a'.repeat(32);
const token = ['t', 'o', 'k'].join('') + '-' + process.pid;

test('Cloudflare client: errors are mapped, the token never appears, 404 is “gone”, 429 pauses, the budget holds', async () => {
  const log: Array<{ url: string; init: RequestInit }> = [];
  let status = 403;
  let code = 10000;
  const cf = new Cloudflare({ base: 'https://api.example/client/v4', zone, token, fetchImpl: fakeFetch(() => ({ status, body: { success: false, errors: [{ code, message: 'Authentication error' }] } }), log) });
  await assert.rejects(cf.quota(), (e: unknown) => e instanceof CfAuthError && !String((e as Error).message).includes(token));
  assert.equal((log[0].init.headers as Record<string, string>).Authorization, 'Bearer ' + token);
  status = 400;
  await assert.rejects(cf.quota(), CfAuthError, 'error 10000 is always the token');
  code = 1442;
  await assert.rejects(cf.quota(), (e: unknown) => e instanceof CfError && !(e instanceof CfAuthError) && (e as CfError).code === 1442);
  status = 503;
  await assert.rejects(cf.quota(), CfUnavailable);
  // 404 auf einen Hostnamen: weg
  const gone = new Cloudflare({ base: 'https://api.example/client/v4', zone, token, fetchImpl: fakeFetch(() => ({ status: 404, body: { success: false, errors: [{ code: 1436, message: 'not found' }] } })) });
  assert.equal(await gone.getHostname('x'), null);
  await gone.deleteHostname('x');
  // 429: keine Aufrufe bis Retry-After
  let clock = 1_000_000;
  const calls: string[] = [];
  const limited = new Cloudflare({ base: 'https://api.example/client/v4', zone, token, clock: () => clock,
    fetchImpl: fakeFetch((url) => (calls.push(url), { status: 429, headers: { 'Retry-After': '30' }, body: {} })) });
  await assert.rejects(limited.quota(), CfUnavailable);
  await assert.rejects(limited.quota(), /slow down/);
  assert.equal(calls.length, 1);
  clock += 31_000;
  await assert.rejects(limited.quota(), CfUnavailable);
  assert.equal(calls.length, 2);
  // Budget: höchstens 400 Aufrufe in 5 Minuten
  let n = 0;
  const busy = new Cloudflare({ base: 'https://api.example/client/v4', zone, token, clock: () => clock,
    fetchImpl: fakeFetch(() => (n++, { status: 200, body: { success: true, result: { allocated: 1, used: 0, exceeded: false, hard_cap: 2 } } })) });
  for (let i = 0; i < 400; i++) await busy.quota();
  await assert.rejects(busy.quota(), /budget/);
  assert.equal(n, 400);
  clock += 5 * 60_000;
  await busy.quota();
  assert.equal(n, 401);
  // Ohne Token: kein Aufruf
  const none = new Cloudflare({ base: 'https://api.example/client/v4', zone, token: '', fetchImpl: fakeFetch(() => ({ status: 200 })) });
  await assert.rejects(none.quota(), CfAuthError);
});

test('Cloudflare client: create adopts an existing hostname, a duplicate on POST adopts too; the TXT fallback body', async () => {
  const log: Array<{ url: string; init: RequestInit }> = [];
  const host = { id: 'h1', hostname: 'links.example.com', status: 'pending', ssl: { status: 'pending_validation', method: 'http' } };
  let existing = true;
  let postFails = false;
  const cf = new Cloudflare({ base: 'https://api.example/client/v4', zone, token, fetchImpl: fakeFetch((url, init) => {
    if (init.method === 'GET') return { status: 200, body: { success: true, result: existing ? [host] : [] } };
    if (init.method === 'POST') return postFails ? { status: 409, body: { success: false, errors: [{ code: 1406, message: 'Duplicate custom hostname found.' }] } } : { status: 200, body: { success: true, result: host } };
    if (init.method === 'PATCH') return { status: 200, body: { success: true, result: host } };
    return { status: 404 };
  }, log) });
  assert.deepEqual(await cf.createHostname('links.example.com'), { hostname: { ...host, created_at: undefined, verification_errors: [], ownership_verification: undefined }, adopted: true });
  assert.equal(log.filter((l) => l.init.method === 'POST').length, 0);
  existing = false;
  let r = await cf.createHostname('links.example.com');
  assert.equal(r.adopted, false);
  const post = log.find((l) => l.init.method === 'POST')!;
  assert.deepEqual(JSON.parse(String(post.init.body)), { hostname: 'links.example.com', ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } } });
  // Gleichzeitig angelegt: der zweite POST meldet doppelt → übernehmen
  postFails = true;
  let afterPost = false;
  const cf2 = new Cloudflare({ base: 'https://api.example/client/v4', zone, token, fetchImpl: fakeFetch((url, init) => {
    if (init.method === 'GET') return { status: 200, body: { success: true, result: afterPost ? [host] : [] } };
    afterPost = true;
    return { status: 409, body: { success: false, errors: [{ code: 1406, message: 'Duplicate custom hostname found.' }] } };
  }) });
  r = await cf2.createHostname('links.example.com');
  assert.equal(r.adopted, true);
  await cf.patchSsl('h1', { method: 'txt', type: 'dv' });
  const patch = log.find((l) => l.init.method === 'PATCH')!;
  assert.deepEqual(JSON.parse(String(patch.init.body)), { ssl: { method: 'txt', type: 'dv' } });
  assert.match(patch.url, new RegExp(`/zones/${zone}/custom_hostnames/h1$`));
});

test('zone detection: SOA in the authority, a CNAME on the name walks the parents, never the site’s own zone', async () => {
  const replies = new Map<string, unknown>();
  const doh = new Doh(['https://a.example/dns-query'], fakeFetch((url) => {
    const u = new URL(url);
    const key = u.searchParams.get('name') + '/' + u.searchParams.get('type');
    const body = replies.get(key) ?? { Status: 3 };
    return { status: 200, body };
  }));
  const soa = (n: string) => ({ name: n + '.', type: 6, data: 'ns. host. 1 2 3 4 5' });
  replies.set('_onyoursite.links.example.com/SOA', { Status: 3, Authority: [soa('example.com')] });
  assert.deepEqual(await detectZone(doh, 'links.example.com', 'on-your.site'), { zone: 'example.com', apex: false });
  replies.set('_onyoursite.example.org/SOA', { Status: 0, Authority: [soa('example.org')] });
  assert.deepEqual(await detectZone(doh, 'example.org', 'on-your.site'), { zone: 'example.org', apex: true });
  // CNAME auf dem Namen (zeigt schon auf uns): Eltern durchgehen, unsere Zone nie
  replies.set('_onyoursite.shop.example.net/SOA', { Status: 0, Answer: [{ name: '_onyoursite.shop.example.net.', type: 5, data: 'edge.on-your.site.' }], Authority: [soa('on-your.site')] });
  replies.set('shop.example.net/SOA', { Status: 0, Answer: [{ name: 'shop.example.net.', type: 5, data: 'edge.on-your.site.' }, soa('on-your.site')] });
  replies.set('example.net/SOA', { Status: 0, Answer: [soa('example.net')] });
  assert.deepEqual(await detectZone(doh, 'shop.example.net', 'on-your.site'), { zone: 'example.net', apex: false });
  // Antwort zeigt nur auf unsere Zone: nichts
  replies.set('_onyoursite.x.example.io/SOA', { Status: 3, Authority: [soa('on-your.site')] });
  assert.equal(await detectZone(doh, 'x.example.io', 'on-your.site'), null);
});

test('the mail of the domain worker: the real template, every value escaped, the title as subject', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oys-domain-mail-'));
  const sent: CapturedMail[] = [];
  try {
    // Zugangsdaten zur Laufzeit (keine festen Werte im Repository); verschickt wird nichts
    writeFileSync(join(dir, 'smtp.json'), JSON.stringify({
      host: '127.0.0.1', port: 1, username: 'noreply@on-your.site', password: 'x-' + process.pid, from_email: 'noreply@on-your.site', from_name: 'OnYourSite',
    }));
    copyFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'email', 'domain_notice.json'), join(dir, 'domain_notice.json'));
    setMailDirForTests(dir);
    setMailTransportForTests((m) => void sent.push(m));
    const ok = await defaultSender({
      to: 'mia@test.de', title: 'Your domain is live', text: 'links.example.com now shows your page “<b>Mia & Co</b>”.', button: 'Open the editor',
      url: 'https://on-your.site/dashboard?page=2&x=1#settings/domain', footer: 'You’re getting this email about your custom domain on on-your.site.',
    });
    assert.equal(ok, true);
    assert.equal(sent.length, 1);
    const msg = parseMessage(sent[0].raw);
    assert.equal(header(msg, 'subject'), 'Your domain is live');
    const html = leaves(msg).find((p) => p.type === 'text/html')?.body.toString('utf8') ?? '';
    assert.ok(html.includes('&lt;b&gt;Mia &amp; Co&lt;/b&gt;'), html);
    assert.ok(!html.includes('<b>Mia'), 'no markup from a page title');
    assert.ok(html.includes('href="https://on-your.site/dashboard?page=2&amp;x=1#settings/domain"'));
    assert.ok(html.includes('>Open the editor</a>') && html.includes('custom domain on on-your.site.'));
  } finally {
    setMailTransportForTests(null);
    setMailDirForTests(null);
    rmSync(dir, { recursive: true, force: true });
  }
});
