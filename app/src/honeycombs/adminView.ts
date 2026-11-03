// Admin, Bereich „Honeycombs“ (Teil von views/admin.php): Unterbereiche über /admin?hc_tab=<bereich>#honeycombs –
// Übersicht (Kennzahlen, was bald endet, meistverkaufte Optionen, verdient nach Grund, was Aufmerksamkeit braucht,
// letzte Buchungen), Katalog & Preise, Angebote, Regeln zum Verdienen und Nutzer (Honigwaben vergeben, Kontostände).
// Gezeigt wird nur der gewählte Unterbereich (seine Abfragen laufen nur dann). Aussehen wie die übrigen Karten des
// Admin-Bereichs; Honigwaben-Symbole gelb. Jeder Text aus der Datenbank geht durch e().
import { earnLimits, type EarnLimits } from './earn.js';
import type { Ctx } from '../web/ctx.js';
import { q, one, value, type Row } from '../db.js';
import { date, intval, numberFormat, phpStr, strtolower, strtotime, ucfirst } from '../php.js';
import { e, phpJson } from '../html.js';
import { randomHex } from '../crypto.js';
import { csrfField } from '../web/security.js';
import { confirmAttrs, confirmField } from '../views/partials/ui.js';
import { GRANT_ASK_ABOVE, HC_MAX_VIEW_REWARDS, hcDescribe, hcSettings, type HcSettings } from './honeycombs.js';
import { ensureCatalogue, optionLabel, optionTitle } from './catalogue.js';
import { feature, featureReady, features, type Feature, type ItemRow } from './features.js';
import { MAX_OPEN_OFFERS, type OfferRow } from './offers.js';
import { addDays, nowStr } from './clock.js';
import { HC_TABS, hcTab, switchOnProblem, type HcTab } from './admin.js';
import { LIFECYCLE_READY } from './features.js';
import { isActive, type EntRow } from './entitlements.js';
import { refundableValue, type PurchaseRow } from './shop.js';
import { premiumReady } from './premium.js';
import { REVERSIBLE, reversedIds } from './teamTools.js';
import { CODE_MAX_AMOUNT, codeStatus, type CodeRow } from './codes.js';
import { bulkFromSession } from './bulkAction.js';
import { Session } from '../web/session.js';

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
  purchases: ['Purchases', 'bx-receipt'],
  ledger: ['Ledger', 'bx-list-ul'],
  codes: ['Codes', 'bx-purchase-tag-alt'],
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
  else if (tab === 'purchases') o += await purchasesTab(ctx, csrf, now);
  else if (tab === 'ledger') o += await ledgerTab(ctx, csrf);
  else if (tab === 'codes') o += await codesTab(csrf, now);
  else o += await users(ctx, csrf, allUsers, now);
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
  const settings: HcSettings & EarnLimits = { ...await hcSettings(), ...await earnLimits() };
  const ruleFields: Array<[keyof (HcSettings & EarnLimits), [string, string]]> = [
    ['daily', ['Active day', 'For opening the editor (once a day)']],
    ['profile', ['Complete profile', 'Once: profile picture, bio and at least 3 links']],
    ['views', ['Visitors', 'Per step of page views (one step a day, up to ' + HC_MAX_VIEW_REWARDS + ' times)']],
    ['views_step', ['Views per step', 'How many page views make one step']],
    ['streak_week', ['7-day streak', 'Bonus every 7 days in a row']],
    ['streak_month', ['30-day streak', 'Bonus every 30 days in a row (instead of the 7-day bonus that day)']],
    ['daily_cap', ['Daily limit', 'Most honeycombs one user can get per day from automatic rewards (not daily, streaks, gifts or codes)']],
  ];
  let o = `                <div class="${CARD} p-5 sm:p-6 max-w-2xl">\n                    <div class="flex items-center gap-3 mb-5 border-b border-bordercolor pb-4">\n                        <i class='bx bx-slider-alt text-2xl text-brand-400'></i>\n                        <h2 class="text-base font-semibold text-white">How users earn them</h2>\n                    </div>\n`;
  o += '                    <form action="/admin" method="POST" class="space-y-3" id="hcRulesForm">\n                        ' + csrf + '                        <input type="hidden" name="hc_action" value="settings">\n';
  for (const [key, [title, hint]] of ruleFields) {
    o += `                        <div class="flex items-center gap-3">\n                            <label class="flex-1 min-w-0" for="hcRule-${key}"><span class="block text-sm text-white">${e(title)}</span><span class="block text-xs text-gray-500">${e(hint)}</span></label>\n`
      + `                            <input id="hcRule-${key}" type="number" name="${key}" min="${key === 'views_step' ? 1 : key === 'daily_cap' ? 50 : 0}" max="100000" step="1" value="${intval(settings[key])}" class="${IN} !w-28 text-right">\n                        </div>\n`;
  }
  o += '                        <p class="text-xs text-gray-500 pt-1">0 switches a reward off. Changes count from now on – nobody loses honeycombs they already have. Prices are set under <a href="/admin?hc_tab=catalogue#honeycombs" class="text-brand-400 hover:text-brand-300">Catalogue &amp; prices</a>.</p>\n'
    + `                        <button type="submit" class="${SUBMIT}"><i class='bx bx-save'></i> Save</button>\n                    </form>\n                </div>\n`;
  return o;
}

// ---------------------------------------------------------------- Nutzer: Honigwaben vergeben, Kontostände (wie bisher)

// Suchtext (?hc_q=, höchstens 100 Zeichen) und Seite (?hc_p=, 50 je Seite)
const PER_PAGE = 50;
function searchText(v: unknown): string {
  return typeof v === 'string' ? v.trim().slice(0, 100) : '';
}
function pageNo(v: unknown): number {
  return typeof v === 'string' && /^[1-9][0-9]{0,5}$/.test(v) ? Number(v) : 1;
}
// ?hc_user=<id> → Konto-ID (sonst 0)
function detailUser(v: unknown): number {
  return typeof v === 'string' && /^[1-9][0-9]{0,9}$/.test(v) && Number(v) <= 2147483647 ? Number(v) : 0;
}

// Stand einer Berechtigung als Text: für immer, bis Datum, Anzahl, beendet
function entState(r: EntRow, now: string): string {
  if (!isActive(r, now)) return 'Ended';
  const f = feature(r.feature);
  const count = f && f.kind !== 'timed' && f.kind !== 'permanent' ? intval(r.quantity) + ' · ' : '';
  if (intval(r.permanent) === 1) return count + 'For good';
  return count + 'Until ' + date('M j, Y', stamp(r.expires_at));
}

async function users(ctx: Ctx, csrf: string, allUsers: Row[], now: string): Promise<string> {
  const balances = new Map<number, Row>();
  for (const row of await q('SELECT user_id, SUM(amount) AS balance, SUM(GREATEST(amount, 0)) AS earned, SUM(GREATEST(-amount, 0)) AS spent FROM honeycomb_ledger GROUP BY user_id')) {
    balances.set(intval(row.user_id), row);
  }
  const balanceOf = (u: Row): number => intval(balances.get(intval(u.id))?.balance ?? 0);
  // Suche auf dem Server: Name, E-Mail, Benutzername (ohne Groß/klein)
  const query = searchText(ctx.get.hc_q);
  const needle = strtolower(query);
  const found = [...allUsers].filter((u) => needle === '' || strtolower(phpStr(userName(u)) + ' ' + phpStr(u.email) + ' ' + phpStr(u.username)).includes(needle))
    .sort((a, b) => Math.sign(balanceOf(b) - balanceOf(a)) || Math.sign(intval(b.id) - intval(a.id)));
  const pages = Math.max(1, Math.ceil(found.length / PER_PAGE));
  const pageNow = Math.min(pageNo(ctx.get.hc_p), pages);
  const hcUsers = found.slice((pageNow - 1) * PER_PAGE, pageNow * PER_PAGE);
  // Premium je Konto (aktiv): für immer, bis Datum, vom Team
  const premium = new Map<number, string>();
  for (const r of await q<EntRow>("SELECT * FROM hc_entitlements WHERE feature = 'premium'")) {
    if (!isActive(r, now)) continue;
    const label = intval(r.permanent) === 1 ? 'for good' : 'until ' + date('M j', stamp(r.expires_at));
    premium.set(intval(r.user_id), label + (r.source === 'admin' ? ' · admin' : ''));
  }
  const frozen = new Set<number>();
  for (const r of await q('SELECT user_id FROM hc_accounts WHERE frozen_at IS NOT NULL')) frozen.add(intval(r.user_id));
  let o = '';
  const uidDetail = detailUser(ctx.get.hc_user);
  if (uidDetail > 0) o += await userDetails(csrf, uidDetail, now);
  const bulk = bulkFromSession(await Session.start(ctx));
  o += "                <div class=\"bg-card border border-bordercolor rounded-xl shadow-xl p-5 sm:p-6\">\n                    <div class=\"flex items-center gap-3 mb-5 border-b border-bordercolor pb-4\">\n                        <i class='bx bx-hive text-2xl text-yellow-400'></i>\n                        <h2 class=\"text-base font-semibold text-white\">Give honeycombs</h2>\n                    </div>\n                    <form action=\"/admin\" method=\"POST\" class=\"space-y-4\" id=\"hcGrantForm\" data-hc-ask-above=\"" + GRANT_ASK_ABOVE + "\""
    + confirmAttrs({ title: 'Send these honeycombs?', text: 'Please check the user and the amount. A negative amount takes honeycombs away.', ok: 'Send', tone: 'warn' }) + ">\n                        ";
  o += csrf.trimEnd() + confirmField() + '\n';
  o += "                        <input type=\"hidden\" name=\"hc_action\" value=\"grant\">\n                        <input type=\"hidden\" name=\"grant_ref\" value=\"";
  o += randomHex(8);
  o += "\">\n                        <div>\n                            <label class=\"" + LBL + "\" for=\"hcUser\">User</label>\n                            <select id=\"hcUser\" name=\"user_id\" required data-error-required=\"Please choose a user.\" class=\"" + IN + "\">\n                                <option value=\"\">Choose a user …</option>\n";
  for (const u of allUsers) {
    o += '                                <option value="' + intval(u.id) + '" data-name="' + e(userName(u)) + '">' + e(userName(u)) + ' · ' + e(u.email) + ' (' + intval(balances.get(intval(u.id))?.balance ?? 0) + ')</option>\n';
  }
  o += "                            </select>\n                        </div>\n                        <div class=\"grid grid-cols-1 sm:grid-cols-3 gap-4\">\n                            <div>\n                                <label class=\"" + LBL + "\" for=\"hcAmount\">Amount</label>\n                                <input id=\"hcAmount\" type=\"number\" name=\"amount\" required min=\"-100000\" max=\"100000\" step=\"1\" placeholder=\"50\" class=\"" + IN + "\">\n                            </div>\n                            <div class=\"sm:col-span-2\">\n                                <label class=\"" + LBL + "\" for=\"hcNote\">Note <span class=\"text-gray-500 font-normal\">(the user sees it)</span></label>\n                                <input id=\"hcNote\" type=\"text\" name=\"note\" maxlength=\"150\" placeholder=\"e.g. Thanks for your feedback!\" class=\"" + IN + "\">\n                            </div>\n                        </div>\n                        <p class=\"text-xs text-gray-500\">A negative amount takes honeycombs away (e.g. −20). The balance can’t go below 0.</p>\n                        <button type=\"submit\" class=\"" + SUBMIT + "\"><i class='bx bx-gift'></i> Send</button>\n                    </form>\n                </div>\n\n";
  o += bulkCard(csrf, bulk);
  o += "                <div class=\"bg-card border border-bordercolor rounded-xl shadow-xl overflow-hidden\">\n                    <div class=\"flex flex-wrap items-center justify-between gap-3 p-5 sm:p-6 border-b border-bordercolor\">\n                        <h2 class=\"text-base font-semibold text-white flex items-center gap-2\"><i class='bx bx-wallet text-xl text-brand-400'></i> Balances</h2>\n                        <form action=\"/admin#honeycombs\" method=\"GET\" class=\"m-0 flex gap-2\" role=\"search\"><input type=\"hidden\" name=\"hc_tab\" value=\"users\"><input type=\"search\" id=\"hcFilter\" name=\"hc_q\" maxlength=\"100\" value=\"" + e(query) + "\" placeholder=\"Search users …\" class=\"" + IN + " sm:!w-64\"><button type=\"submit\" class=\"" + BTN + "\"><i class='bx bx-search'></i> Search</button></form>\n                    </div>\n                    <div class=\"overflow-x-auto\">\n                        <table class=\"w-full text-sm text-left\">\n                            <thead class=\"text-xs text-gray-500 uppercase bg-inputbg\">\n                                <tr><th class=\"px-5 py-3 font-medium\">User</th><th class=\"px-4 py-3 font-medium text-right\">Balance</th><th class=\"px-4 py-3 font-medium text-right hidden sm:table-cell\">Earned</th><th class=\"px-4 py-3 font-medium text-right hidden sm:table-cell\">Spent</th><th class=\"px-4 py-3 font-medium hidden sm:table-cell\">Premium</th><th class=\"px-5 py-3\"></th></tr>\n                            </thead>\n                            <tbody class=\"divide-y divide-bordercolor\" id=\"hcRows\">\n";
  for (const u of hcUsers) {
    const uid = intval(u.id);
    const b = balances.get(uid) ?? null;
    o += '                                <tr data-search="' + e(strtolower(phpStr(userName(u)) + ' ' + phpStr(u.email) + ' ' + phpStr(u.username))) + '">\n'
      + '                                    <td class="px-5 py-3"><span class="text-white">' + e(userName(u)) + '</span><span class="block text-xs text-gray-500 break-all">' + e(u.email) + '</span></td>\n'
      + '                                    <td class="px-4 py-3 text-right font-bold text-white whitespace-nowrap">' + numberFormat(intval(b?.balance ?? 0)) + " <i class='bx bx-hive text-yellow-400'></i></td>\n"
      + '                                    <td class="px-4 py-3 text-right text-gray-400 hidden sm:table-cell">' + numberFormat(intval(b?.earned ?? 0)) + '</td>\n'
      + '                                    <td class="px-4 py-3 text-right text-gray-400 hidden sm:table-cell">' + numberFormat(intval(b?.spent ?? 0)) + '</td>\n'
      + '                                    <td class="px-4 py-3 text-gray-400 hidden sm:table-cell whitespace-nowrap">' + e(premium.get(uid) ?? '–') + (frozen.has(uid) ? ` <span class="${BADGE} bg-sky-500/15 text-sky-400">Frozen</span>` : '') + '</td>\n'
      + '                                    <td class="px-5 py-3 text-right whitespace-nowrap"><button type="button" class="' + BTN + '" data-hc-give="' + uid + "\"><i class='bx bx-gift'></i> Give</button> <a href=\"/admin?hc_tab=users&amp;hc_user=" + uid + "#honeycombs\" class=\"" + BTN + "\"><i class='bx bx-detail'></i> Details</a></td>\n"
      + '                                </tr>\n';
  }
  o += "                            </tbody>\n                        </table>\n                    </div>\n";
  if (pages > 1) {
    const link = (n: number): string => '/admin?hc_tab=users' + (query !== '' ? '&amp;hc_q=' + encodeURIComponent(query) : '') + '&amp;hc_p=' + n + '#honeycombs';
    o += `                    <div class="flex items-center justify-between gap-3 p-4 border-t border-bordercolor text-xs text-gray-500" id="hcPager"><span>Page ${pageNow} of ${pages} · ${numberFormat(found.length)} users</span><span class="flex gap-1.5">`
      + (pageNow > 1 ? `<a href="${link(pageNow - 1)}" class="${BTN}">Previous</a>` : '') + (pageNow < pages ? `<a href="${link(pageNow + 1)}" class="${BTN}">Next</a>` : '') + '</span></div>\n';
  }
  o += "                </div>\n";
  o += "                <script>\n                    // „Give“ in der Liste wählt den Nutzer oben aus; Suche filtert die Liste\n                    document.querySelectorAll('[data-hc-give]').forEach(b => b.addEventListener('click', () => {\n                        document.getElementById('hcUser').value = b.dataset.hcGive;\n                        document.getElementById('hcGrantForm').scrollIntoView({ behavior: 'smooth', block: 'center' });\n                        setTimeout(() => document.getElementById('hcAmount').focus(), 300);\n                    }));\n                    // Abziehen und Gaben über der Grenze fragen im eigenen Dialog (Name und Betrag als Text); normale Gaben ohne Rückfrage\n                    document.addEventListener('DOMContentLoaded', () => {\n                        const grant = document.getElementById('hcGrantForm');\n                        if (!window.OYSUI || !grant) return;\n                        const above = parseInt(grant.dataset.hcAskAbove, 10) || 0;\n                        const fmt = (n) => n.toLocaleString('en-US');\n                        OYSUI.beforeSubmit(grant, (form) => {\n                            const n = parseInt(form.amount.value, 10) || 0;\n                            const opt = form.user_id.options[form.user_id.selectedIndex];\n                            const who = opt && opt.value !== '' ? opt.dataset.name : 'this user';\n                            if (n < 0) return { title: 'Take ' + fmt(-n) + ' honeycombs from ' + who + '?', text: 'They’re taken from the balance right away, and ' + who + ' gets a notification.', ok: 'Take honeycombs', tone: 'danger' };\n                            if (n > above) return { title: 'Give ' + fmt(n) + ' honeycombs to ' + who + '?', text: 'That’s more than ' + fmt(above) + ' – please check the amount.', ok: 'Give honeycombs', tone: 'warn' };\n                            return null;\n                        });\n                    });\n                    document.getElementById('hcFilter').addEventListener('input', e => {\n                        const q = e.target.value.trim().toLowerCase();\n                        document.querySelectorAll('#hcRows tr').forEach(tr => { tr.hidden = q !== '' && !tr.dataset.search.includes(q); });\n                    });\n                </script>\n";
  return o;
}

// ---------------------------------------------------------------- Erstatten (Details eines Nutzers und Käufe)

// Formular „Refund“ eines Kaufs: Betrag (Vorgabe: der erstattbare Wert), wegnehmen oder behalten (vorgewählt nur bei
// voller Erstattung), Notiz; mit Bestätigungsdialog
async function refundForm(csrf: string, p: PurchaseRow, name: string, now: string): Promise<string> {
  const uid = intval(p.user_id);
  const f = feature(p.feature);
  const title = itemTitle(p);
  const price = intval(p.price);
  const ent = await one<EntRow>('SELECT * FROM hc_entitlements WHERE user_id = ? AND feature = ? AND lot = ?', [uid, p.feature, intval(p.lot)]);
  const quantityNow = ent && isActive(ent, now) ? intval(ent.quantity) : 0;
  const kind = f?.kind ?? (p.days !== null ? 'timed' : 'permanent');
  const r = refundableValue({ kind, price, units: intval(p.units), periodStart: p.period_start, periodEnd: p.period_end }, quantityNow, now);
  const full = r.value === price;
  const hidden = (n: string, v: string | number): string => `<input type="hidden" name="${n}" value="${e(String(v))}">`;
  return `                                    <form action="/admin" method="POST" class="mt-2 grid grid-cols-1 sm:grid-cols-5 gap-2 items-end" data-hc-refund="${e(title)}" data-hc-refund-name="${e(name)}"${confirmAttrs({ title: 'Refund “' + title + '” to ' + name + '?', text: 'The amount you entered goes back to the balance. This can’t be undone.', ok: 'Refund', tone: 'danger' })}>`
    + csrf.trim() + hidden('user_id', uid) + confirmField() + hidden('hc_action', 'refund') + hidden('purchase_id', intval(p.id)) + '\n'
    + `                                        <div><label class="${SMALL}">Amount <span class="text-gray-500 font-normal">(max ${numberFormat(r.value)} – the unused part)</span></label><input type="number" name="amount" min="0" max="${r.value}" step="1" value="${r.value}" class="${IN}"></div>\n`
    + `                                        <div class="sm:col-span-2"><label class="${SMALL}">What was bought</label><select name="remove" class="${IN}"><option value="1"${full ? ' selected' : ''}>Also remove what was bought</option><option value="0"${full ? '' : ' selected'}>Keep what was bought</option></select></div>\n`
    + `                                        <div><label class="${SMALL}">Note <span class="text-gray-500 font-normal">(the user sees it)</span></label><input type="text" name="note" maxlength="150" class="${IN}"></div>\n`
    + `                                        <div><button type="submit" class="${BTN} hover:text-red-400"><i class='bx bx-undo'></i> Refund</button></div>\n`
    + '                                    </form>';
}

// Rückfrage mit dem eingegebenen Betrag (OYSUI.beforeSubmit); die Attribute des Formulars gelten, falls das Skript fehlt.
// Namen und Titel kommen aus data-Attributen und werden als Text gezeigt.
const REFUND_SCRIPT = "                <script>\n"
  + "                    // Erstatten: der Dialog nennt den Betrag und ob auch weggenommen wird\n"
  + "                    document.addEventListener('DOMContentLoaded', () => {\n"
  + "                        if (!window.OYSUI) return;\n"
  + "                        document.querySelectorAll('form[data-hc-refund]').forEach((f) => OYSUI.beforeSubmit(f, (form) => {\n"
  + "                            const n = Math.max(0, parseInt(form.amount.value, 10) || 0);\n"
  + "                            const what = '“' + form.dataset.hcRefund + '”';\n"
  + "                            return { title: 'Refund ' + n + ' honeycombs to ' + form.dataset.hcRefundName + '?',\n"
  + "                                text: (form.remove.value === '1' ? what + ' is removed too.' : what + ' stays.') + ' This can’t be undone.', ok: 'Refund', tone: 'danger' };\n"
  + "                        }));\n"
  + "                    });\n"
  + "                </script>\n";

// ---------------------------------------------------------------- Käufe (HC-6a)

// Filter: Option (?hc_item=), Nutzer (?hc_q=), Zeitraum (?hc_from=/?hc_to=, YYYY-MM-DD), Stand (?hc_status=open|refunded)
async function purchasesTab(ctx: Ctx, csrf: string, now: string): Promise<string> {
  const itemKey = typeof ctx.get.hc_item === 'string' && /^[a-z][a-z0-9_]{1,39}$/.test(ctx.get.hc_item) ? ctx.get.hc_item : '';
  const query = searchText(ctx.get.hc_q);
  const day = (v: unknown): string => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');
  const from = day(ctx.get.hc_from);
  const to = day(ctx.get.hc_to);
  const status = ctx.get.hc_status === 'open' || ctx.get.hc_status === 'refunded' ? ctx.get.hc_status : '';
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (itemKey !== '') { where.push('p.item_key = ?'); params.push(itemKey); }
  if (query !== '') {
    const like = '%' + query.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    where.push('(u.full_name LIKE ? OR u.email LIKE ? OR u.username LIKE ?)');
    params.push(like, like, like);
  }
  if (from !== '') { where.push('p.created_at >= ?'); params.push(from + ' 00:00:00'); }
  if (to !== '') { where.push('p.created_at <= ?'); params.push(to + ' 23:59:59'); }
  if (status === 'open') where.push('p.refunded_at IS NULL');
  if (status === 'refunded') where.push('p.refunded_at IS NOT NULL');
  const cond = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = intval(await value(`SELECT COUNT(*) FROM hc_purchases p JOIN users u ON u.id = p.user_id ${cond}`, params));
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const pageNow = Math.min(pageNo(ctx.get.hc_p), pages);
  const list = await q<PurchaseRow>(`SELECT p.*, u.full_name, u.email, o.label AS offer_label FROM hc_purchases p JOIN users u ON u.id = p.user_id
      LEFT JOIN hc_offers o ON o.id = p.offer_id ${cond} ORDER BY p.id DESC LIMIT ${PER_PAGE} OFFSET ${(pageNow - 1) * PER_PAGE}`, params);
  const items = await q('SELECT item_key, feature, days, units FROM hc_items ORDER BY feature, position, id');
  let o = `                <div class="${CARD} overflow-hidden" id="hcPurchases">\n` + cardHead('bx-receipt', 'Purchases')
    + `                    <form action="/admin#honeycombs" method="GET" class="p-5 sm:p-6 border-b border-bordercolor grid grid-cols-1 sm:grid-cols-5 gap-3 items-end">`
    + '<input type="hidden" name="hc_tab" value="purchases">\n'
    + `                        <div><label class="${SMALL}" for="hcPItem">Option</label><select id="hcPItem" name="hc_item" class="${IN}"><option value="">All</option>`
    + items.map((i) => `<option value="${e(i.item_key)}"${i.item_key === itemKey ? ' selected' : ''}>${e(itemTitle(i as unknown as ItemRow))}</option>`).join('') + '</select></div>\n'
    + `                        <div><label class="${SMALL}" for="hcPUser">User</label><input id="hcPUser" type="search" name="hc_q" maxlength="100" value="${e(query)}" placeholder="Name or email" class="${IN}"></div>\n`
    + `                        <div><label class="${SMALL}" for="hcPFrom">From</label><input id="hcPFrom" type="date" name="hc_from" value="${e(from)}" class="${IN}"></div>\n`
    + `                        <div><label class="${SMALL}" for="hcPTo">To</label><input id="hcPTo" type="date" name="hc_to" value="${e(to)}" class="${IN}"></div>\n`
    + `                        <div class="flex gap-2"><select name="hc_status" aria-label="Status" class="${IN}"><option value="">All</option><option value="open"${status === 'open' ? ' selected' : ''}>Not refunded</option><option value="refunded"${status === 'refunded' ? ' selected' : ''}>Refunded</option></select>`
    + `<button type="submit" class="${BTN}"><i class='bx bx-filter-alt'></i> Filter</button></div>\n`
    + '                    </form>\n';
  if (!list.length) {
    o += '                    <p class="p-5 sm:p-6 text-sm text-gray-500">No purchases found.</p>\n';
  } else {
    o += '                    <ul class="divide-y divide-bordercolor text-sm px-5 sm:px-6" id="hcPurchaseRows">\n';
    for (const p of list) {
      const name = phpStr(userName(p));
      const price = intval(p.price);
      const period = p.period_start !== null && p.period_end !== null ? ' · ' + date('M j', stamp(p.period_start)) + ' – ' + date('M j, Y', stamp(p.period_end)) : '';
      o += `                        <li class="py-3" data-purchase="${intval(p.id)}"><div class="flex flex-wrap items-center justify-between gap-2"><span><a href="/admin?hc_tab=users&amp;hc_user=${intval(p.user_id)}#honeycombs" class="text-white hover:underline">${e(name)}</a> · <span class="text-gray-300">${e(itemTitle(p))}</span>`
        + `<span class="block text-xs text-gray-500">${e(when(p.created_at))} · ${numberFormat(price)}${intval(p.list_price) !== price ? ' (list ' + numberFormat(intval(p.list_price)) + ')' : ''} honeycombs${p.offer_label ? ' · ' + e(p.offer_label) : ''}${e(period)}</span></span>`;
      if (p.refunded_at !== null) {
        o += `<span class="${BADGE} bg-white/5 text-gray-400">Refunded +${numberFormat(intval(p.refund_amount))}</span></div></li>\n`;
        continue;
      }
      o += '</div>\n' + (await refundForm(csrf, p, name, now)) + '</li>\n';
    }
    o += '                    </ul>\n';
  }
  if (pages > 1) {
    const qs = (n: number): string => '/admin?hc_tab=purchases' + (itemKey ? '&amp;hc_item=' + itemKey : '') + (query ? '&amp;hc_q=' + encodeURIComponent(query) : '')
      + (from ? '&amp;hc_from=' + from : '') + (to ? '&amp;hc_to=' + to : '') + (status ? '&amp;hc_status=' + status : '') + '&amp;hc_p=' + n + '#honeycombs';
    o += `                    <div class="flex items-center justify-between gap-3 p-4 border-t border-bordercolor text-xs text-gray-500"><span>Page ${pageNow} of ${pages} · ${numberFormat(total)} purchases</span><span class="flex gap-1.5">`
      + (pageNow > 1 ? `<a href="${qs(pageNow - 1)}" class="${BTN}">Previous</a>` : '') + (pageNow < pages ? `<a href="${qs(pageNow + 1)}" class="${BTN}">Next</a>` : '') + '</span></div>\n';
  }
  o += '                </div>\n' + REFUND_SCRIPT;
  return o;
}

// ---------------------------------------------------------------- Buchungen zurücknehmen (HC-6b)

// Knopf „Reverse“ einer Buchung (nur Belohnungen und Gaben, je einmal); fromTab: wohin es danach zurückgeht
function reverseForm(csrf: string, l: Row, name: string, reversed: ReadonlySet<number>, fromTab: '' | 'ledger'): string {
  const id = intval(l.id);
  const amount = intval(l.amount);
  if (!REVERSIBLE.includes(phpStr(l.reason)) || amount === 0) return '';
  if (reversed.has(id)) return `<span class="${BADGE} bg-white/5 text-gray-400">Reversed</span>`;
  const text = (amount > 0 ? 'Take ' + numberFormat(amount) + ' honeycombs back from ' : 'Give ' + numberFormat(-amount) + ' honeycombs back to ') + name + '?';
  return `<form action="/admin" method="POST" class="m-0 shrink-0"${confirmAttrs({ title: 'Reverse this entry?', text: text + ' They see it in their history.', ok: 'Reverse', tone: 'danger' })}>`
    + csrf.trim() + confirmField() + `<input type="hidden" name="hc_action" value="reverse"><input type="hidden" name="ledger_id" value="${id}"><input type="hidden" name="user_id" value="${intval(l.user_id)}">`
    + (fromTab ? `<input type="hidden" name="from_tab" value="${fromTab}">` : '')
    + `<button type="submit" class="${BTN} !py-1 !min-h-0 hover:text-red-400"><i class='bx bx-undo'></i> Reverse</button></form>`;
}

const LEDGER_REASONS: ReadonlyArray<[string, string]> = [['admin', 'Gifts from the team'], ['daily', 'Active days'], ['profile', 'Completed profiles'], ['views', 'Page views'],
  ['streak', 'Streaks'], ['code', 'Codes'], ['purchase', 'Purchases'], ['unlock', 'Unlocks'], ['refund', 'Refunds'], ['reversal', 'Reversals'], ['grant', 'Unlocks from the team'], ['revoke', 'Removed by the team']];

// Unterbereich „Ledger“: alle Buchungen mit Filtern (Grund ?hc_reason=, Nutzer ?hc_q=, Zeitraum ?hc_from=/?hc_to=)
async function ledgerTab(ctx: Ctx, csrf: string): Promise<string> {
  const reasonIn = typeof ctx.get.hc_reason === 'string' ? ctx.get.hc_reason : '';
  const reason = LEDGER_REASONS.some(([k]) => k === reasonIn) ? reasonIn : '';
  const query = searchText(ctx.get.hc_q);
  const day = (v: unknown): string => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');
  const from = day(ctx.get.hc_from);
  const to = day(ctx.get.hc_to);
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (reason !== '') { where.push('l.reason = ?'); params.push(reason); }
  if (query !== '') {
    const like = '%' + query.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    where.push('(u.full_name LIKE ? OR u.email LIKE ? OR u.username LIKE ?)');
    params.push(like, like, like);
  }
  if (from !== '') { where.push('l.created_at >= ?'); params.push(from + ' 00:00:00'); }
  if (to !== '') { where.push('l.created_at <= ?'); params.push(to + ' 23:59:59'); }
  const cond = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = intval(await value(`SELECT COUNT(*) FROM honeycomb_ledger l JOIN users u ON u.id = l.user_id ${cond}`, params));
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const pageNow = Math.min(pageNo(ctx.get.hc_p), pages);
  const rows = await q(`SELECT l.*, u.full_name, u.email, a.full_name AS admin_name, a.email AS admin_email FROM honeycomb_ledger l JOIN users u ON u.id = l.user_id
      LEFT JOIN users a ON a.id = l.actor_id ${cond} ORDER BY l.id DESC LIMIT ${PER_PAGE} OFFSET ${(pageNow - 1) * PER_PAGE}`, params);
  const reversed = await reversedIds(rows.map((r) => intval(r.id)));
  let o = `                <div class="${CARD} overflow-hidden" id="hcLedger">\n` + cardHead('bx-list-ul', 'Ledger')
    + `                    <form action="/admin#honeycombs" method="GET" class="p-5 sm:p-6 border-b border-bordercolor grid grid-cols-1 sm:grid-cols-5 gap-3 items-end">`
    + '<input type="hidden" name="hc_tab" value="ledger">\n'
    + `                        <div><label class="${SMALL}" for="hcLReason">Reason</label><select id="hcLReason" name="hc_reason" class="${IN}"><option value="">All</option>`
    + LEDGER_REASONS.map(([k, label]) => `<option value="${k}"${k === reason ? ' selected' : ''}>${e(label)}</option>`).join('') + '</select></div>\n'
    + `                        <div><label class="${SMALL}" for="hcLUser">User</label><input id="hcLUser" type="search" name="hc_q" maxlength="100" value="${e(query)}" placeholder="Name or email" class="${IN}"></div>\n`
    + `                        <div><label class="${SMALL}" for="hcLFrom">From</label><input id="hcLFrom" type="date" name="hc_from" value="${e(from)}" class="${IN}"></div>\n`
    + `                        <div><label class="${SMALL}" for="hcLTo">To</label><input id="hcLTo" type="date" name="hc_to" value="${e(to)}" class="${IN}"></div>\n`
    + `                        <div><button type="submit" class="${BTN}"><i class='bx bx-filter-alt'></i> Filter</button></div>\n`
    + '                    </form>\n';
  if (!rows.length) {
    o += '                    <p class="p-5 sm:p-6 text-sm text-gray-500">No entries found.</p>\n';
  } else {
    o += '                    <ul class="divide-y divide-bordercolor text-sm px-5 sm:px-6" id="hcLedgerRows">\n';
    for (const l of rows) {
      const name = phpStr(userName(l));
      const by = l.actor_id !== null ? ' · by ' + phpStr(phpStr(l.admin_name ?? '') !== '' ? l.admin_name : (l.admin_email ?? '#' + intval(l.actor_id))) : '';
      o += `                        <li class="py-2.5 flex flex-wrap items-center justify-between gap-3" data-ledger="${intval(l.id)}"><span class="min-w-0"><a href="/admin?hc_tab=users&amp;hc_user=${intval(l.user_id)}#honeycombs" class="text-white hover:underline">${e(name)}</a> · <span class="text-gray-300">${e(hcDescribe(l))}</span>`
        + `<span class="block text-xs text-gray-500">${e(when(l.created_at))}${e(by)}</span></span><span class="flex items-center gap-3">${amountHtml(intval(l.amount))}${reverseForm(csrf, l, name, reversed, 'ledger')}</span></li>\n`;
    }
    o += '                    </ul>\n';
  }
  if (pages > 1) {
    const qs = (n: number): string => '/admin?hc_tab=ledger' + (reason ? '&amp;hc_reason=' + reason : '') + (query ? '&amp;hc_q=' + encodeURIComponent(query) : '')
      + (from ? '&amp;hc_from=' + from : '') + (to ? '&amp;hc_to=' + to : '') + '&amp;hc_p=' + n + '#honeycombs';
    o += `                    <div class="flex items-center justify-between gap-3 p-4 border-t border-bordercolor text-xs text-gray-500"><span>Page ${pageNow} of ${pages} · ${numberFormat(total)} entries</span><span class="flex gap-1.5">`
      + (pageNow > 1 ? `<a href="${qs(pageNow - 1)}" class="${BTN}">Previous</a>` : '') + (pageNow < pages ? `<a href="${qs(pageNow + 1)}" class="${BTN}">Next</a>` : '') + '</span></div>\n';
  }
  return o + '                </div>\n';
}

// ---------------------------------------------------------------- Event-Codes (HC-9)

const CODE_BADGES: Readonly<Record<ReturnType<typeof codeStatus>, string>> = {
  running: 'bg-emerald-500/15 text-emerald-400', scheduled: 'bg-sky-500/15 text-sky-400', ended: 'bg-white/5 text-gray-400', off: 'bg-white/5 text-gray-400', 'used up': 'bg-white/5 text-gray-400',
};

// Anlegen (Code, Betrag, Zeitraum, höchstens so oft, Mindestalter, Notiz) und Liste mit „Disable“
async function codesTab(csrf: string, now: string): Promise<string> {
  let o = `                <div class="${CARD} p-5 sm:p-6" id="hcCodeCreate">\n` + `                    <div class="flex items-center gap-3 mb-5 border-b border-bordercolor pb-4"><i class='bx bx-purchase-tag-alt text-2xl text-yellow-400'></i><h2 class="text-base font-semibold text-white">Create a code</h2></div>\n`
    + `                    <form action="/admin" method="POST" class="grid grid-cols-1 sm:grid-cols-3 gap-4" id="hcCodeForm">` + csrf.trim() + '<input type="hidden" name="hc_action" value="code_create">\n'
    + `                        <div><label class="${LBL}" for="hcCode">Code</label><input id="hcCode" type="text" name="code" minlength="4" maxlength="32" pattern="[A-Za-z0-9\\-]{4,32}" title="4–32 letters, digits or dashes – empty: a random code" placeholder="Empty: a random code" autocomplete="off" class="${IN} uppercase"></div>\n`
    + `                        <div><label class="${LBL}" for="hcCodeAmount">Amount</label><input id="hcCodeAmount" type="number" name="amount" required min="1" max="${CODE_MAX_AMOUNT}" step="1" placeholder="50" class="${IN}"></div>\n`
    + `                        <div><label class="${LBL}" for="hcCodeNote">Note <span class="text-gray-500 font-normal">(in their history)</span></label><input id="hcCodeNote" type="text" name="note" maxlength="150" placeholder="Halloween 2026" class="${IN}"></div>\n`
    + `                        <div><label class="${LBL}" for="hcCodeFrom">From <span class="text-gray-500 font-normal">(optional)</span></label><input id="hcCodeFrom" type="datetime-local" name="starts_at" class="${IN}"></div>\n`
    + `                        <div><label class="${LBL}" for="hcCodeTo">Until <span class="text-gray-500 font-normal">(optional)</span></label><input id="hcCodeTo" type="datetime-local" name="ends_at" class="${IN}"></div>\n`
    + `                        <div class="grid grid-cols-2 gap-3"><div><label class="${LBL}" for="hcCodeMax">Max. uses</label><input id="hcCodeMax" type="number" name="max_uses" min="1" step="1" placeholder="No limit" class="${IN}"></div>`
    + `<div><label class="${LBL}" for="hcCodeAge">Min. age (days)</label><input id="hcCodeAge" type="number" name="min_account_days" min="0" max="3650" step="1" value="0" class="${IN}"></div></div>\n`
    + `                        <div class="sm:col-span-3"><button type="submit" class="${SUBMIT}"><i class='bx bx-plus'></i> Create code</button><p class="text-xs text-gray-500 mt-2">Each account can redeem a code once. Codes don’t count towards the daily limit.</p></div>\n`
    + '                    </form>\n                </div>\n';
  const rows = await q<CodeRow>('SELECT * FROM hc_codes ORDER BY id DESC LIMIT 200');
  o += `                <div class="${CARD} overflow-hidden" id="hcCodes">\n` + cardHead('bx-list-ul', 'Codes');
  if (!rows.length) return o + '                    <p class="p-5 sm:p-6 text-sm text-gray-500">No codes yet.</p>\n                </div>\n';
  o += '                    <ul class="divide-y divide-bordercolor text-sm px-5 sm:px-6" id="hcCodeRows">\n';
  for (const c of rows) {
    const st = codeStatus(c, now);
    const win = (c.starts_at ? 'from ' + date('M j, Y H:i', stamp(c.starts_at)) : '') + (c.ends_at ? (c.starts_at ? ' ' : '') + 'until ' + date('M j, Y H:i', stamp(c.ends_at)) : '');
    o += `                        <li class="py-3 flex flex-wrap items-center justify-between gap-3" data-code="${intval(c.id)}"><span class="min-w-0"><span class="font-mono text-white">${e(c.code)}</span> <span class="${BADGE} ${CODE_BADGES[st]}">${e(st)}</span>`
      + `<span class="block text-xs text-gray-500">${numberFormat(intval(c.amount))} honeycombs · ${numberFormat(intval(c.uses))}${c.max_uses !== null ? ' / ' + numberFormat(intval(c.max_uses)) : ''} uses${win ? ' · ' + e(win) : ''}${intval(c.min_account_days) > 0 ? ' · accounts ≥ ' + intval(c.min_account_days) + ' days' : ''}${phpStr(c.note) ? ' · ' + e(c.note) : ''}</span></span>`;
    if (c.disabled_at === null && st !== 'ended') {
      o += `<form action="/admin" method="POST" class="m-0"${confirmAttrs({ title: 'Turn off the code ' + phpStr(c.code) + '?', text: 'Nobody can redeem it any more. Honeycombs already given stay.', ok: 'Turn off', tone: 'danger' })}>`
        + csrf.trim() + confirmField() + `<input type="hidden" name="hc_action" value="code_disable"><input type="hidden" name="code_id" value="${intval(c.id)}"><button type="submit" class="${BTN} hover:text-red-400"><i class='bx bx-block'></i> Disable</button></form>`;
    }
    o += '</li>\n';
  }
  return o + '                    </ul>\n                </div>\n';
}

// Honigwaben an mehrere Nutzer: Formular mit der Liste und – nach „Check list“ – die Vorschau aus der Sitzung
function bulkCard(csrf: string, preview: ReturnType<typeof bulkFromSession>): string {
  let o = `                <details class="${CARD} p-5 sm:p-6" id="hcBulk"${preview ? ' open' : ''}><summary class="cursor-pointer text-sm font-semibold text-white flex items-center gap-2"><i class='bx bx-group text-xl text-yellow-400'></i> Give honeycombs to several users</summary>\n`
    + `                    <form action="/admin" method="POST" class="space-y-4 mt-4" id="hcBulkForm">` + csrf.trim() + `<input type="hidden" name="hc_action" value="grant_preview"><input type="hidden" name="grant_ref" value="${randomHex(8)}">\n`
    + `                        <div><label class="${LBL}" for="hcBulkList">Users</label><textarea id="hcBulkList" name="user_list" rows="5" required maxlength="20000" class="${IN} font-mono" placeholder="mia@example.com&#10;#42&#10;@tom">${preview ? e([...preview.found.map((f) => f.email), ...preview.unclear, ...preview.missing].join('\n')) : ''}</textarea>`
    + `<p class="text-xs text-gray-500 mt-1">One per line: an email, #id or @name. Up to 200.</p></div>\n`
    + `                        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4"><div><label class="${LBL}" for="hcBulkAmount">Amount</label><input id="hcBulkAmount" type="number" name="amount" required min="-100000" max="100000" step="1" placeholder="50" value="${preview ? preview.amount : ''}" class="${IN}"></div>`
    + `<div class="sm:col-span-2"><label class="${LBL}" for="hcBulkNote">Note <span class="text-gray-500 font-normal">(the users see it)</span></label><input id="hcBulkNote" type="text" name="note" maxlength="150" value="${preview ? e(preview.note) : ''}" class="${IN}"></div></div>\n`
    + `                        <button type="submit" class="${BTN}"><i class='bx bx-list-check'></i> Check list</button>\n                    </form>\n`;
  if (preview) {
    const ok = preview.found.filter((f) => !f.belowZero);
    const sign = preview.amount > 0 ? '+' : '−';
    o += `                    <div class="mt-5 border-t border-bordercolor pt-5 space-y-3" id="hcBulkPreview"><h3 class="text-sm font-semibold text-white">${sign}${numberFormat(Math.abs(preview.amount))} honeycombs for ${ok.length} user${ok.length === 1 ? '' : 's'}</h3>\n`;
    if (preview.found.length) {
      o += '                        <ul class="divide-y divide-bordercolor text-sm">\n';
      for (const f of preview.found) {
        o += `                            <li class="py-2 flex flex-wrap items-center justify-between gap-2"><span class="min-w-0"><span class="text-white">${e(f.name)}</span> <span class="text-gray-500 break-all">${e(f.email)}</span></span>`
          + `<span class="text-xs ${f.belowZero ? 'text-red-400' : 'text-gray-400'}">Balance ${numberFormat(f.balance)}${f.belowZero ? ' – would go below 0, skipped' : ''}</span></li>\n`;
      }
      o += '                        </ul>\n';
    }
    if (preview.unclear.length) o += `                        <p class="text-xs text-amber-400">Not clear – use #id, @name or an email: ${e(preview.unclear.join(', '))}</p>\n`;
    if (preview.missing.length) o += `                        <p class="text-xs text-amber-400">Not found: ${e(preview.missing.join(', '))}</p>\n`;
    o += '                        <div class="flex flex-wrap gap-2">';
    if (ok.length) {
      o += `<form action="/admin" method="POST" class="m-0"${confirmAttrs({ title: 'Send ' + sign + numberFormat(Math.abs(preview.amount)) + ' honeycombs to ' + ok.length + ' user' + (ok.length === 1 ? '' : 's') + '?', text: 'Each of them gets a notification' + (preview.note ? ' with your note' : '') + '.', ok: 'Send', tone: preview.amount < 0 ? 'danger' : 'warn' })}>`
        + csrf.trim() + confirmField() + `<input type="hidden" name="hc_action" value="grant_bulk"><input type="hidden" name="grant_ref" value="${e(preview.ref)}"><button type="submit" class="${SUBMIT}"><i class='bx bx-check'></i> Confirm</button></form>`;
    }
    o += `<form action="/admin" method="POST" class="m-0">` + csrf.trim() + `<input type="hidden" name="hc_action" value="grant_bulk_cancel"><button type="submit" class="${BTN}"><i class='bx bx-x'></i> Cancel</button></form></div>\n                    </div>\n`;
  }
  return o + '                </details>\n';
}

// ---------------------------------------------------------------- Details eines Nutzers (HC-6a)

// Kontostand, Freischaltungen (mit „Give unlock“ und „Remove“), Käufe (mit „Refund“), Buchungen und Protokoll
async function userDetails(csrf: string, uid: number, now: string): Promise<string> {
  const user = await one('SELECT id, full_name, email, username FROM users WHERE id = ?', [uid]);
  if (!user) return `                <div class="${CARD} p-5 sm:p-6 text-sm text-gray-400" id="hcUserDetails">This user no longer exists.</div>\n`;
  const name = phpStr(userName(user));
  const balance = intval(await value('SELECT COALESCE(SUM(amount), 0) FROM honeycomb_ledger WHERE user_id = ?', [uid]));
  const acc = await one('SELECT frozen_at, frozen_reason FROM hc_accounts WHERE user_id = ?', [uid]);
  const hidden = (n: string, v: string | number): string => `<input type="hidden" name="${n}" value="${e(String(v))}">`;
  const base = csrf.trim() + hidden('user_id', uid);
  let o = `                <div class="${CARD} overflow-hidden" id="hcUserDetails">\n`
    + cardHead('bx-user', name, `<a href="/admin?hc_tab=users#honeycombs" class="${BTN}"><i class='bx bx-x'></i> Close</a>`)
    + `                    <div class="p-5 sm:p-6 space-y-6">\n`
    + `                        <p class="text-sm text-gray-400"><span class="break-all">${e(user.email)}</span> · #${uid} · Balance <span class="font-bold text-white">${numberFormat(balance)}</span> <i class='bx bx-hive text-yellow-400'></i>`
    + (acc && acc.frozen_at !== null ? ` <span class="${BADGE} bg-sky-500/15 text-sky-400">Frozen</span>` : '') + '</p>\n';
  // Anhalten (mit Grund, den der Nutzer sieht) oder wieder freigeben
  if (acc && acc.frozen_at !== null) {
    o += `                        <form action="/admin" method="POST" class="flex flex-wrap items-center gap-3 text-sm" id="hcFreeze"${confirmAttrs({ title: 'Let ' + name + ' use honeycombs again?', ok: 'Unfreeze' })}>` + base + confirmField() + hidden('hc_action', 'unfreeze')
      + `<span class="text-gray-400">On hold since ${e(when(acc.frozen_at))}: ${e(acc.frozen_reason ?? '')}</span><button type="submit" class="${BTN}"><i class='bx bx-play-circle'></i> Unfreeze</button></form>\n`;
  } else {
    o += `                        <form action="/admin" method="POST" class="flex flex-wrap items-end gap-3" id="hcFreeze"${confirmAttrs({ title: 'Put ' + name + '’s honeycombs on hold?', text: 'Earning and buying stop until you unfreeze them. Their unlocks keep working.', ok: 'Put on hold', tone: 'danger' })}>` + base + confirmField() + hidden('hc_action', 'freeze')
      + `<div class="flex-1 min-w-[12rem]"><label class="${SMALL}" for="hcFreezeReason">Put on hold <span class="text-gray-500 font-normal">(the user sees the reason)</span></label><input id="hcFreezeReason" type="text" name="reason" required maxlength="200" placeholder="e.g. We’re checking unusual activity." class="${IN}"></div>`
      + `<button type="submit" class="${BTN} hover:text-red-400"><i class='bx bx-pause-circle'></i> Put on hold</button></form>\n`;
  }

  // Freischaltungen
  const ents = await q<EntRow>('SELECT * FROM hc_entitlements WHERE user_id = ? ORDER BY feature, lot', [uid]);
  o += `                        <div><h3 class="text-sm font-semibold text-white mb-2">Unlocks</h3>\n`;
  if (!ents.length) {
    o += '                            <p class="text-sm text-gray-500" id="hcUserUnlocks">No unlocks yet.</p>\n';
  } else {
    o += '                            <div class="overflow-x-auto"><table class="w-full text-sm text-left" id="hcUserUnlocks"><thead class="text-xs text-gray-500 uppercase bg-inputbg"><tr><th class="px-4 py-2 font-medium">Feature</th><th class="px-4 py-2 font-medium">State</th><th class="px-4 py-2 font-medium hidden sm:table-cell">From</th><th class="px-4 py-2"></th></tr></thead><tbody class="divide-y divide-bordercolor">\n';
    for (const r of ents) {
      const f = feature(r.feature);
      const title = (f ? f.title : r.feature) + (intval(r.lot) > 0 ? ' · pack ' + (intval(r.lot) + 1) : '');
      const active = isActive(r, now);
      o += `                                <tr data-ent="${e(r.feature)}:${intval(r.lot)}"><td class="px-4 py-2 text-white">${e(title)}</td><td class="px-4 py-2 text-gray-300 whitespace-nowrap">${e(entState(r, now))}</td>`
        + `<td class="px-4 py-2 text-xs text-gray-500 hidden sm:table-cell">${e(ucfirst(phpStr(r.source)))}</td><td class="px-4 py-2 text-right">`;
      if (active && (r.feature !== 'premium' || premiumReady())) {
        o += `<form action="/admin" method="POST" class="m-0"${confirmAttrs({ title: 'Remove ' + title + ' from ' + name + '?', text: 'It ends right away. No honeycombs go back – use “Refund” on a purchase for that.', ok: 'Remove', tone: 'danger' })}>`
          + base + confirmField() + hidden('hc_action', 'feature_revoke') + hidden('feature', r.feature) + hidden('lot', intval(r.lot)) + hidden('form_ref', randomHex(8))
          + `<button type="submit" class="${BTN} hover:text-red-400"><i class='bx bx-minus-circle'></i> Remove</button></form>`;
      }
      o += '</td></tr>\n';
    }
    o += '                            </tbody></table></div>\n';
  }
  // Freischaltung schenken
  const givable = features().filter((f) => featureReady(f) && (f.key !== 'premium' || premiumReady()));
  if (givable.length) {
    o += `                            <form action="/admin" method="POST" class="mt-3 grid grid-cols-1 sm:grid-cols-6 gap-3 items-end" id="hcGiveUnlock">` + base + hidden('hc_action', 'feature_grant') + hidden('form_ref', randomHex(8)) + '\n'
      + `                                <div class="sm:col-span-2"><label class="${SMALL}" for="hcGiveFeature">Give unlock</label><select id="hcGiveFeature" name="feature" class="${IN}">`
      + givable.map((f) => `<option value="${e(f.key)}" data-kind="${e(f.kind)}">${e(f.title)}</option>`).join('') + '</select></div>\n'
      + `                                <div><label class="${SMALL}" for="hcGiveMode">How</label><select id="hcGiveMode" name="mode" class="${IN}"><option value="permanent">For good</option>`
      + `<option value="days"${LIFECYCLE_READY ? '' : ' disabled title="Time-limited grants come with the end-of-period handling."'}>Days</option><option value="units">Number</option></select></div>\n`
      + `                                <div><label class="${SMALL}" for="hcGiveDays">Days / number</label><input id="hcGiveDays" type="number" name="days" min="1" max="3650" step="1" placeholder="30" class="${IN}">`
      + `<input type="hidden" name="units" value=""></div>\n`
      + `                                <div><label class="${SMALL}" for="hcGiveNote">Note <span class="text-gray-500 font-normal">(the user sees it)</span></label><input id="hcGiveNote" type="text" name="note" maxlength="150" class="${IN}"></div>\n`
      + `                                <div><button type="submit" class="${BTN}"><i class='bx bx-gift'></i> Give</button></div>\n`
      + '                            </form>\n'
      + "                            <script>\n                                // Anzahl statt Tagen: dasselbe Feld, beim Absenden als units\n                                (function () {\n"
      + "                                    const form = document.getElementById('hcGiveUnlock');\n"
      + "                                    form.addEventListener('submit', () => { if (form.mode.value === 'units') { form.units.value = form.days.value; } });\n"
      + '                                })();\n                            </script>\n';
  }
  o += '                        </div>\n';

  // Käufe mit Erstattung
  const purchases = await q<PurchaseRow>('SELECT * FROM hc_purchases WHERE user_id = ? ORDER BY id DESC LIMIT 50', [uid]);
  o += `                        <div><h3 class="text-sm font-semibold text-white mb-2">Purchases</h3>\n`;
  if (!purchases.length) {
    o += '                            <p class="text-sm text-gray-500" id="hcUserPurchases">No purchases yet.</p>\n';
  } else {
    o += '                            <ul class="divide-y divide-bordercolor text-sm" id="hcUserPurchases">\n';
    for (const p of purchases) {
      const title = itemTitle(p);
      const price = intval(p.price);
      const period = p.period_start !== null && p.period_end !== null ? ' · ' + date('M j', stamp(p.period_start)) + ' – ' + date('M j, Y', stamp(p.period_end)) : '';
      o += `                                <li class="py-3" data-purchase="${intval(p.id)}"><div class="flex flex-wrap items-center justify-between gap-2"><span><span class="text-white">${e(title)}</span>`
        + `<span class="block text-xs text-gray-500">${e(when(p.created_at))} · ${numberFormat(price)}${intval(p.list_price) !== price ? ' (list ' + numberFormat(intval(p.list_price)) + ')' : ''} honeycombs${e(period)}</span></span>`;
      if (p.refunded_at !== null) {
        o += `<span class="${BADGE} bg-white/5 text-gray-400">Refunded +${numberFormat(intval(p.refund_amount))}</span></div></li>\n`;
        continue;
      }
      o += '</div>\n' + (await refundForm(csrf, p, name, now)) + '</li>\n';
    }
    o += '                            </ul>\n';
  }
  o += '                        </div>\n';

  // Buchungen und Protokoll
  const ledger = await q('SELECT * FROM honeycomb_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 50', [uid]);
  o += `                        <div><h3 class="text-sm font-semibold text-white mb-2">History</h3>\n`;
  if (!ledger.length) {
    o += '                            <p class="text-sm text-gray-500">No entries yet.</p>\n';
  } else {
    o += '                            <ul class="divide-y divide-bordercolor text-sm" id="hcUserLedger">\n';
    const reversed = await reversedIds(ledger.map((l) => intval(l.id)));
    for (const l of ledger) {
      o += `                                <li class="py-2 flex items-center justify-between gap-3" data-ledger="${intval(l.id)}"><span class="min-w-0"><span class="text-gray-300">${e(hcDescribe(l))}</span><span class="block text-xs text-gray-500">${e(when(l.created_at))}</span></span><span class="flex items-center gap-3">${amountHtml(intval(l.amount))}${reverseForm(csrf, l, name, reversed, '')}</span></li>\n`;
    }
    o += '                            </ul>\n';
  }
  o += '                        </div>\n';
  const audits = await q('SELECT a.*, u.full_name, u.email FROM hc_audit a LEFT JOIN users u ON u.id = a.admin_id WHERE a.user_id = ? ORDER BY a.id DESC LIMIT 20', [uid]);
  if (audits.length) {
    o += `                        <div><h3 class="text-sm font-semibold text-white mb-2">Team actions</h3><ul class="text-xs text-gray-400 space-y-1" id="hcUserAudit">\n`;
    for (const a of audits) o += `                            <li>${e(when(a.created_at))} · ${e(a.full_name || a.email ? userName(a) : '#' + intval(a.admin_id))} · ${e(a.action)} · ${e(a.target)}</li>\n`;
    o += '                        </ul></div>\n';
  }
  o += '                    </div>\n                </div>\n' + REFUND_SCRIPT;
  return o;
}
