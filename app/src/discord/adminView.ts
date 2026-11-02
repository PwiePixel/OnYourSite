// Admin → Discord: Status, der installierte Bot, ein eigenes Formular je Ziel (Bot, Webhook, alter Bot-Token,
// Vorgaben) und die Karte „Discord posts“. Kein Passwortfeld und keine Feldnamen, die ein Browser mit Anmeldedaten füllt
// (username, email …); der gespeicherte Webhook-Link steht nie im HTML, das Eingabefeld erscheint erst mit
// „Replace link“. Was sich ohne Neuladen ändert (Chips, Prüfung durch den Bot, Test), lädt ein kleines Skript über
// /admin/api/discord-status nach – nur solange etwas unterwegs ist.
import type { Ctx } from '../web/ctx.js';
import { ROOT_DIR } from '../config.js';
import { q, value } from '../db.js';
import { e } from '../html.js';
import { date, intval, phpStr, strtotime, time } from '../php.js';
import { BOT_KEEP, WEBHOOK_KEEP } from './admin.js';
import { activeDestination, activeWebhook, discordSettings, displayNameProblem, tokenUsable, type DiscordSettings } from './settings.js';
import { maskedWebhook, parseWebhookLink } from './webhook.js';
import { confirmAttrs as uiConfirmAttrs, confirmField as uiConfirmField } from '../views/partials/ui.js';
import { botStatus, type BotReport } from './botReport.js';
import { botCard, botOnThisServer, parseBotTest, placeOf, type BotCard, type Tone } from './botCard.js';
import { rowFrom, type PostRow } from './posts.js';
import { chipActionsHtml, chipHtml, chipOf, openJobsOf, type Chip } from './chips.js';
import { failingJobs, type FailingJob } from './jobs.js';

// Eine Zeile der Karte „Discord posts“
export interface PostListItem { chip: Chip; title: string; where: string; at: string }

export interface DiscordTabData {
  csrf: string;
  s: DiscordSettings;
  card: BotCard;
  report: BotReport | null;
  installed: boolean;
  codeDir: string;
  onThisServer: boolean;
  errorField: string;
  keep: Record<string, string> | null;
  botKeep: Record<string, string> | null;
  replaceLink: boolean;
  posts: PostListItem[];
  jobs: FailingJob[];
}

// Wo ein Beitrag steht: Bot mit Kanal (aus dem Bericht), Webhook oder alter Token
export function whereOf(row: PostRow, rep: BotReport | null): string {
  if (row.via === 'webhook') return 'Webhook';
  if (row.via === 'token') return 'Old bot token';
  const place = placeOf(rep, row.channel_id ?? '');
  if (place) return 'Bot #' + place.name;
  return row.kind === 'forum_post' ? 'Bot (forum post)' : 'Bot';
}

// Karte „Discord posts“: alles, was nicht gepostet ist oder einen Fehler hat, dazu die letzten 10 geposteten
export async function postList(rep: BotReport | null, botInstalled: boolean): Promise<PostListItem[]> {
  const cols = 'p.*, u.title AS u_title, u.version AS u_version';
  const problems = await q(`SELECT ${cols} FROM update_discord_posts p LEFT JOIN updates u ON u.id = p.update_id
    WHERE p.state <> 'posted' OR (p.error IS NOT NULL AND p.error <> '') ORDER BY p.updated_at DESC, p.id DESC LIMIT 50`);
  const recent = await q(`SELECT ${cols} FROM update_discord_posts p LEFT JOIN updates u ON u.id = p.update_id
    WHERE p.state = 'posted' AND (p.error IS NULL OR p.error = '') ORDER BY p.updated_at DESC, p.id DESC LIMIT 10`);
  const all = [...problems, ...recent];
  const rows = all.map(rowFrom);
  const jobs = await openJobsOf(rows.map((r) => r.id));
  const now = time();
  return all.map((r, i) => {
    const row = rows[i];
    const title = r.u_title === null || r.u_title === undefined ? `(deleted update #${row.update_id})`
      : (phpStr(r.u_version) !== '' ? phpStr(r.u_version) + ' – ' : '') + phpStr(r.u_title);
    return { chip: chipOf(row, jobs.get(row.id), botInstalled, now), title, where: whereOf(row, rep), at: row.updated_at };
  });
}

// Bot-Beiträge, die in Discord stehen (für „Turned off“)
async function botPostCount(): Promise<number> {
  return intval(await value("SELECT COUNT(*) FROM update_discord_posts WHERE via = 'bot' AND state IN ('posted', 'remove_failed')"));
}

// Das Modell der Bot-Karte mit allem, was es braucht (auch für /admin/api/discord-status)
export async function loadBotCard(s?: DiscordSettings): Promise<{ card: BotCard; report: BotReport | null; installed: boolean; onThisServer: boolean; lastSeen: number | null }> {
  const settings = s ?? await discordSettings();
  const st = await botStatus();
  const onThisServer = botOnThisServer();
  const card = botCard({
    s: settings, report: st.report, installed: st.installed, lastSeen: st.lastSeen, now: time(), onThisServer,
    test: parseBotTest(await value("SELECT meta_value FROM oys_meta WHERE meta_key = 'discord_bot_test'")), botPosts: await botPostCount(),
  });
  return { card, report: st.report, installed: st.installed, onThisServer, lastSeen: st.lastSeen };
}

function keptValues(raw: unknown, keys: readonly string[]): Record<string, string> | null {
  if (!raw || typeof raw !== 'object') return null;
  const out: Record<string, string> = {};
  for (const k of keys) if (typeof (raw as Record<string, unknown>)[k] === 'string') out[k] = (raw as Record<string, string>)[k];
  return out;
}

export async function discordTabData(ctx: Ctx, csrf: string): Promise<DiscordTabData> {
  const session = ctx.session;
  const field = session?.take<string>('discord_error_field');
  const keep = session?.take<Record<string, unknown>>('discord_keep');
  const botKeep = session?.take<Record<string, unknown>>('discord_bot_keep');
  const s = await discordSettings();
  const { card, report, installed, onThisServer } = await loadBotCard(s);
  return {
    csrf,
    s,
    card,
    report,
    installed,
    codeDir: ROOT_DIR,
    onThisServer,
    errorField: typeof field === 'string' ? field : '',
    keep: keptValues(keep, WEBHOOK_KEEP),
    botKeep: keptValues(botKeep, BOT_KEEP),
    replaceLink: ctx.get.replace_webhook !== undefined,
    posts: await postList(report, installed),
    jobs: await failingJobs(),
  };
}

const card = 'bg-card border border-bordercolor rounded-xl shadow-xl p-5 sm:p-6';
const inp = 'w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm';
const lbl = 'block text-sm font-medium text-gray-300 mb-1.5';
const btn = 'inline-flex items-center gap-1.5 px-3 py-2 min-h-[36px] rounded-lg text-xs font-medium border border-bordercolor text-gray-300 hover:text-white hover:bg-white/5 transition-colors';
const primary = 'bg-white text-black hover:bg-gray-200 font-bold py-2.5 px-6 rounded-lg transition-all flex items-center gap-2';
const radioCard = 'flex gap-3 p-4 rounded-xl border border-bordercolor cursor-pointer has-[:checked]:border-[#5865F2] has-[:checked]:bg-[#5865F2]/10';
const badge = (tone: 'green' | 'amber' | 'gray', text: string): string => {
  const cls = tone === 'green' ? 'bg-emerald-500/15 text-emerald-400' : tone === 'amber' ? 'bg-amber-500/15 text-amber-400' : 'bg-white/10 text-gray-400';
  return `<span class="text-[10px] font-bold uppercase px-2 py-0.5 rounded ${cls}">${e(text)}</span>`;
};
// Ton einer Zeile (Bereit, Problem, Prüfung, Test) → Textfarbe
export const TONE_TEXT: Record<Tone, string> = { ok: 'text-emerald-400', warn: 'text-amber-400', err: 'text-red-400', muted: 'text-gray-400' };
const BADGE_TONE: Record<Tone, 'green' | 'amber' | 'gray'> = { ok: 'green', warn: 'amber', err: 'amber', muted: 'gray' };
const when = (dt: string): string => {
  const t = strtotime(dt);
  return t === false ? '' : date('M j, Y H:i', t);
};
// Bestätigung: Attribute für den Dialog und das Feld, das erst nach dem Bestätigen 1 ist (ohne Bestätigung ändert
// der Server nichts)
// Bestätigungen über die Dialog-Bibliothek der Seite (views/partials/ui.ts) – derselbe Server-Schutz wie überall im Admin
const confirmAttrs = (title: string, text: string, okLabel: string, tone: 'warn' | 'danger'): string =>
  uiConfirmAttrs({ title, text, ok: okLabel, tone });
const confirmField = uiConfirmField();

export function discordTabView(d: DiscordTabData): string {
  const { csrf, s, card: bc } = d;
  const active = activeDestination(s);
  const w = s.webhook;
  const hook = parseWebhookLink(w.url);
  const err = (name: string): string => (d.errorField === name ? ' ring-1 ring-red-500' : '');
  const kept = (name: string, fallback: string): string => (d.keep && d.keep[name] !== undefined ? d.keep[name] : fallback);
  const where = w.post_in === 'forum' ? 'a new forum post for each update' : w.post_in === 'thread' ? 'thread ' + w.thread_id : 'the channel';
  const checked = w.checked_at !== '' && w.check_error === '';
  const target = bc.target;

  // Kopf: wohin Updates gerade gehen (alle eingeschalteten Ziele)
  const parts: string[] = [];
  if (target) parts.push('the bot' + (target.name !== '' ? ' in #' + target.name : ''));
  if (activeWebhook(s) && hook) parts.push('the webhook' + (w.hook_name !== '' ? ' “' + w.hook_name + '”' : ''));
  if (tokenUsable(s)) parts.push('the old bot token');
  let title = 'Discord isn’t connected yet';
  let subline = d.installed ? 'Choose a channel for the bot below, or paste a webhook link.' : 'Paste a webhook link below.';
  if (parts.length) title = 'Posting with ' + (parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1] : parts[0]);
  if (active === 'webhook' && hook) subline = maskedWebhook(hook) + ' · into ' + where + ' · ' + (checked ? 'checked ' + when(w.checked_at) : 'not checked yet');
  else if (target) subline = 'The bot that runs on your server posts new updates – no token needed here.';
  else if (active === 'token') subline = 'Channel ' + s.channel_id;
  const hookBadge = !hook ? badge('gray', 'Off') : active !== 'webhook' ? badge('gray', 'Not in use') : checked ? badge('green', 'Checked') : badge('amber', 'Not verified');
  const botNote = !d.installed ? '' : bc.state === 'off' ? 'turned off' : target ? 'posts new updates' + (target.name !== '' ? ' in #' + target.name : '') : bc.canPost ? 'can post updates' : 'doesn’t post updates yet';
  const botBadge = badge(BADGE_TONE[bc.badge.tone], bc.badge.text).replace('<span ', '<span data-bot-badge ');

  let o = `
            <!-- ===================== Discord ===================== -->
            <div id="tab-discord" class="admin-tab-content max-w-4xl mx-auto space-y-8 hidden">
                <div class="${card}">
                    <div class="flex flex-col sm:flex-row sm:items-center gap-4">
                        <span class="w-12 h-12 rounded-xl flex items-center justify-center shrink-0 ${parts.length ? 'bg-[#5865F2]/20 text-[#8b93ff]' : 'bg-white/5 text-gray-500'}"><i class='bx bxl-discord-alt text-3xl'></i></span>
                        <div class="flex-1 min-w-0">
                            <p class="text-white font-semibold">${e(title)}</p>
                            <p class="text-sm text-gray-400 truncate">${e(subline)}</p>
                        </div>
                    </div>
                    <div class="mt-5 pt-4 border-t border-bordercolor flex flex-wrap gap-x-6 gap-y-2 text-sm">
                        <span class="flex items-center gap-2"><i class='bx bx-bot text-lg text-gray-400'></i><span class="text-gray-300">Bot</span> ${botBadge}${botNote !== '' ? ' <span class="text-xs text-gray-500">' + e(botNote) + '</span>' : ''}</span>
                        <span class="flex items-center gap-2"><i class='bx bx-link text-lg text-gray-400'></i><span class="text-gray-300">Webhook</span> ${hookBadge}</span>
${s.bot_token !== '' ? `                        <span class="flex items-center gap-2"><i class='bx bx-key text-lg text-gray-400'></i><span class="text-gray-300">Old bot token</span> ${badge(active === 'token' ? 'amber' : 'gray', active === 'token' ? 'In use' : 'Not in use')}</span>\n` : ''}                    </div>
                </div>
`;
  if (s.auto_post && parts.length === 0) {
    o += `                <div class="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-300">Updates aren’t announced on Discord right now – no destination is on.</div>\n`;
  }
  o += jobsBanner(d);
  o += botCardHtml(d);
  o += tokenCardHtml(d);

  // Webhook
  const postIn = kept('post_in', w.post_in);
  // Ein gespeicherter Name, den Discord ablehnt, wird nicht gesendet (webhookName) – das Feld sagt warum
  const storedNameProblem = d.keep === null ? displayNameProblem(w.display_name) : null;
  const nameRing = d.errorField === 'display_name' || storedNameProblem !== null ? ' ring-1 ring-red-500' : '';
  const showInput = !hook || d.replaceLink || d.errorField === 'webhook_link';
  const linkInput = `<label class="${lbl}" for="dLink">Webhook link</label>
                                <input id="dLink" type="text" name="webhook_link" inputmode="url" spellcheck="false" autocapitalize="off" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore placeholder="https://discord.com/api/webhooks/…" class="${inp}${err('webhook_link')}">`;
  const radio = (value: string, name: string, help: string): string => `                                <label class="${radioCard}">
                                    <input type="radio" name="post_in" value="${value}" class="mt-1 accent-[#5865F2]"${postIn === value ? ' checked' : ''}>
                                    <span><span class="block text-white font-medium text-sm">${e(name)}</span><span class="block text-xs text-gray-400 mt-0.5">${e(help)}</span></span>
                                </label>
`;
  o += `                <div class="${card}">
                    <h2 class="text-base font-semibold text-white mb-1 flex items-center gap-2"><i class='bx bx-link text-xl text-[#8b93ff]'></i> Post with a webhook</h2>
                    <p class="text-sm text-gray-500 mb-5">Optional – e.g. for a second server. A webhook posts updates into one channel, forum or thread without the bot.</p>
                    <form action="/admin" method="POST" id="discordWebhookForm" autocomplete="off" class="space-y-5">
                        ${csrf}
                        <input type="hidden" name="oys_action" value="discord_webhook_save">
`;
  if (hook) {
    const line = 'Webhook' + (w.hook_name !== '' ? ' “' + w.hook_name + '”' : '') + ' · ' + maskedWebhook(hook) + (checked ? ' · checked ' + when(w.checked_at) : '');
    o += `                        <div class="rounded-xl border border-bordercolor bg-white/[.02] p-4 text-sm space-y-1">
                            <p class="text-gray-200 break-all">${e(line)}</p>
${active !== 'webhook' ? `                            <p class="text-xs text-gray-500">Saved, but not in use${active === 'token' ? ' – updates are posted with the old bot token. Save here to post with the webhook instead.' : '. Save to check it and post with it.'}</p>\n` : ''}${w.check_error !== '' ? `                            <p class="text-xs text-amber-400">Not checked: ${e(w.check_error)}</p>\n` : ''}                        </div>
                        <div id="discordLinkSlot">
`;
    o += showInput
      ? `                                ${linkInput}\n`
      : `                                <a href="/admin?replace_webhook=1#discord" data-replace-link class="${btn}"><i class='bx bx-edit'></i> Replace link</a>\n`;
    o += `                        </div>
`;
  } else {
    o += `                        <div>
                                ${linkInput}
                        </div>
`;
  }
  o += `                        <fieldset>
                            <legend class="${lbl}">Where to post</legend>
                            <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
${radio('channel', 'In the channel', 'Each update is a message in the webhook’s channel.')}${radio('forum', 'As a new forum post for each update', 'For a forum channel: each update gets its own post.')}${radio('thread', 'In a thread', 'All updates go into one thread.')}                            </div>
                            <p data-show-for="forum thread" class="text-xs text-gray-500 mt-2${postIn === 'channel' ? ' hidden' : ''}">A webhook can’t rename or delete forum posts or threads: edits keep the first title, and unpublishing removes the message but leaves an empty post.</p>
                            <div data-show-for="thread" class="mt-4${postIn === 'thread' ? '' : ' hidden'}">
                                <label class="${lbl}" for="dThread">Thread ID</label>
                                <input id="dThread" type="text" name="thread_id" inputmode="numeric" autocomplete="off" maxlength="25" value="${e(kept('thread_id', w.thread_id))}" placeholder="e.g. 1234567890123456789" class="${inp}${err('thread_id')}">
                                <p class="text-xs text-gray-500 mt-1.5">In Discord turn on Developer Mode, right-click the thread → Copy Thread ID.${w.post_in === 'thread' && w.thread_id !== '' && !w.thread_verified ? ' <span class="text-amber-400">Thread not verified yet – it is checked with the first post into it.</span>' : ''}</p>
                            </div>
                        </fieldset>
                        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            <div>
                                <label class="${lbl}" for="dDisplayName">Display name <span class="text-gray-500 font-normal">(optional)</span></label>
                                <input id="dDisplayName" type="text" name="display_name" maxlength="80" autocomplete="off" data-1p-ignore data-lpignore="true" value="${e(kept('display_name', w.display_name))}" placeholder="OnYourSite Updates" class="${inp}${nameRing}">
                                <p class="text-xs text-gray-500 mt-1.5">Up to 80 characters, without @ # : and without the words “discord” or “clyde”.</p>
${storedNameProblem !== null ? `                                <p class="text-xs text-amber-400 mt-1">${e(storedNameProblem + ' It isn’t sent until you change it.')}</p>\n` : ''}                            </div>
                            <div>
                                <label class="${lbl}" for="dAvatar">Avatar image link <span class="text-gray-500 font-normal">(optional)</span></label>
                                <input id="dAvatar" type="text" name="avatar_url" inputmode="url" autocomplete="off" value="${e(kept('avatar_url', w.avatar_url))}" placeholder="https://…/logo.png" class="${inp}${err('avatar_url')}">
                            </div>
                            <div>
                                <label class="${lbl}" for="dMention">Ping <span class="text-gray-500 font-normal">(optional)</span></label>
                                <input id="dMention" type="text" name="mention" maxlength="30" autocomplete="off" value="${e(kept('mention', w.mention))}" placeholder="Role ID, “everyone” or “here”" class="${inp}${err('mention')}">
                                <p class="text-xs text-gray-500 mt-1.5">Who gets notified when an update is posted. Empty = nobody is pinged.</p>
                            </div>
                        </div>
                        <div class="flex flex-wrap items-center justify-end gap-2">
`;
  if (hook) {
    const firstForumTest = w.post_in === 'forum' && w.test_thread_id === '';
    o += `                            <button type="submit" form="discordWebhookTestForm" class="${btn}"${firstForumTest ? confirmAttrs('Send a test?', 'In a forum channel this creates a post “OnYourSite test”; later tests go into that post.', 'Send test', 'warn') : ''}><i class='bx bx-paper-plane'></i> Send test</button>
                            <button type="submit" form="discordWebhookRemoveForm" class="${btn} hover:text-red-400"${confirmAttrs('Remove the webhook?', 'Its earlier posts stay in Discord and can’t be edited from here any more.', 'Remove', 'danger')}><i class='bx bx-unlink'></i> Remove</button>
`;
  }
  o += `                            <button type="submit" class="${primary}"><i class='bx bx-save'></i> Save</button>
                        </div>
                    </form>
`;
  if (hook) {
    // Das Bestätigungsfeld nur, wenn gefragt wird (sonst lehnte die zentrale Prüfung den Test ohne Dialog ab)
    const firstForumTest = w.post_in === 'forum' && w.test_thread_id === '';
    o += `                    <form action="/admin" method="POST" id="discordWebhookTestForm" class="hidden">${csrf}<input type="hidden" name="oys_action" value="discord_webhook_test">${firstForumTest ? confirmField : ''}</form>
                    <form action="/admin" method="POST" id="discordWebhookRemoveForm" class="hidden">${csrf}<input type="hidden" name="oys_action" value="discord_webhook_remove">${confirmField}</form>
`;
  }
  o += `                </div>
`;

  // Vorgaben
  o += `                <div class="${card}">
                    <h2 class="text-base font-semibold text-white mb-5 flex items-center gap-2"><i class='bx bx-cog text-xl text-[#8b93ff]'></i> Defaults</h2>
                    <form action="/admin" method="POST" id="discordDefaultsForm" autocomplete="off" class="space-y-5">
                        ${csrf}
                        <input type="hidden" name="oys_action" value="discord_defaults_save">
                        <label class="flex items-center gap-2 text-sm text-gray-300 cursor-pointer"><input type="checkbox" name="auto_post" value="1" class="accent-[#5865F2]"${s.auto_post ? ' checked' : ''}> Announce new updates on Discord by default</label>
                        <div>
                            <label class="${lbl}" for="dInvite">Invite link for visitors <span class="text-gray-500 font-normal">(optional)</span></label>
                            <input id="dInvite" type="text" name="invite_url" inputmode="url" autocomplete="off" value="${e(s.invite_url)}" placeholder="https://discord.gg/…" class="${inp}${err('invite_url')}">
                            <p class="text-xs text-gray-500 mt-1.5">Used for “Get updates on Discord” on /updates and for “Suggest an idea” and “Join the Discord” on /roadmap.</p>
                        </div>
                        <div class="flex justify-end">
                            <button type="submit" class="${primary}"><i class='bx bx-save'></i> Save</button>
                        </div>
                    </form>
                </div>

`;
  o += postsCardHtml(d);
  o += `                <div class="grid gap-6 md:grid-cols-2">
                    <div class="bg-card border border-bordercolor rounded-xl p-5 text-sm text-gray-400">
                        <h3 class="text-white font-semibold mb-3 flex items-center gap-2"><i class='bx bx-link'></i> Get a webhook link</h3>
                        <ol class="list-decimal pl-5 space-y-1.5">
                            <li>In Discord, open the channel settings (gear icon) of your updates channel.</li>
                            <li><b class="text-gray-300">Integrations → Webhooks → New Webhook</b>.</li>
                            <li>Click <b class="text-gray-300">Copy Webhook URL</b> and paste it above.</li>
                        </ol>
                    </div>
                    <div class="bg-card border border-bordercolor rounded-xl p-5 text-sm text-gray-400">
                        <h3 class="text-white font-semibold mb-3 flex items-center gap-2"><i class='bx bx-bot'></i> Set up the bot</h3>
                        <p>The server installer sets up the bot (welcome, suggestions and support tickets) and its channels. It runs on your server – no token needed here.</p>
                    </div>
                </div>
                <p class="text-xs text-gray-500 text-center">Webhook links are stored encrypted and never shown again.</p>
`;
  if (hook) {
    o += `                <template id="discordLinkInput">${linkInput}</template>\n`;
  }
  o += `                <script>
                (function () {
                    var tab = document.getElementById('tab-discord');
                    var form = document.getElementById('discordWebhookForm');
                    if (!tab || !form) return;
                    // Wo gepostet wird: Thread-Feld und Hinweis nur, wenn sie gebraucht werden – ein verstecktes Feld wird
                    // auch nicht mitgesendet
                    function sync() {
                        var checked = form.querySelector('input[name=post_in]:checked');
                        var v = checked ? checked.value : 'channel';
                        form.querySelectorAll('[data-show-for]').forEach(function (el) {
                            var off = el.getAttribute('data-show-for').split(' ').indexOf(v) < 0;
                            el.classList.toggle('hidden', off);
                            el.querySelectorAll('input').forEach(function (i) { i.disabled = off; });
                        });
                    }
                    form.querySelectorAll('input[name=post_in]').forEach(function (r) { r.addEventListener('change', sync); });
                    // Das Feld für einen neuen Link erst auf Wunsch einsetzen (nichts Gespeichertes steht vorher darin)
                    function linkInput() {
                        var input = form.querySelector('input[name=webhook_link]');
                        var tpl = document.getElementById('discordLinkInput');
                        if (!input && tpl) {
                            document.getElementById('discordLinkSlot').replaceChildren(tpl.content.cloneNode(true));
                            input = form.querySelector('input[name=webhook_link]');
                        }
                        return input;
                    }
                    var replace = tab.querySelector('[data-replace-link]');
                    if (replace) replace.addEventListener('click', function (ev) { ev.preventDefault(); var input = linkInput(); if (input) input.focus(); });
                    // Ein Link mit ?thread_id= meint „in diesen Thread“
                    // Ob es ein Webhook-Link ist, entscheidet beim Speichern der Server – hier genügt die grobe Form
                    var HOOK = /^\\s*https?:\\/\\/\\S+\\/webhooks\\/\\d{5,25}\\/[A-Za-z0-9_-]{20,120}/;
                    function fromLink(text) {
                        var m = /[?&]thread_id=(\\d{15,25})/.exec(text);
                        if (!m) return;
                        form.querySelector('input[name=post_in][value=thread]').checked = true;
                        form.querySelector('input[name=thread_id]').value = m[1];
                        sync();
                    }
                    form.addEventListener('input', function (ev) { if (ev.target.name === 'webhook_link') fromLink(ev.target.value); });
                    // Ein Webhook-Link, der in ein anderes Feld eingefügt wird, gehört in das Webhook-Feld
                    tab.addEventListener('paste', function (ev) {
                        var t = ev.target;
                        if (!t || t.tagName !== 'INPUT' || t.name === 'webhook_link') return;
                        var text = (ev.clipboardData || window.clipboardData).getData('text');
                        if (!HOOK.test(text)) return;
                        ev.preventDefault();
                        var input = linkInput();
                        if (!input) return;
                        input.value = text.trim();
                        fromLink(input.value);
                        input.focus();
                    });
                    sync();
                })();
                </script>
` + PING_SCRIPT + STATUS_SCRIPT + `            </div>
`;
  return o;
}


// ------------------------------------------------------------------ Teile des Reiters

const code = (c: string): string => `<code class="text-white break-all">${e(c)}</code>`;

// Rote Hinweise für Aufträge des Bots mit Fehler (früher im Community-Bereich): Beiträge haben Retry und Forget in der
// Karte „Discord posts“, ein toter Bericht, Test oder Richtlinien-Satz lässt sich ausblenden
function jobsBanner(d: DiscordTabData): string {
  let o = '';
  for (const j of d.jobs) {
    const text = `The bot couldn’t ${j.label} (${j.tries} ${j.tries === 1 ? 'try' : 'tries'}): ${j.error}` + (j.dead ? ' – it stopped trying.' : ' – it tries again.')
      + (j.post ? ' Use Retry or Forget on it under “Discord posts”.' : '');
    o += `                <div class="rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-300 flex flex-col sm:flex-row sm:items-center gap-3" data-bot-job="${j.id}">
                    <span class="flex-1 break-words">${e(text)}</span>
${j.dismissable ? `                    <form action="/admin" method="POST" class="m-0 shrink-0">${d.csrf}<input type="hidden" name="oys_action" value="discord_job_dismiss"><input type="hidden" name="id" value="${j.id}"><button type="submit" class="${btn}"><i class='bx bx-x'></i> Dismiss</button></form>\n` : ''}                </div>
`;
  }
  return o;
}

// Kanäle aus dem Bericht in Gruppen: Ankündigung, Text, Forum, Threads; ohne Zugang gesperrt
function channelOptions(rep: BotReport, chosen: string): string {
  const cats = new Map(rep.categories.map((c) => [c.id, c.name]));
  const byId = new Map(rep.channels.map((c) => [c.id, c]));
  const opt = (id: string, label: string, ok: boolean, everyone: boolean): string =>
    `<option value="${e(id)}" data-everyone="${everyone ? '1' : '0'}"${id === chosen ? ' selected' : ''}${ok ? '' : ' disabled'}>${e(label + (ok ? '' : ' – no access'))}</option>`;
  let o = '';
  const known = byId.has(chosen) || rep.threads.some((t) => t.id === chosen);
  if (!known) o += `<option value="" disabled selected>${e(chosen === '' ? 'Choose a channel…' : 'Channel ' + chosen + ' – no longer listed')}</option>`;
  const groups: Array<[string, string]> = [['announcement', 'Announcement channels'], ['text', 'Text channels'], ['forum', 'Forum channels – each update becomes a new post']];
  for (const [type, label] of groups) {
    const list = rep.channels.filter((c) => c.type === type);
    if (!list.length) continue;
    o += `<optgroup label="${e(label)}">`;
    for (const c of list) {
      const cat = cats.get(c.parent_id);
      o += opt(c.id, '#' + c.name + (cat ? ' (' + cat + ')' : ''), c.can_post, c.can_mention_everyone);
    }
    o += '</optgroup>';
  }
  if (rep.threads.length) {
    o += '<optgroup label="Threads">';
    for (const t of rep.threads) {
      const parent = byId.get(t.parent_id);
      o += opt(t.id, '#' + t.name + (parent ? ' (in #' + parent.name + ')' : ''), t.can_post, parent?.can_mention_everyone ?? false);
    }
    o += '</optgroup>';
  }
  return o;
}

// Wer gepingt wird: niemand, @everyone, @here oder eine Rolle; was der Bot im gewählten Kanal nicht darf, ist gesperrt
const MAY_NOT_PING = ' – the bot may not ping';
function mentionOptions(rep: BotReport, channel: string, mention: string): string {
  const everyone = placeOf(rep, channel)?.can_mention_everyone ?? false;
  const opt = (value: string, label: string, needsEveryone: boolean): string => {
    const blocked = needsEveryone && !everyone;
    return `<option value="${e(value)}" data-label="${e(label)}"${needsEveryone ? ' data-needs-everyone' : ''}${value === mention ? ' selected' : ''}${blocked ? ' disabled' : ''}>${e(label + (blocked ? MAY_NOT_PING : ''))}</option>`;
  };
  let o = opt('', 'Nobody', false) + opt('everyone', '@everyone', true) + opt('here', '@here', true);
  if (mention !== '' && mention !== 'everyone' && mention !== 'here' && !rep.roles.some((r) => r.id === mention)) {
    o += `<option value="" disabled selected>${e('Role ' + mention + ' – no longer exists')}</option>`;
  }
  if (rep.roles.length) {
    o += '<optgroup label="Roles">';
    for (const r of rep.roles) o += opt(r.id, '@' + r.name, !r.mentionable);
    o += '</optgroup>';
  }
  return o;
}

// Karte „Post with the bot“ (discord-pages §3.1/§6.1): Zustand, „Use #updates“, Kanal, Ping, ein/aus, Test, Bericht
function botCardHtml(d: DiscordTabData): string {
  const { csrf, card: bc, report: rep } = d;
  const state = bc.state;
  let o = `                <div id="discordBotCard" class="${card}" data-bot-card data-bot-state="${state}" data-bot-checking="${state === 'checking' ? '1' : '0'}" data-test-state="${e(bc.test?.state ?? '')}">
                    <div class="flex flex-wrap items-center gap-2 mb-3">
                        <h2 class="text-base font-semibold text-white flex items-center gap-2"><i class='bx bx-bot text-xl text-[#8b93ff]'></i> Post with the bot</h2>
                        <span class="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-[#5865F2]/20 text-[#8b93ff]">Recommended</span>
                    </div>
`;
  if (state === 'not_installed') {
    return o + `                    <p class="text-sm text-gray-400">The Discord bot isn’t set up on this server. Run ${code('sudo bash ' + d.codeDir + '/server/install.sh')} and answer y at “Set up the Discord bot on this server too?” – until then you can use a webhook below.</p>
                </div>
`;
  }
  o += `                    <p class="text-sm text-gray-400" data-bot-status>${e(bc.status)}</p>\n`;
  const refreshForm = `                    <form action="/admin" method="POST" id="discordBotRefreshForm" class="hidden">${csrf}<input type="hidden" name="oys_action" value="discord_bot_refresh"></form>\n`;
  const noToken = '                    <p class="text-xs text-gray-500 mt-4">The bot runs on your server with its own login – you never need to enter its token here.</p>\n';
  if (state === 'old' || !rep) {
    const local = 'sudo bash ' + d.codeDir + '/server/install.sh --update';
    o += `                    <p class="text-sm text-amber-400 mt-3" data-bot-line>${e(bc.line?.text ?? '')}</p>\n`;
    o += d.onThisServer
      ? `                    <p class="text-sm text-gray-400 mt-1">Update it: ${code(local)}</p>\n`
      : `                    <p class="text-sm text-gray-400 mt-1">Update it where it runs: get the new code there, then ${code('sudo bash discord-bot/install.sh --update')} in that folder. If it runs on this server: ${code(local)}</p>\n`;
    o += `                    <div class="flex flex-wrap gap-2 mt-4"><button type="submit" form="discordBotRefreshForm" class="${btn}"><i class='bx bx-refresh'></i> Refresh</button></div>\n`;
    return o + refreshForm + noToken + '                </div>\n';
  }
  // „Use #updates“: eigenes Formular mit genau dieser Wahl (der Kanal, den der Bot meldet)
  if (bc.offer) {
    o += `                    <div class="rounded-xl border border-[#5865F2]/40 bg-[#5865F2]/10 p-4 mt-4 flex flex-col sm:flex-row sm:items-center gap-3" data-bot-offer>
                        <p class="text-sm text-white flex-1">The bot is ready to post in #${e(bc.offer.name)}.</p>
                        <form action="/admin" method="POST" class="m-0 shrink-0">${csrf}<input type="hidden" name="oys_action" value="discord_bot_save"><input type="hidden" name="bot_enabled" value="1"><input type="hidden" name="bot_channel" value="${e(bc.offer.channel_id)}"><input type="hidden" name="bot_mention" value="${e(bc.offer.mention)}"><button type="submit" class="${primary}"><i class='bx bx-check'></i> Use #${e(bc.offer.name)}</button></form>
                    </div>
`;
  }
  const keep = d.botKeep;
  const chosen = keep?.bot_channel ?? bc.channelId;
  const mention = keep?.bot_mention ?? bc.mention;
  const enabled = keep ? (keep.bot_enabled ?? '') !== '' : bc.saved ? d.s.bot.enabled : true;
  const errRing = (name: string): string => (d.errorField === name ? ' ring-1 ring-red-500' : '');
  const testPlace = bc.testPlace;
  const showTest = state !== 'off' && testPlace !== null;
  const forum = testPlace?.type === 'forum';
  const line = bc.line;
  o += `                    <form action="/admin" method="POST" id="discordBotForm" autocomplete="off" class="space-y-5 mt-5">
                        ${csrf}
                        <input type="hidden" name="oys_action" value="discord_bot_save">
                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label class="${lbl}" for="dBotChannel">Channel</label>
                                <select id="dBotChannel" name="bot_channel" class="${inp}${errRing('bot_channel')}">${channelOptions(rep, chosen)}</select>
${rep.truncated ? '                                <p class="text-xs text-amber-400 mt-1.5">Some channels aren’t listed – the server has more than the bot can report.</p>\n' : ''}                            </div>
                            <div>
                                <label class="${lbl}" for="dBotMention">Ping</label>
                                <select id="dBotMention" name="bot_mention" class="${inp}${errRing('bot_mention')}">${mentionOptions(rep, chosen, mention)}</select>
                                <p class="text-xs text-gray-500 mt-1.5">Who gets notified when an update is posted. To let the bot ping @everyone, give it “Mention @everyone, @here and All Roles” in this channel’s settings.</p>
                            </div>
                        </div>
                        <label class="flex items-center gap-2 text-sm text-gray-300 cursor-pointer"><input type="checkbox" name="bot_enabled" value="1" class="accent-[#5865F2]"${enabled ? ' checked' : ''}> Announce new updates with the bot</label>
                        <div class="space-y-1">
                            <p class="text-sm ${TONE_TEXT[line?.tone ?? 'muted']}" data-bot-line${line ? '' : ' hidden'}>${e(line?.text ?? '')}</p>
                            <p class="text-sm ${TONE_TEXT[bc.test?.tone ?? 'muted']}" data-bot-test${bc.test ? '' : ' hidden'}>${e(bc.test?.text ?? '')}</p>
                        </div>
                        <div class="flex flex-wrap items-center justify-end gap-2">
${state === 'off' ? `                            <button type="submit" form="discordBotOnForm" class="${btn} text-[#8b93ff]"><i class='bx bx-power-off'></i> Turn on</button>\n` : ''}                            <button type="submit" form="discordBotRefreshForm" class="${btn}"><i class='bx bx-refresh'></i> Refresh list</button>
${showTest ? `                            <button type="submit" form="discordBotTestForm" class="${btn}"${forum ? confirmAttrs('Send a test?', 'In a forum channel each test creates a post “OnYourSite test”.', 'Send test', 'warn') : ''}><i class='bx bx-paper-plane'></i> Send test</button>\n` : ''}                            <button type="submit" class="${primary}"><i class='bx bx-save'></i> Save</button>
                        </div>
                    </form>
` + refreshForm;
  if (showTest) {
    o += `                    <form action="/admin" method="POST" id="discordBotTestForm" class="hidden">${csrf}<input type="hidden" name="oys_action" value="discord_bot_test">${forum ? confirmField : ''}</form>\n`;
  }
  if (state === 'off') {
    o += `                    <form action="/admin" method="POST" id="discordBotOnForm" class="hidden">${csrf}<input type="hidden" name="oys_action" value="discord_bot_save"><input type="hidden" name="bot_enabled" value="1"><input type="hidden" name="bot_channel" value="${e(d.s.bot.channel_id)}"><input type="hidden" name="bot_mention" value="${e(d.s.bot.mention)}"></form>\n`;
  }
  return o + noToken + '                </div>\n';
}

// Karte „Old bot token“: nur solange einer gespeichert ist – testen und löschen, nie ein neuer
function tokenCardHtml(d: DiscordTabData): string {
  const { s, csrf } = d;
  if (s.bot_token === '') return '';
  const place = placeOf(d.report, s.channel_id);
  const where = place ? '#' + place.name : 'channel ' + s.channel_id;
  const used = tokenUsable(s);
  const note = s.channel_id === ''
    ? 'No channel is set for it, so nothing is posted with it. Delete it and use ' + (d.installed ? 'the installed bot or a webhook.' : 'a webhook.')
    : used
      ? `Updates are posted with a bot token stored on the website (old setup), in ${where}. ` + (d.installed ? 'Switch to the installed bot above or to a webhook below' : 'Paste a webhook link below to switch') + ' – the token is then deleted from the website.'
      : 'A bot token from the old setup is still stored on the website, but it isn’t used.';
  return `                <div class="${card}">
                    <h2 class="text-base font-semibold text-white mb-3 flex items-center gap-2"><i class='bx bx-key text-xl text-[#8b93ff]'></i> Old bot token</h2>
                    <p class="text-sm text-gray-400">${e(note)}</p>
                    <div class="flex flex-wrap gap-2 mt-4">
                        <form action="/admin" method="POST" class="m-0">${csrf}<input type="hidden" name="oys_action" value="discord_token_test"><button type="submit" class="${btn}"><i class='bx bx-paper-plane'></i> Send test</button></form>
                        <form action="/admin" method="POST" class="m-0"${confirmAttrs('Delete the old bot token?', d.installed ? 'Updates posted with it are then edited and removed by the installed bot, if it can.' : 'Updates posted with it can’t be edited or removed from here any more.', 'Delete token', 'danger')}>${csrf}<input type="hidden" name="oys_action" value="discord_token_remove">${confirmField}<button type="submit" class="${btn} hover:text-red-400"><i class='bx bx-trash'></i> Delete token</button></form>
                    </div>
                </div>
`;
}

// Karte „Discord posts“ (§3.3): Update, Ziel, Zustand, Retry und Forget
function postsCardHtml(d: DiscordTabData): string {
  let o = `                <div id="discordPostsCard" class="bg-card border border-bordercolor rounded-xl shadow-xl overflow-hidden">
                    <div class="flex items-center justify-between px-5 sm:px-6 py-4 border-b border-bordercolor">
                        <h2 class="text-base font-semibold text-white flex items-center gap-2"><i class='bx bx-list-ul text-xl text-[#8b93ff]'></i> Discord posts</h2>
                        <span class="text-xs text-gray-500">Problems and the last 10 posts</span>
                    </div>
`;
  if (!d.posts.length) {
    return o + `                    <p class="px-6 py-10 text-center text-sm text-gray-500">Nothing posted to Discord yet.</p>
                </div>
`;
  }
  o += '                    <ul class="divide-y divide-bordercolor">\n';
  for (const p of d.posts) {
    const c = p.chip;
    o += `                        <li class="px-5 sm:px-6 py-4 flex flex-col lg:flex-row lg:items-center gap-3" data-post-row="${c.id}">
                            <div class="min-w-0 flex-1">
                                <p class="text-white font-medium truncate">${e(p.title)}</p>
                                <p class="text-xs text-gray-500 mt-0.5">${e(p.where)} · ${e(when(p.at))}</p>
                                <div class="flex flex-wrap items-center gap-2 mt-1.5">${chipHtml(c, p.title)}</div>
                                <p class="text-xs text-red-300 mt-1.5 break-words" data-post-error${c.error !== '' ? '' : ' hidden'}>${e(c.error)}</p>
                            </div>
                            <div class="flex flex-wrap gap-2 shrink-0">${chipActionsHtml(c, d.csrf, 'discord')}</div>
                        </li>
`;
  }
  return o + `                    </ul>
                </div>
`;
}

// Ping je Kanal: was der Bot im gewählten Kanal nicht darf (@everyone, @here, nicht erwähnbare Rollen), ist gesperrt –
// der Server prüft es beim Speichern noch einmal
const PING_SCRIPT = String.raw`                <script>
                (function () {
                    var channelSel = document.getElementById('dBotChannel');
                    var mentionSel = document.getElementById('dBotMention');
                    function syncPing() {
                        if (!channelSel || !mentionSel) return;
                        var opt = channelSel.options[channelSel.selectedIndex];
                        var everyone = !!opt && opt.getAttribute('data-everyone') === '1';
                        Array.prototype.forEach.call(mentionSel.querySelectorAll('option[data-needs-everyone]'), function (o) {
                            o.disabled = !everyone;
                            o.textContent = o.getAttribute('data-label') + (everyone ? '' : ' – the bot may not ping');
                        });
                        var sel = mentionSel.options[mentionSel.selectedIndex];
                        if (sel && sel.disabled && sel.value !== '') mentionSel.value = '';
                    }
                    if (channelSel) channelSel.addEventListener('change', syncPing);
                })();
                </script>
`;

// Nachladen über /admin/api/discord-status: Chips der Beiträge (Updates und „Discord posts“), Prüfung durch den Bot und
// der Test – alle 3 s, höchstens 2 Minuten, nur solange etwas unterwegs ist. Texte kommen fertig vom Server und landen
// nur als Text (textContent) auf der Seite; Hinweise über OYSUI.toast.
const STATUS_SCRIPT = String.raw`                <script>
                (function () {
                    if (!window.fetch) return;
                    var TEXT = { ok: 'text-emerald-400', warn: 'text-amber-400', err: 'text-red-400', muted: 'text-gray-400' };
                    var CHIP = { posted: ['bg-[#5865F2]/20', 'text-[#8b93ff]'], warn: ['bg-amber-500/15', 'text-amber-400'], err: ['bg-red-500/15', 'text-red-400'] };
                    var BADGE = { ok: ['bg-emerald-500/15', 'text-emerald-400'], warn: ['bg-amber-500/15', 'text-amber-400'], err: ['bg-amber-500/15', 'text-amber-400'], muted: ['bg-white/10', 'text-gray-400'] };
                    var card = document.querySelector('[data-bot-card]');
                    var started = 0, timer = 0, titles = {};
                    function chips() { return Array.prototype.slice.call(document.querySelectorAll('[data-discord-post]')); }
                    function pending() {
                        if (card && (card.getAttribute('data-bot-checking') === '1' || card.getAttribute('data-test-state') === 'queued')) return true;
                        return chips().some(function (c) {
                            var st = c.getAttribute('data-state');
                            return st === 'queued' || st === 'posting' || st === 'removing' || c.getAttribute('data-busy') === '1';
                        });
                    }
                    function setClasses(el, map, key) {
                        Object.keys(map).forEach(function (k) { [].concat(map[k]).forEach(function (c) { el.classList.remove(c); }); });
                        [].concat(map[key] || []).forEach(function (c) { el.classList.add(c); });
                    }
                    function say(text, tone) { if (text && window.OYSUI) OYSUI.toast({ text: text, tone: tone }); }
                    function quoted(id) { return titles[id] ? '“' + titles[id] + '”' : 'the update'; }
                    function applyBot(b) {
                        if (!card || !b) return;
                        var wasChecking = card.getAttribute('data-bot-checking') === '1';
                        var testWas = card.getAttribute('data-test-state') || '';
                        var status = card.querySelector('[data-bot-status]');
                        if (status && b.status) status.textContent = b.status;
                        var line = card.querySelector('[data-bot-line]');
                        if (line && b.line) { line.textContent = b.line.text; setClasses(line, TEXT, b.line.tone); line.hidden = false; }
                        card.setAttribute('data-bot-checking', b.checking ? '1' : '0');
                        if (wasChecking && !b.checking && b.line) say(b.line.text, b.line.tone === 'err' ? 'err' : 'ok');
                        var test = card.querySelector('[data-bot-test]');
                        var ts = b.test ? b.test.state : '';
                        if (test && b.test) { test.textContent = b.test.text; setClasses(test, TEXT, b.test.tone); test.hidden = false; }
                        card.setAttribute('data-test-state', ts);
                        if (testWas === 'queued' && ts !== 'queued' && b.test) say(b.test.text, b.test.tone === 'ok' ? 'ok' : 'err');
                        var badge = document.querySelector('[data-bot-badge]');
                        if (badge && b.badge) { badge.textContent = b.badge.text; setClasses(badge, BADGE, b.badge.tone); }
                    }
                    function applyPosts(list, asked) {
                        var byId = {}, told = {};
                        chips().forEach(function (el) { var t = el.getAttribute('data-title'); if (t) titles[el.getAttribute('data-discord-post')] = t; });
                        list.forEach(function (p) { byId[String(p.id)] = p; if (p.update_title) titles[String(p.id)] = p.update_title; });
                        chips().forEach(function (el) {
                            var id = el.getAttribute('data-discord-post');
                            if (asked.indexOf(el.getAttribute('data-update-id')) < 0) return;
                            var p = byId[id];
                            var was = el.getAttribute('data-state'), wasBusy = el.getAttribute('data-busy') === '1';
                            if (!told[id]) {
                                told[id] = true;
                                if (!p) { if (was === 'removing') say('Removed from Discord: ' + quoted(id) + '.', 'ok'); }
                                else if ((was === 'queued' || was === 'posting') && p.state === 'posted') say('Posted to Discord: ' + quoted(id) + '.', 'ok');
                                else if ((was === 'queued' || was === 'posting') && p.state === 'failed') say('Not posted to Discord: ' + quoted(id) + ' – ' + p.error, 'err');
                                else if (was === 'removing' && p.state === 'remove_failed') say('Couldn’t remove ' + quoted(id) + ' from Discord – ' + p.error, 'err');
                                else if (wasBusy && !p.busy && p.state === 'posted') say(p.error ? 'The Discord post of ' + quoted(id) + ' wasn’t updated – ' + p.error : 'The Discord post of ' + quoted(id) + ' is updated.', p.error ? 'warn' : 'ok');
                            }
                            if (!p) {
                                // Weg (entfernt, abgebrochen oder vergessen): Chip, Knöpfe und Zeile der Karte verschwinden
                                document.querySelectorAll('[data-post-retry="' + id + '"], [data-post-forget="' + id + '"], [data-post-row="' + id + '"]').forEach(function (x) { x.remove(); });
                                el.remove();
                                return;
                            }
                            el.setAttribute('data-state', p.state);
                            el.setAttribute('data-busy', p.busy ? '1' : '0');
                            if (p.title) el.setAttribute('title', p.title); else el.removeAttribute('title');
                            var label = el.querySelector('[data-chip-label]');
                            if (label) label.textContent = p.label;
                            setClasses(el, CHIP, p.tone);
                            document.querySelectorAll('[data-post-retry="' + id + '"]').forEach(function (f) { f.hidden = !p.retry; });
                            document.querySelectorAll('[data-post-forget="' + id + '"]').forEach(function (f) { f.hidden = !p.forget; });
                            document.querySelectorAll('[data-post-row="' + id + '"] [data-post-error]').forEach(function (x) { x.textContent = p.title || ''; x.hidden = !p.title; });
                        });
                    }
                    function updateIds() {
                        var ids = [];
                        chips().forEach(function (c) { var u = c.getAttribute('data-update-id'); if (u && ids.indexOf(u) < 0 && ids.length < 100) ids.push(u); });
                        return ids;
                    }
                    function schedule() {
                        if (timer || !pending() || Date.now() - started > 120000) return;
                        timer = setTimeout(poll, 3000);
                    }
                    function poll() {
                        timer = 0;
                        var ids = updateIds();
                        fetch('/admin/api/discord-status' + (ids.length ? '?updates=' + ids.join(',') : ''), { credentials: 'same-origin', headers: { Accept: 'application/json' } })
                            .then(function (res) { return res.json().then(function (data) { return { status: res.status, data: data }; }, function () { return { status: res.status, data: null }; }); })
                            .then(function (r) {
                                if (r.status !== 200 || !r.data || !r.data.ok) {
                                    // Abgemeldet: der Dialog der Seite bietet die Anmeldung an; sonst einfach aufhören
                                    if (r.status === 401 && window.OYSUI) OYSUI.handle(401, r.data || {});
                                    return;
                                }
                                applyBot(r.data.bot);
                                applyPosts(r.data.posts || [], ids);
                                schedule();
                            }, function () { schedule(); });
                    }
                    function start() { started = Date.now(); schedule(); }
                    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
                })();
                </script>
`;
