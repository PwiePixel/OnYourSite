// Verdienen beim Öffnen des Editors (HC-8, honeycomb-shop §4.6): Tagesbelohnung, Serie (7 und 30 Tage in Folge),
// vollständiges Profil und Aufrufe – mit dem Tageslimit für die automatischen Belohnungen (Profil, Aufrufe).
// Ersetzt hcEarn auf GET /dashboard. hcEarn bleibt für den Vergleich mit PHP stehen.
//
// Ablauf: erst ohne Sperre lesen, ob heute überhaupt etwas zu holen ist (die meisten Aufrufe enden hier). Sonst die
// Kontosperre ohne Warten (NOWAIT): ist das Konto gerade gesperrt, wird nichts gebucht – beim nächsten Laden schon.
// Unter der Sperre bucht jede Belohnung über ihren eindeutigen Bezug (Grund + ref), also nie doppelt.
import type { Db, Row } from '../db.js';
import { date, intval, numberFormat, phpStr, strtotime } from '../php.js';
import { PhpNumber, jsonInt, jsonIsNumeric, phpJsonDecode, poolDb } from './util.js';
import { BUSY, credit, withAccount } from './ledger.js';
import { HC_MAX_VIEW_REWARDS, hcHas, hcProfileComplete, hcSettings, type HcEarned } from './honeycombs.js';

// Neue Schlüssel in oys_meta 'honeycombs' (neben daily, profile, views, views_step aus PHP)
export interface EarnLimits {
  streak_week: number; // Bonus alle 7 Tage in Folge
  streak_month: number; // Bonus alle 30 Tage in Folge (statt des 7-Tage-Bonus an diesem Tag)
  daily_cap: number; // höchstens so viele Honigwaben am Tag aus Profil und Aufrufen
}

export const EARN_DEFAULTS: Readonly<EarnLimits> = Object.freeze({ streak_week: 15, streak_month: 50, daily_cap: 300 });
export const EARN_KEYS = Object.keys(EARN_DEFAULTS) as Array<keyof EarnLimits>;
const RANGES: Readonly<Record<keyof EarnLimits, readonly [number, number]>> = { streak_week: [0, 100000], streak_month: [0, 100000], daily_cap: [50, 100000] };

// Gründe, die das Tageslimit zählt (später auch visitors, anniversary, referral)
export const CAPPED_REASONS: readonly string[] = ['profile', 'views'];

export const clampEarn = (key: keyof EarnLimits, n: number): number => Math.min(RANGES[key][1], Math.max(RANGES[key][0], n));

// Gleiche Regeln wie hcSettingsFrom: nur Zahlen zählen, sonst der Standardwert; dann begrenzen
export function earnLimitsFrom(raw: string): EarnLimits {
  const data = phpJsonDecode(raw, true);
  const isObj = data !== null && typeof data === 'object' && !(data instanceof PhpNumber);
  const out = { ...EARN_DEFAULTS };
  for (const key of EARN_KEYS) {
    const v = isObj && Object.hasOwn(data as object, key) ? (data as Record<string, unknown>)[key] : undefined;
    if (v !== undefined && v !== null && jsonIsNumeric(v)) out[key] = clampEarn(key, jsonInt(v));
  }
  return out;
}

export async function earnLimits(sql: Db = poolDb): Promise<EarnLimits> {
  return earnLimitsFrom(phpStr(await sql.value("SELECT meta_value FROM oys_meta WHERE meta_key = 'honeycombs'")));
}

const dayBefore = (day: string): string => date('Y-m-d', (strtotime(day + ' -1 day') as number));
// DATE aus der Datenbank (dateStrings) oder null
const dayOf = (v: unknown): string => (v === null || v === undefined ? '' : String(v).slice(0, 10));

// Serie für die Anzeige: zählt nur, solange sie heute oder gestern weiterlief
export interface StreakInfo { days: number; best: number; nextAt: number | null; nextAmount: number | null }

export function streakInfo(acc: Row | null, lim: EarnLimits, today: string = date('Y-m-d')): StreakInfo {
  const day = dayOf(acc?.streak_day);
  const days = day === today || day === dayBefore(today) ? intval(acc?.streak ?? 0) : 0;
  const next = nextBonus(days, lim);
  return { days, best: intval(acc?.best_streak ?? 0), nextAt: next ? next.at : null, nextAmount: next ? next.amount : null };
}

// Nächster Bonus nach `days` Tagen in Folge (30 geht vor 7) – oder null, wenn beide aus sind
export function nextBonus(days: number, lim: EarnLimits): { at: number; amount: number } | null {
  for (let n = days + 1; n <= days + 30; n++) {
    if (n % 30 === 0 && lim.streak_month > 0) return { at: n, amount: lim.streak_month };
    if (n % 30 !== 0 && n % 7 === 0 && lim.streak_week > 0) return { at: n, amount: lim.streak_week };
  }
  return null;
}

// Heute schon gezählte Honigwaben der begrenzten Gründe (Tag der Seite, wie die Bezüge)
export async function cappedToday(db: Db, uid: number, today: string = date('Y-m-d')): Promise<number> {
  return intval(await db.value(`SELECT COALESCE(SUM(amount), 0) FROM honeycomb_ledger WHERE user_id = ? AND reason IN (${CAPPED_REASONS.map(() => '?').join(', ')})
      AND created_at >= ? AND amount > 0`, [uid, ...CAPPED_REASONS, today + ' 00:00:00']));
}

// Höchstens einmal je 10 Sekunden und Konto in diesem Prozess (Bestmühe; NOWAIT hält es über Prozesse hinweg richtig)
const THROTTLE_MS = 10_000;
const THROTTLE_MAX = 10_000;
const lastRun = new Map<number, number>();

export function resetEarnThrottleForTests(): void {
  lastRun.clear();
}

function throttled(uid: number): boolean {
  const now = Date.now();
  const last = lastRun.get(uid);
  if (last !== undefined && now - last < THROTTLE_MS) return true;
  if (lastRun.size >= THROTTLE_MAX) lastRun.clear();
  lastRun.set(uid, now);
  return false;
}

// Beim Öffnen des Editors (nicht im Admin-Modus – das prüft der Aufrufer). Die neuen Buchungen als Meldungen.
export async function earnOnVisit(uid: number): Promise<HcEarned[]> {
  if (throttled(uid)) return [];
  const today = date('Y-m-d');
  const cfg = await hcSettings();
  const lim = await earnLimits();
  // Vor der Sperre: was ist heute noch offen?
  const acc0 = await poolDb.one('SELECT streak_day, frozen_at FROM hc_accounts WHERE user_id = ?', [uid]);
  // Angehalten: nichts zu holen, auch keine Sperre (unter der Sperre wird es noch einmal geprüft)
  if (acc0 && acc0.frozen_at !== null) return [];
  const firstToday = dayOf(acc0?.streak_day) !== today || (cfg.daily > 0 && !(await hcHas(uid, 'daily', today)));
  // Eine Belohnung über dem Tageslimit lässt sich nie zahlen – dafür keine Sperre holen
  const wantProfile = cfg.profile > 0 && cfg.profile <= lim.daily_cap && !(await hcHas(uid, 'profile', 'complete')) && (await hcProfileComplete(uid));
  let viewsLevel = 0;
  if (cfg.views > 0 && cfg.views <= lim.daily_cap) {
    const have = intval(await poolDb.value("SELECT COUNT(*) FROM honeycomb_ledger WHERE user_id = ? AND reason = 'views'", [uid]));
    if (have < HC_MAX_VIEW_REWARDS && !(await hcHas(uid, 'views', today))) {
      const level = (have + 1) * cfg.views_step;
      const views = intval(await poolDb.value('SELECT COALESCE(SUM(views), 0) FROM pages WHERE user_id = ?', [uid]));
      if (views >= level) viewsLevel = level;
    }
  }
  if (!firstToday && !wantProfile && viewsLevel === 0) return [];

  const out = await withAccount(uid, async (db, acc) => {
    const earned: HcEarned[] = [];
    if (acc.frozen_at !== null) return earned;
    if (cfg.daily > 0 && (await credit(db, uid, cfg.daily, 'daily', today)) !== null) earned.push({ amount: cfg.daily, text: 'for being active today' });
    // Serie: einmal am Tag weiterzählen (gestern da → +1, sonst neu ab 1)
    const day = dayOf(acc.streak_day);
    if (day !== today) {
      const streak = Math.min(65535, day === dayBefore(today) ? intval(acc.streak) + 1 : 1);
      await db.exec('UPDATE hc_accounts SET streak = ?, streak_day = ?, best_streak = GREATEST(best_streak, ?) WHERE user_id = ?', [streak, today, streak, uid]);
      if (streak % 30 === 0) {
        if (lim.streak_month > 0 && (await credit(db, uid, lim.streak_month, 'streak', 'm' + today)) !== null) earned.push({ amount: lim.streak_month, text: 'for a 30-day streak' });
      } else if (streak % 7 === 0 && lim.streak_week > 0 && (await credit(db, uid, lim.streak_week, 'streak', 'w' + today)) !== null) {
        earned.push({ amount: lim.streak_week, text: 'for a 7-day streak' });
      }
    }
    // Tageslimit unter der Sperre: zwei Anfragen zugleich können es nicht überschreiten
    let used = await cappedToday(db, uid, today);
    if (wantProfile && used + cfg.profile <= lim.daily_cap && (await credit(db, uid, cfg.profile, 'profile', 'complete')) !== null) {
      used += cfg.profile;
      earned.push({ amount: cfg.profile, text: 'for completing your profile' });
    }
    if (viewsLevel > 0 && used + cfg.views <= lim.daily_cap && (await credit(db, uid, cfg.views, 'views', today, String(viewsLevel))) !== null) {
      earned.push({ amount: cfg.views, text: 'for ' + numberFormat(viewsLevel) + ' page views' });
    }
    return earned;
  }, { nowait: true });
  return out === BUSY ? [] : out;
}

// Serie eines Kontos für Editor und Shop
export async function streakOf(uid: number, sql: Db = poolDb): Promise<StreakInfo> {
  return streakInfo(await sql.one('SELECT streak, streak_day, best_streak FROM hc_accounts WHERE user_id = ?', [uid]), await earnLimits(sql));
}
