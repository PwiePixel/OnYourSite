<?php
// Admin: zurück zum eigenen Konto (nur per POST mit CSRF-Token)
require __DIR__ . '/lib/bootstrap.php';
oys_start_session();

if (isset($_SESSION['original_admin_id']) && ($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST' && oys_csrf_check($_POST['csrf'] ?? null)) {
    session_regenerate_id(true);
    $_SESSION['user_id'] = $_SESSION['original_admin_id'];
    unset($_SESSION['original_admin_id'], $_SESSION['page_id']);

    $_SESSION['admin_success'] = 'Welcome back! You are no longer impersonating a user.';
    header('Location: /admin');
    exit;
}

header('Location: /dashboard');
exit;
