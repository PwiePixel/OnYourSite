// Freischaltungen durch das Team (HC-6a): grantFeature() schenkt eine Funktion (dauerhaft, für Tage oder als Anzahl),
// revokeFeature() nimmt sie wieder weg. Beides unter der Kontosperre des Nutzers in einer Transaktion: Buchung,
// Berechtigung (setPeriod), Protokoll, Glocke (genau einmal, in derselben Transaktion) und markReconcile; nach dem
// Commit die schnellen Abgleiche.
//
// Schutz gegen doppeltes Absenden (ROADMAP §3.2, XD-15): zeitlich begrenzte und gezählte Geschenke sowie jeder Entzug
// brauchen formRef (16 hex) – eine 0-Buchung grant/g<adminId>-<formRef> bzw. revoke/v<adminId>-<formRef>; kommt sie
// ein zweites Mal, wird nichts geändert. Dauerhafte Freischaltungen bleiben über die Buchung unlock/<feature> einmalig.
import type { Db } from '../db.js';
import { intval, mbSubstr, phpStr, phpTruthy } from '../php.js';
import { notify } from '../notify/notify.js';
import { addDays, dayLabel, nowStr } from './clock.js';
import { LIFECYCLE_READY, feature, featureReady, type Feature } from './features.js';
import { BUSY, HC_BUSY_TEXT, credit, withAccount } from './ledger.js';
import { grantUnlock, isActive, setPeriod, type EntRow } from './entitlements.js';
import { reconcileNow } from './reconcile.js';
import { premiumReady } from './premium.js';
import { audit } from './audit.js';

export type GrantResult = { ok: string } | { error: string };

// Wie lange und wie viel: dauerhaft (bei zeitlich begrenzten: „für immer“), Tage (nur zeitlich begrenzte, erst mit
// dem Ablauf HC-7a) oder Anzahl (gezählte und Pässe). lot: Paket bei stapelbaren Funktionen (Standard 0).
export interface GrantMode {
  permanent?: boolean;
  days?: number;
  units?: number;
  lot?: number;
  formRef?: string;
}

export const FORM_REF = /^[0-9a-f]{16}$/;
// Admin-Geschenke sind nicht an die 400 Tage im Voraus gebunden, aber an 3650 Tage je Geschenk
export const MAX_GRANT_DAYS = 3650;
export const MAX_GRANT_UNITS = 10;

const TWICE = 'This was already booked – the form was sent twice.';

// Anzeigename: Name, sonst E-Mail
async function userLabel(db: Db, uid: number): Promise<string | null> {
  const u = await db.one('SELECT full_name, email FROM users WHERE id = ?', [uid]);
  if (!u) return null;
  return phpStr(u.full_name ?? '') !== '' ? phpStr(u.full_name) : phpStr(u.email);
}

// Gibt es die Buchung schon? (Groß/klein genau wie der eindeutige Schlüssel uq_entry)
async function booked(db: Db, uid: number, reason: string, ref: string): Promise<boolean> {
  return (await db.value('SELECT 1 FROM honeycomb_ledger WHERE user_id = ? AND reason = ? AND ref = ? LIMIT 1', [uid, reason, ref])) !== null;
}

// Bereit zum Vergeben? (registriert, bereit; Premium nur mit dem Bereich Domains/Branding)
function grantable(key: string): Feature | null {
  const f = feature(key);
  if (!f || !featureReady(f)) return null;
  if (f.key === 'premium' && !premiumReady()) return null;
  return f;
}

function lotOf(f: Feature, lot: number | undefined): number | null {
  const n = lot ?? 0;
  if (!Number.isInteger(n) || n < 0) return null;
  const most = f.kind === 'timed' ? (f.stack ?? 1) : 1;
  return n < most ? n : null;
}

export async function grantFeature(adminId: number, uid: number, key: string, mode: GrantMode, note = ''): Promise<GrantResult> {
  const f = grantable(key);
  if (!f) return { error: 'This feature can’t be given yet.' };
  const formRef = mode.formRef ?? '';
  const permanent = mode.permanent === true;
  const days = mode.days ?? 0;
  const units = mode.units ?? 0;
  if (permanent && f.kind === 'permanent') {
    if (formRef !== '' && !FORM_REF.test(formRef)) return { error: 'Please reload the page and try again.' };
  } else {
    // Alles außer der einfachen dauerhaften Freischaltung braucht den Schlüssel des Formulars
    if (!FORM_REF.test(formRef)) return { error: 'Please reload the page and try again.' };
    if (!permanent && f.kind === 'timed') {
      if (!LIFECYCLE_READY) return { error: 'Time-limited grants can’t be given yet – give it for good instead.' };
      if (!Number.isInteger(days) || days < 1 || days > MAX_GRANT_DAYS) return { error: 'Enter 1 to 3,650 days.' };
    } else if (!permanent && (f.kind === 'count' || f.kind === 'consumable')) {
      if (!Number.isInteger(units) || units < 1 || units > MAX_GRANT_UNITS) return { error: 'Enter a number from 1 to 10.' };
    } else if (!permanent) {
      return { error: 'Please choose how long.' };
    }
  }
  const lot = lotOf(f, mode.lot);
  if (lot === null) return { error: 'This pack doesn’t exist.' };
  const text = mbSubstr(note, 0, 150);
  const out = await withAccount(uid, async (db): Promise<GrantResult> => {
    const name = await userLabel(db, uid);
    if (name === null) return { error: 'Please choose a user.' };
    // Dasselbe Formular noch einmal: vor allen übrigen Prüfungen erkennen (unter der Sperre, also eindeutig)
    if (formRef !== '' && (await booked(db, uid, 'grant', 'g' + adminId + '-' + formRef))) return { error: TWICE };
    const now = nowStr();
    const lots = await db.q<EntRow>('SELECT * FROM hc_entitlements WHERE user_id = ? AND feature = ? FOR UPDATE', [uid, f.key]);
    const active = lots.filter((l) => isActive(l, now));
    let done: string;
    let details: Record<string, number | string | boolean | null>;
    if (permanent && f.kind === 'permanent') {
      // Einmalig über unlock/<feature>; schon aktiv → nichts gebucht
      const r = await grantUnlock(db, uid, f.key, 0, text, adminId, 'admin');
      if (r === null) return { error: name + ' already has this.' };
      done = f.title + ' given to ' + name + '.';
      details = { mode: 'permanent' };
    } else {
      if (active.some((l) => phpTruthy(l.permanent) && (f.kind === 'timed' || permanent))) return { error: name + ' already has this.' };
      const cur = lots.find((l) => intval(l.lot) === lot) ?? null;
      const curActive = cur !== null && isActive(cur, now);
      let quantity = 1;
      if (!permanent && f.kind !== 'timed') {
        const have = active.reduce((n, l) => n + intval(l.quantity), 0);
        if (f.max !== undefined && have + units > f.max) return { error: name + ' already has the maximum (' + f.max + ').' };
        quantity = (curActive ? intval(cur.quantity) : 0) + units;
      }
      // 0-Buchung als Schutz gegen das doppelte Absenden (vor jeder Änderung)
      if ((await credit(db, uid, 0, 'grant', 'g' + adminId + '-' + formRef, text !== '' ? text : f.title + ' from the team', adminId)) === null) return { error: TWICE };
      if (permanent) {
        await setPeriod(db, uid, f.key, lot, { quantity: Math.max(1, quantity), permanent: true, expiresAt: null, source: 'admin', note: text, grantedBy: adminId }, now);
        done = f.title + ' given to ' + name + ' for good.';
        details = { mode: 'permanent', lot };
      } else if (f.kind === 'timed') {
        // Verlängert ab dem späteren von jetzt und dem bisherigen Ende
        const from = curActive && cur.expires_at !== null && cur.expires_at > now ? cur.expires_at : now;
        const end = addDays(from, days);
        await setPeriod(db, uid, f.key, lot, { quantity: 1, permanent: false, expiresAt: end, source: 'admin', note: text, grantedBy: adminId }, now);
        done = f.title + ' given to ' + name + ' until ' + dayLabel(end) + '.';
        details = { mode: 'days', days, lot };
      } else {
        await setPeriod(db, uid, f.key, lot, { quantity, permanent: true, expiresAt: null, source: 'admin', note: text, grantedBy: adminId }, now);
        done = units + ' × ' + f.title + ' given to ' + name + '.';
        details = { mode: 'units', units, lot };
      }
    }
    await audit(db, adminId, 'feature_grant', uid, f.key, details);
    // Glocke in derselben Transaktion wie die Buchung: genau einmal
    await notify(uid, 'unlock', mbSubstr('The team gave you ' + f.title + '.', 0, 190), text, '/dashboard#honeycombs/' + f.key, { db });
    return { ok: done };
  });
  if (out === BUSY) return { error: HC_BUSY_TEXT };
  if ('ok' in out) await reconcileNow(uid, { inlineOnly: true });
  return out;
}

// Entzug: lot null = alle Pakete der Funktion. Premium nur, solange Premium bereit ist.
export async function revokeFeature(adminId: number, uid: number, key: string, lot: number | null, note: string, formRef: string): Promise<GrantResult> {
  const f = feature(key);
  if (!f) return { error: 'This feature doesn’t exist.' };
  if (f.key === 'premium' && !premiumReady()) return { error: 'Premium can’t be removed right now.' };
  if (!FORM_REF.test(formRef)) return { error: 'Please reload the page and try again.' };
  if (lot !== null && (!Number.isInteger(lot) || lot < 0 || lot > 9)) return { error: 'This pack doesn’t exist.' };
  const text = mbSubstr(note, 0, 150);
  const out = await withAccount(uid, async (db): Promise<GrantResult> => {
    const name = await userLabel(db, uid);
    if (name === null) return { error: 'Please choose a user.' };
    if (await booked(db, uid, 'revoke', 'v' + adminId + '-' + formRef)) return { error: TWICE };
    const now = nowStr();
    const lots = (await db.q<EntRow>('SELECT * FROM hc_entitlements WHERE user_id = ? AND feature = ? FOR UPDATE', [uid, f.key]))
      .filter((l) => isActive(l, now) && (lot === null || intval(l.lot) === lot));
    if (!lots.length) return { error: name + ' doesn’t have this.' };
    if ((await credit(db, uid, 0, 'revoke', 'v' + adminId + '-' + formRef, text !== '' ? text : f.title + ' removed by the team', adminId)) === null) return { error: TWICE };
    for (const l of lots) {
      // Inaktiv, Ende gilt als verarbeitet: der Ablauf schickt keinen zweiten „ended“-Hinweis
      await setPeriod(db, uid, f.key, intval(l.lot), { quantity: 0, permanent: false, expiresAt: now, expiryDoneAt: now, note: text, grantedBy: adminId }, now);
    }
    await audit(db, adminId, 'feature_revoke', uid, f.key, { lots: lots.length, lot });
    await notify(uid, 'unlock', mbSubstr(f.title + ' was removed by the team.', 0, 190), text, '/dashboard#honeycombs/' + f.key, { db });
    return { ok: f.title + ' removed from ' + name + '.' };
  });
  if (out === BUSY) return { error: HC_BUSY_TEXT };
  if ('ok' in out) await reconcileNow(uid, { inlineOnly: true });
  return out;
}
