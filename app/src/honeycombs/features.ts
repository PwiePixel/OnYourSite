// Was man mit Honigwaben bekommen kann: das Verhalten steht im Code, die Preise in hc_items (ab dem Katalog).
// Jeder Bereich meldet seine Funktionen in seinem eigenen Modul an (registerFeature), dazu Vorteile von Premium
// (registerPerk) und Zeilen für „was dann wegfällt“ (registerLossPreview). Der Shop selbst meldet nur `premium` an.
// Eine Option, deren Funktion im Code nicht angemeldet ist, wird nie gezeigt und nie verkauft.
import type { Db, Row } from '../db.js';

export type FeatureKind = 'permanent' | 'timed' | 'count' | 'consumable';

// Standard-Option einer Funktion (wird beim ersten Lesen des Katalogs per INSERT IGNORE angelegt)
export interface FeatureItem {
  days?: number; // nur zeitlich begrenzt: Laufzeit in Tagen
  units?: number; // Anzahl/Pässe (count, consumable)
  price: number;
  active: boolean;
  minAccountDays?: number;
  minActiveDays?: number;
}

// Zeile aus hc_items
export interface ItemRow extends Row {
  id: number;
  item_key: string;
  feature: string;
  days: number | null;
  units: number;
  price: number;
  is_active: number;
  position: number;
  available_from: string | null;
  available_until: string | null;
  min_account_days: number;
  min_active_days: number;
}

// Eigene Regeln des Bereichs beim Kauf – nur über c.db (die Verbindung der Kontosperre)
export interface BuyCheck {
  uid: number;
  user: Row;
  db: Db;
  item: ItemRow;
  input: { terms?: boolean };
}

export interface Feature {
  key: string; // z. B. 'premium', 'code_page' – bei dauerhaften Freischaltungen auch der Bezug im Buch (unlock/<key>)
  owner: string; // Bereich, dem die Funktion gehört (Anzeige im Admin)
  title: string;
  icon: string;
  description: string;
  kind: FeatureKind;
  stack?: number; // timed: so viele Pakete gleichzeitig (Standard 1)
  max?: number; // count/consumable: höchste Anzahl
  maxAheadDays?: number; // timed: höchstens so weit im Voraus (Standard 400)
  minAccountDaysFloor?: number; // untere Grenze für das Mindestalter der Optionen und Angebote (Premium: 30)
  requires?: string; // muss aktiv sein, z. B. 'code_page'
  freeAtZero?: boolean; // dauerhaft: Preis 0 = für alle frei – keine Karte, kein Kauf
  ready?: () => boolean; // false: nicht zeigen, nicht verkaufen, nicht vergeben
  includedFor?: (user: Row) => boolean; // z. B. für Admins immer dabei
  needsTerms?: (user: Row) => boolean; // Kaufdialog zeigt die Regeln zum Ankreuzen
  canBuy?: (c: BuyCheck) => Promise<string | null>; // eigene Regeln (Sperre, Grenzen, Regeln akzeptiert)
  items: Record<string, FeatureItem>;
  href?: string; // Ziel nach dem Kauf, z. B. '#code'
}

// Zeitlich begrenzte Optionen lassen sich einschalten: Erinnerungen und das Ende verarbeitet die Hintergrundaufgabe (HC-7a)
export let LIFECYCLE_READY = true;
export function setLifecycleReadyForTests(v: boolean): void {
  LIFECYCLE_READY = v;
}

export const FEATURE_KEY = /^[a-z][a-z0-9_]{1,39}$/;
export const DEFAULT_MAX_AHEAD_DAYS = 400;
export const MAX_PRICE = 1000000;

const registry = new Map<string, Feature>();
// Wer wissen muss, dass etwas Neues angemeldet wurde (der Katalog legt dann fehlende Optionen an)
const listeners: Array<() => void> = [];

export function onFeatureRegistered(fn: () => void): void {
  listeners.push(fn);
}

// Schlüssel einer Option aus Funktion und Laufzeit/Menge: dauerhaft = Funktion, timed = <f>_<Tage>, sonst <f>_x<Anzahl>
export function itemKeyFor(f: Pick<Feature, 'key' | 'kind'>, o: { days?: number | null; units?: number | null }): string {
  if (f.kind === 'permanent') return f.key;
  if (f.kind === 'timed') return `${f.key}_${o.days ?? 0}`;
  return `${f.key}_x${o.units ?? 1}`;
}

const isInt = (n: unknown, min: number, max: number): boolean => typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;

// Fehler in einer Anmeldung sind Programmierfehler: sofort beim Start auffallen
export function registerFeature(f: Feature): void {
  const bad = (why: string): never => {
    throw new Error(`registerFeature(${f.key}): ${why}`);
  };
  if (!FEATURE_KEY.test(f.key)) bad('invalid key');
  if (registry.has(f.key)) bad('registered twice');
  if (!['permanent', 'timed', 'count', 'consumable'].includes(f.kind)) bad('invalid kind');
  if (f.stack !== undefined && (f.kind !== 'timed' || !isInt(f.stack, 1, 10))) bad('stack is for timed features (1–10)');
  if (f.max !== undefined && (!['count', 'consumable'].includes(f.kind) || !isInt(f.max, 1, 1000))) bad('max is for count/consumable features');
  if (f.maxAheadDays !== undefined && (f.kind !== 'timed' || !isInt(f.maxAheadDays, 1, 3650))) bad('maxAheadDays is for timed features');
  if (f.minAccountDaysFloor !== undefined && !isInt(f.minAccountDaysFloor, 0, 3650)) bad('invalid minAccountDaysFloor');
  if (f.freeAtZero && f.kind !== 'permanent') bad('freeAtZero is for permanent features');
  if (f.requires !== undefined && (!FEATURE_KEY.test(f.requires) || f.requires === f.key)) bad('invalid requires');
  const keys = Object.keys(f.items);
  if (!keys.length) bad('needs at least one option');
  if (f.kind === 'permanent' && (keys.length !== 1 || keys[0] !== f.key)) bad('a permanent feature has exactly one option named like the feature');
  for (const [key, item] of Object.entries(f.items)) {
    if (!isInt(item.price, 0, MAX_PRICE)) bad(`option ${key}: invalid price`);
    if (f.kind === 'timed' && !isInt(item.days, 1, 365)) bad(`option ${key}: timed options need 1–365 days`);
    if (f.kind !== 'timed' && item.days !== undefined) bad(`option ${key}: only timed options have days`);
    if ((f.kind === 'count' || f.kind === 'consumable') && item.units !== undefined && !isInt(item.units, 1, 10)) bad(`option ${key}: 1–10 units`);
    if (f.kind !== 'count' && f.kind !== 'consumable' && item.units !== undefined) bad(`option ${key}: only count/consumable options have units`);
    if (item.minAccountDays !== undefined && !isInt(item.minAccountDays, 0, 3650)) bad(`option ${key}: invalid minAccountDays`);
    if (item.minActiveDays !== undefined && !isInt(item.minActiveDays, 0, 3650)) bad(`option ${key}: invalid minActiveDays`);
    if (itemKeyFor(f, item) !== key) bad(`option ${key} must be called ${itemKeyFor(f, item)}`);
  }
  registry.set(f.key, f);
  for (const fn of listeners) fn();
}

export const feature = (key: string): Feature | null => registry.get(key) ?? null;
export const features = (): Feature[] => [...registry.values()];
export const featureReady = (f: Feature): boolean => (f.ready ? f.ready() : true);

// Nur für Tests: eine Testfunktion wieder abmelden
export function unregisterFeatureForTests(key: string): void {
  registry.delete(key);
}

// ---------------------------------------------------------------- Vorteile von Premium

export interface Perk {
  owner: string;
  text: string;
  ready: () => boolean;
}
const perks: Perk[] = [];

// Premium enthält genau die Vorteile, die die zuständigen Bereiche hier anmelden
export function registerPerk(featureKey: 'premium', perk: Perk): void {
  if (featureKey !== 'premium') throw new Error('registerPerk: only premium has perks');
  if (!perk.owner || !perk.text) throw new Error('registerPerk: owner and text are required');
  perks.push(perk);
}

export const premiumPerks = (): Perk[] => [...perks];

export function unregisterPerksForTests(owner: string): void {
  for (let i = perks.length - 1; i >= 0; i--) if (perks[i].owner === owner) perks.splice(i, 1);
}

// ---------------------------------------------------------------- Was beim Ende wegfällt

export type LossPreview = (uid: number, db: Db) => Promise<string[]>;
const previews = new Map<string, LossPreview[]>();

// Zeilen wie „links.example.com will forward to mia.on-your.site.“ für Erinnerungen und den Hinweis beim Ende
export function registerLossPreview(featureKey: string, fn: LossPreview): void {
  if (!FEATURE_KEY.test(featureKey)) throw new Error(`registerLossPreview: invalid feature ${featureKey}`);
  previews.set(featureKey, [...(previews.get(featureKey) ?? []), fn]);
}

// Alle Zeilen einer Funktion (ein Fehler eines Bereichs kostet nur dessen Zeilen)
export async function lossPreview(featureKey: string, uid: number, db: Db): Promise<string[]> {
  const lines: string[] = [];
  for (const fn of previews.get(featureKey) ?? []) {
    try {
      lines.push(...(await fn(uid, db)));
    } catch (err) {
      console.error(`loss preview for ${featureKey} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return lines;
}
