<?php
require __DIR__ . '/lib/bootstrap.php';
oys_start_session();

// Sicherheits-Check: Nur Admins dürfen das!
if (!isset($_SESSION['user_id'])) {
    header("Location: /login");
    exit;
}

$stmtCheck = $pdo->prepare("SELECT is_admin FROM users WHERE id = ?");
$stmtCheck->execute([$_SESSION['original_admin_id'] ?? $_SESSION['user_id']]);
$isAdmin = $stmtCheck->fetchColumn();

if (!$isAdmin) {
    header("Location: /dashboard");
    exit;
}

// User-ID abgreifen, in die wir uns einloggen wollen
$target_user_id = (int) ($_GET['id'] ?? 0);

if ($target_user_id > 0) {
    // 1. Wir speichern die originale Admin-ID, damit wir später zurückkönnen
    if (!isset($_SESSION['original_admin_id'])) {
        $_SESSION['original_admin_id'] = (int) $_SESSION['user_id'];
    }

    // 2. Wir loggen den Admin nun als diesen User ein
    $_SESSION['user_id'] = $target_user_id;
    unset($_SESSION['page_id']);

    $_SESSION['success'] = "Eingeloggt als Nutzer #" . $target_user_id;
    header("Location: /dashboard");
    exit;
}

$_SESSION['admin_error'] = "User ID not found.";
header("Location: /admin");
exit;
