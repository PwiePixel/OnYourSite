<?php
// Code-Seiten: eigene Website aus HTML, CSS und JavaScript unter name.on-your.site.
//
// Sicherheit: Es wird kein Code auf dem Server ausgeführt (kein PHP) – die Dateien werden nur ausgeliefert.
// Jede Antwort hat „Content-Security-Policy: sandbox …“ ohne allow-same-origin: Die Seite läuft damit in einem
// eigenen, anonymen Ursprung und kommt weder an Cookies noch an Speicher oder andere Seiten von OnYourSite.

const OYS_CODE_MAX_FILES = 30;
const OYS_CODE_MAX_FILE_BYTES = 262144;      // 256 KB je Datei
const OYS_CODE_MAX_TOTAL_BYTES = 2097152;    // 2 MB je Seite
const OYS_CODE_TYPES = [
    'html' => 'text/html', 'htm' => 'text/html', 'css' => 'text/css', 'js' => 'text/javascript', 'mjs' => 'text/javascript',
    'json' => 'application/json', 'txt' => 'text/plain', 'md' => 'text/plain', 'svg' => 'image/svg+xml',
    'xml' => 'application/xml', 'webmanifest' => 'application/manifest+json',
];
const OYS_CODE_SANDBOX = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock';

function oys_code_site(PDO $pdo, int $userId): ?array
{
    $stmt = $pdo->prepare('SELECT * FROM code_sites WHERE user_id = ? LIMIT 1');
    $stmt->execute([$userId]);
    return $stmt->fetch() ?: null;
}

function oys_code_site_by_id(PDO $pdo, int $id): ?array
{
    $stmt = $pdo->prepare('SELECT * FROM code_sites WHERE id = ?');
    $stmt->execute([$id]);
    return $stmt->fetch() ?: null;
}

function oys_code_site_by_slug(PDO $pdo, string $slug): ?array
{
    $stmt = $pdo->prepare('SELECT * FROM code_sites WHERE slug = ? LIMIT 1');
    $stmt->execute([$slug]);
    return $stmt->fetch() ?: null;
}

function oys_code_url(array $site): string
{
    return oys_scheme() . '://' . $site['slug'] . '.' . oys_base_authority();
}

function oys_code_unlocked(PDO $pdo, int $userId): bool
{
    return oys_hc_has($pdo, $userId, 'unlock', 'code_page');
}

// Alle Dateien einer Seite: Pfad => Inhalt
function oys_code_files(PDO $pdo, int $siteId): array
{
    $stmt = $pdo->prepare('SELECT path, content FROM code_files WHERE site_id = ? ORDER BY path');
    $stmt->execute([$siteId]);
    $files = [];
    foreach ($stmt->fetchAll() as $row) {
        $files[$row['path']] = (string) $row['content'];
    }
    return $files;
}

// Erlaubter Dateipfad (klein geschrieben, bis zu 3 Ordner, bekannte Endung) oder null
function oys_code_valid_path(string $path): ?string
{
    $path = strtolower(trim(str_replace('\\', '/', $path), '/ '));
    if (strlen($path) > 120 || !preg_match('#^[a-z0-9_-]+(?:[.][a-z0-9_-]+)*(?:/[a-z0-9_-]+(?:[.][a-z0-9_-]+)*){0,3}$#', $path)) {
        return null;
    }
    $ext = pathinfo($path, PATHINFO_EXTENSION);
    return isset(OYS_CODE_TYPES[$ext]) ? $path : null;
}

function oys_code_for_editor(PDO $pdo, array $site): array
{
    $files = oys_code_files($pdo, (int) $site['id']);
    return [
        'id' => (int) $site['id'],
        'slug' => $site['slug'],
        'title' => $site['title'],
        'online' => (bool) $site['is_published'],
        'blocked' => (bool) $site['is_blocked'],
        'blocked_reason' => (string) ($site['blocked_reason'] ?? ''),
        'url' => oys_code_url($site),
        'preview' => oys_code_url($site) . '/?oys-preview=' . oys_code_preview_token($site),
        'views' => (int) $site['views'],
        'files' => $files,
        'limits' => ['files' => OYS_CODE_MAX_FILES, 'file' => OYS_CODE_MAX_FILE_BYTES, 'total' => OYS_CODE_MAX_TOTAL_BYTES, 'types' => array_keys(OYS_CODE_TYPES)],
    ];
}

// Neue Code-Seite mit Startdateien. Gibt [Seite, Fehler] zurück.
function oys_code_create(PDO $pdo, int $userId, string $slug, string $title): array
{
    if (oys_code_site($pdo, $userId)) {
        return [null, 'You already have a code page.'];
    }
    if ($problem = oys_slug_problem($pdo, $slug)) {
        return [null, $problem];
    }
    $title = oys_clean_text($title, 120) ?: $slug;
    $now = date('Y-m-d H:i:s');
    $pdo->prepare('INSERT INTO code_sites (user_id, slug, title, is_published, is_blocked, views, created_at, updated_at) VALUES (?, ?, ?, 1, 0, 0, ?, ?)')
        ->execute([$userId, $slug, $title, $now, $now]);
    $site = oys_code_site_by_id($pdo, (int) $pdo->lastInsertId());
    $insert = $pdo->prepare('INSERT INTO code_files (site_id, path, content, updated_at) VALUES (?, ?, ?, ?)');
    foreach (oys_code_starter_files($title) as $path => $content) {
        $insert->execute([$site['id'], $path, $content, $now]);
    }
    return [$site, null];
}

function oys_code_starter_files(string $title): array
{
    $t = e($title);
    return [
        'index.html' => "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"UTF-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n  <title>$t</title>\n  <link rel=\"stylesheet\" href=\"style.css\">\n</head>\n<body>\n  <main class=\"card\">\n    <h1>$t</h1>\n    <p>This is your own website – edit <code>index.html</code>, <code>style.css</code> and <code>script.js</code> in the editor.</p>\n    <button id=\"hello\">Click me</button>\n  </main>\n  <script src=\"script.js\"></script>\n</body>\n</html>\n",
        'style.css' => "* { box-sizing: border-box; }\nbody {\n  margin: 0;\n  min-height: 100vh;\n  display: grid;\n  place-items: center;\n  font-family: system-ui, sans-serif;\n  background: radial-gradient(circle at 20% 20%, #312e81, #09090b 60%);\n  color: #fafafa;\n}\n.card {\n  max-width: 520px;\n  margin: 24px;\n  padding: 32px;\n  border-radius: 20px;\n  background: rgba(255, 255, 255, .06);\n  border: 1px solid rgba(255, 255, 255, .12);\n}\nbutton {\n  padding: 10px 18px;\n  border: 0;\n  border-radius: 999px;\n  background: #6366f1;\n  color: #fff;\n  font-weight: 600;\n  cursor: pointer;\n}\n",
        'script.js' => "document.getElementById('hello').addEventListener('click', () => {\n  alert('Hello from your own website!');\n});\n",
    ];
}

// Dateien speichern: geänderte/neue Dateien ($files: Pfad => Inhalt) und gelöschte ($deleted: Pfade).
// Gibt eine Fehlermeldung oder null zurück.
function oys_code_save(PDO $pdo, array $site, array $files, array $deleted): ?string
{
    // Gleichzeitige Speichervorgänge (z. B. zwei Tabs) nacheinander prüfen – sonst ließen sich die Grenzen umgehen
    $pdo->beginTransaction();
    try {
        $pdo->prepare('SELECT id FROM code_sites WHERE id = ? FOR UPDATE')->execute([$site['id']]);
        $error = oys_code_write($pdo, $site, $files, $deleted);
        if ($error !== null) {
            $pdo->rollBack();
            return $error;
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }
    return null;
}

// Prüft und schreibt die Änderungen (innerhalb der Transaktion von oys_code_save)
function oys_code_write(PDO $pdo, array $site, array $files, array $deleted): ?string
{
    $current = oys_code_files($pdo, (int) $site['id']);
    $next = $current;
    foreach ($deleted as $path) {
        unset($next[(string) $path]);
    }
    foreach ($files as $path => $content) {
        $clean = oys_code_valid_path((string) $path);
        if ($clean === null) {
            return '“' . mb_substr((string) $path, 0, 60) . '” isn’t an allowed file name. Use lowercase letters, numbers, - and _, and one of: ' . implode(', ', array_keys(OYS_CODE_TYPES)) . '.';
        }
        if (!is_string($content) || !mb_check_encoding($content, 'UTF-8')) {
            return $clean . ': only text files (UTF-8) can be saved.';
        }
        if (strlen($content) > OYS_CODE_MAX_FILE_BYTES) {
            return $clean . ' is larger than ' . (OYS_CODE_MAX_FILE_BYTES / 1024) . ' KB.';
        }
        $next[$clean] = str_replace("\0", '', $content);
    }
    if (count($next) > OYS_CODE_MAX_FILES) {
        return 'A code page can have up to ' . OYS_CODE_MAX_FILES . ' files.';
    }
    if (array_sum(array_map('strlen', $next)) > OYS_CODE_MAX_TOTAL_BYTES) {
        return 'All files together may be up to ' . (OYS_CODE_MAX_TOTAL_BYTES / 1048576) . ' MB.';
    }
    if (!isset($next['index.html'])) {
        return 'Your page needs an index.html – it’s the first file visitors see.';
    }
    $now = date('Y-m-d H:i:s');
    $del = $pdo->prepare('DELETE FROM code_files WHERE site_id = ? AND path = ?');
    foreach (array_diff_key($current, $next) as $path => $unused) {
        $del->execute([$site['id'], $path]);
    }
    $up = $pdo->prepare('INSERT INTO code_files (site_id, path, content, updated_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE content = VALUES(content), updated_at = VALUES(updated_at)');
    foreach ($next as $path => $content) {
        if (!array_key_exists($path, $current) || $current[$path] !== $content) {
            $up->execute([$site['id'], $path, $content, $now]);
        }
    }
    $pdo->prepare('UPDATE code_sites SET updated_at = ? WHERE id = ?')->execute([$now, $site['id']]);
    return null;
}

// Konto gelöscht: Code-Seite, Dateien und Honigwaben entfernen
function oys_code_delete_user(PDO $pdo, int $userId): void
{
    if ($site = oys_code_site($pdo, $userId)) {
        $pdo->prepare('DELETE FROM code_files WHERE site_id = ?')->execute([$site['id']]);
        $pdo->prepare('DELETE FROM code_sites WHERE id = ?')->execute([$site['id']]);
    }
    $pdo->prepare('DELETE FROM honeycomb_ledger WHERE user_id = ?')->execute([$userId]);
}

// Hochgeladene Bilder, die in den Dateien einer Code-Seite benutzt werden (damit das Aufräumen sie nicht löscht)
function oys_code_used_uploads(PDO $pdo, int $userId): array
{
    $site = oys_code_site($pdo, $userId);
    if (!$site) {
        return [];
    }
    $used = [];
    foreach (oys_code_files($pdo, (int) $site['id']) as $content) {
        // Dateinamen dieser Version (name_ID_zeit_zufall.ext), egal wie sie eingebunden sind
        if (preg_match_all('#[a-z]+_' . $userId . '_\d{9,11}_[0-9a-f]{8}\.[a-z0-9]{2,5}#', $content, $m)) {
            foreach ($m[0] as $name) {
                $used[$name] = true;
            }
        }
        // ältere Dateinamen über ihre Adresse (auch ohne / am Anfang)
        if (preg_match_all('#static/uploads/([A-Za-z0-9._%-]+)#', $content, $m)) {
            foreach ($m[1] as $name) {
                $used[rawurldecode($name)] = true;
            }
        }
    }
    return $used;
}

// Vorschau des Besitzers im Editor: zeigt die Seite auch, wenn sie offline ist (12 Stunden gültig)
function oys_code_preview_token(array $site, ?int $time = null): string
{
    $time = $time ?? time();
    return $time . '-' . substr(oys_hmac('code-preview|' . $site['id'] . '|' . $site['slug'] . '|' . $time), 0, 24);
}

function oys_code_preview_valid(array $site, string $token): bool
{
    if (!preg_match('/^(\d{9,11})-[0-9a-f]{24}$/', $token, $m)) {
        return false;
    }
    $age = time() - (int) $m[1];
    return $age >= -60 && $age <= 43200 && hash_equals(oys_code_preview_token($site, (int) $m[1]), $token);
}

// Datei einer Code-Seite ausliefern (name.on-your.site/…)
function oys_code_serve(PDO $pdo, array $site, string $path): void
{
    header('Content-Security-Policy: ' . OYS_CODE_SANDBOX);
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: strict-origin-when-cross-origin');
    header('Access-Control-Allow-Origin: *');
    // Für jede Antwort, auch Hinweise wie „Page not found“ – sonst hielte Cloudflare sie ein paar Minuten fest
    header('Cache-Control: no-cache, no-transform');
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    // Code-Seiten sind reine Dateien: nur ansehen (auch keine POST-Anfragen wie die der Mail-Autokonfiguration)
    if ($method !== 'GET' && $method !== 'HEAD') {
        header('Allow: GET, HEAD');
        http_response_code(405);
        echo oys_code_notice('Not allowed', 'Code pages can only be viewed.');
        return;
    }
    if (!empty($site['is_blocked'])) {
        http_response_code(451);
        echo oys_code_notice('This page has been blocked', 'It broke the rules for code pages on OnYourSite.');
        return;
    }
    $urlToken = is_string($_GET['oys-preview'] ?? null) ? $_GET['oys-preview'] : '';
    $rel = strtolower(trim(rawurldecode($path), '/'));
    // Offline sehen Besucher nur einen Hinweis. Der Besitzer sieht Seiten mit Vorschau-Schlüssel (Editor) –
    // Dateien wie CSS, JS und Bilder werden dafür auch offline ausgeliefert, die Sandbox gibt keinen Referer mit.
    $hidden = empty($site['is_published']) && !oys_code_preview_valid($site, $urlToken);
    $askedExt = pathinfo($rel, PATHINFO_EXTENSION);
    if ($hidden && ($askedExt === '' || $askedExt === 'html' || $askedExt === 'htm' || !isset(OYS_CODE_TYPES[$askedExt]))) {
        http_response_code(404);
        echo oys_code_notice('This page is offline', 'Its owner has switched it off for now.');
        return;
    }
    $candidates = $rel === '' ? ['index.html'] : [$rel, $rel . '.html', $rel . '/index.html'];
    $stmt = $pdo->prepare('SELECT path, content, updated_at FROM code_files WHERE site_id = ? AND path = ?');
    $file = null;
    foreach ($candidates as $candidate) {
        if (oys_code_valid_path($candidate) === null) {
            continue;
        }
        $stmt->execute([$site['id'], $candidate]);
        if ($row = $stmt->fetch()) {
            $file = $row;
            break;
        }
    }
    $status = 200;
    if (!$file) {
        $status = 404;
        $stmt->execute([$site['id'], '404.html']);
        $file = $stmt->fetch() ?: null;
        if (!$file) {
            http_response_code(404);
            echo oys_code_notice('Page not found', 'This page doesn’t exist on ' . $site['slug'] . '.' . oys_base_authority() . '.');
            return;
        }
    }
    $ext = pathinfo($file['path'], PATHINFO_EXTENSION);
    $type = OYS_CODE_TYPES[$ext];
    $isHtml = $type === 'text/html';
    if ($hidden && $isHtml) {
        http_response_code(404);
        echo oys_code_notice('This page is offline', 'Its owner has switched it off for now.');
        return;
    }
    $qs = (string) ($_SERVER['QUERY_STRING'] ?? '');
    // Ordner immer mit / am Ende, damit relative Links in ordner/index.html stimmen
    if ($status === 200 && $file['path'] === $rel . '/index.html' && substr($path, -1) !== '/') {
        oys_redirect('/' . $rel . '/' . ($qs !== '' ? '?' . $qs : ''), 302);
    }
    $body = (string) $file['content'];
    if ($isHtml) {
        $body = oys_code_add_badge($body, $site);
    }
    $etag = '"' . substr(md5($body), 0, 16) . '"';
    http_response_code($status);
    header('Content-Type: ' . $type . (strpos($type, 'text/') === 0 || in_array($ext, ['json', 'svg', 'xml', 'webmanifest'], true) ? '; charset=utf-8' : ''));
    // Immer kurz nachfragen (304 bei gleichem Stand), damit Änderungen sofort sichtbar sind.
    // no-transform: Cloudflare ändert die Dateien nicht (keine E-Mail-Verschleierung, keine eingefügten Skripte)
    header('Cache-Control: no-cache, no-transform');
    header('ETag: ' . $etag);
    if ($status === 200 && ($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) {
        http_response_code(304);
        return;
    }
    // Aufrufe zählen – nicht die Vorschau im Editor (?oys-preview=…) und keine HEAD-Anfragen
    if ($method === 'GET' && $isHtml && $status === 200 && $urlToken === '' && !oys_is_bot($_SERVER['HTTP_USER_AGENT'] ?? '')) {
        $pdo->prepare('UPDATE code_sites SET views = views + 1 WHERE id = ?')->execute([$site['id']]);
    }
    echo $body;
}

// Kleiner Hinweis „Hosted on OnYourSite“ unten rechts (mit Link zu den Regeln und zum Melden)
function oys_code_add_badge(string $html, array $site): string
{
    $badge = '<a href="' . e(oys_main_url('/terms/code-pages')) . '#report" target="_blank" rel="noopener" '
        . 'style="position:fixed;right:10px;bottom:10px;z-index:2147483647;display:inline-flex;align-items:center;gap:5px;'
        . 'padding:6px 10px;border-radius:999px;background:rgba(15,15,20,.78);color:#fff;font:600 11px/1 system-ui,sans-serif;'
        . 'text-decoration:none;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)" title="Hosted on OnYourSite – report this page">'
        . '<span style="color:#818cf8">&#x2B21;</span> OnYourSite</a>';
    $pos = strripos($html, '</body>');
    return $pos === false ? $html . $badge : substr($html, 0, $pos) . $badge . substr($html, $pos);
}

function oys_code_notice(string $title, string $text): string
{
    header('Content-Type: text/html; charset=utf-8');
    return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
        . '<title>' . e($title) . '</title><meta name="robots" content="noindex"></head>'
        . '<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#09090b;color:#e4e4e7;font-family:system-ui,sans-serif;text-align:center;padding:24px">'
        . '<div><div style="font-size:40px;color:#818cf8">&#x2B21;</div><h1 style="font-size:22px;margin:12px 0 6px">' . e($title) . '</h1>'
        . '<p style="color:#a1a1aa;margin:0 0 18px">' . e($text) . '</p>'
        . '<a href="' . e(oys_main_url('/')) . '" style="color:#818cf8">OnYourSite</a></div></body></html>';
}
