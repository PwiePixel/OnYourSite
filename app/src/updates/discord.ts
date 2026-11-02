// Updates in Discord ankündigen, nachziehen und entfernen (lib/updates.php, Discord-Teil) – über den gespeicherten
// Webhook (in den Kanal, als neuer Forenbeitrag oder in einen Thread) oder, solange er noch da ist, den alten
// Bot-Token. Anfragen, Einstellungen und Fehlertexte stehen in app/src/discord/; die Namen von früher bleiben hier
// erhalten, damit Code, der gegen die Portierung geschrieben ist, weiter passt.
//
// updates.discord_target: 'webhook:{webhookId}' (Nachricht im Kanal), 'webhook:{webhookId}:{threadId}' (in einem
// Thread oder Forenbeitrag – bei einem Forenbeitrag ist die Thread-ID die ID seiner ersten Nachricht) oder
// 'bot:{channelId}' (alter Bot-Token).
import { exec } from '../db.js';
import { gmdate, mbStrlen, mbSubstr, phpRtrim, phpStr, phpTrim, phpTruthy, strtotime } from '../php.js';
import { UPDATE_CATEGORIES, updateUrl, type Update } from './updates.js';
import { discordBase, discordError, discordRequest, type DiscordResponse, type Payload, type Via } from '../discord/rest.js';
import {
  activeDestination, discordConfigured, discordDefaults, discordSettings, storeDiscordSettings, webhookName, type DiscordSettings,
} from '../discord/settings.js';
import { parseWebhookLink, webhookDelete, webhookEdit, webhookPost, type WebhookLink } from '../discord/webhook.js';

export { discordBase, discordConfigured, discordDefaults, discordError, discordRequest, discordSettings };
export type { DiscordResponse, DiscordSettings, Payload };
export const discordStore = storeDiscordSettings;

export interface DiscordTarget { key: string; via: Via; hook: WebhookLink | null; channel: string }
export interface DiscordSent { ok: boolean; id: string; target: string; error: string | null }
// state: ok | missing (in Discord schon gelöscht) | unreachable (anderer Webhook/Bot, Webhook/Kanal gelöscht)
//        | disconnected (Discord nicht verbunden) | failed (z. B. Zeitüberschreitung, Rate-Limit, fehlende Rechte)
export interface DiscordChange { state: 'ok' | 'missing' | 'unreachable' | 'disconnected' | 'failed'; error: string | null; transient: boolean }

// oys_discord_parse_webhook() für ältere Aufrufer: [id, token] oder null
export function discordParseWebhook(url: string): [string, string] | null {
  const hook = parseWebhookLink(url);
  return hook ? [hook.id, hook.token] : null;
}

// oys_discord_target(): das gerade gewählte Ziel
export function discordTarget(s: DiscordSettings): DiscordTarget | null {
  const dest = activeDestination(s);
  if (dest === 'token') return { key: 'bot:' + s.channel_id, via: 'token', hook: null, channel: s.channel_id };
  const hook = dest === 'webhook' ? parseWebhookLink(s.webhook_url) : null;
  return hook ? { key: 'webhook:' + hook.id, via: 'webhook', hook, channel: '' } : null;
}

// Gespeichertes Ziel einer Nachricht → Teile (null = unbekanntes Format)
export function storedTarget(target: string): { via: Via; id: string; threadId: string } | null {
  let m = /^webhook:(\d{5,25})(?::(\d{15,25}))?$/.exec(target);
  if (m) return { via: 'webhook', id: m[1], threadId: m[2] ?? '' };
  m = /^bot:(\d{15,25})$/.exec(target);
  return m ? { via: 'token', id: m[1], threadId: '' } : null;
}

// Name eines Forenbeitrags für ein Update (höchstens 100 Zeichen)
export function threadName(u: Update): string {
  return mbSubstr((u.version !== '' ? u.version + ' – ' : '') + u.title, 0, 100);
}

const tokenUrl = (channel: string): string => discordBase() + '/v10/channels/' + channel + '/messages';
const ok2xx = (res: DiscordResponse): boolean => res.status >= 200 && res.status < 300;

// oys_discord_update_payload(): Embed mit Titel, Text, Farbe der Kategorie und Link zur Seite
export function discordUpdatePayload(u: Update, s: DiscordSettings): Payload {
  const cat = Object.hasOwn(UPDATE_CATEGORIES, u.category) ? UPDATE_CATEGORIES[u.category] : UPDATE_CATEGORIES.news;
  const url = updateUrl(u.id);
  const title = (u.version !== '' ? u.version + ' – ' : '') + u.title;
  let desc = phpTrim(u.body);
  if (mbStrlen(desc) > 3800) desc = phpRtrim(mbSubstr(desc, 0, 3800)) + '…\n\n[Read the full update](' + url + ')';
  const when = strtotime(phpTruthy(u.published_at) ? (u.published_at as string) : 'now');
  const embed: Payload = {
    title: mbSubstr(title, 0, 256),
    url,
    color: parseInt(cat.color.replace(/^#+/, ''), 16),
    author: { name: cat.label },
    footer: { text: 'OnYourSite Updates' },
    timestamp: gmdate('Y-m-d\\TH:i:s\\Z', when === false ? 0 : when),
  };
  if (desc !== '') embed.description = desc;
  return discordWithMention({ embeds: [embed] }, s);
}

// oys_discord_with_mention(): Ping und Absender; Reihenfolge embeds, allowed_mentions, content, username, avatar_url.
// Name und Bild nur für den Webhook – ein Name, den Discord ablehnt, bleibt weg (webhookName).
export function discordWithMention(payload: Payload, s: DiscordSettings, via: Via | null = activeDestination(s)): Payload {
  const p: Payload = { ...payload, allowed_mentions: { parse: [] } };
  const mention = s.mention;
  if (mention === 'everyone' || mention === 'here') {
    p.content = '@' + mention;
    p.allowed_mentions = { parse: ['everyone'] };
  } else if (mention !== '') {
    p.content = '<@&' + mention + '>';
    p.allowed_mentions = { parse: [], roles: [mention] };
  }
  if (via === 'webhook') {
    const name = webhookName(s);
    if (name !== '') p.username = name;
    if (s.avatar_url !== '') p.avatar_url = s.avatar_url;
  }
  return p;
}

// oys_discord_send(): neue Nachricht – beim Webhook dorthin, wo er postet (Kanal, neuer Forenbeitrag, Thread)
export async function discordSend(s: DiscordSettings, payload: Payload, opts: { threadName?: string } = {}): Promise<DiscordSent> {
  const t = discordTarget(s);
  if (!t) return { ok: false, id: '', target: '', error: 'Discord isn’t set up yet (Admin → Discord).' };
  if (t.via === 'token') {
    const res = await discordRequest('POST', tokenUrl(t.channel), payload, ['Authorization: Bot ' + s.bot_token]);
    if (ok2xx(res)) return { ok: true, id: phpStr(res.data?.id ?? ''), target: t.key, error: null };
    return { ok: false, id: '', target: '', error: discordError(res, 'token') };
  }
  const hook = t.hook as WebhookLink;
  let res: DiscordResponse;
  if (s.post_in === 'forum') res = await webhookPost(hook, payload, { threadName: opts.threadName ?? 'OnYourSite' });
  else if (s.post_in === 'thread') res = await webhookPost(hook, payload, { threadId: s.thread_id });
  else res = await webhookPost(hook, payload);
  if (!ok2xx(res)) return { ok: false, id: '', target: '', error: discordError(res, 'webhook') };
  const id = phpStr(res.data?.id ?? '');
  const channel = phpStr(res.data?.channel_id ?? '');
  let thread = '';
  if (s.post_in === 'forum') thread = /^\d{15,25}$/.test(channel) ? channel : id;
  else if (s.post_in === 'thread') {
    thread = s.thread_id;
    // Der erste Beitrag in den Thread hat geklappt: der Thread ist bestätigt
    if (!s.thread_verified) {
      const fresh = await discordSettings();
      if (fresh.thread_id === s.thread_id && !fresh.thread_verified) await storeDiscordSettings({ ...fresh, thread_verified: true });
    }
  }
  return { ok: true, id, target: t.key + (thread !== '' ? ':' + thread : ''), error: null };
}

// oys_discord_change(): bestehende Nachricht ändern (Payload) oder löschen (null) – nur über dasselbe Ziel,
// über das sie gesendet wurde (beim Webhook: derselbe Webhook, auch mit neuem Token)
export async function discordChange(s: DiscordSettings, target: string, messageId: string, payload: Payload | null): Promise<DiscordChange> {
  const t = discordTarget(s);
  if (!t) return { state: 'disconnected', error: 'Discord isn’t connected', transient: false };
  const st = storedTarget(target);
  const same = !!st && st.via === t.via && st.id === (t.via === 'webhook' ? (t.hook as WebhookLink).id : t.channel);
  if (!same) return { state: 'unreachable', error: 'it was posted through a different webhook or bot', transient: false };
  if (!/^\d{5,25}$/.test(messageId)) return { state: 'missing', error: null, transient: false };
  let body = payload;
  if (body !== null) {
    // Beim Bearbeiten nur die Nachricht selbst ändern – Ping, Absender und Titel des Beitrags bleiben
    body = { ...body };
    delete body.content;
    delete body.allowed_mentions;
    delete body.username;
    delete body.avatar_url;
    delete body.thread_name;
  }
  let res: DiscordResponse;
  if (t.via === 'webhook') {
    const hook = t.hook as WebhookLink;
    res = body === null ? await webhookDelete(hook, messageId, st!.threadId) : await webhookEdit(hook, messageId, body, st!.threadId);
  } else {
    res = await discordRequest(body === null ? 'DELETE' : 'PATCH', tokenUrl(t.channel) + '/' + messageId, body, ['Authorization: Bot ' + s.bot_token]);
  }
  if (ok2xx(res)) return { state: 'ok', error: null, transient: false };
  if (res.status === 404 && res.code === 10008) return { state: 'missing', error: null, transient: false };
  if (res.status === 404 && (res.code === 10003 || res.code === 10015)) return { state: 'unreachable', error: discordError(res, t.via), transient: false };
  return { state: 'failed', error: discordError(res, t.via), transient: res.status === 0 || res.status === 429 || res.status >= 500 };
}

// oys_discord_announce_update(): neue Nachricht mit Ping; hat das Update schon eine, wird nur diese aktualisiert.
// Gibt eine Fehlermeldung oder null zurück.
export async function discordAnnounceUpdate(u: Update, s: DiscordSettings): Promise<string | null> {
  if (u.discord_message_id !== '') {
    const res = await discordSyncUpdate(u, s);
    if (res.state !== 'missing' && res.state !== 'unreachable') return res.state === 'ok' ? null : phpRtrim(phpStr(res.error), '.') + '.';
    // In Discord gelöscht oder über ein anderes Ziel gesendet → neu ankündigen
  }
  const sent = await discordSend(s, discordUpdatePayload(u, s), { threadName: threadName(u) });
  if (!sent.ok) return sent.error;
  await exec('UPDATE updates SET discord_message_id = ?, discord_target = ? WHERE id = ?', [sent.id, sent.target, u.id]);
  return null;
}

// oys_discord_sync_update(): geändertes Update in seiner Nachricht nachziehen – postet nie neu
export async function discordSyncUpdate(u: Update, s: DiscordSettings): Promise<DiscordChange> {
  const res = await discordChange(s, u.discord_target, u.discord_message_id, discordUpdatePayload(u, s));
  if (res.state === 'missing' || res.state === 'unreachable') await discordForget(u.id);
  return res;
}

// oys_discord_remove_update(): die gemerkte Nachricht wird nur vergessen, wenn sie wirklich weg ist oder von hier nie
// mehr erreicht werden kann – sonst bleibt sie für einen neuen Versuch
export async function discordRemoveUpdate(u: Update, s: DiscordSettings): Promise<DiscordChange> {
  if (u.discord_message_id === '') return { state: 'ok', error: null, transient: false };
  const res = await discordChange(s, u.discord_target, u.discord_message_id, null);
  if (res.state === 'ok' || res.state === 'missing' || res.state === 'unreachable') await discordForget(u.id);
  return res;
}

// oys_discord_forget()
export async function discordForget(id: number): Promise<void> {
  await exec('UPDATE updates SET discord_message_id = NULL, discord_target = NULL WHERE id = ?', [id]);
}

// oys_discord_remove_note(): Hinweis, wenn eine Nachricht nicht (sicher) entfernt wurde. '' = alles erledigt.
export function discordRemoveNote(res: DiscordChange, deleted = false): string {
  if (res.state === 'ok' || res.state === 'missing') return '';
  if (res.state === 'disconnected') {
    return 'Discord isn’t connected, so its post there was not removed' + (deleted ? ' – please delete it in Discord yourself.' : '.');
  }
  if (res.state === 'unreachable' || deleted) {
    return 'Its Discord post couldn’t be removed (' + phpRtrim(phpStr(res.error), '.') + ') – please delete it in Discord yourself.';
  }
  return 'But Discord: ' + phpStr(res.error);
}
