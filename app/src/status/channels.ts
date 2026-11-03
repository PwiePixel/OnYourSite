// Statusseiten: zusätzliche Alarm-Kanäle (Entwurf §2.1.5, §4.10; ST-5) – weitere E-Mail-Adressen (erst nach der
// Bestätigung über einen Link auf der Hauptseite) und Discord-Webhooks (geprüft und mit einer Testnachricht angelegt;
// auf Wunsch auch Beiträge zu Vorfällen). Ziele liegen verschlüsselt in status_channels (target_enc), jedes Ziel nur
// einmal je Seite (target_hash). Verschickt wird nur über status_outbox (notifier.ts) – nie hier, außer der Prüfung
// des Webhooks beim Anlegen (außerhalb jeder Transaktion).
import { randomBytes } from 'node:crypto';
import { transaction, withConnection, type Db, type Row } from '../db.js';
import { decrypt, encryptData, hmac, sha256Hex } from '../crypto.js';
import { validateEmail } from '../helpers.js';
import { rateLimit } from '../web/security.js';
import { checkWebhook, cleanWebhookLink, discordError, maskedWebhook, parseWebhookLink, webhookPost, type WebhookLink } from '../discord/index.js';
import { ALERT_EVENTS, type AlertEvent } from './settings.js';

export type ChannelType = 'email' | 'discord';
export const CHANNEL_EVENTS = [...ALERT_EVENTS, 'incident'] as const;
export type ChannelEvent = (typeof CHANNEL_EVENTS)[number];
export const VERIFY_VALID_SEC = 7 * 86400;
export const RESEND_AFTER_SEC = 600;
export const TEST_RATE = { max: 3, windowSec: 600 };
export const VERIFY_RATE = { max: 10, windowSec: 3600 };
export const BROKEN_AFTER = 5; // Fehlschläge in Folge (Discord 401/404), dann aus

export interface Channel {
  id: number;
  type: ChannelType;
  label: string;
  events: ChannelEvent[];
  state: 'waiting' | 'working' | 'failing' | 'off';
  error: string;
  enabled: boolean;
  verified: boolean;
  canResend: boolean;
}

const nowS = (): number => Math.floor(Date.now() / 1000);
export const channelKey = (id: number): string => 'channel:' + id;
export const targetHash = (type: ChannelType, target: string): string => hmac('status-channel|' + type + '|' + (type === 'email' ? target.toLowerCase() : target));

export function eventsFrom(raw: unknown): ChannelEvent[] {
  const list = String(raw ?? '').split(',').map((x) => x.trim());
  return CHANNEL_EVENTS.filter((e) => list.includes(e));
}

export function channelFrom(r: Row, now: number = nowS()): Channel {
  const type = String(r.type) === 'discord' ? 'discord' : 'email';
  const verified = r.verified_at !== null && r.verified_at !== undefined;
  const enabled = Number(r.is_enabled) === 1;
  const failing = Number(r.fail_count ?? 0) > 0 && enabled;
  const state: Channel['state'] = !enabled ? 'off' : !verified ? 'waiting' : failing ? 'failing' : 'working';
  const sent = r.verify_sent_at === null || r.verify_sent_at === undefined ? 0 : Number(r.verify_sent_at);
  return {
    id: Number(r.id), type, label: String(r.label ?? ''), events: eventsFrom(r.events), state, error: String(r.last_error ?? ''), enabled, verified,
    canResend: type === 'email' && !verified && now - sent >= RESEND_AFTER_SEC,
  };
}

export async function listChannels(db: Db, pageId: number): Promise<Channel[]> {
  const now = nowS();
  return (await db.q('SELECT * FROM status_channels WHERE page_id = ? AND type IN (?, ?) ORDER BY id', [pageId, 'email', 'discord'])).map((r) => channelFrom(r, now));
}

// Ziel (entschlüsselt) eines Kanals – nur für den Versand
export function channelTarget(r: Row): string {
  return decrypt(r.target_enc);
}

// Anzeige: E-Mail-Adresse mit verdecktem Namen, Webhook nur mit ID
function emailLabel(email: string): string {
  const [name, domain] = email.split('@');
  return (name.length <= 2 ? name[0] + '•' : name.slice(0, 2) + '•••') + '@' + domain;
}

export type ChannelResult = { ok: true; channel: Channel } | { ok: false; error: string; field?: string };

function cleanEvents(input: unknown, type: ChannelType): ChannelEvent[] | null {
  if (input === undefined) return type === 'discord' ? [...ALERT_EVENTS, 'incident'] : [...ALERT_EVENTS];
  if (!Array.isArray(input) || !input.every((x) => typeof x === 'string' && (CHANNEL_EVENTS as readonly string[]).includes(x))) return null;
  return CHANNEL_EVENTS.filter((e) => (input as string[]).includes(e) && (e !== 'incident' || type === 'discord'));
}
const NO_EVENTS = { ok: false as const, error: 'Please choose at least one event.', field: 'events' };

// Neuer Kanal. limit = erlaubte Kanäle dieser Seite (limits.channels)
export async function addChannel(pageId: number, uid: number, limit: number, input: Record<string, unknown>): Promise<ChannelResult> {
  const type = input.type === 'email' || input.type === 'discord' ? input.type : null;
  if (type === null) return { ok: false, error: 'Please choose email or Discord.', field: 'type' };
  const events = cleanEvents(input.events, type);
  if (events === null) return { ok: false, error: 'Please choose the events again.', field: 'events' };
  if (!events.length) return NO_EVENTS;
  if (limit <= 0) return { ok: false, error: 'Extra alert channels aren’t available for this page.' };
  const raw = typeof input.target === 'string' ? input.target.trim() : '';
  let target = '';
  let label = '';
  let hook: WebhookLink | null = null;
  if (type === 'email') {
    if (raw === '' || raw.length > 190 || !validateEmail(raw)) return { ok: false, error: 'Please enter a valid email address.', field: 'target' };
    target = raw;
    label = emailLabel(raw.toLowerCase());
  } else {
    hook = parseWebhookLink(raw);
    if (!hook) return { ok: false, error: 'Please paste a Discord webhook link (Server settings → Integrations → Webhooks).', field: 'target' };
    target = cleanWebhookLink(raw) + (hook.threadId !== '' ? '?thread_id=' + hook.threadId : '');
    label = maskedWebhook(hook);
  }
  const hash = targetHash(type, target);
  // Vorab (ohne Sperre): doppelt oder voll – so wird kein Webhook unnötig angesprochen; unter der Sperre noch einmal
  const pre = await withConnection(async (db) => ({
    dup: !!(await db.value('SELECT 1 FROM status_channels WHERE page_id = ? AND target_hash = ?', [pageId, hash])),
    count: Number(await db.value("SELECT COUNT(*) FROM status_channels WHERE page_id = ? AND type IN ('email', 'discord')", [pageId])),
  }));
  if (pre.dup) return { ok: false, error: 'This address is already on the list.', field: 'target' };
  if (pre.count >= limit) return { ok: false, error: `You can add up to ${limit} alert channel${limit === 1 ? '' : 's'}.` };
  if (type === 'email' && !(await rateLimit('statusverify:' + uid, VERIFY_RATE.max, VERIFY_RATE.windowSec))) {
    return { ok: false, error: 'You’ve added many addresses – please wait an hour.' };
  }
  if (hook) {
    // Prüfen und eine Testnachricht schicken: aktiv nur, wenn Discord sie annimmt
    const check = await checkWebhook(hook);
    if (check.status < 200 || check.status >= 300) return { ok: false, error: 'Discord rejected the webhook link – please copy it again from Discord.', field: 'target' };
    const test = await webhookPost(hook, { content: 'Status alerts will be posted here.', allowed_mentions: { parse: [] } }, { threadId: hook.threadId });
    if (test.status < 200 || test.status >= 300) return { ok: false, error: discordError(test, 'webhook'), field: 'target' };
  }
  const now = nowS();
  return transaction(async (_conn, db): Promise<ChannelResult> => {
    // Sperre der Seite: Anzahl und Doppelte genau
    if (!(await db.one('SELECT id FROM status_pages WHERE id = ? FOR UPDATE', [pageId]))) return { ok: false, error: 'This status page no longer exists.' };
    const count = Number(await db.value("SELECT COUNT(*) FROM status_channels WHERE page_id = ? AND type IN ('email', 'discord')", [pageId]));
    if (count >= limit) return { ok: false, error: `You can add up to ${limit} alert channel${limit === 1 ? '' : 's'}.` };
    const res = await db.exec(`INSERT IGNORE INTO status_channels (page_id, type, target_enc, target_hash, label, events, verified_at, is_enabled, fail_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, NOW())`, [pageId, type, encryptData(target) ?? '', hash, label, events.join(','), type === 'discord' ? now : null]);
    if (!res.affectedRows) return { ok: false, error: 'This address is already on the list.', field: 'target' };
    if (type === 'email') await queueVerify(db, pageId, res.insertId, now);
    const row = await db.one('SELECT * FROM status_channels WHERE id = ?', [res.insertId]);
    return { ok: true, channel: channelFrom(row!, now) };
  });
}

// Bestätigungsmail in die Warteschlange (der Link entsteht erst beim Versand – nie in der Datenbank im Klartext)
export async function queueVerify(db: Db, pageId: number, channelId: number, now: number): Promise<void> {
  await db.exec('UPDATE status_channels SET verify_sent_at = ? WHERE id = ?', [now, channelId]);
  // Wartet schon eine: die erzeugt beim Versand den neuesten Link – keine zweite Mail
  if (await db.value("SELECT 1 FROM status_outbox WHERE channel = ? AND kind = 'channel_verify' AND state = 'pending'", [channelKey(channelId)])) return;
  await db.exec(`INSERT INTO status_outbox (page_id, monitor_id, kind, class, channel, event, payload, state, attempts, next_at, created_at)
      VALUES (?, NULL, 'channel_verify', 'confirm', ?, '', '{}', 'pending', 0, ?, ?)`, [pageId, channelKey(channelId), now, now]);
}

async function channelOf(db: Db, pageId: number, id: number, lock = false): Promise<Row | null> {
  return db.one(`SELECT * FROM status_channels WHERE id = ? AND page_id = ? AND type IN ('email', 'discord')${lock ? ' FOR UPDATE' : ''}`, [id, pageId]);
}

export async function editChannel(pageId: number, id: number, input: Record<string, unknown>): Promise<ChannelResult> {
  return transaction(async (_conn, db): Promise<ChannelResult> => {
    const r = await channelOf(db, pageId, id, true);
    if (!r) return { ok: false, error: 'This channel no longer exists.' };
    const type = String(r.type) as ChannelType;
    const sets: string[] = [];
    const params: Array<string | number> = [];
    if (input.events !== undefined) {
      const events = cleanEvents(input.events, type);
      if (events === null) return { ok: false, error: 'Please choose the events again.', field: 'events' };
      if (!events.length) return NO_EVENTS;
      sets.push('events = ?');
      params.push(events.join(','));
    }
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') return { ok: false, error: 'Not all of the data arrived. Please try again.' };
      // Wieder an: die Fehlerzählung beginnt neu
      sets.push('is_enabled = ?', 'fail_count = 0');
      params.push(input.enabled ? 1 : 0);
      if (input.enabled) sets.push('last_error = NULL');
    }
    if (sets.length) await db.exec(`UPDATE status_channels SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
    return { ok: true, channel: channelFrom((await channelOf(db, pageId, id))!) };
  });
}

// Entfernen: wartende Nachrichten an ihn entfallen; Vorfall-Beiträge in Discord bleiben dort stehen
export async function removeChannel(pageId: number, id: number): Promise<{ ok: true } | { ok: false; error: string }> {
  return transaction(async (_conn, db) => {
    const r = await channelOf(db, pageId, id, true);
    if (!r) return { ok: false as const, error: 'This channel no longer exists.' };
    await db.exec("UPDATE status_outbox SET state = 'skipped', error = 'The channel was removed.' WHERE page_id = ? AND channel = ? AND state = 'pending'", [pageId, channelKey(id)]);
    await db.exec('DELETE FROM status_incident_posts WHERE target = ?', [channelKey(id)]);
    await db.exec('DELETE FROM status_channels WHERE id = ?', [id]);
    return { ok: true as const };
  });
}

// Testnachricht (3 je 10 Minuten und Kanal) – geht wie ein Alarm durch die Warteschlange
export async function testChannel(pageId: number, id: number, page: { slug: string; title: string; system: boolean; owner: number | null }): Promise<{ ok: true } | { ok: false; error: string }> {
  // Erst prüfen, dann zählen: ein abgelehnter Test verbraucht keinen der drei
  const pre = await withConnection((db) => channelOf(db, pageId, id));
  if (!pre) return { ok: false, error: 'This channel no longer exists.' };
  const problem = (c: Channel): string | null => (!c.verified ? 'Confirm the address first – we sent a link to it.' : !c.enabled ? 'Turn the channel on first.' : null);
  const first = problem(channelFrom(pre));
  if (first) return { ok: false, error: first };
  if (!(await rateLimit('statustest:' + id, TEST_RATE.max, TEST_RATE.windowSec))) return { ok: false, error: 'You’ve sent 3 tests – please wait 10 minutes.' };
  return transaction(async (_conn, db) => {
    const r = await channelOf(db, pageId, id, true);
    if (!r) return { ok: false as const, error: 'This channel no longer exists.' };
    const again = problem(channelFrom(r));
    if (again) return { ok: false as const, error: again };
    const now = nowS();
    const payload = { page: { id: pageId, ...page }, monitor: { id: 0, name: 'Test', type: 'test', target: '', public: false }, event: 'test', category: 'down', at: now };
    await db.exec(`INSERT INTO status_outbox (page_id, monitor_id, kind, class, channel, event, payload, state, attempts, next_at, created_at)
        VALUES (?, NULL, 'test', 'owner', ?, 'test', ?, 'pending', 0, ?, ?)`, [pageId, channelKey(id), JSON.stringify(payload), now, now]);
    return { ok: true as const };
  });
}

// Bestätigungsmail noch einmal (nur unbestätigt, höchstens alle 10 Minuten)
export async function resendVerify(pageId: number, id: number): Promise<{ ok: true } | { ok: false; error: string }> {
  return transaction(async (_conn, db) => {
    const r = await channelOf(db, pageId, id, true);
    if (!r) return { ok: false as const, error: 'This channel no longer exists.' };
    const c = channelFrom(r);
    if (c.type !== 'email' || c.verified) return { ok: false as const, error: 'This address is already confirmed.' };
    if (!c.canResend) return { ok: false as const, error: 'We just sent a link – you can send it again after 10 minutes.' };
    await queueVerify(db, pageId, id, nowS());
    return { ok: true as const };
  });
}

// Link für die Bestätigung: 32 Zeichen base64url; gespeichert wird nur der Hash
export function mintVerifyToken(): { token: string; hash: string } {
  const token = randomBytes(24).toString('base64url');
  return { token, hash: sha256Hex(token) };
}

export const VERIFY_TOKEN = /^[A-Za-z0-9_-]{32}$/;

// Was der Link bestätigen würde (für GET): Seite und Adresse – oder null
export async function verifyLookup(token: string, now: number = nowS()): Promise<{ id: number; pageTitle: string; verified: boolean } | null> {
  if (!VERIFY_TOKEN.test(token)) return null;
  const r = await withConnection((db) => db.one(`SELECT c.id, c.verified_at, c.verify_sent_at, p.title FROM status_channels c JOIN status_pages p ON p.id = c.page_id
      WHERE c.verify_hash = ? AND c.type = 'email'`, [sha256Hex(token)]));
  if (!r || now - Number(r.verify_sent_at ?? 0) > VERIFY_VALID_SEC) return null;
  return { id: Number(r.id), pageTitle: String(r.title), verified: r.verified_at !== null };
}

// POST: bestätigen (der Link gilt danach nicht mehr)
export async function verifyConfirm(token: string, now: number = nowS()): Promise<{ title: string; already: boolean } | null> {
  const found = await verifyLookup(token, now);
  if (!found) return null;
  if (found.verified) return { title: found.pageTitle, already: true };
  await withConnection((db) => db.exec('UPDATE status_channels SET verified_at = ? WHERE id = ? AND verify_hash = ? AND verified_at IS NULL', [now, found.id, sha256Hex(token)]));
  return { title: found.pageTitle, already: false };
}

// Für den Prüfdienst (alerts.ts): Kanäle einer Seite, die ein Ereignis bekommen
export async function channelsFor(db: Db, pageId: number, event: AlertEvent | 'incident'): Promise<number[]> {
  const rows = await db.q("SELECT id, events FROM status_channels WHERE page_id = ? AND type IN ('email', 'discord') AND is_enabled = 1 AND verified_at IS NOT NULL", [pageId]);
  return rows.filter((r) => eventsFrom(r.events).includes(event)).map((r) => Number(r.id));
}
