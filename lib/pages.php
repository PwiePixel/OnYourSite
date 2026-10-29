<?php
// Seiten (bis zu 3 pro Konto): Laden, Anlegen, Speichern, Löschen.

function oys_default_settings(): array
{
    return [
        'accent' => '',
        'font' => '',
        'button' => '',
        'avatar_shape' => 'circle',
        'avatar_ring' => 'none',
        'particles' => 'none',
        'cursor_sparks' => false,
        'bg_overlay' => 45,
        'entrance' => [
            'enabled' => false,
            'text' => 'Tap to enter',
            'animation' => 'zoom',
            'music' => '',
            'music_url' => '',
            'volume' => 70,
            'loop' => true,
        ],
        'seo' => ['title' => '', 'description' => '', 'keywords' => ''],
        'custom_css' => '',
        'hide_branding' => false,
        'notify_email' => true,
        'share_button' => true,
    ];
}

function oys_page_settings(array $page): array
{
    $stored = json_decode((string) ($page['settings'] ?? ''), true);
    $stored = is_array($stored) ? $stored : [];
    $defaults = oys_default_settings();
    $settings = array_replace($defaults, $stored);
    foreach (['entrance', 'seo'] as $nested) {
        $settings[$nested] = array_replace($defaults[$nested], is_array($stored[$nested] ?? null) ? $stored[$nested] : []);
    }
    // Auch übernommenes CSS aus der alten Version nie ungeprüft ausgeben
    $settings['custom_css'] = oys_clean_css($settings['custom_css']);
    return $settings;
}

function oys_settings_normalize($in, int $userId, bool $premium, array $old): array
{
    $in = is_array($in) ? $in : [];
    $s = oys_default_settings();

    $accent = (string) ($in['accent'] ?? '');
    $s['accent'] = preg_match('/^#[0-9a-fA-F]{6}$/', $accent) ? strtolower($accent) : '';
    $s['font'] = array_key_exists((string) ($in['font'] ?? ''), oys_font_choices()) ? (string) $in['font'] : '';
    $s['button'] = oys_pick($in['button'] ?? '', ['', 'rounded', 'pill', 'square'], '');
    $s['avatar_shape'] = oys_pick($in['avatar_shape'] ?? 'circle', ['circle', 'rounded', 'square'], 'circle');
    $s['avatar_ring'] = oys_pick($in['avatar_ring'] ?? 'none', ['none', 'accent', 'rainbow', 'story', 'pulse'], 'none');
    $s['particles'] = oys_pick($in['particles'] ?? 'none', ['none', 'snow', 'confetti', 'fireflies'], 'none');
    $s['cursor_sparks'] = !empty($in['cursor_sparks']);
    $s['bg_overlay'] = max(0, min(90, (int) ($in['bg_overlay'] ?? 45)));

    $en = is_array($in['entrance'] ?? null) ? $in['entrance'] : [];
    // Musik per Link: MP3 oder YouTube (auch ohne https:// eingegeben)
    $musicUrl = oys_clean_url((string) ($en['music_url'] ?? ''));
    $s['entrance'] = [
        'enabled' => !empty($en['enabled']),
        'text' => oys_clean_text($en['text'] ?? '', 60) ?: 'Tap to enter',
        'animation' => oys_pick($en['animation'] ?? 'zoom', ['fade', 'zoom', 'curtain', 'blur', 'flip'], 'zoom'),
        'music' => oys_valid_upload($en['music'] ?? '', $userId, ['mp3', 'm4a', 'ogg', 'wav']) ?? '',
        'music_url' => preg_match('#^https://#i', $musicUrl) ? $musicUrl : '',
        'volume' => max(0, min(100, (int) ($en['volume'] ?? 70))),
        'loop' => !isset($en['loop']) || !empty($en['loop']),
    ];

    $seo = is_array($in['seo'] ?? null) ? $in['seo'] : [];
    $s['seo'] = [
        'title' => oys_clean_text($seo['title'] ?? '', 120),
        'description' => oys_clean_text($seo['description'] ?? '', 300),
        'keywords' => oys_clean_text($seo['keywords'] ?? '', 255),
    ];

    $s['custom_css'] = oys_clean_css($in['custom_css'] ?? '');
    // Branding ausblenden ist nur mit Premium möglich – sonst alten Wert behalten
    $s['hide_branding'] = $premium ? !empty($in['hide_branding']) : !empty($old['hide_branding']);
    $s['notify_email'] = !isset($in['notify_email']) || !empty($in['notify_email']);
    $s['share_button'] = !isset($in['share_button']) || !empty($in['share_button']);
    return $s;
}

// Eigenes CSS: darf nicht aus dem <style>-Tag ausbrechen
// Eigenes CSS: kann nicht aus <style> ausbrechen und lädt nichts von fremden Servern
// (url(), @import, image-set() nur mit eigenen Pfaden oder data:). Auch mit CSS-Escapes wie u\72l( nicht umgehbar.
function oys_clean_css($css): string
{
    $css = mb_substr(is_string($css) ? str_replace("\0", '', $css) : '', 0, 20000);
    if (trim($css) === '') {
        return '';
    }
    $urlFunctions = ['url', 'image', 'image-set', '-webkit-image-set', 'cross-fade', '-webkit-cross-fade', 'src'];
    $out = '';
    $word = '';    // Bezeichner direkt vor der aktuellen Stelle (für Funktionsnamen)
    $stack = [];   // offene Funktionen, z. B. ['image-set']
    $inUrl = 0;    // wie viele davon laden Adressen (url, image-set …)
    $len = strlen($css);
    for ($i = 0; $i < $len; $i++) {
        $c = $css[$i];
        if ($c === '/' && ($css[$i + 1] ?? '') === '*') {
            // Kommentare entfernen (sie trennen Wörter: u/**/rl ist kein url)
            $end = strpos($css, '*/', $i + 2);
            $i = $end === false ? $len : $end + 1;
            $out .= ' ';
            $word = '';
        } elseif ($c === '"' || $c === "'") {
            $j = $i + 1;
            while ($j < $len && $css[$j] !== $c && $css[$j] !== "\n") {
                $j += $css[$j] === '\\' ? 2 : 1;
            }
            $string = substr($css, $i, min($j, $len - 1) - $i + 1);
            $out .= $inUrl > 0 && oys_css_external(oys_css_unescape(substr($string, 1, -1))) ? $c . $c : $string;
            $i = $j;
            $word = '';
        } elseif ($c === '\\') {
            // Escapes außerhalb von Zeichenketten: Buchstaben/Ziffern auflösen, damit Tarnungen wie u\72l( auffallen
            if (preg_match('/\G\\\\([0-9a-fA-F]{1,6})[ \t\n\f]?|\G\\\\(.)/su', $css, $m, 0, $i)) {
                $char = $m[1] !== '' ? mb_chr(hexdec($m[1]) ?: 0xFFFD, 'UTF-8') : $m[2];
                if (is_string($char) && preg_match('/^[a-zA-Z0-9-]$/', $char)) {
                    $out .= $char;
                    $word .= $char;
                } else {
                    $out .= $m[0];
                    $word = '';
                }
                $i += strlen($m[0]) - 1;
            } else {
                $out .= $c;
                $word = '';
            }
        } elseif ($c === '(') {
            $name = strtolower($word);
            $word = '';
            if ($name === 'url' && preg_match('/\G\(\s*([^\s"\')][^)]*?)\s*(?:\)|\z)/', $css, $m, 0, $i)) {
                // url(ohne Anführungszeichen) – auch ohne schließende Klammer am Ende
                $out .= oys_css_external(oys_css_unescape($m[1])) ? '("")' : $m[0];
                $i += strlen($m[0]) - 1;
                continue;
            }
            $stack[] = $name;
            $inUrl += in_array($name, $urlFunctions, true) ? 1 : 0;
            $out .= $c;
        } else {
            if ($c === ')' && $stack) {
                $inUrl -= in_array(array_pop($stack), $urlFunctions, true) ? 1 : 0;
            }
            $word = ctype_alnum($c) || $c === '-' ? $word . $c : '';
            $out .= $c;
        }
    }
    $out = preg_replace('/@import\b[^;{}]*;?/i', '', $out);
    return trim(str_replace('<', '', (string) $out));
}

// Löst CSS-Escapes (\72, \") in einem Wert auf
function oys_css_unescape(string $value): string
{
    return (string) preg_replace_callback('/\\\\([0-9a-fA-F]{1,6})[ \t\n\f]?|\\\\(\n)|\\\\(.)/su', function ($m) {
        if ($m[1] !== '') {
            return (string) mb_chr(hexdec($m[1]) ?: 0xFFFD, 'UTF-8');
        }
        return ($m[2] ?? '') !== '' ? '' : ($m[3] ?? '');
    }, $value);
}

// Zeigt eine Adresse in CSS auf einen fremden Server? (Erlaubt: /pfad, relativ, #id, data:)
function oys_css_external(string $url): bool
{
    $url = (string) preg_replace('/[\x00-\x20\x7f]+/', '', $url);
    if ($url === '' || $url[0] === '#' || stripos($url, 'data:') === 0) {
        return false;
    }
    return (bool) preg_match('#^([a-z][a-z0-9+.\-]*:|[/\\\\]{2})#i', $url);
}

// ---------------------------------------------------------------
// Laden
// ---------------------------------------------------------------

function oys_load_page(PDO $pdo, int $id): ?array
{
    $stmt = $pdo->prepare('SELECT * FROM pages WHERE id = ?');
    $stmt->execute([$id]);
    return $stmt->fetch() ?: null;
}

function oys_load_page_by_slug(PDO $pdo, string $slug): ?array
{
    $stmt = $pdo->prepare('SELECT * FROM pages WHERE slug = ? LIMIT 1');
    $stmt->execute([$slug]);
    return $stmt->fetch() ?: null;
}

function oys_user_pages(PDO $pdo, int $userId): array
{
    $stmt = $pdo->prepare('SELECT * FROM pages WHERE user_id = ? ORDER BY position ASC, id ASC');
    $stmt->execute([$userId]);
    return $stmt->fetchAll();
}

function oys_load_blocks(PDO $pdo, int $pageId): array
{
    $stmt = $pdo->prepare('SELECT * FROM page_blocks WHERE page_id = ? ORDER BY position ASC, id ASC');
    $stmt->execute([$pageId]);
    $blocks = [];
    foreach ($stmt->fetchAll() as $row) {
        $blocks[] = oys_block_from_row($row);
    }
    return $blocks;
}

function oys_block_from_row(array $row): array
{
    $data = json_decode((string) ($row['data'] ?? ''), true);
    $schedule = json_decode((string) ($row['schedule'] ?? ''), true);
    return [
        'id' => (int) $row['id'],
        'type' => $row['type'],
        'is_visible' => (int) $row['is_visible'],
        'data' => is_array($data) ? $data : [],
        'schedule' => is_array($schedule) ? $schedule : null,
        'protection' => $row['protection'] ?: 'none',
        'has_password' => !empty($row['password_hash']),
        'password_hash' => $row['password_hash'] ?? null,
        'effect' => $row['effect'] ?: 'none',
        'clicks' => (int) $row['clicks'],
    ];
}

// Form für den Editor (ohne Passwort-Hash)
function oys_block_for_editor(array $b): array
{
    return [
        'id' => $b['id'],
        'type' => $b['type'],
        'visible' => (bool) $b['is_visible'],
        'data' => (object) $b['data'],
        'schedule' => $b['schedule'] ?: ['enabled' => false, 'days' => [], 'from' => '', 'to' => '', 'start' => '', 'end' => ''],
        'protection' => $b['protection'],
        'has_password' => (bool) ($b['has_password'] ?? false),
        'password' => '',
        'effect' => $b['effect'],
        'clicks' => (int) ($b['clicks'] ?? 0),
    ];
}

function oys_page_for_editor(array $page): array
{
    return [
        'id' => (int) $page['id'],
        'slug' => $page['slug'],
        'title' => $page['title'],
        'subtitle' => $page['subtitle'],
        'bio' => (string) $page['bio'],
        'avatar' => (string) $page['avatar'],
        'bg_image' => (string) $page['bg_image'],
        'theme' => oys_theme_key($page['theme']),
        'layout' => oys_layout_key($page['layout']),
        'address_mode' => $page['address_mode'] === 'path' ? 'path' : 'subdomain',
        'settings' => oys_page_settings($page),
        'urls' => oys_page_urls($page),
        'url' => oys_page_url($page),
        'og' => oys_og_supported() ? oys_og_url($page) : '',
    ];
}

// ---------------------------------------------------------------
// Anlegen
// ---------------------------------------------------------------

function oys_create_page(PDO $pdo, int $userId, string $slug, string $title): int
{
    $count = $pdo->prepare('SELECT COUNT(*) FROM pages WHERE user_id = ?');
    $count->execute([$userId]);
    $position = (int) $count->fetchColumn();
    $now = date('Y-m-d H:i:s');

    $pdo->prepare('INSERT INTO pages (user_id, slug, position, title, subtitle, bio, theme, layout, address_mode, settings, created_at, updated_at)
        VALUES (?, ?, ?, ?, \'\', \'\', ?, \'buttons\', \'subdomain\', ?, ?, ?)')
        ->execute([$userId, $slug, $position, mb_substr($title, 0, 120), OYS_DEFAULT_THEME, json_encode(oys_default_settings(), JSON_UNESCAPED_UNICODE), $now, $now]);
    $pageId = (int) $pdo->lastInsertId();

    // Startinhalt, damit niemand vor einer leeren Seite sitzt
    $starter = [
        ['socials', ['items' => [['p' => 'instagram', 'v' => ''], ['p' => 'tiktok', 'v' => ''], ['p' => 'youtube', 'v' => '']], 'style' => 'icons']],
        ['link', ['title' => 'My first link', 'url' => '', 'subtitle' => '', 'icon' => '', 'thumb' => '', 'featured' => false]],
    ];
    $insert = $pdo->prepare('INSERT INTO page_blocks (page_id, type, position, is_visible, data, created_at) VALUES (?, ?, ?, 1, ?, ?)');
    foreach ($starter as $i => [$type, $data]) {
        $insert->execute([$pageId, $type, $i, json_encode($data, JSON_UNESCAPED_UNICODE), $now]);
    }
    return $pageId;
}

// ---------------------------------------------------------------
// Speichern (aus dem Editor)
// ---------------------------------------------------------------

function oys_save_page(PDO $pdo, array $page, array $input, int $userId, bool $premium): array
{
    $p = is_array($input['page'] ?? null) ? $input['page'] : [];
    $oldSettings = oys_page_settings($page);
    $oldFiles = oys_page_files($page, oys_load_blocks($pdo, (int) $page['id']));

    $fields = [
        'title' => oys_clean_text($p['title'] ?? '', 120),
        'subtitle' => oys_clean_text($p['subtitle'] ?? '', 160),
        'bio' => oys_clean_text($p['bio'] ?? '', 1000, true),
        'avatar' => oys_valid_upload($p['avatar'] ?? '', $userId, OYS_IMAGE_EXTS),
        'bg_image' => oys_valid_upload($p['bg_image'] ?? '', $userId, OYS_IMAGE_EXTS),
        'theme' => oys_theme_key($p['theme'] ?? OYS_DEFAULT_THEME),
        'layout' => oys_layout_key($p['layout'] ?? 'buttons'),
        'settings' => json_encode(oys_settings_normalize($p['settings'] ?? [], $userId, $premium, $oldSettings), JSON_UNESCAPED_UNICODE),
        'updated_at' => date('Y-m-d H:i:s'),
    ];

    $existing = [];
    $stmt = $pdo->prepare('SELECT * FROM page_blocks WHERE page_id = ?');
    $stmt->execute([$page['id']]);
    foreach ($stmt->fetchAll() as $row) {
        $existing[(int) $row['id']] = $row;
    }

    $warnings = [];
    $idMap = [];
    $kept = [];
    $now = date('Y-m-d H:i:s');

    $pdo->beginTransaction();
    try {
        $sets = implode(', ', array_map(fn($k) => "$k = ?", array_keys($fields)));
        $pdo->prepare("UPDATE pages SET $sets WHERE id = ?")->execute([...array_values($fields), $page['id']]);

        $update = $pdo->prepare('UPDATE page_blocks SET type = ?, position = ?, is_visible = ?, data = ?, schedule = ?, protection = ?, password_hash = ?, effect = ? WHERE id = ? AND page_id = ?');
        $insert = $pdo->prepare('INSERT INTO page_blocks (page_id, type, position, is_visible, data, schedule, protection, password_hash, effect, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');

        $position = 0;
        foreach (array_slice(is_array($input['blocks'] ?? null) ? $input['blocks'] : [], 0, 150) as $in) {
            if (!is_array($in)) {
                continue;
            }
            $id = $in['id'] ?? null;
            $old = (is_int($id) || ctype_digit((string) $id)) && isset($existing[(int) $id]) ? $existing[(int) $id] : null;
            $norm = oys_block_normalize($in, $userId, $old);
            if (!$norm) {
                continue;
            }
            if ($norm['warning']) {
                $warnings[] = $norm['warning'];
            }
            $values = [
                $norm['type'], $position++, $norm['is_visible'],
                json_encode($norm['data'], JSON_UNESCAPED_UNICODE),
                $norm['schedule'] ? json_encode($norm['schedule']) : null,
                $norm['protection'], $norm['password_hash'], $norm['effect'],
            ];
            if ($old) {
                $update->execute([...$values, $old['id'], $page['id']]);
                $kept[(int) $old['id']] = true;
            } else {
                $insert->execute([$page['id'], ...$values, $now]);
                $newId = (int) $pdo->lastInsertId();
                $kept[$newId] = true;
                if ($id !== null) {
                    $idMap[(string) $id] = $newId;
                }
            }
        }

        $removed = array_diff(array_keys($existing), array_keys($kept));
        if ($removed) {
            $in = implode(',', array_map('intval', $removed));
            $pdo->exec("DELETE FROM page_blocks WHERE page_id = " . (int) $page['id'] . " AND id IN ($in)");
            $pdo->exec("DELETE FROM block_clicks_daily WHERE block_id IN ($in)");
        }
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }

    $fresh = oys_load_page($pdo, (int) $page['id']);
    oys_cleanup_files($pdo, $userId, $oldFiles);

    return [
        'page' => $fresh,
        'blocks' => oys_load_blocks($pdo, (int) $page['id']),
        'idmap' => (object) $idMap,
        'warnings' => array_values(array_unique($warnings)),
    ];
}

// Alle Upload-Dateien, die eine Seite verwendet
function oys_page_files(array $page, array $blocks): array
{
    $files = [];
    $settings = oys_page_settings($page);
    foreach ([$page['avatar'] ?? '', $page['bg_image'] ?? '', $settings['entrance']['music'] ?? ''] as $f) {
        if ($f) $files[] = $f;
    }
    foreach ($blocks as $b) {
        $d = $b['data'];
        foreach (['thumb', 'src'] as $k) {
            if (!empty($d[$k]) && is_string($d[$k])) $files[] = $d[$k];
        }
        foreach ((array) ($d['images'] ?? []) as $img) {
            if (!empty($img['src'])) $files[] = $img['src'];
        }
    }
    return array_values(array_unique($files));
}

// Darf der eingebaute Kalender gezeigt werden? Nur mit aktivem Termin-Block, der auf ihn zeigt.
// '' = frei zugänglich, Schlüssel = über einen geschützten Termin-Block freigegeben, null = nein.
function oys_calendar_access(PDO $pdo, array $page, string $given): ?string
{
    $now = new DateTimeImmutable('now', new DateTimeZone(oys_config('timezone', 'Europe/Berlin')));
    $access = null;
    foreach (oys_load_blocks($pdo, (int) $page['id']) as $b) {
        if ($b['type'] !== 'booking' || !$b['is_visible'] || !oys_schedule_active($b['schedule'], $now) || !oys_booking_is_internal($b['data'], $page)) {
            continue;
        }
        if ($b['protection'] === 'none') {
            return '';
        }
        $key = oys_calendar_key($page, $b);
        if ($given !== '' && hash_equals($key, $given)) {
            $access = $key;
        }
    }
    return $access;
}

// Alle Dateien, die eine Seite des Nutzers verwendet (Name => true)
function oys_used_files(PDO $pdo, int $userId): array
{
    $used = oys_code_used_uploads($pdo, $userId);
    foreach (oys_user_pages($pdo, $userId) as $p) {
        foreach (oys_page_files($p, oys_load_blocks($pdo, (int) $p['id'])) as $f) {
            $used[$f] = true;
        }
    }
    return $used;
}

// Löscht Dateien, die von keiner Seite des Nutzers mehr verwendet werden
function oys_cleanup_files(PDO $pdo, int $userId, array $candidates): void
{
    if (!$candidates) {
        return;
    }
    $used = oys_used_files($pdo, $userId);
    $dir = oys_uploads_dir() . '/';
    foreach ($candidates as $file) {
        if (!isset($used[$file]) && oys_valid_upload($file, $userId) && is_file($dir . $file)) {
            @unlink($dir . $file);
        }
    }
}

function oys_delete_page(PDO $pdo, array $page): void
{
    $id = (int) $page['id'];
    $files = oys_page_files($page, oys_load_blocks($pdo, $id));
    $pdo->beginTransaction();
    $pdo->prepare('DELETE FROM block_clicks_daily WHERE page_id = ?')->execute([$id]);
    $pdo->prepare('DELETE FROM stats_daily WHERE page_id = ?')->execute([$id]);
    $pdo->prepare('DELETE FROM page_blocks WHERE page_id = ?')->execute([$id]);
    $pdo->prepare('DELETE FROM messages WHERE page_id = ?')->execute([$id]);
    $pdo->prepare('DELETE FROM pages WHERE id = ?')->execute([$id]);
    $pdo->commit();
    oys_cleanup_files($pdo, (int) $page['user_id'], $files);
}

// Hält users.username (für Admin & alte Mail-Vorlagen) auf der ersten Seite
function oys_sync_username(PDO $pdo, int $userId): void
{
    $pages = oys_user_pages($pdo, $userId);
    if ($pages) {
        try {
            $pdo->prepare('UPDATE users SET username = ? WHERE id = ?')->execute([$pages[0]['slug'], $userId]);
        } catch (PDOException $e) {
            error_log('username sync failed: ' . $e->getMessage());
        }
    }
}
