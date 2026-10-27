<?php
// Routen der Hauptdomain: Startseite, Login, Registrierung, Editor (Dashboard), Admin.
/** @var PDO $pdo */
/** @var string $path */
/** @var string $method */

// Session nur, wenn nötig: Die Startseite setzt für Besucher kein Cookie.
if ($path !== '/' || isset($_COOKIE[session_name()])) {
    oys_start_session();
}

function oys_current_user(PDO $pdo): ?array
{
    if (empty($_SESSION['user_id'])) {
        return null;
    }
    $stmt = $pdo->prepare('SELECT * FROM users WHERE id = ?');
    $stmt->execute([(int) $_SESSION['user_id']]);
    return $stmt->fetch() ?: null;
}

function oys_has_premium(array $user): bool
{
    return !empty($user['is_admin']) || isset($_SESSION['original_admin_id']);
}

function oys_flash(string $type, string $message): void
{
    $_SESSION[$type] = $message;
}

// Aktuelle Seite des Nutzers (aus ?page=, Session oder die erste)
function oys_current_page(PDO $pdo, array $user, $requested = null): ?array
{
    $pages = oys_user_pages($pdo, (int) $user['id']);
    if (!$pages) {
        return null;
    }
    foreach ([$requested, $_SESSION['page_id'] ?? null] as $want) {
        if ($want === null || $want === '') continue;
        foreach ($pages as $p) {
            if ((int) $p['id'] === (int) $want) {
                $_SESSION['page_id'] = (int) $p['id'];
                return $p;
            }
        }
    }
    $_SESSION['page_id'] = (int) $pages[0]['id'];
    return $pages[0];
}

// ---------------------------------------------------------------
// Statische Seiten
// ---------------------------------------------------------------
$static = ['/challenge' => 'challenge', '/imprint' => 'imprint', '/privacy' => 'privacy', '/terms' => 'terms'];
if (isset($static[$path])) {
    require dirname(__DIR__) . '/views/' . $static[$path] . '.php';
    exit;
}

if ($path === '/') {
    $user_data = session_status() === PHP_SESSION_ACTIVE ? oys_current_user($pdo) : null;
    require dirname(__DIR__) . '/views/landingpage.php';
    exit;
}

if ($path === '/logout') {
    $_SESSION = [];
    session_destroy();
    oys_redirect('/');
}

// ---------------------------------------------------------------
// Registrierung
// ---------------------------------------------------------------
if ($path === '/register') {
    if ($method === 'POST') {
        $fullname = oys_clean_text($_POST['fullname'] ?? '', 120);
        $email = strtolower(trim((string) ($_POST['email'] ?? '')));
        $password = (string) ($_POST['password'] ?? '');
        $slug = oys_normalize_slug($_POST['subdomain'] ?? '');
        $_SESSION['old'] = ['fullname' => $fullname, 'email' => $email, 'subdomain' => $slug];

        if (!oys_csrf_check($_POST['csrf'] ?? null)) {
            oys_flash('error', 'Die Sitzung ist abgelaufen. Bitte versuche es erneut.');
        } elseif ($fullname === '' || $email === '' || $password === '' || $slug === '') {
            oys_flash('error', 'Bitte fülle alle Felder aus.');
        } elseif (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            oys_flash('error', 'Bitte gib eine gültige E-Mail-Adresse an.');
        } elseif (strlen($password) < 8) {
            oys_flash('error', 'Dein Passwort muss mindestens 8 Zeichen lang sein.');
        } elseif ($problem = oys_slug_problem($pdo, $slug)) {
            oys_flash('error', $problem);
        } else {
            $check = $pdo->prepare('SELECT id FROM users WHERE email = ? OR username = ? LIMIT 1');
            $check->execute([$email, $slug]);
            if ($check->fetch()) {
                oys_flash('error', 'Diese E-Mail-Adresse oder Adresse ist schon registriert.');
            } else {
                try {
                    $pdo->prepare("INSERT INTO users (email, password, full_name, username, layout_type, last_ip, theme) VALUES (?, ?, ?, ?, 'link-tree', ?, 'trs')")
                        ->execute([$email, password_hash($password, PASSWORD_DEFAULT), $fullname, $slug, encryptData($_SERVER['REMOTE_ADDR'] ?? '')]);
                    $userId = (int) $pdo->lastInsertId();
                    $pageId = oys_create_page($pdo, $userId, $slug, $fullname);
                    session_regenerate_id(true);
                    $_SESSION['user_id'] = $userId;
                    $_SESSION['page_id'] = $pageId;
                    unset($_SESSION['old']);
                    oys_flash('success', 'Willkommen! Deine Seite ist live.');
                    sendCustomEmail($email, 'register', ['full_name' => e($fullname), 'subdomain' => e($slug)]);
                    oys_redirect('/dashboard');
                } catch (PDOException $e) {
                    error_log('Registrierung fehlgeschlagen: ' . $e->getMessage());
                    oys_flash('error', 'Diese E-Mail-Adresse ist schon registriert.');
                }
            }
        }
        oys_redirect('/register');
    }
    require dirname(__DIR__) . '/views/register.php';
    exit;
}

// ---------------------------------------------------------------
// Login
// ---------------------------------------------------------------
if ($path === '/login') {
    if ($method === 'POST') {
        $email = strtolower(trim((string) ($_POST['email'] ?? '')));
        $password = (string) ($_POST['password'] ?? '');
        if (!oys_csrf_check($_POST['csrf'] ?? null)) {
            oys_flash('error', 'Die Sitzung ist abgelaufen. Bitte versuche es erneut.');
        } elseif (!oys_rate_limit($pdo, 'login:' . substr(hash('sha256', $email), 0, 40), 10, 900)) {
            oys_flash('error', 'Zu viele Versuche. Bitte warte 15 Minuten.');
        } else {
            $stmt = $pdo->prepare('SELECT * FROM users WHERE email = ?');
            $stmt->execute([$email]);
            $user = $stmt->fetch();
            if ($user && password_verify($password, $user['password'])) {
                session_regenerate_id(true);
                $_SESSION['user_id'] = (int) $user['id'];
                $pdo->prepare('UPDATE users SET last_ip = ? WHERE id = ?')->execute([encryptData($_SERVER['REMOTE_ADDR'] ?? ''), $user['id']]);
                oys_redirect('/dashboard');
            }
            oys_flash('error', 'E-Mail oder Passwort ist falsch.');
        }
        oys_redirect('/login');
    }
    require dirname(__DIR__) . '/views/login.php';
    exit;
}

// ---------------------------------------------------------------
// Ab hier nur mit Login
// ---------------------------------------------------------------
$user = oys_current_user($pdo);
if (!$user) {
    if (strpos($path, '/dashboard/api/') === 0) {
        oys_json(['ok' => false, 'error' => 'Bitte melde dich erneut an.'], 401);
    }
    oys_redirect('/login');
}
$userId = (int) $user['id'];
$premium = oys_has_premium($user);

// ---------------------------------------------------------------
// Admin
// ---------------------------------------------------------------
if ($path === '/admin') {
    if (empty($user['is_admin'])) {
        oys_redirect('/dashboard');
    }
    $user_data = $user;
    require dirname(__DIR__) . '/views/admin.php';
    exit;
}

// ---------------------------------------------------------------
// Editor-API (JSON)
// ---------------------------------------------------------------
if (strpos($path, '/dashboard/api/') === 0) {
    $action = substr($path, strlen('/dashboard/api/'));
    $isPost = $method === 'POST';
    if ($isPost && !oys_csrf_check(oys_csrf_from_request())) {
        oys_json(['ok' => false, 'error' => 'Sitzung abgelaufen – bitte lade die Seite neu.'], 419);
    }
    $isJsonBody = stripos($_SERVER['CONTENT_TYPE'] ?? '', 'application/json') !== false;
    $input = $isPost && $isJsonBody ? oys_json_input() : [];
    $requestedPage = $input['page']['id'] ?? ($input['page_id'] ?? ($_POST['page_id'] ?? ($_GET['page'] ?? null)));
    $page = oys_current_page($pdo, $user, $requestedPage);

    // Seite anlegen geht auch ohne bestehende Seite
    if ($action === 'page-create' && $isPost) {
        $count = count(oys_user_pages($pdo, $userId));
        $max = (int) oys_config('max_pages', 3);
        if ($count >= $max && !$premium) {
            oys_json(['ok' => false, 'error' => "Du kannst höchstens $max Seiten anlegen."]);
        }
        $slug = oys_normalize_slug($input['slug'] ?? '');
        if ($problem = oys_slug_problem($pdo, $slug)) {
            oys_json(['ok' => false, 'error' => $problem]);
        }
        $title = oys_clean_text($input['title'] ?? '', 120) ?: ($user['full_name'] ?? '');
        $newId = oys_create_page($pdo, $userId, $slug, $title);
        $_SESSION['page_id'] = $newId;
        if ($count === 0) {
            oys_sync_username($pdo, $userId);
        }
        oys_json(['ok' => true, 'id' => $newId]);
    }

    if (!$page) {
        oys_json(['ok' => false, 'error' => 'Lege zuerst eine Seite an.'], 404);
    }

    switch ($action) {
        case 'preview':
            if (!$isPost) break;
            $p = is_array($input['page'] ?? null) ? $input['page'] : [];
            $draft = $page;
            $draft['title'] = oys_clean_text($p['title'] ?? '', 120);
            $draft['subtitle'] = oys_clean_text($p['subtitle'] ?? '', 160);
            $draft['bio'] = oys_clean_text($p['bio'] ?? '', 1000, true);
            $draft['avatar'] = oys_valid_upload($p['avatar'] ?? '', $userId, OYS_IMAGE_EXTS);
            $draft['bg_image'] = oys_valid_upload($p['bg_image'] ?? '', $userId, OYS_IMAGE_EXTS);
            $draft['theme'] = oys_theme_key($p['theme'] ?? $page['theme']);
            $draft['layout'] = oys_layout_key($p['layout'] ?? $page['layout']);
            $draft['settings'] = json_encode(oys_settings_normalize($p['settings'] ?? [], $userId, $premium, oys_page_settings($page)));
            $blocks = [];
            foreach (array_slice(is_array($input['blocks'] ?? null) ? $input['blocks'] : [], 0, 150) as $i => $b) {
                if (!is_array($b)) continue;
                $norm = oys_block_normalize($b, $userId, null, true);
                if (!$norm) continue;
                $id = $b['id'] ?? ('n' . $i);
                $blocks[] = [
                    'id' => preg_match('/^[a-z0-9]+$/i', (string) $id) ? (string) $id : 'n' . $i,
                    'type' => $norm['type'],
                    'is_visible' => $norm['is_visible'],
                    'data' => $norm['data'],
                    'schedule' => $norm['schedule'],
                    'protection' => $norm['protection'],
                    'effect' => $norm['effect'],
                ];
            }
            header('Content-Type: text/html; charset=utf-8');
            header('Cache-Control: no-store');
            echo oys_render_page($draft, $blocks, [
                'mode' => 'preview',
                'entrance' => ($input['entrance'] ?? '') === 'show' ? 'show' : 'skip',
                'host' => oys_request_host(),
            ]);
            exit;

        case 'save':
            if (!$isPost) break;
            try {
                $result = oys_save_page($pdo, $page, $input, $userId, $premium);
            } catch (Throwable $e) {
                error_log('Speichern fehlgeschlagen: ' . $e->getMessage());
                oys_json(['ok' => false, 'error' => 'Speichern fehlgeschlagen. Bitte versuche es erneut.'], 500);
            }
            oys_json([
                'ok' => true,
                'page' => oys_page_for_editor($result['page']),
                'blocks' => array_map('oys_block_for_editor', $result['blocks']),
                'idmap' => $result['idmap'],
                'warnings' => $result['warnings'],
            ]);

        case 'upload':
            if (!$isPost) break;
            $kind = (string) ($_POST['kind'] ?? '');
            if (empty($_FILES['file'])) {
                oys_json(['ok' => false, 'error' => 'Keine Datei empfangen (evtl. zu groß für den Server).']);
            }
            $res = oys_handle_upload($_FILES['file'], $kind, $userId);
            if (isset($res['error'])) {
                oys_json(['ok' => false, 'error' => $res['error']]);
            }
            oys_json(['ok' => true, 'file' => $res['file'], 'url' => oys_upload_url($res['file'])]);

        case 'address':
            if (!$isPost) break;
            $slug = oys_normalize_slug($input['slug'] ?? $page['slug']);
            $mode = ($input['mode'] ?? 'subdomain') === 'path' ? 'path' : 'subdomain';
            if ($slug !== $page['slug']) {
                $last = $page['slug_changed_at'] ? strtotime($page['slug_changed_at']) : 0;
                $daysLeft = 30 - (int) floor((time() - $last) / 86400);
                if ($last && $daysLeft > 0 && !$premium) {
                    oys_json(['ok' => false, 'error' => "Du kannst deine Adresse erst in $daysLeft Tagen wieder ändern."]);
                }
                if ($problem = oys_slug_problem($pdo, $slug, (int) $page['id'])) {
                    oys_json(['ok' => false, 'error' => $problem]);
                }
                $pdo->prepare('UPDATE pages SET slug = ?, slug_changed_at = ? WHERE id = ?')->execute([$slug, date('Y-m-d H:i:s'), $page['id']]);
            }
            $pdo->prepare('UPDATE pages SET address_mode = ? WHERE id = ?')->execute([$mode, $page['id']]);
            oys_sync_username($pdo, $userId);
            oys_json(['ok' => true, 'page' => oys_page_for_editor(oys_load_page($pdo, (int) $page['id']))]);

        case 'page-delete':
            if (!$isPost) break;
            $target = oys_load_page($pdo, (int) ($input['id'] ?? 0));
            if (!$target || (int) $target['user_id'] !== $userId) {
                oys_json(['ok' => false, 'error' => 'Seite nicht gefunden.'], 404);
            }
            if (count(oys_user_pages($pdo, $userId)) <= 1) {
                oys_json(['ok' => false, 'error' => 'Deine letzte Seite kannst du nicht löschen.']);
            }
            if (($input['confirm'] ?? '') !== $target['slug']) {
                oys_json(['ok' => false, 'error' => 'Bitte tippe zur Bestätigung die Adresse der Seite ein.']);
            }
            oys_delete_page($pdo, $target);
            unset($_SESSION['page_id']);
            oys_sync_username($pdo, $userId);
            oys_json(['ok' => true]);

        case 'stats':
            $range = (int) ($_GET['range'] ?? 7);
            if (!in_array($range, [7, 30, 90, 0], true)) $range = 7;
            oys_json(['ok' => true, 'stats' => oys_stats($pdo, $page, $range)]);

        case 'messages':
            $stmt = $pdo->prepare('SELECT m.*, p.slug FROM messages m LEFT JOIN pages p ON p.id = m.page_id WHERE m.user_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT 200');
            $stmt->execute([$userId]);
            $messages = [];
            foreach ($stmt->fetchAll() as $m) {
                $messages[] = [
                    'id' => (int) $m['id'],
                    'page' => $m['slug'],
                    'name' => decryptData($m['name']),
                    'email' => decryptData($m['email']),
                    'message' => decryptData($m['message']),
                    'read' => (bool) $m['is_read'],
                    'date' => date('d.m.Y H:i', strtotime((string) $m['created_at'])),
                    'ago' => oys_time_ago($m['created_at']),
                ];
            }
            $stmt = $pdo->prepare('SELECT * FROM user_bookings WHERE user_id = ? ORDER BY booking_date DESC, booking_time DESC LIMIT 200');
            $stmt->execute([$userId]);
            $bookings = [];
            foreach ($stmt->fetchAll() as $b) {
                $bookings[] = [
                    'id' => (int) $b['id'],
                    'name' => decryptData($b['guest_name'] ?? ''),
                    'email' => decryptData($b['guest_email'] ?? ''),
                    'date' => $b['booking_date'] ? date('d.m.Y', strtotime($b['booking_date'])) : '',
                    'time' => $b['booking_time'],
                    'past' => $b['booking_date'] && $b['booking_date'] < date('Y-m-d'),
                ];
            }
            oys_json(['ok' => true, 'messages' => $messages, 'bookings' => $bookings]);

        case 'message':
            if (!$isPost) break;
            $id = (int) ($input['id'] ?? 0);
            $act = (string) ($input['action'] ?? '');
            if ($act === 'delete') {
                $pdo->prepare('DELETE FROM messages WHERE id = ? AND user_id = ?')->execute([$id, $userId]);
            } elseif ($act === 'read' || $act === 'unread') {
                $pdo->prepare('UPDATE messages SET is_read = ? WHERE id = ? AND user_id = ?')->execute([$act === 'read' ? 1 : 0, $id, $userId]);
            }
            oys_json(['ok' => true]);

        case 'booking-delete':
            if (!$isPost) break;
            $pdo->prepare('DELETE FROM user_bookings WHERE id = ? AND user_id = ?')->execute([(int) ($input['id'] ?? 0), $userId]);
            oys_json(['ok' => true]);

        case 'notifications':
            $stmt = $pdo->prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 15');
            $stmt->execute([$userId]);
            $items = array_map(fn($n) => [
                'id' => (int) $n['id'],
                'type' => $n['type'],
                'title' => $n['title'],
                'body' => $n['body'],
                'read' => (bool) $n['is_read'],
                'ago' => oys_time_ago($n['created_at']),
            ], $stmt->fetchAll());
            $unread = $pdo->prepare('SELECT COUNT(*) FROM notifications WHERE user_id = ? AND is_read = 0');
            $unread->execute([$userId]);
            $msgUnread = $pdo->prepare('SELECT COUNT(*) FROM messages WHERE user_id = ? AND is_read = 0');
            $msgUnread->execute([$userId]);
            oys_json(['ok' => true, 'unread' => (int) $unread->fetchColumn(), 'messages_unread' => (int) $msgUnread->fetchColumn(), 'items' => $items]);

        case 'notifications-read':
            if (!$isPost) break;
            $pdo->prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?')->execute([$userId]);
            oys_json(['ok' => true]);

        case 'weekly':
            if (!$isPost) break;
            $pdo->prepare('UPDATE users SET weekly_report = ? WHERE id = ?')->execute([!empty($input['enabled']) ? 1 : 0, $userId]);
            oys_json(['ok' => true]);

        case 'weekly-test':
            if (!$isPost) break;
            if (!oys_rate_limit($pdo, 'weeklytest:' . $userId, 3, 3600)) {
                oys_json(['ok' => false, 'error' => 'Du kannst höchstens 3 Testberichte pro Stunde senden.']);
            }
            $ok = oys_send_weekly_report($pdo, $user);
            oys_json($ok ? ['ok' => true] : ['ok' => false, 'error' => 'Die Mail konnte nicht gesendet werden. Bitte prüfe die Mail-Einstellungen im Admin-Bereich.']);

        case 'discord':
            if (!$isPost) break;
            $discord = preg_replace('/[^0-9]/', '', (string) ($input['discord_id'] ?? ''));
            $pdo->prepare('UPDATE users SET discord_id = ? WHERE id = ?')->execute([$discord !== '' ? encryptData(substr($discord, 0, 25)) : '', $userId]);
            oys_json(['ok' => true]);
    }
    oys_json(['ok' => false, 'error' => 'Unbekannte Aktion.'], 404);
}

// ---------------------------------------------------------------
// Editor (Dashboard)
// ---------------------------------------------------------------
if ($path === '/dashboard') {
    // Klassische Formulare: E-Mail und Passwort ändern
    if ($method === 'POST') {
        if (!oys_csrf_check($_POST['csrf'] ?? null)) {
            oys_flash('error', 'Die Sitzung ist abgelaufen. Bitte versuche es erneut.');
            oys_redirect('/dashboard#einstellungen');
        }
        $action = $_POST['update_action'] ?? '';
        if ($action === 'email') {
            $newEmail = strtolower(trim((string) ($_POST['new_email'] ?? '')));
            if (!password_verify((string) ($_POST['current_password_email'] ?? ''), $user['password'])) {
                oys_flash('error', 'Das aktuelle Passwort ist falsch.');
            } elseif (!filter_var($newEmail, FILTER_VALIDATE_EMAIL)) {
                oys_flash('error', 'Bitte gib eine gültige E-Mail-Adresse an.');
            } elseif ($newEmail === strtolower($user['email'])) {
                oys_flash('error', 'Das ist bereits deine E-Mail-Adresse.');
            } else {
                $check = $pdo->prepare('SELECT id FROM users WHERE email = ? AND id <> ?');
                $check->execute([$newEmail, $userId]);
                if ($check->fetch()) {
                    oys_flash('error', 'Diese E-Mail-Adresse wird schon verwendet.');
                } else {
                    $pdo->prepare('UPDATE users SET email = ? WHERE id = ?')->execute([$newEmail, $userId]);
                    oys_flash('success', 'E-Mail-Adresse geändert.');
                }
            }
        } elseif ($action === 'password') {
            $new = (string) ($_POST['new_password'] ?? '');
            if ($new !== (string) ($_POST['confirm_new_password'] ?? '')) {
                oys_flash('error', 'Die neuen Passwörter stimmen nicht überein.');
            } elseif (strlen($new) < 8) {
                oys_flash('error', 'Das neue Passwort muss mindestens 8 Zeichen lang sein.');
            } elseif (!password_verify((string) ($_POST['current_password_pwd'] ?? ''), $user['password'])) {
                oys_flash('error', 'Das aktuelle Passwort ist falsch.');
            } else {
                $pdo->prepare('UPDATE users SET password = ? WHERE id = ?')->execute([password_hash($new, PASSWORD_DEFAULT), $userId]);
                oys_flash('success', 'Passwort geändert.');
            }
        }
        oys_redirect('/dashboard#einstellungen');
    }

    $page = oys_current_page($pdo, $user, $_GET['page'] ?? null);
    $pages = oys_user_pages($pdo, $userId);
    $blocks = $page ? oys_load_blocks($pdo, (int) $page['id']) : [];
    $user_data = $user;
    $user_data['discord_id'] = decryptData($user['discord_id'] ?? '');
    $is_impersonating = isset($_SESSION['original_admin_id']);
    $has_premium_access = $premium;
    require dirname(__DIR__) . '/views/dashboard.php';
    exit;
}

http_response_code(404);
require dirname(__DIR__) . '/views/404.php';
