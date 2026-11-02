// Honigwaben (lib/honeycombs.php): Punkte für aktive Nutzung, mit denen man Extras freischaltet (z. B. eine Code-Seite).
// Jede Buchung steht in honeycomb_ledger. Grund + Bezug sind eindeutig – so kann niemand etwas doppelt verdienen.
// Seit dem Shop-Kern laufen Ausgaben und Admin-Buchungen unter der Kontosperre (ledger.ts) und jede Freischaltung
// schreibt zugleich die Berechtigung (entitlements.ts) – auch über hcAdd(…, 'unlock', …).
import type { Db, Row } from '../db.js';
import { date, field, intval, numberFormat, phpStr, ucfirst, type PhpArray } from '../php.js';
import { cleanText } from '../helpers.js';
import { notify } from '../notify/notify.js';
import { phpJson } from '../html.js';
import { randomHex } from '../crypto.js';
import { PhpNumber, jsonInt, jsonIsNumeric, phpInt, phpJsonDecode, poolDb } from './util.js';
import { BUSY, HC_BUSY_TEXT, balanceIn, credit, lockedAccount, withAccount } from './ledger.js';
import { grantUnlock, has } from './entitlements.js';
import { feature } from './features.js';
import { shopPrice } from './catalogue.js';
import { adminShopHandle } from './admin.js';
import { reconcileNow } from './reconcile.js';

export interface HcSettings {
  daily: number;
  profile: number;
  views: number;
  views_step: number;
  code_page: number;
}
export interface HcEarned { amount: number; text: string }
export interface HcHistoryItem { amount: number; text: string; at: string }
export interface HcEditor {
  balance: number;
  earned: HcEarned[];
  history: HcHistoryItem[];
  rules: HcSettings;
  today: boolean;
  profile: boolean;
  viewRewards: number;
  maxViewRewards: number;
  codeUnlocked: boolean;
}
export type AdminResult = { ok: string } | { error: string } | null;

// oys_hc_defaults()
export function hcDefaults(): HcSettings {
  return {
    daily: 5, // an jedem Tag, an dem man den Editor öffnet
    profile: 20, // einmalig: Profilbild, Bio und mindestens 3 Links
    views: 10, // je erreichte Stufe an Aufrufen …
    views_step: 100, // … alle 100 Aufrufe (eine Stufe pro Tag, höchstens HC_MAX_VIEW_REWARDS-mal)
    code_page: 100, // früherer Preis der Code-Seite – heute steht er im Katalog (hc_items), hier nur noch das alte Feld
  };
}

export const HC_MAX_VIEW_REWARDS = 20;

const KEYS = Object.keys(hcDefaults()) as Array<keyof HcSettings>;
const clamp = (n: number): number => Math.max(0, Math.min(100000, n));

// oys_hc_settings(): gespeicherte Werte (nur Zahlen, 0–100000) über den Vorgaben
export async function hcSettings(sql: Db = poolDb): Promise<HcSettings> {
  return hcSettingsFrom(phpStr(await sql.value("SELECT meta_value FROM oys_meta WHERE meta_key = 'honeycombs'")));
}

// Gleiche Regeln für einen gespeicherten Text (fehlende Zeile = '')
export function hcSettingsFrom(raw: string): HcSettings {
  const data = phpJsonDecode(raw, true);
  const s = hcDefaults();
  // is_array(): Objekt oder Liste aus dem JSON (keine einzelne Zahl)
  const isArray = data !== null && typeof data === 'object' && !(data instanceof PhpNumber);
  for (const key of KEYS) {
    const v = isArray ? (data as Record<string, unknown>)[key] : undefined;
    if (isArray && Object.hasOwn(data as object, key) && v !== null && jsonIsNumeric(v)) s[key] = clamp(jsonInt(v));
  }
  s.views_step = Math.max(1, s.views_step);
  return s;
}

// oys_hc_save_settings(): Formularwerte als ganze Zahlen 0–100000
export async function hcSaveSettings(input: PhpArray, sql: Db = poolDb): Promise<void> {
  const defaults = hcDefaults();
  const s = {} as HcSettings;
  for (const key of KEYS) s[key] = clamp(phpInt(input[key] ?? defaults[key]));
  s.views_step = Math.max(1, s.views_step);
  await sql.exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('honeycombs', ?)", [phpJson(s)]);
}

// oys_hc_balance()
export async function hcBalance(userId: number, sql: Db = poolDb): Promise<number> {
  return intval(await sql.value('SELECT COALESCE(SUM(amount), 0) FROM honeycomb_ledger WHERE user_id = ?', [userId]));
}

// oys_hc_has()
export async function hcHas(userId: number, reason: string, ref: string, sql: Db = poolDb): Promise<boolean> {
  return !!(await sql.value('SELECT 1 FROM honeycomb_ledger WHERE user_id = ? AND reason = ? AND ref = ? LIMIT 1', [userId, reason, ref]));
}

// Die Kontosperre wurde nicht frei (hcAdd mit 'unlock' kann nicht „schon gebucht“ melden, wenn es nicht stimmt)
export class HcBusyError extends Error {
  constructor() {
    super(HC_BUSY_TEXT);
  }
}

// oys_hc_add(): bucht Honigwaben (+ verdient, − ausgegeben). false, wenn es diese Buchung schon gibt.
// reason 'unlock' ist eine Freischaltung: Buchung + Berechtigung über grantUnlock() – unter der Kontosperre (fehlt sie,
// holt hcAdd sie selbst). false heißt dann: war schon freigeschaltet.
export async function hcAdd(userId: number, amount: number, reason: string, ref: string, note = '', sql: Db = poolDb): Promise<boolean> {
  if (reason === 'unlock') {
    const source = amount < 0 ? 'purchase' : 'admin';
    // In der Kontosperre des Aufrufers: in dessen Transaktion; den Abgleich startet er selbst nach seinem Commit
    if (lockedAccount() === userId) return (await grantUnlock(sql, userId, ref, amount, note, null, source)) !== null;
    const booked = await withAccount(userId, async (db) => (await grantUnlock(db, userId, ref, amount, note, null, source)) !== null);
    if (booked === BUSY) throw new HcBusyError();
    // Nach dem Commit, ohne gehaltene Verbindung: die schnellen Abgleiche (z. B. Code-Seiten), die übrigen der Job
    await reconcileNow(userId, { inlineOnly: true });
    return booked;
  }
  return (await credit(sql, userId, amount, reason, ref, note)) !== null;
}

// oys_hc_history(): neueste Buchungen zuerst
export async function hcHistory(userId: number, limit = 20, sql: Db = poolDb): Promise<HcHistoryItem[]> {
  const rows = await sql.q(`SELECT amount, reason, ref, note, created_at FROM honeycomb_ledger WHERE user_id = ? ORDER BY id DESC LIMIT ${Math.max(1, Math.trunc(limit))}`, [userId]);
  return rows.map((r) => ({ amount: intval(r.amount), text: hcDescribe(r), at: phpStr(r.created_at) }));
}

// oys_hc_describe(): Text einer Buchung für Nutzer und Admin
export function hcDescribe(r: Row): string {
  const note = phpStr(r.note);
  switch (phpStr(r.reason)) {
    case 'daily':
      return 'Active on OnYourSite';
    case 'profile':
      return 'Profile completed';
    case 'views':
      return numberFormat(intval(r.note)) + ' page views reached';
    case 'unlock':
      return unlockText(phpStr(r.ref));
    case 'admin':
      return note !== '' ? note : intval(r.amount) >= 0 ? 'Gift from the team' : 'Correction by the team';
    // Gründe des Shops (Notiz = Titel der Option oder Notiz des Teams)
    case 'purchase':
      return (phpStr(r.ref).startsWith('auto-') ? 'Renewed ' : 'Bought ') + (note !== '' ? note : 'an extra');
    case 'grant':
      return note !== '' ? note : 'From the team';
    case 'revoke':
      return note !== '' ? note : 'Removed by the team';
    case 'refund':
      return note !== '' ? note : 'Refund';
    case 'reversal':
      return note !== '' ? note : 'Correction by the team';
    case 'streak':
      return phpStr(r.ref).startsWith('m') ? '30-day streak' : '7-day streak';
    case 'code':
      return note !== '' ? note : 'Code redeemed';
  }
  return note !== '' ? note : ucfirst(phpStr(r.reason));
}

// Freischaltung: <Funktion> oder <Funktion>:<n> (erneut nach einer Erstattung) – Groß/klein genau wie bisher
function unlockText(ref: string): string {
  const m = /^([a-z][a-z0-9_]{1,39})(?::[1-9][0-9]{0,5})?$/.exec(ref);
  if (!m) return 'Unlocked an extra';
  if (m[1] === 'code_page') return 'Unlocked your code page';
  if (m[1] === 'code_more') return 'Unlocked more code pages';
  const f = feature(m[1]);
  return f ? 'Unlocked ' + f.title : 'Unlocked an extra';
}

// oys_hc_profile_complete(): eine Seite mit Profilbild, Text und mindestens 3 sichtbaren Links
export async function hcProfileComplete(userId: number, sql: Db = poolDb): Promise<boolean> {
  return !!(await sql.value(`SELECT p.id FROM pages p WHERE p.user_id = ? AND p.avatar IS NOT NULL AND p.avatar <> ''
        AND (COALESCE(p.bio, '') <> '' OR p.subtitle <> '')
        AND (SELECT COUNT(*) FROM page_blocks b WHERE b.page_id = p.id AND b.type = 'link' AND b.is_visible = 1) >= 3 LIMIT 1`, [userId]));
}

// oys_hc_earn(): Verdienen beim Öffnen des Editors – die neuen Buchungen (für die Meldung im Editor)
export async function hcEarn(userId: number, sql: Db = poolDb): Promise<HcEarned[]> {
  const cfg = await hcSettings(sql);
  const earned: HcEarned[] = [];
  if (cfg.daily > 0 && (await hcAdd(userId, cfg.daily, 'daily', date('Y-m-d'), '', sql))) {
    earned.push({ amount: cfg.daily, text: 'for being active today' });
  }
  if (cfg.profile > 0 && !(await hcHas(userId, 'profile', 'complete', sql)) && (await hcProfileComplete(userId, sql))
    && (await hcAdd(userId, cfg.profile, 'profile', 'complete', '', sql))) {
    earned.push({ amount: cfg.profile, text: 'for completing your profile' });
  }
  // Aufrufe lassen sich leicht künstlich hochtreiben: höchstens eine Stufe pro Tag (Bezug = Datum)
  if (cfg.views > 0) {
    const have = intval(await sql.value("SELECT COUNT(*) FROM honeycomb_ledger WHERE user_id = ? AND reason = 'views'", [userId]));
    const level = (have + 1) * cfg.views_step;
    if (have < HC_MAX_VIEW_REWARDS) {
      const views = intval(await sql.value('SELECT COALESCE(SUM(views), 0) FROM pages WHERE user_id = ?', [userId]));
      if (views >= level && (await hcAdd(userId, cfg.views, 'views', date('Y-m-d'), String(level), sql))) {
        earned.push({ amount: cfg.views, text: 'for ' + numberFormat(level) + ' page views' });
      }
    }
  }
  return earned;
}

export const HC_BUSY = HC_BUSY_TEXT;

// oys_hc_locked(): Sperre je Nutzer – gleichzeitige Buchungen (zwei Klicks, ein Admin) dürfen den Kontostand nicht
// unter 0 bringen. Seit dem Shop-Kern die Kontosperre (Zeile in hc_accounts, eine Transaktion): fn arbeitet nur über
// sql. Gibt zurück, was fn zurückgibt – oder die Meldung, wenn die Sperre nicht innerhalb von 5 Sekunden frei wird.
export async function hcLocked<T>(userId: number, fn: (sql: Db) => Promise<T>): Promise<T | string> {
  const out = await withAccount(userId, (db) => fn(db));
  return out === BUSY ? HC_BUSY : out;
}

// oys_hc_spend(): mit Honigwaben dauerhaft freischalten (je Funktion nur einmal). Fehlermeldung oder null.
// Wer die Funktion schon hat, zahlt nichts; eine erstattete Freischaltung kostet erneut.
export async function hcSpend(userId: number, cost: number, ref: string): Promise<string | null> {
  const out = await hcLocked(userId, async (sql) => {
    if (await has(userId, ref, sql)) return null;
    const balance = await balanceIn(sql, userId);
    if (balance < cost) return 'You need ' + cost + ' honeycombs – you have ' + balance + '.';
    await grantUnlock(sql, userId, ref, 0 - cost, '', null, 'purchase');
    return null;
  });
  // Nach dem Commit: die schnellen Abgleiche (ohne Merker kehrt reconcileNow sofort zurück)
  if (out !== HC_BUSY) await reconcileNow(userId, { inlineOnly: true });
  return out;
}

// oys_hc_for_editor(): Kontostand, Verlauf und wie man mehr verdient (Schlüssel-Reihenfolge wie in PHP)
export async function hcForEditor(userId: number, earned: HcEarned[] = [], sql: Db = poolDb): Promise<HcEditor> {
  const cfg = await hcSettings(sql);
  const viewRewards = intval(await sql.value("SELECT COUNT(*) FROM honeycomb_ledger WHERE user_id = ? AND reason = 'views'", [userId]));
  return {
    balance: await hcBalance(userId, sql),
    earned,
    history: await hcHistory(userId, 15, sql),
    // Preis der Code-Seite aus dem Katalog (mit Angebot für dieses Konto) – nicht mehr aus den Einstellungen
    rules: { ...cfg, code_page: await shopPrice('code_page', userId, sql) },
    today: await hcHas(userId, 'daily', date('Y-m-d'), sql),
    profile: await hcHas(userId, 'profile', 'complete', sql),
    viewRewards,
    maxViewRewards: HC_MAX_VIEW_REWARDS,
    codeUnlocked: await has(userId, 'code_page', sql),
  };
}

// ---------------------------------------------------------------
// Admin: Einstellungen, vergeben/abziehen
// ---------------------------------------------------------------

// oys_admin_hc_handle(): $post wie $_POST, adminId = angemeldeter Admin. null = keine bekannte Aktion.
// Sperren, Entsperren und Freischalten der Code-Seiten gehören zum eigenen Bereich (code/admin.ts). Regeln, Katalog
// und Angebote (Unterbereiche des Shops) erledigt admin.ts; die Preise stehen nur noch im Katalog.
export async function adminHcHandle(post: PhpArray, adminId: number): Promise<AdminResult> {
  const action = field(post, 'hc_action');
  switch (action) {
    case 'grant': {
      const userId = phpInt(post.user_id ?? 0);
      const amount = phpInt(post.amount ?? 0);
      const user = await poolDb.one('SELECT id, full_name, email FROM users WHERE id = ?', [userId]);
      if (!user) return { error: 'Please choose a user.' };
      if (amount === 0 || Math.abs(amount) > 100000) return { error: 'Enter an amount between −100,000 and 100,000 (not 0).' };
      const note = cleanText(post.note ?? '', 150);
      // Jedes Formular hat einen eigenen Schlüssel: doppelt abgeschickt wird nur einmal gebucht
      const formRef = field(post, 'grant_ref');
      const ref = 'a' + adminId + '-' + (/^[0-9a-f]{16}\n?$/.test(formRef) ? formRef : randomHex(8));
      const booked = await hcLocked(userId, async (sql) => {
        if (amount < 0 && (await hcBalance(userId, sql)) + amount < 0) {
          return 'That would take the balance below 0 (current: ' + (await hcBalance(userId, sql)) + ').';
        }
        if ((await credit(sql, userId, amount, 'admin', ref, note, adminId)) === null) return 'This was already booked – the form was sent twice.';
        // Glocke nur, wenn gebucht wurde – in derselben Transaktion, also genau einmal
        await notify(userId, 'honeycombs', (amount > 0 ? '+' + amount + ' honeycombs from the team' : '−' + -amount + ' honeycombs (correction by the team)'), note, '/dashboard#honeycombs', { db: sql });
        return true;
      });
      if (booked !== true) return { error: booked };
      const name = phpStr(user.full_name ?? '') !== '' ? phpStr(user.full_name) : phpStr(user.email);
      return { ok: (amount > 0 ? '+' : '−') + Math.abs(amount) + ' honeycombs for ' + name + '. New balance: ' + (await hcBalance(userId)) + '.' };
    }
  }
  return adminShopHandle(post, adminId);
}
