// Namensregel für Statusseiten (ST-4, Entwurf §6.6): der Name von OnYourSite ist nie erlaubt; eine fremde Marke im
// Namen wird nicht abgelehnt („Acme Discord bot status“ ist ein üblicher Name), markiert die Seite aber zur Prüfung –
// bis ein Admin den Namen freigibt, sehen Suchmaschinen sie nicht (noindex, view.ts).
import { brandsInText, textUsesOurName } from '../content/addresses.js';

export const OUR_NAME_TEXT = 'Status page names can’t use the OnYourSite name.';

// {error}: ablehnen; {review}: Hinweis für die Prüfung („Mentions Discord“); {}: in Ordnung
export function statusTitleProblem(title: string): { error?: string; review?: string } {
  if (textUsesOurName(title)) return { error: OUR_NAME_TEXT };
  // Alle Marken: kommt eine dazu, ändert sich die Notiz und die Seite geht wieder in die Prüfung
  const brands = brandsInText(title);
  return brands.length ? { review: 'Mentions ' + brands.join(', ') } : {};
}
