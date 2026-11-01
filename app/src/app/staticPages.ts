// Feste Seiten: /challenge, /imprint, /privacy, /terms, /terms/code-pages (views/*.php)
import type { Ctx } from '../web/ctx.js';
import { notPorted } from '../web/notPorted.js';
import { termsCodePages } from '../code/terms.js';

export type StaticPage = 'challenge' | 'imprint' | 'privacy' | 'terms' | 'terms-code-pages';

export async function staticPage(ctx: Ctx, name: StaticPage): Promise<void> {
  // Die Bedingungen der Code-Seiten gehören zu den Code-Seiten (Preise aus den Honigwaben-Einstellungen)
  if (name === 'terms-code-pages') return termsCodePages(ctx);
  notPorted(ctx, name);
}
