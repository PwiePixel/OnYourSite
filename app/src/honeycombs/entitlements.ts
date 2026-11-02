// Was ein Konto besitzt (hc_entitlements): je Funktion eine Zeile, bei stapelbaren Zeitpaketen eine Zeile je Paket
// (lot). Das lesen alle Bereiche – nie das Buch direkt. Jede Änderung des Besitzes schreibt zugleich eine Buchung
// (unlock, purchase, grant, revoke, refund) und setzt den Abgleich-Merker, alles in der Transaktion der Kontosperre.
//
// „Dauerhaft“ ist immer permanent = 1, nie expires_at IS NULL (Rechnen mit NULL ergibt NULL, nie „für immer“).
// Lesen schreibt nie. Jede Lese-Funktion nimmt die Verbindung des Aufrufers (db), damit andere Bereiche sie in ihrer
// eigenen Sperre benutzen können, ohne eine zweite Verbindung zu holen.
import type { Db, Row } from '../db.js';
import { intval, mbSubstr, phpTruthy } from '../php.js';
import { poolDb } from './util.js';
import { nowStr, toUnix } from './clock.js';
import { FEATURE_KEY, feature } from './features.js';
import { credit, debit, lockedAccount } from './ledger.js';
import { markReconcile } from './reconcile.js';

// Premium „für immer“ in users.premium_until (premium-domains verknüpft per SQL: premium_until > NOW())
export const PREMIUM_FOREVER = '9999-12-31 23:59:59';

export type EntitlementSource = 'purchase' | 'admin' | 'legacy';

export interface EntRow extends Row {
  id: number;
  user_id: number;
  feature: string;
  lot: number;
  quantity: number;
  permanent: number;
  expires_at: string | null;
  source: string;
  reminded: number;
  expiry_done_at: string | null;
  note: string;
  granted_by: number | null;
}

export interface Lot {
  lot: number;
  quantity: number;
  permanent: boolean;
  expiresAt: string | null;
  active: boolean;
  source: string;
}

export interface Entitlement {
  active: boolean; // wie has(): aktives Paket, alte Freischaltung im Buch oder für das Konto ohnehin dabei
  until: string | null; // frühestes Ende eines aktiven, zeitlich begrenzten Pakets
  quantity: number; // Summe der aktiven Pakete (alte Freischaltung im Buch: 1)
  permanent: boolean; // ohne Ende (dauerhaft freigeschaltet oder für das Konto dabei)
  included: boolean; // includedFor() der Funktion (z. B. Admins)
  lots: Lot[];
}

function assertKey(key: string): void {
  if (!FEATURE_KEY.test(key)) throw new Error(`invalid feature key: ${key}`);
}

// Aktiv = Menge > 0 und dauerhaft oder Ende in der Zukunft (Vergleich als DATETIME-Text, gleiche Zeitzone)
export function isActive(e: { quantity?: unknown; permanent?: unknown; expires_at?: unknown }, now: string): boolean {
  if (intval(e.quantity) <= 0) return false;
  if (phpTruthy(e.permanent)) return true;
  return typeof e.expires_at === 'string' && e.expires_at > now;
}

// Erinnerungsstufe nach verbleibender Zeit: ≤ 1 Tag → 3, ≤ 3 Tage → 2, ≤ 7 Tage → 1, sonst 0
export function stage(expiresAt: string, now: string): number {
  const left = (toUnix(expiresAt) - toUnix(now)) / 86400;
  return left <= 1 ? 3 : left <= 3 ? 2 : left <= 7 ? 1 : 0;
}

// Die alte Freischaltung im Buch (unlock/<Funktion>) gilt nur für Funktionen, die dauerhaft sind oder (noch) nicht
// angemeldet: Zeilen, die der alte Prozess zwischen `migrate` und dem Neustart eines Updates bucht
function ledgerFallback(key: string): boolean {
  const f = feature(key);
  return f === null || f.kind === 'permanent';
}

async function lotsOf(db: Db, uid: number, key: string): Promise<EntRow[]> {
  return db.q<EntRow>('SELECT * FROM hc_entitlements WHERE user_id = ? AND feature = ? ORDER BY lot', [uid, key]);
}

// Genau dieser Bezug (Groß/klein wie bei der Übernahme in V_SHOP_CORE: CODE_PAGE ist keine Freischaltung)
async function ledgerUnlocked(db: Db, uid: number, key: string): Promise<boolean> {
  return !!(await db.value("SELECT 1 FROM honeycomb_ledger WHERE user_id = ? AND reason = 'unlock' AND BINARY ref = ? LIMIT 1", [uid, key]));
}

// includedFor(user): eine Abfrage über den Primärschlüssel von users auf derselben Verbindung
async function includedFor(db: Db, uid: number, key: string): Promise<boolean> {
  const f = feature(key);
  if (!f?.includedFor) return false;
  const user = await db.one('SELECT * FROM users WHERE id = ?', [uid]);
  return user !== null && f.includedFor(user);
}

// Hat das Konto die Funktion? Aktives Paket – oder (dauerhaft, ohne jede Zeile) die Buchung unlock/<Funktion> –
// oder die Funktion ist für dieses Konto ohnehin dabei. Eine erstattete oder entzogene Freischaltung behält ihre Zeile
// (Menge 0), die Buchung belebt sie also nicht wieder.
export async function has(uid: number, key: string, db: Db = poolDb): Promise<boolean> {
  const now = nowStr();
  const lots = await lotsOf(db, uid, key);
  if (lots.some((l) => isActive(l, now))) return true;
  if (!lots.length && ledgerFallback(key) && (await ledgerUnlocked(db, uid, key))) return true;
  return includedFor(db, uid, key);
}

// Summe der aktiven Pakete (0 ohne); eine alte Freischaltung im Buch zählt als 1
export async function quantity(uid: number, key: string, db: Db = poolDb): Promise<number> {
  const now = nowStr();
  const lots = await lotsOf(db, uid, key);
  const sum = lots.filter((l) => isActive(l, now)).reduce((n, l) => n + intval(l.quantity), 0);
  if (sum === 0 && !lots.length && ledgerFallback(key) && (await ledgerUnlocked(db, uid, key))) return 1;
  return sum;
}

// Stand einer Funktion mit allen Paketen (z. B. für die Grenzen der Statusseiten)
export async function entitlement(uid: number, key: string, db: Db = poolDb): Promise<Entitlement> {
  const now = nowStr();
  const rows = await lotsOf(db, uid, key);
  const lots: Lot[] = rows.map((r) => ({
    lot: intval(r.lot), quantity: intval(r.quantity), permanent: phpTruthy(r.permanent), expiresAt: r.expires_at,
    active: isActive(r, now), source: String(r.source),
  }));
  const active = lots.filter((l) => l.active);
  let quantitySum = active.reduce((n, l) => n + l.quantity, 0);
  let permanent = active.some((l) => l.permanent);
  const ends = active.filter((l) => !l.permanent && l.expiresAt !== null).map((l) => l.expiresAt as string).sort();
  if (!rows.length && ledgerFallback(key) && (await ledgerUnlocked(db, uid, key))) {
    quantitySum = 1;
    permanent = true;
  }
  const included = await includedFor(db, uid, key);
  return {
    active: quantitySum > 0 || included,
    until: ends[0] ?? null,
    quantity: quantitySum,
    permanent: permanent || included,
    included,
    lots,
  };
}

// Für Admin-Listen: wer eine dauerhafte Funktion gerade hat → Betrag der letzten Freischaltung (0 = vom Team,
// negativ = bezahlt). Gleiche Regeln wie has() ohne includedFor.
export async function unlockHolders(key: string, db: Db = poolDb): Promise<Map<number, number>> {
  assertKey(key);
  const now = nowStr();
  const amounts = new Map<number, number>();
  for (const r of await db.q("SELECT user_id, amount FROM honeycomb_ledger WHERE reason = 'unlock' AND (BINARY ref = ? OR BINARY LEFT(ref, ?) = ?) ORDER BY id",
    [key, key.length + 1, key + ':'])) {
    amounts.set(intval(r.user_id), intval(r.amount));
  }
  const rows = new Map<number, boolean>();
  for (const r of await db.q('SELECT user_id, quantity, permanent, expires_at FROM hc_entitlements WHERE feature = ?', [key])) {
    const uid = intval(r.user_id);
    rows.set(uid, (rows.get(uid) ?? false) || isActive(r, now));
  }
  const out = new Map<number, number>();
  for (const [uid, amount] of amounts) {
    if (rows.get(uid) ?? true) out.set(uid, amount);
  }
  for (const [uid, activeNow] of rows) {
    if (activeNow && !out.has(uid)) out.set(uid, 0);
  }
  return out;
}

// ---------------------------------------------------------------- Schreiben (nur unter der Kontosperre)

function assertLocked(uid: number, what: string): void {
  if (lockedAccount() !== uid) throw new Error(`${what} needs the account lock of this user (withAccount)`);
}

// Bezug der nächsten Freischaltung: <Funktion> beim ersten Mal, danach <Funktion>:<n> (n = 2, 3 …) – zum Beispiel nach
// einer Erstattung. Unter der Sperre gezählt, also eindeutig. Gezählt ohne Groß/klein wie der eindeutige Schlüssel des
// Buchs (uq_entry), damit der neue Bezug nie mit einer alten Zeile zusammenfällt.
export async function unlockRef(db: Db, uid: number, key: string): Promise<string> {
  const n = intval(await db.value("SELECT COUNT(*) FROM honeycomb_ledger WHERE user_id = ? AND reason = 'unlock' AND (ref = ? OR LEFT(ref, ?) = ?)",
    [uid, key, key.length + 1, key + ':']));
  return n === 0 ? key : `${key}:${n + 1}`;
}

async function upsertPermanent(db: Db, uid: number, key: string, source: EntitlementSource, note: string, grantedBy: number | null, now: string): Promise<void> {
  await db.exec(`INSERT INTO hc_entitlements (user_id, feature, lot, quantity, permanent, expires_at, source, reminded, expiry_done_at, note, granted_by, created_at, updated_at)
      VALUES (?, ?, 0, 1, 1, NULL, ?, 0, NULL, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE quantity = 1, permanent = 1, expires_at = NULL, source = VALUES(source), reminded = 0, expiry_done_at = NULL,
        note = VALUES(note), granted_by = VALUES(granted_by), updated_at = VALUES(updated_at)`,
  [uid, key, source, mbSubstr(note, 0, 200), grantedBy, now, now]);
}

// Dauerhafte Freischaltung – gekauft oder geschenkt: Buchung unlock/<Bezug> (−Preis oder 0) und die Berechtigung in
// derselben Transaktion. null = schon freigeschaltet (nichts gebucht). Fehlt nur die Berechtigung zu einer alten
// Buchung im Buch, wird sie nachgetragen (auch dann wird nichts gebucht).
export async function grantUnlock(db: Db, uid: number, key: string, amount: number, note: string, actorId: number | null,
  source: EntitlementSource): Promise<{ ledgerId: number; ref: string } | null> {
  assertKey(key);
  assertLocked(uid, 'grantUnlock()');
  const now = nowStr();
  const lots = await db.q<EntRow>('SELECT * FROM hc_entitlements WHERE user_id = ? AND feature = ? FOR UPDATE', [uid, key]);
  if (lots.some((l) => isActive(l, now))) return null;
  if (!lots.length && (await ledgerUnlocked(db, uid, key))) {
    const paid = intval(await db.value("SELECT amount FROM honeycomb_ledger WHERE user_id = ? AND reason = 'unlock' AND BINARY ref = ? LIMIT 1", [uid, key]));
    await upsertPermanent(db, uid, key, paid === 0 ? 'admin' : 'legacy', '', null, now);
    await markReconcile(db, uid, now);
    return null;
  }
  const ref = await unlockRef(db, uid, key);
  const ledgerId = amount < 0 ? await debit(db, uid, -amount, 'unlock', ref, note, actorId) : await credit(db, uid, amount, 'unlock', ref, note, actorId);
  if (ledgerId === null) throw new Error(`unlock ${ref} of #${uid} was booked twice`);
  await upsertPermanent(db, uid, key, source, note, actorId, now);
  await markReconcile(db, uid, now);
  return { ledgerId, ref };
}

// Neuer Stand eines Pakets. Der EINZIGE Schreiber von Laufzeit, Menge und „dauerhaft“: Käufe, Verlängerungen,
// Geschenke, Erstattungen und Entzug laufen alle hierüber.
export interface PeriodChange {
  quantity: number; // 0 = entzogen
  permanent: boolean;
  expiresAt: string | null; // Ende bei zeitlich begrenzten (bei permanent ohne Bedeutung)
  source?: EntitlementSource;
  note?: string;
  grantedBy?: number | null;
  expiryDoneAt?: string | null; // nur für ein inaktives Paket: Ende gilt als verarbeitet (kein zweiter Hinweis)
}

export async function setPeriod(db: Db, uid: number, key: string, lot: number, change: PeriodChange, now: string = nowStr()): Promise<void> {
  assertKey(key);
  assertLocked(uid, 'setPeriod()');
  if (!Number.isInteger(lot) || lot < 0 || lot > 9) throw new Error(`invalid lot ${lot}`);
  if (!Number.isInteger(change.quantity) || change.quantity < 0) throw new Error('invalid quantity');
  const permanent = change.permanent && change.quantity > 0;
  const expiresAt = permanent ? null : change.expiresAt;
  const row = { quantity: change.quantity, permanent: permanent ? 1 : 0, expires_at: expiresAt };
  const active = isActive(row, now);
  // Erinnerungen ab der Stufe des neuen Endes (ein Kauf für 7 Tage erinnert nicht am selben Tag)
  const reminded = active && !permanent && expiresAt !== null ? stage(expiresAt, now) : 0;
  const cur = await db.one<EntRow>('SELECT * FROM hc_entitlements WHERE user_id = ? AND feature = ? AND lot = ? FOR UPDATE', [uid, key, lot]);
  const expiryDone = active ? null : change.expiryDoneAt !== undefined ? change.expiryDoneAt : (cur?.expiry_done_at ?? null);
  const source = change.source ?? (cur ? (String(cur.source) as EntitlementSource) : 'purchase');
  const note = mbSubstr(change.note ?? (cur ? String(cur.note) : ''), 0, 200);
  const grantedBy = change.grantedBy !== undefined ? change.grantedBy : (cur?.granted_by ?? null);
  if (cur) {
    await db.exec(`UPDATE hc_entitlements SET quantity = ?, permanent = ?, expires_at = ?, reminded = ?, expiry_done_at = ?, source = ?, note = ?,
        granted_by = ?, updated_at = ? WHERE id = ?`,
    [row.quantity, row.permanent, expiresAt, reminded, expiryDone, source, note, grantedBy, now, intval(cur.id)]);
  } else {
    await db.exec(`INSERT INTO hc_entitlements (user_id, feature, lot, quantity, permanent, expires_at, source, reminded, expiry_done_at, note, granted_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uid, key, lot, row.quantity, row.permanent, expiresAt, source, reminded, expiryDone, note, grantedBy, now, now]);
  }
  // Premium: users.premium_until in derselben Transaktion (aktiv + dauerhaft → fernes Datum, aktiv → Ende, sonst NULL)
  if (key === 'premium') {
    const until = active ? (permanent ? PREMIUM_FOREVER : expiresAt) : null;
    await db.exec('UPDATE users SET premium_until = ? WHERE id = ?', [until, uid]);
  }
  await markReconcile(db, uid, now);
}
