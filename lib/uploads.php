<?php
// Uploads aus dem Editor: Bilder (werden verkleinert und ohne Metadaten gespeichert), Musik, Dateien.

function oys_upload_kinds(): array
{
    return [
        'avatar'  => ['exts' => OYS_IMAGE_EXTS, 'max_mb' => 8,  'max_px' => 640,  'prefix' => 'avatar'],
        'bg'      => ['exts' => OYS_IMAGE_EXTS, 'max_mb' => 10, 'max_px' => 2200, 'prefix' => 'bg'],
        'image'   => ['exts' => OYS_IMAGE_EXTS, 'max_mb' => 10, 'max_px' => 1600, 'prefix' => 'img'],
        'thumb'   => ['exts' => OYS_IMAGE_EXTS, 'max_mb' => 8,  'max_px' => 800,  'prefix' => 'thumb'],
        'gallery' => ['exts' => OYS_IMAGE_EXTS, 'max_mb' => 10, 'max_px' => 1600, 'prefix' => 'gal'],
        'music'   => ['exts' => ['mp3', 'm4a', 'ogg', 'wav'], 'max_mb' => 15, 'max_px' => 0, 'prefix' => 'music'],
        'file'    => ['exts' => ['pdf', 'vcf', 'zip'], 'max_mb' => 10, 'max_px' => 0, 'prefix' => 'file'],
    ];
}

// Größte Datei, die PHP auf diesem Server annimmt (upload_max_filesize / post_max_size), in MB
function oys_upload_limit_mb(): float
{
    $toBytes = function ($v) {
        $v = trim((string) $v);
        if ($v === '' || $v === '-1') {
            return PHP_INT_MAX;
        }
        $unit = strtolower(substr($v, -1));
        $n = (float) $v;
        return (int) ($unit === 'g' ? $n * 1073741824 : ($unit === 'm' ? $n * 1048576 : ($unit === 'k' ? $n * 1024 : $n)));
    };
    $bytes = min($toBytes(ini_get('upload_max_filesize')), $toBytes(ini_get('post_max_size')));
    return round(min($bytes, 100 * 1048576) / 1048576, 1);
}

// Gibt ['file' => name] oder ['error' => text] zurück
function oys_handle_upload(array $upload, string $kind, int $userId): array
{
    $kinds = oys_upload_kinds();
    if (!isset($kinds[$kind])) {
        return ['error' => 'Unbekannte Upload-Art.'];
    }
    $cfg = $kinds[$kind];

    $err = $upload['error'] ?? UPLOAD_ERR_NO_FILE;
    if ($err === UPLOAD_ERR_INI_SIZE || $err === UPLOAD_ERR_FORM_SIZE) {
        return ['error' => 'Die Datei ist zu groß für den Server (upload_max_filesize in Plesk erhöhen).'];
    }
    if ($err !== UPLOAD_ERR_OK || !is_uploaded_file($upload['tmp_name'] ?? '')) {
        return ['error' => 'Upload fehlgeschlagen (Fehlercode ' . (int) $err . ').'];
    }
    if (($upload['size'] ?? 0) > $cfg['max_mb'] * 1024 * 1024) {
        return ['error' => 'Die Datei ist zu groß (max. ' . $cfg['max_mb'] . ' MB).'];
    }

    $ext = strtolower(pathinfo((string) ($upload['name'] ?? ''), PATHINFO_EXTENSION));
    if ($ext === 'jpeg') {
        $ext = 'jpg';
    }
    if (!in_array($ext, $cfg['exts'], true)) {
        return ['error' => 'Dieses Dateiformat ist nicht erlaubt (' . implode(', ', $cfg['exts']) . ').'];
    }

    // Inhalt prüfen, nicht nur die Endung
    $mime = function_exists('finfo_open') ? (string) finfo_file(finfo_open(FILEINFO_MIME_TYPE), $upload['tmp_name']) : '';
    $isImage = in_array($ext, OYS_IMAGE_EXTS, true);
    if ($isImage && !@getimagesize($upload['tmp_name'])) {
        return ['error' => 'Das ist kein gültiges Bild.'];
    }
    $allowedMimes = [
        'mp3' => ['audio/mpeg', 'audio/mp3', 'application/octet-stream'],
        'm4a' => ['audio/mp4', 'audio/x-m4a', 'audio/m4a', 'video/mp4', 'application/octet-stream'],
        'ogg' => ['audio/ogg', 'application/ogg', 'video/ogg'],
        'wav' => ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'],
        'pdf' => ['application/pdf'],
        'vcf' => ['text/vcard', 'text/x-vcard', 'text/plain', 'text/directory'],
        'zip' => ['application/zip', 'application/x-zip-compressed'],
    ];
    if (!$isImage && $mime !== '' && isset($allowedMimes[$ext]) && !in_array($mime, $allowedMimes[$ext], true)) {
        return ['error' => 'Der Dateiinhalt passt nicht zur Endung .' . $ext . '.'];
    }

    $dir = dirname(__DIR__) . '/static/uploads/';
    if (!is_dir($dir)) {
        @mkdir($dir, 0755, true);
    }
    $base = $cfg['prefix'] . '_' . $userId . '_' . time() . '_' . bin2hex(random_bytes(4));

    if ($isImage && $cfg['max_px'] > 0) {
        $converted = oys_process_image($upload['tmp_name'], $ext, $cfg['max_px'], $dir . $base . '.webp');
        if ($converted) {
            return ['file' => $base . '.webp'];
        }
    }
    $name = $base . '.' . $ext;
    if (!move_uploaded_file($upload['tmp_name'], $dir . $name)) {
        return ['error' => 'Der Ordner static/uploads/ ist nicht beschreibbar (Rechte 755 prüfen).'];
    }
    @chmod($dir . $name, 0644);
    return ['file' => $name];
}

// Verkleinert ein Bild, dreht es richtig und speichert es als WebP ohne EXIF (z. B. GPS-Daten).
// GIFs und animierte WebPs bleiben unverändert (Animation würde sonst verloren gehen).
function oys_process_image(string $src, string $ext, int $maxPx, string $target): bool
{
    if (!function_exists('imagewebp') || $ext === 'gif') {
        return false;
    }
    if ($ext === 'webp') {
        $head = (string) @file_get_contents($src, false, null, 0, 64);
        if (strpos($head, 'ANIM') !== false || strpos($head, 'ANMF') !== false) {
            return false;
        }
    }
    $info = @getimagesize($src);
    if (!$info || $info[0] * $info[1] > 40000000) {
        return false;
    }
    $img = false;
    if ($ext === 'jpg') {
        $img = @imagecreatefromjpeg($src);
    } elseif ($ext === 'png') {
        $img = @imagecreatefrompng($src);
    } elseif ($ext === 'webp' && function_exists('imagecreatefromwebp')) {
        $img = @imagecreatefromwebp($src);
    }
    if (!$img) {
        return false;
    }

    if ($ext === 'jpg' && function_exists('exif_read_data')) {
        $exif = @exif_read_data($src);
        $orientation = (int) ($exif['Orientation'] ?? 1);
        $angles = [3 => 180, 6 => -90, 8 => 90];
        $rotated = isset($angles[$orientation]) ? imagerotate($img, $angles[$orientation], 0) : null;
        if ($rotated) {
            imagedestroy($img);
            $img = $rotated;
        }
    }

    $w = imagesx($img);
    $h = imagesy($img);
    $scale = min(1, $maxPx / max($w, $h));
    $nw = max(1, (int) round($w * $scale));
    $nh = max(1, (int) round($h * $scale));
    $out = imagecreatetruecolor($nw, $nh);
    imagealphablending($out, false);
    imagesavealpha($out, true);
    imagecopyresampled($out, $img, 0, 0, 0, 0, $nw, $nh, $w, $h);
    $ok = imagewebp($out, $target, 84);
    imagedestroy($img);
    imagedestroy($out);
    if ($ok) {
        @chmod($target, 0644);
    }
    return $ok;
}
