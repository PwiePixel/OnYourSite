// Admin-Panel (views/admin.php): Rahmen, Nutzerverwaltung, Newsletter, Mail-Server, Passwort-Dialog und Skripte.
// Seit der Trennung sind Honigwaben und Code-Seiten zwei Bereiche (zwei Einträge in der Navigation, ADMIN_TABS).
// Die Teile für Updates/Roadmap/Discord, Community, Honigwaben, Code-Seiten und Speicher kommen fertig als HTML herein; die 12
// Leerzeichen, die admin.php vor jedes require schreibt, stehen hier im Text. Der Text außerhalb der PHP-Teile ist Byte
// für Byte übernommen (view2ts): die Datei hat kein abschließendes Zeilenende und 32 Zeilen mit Leerzeichen am Ende.
import type { Row } from '../../db.js';
import { e } from '../../html.js';
import { asset, mainUrl, pageDisplayUrl, pageUrl, type PageLike } from '../../helpers.js';
import { date, intval, phpStr, phpTruthy, strtotime } from '../../php.js';
import { phpCastString, PhpArr, type PhpJson } from '../../community/json.js';
import { confirmAttrs, confirmField, flashMarkup, uiAssets } from '../../views/partials/ui.js';
import { appVersion } from '../../version.js';

export interface AdminViewData {
  // oys_csrf_field() – überall dasselbe Feld
  csrfField: string;
  // $_SESSION['admin_success'] / ['admin_error'] (schon aus der Sitzung genommen; undefined = nicht gesetzt)
  flashSuccess: unknown;
  flashError: unknown;
  // $_SESSION['user_id'] (für den eigenen Eintrag in der Tabelle)
  sessionUserId: unknown;
  // $all_users: id, full_name, email, username, discord_id (entschlüsselt), is_admin, created_at – neueste zuerst
  allUsers: Row[];
  // $pagesByUser: Seiten je Nutzer (position, id)
  pagesByUser: Map<number, Row[]>;
  totalUsers: number;
  totalDomains: number;
  totalPages: number;
  totalAdmins: number;
  // Dateinamen der Vorlagen in email/ (ohne smtp.json)
  templates: string[];
  // json_decode(email/smtp.json, true) – ohne Datei ein leeres Array
  smtpConfig: PhpJson;
  // Ausgabe der eingebundenen Vorlagen admin_updates, admin_community, admin_honeycombs, admin_storage und des
  // Bereichs Code-Seiten (code/adminView.ts)
  updatesHtml: string;
  communityHtml: string;
  honeycombsHtml: string;
  codePagesHtml: string;
  // Bereich eigene Domains (domains/adminView.ts, PD-5)
  domainsHtml: string;
  // Bereich Statusseiten (status/adminView.ts)
  statusHtml: string;
  // Admin → Seasons (seasons/admin.ts)
  seasonsHtml: string;
  // Admin → Beta (beta/admin.ts)
  betaHtml: string;
  storageHtml: string;
  // Glocke im Kopf (bellMarkup(), dasselbe Markup wie im Editor)
  bellHtml: string;
}

// isset(): gesetzt und nicht null
const isset = (v: unknown): boolean => v !== undefined && v !== null;

// addslashes(): ' " \\ und das Nullbyte bekommen einen Backslash (das Nullbyte als \\0)
export const addslashes = (s: string): string => s.replace(/[\\'"\0]/g, (c) => (c === '\0' ? '\\0' : '\\' + c));

// date('M j, Y', strtotime($v ?? 'now')) – ungültige Angaben wie date(…, false), also 1970; der Zeitstempel
// 0000-00-00 00:00:00 ergibt wie in PHP "Nov 30, -0001"
export function joined(v: unknown): string {
  const t = strtotime(v === null || v === undefined ? 'now' : phpStr(v));
  return date('M j, Y', t === false ? 0 : t);
}

// htmlspecialchars($smtp_config['key'] ?? ''): fehlende Werte (oder kein Array) → '', Zahlen und true als Text;
// ein Array ist in PHP ein TypeError (die Seite endet mit 500)
export function smtpValue(config: PhpJson, key: string): string {
  const v = config instanceof PhpArr ? config.get(key) : undefined;
  if (v instanceof PhpArr) throw new TypeError('htmlspecialchars(): Argument #1 ($string) must be of type string, array given');
  return e(phpCastString(v ?? null));
}

// Ein TypeError mitten in der Seite (z. B. ein Array in einer von Hand bearbeiteten smtp.json): PHP hat den Anfang
// schon gesendet (Status 200) und gibt danach nichts mehr aus. html ist die Ausgabe bis zu dieser Stelle.
export class CutOffPage extends Error {
  constructor(readonly html: string, readonly reason: unknown) {
    super('admin page cut off');
  }
}

// smtpValue() an seiner Stelle in der Seite: wirft PHP dort, endet die Seite mit dem, was davor steht
function smtpField(before: string, config: PhpJson, key: string): string {
  try {
    return smtpValue(config, key);
  } catch (err) {
    throw new CutOffPage(before, err);
  }
}

// Name für Rückfragen: der volle Name, sonst die E-Mail-Adresse
const who = (u: Row): string => (phpStr(u.full_name) !== '' ? phpStr(u.full_name) : phpStr(u.email));

// $u['id'] === $_SESSION['user_id']: beide sind in PHP int – nur dann gleich
const sameId = (id: unknown, sessionId: unknown): boolean => typeof id === 'number' && typeof sessionId === 'number' && id === sessionId;

export function adminView(d: AdminViewData): string {
  let o = '';
  o += "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n    <meta charset=\"UTF-8\">\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n    <meta name=\"robots\" content=\"noindex, nofollow\">\n    <!-- Die Seite ist schon dunkel: kein Nachtmodus des Browsers darüber (z. B. Brave, Dark Reader) -->\n    <meta name=\"color-scheme\" content=\"dark\">\n    <meta name=\"darkreader-lock\">\n    <title>Admin Panel | OnYourSite</title>\n    <link rel=\"icon\" type=\"image/png\" href=\"/static/images/favicon.png\">\n    <link href=\"https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap\" rel=\"stylesheet\">\n    <link href='https://unpkg.com/boxicons@2.1.4/css/boxicons.min.css' rel='stylesheet'>\n    <script src=\"https://cdn.tailwindcss.com\"></script>\n    <script>\n        tailwind.config = { \n            theme: { \n                extend: { \n                    fontFamily: { sans: ['Inter', 'sans-serif'], },\n                    colors: { \n                        background: '#000000', card: '#0a0a0a', inputbg: '#121212', bordercolor: '#27272a',\n                        brand: { 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5', } \n                    } \n                } \n            } \n        }\n    </script>\n" + "    " + uiAssets('app') + "\n    <script src=\"" + e(asset('/static/js/bell.js')) + "\" defer></script>\n</head>\n<body class=\"bg-background text-gray-300 font-sans h-screen flex overflow-hidden selection:bg-brand-500/30\">\n\n    <aside class=\"w-20 lg:w-64 border-r border-bordercolor bg-card flex flex-col justify-between py-6 transition-all z-20 shrink-0\">\n        <div>\n            <a href=\"";
  o += e(mainUrl('/'));
  o += "\" class=\"px-6 mb-8 flex items-center gap-2 cursor-pointer transition-transform hover:scale-105 group block\">\n                <div class=\"w-8 h-8 rounded-lg bg-gradient-to-br from-brand-500 to-purple-600 flex items-center justify-center shadow-lg shadow-brand-500/20\">\n                    <i class='bx bx-hive text-xl text-white'></i>\n                </div>\n                <span class=\"font-bold text-xl text-white tracking-tight hidden lg:block\">OnYourSite</span>\n            </a>\n            \n            <div class=\"px-4 mb-2 hidden lg:block\">\n                <p class=\"text-xs font-semibold text-gray-500 uppercase tracking-wider\">Admin Menu</p>\n            </div>\n            \n            <nav class=\"space-y-1 px-3\">\n                <a href=\"/dashboard\" class=\"flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/5 text-gray-400 hover:text-white transition-all\">\n                    <i class='bx bx-left-arrow-alt text-xl'></i> <span class=\"hidden lg:block text-sm\">Back to Dashboard</span>\n                </a>\n                \n                <div class=\"my-4 border-t border-bordercolor\"></div>\n\n                <button type=\"button\" onclick=\"switchAdminTab('users')\" id=\"nav-users\" class=\"admin-nav-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 font-medium transition-all shadow-inner\">\n                    <i class='bx bx-group text-xl'></i> <span class=\"hidden lg:block text-sm\">User Management</span>\n                </button>\n\n                <button type=\"button\" onclick=\"switchAdminTab('newsletter')\" id=\"nav-newsletter\" class=\"admin-nav-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-transparent hover:bg-white/5 text-gray-400 hover:text-white font-medium transition-all\">\n                    <i class='bx bx-envelope text-xl'></i> <span class=\"hidden lg:block text-sm\">Newsletter & Mails</span>\n                </button>\n\n                <button type=\"button\" onclick=\"switchAdminTab('mailserver')\" id=\"nav-mailserver\" class=\"admin-nav-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-transparent hover:bg-white/5 text-gray-400 hover:text-white font-medium transition-all\">\n                    <i class='bx bx-server text-xl'></i> <span class=\"hidden lg:block text-sm\">Mail Server</span>\n                </button>\n\n                <div class=\"my-4 border-t border-bordercolor\"></div>\n\n                <button type=\"button\" onclick=\"switchAdminTab('updates')\" id=\"nav-updates\" class=\"admin-nav-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-transparent hover:bg-white/5 text-gray-400 hover:text-white font-medium transition-all\">\n                    <i class='bx bx-news text-xl'></i> <span class=\"hidden lg:block text-sm\">Updates</span>\n                </button>\n\n                <button type=\"button\" onclick=\"switchAdminTab('roadmap')\" id=\"nav-roadmap\" class=\"admin-nav-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-transparent hover:bg-white/5 text-gray-400 hover:text-white font-medium transition-all\">\n                    <i class='bx bx-map-alt text-xl'></i> <span class=\"hidden lg:block text-sm\">Roadmap</span>\n                </button>\n\n                <button type=\"button\" onclick=\"switchAdminTab('discord')\" id=\"nav-discord\" class=\"admin-nav-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-transparent hover:bg-white/5 text-gray-400 hover:text-white font-medium transition-all\">\n                    <i class='bx bxl-discord-alt text-xl'></i> <span class=\"hidden lg:block text-sm\">Discord</span>\n                </button>\n\n                <div class=\"my-4 border-t border-bordercolor\"></div>\n\n                <button type=\"button\" onclick=\"switchAdminTab('community')\" id=\"nav-community\" class=\"admin-nav-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-transparent hover:bg-white/5 text-gray-400 hover:text-white font-medium transition-all\">\n                    <i class='bx bx-conversation text-xl'></i> <span class=\"hidden lg:block text-sm\">Community</span>\n                </button>\n\n                <button type=\"button\" onclick=\"switchAdminTab('honeycombs')\" id=\"nav-honeycombs\" class=\"admin-nav-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-transparent hover:bg-white/5 text-gray-400 hover:text-white font-medium transition-all\">\n                    <i class='bx bx-hive text-xl text-yellow-400'></i> <span class=\"hidden lg:block text-sm\">Honeycombs</span>\n                </button>\n\n                <button type=\"button\" onclick=\"switchAdminTab('code-pages')\" id=\"nav-code-pages\" class=\"admin-nav-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-transparent hover:bg-white/5 text-gray-400 hover:text-white font-medium transition-all\">\n                    <i class='bx bx-code-alt text-xl'></i> <span class=\"hidden lg:block text-sm\">Code pages</span>\n                </button>\n\n                <button type=\"button\" onclick=\"switchAdminTab('domains')\" id=\"nav-domains\" class=\"admin-nav-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-transparent hover:bg-white/5 text-gray-400 hover:text-white font-medium transition-all\">\n                    <i class='bx bx-globe text-xl'></i> <span class=\"hidden lg:block text-sm\">Custom domains</span>\n                </button>\n\n                <button type=\"button\" onclick=\"switchAdminTab('status')\" id=\"nav-status\" class=\"admin-nav-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-transparent hover:bg-white/5 text-gray-400 hover:text-white font-medium transition-all\">\n                    <i class='bx bx-pulse text-xl'></i> <span class=\"hidden lg:block text-sm\">Status pages</span>\n                </button>\n                <button type=\"button\" onclick=\"switchAdminTab('seasons')\" id=\"nav-seasons\" class=\"admin-nav-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-transparent hover:bg-white/5 text-gray-400 hover:text-white font-medium transition-all\">\n                    <i class='bx bx-calendar-star text-xl'></i> <span class=\"hidden lg:block text-sm\">Seasons</span>\n                </button>\n                <button type=\"button\" onclick=\"switchAdminTab('beta')\" id=\"nav-beta\" class=\"admin-nav-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-transparent hover:bg-white/5 text-gray-400 hover:text-white font-medium transition-all\">\n                    <i class='bx bx-test-tube text-xl'></i> <span class=\"hidden lg:block text-sm\">Beta</span>\n                </button>\n\n                <button type=\"button\" onclick=\"switchAdminTab('storage')\" id=\"nav-storage\" class=\"admin-nav-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-transparent hover:bg-white/5 text-gray-400 hover:text-white font-medium transition-all\">\n                    <i class='bx bx-hdd text-xl'></i> <span class=\"hidden lg:block text-sm\">Storage &amp; backups</span>\n                </button>\n            </nav>\n        </div>\n        <div class=\"px-3\">\n            <p class=\"hidden lg:block px-3 pb-3 text-xs text-gray-600\" title=\"Installed version – see CHANGELOG.md\">OnYourSite v";
  o += e(appVersion());
  o += "</p>\n            <form method=\"post\" action=\"/logout\" class=\"m-0\">";
  o += d.csrfField;
  o += "                <button type=\"submit\" class=\"w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-red-500/10 text-gray-500 hover:text-red-400 transition-colors\">\n                    <i class='bx bx-log-out text-xl'></i> <span class=\"hidden lg:block text-sm\">Log Out</span>\n                </button>\n            </form>\n        </div>\n    </aside>\n\n    <div class=\"flex-1 flex flex-col h-full overflow-hidden w-full bg-background relative\">\n        \n        <header class=\"h-16 border-b border-bordercolor bg-background/80 backdrop-blur-md flex items-center justify-between px-8 shrink-0 z-10\">\n            <div class=\"flex items-center gap-3\">\n                <h1 class=\"text-lg font-semibold text-white tracking-tight\" id=\"admin-page-title\">User Management</h1>\n                <span class=\"bg-emerald-500/20 text-emerald-400 text-[10px] uppercase px-2 py-0.5 rounded border border-emerald-500/30 font-bold flex items-center gap-1\"><i class='bx bxs-shield'></i> System Admin</span>\n            </div>\n            <div class=\"flex items-center gap-4\">\n                ";
  o += d.bellHtml;
  o += "\n                <a href=\"";
  o += e(mainUrl('/'));
  o += "\" target=\"_blank\" class=\"text-sm text-gray-400 hover:text-brand-400 hidden sm:flex items-center gap-1.5 transition-colors bg-white/5 px-3 py-1.5 rounded-md border border-bordercolor hover:border-brand-500/30\">\n                    View Live Site <i class='bx bx-link-external'></i>\n                </a>\n            </div>\n        </header>\n\n        ";
  if (isset(d.flashSuccess)) {
    o += flashMarkup('ok', d.flashSuccess);
  }
  o += "        ";
  if (isset(d.flashError)) {
    o += flashMarkup('err', d.flashError);
  }
  o += "\n        <main class=\"flex-1 overflow-y-auto p-4 md:p-8 custom-scrollbar relative\">\n            \n            <div id=\"tab-users\" class=\"admin-tab-content max-w-7xl mx-auto space-y-8 block\">\n                <div class=\"grid grid-cols-1 md:grid-cols-3 gap-6\">\n                    <div class=\"bg-card border border-bordercolor rounded-xl p-6 flex items-center gap-4\">\n                        <div class=\"w-12 h-12 rounded-lg bg-brand-500/10 border border-brand-500/20 flex items-center justify-center text-brand-400\"><i class='bx bx-group text-2xl'></i></div>\n                        <div><p class=\"text-sm text-gray-500 font-medium mb-1\">Total Users</p><h3 class=\"text-2xl font-bold text-white\">";
  o += String(d.totalUsers);
  o += "</h3></div>\n                    </div>\n                    <div class=\"bg-card border border-bordercolor rounded-xl p-6 flex items-center gap-4\">\n                        <div class=\"w-12 h-12 rounded-lg bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400\"><i class='bx bx-globe text-2xl'></i></div>\n                        <div><p class=\"text-sm text-gray-500 font-medium mb-1\">Claimed Domains / Pages</p><h3 class=\"text-2xl font-bold text-white\">";
  o += String(d.totalDomains);
  o += " <span class=\"text-base text-gray-500\">/ ";
  o += String(d.totalPages);
  o += "</span></h3></div>\n                    </div>\n                    <div class=\"bg-card border border-bordercolor rounded-xl p-6 flex items-center gap-4\">\n                        <div class=\"w-12 h-12 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400\"><i class='bx bx-shield-check text-2xl'></i></div>\n                        <div><p class=\"text-sm text-gray-500 font-medium mb-1\">System Admins</p><h3 class=\"text-2xl font-bold text-white\">";
  o += String(d.totalAdmins);
  o += "</h3></div>\n                    </div>\n                </div>\n\n                <div class=\"bg-card border border-bordercolor rounded-xl overflow-hidden shadow-xl\">\n                    <div class=\"p-6 border-b border-bordercolor flex justify-between items-center bg-inputbg/50\">\n                        <h2 class=\"text-base font-semibold text-white\">User Database</h2>\n                        <div class=\"relative\">\n                            <i class='bx bx-search absolute left-3 top-1/2 -translate-y-1/2 text-gray-500'></i>\n                            <input type=\"text\" id=\"searchInput\" onkeyup=\"filterTable()\" placeholder=\"Search users...\" class=\"bg-background border border-bordercolor rounded-lg pl-10 pr-4 py-2 text-sm text-white focus:outline-none focus:border-brand-500 transition-colors w-64 shadow-inner\">\n                        </div>\n                    </div>\n\n                    <div class=\"overflow-x-auto\">\n                        <table class=\"w-full text-left border-collapse\" id=\"userTable\">\n                            <thead>\n                                <tr class=\"bg-card border-b border-bordercolor text-xs uppercase text-gray-500 font-semibold tracking-wider\">\n                                    <th class=\"px-6 py-4\">ID</th>\n                                    <th class=\"px-6 py-4\">User Info</th>\n                                    <th class=\"px-6 py-4\">Domain & Integrations</th>\n                                    <th class=\"px-6 py-4\">Role</th>\n                                    <th class=\"px-6 py-4 text-right\">Actions</th>\n                                </tr>\n                            </thead>\n                            <tbody class=\"divide-y divide-bordercolor\">\n                                ";
  for (const u of d.allUsers) {
    o += "                                <tr class=\"hover:bg-white/5 transition-colors group\">\n                                    <td class=\"px-6 py-4 text-gray-500 text-xs font-mono\">#";
    o += phpStr(u.id);
    o += "</td>\n                                    <td class=\"px-6 py-4\">\n                                        <div class=\"flex flex-col\">\n                                            <span class=\"text-white font-medium text-sm search-target flex items-center gap-1.5\">\n                                                ";
    o += e(u.full_name);
    o += "                                                ";
    if (phpTruthy(u.is_admin)) {
      o += "<i class='bx bxs-shield text-emerald-400' title='Admin'></i>";
    }
    o += "                                            </span>\n                                            <span class=\"text-gray-500 text-xs search-target\">";
    o += e(u.email);
    o += "</span>\n                                            <span class=\"text-gray-600 text-[10px] mt-1\">Joined: ";
    o += joined(u.created_at);
    o += "</span>\n                                        </div>\n                                    </td>\n                                    <td class=\"px-6 py-4\">\n                                        <div class=\"flex flex-col gap-1.5\">\n                                            ";
    const pages = d.pagesByUser.get(intval(u.id)) ?? [];
    if (pages.length > 0) {
      o += "                                                ";
      for (const pg of pages) {
        o += "                                                <a href=\"";
        o += e(pageUrl(pg as unknown as PageLike));
        o += "\" target=\"_blank\" class=\"text-brand-400 hover:text-brand-300 text-xs flex items-center gap-1 transition-colors search-target font-mono\"><i class='bx bx-globe'></i> ";
        o += e(pageDisplayUrl(pg as unknown as PageLike));
        o += " <span class=\"text-gray-600\">(";
        o += String(intval(pg.views));
        o += " views)</span></a>\n                                                ";
      }
      o += "                                            ";
    } else {
      o += "                                                <span class=\"text-gray-600 text-xs italic\"><i class='bx bx-ghost'></i> No domain</span>\n                                            ";
    }
    o += "                                            ";
    if (phpTruthy(u.discord_id)) {
      o += "                                                <span class=\"text-[#5865F2] text-[10px] flex items-center gap-1 font-mono search-target\"><i class='bx bxl-discord-alt'></i> ";
      o += e(u.discord_id);
      o += "</span>\n                                            ";
    }
    o += "                                        </div>\n                                    </td>\n                                    <td class=\"px-6 py-4\">\n                                        ";
    if (phpTruthy(u.is_admin)) {
      o += "                                            <span class=\"inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 uppercase tracking-wider\"><i class='bx bx-shield-check'></i> Admin</span>\n                                        ";
    } else {
      o += "                                            <span class=\"inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-gray-800 text-gray-400 border border-gray-700 uppercase tracking-wider\"><i class='bx bx-user'></i> User</span>\n                                        ";
    }
    o += "                                    </td>\n                                    <td class=\"px-6 py-4 text-right\">\n                                        <div class=\"flex justify-end items-center gap-2\">\n                                            \n                                            ";
    if (intval(u.id) !== intval(d.sessionUserId)) {
      o += "                                            <form action=\"/admin_impersonate.php\" method=\"POST\" class=\"inline-block m-0 p-0\"";
      o += confirmAttrs({ title: 'Log in as ' + who(u) + '?', text: 'You’ll see the editor as this user. “Back to admin panel” brings you back.', ok: 'Log in as user' });
      o += ">";
      o += d.csrfField + confirmField();
      o += "                                                <input type=\"hidden\" name=\"id\" value=\"";
      o += String(intval(u.id));
      o += "\">\n                                                <button type=\"submit\" class=\"p-1.5 text-gray-500 hover:text-brand-400 hover:bg-brand-500/10 rounded-md transition-all shadow-sm border border-transparent hover:border-brand-500/20\" title=\"Login as this User\">\n                                                    <i class='bx bx-log-in-circle text-lg'></i>\n                                                </button>\n                                            </form>\n                                            ";
    }
    o += "\n                                            <button type=\"button\" data-pwd-reset=\"";
    o += phpStr(u.id);
    o += "\" data-name=\"";
    o += e(u.full_name);
    o += "\" class=\"p-1.5 text-gray-500 hover:text-white hover:bg-white/10 rounded-md transition-all shadow-sm border border-transparent hover:border-bordercolor\" title=\"Force Password Reset\"><i class='bx bx-key text-lg'></i></button>\n                                            \n                                            <form action=\"/admin\" method=\"POST\" class=\"inline-block m-0 p-0\"";
    o += phpTruthy(u.is_admin)
      ? confirmAttrs({ title: 'Remove admin rights from ' + who(u) + '?', text: who(u) + ' loses access to the admin panel.', ok: 'Remove admin rights', tone: 'warn' })
      : confirmAttrs({ title: 'Make ' + who(u) + ' an admin?', text: 'Admins can see and change everything.', ok: 'Make admin', tone: 'warn' });
    o += ">";
    o += d.csrfField + confirmField();
    o += "                                                <input type=\"hidden\" name=\"toggle_admin_id\" value=\"";
    o += phpStr(u.id);
    o += "\">\n                                                <button type=\"submit\" class=\"p-1.5 text-gray-500 hover:text-emerald-400 hover:bg-emerald-500/10 rounded-md transition-all shadow-sm border border-transparent hover:border-emerald-500/20\" title=\"";
    o += phpTruthy(u.is_admin) ? 'Remove Admin Rights' : 'Make Admin';
    o += "\" ";
    o += sameId(u.id, d.sessionUserId) ? 'disabled class="p-1.5 text-gray-700 cursor-not-allowed"' : '';
    o += "><i class='bx ";
    o += phpTruthy(u.is_admin) ? 'bx-shield-minus' : 'bx-shield-plus';
    o += " text-lg'></i></button>\n                                            </form>\n                                            \n                                            <form action=\"/admin\" method=\"POST\" class=\"inline-block m-0 p-0\"";
    o += confirmAttrs({ title: 'Delete this user?', text: who(u) + ' (' + phpStr(u.email) + ') and all their pages, stats, messages and uploads are deleted. This can’t be undone.', ok: 'Delete user', tone: 'danger' });
    o += ">";
    o += d.csrfField + confirmField();
    o += "                                                <input type=\"hidden\" name=\"delete_user_id\" value=\"";
    o += phpStr(u.id);
    o += "\">\n                                                <button type=\"submit\" class=\"p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-500/10 rounded-md transition-all shadow-sm border border-transparent hover:border-red-500/20\" title=\"Delete User\" ";
    o += sameId(u.id, d.sessionUserId) ? 'disabled class="p-1.5 text-gray-700 cursor-not-allowed"' : '';
    o += "><i class='bx bx-trash text-lg'></i></button>\n                                            </form>\n                                        </div>\n                                    </td>\n                                </tr>\n                                ";
  }
  o += "                            </tbody>\n                        </table>\n                    </div>\n                </div>\n            </div>\n\n            <div id=\"tab-newsletter\" class=\"admin-tab-content max-w-4xl mx-auto space-y-8 hidden\">\n                <div class=\"bg-gradient-to-r from-brand-500/20 to-purple-500/20 p-1 rounded-xl border border-brand-500/30\">\n                    <div class=\"bg-card p-6 rounded-lg flex items-start gap-4\">\n                        <i class='bx bx-info-circle text-3xl text-brand-400 mt-1'></i>\n                        <div>\n                            <h2 class=\"text-lg font-bold text-white mb-1\">JSON Email Templates</h2>\n                            <p class=\"text-sm text-gray-400\">\n                                Place your templates in the <code class=\"bg-black px-1.5 py-0.5 rounded border border-bordercolor text-brand-300\">/email</code> folder. \n                                Files must be in JSON format. Use variables like <code class=\"text-emerald-400\">{full_name}</code> or <code class=\"text-emerald-400\">{subdomain}</code>.\n                            </p>\n                        </div>\n                    </div>\n                </div>\n\n                <div class=\"bg-card border border-bordercolor rounded-xl overflow-hidden shadow-xl p-6\">\n                    <h2 class=\"text-base font-semibold text-white mb-6 border-b border-bordercolor pb-4\">Compose Campaign</h2>\n                    \n                    <form action=\"/admin\" method=\"POST\" class=\"space-y-6\" id=\"newsletterForm\"";
  // Rückfrage mit Empfänger (beforeSubmit im Skript unten); die Attribute gelten, falls das Skript fehlt
  o += confirmAttrs({ title: 'Send this email?', ok: 'Send email', tone: 'warn' });
  o += ">\n                        ";
  o += d.csrfField + confirmField();
  o += "                        <input type=\"hidden\" name=\"send_newsletter\" value=\"1\">\n                        \n                        <div class=\"grid grid-cols-1 md:grid-cols-2 gap-6\">\n                            <div>\n                                <label class=\"block text-sm font-medium text-gray-300 mb-1.5\">Select Template (.json)</label>\n                                <div class=\"relative rounded-lg\" data-field>\n                                    <select name=\"template_file\" required data-error-required=\"Please choose a template.\" class=\"w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 appearance-none text-sm\">\n                                        <option value=\"\" disabled selected>-- Choose a template --</option>\n                                        ";
  for (const tpl of d.templates) {
    o += "                                            <option value=\"";
    o += e(tpl);
    o += "\">";
    o += e(tpl);
    o += "</option>\n                                        ";
  }
  o += "                                        ";
  if (d.templates.length === 0) {
    o += "                                            <option value=\"\" disabled>No templates found!</option>\n                                        ";
  }
  o += "                                    </select>\n                                    <i class='bx bx-chevron-down absolute right-4 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none'></i>\n                                </div>\n                            </div>\n                            \n                            <div>\n                                <label class=\"block text-sm font-medium text-gray-300 mb-1.5\">Target Audience</label>\n                                <div class=\"relative\">\n                                    <select name=\"audience\" id=\"audienceSelect\" onchange=\"toggleSingleEmail()\" class=\"w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 appearance-none text-sm\">\n                                        <option value=\"all\">All Registered Users (";
  o += String(d.totalUsers);
  o += ")</option>\n                                        <option value=\"with_domain\">Users with a Domain (";
  o += String(d.totalDomains);
  o += ")</option>\n                                        <option value=\"no_domain\">Users without a Domain (";
  o += String(d.totalUsers - d.totalDomains);
  o += ")</option>\n                                        <option value=\"single\">Test / Single User</option>\n                                    </select>\n                                    <i class='bx bx-chevron-down absolute right-4 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none'></i>\n                                </div>\n                            </div>\n                        </div>\n\n                        <div id=\"singleEmailDiv\" class=\"hidden pt-4 border-t border-bordercolor\">\n                            <label class=\"block text-sm font-medium text-gray-300 mb-1.5\">User Email Address</label>\n                            <input type=\"email\" name=\"single_email\" id=\"singleEmail\" placeholder=\"user@example.com\" data-error-required=\"Please enter the email address.\" class=\"w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm\">\n                            <p class=\"text-xs text-brand-400 mt-1.5\"><i class='bx bx-info-circle'></i> Use this to test your templates before sending to everyone.</p>\n                        </div>\n\n                        <div>\n                            <label class=\"block text-sm font-medium text-gray-300 mb-1.5\">Email Subject Override (Optional)</label>\n                            <input type=\"text\" name=\"email_subject\" placeholder=\"Leave blank to use subject from JSON template\" class=\"w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm placeholder-gray-600\">\n                        </div>\n                        \n                        <div class=\"pt-4 border-t border-bordercolor flex justify-end\">\n                            <button type=\"submit\" class=\"bg-brand-500 hover:bg-brand-600 text-white font-bold py-2.5 px-6 rounded-lg transition-all duration-300 shadow-[0_0_15px_rgba(99,102,241,0.3)] flex items-center gap-2\">\n                                <i class='bx bx-send'></i> Send Email\n                            </button>\n                        </div>\n                    </form>\n                </div>\n            </div>\n\n            <div id=\"tab-mailserver\" class=\"admin-tab-content max-w-4xl mx-auto space-y-8 hidden\">\n                <div class=\"bg-card border border-bordercolor rounded-xl overflow-hidden shadow-xl p-6\">\n                    <div class=\"flex items-center gap-3 mb-6 border-b border-bordercolor pb-4\">\n                        <i class='bx bx-server text-2xl text-white'></i>\n                        <h2 class=\"text-base font-semibold text-white\">SMTP Mail Server Configuration</h2>\n                    </div>\n                    \n                    <form action=\"/admin\" method=\"POST\" class=\"space-y-6\">\n                        ";
  o += d.csrfField;
  o += "                        <input type=\"hidden\" name=\"save_smtp\" value=\"1\">\n                        \n                        <div class=\"grid grid-cols-1 md:grid-cols-2 gap-6\">\n                            <div>\n                                <label class=\"block text-sm font-medium text-gray-300 mb-1.5\">SMTP Host</label>\n                                <input type=\"text\" name=\"smtp_host\" value=\"";
  o += smtpField(o, d.smtpConfig, 'host');
  o += "\" placeholder=\"smtp.example.com\" class=\"w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm\">\n                            </div>\n                            <div>\n                                <label class=\"block text-sm font-medium text-gray-300 mb-1.5\">SMTP Port</label>\n                                <input type=\"text\" name=\"smtp_port\" value=\"";
  o += smtpField(o, d.smtpConfig, 'port');
  o += "\" placeholder=\"587 or 465\" class=\"w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm\">\n                            </div>\n                        </div>\n\n                        <div class=\"grid grid-cols-1 md:grid-cols-2 gap-6\">\n                            <div>\n                                <label class=\"block text-sm font-medium text-gray-300 mb-1.5\">SMTP Username</label>\n                                <input type=\"text\" name=\"smtp_username\" value=\"";
  o += smtpField(o, d.smtpConfig, 'username');
  o += "\" placeholder=\"hello@yourdomain.com\" class=\"w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm\">\n                            </div>\n                            <div>\n                                <label class=\"block text-sm font-medium text-gray-300 mb-1.5\">SMTP Password</label>\n                                <input type=\"password\" name=\"smtp_password\" value=\"";
  o += smtpField(o, d.smtpConfig, 'password');
  o += "\" placeholder=\"••••••••\" class=\"w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm\">\n                            </div>\n                        </div>\n\n                        <div class=\"grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t border-bordercolor\">\n                            <div>\n                                <label class=\"block text-sm font-medium text-gray-300 mb-1.5\">From Email Address</label>\n                                <input type=\"email\" name=\"from_email\" value=\"";
  o += smtpField(o, d.smtpConfig, 'from_email');
  o += "\" placeholder=\"noreply@on-your.site\" class=\"w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm\">\n                            </div>\n                            <div>\n                                <label class=\"block text-sm font-medium text-gray-300 mb-1.5\">From Name</label>\n                                <input type=\"text\" name=\"from_name\" value=\"";
  o += smtpField(o, d.smtpConfig, 'from_name');
  o += "\" placeholder=\"On Your Site Team\" class=\"w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm\">\n                            </div>\n                        </div>\n                        \n                        <div class=\"pt-4 flex justify-end\">\n                            <button type=\"submit\" class=\"bg-white text-black hover:bg-gray-200 font-bold py-2.5 px-6 rounded-lg transition-all duration-300 shadow-sm flex items-center gap-2\">\n                                <i class='bx bx-save'></i> Save Configuration\n                            </button>\n                        </div>\n                    </form>\n                </div>\n            </div>\n\n            ";
  o += d.updatesHtml;
  o += "            ";
  o += d.communityHtml;
  o += "            ";
  o += d.honeycombsHtml;
  o += "            ";
  o += d.codePagesHtml;
  o += d.domainsHtml;
  o += d.statusHtml;
  o += d.seasonsHtml;
  o += d.betaHtml;
  o += "            ";
  o += d.storageHtml;
  o += "\n        </main>\n    </div>\n\n    <div id=\"pwdModal\" class=\"hidden fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4\">\n        <div class=\"bg-card w-full max-w-md rounded-xl border border-bordercolor shadow-2xl flex flex-col transform scale-100 overflow-hidden\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"pwdModalTitle\">\n            <div class=\"p-4 border-b border-bordercolor flex justify-between items-center bg-inputbg\">\n                <h3 id=\"pwdModalTitle\" class=\"text-white font-semibold text-sm flex items-center gap-2\"><i class='bx bx-key text-brand-400'></i> Reset Password</h3>\n                <button type=\"button\" data-close aria-label=\"Close\" class=\"text-gray-500 hover:text-white transition-colors\"><i class='bx bx-x text-2xl'></i></button>\n            </div>\n            <form action=\"/admin\" method=\"POST\" class=\"p-6 bg-background\">\n                ";
  o += d.csrfField;
  o += "                <input type=\"hidden\" name=\"reset_password_id\" id=\"resetUserId\" value=\"\">\n                <p class=\"text-sm text-gray-400 mb-4\">Set a new password for <strong id=\"resetUserName\" class=\"text-white\"></strong>. They will need this new password to log in.</p>\n                <div class=\"mb-6\">\n                    <label class=\"block text-sm font-medium text-gray-300 mb-1.5\">New Password</label>\n                    <input type=\"text\" name=\"new_password\" id=\"resetPassword\" required data-error-required=\"Please enter a new password.\" placeholder=\"Type new password...\" class=\"w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm\">\n                </div>\n                <div class=\"flex justify-end gap-3\">\n                    <button type=\"button\" data-close class=\"px-4 py-2 rounded-lg text-sm font-medium text-gray-400 hover:bg-white/5 transition-colors\">Cancel</button>\n                    <button type=\"submit\" class=\"bg-brand-500 hover:bg-brand-600 text-white px-5 py-2 rounded-lg text-sm font-bold transition-all shadow-sm\">Save Password</button>\n                </div>\n            </form>\n        </div>\n    </div>\n\n    <script>\n        const ADMIN_TABS = {\n            users: ['User Management', 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'],\n            newsletter: ['Newsletter Campaigns', 'border-brand-500/30 bg-brand-500/10 text-brand-400'],\n            mailserver: ['Mail Server Setup', 'border-purple-500/30 bg-purple-500/10 text-purple-400'],\n            updates: ['Updates', 'border-sky-500/30 bg-sky-500/10 text-sky-400'],\n            roadmap: ['Roadmap', 'border-amber-500/30 bg-amber-500/10 text-amber-400'],\n            discord: ['Discord', 'border-[#5865F2]/40 bg-[#5865F2]/10 text-[#8b93ff]'],\n            community: ['Community', 'border-indigo-400/30 bg-indigo-400/10 text-indigo-300'],\n            honeycombs: ['Honeycombs', 'border-yellow-500/30 bg-yellow-500/10 text-yellow-400'],\n            'code-pages': ['Code pages', 'border-brand-500/30 bg-brand-500/10 text-brand-400'],\n            domains: ['Custom domains', 'border-cyan-500/30 bg-cyan-500/10 text-cyan-400'],\n            status: ['Status pages', 'border-lime-500/30 bg-lime-500/10 text-lime-400'],\n            seasons: ['Seasons', 'border-sky-500/30 bg-sky-500/10 text-sky-300'],\n            beta: ['Beta', 'border-sky-500/30 bg-sky-500/10 text-sky-300'],\n            storage: ['Storage & backups', 'border-teal-500/30 bg-teal-500/10 text-teal-400'],\n        };\n        function switchAdminTab(tabName) {\n            if (!Object.prototype.hasOwnProperty.call(ADMIN_TABS, tabName)) return;\n            document.querySelectorAll('.admin-tab-content').forEach(tab => tab.classList.add('hidden'));\n            document.querySelectorAll('.admin-nav-btn').forEach(btn => btn.className = \"admin-nav-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-transparent hover:bg-white/5 text-gray-400 hover:text-white font-medium transition-all\");\n\n            document.getElementById('tab-' + tabName).classList.remove('hidden');\n            document.getElementById('nav-' + tabName).className = \"admin-nav-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border font-medium transition-all shadow-inner \" + ADMIN_TABS[tabName][1];\n            document.getElementById('admin-page-title').innerText = ADMIN_TABS[tabName][0];\n            if (location.hash !== '#' + tabName) history.replaceState(null, '', '#' + tabName);\n        }\n        window.addEventListener('hashchange', () => switchAdminTab(location.hash.slice(1)));\n\n        // Meldungen: Erfolg verschwindet nach ein paar Sekunden, ein Klick schließt jede Meldung\n        document.querySelectorAll('.animate-fade-in').forEach(el => {\n            el.style.cursor = 'pointer';\n            el.addEventListener('click', () => el.remove());\n            if (el.classList.contains('bg-emerald-500/10')) setTimeout(() => el.remove(), 5000);\n        });\n        switchAdminTab(location.hash.slice(1));\n\n        // Discord: nur die Felder der gewählten Verbindungsart zeigen\n        (function () {\n            const form = document.getElementById('discordForm');\n            if (!form) return;\n            const sync = () => {\n                const mode = form.querySelector('input[name=mode]:checked')?.value || 'webhook';\n                form.querySelectorAll('[data-mode]').forEach(el => el.classList.toggle('hidden', el.dataset.mode !== mode));\n            };\n            form.querySelectorAll('input[name=mode]').forEach(r => r.addEventListener('change', sync));\n            sync();\n        })();\n\n        function toggleSingleEmail() {\n            const select = document.getElementById('audienceSelect');\n            const singleDiv = document.getElementById('singleEmailDiv');\n            if(select.value === 'single') {\n                singleDiv.classList.remove('hidden');\n            } else {\n                singleDiv.classList.add('hidden');\n            }\n            document.getElementById('singleEmail').required = select.value === 'single';\n        }\n\n        function filterTable() {\n            let input = document.getElementById(\"searchInput\");\n            let filter = input.value.toLowerCase();\n            let trs = document.getElementById(\"userTable\").getElementsByTagName(\"tr\");\n            for (let i = 1; i < trs.length; i++) {\n                let targets = trs[i].getElementsByClassName(\"search-target\");\n                let found = false;\n                for (let j = 0; j < targets.length; j++) {\n                    if (targets[j].innerText.toLowerCase().indexOf(filter) > -1) {\n                        found = true;\n                        break;\n                    }\n                }\n                trs[i].style.display = found ? \"\" : \"none\";\n            }\n        }\n\n        // Passwort neu setzen: ein Fenster für alle Zeilen; mit ui.js als Ebene (Escape, Fokus bleibt drin, Fokus zurück)\n        (function () {\n            const modal = document.getElementById('pwdModal');\n            const input = document.getElementById('resetPassword');\n            const form = modal.querySelector('form');\n            let layer = null, downOnBackdrop = false;\n            function close() {\n                modal.classList.add('hidden');\n                if (layer) { layer.release(); layer = null; }\n            }\n            // Nur ein Klick, der auf dem Hintergrund beginnt, schließt – nicht das Markieren von Text, das daneben endet\n            modal.addEventListener('mousedown', (ev) => { downOnBackdrop = ev.target === modal; });\n            document.addEventListener('click', (ev) => {\n                const btn = ev.target.closest('[data-pwd-reset]');\n                if (btn) {\n                    // Für jede Zeile frisch: Feld leer, keine Meldung vom letzten Öffnen (ui.js räumt sie beim Zurücksetzen weg)\n                    form.reset();\n                    document.getElementById('resetUserId').value = btn.dataset.pwdReset;\n                    document.getElementById('resetUserName').textContent = btn.dataset.name;\n                    modal.classList.remove('hidden');\n                    if (window.OYSUI) layer = OYSUI.layer(modal, { labelledBy: 'pwdModalTitle', onEscape: close });\n                    input.focus();\n                    return;\n                }\n                if (!modal.classList.contains('hidden') && ((ev.target === modal && downOnBackdrop) || ev.target.closest('#pwdModal [data-close]'))) close();\n            });\n        })();\n\n        // Newsletter: Empfänger im Dialog nennen – bei „Test / Single User“ die Adresse (ohne ui.js lehnt der Server ab)\n        document.addEventListener('DOMContentLoaded', () => {\n            const f = document.getElementById('newsletterForm');\n            if (!f || !window.OYSUI) return;\n            OYSUI.beforeSubmit(f, (form) => {\n                const a = form.audience;\n                const to = a.value === 'single' ? form.single_email.value.trim() : a.options[a.selectedIndex].text;\n                return { title: 'Send this email?', text: 'Template “' + form.template_file.value + '” to ' + to + '.', ok: 'Send email', tone: 'warn' };\n            });\n        });\n\n        // Glocke im Kopf (bell.js); Ziele /admin#<bereich> aus der Glocke öffnen den Bereich ohne Neuladen, /admin ohne\n        // Bereich lässt den offenen Bereich stehen\n        document.addEventListener('DOMContentLoaded', () => {\n            if (!window.OYSUI) return;\n            OYSUI.onLink((url) => {\n                const tab = url.hash.slice(1);\n                if (url.pathname !== '/admin' || url.search) return false;\n                if (tab === '') return true;\n                if (!Object.prototype.hasOwnProperty.call(ADMIN_TABS, tab)) return false;\n                switchAdminTab(tab);\n                return true;\n            });\n            if (window.OYSBell) OYSBell.mount(document.querySelector('[data-bell]'));\n        });\n    </script>\n    <style>\n        @media (max-width: 639px) { input:not([type=checkbox]):not([type=radio]), select, textarea { font-size: 16px !important; } }\n    </style>\n    <style>\n        .custom-scrollbar::-webkit-scrollbar { width: 5px; }\n        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }\n        .custom-scrollbar::-webkit-scrollbar-thumb { background: #27272a; border-radius: 10px; }\n        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #3f3f46; }\n        @keyframes fadeIn { from { opacity: 0; transform: translateY(-5px); } to { opacity: 1; transform: translateY(0); } }\n        .animate-fade-in { animation: fadeIn 0.2s ease forwards; }\n    </style>\n</body>\n</html>";
  return o;
}
