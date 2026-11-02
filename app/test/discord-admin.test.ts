// Admin → Discord mit Datenbank und Discord-Ersatz: über den ganzen Admin-Weg (CSRF, Weiterleitung, Meldung in der
// Sitzung). Webhook speichern (Prüfung bei Discord, Fehler von Discord, nicht erreichbar), Regeln der Felder, Foren und
// Threads, alte Formulare, Rate-Limits, alter Bot-Token, Vorgaben – und Updates in Discord (Foren, Threads, Fehler,
// doppelte Klicks). Die Schleife aus DECISIONS.md Q13 steht als Browser-Test in e2e/discord-settings.e2e.ts.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { configString, loadConfig, setConfigForTests, type ConfigData } from '../src/config.js';
import { closePool, exec, one, q, value, withConnection } from '../src/db.js';
import { convertLegacyPosts, ensureSchema } from '../src/schema.js';
import { decryptData, encryptData } from '../src/crypto.js';
import { isHalt, makeTestCtx, type Ctx } from '../src/web/ctx.js';
import { Session } from '../src/web/session.js';
import { adminPage } from '../src/admin/page.js';
import { UNCONFIRMED_MESSAGE } from '../src/views/partials/ui.js';
import { appRoutes } from '../src/app/dispatch.js';
import { adminUpdatesHandle, ALREADY_POSTING } from '../src/updates/admin.js';
import { adminUpdatesView } from '../src/updates/adminView.js';
import { OUT_OF_DATE } from '../src/discord/admin.js';
import { GOOD_TOKEN, startStandIn, type DiscordStandIn } from './fixtures/discord/standIn.js';

const BASE = loadConfig();
const SOURCE = configString('db.name');
const DB = SOURCE + '_dsc';
let root: Connection;
let discord: DiscordStandIn;

const token = (seed: string): string => (seed + 'Qz7_-').repeat(12).slice(0, 68);
const link = (id: string): string => `${discord.base}/webhooks/${id}/${token('k' + id.slice(-2))}`;
const HOOK = '1301234567890123456';
const FORUM = '1551234567890123456';
const CHANNEL = '1301234567890120000';

function useConfig(extra: ConfigData = {}): void {
  setConfigForTests({ ...BASE, db: { ...(BASE.db as Record<string, string>), name: DB }, discord_api_base: discord.base, ...extra });
}

before(async () => {
  discord = await startStandIn();
  root = await mysql.createConnection({ host: configString('db.host', 'localhost'), user: configString('db.user', ''), password: configString('db.pass', ''), charset: 'utf8mb4_unicode_ci' });
  const [tables] = await root.query<RowDataPacket[]>(`SHOW TABLES FROM \`${SOURCE}\``);
  await root.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await root.query(`CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  for (const row of tables) {
    const t = String(Object.values(row)[0]);
    await root.query(`CREATE TABLE \`${DB}\`.\`${t}\` LIKE \`${SOURCE}\`.\`${t}\``);
    await root.query(`INSERT INTO \`${DB}\`.\`${t}\` SELECT * FROM \`${SOURCE}\`.\`${t}\``);
  }
  await closePool();
  useConfig();
  // Die Kopie auf den Stand dieses Codes bringen (die Quelle ist nach pkg-env.sh noch nicht migriert)
  await ensureSchema();
});

after(async () => {
  await closePool();
  setConfigForTests(BASE);
  await root.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await root.end();
  await discord.close();
});

beforeEach(async () => {
  useConfig();
  discord.restart();
  await exec("DELETE FROM oys_meta WHERE meta_key IN ('discord', 'bot_last_seen')");
  await exec("DELETE FROM rate_limits WHERE rl_key LIKE 'discord%'");
  await exec('DELETE FROM updates');
  await exec('DELETE FROM update_discord_posts');
  await exec('DELETE FROM community_outbox');
  await exec("DELETE FROM oys_meta WHERE meta_key = 'discord_bot_report'");
});

async function store(settings: Record<string, unknown> | null): Promise<void> {
  if (settings === null) await exec("DELETE FROM oys_meta WHERE meta_key = 'discord'");
  else await exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('discord', ?)", [encryptData(JSON.stringify(settings)) ?? null]);
}
// Gespeicherte Einstellungen (Form v2: webhook, bot, alter Token oben)
interface Stored { v: number; auto_post: boolean; invite_url: string; webhook: Record<string, unknown>; bot: Record<string, unknown>; bot_token: string; channel_id: string; mention: string }
async function stored(): Promise<Stored | null> {
  const raw = await value("SELECT meta_value FROM oys_meta WHERE meta_key = 'discord'");
  return raw === null ? null : (JSON.parse(String(decryptData(String(raw)))) as Stored);
}
const storedHook = async (): Promise<Record<string, unknown>> => (await stored())?.webhook ?? {};
// Der Beitrag eines Updates an einem Ziel (update_discord_posts)
async function postRow(updateId: number, via = 'webhook'): Promise<Record<string, unknown> | null> {
  return one('SELECT * FROM update_discord_posts WHERE update_id = ? AND via = ?', [updateId, via]);
}

interface Result { status: number; location: string; ok?: string; error?: string; field?: string; keep?: Record<string, string>; ctx: Ctx }

// POST /admin wie über den Server (Sitzung des Admins mit id 3)
async function post(form: Record<string, unknown>, opts: { csrf?: boolean; userId?: number } = {}): Promise<Result> {
  const csrf = 'c'.repeat(64);
  const pre = makeTestCtx({ url: '/admin' });
  const s = await Session.start(pre);
  s.set('user_id', opts.userId ?? 3);
  s.set('csrf', csrf);
  await s.close();
  const ctx = makeTestCtx({ method: 'POST', url: '/admin', cookies: { PHPSESSID: s.id }, post: opts.csrf === false ? form : { csrf, ...form } });
  await Session.start(ctx);
  const user = (await one('SELECT * FROM users WHERE id = 3'))!;
  try {
    await adminPage(ctx, user);
  } catch (err) {
    if (!isHalt(err)) throw err;
  } finally {
    await ctx.session?.close();
  }
  const data = ctx.session!.data;
  return {
    status: ctx.status, location: String(ctx.header('Location') ?? ''), ctx,
    ok: data.admin_success as string | undefined, error: data.admin_error as string | undefined,
    field: data.discord_error_field as string | undefined, keep: data.discord_keep as Record<string, string> | undefined,
  };
}

const save = (fields: Record<string, unknown>): Promise<Result> => post({ oys_action: 'discord_webhook_save', ...fields });
const calls = (method: string, part: string) => discord.calls().filter((c) => c.method === method && c.path.includes(part));

test('saving a webhook checks it with Discord (GET, nothing posted) and stores it encrypted', async () => {
  const r = await save({ webhook_link: '  ' + link(HOOK) + '?wait=true\n', display_name: '  OnYourSite News ', mention: '@here', avatar_url: 'https://x.y/logo.png' });
  assert.equal(r.status, 302);
  assert.equal(r.location, '/admin#discord');
  assert.equal(r.ok, 'Webhook saved and checked – Discord knows it as “Captain Hook” (channel 1200000000000000001).');
  assert.equal(calls('GET', '/webhooks/' + HOOK + '/').length, 1);
  assert.equal(calls('POST', '/webhooks/').length, 0, 'saving posts nothing');
  assert.match(String(await value("SELECT meta_value FROM oys_meta WHERE meta_key = 'discord'")), /^ENC:/);
  const st = await stored();
  assert.equal(st?.v, 2);
  const s = st!.webhook;
  assert.equal(s.enabled, true);
  assert.equal(s.url, link(HOOK), 'stored without the query');
  assert.equal(s.display_name, 'OnYourSite News');
  assert.equal(s.mention, 'here');
  assert.equal(s.hook_name, 'Captain Hook');
  assert.equal(s.hook_guild_id, '1100000000000000001');
  assert.match(String(s.checked_at), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  // Ohne neuen Link wird der gespeicherte noch einmal geprüft
  const again = await save({ display_name: 'Other' });
  assert.match(String(again.ok), /^Webhook saved and checked/);
  assert.equal(calls('GET', '/webhooks/' + HOOK + '/').length, 2);
  assert.equal((await storedHook()).url, link(HOOK));
});

test('Discord’s refusal is shown with its own message and nothing is stored', async () => {
  const unknown = await save({ webhook_link: link('4041234567890123456') });
  assert.equal(unknown.error, 'Discord doesn’t know this webhook – it was deleted or the link is incomplete. Copy it again in Discord (channel settings → Integrations → Webhooks). Discord said: “Unknown Webhook” (10015).');
  assert.equal(unknown.field, 'webhook_link');
  const badToken = await save({ webhook_link: link('4011234567890123456') });
  assert.equal(badToken.error, 'Discord doesn’t accept this webhook link any more. Copy it again in Discord (channel settings → Integrations → Webhooks). Discord said: “Invalid Webhook Token” (50027).');
  assert.equal(await stored(), null);
  // Ein schon gespeicherter Webhook bleibt, wenn der neue Link abgelehnt wird
  await save({ webhook_link: link(HOOK) });
  await save({ webhook_link: link('4041234567890123456') });
  assert.equal((await storedHook()).url, link(HOOK));
});

test('Discord not reachable or busy: the webhook is saved with a warning and marked as not checked', async () => {
  const port = await new Promise<number>((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
  const closed = `http://127.0.0.1:${port}/api`;
  useConfig({ discord_api_base: closed });
  const r = await save({ webhook_link: `${closed}/webhooks/${HOOK}/${token('cl')}` });
  assert.equal(r.error, 'Webhook saved, but Discord couldn’t be asked right now – couldn’t reach Discord (connection refused). Use “Send test” to try it.');
  const s = await storedHook();
  assert.equal(s.url, `${closed}/webhooks/${HOOK}/${token('cl')}`);
  assert.equal(s.check_error, 'Couldn’t reach Discord (connection refused).');
  assert.equal(s.checked_at, '');
  useConfig();
  await store(null);
  const busy = await save({ webhook_link: link('4291234567890123456') });
  assert.equal(busy.error, 'Webhook saved, but Discord couldn’t be asked right now – Discord is rate limiting us – try again in 3 s. Use “Send test” to try it.');
  await store(null);
  discord.failNext(500);
  const broken = await save({ webhook_link: link(HOOK) });
  assert.equal(broken.error, 'Webhook saved, but Discord couldn’t be asked right now – Discord had a problem (500) – please try again in a moment. Use “Send test” to try it.');
});

// DECISIONS.md Q13, der Pflichttest über HTTP: vom Stand des Besitzers aus (Bot-Modus gespeichert, kein Token, kein
// Webhook) in jeder Reihenfolge – Link einfügen und speichern, eine Kanal-ID allein, von Discord abgelehnte Links.
// Keine der beiden alten Meldungen erscheint je.
test('Q13 loop: from the owner’s state, in every order of the steps, nothing loops and every message says what is missing', async () => {
  const OLD = [/a token and a channel ID/i, /a webhook link or bot/i, /for the bot/i];
  const owner = { mode: 'bot', webhook_url: '', bot_token: '', channel_id: '', mention: '', username: '', avatar_url: '', invite_url: '', auto_post: true };
  const texts: string[] = [];
  const said = (r: Result): string => {
    const t = String(r.ok ?? r.error ?? '');
    texts.push(t);
    return t;
  };
  // Abgelehnte Schritte ändern nichts am Gespeicherten
  const unchanged = async (step: () => Promise<void>): Promise<void> => {
    const before = await stored();
    await step();
    assert.deepEqual(await stored(), before);
  };
  const steps: Record<string, () => Promise<void>> = {
    link: async () => {
      assert.match(said(await save({ webhook_link: link(HOOK) })), /^Webhook saved and checked – Discord knows it as “Captain Hook”/);
      const s = await storedHook();
      assert.equal(s.enabled, true);
      assert.equal(s.url, link(HOOK));
      assert.equal(said(await post({ oys_action: 'discord_webhook_test' })), 'Test message sent – check your Discord channel.');
    },
    channelIdAlone: () => unchanged(async () => {
      // Die Kanal-ID im einzigen Feld für den Link, als Kanal-Link und über das alte Formular
      assert.equal(said(await save({ webhook_link: CHANNEL })), 'That’s a channel ID – posting with a webhook needs the webhook’s link instead. In Discord: channel settings → Integrations → Webhooks → Copy Webhook URL.');
      assert.equal(said(await save({ webhook_link: 'https://discord.com/channels/' + CHANNEL + '/' + CHANNEL })), 'That’s a link to a channel – posting with a webhook needs the webhook’s link instead. In Discord: channel settings → Integrations → Webhooks → Copy Webhook URL.');
      assert.equal(said(await post({ oys_action: 'discord_save', mode: 'bot', channel_id: CHANNEL })), OUT_OF_DATE);
    }),
    refused: () => unchanged(async () => {
      assert.match(said(await save({ webhook_link: link('4041234567890123456') })), /^Discord doesn’t know this webhook.* Discord said: “Unknown Webhook” \(10015\)\.$/);
      assert.match(said(await save({ webhook_link: link('4011234567890123456') })), /^Discord doesn’t accept this webhook link any more\..* Discord said: “Invalid Webhook Token” \(50027\)\.$/);
    }),
  };
  const orders = (names: string[]): string[][] => (names.length <= 1 ? [names] : names.flatMap((n) => orders(names.filter((x) => x !== n)).map((rest) => [n, ...rest])));
  for (const order of orders(Object.keys(steps))) {
    await store(owner);
    await exec("DELETE FROM rate_limits WHERE rl_key LIKE 'discord%'");
    discord.restart();
    for (const name of order) await steps[name]();
    // Am Ende postet der Webhook – egal, was vorher oder danach versucht wurde
    const s = await storedHook();
    assert.equal(s.url, link(HOOK), order.join(' → '));
    assert.ok(discord.calls().some((c) => c.method === 'POST' && c.path.includes('/webhooks/' + HOOK + '/')), order.join(' → '));
  }
  assert.ok(texts.length >= 6 * 6);
  for (const t of texts) for (const old of OLD) assert.doesNotMatch(t, old);
});

test('a display name stored before the fix that Discord refuses (A4: the login e-mail) is not sent any more', async () => {
  await store({ mode: 'bot', webhook_url: link(HOOK), bot_token: '', channel_id: '', mention: '', username: 'admin@test.de', avatar_url: 'https://x.y/a.png', invite_url: '', auto_post: true });
  assert.equal((await post({ oys_action: 'discord_webhook_test' })).ok, 'Test message sent – check your Discord channel.');
  await exec("INSERT INTO updates (id, title, body, version, category, is_published, published_at, discord_announce, created_at, updated_at) VALUES (3, 'Name check', '', '', 'new', 1, NOW(), 1, NOW(), NOW())");
  assert.equal((await adminUpdatesHandle({ oys_action: 'update_discord', id: '3' }))?.ok, 'Posted to Discord.');
  const posts = calls('POST', '/webhooks/' + HOOK + '/');
  assert.equal(posts.length, 2);
  for (const p of posts) {
    assert.equal((p.body as Record<string, unknown>).username, undefined, 'the refused name is left out – Discord uses the webhook’s own name');
    assert.equal((p.body as Record<string, unknown>).avatar_url, 'https://x.y/a.png');
  }
  // Beim Umwandeln in die neue Form fällt der Name weg; das Formular zeigt ein leeres Feld
  const view = makeTestCtx({ url: '/admin' });
  await Session.start(view);
  const html = await adminUpdatesView(view);
  await view.session?.close();
  assert.match(html, /name="display_name"[^>]*value=""/);
  assert.ok(!html.includes('admin@test.de'));
  // Ein Name, den Discord ablehnt, kann auch in v2 nicht gesendet werden (falls er von Hand gespeichert wurde)
  await store({ v: 2, auto_post: true, invite_url: '', bot: {}, webhook: { enabled: true, url: link(HOOK), display_name: 'admin@test.de' }, bot_token: '', channel_id: '', mention: '' });
  discord.restart();
  assert.equal((await post({ oys_action: 'discord_webhook_test' })).ok, 'Test message sent – check your Discord channel.');
  assert.equal((calls('POST', '/webhooks/' + HOOK + '/')[0].body as Record<string, unknown>).username, undefined);
  const view2 = makeTestCtx({ url: '/admin' });
  await Session.start(view2);
  const html2 = await adminUpdatesView(view2);
  await view2.session?.close();
  assert.match(html2, /name="display_name"[^>]*value="admin@test.de"[^>]*ring-1 ring-red-500/);
  assert.ok(html2.includes('Display name: Discord doesn’t allow “@” in names. It isn’t sent until you change it.'));
});

test('a slow check with Discord doesn’t undo what was saved meanwhile', async () => {
  await save({ webhook_link: link(HOOK) });
  discord.restart();
  // Discord antwortet erst nach 1,5 s; das Speichern der Vorgaben läuft währenddessen ganz durch
  discord.delayNext(1500);
  const [check, defaults] = await Promise.all([
    save({ display_name: 'News' }),
    new Promise((r) => setTimeout(r, 200)).then(() => post({ oys_action: 'discord_defaults_save', invite_url: 'https://discord.gg/new', auto_post: '' })),
  ]);
  assert.match(String(check.ok), /^Webhook saved and checked/);
  assert.equal(defaults.ok, 'Discord settings saved.');
  const s = await stored();
  assert.equal(s?.webhook.display_name, 'News');
  assert.equal(s?.invite_url, 'https://discord.gg/new', 'the invite link saved during the check stays');
  assert.equal(s?.auto_post, false);
});

test('values kept after an error are bounded – a huge field never goes into the session', async () => {
  const huge = 'x'.repeat(300000);
  const r = await save({ webhook_link: 'nonsense', display_name: huge, avatar_url: huge, mention: huge, thread_id: huge, post_in: 'thread' });
  assert.equal(r.field, 'webhook_link');
  for (const [name, v] of Object.entries(r.keep ?? {})) assert.ok(v.length <= 500, `${name}: ${v.length}`);
});

test('updates through the old bot token: posted, edited and removed in its channel, under the bot’s own name', async () => {
  await store({ mode: 'bot', webhook_url: '', bot_token: GOOD_TOKEN, channel_id: CHANNEL, mention: 'here', username: 'Ignored', avatar_url: '', invite_url: '', auto_post: true });
  await exec("INSERT INTO updates (id, title, body, version, category, is_published, published_at, discord_announce, created_at, updated_at) VALUES (5, 'Token news', 'Text', '', 'new', 1, NOW(), 1, NOW(), NOW())");
  discord.restart();
  assert.equal((await adminUpdatesHandle({ oys_action: 'update_discord', id: '5' }))?.ok, 'Posted to Discord.');
  const [sent] = calls('POST', '/channels/' + CHANNEL + '/messages');
  assert.equal(sent.auth, 'Bot ' + GOOD_TOKEN);
  assert.equal((sent.body as Record<string, unknown>).content, '@here');
  assert.equal((sent.body as Record<string, unknown>).username, undefined);
  const row = (await postRow(5, 'token'))!;
  assert.equal(row.target, 'bot:' + CHANNEL);
  assert.equal(row.state, 'posted');
  assert.equal(row.legacy, 1);
  // Die alten Spalten schreibt Node nicht mehr
  assert.equal((await one('SELECT discord_message_id FROM updates WHERE id = 5'))!.discord_message_id, null);
  assert.equal((await adminUpdatesHandle({ oys_action: 'update_save', id: '5', title: 'Token news, edited', body: 'New', category: 'new', publish: '1' }))?.ok, 'Update published. The Discord post was updated too.');
  const [edit] = calls('PATCH', '/channels/' + CHANNEL + '/messages/' + row.message_id);
  assert.equal(edit.auth, 'Bot ' + GOOD_TOKEN);
  assert.equal((edit.body as Record<string, unknown>).content, undefined, 'an edit never pings again');
  assert.equal((await adminUpdatesHandle({ oys_action: 'update_publish', id: '5', state: '' }))?.ok, 'Moved back to drafts and removed from Discord.');
  assert.equal(calls('DELETE', '/channels/' + CHANNEL + '/messages/' + row.message_id).length, 1);
  assert.equal(await postRow(5, 'token'), null);
});

test('every field rule names the field, keeps the other values and never calls Discord', async () => {
  const cases: Array<[Record<string, unknown>, string, string]> = [
    [{}, 'Webhook link is missing – in Discord: channel settings → Integrations → Webhooks → Copy Webhook URL, then paste it here.', 'webhook_link'],
    [{ webhook_link: 'https://discord.com/channels/1/2' }, 'That’s a link to a channel – posting with a webhook needs the webhook’s link instead. In Discord: channel settings → Integrations → Webhooks → Copy Webhook URL.', 'webhook_link'],
    [{ webhook_link: 'https://example.com/hook' }, 'That isn’t a Discord webhook link. In Discord: channel settings → Integrations → Webhooks → Copy Webhook URL.', 'webhook_link'],
    // A4: die Login-Adresse als Name – früher gespeichert, dann scheiterte jeder Beitrag mit „Invalid Form Body“
    [{ webhook_link: link(HOOK), display_name: 'admin@test.de' }, 'Display name: Discord doesn’t allow “@” in names.', 'display_name'],
    [{ webhook_link: link(HOOK), display_name: 'x'.repeat(81) }, 'Display name: at most 80 characters.', 'display_name'],
    [{ webhook_link: link(HOOK), mention: 'someone' }, 'Ping: enter a role ID, “everyone” or “here” – or leave it empty.', 'mention'],
    [{ webhook_link: link(HOOK), post_in: 'thread' }, 'Thread ID is missing – in Discord turn on Developer Mode, right-click the thread → Copy Thread ID.', 'thread_id'],
    [{ webhook_link: link(HOOK), post_in: 'thread', thread_id: '12abc' }, 'Thread ID: in Discord turn on Developer Mode, right-click the thread → Copy Thread ID.', 'thread_id'],
    [{ webhook_link: link(HOOK), avatar_url: 'http://x.y/a.png' }, 'Avatar image link: use an https:// link to an image – or leave it empty.', 'avatar_url'],
  ];
  for (const [fields, message, field] of cases) {
    const r = await save({ display_name: 'Kept', ...fields });
    assert.equal(r.error, message);
    assert.equal(r.field, field);
    assert.equal(r.keep?.display_name, fields.display_name === undefined ? 'Kept' : String(fields.display_name).slice(0, 1000));
    assert.equal(Object.values(r.keep ?? {}).some((v) => v.includes('/webhooks/')), false, 'the link is never kept');
  }
  assert.equal(discord.calls().length, 0);
  assert.equal(await stored(), null);
  // Die nächste Anzeige markiert das Feld und zeigt die Werte (einmal)
  const r = await save({ webhook_link: link(HOOK), display_name: 'admin@test.de', post_in: 'thread', thread_id: '1401234567890123456' });
  const view = makeTestCtx({ url: '/admin', cookies: { PHPSESSID: r.ctx.session!.id } });
  await Session.start(view);
  const html = await adminUpdatesView(view);
  await view.session?.close();
  assert.match(html, /name="display_name"[^>]*value="admin@test.de"[^>]*ring-1 ring-red-500/);
  assert.match(html, /name="post_in" value="thread" class="mt-1 accent-\[#5865F2\]" checked/);
  assert.match(html, /name="thread_id"[^>]*value="1401234567890123456"/);
  assert.ok(!html.includes(token('k' + HOOK.slice(-2))), 'the link is not in the page');
});

test('A1/A2: fields of the old form or of another form have no effect', async () => {
  // Werte, die ein Passwort-Manager in versteckte Felder füllen würde, und die alten Feldnamen
  const r = await save({ webhook_link: link(HOOK), webhook_url: 'admin@test.de', bot_token: 'hunter2', channel_id: '123', username: 'admin@test.de', mode: 'bot', invite_url: 'x' });
  assert.match(String(r.ok), /^Webhook saved and checked/);
  const s = await stored();
  assert.equal(s?.webhook.enabled, true);
  assert.equal(s?.bot_token, '');
  assert.equal(s?.channel_id, '');
  assert.equal(s?.webhook.display_name, '');
  assert.equal(s?.invite_url, '');
  // Die Vorgaben ändern den Webhook nicht
  await post({ oys_action: 'discord_defaults_save', webhook_link: link('1309999999999999999'), auto_post: '1' });
  assert.equal((await storedHook()).url, link(HOOK));
  // Das alte gemeinsame Formular ändert nichts mehr
  for (const action of ['discord_save', 'discord_test', 'discord_disconnect']) {
    const before = await stored();
    const old = await post({ oys_action: action, mode: 'bot', channel_id: CHANNEL, webhook_url: link('1308888888888888888') });
    assert.equal(old.error, OUT_OF_DATE);
    assert.deepEqual(await stored(), before);
  }
});

test('CSRF and access: without the token nothing changes; non-admins never reach the admin', async () => {
  const r = await post({ oys_action: 'discord_webhook_save', webhook_link: link(HOOK) }, { csrf: false });
  assert.equal(r.error, 'Session expired – please try again.');
  assert.equal(await stored(), null);
  assert.equal(discord.calls().length, 0);
  // Mia (id 5) ist kein Admin
  const pre = makeTestCtx({ url: '/admin' });
  const s = await Session.start(pre);
  s.set('user_id', 5);
  s.set('csrf', 'c'.repeat(64));
  await s.close();
  const ctx = makeTestCtx({ method: 'POST', url: '/admin', cookies: { PHPSESSID: s.id }, post: { csrf: 'c'.repeat(64), oys_action: 'discord_webhook_save', webhook_link: link(HOOK) } });
  try {
    await appRoutes(ctx);
  } catch (err) {
    if (!isHalt(err)) throw err;
  } finally {
    await ctx.session?.close();
  }
  assert.equal(ctx.status, 302);
  assert.equal(ctx.header('Location'), '/dashboard');
  assert.equal(await stored(), null);
});

test('forum webhook: updates become forum posts; edits and removal reach them through ?thread_id=', async () => {
  // Im Kanal-Modus sagt der Fehler, was zu tun ist (Discord: 220001)
  await save({ webhook_link: link(FORUM) });
  let t = await post({ oys_action: 'discord_webhook_test' });
  assert.equal(t.error, 'This webhook belongs to a forum channel. Choose “As a new forum post for each update” or “In a thread”, then save again.');
  await save({ post_in: 'forum' });
  await exec("INSERT INTO updates (id, title, body, version, category, is_published, published_at, discord_announce, created_at, updated_at) VALUES (1, 'Own pages', 'Text', '2.5', 'new', 1, NOW(), 1, NOW(), NOW())");
  discord.restart();
  const r = await post({ oys_action: 'update_discord', id: '1' });
  assert.equal(r.ok, 'Posted to Discord.');
  const [created] = calls('POST', '/webhooks/' + FORUM + '/');
  assert.equal((created.body as { thread_name: string }).thread_name, '2.5 – Own pages');
  const row = (await postRow(1))!;
  assert.equal(row.target, 'webhook:' + FORUM);
  assert.equal(row.kind, 'forum_post');
  assert.equal(row.channel_id, row.message_id, 'a forum post’s thread has the ID of its first message');
  await post({ oys_action: 'update_save', id: '1', title: 'Own pages, edited', body: 'New', version: '2.5', category: 'new', publish: '1' });
  const [edit] = calls('PATCH', '/webhooks/' + FORUM + '/');
  assert.ok(edit.path.endsWith('?thread_id=' + row.message_id));
  assert.equal((edit.body as Record<string, unknown>).thread_name, undefined);
  const removed = await post({ oys_action: 'update_discord_remove', id: '1' });
  assert.equal(removed.ok, 'Removed from Discord.');
  assert.ok(calls('DELETE', '/webhooks/' + FORUM + '/')[0].path.endsWith('?thread_id=' + row.message_id));
  // Test-Beitrag: erst nach Bestätigung, danach in denselben Beitrag; ist er weg, fragt der nächste Test neu
  t = await post({ oys_action: 'discord_webhook_test', _confirmed: '0' });
  // Unbestätigt fängt schon der gemeinsame Schutz des Admin-Bereichs die Sendung ab
  assert.equal(t.error, UNCONFIRMED_MESSAGE);
  t = await post({ oys_action: 'discord_webhook_test', _confirmed: '1' });
  assert.equal(t.ok, 'Test message sent – check your Discord channel.');
  const testThread = String((await storedHook()).test_thread_id);
  assert.match(testThread, /^\d{19}$/);
  t = await post({ oys_action: 'discord_webhook_test' });
  assert.equal(t.ok, 'Test message sent – check your Discord channel.');
  assert.ok(calls('POST', '/webhooks/' + FORUM + '/').at(-1)!.path.endsWith('&thread_id=' + testThread));
  const cur = (await stored())!;
  await store({ ...cur, webhook: { ...cur.webhook, test_thread_id: '4041234567890123456' } });
  t = await post({ oys_action: 'discord_webhook_test' });
  assert.equal(t.error, 'The earlier test post was deleted in Discord – send the test again to create a new one.');
  assert.equal((await storedHook()).test_thread_id, '');
});

test('thread: not verified until the first post into it works; a link with ?thread_id= chooses it', async () => {
  const r = await save({ webhook_link: link(HOOK) + '?thread_id=1401234567890123456' });
  assert.equal(r.ok, 'Webhook saved and checked – Discord knows it as “Captain Hook” (channel 1200000000000000001). The thread is checked with the first post into it.');
  let s = await storedHook();
  assert.equal(s.post_in, 'thread');
  assert.equal(s.thread_id, '1401234567890123456');
  assert.equal(s.thread_verified, false);
  const t = await post({ oys_action: 'discord_webhook_test' });
  assert.equal(t.ok, 'Test message sent – check your Discord channel.');
  assert.ok(calls('POST', '/webhooks/' + HOOK + '/')[0].path.endsWith('?wait=true&thread_id=1401234567890123456'));
  s = await storedHook();
  assert.equal(s.thread_verified, true);
  // Unverändert gespeichert bleibt er bestätigt, ein anderer Thread nicht
  await save({ post_in: 'thread', thread_id: '1401234567890123456' });
  assert.equal((await storedHook()).thread_verified, true);
  await save({ post_in: 'thread', thread_id: '1401234567890129999' });
  assert.equal((await storedHook()).thread_verified, false);
  const bad = await (async () => {
    await save({ post_in: 'thread', thread_id: '4041234567890123456' });
    return post({ oys_action: 'discord_webhook_test' });
  })();
  assert.equal(bad.error, 'Discord can’t find this channel or thread – it may have been deleted. Discord said: “Unknown Channel” (10003).');
});

test('tests are limited to 5 a minute per admin, checks to 10', async () => {
  await save({ webhook_link: link(HOOK) });
  for (let i = 0; i < 5; i++) assert.equal((await post({ oys_action: 'discord_webhook_test' })).ok, 'Test message sent – check your Discord channel.');
  assert.equal((await post({ oys_action: 'discord_webhook_test' })).error, 'Please wait a minute before sending another test.');
  assert.equal(calls('POST', '/webhooks/').length, 5);
  for (let i = 0; i < 9; i++) assert.match(String((await save({})).ok), /^Webhook saved/);
  assert.equal((await save({})).error, 'Too many checks with Discord – please wait a minute and save again.');
  // Ein anderer Admin hat sein eigenes Kontingent
  await exec('UPDATE users SET is_admin = 1 WHERE id = 6');
  assert.equal((await post({ oys_action: 'discord_webhook_test' }, { userId: 6 })).ok, 'Test message sent – check your Discord channel.');
  await exec('UPDATE users SET is_admin = 0 WHERE id = 6');
});

test('no webhook yet: the test says what to do; removing needs the confirmation', async () => {
  assert.equal((await post({ oys_action: 'discord_webhook_test' })).error, 'There is no webhook to test yet – paste a webhook link under “Post with a webhook” and save it.');
  await save({ webhook_link: link(HOOK) });
  assert.equal((await post({ oys_action: 'discord_webhook_remove', _confirmed: '0' })).error, UNCONFIRMED_MESSAGE);
  assert.equal((await storedHook()).url, link(HOOK));
  assert.equal((await post({ oys_action: 'discord_webhook_remove', _confirmed: '1' })).ok, 'Webhook removed. Its earlier posts stay in Discord.');
  assert.equal((await storedHook()).url, '');
  assert.equal((await storedHook()).enabled, false);
  assert.equal((await post({ oys_action: 'discord_webhook_remove', _confirmed: '1' })).error, 'There is no webhook to remove.');
});

test('the old bot token keeps posting until a webhook is saved or it is deleted; no new token is accepted', async () => {
  const legacy = { mode: 'bot', webhook_url: '', bot_token: GOOD_TOKEN, channel_id: CHANNEL, mention: '', username: '', avatar_url: '', invite_url: '', auto_post: true };
  await store(legacy);
  const t = await post({ oys_action: 'discord_token_test' });
  assert.equal(t.ok, 'Test message sent – check your Discord channel.');
  const [sent] = calls('POST', '/channels/' + CHANNEL + '/messages');
  assert.equal(sent.auth, 'Bot ' + GOOD_TOKEN);
  assert.equal((sent.body as Record<string, unknown>).username, undefined, 'a bot posts under its own name');
  // Ein neuer Token kommt über kein Formular mehr herein
  await post({ oys_action: 'discord_defaults_save', bot_token: 'x'.repeat(70), auto_post: '1' });
  assert.equal((await stored())?.bot_token, GOOD_TOKEN);
  assert.equal((await post({ oys_action: 'discord_token_remove' , _confirmed: '0' })).error, UNCONFIRMED_MESSAGE);
  // Ein gespeicherter Webhook löst den Token ab
  const r = await save({ webhook_link: link(HOOK) });
  assert.equal(r.ok, 'Webhook saved and checked – Discord knows it as “Captain Hook” (channel 1200000000000000001). The old bot token is deleted from the website.');
  assert.equal((await stored())?.bot_token, '');
  // Löschen ohne Webhook
  await store(legacy);
  assert.equal((await post({ oys_action: 'discord_token_remove', _confirmed: '1' })).ok, 'The old bot token is deleted from the website.');
  assert.equal((await stored())?.bot_token, '');
  assert.equal((await post({ oys_action: 'discord_token_test' })).error, 'There is no old bot token stored.');
  // Ein Token ohne Kanal: sagt, was zu tun ist
  await store({ ...legacy, channel_id: '' });
  assert.equal((await post({ oys_action: 'discord_token_test' })).error, 'The old bot token has no channel – delete it and use a webhook.');
});

test('defaults: announce by default and the invite link (https only)', async () => {
  assert.equal((await post({ oys_action: 'discord_defaults_save', invite_url: 'http://discord.gg/x', auto_post: '1' })).error, 'Invite link: use an https:// link, e.g. https://discord.gg/… – or leave it empty.');
  assert.equal((await post({ oys_action: 'discord_defaults_save', invite_url: ' https://discord.gg/abc ' })).ok, 'Discord settings saved.');
  const s = await stored();
  assert.equal(s?.invite_url, 'https://discord.gg/abc');
  assert.equal(s?.auto_post, false);
});

test('a failed save or test leaves one log line with the reason – never the link or token', async () => {
  const lines: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => void lines.push(args.join(' '));
  try {
    await save({ webhook_link: link('4041234567890123456'), display_name: 'News' });
    await save({ webhook_link: link(HOOK), display_name: 'admin@test.de' });
    await post({ oys_action: 'discord_webhook_test' });
  } finally {
    console.warn = orig;
  }
  assert.equal(lines.length, 3);
  for (const l of lines) {
    assert.match(l, /^\[\d{4}-\d\d-\d\dT[\d:.]+Z\] Discord settings: /);
    assert.ok(!l.includes('/webhooks/') && !l.includes(token('k56')), l);
  }
  assert.match(lines[0], /Discord doesn’t know this webhook/);
  assert.match(lines[1], /Display name: Discord doesn’t allow “@” in names\./);
});

test('updates: two clicks on "Post to Discord" post once; the second one hears it is already posting', async () => {
  await save({ webhook_link: link(HOOK) });
  await exec("INSERT INTO updates (id, title, body, version, category, is_published, published_at, discord_announce, created_at, updated_at) VALUES (7, 'Launch', '', '', 'new', 1, NOW(), 1, NOW(), NOW())");
  discord.restart();
  discord.delayNext(600);
  const [a, b] = await Promise.all([
    adminUpdatesHandle({ oys_action: 'update_discord', id: '7' }),
    new Promise((r) => setTimeout(r, 150)).then(() => adminUpdatesHandle({ oys_action: 'update_discord', id: '7' })),
  ]);
  assert.deepEqual(a, { tab: 'updates', ok: 'Posted to Discord.' });
  assert.deepEqual(b, { tab: 'updates', error: ALREADY_POSTING });
  assert.equal(calls('POST', '/webhooks/').length, 1, 'exactly one post');
  // Danach ist die Sperre frei: ein weiterer Klick bearbeitet nur die vorhandene Nachricht
  assert.deepEqual(await adminUpdatesHandle({ oys_action: 'update_discord', id: '7' }), { tab: 'updates', ok: 'Posted to Discord.' });
  assert.equal(calls('POST', '/webhooks/').length, 1);
  assert.equal(calls('PATCH', '/webhooks/').length, 1);
});

test('updates: errors from Discord, deleted posts, other webhooks and broken message IDs', async () => {
  await save({ webhook_link: link(HOOK) });
  await exec(`INSERT INTO updates (id, title, body, version, category, is_published, published_at, discord_announce, discord_message_id, discord_target, created_at, updated_at) VALUES
    (1, 'One', '', '', 'new', 1, NOW(), 1, NULL, NULL, NOW(), NOW()),
    (2, 'Two', '', '', 'new', 1, NOW(), 1, '1300000000000000099', 'webhook:${HOOK}', NOW(), NOW()),
    (3, 'Three', '', '', 'new', 1, NOW(), 1, '1300000000000000098', 'webhook:1309999999999999999', NOW(), NOW()),
    (4, 'Four', '', '', 'new', 1, NOW(), 1, '1300000000000000097\n', 'webhook:${HOOK}', NOW(), NOW())`);
  // Gepostete Updates von vorher übernimmt der Schritt V_DISCORD_DELIVERY als Zeilen
  await withConnection((_db, conn) => convertLegacyPosts(conn, { tokenStored: false, botInstalled: false }));
  discord.restart();
  discord.failNext(500);
  assert.equal((await adminUpdatesHandle({ oys_action: 'update_discord', id: '1' }))?.error, 'Discord had a problem (500) – please try again in a moment.');
  discord.failNext(429);
  assert.equal((await adminUpdatesHandle({ oys_action: 'update_discord', id: '1' }))?.error, 'Discord is rate limiting us – try again in 2 s.');
  // In Discord gelöscht: vergessen und neu posten
  assert.equal((await adminUpdatesHandle({ oys_action: 'update_discord', id: '2' }))?.ok, 'Posted to Discord.');
  assert.notEqual((await postRow(2))!.message_id, '1300000000000000099');
  // Über einen anderen Webhook gepostet: wird nicht angefasst, nur vergessen
  const other = await adminUpdatesHandle({ oys_action: 'update_discord_remove', id: '3' });
  assert.equal(other?.error, 'Its Discord post couldn’t be removed (it was posted through a different webhook or bot) – please delete it in Discord yourself.');
  // Kaputte gespeicherte ID: nichts wird gesendet, die ID wird vergessen
  discord.restart();
  assert.equal((await adminUpdatesHandle({ oys_action: 'update_discord_remove', id: '4' }))?.ok, 'Removed from Discord.');
  assert.equal(discord.calls().length, 0);
  assert.equal(await postRow(4), null);
  // Löschen mit kurzem Aussetzer bei Discord: nichts wird gelöscht
  const two = (await postRow(2))!;
  await exec("DELETE FROM update_discord_posts WHERE update_id = 1");
  await exec(`INSERT INTO update_discord_posts (update_id, via, target, kind, message_id, state, created_at, updated_at) VALUES (1, 'webhook', 'webhook:${HOOK}', 'message', ?, 'posted', NOW(), NOW())`, [String(two.message_id)]);
  discord.failNext(503);
  const del = await adminUpdatesHandle({ oys_action: 'update_delete', id: '1' });
  assert.equal(del?.error, 'Nothing was deleted, because its Discord post couldn’t be removed: Discord had a problem (503) – please try again in a moment.');
  assert.ok(await one('SELECT id FROM updates WHERE id = 1'));
  // Discord nicht erreichbar
  useConfig({ discord_api_base: 'http://127.0.0.1:1/api' });
  const cur = (await stored())!;
  await store({ ...cur, webhook: { ...cur.webhook, url: `http://127.0.0.1:1/api/webhooks/${HOOK}/${token('zz')}` } });
  assert.equal((await adminUpdatesHandle({ oys_action: 'update_discord', id: '3' }))?.error, 'Couldn’t reach Discord (connection refused).');
  useConfig();
  assert.equal((await q('SELECT id FROM updates')).length, 4);
});
