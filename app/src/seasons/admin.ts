// Admin → Seasons: Saison-Themes für OnYourSites eigene Seiten (seasons.ts). Je Thema eine Karte mit „Off / On /
// Automatic“, dem Zeitraum für „Automatic“, dem Stand (gerade aktiv oder nicht) und einer Vorschau.
import type { Ctx } from '../web/ctx.js';
import type { Session } from '../web/session.js';
import { e } from '../html.js';
import { date, field, type PhpArray } from '../php.js';
import { csrfField } from '../web/security.js';
import { SEASONS, inWindow, isMonthDay, loadSettings, pickSeason, saveSettings, type SeasonMode, type SeasonSetting } from './seasons.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// 12-01 → „Dec 1“
const pretty = (md: string): string => MONTHS[Number(md.slice(0, 2)) - 1] + ' ' + Number(md.slice(3));

export async function seasonsAdminPost(ctx: Ctx, session: Session, post: PhpArray): Promise<never> {
  const action = field(post, 'season_action');
  const key = field(post, 'season');
  if (action !== 'save' || !Object.hasOwn(SEASONS, key)) {
    session.set('admin_error', 'Unknown action.');
    return ctx.redirect('/admin#seasons');
  }
  const modeIn = field(post, 'mode');
  const from = field(post, 'from').trim();
  const to = field(post, 'to').trim();
  if (modeIn !== 'off' && modeIn !== 'on' && modeIn !== 'auto') {
    session.set('admin_error', 'Please choose Off, On or Automatic.');
    return ctx.redirect('/admin#seasons');
  }
  if (!isMonthDay(from) || !isMonthDay(to)) {
    session.set('admin_error', 'Please enter the dates as month-day, e.g. 12-01 for December 1.');
    return ctx.redirect('/admin#seasons');
  }
  const mode = modeIn as SeasonMode;
  const settings = await loadSettings();
  // Nur ein Thema ist „On“: ein anderes, das an war, geht auf „Off“
  if (mode === 'on') for (const [k, s] of Object.entries(settings)) if (k !== key && s.mode === 'on') settings[k] = { ...s, mode: 'off' };
  settings[key] = { mode, from, to };
  await saveSettings(settings);
  const name = SEASONS[key].name;
  session.set('admin_success', mode === 'off' ? `${name} is off.` : mode === 'on' ? `${name} is on for OnYourSite’s own pages.`
    : `${name} turns on by itself from ${pretty(from)} to ${pretty(to)}.`);
  return ctx.redirect('/admin#seasons');
}

function stateBadge(key: string, s: SeasonSetting, active: string | null, today: string): string {
  if (active === key) return '<span class="text-[11px] font-bold uppercase tracking-wide px-2 py-0.5 rounded border border-emerald-500/30 bg-emerald-500/10 text-emerald-400">Active now</span>';
  if (s.mode === 'auto') {
    const label = inWindow(today, s.from, s.to) ? 'Waiting' : 'Scheduled';
    return '<span class="text-[11px] font-bold uppercase tracking-wide px-2 py-0.5 rounded border border-sky-500/30 bg-sky-500/10 text-sky-400">' + label + '</span>';
  }
  if (s.mode === 'on') return '<span class="text-[11px] font-bold uppercase tracking-wide px-2 py-0.5 rounded border border-amber-500/30 bg-amber-500/10 text-amber-400">Waiting</span>';
  return '<span class="text-[11px] font-bold uppercase tracking-wide px-2 py-0.5 rounded border border-bordercolor bg-white/5 text-gray-400">Off</span>';
}

export async function adminSeasonsView(ctx: Ctx): Promise<string> {
  const csrf = await csrfField(ctx);
  const settings = await loadSettings();
  const today = date('m-d');
  const active = pickSeason(settings, today);
  const input = 'w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm';
  let o = '';
  o += '            <!-- ===================== Seasons ===================== -->\n';
  o += '            <div id="tab-seasons" class="admin-tab-content max-w-5xl mx-auto space-y-8 hidden">\n';
  o += '                <div class="bg-card border border-bordercolor rounded-xl shadow-xl p-5 sm:p-6">\n';
  o += '                    <h2 class="text-lg font-semibold text-white flex items-center gap-2"><i class=\'bx bx-calendar-star text-sky-400\'></i> Website themes for the seasons</h2>\n';
  o += '                    <p class="text-sm text-gray-400 mt-1">A season theme decorates OnYourSite’s own pages: the home page, log in and sign up, updates, roadmap, suggestions, the legal pages and the 404 page. Users’ pages, the editor and the admin panel stay as they are. Only one theme is shown at a time.</p>\n';
  o += '                </div>\n';
  for (const [key, theme] of Object.entries(SEASONS)) {
    const s = settings[key];
    const radio = (value: SeasonMode, label: string, hint: string): string =>
      '<label class="flex items-start gap-3 p-3 rounded-lg border border-bordercolor bg-white/[0.02] hover:bg-white/5 cursor-pointer has-[:checked]:border-sky-500/50 has-[:checked]:bg-sky-500/5">' +
      '<input type="radio" name="mode" value="' + value + '"' + (s.mode === value ? ' checked' : '') + ' class="mt-1 accent-sky-400">' +
      '<span><span class="block text-sm font-medium text-white">' + label + '</span><span class="block text-xs text-gray-500">' + hint + '</span></span></label>';
    o += '                <div class="bg-card border border-bordercolor rounded-xl shadow-xl p-5 sm:p-6" data-season="' + e(key) + '">\n';
    o += '                    <div class="flex flex-wrap items-center justify-between gap-3 mb-4">\n';
    o += '                        <div class="flex items-center gap-3 min-w-0"><span class="w-10 h-10 rounded-lg shrink-0" style="background:linear-gradient(135deg,' + e(theme.swatch) + ',#1e3a8a)"></span>' +
      '<div class="min-w-0"><h3 class="text-white font-semibold flex items-center gap-2">' + e(theme.name) + ' ' + stateBadge(key, s, active, today) + '</h3>' +
      '<p class="text-xs text-gray-500">' + e(theme.desc) + '</p></div></div>\n';
    o += '                        <a href="/?season_preview=' + e(key) + '" target="_blank" rel="noopener" class="bg-white/5 hover:bg-white/10 border border-bordercolor text-white text-sm font-medium py-2 px-4 rounded-lg transition-colors flex items-center gap-2"><i class=\'bx bx-show\'></i> Preview</a>\n';
    o += '                    </div>\n';
    o += '                    <form action="/admin" method="POST" class="space-y-4">\n';
    o += '                        ' + csrf + '<input type="hidden" name="season_action" value="save"><input type="hidden" name="season" value="' + e(key) + '">\n';
    o += '                        <div class="grid gap-2 sm:grid-cols-3">' + radio('off', 'Off', 'Not shown') + radio('on', 'On', 'Shown from now on') +
      radio('auto', 'Automatic', 'Shown between the two dates every year') + '</div>\n';
    o += '                        <div class="grid gap-4 sm:grid-cols-2">\n';
    o += '                            <div><label class="block text-sm font-medium text-gray-300 mb-1.5" for="season-' + e(key) + '-from">From (month-day)</label>' +
      '<input type="text" id="season-' + e(key) + '-from" name="from" value="' + e(s.from) + '" required pattern="(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])" placeholder="12-01" inputmode="numeric" maxlength="5" class="' + input + '"></div>\n';
    o += '                            <div><label class="block text-sm font-medium text-gray-300 mb-1.5" for="season-' + e(key) + '-to">To (month-day)</label>' +
      '<input type="text" id="season-' + e(key) + '-to" name="to" value="' + e(s.to) + '" required pattern="(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])" placeholder="01-06" inputmode="numeric" maxlength="5" class="' + input + '"></div>\n';
    o += '                        </div>\n';
    o += '                        <p class="text-xs text-gray-500">Automatic: from ' + e(pretty(s.from)) + ' to ' + e(pretty(s.to)) + (s.from > s.to ? ', across the new year' : '') + '. Changes show within a few seconds.</p>\n';
    o += '                        <div class="flex justify-end"><button type="submit" class="bg-white text-black hover:bg-gray-200 font-semibold py-2 px-5 rounded-lg text-sm transition-colors">Save</button></div>\n';
    o += '                    </form>\n';
    o += '                </div>\n';
  }
  o += '            </div>\n';
  return o;
}
