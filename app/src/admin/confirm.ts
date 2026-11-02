// Formulare mit eigenem Bestätigungsdialog (confirmAttrs + confirmField): Kommt _confirmed ohne „1“ an, lief der Dialog
// nicht (ui.js fehlt oder ist kaputt) – dann wird nichts ausgeführt (fällt geschlossen aus). Das ersetzt keine
// Zugriffsprüfung (die bleibt: Admin-Sitzung und CSRF), es schützt vor einer Aktion ohne Rückfrage.
import type { Ctx } from '../web/ctx.js';
import type { Session } from '../web/session.js';
import { field, type PhpArray } from '../php.js';
import { UNCONFIRMED_MESSAGE, unconfirmed } from '../views/partials/ui.js';

// Zurück zum Bereich des Formulars (wie die Weiterleitungen der Aktionen selbst)
export function adminBackUrl(post: PhpArray): string {
  if (post.storage_action !== undefined) return '/admin#storage';
  if (post.community_action !== undefined) return '/admin#community';
  if (post.hc_action !== undefined) return '/admin#honeycombs';
  if (post.code_action !== undefined) return '/admin#code-pages';
  if (post.oys_action !== undefined) {
    const action = field(post, 'oys_action');
    if (action.startsWith('discord_')) return '/admin#discord';
    if (action.startsWith('milestone_') || action.startsWith('task_')) return '/admin#roadmap';
    return '/admin#updates';
  }
  if (post.save_smtp !== undefined) return '/admin#mailserver';
  if (post.send_newsletter !== undefined) return '/admin#newsletter';
  return '/admin';
}

// Vor jeder Admin-Aktion (nach der CSRF-Prüfung): unbestätigt → Hinweis und zurück, die Anfrage endet hier
export function refuseUnconfirmed(ctx: Ctx, session: Session, back: string): void {
  if (!unconfirmed(ctx.post)) return;
  session.set('admin_error', UNCONFIRMED_MESSAGE);
  ctx.redirect(back);
}
