<?php
require __DIR__ . '/lib/bootstrap.php';
oys_start_session();

if (isset($_SESSION['original_admin_id'])) {
    // Logge den Admin wieder in seinen echten Account ein
    $_SESSION['user_id'] = $_SESSION['original_admin_id'];

    // Lösche den "Verkleidungs"-Status
    unset($_SESSION['original_admin_id'], $_SESSION['page_id']);

    $_SESSION['admin_success'] = "Welcome back! You are no longer impersonating a user.";
    header("Location: /admin");
    exit;
}

// Falls jemand die Datei normal aufruft
header("Location: /dashboard");
exit;
