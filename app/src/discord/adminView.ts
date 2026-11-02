// Admin → Discord: Status, der installierte Bot, ein eigenes Formular je Ziel (Webhook, alter Bot-Token, Vorgaben).
// Kein Passwortfeld und keine Feldnamen, die ein Browser mit Anmeldedaten füllt (username, email …); der gespeicherte
// Webhook-Link steht nie im HTML, das Eingabefeld erscheint erst mit „Replace link“.
import type { Ctx } from '../web/ctx.js';
import { ROOT_DIR } from '../config.js';
import { e } from '../html.js';
import { timeAgo } from '../helpers.js';
import { date, strtotime, time } from '../php.js';
import { botLastSeen, botSecret } from '../community/community.js';
import { WEBHOOK_KEEP } from './admin.js';
import { activeDestination, discordSettings, displayNameProblem, type DiscordSettings } from './settings.js';
import { maskedWebhook, parseWebhookLink } from './webhook.js';
import { confirmAttrs as uiConfirmAttrs, confirmField as uiConfirmField } from '../views/partials/ui.js';

export interface DiscordTabData {
  csrf: string;
  s: DiscordSettings;
  bot: { installed: boolean; lastSeen: number | null };
  codeDir: string;
  errorField: string;
  keep: Record<string, string> | null;
  replaceLink: boolean;
}

export async function discordTabData(ctx: Ctx, csrf: string): Promise<DiscordTabData> {
  const session = ctx.session;
  const field = session?.take<string>('discord_error_field');
  const keep = session?.take<Record<string, unknown>>('discord_keep');
  const kept: Record<string, string> = {};
  if (keep && typeof keep === 'object') for (const k of WEBHOOK_KEEP) if (typeof keep[k] === 'string') kept[k] = keep[k] as string;
  return {
    csrf,
    s: await discordSettings(),
    bot: { installed: botSecret() !== '', lastSeen: await botLastSeen() },
    codeDir: ROOT_DIR,
    errorField: typeof field === 'string' ? field : '',
    keep: keep ? kept : null,
    replaceLink: ctx.get.replace_webhook !== undefined,
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
  const { csrf, s, bot } = d;
  const active = activeDestination(s);
  const hook = parseWebhookLink(s.webhook_url);
  const err = (name: string): string => (d.errorField === name ? ' ring-1 ring-red-500' : '');
  const kept = (name: string, fallback: string): string => (d.keep && d.keep[name] !== undefined ? d.keep[name] : fallback);
  const online = bot.lastSeen !== null && time() - bot.lastSeen < 300;
  const seen = bot.lastSeen !== null ? timeAgo(date('Y-m-d H:i:s', bot.lastSeen)) : '';
  const where = s.post_in === 'forum' ? 'a new forum post for each update' : s.post_in === 'thread' ? 'thread ' + s.thread_id : 'the channel';
  const checked = s.checked_at !== '' && s.check_error === '';

  // Kopf: wohin Updates gerade gehen
  let title = 'Discord isn’t connected yet';
  let subline = 'Paste a webhook link below.';
  if (active === 'webhook' && hook) {
    title = 'Posting with the webhook' + (s.hook_name !== '' ? ' “' + s.hook_name + '”' : '');
    subline = maskedWebhook(hook) + ' · into ' + where + ' · ' + (checked ? 'checked ' + when(s.checked_at) : 'not checked yet');
  } else if (active === 'token') {
    title = 'Posting with the old bot token';
    subline = 'Channel ' + s.channel_id;
  }
  const hookBadge = !hook ? badge('gray', 'Off') : active !== 'webhook' ? badge('gray', 'Not in use') : checked ? badge('green', 'Checked') : badge('amber', 'Not verified');
  const botBadge = !bot.installed ? badge('amber', 'Not set up') : online ? badge('green', 'Online') : badge('gray', 'Offline');

  let o = `
            <!-- ===================== Discord ===================== -->
            <div id="tab-discord" class="admin-tab-content max-w-4xl mx-auto space-y-8 hidden">
                <div class="${card}">
                    <div class="flex flex-col sm:flex-row sm:items-center gap-4">
                        <span class="w-12 h-12 rounded-xl flex items-center justify-center shrink-0 ${active ? 'bg-[#5865F2]/20 text-[#8b93ff]' : 'bg-white/5 text-gray-500'}"><i class='bx bxl-discord-alt text-3xl'></i></span>
                        <div class="flex-1 min-w-0">
                            <p class="text-white font-semibold">${e(title)}</p>
                            <p class="text-sm text-gray-400 truncate">${e(subline)}</p>
                        </div>
                    </div>
                    <div class="mt-5 pt-4 border-t border-bordercolor flex flex-wrap gap-x-6 gap-y-2 text-sm">
                        <span class="flex items-center gap-2"><i class='bx bx-bot text-lg text-gray-400'></i><span class="text-gray-300">Bot</span> ${botBadge}${bot.installed ? ' <span class="text-xs text-gray-500">doesn’t post updates yet</span>' : ''}</span>
                        <span class="flex items-center gap-2"><i class='bx bx-link text-lg text-gray-400'></i><span class="text-gray-300">Webhook</span> ${hookBadge}</span>
${s.bot_token !== '' ? `                        <span class="flex items-center gap-2"><i class='bx bx-key text-lg text-gray-400'></i><span class="text-gray-300">Old bot token</span> ${badge(active === 'token' ? 'amber' : 'gray', active === 'token' ? 'In use' : 'Not in use')}</span>\n` : ''}                    </div>
                </div>
`;
  if (s.auto_post && !active) {
    o += `                <div class="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-300">Updates aren’t announced on Discord right now – no destination is on.</div>\n`;
  }

  // Der installierte Bot: kein Token nötig
  o += `                <div id="discordBotCard" class="${card}">
                    <h2 class="text-base font-semibold text-white mb-3 flex items-center gap-2"><i class='bx bx-bot text-xl text-[#8b93ff]'></i> Post with the bot</h2>
`;
  if (bot.installed) {
    const status = online ? 'online · last seen ' + seen : bot.lastSeen !== null ? 'offline · last seen ' + seen : 'it hasn’t checked in yet';
    o += `                    <p class="text-sm text-gray-400">The Discord bot on this server is connected to the website (${e(status)}). It doesn’t announce updates yet – until it does, post them with a webhook below. You never need to enter its token here.</p>\n`;
  } else {
    o += `                    <p class="text-sm text-gray-400">The Discord bot isn’t set up on this server. Run <code class="text-white break-all">sudo bash ${e(d.codeDir)}/server/install.sh</code> and answer y at “Set up the Discord bot on this server too?” – until then you can use a webhook below.</p>\n`;
  }
  o += `                </div>
`;

  // Webhook
  const postIn = kept('post_in', s.post_in);
  // Ein gespeicherter Name, den Discord ablehnt, wird nicht gesendet (webhookName) – das Feld sagt warum
  const storedNameProblem = d.keep === null ? displayNameProblem(s.username) : null;
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
                    <p class="text-sm text-gray-500 mb-5">Posts updates into one channel, forum or thread of your Discord server – no bot needed.</p>
                    <form action="/admin" method="POST" id="discordWebhookForm" autocomplete="off" class="space-y-5">
                        ${csrf}
                        <input type="hidden" name="oys_action" value="discord_webhook_save">
`;
  if (hook) {
    const line = 'Webhook' + (s.hook_name !== '' ? ' “' + s.hook_name + '”' : '') + ' · ' + maskedWebhook(hook) + (checked ? ' · checked ' + when(s.checked_at) : '');
    o += `                        <div class="rounded-xl border border-bordercolor bg-white/[.02] p-4 text-sm space-y-1">
                            <p class="text-gray-200 break-all">${e(line)}</p>
${active !== 'webhook' ? `                            <p class="text-xs text-gray-500">Saved, but not in use${active === 'token' ? ' – updates are posted with the old bot token. Save here to post with the webhook instead.' : '. Save to check it and post with it.'}</p>\n` : ''}${s.check_error !== '' ? `                            <p class="text-xs text-amber-400">Not checked: ${e(s.check_error)}</p>\n` : ''}                        </div>
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
                                <input id="dThread" type="text" name="thread_id" inputmode="numeric" autocomplete="off" maxlength="25" value="${e(kept('thread_id', s.thread_id))}" placeholder="e.g. 1234567890123456789" class="${inp}${err('thread_id')}">
                                <p class="text-xs text-gray-500 mt-1.5">In Discord turn on Developer Mode, right-click the thread → Copy Thread ID.${s.post_in === 'thread' && s.thread_id !== '' && !s.thread_verified ? ' <span class="text-amber-400">Thread not verified yet – it is checked with the first post into it.</span>' : ''}</p>
                            </div>
                        </fieldset>
                        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            <div>
                                <label class="${lbl}" for="dDisplayName">Display name <span class="text-gray-500 font-normal">(optional)</span></label>
                                <input id="dDisplayName" type="text" name="display_name" maxlength="80" autocomplete="off" data-1p-ignore data-lpignore="true" value="${e(kept('display_name', s.username))}" placeholder="OnYourSite Updates" class="${inp}${nameRing}">
                                <p class="text-xs text-gray-500 mt-1.5">Up to 80 characters, without @ # : and without the words “discord” or “clyde”.</p>
${storedNameProblem !== null ? `                                <p class="text-xs text-amber-400 mt-1">${e(storedNameProblem + ' It isn’t sent until you change it.')}</p>\n` : ''}                            </div>
                            <div>
                                <label class="${lbl}" for="dAvatar">Avatar image link <span class="text-gray-500 font-normal">(optional)</span></label>
                                <input id="dAvatar" type="text" name="avatar_url" inputmode="url" autocomplete="off" value="${e(kept('avatar_url', s.avatar_url))}" placeholder="https://…/logo.png" class="${inp}${err('avatar_url')}">
                            </div>
                            <div>
                                <label class="${lbl}" for="dMention">Ping <span class="text-gray-500 font-normal">(optional)</span></label>
                                <input id="dMention" type="text" name="mention" maxlength="30" autocomplete="off" value="${e(kept('mention', s.mention))}" placeholder="Role ID, “everyone” or “here”" class="${inp}${err('mention')}">
                                <p class="text-xs text-gray-500 mt-1.5">Who gets notified when an update is posted. Empty = nobody is pinged.</p>
                            </div>
                        </div>
                        <div class="flex flex-wrap items-center justify-end gap-2">
`;
  if (hook) {
    const firstForumTest = s.post_in === 'forum' && s.test_thread_id === '';
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
    const firstForumTest = s.post_in === 'forum' && s.test_thread_id === '';
    o += `                    <form action="/admin" method="POST" id="discordWebhookTestForm" class="hidden">${csrf}<input type="hidden" name="oys_action" value="discord_webhook_test">${firstForumTest ? confirmField : ''}</form>
                    <form action="/admin" method="POST" id="discordWebhookRemoveForm" class="hidden">${csrf}<input type="hidden" name="oys_action" value="discord_webhook_remove">${confirmField}</form>
`;
  }
  o += `                </div>
`;

  // Alter Bot-Token: nur solange einer gespeichert ist, ohne Feld für einen neuen
  if (s.bot_token !== '') {
    const note = s.channel_id === ''
      ? 'No channel is set for it, so nothing is posted with it. Delete it and use a webhook.'
      : active === 'token'
        ? 'Updates are posted with a bot token stored on the website (old setup), in channel ' + s.channel_id + '. Paste a webhook link above to switch – the token is then deleted from the website.'
        : 'A bot token from the old setup is still stored on the website, but it isn’t used.';
    o += `                <div class="${card}">
                    <h2 class="text-base font-semibold text-white mb-3 flex items-center gap-2"><i class='bx bx-key text-xl text-[#8b93ff]'></i> Old bot token</h2>
                    <p class="text-sm text-gray-400">${e(note)}</p>
                    <div class="flex flex-wrap gap-2 mt-4">
                        <form action="/admin" method="POST" class="m-0">${csrf}<input type="hidden" name="oys_action" value="discord_token_test"><button type="submit" class="${btn}"><i class='bx bx-paper-plane'></i> Send test</button></form>
                        <form action="/admin" method="POST" class="m-0"${confirmAttrs('Delete the old bot token?', 'Updates posted with it can’t be edited or removed from here any more.', 'Delete token', 'danger')}>${csrf}<input type="hidden" name="oys_action" value="discord_token_remove">${confirmField}<button type="submit" class="${btn} hover:text-red-400"><i class='bx bx-trash'></i> Delete token</button></form>
                    </div>
                </div>
`;
  }

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

                <div class="grid gap-6 md:grid-cols-2">
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
            </div>
`;
  return o;
}
