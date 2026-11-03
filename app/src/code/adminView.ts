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
import { codeUrl, codeFiles, codeValidPath } from './sites.js';
import { codeSettings } from './settings.js';
import { cleanText } from '../helpers.js';
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
  // Liste mit Filter und Suche (?cs=…&csq=…), aus den gespeicherten Zählern (file_count, bytes) – keine Abfrage je Zeile;
  // höchstens LIST_MAX Zeilen. Der Zugang unten braucht alle Code-Seiten (nur Adressen).
  const get = (k: string): string => (typeof ctx.get[k] === 'string' ? String(ctx.get[k]) : '');
  const filter = FILTERS.includes(get('cs')) ? get('cs') : 'all';
  const search = cleanText(get('csq'), 60);
  const conds: string[] = [];
  const params: string[] = [];
  if (filter === 'online') conds.push('s.is_blocked = 0 AND s.is_published = 1');
  if (filter === 'offline') conds.push('s.is_blocked = 0 AND s.is_published = 0');
  if (filter === 'blocked') conds.push('s.is_blocked = 1');
  if (filter === 'own') conds.push('s.slug IS NOT NULL');
  if (filter === 'page') conds.push('s.slug IS NULL');
  if (search !== '') {
    const like = '%' + search.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    conds.push('(LOWER(s.slug) LIKE ? OR LOWER(p.slug) LIKE ? OR LOWER(s.title) LIKE ? OR LOWER(u.email) LIKE ? OR LOWER(u.full_name) LIKE ?)');
    params.push(like, like, like, like, like);
  }
  const from = `FROM code_sites s JOIN users u ON u.id = s.user_id LEFT JOIN pages p ON p.code_site_id = s.id AND p.user_id = s.user_id
    ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}`;
  const listed = await q(`SELECT s.*, u.full_name, u.email, p.id AS slot_id, p.slug AS slot_slug ${from} ORDER BY s.updated_at DESC, s.id DESC LIMIT ${LIST_MAX}`, params);
  const matching = Number((await q(`SELECT COUNT(*) AS n ${from}`, params))[0]?.n ?? 0);
  const counts = (await q(`SELECT COUNT(*) AS total, COALESCE(SUM(slug IS NULL), 0) AS on_pages, COALESCE(SUM(is_blocked = 1), 0) AS blocked,
      COALESCE(SUM(is_blocked = 0 AND is_published = 1), 0) AS online, COALESCE(SUM(bytes), 0) AS bytes FROM code_sites`))[0] ?? {};
  const codeSites = await q(`SELECT s.id, s.user_id, s.slug, s.title, p.slug AS slot_slug
    FROM code_sites s LEFT JOIN pages p ON p.code_site_id = s.id AND p.user_id = s.user_id ORDER BY s.updated_at DESC`);
  const banned = new Map((await q('SELECT id, code_ban_reason FROM users WHERE code_banned_at IS NOT NULL')).map((r) => [intval(r.id), phpStr(r.code_ban_reason ?? '')]));
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
  const access = allUsers.filter((u) => unlocks.has(intval(u.id)) || sitesOf.has(intval(u.id)) || banned.has(intval(u.id)));
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
                        <form action="/admin" method="POST" class="space-y-4" id="codeAccessForm"${raw(confirmAttrs({ title: 'Unlock for free?', text: 'This user gets it without paying honeycombs.', ok: 'Unlock' }))}>
                            ${csrf}${raw(confirmField())}
                            <input type="hidden" name="code_action" value="unlock">
                            <div>
                                <label class="${LBL}" for="codeItem">What</label>
                                <select id="codeItem" name="item" class="${IN}">
                                    <option value="code_page">Code page</option>
                                    <option value="code_more">More code pages (needs the code page)</option>
                                </select>
                            </div>
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
  o += await settingsCard(csrf);
  const viewerId = intval(get('code_site'));
  if (viewerId > 0) o += await viewerCard(viewerId, get('file'), csrf);

  // Liste der Code-Seiten (wie bisher im Bereich „Honeycombs & code pages“)
  o += "                <div class=\"bg-card border border-bordercolor rounded-xl shadow-xl overflow-hidden\">\n                    <div class=\"flex flex-wrap items-center justify-between gap-3 p-5 sm:p-6 border-b border-bordercolor\">\n                        <h2 class=\"text-base font-semibold text-white flex items-center gap-2\"><i class='bx bx-code-alt text-xl text-brand-400'></i> Code pages <span class=\"text-gray-500 text-sm font-normal\">";
  o += intval(counts.total);
  o += "</span></h2>\n                        <a href=\"/terms/code-pages\" target=\"_blank\" rel=\"noopener\" class=\"text-sm text-gray-400 hover:text-white flex items-center gap-1 py-2\">Rules for code pages <i class='bx bx-link-external'></i></a>\n                    </div>\n                    ";
  o += filterBar(filter, search, counts);
  if (matching > listed.length) o += `<p class="px-5 sm:px-6 pt-3 text-xs text-amber-300">Showing ${listed.length} of ${matching} – narrow it down with the filter or search.</p>\n`;
  if (!listed.length) {
    o += "                    <p class=\"p-6 text-sm text-gray-500\">" + (intval(counts.total) === 0 ? 'No code pages yet.' : 'No code page matches.') + "</p>\n                    ";
  } else {
    o += "                    <div class=\"divide-y divide-bordercolor\">\n                        ";
    for (const cs of listed) {
      o += "                        <div class=\"p-4 sm:px-6 flex flex-col lg:flex-row lg:items-center gap-3\">\n                            <div class=\"min-w-0 flex-1\">\n                                <div class=\"flex items-center gap-2 flex-wrap\">\n                                    ";
      if (slugOf(cs) === '') {
        // Weder eigene Adresse noch Seitenplatz: nirgends zu sehen
        o += "<span class=\"text-white font-medium\">";
        o += e(phpTruthy(cs.title) ? cs.title : '#' + intval(cs.id));
        o += "</span> <span class=\"text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-red-500/15 text-red-400\">No address</span>\n                                    ";
      } else {
        o += "<a href=\"";
        o += e(codeUrl(slugOf(cs)));
        o += "/\" target=\"_blank\" rel=\"noopener noreferrer\" class=\"text-white font-medium hover:text-brand-400 break-all\">";
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
      o += `<a href="/admin?code_site=${intval(cs.id)}#code-pages" class="${BTN} shrink-0"><i class='bx bx-code-block'></i> Source</a>\n`;
      if (phpTruthy(cs.is_blocked)) {
        o += "                            <form action=\"/admin\" method=\"POST\" class=\"m-0 shrink-0\"" + confirmAttrs({ title: 'Unblock this code page?', text: 'Visitors see it again (if it is online).', ok: 'Unblock' }) + ">\n                                ";
        o += csrf + confirmField();
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
      if (slugOf(cs) !== '') o += deleteForm(cs, csrf);
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
${join(access.map((u) => accessRow(u, unlocks, sitesOf.get(intval(u.id)) ?? [], csrf, banned.get(intval(u.id)))))}                            </tbody>
                        </table>
                    </div>
`);
  }
  o += '                </div>\n';
  o += await logCard();
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
function accessRow(u: Row, unlocks: Map<number, number>, sites: Row[], csrf: SafeHtml, bannedReason?: string): SafeHtml {
  const uid = intval(u.id);
  const paid = unlocks.get(uid);
  const search = strtolower(phpStr(userName(u)) + ' ' + phpStr(u.email) + ' ' + phpStr(u.username) + sites.map((cs) => ' ' + address(cs)).join(''));
  const pages = sites.length
    ? join(sites.map((cs) => (slugOf(cs) === '' ? html`<span class="block text-red-400">No address</span>`
      : html`<a href="${codeUrl(slugOf(cs))}/" target="_blank" rel="noopener noreferrer" class="block text-gray-300 hover:text-brand-400 break-all">${address(cs)}</a>`)))
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
  // Konto für Code-Seiten sperren (mit Grund, auf Wunsch alle Code-Seiten blocken) oder wieder zulassen
  const ban = bannedReason !== undefined
    ? html`<form action="/admin" method="POST" class="m-0 mt-2"${raw(confirmAttrs({ title: 'Allow code pages again?', text: phpStr(userName(u)) + ' can create and change code pages again.', ok: 'Allow' }))}>${csrf}${raw(confirmField())}<input type="hidden" name="code_action" value="unban"><input type="hidden" name="user_id" value="${uid}"><button type="submit" class="text-xs text-gray-400 hover:text-white underline underline-offset-2 py-1">Allow code pages again</button></form>`
    : html`<form action="/admin" method="POST" class="m-0 mt-2 flex flex-wrap justify-end gap-2"${raw(confirmAttrs({ title: 'Turn code pages off for ' + phpStr(userName(u)) + '?', text: 'They can no longer create or change code pages.', ok: 'Turn off', tone: 'danger' }))}>${csrf}${raw(confirmField())}<input type="hidden" name="code_action" value="ban"><input type="hidden" name="user_id" value="${uid}"><input type="text" name="reason" maxlength="200" placeholder="Reason (the user sees it)" class="${IN} !py-1.5 !w-48"><label class="text-xs text-gray-400 flex items-center gap-1"><input type="checkbox" name="block_all" value="1" checked> Block their code pages</label><button type="submit" class="text-xs text-red-400 hover:text-red-300 underline underline-offset-2 py-1">Turn code pages off</button></form>`;
  return html`                                <tr data-search="${search}">
                                    <td class="px-5 py-3"><span class="text-white">${phpStr(userName(u))}</span>${bannedReason !== undefined ? html` <span class="${BADGE} bg-red-500/15 text-red-400">Code pages off</span>` : raw('')}<span class="block text-xs text-gray-500 break-all">${phpStr(u.email)}</span>${bannedReason ? html`<span class="block text-xs text-red-300">Reason: ${bannedReason}</span>` : raw('')}</td>
                                    <td class="px-4 py-3">${pages}</td>
                                    <td class="px-4 py-3">${unlocked}</td>
                                    <td class="px-5 py-3 text-right">${action}${ban}</td>
                                </tr>
`;
}

const FILTERS = ['all', 'online', 'offline', 'blocked', 'own', 'page'];
const FILTER_LABELS: Record<string, string> = { all: 'All', online: 'Online', offline: 'Offline', blocked: 'Blocked', own: 'Own address', page: 'On a page address' };
const LIST_MAX = 200;

// Filter und Suche der Liste (GET, bleibt im Bereich)
function filterBar(filter: string, search: string, counts: Row): string {
  const n: Record<string, number> = { all: intval(counts.total), online: intval(counts.online), blocked: intval(counts.blocked), page: intval(counts.on_pages) };
  let o = '<div class="px-5 sm:px-6 pt-4 flex flex-wrap items-center gap-2" id="codeFilters">';
  for (const f of FILTERS) {
    const on = f === filter;
    o += `<a href="/admin?cs=${f}${search !== '' ? '&amp;csq=' + encodeURIComponent(search) : ''}#code-pages" class="${BTN}${on ? ' !text-white !bg-white/10' : ''}"${on ? ' aria-current="true"' : ''}>${e(FILTER_LABELS[f])}${n[f] !== undefined ? ' <span class="text-gray-500">' + n[f] + '</span>' : ''}</a>`;
  }
  o += `<form action="/admin#code-pages" method="GET" class="m-0 flex gap-2 ml-auto"><input type="hidden" name="cs" value="${e(filter)}"><input type="search" name="csq" value="${e(search)}" placeholder="Address, name or email" class="${IN} !py-2 sm:!w-56" aria-label="Search code pages"><button type="submit" class="${BTN}"><i class='bx bx-search'></i> Search</button></form>`;
  return o + '</div>\n';
}

// Löschen: die Adresse muss getippt werden (der Server prüft sie noch einmal)
function deleteForm(cs: Row, csrf: SafeHtml | string): string {
  const slug = slugOf(cs);
  return `<form action="/admin" method="POST" class="m-0 shrink-0 flex flex-wrap gap-2"${confirmAttrs({ title: 'Delete “' + slug + '”?', text: 'Its files are deleted; ' + (phpTruthy(cs.slug) ? 'the address stays reserved for nobody.' : 'the address shows the link page again.') + ' This can’t be undone.', ok: 'Delete', tone: 'danger', match: slug, label: 'Type ' + slug + ' to confirm', normalize: 'slug', into: 'confirm' })}>${csrf}${confirmField()}<input type="hidden" name="code_action" value="delete"><input type="hidden" name="site_id" value="${intval(cs.id)}"><input type="hidden" name="confirm" value=""><input type="text" name="reason" maxlength="200" placeholder="Reason (the user sees it)" aria-label="Reason for deleting" class="${IN} !py-2 !w-48"><button type="submit" class="${BTN} !text-red-400 hover:!bg-red-500/10"><i class='bx bx-trash'></i> Delete</button></form>\n`;
}

// Grenzen für Code-Seiten (gelten sofort; eine Seite über einer gesenkten Grenze darf nur nicht größer werden)
async function settingsCard(csrf: SafeHtml | string): Promise<string> {
  const s = await codeSettings();
  const num = (name: string, label: string, v: number, min: number, max: number): string =>
    `<div><label class="${LBL}" for="cs_${name}">${e(label)}</label><input class="${IN}" type="number" id="cs_${name}" name="${name}" min="${min}" max="${max}" value="${v}"></div>`;
  return `                <div class="bg-card border border-bordercolor rounded-xl shadow-xl p-5 sm:p-6" id="codeSettings">
                    <div class="flex items-center gap-3 mb-5 border-b border-bordercolor pb-4"><i class='bx bx-slider-alt text-2xl text-brand-400'></i><h2 class="text-base font-semibold text-white">Limits</h2></div>
                    <form action="/admin" method="POST" class="space-y-4"${confirmAttrs({ title: 'Save the code page limits?', text: 'They apply to every save right away. Pages already above a lowered limit can only get smaller.', ok: 'Save' })}>
                        ${csrf}${confirmField()}<input type="hidden" name="code_action" value="settings">
                        <div class="grid grid-cols-1 sm:grid-cols-4 gap-4">
                            ${num('max_on_pages', 'Pages that may show code', s.max_on_pages, 0, 3)}
                            ${num('max_files', 'Files per page', s.max_files, 1, 100)}
                            ${num('max_file_kb', 'KB per file', s.max_file_kb, 16, 1024)}
                            ${num('max_total_kb', 'KB per page', s.max_total_kb, 256, 5120)}
                        </div>
                        <label class="flex items-start gap-3 text-sm text-gray-300"><input type="checkbox" name="paused" value="1" class="mt-1"${s.paused ? ' checked' : ''}><span>Pause new code pages<small class="block text-xs text-gray-500">Existing ones keep running; nobody can create or move one.</small></span></label>
                        <button type="submit" class="bg-white text-black hover:bg-gray-200 font-bold py-2.5 px-6 rounded-lg transition-all flex items-center gap-2"><i class='bx bx-save'></i> Save</button>
                    </form>
                </div>\n`;
}

// Quelltext ansehen, ohne die Seite zu öffnen (eine Code-Seite kann ihren Inhalt vor einem Prüfer verstecken)
async function viewerCard(siteId: number, file: string, csrf: SafeHtml | string): Promise<string> {
  const site = (await q(`SELECT s.*, u.email, p.slug AS slot_slug FROM code_sites s JOIN users u ON u.id = s.user_id
      LEFT JOIN pages p ON p.code_site_id = s.id AND p.user_id = s.user_id WHERE s.id = ?`, [siteId]))[0];
  if (!site) return '                <div class="bg-card border border-bordercolor rounded-xl shadow-xl p-5 sm:p-6 text-sm text-gray-400" id="codeViewer">Code page not found.</div>\n';
  const files = await codeFiles(siteId);
  const paths = [...files.keys()].sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a < b ? -1 : 1));
  const want = codeValidPath(file) ?? 'index.html';
  const cur = files.has(want) ? want : paths[0] ?? '';
  const addr = slugOf(site);
  let o = `                <div class="bg-card border border-bordercolor rounded-xl shadow-xl overflow-hidden" id="codeViewer">
                    <div class="flex flex-wrap items-center justify-between gap-3 p-5 sm:p-6 border-b border-bordercolor">
                        <h2 class="text-base font-semibold text-white flex items-center gap-2 min-w-0"><i class='bx bx-code-block text-xl text-brand-400'></i> <span class="break-all">Files of ${e(addr !== '' ? address(site) : '#' + siteId)}</span></h2>
                        <div class="flex gap-2 flex-wrap">`;
  if (phpTruthy(site.is_blocked)) {
    o += `<form action="/admin" method="POST" class="m-0"${confirmAttrs({ title: 'Unblock this code page?', ok: 'Unblock' })}>${csrf}${confirmField()}<input type="hidden" name="code_action" value="unblock"><input type="hidden" name="site_id" value="${siteId}"><input type="hidden" name="from_viewer" value="${siteId}"><button type="submit" class="${BTN}"><i class='bx bx-check-circle'></i> Unblock</button></form>`;
  } else {
    o += `<form action="/admin" method="POST" class="m-0 flex gap-2"${confirmAttrs({ title: 'Block this code page?', text: 'Visitors will only see a notice.', ok: 'Block', tone: 'danger' })}>${csrf}${confirmField()}<input type="hidden" name="code_action" value="block"><input type="hidden" name="site_id" value="${siteId}"><input type="hidden" name="from_viewer" value="${siteId}"><input type="text" name="reason" maxlength="200" placeholder="Reason (the user sees it)" class="${IN} !py-2 !w-48"><button type="submit" class="${BTN} !text-red-400 hover:!bg-red-500/10"><i class='bx bx-block'></i> Block</button></form>`;
  }
  o += `<a href="/admin#code-pages" class="${BTN}"><i class='bx bx-x'></i> Close</a></div>
                    </div>
                    <div class="flex flex-col md:flex-row">
                        <nav class="md:w-56 shrink-0 border-b md:border-b-0 md:border-r border-bordercolor p-3 space-y-1 text-sm" aria-label="Files">\n`;
  for (const pth of paths) {
    o += `<a href="/admin?code_site=${siteId}&amp;file=${encodeURIComponent(pth)}#code-pages" class="block px-2 py-1.5 rounded break-all ${pth === cur ? 'bg-white/10 text-white' : 'text-gray-400 hover:text-white'}">${e(pth)}</a>`;
  }
  o += `</nav>
                        <pre class="flex-1 min-w-0 p-4 text-xs text-gray-200 overflow-auto max-h-[60vh] whitespace-pre-wrap break-words custom-scrollbar">${cur !== '' ? e(files.get(cur) ?? '') : 'No files.'}</pre>
                    </div>
                    <p class="px-5 sm:px-6 py-3 text-xs text-gray-500 border-t border-bordercolor">${e(phpStr(site.email))} · ${paths.length} files · shown as text, nothing runs here.</p>
                </div>\n`;
  return o;
}

// Protokoll der Team-Aktionen (die letzten 30)
async function logCard(): Promise<string> {
  const rows = await q(`SELECT m.*, a.full_name AS admin_name, a.email AS admin_email, u.email AS user_email FROM code_moderation m
      LEFT JOIN users a ON a.id = m.admin_id LEFT JOIN users u ON u.id = m.user_id ORDER BY m.id DESC LIMIT 30`);
  let o = `                <div class="bg-card border border-bordercolor rounded-xl shadow-xl overflow-hidden" id="codeLog">
                    <div class="p-5 sm:p-6 border-b border-bordercolor"><h2 class="text-base font-semibold text-white flex items-center gap-2"><i class='bx bx-history text-xl text-brand-400'></i> Moderation log</h2></div>\n`;
  if (!rows.length) return o + '                    <p class="p-6 text-sm text-gray-500">Nothing yet.</p>\n                </div>\n';
  o += '                    <ul class="divide-y divide-bordercolor text-sm">\n';
  for (const r of rows) {
    const who = phpStr(r.admin_name ?? '') !== '' ? phpStr(r.admin_name) : phpStr(r.admin_email ?? '#' + intval(r.admin_id));
    const parts = [date('M j, Y H:i', stamp(r.created_at)), who, phpStr(r.action), phpStr(r.address ?? ''), phpStr(r.user_email ?? ''), phpStr(r.reason ?? '')].filter((x) => x !== '');
    o += `                        <li class="px-5 sm:px-6 py-2.5 text-gray-300 break-words">${e(parts.join(' · '))}</li>\n`;
  }
  return o + '                    </ul>\n                </div>\n';
}
