// Arten von Benachrichtigungen (Symbol, Farbe, Standard-Ziel in der Glocke) und Hinweise in JSON-Antworten.
// Jede Funktion schreibt ihre Benachrichtigungen mit notify() (notify.ts); hier steht nur, wie sie aussehen.
import { mbSubstr, phpTrim } from '../php.js';
import { safeLink } from './links.js';

export type Tone = 'ok' | 'info' | 'warn' | 'err' | 'hc';
const TONES: readonly Tone[] = ['ok', 'info', 'warn', 'err', 'hc'];

export interface NotifyType {
  icon: string;
  tone: Tone;
  link: string;
}

// Typ → Symbol (Boxicons), Farbe, Standard-Ziel. Suche: genauer Typ → Teil vor dem ersten „_“ → Standard (Glocke).
// Ziele ohne Doppelpunkt: /dashboard#<ziel>[/<arg>], /dashboard?page=<id>#settings/domain, /dashboard?site=<id>#code,
// /admin#<bereich>.
export const NOTIFY_TYPES: Readonly<Record<string, NotifyType>> = Object.freeze({
  message: { icon: 'bx-envelope', tone: 'info', link: '/dashboard#messages' },
  booking: { icon: 'bx-calendar-check', tone: 'info', link: '/dashboard#messages' },
  honeycombs: { icon: 'bx-hive', tone: 'hc', link: '/dashboard#honeycombs' }, // Geschenke, Abzüge, Erstattungen
  unlock: { icon: 'bx-hive', tone: 'hc', link: '/dashboard#honeycombs' }, // Freischaltungen, endet bald / beendet
  code: { icon: 'bx-code-alt', tone: 'warn', link: '/dashboard#code' }, // Code-Seite gesperrt, entsperrt, gelöscht
  domain: { icon: 'bx-globe', tone: 'info', link: '/dashboard#settings' }, // eigene Domain (Präfix)
  domain_live: { icon: 'bx-globe', tone: 'ok', link: '/dashboard#settings' },
  domain_back: { icon: 'bx-globe', tone: 'ok', link: '/dashboard#settings' },
  domain_problem: { icon: 'bx-globe', tone: 'warn', link: '/dashboard#settings' },
  domain_paused: { icon: 'bx-globe', tone: 'warn', link: '/dashboard#settings' },
  domain_removed: { icon: 'bx-globe', tone: 'warn', link: '/dashboard#settings' },
  status: { icon: 'bx-pulse', tone: 'warn', link: '/dashboard#status' }, // Statusseiten (Präfix, Admins)
  status_down: { icon: 'bx-pulse', tone: 'err', link: '/dashboard#status' },
  status_up: { icon: 'bx-pulse', tone: 'ok', link: '/dashboard#status' },
  status_team: { icon: 'bx-shield-quarter', tone: 'warn', link: '/dashboard#status' },
  team: { icon: 'bx-shield-quarter', tone: 'warn', link: '/admin' }, // nur über notifyAdmins()
  system: { icon: 'bx-bell', tone: 'info', link: '' }, // z. B. Adresse durch eine Migration geändert
});

const FALLBACK: NotifyType = Object.freeze({ icon: 'bx-bell', tone: 'info', link: '' });

// Aussehen eines Typs (auch für alte oder unbekannte Typen in der Datenbank)
export function notifyType(type: unknown): NotifyType {
  const t = typeof type === 'string' ? type : '';
  if (Object.hasOwn(NOTIFY_TYPES, t)) return NOTIFY_TYPES[t];
  const prefix = t.split('_', 1)[0];
  if (prefix !== t && Object.hasOwn(NOTIFY_TYPES, prefix)) return NOTIFY_TYPES[prefix];
  return FALLBACK;
}

// Hinweis in einer JSON-Antwort (Ergebnis der eigenen Aktion) oder beim Öffnen des Editors. Nur der gemeinsame
// Antwort-Handler im Browser zeigt sie an.
export interface Notice {
  tone: Tone;
  text: string;
  title?: string;
  // Honigwaben mit Vorzeichen (+50), als Abzeichen; der Text wiederholt die Zahl dann nicht
  amount?: number;
  action?: { label: string; link: string };
}

// Höchstens so viele Hinweise je Antwort bzw. beim Öffnen des Editors
export const NOTICES_MAX = 3;
export const BOOTSTRAP_NOTICES_MAX = 12;

// Hinweis prüfen und kürzen: Text ≤ 200, Titel ≤ 80, Knopf ≤ 40 Zeichen; Ziel nur als eigener relativer Pfad
// (sonst fällt der Knopf weg). Ohne Text gibt es keinen Hinweis (null).
export function notice(n: Notice): Notice | null {
  const text = mbSubstr(phpTrim(String(n.text ?? '')), 0, 200);
  if (text === '') return null;
  const out: Notice = { tone: TONES.includes(n.tone) ? n.tone : 'info', text };
  const title = n.title === undefined ? '' : mbSubstr(phpTrim(String(n.title)), 0, 80);
  if (title !== '') out.title = title;
  if (typeof n.amount === 'number' && Number.isSafeInteger(n.amount) && n.amount !== 0) out.amount = n.amount;
  if (n.action) {
    const label = mbSubstr(phpTrim(String(n.action.label ?? '')), 0, 40);
    const link = safeLink(n.action.link);
    if (label !== '' && link !== '') out.action = { label, link };
  }
  return out;
}

// Liste für eine Antwort: geprüft und höchstens max Einträge
export function notices(list: readonly Notice[], max: number = NOTICES_MAX): Notice[] {
  const out: Notice[] = [];
  for (const n of list) {
    if (out.length >= max) break;
    const ok = notice(n);
    if (ok) out.push(ok);
  }
  return out;
}
