// Eigene Dialoge und Hinweise (static/js/ui.js, Vertrag static/js/ui.d.ts) auf den Seiten vom Server:
// Tags für den Kopf, Bestätigungen für Formulare (fallen ohne ui.js geschlossen aus), Hinweis-Banner und die Glocke.
import type { Ctx } from '../../web/ctx.js';
import { e } from '../../html.js';
import { asset } from '../../helpers.js';
import { intval } from '../../php.js';
import { csrfToken } from '../../web/security.js';

export type UiSkin = 'app' | 'page';

// <link> und <script defer> für App-Seiten (Aussehen aus ui.css), nur <script> für Profil- und einfache Seiten
// (Aussehen aus page.css und dem Theme). toastTop: Abstand der Hinweise von oben (Seiten mit 80-px-Navigation: 96).
export function uiAssets(skin: UiSkin = 'app', opts: { indent?: string; toastTop?: number } = {}): string {
  const indent = opts.indent ?? '    ';
  const js = '<script src="' + e(asset('/static/js/ui.js')) + '" defer></script>';
  if (skin === 'page') return js;
  let out = '<link rel="stylesheet" href="' + e(asset('/static/css/ui.css')) + '">\n' + indent + js;
  if (opts.toastTop !== undefined) out += '\n' + indent + '<style>:root { --ui-toast-top: ' + Math.max(0, Math.round(opts.toastTop)) + 'px; }</style>';
  return out;
}

export interface ConfirmOptions {
  // Titel des Dialogs (schaltet die Rückfrage ein)
  title: string;
  text?: string;
  ok?: string;
  tone?: 'warn' | 'danger' | 'hc';
  // Bestätigen durch Tippen: Wert, Feldbeschriftung, Vergleich und Ziel-Feld für den getippten Wert
  match?: string;
  label?: string;
  normalize?: 'trim' | 'lower' | 'slug' | 'host';
  into?: string;
}

// data-confirm-Attribute für ein Formular oder einen Absendeknopf (mit führendem Leerzeichen, alles mit e() maskiert).
// Immer zusammen mit confirmField() im selben Formular, damit der Server unbestätigte Sendungen ablehnt.
export function confirmAttrs(o: ConfirmOptions): string {
  const parts: Array<[string, string | undefined]> = [
    ['data-confirm', o.title], ['data-confirm-text', o.text], ['data-confirm-ok', o.ok], ['data-confirm-tone', o.tone],
    ['data-confirm-match', o.match], ['data-confirm-label', o.label], ['data-confirm-normalize', o.normalize], ['data-confirm-into', o.into],
  ];
  let out = '';
  for (const [name, value] of parts) if (value !== undefined) out += ' ' + name + '="' + e(value) + '"';
  return out;
}

// Verstecktes Feld _confirmed: ui.js setzt „1“, nachdem der Dialog mit OK beantwortet wurde
export function confirmField(): string {
  return '<input type="hidden" name="_confirmed" value="0" autocomplete="off">';
}

// Ein Formular mit confirmField() kam ohne Bestätigung an (ui.js fehlt oder ist kaputt): dann wird nichts ausgeführt.
// Formulare ohne das Feld sind nicht betroffen.
export const UNCONFIRMED_MESSAGE = 'Nothing was changed. Please confirm in the dialog – if no dialog appears, reload the page.';
export function unconfirmed(post: Record<string, unknown>): boolean {
  return post._confirmed !== undefined && post._confirmed !== '1';
}

// Hinweis-Banner (Erfolg/Fehler) aus der Sitzung: liest die Schlüssel und entfernt sie (wie isset … unset in PHP).
// Schlüssel auf "error" sind Fehler, alle anderen Erfolg. ui.js macht daraus Toasts (Erfolg 5 s, Fehler bleibt);
// ohne ui.js bleiben die Banner wie bisher (Klick schließt, Erfolg verschwindet nach 5 s).
export function flashBanner(ctx: Ctx, keys: string[]): string {
  let out = '';
  for (const key of keys) {
    const value = ctx.session?.get(key);
    if (value === undefined || value === null) continue;
    ctx.session?.delete(key);
    out += flashMarkup(/error$/.test(key) ? 'err' : 'ok', value);
  }
  return out;
}

// Das Banner der Admin-Seite (views/admin.php) mit data-flash und Rolle für Screenreader
export function flashMarkup(tone: 'ok' | 'err', text: unknown): string {
  if (tone === 'err') {
    return "            <div data-flash=\"err\" role=\"alert\" class=\"absolute top-20 left-1/2 -translate-x-1/2 z-50 bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-2 rounded-lg flex items-center gap-2 shadow-lg backdrop-blur-md text-sm font-medium animate-fade-in\">\n                <i class='bx bx-error-circle text-lg'></i> "
      + e(text) + "            </div>\n        ";
  }
  return "            <div data-flash=\"ok\" role=\"status\" class=\"absolute top-20 left-1/2 -translate-x-1/2 z-50 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-4 py-2 rounded-lg flex items-center gap-2 shadow-lg backdrop-blur-md text-sm font-medium animate-fade-in\">\n                <i class='bx bx-check-circle text-lg'></i> "
    + e(text) + "            </div>\n        ";
}

// Glocke für Kopfzeilen (Editor und Admin, gleiches Markup); static/js/bell.js liest data-csrf (für „gelesen“), data-user
// (Schlüssel im Browser: zuletzt gezeigter Eintrag dieses Kontos) und data-readonly (Admin im Nutzer-Modus: nur lesen)
export async function bellMarkup(ctx: Ctx): Promise<string> {
  const user = intval(ctx.session?.get('user_id') ?? 0);
  const original = ctx.session?.get('original_admin_id');
  const readonly = original !== undefined && original !== null;
  return '<div class="relative" data-bell data-csrf="' + e(await csrfToken(ctx)) + '"' + (user > 0 ? ' data-user="' + user + '"' : '') + (readonly ? ' data-readonly' : '') + '>\n'
    + '    <button type="button" id="bellBtn" class="relative w-9 h-9 rounded-lg hover:bg-white/5 border border-transparent hover:border-bordercolor flex items-center justify-center text-gray-400 hover:text-white transition-colors" aria-label="Notifications" aria-expanded="false" aria-controls="bellMenu">\n'
    + "        <i class='bx bx-bell text-xl'></i><span id=\"bellBadge\" class=\"bell-badge\" hidden>0</span>\n"
    + '    </button>\n'
    + '    <div id="bellMenu" class="dropdown hidden w-80 right-0" role="region" aria-label="Notifications"></div>\n'
    + '</div>';
}
