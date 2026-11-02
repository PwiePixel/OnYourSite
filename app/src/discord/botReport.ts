// Bericht des installierten Bots (POST /_/bot/hello): Server, Kanäle mit seinen Rechten, aktive Threads, Rollen und der
// vorgeschlagene Kanal #updates. Gespeichert als JSON in oys_meta 'discord_bot_report' (ohne Geheimnisse). Daraus
// entsteht der Bot als Ziel für Updates – ohne dass irgendwo ein Token eingegeben wird.
import { exec, value, type Db } from '../db.js';
import { cleanText } from '../helpers.js';
import { jsonUnescaped } from '../html.js';
import { phpStr, strlen, time } from '../php.js';
import { botLastSeen, botSecret } from '../community/community.js';
import { activeWebhook, tokenUsable, type DiscordSettings } from './settings.js';

export const REPORT_PERMISSIONS = ['ViewChannel', 'SendMessages', 'SendMessagesInThreads', 'EmbedLinks', 'ReadMessageHistory', 'ManageThreads'] as const;
export const REPORT_CAPS = { categories: 50, channels: 200, threads: 50, roles: 100 } as const;
// oys_meta.meta_value ist TEXT (65.535 Bytes) – mit Abstand darunter
export const REPORT_MAX_BYTES = 60000;
export const RUNTIMES = ['service', 'docker', 'other'] as const;
// Der Bot gilt als online, wenn er sich in den letzten 5 Minuten gemeldet hat
export const ONLINE_SECONDS = 300;

export type ChannelType = 'text' | 'announcement' | 'forum';
export interface ReportChannel {
  id: string; name: string; type: ChannelType; parent_id: string; can_post: boolean; can_mention_everyone: boolean; missing: string[];
}
export interface ReportThread { id: string; name: string; parent_id: string; can_post: boolean }
export interface ReportRole { id: string; name: string; mentionable: boolean }
export interface BotReport {
  reported_at: number;
  version: string;
  runtime: string;
  features: string[];
  guild: { id: string; name: string; community: boolean };
  updates_channel_id: string;
  // Vorschläge des Bots für die Statusseite von OnYourSite (#status, #alerts) – ab Bot 0.3.0, sonst leer
  status_channel_id?: string;
  alerts_channel_id?: string;
  categories: Array<{ id: string; name: string }>;
  channels: ReportChannel[];
  threads: ReportThread[];
  roles: ReportRole[];
  truncated: boolean;
  gateway?: { ready: boolean; ping_ms: number };
}

export type ReportCheck = { ok: true; report: BotReport; json: string } | { ok: false; status: 400 | 413; error: string };

class Invalid extends Error {}
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const SNOWFLAKE = /^\d{15,25}$/;

function str(v: unknown): string {
  if (typeof v !== 'string') throw new Invalid();
  return v;
}
function bool(v: unknown, fallback?: boolean): boolean {
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== 'boolean') throw new Invalid();
  return v;
}
function id(v: unknown): string {
  const s = str(v);
  if (!SNOWFLAKE.test(s)) throw new Invalid();
  return s;
}
// Leer oder eine ID
function optionalId(v: unknown): string {
  if (v === undefined || v === null || v === '') return '';
  return id(v);
}
// Namen wie alle Texte von außen: ohne Steuerzeichen, höchstens 100 Zeichen
function name(v: unknown): string {
  return cleanText(str(v), 100);
}
function list<T>(v: unknown, max: number, item: (x: unknown) => T): T[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max) throw new Invalid();
  return v.map((x) => item(x));
}

// Bericht prüfen: unbekannte Schlüssel oben fallen weg (vorwärtskompatibel), unbekannte Funktionen ebenso; alles
// andere, was nicht passt, ist ein 400. known: Funktionen, die diese Website kennt (aus dem Auftragsregister).
export function validateReport(body: unknown, known: readonly string[], now = time()): ReportCheck {
  try {
    if (!isObject(body)) throw new Invalid();
    const version = str(body.version);
    if (!/^[0-9a-z.+-]{1,20}$/.test(version)) throw new Invalid();
    const runtime = str(body.runtime);
    if (!(RUNTIMES as readonly string[]).includes(runtime)) throw new Invalid();
    if (!Array.isArray(body.features) || body.features.length > 50) throw new Invalid();
    const features: string[] = [];
    for (const f of body.features) {
      if (typeof f !== 'string') throw new Invalid();
      if (known.includes(f) && !features.includes(f)) features.push(f);
    }
    if (!isObject(body.guild)) throw new Invalid();
    const guild = { id: id(body.guild.id), name: name(body.guild.name ?? ''), community: bool(body.guild.community, false) };
    const categories = list(body.categories, REPORT_CAPS.categories, (c) => {
      if (!isObject(c)) throw new Invalid();
      return { id: id(c.id), name: name(c.name) };
    });
    if (body.channels === undefined) throw new Invalid();
    const channels = list(body.channels, REPORT_CAPS.channels, (c): ReportChannel => {
      if (!isObject(c)) throw new Invalid();
      const type = str(c.type);
      if (type !== 'text' && type !== 'announcement' && type !== 'forum') throw new Invalid();
      const missing = list(c.missing, REPORT_PERMISSIONS.length, (m) => {
        const p = str(m);
        if (!(REPORT_PERMISSIONS as readonly string[]).includes(p)) throw new Invalid();
        return p;
      });
      return {
        id: id(c.id), name: name(c.name), type, parent_id: optionalId(c.parent_id), can_post: bool(c.can_post),
        can_mention_everyone: bool(c.can_mention_everyone, false), missing: [...new Set(missing)],
      };
    });
    const threads = list(body.threads, REPORT_CAPS.threads, (t): ReportThread => {
      if (!isObject(t)) throw new Invalid();
      return { id: id(t.id), name: name(t.name), parent_id: optionalId(t.parent_id), can_post: bool(t.can_post) };
    });
    const roles = list(body.roles, REPORT_CAPS.roles, (r): ReportRole => {
      if (!isObject(r)) throw new Invalid();
      return { id: id(r.id), name: name(r.name), mentionable: bool(r.mentionable, false) };
    });
    const report: BotReport = {
      reported_at: now, version, runtime, features, guild, updates_channel_id: optionalId(body.updates_channel_id),
      categories, channels, threads, roles, truncated: bool(body.truncated, false),
    };
    const statusId = optionalId(body.status_channel_id);
    const alertsId = optionalId(body.alerts_channel_id);
    if (statusId !== '') report.status_channel_id = statusId;
    if (alertsId !== '') report.alerts_channel_id = alertsId;
    if (body.gateway !== undefined) {
      const g = body.gateway;
      if (!isObject(g) || typeof g.ping_ms !== 'number' || !Number.isSafeInteger(g.ping_ms) || g.ping_ms < 0) throw new Invalid();
      report.gateway = { ready: bool(g.ready), ping_ms: g.ping_ms };
    }
    const json = jsonUnescaped(report);
    if (strlen(json) > REPORT_MAX_BYTES) return { ok: false, status: 413, error: 'Request too large.' };
    return { ok: true, report, json };
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, status: 400, error: 'Invalid report.' };
    throw err;
  }
}

export async function saveReport(json: string): Promise<void> {
  await exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('discord_bot_report', ?)", [json]);
}

// Der letzte Bericht (oder null). db: die Verbindung des Aufrufers (z. B. in einer Transaktion)
export async function report(db?: Db): Promise<BotReport | null> {
  const sql = "SELECT meta_value FROM oys_meta WHERE meta_key = 'discord_bot_report'";
  const raw = phpStr(db ? await db.value(sql) : await value(sql));
  if (raw === '') return null;
  try {
    const r = JSON.parse(raw) as BotReport;
    return isObject(r) && Array.isArray(r.channels) && Array.isArray(r.features) ? r : null;
  } catch {
    return null;
  }
}

// Der Bot als Ziel für neue Updates:
// - vom Admin gespeichert (bot.saved_at): sein Kanal, solange er eingeschaltet ist;
// - noch nie gespeichert: der Kanal #updates, den der Bot meldet – aber nur, wenn sonst kein Ziel an ist (kein
//   doppelter Beitrag neben einem Webhook) und der Bot Updates posten kann und darf.
export interface BotTarget { channel_id: string; channel_type: string; name: string; mention: string; auto: boolean }

export function botTarget(s: DiscordSettings, rep: BotReport | null, installed: boolean): BotTarget | null {
  if (!installed) return null;
  if (s.bot.saved_at !== '') {
    if (!s.bot.enabled || s.bot.channel_id === '') return null;
    const channel = rep?.channels.find((c) => c.id === s.bot.channel_id);
    const thread = rep?.threads.find((t) => t.id === s.bot.channel_id);
    const type = s.bot.channel_type !== '' ? s.bot.channel_type : channel ? channel.type : thread ? 'thread' : 'text';
    return { channel_id: s.bot.channel_id, channel_type: type, name: channel?.name ?? thread?.name ?? '', mention: s.bot.mention, auto: false };
  }
  if (activeWebhook(s) || tokenUsable(s)) return null;
  if (!rep || !rep.features.includes('updates.v1') || rep.updates_channel_id === '') return null;
  const ch = rep.channels.find((c) => c.id === rep.updates_channel_id);
  if (!ch || !ch.can_post) return null;
  return { channel_id: ch.id, channel_type: ch.type, name: ch.name, mention: '', auto: true };
}

export interface BotStatus {
  installed: boolean;
  online: boolean;
  lastSeen: number | null;
  report: BotReport | null;
  // Der letzte Bericht nennt updates.v1: dieser Bot kann Updates posten
  canPostUpdates: boolean;
}

export async function botStatus(db?: Db): Promise<BotStatus> {
  const installed = botSecret() !== '';
  const lastSeen = db ? lastSeenOn(db) : botLastSeen();
  const seen = await lastSeen;
  const rep = installed ? await report(db) : null;
  return {
    installed,
    online: seen !== null && time() - seen < ONLINE_SECONDS,
    lastSeen: seen,
    report: rep,
    canPostUpdates: !!rep && rep.features.includes('updates.v1'),
  };
}

async function lastSeenOn(db: Db): Promise<number | null> {
  const v = await db.value("SELECT meta_value FROM oys_meta WHERE meta_key = 'bot_last_seen'");
  return v === null ? null : Number(v) || 0;
}
