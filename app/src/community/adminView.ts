// Admin: Community – Vorschläge aus Discord annehmen/ablehnen, Support-Tickets beantworten (views/admin_community.php).
// Gibt genau das aus, was das require in views/admin.php ausgibt (ohne die 12 Leerzeichen, die admin.php selbst vor
// das require schreibt). Der Text außerhalb der PHP-Teile ist mit view2ts Byte für Byte übernommen.
import type { Ctx } from '../web/ctx.js';
import { q, value } from '../db.js';
import { e } from '../html.js';
import { randomHex } from '../crypto.js';
import { csrfField } from '../web/security.js';
import { date, intval, phpStr, phpTruthy, strtotime, time, ucfirst } from '../php.js';
import { botLastSeen, botSecret, ticketGet, ticketMessages } from './community.js';

const FILTERS = ['open', 'accepted', 'declined', 'all'];
const FILTER_LABELS: Array<[string, string]> = [['open', 'Open'], ['accepted', 'Accepted'], ['declined', 'Declined'], ['all', 'All']];
const BADGE = new Map<string, string>([
  ['open', 'bg-sky-500/15 text-sky-400'], ['accepted', 'bg-emerald-500/15 text-emerald-400'], ['declined', 'bg-red-500/15 text-red-400'],
  ['closed', 'bg-white/10 text-gray-400'],
]);

export async function adminCommunityView(ctx: Ctx): Promise<string> {
  let o = '';
  const botReady = botSecret() !== '';
  const botSeenAt = await botLastSeen();
  const botOnline = botSeenAt !== null && time() - botSeenAt < 300;
  const requested = ctx.get.suggestions ?? 'open';
  const suggestionFilter = typeof requested === 'string' && FILTERS.includes(requested) ? requested : 'open';
  const suggestions = suggestionFilter === 'all'
    ? await q('SELECT * FROM community_suggestions ORDER BY id DESC LIMIT 100')
    : await q('SELECT * FROM community_suggestions WHERE status = ? ORDER BY id DESC LIMIT 100', [suggestionFilter]);
  // Zähler wie ein PHP-Array: feste Schlüssel zuerst, dann was die Datenbank sonst noch liefert; all = Summe
  const counts = new Map<string, number>([['open', 0], ['accepted', 0], ['declined', 0]]);
  for (const row of await q('SELECT status, COUNT(*) AS n FROM community_suggestions GROUP BY status')) {
    counts.set(phpStr(row.status), intval(row.n));
  }
  counts.set('all', [...counts.values()].reduce((a, b) => a + b, 0));
  const tickets = await q(`SELECT t.*, (SELECT COUNT(*) FROM community_ticket_messages m WHERE m.ticket_id = t.id) AS message_count
    FROM community_tickets t ORDER BY t.status = 'open' DESC, t.updated_at DESC LIMIT 50`);
  const openTickets = tickets.filter((t) => t.status === 'open').length;
  const ticketView = ctx.get.ticket !== undefined ? await ticketGet(intval(ctx.get.ticket)) : null;
  const messages = ticketView ? await ticketMessages(intval(ticketView.id)) : [];
  const pendingOutbox = intval(await value('SELECT COUNT(*) FROM community_outbox WHERE done_at IS NULL AND attempts < 10'));
  const failedOutbox = await q('SELECT action, last_error, attempts FROM community_outbox WHERE done_at IS NULL AND last_error IS NOT NULL ORDER BY id DESC LIMIT 3');

  const inputClass = 'w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm';
  const btn = 'inline-flex items-center gap-1.5 px-3 py-2 min-h-[36px] rounded-lg text-xs font-medium border border-bordercolor text-gray-300 hover:text-white hover:bg-white/5 transition-colors';
  const when = (d: unknown): string => (phpTruthy(d) ? date('M j, Y H:i', intval(strtotime(phpStr(d)))) : '—');
  o += "            <!-- ===================== Community ===================== -->\n            <div id=\"tab-community\" class=\"admin-tab-content max-w-5xl mx-auto space-y-8 hidden\">\n                <div class=\"grid grid-cols-1 sm:grid-cols-3 gap-4\">\n                    <div class=\"bg-card border border-bordercolor rounded-xl p-5\">\n                        <p class=\"text-xs text-gray-500 uppercase tracking-wider font-semibold\">Open suggestions</p>\n                        <p class=\"text-3xl font-bold text-white mt-1\">";
  o += String(counts.get('open'));
  o += "</p>\n                    </div>\n                    <div class=\"bg-card border border-bordercolor rounded-xl p-5\">\n                        <p class=\"text-xs text-gray-500 uppercase tracking-wider font-semibold\">Open tickets</p>\n                        <p class=\"text-3xl font-bold text-white mt-1\">";
  o += String(openTickets);
  o += "</p>\n                    </div>\n                    <div class=\"bg-card border border-bordercolor rounded-xl p-5\">\n                        <p class=\"text-xs text-gray-500 uppercase tracking-wider font-semibold\">Discord bot</p>\n                        ";
  if (!botReady) {
    o += "                        <p class=\"text-sm text-amber-400 mt-2 font-medium\">Not set up</p>\n                        ";
  } else if (botOnline) {
    o += "                        <p class=\"text-sm text-emerald-400 mt-2 font-medium flex items-center gap-1.5\"><span class=\"h-2 w-2 rounded-full bg-emerald-400\"></span> Connected</p>\n                        ";
  } else {
    o += "                        <p class=\"text-sm text-gray-400 mt-2 font-medium\">Offline";
    o += (botSeenAt ? ' – last seen ' + e(when(date('Y-m-d H:i:s', botSeenAt))) : '');
    o += "</p>\n                        ";
  }
  o += "                        ";
  if (pendingOutbox) {
    o += "                        <p class=\"text-xs text-gray-500 mt-1\">";
    o += String(pendingOutbox);
    o += " change";
    o += (pendingOutbox === 1 ? '' : 's');
    o += " waiting for the bot</p>\n                        ";
  }
  o += "                    </div>\n                </div>\n\n                ";
  if (!botReady) {
    o += "                <div class=\"rounded-xl border border-amber-500/30 bg-amber-500/5 p-5 text-sm text-gray-300 space-y-2\">\n                    <p class=\"font-semibold text-amber-300\">Connect the Discord bot</p>\n                    <ol class=\"list-decimal pl-5 space-y-1\">\n                        <li>Add this line to <code>config.php</code> (a random secret, made just now): <code class=\"text-white break-all\">'bot_secret' =&gt; '";
    o += randomHex(32);
    o += "',</code></li>\n                        <li>Put the same value into <code>BOT_SECRET</code> in the bot’s <code>.env</code> and start the bot – see <code>discord-bot/README.md</code>.</li>\n                    </ol>\n                </div>\n                ";
  }
  o += "                ";
  for (const f of failedOutbox) {
    o += "                <div class=\"rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-300\">The bot couldn’t carry out “";
    o += e(f.action);
    o += "” (";
    o += String(intval(f.attempts));
    o += " tries): ";
    o += e(f.last_error);
    o += "</div>\n                ";
  }
  o += "\n                <!-- Vorschläge -->\n                <div class=\"bg-card border border-bordercolor rounded-xl shadow-xl overflow-hidden\">\n                    <div class=\"flex flex-wrap items-center justify-between gap-3 p-5 sm:p-6 border-b border-bordercolor\">\n                        <h2 class=\"text-base font-semibold text-white flex items-center gap-2\"><i class='bx bx-bulb text-xl text-brand-400'></i> Suggestions from Discord</h2>\n                        <div class=\"flex flex-wrap gap-1.5\">\n                            ";
  for (const [key, label] of FILTER_LABELS) {
    o += "                            <a href=\"/admin?suggestions=";
    o += key;
    o += "#community\" class=\"";
    o += btn;
    o += " ";
    o += (suggestionFilter === key ? '!bg-white/10 !text-white' : '');
    o += "\">";
    o += label;
    o += " <span class=\"text-gray-500\">";
    o += String(counts.get(key));
    o += "</span></a>\n                            ";
  }
  o += "                        </div>\n                    </div>\n                    ";
  if (!suggestions.length) {
    o += "                    <p class=\"p-6 text-sm text-gray-500\">";
    o += (suggestionFilter === 'open' ? 'No open suggestions. New posts in the suggestion forum on Discord show up here.' : 'Nothing here yet.');
    o += "</p>\n                    ";
  } else {
    o += "                    <div class=\"divide-y divide-bordercolor\">\n                        ";
    for (const s of suggestions) {
      o += "                        <div class=\"p-5 sm:px-6\" id=\"suggestion-";
      o += String(intval(s.id));
      o += "\">\n                            <div class=\"flex flex-wrap items-start justify-between gap-3\">\n                                <div class=\"min-w-0\">\n                                    <p class=\"text-white font-medium break-words\"><span class=\"text-gray-500\">#";
      o += String(intval(s.id));
      o += "</span> ";
      o += e(s.title);
      o += "</p>\n                                    <p class=\"text-xs text-gray-500 mt-1\">by ";
      o += e(s.author_name !== '' ? s.author_name : s.author_id);
      o += " · ";
      o += e(when(s.created_at));
      o += "</p>\n                                </div>\n                                <span class=\"shrink-0 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ";
      o += (BADGE.get(phpStr(s.status)) ?? BADGE.get('open'));
      o += "\">";
      o += e(s.status);
      o += "</span>\n                            </div>\n                            ";
      if (s.body !== '') {
        o += "                            <details class=\"mt-3 text-sm text-gray-300\">\n                                <summary class=\"cursor-pointer text-gray-400 hover:text-white text-xs\">Show text</summary>\n                                <div class=\"mt-2 whitespace-pre-wrap break-words bg-inputbg border border-bordercolor rounded-lg p-3\">";
        o += e(s.body);
        o += "</div>\n                            </details>\n                            ";
      }
      o += "                            ";
      if (s.status === 'open') {
        o += "                            <form action=\"/admin\" method=\"POST\" class=\"mt-3 flex flex-col sm:flex-row gap-2\">\n                                ";
        o += await csrfField(ctx);
        o += "<input type=\"hidden\" name=\"community_action\" value=\"suggestion_decide\"><input type=\"hidden\" name=\"id\" value=\"";
        o += String(intval(s.id));
        o += "\">\n                                <input type=\"text\" name=\"reason\" maxlength=\"500\" placeholder=\"Note for the community (optional)\" class=\"";
        o += inputClass;
        o += " !py-2 sm:flex-1\">\n                                <div class=\"flex gap-2 shrink-0\">\n                                    <button type=\"submit\" name=\"status\" value=\"accepted\" class=\"";
        o += btn;
        o += " !text-emerald-400 hover:!bg-emerald-500/10\"><i class='bx bx-check'></i> Accept</button>\n                                    <button type=\"submit\" name=\"status\" value=\"declined\" class=\"";
        o += btn;
        o += " !text-red-400 hover:!bg-red-500/10\"><i class='bx bx-x'></i> Decline</button>\n                                </div>\n                            </form>\n                            ";
      } else {
        o += "                            <p class=\"mt-3 text-xs text-gray-400\">";
        o += e(ucfirst(phpStr(s.status)));
        o += " by ";
        o += e(s.decided_by);
        o += " ";
        o += (s.decided_via === 'web' ? 'on the website' : 'in Discord');
        o += " · ";
        o += e(when(s.decided_at));
        o += (s.reason !== '' ? ' – “' + e(s.reason) + '”' : '');
        o += "</p>\n                            ";
      }
      o += "                        </div>\n                        ";
    }
    o += "                    </div>\n                    ";
  }
  o += "                </div>\n\n                <!-- Support -->\n                <div class=\"bg-card border border-bordercolor rounded-xl shadow-xl overflow-hidden\" id=\"community-tickets\">\n                    <div class=\"flex items-center gap-3 p-5 sm:p-6 border-b border-bordercolor\">\n                        <i class='bx bx-support text-xl text-brand-400'></i>\n                        <h2 class=\"text-base font-semibold text-white\">Support tickets</h2>\n                    </div>\n                    ";
  if (ticketView) {
    o += "                    <div class=\"p-5 sm:p-6 border-b border-bordercolor bg-white/[0.02]\">\n                        <div class=\"flex flex-wrap items-start justify-between gap-3 mb-4\">\n                            <div class=\"min-w-0\">\n                                <p class=\"text-white font-semibold break-words\"><span class=\"text-gray-500\">#";
    o += String(intval(ticketView.id));
    o += "</span> ";
    o += e(ticketView.subject);
    o += "</p>\n                                <p class=\"text-xs text-gray-500 mt-1\">";
    o += e(ticketView.user_name !== '' ? ticketView.user_name : ticketView.user_id);
    o += " · opened ";
    o += e(when(ticketView.created_at));
    o += (ticketView.status === 'closed' ? ' · closed by ' + e(ticketView.closed_by) + ' ' + e(when(ticketView.closed_at)) : '');
    o += "</p>\n                            </div>\n                            <a href=\"/admin#community\" class=\"";
    o += btn;
    o += "\"><i class='bx bx-x'></i> Close view</a>\n                        </div>\n                        <div class=\"space-y-3 max-h-[480px] overflow-y-auto pr-1\">\n                            ";
    for (const msg of messages) {
      o += "                            <div class=\"flex ";
      o += (phpTruthy(msg.is_team) ? 'justify-end' : '');
      o += "\">\n                                <div class=\"max-w-[85%] rounded-xl px-4 py-3 text-sm ";
      o += (phpTruthy(msg.is_team) ? 'bg-brand-500/15 border border-brand-500/30' : 'bg-inputbg border border-bordercolor');
      o += "\">\n                                    <p class=\"text-xs mb-1 ";
      o += (phpTruthy(msg.is_team) ? 'text-brand-400' : 'text-gray-400');
      o += "\">";
      o += e(msg.author_name !== '' ? msg.author_name : 'Unknown');
      o += (phpTruthy(msg.is_team) ? ' (team' + (msg.source === 'web' ? ', website' : '') + ')' : '');
      o += " · ";
      o += e(when(msg.created_at));
      o += "</p>\n                                    <p class=\"text-gray-200 whitespace-pre-wrap break-words\">";
      o += e(msg.body);
      o += "</p>\n                                </div>\n                            </div>\n                            ";
    }
    o += "                        </div>\n                        ";
    if (ticketView.status === 'open') {
      o += "                        <form action=\"/admin\" method=\"POST\" class=\"mt-4 space-y-3\">\n                            ";
      o += await csrfField(ctx);
      o += "<input type=\"hidden\" name=\"id\" value=\"";
      o += String(intval(ticketView.id));
      o += "\">\n                            <textarea name=\"body\" rows=\"3\" maxlength=\"2000\" placeholder=\"Write a reply – it’s posted in the ticket channel on Discord.\" class=\"";
      o += inputClass;
      o += "\"></textarea>\n                            <div class=\"flex flex-wrap gap-2 justify-end\">\n                                <button type=\"submit\" name=\"community_action\" value=\"ticket_close\" class=\"";
      o += btn;
      o += " !text-red-400 hover:!bg-red-500/10\" onclick=\"return confirm('Close this ticket?')\"><i class='bx bx-lock-alt'></i> Close ticket</button>\n                                <button type=\"submit\" name=\"community_action\" value=\"ticket_reply\" class=\"bg-white text-black hover:bg-gray-200 font-bold py-2 px-5 rounded-lg transition-all flex items-center gap-2 text-sm\"><i class='bx bx-send'></i> Send reply</button>\n                            </div>\n                        </form>\n                        ";
    }
    o += "                    </div>\n                    ";
  }
  o += "                    ";
  if (!tickets.length) {
    o += "                    <p class=\"p-6 text-sm text-gray-500\">No tickets yet. People open them with the support button on Discord.</p>\n                    ";
  } else {
    o += "                    <div class=\"divide-y divide-bordercolor\">\n                        ";
    for (const t of tickets) {
      o += "                        <a href=\"/admin?ticket=";
      o += String(intval(t.id));
      o += "#community\" class=\"flex items-center gap-3 px-5 sm:px-6 py-3 hover:bg-white/[0.03] transition-colors ";
      o += (ticketView && intval(ticketView.id) === intval(t.id) ? 'bg-white/[0.04]' : '');
      o += "\">\n                            <span class=\"shrink-0 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ";
      o += (BADGE.get(phpStr(t.status)) ?? BADGE.get('closed'));
      o += "\">";
      o += e(t.status);
      o += "</span>\n                            <span class=\"min-w-0 flex-1\">\n                                <span class=\"block text-sm text-white truncate\"><span class=\"text-gray-500\">#";
      o += String(intval(t.id));
      o += "</span> ";
      o += e(t.subject);
      o += "</span>\n                                <span class=\"block text-xs text-gray-500 truncate\">";
      o += e(t.user_name !== '' ? t.user_name : t.user_id);
      o += " · ";
      o += String(intval(t.message_count));
      o += " message";
      o += (intval(t.message_count) === 1 ? '' : 's');
      o += " · last activity ";
      o += e(when(t.updated_at));
      o += "</span>\n                            </span>\n                            <i class='bx bx-chevron-right text-gray-500 text-xl'></i>\n                        </a>\n                        ";
    }
    o += "                    </div>\n                    ";
  }
  o += "                </div>\n            </div>\n";
  return o;
}
