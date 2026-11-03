// Statusseiten im Honigwaben-Shop: die dauerhafte Freischaltung `status_page` (ST-4, 150, für Admins immer dabei) und
// die zwei Zusatzpakete für 30 Tage (ST-7, DECISIONS Q4): „Extra checks“ (+10 Prüfungen, höchstens 2 zugleich, 60) und
// „Fast checks“ (jede Minute, 80). Premium enthält mehr für Statusseiten (Q1 = b) – als Vorteil angemeldet. Der Shop
// bucht, prüft den Preis und schreibt die Berechtigung; dieser Bereich entscheidet nur, wer kaufen darf. Ändert sich
// etwas, gleicht refreshStatusLimits sofort ab (status/limitsSync.ts).
import { phpTruthy } from '../php.js';
import { registerFeature, registerPerk, type BuyCheck } from '../honeycombs/features.js';
import { premiumState } from '../honeycombs/premium.js';
import { statusSettings } from './settings.js';

export const STATUS_FEATURE_KEY = 'status_page';
export const MORE_CHECKS_KEY = 'status_more_checks';
export const FAST_CHECKS_KEY = 'status_fast_checks';
export const STATUS_NEW_CLOSED = 'New status pages aren’t available right now.';

// Notschalter „neue Freischaltungen“ (allow_new) – geprüft in der Transaktion des Kaufs
async function buyRule(c: BuyCheck): Promise<string | null> {
  const s = await statusSettings(c.db);
  return s.allow_new ? null : STATUS_NEW_CLOSED;
}

registerFeature({
  key: STATUS_FEATURE_KEY,
  owner: 'status-pages',
  title: 'Status page',
  icon: 'bx-pulse',
  description: 'Your own status page at its own address: website checks, incidents and maintenance.',
  kind: 'permanent',
  includedFor: (u) => phpTruthy(u.is_admin),
  canBuy: buyRule,
  items: { status_page: { price: 150, active: true } },
  href: '#status',
});

// Zusatzpakete: nur mit einer eigenen Seite, die prüfen kann – sonst bezahlte niemand für Prüfungen, die nicht laufen
async function addonRule(c: BuyCheck): Promise<string | null> {
  const page = await c.db.one('SELECT id, is_blocked FROM status_pages WHERE user_id = ? AND is_system = 0', [c.uid]);
  if (!page) return 'Create your status page first.';
  if (phpTruthy(page.is_blocked)) return 'Your status page is blocked by the team.';
  const s = await statusSettings(c.db);
  if (!s.run_user_checks) return 'Checks are paused by the team right now – buying more checks isn’t possible.';
  if ((await premiumState(c.uid, c.db)).forever) return 'Your Premium already includes this.';
  return null;
}

registerFeature({
  key: MORE_CHECKS_KEY,
  owner: 'status-pages',
  title: 'Extra checks',
  icon: 'bx-pulse',
  description: '+10 checks for your status page for 30 days.',
  kind: 'timed',
  stack: 2,
  requires: STATUS_FEATURE_KEY,
  canBuy: addonRule,
  items: { status_more_checks_30: { days: 30, price: 60, active: true } },
  href: '#status',
});

registerFeature({
  key: FAST_CHECKS_KEY,
  owner: 'status-pages',
  title: 'Fast checks',
  icon: 'bx-pulse',
  description: 'Check your websites every minute for 30 days.',
  kind: 'timed',
  requires: STATUS_FEATURE_KEY,
  canBuy: addonRule,
  items: { status_fast_checks_30: { days: 30, price: 80, active: true } },
  href: '#status',
});

// Premium enthält mehr für Statusseiten (DECISIONS Q1 = b)
registerPerk('premium', { owner: 'status-pages', text: 'Status page: 30 checks and checks every minute', ready: () => true });
