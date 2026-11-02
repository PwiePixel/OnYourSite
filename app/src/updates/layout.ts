// Gemeinsamer Rahmen für die öffentlichen Seiten /updates, /roadmap und /suggestions: Kopf mit Titel,
// Beschreibung und kanonischer Adresse, Navigation, Hero mit Unternavigation und Fußzeile – dasselbe Aussehen wie
// bisher views/updates.php. Die Seiten setzen keine Cookies.
import { e } from '../html.js';
import { asset, mainUrl } from '../helpers.js';
import { date } from '../php.js';
import { uiAssets } from '../views/partials/ui.js';

export type Section = 'updates' | 'roadmap' | 'suggestions';

export interface LayoutOptions {
  section: Section;
  title: string; // z. B. „Roadmap | OnYourSite“
  description: string;
  canonical: string; // Pfad, z. B. /roadmap
  loggedIn: boolean;
  invite: string;
  // Platz für „Status“ in Navigation und Fußzeile (Statusseiten); ohne Wert erscheint nichts
  statusUrl?: string;
  // Skript, das vor allem anderen laufen soll (Weiterleitung alter Anker)
  headScript?: string;
  // Die Vorschlagsseite ist an: ihre Pille erscheint in der Unternavigation
  suggestions?: boolean;
  // <meta name="robots"> (z. B. gefilterte Ansichten: noindex, follow)
  robots?: string;
}

export interface HeroOptions {
  badge: string;
  // h1 als fertiges HTML (mit dem Verlauf-Span)
  headline: string;
  text: string;
  buttons: string;
}

export const GRADIENT = 'text-transparent bg-clip-text [-webkit-text-fill-color:transparent] box-decoration-clone bg-gradient-to-r from-brand-400 to-purple-400';
const BTN_DISCORD = 'inline-flex justify-center items-center gap-2 bg-[#5865F2] hover:bg-[#4752C4] text-white px-6 py-3 rounded-full font-medium transition-colors';
const BTN_CARD = 'inline-flex justify-center items-center gap-2 bg-card border border-bordercolor hover:border-brand-500/50 text-white px-6 py-3 rounded-full font-medium transition-colors';

export const discordButton = (invite: string, label: string, icon = 'bxl-discord-alt'): string =>
  `<a href="${e(invite)}" target="_blank" rel="noopener" class="${BTN_DISCORD}"><i class='bx ${icon} text-xl'></i> ${e(label)}</a>`;
export const cardButton = (href: string, label: string, icon: string): string =>
  `<a href="${e(href)}" class="${BTN_CARD}"><i class='bx ${icon} text-xl'></i> ${e(label)}</a>`;

// Unternavigation: Symbole erst ab sm (auf Telefonen passen die Pillen sonst nicht in die Zeile)
const PILLS: Array<{ section: Section; href: string; icon: string; label: string }> = [
  { section: 'updates', href: '/updates', icon: 'bx-news', label: 'Changelog' },
  { section: 'roadmap', href: '/roadmap', icon: 'bx-map-alt', label: 'Roadmap' },
  { section: 'suggestions', href: '/suggestions', icon: 'bx-bulb', label: 'Suggestions' },
];
// showSuggestions: die Pille „Suggestions“ nur, solange die Seite an ist
export function subNav(active: Section, showSuggestions = false): string {
  const pill = 'shrink-0 inline-flex items-center gap-1.5 px-3.5 sm:px-4 py-2 rounded-full text-sm font-medium';
  const links = PILLS.filter((p) => p.section !== 'suggestions' || showSuggestions || active === 'suggestions').map((p) => (p.section === active
    ? `<a href="${p.href}" aria-current="page" class="${pill} bg-white text-black"><i class='bx ${p.icon} hidden sm:inline-block'></i> ${p.label}</a>`
    : `<a href="${p.href}" class="${pill} text-gray-400 hover:text-white hover:bg-white/5 transition-colors"><i class='bx ${p.icon} hidden sm:inline-block'></i> ${p.label}</a>`));
  return `<nav aria-label="Updates sections" class="mt-8 inline-flex max-w-full overflow-x-auto [scrollbar-width:none] gap-1 p-1 rounded-full border border-bordercolor bg-card/60">
                ${links.join('\n                ')}
            </nav>`;
}

export function layoutPage(o: LayoutOptions, hero: HeroOptions, main: string): string {
  const canonical = mainUrl(o.canonical);
  return `<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <!-- Die Seite ist schon dunkel: kein Nachtmodus des Browsers darüber (z. B. Brave, Dark Reader) -->
    <meta name="color-scheme" content="dark">
    <meta name="darkreader-lock">
    <title>${e(o.title)}</title>
${o.headScript ? `    <script>${o.headScript}</script>\n` : ''}    <meta name="description" content="${e(o.description)}">
${o.robots ? `    <meta name="robots" content="${e(o.robots)}">\n` : ''}    <link rel="canonical" href="${e(canonical)}">
    <meta property="og:type" content="website">
    <meta property="og:url" content="${e(canonical)}">
    <meta property="og:title" content="${e(o.title)}">
    <meta property="og:description" content="${e(o.description)}">
    <meta property="og:image" content="${e(mainUrl('/static/images/banner-onyoursite.png'))}">
    <link rel="alternate" type="application/atom+xml" title="OnYourSite updates" href="/updates/feed.xml">
    <link rel="icon" type="image/png" href="/static/images/favicon.png">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="${e(asset('/static/vendor/boxicons/css/boxicons.min.css'))}">
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = {
            theme: {
                extend: {
                    fontFamily: { sans: ['Inter', 'sans-serif'] },
                    colors: {
                        background: '#09090b',
                        card: '#18181b',
                        bordercolor: 'rgba(255, 255, 255, 0.08)',
                        brand: { 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5' }
                    }
                }
            }
        }
    </script>
    <style>
        /* Text aus dem Admin (einfaches Markdown) */
        .md { color: #d4d4d8; line-height: 1.7; overflow-wrap: anywhere; }
        .md > * + * { margin-top: .7em; }
        .md ul { list-style: disc; padding-left: 1.25em; }
        .md ol { list-style: decimal; padding-left: 1.4em; }
        .md li + li { margin-top: .3em; }
        .md li::marker { color: #6366f1; }
        .md strong { color: #fff; font-weight: 600; }
        .md a { color: #a5b4fc; text-decoration: underline; text-underline-offset: 3px; }
        .md a:hover { color: #fff; }
        .md h4 { color: #fff; font-weight: 700; font-size: 1.05em; margin-top: 1.1em; }
        .md h5 { color: #fff; font-weight: 600; margin-top: 1em; }
        .md code { background: rgba(255, 255, 255, .08); padding: .1em .35em; border-radius: 5px; font-size: .9em; }
        .md pre { background: #0b0b0d; border: 1px solid rgba(255, 255, 255, .08); border-radius: 10px; padding: 12px 14px; overflow-x: auto; }
        .md pre code { background: none; padding: 0; }
        .md blockquote { border-left: 3px solid #3f3f46; padding-left: .9em; color: #a1a1aa; }
        .md del { color: #71717a; }
        .md-sm { font-size: .92rem; }
        .bar { height: 6px; border-radius: 99px; background: rgba(255, 255, 255, .08); overflow: hidden; }
        .bar > span { display: block; height: 100%; border-radius: inherit; }
        details > summary { list-style: none; cursor: pointer; }
        details > summary::-webkit-details-marker { display: none; }
        @media (max-width: 639px) { .timeline-line { display: none; } }
    </style>
    ${uiAssets('app', { toastTop: 96 })}
</head>
<body class="bg-background text-gray-300 font-sans antialiased overflow-x-hidden selection:bg-brand-500/30">

    <nav class="fixed w-full z-50 top-0 backdrop-blur-md bg-background/80 border-b border-bordercolor">
        <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
            <div class="flex justify-between items-center h-16 sm:h-20">
                <a href="/" class="flex items-center gap-2 transition-transform hover:scale-105">
                    <i class='bx bx-hive text-3xl text-brand-500'></i>
                    <span class="font-bold text-xl text-white tracking-tight">OnYourSite</span>
                </a>
                <div class="hidden md:flex items-center space-x-8">
                    <a href="/#features" class="text-sm font-medium text-gray-400 hover:text-white transition-colors">Features</a>
                    <a href="/#designs" class="text-sm font-medium text-gray-400 hover:text-white transition-colors">Themes</a>
                    <a href="/updates" class="text-sm font-medium text-white">Updates</a>
${o.statusUrl ? `                    <a href="${e(o.statusUrl)}" class="text-sm font-medium text-gray-400 hover:text-white transition-colors">Status</a>\n` : ''}                    <a href="${e(o.invite)}" target="_blank" rel="noopener" class="text-sm font-medium text-[#5865F2] hover:text-[#4752C4] transition-colors flex items-center gap-1"><i class='bx bxl-discord-alt text-lg'></i> Community</a>
                    <div class="h-5 w-px bg-bordercolor"></div>
${o.loggedIn
    ? `                    <a href="/dashboard" class="text-sm font-medium bg-white text-black px-5 py-2.5 rounded-full hover:bg-gray-200 transition-all">Open editor</a>\n`
    : `                    <a href="/login" class="text-sm font-medium text-white hover:text-brand-400 transition-colors">Log in</a>
                    <a href="/register" class="text-sm font-medium bg-white text-black px-5 py-2.5 rounded-full hover:bg-gray-200 transition-all">Start for free</a>\n`}                </div>
                <a href="${o.loggedIn ? '/dashboard' : '/register'}" class="md:hidden text-sm font-medium bg-white text-black px-4 py-2 rounded-full">${o.loggedIn ? 'Editor' : 'Get started'}</a>
            </div>
        </div>
    </nav>

    <header class="relative pt-28 sm:pt-36 pb-10 sm:pb-14 px-4">
        <div class="absolute top-0 left-1/2 -translate-x-1/2 w-[700px] max-w-full h-[420px] bg-brand-500/15 rounded-full blur-[110px] -z-10 pointer-events-none"></div>
        <div class="max-w-3xl mx-auto text-center">
            <span class="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-bordercolor bg-white/5 text-xs font-medium text-gray-300"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> ${e(hero.badge)}</span>
            <h1 class="mt-5 text-4xl sm:text-6xl font-extrabold text-white tracking-tight">${hero.headline}</h1>
            <p class="mt-5 text-base sm:text-lg text-gray-400">${e(hero.text)}</p>
            <div class="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
                ${hero.buttons}
            </div>
            ${subNav(o.section, o.suggestions === true)}
        </div>
    </header>

    <main class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pb-20 space-y-20">
${main}
    </main>

    <footer class="border-t border-bordercolor bg-[#050505] py-12">
        <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col items-center">
            <div class="flex items-center flex-wrap justify-center gap-x-4 mb-6 text-sm text-gray-500 font-medium">
                <a href="/" class="inline-block py-2 hover:text-white transition-colors">Home</a>
                <span>&bull;</span>
                <a href="/imprint" class="inline-block py-2 hover:text-white transition-colors">Legal notice</a>
                <span>&bull;</span>
                <a href="/privacy" class="inline-block py-2 hover:text-white transition-colors">Privacy</a>
                <span>&bull;</span>
                <a href="/terms" class="inline-block py-2 hover:text-white transition-colors">Terms</a>
                <span>&bull;</span>
                <a href="/terms/code-pages" class="inline-block py-2 hover:text-white transition-colors">Code page terms</a>
${o.statusUrl ? `                <span>&bull;</span>\n                <a href="${e(o.statusUrl)}" class="inline-block py-2 hover:text-white transition-colors">Status</a>\n` : ''}            </div>
            <p class="text-gray-500 text-sm">&copy; ${date('Y')} OnYourSite. Made with <i class='bx bxs-heart text-red-500 mx-1'></i> for the community.</p>
        </div>
    </footer>
</body>
</html>
`;
}
