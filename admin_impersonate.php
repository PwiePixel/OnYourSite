<?php
session_start();
require_once 'db.php';

// Sicherheits-Check: Nur Admins dürfen das!
if (!isset($_SESSION['user_id'])) {
    header("Location: /login");
    exit;
}

$stmtCheck = $pdo->prepare("SELECT is_admin FROM users WHERE id = ?");
$stmtCheck->execute([$_SESSION['user_id']]);
$isAdmin = $stmtCheck->fetchColumn();

if (!$isAdmin) {
    header("Location: /dashboard");
    exit;
}

// User-ID abgreifen, in die wir uns einloggen wollen
$target_user_id = $_GET['id'] ?? null;

if ($target_user_id) {
    // 1. Wir speichern die originale Admin-ID, damit wir (optional) später zurückkönnen
    $_SESSION['original_admin_id'] = $_SESSION['user_id'];
    
    // 2. Wir loggen den Admin nun als diesen User ein
    $_SESSION['user_id'] = (int)$target_user_id;
    
    $_SESSION['success'] = "Successfully logged in as User #" . $target_user_id;
    header("Location: /dashboard");
    exit;
} else {
    $_SESSION['admin_error'] = "User ID not found.";
    header("Location: /admin");
    exit;
}
?>