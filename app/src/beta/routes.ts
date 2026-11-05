// beta.<domain>: Anmelden mit dem OnYourSite-Konto (dieselben Zugangsdaten, eigene Sitzung auf dieser Adresse), das
// Beta-Panel für Tester (was gerade getestet wird, Meldung schicken, eigene Meldungen mit Status und Antwort) und ein
// Hinweis für alle anderen. Gleiche Gestaltung wie die Anmeldeseite.
import type { Ctx } from '../web/ctx.js';
import { Session } from '../web/session.js';
import { attemptFailed, attemptsAllowed, csrfCheck, csrfField, rateLimit } from '../web/security.js';
import { exec, one, type Param, type Row } from '../db.js';
import { encryptData, passwordVerify, sha256Hex } from '../crypto.js';
import { e } from '../html.js';
import { asset, mainUrl } from '../helpers.js';
import { date, intval, phpStr, phpTrim, strtolower, strtotime } from '../php.js';
import { uiAssets } from '../views/partials/ui.js';
import { REPORT_AREAS, REPORT_KINDS, REPORT_STATUSES, addReport, betaAccess, betaNotes, readReport, reportsOf, type BetaAccess } from './beta.js';

export async function betaRoutes(ctx: Ctx): Promise<void> {
  ctx.header('X-Robots-Tag', 'noindex, nofollow');
  ctx.header('Content-Security-Policy', "frame-ancestors 'none'");
  ctx.header('X-Frame-Options', 'DENY');
  const path = ctx.path;
  const session = await Session.start(ctx);
  if (path === '/login' && ctx.method === 'POST') return betaLogin(ctx, session);
  if (path === '/logout' && ctx.method === 'POST') {
    if (csrfCheck(ctx, ctx.post.csrf ?? null)) {
      session.data = {};
      session.destroy();
    }
    ctx.redirect('/');
  }
  const userId = intval(session.get('user_id'));
  const user = userId > 0 ? await one('SELECT * FROM users WHERE id = ?', [userId]) : null;
  if (path === '/report' && ctx.method === 'POST') return betaReport(ctx, session, user);
  if (path !== '/') ctx.redirect('/');
  const flashError = session.take('beta_error') ?? null;
  const flashOk = session.take('beta_ok') ?? null;
  const csrf = String(await csrfField(ctx));
  if (!user) ctx.send(page('Log in', loginBody(csrf, flashError)));
  const access = betaAccess(user);
  if (access !== 'ok') ctx.send(page('Beta', deniedBody(user, access, csrf)));
  ctx.send(page('Beta', panelBody(user, csrf, await betaNotes(), await reportsOf(intval(user.id)), flashError, flashOk)));
}

// Wie /login der Hauptseite: dieselbe Bremse für Fehlversuche (je Absender und je Konto), neue Sitzung
async function betaLogin(ctx: Ctx, session: Session): Promise<never> {
  const email = strtolower(phpTrim(ctx.p('email')));
  const loginKey = 'login:' + sha256Hex(email).slice(0, 40);
  if (!csrfCheck(ctx, ctx.post.csrf ?? null)) {
    session.set('beta_error', 'Your session has expired. Please try again.');
  } else if (!(await attemptsAllowed(ctx, loginKey, 10, 50, 900))) {
    session.set('beta_error', 'Too many attempts. Please wait 15 minutes.');
  } else {
    const user = await one('SELECT * FROM users WHERE email = ?', [email]);
    if (user && (await passwordVerify(ctx.p('password'), user.password))) {
      session.regenerate();
      session.set('user_id', intval(user.id));
      await exec('UPDATE users SET last_ip = ? WHERE id = ?', [encryptData(ctx.ip) ?? null, user.id as Param]);
      ctx.redirect('/');
    }
    await attemptFailed(ctx, loginKey, 900);
    session.set('beta_error', 'Wrong email or password.');
  }
  return ctx.redirect('/');
}

async function betaReport(ctx: Ctx, session: Session, user: Row | null): Promise<never> {
  if (!user || betaAccess(user) !== 'ok') return ctx.redirect('/');
  if (!csrfCheck(ctx, ctx.post.csrf ?? null)) {
    session.set('beta_error', 'Your session has expired. Please try again.');
    return ctx.redirect('/');
  }
  const report = readReport(ctx.post as Record<string, unknown>, phpStr(ctx.headers['user-agent'] ?? ''));
  if (typeof report === 'string') {
    session.set('beta_error', report);
    return ctx.redirect('/#report');
  }
  if (!(await rateLimit('beta-report:' + intval(user.id), 20, 3600))) {
    session.set('beta_error', 'That’s a lot of reports in a short time – please wait a few minutes.');
    return ctx.redirect('/#report');
  }
  await addReport(intval(user.id), report);
  session.set('beta_ok', 'Thanks! Your report was sent to the team.');
  return ctx.redirect('/#reports');
}

// ---------------------------------------------------------------- Ansichten

const FIELD = 'w-full bg-[#09090b] border border-bordercolor rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-gray-400 transition-all';

function page(title: string, body: string): string {
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n    <meta charset="UTF-8">\n    <meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
    + '    <meta name="color-scheme" content="dark">\n    <meta name="darkreader-lock">\n    <meta name="robots" content="noindex, nofollow">\n'
    + '    <title>' + e(title) + ' | OnYourSite Beta</title>\n    <link rel="icon" type="image/png" href="/static/images/favicon.png">\n'
    + '    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">\n'
    + '    <link rel="stylesheet" href="' + e(asset('/static/vendor/boxicons/css/boxicons.min.css')) + '">\n'
    + '    <script src="https://cdn.tailwindcss.com"></script>\n'
    + "    <script>tailwind.config = { theme: { extend: { fontFamily: { sans: ['Inter', 'sans-serif'] }, colors: { background: '#09090b', card: '#18181b', bordercolor: 'rgba(255, 255, 255, 0.08)', brand: { 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5' } } } } }</script>\n"
    + '    <style>@media (max-width: 639px) { input:not([type=checkbox]):not([type=radio]), select, textarea { font-size: 16px !important; } }</style>\n'
    + '    ' + uiAssets('app') + '\n</head>\n'
    + '<body class="bg-background text-gray-300 font-sans min-h-screen relative overflow-x-hidden selection:bg-brand-500/30">\n'
    + '<div class="absolute top-0 left-1/2 -translate-x-1/2 w-[700px] h-[500px] bg-brand-500/10 rounded-full blur-[110px] -z-10 pointer-events-none"></div>\n'
    + body + '\n</body>\n</html>\n';
}

const brand = (): string => '<a href="/" class="flex items-center gap-2"><i class=\'bx bx-hive text-3xl text-brand-500\'></i>'
  + '<span class="font-bold text-xl text-white tracking-tight">OnYourSite</span>'
  + '<span class="ml-1 text-[11px] font-bold uppercase tracking-wide px-2 py-0.5 rounded border border-sky-500/30 bg-sky-500/10 text-sky-300">Beta</span></a>';

const notice = (kind: 'error' | 'ok', text: unknown): string => !text ? '' : kind === 'error'
  ? '<div class="mb-6 bg-red-500/10 border border-red-500/20 text-red-400 p-3 rounded-lg flex items-center gap-2 text-sm font-medium" data-flash="error"><i class=\'bx bx-error-circle text-lg\'></i> ' + e(text) + '</div>'
  : '<div class="mb-6 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 p-3 rounded-lg flex items-center gap-2 text-sm font-medium" data-flash="ok"><i class=\'bx bx-check-circle text-lg\'></i> ' + e(text) + '</div>';

function loginBody(csrf: string, error: unknown): string {
  return '<main class="min-h-screen flex flex-col items-center justify-center py-16 px-4">'
    + '<div class="w-full max-w-md p-8 md:p-10 bg-card rounded-3xl border border-bordercolor shadow-2xl">'
    + '<div class="flex justify-center mb-6">' + brand() + '</div>'
    + '<h1 class="text-2xl font-bold text-white text-center mb-2">Welcome to the beta</h1>'
    + '<p class="text-gray-400 text-center mb-8">Log in with your OnYourSite account.</p>'
    + notice('error', error)
    + '<form action="/login" method="POST" class="space-y-5">' + csrf
    + '<div><label class="block text-sm font-medium text-gray-300 mb-2" for="beta-email">Email address</label><input id="beta-email" type="email" name="email" required autocomplete="email" placeholder="max@example.com" class="' + FIELD + '"></div>'
    + '<div><label class="block text-sm font-medium text-gray-300 mb-2" for="beta-password">Password</label><input id="beta-password" type="password" name="password" required autocomplete="current-password" placeholder="••••••••" class="' + FIELD + '"></div>'
    + '<button type="submit" class="w-full bg-white text-black hover:bg-gray-200 font-bold py-3.5 rounded-xl transition-all duration-300 mt-4">Log in</button></form>'
    + '<p class="text-center text-gray-500 mt-8 text-sm">No account yet? <a href="' + e(mainUrl('/register')) + '" class="text-white hover:text-gray-300 font-medium">Sign up on OnYourSite</a></p>'
    + '</div></main>';
}

const logoutForm = (csrf: string): string => '<form action="/logout" method="POST" class="m-0">' + csrf
  + '<button type="submit" class="text-sm text-gray-400 hover:text-white flex items-center gap-1.5"><i class=\'bx bx-log-out text-lg\'></i> Log out</button></form>';

function deniedBody(user: Row, access: BetaAccess, csrf: string): string {
  const text = access === 'no_discord'
    ? 'You’re a beta tester, but your Discord isn’t linked any more. Add your Discord ID in the editor under Settings – then the beta area opens again and you get the Beta Tester role on our Discord.'
    : 'This area is for beta testers. Beta testers try new things before everyone else and help us find bugs. Ask the team on our Discord if you’d like to join – you need a linked Discord account.';
  return '<main class="min-h-screen flex flex-col items-center justify-center py-16 px-4">'
    + '<div class="w-full max-w-md p-8 md:p-10 bg-card rounded-3xl border border-bordercolor shadow-2xl text-center">'
    + '<div class="flex justify-center mb-6">' + brand() + '</div>'
    + '<i class=\'bx bx-lock-alt text-4xl text-gray-500\'></i>'
    + '<h1 class="text-2xl font-bold text-white mt-3 mb-2">' + (access === 'no_discord' ? 'Link your Discord' : 'For beta testers only') + '</h1>'
    + '<p class="text-gray-400 mb-6">' + e(text) + '</p>'
    + '<p class="text-sm text-gray-500 mb-6">Logged in as ' + e(user.email) + '</p>'
    + '<div class="flex items-center justify-center gap-4"><a href="' + e(mainUrl('/dashboard#settings')) + '" class="bg-white text-black hover:bg-gray-200 font-semibold py-2.5 px-5 rounded-xl text-sm">Open the editor</a>' + logoutForm(csrf) + '</div>'
    + '</div></main>';
}

const badge = (status: string): string => {
  const s = REPORT_STATUSES[status] ?? REPORT_STATUSES.open;
  return '<span class="text-[11px] font-bold uppercase tracking-wide px-2 py-0.5 rounded border ' + s.cls + '">' + e(s.label) + '</span>';
};

const options = (list: Readonly<Record<string, string>>, chosen: string): string =>
  Object.entries(list).map(([k, v]) => '<option value="' + e(k) + '"' + (k === chosen ? ' selected' : '') + '>' + e(v) + '</option>').join('');

// Einfacher Text mit Absätzen (Zeilenumbrüche bleiben)
const paras = (text: string): string => text.split(/\n{2,}/).map((p) => '<p>' + e(p).replace(/\n/g, '<br>') + '</p>').join('');

function panelBody(user: Row, csrf: string, notes: string, reports: Row[], error: unknown, ok: unknown): string {
  const name = phpStr(user.full_name ?? '') || phpStr(user.email);
  let o = '<header class="border-b border-bordercolor bg-background/80 backdrop-blur-md sticky top-0 z-40"><div class="max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">'
    + brand() + '<div class="flex items-center gap-5"><a href="' + e(mainUrl('/dashboard')) + '" class="hidden sm:flex text-sm text-gray-400 hover:text-white items-center gap-1.5"><i class=\'bx bx-edit text-lg\'></i> Editor</a>' + logoutForm(csrf) + '</div></div></header>';
  o += '<main class="max-w-5xl mx-auto px-4 sm:px-6 py-10 space-y-8">';
  o += '<section><h1 class="text-3xl font-bold text-white tracking-tight">Hi ' + e(name.split(' ')[0]) + ', thanks for testing!</h1>'
    + '<p class="text-gray-400 mt-2">Try new things on OnYourSite before everyone else and tell us what breaks or what you’d like. Every report goes straight to the team.</p></section>';
  o += notice('error', error) + notice('ok', ok);
  o += '<section class="bg-card border border-bordercolor rounded-2xl p-6"><h2 class="text-lg font-semibold text-white flex items-center gap-2 mb-3"><i class=\'bx bx-test-tube text-sky-300\'></i> What to test right now</h2>'
    + '<div class="text-gray-300 space-y-3 text-sm leading-relaxed">' + (notes ? paras(notes) : '<p class="text-gray-500">Nothing special right now – use OnYourSite as usual and tell us about anything that feels wrong.</p>') + '</div></section>';
  o += '<section id="report" class="bg-card border border-bordercolor rounded-2xl p-6"><h2 class="text-lg font-semibold text-white flex items-center gap-2 mb-5"><i class=\'bx bx-bug text-sky-300\'></i> Send a report</h2>'
    + '<form action="/report" method="POST" class="space-y-5">' + csrf
    + '<div class="grid gap-4 sm:grid-cols-2"><div><label class="block text-sm font-medium text-gray-300 mb-2" for="r-kind">Type</label><select id="r-kind" name="kind" class="' + FIELD + '">' + options(REPORT_KINDS, 'bug') + '</select></div>'
    + '<div><label class="block text-sm font-medium text-gray-300 mb-2" for="r-area">Where</label><select id="r-area" name="area" class="' + FIELD + '">' + options(REPORT_AREAS, 'other') + '</select></div></div>'
    + '<div><label class="block text-sm font-medium text-gray-300 mb-2" for="r-title">Title</label><input id="r-title" name="title" required minlength="4" maxlength="160" placeholder="e.g. The countdown block shows the wrong time" class="' + FIELD + '"></div>'
    + '<div><label class="block text-sm font-medium text-gray-300 mb-2" for="r-body">What happened?</label><textarea id="r-body" name="body" required minlength="10" maxlength="5000" rows="5" placeholder="What did you expect, and what happened instead?" class="' + FIELD + '"></textarea></div>'
    + '<div><label class="block text-sm font-medium text-gray-300 mb-2" for="r-steps">Steps to see it <span class="text-gray-500">(optional)</span></label><textarea id="r-steps" name="steps" maxlength="3000" rows="3" placeholder="1. Open … 2. Click … 3. …" class="' + FIELD + '"></textarea></div>'
    + '<div><label class="block text-sm font-medium text-gray-300 mb-2" for="r-url">Link <span class="text-gray-500">(optional)</span></label><input id="r-url" name="page_url" type="url" maxlength="500" placeholder="https://…" class="' + FIELD + '"></div>'
    + '<div class="flex justify-end"><button type="submit" class="bg-white text-black hover:bg-gray-200 font-bold py-3 px-6 rounded-xl transition-all">Send report</button></div></form></section>';
  o += '<section id="reports" class="bg-card border border-bordercolor rounded-2xl p-6"><h2 class="text-lg font-semibold text-white flex items-center gap-2 mb-5"><i class=\'bx bx-list-ul text-sky-300\'></i> Your reports <span class="text-gray-500 text-sm font-normal">' + reports.length + '</span></h2>';
  if (!reports.length) o += '<p class="text-sm text-gray-500">You haven’t sent a report yet.</p>';
  else {
    o += '<ul class="space-y-3">';
    for (const r of reports) {
      const when = strtotime(phpStr(r.created_at));
      o += '<li class="border border-bordercolor rounded-xl p-4 bg-white/[0.02]" data-report="' + intval(r.id) + '"><div class="flex flex-wrap items-center gap-2 mb-1">' + badge(phpStr(r.status))
        + '<span class="text-xs text-gray-500">' + e(REPORT_KINDS[phpStr(r.kind)] ?? 'Other') + ' · ' + e(REPORT_AREAS[phpStr(r.area)] ?? 'Something else') + ' · ' + e(when === false ? '' : date('M j, Y', when)) + '</span></div>'
        + '<p class="text-white font-medium">' + e(r.title) + '</p>';
      if (r.reply) o += '<div class="mt-3 border-l-2 border-sky-400/50 pl-3 text-sm text-gray-300"><p class="text-xs text-sky-300 font-semibold mb-1">Reply from the team</p>' + paras(phpStr(r.reply)) + '</div>';
      o += '</li>';
    }
    o += '</ul>';
  }
  o += '</section></main>';
  return o;
}
