// Eigene Domain im Editor (PD-4): zwei Konten und eine Domain. „Remove“ liest die Domain der Seite vor seiner
// Transaktion; übernimmt genau dazwischen ein anderes Konto die Domain mit seinem TXT-Nachweis, darf das Entfernen nie
// dessen Domain treffen. Der Haltepunkt 'domain-remove' (honeycombs/ledger.ts: pausePoint) hält den Ablauf genau dort an.
// Eine übernommene Domain, die beim bisherigen Konto seit Monaten live war, bekommt beim neuen Konto eine frische
// Einrichtungsfrist (die Entscheidung des Domain-Dienstes, evaluate(), ohne Netz). Übernahme und „Remove“ zugleich
// sperren in derselben Reihenfolge (Seiten vor Domain-Zeilen) und verklemmen sich nicht ('domain-remove-locked').
// Dieselbe Frist gilt, wenn Premium für eine pausierte, lange live gewesene Domain zurückkommt (reconcileUser).
// Ein Doppelklick auf „Connect“ (zweite Anfrage überholt die erste am Haltepunkt 'domain-add') bekommt zweimal dieselbe
// Domain (Entwurf 2.8: dieselbe Seite → die bestehende Zeile).
import { test, before, after, afterEach } from 'node:test';
import { AsyncResource } from 'node:async_hooks';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { loadConfig, setConfigForTests } from '../src/config.js';
import { makeTestCtx, type Ctx } from '../src/web/ctx.js';
import { appRoutes } from '../src/app/dispatch.js';
import { ensureSchema } from '../src/schema.js';
import { createDomain, ownershipToken, reconcileUser, saveDomainSettings } from '../src/domains/index.js';
import { setDohForTests } from '../src/domains/editor.js';
import { domainById } from '../src/domains/store.js';
import { DOMAIN_SETTINGS_DEFAULTS } from '../src/domains/settings.js';
import { NO_FACTS, evaluate, type EvalInput } from '../src/domains/worker/evaluate.js';
import { date, strtotime } from '../src/php.js';
import { setPauseGateForTests } from '../src/honeycombs/ledger.js';
import type { Doh, DohReply } from '../src/domains/worker/dns.js';
import { CSRF, jsonBody, loginSession, runRequest, testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
const U = 5; // bisheriger Besitzer
const W = 6; // echter Besitzer der Domain (TXT-Nachweis)
const pages: Record<number, number> = {};
let txt: string[] = [];

async function sql(query: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [r] = await t.admin.query<RowDataPacket[]>(query.replace(/`DB`/g, '`' + t.name + '`'), params);
  return r;
}
async function api(userId: number, action: string, json: unknown): Promise<Ctx> {
  const sid = await loginSession(userId);
  const ctx = makeTestCtx({ method: 'POST', url: '/dashboard/api/' + action, cookies: { PHPSESSID: sid },
    headers: { 'content-type': 'application/json', 'x-csrf-token': CSRF }, rawBody: Buffer.from(JSON.stringify(json)) });
  return runRequest(ctx, appRoutes);
}

before(async () => {
  t = await testDatabase('pd4race', { empty: true });
  setConfigForTests({ ...loadConfig(), base_domain: 'oys.test', scheme: 'http', cloudflare: { zone_id: 'b'.repeat(32) },
    custom_domains: { cname_target: 'edge.oys.test', fallback_origin: 'origin.oys.test' } });
  await ensureSchema();
  for (const id of [U, W]) {
    await sql("INSERT INTO `DB`.users (id, email, password, full_name, is_admin, created_at, premium_until) VALUES (?, ?, 'x', 'U', 0, '2025-01-01 10:00:00', '2030-01-01 10:00:00')", [id, `r${id}@test.de`]);
    const [r] = await t.admin.query(`INSERT INTO \`${t.name}\`.pages (user_id, slug, title, created_at) VALUES (?, ?, 'x', NOW())`, [id, 'race-' + id]);
    pages[id] = (r as { insertId: number }).insertId;
  }
  await saveDomainSettings({ enabled: true, per_user: 3, min_account_days: 0 });
  setDohForTests({ query: async (name: string): Promise<DohReply[]> => [{ rcode: 0, answer: txt.map((v) => ({ name, type: 16, data: '"' + v + '"' })), authority: [] }] } as unknown as Doh);
});

afterEach(() => {
  setPauseGateForTests(null);
});

after(async () => {
  setDohForTests(null);
  await t.done();
});

test('remove never hits a domain that another account took over with its TXT proof in the meantime', { timeout: 60000 }, async () => {
  const host = 'race.example.com';
  const id = await createDomain({ hostname: host, targetId: pages[U], userId: U });
  txt = [ownershipToken(W, host)];
  let claimed: Ctx | null = null;
  // U hat die Domain gelesen und bestätigt; genau jetzt übernimmt W sie mit seinem TXT-Nachweis
  setPauseGateForTests(async (name) => {
    if (name !== 'domain-remove' || claimed) return;
    claimed = await api(W, 'domain-add', { page_id: pages[W], hostname: host, claim: true });
  });
  const r = await api(U, 'domain-remove', { page_id: pages[U], confirm: host });
  assert.ok(claimed, 'the pause point was reached');
  assert.equal((claimed as Ctx).status, 200, JSON.stringify(jsonBody(claimed as Ctx)));
  assert.equal(jsonBody(claimed as Ctx).transferred, true);
  // Ws Domain bleibt, wie sie ist – U bekommt „keine Domain mehr“
  const rows = await sql('SELECT user_id, target_id, state FROM `DB`.custom_domains WHERE id = ?', [id]);
  assert.equal(rows.length, 1, 'the domain of the other account was removed');
  assert.deepEqual([rows[0].user_id, rows[0].target_id, rows[0].state], [W, pages[W], 'verifying']);
  assert.equal((await sql("SELECT COUNT(*) AS n FROM `DB`.custom_domain_log WHERE domain_id = ? AND event = 'removed'", [id]))[0].n, 0);
  assert.equal(r.status, 404, JSON.stringify(jsonBody(r)));
  assert.equal(jsonBody(r).error, 'This page has no custom domain.');
});

test('taking over a domain that was live for months: the old owner gets bell and mail, the new owner a fresh setup window', { timeout: 60000 }, async () => {
  const host = 'longlive.example.com';
  for (const table of ['custom_domains', 'custom_domain_log', 'notifications']) await sql(`DELETE FROM \`DB\`.${table}`);
  const id = await createDomain({ hostname: host, targetId: pages[U], userId: U });
  // Bei U seit Monaten live: Hostname bei Cloudflare seit März 2025
  await sql(`UPDATE \`DB\`.custom_domains SET state = 'active', cf_id = 'cf-longlive', cf_status = 'active', cf_ssl_status = 'active',
    cf_created_at = '2025-03-01 10:00:00', verified_at = '2025-03-01 09:00:00', activated_at = '2025-03-01 11:00:00' WHERE id = ?`, [id]);
  await sql('UPDATE `DB`.pages SET custom_domain = ? WHERE id = ?', [host, pages[U]]);
  txt = [ownershipToken(W, host)];
  const r = await api(W, 'domain-add', { page_id: pages[W], hostname: host, claim: true });
  assert.equal(r.status, 200, JSON.stringify(jsonBody(r)));
  assert.equal(jsonBody(r).transferred, true);
  // Das bisherige Konto erfährt es über die Glocke und per Mail (Entwurf 4.11: domain_removed wird gemailt); die
  // Mail-Zeile zeigt nicht auf die Domain, die jetzt zu Ws Seite gehört
  assert.equal((await sql("SELECT COUNT(*) AS n FROM `DB`.notifications WHERE user_id = ? AND type = 'domain_removed'", [U]))[0].n, 1);
  const mails = await sql("SELECT domain_id, hostname, detail FROM `DB`.custom_domain_log WHERE user_id = ? AND event = 'domain_removed' AND mail = 1", [U]);
  assert.equal(mails.length, 1, 'the old owner gets no mail about the takeover');
  assert.equal(mails[0].domain_id, null);
  assert.equal(mails[0].hostname, host);
  assert.match(String(mails[0].detail), /connected it to another account/);
  const moved = await domainById(id);
  assert.ok(moved);
  // Der Domain-Dienst: Ws TXT-Wert ist da → weiter zur Einrichtung mit dem vorhandenen Hostnamen …
  const now = Math.floor(Date.now() / 1000);
  const base = { settings: { ...DOMAIN_SETTINGS_DEFAULTS }, frozen: false, at: (u: number) => date('Y-m-d H:i:s', u),
    toUnix: (s: string) => { const v = strtotime(s); return v === false ? 0 : v; }, facts: NO_FACTS };
  const txtMine = { values: [ownershipToken(W, host)], mine: true, others: [], answered: 2, unknown: false };
  const first = evaluate({ ...base, row: moved, obs: { txt: txtMine }, now: now + 5, manual: true } as EvalInput);
  assert.equal(first.state, 'pending');
  // … und die nächste Runde, während Cloudflare das Zertifikat noch ausstellt: keine sofortige Zeitüberschreitung
  const pendingRow = { ...moved, ...first.set, state: 'pending', state_at: date('Y-m-d H:i:s', now + 5) } as typeof moved;
  const second = evaluate({ ...base, row: pendingRow, now: now + 65, manual: false,
    obs: { cf: { kind: 'ok', status: 'active', sslStatus: 'pending_validation', host: null } } } as EvalInput);
  assert.notEqual(second.state, 'failed', 'setup_timeout right after the takeover: ' + JSON.stringify(second.set));
  assert.equal(second.cfAction === 'delete', false);
});

test('remove and a takeover at the same moment lock in the same order: no deadlock, the removal wins', { timeout: 60000 }, async () => {
  const host = 'both.example.com';
  for (const table of ['custom_domains', 'custom_domain_log', 'notifications', 'rate_limits']) await sql(`DELETE FROM \`DB\`.${table}`);
  const id = await createDomain({ hostname: host, targetId: pages[U], userId: U });
  txt = [ownershipToken(W, host)];
  let claim: Promise<Ctx> | null = null;
  // Ws Anfrage läuft außerhalb von Us Transaktion (eigene Verbindung, nicht die gepinnte des Haltepunkts)
  const outside = AsyncResource.bind((): Promise<Ctx> => api(W, 'domain-add', { page_id: pages[W], hostname: host, claim: true }));
  // U entfernt und hält schon seine Seite; W übernimmt im selben Moment (wartet in der Datenbank auf eine Sperre)
  setPauseGateForTests(async (name) => {
    if (name !== 'domain-remove-locked' || claim) return;
    claim = outside();
    await new Promise((resolve) => setTimeout(resolve, 1500));
  });
  const removed = await api(U, 'domain-remove', { page_id: pages[U], confirm: host });
  assert.ok(claim, 'the pause point was reached');
  const claimed = await (claim as unknown as Promise<Ctx>);
  assert.equal(removed.status, 200, 'remove: ' + removed.status + ' ' + JSON.stringify(jsonBody(removed)));
  assert.equal(jsonBody(removed).ok, true);
  assert.equal(claimed.status, 409, 'claim: ' + JSON.stringify(jsonBody(claimed)));
  assert.equal(jsonBody(claimed).error, 'Please try again.');
  assert.equal((await sql('SELECT COUNT(*) AS n FROM `DB`.custom_domains WHERE id = ?', [id]))[0].n, 0);
});

test('Premium back for a paused domain that was live for months: the setup window starts again', { timeout: 60000 }, async () => {
  const host = 'paused.example.com';
  for (const table of ['custom_domains', 'custom_domain_log', 'notifications']) await sql(`DELETE FROM \`DB\`.${table}`);
  const id = await createDomain({ hostname: host, targetId: pages[U], userId: U });
  // Pausiert (Premium war weg) mit Weiterleitung über den Hostnamen, der seit März 2025 besteht; U hat wieder Premium
  await sql(`UPDATE \`DB\`.custom_domains SET state = 'suspended', cf_id = 'cf-paused', cf_status = 'active', cf_ssl_status = 'active',
    cf_created_at = '2025-03-01 10:00:00', verified_at = '2025-03-01 09:00:00', activated_at = '2025-03-01 11:00:00', suspended_at = NOW() - INTERVAL 1 DAY
    WHERE id = ?`, [id]);
  await reconcileUser(U);
  const row = await domainById(id);
  assert.ok(row);
  assert.equal(row.state, 'pending');
  const now = Math.floor(Date.now() / 1000);
  const d = evaluate({ settings: { ...DOMAIN_SETTINGS_DEFAULTS }, frozen: false, at: (u: number) => date('Y-m-d H:i:s', u),
    toUnix: (v: string) => { const x = strtotime(v); return x === false ? 0 : x; }, facts: NO_FACTS, row, now: now + 60, manual: false,
    obs: { cf: { kind: 'ok', status: 'active', sslStatus: 'pending_validation', host: null } } } as EvalInput);
  assert.notEqual(d.state, 'failed', 'setup_timeout right after Premium came back: ' + JSON.stringify(d.set));
});

test('a double click on Connect: both requests answer with the one new domain', { timeout: 60000 }, async () => {
  const host = 'twice.example.com';
  for (const table of ['custom_domains', 'custom_domain_log', 'notifications', 'rate_limits']) await sql(`DELETE FROM \`DB\`.${table}`);
  let second: Promise<Ctx> | null = null;
  const outside = AsyncResource.bind((): Promise<Ctx> => api(U, 'domain-add', { page_id: pages[U], hostname: host }));
  // Beide haben „keine Domain“ gelesen; die zweite legt sie an, bevor die erste die Platz-Sperre bekommt
  setPauseGateForTests(async (name) => {
    if (name !== 'domain-add' || second) return;
    second = outside();
    await second;
  });
  const first = await api(U, 'domain-add', { page_id: pages[U], hostname: host });
  assert.ok(second, 'the pause point was reached');
  const other = await (second as unknown as Promise<Ctx>);
  for (const r of [other, first]) {
    assert.equal(r.status, 200, JSON.stringify(jsonBody(r)));
    assert.equal(jsonBody(r).ok, true);
    assert.equal((jsonBody(r).domain as { hostname: string }).hostname, host);
  }
  assert.equal((await sql('SELECT COUNT(*) AS n FROM `DB`.custom_domains WHERE hostname = ?', [host]))[0].n, 1);
});

test('R2: a hostname blocked and removed while another account’s Connect waits is still refused', { timeout: 60000 }, async () => {
  const host = 'blocked-race.example.com';
  for (const table of ['custom_domains', 'custom_domain_log', 'notifications', 'rate_limits']) await sql(`DELETE FROM \`DB\`.${table}`);
  let removed: Promise<Ctx> | null = null;
  // U verbindet den Namen, das Team sperrt ihn, U entfernt ihn – nachdem W „frei“ gelesen hat, vor Ws Transaktion
  const outside = AsyncResource.bind(async (): Promise<Ctx> => {
    await createDomain({ hostname: host, targetId: pages[U], userId: U });
    await sql("UPDATE `DB`.custom_domains SET state = 'blocked' WHERE hostname = ?", [host]);
    return api(U, 'domain-remove', { page_id: pages[U], confirm: host });
  });
  setPauseGateForTests(async (name) => {
    if (name !== 'domain-add' || removed) return;
    removed = outside();
    await removed;
  });
  const r = await api(W, 'domain-add', { page_id: pages[W], hostname: host });
  assert.ok(removed, 'the pause point was reached');
  assert.equal((await (removed as unknown as Promise<Ctx>)).status, 200);
  assert.equal(r.status, 409, JSON.stringify(jsonBody(r)));
  assert.equal(jsonBody(r).error, 'This domain was disabled by the OnYourSite team and can’t be connected. Please contact support.');
  assert.equal((await sql('SELECT COUNT(*) AS n FROM `DB`.custom_domains WHERE hostname = ?', [host]))[0].n, 0);
  assert.equal((await sql('SELECT COUNT(*) AS n FROM `DB`.custom_domain_blocks WHERE hostname = ?', [host]))[0].n, 1);
});
