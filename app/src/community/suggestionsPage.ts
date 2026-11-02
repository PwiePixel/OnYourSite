// Öffentliche Seite /suggestions: Ideen aus dem Vorschlagsforum auf Discord und was das Team entschieden hat – ohne
// Namen. Solange das Admin die Seite nicht einschaltet (oder der Bot nicht eingerichtet ist), antwortet sie wie jede
// unbekannte Adresse mit 404. Kein Cookie für Besucher; jeder Text geht durch e().
import type { Ctx } from '../web/ctx.js';
import type { Row } from '../db.js';
import { e } from '../html.js';
import { intval, phpTruthy } from '../php.js';
import { notFound } from '../public/notFound.js';
import { GRADIENT, cardButton, discordButton, layoutPage } from '../updates/layout.js';
import { fmtDate } from '../updates/views/updatesView.js';
import { invite } from '../updates/pages.js';
import { report } from '../discord/botReport.js';
import {
  PUBLIC_FILTERS, SUGGESTIONS_PER_PAGE, excerpt, publicCounts, publicSuggestions, suggestionPageOf, suggestionText, suggestionsPageOn,
  type PublicFilter, type PublicSuggestion,
} from './suggestions.js';

export const SUGGESTIONS_DESCRIPTION = 'Suggestions from our Discord and what the team decided. Got an idea? Post it in #suggestions.';

const BADGE: Record<string, string> = {
  open: 'bg-sky-500/15 text-sky-400', accepted: 'bg-emerald-500/15 text-emerald-400', declined: 'bg-red-500/15 text-red-400',
};
const LABEL: Record<PublicFilter, string> = { all: 'All', open: 'Open', accepted: 'Accepted', declined: 'Declined' };
const NOTE_BORDER: Record<string, string> = { accepted: 'border-emerald-500/40', declined: 'border-red-500/40' };
const PILL = 'inline-flex items-center gap-1.5 px-3 py-2 min-h-[36px] rounded-full text-xs font-medium border border-bordercolor text-gray-300 hover:text-white hover:bg-white/5 transition-colors';
const PAGER = 'inline-flex items-center gap-1 px-4 py-2.5 rounded-full border border-bordercolor hover:border-brand-500/50 text-white';
const SNOWFLAKE = /^\d{15,25}$/;

export interface SuggestionsPageData {
  loggedIn: boolean;
  filter: PublicFilter;
  counts: Record<PublicFilter, number>;
  pageNo: number;
  lastPage: number;
  items: PublicSuggestion[];
  invite: string;
  // Server des Bots (für „Discuss on Discord“); leer, solange er unbekannt ist
  guildId: string;
}

// ?status=…: nur bekannte Werte, sonst alle
function parseFilter(v: unknown): PublicFilter {
  return typeof v === 'string' && (PUBLIC_FILTERS as readonly string[]).includes(v) ? (v as PublicFilter) : 'all';
}

// Adresse der Liste mit Filter und Seite (die Abfrage bleibt beim Blättern erhalten)
function listUrl(filter: PublicFilter, pageNo: number, anchor = true): string {
  const query: string[] = [];
  if (filter !== 'all') query.push('status=' + filter);
  if (pageNo > 1) query.push('page=' + pageNo);
  return '/suggestions' + (query.length ? '?' + query.join('&') : '') + (anchor ? '#list' : '');
}

// GET /suggestions
export async function suggestionsPage(ctx: Ctx, user: Row | null): Promise<void> {
  if (!(await suggestionsPageOn())) {
    ctx.status = 404;
    return notFound(ctx);
  }
  const filter = parseFilter(ctx.get.status);
  const counts = await publicCounts(true);
  const lastPage = Math.max(1, Math.ceil(counts[filter] / SUGGESTIONS_PER_PAGE));
  const pageNo = Math.min(lastPage, Math.max(1, typeof ctx.get.page === 'string' ? intval(ctx.get.page) : 1));
  const items = await publicSuggestions(true, filter, pageNo);
  const rep = await report();
  const guildId = rep && SNOWFLAKE.test(rep.guild.id) ? rep.guild.id : '';
  ctx.write(suggestionsView({ loggedIn: phpTruthy(user), filter, counts, pageNo, lastPage, items, invite: await invite(), guildId }));
}

// GET /suggestions/{id}: zur Seite, auf der der Vorschlag steht (nicht sichtbar: zur Liste)
export async function suggestionLink(ctx: Ctx, id: number): Promise<void> {
  if (!(await suggestionsPageOn())) {
    ctx.status = 404;
    return notFound(ctx);
  }
  const pageNo = await suggestionPageOf(true, id);
  ctx.redirect(pageNo === null ? '/suggestions' : listUrl('all', pageNo, false) + '#suggestion-' + id);
}

function card(s: PublicSuggestion, guildId: string): string {
  const status = BADGE[s.status] !== undefined ? s.status : 'open';
  const label = LABEL[status as PublicFilter];
  const text = suggestionText(s.body);
  const ex = excerpt(text);
  const reason = suggestionText(s.reason);
  let meta = 'Suggested ' + fmtDate(s.created_at);
  if (status !== 'open' && s.decided_at) meta += ' · ' + label + ' ' + fmtDate(s.decided_at);
  let o = `                <article id="suggestion-${s.id}" class="group rounded-2xl border border-bordercolor bg-card/50 p-5 sm:p-6 scroll-mt-24">
                    <span class="text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${BADGE[status]}">${e(label)}</span>
                    <h3 class="mt-3 text-lg font-bold text-white break-words">${e(s.title)}</h3>
`;
  if (text !== '') {
    if (ex.more) {
      o += `                    <p class="mt-2 text-gray-300 whitespace-pre-line break-words group-has-[details[open]]:hidden">${e(ex.text)}…</p>
                    <details class="mt-2">
                        <summary class="text-sm text-brand-400 hover:text-white"><span class="group-has-[details[open]]:hidden">Show more</span><span class="hidden group-has-[details[open]]:inline">Show less</span></summary>
                        <p class="mt-2 text-gray-300 whitespace-pre-line break-words">${e(text)}</p>
                    </details>
`;
    } else {
      o += `                    <p class="mt-2 text-gray-300 whitespace-pre-line break-words">${e(text)}</p>\n`;
    }
  }
  o += `                    <p class="mt-3 text-xs text-gray-500">${e(meta)}</p>\n`;
  if (reason !== '') {
    o += `                    <blockquote class="mt-3 border-l-2 ${NOTE_BORDER[status] ?? 'border-white/20'} pl-3 text-sm text-gray-300">
                        <p class="text-xs font-semibold uppercase tracking-wider text-gray-500">Note from the team</p>
                        <p class="mt-1 whitespace-pre-line break-words">${e(reason)}</p>
                    </blockquote>
`;
  }
  if (guildId !== '' && SNOWFLAKE.test(s.thread_id)) {
    o += `                    <div class="mt-4"><a href="${e(`https://discord.com/channels/${guildId}/${s.thread_id}`)}" target="_blank" rel="noopener" class="inline-flex items-center gap-1.5 text-sm text-[#8b93ff] hover:text-white font-medium"><i class='bx bx-conversation text-lg'></i> Discuss on Discord</a></div>\n`;
  }
  o += '                </article>\n';
  return o;
}

export function suggestionsView(d: SuggestionsPageData): string {
  const { filter, counts, pageNo, lastPage } = d;
  // Filter: „Open“ nur, wenn offene Vorschläge gezeigt werden (oder der Filter gerade gewählt ist)
  const pills = PUBLIC_FILTERS.filter((f) => f !== 'open' || counts.open > 0 || filter === 'open').map((f) => {
    const active = f === filter;
    return `<a href="${listUrl(f, 1)}"${active ? ' aria-current="page"' : ''} class="${PILL}${active ? ' !bg-white/10 !text-white' : ''}">${LABEL[f]} <span class="text-gray-500">${counts[f]}</span></a>`;
  });
  let main = `        <section id="list" class="max-w-3xl mx-auto scroll-mt-24">
            <div class="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-6">
                <h2 class="text-2xl sm:text-3xl font-bold text-white">Suggestions</h2>
                <nav aria-label="Filter suggestions" class="flex flex-wrap gap-1.5">
                    ${pills.join('\n                    ')}
                </nav>
            </div>
`;
  if (!d.items.length) {
    const empty = filter === 'all'
      ? 'No suggestions on the website yet. Post yours in #suggestions on our Discord – once the team decides it, it shows up here.'
      : `No ${LABEL[filter].toLowerCase()} suggestions yet.`;
    main += `            <div class="rounded-2xl border border-dashed border-bordercolor p-10 text-center">
                <i class='bx bx-bulb text-4xl text-gray-600'></i>
                <p class="mt-3 text-gray-400">${e(empty)}</p>
            </div>
`;
  } else {
    main += `            <div class="grid gap-4">
${d.items.map((s) => card(s, d.guildId)).join('')}            </div>
`;
  }
  if (lastPage > 1) {
    main += `            <nav class="mt-10 flex items-center justify-between gap-3 text-sm" aria-label="Pages">
                ${pageNo > 1 ? `<a href="${listUrl(filter, pageNo - 1)}" class="${PAGER}"><i class='bx bx-left-arrow-alt'></i> Newer</a>` : '<span></span>'}
                <span class="text-gray-500">Page ${pageNo} of ${lastPage}</span>
                ${pageNo < lastPage ? `<a href="${listUrl(filter, pageNo + 1)}" class="${PAGER}">Older <i class='bx bx-right-arrow-alt'></i></a>` : '<span></span>'}
            </nav>
`;
  }
  main += `            <p class="mt-10 text-center text-sm text-gray-500">Suggestions come from the #suggestions forum on our Discord. Only ideas the team has decided are shown, without names.</p>
        </section>
`;
  return layoutPage({
    section: 'suggestions',
    title: 'Suggestions | OnYourSite',
    description: SUGGESTIONS_DESCRIPTION,
    canonical: listUrl('all', filter === 'all' ? pageNo : 1, false),
    loggedIn: d.loggedIn,
    invite: d.invite,
    suggestions: true,
    // Gefilterte Ansichten nicht in Suchmaschinen (nur die ganze Liste)
    robots: filter === 'all' ? undefined : 'noindex, follow',
  }, {
    badge: 'Community ideas',
    headline: 'Ideas from the <span class="' + GRADIENT + '">community</span>',
    text: SUGGESTIONS_DESCRIPTION,
    buttons: discordButton(d.invite, 'Share an idea on Discord', 'bx-bulb') + '\n                ' + cardButton('/roadmap', 'See the roadmap', 'bx-map-alt'),
  }, main);
}
