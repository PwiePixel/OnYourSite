<?php
// Blöcke einer Seite: Typen, Prüfung der Eingaben, Einbettungen und Zeitsteuerung.

function oys_block_types(): array
{
    return [
        'link'      => 'Link',
        'socials'   => 'Social icons',
        'heading'   => 'Heading',
        'text'      => 'Text',
        'divider'   => 'Divider',
        'image'     => 'Image',
        'gallery'   => 'Gallery',
        'embed'     => 'Video & music',
        'countdown' => 'Countdown',
        'contact'   => 'Contact form',
        'booking'   => 'Book a meeting',
        'file'      => 'File',
    ];
}

// Blöcke, auf die man klicken kann (zählen in der Statistik)
function oys_block_is_clickable(string $type): bool
{
    return in_array($type, ['link', 'booking', 'file'], true);
}

const OYS_EFFECTS = ['none', 'shine', 'wobble', 'pulse'];
const OYS_PROTECTIONS = ['none', 'password', 'age'];
const OYS_LINK_PASSWORD_MIN = 6;

// Zeigt ein Termin-Block auf den eingebauten Kalender dieser Seite? ('', '/kalender' oder die volle eigene Adresse)
function oys_booking_is_internal(array $data, array $page): bool
{
    $url = strtolower(rtrim(trim((string) ($data['url'] ?? '')), '/'));
    if ($url === '' || $url === '/kalender') {
        return true;
    }
    $url = preg_replace('#^https?://#', '', $url);
    foreach (oys_page_urls($page) as $own) {
        if ($url === strtolower(preg_replace('#^https?://#', '', $own)) . '/kalender') {
            return true;
        }
    }
    return false;
}

// Schlüssel, mit dem ein geschützter Termin-Block den Kalender freigibt (ändert sich mit dem Passwort)
function oys_calendar_key(array $page, array $block): string
{
    return substr(oys_hmac('calendar|' . $page['id'] . '|' . $block['id'] . '|' . ($block['password_hash'] ?? '')), 0, 24);
}

function oys_pick($value, array $allowed, $default)
{
    return in_array($value, $allowed, true) ? $value : $default;
}

// Prüft, ob ein Dateiname aus unserem Upload-Ordner stammt und zum Nutzer gehört.
function oys_valid_upload($file, int $userId, array $exts = []): ?string
{
    $file = is_string($file) ? basename(trim($file)) : '';
    if ($file === '' || !preg_match('/^[a-z]+_(\d+)_[A-Za-z0-9_]+\.([a-z0-9]{2,5})$/', $file, $m)) {
        return null;
    }
    if ((int) $m[1] !== $userId) {
        return null;
    }
    if ($exts && !in_array(strtolower($m[2]), $exts, true)) {
        return null;
    }
    return $file;
}

const OYS_IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp'];

// Säubert einen Block aus dem Editor. $existing = bisheriger Block aus der DB (oder null).
// Gibt ['type','is_visible','data','schedule','protection','password_hash','effect','warning'] zurück.
function oys_block_normalize(array $in, int $userId, ?array $existing = null, bool $forPreview = false): ?array
{
    $type = (string) ($in['type'] ?? '');
    if (!array_key_exists($type, oys_block_types())) {
        return null;
    }
    $d = is_array($in['data'] ?? null) ? $in['data'] : [];
    $data = [];
    $warning = null;

    switch ($type) {
        case 'link':
            $data['title'] = oys_clean_text($d['title'] ?? '', 120);
            $data['url'] = oys_clean_url($d['url'] ?? '', true);
            $data['subtitle'] = oys_clean_text($d['subtitle'] ?? '', 90);
            $data['icon'] = oys_clean_icon($d['icon'] ?? '');
            $data['thumb'] = oys_valid_upload($d['thumb'] ?? '', $userId, OYS_IMAGE_EXTS) ?? '';
            $data['featured'] = !empty($d['featured']);
            break;

        case 'socials':
            $items = [];
            foreach (array_slice(is_array($d['items'] ?? null) ? $d['items'] : [], 0, 30) as $item) {
                $p = (string) ($item['p'] ?? '');
                if (!isset(oys_brands()[$p])) {
                    continue;
                }
                $items[] = ['p' => $p, 'v' => oys_clean_text($item['v'] ?? '', 200)];
            }
            $data['items'] = $items;
            $data['style'] = oys_pick($d['style'] ?? 'icons', ['icons', 'brand', 'pills'], 'icons');
            break;

        case 'heading':
            $data['text'] = oys_clean_text($d['text'] ?? '', 120);
            $data['size'] = oys_pick($d['size'] ?? 'm', ['s', 'm', 'l'], 'm');
            $data['align'] = oys_pick($d['align'] ?? 'center', ['left', 'center'], 'center');
            break;

        case 'text':
            $data['text'] = oys_clean_text($d['text'] ?? '', 3000, true);
            $data['align'] = oys_pick($d['align'] ?? 'center', ['left', 'center'], 'center');
            break;

        case 'divider':
            $data['style'] = oys_pick($d['style'] ?? 'line', ['line', 'dots', 'space', 'wave'], 'line');
            break;

        case 'image':
            $data['src'] = oys_valid_upload($d['src'] ?? '', $userId, OYS_IMAGE_EXTS) ?? '';
            $data['alt'] = oys_clean_text($d['alt'] ?? '', 150);
            $data['caption'] = oys_clean_text($d['caption'] ?? '', 150);
            $data['url'] = oys_clean_url($d['url'] ?? '');
            $data['ratio'] = oys_pick($d['ratio'] ?? 'auto', ['auto', 'square', 'wide', 'portrait'], 'auto');
            break;

        case 'gallery':
            $images = [];
            foreach (array_slice(is_array($d['images'] ?? null) ? $d['images'] : [], 0, 20) as $img) {
                $src = oys_valid_upload($img['src'] ?? '', $userId, OYS_IMAGE_EXTS);
                if ($src) {
                    $images[] = ['src' => $src, 'caption' => oys_clean_text($img['caption'] ?? '', 120)];
                }
            }
            $data['images'] = $images;
            $data['ratio'] = oys_pick($d['ratio'] ?? 'square', ['square', 'portrait', 'wide'], 'square');
            $data['autoplay'] = !empty($d['autoplay']);
            break;

        case 'embed':
            $data['url'] = oys_clean_url($d['url'] ?? '');
            $data['title'] = oys_clean_text($d['title'] ?? '', 100);
            $data['provider'] = oys_pick($d['provider'] ?? '', ['youtube', 'twitch', 'spotify', ''], '');
            $parsed = $data['url'] !== '' ? oys_parse_embed($data['url']) : null;
            if ($data['url'] !== '' && !$parsed) {
                $warning = 'This address can’t be embedded (supported: YouTube, Twitch, Spotify).';
            }
            if ($parsed) {
                $data['provider'] = $parsed['provider'];
            }
            break;

        case 'countdown':
            $data['title'] = oys_clean_text($d['title'] ?? '', 100);
            $target = (string) ($d['target'] ?? '');
            $data['target'] = preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/', $target) ? $target : '';
            $data['done_text'] = oys_clean_text($d['done_text'] ?? '', 100);
            $data['url'] = oys_clean_url($d['url'] ?? '');
            $data['url_label'] = oys_clean_text($d['url_label'] ?? '', 60);
            break;

        case 'contact':
            $data['title'] = oys_clean_text($d['title'] ?? '', 80);
            $data['intro'] = oys_clean_text($d['intro'] ?? '', 300, true);
            $data['button'] = oys_clean_text($d['button'] ?? '', 40);
            $data['success'] = oys_clean_text($d['success'] ?? '', 150);
            break;

        case 'booking':
            $data['title'] = oys_clean_text($d['title'] ?? '', 80);
            $data['url'] = oys_clean_url($d['url'] ?? '/kalender', true) ?: '/kalender';
            break;

        case 'file':
            $data['title'] = oys_clean_text($d['title'] ?? '', 80);
            $data['src'] = oys_valid_upload($d['src'] ?? '', $userId, ['pdf', 'vcf', 'zip']) ?? '';
            break;
    }

    $protection = oys_pick($in['protection'] ?? 'none', OYS_PROTECTIONS, 'none');
    $passwordHash = null;
    if (!oys_block_is_clickable($type)) {
        $protection = 'none';
    }
    $visible = !isset($in['visible']) || !empty($in['visible']) ? 1 : 0;
    if ($protection === 'password') {
        $newPassword = is_string($in['password'] ?? null) ? trim($in['password']) : '';
        if ($newPassword !== '' && mb_strlen($newPassword) < OYS_LINK_PASSWORD_MIN) {
            $newPassword = '';
            $warning = 'Link passwords need at least ' . OYS_LINK_PASSWORD_MIN . ' characters – the new password wasn’t saved.';
        }
        if ($newPassword !== '') {
            // In der Vorschau wird nicht gehasht (zu langsam bei jedem Tastendruck)
            $passwordHash = $forPreview ? 'preview' : password_hash(mb_substr($newPassword, 0, 100), PASSWORD_DEFAULT);
        } elseif ($forPreview) {
            $passwordHash = 'preview';
        } elseif ($existing && !empty($existing['password_hash'])) {
            $passwordHash = $existing['password_hash'];
        } else {
            // Nie stillschweigend ungeschützt veröffentlichen: ohne Passwort bleibt der Link ausgeblendet
            $visible = 0;
            $warning = 'The protected link has no password, so it’s been hidden. Set a password and show it again.';
        }
    }

    return [
        'type' => $type,
        'is_visible' => $visible,
        'data' => $data,
        'schedule' => oys_schedule_normalize($in['schedule'] ?? null),
        'protection' => $protection,
        'password_hash' => $passwordHash,
        'effect' => oys_block_is_clickable($type) ? oys_pick($in['effect'] ?? 'none', OYS_EFFECTS, 'none') : 'none',
        'warning' => $warning,
    ];
}

function oys_clean_icon($icon): string
{
    $icon = trim(is_string($icon) ? $icon : '');
    if ($icon === '' || $icon === 'none') {
        return $icon;
    }
    if (strpos($icon, 'brand:') === 0 && isset(oys_brands()[substr($icon, 6)])) {
        return $icon;
    }
    if (preg_match('/^bx[sl]? bx[sl]?-[a-z0-9-]+$/', $icon)) {
        return $icon;
    }
    return '';
}

// ---------------------------------------------------------------
// Einbettungen: YouTube, Twitch, Spotify
// ---------------------------------------------------------------

function oys_parse_embed(string $url): ?array
{
    $parts = parse_url($url);
    if (!$parts || empty($parts['host'])) {
        if (preg_match('/^spotify:(track|album|playlist|episode|show|artist):([A-Za-z0-9]{10,40})$/', $url, $m)) {
            return ['provider' => 'spotify', 'kind' => $m[1], 'id' => $m[2]];
        }
        return null;
    }
    $host = strtolower(preg_replace('/^(www|m|music)\./', '', $parts['host']));
    $path = $parts['path'] ?? '';
    parse_str($parts['query'] ?? '', $query);

    // YouTube
    if (in_array($host, ['youtube.com', 'youtu.be', 'youtube-nocookie.com'], true)) {
        $id = null;
        if ($host === 'youtu.be') {
            $id = trim($path, '/');
        } elseif (!empty($query['v'])) {
            $id = $query['v'];
        } elseif (preg_match('#^/(embed|shorts|live|v)/([A-Za-z0-9_-]{11})#', $path, $m)) {
            $id = $m[2];
        }
        $start = 0;
        if (!empty($query['t'])) {
            $t = (string) $query['t'];
            if (preg_match('/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/', $t, $tm)) {
                $start = ((int) ($tm[1] ?? 0)) * 3600 + ((int) ($tm[2] ?? 0)) * 60 + (int) ($tm[3] ?? 0);
            }
        }
        if ($id && preg_match('/^[A-Za-z0-9_-]{11}$/', $id)) {
            return ['provider' => 'youtube', 'kind' => 'video', 'id' => $id, 'start' => $start];
        }
        if (!empty($query['list']) && preg_match('/^[A-Za-z0-9_-]{10,64}$/', $query['list'])) {
            return ['provider' => 'youtube', 'kind' => 'playlist', 'id' => $query['list']];
        }
        return null;
    }

    // Twitch
    if ($host === 'clips.twitch.tv') {
        $slug = trim($path, '/');
        return preg_match('/^[A-Za-z0-9_-]{3,100}$/', $slug) ? ['provider' => 'twitch', 'kind' => 'clip', 'id' => $slug] : null;
    }
    if ($host === 'twitch.tv') {
        if (preg_match('#^/videos/(\d+)#', $path, $m)) {
            return ['provider' => 'twitch', 'kind' => 'video', 'id' => $m[1]];
        }
        if (preg_match('#^/[A-Za-z0-9_]{3,25}/clip/([A-Za-z0-9_-]{3,100})#', $path, $m)) {
            return ['provider' => 'twitch', 'kind' => 'clip', 'id' => $m[1]];
        }
        if (preg_match('#^/([A-Za-z0-9_]{3,25})/?$#', $path, $m)) {
            return ['provider' => 'twitch', 'kind' => 'channel', 'id' => strtolower($m[1])];
        }
        return null;
    }

    // Spotify
    if ($host === 'open.spotify.com') {
        if (preg_match('#^/(?:intl-[a-z-]+/)?(?:embed/)?(track|album|playlist|episode|show|artist)/([A-Za-z0-9]{10,40})#', $path, $m)) {
            return ['provider' => 'spotify', 'kind' => $m[1], 'id' => $m[2]];
        }
    }
    return null;
}

// Adresse für das iframe (Twitch bekommt "parent" erst im Browser angehängt)
function oys_embed_src(array $embed): string
{
    switch ($embed['provider']) {
        case 'youtube':
            if ($embed['kind'] === 'playlist') {
                return 'https://www.youtube-nocookie.com/embed/videoseries?list=' . rawurlencode($embed['id']) . '&autoplay=1&rel=0';
            }
            $start = !empty($embed['start']) ? '&start=' . (int) $embed['start'] : '';
            return 'https://www.youtube-nocookie.com/embed/' . rawurlencode($embed['id']) . '?autoplay=1&rel=0&playsinline=1' . $start;
        case 'twitch':
            if ($embed['kind'] === 'clip') {
                return 'https://clips.twitch.tv/embed?clip=' . rawurlencode($embed['id']) . '&autoplay=true';
            }
            if ($embed['kind'] === 'video') {
                return 'https://player.twitch.tv/?video=' . rawurlencode($embed['id']) . '&autoplay=true';
            }
            return 'https://player.twitch.tv/?channel=' . rawurlencode($embed['id']) . '&autoplay=true';
        case 'spotify':
            return 'https://open.spotify.com/embed/' . $embed['kind'] . '/' . rawurlencode($embed['id']) . '?utm_source=oembed';
    }
    return '';
}

// ---------------------------------------------------------------
// Zeitsteuerung
// ---------------------------------------------------------------

function oys_schedule_normalize($in): ?array
{
    if (!is_array($in) || empty($in['enabled'])) {
        return null;
    }
    $days = [];
    foreach ((array) ($in['days'] ?? []) as $day) {
        $day = (int) $day;
        if ($day >= 1 && $day <= 7) {
            $days[$day] = $day;
        }
    }
    ksort($days);
    $time = fn($v) => is_string($v) && preg_match('/^([01]\d|2[0-3]):[0-5]\d$/', $v) ? $v : '';
    $date = fn($v) => is_string($v) && preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/', $v) ? $v : '';
    return [
        'enabled' => true,
        'days' => array_values($days),
        'from' => $time($in['from'] ?? ''),
        'to' => $time($in['to'] ?? ''),
        'start' => $date($in['start'] ?? ''),
        'end' => $date($in['end'] ?? ''),
    ];
}

// Ist der Block gerade sichtbar? $now in der Zeitzone der Seite.
function oys_schedule_active(?array $s, DateTimeImmutable $now): bool
{
    if (!$s || empty($s['enabled'])) {
        return true;
    }
    $tz = $now->getTimezone();
    if (!empty($s['start']) && $now < new DateTimeImmutable($s['start'], $tz)) {
        return false;
    }
    if (!empty($s['end']) && $now >= new DateTimeImmutable($s['end'], $tz)) {
        return false;
    }
    $days = $s['days'] ?? [];
    $allDays = !$days || count($days) === 7;
    $dayOk = fn(DateTimeImmutable $d) => $allDays || in_array((int) $d->format('N'), $days, true);
    $time = $now->format('H:i');
    $from = $s['from'] ?? '';
    $to = $s['to'] ?? '';

    if ($from !== '' && $to !== '') {
        if ($from <= $to) {
            return $dayOk($now) && $time >= $from && $time < $to;
        }
        // Über Mitternacht, z. B. 22:00–02:00
        if ($time >= $from) {
            return $dayOk($now);
        }
        if ($time < $to) {
            return $dayOk($now->modify('-1 day'));
        }
        return false;
    }
    if ($from !== '') {
        return $dayOk($now) && $time >= $from;
    }
    if ($to !== '') {
        return $dayOk($now) && $time < $to;
    }
    return $dayOk($now);
}
