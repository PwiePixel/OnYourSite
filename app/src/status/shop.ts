// Statusseiten im Honigwaben-Shop (ST-4): die dauerhafte Freischaltung `status_page` – ein Preis, keine Miete,
// für Admins immer dabei (ROADMAP §3.2, Startpreis 150 nach DECISIONS Q4). Der Shop bucht, prüft den Preis und schreibt
// die Berechtigung; dieser Bereich entscheidet nur, ob neue Freischaltungen gerade erlaubt sind.
import { phpTruthy } from '../php.js';
import { registerFeature, type BuyCheck } from '../honeycombs/features.js';
import { statusSettings } from './settings.js';

export const STATUS_FEATURE_KEY = 'status_page';
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
