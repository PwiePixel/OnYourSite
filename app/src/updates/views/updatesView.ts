// Öffentliche Seite /updates: der Verlauf aller Updates (Changelog). Die Roadmap hat ihre eigene Seite (/roadmap);
// alte Links auf /updates#roadmap, #shipped und #milestone-N leitet ein Skript dorthin weiter. Der Teil „Changelog“
// ist mit view2ts aus views/updates.php übernommen.
import { e } from '../../html.js';
import { date, phpLtrim, phpTrim, phpTruthy, strtotime } from '../../php.js';
import { markdown } from '../markdown.js';
import { UPDATE_CATEGORIES, type Update } from '../updates.js';
import { cardButton, discordButton, layoutPage } from '../layout.js';

export interface UpdatesPageData {
  loggedIn: boolean;
  pageNo: number;
  lastPage: number;
  updates: Update[];
  // Titel der öffentlichen Meilensteine (für die Chips mit Link zur Roadmap)
  milestoneTitles: Map<number, string>;
  invite: string;
}

export const UPDATES_DESCRIPTION = 'Every change to OnYourSite, newest first.';

// Alte Anker der früheren gemeinsamen Seite → /roadmap. Die Abfrage ?from=updates ist nötig, weil Browser die alte
// 301 von /roadmap auf /updates#roadmap im Cache behalten – ohne sie entstünde eine Schleife.
export const FORWARD_SCRIPT = "if (/^#(roadmap|shipped|milestone-\\d+)$/.test(location.hash)) location.replace('/roadmap?from=updates' + location.hash);";

// date('M j, Y') oder '' (strtotime ohne Ergebnis = 1. Januar 1970 wie in PHP)
export function fmtDate(dt: string | null): string {
  if (!phpTruthy(dt)) return '';
  const t = strtotime(dt as string);
  return date('M j, Y', t === false ? 0 : t);
}

// <section id="changelog"> … </section>
export function changelogSection(d: UpdatesPageData): string {
  let o = '';
  const { pageNo, lastPage, updates, milestoneTitles } = d;
  o += "\n        <section id=\"changelog\" class=\"scroll-mt-24\">\n            <div class=\"flex items-end justify-between gap-3 mb-8\">\n                <div>\n                    <h2 class=\"text-2xl sm:text-3xl font-bold text-white\">Changelog</h2>\n                    <p class=\"text-gray-400 text-sm mt-1\">Everything that changed, newest first.</p>\n                </div>\n            </div>\n\n            ";
  if (!updates.length) {
    o += "                <div class=\"rounded-2xl border border-dashed border-bordercolor p-10 text-center\">\n                    <i class='bx bx-news text-4xl text-gray-600'></i>\n                    <p class=\"mt-3 text-gray-400\">No updates yet – stay tuned.</p>\n                </div>\n            ";
  } else {
    o += "            <div class=\"relative\">\n                <div class=\"timeline-line absolute left-[152px] top-2 bottom-2 w-px bg-bordercolor\"></div>\n                <div class=\"space-y-10\">\n                    ";
    for (const u of updates) {
      const cat = UPDATE_CATEGORIES[u.category];
      const published = strtotime(u.published_at ?? '');
      o += "                    <article id=\"update-";
      o += u.id;
      o += "\" class=\"relative sm:grid sm:grid-cols-[132px_1fr] sm:gap-10 scroll-mt-24\">\n                        <div class=\"sm:text-right sm:pt-1 mb-3 sm:mb-0\">\n                            <time datetime=\"";
      o += e(date('Y-m-d', published === false ? 0 : published));
      o += "\" class=\"text-sm text-gray-400\">";
      o += e(fmtDate(u.published_at));
      o += "</time>\n                            ";
      if (u.version !== '') {
        o += "<div class=\"inline-block sm:block ml-2 sm:ml-0 sm:mt-1 text-xs font-mono text-gray-500\">v";
        o += e(phpLtrim(u.version, 'vV'));
        o += "</div>";
      }
      o += "                        </div>\n                        <span class=\"timeline-line absolute left-[147px] top-2 w-[11px] h-[11px] rounded-full border-2 border-background\" style=\"background:";
      o += e(cat.color);
      o += "\"></span>\n                        <div class=\"min-w-0 rounded-2xl border border-bordercolor bg-card/50 p-5 sm:p-6\">\n                            <div class=\"flex flex-wrap items-center gap-2 mb-3\">\n                                <span class=\"text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full\" style=\"color:";
      o += e(cat.color);
      o += ";background:";
      o += e(cat.color);
      o += "1f\">";
      o += e(cat.label);
      o += "</span>\n                                ";
      if (u.milestone_id && milestoneTitles.has(u.milestone_id)) {
        o += "                                <a href=\"/roadmap#milestone-";
        o += u.milestone_id;
        o += "\" class=\"inline-flex items-center gap-1 text-xs text-gray-400 hover:text-white border border-bordercolor rounded-full px-2.5 py-1.5\"><i class='bx bx-flag'></i> ";
        o += e(milestoneTitles.get(u.milestone_id));
        o += "</a>\n                                ";
      }
      o += "                            </div>\n                            <h3 class=\"text-lg sm:text-xl font-bold text-white leading-snug\"><a href=\"#update-";
      o += u.id;
      o += "\" class=\"hover:text-brand-400 transition-colors\">";
      o += e(u.title);
      o += "</a></h3>\n                            ";
      if (phpTrim(u.body) !== '') {
        o += "<div class=\"md mt-3\">";
        o += markdown(u.body);
        o += "</div>";
      }
      o += "                        </div>\n                    </article>\n                    ";
    }
    o += "                </div>\n            </div>\n\n            ";
    if (lastPage > 1) {
      o += "            <nav class=\"mt-10 flex items-center justify-between gap-3 text-sm\" aria-label=\"Pages\">\n                ";
      if (pageNo > 1) {
        o += "<a href=\"/updates";
        o += pageNo - 1 > 1 ? '?page=' + (pageNo - 1) : '';
        o += "#changelog\" class=\"inline-flex items-center gap-1 px-4 py-2.5 rounded-full border border-bordercolor hover:border-brand-500/50 text-white\"><i class='bx bx-left-arrow-alt'></i> Newer</a>";
      } else {
        o += "<span></span>";
      }
      o += "                <span class=\"text-gray-500\">Page ";
      o += pageNo;
      o += " of ";
      o += lastPage;
      o += "</span>\n                ";
      if (pageNo < lastPage) {
        o += "<a href=\"/updates?page=";
        o += pageNo + 1;
        o += "#changelog\" class=\"inline-flex items-center gap-1 px-4 py-2.5 rounded-full border border-bordercolor hover:border-brand-500/50 text-white\">Older <i class='bx bx-right-arrow-alt'></i></a>";
      } else {
        o += "<span></span>";
      }
      o += "            </nav>\n            ";
    }
    o += "            ";
  }
  o += "        </section>\n";
  return o;
}

export function updatesView(d: UpdatesPageData): string {
  return layoutPage({
    section: 'updates',
    title: 'Updates | OnYourSite',
    description: UPDATES_DESCRIPTION,
    canonical: '/updates' + (d.pageNo > 1 ? '?page=' + d.pageNo : ''),
    loggedIn: d.loggedIn,
    invite: d.invite,
    headScript: FORWARD_SCRIPT,
  }, {
    badge: 'Changelog',
    headline: 'What’s new at <span class="text-transparent bg-clip-text [-webkit-text-fill-color:transparent] box-decoration-clone bg-gradient-to-r from-brand-400 to-purple-400">OnYourSite</span>',
    text: UPDATES_DESCRIPTION,
    buttons: discordButton(d.invite, 'Get updates on Discord') + '\n                ' + cardButton('/updates/feed.xml', 'RSS feed', 'bx-rss'),
  }, '        <span id="roadmap"></span><span id="shipped"></span>' + changelogSection(d));
}
