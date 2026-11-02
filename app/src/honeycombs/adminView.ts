// Admin, Bereich „Honeycombs“ (Teil von views/admin.php): Unterbereiche über /admin?hc_tab=<bereich>#honeycombs –
// Übersicht (Kennzahlen, was bald endet, meistverkaufte Optionen, verdient nach Grund, was Aufmerksamkeit braucht,
// letzte Buchungen), Katalog & Preise, Angebote, Regeln zum Verdienen und Nutzer (Honigwaben vergeben, Kontostände).
// Gezeigt wird nur der gewählte Unterbereich (seine Abfragen laufen nur dann). Aussehen wie die übrigen Karten des
// Admin-Bereichs; Honigwaben-Symbole gelb. Jeder Text aus der Datenbank geht durch e().
import type { Ctx } from '../web/ctx.js';
import { q, one, value, type Row } from '../db.js';
import { date, intval, numberFormat, phpStr, strtolower, strtotime, ucfirst } from '../php.js';
import { e, phpJson } from '../html.js';
import { randomHex } from '../crypto.js';
import { csrfField } from '../web/security.js';
import { confirmAttrs, confirmField } from '../views/partials/ui.js';
import { HC_MAX_VIEW_REWARDS, hcDescribe, hcSettings, type HcSettings } from './honeycombs.js';
import { ensureCatalogue, optionLabel, optionTitle } from './catalogue.js';
import { feature, featureReady, features, type Feature, type ItemRow } from './features.js';
import { MAX_OPEN_OFFERS, type OfferRow } from './offers.js';
import { addDays, nowStr } from './clock.js';
import { HC_TABS, hcTab, switchOnProblem, type HcTab } from './admin.js';

const IN = 'w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm';
const LBL = 'block text-sm font-medium text-gray-300 mb-1.5';
const BTN = 'inline-flex items-center gap-1.5 px-3 py-2 min-h-[36px] rounded-lg text-xs font-medium border border-bordercolor text-gray-300 hover:text-white hover:bg-white/5 transition-colors';
const SMALL = 'block text-xs font-medium text-gray-400 mb-1';
const BADGE = 'text-[10px] font-bold uppercase px-1.5 py-0.5 rounded';
const CARD = 'bg-card border border-bordercolor rounded-xl shadow-xl';
const SUBMIT = 'bg-white text-black hover:bg-gray-200 font-bold py-2.5 px-6 rounded-lg transition-all flex items-center gap-2';

const TAB_LABELS: Readonly<Record<HcTab, [string, string]>> = {
  overview: ['Overview', 'bx-bar-chart-alt-2'],
  catalogue: ['Catalogue & prices', 'bx-purchase-tag'],
  offers: ['Offers', 'bx-gift'],
  rules: ['Earning rules', 'bx-slider-alt'],
  users: ['Users', 'bx-group'],
};

// $userName: Name, sonst E-Mail (null und '' zählen als leer)
const userName = (u: Row): unknown => (u.full_name !== '' && u.full_name !== null && u.full_name !== undefined ? u.full_name : u.email);

// strtotime() eines Datums aus der Datenbank; leer/ungültig → 0 wie date(…, false)
function stamp(v: unknown): number {
  const t = strtotime(phpStr(v));
  return t === false ? 0 : t;
}
const when = (v: unknown): string => date('M j, Y H:i', stamp(v));
// DATETIME → Wert eines datetime-local-Felds
const localValue = (v: unknown): string => (typeof v === 'string' && v.length >= 16 ? v.slice(0, 16).replace(' ', 'T') : '');

// Kopf einer Karte (Symbol + Überschrift), wie die übrigen Karten des Bereichs
function cardHead(icon: string, title: string, extra = ''): string {
  return `                    <div class="flex flex-wrap items-center justify-between gap-3 p-5 sm:p-6 border-b border-bordercolor">\n`
    + `                        <h2 class="text-base font-semibold text-white flex items-center gap-2"><i class='bx ${icon} text-xl ${icon === 'bx-hive' ? 'text-yellow-400' : 'text-brand-400'}'></i> ${e(title)}</h2>${extra}\n`
    + '                    </div>\n';
}

// Betrag wie in der Liste der Buchungen: +N grün, −N rot, 0 = „free“
function amountHtml(amt: number): string {
  const cls = amt > 0 ? 'text-emerald-400' : amt < 0 ? 'text-red-400' : 'text-gray-500';
  return `<span class="shrink-0 font-bold ${cls}">${amt > 0 ? '+' + numberFormat(amt) : amt < 0 ? '−' + numberFormat(-amt) : 'free'}</span>`;
}

// Titel einer Option für Listen (Funktion nicht mehr im Code: der Schlüssel)
function itemTitle(item: Pick<ItemRow, 'item_key' | 'feature' | 'days' | 'units'>): string {
  const f = feature(item.feature);
  return f ? optionTitle(f, { days: item.days, units: intval(item.units) }) : item.item_key;
}

// Bezeichnungen der Gründe im Verlauf (verdient nach Grund)
const REASONS: Readonly<Record<string, string>> = {
  daily: 'Active days', profile: 'Completed profiles', views: 'Page views', admin: 'Gifts from the team', refund: 'Refunds', streak: 'Streaks',
  code: 'Event codes', reversal: 'Corrections', grant: 'Grants', unlock: 'Unlocks',
};

// Stand eines Angebots
function offerStatus(o: OfferRow, now: string): 'running' | 'scheduled' | 'ended' | 'cancelled' | 'used up' {
  if (o.cancelled_at !== null) return 'cancelled';
  if (!(o.ends_at > now)) return 'ended';
  if (o.max_uses !== null && intval(o.uses) >= intval(o.max_uses)) return 'used up';
  return o.starts_at <= now ? 'running' : 'scheduled';
}
const STATUS_STYLE: Readonly<Record<string, string>> = {
  running: 'bg-emerald-500/15 text-emerald-400', scheduled: 'bg-sky-500/15 text-sky-400', ended: 'bg-white/5 text-gray-400', cancelled: 'bg-white/5 text-gray-400',
  'used up': 'bg-white/5 text-gray-400',
};

// Wofür ein Angebot gilt, als Text (titles: Titel der Optionen nach Schlüssel)
function scopeText(scope: string, titles: ReadonlyMap<string, string>): string {
  if (scope === 'all') return 'Everything';
  if (scope.startsWith('feature:')) {
    const f = feature(scope.slice(8));
    return 'All of ' + (f ? f.title : scope.slice(8));
  }
  if (scope.startsWith('item:')) return 'Only ' + (titles.get(scope.slice(5)) ?? scope.slice(5));
  return scope;
}

// allUsers: alle Konten aus admin/page.ts (id, full_name, email, username, …; neueste zuerst)
export async function adminHoneycombsView(ctx: Ctx, allUsers: Row[]): Promise<string> {
  await ensureCatalogue();
  const tab = hcTab(ctx.get.hc_tab);
  const csrf = String(await csrfField(ctx));
  const now = nowStr();
  const optionCount = (await q('SELECT feature FROM hc_items')).filter((r) => feature(String(r.feature)) !== null).length;
  const openOffers = intval(await value('SELECT COUNT(*) FROM hc_offers WHERE cancelled_at IS NULL AND ends_at > ?', [now]));
  const counts: Partial<Record<HcTab, number>> = { catalogue: optionCount, offers: openOffers };

  let o = '';
  o += "            <!-- ===================== Honigwaben ===================== -->\n            <div id=\"tab-honeycombs\" class=\"admin-tab-content max-w-5xl mx-auto space-y-8 hidden\">\n";
  // Unterbereiche (wie die Filter im Bereich Community)
  o += '                <nav class="flex flex-wrap gap-1.5" aria-label="Honeycombs" id="hcTabs">\n';
  for (const key of HC_TABS) {
    const [label, icon] = TAB_LABELS[key];
    const count = counts[key];
    o += `                    <a href="/admin?hc_tab=${key}#honeycombs" class="${BTN}${tab === key ? ' !bg-white/10 !text-white' : ''}"${tab === key ? ' aria-current="page"' : ''}><i class='bx ${icon}'></i> ${e(label)}`
      + (count !== undefined ? ` <span class="text-gray-500">${count}</span>` : '') + '</a>\n';
  }
  o += '                </nav>\n';
  if (tab === 'overview') o += await overview(now);
  else if (tab === 'catalogue') o += await catalogue(csrf, now);
  else if (tab === 'offers') o += await offers(csrf, now);
  else if (tab === 'rules') o += await rules(csrf);
  else o += await users(csrf, allUsers);
  o += '            </div>\n';
  return o;
}

// ---------------------------------------------------------------- Übersicht

async function overview(now: string): Promise<string> {
  const since = addDays(now, -30);
  const circulation = intval(await value('SELECT COALESCE(SUM(amount), 0) FROM honeycomb_ledger'));
  const flows = await one('SELECT COALESCE(SUM(GREATEST(amount, 0)), 0) AS earned, COALESCE(SUM(GREATEST(-amount, 0)), 0) AS spent FROM honeycomb_ledger WHERE created_at >= ?', [since]);
  const premium = intval(await value('SELECT COUNT(*) FROM users WHERE premium_until > ?', [now]));
  const kpis: Array<[string, number, string, string]> = [
    ['In circulation', circulation, 'bx-hive', 'bg-yellow-500/10 border-yellow-500/20 text-yellow-400'],
    ['Earned · 30 days', intval(flows?.earned), 'bx-trending-up', 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'],
    ['Spent · 30 days', intval(flows?.spent), 'bx-cart', 'bg-red-500/10 border-red-500/20 text-red-400'],
    ['Active Premium', premium, 'bx-crown', 'bg-purple-500/10 border-purple-500/20 text-purple-400'],
  ];
  let o = '                <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">\n';
  for (const [label, n, icon, colors] of kpis) {
    o += `                    <div class="bg-card border border-bordercolor rounded-xl p-5 flex items-center gap-4"><div class="w-12 h-12 shrink-0 rounded-lg border flex items-center justify-center ${colors}"><i class='bx ${icon} text-2xl${icon === 'bx-hive' ? ' text-yellow-400' : ''}'></i></div>`
      + `<div class="min-w-0"><p class="text-sm text-gray-500 font-medium mb-1">${e(label)}</p><h3 class="text-2xl font-bold text-white">${numberFormat(n)}</h3></div></div>\n`;
  }
  o += '                </div>\n';

  // Endet in 7 Tagen · Meistverkauft in 30 Tagen
  const ending = await q(`SELECT e.user_id, e.feature, e.lot, e.expires_at, u.full_name, u.email FROM hc_entitlements e JOIN users u ON u.id = e.user_id
      WHERE e.permanent = 0 AND e.quantity > 0 AND e.expires_at > ? AND e.expires_at <= ? ORDER BY e.expires_at, e.id LIMIT 20`, [now, addDays(now, 7)]);
  const top = await q(`SELECT p.item_key, p.feature, MAX(p.days) AS days, MAX(p.units) AS units, COUNT(*) AS sold, SUM(p.price) AS total FROM hc_purchases p
      WHERE p.created_at >= ? AND p.refunded_at IS NULL GROUP BY p.item_key, p.feature ORDER BY sold DESC, total DESC, p.item_key LIMIT 10`, [since]);
  o += '                <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">\n';
  o += `                <div class="${CARD} overflow-hidden" id="hcEnding">\n` + cardHead('bx-time-five', 'Ending in 7 days');
  if (!ending.length) {
    o += '                    <p class="p-5 sm:p-6 text-sm text-gray-500">Nothing ends in the next 7 days.</p>\n';
  } else {
    o += '                    <ul class="divide-y divide-bordercolor text-sm">\n';
    for (const r of ending) {
      const f = feature(String(r.feature));
      o += `                        <li class="px-5 sm:px-6 py-2.5 flex items-center justify-between gap-3"><span class="min-w-0"><span class="text-white">${e(userName(r))}</span> <span class="text-gray-400">– ${e(f ? f.title : r.feature)}</span></span>`
        + `<span class="shrink-0 text-xs text-gray-400">${e(when(r.expires_at))}</span></li>\n`;
    }
    o += '                    </ul>\n';
  }
  o += '                </div>\n';
  o += `                <div class="${CARD} overflow-hidden" id="hcTop">\n` + cardHead('bx-trophy', 'Top options · 30 days');
  if (!top.length) {
    o += '                    <p class="p-5 sm:p-6 text-sm text-gray-500">No purchases yet.</p>\n';
  } else {
    o += '                    <div class="overflow-x-auto"><table class="w-full text-sm text-left"><thead class="text-xs text-gray-500 uppercase bg-inputbg"><tr><th class="px-5 py-3 font-medium">Option</th><th class="px-4 py-3 font-medium text-right">Sold</th><th class="px-5 py-3 font-medium text-right">Honeycombs</th></tr></thead><tbody class="divide-y divide-bordercolor">\n';
    for (const r of top) {
      o += `                        <tr><td class="px-5 py-2.5 text-white">${e(itemTitle({ item_key: String(r.item_key), feature: String(r.feature), days: r.days === null ? null : intval(r.days), units: intval(r.units) }))}</td>`
        + `<td class="px-4 py-2.5 text-right text-gray-300">${numberFormat(intval(r.sold))}</td><td class="px-5 py-2.5 text-right text-gray-300 whitespace-nowrap">${numberFormat(intval(r.total))} <i class='bx bx-hive text-yellow-400'></i></td></tr>\n`;
    }
    o += '                    </tbody></table></div>\n';
  }
  o += '                </div>\n                </div>\n';

  // Verdient nach Grund (30 Tage), Balken in CSS
  const byReason = await q('SELECT reason, SUM(amount) AS total FROM honeycomb_ledger WHERE created_at >= ? AND amount > 0 GROUP BY reason ORDER BY total DESC, reason', [since]);
  const maxReason = Math.max(1, ...byReason.map((r) => intval(r.total)));
  o += `                <div class="${CARD} overflow-hidden" id="hcEarned">\n` + cardHead('bx-bar-chart', 'Earned by reason · 30 days');
  if (!byReason.length) {
    o += '                    <p class="p-5 sm:p-6 text-sm text-gray-500">Nothing earned in the last 30 days.</p>\n';
  } else {
    o += '                    <div class="p-5 sm:p-6 space-y-3">\n';
    for (const r of byReason) {
      const reason = phpStr(r.reason);
      const total = intval(r.total);
      o += `                        <div><div class="flex justify-between gap-3 text-sm mb-1"><span class="text-gray-300">${e(Object.hasOwn(REASONS, reason) ? REASONS[reason] : ucfirst(reason))}</span><span class="text-white font-medium">${numberFormat(total)}</span></div>`
        + `<div class="h-2 rounded-full bg-inputbg overflow-hidden"><div class="h-2 rounded-full bg-yellow-400" style="width:${Math.max(1, Math.round((total / maxReason) * 100))}%"></div></div></div>\n`;
    }
    o += '                    </div>\n';
  }
  o += '                </div>\n';

  // Braucht Aufmerksamkeit: Konten, deren Abgleich mit den anderen Bereichen seit über einer Stunde aussteht
  const hourAgo = nowStr(stamp(now) - 3600);
  const waiting = await one(`SELECT COUNT(*) AS n, MIN(reconcile_at) AS oldest FROM hc_accounts WHERE reconcile_at IS NOT NULL AND reconcile_at <= ?`, [hourAgo]);
  const lastError = phpStr(await value("SELECT reconcile_error FROM hc_accounts WHERE reconcile_at IS NOT NULL AND reconcile_at <= ? AND reconcile_error <> '' ORDER BY reconcile_at LIMIT 1", [hourAgo]) ?? '');
  o += `                <div class="${CARD} p-5 sm:p-6" id="hcAttention">\n                    <h2 class="text-base font-semibold text-white flex items-center gap-2 mb-3"><i class='bx bx-error-circle text-xl text-brand-400'></i> Needs attention</h2>\n`;
  if (intval(waiting?.n) > 0) {
    const n = intval(waiting?.n);
    o += `                    <p class="text-sm text-amber-400">${n === 1 ? '1 account is' : n + ' accounts are'} waiting to be updated (oldest since ${e(date('M j, H:i', stamp(waiting?.oldest)))})${lastError !== '' ? ': ' + e(lastError) : '.'}</p>\n`;
  } else {
    o += '                    <p class="text-sm text-gray-500">Nothing needs attention.</p>\n';
  }
  o += '                </div>\n';

  // Letzte Buchungen
  const recent = await q('SELECT l.*, u.full_name, u.email FROM honeycomb_ledger l JOIN users u ON u.id = l.user_id ORDER BY l.id DESC LIMIT 10');
  o += `                <div class="${CARD} p-5 sm:p-6" id="hcRecent">\n                    <div class="flex items-center gap-3 mb-4 border-b border-bordercolor pb-4">\n                        <i class='bx bx-history text-2xl text-brand-400'></i>\n                        <h2 class="text-base font-semibold text-white">Latest activity</h2>\n                    </div>\n`;
  if (!recent.length) {
    o += '                    <p class="text-sm text-gray-500">Nothing yet.</p>\n';
  } else {
    o += '                    <ul class="divide-y divide-bordercolor text-sm">\n';
    for (const r of recent) {
      o += `                        <li class="py-2.5 flex items-center justify-between gap-3"><span class="min-w-0"><span class="text-white">${e(userName(r))}</span> <span class="text-gray-400">– ${e(hcDescribe(r))}</span><span class="block text-xs text-gray-500">${e(when(r.created_at))}</span></span>${amountHtml(intval(r.amount))}</li>\n`;
    }
    o += '                    </ul>\n';
  }
  o += '                </div>\n';
  return o;
}

// ---------------------------------------------------------------- Katalog & Preise

async function catalogue(csrf: string, now: string): Promise<string> {
  const order = new Map(features().map((f, i) => [f.key, i]));
  const items = (await q<ItemRow>('SELECT * FROM hc_items ORDER BY position, id')).filter((i) => order.has(i.feature))
    .sort((a, b) => (order.get(a.feature)! - order.get(b.feature)!) || (intval(a.position) - intval(b.position)) || (intval(a.id) - intval(b.id)));
  const sold = new Map<string, number>();
  for (const r of await q('SELECT item_key, COUNT(*) AS n FROM hc_purchases WHERE created_at >= ? AND refunded_at IS NULL GROUP BY item_key', [addDays(now, -30)])) {
    sold.set(String(r.item_key), intval(r.n));
  }
  let o = `                <div class="${CARD} overflow-hidden" id="hcCatalogue">\n` + cardHead('bx-purchase-tag', 'Catalogue & prices');
  o += '                    <p class="px-5 sm:px-6 pt-4 text-xs text-gray-500">Prices are in honeycombs. Purchases keep the price they were made at. Options are never deleted – switch them off instead.</p>\n';
  if (!items.length) o += '                    <p class="p-5 sm:p-6 text-sm text-gray-500">No options yet.</p>\n';
  for (const item of items) {
    const f = feature(item.feature) as Feature;
    const active = intval(item.is_active) === 1;
    const problem = active ? null : switchOnProblem(f);
    const floor = f.minAccountDaysFloor ?? 0;
    const id = intval(item.id);
    o += `                    <form action="/admin" method="POST" class="px-5 sm:px-6 py-4 border-t border-bordercolor space-y-3" data-item="${e(item.item_key)}">\n`
      + '                        ' + csrf + `                        <input type="hidden" name="hc_action" value="item_save"><input type="hidden" name="item_id" value="${id}">\n`
      + '                        <div class="flex flex-wrap items-end gap-3">\n'
      + `                            <div class="min-w-0 flex-1 basis-56"><span class="text-white font-medium">${e(optionTitle(f, item))}</span> <span class="${BADGE} ${active ? 'bg-emerald-500/15 text-emerald-400' : 'bg-white/5 text-gray-400'}">${active ? 'On' : 'Off'}</span>`
      + `<span class="block text-xs text-gray-500 break-all">${e(item.item_key)} · ${e(f.title)} (${e(f.owner)}) · ${e(optionLabel(f, item))} · sold ${numberFormat(sold.get(item.item_key) ?? 0)} in 30 days</span></div>\n`
      + `                            <div><label class="${SMALL}" for="hcPrice${id}">Price</label><input id="hcPrice${id}" type="number" name="price" required min="0" max="1000000" step="1" value="${intval(item.price)}" class="${IN} !w-28 text-right"></div>\n`
      + `                            <label class="inline-flex items-center gap-2 text-sm text-gray-300 min-h-[42px]"${problem ? ` title="${e(problem)}"` : ''}><input type="checkbox" name="is_active" value="1"${active ? ' checked' : ''}${problem ? ' disabled' : ''} class="w-4 h-4 accent-yellow-400"> Active</label>\n`
      + `                            <button type="submit" class="${BTN}"><i class='bx bx-save'></i> Save</button>\n`
      + '                        </div>\n'
      + '                        <div class="grid grid-cols-2 sm:grid-cols-5 gap-3">\n'
      + `                            <div><label class="${SMALL}" for="hcPos${id}">Position</label><input id="hcPos${id}" type="number" name="position" min="-1000" max="1000" step="1" value="${intval(item.position)}" class="${IN}"></div>\n`
      + `                            <div><label class="${SMALL}" for="hcFrom${id}">Available from</label><input id="hcFrom${id}" type="datetime-local" name="available_from" value="${e(localValue(item.available_from))}" class="${IN}"></div>\n`
      + `                            <div><label class="${SMALL}" for="hcUntil${id}">Available until</label><input id="hcUntil${id}" type="datetime-local" name="available_until" value="${e(localValue(item.available_until))}" class="${IN}"></div>\n`
      + `                            <div><label class="${SMALL}" for="hcAge${id}">Min. account age (days)</label><input id="hcAge${id}" type="number" name="min_account_days" min="${floor}" max="3650" step="1" value="${intval(item.min_account_days)}" class="${IN}"></div>\n`
      + `                            <div><label class="${SMALL}" for="hcActive${id}">Min. active days</label><input id="hcActive${id}" type="number" name="min_active_days" min="0" max="3650" step="1" value="${intval(item.min_active_days)}" class="${IN}"></div>\n`
      + '                        </div>\n'
      + (problem ? `                        <p class="text-xs text-gray-500">${e(problem)} ${f.kind === 'timed' ? 'Time-limited options can be sold once reminders and the end of a period are handled.' : 'Its feature isn’t ready yet.'}</p>\n` : '')
      + '                    </form>\n';
  }
  o += '                </div>\n';

  // Weitere Option: nur bei Funktionen mit Laufzeiten oder Paketen, die bereit sind
  const extendable = features().filter((f) => f.kind !== 'permanent' && featureReady(f));
  o += `                <div class="${CARD} p-5 sm:p-6" id="hcAddOption">\n                    <h2 class="text-base font-semibold text-white flex items-center gap-2 mb-4"><i class='bx bx-plus-circle text-xl text-brand-400'></i> Add an option</h2>\n`;
  if (!extendable.length) {
    o += '                    <p class="text-sm text-gray-500">No feature can get more options right now. Unlocks for good have exactly one option; durations and pack sizes can be added to a feature once it’s ready.</p>\n';
  } else {
    o += '                    <form action="/admin" method="POST" class="grid grid-cols-1 sm:grid-cols-4 gap-4 items-end">\n                        ' + csrf
      + '                        <input type="hidden" name="hc_action" value="item_add">\n'
      + `                        <div class="sm:col-span-2"><label class="${LBL}" for="hcAddFeature">Feature</label><select id="hcAddFeature" name="feature" required data-error-required="Please choose a feature." class="${IN}">`
      + extendable.map((f) => `<option value="${e(f.key)}">${e(f.title)} (${f.kind === 'timed' ? 'days' : 'pack size'})</option>`).join('') + '</select></div>\n'
      + `                        <div><label class="${LBL}" for="hcAddSize">Days or pack size</label><input id="hcAddSize" type="number" name="days" required min="1" max="365" step="1" class="${IN}"></div>\n`
      + `                        <div><label class="${LBL}" for="hcAddPrice">Price</label><input id="hcAddPrice" type="number" name="price" required min="0" max="1000000" step="1" class="${IN}"></div>\n`
      + `                        <div class="sm:col-span-4"><button type="submit" class="${SUBMIT}"><i class='bx bx-plus'></i> Add option</button></div>\n`
      + '                    </form>\n'
      + `                    <script>\n                        // Paketgröße statt Tagen für Funktionen ohne Laufzeit\n                        (function () {\n                            const kinds = ${phpJson(Object.fromEntries(extendable.map((f) => [f.key, f.kind])), { hexTag: true, hexAmp: true })};\n`
      + "                            const sel = document.getElementById('hcAddFeature'), size = document.getElementById('hcAddSize');\n"
      + "                            const sync = () => { const timed = kinds[sel.value] === 'timed'; size.name = timed ? 'days' : 'units'; size.max = timed ? '365' : '10'; };\n"
      + "                            sel.addEventListener('change', sync);\n                            sync();\n                        })();\n                    </script>\n";
  }
  o += '                </div>\n';
  return o;
}

// ---------------------------------------------------------------- Angebote

async function offers(csrf: string, now: string): Promise<string> {
  const list = await q<OfferRow>('SELECT * FROM hc_offers ORDER BY (cancelled_at IS NULL AND ends_at > ?) DESC, starts_at DESC, id DESC LIMIT 50', [now]);
  // Wofür: alles, eine Funktion oder eine Option (auch von Admins angelegte Laufzeiten) – nur Funktionen im Code
  const titles = new Map<string, string>();
  const byFeature = new Map<string, ItemRow[]>();
  for (const item of await q<ItemRow>('SELECT * FROM hc_items ORDER BY position, id')) {
    const f = feature(item.feature);
    if (!f) continue;
    titles.set(item.item_key, optionTitle(f, item));
    byFeature.set(f.key, [...(byFeature.get(f.key) ?? []), item]);
  }
  const options: Array<[string, string]> = [['all', 'Everything']];
  for (const f of features()) {
    options.push(['feature:' + f.key, 'All of ' + f.title]);
    for (const item of byFeature.get(f.key) ?? []) options.push(['item:' + item.item_key, 'Only ' + (titles.get(item.item_key) as string)]);
  }
  let o = `                <div class="${CARD} p-5 sm:p-6">\n                    <h2 class="text-base font-semibold text-white flex items-center gap-2 mb-4"><i class='bx bx-gift text-xl text-brand-400'></i> Create an offer</h2>\n`;
  o += '                    <form action="/admin" method="POST" class="space-y-4" id="hcOfferForm">\n                        ' + csrf
    + `                        <input type="hidden" name="hc_action" value="offer_create"><input type="hidden" name="form_ref" value="${randomHex(8)}">\n`
    + '                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">\n'
    + `                            <div><label class="${LBL}" for="hcOfferLabel">Name <span class="text-gray-500 font-normal">(users see it)</span></label><input id="hcOfferLabel" type="text" name="label" required maxlength="60" placeholder="e.g. Black Friday" data-error-required="Please give the offer a name." class="${IN}"></div>\n`
    + `                            <div><label class="${LBL}" for="hcOfferScope">For</label><select id="hcOfferScope" name="scope" class="${IN}">`
    + options.map(([v, label]) => `<option value="${e(v)}">${e(label)}</option>`).join('') + '</select></div>\n'
    + '                        </div>\n'
    + '                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">\n'
    + `                            <div><span class="${LBL}">Discount</span><div class="flex flex-wrap items-center gap-3">`
    + `<label class="inline-flex items-center gap-2 text-sm text-gray-300"><input type="radio" name="discount" value="percent" checked class="accent-yellow-400"> % off</label>`
    + `<input type="number" name="percent_off" min="1" max="100" step="1" placeholder="30" aria-label="Percent off" class="${IN} !w-24 text-right">`
    + `<label class="inline-flex items-center gap-2 text-sm text-gray-300"><input type="radio" name="discount" value="fixed" class="accent-yellow-400"> Fixed price</label>`
    + `<input type="number" name="fixed_price" min="0" max="1000000" step="1" placeholder="80" aria-label="Fixed price" class="${IN} !w-28 text-right" disabled>`
    + '</div><p class="text-xs text-gray-500 mt-1.5">A fixed price is only possible for a single option.</p></div>\n'
    + '                            <div class="grid grid-cols-2 gap-3">\n'
    + `                                <div><label class="${LBL}" for="hcOfferStart">Starts</label><input id="hcOfferStart" type="datetime-local" name="starts_at" required data-error-required="Please choose when the offer starts." class="${IN}"></div>\n`
    + `                                <div><label class="${LBL}" for="hcOfferEnd">Ends</label><input id="hcOfferEnd" type="datetime-local" name="ends_at" required data-error-required="Please choose when the offer ends." class="${IN}"></div>\n`
    + '                            </div>\n'
    + '                        </div>\n'
    + '                        <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">\n'
    + `                            <div><label class="${LBL}" for="hcOfferMax">Max. uses</label><input id="hcOfferMax" type="number" name="max_uses" min="1" max="1000000" step="1" placeholder="no limit" class="${IN}"></div>\n`
    + `                            <div><label class="${LBL}" for="hcOfferPer">Per account</label><input id="hcOfferPer" type="number" name="per_user_max" min="1" max="100" step="1" placeholder="no limit" class="${IN}"></div>\n`
    + `                            <div><label class="${LBL}" for="hcOfferAge">Min. account age</label><input id="hcOfferAge" type="number" name="min_account_days" min="0" max="3650" step="1" value="0" class="${IN}"></div>\n`
    + `                            <div><label class="${LBL}" for="hcOfferActive">Min. active days</label><input id="hcOfferActive" type="number" name="min_active_days" min="0" max="3650" step="1" value="0" class="${IN}"></div>\n`
    + '                        </div>\n'
    + `                        <p class="text-xs text-gray-500">Up to ${MAX_OPEN_OFFERS} running or scheduled offers, each for up to 90 days. Offers that include Premium need accounts that are at least 30 days old. Offers can’t be edited – cancel one and create a new one.</p>\n`
    + `                        <button type="submit" class="${SUBMIT}"><i class='bx bx-check'></i> Create offer</button>\n`
    + '                    </form>\n'
    + "                    <script>\n                        // Nur das Feld der gewählten Rabattart ist aktiv\n                        (function () {\n"
    + "                            const form = document.getElementById('hcOfferForm');\n"
    + "                            const sync = () => {\n                                const fixed = form.querySelector('input[name=discount]:checked').value === 'fixed';\n"
    + "                                form.elements.percent_off.disabled = fixed;\n                                form.elements.fixed_price.disabled = !fixed;\n                            };\n"
    + "                            form.querySelectorAll('input[name=discount]').forEach((r) => r.addEventListener('change', sync));\n                            sync();\n                        })();\n                    </script>\n"
    + '                </div>\n';

  o += `                <div class="${CARD} overflow-hidden" id="hcOffers">\n` + cardHead('bx-list-ul', 'Offers');
  if (!list.length) {
    o += '                    <p class="p-5 sm:p-6 text-sm text-gray-500">No offers yet.</p>\n';
  } else {
    o += '                    <div class="overflow-x-auto"><table class="w-full text-sm text-left"><thead class="text-xs text-gray-500 uppercase bg-inputbg"><tr><th class="px-5 py-3 font-medium">Offer</th><th class="px-4 py-3 font-medium">Discount</th><th class="px-4 py-3 font-medium">When</th><th class="px-4 py-3 font-medium text-right">Uses</th><th class="px-4 py-3 font-medium">Status</th><th class="px-5 py-3"></th></tr></thead><tbody class="divide-y divide-bordercolor">\n';
    for (const off of list) {
      const status = offerStatus(off, now);
      const discount = off.fixed_price !== null ? 'Fixed ' + numberFormat(intval(off.fixed_price)) : '−' + intval(off.percent_off) + ' %';
      const limits = [off.per_user_max !== null ? intval(off.per_user_max) + ' per account' : '', intval(off.min_account_days) > 0 ? 'accounts ' + intval(off.min_account_days) + '+ days' : '',
        intval(off.min_active_days) > 0 ? intval(off.min_active_days) + '+ active days' : ''].filter(Boolean).join(' · ');
      o += `                        <tr data-offer="${intval(off.id)}"><td class="px-5 py-3"><span class="text-white">${e(off.label)}</span><span class="block text-xs text-gray-500">${e(scopeText(phpStr(off.scope), titles))}${limits ? ' · ' + e(limits) : ''}</span></td>`
        + `<td class="px-4 py-3 text-gray-300 whitespace-nowrap">${e(discount)}</td>`
        + `<td class="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">${e(when(off.starts_at))} –<br>${e(when(off.ends_at))}</td>`
        + `<td class="px-4 py-3 text-right text-gray-300 whitespace-nowrap">${numberFormat(intval(off.uses))}${off.max_uses !== null ? ' / ' + numberFormat(intval(off.max_uses)) : ''}</td>`
        + `<td class="px-4 py-3"><span class="${BADGE} ${STATUS_STYLE[status]}">${e(ucfirst(status))}</span></td><td class="px-5 py-3 text-right">`;
      if (status === 'running' || status === 'scheduled') {
        o += `<form action="/admin" method="POST" class="m-0"${confirmAttrs({ title: 'Cancel the offer “' + phpStr(off.label) + '”?', text: 'It ends right away. Purchases made with it keep their price.', ok: 'Cancel offer', tone: 'danger' })}>`
          + csrf.trim() + confirmField() + `<input type="hidden" name="hc_action" value="offer_cancel"><input type="hidden" name="offer_id" value="${intval(off.id)}">`
          + `<button type="submit" class="${BTN} hover:text-red-400"><i class='bx bx-x-circle'></i> Cancel</button></form>`;
      }
      o += '</td></tr>\n';
    }
    o += '                    </tbody></table></div>\n';
  }
  o += '                </div>\n';
  return o;
}

// ---------------------------------------------------------------- Regeln zum Verdienen

async function rules(csrf: string): Promise<string> {
  const settings: HcSettings = await hcSettings();
  const ruleFields: Array<[keyof HcSettings, [string, string]]> = [
    ['daily', ['Active day', 'For opening the editor (once a day)']],
    ['profile', ['Complete profile', 'Once: profile picture, bio and at least 3 links']],
    ['views', ['Visitors', 'Per step of page views (one step a day, up to ' + HC_MAX_VIEW_REWARDS + ' times)']],
    ['views_step', ['Views per step', 'How many page views make one step']],
  ];
  let o = `                <div class="${CARD} p-5 sm:p-6 max-w-2xl">\n                    <div class="flex items-center gap-3 mb-5 border-b border-bordercolor pb-4">\n                        <i class='bx bx-slider-alt text-2xl text-brand-400'></i>\n                        <h2 class="text-base font-semibold text-white">How users earn them</h2>\n                    </div>\n`;
  o += '                    <form action="/admin" method="POST" class="space-y-3" id="hcRulesForm">\n                        ' + csrf + '                        <input type="hidden" name="hc_action" value="settings">\n';
  for (const [key, [title, hint]] of ruleFields) {
    o += `                        <div class="flex items-center gap-3">\n                            <label class="flex-1 min-w-0" for="hcRule-${key}"><span class="block text-sm text-white">${e(title)}</span><span class="block text-xs text-gray-500">${e(hint)}</span></label>\n`
      + `                            <input id="hcRule-${key}" type="number" name="${key}" min="${key === 'views_step' ? 1 : 0}" max="100000" step="1" value="${intval(settings[key])}" class="${IN} !w-28 text-right">\n                        </div>\n`;
  }
  o += '                        <p class="text-xs text-gray-500 pt-1">0 switches a reward off. Changes count from now on – nobody loses honeycombs they already have. Prices are set under <a href="/admin?hc_tab=catalogue#honeycombs" class="text-brand-400 hover:text-brand-300">Catalogue &amp; prices</a>.</p>\n'
    + `                        <button type="submit" class="${SUBMIT}"><i class='bx bx-save'></i> Save</button>\n                    </form>\n                </div>\n`;
  return o;
}

// ---------------------------------------------------------------- Nutzer: Honigwaben vergeben, Kontostände (wie bisher)

async function users(csrf: string, allUsers: Row[]): Promise<string> {
  const balances = new Map<number, Row>();
  for (const row of await q('SELECT user_id, SUM(amount) AS balance, SUM(GREATEST(amount, 0)) AS earned, SUM(GREATEST(-amount, 0)) AS spent FROM honeycomb_ledger GROUP BY user_id')) {
    balances.set(intval(row.user_id), row);
  }
  const balanceOf = (u: Row): number => intval(balances.get(intval(u.id))?.balance ?? 0);
  const hcUsers = [...allUsers].sort((a, b) => Math.sign(balanceOf(b) - balanceOf(a)) || Math.sign(intval(b.id) - intval(a.id)));
  let o = '';
  o += "                <div class=\"bg-card border border-bordercolor rounded-xl shadow-xl p-5 sm:p-6\">\n                    <div class=\"flex items-center gap-3 mb-5 border-b border-bordercolor pb-4\">\n                        <i class='bx bx-hive text-2xl text-yellow-400'></i>\n                        <h2 class=\"text-base font-semibold text-white\">Give honeycombs</h2>\n                    </div>\n                    <form action=\"/admin\" method=\"POST\" class=\"space-y-4\" id=\"hcGrantForm\">\n                        ";
  o += csrf;
  o += "                        <input type=\"hidden\" name=\"hc_action\" value=\"grant\">\n                        <input type=\"hidden\" name=\"grant_ref\" value=\"";
  o += randomHex(8);
  o += "\">\n                        <div>\n                            <label class=\"" + LBL + "\" for=\"hcUser\">User</label>\n                            <select id=\"hcUser\" name=\"user_id\" required data-error-required=\"Please choose a user.\" class=\"" + IN + "\">\n                                <option value=\"\">Choose a user …</option>\n";
  for (const u of allUsers) {
    o += '                                <option value="' + intval(u.id) + '">' + e(userName(u)) + ' · ' + e(u.email) + ' (' + intval(balances.get(intval(u.id))?.balance ?? 0) + ')</option>\n';
  }
  o += "                            </select>\n                        </div>\n                        <div class=\"grid grid-cols-1 sm:grid-cols-3 gap-4\">\n                            <div>\n                                <label class=\"" + LBL + "\" for=\"hcAmount\">Amount</label>\n                                <input id=\"hcAmount\" type=\"number\" name=\"amount\" required min=\"-100000\" max=\"100000\" step=\"1\" placeholder=\"50\" class=\"" + IN + "\">\n                            </div>\n                            <div class=\"sm:col-span-2\">\n                                <label class=\"" + LBL + "\" for=\"hcNote\">Note <span class=\"text-gray-500 font-normal\">(the user sees it)</span></label>\n                                <input id=\"hcNote\" type=\"text\" name=\"note\" maxlength=\"150\" placeholder=\"e.g. Thanks for your feedback!\" class=\"" + IN + "\">\n                            </div>\n                        </div>\n                        <p class=\"text-xs text-gray-500\">A negative amount takes honeycombs away (e.g. −20). The balance can’t go below 0.</p>\n                        <button type=\"submit\" class=\"" + SUBMIT + "\"><i class='bx bx-gift'></i> Send</button>\n                    </form>\n                </div>\n\n";
  o += "                <div class=\"bg-card border border-bordercolor rounded-xl shadow-xl overflow-hidden\">\n                    <div class=\"flex flex-wrap items-center justify-between gap-3 p-5 sm:p-6 border-b border-bordercolor\">\n                        <h2 class=\"text-base font-semibold text-white flex items-center gap-2\"><i class='bx bx-wallet text-xl text-brand-400'></i> Balances</h2>\n                        <input type=\"search\" id=\"hcFilter\" placeholder=\"Search users …\" class=\"" + IN + " sm:!w-64\">\n                    </div>\n                    <div class=\"overflow-x-auto\">\n                        <table class=\"w-full text-sm text-left\">\n                            <thead class=\"text-xs text-gray-500 uppercase bg-inputbg\">\n                                <tr><th class=\"px-5 py-3 font-medium\">User</th><th class=\"px-4 py-3 font-medium text-right\">Balance</th><th class=\"px-4 py-3 font-medium text-right hidden sm:table-cell\">Earned</th><th class=\"px-4 py-3 font-medium text-right hidden sm:table-cell\">Spent</th><th class=\"px-5 py-3\"></th></tr>\n                            </thead>\n                            <tbody class=\"divide-y divide-bordercolor\" id=\"hcRows\">\n";
  for (const u of hcUsers) {
    const uid = intval(u.id);
    const b = balances.get(uid) ?? null;
    o += '                                <tr data-search="' + e(strtolower(phpStr(userName(u)) + ' ' + phpStr(u.email) + ' ' + phpStr(u.username))) + '">\n'
      + '                                    <td class="px-5 py-3"><span class="text-white">' + e(userName(u)) + '</span><span class="block text-xs text-gray-500 break-all">' + e(u.email) + '</span></td>\n'
      + '                                    <td class="px-4 py-3 text-right font-bold text-white whitespace-nowrap">' + numberFormat(intval(b?.balance ?? 0)) + " <i class='bx bx-hive text-yellow-400'></i></td>\n"
      + '                                    <td class="px-4 py-3 text-right text-gray-400 hidden sm:table-cell">' + numberFormat(intval(b?.earned ?? 0)) + '</td>\n'
      + '                                    <td class="px-4 py-3 text-right text-gray-400 hidden sm:table-cell">' + numberFormat(intval(b?.spent ?? 0)) + '</td>\n'
      + '                                    <td class="px-5 py-3 text-right"><button type="button" class="' + BTN + '" data-hc-give="' + uid + "\"><i class='bx bx-gift'></i> Give</button></td>\n"
      + '                                </tr>\n';
  }
  o += "                            </tbody>\n                        </table>\n                    </div>\n                </div>\n";
  o += "                <script>\n                    // „Give“ in der Liste wählt den Nutzer oben aus; Suche filtert die Liste\n                    document.querySelectorAll('[data-hc-give]').forEach(b => b.addEventListener('click', () => {\n                        document.getElementById('hcUser').value = b.dataset.hcGive;\n                        document.getElementById('hcGrantForm').scrollIntoView({ behavior: 'smooth', block: 'center' });\n                        setTimeout(() => document.getElementById('hcAmount').focus(), 300);\n                    }));\n                    document.getElementById('hcFilter').addEventListener('input', e => {\n                        const q = e.target.value.trim().toLowerCase();\n                        document.querySelectorAll('#hcRows tr').forEach(tr => { tr.hidden = q !== '' && !tr.dataset.search.includes(q); });\n                    });\n                </script>\n";
  return o;
}
