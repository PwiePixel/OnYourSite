// Hintergrundaufgabe der Honigwaben (honeycomb-shop §4.13, HC-7a), alle 15 Minuten über den gemeinsamen Läufer:
//   1. Abgleich: Konten mit Merker (älter als 30 s) – alle Abgleiche, auch die langsamen
//   2. Erinnerungen: zeitlich begrenzte Freischaltungen, die in 7, 3 und 1 Tag(en) enden – je Stufe eine Glocke
//   3. Ende: abgelaufene Pakete einmal verarbeiten (Glocke, Merker, Abgleich)
// Nachts: Freischaltungen im Buch ohne Berechtigung nachtragen.
// Jede Zeile in ihrer eigenen kurzen Kontosperre; Glocke und Zustand (reminded, expiry_done_at) in derselben
// Transaktion – ein zweiter Lauf wiederholt nichts, ein Absturz verliert nichts. Ist das Budget aufgebraucht, kommt der
// Rest im nächsten Lauf. Mails (HC-7b): Stufe 2 der Erinnerung und das Ende, verschickt im Schritt „mails“ (outbox.ts).
// Automatisches Verlängern (HC-7c) gehört nicht hierher.
import type { Db, Row } from '../db.js';
import { intval, phpStr } from '../php.js';
import { V_SHOP_MAIL } from '../schema.js';
import { notify } from '../notify/notify.js';
import { registerJob, registerNightly, type JobContext } from '../jobs/registry.js';
import { addSeconds, dayLabel, nowStr, toUnix } from './clock.js';
import { withAccount } from './ledger.js';
import { isActive, stage } from './entitlements.js';
import { feature, lossPreview } from './features.js';
import { markReconcile, reconcileNow } from './reconcile.js';
import { poolDb } from './util.js';
import { laterLots, mailBudget, pruneShopMails, queueEndedMail, queueReminderMail, sendShopMails } from './outbox.js';

export const RECONCILE_BATCH = 200;
const ROWS_PER_STEP = 500;

const titleOf = (key: string): string => feature(key)?.title ?? key;
const linkOf = (key: string): string => '/dashboard#honeycombs/' + key;

// Text der Erinnerung nach Kalendertagen der Seite: „Premium ends today“ / „ends tomorrow“ / „ends in 3 days“
export function endsText(title: string, expiresAt: string, now: string): string {
  const days = Math.round((toUnix(expiresAt.slice(0, 10) + ' 12:00:00') - toUnix(now.slice(0, 10) + ' 12:00:00')) / 86400);
  if (days <= 0) return title + ' ends today';
  if (days === 1) return title + ' ends tomorrow';
  return title + ' ends in ' + days + ' days';
}


const outOfTime = (c: JobContext): boolean => Date.now() > c.deadline;

// Eine Zeile: ein Fehler (Verklemmung, gelöschtes Konto …) wird gemeldet, die übrigen Zeilen laufen weiter
async function eachRow<T>(c: JobContext, what: string, id: unknown, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    c.log(`${what} #${intval(id)} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// 1. Abgleich wiederholen
export async function reconcileStep(c: JobContext, now: string = nowStr()): Promise<number> {
  const rows = await poolDb.q(`SELECT user_id FROM hc_accounts WHERE reconcile_at IS NOT NULL AND reconcile_at <= ? ORDER BY reconcile_at, user_id LIMIT ${RECONCILE_BATCH}`,
    [addSeconds(now, -30)]);
  let done = 0;
  for (const r of rows) {
    if (outOfTime(c)) break;
    if (await reconcileNow(intval(r.user_id))) done++;
  }
  return done;
}

// 2. Erinnerungen (Stufe 1–3); ein Kauf setzt `reminded` schon auf die Stufe des Kaufs
export async function reminderStep(c: JobContext, now: string = nowStr()): Promise<number> {
  // Nur Pakete, deren Stufe noch nicht erinnert ist (sonst stünden schon erinnerte vor neuen in der Liste)
  const rows = await poolDb.q(`SELECT id, user_id FROM hc_entitlements WHERE permanent = 0 AND quantity > 0 AND expires_at > ? AND expires_at <= ?
      AND (reminded < 1 OR (reminded < 2 AND expires_at <= ?) OR (reminded < 3 AND expires_at <= ?))
      ORDER BY expires_at, id LIMIT ${ROWS_PER_STEP}`, [now, addSeconds(now, 7 * 86400), addSeconds(now, 3 * 86400), addSeconds(now, 86400)]);
  let sent = 0;
  for (const r of rows) {
    if (outOfTime(c)) break;
    const uid = intval(r.user_id);
    const out = await eachRow(c, 'reminder', r.id, () => withAccount(uid, async (db) => {
      const e = await db.one('SELECT * FROM hc_entitlements WHERE id = ? FOR UPDATE', [intval(r.id)]);
      if (!e || !isActive(e, now) || e.expires_at === null) return false;
      const st = stage(phpStr(e.expires_at), now);
      if (st <= intval(e.reminded)) return false;
      const before = intval(e.reminded);
      await db.exec('UPDATE hc_entitlements SET reminded = ?, updated_at = ? WHERE id = ?', [st, now, intval(e.id)]);
      const key = phpStr(e.feature);
      const others = await laterLots(db, uid, key, intval(e.lot), phpStr(e.expires_at), now, false);
      const title = others > 0 ? endsText('A pack of ' + titleOf(key), phpStr(e.expires_at), now) : endsText(titleOf(key), phpStr(e.expires_at), now);
      const lines = others > 0 ? [] : await lossPreview(key, uid, db);
      const body = [(others > 0 ? '' : 'It ends on ' + dayLabel(phpStr(e.expires_at)) + '. ') + 'Renew it in the shop to keep it.', ...lines].join(' ');
      await notify(uid, 'unlock', title, body, linkOf(key), { db });
      // 3 Tage vorher (Stufe 2) zusätzlich eine Mail – für das letzte Paket, wenn das Konto sie nicht abgeschaltet hat
      if (st >= 2 && before < 2 && others === 0) await queueReminderMail(db, uid, intval(e.id), key, phpStr(e.expires_at));
      return true;
    }));
    if (out === true) sent++;
  }
  return sent;
}

// 3. Ende verarbeiten: einmal je Paket (expiry_done_at); Verlängerung inzwischen → nichts zu tun
export async function expiryStep(c: JobContext, now: string = nowStr()): Promise<number> {
  const rows = await poolDb.q(`SELECT id, user_id FROM hc_entitlements WHERE permanent = 0 AND quantity > 0 AND expires_at <= ? AND expiry_done_at IS NULL
      ORDER BY expires_at, id LIMIT ${ROWS_PER_STEP}`, [now]);
  let ended = 0;
  for (const r of rows) {
    if (outOfTime(c)) break;
    const uid = intval(r.user_id);
    const out = await eachRow(c, 'expiry', r.id, () => withAccount(uid, async (db) => {
      const e = await db.one('SELECT * FROM hc_entitlements WHERE id = ? FOR UPDATE', [intval(r.id)]);
      if (!e || e.expiry_done_at !== null || isActive(e, now) || intval(e.quantity) <= 0 || intval(e.permanent) === 1) return false;
      await db.exec('UPDATE hc_entitlements SET expiry_done_at = ?, updated_at = ? WHERE id = ?', [now, now, intval(e.id)]);
      const key = phpStr(e.feature);
      const others = await laterLots(db, uid, key, intval(e.lot), phpStr(e.expires_at), now, true);
      const lines = others > 0 ? [] : await lossPreview(key, uid, db);
      await notify(uid, 'unlock', others > 0 ? 'A pack of ' + titleOf(key) + ' has ended' : titleOf(key) + ' has ended',
        ['It ended on ' + dayLabel(phpStr(e.expires_at)) + '. You can renew it in the shop.', ...lines].join(' '), linkOf(key), { db });
      if (others === 0) await queueEndedMail(db, uid, intval(e.id), key, phpStr(e.expires_at));
      await markReconcile(db, uid, now);
      return true;
    }));
    if (out === true) {
      ended++;
      // Nach dem Commit, ohne gehaltene Verbindung; ein Fehler lässt den Merker stehen (Schritt 1 versucht es erneut)
      await reconcileNow(uid);
    }
  }
  return ended;
}

// Nachts: Freischaltung im Buch (unlock/<Funktion>) ohne Berechtigung → dauerhafte Berechtigung nachtragen (wie die
// Migration). Nur dauerhafte oder nicht (mehr) angemeldete Funktionen; jede Zeile unter der Kontosperre mit Merker.
export async function repairEntitlements(c: JobContext): Promise<number> {
  const rows: Row[] = await poolDb.q(`SELECT l.user_id, l.ref, MIN(l.created_at) AS at, MIN(l.amount) AS amount FROM honeycomb_ledger l
      JOIN users u ON u.id = l.user_id
      LEFT JOIN hc_entitlements e ON e.user_id = l.user_id AND e.feature = l.ref
      WHERE l.reason = 'unlock' AND e.id IS NULL AND CAST(l.ref AS BINARY) REGEXP '^[a-z][a-z0-9_]{1,39}$'
      GROUP BY l.user_id, l.ref ORDER BY l.user_id LIMIT ${ROWS_PER_STEP}`);
  let fixed = 0;
  for (const r of rows) {
    if (outOfTime(c)) break;
    const key = phpStr(r.ref);
    const f = feature(key);
    if (f && f.kind !== 'permanent') continue;
    const uid = intval(r.user_id);
    const out = await eachRow(c, 'repair', r.user_id, () => withAccount(uid, async (db) => {
      const now = nowStr();
      const res = await db.exec(`INSERT IGNORE INTO hc_entitlements (user_id, feature, lot, quantity, permanent, expires_at, source, note, created_at, updated_at)
          VALUES (?, ?, 0, 1, 1, NULL, ?, '', ?, ?)`, [uid, key, intval(r.amount) === 0 ? 'admin' : 'legacy', phpStr(r.at), now]);
      if (res.affectedRows > 0) await markReconcile(db, uid, now);
      return res.affectedRows > 0;
    }));
    if (out === true) {
      fixed++;
      await reconcileNow(uid);
    }
  }
  return fixed;
}

// Die ganze Aufgabe; ein Fehler eines Schritts wird gemeldet, die nächsten laufen trotzdem
export async function honeycombJob(c: JobContext): Promise<void> {
  const errors: string[] = [];
  const steps: Array<[string, (c: JobContext) => Promise<number>]> = [['reconcile', (x) => reconcileStep(x)], ['reminders', (x) => reminderStep(x)], ['expiry', (x) => expiryStep(x)],
    ['mails', async (x) => sendShopMails({ budget: await mailBudget(), deadline: x.deadline })]];
  for (const [name, fn] of steps) {
    try {
      const n = await fn(c);
      if (n > 0) c.log(`${name}: ${n}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      c.log(`${name} failed: ${msg}`);
      errors.push(`${name}: ${msg}`);
    }
  }
  if (errors.length) throw new Error(errors.join('; '));
}

let registered = false;
// Beim Laden des Läufers (cli.ts jobs:tick) und in Tests – einmal
export function registerHoneycombJobs(): void {
  if (registered) return;
  registered = true;
  registerJob({ name: 'honeycombs', everyMinutes: 15, minSchema: V_SHOP_MAIL, budgetSec: 240, run: honeycombJob });
  registerNightly('honeycombs', async (c) => {
    const n = await repairEntitlements(c);
    if (n > 0) c.log(`repaired entitlements: ${n}`);
    const old = await pruneShopMails();
    if (old > 0) c.log(`old mails removed: ${old}`);
  }, V_SHOP_MAIL);
}

export function resetHoneycombJobsForTests(): void {
  registered = false;
}
