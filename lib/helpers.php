<?php
// Kleine Helfer, die überall gebraucht werden.

// Für ältere PHP-Versionen (vor 8.0)
if (!function_exists('str_ends_with')) {
    function str_ends_with(string $haystack, string $needle): bool
    {
        return $needle === '' || substr($haystack, -strlen($needle)) === $needle;
    }
}
if (!function_exists('str_starts_with')) {
    function str_starts_with(string $haystack, string $needle): bool
    {
        return strncmp($haystack, $needle, strlen($needle)) === 0;
    }
}

function e($value): string
{
    return htmlspecialchars((string) $value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

// ---------------------------------------------------------------
// Domains & Adressen
// ---------------------------------------------------------------

// Hauptdomain ohne Port, z. B. "on-your.site"
function oys_base_host(): string
{
    $base = strtolower((string) oys_config('base_domain', 'on-your.site'));
    return explode(':', $base)[0];
}

// Hauptdomain inkl. Port (nur lokal relevant), z. B. "on-your.site" oder "oys.test:8080"
function oys_base_authority(): string
{
    return strtolower((string) oys_config('base_domain', 'on-your.site'));
}

function oys_scheme(): string
{
    return oys_config('scheme', 'https') === 'http' ? 'http' : 'https';
}

function oys_main_url(string $path = '/'): string
{
    return oys_scheme() . '://' . oys_base_authority() . $path;
}

function oys_request_host(): string
{
    $host = strtolower((string) ($_SERVER['HTTP_HOST'] ?? ''));
    return explode(':', $host)[0];
}

function oys_is_main_host(string $host): bool
{
    $base = oys_base_host();
    return $host === $base || $host === 'www.' . $base;
}

// Liefert beide Adressen einer Seite
function oys_page_urls(array $page): array
{
    $slug = $page['slug'];
    $authority = oys_base_authority();
    return [
        'subdomain' => oys_scheme() . '://' . $slug . '.' . $authority,
        'path' => oys_scheme() . '://' . $authority . '/' . $slug,
    ];
}

// Hauptadresse (die andere leitet weiter)
function oys_page_url(array $page, string $sub = ''): string
{
    $urls = oys_page_urls($page);
    $mode = ($page['address_mode'] ?? 'subdomain') === 'path' ? 'path' : 'subdomain';
    $url = $urls[$mode];
    if ($sub !== '') {
        $url .= '/' . ltrim($sub, '/');
    }
    return $url;
}

function oys_page_display_url(array $page): string
{
    return preg_replace('#^https?://#', '', oys_page_url($page));
}

// Ursprung der Hauptadresse – dort liegen die Endpunkte unter /_/ (z. B. https://name.on-your.site)
function oys_page_origin(array $page): string
{
    return ($page['address_mode'] ?? 'subdomain') === 'path' ? oys_main_url('') : oys_page_urls($page)['subdomain'];
}

// Läuft die Anfrage auf der Hauptadresse dieser Seite?
function oys_on_page_host(array $page): bool
{
    $host = oys_request_host();
    if (($page['address_mode'] ?? 'subdomain') === 'path') {
        return oys_is_main_host($host);
    }
    return $host === strtolower((string) $page['slug']) . '.' . oys_base_host();
}

// ---------------------------------------------------------------
// Antworten
// ---------------------------------------------------------------

function oys_redirect(string $url, int $code = 302): void
{
    header('Location: ' . $url, true, $code);
    exit;
}

function oys_json($data, int $code = 200): void
{
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function oys_json_input(): array
{
    $raw = file_get_contents('php://input');
    $data = json_decode($raw ?: '', true);
    return is_array($data) ? $data : [];
}

// ---------------------------------------------------------------
// Session, CSRF, Flash
// ---------------------------------------------------------------

// Sessions nur für Login & Editor – Besucher von Profilseiten bekommen keine Cookies.
function oys_start_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }
    $secure = oys_scheme() === 'https';
    session_set_cookie_params([
        'lifetime' => 0,
        'path' => '/',
        'secure' => $secure,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    session_start();
}

function oys_csrf_token(): string
{
    if (empty($_SESSION['csrf'])) {
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
    }
    return $_SESSION['csrf'];
}

function oys_csrf_field(): string
{
    return '<input type="hidden" name="csrf" value="' . e(oys_csrf_token()) . '">';
}

function oys_csrf_check(?string $token): bool
{
    return !empty($_SESSION['csrf']) && is_string($token) && hash_equals($_SESSION['csrf'], $token);
}

function oys_csrf_from_request(): ?string
{
    return $_SERVER['HTTP_X_CSRF_TOKEN'] ?? ($_POST['csrf'] ?? null);
}

// ---------------------------------------------------------------
// Eingaben säubern
// ---------------------------------------------------------------

function oys_clean_text($value, int $max = 255, bool $multiline = false): string
{
    $value = is_scalar($value) ? (string) $value : '';
    // Steuerzeichen und Schreibrichtungs-Tricks entfernen (Zeilenumbrüche nur bei mehrzeiligen Feldern behalten).
    // Unsichtbare Verbinder in Emoji wie 👨‍💻 bleiben erhalten.
    $value = $multiline
        ? preg_replace('/[^\P{Cc}\n]+|[\x{202A}-\x{202E}\x{2066}-\x{2069}]+/u', '', str_replace("\r\n", "\n", $value))
        : preg_replace('/[\p{Cc}\x{202A}-\x{202E}\x{2066}-\x{2069}]+/u', '', $value);
    $value = trim((string) $value);
    if ($multiline) {
        $value = preg_replace("/\n{3,}/", "\n\n", $value);
    }
    return mb_substr((string) $value, 0, $max);
}

// Normalisiert eine URL. Erlaubt http(s), mailto, tel und (optional) relative Pfade.
function oys_clean_url($value, bool $allowRelative = false): string
{
    $url = trim(is_scalar($value) ? (string) $value : '');
    $url = preg_replace('/\s+/u', '', $url);
    if ($url === '') {
        return '';
    }
    if ($allowRelative && preg_match('#^/[^/]#', $url)) {
        return mb_substr($url, 0, 500);
    }
    // E-Mail-Adresse ohne mailto:
    if (!preg_match('#^[a-z][a-z0-9+.-]*:#i', $url) && preg_match('/^[^@\s\/]+@[^@\s\/]+\.[a-z]{2,}$/i', $url)) {
        $url = 'mailto:' . $url;
    }
    // Telefonnummer
    if (!preg_match('#^[a-z][a-z0-9+.-]*:#i', $url) && preg_match('/^(\+|00)[0-9 ()\/-]{6,}$/', $url)) {
        $url = 'tel:' . preg_replace('/[^0-9+]/', '', $url);
    }
    // Domain ohne Protokoll
    if (!preg_match('#^[a-z][a-z0-9+.-]*:#i', $url)) {
        $url = 'https://' . ltrim($url, '/');
    }
    $scheme = strtolower((string) parse_url($url, PHP_URL_SCHEME));
    if (!in_array($scheme, ['http', 'https', 'mailto', 'tel'], true)) {
        return '';
    }
    if (in_array($scheme, ['http', 'https'], true) && !filter_var($url, FILTER_VALIDATE_URL)) {
        // Umlaut-Domains u. Ä. durchlassen, solange ein Host erkennbar ist
        $host = parse_url($url, PHP_URL_HOST);
        if (!$host || !preg_match('/\./', $host)) {
            return '';
        }
    }
    return mb_substr($url, 0, 1000);
}

// Anzeigeform einer URL (instagram.com/name)
function oys_pretty_url(string $url): string
{
    if (stripos($url, 'mailto:') === 0) {
        return substr($url, 7);
    }
    if (stripos($url, 'tel:') === 0) {
        return substr($url, 4);
    }
    $pretty = preg_replace('#^https?://(www\.)?#i', '', $url);
    return rtrim((string) $pretty, '/');
}

// ---------------------------------------------------------------
// Adressen (Slugs)
// ---------------------------------------------------------------

function oys_normalize_slug($slug): string
{
    $slug = strtolower(trim((string) $slug));
    return (string) preg_replace('/[^a-z0-9-]/', '', $slug);
}

// Gibt eine Fehlermeldung zurück oder null, wenn die Adresse frei und erlaubt ist.
function oys_slug_problem(PDO $pdo, string $slug, ?int $exceptPageId = null): ?string
{
    if ($slug === '') {
        return 'Please enter an address.';
    }
    if (strlen($slug) < 2 || strlen($slug) > 30) {
        return 'The address must be 2–30 characters long.';
    }
    if (!preg_match('/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/', $slug) || strpos($slug, '--') !== false) {
        return 'Only a–z, 0–9 and single hyphens are allowed (not at the start or end).';
    }
    if (function_exists('is_forbidden_subdomain') && is_forbidden_subdomain($slug)) {
        return "The address “{$slug}” is reserved or not allowed.";
    }
    if (in_array($slug, oys_reserved_paths(), true)) {
        return "The address “{$slug}” is reserved.";
    }
    $stmt = $pdo->prepare('SELECT id FROM pages WHERE slug = ? AND id <> ? LIMIT 1');
    $stmt->execute([$slug, (int) $exceptPageId]);
    if ($stmt->fetch()) {
        return "Sorry, the address “{$slug}” is already taken.";
    }
    return null;
}

// Pfade der Hauptdomain, die nie eine Profil-Adresse sein dürfen
function oys_reserved_paths(): array
{
    return [
        'login', 'logout', 'register', 'dashboard', 'admin', 'challenge', 'imprint', 'privacy', 'terms',
        'api', 'static', 'track-click', 'kalender', 'cron', 'lib', 'email', 'install', 'phpmailer',
        'robots', 'sitemap', 'favicon', 'index', 'config', 'go', 'demo', 'impressum', 'datenschutz', 'agb',
    ];
}

// ---------------------------------------------------------------
// Sonstiges
// ---------------------------------------------------------------

function oys_is_bot(string $ua): bool
{
    if ($ua === '') {
        return true;
    }
    return (bool) preg_match(
        '/bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|headless|lighthouse|pingdom|monitor|curl|wget|python|java\/|go-http|okhttp|discordapp|whatsapp|telegram|skype|vkshare|quora link|bitlybot|feedfetcher|ahrefs|semrush|mj12|yandex|baidu|bingpreview/i',
        $ua
    );
}

function oys_hmac(string $data): string
{
    $secret = (string) oys_config('app_secret', '');
    if ($secret === '') {
        // Fallback: aus AES-Schlüssel ableiten, damit es auch ohne app_secret funktioniert
        $secret = hash('sha256', 'oys|' . oys_config('aes_key', '') . '|' . oys_config('db.pass', ''));
    }
    return hash_hmac('sha256', $data, $secret);
}

// Einfache Begrenzung ohne IP-Adressen (z. B. pro Seite oder pro Link).
// Gibt true zurück, wenn die Aktion erlaubt ist.
// Zählt einen Versuch und sagt, ob er noch erlaubt ist
function oys_rate_limit(PDO $pdo, string $key, int $max, int $windowSeconds): bool
{
    if (!oys_rate_ok($pdo, $key, $max, $windowSeconds)) {
        return false;
    }
    oys_rate_hit($pdo, $key, $windowSeconds);
    return true;
}

// Sind unter $key noch Versuche frei? (zählt nicht mit)
function oys_rate_ok(PDO $pdo, string $key, int $max, int $windowSeconds): bool
{
    $stmt = $pdo->prepare('SELECT hits, UNIX_TIMESTAMP(window_start) AS ws FROM rate_limits WHERE rl_key = ?');
    $stmt->execute([$key]);
    $row = $stmt->fetch();
    return !$row || (time() - (int) $row['ws']) >= $windowSeconds || (int) $row['hits'] < $max;
}

// Zählt einen Versuch (z. B. ein falsches Passwort)
function oys_rate_hit(PDO $pdo, string $key, int $windowSeconds): void
{
    $now = time();
    $pdo->prepare('INSERT INTO rate_limits (rl_key, hits, window_start) VALUES (?, 1, FROM_UNIXTIME(?))
        ON DUPLICATE KEY UPDATE hits = IF(window_start <= FROM_UNIXTIME(?), 1, hits + 1),
            window_start = IF(window_start <= FROM_UNIXTIME(?), FROM_UNIXTIME(?), window_start)')
        ->execute([$key, $now, $now - $windowSeconds, $now - $windowSeconds, $now]);
    if (random_int(1, 50) === 1) {
        $pdo->prepare('DELETE FROM rate_limits WHERE window_start < FROM_UNIXTIME(?)')->execute([$now - 86400]);
    }
}

// Kurzlebige Kennung des Absenders für Rate-Limits: nicht umkehrbar, wechselt täglich –
// die IP-Adresse selbst wird nie gespeichert.
function oys_client_key(): string
{
    return substr(oys_hmac('client|' . gmdate('Y-m-d') . '|' . ($_SERVER['REMOTE_ADDR'] ?? '')), 0, 16);
}

// Fehlversuche zählen, damit niemand Passwörter durchprobieren kann – je Absender und insgesamt.
// Richtige Eingaben verbrauchen nichts.
function oys_attempts_allowed(PDO $pdo, string $key, int $perClient, int $total, int $windowSeconds): bool
{
    return oys_rate_ok($pdo, $key . ':' . oys_client_key(), $perClient, $windowSeconds)
        && oys_rate_ok($pdo, $key, $total, $windowSeconds);
}

function oys_attempt_failed(PDO $pdo, string $key, int $windowSeconds): void
{
    oys_rate_hit($pdo, $key . ':' . oys_client_key(), $windowSeconds);
    oys_rate_hit($pdo, $key, $windowSeconds);
}

function oys_upload_url(?string $file): string
{
    return $file ? '/static/uploads/' . rawurlencode($file) : '';
}

function oys_asset(string $path): string
{
    $file = dirname(__DIR__) . $path;
    $v = is_file($file) ? substr(md5((string) filemtime($file)), 0, 8) : '1';
    return $path . '?v=' . $v;
}

function oys_time_ago(?string $datetime): string
{
    if (!$datetime) {
        return '';
    }
    $diff = time() - strtotime($datetime);
    if ($diff < 60) return 'just now';
    if ($diff < 3600) return ($m = (int) floor($diff / 60)) === 1 ? '1 minute ago' : "$m minutes ago";
    if ($diff < 86400) return ($h = (int) floor($diff / 3600)) === 1 ? '1 hour ago' : "$h hours ago";
    if ($diff < 86400 * 7) {
        $d = (int) floor($diff / 86400);
        return $d === 1 ? 'yesterday' : "$d days ago";
    }
    return date('M j, Y', strtotime($datetime));
}

function oys_initials(string $name): string
{
    $parts = preg_split('/\s+/u', trim($name)) ?: [];
    $initials = '';
    foreach (array_slice($parts, 0, 2) as $p) {
        $initials .= mb_strtoupper(mb_substr($p, 0, 1));
    }
    return $initials !== '' ? $initials : '?';
}
