// Ankündigungen in Discord: Webhook-Link oder eigener Bot (lib/updates.php, Discord-Teil). Die Einstellungen liegen
// verschlüsselt in oys_meta; gesendet wird wie mit curl in PHP (10 s Zeitlimit, 5 s für den Verbindungsaufbau,
// keine Weiterleitungen).
import http from 'node:http';
import https from 'node:https';
import { config } from '../config.js';
import { exec, value } from '../db.js';
import { decryptData, encryptData } from '../crypto.js';
import { baseHost, cleanText, cleanUrl } from '../helpers.js';
import { jsonUnescaped, phpJson } from '../html.js';
import { gmdate, intval, mbStrlen, mbSubstr, phpRtrim, phpStr, phpTrim, phpTruthy, strtolower, strtotime } from '../php.js';
import { UPDATE_CATEGORIES, updateUrl, type Input, type Update } from './updates.js';

export interface DiscordSettings {
  mode: string;
  webhook_url: string;
  bot_token: string;
  channel_id: string;
  mention: string;
  username: string;
  avatar_url: string;
  invite_url: string;
  auto_post: boolean;
}

export interface DiscordTarget { key: string; url: string; headers: string[]; bot: boolean }
export interface DiscordResponse { status: number; data: Record<string, unknown> | null; code: number | null; error: string }
export interface DiscordSent { ok: boolean; id: string; target: string; error: string | null }
// state: ok | missing (in Discord schon gelöscht) | unreachable (anderer Webhook/Bot, Webhook/Kanal gelöscht)
//        | disconnected (Discord nicht verbunden) | failed (z. B. Zeitüberschreitung, Rate-Limit, fehlende Rechte)
export interface DiscordChange { state: 'ok' | 'missing' | 'unreachable' | 'disconnected' | 'failed'; error: string | null; transient: boolean }
export type Payload = Record<string, unknown>;

// oys_discord_defaults() – die Reihenfolge der Schlüssel bestimmt auch das gespeicherte JSON
export function discordDefaults(): DiscordSettings {
  return {
    mode: 'webhook', webhook_url: '', bot_token: '', channel_id: '',
    mention: '', username: '', avatar_url: '', invite_url: '', auto_post: true,
  };
}

// oys_discord_settings(): Webhook-Link und Bot-Token sind Zugangsdaten. Ein falscher Schlüssel ergibt die Vorgaben.
export async function discordSettings(): Promise<DiscordSettings> {
  const raw = phpStr(await value("SELECT meta_value FROM oys_meta WHERE meta_key = 'discord'"));
  const data = raw !== '' ? jsonDecode(phpStr(decryptData(raw))) : null;
  const s = discordDefaults() as unknown as Record<string, unknown>;
  // json_decode(…, true) liefert auch für JSON-Listen ein Array – deren Schlüssel 0, 1 … passen aber nie
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    for (const key of Object.keys(s)) if (Object.hasOwn(data, key)) s[key] = (data as Record<string, unknown>)[key];
  }
  return s as unknown as DiscordSettings;
}

// oys_discord_store(): null = trennen; Umlaute als \uXXXX, Schrägstriche unmaskiert
export async function discordStore(s: DiscordSettings | null): Promise<void> {
  if (s === null) {
    await exec("DELETE FROM oys_meta WHERE meta_key = 'discord'");
    return;
  }
  await exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('discord', ?)", [encryptData(phpJson(s, { unescapedSlashes: true })) ?? null]);
}

// oys_discord_configured()
export function discordConfigured(s: DiscordSettings): boolean {
  return s.mode === 'bot' ? s.bot_token !== '' && s.channel_id !== '' : s.webhook_url !== '';
}

// oys_discord_base(): für Tests umstellbar (discord_api_base)
export function discordBase(): string {
  return phpRtrim(phpStr(config<unknown>('discord_api_base', 'https://discord.com/api')), '/');
}

const WEBHOOK = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/(\d{5,25})\/([A-Za-z0-9_-]{20,120})\/?$/;
const quote = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// oys_discord_parse_webhook(): nur Discord selbst (oder die Test-Adresse) – keine beliebigen Adressen → [id, token]
export function discordParseWebhook(url: string): [string, string] | null {
  const u = phpTrim(url);
  let m = WEBHOOK.exec(u);
  if (m) return [m[1], m[2]];
  const base = discordBase();
  if (base !== 'https://discord.com/api') {
    m = new RegExp('^' + quote(base) + '/webhooks/(\\d{5,25})/([A-Za-z0-9_-]{20,120})/?$').exec(u);
    if (m) return [m[1], m[2]];
  }
  return null;
}

// oys_discord_save_settings(): Fehlertext oder null. Leere Geheimnis-Felder behalten den alten Wert.
export async function discordSaveSettings(input: Input): Promise<string | null> {
  const s = await discordSettings();
  s.mode = input.mode === 'bot' ? 'bot' : 'webhook';

  const webhook = phpTrim(phpStr(input.webhook_url ?? ''));
  if (webhook !== '') {
    if (!discordParseWebhook(webhook)) return 'That doesn’t look like a Discord webhook link (https://discord.com/api/webhooks/…).';
    s.webhook_url = webhook;
  }
  const token = phpTrim(phpStr(input.bot_token ?? ''));
  if (token !== '') {
    if (!/^[A-Za-z0-9_.-]{50,120}$/.test(token)) {
      return 'That doesn’t look like a bot token. Copy it from the Discord Developer Portal (Bot → Reset Token).';
    }
    s.bot_token = token;
  }
  const channel = phpTrim(phpStr(input.channel_id ?? ''));
  if (channel !== '' && !/^\d{15,25}$/.test(channel)) {
    return 'The channel ID is a long number. In Discord: enable Developer Mode, right-click the channel → Copy Channel ID.';
  }
  s.channel_id = channel;

  // trim() ohne \n: wie PHP passt eine Rollen-ID mit einem \n am Ende ($ vor dem letzten Zeilenumbruch)
  const mention = strtolower(phpTrim(phpStr(input.mention ?? ''), ' @<&>\t'));
  if (mention !== '' && mention !== 'everyone' && mention !== 'here' && !/^\d{15,25}\n?$/.test(mention)) {
    return 'Ping: enter a role ID, “everyone” or “here” – or leave it empty.';
  }
  s.mention = mention;

  const username = cleanText(input.username ?? '', 80);
  if (username !== '' && /discord|clyde/i.test(username)) return 'Discord doesn’t allow “discord” or “clyde” in the webhook name.';
  s.username = username;
  const avatar = phpTrim(phpStr(input.avatar_url ?? ''));
  s.avatar_url = avatar !== '' && /^https:\/\//i.test(avatar) ? cleanUrl(avatar) : '';
  const invite = phpTrim(phpStr(input.invite_url ?? ''));
  s.invite_url = invite !== '' ? cleanUrl(invite) : '';
  if (s.invite_url !== '' && !/^https:\/\//i.test(s.invite_url)) s.invite_url = '';
  s.auto_post = phpTruthy(input.auto_post);

  if (s.mode === 'bot' && (s.bot_token === '' || s.channel_id === '')) {
    await discordStore(s);
    return 'Saved – for the bot, a token and a channel ID are both needed.';
  }
  await discordStore(s);
  return null;
}

// oys_discord_target(): Webhook (mit Token) oder Bot-Kanal
export function discordTarget(s: DiscordSettings): DiscordTarget | null {
  if (s.mode === 'bot') {
    if (s.bot_token === '' || s.channel_id === '') return null;
    return { key: 'bot:' + s.channel_id, url: discordBase() + '/v10/channels/' + s.channel_id + '/messages', headers: ['Authorization: Bot ' + s.bot_token], bot: true };
  }
  const hook = discordParseWebhook(s.webhook_url);
  if (!hook) return null;
  return { key: 'webhook:' + hook[0], url: discordBase() + '/v10/webhooks/' + hook[0] + '/' + hook[1], headers: [], bot: false };
}

// oys_discord_request(): status 0 = keine Antwort (dann steht der Grund in error)
export async function discordRequest(method: string, url: string, json: Payload | null = null, headers: string[] = []): Promise<DiscordResponse> {
  const body = json === null ? null : jsonUnescaped(json);
  // Discord verlangt dieses Format für den User-Agent
  const all = ['Content-Type: application/json', 'User-Agent: DiscordBot (https://' + baseHost() + ', 2.2)', ...headers];
  const res = await curlRequest(method, url, body, all);
  const data = res.body !== null && res.body.length ? jsonDecode(res.body) : null;
  const obj = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  const code = obj && obj.code !== undefined && obj.code !== null ? intval(obj.code) : null;
  return { status: res.status, data: obj, code, error: res.error };
}

// json_decode(): ungültiges UTF-8 oder JSON → null
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function jsonDecode(raw: string | Buffer): unknown {
  try {
    return JSON.parse(typeof raw === 'string' ? raw : UTF8.decode(raw));
  } catch {
    return null;
  }
}

// Eine Anfrage wie curl_exec() mit CURLOPT_TIMEOUT 10, CURLOPT_CONNECTTIMEOUT 5 und ohne FOLLOWLOCATION.
// Die Fehlertexte folgen curl (die Millisekunden unterscheiden sich naturgemäß).
function curlRequest(method: string, url: string, body: string | null, headers: string[]): Promise<{ status: number; body: Buffer | null; error: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    // Steuerzeichen und Leerzeichen lehnt curl ab (new URL() würde sie still entfernen oder kodieren und trotzdem
    // senden) – etwa eine gespeicherte Nachrichten-ID mit \n am Ende, die /^\d{5,25}$/ in PHP noch durchlässt
    if (/[\x00-\x20\x7f]/.test(url)) {
      resolve({ status: 0, body: null, error: 'URL rejected: Malformed input to a URL function' });
      return;
    }
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      resolve({ status: 0, body: null, error: 'URL rejected: Malformed input to a URL function' });
      return;
    }
    const secure = target.protocol === 'https:';
    if (!secure && target.protocol !== 'http:') {
      resolve({ status: 0, body: null, error: `Protocol "${target.protocol.slice(0, -1)}" not supported` });
      return;
    }
    const host = target.hostname.replace(/^\[|\]$/g, '');
    const port = target.port || (secure ? '443' : '80');
    const out: Record<string, string> = { Accept: '*/*' };
    for (const h of headers) {
      const i = h.indexOf(':');
      if (i > 0) out[h.slice(0, i)] = h.slice(i + 1).replace(/^[ \t]+/, '');
    }
    if (body !== null) out['Content-Length'] = String(Buffer.byteLength(body, 'utf8'));

    let status = 0;
    let received = 0;
    let expected: number | null = null;
    let reason: string | null = null;
    let settled = false;
    let tcpUp = false;
    let response: http.IncomingMessage | null = null;
    const chunks: Buffer[] = [];
    const finish = (result: { status: number; body: Buffer | null; error: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(totalTimer);
      resolve(result);
    };
    const fail = (err: NodeJS.ErrnoException): void => finish({ status, body: null, error: reason ?? curlError(err, host, port, Date.now() - started, status !== 0) });

    const req = (secure ? https : http).request(target, { method, headers: out, agent: false });
    // Verbindungsaufbau: ohne TCP-Verbindung meldet curl „Failed to connect …“, hängt danach der TLS-Handschlag
    // „SSL connection timeout“
    const connectTimer = setTimeout(() => {
      reason = tcpUp ? 'SSL connection timeout' : `Failed to connect to ${host} port ${port} after ${Date.now() - started} ms: Timeout was reached`;
      req.destroy();
    }, 5000);
    const totalTimer = setTimeout(() => {
      reason = `Operation timed out after ${Date.now() - started} milliseconds with ${expected !== null ? `${received} out of ${expected}` : received} bytes received`;
      req.destroy();
    }, 10000);
    req.on('socket', (socket) => {
      socket.once('connect', () => (tcpUp = true));
      socket.once(secure ? 'secureConnect' : 'connect', () => clearTimeout(connectTimer));
    });
    req.on('response', (res) => {
      response = res;
      status = res.statusCode ?? 0;
      const len = res.headers['content-length'];
      expected = len !== undefined && /^\d+$/.test(len) ? Number(len) : null;
      res.on('data', (c: Buffer) => {
        received += c.length;
        chunks.push(c);
      });
      res.on('end', () => finish({ status, body: Buffer.concat(chunks), error: '' }));
      // Verbindung vor dem Ende der Antwort geschlossen: Text von curl (ein Abbruch durch die Gegenseite bleibt
      // „Recv failure: Connection reset by peer“, der kommt vorher als Fehler der Anfrage)
      const cut = (): void => fail(new Error(expected !== null
        ? `transfer closed with ${expected - received} bytes remaining to read`
        : 'transfer closed with outstanding read data remaining'));
      res.on('error', (err: NodeJS.ErrnoException) => (err.message === 'aborted' ? cut() : fail(err)));
      res.on('close', () => {
        if (!res.complete) cut();
      });
    });
    // Ist die Antwort vollständig, zählt alles danach nicht mehr (curl liest nur, was angekündigt ist) – Node meldet
    // solche Reste als Fehler, noch bevor der Inhalt ausgeliefert ist
    req.on('error', (err) => {
      if (!response?.complete) fail(err);
    });
    req.on('close', () => {
      if (reason !== null) fail(new Error(reason));
    });
    if (body !== null) req.write(body, 'utf8');
    req.end();
  });
}

// Node-Fehler → Text wie curl_error()
function curlError(err: NodeJS.ErrnoException, host: string, port: string, ms: number, answered: boolean): string {
  switch (err.code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'EAI_NONAME':
    case 'EAI_FAIL':
      return `Could not resolve host: ${host}`;
    case 'ECONNREFUSED':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'EADDRNOTAVAIL':
      return `Failed to connect to ${host} port ${port} after ${ms} ms: Couldn't connect to server`;
    case 'ECONNRESET':
    case 'EPIPE':
      return !answered && err.message === 'socket hang up' ? 'Empty reply from server' : 'Recv failure: Connection reset by peer';
    case 'CERT_HAS_EXPIRED':
      return 'SSL certificate problem: certificate has expired';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
      return 'SSL certificate problem: self-signed certificate';
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return 'SSL certificate problem: self-signed certificate in certificate chain';
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return 'SSL certificate problem: unable to get local issuer certificate';
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return `SSL: no alternative certificate subject name matches target host name '${host}'`;
  }
  // Keine HTTP-Antwort (z. B. ein anderer Dienst auf dem Port): curl hält das für HTTP/0.9 und lehnt es ab
  if (err.code === 'HPE_INVALID_CONSTANT' && !answered) return 'Received HTTP/0.9 when not allowed';
  if (typeof err.code === 'string' && err.code.startsWith('HPE_')) return 'Weird server reply';
  return err.message;
}

// oys_discord_error()
export function discordError(res: DiscordResponse, bot: boolean): string {
  const status = res.status;
  const message = phpStr(res.data?.message ?? '');
  if (status === 0) return 'Couldn’t reach Discord' + (res.error !== '' ? ' (' + res.error + ')' : '') + '.';
  if (status === 401) return bot ? 'Discord rejected the bot token – please check it.' : 'Discord rejected the webhook link – please copy it again from Discord.';
  if (status === 403) {
    return bot
      ? 'The bot isn’t allowed to post in this channel. It needs “View Channel”, “Send Messages” and “Embed Links”.'
      : 'Discord refused the webhook (403) – please check it in the channel settings.';
  }
  if (status === 404) return bot ? 'Discord couldn’t find the channel or message.' : 'Discord couldn’t find this webhook – it may have been deleted.';
  if (status === 429) return 'Discord is rate limiting us – please try again in a moment.';
  return 'Discord error ' + status + (message !== '' ? ': ' + message : '') + '.';
}

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

// oys_discord_with_mention(): Ping und Absender; Reihenfolge embeds, allowed_mentions, content, username, avatar_url
export function discordWithMention(payload: Payload, s: DiscordSettings): Payload {
  const p: Payload = { ...payload, allowed_mentions: { parse: [] } };
  const mention = s.mention;
  if (mention === 'everyone' || mention === 'here') {
    p.content = '@' + mention;
    p.allowed_mentions = { parse: ['everyone'] };
  } else if (mention !== '') {
    p.content = '<@&' + mention + '>';
    p.allowed_mentions = { parse: [], roles: [mention] };
  }
  if (s.mode === 'webhook') {
    if (s.username !== '') p.username = s.username;
    if (s.avatar_url !== '') p.avatar_url = s.avatar_url;
  }
  return p;
}

// oys_discord_send(): neue Nachricht senden
export async function discordSend(s: DiscordSettings, payload: Payload): Promise<DiscordSent> {
  const t = discordTarget(s);
  if (!t) return { ok: false, id: '', target: '', error: 'Discord isn’t set up yet (Admin → Discord).' };
  const res = await discordRequest('POST', t.url + (t.bot ? '' : '?wait=true'), payload, t.headers);
  if (res.status >= 200 && res.status < 300) return { ok: true, id: phpStr(res.data?.id ?? ''), target: t.key, error: null };
  return { ok: false, id: '', target: '', error: discordError(res, t.bot) };
}

// oys_discord_change(): bestehende Nachricht ändern (Payload) oder löschen (null) – nur über dasselbe Ziel,
// über das sie gesendet wurde
export async function discordChange(s: DiscordSettings, target: string, messageId: string, payload: Payload | null): Promise<DiscordChange> {
  const t = discordTarget(s);
  if (!t) return { state: 'disconnected', error: 'Discord isn’t connected', transient: false };
  if (t.key !== target) return { state: 'unreachable', error: 'it was posted through a different webhook or bot', transient: false };
  if (!/^\d{5,25}\n?$/.test(messageId)) return { state: 'missing', error: null, transient: false };
  let body = payload;
  if (body !== null) {
    // Beim Bearbeiten nur die Nachricht selbst ändern – Ping und Absender bleiben wie beim ersten Senden
    body = { ...body };
    delete body.content;
    delete body.allowed_mentions;
    delete body.username;
    delete body.avatar_url;
  }
  // Webhook: /webhooks/{id}/{token}/messages/{msg} – Bot: /channels/{id}/messages/{msg}
  const res = await discordRequest(body === null ? 'DELETE' : 'PATCH', t.url + (t.bot ? '' : '/messages') + '/' + messageId, body, t.headers);
  if (res.status >= 200 && res.status < 300) return { state: 'ok', error: null, transient: false };
  if (res.status === 404 && res.code === 10008) return { state: 'missing', error: null, transient: false };
  if (res.status === 404 && (res.code === 10003 || res.code === 10015)) return { state: 'unreachable', error: discordError(res, t.bot), transient: false };
  return { state: 'failed', error: discordError(res, t.bot), transient: res.status === 0 || res.status === 429 || res.status >= 500 };
}

// oys_discord_announce_update(): neue Nachricht mit Ping; hat das Update schon eine, wird nur diese aktualisiert.
// Gibt eine Fehlermeldung oder null zurück.
export async function discordAnnounceUpdate(u: Update, s: DiscordSettings): Promise<string | null> {
  if (u.discord_message_id !== '') {
    const res = await discordSyncUpdate(u, s);
    if (res.state !== 'missing' && res.state !== 'unreachable') return res.state === 'ok' ? null : phpRtrim(phpStr(res.error), '.') + '.';
    // In Discord gelöscht oder über ein anderes Ziel gesendet → neu ankündigen
  }
  const sent = await discordSend(s, discordUpdatePayload(u, s));
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
