<?php
// Admin: als anderer Nutzer einloggen. Nur per POST mit CSRF-Token – ein einfacher Link
// (z. B. aus eigenem CSS einer Profilseite) darf den Admin nicht umschalten.
require __DIR__ . '/lib/bootstrap.php';
oys_start_session();

if (!isset($_SESSION['user_id'])) {
    header('Location: /login');
    exit;
}
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST' || !oys_csrf_check($_POST['csrf'] ?? null)) {
    header('Location: /admin');
    exit;
}

$stmtCheck = $pdo->prepare('SELECT is_admin FROM users WHERE id = ?');
$stmtCheck->execute([$_SESSION['original_admin_id'] ?? $_SESSION['user_id']]);
if (!$stmtCheck->fetchColumn()) {
    header('Location: /dashboard');
    exit;
}

$target_user_id = (int) ($_POST['id'] ?? 0);
$exists = $pdo->prepare('SELECT id FROM users WHERE id = ?');
$exists->execute([$target_user_id]);

if ($target_user_id > 0 && $exists->fetchColumn()) {
    // Originale Admin-ID merken, damit es zurückgeht
    if (!isset($_SESSION['original_admin_id'])) {
        $_SESSION['original_admin_id'] = (int) $_SESSION['user_id'];
    }
    session_regenerate_id(true);
    $_SESSION['user_id'] = $target_user_id;
    unset($_SESSION['page_id']);

    $_SESSION['success'] = 'Logged in as user #' . $target_user_id;
    header('Location: /dashboard');
    exit;
}

$_SESSION['admin_error'] = 'User ID not found.';
header('Location: /admin');
exit;
