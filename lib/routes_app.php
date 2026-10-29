<?php
// Routen der Hauptdomain: Startseite, Login, Registrierung, Editor (Dashboard), Admin.
/** @var PDO $pdo */
/** @var string $path */
/** @var string $method */

// Session nur, wenn nötig: Startseite und Updates setzen für Besucher kein Cookie.
$cookieless = in_array($path, ['/', '/updates', '/updates/feed.xml', '/roadmap'], true) || preg_match('#^/updates/\d+$#', $path);
if (!$cookieless || isset($_COOKIE[session_name()])) {
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

// Updates & Roadmap (öffentlich)
if ($path === '/roadmap') {
    oys_redirect('/updates#roadmap', 301);
}
if ($path === '/updates') {
    $user_data = session_status() === PHP_SESSION_ACTIVE ? oys_current_user($pdo) : null;
    require dirname(__DIR__) . '/views/updates.php';
    exit;
}
if ($path === '/updates/feed.xml') {
    require dirname(__DIR__) . '/views/updates_feed.php';
    exit;
}
// Dauerhafter Link zu einem Update (Discord, Feed): zur Seite weiterleiten, auf der es gerade steht
if (preg_match('#^/updates/(\d+)$#', $path, $m)) {
    $id = (int) $m[1];
    $pageNo = oys_update_page_of($pdo, $id);
    oys_redirect($pageNo === null ? '/updates' : '/updates' . ($pageNo > 1 ? '?page=' . $pageNo : '') . '#update-' . $id);
}

if ($path === '/logout') {
    // Nur per POST mit CSRF-Token – sonst könnte jede fremde Seite (oder eigenes CSS) abmelden
    if ($method === 'POST' && oys_csrf_check($_POST['csrf'] ?? null)) {
        $_SESSION = [];
        session_destroy();
        oys_redirect('/');
    }
    oys_redirect(empty($_SESSION['user_id']) ? '/' : '/dashboard');
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
            oys_flash('error', 'Your session has expired. Please try again.');
        } elseif ($fullname === '' || $email === '' || $password === '' || $slug === '') {
            oys_flash('error', 'Please fill in all fields.');
        } elseif (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            oys_flash('error', 'Please enter a valid email address.');
        } elseif (strlen($password) < 8) {
            oys_flash('error', 'Your password must be at least 8 characters long.');
        } elseif ($problem = oys_slug_problem($pdo, $slug)) {
            oys_flash('error', $problem);
        } elseif (!oys_rate_limit($pdo, 'register:' . oys_client_key(), 5, 3600)) {
            // Massen-Anmeldungen bremsen (jedes Konto bekommt Speicherplatz)
            oys_flash('error', 'A lot of accounts were just created from here. Please try again later.');
        } else {
            $check = $pdo->prepare('SELECT id FROM users WHERE email = ? OR username = ? LIMIT 1');
            $check->execute([$email, $slug]);
            if ($check->fetch()) {
                oys_flash('error', 'This email address or page address is already registered.');
            } else {
                try {
                    $pdo->prepare("INSERT INTO users (email, password, full_name, username, layout_type, last_ip, theme) VALUES (?, ?, ?, ?, 'link-tree', ?, ?)")
                        ->execute([$email, password_hash($password, PASSWORD_DEFAULT), $fullname, $slug, encryptData($_SERVER['REMOTE_ADDR'] ?? ''), OYS_DEFAULT_THEME]);
                    $userId = (int) $pdo->lastInsertId();
                    $pageId = oys_create_page($pdo, $userId, $slug, $fullname);
                    session_regenerate_id(true);
                    $_SESSION['user_id'] = $userId;
                    $_SESSION['page_id'] = $pageId;
                    unset($_SESSION['old']);
                    oys_flash('success', 'Welcome! Your page is live.');
                    sendCustomEmail($email, 'register', ['full_name' => e($fullname), 'subdomain' => e($slug)]);
                    oys_redirect('/dashboard');
                } catch (PDOException $e) {
                    error_log('Sign-up failed: ' . $e->getMessage());
                    oys_flash('error', 'This email address is already registered.');
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
        $loginKey = 'login:' . substr(hash('sha256', $email), 0, 40);
        if (!oys_csrf_check($_POST['csrf'] ?? null)) {
            oys_flash('error', 'Your session has expired. Please try again.');
        } elseif (!oys_attempts_allowed($pdo, $loginKey, 10, 50, 900)) {
            oys_flash('error', 'Too many attempts. Please wait 15 minutes.');
        } else {
            $stmt = $pdo->prepare('SELECT * FROM users WHERE email = ?');
            $stmt->execute([$email]);
            $user = $stmt->fetch();
            if (!$user || !password_verify($password, $user['password'])) {
                // Nur Fehlversuche zählen – je Absender und je Konto
                oys_attempt_failed($pdo, $loginKey, 900);
            } else {
                session_regenerate_id(true);
                $_SESSION['user_id'] = (int) $user['id'];
                $pdo->prepare('UPDATE users SET last_ip = ? WHERE id = ?')->execute([encryptData($_SERVER['REMOTE_ADDR'] ?? ''), $user['id']]);
                oys_redirect('/dashboard');
            }
            oys_flash('error', 'Wrong email or password.');
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
        oys_json(['ok' => false, 'error' => 'Please log in again.'], 401);
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
        oys_json(['ok' => false, 'error' => 'Session expired – please reload the page.'], 419);
    }
    $isJsonBody = stripos($_SERVER['CONTENT_TYPE'] ?? '', 'application/json') !== false;
    $raw = $isPost && $isJsonBody ? (string) file_get_contents('php://input') : '';
    $input = $raw !== '' ? json_decode($raw, true) : [];
    if (!is_array($input)) {
        // Kaputtes JSON nie als „leere Seite“ speichern
        oys_json(['ok' => false, 'error' => 'Not all of the data arrived. Please try again.'], 400);
    }
    $requestedPage = $input['page']['id'] ?? ($input['page_id'] ?? ($_POST['page_id'] ?? ($_GET['page'] ?? null)));
    $requestedPage = is_scalar($requestedPage) && (int) $requestedPage > 0 ? (int) $requestedPage : null;
    if ($requestedPage !== null && $action !== 'page-create') {
        // Nie still auf eine andere Seite ausweichen: gelöschte Seite (anderer Tab) oder inzwischen
        // ein anderes Konto (Admin-Modus in einem zweiten Tab) → ablehnen statt die falsche Seite zu überschreiben
        $page = oys_load_page($pdo, $requestedPage);
        if (!$page || (int) $page['user_id'] !== $userId) {
            oys_json(['ok' => false, 'error' => 'This page no longer exists, or you’re now logged in with a different account. Please reload the editor.', 'reload' => true], 409);
        }
        $_SESSION['page_id'] = $requestedPage;
    } else {
        $page = oys_current_page($pdo, $user);
    }
    if (in_array($action, ['save', 'address'], true) && $requestedPage === null) {
        oys_json(['ok' => false, 'error' => 'The request doesn’t say which page it’s for. Please reload the editor.', 'reload' => true], 400);
    }

    // Seite anlegen geht auch ohne bestehende Seite
    if ($action === 'page-create' && $isPost) {
        $count = count(oys_user_pages($pdo, $userId));
        $max = (int) oys_config('max_pages', 3);
        if ($count >= $max && !$premium) {
            oys_json(['ok' => false, 'error' => "You can create up to $max " . ($max === 1 ? 'page.' : 'pages.')]);
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
        oys_json(['ok' => false, 'error' => 'Create a page first.'], 404);
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
            if (!is_array($input['page'] ?? null) || !is_array($input['blocks'] ?? null)) {
                oys_json(['ok' => false, 'error' => 'Not all of the data arrived. Please try again.'], 400);
            }
            try {
                $result = oys_save_page($pdo, $page, $input, $userId, $premium);
            } catch (Throwable $e) {
                error_log('Saving failed: ' . $e->getMessage());
                oys_json(['ok' => false, 'error' => 'Saving failed. Please try again.'], 500);
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
                oys_json(['ok' => false, 'error' => 'No file received (it may be too large for the server).']);
            }
            if (!oys_rate_limit($pdo, 'upload:' . $userId, 120, 3600)) {
                oys_json(['ok' => false, 'error' => 'Too many uploads in a short time – please wait a moment.']);
            }
            // Speicherplatz begrenzen (vorher nie gespeicherte Uploads aufräumen)
            $quotaMb = $premium ? OYS_UPLOAD_QUOTA_PREMIUM_MB : OYS_UPLOAD_QUOTA_MB;
            $usedBytes = array_sum(oys_sweep_uploads($pdo, $userId, oys_user_upload_files($userId)));
            if ($usedBytes + (int) ($_FILES['file']['size'] ?? 0) > $quotaMb * 1048576) {
                oys_json(['ok' => false, 'error' => 'Your storage (' . $quotaMb . ' MB) is full. Remove images, music or files you no longer need and save.']);
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
                    oys_json(['ok' => false, 'error' => "You can change your address again in $daysLeft " . ($daysLeft === 1 ? 'day.' : 'days.')]);
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
                oys_json(['ok' => false, 'error' => 'Page not found.'], 404);
            }
            if (count(oys_user_pages($pdo, $userId)) <= 1) {
                oys_json(['ok' => false, 'error' => 'You can’t delete your last page.']);
            }
            if (($input['confirm'] ?? '') !== $target['slug']) {
                oys_json(['ok' => false, 'error' => 'To confirm, please type the page’s address.']);
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
                    'date' => date('M j, Y, H:i', strtotime((string) $m['created_at'])),
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
                    'date' => $b['booking_date'] ? date('M j, Y', strtotime($b['booking_date'])) : '',
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
                oys_json(['ok' => false, 'error' => 'You can send up to 3 test reports per hour.']);
            }
            $ok = oys_send_weekly_report($pdo, $user);
            oys_json($ok ? ['ok' => true] : ['ok' => false, 'error' => 'The email couldn’t be sent. Please check the mail settings in the admin area.']);

        case 'discord':
            if (!$isPost) break;
            $discord = preg_replace('/[^0-9]/', '', (string) ($input['discord_id'] ?? ''));
            $pdo->prepare('UPDATE users SET discord_id = ? WHERE id = ?')->execute([$discord !== '' ? encryptData(substr($discord, 0, 25)) : '', $userId]);
            oys_json(['ok' => true]);
    }
    oys_json(['ok' => false, 'error' => 'Unknown action.'], 404);
}

// ---------------------------------------------------------------
// Editor (Dashboard)
// ---------------------------------------------------------------
if ($path === '/dashboard') {
    // Klassische Formulare: E-Mail und Passwort ändern
    if ($method === 'POST') {
        if (!oys_csrf_check($_POST['csrf'] ?? null)) {
            oys_flash('error', 'Your session has expired. Please try again.');
            oys_redirect('/dashboard#settings');
        }
        $action = $_POST['update_action'] ?? '';
        if ($action === 'email') {
            $newEmail = strtolower(trim((string) ($_POST['new_email'] ?? '')));
            if (!password_verify((string) ($_POST['current_password_email'] ?? ''), $user['password'])) {
                oys_flash('error', 'Your current password is incorrect.');
            } elseif (!filter_var($newEmail, FILTER_VALIDATE_EMAIL)) {
                oys_flash('error', 'Please enter a valid email address.');
            } elseif ($newEmail === strtolower($user['email'])) {
                oys_flash('error', 'That’s already your email address.');
            } else {
                $check = $pdo->prepare('SELECT id FROM users WHERE email = ? AND id <> ?');
                $check->execute([$newEmail, $userId]);
                if ($check->fetch()) {
                    oys_flash('error', 'This email address is already in use.');
                } else {
                    $pdo->prepare('UPDATE users SET email = ? WHERE id = ?')->execute([$newEmail, $userId]);
                    oys_flash('success', 'Email address changed.');
                }
            }
        } elseif ($action === 'password') {
            $new = (string) ($_POST['new_password'] ?? '');
            if ($new !== (string) ($_POST['confirm_new_password'] ?? '')) {
                oys_flash('error', 'The new passwords don’t match.');
            } elseif (strlen($new) < 8) {
                oys_flash('error', 'Your new password must be at least 8 characters long.');
            } elseif (!password_verify((string) ($_POST['current_password_pwd'] ?? ''), $user['password'])) {
                oys_flash('error', 'Your current password is incorrect.');
            } else {
                $pdo->prepare('UPDATE users SET password = ? WHERE id = ?')->execute([password_hash($new, PASSWORD_DEFAULT), $userId]);
                oys_flash('success', 'Password changed.');
            }
        }
        oys_redirect('/dashboard#settings');
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
