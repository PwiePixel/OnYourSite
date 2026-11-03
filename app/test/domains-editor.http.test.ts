// HTTP: eigene Domain im Editor (PD-4). Vorrede (Login, CSRF, fremde Seite), nur Premium (auch nicht kurz vor dem
// Ende, nicht für junge Konten), Hostnamen-Prüfung, Wurzeldomain-Rückfrage, Grenze je Konto, Übernahme fremder Domains
// nur mit eigenem TXT-Nachweis (DoH ersetzt), Prüfen mit Wartezeit, Weiterleitung, Entfernen mit Bestätigung – und
// Zusatz-Einträge ohne Markup. Cloudflare wird nie gefragt (die Routen schreiben nur die Datenbank).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { loadConfig, setConfigForTests } from '../src/config.js';
import { makeTestCtx, type Ctx } from '../src/web/ctx.js';
import { appRoutes } from '../src/app/dispatch.js';
import { ensureSchema } from '../src/schema.js';
import { createDomain, hostnameBlocked, ownershipToken, releaseBlock, saveDomainSettings } from '../src/domains/index.js';
import { setDohForTests } from '../src/domains/editor.js';
import type { Doh, DohReply } from '../src/domains/worker/dns.js';
import { CSRF, jsonBody, loginSession, runRequest, testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
const OLD = '2025-01-01 10:00:00';
const FAR = '2030-01-01 10:00:00';
const U = 5; // Premium
const V = 6; // Premium, besitzt shop.example.net
const N = 7; // ohne Premium
const Y = 8; // Premium, Konto neu
const S = 9; // Premium endet bald
const pages: Record<string, number> = {};
const BLOCKED_TEXT = 'This domain was disabled by the OnYourSite team and can’t be connected. Please contact support.';

async function sql(query: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [r] = await t.admin.query<RowDataPacket[]>(query.replace(/`DB`/g, '`' + t.name + '`'), params);
  return r;
}
const count = async (query: string, params: unknown[] = []): Promise<number> => Number((await sql(query, params))[0].n);

async function api(action: string, o: { userId?: number; json?: unknown; method?: string; csrf?: string | null; query?: string; impersonatedBy?: number } = {}): Promise<Ctx> {
  const sid = o.userId === undefined ? null : await loginSession(o.userId, o.impersonatedBy !== undefined ? { impersonatedBy: o.impersonatedBy } : {});
  const method = o.method ?? 'POST';
  const headers: Record<string, string> = {};
  if (method === 'POST') headers['content-type'] = 'application/json';
  if (o.csrf !== null) headers['x-csrf-token'] = o.csrf ?? CSRF;
  const ctx = makeTestCtx({ method, url: '/dashboard/api/' + action + (o.query ?? ''), headers, cookies: sid ? { PHPSESSID: sid } : undefined,
    rawBody: method === 'POST' ? Buffer.from(JSON.stringify(o.json ?? {})) : undefined });
  return runRequest(ctx, appRoutes);
}
const add = (userId: number, page: number, hostname: string, extra: Record<string, unknown> = {}) =>
  api('domain-add', { userId, json: { page_id: page, hostname, ...extra } });
const get = (userId: number, page: number) => api('domain', { userId, method: 'GET', query: '?page=' + page });

// DoH-Antworten für „I’ve added it“: TXT-Werte je Name (null = kein Resolver antwortet)
let txt: string[] | null = [];
const fakeDoh = { query: async (name: string): Promise<DohReply[]> => {
  if (txt === null) return [{ rcode: null, answer: [], authority: [] }];
  return [{ rcode: 0, answer: txt.map((v) => ({ name, type: 16, data: '"' + v + '"' })), authority: [] }];
} } as unknown as Doh;

before(async () => {
  t = await testDatabase('pd4http', { empty: true });
  setConfigForTests({ ...loadConfig(), base_domain: 'oys.test', scheme: 'http', cloudflare: { zone_id: 'f'.repeat(32) },
    custom_domains: { cname_target: 'edge.oys.test', fallback_origin: 'origin.oys.test' } });
  await ensureSchema();
  const user = 'INSERT INTO `DB`.users (id, email, password, full_name, is_admin, created_at, premium_until) VALUES (?, ?, \'x\', ?, 0, ?, ?)';
  const soon = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
  for (const [id, created, prem] of [[U, OLD, FAR], [V, OLD, FAR], [N, OLD, null], [Y, new Date().toISOString().slice(0, 19).replace('T', ' '), FAR], [S, OLD, soon]] as const) {
    await sql(user, [id, `u${id}@test.de`, 'User ' + id, created, prem]);
  }
  for (const [key, uid] of [['u1', U], ['u2', U], ['u3', U], ['v1', V], ['n1', N], ['y1', Y], ['s1', S]] as const) {
    const [r] = await t.admin.query(`INSERT INTO \`${t.name}\`.pages (user_id, slug, title, created_at) VALUES (?, ?, 'x', ?)`, [uid, 'pg-' + key, OLD]);
    pages[key] = (r as { insertId: number }).insertId;
  }
  await saveDomainSettings({ enabled: true, per_user: 2, min_account_days: 30 });
  setDohForTests(fakeDoh);
});

// Jeder Fall mit leeren Ratenlimits (eigener Fall unten)
beforeEach(async () => {
  await sql('DELETE FROM `DB`.rate_limits');
});

after(async () => {
  setDohForTests(null);
  await t.done();
});

test('login and CSRF are required; nothing is written without them', async () => {
  const anon = await api('domain-add', { json: { page_id: pages.u1, hostname: 'links.example.com' } });
  assert.notEqual(anon.status, 200);
  const noCsrf = await api('domain-add', { userId: U, csrf: null, json: { page_id: pages.u1, hostname: 'links.example.com' } });
  assert.equal(noCsrf.status, 419);
  const wrongCsrf = await api('domain-add', { userId: U, csrf: 'd'.repeat(64), json: { page_id: pages.u1, hostname: 'links.example.com' } });
  assert.equal(wrongCsrf.status, 419);
  assert.equal(await count('SELECT COUNT(*) AS n FROM `DB`.custom_domains'), 0);
});

test('Premium only: teaser data without Premium, 403 on add; short Premium and young accounts are refused', async () => {
  const g = jsonBody(await get(N, pages.n1));
  assert.equal(g.ok, true);
  assert.equal((g.premium as { active: boolean }).active, false);
  assert.equal(g.domain, null);
  const r = await add(N, pages.n1, 'links.example.com');
  assert.equal(r.status, 403);
  assert.equal(jsonBody(r).premium, false);
  assert.equal(jsonBody(r).error, 'Custom domains are part of Premium.');
  const s = await add(S, pages.s1, 'links.example.com');
  assert.equal(s.status, 403);
  assert.match(String(jsonBody(s).error), /^Your Premium ends on .+\. Extend it to connect a domain\.$/);
  const y = await add(Y, pages.y1, 'links.example.com');
  assert.equal(y.status, 403);
  assert.equal(jsonBody(y).error, 'Custom domains are available once your account is 30 days old.');
  assert.equal(await count('SELECT COUNT(*) AS n FROM `DB`.custom_domains'), 0);
});

test('another account’s page id is refused without any write', async () => {
  const r = await add(U, pages.v1, 'links.example.com');
  assert.equal(r.status, 409);
  assert.equal(jsonBody(r).reload, true);
  assert.equal(await count('SELECT COUNT(*) AS n FROM `DB`.custom_domains'), 0);
  const g = await get(U, pages.v1);
  assert.equal(g.status, 409);
});

test('invalid input, own base domain and markup are refused with fixed texts', async () => {
  for (const bad of ['', 'not a domain', '*.example.com', 'mia.oys.test', '<script>alert(1)</script>.com']) {
    const r = await add(U, pages.u1, bad);
    assert.equal(r.status, 400, bad);
    assert.ok(!String(jsonBody(r).error).includes('<'), bad);
  }
});

test('add a subdomain: verifying row, TXT and CNAME records, check with cooldown, forwarding switch', async () => {
  const r = await add(U, pages.u1, 'Links.Example.com');
  assert.equal(r.status, 200);
  const d = jsonBody(r).domain as Record<string, unknown> & { records: Array<Record<string, string>> };
  assert.equal(d.hostname, 'links.example.com');
  assert.equal(d.state, 'verifying');
  assert.deepEqual(d.records.map((x) => [x.type, x.host, x.value]), [
    ['TXT', '_onyoursite.links', ownershipToken(U, 'links.example.com')], ['CNAME', 'links', 'edge.oys.test']]);
  assert.equal(await count("SELECT COUNT(*) AS n FROM `DB`.custom_domain_log WHERE event = 'added' AND hostname = 'links.example.com'"), 1);
  // Gleiche Seite, gleiche Domain: dieselbe Zeile; zweite Domain für dieselbe Seite: abgelehnt
  assert.equal(jsonBody(await add(U, pages.u1, 'links.example.com')).ok, true);
  const second = await add(U, pages.u1, 'other.example.com');
  assert.equal(second.status, 409);
  assert.equal(jsonBody(second).error, 'This page already has a domain. Remove it first.');
  // Dieselbe Domain auf der anderen eigenen Seite
  const other = await add(U, pages.u2, 'links.example.com');
  assert.equal(other.status, 409);
  assert.match(String(jsonBody(other).error), /already connected to your page “pg-u1”/);
  // Prüfen: checking, dann Wartezeit
  const c1 = jsonBody(await api('domain-check', { userId: U, json: { page_id: pages.u1 } }));
  assert.equal((c1.domain as { checking: boolean }).checking, true);
  assert.ok((c1.domain as { fastUntil: string | null }).fastUntil);
  const c2 = jsonBody(await api('domain-check', { userId: U, json: { page_id: pages.u1 } }));
  assert.equal(c2.cooldown, true);
  // GET ändert nichts
  const before = await count('SELECT version AS n FROM `DB`.custom_domains WHERE hostname = ?', ['links.example.com']);
  const g = jsonBody(await get(U, pages.u1));
  assert.equal((g.domain as { hostname: string }).hostname, 'links.example.com');
  assert.equal(await count('SELECT version AS n FROM `DB`.custom_domains WHERE hostname = ?', ['links.example.com']), before);
  // Weiterleitung aus
  const st = jsonBody(await api('domain-settings', { userId: U, json: { page_id: pages.u1, redirect: false } }));
  assert.equal((st.domain as { redirect: boolean }).redirect, false);
});

test('root domains need a confirmation; the per-user limit holds', async () => {
  const q1 = jsonBody(await add(U, pages.u2, 'example.org'));
  assert.equal(q1.ok, false);
  assert.equal(q1.confirm, 'apex');
  assert.equal(q1.suggest, 'www.example.org');
  const ok = jsonBody(await add(U, pages.u2, 'example.org', { apex_ok: true }));
  assert.equal(ok.ok, true);
  assert.equal((ok.domain as { apex: boolean }).apex, true);
  const limit = await add(U, pages.u3, 'third.example.com');
  assert.equal(limit.status, 409);
  assert.equal(jsonBody(limit).error, 'You’ve connected 2 of 2 domains. Remove one from another page to connect a new one.');
});

test('extra records from the worker are shown without markup', async () => {
  const bad = JSON.stringify([{ type: 'TXT', name: '_cf-custom-hostname.example.org', value: 'abc-123' },
    { type: 'TXT', name: '<img src=x onerror=alert(1)>', value: 'x' }, { type: 'CNAME', name: 'a.example.org', value: '"><script>' }]);
  await sql('UPDATE `DB`.custom_domains SET extra_records = ? WHERE hostname = ?', [bad, 'example.org']);
  const d = jsonBody(await get(U, pages.u2)).domain as { extra: Array<Record<string, string>> };
  assert.deepEqual(d.extra.map((x) => [x.type, x.host, x.value]), [['TXT', '_cf-custom-hostname', 'abc-123']]);
});

test('takeover: another account’s domain needs this account’s TXT value', async () => {
  await createDomain({ hostname: 'shop.example.net', targetId: pages.v1, userId: V });
  await sql("UPDATE `DB`.pages SET custom_domain = 'shop.example.net' WHERE id = ?", [pages.v1]);
  await sql("UPDATE `DB`.custom_domains SET state = 'active' WHERE hostname = 'shop.example.net'");
  await sql('DELETE FROM `DB`.custom_domains WHERE hostname = ?', ['example.org']);
  const token = ownershipToken(U, 'shop.example.net');
  // Ohne claim: Aufgabe mit dem eigenen TXT-Wert, der Zustand des anderen Kontos bleibt verborgen
  const c = await add(U, pages.u2, 'shop.example.net');
  assert.equal(c.status, 409);
  const body = jsonBody(c);
  assert.deepEqual(body.challenge, { type: 'TXT', host: '_onyoursite.shop', name: '_onyoursite.shop.example.net', value: token });
  assert.ok(!JSON.stringify(body).includes('active'));
  // claim, aber der Wert fehlt / ein fremder Wert ist auch da / DNS antwortet nicht
  txt = [];
  assert.ok(jsonBody(await add(U, pages.u2, 'shop.example.net', { claim: true })).challenge);
  txt = [token, ownershipToken(V, 'shop.example.net')];
  assert.match(String(jsonBody(await add(U, pages.u2, 'shop.example.net', { claim: true })).error), /There is another OnYourSite TXT value/);
  txt = null;
  assert.match(String(jsonBody(await add(U, pages.u2, 'shop.example.net', { claim: true })).error), /couldn’t check your DNS/);
  const unchanged = await sql('SELECT user_id, target_id, state FROM `DB`.custom_domains WHERE hostname = ?', ['shop.example.net']);
  assert.deepEqual([unchanged[0].user_id, unchanged[0].target_id, unchanged[0].state], [V, pages.v1, 'active']);
  // Nur der eigene Wert: Übernahme, das andere Konto verliert die Hauptadresse und bekommt einen Hinweis
  txt = [token];
  const ok = await add(U, pages.u2, 'shop.example.net', { claim: true });
  assert.equal(ok.status, 200);
  assert.equal(jsonBody(ok).transferred, true);
  const moved = await sql('SELECT user_id, target_id, state FROM `DB`.custom_domains WHERE hostname = ?', ['shop.example.net']);
  assert.deepEqual([moved[0].user_id, moved[0].target_id, moved[0].state], [U, pages.u2, 'verifying']);
  assert.equal((await sql('SELECT custom_domain FROM `DB`.pages WHERE id = ?', [pages.v1]))[0].custom_domain, null);
  assert.equal(await count("SELECT COUNT(*) AS n FROM `DB`.notifications WHERE user_id = ? AND type = 'domain_removed'", [V]), 1);
  assert.equal(await count("SELECT COUNT(*) AS n FROM `DB`.custom_domain_log WHERE event = 'transferred'"), 1);
});

test('blocked and removing domains of other accounts cannot be claimed', async () => {
  await createDomain({ hostname: 'blocked.example.net', targetId: pages.v1, userId: V });
  await sql("UPDATE `DB`.custom_domains SET state = 'blocked' WHERE hostname = 'blocked.example.net'");
  txt = [ownershipToken(U, 'blocked.example.net')];
  const r = await add(U, pages.u3, 'blocked.example.net', { claim: true });
  assert.equal(r.status, 409);
  assert.equal(jsonBody(r).error, BLOCKED_TEXT);
  assert.equal((await sql('SELECT user_id FROM `DB`.custom_domains WHERE hostname = ?', ['blocked.example.net']))[0].user_id, V);
});

test('R2: removing a blocked domain detaches it, but the hostname stays blocked for every account until an admin releases it', async () => {
  // Stand aus dem Fall davor: blocked.example.net hängt gesperrt an der Seite von V
  await sql("UPDATE `DB`.custom_domains SET blocked_reason = 'spam' WHERE hostname = 'blocked.example.net'");
  const removed = await api('domain-remove', { userId: V, json: { page_id: pages.v1, confirm: 'blocked.example.net' } });
  assert.equal(removed.status, 200);
  assert.equal(jsonBody(await get(V, pages.v1)).domain, null);
  assert.equal(await count('SELECT COUNT(*) AS n FROM `DB`.custom_domains WHERE hostname = ?', ['blocked.example.net']), 0);
  assert.equal(await hostnameBlocked('blocked.example.net'), true);
  // Dasselbe Konto, ein anderes Konto, ein anderes Konto mit TXT-Nachweis: abgelehnt, nichts geschrieben
  const same = await add(V, pages.v1, 'blocked.example.net');
  assert.equal(same.status, 409);
  assert.equal(jsonBody(same).error, BLOCKED_TEXT);
  const other = await add(U, pages.u3, 'blocked.example.net');
  assert.equal(other.status, 409);
  assert.equal(jsonBody(other).error, BLOCKED_TEXT);
  txt = [ownershipToken(U, 'blocked.example.net')];
  const claim = await add(U, pages.u3, 'blocked.example.net', { claim: true });
  assert.equal(claim.status, 409);
  assert.equal(jsonBody(claim).error, BLOCKED_TEXT);
  // Andere Schreibweisen desselben Namens (groß mit Punkt am Ende, eingefügte Adresse mit Port, Breitzeichen): erst
  // normalisiert, dann gegen die Sperre geprüft
  for (const variant of ['BLOCKED.Example.NET.', 'https://blocked.example.net:8443/x?y=1', 'ｂｌｏｃｋｅｄ．ｅｘａｍｐｌｅ．ｎｅｔ']) {
    const r = await add(U, pages.u3, variant);
    assert.equal(r.status, 409, variant);
    assert.equal(jsonBody(r).error, BLOCKED_TEXT, variant);
  }
  assert.equal(await count('SELECT COUNT(*) AS n FROM `DB`.custom_domains WHERE hostname = ?', ['blocked.example.net']), 0);
  // Ein Admin gibt den Hostnamen frei: danach lässt er sich wieder verbinden
  assert.equal(await releaseBlock('blocked.example.net'), true);
  assert.equal(await hostnameBlocked('blocked.example.net'), false);
  const again = await add(V, pages.v1, 'blocked.example.net');
  assert.equal(again.status, 200);
  assert.equal((jsonBody(again).domain as { state: string }).state, 'verifying');
  assert.equal(await releaseBlock('blocked.example.net'), false);
  assert.equal(await count("SELECT COUNT(*) AS n FROM `DB`.custom_domain_log WHERE hostname = 'blocked.example.net' AND event = 'unblocked'"), 1);
  // Aufräumen für die folgenden Fälle
  assert.equal((await api('domain-remove', { userId: V, json: { page_id: pages.v1, confirm: 'blocked.example.net' } })).status, 200);
});

test('remove needs the typed domain; afterwards the page has none', async () => {
  const wrong = await api('domain-remove', { userId: U, json: { page_id: pages.u1, confirm: 'other.example.com' } });
  assert.equal(wrong.status, 400);
  assert.equal(jsonBody(wrong).error, 'To confirm, please type the domain.');
  const foreign = await api('domain-remove', { userId: U, json: { page_id: pages.v1, confirm: 'shop.example.net' } });
  assert.equal(foreign.status, 409);
  const ok = jsonBody(await api('domain-remove', { userId: U, json: { page_id: pages.u1, confirm: 'LINKS.example.com.' } }));
  assert.equal(ok.ok, true);
  assert.equal((ok.records as unknown[]).length, 2);
  assert.equal(await count('SELECT COUNT(*) AS n FROM `DB`.custom_domains WHERE hostname = ?', ['links.example.com']), 0);
  assert.equal(jsonBody(await get(U, pages.u1)).domain, null);
  const none = await api('domain-check', { userId: U, json: { page_id: pages.u1 } });
  assert.equal(none.status, 404);
});

test('R8: an admin working as the user sees the domain but changes nothing – every domain action is refused', async () => {
  const ADMIN = 3;
  const HOST_R8 = 'admin-mode.example.com';
  // Eine eigene, aktive Domain auf V's Seite – unabhängig vom Stand der Tests davor
  await createDomain({ hostname: HOST_R8, targetId: pages.v1, userId: V });
  await sql("UPDATE `DB`.custom_domains SET state = 'active' WHERE hostname = ?", [HOST_R8]);
  try {
    const rows = async () => (await sql('SELECT hostname, user_id, target_id, state, redirect, version, manual_at FROM `DB`.custom_domains ORDER BY id')).map((r) => ({ ...r }));
    const before = await rows();
    const logs = await count('SELECT COUNT(*) AS n FROM `DB`.custom_domain_log');
    // Ansehen geht: die Domain ist da, dazu der Hinweis für den Editor
    const g = jsonBody(await api('domain', { userId: V, method: 'GET', query: '?page=' + pages.v1, impersonatedBy: ADMIN }));
    assert.equal(g.adminMode, true);
    assert.equal((g.domain as { hostname: string }).hostname, HOST_R8);
    assert.equal(jsonBody(await get(V, pages.v1)).adminMode, false);
    // Jede Änderung: 403, auch die Übernahme mit dem passenden TXT-Wert (claim) und eine neue Domain
    txt = [ownershipToken(U, HOST_R8)];
    for (const [uid, action, json] of [
      [V, 'domain-check', { page_id: pages.v1 }],
      [V, 'domain-settings', { page_id: pages.v1, redirect: false }],
      [V, 'domain-remove', { page_id: pages.v1, confirm: HOST_R8 }],
      [U, 'domain-add', { page_id: pages.u3, hostname: 'admin-new.example.com' }],
      [U, 'domain-add', { page_id: pages.u3, hostname: HOST_R8, claim: true }],
    ] as const) {
      const r = await api(action, { userId: uid, json, impersonatedBy: ADMIN });
      assert.equal(r.status, 403, action);
      assert.deepEqual(jsonBody(r), { ok: false, code: 'admin_mode', error: 'Custom domains can’t be changed in admin mode.' }, action);
    }
    assert.deepEqual(await rows(), before);
    assert.equal(await count('SELECT COUNT(*) AS n FROM `DB`.custom_domain_log'), logs);
    // Vor der Ablehnung zählt kein Ratenlimit (beforeEach leert die Tabelle)
    assert.equal(await count('SELECT COUNT(*) AS n FROM `DB`.rate_limits'), 0);
  } finally {
    txt = [];
    await sql('DELETE FROM `DB`.custom_domains WHERE hostname = ?', [HOST_R8]);
    await sql('UPDATE `DB`.pages SET custom_domain = NULL WHERE id = ?', [pages.v1]);
  }
});

test('R8: in admin mode a page with a custom domain isn’t deleted (the domain would go with it); other pages are', async () => {
  const ADMIN = 3;
  const HOST_DEL = 'admin-delete.example.com';
  const [extra] = await t.admin.query(`INSERT INTO \`${t.name}\`.pages (user_id, slug, title, created_at) VALUES (?, 'pg-r8-extra', 'x', ?)`, [V, OLD]);
  const extraId = (extra as { insertId: number }).insertId;
  await createDomain({ hostname: HOST_DEL, targetId: pages.v1, userId: V });
  try {
    const del = (id: number, slug: string) => api('page-delete', { userId: V, json: { id, confirm: slug }, impersonatedBy: ADMIN });
    const r = await del(pages.v1, 'pg-v1');
    assert.equal(r.status, 403);
    assert.deepEqual(jsonBody(r), { ok: false, code: 'admin_mode', error: 'Pages with a custom domain can’t be deleted in admin mode.' });
    assert.equal(await count('SELECT COUNT(*) AS n FROM `DB`.pages WHERE id = ?', [pages.v1]), 1);
    assert.equal(await count('SELECT COUNT(*) AS n FROM `DB`.custom_domains WHERE hostname = ?', [HOST_DEL]), 1);
    // Eine Seite ohne Domain löscht der Admin wie bisher
    const ok = await del(extraId, 'pg-r8-extra');
    assert.equal(jsonBody(ok).ok, true, JSON.stringify(jsonBody(ok)));
    assert.equal(await count('SELECT COUNT(*) AS n FROM `DB`.pages WHERE id = ?', [extraId]), 0);
  } finally {
    await sql('DELETE FROM `DB`.custom_domains WHERE hostname = ?', [HOST_DEL]);
    await sql('DELETE FROM `DB`.pages WHERE id = ?', [extraId]);
    await sql('DELETE FROM `DB`.rate_limits');
  }
});

test('rate limit: at most 10 add attempts per account and day', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await add(N, pages.n1, 'x.example.com')).status, 403);
  // Premium-Prüfung kommt vor dem Limit: auch das elfte Mal 403 für N – für U zählt jeder Versuch nach der Premium-Prüfung
  for (let i = 0; i < 10; i++) assert.notEqual((await add(U, pages.u3, 'bad host ' + i)).status, 429);
  const r = await add(U, pages.u3, 'bad host 11');
  assert.equal(r.status, 429);
  assert.equal(jsonBody(r).error, 'You’ve added too many domains today. Please try again tomorrow.');
});
