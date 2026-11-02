// Code-Seiten im Honigwaben-Shop: die dauerhafte Freischaltung `code_page`. Sie gehört dem Bereich Code-Seiten (der
// später weitere Regeln wie Sperren ergänzt); der Shop bucht, prüft den Preis und schreibt die Berechtigung.
// Regel von heute: Wer die Regeln für Code-Seiten noch nicht akzeptiert hat, muss sie im Kaufdialog ankreuzen – die
// Zustimmung wird in derselben Transaktion wie der Kauf gespeichert.
import { phpTruthy } from '../php.js';
import { registerFeature, type BuyCheck } from '../honeycombs/features.js';
import { nowStr } from '../honeycombs/clock.js';
import { codeSettings } from './settings.js';
import './enforce.js';

export const CODE_TERMS_REQUIRED = 'Please read and accept the rules for code pages first.';
export const CODE_MORE_UNAVAILABLE = 'More code pages aren’t available right now.';

// Gesperrte Konten kaufen nichts für Code-Seiten (E1) – geprüft in der Transaktion des Kaufs
const bannedText = (u: BuyCheck['user']): string | null => phpTruthy(u.code_banned_at)
  ? 'Code pages have been turned off for your account by the team' + (phpTruthy(u.code_ban_reason) ? ': ' + String(u.code_ban_reason) : '.')
  : null;

async function termsRule(c: BuyCheck): Promise<string | null> {
  const banned = bannedText(c.user);
  if (banned !== null) return banned;
  if (phpTruthy(c.user.code_terms_at)) return null;
  if (!c.input.terms) return CODE_TERMS_REQUIRED;
  await c.db.exec('UPDATE users SET code_terms_at = ? WHERE id = ?', [nowStr(), c.uid]);
  return null;
}

registerFeature({
  key: 'code_page',
  owner: 'code-slots-admin',
  title: 'Code page',
  icon: 'bx-code-alt',
  description: 'Your own website with HTML, CSS and JavaScript at its own address.',
  kind: 'permanent',
  needsTerms: (u) => !phpTruthy(u.code_terms_at),
  canBuy: termsRule,
  // Startpreis 100 (DECISIONS Q4); ein bisher eingestellter Preis wird beim Anlegen übernommen
  items: { code_page: { price: 100, active: true } },
  href: '#code',
});

// Weitere Code-Seiten (über die erste hinaus): dauerhaft, braucht code_page. Startpreis 0 (DECISIONS Q4) – dann ist
// nichts zu kaufen. Nicht verkaufen, solange keine weitere Code-Seite möglich ist (keine Plätze freigegeben oder Pause).
async function moreRule(c: BuyCheck): Promise<string | null> {
  const banned = bannedText(c.user);
  if (banned !== null) return banned;
  const s = await codeSettings(c.db);
  if (s.max_on_pages === 0 || s.paused) return CODE_MORE_UNAVAILABLE;
  return termsRule(c);
}

registerFeature({
  key: 'code_more',
  owner: 'code-slots-admin',
  title: 'More code pages',
  icon: 'bx-code-alt',
  description: 'Show code pages on more of your page addresses.',
  kind: 'permanent',
  requires: 'code_page',
  freeAtZero: true,
  needsTerms: (u) => !phpTruthy(u.code_terms_at),
  canBuy: moreRule,
  items: { code_more: { price: 0, active: true } },
  href: '#code',
});
