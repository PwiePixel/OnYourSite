<?php
// Teilen: Vorschaubild (og:image) für geteilte Links – Discord, WhatsApp, X & Co. zeigen es als Karte.
// Das Bild wird beim ersten Abruf erzeugt und in static/uploads/og/ zwischengespeichert.

const OYS_OG_WIDTH = 1200;
const OYS_OG_HEIGHT = 630;

// Adressen zum Teilen (Discord hat keine – dort wird der Link eingefügt und als Karte angezeigt)
function oys_share_links(string $url, string $title): array
{
    return [
        'whatsapp' => 'https://wa.me/?text=' . rawurlencode($title !== '' ? $title . ' ' . $url : $url),
        'x' => 'https://x.com/intent/tweet?url=' . rawurlencode($url) . ($title !== '' ? '&text=' . rawurlencode($title) : ''),
    ];
}

function oys_og_supported(): bool
{
    return function_exists('imagecreatetruecolor') && function_exists('imagettftext') && is_file(oys_og_font(true));
}

function oys_og_font(bool $bold): string
{
    return dirname(__DIR__) . '/static/fonts/inter-' . ($bold ? '700' : '400') . '.ttf';
}

// Kennung des Bildes: ändert sich, sobald sich etwas Sichtbares ändert – dann laden Discord & Co. es neu
function oys_og_hash(array $page): string
{
    $s = oys_page_settings($page);
    return substr(sha1(implode("\n", [
        'og-1', (int) ($page['id'] ?? 0), $page['slug'] ?? '', $page['address_mode'] ?? '', $page['title'] ?? '',
        $page['subtitle'] ?? '', (string) ($page['bio'] ?? ''), (string) ($page['avatar'] ?? ''),
        oys_theme_key($page['theme'] ?? OYS_DEFAULT_THEME), $s['accent'], !empty($s['hide_branding']) ? 1 : 0, oys_base_authority(),
    ])), 0, 12);
}

function oys_og_url(array $page): string
{
    return oys_page_origin($page) . '/_/og/' . (int) $page['id'] . '-' . oys_og_hash($page) . '.png';
}

// /_/og/{id}-{hash}.png ausliefern (aus dem Zwischenspeicher oder frisch erzeugt)
function oys_og_serve(PDO $pdo, int $id, string $hash): void
{
    $page = oys_load_page($pdo, $id);
    if (!$page || !oys_og_supported()) {
        http_response_code(404);
        exit;
    }
    $current = oys_og_hash($page);
    if (!hash_equals($current, $hash)) {
        // Alte Adresse (Seite wurde geändert): zum aktuellen Bild weiterleiten, nichts neu erzeugen
        header('Cache-Control: public, max-age=300');
        oys_redirect('/_/og/' . $id . '-' . $current . '.png');
    }
    $dir = dirname(__DIR__) . '/static/uploads/og';
    $file = $dir . '/' . $id . '-' . $current . '.png';
    if (!is_file($file)) {
        $png = oys_og_render($page);
        if (!is_dir($dir)) {
            @mkdir($dir, 0755, true);
        }
        // Ältere Bilder dieser Seite aufräumen
        foreach (glob($dir . '/' . $id . '-*.png') ?: [] as $old) {
            @unlink($old);
        }
        if (@file_put_contents($file . '.tmp', $png) !== false) {
            @rename($file . '.tmp', $file);
        }
    } else {
        $png = (string) file_get_contents($file);
    }
    header('Content-Type: image/png');
    header('Content-Length: ' . strlen($png));
    header('Cache-Control: public, max-age=31536000, immutable');
    echo $png;
    exit;
}

// Zeichnet die Karte: Hintergrund in den Farben des Designs, Profilbild, Name, Untertitel und Adresse
function oys_og_render(array $page): string
{
    $W = OYS_OG_WIDTH;
    $H = OYS_OG_HEIGHT;
    $s = oys_page_settings($page);
    $theme = oys_themes()[oys_theme_key($page['theme'] ?? OYS_DEFAULT_THEME)];
    $dark = (bool) $theme['dark'];
    $accent = oys_og_rgb($s['accent'] ?: $theme['accent']);
    $base = $dark ? [11, 11, 15] : [248, 248, 251];
    $text = $dark ? [255, 255, 255] : [24, 24, 27];
    $muted = $dark ? [161, 161, 170] : [82, 82, 91];
    // Akzentfarbe, die sich vom Hintergrund abhebt (z. B. Weiß auf hellem Design → dunkel)
    $accentText = oys_og_contrast($accent, $base) >= 2.2 ? $accent : $text;

    $im = imagecreatetruecolor($W, $H);
    imagealphablending($im, true);

    // Weicher Farbverlauf: viele Ellipsen mit wenig Deckkraft übereinander ergeben runde Lichtflecken
    imagefill($im, 0, 0, imagecolorallocate($im, $base[0], $base[1], $base[2]));
    $glow = imagecolorallocatealpha($im, $accent[0], $accent[1], $accent[2], $dark ? 122 : 124);
    foreach ([[90, 40, 1150, 900], [1130, 640, 1000, 760]] as [$cx, $cy, $rw, $rh]) {
        for ($i = 0; $i < 48; $i++) {
            $f = 1 - $i / 48;
            imagefilledellipse($im, $cx, $cy, (int) ($rw * $f), (int) ($rh * $f), $glow);
        }
    }

    // Profilbild (oder Initialen) mit Ring in der Akzentfarbe
    $disc = 300;
    $avatar = oys_og_avatar($page, $disc, $accent, $base, $dark);
    imagecopy($im, $avatar, 96, (int) (($H - $disc) / 2), 0, 0, $disc, $disc);
    imagedestroy($avatar);

    // Texte rechts daneben
    $x = 456;
    $maxW = $W - $x - 90;
    $title = oys_og_clean((string) ($page['title'] ?? '')) ?: (string) $page['slug'];
    $sub = oys_og_clean((string) ($page['subtitle'] ?? ''));
    if ($sub === '') {
        $sub = oys_og_clean(strtok((string) ($page['bio'] ?? ''), "\n") ?: '');
    }
    $address = preg_replace('#^https?://#', '', oys_page_url($page));

    // Name: Schrift verkleinern, bis er in zwei Zeilen passt – erst bei der kleinsten Größe kürzen
    for ($size = 72; $size > 48; $size -= 4) {
        if (count(oys_og_wrap($title, oys_og_font(true), $size, $maxW, 99)) <= 2) {
            break;
        }
    }
    $titleLines = oys_og_wrap($title, oys_og_font(true), $size, $maxW, 2);
    $subLines = $sub !== '' ? oys_og_wrap($sub, oys_og_font(false), 32, $maxW, 2) : [];

    // Block aus Name, Untertitel und Adresse senkrecht mittig setzen (y = Oberkante der jeweiligen Zeile)
    $lineH = (int) round($size * 1.16);
    $block = count($titleLines) * $lineH + ($subLines ? 16 + count($subLines) * 44 : 0) + 30 + 36;
    $y = (int) (($H - $block) / 2);
    $cText = imagecolorallocate($im, $text[0], $text[1], $text[2]);
    $cMuted = imagecolorallocate($im, $muted[0], $muted[1], $muted[2]);
    $cAccent = imagecolorallocate($im, $accentText[0], $accentText[1], $accentText[2]);
    foreach ($titleLines as $line) {
        imagettftext($im, $size, 0, $x, $y + (int) round($size * .92), $cText, oys_og_font(true), $line);
        $y += $lineH;
    }
    if ($subLines) {
        $y += 16;
        foreach ($subLines as $line) {
            imagettftext($im, 32, 0, $x, $y + 32, $cMuted, oys_og_font(false), $line);
            $y += 44;
        }
    }
    $y += 30;
    imagettftext($im, 30, 0, $x, $y + 30, $cAccent, oys_og_font(true), oys_og_fit($address, oys_og_font(true), 30, $maxW));

    if (empty($s['hide_branding'])) {
        $mark = 'OnYourSite';
        $w = oys_og_width($mark, oys_og_font(true), 24);
        imagettftext($im, 24, 0, $W - $w - 48, $H - 42, $cMuted, oys_og_font(true), $mark);
    }

    ob_start();
    imagepng($im, null, 6);
    imagedestroy($im);
    return (string) ob_get_clean();
}

// Rundes Profilbild mit Ring (doppelt so groß gezeichnet und verkleinert → glatte Kanten)
function oys_og_avatar(array $page, int $size, array $accent, array $base, bool $dark)
{
    $big = $size * 2;
    $im = imagecreatetruecolor($big, $big);
    imagealphablending($im, false);
    imagefill($im, 0, 0, imagecolorallocatealpha($im, 0, 0, 0, 127));
    imagealphablending($im, true);
    imagefilledellipse($im, $size, $size, $big - 4, $big - 4, imagecolorallocate($im, $accent[0], $accent[1], $accent[2]));
    $gap = 14;
    imagefilledellipse($im, $size, $size, $big - 4 - 2 * $gap, $big - 4 - 2 * $gap, imagecolorallocate($im, $base[0], $base[1], $base[2]));

    $inner = $big - 4 - 2 * $gap - 2 * 10;
    $photo = oys_og_load_image((string) ($page['avatar'] ?? ''));
    $disc = imagecreatetruecolor($inner, $inner);
    if ($photo) {
        // Quadratisch zuschneiden (Mitte), auf die Kreisgröße bringen
        $pw = imagesx($photo);
        $ph = imagesy($photo);
        $side = min($pw, $ph);
        imagecopyresampled($disc, $photo, 0, 0, (int) (($pw - $side) / 2), (int) (($ph - $side) / 2), $inner, $inner, $side, $side);
        imagedestroy($photo);
    } else {
        $bg = $dark ? oys_og_mix($accent, [0, 0, 0], .55) : oys_og_mix($accent, [255, 255, 255], .75);
        imagefill($disc, 0, 0, imagecolorallocate($disc, $bg[0], $bg[1], $bg[2]));
        $initials = oys_og_clean(oys_initials((string) (($page['title'] ?? '') !== '' ? $page['title'] : $page['slug'])));
        $fs = (int) ($inner * .3);
        $w = oys_og_width($initials, oys_og_font(true), $fs);
        $c = $dark ? [255, 255, 255] : oys_og_mix($accent, [0, 0, 0], .35);
        imagettftext($disc, $fs, 0, (int) (($inner - $w) / 2), (int) ($inner / 2 + $fs * .36), imagecolorallocate($disc, $c[0], $c[1], $c[2]), oys_og_font(true), $initials);
    }
    // Als Kreis maskieren
    $r = $inner / 2;
    $off = (int) (($big - $inner) / 2);
    for ($py = 0; $py < $inner; $py++) {
        for ($px = 0; $px < $inner; $px++) {
            $d = sqrt(($px - $r + .5) ** 2 + ($py - $r + .5) ** 2);
            if ($d <= $r) {
                imagesetpixel($im, $off + $px, $off + $py, imagecolorat($disc, $px, $py));
            }
        }
    }
    imagedestroy($disc);

    $out = imagecreatetruecolor($size, $size);
    imagealphablending($out, false);
    imagesavealpha($out, true);
    imagefill($out, 0, 0, imagecolorallocatealpha($out, 0, 0, 0, 127));
    imagecopyresampled($out, $im, 0, 0, 0, 0, $size, $size, $big, $big);
    imagedestroy($im);
    imagealphablending($out, true);
    return $out;
}

// Hochgeladenes Bild laden (nur aus static/uploads, nur echte Bilddateien)
function oys_og_load_image(string $file)
{
    $name = basename($file);
    $path = dirname(__DIR__) . '/static/uploads/' . $name;
    if ($name === '' || !is_file($path) || filesize($path) > 15 * 1024 * 1024) {
        return null;
    }
    $info = @getimagesize($path);
    if (!$info || $info[0] * $info[1] > 40000000) {
        return null;
    }
    switch ($info[2]) {
        case IMAGETYPE_JPEG:
            $img = @imagecreatefromjpeg($path);
            break;
        case IMAGETYPE_PNG:
            $img = @imagecreatefrompng($path);
            break;
        case IMAGETYPE_GIF:
            $img = @imagecreatefromgif($path);
            break;
        case IMAGETYPE_WEBP:
            $img = function_exists('imagecreatefromwebp') ? @imagecreatefromwebp($path) : false;
            break;
        default:
            $img = false;
    }
    return $img ?: null;
}

// Emoji und Steuerzeichen raus (die Schrift kennt sie nicht), Leerraum zusammenfassen
function oys_og_clean(string $s): string
{
    $s = preg_replace('/[\x{1F000}-\x{1FAFF}\x{2600}-\x{27BF}\x{2B00}-\x{2BFF}\x{FE00}-\x{FE0F}\x{200B}-\x{200F}\x{E0000}-\x{E007F}]/u', '', $s);
    return trim((string) preg_replace('/\s+/u', ' ', (string) $s));
}

function oys_og_width(string $s, string $font, int $size): int
{
    $box = imagettfbbox($size, 0, $font, $s);
    return $box ? (int) abs($box[2] - $box[0]) : 0;
}

// Text auf höchstens $maxLines Zeilen umbrechen, die letzte bei Bedarf mit … kürzen
function oys_og_wrap(string $s, string $font, int $size, int $maxW, int $maxLines): array
{
    $words = preg_split('/\s+/u', $s, -1, PREG_SPLIT_NO_EMPTY);
    $lines = [];
    $line = '';
    foreach ($words as $i => $word) {
        $try = $line === '' ? $word : $line . ' ' . $word;
        if ($line !== '' && oys_og_width($try, $font, $size) > $maxW) {
            $lines[] = $line;
            $line = $word;
            if (count($lines) === $maxLines) {
                $lines[$maxLines - 1] = oys_og_fit($lines[$maxLines - 1] . ' ' . implode(' ', array_slice($words, $i)), $font, $size, $maxW);
                return $lines;
            }
        } else {
            $line = $try;
        }
    }
    if ($line !== '') {
        $lines[] = oys_og_fit($line, $font, $size, $maxW);
    }
    return $lines ?: [''];
}

function oys_og_fit(string $s, string $font, int $size, int $maxW): string
{
    if (oys_og_width($s, $font, $size) <= $maxW) {
        return $s;
    }
    while (mb_strlen($s) > 1 && oys_og_width($s . '…', $font, $size) > $maxW) {
        $s = mb_substr($s, 0, -1);
    }
    return rtrim($s) . '…';
}

function oys_og_rgb(string $hex): array
{
    $hex = ltrim($hex, '#');
    if (!preg_match('/^[0-9a-f]{6}$/i', $hex)) {
        return [99, 102, 241];
    }
    return [hexdec(substr($hex, 0, 2)), hexdec(substr($hex, 2, 2)), hexdec(substr($hex, 4, 2))];
}

function oys_og_mix(array $a, array $b, float $t): array
{
    return [(int) round($a[0] + ($b[0] - $a[0]) * $t), (int) round($a[1] + ($b[1] - $a[1]) * $t), (int) round($a[2] + ($b[2] - $a[2]) * $t)];
}

// Kontrastverhältnis nach WCAG
function oys_og_contrast(array $a, array $b): float
{
    $lum = function (array $c) {
        $v = array_map(function ($x) { $x /= 255; return $x <= .03928 ? $x / 12.92 : (($x + .055) / 1.055) ** 2.4; }, $c);
        return .2126 * $v[0] + .7152 * $v[1] + .0722 * $v[2];
    };
    $l1 = $lum($a);
    $l2 = $lum($b);
    return (max($l1, $l2) + .05) / (min($l1, $l2) + .05);
}
