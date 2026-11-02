// Updates in Discord (früher lib/updates.php, Discord-Teil). Die Zustellung steht jetzt in app/src/discord/: je Ziel
// (installierter Bot, Webhook, alter Bot-Token) ein Beitrag in update_discord_posts (discord/posts.ts), Nachrichten in
// discord/payload.ts, Einstellungen in discord/settings.ts. Hier bleiben die Namen der Portierung erhalten, damit Code,
// der gegen sie geschrieben ist, weiter passt.
import type { Update } from './updates.js';
import { discordBase, discordError, discordRequest, type DiscordResponse, type Payload } from '../discord/rest.js';
import {
  activeDestination, discordDefaults, discordSettings, siteDestinations, storeDiscordSettings, type DiscordSettings,
} from '../discord/settings.js';
import { parseWebhookLink } from '../discord/webhook.js';
import { styleOf, threadName, updatePayload, withMention, type PostVia } from '../discord/payload.js';
import { removeNote, type DiscordChange } from '../discord/posts.js';

export { discordBase, discordDefaults, discordError, discordRequest, discordSettings, threadName };
export type { DiscordChange, DiscordResponse, DiscordSettings, Payload };
export const discordStore = storeDiscordSettings;

// oys_discord_parse_webhook() für ältere Aufrufer: [id, token] oder null
export function discordParseWebhook(url: string): [string, string] | null {
  const hook = parseWebhookLink(url);
  return hook ? [hook.id, hook.token] : null;
}

// oys_discord_configured(): Webhook oder alter Token ist eingerichtet (den installierten Bot prüft discord/posts.ts
// delivery(), weil dafür sein Bericht nötig ist)
export function discordConfigured(s: DiscordSettings): boolean {
  return siteDestinations(s).length > 0;
}

// oys_discord_update_payload() für das erste Ziel der Website (bzw. für via)
export function discordUpdatePayload(u: Update, s: DiscordSettings, via: PostVia = activeDestination(s) ?? 'token'): Payload {
  return updatePayload(u, styleOf(s, via), via);
}

// oys_discord_with_mention()
export function discordWithMention(payload: Payload, s: DiscordSettings, via: PostVia = activeDestination(s) ?? 'token'): Payload {
  return withMention(payload, styleOf(s, via), via);
}

// oys_discord_remove_note()
export const discordRemoveNote = removeNote;
