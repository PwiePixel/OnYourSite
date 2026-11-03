// Werkzeuge des Teams im Shop (honeycomb-shop §4.5, HC-6b): Buchungen zurücknehmen (Reverse), Konten anhalten
// (Freeze) und Honigwaben an mehrere Nutzer auf einmal (erst prüfen, dann buchen). Jede Buchung unter der Kontosperre,
// mit Protokoll (hc_audit) und Glocke in derselben Transaktion; CSRF, Admin-Sitzung und die Bestätigung prüft
// admin/page.ts vorher.
import type { Db, Row } from '../db.js';
import { intval, numberFormat, phpStr } from '../php.js';
import { cleanText } from '../helpers.js';
import { notify } from '../notify/notify.js';
import { nowStr } from './clock.js';
import { BUSY, HC_BUSY_TEXT, balanceIn, credit, withAccount } from './ledger.js';
import { audit } from './audit.js';
import { hcDescribe } from './honeycombs.js';
import { poolDb } from './util.js';

export type ToolResult = { ok: string } | { error: string };

// Gründe, die sich zurücknehmen lassen (Belohnungen und Gaben); Käufe, Erstattungen, Freischaltungen nicht
export const REVERSIBLE: readonly string[] = ['admin', 'daily', 'profile', 'views', 'streak', 'code'];

const nameOf = (u: Row | null): string => (u ? (phpStr(u.full_name ?? '') !== '' ? phpStr(u.full_name) : phpStr(u.email)) : '');
const busy = (out: unknown): out is typeof BUSY => out === BUSY;

// ---------------------------------------------------------------- Reverse

export async function reverseEntry(adminId: number, ledgerId: number, noteIn: string): Promise<ToolResult> {
  const row = await poolDb.one('SELECT * FROM honeycomb_ledger WHERE id = ?', [ledgerId]);
  if (!row) return { error: 'This entry no longer exists.' };
  const reason = phpStr(row.reason);
  if (!REVERSIBLE.includes(reason)) return { error: 'This entry can’t be reversed – remove unlocks with “Remove” or refund the purchase.' };
  const amount = intval(row.amount);
  if (amount === 0) return { error: 'There is nothing to reverse – the entry is 0.' };
  const uid = intval(row.user_id);
  const note = cleanText(noteIn, 150);
  const user = await poolDb.one('SELECT id, full_name, email FROM users WHERE id = ?', [uid]);
  if (!user) return { error: 'This user no longer exists.' };
  const out = await withAccount(uid, async (db) => {
    // Schon zurückgenommen? (vor der Prüfung des Kontostands – sonst käme beim zweiten Klick die falsche Meldung)
    if (await db.value("SELECT 1 FROM honeycomb_ledger WHERE user_id = ? AND reason = 'reversal' AND ref = ?", [uid, 'x' + ledgerId])) return { error: 'This entry was already reversed.' };
    const balance = await balanceIn(db, uid);
    if (balance - amount < 0) return { error: 'That would take the balance below 0 (current: ' + balance + ').' };
    const text = note !== '' ? note : 'Correction: ' + hcDescribe(row);
    if ((await credit(db, uid, -amount, 'reversal', 'x' + ledgerId, text, adminId)) === null) return { error: 'This entry was already reversed.' };
    await audit(db, adminId, 'reverse', uid, 'ledger:' + ledgerId, { ledger: ledgerId, amount: -amount });
    await notify(uid, 'honeycombs', (amount > 0 ? '−' + numberFormat(amount) : '+' + numberFormat(-amount)) + ' honeycombs (correction by the team)', text, '/dashboard#honeycombs', { db });
    return { ok: 'Reversed: ' + (amount > 0 ? '−' : '+') + numberFormat(Math.abs(amount)) + ' honeycombs for ' + nameOf(user) + '. New balance: ' + numberFormat(balance - amount) + '.' };
  });
  return busy(out) ? { error: HC_BUSY_TEXT } : out;
}

// Schon zurückgenommene Buchungen (für die Knöpfe in den Listen)
export async function reversedIds(ids: readonly number[], db: Db = poolDb): Promise<Set<number>> {
  if (!ids.length) return new Set();
  const rows = await db.q(`SELECT ref FROM honeycomb_ledger WHERE reason = 'reversal' AND ref IN (${ids.map(() => '?').join(', ')})`, ids.map((id) => 'x' + id));
  return new Set(rows.map((r) => intval(phpStr(r.ref).slice(1))));
}

// ---------------------------------------------------------------- Freeze

export async function setFrozen(adminId: number, uid: number, frozen: boolean, reasonIn: string): Promise<ToolResult> {
  const user = await poolDb.one('SELECT id, full_name, email FROM users WHERE id = ?', [uid]);
  if (!user) return { error: 'Please choose a user.' };
  const reason = cleanText(reasonIn, 200);
  if (frozen && reason === '') return { error: 'Please give a reason – the user sees it.' };
  const out = await withAccount(uid, async (db, acc) => {
    if ((acc.frozen_at !== null) === frozen) return { ok: nameOf(user) + (frozen ? '’s honeycombs are already on hold.' : '’s honeycombs aren’t on hold.') };
    const now = nowStr();
    await db.exec('UPDATE hc_accounts SET frozen_at = ?, frozen_reason = ?, updated_at = ? WHERE user_id = ?', [frozen ? now : null, frozen ? reason : null, now, uid]);
    await audit(db, adminId, frozen ? 'freeze' : 'unfreeze', uid, '', {});
    await notify(uid, 'honeycombs', frozen ? 'Your honeycombs are on hold' : 'Your honeycombs work again',
      frozen ? reason.replace(/[.!?]*$/, (m) => m || '.') + ' Earning and buying are paused – your unlocks keep working.' : 'You can earn and buy again.', '/dashboard#honeycombs', { db });
    return { ok: nameOf(user) + (frozen ? '’s honeycombs are on hold now.' : '’s honeycombs work again.') };
  });
  return busy(out) ? { error: HC_BUSY_TEXT } : out;
}

// ---------------------------------------------------------------- Mehrere Nutzer

export const BULK_MAX = 200;
export const BULK_VALID_SEC = 15 * 60;

export interface BulkEntry { uid: number; name: string; email: string; balance: number; belowZero: boolean }
export interface BulkPreview { ref: string; amount: number; note: string; at: number; ids: number[] }
export interface BulkList { found: BulkEntry[]; unclear: string[]; missing: string[] }

// Liste lesen: je Eintrag eine E-Mail (mit @ nach dem ersten Zeichen), #<id> oder @<name> (Benutzername oder Seitenadresse)
export async function resolveUserList(text: string, amount: number): Promise<BulkList | { error: string }> {
  const entries = text.split(/[\n,]/).map((x) => x.trim()).filter((x) => x !== '');
  if (!entries.length) return { error: 'Please enter at least one user.' };
  if (entries.length > BULK_MAX) return { error: 'Up to ' + BULK_MAX + ' users at once.' };
  const unclear: string[] = [];
  const missing: string[] = [];
  const ids: number[] = [];
  for (const raw of entries) {
    const item = raw.slice(0, 190);
    let row: Row | null = null;
    if (/^#[1-9][0-9]{0,9}$/.test(item)) row = await poolDb.one('SELECT id FROM users WHERE id = ?', [Number(item.slice(1))]);
    else if (/^@[^\s@]{1,100}$/.test(item)) {
      const name = item.slice(1).toLowerCase();
      row = await poolDb.one('SELECT id FROM users WHERE LOWER(username) = ? LIMIT 1', [name])
        ?? await poolDb.one('SELECT user_id AS id FROM pages WHERE slug = ? LIMIT 1', [name]);
    } else if (item.indexOf('@') > 0 && !/\s/.test(item)) row = await poolDb.one('SELECT id FROM users WHERE LOWER(email) = ? LIMIT 1', [item.toLowerCase()]);
    else {
      unclear.push(item);
      continue;
    }
    if (!row) missing.push(item);
    else if (!ids.includes(intval(row.id))) ids.push(intval(row.id));
  }
  const found: BulkEntry[] = [];
  for (const uid of ids) {
    const u = await poolDb.one('SELECT id, full_name, email FROM users WHERE id = ?', [uid]);
    if (!u) continue;
    const balance = await balanceIn(poolDb, uid);
    found.push({ uid, name: nameOf(u), email: phpStr(u.email), balance, belowZero: balance + amount < 0 });
  }
  return { found, unclear, missing };
}

// Buchen: je Konto einmal mit demselben Formularschlüssel (ein zweites Absenden bucht nichts)
export async function bookBulk(adminId: number, p: BulkPreview, nowSec: number): Promise<ToolResult> {
  if (nowSec - p.at > BULK_VALID_SEC) return { error: 'The checked list is older than 15 minutes – please check it again.' };
  const ref = 'a' + adminId + '-' + p.ref;
  let booked = 0;
  const skipped: string[] = [];
  let twice = 0;
  for (const uid of p.ids) {
    const u = await poolDb.one('SELECT id, full_name, email FROM users WHERE id = ?', [uid]);
    if (!u) continue;
    const out = await withAccount(uid, async (db) => {
      if (p.amount < 0 && (await balanceIn(db, uid)) + p.amount < 0) return 'below' as const;
      if ((await credit(db, uid, p.amount, 'admin', ref, p.note, adminId)) === null) return 'twice' as const;
      await audit(db, adminId, 'grant', uid, '', { amount: p.amount, bulk: p.ids.length });
      await notify(uid, 'honeycombs', p.amount > 0 ? '+' + p.amount + ' honeycombs from the team' : '−' + -p.amount + ' honeycombs (correction by the team)', p.note, '/dashboard#honeycombs', { db });
      return 'booked' as const;
    });
    if (out === 'booked') booked++;
    else if (out === 'twice') twice++;
    else skipped.push(phpStr(u.email) + (busy(out) ? ' (busy – check only this one again)' : ' (would go below 0)'));
  }
  if (booked === 0 && twice > 0 && !skipped.length) return { error: 'This was already booked – the form was sent twice.' };
  const sign = p.amount > 0 ? '+' : '−';
  return { ok: sign + numberFormat(Math.abs(p.amount)) + ' honeycombs for ' + booked + ' user' + (booked === 1 ? '' : 's') + '.' + (skipped.length ? ' Skipped: ' + skipped.join(', ') + '.' : '') };
}
