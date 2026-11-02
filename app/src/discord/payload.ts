// Nachrichten für Discord: das Embed eines Updates (oys_discord_update_payload), Ping und Absender
// (oys_discord_with_mention), die Testnachricht und der Name eines Forenbeitrags – gleich für jedes Ziel
// (Webhook, alter Token, installierter Bot). Name und Bild des Absenders gelten nur für den Webhook.
import { baseHost, mainUrl } from '../helpers.js';
import { gmdate, mbStrlen, mbSubstr, phpRtrim, phpTrim, phpTruthy, strtotime } from '../php.js';
import { UPDATE_CATEGORIES, updateUrl, type Update } from '../updates/updates.js';
import type { Payload } from './rest.js';
import { webhookName, type DiscordSettings } from './settings.js';

export type PostVia = 'bot' | 'webhook' | 'token';

// Ping und Absender eines Ziels
export interface PostStyle { mention: string; username: string; avatar_url: string }

// Stil des Ziels aus den Einstellungen (Bot: Ping aus seinen Einstellungen; ohne gespeicherte Wahl niemand)
export function styleOf(s: DiscordSettings, via: PostVia): PostStyle {
  if (via === 'webhook') return { mention: s.webhook.mention, username: webhookName(s), avatar_url: s.webhook.avatar_url };
  if (via === 'token') return { mention: s.mention, username: '', avatar_url: '' };
  return { mention: s.bot.saved_at !== '' ? s.bot.mention : '', username: '', avatar_url: '' };
}

// oys_discord_with_mention(): Ping und Absender; Reihenfolge embeds, allowed_mentions, content, username, avatar_url.
// allowed_mentions steht immer da (parse: [] außer bei einem gewählten Ping) – kein Text pingt aus Versehen.
export function withMention(payload: Payload, style: PostStyle, via: PostVia): Payload {
  const p: Payload = { ...payload, allowed_mentions: { parse: [] } };
  const mention = style.mention;
  if (mention === 'everyone' || mention === 'here') {
    p.content = '@' + mention;
    p.allowed_mentions = { parse: ['everyone'] };
  } else if (mention !== '') {
    p.content = '<@&' + mention + '>';
    p.allowed_mentions = { parse: [], roles: [mention] };
  }
  if (via === 'webhook') {
    if (style.username !== '') p.username = style.username;
    if (style.avatar_url !== '') p.avatar_url = style.avatar_url;
  }
  return p;
}

// oys_discord_update_payload(): Embed mit Titel, Text, Farbe der Kategorie und Link zur Seite
export function updatePayload(u: Update, style: PostStyle, via: PostVia): Payload {
  const cat = Object.hasOwn(UPDATE_CATEGORIES, u.category) ? UPDATE_CATEGORIES[u.category] : UPDATE_CATEGORIES.news;
  const url = updateUrl(u.id);
  const title = (u.version !== '' ? u.version + ' – ' : '') + u.title;
  let desc = phpTrim(u.body);
  if (mbStrlen(desc) > 3800) desc = phpRtrim(mbSubstr(desc, 0, 3800)) + '…\n\n[Read the full update](' + url + ')';
  const when = strtotime(phpTruthy(u.published_at) ? (u.published_at as string) : 'now');
  const embed: Payload = {
    title: mbSubstr(title, 0, 256),
    url,
    // hexdec(ltrim($color, '#')): nur Hex-Ziffern zählen
    color: hexdec(cat.color.replace(/^#+/, '')),
    author: { name: cat.label },
    footer: { text: 'OnYourSite Updates' },
    timestamp: gmdate('Y-m-d\\TH:i:s\\Z', when === false ? 0 : when),
  };
  if (desc !== '') embed.description = desc;
  return withMention({ embeds: [embed] }, style, via);
}

function hexdec(hex: string): number {
  const digits = hex.replace(/[^0-9a-fA-F]/g, '');
  return digits === '' ? 0 : Number.parseInt(digits, 16);
}

// Beim Bearbeiten nur die Nachricht selbst ändern – Ping, Absender und Titel des Beitrags bleiben (pingt nie neu)
export function forEdit(p: Payload): Payload {
  const body = { ...p };
  delete body.content;
  delete body.allowed_mentions;
  delete body.username;
  delete body.avatar_url;
  delete body.thread_name;
  return body;
}

// Name eines Forenbeitrags für ein Update (höchstens 100 Zeichen)
export function threadName(u: Update): string {
  return mbSubstr((u.version !== '' ? u.version + ' – ' : '') + u.title, 0, 100);
}

// Testnachricht (wie bisher), ohne Ping
export function testPayload(style: PostStyle, via: PostVia): Payload {
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
    if (style.username !== '') p.username = style.username;
    if (style.avatar_url !== '') p.avatar_url = style.avatar_url;
  }
  return p;
}
