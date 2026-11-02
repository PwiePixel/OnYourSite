// Seitenplätze eines Kontos: jede Seite ist ein Platz, und ein Platz kann statt seiner Link-Seite eine Code-Seite zeigen
// (pages.code_site_id – die Link-Seite bleibt gespeichert). Alle Änderungen an den Plätzen, Code-Seiten und Adressen
// eines Kontos laufen nacheinander unter withSlotLock(uid): einer Zeilensperre auf users, auf EINER Verbindung.
// Andere Funktionen (eigene Domains, Statusseiten) nehmen dieselbe Sperre.
//
// REGEL: In fn nur über db abfragen (oder die Pool-Helfer, die innerhalb der Sperre dieselbe Verbindung benutzen) –
// nie eine zweite Verbindung verlangen. Wer eine Verbindung hält und auf eine zweite wartet, blockiert bei vielen
// gleichzeitigen Anfragen den ganzen Pool. Was nicht in die Transaktion gehört (Dateien aufräumen, Benutzername
// abgleichen, Zähler der Begrenzung, Sitzung), läuft erst nach dem Commit.
// Sperrreihenfolge überall: users → pages → code_sites → status_pages → site_addresses.
import type { Ctx } from '../web/ctx.js';
import { transaction, withConnection, type Db, type Row } from '../db.js';
import { config } from '../config.js';
import { intval } from '../php.js';
import { hasPremium } from '../app/context.js';

// Erfolgreiche Änderungen an den Plätzen: höchstens 20 je Stunde und Konto (abgelehnte Versuche zählen nicht)
export const SLOT_RATE_MAX = 20;
export const SLOT_RATE_WINDOW = 3600;
export const slotRateKey = (userId: number): string => 'slots:' + userId;

export const SLOT_RATE_TEXT = 'Too many changes in a short time – please wait a moment.';
export const SLOT_BUSY_TEXT = 'Your pages are busy right now – please try again in a moment.';
export const SLOT_GONE_TEXT = 'This page no longer exists, or you’re now logged in with a different account. Please reload the editor.';

// Die Sperre kam nicht innerhalb von 3 s (oder zweimal eine Verklemmung) – Antwort „busy“
export class SlotBusyError extends Error {}
// Das Konto gibt es nicht mehr (während der Anfrage gelöscht) – Antwort 409 mit reload
export class SlotGoneError extends Error {}

// Die gesperrte Zeile des Kontos: Bann, Regeln und Admin-Rechte werden immer hier gelesen, nie aus der Zeile vom
// Anfang der Anfrage – eine Sperre des Teams, die während der Anfrage kommt, gilt so sofort
export interface SlotUser extends Row {
  id: number;
  is_admin: unknown;
  code_banned_at: unknown;
  code_ban_reason: unknown;
  code_terms_at: unknown;
}

const errno = (err: unknown): number => Number((err as { errno?: unknown } | null)?.errno ?? 0);

// Alle Änderungen an Plätzen, Code-Seiten und Adressen eines Kontos – nacheinander, auch über mehrere Prozesse
export async function withSlotLock<T>(userId: number, fn: (db: Db, user: SlotUser) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withConnection(async (_db, conn) => {
        // Sperren höchstens 3 s abwarten (statt 50 s); vor der Rückgabe an den Pool zurücksetzen. Klappt das nicht,
        // ist die Verbindung kaputt – sie kommt dann nicht zurück in den Pool.
        await conn.query('SET SESSION innodb_lock_wait_timeout = 3');
        try {
          return await transaction(async (_c, db) => {
            const user = await db.one<SlotUser>('SELECT id, is_admin, code_banned_at, code_ban_reason, code_terms_at FROM users WHERE id = ? FOR UPDATE', [userId]);
            if (!user) throw new SlotGoneError(`account #${userId} no longer exists`);
            return fn(db, user);
          });
        } finally {
          await conn.query('SET SESSION innodb_lock_wait_timeout = DEFAULT').catch(() => conn.destroy());
        }
      });
    } catch (err) {
      // 1213 = Verklemmung (einmal wiederholen), 1205 = Sperre nicht frei geworden
      if (errno(err) === 1213 && attempt === 0) continue;
      if (errno(err) === 1205 || errno(err) === 1213) throw new SlotBusyError(`the pages of account #${userId} are busy`);
      throw err;
    }
  }
}

export interface PageAllowance {
  max: number;
  unlimited: boolean;
}

// Seitenplätze eines Kontos: max_pages für alle (Q1 = b: Premium ändert daran nichts), unbegrenzt nur für das Team
// (Admins und Admins im Nutzer-Modus). Innerhalb der Sperre mit db und der gesperrten Zeile aufrufen.
export async function pageAllowance(ctx: Ctx, user: Row, _db?: Db): Promise<PageAllowance> {
  return { max: intval(config('max_pages', 3)), unlimited: hasPremium(ctx, user) };
}

// „You can create up to N pages.“ (Text wie bisher)
export const pageLimitText = (max: number): string => `You can create up to ${max} ` + (max === 1 ? 'page.' : 'pages.');
