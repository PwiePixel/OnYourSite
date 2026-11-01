// Anmelden, Registrieren, Abmelden (lib/routes_app.php, views/login.php, views/register.php)
import type { Ctx } from '../web/ctx.js';
import { notPorted } from '../web/notPorted.js';
import { csrfCheck } from '../web/security.js';
import { phpEmpty } from '../php.js';

// /logout: nur per POST mit CSRF-Token – sonst könnte jede fremde Seite (oder eigenes CSS) abmelden
export async function logout(ctx: Ctx): Promise<void> {
  const session = ctx.session;
  if (ctx.method === 'POST' && session && csrfCheck(ctx, ctx.post.csrf ?? null)) {
    session.data = {};
    session.destroy();
    ctx.redirect('/');
  }
  ctx.redirect(phpEmpty(session?.get('user_id')) ? '/' : '/dashboard');
}

export async function register(ctx: Ctx): Promise<void> {
  notPorted(ctx, '/register');
}

export async function login(ctx: Ctx): Promise<void> {
  notPorted(ctx, '/login');
}
