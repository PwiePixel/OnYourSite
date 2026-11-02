// Statusseiten in Discord: Beiträge zu Vorfällen im Kanal #status des eigenen Bots (öffentlich, nur lesen) und die
// Aufträge des Bots für Statusmeldungen (#alerts, nur das Team). Ablauf wie bei den Beiträgen der Updates:
// - je Vorfall und Ziel eine Zeile in status_incident_posts: queued → posted | failed | removing;
// - ein neuer Beitrag ist der Auftrag status.post (ref 'status-inc:<Vorfall>'), Änderungen status.edit (ein noch nicht
//   abgeholtes älteres Bearbeiten wird ersetzt), Löschen status.delete – alles in der Transaktion, die den Vorfall
//   ändert. Beim Ausgeben an den Bot entsteht der Inhalt neu aus der Datenbank: er zeigt immer den neuesten Stand.
// - Die Nachrichten-ID kommt mit der Rückmeldung des Bots (/_/bot/outbox/{id}/done, result.message_id) und wird in
//   derselben Transaktion übernommen (onResult). Ändert sich der Vorfall, während der erste Beitrag noch aussteht
//   (dirty), folgt danach ein Bearbeiten. Eine in Discord gelöschte Nachricht (missing) wird nicht neu gepostet.
// Aufträge gibt es nur für einen Bot, der die Funktion status.v1 meldet (Register in community/outbox.ts) – ein älterer
// Bot bekommt sie nie. Sperr-Reihenfolge immer: Seite → Vorfall → Beitragszeile → Auftrag.
import type { Db } from '../db.js';
import { botSecret, outboxAdd, supersede } from '../community/community.js';
import { closeJob, registerBotAction, type OutboxJob, type Prepared } from '../community/outbox.js';
import { report, type BotReport } from '../discord/botReport.js';
import { mdPlain } from '../updates/markdown.js';
import { incidentPath } from './links.js';
import { loadIncidents, isFinal, STATUS_LABEL, type Incident } from './incidents.js';
import { pageFromRow, statusPageUrl, type StatusPageRow } from './model.js';
import { statusPageSettings } from './settings.js';

export const STATUS_FEATURE = 'status.v1';
export const incidentRef = (incidentId: number): string => 'status-inc:' + incidentId;
export const alertRef = (monitorId: number | null): string => (monitorId === null ? 'status-alert:sys' : 'status-alert:m' + monitorId);
// Statusmeldungen, die der Bot nach 2 Stunden noch nicht abgeholt hat, sind überholt
export const ALERT_MAX_AGE = 7200;

const SNOWFLAKE = /^\d{15,25}$/;
const now = (): number => Math.floor(Date.now() / 1000);

// Farben (Bot: discord-bot/src/embeds.js, dazu Blau für Wartungen)
export const COLORS = { green: 0x22c55e, red: 0xef4444, amber: 0xf59e0b, orange: 0xf97316, blue: 0x3b82f6, gray: 0x71717a, brand: 0x6366f1 } as const;

// ---------------------------------------------------------------- Kanäle des Bots

export interface BotChannels {
  installed: boolean; // bot_secret eingerichtet
  supported: boolean; // der letzte Bericht nennt status.v1
  ready: boolean | null; // gateway.ready aus dem Bericht (null = unbekannt)
  reportedAt: number | null;
  version: string;
  statusChannel: string; // #status für Beiträge zu Vorfällen ('' = aus)
  alertsChannel: string; // #alerts für Meldungen ans Team ('' = aus)
  saved: boolean; // vom Admin gewählt (sonst die Vorschläge aus dem Bericht)
  report: BotReport | null;
}

// Ein Kanal des Berichts, in dem der Bot posten darf – Text- oder Ankündigungskanal (ein Forum hätte je Meldung einen
// eigenen Beitrag)
export function postableChannel(rep: BotReport | null, id: string): boolean {
  return !!rep && id !== '' && rep.channels.some((c) => c.id === id && c.can_post && c.type !== 'forum');
}

// Welche Kanäle gelten: gewählte (saved) oder die Vorschläge des Bots – nur, solange der Bot dort posten darf
export async function botChannels(db: Db, settingsRaw: string | null): Promise<BotChannels> {
  const installed = botSecret() !== '';
  const rep = installed ? await report(db) : null;
  const s = statusPageSettings({ is_system: 1, settings: settingsRaw });
  const bot = s.bot ?? { status_channel_id: '', alerts_channel_id: '', saved: false };
  const pick = (stored: string, suggested: string | undefined): string => {
    const id = bot.saved ? stored : stored || suggested || '';
    return postableChannel(rep, id) ? id : '';
  };
  return {
    installed,
    supported: !!rep && rep.features.includes(STATUS_FEATURE),
    ready: rep?.gateway ? rep.gateway.ready : null,
    reportedAt: rep ? Number(rep.reported_at) || null : null,
    version: rep ? String(rep.version) : '',
    statusChannel: pick(bot.status_channel_id, rep?.status_channel_id),
    alertsChannel: pick(bot.alerts_channel_id, rep?.alerts_channel_id),
    saved: bot.saved,
    report: rep,
  };
}

// ---------------------------------------------------------------- Inhalt (Embed) eines Vorfalls

function impactColor(inc: Incident): number {
  if (isFinal(inc.status)) return COLORS.green;
  if (inc.kind === 'maintenance') return COLORS.blue;
  return inc.impact === 'critical' ? COLORS.red : inc.impact === 'major' ? COLORS.orange : inc.impact === 'minor' ? COLORS.amber : COLORS.gray;
}

const clip = (text: string, max: number): string => (text.length > max ? text.slice(0, max - 1) + '…' : text);

export function incidentEmbed(page: StatusPageRow, inc: Incident): Record<string, unknown> {
  const last = inc.updates[inc.updates.length - 1];
  const affected = inc.monitors.filter((m) => m.isPublic).map((m) => m.name);
  const embed: Record<string, unknown> = {
    title: clip(`${STATUS_LABEL[inc.status] ?? inc.status} · ${inc.title}`, 256),
    description: last ? clip(mdPlain(last.body, 1500), 1500) : '',
    color: impactColor(inc),
    url: statusPageUrl(page.slug, incidentPath(inc.id)),
    fields: [
      { name: 'Affected', value: clip(affected.length ? affected.join(', ') : '—', 1024), inline: true },
      { name: 'Status', value: STATUS_LABEL[inc.status] ?? inc.status, inline: true },
    ],
    footer: { text: clip(`${page.title || page.slug} · OnYourSite`, 200) },
    timestamp: new Date((last ? last.createdAt : inc.startsAt) * 1000).toISOString(),
  };
  if (inc.kind === 'maintenance' && inc.endsAt !== null && !isFinal(inc.status)) {
    (embed.fields as unknown[]).push({ name: 'Window', value: `<t:${inc.startsAt}:f> – <t:${inc.endsAt}:t>`, inline: false });
  }
  return embed;
}

async function embedOf(db: Db, incidentId: number): Promise<Record<string, unknown> | null> {
  const inc = (await loadIncidents(db, 'id = ?', [incidentId]))[0];
  if (!inc) return null;
  const row = await db.one('SELECT id, user_id, is_system, slug, title, description, theme, settings, is_published, is_blocked, blocked_reason, review_note, reviewed_at, rev, created_at FROM status_pages WHERE id = ?', [inc.pageId]);
  return row ? incidentEmbed(pageFromRow(row), inc) : null;
}

// ---------------------------------------------------------------- Zeilen und Aufträge

interface PostRow {
  id: number;
  incidentId: number;
  target: string;
  channelId: string | null;
  messageId: string | null;
  state: string;
  dirty: boolean;
}

function postFrom(r: Record<string, unknown>): PostRow {
  return {
    id: Number(r.id), incidentId: Number(r.incident_id), target: String(r.target), channelId: r.channel_id === null ? null : String(r.channel_id),
    messageId: r.message_id === null ? null : String(r.message_id), state: String(r.state), dirty: Number(r.dirty) === 1,
  };
}

async function lockPost(db: Db, id: number): Promise<PostRow | null> {
  const r = await db.one('SELECT * FROM status_incident_posts WHERE id = ? FOR UPDATE', [id]);
  return r ? postFrom(r) : null;
}

async function setPost(db: Db, id: number, fields: Record<string, string | number | null>): Promise<void> {
  const keys = Object.keys(fields);
  await db.exec(`UPDATE status_incident_posts SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    [...keys.map((k) => fields[k]), now(), id]);
}

const cut = (text: string): string => (text.length > 160 ? text.slice(0, 159) + '…' : text);

async function queuePost(db: Db, row: PostRow, incidentId: number): Promise<void> {
  await outboxAdd('status.post', { post_id: row.id, incident_id: incidentId, channel_id: row.channelId }, { ref: incidentRef(incidentId), db });
}

async function queueEdit(db: Db, row: PostRow): Promise<void> {
  if (row.messageId === null || row.channelId === null) return;
  const ref = incidentRef(row.incidentId);
  await supersede(ref, 'status.edit', db);
  await outboxAdd('status.edit', { post_id: row.id, incident_id: row.incidentId, channel_id: row.channelId, message_id: row.messageId }, { ref, db });
}

// Ein Vorfall wurde angelegt oder geändert (Transaktion des Aufrufers, Seite und Vorfall gesperrt):
// - bestehende Beiträge: noch ausstehend → dirty, gepostet → bearbeiten, gescheitert ohne Nachricht → mit post neu;
// - post: noch kein Beitrag im Kanal #status → einen anlegen (nur OnYourSites Seite, nur mit Bot status.v1).
export async function syncIncidentPosts(db: Db, page: StatusPageRow, incidentId: number, opts: { post?: boolean } = {}): Promise<void> {
  const rows = (await db.q('SELECT * FROM status_incident_posts WHERE incident_id = ? ORDER BY id FOR UPDATE', [incidentId])).map(postFrom);
  for (const row of rows) {
    if (row.state === 'queued') {
      if (!row.dirty) await setPost(db, row.id, { dirty: 1 });
    } else if (row.state === 'posted') {
      await queueEdit(db, row);
    } else if (row.state === 'failed' && row.messageId === null && opts.post) {
      await setPost(db, row.id, { state: 'queued', dirty: 0, error: null });
      await queuePost(db, row, incidentId);
    }
  }
  if (!opts.post || !page.isSystem) return;
  const ch = await botChannels(db, page.settings);
  if (!ch.supported || ch.statusChannel === '') return;
  const target = 'bot:' + ch.statusChannel;
  if (rows.some((r) => r.target === target)) return;
  const res = await db.exec("INSERT IGNORE INTO status_incident_posts (incident_id, target, channel_id, state, dirty, updated_at) VALUES (?, ?, ?, 'queued', 0, ?)",
    [incidentId, target, ch.statusChannel, now()]);
  if (!res.affectedRows) return;
  await queuePost(db, { id: res.insertId, incidentId, target, channelId: ch.statusChannel, messageId: null, state: 'queued', dirty: false }, incidentId);
}

// Ein Vorfall wird gelöscht (vor dem Löschen der Zeilen des Vorfalls, gleiche Transaktion): gepostete Nachrichten
// löscht der Bot; ein Beitrag, den der Bot noch nicht abgeholt hat, entfällt; einen schon abgeholten löscht das
// Ergebnis (removing).
export async function removeIncidentPosts(db: Db, incidentId: number): Promise<void> {
  const ref = incidentRef(incidentId);
  const rows = (await db.q('SELECT * FROM status_incident_posts WHERE incident_id = ? ORDER BY id FOR UPDATE', [incidentId])).map(postFrom);
  // Offene Bearbeitungen braucht niemand mehr (eine schon abgeholte läuft zu Ende und ändert nichts)
  await db.exec("UPDATE community_outbox SET done_at = NOW(), last_error = 'cancelled' WHERE ref = ? AND action = 'status.edit' AND done_at IS NULL AND claimed_at IS NULL", [ref]);
  for (const row of rows) {
    if (row.state === 'posted' && row.messageId !== null) {
      await setPost(db, row.id, { state: 'removing', dirty: 0 });
      await outboxAdd('status.delete', { post_id: row.id, incident_id: incidentId, channel_id: row.channelId, message_id: row.messageId }, { ref, db });
      continue;
    }
    if (row.state === 'queued') {
      const jobs = await db.q("SELECT id, claimed_at FROM community_outbox WHERE ref = ? AND action = 'status.post' AND done_at IS NULL FOR UPDATE", [ref]);
      if (jobs.some((j) => j.claimed_at !== null)) {
        await setPost(db, row.id, { state: 'removing', dirty: 0 });
        continue;
      }
      for (const j of jobs) await closeJob(db, Number(j.id), 'cancelled');
    }
    await db.exec('DELETE FROM status_incident_posts WHERE id = ?', [row.id]);
  }
}

// ---------------------------------------------------------------- Regeln beim Ausgeben und Rückmeldungen des Bots

async function lockPostOf(db: Db, job: OutboxJob): Promise<void> {
  const id = Number(job.data?.post_id ?? 0);
  if (id > 0) await db.q('SELECT id FROM status_incident_posts WHERE id = ? FOR UPDATE', [id]);
}

// status.post: nur solange die Zeile aussteht; der Inhalt ist der aktuelle Stand. Hat der Bot den Auftrag schon einmal
// abgeholt (Rückmeldung verloren), sucht er zuerst nach seinem eigenen Beitrag (recheck).
async function preparePost(db: Db, job: OutboxJob): Promise<Prepared> {
  const row = await lockPost(db, Number(job.data?.post_id ?? 0));
  if (!row || (row.state !== 'queued' && row.state !== 'removing')) return { send: false, reason: 'skipped' };
  if (row.state === 'removing') {
    // Vorfall inzwischen gelöscht: nur einen schon geposteten Beitrag melden lassen (der wird dann gelöscht)
    if (job.claimed_at === null) {
      await db.exec('DELETE FROM status_incident_posts WHERE id = ?', [row.id]);
      return { send: false, reason: 'cancelled' };
    }
  }
  const embed = await embedOf(db, row.incidentId);
  if (!embed && row.state !== 'removing') return { send: false, reason: 'skipped' };
  const data: Record<string, unknown> = { channel_id: row.channelId, message: { embeds: embed ? [embed] : [] }, incident_url: embed ? String(embed.url) : '' };
  if (job.claimed_at !== null) data.recheck = true;
  if (row.state === 'removing') data.only_if_posted = true;
  return { send: true, data };
}

async function prepareEdit(db: Db, job: OutboxJob): Promise<Prepared> {
  const row = await lockPost(db, Number(job.data?.post_id ?? 0));
  if (!row || row.state !== 'posted' || row.messageId === null) return { send: false, reason: 'skipped' };
  const embed = await embedOf(db, row.incidentId);
  if (!embed) return { send: false, reason: 'skipped' };
  return { send: true, data: { channel_id: row.channelId, message_id: row.messageId, message: { embeds: [embed] } } };
}

// Ergebnis eines Auftrags (in der Transaktion von /done; die Zeile ist schon gesperrt)
async function applyPostResult(db: Db, job: OutboxJob, result: Record<string, unknown> | null, error: string, final: boolean): Promise<void> {
  const row = await lockPost(db, Number(job.data?.post_id ?? 0));
  if (!row) return;
  const messageId = typeof result?.message_id === 'string' && SNOWFLAKE.test(result.message_id) ? result.message_id : null;
  const channelId = typeof result?.channel_id === 'string' && SNOWFLAKE.test(result.channel_id) ? result.channel_id : row.channelId;
  if (error !== '') {
    if (!final) return;
    if (job.action === 'status.delete') {
      await setPost(db, row.id, { state: 'failed', error: cut('The Discord post couldn’t be removed: ' + error) });
    } else if (job.action === 'status.post') {
      await setPost(db, row.id, { state: 'failed', error: cut(error === 'expired' ? 'Not posted: the bot didn’t pick it up in time.' : error), dirty: 0 });
    } else {
      await setPost(db, row.id, { error: cut(error) });
    }
    return;
  }
  if (job.action === 'status.post') {
    if (result?.found === false) {
      // Nachfrage ohne Treffer: der Beitrag ist nie entstanden
      if (row.state === 'removing') await db.exec('DELETE FROM status_incident_posts WHERE id = ?', [row.id]);
      else await setPost(db, row.id, { state: 'failed', error: 'The bot didn’t post it.', dirty: 0 });
      return;
    }
    if (messageId === null) {
      await setPost(db, row.id, { state: 'failed', error: 'The bot didn’t report which message it posted.', dirty: 0 });
      return;
    }
    if (row.state === 'removing') {
      await setPost(db, row.id, { message_id: messageId, channel_id: channelId });
      await outboxAdd('status.delete', { post_id: row.id, incident_id: row.incidentId, channel_id: channelId, message_id: messageId }, { ref: incidentRef(row.incidentId), db });
      return;
    }
    await setPost(db, row.id, { state: 'posted', message_id: messageId, channel_id: channelId, error: null, dirty: 0 });
    if (row.dirty) await queueEdit(db, { ...row, state: 'posted', messageId, channelId });
    return;
  }
  if (result?.missing === true) {
    // In Discord gelöscht: nicht neu posten
    if (job.action === 'status.delete') await db.exec('DELETE FROM status_incident_posts WHERE id = ?', [row.id]);
    else await setPost(db, row.id, { state: 'failed', error: 'The message was deleted in Discord.' });
    return;
  }
  if (job.action === 'status.delete') await db.exec('DELETE FROM status_incident_posts WHERE id = ?', [row.id]);
  else await setPost(db, row.id, { error: null });
}

registerBotAction('status.alert', { feature: STATUS_FEATURE, maxAgeSec: ALERT_MAX_AGE });
registerBotAction('status.post', { feature: STATUS_FEATURE, onResult: applyPostResult, lock: lockPostOf, prepare: preparePost });
registerBotAction('status.edit', { feature: STATUS_FEATURE, onResult: applyPostResult, lock: lockPostOf, prepare: prepareEdit });
registerBotAction('status.delete', { feature: STATUS_FEATURE, onResult: applyPostResult, lock: lockPostOf });
