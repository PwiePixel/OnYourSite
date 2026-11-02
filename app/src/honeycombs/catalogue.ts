// Katalog: Optionen mit Preisen (hc_items). Was eine Option bewirkt, steht im Code ihres Bereichs (features.ts); hier
// stehen nur Preis, Laufzeit/Menge, ob sie zu kaufen ist (aktiv, Zeitfenster) und das Mindestalter. Den Preis eines
// Kaufs bestimmt nur quote() – mit den laufenden Angeboten. Die Standard-Optionen der angemeldeten Funktionen legt
// seedItems() mit INSERT IGNORE an; was ein Admin geändert hat, bleibt.
import './premium.js';
import { configString } from '../config.js';
import { transaction, type Db, type Row } from '../db.js';
import { intval, phpTruthy } from '../php.js';
import { poolDb } from './util.js';
import { nowStr, toUnix } from './clock.js';
import { MAX_PRICE, feature, features, onFeatureRegistered, type Feature, type ItemRow } from './features.js';
import { bestOffer, offerUsesBy, runningOffers, type OfferRow } from './offers.js';
import { hcSettings } from './honeycombs.js';
import { audit } from './audit.js';

// Datenbanken, in denen alle angemeldeten Optionen schon angelegt sind (eine neue Anmeldung prüft erneut)
const seeded = new Set<string>();
onFeatureRegistered(() => seeded.clear());

// Standard-Optionen anlegen. Die Code-Seite übernimmt den bisher eingestellten Preis (oys_meta.honeycombs.code_page).
export async function seedItems(db: Db = poolDb): Promise<number> {
  const now = nowStr();
  let added = 0;
  for (const f of features()) {
    let position = 0;
    for (const [key, it] of Object.entries(f.items)) {
      const price = key === 'code_page' ? (await hcSettings(db)).code_page : it.price;
      const res = await db.exec(`INSERT IGNORE INTO hc_items (item_key, feature, days, units, price, is_active, position, available_from, available_until,
          min_account_days, min_active_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
      [key, f.key, it.days ?? null, it.units ?? 1, price, it.active ? 1 : 0, position, it.minAccountDays ?? 0, it.minActiveDays ?? 0, now, now]);
      added += res.affectedRows;
      position += 10;
    }
  }
  return added;
}

// Einmal je Prozess und Datenbank vor dem ersten Lesen – außerhalb jeder Sperre (eigene Pool-Abfragen)
export async function ensureCatalogue(): Promise<void> {
  const name = configString('db.name', '');
  if (seeded.has(name)) return;
  await seedItems(poolDb);
  seeded.add(name);
}

export async function itemByKey(key: string, db: Db = poolDb): Promise<ItemRow | null> {
  return db.one<ItemRow>('SELECT * FROM hc_items WHERE item_key = ?', [key]);
}

export async function itemsOf(featureKey: string, db: Db = poolDb): Promise<ItemRow[]> {
  return db.q<ItemRow>('SELECT * FROM hc_items WHERE feature = ? ORDER BY position, id', [featureKey]);
}

// Zu kaufen: aktiv und im Zeitfenster
export function itemOpen(item: ItemRow, now: string): boolean {
  return phpTruthy(item.is_active) && (item.available_from === null || item.available_from <= now)
    && (item.available_until === null || item.available_until > now);
}

// Bezeichnung einer Option: „30 days“, „+1“, „1 pass“, „Unlock“
export function optionLabel(f: Pick<Feature, 'kind'>, item: { days: number | null; units: number }): string {
  const days = intval(item.days);
  const units = intval(item.units);
  switch (f.kind) {
    case 'timed':
      return days + (days === 1 ? ' day' : ' days');
    case 'count':
      return '+' + units;
    case 'consumable':
      return units + (units === 1 ? ' pass' : ' passes');
    default:
      return 'Unlock';
  }
}

// Titel im Verlauf und in Hinweisen: „Code page“, „Premium · 30 days“
export function optionTitle(f: Pick<Feature, 'kind' | 'title'>, item: { days: number | null; units: number }): string {
  return f.kind === 'permanent' ? f.title : f.title + ' · ' + optionLabel(f, item);
}

// Was für Mindestalter und Angebote je Konto zählt
export interface Buyer {
  uid: number;
  accountDays: number; // seit users.created_at (unbekannt = 0)
  activeDays: number; // Tage mit der Tagesbelohnung
}

export async function buyerInfo(db: Db, uid: number, user: Row | null, now: string): Promise<Buyer> {
  const created = user && typeof user.created_at === 'string' ? user.created_at : null;
  const accountDays = created ? Math.max(0, Math.floor((toUnix(now) - toUnix(created)) / 86400)) : 0;
  const activeDays = intval(await db.value("SELECT COUNT(*) FROM honeycomb_ledger WHERE user_id = ? AND reason = 'daily'", [uid]));
  return { uid, accountDays, activeDays };
}

export interface Quote {
  listPrice: number;
  price: number;
  offer: OfferRow | null;
}

// Preis einer Option jetzt: das günstigste laufende Angebot (mit Konto: nur die, die für dieses Konto gelten –
// Mindestalter, aktive Tage, Einlösungen je Konto inklusive erstatteter Käufe)
export async function quote(db: Db, item: ItemRow, buyer: Buyer | null, now: string = nowStr()): Promise<Quote> {
  const list = intval(item.price);
  let offers = await runningOffers(db, item.item_key, item.feature, now);
  if (buyer) {
    const fit: OfferRow[] = [];
    for (const o of offers) {
      if (buyer.accountDays < intval(o.min_account_days) || buyer.activeDays < intval(o.min_active_days)) continue;
      if (o.per_user_max !== null && (await offerUsesBy(db, buyer.uid, intval(o.id))) >= intval(o.per_user_max)) continue;
      fit.push(o);
    }
    offers = fit;
  }
  const best = bestOffer(list, offers);
  return { listPrice: list, price: best.price, offer: best.offer };
}

// Aktueller Preis der einzigen Option einer dauerhaften Funktion (mit Angebot; mit uid auch je Konto)
export async function shopPrice(featureKey: string, uid?: number, db: Db = poolDb): Promise<number> {
  if (db === poolDb) await ensureCatalogue();
  const item = await itemByKey(featureKey, db);
  if (!item) return feature(featureKey)?.items[featureKey]?.price ?? 0;
  const now = nowStr();
  const buyer = uid === undefined ? null : await buyerInfo(db, uid, await db.one('SELECT * FROM users WHERE id = ?', [uid]), now);
  return (await quote(db, item, buyer, now)).price;
}

// Listenpreis einer Option (Anzeige im Admin)
export async function listPrice(itemKey: string): Promise<number> {
  await ensureCatalogue();
  const item = await itemByKey(itemKey);
  if (item) return intval(item.price);
  for (const f of features()) if (Object.hasOwn(f.items, itemKey)) return f.items[itemKey].price;
  return 0;
}

// Preis einer Option ändern (Admin) – mit Protokoll, nur wenn er sich ändert
export async function setItemPrice(adminId: number, itemKey: string, price: number): Promise<void> {
  if (!Number.isInteger(price) || price < 0 || price > MAX_PRICE) throw new Error(`invalid price ${price}`);
  await ensureCatalogue();
  await transaction(async (_conn, db) => {
    const item = await db.one<ItemRow>('SELECT * FROM hc_items WHERE item_key = ? FOR UPDATE', [itemKey]);
    if (!item || intval(item.price) === price) return;
    await db.exec('UPDATE hc_items SET price = ?, updated_at = ? WHERE id = ?', [price, nowStr(), intval(item.id)]);
    await audit(db, adminId, 'item_save', null, itemKey, { old: intval(item.price), new: price });
  });
}
