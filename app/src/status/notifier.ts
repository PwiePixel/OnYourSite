// Statusseiten: der Kern des Benachrichtigungsdienstes (ohne Einstieg und Sperre – die macht notify.ts). Er stellt zu,
// was in status_outbox wartet: E-Mails (an die Admins bzw. den Besitzer, Vorlagen status_alert / status_owner_alert),
// die Glocke (notify()/notifyAdmins() in derselben Transaktion, die die Zeile als gesendet markiert – das macht sie
// „genau einmal“) und Aufträge an den eigenen Bot (status.alert für #alerts, nur wenn sein Bericht status.v1 nennt).
// Regeln (Entwurf §4.8.11/§4.8.12):
// - alle 2 s die fälligen Zeilen (Index idx_due); OnYourSites eigene Alarme (Klasse system) zuerst;
// - Wiederholung nach 30 s, 2 min und 10 min, danach failed; älter als 30 Minuten (z. B. nach einem Neustart) → skipped;
// - das Mail-Budget (budget.ts) mit den Klassen system, confirm, owner (und broadcast ab ST-6);
// - Seiten von Nutzern: höchstens 30 Alarme je Stunde über alle Wege, E-Mails an den Besitzer höchstens
//   owner_mails_hour je Stunde und owner_mails_day je Tag – danach je einmal eine Nachricht, dass Alarme ruhen;
// - alle 30 s der Gesundheitseintrag oys_meta.status_notify (Zähler je Klasse, wartende Zeilen, Fehler des Mail-Servers).
// Er verbindet sich nie mit Adressen von Nutzern: nur mit dem Mail-Server und (über den Bot) mit Discord.
import { transaction, withConnection, type Db } from '../db.js';
import { baseHost, mainUrl, validateEmail } from '../helpers.js';
import { e } from '../html.js';
import { date } from '../php.js';
import { sendCustomEmail } from '../mail.js';
import { notify, notifyAdmins } from '../notify/notify.js';
import { outboxAdd } from '../community/community.js';
import { alertEmbed, alertMessage, bellType, type AlertPayload, type MailClass } from './alerts.js';
import { MailBudget, emptyUsed, type BudgetLimits, type Used } from './budget.js';
import { editorLink } from './links.js';
import { metaJson, statusPageUrl } from './model.js';
import { alertRef, botChannels, incidentContent, queueChannelPost } from './posts.js';
import { BROKEN_AFTER, channelTarget, mintVerifyToken } from './channels.js';
import { discordError, parseWebhookLink, webhookDelete, webhookEdit, webhookPost, type DiscordResponse } from '../discord/index.js';
import { statusSettings, type StatusSettings } from './settings.js';

export const NOTIFIER_VERSION = '1';
export const RETRY_AFTER = [30, 120, 600]; // Sekunden nach dem 1., 2. und 3. Fehlversuch; danach failed
export const STALE_AFTER = 1800; // ältere Zeilen werden nicht mehr zugestellt
export const PAGE_ALERTS_HOUR = 30; // Alarme je Seite und Stunde (Seiten von Nutzern)
export const PAGE_CONFIRM_DAY = 10; // Bestätigungsmails je Seite und Tag (X12)

export interface MailRequest {
  to: string;
  template: 'status_alert' | 'status_owner_alert' | 'status_verify' | 'status_channel_alert';
  subject: string;
  vars: Record<string, string>; // schon maskiert
}

export interface NotifierDeps {
  clock?: () => number; // ms
  sendMail?: (m: MailRequest) => Promise<boolean>;
  log?: (line: string) => void;
}

interface OutboxItem {
  id: number;
  pageId: number;
  monitorId: number | null;
  kind: string;
  cls: MailClass;
  channel: string;
  event: string;
  payload: Record<string, unknown>;
  attempts: number;
  createdAt: number;
}

type Periodic = 'deliver' | 'health' | 'settings';

function itemFrom(r: Record<string, unknown>): OutboxItem {
  let payload: Record<string, unknown> = {};
  try {
    const v = JSON.parse(String(r.payload ?? '{}')) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) payload = v as Record<string, unknown>;
  } catch {
    payload = {};
  }
  const cls = String(r.class);
  return {
    id: Number(r.id), pageId: Number(r.page_id), monitorId: r.monitor_id === null ? null : Number(r.monitor_id), kind: String(r.kind),
    cls: (cls === 'system' || cls === 'confirm' || cls === 'broadcast' ? cls : 'owner') as MailClass, channel: String(r.channel),
    event: String(r.event ?? ''), payload, attempts: Number(r.attempts ?? 0), createdAt: Number(r.created_at ?? 0),
  };
}

const limitsOf = (s: StatusSettings): BudgetLimits => ({
  mail_per_min: s.mail_per_min, mail_per_day: s.mail_per_day, confirm_share: s.confirm_share, owner_share: s.owner_share,
});

// Abkürzung der Zeitzone (CET, CEST …) für Zeiten in Mails
function zoneName(unix: number): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: process.env.TZ || undefined, timeZoneName: 'short' }).formatToParts(new Date(unix * 1000));
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

// Standard: die Vorlage aus email/ über den Mail-Server aus email/smtp.json, 15 s Zeit
async function defaultSend(m: MailRequest): Promise<boolean> {
  return sendCustomEmail(m.to, m.template, m.vars, m.subject, null, { timeoutMs: 15_000 });
}

// Ergebnis eines Versands, das noch geschrieben werden muss
// post: Stand eines Vorfall-Beitrags (Webhook), in derselben Transaktion wie das Ergebnis geschrieben
interface PostUpdate { id: number; state: 'posted' | 'failed'; messageId: string | null; error: string | null }
type Outcome = { state: 'sent'; payload?: Record<string, unknown>; post?: PostUpdate } | { state: 'retry'; error: string; payload: Record<string, unknown>; post?: PostUpdate }
  | { state: 'failed'; error: string; post?: PostUpdate };

export class Notifier {
  budget: MailBudget;
  settings!: StatusSettings;
  private readonly clock: () => number;
  private readonly send: (m: MailRequest) => Promise<boolean>;
  private readonly log: (line: string) => void;
  private readonly last = new Map<Periodic, number>();
  private readonly busy = new Set<Periodic>();
  // Zugestellt, aber das Ergebnis ließ sich nicht schreiben (Datenbank kurz weg): der nächste Durchgang trägt nur das
  // Ergebnis nach – sonst ginge dieselbe E-Mail noch einmal hinaus
  private readonly unsaved = new Map<number, Outcome>();
  private readonly bg = new Set<Promise<void>>();
  private started = 0;
  private stopping = false;
  smtpFail = 0; // Fehlschläge des Mail-Servers in Folge (Prüfung „mail“ von OnYourSites Seite)
  sentTotal = 0;

  constructor(deps: NotifierDeps = {}) {
    this.clock = deps.clock ?? Date.now;
    this.send = deps.sendMail ?? defaultSend;
    this.log = deps.log ?? ((line) => console.log(line));
    this.budget = new MailBudget({ mail_per_min: 30, mail_per_day: 1000, confirm_share: 10, owner_share: 30 }, this.today());
  }

  private nowS(): number {
    return Math.floor(this.clock() / 1000);
  }

  private today(): string {
    return date('Y-m-d', this.nowS());
  }

  async start(): Promise<void> {
    this.started = this.nowS();
    this.settings = await statusSettings();
    // Zähler des Tages übernehmen (Neustart am selben Tag)
    const prev = await withConnection((db) => metaJson(db, 'status_notify'));
    const used: Partial<Used> = {};
    if (prev && prev.day === this.today() && prev.mail_today && typeof prev.mail_today === 'object') {
      const m = prev.mail_today as Record<string, unknown>;
      for (const k of Object.keys(emptyUsed()) as MailClass[]) if (typeof m[k] === 'number') used[k] = m[k] as number;
    }
    if (prev && typeof prev.smtp_fail === 'number') this.smtpFail = prev.smtp_fail;
    this.budget = new MailBudget(limitsOf(this.settings), this.today(), used, this.clock());
  }

  // ---------------------------------------------------------------- Takt

  private due(task: Periodic, everyMs: number): boolean {
    const now = this.clock();
    if (this.busy.has(task)) return false;
    if (now - (this.last.get(task) ?? 0) < everyMs) return false;
    this.last.set(task, now);
    return true;
  }

  tick(): void {
    const run = (task: Periodic, everyMs: number, fn: () => Promise<unknown>): void => {
      if (this.stopping || !this.due(task, everyMs)) return;
      this.busy.add(task);
      const p = fn()
        .then(() => undefined, (err) => this.log(`Status notifier (${task}): ${(err as Error).message}`))
        .finally(() => {
          this.busy.delete(task);
          this.bg.delete(p);
        });
      this.bg.add(p);
    };
    run('settings', 60_000, async () => {
      this.settings = await statusSettings();
      this.budget.setLimits(limitsOf(this.settings));
    });
    run('deliver', 2_000, () => this.deliverDue());
    run('health', 30_000, () => this.writeHealth());
  }

  makeDue(task: Periodic): void {
    this.last.delete(task);
  }

  async settle(): Promise<void> {
    while (this.bg.size) await Promise.all([...this.bg]);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.settle();
    await this.writeHealth().catch(() => undefined);
  }

  // ---------------------------------------------------------------- Zustellen

  async deliverDue(): Promise<number> {
    const now = this.nowS();
    this.budget.rollDay(this.today());
    const rows = await withConnection((db) => db.q(`SELECT id, page_id, monitor_id, kind, class, channel, event, payload, attempts, created_at FROM status_outbox
        WHERE state = 'pending' AND next_at <= ? ORDER BY class = 'system' DESC, id LIMIT 200`, [now]));
    let handled = 0;
    for (const r of rows) {
      if (this.stopping) break;
      const item = itemFrom(r);
      try {
        const open = this.unsaved.get(item.id);
        if (open) {
          await this.record(item, open);
          handled++;
          continue;
        }
        if (now - item.createdAt > STALE_AFTER) {
          await this.finish(item, 'skipped', 'Not sent: it was more than 30 minutes old.');
        } else if (item.channel === 'bell') {
          await this.deliverBell(item);
        } else if (item.channel === 'admins') {
          await this.deliverAdmins(item);
        } else if (item.channel === 'owner') {
          await this.deliverOwner(item);
        } else if (item.channel === 'bot') {
          await this.deliverBot(item);
        } else if (item.channel.startsWith('channel:')) {
          await this.deliverChannel(item);
        } else {
          await this.finish(item, 'skipped', 'This kind of channel isn’t available.');
        }
        handled++;
      } catch (err) {
        this.log(`Status notifier: message #${item.id} failed – ${(err as Error).message}`);
        // Schon zugestellt: kein neuer Versuch ohne das Ergebnis (sent_to)
        if (!this.unsaved.has(item.id)) await this.retry(item, 'Sending failed.').catch(() => undefined);
      }
    }
    return handled;
  }

  private async finish(item: OutboxItem, state: 'sent' | 'skipped' | 'failed', error: string | null, payload?: Record<string, unknown>): Promise<void> {
    const now = this.nowS();
    const sets = ['state = ?', 'error = ?', 'attempts = attempts + 1'];
    const params: Array<string | number | null> = [state, error === null ? null : error.slice(0, 160)];
    if (state === 'sent') {
      sets.push('sent_at = ?');
      params.push(now);
    }
    if (payload) {
      sets.push('payload = ?');
      params.push(JSON.stringify(payload));
    }
    await withConnection((db) => db.exec(`UPDATE status_outbox SET ${sets.join(', ')} WHERE id = ? AND state = 'pending'`, [...params, item.id]));
  }

  // Ergebnis nach einem Versand schreiben; scheitert das, bleibt es im Speicher (unsaved) für den nächsten Durchgang
  private async record(item: OutboxItem, outcome: Outcome): Promise<void> {
    try {
      await transaction(async (_conn, db) => {
        const post = outcome.post;
        if (post) {
          await db.exec('UPDATE status_incident_posts SET state = ?, message_id = COALESCE(message_id, ?), error = ?, updated_at = ? WHERE id = ?',
            [post.state, post.messageId, post.error === null ? null : post.error.slice(0, 160), this.nowS(), post.id]);
        }
        if (outcome.state === 'sent') await this.finish(item, 'sent', null, outcome.payload);
        else if (outcome.state === 'failed') await this.finish(item, 'failed', outcome.error);
        else await this.retry(item, outcome.error, outcome.payload);
      });
      this.unsaved.delete(item.id);
    } catch (err) {
      this.unsaved.set(item.id, outcome);
      throw err;
    }
  }

  // Fehlversuch: später noch einmal (30 s, 2 min, 10 min), dann failed
  private async retry(item: OutboxItem, error: string, payload?: Record<string, unknown>): Promise<void> {
    const attempts = item.attempts + 1;
    if (attempts > RETRY_AFTER.length) {
      await this.finish(item, 'failed', error, payload);
      return;
    }
    const next = this.nowS() + RETRY_AFTER[attempts - 1];
    await withConnection((db) => db.exec(`UPDATE status_outbox SET attempts = ?, next_at = ?, error = ?${payload ? ', payload = ?' : ''} WHERE id = ? AND state = 'pending'`,
      payload ? [attempts, next, error.slice(0, 160), JSON.stringify(payload), item.id] : [attempts, next, error.slice(0, 160), item.id]));
  }

  // Budget der Minute voll: ohne Fehlversuch später
  private async later(item: OutboxItem, ms: number): Promise<void> {
    await withConnection((db) => db.exec("UPDATE status_outbox SET next_at = ? WHERE id = ? AND state = 'pending'", [this.nowS() + Math.max(1, Math.ceil(ms / 1000)), item.id]));
  }

  // Glocke: in derselben Transaktion wie „sent“ – genau einmal
  private async deliverBell(item: OutboxItem): Promise<void> {
    const p = item.payload as unknown as AlertPayload;
    const m = alertMessage(p);
    const now = this.nowS();
    await transaction(async (_conn, db) => {
      const res = await db.exec("UPDATE status_outbox SET state = 'sent', sent_at = ?, attempts = attempts + 1, error = NULL WHERE id = ? AND state = 'pending'", [now, item.id]);
      if (!res.affectedRows) return;
      if (p.page?.system) await notifyAdmins('status', m.title, m.text, p.event.startsWith('gate') ? '/admin#status' : editorLink(true), { db });
      else if (typeof p.page?.owner === 'number') await notify(p.page.owner, bellType(p), m.title, m.text, editorLink(false), { db });
    });
  }

  private mailVars(p: AlertPayload, owner: boolean): { subject: string; vars: Record<string, string> } {
    const m = alertMessage(p);
    let text = m.text;
    const since = p.event === 'down' ? (p.since ?? p.at) : null;
    if (since !== null) text += ` Since ${date('M j, H:i', since)}${zoneName(since) ? ' ' + zoneName(since) : ''}.`;
    if (p.monitor.target && (owner || p.page.system)) text += ` Check: ${p.monitor.target}`;
    const vars: Record<string, string> = {
      title: e(m.title),
      text: e(text),
      button_url: e(owner ? mainUrl(editorLink(false)) : mainUrl(editorLink(true))),
      button: owner ? 'Manage alerts' : 'Open OnYourSite status',
      domain: e(baseHost()),
      page: e(statusPageUrl(p.page.slug).replace(/^https?:\/\//, '').replace(/\/$/, '')),
    };
    return { subject: m.subject, vars };
  }

  // E-Mail an alle Admins (OnYourSites Seite, Klasse system). Wer sie schon hat, steht in payload.sent_to.
  private async deliverAdmins(item: OutboxItem): Promise<void> {
    const p = item.payload as unknown as AlertPayload;
    const admins = await withConnection((db) => db.q('SELECT id, email FROM users WHERE is_admin = 1 ORDER BY id'));
    const sentTo = new Set<number>(Array.isArray(item.payload.sent_to) ? (item.payload.sent_to as unknown[]).filter((x): x is number => typeof x === 'number') : []);
    const { subject, vars } = this.mailVars(p, false);
    let failed = false;
    for (const a of admins) {
      const id = Number(a.id);
      if (sentTo.has(id)) continue;
      const to = String(a.email ?? '');
      if (!validateEmail(to)) {
        sentTo.add(id);
        continue;
      }
      this.budget.take('system', this.clock());
      const ok = await this.send({ to, template: 'status_alert', subject, vars });
      if (ok) {
        sentTo.add(id);
        this.smtpFail = 0;
        this.sentTotal++;
      } else {
        this.budget.giveBack('system');
        this.smtpFail++;
        failed = true;
      }
    }
    const payload = { ...item.payload, sent_to: [...sentTo] };
    await this.record(item, failed ? { state: 'retry', error: 'The mail server didn’t take the email.', payload } : { state: 'sent', payload });
  }

  // Seiten von Nutzern: höchstens PAGE_ALERTS_HOUR Alarme je Stunde über alle Wege
  private async pageMuted(db: Db, pageId: number, now: number): Promise<boolean> {
    // Zusätzliche Kanäle zählen nicht mit (sonst wären die Mails an den Besitzer mit drei Kanälen schneller stumm)
    const n = Number(await db.value("SELECT COUNT(*) FROM status_outbox WHERE page_id = ? AND kind = 'alert' AND state = 'sent' AND sent_at >= ? AND channel NOT LIKE 'channel:%'", [pageId, now - 3600]));
    return n >= PAGE_ALERTS_HOUR;
  }

  // E-Mail an den Besitzer einer Seite (Klasse owner)
  private async deliverOwner(item: OutboxItem): Promise<void> {
    const p = item.payload as unknown as AlertPayload;
    const now = this.nowS();
    const owner = typeof p.page?.owner === 'number' ? p.page.owner : null;
    const check = await withConnection(async (db) => {
      const user = owner === null ? null : await db.one('SELECT email FROM users WHERE id = ?', [owner]);
      if (!user) return { skip: 'The account no longer exists.' };
      if (item.kind === 'alert' && (await this.pageMuted(db, item.pageId, now))) return { skip: 'Muted: too many alerts in the last hour.' };
      const hour = Number(await db.value("SELECT COUNT(*) FROM status_outbox WHERE page_id = ? AND channel = 'owner' AND state = 'sent' AND sent_at >= ?", [item.pageId, now - 3600]));
      const day = Number(await db.value("SELECT COUNT(*) FROM status_outbox WHERE page_id = ? AND channel = 'owner' AND state = 'sent' AND sent_at >= ?", [item.pageId, now - 86400]));
      if (item.kind === 'alert' && (hour >= this.settings.owner_mails_hour || day >= this.settings.owner_mails_day)) {
        return { skip: 'Muted: the email limit of this page is reached.', mute: true };
      }
      return { to: String(user.email ?? '') };
    });
    if ('skip' in check) {
      await this.finish(item, 'skipped', check.skip ?? 'Skipped.');
      if (check.mute) await this.muteNotice(item, now);
      return;
    }
    if (!validateEmail(check.to)) {
      await this.finish(item, 'skipped', 'The account has no valid email address.');
      return;
    }
    const taken = this.budget.take('owner', this.clock());
    if (taken === 'day') {
      await this.finish(item, 'skipped', 'The daily email budget for alerts is used up.');
      return;
    }
    if (taken === 'wait') {
      await this.later(item, this.budget.nextTokenIn(this.clock()));
      return;
    }
    const { subject, vars } = item.kind === 'muted'
      ? { subject: '[Status] Alerts are muted until tomorrow', vars: { ...this.mailVars(p, true).vars, title: 'Alerts are muted until tomorrow', text: e('Your status page sent the most alert emails it can send for now. You’ll get emails again tomorrow – the bell in the editor keeps working.') } }
      : item.kind === 'channel_broken'
        ? { subject: `Your Discord alerts for ${p.page.title} stopped working`, vars: { ...this.mailVars(p, true).vars, title: `Your Discord alerts for ${e(p.page.title)} stopped working`,
          text: e(`Discord rejected the webhook ${String(item.payload.label ?? '')} five times in a row, so we turned it off. Add the webhook again in the editor under Status → Alerts.`) } }
        : this.mailVars(p, true);
    const ok = await this.send({ to: check.to, template: 'status_owner_alert', subject, vars });
    if (ok) {
      this.smtpFail = 0;
      this.sentTotal++;
      await this.record(item, { state: 'sent' });
    } else {
      this.budget.giveBack('owner');
      this.smtpFail++;
      await this.retry(item, 'The mail server didn’t take the email.');
    }
  }

  // Einmal je Tag: „Alerts are muted until tomorrow“ an den Besitzer
  private async muteNotice(item: OutboxItem, now: number): Promise<void> {
    await withConnection(async (db) => {
      const already = await db.value("SELECT COUNT(*) FROM status_outbox WHERE page_id = ? AND kind = 'muted' AND created_at >= ?", [item.pageId, now - 86400]);
      if (Number(already) > 0) return;
      await db.exec(`INSERT INTO status_outbox (page_id, monitor_id, kind, class, channel, event, payload, state, attempts, next_at, created_at)
          VALUES (?, NULL, 'muted', 'owner', 'owner', '', ?, 'pending', 0, ?, ?)`, [item.pageId, JSON.stringify(item.payload), now, now]);
    });
  }

  // Auftrag für den eigenen Bot (#alerts) – in derselben Transaktion wie „sent“
  private async deliverBot(item: OutboxItem): Promise<void> {
    const p = item.payload as unknown as AlertPayload;
    const now = this.nowS();
    const skipped = await transaction(async (_conn, db) => {
      const row = await db.one("SELECT id FROM status_outbox WHERE id = ? AND state = 'pending' FOR UPDATE", [item.id]);
      if (!row) return null;
      const page = await db.one('SELECT settings FROM status_pages WHERE id = ?', [item.pageId]);
      const ch = await botChannels(db, page && page.settings !== null ? String(page.settings) : null);
      let reason: string | null = null;
      if (!ch.installed) reason = 'The Discord bot isn’t set up.';
      else if (!ch.supported) reason = 'The bot doesn’t support status messages yet – update it with discord-bot/install.sh --update.';
      else if (ch.alertsChannel === '') reason = ch.alertsNote || 'No channel for team alerts is chosen.';
      if (reason !== null) {
        await db.exec("UPDATE status_outbox SET state = 'skipped', error = ?, attempts = attempts + 1 WHERE id = ?", [reason, item.id]);
        return reason;
      }
      await outboxAdd('status.alert', { channel_id: ch.alertsChannel, message: { embeds: [alertEmbed(p, mainUrl(editorLink(true)))] } },
        { ref: alertRef(item.monitorId), db });
      await db.exec("UPDATE status_outbox SET state = 'sent', sent_at = ?, attempts = attempts + 1, error = NULL WHERE id = ?", [now, item.id]);
      return null;
    });
    if (skipped) this.log(`Status notifier: bot alert #${item.id} skipped – ${skipped}`);
  }

  // ---------------------------------------------------------------- Zusätzliche Kanäle (ST-5)

  // E-Mail-Adresse oder Discord-Webhook einer Seite: Alarme, Tests, Bestätigungsmails, Beiträge zu Vorfällen
  private async deliverChannel(item: OutboxItem): Promise<void> {
    const id = Number(item.channel.slice('channel:'.length));
    const row = await withConnection((db) => db.one('SELECT * FROM status_channels WHERE id = ? AND page_id = ?', [id, item.pageId]));
    if (!row) {
      await this.finish(item, 'skipped', 'The channel was removed.');
      return;
    }
    if (item.kind === 'channel_verify') return this.deliverVerify(item, row);
    if (item.kind === 'incident') return this.deliverIncidentPost(item, row);
    if (Number(row.is_enabled) !== 1) {
      await this.finish(item, 'skipped', 'The channel is off.');
      return;
    }
    if (row.verified_at === null) {
      await this.finish(item, 'skipped', 'The address isn’t confirmed yet.');
      return;
    }
    const p = item.payload as unknown as AlertPayload;
    const now = this.nowS();
    // Die Grenze gilt für Seiten von Nutzern (OnYourSites Seite meldet jeden Ausfall)
    if (item.kind === 'alert' && !p.page?.system && (await withConnection((db) => this.pageMuted(db, item.pageId, now)))) {
      await this.finish(item, 'skipped', 'Muted: too many alerts in the last hour.');
      return;
    }
    const target = channelTarget(row);
    if (String(row.type) === 'email') {
      const taken = this.budget.take('owner', this.clock());
      if (taken === 'day') { await this.finish(item, 'skipped', 'The daily email budget for alerts is used up.'); return; }
      if (taken === 'wait') { await this.later(item, this.budget.nextTokenIn(this.clock())); return; }
      const { subject, vars } = item.kind === 'test'
        ? { subject: `[Test] Status alerts for ${p.page.title}`, vars: { ...this.mailVars(p, false).vars, title: 'Test alert', text: e(`This is a test. Alerts for ${p.page.title} arrive at this address.`) } }
        : this.mailVars(p, false);
      // An eine fremde Adresse: immer mit der Adresse der Seite und dem Link zur Seite (nie zum Editor)
      vars.button_url = e(statusPageUrl(p.page.slug));
      vars.button = 'Open status page';
      const ok = await this.send({ to: target, template: 'status_channel_alert', subject, vars });
      if (ok) {
        this.smtpFail = 0;
        this.sentTotal++;
        // Erst das Ergebnis (sonst ginge die Mail bei einem kurzen Datenbankfehler noch einmal hinaus), dann der Kanal
        await this.record(item, { state: 'sent' });
        await this.touchChannel(id, now);
      } else {
        this.budget.giveBack('owner');
        this.smtpFail++;
        await this.retry(item, 'The mail server didn’t take the email.');
      }
      return;
    }
    const hook = parseWebhookLink(target);
    if (!hook) {
      await this.finish(item, 'failed', 'The webhook link is invalid.');
      return;
    }
    const body = item.kind === 'test'
      ? { content: 'Test alert for ' + p.page.title + ' – alerts arrive here.', allowed_mentions: { parse: [] } }
      : { embeds: [alertEmbed(p, statusPageUrl(p.page.slug))], allowed_mentions: { parse: [] } };
    const res = await webhookPost(hook, body, { threadId: hook.threadId });
    await this.afterDiscord(item, row, res, now);
  }

  // Kanal hat angenommen: Zeitpunkt und Fehlerzählung (danach, nur Bestmühe – das Ergebnis steht schon)
  private async touchChannel(id: number, now: number): Promise<void> {
    await withConnection((db) => db.exec('UPDATE status_channels SET last_sent_at = ?, fail_count = 0, last_error = NULL WHERE id = ?', [now, id])).catch(() => undefined);
  }

  // Ergebnis einer Discord-Anfrage: angenommen → gesendet; Webhook weg (401/404, 10015/10003) → zählen, nach 5 aus
  // (mit Mail an den Besitzer); alles andere → später noch einmal
  private async afterDiscord(item: OutboxItem, row: Record<string, unknown>, res: DiscordResponse, now: number, post?: (ok: boolean, error: string | null) => PostUpdate): Promise<boolean> {
    const id = Number(row.id);
    if (res.status >= 200 && res.status < 300) {
      await this.record(item, { state: 'sent', post: post ? post(true, null) : undefined });
      await this.touchChannel(id, now);
      return true;
    }
    const error = discordError(res, 'webhook').slice(0, 160);
    // Nur die Nachricht fehlt (in Discord gelöscht, 10008): der Beitrag ist erledigt, der Webhook zählt keinen Fehler
    if (res.code === 10008) {
      await this.record(item, { state: 'failed', error: 'The message was deleted in Discord.', post: post ? post(false, 'The message was deleted in Discord.') : undefined });
      return false;
    }
    const gone = res.status === 401 || res.status === 404 || res.code === 10015 || res.code === 10003;
    if (!gone) {
      await this.retry(item, error);
      return false;
    }
    await transaction(async (_conn, db) => {
      const cur = await db.one('SELECT fail_count, is_enabled, label FROM status_channels WHERE id = ? FOR UPDATE', [id]);
      if (!cur) return;
      const fails = Number(cur.fail_count) + 1;
      const off = fails >= BROKEN_AFTER && Number(cur.is_enabled) === 1;
      await db.exec('UPDATE status_channels SET fail_count = ?, last_error = ?, is_enabled = ? WHERE id = ?', [Math.min(255, fails), error, off ? 0 : Number(cur.is_enabled), id]);
      await db.exec("UPDATE status_outbox SET state = 'failed', error = ?, attempts = attempts + 1 WHERE id = ? AND state = 'pending'", [error, item.id]);
      if (post) {
        const u = post(false, error);
        await db.exec('UPDATE status_incident_posts SET state = ?, error = ?, updated_at = ? WHERE id = ?', [u.state, u.error, now, u.id]);
      }
      if (off) {
        // Einmal: Mail an den Besitzer (Klasse owner)
        const page = await db.one('SELECT id, user_id, is_system, slug, title FROM status_pages WHERE id = ?', [item.pageId]);
        if (page && page.user_id !== null) {
          const payload2 = { page: { id: Number(page.id), slug: String(page.slug), title: String(page.title), system: Number(page.is_system) === 1, owner: Number(page.user_id) },
            monitor: { id: 0, name: 'Discord', type: 'channel', target: '', public: false }, event: 'channel_broken', category: 'down', at: now, label: String(cur.label ?? '') };
          await db.exec(`INSERT INTO status_outbox (page_id, monitor_id, kind, class, channel, event, payload, state, attempts, next_at, created_at)
              VALUES (?, NULL, 'channel_broken', 'owner', 'owner', '', ?, 'pending', 0, ?, ?)`, [item.pageId, JSON.stringify(payload2), now, now]);
        }
      }
    });
    return false;
  }

  // Bestätigungsmail: der Link entsteht erst jetzt (nur sein Hash wird gespeichert); je Seite höchstens 10 am Tag
  private async deliverVerify(item: OutboxItem, row: Record<string, unknown>): Promise<void> {
    if (String(row.type) !== 'email' || row.verified_at !== null) {
      await this.finish(item, 'skipped', 'Already confirmed.');
      return;
    }
    const now = this.nowS();
    const today = Number(await withConnection((db) => db.value("SELECT COUNT(*) FROM status_outbox WHERE page_id = ? AND kind = 'channel_verify' AND state = 'sent' AND sent_at >= ?", [item.pageId, now - 86400])));
    if (today >= PAGE_CONFIRM_DAY) {
      await this.finish(item, 'skipped', 'This page sent the most confirmation emails it can send today.');
      return;
    }
    const taken = this.budget.take('confirm', this.clock());
    if (taken === 'day') { await this.finish(item, 'skipped', 'The daily email budget for confirmations is used up.'); return; }
    if (taken === 'wait') { await this.later(item, this.budget.nextTokenIn(this.clock())); return; }
    const page = await withConnection((db) => db.one('SELECT p.slug, p.title, u.full_name, u.email FROM status_pages p LEFT JOIN users u ON u.id = p.user_id WHERE p.id = ?', [item.pageId]));
    if (!page) {
      this.budget.giveBack('confirm');
      await this.finish(item, 'skipped', 'The page no longer exists.');
      return;
    }
    const { token, hash } = mintVerifyToken();
    await withConnection((db) => db.exec('UPDATE status_channels SET verify_hash = ?, verify_sent_at = ? WHERE id = ?', [hash, now, Number(row.id)]));
    const owner = String(page.full_name ?? '') || 'Someone';
    const address = statusPageUrl(String(page.slug)).replace(/^https?:\/\//, '').replace(/\/$/, '');
    const ok = await this.send({
      to: channelTarget(row), template: 'status_verify', subject: `Confirm alerts for ${String(page.title)}`,
      vars: { owner: e(owner), page: e(String(page.title)), address: e(address), button_url: e(mainUrl('/_/status/verify/' + token)), domain: e(baseHost()) },
    });
    if (ok) {
      this.smtpFail = 0;
      this.sentTotal++;
      await this.record(item, { state: 'sent' });
    } else {
      this.budget.giveBack('confirm');
      this.smtpFail++;
      await this.retry(item, 'The mail server didn’t take the email.');
    }
  }

  // Beitrag zu einem Vorfall in einem Webhook-Kanal: neu, bearbeiten oder löschen (immer mit dem aktuellen Stand).
  // Vor dem Lesen wird dirty gelöscht: ändert sich der Vorfall während des Sendens, setzt das dirty wieder, und danach
  // folgt ein weiteres Bearbeiten. Die Nachrichten-ID steht in derselben Transaktion wie das Ergebnis.
  private async deliverIncidentPost(item: OutboxItem, row: Record<string, unknown>): Promise<void> {
    const hook = parseWebhookLink(channelTarget(row));
    if (!hook || Number(row.is_enabled) !== 1) {
      await this.finish(item, 'skipped', 'The channel is off.');
      return;
    }
    const now = this.nowS();
    const op = String(item.payload.op ?? 'post');
    if (op === 'delete') {
      const res = await webhookDelete(hook, String(item.payload.message_id ?? ''), hook.threadId);
      if (res.status === 404) await this.finish(item, 'sent', null);
      else await this.afterDiscord(item, row, res, now);
      return;
    }
    const postId = Number(item.payload.post_id ?? 0);
    const found = await withConnection(async (db) => {
      const post = await db.one('SELECT * FROM status_incident_posts WHERE id = ?', [postId]);
      if (!post) return null;
      await db.exec('UPDATE status_incident_posts SET dirty = 0 WHERE id = ?', [postId]);
      const content = await incidentContent(db, Number(post.incident_id));
      return content ? { post, content } : null;
    });
    if (!found) {
      await this.finish(item, 'skipped', 'The incident was deleted.');
      return;
    }
    const body = { embeds: [found.content.embed], allowed_mentions: { parse: [] } };
    const messageId = found.post.message_id === null ? '' : String(found.post.message_id);
    const res = messageId !== '' ? await webhookEdit(hook, messageId, body, hook.threadId) : await webhookPost(hook, body, { threadId: hook.threadId });
    const newId = res.data && typeof res.data.id === 'string' ? res.data.id : null;
    const sent = await this.afterDiscord(item, row, res, now, (ok, error) => ({ id: postId, state: ok ? 'posted' : 'failed', messageId: ok ? newId : null, error }));
    // Während des Sendens geändert: noch einmal bearbeiten
    if (sent) {
      await withConnection(async (db) => {
        const again = await db.one('SELECT dirty FROM status_incident_posts WHERE id = ?', [postId]);
        if (again && Number(again.dirty) === 1) {
          await db.exec('UPDATE status_incident_posts SET dirty = 0 WHERE id = ?', [postId]);
          await queueChannelPost(db, item.pageId, Number(row.id), postId, Number(found.post.incident_id), 'edit');
        }
      }).catch((err) => this.log(`Status notifier: follow-up edit for post #${postId} – ${(err as Error).message}`));
    }
  }

  // ---------------------------------------------------------------- Gesundheitseintrag

  async writeHealth(): Promise<void> {
    const now = this.nowS();
    this.budget.rollDay(this.today());
    await withConnection(async (db) => {
      const pending = Number(await db.value("SELECT COUNT(*) FROM status_outbox WHERE state = 'pending'"));
      const record = {
        at: now, pid: process.pid, started: this.started, version: NOTIFIER_VERSION, day: this.budget.day,
        mail_today: { ...this.budget.used }, outbox: pending, smtp_fail: this.smtpFail,
      };
      await db.exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('status_notify', ?)", [JSON.stringify(record)]);
    });
  }
}
