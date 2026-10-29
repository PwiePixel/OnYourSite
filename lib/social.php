<?php
// Social-Plattformen, Marken-Icons und Symbole.

function oys_brands(): array
{
    static $brands = null;
    if ($brands === null) {
        $brands = require __DIR__ . '/brand_icons.php';
    }
    return $brands;
}

function oys_brand_svg(string $key, string $class = 'oys-ico'): string
{
    $brands = oys_brands();
    if (!isset($brands[$key])) {
        return oys_ui_icon('link', $class);
    }
    return '<svg class="' . e($class) . '" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' . $brands[$key]['svg'] . '</svg>';
}

// Erkennt die Plattform an der Adresse (instagram.com → instagram)
function oys_detect_brand(string $url): ?string
{
    $lower = strtolower($url);
    if (strpos($lower, 'mailto:') === 0) {
        return 'email';
    }
    $host = (string) parse_url($lower, PHP_URL_HOST);
    if ($host === '') {
        return null;
    }
    $host = preg_replace('/^(www|m|mobile|open|music|vm)\./', '', $host);
    foreach (oys_brands() as $key => $brand) {
        foreach ($brand['domains'] as $domain) {
            if ($host === $domain || str_ends_with($host, '.' . $domain)) {
                return $key;
            }
        }
    }
    // Mastodon-Instanzen erkennt man am /@name
    if (preg_match('#^https?://[^/]+/@[a-z0-9_]+$#i', $url) && strpos($host, 'mastodon') !== false) {
        return 'mastodon';
    }
    return null;
}

// Baut aus Benutzername oder Adresse die fertige Profil-URL
function oys_social_url(string $platform, string $value): string
{
    $value = trim($value);
    if ($value === '') {
        return '';
    }
    $brands = oys_brands();
    if (preg_match('#^(https?://|mailto:|tel:)#i', $value)) {
        return oys_clean_url($value);
    }
    if ($platform === 'email') {
        return filter_var($value, FILTER_VALIDATE_EMAIL) ? 'mailto:' . $value : '';
    }
    if ($platform === 'whatsapp') {
        $digits = preg_replace('/[^0-9]/', '', $value);
        if (strpos($digits, '00') === 0) {
            $digits = substr($digits, 2);
        }
        return $digits !== '' ? 'https://wa.me/' . $digits : '';
    }
    if ($platform === 'mastodon' && preg_match('/^@?([a-z0-9_.]+)@([a-z0-9.-]+\.[a-z]{2,})$/i', $value, $m)) {
        return 'https://' . $m[2] . '/@' . $m[1];
    }
    $template = $brands[$platform]['url'] ?? '';
    // Sieht es aus wie eine Domain? Dann als Adresse behandeln.
    if ($template === '' || preg_match('#^[a-z0-9.-]+\.[a-z]{2,}(/|$)#i', $value)) {
        return oys_clean_url($value);
    }
    $handle = ltrim($value, '@');
    $handle = preg_replace('/[^\p{L}\p{N}._\-]/u', '', $handle);
    return $handle === '' ? '' : str_replace('{u}', rawurlencode($handle), $template);
}

// Symbol für einen Link: '' = automatisch, 'brand:instagram', oder Boxicons-Klasse 'bx bx-music'
function oys_icon_html(string $icon, string $url = ''): string
{
    $icon = trim($icon);
    if ($icon === '' || $icon === 'auto') {
        if (stripos($url, 'tel:') === 0) {
            return oys_ui_icon('phone');
        }
        $brand = oys_detect_brand($url);
        return $brand ? oys_brand_svg($brand) : '';
    }
    if (strpos($icon, 'brand:') === 0) {
        return oys_brand_svg(substr($icon, 6));
    }
    if (preg_match('/^bx[sl]? bx[sl]?-[a-z0-9-]+$/', $icon)) {
        return '<i class="oys-ico ' . e($icon) . '" aria-hidden="true"></i>';
    }
    if ($icon === 'none') {
        return '';
    }
    return '';
}

function oys_icon_uses_boxicons(string $icon): bool
{
    return (bool) preg_match('/^bx[sl]? /', trim($icon));
}

// Einfache Linien-Symbole für die Oberfläche der Profilseite
function oys_ui_icon(string $name, string $class = 'oys-ico'): string
{
    static $paths = [
        'arrow'    => '<path d="M5 12h14M13 5l7 7-7 7"/>',
        'external' => '<path d="M14 3h7v7M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
        'lock'     => '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
        'link'     => '<path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5"/>',
        'calendar' => '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
        'download' => '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
        'file'     => '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
        'mail'     => '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/>',
        'phone'    => '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
        'play'     => '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>',
        'volume'   => '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
        'mute'     => '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="m23 9-6 6M17 9l6 6"/>',
        'close'    => '<path d="M18 6 6 18M6 6l12 12"/>',
        'left'     => '<path d="m15 18-6-6 6-6"/>',
        'right'    => '<path d="m9 18 6-6-6-6"/>',
        'send'     => '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
        'check'    => '<path d="M20 6 9 17l-5-5"/>',
        'clock'    => '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
        'eye-off'  => '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24M1 1l22 22"/>',
        'image'    => '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
        'user'     => '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
        'sparkle'  => '<path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z"/>',
        'share'    => '<path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="m16 6-4-4-4 4M12 2v14"/>',
    ];
    $inner = $paths[$name] ?? $paths['link'];
    return '<svg class="' . e($class) . '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' . $inner . '</svg>';
}

// Allgemeine Symbole (Boxicons) für die Symbol-Auswahl im Editor
function oys_bx_icons(): array
{
    return [
        'bx bx-link', 'bx bx-globe', 'bx bx-envelope', 'bx bx-phone', 'bx bx-store', 'bx bx-cart', 'bx bx-shopping-bag', 'bx bx-gift',
        'bx bx-music', 'bx bx-headphone', 'bx bx-microphone', 'bx bx-radio', 'bx bx-video', 'bx bx-camera', 'bx bx-image', 'bx bx-movie-play',
        'bx bx-game', 'bx bx-joystick', 'bx bx-trophy', 'bx bx-crown', 'bx bx-star', 'bx bx-heart', 'bx bx-like', 'bx bx-happy',
        'bx bx-coffee', 'bx bx-restaurant', 'bx bx-cake', 'bx bx-palette', 'bx bx-brush', 'bx bx-pen', 'bx bx-book', 'bx bx-book-open',
        'bx bx-code-alt', 'bx bx-terminal', 'bx bx-chip', 'bx bx-server', 'bx bx-rocket', 'bx bx-bulb', 'bx bx-briefcase', 'bx bx-building',
        'bx bx-calendar', 'bx bx-time', 'bx bx-map', 'bx bx-home', 'bx bx-donate-heart', 'bx bx-dollar-circle', 'bx bx-credit-card', 'bx bx-wallet',
        'bx bx-news', 'bx bx-podcast', 'bx bx-broadcast', 'bx bx-chat', 'bx bx-message-rounded', 'bx bx-group', 'bx bx-user', 'bx bx-id-card',
        'bx bx-download', 'bx bx-file', 'bx bx-paper-plane', 'bx bx-planet', 'bx bx-leaf', 'bx bx-dumbbell', 'bx bx-car', 'bx bx-bone',
    ];
}
