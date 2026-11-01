// Teilen (lib/share.php): Adressen zum Teilen und Adresse des Vorschaubilds (og:image) für geteilte Links.
// Das Zeichnen des Bildes und die Auslieferung unter /_/og/… kommen mit dem Darstellungs-Paket dazu.
import { createHash } from 'node:crypto';
import { ROOT_DIR } from '../config.js';
import { baseAuthority, pageOrigin, type PageLike } from '../helpers.js';
import { intval, phpStr, phpTruthy, rawurlencode } from '../php.js';
import { isFile } from './storage.js';
import { pageSettings } from './pages.js';
import { DEFAULT_THEME, themeKey } from './themes.js';
import { own } from './util.js';

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

// oys_share_links(): Adressen zum Teilen (Discord hat keine – dort wird der Link eingefügt und als Karte angezeigt)
export function shareLinks(url: string, title: string): { whatsapp: string; x: string } {
  return {
    whatsapp: 'https://wa.me/?text=' + rawurlencode(title !== '' ? title + ' ' + url : url),
    x: 'https://x.com/intent/tweet?url=' + rawurlencode(url) + (title !== '' ? '&text=' + rawurlencode(title) : ''),
  };
}

// oys_og_supported(): Node zeichnet mit @napi-rs/canvas (immer vorhanden) – wie in PHP zählt nur, ob die Schrift da ist
export function ogSupported(): boolean {
  return isFile(ogFont(true));
}

// oys_og_font()
export function ogFont(bold: boolean): string {
  return ROOT_DIR + '/static/fonts/inter-' + (bold ? '700' : '400') + '.ttf';
}

// oys_og_hash(): Kennung des Bildes – ändert sich, sobald sich etwas Sichtbares ändert; dann laden Discord & Co. es neu.
// Muss genau wie in PHP sein, sonst gelten bereits geteilte Adressen und gespeicherte Bilder nicht mehr.
export function ogHash(page: Record<string, unknown>): string {
  const s = pageSettings(page);
  const parts = [
    'og-1', intval(page.id ?? 0), page.slug ?? '', page.address_mode ?? '', page.title ?? '',
    page.subtitle ?? '', phpStr(page.bio ?? ''), phpStr(page.avatar ?? ''),
    themeKey(page.theme ?? DEFAULT_THEME), own(s, 'accent'), phpTruthy(own(s, 'hide_branding')) ? 1 : 0, baseAuthority(),
  ];
  return createHash('sha1').update(parts.map(phpStr).join('\n'), 'utf8').digest('hex').slice(0, 12);
}

// oys_og_url()
export function ogUrl(page: Record<string, unknown>): string {
  return pageOrigin(page as unknown as PageLike) + '/_/og/' + intval(page.id) + '-' + ogHash(page) + '.png';
}
