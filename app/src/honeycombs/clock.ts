// Zeiten des Shops: Wanduhrzeit der Seite als DATETIME-Text ('Y-m-d H:i:s' in config.timezone), wie jede andere
// Tabelle sie speichert. Laufzeiten zählen Kalendertage (strtotime('+30 days')), auch über eine Zeitumstellung.
import { date, strtotime, time } from '../php.js';

// Jetzt (oder eine Unixzeit) als DATETIME-Text
export const nowStr = (unix: number = time()): string => date('Y-m-d H:i:s', unix);

// DATETIME-Text → Unixzeit (Zeitzone der Seite)
export function toUnix(dt: string): number {
  const t = strtotime(dt);
  if (t === false) throw new Error(`invalid date: ${dt}`);
  return t;
}

// Kalendertage addieren (Uhrzeit bleibt, auch über die Sommerzeit hinweg)
export function addDays(dt: string, days: number): string {
  if (!Number.isInteger(days)) throw new Error(`invalid number of days: ${days}`);
  const t = strtotime(`${dt} ${days >= 0 ? '+' : ''}${days} days`);
  if (t === false) throw new Error(`invalid date: ${dt}`);
  return nowStr(t);
}

// Sekunden addieren (Erstattung: Zeitraum verkürzen)
export const addSeconds = (dt: string, seconds: number): string => nowStr(toUnix(dt) + seconds);

// Datum für Texte, z. B. „Dec 1, 2026“
export const dayLabel = (dt: string): string => date('M j, Y', toUnix(dt));
