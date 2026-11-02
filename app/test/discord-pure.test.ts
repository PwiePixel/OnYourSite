// Discord ohne Datenbank: Webhook-Links (auch mit ?thread_id=), Regeln für Anzeigename und Ping, Discords Fehler als
// Text (jede Zeile der Tabelle aus discord-pages.md §5.5.2), gespeicherte Ziele und Einstellungen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discordBase, discordError, walkErrors, type DiscordResponse } from '../src/discord/rest.js';
import { cleanWebhookLink, maskedWebhook, parseWebhookLink } from '../src/discord/webhook.js';
import {
  activeDestination, discordDefaults, discordDefaultsV1, discordSettingsFromV1, displayNameProblem, normalizeSettings, normalizeV1, parseMention,
} from '../src/discord/settings.js';
import { discordWithMention, threadName } from '../src/updates/discord.js';
import { legacyPostRow } from '../src/discord/legacy.js';
import type { Update } from '../src/updates/updates.js';

// Token zur Laufzeit zusammengesetzt (kein tokenförmiger Text im Repository)
const TOKEN = 'aB3_-'.repeat(8);

test('parseWebhookLink: every Discord host form, ?thread_id= and ?wait=, nothing else', () => {
  const ok = [
    ['https://discord.com/api/webhooks/123456789012345678/' + TOKEN, ''],
    ['https://discordapp.com/api/webhooks/123456789012345678/' + TOKEN, ''],
    ['https://ptb.discord.com/api/v10/webhooks/123456789012345678/' + TOKEN + '/', ''],
    ['https://canary.discordapp.com/api/v9/webhooks/123456789012345678/' + TOKEN, ''],
    ['  https://discord.com/api/webhooks/123456789012345678/' + TOKEN + '\n', ''],
    ['https://discord.com/api/webhooks/123456789012345678/' + TOKEN + '?thread_id=1401234567890123456', '1401234567890123456'],
    ['https://discord.com/api/webhooks/123456789012345678/' + TOKEN + '?wait=true', ''],
    ['https://discord.com/api/webhooks/123456789012345678/' + TOKEN + '/?wait=false&thread_id=1401234567890123456', '1401234567890123456'],
    ['https://discord.com/api/webhooks/123456789012345678/' + TOKEN + '?thread_id=1401234567890123456&wait=true', '1401234567890123456'],
    // Die Test-Adresse aus discord_api_base, auch mit API-Version
    [discordBase() + '/webhooks/123456789012345678/' + TOKEN, ''],
    [discordBase() + '/v10/webhooks/123456789012345678/' + TOKEN, ''],
  ];
  for (const [link, thread] of ok) assert.deepEqual(parseWebhookLink(link), { id: '123456789012345678', token: TOKEN, threadId: thread }, link);
  const bad = [
    'https://discord.com/channels/123456789012345678/123456789012345678',
    'http://discord.com/api/webhooks/123456789012345678/' + TOKEN,
    'https://discord.com.evil.io/api/webhooks/123456789012345678/' + TOKEN,
    'https://evil.io/?u=https://discord.com/api/webhooks/123456789012345678/' + TOKEN,
    'https://discord.com/api/webhooks/123456789012345678/' + TOKEN + '/messages/1',
    'https://discord.com/api/webhooks/123456789012345678/' + TOKEN + '?foo=1',
    'https://discord.com/api/webhooks/123456789012345678/' + TOKEN + '?wait=maybe',
    'https://discord.com/api/webhooks/123456789012345678/' + TOKEN + '?thread_id=12',
    'https://discord.com/api/webhooks/123456789012345678/' + TOKEN + '?thread_id=1401234567890123456&thread_id=1401234567890123457',
    'https://discord.com/api/webhooks/123456789012345678/' + TOKEN + '#x',
    'https://discord.com/api/webhooks/1234/' + TOKEN,
    'https://discord.com/api/webhooks/123456789012345678/short',
    'https://discord.com/api/webhooks/123456789012345678/' + TOKEN + ' x',
    'https://DISCORD.com/api/webhooks/123456789012345678/' + TOKEN,
    '', 'nonsense',
  ];
  for (const link of bad) assert.equal(parseWebhookLink(link), null, link);
  assert.equal(parseWebhookLink(['x']), null);
  assert.equal(cleanWebhookLink(' https://discord.com/api/webhooks/1234567/' + TOKEN + '/?wait=true '), 'https://discord.com/api/webhooks/1234567/' + TOKEN);
  assert.equal(maskedWebhook({ id: '1234567', token: TOKEN, threadId: '' }), 'https://discord.com/api/webhooks/1234567/••••');
});

test('displayNameProblem: Discord’s name rules, each with its own message', () => {
  assert.equal(displayNameProblem(''), null);
  assert.equal(displayNameProblem('OnYourSite Updates'), null);
  assert.equal(displayNameProblem('x'.repeat(80)), null);
  assert.equal(displayNameProblem('\u{E4}'.repeat(80)), null);
  assert.equal(displayNameProblem('x'.repeat(81)), 'Display name: at most 80 characters.');
  assert.equal(displayNameProblem('admin@test.de'), 'Display name: Discord doesn’t allow “@” in names.');
  assert.equal(displayNameProblem('#news'), 'Display name: Discord doesn’t allow “#” in names.');
  assert.equal(displayNameProblem('News: daily'), 'Display name: Discord doesn’t allow “:” in names.');
  assert.equal(displayNameProblem('a```b'), 'Display name: Discord doesn’t allow “```” in names.');
  assert.equal(displayNameProblem('My Discord News'), 'Display name: Discord doesn’t allow the word “discord” in names.');
  assert.equal(displayNameProblem('CLYDE bot'), 'Display name: Discord doesn’t allow the word “clyde” in names.');
  assert.equal(displayNameProblem('Everyone'), 'Display name: Discord doesn’t allow the name “everyone”.');
  assert.equal(displayNameProblem('here'), 'Display name: Discord doesn’t allow the name “here”.');
  assert.equal(displayNameProblem('here we go'), null);
});

test('parseMention: nobody, everyone, here or a role ID – in the forms people type', () => {
  const role = '1301234567890123457';
  const cases: Array<[unknown, string | null]> = [
    ['', ''], ['   ', ''], ['everyone', 'everyone'], ['@everyone', 'everyone'], ['EVERYONE', 'everyone'], ['@here', 'here'], ['HERE', 'here'],
    [role, role], ['<@&' + role + '>', role], ['@' + role, role], [' ' + role + '\n', role],
    ['someone', null], ['@someone', null], ['123', null], ['<@' + role + '> x', null], [['everyone'], ''],
  ];
  for (const [input, expected] of cases) {
    const r = parseMention(input);
    if (expected === null) assert.deepEqual(r, { error: 'Ping: enter a role ID, “everyone” or “here” – or leave it empty.' }, String(input));
    else assert.deepEqual(r, { value: expected }, String(input));
  }
});

test('parseMention takes linear time: a long run of spaces inside the input never stalls the server', () => {
  // Früher /^[\s@<&>]+|[\s@<&>]+$/g: bei Leerzeichen vor einem anderen Zeichen quadratisch (50 000 ≈ 5 s, 20 MB ≈ Tage)
  for (const input of ['x' + ' '.repeat(50000) + 'x', '@' + '\t'.repeat(50000) + '#', ' '.repeat(50000)]) {
    const started = performance.now();
    const r = parseMention(input);
    assert.ok(performance.now() - started < 250, 'linear time for ' + JSON.stringify(input.slice(0, 3)) + '…');
    assert.deepEqual(r, input.trim() === '' ? { value: '' } : { error: 'Ping: enter a role ID, “everyone” or “here” – or leave it empty.' });
  }
  // Der Rand aus Leerraum und @ < & > fällt weiter weg, auch geschützte Leerzeichen aus kopiertem Text
  assert.deepEqual(parseMention(' \n<@&1301234567890123457>  '), { value: '1301234567890123457' });
});

test('discordError: every case of the table, with Discord’s own message', () => {
  const res = (status: number, data: Record<string, unknown> | null = null, error = ''): DiscordResponse => ({
    status, data, code: data && typeof data.code === 'number' ? data.code : null, error,
  });
  // Keine Antwort
  assert.equal(discordError(res(0, null, 'Operation timed out after 10001 milliseconds with 0 bytes received'), 'webhook'), 'Couldn’t reach Discord (timeout).');
  assert.equal(discordError(res(0, null, 'Failed to connect to discord.com port 443 after 5000 ms: Timeout was reached'), 'webhook'), 'Couldn’t reach Discord (timeout).');
  assert.equal(discordError(res(0, null, 'Could not resolve host: discord.com'), 'webhook'), 'Couldn’t reach Discord (DNS lookup failed).');
  assert.equal(discordError(res(0, null, "Failed to connect to 127.0.0.1 port 1 after 0 ms: Couldn't connect to server"), 'token'), 'Couldn’t reach Discord (connection refused).');
  assert.equal(discordError(res(0, null, 'SSL certificate problem: self-signed certificate'), 'webhook'), 'Couldn’t reach Discord (TLS error).');
  assert.equal(discordError(res(0, null, 'Recv failure: Connection reset by peer'), 'webhook'), 'Couldn’t reach Discord (the connection broke off).');
  // 401
  assert.equal(discordError(res(401, { message: 'Invalid Webhook Token', code: 50027 }), 'webhook'),
    'Discord doesn’t accept this webhook link any more – copy it again in Discord. Discord said: “Invalid Webhook Token” (50027).');
  // Mit dem Hinweis beim Speichern: kein doppeltes „copy it again in Discord“
  assert.equal(discordError(res(401, { message: 'Invalid Webhook Token', code: 50027 }), 'webhook', 'Copy it again in Discord (channel settings → Integrations → Webhooks).'),
    'Discord doesn’t accept this webhook link any more. Copy it again in Discord (channel settings → Integrations → Webhooks). Discord said: “Invalid Webhook Token” (50027).');
  assert.equal(discordError(res(401, { message: '401: Unauthorized', code: 0 }), 'token'),
    'Discord doesn’t accept the old bot token any more – delete it and use a webhook. Discord said: “401: Unauthorized”.');
  // 403
  assert.equal(discordError(res(403, { message: 'Missing Permissions', code: 50013 }), 'webhook'),
    'Discord refused the webhook (403) – please check it in the channel settings. Discord said: “Missing Permissions” (50013).');
  assert.equal(discordError(res(403, { message: 'Missing Access', code: 50001 }), 'token'),
    'The bot isn’t allowed to post in this channel. It needs “View Channel”, “Send Messages” and “Embed Links”. Discord said: “Missing Access” (50001).');
  // 404
  assert.equal(discordError(res(404, { message: 'Unknown Webhook', code: 10015 }), 'webhook'),
    'Discord doesn’t know this webhook – it was deleted or the link is incomplete. Discord said: “Unknown Webhook” (10015).');
  assert.equal(discordError(res(404, { message: 'Unknown Webhook', code: 10015 }), 'webhook', 'Copy it again.'),
    'Discord doesn’t know this webhook – it was deleted or the link is incomplete. Copy it again. Discord said: “Unknown Webhook” (10015).');
  assert.equal(discordError(res(404, { message: 'Unknown Channel', code: 10003 }), 'webhook'),
    'Discord can’t find this channel or thread – it may have been deleted. Discord said: “Unknown Channel” (10003).');
  assert.equal(discordError(res(404, { message: 'Unknown Message', code: 10008 }), 'token'),
    'Discord can’t find this message – it may have been deleted. Discord said: “Unknown Message” (10008).');
  assert.equal(discordError(res(404), 'webhook'), 'Discord couldn’t find this webhook – it may have been deleted.');
  assert.equal(discordError(res(404), 'token'), 'Discord couldn’t find the channel or message.');
  // 400: Invalid Form Body mit dem Pfad des ersten Fehlers
  assert.equal(discordError(res(400, { code: 50035, message: 'Invalid Form Body', errors: { username: { _errors: [{ code: 'USERNAME_INVALID_CONTAINS', message: 'Username cannot contain "@"' }] } } }), 'webhook'),
    'Discord rejected the message – username: Username cannot contain "@".');
  assert.equal(discordError(res(400, { code: 50035, message: 'Invalid Form Body', errors: { embeds: { 0: { description: { _errors: [{ code: 'BASE_TYPE_MAX_LENGTH', message: 'Must be 4096 or fewer in length.' }] } } } } }), 'webhook'),
    'Discord rejected the message – embeds.0.description: Must be 4096 or fewer in length.');
  assert.equal(discordError(res(400, { code: 50035, message: 'Invalid Form Body' }), 'webhook'), 'Discord rejected the message – Invalid Form Body.');
  assert.equal(discordError(res(400, { code: 220001, message: 'Webhooks posted to forum channels must have a thread_name or thread_id' }), 'webhook'),
    'This webhook belongs to a forum channel. Choose “As a new forum post for each update” or “In a thread”, then save again.');
  assert.equal(discordError(res(400, { code: 220003, message: 'Webhooks can only create threads in forum channels' }), 'webhook'),
    'Threads can only be created in forum channels – choose “In the channel” for this webhook. Discord said: “Webhooks can only create threads in forum channels” (220003).');
  assert.equal(discordError(res(400, { code: 50008, message: 'Cannot send messages in a non-text channel' }), 'token'),
    'This isn’t a text channel – choose a text, announcement or forum channel. Discord said: “Cannot send messages in a non-text channel” (50008).');
  // Rate-Limit und Störungen bei Discord
  assert.equal(discordError(res(429, { message: 'You are being rate limited.', retry_after: 1.5 }), 'webhook'), 'Discord is rate limiting us – try again in 2 s.');
  assert.equal(discordError(res(429, null), 'webhook'), 'Discord is rate limiting us – try again in a moment.');
  assert.equal(discordError(res(500), 'webhook'), 'Discord had a problem (500) – please try again in a moment.');
  assert.equal(discordError(res(502, { message: '<html>' }), 'token'), 'Discord had a problem (502) – please try again in a moment.');
  // Sonstiges: Status, Discords Meldung (ohne Steuerzeichen) und Code
  assert.equal(discordError(res(418, { message: 'I\u0000m a teapot\n', code: 7 }), 'webhook'), 'Discord error 418: Im a teapot (7).');
  assert.equal(discordError(res(405), 'webhook'), 'Discord error 405.');
});

test('walkErrors finds the first nested message and its path', () => {
  assert.deepEqual(walkErrors({ a: { b: { _errors: [{ message: 'deep' }] } }, c: { _errors: [{ message: 'later' }] } }), { path: 'a.b', message: 'deep' });
  assert.deepEqual(walkErrors({ _errors: [{ message: 'top' }] }), { path: '', message: 'top' });
  assert.equal(walkErrors(null), null);
  assert.equal(walkErrors({ a: { _errors: [] } }), null);
  assert.equal(walkErrors('x'), null);
});

test('stored targets of posts from before (migration), forum post names and the active destination', () => {
  const opts = { tokenStored: false, botInstalled: false };
  assert.deepEqual(legacyPostRow('webhook:123456', '1300000000000000001', opts), { via: 'webhook', target: 'webhook:123456', kind: 'message', channel_id: null, legacy: 0 });
  // Thread-ID = Nachrichten-ID: ein neuer Forenbeitrag; sonst eine Nachricht in einem Thread
  assert.deepEqual(legacyPostRow('webhook:123456:1401234567890123456', '1401234567890123456', opts), { via: 'webhook', target: 'webhook:123456', kind: 'forum_post', channel_id: '1401234567890123456', legacy: 0 });
  assert.deepEqual(legacyPostRow('webhook:123456:1401234567890123456', '1300000000000000002', opts), { via: 'webhook', target: 'webhook:123456', kind: 'thread_msg', channel_id: '1401234567890123456', legacy: 0 });
  // Alter Token: bleibt beim Token, solange er gespeichert ist; sonst übernimmt ihn der installierte Bot; sonst nicht
  assert.deepEqual(legacyPostRow('bot:1301234567890123456', '1300000000000000003', { tokenStored: true, botInstalled: true }), { via: 'token', target: 'bot:1301234567890123456', kind: 'message', channel_id: '1301234567890123456', legacy: 1 });
  assert.deepEqual(legacyPostRow('bot:1301234567890123456', '1300000000000000003', { tokenStored: false, botInstalled: true }), { via: 'bot', target: 'bot', kind: 'message', channel_id: '1301234567890123456', legacy: 1 });
  assert.equal(legacyPostRow('bot:1301234567890123456', '1300000000000000003', opts), null);
  for (const bad of ['', 'webhook:', 'webhook:12:34', 'bot:12', 'other:123456', 'webhook:123456\n']) assert.equal(legacyPostRow(bad, '1', { tokenStored: true, botInstalled: true }), null, bad);
  const u = { id: 1, title: 'Own pages for the roadmap', version: '2.5' } as Update;
  assert.equal(threadName(u), '2.5 – Own pages for the roadmap');
  assert.equal(threadName({ ...u, version: '', title: 'x'.repeat(150) }), 'x'.repeat(100));
  // Der Stand aus der Schleife (Bot-Modus ohne Token) zählt nicht: ein gespeicherter Webhook wird benutzt
  const hook = 'https://discord.com/api/webhooks/123456789012345678/' + TOKEN;
  const v1 = (o: Record<string, unknown>) => discordSettingsFromV1(normalizeV1({ ...discordDefaultsV1(), ...o }));
  assert.equal(activeDestination(v1({ mode: 'bot', webhook_url: hook })), 'webhook');
  assert.equal(activeDestination(v1({ mode: 'bot', bot_token: 'x'.repeat(60), channel_id: '1301234567890123456', webhook_url: hook })), 'token');
  assert.equal(activeDestination(v1({ mode: 'bot', bot_token: 'x'.repeat(60), webhook_url: hook })), null);
  assert.equal(activeDestination(v1({ webhook_url: 'nonsense' })), null);
  assert.equal(activeDestination(discordDefaults()), null);
  // Name und Bild nur für den Webhook
  const s = v1({ webhook_url: hook, username: 'News', avatar_url: 'https://x.y/a.png', mention: 'here' });
  assert.deepEqual(discordWithMention({ embeds: [] }, s), { embeds: [], allowed_mentions: { parse: ['everyone'] }, content: '@here', username: 'News', avatar_url: 'https://x.y/a.png' });
  const t = v1({ mode: 'bot', bot_token: 'x'.repeat(60), channel_id: '1301234567890123456', mention: 'here' });
  assert.deepEqual(discordWithMention({ embeds: [] }, t, 'token'), { embeds: [], allowed_mentions: { parse: ['everyone'] }, content: '@here' });
});

test('stored settings of any shape become well-typed v2 settings; v1 values are converted', () => {
  const d = discordDefaults();
  assert.deepEqual(normalizeSettings(null), d);
  assert.deepEqual(normalizeSettings([1, 2]), d);
  assert.deepEqual(normalizeSettings('x'), d);
  // Alte Form: Werte in ihre Typen, unbekannte Schlüssel weg
  const n = normalizeV1({ mode: 'bot', auto_post: 0, thread_verified: '1', post_in: 'nowhere', channel_id: 1301234567890, mention: ['x'], extra: 1, username: null });
  assert.equal(n.mode, 'bot');
  assert.equal(n.auto_post, false);
  assert.equal(n.thread_verified, true);
  assert.equal(n.post_in, 'channel');
  assert.equal(n.channel_id, '1301234567890');
  assert.equal(n.mention, '');
  assert.equal(n.username, '');
  assert.equal('extra' in n, false);
  // v2 mit kaputten Teilen
  const v2 = normalizeSettings({ v: 2, auto_post: '', bot: { enabled: 1, channel_id: 5, channel_type: 'voice', extra: 1 }, webhook: 'x', bot_token: ['t'], other: 1 });
  assert.equal(v2.auto_post, false);
  assert.deepEqual(v2.bot, { enabled: true, channel_id: '5', channel_type: '', mention: '', saved_at: '' });
  assert.deepEqual(v2.webhook, discordDefaults().webhook);
  assert.equal(v2.bot_token, '');
  assert.equal('other' in v2, false);
});

test('v1 → v2: webhook (active or kept off), the old token with its channel and ping, names Discord refuses, the bot prefilled', () => {
  const hook = 'https://discord.com/api/webhooks/123456789012345678/' + TOKEN;
  const conv = (o: Record<string, unknown>) => discordSettingsFromV1(normalizeV1({ ...discordDefaultsV1(), ...o }));
  // Webhook mit allem aus PR 1
  const w = conv({ mode: 'webhook', webhook_url: hook, username: 'News', avatar_url: 'https://x.y/a.png', mention: 'everyone', invite_url: 'https://discord.gg/x',
    auto_post: false, post_in: 'thread', thread_id: '1401234567890123456', thread_verified: true, checked_at: '2026-11-01 10:00:00', hook_name: 'Captain Hook' });
  assert.equal(w.v, 2);
  assert.equal(w.auto_post, false);
  assert.equal(w.invite_url, 'https://discord.gg/x');
  assert.deepEqual(w.webhook, { enabled: true, url: hook, post_in: 'thread', thread_id: '1401234567890123456', thread_verified: true, test_thread_id: '', display_name: 'News',
    avatar_url: 'https://x.y/a.png', mention: 'everyone', checked_at: '2026-11-01 10:00:00', check_error: '', hook_name: 'Captain Hook', hook_channel_id: '', hook_guild_id: '' });
  assert.equal(w.bot_token, '');
  assert.equal(w.bot.enabled, false);
  // Alter Token gewählt: bleibt Ziel mit Kanal und Ping; ein gespeicherter Webhook bleibt ausgeschaltet; der Bot ist vorgemerkt, aber aus
  const t = conv({ mode: 'bot', bot_token: 'x'.repeat(60), channel_id: '1301234567890123456', mention: '1301234567890123457', webhook_url: hook, username: 'admin@test.de' });
  assert.equal(t.bot_token, 'x'.repeat(60));
  assert.equal(t.channel_id, '1301234567890123456');
  assert.equal(t.mention, '1301234567890123457');
  assert.equal(t.webhook.enabled, false);
  assert.equal(t.webhook.url, hook);
  assert.equal(t.webhook.display_name, '', 'a name Discord refuses (the login e-mail) is dropped');
  assert.deepEqual(t.bot, { enabled: false, channel_id: '1301234567890123456', channel_type: '', mention: '1301234567890123457', saved_at: '' });
  // Unbrauchbarer Link: kein Webhook
  assert.equal(conv({ webhook_url: 'https://evil.example/hook' }).webhook.url, '');
  // Rundreise: v2 bleibt v2
  assert.deepEqual(normalizeSettings(JSON.parse(JSON.stringify(t))), t);
});
