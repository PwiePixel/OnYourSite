// Erzeugt die Profilseite (lib/render.php). Wird für die öffentliche Seite UND die Editor-Vorschau benutzt,
// damit die Vorschau exakt so aussieht wie die echte Seite. Die Ausgabe ist Byte für Byte die von PHP: der feste
// Text stammt aus view2ts, die Werte werden mit PHP-Regeln gelesen (Daten aus json_decode haben beliebige Typen).
import { PCRE_WS } from '../compat/core.js';
import { hmac } from '../crypto.js';
import { timeZone } from '../db.js';
import { asset, baseHost, cleanUrl, initials, mainUrl, pageUrl, prettyUrl, uploadUrl, type PageLike } from '../helpers.js';
import { e, phpJson, type SafeHtml } from '../html.js';
import { intval, isNumeric, mbSubstr, nl2br, phpStr, phpTrim, phpTruthy, strtolower, strtoupper, time } from '../php.js';
import { embedSrc, parseEmbed, scheduleActive, youtubeMusic } from './blocks.js';
import { pageSettings } from './pages.js';
import { OG_HEIGHT, OG_WIDTH, ogSupported, ogUrl, shareLinks } from './share.js';
import { brands, brandSvg, iconHtml, iconUsesBoxicons, socialUrl, uiIcon } from './social.js';
import { DEFAULT_THEME, layoutKey, themeKey, themes } from './themes.js';
import { idx, JsonEncodeError, nullableStrArg, PhpFloat, phpFloatStr, phpNumber, phpRound, strArg, withPhpFloats } from './phpValues.js';
import { basename, entries, isArr, own, parseLocalDateTime, values } from './util.js';
import { uiAssets } from '../views/partials/ui.js';

type Rec = Record<string, unknown>;

// Optionen wie $opts in PHP: mode public|preview|demo, entrance auto|show|skip, now (Unix-Sekunden), host, notice
export interface RenderOptions {
  mode?: string;
  entrance?: string;
  now?: number;
  host?: string;
  notice?: string | null;
}

// $ctx der Block-Funktionen
interface RenderCtx {
  page: Rec;
  mode: string;
  preview: boolean;
  layout: string;
  now: number;
  tz: string;
  notice: string | null;
}

// oys_upload_url(?string $file)
const uploadUrlOf = (v: unknown): string => uploadUrl(nullableStrArg(v));

// $x / 100
const div100 = (v: unknown): number => phpNumber(v) / 100;

// pathinfo($p, PATHINFO_EXTENSION): Teil nach dem letzten Punkt des Dateinamens
function extension(p: string): string {
  const name = basename(p);
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1) : '';
}

// Schlüssel eines PHP-Arrays: "5" ist dort die Zahl 5
const intKey = (k: string): number | null => (/^(0|-?[1-9]\d*)$/.test(k) && Number.isSafeInteger(Number(k)) ? Number(k) : null);

// DateTimeImmutable::format(DATE_ATOM) in der Zeitzone der Seite (Jahr mit mind. 4 Stellen, vor Christus mit „-“,
// Abstand zu UTC wie 'P': vor 1893 die Ortszeit, z. B. +00:53)
const atomFormats = new Map<string, Intl.DateTimeFormat>();
function dateAtom(unix: number, tz: string): string {
  let f = atomFormats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', era: 'short', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    atomFormats.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(unix * 1000))) p[x.type] = x.value;
  const year = p.era === 'BC' ? 1 - Number(p.year) : Number(p.year);
  const [mo, d, h, mi, s] = [p.month, p.day, p.hour, p.minute, p.second].map(Number);
  const t = new Date(0);
  t.setUTCFullYear(year, mo - 1, d);
  t.setUTCHours(h, mi, s, 0);
  const off = Math.round((t.getTime() - unix * 1000) / 1000);
  const a = Math.abs(off);
  const pad = (n: number, l = 2): string => String(n).padStart(l, '0');
  return (year < 0 ? '-' + pad(-year, 4) : pad(year, 4)) + '-' + pad(mo) + '-' + pad(d) + 'T' + pad(h) + ':' + pad(mi) + ':' + pad(s)
    + (off < 0 ? '-' : '+') + pad(Math.floor(a / 3600)) + ':' + pad(Math.floor((a % 3600) / 60));
}

// /\s+/u von PCRE (Unicode-Leerraum, aber nicht U+FEFF)
const U_SPACES = new RegExp('[' + PCRE_WS + ']+', 'gu');

const OFF_BADGE = (): string => '<span class="oys-off-badge">' + uiIcon('clock') + ' Hidden right now</span>';

// ---------------------------------------------------------------- Seite

// oys_render_page(): $page = Zeile aus "pages" (oder Entwurf aus dem Editor), $blocks wie aus oys_load_blocks()
export function renderPage(pageIn: object, blocks: ReadonlyArray<object>, opts: RenderOptions = {}): string {
  const page = pageIn as Rec;
  const mode = opts.mode ?? 'public';
  const isPreview = mode !== 'public';
  const settings = pageSettings(page);
  const theme = themeKey(page.theme ?? DEFAULT_THEME);
  const layout = layoutKey(page.layout ?? 'buttons');
  const themeMeta = themes()[theme];
  const tz = timeZone();
  const now = opts.now ?? Date.now() / 1000;
  const seo = settings.seo;

  const title = phpTrim(phpStr(page.title ?? ''));
  const seoTitle: unknown = phpTruthy(idx(seo, 'title')) ? idx(seo, 'title') : (title !== '' ? title : phpStr(idx(page, 'slug'))) + ' | OnYourSite';
  const description: unknown = phpTruthy(idx(seo, 'description'))
    ? idx(seo, 'description')
    : mbSubstr(phpTrim(phpStr(page.bio ?? '').replace(U_SPACES, ' ')), 0, 160);
  const canonical = page.slug !== undefined && page.slug !== null ? pageUrl(page as unknown as PageLike) : '';
  const avatarUrl = phpTruthy(page.avatar) ? uploadUrlOf(page.avatar) : '';
  // Vorschaubild für geteilte Links: eigene Karte, sonst das Profilbild
  const ogCard = !isPreview && phpTruthy(page.id) && canonical !== '' && ogSupported();
  const ogImage = ogCard ? ogUrl(page) : avatarUrl !== '' ? mainUrl(avatarUrl) : '';
  const shareTitle = title !== '' ? title : phpStr(page.slug ?? '');

  // Sichtbare Blöcke bestimmen
  const visible: Rec[] = [];
  let needsBoxicons = false;
  for (const raw of blocks) {
    // empty($b['is_visible']): auch Einträge, die keine Arrays sind, fallen hier heraus
    if (!isArr(raw) || !phpTruthy(own(raw, 'is_visible'))) continue;
    const b = raw as Rec;
    const schedule = b.schedule ?? null;
    // oys_schedule_active(?array $s, …)
    if (schedule !== null && !isArr(schedule)) throw new TypeError('oys_schedule_active(): Argument #1 ($s) must be of type ?array');
    const active = scheduleActive(schedule, now, tz);
    if (!active && !isPreview) continue;
    const block: Rec = { ...b, _off: !active };
    if (!blockHasContent(block, isPreview)) continue;
    if (block.type === 'link' && iconUsesBoxicons(phpStr(own(block.data, 'icon') ?? ''))) needsBoxicons = true;
    visible.push(block);
  }

  const ctx: RenderCtx = { page, mode, preview: isPreview, layout, now, tz, notice: opts.notice ?? null };

  // Body-Klassen
  const classes = ['oys', 't-' + theme, 'l-' + layout, 'mode-' + phpStr(mode)];
  if (phpTruthy(settings.font)) classes.push('f-' + phpStr(settings.font));
  if (phpTruthy(settings.button)) classes.push('btn-' + phpStr(settings.button));
  if (phpTruthy(page.bg_image)) classes.push('has-bgimg');

  const entrance = settings.entrance;
  // Musik: hochgeladene Datei, sonst Link (MP3 oder YouTube – YouTube lädt erst nach dem Tippen)
  const musicYoutube = !phpTruthy(idx(entrance, 'music')) ? youtubeMusic(strArg(idx(entrance, 'music_url'))) : null;
  const music: unknown = phpTruthy(idx(entrance, 'music'))
    ? uploadUrlOf(idx(entrance, 'music'))
    : musicYoutube ? '' : phpTruthy(idx(entrance, 'music_url')) ? idx(entrance, 'music_url') : '';
  const showEntrance = phpTruthy(idx(entrance, 'enabled')) && (opts.entrance ?? (isPreview ? 'skip' : 'auto')) !== 'skip';
  if (showEntrance) classes.push('has-entrance');

  const style: string[] = [];
  if (phpTruthy(settings.accent)) style.push('--accent:' + phpStr(settings.accent));
  if (phpTruthy(page.bg_image)) style.push('--bg-overlay:' + phpFloatStr(phpRound(div100(settings.bg_overlay), 2)));

  // hosts: array_values(array_unique(array_filter([...]))) – leere Werte und "0" fallen weg, Vergleich als Text
  const hosts: string[] = [];
  for (const h of [opts.host ?? '', baseHost()]) {
    if (phpTruthy(h) && !hosts.includes(phpStr(h))) hosts.push(phpStr(h));
  }
  // $x / 100 ist in PHP nur dann int, wenn eine ganze Zahl aufgeht – ab 1e17 (also $x ab 1e19, über PHP_INT_MAX)
  // ist es immer eine Kommazahl
  const volume = div100(idx(entrance, 'volume'));
  const config = {
    page: page.id !== undefined && page.id !== null ? intval(page.id) : 0,
    mode,
    particles: settings.particles,
    sparks: phpTruthy(settings.cursor_sparks),
    entrance: showEntrance ? idx(entrance, 'animation') : '',
    music: showEntrance ? music : '',
    musicYoutube: showEntrance ? musicYoutube : null,
    dark: themeMeta.dark,
    volume: Number.isInteger(volume) && Math.abs(volume) >= 1e17 ? new PhpFloat(volume) : volume,
    loop: phpTruthy(idx(entrance, 'loop')),
    hosts,
    share: phpTruthy(settings.share_button) && canonical !== '' && mode !== 'demo'
      ? { url: canonical, title: shareTitle, js: asset('/static/js/share.js'), qr: asset('/static/vendor/qrcode/qrcode.js') }
      : null,
  };

  let o = '';
  o += "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<title>";
  o += e(seoTitle);
  o += "</title>\n";
  if (description !== '') {
    o += "<meta name=\"description\" content=\"";
    o += e(description);
    o += "\">";
  }
  if (idx(seo, 'keywords') !== '') {
    o += "<meta name=\"keywords\" content=\"";
    o += e(idx(seo, 'keywords'));
    o += "\">";
  }
  if (isPreview) {
    o += "<meta name=\"robots\" content=\"noindex\">";
  } else if (canonical !== '') {
    o += "<link rel=\"canonical\" href=\"";
    o += e(canonical);
    o += "\">";
  }
  o += "<meta property=\"og:title\" content=\"";
  o += e(seoTitle);
  o += "\">\n<meta property=\"og:type\" content=\"profile\">\n";
  if (canonical !== '') {
    o += "<meta property=\"og:url\" content=\"";
    o += e(canonical);
    o += "\">";
  }
  if (description !== '') {
    o += "<meta property=\"og:description\" content=\"";
    o += e(description);
    o += "\">";
  }
  if (ogImage !== '') {
    o += "<meta property=\"og:image\" content=\"";
    o += e(ogImage);
    o += "\">\n";
    if (ogCard) {
      o += "<meta property=\"og:image:width\" content=\"";
      o += OG_WIDTH;
      o += "\"><meta property=\"og:image:height\" content=\"";
      o += OG_HEIGHT;
      o += "\"><meta property=\"og:image:alt\" content=\"";
      o += e(shareTitle);
      o += " on OnYourSite\">";
    }
  }
  o += "<meta name=\"twitter:card\" content=\"";
  o += ogCard ? 'summary_large_image' : 'summary';
  o += "\">\n<meta name=\"twitter:title\" content=\"";
  o += e(seoTitle);
  o += "\">\n";
  if (description !== '') {
    o += "<meta name=\"twitter:description\" content=\"";
    o += e(description);
    o += "\">";
  }
  if (ogImage !== '') {
    o += "<meta name=\"twitter:image\" content=\"";
    o += e(ogImage);
    o += "\">";
  }
  o += "<meta name=\"theme-color\" content=\"";
  o += e(themeMeta.dark ? '#0b0b0d' : '#ffffff');
  o += "\">\n<link rel=\"icon\" type=\"image/png\" href=\"/static/images/favicon.png\">\n<link rel=\"preload\" href=\"/static/fonts/";
  o += e(phpTruthy(settings.font) ? settings.font : themeMeta.font);
  o += ".woff2\" as=\"font\" type=\"font/woff2\" crossorigin>\n<link rel=\"stylesheet\" href=\"";
  o += e(asset('/static/css/fonts.css'));
  o += "\">\n<link rel=\"stylesheet\" href=\"";
  o += e(asset('/static/css/themes.css'));
  o += "\">\n<link rel=\"stylesheet\" href=\"";
  o += e(asset('/static/css/page.css'));
  o += "\">\n";
  if (needsBoxicons) {
    o += "<link rel=\"stylesheet\" href=\"";
    o += e(asset('/static/vendor/boxicons/css/boxicons.min.css'));
    o += "\">";
  }
  if (settings.custom_css !== '') {
    o += "<style id=\"oys-custom-css\">";
    // Bereits von oys_clean_css() gesäubert (enthält kein „<“) – wie in PHP unmaskiert
    o += settings.custom_css;
    o += "</style>";
  }
  o += "<noscript><style>.has-entrance .oys-main{opacity:1!important;transform:none!important}.oys-entrance{display:none!important}</style></noscript>\n</head>\n<body class=\"";
  o += e(classes.join(' '));
  o += "\"";
  o += style.length ? ' style="' + e(style.join(';')) + '"' : '';
  o += ">\n<div class=\"oys-bg\" aria-hidden=\"true\"><span class=\"oys-deco oys-deco-1\"></span><span class=\"oys-deco oys-deco-2\"></span><span class=\"oys-deco oys-deco-3\"></span></div>\n";
  if (phpTruthy(page.bg_image)) {
    o += "<div class=\"oys-bgimg\" aria-hidden=\"true\" style=\"background-image:url('";
    o += e(uploadUrlOf(page.bg_image));
    o += "')\"></div>";
  }
  o += "<main class=\"oys-main profile-container\">\n  <header class=\"oys-head\">\n    <div class=\"oys-avatar shape-";
  o += e(settings.avatar_shape);
  o += " ring-";
  o += e(settings.avatar_ring);
  o += "\">\n      <div class=\"oys-avatar-inner\">\n        ";
  if (avatarUrl !== '') {
    o += "<img src=\"";
    o += e(avatarUrl);
    o += "\" alt=\"";
    o += e(title);
    o += "\" width=\"112\" height=\"112\">";
  } else {
    o += "<span class=\"oys-initials\">";
    o += e(initials(title !== '' ? title : phpStr(page.slug ?? '')));
    o += "</span>";
  }
  o += "      </div>\n    </div>\n    ";
  if (title !== '') {
    o += "<h1 class=\"oys-name\" data-text=\"";
    o += e(title);
    o += "\">";
    o += e(title);
    o += "</h1>";
  }
  o += "    ";
  if (phpTruthy(page.subtitle)) {
    o += "<p class=\"oys-sub\">";
    o += e(page.subtitle);
    o += "</p>";
  }
  o += "    ";
  if (phpTruthy(page.bio)) {
    o += "<p class=\"oys-bio\">";
    o += nl2br(e(page.bio));
    o += "</p>";
  }
  o += "  </header>\n\n  <section class=\"oys-blocks links-container\">\n";
  // Links, Termine und Dateien hintereinander bilden eine Gruppe (Anordnung per CSS)
  let group: Rec[] = [];
  const flush = (): void => {
    if (group.length) {
      o += renderLinkGroup(group, ctx);
      group = [];
    }
  };
  for (const b of visible) {
    if (b.type === 'link' || b.type === 'booking' || b.type === 'file') {
      group.push(b);
      continue;
    }
    flush();
    o += renderBlock(b, ctx);
  }
  flush();
  if (!visible.length && isPreview) {
    o += '<p class="oys-empty">Add links or blocks in the editor on the left – they’ll show up here right away.</p>';
  }
  o += "  </section>\n\n  ";
  if (!phpTruthy(settings.hide_branding)) {
    o += "  <footer class=\"oys-foot\"><a href=\"";
    o += e(mainUrl('/'));
    o += "\" target=\"_blank\" rel=\"noopener\">Made with <strong>OnYourSite</strong></a></footer>\n  ";
  }
  o += "</main>\n\n";
  if (showEntrance) {
    o += "<div class=\"oys-entrance anim-";
    o += e(idx(entrance, 'animation'));
    o += "\" role=\"button\" tabindex=\"0\" aria-label=\"";
    o += e(idx(entrance, 'text'));
    o += "\">\n  <div class=\"oys-entrance-half oys-entrance-left\"></div><div class=\"oys-entrance-half oys-entrance-right\"></div>\n  <div class=\"oys-entrance-inner\">\n    <div class=\"oys-entrance-avatar\">";
    if (avatarUrl !== '') {
      o += "<img src=\"";
      o += e(avatarUrl);
      o += "\" alt=\"\">";
    } else {
      o += "<span class=\"oys-initials\">";
      o += e(initials(title !== '' ? title : phpStr(page.slug ?? '')));
      o += "</span>";
    }
    o += "</div>\n    ";
    if (title !== '') {
      o += "<div class=\"oys-entrance-name\">";
      o += e(title);
      o += "</div>";
    }
    o += "    <div class=\"oys-entrance-cta\">";
    o += phpTruthy(music) ? uiIcon('volume') : uiIcon('sparkle');
    o += "<span>";
    o += e(idx(entrance, 'text'));
    o += "</span></div>\n  </div>\n</div>\n";
  }
  if (config.share) {
    const links = shareLinks(canonical, shareTitle);
    o += "<button type=\"button\" class=\"oys-share\" aria-label=\"Share this page\" title=\"Share\">";
    o += uiIcon('share');
    o += "</button>\n<template id=\"oys-share-tpl\">\n  <h2 id=\"oys-modal-title\">Share this page</h2>\n  <div class=\"oys-share-qr\"><span class=\"oys-share-wait\"></span></div>\n  <p class=\"oys-share-url\">";
    o += e(canonical.replace(/^https?:\/\//, ''));
    o += "</p>\n  <button type=\"button\" class=\"oys-btn\" data-share=\"copy\">";
    o += uiIcon('link');
    o += "<span>Copy link</span></button>\n  <div class=\"oys-share-row\">\n    <a class=\"oys-btn ghost\" href=\"";
    o += e(links.whatsapp);
    o += "\" target=\"_blank\" rel=\"noopener\">";
    o += brandSvg('whatsapp');
    o += "<span>WhatsApp</span></a>\n    <a class=\"oys-btn ghost\" href=\"";
    o += e(links.x);
    o += "\" target=\"_blank\" rel=\"noopener\">";
    o += brandSvg('x');
    o += "<span>X</span></a>\n    <button type=\"button\" class=\"oys-btn ghost\" data-share=\"discord\">";
    o += brandSvg('discord');
    o += "<span>Discord</span></button>\n  </div>\n  <button type=\"button\" class=\"oys-btn ghost\" data-share=\"native\" hidden>";
    o += uiIcon('share');
    o += "<span>More options</span></button>\n</template>\n";
  }
  if (phpTruthy(music) && showEntrance) {
    o += "<audio id=\"oys-audio\" src=\"";
    o += e(music);
    o += "\" preload=\"none\"";
    o += phpTruthy(idx(entrance, 'loop')) ? ' loop' : '';
    o += "></audio>\n";
  } else if (musicYoutube && showEntrance) {
    o += "<div class=\"oys-yt\" aria-hidden=\"true\"><div id=\"oys-yt\"></div></div>\n";
  }
  if ((phpTruthy(music) || musicYoutube) && showEntrance) {
    o += "<button type=\"button\" class=\"oys-mute\" hidden aria-label=\"Mute music\">";
    o += uiIcon('volume', 'oys-ico on');
    o += uiIcon('mute', 'oys-ico off');
    o += "</button>\n";
  }
  o += "\n<div class=\"oys-modal\" id=\"oys-modal\" hidden>\n  <div class=\"oys-modal-box\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"oys-modal-title\">\n    <button type=\"button\" class=\"oys-modal-close\" aria-label=\"Close\">";
  o += uiIcon('close');
  o += "</button>\n    <div class=\"oys-modal-body\"></div>\n  </div>\n</div>\n\n<script id=\"oys-config\" type=\"application/json\">";
  // Kommazahlen wie json_encode(); an INF/NAN (z. B. "volume": 1e999) scheitert es und gibt nichts aus
  try {
    o += phpJson(withPhpFloats(config), { hexTag: true, hexAmp: true, hexApos: true, hexQuot: true, unescapedSlashes: true });
  } catch (err) {
    if (!(err instanceof JsonEncodeError)) throw err;
  }
  o += "</script>\n";
  // Eigene Dialoge und Formularprüfungen im Design der Seite (vor page.js; beide defer, die Reihenfolge bleibt)
  o += uiAssets('page') + "\n<script src=\"";
  o += e(asset('/static/js/page.js'));
  o += "\" defer></script>\n</body>\n</html>\n";
  return o;
}

// oys_block_has_content(): hat ein Block etwas anzuzeigen? (leere Links werden öffentlich nicht gezeigt)
export function blockHasContent(b: Rec, preview: boolean): boolean {
  const d = b.data ?? null;
  switch (b.type) {
    case 'link': {
      const hasUrl = cleanUrl(phpStr(own(d, 'url') ?? ''), true) !== '';
      return preview ? (own(d, 'title') ?? '') !== '' || hasUrl : hasUrl;
    }
    case 'socials':
      for (const item of values(own(d, 'items') ?? [])) {
        if (socialUrl(strArg(idx(item, 'p')), phpStr(idx(item, 'v'))) !== '') return true;
      }
      return false;
    case 'heading':
    case 'text':
      return phpTrim(phpStr(own(d, 'text') ?? '')) !== '';
    case 'image':
      return phpTruthy(own(d, 'src'));
    case 'gallery':
      return phpTruthy(own(d, 'images'));
    case 'embed':
      return phpTruthy(own(d, 'url')) && (preview || parseEmbed(strArg(own(d, 'url'))) !== null);
    case 'countdown':
      return phpTruthy(own(d, 'target'));
    case 'file':
      return phpTruthy(own(d, 'src'));
    default:
      return true;
  }
}

// ---------------------------------------------------------------
// Links (werden je nach Anordnung per CSS anders dargestellt)
// ---------------------------------------------------------------

// oys_render_link_group()
function renderLinkGroup(links: Rec[], ctx: RenderCtx): string {
  let html = '<div class="oys-links lay-' + e(ctx.layout) + '" data-count="' + links.length + '">';
  links.forEach((b, i) => {
    html += renderLink(b, ctx, i);
  });
  return html + '</div>';
}

// oys_render_link()
function renderLink(b: Rec, ctx: RenderCtx, index: number): string {
  const d = b.data ?? null;
  const page = ctx.page;
  const type = b.type ?? null;
  const id = phpStr(b.id ?? null);
  const attrs: Array<[string, unknown]> = [];
  let download = false;
  const protection = b.protection ?? 'none';
  let title: unknown;
  let url: string;
  let icon: string;
  let sub: unknown;

  if (type === 'booking') {
    title = phpTruthy(own(d, 'title') ?? '') ? own(d, 'title') : 'Book a meeting';
    url = (own(d, 'url') ?? '/kalender') === '/kalender' || (own(d, 'url') ?? '') === ''
      ? (page.slug !== undefined && page.slug !== null ? pageUrl(page as unknown as PageLike, 'kalender') : '#')
      : cleanUrl(phpStr(idx(d, 'url')), true);
    icon = uiIcon('calendar');
    sub = 'Request a meeting';
  } else if (type === 'file') {
    title = phpTruthy(own(d, 'title') ?? '') ? own(d, 'title') : 'Download file';
    url = uploadUrlOf(own(d, 'src') ?? '');
    const ext = strtolower(extension(phpStr(own(d, 'src') ?? '')));
    icon = uiIcon(ext === 'vcf' ? 'user' : 'download');
    sub = strtoupper(ext) + ' file';
    download = true;
  } else {
    url = cleanUrl(phpStr(own(d, 'url') ?? ''), true);
    title = phpStr(own(d, 'title') ?? '');
    if (title === '') {
      title = url !== '' ? prettyUrl(url) : 'New link';
    }
    // Bei geschützten Links kein aus der Zieladresse erkanntes Symbol (verriete z. B. „Discord“)
    icon = iconHtml(phpStr(own(d, 'icon') ?? ''), protection === 'none' ? url : '');
    sub = (own(d, 'subtitle') ?? '') !== '' ? own(d, 'subtitle') : url !== '' ? prettyUrl(url) : '';
  }

  const classes = ['oys-link', 'type-' + phpStr(type)];
  if ((b.effect ?? 'none') !== 'none') classes.push('fx-' + phpStr(b.effect));
  if (phpTruthy(own(d, 'featured'))) classes.push('is-featured');
  if (phpTruthy(own(d, 'thumb'))) classes.push('has-thumb');
  if (!phpTruthy(icon)) classes.push('no-icon');
  if (phpTruthy(b._off)) classes.push('is-off');
  if (url === '') classes.push('is-empty');

  let href: string;
  if (protection !== 'none') {
    // Die Zieladresse darf bei geschützten Links nirgends im HTML auftauchen
    sub = (own(d, 'subtitle') ?? '') !== '' ? own(d, 'subtitle') : protection === 'age' ? '18+ only' : 'Password protected';
    if (title === prettyUrl(url)) {
      title = 'Protected link';
    }
    classes.push('is-protected');
    attrs.push(['data-protect', protection]);
    href = '/_/go/' + intval(id);
  } else {
    href = url !== '' ? url : '#';
  }

  attrs.push(['class', classes.join(' ')], ['href', href], ['data-b', id], ['style', '--i:' + index]);
  if (download) {
    attrs.push(['download', '']);
  } else if (!/^(mailto|tel):/i.test(href) && href !== '#') {
    attrs.push(['target', '_blank'], ['rel', 'noopener noreferrer']);
  }

  let end = uiIcon('arrow');
  if (protection === 'password') end = uiIcon('lock');
  if (protection === 'age') end = '<span class="oys-badge18">18+</span>';

  let html = '<a';
  for (const [k, v] of attrs) {
    html += ' ' + k + (v === '' && k === 'download' ? '' : '="' + e(v) + '"');
  }
  html += '>';
  html += '<span class="oys-link-media">';
  if (phpTruthy(own(d, 'thumb'))) {
    html += '<img class="oys-link-thumb" src="' + e(uploadUrlOf(own(d, 'thumb'))) + '" alt="" loading="lazy">';
  }
  html += '<span class="oys-link-icon">' + (phpTruthy(icon) ? icon : uiIcon('link')) + '</span></span>';
  html += '<span class="oys-link-body"><span class="oys-link-title">' + e(title) + '</span>';
  if (sub !== '') {
    html += '<span class="oys-link-sub">' + e(sub) + '</span>';
  }
  html += '</span><span class="oys-link-end">' + end + '</span>';
  if (phpTruthy(b._off)) {
    html += OFF_BADGE();
  }
  return html + '</a>';
}

// ---------------------------------------------------------------
// Übrige Blöcke
// ---------------------------------------------------------------

// oys_render_block()
function renderBlock(b: Rec, ctx: RenderCtx): string {
  const d = b.data ?? null;
  const id = phpStr(b.id ?? null);
  const off = phpTruthy(b._off) ? ' is-off' : '';
  const badge = phpTruthy(b._off) ? OFF_BADGE() : '';

  switch (b.type) {
    case 'socials': {
      const style = own(d, 'style') ?? 'icons';
      let html = '<div class="oys-block oys-socials style-' + e(style) + off + '" data-b="' + e(id) + '">';
      const all = brands();
      for (const item of values(own(d, 'items') ?? [])) {
        const url = socialUrl(strArg(idx(item, 'p')), phpStr(idx(item, 'v')));
        if (url === '') continue;
        const p = idx(item, 'p');
        const brand = typeof p === 'string' || typeof p === 'number' ? own(all, phpStr(p)) ?? null : null;
        const target = url.startsWith('mailto:') ? '' : ' target="_blank" rel="noopener noreferrer me"';
        html += '<a class="oys-social" href="' + e(url) + '"' + target + ' data-b="' + e(id) + '" data-s="' + e(p) + '" aria-label="' + e(own(brand, 'name')) + '" title="' + e(own(brand, 'name')) + '" style="--brand:' + e(own(brand, 'color')) + '">'
          + brandSvg(strArg(p))
          + (style === 'pills' ? '<span>' + e(own(brand, 'name')) + '</span>' : '')
          + '</a>';
      }
      return html + badge + '</div>';
    }

    case 'heading': {
      const tag = (own(d, 'size') ?? 'm') === 'l' ? 'h2' : 'h3';
      return '<' + tag + ' class="oys-block oys-heading size-' + e(own(d, 'size') ?? 'm') + ' align-' + e(own(d, 'align') ?? 'center') + off + '">' + e(idx(d, 'text')) + badge + '</' + tag + '>';
    }

    case 'text':
      return '<div class="oys-block oys-text align-' + e(own(d, 'align') ?? 'center') + off + '">' + formatText(phpStr(idx(d, 'text'))) + badge + '</div>';

    case 'divider':
      return '<div class="oys-block oys-divider style-' + e(own(d, 'style') ?? 'line') + off + '" role="separator"><span></span></div>';

    case 'image': {
      let img = '<img src="' + e(uploadUrlOf(idx(d, 'src'))) + '" alt="' + e(own(d, 'alt') ?? '') + '" loading="lazy">';
      const imgUrl = cleanUrl(phpStr(own(d, 'url') ?? ''));
      if (imgUrl !== '') {
        img = '<a href="' + e(imgUrl) + '" target="_blank" rel="noopener noreferrer" data-b="' + e(id) + '">' + img + '</a>';
      }
      const caption = phpTruthy(own(d, 'caption')) ? '<figcaption>' + e(own(d, 'caption')) + '</figcaption>' : '';
      return '<figure class="oys-block oys-image ratio-' + e(own(d, 'ratio') ?? 'auto') + off + '">' + img + caption + badge + '</figure>';
    }

    case 'gallery': {
      const images = own(d, 'images') ?? [];
      // count() auf etwas anderem als einem Array ist in PHP 8 ein Fehler
      if (!isArr(images)) throw new TypeError('count(): Argument #1 ($value) must be of type Countable|array');
      const list = entries(images);
      let html = '<div class="oys-block oys-gallery ratio-' + e(own(d, 'ratio') ?? 'square') + off + '"' + (phpTruthy(own(d, 'autoplay')) ? ' data-autoplay="1"' : '') + '>';
      html += '<div class="oys-gal-track">';
      for (const [k, img] of list) {
        // $i > 0: Zahl-Schlüssel und numerischer Text als Zahl, anderer Text als Text mit "0" verglichen
        const n = intKey(k);
        const later = n !== null ? n > 0 : isNumeric(k) ? Number(k) > 0 : k > '0';
        html += '<figure class="oys-gal-item"><img src="' + e(uploadUrlOf(idx(img, 'src'))) + '" alt="' + e(own(img, 'caption') ?? '') + '"' + (later ? ' loading="lazy"' : '') + '>'
          + (phpTruthy(own(img, 'caption')) ? '<figcaption>' + e(own(img, 'caption')) + '</figcaption>' : '') + '</figure>';
      }
      html += '</div>';
      if (list.length > 1) {
        html += '<button type="button" class="oys-gal-nav prev" aria-label="Previous image">' + uiIcon('left') + '</button>';
        html += '<button type="button" class="oys-gal-nav next" aria-label="Next image">' + uiIcon('right') + '</button>';
        html += '<div class="oys-gal-dots">';
        for (const [k] of list) {
          const n = intKey(k);
          // $i + 1: Text-Schlüssel ohne Zahl am Anfang sind in PHP 8 ein TypeError
          html += '<button type="button" aria-label="Image ' + phpStr((n ?? phpNumber(k)) + 1) + '"' + (n === 0 ? ' class="on"' : '') + '></button>';
        }
        html += '</div>';
      }
      return html + badge + '</div>';
    }

    case 'embed':
      return renderEmbed(b, ctx);

    case 'countdown':
      return renderCountdown(b, ctx);

    case 'contact':
      return renderContact(b, ctx);
  }
  return '';
}

// Nur die Entities, die e() erzeugt (der Text ist bereits maskiert); ohne „;“ bleibt alles stehen wie in PHP
const fromEscaped = (s: string): string =>
  s.replace(/&(amp|quot|lt|gt|#039);/g, (_m, n: string) => ({ amp: '&', quot: '"', lt: '<', gt: '>', '#039': "'" })[n] as string);

// oys_format_text(): Text mit Zeilenumbrüchen und klickbaren Adressen. Das Muster läuft wie in PHP (ohne /u) auf den
// Bytes des bereits maskierten Textes – dort ist z. B. „https://ä“ (2 Bytes nach //) eine Adresse; \s ist nur
// ASCII-Leerraum. Ein Treffer endet nie mitten in einem Zeichen (Folgebytes sind nie ausgeschlossen).
const LINK_BYTES = /\bhttps?:\/\/[^\t\n\v\f\r <]+[^\t\n\v\f\r <.,;:!?)\]"']/gi;
const toBytes = (s: string): string => Buffer.from(s, 'utf8').toString('latin1');
const fromBytes = (s: string): string => Buffer.from(s, 'latin1').toString('utf8');
export function formatText(text: string): string {
  const html = toBytes(e(text)).replace(LINK_BYTES, (m) => {
    const url = fromEscaped(fromBytes(m));
    return toBytes('<a href="' + e(url) + '" target="_blank" rel="noopener noreferrer nofollow">' + e(prettyUrl(url)) + '</a>');
  });
  return nl2br(fromBytes(html));
}

const PROVIDER_NAMES: Record<string, string> = { youtube: 'YouTube', twitch: 'Twitch', spotify: 'Spotify' };

// oys_render_embed()
function renderEmbed(b: Rec, _ctx: RenderCtx): string {
  const d = b.data ?? null;
  const id = phpStr(b.id ?? null);
  const embed = parseEmbed(phpStr(own(d, 'url') ?? ''));
  const off = phpTruthy(b._off) ? ' is-off' : '';
  if (!embed) {
    return '<div class="oys-block oys-embed is-invalid' + off + '"><div class="oys-embed-load"><span class="oys-embed-title">This address can’t be embedded.</span><span class="oys-embed-note">YouTube, Twitch and Spotify are supported.</span></div></div>';
  }
  const provider = embed.provider;
  const kind = embed.kind;
  const ratio = provider === 'spotify' ? (kind === 'track' || kind === 'episode' ? 'spotify-s' : 'spotify-l') : 'video';
  let label: unknown = own(d, 'title') ?? '';
  if (label === '') {
    label = provider === 'spotify' ? 'Listen on Spotify' : provider === 'twitch' && kind === 'channel' ? 'Watch the livestream' : 'Play video';
  }
  const brand = provider === 'spotify' ? 'spotify' : provider;

  return '<div class="oys-block oys-embed provider-' + e(provider) + ' ratio-' + e(ratio) + off + '" data-src="' + e(embedSrc(embed)) + '" data-provider="' + e(provider) + '" data-b="' + e(id) + '">'
    + '<button type="button" class="oys-embed-load">'
    + '<span class="oys-embed-logo">' + brandSvg(brand) + '</span>'
    + '<span class="oys-embed-play">' + uiIcon('play') + '</span>'
    + '<span class="oys-embed-title">' + e(label) + '</span>'
    + '<span class="oys-embed-note">' + e(PROVIDER_NAMES[provider]) + ' only loads once you tap (privacy).</span>'
    + '</button>'
    + (phpTruthy(b._off) ? OFF_BADGE() : '')
    + '</div>';
}

// oys_render_countdown(): ein Ziel, das PHP nicht lesen kann, ergibt einen leeren Block
function renderCountdown(b: Rec, ctx: RenderCtx): string {
  const d = b.data ?? null;
  let target: number;
  try {
    target = parseLocalDateTime(strArg(idx(d, 'target')), ctx.tz);
  } catch {
    return '';
  }
  const diff = Math.max(0, target - Math.floor(ctx.now));
  const parts: Array<[string, number, string]> = [
    ['d', Math.floor(diff / 86400), 'days'],
    ['h', Math.floor((diff % 86400) / 3600), 'hours'],
    ['m', Math.floor((diff % 3600) / 60), 'min'],
    ['s', diff % 60, 'sec'],
  ];
  const done = diff === 0;
  const off = phpTruthy(b._off) ? ' is-off' : '';

  let html = '<div class="oys-block oys-card oys-countdown' + (done ? ' is-done' : '') + off + '" data-target="' + e(dateAtom(target, ctx.tz)) + '">';
  if (phpTruthy(own(d, 'title'))) {
    html += '<div class="oys-cd-title">' + e(own(d, 'title')) + '</div>';
  }
  html += '<div class="oys-cd-grid"' + (done ? ' hidden' : '') + '>';
  for (const [unit, value, label] of parts) {
    html += '<div class="oys-cd-cell"><span class="oys-cd-num" data-u="' + unit + '">' + String(value).padStart(2, '0') + '</span><span class="oys-cd-label">' + label + '</span></div>';
  }
  html += '</div>';
  html += '<div class="oys-cd-done"' + (done ? '' : ' hidden') + '>' + e(phpTruthy(own(d, 'done_text') ?? '') ? own(d, 'done_text') : 'It’s time!') + '</div>';
  const cdUrl = cleanUrl(phpStr(own(d, 'url') ?? ''));
  if (cdUrl !== '') {
    html += '<a class="oys-cd-link" href="' + e(cdUrl) + '" target="_blank" rel="noopener noreferrer" data-b="' + e(phpStr(b.id ?? null)) + '">' + e(phpTruthy(own(d, 'url_label') ?? '') ? own(d, 'url_label') : 'Learn more') + ' ' + uiIcon('arrow') + '</a>';
  }
  if (phpTruthy(b._off)) {
    html += OFF_BADGE();
  }
  return html + '</div>';
}

// oys_render_contact(): Formular mit Zeitstempel-Token (gegen Spam, siehe oys_contact_check)
function renderContact(b: Rec, ctx: RenderCtx): string {
  const d = b.data ?? null;
  const page = ctx.page;
  const pageId = intval(page.id ?? 0);
  const blockId = phpStr(b.id ?? null);
  const ts = time();
  const token = ts + '.' + hmac(pageId + '|' + blockId + '|' + ts).slice(0, 32);
  const name = phpTrim(phpStr(page.title ?? ''));
  const sent = (ctx.notice ?? null) === 'sent:' + blockId;
  const off = phpTruthy(b._off) ? ' is-off' : '';
  const success = (): unknown => (phpTruthy(own(d, 'success') ?? '') ? own(d, 'success') : 'Thanks! Your message has been sent.');

  let html = '<form class="oys-block oys-card oys-contact' + off + '" id="contact-' + e(blockId) + '" method="post" action="/_/contact" novalidate>';
  html += '<h3 class="oys-contact-title">' + e(phpTruthy(own(d, 'title') ?? '') ? own(d, 'title') : 'Message me') + '</h3>';
  if (phpTruthy(own(d, 'intro'))) {
    html += '<p class="oys-contact-intro">' + nl2br(e(own(d, 'intro'))) + '</p>';
  }
  html += '<input type="hidden" name="b" value="' + e(blockId) + '"><input type="hidden" name="t" value="' + e(token) + '">';
  html += '<div class="oys-hp" aria-hidden="true"><label>Website <input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>';
  html += '<label class="oys-field"><span>Name</span><input type="text" name="name" maxlength="80" required autocomplete="name" placeholder="Your name"></label>';
  html += '<label class="oys-field"><span>Email</span><input type="email" name="email" maxlength="190" required autocomplete="email" placeholder="you@example.com"></label>';
  html += '<label class="oys-field"><span>Message</span><textarea name="message" rows="4" maxlength="2000" required placeholder="Your message…"></textarea></label>';
  html += '<button type="submit" class="oys-contact-send">' + uiIcon('send') + '<span>' + e(phpTruthy(own(d, 'button') ?? '') ? own(d, 'button') : 'Send message') + '</span></button>';
  html += '<p class="oys-contact-status' + (sent ? ' ok' : '') + '" role="status" data-success="' + e(success()) + '">'
    + (sent ? e(success()) : '') + '</p>';
  html += '<p class="oys-contact-note">Your message goes directly to ' + e(name !== '' ? name : 'the page owner') + '. Your details are only used to reply to you.</p>';
  if (phpTruthy(b._off)) {
    html += OFF_BADGE();
  }
  return html + '</form>';
}

// oys_render_simple(): kleine Seite im Design des Profils (Kalender, Passwort-Abfrage ohne JS …)
export function renderSimple(pageIn: object, title: string, bodyHtml: string | SafeHtml): string {
  const page = pageIn as Rec;
  const settings = pageSettings(page);
  const theme = themeKey(page.theme ?? DEFAULT_THEME);
  const classes = ['oys', 't-' + theme, 'l-buttons', 'mode-simple'];
  if (phpTruthy(settings.font)) classes.push('f-' + phpStr(settings.font));
  if (phpTruthy(settings.button)) classes.push('btn-' + phpStr(settings.button));
  const style = phpTruthy(settings.accent) ? ' style="--accent:' + e(settings.accent) + '"' : '';
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>' + e(title) + '</title><meta name="robots" content="noindex"><link rel="icon" type="image/png" href="/static/images/favicon.png">'
    + '<link rel="stylesheet" href="' + e(asset('/static/css/fonts.css')) + '">'
    + '<link rel="stylesheet" href="' + e(asset('/static/css/themes.css')) + '">'
    + '<link rel="stylesheet" href="' + e(asset('/static/css/page.css')) + '">'
    + uiAssets('page')
    + '</head><body class="' + e(classes.join(' ')) + '"' + style + '>'
    + '<div class="oys-bg" aria-hidden="true"><span class="oys-deco oys-deco-1"></span><span class="oys-deco oys-deco-2"></span><span class="oys-deco oys-deco-3"></span></div>'
    + '<main class="oys-main oys-simple">' + String(bodyHtml) + '</main></body></html>';
}
