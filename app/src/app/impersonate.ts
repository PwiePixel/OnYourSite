// Als Nutzer anmelden und zurück zum Admin (admin_impersonate.php, admin_return.php). Beide Adressen gelten auf
// jeder Domain (früher echte Dateien) und nur per POST mit CSRF-Token – ein einfacher Link (z. B. aus eigenem CSS
// einer Profilseite) darf den Admin nicht umschalten.
import type { Ctx } from '../web/ctx.js';
import { Session } from '../web/session.js';
import { csrfCheck } from '../web/security.js';
import { one, value, type Param } from '../db.js';
import { intval, phpTruthy } from '../php.js';
import { refuseUnconfirmed } from '../admin/confirm.js';
import { isAdminSession } from './context.js';

// isset($_SESSION[…])
const isSet = (v: unknown): boolean => v !== undefined && v !== null;

// admin_impersonate.php
export async function adminImpersonate(ctx: Ctx): Promise<void> {
  const session = await Session.start(ctx);
  if (!isSet(session.get('user_id'))) ctx.redirect('/login');
  if (ctx.method !== 'POST' || !csrfCheck(ctx, ctx.post.csrf ?? null)) ctx.redirect('/admin');

  // „Log in as“ ist ein Admin-Recht und gilt nur in der eigenen Sitzung eines Admins (Entscheidung R1): wer schon als
  // ein anderes Konto arbeitet, wechselt nicht weiter (auch nicht aus einem älteren Tab des Admin-Bereichs) – erst
  // „Back to admin panel“
  const current = await one('SELECT id, is_admin FROM users WHERE id = ?', [session.get('user_id') as Param]);
  if (!current || !isAdminSession(ctx, current)) ctx.redirect('/dashboard');
  // Ohne bestätigten Dialog (ui.js fehlt) wird niemand gewechselt
  refuseUnconfirmed(ctx, session, '/admin');

  const targetUserId = intval(ctx.post.id ?? 0);
  const exists = await value('SELECT id FROM users WHERE id = ?', [targetUserId]);
  if (targetUserId > 0 && phpTruthy(exists)) {
    // Admin-ID merken, damit es zurückgeht (hier immer die eigene Sitzung des Admins, siehe oben)
    session.set('original_admin_id', intval(session.get('user_id')));
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
