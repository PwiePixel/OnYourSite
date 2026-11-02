// Admin → Discord: jedes Ziel hat sein eigenes Formular mit eigenen Feldnamen (installierter Bot, Webhook, alter
// Bot-Token, Vorgaben). Ein Formular sendet nur seine Felder – ein Wert, den der Browser in ein anderes Formular füllt,
// kommt nie mit. Speichern fragt bei Discord nach (Webhook) bzw. prüft gegen den Bericht des Bots und zeigt den Fehler;
// jede Meldung sagt genau, was fehlt. Fehlgeschlagene Speicher- und Testversuche stehen mit ihrem Grund im
// Server-Protokoll (nie mit Link oder Token). Dazu die Karte „Discord posts“: Retry und Forget je Beitrag.
import type { Ctx } from '../web/ctx.js';
import { rateLimit } from '../web/security.js';
import { cleanText, cleanUrl } from '../helpers.js';
import { configString } from '../config.js';
import { LockBusyError, one, withNamedLock, type Db } from '../db.js';
import { date, intval, mbStrlen, mbSubstr, phpStr, phpTrim, phpTruthy } from '../php.js';
import { phpJson } from '../html.js';
import { botSecret, outboxAdd, supersede } from '../community/community.js';
import { withRetry } from '../community/outbox.js';
import { discordBase, discordError, discordRequest, type DiscordResponse, type Payload } from './rest.js';
import { checkWebhook, cleanWebhookLink, parseWebhookLink, webhookPost, type WebhookLink } from './webhook.js';
import {
  POST_IN, activeWebhook, decodeStored, discordSettings, displayNameInput, displayNameProblem, normalizeSettings, parseMention, snowflake,
  storeDiscordSettings, tokenUsable, webhookDefaults, type DiscordSettings,
} from './settings.js';
import { styleOf, testPayload as buildTestPayload } from './payload.js';
import { TEXTS, delivery, dropWebhookRows, forget, patchWebhook, retry, tokenRowsToBot } from './posts.js';
import { botStatus, report } from './botReport.js';
import { cantPost, checkBotChoice, placeOf, webhookPostsInto } from './botCard.js';
import { DISMISSABLE_JOBS } from './jobs.js';

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
  return buildTestPayload(styleOf(s, via), via);
}

// discord_* aus dem Admin; null = gehört nicht hierher
export async function discordAdminHandle(action: string, post: Record<string, unknown>, ctx?: Ctx): Promise<AdminResult | null> {
  switch (action) {
    case 'discord_bot_save':
      return botSave(post, ctx);
    case 'discord_bot_test':
      return botTest(post, ctx);
    case 'discord_bot_refresh':
      return botRefresh(ctx);
    case 'discord_post_retry':
      return postRetry(post, ctx);
    case 'discord_post_forget':
      return postForget(post, ctx);
    case 'discord_job_dismiss':
      return jobDismiss(post, ctx);
    case 'discord_webhook_save':
      return webhookSave(post, ctx);
    case 'discord_webhook_test':
      return webhookTest(post, ctx);
    case 'discord_webhook_remove': {
      if (unconfirmed(post)) return fail(ctx, 'Please confirm removing the webhook.');
      // Gesperrt lesen und speichern (wie jedes Speichern hier); seine Beiträge werden vergessen (sie bleiben in Discord)
      const removed = await withRetry(async (db) => {
        const s = await lockedSettings(db);
        if (!parseWebhookLink(s.webhook.url)) return false;
        s.webhook = webhookDefaults();
        await storeDiscordSettings(s);
        await dropWebhookRows(db);
        return true;
      });
      if (!removed) return fail(ctx, 'There is no webhook to remove.');
      return ok('Webhook removed. Its earlier posts stay in Discord.');
    }
    case 'discord_token_test':
      return tokenTest(ctx);
    case 'discord_token_remove': {
      if (unconfirmed(post)) return fail(ctx, 'Please confirm deleting the old bot token.');
      // Geht der alte Token, übernimmt der installierte Bot dessen Beiträge (oder sie werden vergessen) – zusammen mit den
      // Einstellungen in einer Transaktion
      const left = await withRetry(async (db) => {
        const s = await lockedSettings(db);
        if (s.bot_token === '') return null;
        s.bot_token = '';
        s.channel_id = '';
        s.mention = '';
        await storeDiscordSettings(s);
        await tokenRowsToBot(db, botSecret() !== '');
        return s;
      });
      if (!left) return fail(ctx, 'There is no old bot token stored.');
      return ok('The old bot token is deleted from the website.' + (activeWebhook(left) ? ' Updates are posted with the webhook now.' : ''));
    }
    case 'discord_defaults_save': {
      const invite = phpTrim(str(post.invite_url));
      const clean = invite !== '' ? cleanUrl(invite) : '';
      if (invite !== '' && (!/^https:\/\//i.test(clean) || mbStrlen(clean) > 500)) {
        return fail(ctx, 'Invite link: use an https:// link, e.g. https://discord.gg/… – or leave it empty.', 'invite_url');
      }
      await withRetry(async (db) => {
        const s = await lockedSettings(db);
        s.invite_url = clean;
        s.auto_post = phpTruthy(post.auto_post);
        await storeDiscordSettings(s);
      });
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
  const stored = parseWebhookLink(s.webhook.url);
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
  // bleibt; dieses Formular ändert nur seine eigenen Felder. Gespeichert wird der Link, der eben geprüft wurde. Lesen und
  // Speichern laufen gesperrt in einer Transaktion: ein gleichzeitiges Speichern des Bots geht nicht verloren und bekommt
  // nicht denselben Kanal.
  return withRetry(async (db): Promise<AdminResult> => {
    const fresh = await lockedSettings(db);
    const current = parseWebhookLink(fresh.webhook.url);
    const sameHook = !!current && current.id === hook.id;
    // Ohne neuen Link gilt der gespeicherte, den Discord eben geprüft hat: hat ihn inzwischen jemand entfernt oder
    // ersetzt, nicht den alten wieder einsetzen
    if (linkRaw === '' && !sameHook) return fail(ctx, OUT_OF_DATE, '', keep);
    const was = fresh.webhook;
    const next: DiscordSettings = {
      ...fresh,
      webhook: {
        ...was,
        enabled: true,
        url: linkRaw !== '' ? cleanWebhookLink(linkRaw) : fresh.webhook.url,
        display_name: displayName,
        avatar_url: avatar,
        mention: mention.value,
        post_in: postIn,
        thread_id: threadId,
        // Bestätigt bleibt ein Thread nur, wenn sich nichts geändert hat; der Test-Beitrag im Forum gehört zum Webhook
        thread_verified: postIn === 'thread' && sameHook && was.post_in === 'thread' && was.thread_id === threadId && was.thread_verified,
        test_thread_id: sameHook && postIn === 'forum' ? was.test_thread_id : '',
      },
    };
    // Der alte Token wird gelöscht, sobald ein Webhook gespeichert ist – die Website hält dann keinen Bot-Token mehr
    const hadToken = fresh.bot_token !== '';
    next.bot_token = '';
    next.channel_id = '';
    next.mention = '';
    const tokenNote = hadToken ? ' The old bot token is deleted from the website.' : '';
    const threadNote = postIn === 'thread' && !next.webhook.thread_verified ? ' The thread is checked with the first post into it.' : '';

    if (reachable) {
      const data = res.data ?? {};
      const channel = typeof data.channel_id === 'string' && snowflake(data.channel_id) ? data.channel_id : '';
      // Der Bot postet schon in diesen Kanal (oder in diesen Thread): jedes Update käme zweimal
      const botChannel = next.bot.saved_at !== '' && next.bot.enabled ? next.bot.channel_id : '';
      if (botChannel !== '' && (botChannel === channel || (postIn === 'thread' && botChannel === threadId))) {
        return fail(ctx, 'The bot already posts into this channel – updates would show up twice.', 'webhook_link', keep);
      }
      next.webhook.hook_name = cleanText(typeof data.name === 'string' ? data.name : '', 100);
      next.webhook.hook_channel_id = channel;
      next.webhook.hook_guild_id = typeof data.guild_id === 'string' && snowflake(data.guild_id) ? data.guild_id : '';
      next.webhook.checked_at = date('Y-m-d H:i:s');
      next.webhook.check_error = '';
      await storeDiscordSettings(next);
      if (hadToken) await tokenRowsToBot(db, botSecret() !== '');
      const known = next.webhook.hook_name !== '' ? '“' + next.webhook.hook_name + '”' : 'this webhook';
      return ok('Webhook saved and checked – Discord knows it as ' + known + (channel !== '' ? ' (channel ' + channel + ')' : '') + '.' + threadNote + tokenNote);
    }
    // Discord gerade nicht erreichbar: speichern, aber sagen, dass nicht geprüft wurde
    const why = discordError(res, 'webhook');
    next.webhook.check_error = why;
    if (!sameHook) {
      next.webhook.hook_name = '';
      next.webhook.hook_channel_id = '';
      next.webhook.hook_guild_id = '';
      next.webhook.checked_at = '';
    }
    await storeDiscordSettings(next);
    if (hadToken) await tokenRowsToBot(db, botSecret() !== '');
    logDiscord('saved without a check: ' + why);
    return { tab: 'discord', error: 'Webhook saved, but Discord couldn’t be asked right now – ' + lowerFirst(why) + ' Use “Send test” to try it.' + threadNote + tokenNote };
  });
}

// „Couldn’t reach …“ → „couldn’t reach …“ mitten im Satz; „Discord …“ bleibt groß
const lowerFirst = (t: string): string => (t.startsWith('Discord') ? t : t.charAt(0).toLowerCase() + t.slice(1));

// discord_webhook_test: an den gespeicherten Webhook, so wie Updates gepostet würden (Kanal, Forum, Thread)
async function webhookTest(post: Record<string, unknown>, ctx?: Ctx): Promise<AdminResult> {
  const s = await discordSettings();
  const hook = parseWebhookLink(s.webhook.url);
  if (!hook) return fail(ctx, 'There is no webhook to test yet – paste a webhook link under “Post with a webhook” and save it.');
  if (!(await rateLimit('discord_test:' + adminKey(ctx), TEST_LIMIT, 60))) return fail(ctx, 'Please wait a minute before sending another test.');
  const payload = testPayload(s, 'webhook');

  if (s.webhook.post_in === 'forum') {
    if (s.webhook.test_thread_id !== '') {
      const res = await webhookPost(hook, payload, { threadId: s.webhook.test_thread_id });
      if (res.status >= 200 && res.status < 300) return ok('Test message sent – check your Discord channel.');
      if (res.status === 404 && res.code === 10003) {
        await patchWebhook(hook.id, (w) => {
          w.test_thread_id = '';
          return true;
        });
        return fail(ctx, 'The earlier test post was deleted in Discord – send the test again to create a new one.');
      }
      return fail(ctx, discordError(res, 'webhook'));
    }
    // Der erste Test in einem Forum legt einen Beitrag an – nur nach der Bestätigung
    if (post._confirmed !== '1') return fail(ctx, 'Please confirm the test post – in a forum it creates a post “OnYourSite test”.');
    const res = await webhookPost(hook, payload, { threadName: 'OnYourSite test' });
    if (res.status >= 200 && res.status < 300) {
      const thread = typeof res.data?.channel_id === 'string' && snowflake(res.data.channel_id) ? res.data.channel_id : '';
      if (thread !== '') {
        await patchWebhook(hook.id, (w) => {
          w.test_thread_id = thread;
          return true;
        });
      }
      return ok('Test message sent – check your Discord channel.');
    }
    return fail(ctx, discordError(res, 'webhook'));
  }

  const threadId = s.webhook.post_in === 'thread' ? s.webhook.thread_id : '';
  const res = await webhookPost(hook, payload, { threadId });
  if (res.status >= 200 && res.status < 300) {
    if (threadId !== '' && !s.webhook.thread_verified) {
      await patchWebhook(hook.id, (w) => {
        if (w.thread_id !== threadId) return false;
        w.thread_verified = true;
        return true;
      });
    }
    return ok('Test message sent – check your Discord channel.');
  }
  return fail(ctx, discordError(res, 'webhook'));
}

// discord_token_test: der alte Token in seinen Kanal (wie bisher)
async function tokenTest(ctx?: Ctx): Promise<AdminResult> {
  const s = await discordSettings();
  if (s.bot_token === '') return fail(ctx, 'There is no old bot token stored.');
  if (!tokenUsable(s)) return fail(ctx, 'The old bot token has no channel – delete it and use a webhook.');
  if (!(await rateLimit('discord_test:' + adminKey(ctx), TEST_LIMIT, 60))) return fail(ctx, 'Please wait a minute before sending another test.');
  const res = await discordRequest('POST', discordBase() + '/v10/channels/' + s.channel_id + '/messages', testPayload(s, 'token'), ['Authorization: Bot ' + s.bot_token]);
  if (res.status >= 200 && res.status < 300) return ok('Test message sent – check your Discord channel.');
  return fail(ctx, discordError(res, 'token'));
}


// ------------------------------------------------------------------ Der installierte Bot

const NO_BOT = 'The Discord bot isn’t set up on this server – run the server installer first, or post with a webhook.';
const OLD_BOT = 'The bot hasn’t reported its channels – it needs version 0.2.0 or newer. Update it, wait until it shows Online, then try again.';
// Felder des Bot-Formulars, die nach einem Fehler stehen bleiben
export const BOT_KEEP = ['bot_channel', 'bot_mention', 'bot_enabled'] as const;

// Fehler im Bot-Formular: wie fail(), die Werte stehen unter einem eigenen Schlüssel (das Webhook-Formular bleibt, wie es ist)
function failBot(ctx: Ctx | undefined, text: string, field: string, post: Record<string, unknown>): AdminResult {
  const keep: Record<string, string> = {};
  for (const k of BOT_KEEP) keep[k] = mbSubstr(str(post[k]), 0, 40);
  if (ctx?.session) ctx.session.set('discord_bot_keep', keep);
  return fail(ctx, text, field);
}

// Einstellungen gesperrt lesen (in der Transaktion des Aufrufers): zwei gleichzeitige Speichervorgänge überschreiben
// sich nicht gegenseitig
async function lockedSettings(db: Db): Promise<DiscordSettings> {
  const raw = await db.value("SELECT meta_value FROM oys_meta WHERE meta_key = 'discord' FOR UPDATE");
  return normalizeSettings(decodeStored(phpStr(raw ?? '')));
}

// Den Bot um einen neuen Bericht bitten: ein noch nicht abgeholter Auftrag wird ersetzt, ein toter beendet
async function queueReport(db: Db): Promise<void> {
  await supersede('report', 'bot.report', db);
  await db.exec("UPDATE community_outbox SET done_at = ? WHERE ref = 'report' AND action = 'bot.report' AND done_at IS NULL AND attempts >= 10", [date('Y-m-d H:i:s')]);
  await outboxAdd('bot.report', {}, { ref: 'report', db });
}

// discord_bot_save: Kanal und Ping aus dem Bericht des Bots, ein/aus. Eingeschaltet geht der alte Token (der Bot
// übernimmt dessen Beiträge); danach meldet der Bot seine Kanäle neu („Checking with the bot…“).
async function botSave(post: Record<string, unknown>, ctx?: Ctx): Promise<AdminResult> {
  if (botSecret() === '') return fail(ctx, NO_BOT);
  const rep = await report();
  if (!rep || !rep.features.includes('updates.v1')) return fail(ctx, OLD_BOT);
  const enabled = phpTruthy(post.bot_enabled);
  const channel = phpTrim(str(post.bot_channel));
  const mention = parseMention(post.bot_mention);
  if ('error' in mention) return failBot(ctx, 'Ping: choose Nobody, @everyone, @here or a role.', 'bot_mention', post);
  let name = '';
  let type = '';
  if (enabled) {
    const choice = checkBotChoice(rep, channel, mention.value);
    if (!choice.ok) return failBot(ctx, choice.error, choice.field, post);
    name = choice.place.name;
    type = choice.place.type;
  } else if (channel !== '' && !snowflake(channel)) {
    return failBot(ctx, 'Channel: choose where the bot posts updates.', 'bot_channel', post);
  }
  const outcome = await withRetry(async (db): Promise<{ error: string } | { hadToken: boolean }> => {
    const s = await lockedSettings(db);
    if (enabled && webhookPostsInto(s, channel)) {
      return { error: 'The webhook already posts into this channel – updates would show up twice. Choose another channel for the bot, or remove the webhook.' };
    }
    const kept = channel !== '' ? channel : s.bot.channel_id;
    s.bot = {
      enabled,
      channel_id: kept,
      channel_type: enabled ? type : placeOf(rep, kept)?.type ?? s.bot.channel_type,
      mention: mention.value,
      saved_at: date('Y-m-d H:i:s'),
    };
    // Wer auf den Bot umstellt, braucht den alten Token nicht mehr – die Website hält dann keinen Bot-Token
    const hadToken = enabled && s.bot_token !== '';
    if (hadToken) {
      s.bot_token = '';
      s.channel_id = '';
      s.mention = '';
    }
    await storeDiscordSettings(s);
    if (hadToken) await tokenRowsToBot(db, true);
    await queueReport(db);
    return { hadToken };
  });
  if ('error' in outcome) return failBot(ctx, outcome.error, 'bot_channel', post);
  if (!enabled) return ok('The bot no longer announces new updates.');
  // Ein Bot, der gerade nicht erreichbar ist, prüft den Kanal erst, wenn er wieder da ist
  const online = (await botStatus()).online;
  return ok(`Saved – the bot checks #${name} ${online ? 'now' : 'when it’s back online'}.` + (outcome.hadToken ? ' The old bot token is deleted from the website.' : ''));
}

// discord_bot_test: Testnachricht über den Bot in seinen Kanal (gespeichert, sonst #updates). Ein Test, den der Bot
// noch nicht abgeholt hat oder der schon gescheitert ist, wird ersetzt; nach 2 Minuten verfällt er.
async function botTest(post: Record<string, unknown>, ctx?: Ctx): Promise<AdminResult> {
  if (botSecret() === '') return fail(ctx, NO_BOT);
  const rep = await report();
  if (!rep || !rep.features.includes('updates.v1')) return fail(ctx, OLD_BOT);
  const s = await discordSettings();
  const channel = s.bot.saved_at !== '' ? s.bot.channel_id : rep.updates_channel_id;
  if (channel === '') return fail(ctx, 'Choose a channel for the bot and save it first – then send a test.');
  const place = placeOf(rep, channel);
  if (!place) return fail(ctx, 'The bot doesn’t list its channel any more – choose another one and save, or use “Refresh list”.');
  if (!place.can_post) return fail(ctx, cantPost(place));
  // In einem Forum legt jeder Test einen Beitrag an – nur nach der Rückfrage
  if (place.type === 'forum' && post._confirmed !== '1') return fail(ctx, 'Please confirm the test – in a forum channel it creates a post “OnYourSite test”.');
  if (!(await rateLimit('discord_test:' + adminKey(ctx), TEST_LIMIT, 60))) return fail(ctx, 'Please wait a minute before sending another test.');
  const st = await botStatus();
  const now = date('Y-m-d H:i:s');
  await withRetry(async (db) => {
    await db.exec(
      "UPDATE community_outbox SET done_at = ?, last_error = COALESCE(last_error, 'superseded') WHERE ref = 'test' AND action = 'update.test' AND done_at IS NULL AND (claimed_at IS NULL OR attempts > 0)",
      [now],
    );
    const jobId = await outboxAdd('update.test', { channel_id: place.id, kind: place.type, message: buildTestPayload(styleOf(s, 'bot'), 'bot') }, { ref: 'test', db });
    await db.exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('discord_bot_test', ?)",
      [phpJson({ at: now, state: 'queued', job_id: jobId, channel_id: place.id, error: '' }, { unescapedUnicode: true, unescapedSlashes: true })]);
  });
  return ok(st.online ? 'Test message queued – the bot posts it within a few seconds.' : 'Test message queued – the bot is offline right now; it posts it only if it’s back within 2 minutes.');
}

// discord_bot_refresh: der Bot schickt seine Kanäle neu
async function botRefresh(ctx?: Ctx): Promise<AdminResult> {
  if (botSecret() === '') return fail(ctx, NO_BOT);
  const st = await botStatus();
  await withRetry((db) => queueReport(db));
  if (!st.canPostUpdates) return ok('Checking again – once the bot runs version 0.2.0 or newer, it sends its channel list within a few seconds.');
  return ok(st.online ? 'The bot sends its channel list within a few seconds.' : 'The bot is offline right now – it sends its channel list when it’s back.');
}

// ------------------------------------------------------------------ Karte „Discord posts“ und die Chips der Updates

// Zurück in den Bereich, aus dem der Knopf kam
const backTab = (post: Record<string, unknown>): string => (post.back === 'updates' ? 'updates' : 'discord');

// discord_post_retry: ein fehlgeschlagener Beitrag (neu posten), ein nicht geänderter (Änderung noch einmal) oder einer,
// der nicht entfernt werden konnte (noch einmal entfernen). Wie die Update-Aktionen je Update nacheinander.
async function postRetry(post: Record<string, unknown>, _ctx?: Ctx): Promise<AdminResult> {
  const tab = backTab(post);
  const id = intval(post.id ?? 0);
  const row = id > 0 ? await one('SELECT update_id FROM update_discord_posts WHERE id = ?', [id]) : null;
  if (!row) return { tab, error: 'This Discord post is no longer listed.' };
  try {
    const res = await withNamedLock(configString('db.name') + ':discord_update:' + intval(row.update_id), 0, async () => retry(id, await delivery()), 'fail');
    return res.ok ? { tab, ok: res.text } : { tab, error: res.text };
  } catch (err) {
    if (err instanceof LockBusyError) return { tab, error: TEXTS.alreadyPosting };
    throw err;
  }
}

// discord_post_forget: die Zeile vergessen (die Nachricht bleibt in Discord); nur nach der Rückfrage
async function postForget(post: Record<string, unknown>, _ctx?: Ctx): Promise<AdminResult> {
  const tab = backTab(post);
  if (post._confirmed !== '1') return { tab, error: 'Please confirm forgetting this post.' };
  const res = await forget(intval(post.id ?? 0));
  return res.ok ? { tab, ok: res.text } : { tab, error: res.text };
}

// discord_job_dismiss: einen toten Auftrag ohne eigenen Beitrag ausblenden (Bericht, Test, Richtlinien-Satz)
async function jobDismiss(post: Record<string, unknown>, ctx?: Ctx): Promise<AdminResult> {
  const id = intval(post.id ?? 0);
  const done = id > 0 && await withRetry(async (db) => {
    const job = await db.one('SELECT id, action, attempts, done_at FROM community_outbox WHERE id = ? FOR UPDATE', [id]);
    if (!job || job.done_at !== null || intval(job.attempts) < 10 || !DISMISSABLE_JOBS.includes(phpStr(job.action))) return false;
    await db.exec('UPDATE community_outbox SET done_at = ? WHERE id = ? AND done_at IS NULL', [date('Y-m-d H:i:s'), id]);
    return true;
  });
  return done ? ok('Dismissed – the bot won’t try this again.') : fail(ctx, 'This can’t be dismissed – it is done or the bot is still trying.');
}
