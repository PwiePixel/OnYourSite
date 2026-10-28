<?php
// Sicherheits-Check
if (!isset($_SESSION['user_id']) || !$user_data['is_admin']) {
    header("Location: /dashboard");
    exit;
}

// Mail & Security-Funktionen laden
require_once __DIR__ . '/../mail.php';
require_once __DIR__ . '/../security.php'; // NEU: Damit der Admin die Daten lesen kann

// Alle Admin-Formulare sind gegen CSRF geschützt
if ($_SERVER['REQUEST_METHOD'] === 'POST' && !oys_csrf_check($_POST['csrf'] ?? null)) {
    $_SESSION['admin_error'] = "Session expired – please try again.";
    header("Location: /admin");
    exit;
}

// Ordner für E-Mails und Config sicherstellen
$email_dir = __DIR__ . '/../email/';
if (!is_dir($email_dir)) {
    mkdir($email_dir, 0755, true);
}

// LOGIK: Mail-Server (SMTP) Einstellungen speichern
$smtp_file = $email_dir . 'smtp.json';
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['save_smtp'])) {
    $smtp_data = [
        'host' => trim($_POST['smtp_host'] ?? ''),
        'port' => trim($_POST['smtp_port'] ?? ''),
        'username' => trim($_POST['smtp_username'] ?? ''),
        'password' => trim($_POST['smtp_password'] ?? ''),
        'from_email' => trim($_POST['from_email'] ?? ''),
        'from_name' => trim($_POST['from_name'] ?? '')
    ];
    file_put_contents($smtp_file, json_encode($smtp_data, JSON_PRETTY_PRINT));
    $_SESSION['admin_success'] = "Mail Server settings successfully saved.";
    header("Location: /admin");
    exit;
}

// LOGIK: User löschen
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['delete_user_id'])) {
    $delete_id = (int)$_POST['delete_user_id'];
    if ($delete_id === $_SESSION['user_id']) {
        $_SESSION['admin_error'] = "You cannot delete your own admin account!";
    } else {
        foreach (oys_user_pages($pdo, $delete_id) as $delPage) {
            oys_delete_page($pdo, $delPage);
        }
        foreach (['notifications', 'messages', 'user_links', 'user_bookings', 'user_certificates'] as $tbl) {
            $pdo->prepare("DELETE FROM $tbl WHERE user_id = ?")->execute([$delete_id]);
        }
        $stmtDel = $pdo->prepare("DELETE FROM users WHERE id = ?");
        $stmtDel->execute([$delete_id]);
        $_SESSION['admin_success'] = "User successfully deleted.";
    }
    header("Location: /admin");
    exit;
}

// LOGIK: Admin-Rolle umschalten
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['toggle_admin_id'])) {
    $toggle_id = (int)$_POST['toggle_admin_id'];
    if ($toggle_id === $_SESSION['user_id']) {
        $_SESSION['admin_error'] = "You cannot change your own admin status here!";
    } else {
        $stmtStatus = $pdo->prepare("SELECT is_admin FROM users WHERE id = ?");
        $stmtStatus->execute([$toggle_id]);
        $status = $stmtStatus->fetchColumn();
        
        $new_status = $status ? 0 : 1;
        $stmtToggle = $pdo->prepare("UPDATE users SET is_admin = ? WHERE id = ?");
        $stmtToggle->execute([$new_status, $toggle_id]);
        
        $role_text = $new_status ? "promoted to Admin" : "demoted to User";
        $_SESSION['admin_success'] = "User successfully $role_text.";
    }
    header("Location: /admin");
    exit;
}

// LOGIK: Passwort für User zurücksetzen
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['reset_password_id']) && !empty($_POST['new_password'])) {
    $reset_id = (int)$_POST['reset_password_id'];
    $new_pwd = $_POST['new_password'];
    
    $hashed_pwd = password_hash($new_pwd, PASSWORD_DEFAULT);
    $stmtReset = $pdo->prepare("UPDATE users SET password = ? WHERE id = ?");
    $stmtReset->execute([$hashed_pwd, $reset_id]);
    
    $_SESSION['admin_success'] = "Password for user #$reset_id successfully changed.";
    header("Location: /admin");
    exit;
}

// LOGIK: NEWSLETTER & EINZELNE MAILS SENDEN
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['send_newsletter'])) {
    $template_file = $_POST['template_file'] ?? '';
    $template_name = str_replace('.json', '', $template_file); 
    $subject = trim($_POST['email_subject'] ?? '');
    $audience = $_POST['audience'] ?? 'all';
    $single_email = trim($_POST['single_email'] ?? '');
    
    $recipients = [];
    if ($audience === 'all') {
        $stmt = $pdo->query("SELECT email, full_name, username FROM users");
        $recipients = $stmt->fetchAll(PDO::FETCH_ASSOC);
    } elseif ($audience === 'with_domain') {
        $stmt = $pdo->query("SELECT email, full_name, username FROM users WHERE username IS NOT NULL AND username != ''");
        $recipients = $stmt->fetchAll(PDO::FETCH_ASSOC);
    } elseif ($audience === 'no_domain') {
        $stmt = $pdo->query("SELECT email, full_name, username FROM users WHERE username IS NULL OR username = ''");
        $recipients = $stmt->fetchAll(PDO::FETCH_ASSOC);
    } elseif ($audience === 'single' && !empty($single_email)) {
        $stmt = $pdo->prepare("SELECT email, full_name, username FROM users WHERE email = ?");
        $stmt->execute([$single_email]);
        $recipients = $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    if (empty($recipients)) {
        $_SESSION['admin_error'] = "No users found for this audience. Mail aborted.";
    } else {
        $success_count = 0;
        foreach ($recipients as $r) {
            $vars = [
                'full_name' => $r['full_name'],
                'subdomain' => $r['username'] ?: 'yourname'
            ];
            if (sendCustomEmail($r['email'], $template_name, $vars, empty($subject) ? null : $subject)) {
                $success_count++;
            }
        }
        
        if ($success_count > 0) {
            $_SESSION['admin_success'] = "Successfully sent $success_count email(s)!";
        } else {
            $_SESSION['admin_error'] = "Failed to send emails. Check your SMTP settings and PHPMailer installation.";
        }
    }
    
    header("Location: /admin");
    exit;
}

// Alle User laden
$stmtUsers = $pdo->query("SELECT id, full_name, email, username, discord_id, is_admin, created_at FROM users ORDER BY id DESC");
$all_users = $stmtUsers->fetchAll(PDO::FETCH_ASSOC);

// NEU: Wir müssen die verschlüsselten Discord-IDs für die Tabelle im Admin-Panel wieder lesbar machen
foreach ($all_users as &$u) {
    $u['discord_id'] = decryptData($u['discord_id']);
}
unset($u);

// Seiten (bis zu 3 je Nutzer) für die Tabelle
$pagesByUser = [];
foreach ($pdo->query("SELECT * FROM pages ORDER BY position, id")->fetchAll() as $pg) {
    $pagesByUser[(int) $pg['user_id']][] = $pg;
}
$total_pages = array_sum(array_map('count', $pagesByUser));

$total_users = count($all_users);
$total_admins = count(array_filter($all_users, fn($u) => $u['is_admin'] == 1));
$total_domains = count(array_filter($all_users, fn($u) => !empty($u['username'])));

// Templates scannen
$templates = [];
$files = glob($email_dir . '*.json');
if ($files) {
    foreach ($files as $file) {
        if(basename($file) !== 'smtp.json') {
            $templates[] = basename($file);
        }
    }
}

// SMTP Config laden
$smtp_config = [];
if (file_exists($smtp_file)) {
    $smtp_config = json_decode(file_get_contents($smtp_file), true);
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Panel | OnYourSite</title>
    <link rel="icon" type="image/png" href="/static/images/favicon.png">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <link href='https://unpkg.com/boxicons@2.1.4/css/boxicons.min.css' rel='stylesheet'>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = { 
            theme: { 
                extend: { 
                    fontFamily: { sans: ['Inter', 'sans-serif'], },
                    colors: { 
                        background: '#000000', card: '#0a0a0a', inputbg: '#121212', bordercolor: '#27272a',
                        brand: { 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5', } 
                    } 
                } 
            } 
        }
    </script>
</head>
<body class="bg-background text-gray-300 font-sans h-screen flex overflow-hidden selection:bg-brand-500/30">

    <aside class="w-20 lg:w-64 border-r border-bordercolor bg-card flex flex-col justify-between py-6 transition-all z-20 shrink-0">
        <div>
            <a href="<?php echo htmlspecialchars(oys_main_url('/')); ?>" class="px-6 mb-8 flex items-center gap-2 cursor-pointer transition-transform hover:scale-105 group block">
                <div class="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-500 to-purple-600 flex items-center justify-center shadow-lg shadow-brand-500/20">
                    <i class='bx bx-hive text-xl text-white'></i>
                </div>
                <span class="font-bold text-xl text-white tracking-tight hidden lg:block">OnYourSite</span>
            </a>
            
            <div class="px-4 mb-2 hidden lg:block">
                <p class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Admin Menu</p>
            </div>
            
            <nav class="space-y-1 px-3">
                <a href="/dashboard" class="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/5 text-gray-400 hover:text-white transition-all">
                    <i class='bx bx-left-arrow-alt text-xl'></i> <span class="hidden lg:block text-sm">Back to Dashboard</span>
                </a>
                
                <div class="my-4 border-t border-bordercolor"></div>

                <button type="button" onclick="switchAdminTab('users')" id="nav-users" class="admin-nav-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 font-medium transition-all shadow-inner">
                    <i class='bx bx-group text-xl'></i> <span class="hidden lg:block text-sm">User Management</span>
                </button>

                <button type="button" onclick="switchAdminTab('newsletter')" id="nav-newsletter" class="admin-nav-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-transparent hover:bg-white/5 text-gray-400 hover:text-white font-medium transition-all">
                    <i class='bx bx-envelope text-xl'></i> <span class="hidden lg:block text-sm">Newsletter & Mails</span>
                </button>

                <button type="button" onclick="switchAdminTab('mailserver')" id="nav-mailserver" class="admin-nav-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-transparent hover:bg-white/5 text-gray-400 hover:text-white font-medium transition-all">
                    <i class='bx bx-server text-xl'></i> <span class="hidden lg:block text-sm">Mail Server</span>
                </button>
            </nav>
        </div>
        <div class="px-3">
            <form method="post" action="/logout" class="m-0"><?= oys_csrf_field() ?>
                <button type="submit" class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-red-500/10 text-gray-500 hover:text-red-400 transition-colors">
                    <i class='bx bx-log-out text-xl'></i> <span class="hidden lg:block text-sm">Log Out</span>
                </button>
            </form>
        </div>
    </aside>

    <div class="flex-1 flex flex-col h-full overflow-hidden w-full bg-background relative">
        
        <header class="h-16 border-b border-bordercolor bg-background/80 backdrop-blur-md flex items-center justify-between px-8 shrink-0 z-10">
            <div class="flex items-center gap-3">
                <h1 class="text-lg font-semibold text-white tracking-tight" id="admin-page-title">User Management</h1>
                <span class="bg-emerald-500/20 text-emerald-400 text-[10px] uppercase px-2 py-0.5 rounded border border-emerald-500/30 font-bold flex items-center gap-1"><i class='bx bxs-shield'></i> System Admin</span>
            </div>
            <div class="flex items-center gap-4">
                <a href="<?php echo htmlspecialchars(oys_main_url('/')); ?>" target="_blank" class="text-sm text-gray-400 hover:text-brand-400 hidden sm:flex items-center gap-1.5 transition-colors bg-white/5 px-3 py-1.5 rounded-md border border-bordercolor hover:border-brand-500/30">
                    View Live Site <i class='bx bx-link-external'></i>
                </a>
            </div>
        </header>

        <?php if(isset($_SESSION['admin_success'])): ?>
            <div class="absolute top-20 left-1/2 -translate-x-1/2 z-50 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-4 py-2 rounded-lg flex items-center gap-2 shadow-lg backdrop-blur-md text-sm font-medium animate-fade-in">
                <i class='bx bx-check-circle text-lg'></i> <?php echo $_SESSION['admin_success']; unset($_SESSION['admin_success']); ?>
            </div>
        <?php endif; ?>
        <?php if(isset($_SESSION['admin_error'])): ?>
            <div class="absolute top-20 left-1/2 -translate-x-1/2 z-50 bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-2 rounded-lg flex items-center gap-2 shadow-lg backdrop-blur-md text-sm font-medium animate-fade-in">
                <i class='bx bx-error-circle text-lg'></i> <?php echo $_SESSION['admin_error']; unset($_SESSION['admin_error']); ?>
            </div>
        <?php endif; ?>

        <main class="flex-1 overflow-y-auto p-4 md:p-8 custom-scrollbar relative">
            
            <div id="tab-users" class="admin-tab-content max-w-7xl mx-auto space-y-8 block">
                <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div class="bg-card border border-bordercolor rounded-xl p-6 flex items-center gap-4">
                        <div class="w-12 h-12 rounded-lg bg-brand-500/10 border border-brand-500/20 flex items-center justify-center text-brand-400"><i class='bx bx-group text-2xl'></i></div>
                        <div><p class="text-sm text-gray-500 font-medium mb-1">Total Users</p><h3 class="text-2xl font-bold text-white"><?php echo $total_users; ?></h3></div>
                    </div>
                    <div class="bg-card border border-bordercolor rounded-xl p-6 flex items-center gap-4">
                        <div class="w-12 h-12 rounded-lg bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400"><i class='bx bx-globe text-2xl'></i></div>
                        <div><p class="text-sm text-gray-500 font-medium mb-1">Claimed Domains / Pages</p><h3 class="text-2xl font-bold text-white"><?php echo $total_domains; ?> <span class="text-base text-gray-500">/ <?php echo $total_pages; ?></span></h3></div>
                    </div>
                    <div class="bg-card border border-bordercolor rounded-xl p-6 flex items-center gap-4">
                        <div class="w-12 h-12 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400"><i class='bx bx-shield-check text-2xl'></i></div>
                        <div><p class="text-sm text-gray-500 font-medium mb-1">System Admins</p><h3 class="text-2xl font-bold text-white"><?php echo $total_admins; ?></h3></div>
                    </div>
                </div>

                <div class="bg-card border border-bordercolor rounded-xl overflow-hidden shadow-xl">
                    <div class="p-6 border-b border-bordercolor flex justify-between items-center bg-inputbg/50">
                        <h2 class="text-base font-semibold text-white">User Database</h2>
                        <div class="relative">
                            <i class='bx bx-search absolute left-3 top-1/2 -translate-y-1/2 text-gray-500'></i>
                            <input type="text" id="searchInput" onkeyup="filterTable()" placeholder="Search users..." class="bg-background border border-bordercolor rounded-lg pl-10 pr-4 py-2 text-sm text-white focus:outline-none focus:border-brand-500 transition-colors w-64 shadow-inner">
                        </div>
                    </div>

                    <div class="overflow-x-auto">
                        <table class="w-full text-left border-collapse" id="userTable">
                            <thead>
                                <tr class="bg-card border-b border-bordercolor text-xs uppercase text-gray-500 font-semibold tracking-wider">
                                    <th class="px-6 py-4">ID</th>
                                    <th class="px-6 py-4">User Info</th>
                                    <th class="px-6 py-4">Domain & Integrations</th>
                                    <th class="px-6 py-4">Role</th>
                                    <th class="px-6 py-4 text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody class="divide-y divide-bordercolor">
                                <?php foreach($all_users as $u): ?>
                                <tr class="hover:bg-white/5 transition-colors group">
                                    <td class="px-6 py-4 text-gray-500 text-xs font-mono">#<?php echo $u['id']; ?></td>
                                    <td class="px-6 py-4">
                                        <div class="flex flex-col">
                                            <span class="text-white font-medium text-sm search-target flex items-center gap-1.5">
                                                <?php echo htmlspecialchars($u['full_name']); ?>
                                                <?php if($u['is_admin']): ?><i class='bx bxs-shield text-emerald-400' title='Admin'></i><?php endif; ?>
                                            </span>
                                            <span class="text-gray-500 text-xs search-target"><?php echo htmlspecialchars($u['email']); ?></span>
                                            <span class="text-gray-600 text-[10px] mt-1">Joined: <?php echo date('M j, Y', strtotime($u['created_at'] ?? 'now')); ?></span>
                                        </div>
                                    </td>
                                    <td class="px-6 py-4">
                                        <div class="flex flex-col gap-1.5">
                                            <?php if(!empty($pagesByUser[(int) $u['id']])): ?>
                                                <?php foreach ($pagesByUser[(int) $u['id']] as $pg): ?>
                                                <a href="<?php echo htmlspecialchars(oys_page_url($pg)); ?>" target="_blank" class="text-brand-400 hover:text-brand-300 text-xs flex items-center gap-1 transition-colors search-target font-mono"><i class='bx bx-globe'></i> <?php echo htmlspecialchars(oys_page_display_url($pg)); ?> <span class="text-gray-600">(<?php echo (int) $pg['views']; ?> views)</span></a>
                                                <?php endforeach; ?>
                                            <?php else: ?>
                                                <span class="text-gray-600 text-xs italic"><i class='bx bx-ghost'></i> No domain</span>
                                            <?php endif; ?>
                                            <?php if(!empty($u['discord_id'])): ?>
                                                <span class="text-[#5865F2] text-[10px] flex items-center gap-1 font-mono search-target"><i class='bx bxl-discord-alt'></i> <?php echo htmlspecialchars($u['discord_id']); ?></span>
                                            <?php endif; ?>
                                        </div>
                                    </td>
                                    <td class="px-6 py-4">
                                        <?php if($u['is_admin']): ?>
                                            <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 uppercase tracking-wider"><i class='bx bx-shield-check'></i> Admin</span>
                                        <?php else: ?>
                                            <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-gray-800 text-gray-400 border border-gray-700 uppercase tracking-wider"><i class='bx bx-user'></i> User</span>
                                        <?php endif; ?>
                                    </td>
                                    <td class="px-6 py-4 text-right">
                                        <div class="flex justify-end items-center gap-2">
                                            
                                            <?php if ((int) $u['id'] !== (int) $_SESSION['user_id']): ?>
                                            <form action="/admin_impersonate.php" method="POST" class="inline-block m-0 p-0" data-confirm="<?= e('Log in as ' . $u['full_name'] . '?') ?>" onsubmit="return confirm(this.dataset.confirm);"><?= oys_csrf_field() ?>
                                                <input type="hidden" name="id" value="<?= (int) $u['id'] ?>">
                                                <button type="submit" class="p-1.5 text-gray-500 hover:text-brand-400 hover:bg-brand-500/10 rounded-md transition-all shadow-sm border border-transparent hover:border-brand-500/20" title="Login as this User">
                                                    <i class='bx bx-log-in-circle text-lg'></i>
                                                </button>
                                            </form>
                                            <?php endif; ?>

                                            <button type="button" onclick="openPwdModal(<?php echo $u['id']; ?>, '<?php echo htmlspecialchars(addslashes($u['full_name'])); ?>')" class="p-1.5 text-gray-500 hover:text-white hover:bg-white/10 rounded-md transition-all shadow-sm border border-transparent hover:border-bordercolor" title="Force Password Reset"><i class='bx bx-key text-lg'></i></button>
                                            
                                            <form action="/admin" method="POST" class="inline-block m-0 p-0" onsubmit="return confirm('Change admin privileges for this user?');"><?= oys_csrf_field() ?>
                                                <input type="hidden" name="toggle_admin_id" value="<?php echo $u['id']; ?>">
                                                <button type="submit" class="p-1.5 text-gray-500 hover:text-emerald-400 hover:bg-emerald-500/10 rounded-md transition-all shadow-sm border border-transparent hover:border-emerald-500/20" title="<?php echo $u['is_admin'] ? 'Remove Admin Rights' : 'Make Admin'; ?>" <?php echo ($u['id'] === $_SESSION['user_id']) ? 'disabled class="p-1.5 text-gray-700 cursor-not-allowed"' : ''; ?>><i class='bx <?php echo $u['is_admin'] ? 'bx-shield-minus' : 'bx-shield-plus'; ?> text-lg'></i></button>
                                            </form>
                                            
                                            <form action="/admin" method="POST" class="inline-block m-0 p-0" onsubmit="return confirm('WARNING: Are you sure you want to completely delete this user and all their data? This cannot be undone.');"><?= oys_csrf_field() ?>
                                                <input type="hidden" name="delete_user_id" value="<?php echo $u['id']; ?>">
                                                <button type="submit" class="p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-500/10 rounded-md transition-all shadow-sm border border-transparent hover:border-red-500/20" title="Delete User" <?php echo ($u['id'] === $_SESSION['user_id']) ? 'disabled class="p-1.5 text-gray-700 cursor-not-allowed"' : ''; ?>><i class='bx bx-trash text-lg'></i></button>
                                            </form>
                                        </div>
                                    </td>
                                </tr>
                                <?php endforeach; ?>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            <div id="tab-newsletter" class="admin-tab-content max-w-4xl mx-auto space-y-8 hidden">
                <div class="bg-gradient-to-r from-brand-500/20 to-purple-500/20 p-1 rounded-xl border border-brand-500/30">
                    <div class="bg-card p-6 rounded-lg flex items-start gap-4">
                        <i class='bx bx-info-circle text-3xl text-brand-400 mt-1'></i>
                        <div>
                            <h2 class="text-lg font-bold text-white mb-1">JSON Email Templates</h2>
                            <p class="text-sm text-gray-400">
                                Place your templates in the <code class="bg-black px-1.5 py-0.5 rounded border border-bordercolor text-brand-300">/email</code> folder. 
                                Files must be in JSON format. Use variables like <code class="text-emerald-400">{full_name}</code> or <code class="text-emerald-400">{subdomain}</code>.
                            </p>
                        </div>
                    </div>
                </div>

                <div class="bg-card border border-bordercolor rounded-xl overflow-hidden shadow-xl p-6">
                    <h2 class="text-base font-semibold text-white mb-6 border-b border-bordercolor pb-4">Compose Campaign</h2>
                    
                    <form action="/admin" method="POST" class="space-y-6">
                        <?= oys_csrf_field() ?>
                        <input type="hidden" name="send_newsletter" value="1">
                        
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div>
                                <label class="block text-sm font-medium text-gray-300 mb-1.5">Select Template (.json)</label>
                                <div class="relative">
                                    <select name="template_file" required class="w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 appearance-none text-sm">
                                        <option value="" disabled selected>-- Choose a template --</option>
                                        <?php foreach($templates as $tpl): ?>
                                            <option value="<?php echo htmlspecialchars($tpl); ?>"><?php echo htmlspecialchars($tpl); ?></option>
                                        <?php endforeach; ?>
                                        <?php if(empty($templates)): ?>
                                            <option value="" disabled>No templates found!</option>
                                        <?php endif; ?>
                                    </select>
                                    <i class='bx bx-chevron-down absolute right-4 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none'></i>
                                </div>
                            </div>
                            
                            <div>
                                <label class="block text-sm font-medium text-gray-300 mb-1.5">Target Audience</label>
                                <div class="relative">
                                    <select name="audience" id="audienceSelect" onchange="toggleSingleEmail()" class="w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 appearance-none text-sm">
                                        <option value="all">All Registered Users (<?php echo $total_users; ?>)</option>
                                        <option value="with_domain">Users with a Domain (<?php echo $total_domains; ?>)</option>
                                        <option value="no_domain">Users without a Domain (<?php echo $total_users - $total_domains; ?>)</option>
                                        <option value="single">Test / Single User</option>
                                    </select>
                                    <i class='bx bx-chevron-down absolute right-4 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none'></i>
                                </div>
                            </div>
                        </div>

                        <div id="singleEmailDiv" class="hidden pt-4 border-t border-bordercolor">
                            <label class="block text-sm font-medium text-gray-300 mb-1.5">User Email Address</label>
                            <input type="email" name="single_email" placeholder="user@example.com" class="w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm">
                            <p class="text-xs text-brand-400 mt-1.5"><i class='bx bx-info-circle'></i> Use this to test your templates before sending to everyone.</p>
                        </div>

                        <div>
                            <label class="block text-sm font-medium text-gray-300 mb-1.5">Email Subject Override (Optional)</label>
                            <input type="text" name="email_subject" placeholder="Leave blank to use subject from JSON template" class="w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm placeholder-gray-600">
                        </div>
                        
                        <div class="pt-4 border-t border-bordercolor flex justify-end">
                            <button type="submit" class="bg-brand-500 hover:bg-brand-600 text-white font-bold py-2.5 px-6 rounded-lg transition-all duration-300 shadow-[0_0_15px_rgba(99,102,241,0.3)] flex items-center gap-2" onclick="return confirm('Are you sure you want to queue this email?');">
                                <i class='bx bx-send'></i> Send Email
                            </button>
                        </div>
                    </form>
                </div>
            </div>

            <div id="tab-mailserver" class="admin-tab-content max-w-4xl mx-auto space-y-8 hidden">
                <div class="bg-card border border-bordercolor rounded-xl overflow-hidden shadow-xl p-6">
                    <div class="flex items-center gap-3 mb-6 border-b border-bordercolor pb-4">
                        <i class='bx bx-server text-2xl text-white'></i>
                        <h2 class="text-base font-semibold text-white">SMTP Mail Server Configuration</h2>
                    </div>
                    
                    <form action="/admin" method="POST" class="space-y-6">
                        <?= oys_csrf_field() ?>
                        <input type="hidden" name="save_smtp" value="1">
                        
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div>
                                <label class="block text-sm font-medium text-gray-300 mb-1.5">SMTP Host</label>
                                <input type="text" name="smtp_host" value="<?php echo htmlspecialchars($smtp_config['host'] ?? ''); ?>" placeholder="smtp.example.com" class="w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm">
                            </div>
                            <div>
                                <label class="block text-sm font-medium text-gray-300 mb-1.5">SMTP Port</label>
                                <input type="text" name="smtp_port" value="<?php echo htmlspecialchars($smtp_config['port'] ?? ''); ?>" placeholder="587 or 465" class="w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm">
                            </div>
                        </div>

                        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div>
                                <label class="block text-sm font-medium text-gray-300 mb-1.5">SMTP Username</label>
                                <input type="text" name="smtp_username" value="<?php echo htmlspecialchars($smtp_config['username'] ?? ''); ?>" placeholder="hello@yourdomain.com" class="w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm">
                            </div>
                            <div>
                                <label class="block text-sm font-medium text-gray-300 mb-1.5">SMTP Password</label>
                                <input type="password" name="smtp_password" value="<?php echo htmlspecialchars($smtp_config['password'] ?? ''); ?>" placeholder="••••••••" class="w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm">
                            </div>
                        </div>

                        <div class="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t border-bordercolor">
                            <div>
                                <label class="block text-sm font-medium text-gray-300 mb-1.5">From Email Address</label>
                                <input type="email" name="from_email" value="<?php echo htmlspecialchars($smtp_config['from_email'] ?? ''); ?>" placeholder="noreply@on-your.site" class="w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm">
                            </div>
                            <div>
                                <label class="block text-sm font-medium text-gray-300 mb-1.5">From Name</label>
                                <input type="text" name="from_name" value="<?php echo htmlspecialchars($smtp_config['from_name'] ?? ''); ?>" placeholder="On Your Site Team" class="w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm">
                            </div>
                        </div>
                        
                        <div class="pt-4 flex justify-end">
                            <button type="submit" class="bg-white text-black hover:bg-gray-200 font-bold py-2.5 px-6 rounded-lg transition-all duration-300 shadow-sm flex items-center gap-2">
                                <i class='bx bx-save'></i> Save Configuration
                            </button>
                        </div>
                    </form>
                </div>
            </div>

        </main>
    </div>

    <div id="pwdModal" class="hidden fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
        <div class="bg-card w-full max-w-md rounded-xl border border-bordercolor shadow-2xl flex flex-col transform scale-100 overflow-hidden">
            <div class="p-4 border-b border-bordercolor flex justify-between items-center bg-inputbg">
                <h3 class="text-white font-semibold text-sm flex items-center gap-2"><i class='bx bx-key text-brand-400'></i> Reset Password</h3>
                <button type="button" onclick="closePwdModal()" class="text-gray-500 hover:text-white transition-colors"><i class='bx bx-x text-2xl'></i></button>
            </div>
            <form action="/admin" method="POST" class="p-6 bg-background">
                <?= oys_csrf_field() ?>
                <input type="hidden" name="reset_password_id" id="resetUserId" value="">
                <p class="text-sm text-gray-400 mb-4">Set a new password for <strong id="resetUserName" class="text-white"></strong>. They will need this new password to log in.</p>
                <div class="mb-6">
                    <label class="block text-sm font-medium text-gray-300 mb-1.5">New Password</label>
                    <input type="text" name="new_password" required placeholder="Type new password..." class="w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm">
                </div>
                <div class="flex justify-end gap-3">
                    <button type="button" onclick="closePwdModal()" class="px-4 py-2 rounded-lg text-sm font-medium text-gray-400 hover:bg-white/5 transition-colors">Cancel</button>
                    <button type="submit" class="bg-brand-500 hover:bg-brand-600 text-white px-5 py-2 rounded-lg text-sm font-bold transition-all shadow-sm">Save Password</button>
                </div>
            </form>
        </div>
    </div>

    <script>
        function switchAdminTab(tabName) {
            document.querySelectorAll('.admin-tab-content').forEach(tab => tab.classList.add('hidden'));
            document.querySelectorAll('.admin-nav-btn').forEach(btn => btn.className = "admin-nav-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-transparent hover:bg-white/5 text-gray-400 hover:text-white font-medium transition-all");
            
            document.getElementById('tab-' + tabName).classList.remove('hidden');
            
            let activeBtn = document.getElementById('nav-' + tabName);
            if(tabName === 'users') {
                activeBtn.className = "admin-nav-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 font-medium transition-all shadow-inner";
                document.getElementById('admin-page-title').innerText = "User Management";
            } else if (tabName === 'newsletter') {
                activeBtn.className = "admin-nav-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-brand-500/30 bg-brand-500/10 text-brand-400 font-medium transition-all shadow-inner";
                document.getElementById('admin-page-title').innerText = "Newsletter Campaigns";
            } else if (tabName === 'mailserver') {
                activeBtn.className = "admin-nav-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-purple-500/30 bg-purple-500/10 text-purple-400 font-medium transition-all shadow-inner";
                document.getElementById('admin-page-title').innerText = "Mail Server Setup";
            }
        }

        function toggleSingleEmail() {
            const select = document.getElementById('audienceSelect');
            const singleDiv = document.getElementById('singleEmailDiv');
            if(select.value === 'single') {
                singleDiv.classList.remove('hidden');
            } else {
                singleDiv.classList.add('hidden');
            }
        }

        function filterTable() {
            let input = document.getElementById("searchInput");
            let filter = input.value.toLowerCase();
            let trs = document.getElementById("userTable").getElementsByTagName("tr");
            for (let i = 1; i < trs.length; i++) {
                let targets = trs[i].getElementsByClassName("search-target");
                let found = false;
                for (let j = 0; j < targets.length; j++) {
                    if (targets[j].innerText.toLowerCase().indexOf(filter) > -1) {
                        found = true;
                        break;
                    }
                }
                trs[i].style.display = found ? "" : "none";
            }
        }

        function openPwdModal(id, name) {
            document.getElementById('resetUserId').value = id;
            document.getElementById('resetUserName').innerText = name;
            document.getElementById('pwdModal').classList.remove('hidden');
        }
        function closePwdModal() { document.getElementById('pwdModal').classList.add('hidden'); }
    </script>
    <style>
        @media (max-width: 639px) { input:not([type=checkbox]):not([type=radio]), select, textarea { font-size: 16px !important; } }
    </style>
    <style>
        .custom-scrollbar::-webkit-scrollbar { width: 5px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #27272a; border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #3f3f46; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(-5px); } to { opacity: 1; transform: translateY(0); } }
        .animate-fade-in { animation: fadeIn 0.2s ease forwards; }
    </style>
</body>
</html>