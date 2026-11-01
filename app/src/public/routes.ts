// Öffentliche Endpunkte und Profilseiten (lib/routes_public.php und Teile von index.php)
import type { Ctx } from '../web/ctx.js';
import { notPorted } from '../web/notPorted.js';
import { botApi } from '../community/api.js';
import { loadPageBySlug } from '../content/pages.js';
import { codeSiteBySlug } from '../code/sites.js';
import { codeServe } from '../code/serve.js';

// /_/… auf jeder Adresse (Klicks, Freischalten, Kontakt, Termine, Vorschaubilder, Bot-Schnittstelle …)
export async function publicRoutes(ctx: Ctx): Promise<void> {
  // Schnittstelle für den Discord-Bot (signiert, siehe community/api.ts)
  if (ctx.path.startsWith('/_/bot/')) return botApi(ctx);
  notPorted(ctx, '/_/');
}
// POST /track-click (alte Klick-Zählung)
export async function trackClick(ctx: Ctx): Promise<void> {
  notPorted(ctx, '/track-click');
}
// on-your.site/name[/kalender] – sonst 404
export async function pathProfile(ctx: Ctx, _slug: string, _sub: string): Promise<void> {
  notPorted(ctx, 'profile (path)');
}
// name.on-your.site[/kalender] – Profil oder Code-Seite, sonst 404
export async function subdomain(ctx: Ctx, slug: string, _sub: string): Promise<void> {
  if (await loadPageBySlug(slug)) notPorted(ctx, 'profile (subdomain)');
  const site = await codeSiteBySlug(slug);
  if (site) return codeServe(ctx, site, ctx.path);
  notPorted(ctx, 'subdomain 404');
}
