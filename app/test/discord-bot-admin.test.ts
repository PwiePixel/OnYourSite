// Admin → Discord für den installierten Bot (DP-2b), über den ganzen Server (Router, Sitzung, CSRF, Weiterleitung):
// /admin/api/ mit 401/403 als JSON und /admin/api/discord-status; die Bot-Karte in jedem Zustand mit „Use #updates“;
// discord_bot_save/test/refresh, discord_post_retry/forget und discord_job_dismiss mit allen Regeln; die Karte
// „Discord posts“ und die Chips der Updates; tote Aufträge im Reiter Discord statt im Community-Bereich; dieselbe
// Prüfung auf denselben Kanal in beide Richtungen; CSRF, nur Admins und maskierte Texte.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { configString, setConfigForTests, type ConfigData } from '../src/config.js';
import { exec, one, q, value } from '../src/db.js';
import { decryptData, encryptData } from '../src/crypto.js';
import { date, time } from '../src/php.js';
import { buildServer } from '../src/server.js';
import { botPlaces } from '../src/discord/botCard.js';
import { BASE, CSRF, loginSession, testDatabase, type TestDb } from './coreHarness.js';
import { startStandIn, type DiscordStandIn } from './fixtures/discord/standIn.js';

let t: TestDb;
let app: FastifyInstance;
let discord: DiscordStandIn;
let dir: string;
const HOST = 'oys.test:8080';
const SECRET = configString('bot_secret');
const ID = (n: number): string => String(1300000000000000000n + BigInt(n));
const UPDATES = ID(10);
const GENERAL = ID(11);
const FORUM = ID(12);
const THREAD = ID(20);
const ROLE = ID(30);
const HIDDEN_ROLE = ID(31);
// Webhook-Links zur Laufzeit zusammengesetzt (kein tokenförmiger Text im Repository)
const token = (seed: string): string => (seed + 'Qz7_-').repeat(12).slice(0, 68);
const HOOK = '1301234567890123456';
const hookLink = (): string => `${discord.base}/webhooks/${HOOK}/${token('w' + HOOK.slice(-2))}`;
// Der Kanal, den der Discord-Ersatz für jeden Webhook meldet (standIn.ts)
const HOOK_CHANNEL = '1200000000000000001';

function useConfig(extra: ConfigData = {}): void {
  setConfigForTests({ ...BASE, db: { ...(BASE.db as ConfigData), name: t.name }, discord_api_base: discord.base, ...extra });
}

before(async () => {
  assert.ok(SECRET.length >= 32, 'the test settings need a bot_secret');
  discord = await startStandIn();
  t = await testDatabase('dp2b');
  useConfig();
  dir = mkdtempSync(join(tmpdir(), 'oys-dp2b-'));
  // Der Bot läuft nicht auf diesem Rechner, solange ein Test nichts anderes sagt
  botPlaces.unit = join(dir, 'no-unit');
  botPlaces.dockerEnv = () => join(dir, 'no-env');
  app = await buildServer();
  await app.ready();
});

after(async () => {
  await app?.close();
  await t?.done();
  await discord?.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  useConfig();
  discord.restart();
  botPlaces.unit = join(dir, 'no-unit');
  for (const sql of ['DELETE FROM updates', 'DELETE FROM update_discord_posts', 'DELETE FROM community_outbox', "DELETE FROM rate_limits WHERE rl_key LIKE 'discord%'",
    "DELETE FROM oys_meta WHERE meta_key IN ('discord', 'discord_bot_report', 'discord_bot_test', 'bot_last_seen')"]) await exec(sql);
});

// ------------------------------------------------------------------ Hilfen

function report(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '0.2.0', runtime: 'service', features: ['updates.v1'],
    guild: { id: ID(1), name: 'OnYourSite', community: true }, updates_channel_id: UPDATES,
    categories: [{ id: ID(2), name: 'News' }],
    channels: [
      { id: UPDATES, name: 'updates', type: 'announcement', parent_id: ID(2), can_post: true, can_mention_everyone: false, missing: [] },
      { id: GENERAL, name: 'general', type: 'text', parent_id: '', can_post: false, can_mention_everyone: false, missing: ['SendMessages', 'EmbedLinks'] },
      { id: FORUM, name: 'changelog', type: 'forum', parent_id: '', can_post: true, can_mention_everyone: true, missing: [] },
    ],
    threads: [{ id: THREAD, name: 'Release notes', parent_id: FORUM, can_post: true }],
    roles: [{ id: ROLE, name: 'Update pings', mentionable: true }, { id: HIDDEN_ROLE, name: 'Mods', mentionable: false }],
    truncated: false, ...over,
  };
}

// Bericht wie nach /_/bot/hello gespeichert (reported_at: so viele Sekunden her)
async function storeReport(over: Record<string, unknown> = {}, agoSec = 60): Promise<void> {
  await exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('discord_bot_report', ?)", [JSON.stringify({ reported_at: time() - agoSec, ...report(over) })]);
}
async function seen(agoSec = 10): Promise<void> {
  await exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('bot_last_seen', ?)", [String(time() - agoSec)]);
}
// Ein Bot, der online ist und Updates posten kann
async function onlineBot(over: Record<string, unknown> = {}): Promise<void> {
  await seen();
  await storeReport(over);
}

async function storeSettings(v: Record<string, unknown>): Promise<void> {
  await exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('discord', ?)", [String(encryptData(JSON.stringify(v)))]);
}
async function stored(): Promise<Record<string, any> | null> {
  const raw = await value("SELECT meta_value FROM oys_meta WHERE meta_key = 'discord'");
  return raw === null ? null : (JSON.parse(String(decryptData(String(raw)))) as Record<string, any>);
}
const v2 = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ v: 2, auto_post: true, invite_url: '', bot: {}, webhook: {}, bot_token: '', channel_id: '', mention: '', ...over });

// Signierte Anfrage wie der Bot (site.js)
async function bot(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const ts = String(time());
  const sig = createHmac('sha256', SECRET).update(`${ts}\n${method}\n${path}\n${payload}`).digest('hex');
  const headers: Record<string, string> = { host: HOST, 'x-oys-timestamp': ts, 'x-oys-signature': sig };
  if (payload !== '') headers['content-type'] = 'application/json';
  const res = await app.inject({ method, url: path, headers, payload: payload === '' ? undefined : payload });
  return { status: res.statusCode, json: res.body === '' ? {} : (JSON.parse(res.body) as Record<string, unknown>) };
}

interface Posted { status: number; location: string; ok?: string; error?: string; field?: string; keep?: Record<string, string> }
// POST /admin über den Server; die Meldung steht danach in der Sitzung
async function adminPost(form: Record<string, string>, opts: { user?: number; csrf?: boolean; impersonatedBy?: number } = {}): Promise<Posted> {
  const sid = await loginSession(opts.user ?? 3, opts.impersonatedBy !== undefined ? { impersonatedBy: opts.impersonatedBy } : {});
  const body = new URLSearchParams({ ...(opts.csrf === false ? {} : { csrf: CSRF }), ...form }).toString();
  const res = await app.inject({ method: 'POST', url: '/admin', headers: { host: HOST, cookie: 'PHPSESSID=' + sid, 'content-type': 'application/x-www-form-urlencoded' }, payload: body });
  const raw = await value('SELECT data FROM oys_sessions WHERE id = ?', [sid]);
  const data = raw === null ? {} : (JSON.parse(String(raw)) as Record<string, any>);
  return { status: res.statusCode, location: String(res.headers.location ?? ''), ok: data.admin_success, error: data.admin_error, field: data.discord_error_field, keep: data.discord_bot_keep };
}

// GET /admin als Admin: die ganze Seite und der Reiter Discord
async function adminPage(): Promise<{ html: string; tab: string }> {
  const sid = await loginSession(3);
  const res = await app.inject({ method: 'GET', url: '/admin', headers: { host: HOST, cookie: 'PHPSESSID=' + sid } });
  assert.equal(res.statusCode, 200);
  const html = res.body;
  const start = html.indexOf('<div id="tab-discord"');
  const end = html.indexOf('<!-- ===================== Community', start);
  assert.ok(start > 0, 'the Discord tab is on the page');
  return { html, tab: html.slice(start, end > start ? end : undefined) };
}
const botCardOf = (tab: string): string => {
  const start = tab.indexOf('<div id="discordBotCard"');
  return tab.slice(start, tab.indexOf('<div class="bg-card border border-bordercolor rounded-xl shadow-xl p-5 sm:p-6">', start + 10));
};

async function statusJson(query = '', opts: { user?: number; cookie?: boolean; impersonatedBy?: number; method?: 'GET' | 'POST' } = {}): Promise<{ status: number; json: Record<string, any>; headers: Record<string, unknown> }> {
  const headers: Record<string, string> = { host: HOST };
  if (opts.cookie !== false) headers.cookie = 'PHPSESSID=' + await loginSession(opts.user ?? 3, opts.impersonatedBy !== undefined ? { impersonatedBy: opts.impersonatedBy } : {});
  const res = await app.inject({ method: opts.method ?? 'GET', url: '/admin/api/discord-status' + query, headers });
  return { status: res.statusCode, json: JSON.parse(res.body) as Record<string, any>, headers: res.headers };
}

async function addUpdate(id: number, extra: Record<string, unknown> = {}): Promise<void> {
  const row = { id, title: 'Update ' + id, body: 'Text', version: '', category: 'new', is_published: 1, published_at: date('Y-m-d H:i:s'), discord_announce: 1, created_at: date('Y-m-d H:i:s'), updated_at: date('Y-m-d H:i:s'), ...extra };
  await exec(`INSERT INTO updates (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`, Object.values(row) as never[]);
}
// Eine Zeile in update_discord_posts (updated: so viele Sekunden her)
async function addPost(updateId: number, fields: Record<string, unknown>, agoSec = 0): Promise<number> {
  const at = date('Y-m-d H:i:s', time() - agoSec);
  const row = { update_id: updateId, via: 'bot', target: 'bot', kind: 'message', channel_id: UPDATES, message_id: null, state: 'posted', dirty: 0, legacy: 0, error: null, created_at: at, updated_at: at, ...fields };
  const res = await exec(`INSERT INTO update_discord_posts (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`, Object.values(row) as never[]);
  return res.insertId;
}
async function addJob(action: string, ref: string | null, fields: Record<string, unknown> = {}): Promise<number> {
  const row = { action, payload: '{}', ref, attempts: 0, last_error: null, created_at: date('Y-m-d H:i:s'), done_at: null, claimed_at: null, ...fields };
  const res = await exec(`INSERT INTO community_outbox (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`, Object.values(row) as never[]);
  return res.insertId;
}
const openJobs = (action: string) => q('SELECT * FROM community_outbox WHERE action = ? AND done_at IS NULL ORDER BY id', [action]);

// ------------------------------------------------------------------ /admin/api/

test('/admin/api/: logged out 401 as JSON, a user or an impersonating admin 403 as JSON, unknown names 404, only GET', async () => {
  let r = await statusJson('', { cookie: false });
  assert.equal(r.status, 401);
  assert.deepEqual(r.json, { ok: false, error: 'Please log in again.' });
  r = await statusJson('', { user: 5 });
  assert.equal(r.status, 403);
  assert.deepEqual(r.json, { ok: false, error: 'Admins only.' });
  r = await statusJson('', { user: 5, impersonatedBy: 3 });
  assert.equal(r.status, 403, 'an admin in user mode is the user here');
  r = await statusJson('', { method: 'POST' });
  assert.equal(r.status, 405);
  const sid = await loginSession(3);
  const res = await app.inject({ method: 'GET', url: '/admin/api/nothing-here', headers: { host: HOST, cookie: 'PHPSESSID=' + sid } });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'Not found.' });
  // Andere Adressen unter /admin bleiben, was sie waren (keine Profilseite, keine Weiterleitung auf einen Fehler)
  const other = await app.inject({ method: 'GET', url: '/admin/api', headers: { host: HOST } });
  assert.equal(other.statusCode, 404);
});

test('/admin/api/discord-status: the bot, the webhook and the posts of the asked updates – no-store, noindex, at most 100', async () => {
  await onlineBot();
  await addUpdate(1);
  await addUpdate(2);
  const p1 = await addPost(1, { state: 'queued' });
  await addPost(2, { via: 'webhook', target: 'webhook:' + HOOK, state: 'failed', error: 'Discord said <no>' });
  const r = await statusJson('?updates=1,2,x,,1,999');
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.match(String(r.headers['x-robots-tag']), /noindex/);
  assert.match(String(r.headers['content-type']), /^application\/json/);
  const b = r.json.bot;
  assert.equal(b.installed, true);
  assert.equal(b.online, true);
  assert.equal(b.version, '0.2.0');
  assert.equal(b.state, 'online');
  assert.equal(b.checking, false);
  assert.equal(b.channel, '#updates', 'nothing else is set up: the bot posts in #updates by itself');
  assert.equal(b.ready, true);
  assert.deepEqual(r.json.webhook, { enabled: false, checked_at: '', error: '' });
  const posts = r.json.posts as Array<Record<string, unknown>>;
  assert.equal(posts.length, 2);
  const queued = posts.find((p) => p.id === p1)!;
  assert.equal(queued.label, 'Bot · posting…');
  assert.equal(queued.state, 'queued');
  assert.equal(queued.forget, false, 'a queued post can be forgotten after 10 minutes');
  assert.equal(queued.update_title, 'Update 1');
  const failed = posts.find((p) => p.update_id === 2)!;
  assert.deepEqual([failed.label, failed.tone, failed.retry, failed.forget, failed.error], ['Webhook · failed', 'err', true, true, 'Discord said <no>']);
  // Höchstens 100 Updates je Abfrage, Unsinn fällt weg
  const many = Array.from({ length: 150 }, (_, i) => String(i + 1)).join(',');
  assert.equal((await statusJson('?updates=' + many)).status, 200);
  assert.deepEqual((await statusJson('?updates[]=1')).json.posts, [], 'an array is no list of updates');
});

// ------------------------------------------------------------------ Karte „Post with the bot“

test('bot card: not set up, an older bot (with the update commands for here or elsewhere), online – never a token field', async () => {
  useConfig({ bot_secret: '' });
  let card = botCardOf((await adminPage()).tab);
  assert.match(card, /The Discord bot isn’t set up on this server\. Run <code class="text-white break-all">sudo bash [^<]+\/server\/install\.sh<\/code>/);
  assert.match((await adminPage()).tab, /data-bot-badge[^>]*>Not set up</);
  useConfig();
  // Ohne Bericht (Bot 0.1): ältere Version; der Bot läuft woanders → beide Befehle
  await seen(30);
  card = botCardOf((await adminPage()).tab);
  assert.match(card, /data-bot-status>Online · last seen just now</);
  assert.match(card, /The bot runs an older version that can’t post updates yet\./);
  assert.match(card, /Update it where it runs: get the new code there, then <code[^>]*>sudo bash discord-bot\/install\.sh --update<\/code> in that folder\. If it runs on this server: <code[^>]*>sudo bash [^<]+\/server\/install\.sh --update<\/code>/);
  assert.match(card, /form="discordBotRefreshForm"[^>]*>.*Refresh</);
  // Die Einheit des Bots gibt es auf diesem Rechner: nur der eine Befehl
  writeFileSync(botPlaces.unit, '[Unit]\n');
  card = botCardOf((await adminPage()).tab);
  assert.match(card, /Update it: <code[^>]*>sudo bash [^<]+\/server\/install\.sh --update<\/code>/);
  assert.doesNotMatch(card, /discord-bot\/install\.sh/);
  // Bericht mit updates.v1: online, Version, Ort, Server, „Use #updates“ und das Formular
  await storeReport();
  const { tab, html } = await adminPage();
  card = botCardOf(tab);
  assert.match(card, /Online · version 0\.2\.0 · system service on this server · server “OnYourSite” · channels checked 1 minute ago/);
  assert.match(card, /The bot is ready to post in #updates\./);
  assert.match(card, /<input type="hidden" name="bot_channel" value="1300000000000000010">.*Use #updates<\/button>/);
  assert.match(card, /Ready – the bot posts new updates in #updates by itself while nothing else is set up\./);
  // Kanäle in Gruppen, ohne Zugang gesperrt; Ping je Kanal (im Ankündigungskanal darf der Bot nicht @everyone)
  assert.match(card, /<optgroup label="Announcement channels"><option value="1300000000000000010" data-everyone="0" selected>#updates \(News\)<\/option><\/optgroup>/);
  assert.match(card, /<option value="1300000000000000011" data-everyone="0" disabled>#general – no access<\/option>/);
  assert.match(card, /<optgroup label="Forum channels – each update becomes a new post">/);
  assert.match(card, /<optgroup label="Threads"><option value="1300000000000000020" data-everyone="1">#Release notes \(in #changelog\)<\/option>/);
  assert.match(card, /<option value="everyone" data-label="@everyone" data-needs-everyone disabled>@everyone – the bot may not ping<\/option>/);
  assert.match(card, /<option value="1300000000000000030" data-label="@Update pings">@Update pings<\/option>/);
  assert.match(card, /<option value="1300000000000000031" data-label="@Mods" data-needs-everyone disabled>@Mods – the bot may not ping<\/option>/);
  assert.match(card, /name="bot_enabled" value="1" class="accent-\[#5865F2\]" checked> Announce new updates with the bot/);
  assert.match(card, /Send test/);
  // Q13: nirgends ein Feld für einen Token, kein Passwortfeld, keine Namen, die ein Browser mit Logins füllt
  assert.doesNotMatch(tab, /<input[^>]*name="[^"]*token[^"]*"/);
  assert.doesNotMatch(tab, /type="password"/);
  assert.doesNotMatch(tab, /name="(?:username|email|channel_id|webhook_url)"/);
  assert.match(html, /data-bot-badge[^>]*>Online</);
  // Zu viele Kanäle für den Bericht: Hinweis
  await storeReport({ truncated: true });
  assert.match(botCardOf((await adminPage()).tab), /Some channels aren’t listed – the server has more than the bot can report\./);
  // Offline: Formular bleibt, mit dem Hinweis auf die Wartezeit
  await seen(3600);
  card = botCardOf((await adminPage()).tab);
  assert.match(card, /data-bot-status>Offline – last seen [A-Z][a-z]{2} \d{1,2}, \d{4} \d\d:\d\d\. New posts wait and go out when the bot is back; posts that wait longer than 24 hours aren’t sent\.</);
  assert.match(card, /id="discordBotForm"/);
});

test('discord_bot_save: every rule names the problem and the field, keeps the choice and stores nothing', async () => {
  const fail = async (form: Record<string, string>, error: RegExp | string, field?: string): Promise<void> => {
    const r = await adminPost({ oys_action: 'discord_bot_save', bot_enabled: '1', ...form });
    assert.equal(r.status, 302);
    assert.equal(r.location, '/admin#discord');
    if (typeof error === 'string') assert.equal(r.error, error, JSON.stringify(form));
    else assert.match(String(r.error), error, JSON.stringify(form));
    if (field !== undefined) assert.equal(r.field, field, JSON.stringify(form));
    assert.equal(await stored(), null, 'nothing stored');
    assert.equal((await openJobs('bot.report')).length, 0, 'no report asked for');
  };
  useConfig({ bot_secret: '' });
  await fail({ bot_channel: UPDATES }, /^The Discord bot isn’t set up on this server/);
  useConfig();
  await seen();
  await fail({ bot_channel: UPDATES }, /^The bot hasn’t reported its channels – it needs version 0\.2\.0 or newer/);
  await storeReport({ features: [] });
  await fail({ bot_channel: UPDATES }, /^The bot hasn’t reported its channels/);
  await storeReport();
  await fail({}, 'Channel: choose where the bot posts updates.', 'bot_channel');
  await fail({ bot_channel: ID(99) }, /^Channel: the bot doesn’t list this channel any more/, 'bot_channel');
  await fail({ bot_channel: 'abc' }, /^Channel: the bot doesn’t list this channel any more/, 'bot_channel');
  await fail({ bot_channel: GENERAL }, 'The bot can’t post in #general: it needs Send Messages, Embed Links there.', 'bot_channel');
  await fail({ bot_channel: UPDATES, bot_mention: 'everyone' }, /^Ping: the bot may not ping @everyone in #updates – give it “Mention @everyone, @here and All Roles”/, 'bot_mention');
  await fail({ bot_channel: UPDATES, bot_mention: HIDDEN_ROLE }, /^Ping: the bot may not ping @Mods in #updates/, 'bot_mention');
  await fail({ bot_channel: UPDATES, bot_mention: ID(98) }, 'Ping: this role no longer exists – choose another one.', 'bot_mention');
  await fail({ bot_channel: UPDATES, bot_mention: 'someone' }, 'Ping: choose Nobody, @everyone, @here or a role.', 'bot_mention');
  const r = await adminPost({ oys_action: 'discord_bot_save', bot_enabled: '1', bot_channel: GENERAL, bot_mention: ROLE });
  assert.deepEqual(r.keep, { bot_channel: GENERAL, bot_mention: ROLE, bot_enabled: '1' }, 'the choice stays for the next page');
  // Die nächste Seite zeigt die Wahl und markiert das Feld (einmal)
  // (eigene Sitzung je adminPost – hier genügt, dass die Werte gemerkt sind; die Ansicht prüft der Browser-Test)
  // Derselbe Kanal wie der Webhook: jedes Update käme zweimal
  await storeSettings(v2({ webhook: { enabled: true, url: hookLink(), hook_channel_id: UPDATES, checked_at: date('Y-m-d H:i:s') } }));
  const same = await adminPost({ oys_action: 'discord_bot_save', bot_enabled: '1', bot_channel: UPDATES });
  assert.equal(same.error, 'The webhook already posts into this channel – updates would show up twice. Choose another channel for the bot, or remove the webhook.');
  assert.equal(same.field, 'bot_channel');
  assert.equal((await stored())?.bot.saved_at ?? '', '', 'the bot stays unsaved');
  // Ein Thread des Webhooks zählt genauso
  await storeSettings(v2({ webhook: { enabled: true, url: hookLink(), post_in: 'thread', thread_id: THREAD, hook_channel_id: FORUM } }));
  assert.match(String((await adminPost({ oys_action: 'discord_bot_save', bot_enabled: '1', bot_channel: THREAD })).error), /^The webhook already posts into this channel/);
});

test('discord_bot_save: stores the choice, deletes the old token (the bot takes over its posts) and shows “Checking” until a newer report', async () => {
  await onlineBot();
  await addUpdate(4);
  await storeSettings(v2({ bot_token: 'old-' + token('t'), channel_id: GENERAL, mention: 'here' }));
  await addPost(4, { via: 'token', target: 'bot:' + GENERAL, channel_id: GENERAL, message_id: ID(400), legacy: 1 });
  await addJob('bot.report', 'report');
  const r = await adminPost({ oys_action: 'discord_bot_save', bot_enabled: '1', bot_channel: FORUM, bot_mention: 'everyone' });
  assert.equal(r.ok, 'Saved – the bot checks #changelog now. The old bot token is deleted from the website.');
  assert.equal(r.location, '/admin#discord');
  const s = (await stored())!;
  assert.equal(s.bot.enabled, true);
  assert.equal(s.bot.channel_id, FORUM);
  assert.equal(s.bot.channel_type, 'forum');
  assert.equal(s.bot.mention, 'everyone');
  assert.match(s.bot.saved_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.deepEqual([s.bot_token, s.channel_id, s.mention], ['', '', ''], 'the website holds no bot token any more');
  const legacy = (await one("SELECT * FROM update_discord_posts WHERE update_id = 4"))!;
  assert.deepEqual([legacy.via, legacy.legacy, legacy.message_id], ['bot', 1, ID(400)], 'the installed bot takes over the old posts');
  // Ein neuer Bericht ist bestellt; der noch nicht abgeholte alte ist ersetzt
  const reports = await q("SELECT * FROM community_outbox WHERE action = 'bot.report' ORDER BY id");
  assert.equal(reports.length, 2);
  assert.equal(reports[0].last_error, 'superseded');
  assert.deepEqual([reports[1].ref, reports[1].done_at], ['report', null]);
  // „Checking with the bot…“ bis ein Bericht nach dem Speichern kommt
  let st = await statusJson();
  assert.equal(st.json.bot.state, 'checking');
  assert.equal(st.json.bot.checking, true);
  assert.deepEqual(st.json.bot.line, { text: 'Checking with the bot…', tone: 'warn' });
  assert.deepEqual(st.json.bot.badge, { text: 'Checking', tone: 'warn' });
  const card = botCardOf((await adminPage()).tab);
  assert.match(card, /data-bot-checking="1"/);
  assert.match(card, /data-bot-line>Checking with the bot…</);
  // Der Bot holt den Auftrag ab und schickt seinen Bericht
  const hello = await bot('POST', '/_/bot/hello', report());
  assert.equal(hello.status, 200);
  st = await statusJson();
  assert.equal(st.json.bot.checking, false);
  assert.equal(st.json.bot.state, 'online');
  assert.deepEqual(st.json.bot.line, { text: 'Ready – the bot can post in #changelog.', tone: 'ok' });
  assert.equal(st.json.bot.ready, true);
  assert.equal(st.json.bot.channel, '#changelog');
  // Meldet der Bot danach, dass er dort nicht mehr posten darf, sagt die Karte genau das
  await bot('POST', '/_/bot/hello', report({ channels: [{ id: FORUM, name: 'changelog', type: 'forum', parent_id: '', can_post: false, can_mention_everyone: true, missing: ['ManageThreads', 'EmbedLinks'] }] }));
  st = await statusJson();
  assert.deepEqual(st.json.bot.line, { text: 'The bot can’t post in #changelog: it needs Manage Threads, Embed Links there.', tone: 'err' });
  assert.equal(st.json.bot.ready, false);
});

test('“Use #updates”, turning the bot off (posts it made stay in its care) and on again', async () => {
  await onlineBot();
  // Webhook an, Bot nie gespeichert: der Bot postet nicht von selbst; „Use #updates“ stellt ihn dazu
  await storeSettings(v2({ webhook: { enabled: true, url: hookLink(), hook_channel_id: HOOK_CHANNEL } }));
  let card = botCardOf((await adminPage()).tab);
  assert.match(card, /Updates are posted with the webhook right now\. Choose a channel and save to let the bot post them as well\./);
  assert.match(card, /The bot is ready to post in #updates\./);
  let r = await adminPost({ oys_action: 'discord_bot_save', bot_enabled: '1', bot_channel: UPDATES, bot_mention: '' });
  assert.equal(r.ok, 'Saved – the bot checks #updates now.');
  let { tab } = await adminPage();
  assert.match(tab, /Posting with the bot in #updates and the webhook/);
  assert.doesNotMatch(botCardOf(tab), /Use #updates/, 'no offer once the bot posts there');
  // Ausschalten: Kanal und Ping bleiben; der Bot kümmert sich weiter um seine Beiträge
  await addUpdate(5);
  await addUpdate(6);
  await addPost(5, { message_id: ID(500) });
  await addPost(6, { message_id: ID(600) });
  r = await adminPost({ oys_action: 'discord_bot_save', bot_channel: UPDATES, bot_mention: '' });
  assert.equal(r.ok, 'The bot no longer announces new updates.');
  const s = (await stored())!;
  assert.deepEqual([s.bot.enabled, s.bot.channel_id], [false, UPDATES]);
  ({ tab } = await adminPage());
  card = botCardOf(tab);
  assert.match(card, /data-bot-state="off"/);
  assert.match(card, /The bot doesn’t announce new updates\. It still edits and removes the 2 posts it made\./);
  assert.doesNotMatch(card, /Use #updates|Send test/);
  assert.match(card, /<form action="\/admin" method="POST" id="discordBotOnForm" class="hidden">.*name="bot_enabled" value="1"><input type="hidden" name="bot_channel" value="1300000000000000010">/);
  assert.match(tab, /<span class="text-xs text-gray-500">turned off<\/span>/);
  // Wieder an (der Knopf „Turn on“ sendet genau das)
  r = await adminPost({ oys_action: 'discord_bot_save', bot_enabled: '1', bot_channel: UPDATES, bot_mention: '' });
  assert.equal(r.ok, 'Saved – the bot checks #updates now.');
  assert.equal((await stored())!.bot.enabled, true);
});

// ------------------------------------------------------------------ Test, Bericht

test('discord_bot_test: queued for the bot, replaces an unclaimed test, asks first in a forum, 5 a minute; the result shows up', async () => {
  await onlineBot();
  let r = await adminPost({ oys_action: 'discord_bot_test' });
  assert.equal(r.ok, 'Test message queued – the bot posts it within a few seconds.');
  let tests = await openJobs('update.test');
  assert.equal(tests.length, 1);
  const data = JSON.parse(String(tests[0].payload));
  assert.equal(tests[0].ref, 'test');
  assert.equal(data.channel_id, UPDATES, 'not saved yet: into #updates');
  assert.equal(data.kind, 'announcement');
  assert.equal(data.message.embeds[0].title, 'Discord is connected');
  assert.deepEqual(data.message.allowed_mentions, { parse: [] }, 'a test never pings');
  let meta = JSON.parse(String(await value("SELECT meta_value FROM oys_meta WHERE meta_key = 'discord_bot_test'")));
  assert.deepEqual([meta.state, meta.job_id, meta.channel_id], ['queued', tests[0].id, UPDATES]);
  let st = await statusJson();
  assert.deepEqual(st.json.bot.test, { state: 'queued', text: 'Sending the test through the bot…', tone: 'warn' });
  // Ein zweiter Test ersetzt den ersten, solange der Bot ihn nicht abgeholt hat
  r = await adminPost({ oys_action: 'discord_bot_test' });
  assert.match(String(r.ok), /^Test message queued/);
  tests = await q("SELECT * FROM community_outbox WHERE action = 'update.test' ORDER BY id");
  assert.equal(tests[0].last_error, 'superseded');
  assert.notEqual(tests[0].done_at, null);
  assert.equal(tests[1].done_at, null);
  // Der Bot holt ihn ab und meldet Erfolg
  const out = await bot('GET', '/_/bot/outbox?f=updates.v1');
  const item = (out.json.items as Array<{ id: number; action: string }>).find((i) => i.action === 'update.test')!;
  assert.equal(item.id, tests[1].id);
  assert.equal((await bot('POST', `/_/bot/outbox/${item.id}/done`, { error: '', result: { message_id: ID(700), channel_id: UPDATES } })).status, 200);
  st = await statusJson();
  assert.equal(st.json.bot.test.state, 'ok');
  assert.match(st.json.bot.test.text, /^Test message posted in #updates at \d\d:\d\d\.$/);
  // Ein Fehler des Bots erscheint mit seinem Text
  await adminPost({ oys_action: 'discord_bot_test' });
  const failing = (await openJobs('update.test'))[0];
  await bot('POST', `/_/bot/outbox/${failing.id}/done`, { error: 'The bot can’t post in #updates: it needs Embed Links there.', final: true });
  st = await statusJson();
  assert.deepEqual(st.json.bot.test, { state: 'failed', text: 'The test failed: The bot can’t post in #updates: it needs Embed Links there.', tone: 'err' });
  // Kein Bot antwortet: nach 2 Minuten gilt der Test als verfallen
  await adminPost({ oys_action: 'discord_bot_test' });
  meta = JSON.parse(String(await value("SELECT meta_value FROM oys_meta WHERE meta_key = 'discord_bot_test'")));
  meta.at = date('Y-m-d H:i:s', time() - 130);
  await exec("UPDATE oys_meta SET meta_value = ? WHERE meta_key = 'discord_bot_test'", [JSON.stringify(meta)]);
  st = await statusJson();
  assert.equal(st.json.bot.test.state, 'expired');
  assert.equal(st.json.bot.test.text, 'The bot didn’t answer within 2 minutes – it may be offline. Try again when it shows Online.');
  // Höchstens 5 Tests je Minute und Admin (Webhook und Bot zusammen)
  r = await adminPost({ oys_action: 'discord_bot_test' });
  assert.match(String(r.ok), /^Test message queued/);
  r = await adminPost({ oys_action: 'discord_bot_test' });
  assert.equal(r.error, 'Please wait a minute before sending another test.');
  // Im Forum legt jeder Test einen Beitrag an: nur nach der Rückfrage
  await exec("DELETE FROM rate_limits WHERE rl_key LIKE 'discord%'");
  await storeSettings(v2({ bot: { enabled: true, channel_id: FORUM, channel_type: 'forum', mention: '', saved_at: date('Y-m-d H:i:s') } }));
  const card = botCardOf((await adminPage()).tab);
  assert.match(card, /form="discordBotTestForm"[^>]* data-confirm="Send a test\?" data-confirm-text="In a forum channel each test creates a post “OnYourSite test”\."/);
  assert.match(card, /id="discordBotTestForm" class="hidden">.*name="_confirmed" value="0"/);
  r = await adminPost({ oys_action: 'discord_bot_test' });
  assert.equal(r.error, 'Please confirm the test – in a forum channel it creates a post “OnYourSite test”.');
  r = await adminPost({ oys_action: 'discord_bot_test', _confirmed: '1' });
  assert.match(String(r.ok), /^Test message queued/);
  // Ohne Kanal (gespeichert ohne) gibt es keinen Test
  await storeSettings(v2({ bot: { enabled: false, channel_id: '', saved_at: date('Y-m-d H:i:s') } }));
  assert.equal((await adminPost({ oys_action: 'discord_bot_test' })).error, 'Choose a channel for the bot and save it first – then send a test.');
});

test('discord_bot_refresh: one report job – an unclaimed one is replaced, a dead one closed; an older bot is told what to do', async () => {
  await onlineBot();
  const dead = await addJob('bot.report', 'report', { attempts: 10, last_error: 'boom', claimed_at: date('Y-m-d H:i:s') });
  let r = await adminPost({ oys_action: 'discord_bot_refresh' });
  assert.equal(r.ok, 'The bot sends its channel list within a few seconds.');
  r = await adminPost({ oys_action: 'discord_bot_refresh' });
  const open = await openJobs('bot.report');
  assert.equal(open.length, 1);
  assert.notEqual((await one('SELECT done_at FROM community_outbox WHERE id = ?', [dead]))!.done_at, null);
  await exec("DELETE FROM oys_meta WHERE meta_key = 'discord_bot_report'");
  r = await adminPost({ oys_action: 'discord_bot_refresh' });
  assert.equal(r.ok, 'Checking again – once the bot runs version 0.2.0 or newer, it sends its channel list within a few seconds.');
  useConfig({ bot_secret: '' });
  assert.match(String((await adminPost({ oys_action: 'discord_bot_refresh' })).error), /^The Discord bot isn’t set up/);
});

// ------------------------------------------------------------------ Karte „Discord posts“, Chips, Retry, Forget

test('Discord posts and the chips of the update list: Retry and Forget per state, Forget asks first, back to where the button was', async () => {
  await onlineBot();
  await addUpdate(10, { title: 'Ten' });
  await addUpdate(11, { title: 'Eleven' });
  await addUpdate(12, { title: 'Twelve' });
  const failed = await addPost(10, { state: 'failed', error: 'Not posted: the bot didn’t pick it up within 24 hours.' });
  const dead = await addJob('update.post', 'post:' + failed, { attempts: 10, last_error: 'expired', claimed_at: null });
  const queued = await addPost(11, { state: 'queued' });
  const removeFailed = await addPost(12, { state: 'remove_failed', message_id: ID(1200), error: 'Missing Access (50001)' });
  const gone = await addPost(99, { state: 'remove_failed', message_id: ID(9900), error: 'The update was deleted, but its Discord post is still there.' });
  const { html, tab } = await adminPage();
  // Die Karte nennt jedes Problem, auch das eines gelöschten Updates
  const postsCard = tab.slice(tab.indexOf('id="discordPostsCard"'));
  assert.match(postsCard, /\(deleted update #99\)/);
  assert.match(postsCard, new RegExp(`data-post-row="${failed}"[\\s\\S]*?Bot #updates · [\\s\\S]*?Bot · failed[\\s\\S]*?Not posted: the bot didn’t pick it up within 24 hours\\.`));
  // Chips in der Liste der Updates (statt „On Discord“), mit Retry/Forget je nach Zustand
  const updatesTab = html.slice(html.indexOf('id="tab-updates"'), html.indexOf('id="tab-roadmap"'));
  assert.match(updatesTab, new RegExp(`data-discord-post="${failed}" data-update-id="10" data-state="failed"[^>]*><i class='bx bxl-discord-alt'></i> <span data-chip-label>Bot · failed</span>`));
  assert.match(updatesTab, new RegExp(`data-discord-post="${queued}"[^>]*>.*Bot · posting…`));
  assert.match(updatesTab, new RegExp(`data-discord-post="${removeFailed}"[^>]*>.*Bot · couldn’t remove`));
  assert.match(updatesTab, new RegExp(`<form action="/admin" method="POST" class="m-0" data-post-retry="${failed}">`));
  assert.match(updatesTab, new RegExp(`<form action="/admin" method="POST" class="m-0" data-post-retry="${queued}" hidden>`), 'nothing to retry while queued');
  assert.match(updatesTab, new RegExp(`data-post-forget="${queued}" data-confirm="Forget this post\\?" data-confirm-text="If it is in Discord, it stays there and can’t be edited from here any more\\." data-confirm-ok="Forget" data-confirm-tone="danger" hidden>`), 'forget a queued post only after 10 minutes');
  assert.match(updatesTab, /<input type="hidden" name="back" value="updates">/);
  // Forget ohne Bestätigung ändert nichts (fällt geschlossen aus)
  let r = await adminPost({ oys_action: 'discord_post_forget', id: String(removeFailed), back: 'updates', _confirmed: '0' });
  assert.match(String(r.error), /^Nothing was changed/);
  r = await adminPost({ oys_action: 'discord_post_forget', id: String(removeFailed), back: 'updates' });
  assert.equal(r.error, 'Please confirm forgetting this post.');
  assert.ok(await one('SELECT id FROM update_discord_posts WHERE id = ?', [removeFailed]));
  r = await adminPost({ oys_action: 'discord_post_forget', id: String(removeFailed), back: 'updates', _confirmed: '1' });
  assert.equal(r.ok, 'Forgotten. If the message is in Discord, it stays there.');
  assert.equal(r.location, '/admin#updates');
  assert.equal(await one('SELECT id FROM update_discord_posts WHERE id = ?', [removeFailed]), null);
  // Zu früh: ein Beitrag, den der Bot gerade abarbeitet
  r = await adminPost({ oys_action: 'discord_post_forget', id: String(queued), _confirmed: '1' });
  assert.equal(r.error, 'This post is still being handled – try again in a few minutes.');
  assert.equal(r.location, '/admin#discord');
  // Retry: neu für den Bot eingereiht, der tote Auftrag ist erledigt
  r = await adminPost({ oys_action: 'discord_post_retry', id: String(failed) });
  assert.equal(r.ok, 'Queued for the bot.');
  assert.equal(r.location, '/admin#discord');
  assert.equal((await one('SELECT state FROM update_discord_posts WHERE id = ?', [failed]))!.state, 'queued');
  assert.equal((await one('SELECT last_error FROM community_outbox WHERE id = ?', [dead]))!.last_error, 'retried');
  assert.equal((await q("SELECT id FROM community_outbox WHERE action = 'update.post' AND ref = ? AND done_at IS NULL", ['post:' + failed])).length, 1);
  // Nichts zu wiederholen / nicht mehr da
  assert.equal((await adminPost({ oys_action: 'discord_post_retry', id: String(queued) })).error, 'There is nothing to retry for this post.');
  assert.equal((await adminPost({ oys_action: 'discord_post_retry', id: '987654' })).error, 'This Discord post is no longer listed.');
  assert.equal((await adminPost({ oys_action: 'discord_post_forget', id: 'x', _confirmed: '1' })).error, 'This Discord post is no longer listed.');
  // Ein Beitrag eines gelöschten Updates: Retry entfernt ihn noch einmal
  r = await adminPost({ oys_action: 'discord_post_retry', id: String(gone) });
  assert.equal(r.ok, 'The bot removes its post within a few seconds.');
  assert.equal((await one('SELECT state FROM update_discord_posts WHERE id = ?', [gone]))!.state, 'removing');
});

test('failed bot jobs are listed in the Discord tab, not in the Community banner; dead ones without a post can be dismissed', async () => {
  await onlineBot();
  await addUpdate(20);
  const post = await addPost(20, { state: 'queued' });
  await addJob('update.post', 'post:' + post, { attempts: 3, last_error: 'Discord is down <b>now</b>', claimed_at: date('Y-m-d H:i:s') });
  const notice = await addJob('suggestions.notice', 'notice', { attempts: 10, last_error: 'Missing Permissions', claimed_at: date('Y-m-d H:i:s') });
  const live = await addJob('bot.report', 'report', { attempts: 2, last_error: 'timeout', claimed_at: date('Y-m-d H:i:s') });
  await addJob('ticket.reply', 'ticket:1', { attempts: 10, last_error: 'The ticket channel no longer exists.' });
  const { html, tab } = await adminPage();
  const community = html.slice(html.indexOf('id="tab-community"'));
  assert.match(community, /The bot couldn’t carry out “ticket\.reply” \(10 tries\): The ticket channel no longer exists\./);
  assert.doesNotMatch(community, /couldn’t carry out “(?:update|bot|suggestions)\./, 'Discord jobs are not in the Community banner any more');
  assert.match(tab, /The bot couldn’t post an update \(3 tries\): Discord is down &lt;b&gt;now&lt;\/b&gt; – it tries again\. Use Retry or Forget on it under “Discord posts”\./);
  assert.match(tab, /The bot couldn’t change the note in the #suggestions guidelines \(10 tries\): Missing Permissions – it stopped trying\./);
  assert.match(tab, new RegExp(`name="oys_action" value="discord_job_dismiss"><input type="hidden" name="id" value="${notice}">`));
  assert.doesNotMatch(tab, new RegExp(`name="id" value="${live}"><button[^>]*>.*Dismiss`), 'a job that still runs can’t be dismissed');
  // Der Chip des wartenden Beitrags nennt den letzten Fehlversuch
  assert.match(html, /title="Last try failed \(3 tries\): Discord is down &lt;b&gt;now&lt;\/b&gt; – the bot tries again\."/);
  let r = await adminPost({ oys_action: 'discord_job_dismiss', id: String(notice) });
  assert.equal(r.ok, 'Dismissed – the bot won’t try this again.');
  assert.notEqual((await one('SELECT done_at FROM community_outbox WHERE id = ?', [notice]))!.done_at, null);
  r = await adminPost({ oys_action: 'discord_job_dismiss', id: String(live) });
  assert.equal(r.error, 'This can’t be dismissed – it is done or the bot is still trying.');
  assert.doesNotMatch((await adminPage()).tab, /#suggestions guidelines/);
});

test('the same channel is refused both ways: a webhook into the bot’s channel, the bot into the webhook’s', async () => {
  await onlineBot({ channels: [{ id: HOOK_CHANNEL, name: 'news', type: 'text', parent_id: '', can_post: true, can_mention_everyone: false, missing: [] }], updates_channel_id: HOOK_CHANNEL });
  let r = await adminPost({ oys_action: 'discord_bot_save', bot_enabled: '1', bot_channel: HOOK_CHANNEL });
  assert.equal(r.ok, 'Saved – the bot checks #news now.');
  r = await adminPost({ oys_action: 'discord_webhook_save', webhook_link: hookLink() });
  assert.equal(r.error, 'The bot already posts into this channel – updates would show up twice.');
  assert.equal((await stored())!.webhook.url ?? '', '', 'no webhook stored');
  // Bot aus: der Webhook darf dorthin
  await adminPost({ oys_action: 'discord_bot_save', bot_channel: HOOK_CHANNEL });
  r = await adminPost({ oys_action: 'discord_webhook_save', webhook_link: hookLink() });
  assert.match(String(r.ok), /^Webhook saved and checked/);
  // … und der Bot nicht mehr, solange der Webhook dort postet; „Use #news“ wird gar nicht angeboten (auch nicht für einen
  // Bot, der noch nie gespeichert wurde)
  const s = (await stored())!;
  s.bot = {};
  await storeSettings(s);
  const card = botCardOf((await adminPage()).tab);
  assert.match(card, /Updates are posted with the webhook right now/);
  assert.doesNotMatch(card, /Use #news/);
  r = await adminPost({ oys_action: 'discord_bot_save', bot_enabled: '1', bot_channel: HOOK_CHANNEL });
  assert.match(String(r.error), /^The webhook already posts into this channel/);
});

// ------------------------------------------------------------------ Schutz

test('CSRF and admins only: discord_* without the token or from a user changes nothing', async () => {
  await onlineBot();
  await addUpdate(30);
  const id = await addPost(30, { state: 'failed', error: 'x' });
  const actions: Array<Record<string, string>> = [
    { oys_action: 'discord_bot_save', bot_enabled: '1', bot_channel: UPDATES },
    { oys_action: 'discord_bot_test' },
    { oys_action: 'discord_bot_refresh' },
    { oys_action: 'discord_post_retry', id: String(id) },
    { oys_action: 'discord_post_forget', id: String(id), _confirmed: '1' },
  ];
  for (const form of actions) {
    const noToken = await adminPost(form, { csrf: false });
    assert.equal(noToken.error, 'Session expired – please try again.', form.oys_action);
    assert.equal(noToken.location, '/admin');
    const user = await adminPost(form, { user: 5 });
    assert.equal(user.status, 302);
    assert.equal(user.location, '/dashboard', form.oys_action);
    const impersonating = await adminPost(form, { user: 5, impersonatedBy: 3 });
    assert.equal(impersonating.location, '/dashboard', form.oys_action);
  }
  assert.equal(await stored(), null);
  assert.equal((await q('SELECT id FROM community_outbox')).length, 0);
  assert.equal((await one('SELECT state FROM update_discord_posts WHERE id = ?', [id]))!.state, 'failed');
});

test('names from the bot’s report, update titles and errors are escaped in the tab, the list and the Community card', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  await seen();
  await storeReport({
    version: '0.2.0+x', guild: { id: ID(1), name: evil, community: false },
    channels: [{ id: UPDATES, name: evil, type: 'text', parent_id: ID(2), can_post: true, can_mention_everyone: true, missing: [] }],
    categories: [{ id: ID(2), name: '"><script>alert(2)</script>' }], roles: [{ id: ROLE, name: evil, mentionable: true }],
  });
  await addUpdate(40, { title: '</span><script>alert(3)</script>' });
  const post = await addPost(40, { state: 'failed', error: '<script>alert(4)</script>' });
  const { html } = await adminPage();
  assert.doesNotMatch(html, /<img src=x|<script>alert/);
  assert.match(html, /server “&lt;img src=x onerror=alert\(1\)&gt;”/);
  assert.match(html, /#&lt;img src=x onerror=alert\(1\)&gt; \(&quot;&gt;&lt;script&gt;alert\(2\)&lt;\/script&gt;\)/);
  assert.match(html, new RegExp(`data-discord-post="${post}"[^>]*data-title="&lt;/span&gt;&lt;script&gt;alert\\(3\\)&lt;/script&gt;" title="&lt;script&gt;alert\\(4\\)&lt;/script&gt;"`));
  // Im JSON stehen die Texte unverändert – die Seite setzt sie nur als Text ein (textContent)
  const st = await statusJson('?updates=40');
  assert.equal(st.json.posts[0].update_title, '</span><script>alert(3)</script>');
  assert.match(String(st.headers['content-type']), /^application\/json/);
  // Das Skript, das nachlädt, setzt Texte nie als HTML
  const at = html.indexOf("fetch('/admin/api/discord-status'");
  const script = html.slice(html.lastIndexOf('<script>', at), html.indexOf('</script>', at));
  assert.ok(script.length > 1000);
  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
});

test('Community card: the bot’s version and a link to the Discord settings', async () => {
  await onlineBot({ version: '0.2.1' });
  const { html } = await adminPage();
  const community = html.slice(html.indexOf('id="tab-community"'));
  assert.match(community, /<p class="text-xs text-gray-500 mt-1" data-bot-extra>Version 0\.2\.1 · <a href="#discord" class="text-brand-400 hover:text-white">Discord settings<\/a><\/p>/);
  await exec("DELETE FROM oys_meta WHERE meta_key = 'discord_bot_report'");
  assert.match((await adminPage()).html, /data-bot-extra><a href="#discord"/, 'without a report: only the link');
});

test('saving at the same time: nothing is lost, and the same channel can’t slip in while Discord checks the webhook', async () => {
  await onlineBot({ channels: [
    { id: HOOK_CHANNEL, name: 'news', type: 'text', parent_id: '', can_post: true, can_mention_everyone: false, missing: [] },
    { id: UPDATES, name: 'updates', type: 'announcement', parent_id: '', can_post: true, can_mention_everyone: false, missing: [] },
  ] });
  // Discord antwortet erst nach 1,5 s; währenddessen speichern Bot und Vorgaben – alles bleibt erhalten
  discord.delayNext(1500);
  const later = (ms: number, form: Record<string, string>) => new Promise((r) => setTimeout(r, ms)).then(() => adminPost(form));
  const [hook, botSaved, defaults] = await Promise.all([
    adminPost({ oys_action: 'discord_webhook_save', webhook_link: hookLink() }),
    later(200, { oys_action: 'discord_bot_save', bot_enabled: '1', bot_channel: UPDATES }),
    later(300, { oys_action: 'discord_defaults_save', invite_url: 'https://discord.gg/both', auto_post: '1' }),
  ]);
  assert.match(String(hook.ok), /^Webhook saved and checked/);
  assert.equal(botSaved.ok, 'Saved – the bot checks #updates now.');
  assert.equal(defaults.ok, 'Discord settings saved.');
  let s = (await stored())!;
  assert.deepEqual([s.webhook.enabled, s.webhook.hook_channel_id, s.bot.enabled, s.bot.channel_id, s.invite_url], [true, HOOK_CHANNEL, true, UPDATES, 'https://discord.gg/both']);
  // Der Bot wechselt in den Kanal des Webhooks, während Discord den Webhook noch einmal prüft: der Webhook unterliegt
  await adminPost({ oys_action: 'discord_webhook_remove', _confirmed: '1' });
  discord.restart();
  discord.delayNext(1500);
  const [again, botMoved] = await Promise.all([
    adminPost({ oys_action: 'discord_webhook_save', webhook_link: hookLink() }),
    later(200, { oys_action: 'discord_bot_save', bot_enabled: '1', bot_channel: HOOK_CHANNEL }),
  ]);
  assert.equal(botMoved.ok, 'Saved – the bot checks #news now.');
  assert.equal(again.error, 'The bot already posts into this channel – updates would show up twice.');
  s = (await stored())!;
  assert.deepEqual([s.webhook.enabled ?? false, s.bot.channel_id], [false, HOOK_CHANNEL]);
});
