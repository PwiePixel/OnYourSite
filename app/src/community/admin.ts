// Admin: Vorschläge entscheiden, Tickets beantworten und schließen (oys_admin_community_handle in lib/community.php)
import type { Ctx } from '../web/ctx.js';
import type { Row } from '../db.js';
import { Session } from '../web/session.js';
import { field, intval, phpStr, type PhpArray, type PhpValue } from '../php.js';
import { communityText, outboxAdd, suggestionDecide, suggestionGet, suggestionPublic, ticketAddMessage, ticketClose, ticketGet, ticketPublic } from './community.js';

export type AdminResult = { error: string } | { ok: string } | null;

// $post['key'] ?? $fallback
const postValue = (post: PhpArray, key: string, fallback: PhpValue | number): PhpValue | number => post[key] ?? fallback;

// oys_admin_community_handle(): null, wenn es keine Community-Aktion ist
export async function adminCommunityHandle(post: PhpArray, adminName: string): Promise<AdminResult> {
  const action = field(post, 'community_action');
  adminName = communityText(adminName !== '' ? adminName : 'Team', 100);
  if (action === 'suggestion_decide') {
    const s = await suggestionGet(intval(postValue(post, 'id', 0)));
    const status = field(post, 'status');
    if (!s || !(status === 'accepted' || status === 'declined')) {
      return { error: 'Suggestion not found.' };
    }
    const [decided, changed] = await suggestionDecide(s, status, communityText(postValue(post, 'reason', ''), 500), adminName, 'web');
    if (!changed) {
      // (Inzwischen gelöscht: PHP liest dann null und schreibt leere Werte)
      return { error: 'This suggestion was already ' + phpStr(decided?.status) + ' by ' + phpStr(decided?.decided_by) + '.' };
    }
    await outboxAdd('suggestion.decided', suggestionPublic(decided as Row));
    return { ok: 'Suggestion #' + phpStr((decided as Row).id) + ' ' + status + '. It updates in Discord within a few seconds.' };
  }
  if (action === 'ticket_reply' || action === 'ticket_close') {
    const t = await ticketGet(intval(postValue(post, 'id', 0)));
    if (!t) {
      return { error: 'Ticket not found.' };
    }
    if (t.status !== 'open') {
      return { error: 'This ticket is already closed.' };
    }
    if (action === 'ticket_reply') {
      const body = communityText(postValue(post, 'body', ''), 2000);
      if (body === '') {
        return { error: 'Please write a reply.' };
      }
      await ticketAddMessage(intval(t.id), null, null, adminName, true, 'web', body);
      await outboxAdd('ticket.reply', { ...ticketPublic(t), author_name: adminName, body });
      return { ok: 'Reply sent. It appears in Discord within a few seconds.' };
    }
    await ticketClose(t, adminName, 'web');
    // Wie in PHP mit dem Stand vor dem Schließen (status ist darin noch "open")
    await outboxAdd('ticket.close', { ...ticketPublic(t), by_name: adminName });
    return { ok: 'Ticket #' + phpStr(t.id) + ' closed.' };
  }
  return null;
}

// Der Community-Teil von POST /admin (views/admin.php, nach der CSRF-Prüfung): Aktion ausführen, Hinweis für die
// nächste Seite merken und zurück zum Tab – bei Tickets mit geöffnetem Ticket. Aufrufen, wenn
// isset($_POST['community_action']) gilt; user ist der angemeldete Admin.
export async function adminCommunityPost(ctx: Ctx, user: Row): Promise<never> {
  const result = await adminCommunityHandle(ctx.post, phpStr(user.full_name ?? ''));
  if (result) {
    const session = await Session.start(ctx);
    if ('error' in result) session.set('admin_error', result.error);
    else session.set('admin_success', result.ok);
  }
  const back = field(ctx.post, 'community_action').startsWith('ticket_') ? '?ticket=' + intval(postValue(ctx.post, 'id', 0)) : '';
  ctx.redirect('/admin' + back + '#community');
}
