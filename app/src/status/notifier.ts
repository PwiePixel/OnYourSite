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
import { alertRef, botChannels } from './posts.js';
import { statusSettings, type StatusSettings } from './settings.js';

export const NOTIFIER_VERSION = '1';
export const RETRY_AFTER = [30, 120, 600]; // Sekunden nach dem 1., 2. und 3. Fehlversuch; danach failed
export const STALE_AFTER = 1800; // ältere Zeilen werden nicht mehr zugestellt
export const PAGE_ALERTS_HOUR = 30; // Alarme je Seite und Stunde (Seiten von Nutzern)

export interface MailRequest {
  to: string;
  template: 'status_alert' | 'status_owner_alert';
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
type Outcome = { state: 'sent'; payload?: Record<string, unknown> } | { state: 'retry'; error: string; payload: Record<string, unknown> };

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
      if (outcome.state === 'sent') await this.finish(item, 'sent', null, outcome.payload);
      else await this.retry(item, outcome.error, outcome.payload);
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
    const n = Number(await db.value("SELECT COUNT(*) FROM status_outbox WHERE page_id = ? AND kind = 'alert' AND state = 'sent' AND sent_at >= ?", [pageId, now - 3600]));
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
