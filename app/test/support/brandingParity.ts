// Vergleiche mit der PHP-Referenz (premium-domains PD-1): PHP blendet „Made with OnYourSite“ und das Zeichen auf dem
// Vorschaubild nach dem gespeicherten Schalter aus, Node nach dem wirksamen Branding (Premium des Besitzers oder
// Bestandsschutz). Für den Vergleich bekommt Node den Wert, den PHP benutzt; die festen Stile der Fußzeile werden
// vor dem Vergleich entfernt. Alles andere muss weiter Byte für Byte gleich sein.
import { e } from '../../src/html.js';
import { mainUrl } from '../../src/helpers.js';
import { phpTruthy } from '../../src/php.js';
import { pageSettings } from '../../src/content/pages.js';
import { brandingFooter, type Branding } from '../../src/content/branding.js';

// Der gespeicherte Schalter – so entscheidet PHP
export const storedHidden = (page: object): boolean => phpTruthy(pageSettings(page as Record<string, unknown>).hide_branding);

// Branding wie in PHP (nur der Schalter, kein Premium, kein Bestandsschutz)
export const phpBranding = (page: object): Branding => ({ footerHidden: storedHidden(page), fullyUnbranded: false });

// Node-Ausgabe mit der Fußzeile von PHP (ohne die festen Inline-Stile)
export function withoutPinnedFooter(html: string): string {
  const php = '  <footer class="oys-foot"><a href="' + e(mainUrl('/')) + '" target="_blank" rel="noopener">Made with <strong>OnYourSite</strong></a></footer>\n  ';
  return html.split(brandingFooter()).join(php);
}
