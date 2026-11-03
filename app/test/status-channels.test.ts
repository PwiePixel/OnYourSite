// Statusseiten, zusätzliche Alarm-Kanäle (ST-5): E-Mail-Adressen (Bestätigungslink erst beim Versand erzeugt, nur der
// Hash gespeichert, GET zeigt nur einen Knopf, POST bestätigt, 7 Tage gültig, je Seite 10 Bestätigungsmails am Tag),
// Discord-Webhooks (geprüft und mit Testnachricht angelegt, Alarme als Embed, nach 5 Fehlschlägen aus mit Mail an den
// Besitzer, Beiträge zu Vorfällen: posten, bearbeiten, löschen), die Grenze, Doppelte, Test und erneut senden, Admin-Modus,
// „Recent alerts“ und die Verteilung eines Alarms auf die Kanäle mit dem passenden Ereignis.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { makeTestCtx, type Ctx } from '../src/web/ctx.js';
import { appRoutes } from '../src/app/dispatch.js';
import { ensureSchema } from '../src/schema.js';
import { setConfigForTests } from '../src/config.js';
import { sha256Hex, randomHex } from '../src/crypto.js';
import { nowStr } from '../src/honeycombs/clock.js';
import { transaction } from '../src/db.js';
import { time } from '../src/php.js';
import { dispatch } from '../src/router.js';
import { alertRows, writeAlertRows, type AlertSource } from '../src/status/alerts.js';
import { statusPageSettings } from '../src/status/settings.js';
import { Notifier, type MailRequest } from '../src/status/notifier.js';
import '../src/status/shop.js';
import { startStandIn, type DiscordStandIn } from './fixtures/discord/standIn.js';
import { BASE, CSRF, jsonBody, loginSession, runRequest, testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
let discord: DiscordStandIn;
const OLD = '2026-01-01 10:00:00';
const ADMIN = 3;
const MIA = 5;
let pageId = 0;
let monitorId = 0;
const HOOK = '1301234567890123456';
const token = (seed: string): string => (seed + 'Qz7_-').repeat(12).slice(0, 68);
const hookLink = (id = HOOK): string => `${discord.base}/webhooks/${id}/${token('k' + id.slice(-2))}`;

async function sql(query: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [r] = await t.admin.query<RowDataPacket[]>(query.replace(/`DB`/g, '`' + t.name + '`'), params);
  return r;
}
const n = async (query: string, params: unknown[] = []): Promise<number> => Number(Object.values((await sql(query, params))[0])[0]);
async function api(action: string, o: { userId?: number; impersonatedBy?: number; json?: Record<string, unknown>; method?: string } = {}): Promise<Ctx> {
  const sid = await loginSession(o.userId ?? MIA, { impersonatedBy: o.impersonatedBy });
  const method = o.method ?? 'POST';
  const headers: Record<string, string> = method === 'POST' ? { 'content-type': 'application/json', 'x-csrf-token': CSRF } : {};
  return runRequest(makeTestCtx({ method, url: '/dashboard/api/' + action, headers, cookies: { PHPSESSID: sid }, rawBody: method === 'POST' ? Buffer.from(JSON.stringify(o.json ?? {})) : undefined }), appRoutes);
}
const body = (ctx: Ctx): Record<string, any> => jsonBody(ctx) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function verifyRequest(path: string, method = 'GET'): Promise<Ctx> {
  const ctx = makeTestCtx({ method, url: path, host: 'oys.test:8080', ip: '10.2.0.' + (Math.floor(Math.random() * 200) + 2) });
  await dispatch(ctx).catch(() => undefined);
  return ctx;
}
interface Mail extends MailRequest { at: number }
function notifier(): { n: Notifier; mails: Mail[] } {
  const mails: Mail[] = [];
  return { n: new Notifier({ log: () => undefined, sendMail: async (m) => { mails.push({ ...m, at: Date.now() }); return true; } }), mails };
}
async function deliver(): Promise<Mail[]> {
  const { n: nt, mails } = notifier();
  await nt.start();
  await nt.deliverDue();
  return mails;
}
function source(kind = 'down'): AlertSource {
  return {
    page: { id: pageId, userId: MIA, isSystem: false, slug: 'mia-status', title: 'Mia status' },
    monitor: { id: monitorId, name: 'Website', type: 'http', target: 'https://example.com/', isPublic: true, timeout: 10, retries: 1 },
    event: { kind, at: time(), error: 'timeout', code: null, muted: false, since: time() - 60 },
  };
}
async function alert(kind = 'down'): Promise<void> {
  const settings = statusPageSettings({ is_system: 0, settings: '{"alerts":{"owner":false,"events":["down","up"]}}' });
  await transaction(async (_conn, db) => { await writeAlertRows(db, alertRows(source(kind), settings), time()); });
}

before(async () => {
  discord = await startStandIn();
  t = await testDatabase('st5chan', { empty: true });
  await ensureSchema();
  setConfigForTests({ ...BASE, db: { ...(BASE.db as Record<string, string>), name: t.name }, discord_api_base: discord.base });
  const user = 'INSERT INTO `DB`.users (id, email, password, full_name, is_admin, created_at) VALUES (?, ?, \'x\', ?, ?, ?)';
  await sql(user, [ADMIN, 'admin@test.de', 'Pixel Admin', 1, OLD]);
  await sql(user, [MIA, 'mia@test.de', 'Mia', 0, OLD]);
  await sql("INSERT INTO `DB`.honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (?, 300, 'admin', ?, '', ?)", [MIA, 'st5-' + randomHex(8), nowStr()]);
  assert.equal(body(await api('shop-buy', { json: { item: 'status_page', request_id: randomHex(16), expected_price: 150 } })).ok, true);
  assert.equal(body(await api('status-create', { json: { title: 'Mia status', slug: 'mia-status' } })).ok, true);
  pageId = await n('SELECT id FROM `DB`.status_pages WHERE user_id = ?', [MIA]);
  await sql(`INSERT INTO \`DB\`.status_monitors (page_id, user_id, type, name, is_public, target, config, interval_s, changed_at, created_at, updated_at)
    VALUES (?, ?, 'http', 'Website', 1, 'https://example.com/', '{}', 300, 0, NOW(), NOW())`, [pageId, MIA]);
  monitorId = await n("SELECT id FROM `DB`.status_monitors WHERE page_id = ? AND name = 'Website'", [pageId]);
});

beforeEach(async () => {
  await sql('DELETE FROM `DB`.status_channels WHERE page_id = ?', [pageId]);
  await sql('DELETE FROM `DB`.status_outbox');
  await sql('DELETE FROM `DB`.status_incident_posts');
  await sql('DELETE FROM `DB`.rate_limits');
  discord.restart();
});

after(async () => {
  await discord.close();
  await t.done();
});

test('email channel: checks, a confirmation link minted at send time (only its hash stored), GET shows a button, POST confirms once', async () => {
  assert.deepEqual(body(await api('status-channel-add', { json: { type: 'email', target: 'nope' } })), { ok: false, error: 'Please enter a valid email address.', field: 'target' });
  assert.deepEqual(body(await api('status-channel-add', { json: { type: 'sms', target: 'x' } })), { ok: false, error: 'Please choose email or Discord.', field: 'type' });
  const r = body(await api('status-channel-add', { json: { type: 'email', target: 'Ops@Example.com', events: ['down', 'up', 'incident'] } }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.channel.state, r.channel.label, r.channel.events], ['waiting', 'op•••@example.com', ['down', 'up']]);
  assert.deepEqual(body(await api('status-channel-add', { json: { type: 'email', target: 'ops@example.com' } })), { ok: false, error: 'This address is already on the list.', field: 'target' });
  const stored = (await sql('SELECT target_enc FROM `DB`.status_channels WHERE page_id = ?', [pageId]))[0];
  assert.ok(!String(stored.target_enc).includes('example.com'), 'stored encrypted');
  const out = (await sql("SELECT kind, class, payload FROM `DB`.status_outbox WHERE kind = 'channel_verify'"))[0];
  assert.deepEqual([out.kind, out.class, out.payload], ['channel_verify', 'confirm', '{}']);
  const mails = await deliver();
  assert.equal(mails.length, 1);
  assert.equal(mails[0].template, 'status_verify');
  assert.equal(mails[0].to, 'Ops@Example.com');
  assert.equal(mails[0].subject, 'Confirm alerts for Mia status');
  const link = /\/_\/status\/verify\/([A-Za-z0-9_-]{32})$/.exec(mails[0].vars.button_url);
  assert.ok(link, mails[0].vars.button_url);
  const tok = link[1];
  assert.equal((await sql('SELECT verify_hash FROM `DB`.status_channels WHERE page_id = ?', [pageId]))[0].verify_hash, sha256Hex(tok));
  // GET bestätigt nichts
  let ctx = await verifyRequest('/_/status/verify/' + tok);
  assert.equal(ctx.status, 200);
  assert.match(String(ctx.body), /Confirm status alerts[\s\S]*<form method="POST"/);
  assert.equal(await n('SELECT COUNT(*) FROM `DB`.status_channels WHERE verified_at IS NOT NULL'), 0);
  ctx = await verifyRequest('/_/status/verify/' + tok, 'POST');
  assert.match(String(ctx.body), /Alerts for Mia status will now go to this address\./);
  assert.equal(await n('SELECT COUNT(*) FROM `DB`.status_channels WHERE verified_at IS NOT NULL'), 1);
  // Ein zweites Mal ändert nichts mehr („Already confirmed“, siehe unten)
  assert.match(String((await verifyRequest('/_/status/verify/' + tok, 'POST')).body), /Already confirmed/);
  assert.equal((await verifyRequest('/_/status/verify/short')).status, 404);
  // Zustand im Editor
  const list = body(await api('status-channels', { method: 'GET' }));
  assert.deepEqual(list.channels.map((c: { state: string }) => c.state), ['working']);
  assert.equal(list.limit, 3);
});

test('email channel: resend only after 10 minutes, links expire after 7 days, at most 10 confirmation mails a page a day', async () => {
  const r = body(await api('status-channel-add', { json: { type: 'email', target: 'a@example.com' } }));
  assert.deepEqual(body(await api('status-channel-resend', { json: { id: r.channel.id } })), { ok: false, error: 'We just sent a link – you can send it again after 10 minutes.' });
  await sql('UPDATE `DB`.status_channels SET verify_sent_at = verify_sent_at - 700');
  assert.equal(body(await api('status-channel-resend', { json: { id: r.channel.id } })).ok, true);
  const mails = await deliver();
  assert.equal(mails.length, 1, 'only the newest pending link is sent once per row');
  const tok = /([A-Za-z0-9_-]{32})$/.exec(mails[0].vars.button_url)![1];
  await sql('UPDATE `DB`.status_channels SET verify_sent_at = ?', [time() - 8 * 86400]);
  assert.equal((await verifyRequest('/_/status/verify/' + tok)).status, 404, 'expired');
  // Obergrenze je Seite: 10 am Tag
  await sql('DELETE FROM `DB`.status_outbox');
  for (let i = 0; i < 10; i++) {
    await sql(`INSERT INTO \`DB\`.status_outbox (page_id, monitor_id, kind, class, channel, event, payload, state, attempts, next_at, created_at, sent_at)
      VALUES (?, NULL, 'channel_verify', 'confirm', ?, '', '{}', 'sent', 1, ?, ?, ?)`, [pageId, 'channel:' + r.channel.id, time(), time(), time()]);
  }
  await sql('UPDATE `DB`.status_channels SET verify_sent_at = verify_sent_at - 700');
  await api('status-channel-resend', { json: { id: r.channel.id } });
  assert.equal((await deliver()).length, 0);
  assert.equal((await sql("SELECT error FROM `DB`.status_outbox WHERE state = 'skipped'"))[0].error, 'This page sent the most confirmation emails it can send today.');
});

test('the limit, admin mode and the alert fan-out to channels with the event (confirmed and on only)', async () => {
  for (const a of ['a@example.com', 'b@example.com', 'c@example.com']) assert.equal(body(await api('status-channel-add', { json: { type: 'email', target: a, events: a === 'c@example.com' ? ['up'] : ['down', 'up'] } })).ok, true);
  assert.deepEqual(body(await api('status-channel-add', { json: { type: 'email', target: 'd@example.com' } })), { ok: false, error: 'You can add up to 3 alert channels.' });
  const am = await api('status-channel-add', { impersonatedBy: ADMIN, json: { type: 'email', target: 'e@example.com' } });
  assert.equal(am.status, 403);
  const ids = (await sql('SELECT id, target_hash FROM `DB`.status_channels WHERE page_id = ? ORDER BY id', [pageId])).map((r) => Number(r.id));
  // a bestätigt, b noch nicht, c bestätigt aber nur „up“
  await sql('UPDATE `DB`.status_channels SET verified_at = ? WHERE id IN (?, ?)', [time(), ids[0], ids[2]]);
  await sql('DELETE FROM `DB`.status_outbox');
  await alert('down');
  const rows = await sql("SELECT channel FROM `DB`.status_outbox WHERE kind = 'alert' ORDER BY id");
  assert.deepEqual(rows.map((r) => r.channel), ['bell', 'channel:' + ids[0]]);
  const mails = (await deliver()).filter((m) => m.template === 'status_channel_alert');
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'a@example.com');
  assert.match(mails[0].vars.button_url, /mia-status/);
  assert.doesNotMatch(mails[0].vars.button_url, /dashboard/, 'never the editor link for a third party');
  // Aus: nichts mehr
  assert.equal(body(await api('status-channel-edit', { json: { id: ids[0], enabled: false } })).ok, true);
  await sql('DELETE FROM `DB`.status_outbox');
  await alert('down');
  assert.equal(await n("SELECT COUNT(*) FROM `DB`.status_outbox WHERE channel LIKE 'channel:%'"), 0);
  // Recent alerts nennt den Kanal
  const rec = body(await api('status-channels', { method: 'GET' })).recent;
  assert.ok(rec.some((r: { to: string }) => r.to === 'bell'));
  // Entfernen
  assert.equal(body(await api('status-channel-remove', { json: { id: ids[1] } })).ok, true);
  assert.equal(await n('SELECT COUNT(*) FROM `DB`.status_channels WHERE id = ?', [ids[1]]), 0);
});

test('discord channel: checked and tested when added, alerts as embeds, five rejections turn it off and mail the owner', async () => {
  assert.equal(body(await api('status-channel-add', { json: { type: 'discord', target: 'https://example.com/hook' } })).error, 'Please paste a Discord webhook link (Server settings → Integrations → Webhooks).');
  assert.equal(body(await api('status-channel-add', { json: { type: 'discord', target: hookLink('4041234567890123456') } })).error, 'Discord rejected the webhook link – please copy it again from Discord.');
  const r = body(await api('status-channel-add', { json: { type: 'discord', target: hookLink() } }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.channel.state, r.channel.events.includes('incident')], ['working', true]);
  assert.ok(r.channel.label.endsWith('/••••') && !r.channel.label.includes(token('k56')), 'token never shown');
  assert.ok([...discord.messages().values()].some((m) => String((m.body as { content?: string }).content).includes('Status alerts will be posted here')), 'test message');
  // Alarm → Embed
  await alert('down');
  await deliver();
  const embeds = [...discord.messages().values()].filter((m) => Array.isArray((m.body as { embeds?: unknown[] }).embeds));
  assert.equal(embeds.length, 1);
  assert.deepEqual((embeds[0].body as { allowed_mentions: unknown }).allowed_mentions, { parse: [] });
  // Fünfmal abgelehnt (404): aus, Mail an den Besitzer
  for (let i = 0; i < 5; i++) {
    await sql('DELETE FROM `DB`.status_outbox');
    discord.failNext(404);
    await alert('down');
    await deliver();
  }
  const ch = (await sql('SELECT is_enabled, fail_count FROM `DB`.status_channels WHERE id = ?', [r.channel.id]))[0];
  assert.deepEqual([ch.is_enabled, ch.fail_count], [0, 5]);
  assert.equal(await n("SELECT COUNT(*) FROM `DB`.status_outbox WHERE kind = 'channel_broken' AND channel = 'owner'"), 1);
  const mails = await deliver();
  assert.equal(mails.length, 1);
  assert.equal(mails[0].subject, 'Your Discord alerts for Mia status stopped working');
  assert.equal(mails[0].to, 'mia@test.de');
  // Wieder an: zählt neu
  assert.equal(body(await api('status-channel-edit', { json: { id: r.channel.id, enabled: true } })).channel.state, 'working');
});

test('discord channel: one post per incident, edited on updates, deleted with the incident', async () => {
  const r = body(await api('status-channel-add', { json: { type: 'discord', target: hookLink() } }));
  assert.equal(r.ok, true);
  const before = discord.messages().size;
  const inc = body(await api('status-incident-save', { json: { kind: 'incident', title: 'Website is slow', status: 'investigating', impact: 'minor', monitors: [], body: 'Looking into it.' } }));
  assert.equal(inc.ok, true, JSON.stringify(inc));
  const incId = inc.incident.id;
  await deliver();
  const post = (await sql('SELECT state, message_id FROM `DB`.status_incident_posts WHERE incident_id = ?', [incId]))[0];
  assert.equal(post.state, 'posted');
  assert.ok(post.message_id);
  assert.equal(discord.messages().size, before + 1);
  assert.equal(body(await api('status-incident-update', { json: { id: incId, status: 'identified', body: 'Found it.' } })).ok, true);
  await deliver();
  const msg = discord.messages().get(String(post.message_id));
  assert.match(JSON.stringify(msg?.body), /Identified/);
  assert.equal(body(await api('status-incident-delete', { json: { id: incId } })).ok, true);
  await deliver();
  assert.equal(discord.messages().has(String(post.message_id)), false, 'deleted in Discord');
  assert.equal(await n('SELECT COUNT(*) FROM `DB`.status_incident_posts WHERE incident_id = ?', [incId]), 0);
});

test('test messages: only confirmed and on, 3 per 10 minutes', async () => {
  const r = body(await api('status-channel-add', { json: { type: 'email', target: 't@example.com' } }));
  assert.deepEqual(body(await api('status-channel-test', { json: { id: r.channel.id } })), { ok: false, error: 'Confirm the address first – we sent a link to it.' });
  await sql('UPDATE `DB`.status_channels SET verified_at = ?', [time()]);
  for (let i = 0; i < 3; i++) assert.equal(body(await api('status-channel-test', { json: { id: r.channel.id } })).ok, true);
  assert.deepEqual(body(await api('status-channel-test', { json: { id: r.channel.id } })), { ok: false, error: 'You’ve sent 3 tests – please wait 10 minutes.' });
  const mails = (await deliver()).filter((m) => m.template === 'status_channel_alert');
  assert.equal(mails.length, 3);
  assert.equal(mails[0].subject, '[Test] Status alerts for Mia status');
});

test('review: channels get their own events, channel rows don’t mute the owner, a message deleted in Discord doesn’t break the webhook, empty events and the confirmed link', async () => {
  // Der Besitzer will nur „down“, der Kanal nur „up“: der Kanal bekommt „up“ trotzdem
  const e = body(await api('status-channel-add', { json: { type: 'email', target: 'up@example.com', events: ['up'] } }));
  await sql('UPDATE `DB`.status_channels SET verified_at = ? WHERE id = ?', [time(), e.channel.id]);
  await sql('DELETE FROM `DB`.status_outbox');
  const only = statusPageSettings({ is_system: 0, settings: '{"alerts":{"owner":true,"events":["down"]}}' });
  await transaction(async (_conn, db) => { await writeAlertRows(db, alertRows(source('up'), only), time()); });
  assert.deepEqual((await sql("SELECT channel FROM `DB`.status_outbox WHERE kind = 'alert'")).map((r) => r.channel), ['channel:' + e.channel.id]);
  // 30 gesendete Kanal-Alarme in der Stunde stummen die E-Mail an den Besitzer nicht
  await sql('DELETE FROM `DB`.status_outbox');
  for (let i = 0; i < 30; i++) {
    await sql(`INSERT INTO \`DB\`.status_outbox (page_id, monitor_id, kind, class, channel, event, payload, state, attempts, next_at, created_at, sent_at)
      VALUES (?, ?, 'alert', 'owner', ?, 'down', '{}', 'sent', 1, ?, ?, ?)`, [pageId, monitorId, 'channel:' + e.channel.id, time(), time(), time()]);
  }
  const settings = statusPageSettings({ is_system: 0, settings: '{"alerts":{"owner":true,"events":["down"]}}' });
  await transaction(async (_conn, db) => { await writeAlertRows(db, alertRows(source('down'), settings), time()); });
  const mails = await deliver();
  assert.ok(mails.some((m) => m.template === 'status_owner_alert' && m.to === 'mia@test.de'), 'the owner still gets the email');
  await sql('DELETE FROM `DB`.status_channels WHERE id = ?', [e.channel.id]);
  // In Discord gelöschte Nachricht: das Bearbeiten scheitert mit 10008 – der Webhook zählt keinen Fehler
  const d = body(await api('status-channel-add', { json: { type: 'discord', target: hookLink() } }));
  const inc = body(await api('status-incident-save', { json: { kind: 'incident', title: 'Slow', status: 'investigating', impact: 'minor', monitors: [], body: 'x' } }));
  await deliver();
  discord.forget();
  for (let i = 0; i < 5; i++) {
    await api('status-incident-update', { json: { id: inc.incident.id, status: 'identified', body: 'y' + i } });
    await deliver();
  }
  const ch = (await sql('SELECT is_enabled, fail_count FROM `DB`.status_channels WHERE id = ?', [d.channel.id]))[0];
  assert.deepEqual([ch.is_enabled, ch.fail_count], [1, 0]);
  assert.equal((await sql('SELECT state FROM `DB`.status_incident_posts WHERE incident_id = ?', [inc.incident.id]))[0].state, 'failed');
  // Ohne Ereignis: kein Kanal
  assert.deepEqual(body(await api('status-channel-add', { json: { type: 'email', target: 'none@example.com', events: [] } })), { ok: false, error: 'Please choose at least one event.', field: 'events' });
});

test('review: the confirmation link says “Already confirmed” after use', async () => {
  body(await api('status-channel-add', { json: { type: 'email', target: 'twice@example.com' } }));
  const tok = /([A-Za-z0-9_-]{32})$/.exec((await deliver())[0].vars.button_url)![1];
  await verifyRequest('/_/status/verify/' + tok, 'POST');
  const again = await verifyRequest('/_/status/verify/' + tok);
  assert.match(String(again.body), /Already confirmed/);
  assert.match(String((await verifyRequest('/_/status/verify/' + tok, 'POST')).body), /Already confirmed/);
});
