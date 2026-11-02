// Statusseiten, Benachrichtigungen (ST-3) mit Datenbank: Zeilen in status_outbox (je Empfänger, ein „up“ fasst ein
// wartendes „down“ zusammen), der Benachrichtigungsdienst (E-Mail an alle Admins – Klasse system –, an den Besitzer –
// Klasse owner, mit Grenzen –, Glocke genau einmal, Wiederholungen 30 s/2 min/10 min, zu alte Zeilen, Auftrag für den
// Bot nur mit status.v1 und Kanal) und der Weg über den Bot (signierte Anfragen an /_/bot/* – ohne Unterschrift nichts;
// Ausgabe nur an einen Bot mit status.v1, der Inhalt beim Ausgeben, die Nachrichten-ID aus /done, Bearbeiten danach,
// Verfallen von status.alert).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { configString } from '../src/config.js';
import { exec, transaction, withConnection } from '../src/db.js';
import { date, time } from '../src/php.js';
import { buildServer } from '../src/server.js';
import { ensureSchema } from '../src/schema.js';
import { alertRows, writeAlertRows, type AlertSource } from '../src/status/alerts.js';
import { Notifier, RETRY_AFTER, STALE_AFTER, type MailRequest } from '../src/status/notifier.js';
import { statusPageSettings } from '../src/status/settings.js';
import { syncIncidentPosts } from '../src/status/posts.js';
import { createIncident, addIncidentUpdate, loadIncident } from '../src/status/incidents.js';
import { systemStatusPage } from '../src/status/model.js';
import { testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
let app: FastifyInstance;
const HOST = 'oys.test:8080';
const SECRET = configString('bot_secret');
const OLD = '2026-01-01 10:00:00';
const CH = (n: number): string => String(1300000000000000000n + BigInt(n));
let pageId = 0;
let monitorId = 0;
let userPage = 0;
let userMonitor = 0;

async function sql(query: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [r] = await t.admin.query<RowDataPacket[]>(query.replace(/`DB`/g, '`' + t.name + '`'), params);
  return r;
}

function botReport(features: string[]): string {
  return JSON.stringify({
    reported_at: time(), version: '0.3.0', runtime: 'service', features, guild: { id: CH(1), name: 'OnYourSite', community: true },
    updates_channel_id: '', status_channel_id: CH(20), alerts_channel_id: CH(21), categories: [],
    channels: [
      { id: CH(20), name: 'status', type: 'text', parent_id: '', can_post: true, can_mention_everyone: false, missing: [] },
      { id: CH(21), name: 'alerts', type: 'text', parent_id: '', can_post: true, can_mention_everyone: false, missing: [] },
    ],
    threads: [], roles: [], truncated: false,
  });
}
const setReport = (json: string | null) => (json === null
  ? sql("DELETE FROM `DB`.oys_meta WHERE meta_key = 'discord_bot_report'")
  : sql("REPLACE INTO `DB`.oys_meta (meta_key, meta_value) VALUES ('discord_bot_report', ?)", [json]));

// Signierte Anfrage wie der Bot (site.js)
async function bot(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const payload = body === undefined ? '' : JSON.stringify(body);
  const ts = String(time());
  const sig = createHmac('sha256', SECRET).update(`${ts}\n${method}\n${path}\n${method === 'GET' ? '' : payload}`).digest('hex');
  const headers: Record<string, string> = { host: HOST, 'x-oys-timestamp': ts, 'x-oys-signature': sig };
  if (payload !== '') headers['content-type'] = 'application/json';
  const res = await app.inject({ method, url: path, headers, payload: payload === '' ? undefined : payload });
  return { status: res.statusCode, json: res.body === '' ? {} : (JSON.parse(res.body) as Record<string, unknown>) };
}

// Ein Ereignis wie vom Prüfdienst
function source(over: Partial<AlertSource['event']> = {}, user = false): AlertSource {
  return {
    page: user ? { id: userPage, userId: 5, isSystem: false, slug: 'mia-status', title: 'Mia <status>' } : { id: pageId, userId: null, isSystem: true, slug: 'status', title: 'OnYourSite status' },
    monitor: { id: user ? userMonitor : monitorId, name: 'Website <b>', type: 'http', target: 'https://example.com/health', isPublic: true, timeout: 10, retries: 1 },
    event: { kind: 'down', at: time(), error: 'timeout', code: null, muted: false, since: time() - 60, ...over },
  };
}
// Mit den Einstellungen der Seite wie der Prüfdienst (OnYourSites Seite: alle Admins, alle Ereignisse – aus der Datenbank)
async function write(src: AlertSource): Promise<void> {
  const stored = src.page.isSystem ? String((await sql('SELECT settings FROM `DB`.status_pages WHERE id = ?', [pageId]))[0].settings) : '{"alerts":{"owner":true,"events":["down","up"]}}';
  const settings = statusPageSettings({ is_system: src.page.isSystem ? 1 : 0, settings: stored });
  await transaction(async (_conn, db) => {
    await writeAlertRows(db, alertRows(src, settings), time());
  });
}

interface Mail extends MailRequest { at: number }
function notifier(o: { fail?: boolean; clock?: () => number } = {}): { n: Notifier; mails: Mail[] } {
  const mails: Mail[] = [];
  const n = new Notifier({
    clock: o.clock,
    log: () => undefined,
    sendMail: async (m) => {
      if (o.fail) return false;
      mails.push({ ...m, at: Date.now() });
      return true;
    },
  });
  return { n, mails };
}

before(async () => {
  assert.ok(SECRET.length >= 32, 'the test settings need a bot_secret');
  t = await testDatabase('st3notify', { empty: true });
  await ensureSchema();
  const user = 'INSERT INTO `DB`.users (id, email, password, full_name, is_admin, created_at) VALUES (?, ?, \'x\', ?, ?, ?)';
  await sql(user, [3, 'admin@test.de', 'Pixel Admin', 1, OLD]);
  await sql(user, [4, 'admin2@test.de', 'Second Admin', 1, OLD]);
  await sql(user, [5, 'mia@test.de', 'Mia', 0, OLD]);
  pageId = Number((await sql('SELECT id FROM `DB`.status_pages WHERE is_system = 1'))[0].id);
  await sql(`INSERT INTO \`DB\`.status_monitors (page_id, user_id, type, name, is_public, target, config, interval_s, changed_at, created_at, updated_at)
    VALUES (?, NULL, 'http', 'Website', 1, 'https://example.com/health', '{}', 300, 0, NOW(), NOW())`, [pageId]);
  monitorId = Number((await sql("SELECT id FROM `DB`.status_monitors WHERE name = 'Website'"))[0].id);
  await sql("INSERT INTO `DB`.status_pages (user_id, is_system, slug, title, created_at, updated_at) VALUES (5, 0, 'mia-status', 'Mia', NOW(), NOW())");
  userPage = Number((await sql("SELECT id FROM `DB`.status_pages WHERE slug = 'mia-status'"))[0].id);
  await sql(`INSERT INTO \`DB\`.status_monitors (page_id, user_id, type, name, is_public, target, config, interval_s, changed_at, created_at, updated_at)
    VALUES (?, 5, 'http', 'Shop', 1, 'https://shop.example/', '{}', 300, 0, NOW(), NOW())`, [userPage]);
  userMonitor = Number((await sql("SELECT id FROM `DB`.status_monitors WHERE name = 'Shop'"))[0].id);
  app = await buildServer();
  await app.ready();
});

after(async () => {
  await app?.close();
  await t?.done();
});

beforeEach(async () => {
  for (const q of ['DELETE FROM `DB`.status_outbox', 'DELETE FROM `DB`.notifications', 'DELETE FROM `DB`.community_outbox', 'DELETE FROM `DB`.status_incident_posts',
    "DELETE FROM `DB`.oys_meta WHERE meta_key IN ('discord_bot_report', 'status_notify')"]) await sql(q);
});

test('rows per recipient: OnYourSite’s page → admins, bell and bot (class system); a user page → owner and bell (class owner)', async () => {
  await write(source());
  let rows = await sql('SELECT channel, class, event, state FROM `DB`.status_outbox ORDER BY id');
  assert.deepEqual(rows.map((r) => [r.channel, r.class, r.event, r.state]), [['admins', 'system', 'down', 'pending'], ['bell', 'system', 'down', 'pending'], ['bot', 'system', 'down', 'pending']]);
  await write(source({}, true));
  rows = await sql('SELECT channel, class FROM `DB`.status_outbox WHERE page_id = ? ORDER BY id', [userPage]);
  assert.deepEqual(rows.map((r) => [r.channel, r.class]), [['owner', 'owner'], ['bell', 'owner']]);
  // Stummgeschaltet (Wartung) oder nicht gewählt: keine Zeile
  await sql('DELETE FROM `DB`.status_outbox');
  await write(source({ muted: true }));
  await write(source({ kind: 'degraded' }, true));
  assert.equal((await sql('SELECT COUNT(*) AS n FROM `DB`.status_outbox'))[0].n, 0);
  // „up“, solange „down“ noch wartet: eine Nachricht „was down for …“
  await write(source());
  await write(source({ kind: 'up', downFor: 40 }));
  rows = await sql("SELECT channel, event, state, payload FROM `DB`.status_outbox WHERE channel = 'admins' ORDER BY id");
  assert.deepEqual(rows.map((r) => [r.event, r.state]), [['down', 'merged'], ['up', 'pending']]);
  assert.equal(JSON.parse(String(rows[1].payload)).merged, true);
});

test('admins get one email each (class system, escaped, the check address only for the team); the bell exactly once', async () => {
  await write(source());
  const { n, mails } = notifier();
  await n.start();
  await n.deliverDue();
  assert.deepEqual(mails.map((m) => [m.to, m.template, m.subject]).sort(), [
    ['admin2@test.de', 'status_alert', '[Down] Website <b> – OnYourSite status'],
    ['admin@test.de', 'status_alert', '[Down] Website <b> – OnYourSite status'],
  ]);
  assert.equal(mails[0].vars.title, 'Website &lt;b&gt; is down', 'vars are escaped for the HTML template');
  assert.match(mails[0].vars.text, /^No answer within 10 s \(2 checks in a row\)\. Since .+ Check: https:\/\/example\.com\/health$/);
  assert.equal(mails[0].vars.button_url, 'http://oys.test:8080/dashboard#status/system');
  assert.equal(n.budget.used.system, 2);
  const rows = await sql('SELECT channel, state, payload FROM `DB`.status_outbox ORDER BY id');
  assert.deepEqual(rows.map((r) => [r.channel, r.state]), [['admins', 'sent'], ['bell', 'sent'], ['bot', 'skipped']]);
  assert.deepEqual(JSON.parse(String(rows[0].payload)).sent_to.sort(), [3, 4]);
  const bell = await sql("SELECT user_id, type, title, link FROM `DB`.notifications ORDER BY user_id");
  assert.deepEqual(bell.map((b) => [Number(b.user_id), b.type, b.title, b.link]), [[3, 'status', 'Website <b> is down', '/dashboard#status/system'], [4, 'status', 'Website <b> is down', '/dashboard#status/system']]);
  // Noch einmal zustellen ändert nichts – keine zweite Glocke, keine zweite Mail
  await sql("UPDATE `DB`.status_outbox SET next_at = 0");
  await n.deliverDue();
  assert.equal(mails.length, 2);
  assert.equal((await sql('SELECT COUNT(*) AS n FROM `DB`.notifications'))[0].n, 2);
});

test('the mail server refuses: retries after 30 s, 2 min, 10 min, then failed; rows older than 30 minutes are skipped', async () => {
  await write(source());
  let now = Date.now();
  const { n } = notifier({ fail: true, clock: () => now });
  await n.start();
  const admins = async () => (await sql("SELECT attempts, next_at, state, error FROM `DB`.status_outbox WHERE channel = 'admins'"))[0];
  for (const wait of RETRY_AFTER) {
    await n.deliverDue();
    const r = await admins();
    assert.equal(r.state, 'pending');
    assert.equal(Number(r.next_at), Math.floor(now / 1000) + wait);
    assert.equal(r.error, 'The mail server didn’t take the email.');
    now += wait * 1000;
  }
  await n.deliverDue();
  assert.equal((await admins()).state, 'failed');
  assert.equal(n.smtpFail, 8, 'two admins, four tries');
  assert.equal(n.budget.used.system, 0, 'failed sends don’t count');
  // Zu alt (nach einem Neustart des Dienstes): nicht mehr senden
  await sql('DELETE FROM `DB`.status_outbox');
  await write(source());
  await sql('UPDATE `DB`.status_outbox SET created_at = created_at - ?', [STALE_AFTER + 5]);
  const fresh = notifier();
  await fresh.n.start();
  await fresh.n.deliverDue();
  assert.equal(fresh.mails.length, 0);
  assert.deepEqual((await sql('SELECT DISTINCT state FROM `DB`.status_outbox')).map((r) => r.state), ['skipped']);
});

test('the owner of a page: class owner with its own template, the bell for the owner, at most owner_mails_hour – then one note', async () => {
  await sql("REPLACE INTO `DB`.oys_meta (meta_key, meta_value) VALUES ('status', '{\"owner_mails_hour\": 2}')");
  try {
    await write(source({}, true));
    const { n, mails } = notifier();
    await n.start();
    await n.deliverDue();
    assert.deepEqual(mails.map((m) => [m.to, m.template]), [['mia@test.de', 'status_owner_alert']]);
    assert.equal(mails[0].vars.page, 'mia-status.oys.test:8080');
    assert.equal(n.budget.used.owner, 1);
    assert.equal(n.budget.used.system, 0);
    const bell = await sql('SELECT user_id, type, link FROM `DB`.notifications');
    assert.deepEqual(bell.map((b) => [Number(b.user_id), b.type, b.link]), [[5, 'status_down', '/dashboard#status']]);
    // Zwei weitere Alarme in der Stunde: der zweite überschreitet die Grenze – eine Nachricht „muted until tomorrow“
    await write(source({ kind: 'up', downFor: 30 }, true));
    await write(source({}, true));
    await n.deliverDue();
    await n.deliverDue();
    const owner = await sql("SELECT kind, state, error FROM `DB`.status_outbox WHERE channel = 'owner' ORDER BY id");
    assert.deepEqual(owner.map((r) => [r.kind, r.state]), [['alert', 'sent'], ['alert', 'sent'], ['alert', 'skipped'], ['muted', 'sent']]);
    assert.equal(owner[2].error, 'Muted: the email limit of this page is reached.');
    assert.equal(mails[mails.length - 1].subject, '[Status] Alerts are muted until tomorrow');
  } finally {
    await sql("DELETE FROM `DB`.oys_meta WHERE meta_key = 'status'");
  }
});

test('bot alerts: skipped without the bot, without status.v1 or without a channel; with them a status.alert job (ref per monitor)', async () => {
  const deliver = async (): Promise<RowDataPacket> => {
    await sql('DELETE FROM `DB`.status_outbox');
    await write(source());
    const { n } = notifier();
    await n.start();
    await n.deliverDue();
    return (await sql("SELECT state, error FROM `DB`.status_outbox WHERE channel = 'bot'"))[0];
  };
  let r = await deliver();
  assert.deepEqual([r.state, r.error], ['skipped', 'The bot doesn’t support status messages yet – update it with discord-bot/install.sh --update.']);
  await setReport(botReport(['updates.v1']));
  r = await deliver();
  assert.equal(r.state, 'skipped');
  await setReport(botReport(['updates.v1', 'status.v1']));
  await sql("UPDATE `DB`.status_pages SET settings = JSON_SET(COALESCE(settings, '{}'), '$.bot', JSON_OBJECT('status_channel_id', '', 'alerts_channel_id', '', 'saved', true)) WHERE id = ?", [pageId]);
  r = await deliver();
  assert.deepEqual([r.state, r.error], ['skipped', 'No channel for team alerts is chosen.']);
  await sql("UPDATE `DB`.status_pages SET settings = JSON_REMOVE(settings, '$.bot') WHERE id = ?", [pageId]);
  r = await deliver();
  assert.equal(r.state, 'sent');
  const jobs = await sql('SELECT action, ref, payload FROM `DB`.community_outbox');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].action, 'status.alert');
  assert.equal(jobs[0].ref, 'status-alert:m' + monitorId);
  const data = JSON.parse(String(jobs[0].payload));
  assert.equal(data.channel_id, CH(21));
  assert.equal(data.message.embeds[0].title, 'Website <b> is down');
  assert.equal(data.message.embeds[0].url, 'http://oys.test:8080/dashboard#status/system');
});

test('health record: mail counts per class, waiting rows; a restart on the same day keeps the counts', async () => {
  await write(source());
  const { n } = notifier();
  await n.start();
  await n.deliverDue();
  await write(source({ kind: 'cert', certDays: 14 }));
  await n.writeHealth();
  const rec = JSON.parse(String((await sql("SELECT meta_value FROM `DB`.oys_meta WHERE meta_key = 'status_notify'"))[0].meta_value));
  assert.deepEqual(rec.mail_today, { system: 2, confirm: 0, owner: 0, broadcast: 0 });
  assert.equal(rec.outbox, 3);
  assert.ok(Math.abs(rec.at - time()) < 5);
  const again = notifier();
  await again.n.start();
  assert.equal(again.n.budget.used.system, 2);
});

test('bot jobs: only a bot with status.v1 gets them; the embed is built at hand-out; the message id comes from /done; changes edit it', async () => {
  await setReport(botReport(['updates.v1', 'status.v1']));
  const page = (await withConnection((db) => systemStatusPage(db)))!;
  const now = time();
  const incId = await transaction(async (_conn, db) => {
    const id = await createIncident(db, pageId, { kind: 'incident', title: 'Website is slow', status: 'investigating', impact: 'minor', startsAt: now, endsAt: null,
      monitors: [{ id: monitorId, effect: 'degraded' }], body: 'Looking into it.' }, 3, now);
    await syncIncidentPosts(db, page, id, { post: true });
    return id;
  });
  // Ohne gültige Unterschrift nichts – und der Auftrag bleibt unberührt
  for (const headers of [{ host: HOST }, { host: HOST, 'x-oys-timestamp': String(time()), 'x-oys-signature': 'f'.repeat(64) }]) {
    const res = await app.inject({ method: 'GET', url: '/_/bot/outbox?f=status.v1', headers });
    assert.notEqual(res.statusCode, 200);
    assert.ok(!res.body.includes('status.post'));
  }
  assert.equal((await sql("SELECT claimed_at FROM `DB`.community_outbox WHERE action = 'status.post'"))[0].claimed_at, null);
  // Ein Bot ohne status.v1 bekommt nichts
  let out = await bot('GET', '/_/bot/outbox?f=updates.v1,suggestions.v2');
  assert.equal(out.status, 200);
  assert.deepEqual(out.json.items, []);
  // Mit status.v1: der Beitrag mit dem aktuellen Inhalt
  out = await bot('GET', '/_/bot/outbox?f=updates.v1,status.v1');
  const [item] = out.json.items as Array<{ id: number; action: string; data: Record<string, any> }>; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(item.action, 'status.post');
  assert.equal(item.data.channel_id, CH(20));
  assert.equal(item.data.message.embeds[0].url, `http://status.oys.test:8080/incidents/${incId}`);
  assert.equal(item.data.message.embeds[0].title, 'Investigating · Website is slow');
  assert.equal(item.data.recheck, undefined);
  // Während der Bot postet, kommt ein Update: vorgemerkt (dirty)
  await transaction(async (_conn, db) => {
    const inc = (await loadIncident(db, pageId, incId, true))!;
    await addIncidentUpdate(db, inc, 'identified', 'Found it.', 3, now + 1);
    await syncIncidentPosts(db, page, incId);
  });
  // /done mit der Nachrichten-ID: übernommen, danach ein Bearbeiten
  const done = await bot('POST', `/_/bot/outbox/${item.id}/done`, { error: '', result: { message_id: CH(500), channel_id: CH(20) } });
  assert.equal(done.status, 200);
  const post = (await sql('SELECT state, message_id, dirty FROM `DB`.status_incident_posts WHERE incident_id = ?', [incId]))[0];
  assert.deepEqual([post.state, post.message_id, Number(post.dirty)], ['posted', CH(500), 0]);
  out = await bot('GET', '/_/bot/outbox?f=status.v1');
  const [edit] = out.json.items as Array<{ id: number; action: string; data: Record<string, any> }>; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(edit.action, 'status.edit');
  assert.equal(edit.data.message_id, CH(500));
  assert.equal(edit.data.message.embeds[0].title, 'Identified · Website is slow');
  // Zwei schnelle Änderungen: ein noch nicht abgeholtes Bearbeiten wird ersetzt
  await bot('POST', `/_/bot/outbox/${edit.id}/done`, { error: '', result: {} });
  for (const s of ['monitoring', 'resolved']) {
    await transaction(async (_conn, db) => {
      const inc = (await loadIncident(db, pageId, incId, true))!;
      await addIncidentUpdate(db, inc, s, 'Update ' + s, 3, now + 2);
      await syncIncidentPosts(db, page, incId);
    });
  }
  const open = await sql("SELECT action FROM `DB`.community_outbox WHERE ref = ? AND done_at IS NULL", ['status-inc:' + incId]);
  assert.deepEqual(open.map((r) => r.action), ['status.edit']);
  out = await bot('GET', '/_/bot/outbox?f=status.v1');
  assert.equal((out.json.items as Array<{ data: Record<string, any> }>)[0].data.message.embeds[0].title, 'Resolved · Website is slow'); // eslint-disable-line @typescript-eslint/no-explicit-any
  // In Discord gelöscht (missing): nicht neu posten, sondern als gescheitert zeigen
  const last = (out.json.items as Array<{ id: number }>)[0];
  await bot('POST', `/_/bot/outbox/${last.id}/done`, { error: '', result: { missing: true } });
  const after = (await sql('SELECT state, error FROM `DB`.status_incident_posts WHERE incident_id = ?', [incId]))[0];
  assert.deepEqual([after.state, after.error], ['failed', 'The message was deleted in Discord.']);
});

test('status.alert jobs the bot hasn’t picked up within 2 hours expire; a final error marks a post as failed', async () => {
  await exec("INSERT INTO community_outbox (action, payload, ref, created_at) VALUES ('status.alert', '{\"channel_id\":\"1\"}', 'status-alert:m1', ?)", [date('Y-m-d H:i:s', time() - 7300)]);
  await exec("INSERT INTO community_outbox (action, payload, ref, created_at) VALUES ('status.alert', '{\"channel_id\":\"1\"}', 'status-alert:m2', ?)", [date('Y-m-d H:i:s', time() - 60)]);
  const out = await bot('GET', '/_/bot/outbox?f=status.v1');
  assert.deepEqual((out.json.items as Array<{ action: string }>).map((i) => i.action), ['status.alert']);
  const rows = await sql('SELECT ref, done_at, last_error FROM `DB`.community_outbox ORDER BY id');
  assert.equal(rows[0].last_error, 'expired');
  assert.notEqual(rows[0].done_at, null);
  assert.equal(rows[1].done_at, null);

  // Ein endgültiger Fehler beim ersten Beitrag (z. B. fehlende Rechte): gescheitert, mit dem Text des Bots
  await setReport(botReport(['status.v1']));
  const page = (await withConnection((db) => systemStatusPage(db)))!;
  const now = time();
  const incId = await transaction(async (_conn, db) => {
    const id = await createIncident(db, pageId, { kind: 'incident', title: 'Down', status: 'investigating', impact: 'major', startsAt: now, endsAt: null, monitors: [], body: 'x' }, 3, now);
    await syncIncidentPosts(db, page, id, { post: true });
    return id;
  });
  const job = (await bot('GET', '/_/bot/outbox?f=status.v1')).json.items.find((i: { action: string }) => i.action === 'status.post');
  await bot('POST', `/_/bot/outbox/${job.id}/done`, { error: 'The bot can’t post in #status: it needs Embed Links there.', final: true });
  const post = (await sql('SELECT state, error FROM `DB`.status_incident_posts WHERE incident_id = ?', [incId]))[0];
  assert.deepEqual([post.state, post.error], ['failed', 'The bot can’t post in #status: it needs Embed Links there.']);
});
