// Öffentliche Seite /roadmap: was gerade passiert, was als Nächstes kommt und was schon fertig ist. Spalten und
// Karten sind mit view2ts aus views/updates.php übernommen (früher Teil von /updates).
import { e } from '../../html.js';
import { timeAgo } from '../../helpers.js';
import { phpTruthy } from '../../php.js';
import { markdown } from '../markdown.js';
import { MILESTONE_STATUSES, type Milestone } from '../updates.js';
import { GRADIENT, cardButton, discordButton, layoutPage } from '../layout.js';
import { fmtDate } from './updatesView.js';

export interface RoadmapPageData {
  loggedIn: boolean;
  columns: Record<'now' | 'next' | 'planned' | 'done', Milestone[]>;
  // Update zu einem fertigen Meilenstein (das neueste)
  updateForMilestone: Map<number, number>;
  invite: string;
  // Die Vorschlagsseite ist an (Pille in der Unternavigation)
  suggestions?: boolean;
  // OnYourSites Statusseite (online): „Status“ in Navigation und Fußzeile
  statusUrl?: string;
}

export const ROADMAP_DESCRIPTION = 'What we’re working on right now, what’s up next and what has shipped. Progress comes from finished tasks – no guesswork.';
export const SHIPPED_SHOWN = 12;

// Karte eines fertigen Meilensteins
function shippedCard(m: Milestone, uid: number | null): string {
  let o = '';
  o += "                <div id=\"milestone-";
  o += m.id;
  o += "\" class=\"flex gap-3 rounded-xl border border-bordercolor bg-card/50 p-4 scroll-mt-24\">\n                    <span class=\"w-9 h-9 rounded-lg bg-amber-500/10 text-amber-400 flex items-center justify-center shrink-0\"><i class='bx bx-rocket text-xl'></i></span>\n                    <div class=\"min-w-0\">\n                        <p class=\"font-medium text-white leading-snug\">";
  o += e(m.title);
  o += "</p>\n                        <p class=\"text-xs text-gray-500 mt-1\">Shipped ";
  o += e(fmtDate(phpTruthy(m.done_at) ? m.done_at : m.updated_at));
  if (uid) {
    o += " · <a href=\"/updates/";
    o += uid;
    o += "\" class=\"text-brand-400 hover:text-white\">Read the update</a>";
  }
  o += "</p>\n                    </div>\n                </div>\n";
  return o;
}

// <section id="roadmap"> mit den drei Spalten (wie bisher auf /updates)
export function roadmapColumns(columns: RoadmapPageData['columns']): string {
  let o = '';
  o += "        <section id=\"roadmap\" class=\"scroll-mt-24\">\n            <div class=\"flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2 mb-6\">\n                <div>\n                    <h2 class=\"text-2xl sm:text-3xl font-bold text-white\">Roadmap</h2>\n                    <p class=\"text-gray-400 text-sm mt-1\">Progress comes from finished tasks – no guesswork. Targets are rough and can move.</p>\n                </div>\n            </div>\n            <div class=\"grid gap-5 md:grid-cols-3\">\n                ";
  for (const status of ['now', 'next', 'planned'] as const) {
    const info = MILESTONE_STATUSES[status];
    o += "                <div class=\"min-w-0\">\n                    <div class=\"flex items-center gap-2 mb-3 px-1\">\n                        <span class=\"w-2.5 h-2.5 rounded-full";
    o += status === 'now' ? ' animate-pulse' : '';
    o += "\" style=\"background:";
    o += e(info.color);
    o += "\"></span>\n                        <h3 class=\"text-sm font-semibold text-white uppercase tracking-wider\">";
    o += e(info.label);
    o += "</h3>\n                        <span class=\"text-xs text-gray-500\">";
    o += columns[status].length;
    o += "</span>\n                    </div>\n                    <div class=\"space-y-4\">\n                        ";
    if (!columns[status].length) {
      o += "                            <div class=\"rounded-2xl border border-dashed border-bordercolor p-5 text-sm text-gray-500\">";
      o += status === 'now' ? 'Nothing in progress right now.' : 'Nothing here yet.';
      o += "</div>\n                        ";
    }
    o += "                        ";
    for (const m of columns[status]) {
      const p = m.progress;
      o += "                        <article id=\"milestone-";
      o += m.id;
      o += "\" class=\"rounded-2xl border border-bordercolor bg-card/70 p-5 scroll-mt-24";
      o += status === 'now' ? ' shadow-[0_0_0_1px_rgba(34,197,94,.15),0_20px_40px_-25px_rgba(34,197,94,.35)]' : '';
      o += "\">\n                            <div class=\"flex items-start justify-between gap-3\">\n                                <h4 class=\"font-semibold text-white leading-snug\">";
      o += e(m.title);
      o += "</h4>\n                                ";
      if (m.target !== '') {
        o += "<span class=\"shrink-0 text-[11px] font-medium text-gray-300 bg-white/5 border border-bordercolor rounded-full px-2 py-0.5\" title=\"Rough target\">";
        o += e(m.target);
        o += "</span>";
      }
      o += "                            </div>\n                            ";
      if (m.description !== '') {
        o += "<div class=\"md md-sm mt-2 text-gray-400\">";
        o += markdown(m.description);
        o += "</div>";
      }
      o += "                            ";
      if (p) {
        o += "                            <div class=\"mt-4\">\n                                <div class=\"flex justify-between text-xs mb-1.5\"><span class=\"text-gray-400\">";
        o += p.done;
        o += " of ";
        o += p.total;
        o += " tasks done</span><span class=\"text-white font-semibold\">";
        o += p.percent;
        o += "%</span></div>\n                                <div class=\"bar\"><span style=\"width:";
        o += p.percent;
        o += "%;background:";
        o += e(info.color);
        o += "\"></span></div>\n                            </div>\n                            ";
      }
      o += "                            ";
      if (m.tasks.length) {
        const shown = m.tasks.slice(0, 5);
        const rest = m.tasks.slice(5);
        o += "                            <ul class=\"mt-4 space-y-1.5 text-sm\">\n                                ";
        for (const t of shown) {
          o += "                                <li class=\"flex gap-2 ";
          o += t.is_done ? 'text-gray-500' : 'text-gray-300';
          o += "\"><i class='bx ";
          o += t.is_done ? 'bx-check-circle text-emerald-400' : 'bx-circle text-gray-600';
          o += " text-base mt-0.5 shrink-0'></i><span class=\"";
          o += t.is_done ? 'line-through decoration-gray-600' : '';
          o += "\">";
          o += e(t.title);
          o += "</span></li>\n                                ";
        }
        o += "                            </ul>\n                            ";
        if (rest.length) {
          o += "                            <details class=\"mt-1.5 text-sm\">\n                                <summary class=\"text-brand-400 hover:text-white py-1\">";
          o += rest.length;
          o += " more task";
          o += rest.length === 1 ? '' : 's';
          o += "</summary>\n                                <ul class=\"mt-1 space-y-1.5\">\n                                    ";
          for (const t of rest) {
            o += "                                    <li class=\"flex gap-2 ";
            o += t.is_done ? 'text-gray-500' : 'text-gray-300';
            o += "\"><i class='bx ";
            o += t.is_done ? 'bx-check-circle text-emerald-400' : 'bx-circle text-gray-600';
            o += " text-base mt-0.5 shrink-0'></i><span class=\"";
            o += t.is_done ? 'line-through decoration-gray-600' : '';
            o += "\">";
            o += e(t.title);
            o += "</span></li>\n                                    ";
          }
          o += "                                </ul>\n                            </details>\n                            ";
        }
        o += "                            ";
      }
      o += "                            <p class=\"mt-4 text-xs text-gray-500\">\n                                ";
      if (status === 'now' && phpTruthy(m.started_at)) {
        o += "Started ";
        o += e(fmtDate(m.started_at));
        o += " · ";
      }
      o += "Updated ";
      o += e(timeAgo(m.updated_at));
      o += "                            </p>\n                        </article>\n                        ";
    }
    o += "                    </div>\n                </div>\n                ";
  }
  o += "            </div>\n        </section>\n        ";
  return o;
}

export function roadmapView(d: RoadmapPageData): string {
  const { columns, updateForMilestone, invite } = d;
  const hasRoadmap = columns.now.length > 0 || columns.next.length > 0 || columns.planned.length > 0;
  let main = '';
  if (hasRoadmap) {
    main += roadmapColumns(columns);
  } else {
    main += `        <section id="roadmap" class="scroll-mt-24">
            <div class="rounded-2xl border border-dashed border-bordercolor p-10 text-center">
                <i class='bx bx-map-alt text-4xl text-gray-600'></i>
                <p class="mt-3 text-gray-400">Nothing on the roadmap right now – see what shipped in the <a href="/updates" class="text-brand-400 hover:text-white">changelog</a>.</p>
            </div>
        </section>
`;
  }
  const shipped = columns.done;
  if (shipped.length) {
    const shown = shipped.slice(0, SHIPPED_SHOWN);
    const rest = shipped.slice(SHIPPED_SHOWN);
    main += `        <section id="shipped" class="scroll-mt-24">
            <h2 class="text-xl sm:text-2xl font-bold text-white mb-5">Recently shipped</h2>
            <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
${shown.map((m) => shippedCard(m, updateForMilestone.get(m.id) ?? null)).join('')}            </div>
`;
    if (rest.length) {
      main += `            <details class="mt-4">
                <summary class="text-sm text-brand-400 hover:text-white py-1">${rest.length} more shipped</summary>
                <div class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
${rest.map((m) => shippedCard(m, updateForMilestone.get(m.id) ?? null)).join('')}                </div>
            </details>
`;
    }
    main += `        </section>
`;
  } else {
    main += `        <span id="shipped"></span>
`;
  }
  main += `        <div class="rounded-2xl border border-bordercolor bg-card/50 p-6 sm:p-8 text-center">
            <p class="text-white font-semibold">Missing something?</p>
            <p class="mt-1 text-gray-400">Post your idea in #suggestions on our Discord.</p>
            <a href="${e(invite)}" target="_blank" rel="noopener" class="mt-4 inline-flex items-center gap-2 text-[#8b93ff] hover:text-white font-medium"><i class='bx bxl-discord-alt text-xl'></i> Join the Discord</a>
        </div>
        <script>
            // Zeigt der Anker auf etwas in einem zugeklappten Teil (ältere fertige Meilensteine): erst aufklappen
            (function () {
                function open() {
                    var el = location.hash.length > 1 ? document.getElementById(location.hash.slice(1)) : null;
                    var d = el && el.closest('details');
                    if (d && !d.open) { d.open = true; el.scrollIntoView(); }
                }
                open();
                window.addEventListener('hashchange', open);
            })();
        </script>
`;
  return layoutPage({
    section: 'roadmap',
    title: 'Roadmap | OnYourSite',
    description: ROADMAP_DESCRIPTION,
    canonical: '/roadmap',
    loggedIn: d.loggedIn,
    invite,
    suggestions: d.suggestions === true,
    statusUrl: d.statusUrl,
  }, {
    badge: 'Roadmap',
    headline: 'What we’re <span class="' + GRADIENT + '">building</span>',
    text: ROADMAP_DESCRIPTION,
    buttons: discordButton(invite, 'Suggest an idea', 'bx-bulb') + '\n                ' + cardButton('/updates', 'See the changelog', 'bx-news'),
  }, main);
}
