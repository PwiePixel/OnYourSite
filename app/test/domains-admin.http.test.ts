// Eigene Domains im Admin (PD-5): der Bereich „Custom domains“ (Einrichtung, Einstellungen, Liste mit Aktionen,
// gesperrte Hostnamen, Hostnamen, die nicht von hier stammen) und jede domain_action über POST /admin – nur in der
// eigenen Sitzung eines Admins, mit CSRF und Bestätigung. Keine Aktion fragt Cloudflare: Aufträge gehen an den Dienst.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { makeTestCtx, type Ctx } from '../src/web/ctx.js';
import { appRoutes } from '../src/app/dispatch.js';
import { ensureSchema } from '../src/schema.js';
import { loadConfig, setConfigForTests } from '../src/config.js';
import { createDomain, domainById } from '../src/domains/store.js';
import { domainSettings, saveDomainSettings, updateWorkerState } from '../src/domains/settings.js';
import { CSRF, loginSession, runRequest, testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
const OLD = '2025-01-01 10:00:00';
const ADMIN = 3;
const ADMIN_B = 4;
const MIA = 5;
const pages: Record<string, number> = {};
let sid = '';

async function sql(query: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [r] = await t.admin.query<RowDataPacket[]>(query.replace(/`DB`/g, '`' + t.name + '`'), params);
  return r;
}
const n = async (query: string, params: unknown[] = []): Promise<number> => Number(Object.values((await sql(query, params))[0])[0]);

async function post(form: Record<string, string>, session = sid): Promise<Ctx> {
  return runRequest(makeTestCtx({ method: 'POST', url: '/admin', cookies: { PHPSESSID: session }, post: { csrf: CSRF, _confirmed: '1', ...form } }), appRoutes);
}
async function adminHtml(): Promise<string> {
  const ctx = await runRequest(makeTestCtx({ url: '/admin', cookies: { PHPSESSID: sid } }), appRoutes);
  assert.equal(ctx.status, 200);
  return String(ctx.body);
}
// Der Bereich #tab-domains aus der Admin-Seite
const section = (html: string): string => {
  const start = html.indexOf('<div id="tab-domains"');
  assert.ok(start >= 0, 'the Custom domains section is there');
  return html.slice(start, html.indexOf('<!-- =====', start + 10) > 0 ? html.indexOf('<!-- =====', start + 10) : undefined);
};
const flash = async (): Promise<string> => {
  const html = await adminHtml();
  return /<div data-flash="[a-z]+"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1].replace(/<[^>]+>/g, '').trim() ?? '';
};

before(async () => {
  t = await testDatabase('pd5admin', { empty: true });
  setConfigForTests({ ...loadConfig(), db: { ...(loadConfig().db as Record<string, string>), name: t.name }, base_domain: 'oys.test:8080', scheme: 'http',
    cloudflare: { zone_id: 'f'.repeat(32) }, custom_domains: { cname_target: 'edge.oys.test', fallback_origin: 'origin.oys.test' } });
  await ensureSchema();
  const user = 'INSERT INTO `DB`.users (id, email, password, full_name, is_admin, created_at, premium_until) VALUES (?, ?, \'x\', ?, ?, ?, ?)';
  await sql(user, [ADMIN, 'admin@test.de', 'Pixel Admin', 1, OLD, null]);
  await sql(user, [ADMIN_B, 'admin2@test.de', 'Second Admin', 1, OLD, null]);
  await sql(user, [MIA, 'mia@test.de', 'Mia <b>Müller</b>', 0, OLD, '2030-01-01 00:00:00']);
  for (const key of ['m1', 'm2', 'm3']) {
    const [r] = await t.admin.query(`INSERT INTO \`${t.name}\`.pages (user_id, slug, title, created_at) VALUES (?, ?, 'x', ?)`, [MIA, 'mia-' + key, OLD]);
    pages[key] = (r as { insertId: number }).insertId;
  }
  await saveDomainSettings({ enabled: true });
  sid = await loginSession(ADMIN);
});

after(async () => {
  await t.done();
});

beforeEach(async () => {
  await sql('DELETE FROM `DB`.notifications');
});

test('the section: setup, settings, the domain list with owner and page, all as text', async () => {
  const id = await createDomain({ hostname: 'links.example.com', targetId: pages.m1, userId: MIA });
  await sql("UPDATE `DB`.custom_domains SET state = 'active', problem = 'cname_wrong' WHERE id = ?", [id]);
  await updateWorkerState({ worker_at: '2026-11-03 10:00:00', token: 'ok', quota: { allocated: 100, used: 7, exceeded: false, hard_cap: 200, checked_at: '2026-11-03 10:00:00' },
    unmanaged: [{ hostname: 'hand<made>.example.org', id: 'x', status: 'active' }] });
  const html = await adminHtml();
  assert.match(html, /id="nav-domains"/);
  assert.match(html, /domains: \['Custom domains', 'border-cyan-500\/30 bg-cyan-500\/10 text-cyan-400'\]/);
  const s = section(html);
  assert.match(s, /Setup/);
  assert.match(s, /edge\.oys\.test/);
  assert.match(s, /7 used · 100 included · hard cap 200/);
  assert.match(s, /name="domain_action" value="test"/);
  assert.match(s, /name="domain_action" value="settings"/);
  assert.match(s, /links\.example\.com/);
  assert.match(s, /mia-m1/);
  assert.ok(s.includes('Mia &lt;b&gt;Müller&lt;/b&gt;') && !s.includes('<b>Müller</b>'), 'owner name as text');
  assert.ok(s.includes('hand&lt;made&gt;.example.org'), 'unmanaged hostnames as text');
  for (const a of ['check', 'disable', 'remove']) assert.match(s, new RegExp(`name="domain_action" value="${a}"`), a);
  // Jedes Formular mit Bestätigung des Servers
  for (const form of s.match(/<form[\s\S]*?<\/form>/g) ?? []) {
    if (/name="domain_action"/.test(form) && !/value="(?:test|control)"/.test(form)) assert.ok(form.includes('name="_confirmed"'), form.slice(0, 120));
  }
});

test('settings: saved with their limits; test and control go to the worker as requests', async () => {
  let ctx = await post({ domain_action: 'settings', per_user: '99', max_total: '-5', grace_days: '45', pending_days: '0', min_account_days: '400', mails_per_minute: '5', allow_paid: '1' });
  assert.equal(ctx.status, 302);
  assert.equal(ctx.header('Location'), '/admin#domains');
  const st = await domainSettings();
  assert.deepEqual({ ...st }, { enabled: false, per_user: 10, max_total: 0, allow_paid: true, grace_days: 45, pending_days: 1, min_account_days: 365, slots: false, mails_per_minute: 5 });
  assert.equal(await flash(), 'Custom domain settings saved.');
  ctx = await post({ domain_action: 'settings', enabled: '1', per_user: '3', max_total: '100', grace_days: '30', pending_days: '7', min_account_days: '30', mails_per_minute: '20' });
  assert.equal((await domainSettings()).enabled, true);
  await post({ domain_action: 'test' });
  await post({ domain_action: 'control' });
  const req = JSON.parse(String((await sql("SELECT meta_value FROM `DB`.oys_meta WHERE meta_key = 'custom_domains_req'"))[0].meta_value)) as Record<string, string>;
  assert.ok(req.test && req.control, 'both requests are waiting for the worker');
});

test('check, disable with a reason the owner sees, enable, remove – each with one notice for the owner', async () => {
  const id = Number((await sql("SELECT id FROM `DB`.custom_domains WHERE hostname = 'links.example.com'"))[0].id);
  // Prüfen: sofort fällig
  await post({ domain_action: 'check', domain_id: String(id) });
  let row = (await domainById(id))!;
  assert.ok(row.manual_at && row.next_check_at);
  assert.equal(await flash(), 'links.example.com: check started.');
  // Sperren: Zustand blocked, der Grund für den Besitzer, die Hauptadresse ist weg, der Dienst löscht den Hostnamen
  await sql("UPDATE `DB`.pages SET custom_domain = 'links.example.com' WHERE id = ?", [pages.m1]);
  await post({ domain_action: 'disable', domain_id: String(id), reason: 'Phishing <script>' });
  row = (await domainById(id))!;
  assert.equal(row.state, 'blocked');
  assert.equal(row.blocked_reason, 'Phishing <script>');
  assert.equal((await sql('SELECT custom_domain FROM `DB`.pages WHERE id = ?', [pages.m1]))[0].custom_domain, null);
  const notes = await sql('SELECT type, title, body FROM `DB`.notifications WHERE user_id = ?', [MIA]);
  assert.deepEqual(notes.map((x) => ({ ...x })), [{ type: 'domain_removed', title: 'Your custom domain was disconnected', body: 'The team disabled links.example.com: Phishing <script>' }]);
  assert.equal(await flash(), 'links.example.com is disabled.');
  // Die Liste nennt den Grund als Text, „Enable“ statt „Disable“
  const s = section(await adminHtml());
  assert.ok(s.includes('Phishing &lt;script&gt;'));
  assert.match(s, /name="domain_action" value="enable"/);
  // Wieder einschalten: Prüfung von vorn
  await post({ domain_action: 'enable', domain_id: String(id) });
  row = (await domainById(id))!;
  assert.equal(row.state, 'verifying');
  assert.equal(row.blocked_reason, null);
  assert.equal(await flash(), 'links.example.com is being reconnected.');
  // Entfernen: weg (ohne Hostnamen bei Cloudflare sofort), der Besitzer erfährt es
  await sql('DELETE FROM `DB`.notifications');
  await post({ domain_action: 'remove', domain_id: String(id) });
  assert.equal(await domainById(id), null);
  assert.deepEqual((await sql('SELECT type, body FROM `DB`.notifications WHERE user_id = ?', [MIA])).map((x) => ({ ...x })),
    [{ type: 'domain_removed', body: 'links.example.com was disconnected.' }]);
  assert.equal(await flash(), 'links.example.com was removed.');
  // Unbekannte Domain: nur eine Meldung
  await post({ domain_action: 'check', domain_id: '999999' });
  assert.equal(await flash(), 'This domain no longer exists.');
});

test('blocked hostnames: listed with their reason and released by an admin (R2); then anyone may connect them again', async () => {
  await sql("INSERT INTO `DB`.custom_domain_blocks (hostname, reason, created_at) VALUES ('bad.example.net', 'Spam <i>', NOW())");
  const s = section(await adminHtml());
  assert.ok(s.includes('bad.example.net') && s.includes('Spam &lt;i&gt;'));
  assert.match(s, /name="domain_action" value="release"/);
  await post({ domain_action: 'release', hostname: 'bad.example.net' });
  assert.equal(await n("SELECT COUNT(*) FROM `DB`.custom_domain_blocks WHERE hostname = 'bad.example.net'"), 0);
  assert.equal(await flash(), 'bad.example.net can be connected again.');
  await post({ domain_action: 'release', hostname: 'bad.example.net' });
  assert.equal(await flash(), 'bad.example.net isn’t blocked.');
});

test('only an admin in their own session, with CSRF and the confirmation, changes anything', async () => {
  const before = JSON.stringify(await domainSettings());
  const form = { domain_action: 'settings', enabled: '0', per_user: '1', max_total: '1', grace_days: '1', pending_days: '1', min_account_days: '1', mails_per_minute: '1' };
  // Nutzer, Admin im Nutzer-Modus, ohne CSRF, ohne Bestätigung
  for (const [label, ctx] of [
    ['user', await post(form, await loginSession(MIA))],
    ['admin working as another admin (R1)', await post(form, await loginSession(ADMIN_B, { impersonatedBy: ADMIN }))],
    ['no csrf', await runRequest(makeTestCtx({ method: 'POST', url: '/admin', cookies: { PHPSESSID: sid }, post: { ...form, _confirmed: '1' } }), appRoutes)],
    ['unconfirmed', await runRequest(makeTestCtx({ method: 'POST', url: '/admin', cookies: { PHPSESSID: sid }, post: { csrf: CSRF, ...form, _confirmed: '0' } }), appRoutes)],
  ] as const) {
    assert.equal(ctx.status, 302, label);
    assert.equal(JSON.stringify(await domainSettings()), before, label);
  }
});

test('every changing action needs the confirmation and the own admin session', async () => {
  const id = await createDomain({ hostname: 'guard.example.com', targetId: pages.m2, userId: MIA });
  await sql("INSERT INTO `DB`.custom_domain_blocks (hostname, reason, created_at) VALUES ('guard-block.example.com', '', NOW())");
  try {
    const forms: Array<Record<string, string>> = [
      { domain_action: 'disable', domain_id: String(id), reason: 'x' }, { domain_action: 'remove', domain_id: String(id) },
      { domain_action: 'release', hostname: 'guard-block.example.com' }, { domain_action: 'check', domain_id: String(id) },
    ];
    const state = async () => JSON.stringify([await domainById(id), await n("SELECT COUNT(*) FROM `DB`.custom_domain_blocks WHERE hostname = 'guard-block.example.com'")]);
    const before = await state();
    for (const form of forms) {
      for (const session of [await loginSession(ADMIN_B, { impersonatedBy: ADMIN }), await loginSession(MIA)]) await post(form, session);
      await runRequest(makeTestCtx({ method: 'POST', url: '/admin', cookies: { PHPSESSID: sid }, post: { csrf: CSRF, ...form, _confirmed: '0' } }), appRoutes);
      assert.equal(await state(), before, JSON.stringify(form));
    }
  } finally {
    await sql("DELETE FROM `DB`.custom_domains WHERE hostname = 'guard.example.com'");
    await sql("DELETE FROM `DB`.custom_domain_blocks WHERE hostname = 'guard-block.example.com'");
  }
});

test('R2 through the admin: disable, then remove – the hostname stays blocked, the owner is told once; a long reason fits the mail', async () => {
  for (const cf of [null, 'cf-123']) {
    // Lange Namen: mit dem Grund (200 Zeichen) wäre der Text länger als ein Eintrag im Verlauf
    const host = (cf ? 'cf-' : '') + 'a-rather-long-subdomain-for-the-mail-test.r2.example.com';
    const id = await createDomain({ hostname: host, targetId: pages.m3, userId: MIA });
    if (cf) await sql('UPDATE `DB`.custom_domains SET cf_id = ? WHERE id = ?', [cf, id]);
    await sql('DELETE FROM `DB`.notifications');
    const reason = 'R'.repeat(200);
    await post({ domain_action: 'disable', domain_id: String(id), reason });
    await post({ domain_action: 'remove', domain_id: String(id) });
    assert.equal(await n('SELECT COUNT(*) FROM `DB`.notifications WHERE user_id = ?', [MIA]), 1, 'one notice');
    const mails = await sql("SELECT detail FROM `DB`.custom_domain_log WHERE hostname = ? AND mail = 1", [host]);
    assert.equal(mails.length, 1, 'one mail');
    assert.ok(String(mails[0].detail).length <= 255 && String(mails[0].detail).endsWith('…'), 'the mail text ends cleanly');
    assert.equal(await n('SELECT COUNT(*) FROM `DB`.custom_domain_blocks WHERE hostname = ?', [host]), 1, 'still blocked: ' + host);
    if (cf) assert.equal((await domainById(id))?.state, 'removing', 'the worker deletes the hostname at Cloudflare');
    else assert.equal(await domainById(id), null);
    await sql('DELETE FROM `DB`.custom_domains WHERE hostname = ?', [host]);
    await post({ domain_action: 'release', hostname: host });
  }
});

test('international names: the list shows the ASCII form of look-alike names, the search finds it, release takes either form', async () => {
  const id = await createDomain({ hostname: 'xn--pple-43d.com', targetId: pages.m2, userId: MIA });
  try {
    const s = section(await adminHtml());
    assert.ok(s.includes('аpple.com') && s.includes('xn--pple-43d.com'), 'both forms are shown');
    assert.match(s, /data-search="[^"]*xn--pple-43d\.com/);
    // Suche auf dem Server
    const found = String((await runRequest(makeTestCtx({ url: '/admin?domain_q=xn--pple', cookies: { PHPSESSID: sid } }), appRoutes)).body);
    assert.ok(section(found).includes('xn--pple-43d.com'));
    const none = String((await runRequest(makeTestCtx({ url: '/admin?domain_q=nothing-like-this', cookies: { PHPSESSID: sid } }), appRoutes)).body);
    assert.ok(!section(none).includes('xn--pple-43d.com'));
  } finally {
    await sql('DELETE FROM `DB`.custom_domains WHERE id = ?', [id]);
  }
  await sql("INSERT INTO `DB`.custom_domain_blocks (hostname, reason, created_at) VALUES ('xn--mnchen-3ya.de', '', NOW())");
  await post({ domain_action: 'release', hostname: 'münchen.de' });
  assert.equal(await n("SELECT COUNT(*) FROM `DB`.custom_domain_blocks WHERE hostname = 'xn--mnchen-3ya.de'"), 0);
});
