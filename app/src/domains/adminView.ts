// Admin, Bereich „Custom domains“ (PD-5, Entwurf §5.4): Einrichtung (Token, Rückfall-Adresse, Ziel für die Kunden,
// Dienst, Schutzschalter, Kontingent), Einstellungen, alle Domains mit Besitzer, Seite und Verlauf und ihren Aktionen,
// gesperrte Hostnamen (R2, freigeben) und Hostnamen bei Cloudflare, die nicht von hier stammen. Jeder Wert wird mit e()
// ausgegeben; Formulare, die etwas ändern, fragen über den eigenen Dialog (confirmAttrs + confirmField).
import type { Ctx } from '../web/ctx.js';
import { q } from '../db.js';
import { e } from '../html.js';
import { intval, phpStr, strtotime, time } from '../php.js';
import { csrfField } from '../web/security.js';
import { confirmAttrs, confirmField } from '../views/partials/ui.js';
import { cnameTarget, domainsAvailable, fallbackOrigin } from './config.js';
import { displayHostname } from './hostname.js';
import { domainSettings, workerState, type WorkerState } from './settings.js';

const CARD = 'bg-card border border-bordercolor rounded-xl shadow-xl';
const BADGE = 'text-[10px] font-bold uppercase px-1.5 py-0.5 rounded';
const TONE: Record<string, string> = {
  green: `${BADGE} bg-emerald-500/15 text-emerald-400`, amber: `${BADGE} bg-amber-500/15 text-amber-400`,
  red: `${BADGE} bg-red-500/15 text-red-400`, gray: `${BADGE} bg-white/10 text-gray-400`,
};
// Wie im Editor (static/js/editor.js DOMAIN_BADGES)
const STATE: Record<string, [string, string]> = {
  verifying: ['amber', 'Waiting for DNS'], pending: ['amber', 'Setting up HTTPS'], active: ['green', 'Live'], broken: ['red', 'Not reachable'],
  suspended: ['gray', 'Paused'], failed: ['red', 'Couldn’t be verified'], blocked: ['red', 'Disabled by the team'], removing: ['gray', 'Removing…'],
};
const LBL = 'block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5';
const FIELD = 'w-full bg-inputbg border border-bordercolor rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500';
const BTN = 'bg-white/5 hover:bg-white/10 border border-bordercolor text-white text-sm font-medium py-2 px-3 rounded-lg transition-colors flex items-center gap-1.5';
const BTN_RED = 'bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 text-sm font-medium py-2 px-3 rounded-lg transition-colors flex items-center gap-1.5';

// Internationale Namen wie angezeigt und dazu als ASCII – ähnlich aussehende Zeichen (kyrillisches а in „аpple.com“)
// fallen in einem Werkzeug zum Sperren sonst nicht auf
const nameBoth = (ascii: string): string => {
  const shown = displayHostname(ascii);
  return shown === ascii ? shown : `${shown} (${ascii})`;
};

const dot = (tone: 'green' | 'amber' | 'red' | 'gray'): string =>
  `<span class="inline-block w-2 h-2 rounded-full shrink-0 ${tone === 'green' ? 'bg-emerald-400' : tone === 'amber' ? 'bg-amber-400' : tone === 'red' ? 'bg-red-400' : 'bg-gray-500'}"></span>`;
const ago = (at: string | null): string => {
  if (!at) return 'never';
  const s = time() - (strtotime(at) || 0);
  return s < 90 ? Math.max(0, s) + ' seconds ago' : s < 5400 ? Math.round(s / 60) + ' minutes ago' : at;
};

export async function adminDomainsView(ctx: Ctx): Promise<string> {
  let o = '            <!-- ===================== Eigene Domains ===================== -->\n';
  o += '            <div id="tab-domains" class="admin-tab-content max-w-5xl mx-auto space-y-8 hidden">\n';
  if (!domainsAvailable()) {
    o += `                <div class="${CARD} p-5 sm:p-6 text-sm text-gray-400"><h2 class="text-base font-semibold text-white mb-2 flex items-center gap-2"><i class='bx bx-globe text-xl text-cyan-400'></i> Custom domains aren’t set up</h2>
                    <p>Run <code class="text-cyan-300">sudo bash /var/www/onyoursite/server/install.sh --domains</code> on the server. It asks for a Cloudflare token and sets up Cloudflare for SaaS.</p></div>\n`;
    return o + '            </div>\n';
  }
  const csrf = String(await csrfField(ctx));
  const ws = await workerState();
  const s = await domainSettings();
  o += setupCard(ws, csrf);
  o += settingsCard(s, csrf);
  o += await listCard(csrf, typeof ctx.get.domain_q === 'string' ? ctx.get.domain_q.trim().slice(0, 100) : '');
  o += await blocksCard(csrf);
  if (ws.unmanaged.length) {
    o += `                <div class="${CARD} p-5 sm:p-6" id="domainsUnmanaged"><h2 class="text-base font-semibold text-white mb-2 flex items-center gap-2"><i class='bx bx-help-circle text-xl text-cyan-400'></i> Not managed here</h2>
                    <p class="text-xs text-gray-500 mb-3">Created by hand in Cloudflare. Delete them there if they’re not needed.</p><ul class="text-sm text-gray-300 space-y-1">\n`;
    // Nur der Dienst schreibt die Liste – trotzdem nur Einträge mit Text annehmen
    for (const u of ws.unmanaged) {
      if (!u || typeof u !== 'object' || typeof u.hostname !== 'string') continue;
      o += `                        <li class="break-all">${e(nameBoth(u.hostname))} <span class="${TONE.gray}">${e(phpStr(u.status ?? ''))}</span></li>\n`;
    }
    o += '                    </ul></div>\n';
  }
  return o + '            </div>\n';
}

function setupCard(ws: WorkerState, csrf: string): string {
  const workerAge = ws.worker_at ? time() - (strtotime(ws.worker_at) || 0) : null;
  const rows: Array<[('green' | 'amber' | 'red' | 'gray'), string, string]> = [
    [ws.token === 'ok' ? 'green' : ws.token === 'error' ? 'red' : 'gray', 'Cloudflare token', ws.token === 'ok' ? 'Works' : ws.token === 'error' ? 'Doesn’t work: ' + ws.token_error : 'Not tested yet'],
    [ws.fallback?.status === 'active' ? 'green' : ws.fallback ? 'amber' : 'gray', 'Fallback origin', fallbackOrigin() + ' · ' + (ws.fallback?.status ?? 'not checked yet')],
    ['green', 'Customers point to', cnameTarget()],
    [ws.probe_ok_at ? 'green' : 'gray', 'Tunnel catch-all', ws.probe_ok_at ? 'OK since ' + ws.probe_ok_at : 'Not tested yet'],
    [workerAge === null ? 'red' : workerAge <= 180 ? 'green' : 'red', 'Worker', workerAge === null ? 'Not running – see journalctl -u onyoursite-domains' : workerAge <= 180 ? 'Running – last seen ' + ago(ws.worker_at) : 'Last seen ' + ago(ws.worker_at) + ' – see journalctl -u onyoursite-domains'],
    [ws.freeze ? 'amber' : 'green', 'Checks', ws.freeze ? 'Paused since ' + ws.freeze.since + ': ' + (ws.freeze.detail || (ws.freeze.reason === 'control' ? 'our own site didn’t answer through Cloudflare' : 'many domains failed at once')) : 'Running'],
    [ws.quota?.exceeded ? 'red' : 'gray', 'Hostnames', ws.quota ? `${ws.quota.used} used · ${ws.quota.allocated} included · hard cap ${ws.quota.hard_cap}` : 'Not checked yet'],
    ['gray', 'Last test', ws.test ? ws.test.at + ' · ' + ws.test.result : 'None yet'],
  ];
  let o = `                <div class="${CARD} p-5 sm:p-6" id="domainsSetup">
                    <div class="flex flex-wrap items-center justify-between gap-3 mb-4 border-b border-bordercolor pb-4">
                        <h2 class="text-base font-semibold text-white flex items-center gap-2"><i class='bx bx-server text-xl text-cyan-400'></i> Setup</h2>
                        <div class="flex gap-2 flex-wrap">
                            ${ws.freeze ? `<form action="/admin" method="POST" class="m-0">${csrf}<input type="hidden" name="domain_action" value="control"><button type="submit" class="${BTN}"><i class='bx bx-refresh'></i> Check again now</button></form>` : ''}
                            <form action="/admin" method="POST" class="m-0">${csrf}<input type="hidden" name="domain_action" value="test"><button type="submit" class="${BTN}"><i class='bx bx-plug'></i> Test connection</button></form>
                        </div>
                    </div>
                    <dl class="divide-y divide-bordercolor">\n`;
  for (const [tone, label, value] of rows) {
    o += `                        <div class="py-2.5 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4"><dt class="text-sm text-gray-400 sm:w-48 shrink-0 flex items-center gap-2">${dot(tone)} ${e(label)}</dt><dd class="text-sm text-white break-all">${e(value)}</dd></div>\n`;
  }
  return o + '                    </dl>\n                </div>\n';
}

function settingsCard(s: Awaited<ReturnType<typeof domainSettings>>, csrf: string): string {
  const num = (name: string, label: string, value: number, min: number, max: number): string =>
    `<div><label class="${LBL}" for="dom_${name}">${e(label)}</label><input class="${FIELD}" type="number" id="dom_${name}" name="${name}" min="${min}" max="${max}" value="${value}"></div>`;
  const box = (name: string, label: string, on: boolean, hint = ''): string =>
    `<label class="flex items-start gap-3 text-sm text-gray-300"><input type="checkbox" name="${name}" value="1" class="mt-1"${on ? ' checked' : ''}><span>${e(label)}${hint ? `<small class="block text-xs text-gray-500">${e(hint)}</small>` : ''}</span></label>`;
  return `                <div class="${CARD} p-5 sm:p-6" id="domainsSettings">
                    <h2 class="text-base font-semibold text-white mb-4 border-b border-bordercolor pb-4 flex items-center gap-2"><i class='bx bx-slider-alt text-xl text-cyan-400'></i> Settings</h2>
                    <form action="/admin" method="POST" class="space-y-4"${confirmAttrs({ title: 'Save the custom domain settings?', text: 'They apply to new checks and new domains right away.', ok: 'Save' })}>
                        ${csrf}${confirmField()}<input type="hidden" name="domain_action" value="settings">
                        ${box('enabled', 'Let premium users connect new domains', s.enabled)}
                        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            ${num('per_user', 'Domains per user', s.per_user, 0, 10)}
                            ${num('max_total', 'Domains in total', s.max_total, 0, 50000)}
                            ${num('grace_days', 'Days a paused domain keeps forwarding', s.grace_days, 0, 90)}
                            ${num('pending_days', 'Days to finish the setup', s.pending_days, 1, 7)}
                            ${num('min_account_days', 'Minimum account age in days', s.min_account_days, 0, 365)}
                            ${num('mails_per_minute', 'Emails per minute (worker)', s.mails_per_minute, 1, 200)}
                        </div>
                        ${box('allow_paid', 'Allow paid hostnames beyond the free quota', s.allow_paid, 'Cloudflare bills $0.10 per hostname and month above the 100 included.')}
                        ${box('slots', 'Each domain needs a domain slot (sold in the shop)', s.slots)}
                        <button type="submit" class="bg-white text-black hover:bg-gray-200 font-bold py-2.5 px-5 rounded-lg transition-all flex items-center gap-2"><i class='bx bx-save'></i> Save</button>
                    </form>
                </div>\n`;
}

// Höchstens so viele Zeilen; darüber hinaus sucht der Admin auf dem Server (?domain_q=)
const LIST_MAX = 500;

async function listCard(csrf: string, search: string): Promise<string> {
  const like = '%' + search.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c) + '%';
  const where = search === '' ? '' : 'WHERE (LOWER(d.hostname) LIKE ? OR LOWER(p.slug) LIKE ? OR LOWER(u.email) LIKE ? OR LOWER(u.full_name) LIKE ?)';
  const params = search === '' ? [] : [like, like, like, like];
  const from = `FROM custom_domains d LEFT JOIN pages p ON d.target_type = 'page' AND p.id = d.target_id LEFT JOIN users u ON u.id = d.user_id ${where}`;
  const total = Number((await q(`SELECT COUNT(*) AS n ${from}`, params))[0]?.n ?? 0);
  const rows = await q(`SELECT d.*, p.slug AS page_slug, u.full_name AS owner_name, u.email AS owner_email ${from} ORDER BY d.id DESC LIMIT ${LIST_MAX}`, params);
  const ids = rows.map((r) => intval(r.id));
  // Je Domain die letzten zehn Einträge (nicht die letzten Einträge insgesamt – sonst verdrängen viel genutzte Domains
  // den Verlauf der anderen)
  const logs = new Map<number, Array<{ at: string; event: string; detail: string }>>();
  if (ids.length) {
    for (const l of await q(`SELECT domain_id, event, detail, created_at FROM (SELECT domain_id, event, detail, created_at, id,
        ROW_NUMBER() OVER (PARTITION BY domain_id ORDER BY id DESC) AS rn FROM custom_domain_log WHERE domain_id IN (${ids.map(() => '?').join(', ')})) x
        WHERE rn <= 10 ORDER BY domain_id, id DESC`, ids)) {
      const list = logs.get(intval(l.domain_id)) ?? [];
      list.push({ at: phpStr(l.created_at), event: phpStr(l.event), detail: phpStr(l.detail ?? '') });
      logs.set(intval(l.domain_id), list);
    }
  }
  let o = `                <div class="${CARD} overflow-hidden" id="domainsList">
                    <div class="flex flex-wrap items-center justify-between gap-3 p-5 sm:p-6 border-b border-bordercolor">
                        <h2 class="text-base font-semibold text-white flex items-center gap-2"><i class='bx bx-globe text-xl text-cyan-400'></i> Domains <span class="text-gray-500 text-sm font-normal">${rows.length}</span></h2>
                        <form action="/admin#domains" method="GET" class="m-0 flex gap-2"><input type="search" id="domainsFilter" name="domain_q" value="${e(search)}" placeholder="Search domains, pages, owners" class="${FIELD} sm:w-72" aria-label="Search domains"><button type="submit" class="${BTN}"><i class='bx bx-search'></i> Search</button></form>
                    </div>\n`;
  if (total > rows.length) o += `                    <p class="px-5 sm:px-6 pt-4 text-xs text-amber-300">Showing the newest ${rows.length} of ${total} – search to find the others.</p>\n`;
  if (!rows.length) return o + `                    <p class="p-6 text-sm text-gray-500">${search === '' ? 'No custom domains yet.' : 'No domain matches this search.'}</p>\n                </div>\n`;
  o += '                    <div class="divide-y divide-bordercolor" id="domainRows">\n';
  for (const r of rows) {
    const id = intval(r.id);
    const host = nameBoth(phpStr(r.hostname));
    const state = phpStr(r.state);
    const [tone, label] = STATE[state] ?? ['gray', state];
    const owner = phpStr(r.owner_name ?? '') !== '' ? `${phpStr(r.owner_name)} (${phpStr(r.owner_email ?? '')})` : phpStr(r.owner_email ?? '');
    const meta = [
      'page ' + (phpStr(r.page_slug ?? '') || '#' + intval(r.target_id)), owner,
      `CF: ${phpStr(r.cf_status ?? '') || '—'} / SSL: ${phpStr(r.cf_ssl_status ?? '') || '—'}`,
      phpStr(r.problem ?? '') !== '' ? 'problem: ' + phpStr(r.problem) : '',
      'added ' + phpStr(r.created_at ?? ''), r.activated_at ? 'live since ' + phpStr(r.activated_at) : '', r.checked_at ? 'last check ' + phpStr(r.checked_at) : '',
    ].filter((x) => x !== '');
    const form = (action: string, inner: string, confirm: string, cls = 'm-0'): string =>
      `<form action="/admin" method="POST" class="${cls}"${confirm}>${csrf}${confirmField()}<input type="hidden" name="domain_action" value="${action}"><input type="hidden" name="domain_id" value="${id}">${inner}</form>`;
    const acts: string[] = [];
    if (state !== 'removing' && state !== 'blocked') acts.push(form('check', `<button type="submit" class="${BTN}"><i class='bx bx-refresh'></i> Check now</button>`, ''));
    if (state === 'blocked') {
      acts.push(form('enable', `<button type="submit" class="${BTN}"><i class='bx bx-check'></i> Enable</button>`, confirmAttrs({ title: 'Enable ' + host + '?', text: 'The domain is checked again and can go live.', ok: 'Enable' })));
    } else if (state !== 'removing') {
      acts.push(form('disable', `<input name="reason" maxlength="200" placeholder="Reason the user sees" class="${FIELD} sm:w-56" aria-label="Reason for ${e(host)}"><button type="submit" class="${BTN_RED}"><i class='bx bx-block'></i> Disable</button>`,
        confirmAttrs({ title: 'Disable ' + host + '?', text: 'The page loses the domain at once, and the hostname stays blocked for every account until you enable it.', ok: 'Disable', tone: 'danger' }), 'm-0 flex flex-wrap gap-2'));
    }
    if (state !== 'removing') acts.push(form('remove', `<button type="submit" class="${BTN_RED}"><i class='bx bx-trash'></i> Remove</button>`, confirmAttrs({ title: 'Remove ' + host + '?', text: 'The domain is disconnected from its page. The owner is told.', ok: 'Remove', tone: 'danger' })));
    const history = logs.get(id) ?? [];
    o += `                        <div class="p-4 sm:px-6" data-domain-row data-search="${e((host + ' ' + phpStr(r.hostname) + ' ' + meta.join(' ')).toLowerCase())}">
                            <div class="flex flex-col lg:flex-row lg:items-start gap-3">
                                <div class="min-w-0 flex-1">
                                    <p class="text-sm text-white font-medium break-all"><a href="${e('https://' + phpStr(r.hostname))}" target="_blank" rel="noopener" class="hover:underline">${e(host)}</a> <span class="${TONE[tone]}">${e(label)}</span></p>
                                    <p class="text-xs text-gray-500 mt-1 break-words">${e(meta.join(' · '))}</p>
                                    ${state === 'blocked' && r.blocked_reason ? `<p class="text-xs text-red-300 mt-1 break-words">Reason: ${e(phpStr(r.blocked_reason))}</p>` : ''}
                                    ${history.length ? `<details class="mt-2"><summary class="text-xs text-gray-400 cursor-pointer">History</summary><ul class="mt-1 space-y-0.5 text-xs text-gray-500">${history.map((h) => `<li class="break-words">${e(h.at)} · ${e(h.event)}${h.detail ? ' – ' + e(h.detail) : ''}</li>`).join('')}</ul></details>` : ''}
                                </div>
                                <div class="flex flex-wrap gap-2 shrink-0">${acts.join('')}</div>
                            </div>
                        </div>\n`;
  }
  o += `                    </div>
                    <script>
                        (function () {
                            var f = document.getElementById('domainsFilter');
                            if (!f) return;
                            f.addEventListener('input', function () {
                                var v = f.value.trim().toLowerCase();
                                document.querySelectorAll('[data-domain-row]').forEach(function (row) { row.hidden = v !== '' && row.getAttribute('data-search').indexOf(v) === -1; });
                            });
                        })();
                    </script>
                </div>\n`;
  return o;
}

async function blocksCard(csrf: string): Promise<string> {
  const rows = await q('SELECT hostname, reason, created_at FROM custom_domain_blocks ORDER BY created_at DESC LIMIT 500');
  if (!rows.length) return '';
  let o = `                <div class="${CARD} overflow-hidden" id="domainsBlocked">
                    <div class="p-5 sm:p-6 border-b border-bordercolor"><h2 class="text-base font-semibold text-white flex items-center gap-2"><i class='bx bx-block text-xl text-red-400'></i> Blocked hostnames <span class="text-gray-500 text-sm font-normal">${rows.length}</span></h2>
                    <p class="text-xs text-gray-500 mt-1">Removed after the team disabled them. No account can connect them until you release them.</p></div>
                    <div class="divide-y divide-bordercolor">\n`;
  for (const r of rows) {
    const host = nameBoth(phpStr(r.hostname));
    o += `                        <div class="p-4 sm:px-6 flex flex-col sm:flex-row sm:items-center gap-3">
                            <div class="min-w-0 flex-1"><p class="text-sm text-white break-all">${e(host)}</p><p class="text-xs text-gray-500 mt-1 break-words">${e((r.reason ? phpStr(r.reason) + ' · ' : '') + 'since ' + phpStr(r.created_at ?? ''))}</p></div>
                            <form action="/admin" method="POST" class="m-0 shrink-0"${confirmAttrs({ title: 'Release ' + host + '?', text: 'Any account can connect this domain again.', ok: 'Release' })}>${csrf}${confirmField()}<input type="hidden" name="domain_action" value="release"><input type="hidden" name="hostname" value="${e(phpStr(r.hostname))}"><button type="submit" class="${BTN}"><i class='bx bx-lock-open-alt'></i> Release</button></form>
                        </div>\n`;
  }
  return o + '                    </div>\n                </div>\n';
}
