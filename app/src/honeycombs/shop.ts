// Kaufen und Erstatten. buy() ist der EINZIGE Weg, Honigwaben auszugeben – im Shop, im Code-Tab, für Statusseiten.
// Ablauf: Anfrage-ID und Admin-Modus prüfen, dann unter der Kontosperre (eine Transaktion): Wiederholung erkennen,
// Sperre durch das Team, Mindestalter, Regeln der Funktion, Preis (mit Angebot) gegen den erwarteten Preis, Kontostand,
// Angebot zählen, Buchung, Kauf, Berechtigung. Nach dem Commit laufen die schnellen Abgleiche.
//
// Vertrag der Kauf-Routen (ROADMAP §3.2): request_id (32 hex, vom Browser beim Öffnen des Dialogs erzeugt) und
// expected_price; ohne request_id → 409 mit reload; Admin-Modus → 403; anderer Preis → 200 mit code 'price_changed'.
import { laterLots, queueEndedMail } from './outbox.js';
import type { Ctx } from '../web/ctx.js';
import type { Db, Row } from '../db.js';
import { intval, mbSubstr, phpStr, phpTruthy } from '../php.js';
import { notify } from '../notify/notify.js';
import { notice, type Notice } from '../notify/types.js';
import { poolDb } from './util.js';
import { addDays, addSeconds, dayLabel, nowStr, toUnix } from './clock.js';
import { DEFAULT_MAX_AHEAD_DAYS, LIFECYCLE_READY, feature, featureReady, type Feature, type FeatureKind, type ItemRow } from './features.js';
import { BUSY, HC_BUSY_TEXT, balanceIn, credit, debit, pausePoint, withAccount, type AccountRow } from './ledger.js';
import { entitlement, grantUnlock, has, isActive, setPeriod, type EntRow, type Entitlement } from './entitlements.js';
import { markReconcile, reconcileNow } from './reconcile.js';
import { buyerInfo, ensureCatalogue, itemByKey, itemOpen, optionTitle, quote } from './catalogue.js';
import { audit } from './audit.js';

export type BuyVia = 'shop' | 'code' | 'status' | 'auto';
export const REQUEST_ID = /^[0-9a-f]{32}$/;

export interface PurchaseRow extends Row {
  id: number;
  user_id: number;
  request_id: string;
  item_key: string;
  feature: string;
  lot: number;
  units: number;
  days: number | null;
  list_price: number;
  price: number;
  offer_id: number | null;
  ledger_id: number;
  via: string;
  period_start: string | null;
  period_end: string | null;
  refunded_at: string | null;
}

export interface PurchaseOut {
  id: number;
  item: string;
  feature: string;
  title: string;
  price: number;
  listPrice: number;
  expiresAt: string | null;
  quantity: number;
}

export type BuyCode = 'bad_request' | 'admin_mode' | 'unavailable' | 'free' | 'busy' | 'request_used' | 'frozen' | 'too_new' | 'too_inactive'
  | 'included' | 'owned' | 'forever' | 'max' | 'too_far' | 'packs_full' | 'requires' | 'rule' | 'price_changed' | 'balance';

export type BuyResult =
  | { ok: true; replay: boolean; purchase: PurchaseOut; balance: number; entitlement: Entitlement; notices: Notice[] }
  | { ok: false; status: 200 | 400 | 403 | 409; code: BuyCode; error: string; price?: number };

export interface BuyOptions {
  via: BuyVia;
  mode?: 'stack' | 'extend'; // stapelbare Pakete: neues Paket oder das zuerst endende verlängern
  terms?: boolean; // Regeln im Kaufdialog angekreuzt
}

const fail = (status: 200 | 400 | 403 | 409, code: BuyCode, error: string, price?: number): BuyResult =>
  (price === undefined ? { ok: false, status, code, error } : { ok: false, status, code, error, price });

const UNAVAILABLE = 'This isn’t available right now.';

// Admin im Nutzer-Modus: darf sich umsehen, aber nichts ausgeben (der Admin-Bereich vergibt Honigwaben und Freischaltungen)
export function adminMode(ctx: Ctx | null): boolean {
  const original = ctx?.session?.get('original_admin_id');
  return original !== undefined && original !== null;
}

// „Needs your code page first.“ – Premium ist ein Name und bleibt groß
function needsText(key: string): string {
  const f = feature(key);
  if (!f) return 'Needs another unlock first.';
  return key === 'premium' ? 'Needs Premium first.' : 'Needs your ' + f.title.charAt(0).toLowerCase() + f.title.slice(1) + ' first.';
}

// ---------------------------------------------------------------- Pakete und Laufzeiten (rein, ohne Datenbank)

export interface LotState {
  lot: number;
  active: boolean;
  permanent: boolean;
  expiresAt: string | null;
}

// Welches Paket ein Kauf trifft. stack 1: immer Paket 0. Sonst 'stack' (Standard, solange eines frei ist): das
// kleinste freie; 'extend' (oder keins frei): das aktive, das zuerst endet. full: 'stack' verlangt, aber alle belegt.
export function pickLot(stack: number, lots: readonly LotState[], mode?: 'stack' | 'extend'): { lot: number } | { full: true } {
  if (stack <= 1) return { lot: 0 };
  const busy = new Set(lots.filter((l) => l.active).map((l) => l.lot));
  let free = -1;
  for (let i = 0; i < stack; i++) {
    if (!busy.has(i)) {
      free = i;
      break;
    }
  }
  if (mode === 'stack') return free >= 0 ? { lot: free } : { full: true };
  if (mode === 'extend' || free < 0) {
    const first = lots.filter((l) => l.active && !l.permanent && l.expiresAt !== null)
      .sort((a, b) => (a.expiresAt === b.expiresAt ? a.lot - b.lot : (a.expiresAt as string) < (b.expiresAt as string) ? -1 : 1))[0];
    if (first) return { lot: first.lot };
  }
  return { lot: free >= 0 ? free : 0 };
}

// Neuer Zeitraum: ab dem Ende des laufenden Pakets (sonst ab jetzt) um days Kalendertage
export function nextPeriod(current: LotState | null, days: number, now: string): { start: string; end: string } {
  const start = current && current.active && !current.permanent && current.expiresAt !== null && current.expiresAt > now ? current.expiresAt : now;
  return { start, end: addDays(start, days) };
}

// Was sich von einem Kauf erstatten lässt: dauerhaft und Anzahl → der Preis; Pässe → nur die unbenutzten
// (abgerundet); Zeiträume → der unbenutzte Teil (aufgerundet; vorbei → 0, noch nicht begonnen → alles)
export function refundableValue(p: { kind: FeatureKind; price: number; units: number; periodStart: string | null; periodEnd: string | null },
  quantityNow: number, now: string): { value: number; unusedSec: number; units: number } {
  const units = Math.min(p.units, Math.max(0, quantityNow));
  if (p.kind === 'timed') {
    if (p.periodStart === null || p.periodEnd === null) return { value: 0, unusedSec: 0, units: 0 };
    const start = toUnix(p.periodStart);
    const end = toUnix(p.periodEnd);
    const unusedSec = Math.max(0, end - Math.max(toUnix(now), start));
    const periodSec = end - start;
    return { value: periodSec > 0 ? Math.min(p.price, Math.ceil((p.price * unusedSec) / periodSec)) : 0, unusedSec, units: 0 };
  }
  if (p.kind === 'consumable') return { value: p.units > 0 ? Math.floor((p.price * units) / p.units) : 0, unusedSec: 0, units };
  if (p.kind === 'count') return { value: p.price, unusedSec: 0, units };
  return { value: p.price, unusedSec: 0, units: 0 };
}

// ---------------------------------------------------------------- Kaufen

export async function buy(ctx: Ctx | null, uid: number, itemKey: string, requestId: string, expectedPrice: number | null | undefined,
  opts: BuyOptions): Promise<BuyResult> {
  // Automatische Verlängerung kommt erst mit HC-7c; bis dahin nimmt buy() nur Anfragen aus dem Browser an
  if (opts.via === 'auto' || !REQUEST_ID.test(requestId)) return fail(400, 'bad_request', 'Not all of the data arrived. Please try again.');
  if (adminMode(ctx)) return fail(403, 'admin_mode', 'Buying is turned off in admin mode.');
  if (expectedPrice !== null && expectedPrice !== undefined && (!Number.isSafeInteger(expectedPrice) || expectedPrice < 0)) {
    return fail(400, 'bad_request', 'Not all of the data arrived. Please try again.');
  }
  await ensureCatalogue();
  // Vorprüfung ohne Sperre (unter der Sperre wird alles noch einmal gelesen)
  const now = nowStr();
  const pre = await itemByKey(itemKey);
  const f = pre ? feature(pre.feature) : null;
  if (!pre || !f || !featureReady(f) || !itemOpen(pre, now) || (f.kind === 'timed' && !LIFECYCLE_READY)) return fail(200, 'unavailable', UNAVAILABLE);
  if (f.freeAtZero && intval(pre.price) === 0) return fail(200, 'free', 'Nothing to unlock – this is free right now.');

  const out = await withAccount(uid, (db, acc) => buyLocked(db, acc, uid, itemKey, f, requestId, expectedPrice ?? null, opts));
  if (out === BUSY) return fail(200, 'busy', HC_BUSY_TEXT);
  if (out.ok && !out.replay) await reconcileNow(uid, { inlineOnly: true });
  return out;
}

async function buyLocked(db: Db, acc: AccountRow, uid: number, itemKey: string, f: Feature, requestId: string,
  expectedPrice: number | null, opts: BuyOptions): Promise<BuyResult> {
  const now = nowStr();
  // 1. Wiederholung (Doppelklick, erneutes Senden): derselbe Kauf zählt als Erfolg, ohne zweite Abbuchung
  const prev = await db.one<PurchaseRow>('SELECT * FROM hc_purchases WHERE user_id = ? AND request_id = ?', [uid, requestId]);
  if (prev) {
    if (prev.item_key !== itemKey || prev.refunded_at !== null) {
      return fail(409, 'request_used', 'This request was already used. Please reload and try again.');
    }
    return success(db, uid, f, prev, true, []);
  }
  // 2. Vom Team angehalten
  if (acc.frozen_at !== null) return fail(200, 'frozen', 'Your honeycombs are on hold. Please contact the team.');
  const item = await db.one<ItemRow>('SELECT * FROM hc_items WHERE item_key = ?', [itemKey]);
  const user = await db.one('SELECT * FROM users WHERE id = ?', [uid]);
  if (!item || !user || item.feature !== f.key || !itemOpen(item, now)) return fail(200, 'unavailable', UNAVAILABLE);
  // Für das Konto ohnehin dabei (z. B. Premium für Admins) – vor Alter und aktiven Tagen, die dann nichts mehr ändern
  if (f.includedFor?.(user)) {
    return fail(200, 'included', f.key === 'premium' ? 'Premium is included with your admin account.' : 'This is included with your account.');
  }
  // 3. Mindestalter und aktive Tage
  const buyer = await buyerInfo(db, uid, user, now);
  const minDays = Math.max(intval(item.min_account_days), f.minAccountDaysFloor ?? 0);
  if (buyer.accountDays < minDays) return fail(200, 'too_new', 'This is available once your account is ' + minDays + ' days old.');
  if (buyer.activeDays < intval(item.min_active_days)) {
    return fail(200, 'too_inactive', 'This is available once you’ve been active on ' + intval(item.min_active_days) + ' days.');
  }
  // 4. Pakete der Funktion (gesperrt bis zum Ende der Transaktion)
  const lots = await db.q<EntRow>('SELECT * FROM hc_entitlements WHERE user_id = ? AND feature = ? ORDER BY lot FOR UPDATE', [uid, f.key]);
  const state: LotState[] = lots.map((l) => ({ lot: intval(l.lot), active: isActive(l, now), permanent: phpTruthy(l.permanent), expiresAt: l.expires_at }));
  // 6. Regeln der Funktion
  if (f.kind === 'permanent' && (await has(uid, f.key, db))) return fail(200, 'owned', 'You already own this.');
  let lotNo = 0;
  let period: { start: string; end: string } | null = null;
  if (f.kind === 'timed') {
    if (state.some((l) => l.active && l.permanent)) {
      return fail(200, 'forever', f.key === 'premium' ? 'You have Premium for good – no need to buy it.' : 'You have this for good – no need to buy it.');
    }
    const stack = f.stack ?? 1;
    const pick = pickLot(stack, state, opts.mode);
    if ('full' in pick) return fail(200, 'packs_full', 'You already have ' + stack + ' packs – you can extend one instead.');
    lotNo = pick.lot;
    const current = state.find((l) => l.lot === lotNo) ?? null;
    period = nextPeriod(current, intval(item.days), now);
    if (toUnix(period.end) - toUnix(now) > (f.maxAheadDays ?? DEFAULT_MAX_AHEAD_DAYS) * 86400) {
      return fail(200, 'too_far', 'You already have ' + f.title + ' until ' + dayLabel(period.start) + '. You can extend it again later.');
    }
  }
  if ((f.kind === 'count' || f.kind === 'consumable') && f.max !== undefined) {
    const have = state.filter((l) => l.active).reduce((n, l) => n + intval(lots.find((x) => intval(x.lot) === l.lot)?.quantity), 0);
    if (have + intval(item.units) > f.max) return fail(200, 'max', 'You already have the maximum (' + f.max + ').');
  }
  if (f.requires !== undefined && !(await has(uid, f.requires, db))) return fail(200, 'requires', needsText(f.requires));
  if (f.canBuy) {
    const err = await f.canBuy({ uid, user, db, item, input: { terms: opts.terms === true } });
    if (err !== null) return fail(200, 'rule', err);
  }
  // 7. Preis jetzt (mit Angebot) gegen den Preis, den der Nutzer gesehen hat
  let q = await quote(db, item, buyer, now);
  if (expectedPrice !== null && expectedPrice !== q.price) {
    return fail(200, 'price_changed', 'The price changed – this now costs ' + q.price + ' honeycombs.', q.price);
  }
  // 8. Kontostand (unter der Sperre: verlässlich)
  const balance = await balanceIn(db, uid);
  if (balance < q.price) return fail(200, 'balance', 'You need ' + q.price + ' honeycombs – you have ' + balance + '.');
  // 9. Angebot zählen – nur, solange es noch gilt (sonst neuer Preis)
  if (q.offer) {
    const used = await db.exec(`UPDATE hc_offers SET uses = uses + 1 WHERE id = ? AND cancelled_at IS NULL AND starts_at <= ? AND ends_at > ?
        AND (max_uses IS NULL OR uses < max_uses)`, [intval(q.offer.id), now, now]);
    if (used.affectedRows === 0) {
      q = await quote(db, item, buyer, now);
      return fail(200, 'price_changed', 'The price changed – this now costs ' + q.price + ' honeycombs.', q.price);
    }
  }
  await pausePoint('before-debit', { uid, requestId });
  // 10.–13. Buchung, Kauf, Berechtigung (alles in dieser Transaktion)
  const title = optionTitle(f, item);
  let ledgerId: number;
  if (f.kind === 'permanent') {
    const g = await grantUnlock(db, uid, f.key, -q.price, title, null, 'purchase');
    if (!g) throw new Error(`unlock of ${f.key} for #${uid} was not booked`);
    ledgerId = g.ledgerId;
  } else {
    const id = await debit(db, uid, q.price, 'purchase', requestId, title);
    if (id === null) throw new Error(`purchase ${requestId} of #${uid} was booked twice`);
    ledgerId = id;
  }
  const res = await db.exec(`INSERT INTO hc_purchases (user_id, request_id, item_key, feature, lot, units, days, list_price, price, offer_id, ledger_id, via,
      period_start, period_end, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [uid, requestId, item.item_key, f.key, lotNo, intval(item.units), item.days === null ? null : intval(item.days), q.listPrice, q.price,
    q.offer ? intval(q.offer.id) : null, ledgerId, opts.via, period?.start ?? null, period?.end ?? null, now]);
  await pausePoint('after-purchase-insert', { uid, requestId });
  if (f.kind === 'timed' && period) {
    await setPeriod(db, uid, f.key, lotNo, { quantity: 1, permanent: false, expiresAt: period.end, source: 'purchase', note: '', grantedBy: null }, now);
  } else if (f.kind === 'count' || f.kind === 'consumable') {
    const cur = lots.find((l) => intval(l.lot) === lotNo);
    const base = cur && isActive(cur, now) ? intval(cur.quantity) : 0;
    await setPeriod(db, uid, f.key, lotNo, { quantity: base + intval(item.units), permanent: true, expiresAt: null, source: 'purchase', note: '', grantedBy: null }, now);
  }
  await markReconcile(db, uid, now);
  const row = await db.one<PurchaseRow>('SELECT * FROM hc_purchases WHERE id = ?', [res.insertId]);
  const text = f.kind === 'permanent' ? f.title + ' unlocked'
    : f.kind === 'timed' && period ? title + ' – until ' + dayLabel(period.end) : title;
  const n = notice({ tone: 'hc', amount: -q.price, text });
  return success(db, uid, f, row as PurchaseRow, false, n ? [n] : []);
}

async function success(db: Db, uid: number, f: Feature, p: PurchaseRow, replay: boolean, notices: Notice[]): Promise<BuyResult> {
  const ent = await entitlement(uid, f.key, db);
  return {
    ok: true,
    replay,
    purchase: {
      id: intval(p.id), item: p.item_key, feature: p.feature, title: optionTitle(f, p), price: intval(p.price), listPrice: intval(p.list_price),
      expiresAt: p.period_end, quantity: ent.quantity,
    },
    balance: await balanceIn(db, uid),
    entitlement: ent,
    notices,
  };
}

// Dauerhafte Freischaltung mit Text-Antwort (heutige hcSpend-Semantik): null = erledigt (auch: schon freigeschaltet),
// sonst ein Fehlertext für die Oberfläche
export async function purchaseUnlock(ctx: Ctx | null, uid: number, featureKey: string,
  o: { requestId: string; expectedPrice: number; terms?: boolean; via: 'code' | 'status' | 'shop' }): Promise<string | null> {
  const r = await buy(ctx, uid, featureKey, o.requestId, o.expectedPrice, { via: o.via, terms: o.terms });
  if (r.ok || r.code === 'owned') return null;
  return r.error;
}

// ---------------------------------------------------------------- Erstatten (nur das Team)

// amount: null = der erstattbare Wert; remove: auch wegnehmen, was gekauft wurde (Admin entscheidet ausdrücklich)

export async function refund(adminId: number, purchaseId: number, amount: number | null, remove: boolean, note = ''): Promise<{ ok: string } | { error: string }> {
  const head = await poolDb.one('SELECT user_id FROM hc_purchases WHERE id = ?', [purchaseId]);
  if (!head) return { error: 'Purchase not found.' };
  const uid = intval(head.user_id);
  const out = await withAccount(uid, async (db): Promise<{ ok: string } | { error: string }> => {
    const p = await db.one<PurchaseRow>('SELECT * FROM hc_purchases WHERE id = ? FOR UPDATE', [purchaseId]);
    if (!p) return { error: 'Purchase not found.' };
    if (p.refunded_at !== null) return { error: 'This purchase was already refunded.' };
    const now = nowStr();
    const f = feature(p.feature);
    // Eine Funktion, die es im Code nicht mehr gibt: Art aus dem Kauf ableiten
    const kind: FeatureKind = f?.kind ?? (p.days !== null ? 'timed' : 'permanent');
    const title = f ? optionTitle(f, p) : p.item_key;
    const lot = await db.one<EntRow>('SELECT * FROM hc_entitlements WHERE user_id = ? AND feature = ? AND lot = ? FOR UPDATE', [uid, p.feature, intval(p.lot)]);
    const quantityNow = lot && isActive(lot, now) ? intval(lot.quantity) : 0;
    const r = refundableValue({ kind, price: intval(p.price), units: intval(p.units), periodStart: p.period_start, periodEnd: p.period_end }, quantityNow, now);
    const give = amount ?? r.value;
    if (!Number.isSafeInteger(give) || give < 0 || give > r.value) return { error: 'Refund at most ' + r.value + ' honeycombs (the unused part).' };
    // Die Buchung refund/p<id> ist zugleich der Schutz gegen eine zweite Erstattung (auch bei 0)
    const booked = await credit(db, uid, give, 'refund', 'p' + intval(p.id), note !== '' ? note : 'Refund: ' + title, adminId);
    if (booked === null) return { error: 'This purchase was already refunded.' };
    let cut = 0;
    let units = 0;
    let after = '';
    const name = f ? f.title.charAt(0).toLowerCase() + f.title.slice(1) : p.item_key;
    if (kind === 'permanent') {
      if (remove) {
        await setPeriod(db, uid, p.feature, intval(p.lot), { quantity: 0, permanent: false, expiresAt: null, expiryDoneAt: now }, now);
        after = ' The ' + name + ' is locked again.';
      } else {
        after = ' The ' + name + ' stays unlocked.';
      }
    } else if (kind === 'timed') {
      if (remove && r.unusedSec > 0 && lot && lot.expires_at !== null && !phpTruthy(lot.permanent)) {
        cut = r.unusedSec;
        const shortened = addSeconds(lot.expires_at, -cut);
        const end = shortened > now ? shortened : now;
        await setPeriod(db, uid, p.feature, intval(p.lot), { quantity: intval(lot.quantity), permanent: false, expiresAt: end,
          ...(end > now ? {} : { expiryDoneAt: now }) }, now);
        // Spätere Zeiträume desselben Pakets rücken um cut nach vorn – sie beschreiben weiter die Wahrheit
        await db.exec(`UPDATE hc_purchases SET period_start = period_start - INTERVAL ? SECOND, period_end = period_end - INTERVAL ? SECOND
            WHERE user_id = ? AND feature = ? AND lot = ? AND period_start >= ? AND id <> ? AND refunded_at IS NULL`,
        [cut, cut, uid, p.feature, intval(p.lot), p.period_end, intval(p.id)]);
        after = end > now ? ' ' + title + ' now ends on ' + dayLabel(end) + '.' : ' ' + title + ' has ended.';
        // Durch die Erstattung beendet: dieselbe Mail wie beim Ablauf (wenn kein anderes Paket weiterläuft)
        if (end <= now && (await laterLots(db, uid, p.feature, intval(p.lot), now, now, true)) === 0) await queueEndedMail(db, uid, intval(lot.id), p.feature, now);
      }
    } else if (remove && r.units > 0) {
      units = r.units;
      // IF statt quantity − ?: auf UNSIGNED bricht MariaDB sonst mit Fehler 1690 ab, bevor GREATEST greifen könnte
      await db.exec('UPDATE hc_entitlements SET quantity = IF(quantity > ?, quantity - ?, 0), updated_at = ? WHERE user_id = ? AND feature = ? AND lot = ?',
        [units, units, now, uid, p.feature, intval(p.lot)]);
      after = ' ' + units + ' taken back.';
    }
    await db.exec('UPDATE hc_purchases SET refunded_at = ?, refund_amount = ?, refund_units = ?, refund_cut_sec = ?, refund_removed = ?, refunded_by = ? WHERE id = ?',
      [now, give, units, cut, remove ? 1 : 0, adminId, intval(p.id)]);
    await audit(db, adminId, 'refund', uid, 'p' + intval(p.id), { purchase: intval(p.id), amount: give, removed: remove });
    await markReconcile(db, uid, now);
    // Glocke in derselben Transaktion wie die Buchung: genau einmal
    await notify(uid, 'honeycombs', mbSubstr(title + ' was refunded: +' + give + ' honeycombs.', 0, 190), after.trim(), '/dashboard#honeycombs/' + p.feature, { db });
    const user = await db.one('SELECT full_name, email FROM users WHERE id = ?', [uid]);
    const who = user ? (phpStr(user.full_name ?? '') !== '' ? phpStr(user.full_name) : phpStr(user.email)) : '#' + uid;
    return { ok: 'Refunded ' + give + ' honeycombs to ' + who + '.' + after };
  });
  if (out === BUSY) return { error: HC_BUSY_TEXT };
  if ('ok' in out) await reconcileNow(uid, { inlineOnly: true });
  return out;
}
