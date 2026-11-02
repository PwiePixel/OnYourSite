// Premium: ein Status des Kontos, gespeichert in users.premium_until (NULL = kein Premium, ein Datum = bis dahin,
// '9999-12-31 23:59:59' = für immer) – geschrieben nur von setPeriod() in derselben Transaktion wie die Berechtigung
// `premium`. Admins haben Premium immer. Premium enthält genau die Vorteile, die andere Bereiche anmelden
// (registerPerk); Seitenzahl, Speicher und die Wartezeit für Adressen bleiben dem Team vorbehalten (isStaff).
// Alle Abfragen lesen die Datenbank, nie die Sitzung: Ein Admin im Nutzer-Modus sieht den echten Stand des Nutzers.
import type { Db, Row } from '../db.js';
import { phpTruthy } from '../php.js';
import { poolDb } from './util.js';
import { nowStr } from './clock.js';
import { premiumPerks, registerFeature } from './features.js';
import { PREMIUM_FOREVER } from './entitlements.js';

export { PREMIUM_FOREVER };

// Premium bleibt verborgen (keine Karte, kein Verkauf, kein Geschenk), bis premium-domains seinen Vorteil bereit meldet.
// Andere Vorteile (z. B. die der Statusseiten) ergänzen nur die Liste.
export function premiumReady(): boolean {
  return premiumPerks().some((p) => p.owner === 'premium-domains' && p.ready());
}

registerFeature({
  key: 'premium',
  owner: 'honeycomb-shop',
  title: 'Premium',
  icon: 'bx-crown',
  description: 'Your pages without OnYourSite branding, your own domain and more for status pages.',
  kind: 'timed',
  stack: 1,
  maxAheadDays: 400,
  minAccountDaysFloor: 30,
  ready: premiumReady,
  includedFor: (u) => phpTruthy(u.is_admin),
  // Startpreise (DECISIONS Q4); zeitlich begrenzte Optionen bleiben aus, bis der Ablauf bereit ist (HC-7a)
  items: {
    premium_30: { days: 30, price: 350, active: false, minAccountDays: 30, minActiveDays: 10 },
    premium_90: { days: 90, price: 700, active: false, minAccountDays: 30, minActiveDays: 10 },
  },
  href: '#honeycombs/premium',
});

// Premium auf einer geladenen users-Zeile (ohne Abfrage): Admin oder premium_until in der Zukunft
export function isPremiumRow(user: Row, now: string = nowStr()): boolean {
  if (phpTruthy(user.is_admin)) return true;
  return typeof user.premium_until === 'string' && user.premium_until > now;
}

export async function isPremium(uid: number, db: Db = poolDb): Promise<boolean> {
  const u = await db.one('SELECT is_admin, premium_until FROM users WHERE id = ?', [uid]);
  return u !== null && isPremiumRow(u);
}
// Andere Namen derselben Abfrage (code-slots-admin, status-pages)
export const premiumActive = isPremium;
export const userPremium = isPremium;

// Gespeichertes Ende (NULL ohne Premium; für immer: '9999-12-31 23:59:59')
export async function premiumUntil(uid: number, db: Db = poolDb): Promise<string | null> {
  const v = await db.value('SELECT premium_until FROM users WHERE id = ?', [uid]);
  return typeof v === 'string' ? v : null;
}

export interface PremiumState {
  active: boolean;
  until: string | null; // Ende eines zeitlich begrenzten Premium (auch ein vergangenes); null ohne oder für immer
  forever: boolean;
  source: 'admin-role' | 'purchase' | 'admin' | null; // Admin-Rolle, gekauft, vom Team geschenkt
}

export async function premiumState(uid: number, db: Db = poolDb): Promise<PremiumState> {
  const u = await db.one('SELECT is_admin, premium_until FROM users WHERE id = ?', [uid]);
  if (!u) return { active: false, until: null, forever: false, source: null };
  const stored = typeof u.premium_until === 'string' ? u.premium_until : null;
  const until = stored !== null && stored !== PREMIUM_FOREVER ? stored : null;
  if (phpTruthy(u.is_admin)) return { active: true, until, forever: true, source: 'admin-role' };
  if (stored === null || !(stored > nowStr())) return { active: false, until, forever: false, source: null };
  const lot = await db.one("SELECT source FROM hc_entitlements WHERE user_id = ? AND feature = 'premium' AND lot = 0", [uid]);
  return { active: true, until, forever: stored === PREMIUM_FOREVER, source: lot?.source === 'admin' ? 'admin' : 'purchase' };
}
