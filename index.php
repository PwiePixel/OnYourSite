<?php
// OnYourSite – zentrale Weiterleitung aller Anfragen
require __DIR__ . '/lib/bootstrap.php';

$host = oys_request_host();
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$baseHost = oys_base_host();

// --- 1. Öffentliche Endpunkte ohne Cookies (auf jeder Adresse gleich) ---
if (strpos($path, '/_/') === 0) {
    require __DIR__ . '/lib/routes_public.php';
    exit;
}

// Alte Klick-Zählung (für noch offene alte Profilseiten)
if ($path === '/track-click' && $method === 'POST') {
    $data = json_decode(file_get_contents('php://input') ?: '', true);
    $legacyId = (int) ($data['link_id'] ?? 0);
    if ($legacyId > 0 && !oys_is_bot($_SERVER['HTTP_USER_AGENT'] ?? '')) {
        $stmt = $pdo->prepare('SELECT id, page_id FROM page_blocks WHERE legacy_link_id = ? LIMIT 1');
        $stmt->execute([$legacyId]);
        if ($row = $stmt->fetch()) {
            oys_record_click($pdo, (int) $row['page_id'], (int) $row['id']);
        }
    }
    oys_json(['status' => 'success']);
}

// Zeigt eine Profilseite (oder deren Termin-Seite)
function oys_serve_page(PDO $pdo, array $page, string $sub): void
{
    header('Referrer-Policy: strict-origin-when-cross-origin');
    header('X-Content-Type-Options: nosniff');
    if ($sub === 'kalender') {
        require __DIR__ . '/views/kalender.php';
        exit;
    }
    $notice = null;
    if (isset($_GET['sent']) && ctype_digit((string) $_GET['sent'])) {
        $notice = 'sent:' . $_GET['sent'];
    }
    echo oys_render_page($page, oys_load_blocks($pdo, (int) $page['id']), [
        'mode' => 'public',
        'host' => oys_request_host(),
        'notice' => $notice,
    ]);
    exit;
}

// --- 2. Hauptdomain: App (Login, Editor …) und Profile im Pfad-Modus ---
if (oys_is_main_host($host)) {
    $appRoutes = ['/', '/login', '/register', '/logout', '/dashboard', '/admin', '/challenge', '/imprint', '/privacy', '/terms'];
    if (in_array($path, $appRoutes, true) || strpos($path, '/dashboard/') === 0) {
        require __DIR__ . '/lib/routes_app.php';
        exit;
    }

    // on-your.site/name  bzw.  on-your.site/name/kalender
    if (preg_match('#^/([a-z0-9-]{1,63})(?:/(kalender))?/?$#', strtolower($path), $m)) {
        $page = oys_load_page_by_slug($pdo, $m[1]);
        if ($page) {
            $sub = $m[2] ?? '';
            if ($page['address_mode'] !== 'path') {
                // Hauptadresse ist name.on-your.site → dorthin weiterleiten
                $qs = isset($_SERVER['QUERY_STRING']) && $_SERVER['QUERY_STRING'] !== '' ? '?' . $_SERVER['QUERY_STRING'] : '';
                oys_redirect(oys_page_url($page, $sub) . $qs, 302);
            }
            oys_serve_page($pdo, $page, $sub);
        }
    }

    http_response_code(404);
    require __DIR__ . '/views/404.php';
    exit;
}

// --- 3. Subdomain: name.on-your.site ---
if (str_ends_with($host, '.' . $baseHost)) {
    $slug = substr($host, 0, -strlen('.' . $baseHost));
    $page = oys_load_page_by_slug($pdo, $slug);
    if ($page) {
        $sub = trim(strtolower($path), '/');
        if ($sub !== '' && $sub !== 'kalender') {
            oys_redirect(oys_page_url($page), 302);
        }
        if ($page['address_mode'] === 'path') {
            // Hauptadresse ist on-your.site/name → dorthin weiterleiten
            $qs = isset($_SERVER['QUERY_STRING']) && $_SERVER['QUERY_STRING'] !== '' ? '?' . $_SERVER['QUERY_STRING'] : '';
            oys_redirect(oys_page_url($page, $sub) . $qs, 302);
        }
        oys_serve_page($pdo, $page, $sub);
    }
}

http_response_code(404);
require __DIR__ . '/views/404.php';
