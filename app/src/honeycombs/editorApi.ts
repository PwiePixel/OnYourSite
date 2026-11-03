// Editor-API des Bereichs „Honeycombs“ (/dashboard/api/shop, shop-*, hc-*): Stand des Shops, Kaufen und der Verlauf.
// Läuft nach der gemeinsamen Vorprüfung der Editor-API (Login 401, CSRF 419 bei POST, JSON 400) und gehört zum Konto,
// nicht zu einer Profilseite. Geschäftliche Fehler und Ratenlimits antworten 200 mit {ok:false, error}; Protokollfehler
// mit Statuscodes. Kaufen folgt dem Vertrag der Kauf-Routen (ROADMAP §3.2): request_id (32 hex, im Browser beim Öffnen
// des Dialogs erzeugt) und expected_price; fehlen sie → 409 mit reload, Admin-Modus → 403, anderer Preis → 200 mit
// code 'price_changed'. Hinweise (notices) stehen oben in der Antwort; angezeigt werden sie nur vom Browser.
import { setMailReminders } from './outbox.js';
import { redeemCode } from './codes.js';
import type { Ctx } from '../web/ctx.js';
import type { Row } from '../db.js';
import { rateLimit } from '../web/security.js';
import { intval, phpTruthy } from '../php.js';
import { own, type PhpArr } from '../content/util.js';
import { FEATURE_KEY } from './features.js';
import { REQUEST_ID, adminMode, buy } from './shop.js';
import { historyPage, shopState } from './shopState.js';

const BAD_INPUT = { ok: false, error: 'Not all of the data arrived. Please try again.' };
const NOT_FOUND = { ok: false, error: 'Not found.' };
const RELOAD = { ok: false, error: 'OnYourSite was updated – please reload the editor.', reload: true };
export const BUY_RATE = { max: 20, windowSec: 600 };
export const HISTORY_RATE = { max: 120, windowSec: 60 };
export const SETTINGS_RATE = { max: 30, windowSec: 600 };

// Gehört die Aktion zu diesem Bereich?
export const isShopAction = (action: string): boolean => action === 'shop' || action.startsWith('shop-') || action.startsWith('hc-');

// Ganze Zahl ≥ 0 aus JSON (Zahl) oder Formular (nur Ziffern); sonst null
function wholeNumber(v: unknown, maxDigits = 7): number | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v === 'string' && new RegExp(`^[0-9]{1,${maxDigits}}$`).test(v)) return Number(v);
  return null;
}
const missing = (v: unknown): boolean => v === undefined || v === null || v === '';

// Alle Aktionen des Bereichs (enden immer hier)
export async function shopApi(ctx: Ctx, user: Row, action: string, isPost: boolean, input: PhpArr): Promise<never> {
  const userId = intval(user.id);
  const inp = (key: string): unknown => own(input, key);

  // Stand des Shops (jede Methode)
  if (action === 'shop') ctx.json({ ok: true, shop: await shopState(userId, adminMode(ctx)) });

  // Verlauf seitenweise (jede Methode): before = ID der ältesten schon gezeigten Buchung
  if (action === 'hc-history') {
    const raw = inp('before') ?? ctx.get.before;
    const before = missing(raw) ? null : wholeNumber(raw, 10);
    if (before === 0 || (!missing(raw) && before === null)) ctx.json(BAD_INPUT, 400);
    if (!(await rateLimit('hchist:' + userId, HISTORY_RATE.max, HISTORY_RATE.windowSec))) {
      ctx.json({ ok: false, error: 'Too many requests – please wait a moment.' });
    }
    ctx.json({ ok: true, ...(await historyPage(userId, before)) });
  }

  if (action === 'shop-buy') {
    if (!isPost) ctx.json(NOT_FOUND, 404);
    const item = inp('item');
    const requestId = inp('request_id');
    const expected = inp('expected_price');
    // Ein Editor von vor einem Update kennt den Vertrag nicht: neu laden statt raten
    if (missing(requestId) || missing(expected)) ctx.json(RELOAD, 409);
    const price = wholeNumber(expected);
    const modeIn = inp('mode');
    const mode = missing(modeIn) ? undefined : modeIn === 'stack' || modeIn === 'extend' ? modeIn : null;
    if (typeof item !== 'string' || !FEATURE_KEY.test(item) || typeof requestId !== 'string' || !REQUEST_ID.test(requestId) || price === null || mode === null) {
      ctx.json(BAD_INPUT, 400);
    }
    // Admin im Nutzer-Modus: vor dem Ratenlimit, damit nichts gezählt wird
    if (adminMode(ctx)) ctx.json({ ok: false, code: 'admin_mode', error: 'Buying is turned off in admin mode.' }, 403);
    if (!(await rateLimit('hcbuy:' + userId, BUY_RATE.max, BUY_RATE.windowSec))) {
      ctx.json({ ok: false, error: 'Too many purchases in a short time – please wait a moment.' });
    }
    const r = await buy(ctx, userId, item as string, requestId as string, price, { via: 'shop', mode: mode ?? undefined, terms: phpTruthy(inp('terms')) });
    if (!r.ok) ctx.json(r.price === undefined ? { ok: false, code: r.code, error: r.error } : { ok: false, code: r.code, price: r.price, error: r.error }, r.status);
    ctx.json({ ok: true, purchase: r.purchase, notices: r.notices, shop: await shopState(userId, false) });
  }

  // Schalter „Email me before an unlock ends“ (HC-7b)
  if (action === 'shop-reminders') {
    if (!isPost) ctx.json(NOT_FOUND, 404);
    const enabled = inp('enabled');
    if (typeof enabled !== 'boolean') ctx.json(BAD_INPUT, 400);
    if (adminMode(ctx)) ctx.json({ ok: false, code: 'admin_mode', error: 'Settings can’t be changed in admin mode.' }, 403);
    if (!(await rateLimit('hcset:' + userId, SETTINGS_RATE.max, SETTINGS_RATE.windowSec))) ctx.json({ ok: false, error: 'Too many changes – please wait a moment.' });
    await setMailReminders(userId, enabled as boolean);
    ctx.json({ ok: true });
  }

  // Event-Code einlösen (HC-9): Fehler mit 200 und Text, im Admin-Modus nie
  if (action === 'hc-redeem') {
    if (!isPost) ctx.json(NOT_FOUND, 404);
    const code = inp('code');
    if (typeof code !== 'string' || code.length > 40) ctx.json(BAD_INPUT, 400);
    if (adminMode(ctx)) ctx.json({ ok: false, code: 'admin_mode', error: 'Redeeming is turned off in admin mode.' }, 403);
    const r = await redeemCode(ctx, userId, code);
    if (!r.ok) ctx.json({ ok: false, error: r.error });
    ctx.json({ ok: true, amount: r.amount, balance: r.balance, notices: [{ tone: 'hc', amount: r.amount, text: r.text }] });
  }

  // Unbekannte Aktion des Bereichs (z. B. eine spätere in einem älteren Server)
  ctx.json(NOT_FOUND, 404);
}
