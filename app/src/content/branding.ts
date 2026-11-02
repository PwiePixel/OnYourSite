// Branding der Profilseiten (Premium): Der gespeicherte Schalter hide_branding wirkt nur, wenn der Besitzer der Seite
// Premium hat – oder die Seite den Hinweis schon vor Premium ausgeblendet hat (branding_legacy, Bestandsschutz Q9).
// Entschieden wird bei jeder Ausgabe, so braucht das Ende von Premium keine Änderung an den Daten.
// Ohne Premium bleibt „Made with OnYourSite“ sichtbar: Die Fußzeile trägt feste Inline-Stile (die schlagen jede Regel
// aus eigenem CSS, auch mit !important), und wer sie mit eigenem CSS anspricht, bekommt beim Speichern einen Hinweis.
// Mit Premium (nicht mit Bestandsschutz) fällt außerdem „| OnYourSite“ im Titel weg, das Profilbild wird zum Favicon,
// und auf Code-Seiten wird das Abzeichen zu einem schlichten „Report“-Link (Q2 = c, code/serve.ts).
import { createHash } from 'node:crypto';
import type { Db } from '../db.js';
import { e } from '../html.js';
import { baseHost, mainUrl } from '../helpers.js';
import { intval, phpStr, phpTruthy } from '../php.js';
import { isPremiumRow } from '../honeycombs/premium.js';
import { poolDb } from '../honeycombs/util.js';
import { registerLossPreview, registerPerk } from '../honeycombs/features.js';
import { jsonDecode, own } from './util.js';
import { cssHides, cssTouches } from './brandingCss.js';

export { CSS_WARNING, cssRules, selectorTargetsBranding } from './brandingCss.js';

// Wirksames Branding einer Seite: Fußzeile und OG-Zeichen (footerHidden), dazu Titelzusatz und Favicon (fullyUnbranded)
export interface Branding {
  footerHidden: boolean;
  fullyUnbranded: boolean;
}

// Nichts ausgeblendet (Beispielseiten, Schalter aus)
export const BRANDED: Readonly<Branding> = Object.freeze({ footerHidden: false, fullyUnbranded: false });

// Fußzeile und OG-Zeichen ausgeblendet? Gespeicherter Schalter UND (Premium des Besitzers ODER Bestandsschutz)
export const footerHidden = (s: unknown, ownerPremium: boolean): boolean =>
  phpTruthy(own(s, 'hide_branding')) && (ownerPremium || phpTruthy(own(s, 'branding_legacy')));

// Titelzusatz, og:image:alt und Favicon: nur mit Premium des Besitzers, nicht mit Bestandsschutz
export const fullyUnbranded = (s: unknown, ownerPremium: boolean): boolean => phpTruthy(own(s, 'hide_branding')) && ownerPremium;

// Premium des Besitzers (Zeile mit user_id: Profilseite, Statusseite …) – eine Abfrage über den Primärschlüssel, immer
// aus der Datenbank (auch für einen Admin im Nutzer-Modus der echte Stand des Besitzers)
export async function ownerPremium(page: { user_id?: unknown }, db: Db = poolDb): Promise<boolean> {
  const owner = await db.one('SELECT is_admin, premium_until FROM users WHERE id = ?', [intval(page.user_id ?? 0)]);
  return owner !== null && isPremiumRow(owner);
}

// Wirksames Branding aus den Einstellungen und dem Premium des Besitzers
export function brandingFor(settings: unknown, premium: boolean): Branding {
  return { footerHidden: footerHidden(settings, premium), fullyUnbranded: fullyUnbranded(settings, premium) };
}

// Branding einer gespeicherten Seite für eine Ausgabe (Seite, Vorschaubild, Schnittstelle). Der Besitzer wird nur
// nachgeschlagen, wenn der Schalter an ist – sonst ändert sich nichts und es gibt keine Abfrage.
export async function pageBranding(page: { user_id?: unknown }, settings: unknown, db: Db = poolDb): Promise<Branding> {
  if (!phpTruthy(own(settings, 'hide_branding'))) return BRANDED;
  return brandingFor(settings, await ownerPremium(page, db));
}

// ---------------------------------------------------------------- Favicon aus dem Profilbild

export const DEFAULT_FAVICON = '/static/images/favicon.png';

// Kennung des Favicons einer Seite: ändert sich mit dem Profilbild (die Adresse darf darum ein Jahr gelten)
export const iconHash = (avatar: string): string => createHash('sha1').update('icon-1|' + avatar, 'utf8').digest('hex').slice(0, 12);

// Favicon einer Seite: mit Premium und Profilbild /_/icon/{id}-{hash}.png (content/icon.ts), sonst das von OnYourSite.
// Relativ, damit es auf jeder Adresse der Seite gilt – auch auf ihrer eigenen Domain.
export function faviconUrl(page: { id?: unknown; avatar?: unknown }, unbranded: boolean): string {
  const avatar = page.avatar === null || page.avatar === undefined ? '' : phpStr(page.avatar);
  const id = intval(page.id ?? 0);
  if (!unbranded || avatar === '' || id <= 0) return DEFAULT_FAVICON;
  return '/_/icon/' + id + '-' + iconHash(avatar) + '.png';
}

// ---------------------------------------------------------------- Fußzeile mit festen Stilen

// Inline-Stile mit !important stehen in der Kaskade vor jedem Stylesheet (auch vor Ebenen und !important dort). Die
// Werte entsprechen dem, was page.css heute ergibt – ehrliche Seiten sehen gleich aus. Nur der Hover-Effekt wechselt
// in page.css von der Deckkraft zur Unterstreichung, denn die feste Deckkraft schlägt :hover.
const HIDE_PROOF = 'transform:none!important;translate:none!important;scale:none!important;rotate:none!important;zoom:1!important;'
  + 'filter:none!important;clip-path:none!important;mask:none!important;-webkit-mask:none!important;text-indent:0!important';
export const FOOTER_STYLE = 'display:block!important;visibility:visible!important;opacity:1!important;position:relative!important;'
  + 'inset:auto!important;z-index:2147483647!important;' + HIDE_PROOF + ';height:auto!important;max-height:none!important;'
  + 'overflow:visible!important;content-visibility:visible!important;font-size:max(.78em,11px)!important';
export const FOOTER_LINK_STYLE = 'display:inline-block!important;visibility:visible!important;opacity:.75!important;position:static!important;'
  + HIDE_PROOF + ';font-size:max(1em,11px)!important';
export const FOOTER_STRONG_STYLE = 'display:inline!important;visibility:visible!important;opacity:1!important;filter:none!important;'
  + 'clip-path:none!important;mask:none!important;-webkit-mask:none!important;font-size:inherit!important';

// <footer class="oys-foot"> der Profilseite (Abstände wie bisher in render.ts)
export function brandingFooter(): string {
  return '  <footer class="oys-foot" style="' + FOOTER_STYLE + '"><a href="' + e(mainUrl('/')) + '" target="_blank" rel="noopener" style="'
    + FOOTER_LINK_STYLE + '">Made with <strong style="' + FOOTER_STRONG_STYLE + '">OnYourSite</strong></a></footer>\n  ';
}

// ---------------------------------------------------------------- Eigenes CSS, das den Hinweis anspricht

// Beim Speichern: spricht das CSS den Hinweis an? (Hinweis im Editor, das Speichern klappt trotzdem)
export const cssTouchesBranding = (css: string): boolean => cssTouches(css, baseHost());
// Blendet das CSS den Hinweis heute aus? (Bestandsschutz Q9)
export const cssHidesBranding = (css: string): boolean => cssHides(css, baseHost());

// ---------------------------------------------------------------- Premium-Vorteil

// Macht Premium bereit (honeycomb-shop zeigt Premium erst, wenn dieser Vorteil angemeldet ist)
registerPerk('premium', { owner: 'premium-domains', text: 'No OnYourSite branding on your pages', ready: () => true });

// Was beim Ende von Premium wieder erscheint (Erinnerung und Hinweis des Shops): der Hinweis auf Seiten, die ihn nur
// dank Premium ausblenden (Bestandsschutz bleibt), und das Abzeichen auf Code-Seiten
export async function brandingLossPreview(uid: number, db: Db): Promise<string[]> {
  const lines: string[] = [];
  let pages = 0;
  for (const r of await db.q('SELECT settings FROM pages WHERE user_id = ? AND code_site_id IS NULL', [uid])) {
    const s = jsonDecode(phpStr(r.settings ?? ''));
    if (phpTruthy(own(s, 'hide_branding')) && !phpTruthy(own(s, 'branding_legacy'))) pages++;
  }
  if (pages > 0) lines.push(`“Made with OnYourSite” will be shown again on ${pages} ${pages === 1 ? 'page' : 'pages'}.`);
  const code = intval(await db.value('SELECT COUNT(*) FROM code_sites WHERE user_id = ?', [uid]));
  if (code > 0) lines.push(`Your code ${code === 1 ? 'page shows' : 'pages show'} the OnYourSite badge again.`);
  return lines;
}
registerLossPreview('premium', brandingLossPreview);
