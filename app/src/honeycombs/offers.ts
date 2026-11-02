// Rabattaktionen (hc_offers): ein Prozentsatz für alles, eine Funktion oder eine Option – oder ein fester Preis für eine
// Option –, mit Start und Ende, höchstens N Einlösungen insgesamt und je Konto, Mindestalter und aktive Tage. Käufe
// behalten den Preis, den sie bezahlt haben; erstattete Käufe zählen weiter für die Grenzen. Angebote werden nicht
// bearbeitet: absagen und ein neues anlegen.
import { transaction, type Db, type Row } from '../db.js';
import { intval, mbStrlen } from '../php.js';
import { cleanText } from '../helpers.js';
import { poolDb } from './util.js';
import { addDays, nowStr, toUnix } from './clock.js';
import { FEATURE_KEY, feature, features } from './features.js';
import { audit } from './audit.js';

export interface OfferRow extends Row {
  id: number;
  label: string;
  scope: string;
  percent_off: number | null;
  fixed_price: number | null;
  starts_at: string;
  ends_at: string;
  max_uses: number | null;
  uses: number;
  per_user_max: number | null;
  min_account_days: number;
  min_active_days: number;
  cancelled_at: string | null;
}

export const MAX_OPEN_OFFERS = 20;
export const MAX_OFFER_DAYS = 90;

// Je genauer der Geltungsbereich, desto mehr Vorrang bei gleichem Preis: Option > Funktion > alles
export function scopeRank(scope: string): number {
  return scope.startsWith('item:') ? 2 : scope.startsWith('feature:') ? 1 : 0;
}

// Preis mit einem Angebot: fester Preis oder Listenpreis minus Prozent, aufgerundet
export function offerPrice(list: number, o: Pick<OfferRow, 'percent_off' | 'fixed_price'>): number {
  if (o.fixed_price !== null && o.fixed_price !== undefined) return intval(o.fixed_price);
  return Math.ceil((list * (100 - intval(o.percent_off))) / 100);
}

// Das günstigste Angebot (bei Gleichstand: genauerer Bereich, dann die kleinste ID). Ist keins billiger als der
// Listenpreis, gilt der Listenpreis ohne Angebot.
export function bestOffer<T extends Pick<OfferRow, 'id' | 'scope' | 'percent_off' | 'fixed_price'>>(list: number, offers: readonly T[]): { price: number; offer: T | null } {
  let best: { price: number; offer: T } | null = null;
  for (const o of offers) {
    const price = offerPrice(list, o);
    if (best === null || price < best.price || (price === best.price && (scopeRank(o.scope) > scopeRank(best.offer.scope)
      || (scopeRank(o.scope) === scopeRank(best.offer.scope) && intval(o.id) < intval(best.offer.id))))) {
      best = { price, offer: o };
    }
  }
  return best !== null && best.price < list ? best : { price: list, offer: null };
}

// Laufende Angebote, die für diese Option gelten können (noch nicht je Konto geprüft)
export async function runningOffers(db: Db, itemKey: string, featureKey: string, now: string): Promise<OfferRow[]> {
  return db.q<OfferRow>(`SELECT * FROM hc_offers WHERE cancelled_at IS NULL AND starts_at <= ? AND ends_at > ? AND (max_uses IS NULL OR uses < max_uses)
      AND scope IN ('all', ?, ?) ORDER BY id`, [now, now, 'feature:' + featureKey, 'item:' + itemKey]);
}

// Zahl der Käufe eines Kontos mit einem Angebot – erstattete zählen mit (ein erstatteter Test-Kauf geht nicht noch einmal)
export async function offerUsesBy(db: Db, uid: number, offerId: number): Promise<number> {
  return intval(await db.value('SELECT COUNT(*) FROM hc_purchases WHERE user_id = ? AND offer_id = ?', [uid, offerId]));
}

// ---------------------------------------------------------------- Anlegen und Absagen (Admin)

export interface OfferInput {
  label: unknown;
  scope: unknown; // all | feature:<key> | item:<key>
  percentOff: unknown; // genau eins von beiden
  fixedPrice: unknown;
  startsAt: unknown; // YYYY-MM-DDTHH:MM (datetime-local) oder Y-m-d H:i:s
  endsAt: unknown;
  maxUses: unknown; // leer oder 1–1.000.000
  perUserMax: unknown; // leer oder 1–100
  minAccountDays: unknown;
  minActiveDays: unknown;
  formRef: unknown; // 16 hex, gegen doppeltes Absenden
}

export type AdminResult = { ok: string } | { error: string };

// Ganze Zahl aus einem Formularfeld (nur Ziffern); '' = leer (null); sonst undefined (ungültig)
function formInt(v: unknown, min: number, max: number): number | null | undefined {
  if (v === undefined || v === null || v === '') return null;
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '';
  if (!/^[0-9]{1,9}$/.test(s)) return undefined;
  const n = Number(s);
  return n >= min && n <= max ? n : undefined;
}

// Datum aus einem Formular als DATETIME-Text (Sekunden 00), sonst null
export function formDateTime(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v);
  if (!m) return null;
  const dt = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6] ?? '00'}`;
  try {
    // Ungültige Tage (31.02.) rollen in strtotime weiter – dann ist es kein gültiges Datum
    return nowStr(toUnix(dt)) === dt ? dt : null;
  } catch {
    return null;
  }
}

export async function createOffer(adminId: number, input: OfferInput): Promise<AdminResult> {
  const label = cleanText(input.label ?? '', 60);
  if (label === '' || mbStrlen(label) > 60) return { error: 'Please give the offer a name (up to 60 characters).' };
  const scope = typeof input.scope === 'string' ? input.scope : '';
  const formRef = typeof input.formRef === 'string' && /^[0-9a-f]{16}$/.test(input.formRef) ? input.formRef : null;
  if (formRef === null) return { error: 'The form is out of date. Please reload the page.' };
  let listPrice: number | null = null;
  let itemFeature: string | null = null;
  if (scope.startsWith('item:')) {
    const item = await poolDb.one('SELECT item_key, feature, price FROM hc_items WHERE item_key = ?', [scope.slice(5)]);
    if (!item || !feature(String(item.feature))) return { error: 'Please choose what the offer is for.' };
    listPrice = intval(item.price);
    itemFeature = String(item.feature);
  } else if (scope.startsWith('feature:')) {
    const key = scope.slice(8);
    if (!FEATURE_KEY.test(key) || !feature(key)) return { error: 'Please choose what the offer is for.' };
  } else if (scope !== 'all') {
    return { error: 'Please choose what the offer is for.' };
  }
  // Genau eins: Prozent (1–100) oder ein fester Preis (nur für eine Option, 0 bis zum Listenpreis)
  const percent = formInt(input.percentOff, 1, 100);
  const fixedGiven = !(input.fixedPrice === undefined || input.fixedPrice === null || input.fixedPrice === '');
  if (percent === undefined) return { error: 'Enter a discount between 1 and 100 %.' };
  if (percent !== null && fixedGiven) return { error: 'Enter either a discount or a fixed price, not both.' };
  if (percent === null && !fixedGiven) return { error: 'Enter a discount between 1 and 100 % or a fixed price.' };
  let fixed: number | null = null;
  if (fixedGiven) {
    if (listPrice === null) return { error: 'A fixed price is only possible for a single option.' };
    const f = formInt(input.fixedPrice, 0, listPrice);
    if (f === undefined || f === null) return { error: 'The fixed price can be 0 to ' + listPrice + ' (the list price).' };
    fixed = f;
  }
  const startsAt = formDateTime(input.startsAt);
  const endsAt = formDateTime(input.endsAt);
  const now = nowStr();
  if (startsAt === null || endsAt === null || !(startsAt < endsAt)) return { error: 'Please enter a start and an end after it.' };
  if (!(endsAt > now)) return { error: 'The end must be in the future.' };
  if (endsAt > addDays(startsAt, MAX_OFFER_DAYS)) return { error: 'An offer can run for up to ' + MAX_OFFER_DAYS + ' days.' };
  const maxUses = formInt(input.maxUses, 1, 1000000);
  const perUserMax = formInt(input.perUserMax, 1, 100);
  if (maxUses === undefined) return { error: 'Maximum uses: leave it empty or enter 1 to 1,000,000.' };
  if (perUserMax === undefined) return { error: 'Uses per account: leave it empty or enter 1 to 100.' };
  const minAccount = formInt(input.minAccountDays, 0, 3650) ?? 0;
  const minActive = formInt(input.minActiveDays, 0, 3650) ?? 0;
  if (formInt(input.minAccountDays, 0, 3650) === undefined || formInt(input.minActiveDays, 0, 3650) === undefined) {
    return { error: 'Minimum days: enter 0 to 3,650.' };
  }
  // Das Mindestalter der betroffenen Funktionen (Premium: 30 Tage) gilt auch für ihre Angebote
  const affected = scope === 'all' ? features().map((f) => f.key) : scope.startsWith('feature:') ? [scope.slice(8)] : [itemFeature as string];
  const floor = Math.max(0, ...affected.map((k) => feature(k)?.minAccountDaysFloor ?? 0));
  if (minAccount < floor) {
    return { error: affected.includes('premium') ? 'Offers that include Premium need accounts that are at least ' + floor + ' days old.'
      : 'This offer needs accounts that are at least ' + floor + ' days old.' };
  }

  return transaction(async (_conn, db) => {
    // Nicht mehr als 20 laufende oder geplante Angebote (unter Sperre gezählt)
    await db.q('SELECT id FROM hc_offers WHERE cancelled_at IS NULL AND ends_at > ? FOR UPDATE', [now]);
    const open = intval(await db.value('SELECT COUNT(*) FROM hc_offers WHERE cancelled_at IS NULL AND ends_at > ?', [now]));
    if (open >= MAX_OPEN_OFFERS) return { error: 'There are already ' + MAX_OPEN_OFFERS + ' active or upcoming offers.' };
    const res = await db.exec(`INSERT IGNORE INTO hc_offers (label, scope, percent_off, fixed_price, starts_at, ends_at, max_uses, uses, per_user_max,
        min_account_days, min_active_days, cancelled_at, form_ref, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, ?, ?, ?)`,
    [label, scope, percent, fixed, startsAt, endsAt, maxUses, perUserMax, minAccount, minActive, formRef, adminId, now]);
    if (res.affectedRows === 0) return { error: 'This offer was already created – the form was sent twice.' };
    await audit(db, adminId, 'offer_create', null, 'offer:' + res.insertId, { offer: res.insertId, percent, fixed });
    return { ok: 'Offer “' + label + '” created.' };
  });
}

export async function cancelOffer(adminId: number, offerId: number): Promise<AdminResult> {
  return transaction(async (_conn, db) => {
    const o = await db.one<OfferRow>('SELECT * FROM hc_offers WHERE id = ? FOR UPDATE', [offerId]);
    if (!o) return { error: 'Offer not found.' };
    if (o.cancelled_at === null) {
      await db.exec('UPDATE hc_offers SET cancelled_at = ? WHERE id = ?', [nowStr(), offerId]);
      await audit(db, adminId, 'offer_cancel', null, 'offer:' + offerId, { offer: offerId });
    }
    return { ok: 'Offer cancelled. Purchases made with it keep their price.' };
  });
}
