<?php
// Datenbank-Schema und automatische Migration.
// Läuft beim ersten Aufruf nach dem Update einmalig durch. Alte Tabellen werden NICHT gelöscht.

const OYS_SCHEMA_VERSION = 1;

function oys_schema_version(PDO $pdo): int
{
    try {
        $stmt = $pdo->query("SELECT meta_value FROM oys_meta WHERE meta_key = 'schema_version'");
        $value = $stmt ? $stmt->fetchColumn() : false;
        return $value === false ? 0 : (int) $value;
    } catch (PDOException $e) {
        return 0;
    }
}

function oys_ensure_schema(PDO $pdo): void
{
    if (oys_schema_version($pdo) >= OYS_SCHEMA_VERSION) {
        return;
    }

    // Nur ein Prozess migriert gleichzeitig
    $pdo->query("SELECT GET_LOCK('oys_migrate', 60)");
    try {
        if (oys_schema_version($pdo) >= OYS_SCHEMA_VERSION) {
            return;
        }
        oys_create_tables($pdo);
        oys_migrate_legacy_users($pdo);
        $pdo->prepare("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('schema_version', ?)")
            ->execute([(string) OYS_SCHEMA_VERSION]);
    } finally {
        $pdo->query("SELECT RELEASE_LOCK('oys_migrate')");
    }
}

function oys_create_tables(PDO $pdo): void
{
    $opts = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

    $pdo->exec("CREATE TABLE IF NOT EXISTS oys_meta (
        meta_key VARCHAR(64) NOT NULL PRIMARY KEY,
        meta_value TEXT NULL
    ) $opts");

    // Bestehende Tabellen (nur für Neuinstallationen – existieren sie schon, passiert nichts)
    $pdo->exec("CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        password VARCHAR(255) NOT NULL,
        full_name VARCHAR(255) NULL,
        username VARCHAR(100) NULL,
        layout_type VARCHAR(50) NULL,
        last_ip TEXT NULL,
        bio TEXT NULL,
        profession VARCHAR(255) NULL,
        detailed_bio TEXT NULL,
        booking_url TEXT NULL,
        theme VARCHAR(50) NULL,
        custom_css TEXT NULL,
        discord_id TEXT NULL,
        seo_title VARCHAR(255) NULL,
        seo_description TEXT NULL,
        seo_keywords TEXT NULL,
        hide_branding TINYINT(1) NOT NULL DEFAULT 0,
        last_layout_change DATETIME NULL,
        bg_image VARCHAR(255) NULL,
        cv_file VARCHAR(255) NULL,
        profile_image VARCHAR(255) NULL,
        last_subdomain_change DATETIME NULL,
        profile_views INT NOT NULL DEFAULT 0,
        is_admin TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_email (email),
        UNIQUE KEY uq_username (username)
    ) $opts");

    $pdo->exec("CREATE TABLE IF NOT EXISTS user_links (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        title VARCHAR(255) NULL,
        url TEXT NULL,
        icon_class VARCHAR(100) NULL,
        sort_order INT NOT NULL DEFAULT 0,
        clicks INT NOT NULL DEFAULT 0,
        KEY idx_user (user_id)
    ) $opts");

    $pdo->exec("CREATE TABLE IF NOT EXISTS user_bookings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        guest_name TEXT NULL,
        guest_email TEXT NULL,
        booking_date DATE NULL,
        booking_time VARCHAR(10) NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_user (user_id)
    ) $opts");

    $pdo->exec("CREATE TABLE IF NOT EXISTS user_certificates (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        cert_id VARCHAR(50) NULL,
        title VARCHAR(255) NULL,
        issuer VARCHAR(255) NULL,
        issue_date DATE NULL,
        credential_url TEXT NULL,
        KEY idx_user (user_id)
    ) $opts");

    // Neue Tabellen
    $pdo->exec("CREATE TABLE IF NOT EXISTS pages (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        slug VARCHAR(63) NOT NULL,
        position TINYINT UNSIGNED NOT NULL DEFAULT 0,
        title VARCHAR(120) NOT NULL DEFAULT '',
        subtitle VARCHAR(160) NOT NULL DEFAULT '',
        bio TEXT NULL,
        avatar VARCHAR(255) NULL,
        bg_image VARCHAR(255) NULL,
        theme VARCHAR(40) NOT NULL DEFAULT 'deep-dark',
        layout VARCHAR(40) NOT NULL DEFAULT 'buttons',
        address_mode VARCHAR(12) NOT NULL DEFAULT 'subdomain',
        settings MEDIUMTEXT NULL,
        views INT UNSIGNED NOT NULL DEFAULT 0,
        slug_changed_at DATETIME NULL,
        created_at DATETIME NULL,
        updated_at DATETIME NULL,
        UNIQUE KEY uq_slug (slug),
        KEY idx_user (user_id)
    ) $opts");

    $pdo->exec("CREATE TABLE IF NOT EXISTS page_blocks (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        page_id INT UNSIGNED NOT NULL,
        type VARCHAR(24) NOT NULL,
        position SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        is_visible TINYINT(1) NOT NULL DEFAULT 1,
        data MEDIUMTEXT NULL,
        schedule TEXT NULL,
        protection VARCHAR(12) NOT NULL DEFAULT 'none',
        password_hash VARCHAR(255) NULL,
        effect VARCHAR(12) NOT NULL DEFAULT 'none',
        clicks INT UNSIGNED NOT NULL DEFAULT 0,
        legacy_link_id INT NULL,
        created_at DATETIME NULL,
        KEY idx_page (page_id, position),
        KEY idx_legacy (legacy_link_id)
    ) $opts");

    // Statistik ohne Cookies und ohne IP-Adressen: nur Zähler pro Tag
    $pdo->exec("CREATE TABLE IF NOT EXISTS stats_daily (
        page_id INT UNSIGNED NOT NULL,
        day DATE NOT NULL,
        views INT UNSIGNED NOT NULL DEFAULT 0,
        clicks INT UNSIGNED NOT NULL DEFAULT 0,
        PRIMARY KEY (page_id, day)
    ) $opts");

    // item = Plattform bei Social-Icons (z. B. "instagram"), sonst leer
    $pdo->exec("CREATE TABLE IF NOT EXISTS block_clicks_daily (
        block_id INT UNSIGNED NOT NULL,
        item VARCHAR(24) NOT NULL DEFAULT '',
        day DATE NOT NULL,
        page_id INT UNSIGNED NOT NULL,
        clicks INT UNSIGNED NOT NULL DEFAULT 0,
        PRIMARY KEY (block_id, item, day),
        KEY idx_page_day (page_id, day)
    ) $opts");

    $pdo->exec("CREATE TABLE IF NOT EXISTS messages (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        page_id INT UNSIGNED NOT NULL,
        user_id INT NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        message TEXT NOT NULL,
        is_read TINYINT(1) NOT NULL DEFAULT 0,
        created_at DATETIME NULL,
        KEY idx_user (user_id, is_read),
        KEY idx_page (page_id)
    ) $opts");

    $pdo->exec("CREATE TABLE IF NOT EXISTS notifications (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        type VARCHAR(24) NOT NULL,
        title VARCHAR(190) NOT NULL,
        body VARCHAR(255) NULL,
        link VARCHAR(255) NULL,
        is_read TINYINT(1) NOT NULL DEFAULT 0,
        created_at DATETIME NULL,
        KEY idx_user (user_id, is_read)
    ) $opts");

    $pdo->exec("CREATE TABLE IF NOT EXISTS rate_limits (
        rl_key VARCHAR(100) NOT NULL PRIMARY KEY,
        hits INT UNSIGNED NOT NULL DEFAULT 0,
        window_start DATETIME NOT NULL
    ) $opts");

    // Neue Spalten in users
    oys_add_column($pdo, 'users', 'weekly_report', 'TINYINT(1) NOT NULL DEFAULT 0');
    oys_add_column($pdo, 'users', 'weekly_report_sent_at', 'DATETIME NULL');
}

function oys_add_column(PDO $pdo, string $table, string $column, string $definition): void
{
    $stmt = $pdo->prepare("SHOW COLUMNS FROM `$table` LIKE ?");
    $stmt->execute([$column]);
    if (!$stmt->fetch()) {
        $pdo->exec("ALTER TABLE `$table` ADD COLUMN `$column` $definition");
    }
}

// Übernimmt alte Profile (users + user_links) als erste Seite mit Blöcken.
function oys_migrate_legacy_users(PDO $pdo): void
{
    // Alte Installationen haben evtl. nicht alle Spalten – daher defensiv lesen
    $col = fn(array $row, string $name, $default = null) => array_key_exists($name, $row) ? $row[$name] : $default;

    $users = $pdo->query("SELECT * FROM users WHERE username IS NOT NULL AND username <> ''")->fetchAll();
    $hasPage = $pdo->prepare('SELECT id FROM pages WHERE user_id = ? LIMIT 1');
    $slugTaken = $pdo->prepare('SELECT id FROM pages WHERE slug = ? LIMIT 1');
    $insertPage = $pdo->prepare('INSERT INTO pages (user_id, slug, position, title, subtitle, bio, avatar, bg_image, theme, layout, address_mode, settings, views, slug_changed_at, created_at, updated_at)
        VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, \'subdomain\', ?, ?, ?, ?, ?)');
    $insertBlock = $pdo->prepare('INSERT INTO page_blocks (page_id, type, position, is_visible, data, clicks, legacy_link_id, created_at)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?)');
    $linksStmt = $pdo->prepare('SELECT * FROM user_links WHERE user_id = ? ORDER BY sort_order ASC, id ASC');

    $layoutMap = [
        'link-tree' => 'buttons',
        'about-me' => 'cards',
        'bento-grid' => 'bento',
        'minimal-cv' => 'magazine',
    ];
    $now = date('Y-m-d H:i:s');

    foreach ($users as $user) {
        $hasPage->execute([$user['id']]);
        if ($hasPage->fetch()) {
            continue;
        }
        $slug = strtolower((string) $user['username']);
        $slugTaken->execute([$slug]);
        if ($slugTaken->fetch()) {
            continue;
        }

        $pdo->beginTransaction();
        try {
            $settings = [
                'seo' => [
                    'title' => (string) $col($user, 'seo_title', ''),
                    'description' => (string) $col($user, 'seo_description', ''),
                    'keywords' => (string) $col($user, 'seo_keywords', ''),
                ],
                'custom_css' => oys_clean_css((string) $col($user, 'custom_css', '')),
                'hide_branding' => (bool) $col($user, 'hide_branding', 0),
            ];
            $theme = (string) ($col($user, 'theme') ?: 'deep-dark');
            $layout = $layoutMap[(string) $col($user, 'layout_type', '')] ?? 'buttons';
            $created = $col($user, 'created_at') ?: $now;

            $insertPage->execute([
                $user['id'],
                $slug,
                mb_substr((string) $col($user, 'full_name', ''), 0, 120),
                mb_substr((string) $col($user, 'profession', ''), 0, 160),
                (string) $col($user, 'bio', ''),
                $col($user, 'profile_image') ?: null,
                $col($user, 'bg_image') ?: null,
                $theme,
                $layout,
                json_encode($settings, JSON_UNESCAPED_UNICODE),
                max(0, (int) $col($user, 'profile_views', 0)),
                $col($user, 'last_subdomain_change') ?: null,
                $created,
                $now,
            ]);
            $pageId = (int) $pdo->lastInsertId();
            $pos = 0;
            $add = function (string $type, array $data, int $clicks = 0, ?int $legacyId = null) use (&$pos, $insertBlock, $pageId, $now) {
                $insertBlock->execute([$pageId, $type, $pos++, json_encode($data, JSON_UNESCAPED_UNICODE), $clicks, $legacyId, $now]);
            };

            // Termin-Button und Datei standen früher über den Links
            $booking = function_exists('decryptData') ? decryptData((string) $col($user, 'booking_url', '')) : (string) $col($user, 'booking_url', '');
            if ($booking !== '' && strpos($booking, 'ENC:') !== 0) {
                $add('booking', ['title' => 'Book a meeting', 'url' => $booking]);
            }
            $cv = (string) $col($user, 'cv_file', '');
            if ($cv !== '') {
                $ext = strtolower(pathinfo($cv, PATHINFO_EXTENSION));
                $title = $ext === 'pdf' ? 'Download CV' : ($ext === 'vcf' ? 'Save contact' : 'Download file');
                $add('file', ['title' => $title, 'src' => $cv]);
            }

            $about = trim((string) $col($user, 'detailed_bio', ''));
            $aboutAfterLinks = ($col($user, 'layout_type') === 'bento-grid');
            if ($about !== '' && !$aboutAfterLinks) {
                $add('heading', ['text' => 'About me', 'size' => 'm', 'align' => 'center']);
                $add('text', ['text' => $about, 'align' => 'center']);
            }

            $linksStmt->execute([$user['id']]);
            foreach ($linksStmt->fetchAll() as $link) {
                if (trim((string) $link['title']) === '' && trim((string) $link['url']) === '') {
                    continue;
                }
                $add('link', [
                    'title' => mb_substr((string) $link['title'], 0, 120),
                    'url' => (string) $link['url'],
                    'icon' => (string) ($link['icon_class'] ?? ''),
                ], max(0, (int) $link['clicks']), (int) $link['id']);
            }

            if ($about !== '' && $aboutAfterLinks) {
                $add('heading', ['text' => 'Story', 'size' => 'm', 'align' => 'center']);
                $add('text', ['text' => $about, 'align' => 'center']);
            }

            $pdo->commit();
        } catch (Throwable $e) {
            $pdo->rollBack();
            error_log('Migration for user #' . $user['id'] . ' failed: ' . $e->getMessage());
        }
    }
}
