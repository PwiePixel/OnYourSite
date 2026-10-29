<?php
// Speicherort der hochgeladenen Dateien (Profilbilder, Hintergründe, Musik, Dateien, Vorschaubilder).
//
// Standard: static/uploads/ im Code-Ordner. Mit 'uploads_dir' in config.php liegt der Ordner außerhalb
// des Codes (z. B. neben httpdocs) – dann übersteht er jedes Update per Git, jedes Hineinkopieren der
// Dateien und jedes zurückgespielte Code-Backup. Die Adressen bleiben gleich (/static/uploads/…):
// Liegen die Dateien nicht im Web-Ordner, liefert index.php sie aus.

function oys_uploads_dir(): string
{
    static $dir = null;
    if ($dir === null) {
        $set = trim((string) oys_config('uploads_dir', ''));
        if ($set === '') {
            $dir = oys_uploads_default_dir();
        } else {
            // Relative Angaben gelten ab dem Code-Ordner (z. B. "../oys-uploads")
            $absolute = $set[0] === '/' || preg_match('#^[A-Za-z]:[\\\\/]#', $set);
            $dir = rtrim($absolute ? $set : dirname(__DIR__) . '/' . $set, '/\\');
        }
    }
    return $dir;
}

function oys_uploads_default_dir(): string
{
    return dirname(__DIR__) . '/static/uploads';
}

// Liegt der Ordner außerhalb des Codes (sicher bei Updates)?
function oys_uploads_external(): bool
{
    $a = realpath(oys_uploads_dir());
    $b = realpath(oys_uploads_default_dir());
    return ($a !== false ? $a : oys_uploads_dir()) !== ($b !== false ? $b : oys_uploads_default_dir());
}

// Vorschlag für einen Ordner neben dem Code (bei Plesk: neben httpdocs)
function oys_uploads_suggested_dir(): string
{
    return dirname(dirname(__DIR__)) . '/oys-uploads';
}

function oys_upload_path(string $name): string
{
    return oys_uploads_dir() . '/' . $name;
}

// Zum Lesen auf dem Server: nach dem Umstellen auf uploads_dir liegen manche Dateien evtl. noch in static/uploads
function oys_upload_read_path(string $name): string
{
    $path = oys_upload_path($name);
    if (!is_file($path) && oys_uploads_external() && is_file(oys_uploads_default_dir() . '/' . $name)) {
        return oys_uploads_default_dir() . '/' . $name;
    }
    return $path;
}

// Dateiname aus einer Adresse: nur einfache Namen, keine Ordner, nichts Verstecktes
function oys_upload_name_ok(string $name): bool
{
    return $name !== '' && strlen($name) <= 200 && strpos($name, '/') === false && strpos($name, '\\') === false
        && $name[0] !== '.' && strpos($name, "\0") === false && strpos($name, '..') === false;
}

// /static/uploads/{datei} ausliefern, wenn der Ordner nicht im Web-Ordner liegt (läuft ohne Datenbank)
function oys_serve_upload(string $raw): void
{
    $name = rawurldecode($raw);
    $types = [
        'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'png' => 'image/png', 'gif' => 'image/gif', 'webp' => 'image/webp', 'avif' => 'image/avif', 'bmp' => 'image/bmp',
        'mp3' => 'audio/mpeg', 'm4a' => 'audio/mp4', 'ogg' => 'audio/ogg', 'wav' => 'audio/wav', 'aac' => 'audio/aac', 'flac' => 'audio/flac',
        'mp4' => 'video/mp4', 'webm' => 'video/webm', 'pdf' => 'application/pdf', 'vcf' => 'text/vcard', 'zip' => 'application/zip', 'txt' => 'text/plain; charset=utf-8',
    ];
    // Wie static/uploads/.htaccess: nie als Skript, HTML oder SVG ausliefern; Unbekanntes nur zum Herunterladen
    $denied = ['php', 'php3', 'php4', 'php5', 'php7', 'php8', 'phtml', 'phar', 'pl', 'py', 'cgi', 'sh', 'html', 'htm', 'xhtml', 'shtml', 'svg', 'svgz', 'js', 'mjs', 'xml', 'xsl'];
    $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
    $path = oys_upload_path($name);
    if (!oys_upload_name_ok($name) || $ext === '' || in_array($ext, $denied, true) || !is_file($path)) {
        http_response_code(404);
        header('Content-Type: text/plain; charset=utf-8');
        echo 'Not found';
        return;
    }
    $size = (int) filesize($path);
    $mtime = (int) filemtime($path);
    $etag = '"' . dechex($mtime) . '-' . dechex($size) . '"';
    header('Content-Type: ' . ($types[$ext] ?? 'application/octet-stream'));
    if (!isset($types[$ext])) {
        header('Content-Disposition: attachment');
    }
    header('X-Content-Type-Options: nosniff');
    header('Cache-Control: public, max-age=2592000');
    header('Last-Modified: ' . gmdate('D, d M Y H:i:s', $mtime) . ' GMT');
    header('ETag: ' . $etag);
    header('Accept-Ranges: bytes');
    if (($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) {
        http_response_code(304);
        return;
    }
    // Teilbereiche (Safari braucht das für Musik)
    $start = 0;
    $end = $size - 1;
    if (preg_match('/^bytes=(\d*)-(\d*)$/', (string) ($_SERVER['HTTP_RANGE'] ?? ''), $m) && ($m[1] !== '' || $m[2] !== '')) {
        if ($m[1] === '') {
            $start = max(0, $size - (int) $m[2]);
        } else {
            $start = (int) $m[1];
            $end = $m[2] !== '' ? min((int) $m[2], $size - 1) : $size - 1;
        }
        if ($start > $end || $start >= $size) {
            http_response_code(416);
            header('Content-Range: bytes */' . $size);
            return;
        }
        http_response_code(206);
        header('Content-Range: bytes ' . $start . '-' . $end . '/' . $size);
    }
    header('Content-Length: ' . ($end - $start + 1));
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'HEAD') {
        return;
    }
    $fh = fopen($path, 'rb');
    if (!$fh) {
        return;
    }
    fseek($fh, $start);
    $left = $end - $start + 1;
    while ($left > 0 && !feof($fh)) {
        $chunk = fread($fh, (int) min(65536, $left));
        if ($chunk === false) {
            break;
        }
        echo $chunk;
        $left -= strlen($chunk);
    }
    fclose($fh);
}

// Alle Dateien im Upload-Ordner (ohne Unterordner und Hilfsdateien): Name => Bytes
function oys_storage_files(?string $dir = null): array
{
    $dir = $dir ?? oys_uploads_dir();
    $files = [];
    foreach (glob($dir . '/*') ?: [] as $path) {
        $name = basename($path);
        if (is_file($path) && $name[0] !== '.') {
            $files[$name] = (int) filesize($path);
        }
    }
    return $files;
}

// Alle Uploads als ZIP herunterladen (Backup). Gibt eine Fehlermeldung zurück oder beendet die Anfrage.
function oys_storage_download_zip(): ?string
{
    if (!class_exists('ZipArchive')) {
        return 'The PHP extension “zip” is missing on this server – please download the folder by FTP or the file manager instead.';
    }
    $files = oys_storage_files();
    if (!$files) {
        return 'There are no uploads yet.';
    }
    @set_time_limit(0);
    $tmp = tempnam(sys_get_temp_dir(), 'oys-backup');
    $zip = new ZipArchive();
    if ($tmp === false || $zip->open($tmp, ZipArchive::OVERWRITE) !== true) {
        return 'The backup file couldn’t be created (temporary folder not writable).';
    }
    // Die Zwischendatei verschwindet auch, wenn der Download abbricht
    register_shutdown_function(function () use ($tmp) { @unlink($tmp); });
    $retry = 'The backup couldn’t be finished – a file probably changed while it was being packed, or the temporary folder is full. Please try again.';
    foreach ($files as $name => $bytes) {
        if (!$zip->addFile(oys_upload_path($name), 'uploads/' . $name)) {
            $zip->unchangeAll();
            $zip->close();
            return $retry;
        }
        // Bilder und Musik sind schon komprimiert – nur speichern geht schneller
        if (method_exists($zip, 'setCompressionName')) {
            $zip->setCompressionName('uploads/' . $name, ZipArchive::CM_STORE);
        }
    }
    // Die Dateien werden erst hier gelesen – fehlt eine inzwischen, schlägt close() fehl
    $closed = @$zip->close();
    clearstatcache(true, $tmp);
    if ($closed !== true || !filesize($tmp)) {
        return $retry;
    }
    header('Content-Type: application/zip');
    header('Content-Disposition: attachment; filename="onyoursite-uploads-' . date('Y-m-d') . '.zip"');
    header('Content-Length: ' . filesize($tmp));
    header('Cache-Control: no-store');
    readfile($tmp);
    exit;
}

// Dateien aus static/uploads in den eingestellten Ordner verschieben (einmalig nach dem Umstellen)
function oys_storage_move_to_data_dir(): array
{
    $from = oys_uploads_default_dir();
    $to = oys_uploads_dir();
    if (!oys_uploads_external()) {
        return ['moved' => 0, 'error' => 'Set “uploads_dir” in config.php first.'];
    }
    if (!is_dir($to) && !@mkdir($to, 0755, true)) {
        return ['moved' => 0, 'error' => 'The folder ' . $to . ' couldn’t be created – create it in the file manager (permissions 755).'];
    }
    if (!is_writable($to)) {
        return ['moved' => 0, 'error' => 'The folder ' . $to . ' isn’t writable (permissions 755).'];
    }
    $moved = 0;
    $skipped = 0;
    foreach (oys_storage_files($from) as $name => $bytes) {
        $target = $to . '/' . $name;
        if (is_file($target)) {
            $skipped++;
            continue;
        }
        if (@rename($from . '/' . $name, $target) || (@copy($from . '/' . $name, $target) && @unlink($from . '/' . $name))) {
            $moved++;
        }
    }
    return ['moved' => $moved, 'skipped' => $skipped, 'error' => null];
}
