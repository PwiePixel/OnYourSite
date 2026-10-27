<?php
// Öffentliche Endpunkte unter /_/… – funktionieren auf jeder Adresse (Subdomain oder Pfad)
// und setzen KEINE Cookies.
/** @var PDO $pdo */
/** @var string $path */
/** @var string $method */

header('X-Robots-Tag: noindex');

// Block samt Seite laden (nur sichtbare, gerade aktive Blöcke)
function oys_public_block(PDO $pdo, $id): ?array
{
    if (!ctype_digit((string) $id)) {
        return null;
    }
    $stmt = $pdo->prepare('SELECT * FROM page_blocks WHERE id = ?');
    $stmt->execute([(int) $id]);
    $row = $stmt->fetch();
    if (!$row || !(int) $row['is_visible']) {
        return null;
    }
    $page = oys_load_page($pdo, (int) $row['page_id']);
    if (!$page) {
        return null;
    }
    $block = oys_block_from_row($row);
    $tz = new DateTimeZone(oys_config('timezone', 'Europe/Berlin'));
    $block['active'] = oys_schedule_active($block['schedule'], new DateTimeImmutable('now', $tz));
    return ['block' => $block, 'page' => $page];
}

// Ziel-Adresse eines klickbaren Blocks
function oys_block_target(array $block, array $page): string
{
    $d = $block['data'];
    switch ($block['type']) {
        case 'booking':
            if (oys_booking_is_internal($d, $page)) {
                // Geschützter Termin-Block: Kalender nur mit Schlüssel (sonst ließe sich der Schutz über /kalender umgehen)
                return oys_page_url($page, 'kalender') . ($block['protection'] !== 'none' ? '?k=' . oys_calendar_key($page, $block) : '');
            }
            return oys_clean_url((string) ($d['url'] ?? ''), true);
        case 'file':
            return !empty($d['src']) ? oys_main_url(oys_upload_url($d['src'])) : '';
        default:
            $url = oys_clean_url((string) ($d['url'] ?? ''), true);
            if ($url !== '' && $url[0] === '/') {
                return oys_page_url($page) . $url;
            }
            return $url;
    }
}

function oys_wants_json(): bool
{
    return stripos($_SERVER['HTTP_ACCEPT'] ?? '', 'application/json') !== false;
}

// Zwischenseite für geschützte Links ohne JavaScript
function oys_render_gate(array $page, array $block, string $kind, ?string $error = null): string
{
    $title = ($block['data']['title'] ?? '') ?: 'Link';
    $back = '<a class="oys-back" href="' . e(oys_page_url($page)) . '">' . oys_ui_icon('left') . ' Zurück zu ' . e($page['title'] ?: $page['slug']) . '</a>';
    if ($kind === 'age') {
        $body = '<div class="oys-card">' . $back
            . '<div class="oys-modal-icon" style="margin:0 0 12px">18+</div><h1>Ab 18 Jahren</h1>'
            . '<p>„' . e($title) . '“ ist nur für Erwachsene. Bist du mindestens 18 Jahre alt?</p>'
            . '<form method="post" action="/_/go/' . (int) $block['id'] . '"><input type="hidden" name="age" value="yes">'
            . '<button class="oys-contact-send" type="submit"><span>Ja, ich bin 18 oder älter</span></button></form></div>';
    } else {
        $body = '<form class="oys-card oys-contact" method="post" action="/_/go/' . (int) $block['id'] . '">' . $back
            . '<h1>Geschützter Link</h1><p>„' . e($title) . '“ ist mit einem Passwort geschützt.</p>'
            . ($error ? '<div class="oys-alert err">' . e($error) . '</div>' : '')
            . '<label class="oys-field"><span>Passwort</span><input type="password" name="pw" required autofocus></label>'
            . '<button class="oys-contact-send" type="submit">' . oys_ui_icon('lock') . '<span>Entsperren</span></button></form>';
    }
    return oys_render_simple($page, 'Geschützter Link', $body);
}

// --- Aufruf zählen ---
if ($path === '/_/v' && $method === 'POST') {
    if (!oys_is_bot($_SERVER['HTTP_USER_AGENT'] ?? '') && oys_request_from_own_site()) {
        $pageId = (int) ($_POST['p'] ?? 0);
        if ($pageId > 0 && oys_load_page($pdo, $pageId)) {
            oys_record_view($pdo, $pageId);
        }
    }
    http_response_code(204);
    exit;
}

// --- Klick zählen ---
if ($path === '/_/c' && $method === 'POST') {
    if (!oys_is_bot($_SERVER['HTTP_USER_AGENT'] ?? '') && oys_request_from_own_site()) {
        $found = oys_public_block($pdo, $_POST['b'] ?? '');
        if ($found && $found['block']['protection'] === 'none') {
            $item = '';
            if ($found['block']['type'] === 'socials') {
                $item = (string) ($_POST['s'] ?? '');
                if (!isset(oys_brands()[$item])) {
                    $item = '';
                }
            }
            oys_record_click($pdo, (int) $found['page']['id'], (int) $found['block']['id'], $item);
        }
    }
    http_response_code(204);
    exit;
}

// --- Passwort prüfen (per JavaScript) ---
if ($path === '/_/unlock' && $method === 'POST') {
    $found = oys_public_block($pdo, $_POST['b'] ?? '');
    if (!$found || !$found['block']['active'] || $found['block']['protection'] !== 'password') {
        oys_json(['ok' => false, 'error' => 'Dieser Link ist gerade nicht verfügbar.'], 404);
    }
    $block = $found['block'];
    if (!oys_attempts_allowed($pdo, 'pw:' . $block['id'], 10, 200, 900)) {
        oys_json(['ok' => false, 'error' => 'Zu viele Versuche. Bitte warte ein paar Minuten.'], 429);
    }
    $pw = (string) ($_POST['pw'] ?? '');
    if ($pw === '' || !password_verify($pw, (string) $block['password_hash'])) {
        oys_attempt_failed($pdo, 'pw:' . $block['id'], 900);
        oys_json(['ok' => false, 'error' => 'Das Passwort stimmt nicht.']);
    }
    oys_record_click($pdo, (int) $found['page']['id'], (int) $block['id']);
    oys_json(['ok' => true, 'url' => oys_block_target($block, $found['page'])]);
}

// --- Weiterleitung /_/go/123 (nur geschützte Links: Passwort, Ab-18-Bestätigung, Fallback ohne JS) ---
// Weitergeleitet wird nur nach einem POST – so taugt /_/go nicht als offene Weiterleitung.
if (preg_match('#^/_/go/(\d+)$#', $path, $m)) {
    $found = oys_public_block($pdo, $m[1]);
    if (!$found || !$found['block']['active'] || !oys_block_is_clickable($found['block']['type'])) {
        http_response_code(404);
        require dirname(__DIR__) . '/views/404.php';
        exit;
    }
    $block = $found['block'];
    $page = $found['page'];
    if ($block['protection'] === 'none') {
        oys_redirect(oys_page_url($page));
    }
    if (!oys_on_page_host($page)) {
        oys_redirect(oys_page_origin($page) . '/_/go/' . (int) $block['id']);
    }
    $target = oys_block_target($block, $page);
    if ($target === '') {
        oys_redirect(oys_page_url($page));
    }
    header('Cache-Control: no-store');

    if ($block['protection'] === 'age') {
        if ($method !== 'POST' || ($_POST['age'] ?? '') !== 'yes') {
            echo oys_render_gate($page, $block, 'age');
            exit;
        }
    } else {
        if ($method !== 'POST') {
            echo oys_render_gate($page, $block, 'password');
            exit;
        }
        if (!oys_attempts_allowed($pdo, 'pw:' . $block['id'], 10, 200, 900)) {
            echo oys_render_gate($page, $block, 'password', 'Zu viele Versuche. Bitte warte ein paar Minuten.');
            exit;
        }
        if (!password_verify((string) ($_POST['pw'] ?? ''), (string) $block['password_hash'])) {
            oys_attempt_failed($pdo, 'pw:' . $block['id'], 900);
            echo oys_render_gate($page, $block, 'password', 'Das Passwort stimmt nicht.');
            exit;
        }
    }
    if (!oys_is_bot($_SERVER['HTTP_USER_AGENT'] ?? '')) {
        oys_record_click($pdo, (int) $page['id'], (int) $block['id']);
    }
    oys_redirect($target, 303);
}

// --- Kontaktformular ---
if ($path === '/_/contact' && $method === 'POST') {
    $found = oys_public_block($pdo, $_POST['b'] ?? '');
    $json = oys_wants_json();
    if (!$found || $found['block']['type'] !== 'contact' || !$found['block']['active']) {
        $json ? oys_json(['ok' => false, 'error' => 'Dieses Formular ist nicht mehr verfügbar.'], 404) : oys_redirect(oys_main_url('/'));
    }
    $page = $found['page'];
    $blockId = (string) $found['block']['id'];
    [$ok, $error, $spam] = oys_contact_check($pdo, $page, $blockId, $_POST);
    if ($ok && !$spam) {
        oys_store_message($pdo, $page, $_POST);
    }
    if ($json) {
        oys_json($ok ? ['ok' => true] : ['ok' => false, 'error' => $error]);
    }
    $back = oys_page_url($page) . ($ok ? '?sent=' . $blockId : '') . '#kontakt-' . $blockId;
    oys_redirect($back);
}

// --- Demo-Seiten für die Startseite ---
if (preg_match('#^/_/demo/([a-z0-9-]+)$#', $path, $m)) {
    require_once __DIR__ . '/demo.php';
    $demo = oys_demo_page($m[1]);
    if (!$demo) {
        http_response_code(404);
        exit;
    }
    if (isset($_GET['layout']) && array_key_exists((string) $_GET['layout'], oys_layouts())) {
        $demo['page']['layout'] = (string) $_GET['layout'];
    }
    header('Cache-Control: public, max-age=600');
    echo oys_render_page($demo['page'], $demo['blocks'], ['mode' => 'demo', 'entrance' => 'skip', 'host' => oys_request_host()]);
    exit;
}

// --- Wochenbericht per Web-Cron (nur mit Geheimnis aus config.php) ---
if ($path === '/_/cron/weekly-report') {
    $secret = (string) oys_config('cron_secret', '');
    if ($secret === '' || !hash_equals($secret, (string) ($_GET['key'] ?? ''))) {
        http_response_code(403);
        exit('Verboten');
    }
    header('Content-Type: text/plain; charset=utf-8');
    $result = oys_run_weekly_reports($pdo);
    exit('Wochenberichte gesendet: ' . $result['sent'] . ', fehlgeschlagen: ' . $result['failed']);
}

http_response_code(404);
require dirname(__DIR__) . '/views/404.php';
exit;
