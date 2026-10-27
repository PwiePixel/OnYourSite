<?php
// Beispielseiten für die Startseite (Handy-Vorschau mit Punkten) und als Vorlage.

function oys_demo_page(string $theme): ?array
{
    if (!array_key_exists($theme, oys_themes())) {
        return null;
    }
    $layouts = [
        'trs' => 'buttons', 'galaxy' => 'cards', 'notebook' => 'timeline', 'comic' => 'tiles',
        'ocean' => 'buttons', 'midnight' => 'cards', 'retro' => 'buttons', 'pixel' => 'columns',
        'newspaper' => 'magazine', 'candy' => 'cloud', 'brutal' => 'bento', 'zen' => 'buttons',
        'glass' => 'apps', 'code' => 'cards', 'cafe' => 'cards', 'neon' => 'buttons', 'luxe' => 'buttons',
    ];
    $rings = ['trs' => 'accent', 'galaxy' => 'rainbow', 'neon' => 'accent', 'retro' => 'accent', 'candy' => 'story'];
    $settings = oys_default_settings();
    $settings['avatar_ring'] = $rings[$theme] ?? 'none';
    $settings['particles'] = $theme === 'midnight' ? 'fireflies' : 'none';

    $page = [
        'id' => 0,
        'slug' => 'mia',
        'title' => 'Mia Sommer',
        'subtitle' => 'Musik & Livestreams',
        'bio' => 'Neue Single am Freitag 🎧 Live auf Twitch – jeden Freitag ab 18 Uhr.',
        'avatar' => '',
        'bg_image' => '',
        'theme' => $theme,
        'layout' => $layouts[$theme] ?? 'buttons',
        'address_mode' => 'subdomain',
        'settings' => json_encode($settings),
    ];

    $tz = new DateTimeZone(oys_config('timezone', 'Europe/Berlin'));
    $release = (new DateTimeImmutable('today', $tz))->modify('+9 days')->setTime(18, 0)->format('Y-m-d\TH:i');

    $i = 0;
    $block = function (string $type, array $data, string $effect = 'none') use (&$i) {
        return ['id' => 'demo' . (++$i), 'type' => $type, 'is_visible' => 1, 'data' => $data, 'schedule' => null, 'protection' => 'none', 'effect' => $effect];
    };
    $blocks = [
        $block('socials', ['style' => 'icons', 'items' => [
            ['p' => 'instagram', 'v' => 'mia'], ['p' => 'tiktok', 'v' => 'mia'], ['p' => 'youtube', 'v' => 'mia'],
            ['p' => 'twitch', 'v' => 'mia'], ['p' => 'discord', 'v' => 'mia'], ['p' => 'spotify', 'v' => 'https://open.spotify.com/artist/0'],
        ]]),
        $block('link', ['title' => 'Jetzt live auf Twitch', 'url' => 'https://twitch.tv/mia', 'subtitle' => 'Freitags 18–23 Uhr', 'icon' => '', 'thumb' => '', 'featured' => false], 'shine'),
        $block('link', ['title' => 'Neue Single hören', 'url' => 'https://open.spotify.com/artist/0', 'subtitle' => 'Spotify', 'icon' => '', 'thumb' => '', 'featured' => false]),
        $block('link', ['title' => 'Merch-Shop', 'url' => 'https://example.com/shop', 'subtitle' => 'Hoodies & Sticker', 'icon' => 'bx bx-shopping-bag', 'thumb' => '', 'featured' => false], 'wobble'),
        $block('link', ['title' => 'Tourdaten 2026', 'url' => 'https://example.com/tour', 'subtitle' => '12 Städte', 'icon' => 'bx bx-calendar', 'thumb' => '', 'featured' => false]),
        $block('countdown', ['title' => 'Neue Single erscheint in', 'target' => $release, 'done_text' => 'Jetzt überall hören!', 'url' => '', 'url_label' => '']),
    ];
    return ['page' => $page, 'blocks' => $blocks];
}

// Kleine statische Vorschau eines Designs (Startseite: Leiste mit allen 25 Designs)
function oys_mini_html(string $theme, string $layout = 'buttons'): string
{
    $links = [['Instagram', 'instagram'], ['Neues Video', 'youtube'], ['Meine Website', 'website']];
    $html = '<div class="oys oys-mini t-' . e($theme) . ' l-' . e($layout) . '">'
        . '<div class="oys-bg"><span class="oys-deco oys-deco-1"></span><span class="oys-deco oys-deco-2"></span><span class="oys-deco oys-deco-3"></span></div>'
        . '<div class="oys-main"><header class="oys-head"><div class="oys-avatar shape-circle ring-none"><div class="oys-avatar-inner"><span class="oys-initials">MS</span></div></div>'
        . '<h1 class="oys-name">Mia Sommer</h1><p class="oys-sub">Musik &amp; Livestreams</p><p class="oys-bio">Neue Single am Freitag 🎧</p></header>'
        . '<section class="oys-blocks"><div class="oys-links lay-' . e($layout) . '">';
    foreach ($links as $i => [$title, $brand]) {
        $html .= '<span class="oys-link" style="--i:' . $i . '"><span class="oys-link-media"><span class="oys-link-icon">' . oys_brand_svg($brand) . '</span></span>'
            . '<span class="oys-link-body"><span class="oys-link-title">' . e($title) . '</span></span><span class="oys-link-end"></span></span>';
    }
    return $html . '</div></section></div></div>';
}
