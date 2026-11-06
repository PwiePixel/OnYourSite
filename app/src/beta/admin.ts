// Admin → Beta: Tester freischalten (E-Mail oder Benutzername; Discord muss verknüpft sein) und entfernen, den Stand der
// Rolle „Beta Tester“ auf Discord sehen und neu anstoßen, Meldungen der Tester beantworten, den Text „What to test right
// now“ für das Beta-Panel schreiben.
import type { Ctx } from '../web/ctx.js';
import type { Session } from '../web/session.js';
import { one, q } from '../db.js';
import { e } from '../html.js';
import { date, field, intval, phpStr, strtolower, strtotime, type PhpArray } from '../php.js';
import { csrfField } from '../web/security.js';
import { schemaAtLeast, V_BETA } from '../schema.js';
import { report } from '../discord/botReport.js';
import { betaSitePort, betaSiteVersion, isBetaBuild } from './site.js';
import { appVersion } from '../version.js';
import {
  REPORT_AREAS, REPORT_KINDS, REPORT_STATUSES, answerReport, betaHost, betaNotes, betaUrl, discordOf, grantBeta, retryRole, revokeBeta,
  saveBetaNotes, type GrantResult,
} from './beta.js';

const done = (session: Session, r: GrantResult, ok: string): void => {
  if (r.ok) session.set('admin_success', ok);
  else session.set('admin_error', r.error);
};

export async function betaAdminPost(ctx: Ctx, session: Session, post: PhpArray): Promise<never> {
  const action = field(post, 'beta_action');
  const adminId = intval(session.get('user_id'));
  if (action === 'grant') {
    const who = strtolower(field(post, 'who').trim().replace(/^@/, ''));
    const user = who === '' ? null : await one('SELECT id, email FROM users WHERE LOWER(email) = ? OR LOWER(username) = ? LIMIT 1', [who, who]);
    if (!user) session.set('admin_error', 'No account with this email or username.');
    else done(session, await grantBeta(adminId, intval(user.id)), `${phpStr(user.email)} is a beta tester now. The Discord bot gives the Beta Tester role.`);
  } else if (action === 'revoke') {
    done(session, await revokeBeta(intval(field(post, 'user_id'))), 'Removed from the beta. The Discord bot takes the Beta Tester role away.');
  } else if (action === 'retry') {
    done(session, await retryRole(intval(field(post, 'user_id'))), 'The Discord bot tries again.');
  } else if (action === 'answer') {
    done(session, await answerReport(adminId, intval(field(post, 'report_id')), field(post, 'status'), field(post, 'reply')), 'Report saved – the tester gets a notification.');
  } else if (action === 'notes') {
    await saveBetaNotes(field(post, 'notes'));
    session.set('admin_success', 'Saved – testers see the new text in the beta area.');
  } else {
    session.set('admin_error', 'Unknown action.');
  }
  return ctx.redirect('/admin#beta');
}

const ROLE: Record<string, [string, string]> = {
  pending: ['Waiting for the bot', 'border-amber-500/30 bg-amber-500/10 text-amber-300'],
  given: ['Role given', 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'],
  not_on_server: ['Not on the Discord server', 'border-amber-500/30 bg-amber-500/10 text-amber-300'],
  error: ['Role failed', 'border-red-500/30 bg-red-500/10 text-red-300'],
};
const pill = (text: string, cls: string): string => '<span class="text-[11px] font-bold uppercase tracking-wide px-2 py-0.5 rounded border ' + cls + '">' + e(text) + '</span>';
const CARD = 'bg-card border border-bordercolor rounded-xl shadow-xl p-5 sm:p-6';
const INPUT = 'w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm';
const BTN = 'bg-white/5 hover:bg-white/10 border border-bordercolor text-white text-sm font-medium py-2 px-4 rounded-lg transition-colors flex items-center gap-2';
const day = (v: unknown): string => { const t = strtotime(phpStr(v ?? '')); return t === false ? '' : date('M j, Y', t); };

export async function adminBetaView(ctx: Ctx): Promise<string> {
  let o = '            <!-- ===================== Beta ===================== -->\n';
  o += '            <div id="tab-beta" class="admin-tab-content max-w-5xl mx-auto space-y-8 hidden">\n';
  if (!(await schemaAtLeast(V_BETA).catch(() => false))) return o + '<div class="' + CARD + ' text-sm text-gray-400">The database update for the beta hasn’t run yet.</div></div>\n';
  const csrf = String(await csrfField(ctx));
  const rep = await report().catch(() => null);
  const testers = await q('SELECT id, full_name, email, username, discord_id, is_admin, beta_at, beta_role, beta_role_error, beta_discord FROM users WHERE beta_at IS NOT NULL OR beta_role = \'error\' ORDER BY beta_at IS NULL DESC, beta_at DESC');
  const reports = await q(`SELECT r.*, u.email, u.full_name FROM beta_reports r LEFT JOIN users u ON u.id = r.user_id
    ORDER BY FIELD(r.status, 'open', 'in_progress', 'planned', 'fixed', 'wont_fix', 'duplicate'), r.id DESC LIMIT 200`);
  const open = reports.filter((r) => r.status === 'open').length;

  o += '<div class="' + CARD + '"><div class="flex flex-wrap items-start justify-between gap-4"><div class="min-w-0">'
    + '<h2 class="text-lg font-semibold text-white flex items-center gap-2"><i class=\'bx bx-test-tube text-sky-300\'></i> Beta</h2>'
    + '<p class="text-sm text-gray-400 mt-1">Beta testers log in at <a class="text-brand-400 hover:text-white" href="' + e(betaUrl('/_beta/')) + '" target="_blank" rel="noopener">' + e(betaHost()) + '</a> with their OnYourSite account and send reports from there. Every tester needs a linked Discord account – the bot gives them the <b class="text-white">Beta Tester</b> role on the Discord server (and creates the role if it’s missing).</p>'
    + '</div><div class="flex gap-6 text-center"><div><p class="text-2xl font-bold text-white">' + testers.length + '</p><p class="text-xs text-gray-500">Testers</p></div><div><p class="text-2xl font-bold text-white">' + open + '</p><p class="text-xs text-gray-500">Open reports</p></div></div></div>';
  if (!rep) o += '<p class="mt-4 text-sm text-amber-300 flex items-center gap-2"><i class=\'bx bx-error\'></i> The Discord bot hasn’t reported yet – roles are given as soon as it runs.</p>';
  else if (!rep.features.includes('beta.v1')) o += '<p class="mt-4 text-sm text-amber-300 flex items-center gap-2"><i class=\'bx bx-error\'></i> The Discord bot is too old for beta roles – update it (<code>install.sh --update</code> updates the bot too). Testers can use the beta area anyway.</p>';
  // Die Beta-Webseite (zweite Installation, Branch beta – server/beta.sh)
  const port = betaSitePort();
  const version = betaSiteVersion();
  if (isBetaBuild()) {
    o += '<p class="mt-4 text-sm flex items-center gap-2 text-sky-300" data-beta-site><i class=\'bx bx-globe\'></i> This is the beta website (version ' + e(appVersion()) + ') – manage testers and reports on the main site.</p>';
  } else o += '<p class="mt-4 text-sm flex items-center gap-2 ' + (port ? 'text-gray-300' : 'text-gray-500') + '" data-beta-site><i class=\'bx bx-globe text-sky-300\'></i> '
    + (port
      ? 'Beta website: <b class="text-white">' + e(version || 'unknown version') + '</b> – testers open it from the panel. A new pre-release: push it to the <code>beta</code> branch, then <code>install.sh --beta</code>.'
      : 'No beta website is set up – the panel works without it. Set it up on the server with <code>install.sh --beta</code> (it runs the <code>beta</code> branch next to this site, with the same database).')
    + '</p>';
  o += '</div>\n';

  // Tester freischalten
  o += '<div class="' + CARD + '"><h3 class="text-white font-semibold mb-3">Add a beta tester</h3><form action="/admin" method="POST" class="flex flex-col sm:flex-row gap-3">' + csrf
    + '<input type="hidden" name="beta_action" value="grant"><label class="sr-only" for="beta-who">Email or username</label>'
    + '<input id="beta-who" name="who" required placeholder="Email or username" autocomplete="off" class="' + INPUT + '">'
    + '<button type="submit" class="bg-white text-black hover:bg-gray-200 font-semibold py-2.5 px-5 rounded-lg text-sm shrink-0">Add tester</button></form>'
    + '<p class="text-xs text-gray-500 mt-2">Only accounts with a linked Discord ID can be added (the user sets it in the editor under Settings).</p></div>\n';

  // Tester
  o += '<div class="' + CARD + '"><h3 class="text-white font-semibold mb-4">Testers <span class="text-gray-500 font-normal text-sm">' + testers.filter((t) => t.beta_at !== null).length + '</span></h3>';
  if (!testers.length) o += '<p class="text-sm text-gray-500">No beta testers yet.</p>';
  else {
    o += '<div class="space-y-3">';
    for (const t of testers) {
      const discord = discordOf(t);
      const state = phpStr(t.beta_role ?? '');
      const role = ROLE[state];
      o += '<div class="flex flex-wrap items-center justify-between gap-3 border border-bordercolor rounded-lg p-3" data-tester="' + intval(t.id) + '"><div class="min-w-0">'
        + '<p class="text-white text-sm font-medium truncate">' + e(phpStr(t.full_name ?? '') || phpStr(t.email)) + ' <span class="text-gray-500 font-normal">' + e(t.email) + '</span></p>'
        + '<p class="text-xs text-gray-500 mt-1 flex flex-wrap items-center gap-2">' + (t.beta_at === null ? '<span class="text-red-300">Removed from the beta – the Discord role couldn’t be taken away</span>' : '<span>since ' + e(day(t.beta_at)) + '</span>') + '<span>·</span>'
        + (discord ? '<span><i class=\'bx bxl-discord-alt\'></i> ' + e(discord) + '</span>' : '<span class="text-amber-300">No Discord linked – beta paused</span>')
        + (role ? ' ' + pill(role[0], role[1]) : '') + (t.beta_role_error ? '<span class="text-red-300">' + e(t.beta_role_error) + '</span>' : '') + '</p></div>'
        + '<div class="flex items-center gap-2">'
        + ((t.beta_at === null || discord) && (state !== 'given' && state !== 'pending' || t.beta_role_error) ? '<form action="/admin" method="POST" class="m-0">' + csrf + '<input type="hidden" name="beta_action" value="retry"><input type="hidden" name="user_id" value="' + intval(t.id) + '"><button type="submit" class="' + BTN + '"><i class=\'bx bx-refresh\'></i> ' + (t.beta_at === null ? 'Take the role away again' : 'Try the role again') + '</button></form>' : '')
        + (t.beta_at === null ? '' : '<form action="/admin" method="POST" class="m-0">' + csrf + '<input type="hidden" name="beta_action" value="revoke"><input type="hidden" name="user_id" value="' + intval(t.id) + '"><button type="submit" class="' + BTN + ' hover:text-red-300"><i class=\'bx bx-user-x\'></i> Remove</button></form>')
        + '</div></div>';
    }
    o += '</div>';
  }
  o += '</div>\n';

  // Meldungen
  o += '<div class="' + CARD + '"><h3 class="text-white font-semibold mb-4">Reports <span class="text-gray-500 font-normal text-sm">' + reports.length + '</span></h3>';
  if (!reports.length) o += '<p class="text-sm text-gray-500">No reports yet.</p>';
  else {
    o += '<div class="space-y-4">';
    for (const r of reports) {
      const st = REPORT_STATUSES[phpStr(r.status)] ?? REPORT_STATUSES.open;
      o += '<details class="border border-bordercolor rounded-lg p-4 group" data-report="' + intval(r.id) + '"' + (r.status === 'open' ? ' open' : '') + '><summary class="cursor-pointer list-none flex flex-wrap items-center gap-2">'
        + pill(st.label, st.cls) + '<span class="text-white text-sm font-medium">' + e(r.title) + '</span>'
        + '<span class="text-xs text-gray-500">' + e(REPORT_KINDS[phpStr(r.kind)] ?? 'Other') + ' · ' + e(REPORT_AREAS[phpStr(r.area)] ?? 'Something else') + ' · ' + e(phpStr(r.email ?? 'deleted account')) + ' · ' + e(day(r.created_at)) + '</span></summary>'
        + '<div class="mt-3 text-sm text-gray-300 whitespace-pre-wrap">' + e(r.body) + '</div>'
        + (r.steps ? '<p class="mt-3 text-xs text-gray-500 font-semibold">Steps</p><div class="text-sm text-gray-300 whitespace-pre-wrap">' + e(r.steps) + '</div>' : '')
        + (r.page_url ? '<p class="mt-3 text-xs text-gray-500">Link: <span class="text-gray-300 break-all">' + e(r.page_url) + '</span></p>' : '')
        + (r.user_agent ? '<p class="mt-1 text-xs text-gray-600 break-all">' + e(r.user_agent) + '</p>' : '')
        + '<form action="/admin" method="POST" class="mt-4 grid gap-3 sm:grid-cols-[200px_1fr_auto] items-start">' + csrf
        + '<input type="hidden" name="beta_action" value="answer"><input type="hidden" name="report_id" value="' + intval(r.id) + '">'
        + '<select name="status" aria-label="Status" class="' + INPUT + '">' + Object.entries(REPORT_STATUSES).map(([k, v]) => '<option value="' + e(k) + '"' + (k === r.status ? ' selected' : '') + '>' + e(v.label) + '</option>').join('') + '</select>'
        + '<textarea name="reply" rows="2" maxlength="3000" aria-label="Reply to the tester" placeholder="Reply to the tester (optional)" class="' + INPUT + '">' + e(r.reply ?? '') + '</textarea>'
        + '<button type="submit" class="bg-white text-black hover:bg-gray-200 font-semibold py-2.5 px-5 rounded-lg text-sm">Save</button></form></details>';
    }
    o += '</div>';
  }
  o += '</div>\n';

  // Text für das Panel
  o += '<div class="' + CARD + '"><h3 class="text-white font-semibold mb-1">What to test right now</h3><p class="text-xs text-gray-500 mb-3">Shown at the top of the beta area. Plain text; an empty line starts a new paragraph.</p>'
    + '<form action="/admin" method="POST" class="space-y-3">' + csrf + '<input type="hidden" name="beta_action" value="notes">'
    + '<textarea name="notes" rows="5" maxlength="4000" aria-label="What to test right now" class="' + INPUT + '">' + e(await betaNotes()) + '</textarea>'
    + '<div class="flex justify-end"><button type="submit" class="bg-white text-black hover:bg-gray-200 font-semibold py-2 px-5 rounded-lg text-sm">Save</button></div></form></div>\n';
  o += '            </div>\n';
  return o;
}

