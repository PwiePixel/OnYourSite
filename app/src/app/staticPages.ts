// Feste Seiten: /challenge, /imprint, /privacy, /terms, /terms/code-pages (views/*.php)
import type { Ctx } from '../web/ctx.js';
import { termsCodePages } from '../code/terms.js';
import { challengeView } from './views/challenge.js';
import { imprintView } from './views/imprint.js';
import { privacyView } from './views/privacy.js';
import { termsView } from './views/terms.js';

export type StaticPage = 'challenge' | 'imprint' | 'privacy' | 'terms' | 'terms-code-pages';

// require views/<name>.php; exit – die Sitzung hat dispatch schon gestartet (wie routes_app.php)
export async function staticPage(ctx: Ctx, name: StaticPage): Promise<void> {
  switch (name) {
    // Die Bedingungen der Code-Seiten gehören zu den Code-Seiten (Preise aus den Honigwaben-Einstellungen)
    case 'terms-code-pages': return termsCodePages(ctx);
    case 'challenge': ctx.write(challengeView()); return;
    case 'imprint': ctx.write(imprintView()); return;
    case 'privacy': ctx.write(privacyView()); return;
    case 'terms': ctx.write(termsView()); return;
  }
}
