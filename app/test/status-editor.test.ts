// Statusseiten im Editor (ST-3, nur OnYourSites eigene Seite): wer darf (401 ohne Anmeldung, 419 ohne CSRF, 403 für
// Nutzer, im Admin-Modus und für den Bereich der Nutzer), Bestandteile (Prüfung der Adresse gegen SSRF, Heartbeat-Link,
// Reihenfolge, Pause), Vorfälle und Wartungen (anlegen, Update, Eintrag ändern und löschen, löschen; rev steigt), die
// Grenze für Updates je Stunde, Alarme der Admins und die Kanäle des Bots (nur Kanäle aus seinem Bericht, kein Forum,
// zwei verschiedene) – und Beiträge in Discord nur, wenn der Bot status.v1 meldet. Dazu die Karte im Admin, die in den
// Editor führt.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { makeTestCtx, type Ctx } from '../src/web/ctx.js';
import { appRoutes } from '../src/app/dispatch.js';
import { ensureSchema } from '../src/schema.js';
import { adminStatusView } from '../src/status/adminView.js';
import { CSRF, jsonBody, loginSession, runRequest, testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
const OLD = '2026-01-01 10:00:00';
const ADMIN = 3;
const ADMIN2 = 4;
const USER = 5;
const CH = (n: number): string => String(1300000000000000000n + BigInt(n));

async function sql(query: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [r] = await t.admin.query<RowDataPacket[]>(query.replace(/`DB`/g, '`' + t.name + '`'), params);
  return r;
}

// Editor-API wie über den Server
async function api(action: string, o: { userId?: number; impersonatedBy?: number; json?: Record<string, unknown>; method?: string; csrf?: string | null; query?: string } = {}): Promise<Ctx> {
  const sid = o.userId === undefined ? null : await loginSession(o.userId, { impersonatedBy: o.impersonatedBy });
  const method = o.method ?? 'POST';
  const headers: Record<string, string> = {};
  if (method === 'POST') headers['content-type'] = 'application/json';
  if (o.csrf !== null) headers['x-csrf-token'] = o.csrf ?? CSRF;
  const url = '/dashboard/api/' + action + (o.query ?? (method === 'GET' ? '?scope=system' : ''));
  const ctx = makeTestCtx({ method, url, headers, cookies: sid ? { PHPSESSID: sid } : undefined,
    rawBody: method === 'POST' ? Buffer.from(JSON.stringify({ scope: 'system', ...(o.json ?? {}) })) : undefined });
  return runRequest(ctx, appRoutes);
}
const get = (action: string, query = '?scope=system') => api(action, { userId: ADMIN, method: 'GET', query });
const post = (action: string, json: Record<string, unknown>) => api(action, { userId: ADMIN, json });
const body = (ctx: Ctx): Record<string, any> => jsonBody(ctx) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let pageId = 0;
const rev = async (): Promise<number> => Number((await sql('SELECT rev FROM `DB`.status_pages WHERE id = ?', [pageId]))[0].rev);

function botReport(features: string[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    reported_at: Math.floor(Date.now() / 1000), version: '0.3.0', runtime: 'service', features,
    guild: { id: CH(1), name: 'OnYourSite', community: true }, updates_channel_id: '',
    status_channel_id: CH(20), alerts_channel_id: CH(21), categories: [],
    channels: [
      { id: CH(20), name: 'status', type: 'announcement', parent_id: '', can_post: true, can_mention_everyone: false, missing: [] },
      { id: CH(21), name: 'alerts', type: 'text', parent_id: '', can_post: true, can_mention_everyone: false, missing: [] },
      { id: CH(22), name: 'locked', type: 'text', parent_id: '', can_post: false, can_mention_everyone: false, missing: ['SendMessages'] },
      { id: CH(23), name: 'ideas', type: 'forum', parent_id: '', can_post: true, can_mention_everyone: false, missing: [] },
    ],
    threads: [], roles: [], truncated: false, ...extra,
  });
}
const setReport = (json: string | null) => (json === null
  ? sql("DELETE FROM `DB`.oys_meta WHERE meta_key = 'discord_bot_report'")
  : sql("REPLACE INTO `DB`.oys_meta (meta_key, meta_value) VALUES ('discord_bot_report', ?)", [json]));

before(async () => {
  t = await testDatabase('st3editor', { empty: true });
  await ensureSchema();
  const user = 'INSERT INTO `DB`.users (id, email, password, full_name, is_admin, created_at) VALUES (?, ?, \'x\', ?, ?, ?)';
  await sql(user, [ADMIN, 'admin@test.de', 'Pixel Admin', 1, OLD]);
  await sql(user, [ADMIN2, 'admin2@test.de', 'Second Admin', 1, OLD]);
  await sql(user, [USER, 'mia@test.de', 'Mia', 0, OLD]);
  pageId = Number((await sql('SELECT id FROM `DB`.status_pages WHERE is_system = 1'))[0].id);
});

after(async () => {
  await t.done();
});

test('who may: 401 without login, 419 without CSRF, 403 for users, in admin mode and for the user scope', async () => {
  let ctx = await api('status', { method: 'GET' });
  assert.equal(ctx.status, 401);
  ctx = await api('status-page', { userId: ADMIN, csrf: null, json: { title: 'Hacked' } });
  assert.equal(ctx.status, 419);
  ctx = await api('status-page', { userId: ADMIN, csrf: 'd'.repeat(64), json: { title: 'Hacked' } });
  assert.equal(ctx.status, 419);
  for (const o of [{ userId: USER }, { userId: USER, impersonatedBy: ADMIN }, { userId: ADMIN2, impersonatedBy: ADMIN }]) {
    ctx = await api('status-page', { ...o, json: { title: 'Hacked' } });
    assert.equal(ctx.status, 403, JSON.stringify(o));
    assert.deepEqual(body(ctx), { ok: false, error: 'Not allowed.' });
    ctx = await api('status', { ...o, method: 'GET' });
    assert.equal(ctx.status, 403);
  }
  // Der Bereich der Nutzer kommt mit der Freischaltung (ST-4)
  ctx = await api('status', { userId: USER, method: 'GET', query: '' });
  assert.equal(ctx.status, 403);
  assert.deepEqual(body(ctx), { ok: false, error: 'Unlock status pages with honeycombs first.' });
  ctx = await api('status-monitors', { userId: ADMIN, method: 'GET', query: '' });
  assert.equal(ctx.status, 403, 'an admin without scope=system is a user too');
  assert.equal((await sql('SELECT title FROM `DB`.status_pages WHERE id = ?', [pageId]))[0].title, 'OnYourSite status');
  // Unbekannte Aktion, falsche Methode
  ctx = await get('status-nope');
  assert.equal(ctx.status, 404);
  ctx = await get('status-page');
  assert.equal(ctx.status, 404, 'a write action needs POST');
});

test('the state: the page, KPIs, limits and the services; settings are clamped and saved', async () => {
  let ctx = await get('status');
  assert.equal(ctx.status, 200);
  const st = body(ctx);
  assert.equal(st.ok, true);
  assert.equal(st.scope, 'system');
  assert.equal(st.page.slug, 'status');
  assert.equal(st.page.online, true);
  assert.match(st.page.url, /^http:\/\/status\.oys\.test:8080\/$/);
  assert.equal(st.page.clash, false);
  assert.ok(Array.isArray(st.limits.intervals));
  assert.equal(st.notifier.ok, false, 'no notifier has reported');
  const before = await rev();
  ctx = await post('status-page', { title: '  OnYourSite <b>status</b>  ', history_days: 31 });
  assert.deepEqual(body(ctx), { ok: false, error: 'Past incidents can show 0 to 30 days.', field: 'history_days' });
  ctx = await post('status-page', { auto_incident: 60 });
  assert.equal(body(ctx).field, 'auto_incident');
  ctx = await post('status-page', { title: '', history_days: 7 });
  assert.equal(body(ctx).field, 'title');
  ctx = await post('status-page', { title: 'OnYourSite status', description: 'Live status.', history_days: 7, auto_incident: 900, show_uptime: false });
  assert.equal(body(ctx).ok, true);
  assert.equal(body(ctx).page.settings.history_days, 7);
  assert.equal(body(ctx).page.settings.auto_incident, 900);
  assert.equal(body(ctx).page.settings.show_uptime, false);
  assert.ok((await rev()) > before, 'rev goes up');
  await post('status-page', { show_uptime: true, auto_incident: 300, history_days: 14 });
});

test('components: SSRF targets are refused, a public address is saved; heartbeat links, order, pause and delete', async () => {
  for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/', 'http://[::1]/', 'ftp://example.com/', 'http://2130706433/']) {
    const ctx = await post('status-monitor-save', { type: 'http', name: 'Bad', url, interval: 300, timeout: 10 });
    assert.equal(body(ctx).ok, false, url);
    assert.equal(body(ctx).field, 'url', url);
  }
  assert.equal(Number((await sql("SELECT COUNT(*) AS n FROM `DB`.status_monitors WHERE name = 'Bad'"))[0].n), 0);
  let ctx = await post('status-monitor-save', { type: 'http', name: 'Example <img src=x onerror=alert(1)>', url: 'https://93.184.216.34/health', interval: 300, timeout: 10, public: false });
  assert.equal(body(ctx).ok, true, JSON.stringify(body(ctx)));
  const web = body(ctx).monitor;
  assert.equal(web.name, 'Example <img src=x onerror=alert(1)>', 'stored as text; escaped wherever it is shown');
  assert.equal(web.public, false);
  ctx = await post('status-monitor-save', { type: 'heartbeat', name: 'Nightly backup', period: 3600, grace: 300 });
  const hb = body(ctx).monitor;
  assert.match(hb.heartbeatUrl, /^http:\/\/oys\.test:8080\/_\/hb\/[A-Za-z0-9_-]{32}$/);
  ctx = await post('status-monitor-token', { id: hb.id });
  assert.notEqual(body(ctx).monitor.heartbeatUrl, hb.heartbeatUrl, 'a new link replaces the old one');
  ctx = await post('status-monitor-save', { type: 'manual', name: 'Email', status: 'degraded' });
  const manual = body(ctx).monitor;
  assert.equal(manual.manualStatus, 'degraded');
  ctx = await post('status-monitor-pause', { id: manual.id, paused: true });
  assert.equal(body(ctx).ok, false, 'a manual component isn’t checked');
  ctx = await post('status-monitor-pause', { id: web.id, paused: true });
  assert.equal(body(ctx).monitor.paused, true);
  // Reihenfolge: nur die eigenen IDs, jede einmal
  const ids = (await sql('SELECT id FROM `DB`.status_monitors WHERE page_id = ? ORDER BY position', [pageId])).map((r) => Number(r.id));
  ctx = await post('status-monitor-order', { ids: [...ids].reverse() });
  assert.equal(body(ctx).ok, true);
  ctx = await post('status-monitor-order', { ids: [...ids, 999999] });
  assert.equal(body(ctx).ok, false);
  // Eigene Bestandteile lassen sich nicht löschen, andere schon
  const sys = Number((await sql("SELECT id FROM `DB`.status_monitors WHERE page_id = ? AND type = 'system' LIMIT 1", [pageId]))[0].id);
  ctx = await post('status-monitor-delete', { id: sys });
  assert.equal(body(ctx).ok, false);
  ctx = await post('status-monitor-delete', { id: web.id });
  assert.equal(body(ctx).ok, true);
  ctx = await post('status-monitor-delete', { id: web.id });
  assert.equal(ctx.status, 404);
  // „Check now“ schreibt nur in die Warteschlange
  ctx = await post('status-monitor-run', { id: sys });
  assert.equal(body(ctx).ok, true);
  assert.equal(Number((await sql('SELECT COUNT(*) AS n FROM `DB`.status_run_requests WHERE monitor_id = ?', [sys]))[0].n), 1);
  ctx = await get('status-monitors');
  assert.ok(body(ctx).monitors.some((m: { id: number }) => m.id === hb.id));
});

test('incidents and maintenance: create, update, edit and delete an entry, delete; bad input is refused', async () => {
  const mons = (await sql("SELECT id, is_public FROM `DB`.status_monitors WHERE page_id = ? AND type = 'system' ORDER BY id", [pageId]));
  const pub = Number(mons.find((m) => Number(m.is_public) === 1)!.id);
  let ctx = await post('status-incident-save', { kind: 'incident', title: '', status: 'investigating', impact: 'minor', body: 'x', monitors: [] });
  assert.equal(body(ctx).ok, false);
  ctx = await post('status-incident-save', { kind: 'incident', title: 'Slow', status: 'investigating', impact: 'minor', body: 'x', monitors: [{ id: 999999, effect: 'partial' }] });
  assert.equal(body(ctx).ok, false, 'a component of another page');
  const before = await rev();
  ctx = await post('status-incident-save', {
    kind: 'incident', title: '<script>alert(1)</script> Slow', status: 'investigating', impact: 'major',
    body: 'We are **looking** into it. <img src=x onerror=alert(1)>', monitors: [{ id: pub, effect: 'partial' }],
  });
  assert.equal(body(ctx).ok, true, JSON.stringify(body(ctx)));
  const inc = body(ctx).incident;
  assert.equal(inc.title, '<script>alert(1)</script> Slow');
  assert.equal(inc.updates.length, 1);
  assert.deepEqual(inc.discord, [], 'no bot – no Discord post');
  assert.ok((await rev()) > before);
  ctx = await post('status-incident-update', { id: inc.id, status: 'identified', body: 'Found it.' });
  assert.equal(body(ctx).incident.updates.length, 2);
  assert.equal(body(ctx).incident.status, 'identified');
  ctx = await post('status-incident-update', { id: inc.id, status: 'nope', body: 'x' });
  assert.equal(body(ctx).field, 'status');
  const first = body(ctx).incident ?? null;
  assert.equal(first, null);
  const updates = (await sql('SELECT id FROM `DB`.status_incident_updates WHERE incident_id = ? ORDER BY id', [inc.id])).map((r) => Number(r.id));
  ctx = await post('status-incident-edit', { id: inc.id, update_id: updates[0], body: 'Edited text' });
  assert.equal(body(ctx).incident.updates[0].body, 'Edited text');
  assert.ok(body(ctx).incident.updates[0].editedAt > 0);
  ctx = await post('status-incident-edit', { id: inc.id, update_id: updates[1], delete: true });
  assert.equal(body(ctx).incident.updates.length, 1);
  assert.equal(body(ctx).incident.status, 'investigating', 'the status follows the latest update');
  ctx = await post('status-incident-edit', { id: inc.id, update_id: updates[0], delete: true });
  assert.equal(body(ctx).ok, false, 'the last update stays');
  ctx = await post('status-incident-update', { id: inc.id, status: 'resolved', body: 'Fixed.' });
  assert.ok(body(ctx).incident.resolvedAt > 0);
  // Wartung: Fenster in der Zukunft, nicht länger als 7 Tage
  const now = Math.floor(Date.now() / 1000);
  ctx = await post('status-incident-save', { kind: 'maintenance', title: 'Upgrade', starts_at: now + 3600, ends_at: now + 3600 + 8 * 86400, body: 'x', monitors: [{ id: pub }] });
  assert.equal(body(ctx).ok, false);
  ctx = await post('status-incident-save', { kind: 'maintenance', title: 'Database upgrade', starts_at: now + 3600, ends_at: now + 7200, body: 'Short downtime.', monitors: [{ id: pub }] });
  assert.equal(body(ctx).ok, true, JSON.stringify(body(ctx)));
  const maint = body(ctx).incident;
  assert.equal(maint.status, 'scheduled');
  assert.equal(maint.kind, 'maintenance');
  ctx = await get('status-incidents');
  assert.ok(body(ctx).upcoming.some((i: { id: number }) => i.id === maint.id));
  assert.ok(body(ctx).past.some((i: { id: number }) => i.id === inc.id));
  ctx = await post('status-incident-delete', { id: maint.id });
  assert.equal(body(ctx).ok, true);
  ctx = await post('status-incident-delete', { id: maint.id });
  assert.equal(ctx.status, 404);
  assert.equal(Number((await sql('SELECT COUNT(*) AS n FROM `DB`.status_incident_updates WHERE incident_id = ?', [maint.id]))[0].n), 0);
});

test('updates per hour are limited (rate limit per page)', async () => {
  await sql("REPLACE INTO `DB`.oys_meta (meta_key, meta_value) VALUES ('status', '{\"updates_per_hour\": 2}')");
  await sql("DELETE FROM `DB`.rate_limits WHERE rl_key LIKE 'statusinc:%'");
  try {
    const answers: boolean[] = [];
    for (let i = 0; i < 4; i++) answers.push(body(await post('status-incident-save', { kind: 'incident', title: 'Spam ' + i, status: 'investigating', impact: 'none', body: 'x', monitors: [] })).ok === true);
    assert.deepEqual(answers, [true, true, false, false]);
    const last = body(await post('status-incident-save', { kind: 'incident', title: 'Spam 9', status: 'investigating', impact: 'none', body: 'x', monitors: [] }));
    assert.equal(last.error, 'That’s a lot of updates – please wait a bit before posting again.');
  } finally {
    await sql("DELETE FROM `DB`.oys_meta WHERE meta_key = 'status'");
    await sql("DELETE FROM `DB`.rate_limits WHERE rl_key LIKE 'statusinc:%'");
  }
});

test('alerts: admins on or off and the events; bot channels only from the bot’s report – never a forum, two different ones', async () => {
  let ctx = await post('status-alerts-owner', { admins: false, events: ['down', 'up'] });
  assert.equal(body(ctx).admins.enabled, false);
  assert.deepEqual(body(ctx).admins.events, ['down', 'up']);
  ctx = await post('status-alerts-owner', { events: ['down', 'nope'] });
  assert.equal(body(ctx).field, 'events');
  await post('status-alerts-owner', { admins: true, events: ['down', 'up', 'degraded', 'cert', 'heartbeat'] });

  await setReport(null);
  ctx = await post('status-bot-channels', { status_channel_id: CH(20), alerts_channel_id: CH(21) });
  assert.equal(body(ctx).error, 'That channel isn’t in the bot’s latest report – refresh the list.');
  await setReport(botReport(['updates.v1', 'status.v1']));
  ctx = await get('status-alerts');
  assert.equal(body(ctx).bot.supported, true);
  assert.equal(body(ctx).bot.statusChannel, CH(20), 'the bot’s suggestion while nothing is saved');
  assert.equal(body(ctx).bot.alertsChannel, CH(21));
  assert.deepEqual(body(ctx).bot.choices.map((c: { id: string }) => c.id), [CH(20), CH(21), CH(22)], 'no forum in the list');
  for (const [s, a] of [[CH(22), CH(21)], [CH(23), CH(21)], [CH(20), CH(99)], ['<script>', CH(21)]]) {
    ctx = await post('status-bot-channels', { status_channel_id: s, alerts_channel_id: a });
    assert.equal(body(ctx).ok, false, `${s} ${a}`);
  }
  ctx = await post('status-bot-channels', { status_channel_id: CH(20), alerts_channel_id: CH(20) });
  assert.equal(body(ctx).error, 'Public incident posts and team alerts need two different channels.');
  ctx = await post('status-bot-channels', { status_channel_id: CH(20), alerts_channel_id: '' });
  assert.equal(body(ctx).ok, true);
  assert.equal(body(ctx).bot.alertsChannel, '', 'saved as off – the suggestion no longer counts');
  assert.equal(body(ctx).bot.saved, true);
  await post('status-bot-channels', { status_channel_id: CH(20), alerts_channel_id: CH(21) });
});

test('Discord: a new incident gets a post job only when the bot reports status.v1; later changes edit it', async () => {
  // Ohne status.v1: keine Zeile, kein Auftrag
  await setReport(botReport(['updates.v1']));
  let ctx = await post('status-incident-save', { kind: 'incident', title: 'Old bot', status: 'investigating', impact: 'minor', body: 'x', monitors: [] });
  const oldBot = body(ctx).incident.id;
  assert.equal(Number((await sql('SELECT COUNT(*) AS n FROM `DB`.status_incident_posts WHERE incident_id = ?', [oldBot]))[0].n), 0);
  assert.equal(Number((await sql("SELECT COUNT(*) AS n FROM `DB`.community_outbox WHERE ref = ?", ['status-inc:' + oldBot]))[0].n), 0);
  // Mit status.v1: ein Beitrag in #status (wartet auf den Bot)
  await setReport(botReport(['updates.v1', 'status.v1']));
  ctx = await post('status-incident-save', { kind: 'incident', title: 'New bot', status: 'investigating', impact: 'minor', body: 'x', monitors: [] });
  const inc = body(ctx).incident;
  assert.deepEqual(inc.discord, [{ state: 'queued', error: '' }]);
  const jobs = await sql("SELECT action, payload FROM `DB`.community_outbox WHERE ref = ? ORDER BY id", ['status-inc:' + inc.id]);
  assert.deepEqual(jobs.map((j) => j.action), ['status.post']);
  assert.equal(JSON.parse(String(jobs[0].payload)).channel_id, CH(20));
  // Ohne Häkchen kein Beitrag
  ctx = await post('status-incident-save', { kind: 'incident', title: 'Quiet', status: 'investigating', impact: 'minor', body: 'x', monitors: [], discord: false });
  assert.deepEqual(body(ctx).incident.discord, []);
  // Solange der Beitrag aussteht, wird eine Änderung vorgemerkt (dirty) statt eines zweiten Auftrags
  ctx = await post('status-incident-update', { id: inc.id, status: 'identified', body: 'Found it.' });
  assert.equal(Number((await sql('SELECT dirty FROM `DB`.status_incident_posts WHERE incident_id = ?', [inc.id]))[0].dirty), 1);
  assert.equal(Number((await sql("SELECT COUNT(*) AS n FROM `DB`.community_outbox WHERE ref = ?", ['status-inc:' + inc.id]))[0].n), 1);
  // Löschen, bevor der Bot ihn abholt: der Auftrag entfällt, die Zeile auch
  ctx = await post('status-incident-delete', { id: inc.id });
  assert.equal(body(ctx).ok, true);
  assert.equal(Number((await sql('SELECT COUNT(*) AS n FROM `DB`.status_incident_posts WHERE incident_id = ?', [inc.id]))[0].n), 0);
  const job = (await sql("SELECT done_at, last_error FROM `DB`.community_outbox WHERE ref = ?", ['status-inc:' + inc.id]))[0];
  assert.notEqual(job.done_at, null);
  await setReport(null);
});

test('admin: the card links the editor (/dashboard#status/system) and the page; the notifier line', async () => {
  const html = await adminStatusView(makeTestCtx({ url: '/admin' }));
  const card = html.slice(html.indexOf('id="statusSystemPage"'), html.indexOf('Health'));
  assert.match(card, /OnYourSite status page <span class="[^"]+">Online<\/span>/);
  assert.match(card, /href="\/dashboard#status\/system"[^>]*><i class='bx bx-edit-alt'><\/i> Open in the editor<\/a>/);
  assert.match(card, /href="http:\/\/status\.oys\.test:8080\/" target="_blank" rel="noopener"/);
  assert.match(html, /Notifier[\s\S]*?It hasn’t reported yet – see journalctl -u onyoursite-status-notify/);
  await sql("REPLACE INTO `DB`.oys_meta (meta_key, meta_value) VALUES ('status_notify', ?)", [JSON.stringify({ at: Math.floor(Date.now() / 1000), started: 1800000000, outbox: 4, mail_today: { system: 3, confirm: 0, owner: 1, broadcast: 0 } })]);
  const later = await adminStatusView(makeTestCtx({ url: '/admin' }));
  assert.match(later, /Notifier[\s\S]*?Running/);
  assert.match(later, /Emails today[\s\S]*?system 3 · confirm 0 · owner 1 · broadcast 0/);
  assert.match(later, /Waiting messages[\s\S]*?>4</);
});
