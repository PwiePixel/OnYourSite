// Discord-Einstellungen (verschlüsselt in oys_meta 'discord') und die Regeln für ihre Felder.
// Ziel der Ankündigungen ist der Webhook – oder, solange noch einer gespeichert ist, der alte Bot-Token (mode 'bot').
// Neue Bot-Tokens nimmt die Website nicht mehr an; der installierte Bot braucht keinen.
import { exec, value } from '../db.js';
import { decryptData, encryptData } from '../crypto.js';
import { cleanText } from '../helpers.js';
import { phpJson } from '../html.js';
import { mbStrlen, phpStr, phpTruthy, strtolower } from '../php.js';
import { parseWebhookLink } from './webhook.js';

export interface DiscordSettings {
  mode: string; // 'webhook' | 'bot' (= alter Bot-Token)
  webhook_url: string;
  bot_token: string;
  channel_id: string; // Kanal des alten Bot-Tokens
  mention: string; // '' | everyone | here | Rollen-ID
  username: string; // Anzeigename des Webhooks
  avatar_url: string;
  invite_url: string;
  auto_post: boolean;
  post_in: string; // channel | forum | thread
  thread_id: string;
  thread_verified: boolean; // erster Beitrag in den Thread hat geklappt
  test_thread_id: string; // Forenbeitrag „OnYourSite test“ für weitere Tests
  checked_at: string; // letzte erfolgreiche Prüfung bei Discord ('Y-m-d H:i:s')
  check_error: string; // Discord war beim Speichern nicht erreichbar
  hook_name: string;
  hook_channel_id: string;
  hook_guild_id: string;
}

export type Destination = 'webhook' | 'token';
export const POST_IN = ['channel', 'forum', 'thread'] as const;

// oys_discord_defaults() – die Reihenfolge der Schlüssel bestimmt auch das gespeicherte JSON
export function discordDefaults(): DiscordSettings {
  return {
    mode: 'webhook', webhook_url: '', bot_token: '', channel_id: '', mention: '', username: '', avatar_url: '', invite_url: '', auto_post: true,
    post_in: 'channel', thread_id: '', thread_verified: false, test_thread_id: '', checked_at: '', check_error: '',
    hook_name: '', hook_channel_id: '', hook_guild_id: '',
  };
}

// Gespeicherte Werte in die erwarteten Typen bringen (ältere oder fremde Werte machen nichts kaputt)
export function normalizeSettings(data: unknown): DiscordSettings {
  const s = discordDefaults() as unknown as Record<string, unknown>;
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    for (const key of Object.keys(s)) {
      if (!Object.hasOwn(data, key)) continue;
      const v = (data as Record<string, unknown>)[key];
      if (typeof s[key] === 'boolean') s[key] = phpTruthy(v);
      else if (typeof v === 'string' || typeof v === 'number') s[key] = String(v);
    }
  }
  const out = s as unknown as DiscordSettings;
  if (!(POST_IN as readonly string[]).includes(out.post_in)) out.post_in = 'channel';
  return out;
}

// oys_discord_settings(): ein falscher Schlüssel oder kaputter Wert ergibt die Vorgaben
export async function discordSettings(): Promise<DiscordSettings> {
  const raw = phpStr(await value("SELECT meta_value FROM oys_meta WHERE meta_key = 'discord'"));
  let data: unknown = null;
  if (raw !== '') {
    try {
      data = JSON.parse(phpStr(decryptData(raw)));
    } catch {
      data = null;
    }
  }
  return normalizeSettings(data);
}

// oys_discord_store(): null = alles entfernen
export async function storeDiscordSettings(s: DiscordSettings | null): Promise<void> {
  if (s === null) {
    await exec("DELETE FROM oys_meta WHERE meta_key = 'discord'");
    return;
  }
  await exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('discord', ?)", [encryptData(phpJson(s, { unescapedSlashes: true })) ?? null]);
}

// Wohin Updates gerade gehen: der alte Token, solange er gewählt ist und einen Kanal hat, sonst ein gespeicherter
// Webhook. Ein „Bot“-Modus ohne Token (der Stand aus der Schleife, in der man nichts speichern konnte) zählt nicht.
export function activeDestination(s: DiscordSettings): Destination | null {
  if (s.mode === 'bot' && s.bot_token !== '') return s.channel_id !== '' ? 'token' : null;
  return parseWebhookLink(s.webhook_url) ? 'webhook' : null;
}

// oys_discord_configured()
export function discordConfigured(s: DiscordSettings): boolean {
  return activeDestination(s) !== null;
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

// Der Name, mit dem der Webhook postet: ein gespeicherter Name, den Discord ablehnt (z. B. die Login-E-Mail, die ein
// Passwort-Manager vor der Reparatur in das alte Feld „username“ gefüllt hat), bleibt weg – sonst scheiterte jeder
// Beitrag mit „Invalid Form Body“. Discord nimmt dann den Namen des Webhooks.
export function webhookName(s: DiscordSettings): string {
  return s.username !== '' && displayNameProblem(s.username) === null ? s.username : '';
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
