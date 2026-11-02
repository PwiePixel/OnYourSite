// Öffentliche JSON-Schnittstelle: https://on-your.site/api.php?user=name (api.php, auf jeder Adresse)
import type { Ctx } from '../web/ctx.js';
import { isHalt } from '../web/ctx.js';
import { DbUnavailableError } from '../db.js';
import { phpJson } from '../html.js';
import { cleanUrl, mainUrl, normalizeSlug, pageOrigin, pageUrl, pageUrls, prettyUrl, uploadUrl, type PageLike } from '../helpers.js';
import { intval, phpStr, phpTruthy } from '../php.js';
import { scheduleActive } from '../content/blocks.js';
import { isShownLinkPage, loadBlocks, loadPageBySlug, pageSettings } from '../content/pages.js';
import { pageBranding } from '../content/branding.js';
import { detectBrand, socialUrl } from '../content/social.js';
import { layoutKey, themeKey, themes } from '../content/themes.js';
import { isArr, own, values } from '../content/util.js';

// json_encode() ohne Optionen (Fehlermeldungen)
const plain = (message: string): string => phpJson({ status: 'error', message });

// GET /api.php?user=<name>
export async function api(ctx: Ctx): Promise<void> {
  ctx.header('Content-Type', 'application/json; charset=utf-8');
  ctx.header('Access-Control-Allow-Origin', '*');

  const slug = normalizeSlug(own(ctx.get, 'user') ?? '');
  if (slug === '') ctx.send(plain('No user parameter provided.'));

  try {
    const page = await loadPageBySlug(slug);
    // Zeigt der Platz eine Code-Seite, gibt es seine Link-Seite für Besucher nicht
    if (!page || !isShownLinkPage(page)) ctx.send(plain('User not found.'));
    const pageLike = page as unknown as PageLike;
    const settings = pageSettings(page);
    const theme = themeKey(page.theme);
    const themeMeta = themes()[theme];
    const now = Date.now() / 1000;

    const links: Array<Record<string, unknown>> = [];
    const socials: Array<Record<string, unknown>> = [];
    let position = 0;
    for (const b of await loadBlocks(intval(page.id))) {
      if (!phpTruthy(b.is_visible) || !scheduleActive(b.schedule, now)) continue;
      const d = b.data;
      let url = b.type === 'link' ? cleanUrl(phpStr(own(d, 'url') ?? '')) : '';
      if (url !== '') {
        const isProtected = b.protection !== 'none';
        const icon = phpStr(own(d, 'icon') ?? '');
        const explicitBrand = icon.startsWith('brand:') ? icon.slice(6) : null;
        const title = own(d, 'title') ?? '';
        // Geschützte Links verraten ihre Zieladresse nicht – weder als Titel noch über die erkannte Plattform
        links.push({
          id: b.id,
          title: phpTruthy(title) ? title : (isProtected ? 'Protected link' : prettyUrl(url)),
          url: isProtected ? pageOrigin(pageLike) + '/_/go/' + b.id : url,
          icon_class: icon.startsWith('bx') ? icon : '',
          platform: explicitBrand ?? (isProtected ? null : detectBrand(url)),
          protected: isProtected ? b.protection : false,
          sort_order: position++,
        });
      }
      if (b.type === 'socials') {
        for (const item of values(own(d, 'items') ?? [])) {
          // oys_social_url(string $platform, …): $item['p'] auf einem Text ist ein TypeError, null/Array ebenso
          if (!isArr(item)) throw new TypeError('oys_social_url(): Argument #1 ($platform) must be of type string');
          const platform = own(item, 'p');
          const value = phpStr(own(item, 'v'));
          if (platform === undefined || platform === null || isArr(platform)) {
            throw new TypeError('oys_social_url(): Argument #1 ($platform) must be of type string');
          }
          url = socialUrl(phpStr(platform), value);
          if (url !== '') socials.push({ platform, url });
        }
      }
    }

    const mediaUrl = (f: unknown): string | null => (phpTruthy(f) ? mainUrl(uploadUrl(f)) : null);
    // Wirksamer Wert: ausgeblendet nur mit Premium des Besitzers oder Bestandsschutz
    const brandingHidden = (await pageBranding(page, settings)).footerHidden;
    ctx.send(phpJson({
      status: 'success',
      data: {
        profile: {
          full_name: page.title,
          username: page.slug,
          url: pageUrl(pageLike),
          urls: pageUrls(pageLike),
          bio: page.bio,
          profession: page.subtitle,
          hide_branding: brandingHidden,
        },
        media: {
          profile_image: mediaUrl(page.avatar),
          background_image: mediaUrl(page.bg_image),
        },
        design: {
          theme,
          theme_name: themeMeta.name,
          layout: layoutKey(page.layout),
          accent: phpTruthy(settings.accent) ? settings.accent : themeMeta.accent,
          is_dark: phpTruthy(themeMeta.dark),
        },
        links,
        socials,
      },
    }, { prettyPrint: true, unescapedSlashes: true, unescapedUnicode: true }));
  } catch (err) {
    // exit und eine fehlende Datenbank (503-Seite wie beim Start von PHP) gehen weiter
    if (isHalt(err) || err instanceof DbUnavailableError) throw err;
    console.error('API error: ' + (err instanceof Error ? err.message : String(err)));
    ctx.send(plain('Database error occurred.'));
  }
}
