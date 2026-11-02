// Beiträge eines Updates in Discord (update_discord_posts): je Update und Ziel (bot, webhook, token = alter Bot-Token)
// eine Zeile mit Zustand – queued | posting | posted | failed | removing | remove_failed.
//
// Regeln gegen Doppelklicks und gleichzeitige Antworten des Bots (discord-pages §5.5.3):
// 1. Jeder Übergang läuft in einer Transaktion, die zuerst die Zeile sperrt (SELECT … FOR UPDATE), dann – wo ein Auftrag
//    beteiligt ist – den Auftrag. Reihenfolge immer: Zeile → Auftrag (auch in /_/bot/outbox und /done).
// 2. Eine fehlende Zeile entsteht mit INSERT IGNORE (uq_update_via): nur wer sie anlegt, macht weiter.
// 3. Discord wird nie in einer Transaktion gerufen. Webhook und Token: Zeile auf posting, festschreiben, senden, dann
//    erneut sperren und nur „WHERE state = 'posting'“ übernehmen.
// 4. Ein Auftrag für den Bot entsteht in derselben Transaktion wie seine Zeile.
// Die Entscheidungen selbst sind reine Funktionen (decide/decideResult) – die Tabelle prüfen Tests Zelle für Zelle.
import { exec, q, type Db, type Row } from '../db.js';
import { date, intval, mbSubstr, phpRtrim, phpStr, strtotime, time } from '../php.js';
import { phpJson } from '../html.js';
import { closeJob, jobFromRow, registerBotAction, registerCleanup, withRetry, type OutboxJob, type Prepared } from '../community/outbox.js';
import { outboxAdd, supersede } from '../community/community.js';
import { updateFromRow, type Update } from '../updates/updates.js';
import { discordBase, discordError, discordRequest, type DiscordResponse, type Payload } from './rest.js';
import { webhookDelete, webhookEdit, webhookPost, type WebhookLink } from './webhook.js';
import { activeWebhook, discordSettings, storeDiscordSettings, tokenUsable, type DiscordSettings } from './settings.js';
import { botStatus, botTarget, type BotTarget } from './botReport.js';
import { forEdit, styleOf, threadName, updatePayload, type PostVia } from './payload.js';

export type { PostVia };
export type PostState = 'queued' | 'posting' | 'posted' | 'failed' | 'removing' | 'remove_failed';
export type PostKind = 'message' | 'thread_msg' | 'forum_post';

export interface PostRow {
  id: number;
  update_id: number;
  via: PostVia;
  target: string;
  kind: PostKind;
  channel_id: string | null;
  message_id: string | null;
  state: PostState;
  dirty: boolean;
  legacy: boolean;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export const TEXTS = {
  alreadyPosting: 'Already posting to Discord – this takes a few seconds.',
  alreadyQueued: 'Already queued for the bot.',
  stillRemoving: 'Still removing the previous Discord post – try again in a moment.',
  removeFailedFirst: 'Its earlier Discord post couldn’t be removed yet – use Retry or Forget on it first.',
  stillPosting: 'Still posting to Discord – try again in a few seconds.',
  tooEarly: 'This post is still being handled – try again in a few minutes.',
  stuck: 'The website stopped while posting – the message may be in Discord. Check the channel before you retry.',
  notPicked: 'Not posted: the bot didn’t pick it up within 24 hours.',
  orphan: 'The update was deleted, but its Discord post is still there.',
  noBotEdit: 'not updated – the Discord bot isn’t set up',
  noBotRemove: 'Discord isn’t connected, so its post there was not removed – please delete it in Discord yourself.',
  otherBot: 'Posted by a different bot – it can’t be edited from here.',
  noMessageId: 'The bot didn’t report which message it posted.',
} as const;

const now = (): string => date('Y-m-d H:i:s');
// Fehlertext für die Spalte error (300 Zeichen)
const cut = (text: string): string => mbSubstr(text, 0, 300);
export const refOf = (postId: number): string => 'post:' + postId;
// Wie lange ein Zustand dauern darf, bevor „Forget“ geht bzw. das Aufräumen eingreift (Sekunden)
export const POSTING_STUCK = 120;
export const BOT_FORGET_AFTER = 600;

export function rowFrom(r: Row): PostRow {
  const via = phpStr(r.via);
  const kind = phpStr(r.kind);
  return {
    id: intval(r.id),
    update_id: intval(r.update_id),
    via: (via === 'bot' || via === 'token' ? via : 'webhook') as PostVia,
    target: phpStr(r.target),
    kind: (kind === 'thread_msg' || kind === 'forum_post' ? kind : 'message') as PostKind,
    channel_id: r.channel_id === null || r.channel_id === undefined ? null : phpStr(r.channel_id),
    message_id: r.message_id === null || r.message_id === undefined ? null : phpStr(r.message_id),
    state: phpStr(r.state) as PostState,
    dirty: intval(r.dirty) === 1,
    legacy: intval(r.legacy) === 1,
    error: r.error === null || r.error === undefined ? null : phpStr(r.error),
    created_at: phpStr(r.created_at),
    updated_at: phpStr(r.updated_at),
  };
}

const ageOfRow = (row: PostRow): number => {
  const t = strtotime(row.updated_at);
  return t === false ? 0 : time() - t;
};

// ------------------------------------------------------------------ reine Entscheidungen

export type AdminEvent = 'announce' | 'edit' | 'remove' | 'retry' | 'forget' | 'cleanup';
export interface Facts {
  via: PostVia;
  state: PostState;
  ageSec: number; // seit der letzten Änderung der Zeile
  jobClaimed: boolean; // der offene Auftrag (update.post) ist schon beim Bot
  hasError: boolean;
  botInstalled: boolean;
  updateGone: boolean;
}
export type Decision =
  | 'claim_post' // Webhook/Token: Zeile (neu oder nach failed) auf posting, dann senden
  | 'queue_post' // Bot: Zeile (neu oder nach failed) auf queued + update.post
  | 'edit' // posted: Webhook/Token bearbeiten bzw. Bot: update.edit (beim Ankündigen: „stattdessen bearbeiten“)
  | 'edit_no_bot' // Bot-Beitrag ohne installierten Bot: bleibt posted, mit Fehler
  | 'mark_dirty' // Inhalt geändert, während der Beitrag noch entsteht
  | 'delete' // Webhook/Token löschen bzw. Bot: removing + update.delete
  | 'delete_no_bot' // Bot-Beitrag ohne installierten Bot: remove_failed mit Hinweis
  | 'cancel' // Auftrag noch nicht beim Bot: Auftrag beenden, Zeile löschen
  | 'set_removing' // Auftrag schon beim Bot: removing (sein Ergebnis löst das Löschen aus)
  | 'drop' // Zeile löschen
  | 'drop_jobs' // Zeile löschen, offene und tote Aufträge beenden
  | 'fail_stuck' // posting zu lange: failed
  | 'orphan' // Update gelöscht, Beitrag noch da: remove_failed
  | 'none'
  | 'already_queued' | 'already_posting' | 'still_removing' | 'remove_failed_first' | 'still_posting' | 'too_early';

export function decide(event: AdminEvent, f: Facts | null, via: PostVia): Decision {
  const bot = via === 'bot';
  const editOrNoBot: Decision = bot && f !== null && !f.botInstalled ? 'edit_no_bot' : 'edit';
  const deleteOrNoBot: Decision = bot && f !== null && !f.botInstalled ? 'delete_no_bot' : 'delete';
  if (f === null) return event === 'announce' ? (bot ? 'queue_post' : 'claim_post') : 'none';
  switch (event) {
    case 'announce':
      switch (f.state) {
        case 'queued': return 'already_queued';
        case 'posting': return 'already_posting';
        case 'posted': return editOrNoBot;
        case 'failed': return bot ? 'queue_post' : 'claim_post';
        case 'removing': return 'still_removing';
        case 'remove_failed': return 'remove_failed_first';
      }
      break;
    case 'edit':
      switch (f.state) {
        case 'queued':
        case 'posting': return 'mark_dirty';
        case 'posted': return editOrNoBot;
        default: return 'none';
      }
    case 'remove':
      switch (f.state) {
        case 'queued': return f.jobClaimed ? 'set_removing' : 'cancel';
        case 'posting': return 'still_posting';
        case 'posted':
        case 'remove_failed': return deleteOrNoBot;
        case 'failed': return 'drop';
        case 'removing': return 'none';
      }
      break;
    case 'retry':
      switch (f.state) {
        case 'posted': return f.hasError ? editOrNoBot : 'none';
        case 'failed': return bot ? 'queue_post' : 'claim_post';
        case 'remove_failed': return deleteOrNoBot;
        default: return 'none';
      }
    case 'forget':
      switch (f.state) {
        case 'queued':
        case 'removing': return f.ageSec >= BOT_FORGET_AFTER ? 'drop_jobs' : 'too_early';
        case 'posting': return f.ageSec >= POSTING_STUCK ? 'drop_jobs' : 'too_early';
        default: return 'drop_jobs';
      }
    case 'cleanup':
      if (f.state === 'posting' && f.ageSec >= POSTING_STUCK) return 'fail_stuck';
      if (f.state === 'posted' && f.updateGone) return 'orphan';
      return 'none';
  }
  return 'none';
}

// Ergebnis eines Bot-Auftrags: ok, not_found (only_if_posted ohne eigenen Beitrag), missing (Nachricht in Discord
// gelöscht), failed (endgültig oder tot), retry (Fehler, es gibt noch Versuche)
export type ResultOutcome = 'ok' | 'not_found' | 'missing' | 'failed' | 'retry';
export type ResultDecision =
  | 'posted' | 'store_and_delete' | 'failed_not_picked' | 'failed' | 'drop' | 'clear_error' | 'edit_error' | 'remove_failed' | 'ignore';

export function decideResult(action: string, outcome: ResultOutcome, state: PostState): ResultDecision {
  if (outcome === 'retry') return 'ignore';
  if (action === 'update.post') {
    if (state === 'queued') return outcome === 'ok' ? 'posted' : outcome === 'not_found' ? 'failed_not_picked' : 'failed';
    if (state === 'removing') return outcome === 'ok' ? 'store_and_delete' : 'drop';
    return 'ignore';
  }
  if (action === 'update.edit') {
    if (state !== 'posted') return 'ignore';
    return outcome === 'ok' ? 'clear_error' : outcome === 'missing' ? 'drop' : 'edit_error';
  }
  if (action === 'update.delete') {
    if (state !== 'removing') return 'ignore';
    return outcome === 'failed' ? 'remove_failed' : 'drop';
  }
  return 'ignore';
}

// ------------------------------------------------------------------ Ziele

export interface Delivery {
  s: DiscordSettings;
  hook: WebhookLink | null; // eingeschalteter Webhook
  token: boolean; // alter Token mit Kanal (neue Beiträge)
  bot: BotTarget | null; // Bot als Ziel für neue Beiträge
  botInstalled: boolean;
  botOnline: boolean;
  botCanPost: boolean; // sein letzter Bericht nennt updates.v1
}

export async function delivery(): Promise<Delivery> {
  const s = await discordSettings();
  const st = await botStatus();
  return {
    s, hook: activeWebhook(s), token: tokenUsable(s), bot: botTarget(s, st.report, st.installed),
    botInstalled: st.installed, botOnline: st.online, botCanPost: st.canPostUpdates,
  };
}

export const anyDestination = (d: Delivery): boolean => !!(d.hook || d.token || d.bot);

interface Dest { via: PostVia; target: string; kind: PostKind; channel_id: string | null }

const kindOf = (channelType: string): PostKind => (channelType === 'forum' ? 'forum_post' : channelType === 'thread' ? 'thread_msg' : 'message');

export function destinations(d: Delivery): Dest[] {
  const out: Dest[] = [];
  if (d.hook) {
    const postIn = d.s.webhook.post_in;
    out.push({ via: 'webhook', target: 'webhook:' + d.hook.id, kind: kindOf(postIn === 'channel' ? 'text' : postIn), channel_id: postIn === 'thread' ? d.s.webhook.thread_id : null });
  }
  if (d.token) out.push({ via: 'token', target: 'bot:' + d.s.channel_id, kind: 'message', channel_id: d.s.channel_id });
  if (d.bot) out.push({ via: 'bot', target: 'bot', kind: kindOf(d.bot.channel_type), channel_id: d.bot.channel_id });
  return out;
}

// ------------------------------------------------------------------ Testhaken

// Nur für Tests: an festen Stellen anhalten (zwischen Lesen und Schreiben), um Rennen nachzustellen
export const postHooks: { pause: ((point: string, info: Record<string, unknown>) => Promise<void>) | null } = { pause: null };
async function barrier(point: string, info: Record<string, unknown>): Promise<void> {
  if (postHooks.pause) await postHooks.pause(point, info);
}

// ------------------------------------------------------------------ Zeilen

async function lockRow(db: Db, updateId: number, via: PostVia): Promise<PostRow | null> {
  const r = await db.one('SELECT * FROM update_discord_posts WHERE update_id = ? AND via = ? FOR UPDATE', [updateId, via]);
  return r ? freshen(db, rowFrom(r)) : null;
}

async function lockRowById(db: Db, id: number): Promise<PostRow | null> {
  const r = await db.one('SELECT * FROM update_discord_posts WHERE id = ? FOR UPDATE', [id]);
  return r ? freshen(db, rowFrom(r)) : null;
}

// Ein Beitrag, der zu lange „posting“ ist (die Website hielt mitten im Senden an), gilt beim Lesen als fehlgeschlagen
async function freshen(db: Db, row: PostRow): Promise<PostRow> {
  if (row.state !== 'posting' || ageOfRow(row) < POSTING_STUCK) return row;
  await db.exec("UPDATE update_discord_posts SET state = 'failed', error = ?, updated_at = ? WHERE id = ? AND state = 'posting'", [TEXTS.stuck, now(), row.id]);
  return { ...row, state: 'failed', error: TEXTS.stuck };
}

// Offene (und tote) Aufträge eines Beitrags, gesperrt – nach der Zeile
async function lockJobs(db: Db, postId: number): Promise<OutboxJob[]> {
  const rows = await db.q('SELECT id, action, payload, attempts, ref, created_at, claimed_at, done_at FROM community_outbox WHERE ref = ? AND done_at IS NULL ORDER BY id FOR UPDATE', [refOf(postId)]);
  return rows.map(jobFromRow);
}

async function setRow(db: Db, id: number, fields: Record<string, string | number | null>): Promise<void> {
  const keys = Object.keys(fields);
  await db.exec(`UPDATE update_discord_posts SET ${keys.map((k) => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, [...keys.map((k) => fields[k]), now(), id]);
}

async function dropRow(db: Db, id: number): Promise<void> {
  await db.exec('DELETE FROM update_discord_posts WHERE id = ?', [id]);
}

// Alle offenen und toten Aufträge eines Beitrags beenden (z. B. „Forget“)
async function closeJobs(db: Db, jobs: OutboxJob[], reason: string): Promise<void> {
  for (const j of jobs) await closeJob(db, j.id, reason);
}

function facts(row: PostRow, d: Pick<Delivery, 'botInstalled'>, jobs: OutboxJob[] = [], updateGone = false): Facts {
  const post = jobs.filter((j) => j.action === 'update.post' && j.attempts < 10).pop();
  return {
    via: row.via, state: row.state, ageSec: ageOfRow(row), jobClaimed: !!post && post.claimed_at !== null, hasError: (row.error ?? '') !== '',
    botInstalled: d.botInstalled, updateGone,
  };
}

// Beiträge mehrerer Updates (für Anzeigen)
export async function postsOf(updateIds: number[]): Promise<Map<number, PostRow[]>> {
  const out = new Map<number, PostRow[]>();
  const ids = updateIds.filter((i) => Number.isSafeInteger(i) && i > 0);
  if (!ids.length) return out;
  for (const r of await q(`SELECT * FROM update_discord_posts WHERE update_id IN (${ids.map(() => '?').join(', ')}) ORDER BY id`, ids)) {
    const row = rowFrom(r);
    out.set(row.update_id, [...(out.get(row.update_id) ?? []), row]);
  }
  return out;
}

async function rowsOf(updateId: number): Promise<PostRow[]> {
  return (await q('SELECT * FROM update_discord_posts WHERE update_id = ? ORDER BY id', [updateId])).map(rowFrom);
}

// ------------------------------------------------------------------ Aufträge für den Bot

function postJob(row: { id: number }, u: Update, d: Delivery): Record<string, unknown> {
  const bot = d.bot as BotTarget;
  return {
    post_id: row.id, update_id: u.id, channel_id: bot.channel_id, kind: bot.channel_type, thread_name: threadName(u), recheck: false,
    only_if_posted: false, message: updatePayload(u, styleOf(d.s, 'bot'), 'bot'),
  };
}

function editJob(row: PostRow, u: Update, s: DiscordSettings): Record<string, unknown> {
  return {
    post_id: row.id, channel_id: row.channel_id ?? '', message_id: row.message_id ?? '', kind: row.kind, thread_name: threadName(u),
    message: forEdit(updatePayload(u, styleOf(s, 'bot'), 'bot')),
  };
}

function deleteJob(row: PostRow): Record<string, unknown> {
  return { post_id: row.id, channel_id: row.channel_id ?? '', message_id: row.message_id ?? '', kind: row.kind };
}

async function queueEdit(db: Db, row: PostRow, u: Update, s: DiscordSettings): Promise<void> {
  await supersede(refOf(row.id), 'update.edit', db);
  await outboxAdd('update.edit', editJob(row, u, s), { ref: refOf(row.id), db });
}

async function queueDelete(db: Db, row: PostRow): Promise<void> {
  await setRow(db, row.id, { state: 'removing', error: null });
  await outboxAdd('update.delete', deleteJob(row), { ref: refOf(row.id), db });
}

// ------------------------------------------------------------------ Discord direkt (Webhook, alter Token)

// state wie bisher: ok | missing (in Discord gelöscht) | unreachable (anderer Webhook/Bot, Webhook/Kanal gelöscht)
// | disconnected (kein Ziel mehr) | failed (z. B. Zeitüberschreitung, Rate-Limit, fehlende Rechte)
export interface DiscordChange { state: 'ok' | 'missing' | 'unreachable' | 'disconnected' | 'failed'; error: string | null; transient: boolean }

const ok2xx = (res: DiscordResponse): boolean => res.status >= 200 && res.status < 300;
const tokenUrl = (channel: string): string => discordBase() + '/v10/channels/' + channel + '/messages';
const webhookIdOf = (target: string): string => /^webhook:(\d{5,25})$/.exec(target)?.[1] ?? '';

// Kann diese Zeile über die Website erreicht werden?
export function reach(d: Delivery, row: PostRow): 'ok' | 'unreachable' | 'disconnected' {
  if (row.via === 'webhook' && d.hook && webhookIdOf(row.target) === d.hook.id) return 'ok';
  if (row.via === 'token' && d.s.bot_token !== '' && row.channel_id !== null) return 'ok';
  return anyDestination(d) ? 'unreachable' : 'disconnected';
}

// Bestehende Nachricht ändern (Payload) oder löschen (null)
async function changeMessage(d: Delivery, row: PostRow, payload: Payload | null): Promise<DiscordChange> {
  const r = reach(d, row);
  if (r === 'disconnected') return { state: 'disconnected', error: 'Discord isn’t connected', transient: false };
  if (r === 'unreachable') return { state: 'unreachable', error: 'it was posted through a different webhook or bot', transient: false };
  const messageId = row.message_id ?? '';
  if (!/^\d{5,25}$/.test(messageId)) return { state: 'missing', error: null, transient: false };
  let res: DiscordResponse;
  if (row.via === 'webhook') {
    const hook = d.hook as WebhookLink;
    const thread = row.kind !== 'message' ? row.channel_id ?? '' : '';
    res = payload === null ? await webhookDelete(hook, messageId, thread) : await webhookEdit(hook, messageId, payload, thread);
  } else {
    res = await discordRequest(payload === null ? 'DELETE' : 'PATCH', tokenUrl(row.channel_id as string) + '/' + messageId, payload, ['Authorization: Bot ' + d.s.bot_token]);
  }
  const via = row.via === 'token' ? 'token' : 'webhook';
  if (ok2xx(res)) return { state: 'ok', error: null, transient: false };
  if (res.status === 404 && res.code === 10008) return { state: 'missing', error: null, transient: false };
  if (res.status === 404 && (res.code === 10003 || res.code === 10015)) return { state: 'unreachable', error: discordError(res, via), transient: false };
  return { state: 'failed', error: discordError(res, via), transient: res.status === 0 || res.status === 429 || res.status >= 500 };
}

// Neue Nachricht über Webhook oder Token
async function sendNew(d: Delivery, dest: Dest, u: Update): Promise<{ ok: true; id: string; channel: string } | { ok: false; error: string }> {
  if (dest.via === 'token') {
    const res = await discordRequest('POST', tokenUrl(dest.channel_id as string), updatePayload(u, styleOf(d.s, 'token'), 'token'), ['Authorization: Bot ' + d.s.bot_token]);
    if (ok2xx(res)) return { ok: true, id: phpStr(res.data?.id ?? ''), channel: dest.channel_id as string };
    return { ok: false, error: discordError(res, 'token') };
  }
  const hook = d.hook as WebhookLink;
  const payload = updatePayload(u, styleOf(d.s, 'webhook'), 'webhook');
  const postIn = d.s.webhook.post_in;
  let res: DiscordResponse;
  if (postIn === 'forum') res = await webhookPost(hook, payload, { threadName: threadName(u) });
  else if (postIn === 'thread') res = await webhookPost(hook, payload, { threadId: d.s.webhook.thread_id });
  else res = await webhookPost(hook, payload);
  if (!ok2xx(res)) return { ok: false, error: discordError(res, 'webhook') };
  const id = phpStr(res.data?.id ?? '');
  const channel = phpStr(res.data?.channel_id ?? '');
  let where = /^\d{15,25}$/.test(channel) ? channel : '';
  if (postIn === 'forum' && where === '') where = id; // ein Forenbeitrag hat die ID seiner ersten Nachricht
  if (postIn === 'thread') {
    where = d.s.webhook.thread_id;
    // Der erste Beitrag in den Thread hat geklappt: der Thread ist bestätigt
    if (!d.s.webhook.thread_verified) {
      const fresh = await discordSettings();
      if (fresh.webhook.thread_id === d.s.webhook.thread_id && !fresh.webhook.thread_verified) {
        fresh.webhook.thread_verified = true;
        await storeDiscordSettings(fresh);
      }
    }
  }
  return { ok: true, id, channel: where };
}

// ------------------------------------------------------------------ Ankündigen

export type AnnounceOutcome =
  | { via: PostVia; what: 'posted' } // neue Nachricht (Webhook/Token)
  | { via: PostVia; what: 'edited'; change: DiscordChange } // war schon da: bearbeitet (Webhook/Token)
  | { via: PostVia; what: 'queued'; job: 'post' | 'edit' } // für den Bot eingereiht
  | { via: PostVia; what: 'busy'; text: string } // läuft schon / blockiert
  | { via: PostVia; what: 'failed'; error: string }; // Discord hat abgelehnt oder war nicht erreichbar

// Neue Beiträge an jedes eingeschaltete Ziel (Webhook und Token sofort, der Bot über die Warteschlange). Ist das Update
// an einem Ziel schon gepostet, wird dort nur bearbeitet – wie bisher.
export async function announce(u: Update, d: Delivery): Promise<AnnounceOutcome[]> {
  const out: AnnounceOutcome[] = [];
  for (const dest of destinations(d)) out.push(dest.via === 'bot' ? await announceBot(u, d, dest) : await announceSync(u, d, dest));
  return out;
}

async function announceBot(u: Update, d: Delivery, dest: Dest): Promise<AnnounceOutcome> {
  return withRetry(async (db): Promise<AnnounceOutcome> => {
    let row = await lockRow(db, u.id, 'bot');
    if (!row) {
      const res = await db.exec(
        "INSERT IGNORE INTO update_discord_posts (update_id, via, target, kind, channel_id, state, created_at, updated_at) VALUES (?, 'bot', 'bot', ?, ?, 'queued', ?, ?)",
        [u.id, dest.kind, dest.channel_id, now(), now()],
      );
      if (res.affectedRows) {
        await outboxAdd('update.post', postJob({ id: res.insertId }, u, d), { ref: refOf(res.insertId), db });
        await barrier('announce:queued', { postId: res.insertId });
        return { via: 'bot', what: 'queued', job: 'post' };
      }
      row = await lockRow(db, u.id, 'bot');
      if (!row) return { via: 'bot', what: 'busy', text: TEXTS.alreadyQueued };
    }
    const decision = decide('announce', facts(row, d), 'bot');
    switch (decision) {
      case 'queue_post':
        // Tote Aufträge des früheren Versuchs sind damit erledigt
        await closeJobs(db, (await lockJobs(db, row.id)).filter((j) => j.attempts >= 10), 'retried');
        await setRow(db, row.id, { state: 'queued', kind: dest.kind, channel_id: dest.channel_id, target: 'bot', message_id: null, error: null, dirty: 0, legacy: 0 });
        await outboxAdd('update.post', postJob(row, u, d), { ref: refOf(row.id), db });
        return { via: 'bot', what: 'queued', job: 'post' };
      case 'edit':
        await queueEdit(db, row, u, d.s);
        return { via: 'bot', what: 'queued', job: 'edit' };
      default:
        return { via: 'bot', what: 'busy', text: busyText(decision) };
    }
  });
}

function busyText(decision: Decision): string {
  switch (decision) {
    case 'already_queued': return TEXTS.alreadyQueued;
    case 'already_posting': return TEXTS.alreadyPosting;
    case 'still_removing': return TEXTS.stillRemoving;
    case 'remove_failed_first': return TEXTS.removeFailedFirst;
    case 'still_posting': return TEXTS.stillPosting;
    case 'too_early': return TEXTS.tooEarly;
    case 'edit_no_bot': return 'Its Discord post was ' + TEXTS.noBotEdit + '.';
    default: return '';
  }
}

async function announceSync(u: Update, d: Delivery, dest: Dest, depth = 0): Promise<AnnounceOutcome> {
  // 1. Zeile übernehmen (neu oder nach einem Fehler) – oder sagen, warum nicht
  const claim = await withRetry(async (db): Promise<{ go: 'post'; id: number } | { go: 'edit'; row: PostRow } | { go: 'stop'; text: string }> => {
    let row = await lockRow(db, u.id, dest.via);
    if (!row) {
      const res = await db.exec(
        "INSERT IGNORE INTO update_discord_posts (update_id, via, target, kind, channel_id, state, legacy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'posting', ?, ?, ?)",
        [u.id, dest.via, dest.target, dest.kind, dest.channel_id, dest.via === 'token' ? 1 : 0, now(), now()],
      );
      if (res.affectedRows) return { go: 'post', id: res.insertId };
      row = await lockRow(db, u.id, dest.via);
      if (!row) return { go: 'stop', text: TEXTS.alreadyPosting };
    }
    const decision = decide('announce', facts(row, d), dest.via);
    if (decision === 'claim_post') {
      await setRow(db, row.id, { state: 'posting', target: dest.target, kind: dest.kind, channel_id: dest.channel_id, message_id: null, error: null, dirty: 0 });
      return { go: 'post', id: row.id };
    }
    if (decision === 'edit') return { go: 'edit', row };
    return { go: 'stop', text: busyText(decision) };
  });
  if (claim.go === 'stop') return { via: dest.via, what: 'busy', text: claim.text };
  if (claim.go === 'edit') {
    // Schon in Discord: nur bearbeiten. In Discord gelöscht oder nicht mehr erreichbar → vergessen und neu posten.
    const change = await editSyncRow(u, d, claim.row);
    if ((change.state !== 'missing' && change.state !== 'unreachable') || depth > 0) return { via: dest.via, what: 'edited', change };
    return announceSync(u, d, dest, depth + 1);
  }
  await barrier('announce:claimed', { postId: claim.id, via: dest.via });
  // 2. Senden (außerhalb jeder Transaktion)
  const sent = await sendNew(d, dest, u);
  await barrier('announce:sent', { postId: claim.id, via: dest.via });
  // 3. Ergebnis nur übernehmen, wenn die Zeile noch „posting“ ist
  const dirty = await withRetry(async (db) => {
    const row = await lockRowById(db, claim.id);
    if (!row || row.state !== 'posting') return false;
    if (!sent.ok) {
      await setRow(db, row.id, { state: 'failed', error: cut(sent.error) });
      return false;
    }
    await setRow(db, row.id, { state: 'posted', message_id: sent.id, channel_id: sent.channel !== '' ? sent.channel : row.channel_id, error: null, dirty: 0 });
    return row.dirty;
  });
  if (!sent.ok) return { via: dest.via, what: 'failed', error: sent.error };
  // Inhalt hat sich während des Sendens geändert: gleich nachziehen
  if (dirty) {
    const row = (await rowsOf(u.id)).find((r) => r.id === claim.id);
    const fresh = await updateById(u.id);
    if (row && fresh) await editSyncRow(fresh, d, row);
  }
  return { via: dest.via, what: 'posted' };
}

async function updateById(id: number, db?: Db): Promise<Update | null> {
  const r = db ? await db.one('SELECT * FROM updates WHERE id = ?', [id]) : (await q('SELECT * FROM updates WHERE id = ?', [id]))[0];
  return r ? updateFromRow(r) : null;
}

// Bearbeiten über Webhook/Token und das Ergebnis eintragen
async function editSyncRow(u: Update, d: Delivery, row: PostRow): Promise<DiscordChange> {
  const change = await changeMessage(d, row, forEdit(updatePayload(u, styleOf(d.s, row.via), row.via)));
  await withRetry(async (db) => {
    const cur = await lockRowById(db, row.id);
    if (!cur || cur.state !== 'posted') return;
    if (change.state === 'ok') await setRow(db, cur.id, { error: null });
    else if (change.state === 'missing' || change.state === 'unreachable') await dropRow(db, cur.id);
    else if (change.state === 'failed') await setRow(db, cur.id, { error: cut(phpStr(change.error)) });
  });
  return change;
}

// ------------------------------------------------------------------ Bearbeiten

export type EditOutcome =
  | { via: PostVia; what: 'changed'; change: DiscordChange } // Webhook/Token
  | { via: PostVia; what: 'queued' } // Bot: update.edit eingereiht (oder vorgemerkt, solange der Beitrag noch entsteht)
  | { via: PostVia; what: 'no_bot' }; // Bot-Beitrag, aber kein Bot installiert

// Geändertes Update in allen seinen Beiträgen nachziehen – postet nie neu
export async function syncEdit(u: Update, d: Delivery): Promise<EditOutcome[]> {
  const out: EditOutcome[] = [];
  for (const r of await rowsOf(u.id)) {
    const step = await withRetry(async (db): Promise<{ sync: PostRow } | EditOutcome | null> => {
      const row = await lockRowById(db, r.id);
      if (!row) return null;
      const decision = decide('edit', facts(row, d), row.via);
      await barrier('edit:locked', { postId: row.id, decision });
      switch (decision) {
        case 'mark_dirty':
          await setRow(db, row.id, { dirty: 1 });
          return row.via === 'bot' ? { via: 'bot', what: 'queued' } : null;
        case 'edit':
          if (row.via !== 'bot') return { sync: row };
          await queueEdit(db, row, u, d.s);
          return { via: 'bot', what: 'queued' };
        case 'edit_no_bot':
          await setRow(db, row.id, { error: TEXTS.noBotEdit });
          return { via: 'bot', what: 'no_bot' };
        default:
          return null;
      }
    });
    if (step === null) continue;
    if ('sync' in step) out.push({ via: step.sync.via, what: 'changed', change: await editSyncRow(u, d, step.sync) });
    else out.push(step);
  }
  return out;
}

// ------------------------------------------------------------------ Entfernen

export type RemoveOutcome =
  | { via: PostVia; what: 'removed' } // weg (gelöscht, war schon gelöscht, Auftrag rechtzeitig abgebrochen)
  | { via: PostVia; what: 'queued' } // Bot: update.delete eingereiht oder nach dem laufenden Post
  | { via: PostVia; what: 'change'; change: DiscordChange } // Webhook/Token: nicht (sicher) entfernt
  | { via: PostVia; what: 'busy'; text: string };

// Beiträge eines Updates entfernen (Entwurf oder Löschen). deleting: das Update wird gleich gelöscht – ein kurzer
// Aussetzer bei Discord bricht dann alles ab (abort), bevor der Bot einen Auftrag bekommt.
export async function remove(u: Update, d: Delivery, opts: { deleting?: boolean } = {}): Promise<{ abort: DiscordChange | null; outcomes: RemoveOutcome[] }> {
  const rows = await rowsOf(u.id);
  const ordered = [...rows.filter((r) => r.via !== 'bot'), ...rows.filter((r) => r.via === 'bot')];
  const outcomes: RemoveOutcome[] = [];
  for (const r of ordered) {
    const step = await withRetry(async (db): Promise<{ sync: PostRow } | RemoveOutcome | null> => {
      const row = await lockRowById(db, r.id);
      if (!row) return null;
      const jobs = row.via === 'bot' ? await lockJobs(db, row.id) : [];
      const decision = decide('remove', facts(row, d, jobs), row.via);
      await barrier('remove:locked', { postId: row.id, decision });
      switch (decision) {
        case 'cancel':
          await closeJobs(db, jobs.filter((j) => j.action === 'update.post'), 'cancelled');
          await dropRow(db, row.id);
          return { via: row.via, what: 'removed' };
        case 'set_removing':
          await setRow(db, row.id, { state: 'removing' });
          return { via: row.via, what: 'queued' };
        case 'delete':
          if (row.via !== 'bot') return { sync: row };
          await supersede(refOf(row.id), 'update.edit', db);
          await queueDelete(db, row);
          return { via: 'bot', what: 'queued' };
        case 'delete_no_bot':
          await setRow(db, row.id, { state: 'remove_failed', error: TEXTS.noBotRemove });
          return { via: 'bot', what: 'change', change: { state: 'disconnected', error: 'Discord isn’t connected', transient: false } };
        case 'drop':
          await dropRow(db, row.id);
          return null;
        case 'still_posting':
          return { via: row.via, what: 'busy', text: TEXTS.stillPosting };
        default:
          return null;
      }
    });
    if (step === null) continue;
    if (!('sync' in step)) {
      outcomes.push(step);
      continue;
    }
    const change = await changeMessage(d, step.sync, null);
    if (opts.deleting && change.state === 'failed' && change.transient) return { abort: change, outcomes };
    await withRetry(async (db) => {
      const cur = await lockRowById(db, step.sync.id);
      if (!cur || (cur.state !== 'posted' && cur.state !== 'remove_failed')) return;
      if (change.state === 'ok' || change.state === 'missing' || change.state === 'unreachable') await dropRow(db, cur.id);
      // Nicht entfernt: beim Löschen des Updates bleibt die Zeile als „couldn’t remove“ (der Beitrag ist ja noch da)
      else if (opts.deleting) await setRow(db, cur.id, { state: 'remove_failed', error: cut(phpStr(change.error ?? TEXTS.noBotRemove)) });
      else if (change.state === 'failed') await setRow(db, cur.id, { error: cut(phpStr(change.error)) });
    });
    outcomes.push(change.state === 'ok' || change.state === 'missing' ? { via: step.sync.via, what: 'removed' } : { via: step.sync.via, what: 'change', change });
  }
  return { abort: null, outcomes };
}

// Steht das Update (noch) in Discord – gepostet, unterwegs oder beim Entfernen? (ein fehlgeschlagener Beitrag nicht)
export const isOnDiscord = (rows: PostRow[] | undefined): boolean => !!rows && rows.some((r) => r.state !== 'failed');

// Wird gerade für dieses Update gesendet (Webhook/Token, noch keine 2 Minuten)? Dann wird es nicht gelöscht.
export async function stillPosting(updateId: number): Promise<boolean> {
  return (await rowsOf(updateId)).some((r) => r.state === 'posting' && ageOfRow(r) < POSTING_STUCK);
}

// ------------------------------------------------------------------ Retry und Forget (für die Karte „Discord posts“)

export async function retry(postId: number, d: Delivery): Promise<{ ok: boolean; text: string }> {
  const step = await withRetry(async (db): Promise<{ ok: boolean; text: string } | { sync: PostRow; decision: Decision }> => {
    const row = await lockRowById(db, postId);
    if (!row) return { ok: false, text: 'This Discord post is no longer listed.' };
    const jobs = await lockJobs(db, row.id);
    const decision = decide('retry', facts(row, d, jobs), row.via);
    // Tote Aufträge dieses Beitrags sind damit erledigt
    await closeJobs(db, jobs.filter((j) => j.attempts >= 10), 'retried');
    const u = await updateById(row.update_id, db);
    switch (decision) {
      case 'edit':
        if (!u) return { ok: false, text: 'The update no longer exists.' };
        if (row.via !== 'bot') return { sync: row, decision };
        await queueEdit(db, row, u, d.s);
        return { ok: true, text: 'The bot updates its post within a few seconds.' };
      case 'queue_post':
        if (!u || !d.bot) return { ok: false, text: 'The bot can’t post updates right now.' };
        await setRow(db, row.id, { state: 'queued', error: null, dirty: 0, message_id: null, channel_id: d.bot.channel_id, kind: kindOf(d.bot.channel_type) });
        await outboxAdd('update.post', postJob(row, u, d), { ref: refOf(row.id), db });
        return { ok: true, text: 'Queued for the bot.' };
      case 'claim_post':
        if (!u) return { ok: false, text: 'The update no longer exists.' };
        return { sync: row, decision };
      case 'delete':
        if (row.via !== 'bot') return { sync: row, decision };
        await queueDelete(db, row);
        return { ok: true, text: 'The bot removes its post within a few seconds.' };
      case 'edit_no_bot':
      case 'delete_no_bot':
        return { ok: false, text: 'The Discord bot isn’t set up on this server.' };
      default:
        return { ok: false, text: 'There is nothing to retry for this post.' };
    }
  });
  if (!('sync' in step)) return step;
  const u = await updateById(step.sync.update_id);
  if (step.decision === 'claim_post') {
    // Nur an das Ziel dieses Beitrags (und nur, wenn es noch eingerichtet ist)
    const dest = destinations(d).find((x) => x.via === step.sync.via);
    if (!u || !dest) return { ok: false, text: 'This destination isn’t set up any more.' };
    const res = await announceSync(u, d, dest);
    if (res.what === 'posted' || res.what === 'edited') return { ok: true, text: 'Posted to Discord.' };
    return { ok: false, text: res.what === 'failed' ? res.error : res.what === 'busy' ? res.text : 'It couldn’t be posted.' };
  }
  if (step.decision === 'edit' && u) {
    const change = await editSyncRow(u, d, step.sync);
    return change.state === 'ok' ? { ok: true, text: 'The Discord post is updated.' } : { ok: false, text: phpStr(change.error ?? 'Its Discord post had been deleted.') };
  }
  const res = await remove(u ?? ({ id: step.sync.update_id } as Update), d, { deleting: !u });
  const mine = res.outcomes.find((o) => o.via === step.sync.via);
  return mine?.what === 'removed' ? { ok: true, text: 'Removed from Discord.' } : { ok: false, text: mine && mine.what === 'change' ? phpStr(mine.change.error) : 'It couldn’t be removed.' };
}

export async function forget(postId: number): Promise<{ ok: boolean; text: string }> {
  return withRetry(async (db) => {
    const row = await lockRowById(db, postId);
    if (!row) return { ok: false, text: 'This Discord post is no longer listed.' };
    const jobs = await lockJobs(db, row.id);
    const decision = decide('forget', facts(row, { botInstalled: true }, jobs), row.via);
    if (decision !== 'drop_jobs') return { ok: false, text: busyText(decision) };
    await closeJobs(db, jobs, 'forgotten');
    await dropRow(db, row.id);
    return { ok: true, text: 'Forgotten. If the message is in Discord, it stays there.' };
  });
}

// ------------------------------------------------------------------ Der alte Token geht

// Wird der alte Token gelöscht, übernimmt der installierte Bot dessen Beiträge (legacy: vielleicht von einer anderen
// Discord-Anwendung gepostet – dann kann er sie nicht ändern und sagt es). Ohne Bot werden sie vergessen (die
// Nachrichten bleiben in Discord, wie bisher bei nicht erreichbaren Beiträgen).
export async function tokenRowsToBot(db: Db, botInstalled: boolean): Promise<void> {
  await db.exec("DELETE FROM update_discord_posts WHERE via = 'token' AND state NOT IN ('posted', 'remove_failed')");
  if (!botInstalled) {
    await db.exec("DELETE FROM update_discord_posts WHERE via = 'token'");
    return;
  }
  // Hat das Update schon einen Bot-Beitrag, bleibt nur dieser (je Update und Ziel eine Zeile)
  await db.exec("DELETE t FROM update_discord_posts t JOIN update_discord_posts b ON b.update_id = t.update_id AND b.via = 'bot' WHERE t.via = 'token'");
  await db.exec("UPDATE update_discord_posts SET via = 'bot', target = 'bot', legacy = 1, updated_at = ? WHERE via = 'token'", [now()]);
}

// Der Webhook wird entfernt: seine Beiträge vergessen (sie bleiben in Discord)
export async function dropWebhookRows(db?: Db): Promise<void> {
  const sql = "DELETE FROM update_discord_posts WHERE via = 'webhook'";
  if (db) await db.exec(sql);
  else await exec(sql);
}

// ------------------------------------------------------------------ Ergebnisse des Bots (/_/bot/outbox/{id}/done)

const SNOWFLAKE = /^\d{15,25}$/;

export function classify(action: string, result: Record<string, unknown> | null, error: string, final: boolean): ResultOutcome {
  if (error !== '') return final ? 'failed' : 'retry';
  if (action === 'update.post') {
    if (result?.found === false) return 'not_found';
    return typeof result?.message_id === 'string' && SNOWFLAKE.test(result.message_id) ? 'ok' : 'failed';
  }
  if (result?.missing === true) return 'missing';
  return 'ok';
}

// onResult für update.post/edit/delete – läuft in der Transaktion von /done, die Zeile ist schon gesperrt
async function applyBotResult(db: Db, job: OutboxJob, result: Record<string, unknown> | null, error: string, final: boolean): Promise<void> {
  const row = await lockRowById(db, intval(job.data?.post_id ?? 0));
  if (!row) return; // inzwischen vergessen
  await barrier('result:locked', { postId: row.id, action: job.action });
  const outcome = classify(job.action, result, error, final);
  const decision = decideResult(job.action, outcome, row.state);
  let reason = error === 'expired' ? TEXTS.notPicked : error;
  if (outcome === 'failed' && error === '') reason = TEXTS.noMessageId;
  // Ein Beitrag eines anderen Bots (alter Token einer anderen Anwendung) lässt sich nicht ändern
  if (row.legacy && /\b(50005|50001)\b/.test(reason)) reason = TEXTS.otherBot;
  const messageId = typeof result?.message_id === 'string' && SNOWFLAKE.test(result.message_id) ? result.message_id : null;
  const channelId = typeof result?.channel_id === 'string' && SNOWFLAKE.test(result.channel_id) ? result.channel_id : row.channel_id;
  switch (decision) {
    case 'posted': {
      await setRow(db, row.id, { state: 'posted', message_id: messageId, channel_id: channelId, error: null, dirty: 0 });
      if (row.dirty) {
        const u = await updateById(row.update_id, db);
        if (u) await queueEdit(db, { ...row, state: 'posted', message_id: messageId, channel_id: channelId }, u, await discordSettings());
      }
      return;
    }
    case 'store_and_delete': {
      const posted = { ...row, message_id: messageId, channel_id: channelId };
      await setRow(db, row.id, { message_id: messageId, channel_id: channelId });
      await outboxAdd('update.delete', deleteJob(posted), { ref: refOf(row.id), db });
      return;
    }
    case 'failed_not_picked':
      await setRow(db, row.id, { state: 'failed', error: TEXTS.notPicked });
      return;
    case 'failed':
      await setRow(db, row.id, { state: 'failed', error: cut(reason) });
      return;
    case 'drop':
      await dropRow(db, row.id);
      return;
    case 'clear_error':
      await setRow(db, row.id, { error: null });
      return;
    case 'edit_error':
      await setRow(db, row.id, { error: cut(reason) });
      return;
    case 'remove_failed':
      await setRow(db, row.id, { state: 'remove_failed', error: cut(reason) });
      return;
    default:
  }
}

// Sperre der eigenen Zeile vor dem Auftrag (Sperr-Reihenfolge Zeile → Auftrag)
async function lockPostOf(db: Db, job: OutboxJob): Promise<void> {
  const id = intval(job.data?.post_id ?? 0);
  if (id > 0) await db.q('SELECT id FROM update_discord_posts WHERE id = ? FOR UPDATE', [id]);
}

const DAY = 86400;

// Regeln beim Ausgeben von update.post (die Zeile ist gesperrt)
async function preparePost(db: Db, job: OutboxJob): Promise<Prepared> {
  const row = await lockRowById(db, intval(job.data?.post_id ?? 0));
  if (!row) return { send: false, reason: 'cancelled' };
  const claimed = job.claimed_at !== null;
  const t = strtotime(job.created_at);
  const old = t !== false && time() - t > DAY;
  const data = job.data ?? {};
  if (row.state === 'removing' && row.message_id === null) {
    // Entfernt, bevor der Bot den Beitrag abgeholt hat: abbrechen; sonst nur einen schon geposteten melden lassen
    if (!claimed) {
      await dropRow(db, row.id);
      return { send: false, reason: 'cancelled' };
    }
    return { send: true, data: { ...data, recheck: true, only_if_posted: true } };
  }
  if (row.state !== 'queued') return { send: false, reason: 'skipped' };
  if (old) {
    // Nach 24 Stunden kein Beitrag mehr (keine überraschenden Pings); hatte der Bot ihn schon, meldet er nur ihn
    if (!claimed) return { send: false, reason: 'expired' };
    return { send: true, data: { ...data, recheck: true, only_if_posted: true } };
  }
  if (claimed) return { send: true, data: { ...data, recheck: true } };
  return { send: true };
}

async function prepareEdit(db: Db, job: OutboxJob): Promise<Prepared> {
  const row = await lockRowById(db, intval(job.data?.post_id ?? 0));
  return row && row.state === 'posted' ? { send: true } : { send: false, reason: 'skipped' };
}

// ------------------------------------------------------------------ Test über den Bot (oys_meta 'discord_bot_test')

const TEST_MAX_AGE = 120;

async function prepareTest(_db: Db, job: OutboxJob): Promise<Prepared> {
  const t = strtotime(job.created_at);
  return t !== false && time() - t > TEST_MAX_AGE ? { send: false, reason: 'expired' } : { send: true };
}

async function applyTestResult(db: Db, job: OutboxJob, _result: Record<string, unknown> | null, error: string, final: boolean): Promise<void> {
  if (!final) return;
  const raw = phpStr(await db.value("SELECT meta_value FROM oys_meta WHERE meta_key = 'discord_bot_test'"));
  let test: Record<string, unknown> = {};
  try {
    test = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  if (intval(test.job_id ?? 0) !== job.id) return;
  const state = error === '' ? 'ok' : error === 'expired' ? 'expired' : 'failed';
  const next = { ...test, at: now(), state, error: error === '' || error === 'expired' ? '' : cut(error) };
  await db.exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('discord_bot_test', ?)", [phpJson(next, { unescapedUnicode: true, unescapedSlashes: true })]);
}

// ------------------------------------------------------------------ Aufräumen (stündlich, siehe community/outbox.ts)

export async function postsCleanup(): Promise<void> {
  const stamp = now();
  // Hängt beim Senden: als fehlgeschlagen zeigen (die Nachricht kann trotzdem in Discord sein)
  await exec("UPDATE update_discord_posts SET state = 'failed', error = ?, updated_at = ? WHERE state = 'posting' AND updated_at < ?",
    [TEXTS.stuck, stamp, date('Y-m-d H:i:s', time() - POSTING_STUCK)]);
  // Update gelöscht, Beitrag noch da: nichts verschwindet still
  await exec("UPDATE update_discord_posts p LEFT JOIN updates u ON u.id = p.update_id SET p.state = 'remove_failed', p.error = ?, p.updated_at = ? WHERE p.state = 'posted' AND u.id IS NULL",
    [TEXTS.orphan, stamp]);
}

// ------------------------------------------------------------------ Register

registerBotAction('update.post', { feature: 'updates.v1', onResult: applyBotResult, maxAgeSec: DAY, lock: lockPostOf, prepare: preparePost });
registerBotAction('update.edit', { feature: 'updates.v1', onResult: applyBotResult, lock: lockPostOf, prepare: prepareEdit });
registerBotAction('update.delete', { feature: 'updates.v1', onResult: applyBotResult, lock: lockPostOf });
registerBotAction('update.test', { feature: 'updates.v1', onResult: applyTestResult, maxAgeSec: TEST_MAX_AGE, prepare: prepareTest });
registerBotAction('bot.report', { feature: 'updates.v1' });
registerCleanup(postsCleanup);

// Hinweis-Texte wie bisher (oys_discord_remove_note): '' = alles erledigt
export function removeNote(change: DiscordChange, deleted = false): string {
  if (change.state === 'ok' || change.state === 'missing') return '';
  if (change.state === 'disconnected') {
    return 'Discord isn’t connected, so its post there was not removed' + (deleted ? ' – please delete it in Discord yourself.' : '.');
  }
  if (change.state === 'unreachable' || deleted) {
    return 'Its Discord post couldn’t be removed (' + phpRtrim(phpStr(change.error), '.') + ') – please delete it in Discord yourself.';
  }
  return 'But Discord: ' + phpStr(change.error);
}
