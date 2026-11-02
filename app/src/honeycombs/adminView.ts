// Admin, Bereich „Honeycombs“: Honigwaben vergeben, Regeln einstellen, Kontostände und letzte Buchungen
// (views/admin_honeycombs.php, eingebunden in views/admin.php). Der Text außerhalb der PHP-Teile ist Byte für Byte
// übernommen (view2ts). Die Liste der Code-Seiten und die Spalte „Code page“ stehen seit der Trennung im eigenen
// Bereich „Code pages“ (code/adminView.ts), und die Honigwaben-Symbole sind gelb; sonst ist die Ausgabe unverändert.
import type { Ctx } from '../web/ctx.js';
import { q, type Row } from '../db.js';
import { date, intval, numberFormat, phpStr, strtolower, strtotime } from '../php.js';
import { e } from '../html.js';
import { randomHex } from '../crypto.js';
import { csrfField } from '../web/security.js';
import { HC_MAX_VIEW_REWARDS, hcDescribe, hcSettings, type HcSettings } from './honeycombs.js';

const IN = 'w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm';
const LBL = 'block text-sm font-medium text-gray-300 mb-1.5';
const BTN = 'inline-flex items-center gap-1.5 px-3 py-2 min-h-[36px] rounded-lg text-xs font-medium border border-bordercolor text-gray-300 hover:text-white hover:bg-white/5 transition-colors';

// $userName: Name, sonst E-Mail (null und '' zählen als leer)
const userName = (u: Row): unknown => (u.full_name !== '' && u.full_name !== null && u.full_name !== undefined ? u.full_name : u.email);

// strtotime() eines Datums aus der Datenbank; leer/ungültig → 0 wie date(…, false)
function stamp(v: unknown): number {
  const t = strtotime(phpStr(v));
  return t === false ? 0 : t;
}

// allUsers: $all_users aus views/admin.php (id, full_name, email, username, discord_id, is_admin, created_at; neueste zuerst)
export async function adminHoneycombsView(ctx: Ctx, allUsers: Row[]): Promise<string> {
  const rules: HcSettings = await hcSettings();
  const balances = new Map<number, Row>();
  for (const row of await q('SELECT user_id, SUM(amount) AS balance, SUM(GREATEST(amount, 0)) AS earned, SUM(GREATEST(-amount, 0)) AS spent FROM honeycomb_ledger GROUP BY user_id')) {
    balances.set(intval(row.user_id), row);
  }
  const balanceOf = (u: Row): number => intval(balances.get(intval(u.id))?.balance ?? 0);
  const hcUsers = [...allUsers].sort((a, b) => Math.sign(balanceOf(b) - balanceOf(a)) || Math.sign(intval(b.id) - intval(a.id)));
  const recent = await q('SELECT l.*, u.full_name, u.email FROM honeycomb_ledger l JOIN users u ON u.id = l.user_id ORDER BY l.id DESC LIMIT 25');
  const ruleFields: Array<[keyof HcSettings, [string, string]]> = [
    ['daily', ['Active day', 'For opening the editor (once a day)']],
    ['profile', ['Complete profile', 'Once: profile picture, bio and at least 3 links']],
    ['views', ['Visitors', 'Per step of page views (one step a day, up to ' + HC_MAX_VIEW_REWARDS + ' times)']],
    ['views_step', ['Views per step', 'How many page views make one step']],
    ['code_page', ['Price: code page', 'What unlocking the code page costs']],
  ];
  const csrf = await csrfField(ctx);

  let o = '';
  o += "            <!-- ===================== Honigwaben ===================== -->\n            <div id=\"tab-honeycombs\" class=\"admin-tab-content max-w-5xl mx-auto space-y-8 hidden\">\n                <div class=\"grid grid-cols-1 lg:grid-cols-2 gap-8\">\n                    <div class=\"bg-card border border-bordercolor rounded-xl shadow-xl p-5 sm:p-6\">\n                        <div class=\"flex items-center gap-3 mb-5 border-b border-bordercolor pb-4\">\n                            <i class='bx bx-hive text-2xl text-yellow-400'></i>\n                            <h2 class=\"text-base font-semibold text-white\">Give honeycombs</h2>\n                        </div>\n                        <form action=\"/admin\" method=\"POST\" class=\"space-y-4\" id=\"hcGrantForm\">\n                            ";
  o += csrf;
  o += "                            <input type=\"hidden\" name=\"hc_action\" value=\"grant\">\n                            <input type=\"hidden\" name=\"grant_ref\" value=\"";
  o += randomHex(8);
  o += "\">\n                            <div>\n                                <label class=\"";
  o += LBL;
  o += "\" for=\"hcUser\">User</label>\n                                <select id=\"hcUser\" name=\"user_id\" required data-error-required=\"Please choose a user.\" class=\"";
  o += IN;
  o += "\">\n                                    <option value=\"\">Choose a user …</option>\n                                    ";
  for (const u of allUsers) {
    o += "                                    <option value=\"";
    o += intval(u.id);
    o += "\">";
    o += e(userName(u));
    o += " · ";
    o += e(u.email);
    o += " (";
    o += intval(balances.get(intval(u.id))?.balance ?? 0);
    o += ")</option>\n                                    ";
  }
  o += "                                </select>\n                            </div>\n                            <div class=\"grid grid-cols-1 sm:grid-cols-3 gap-4\">\n                                <div>\n                                    <label class=\"";
  o += LBL;
  o += "\" for=\"hcAmount\">Amount</label>\n                                    <input id=\"hcAmount\" type=\"number\" name=\"amount\" required min=\"-100000\" max=\"100000\" step=\"1\" placeholder=\"50\" class=\"";
  o += IN;
  o += "\">\n                                </div>\n                                <div class=\"sm:col-span-2\">\n                                    <label class=\"";
  o += LBL;
  o += "\" for=\"hcNote\">Note <span class=\"text-gray-500 font-normal\">(the user sees it)</span></label>\n                                    <input id=\"hcNote\" type=\"text\" name=\"note\" maxlength=\"150\" placeholder=\"e.g. Thanks for your feedback!\" class=\"";
  o += IN;
  o += "\">\n                                </div>\n                            </div>\n                            <p class=\"text-xs text-gray-500\">A negative amount takes honeycombs away (e.g. −20). The balance can’t go below 0.</p>\n                            <button type=\"submit\" class=\"bg-white text-black hover:bg-gray-200 font-bold py-2.5 px-6 rounded-lg transition-all flex items-center gap-2\"><i class='bx bx-gift'></i> Send</button>\n                        </form>\n                    </div>\n\n                    <div class=\"bg-card border border-bordercolor rounded-xl shadow-xl p-5 sm:p-6\">\n                        <div class=\"flex items-center gap-3 mb-5 border-b border-bordercolor pb-4\">\n                            <i class='bx bx-slider-alt text-2xl text-brand-400'></i>\n                            <h2 class=\"text-base font-semibold text-white\">How users earn them</h2>\n                        </div>\n                        <form action=\"/admin\" method=\"POST\" class=\"space-y-3\">\n                            ";
  o += csrf;
  o += "                            <input type=\"hidden\" name=\"hc_action\" value=\"settings\">\n                            ";
  for (const [key, [title, hint]] of ruleFields) {
    o += "                            <div class=\"flex items-center gap-3\">\n                                <label class=\"flex-1 min-w-0\" for=\"hcRule-";
    o += key;
    o += "\"><span class=\"block text-sm text-white\">";
    o += e(title);
    o += "</span><span class=\"block text-xs text-gray-500\">";
    o += e(hint);
    o += "</span></label>\n                                <input id=\"hcRule-";
    o += key;
    o += "\" type=\"number\" name=\"";
    o += key;
    o += "\" min=\"";
    o += key === 'views_step' ? 1 : 0;
    o += "\" max=\"100000\" step=\"1\" value=\"";
    o += intval(rules[key]);
    o += "\" class=\"";
    o += IN;
    o += " !w-28 text-right\">\n                            </div>\n                            ";
  }
  o += "                            <p class=\"text-xs text-gray-500 pt-1\">0 switches a reward off. Changes count from now on – nobody loses honeycombs they already have.</p>\n                            <button type=\"submit\" class=\"bg-white text-black hover:bg-gray-200 font-bold py-2.5 px-6 rounded-lg transition-all flex items-center gap-2\"><i class='bx bx-save'></i> Save</button>\n                        </form>\n                    </div>\n                </div>\n\n                <div class=\"bg-card border border-bordercolor rounded-xl shadow-xl overflow-hidden\">\n                    <div class=\"flex flex-wrap items-center justify-between gap-3 p-5 sm:p-6 border-b border-bordercolor\">\n                        <h2 class=\"text-base font-semibold text-white flex items-center gap-2\"><i class='bx bx-wallet text-xl text-brand-400'></i> Balances</h2>\n                        <input type=\"search\" id=\"hcFilter\" placeholder=\"Search users …\" class=\"";
  o += IN;
  o += " sm:!w-64\">\n                    </div>\n                    <div class=\"overflow-x-auto\">\n                        <table class=\"w-full text-sm text-left\">\n                            <thead class=\"text-xs text-gray-500 uppercase bg-inputbg\">\n                                <tr><th class=\"px-5 py-3 font-medium\">User</th><th class=\"px-4 py-3 font-medium text-right\">Balance</th><th class=\"px-4 py-3 font-medium text-right hidden sm:table-cell\">Earned</th><th class=\"px-4 py-3 font-medium text-right hidden sm:table-cell\">Spent</th><th class=\"px-5 py-3\"></th></tr>\n                            </thead>\n                            <tbody class=\"divide-y divide-bordercolor\" id=\"hcRows\">\n                                ";
  for (const u of hcUsers) {
    const uid = intval(u.id);
    const b = balances.get(uid) ?? null;
    o += "                                <tr data-search=\"";
    o += e(strtolower(phpStr(userName(u)) + ' ' + phpStr(u.email) + ' ' + phpStr(u.username)));
    o += "\">\n                                    <td class=\"px-5 py-3\"><span class=\"text-white\">";
    o += e(userName(u));
    o += "</span><span class=\"block text-xs text-gray-500 break-all\">";
    o += e(u.email);
    o += "</span></td>\n                                    <td class=\"px-4 py-3 text-right font-bold text-white whitespace-nowrap\">";
    o += numberFormat(intval(b?.balance ?? 0));
    o += " <i class='bx bx-hive text-yellow-400'></i></td>\n                                    <td class=\"px-4 py-3 text-right text-gray-400 hidden sm:table-cell\">";
    o += numberFormat(intval(b?.earned ?? 0));
    o += "</td>\n                                    <td class=\"px-4 py-3 text-right text-gray-400 hidden sm:table-cell\">";
    o += numberFormat(intval(b?.spent ?? 0));
    o += "</td>\n                                    <td class=\"px-5 py-3 text-right\"><button type=\"button\" class=\"";
    o += BTN;
    o += "\" data-hc-give=\"";
    o += uid;
    o += "\"><i class='bx bx-gift'></i> Give</button></td>\n                                </tr>\n                                ";
  }
  o += "                            </tbody>\n                        </table>\n                    </div>\n                </div>\n\n                <div class=\"bg-card border border-bordercolor rounded-xl shadow-xl p-5 sm:p-6\">\n                    <div class=\"flex items-center gap-3 mb-4 border-b border-bordercolor pb-4\">\n                        <i class='bx bx-history text-2xl text-brand-400'></i>\n                        <h2 class=\"text-base font-semibold text-white\">Latest activity</h2>\n                    </div>\n                    ";
  if (!recent.length) {
    o += "                    <p class=\"text-sm text-gray-500\">Nothing yet.</p>\n                    ";
  } else {
    o += "                    <ul class=\"divide-y divide-bordercolor text-sm\">\n                        ";
    for (const r of recent) {
      const amt = intval(r.amount);
      o += "                        <li class=\"py-2.5 flex items-center justify-between gap-3\">\n                            <span class=\"min-w-0\"><span class=\"text-white\">";
      o += e(userName(r));
      o += "</span> <span class=\"text-gray-400\">– ";
      o += e(hcDescribe(r));
      o += "</span><span class=\"block text-xs text-gray-500\">";
      o += e(date('M j, Y H:i', stamp(r.created_at)));
      o += "</span></span>\n                            <span class=\"shrink-0 font-bold ";
      o += amt > 0 ? 'text-emerald-400' : amt < 0 ? 'text-red-400' : 'text-gray-500';
      o += "\">";
      o += amt > 0 ? '+' + numberFormat(amt) : amt < 0 ? '−' + numberFormat(-amt) : 'free';
      o += "</span>\n                        </li>\n                        ";
    }
    o += "                    </ul>\n                    ";
  }
  o += "                </div>\n            </div>\n            <script>\n                // „Give“ in der Liste wählt den Nutzer oben aus; Suche filtert die Liste\n                document.querySelectorAll('[data-hc-give]').forEach(b => b.addEventListener('click', () => {\n                    document.getElementById('hcUser').value = b.dataset.hcGive;\n                    document.getElementById('hcGrantForm').scrollIntoView({ behavior: 'smooth', block: 'center' });\n                    setTimeout(() => document.getElementById('hcAmount').focus(), 300);\n                }));\n                document.getElementById('hcFilter').addEventListener('input', e => {\n                    const q = e.target.value.trim().toLowerCase();\n                    document.querySelectorAll('#hcRows tr').forEach(tr => { tr.hidden = q !== '' && !tr.dataset.search.includes(q); });\n                });\n            </script>\n";
  return o;
}
