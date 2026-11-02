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
import { intval, phpStr, phpTruthy } from '../php.js';
import { isStaff } from '../app/context.js';
import { has } from '../honeycombs/entitlements.js';
import { shopPrice } from '../honeycombs/catalogue.js';
import { codeSettings } from './settings.js';

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
  return { max: intval(config('max_pages', 3)), unlimited: isStaff(ctx, user) };
}

// „You can create up to N pages.“ (Text wie bisher)
export const pageLimitText = (max: number): string => `You can create up to ${max} ` + (max === 1 ? 'page.' : 'pages.');

// ---- Regeln für Code-Seiten (E1–E8) ----

// Stand eines Kontos für die Regeln – innerhalb der Sperre gelesen (Bann, Pause und Zähler gelten so sofort)
export interface CodeQuota {
  unlocked: boolean; more: boolean; morePrice: number; banned: string | null; paused: boolean;
  own: number; onPages: number; total: number; maxOnPages: number;
  pagesUsed: number; pages: PageAllowance;
}
export interface CodeDenied { error: string; status: 200 | 403; need?: 'code_page' | 'code_more' }
// Ein Platz, auf den eine Code-Seite soll: hat er eine eigene Domain (in irgendeinem Zustand)? (E7)
export interface SlotTarget { hasDomain: boolean }

export const CODE_PAUSED_NEW_TEXT = 'New code pages are paused right now. Please try again later.';
export const CODE_PAUSED_MOVE_TEXT = 'Code pages can’t move to a new address right now. Please try again later.';
export const CODE_OWN_USED_TEXT = 'You already have a code page with its own address.';
export const CODE_DOMAIN_TEXT = 'Remove the custom domain of this page first – custom domains work for link pages only.';
export const CODE_UNLOCK_TEXT = 'Unlock code pages with honeycombs first.';
export const CODE_MORE_TEXT = 'Unlock more code pages with honeycombs first.';

export const codeBannedText = (reason: string): string =>
  'Code pages have been turned off for your account by the team' + (reason !== '' ? ': ' + reason : '.');

export function onPagesText(max: number): string {
  if (max <= 0) return 'Code pages can’t use your page addresses right now.';
  return max === 1 ? 'Only one of your pages can show a code page.' : `Up to ${max} of your pages can show a code page.`;
}

const deny = (error: string, status: 200 | 403 = 200, need?: 'code_page' | 'code_more'): CodeDenied =>
  need ? { error, status, need } : { error, status };

// Neue Code-Seite: an eigener Adresse (own), auf einem bestehenden Platz (page) oder auf einer neuen Seite (new-page).
// Die erste verletzte Regel gewinnt; E8 (Bezahlen) zuletzt, damit niemand für etwas zahlt, das eine andere Regel ablehnt.
export function canCreate(q: CodeQuota, target: 'own' | 'page' | 'new-page', slot?: SlotTarget): CodeDenied | null {
  if (q.banned !== null) return deny(codeBannedText(q.banned));
  if (!q.unlocked) return deny(CODE_UNLOCK_TEXT, 403, 'code_page');
  if (q.paused) return deny(CODE_PAUSED_NEW_TEXT);
  if (target === 'own' && q.own >= 1) return deny(CODE_OWN_USED_TEXT);
  if (target !== 'own' && q.onPages >= q.maxOnPages) return deny(onPagesText(q.maxOnPages));
  if (target === 'new-page' && !q.pages.unlimited && q.pagesUsed >= q.pages.max) return deny(pageLimitText(q.pages.max));
  if (target === 'page' && slot?.hasDomain) return deny(CODE_DOMAIN_TEXT);
  if (q.total >= 1 && q.morePrice > 0 && !q.more) return deny(CODE_MORE_TEXT, 403, 'code_more');
  return null;
}

// Bestehende Code-Seite umziehen: an eine eigene Adresse (own) oder auf einen Platz (page)
export function canMove(q: CodeQuota, to: 'own' | 'page', slot?: SlotTarget): CodeDenied | null {
  if (q.banned !== null) return deny(codeBannedText(q.banned));
  if (q.paused) return deny(CODE_PAUSED_MOVE_TEXT);
  if (to === 'own' && q.own >= 1) return deny(CODE_OWN_USED_TEXT);
  if (to === 'page' && q.onPages >= q.maxOnPages) return deny(onPagesText(q.maxOnPages));
  if (to === 'page' && slot?.hasDomain) return deny(CODE_DOMAIN_TEXT);
  return null;
}

// Stand für die Regeln lesen – nur über db (die Verbindung der Sperre), mit der gesperrten Zeile des Kontos
export async function codeQuota(user: SlotUser, ctx: Ctx, db: Db): Promise<CodeQuota> {
  const uid = intval(user.id);
  const settings = await codeSettings(db);
  const count = async (sql: string): Promise<number> => intval(await db.value(sql, [uid]));
  return {
    unlocked: await has(uid, 'code_page', db),
    more: await has(uid, 'code_more', db),
    morePrice: await shopPrice('code_more', uid, db),
    banned: phpTruthy(user.code_banned_at) ? phpStr(user.code_ban_reason ?? '') : null,
    paused: settings.paused,
    own: await count('SELECT COUNT(*) FROM code_sites WHERE user_id = ? AND slug IS NOT NULL'),
    onPages: await count('SELECT COUNT(*) FROM pages WHERE user_id = ? AND code_site_id IS NOT NULL'),
    total: await count('SELECT COUNT(*) FROM code_sites WHERE user_id = ?'),
    maxOnPages: settings.max_on_pages,
    pagesUsed: await count('SELECT COUNT(*) FROM pages WHERE user_id = ?'),
    pages: await pageAllowance(ctx, user, db),
  };
}
