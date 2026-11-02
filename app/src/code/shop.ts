// Code-Seiten im Honigwaben-Shop: die dauerhafte Freischaltung `code_page`. Sie gehört dem Bereich Code-Seiten (der
// später weitere Regeln wie Sperren ergänzt); der Shop bucht, prüft den Preis und schreibt die Berechtigung.
// Regel von heute: Wer die Regeln für Code-Seiten noch nicht akzeptiert hat, muss sie im Kaufdialog ankreuzen – die
// Zustimmung wird in derselben Transaktion wie der Kauf gespeichert.
import { phpTruthy } from '../php.js';
import { registerFeature, type BuyCheck } from '../honeycombs/features.js';
import { nowStr } from '../honeycombs/clock.js';

export const CODE_TERMS_REQUIRED = 'Please read and accept the rules for code pages first.';

async function termsRule(c: BuyCheck): Promise<string | null> {
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
