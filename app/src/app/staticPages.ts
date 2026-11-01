// Feste Seiten: /challenge, /imprint, /privacy, /terms, /terms/code-pages (views/*.php)
import type { Ctx } from '../web/ctx.js';
import { notPorted } from '../web/notPorted.js';

export type StaticPage = 'challenge' | 'imprint' | 'privacy' | 'terms' | 'terms-code-pages';

export async function staticPage(ctx: Ctx, name: StaticPage): Promise<void> {
  notPorted(ctx, name);
}
