// Einstiegspunkte der einzelnen Bereiche. Jeder Bereich trägt hier seine Funktion ein (siehe routes/*.ts);
// solange ein Bereich noch fehlt, antwortet er mit 501, damit der Vergleich mit PHP die Lücke zeigt.
import type { Ctx } from '../web/ctx.js';

type Handler = (ctx: Ctx) => Promise<void>;

const notPorted = (name: string): Handler => async (ctx) => {
  ctx.status = 501;
  ctx.header('Content-Type', 'text/plain; charset=utf-8');
  ctx.write(`Not ported yet: ${name}`);
  ctx.halt();
};

export const routes = {
  // /static/uploads/{name} außerhalb des Code-Ordners (lib/storage.php)
  serveUpload: (async (ctx: Ctx, _name: string) => notPorted('uploads')(ctx)) as (ctx: Ctx, name: string) => Promise<void>,
  // /api.php
  api: notPorted('api.php'),
  adminImpersonate: notPorted('admin_impersonate.php'),
  adminReturn: notPorted('admin_return.php'),
  // /_/… (lib/routes_public.php)
  publicRoutes: notPorted('/_/'),
  // POST /track-click
  trackClick: notPorted('/track-click'),
  // App-Seiten der Hauptdomain (lib/routes_app.php)
  appRoutes: notPorted('app routes'),
  // on-your.site/name[/kalender]
  pathProfile: (async (ctx: Ctx) => notPorted('profile (path)')(ctx)) as (ctx: Ctx, slug: string, sub: string) => Promise<void>,
  // name.on-your.site (Profil oder Code-Seite)
  subdomain: (async (ctx: Ctx) => notPorted('subdomain')(ctx)) as (ctx: Ctx, slug: string, sub: string) => Promise<void>,
  // 404-Seite
  notFound: notPorted('404 view'),
};
