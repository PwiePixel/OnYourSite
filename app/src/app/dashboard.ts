// /dashboard: Editor (GET) und E-Mail/Passwort ändern (POST) – lib/routes_app.php, views/dashboard.php
import type { Ctx } from '../web/ctx.js';
import { exec, one, type Row } from '../db.js';
import { config } from '../config.js';
import { csrfCheck, csrfField, csrfToken } from '../web/security.js';
import { decryptData, passwordHash, passwordVerify } from '../crypto.js';
import { asset, baseAuthority, pageDisplayUrl, scheme, uploadUrl, validateEmail, type PageLike } from '../helpers.js';
import { intval, phpStr, phpTrim, phpTruthy, strlen, strtolower, strtotime, time } from '../php.js';
import { blockForEditor, loadBlocks, pageForEditor, userPages } from '../content/pages.js';
import { DEFAULT_THEME, fontChoices, layouts, themes } from '../content/themes.js';
import { brands, bxIcons } from '../content/social.js';
import { uploadLimitMb } from '../content/uploads.js';
import { hcEarn, hcForEditor } from '../honeycombs/honeycombs.js';
import { currentPage, flash, hasPremium } from './context.js';
import { dashboardView } from './views/dashboard.js';

export async function dashboard(ctx: Ctx, user: Row): Promise<void> {
  const userId = intval(user.id);
  const premium = hasPremium(ctx, user);

  // Klassische Formulare: E-Mail und Passwort ändern
  if (ctx.method === 'POST') {
    if (!csrfCheck(ctx, ctx.post.csrf ?? null)) {
      flash(ctx, 'error', 'Your session has expired. Please try again.');
      ctx.redirect('/dashboard#settings');
    }
    const action = ctx.post.update_action ?? '';
    if (action === 'email') {
      const newEmail = strtolower(phpTrim(ctx.p('new_email')));
      if (!(await passwordVerify(ctx.p('current_password_email'), user.password))) {
        flash(ctx, 'error', 'Your current password is incorrect.');
      } else if (!validateEmail(newEmail)) {
        flash(ctx, 'error', 'Please enter a valid email address.');
      } else if (newEmail === strtolower(phpStr(user.email))) {
        flash(ctx, 'error', 'That’s already your email address.');
      } else if (await one('SELECT id FROM users WHERE email = ? AND id <> ?', [newEmail, userId])) {
        flash(ctx, 'error', 'This email address is already in use.');
      } else {
        await exec('UPDATE users SET email = ? WHERE id = ?', [newEmail, userId]);
        flash(ctx, 'success', 'Email address changed.');
      }
    } else if (action === 'password') {
      const newPassword = ctx.p('new_password');
      if (newPassword !== ctx.p('confirm_new_password')) {
        flash(ctx, 'error', 'The new passwords don’t match.');
      } else if (strlen(newPassword) < 8) {
        flash(ctx, 'error', 'Your new password must be at least 8 characters long.');
      } else if (!(await passwordVerify(ctx.p('current_password_pwd'), user.password))) {
        flash(ctx, 'error', 'Your current password is incorrect.');
      } else {
        await exec('UPDATE users SET password = ? WHERE id = ?', [await passwordHash(newPassword), userId]);
        flash(ctx, 'success', 'Password changed.');
      }
    }
    ctx.redirect('/dashboard#settings');
  }

  const page = await currentPage(ctx, user, ctx.get.page ?? null);
  const pages = await userPages(userId);
  const blocks = page ? await loadBlocks(intval(page.id)) : [];
  const userData: Row = { ...user, discord_id: decryptData((user.discord_id ?? '') as string) };
  const original = ctx.session?.get('original_admin_id');
  const isImpersonating = original !== undefined && original !== null;
  // Honigwaben fürs Vorbeischauen (nicht, wenn ein Admin als Nutzer eingeloggt ist)
  const honeycombs = await hcForEditor(userId, isImpersonating ? [] : await hcEarn(userId));

  // views/dashboard.php: Daten für static/js/editor.js (Reihenfolge der Schlüssel wie in PHP)
  let slugDaysLeft = 0;
  if (page && phpTruthy(page.slug_changed_at) && !premium) {
    const changed = strtotime(phpStr(page.slug_changed_at));
    slugDaysLeft = Math.max(0, 30 - intval(Math.floor((time() - (changed === false ? 0 : changed)) / 86400)));
  }
  const editorData = {
    csrf: await csrfToken(ctx),
    page: page ? pageForEditor(page) : null,
    blocks: blocks.map(blockForEditor),
    pages: pages.map((p) => ({
      id: intval(p.id),
      slug: p.slug,
      title: p.title,
      url: pageDisplayUrl(p as unknown as PageLike),
      avatar: phpTruthy(p.avatar) ? uploadUrl(p.avatar) : '',
    })),
    maxPages: intval(config('max_pages', 3)),
    premium,
    themes: themes(),
    defaultTheme: DEFAULT_THEME,
    layouts: layouts(),
    fonts: fontChoices(),
    brands: Object.entries(brands()).map(([key, b]) => ({ key, name: b.name, color: b.color, svg: b.svg, url: b.url, domains: b.domains })),
    bxIcons: bxIcons(),
    baseHost: baseAuthority(),
    scheme: scheme(),
    timezone: config('timezone', 'Europe/Berlin'),
    uploadLimitMb: uploadLimitMb(),
    qrJs: asset('/static/vendor/qrcode/qrcode.js'),
    honeycombs,
    cm: { js: asset('/static/vendor/codemirror/codemirror.js'), css: asset('/static/vendor/codemirror/codemirror.css') },
    codeTerms: '/terms/code-pages',
    slugDaysLeft,
    user: {
      name: userData.full_name ?? '',
      email: userData.email ?? '',
      weekly: phpTruthy(userData.weekly_report),
      discord: userData.discord_id ?? '',
      admin: phpTruthy(userData.is_admin),
    },
  };
  const flashSuccess = ctx.session?.take('success') ?? null;
  const flashError = ctx.session?.take('error') ?? null;

  ctx.write(dashboardView({
    editorData,
    flashSuccess,
    flashError,
    csrfField: String(await csrfField(ctx)),
    userData,
    hasPage: page !== null,
    isImpersonating,
    balance: honeycombs.balance,
  }));
}
