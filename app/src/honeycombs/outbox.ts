// Mails des Shops (honeycomb-shop §4.13 Schritt 5, §4.14; HC-7b): in der Transaktion der Änderung in hc_mail_outbox
// geschrieben (ref je Anlass eindeutig – nie doppelt), von der Hintergrundaufgabe verschickt. Je Lauf höchstens so viele,
// wie das Budget erlaubt (Admin → Honeycombs, Standard 100); je Mail 20 Sekunden. Gelingt der Versand nicht, wird es
// bis zu 5-mal versucht; eine Erinnerung älter als 3 Tage wird nicht mehr verschickt (der Fehler bleibt stehen).
// Vorlage email/unlock_reminder.json im Aussehen des Wochenberichts; alle Werte beim Senden mit e() maskiert.
import type { Db } from '../db.js';
import { e } from '../html.js';
import { baseHost, mainUrl } from '../helpers.js';
import { intval, mbSubstr, phpStr } from '../php.js';
import { sendCustomEmail } from '../mail.js';
import { addSeconds, dayLabel, nowStr, toUnix } from './clock.js';
import { feature, lossPreview } from './features.js';
import { poolDb } from './util.js';

export const OUTBOX_MAX_TRIES = 5;
export const OUTBOX_STALE_SEC = 3 * 86400;
export const OUTBOX_KEEP_DAYS = 30;
export const MAIL_BUDGET_DEFAULT = 100;

export interface ShopMail { to: string; fullName: string; headline: string; text: string; shopUrl: string; subject: string }
export type ShopMailSender = (m: ShopMail) => Promise<boolean>;

export const defaultShopSender: ShopMailSender = (m) => sendCustomEmail(m.to, 'unlock_reminder', {
  full_name: e(m.fullName), headline: e(m.headline), text: e(m.text), shop_url: e(m.shopUrl),
  footer: e('You can turn these emails off in the editor under Honeycombs. ' + baseHost()),
}, m.subject, null, { timeoutMs: 20_000 });

let sender: ShopMailSender = defaultShopSender;
export function setShopMailSenderForTests(fn: ShopMailSender | null): void {
  sender = fn ?? defaultShopSender;
}

// In der Transaktion der Änderung (db der Kontosperre) – nur, wenn das Konto die Mails nicht abgeschaltet hat
export async function queueShopMail(db: Db, uid: number, ref: string, subject: string, vars: { headline: string; text: string; feature: string }): Promise<boolean> {
  const on = await db.value('SELECT mail_reminders FROM hc_accounts WHERE user_id = ?', [uid]);
  if (on !== null && intval(on) === 0) return false;
  const res = await db.exec('INSERT IGNORE INTO hc_mail_outbox (user_id, template, ref, subject, vars, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [uid, 'unlock_reminder', mbSubstr(ref, 0, 80), mbSubstr(subject, 0, 200), JSON.stringify(vars), nowStr()]);
  return res.affectedRows > 0;
}

// Fällige Mails senden; Rückgabe: Anzahl gesendet
export async function sendShopMails(o: { budget: number; deadline?: number; now?: string; db?: Db } ): Promise<number> {
  const db = o.db ?? poolDb;
  const now = o.now ?? nowStr();
  const rows = await db.q(`SELECT m.*, u.email, u.full_name, a.mail_reminders FROM hc_mail_outbox m LEFT JOIN users u ON u.id = m.user_id
      LEFT JOIN hc_accounts a ON a.user_id = m.user_id WHERE m.sent_at IS NULL ORDER BY m.id LIMIT ${Math.max(0, Math.min(1000, Math.trunc(o.budget)))}`);
  let sent = 0;
  for (const r of rows) {
    // Eine Mail darf 20 Sekunden dauern: nur anfangen, wenn sie noch ins Budget passt
    if (o.deadline !== undefined && Date.now() > o.deadline - 20_000) break;
    const id = intval(r.id);
    const email = phpStr(r.email ?? '');
    // Konto gelöscht, Erinnerung zu alt: erledigt, ohne zu senden
    if (email === '') {
      await db.exec("UPDATE hc_mail_outbox SET sent_at = ?, last_error = 'no recipient' WHERE id = ?", [now, id]);
      continue;
    }
    // Inzwischen abgeschaltet: nicht mehr schicken
    if (r.mail_reminders !== null && intval(r.mail_reminders) === 0) {
      await db.exec("UPDATE hc_mail_outbox SET sent_at = ?, last_error = 'switched off' WHERE id = ?", [now, id]);
      continue;
    }
    if (phpStr(r.ref).startsWith('rem') && phpStr(r.created_at) < addSeconds(now, -OUTBOX_STALE_SEC)) {
      await db.exec("UPDATE hc_mail_outbox SET sent_at = ?, last_error = 'too old to send' WHERE id = ?", [now, id]);
      continue;
    }
    let vars: { headline?: string; text?: string; feature?: string } = {};
    try { vars = JSON.parse(phpStr(r.vars)) as typeof vars; } catch { vars = {}; }
    const mail: ShopMail = {
      to: email, fullName: phpStr(r.full_name ?? '') || email, headline: phpStr(vars.headline ?? ''), text: phpStr(vars.text ?? ''),
      shopUrl: mainUrl('/dashboard#honeycombs' + (vars.feature ? '/' + phpStr(vars.feature) : '')), subject: phpStr(r.subject),
    };
    let ok = false;
    let error = '';
    try {
      ok = await sender(mail);
      if (!ok) error = 'the mail server did not take it';
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    if (ok) {
      await db.exec('UPDATE hc_mail_outbox SET sent_at = ? WHERE id = ? AND sent_at IS NULL', [now, id]);
      sent++;
    } else {
      // Nach dem 5. Versuch aufgeben (sent_at gesetzt, Fehler bleibt sichtbar)
      const tries = intval(r.tries) + 1;
      await db.exec('UPDATE hc_mail_outbox SET tries = ?, last_error = ?, sent_at = ? WHERE id = ?',
        [Math.min(255, tries), mbSubstr(error, 0, 200), tries >= OUTBOX_MAX_TRIES ? now : null, id]);
    }
  }
  return sent;
}

// Nachts: alte Zeilen löschen
export async function pruneShopMails(db: Db = poolDb, now: string = nowStr()): Promise<number> {
  const res = await db.exec('DELETE FROM hc_mail_outbox WHERE created_at < ?', [addSeconds(now, -OUTBOX_KEEP_DAYS * 86400)]);
  return res.affectedRows;
}

// ---------------------------------------------------------------- Anlässe (in der Transaktion der Kontosperre)

const titleOf = (key: string): string => feature(key)?.title ?? key;
const unix = (dt: string): number => toUnix(dt);

// Stufe 2 der Erinnerung (3 Tage vorher): „Your Premium ends on Dec 1“ mit den Zeilen „was wegfällt“
export async function queueReminderMail(db: Db, uid: number, entId: number, key: string, expiresAt: string): Promise<boolean> {
  const lines = await lossPreview(key, uid, db);
  const title = titleOf(key);
  return queueShopMail(db, uid, `rem2:${entId}:${unix(expiresAt)}`, 'Your ' + title + ' ends on ' + dayLabel(expiresAt), {
    headline: title + ' ends on ' + dayLabel(expiresAt), feature: key,
    text: [...lines, 'Renew it in the shop to keep it.'].join(' '),
  });
}

// Beendet (Ablauf, Erstattung mit „Also remove“, vom Team entfernt) – nur, wenn wirklich etwas wegfällt (§3.8)
export async function queueEndedMail(db: Db, uid: number, entId: number, key: string, endedAt: string): Promise<boolean> {
  const lines = await lossPreview(key, uid, db);
  if (!lines.length) return false;
  const title = titleOf(key);
  return queueShopMail(db, uid, `end:${entId}:${unix(endedAt)}`, 'Your ' + title + ' has ended', {
    headline: title + ' has ended', feature: key,
    text: ['It ended on ' + dayLabel(endedAt) + '.', ...lines, 'You can renew it in the shop.'].join(' '),
  });
}

// Budget je Lauf (Admin → Honeycombs → Earning rules, oys_meta 'honeycombs'.mail_per_run; 1–1000, Standard 100)
export function mailBudgetFrom(raw: string): number {
  let v: unknown;
  try { v = (JSON.parse(raw || '{}') as Record<string, unknown>).mail_per_run; } catch { v = undefined; }
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^[0-9]{1,7}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) ? Math.min(1000, Math.max(1, n)) : MAIL_BUDGET_DEFAULT;
}
export async function mailBudget(db: Db = poolDb): Promise<number> {
  return mailBudgetFrom(phpStr(await db.value("SELECT meta_value FROM oys_meta WHERE meta_key = 'honeycombs'")));
}

// Schalter des Kontos (die Zeile in hc_accounts gibt es meist schon; sonst wird sie angelegt)
export async function setMailReminders(uid: number, on: boolean, db: Db = poolDb): Promise<void> {
  const now = nowStr();
  await db.exec(`INSERT INTO hc_accounts (user_id, mail_reminders, created_at, updated_at) VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE mail_reminders = VALUES(mail_reminders), updated_at = VALUES(updated_at)`, [uid, on ? 1 : 0, now, now]);
}

export async function mailRemindersOn(uid: number, db: Db = poolDb): Promise<boolean> {
  const v = await db.value('SELECT mail_reminders FROM hc_accounts WHERE user_id = ?', [uid]);
  return v === null || intval(v) === 1;
}

// Weitere Pakete derselben Funktion, die nach diesem noch laufen (dauerhaft oder später endend) – oder bei einem Ende
// (atEnd) auch solche, die ebenfalls abgelaufen und noch nicht verarbeitet sind: dann endet nur „ein Paket“, und die
// volle Meldung mit „was wegfällt“ und die Mail kommen mit dem letzten. Gilt für Job, Erstattung und Entfernen.
export async function laterLots(db: Db, uid: number, key: string, lot: number, endsAt: string | null, now: string, atEnd: boolean): Promise<number> {
  const rows = await db.q('SELECT quantity, permanent, expires_at, expiry_done_at FROM hc_entitlements WHERE user_id = ? AND feature = ? AND lot <> ?', [uid, key, lot]);
  return rows.filter((r) => {
    if (intval(r.quantity) <= 0) return false;
    if (intval(r.permanent) === 1) return true;
    const end = r.expires_at === null ? '' : phpStr(r.expires_at);
    if (end > now) return endsAt === null || end > endsAt || atEnd;
    return atEnd && r.expiry_done_at === null && end !== '';
  }).length;
}
