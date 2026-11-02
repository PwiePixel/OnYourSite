// Statusseiten: OnYourSites eigene Bestandteile (Entwurf §4.9). Jeder Schlüssel (status_monitors.target, Typ 'system')
// hat eine Prüfung; ein Teil, dessen Funktion es hier nicht gibt (kein Bot, kein Mail-Server, kein Tunnel, noch keine
// eigenen Domains, noch kein Job-Läufer), ist versteckt: er wird weder geprüft noch gezeigt. Spätere Funktionen
// melden ihre Prüfung mit registerSystemProbe() an (z. B. 'domains' und 'job:domains' der eigenen Domains).
// Die Heartbeats der Jobs (job:backup, job:weekly) setzt `status:ping` direkt in der Datenbank; sie laufen wie die
// Heartbeats der Nutzer über die Frist (period + grace).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_DIR } from '../config.js';
import type { HttpOutcome } from './http.js';

export interface ProbeResult {
  kind: 'ok' | 'fail' | 'unknown';
  slow?: boolean; // eingeschränkt („degraded“)
  error?: string | null;
  ms?: number | null;
  code?: number | null;
}

export interface SystemFacts {
  botSecret: boolean; // Bot eingerichtet (config.json bot_secret)
  smtp: boolean; // Mail-Server eingerichtet (email/smtp.json mit Host)
  tunnel: boolean; // config.json status.tunnel
}

export interface ProbeContext {
  now: number; // Unix-Sekunden
  facts: SystemFacts;
  baseUrl: string; // https://on-your.site
  healthUrl: string; // https://health.on-your.site/_/health
  http(url: string, keyword: string): Promise<HttpOutcome>;
  meta(key: string): Promise<string | null>; // oys_meta
  dbPing(): Promise<number | null>; // Millisekunden, null = nicht erreichbar
  memory: Map<string, number>; // Merkzettel je Prüfung (z. B. seit wann der Bot getrennt ist)
}

export type SystemProbe = (ctx: ProbeContext) => Promise<ProbeResult | null>; // null = versteckt

const registry = new Map<string, SystemProbe>();

export function registerSystemProbe(key: string, probe: SystemProbe): void {
  registry.set(key, probe);
}

export function systemProbe(key: string): SystemProbe | undefined {
  return registry.get(key);
}

// Heartbeats ohne Adresse (Frist aus der Einstellung des Bestandteils)
export const JOB_HEARTBEATS = new Set(['job:backup', 'job:weekly']);

export function smtpConfigured(dir = join(ROOT_DIR, 'email')): boolean {
  const file = join(dir, 'smtp.json');
  if (!existsSync(file)) return false;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as { host?: unknown };
    return typeof data.host === 'string' && data.host.trim() !== '';
  } catch {
    return false;
  }
}

function json(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);

// Webseite und Profilseiten: /_/health über das öffentliche Netz (derselbe Weg wie Besucher)
async function healthProbe(ctx: ProbeContext, url: string): Promise<ProbeResult> {
  const r = await ctx.http(url, '"ok":true');
  if (r.kind === 'ok') return { kind: 'ok', ms: r.ms, code: r.code, slow: r.slow };
  if (r.kind === 'internal' || r.kind === 'delayed' || r.kind === 'throttled') return { kind: 'unknown' };
  return { kind: 'fail', error: r.error, ms: r.ms, code: r.code };
}

// Messwert des Sensors (status_probe): älter als 3 Minuten = unbekannt, nicht gestört
async function sensorValue(ctx: ProbeContext, part: string): Promise<{ stale: boolean; value: Record<string, unknown> | null }> {
  const probe = json(await ctx.meta('status_probe'));
  const at = num(probe?.at);
  if (!probe || at === null || ctx.now - at > 180) return { stale: true, value: null };
  const v = probe[part];
  return { stale: false, value: v && typeof v === 'object' ? (v as Record<string, unknown>) : null };
}

registerSystemProbe('web', async (ctx) => healthProbe(ctx, ctx.baseUrl + '/_/health'));
registerSystemProbe('pages', async (ctx) => healthProbe(ctx, ctx.healthUrl));

// Discord-Bot: zuletzt gesehen (fragt die Seite ab), Alter des Berichts und gateway.ready aus dem Bericht
registerSystemProbe('bot', async (ctx) => {
  if (!ctx.facts.botSecret) return null;
  const seen = num(await ctx.meta('bot_last_seen'));
  if (seen === null || ctx.now - seen > 180) return { kind: 'fail', error: 'bot_offline' };
  const report = json(await ctx.meta('discord_bot_report'));
  const gateway = report?.gateway as { ready?: unknown } | undefined;
  if (gateway && gateway.ready === false) {
    const since = ctx.memory.get('bot:offline') ?? ctx.now;
    ctx.memory.set('bot:offline', since);
    if (ctx.now - since >= 120) return { kind: 'fail', error: 'bot_gateway' };
  } else {
    ctx.memory.delete('bot:offline');
  }
  const reported = num(report?.reported_at);
  if (report && (reported === null || ctx.now - reported > 25 * 60)) return { kind: 'ok', slow: true, error: 'bot_report' };
  return { kind: 'ok' };
});

// E-Mail: Prüfung des Sensors (alle 10 Minuten) und die letzten Zustellfehler des Benachrichtigungsdienstes
registerSystemProbe('mail', async (ctx) => {
  if (!ctx.facts.smtp) return null;
  const notifyState = json(await ctx.meta('status_notify'));
  if ((num(notifyState?.smtp_fail) ?? 0) >= 3) return { kind: 'fail', error: 'mail_failed' };
  const probe = json(await ctx.meta('status_probe'));
  const smtp = probe?.smtp as { ok?: unknown; at?: unknown } | undefined;
  const at = num(smtp?.at);
  if (!smtp || at === null || ctx.now - at > 30 * 60) return { kind: 'unknown' };
  return smtp.ok === true ? { kind: 'ok' } : { kind: 'fail', error: 'mail_login' };
});

// Datenbank: SELECT 1 – über 250 ms eingeschränkt
registerSystemProbe('db', async (ctx) => {
  const ms = await ctx.dbPing();
  if (ms === null) return { kind: 'fail', error: 'connect' };
  return { kind: 'ok', ms, slow: ms > 250 };
});

registerSystemProbe('tunnel', async (ctx) => {
  if (!ctx.facts.tunnel) return null;
  const { stale, value } = await sensorValue(ctx, 'tunnel');
  if (stale) return { kind: 'unknown' };
  return value?.ok === true ? { kind: 'ok', ms: num(value.ms) } : { kind: 'fail', error: 'down' };
});

registerSystemProbe('origin', async (ctx) => {
  const { stale, value } = await sensorValue(ctx, 'origin');
  if (stale) return { kind: 'unknown' };
  return value?.ok === true ? { kind: 'ok', ms: num(value.ms) } : { kind: 'fail', error: 'down' };
});

// Speicher: unter 15 % frei eingeschränkt, unter 10 % gestört
registerSystemProbe('disk', async (ctx) => {
  const { stale, value } = await sensorValue(ctx, 'disk');
  if (stale) return { kind: 'unknown' };
  const free = num(value?.free_pct);
  if (free === null) return { kind: 'unknown' };
  if (free < 10) return { kind: 'fail', error: 'disk_full' };
  return { kind: 'ok', slow: free < 15, error: free < 15 ? 'disk_low' : null };
});

// Gemeinsamer Job-Läufer (oys_meta 'jobs': je Job {at, ok, error, every}): versteckt, solange es ihn nicht gibt
registerSystemProbe('job:runner', async (ctx) => {
  const jobs = json(await ctx.meta('jobs'));
  if (!jobs) return null;
  let degraded = false;
  for (const value of Object.values(jobs)) {
    if (!value || typeof value !== 'object') continue;
    const job = value as { at?: unknown; ok?: unknown; every?: unknown };
    const at = num(job.at);
    const every = num(job.every) ?? 300;
    if (at === null || ctx.now - at > 3 * every) return { kind: 'fail', error: 'job_late' };
    if (job.ok === false) degraded = true;
  }
  return degraded ? { kind: 'ok', slow: true, error: 'job_failed' } : { kind: 'ok' };
});
