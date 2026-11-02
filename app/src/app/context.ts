// Angemeldeter Nutzer, Team, Hinweise und aktuelle Profilseite (lib/routes_app.php, oben)
import type { Ctx } from '../web/ctx.js';
import { one, type Row } from '../db.js';
import { intval, phpEmpty, phpTruthy } from '../php.js';
import { isShownLinkPage, userPages } from '../content/pages.js';

// oys_current_user(): nur mit laufender Sitzung
export async function currentUser(ctx: Ctx): Promise<Row | null> {
  const id = ctx.session?.get('user_id');
  if (!ctx.session || phpEmpty(id)) return null;
  return one('SELECT * FROM users WHERE id = ?', [intval(id)]);
}

// Das Team (früher oys_has_premium()): Admins und Admins im Nutzer-Modus. Gilt für Seitenzahl, Speicher und die
// Wartezeit für Adressen – Premium (honeycombs/premium.ts) ändert daran nichts (Q1 = b).
export function isStaff(ctx: Ctx, user: Row): boolean {
  const original = ctx.session?.get('original_admin_id');
  return phpTruthy(user.is_admin) || (original !== undefined && original !== null);
}

// oys_flash(): Hinweis für die nächste Seite ('error' oder 'success')
export function flash(ctx: Ctx, type: string, message: string): void {
  ctx.session?.set(type, message);
}

// oys_current_page(): aus ?page=, der Sitzung oder die erste Seite – nur gezeigte Link-Seiten (ein Platz, der eine
// Code-Seite zeigt, hat keine bearbeitbare Link-Seite); zeigen alle Plätze Code-Seiten: null
export async function currentPage(ctx: Ctx, user: Row, requested: unknown = null): Promise<Row | null> {
  const pages = (await userPages(intval(user.id))).filter(isShownLinkPage);
  if (!pages.length) return null;
  for (const want of [requested, ctx.session?.get('page_id') ?? null]) {
    if (want === null || want === undefined || want === '') continue;
    for (const p of pages) {
      if (intval(p.id) === intval(want)) {
        ctx.session?.set('page_id', intval(p.id));
        return p;
      }
    }
  }
  ctx.session?.set('page_id', intval(pages[0].id));
  return pages[0];
}
