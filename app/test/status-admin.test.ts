// Admin, Bereich „Status pages“: Eintrag in der Navigation (nach Code pages, vor Storage; Farbe lime), der Bereich an
// seiner Stelle, die Karte „Health“ ohne Dienste und mit ihren Einträgen (läuft, angehalten, Sperre, Schutz im Kernel,
// alte Messung) und die eigenen Bestandteile – Texte immer maskiert.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { setConfigForTests, type ConfigData } from '../src/config.js';
import { makeTestCtx } from '../src/web/ctx.js';
import { appRoutes } from '../src/app/dispatch.js';
import { ensureSchema, V_STATUS_TABLES } from '../src/schema.js';
import { adminStatusView, ago } from '../src/status/adminView.js';
import { BASE, loginSession, runRequest, testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;

async function q(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  await t.admin.query(`USE \`${t.name}\``);
  return (await t.admin.query<RowDataPacket[]>(sql, params))[0];
}

before(async () => {
  t = await testDatabase('st2admin');
  await ensureSchema();
});

after(async () => {
  await t.done();
});

async function adminPage(): Promise<string> {
  const sid = await loginSession(3);
  const ctx = await runRequest(makeTestCtx({ url: '/admin', cookies: { PHPSESSID: sid } }), appRoutes);
  assert.equal(ctx.status, 200);
  return String(ctx.body);
}

const section = (page: string): string => {
  const start = page.indexOf('<div id="tab-status"');
  return page.slice(start, page.indexOf('<div id="tab-', start + 1));
};

test('navigation, tab colour and the place of the section', async () => {
  const page = await adminPage();
  assert.match(page, /onclick="switchAdminTab\('status'\)" id="nav-status"[^>]*>\n {20}<i class='bx bx-pulse text-xl'><\/i> <span class="hidden lg:block text-sm">Status pages<\/span>/);
  // Reihenfolge nach ROADMAP §3.11: … Code pages, Custom domains (PD-5), Status pages, Storage
  const nav = ['nav-community', 'nav-honeycombs', 'nav-code-pages', 'nav-domains', 'nav-status', 'nav-storage'].map((id) => page.indexOf(`id="${id}"`));
  assert.deepEqual([...nav].sort((a, b) => a - b), nav);
  assert.match(page, /'code-pages': \['Code pages', [^\]]+\],\n {12}domains: \['Custom domains', [^\]]+\],\n {12}status: \['Status pages', 'border-lime-500\/30 bg-lime-500\/10 text-lime-400'\],\n {12}storage:/);
  const order = ['tab-code-pages', 'tab-domains', 'tab-status', 'tab-storage'].map((id) => page.indexOf(`<div id="${id}"`));
  assert.ok(order.every((i) => i > 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(page.includes('<meta name="robots" content="noindex, nofollow">'));
});

test('the health card before any service has run', async () => {
  const s = section(await adminPage());
  assert.ok(s.includes('class="admin-tab-content max-w-5xl mx-auto space-y-8 hidden"'));
  assert.match(s, /Checker<\/p>\n\s+<p class="mt-2 flex items-center gap-2 flex-wrap"><span class="[^"]+">Not running<\/span> <span class="text-sm text-gray-300">It hasn’t reported yet – see journalctl -u onyoursite-status<\/span>/);
  assert.match(s, /Notifier[\s\S]*?It hasn’t reported yet – see journalctl -u onyoursite-status-notify/);
  assert.match(s, /Local probe[\s\S]*?No measurement yet/);
  assert.match(s, /Kernel guard<\/dt>[\s\S]*?Not checked yet/);
  assert.match(s, /Platform gate<\/dt>[\s\S]*?OK<\/span> <span class="text-sm text-gray-300">canaries not checked yet/);
  assert.match(s, /Emails today<\/dt>[\s\S]*?No emails yet/);
  assert.match(s, /OnYourSite components <span class="text-gray-500 text-sm font-normal">13<\/span>/);
  assert.equal((s.match(/No data yet/g) ?? []).length, 13);
  assert.equal((s.match(/>Private</g) ?? []).length, 6);
});

test('the health card with running and stopped services, a closed gate, the kernel warning and a component that is down', async () => {
  const now = Math.floor(Date.now() / 1000);
  const meta = (k: string, v: unknown) => q('REPLACE INTO oys_meta (meta_key, meta_value) VALUES (?, ?)', [k, JSON.stringify(v)]);
  await meta('status_worker', { at: now - 20, pid: 1, started: now - 3600, version: '1', monitors: { active: 7, paused: 2 }, checks_min: 12, inflight: 0, delayed_10m: 1, lag_p95_ms: 400 });
  await meta('status_notify', { at: now - 900, mail_today: { system: 4, confirm: 1, owner: 2, broadcast: 0 } });
  await meta('status_probe', { at: now - 400 });
  await meta('status_gate', { state: 'frozen', since: now - 300, reason: 'canaries', canaries: { ok: 0, of: 3 } });
  const web = Number((await q("SELECT id FROM status_monitors WHERE target = 'web'"))[0].id);
  await q("INSERT INTO status_state (monitor_id, state, last_check_at, last_error, last_code, updated_at) VALUES (?, 'down', ?, 'status', 502, ?)", [web, now - 30, now]);
  await q("UPDATE status_monitors SET name = '<script>x</script> Web' WHERE id = ?", [web]);
  setConfigForTests({ ...BASE, db: { ...(BASE.db as ConfigData), name: t.name }, uploads_dir: t.uploads, status: { kernel_guard: false } });
  try {
    const s = await adminStatusView(makeTestCtx({ url: '/admin' }));
    assert.match(s, /Checker<\/p>\n\s+<p[^>]*><span class="[^"]*emerald[^"]*">Running<\/span> <span class="text-sm text-gray-300">since /);
    assert.match(s, /Notifier<\/p>\n\s+<p[^>]*><span class="[^"]*red[^"]*">Stopped<\/span> <span class="text-sm text-gray-300">last seen /);
    assert.match(s, /Local probe<\/p>\n\s+<p[^>]*><span class="[^"]*red[^"]*">Local probe isn’t running<\/span>/);
    assert.match(s, /Checks per minute<\/dt>\n\s+<dd[^>]*>12<\/dd>/);
    assert.match(s, /Schedule lag \(p95\)<\/dt>\n\s+<dd[^>]*>0\.4 s<\/dd>/);
    assert.match(s, /7 active · 2 paused/);
    assert.match(s, /Paused<\/span> <span class="text-sm text-gray-300">since [^<]+: canaries 0\/3/);
    assert.ok(s.includes('This server ignores IPAddressDeny – checks rely on the app guard only.'));
    assert.ok(s.includes('system 4 · confirm 1 · owner 2 · broadcast 0'));
    assert.ok(s.includes('&lt;script&gt;x&lt;/script&gt; Web') && !s.includes('<script>x'));
    assert.match(s, /&lt;script&gt;x&lt;\/script&gt; Web<\/span>\n\s+<span class="[^"]*red[^"]*">Down<\/span>/);
    // Unter Last vergeht zwischen dem Schreiben und der Ansicht auch einmal eine Sekunde mehr
    assert.match(s, /web · checked 3\d s ago · Answered with HTTP 502\./);
  } finally {
    setConfigForTests({ ...BASE, db: { ...(BASE.db as ConfigData), name: t.name }, uploads_dir: t.uploads });
  }
});

test('before the database update the section says so', async () => {
  await q("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('schema_version', ?)", [String(V_STATUS_TABLES - 1)]);
  try {
    const s = await adminStatusView(makeTestCtx({ url: '/admin' }));
    assert.ok(s.includes('The database update for status pages hasn’t run yet.'));
    assert.ok(s.trimEnd().endsWith('</div>'));
  } finally {
    await q("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('schema_version', ?)", [String(V_STATUS_TABLES)]);
  }
});

test('ago()', () => {
  assert.equal(ago(1000, 1040), '40 s ago');
  assert.equal(ago(1000, 1000 + 600), '10 min ago');
  assert.equal(ago(1000, 1000 + 7200), '2 h ago');
  assert.equal(ago(1000, 900), '0 s ago');
});
