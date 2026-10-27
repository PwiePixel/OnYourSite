<?php
session_start();
ini_set('display_errors', 1); // Später im Live-Betrieb auf 0 setzen
error_reporting(E_ALL);

require_once 'db.php';
require_once 'security.php'; 
require_once 'mail.php'; 
require_once 'blacklist.php'; 

$host = $_SERVER['HTTP_HOST'];
$base_domain = "on-your.site";
$request_uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);

// Hilfsfunktion, um die echte IP-Adresse des Users zu ermitteln
function getUserIP() {
    if (!empty($_SERVER['HTTP_CLIENT_IP'])) return $_SERVER['HTTP_CLIENT_IP'];
    elseif (!empty($_SERVER['HTTP_X_FORWARDED_FOR'])) return $_SERVER['HTTP_X_FORWARDED_FOR'];
    else return $_SERVER['REMOTE_ADDR'];
}

// --- AJAX KLICK-TRACKING ROUTE ---
if ($request_uri === '/track-click' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $data = json_decode(file_get_contents('php://input'), true);
    if (!empty($data['link_id'])) {
        $stmt = $pdo->prepare("UPDATE user_links SET clicks = clicks + 1 WHERE id = ?");
        $stmt->execute([(int)$data['link_id']]);
        echo json_encode(['status' => 'success']);
    }
    exit;
}

if ($host === $base_domain || $host === "www." . $base_domain) {

    // --- 1. REGISTRIERUNG ---
    if ($request_uri === '/register' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $fullname = trim($_POST['fullname'] ?? '');
        $email = trim($_POST['email'] ?? '');
        $password = $_POST['password'] ?? '';
        $subdomain = trim($_POST['subdomain'] ?? '');

        if (!empty($fullname) && !empty($email) && !empty($password) && !empty($subdomain)) {
            $clean_subdomain = preg_replace('/[^a-zA-Z0-9-]/', '', strtolower($subdomain));
            
            if (is_forbidden_subdomain($clean_subdomain)) {
                $_SESSION['error'] = "The domain '$clean_subdomain' is reserved or not allowed.";
            } else {
                $stmtCheck = $pdo->prepare("SELECT id FROM users WHERE username = ?");
                $stmtCheck->execute([$clean_subdomain]);
                
                if ($stmtCheck->fetch()) {
                    $_SESSION['error'] = "The domain '$clean_subdomain' is already taken!";
                } else {
                    $hashed_password = password_hash($password, PASSWORD_DEFAULT);
                    $enc_ip = encryptData(getUserIP()); 
                    
                    try {
                        $stmt = $pdo->prepare("INSERT INTO users (email, password, full_name, username, layout_type, last_ip) VALUES (?, ?, ?, ?, 'link-tree', ?)");
                        $stmt->execute([$email, $hashed_password, $fullname, $clean_subdomain, $enc_ip]);
                        
                        $_SESSION['user_id'] = $pdo->lastInsertId();
                        $_SESSION['success'] = "Welcome! Your domain is ready.";
                        
                        sendCustomEmail($email, 'register', ['full_name' => $fullname, 'subdomain' => $clean_subdomain]);
                        header("Location: /dashboard");
                        exit;
                    } catch(PDOException $e) {
                        $_SESSION['error'] = "This email is already registered!";
                    }
                }
            }
        } else {
            $_SESSION['error'] = "Please fill in all fields!";
        }
    }

    // --- 2. LOGIN ---
    if ($request_uri === '/login' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $email = trim($_POST['email'] ?? '');
        $password = $_POST['password'] ?? '';
        $stmt = $pdo->prepare("SELECT * FROM users WHERE email = ?");
        $stmt->execute([$email]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);

        if ($user && password_verify($password, $user['password'])) {
            $_SESSION['user_id'] = $user['id'];
            
            $enc_ip = encryptData(getUserIP());
            $pdo->prepare("UPDATE users SET last_ip = ? WHERE id = ?")->execute([$enc_ip, $user['id']]);
            
            header("Location: /dashboard");
            exit;
        } else {
            $_SESSION['error'] = "Incorrect email or password.";
        }
    }

    // --- 3. LOGOUT ---
    if ($request_uri === '/logout') {
        session_destroy();
        header("Location: /");
        exit;
    }

    // --- 4. DASHBOARD SPEICHERN LOGIK ---
    if ($request_uri === '/dashboard' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        if (!isset($_SESSION['user_id'])) { header("Location: /login"); exit; }
        
        $user_id = $_SESSION['user_id'];
        
        if (isset($_POST['delete_booking_id'])) {
            $pdo->prepare("DELETE FROM user_bookings WHERE id = ? AND user_id = ?")->execute([$_POST['delete_booking_id'], $user_id]);
            $_SESSION['success'] = "Booking deleted.";
            header("Location: /dashboard");
            exit;
        }

        if (isset($_POST['delete_cert_id'])) {
            $pdo->prepare("DELETE FROM user_certificates WHERE id = ? AND user_id = ?")->execute([$_POST['delete_cert_id'], $user_id]);
            $_SESSION['success'] = "Certificate removed.";
            header("Location: /dashboard");
            exit;
        }

        if (isset($_POST['add_certificate'])) {
            $title = trim($_POST['cert_title'] ?? '');
            $issuer = trim($_POST['cert_issuer'] ?? '');
            $date = trim($_POST['cert_date'] ?? '');
            $url = trim($_POST['cert_url'] ?? '');
            
            if (!empty($title) && !empty($issuer) && !empty($date)) {
                $cert_id = 'OYS-' . strtoupper(substr(md5(uniqid((string)rand(), true)), 0, 8));
                $stmt = $pdo->prepare("INSERT INTO user_certificates (user_id, cert_id, title, issuer, issue_date, credential_url) VALUES (?, ?, ?, ?, ?, ?)");
                $stmt->execute([$user_id, $cert_id, $title, $issuer, $date, $url]);
                $_SESSION['success'] = "Certificate successfully added!";
            } else {
                $_SESSION['error'] = "Please fill in all required certificate fields.";
            }
            header("Location: /dashboard");
            exit;
        }
        
        $stmtCurrent = $pdo->prepare("SELECT * FROM users WHERE id = ?");
        $stmtCurrent->execute([$user_id]);
        $current_user = $stmtCurrent->fetch(PDO::FETCH_ASSOC);
        
        $update_action = $_POST['update_action'] ?? 'general';

        if ($update_action === 'general') {
            
            $full_name = trim($_POST['full_name'] ?? '');
            $bio = trim($_POST['bio'] ?? '');
            $profession = trim($_POST['profession'] ?? '');
            $detailed_bio = trim($_POST['detailed_bio'] ?? '');
            
            $booking_url = encryptData(trim($_POST['booking_url'] ?? '')); 
            $discord_id = encryptData(trim($_POST['discord_id'] ?? ''));
            
            $theme = $_POST['theme'] ?? 'deep-dark';
            $custom_css = trim($_POST['custom_css'] ?? '');
            
            $seo_title = trim($_POST['seo_title'] ?? '');
            $seo_description = trim($_POST['seo_description'] ?? '');
            $seo_keywords = trim($_POST['seo_keywords'] ?? '');
            $hide_branding = isset($_POST['hide_branding']) ? 1 : 0;
            
            $update_sql_parts = ["full_name = ?", "bio = ?", "profession = ?", "detailed_bio = ?", "booking_url = ?", "theme = ?", "custom_css = ?", "discord_id = ?", "seo_title = ?", "seo_description = ?", "seo_keywords = ?", "hide_branding = ?"];
            $update_params = [$full_name, $bio, $profession, $detailed_bio, $booking_url, $theme, $custom_css, $discord_id, $seo_title, $seo_description, $seo_keywords, $hide_branding];

            if (!empty($_POST['layout_type']) && $_POST['layout_type'] !== $current_user['layout_type']) {
                $update_sql_parts[] = "layout_type = ?";
                $update_params[] = $_POST['layout_type'];
                $update_sql_parts[] = "last_layout_change = CURRENT_TIMESTAMP";
            }

            // --- SMARTER FILE UPLOAD MIT FEHLER-ERKENNUNG ---
            $upload_dir = __DIR__ . '/static/uploads/';
            if (!file_exists($upload_dir)) { 
                @mkdir($upload_dir, 0777, true); 
            }
            
            // Alte Dateien löschen
            if (isset($_POST['delete_bg_image']) && $_POST['delete_bg_image'] == '1') {
                if (!empty($current_user['bg_image']) && file_exists($upload_dir . $current_user['bg_image'])) { unlink($upload_dir . $current_user['bg_image']); }
                $update_sql_parts[] = "bg_image = NULL";
            }
            
            if (isset($_POST['delete_cv_file']) && $_POST['delete_cv_file'] == '1') {
                if (!empty($current_user['cv_file']) && file_exists($upload_dir . $current_user['cv_file'])) { unlink($upload_dir . $current_user['cv_file']); }
                $update_sql_parts[] = "cv_file = NULL";
            }
            
            // Loop für sauberen Upload + genaue Fehlermeldungen
            $file_uploads = [
                'profile_image' => ['prefix' => 'profile', 'exts' => ['jpg', 'jpeg', 'png', 'gif', 'webp'], 'col' => 'profile_image'],
                'bg_image'      => ['prefix' => 'bg',      'exts' => ['jpg', 'jpeg', 'png', 'gif', 'webp'], 'col' => 'bg_image'],
                'cv_file'       => ['prefix' => 'file',    'exts' => ['pdf', 'vcf'],                        'col' => 'cv_file']
            ];

            foreach ($file_uploads as $input_name => $cfg) {
                if (isset($_FILES[$input_name]) && $_FILES[$input_name]['error'] !== UPLOAD_ERR_NO_FILE) {
                    if ($_FILES[$input_name]['error'] === UPLOAD_ERR_OK) {
                        $ext = strtolower(pathinfo($_FILES[$input_name]['name'], PATHINFO_EXTENSION));
                        if (in_array($ext, $cfg['exts'])) {
                            $new_filename = $cfg['prefix'] . '_' . $user_id . '_' . time() . '.' . $ext;
                            if (move_uploaded_file($_FILES[$input_name]['tmp_name'], $upload_dir . $new_filename)) {
                                $update_sql_parts[] = "{$cfg['col']} = ?";
                                $update_params[] = $new_filename;
                            } else {
                                $_SESSION['error'] = "Server Error: Schreibrechte fehlen! Der Ordner static/uploads/ benötigt Schreibrechte (755 oder 777).";
                            }
                        } else {
                            $_SESSION['error'] = "Upload fehlgeschlagen: Das Dateiformat für '{$input_name}' ist nicht erlaubt!";
                        }
                    } else {
                        // Fehlermeldung generieren, wenn Datei vom PHP-Server abgelehnt wird
                        $errCode = $_FILES[$input_name]['error'];
                        if ($errCode == 1 || $errCode == 2) {
                            $_SESSION['error'] = "Upload fehlgeschlagen: Das Bild ist zu groß! Bitte verringere die Dateigröße oder erhöhe 'upload_max_filesize' im Hosting/Plesk.";
                        } else {
                            $_SESSION['error'] = "Upload fehlgeschlagen mit Fehlercode: " . $errCode;
                        }
                    }
                }
            }
            // ------------------------------------------------

            $requested_subdomain = trim($_POST['subdomain'] ?? '');
            if (!empty($requested_subdomain) && $requested_subdomain !== $current_user['username']) {
                $clean_subdomain = preg_replace('/[^a-zA-Z0-9-]/', '', strtolower($requested_subdomain));
                
                if (is_forbidden_subdomain($clean_subdomain)) {
                    $_SESSION['error'] = "The domain '$clean_subdomain' is reserved or not allowed.";
                } else {
                    $last_change_time = strtotime($current_user['last_subdomain_change'] ?? '-31 days');
                    $days_since_change = floor((time() - $last_change_time) / (60 * 60 * 24));
                    
                    if ($days_since_change < 30) {
                        $_SESSION['error'] = "You can only change your subdomain every 30 days.";
                    } else {
                        $stmtCheck = $pdo->prepare("SELECT id FROM users WHERE username = ? AND id != ?");
                        $stmtCheck->execute([$clean_subdomain, $user_id]);
                        if ($stmtCheck->fetch()) {
                            $_SESSION['error'] = "The domain '$clean_subdomain' is already taken!";
                        } else {
                            $update_sql_parts[] = "username = ?";
                            $update_params[] = $clean_subdomain;
                            $update_sql_parts[] = "last_subdomain_change = CURRENT_TIMESTAMP";
                        }
                    }
                }
            }

            $update_params[] = $user_id; 
            $sql = "UPDATE users SET " . implode(', ', $update_sql_parts) . " WHERE id = ?";
            $pdo->prepare($sql)->execute($update_params);
            
            $existing_links = [];
            $stmtGetLinks = $pdo->prepare("SELECT id, clicks FROM user_links WHERE user_id = ?");
            $stmtGetLinks->execute([$user_id]);
            foreach($stmtGetLinks->fetchAll() as $l) {
                $existing_links[$l['id']] = $l['clicks'];
            }
            
            $pdo->prepare("DELETE FROM user_links WHERE user_id = ?")->execute([$user_id]);
            
            if (!empty($_POST['link_titles']) && is_array($_POST['link_titles'])) {
                $stmtLink = $pdo->prepare("INSERT INTO user_links (id, user_id, title, url, icon_class, sort_order, clicks) VALUES (?, ?, ?, ?, ?, ?, ?)");
                $stmtNewLink = $pdo->prepare("INSERT INTO user_links (user_id, title, url, icon_class, sort_order, clicks) VALUES (?, ?, ?, ?, ?, 0)");
                
                foreach ($_POST['link_titles'] as $index => $title) {
                    $url = $_POST['link_urls'][$index] ?? '';
                    $icon = $_POST['link_icons'][$index] ?? '';
                    $link_id = $_POST['link_ids'][$index] ?? ''; 
                    
                    if (!empty(trim($title)) && !empty(trim($url))) {
                        if (!empty($link_id) && isset($existing_links[$link_id])) {
                            $stmtLink->execute([$link_id, $user_id, trim($title), trim($url), trim($icon), $index, $existing_links[$link_id]]);
                        } else {
                            $stmtNewLink->execute([$user_id, trim($title), trim($url), trim($icon), $index]);
                        }
                    }
                }
            }
            
            if (!isset($_SESSION['error'])) { $_SESSION['success'] = "Changes saved successfully!"; }

        } elseif ($update_action === 'email') {
            $new_email = trim($_POST['new_email'] ?? '');
            $current_pwd = $_POST['current_password_email'] ?? '';
            
            if (empty($current_pwd) || !password_verify($current_pwd, $current_user['password'])) {
                $_SESSION['error'] = "Incorrect current password.";
            } elseif ($new_email === $current_user['email']) {
                $_SESSION['error'] = "New email is the same as the current email.";
            } else {
                $stmtCheckEmail = $pdo->prepare("SELECT id FROM users WHERE email = ? AND id != ?");
                $stmtCheckEmail->execute([$new_email, $user_id]);
                if ($stmtCheckEmail->fetch()) {
                    $_SESSION['error'] = "This email is already in use.";
                } else {
                    $pdo->prepare("UPDATE users SET email = ? WHERE id = ?")->execute([$new_email, $user_id]);
                    $_SESSION['success'] = "Email address successfully updated!";
                }
            }

        } elseif ($update_action === 'password') {
            $new_pwd = $_POST['new_password'] ?? '';
            $confirm_pwd = $_POST['confirm_new_password'] ?? '';
            $current_pwd = $_POST['current_password_pwd'] ?? '';
            
            if ($new_pwd !== $confirm_pwd) {
                $_SESSION['error'] = "New passwords do not match!";
            } elseif (empty($current_pwd) || !password_verify($current_pwd, $current_user['password'])) {
                $_SESSION['error'] = "Incorrect current password.";
            } else {
                $hashed = password_hash($new_pwd, PASSWORD_DEFAULT);
                $pdo->prepare("UPDATE users SET password = ? WHERE id = ?")->execute([$hashed, $user_id]);
                $_SESSION['success'] = "Password successfully changed!";
            }
        }
        
        header("Location: /dashboard");
        exit;
    }

    // --- 5. SEITEN ROUTING ---
    if ($request_uri === '/login') { require_once 'views/login.php'; exit; } 
    elseif ($request_uri === '/register') { require_once 'views/register.php'; exit; }
    elseif ($request_uri === '/challenge') { require_once 'views/challenge.php'; exit; } 
    elseif ($request_uri === '/imprint') { require_once 'views/imprint.php'; exit; } 
    elseif ($request_uri === '/privacy') { require_once 'views/privacy.php'; exit; } 
    elseif ($request_uri === '/terms') { require_once 'views/terms.php'; exit; } 
    elseif ($request_uri === '/dashboard') {
        if (!isset($_SESSION['user_id'])) { header("Location: /login"); exit; }
        
        $stmt = $pdo->prepare("SELECT * FROM users WHERE id = ?");
        $stmt->execute([$_SESSION['user_id']]);
        $user_data = $stmt->fetch(PDO::FETCH_ASSOC);
        
        $user_data['discord_id'] = decryptData($user_data['discord_id'] ?? '');
        $user_data['booking_url'] = decryptData($user_data['booking_url'] ?? '');
        
        $stmtLinks = $pdo->prepare("SELECT * FROM user_links WHERE user_id = ? ORDER BY sort_order ASC");
        $stmtLinks->execute([$_SESSION['user_id']]);
        $user_links = $stmtLinks->fetchAll(PDO::FETCH_ASSOC);
        
        $stmtBook = $pdo->prepare("SELECT * FROM user_bookings WHERE user_id = ? ORDER BY booking_date ASC, booking_time ASC");
        $stmtBook->execute([$_SESSION['user_id']]);
        $user_bookings = $stmtBook->fetchAll(PDO::FETCH_ASSOC);
        foreach ($user_bookings as &$book) {
            $book['guest_name'] = decryptData($book['guest_name'] ?? '');
            $book['guest_email'] = decryptData($book['guest_email'] ?? '');
        }
        
        $stmtCerts = $pdo->prepare("SELECT * FROM user_certificates WHERE user_id = ? ORDER BY issue_date DESC");
        $stmtCerts->execute([$_SESSION['user_id']]);
        $user_certificates = $stmtCerts->fetchAll(PDO::FETCH_ASSOC);
        
        require_once 'views/dashboard.php';
        exit;
    }
    elseif ($request_uri === '/admin') {
        if (!isset($_SESSION['user_id'])) { header("Location: /login"); exit; }
        $stmt = $pdo->prepare("SELECT * FROM users WHERE id = ?");
        $stmt->execute([$_SESSION['user_id']]);
        $user_data = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$user_data['is_admin']) { header("Location: /dashboard"); exit; } 
        require_once 'views/admin.php';
        exit;
    }
    
    require_once 'views/landingpage.php';
    exit;
}

// --- 6. SUBDOMAIN ROUTING ---
$subdomain = str_replace("." . $base_domain, "", $host);
$stmt = $pdo->prepare("SELECT * FROM users WHERE username = :username LIMIT 1");
$stmt->execute(['username' => $subdomain]);
$user_data = $stmt->fetch(PDO::FETCH_ASSOC);

if ($user_data) {
    $user_data['discord_id'] = decryptData($user_data['discord_id'] ?? '');
    $user_data['booking_url'] = decryptData($user_data['booking_url'] ?? '');

    if ($request_uri === '/kalender') {
        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
            $g_name = trim($_POST['guest_name'] ?? '');
            $g_email = trim($_POST['guest_email'] ?? '');
            $b_date = trim($_POST['booking_date'] ?? '');
            $b_time = trim($_POST['booking_time'] ?? '');
            
            if (!empty($g_name) && !empty($g_email) && !empty($b_date) && !empty($b_time)) {
                $enc_name = encryptData($g_name);
                $enc_email = encryptData($g_email);
                
                $stmt = $pdo->prepare("INSERT INTO user_bookings (user_id, guest_name, guest_email, booking_date, booking_time) VALUES (?, ?, ?, ?, ?)");
                $stmt->execute([$user_data['id'], $enc_name, $enc_email, $b_date, $b_time]);
                $_SESSION['booking_success'] = "Dein Termin wurde erfolgreich angefragt!";
                
                $mail_vars = [
                    'full_name' => $user_data['full_name'],
                    'guest_name' => $g_name,
                    'guest_email' => $g_email,
                    'booking_date' => $b_date,
                    'booking_time' => $b_time
                ];
                sendCustomEmail($user_data['email'], 'new_booking', $mail_vars, "Neuer Termin: {$g_name} am {$b_date}");
                
            } else {
                $_SESSION['booking_error'] = "Bitte fülle alle Felder aus.";
            }
            header("Location: /kalender");
            exit;
        }
        require_once 'views/kalender.php';
        exit;
    }

    $pdo->prepare("UPDATE users SET profile_views = profile_views + 1 WHERE id = ?")->execute([$user_data['id']]);

    $stmtLinks = $pdo->prepare("SELECT * FROM user_links WHERE user_id = ? ORDER BY sort_order ASC");
    $stmtLinks->execute([$user_data['id']]);
    $user_links = $stmtLinks->fetchAll(PDO::FETCH_ASSOC);
    
    $stmtCerts = $pdo->prepare("SELECT * FROM user_certificates WHERE user_id = ? ORDER BY issue_date DESC");
    $stmtCerts->execute([$user_data['id']]);
    $user_certificates = $stmtCerts->fetchAll(PDO::FETCH_ASSOC);
    
    require_once 'views/user_profile.php';
} else {
    require_once 'views/404.php';
}
?>