// Admin-Aktionen für Statusseiten der Nutzer (POST /admin, status_action=…; CSRF, Admin-Sitzung und Bestätigung prüft
// admin/page.ts vorher). review_ok: der Name mit einer Marke ist in Ordnung – Suchmaschinen sehen die Seite wieder.
import type { Ctx } from '../web/ctx.js';
import type { Session } from '../web/session.js';
import { transaction } from '../db.js';
import { field, intval, type PhpArray } from '../php.js';
import { bumpRev } from './model.js';

export async function statusAdminPost(ctx: Ctx, session: Session, post: PhpArray): Promise<never> {
  const action = field(post, 'status_action');
  if (action === 'review_ok') {
    const id = intval(field(post, 'page_id'));
    // Freigegeben wird genau die Notiz, die der Admin gesehen hat – hat der Besitzer inzwischen umbenannt, nicht
    const seen = field(post, 'review_note');
    const done = await transaction(async (_conn, db) => {
      const row = await db.one("SELECT id, review_note FROM status_pages WHERE id = ? AND is_system = 0 AND review_note <> '' AND reviewed_at IS NULL FOR UPDATE", [id]);
      if (!row) return 'none';
      if (String(row.review_note) !== seen) return 'changed';
      await db.exec('UPDATE status_pages SET reviewed_at = ? WHERE id = ?', [Math.floor(Date.now() / 1000), id]);
      await bumpRev(db, id);
      return 'ok';
    });
    if (done === 'ok') session.set('admin_success', 'Name approved – the page can be found by search engines again.');
    else session.set('admin_error', done === 'changed' ? 'The name changed meanwhile – please check it again.' : 'This status page no longer needs a review.');
  } else {
    session.set('admin_error', 'Unknown action.');
  }
  return ctx.redirect('/admin#status');
}
