// Event-Codes (honeycomb-shop §4.8, HC-9): das Team legt Codes an (Betrag, Zeitraum, höchstens so oft, Mindestalter
// des Kontos), Nutzer lösen sie im Bereich „Honeycombs“ ein. Je Konto und Code einmal (Buchung code/c<id>), höchstens
// max_uses-mal insgesamt (Zähler unter der Kontosperre, ohne Platz → nichts gebucht). Codes zählen nicht zum
// Tageslimit. Falsche Codes zählen als Fehlversuch: je Konto 5 je Adresse und 50 insgesamt in 15 Minuten (§4.8).
import { randomBytes } from 'node:crypto';
import type { Ctx } from '../web/ctx.js';
import type { Row } from '../db.js';
import { intval, numberFormat, phpStr } from '../php.js';
import { cleanText } from '../helpers.js';
import { attemptFailed, attemptsAllowed } from '../web/security.js';
import { addDays, nowStr } from './clock.js';
import { BUSY, HC_BUSY_TEXT, balanceIn, credit, withAccount } from './ledger.js';
import { audit } from './audit.js';
import { formDateTime } from './offers.js';
import { poolDb } from './util.js';

export const CODE_PATTERN = /^[A-Z0-9-]{4,32}$/;
const AUTO_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne 0/O und 1/I
export const CODE_MAX_AMOUNT = 10000;
export const REDEEM_RATE = { perClient: 5, total: 50, windowSec: 900 } as const;

// Eingabe wie geschrieben → Code: ohne Leerzeichen, Großbuchstaben (nur ASCII)
export function normalizeCode(v: unknown): string {
  // Auch unsichtbare Zeichen, die beim Kopieren aus Chats mitkommen (Nullbreite, BOM)
  return typeof v === 'string' ? v.replace(/[\s\u200b-\u200d\u2060\ufeff]+/g, '').replace(/[a-z]/g, (c) => c.toUpperCase()).slice(0, 40) : '';
}

export interface CodeRow extends Row {
  id: number; code: string; amount: number; note: string; starts_at: string | null; ends_at: string | null;
  max_uses: number | null; uses: number; min_account_days: number; disabled_at: string | null; created_by: number; created_at: string;
}

// Gilt der Code gerade? (Zeitraum, nicht abgeschaltet)
export function codeOpen(c: CodeRow, now: string): boolean {
  if (c.disabled_at !== null) return false;
  if (c.starts_at !== null && phpStr(c.starts_at) > now) return false;
  if (c.ends_at !== null && phpStr(c.ends_at) <= now) return false;
  return true;
}

export type RedeemResult = { ok: true; amount: number; balance: number; text: string } | { ok: false; error: string };

class UsedUp extends Error {}

export async function redeemCode(ctx: Ctx, uid: number, input: unknown): Promise<RedeemResult> {
  const code = normalizeCode(input);
  if (code === '') return { ok: false, error: 'Please enter a code.' };
  const key = 'hcredeem:' + uid;
  if (!(await attemptsAllowed(ctx, key, REDEEM_RATE.perClient, REDEEM_RATE.total, REDEEM_RATE.windowSec))) return { ok: false, error: 'Too many tries. Please wait 15 minutes.' };
  const now = nowStr();
  const c = CODE_PATTERN.test(code) ? await poolDb.one<CodeRow>('SELECT * FROM hc_codes WHERE code = ?', [code]) : null;
  if (!c) {
    await attemptFailed(ctx, key, REDEEM_RATE.windowSec);
    return { ok: false, error: 'This code doesn’t exist or has expired.' };
  }
  if (!codeOpen(c, now)) return { ok: false, error: 'This code doesn’t exist or has expired.' };
  const user = await poolDb.one('SELECT created_at FROM users WHERE id = ?', [uid]);
  const minDays = intval(c.min_account_days);
  if (minDays > 0 && (!user || phpStr(user.created_at) > addDays(now, -minDays))) {
    return { ok: false, error: 'This code is for accounts that are at least ' + minDays + ' day' + (minDays === 1 ? '' : 's') + ' old.' };
  }
  // Ohne Notiz bleibt sie leer – der Verlauf zeigt dann „Code redeemed“ (hcDescribe)
  const note = phpStr(c.note);
  const text = note !== '' ? note : 'Code redeemed';
  try {
    const out = await withAccount(uid, async (db, acc) => {
      if (acc.frozen_at !== null) return { ok: false as const, error: 'Your honeycombs are on hold – redeeming is paused.' };
      if ((await credit(db, uid, intval(c.amount), 'code', 'c' + intval(c.id), note)) === null) return { ok: false as const, error: 'You’ve already used this code.' };
      const res = await db.exec('UPDATE hc_codes SET uses = uses + 1 WHERE id = ? AND disabled_at IS NULL AND (max_uses IS NULL OR uses < max_uses)', [intval(c.id)]);
      // Kein Platz mehr: die Buchung fällt mit der Transaktion weg
      if (res.affectedRows !== 1) throw new UsedUp();
      return { ok: true as const, amount: intval(c.amount), balance: await balanceIn(db, uid), text };
    });
    return out === BUSY ? { ok: false, error: HC_BUSY_TEXT } : out;
  } catch (err) {
    if (err instanceof UsedUp) return { ok: false, error: 'This code has been used up.' };
    throw err;
  }
}

// ---------------------------------------------------------------- Admin

export type CodeAdminResult = { ok: string } | { error: string };

export async function createCode(adminId: number, f: Record<string, string>): Promise<CodeAdminResult> {
  // Leer: ein zufälliger Code aus 10 Zeichen
  const typed = normalizeCode(f.code);
  const code = typed === '' ? autoCode() : typed;
  if (!CODE_PATTERN.test(code)) return { error: 'A code has 4–32 letters, digits or dashes.' };
  const amount = /^[0-9]{1,6}$/.test(f.amount.trim()) ? Number(f.amount.trim()) : NaN;
  if (!Number.isInteger(amount) || amount < 1 || amount > CODE_MAX_AMOUNT) return { error: 'The amount can be 1 to ' + numberFormat(CODE_MAX_AMOUNT) + ' honeycombs.' };
  const startsAt = f.starts_at.trim() === '' ? null : formDateTime(f.starts_at.trim());
  const endsAt = f.ends_at.trim() === '' ? null : formDateTime(f.ends_at.trim());
  if ((f.starts_at.trim() !== '' && startsAt === null) || (f.ends_at.trim() !== '' && endsAt === null)) return { error: 'Please enter the dates as date and time.' };
  if (startsAt !== null && endsAt !== null && endsAt <= startsAt) return { error: 'The end must be after the start.' };
  if (endsAt !== null && endsAt <= nowStr()) return { error: 'The end must be in the future.' };
  const maxUses = f.max_uses.trim() === '' ? null : /^[0-9]{1,7}$/.test(f.max_uses.trim()) ? Number(f.max_uses.trim()) : NaN;
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1)) return { error: 'Max. uses is empty (no limit) or at least 1.' };
  const minDays = f.min_account_days.trim() === '' ? 0 : /^[0-9]{1,4}$/.test(f.min_account_days.trim()) ? Number(f.min_account_days.trim()) : NaN;
  if (!Number.isInteger(minDays) || minDays < 0 || minDays > 3650) return { error: 'The minimum account age can be 0 to 3,650 days.' };
  const note = cleanText(f.note, 150);
  const now = nowStr();
  const res = await poolDb.exec(`INSERT IGNORE INTO hc_codes (code, amount, note, starts_at, ends_at, max_uses, uses, min_account_days, disabled_at, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?)`, [code, amount, note, startsAt, endsAt, maxUses, minDays, adminId, now]);
  if (res.affectedRows !== 1) return { error: 'This code already exists.' };
  await audit(poolDb, adminId, 'code_create', null, 'code:' + res.insertId, { code: res.insertId, amount, max_uses: maxUses ?? 0 });
  return { ok: 'Code ' + code + ' created.' };
}

export async function disableCode(adminId: number, id: number): Promise<CodeAdminResult> {
  const c = await poolDb.one<CodeRow>('SELECT * FROM hc_codes WHERE id = ?', [id]);
  if (!c) return { error: 'This code no longer exists.' };
  if (c.disabled_at !== null) return { ok: 'Code disabled.' };
  await poolDb.exec('UPDATE hc_codes SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL', [nowStr(), id]);
  await audit(poolDb, adminId, 'code_disable', null, 'code:' + id, { code: id });
  return { ok: 'Code disabled.' };
}

// Zufälliger Code (10 Zeichen, ohne leicht verwechselbare)
function autoCode(): string {
  const bytes = randomBytes(10);
  return [...bytes].map((b) => AUTO_LETTERS[b % AUTO_LETTERS.length]).join('');
}

export function codeStatus(c: CodeRow, now: string): 'running' | 'scheduled' | 'ended' | 'off' | 'used up' {
  if (c.disabled_at !== null) return 'off';
  if (c.max_uses !== null && intval(c.uses) >= intval(c.max_uses)) return 'used up';
  if (c.ends_at !== null && phpStr(c.ends_at) <= now) return 'ended';
  if (c.starts_at !== null && phpStr(c.starts_at) > now) return 'scheduled';
  return 'running';
}
