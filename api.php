<?php
// Öffentliche JSON-API: https://on-your.site/api.php?user=name
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');

require __DIR__ . '/lib/bootstrap.php';
ini_set('display_errors', '0');

$slug = oys_normalize_slug($_GET['user'] ?? '');
if ($slug === '') {
    echo json_encode(['status' => 'error', 'message' => 'No user parameter provided.']);
    exit;
}

try {
    $page = oys_load_page_by_slug($pdo, $slug);
    if (!$page) {
        echo json_encode(['status' => 'error', 'message' => 'User not found.']);
        exit;
    }
    $settings = oys_page_settings($page);
    $theme = oys_theme_key($page['theme']);
    $themeMeta = oys_themes()[$theme];
    $tz = new DateTimeZone(oys_config('timezone', 'Europe/Berlin'));
    $now = new DateTimeImmutable('now', $tz);

    $links = [];
    $socials = [];
    $position = 0;
    foreach (oys_load_blocks($pdo, (int) $page['id']) as $b) {
        if (!$b['is_visible'] || !oys_schedule_active($b['schedule'], $now)) {
            continue;
        }
        $d = $b['data'];
        $url = $b['type'] === 'link' ? oys_clean_url((string) ($d['url'] ?? '')) : '';
        if ($url !== '') {
            $protected = $b['protection'] !== 'none';
            $icon = (string) ($d['icon'] ?? '');
            $explicitBrand = strpos($icon, 'brand:') === 0 ? substr($icon, 6) : null;
            // Geschützte Links verraten ihre Zieladresse nicht – weder als Titel noch über die erkannte Plattform
            $links[] = [
                'id' => $b['id'],
                'title' => ($d['title'] ?? '') ?: ($protected ? 'Geschützter Link' : oys_pretty_url($url)),
                'url' => $protected ? oys_page_origin($page) . '/_/go/' . $b['id'] : $url,
                'icon_class' => strpos($icon, 'bx') === 0 ? $icon : '',
                'platform' => $explicitBrand ?? ($protected ? null : oys_detect_brand($url)),
                'protected' => $protected ? $b['protection'] : false,
                'sort_order' => $position++,
            ];
        }
        if ($b['type'] === 'socials') {
            foreach ($d['items'] ?? [] as $item) {
                $url = oys_social_url($item['p'], (string) $item['v']);
                if ($url !== '') {
                    $socials[] = ['platform' => $item['p'], 'url' => $url];
                }
            }
        }
    }

    $mediaUrl = fn($f) => $f ? oys_main_url(oys_upload_url($f)) : null;

    echo json_encode([
        'status' => 'success',
        'data' => [
            'profile' => [
                'full_name' => $page['title'],
                'username' => $page['slug'],
                'url' => oys_page_url($page),
                'urls' => oys_page_urls($page),
                'bio' => $page['bio'],
                'profession' => $page['subtitle'],
                'hide_branding' => (bool) $settings['hide_branding'],
            ],
            'media' => [
                'profile_image' => $mediaUrl($page['avatar']),
                'background_image' => $mediaUrl($page['bg_image']),
            ],
            'design' => [
                'theme' => $theme,
                'theme_name' => $themeMeta['name'],
                'layout' => oys_layout_key($page['layout']),
                'accent' => $settings['accent'] ?: $themeMeta['accent'],
                'is_dark' => (bool) $themeMeta['dark'],
            ],
            'links' => $links,
            'socials' => $socials,
        ],
    ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
} catch (Throwable $e) {
    error_log('API-Fehler: ' . $e->getMessage());
    echo json_encode(['status' => 'error', 'message' => 'Database error occurred.']);
}
