<?php
// Erzeugt die Profilseite. Wird für die öffentliche Seite UND die Editor-Vorschau benutzt,
// damit die Vorschau exakt so aussieht wie die echte Seite.

/**
 * @param array $page   Zeile aus "pages" (oder Entwurf aus dem Editor)
 * @param array $blocks Blöcke wie aus oys_load_blocks()
 * @param array $opts   mode: public|preview|demo, entrance: auto|show|skip, now, host, notice
 */
function oys_render_page(array $page, array $blocks, array $opts = []): string
{
    $mode = $opts['mode'] ?? 'public';
    $isPreview = $mode !== 'public';
    $settings = oys_page_settings($page);
    $theme = oys_theme_key($page['theme'] ?? OYS_DEFAULT_THEME);
    $layout = oys_layout_key($page['layout'] ?? 'buttons');
    $themeMeta = oys_themes()[$theme];
    $tz = new DateTimeZone(oys_config('timezone', 'Europe/Berlin'));
    $now = $opts['now'] ?? new DateTimeImmutable('now', $tz);

    $title = trim((string) ($page['title'] ?? ''));
    $seoTitle = $settings['seo']['title'] ?: ($title !== '' ? $title : $page['slug']) . ' | OnYourSite';
    $description = $settings['seo']['description'] ?: mb_substr(trim(preg_replace('/\s+/u', ' ', (string) ($page['bio'] ?? ''))), 0, 160);
    $canonical = isset($page['slug']) ? oys_page_url($page) : '';
    $avatarUrl = !empty($page['avatar']) ? oys_upload_url($page['avatar']) : '';
    // Vorschaubild für geteilte Links: eigene Karte, sonst das Profilbild
    $ogCard = !$isPreview && !empty($page['id']) && $canonical !== '' && oys_og_supported();
    $ogImage = $ogCard ? oys_og_url($page) : ($avatarUrl ? oys_main_url($avatarUrl) : '');
    $shareTitle = $title !== '' ? $title : (string) ($page['slug'] ?? '');

    // Sichtbare Blöcke bestimmen
    $visible = [];
    $needsBoxicons = false;
    foreach ($blocks as $b) {
        if (empty($b['is_visible'])) {
            continue;
        }
        $active = oys_schedule_active($b['schedule'] ?? null, $now);
        if (!$active && !$isPreview) {
            continue;
        }
        $b['_off'] = !$active;
        if (!oys_block_has_content($b, $isPreview)) {
            continue;
        }
        if ($b['type'] === 'link' && oys_icon_uses_boxicons((string) ($b['data']['icon'] ?? ''))) {
            $needsBoxicons = true;
        }
        $visible[] = $b;
    }

    $ctx = [
        'page' => $page,
        'mode' => $mode,
        'preview' => $isPreview,
        'layout' => $layout,
        'now' => $now,
        'tz' => $tz,
        'notice' => $opts['notice'] ?? null,
    ];

    // Body-Klassen
    $classes = ['oys', 't-' . $theme, 'l-' . $layout, 'mode-' . $mode];
    if ($settings['font']) $classes[] = 'f-' . $settings['font'];
    if ($settings['button']) $classes[] = 'btn-' . $settings['button'];
    if (!empty($page['bg_image'])) $classes[] = 'has-bgimg';

    $entrance = $settings['entrance'];
    // Musik: hochgeladene Datei, sonst Link (MP3 oder YouTube – YouTube lädt erst nach dem Tippen)
    $musicYoutube = !$entrance['music'] ? oys_youtube_music($entrance['music_url']) : null;
    $music = $entrance['music'] ? oys_upload_url($entrance['music']) : ($musicYoutube ? '' : ($entrance['music_url'] ?: ''));
    $showEntrance = $entrance['enabled'] && (($opts['entrance'] ?? ($isPreview ? 'skip' : 'auto')) !== 'skip');
    if ($showEntrance) $classes[] = 'has-entrance';

    $style = [];
    if ($settings['accent']) $style[] = '--accent:' . $settings['accent'];
    if (!empty($page['bg_image'])) $style[] = '--bg-overlay:' . round($settings['bg_overlay'] / 100, 2);

    $config = [
        'page' => isset($page['id']) ? (int) $page['id'] : 0,
        'mode' => $mode,
        'particles' => $settings['particles'],
        'sparks' => (bool) $settings['cursor_sparks'],
        'entrance' => $showEntrance ? $entrance['animation'] : '',
        'music' => $showEntrance ? $music : '',
        'musicYoutube' => $showEntrance ? $musicYoutube : null,
        'dark' => (bool) $themeMeta['dark'],
        'volume' => $entrance['volume'] / 100,
        'loop' => (bool) $entrance['loop'],
        'hosts' => array_values(array_unique(array_filter([$opts['host'] ?? '', oys_base_host()]))),
        'share' => $settings['share_button'] && $canonical !== '' && $mode !== 'demo' ? ['url' => $canonical, 'title' => $shareTitle, 'js' => oys_asset('/static/js/share.js'), 'qr' => oys_asset('/static/vendor/qrcode/qrcode.js')] : null,
    ];

    ob_start();
    ?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title><?= e($seoTitle) ?></title>
<?php if ($description !== ''): ?><meta name="description" content="<?= e($description) ?>"><?php endif; ?>
<?php if ($settings['seo']['keywords'] !== ''): ?><meta name="keywords" content="<?= e($settings['seo']['keywords']) ?>"><?php endif; ?>
<?php if ($isPreview): ?><meta name="robots" content="noindex"><?php elseif ($canonical): ?><link rel="canonical" href="<?= e($canonical) ?>"><?php endif; ?>
<meta property="og:title" content="<?= e($seoTitle) ?>">
<meta property="og:type" content="profile">
<?php if ($canonical): ?><meta property="og:url" content="<?= e($canonical) ?>"><?php endif; ?>
<?php if ($description !== ''): ?><meta property="og:description" content="<?= e($description) ?>"><?php endif; ?>
<?php if ($ogImage !== ''): ?><meta property="og:image" content="<?= e($ogImage) ?>">
<?php if ($ogCard): ?><meta property="og:image:width" content="<?= OYS_OG_WIDTH ?>"><meta property="og:image:height" content="<?= OYS_OG_HEIGHT ?>"><meta property="og:image:alt" content="<?= e($shareTitle) ?> on OnYourSite"><?php endif; ?>
<?php endif; ?>
<meta name="twitter:card" content="<?= $ogCard ? 'summary_large_image' : 'summary' ?>">
<meta name="twitter:title" content="<?= e($seoTitle) ?>">
<?php if ($description !== ''): ?><meta name="twitter:description" content="<?= e($description) ?>"><?php endif; ?>
<?php if ($ogImage !== ''): ?><meta name="twitter:image" content="<?= e($ogImage) ?>"><?php endif; ?>
<meta name="theme-color" content="<?= e($themeMeta['dark'] ? '#0b0b0d' : '#ffffff') ?>">
<link rel="icon" type="image/png" href="/static/images/favicon.png">
<link rel="preload" href="/static/fonts/<?= e($settings['font'] ?: $themeMeta['font']) ?>.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="<?= e(oys_asset('/static/css/fonts.css')) ?>">
<link rel="stylesheet" href="<?= e(oys_asset('/static/css/themes.css')) ?>">
<link rel="stylesheet" href="<?= e(oys_asset('/static/css/page.css')) ?>">
<?php if ($needsBoxicons): ?><link rel="stylesheet" href="<?= e(oys_asset('/static/vendor/boxicons/css/boxicons.min.css')) ?>"><?php endif; ?>
<?php if ($settings['custom_css'] !== ''): ?><style id="oys-custom-css"><?= $settings['custom_css'] ?></style><?php endif; ?>
<noscript><style>.has-entrance .oys-main{opacity:1!important;transform:none!important}.oys-entrance{display:none!important}</style></noscript>
</head>
<body class="<?= e(implode(' ', $classes)) ?>"<?= $style ? ' style="' . e(implode(';', $style)) . '"' : '' ?>>
<div class="oys-bg" aria-hidden="true"><span class="oys-deco oys-deco-1"></span><span class="oys-deco oys-deco-2"></span><span class="oys-deco oys-deco-3"></span></div>
<?php if (!empty($page['bg_image'])): ?><div class="oys-bgimg" aria-hidden="true" style="background-image:url('<?= e(oys_upload_url($page['bg_image'])) ?>')"></div><?php endif; ?>
<main class="oys-main profile-container">
  <header class="oys-head">
    <div class="oys-avatar shape-<?= e($settings['avatar_shape']) ?> ring-<?= e($settings['avatar_ring']) ?>">
      <div class="oys-avatar-inner">
        <?php if ($avatarUrl): ?><img src="<?= e($avatarUrl) ?>" alt="<?= e($title) ?>" width="112" height="112"><?php else: ?><span class="oys-initials"><?= e(oys_initials($title !== '' ? $title : (string) ($page['slug'] ?? ''))) ?></span><?php endif; ?>
      </div>
    </div>
    <?php if ($title !== ''): ?><h1 class="oys-name"><?= e($title) ?></h1><?php endif; ?>
    <?php if (!empty($page['subtitle'])): ?><p class="oys-sub"><?= e($page['subtitle']) ?></p><?php endif; ?>
    <?php if (!empty($page['bio'])): ?><p class="oys-bio"><?= nl2br(e($page['bio'])) ?></p><?php endif; ?>
  </header>

  <section class="oys-blocks links-container">
<?php
    $group = [];
    $flush = function () use (&$group, $ctx) {
        if ($group) {
            echo oys_render_link_group($group, $ctx);
            $group = [];
        }
    };
    foreach ($visible as $b) {
        if (in_array($b['type'], ['link', 'booking', 'file'], true)) {
            $group[] = $b;
            continue;
        }
        $flush();
        echo oys_render_block($b, $ctx);
    }
    $flush();
    if (!$visible && $isPreview) {
        echo '<p class="oys-empty">Add links or blocks in the editor on the left – they’ll show up here right away.</p>';
    }
?>
  </section>

  <?php if (empty($settings['hide_branding'])): ?>
  <footer class="oys-foot"><a href="<?= e(oys_main_url('/')) ?>" target="_blank" rel="noopener">Made with <strong>OnYourSite</strong></a></footer>
  <?php endif; ?>
</main>

<?php if ($showEntrance): ?>
<div class="oys-entrance anim-<?= e($entrance['animation']) ?>" role="button" tabindex="0" aria-label="<?= e($entrance['text']) ?>">
  <div class="oys-entrance-half oys-entrance-left"></div><div class="oys-entrance-half oys-entrance-right"></div>
  <div class="oys-entrance-inner">
    <div class="oys-entrance-avatar"><?php if ($avatarUrl): ?><img src="<?= e($avatarUrl) ?>" alt=""><?php else: ?><span class="oys-initials"><?= e(oys_initials($title !== '' ? $title : (string) ($page['slug'] ?? ''))) ?></span><?php endif; ?></div>
    <?php if ($title !== ''): ?><div class="oys-entrance-name"><?= e($title) ?></div><?php endif; ?>
    <div class="oys-entrance-cta"><?= $music ? oys_ui_icon('volume') : oys_ui_icon('sparkle') ?><span><?= e($entrance['text']) ?></span></div>
  </div>
</div>
<?php endif; ?>
<?php if ($config['share']): $shareLinks = oys_share_links($canonical, $shareTitle); ?>
<button type="button" class="oys-share" aria-label="Share this page" title="Share"><?= oys_ui_icon('share') ?></button>
<template id="oys-share-tpl">
  <h2 id="oys-modal-title">Share this page</h2>
  <div class="oys-share-qr"><span class="oys-share-wait"></span></div>
  <p class="oys-share-url"><?= e(preg_replace('#^https?://#', '', $canonical)) ?></p>
  <button type="button" class="oys-btn" data-share="copy"><?= oys_ui_icon('link') ?><span>Copy link</span></button>
  <div class="oys-share-row">
    <a class="oys-btn ghost" href="<?= e($shareLinks['whatsapp']) ?>" target="_blank" rel="noopener"><?= oys_brand_svg('whatsapp') ?><span>WhatsApp</span></a>
    <a class="oys-btn ghost" href="<?= e($shareLinks['x']) ?>" target="_blank" rel="noopener"><?= oys_brand_svg('x') ?><span>X</span></a>
    <button type="button" class="oys-btn ghost" data-share="discord"><?= oys_brand_svg('discord') ?><span>Discord</span></button>
  </div>
  <button type="button" class="oys-btn ghost" data-share="native" hidden><?= oys_ui_icon('share') ?><span>More options</span></button>
</template>
<?php endif; ?>
<?php if ($music && $showEntrance): ?>
<audio id="oys-audio" src="<?= e($music) ?>" preload="none"<?= $entrance['loop'] ? ' loop' : '' ?>></audio>
<?php elseif ($musicYoutube && $showEntrance): ?>
<div class="oys-yt" aria-hidden="true"><div id="oys-yt"></div></div>
<?php endif; ?>
<?php if (($music || $musicYoutube) && $showEntrance): ?>
<button type="button" class="oys-mute" hidden aria-label="Mute music"><?= oys_ui_icon('volume', 'oys-ico on') ?><?= oys_ui_icon('mute', 'oys-ico off') ?></button>
<?php endif; ?>

<div class="oys-modal" id="oys-modal" hidden>
  <div class="oys-modal-box" role="dialog" aria-modal="true" aria-labelledby="oys-modal-title">
    <button type="button" class="oys-modal-close" aria-label="Close"><?= oys_ui_icon('close') ?></button>
    <div class="oys-modal-body"></div>
  </div>
</div>

<script id="oys-config" type="application/json"><?= json_encode($config, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_UNESCAPED_SLASHES) ?></script>
<script src="<?= e(oys_asset('/static/js/page.js')) ?>" defer></script>
</body>
</html>
<?php
    return (string) ob_get_clean();
}

// Hat ein Block etwas anzuzeigen? (leere Links werden öffentlich nicht gezeigt)
function oys_block_has_content(array $b, bool $preview): bool
{
    $d = $b['data'];
    switch ($b['type']) {
        case 'link':
            $hasUrl = oys_clean_url((string) ($d['url'] ?? ''), true) !== '';
            return $preview ? (($d['title'] ?? '') !== '' || $hasUrl) : $hasUrl;
        case 'socials':
            foreach ($d['items'] ?? [] as $item) {
                if (oys_social_url($item['p'], (string) $item['v']) !== '') return true;
            }
            return false;
        case 'heading':
        case 'text':
            return trim((string) ($d['text'] ?? '')) !== '';
        case 'image':
            return !empty($d['src']);
        case 'gallery':
            return !empty($d['images']);
        case 'embed':
            return !empty($d['url']) && ($preview || oys_parse_embed($d['url']));
        case 'countdown':
            return !empty($d['target']);
        case 'file':
            return !empty($d['src']);
        default:
            return true;
    }
}

// ---------------------------------------------------------------
// Links (werden je nach Anordnung per CSS anders dargestellt)
// ---------------------------------------------------------------

function oys_render_link_group(array $links, array $ctx): string
{
    $html = '<div class="oys-links lay-' . e($ctx['layout']) . '" data-count="' . count($links) . '">';
    foreach ($links as $i => $b) {
        $html .= oys_render_link($b, $ctx, $i);
    }
    return $html . '</div>';
}

function oys_render_link(array $b, array $ctx, int $index): string
{
    $d = $b['data'];
    $page = $ctx['page'];
    $type = $b['type'];
    $id = (string) $b['id'];
    $attrs = [];
    $download = false;
    $protection = $b['protection'] ?? 'none';

    if ($type === 'booking') {
        $title = ($d['title'] ?? '') ?: 'Book a meeting';
        $url = ($d['url'] ?? '/kalender') === '/kalender' || ($d['url'] ?? '') === ''
            ? (isset($page['slug']) ? oys_page_url($page, 'kalender') : '#')
            : oys_clean_url((string) $d['url'], true);
        $icon = oys_ui_icon('calendar');
        $sub = 'Request a meeting';
    } elseif ($type === 'file') {
        $title = ($d['title'] ?? '') ?: 'Download file';
        $url = oys_upload_url($d['src'] ?? '');
        $ext = strtolower(pathinfo((string) ($d['src'] ?? ''), PATHINFO_EXTENSION));
        $icon = oys_ui_icon($ext === 'vcf' ? 'user' : 'download');
        $sub = strtoupper($ext) . ' file';
        $download = true;
    } else {
        $url = oys_clean_url((string) ($d['url'] ?? ''), true);
        $title = (string) ($d['title'] ?? '');
        if ($title === '') {
            $title = $url !== '' ? oys_pretty_url($url) : 'New link';
        }
        // Bei geschützten Links kein aus der Zieladresse erkanntes Symbol (verriete z. B. „Discord“)
        $icon = oys_icon_html((string) ($d['icon'] ?? ''), $protection === 'none' ? $url : '');
        $sub = ($d['subtitle'] ?? '') !== '' ? $d['subtitle'] : ($url !== '' ? oys_pretty_url($url) : '');
    }

    $classes = ['oys-link', 'type-' . $type];
    if (($b['effect'] ?? 'none') !== 'none') $classes[] = 'fx-' . $b['effect'];
    if (!empty($d['featured'])) $classes[] = 'is-featured';
    if (!empty($d['thumb'])) $classes[] = 'has-thumb';
    if (!$icon) $classes[] = 'no-icon';
    if (!empty($b['_off'])) $classes[] = 'is-off';
    if ($url === '') $classes[] = 'is-empty';

    if ($protection !== 'none') {
        // Die Zieladresse darf bei geschützten Links nirgends im HTML auftauchen
        $sub = ($d['subtitle'] ?? '') !== '' ? $d['subtitle'] : ($protection === 'age' ? '18+ only' : 'Password protected');
        if ($title === oys_pretty_url($url)) {
            $title = 'Protected link';
        }
        $classes[] = 'is-protected';
        $attrs['data-protect'] = $protection;
        $href = '/_/go/' . (int) $id;
    } else {
        $href = $url !== '' ? $url : '#';
    }

    $attrs['class'] = implode(' ', $classes);
    $attrs['href'] = $href;
    $attrs['data-b'] = $id;
    $attrs['style'] = '--i:' . $index;
    if ($download) {
        $attrs['download'] = '';
    } elseif (!preg_match('#^(mailto|tel):#i', $href) && $href !== '#') {
        $attrs['target'] = '_blank';
        $attrs['rel'] = 'noopener noreferrer';
    }

    $end = oys_ui_icon('arrow');
    if ($protection === 'password') $end = oys_ui_icon('lock');
    if ($protection === 'age') $end = '<span class="oys-badge18">18+</span>';

    $html = '<a';
    foreach ($attrs as $k => $v) {
        $html .= ' ' . $k . ($v === '' && $k === 'download' ? '' : '="' . e($v) . '"');
    }
    $html .= '>';
    $html .= '<span class="oys-link-media">';
    if (!empty($d['thumb'])) {
        $html .= '<img class="oys-link-thumb" src="' . e(oys_upload_url($d['thumb'])) . '" alt="" loading="lazy">';
    }
    $html .= '<span class="oys-link-icon">' . ($icon ?: oys_ui_icon('link')) . '</span></span>';
    $html .= '<span class="oys-link-body"><span class="oys-link-title">' . e($title) . '</span>';
    if ($sub !== '') {
        $html .= '<span class="oys-link-sub">' . e($sub) . '</span>';
    }
    $html .= '</span><span class="oys-link-end">' . $end . '</span>';
    if (!empty($b['_off'])) {
        $html .= '<span class="oys-off-badge">' . oys_ui_icon('clock') . ' Hidden right now</span>';
    }
    return $html . '</a>';
}

// ---------------------------------------------------------------
// Übrige Blöcke
// ---------------------------------------------------------------

function oys_render_block(array $b, array $ctx): string
{
    $d = $b['data'];
    $id = (string) $b['id'];
    $off = !empty($b['_off']) ? ' is-off' : '';
    $badge = !empty($b['_off']) ? '<span class="oys-off-badge">' . oys_ui_icon('clock') . ' Hidden right now</span>' : '';

    switch ($b['type']) {
        case 'socials':
            $style = $d['style'] ?? 'icons';
            $html = '<div class="oys-block oys-socials style-' . e($style) . $off . '" data-b="' . e($id) . '">';
            $brands = oys_brands();
            foreach ($d['items'] ?? [] as $item) {
                $url = oys_social_url($item['p'], (string) $item['v']);
                if ($url === '') continue;
                $brand = $brands[$item['p']];
                $target = strpos($url, 'mailto:') === 0 ? '' : ' target="_blank" rel="noopener noreferrer me"';
                $html .= '<a class="oys-social" href="' . e($url) . '"' . $target . ' data-b="' . e($id) . '" data-s="' . e($item['p']) . '" aria-label="' . e($brand['name']) . '" title="' . e($brand['name']) . '" style="--brand:' . e($brand['color']) . '">'
                    . oys_brand_svg($item['p'])
                    . ($style === 'pills' ? '<span>' . e($brand['name']) . '</span>' : '')
                    . '</a>';
            }
            return $html . $badge . '</div>';

        case 'heading':
            $tag = ($d['size'] ?? 'm') === 'l' ? 'h2' : 'h3';
            return '<' . $tag . ' class="oys-block oys-heading size-' . e($d['size'] ?? 'm') . ' align-' . e($d['align'] ?? 'center') . $off . '">' . e($d['text']) . $badge . '</' . $tag . '>';

        case 'text':
            return '<div class="oys-block oys-text align-' . e($d['align'] ?? 'center') . $off . '">' . oys_format_text((string) $d['text']) . $badge . '</div>';

        case 'divider':
            return '<div class="oys-block oys-divider style-' . e($d['style'] ?? 'line') . $off . '" role="separator"><span></span></div>';

        case 'image':
            $img = '<img src="' . e(oys_upload_url($d['src'])) . '" alt="' . e($d['alt'] ?? '') . '" loading="lazy">';
            $imgUrl = oys_clean_url((string) ($d['url'] ?? ''));
            if ($imgUrl !== '') {
                $img = '<a href="' . e($imgUrl) . '" target="_blank" rel="noopener noreferrer" data-b="' . e($id) . '">' . $img . '</a>';
            }
            $caption = !empty($d['caption']) ? '<figcaption>' . e($d['caption']) . '</figcaption>' : '';
            return '<figure class="oys-block oys-image ratio-' . e($d['ratio'] ?? 'auto') . $off . '">' . $img . $caption . $badge . '</figure>';

        case 'gallery':
            $images = $d['images'] ?? [];
            $html = '<div class="oys-block oys-gallery ratio-' . e($d['ratio'] ?? 'square') . $off . '"' . (!empty($d['autoplay']) ? ' data-autoplay="1"' : '') . '>';
            $html .= '<div class="oys-gal-track">';
            foreach ($images as $i => $img) {
                $html .= '<figure class="oys-gal-item"><img src="' . e(oys_upload_url($img['src'])) . '" alt="' . e($img['caption'] ?? '') . '"' . ($i > 0 ? ' loading="lazy"' : '') . '>'
                    . (!empty($img['caption']) ? '<figcaption>' . e($img['caption']) . '</figcaption>' : '') . '</figure>';
            }
            $html .= '</div>';
            if (count($images) > 1) {
                $html .= '<button type="button" class="oys-gal-nav prev" aria-label="Previous image">' . oys_ui_icon('left') . '</button>';
                $html .= '<button type="button" class="oys-gal-nav next" aria-label="Next image">' . oys_ui_icon('right') . '</button>';
                $html .= '<div class="oys-gal-dots">';
                foreach ($images as $i => $img) {
                    $html .= '<button type="button" aria-label="Image ' . ($i + 1) . '"' . ($i === 0 ? ' class="on"' : '') . '></button>';
                }
                $html .= '</div>';
            }
            return $html . $badge . '</div>';

        case 'embed':
            return oys_render_embed($b, $ctx);

        case 'countdown':
            return oys_render_countdown($b, $ctx);

        case 'contact':
            return oys_render_contact($b, $ctx);
    }
    return '';
}

// Text mit Zeilenumbrüchen und klickbaren Adressen
function oys_format_text(string $text): string
{
    $html = e($text);
    $html = preg_replace_callback('#\bhttps?://[^\s<]+[^\s<.,;:!?)\]"\']#i', function ($m) {
        $url = html_entity_decode($m[0], ENT_QUOTES, 'UTF-8');
        return '<a href="' . e($url) . '" target="_blank" rel="noopener noreferrer nofollow">' . e(oys_pretty_url($url)) . '</a>';
    }, $html);
    return nl2br((string) $html);
}

function oys_render_embed(array $b, array $ctx): string
{
    $d = $b['data'];
    $id = (string) $b['id'];
    $embed = oys_parse_embed((string) ($d['url'] ?? ''));
    $off = !empty($b['_off']) ? ' is-off' : '';
    if (!$embed) {
        return '<div class="oys-block oys-embed is-invalid' . $off . '"><div class="oys-embed-load"><span class="oys-embed-title">This address can’t be embedded.</span><span class="oys-embed-note">YouTube, Twitch and Spotify are supported.</span></div></div>';
    }
    $names = ['youtube' => 'YouTube', 'twitch' => 'Twitch', 'spotify' => 'Spotify'];
    $provider = $embed['provider'];
    $kind = $embed['kind'];
    $ratio = $provider === 'spotify' ? (in_array($kind, ['track', 'episode'], true) ? 'spotify-s' : 'spotify-l') : 'video';
    $label = $d['title'] ?? '';
    if ($label === '') {
        $label = $provider === 'spotify' ? 'Listen on Spotify' : ($provider === 'twitch' && $kind === 'channel' ? 'Watch the livestream' : 'Play video');
    }
    $brand = $provider === 'spotify' ? 'spotify' : $provider;

    return '<div class="oys-block oys-embed provider-' . e($provider) . ' ratio-' . e($ratio) . $off . '" data-src="' . e(oys_embed_src($embed)) . '" data-provider="' . e($provider) . '" data-b="' . e($id) . '">'
        . '<button type="button" class="oys-embed-load">'
        . '<span class="oys-embed-logo">' . oys_brand_svg($brand) . '</span>'
        . '<span class="oys-embed-play">' . oys_ui_icon('play') . '</span>'
        . '<span class="oys-embed-title">' . e($label) . '</span>'
        . '<span class="oys-embed-note">' . e($names[$provider]) . ' only loads once you tap (privacy).</span>'
        . '</button>'
        . (!empty($b['_off']) ? '<span class="oys-off-badge">' . oys_ui_icon('clock') . ' Hidden right now</span>' : '')
        . '</div>';
}

function oys_render_countdown(array $b, array $ctx): string
{
    $d = $b['data'];
    try {
        $target = new DateTimeImmutable($d['target'], $ctx['tz']);
    } catch (Throwable $e) {
        return '';
    }
    $diff = max(0, $target->getTimestamp() - $ctx['now']->getTimestamp());
    $parts = [
        'd' => intdiv($diff, 86400),
        'h' => intdiv($diff % 86400, 3600),
        'm' => intdiv($diff % 3600, 60),
        's' => $diff % 60,
    ];
    $labels = ['d' => 'days', 'h' => 'hours', 'm' => 'min', 's' => 'sec'];
    $done = $diff === 0;
    $off = !empty($b['_off']) ? ' is-off' : '';

    $html = '<div class="oys-block oys-card oys-countdown' . ($done ? ' is-done' : '') . $off . '" data-target="' . e($target->format(DATE_ATOM)) . '">';
    if (!empty($d['title'])) {
        $html .= '<div class="oys-cd-title">' . e($d['title']) . '</div>';
    }
    $html .= '<div class="oys-cd-grid"' . ($done ? ' hidden' : '') . '>';
    foreach ($parts as $unit => $value) {
        $html .= '<div class="oys-cd-cell"><span class="oys-cd-num" data-u="' . $unit . '">' . str_pad((string) $value, 2, '0', STR_PAD_LEFT) . '</span><span class="oys-cd-label">' . $labels[$unit] . '</span></div>';
    }
    $html .= '</div>';
    $html .= '<div class="oys-cd-done"' . ($done ? '' : ' hidden') . '>' . e(($d['done_text'] ?? '') ?: 'It’s time!') . '</div>';
    $cdUrl = oys_clean_url((string) ($d['url'] ?? ''));
    if ($cdUrl !== '') {
        $html .= '<a class="oys-cd-link" href="' . e($cdUrl) . '" target="_blank" rel="noopener noreferrer" data-b="' . e((string) $b['id']) . '">' . e(($d['url_label'] ?? '') ?: 'Learn more') . ' ' . oys_ui_icon('arrow') . '</a>';
    }
    if (!empty($b['_off'])) {
        $html .= '<span class="oys-off-badge">' . oys_ui_icon('clock') . ' Hidden right now</span>';
    }
    return $html . '</div>';
}

function oys_render_contact(array $b, array $ctx): string
{
    $d = $b['data'];
    $page = $ctx['page'];
    $pageId = (int) ($page['id'] ?? 0);
    $blockId = (string) $b['id'];
    $ts = time();
    $token = $ts . '.' . substr(oys_hmac($pageId . '|' . $blockId . '|' . $ts), 0, 32);
    $name = trim((string) ($page['title'] ?? ''));
    $sent = ($ctx['notice'] ?? null) === 'sent:' . $blockId;
    $off = !empty($b['_off']) ? ' is-off' : '';

    $html = '<form class="oys-block oys-card oys-contact' . $off . '" id="contact-' . e($blockId) . '" method="post" action="/_/contact" novalidate>';
    $html .= '<h3 class="oys-contact-title">' . e(($d['title'] ?? '') ?: 'Message me') . '</h3>';
    if (!empty($d['intro'])) {
        $html .= '<p class="oys-contact-intro">' . nl2br(e($d['intro'])) . '</p>';
    }
    $html .= '<input type="hidden" name="b" value="' . e($blockId) . '"><input type="hidden" name="t" value="' . e($token) . '">';
    $html .= '<div class="oys-hp" aria-hidden="true"><label>Website <input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>';
    $html .= '<label class="oys-field"><span>Name</span><input type="text" name="name" maxlength="80" required autocomplete="name" placeholder="Your name"></label>';
    $html .= '<label class="oys-field"><span>Email</span><input type="email" name="email" maxlength="190" required autocomplete="email" placeholder="you@example.com"></label>';
    $html .= '<label class="oys-field"><span>Message</span><textarea name="message" rows="4" maxlength="2000" required placeholder="Your message…"></textarea></label>';
    $html .= '<button type="submit" class="oys-contact-send">' . oys_ui_icon('send') . '<span>' . e(($d['button'] ?? '') ?: 'Send message') . '</span></button>';
    $html .= '<p class="oys-contact-status' . ($sent ? ' ok' : '') . '" role="status" data-success="' . e(($d['success'] ?? '') ?: 'Thanks! Your message has been sent.') . '">'
        . ($sent ? e(($d['success'] ?? '') ?: 'Thanks! Your message has been sent.') : '') . '</p>';
    $html .= '<p class="oys-contact-note">Your message goes directly to ' . e($name !== '' ? $name : 'the page owner') . '. Your details are only used to reply to you.</p>';
    if (!empty($b['_off'])) {
        $html .= '<span class="oys-off-badge">' . oys_ui_icon('clock') . ' Hidden right now</span>';
    }
    return $html . '</form>';
}

// Kleine Seite im Design des Profils (Kalender, Passwort-Abfrage ohne JS …)
function oys_render_simple(array $page, string $title, string $bodyHtml): string
{
    $settings = oys_page_settings($page);
    $theme = oys_theme_key($page['theme'] ?? OYS_DEFAULT_THEME);
    $classes = ['oys', 't-' . $theme, 'l-buttons', 'mode-simple'];
    if ($settings['font']) $classes[] = 'f-' . $settings['font'];
    if ($settings['button']) $classes[] = 'btn-' . $settings['button'];
    $style = $settings['accent'] ? ' style="--accent:' . e($settings['accent']) . '"' : '';
    return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
        . '<title>' . e($title) . '</title><meta name="robots" content="noindex"><link rel="icon" type="image/png" href="/static/images/favicon.png">'
        . '<link rel="stylesheet" href="' . e(oys_asset('/static/css/fonts.css')) . '">'
        . '<link rel="stylesheet" href="' . e(oys_asset('/static/css/themes.css')) . '">'
        . '<link rel="stylesheet" href="' . e(oys_asset('/static/css/page.css')) . '">'
        . '</head><body class="' . e(implode(' ', $classes)) . '"' . $style . '>'
        . '<div class="oys-bg" aria-hidden="true"><span class="oys-deco oys-deco-1"></span><span class="oys-deco oys-deco-2"></span><span class="oys-deco oys-deco-3"></span></div>'
        . '<main class="oys-main oys-simple">' . $bodyHtml . '</main></body></html>';
}
