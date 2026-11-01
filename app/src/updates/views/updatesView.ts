// Öffentliche Seite /updates (views/updates.php): Roadmap (was gerade passiert, was als Nächstes kommt) und Verlauf
// aller Updates. Der Text außerhalb der PHP-Teile ist mit view2ts Byte für Byte übernommen.
import { e } from '../../html.js';
import { asset, mainUrl, timeAgo } from '../../helpers.js';
import { date, phpLtrim, phpTrim, phpTruthy, strtotime } from '../../php.js';
import { markdown } from '../markdown.js';
import { MILESTONE_STATUSES, UPDATE_CATEGORIES, type Milestone, type Update } from '../updates.js';

export interface UpdatesPageData {
  loggedIn: boolean;
  pageNo: number;
  lastPage: number;
  updates: Update[];
  columns: Record<'now' | 'next' | 'planned' | 'done', Milestone[]>;
  milestoneTitles: Map<number, string>;
  hasRoadmap: boolean;
  shipped: Milestone[];
  milestoneShown: Set<number>;
  updateForMilestone: Map<number, number>;
  // Link zu einem Update: Anker auf dieser Seite oder Dauerlink
  updateLink: (id: number) => string;
  invite: string;
  description: string;
}

// date('M j, Y') oder '' (strtotime ohne Ergebnis = 1. Januar 1970 wie in PHP)
export function fmtDate(dt: string | null): string {
  if (!phpTruthy(dt)) return '';
  const t = strtotime(dt as string);
  return date('M j, Y', t === false ? 0 : t);
}

export function updatesView(d: UpdatesPageData): string {
  let o = '';
  const { loggedIn, pageNo, lastPage, updates, columns, milestoneTitles, hasRoadmap, shipped, milestoneShown, updateForMilestone, updateLink, invite, description } = d;
  o += "<!DOCTYPE html>\n<html lang=\"en\" class=\"scroll-smooth\">\n<head>\n    <meta charset=\"UTF-8\">\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n    <!-- Die Seite ist schon dunkel: kein Nachtmodus des Browsers darüber (z. B. Brave, Dark Reader) -->\n    <meta name=\"color-scheme\" content=\"dark\">\n    <meta name=\"darkreader-lock\">\n    <title>Updates &amp; roadmap | OnYourSite</title>\n    <meta name=\"description\" content=\"";
  o += e(description);
  o += "\">\n    <meta property=\"og:type\" content=\"website\">\n    <meta property=\"og:url\" content=\"";
  o += e(mainUrl('/updates'));
  o += "\">\n    <meta property=\"og:title\" content=\"Updates &amp; roadmap | OnYourSite\">\n    <meta property=\"og:description\" content=\"";
  o += e(description);
  o += "\">\n    <meta property=\"og:image\" content=\"";
  o += e(mainUrl('/static/images/banner-onyoursite.png'));
  o += "\">\n    <link rel=\"alternate\" type=\"application/atom+xml\" title=\"OnYourSite updates\" href=\"/updates/feed.xml\">\n    <link rel=\"icon\" type=\"image/png\" href=\"/static/images/favicon.png\">\n    <link href=\"https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap\" rel=\"stylesheet\">\n    <link rel=\"stylesheet\" href=\"";
  o += e(asset('/static/vendor/boxicons/css/boxicons.min.css'));
  o += "\">\n    <script src=\"https://cdn.tailwindcss.com\"></script>\n    <script>\n        tailwind.config = {\n            theme: {\n                extend: {\n                    fontFamily: { sans: ['Inter', 'sans-serif'] },\n                    colors: {\n                        background: '#09090b',\n                        card: '#18181b',\n                        bordercolor: 'rgba(255, 255, 255, 0.08)',\n                        brand: { 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5' }\n                    }\n                }\n            }\n        }\n    </script>\n    <style>\n        /* Text aus dem Admin (einfaches Markdown) */\n        .md { color: #d4d4d8; line-height: 1.7; overflow-wrap: anywhere; }\n        .md > * + * { margin-top: .7em; }\n        .md ul { list-style: disc; padding-left: 1.25em; }\n        .md ol { list-style: decimal; padding-left: 1.4em; }\n        .md li + li { margin-top: .3em; }\n        .md li::marker { color: #6366f1; }\n        .md strong { color: #fff; font-weight: 600; }\n        .md a { color: #a5b4fc; text-decoration: underline; text-underline-offset: 3px; }\n        .md a:hover { color: #fff; }\n        .md h4 { color: #fff; font-weight: 700; font-size: 1.05em; margin-top: 1.1em; }\n        .md h5 { color: #fff; font-weight: 600; margin-top: 1em; }\n        .md code { background: rgba(255, 255, 255, .08); padding: .1em .35em; border-radius: 5px; font-size: .9em; }\n        .md pre { background: #0b0b0d; border: 1px solid rgba(255, 255, 255, .08); border-radius: 10px; padding: 12px 14px; overflow-x: auto; }\n        .md pre code { background: none; padding: 0; }\n        .md blockquote { border-left: 3px solid #3f3f46; padding-left: .9em; color: #a1a1aa; }\n        .md del { color: #71717a; }\n        .md-sm { font-size: .92rem; }\n        .bar { height: 6px; border-radius: 99px; background: rgba(255, 255, 255, .08); overflow: hidden; }\n        .bar > span { display: block; height: 100%; border-radius: inherit; }\n        details > summary { list-style: none; cursor: pointer; }\n        details > summary::-webkit-details-marker { display: none; }\n        @media (max-width: 639px) { .timeline-line { display: none; } }\n    </style>\n</head>\n<body class=\"bg-background text-gray-300 font-sans antialiased overflow-x-hidden selection:bg-brand-500/30\">\n\n    <nav class=\"fixed w-full z-50 top-0 backdrop-blur-md bg-background/80 border-b border-bordercolor\">\n        <div class=\"max-w-6xl mx-auto px-4 sm:px-6 lg:px-8\">\n            <div class=\"flex justify-between items-center h-16 sm:h-20\">\n                <a href=\"/\" class=\"flex items-center gap-2 transition-transform hover:scale-105\">\n                    <i class='bx bx-hive text-3xl text-brand-500'></i>\n                    <span class=\"font-bold text-xl text-white tracking-tight\">OnYourSite</span>\n                </a>\n                <div class=\"hidden md:flex items-center space-x-8\">\n                    <a href=\"/#features\" class=\"text-sm font-medium text-gray-400 hover:text-white transition-colors\">Features</a>\n                    <a href=\"/#designs\" class=\"text-sm font-medium text-gray-400 hover:text-white transition-colors\">Themes</a>\n                    <a href=\"/updates\" class=\"text-sm font-medium text-white\">Updates</a>\n                    <a href=\"";
  o += e(invite);
  o += "\" target=\"_blank\" rel=\"noopener\" class=\"text-sm font-medium text-[#5865F2] hover:text-[#4752C4] transition-colors flex items-center gap-1\"><i class='bx bxl-discord-alt text-lg'></i> Community</a>\n                    <div class=\"h-5 w-px bg-bordercolor\"></div>\n                    ";
  if (loggedIn) {
    o += "                    <a href=\"/dashboard\" class=\"text-sm font-medium bg-white text-black px-5 py-2.5 rounded-full hover:bg-gray-200 transition-all\">Open editor</a>\n                    ";
  } else {
    o += "                    <a href=\"/login\" class=\"text-sm font-medium text-white hover:text-brand-400 transition-colors\">Log in</a>\n                    <a href=\"/register\" class=\"text-sm font-medium bg-white text-black px-5 py-2.5 rounded-full hover:bg-gray-200 transition-all\">Start for free</a>\n                    ";
  }
  o += "                </div>\n                <a href=\"";
  o += loggedIn ? '/dashboard' : '/register';
  o += "\" class=\"md:hidden text-sm font-medium bg-white text-black px-4 py-2 rounded-full\">";
  o += loggedIn ? 'Editor' : 'Get started';
  o += "</a>\n            </div>\n        </div>\n    </nav>\n\n    <header class=\"relative pt-28 sm:pt-36 pb-10 sm:pb-14 px-4\">\n        <div class=\"absolute top-0 left-1/2 -translate-x-1/2 w-[700px] max-w-full h-[420px] bg-brand-500/15 rounded-full blur-[110px] -z-10 pointer-events-none\"></div>\n        <div class=\"max-w-3xl mx-auto text-center\">\n            <span class=\"inline-flex items-center gap-2 px-3 py-1 rounded-full border border-bordercolor bg-white/5 text-xs font-medium text-gray-300\"><span class=\"w-1.5 h-1.5 rounded-full bg-emerald-400\"></span> Changelog &amp; roadmap</span>\n            <h1 class=\"mt-5 text-4xl sm:text-6xl font-extrabold text-white tracking-tight\">What’s new at <span class=\"text-transparent bg-clip-text [-webkit-text-fill-color:transparent] box-decoration-clone bg-gradient-to-r from-brand-400 to-purple-400\">OnYourSite</span></h1>\n            <p class=\"mt-5 text-base sm:text-lg text-gray-400\">";
  o += e(description);
  o += "</p>\n            <div class=\"mt-8 flex flex-col sm:flex-row gap-3 justify-center\">\n                <a href=\"";
  o += e(invite);
  o += "\" target=\"_blank\" rel=\"noopener\" class=\"inline-flex justify-center items-center gap-2 bg-[#5865F2] hover:bg-[#4752C4] text-white px-6 py-3 rounded-full font-medium transition-colors\"><i class='bx bxl-discord-alt text-xl'></i> Get updates on Discord</a>\n                <a href=\"/updates/feed.xml\" class=\"inline-flex justify-center items-center gap-2 bg-card border border-bordercolor hover:border-brand-500/50 text-white px-6 py-3 rounded-full font-medium transition-colors\"><i class='bx bx-rss text-xl'></i> RSS feed</a>\n            </div>\n        </div>\n    </header>\n\n    <main class=\"max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pb-20 space-y-20\">\n\n        ";
  if (hasRoadmap) {
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
  }
  o += "\n        ";
  if (shipped.length) {
    o += "        <section id=\"shipped\" class=\"scroll-mt-24\">\n            <h2 class=\"text-xl sm:text-2xl font-bold text-white mb-5\">Recently shipped</h2>\n            <div class=\"grid gap-3 sm:grid-cols-2 lg:grid-cols-3\">\n                ";
    for (const m of shipped) {
      const uid = updateForMilestone.get(m.id) ?? null;
      o += "                <div id=\"milestone-";
      o += m.id;
      o += "\" class=\"flex gap-3 rounded-xl border border-bordercolor bg-card/50 p-4 scroll-mt-24\">\n                    <span class=\"w-9 h-9 rounded-lg bg-amber-500/10 text-amber-400 flex items-center justify-center shrink-0\"><i class='bx bx-rocket text-xl'></i></span>\n                    <div class=\"min-w-0\">\n                        <p class=\"font-medium text-white leading-snug\">";
      o += e(m.title);
      o += "</p>\n                        <p class=\"text-xs text-gray-500 mt-1\">Shipped ";
      o += e(fmtDate(phpTruthy(m.done_at) ? m.done_at : m.updated_at));
      if (uid) {
        o += " · <a href=\"";
        o += e(updateLink(uid));
        o += "\" class=\"text-brand-400 hover:text-white\">Read the update</a>";
      }
      o += "</p>\n                    </div>\n                </div>\n                ";
    }
    o += "            </div>\n        </section>\n        ";
  }
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
      if (u.milestone_id && milestoneShown.has(u.milestone_id)) {
        o += "                                <a href=\"#milestone-";
        o += u.milestone_id;
        o += "\" class=\"inline-flex items-center gap-1 text-xs text-gray-400 hover:text-white border border-bordercolor rounded-full px-2.5 py-1.5\"><i class='bx bx-flag'></i> ";
        o += e(milestoneTitles.get(u.milestone_id));
        o += "</a>\n                                ";
      } else if (u.milestone_id && milestoneTitles.has(u.milestone_id)) {
        o += "                                <span class=\"inline-flex items-center gap-1 text-xs text-gray-400 border border-bordercolor rounded-full px-2.5 py-1.5\"><i class='bx bx-flag'></i> ";
        o += e(milestoneTitles.get(u.milestone_id));
        o += "</span>\n                                ";
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
  o += "        </section>\n    </main>\n\n    <footer class=\"border-t border-bordercolor bg-[#050505] py-12\">\n        <div class=\"max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col items-center\">\n            <div class=\"flex items-center flex-wrap justify-center gap-x-4 mb-6 text-sm text-gray-500 font-medium\">\n                <a href=\"/\" class=\"inline-block py-2 hover:text-white transition-colors\">Home</a>\n                <span>&bull;</span>\n                <a href=\"/imprint\" class=\"inline-block py-2 hover:text-white transition-colors\">Legal notice</a>\n                <span>&bull;</span>\n                <a href=\"/privacy\" class=\"inline-block py-2 hover:text-white transition-colors\">Privacy</a>\n                <span>&bull;</span>\n                <a href=\"/terms\" class=\"inline-block py-2 hover:text-white transition-colors\">Terms</a>\n                <span>&bull;</span>\n                <a href=\"/terms/code-pages\" class=\"inline-block py-2 hover:text-white transition-colors\">Code page terms</a>\n            </div>\n            <p class=\"text-gray-500 text-sm\">&copy; ";
  o += date('Y');
  o += " OnYourSite. Made with <i class='bx bxs-heart text-red-500 mx-1'></i> for the community.</p>\n        </div>\n    </footer>\n</body>\n</html>\n";
  return o;
}
