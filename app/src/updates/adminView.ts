// Admin-Panel: Updates, Roadmap und Discord (views/admin_updates.php). Updates und Roadmap geben genau das HTML
// dieses includes innerhalb von views/admin.php aus (ab der ersten Zeile nach dem PHP-Kopf) – admin.php schreibt davor
// nur seine 12 Leerzeichen; Text außerhalb der PHP-Teile: view2ts, Byte für Byte. Der Reiter Discord kommt aus
// app/src/discord/adminView.ts.
import type { Ctx } from '../web/ctx.js';
import { csrfField } from '../web/security.js';
import { e } from '../html.js';
import { date, intval, phpLtrim, phpStr, phpTruthy, strtotime } from '../php.js';
import {
  MILESTONE_STATUSES, UPDATE_CATEGORIES, milestoneGet, milestones, updateGet, updatesList, type Milestone, type Update,
} from './updates.js';
import { discordConfigured, discordSettings, type DiscordSettings } from './discord.js';
import { discordTabData, discordTabView } from '../discord/adminView.js';

export interface AdminUpdatesData {
  // oys_csrf_field() – überall dasselbe Feld
  csrf: string;
  discordSettings: DiscordSettings;
  discordReady: boolean;
  allUpdates: Update[];
  allMilestones: Milestone[];
  editUpdate: Update | null;
  prefillMs: Milestone | null;
  editMilestone: Milestone | null;
  // Reiter Discord (fertiges HTML aus discord/adminView.ts)
  discordTab: string;
}

// Formularwerte: ein vorhandenes Update oder die Vorgaben (auf Wunsch aus einem Meilenstein vorbefüllt)
interface UpdateForm {
  id: number;
  title: string;
  body: string;
  version: string;
  category: string;
  milestone_id: number | null;
  is_published: boolean;
  published_at: string | null;
  discord_message_id: string;
  discord_announce: unknown;
}

// Daten wie am Anfang von admin_updates.php: ?edit_update=, ?new_update_for= und ?edit_milestone= aus der Adresse
export async function adminUpdatesView(ctx: Ctx): Promise<string> {
  const settings = await discordSettings();
  const csrf = (await csrfField(ctx)).value;
  const get = ctx.get;
  return adminUpdatesTemplate({
    discordSettings: settings,
    discordReady: discordConfigured(settings),
    allUpdates: await updatesList(false, 300),
    allMilestones: await milestones(false),
    editUpdate: get.edit_update !== undefined ? await updateGet(intval(get.edit_update)) : null,
    prefillMs: get.new_update_for !== undefined ? await milestoneGet(intval(get.new_update_for)) : null,
    editMilestone: get.edit_milestone !== undefined ? await milestoneGet(intval(get.edit_milestone)) : null,
    csrf,
    discordTab: discordTabView(await discordTabData(ctx, csrf)),
  });
}

export function adminUpdatesTemplate(d: AdminUpdatesData): string {
  let o = '';
  const { csrf, discordSettings: ds, discordReady, allUpdates, allMilestones, editUpdate, prefillMs, editMilestone, discordTab } = d;
  const inp = 'w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm';
  const lbl = 'block text-sm font-medium text-gray-300 mb-1.5';
  const btn = 'inline-flex items-center gap-1.5 px-3 py-2 min-h-[36px] rounded-lg text-xs font-medium border border-bordercolor text-gray-300 hover:text-white hover:bg-white/5 transition-colors';
  const fmt = (dt: string | null): string => {
    if (!phpTruthy(dt)) return '—';
    const t = strtotime(dt as string);
    return date('M j, Y', t === false ? 0 : t);
  };
  const uf: UpdateForm = editUpdate ?? {
    id: 0,
    title: prefillMs ? 'Shipped: ' + prefillMs.title : '',
    body: prefillMs ? prefillMs.description : '',
    version: '', category: 'new', milestone_id: prefillMs ? prefillMs.id : null,
    is_published: false, published_at: null, discord_message_id: '', discord_announce: ds.auto_post,
  };
  const ufDate = phpTruthy(uf.published_at) ? phpStr(uf.published_at).slice(0, 10) : date('Y-m-d');
  // Bereits veröffentlicht, aber nicht in Discord: nur auf ausdrücklichen Wunsch nachträglich posten
  const announceNow = !!editUpdate && uf.is_published;
  const announceChecked = announceNow ? false : phpTruthy(uf.discord_announce);
  const mf = editMilestone ?? { id: 0, title: '', description: '', status: 'next', target: '', is_public: true };
  const byStatus: Record<string, Milestone[]> = { now: [], next: [], planned: [], done: [] };
  for (const m of allMilestones) byStatus[m.status].push(m);
  o += "            <!-- ===================== Updates ===================== -->\n            <div id=\"tab-updates\" class=\"admin-tab-content max-w-5xl mx-auto space-y-8 hidden\">\n                <div class=\"bg-card border border-bordercolor rounded-xl shadow-xl p-5 sm:p-6\">\n                    <div class=\"flex flex-wrap items-center justify-between gap-3 mb-6 border-b border-bordercolor pb-4\">\n                        <h2 class=\"text-base font-semibold text-white flex items-center gap-2\"><i class='bx bx-edit text-xl text-sky-400'></i> ";
  o += editUpdate ? 'Edit update' : 'Write an update';
  o += "</h2>\n                        <a href=\"/updates\" target=\"_blank\" rel=\"noopener\" class=\"text-sm text-gray-400 hover:text-white flex items-center gap-1 py-2\">View /updates <i class='bx bx-link-external'></i></a>\n                    </div>\n                    <form action=\"/admin\" method=\"POST\" class=\"space-y-5\">\n                        ";
  o += csrf;
  o += "                        <input type=\"hidden\" name=\"oys_action\" value=\"update_save\">\n                        <input type=\"hidden\" name=\"id\" value=\"";
  o += uf.id;
  o += "\">\n                        <div>\n                            <label class=\"";
  o += lbl;
  o += "\" for=\"uTitle\">Title</label>\n                            <input id=\"uTitle\" type=\"text\" name=\"title\" required maxlength=\"160\" value=\"";
  o += e(uf.title);
  o += "\" placeholder=\"e.g. New themes and a faster editor\" class=\"";
  o += inp;
  o += "\">\n                        </div>\n                        <div class=\"grid grid-cols-1 sm:grid-cols-3 gap-4\">\n                            <div>\n                                <label class=\"";
  o += lbl;
  o += "\" for=\"uVersion\">Version <span class=\"text-gray-500 font-normal\">(optional)</span></label>\n                                <input id=\"uVersion\" type=\"text\" name=\"version\" maxlength=\"40\" value=\"";
  o += e(uf.version);
  o += "\" placeholder=\"e.g. 2.3\" class=\"";
  o += inp;
  o += "\">\n                            </div>\n                            <div>\n                                <label class=\"";
  o += lbl;
  o += "\" for=\"uCategory\">Category</label>\n                                <select id=\"uCategory\" name=\"category\" class=\"";
  o += inp;
  o += "\">\n                                    ";
  for (const [key, cat] of Object.entries(UPDATE_CATEGORIES)) {
    o += "                                    <option value=\"";
    o += e(key);
    o += "\"";
    o += uf.category === key ? ' selected' : '';
    o += ">";
    o += e(cat.label);
    o += "</option>\n                                    ";
  }
  o += "                                </select>\n                            </div>\n                            <div>\n                                <label class=\"";
  o += lbl;
  o += "\" for=\"uDate\">Date</label>\n                                <input id=\"uDate\" type=\"date\" name=\"date\" value=\"";
  o += e(ufDate);
  o += "\" max=\"";
  o += e(date('Y-m-d'));
  o += "\" class=\"";
  o += inp;
  o += "\">\n                                <input type=\"hidden\" name=\"date_default\" value=\"";
  o += e(ufDate);
  o += "\">\n                            </div>\n                        </div>\n                        <div>\n                            <label class=\"";
  o += lbl;
  o += "\" for=\"uMilestone\">Milestone <span class=\"text-gray-500 font-normal\">(optional)</span></label>\n                            <select id=\"uMilestone\" name=\"milestone_id\" class=\"";
  o += inp;
  o += "\">\n                                <option value=\"0\">— none —</option>\n                                ";
  for (const m of allMilestones) {
    o += "                                <option value=\"";
    o += m.id;
    o += "\"";
    o += intval(uf.milestone_id) === m.id ? ' selected' : '';
    o += ">";
    o += e(m.title);
    o += " (";
    o += e(MILESTONE_STATUSES[m.status].short);
    o += ")</option>\n                                ";
  }
  o += "                            </select>\n                        </div>\n                        <div>\n                            <label class=\"";
  o += lbl;
  o += "\" for=\"uBody\">Text</label>\n                            <textarea id=\"uBody\" name=\"body\" rows=\"10\" maxlength=\"20000\" placeholder=\"What changed? Lists with “- ”, **bold**, *italic*, `code`, [links](https://…)\" class=\"";
  o += inp;
  o += " font-mono leading-relaxed\">";
  o += e(uf.body);
  o += "</textarea>\n                            <p class=\"text-xs text-gray-500 mt-1.5\">Same formatting as in Discord: <code>**bold**</code>, <code>*italic*</code>, <code>- list</code>, <code>[text](https://…)</code>, <code>`code`</code>.</p>\n                        </div>\n                        <div class=\"flex flex-col sm:flex-row sm:items-center gap-4 pt-2 border-t border-bordercolor\">\n                            <div class=\"flex gap-4 text-sm pt-3 sm:pt-4\">\n                                <label class=\"flex items-center gap-2 cursor-pointer\"><input type=\"radio\" name=\"publish\" value=\"1\" class=\"accent-brand-500\"";
  o += uf.is_published || !editUpdate ? ' checked' : '';
  o += "> Publish</label>\n                                <label class=\"flex items-center gap-2 cursor-pointer\"><input type=\"radio\" name=\"publish\" value=\"\"";
  o += editUpdate && !uf.is_published ? ' checked' : '';
  o += " class=\"accent-brand-500\"> Save as draft</label>\n                            </div>\n                            <div class=\"sm:pt-4 text-sm\">\n                                ";
  if (!discordReady) {
    o += "                                <span class=\"text-gray-500 flex items-center gap-1.5\"><i class='bx bxl-discord-alt text-lg'></i> Connect Discord under <a href=\"#discord\" onclick=\"switchAdminTab('discord')\" class=\"text-brand-400 hover:text-white\">Discord</a> to announce updates.</span>\n                                ";
  } else if (uf.discord_message_id !== '') {
    o += "                                <span class=\"text-emerald-400 flex items-center gap-1.5\"><i class='bx bxl-discord-alt text-lg'></i> Already on Discord – changes are synced, drafts are removed there.</span>\n                                ";
  } else {
    o += "                                <input type=\"hidden\" name=\"announce_field\" value=\"1\">\n                                <label class=\"flex items-center gap-2 cursor-pointer text-gray-300\"><input type=\"checkbox\" name=\"post_discord\" value=\"1\" class=\"accent-[#5865F2]\"";
    o += announceChecked ? ' checked' : '';
    o += "> <i class='bx bxl-discord-alt text-lg text-[#5865F2]'></i> ";
    o += announceNow ? 'Post it to Discord now' : 'Announce on Discord when published';
    o += "</label>\n                                ";
  }
  o += "                            </div>\n                        </div>\n                        <div class=\"flex flex-wrap justify-end gap-3\">\n                            ";
  if (editUpdate || prefillMs) {
    o += "<a href=\"/admin#updates\" class=\"px-4 py-2.5 rounded-lg text-sm font-medium text-gray-400 hover:bg-white/5\">Cancel</a>";
  }
  o += "                            <button type=\"submit\" class=\"bg-white text-black hover:bg-gray-200 font-bold py-2.5 px-6 rounded-lg transition-all flex items-center gap-2\"><i class='bx bx-save'></i> ";
  o += editUpdate ? 'Save changes' : 'Save update';
  o += "</button>\n                        </div>\n                    </form>\n                </div>\n\n                <div class=\"bg-card border border-bordercolor rounded-xl shadow-xl overflow-hidden\">\n                    <div class=\"flex items-center justify-between px-5 sm:px-6 py-4 border-b border-bordercolor\">\n                        <h2 class=\"text-base font-semibold text-white\">All updates</h2>\n                        <span class=\"text-xs text-gray-500\">";
  o += allUpdates.filter((u) => u.is_published).length;
  o += " published · ";
  o += allUpdates.filter((u) => !u.is_published).length;
  o += " drafts</span>\n                    </div>\n                    ";
  if (!allUpdates.length) {
    o += "                    <p class=\"px-6 py-10 text-center text-sm text-gray-500\">No updates yet. Write your first one above.</p>\n                    ";
  }
  o += "                    <ul class=\"divide-y divide-bordercolor\">\n                        ";
  for (const u of allUpdates) {
    const cat = UPDATE_CATEGORIES[u.category];
    o += "                        <li class=\"px-5 sm:px-6 py-4 flex flex-col lg:flex-row lg:items-center gap-3\">\n                            <div class=\"min-w-0 flex-1\">\n                                <div class=\"flex flex-wrap items-center gap-2\">\n                                    ";
    if (u.is_published) {
      o += "<span class=\"text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400\">Published</span>";
    } else {
      o += "<span class=\"text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-white/10 text-gray-400\">Draft</span>";
    }
    o += "                                    <span class=\"text-[10px] font-bold uppercase px-2 py-0.5 rounded\" style=\"color:";
    o += e(cat.color);
    o += ";background:";
    o += e(cat.color);
    o += "22\">";
    o += e(cat.label);
    o += "</span>\n                                    ";
    if (u.discord_message_id !== '') {
      o += "<span class=\"text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-[#5865F2]/20 text-[#8b93ff] flex items-center gap-1\"><i class='bx bxl-discord-alt'></i> On Discord</span>";
    }
    o += "                                </div>\n                                <p class=\"mt-1.5 text-white font-medium truncate\">";
    o += e(u.title);
    o += "</p>\n                                <p class=\"text-xs text-gray-500 mt-0.5\">";
    o += e(fmt(u.published_at));
    o += u.version !== '' ? ' · v' + e(phpLtrim(u.version, 'vV')) : '';
    o += "</p>\n                            </div>\n                            <div class=\"flex flex-wrap gap-2 shrink-0\">\n                                <a href=\"/admin?edit_update=";
    o += u.id;
    o += "#updates\" class=\"";
    o += btn;
    o += "\"><i class='bx bx-edit-alt'></i> Edit</a>\n                                ";
    if (u.is_published) {
      o += "<a href=\"/updates/";
      o += u.id;
      o += "\" target=\"_blank\" rel=\"noopener\" class=\"";
      o += btn;
      o += "\"><i class='bx bx-show'></i> View</a>";
    }
    o += "                                <form action=\"/admin\" method=\"POST\" class=\"m-0\">";
    o += csrf;
    o += "<input type=\"hidden\" name=\"oys_action\" value=\"update_publish\"><input type=\"hidden\" name=\"id\" value=\"";
    o += u.id;
    o += "\"><input type=\"hidden\" name=\"state\" value=\"";
    o += u.is_published ? '' : '1';
    o += "\">\n                                    <button type=\"submit\" class=\"";
    o += btn;
    o += "\"><i class='bx ";
    o += u.is_published ? 'bx-hide' : 'bx-send';
    o += "'></i> ";
    o += u.is_published ? 'Unpublish' : 'Publish';
    o += "</button></form>\n                                ";
    if (u.is_published && discordReady && u.discord_message_id === '') {
      o += "                                <form action=\"/admin\" method=\"POST\" class=\"m-0\">";
      o += csrf;
      o += "<input type=\"hidden\" name=\"oys_action\" value=\"update_discord\"><input type=\"hidden\" name=\"id\" value=\"";
      o += u.id;
      o += "\">\n                                    <button type=\"submit\" class=\"";
      o += btn;
      o += " text-[#8b93ff]\"><i class='bx bxl-discord-alt'></i> Post to Discord</button></form>\n                                ";
    } else if (!u.is_published && u.discord_message_id !== '') {
      o += "                                <form action=\"/admin\" method=\"POST\" class=\"m-0\">";
      o += csrf;
      o += "<input type=\"hidden\" name=\"oys_action\" value=\"update_discord_remove\"><input type=\"hidden\" name=\"id\" value=\"";
      o += u.id;
      o += "\">\n                                    <button type=\"submit\" class=\"";
      o += btn;
      o += " text-[#8b93ff]\"><i class='bx bxl-discord-alt'></i> Remove from Discord</button></form>\n                                ";
    }
    o += "                                <form action=\"/admin\" method=\"POST\" class=\"m-0\" onsubmit=\"return confirm('Delete this update";
    o += u.discord_message_id !== '' ? ' and its Discord post' : '';
    o += "?');\">";
    o += csrf;
    o += "<input type=\"hidden\" name=\"oys_action\" value=\"update_delete\"><input type=\"hidden\" name=\"id\" value=\"";
    o += u.id;
    o += "\">\n                                    <button type=\"submit\" class=\"";
    o += btn;
    o += " hover:text-red-400\" title=\"Delete\"><i class='bx bx-trash'></i></button></form>\n                            </div>\n                        </li>\n                        ";
  }
  o += "                    </ul>\n                </div>\n            </div>\n\n            <!-- ===================== Roadmap ===================== -->\n            <div id=\"tab-roadmap\" class=\"admin-tab-content max-w-6xl mx-auto space-y-8 hidden\">\n                <div class=\"bg-card border border-bordercolor rounded-xl shadow-xl p-5 sm:p-6\">\n                    <div class=\"flex flex-wrap items-center justify-between gap-3 mb-6 border-b border-bordercolor pb-4\">\n                        <h2 class=\"text-base font-semibold text-white flex items-center gap-2\"><i class='bx bx-map-alt text-xl text-amber-400'></i> ";
  o += editMilestone ? 'Edit milestone' : 'Add a milestone';
  o += "</h2>\n                        <a href=\"/roadmap\" target=\"_blank\" rel=\"noopener\" class=\"text-sm text-gray-400 hover:text-white flex items-center gap-1 py-2\">View roadmap <i class='bx bx-link-external'></i></a>\n                    </div>\n                    <form action=\"/admin\" method=\"POST\" class=\"space-y-5\">\n                        ";
  o += csrf;
  o += "                        <input type=\"hidden\" name=\"oys_action\" value=\"milestone_save\">\n                        <input type=\"hidden\" name=\"id\" value=\"";
  o += mf.id;
  o += "\">\n                        <div class=\"grid grid-cols-1 sm:grid-cols-[1fr_180px_160px] gap-4\">\n                            <div>\n                                <label class=\"";
  o += lbl;
  o += "\" for=\"mTitle\">Title</label>\n                                <input id=\"mTitle\" type=\"text\" name=\"title\" required maxlength=\"160\" value=\"";
  o += e(mf.title);
  o += "\" placeholder=\"e.g. Custom domains\" class=\"";
  o += inp;
  o += "\">\n                            </div>\n                            <div>\n                                <label class=\"";
  o += lbl;
  o += "\" for=\"mStatus\">Status</label>\n                                <select id=\"mStatus\" name=\"status\" class=\"";
  o += inp;
  o += "\">\n                                    ";
  for (const [key, st] of Object.entries(MILESTONE_STATUSES)) {
    o += "                                    <option value=\"";
    o += e(key);
    o += "\"";
    o += mf.status === key ? ' selected' : '';
    o += ">";
    o += e(st.label);
    o += "</option>\n                                    ";
  }
  o += "                                </select>\n                            </div>\n                            <div>\n                                <label class=\"";
  o += lbl;
  o += "\" for=\"mTarget\">Target <span class=\"text-gray-500 font-normal\">(rough)</span></label>\n                                <input id=\"mTarget\" type=\"text\" name=\"target\" maxlength=\"40\" value=\"";
  o += e(mf.target);
  o += "\" placeholder=\"e.g. Q1 2027\" class=\"";
  o += inp;
  o += "\">\n                            </div>\n                        </div>\n                        <div>\n                            <label class=\"";
  o += lbl;
  o += "\" for=\"mDesc\">Description <span class=\"text-gray-500 font-normal\">(optional)</span></label>\n                            <textarea id=\"mDesc\" name=\"description\" rows=\"3\" maxlength=\"4000\" placeholder=\"What is it and why does it matter?\" class=\"";
  o += inp;
  o += "\">";
  o += e(mf.description);
  o += "</textarea>\n                        </div>\n                        <div>\n                            <label class=\"";
  o += lbl;
  o += "\" for=\"mTasks\">";
  o += editMilestone ? 'Add tasks' : 'Tasks';
  o += " <span class=\"text-gray-500 font-normal\">(one per line – the progress bar is based on these)</span></label>\n                            <textarea id=\"mTasks\" name=\"tasks\" rows=\"4\" placeholder=\"Design the settings page&#10;Connect the DNS check&#10;[x] Write the docs\" class=\"";
  o += inp;
  o += " font-mono\"></textarea>\n                        </div>\n                        <div class=\"flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4\">\n                            <label class=\"flex items-center gap-2 text-sm text-gray-300 cursor-pointer\"><input type=\"checkbox\" name=\"is_public\" value=\"1\" class=\"accent-brand-500\"";
  o += mf.is_public ? ' checked' : '';
  o += "> Show on the public roadmap</label>\n                            <div class=\"flex gap-3 justify-end\">\n                                ";
  if (editMilestone) {
    o += "<a href=\"/admin#roadmap\" class=\"px-4 py-2.5 rounded-lg text-sm font-medium text-gray-400 hover:bg-white/5\">Cancel</a>";
  }
  o += "                                <button type=\"submit\" class=\"bg-white text-black hover:bg-gray-200 font-bold py-2.5 px-6 rounded-lg transition-all flex items-center gap-2\"><i class='bx bx-save'></i> ";
  o += editMilestone ? 'Save changes' : 'Add milestone';
  o += "</button>\n                            </div>\n                        </div>\n                    </form>\n                </div>\n\n                <div class=\"grid gap-6 lg:grid-cols-2 xl:grid-cols-4\">\n                    ";
  for (const [status, st] of Object.entries(MILESTONE_STATUSES)) {
    o += "                    <div class=\"min-w-0\">\n                        <div class=\"flex items-center gap-2 mb-3\">\n                            <span class=\"w-2.5 h-2.5 rounded-full\" style=\"background:";
    o += e(st.color);
    o += "\"></span>\n                            <h3 class=\"text-sm font-semibold text-white uppercase tracking-wider\">";
    o += e(st.label);
    o += "</h3>\n                            <span class=\"text-xs text-gray-500\">";
    o += byStatus[status].length;
    o += "</span>\n                        </div>\n                        <div class=\"space-y-4\">\n                            ";
    if (!byStatus[status].length) {
      o += "<div class=\"rounded-xl border border-dashed border-bordercolor p-4 text-xs text-gray-500\">Empty</div>";
    }
    o += "                            ";
    for (const [i, m] of byStatus[status].entries()) {
      const p = m.progress;
      o += "                            <div class=\"bg-card border border-bordercolor rounded-xl p-4\">\n                                <div class=\"flex items-start justify-between gap-2\">\n                                    <p class=\"font-semibold text-white leading-snug min-w-0\">";
      o += e(m.title);
      o += "</p>\n                                    ";
      if (!m.is_public) {
        o += "<span class=\"shrink-0 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-white/10 text-gray-400\" title=\"Not shown on /updates\">Hidden</span>";
      }
      o += "                                </div>\n                                ";
      if (m.target !== '') {
        o += "<p class=\"text-xs text-gray-500 mt-1\">Target: ";
        o += e(m.target);
        o += "</p>";
      }
      o += "                                ";
      if (p) {
        o += "                                <div class=\"mt-3\">\n                                    <div class=\"flex justify-between text-[11px] text-gray-400 mb-1\"><span>";
        o += p.done;
        o += "/";
        o += p.total;
        o += " tasks</span><span>";
        o += p.percent;
        o += "%</span></div>\n                                    <div class=\"h-1.5 rounded-full bg-white/10 overflow-hidden\"><div class=\"h-full rounded-full\" style=\"width:";
        o += p.percent;
        o += "%;background:";
        o += e(st.color);
        o += "\"></div></div>\n                                </div>\n                                ";
      }
      o += "                                ";
      if (m.tasks.length) {
        o += "                                <ul class=\"mt-3 space-y-1\">\n                                    ";
        for (const t of m.tasks) {
          o += "                                    <li class=\"flex items-center gap-1.5 text-sm group\">\n                                        <form action=\"/admin\" method=\"POST\" class=\"m-0 min-w-0 flex-1\">";
          o += csrf;
          o += "<input type=\"hidden\" name=\"oys_action\" value=\"task_toggle\"><input type=\"hidden\" name=\"id\" value=\"";
          o += t.id;
          o += "\">\n                                            <button type=\"submit\" class=\"flex items-start gap-2 text-left w-full py-1.5 ";
          o += t.is_done ? 'text-gray-500' : 'text-gray-200';
          o += "\"><i class='bx ";
          o += t.is_done ? 'bx-checkbox-checked text-emerald-400' : 'bx-checkbox text-gray-500';
          o += " text-xl leading-none shrink-0'></i><span class=\"";
          o += t.is_done ? 'line-through' : '';
          o += " min-w-0 break-words\">";
          o += e(t.title);
          o += "</span></button></form>\n                                        <form action=\"/admin\" method=\"POST\" class=\"m-0\" onsubmit=\"return confirm('Remove this task?');\">";
          o += csrf;
          o += "<input type=\"hidden\" name=\"oys_action\" value=\"task_delete\"><input type=\"hidden\" name=\"id\" value=\"";
          o += t.id;
          o += "\">\n                                            <button type=\"submit\" class=\"w-8 h-8 inline-flex items-center justify-center text-gray-600 hover:text-red-400\" title=\"Remove task\"><i class='bx bx-x'></i></button></form>\n                                    </li>\n                                    ";
        }
        o += "                                </ul>\n                                ";
      }
      o += "                                <form action=\"/admin\" method=\"POST\" class=\"m-0 mt-2 flex gap-2\">";
      o += csrf;
      o += "<input type=\"hidden\" name=\"oys_action\" value=\"task_add\"><input type=\"hidden\" name=\"id\" value=\"";
      o += m.id;
      o += "\">\n                                    <input type=\"text\" name=\"title\" maxlength=\"200\" placeholder=\"Add a task…\" class=\"min-w-0 flex-1 bg-inputbg border border-bordercolor rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:ring-1 focus:ring-brand-500\">\n                                    <button type=\"submit\" class=\"px-2.5 rounded-lg border border-bordercolor text-gray-300 hover:text-white hover:bg-white/5\" title=\"Add task\"><i class='bx bx-plus'></i></button></form>\n                                <div class=\"mt-3 pt-3 border-t border-bordercolor flex flex-wrap items-center gap-2\">\n                                    <form action=\"/admin\" method=\"POST\" class=\"m-0\">";
      o += csrf;
      o += "<input type=\"hidden\" name=\"oys_action\" value=\"milestone_status\"><input type=\"hidden\" name=\"id\" value=\"";
      o += m.id;
      o += "\">\n                                        <select name=\"status\" onchange=\"this.form.submit()\" aria-label=\"Status\" class=\"bg-inputbg border border-bordercolor rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none\">\n                                            ";
      for (const [key, s2] of Object.entries(MILESTONE_STATUSES)) {
        o += "<option value=\"";
        o += e(key);
        o += "\"";
        o += key === status ? ' selected' : '';
        o += ">";
        o += e(s2.label);
        o += "</option>";
      }
      o += "                                        </select></form>\n                                    ";
      if (status !== 'done') {
        o += "                                    <form action=\"/admin\" method=\"POST\" class=\"m-0\">";
        o += csrf;
        o += "<input type=\"hidden\" name=\"oys_action\" value=\"milestone_move\"><input type=\"hidden\" name=\"id\" value=\"";
        o += m.id;
        o += "\"><input type=\"hidden\" name=\"dir\" value=\"up\">\n                                        <button type=\"submit\" class=\"w-9 h-9 inline-flex items-center justify-center rounded-lg hover:bg-white/5 text-gray-400 hover:text-white disabled:opacity-30\" title=\"Move up\"";
        o += i === 0 ? ' disabled' : '';
        o += "><i class='bx bx-up-arrow-alt'></i></button></form>\n                                    <form action=\"/admin\" method=\"POST\" class=\"m-0\">";
        o += csrf;
        o += "<input type=\"hidden\" name=\"oys_action\" value=\"milestone_move\"><input type=\"hidden\" name=\"id\" value=\"";
        o += m.id;
        o += "\"><input type=\"hidden\" name=\"dir\" value=\"down\">\n                                        <button type=\"submit\" class=\"w-9 h-9 inline-flex items-center justify-center rounded-lg hover:bg-white/5 text-gray-400 hover:text-white disabled:opacity-30\" title=\"Move down\"";
        o += i === byStatus[status].length - 1 ? ' disabled' : '';
        o += "><i class='bx bx-down-arrow-alt'></i></button></form>\n                                    ";
      }
      o += "                                    <a href=\"/admin?edit_milestone=";
      o += m.id;
      o += "#roadmap\" class=\"w-9 h-9 inline-flex items-center justify-center rounded-lg hover:bg-white/5 text-gray-400 hover:text-white\" title=\"Edit\"><i class='bx bx-edit-alt'></i></a>\n                                    <a href=\"/admin?new_update_for=";
      o += m.id;
      o += "#updates\" class=\"w-9 h-9 inline-flex items-center justify-center rounded-lg hover:bg-white/5 text-gray-400 hover:text-white\" title=\"Write an update about it\"><i class='bx bx-news'></i></a>\n                                    <form action=\"/admin\" method=\"POST\" class=\"m-0 ml-auto\" onsubmit=\"return confirm('Delete this milestone and its tasks?');\">";
      o += csrf;
      o += "<input type=\"hidden\" name=\"oys_action\" value=\"milestone_delete\"><input type=\"hidden\" name=\"id\" value=\"";
      o += m.id;
      o += "\">\n                                        <button type=\"submit\" class=\"w-9 h-9 inline-flex items-center justify-center rounded-lg hover:bg-white/5 text-gray-500 hover:text-red-400\" title=\"Delete\"><i class='bx bx-trash'></i></button></form>\n                                </div>\n                            </div>\n                            ";
    }
    o += "                        </div>\n                    </div>\n                    ";
  }
  o += "                </div>\n            </div>\n";
  o += discordTab;
  return o;
}
