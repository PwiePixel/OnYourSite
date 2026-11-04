// Editor (views/dashboard.php). Der Text außerhalb der PHP-Teile ist Byte für Byte übernommen (view2ts); dazu kommt der
// Bereich „Honeycombs“ (Eintrag in der Leiste nur auf dem Schreibtisch, Inhalt aus static/js/editor.js).
// Die Daten für window.OYS_EDITOR stellt dashboard.ts zusammen (Datenbank, Sitzung); die Vorlage gibt nur aus.
import { e, phpJson } from '../../html.js';
import { asset } from '../../helpers.js';
import { intval, phpStr, phpTruthy } from '../../php.js';
import type { Row } from '../../db.js';
import { uiAssets } from '../../views/partials/ui.js';

export interface DashboardViewData {
  // $editorData – Schlüssel in der Reihenfolge von PHP
  editorData: Record<string, unknown>;
  // $_SESSION['success'] / $_SESSION['error'] (schon aus der Sitzung entfernt)
  flashSuccess: unknown;
  flashError: unknown;
  // oys_csrf_field()
  csrfField: string;
  // $user_data (discord_id schon entschlüsselt)
  userData: Row;
  // $page ist gesetzt
  hasPage: boolean;
  // Keine Link-Seite gezeigt, aber Seiten da: jeder Platz zeigt eine Code-Seite (CS-6, U13); und ob ein Platz frei ist
  codeOnly?: boolean;
  canCreatePage?: boolean;
  isImpersonating: boolean;
  // $honeycombs['balance']
  balance: unknown;
  // Glocke (bellMarkup(), dasselbe Markup wie im Kopf des Admin-Bereichs)
  bellHtml: string;
  // OnYourSites eigene Statusseite verwalten (Admin, nicht im Admin-Modus): Bereich „Status“ im Editor
  statusAdmin?: boolean;
  statusUser?: boolean; // eigene Statusseite freigeschaltet (Bereich „Status“ ohne OnYourSites Seite)
}

export function dashboardView(d: DashboardViewData): string {
  let o = '';
  const user = d.userData;
  o += "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n    <meta charset=\"UTF-8\">\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n    <!-- Die Seite ist schon dunkel: kein Nachtmodus des Browsers darüber (z. B. Brave, Dark Reader) -->\n    <meta name=\"color-scheme\" content=\"dark\">\n    <meta name=\"darkreader-lock\">\n    <title>Editor | OnYourSite</title>\n    <meta name=\"robots\" content=\"noindex\">\n    <link href=\"https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap\" rel=\"stylesheet\">\n    <link rel=\"stylesheet\" href=\"";
  o += e(asset('/static/vendor/boxicons/css/boxicons.min.css'));
  o += "\">\n    <link rel=\"icon\" type=\"image/png\" href=\"/static/images/favicon.png\">\n    <script src=\"";
  // SortableJS (Blöcke verschieben) kommt von der eigenen Seite: ein blockiertes CDN machte das Verschieben unmöglich
  o += e(asset('/static/vendor/sortablejs/Sortable.min.js'));
  o += "\"></script>\n    <script src=\"https://cdn.tailwindcss.com\"></script>\n    <script>\n        tailwind.config = { theme: { extend: { fontFamily: { sans: ['Inter', 'sans-serif'], }, colors: { background: '#000000', card: '#0a0a0a', inputbg: '#121212', bordercolor: '#27272a', brand: { 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5', } } } } }\n    </script>\n    <link rel=\"stylesheet\" href=\"";
  o += e(asset('/static/css/fonts.css'));
  o += "\">\n    <link rel=\"stylesheet\" href=\"";
  o += e(asset('/static/css/themes.css'));
  o += "\">\n    <link rel=\"stylesheet\" href=\"";
  o += e(asset('/static/css/page.css'));
  o += "\">\n    <link rel=\"stylesheet\" href=\"";
  o += e(asset('/static/css/editor.css'));
  o += "\">\n" + "    " + uiAssets('app') + "\n</head>\n<body class=\"bg-background text-gray-300 font-sans h-screen flex flex-col overflow-hidden selection:bg-brand-500/30\">\n\n    ";
  if (d.isImpersonating) {
    o += "    <div class=\"bg-emerald-500 text-white text-center py-2.5 text-sm font-bold flex items-center justify-center gap-2 shadow-lg relative z-[200] shrink-0 w-full\">\n        <i class='bx bx-mask text-xl'></i> Admin mode: You’re editing ";
    o += e(user.full_name);
    o += "        <form method=\"post\" action=\"/admin_return.php\" class=\"ml-4 m-0\">";
    o += d.csrfField;
    o += "<button type=\"submit\" class=\"bg-white/20 hover:bg-white/30 px-3 py-1 rounded-md transition-colors border border-white/20 flex items-center gap-1 shadow-sm\"><i class='bx bx-left-arrow-alt'></i> Back to admin panel</button></form>\n    </div>\n    ";
  }
  o += "\n    <div class=\"flex-1 flex overflow-hidden\">\n        <aside class=\"app-rail w-16 sm:w-20 lg:w-64 border-r border-bordercolor bg-card flex flex-col justify-between py-6 transition-all z-20 shrink-0\">\n            <div>\n                <a href=\"/\" class=\"rail-logo px-3 sm:px-6 mb-8 flex items-center justify-center lg:justify-start gap-2 transition-transform hover:scale-105\">\n                    <i class='bx bx-hive text-3xl text-brand-500'></i><span class=\"font-bold text-xl text-white tracking-tight hidden lg:block\">OnYourSite</span>\n                </a>\n                <div class=\"rail-label px-4 mb-2 hidden lg:block\"><p class=\"text-xs font-semibold text-gray-500 uppercase tracking-wider\">Menu</p></div>\n                <nav class=\"space-y-1 px-2 sm:px-3\" id=\"mainNav\">\n                    <button type=\"button\" data-tab=\"content\" class=\"nav-btn\"><i class='bx bx-layout text-xl'></i> <span class=\"hidden lg:block text-sm\">Content</span></button>\n                    <button type=\"button\" data-tab=\"design\" class=\"nav-btn\"><i class='bx bx-palette text-xl'></i> <span class=\"hidden lg:block text-sm\">Design</span></button>\n                    <button type=\"button\" data-tab=\"stats\" class=\"nav-btn\"><i class='bx bx-bar-chart-alt-2 text-xl'></i> <span class=\"hidden lg:block text-sm\">Stats</span></button>\n                    <button type=\"button\" data-tab=\"messages\" class=\"nav-btn\"><i class='bx bx-envelope text-xl'></i> <span class=\"hidden lg:block text-sm\"><span class=\"nav-full\">Messages</span><span class=\"nav-short\">Inbox</span></span><span class=\"nav-badge\" id=\"navMsgBadge\" hidden>0</span></button>\n                    <button type=\"button\" data-tab=\"code\" class=\"nav-btn\"><i class='bx bx-code-alt text-xl'></i> <span class=\"hidden lg:block text-sm\">Code<span class=\"nav-long\"> page</span></span></button>\n" + (d.statusAdmin || d.statusUser ? "                    <button type=\"button\" data-tab=\"status\" class=\"nav-btn nav-desktop\"><i class='bx bx-pulse text-xl'></i> <span class=\"hidden lg:block text-sm\">Status<span class=\"nav-long\"> page</span></span></button>\n" : '') + "                    <button type=\"button\" data-tab=\"honeycombs\" class=\"nav-btn nav-desktop\"><i class='bx bx-hive text-xl hc-icon'></i> <span class=\"hidden lg:block text-sm\">Honeycombs</span></button>\n                    <button type=\"button\" data-tab=\"settings\" class=\"nav-btn\"><i class='bx bx-cog text-xl'></i> <span class=\"hidden lg:block text-sm\">Settings</span></button>\n                    <button type=\"button\" id=\"navPreviewBtn\" class=\"nav-btn nav-preview\"><i class='bx bx-mobile-alt text-xl'></i> <span class=\"hidden lg:block text-sm\">Preview</span></button>\n                </nav>\n            </div>\n            <div class=\"rail-foot px-2 sm:px-3 space-y-1\">\n                ";
  // Weg in den Admin-Bereich nur in der eigenen Sitzung eines Admins (R1) – im Nutzer-Modus führt „Back to admin panel“ zurück
  if (phpTruthy(user.is_admin) && !d.isImpersonating) {
    o += "                <a href=\"/admin\" class=\"flex items-center justify-center lg:justify-start gap-3 px-3 py-2.5 rounded-lg hover:bg-white/5 text-gray-500 hover:text-white transition-colors\"><i class='bx bx-shield-quarter text-xl'></i> <span class=\"hidden lg:block text-sm\">Admin</span></a>\n                ";
  }
  o += "                <form method=\"post\" action=\"/logout\" class=\"m-0\">";
  o += d.csrfField;
  o += "<button type=\"submit\" class=\"w-full flex items-center justify-center lg:justify-start gap-3 px-3 py-2.5 rounded-lg hover:bg-red-500/10 text-gray-500 hover:text-red-400 transition-colors\"><i class='bx bx-log-out text-xl'></i> <span class=\"hidden lg:block text-sm\">Log out</span></button></form>\n            </div>\n        </aside>\n\n        <div class=\"flex-1 flex flex-col h-full overflow-hidden w-full bg-background relative min-w-0\">\n            <header class=\"h-16 border-b border-bordercolor bg-background/80 backdrop-blur-md flex items-center justify-between gap-2 sm:gap-3 px-2 sm:px-6 shrink-0 z-30\">\n                <div class=\"flex items-center gap-3 min-w-0\">\n                    <div class=\"relative\" id=\"pageSwitcher\">\n                        <button type=\"button\" id=\"pageSwitcherBtn\" class=\"flex items-center gap-2 max-w-[42vw] sm:max-w-xs bg-white/5 hover:bg-white/10 border border-bordercolor rounded-lg pl-1.5 pr-2.5 py-1.5 transition-colors\">\n                            <span class=\"ps-avatar\" id=\"psAvatar\"></span>\n                            <span class=\"text-sm text-white font-medium truncate hidden min-[420px]:inline\" id=\"psLabel\">Page</span>\n                            <i class='bx bx-chevron-down text-gray-400'></i>\n                        </button>\n                        <div id=\"pageMenu\" class=\"dropdown hidden w-72 left-0\"></div>\n                    </div>\n                    <h1 class=\"text-base font-semibold text-white tracking-tight hidden md:block\" id=\"pageTitle\">Content</h1>\n                </div>\n                <div class=\"flex items-center gap-2 sm:gap-3\">\n                    <button type=\"button\" id=\"hcBtn\" class=\"hc-pill\" data-action=\"honeycombs\" title=\"Your honeycombs\" aria-label=\"Your honeycombs\"><i class='bx bx-hive'></i><span id=\"hcBalance\">";
  o += phpStr(intval(d.balance));
  o += "</span></button>\n                    ";
  o += d.bellHtml;
  o += "\n                    <button type=\"button\" id=\"shareBtn\" data-action=\"share\"";
  o += (d.hasPage ? '' : ' style="display:none"');
  o += " class=\"h-9 px-2.5 rounded-lg hover:bg-white/5 border border-transparent hover:border-bordercolor flex items-center gap-1.5 text-gray-400 hover:text-white transition-colors\" aria-label=\"Share your page\" title=\"Share your page\">\n                        <i class='bx bx-share-alt text-xl'></i><span class=\"hidden xl:inline text-sm\">Share</span>\n                    </button>\n                    <a id=\"viewPageLink\" href=\"#\" target=\"_blank\" rel=\"noopener\"";
  o += (d.hasPage ? '' : ' style="display:none"');
  o += " class=\"text-sm text-gray-400 hover:text-brand-400 hidden sm:flex items-center gap-1.5 transition-colors bg-white/5 px-3 py-1.5 rounded-md border border-bordercolor hover:border-brand-500/30 max-w-[220px]\">\n                        <span class=\"truncate\" id=\"viewPageLabel\"></span> <i class='bx bx-link-external shrink-0'></i>\n                    </a>\n                    <button type=\"button\" id=\"saveBtn\" class=\"bg-white text-black hover:bg-gray-200 px-4 sm:px-5 py-1.5 rounded-md text-sm font-semibold transition-all shadow-sm flex items-center gap-1.5 disabled:opacity-60\">\n                        <i class='bx bx-check text-lg hidden' id=\"saveIcon\"></i><span id=\"saveLabel\">Save</span>\n                    </button>\n                </div>\n            </header>\n\n            <div class=\"flex-1 flex overflow-hidden relative\">\n                <main id=\"editorScroll\" class=\"flex-1 overflow-y-auto p-4 md:p-8 custom-scrollbar relative min-w-0\">\n                    ";
  if (!d.hasPage && d.codeOnly) {
    o += "                        <div id=\"noPageBox\" class=\"max-w-lg mx-auto mt-10 bg-card border border-bordercolor rounded-2xl p-8 text-center\">\n                            <div class=\"w-14 h-14 mx-auto rounded-2xl bg-brand-500/20 text-brand-400 flex items-center justify-center text-3xl mb-4\"><i class='bx bx-code-alt'></i></div>\n                            <h2 class=\"text-xl font-bold text-white mb-2\">Your pages show code pages</h2>\n                            <p class=\"text-gray-400 text-sm mb-6\">" + (d.canCreatePage ? 'Show a link page again or create a new page.' : 'Show a link page again or delete a page.') + "</p>\n                            <div class=\"flex flex-wrap justify-center gap-3\"><button type=\"button\" class=\"btn-primary\" data-action=\"open-code\"><i class='bx bx-code-alt'></i> Open code pages</button>" + (d.canCreatePage ? "<button type=\"button\" class=\"btn-secondary\" data-action=\"new-page\"><i class='bx bx-plus'></i> Create page</button>" : '') + "</div>\n                        </div>\n                    ";
  } else if (!d.hasPage) {
    o += "                        <div id=\"noPageBox\" class=\"max-w-lg mx-auto mt-10 bg-card border border-bordercolor rounded-2xl p-8 text-center\">\n                            <div class=\"w-14 h-14 mx-auto rounded-2xl bg-brand-500/20 text-brand-400 flex items-center justify-center text-3xl mb-4\"><i class='bx bx-rocket'></i></div>\n                            <h2 class=\"text-xl font-bold text-white mb-2\">Create your first page</h2>\n                            <p class=\"text-gray-400 text-sm mb-6\">Choose an address – you can still change it later.</p>\n                            <button type=\"button\" class=\"btn-primary mx-auto\" data-action=\"new-page\"><i class='bx bx-plus'></i> Create page</button>\n                        </div>\n                    ";
  }
  o += "                    <div id=\"tab-content\" class=\"tab-content\"></div>\n                    <div id=\"tab-design\" class=\"tab-content hidden\"></div>\n                    <div id=\"tab-stats\" class=\"tab-content hidden\"></div>\n                    <div id=\"tab-messages\" class=\"tab-content hidden\"></div>\n                    <div id=\"tab-code\" class=\"tab-content hidden\"></div>\n" + (d.statusAdmin || d.statusUser ? "                    <div id=\"tab-status\" class=\"tab-content hidden\"></div>\n" : '') + "                    <div id=\"tab-honeycombs\" class=\"tab-content hidden\"></div>\n                    <div id=\"tab-settings\" class=\"tab-content hidden\">\n                        <div id=\"settingsDynamic\"></div>\n" + (d.statusAdmin ? statusSettingsRow() : d.statusUser ? statusSettingsRow(true) : '') + "                        <section class=\"max-w-3xl mx-auto mt-8\">\n                            <h2 class=\"section-title\">Account</h2>\n                            <div class=\"grid gap-6 md:grid-cols-2\">\n                                <form action=\"/dashboard\" method=\"POST\" class=\"panel space-y-4\">\n                                    ";
  o += d.csrfField;
  o += "                                    <input type=\"hidden\" name=\"update_action\" value=\"email\">\n                                    <h3 class=\"text-sm font-semibold text-white flex items-center gap-2\"><i class='bx bx-envelope text-brand-400'></i> Change email address</h3>\n                                    <p class=\"text-xs text-gray-500\">Current: <span class=\"text-gray-300\">";
  o += e(user.email ?? '');
  o += "</span></p>\n                                    <input type=\"email\" name=\"new_email\" required data-error-required=\"Please enter your new email address.\" placeholder=\"New email address\" class=\"field\">\n                                    <input type=\"password\" name=\"current_password_email\" required data-error-required=\"Please enter your current password.\" placeholder=\"Current password\" class=\"field\">\n                                    <button type=\"submit\" class=\"btn-secondary w-full justify-center\">Change email</button>\n                                </form>\n                                <form action=\"/dashboard\" method=\"POST\" class=\"panel space-y-4\">\n                                    ";
  o += d.csrfField;
  o += "                                    <input type=\"hidden\" name=\"update_action\" value=\"password\">\n                                    <h3 class=\"text-sm font-semibold text-white flex items-center gap-2\"><i class='bx bx-lock-alt text-brand-400'></i> Change password</h3>\n                                    <input type=\"password\" name=\"new_password\" required minlength=\"8\" data-error-short=\"Your new password must be at least 8 characters long.\" placeholder=\"New password (min. 8 characters)\" class=\"field\">\n                                    <input type=\"password\" name=\"confirm_new_password\" required minlength=\"8\" data-match=\"new_password\" data-error-match=\"The new passwords don’t match.\" placeholder=\"Repeat new password\" class=\"field\">\n                                    <input type=\"password\" name=\"current_password_pwd\" required data-error-required=\"Please enter your current password.\" placeholder=\"Current password\" class=\"field\">\n                                    <button type=\"submit\" class=\"btn-secondary w-full justify-center\">Change password</button>\n                                </form>\n                            </div>\n                            <!-- Auf dem Handy gibt es keine Seitenleiste: Admin und Abmelden hier -->\n                            <div class=\"sm:hidden mt-6 grid gap-3\">\n                                ";
  if (phpTruthy(user.is_admin) && !d.isImpersonating) {
    o += "                                <a href=\"/admin\" class=\"btn-secondary w-full justify-center\"><i class='bx bx-shield-quarter'></i> Admin panel</a>\n                                ";
  }
  o += "                                <form method=\"post\" action=\"/logout\" class=\"m-0\">";
  o += d.csrfField;
  o += "<button type=\"submit\" class=\"btn-secondary w-full justify-center text-red-400\"><i class='bx bx-log-out'></i> Log out</button></form>\n                            </div>\n                        </section>\n                    </div>\n                </main>\n\n                <aside id=\"previewPane\" class=\"preview-pane hidden lg:flex\"";
  o += (d.hasPage ? '' : ' style="display:none"');
  o += ">\n                    <div class=\"preview-stage\" id=\"previewStage\">\n                        <div class=\"preview-glow\" id=\"previewGlow\"></div>\n                        <div class=\"phone-wrap\" id=\"phoneWrap\">\n                            <div class=\"phone\" id=\"phone\">\n                                <div class=\"phone-island\"></div>\n                                <div class=\"phone-screen\">\n                                    <iframe class=\"pv-frame on\" title=\"Preview\" id=\"pvA\"></iframe>\n                                    <iframe class=\"pv-frame\" title=\"Preview\" id=\"pvB\"></iframe>\n                                    <iframe class=\"pv-code\" title=\"Preview of your code page\" id=\"pvCode\" sandbox=\"allow-scripts allow-forms allow-popups\"></iframe>\n                                    <div class=\"pv-loading\" id=\"pvLoading\"><i class='bx bx-loader-alt bx-spin'></i></div>\n                                </div>\n                            </div>\n                        </div>\n                        <div class=\"preview-dots\" id=\"previewDots\"></div>\n                    </div>\n                    <div class=\"preview-bar\">\n                        <span class=\"pv-live\"><span></span> <span id=\"pvLiveLabel\">Live preview</span></span>\n                        <div class=\"flex items-center gap-1\">\n                            <button type=\"button\" class=\"pv-btn\" id=\"pvEntrance\" title=\"Play entrance in preview\" hidden><i class='bx bx-play-circle'></i></button>\n                            <button type=\"button\" class=\"pv-btn\" id=\"pvReload\" title=\"Reload\"><i class='bx bx-refresh'></i></button>\n                            <button type=\"button\" class=\"pv-btn\" id=\"pvBig\" title=\"Large view (desktop)\"><i class='bx bx-desktop'></i></button>\n                            <a class=\"pv-btn\" id=\"pvOpen\" href=\"#\" target=\"_blank\" rel=\"noopener\" title=\"Open page\"><i class='bx bx-link-external'></i></a>\n                        </div>\n                    </div>\n                    <p class=\"hint pv-note\" id=\"pvCodeNote\">Pop-ups like alert&#40;) only run on your live page.</p>\n                </aside>\n            </div>\n        </div>\n    </div>\n\n    <button type=\"button\" id=\"mobilePreviewBtn\" class=\"mobile-preview-btn lg:hidden\"><i class='bx bx-mobile-alt'></i> Preview</button>\n    <div id=\"mobilePreview\" class=\"mobile-preview hidden\">\n        <button type=\"button\" class=\"mobile-preview-close\" id=\"mobilePreviewClose\"><i class='bx bx-x'></i></button>\n        <div class=\"mobile-preview-holder\" id=\"mobilePreviewHolder\"></div>\n    </div>\n\n    <div id=\"bigPreview\" class=\"big-preview hidden\">\n        <div class=\"big-preview-box\">\n            <div class=\"big-preview-bar\"><span class=\"dot\"></span><span class=\"dot\"></span><span class=\"dot\"></span><span class=\"big-preview-url\" id=\"bigPreviewUrl\"></span><button type=\"button\" id=\"bigPreviewClose\"><i class='bx bx-x'></i></button></div>\n            <iframe id=\"bigPreviewFrame\" title=\"Large view\"></iframe>\n        </div>\n    </div>\n\n    <div id=\"modal\" class=\"modal hidden\"><div class=\"modal-box\" id=\"modalBox\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"modalTitle\"></div></div>\n\n    <script>window.OYS_EDITOR = ";
  o += phpJson(d.editorData, { hexTag: true, hexAmp: true, unescapedUnicode: true, unescapedSlashes: true });
  o += ";</script>\n    ";
  if (phpTruthy(d.flashSuccess) || phpTruthy(d.flashError)) {
    o += "    <script>window.OYS_FLASH = ";
    o += phpJson({ success: d.flashSuccess, error: d.flashError }, { hexTag: true, unescapedUnicode: true });
    o += ";</script>\n    ";
  }
  o += "    <script src=\"";
  o += e(asset('/static/js/share.js'));
  o += "\" defer></script>\n    <script src=\"";
  o += e(asset('/static/js/bell.js'));
  o += "\" defer></script>\n    <script src=\"";
  o += e(asset('/static/js/editor.js'));
  o += "\" defer></script>\n</body>\n</html>\n";
  return o;
}

// Telefone haben keinen Eintrag „Status“ in der Leiste unten: der Bereich öffnet aus den Einstellungen
// user: die eigene Statusseite des Kontos (ST-4) – auf dem Handy der Weg in den Bereich „Status“
function statusSettingsRow(user = false): string {
  return '                        <section class="max-w-3xl mx-auto mt-8" id="statusSettingsRow">\n'
    + '                            <div class="panel flex items-center justify-between gap-4 flex-wrap">\n'
    + '                                <div class="min-w-0"><h3 class="text-sm font-semibold text-white flex items-center gap-2"><i class=\'bx bx-pulse text-brand-400\'></i> '
    + (user ? 'Status page' : 'OnYourSite status') + '</h3>'
    + '<p class="hint">' + (user ? 'Components, incidents and maintenance of your own status page.' : 'Components, incidents and alerts of OnYourSite’s own status page.') + '</p></div>\n'
    + '                                <button type="button" class="btn-secondary" data-open-status><i class=\'bx bx-right-arrow-alt\'></i> Open</button>\n'
    + '                            </div>\n'
    + '                        </section>\n';
}
