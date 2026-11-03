// /admin/api/…: JSON-Schnittstellen des Admin-Bereichs für Skripte der Admin-Seite (gemeinsam für alle Bereiche).
// Abgemeldet → 401 und keine Admin-Rechte → 403, beides als JSON (app/dispatch.ts bzw. hier) statt einer Weiterleitung.
// Nur lesen (GET): was etwas ändert, bleibt ein Formular an POST /admin mit CSRF-Schutz.
import type { Ctx } from '../web/ctx.js';
import type { Row } from '../db.js';
import { isAdminSession } from '../app/context.js';
import { discordStatusApi } from '../discord/statusApi.js';

// Name nach /admin/api/ → Antwort (die Funktion beendet die Anfrage mit ctx.json)
const ROUTES = new Map<string, (ctx: Ctx, user: Row) => Promise<never>>([
  ['discord-status', (ctx) => discordStatusApi(ctx)],
]);

export async function adminApi(ctx: Ctx, user: Row): Promise<never> {
  ctx.header('X-Robots-Tag', 'noindex, nofollow');
  // Admin im Nutzer-Modus (Impersonation) ist hier der Nutzer – ohne Admin-Rechte, auch wenn das Konto Admin ist (R1)
  if (!isAdminSession(ctx, user)) ctx.json({ ok: false, error: 'Admins only.' }, 403);
  const route = ROUTES.get(ctx.path.slice('/admin/api/'.length));
  if (!route) ctx.json({ ok: false, error: 'Not found.' }, 404);
  if (ctx.method !== 'GET' && ctx.method !== 'HEAD') {
    ctx.header('Allow', 'GET, HEAD');
    ctx.json({ ok: false, error: 'Method not allowed.' }, 405);
  }
  return route(ctx, user);
}
