// Discord-Einstellungen (verschlüsselt in oys_meta 'discord', Form v2) und die Regeln für ihre Felder.
// Ziele für Ankündigungen: der installierte Bot (bot), ein Webhook (webhook) und – nur solange er noch gespeichert
// ist – der alte Bot-Token (bot_token mit seinem Kanal und Ping). Neue Bot-Tokens nimmt die Website nicht mehr an.
// Werte der alten, flachen Form (v1, z. B. aus einer alten Sicherung) wandelt discordSettingsFromV1() beim Lesen um;
// gespeichert wird immer v2.
import { exec, value } from '../db.js';
import { decryptData, encryptData } from '../crypto.js';
import { cleanText } from '../helpers.js';
import { phpJson } from '../html.js';
import { mbStrlen, phpStr, phpTruthy, strtolower } from '../php.js';
import { parseWebhookLink, type WebhookLink } from './webhook.js';

export interface BotSettings {
  enabled: boolean; // neue Updates mit dem Bot ankündigen (gilt erst, wenn saved_at gesetzt ist)
  channel_id: string;
  channel_type: string; // text | announcement | forum | thread (beim Speichern aus dem Bericht)
  mention: string; // '' | everyone | here | Rollen-ID
  saved_at: string; // '' = vom Admin noch nie gespeichert: dann gilt der Kanal #updates aus dem Bericht des Bots
}

export interface WebhookSettings {
  enabled: boolean;
  url: string;
  post_in: string; // channel | forum | thread
  thread_id: string;
  thread_verified: boolean; // erster Beitrag in den Thread hat geklappt
  test_thread_id: string; // Forenbeitrag „OnYourSite test“ für weitere Tests
  display_name: string;
  avatar_url: string;
  mention: string;
  checked_at: string; // letzte erfolgreiche Prüfung bei Discord ('Y-m-d H:i:s')
  check_error: string; // Discord war beim Speichern nicht erreichbar
  hook_name: string;
  hook_channel_id: string;
  hook_guild_id: string;
}

export interface DiscordSettings {
  v: 2;
  auto_post: boolean;
  invite_url: string;
  bot: BotSettings;
  webhook: WebhookSettings;
  // Alter Bot-Token (Einrichtung von früher): Token, Kanal und Ping – nur bis zum Wechsel auf den Bot oder einen Webhook
  bot_token: string;
  channel_id: string;
  mention: string;
}

// Die alte, flache Form (bis zur Umstellung auf v2)
export interface DiscordSettingsV1 {
  mode: string; // 'webhook' | 'bot' (= alter Bot-Token)
  webhook_url: string;
  bot_token: string;
  channel_id: string;
  mention: string;
  username: string;
  avatar_url: string;
  invite_url: string;
  auto_post: boolean;
  post_in: string;
  thread_id: string;
  thread_verified: boolean;
  test_thread_id: string;
  checked_at: string;
  check_error: string;
  hook_name: string;
  hook_channel_id: string;
  hook_guild_id: string;
}

export type Destination = 'webhook' | 'token';
export const POST_IN = ['channel', 'forum', 'thread'] as const;
export const CHANNEL_TYPES = ['text', 'announcement', 'forum', 'thread'] as const;

export function botDefaults(): BotSettings {
  return { enabled: false, channel_id: '', channel_type: '', mention: '', saved_at: '' };
}

export function webhookDefaults(): WebhookSettings {
  return {
    enabled: false, url: '', post_in: 'channel', thread_id: '', thread_verified: false, test_thread_id: '', display_name: '', avatar_url: '',
    mention: '', checked_at: '', check_error: '', hook_name: '', hook_channel_id: '', hook_guild_id: '',
  };
}

// Die Reihenfolge der Schlüssel bestimmt auch das gespeicherte JSON
export function discordDefaults(): DiscordSettings {
  return { v: 2, auto_post: true, invite_url: '', bot: botDefaults(), webhook: webhookDefaults(), bot_token: '', channel_id: '', mention: '' };
}

// oys_discord_defaults() der alten Form
export function discordDefaultsV1(): DiscordSettingsV1 {
  return {
    mode: 'webhook', webhook_url: '', bot_token: '', channel_id: '', mention: '', username: '', avatar_url: '', invite_url: '', auto_post: true,
    post_in: 'channel', thread_id: '', thread_verified: false, test_thread_id: '', checked_at: '', check_error: '',
    hook_name: '', hook_channel_id: '', hook_guild_id: '',
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

// Bekannte Schlüssel in die Typen der Vorlage bringen (ältere oder fremde Werte machen nichts kaputt)
function fill<T extends object>(template: T, data: unknown): T {
  const out = template as Record<string, unknown>;
  if (!isObject(data)) return template;
  for (const key of Object.keys(out)) {
    if (!Object.hasOwn(data, key)) continue;
    const v = data[key];
    if (typeof out[key] === 'boolean') out[key] = phpTruthy(v);
    else if (typeof out[key] === 'string' && (typeof v === 'string' || typeof v === 'number')) out[key] = String(v);
  }
  return template;
}

// Gespeicherte Werte der alten Form in ihre Typen bringen
export function normalizeV1(data: unknown): DiscordSettingsV1 {
  const out = fill(discordDefaultsV1(), data);
  if (!(POST_IN as readonly string[]).includes(out.post_in)) out.post_in = 'channel';
  return out;
}

// Gespeicherte Werte (v2 oder älter) → v2
export function normalizeSettings(data: unknown): DiscordSettings {
  if (!isObject(data) || data.v !== 2) return discordSettingsFromV1(normalizeV1(data));
  const s = discordDefaults();
  s.auto_post = Object.hasOwn(data, 'auto_post') ? phpTruthy(data.auto_post) : true;
  for (const key of ['invite_url', 'bot_token', 'channel_id', 'mention'] as const) {
    const v = data[key];
    if (typeof v === 'string' || typeof v === 'number') s[key] = String(v);
  }
  s.bot = fill(botDefaults(), data.bot);
  s.webhook = fill(webhookDefaults(), data.webhook);
  if (!(POST_IN as readonly string[]).includes(s.webhook.post_in)) s.webhook.post_in = 'channel';
  if (!(CHANNEL_TYPES as readonly string[]).includes(s.bot.channel_type)) s.bot.channel_type = '';
  return s;
}

// discordSettingsFromV1(): die alte Form umwandeln.
// - Ein gültiger Webhook-Link wird zum Webhook – eingeschaltet, solange nicht der alte Token gewählt war (mode=bot mit
//   Token); sonst bleibt er ausgeschaltet gespeichert.
// - Der alte Token bleibt mit Kanal und Ping das Ziel „token“, bis der Admin den Bot oder einen Webhook speichert.
// - Ein Anzeigename, den Discord ablehnt (z. B. die Login-E-Mail aus einem Passwort-Manager), fällt weg.
// - mode=bot: Kanal und Ping werden für den Bot vorgemerkt; eingeschaltet ist der Bot damit nicht.
export function discordSettingsFromV1(v1: DiscordSettingsV1): DiscordSettings {
  const s = discordDefaults();
  s.auto_post = v1.auto_post;
  s.invite_url = v1.invite_url;
  const tokenChosen = v1.mode === 'bot' && v1.bot_token !== '';
  if (parseWebhookLink(v1.webhook_url)) {
    s.webhook = {
      enabled: !tokenChosen,
      url: v1.webhook_url,
      post_in: v1.post_in,
      thread_id: v1.thread_id,
      thread_verified: v1.thread_verified,
      test_thread_id: v1.test_thread_id,
      display_name: displayNameProblem(v1.username) === null ? v1.username : '',
      avatar_url: v1.avatar_url,
      mention: v1.mention,
      checked_at: v1.checked_at,
      check_error: v1.check_error,
      hook_name: v1.hook_name,
      hook_channel_id: v1.hook_channel_id,
      hook_guild_id: v1.hook_guild_id,
    };
  }
  if (v1.bot_token !== '') {
    s.bot_token = v1.bot_token;
    s.channel_id = v1.channel_id;
    s.mention = v1.mention;
  }
  if (v1.mode === 'bot') {
    s.bot.channel_id = v1.channel_id;
    s.bot.mention = v1.mention;
  }
  return s;
}

// Rohwert aus oys_meta (verschlüsselt oder nicht) → Daten; ein falscher Schlüssel oder kaputter Wert ergibt null
export function decodeStored(raw: string): unknown {
  if (raw === '') return null;
  try {
    return JSON.parse(phpStr(decryptData(raw)));
  } catch {
    return null;
  }
}

// oys_discord_settings(): ein falscher Schlüssel oder kaputter Wert ergibt die Vorgaben
export async function discordSettings(): Promise<DiscordSettings> {
  return normalizeSettings(decodeStored(phpStr(await value("SELECT meta_value FROM oys_meta WHERE meta_key = 'discord'"))));
}

// Gespeicherte Form (v2, verschlüsselt)
export function encodeSettings(s: DiscordSettings): string {
  return String(encryptData(phpJson(normalizeSettings(s), { unescapedSlashes: true })));
}

// oys_discord_store(): null = alles entfernen
export async function storeDiscordSettings(s: DiscordSettings | null): Promise<void> {
  if (s === null) {
    await exec("DELETE FROM oys_meta WHERE meta_key = 'discord'");
    return;
  }
  await exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('discord', ?)", [encodeSettings(s)]);
}

// Der eingeschaltete Webhook (gültiger Link) oder null
export function activeWebhook(s: DiscordSettings): WebhookLink | null {
  return s.webhook.enabled ? parseWebhookLink(s.webhook.url) : null;
}

// Der alte Token kann neue Updates posten, solange er einen Kanal hat
export function tokenUsable(s: DiscordSettings): boolean {
  return s.bot_token !== '' && s.channel_id !== '';
}

// Ziele der Website selbst (Webhook, alter Token) – den Bot entscheidet botTarget() mit seinem Bericht
export function siteDestinations(s: DiscordSettings): Destination[] {
  const out: Destination[] = [];
  if (activeWebhook(s)) out.push('webhook');
  if (tokenUsable(s)) out.push('token');
  return out;
}

// Das erste Ziel der Website (für Anzeigen, die nur eines kennen)
export function activeDestination(s: DiscordSettings): Destination | null {
  return siteDestinations(s)[0] ?? null;
}

// Discord-ID (Snowflake)
export function snowflake(v: string): boolean {
  return /^\d{15,25}$/.test(v);
}

// Anzeigename des Webhooks nach Discords Regeln; leer ist erlaubt (dann der Name aus Discord)
export function displayNameProblem(name: string): string | null {
  if (name === '') return null;
  if (mbStrlen(name) > 80) return 'Display name: at most 80 characters.';
  for (const bad of ['@', '#', ':', '```']) {
    if (name.includes(bad)) return 'Display name: Discord doesn’t allow “' + bad + '” in names.';
  }
  const lower = strtolower(name);
  for (const word of ['discord', 'clyde']) {
    if (lower.includes(word)) return 'Display name: Discord doesn’t allow the word “' + word + '” in names.';
  }
  if (lower === 'everyone' || lower === 'here') return 'Display name: Discord doesn’t allow the name “' + lower + '”.';
  return null;
}

// Eingabe für den Anzeigenamen: Steuerzeichen weg, Leerraum am Rand weg (Länge prüft displayNameProblem)
export function displayNameInput(raw: unknown): string {
  return cleanText(typeof raw === 'string' ? raw : '', 1000);
}

// Der Name, mit dem der Webhook postet: ein gespeicherter Name, den Discord ablehnt, bleibt weg – sonst scheiterte
// jeder Beitrag mit „Invalid Form Body“. Discord nimmt dann den Namen des Webhooks.
export function webhookName(s: DiscordSettings): string {
  const name = s.webhook.display_name;
  return name !== '' && displayNameProblem(name) === null ? name : '';
}

// Rand aus Leerraum und @ < & > – Zeichen für Zeichen: ein Regex wie /[\s@<&>]+$/ bräuchte bei einer langen
// Leerzeichenfolge vor einem anderen Zeichen quadratisch viele Schritte (20 MB Eingabe = der Server steht still)
const MENTION_EDGE = /^[\s@<&>]$/;
function trimMentionEdges(v: string): string {
  let a = 0;
  let b = v.length;
  while (a < b && MENTION_EDGE.test(v[a])) a++;
  while (b > a && MENTION_EDGE.test(v[b - 1])) b--;
  return v.slice(a, b);
}

// Ping: niemand, @everyone, @here oder eine Rollen-ID (auch als <@&ID> oder @ID eingegeben)
export function parseMention(raw: unknown): { value: string } | { error: string } {
  const v = strtolower(trimMentionEdges(typeof raw === 'string' ? raw : ''));
  if (v === '' || v === 'everyone' || v === 'here' || snowflake(v)) return { value: v };
  return { error: 'Ping: enter a role ID, “everyone” or “here” – or leave it empty.' };
}
