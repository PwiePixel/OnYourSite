// Routen der Hauptdomain (lib/routes_app.php): Startseite, Updates, Login, Registrierung, Admin, Editor.
// Hier steht nur die Reihenfolge – genau wie in PHP. Jede Aufgabe steckt in ihrer eigenen Datei.
import type { Ctx } from '../web/ctx.js';
import { Session, SESSION_COOKIE } from '../web/session.js';
import { intval, phpTruthy } from '../php.js';
import { currentUser } from './context.js';
import { staticPage, type StaticPage } from './staticPages.js';
import { landing } from './landing.js';
import { login, logout, register } from './auth.js';
import { dashboard } from './dashboard.js';
import { editorApi } from './editorApi.js';
import { adminPage } from '../admin/page.js';
import { roadmapPage, updateLink, updatesFeed, updatesPage } from '../updates/pages.js';
import { notFound } from '../public/notFound.js';

// Startseite und Updates setzen für Besucher kein Cookie
const COOKIELESS = new Set(['/', '/updates', '/updates/feed.xml', '/roadmap']);
const STATIC = new Map<string, StaticPage>([
  ['/challenge', 'challenge'], ['/imprint', 'imprint'], ['/privacy', 'privacy'], ['/terms', 'terms'], ['/terms/code-pages', 'terms-code-pages'],
]);

export async function appRoutes(ctx: Ctx): Promise<void> {
  const path = ctx.path;
  const cookieless = COOKIELESS.has(path) || /^\/updates\/\d+$/.test(path);
  if (!cookieless || ctx.cookie(SESSION_COOKIE) !== undefined) await Session.start(ctx);

  const page = STATIC.get(path);
  if (page) return staticPage(ctx, page);
  if (path === '/') return landing(ctx, ctx.session ? await currentUser(ctx) : null);

  // Updates & Roadmap (öffentlich)
  if (path === '/roadmap') return roadmapPage(ctx, ctx.session ? await currentUser(ctx) : null);
  if (path === '/updates') return updatesPage(ctx, ctx.session ? await currentUser(ctx) : null);
  if (path === '/updates/feed.xml') return updatesFeed(ctx);
  const m = /^\/updates\/(\d+)$/.exec(path);
  if (m) return updateLink(ctx, intval(m[1]));

  if (path === '/logout') return logout(ctx);
  if (path === '/register') return register(ctx);
  if (path === '/login') return login(ctx);

  // Ab hier nur mit Login
  const user = await currentUser(ctx);
  if (!user) {
    if (path.startsWith('/dashboard/api/')) ctx.json({ ok: false, error: 'Please log in again.' }, 401);
    ctx.redirect('/login');
  }
  if (path === '/admin') {
    if (!phpTruthy(user.is_admin)) ctx.redirect('/dashboard');
    return adminPage(ctx, user);
  }
  if (path.startsWith('/dashboard/api/')) return editorApi(ctx, user);
  if (path === '/dashboard') return dashboard(ctx, user);

  ctx.status = 404;
  return notFound(ctx);
}
