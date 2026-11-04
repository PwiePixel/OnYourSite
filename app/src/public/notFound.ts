// 404-Seite (views/404.php): unbekannte Adresse. Ist der Name noch frei, wird er zum Sichern angeboten.
// Status 404 setzt diese Funktion selbst (Router, App-Routen und /_/…).
import type { Ctx } from '../web/ctx.js';
import { e } from '../html.js';
import { baseHost, mainUrl, slugProblem } from '../helpers.js';
import { date, phpRtrim, rawurlencode, strtolower } from '../php.js';
import { neutralNotFound } from '../domains/answers.js';
import { uiAssets } from '../views/partials/ui.js';

// Daten der Vorlage
export interface NotFoundData {
  isFree: boolean;
  requested: string;
  oysBase: string;
  mainUrl: string;
  year: string;
}

// Gewünschter Name: der Teil vor der Domain (name.on-your.site) oder der Pfad (on-your.site/name)
export async function notFoundData(ctx: Ctx): Promise<NotFoundData> {
  const oysHost = ctx.host;
  const oysBase = baseHost();
  let requested = '';
  if (oysHost !== '' && oysHost.endsWith('.' + oysBase)) {
    requested = oysHost.slice(0, oysHost.length - ('.' + oysBase).length);
  } else {
    const mm = /^\/([a-z0-9-]{2,30})\/?(?=\n?$)/.exec(strtolower(ctx.path));
    if (mm) requested = mm[1];
  }
  const isFree = requested !== '' && (await slugProblem(requested)) === null;
  return { isFree, requested, oysBase, mainUrl: phpRtrim(mainUrl('/'), '/'), year: date('Y') };
}

// http_response_code(404); require views/404.php; exit;
export async function notFound(ctx: Ctx): Promise<void> {
  // Auf einer eigenen Domain (Premium) nie die OnYourSite-Seite, sondern die neutrale 404
  if (ctx.customDomain) neutralNotFound(ctx);
  const d = await notFoundData(ctx);
  // OnYourSites eigene 404-Seite bekommt das Saison-Thema (Admin → Seasons) – nur unter der eigenen Domain; ein fremder
  // Hostname bleibt ohne Datenbank-Abfrage
  if (ctx.host === baseHost() || ctx.host.endsWith('.' + baseHost())) ctx.seasonPage = true;
  ctx.send(notFoundView(d), 404);
}

// views/404.php – der feste Text ist Byte für Byte übernommen (view2ts)
export function notFoundView(d: NotFoundData): string {
  let o = '';
  o += "<!DOCTYPE html>\n<html lang=\"en\" class=\"scroll-smooth\">\n<head>\n    <meta charset=\"UTF-8\">\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n    <!-- Die Seite ist schon dunkel: kein Nachtmodus des Browsers darüber (z. B. Brave, Dark Reader) -->\n    <meta name=\"color-scheme\" content=\"dark\">\n    <meta name=\"darkreader-lock\">\n    <title>";
  o += (d.isFree ? 'Address available' : 'Not found');
  o += " | OnYourSite</title>\n    <link rel=\"icon\" type=\"image/png\" href=\"/static/images/favicon.png\">\n    <link href=\"https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap\" rel=\"stylesheet\">\n    <link rel=\"stylesheet\" href=\"/static/vendor/boxicons/css/boxicons.min.css\">\n    <script src=\"https://cdn.tailwindcss.com\"></script>\n    \n    <script>\n        tailwind.config = {\n            theme: {\n                extend: {\n                    fontFamily: { sans: ['Inter', 'sans-serif'], },\n                    colors: {\n                        background: '#09090b', \n                        card: '#18181b',\n                        bordercolor: 'rgba(255, 255, 255, 0.08)',\n                        brand: { 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5', }\n                    }\n                }\n            }\n        }\n    </script>\n" + "    " + uiAssets('app', { toastTop: 96 }) + "\n</head>\n<body class=\"bg-background text-gray-300 font-sans antialiased overflow-x-hidden selection:bg-brand-500/30 flex flex-col min-h-screen\">\n\n    <nav class=\"fixed w-full z-50 top-0 transition-all duration-300 backdrop-blur-md bg-background/80 border-b border-bordercolor\">\n        <div class=\"max-w-7xl mx-auto px-4 sm:px-6 lg:px-8\">\n            <div class=\"flex justify-between items-center h-20\">\n                <a href=\"";
  o += e(d.mainUrl);
  o += "/\" class=\"flex-shrink-0 flex items-center gap-2 cursor-pointer transition-transform hover:scale-105\">\n                    <i class='bx bx-hive text-3xl text-brand-500'></i>\n                    <span class=\"font-bold text-xl text-white tracking-tight\">OnYourSite</span>\n                </a>\n                <div class=\"hidden md:flex items-center space-x-8\">\n                    <a href=\"";
  o += e(d.mainUrl);
  o += "/#features\" class=\"text-sm font-medium text-gray-400 hover:text-white transition-colors\">Features</a>\n                    <a href=\"";
  o += e(d.mainUrl);
  o += "/#how-it-works\" class=\"text-sm font-medium text-gray-400 hover:text-white transition-colors\">How it works</a>\n                    <div class=\"h-5 w-px bg-bordercolor\"></div>\n                    <a href=\"";
  o += e(d.mainUrl);
  o += "/login\" class=\"text-sm font-medium text-white hover:text-brand-400 transition-colors\">Log in</a>\n                    <a href=\"";
  o += e(d.mainUrl);
  o += "/register";
  o += (d.isFree ? '?name=' + rawurlencode(d.requested) : '');
  o += "\" class=\"text-sm font-medium bg-white text-black px-5 py-2.5 rounded-full hover:bg-gray-200 transition-all duration-300 transform hover:scale-105 shadow-[0_0_15px_rgba(255,255,255,0.1)]\">\n                        Start for free\n                    </a>\n                </div>\n            </div>\n        </div>\n    </nav>\n\n    <main class=\"relative flex-1 flex flex-col items-center justify-center pt-32 pb-20 lg:pt-48 lg:pb-32 overflow-hidden\">\n        <div class=\"absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-brand-500/20 rounded-full blur-[120px] -z-10 pointer-events-none\"></div>\n        \n        <div class=\"max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center relative z-10\">\n            \n            ";
  if (d.isFree) {
    o += "            <div class=\"inline-flex items-center gap-2 px-3 py-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 backdrop-blur-sm text-xs font-medium text-emerald-400 mb-8\">\n                <span class=\"flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse\"></span>\n                This address is available\n            </div>\n            <h1 class=\"text-5xl md:text-7xl font-extrabold text-white tracking-tight mb-6 break-all\">\n                <span class=\"bg-clip-text text-transparent [-webkit-text-fill-color:transparent] box-decoration-clone bg-gradient-to-r from-brand-400 to-purple-500\">\n                    ";
    o += e(d.requested);
    o += ".";
    o += e(d.oysBase);
    o += "                </span>\n            </h1>\n            <p class=\"mt-4 max-w-2xl mx-auto text-lg md:text-xl text-gray-400 mb-10 leading-relaxed\">\n                Nothing here yet. Claim this exact address and start your own page in seconds.\n            </p>\n            ";
  } else {
    o += "            <div class=\"inline-flex items-center gap-2 px-3 py-1 rounded-full border border-bordercolor bg-white/5 text-xs font-medium text-gray-400 mb-8\">404</div>\n            <h1 class=\"text-5xl md:text-7xl font-extrabold text-white tracking-tight mb-6 drop-shadow-lg\">Page not found</h1>\n            <p class=\"mt-4 max-w-2xl mx-auto text-lg md:text-xl text-gray-400 mb-10 leading-relaxed\">\n                This address doesn’t exist (anymore). Maybe the name has changed?\n            </p>\n            ";
  }
  o += "            \n            <div class=\"flex flex-col sm:flex-row justify-center items-center gap-4\">\n                <a href=\"";
  o += e(d.mainUrl);
  o += "/register";
  o += (d.isFree ? '?name=' + rawurlencode(d.requested) : '');
  o += "\" class=\"w-full sm:w-auto inline-flex justify-center items-center gap-2 bg-brand-500 hover:bg-brand-600 text-white px-8 py-3.5 rounded-full font-semibold transition-all duration-300 shadow-[0_0_30px_rgba(99,102,241,0.3)] hover:shadow-[0_0_40px_rgba(99,102,241,0.5)] transform hover:-translate-y-1\">\n                    ";
  o += (d.isFree ? 'Claim it now' : 'Create your own page');
  o += " <i class='bx bx-rocket text-xl'></i>\n                </a>\n                <a href=\"";
  o += e(d.mainUrl);
  o += "/\" class=\"w-full sm:w-auto inline-flex justify-center items-center gap-2 bg-card border border-bordercolor hover:border-brand-500/50 text-white px-8 py-3.5 rounded-full font-medium transition-all duration-300\">\n                    Learn more\n                </a>\n            </div>\n            \n        </div>\n    </main>\n\n    <footer class=\"border-t border-bordercolor bg-[#050505] py-12 mt-auto relative z-10\">\n        <div class=\"max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col items-center\">\n            <div class=\"flex space-x-6 mb-8\">\n                <a href=\"#\" class=\"w-12 h-12 rounded-full bg-card border border-bordercolor flex items-center justify-center text-gray-400 hover:text-white hover:border-brand-500 hover:shadow-[0_0_15px_rgba(99,102,241,0.3)] transition-all duration-300\">\n                    <i class='bx bxl-twitter text-2xl'></i>\n                </a>\n                <a href=\"https://discord.gg/nNT8NnM6py\" target=\"_blank\" rel=\"noopener noreferrer\" class=\"w-12 h-12 rounded-full bg-card border border-bordercolor flex items-center justify-center text-gray-400 hover:text-[#5865F2] hover:border-[#5865F2] hover:shadow-[0_0_15px_rgba(88,101,242,0.3)] transition-all duration-300\">\n                    <i class='bx bxl-discord-alt text-2xl'></i>\n                </a>\n                <a href=\"#\" class=\"w-12 h-12 rounded-full bg-card border border-bordercolor flex items-center justify-center text-gray-400 hover:text-white hover:border-white transition-all duration-300\">\n                    <i class='bx bxl-github text-2xl'></i>\n                </a>\n            </div>\n\t\t\t<div class=\"flex items-center gap-4 mb-6 text-sm text-gray-500 font-medium\">\n                <a href=\"/imprint\" class=\"inline-block py-2 hover:text-white transition-colors\">Legal notice</a>\n                <span>&bull;</span>\n                <a href=\"/privacy\" class=\"inline-block py-2 hover:text-white transition-colors\">Privacy</a>\n                <span>&bull;</span>\n                <a href=\"/terms\" class=\"inline-block py-2 hover:text-white transition-colors\">Terms</a>\n            </div>\n            <p class=\"text-gray-500 text-sm\">\n                &copy; ";
  o += d.year;
  o += " OnYourSite. Made with <i class='bx bxs-heart text-red-500 mx-1'></i> for the community.\n            </p>\n        </div>\n    </footer>\n\n</body>\n</html>";
  return o;
}
