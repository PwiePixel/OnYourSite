// Karte „Post with the bot“ (Admin → Discord): in welchem Zustand der installierte Bot ist, was er gerade tut und was
// der Admin wählen kann – reine Funktionen aus Einstellungen, letztem Bericht (/_/bot/hello), letztem Kontakt und dem
// letzten Test. Dieselben Regeln prüfen beim Speichern Kanal und Ping (checkBotChoice) und zeigen danach, ob der Bot
// dort posten kann. Die Admin-Ansicht und /admin/api/discord-status lesen beide dieses Modell.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_DIR } from '../config.js';
import { timeAgo } from '../helpers.js';
import { date, strtotime } from '../php.js';
import { ONLINE_SECONDS, botTarget, type BotReport, type BotTarget } from './botReport.js';
import { activeWebhook, tokenUsable, type DiscordSettings } from './settings.js';

export type Tone = 'ok' | 'warn' | 'err' | 'muted';
export type BotCardState = 'not_installed' | 'old' | 'off' | 'checking' | 'offline' | 'online';

// oys_meta 'discord_bot_test' (siehe discord/posts.ts applyTestResult)
export interface BotTest { at: string; state: string; job_id: number; channel_id: string; error: string }

// Nach dem Speichern höchstens so lange „Checking with the bot…“; ein Test, den der Bot so lange nicht abgeholt hat,
// verfällt (wie update.test in posts.ts)
export const CHECK_SECONDS = 120;
export const TEST_SECONDS = 120;

// Rechte aus dem Bericht → Namen wie in Discords Kanaleinstellungen
const PERMISSION_LABELS: Record<string, string> = {
  ViewChannel: 'View Channel', SendMessages: 'Send Messages', SendMessagesInThreads: 'Send Messages in Threads', EmbedLinks: 'Embed Links',
  ReadMessageHistory: 'Read Message History', ManageThreads: 'Manage Threads',
};

// Wo der Bot postet: ein Kanal oder ein Thread aus dem Bericht (ein Thread darf pingen, wenn sein Kanal es darf)
export interface Place {
  id: string;
  name: string;
  type: 'text' | 'announcement' | 'forum' | 'thread';
  can_post: boolean;
  can_mention_everyone: boolean;
  missing: string[];
  parent_id: string;
}

const SNOWFLAKE = /^\d{15,25}$/;

export function placeOf(rep: BotReport | null, id: string): Place | null {
  if (!rep || !SNOWFLAKE.test(id)) return null;
  const c = rep.channels.find((x) => x.id === id);
  if (c) return { id: c.id, name: c.name, type: c.type, can_post: c.can_post, can_mention_everyone: c.can_mention_everyone, missing: c.missing, parent_id: c.parent_id };
  const t = rep.threads.find((x) => x.id === id);
  if (!t) return null;
  const parent = rep.channels.find((x) => x.id === t.parent_id);
  return { id: t.id, name: t.name, type: 'thread', can_post: t.can_post, can_mention_everyone: parent?.can_mention_everyone ?? false, missing: [], parent_id: t.parent_id };
}

// „Der Bot kann in #x nicht posten“ – mit den fehlenden Rechten, wie sie der Bot meldet
export function cantPost(p: Place): string {
  const missing = p.missing.map((m) => PERMISSION_LABELS[m] ?? m);
  return missing.length ? `The bot can’t post in #${p.name}: it needs ${missing.join(', ')} there.` : `The bot can’t post in #${p.name}.`;
}

// Ping im gewählten Kanal: @everyone/@here brauchen das Recht dazu, eine Rolle muss erwähnbar sein (oder das Recht)
function mentionProblem(rep: BotReport, place: Place, mention: string): string | null {
  if (mention === '') return null;
  if (mention === 'everyone' || mention === 'here') {
    return place.can_mention_everyone ? null
      : `Ping: the bot may not ping @${mention} in #${place.name} – give it “Mention @everyone, @here and All Roles” in this channel’s settings, or choose Nobody.`;
  }
  if (!SNOWFLAKE.test(mention)) return 'Ping: choose Nobody, @everyone, @here or a role.';
  const role = rep.roles.find((r) => r.id === mention);
  if (!role) return 'Ping: this role no longer exists – choose another one.';
  if (!role.mentionable && !place.can_mention_everyone) {
    return `Ping: the bot may not ping @${role.name} in #${place.name} – make the role mentionable in Discord or give the bot “Mention @everyone, @here and All Roles” there.`;
  }
  return null;
}

export type Choice = { ok: true; place: Place; mention: string } | { ok: false; error: string; field: 'bot_channel' | 'bot_mention' };

// Kanal und Ping gegen den letzten Bericht prüfen (beim Speichern und für die Zeile „Ready …“ bzw. das Problem)
export function checkBotChoice(rep: BotReport, channelId: string, mention: string): Choice {
  if (channelId === '') return { ok: false, error: 'Channel: choose where the bot posts updates.', field: 'bot_channel' };
  const place = placeOf(rep, channelId);
  if (!place) {
    return { ok: false, field: 'bot_channel', error: 'Channel: the bot doesn’t list this channel any more – it may have been deleted, or the bot can’t see it. Choose another one or use “Refresh list”.' };
  }
  if (!place.can_post) return { ok: false, error: cantPost(place), field: 'bot_channel' };
  const problem = mentionProblem(rep, place, mention);
  if (problem) return { ok: false, error: problem, field: 'bot_mention' };
  return { ok: true, place, mention };
}

// Postet der Webhook schon in diesen Kanal oder Thread? (sonst käme jedes Update zweimal)
export function webhookPostsInto(s: DiscordSettings, channelId: string): boolean {
  if (!activeWebhook(s) || channelId === '') return false;
  return s.webhook.hook_channel_id === channelId || (s.webhook.post_in === 'thread' && s.webhook.thread_id === channelId);
}

// Läuft der Bot auf diesem Server? So entscheidet es auch server/install.sh: die systemd-Einheit des Bots oder ein
// nicht leeres discord-bot/.env im Code-Ordner (Docker). Die Pfade sind für Tests austauschbar.
export const botPlaces = {
  unit: '/etc/systemd/system/onyoursite-bot.service',
  dockerEnv: (): string => join(ROOT_DIR, 'discord-bot', '.env'),
};
export function botOnThisServer(): boolean {
  if (existsSync(botPlaces.unit)) return true;
  try {
    return statSync(botPlaces.dockerEnv()).size > 0;
  } catch {
    return false;
  }
}

export interface BotCardInput {
  s: DiscordSettings;
  report: BotReport | null;
  installed: boolean;
  lastSeen: number | null;
  now: number;
  onThisServer: boolean;
  test: BotTest | null;
  // Beiträge des Bots, die in Discord stehen (für „Turned off“)
  botPosts: number;
}

export interface BotCard {
  state: BotCardState;
  online: boolean;
  // Der letzte Bericht nennt updates.v1: der Bot kann Updates posten
  canPost: boolean;
  // Der Bot postet neue Updates (vom Admin gespeichert oder von selbst in #updates)
  target: BotTarget | null;
  saved: boolean;
  // Vorauswahl im Formular: gespeicherter Kanal, sonst #updates aus dem Bericht
  channelId: string;
  mention: string;
  // Erste Zeile (Online · version … / Offline – last seen …)
  status: string;
  // Bereit, Problem, „Checking with the bot…“ oder ausgeschaltet
  line: { text: string; tone: Tone } | null;
  // Letzter Test über den Bot
  test: { state: string; text: string; tone: Tone } | null;
  // „Use #updates“: der Bot meldet #updates, darf dort posten, und er postet noch nicht dort
  offer: { channel_id: string; name: string; mention: string } | null;
  // Kopfzeile des Reiters: Abzeichen des Bots
  badge: { text: string; tone: Tone };
  // Wohin „Send test“ postet (gespeicherter Kanal, sonst #updates); null: es gibt keinen
  testPlace: Place | null;
}

// Ort, an dem der Bot läuft (aus seinem Bericht)
function runtimeText(runtime: string, here: boolean): string {
  if (runtime === 'service') return here ? 'system service on this server' : 'system service';
  if (runtime === 'docker') return here ? 'Docker on this server' : 'Docker';
  return 'elsewhere';
}

export function testLine(test: BotTest | null, rep: BotReport | null, now: number): BotCard['test'] {
  if (!test || test.state === '') return null;
  const at = strtotime(test.at);
  const age = at === false ? 0 : now - at;
  const place = placeOf(rep, test.channel_id);
  const where = place ? '#' + place.name : 'the channel';
  if (test.state === 'queued' && age < TEST_SECONDS) return { state: 'queued', text: 'Sending the test through the bot…', tone: 'warn' };
  if (test.state === 'queued' || test.state === 'expired') {
    return { state: 'expired', text: 'The bot didn’t answer within 2 minutes – it may be offline. Try again when it shows Online.', tone: 'err' };
  }
  if (test.state === 'ok') return { state: 'ok', text: `Test message posted in ${where} at ${date('H:i', at === false ? now : at)}.`, tone: 'ok' };
  return { state: 'failed', text: 'The test failed: ' + (test.error !== '' ? test.error : 'the bot didn’t say why.'), tone: 'err' };
}

export function botCard(i: BotCardInput): BotCard {
  const { s, report: rep, now } = i;
  const online = i.lastSeen !== null && now - i.lastSeen < ONLINE_SECONDS;
  const canPost = i.installed && !!rep && rep.features.includes('updates.v1');
  const saved = s.bot.saved_at !== '';
  const target = botTarget(s, rep, i.installed);
  const savedAt = saved ? strtotime(s.bot.saved_at) : false;
  const seen = i.lastSeen !== null ? 'last seen ' + timeAgo(date('Y-m-d H:i:s', i.lastSeen)) : '';
  const card: BotCard = {
    state: 'online', online, canPost, target, saved, channelId: saved ? s.bot.channel_id : rep?.updates_channel_id ?? '', mention: saved ? s.bot.mention : '',
    status: '', line: null, test: null, offer: null, badge: { text: 'Online', tone: 'ok' }, testPlace: null,
  };
  if (!i.installed) {
    card.state = 'not_installed';
    card.badge = { text: 'Not set up', tone: 'warn' };
    return card;
  }
  card.badge = online ? { text: 'Online', tone: 'ok' } : { text: 'Offline', tone: 'muted' };
  const offlineText = i.lastSeen !== null ? 'Offline – last seen ' + date('M j, Y H:i', i.lastSeen) : 'Offline – the bot hasn’t checked in yet';
  if (!canPost || !rep) {
    card.state = 'old';
    card.status = online ? 'Online · ' + seen : offlineText;
    card.line = { text: 'The bot runs an older version that can’t post updates yet.', tone: 'warn' };
    return card;
  }
  card.status = online
    ? `Online · version ${rep.version} · ${runtimeText(rep.runtime, i.onThisServer)} · server “${rep.guild.name}” · channels checked ${timeAgo(date('Y-m-d H:i:s', rep.reported_at))}`
    : offlineText + '. New posts wait and go out when the bot is back; posts that wait longer than 24 hours aren’t sent.';
  card.test = testLine(i.test, rep, now);
  card.testPlace = placeOf(rep, card.channelId);

  // „Use #updates“: der Bot meldet #updates, darf dort posten, und er ist nicht schon (eingeschaltet) dort. Postet der
  // Webhook schon in #updates, wird nichts angeboten (das Speichern lehnte es ab: jedes Update käme zweimal).
  const updates = placeOf(rep, rep.updates_channel_id);
  const usesUpdates = saved && s.bot.enabled && s.bot.channel_id === rep.updates_channel_id;
  if (updates && updates.can_post && !usesUpdates && !(saved && !s.bot.enabled) && !webhookPostsInto(s, updates.id)) {
    const keep = saved && s.bot.mention !== '' && checkBotChoice(rep, updates.id, s.bot.mention).ok ? s.bot.mention : '';
    card.offer = { channel_id: updates.id, name: updates.name, mention: keep };
  }

  if (saved && !s.bot.enabled) {
    card.state = 'off';
    const n = i.botPosts;
    card.line = { text: 'The bot doesn’t announce new updates.' + (n > 0 ? ` It still edits and removes the ${n} post${n === 1 ? '' : 's'} it made.` : ''), tone: 'muted' };
    return card;
  }
  const checking = saved && savedAt !== false && rep.reported_at < savedAt && now - savedAt < CHECK_SECONDS && online;
  if (checking) {
    card.state = 'checking';
    card.badge = { text: 'Checking', tone: 'warn' };
    card.line = { text: 'Checking with the bot…', tone: 'warn' };
    return card;
  }
  card.state = online ? 'online' : 'offline';
  if (target) {
    const choice = checkBotChoice(rep, target.channel_id, target.mention);
    if (!choice.ok) card.line = { text: choice.error.replace(/^(Channel|Ping): /, ''), tone: 'err' };
    else if (webhookPostsInto(s, target.channel_id)) card.line = { text: 'The webhook posts into the same channel – updates show up twice. Choose another channel for the bot or remove the webhook.', tone: 'err' };
    else if (target.auto) card.line = { text: `Ready – the bot posts new updates in #${choice.place.name} by itself while nothing else is set up.`, tone: 'ok' };
    else card.line = { text: `Ready – the bot can post in #${choice.place.name}.`, tone: 'ok' };
  } else if (!saved && (activeWebhook(s) || tokenUsable(s))) {
    card.line = { text: `Updates are posted with ${activeWebhook(s) ? 'the webhook' : 'the old bot token'} right now. Choose a channel and save to let the bot post them as well.`, tone: 'muted' };
  } else {
    card.line = { text: 'Choose the channel the bot posts updates in, then save.', tone: 'muted' };
  }
  return card;
}

// Bot-Test aus oys_meta (kaputter Wert: kein Test)
export function parseBotTest(raw: unknown): BotTest | null {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (v === null || typeof v !== 'object') return null;
    const str = (x: unknown): string => (typeof x === 'string' ? x : '');
    return { at: str(v.at), state: str(v.state), job_id: Number.isSafeInteger(v.job_id) ? Number(v.job_id) : 0, channel_id: str(v.channel_id), error: str(v.error) };
  } catch {
    return null;
  }
}
