// Admin, Bereich „Code pages“ (#code-pages): getrennt vom Bereich Honeycombs. Code-Zugang ohne Honigwaben vergeben,
// Preis (nur lesen – geändert wird er bei den Honigwaben), die Liste der Code-Seiten mit Sperren/Entsperren und wer
// Zugang hat. Die Liste und das Formular „Unlock for free“ sind unverändert aus dem früheren Bereich
// „Honeycombs & code pages“ übernommen; die Formulare senden jetzt code_action (code/admin.ts).
import type { Ctx } from '../web/ctx.js';
import { q, type Row } from '../db.js';
import { date, intval, numberFormat, phpFloatToString, phpStr, phpTruthy, strtolower, strtotime } from '../php.js';
import { e, html, join, raw, type SafeHtml } from '../html.js';
import { baseAuthority } from '../helpers.js';
import { csrfField } from '../web/security.js';
import { unlockHolders } from '../honeycombs/entitlements.js';
import { listPrice } from '../honeycombs/catalogue.js';
import { codeUrl } from './sites.js';
import { confirmAttrs, confirmField } from '../views/partials/ui.js';

const IN = 'w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm';
const LBL = 'block text-sm font-medium text-gray-300 mb-1.5';
const BTN = 'inline-flex items-center gap-1.5 px-3 py-2 min-h-[36px] rounded-lg text-xs font-medium border border-bordercolor text-gray-300 hover:text-white hover:bg-white/5 transition-colors';
const BADGE = 'text-[10px] font-bold uppercase px-1.5 py-0.5 rounded';

// Name, sonst E-Mail (null und '' zählen als leer)
const userName = (u: Row): unknown => (u.full_name !== '' && u.full_name !== null && u.full_name !== undefined ? u.full_name : u.email);

// Größe mit PHP-round() (positive Werte: halb auf) und PHP-Zahlentext
export function kb(b: number): string {
  if (b >= 1048576) return phpFloatToString(Math.round((b / 1048576) * 10) / 10) + ' MB';
  return phpFloatToString(Math.max(1, Math.round(b / 1024))) + ' KB';
}

// strtotime() eines Datums aus der Datenbank; leer/ungültig → 0 wie date(…, false)
function stamp(v: unknown): number {
  const t = strtotime(phpStr(v));
  return t === false ? 0 : t;
}

// Adresse, unter der eine Code-Seite zu sehen ist: ihre eigene oder die des Seitenplatzes, der sie zeigt (slot_slug aus
// der Abfrage). '' = nirgends (nur nach Handarbeit in der Datenbank)
const slugOf = (cs: Row): string => (phpTruthy(cs.slug) ? phpStr(cs.slug) : phpTruthy(cs.slot_slug) ? phpStr(cs.slot_slug) : '');
// … so, wie sie in der Liste steht
const address = (cs: Row): string => slugOf(cs) + '.' + baseAuthority();

// allUsers: alle Konten aus admin/page.ts (id, full_name, email, username, …; neueste zuerst)
export async function adminCodePagesView(ctx: Ctx, allUsers: Row[]): Promise<string> {
  const price = await listPrice('code_page');
  // Dateien und Größe wie bisher aus den Dateien selbst gezählt (gleichnamig nach s.*, also maßgeblich); dazu der
  // Seitenplatz, der eine Code-Seite ohne eigene Adresse zeigt
  const codeSites = await q(`SELECT s.*, u.full_name, u.email,
        (SELECT COUNT(*) FROM code_files f WHERE f.site_id = s.id) AS file_count,
        (SELECT COALESCE(SUM(LENGTH(f.content)), 0) FROM code_files f WHERE f.site_id = s.id) AS bytes,
        p.id AS slot_id, p.slug AS slot_slug
    FROM code_sites s JOIN users u ON u.id = s.user_id LEFT JOIN pages p ON p.code_site_id = s.id AND p.user_id = s.user_id
    ORDER BY s.updated_at DESC`);
  // Freischaltung je Konto (wer die Berechtigung gerade hat): der Betrag der letzten Buchung (0 = vom Team geschenkt,
  // sonst bezahlt). Eine erstattete Freischaltung zählt nicht mehr, auch wenn ihre Buchung bleibt.
  const unlocks = await unlockHolders('code_page');
  const sitesOf = new Map<number, Row[]>();
  for (const cs of codeSites) {
    const list = sitesOf.get(intval(cs.user_id));
    if (list) list.push(cs);
    else sitesOf.set(intval(cs.user_id), [cs]);
  }
  // Zugang: wer freigeschaltet ist oder eine Code-Seite hat (Reihenfolge wie die Nutzerliste)
  const access = allUsers.filter((u) => unlocks.has(intval(u.id)) || sitesOf.has(intval(u.id)));
  const csrf = await csrfField(ctx);

  let o = '';
  o += '            <!-- ===================== Code-Seiten ===================== -->\n';
  o += '            <div id="tab-code-pages" class="admin-tab-content max-w-5xl mx-auto space-y-8 hidden">\n';
  o += String(html`                <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    <div class="bg-card border border-bordercolor rounded-xl shadow-xl p-5 sm:p-6">
                        <div class="flex items-center gap-3 mb-5 border-b border-bordercolor pb-4">
                            <i class='bx bx-key text-2xl text-brand-400'></i>
                            <h2 class="text-base font-semibold text-white">Give code access</h2>
                        </div>
                        <form action="/admin" method="POST" class="space-y-4" id="codeAccessForm"${raw(confirmAttrs({ title: 'Unlock the code page for free?', text: 'This user gets the code page without paying honeycombs.', ok: 'Unlock' }))}>
                            ${csrf}${raw(confirmField())}
                            <input type="hidden" name="code_action" value="unlock">
                            <input type="hidden" name="item" value="code_page">
                            <div>
                                <label class="${LBL}" for="codeUser">User</label>
                                <select id="codeUser" name="user_id" required data-error-required="Please choose a user." class="${IN}">
                                    <option value="">Choose a user …</option>
${join(allUsers.map((u) => html`                                    <option value="${intval(u.id)}">${phpStr(userName(u))} · ${phpStr(u.email)}${unlocks.has(intval(u.id)) ? ' · unlocked' : ''}</option>\n`))}                                </select>
                            </div>
                            <p class="text-xs text-gray-500">Unlocks code pages without honeycombs – for example for testers. Their balance stays as it is.</p>
                            <button type="submit" class="bg-white text-black hover:bg-gray-200 font-bold py-2.5 px-6 rounded-lg transition-all flex items-center gap-2"><i class='bx bx-lock-open-alt'></i> Unlock for free</button>
                        </form>
                    </div>

                    <div class="bg-card border border-bordercolor rounded-xl shadow-xl p-5 sm:p-6">
                        <div class="flex items-center gap-3 mb-5 border-b border-bordercolor pb-4">
                            <i class='bx bx-hive text-2xl text-yellow-400'></i>
                            <h2 class="text-base font-semibold text-white">Prices</h2>
                        </div>
                        <div class="space-y-3">
                            <div class="flex items-center gap-3">
                                <span class="flex-1 min-w-0"><span class="block text-sm text-white">Unlock code pages</span><span class="block text-xs text-gray-500">Paid once – the user keeps it for good</span></span>
                                <span class="text-sm font-bold text-white whitespace-nowrap" id="codePrice">${priceHtml(price)}</span>
                            </div>
                            <p class="text-xs text-gray-500 pt-1">Prices and offers are set in Honeycombs under “Catalogue &amp; prices”.</p>
                            <a href="/admin?hc_tab=catalogue#honeycombs" class="text-sm text-gray-400 hover:text-white inline-flex items-center gap-1 py-2">Change prices in Honeycombs <i class='bx bx-right-arrow-alt'></i></a>
                        </div>
                    </div>
                </div>

`);

  // Liste der Code-Seiten (wie bisher im Bereich „Honeycombs & code pages“)
  o += "                <div class=\"bg-card border border-bordercolor rounded-xl shadow-xl overflow-hidden\">\n                    <div class=\"flex flex-wrap items-center justify-between gap-3 p-5 sm:p-6 border-b border-bordercolor\">\n                        <h2 class=\"text-base font-semibold text-white flex items-center gap-2\"><i class='bx bx-code-alt text-xl text-brand-400'></i> Code pages <span class=\"text-gray-500 text-sm font-normal\">";
  o += codeSites.length;
  o += "</span></h2>\n                        <a href=\"/terms/code-pages\" target=\"_blank\" rel=\"noopener\" class=\"text-sm text-gray-400 hover:text-white flex items-center gap-1 py-2\">Rules for code pages <i class='bx bx-link-external'></i></a>\n                    </div>\n                    ";
  if (!codeSites.length) {
    o += "                    <p class=\"p-6 text-sm text-gray-500\">No code pages yet.</p>\n                    ";
  } else {
    o += "                    <div class=\"divide-y divide-bordercolor\">\n                        ";
    for (const cs of codeSites) {
      o += "                        <div class=\"p-4 sm:px-6 flex flex-col lg:flex-row lg:items-center gap-3\">\n                            <div class=\"min-w-0 flex-1\">\n                                <div class=\"flex items-center gap-2 flex-wrap\">\n                                    ";
      if (slugOf(cs) === '') {
        // Weder eigene Adresse noch Seitenplatz: nirgends zu sehen
        o += "<span class=\"text-white font-medium\">";
        o += e(phpTruthy(cs.title) ? cs.title : '#' + intval(cs.id));
        o += "</span> <span class=\"text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-red-500/15 text-red-400\">No address</span>\n                                    ";
      } else {
        o += "<a href=\"";
        o += e(codeUrl(slugOf(cs)));
        o += "/\" target=\"_blank\" rel=\"noopener\" class=\"text-white font-medium hover:text-brand-400 break-all\">";
        o += e(address(cs));
        o += "</a>\n                                    ";
      }
      if (phpTruthy(cs.is_blocked)) {
        o += "                                    <span class=\"text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-red-500/15 text-red-400\">Blocked</span>\n                                    ";
      } else if (!phpTruthy(cs.is_published)) {
        o += "                                    <span class=\"text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-white/10 text-gray-400\">Offline</span>\n                                    ";
      } else {
        o += "                                    <span class=\"text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400\">Online</span>\n                                    ";
      }
      o += "                                </div>\n                                <p class=\"text-xs text-gray-500 mt-1\">";
      o += e(cs.title);
      o += " · ";
      o += e(userName(cs));
      o += " (";
      o += e(cs.email);
      o += ") · ";
      o += intval(cs.file_count);
      o += " files · ";
      o += e(kb(intval(cs.bytes)));
      o += " · ";
      o += numberFormat(intval(cs.views));
      o += " views · changed ";
      o += e(date('M j, Y', stamp(cs.updated_at)));
      o += "</p>\n                                ";
      if (phpTruthy(cs.is_blocked) && phpTruthy(cs.blocked_reason)) {
        o += "                                <p class=\"text-xs text-red-300 mt-1\">Reason: ";
        o += e(cs.blocked_reason);
        o += "</p>\n                                ";
      }
      o += "                            </div>\n                            ";
      if (phpTruthy(cs.is_blocked)) {
        o += "                            <form action=\"/admin\" method=\"POST\" class=\"m-0 shrink-0\">\n                                ";
        o += csrf;
        o += "<input type=\"hidden\" name=\"code_action\" value=\"unblock\"><input type=\"hidden\" name=\"site_id\" value=\"";
        o += intval(cs.id);
        o += "\">\n                                <button type=\"submit\" class=\"";
        o += BTN;
        o += "\"><i class='bx bx-check-circle'></i> Unblock</button>\n                            </form>\n                            ";
      } else {
        o += "                            <form action=\"/admin\" method=\"POST\" class=\"m-0 shrink-0 flex gap-2\"";
        o += confirmAttrs({ title: 'Block this code page?', text: 'Visitors will only see a notice.', ok: 'Block', tone: 'danger' });
        o += ">\n                                ";
        o += csrf + confirmField();
        o += "<input type=\"hidden\" name=\"code_action\" value=\"block\"><input type=\"hidden\" name=\"site_id\" value=\"";
        o += intval(cs.id);
        o += "\">\n                                <input type=\"text\" name=\"reason\" maxlength=\"200\" placeholder=\"Reason (the user sees it)\" class=\"";
        o += IN;
        o += " !py-2 lg:!w-56\">\n                                <button type=\"submit\" class=\"";
        o += BTN;
        o += " !text-red-400 hover:!bg-red-500/10\"><i class='bx bx-block'></i> Block</button>\n                            </form>\n                            ";
      }
      o += "                        </div>\n                        ";
    }
    o += "                    </div>\n                    ";
  }
  o += "                </div>\n\n";

  // Zugang: freigeschaltet (bezahlt oder geschenkt) und Code-Seiten je Konto
  o += String(html`                <div class="bg-card border border-bordercolor rounded-xl shadow-xl overflow-hidden">
                    <div class="flex flex-wrap items-center justify-between gap-3 p-5 sm:p-6 border-b border-bordercolor">
                        <h2 class="text-base font-semibold text-white flex items-center gap-2"><i class='bx bx-lock-open-alt text-xl text-brand-400'></i> Access <span class="text-gray-500 text-sm font-normal">${access.length}</span></h2>
                        <input type="search" id="codeAccessFilter" placeholder="Search users …" class="${IN} sm:!w-64">
                    </div>
`);
  if (!access.length) {
    o += '                    <p class="p-6 text-sm text-gray-500">Nobody has unlocked code pages yet.</p>\n';
  } else {
    o += String(html`                    <div class="overflow-x-auto">
                        <table class="w-full text-sm text-left">
                            <thead class="text-xs text-gray-500 uppercase bg-inputbg">
                                <tr><th class="px-5 py-3 font-medium">User</th><th class="px-4 py-3 font-medium">Code pages</th><th class="px-4 py-3 font-medium">Unlocked</th><th class="px-5 py-3"></th></tr>
                            </thead>
                            <tbody class="divide-y divide-bordercolor" id="codeAccessRows">
${join(access.map((u) => accessRow(u, unlocks, sitesOf.get(intval(u.id)) ?? [], csrf)))}                            </tbody>
                        </table>
                    </div>
`);
  }
  o += '                </div>\n';
  o += '            </div>\n';
  o += String(html`            <script>
                // Suche in der Zugangsliste (wie bei den Honigwaben)
                document.getElementById('codeAccessFilter').addEventListener('input', e => {
                    const q = e.target.value.trim().toLowerCase();
                    document.querySelectorAll('#codeAccessRows tr').forEach(tr => { tr.hidden = q !== '' && !tr.dataset.search.includes(q); });
                });
            </script>
`);
  return o;
}

// Preis zum Freischalten: 0 = kostenlos
function priceHtml(price: number): SafeHtml {
  return price > 0 ? html`${numberFormat(price)} <i class='bx bx-hive text-yellow-400'></i>` : html`Free`;
}

// Eine Zeile der Zugangsliste
function accessRow(u: Row, unlocks: Map<number, number>, sites: Row[], csrf: SafeHtml): SafeHtml {
  const uid = intval(u.id);
  const paid = unlocks.get(uid);
  const search = strtolower(phpStr(userName(u)) + ' ' + phpStr(u.email) + ' ' + phpStr(u.username) + sites.map((cs) => ' ' + address(cs)).join(''));
  const pages = sites.length
    ? join(sites.map((cs) => (slugOf(cs) === '' ? html`<span class="block text-red-400">No address</span>`
      : html`<a href="${codeUrl(slugOf(cs))}/" target="_blank" rel="noopener" class="block text-gray-300 hover:text-brand-400 break-all">${address(cs)}</a>`)))
    : html`<span class="text-gray-500">—</span>`;
  const unlocked = paid === undefined
    ? html`<span class="text-gray-500">—</span>`
    : html`<span class="${BADGE} bg-emerald-500/15 text-emerald-400">${paid < 0 ? 'Paid ' + numberFormat(-paid) : 'Free'}</span>`;
  const action = paid === undefined
    ? html`<form action="/admin" method="POST" class="m-0"${raw(confirmAttrs({ title: 'Unlock the code page for free?', text: 'This user gets the code page without paying honeycombs.', ok: 'Unlock' }))}>
                                            ${csrf}${raw(confirmField())}<input type="hidden" name="code_action" value="unlock"><input type="hidden" name="item" value="code_page"><input type="hidden" name="user_id" value="${uid}">
                                            <button type="submit" class="text-xs text-gray-400 hover:text-white underline underline-offset-2 py-1">Unlock for free</button>
                                        </form>`
    : raw('');
  return html`                                <tr data-search="${search}">
                                    <td class="px-5 py-3"><span class="text-white">${phpStr(userName(u))}</span><span class="block text-xs text-gray-500 break-all">${phpStr(u.email)}</span></td>
                                    <td class="px-4 py-3">${pages}</td>
                                    <td class="px-4 py-3">${unlocked}</td>
                                    <td class="px-5 py-3 text-right">${action}</td>
                                </tr>
`;
}
