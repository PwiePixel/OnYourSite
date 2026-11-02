// Kontosperre und Buchungen. Ein Kontostand ist immer SUM(honeycomb_ledger.amount); das Buch wird nur ergänzt.
// Alles, was einen Kontostand senken oder den Besitz eines Kontos ändern kann, läuft in EINER Transaktion, die zuerst
// die Zeile des Kontos in hc_accounts sperrt (withAccount). Die Sperre liegt in der Datenbank und gilt damit für jeden
// Prozess (Webseite, Hintergrundjob). Es gibt keine zweite Sperrart (früher GET_LOCK('oys_hc_…')) daneben.
//
// Verbindungsregel: withAccount hält genau eine Verbindung. fn arbeitet nur über `db` und holt sich nie eine zweite
// aus dem Pool (sonst wartet die Anfrage unter Last auf sich selbst). Nichts in fn wirkt außerhalb der Datenbank –
// so darf fn nach einer Verklemmung (Deadlock) einmal neu laufen.
import { AsyncLocalStorage } from 'node:async_hooks';
import { transaction, withConnection, type Db, type Row } from '../db.js';
import { intval, mbSubstr } from '../php.js';
import { nowStr } from './clock.js';

export const HC_BUSY_TEXT = 'Honeycombs are busy right now – please try again in a moment.';

// Rückgabe von withAccount, wenn die Sperre nicht frei wurde (5 Sekunden, beim Verdienen sofort)
export const BUSY: unique symbol = Symbol('honeycombs-busy');
export type Busy = typeof BUSY;

export interface AccountRow extends Row {
  user_id: number;
  frozen_at: string | null;
  frozen_reason: string | null;
  reconcile_at: string | null;
  reconcile_gen: number;
  reconcile_tries: number;
  reconcile_error: string;
}

// ---------------------------------------------------------------- Haltepunkte für Tests

// Ohne Test-Gatter tut ein Haltepunkt nichts. Tests setzen ein Gatter, halten einen Ablauf an einer festen Stelle an
// (z. B. 'before-debit') und lassen ihn wieder los – so werden Wettläufe ohne Wiederholungsschleifen geprüft.
export type PauseGate = (name: string, info: Readonly<Record<string, unknown>>) => Promise<void> | void;
let gate: PauseGate | null = null;

export function setPauseGateForTests(g: PauseGate | null): void {
  gate = g;
}

export async function pausePoint(name: string, info: Readonly<Record<string, unknown>> = {}): Promise<void> {
  if (gate) await gate(name, info);
}

// ---------------------------------------------------------------- Kontosperre

// Welches Konto der laufende Ablauf gerade gesperrt hat (debit() prüft das; nie zwei Konten zugleich)
const account = new AsyncLocalStorage<{ uid: number }>();

export const lockedAccount = (): number | null => account.getStore()?.uid ?? null;

const errno = (err: unknown): number => Number((err as { errno?: unknown })?.errno ?? 0);

// Sperrt das Konto für eine Transaktion (READ COMMITTED: nach der Sperre sieht die Summe jede fertige Buchung).
// nowait: sofort aufgeben, wenn die Zeile gesperrt ist (Verdienen beim Öffnen des Editors). Eine Verklemmung wird
// genau einmal neu versucht. Eine Transaktion, die schon läuft, lässt sich nicht verschachteln (Fehler).
export async function withAccount<T>(uid: number, fn: (db: Db, acc: AccountRow) => Promise<T>, opts: { nowait?: boolean } = {}): Promise<T | Busy> {
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error(`withAccount: invalid user id ${uid}`);
  if (account.getStore()) throw new Error('withAccount: only one honeycomb account can be locked at a time');
  return withConnection(async (db, conn) => {
    // Zeile nur anlegen, wenn sie fehlt: INSERT IGNORE auf eine vorhandene, gesperrte Zeile würde für die Prüfung auf
    // Doppelte warten (innodb_lock_wait_timeout, 50 s) statt der 5 Sekunden unten. Lesen ohne Sperre wartet nie.
    if (!(await db.value('SELECT 1 FROM hc_accounts WHERE user_id = ?', [uid]))) {
      const now = nowStr();
      await db.exec('INSERT IGNORE INTO hc_accounts (user_id, created_at, updated_at) VALUES (?, ?, ?)', [uid, now, now]);
    }
    for (let attempt = 1; ; attempt++) {
      // Gilt nur für die nächste Transaktion – deshalb direkt davor
      await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      try {
        return await transaction(async (_conn, tdb) => {
          const acc = await tdb.one<AccountRow>(`SELECT * FROM hc_accounts WHERE user_id = ? FOR UPDATE ${opts.nowait ? 'NOWAIT' : 'WAIT 5'}`, [uid]);
          if (!acc) throw new Error(`honeycomb account ${uid} is missing`);
          await pausePoint('account-locked', { uid });
          return account.run({ uid }, () => fn(tdb, acc));
        });
      } catch (err) {
        // MariaDB meldet WAIT n und NOWAIT mit 1205, MySQL NOWAIT mit 3572
        if (errno(err) === 1205 || errno(err) === 3572) return BUSY;
        if (errno(err) === 1213 && attempt === 1) continue;
        throw err;
      }
    }
  });
}

// ---------------------------------------------------------------- Buchungen

// Bucht einen Betrag (INSERT IGNORE: Grund + Bezug sind je Konto eindeutig). Gibt die neue ID zurück – oder null, wenn
// es diese Buchung schon gibt. actorId: der Admin, der sie ausgelöst hat (sonst Nutzer oder System).
export async function credit(db: Db, uid: number, amount: number, reason: string, ref: string, note = '', actorId: number | null = null): Promise<number | null> {
  if (!Number.isSafeInteger(amount)) throw new Error(`invalid honeycomb amount: ${amount}`);
  const res = await db.exec('INSERT IGNORE INTO honeycomb_ledger (user_id, amount, reason, ref, note, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [uid, amount, reason, mbSubstr(ref, 0, 80), mbSubstr(note, 0, 200), actorId, nowStr()]);
  return res.affectedRows > 0 ? res.insertId : null;
}

// Abbuchung (price ≥ 0 wird als −price gebucht) – nur unter der Sperre genau dieses Kontos
export async function debit(db: Db, uid: number, price: number, reason: string, ref: string, note = '', actorId: number | null = null): Promise<number | null> {
  if (lockedAccount() !== uid) throw new Error('debit() needs the account lock of this user (withAccount)');
  return credit(db, uid, price === 0 ? 0 : -price, reason, ref, note, actorId);
}

// Kontostand (unter der Sperre: verlässlich bis zum Ende der Transaktion)
export async function balanceIn(db: Db, uid: number): Promise<number> {
  return intval(await db.value('SELECT COALESCE(SUM(amount), 0) FROM honeycomb_ledger WHERE user_id = ?', [uid]));
}
