// Admin, Bereich „Honeycombs“: Unterbereiche (Übersicht, Katalog & Preise, Angebote, Regeln zum Verdienen, Nutzer) und
// ihre Aktionen (POST /admin mit hc_action). Jede Aktion schreibt eine Zeile in hc_audit (nur IDs, Beträge und
// Schlüssel). Felder mit Arrays werden abgelehnt (kein Umwandeln wie in PHP). Admin = is_admin des angemeldeten Kontos;
// CSRF und die Bestätigung (_confirmed) prüft der Verteiler (admin/page.ts) vorher.
import { transaction, type Db } from '../db.js';
import { intval, phpStr, type PhpArray } from '../php.js';
import { phpJson } from '../html.js';
import { nowStr } from './clock.js';
import { FEATURE_KEY, LIFECYCLE_READY, MAX_PRICE, feature, featureReady, itemKeyFor, type Feature, type ItemRow } from './features.js';
import { ensureCatalogue, optionTitle } from './catalogue.js';
import { cancelOffer, createOffer, formDateTime } from './offers.js';
import { hcSettingsFrom, type HcSettings } from './honeycombs.js';
import { PhpNumber, phpInt, phpJsonDecode } from './util.js';
import { audit, type AuditDetails } from './audit.js';

export type AdminResult = { ok: string } | { error: string };

// Unterbereiche (die übrigen – purchases, ledger, codes – kommen mit HC-6a/6b/HC-9)
export const HC_TABS = ['overview', 'catalogue', 'offers', 'rules', 'users'] as const;
export type HcTab = (typeof HC_TABS)[number];
const ACTION_TAB: Readonly<Record<string, HcTab>> = {
  settings: 'rules', item_save: 'catalogue', item_add: 'catalogue', offer_create: 'offers', offer_cancel: 'offers', grant: 'users',
};

// ?hc_tab=… → Unterbereich (Unbekanntes: Übersicht)
export function hcTab(v: unknown): HcTab {
  return typeof v === 'string' && (HC_TABS as readonly string[]).includes(v) ? (v as HcTab) : 'overview';
}

// Zurück zum Unterbereich der Aktion (nach dem Speichern und wenn die Bestätigung fehlt)
export function hcBackUrl(post: PhpArray): string {
  const action = typeof post.hc_action === 'string' ? post.hc_action : '';
  const tab = Object.hasOwn(ACTION_TAB, action) ? ACTION_TAB[action] : 'overview';
  return '/admin' + (tab === 'overview' ? '' : '?hc_tab=' + tab) + '#honeycombs';
}

const BAD = 'Not all of the data arrived. Please try again.';

// Felder als Text; ein Array oder Objekt (z. B. name[]=…) macht die ganze Anfrage ungültig
function textFields(post: PhpArray, keys: readonly string[]): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = post[k];
    if (v === undefined || v === null) out[k] = '';
    else if (typeof v === 'string') out[k] = v;
    else return null;
  }
  return out;
}

// Ganze Zahl aus einem Formularfeld (Ziffern, optional mit Minus); '' → fallback; sonst null (ungültig)
function wholeNumber(v: string, min: number, max: number, fallback: number | null = null): number | null {
  const s = v.replace(/^\s+|\s+$/g, '').replace('−', '-');
  if (s === '') return fallback;
  if (!/^-?[0-9]{1,9}$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n + 0 : null;
}

// Das Mindestalter, das Optionen und Angebote einer Funktion mindestens verlangen (Premium: 30 Tage)
function floorText(f: Feature, floor: number): string {
  return f.key === 'premium' ? 'Premium needs accounts that are at least ' + floor + ' days old.' : 'This option needs accounts that are at least ' + floor + ' days old.';
}

// Lässt sich eine Option jetzt einschalten? Die Funktion muss bereit sein, zeitlich begrenzte erst mit dem Ablauf (HC-7a)
export function switchOnProblem(f: Feature): string | null {
  if (!featureReady(f) || (f.kind === 'timed' && !LIFECYCLE_READY)) return 'This option can’t be switched on yet.';
  return null;
}

// ---------------------------------------------------------------- Regeln zum Verdienen

const RULE_KEYS = ['daily', 'profile', 'views', 'views_step'] as const;

// Gespeicherter JSON-Text als Objekt (alles andere: leer) – damit Schlüssel späterer Schritte erhalten bleiben
function storedObject(raw: string): Record<string, unknown> {
  const data = phpJsonDecode(raw, false);
  return data !== null && typeof data === 'object' && !Array.isArray(data) && !(data instanceof PhpNumber) ? { ...(data as Record<string, unknown>) } : {};
}

// Formular „How users earn them“: ganze Zahlen 0–100000 (Aufrufe je Stufe ≥ 1), wie bisher begrenzt statt abgelehnt.
// Was das Formular nicht schickt, bleibt; unbekannte Schlüssel (spätere Schritte) und der alte Preis der Code-Seite
// bleiben stehen – der Preis gilt nur noch im Katalog.
export async function saveRules(post: PhpArray, adminId: number): Promise<AdminResult> {
  const f = textFields(post, RULE_KEYS);
  if (!f) return { error: BAD };
  return transaction(async (_conn, db: Db) => {
    const raw = phpStr(await db.value("SELECT meta_value FROM oys_meta WHERE meta_key = 'honeycombs' FOR UPDATE"));
    const before: HcSettings = hcSettingsFrom(raw);
    const next = storedObject(raw);
    const changed: AuditDetails = {};
    for (const key of RULE_KEYS) {
      if (post[key] === undefined) continue;
      let v = Math.max(0, Math.min(100000, phpInt(f[key])));
      if (key === 'views_step') v = Math.max(1, v);
      next[key] = v;
      if (v !== before[key]) changed[key] = v;
    }
    await db.exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('honeycombs', ?)", [phpJson(next)]);
    if (Object.keys(changed).length) await audit(db, adminId, 'settings', null, 'honeycombs', changed);
    return { ok: 'Honeycomb settings saved.' };
  });
}

// ---------------------------------------------------------------- Katalog & Preise

const ITEM_FIELDS = ['item_id', 'price', 'is_active', 'position', 'available_from', 'available_until', 'min_account_days', 'min_active_days'] as const;

export async function saveItem(post: PhpArray, adminId: number): Promise<AdminResult> {
  const f = textFields(post, ITEM_FIELDS);
  if (!f) return { error: BAD };
  const id = wholeNumber(f.item_id, 1, 2147483647);
  if (id === null) return { error: 'Option not found.' };
  const price = wholeNumber(f.price, 0, MAX_PRICE);
  if (price === null) return { error: 'Enter a price between 0 and 1,000,000.' };
  const position = wholeNumber(f.position, -1000, 1000, 0);
  if (position === null) return { error: 'Position: enter a whole number from −1,000 to 1,000.' };
  const from = f.available_from === '' ? null : formDateTime(f.available_from);
  const until = f.available_until === '' ? null : formDateTime(f.available_until);
  if ((f.available_from !== '' && from === null) || (f.available_until !== '' && until === null)) return { error: 'Please enter “Available from” and “until” as a date and time.' };
  if (from !== null && until !== null && !(until > from)) return { error: '“Available until” must be after “Available from”.' };
  const minAccount = wholeNumber(f.min_account_days, 0, 3650, 0);
  const minActive = wholeNumber(f.min_active_days, 0, 3650, 0);
  if (minAccount === null || minActive === null) return { error: 'Minimum days: enter 0 to 3,650.' };
  const active = f.is_active === '1';
  await ensureCatalogue();
  return transaction(async (_conn, db: Db) => {
    const item = await db.one<ItemRow>('SELECT * FROM hc_items WHERE id = ? FOR UPDATE', [id]);
    const feat = item ? feature(item.feature) : null;
    if (!item || !feat) return { error: 'Option not found.' };
    const floor = feat.minAccountDaysFloor ?? 0;
    if (minAccount < floor) return { error: floorText(feat, floor) };
    const wasActive = intval(item.is_active) === 1;
    if (active && !wasActive) {
      const problem = switchOnProblem(feat);
      if (problem) return { error: problem };
    }
    const next: Record<string, number | string | null> = {
      price, is_active: active ? 1 : 0, position, available_from: from, available_until: until, min_account_days: minAccount, min_active_days: minActive,
    };
    const changed: AuditDetails = {};
    for (const [k, v] of Object.entries(next)) {
      const old = item[k] === null || item[k] === undefined ? null : typeof v === 'number' ? intval(item[k]) : phpStr(item[k]);
      if (old !== v) {
        changed[k] = v;
        changed[k + '_was'] = old;
      }
    }
    if (Object.keys(changed).length) {
      await db.exec(`UPDATE hc_items SET price = ?, is_active = ?, position = ?, available_from = ?, available_until = ?, min_account_days = ?, min_active_days = ?,
          updated_at = ? WHERE id = ?`, [price, active ? 1 : 0, position, from, until, minAccount, minActive, nowStr(), id]);
      await audit(db, adminId, 'item_save', null, item.item_key, changed);
    }
    return { ok: 'Saved “' + optionTitle(feat, item) + '”.' };
  });
}

// Weitere Laufzeit (zeitlich begrenzt, 1–365 Tage) oder Paketgröße (Anzahl/Pässe, 1–10) einer Funktion. Neue
// Optionen sind aus, bis ein Admin sie einschaltet; Optionen werden nie gelöscht (Käufe verweisen auf sie).
export async function addItem(post: PhpArray, adminId: number): Promise<AdminResult> {
  const f = textFields(post, ['feature', 'days', 'units', 'price']);
  if (!f) return { error: BAD };
  const feat = FEATURE_KEY.test(f.feature) ? feature(f.feature) : null;
  if (!feat || !featureReady(feat) || feat.kind === 'permanent') return { error: 'Please choose a feature that can have more options.' };
  const days = feat.kind === 'timed' ? wholeNumber(f.days, 1, 365) : null;
  const units = feat.kind === 'timed' ? null : wholeNumber(f.units, 1, 10);
  if (feat.kind === 'timed' && days === null) return { error: 'Enter a duration of 1 to 365 days.' };
  if (feat.kind !== 'timed' && units === null) return { error: 'Enter a pack size of 1 to 10.' };
  const price = wholeNumber(f.price, 0, MAX_PRICE);
  if (price === null) return { error: 'Enter a price between 0 and 1,000,000.' };
  const key = itemKeyFor(feat, { days, units });
  if (!FEATURE_KEY.test(key)) return { error: 'Please choose a feature that can have more options.' };
  // Mindestalter und aktive Tage wie die erste Option der Funktion (nie unter der Untergrenze)
  const first = Object.values(feat.items)[0];
  const minAccount = Math.max(feat.minAccountDaysFloor ?? 0, first?.minAccountDays ?? 0);
  const minActive = first?.minActiveDays ?? 0;
  await ensureCatalogue();
  return transaction(async (_conn, db: Db) => {
    const position = intval(await db.value('SELECT COALESCE(MAX(position), -10) + 10 FROM hc_items WHERE feature = ?', [feat.key]));
    const now = nowStr();
    const res = await db.exec(`INSERT IGNORE INTO hc_items (item_key, feature, days, units, price, is_active, position, available_from, available_until,
        min_account_days, min_active_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, NULL, NULL, ?, ?, ?, ?)`,
    [key, feat.key, days, units ?? 1, price, position, minAccount, minActive, now, now]);
    if (res.affectedRows === 0) return { error: 'This option already exists.' };
    await audit(db, adminId, 'item_add', null, key, { price, days, units });
    return { ok: 'Added “' + optionTitle(feat, { days, units: units ?? 1 }) + '”. It stays off until you switch it on.' };
  });
}

// ---------------------------------------------------------------- Angebote

const OFFER_FIELDS = ['label', 'scope', 'discount', 'percent_off', 'fixed_price', 'starts_at', 'ends_at', 'max_uses', 'per_user_max', 'min_account_days',
  'min_active_days', 'form_ref'] as const;

// Formular: Art des Rabatts (Prozent oder fester Preis) – das Feld der anderen Art zählt nicht
async function offerCreate(post: PhpArray, adminId: number): Promise<AdminResult> {
  const f = textFields(post, OFFER_FIELDS);
  if (!f) return { error: BAD };
  const fixed = f.discount === 'fixed';
  return createOffer(adminId, {
    label: f.label, scope: f.scope, percentOff: fixed ? '' : f.percent_off, fixedPrice: fixed ? f.fixed_price : '', startsAt: f.starts_at, endsAt: f.ends_at,
    maxUses: f.max_uses, perUserMax: f.per_user_max, minAccountDays: f.min_account_days, minActiveDays: f.min_active_days, formRef: f.form_ref,
  });
}

async function offerCancel(post: PhpArray, adminId: number): Promise<AdminResult> {
  const f = textFields(post, ['offer_id']);
  if (!f) return { error: BAD };
  const id = wholeNumber(f.offer_id, 1, 2147483647);
  if (id === null) return { error: 'Offer not found.' };
  return cancelOffer(adminId, id);
}

// Aktionen des Shops (null: keine davon – dann prüft der Aufrufer die übrigen)
export async function adminShopHandle(post: PhpArray, adminId: number): Promise<AdminResult | null> {
  switch (post.hc_action) {
    case 'settings':
      return saveRules(post, adminId);
    case 'item_save':
      return saveItem(post, adminId);
    case 'item_add':
      return addItem(post, adminId);
    case 'offer_create':
      return offerCreate(post, adminId);
    case 'offer_cancel':
      return offerCancel(post, adminId);
  }
  return null;
}
