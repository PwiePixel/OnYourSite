// Webhook-Links von Discord: erkennen, bei Discord prüfen (GET, postet nichts) und damit senden, bearbeiten, löschen –
// auch als neuer Forenbeitrag (thread_name) oder in einen Thread (?thread_id=). Anfragen gehen nur an die feste
// Adresse aus discordBase() und werden nur aus den erkannten Teilen {id, token, threadId} gebaut (kein SSRF).
import { phpTrim } from '../php.js';
import { discordBase, discordRequest, type DiscordResponse, type Payload } from './rest.js';

export interface WebhookLink { id: string; token: string; threadId: string }

const HOOK = String.raw`/webhooks/(\d{5,25})/([A-Za-z0-9_-]{20,120})/?(?:\?([^#]*))?`;
const DISCORD = new RegExp('^https://(?:(?:ptb|canary)\\.)?discord(?:app)?\\.com/api(?:/v\\d+)?' + HOOK + '$');
const quote = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Erlaubt ist nach dem Link nur ?thread_id=<ID> und/oder wait=true|false (je höchstens einmal) → threadId bzw. nichts
function query(q: string | undefined): { threadId: string } | null {
  if (q === undefined || q === '') return { threadId: '' };
  let threadId = '';
  const seen = new Set<string>();
  for (const part of q.split('&')) {
    const m = /^(thread_id|wait)=(.*)$/.exec(part);
    if (!m || seen.has(m[1])) return null;
    seen.add(m[1]);
    if (m[1] === 'thread_id') {
      if (!/^\d{15,25}$/.test(m[2])) return null;
      threadId = m[2];
    } else if (m[2] !== 'true' && m[2] !== 'false') {
      return null;
    }
  }
  return { threadId };
}

// parseWebhookLink(): nur Discord selbst (oder die Test-Adresse aus discord_api_base) – sonst null
export function parseWebhookLink(raw: unknown): WebhookLink | null {
  if (typeof raw !== 'string') return null;
  const link = phpTrim(raw);
  let m = DISCORD.exec(link);
  if (!m) {
    const base = discordBase();
    if (base !== 'https://discord.com/api') m = new RegExp('^' + quote(base) + '(?:/v\\d+)?' + HOOK + '$').exec(link);
  }
  if (!m) return null;
  const q = query(m[3]);
  return q ? { id: m[1], token: m[2], threadId: q.threadId } : null;
}

// Der Link ohne Abfrage und ohne Schrägstrich am Ende – so wird er gespeichert
export function cleanWebhookLink(raw: string): string {
  return phpTrim(raw).replace(/[?#].*$/s, '').replace(/\/+$/, '');
}

// Für die Anzeige: ID sichtbar, Token nie
export function maskedWebhook(hook: WebhookLink): string {
  return 'https://discord.com/api/webhooks/' + hook.id + '/••••';
}

const api = (hook: WebhookLink): string => discordBase() + '/v10/webhooks/' + hook.id + '/' + hook.token;
const threadQuery = (threadId: string, first: boolean): string => (threadId !== '' ? (first ? '?' : '&') + 'thread_id=' + threadId : '');

// checkWebhook(): GET liefert Name, Kanal und Server des Webhooks, ohne etwas zu posten
export function checkWebhook(hook: WebhookLink): Promise<DiscordResponse> {
  return discordRequest('GET', api(hook));
}

// webhookPost(): neue Nachricht (?wait=true, damit Discord die ID zurückgibt); threadName = neuer Forenbeitrag
export function webhookPost(hook: WebhookLink, payload: Payload, opts: { threadId?: string; threadName?: string } = {}): Promise<DiscordResponse> {
  const body = opts.threadName !== undefined ? { ...payload, thread_name: opts.threadName } : payload;
  return discordRequest('POST', api(hook) + '?wait=true' + threadQuery(opts.threadId ?? '', false), body);
}

// webhookEdit()/webhookDelete(): Nachrichten in einem Thread oder Forenbeitrag findet Discord nur mit ?thread_id=
export function webhookEdit(hook: WebhookLink, messageId: string, payload: Payload, threadId = ''): Promise<DiscordResponse> {
  return discordRequest('PATCH', api(hook) + '/messages/' + messageId + threadQuery(threadId, true), payload);
}
export function webhookDelete(hook: WebhookLink, messageId: string, threadId = ''): Promise<DiscordResponse> {
  return discordRequest('DELETE', api(hook) + '/messages/' + messageId + threadQuery(threadId, true));
}
