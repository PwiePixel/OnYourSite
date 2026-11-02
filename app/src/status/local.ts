// Einstieg des Sensors (onyoursite-status-local.timer jede Minute → onyoursite-status-local.service, einmalig):
// node app/dist/status/local.js. Prüft, was nur dieser Server sieht – Cloudflare-Tunnel (/ready auf 127.0.0.1:20241),
// die Webseite direkt (127.0.0.1:<node_port>/_/health), freien Speicher und alle 10 Minuten den Mail-Server – und
// schreibt das als oys_meta.status_probe. Er ist auch der Wächter, und er funktioniert ohne Datenbank:
// - solange die Datenbank erreichbar ist, hält er eine lokale Datei mit den Adressen der Admins aktuell
//   (StateDirectory, 0600 – der Webserver-Benutzer liest config.json mit Passwort und Schlüssel ohnehin);
// - läuft der Prüfdienst seit 3 Minuten nicht mehr: höchstens einmal je Stunde Glocke und E-Mail an alle Admins;
// - ist die Datenbank länger als 2 Minuten weg: er schreibt den Admins selbst (Adressen aus der Datei, SMTP aus
//   email/smtp.json), höchstens einmal je Stunde, und einmal „The database is back“.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import nodemailer from 'nodemailer';
import { ConfigMissingError, ROOT_DIR, configInt, loadConfig } from '../config.js';
import { closePool, timeZone, transaction, withConnection } from '../db.js';
import { baseHost, mainUrl } from '../helpers.js';
import { e } from '../html.js';
import { sendCustomEmail } from '../mail.js';
import { notifyAdmins } from '../notify/notify.js';
import { date } from '../php.js';
import { uploadsDir } from '../content/storage.js';
import { statusServerConfig } from './settings.js';
import { smtpConfigured } from './system.js';
import { outboxAdd } from '../community/community.js';
import { alertRef, botChannels } from './posts.js';

export interface SensorOptions {
  stateDir: string;
  now?: () => number; // ms
  tunnel?: boolean;
  tunnelUrl?: string;
  originUrl?: string;
  originHost?: string;
  diskPaths?: string[];
  smtp?: boolean; // Mail-Server eingerichtet?
  smtpVerify?: () => Promise<boolean>;
  sendMail?: (to: string, subject: string, title: string, text: string) => Promise<boolean>;
  log?: (line: string) => void;
}

export interface SensorReport {
  probe: Record<string, unknown>;
  db: boolean;
  alerts: string[]; // was verschickt wurde (für Tests und das Protokoll)
}

interface SensorState {
  smtp_at?: number;
  smtp_ok?: boolean;
  db_down_since?: number | null;
  db_alert_at?: number | null;
  db_alerted?: boolean;
}

const HOUR = 3600;

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

// Atomar und nur für den Besitzer lesbar
function writePrivate(file: string, data: unknown): void {
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

// GET auf eine lokale Adresse mit Zeitgrenze: Status und Inhalt (höchstens 4 KB)
function localGet(url: string, host: string | undefined, timeoutMs: number): Promise<{ status: number; body: string; ms: number } | null> {
  const started = Date.now();
  return new Promise((resolve) => {
    const req = http.get(url, { headers: host ? { Host: host } : {}, timeout: timeoutMs, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        if (size < 4096) chunks.push(c);
        size += c.length;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8').slice(0, 4096), ms: Date.now() - started }));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

function freePercent(paths: string[]): number | null {
  let min: number | null = null;
  for (const p of paths) {
    try {
      if (!existsSync(p)) continue;
      const s = statfsSync(p);
      if (!s.blocks) continue;
      const pct = Math.floor((s.bavail / s.blocks) * 100);
      min = min === null ? pct : Math.min(min, pct);
    } catch {
      // nicht lesbar: übergehen
    }
  }
  return min;
}

// SMTP prüfen wie der Versand (Port 465 = TLS sofort, sonst STARTTLS), 15 s
export async function smtpVerify(dir = join(ROOT_DIR, 'email')): Promise<boolean> {
  try {
    const cfg = JSON.parse(readFileSync(join(dir, 'smtp.json'), 'utf8')) as Record<string, unknown>;
    const port = Number(cfg.port) || 587;
    const transport = nodemailer.createTransport({
      host: String(cfg.host ?? ''), port, secure: port === 465, requireTLS: port !== 465,
      auth: { user: String(cfg.username ?? ''), pass: String(cfg.password ?? '') },
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 15_000,
    });
    await transport.verify();
    transport.close();
    return true;
  } catch {
    return false;
  }
}

// Alarm-Mail an einen Admin (Vorlage email/status_alert.json; alle Werte maskiert)
async function defaultSendMail(to: string, subject: string, title: string, text: string): Promise<boolean> {
  return sendCustomEmail(to, 'status_alert', {
    title: e(title), text: e(text), button_url: e(mainUrl('/admin#status')), button: 'Open Admin → Status', domain: e(baseHost()),
  }, subject, null, { timeoutMs: 15_000 });
}

export async function runSensor(o: SensorOptions): Promise<SensorReport> {
  const now = Math.floor((o.now ?? Date.now)() / 1000);
  const log = o.log ?? ((l: string) => console.log(l));
  const send = o.sendMail ?? defaultSendMail;
  mkdirSync(o.stateDir, { recursive: true, mode: 0o700 });
  const stateFile = join(o.stateDir, 'sensor.json');
  const contactsFile = join(o.stateDir, 'alert-contacts.json');
  const state = readJson<SensorState>(stateFile, {});
  const alerts: string[] = [];
  const domain = baseHost();

  // 1. Messen (ohne Datenbank)
  const probe: Record<string, unknown> = { at: now };
  if (o.tunnel) {
    const r = await localGet(o.tunnelUrl ?? 'http://127.0.0.1:20241/ready', undefined, 3000);
    probe.tunnel = { ok: r !== null && r.status === 200, ms: r ? r.ms : null };
  } else {
    probe.tunnel = null;
  }
  if (o.originUrl) {
    const r = await localGet(o.originUrl, o.originHost, 5000);
    probe.origin = { ok: r !== null && r.status === 200 && r.body.includes('"ok":true'), ms: r ? r.ms : null };
  }
  probe.disk = { free_pct: freePercent(o.diskPaths ?? []) };
  if (o.smtp) {
    if (state.smtp_at === undefined || now - state.smtp_at >= 600) {
      state.smtp_ok = await (o.smtpVerify ?? (() => smtpVerify()))();
      state.smtp_at = now;
    }
    probe.smtp = { ok: state.smtp_ok === true, at: state.smtp_at };
  }

  // 2. Datenbank: Messung speichern, Adressen der Admins merken, Wächter
  let dbOk = false;
  try {
    const admins = await withConnection(async (db) => {
      await db.exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('status_probe', ?)", [JSON.stringify(probe)]);
      return (await db.q('SELECT email FROM users WHERE is_admin = 1 ORDER BY id')).map((r) => String(r.email));
    });
    dbOk = true;
    writePrivate(contactsFile, { updated_at: now, domain, admins, webhook: null });
    await watchdog(now, admins, domain, send, alerts, log);
  } catch (err) {
    dbOk = false;
    log(`Status sensor: the database isn’t reachable (${(err as Error).message}).`);
  }

  // 3. Datenbank weg: selbst benachrichtigen (Adressen aus der Datei). Der neue Stand wird VOR dem Versand gespeichert:
  //    bricht systemd den Lauf ab (TimeoutStartSec, langsamer Mail-Server), geht dieselbe Meldung nicht jede Minute neu
  //    an alle, die sie schon bekommen haben.
  if (!dbOk) {
    state.db_down_since ??= now;
    if (now - state.db_down_since > 120 && (state.db_alert_at === null || state.db_alert_at === undefined || now - state.db_alert_at >= HOUR)) {
      state.db_alert_at = now;
      state.db_alerted = true;
      writePrivate(stateFile, state);
      const contacts = readJson<{ admins?: string[] }>(contactsFile, {});
      const since = date('H:i', state.db_down_since);
      const text = `The database on ${domain} isn’t reachable since ${since} – the website answers 503.`;
      for (const to of contacts.admins ?? []) {
        if (await send(to, `[Down] Database – ${domain}`, 'The database is down', text)) alerts.push('db-down:' + to);
      }
    }
  } else if (state.db_down_since !== null && state.db_down_since !== undefined) {
    const alerted = state.db_alerted === true;
    state.db_down_since = null;
    state.db_alert_at = null;
    state.db_alerted = false;
    writePrivate(stateFile, state);
    if (alerted) {
      const contacts = readJson<{ admins?: string[] }>(contactsFile, {});
      for (const to of contacts.admins ?? []) {
        if (await send(to, `[Back up] Database – ${domain}`, 'The database is back', `The database on ${domain} is back.`)) alerts.push('db-up:' + to);
      }
    }
  }
  writePrivate(stateFile, state);
  return { probe, db: dbOk, alerts };
}

// Prüfdienst (und, sobald es ihn gibt, Benachrichtigungsdienst) seit 3 Minuten still → Glocke und E-Mail an alle
// Admins, höchstens einmal je Stunde (status_watchdog_at in derselben Transaktion wie die Glocke)
async function watchdog(now: number, admins: string[], domain: string, send: NonNullable<SensorOptions['sendMail']>, alerts: string[],
  log: (l: string) => void): Promise<void> {
  const problems: Array<{ title: string; text: string }> = [];
  const read = async (key: string): Promise<number | null> => {
    const raw = await withConnection((db) => db.value('SELECT meta_value FROM oys_meta WHERE meta_key = ?', [key]));
    if (typeof raw !== 'string') return null;
    try {
      const at = (JSON.parse(raw) as { at?: unknown }).at;
      return typeof at === 'number' ? at : null;
    } catch {
      return null;
    }
  };
  const worker = await read('status_worker');
  if (worker !== null && now - worker > 180) {
    problems.push({ title: 'Status checks have stopped', text: `Status checks have stopped on ${domain}. Check: journalctl -u onyoursite-status` });
  }
  const notifier = await read('status_notify');
  if (notifier !== null && now - notifier > 180) {
    problems.push({ title: 'Status alerts have stopped', text: `Status alerts have stopped on ${domain}. Check: journalctl -u onyoursite-status-notify` });
  }
  if (!problems.length) return;
  const send1 = await transaction(async (_conn, db) => {
    const last = await db.value("SELECT meta_value FROM oys_meta WHERE meta_key = 'status_watchdog_at' FOR UPDATE");
    if (last !== null && last !== undefined && now - Number(last) < HOUR) return false;
    await db.exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('status_watchdog_at', ?)", [String(now)]);
    for (const p of problems) await notifyAdmins('status', p.title, p.text, '/admin#status', { db });
    // Der Kanal #alerts des eigenen Bots (nur mit status.v1) – direkt als Auftrag, denn der Benachrichtigungsdienst
    // läuft vielleicht gerade nicht
    const page = await db.one('SELECT settings FROM status_pages WHERE is_system = 1 ORDER BY id LIMIT 1');
    const ch = await botChannels(db, page && page.settings !== null ? String(page.settings) : null);
    if (ch.supported && ch.alertsChannel !== '') {
      for (const p of problems) {
        const embed = { title: p.title, description: p.text, color: 0xef4444, url: mainUrl('/admin#status'), footer: { text: 'OnYourSite status · OnYourSite' }, timestamp: new Date(now * 1000).toISOString() };
        await outboxAdd('status.alert', { channel_id: ch.alertsChannel, message: { embeds: [embed] } }, { ref: alertRef(null), db });
      }
    }
    return true;
  });
  if (!send1) return;
  for (const p of problems) {
    log(`Status watchdog: ${p.text}`);
    for (const to of admins) if (await send(to, `[Down] ${p.title} – ${domain}`, p.title, p.text)) alerts.push('watchdog:' + to);
  }
}

async function main(): Promise<void> {
  try {
    loadConfig();
  } catch (err) {
    console.error(err instanceof ConfigMissingError ? err.message : String(err));
    process.exit(1);
  }
  process.env.TZ = timeZone();
  const server = statusServerConfig();
  const port = Number(process.env.PORT) || configInt('node_port', 3000);
  const stateDir = process.env.STATE_DIRECTORY || join(tmpdir(), 'onyoursite-status');
  await runSensor({
    stateDir,
    tunnel: server.tunnel,
    originUrl: `http://127.0.0.1:${port}/_/health`,
    originHost: baseHost(),
    diskPaths: [uploadsDir(), '/var/lib/mysql'],
    smtp: smtpConfigured(),
  }).catch((err) => console.error(`Status sensor: ${(err as Error).message}`));
  await closePool().catch(() => undefined);
}

if (process.argv[1] && /status[\\/]local\.(js|ts)$/.test(process.argv[1])) void main().then(() => process.exit(0));
