// Beispielseiten für die Startseite (Handy-Vorschau mit Punkten) und als Vorlage (lib/demo.php)
import { timeZone } from '../db.js';
import { e, phpJson } from '../html.js';
import { wallTime } from '../php.js';
import { defaultSettings } from './pages.js';
import { brandSvg } from './social.js';
import { themes } from './themes.js';

export interface DemoBlock {
  id: string;
  type: string;
  is_visible: 1;
  data: Record<string, unknown>;
  schedule: null;
  protection: 'none';
  effect: string;
}

export interface DemoPage {
  page: {
    id: 0; slug: string; title: string; subtitle: string; bio: string; avatar: string; bg_image: string;
    theme: string; layout: string; address_mode: 'subdomain'; settings: string;
  };
  blocks: DemoBlock[];
}

const LAYOUTS: Record<string, string> = {
  'deep-dark': 'buttons', galaxy: 'cards', notebook: 'timeline', comic: 'tiles',
  holo: 'cards', sakura: 'buttons', blueprint: 'cards', chalkboard: 'buttons', noir: 'buttons', dune: 'cards',
  ocean: 'buttons', midnight: 'cards', retro: 'buttons', pixel: 'columns',
  newspaper: 'magazine', candy: 'cloud', brutal: 'bento', zen: 'buttons',
  glass: 'apps', code: 'cards', cafe: 'cards', neon: 'buttons', luxe: 'buttons',
};
const RINGS: Record<string, string> = { 'deep-dark': 'accent', galaxy: 'rainbow', neon: 'accent', retro: 'accent', candy: 'story', holo: 'rainbow', sakura: 'story' };

// oys_demo_page(): null für unbekannte Designs. now (Unix-Sekunden) nur für Tests – der Countdown endet in 9 Tagen um 18 Uhr
export function demoPage(theme: string, now: number = Date.now() / 1000): DemoPage | null {
  if (!Object.hasOwn(themes(), theme)) return null;
  const settings = defaultSettings();
  settings.avatar_ring = Object.hasOwn(RINGS, theme) ? RINGS[theme] : 'none';
  settings.particles = theme === 'midnight' ? 'fireflies' : 'none';

  const page: DemoPage['page'] = {
    id: 0,
    slug: 'mia',
    title: 'Mia Sommer',
    subtitle: 'Music & livestreams',
    bio: 'New single out Friday 🎧 Live on Twitch – every Friday from 6 pm.',
    avatar: '',
    bg_image: '',
    theme,
    layout: Object.hasOwn(LAYOUTS, theme) ? LAYOUTS[theme] : 'buttons',
    address_mode: 'subdomain',
    settings: phpJson(settings),
  };

  // (new DateTimeImmutable('today', $tz))->modify('+9 days')->setTime(18, 0): Kalendertag in der Ortszeit + 9
  const w = wallTime(Math.floor(now), timeZone());
  const day = new Date(Date.UTC(w.year, w.month - 1, w.day + 9));
  const pad = (n: number, l = 2): string => String(n).padStart(l, '0');
  const release = pad(day.getUTCFullYear(), 4) + '-' + pad(day.getUTCMonth() + 1) + '-' + pad(day.getUTCDate()) + 'T18:00';

  let i = 0;
  const block = (type: string, data: Record<string, unknown>, effect = 'none'): DemoBlock =>
    ({ id: 'demo' + ++i, type, is_visible: 1, data, schedule: null, protection: 'none', effect });
  const blocks = [
    block('socials', { style: 'icons', items: [
      { p: 'instagram', v: 'mia' }, { p: 'tiktok', v: 'mia' }, { p: 'youtube', v: 'mia' },
      { p: 'twitch', v: 'mia' }, { p: 'discord', v: 'mia' }, { p: 'spotify', v: 'https://open.spotify.com/artist/0' },
    ] }),
    block('link', { title: 'Live now on Twitch', url: 'https://twitch.tv/mia', subtitle: 'Fridays 6–11 pm', icon: '', thumb: '', featured: false }, 'shine'),
    block('link', { title: 'Listen to the new single', url: 'https://open.spotify.com/artist/0', subtitle: 'Spotify', icon: '', thumb: '', featured: false }),
    block('link', { title: 'Merch shop', url: 'https://example.com/shop', subtitle: 'Hoodies & stickers', icon: 'bx bx-shopping-bag', thumb: '', featured: false }, 'wobble'),
    block('link', { title: 'Tour dates 2026', url: 'https://example.com/tour', subtitle: '12 cities', icon: 'bx bx-calendar', thumb: '', featured: false }),
    block('countdown', { title: 'New single drops in', target: release, done_text: 'Out now everywhere!', url: '', url_label: '' }),
  ];
  return { page, blocks };
}

// oys_mini_html(): kleine statische Vorschau eines Designs (Startseite: Leiste mit allen Designs)
export function miniHtml(theme: string, layout = 'buttons'): string {
  const links: Array<[string, string]> = [['Instagram', 'instagram'], ['New video', 'youtube'], ['My website', 'website']];
  let html = '<div class="oys oys-mini t-' + e(theme) + ' l-' + e(layout) + '">'
    + '<div class="oys-bg"><span class="oys-deco oys-deco-1"></span><span class="oys-deco oys-deco-2"></span><span class="oys-deco oys-deco-3"></span></div>'
    + '<div class="oys-main"><header class="oys-head"><div class="oys-avatar shape-circle ring-none"><div class="oys-avatar-inner"><span class="oys-initials">MS</span></div></div>'
    + '<h1 class="oys-name">Mia Sommer</h1><p class="oys-sub">Music &amp; livestreams</p><p class="oys-bio">New single out Friday 🎧</p></header>'
    + '<section class="oys-blocks"><div class="oys-links lay-' + e(layout) + '">';
  links.forEach(([title, brand], i) => {
    html += '<span class="oys-link" style="--i:' + i + '"><span class="oys-link-media"><span class="oys-link-icon">' + brandSvg(brand) + '</span></span>'
      + '<span class="oys-link-body"><span class="oys-link-title">' + e(title) + '</span></span><span class="oys-link-end"></span></span>';
  });
  return html + '</div></section></div></div>';
}
