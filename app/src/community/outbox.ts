// Aufträge der Website an den Bot (community_outbox): welche Aktion zu welcher Funktion des Bots gehört, welche
// Aufträge ein Bot bekommt (GET /_/bot/outbox?f=…), was eine Rückmeldung bewirkt (POST /_/bot/outbox/{id}/done) und das
// stündliche Aufräumen.
//
// Register: registerBotAction(action, {feature, onResult?, maxAgeSec?}). feature null = jeder Bot kann es (auch 0.1).
// Ein Bot bekommt nur Aufträge, deren Funktion er beim Abholen nennt (f ist Teil der signierten Adresse) – ein alter
// Bot bekommt so nie einen Auftrag, den er zehnmal mit „Unknown action“ beantworten würde.
// Reihenfolge je ref (z. B. 'post:7', 'ticket:3'): ein Auftrag wartet, solange ein früherer mit demselben ref offen ist.
// Fehler: Pause 10 s · 2^(Versuche−1), höchstens 1 h; nach 10 Versuchen ist der Auftrag tot.
// onResult(db, job, result, error, final) läuft in derselben Transaktion wie die Rückmeldung: bei Erfolg
// (error '' und final true), bei jedem Fehler (final = der Auftrag ist jetzt tot) und beim Verfallen (error 'expired').
import { configString } from '../config.js';
import { LockBusyError, q, transaction, withNamedLock, type Db } from '../db.js';
import { date, intval, phpStr, strtotime, time } from '../php.js';
import { phpCastString, phpJsonDecode } from './json.js';

export interface OutboxJob {
  id: number;
  action: string;
  payload: string;
  attempts: number;
  ref: string | null;
  created_at: string;
  claimed_at: string | null;
  done_at: string | null;
  // Inhalt als JS-Wert (JSON.parse; null bei kaputtem Inhalt)
  data: Record<string, unknown> | null;
}

export type BotResult = Record<string, unknown>;

// Was beim Ausgeben mit einem Auftrag passiert
export type Prepared =
  | { send: true; data?: Record<string, unknown> } // ausgeben (data: ergänzter Inhalt, z. B. recheck)
  | { send: false; reason: string }; // nicht mehr ausgeben: erledigt mit diesem Grund

export interface BotActionSpec {
  feature: string | null;
  onResult?: (db: Db, job: OutboxJob, result: BotResult | null, error: string, final: boolean) => Promise<void>;
  // Nie abgeholt und älter: wird nicht mehr ausgegeben ('expired'; onResult bekommt den endgültigen Fehler)
  maxAgeSec?: number;
  // Eigene Zeile vor dem Auftrag sperren (Sperr-Reihenfolge immer: eigene Zeile → Auftrag), z. B. den Beitrag eines Updates
  lock?: (db: Db, job: OutboxJob) => Promise<void>;
  // Eigene Regeln beim Ausgeben (nach den Sperren, in derselben Transaktion); ersetzt die Regel für maxAgeSec
  prepare?: (db: Db, job: OutboxJob) => Promise<Prepared>;
}

const REGISTRY = new Map<string, BotActionSpec>();

export function registerBotAction(action: string, spec: BotActionSpec): void {
  if (!/^[a-z][a-z0-9_.-]{0,29}$/.test(action)) throw new Error(`invalid bot action: ${action}`);
  if (spec.feature !== null && !/^[a-z][a-z0-9_.-]{0,39}$/.test(spec.feature)) throw new Error(`invalid bot feature: ${spec.feature}`);
  REGISTRY.set(action, spec);
}

export function botAction(action: string): BotActionSpec | undefined {
  return REGISTRY.get(action);
}

// Funktionen, die diese Website kennt: hello und alle registrierten
export function knownFeatures(): string[] {
  const out = ['hello'];
  for (const spec of REGISTRY.values()) if (spec.feature !== null && !out.includes(spec.feature)) out.push(spec.feature);
  return out;
}

// Was jeder Bot kann (schon Version 0.1)
for (const action of ['suggestion.decided', 'ticket.reply', 'ticket.close']) registerBotAction(action, { feature: null });

// ?f=a,b,c → Funktionen des abholenden Bots (unbekannte Namen zählen nicht; höchstens 50)
export function parseFeatures(raw: unknown): Set<string> {
  const out = new Set<string>();
  if (typeof raw !== 'string') return out;
  for (const name of raw.split(',').slice(0, 50)) if (/^[a-z][a-z0-9_.-]{0,39}$/.test(name)) out.add(name);
  return out;
}

// Aktionen, die dieser Bot nicht bekommt (registriert, aber mit einer Funktion, die er nicht nennt). Nicht registrierte
// Aktionen gehen wie bisher an jeden Bot.
function excludedActions(features: Set<string>): string[] {
  const out: string[] = [];
  for (const [action, spec] of REGISTRY) if (spec.feature !== null && !features.has(spec.feature)) out.push(action);
  return out;
}

const now = (): string => date('Y-m-d H:i:s');
const JOB_COLUMNS = 'id, action, payload, attempts, ref, created_at, claimed_at, done_at';

export function jobFromRow(row: Record<string, unknown>): OutboxJob {
  const payload = phpStr(row.payload ?? '');
  let data: Record<string, unknown> | null = null;
  try {
    const v = JSON.parse(payload) as unknown;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) data = v as Record<string, unknown>;
  } catch {
    data = null;
  }
  return {
    id: intval(row.id), action: phpStr(row.action), payload, attempts: intval(row.attempts), ref: row.ref === null || row.ref === undefined ? null : phpStr(row.ref),
    created_at: phpStr(row.created_at), claimed_at: row.claimed_at === null || row.claimed_at === undefined ? null : phpStr(row.claimed_at),
    done_at: row.done_at === null || row.done_at === undefined ? null : phpStr(row.done_at), data,
  };
}

// Alter eines Auftrags in Sekunden
export function ageOf(job: OutboxJob): number {
  const t = strtotime(job.created_at);
  return t === false ? 0 : time() - t;
}

// Pause nach dem n-ten Fehlversuch: 10, 20, 40 … 2560 s, höchstens eine Stunde
export function pauseAfter(attempts: number): number {
  return Math.min(10 * 2 ** Math.max(0, attempts - 1), 3600);
}

// Eine Transaktion; ein Deadlock (1213) wird einmal wiederholt
export async function withRetry<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  try {
    return await transaction((_conn, db) => fn(db));
  } catch (err) {
    if ((err as { errno?: number }).errno !== 1213) throw err;
    return transaction((_conn, db) => fn(db));
  }
}

// Auftrag erledigt (mit Grund in last_error, z. B. 'cancelled', 'expired', 'superseded', 'skipped', 'forgotten')
export async function closeJob(db: Db, id: number, reason: string | null): Promise<void> {
  await db.exec('UPDATE community_outbox SET done_at = ?, last_error = ? WHERE id = ? AND done_at IS NULL', [now(), reason, id]);
}

// Einen Auftrag gesperrt neu lesen (nach der eigenen Zeile)
export async function lockJob(db: Db, id: number): Promise<OutboxJob | null> {
  const row = await db.one(`SELECT ${JOB_COLUMNS} FROM community_outbox WHERE id = ? FOR UPDATE`, [id]);
  return row ? jobFromRow(row) : null;
}

// Prüfen, ob ein Auftrag noch ausgegeben wird – mit den Sperren (eigene Zeile → Auftrag). null: nicht ausgeben
// (erledigt bzw. nicht mehr offen); sonst { data } mit dem ergänzten Inhalt oder data null (Inhalt unverändert).
async function reconcile(db: Db, candidate: OutboxJob): Promise<{ data: Record<string, unknown> | null } | null> {
  const spec = REGISTRY.get(candidate.action);
  if (spec?.lock) await spec.lock(db, candidate);
  const job = await lockJob(db, candidate.id);
  if (!job || job.done_at !== null || job.attempts >= 10) return null;
  let prepared: Prepared = { send: true };
  if (spec?.prepare) {
    prepared = await spec.prepare(db, job);
  } else if (spec?.maxAgeSec !== undefined && job.claimed_at === null && ageOf(job) > spec.maxAgeSec) {
    prepared = { send: false, reason: 'expired' };
  }
  if (!prepared.send) {
    await closeJob(db, job.id, prepared.reason);
    if (prepared.reason === 'expired' && spec?.onResult) await spec.onResult(db, job, null, 'expired', true);
    return null;
  }
  return { data: prepared.data ?? null };
}

export interface HandedOut { id: number; action: string; data: unknown; attempts: number }

// GET /_/bot/outbox: bis zu 20 fällige Aufträge, die dieser Bot kann, je ref nur der früheste offene
export async function handOut(features: Set<string>): Promise<HandedOut[]> {
  const excluded = excludedActions(features);
  const stamp = now();
  const rows = await q(
    `SELECT ${JOB_COLUMNS} FROM community_outbox o
      WHERE o.done_at IS NULL AND o.attempts < 10 AND (o.next_try_at IS NULL OR o.next_try_at <= ?)
        ${excluded.length ? `AND o.action NOT IN (${excluded.map(() => '?').join(', ')})` : ''}
        AND (o.ref IS NULL OR NOT EXISTS (SELECT 1 FROM community_outbox e WHERE e.ref = o.ref AND e.id < o.id AND e.done_at IS NULL AND e.attempts < 10))
      ORDER BY o.id LIMIT 20`,
    [stamp, ...excluded],
  );
  const items: HandedOut[] = [];
  for (const row of rows) {
    const candidate = jobFromRow(row);
    const out = await withRetry(async (db) => {
      const r = await reconcile(db, candidate);
      if (r !== null) await db.exec('UPDATE community_outbox SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL', [now(), candidate.id]);
      return r;
    });
    if (out === null) continue;
    // Inhalt wie bisher (json_decode wie PHP: große Zahlen, Listen …); ergänzt nur, wo eine Regel etwas hinzufügt
    const data = out.data ?? phpJsonDecode(phpCastString(candidate.payload));
    items.push({ id: candidate.id, action: candidate.action, data, attempts: candidate.attempts });
  }
  return items;
}

export type DoneCheck = { ok: true; error: string; final: boolean; result: BotResult | null } | { ok: false };

// Rückmeldung des Bots prüfen: error (Text), final (ja/nein), result (Objekt) – alles optional
export function parseDone(body: unknown, errorText: string): DoneCheck {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false };
  const b = body as Record<string, unknown>;
  if (b.final !== undefined && typeof b.final !== 'boolean') return { ok: false };
  if (b.result !== undefined && b.result !== null && (typeof b.result !== 'object' || Array.isArray(b.result))) return { ok: false };
  return { ok: true, error: errorText, final: b.final === true, result: (b.result as BotResult | undefined) ?? null };
}

// POST /_/bot/outbox/{id}/done – alles in einer Transaktion: eigene Zeile sperren, Auftrag sperren, eintragen,
// onResult. Ein schon erledigter Auftrag ändert nichts mehr (eine wiederholte Rückmeldung schadet nicht).
export async function finishJob(id: number, error: string, final: boolean, result: BotResult | null): Promise<void> {
  // Ohne Sperre lesen, welche eigene Zeile zuerst gesperrt wird
  const first = (await q(`SELECT ${JOB_COLUMNS} FROM community_outbox WHERE id = ?`, [id]))[0];
  if (!first) return;
  const peek = jobFromRow(first);
  if (peek.done_at !== null) return;
  await finishHook('done:read', peek);
  await withRetry(async (db) => {
    const spec = REGISTRY.get(peek.action);
    if (spec?.lock) await spec.lock(db, peek);
    const job = await lockJob(db, id);
    if (!job || job.done_at !== null) return;
    if (error === '') {
      await db.exec('UPDATE community_outbox SET done_at = ?, last_error = NULL WHERE id = ?', [now(), id]);
      if (spec?.onResult) await spec.onResult(db, job, result, '', true);
      return;
    }
    const attempts = final ? 10 : job.attempts + 1;
    const next = date('Y-m-d H:i:s', time() + pauseAfter(attempts));
    await db.exec('UPDATE community_outbox SET attempts = ?, last_error = ?, next_try_at = ? WHERE id = ?', [attempts, error, next, id]);
    if (spec?.onResult) await spec.onResult(db, job, result, error, attempts >= 10);
  });
}

// Nur für Tests: zwischen dem Lesen und dem Sperren in finishJob anhalten
export const outboxHooks: { pause: ((point: string, job: OutboxJob) => Promise<void>) | null } = { pause: null };
async function finishHook(point: string, job: OutboxJob): Promise<void> {
  if (outboxHooks.pause) await outboxHooks.pause(point, job);
}

// Verfallene Aufträge beenden, auch wenn kein passender Bot mehr abholt (nur die Regeln, nichts wird ausgegeben)
export async function expireStale(): Promise<number> {
  let closed = 0;
  for (const [action, spec] of REGISTRY) {
    if (spec.maxAgeSec === undefined) continue;
    const cutoff = date('Y-m-d H:i:s', time() - spec.maxAgeSec);
    const rows = await q(`SELECT ${JOB_COLUMNS} FROM community_outbox WHERE action = ? AND done_at IS NULL AND attempts < 10 AND created_at < ? ORDER BY id LIMIT 100`, [action, cutoff]);
    for (const row of rows) {
      const candidate = jobFromRow(row);
      const sent = await withRetry((db) => reconcile(db, candidate));
      if (sent === null) closed++;
    }
  }
  return closed;
}

// Weitere Aufräumarbeiten anderer Teile (z. B. hängende Discord-Beiträge)
const CLEANUPS: Array<() => Promise<void>> = [];
export function registerCleanup(fn: () => Promise<void>): void {
  CLEANUPS.push(fn);
}

// Stündlich: erledigte Aufträge nach 30 Tagen löschen (höchstens 1000 auf einmal), verfallene beenden, dann die
// Aufräumarbeiten der anderen Teile. Nur ein Prozess gleichzeitig (benannte Sperre, sonst übersprungen).
export async function outboxCleanup(): Promise<boolean> {
  try {
    await withNamedLock(configString('db.name') + ':oys_outbox_cleanup', 0, async (db) => {
      await db.exec('DELETE FROM community_outbox WHERE done_at IS NOT NULL AND done_at < ? LIMIT 1000', [date('Y-m-d H:i:s', time() - 30 * 86400)]);
      await expireStale();
      for (const fn of CLEANUPS) await fn();
    }, 'fail');
    return true;
  } catch (err) {
    if (err instanceof LockBusyError) return false;
    throw err;
  }
}

let timer: NodeJS.Timeout | null = null;
// Im Webserver einmal starten (hält den Prozess nicht am Leben)
export function startOutboxCleanup(everyMs = 3600_000): void {
  if (timer) return;
  timer = setInterval(() => {
    outboxCleanup().catch((err) => console.error(`[${new Date().toISOString()}] outbox cleanup failed:`, err));
  }, everyMs);
  timer.unref();
}
