// Admin → Discord: jedes Ziel hat sein eigenes Formular mit eigenen Feldnamen (Webhook, alter Bot-Token, Vorgaben).
// Ein Formular sendet nur seine Felder – ein Wert, den der Browser in ein anderes Formular füllt, kommt nie mit.
// Speichern fragt bei Discord nach und zeigt dessen Fehler; jede Meldung sagt genau, was fehlt. Fehlgeschlagene
// Speicher- und Testversuche stehen mit ihrem Grund im Server-Protokoll (nie mit Link oder Token).
import type { Ctx } from '../web/ctx.js';
import { rateLimit } from '../web/security.js';
import { baseHost, cleanText, cleanUrl, mainUrl } from '../helpers.js';
import { date, intval, mbStrlen, mbSubstr, phpTrim, phpTruthy } from '../php.js';
import { discordBase, discordError, discordRequest, type DiscordResponse, type Payload } from './rest.js';
import { checkWebhook, cleanWebhookLink, parseWebhookLink, webhookPost, type WebhookLink } from './webhook.js';
import {
  POST_IN, activeDestination, discordSettings, displayNameInput, displayNameProblem, parseMention, snowflake, storeDiscordSettings,
  webhookName, type DiscordSettings,
} from './settings.js';

export interface AdminResult { tab: string; ok?: string; error?: string; query?: string }

// Felder des Webhook-Formulars, die nach einem Fehler stehen bleiben (der Link nie)
export const WEBHOOK_KEEP = ['post_in', 'thread_id', 'display_name', 'avatar_url', 'mention'] as const;
export const OUT_OF_DATE = 'This form is out of date – please reload the page.';
const TEST_LIMIT = 5; // Tests je Minute und Admin
const CHECK_LIMIT = 10; // Prüfungen bei Discord je Minute und Admin

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// Eine Zeile im Server-Protokoll für jeden fehlgeschlagenen Versuch – der Text ist die Meldung an den Admin
export function logDiscord(reason: string): void {
  console.warn(`[${new Date().toISOString()}] Discord settings: ${reason}`);
}

function ok(text: string): AdminResult {
  return { tab: 'discord', ok: text };
}

// Fehler: Meldung, Protokoll, markiertes Feld und die eingegebenen Werte (ohne Geheimnisse) für die nächste Anzeige
function fail(ctx: Ctx | undefined, text: string, field = '', keep: Record<string, string> | null = null): AdminResult {
  logDiscord(text);
  if (ctx?.session) {
    if (field !== '') ctx.session.set('discord_error_field', field);
    if (keep) ctx.session.set('discord_keep', keep);
  }
  return { tab: 'discord', error: text };
}

const adminKey = (ctx: Ctx | undefined): string => String(intval(ctx?.session?.get('user_id') ?? 0));

// Bestätigte Formulare (Entfernen, erster Test in einem Forum) senden _confirmed; ohne Bestätigung passiert nichts
function unconfirmed(post: Record<string, unknown>): boolean {
  return post._confirmed !== undefined && post._confirmed !== '1';
}

// Testnachricht (wie bisher), ohne Ping
export function testPayload(s: DiscordSettings, via: 'webhook' | 'token'): Payload {
  const p: Payload = {
    embeds: [{
      title: 'Discord is connected',
      description: 'New updates from ' + baseHost() + ' will show up here.',
      url: mainUrl('/updates'),
      color: 0x6366f1,
      footer: { text: 'OnYourSite Updates' },
    }],
    allowed_mentions: { parse: [] },
  };
  if (via === 'webhook') {
    const name = webhookName(s);
    if (name !== '') p.username = name;
    if (s.avatar_url !== '') p.avatar_url = s.avatar_url;
  }
  return p;
}

// discord_* aus dem Admin; null = gehört nicht hierher
export async function discordAdminHandle(action: string, post: Record<string, unknown>, ctx?: Ctx): Promise<AdminResult | null> {
  switch (action) {
    case 'discord_webhook_save':
      return webhookSave(post, ctx);
    case 'discord_webhook_test':
      return webhookTest(post, ctx);
    case 'discord_webhook_remove': {
      if (unconfirmed(post)) return fail(ctx, 'Please confirm removing the webhook.');
      const s = await discordSettings();
      if (!parseWebhookLink(s.webhook_url)) return fail(ctx, 'There is no webhook to remove.');
      Object.assign(s, {
        webhook_url: '', post_in: 'channel', thread_id: '', thread_verified: false, test_thread_id: '', checked_at: '', check_error: '',
        hook_name: '', hook_channel_id: '', hook_guild_id: '',
      });
      await storeDiscordSettings(s);
      return ok('Webhook removed. Its earlier posts stay in Discord.');
    }
    case 'discord_token_test':
      return tokenTest(ctx);
    case 'discord_token_remove': {
      if (unconfirmed(post)) return fail(ctx, 'Please confirm deleting the old bot token.');
      const s = await discordSettings();
      if (s.bot_token === '') return fail(ctx, 'There is no old bot token stored.');
      s.bot_token = '';
      s.channel_id = '';
      s.mode = 'webhook';
      await storeDiscordSettings(s);
      return ok('The old bot token is deleted from the website.' + (activeDestination(s) === 'webhook' ? ' Updates are posted with the webhook now.' : ''));
    }
    case 'discord_defaults_save': {
      const s = await discordSettings();
      const invite = phpTrim(str(post.invite_url));
      const clean = invite !== '' ? cleanUrl(invite) : '';
      if (invite !== '' && (!/^https:\/\//i.test(clean) || mbStrlen(clean) > 500)) {
        return fail(ctx, 'Invite link: use an https:// link, e.g. https://discord.gg/… – or leave it empty.', 'invite_url');
      }
      s.invite_url = clean;
      s.auto_post = phpTruthy(post.auto_post);
      await storeDiscordSettings(s);
      return ok('Discord settings saved.');
    }
    // Die alten Formulare (ein Formular für Webhook und Bot) – eine noch offene alte Seite ändert nichts mehr
    case 'discord_save':
    case 'discord_test':
    case 'discord_disconnect':
      return fail(ctx, OUT_OF_DATE);
  }
  return null;
}

// discord_webhook_save: Link (optional, wenn einer gespeichert ist), wo gepostet wird, Name, Bild, Ping – dann Discord
async function webhookSave(post: Record<string, unknown>, ctx?: Ctx): Promise<AdminResult> {
  const s = await discordSettings();
  const stored = parseWebhookLink(s.webhook_url);
  const linkRaw = phpTrim(str(post.webhook_link));
  let postIn = str(post.post_in);
  if (!(POST_IN as readonly string[]).includes(postIn)) postIn = 'channel';
  let threadId = phpTrim(str(post.thread_id));
  const displayName = displayNameInput(post.display_name);
  const avatarRaw = phpTrim(str(post.avatar_url));
  // Für die nächste Anzeige höchstens 500 Zeichen je Feld (eine riesige Eingabe kommt nie in die Sitzung)
  const keep: Record<string, string> = {};
  const keepAll = (): void => {
    const all: Record<string, string> = { post_in: postIn, thread_id: threadId, display_name: displayName, avatar_url: avatarRaw, mention: str(post.mention) };
    for (const [k, v] of Object.entries(all)) keep[k] = mbSubstr(v, 0, 500);
  };
  keepAll();

  // 1. Der Link
  let hook: WebhookLink | null = stored;
  if (linkRaw !== '') {
    hook = parseWebhookLink(linkRaw);
    if (!hook) {
      // Was statt des Links eingefügt wurde, beim Namen nennen (Q13: eine Kanal-ID allein hilft dem Webhook nicht)
      const what = /^\d{15,25}$/.test(linkRaw) ? 'That’s a channel ID'
        : /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\//i.test(linkRaw) ? 'That’s a link to a channel' : '';
      return fail(ctx, what !== ''
        ? what + ' – posting with a webhook needs the webhook’s link instead. In Discord: channel settings → Integrations → Webhooks → Copy Webhook URL.'
        : 'That isn’t a Discord webhook link. In Discord: channel settings → Integrations → Webhooks → Copy Webhook URL.', 'webhook_link', keep);
    }
    // Ein Link mit ?thread_id= meint „in diesen Thread“
    if (hook.threadId !== '') {
      postIn = 'thread';
      threadId = hook.threadId;
      keepAll();
    }
  } else if (!hook) {
    return fail(ctx, 'Webhook link is missing – in Discord: channel settings → Integrations → Webhooks → Copy Webhook URL, then paste it here.', 'webhook_link', keep);
  }
  // 2. Anzeigename, 3. Ping, 4. Thread-ID, Bild
  const nameProblem = displayNameProblem(displayName);
  if (nameProblem) return fail(ctx, nameProblem, 'display_name', keep);
  const mention = parseMention(post.mention);
  if ('error' in mention) return fail(ctx, mention.error, 'mention', keep);
  if (postIn === 'thread') {
    if (threadId === '') return fail(ctx, 'Thread ID is missing – in Discord turn on Developer Mode, right-click the thread → Copy Thread ID.', 'thread_id', keep);
    if (!snowflake(threadId)) return fail(ctx, 'Thread ID: in Discord turn on Developer Mode, right-click the thread → Copy Thread ID.', 'thread_id', keep);
  } else {
    threadId = '';
  }
  const avatar = avatarRaw !== '' ? cleanUrl(avatarRaw) : '';
  if (avatarRaw !== '' && (!/^https:\/\//i.test(avatar) || mbStrlen(avatar) > 500)) {
    return fail(ctx, 'Avatar image link: use an https:// link to an image – or leave it empty.', 'avatar_url', keep);
  }

  // 5. Discord selbst (GET postet nichts)
  if (!(await rateLimit('discord_check:' + adminKey(ctx), CHECK_LIMIT, 60))) {
    return fail(ctx, 'Too many checks with Discord – please wait a minute and save again.', '', keep);
  }
  const res: DiscordResponse = await checkWebhook(hook);
  const reachable = res.status >= 200 && res.status < 300;
  const transient = res.status === 0 || res.status === 429 || res.status >= 500;
  if (!reachable && !transient) {
    const text = discordError(res, 'webhook', 'Copy it again in Discord (channel settings → Integrations → Webhooks).');
    return fail(ctx, text, 'webhook_link', keep);
  }

  // Erst nach der Prüfung (bis zu 10 s) neu lesen: was inzwischen anderswo gespeichert wurde (z. B. die Vorgaben),
  // bleibt; dieses Formular ändert nur seine eigenen Felder. Gespeichert wird der Link, der eben geprüft wurde.
  const fresh = await discordSettings();
  const current = parseWebhookLink(fresh.webhook_url);
  const sameHook = !!current && current.id === hook.id;
  const next: DiscordSettings = {
    ...fresh,
    mode: 'webhook',
    webhook_url: linkRaw !== '' ? cleanWebhookLink(linkRaw) : s.webhook_url,
    username: displayName,
    avatar_url: avatar,
    mention: mention.value,
    post_in: postIn,
    thread_id: threadId,
    // Bestätigt bleibt ein Thread nur, wenn sich nichts geändert hat; der Test-Beitrag im Forum gehört zum Webhook
    thread_verified: postIn === 'thread' && sameHook && fresh.post_in === 'thread' && fresh.thread_id === threadId && fresh.thread_verified,
    test_thread_id: sameHook && postIn === 'forum' ? fresh.test_thread_id : '',
  };
  // Der alte Token wird gelöscht, sobald ein Webhook gespeichert ist – die Website hält dann keinen Bot-Token mehr
  const hadToken = fresh.bot_token !== '';
  next.bot_token = '';
  next.channel_id = '';
  const tokenNote = hadToken ? ' The old bot token is deleted from the website.' : '';
  const threadNote = postIn === 'thread' && !next.thread_verified ? ' The thread is checked with the first post into it.' : '';

  if (reachable) {
    const data = res.data ?? {};
    next.hook_name = cleanText(typeof data.name === 'string' ? data.name : '', 100);
    next.hook_channel_id = typeof data.channel_id === 'string' && snowflake(data.channel_id) ? data.channel_id : '';
    next.hook_guild_id = typeof data.guild_id === 'string' && snowflake(data.guild_id) ? data.guild_id : '';
    next.checked_at = date('Y-m-d H:i:s');
    next.check_error = '';
    await storeDiscordSettings(next);
    const known = next.hook_name !== '' ? '“' + next.hook_name + '”' : 'this webhook';
    return ok('Webhook saved and checked – Discord knows it as ' + known + (next.hook_channel_id !== '' ? ' (channel ' + next.hook_channel_id + ')' : '') + '.' + threadNote + tokenNote);
  }
  // Discord gerade nicht erreichbar: speichern, aber sagen, dass nicht geprüft wurde
  const why = discordError(res, 'webhook');
  next.check_error = why;
  if (!sameHook) {
    next.hook_name = '';
    next.hook_channel_id = '';
    next.hook_guild_id = '';
    next.checked_at = '';
  }
  await storeDiscordSettings(next);
  logDiscord('saved without a check: ' + why);
  return { tab: 'discord', error: 'Webhook saved, but Discord couldn’t be asked right now – ' + lowerFirst(why) + ' Use “Send test” to try it.' + threadNote + tokenNote };
}

// „Couldn’t reach …“ → „couldn’t reach …“ mitten im Satz; „Discord …“ bleibt groß
const lowerFirst = (t: string): string => (t.startsWith('Discord') ? t : t.charAt(0).toLowerCase() + t.slice(1));

// discord_webhook_test: an den gespeicherten Webhook, so wie Updates gepostet würden (Kanal, Forum, Thread)
async function webhookTest(post: Record<string, unknown>, ctx?: Ctx): Promise<AdminResult> {
  const s = await discordSettings();
  const hook = parseWebhookLink(s.webhook_url);
  if (!hook) return fail(ctx, 'There is no webhook to test yet – paste a webhook link under “Post with a webhook” and save it.');
  if (!(await rateLimit('discord_test:' + adminKey(ctx), TEST_LIMIT, 60))) return fail(ctx, 'Please wait a minute before sending another test.');
  const payload = testPayload(s, 'webhook');

  if (s.post_in === 'forum') {
    if (s.test_thread_id !== '') {
      const res = await webhookPost(hook, payload, { threadId: s.test_thread_id });
      if (res.status >= 200 && res.status < 300) return ok('Test message sent – check your Discord channel.');
      if (res.status === 404 && res.code === 10003) {
        await storeDiscordSettings({ ...(await discordSettings()), test_thread_id: '' });
        return fail(ctx, 'The earlier test post was deleted in Discord – send the test again to create a new one.');
      }
      return fail(ctx, discordError(res, 'webhook'));
    }
    // Der erste Test in einem Forum legt einen Beitrag an – nur nach der Bestätigung
    if (post._confirmed !== '1') return fail(ctx, 'Please confirm the test post – in a forum it creates a post “OnYourSite test”.');
    const res = await webhookPost(hook, payload, { threadName: 'OnYourSite test' });
    if (res.status >= 200 && res.status < 300) {
      const thread = typeof res.data?.channel_id === 'string' && snowflake(res.data.channel_id) ? res.data.channel_id : '';
      if (thread !== '') await storeDiscordSettings({ ...(await discordSettings()), test_thread_id: thread });
      return ok('Test message sent – check your Discord channel.');
    }
    return fail(ctx, discordError(res, 'webhook'));
  }

  const threadId = s.post_in === 'thread' ? s.thread_id : '';
  const res = await webhookPost(hook, payload, { threadId });
  if (res.status >= 200 && res.status < 300) {
    if (threadId !== '' && !s.thread_verified) {
      const fresh = await discordSettings();
      if (fresh.thread_id === threadId) await storeDiscordSettings({ ...fresh, thread_verified: true });
    }
    return ok('Test message sent – check your Discord channel.');
  }
  return fail(ctx, discordError(res, 'webhook'));
}

// discord_token_test: der alte Token in seinen Kanal (wie bisher)
async function tokenTest(ctx?: Ctx): Promise<AdminResult> {
  const s = await discordSettings();
  if (s.bot_token === '') return fail(ctx, 'There is no old bot token stored.');
  if (s.channel_id === '') return fail(ctx, 'The old bot token has no channel – delete it and use a webhook.');
  if (!(await rateLimit('discord_test:' + adminKey(ctx), TEST_LIMIT, 60))) return fail(ctx, 'Please wait a minute before sending another test.');
  const res = await discordRequest('POST', discordBase() + '/v10/channels/' + s.channel_id + '/messages', testPayload(s, 'token'), ['Authorization: Bot ' + s.bot_token]);
  if (res.status >= 200 && res.status < 300) return ok('Test message sent – check your Discord channel.');
  return fail(ctx, discordError(res, 'token'));
}

