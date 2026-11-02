// Statusseiten: Alarme (Entwurf §4.8.11). Der Prüfdienst schreibt für jedes Ereignis einer Prüfung je Empfänger eine
// Zeile in status_outbox – in derselben Transaktion wie den Zustandswechsel (checker.ts flush). Zustellen tut nur der
// Benachrichtigungsdienst (notifier.ts). Empfänger:
// - OnYourSites eigene Seite: alle Admins per E-Mail (alerts.admins, Klasse system), die Glocke der Admins, der Kanal
//   #alerts des eigenen Bots (nur mit status.v1);
// - Seiten von Nutzern (ab ST-4): der Besitzer per E-Mail (alerts.owner, Klasse owner) und seine Glocke.
// Kommt ein „up“, solange das „down“ für dieselbe Prüfung und denselben Empfänger noch wartet, wird beides eine
// Nachricht („… was down for 40 s“, die Zeile von „down“ wird merged). Die Nutzdaten enthalten nie Geheimnisse.
import type { Db } from '../db.js';
import { errorText } from './errors.js';
import { duration } from './incidents.js';
import type { AlertEvent, PageSettings } from './settings.js';
import { JOB_HEARTBEATS } from './system.js';

export type AlertChannel = 'admins' | 'owner' | 'bell' | 'bot';
export type MailClass = 'system' | 'confirm' | 'owner' | 'broadcast';

export interface AlertPayload {
  page: { id: number; slug: string; title: string; system: boolean; owner: number | null };
  monitor: { id: number; name: string; type: string; target: string; public: boolean };
  event: string; // down|up|degraded|recovered|flapping|stable|cert
  category: AlertEvent;
  at: number;
  since?: number | null;
  error?: string | null;
  code?: number | null;
  down_for?: number;
  cert_days?: number;
  timeout?: number;
  checks?: number; // Fehlschläge in Folge bis „down“ (1 + Wiederholungen)
  merged?: boolean; // „up“ hat ein wartendes „down“ ersetzt
  canaries?: { ok: number; of: number }; // Plattform-Sperre (gate_frozen)
}

export interface AlertSource {
  page: { id: number; userId: number | null; isSystem: boolean; slug: string; title: string };
  monitor: { id: number; name: string; type: string; target: string; isPublic: boolean; timeout?: number; retries?: number };
  event: { kind: string; at: number; error: string | null; code: number | null; muted: boolean; downFor?: number; certDays?: number; since?: number };
}

export interface OutboxRow {
  pageId: number;
  monitorId: number | null; // null: Meldung über den Dienst selbst (Plattform-Sperre)
  channel: AlertChannel;
  cls: MailClass;
  event: string;
  payload: AlertPayload;
}

const isBeat = (type: string, target: string): boolean => type === 'heartbeat' || (type === 'system' && JOB_HEARTBEATS.has(target));

// Zu welcher Auswahl der Seite (alerts.events) ein Ereignis gehört; null = kein Alarm
export function alertCategory(type: string, target: string, kind: string): AlertEvent | null {
  if (kind === 'cert') return 'cert';
  if (kind === 'degraded' || kind === 'recovered') return 'degraded';
  if (kind === 'down' || kind === 'flapping') return isBeat(type, target) ? 'heartbeat' : 'down';
  if (kind === 'up' || kind === 'stable') return isBeat(type, target) ? 'heartbeat' : 'up';
  return null;
}

// Zeilen für ein Ereignis (rein; geschrieben werden sie mit writeAlertRows)
export function alertRows(src: AlertSource, settings: PageSettings): OutboxRow[] {
  const ev = src.event;
  if (ev.muted) return [];
  const category = alertCategory(src.monitor.type, src.monitor.target, ev.kind);
  if (category === null || !settings.alerts.events.includes(category)) return [];
  const payload: AlertPayload = {
    page: { id: src.page.id, slug: src.page.slug, title: src.page.title, system: src.page.isSystem, owner: src.page.userId },
    monitor: { id: src.monitor.id, name: src.monitor.name, type: src.monitor.type, target: src.monitor.type === 'http' ? src.monitor.target : '', public: src.monitor.isPublic },
    event: ev.kind,
    category,
    at: ev.at,
    since: ev.since ?? null,
    error: ev.error,
    code: ev.code,
  };
  if (ev.downFor !== undefined) payload.down_for = ev.downFor;
  if (ev.certDays !== undefined) payload.cert_days = ev.certDays;
  if (src.monitor.timeout !== undefined) payload.timeout = src.monitor.timeout;
  if (src.monitor.retries !== undefined) payload.checks = 1 + src.monitor.retries;
  const base = { pageId: src.page.id, monitorId: src.monitor.id, event: ev.kind, payload };
  if (src.page.isSystem) {
    const rows: OutboxRow[] = [];
    if (settings.alerts.admins) rows.push({ ...base, channel: 'admins', cls: 'system' });
    rows.push({ ...base, channel: 'bell', cls: 'system' });
    rows.push({ ...base, channel: 'bot', cls: 'system' });
    return rows;
  }
  if (src.page.userId === null) return [];
  const rows: OutboxRow[] = [];
  if (settings.alerts.owner) rows.push({ ...base, channel: 'owner', cls: 'owner' });
  rows.push({ ...base, channel: 'bell', cls: 'owner' });
  return rows;
}

// Plattform-Sperre (Entwurf §4.8.15): Prüfungen der Nutzer ruhen bzw. laufen wieder – an das Team (OnYourSites Seite)
export function gateAlertRows(page: AlertSource['page'], settings: PageSettings, event: 'gate_frozen' | 'gate_ok', at: number, canaries: { ok: number; of: number }): OutboxRow[] {
  const payload: AlertPayload = {
    page: { id: page.id, slug: page.slug, title: page.title, system: true, owner: null },
    monitor: { id: 0, name: 'User checks', type: 'gate', target: '', public: false },
    event, category: event === 'gate_frozen' ? 'down' : 'up', at, canaries,
  };
  const rows: OutboxRow[] = [];
  const base = { pageId: page.id, monitorId: null, event, payload };
  if (settings.alerts.admins) rows.push({ ...base, channel: 'admins', cls: 'system' });
  rows.push({ ...base, channel: 'bell', cls: 'system' });
  rows.push({ ...base, channel: 'bot', cls: 'system' });
  return rows;
}

// Zeilen schreiben (Transaktion des Prüfdienstes). „up“ fasst ein noch wartendes „down“ desselben Empfängers zusammen.
export async function writeAlertRows(db: Db, rows: OutboxRow[], now: number): Promise<number> {
  let written = 0;
  for (const r of rows) {
    const payload = { ...r.payload };
    if (r.event === 'up' && r.monitorId !== null) {
      const merged = await db.exec("UPDATE status_outbox SET state = 'merged' WHERE monitor_id = ? AND channel = ? AND kind = 'alert' AND event = 'down' AND state = 'pending'",
        [r.monitorId, r.channel]);
      if (merged.affectedRows > 0) payload.merged = true;
    }
    await db.exec(`INSERT INTO status_outbox (page_id, monitor_id, kind, class, channel, event, payload, state, attempts, next_at, created_at)
        VALUES (?, ?, 'alert', ?, ?, ?, ?, 'pending', 0, ?, ?)`, [r.pageId, r.monitorId, r.cls, r.channel, r.event.slice(0, 16), JSON.stringify(payload), now, now]);
    written++;
  }
  return written;
}

// ---------------------------------------------------------------- Texte (E-Mail, Glocke, Discord)

export type Tone = 'down' | 'up' | 'warn';

export interface AlertMessage {
  subject: string; // E-Mail
  title: string; // Überschrift (E-Mail, Glocke, Discord)
  text: string; // was passiert ist (unser Text, nie Inhalt der Gegenseite)
  tone: Tone;
}

const host = (target: string): string => {
  const m = /^https?:\/\/(\[[^\]]+\]|[^/:?#]+)/i.exec(target);
  return m ? m[1] : target;
};

export function alertMessage(p: AlertPayload): AlertMessage {
  const name = p.monitor.name || 'A component';
  const pageName = p.page.title || p.page.slug;
  const beat = p.category === 'heartbeat';
  switch (p.event) {
    case 'down': {
      if (beat) {
        const failed = p.error === 'hb_failed';
        return {
          subject: `[Heartbeat] ${name} ${failed ? 'reported a failure' : 'missed its ping'}`,
          title: failed ? `${name} reported a failure` : `${name} missed its ping`,
          text: failed ? 'The job reported a failure.' : 'No ping arrived in time.',
          tone: 'down',
        };
      }
      const reason = errorText(p.error ?? null, { timeout: p.timeout, code: p.code ?? null }) || 'It isn’t working.';
      const checks = p.checks && p.checks > 1 ? ` (${p.checks} checks in a row)` : '';
      return { subject: `[Down] ${name} – ${pageName}`, title: `${name} is down`, text: reason.replace(/\.$/, '') + checks + '.', tone: 'down' };
    }
    case 'up': {
      const lasted = p.down_for !== undefined ? duration(p.down_for) : '';
      if (p.merged) {
        return {
          subject: `[Back up] ${name}${lasted ? ` – down for ${lasted}` : ''}`,
          title: `${name} was down${lasted ? ` for ${lasted}` : ''}`,
          text: `${name} was down${lasted ? ` for ${lasted}` : ''} and is working again.`,
          tone: 'up',
        };
      }
      return {
        subject: `[Back up] ${name}${lasted ? ` – down for ${lasted}` : ''}`,
        title: beat ? `${name} pinged again` : `${name} is back up`,
        text: lasted ? `Down for ${lasted}.` : 'It’s working again.',
        tone: 'up',
      };
    }
    case 'degraded':
      return { subject: `[Slow] ${name} – ${pageName}`, title: `${name} is slow`, text: errorText(p.error && p.error !== 'degraded' ? p.error : 'degraded'), tone: 'warn' };
    case 'recovered':
      return { subject: `[Back to normal] ${name} – ${pageName}`, title: `${name} is fast again`, text: 'It answers as quickly as usual again.', tone: 'up' };
    case 'flapping':
      return {
        subject: `[Unstable] ${name} – ${pageName}`, title: `${name} keeps going up and down`,
        text: 'Alerts for it are muted until it’s stable again (30 minutes without a change).', tone: 'warn',
      };
    case 'stable':
      return { subject: `[Stable] ${name} – ${pageName}`, title: `${name} is stable again`, text: 'Alerts for it are on again.', tone: 'up' };
    case 'gate_frozen': {
      const c = p.canaries;
      return {
        subject: '[Down] User checks are paused', title: 'User checks are paused',
        text: `This server can’t reach the internet reliably${c ? ` (canaries ${c.ok}/${c.of})` : ''}. Nothing is counted as down meanwhile.`, tone: 'down',
      };
    }
    case 'gate_ok':
      return { subject: '[Back up] User checks are running again', title: 'User checks are running again', text: 'The platform gate is open again.', tone: 'up' };
    case 'cert': {
      const days = p.cert_days ?? 14;
      const h = host(p.monitor.target) || name;
      return {
        subject: `[Certificate] ${h} expires in ${days} days`, title: `The certificate of ${h} expires soon`,
        text: `It expires in ${days === 3 ? 'less than 3' : `less than ${days}`} days.`, tone: 'warn',
      };
    }
    default:
      return { subject: `[Status] ${name} – ${pageName}`, title: `${name} changed`, text: '', tone: 'warn' };
  }
}

// Typ der Glocke für Besitzer (Admins bekommen den Typ „status“)
export function bellType(p: AlertPayload): 'status_down' | 'status_up' {
  return p.event === 'down' || p.event === 'flapping' || p.event === 'degraded' ? 'status_down' : 'status_up';
}

const DISCORD_COLOR: Record<Tone, number> = { down: 0xef4444, up: 0x22c55e, warn: 0xf59e0b };

// Meldung für den Kanal #alerts des Bots (nur das Team sieht ihn: die Adresse der Prüfung darf hinein)
export function alertEmbed(p: AlertPayload, manageUrl: string): Record<string, unknown> {
  const m = alertMessage(p);
  const fields: Array<{ name: string; value: string; inline: boolean }> = [];
  const since = p.event === 'down' ? (p.since ?? p.at) : null;
  if (since !== null) fields.push({ name: 'Since', value: `<t:${since}:R>`, inline: true });
  if (p.monitor.target) fields.push({ name: 'Check', value: p.monitor.target.slice(0, 1000), inline: true });
  return {
    title: m.title.slice(0, 256),
    description: m.text.slice(0, 1500),
    color: DISCORD_COLOR[m.tone],
    url: manageUrl,
    fields,
    footer: { text: `${(p.page.title || p.page.slug).slice(0, 120)} · OnYourSite` },
    timestamp: new Date(p.at * 1000).toISOString(),
  };
}
