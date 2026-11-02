// Einstellungen der Code-Seiten (oys_meta 'code_pages', einfaches JSON): Grenzen je Code-Seite, wie viele Seitenplätze
// eines Kontos eine Code-Seite zeigen dürfen, und die Pause des Teams. Eine fehlende oder kaputte Zeile ergibt die
// Standardwerte (die bisherigen Konstanten). max_on_pages bleibt 0, bis die Moderation da ist – vorher ist über die
// Seitenplätze nichts erreichbar, auch nicht aus der Browser-Konsole.
import type { Db } from '../db.js';
import { poolDb } from '../honeycombs/util.js';
import { config } from '../config.js';
import { intval, isNumeric } from '../php.js';

export interface CodeSettings {
  max_on_pages: number;
  max_files: number;
  max_file_kb: number;
  max_total_kb: number;
  paused: boolean;
}

export const CODE_SETTINGS_KEY = 'code_pages';

export const CODE_SETTINGS_DEFAULTS: Readonly<CodeSettings> = Object.freeze({
  max_on_pages: 1, max_files: 30, max_file_kb: 256, max_total_kb: 2048, paused: false,
});

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

// Wert lesen wie hcSettingsFrom: nur Zahlen (is_numeric → intval), sonst der Standardwert; dann begrenzen
function num(raw: Record<string, unknown>, key: keyof CodeSettings, lo: number, hi: number): number {
  const v = raw[key];
  const n = (typeof v === 'number' || typeof v === 'string') && isNumeric(v) ? intval(v) : (CODE_SETTINGS_DEFAULTS[key] as number);
  return clamp(n, lo, hi);
}

// Rohwert (JSON-Text oder Objekt) → Einstellungen. maxPages = max_pages der Seite (max_on_pages höchstens so viel).
export function codeSettingsFrom(raw: unknown, maxPages: number = intval(config('max_pages', 3))): CodeSettings {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { obj = null; }
  }
  const r = obj !== null && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : {};
  const maxFileKb = num(r, 'max_file_kb', 16, 1024);
  return {
    max_on_pages: num(r, 'max_on_pages', 0, Math.max(0, Math.min(3, maxPages))),
    max_files: num(r, 'max_files', 1, 100),
    max_file_kb: maxFileKb,
    max_total_kb: Math.max(maxFileKb, num(r, 'max_total_kb', 256, 5120)),
    paused: r.paused === true,
  };
}

// Innerhalb der Platz-Sperre mit deren db aufrufen
export async function codeSettings(db: Db = poolDb): Promise<CodeSettings> {
  return codeSettingsFrom(await db.value('SELECT meta_value FROM oys_meta WHERE meta_key = ?', [CODE_SETTINGS_KEY]));
}

// Speichern (Admin-Formular, Tests): fehlende Felder behalten ihren gespeicherten Wert; gespeichert wird der begrenzte Stand
export async function saveCodeSettings(patch: Partial<CodeSettings>, db: Db = poolDb): Promise<CodeSettings> {
  const next = codeSettingsFrom({ ...(await codeSettings(db)), ...patch });
  await db.exec('REPLACE INTO oys_meta (meta_key, meta_value) VALUES (?, ?)', [CODE_SETTINGS_KEY, JSON.stringify(next)]);
  return next;
}

// Grenzen für den Editor-Zustand und die Seite mit den Regeln (Bytes wie bisher)
export interface CodeLimits { files: number; file: number; total: number }
export const codeLimits = (s: CodeSettings): CodeLimits => ({ files: s.max_files, file: s.max_file_kb * 1024, total: s.max_total_kb * 1024 });
