// Social-Plattformen, Marken-Icons und Symbole (lib/social.php)
import { e } from '../html.js';
import { phpTrim, rawurlencode, strtolower, phpLtrim } from '../php.js';
import { cleanUrl, validateEmail } from '../helpers.js';
import { phpParseUrl } from '../compat/core.js';
import { BRAND_ICONS, type Brand } from './brandIcons.js';

export type { Brand };

for (const b of Object.values(BRAND_ICONS)) Object.freeze(Object.freeze(b).domains);
Object.freeze(BRAND_ICONS);

// oys_brands(): die 27 Plattformen (eingefroren)
export const brands = (): Record<string, Brand> => BRAND_ICONS;

const isBrand = (key: string): boolean => Object.hasOwn(BRAND_ICONS, key);

// oys_brand_svg(): unbekannte Plattform → Link-Symbol
export function brandSvg(key: string, cls = 'oys-ico'): string {
  if (!isBrand(key)) return uiIcon('link', cls);
  return '<svg class="' + e(cls) + '" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' + BRAND_ICONS[key].svg + '</svg>';
}

// oys_detect_brand(): erkennt die Plattform an der Adresse (instagram.com → instagram)
export function detectBrand(url: string): string | null {
  const lower = strtolower(url);
  if (lower.startsWith('mailto:')) return 'email';
  const parts = phpParseUrl(lower) as false | { host?: string };
  let host = parts === false ? '' : (parts.host ?? '');
  if (host === '') return null;
  host = host.replace(/^(www|m|mobile|open|music|vm)\./, '');
  for (const [key, brand] of Object.entries(BRAND_ICONS)) {
    for (const domain of brand.domains) {
      if (host === domain || host.endsWith('.' + domain)) return key;
    }
  }
  // Mastodon-Instanzen erkennt man am /@name ($ von PCRE passt auch vor einem letzten \n)
  if (/^https?:\/\/[^/]+\/@[a-z0-9_]+(?=\n?$)/i.test(url) && host.includes('mastodon')) return 'mastodon';
  return null;
}

// Buchstaben und Ziffern aus Unicode 15 und 16: JavaScript kennt sie, PHPs PCRE2 10.42 (Unicode 14) nicht –
// dort entfernt [^\p{L}\p{N}._\-] sie also. Geprüft über alle Codepoints gegen PHP (test/model-social.test.ts).
const NEWER_LETTERS = '\\u{1C89}-\\u{1C8A}\\u{A7CB}-\\u{A7CD}\\u{A7DA}-\\u{A7DC}\\u{105C0}-\\u{105F3}\\u{10D40}-\\u{10D65}\\u{10D6F}-\\u{10D85}'
  + '\\u{10EC2}-\\u{10EC4}\\u{1123F}-\\u{11240}\\u{11380}-\\u{11389}\\u{1138B}\\u{1138E}\\u{11390}-\\u{113B5}\\u{113B7}\\u{113D1}\\u{113D3}'
  + '\\u{116D0}-\\u{116E3}\\u{11BC0}-\\u{11BE0}\\u{11BF0}-\\u{11BF9}\\u{11F02}\\u{11F04}-\\u{11F10}\\u{11F12}-\\u{11F33}\\u{11F50}-\\u{11F59}'
  + '\\u{1342F}\\u{13441}-\\u{13446}\\u{13460}-\\u{143FA}\\u{16100}-\\u{1611D}\\u{16130}-\\u{16139}\\u{16D40}-\\u{16D6C}\\u{16D70}-\\u{16D79}'
  + '\\u{18CFF}\\u{1B132}\\u{1B155}\\u{1CCF0}-\\u{1CCF9}\\u{1D2C0}-\\u{1D2D3}\\u{1DF25}-\\u{1DF2A}\\u{1E030}-\\u{1E06D}\\u{1E4D0}-\\u{1E4EB}'
  + '\\u{1E4F0}-\\u{1E4F9}\\u{1E5D0}-\\u{1E5ED}\\u{1E5F0}-\\u{1E5FA}\\u{2B739}\\u{2EBF0}-\\u{2EE5D}\\u{31350}-\\u{323AF}';
const HANDLE_JUNK = new RegExp(`[^\\p{L}\\p{N}._-]|[${NEWER_LETTERS}]`, 'gu');

// oys_social_url(): baut aus Benutzername oder Adresse die fertige Profil-URL
export function socialUrl(platform: string, value: string): string {
  value = phpTrim(value);
  if (value === '') return '';
  if (/^(https?:\/\/|mailto:|tel:)/i.test(value)) return cleanUrl(value);
  if (platform === 'email') return validateEmail(value) ? 'mailto:' + value : '';
  if (platform === 'whatsapp') {
    let digits = value.replace(/[^0-9]/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    return digits !== '' ? 'https://wa.me/' + digits : '';
  }
  const m = platform === 'mastodon' ? /^@?([a-z0-9_.]+)@([a-z0-9.-]+\.[a-z]{2,})(?=\n?$)/i.exec(value) : null;
  if (m) return 'https://' + m[2] + '/@' + m[1];
  const template = isBrand(platform) ? BRAND_ICONS[platform].url : '';
  // Sieht es aus wie eine Domain? Dann als Adresse behandeln.
  if (template === '' || /^[a-z0-9.-]+\.[a-z]{2,}(\/|(?=\n?$))/i.test(value)) return cleanUrl(value);
  const handle = phpLtrim(value, '@').replace(HANDLE_JUNK, '');
  return handle === '' ? '' : template.split('{u}').join(rawurlencode(handle));
}

// oys_icon_html(): Symbol für einen Link – '' = automatisch, 'brand:instagram' oder Boxicons-Klasse 'bx bx-music'
export function iconHtml(icon: string, url = ''): string {
  icon = phpTrim(icon);
  if (icon === '' || icon === 'auto') {
    if (/^tel:/i.test(url)) return uiIcon('phone');
    const brand = detectBrand(url);
    return brand ? brandSvg(brand) : '';
  }
  if (icon.startsWith('brand:')) return brandSvg(icon.slice(6));
  if (/^bx[sl]? bx[sl]?-[a-z0-9-]+(?=\n?$)/.test(icon)) return '<i class="oys-ico ' + e(icon) + '" aria-hidden="true"></i>';
  return '';
}

// oys_icon_uses_boxicons()
export const iconUsesBoxicons = (icon: string): boolean => /^bx[sl]? /.test(phpTrim(icon));

// Einfache Linien-Symbole für die Oberfläche der Profilseite
const UI_PATHS: Record<string, string> = Object.freeze({
  arrow: '<path d="M5 12h14M13 5l7 7-7 7"/>',
  external: '<path d="M14 3h7v7M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  play: '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>',
  volume: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
  mute: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="m23 9-6 6M17 9l6 6"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  'eye-off': '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24M1 1l22 22"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  sparkle: '<path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z"/>',
  share: '<path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="m16 6-4-4-4 4M12 2v14"/>',
});

// oys_ui_icon(): unbekannter Name → Link-Symbol
export function uiIcon(name: string, cls = 'oys-ico'): string {
  const inner = Object.hasOwn(UI_PATHS, name) ? UI_PATHS[name] : UI_PATHS.link;
  return '<svg class="' + e(cls) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
}

// Allgemeine Symbole (Boxicons) für die Symbol-Auswahl im Editor
const BX_ICONS: readonly string[] = Object.freeze([
  'bx bx-link', 'bx bx-globe', 'bx bx-envelope', 'bx bx-phone', 'bx bx-store', 'bx bx-cart', 'bx bx-shopping-bag', 'bx bx-gift',
  'bx bx-music', 'bx bx-headphone', 'bx bx-microphone', 'bx bx-radio', 'bx bx-video', 'bx bx-camera', 'bx bx-image', 'bx bx-movie-play',
  'bx bx-game', 'bx bx-joystick', 'bx bx-trophy', 'bx bx-crown', 'bx bx-star', 'bx bx-heart', 'bx bx-like', 'bx bx-happy',
  'bx bx-coffee', 'bx bx-restaurant', 'bx bx-cake', 'bx bx-palette', 'bx bx-brush', 'bx bx-pen', 'bx bx-book', 'bx bx-book-open',
  'bx bx-code-alt', 'bx bx-terminal', 'bx bx-chip', 'bx bx-server', 'bx bx-rocket', 'bx bx-bulb', 'bx bx-briefcase', 'bx bx-building',
  'bx bx-calendar', 'bx bx-time', 'bx bx-map', 'bx bx-home', 'bx bx-donate-heart', 'bx bx-dollar-circle', 'bx bx-credit-card', 'bx bx-wallet',
  'bx bx-news', 'bx bx-podcast', 'bx bx-broadcast', 'bx bx-chat', 'bx bx-message-rounded', 'bx bx-group', 'bx bx-user', 'bx bx-id-card',
  'bx bx-download', 'bx bx-file', 'bx bx-paper-plane', 'bx bx-planet', 'bx bx-leaf', 'bx bx-dumbbell', 'bx bx-car', 'bx bx-bone',
]);

// oys_bx_icons()
export const bxIcons = (): readonly string[] => BX_ICONS;
