<?php
// API Headers
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *'); // Falls gewünscht, anpassen z.B. auf 'https://on-your.site'

// Fehlerunterdrückung für sauberen JSON Output
ini_set('display_errors', 0);
error_reporting(0);

require_once 'db.php';

// Checken ob ein Username (Subdomain) angefragt wurde
$username = $_GET['user'] ?? '';

if (empty($username)) {
    echo json_encode([
        'status' => 'error',
        'message' => 'No user parameter provided.'
    ]);
    exit;
}

try {
    // 1. User Daten holen
    $stmt = $pdo->prepare("SELECT id, full_name, username, bio, profession, detailed_bio, profile_image, bg_image, theme, layout_type, booking_url, cv_file, discord_id, hide_branding FROM users WHERE username = ?");
    $stmt->execute([$username]);
    $user_data = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$user_data) {
        echo json_encode([
            'status' => 'error',
            'message' => 'User not found.'
        ]);
        exit;
    }

    // 2. Links des Users holen
    $stmtLinks = $pdo->prepare("SELECT id, title, url, icon_class, sort_order FROM user_links WHERE user_id = ? ORDER BY sort_order ASC");
    $stmtLinks->execute([$user_data['id']]);
    $user_links = $stmtLinks->fetchAll(PDO::FETCH_ASSOC);

    // 3. Theme Logik (analog zur user_profile.php) umwandeln für die API
    $layout = $user_data['layout_type'] ?: 'link-tree';
    $theme = $user_data['theme'] ?: 'deep-dark';
    
    // Fallback Styling Infos, falls das Frontend diese direkt nutzen will
    $styleData = [
        'bgClass' => 'bg-[#09090b]',
        'textClass' => 'text-white',
        'isDark' => true
    ];

    if ($theme === 'midnight') { $styleData['bgClass'] = "bg-gradient-to-br from-indigo-900 via-purple-900 to-black"; }
    if ($theme === 'forest') { $styleData['bgClass'] = "bg-gradient-to-br from-emerald-900 to-teal-900"; }
    if ($theme === 'sunset') { $styleData['bgClass'] = "bg-gradient-to-br from-rose-900 to-orange-900"; }
    if ($theme === 'ocean') { $styleData['bgClass'] = "bg-gradient-to-t from-blue-900 to-cyan-900"; }
    if ($theme === 'cherry') { $styleData['bgClass'] = "bg-gradient-to-r from-pink-900 to-rose-900"; }
    
    if ($theme === 'glass') { 
        $styleData['bgClass'] = "bg-gradient-to-tr from-gray-100 to-gray-300"; 
        $styleData['textClass'] = "text-gray-900"; 
        $styleData['isDark'] = false;
    }
    if ($theme === 'minimal') { 
        $styleData['bgClass'] = "bg-gray-50"; 
        $styleData['textClass'] = "text-black"; 
        $styleData['isDark'] = false;
    }
    if ($theme === 'cyberpunk') { 
        $styleData['bgClass'] = "bg-[#fcee0a]"; 
        $styleData['textClass'] = "text-black";
        $styleData['isDark'] = false;
    }
    if ($theme === 'hacker') { 
        $styleData['bgClass'] = "bg-black"; 
        $styleData['textClass'] = "text-green-500"; 
    }

    // 4. Pfade für Bilder generieren
    $profile_img_url = !empty($user_data['profile_image']) ? 'https://on-your.site/static/uploads/' . $user_data['profile_image'] : null;
    $bg_img_url = !empty($user_data['bg_image']) ? 'https://on-your.site/static/uploads/' . $user_data['bg_image'] : null;
    $cv_file_url = !empty($user_data['cv_file']) ? 'https://on-your.site/static/uploads/' . $user_data['cv_file'] : null;

    // 5. JSON Response zusammenbauen
    $response = [
        'status' => 'success',
        'data' => [
            'profile' => [
                'full_name' => $user_data['full_name'],
                'username' => $user_data['username'],
                'url' => 'https://' . $user_data['username'] . '.on-your.site',
                'bio' => $user_data['bio'],
                'profession' => $user_data['profession'],
                'detailed_bio' => $user_data['detailed_bio'],
                'discord_id' => $user_data['discord_id'],
                'booking_url' => $user_data['booking_url'] ?: 'https://' . $user_data['username'] . '.on-your.site/kalender',
                'hide_branding' => (bool)$user_data['hide_branding']
            ],
            'media' => [
                'profile_image' => $profile_img_url,
                'background_image' => $bg_img_url,
                'cv_file' => $cv_file_url,
            ],
            'design' => [
                'layout' => $layout,
                'theme' => $theme,
                'styling' => $styleData
            ],
            'links' => $user_links
        ]
    ];

    echo json_encode($response, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);

} catch (PDOException $e) {
    // Error Handling
    echo json_encode([
        'status' => 'error',
        'message' => 'Database error occurred.'
    ]);
}
?>