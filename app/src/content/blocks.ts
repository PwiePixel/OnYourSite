// Blöcke einer Seite: Typen, Prüfung der Eingaben, Einbettungen und Zeitsteuerung (lib/blocks.php).
// Eingaben kommen aus json_decode(…, true): Werte werden mit PHP-Regeln gelesen (own() statt obj[key]).
import { cleanText, cleanUrl, customOrigin, pageUrls, type PageLike } from '../helpers.js';
import { hmac, passwordHash } from '../crypto.js';
import { intval, mbStrlen, mbSubstr, parseStr, phpRtrim, phpStr, phpTrim, phpTruthy, rawurlencode, strtolower, wallTime } from '../php.js';
import { phpParseUrl } from '../compat/core.js';
import { timeZone, type Row } from '../db.js';
import { brands } from './social.js';
import { basename, isArr, own, parseLocalDateTime, values, type PhpArr } from './util.js';

const BLOCK_TYPES: Record<string, string> = Object.freeze({
  link: 'Link',
  socials: 'Social icons',
  heading: 'Heading',
  text: 'Text',
  divider: 'Divider',
  image: 'Image',
  gallery: 'Gallery',
  embed: 'Video & music',
  countdown: 'Countdown',
  contact: 'Contact form',
  booking: 'Book a meeting',
  file: 'File',
});

// oys_block_types()
export const blockTypes = (): Record<string, string> => BLOCK_TYPES;

// oys_block_is_clickable(): Blöcke, auf die man klicken kann (zählen in der Statistik)
export const blockIsClickable = (type: string): boolean => type === 'link' || type === 'booking' || type === 'file';

export const EFFECTS: readonly string[] = Object.freeze(['none', 'shine', 'wobble', 'pulse']);
export const PROTECTIONS: readonly string[] = Object.freeze(['none', 'password', 'age']);
export const LINK_PASSWORD_MIN = 6;

// oys_booking_is_internal(): zeigt ein Termin-Block auf den eingebauten Kalender dieser Seite?
// ('', '/kalender' oder die volle eigene Adresse). extraHosts: eigene Domain der Seite in jedem Zustand (Premium) –
// so bleibt der Schlüssel eines geschützten Kalenders auch dann nötig, wenn die Domain ausfällt oder pausiert.
export function bookingIsInternal(data: unknown, page: PageLike, extraHosts: readonly string[] = []): boolean {
  let url = strtolower(phpRtrim(phpTrim(phpStr(own(data, 'url') ?? '')), '/'));
  if (url === '' || url === '/kalender') return true;
  url = url.replace(/^https?:\/\//, '');
  for (const pageOwn of Object.values(pageUrls(page))) {
    if (url === strtolower(pageOwn.replace(/^https?:\/\//, '')) + '/kalender') return true;
  }
  return extraHosts.some((host) => bookingPointsTo(data, host));
}

// Zeigt ein Termin-Block mit voller Adresse auf den Kalender unter dieser eigenen Domain? (gleiche Schreibweisen wie oben)
export function bookingPointsTo(data: unknown, host: string): boolean {
  const url = strtolower(phpRtrim(phpTrim(phpStr(own(data, 'url') ?? '')), '/')).replace(/^https?:\/\//, '');
  return url === strtolower(customOrigin(host).replace(/^https?:\/\//, '')) + '/kalender';
}

// oys_calendar_key(): Schlüssel, mit dem ein geschützter Termin-Block den Kalender freigibt (ändert sich mit dem Passwort)
export function calendarKey(page: { id?: unknown }, block: { id?: unknown; password_hash?: unknown }): string {
  return hmac('calendar|' + phpStr(page.id) + '|' + phpStr(block.id) + '|' + phpStr(block.password_hash ?? '')).slice(0, 24);
}

// oys_pick(): erlaubter Wert (streng verglichen) oder die Vorgabe
export function pick<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

// oys_valid_upload(): stammt der Dateiname aus unserem Upload-Ordner und gehört er dem Nutzer?
// ($ von PCRE passt auch vor einem letzten \n – das wird hier mit (?=\n?$) nachgebildet, wie überall in dieser Datei)
export function validUpload(file: unknown, userId: number, exts: readonly string[] = []): string | null {
  const name = typeof file === 'string' ? basename(phpTrim(file)) : '';
  const m = /^[a-z]+_(\d+)_[A-Za-z0-9_]+\.([a-z0-9]{2,5})(?=\n?$)/.exec(name);
  if (name === '' || !m) return null;
  if (intval(m[1]) !== userId) return null;
  if (exts.length && !exts.includes(strtolower(m[2]))) return null;
  return name;
}

export const IMAGE_EXTS: readonly string[] = Object.freeze(['jpg', 'jpeg', 'png', 'gif', 'webp']);

export interface Schedule {
  enabled: true;
  days: number[];
  from: string;
  to: string;
  start: string;
  end: string;
}

export interface NormalizedBlock {
  type: string;
  is_visible: 0 | 1;
  data: Record<string, unknown>;
  schedule: Schedule | null;
  protection: string;
  password_hash: string | null;
  effect: string;
  warning: string | null;
}

// password_hash(): wie PHP kein Nullbyte im Passwort (PHP wirft einen ValueError)
async function hashLinkPassword(password: string): Promise<string> {
  if (password.includes('\0')) throw new Error('Bcrypt password must not contain null character');
  return passwordHash(password);
}

// oys_block_normalize(): säubert einen Block aus dem Editor. existing = bisheriger Block aus der DB (oder null).
// Gibt type, is_visible, data, schedule, protection, password_hash, effect und warning zurück (null bei unbekanntem Typ).
export async function blockNormalize(input: PhpArr, userId: number, existing: Row | null = null, forPreview = false): Promise<NormalizedBlock | null> {
  const type = phpStr(own(input, 'type') ?? '');
  if (!Object.hasOwn(BLOCK_TYPES, type)) return null;
  const dataIn = own(input, 'data');
  const d: PhpArr = isArr(dataIn) ? dataIn : [];
  const get = (key: string, fallback: unknown = ''): unknown => own(d, key) ?? fallback;
  const data: Record<string, unknown> = {};
  let warning: string | null = null;

  switch (type) {
    case 'link':
      data.title = cleanText(get('title'), 120);
      data.url = cleanUrl(get('url'), true);
      data.subtitle = cleanText(get('subtitle'), 90);
      data.icon = cleanIcon(get('icon'));
      data.thumb = validUpload(get('thumb'), userId, IMAGE_EXTS) ?? '';
      data.featured = phpTruthy(own(d, 'featured'));
      break;

    case 'socials': {
      const items: Array<{ p: string; v: string }> = [];
      const list = own(d, 'items');
      for (const item of values(isArr(list) ? list : []).slice(0, 30)) {
        const p = phpStr(own(item, 'p') ?? '');
        if (!Object.hasOwn(brands(), p)) continue;
        items.push({ p, v: cleanText(own(item, 'v') ?? '', 200) });
      }
      data.items = items;
      data.style = pick(get('style', 'icons'), ['icons', 'brand', 'pills'], 'icons');
      break;
    }

    case 'heading':
      data.text = cleanText(get('text'), 120);
      data.size = pick(get('size', 'm'), ['s', 'm', 'l'], 'm');
      data.align = pick(get('align', 'center'), ['left', 'center'], 'center');
      break;

    case 'text':
      data.text = cleanText(get('text'), 3000, true);
      data.align = pick(get('align', 'center'), ['left', 'center'], 'center');
      break;

    case 'divider':
      data.style = pick(get('style', 'line'), ['line', 'dots', 'space', 'wave'], 'line');
      break;

    case 'image':
      data.src = validUpload(get('src'), userId, IMAGE_EXTS) ?? '';
      data.alt = cleanText(get('alt'), 150);
      data.caption = cleanText(get('caption'), 150);
      data.url = cleanUrl(get('url'));
      data.ratio = pick(get('ratio', 'auto'), ['auto', 'square', 'wide', 'portrait'], 'auto');
      break;

    case 'gallery': {
      const images: Array<{ src: string; caption: string }> = [];
      const list = own(d, 'images');
      for (const img of values(isArr(list) ? list : []).slice(0, 20)) {
        const src = validUpload(own(img, 'src') ?? '', userId, IMAGE_EXTS);
        if (src) images.push({ src, caption: cleanText(own(img, 'caption') ?? '', 120) });
      }
      data.images = images;
      data.ratio = pick(get('ratio', 'square'), ['square', 'portrait', 'wide'], 'square');
      data.autoplay = phpTruthy(own(d, 'autoplay'));
      break;
    }

    case 'embed': {
      const url = cleanUrl(get('url'));
      data.url = url;
      data.title = cleanText(get('title'), 100);
      data.provider = pick(get('provider'), ['youtube', 'twitch', 'spotify', ''], '');
      const parsed = url !== '' ? parseEmbed(url) : null;
      if (url !== '' && !parsed) warning = 'This address can’t be embedded (supported: YouTube, Twitch, Spotify).';
      if (parsed) data.provider = parsed.provider;
      break;
    }

    case 'countdown': {
      data.title = cleanText(get('title'), 100);
      const target = phpStr(get('target'));
      data.target = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?=\n?$)/.test(target) ? target : '';
      data.done_text = cleanText(get('done_text'), 100);
      data.url = cleanUrl(get('url'));
      data.url_label = cleanText(get('url_label'), 60);
      break;
    }

    case 'contact':
      data.title = cleanText(get('title'), 80);
      data.intro = cleanText(get('intro'), 300, true);
      data.button = cleanText(get('button'), 40);
      data.success = cleanText(get('success'), 150);
      break;

    case 'booking': {
      data.title = cleanText(get('title'), 80);
      const url = cleanUrl(get('url', '/kalender'), true);
      data.url = phpTruthy(url) ? url : '/kalender';
      break;
    }

    case 'file':
      data.title = cleanText(get('title'), 80);
      data.src = validUpload(get('src'), userId, ['pdf', 'vcf', 'zip']) ?? '';
      break;
  }

  let protection = pick(own(input, 'protection') ?? 'none', PROTECTIONS, 'none');
  let passwordHashValue: string | null = null;
  if (!blockIsClickable(type)) protection = 'none';
  const visibleIn = own(input, 'visible');
  let visible: 0 | 1 = visibleIn === undefined || visibleIn === null || phpTruthy(visibleIn) ? 1 : 0;
  if (protection === 'password') {
    const pw = own(input, 'password');
    let newPassword = typeof pw === 'string' ? phpTrim(pw) : '';
    if (newPassword !== '' && mbStrlen(newPassword) < LINK_PASSWORD_MIN) {
      newPassword = '';
      warning = `Link passwords need at least ${LINK_PASSWORD_MIN} characters – the new password wasn’t saved.`;
    }
    if (newPassword !== '') {
      // In der Vorschau wird nicht gehasht (zu langsam bei jedem Tastendruck)
      passwordHashValue = forPreview ? 'preview' : await hashLinkPassword(mbSubstr(newPassword, 0, 100));
    } else if (forPreview) {
      passwordHashValue = 'preview';
    } else if (existing && phpTruthy(existing.password_hash)) {
      passwordHashValue = existing.password_hash as string;
    } else {
      // Nie stillschweigend ungeschützt veröffentlichen: ohne Passwort bleibt der Link ausgeblendet
      visible = 0;
      warning = 'The protected link has no password, so it’s been hidden. Set a password and show it again.';
    }
  }

  return {
    type,
    is_visible: visible,
    data,
    schedule: scheduleNormalize(own(input, 'schedule') ?? null),
    protection,
    password_hash: passwordHashValue,
    effect: blockIsClickable(type) ? pick(own(input, 'effect') ?? 'none', EFFECTS, 'none') : 'none',
    warning,
  };
}

// oys_clean_icon(): '', 'none', 'brand:<bekannt>' oder eine Boxicons-Klasse – sonst ''
export function cleanIcon(icon: unknown): string {
  const s = phpTrim(typeof icon === 'string' ? icon : '');
  if (s === '' || s === 'none') return s;
  if (s.startsWith('brand:') && Object.hasOwn(brands(), s.slice(6))) return s;
  if (/^bx[sl]? bx[sl]?-[a-z0-9-]+(?=\n?$)/.test(s)) return s;
  return '';
}

// ---------------------------------------------------------------
// Einbettungen: YouTube, Twitch, Spotify
// ---------------------------------------------------------------

export interface Embed {
  provider: 'youtube' | 'twitch' | 'spotify';
  kind: string;
  id: string;
  start?: number;
}

// oys_youtube_music(): YouTube-Link als Eingangsmusik (Video, Shorts, YouTube Music oder Playlist)
export function youtubeMusic(url: string): { kind: string; id: string; start: number } | null {
  const embed = url !== '' ? parseEmbed(url) : null;
  if (!embed || embed.provider !== 'youtube') return null;
  return { kind: embed.kind, id: embed.id, start: intval(embed.start ?? 0) };
}

// preg_match() auf einem Wert aus parse_str(): ein Array (v[]=…) ist in PHP ein TypeError (Seite antwortet mit 500)
function matchString(re: RegExp, subject: unknown): boolean {
  if (typeof subject !== 'string') throw new TypeError('preg_match(): Argument #2 ($subject) must be of type string, array given');
  return re.test(subject);
}

// oys_parse_embed()
export function parseEmbed(url: string): Embed | null {
  const parts = phpParseUrl(url) as false | { host?: string; path?: string; query?: string };
  if (parts === false || Object.keys(parts).length === 0 || !phpTruthy(parts.host)) {
    const m = /^spotify:(track|album|playlist|episode|show|artist):([A-Za-z0-9]{10,40})(?=\n?$)/.exec(url);
    return m ? { provider: 'spotify', kind: m[1], id: m[2] } : null;
  }
  const host = strtolower((parts.host as string).replace(/^(www|m|music)\./, ''));
  const path = parts.path ?? '';
  const query = parseStr(parts.query ?? '');
  let m: RegExpExecArray | null;

  // YouTube
  if (host === 'youtube.com' || host === 'youtu.be' || host === 'youtube-nocookie.com') {
    let id: unknown = null;
    if (host === 'youtu.be') {
      id = phpTrim(path, '/');
    } else if (phpTruthy(own(query, 'v'))) {
      id = own(query, 'v');
    } else if ((m = /^\/(embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/.exec(path))) {
      id = m[2];
    }
    let start = 0;
    if (phpTruthy(own(query, 't'))) {
      const t = phpStr(own(query, 't'));
      const tm = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?(?=\n?$)/.exec(t);
      // Riesige Werte laufen wie in PHP über (Kommazahl); exakt nur bis 2^53
      if (tm) start = intval(tm[1] ?? 0) * 3600 + intval(tm[2] ?? 0) * 60 + intval(tm[3] ?? 0);
    }
    if (phpTruthy(id) && matchString(/^[A-Za-z0-9_-]{11}(?=\n?$)/, id)) return { provider: 'youtube', kind: 'video', id: id as string, start };
    const list = own(query, 'list');
    if (phpTruthy(list) && matchString(/^[A-Za-z0-9_-]{10,64}(?=\n?$)/, list)) return { provider: 'youtube', kind: 'playlist', id: list as string };
    return null;
  }

  // Twitch
  if (host === 'clips.twitch.tv') {
    const slug = phpTrim(path, '/');
    return /^[A-Za-z0-9_-]{3,100}(?=\n?$)/.test(slug) ? { provider: 'twitch', kind: 'clip', id: slug } : null;
  }
  if (host === 'twitch.tv') {
    if ((m = /^\/videos\/(\d+)/.exec(path))) return { provider: 'twitch', kind: 'video', id: m[1] };
    if ((m = /^\/[A-Za-z0-9_]{3,25}\/clip\/([A-Za-z0-9_-]{3,100})/.exec(path))) return { provider: 'twitch', kind: 'clip', id: m[1] };
    if ((m = /^\/([A-Za-z0-9_]{3,25})\/?(?=\n?$)/.exec(path))) return { provider: 'twitch', kind: 'channel', id: strtolower(m[1]) };
    return null;
  }

  // Spotify
  if (host === 'open.spotify.com') {
    m = /^\/(?:intl-[a-z-]+\/)?(?:embed\/)?(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]{10,40})/.exec(path);
    if (m) return { provider: 'spotify', kind: m[1], id: m[2] };
  }
  return null;
}

// Ganze Zahl als Text wie PHP (auch über 2^53; 2^63 steht für PHP_INT_MAX)
const intString = (n: number): string => (n === 2 ** 63 ? '9223372036854775807' : Number.isSafeInteger(n) ? String(n) : BigInt(n).toString());

// oys_embed_src(): Adresse für das iframe (Twitch bekommt "parent" erst im Browser angehängt)
export function embedSrc(embed: Embed): string {
  switch (embed.provider) {
    case 'youtube': {
      if (embed.kind === 'playlist') return 'https://www.youtube-nocookie.com/embed/videoseries?list=' + rawurlencode(embed.id) + '&autoplay=1&rel=0';
      const start = phpTruthy(embed.start) ? '&start=' + intString(intval(embed.start)) : '';
      return 'https://www.youtube-nocookie.com/embed/' + rawurlencode(embed.id) + '?autoplay=1&rel=0&playsinline=1' + start;
    }
    case 'twitch':
      if (embed.kind === 'clip') return 'https://clips.twitch.tv/embed?clip=' + rawurlencode(embed.id) + '&autoplay=true';
      if (embed.kind === 'video') return 'https://player.twitch.tv/?video=' + rawurlencode(embed.id) + '&autoplay=true';
      return 'https://player.twitch.tv/?channel=' + rawurlencode(embed.id) + '&autoplay=true';
    case 'spotify':
      return 'https://open.spotify.com/embed/' + embed.kind + '/' + rawurlencode(embed.id) + '?utm_source=oembed';
  }
  return '';
}

// ---------------------------------------------------------------
// Zeitsteuerung
// ---------------------------------------------------------------

// oys_schedule_normalize()
export function scheduleNormalize(input: unknown): Schedule | null {
  if (!isArr(input) || !phpTruthy(own(input, 'enabled'))) return null;
  const daysIn = own(input, 'days') ?? [];
  const days = new Set<number>();
  // (array) $x: ein einzelner Wert wird zur Liste
  for (const raw of isArr(daysIn) ? values(daysIn) : [daysIn]) {
    const day = intval(raw);
    if (day >= 1 && day <= 7) days.add(day);
  }
  const time = (v: unknown): string => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d(?=\n?$)/.test(v) ? v : '');
  const date = (v: unknown): string => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?=\n?$)/.test(v) ? v : '');
  return {
    enabled: true,
    days: [...days].sort((a, b) => a - b),
    from: time(own(input, 'from') ?? ''),
    to: time(own(input, 'to') ?? ''),
    start: date(own(input, 'start') ?? ''),
    end: date(own(input, 'end') ?? ''),
  };
}

// oys_schedule_active(): ist der Block gerade sichtbar? now = Unix-Sekunden, gerechnet in der Zeitzone der Seite.
// Start/Ende außerhalb der erlaubten Werte (Monat 13 …) werfen wie in PHP einen Fehler.
export function scheduleActive(s: unknown, now: number = Date.now() / 1000, tz = timeZone()): boolean {
  if (!isArr(s) || !phpTruthy(s) || !phpTruthy(own(s, 'enabled'))) return true;
  const start = own(s, 'start');
  if (phpTruthy(start) && now < parseLocalDateTime(phpStr(start), tz)) return false;
  const end = own(s, 'end');
  if (phpTruthy(end) && now >= parseLocalDateTime(phpStr(end), tz)) return false;
  const days = own(s, 'days') ?? [];
  if (phpTruthy(days) && !isArr(days)) throw new TypeError('count(): Argument #1 ($value) must be of type Countable|array');
  const list = values(days);
  const allDays = !phpTruthy(days) || list.length === 7;
  // in_array(…, true): nur echte Zahlen (ein "5" als Text zählt nicht)
  const dayOk = (n: number): boolean => allDays || list.some((x) => typeof x === 'number' && x === n);
  const w = wallTime(Math.floor(now), tz);
  const weekday = w.weekday === 0 ? 7 : w.weekday;
  const hm = String(w.hour).padStart(2, '0') + ':' + String(w.minute).padStart(2, '0');
  const from = phpStr(own(s, 'from') ?? '');
  const to = phpStr(own(s, 'to') ?? '');

  if (from !== '' && to !== '') {
    if (from <= to) return dayOk(weekday) && hm >= from && hm < to;
    // Über Mitternacht, z. B. 22:00–02:00
    if (hm >= from) return dayOk(weekday);
    if (hm < to) return dayOk(weekday === 1 ? 7 : weekday - 1);
    return false;
  }
  if (from !== '') return dayOk(weekday) && hm >= from;
  if (to !== '') return dayOk(weekday) && hm < to;
  return dayOk(weekday);
}
