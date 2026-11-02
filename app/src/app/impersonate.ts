// Als Nutzer anmelden und zurück zum Admin (admin_impersonate.php, admin_return.php). Beide Adressen gelten auf
// jeder Domain (früher echte Dateien) und nur per POST mit CSRF-Token – ein einfacher Link (z. B. aus eigenem CSS
// einer Profilseite) darf den Admin nicht umschalten.
import type { Ctx } from '../web/ctx.js';
import { Session } from '../web/session.js';
import { csrfCheck } from '../web/security.js';
import { value, type Param } from '../db.js';
import { intval, phpTruthy } from '../php.js';

// isset($_SESSION[…])
const isSet = (v: unknown): boolean => v !== undefined && v !== null;

// admin_impersonate.php
export async function adminImpersonate(ctx: Ctx): Promise<void> {
  const session = await Session.start(ctx);
  if (!isSet(session.get('user_id'))) ctx.redirect('/login');
  if (ctx.method !== 'POST' || !csrfCheck(ctx, ctx.post.csrf ?? null)) ctx.redirect('/admin');

  // Admin ist, wer ursprünglich angemeldet war (auch mitten im Nutzer-Modus)
  const adminId = session.get('original_admin_id') ?? session.get('user_id');
  if (!phpTruthy(await value('SELECT is_admin FROM users WHERE id = ?', [adminId as Param]))) ctx.redirect('/dashboard');

  const targetUserId = intval(ctx.post.id ?? 0);
  const exists = await value('SELECT id FROM users WHERE id = ?', [targetUserId]);
  if (targetUserId > 0 && phpTruthy(exists)) {
    // Originale Admin-ID merken, damit es zurückgeht (beim Wechsel von Nutzer zu Nutzer bleibt die erste)
    if (!isSet(session.get('original_admin_id'))) session.set('original_admin_id', intval(session.get('user_id')));
    session.regenerate();
    session.set('user_id', targetUserId);
    session.delete('page_id');
    session.set('success', 'Logged in as user #' + targetUserId);
    ctx.redirect('/dashboard');
  }

  session.set('admin_error', 'User ID not found.');
  ctx.redirect('/admin');
}

// admin_return.php: zurück zum eigenen Konto
export async function adminReturn(ctx: Ctx): Promise<void> {
  const session = await Session.start(ctx);
  if (isSet(session.get('original_admin_id')) && ctx.method === 'POST' && csrfCheck(ctx, ctx.post.csrf ?? null)) {
    session.regenerate();
    session.set('user_id', session.get('original_admin_id'));
    session.delete('original_admin_id');
    session.delete('page_id');
    session.set('admin_success', 'Welcome back! You are no longer impersonating a user.');
    ctx.redirect('/admin');
  }
  ctx.redirect('/dashboard');
}
