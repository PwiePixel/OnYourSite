<?php
// Updates (Changelog), Roadmap mit Meilensteinen und Ankündigungen in Discord.
// Öffentlich unter /updates, gepflegt im Admin-Panel.

const OYS_UPDATE_CATEGORIES = [
    'new'      => ['label' => 'New',      'color' => '#22c55e'],
    'improved' => ['label' => 'Improved', 'color' => '#818cf8'],
    'fixed'    => ['label' => 'Fixed',    'color' => '#f59e0b'],
    'news'     => ['label' => 'News',     'color' => '#ec4899'],
];

const OYS_MILESTONE_STATUSES = [
    'now'     => ['label' => 'Working on now', 'short' => 'In progress', 'color' => '#22c55e'],
    'next'    => ['label' => 'Up next',        'short' => 'Up next',     'color' => '#818cf8'],
    'planned' => ['label' => 'Later',          'short' => 'Planned',     'color' => '#a1a1aa'],
    'done'    => ['label' => 'Shipped',        'short' => 'Shipped',     'color' => '#f59e0b'],
];

// ---------------------------------------------------------------
// Updates
// ---------------------------------------------------------------

function oys_update_from_row(array $row): array
{
    return [
        'id' => (int) $row['id'],
        'title' => (string) $row['title'],
        'body' => (string) ($row['body'] ?? ''),
        'version' => (string) ($row['version'] ?? ''),
        'category' => isset(OYS_UPDATE_CATEGORIES[$row['category'] ?? '']) ? $row['category'] : 'news',
        'milestone_id' => $row['milestone_id'] !== null ? (int) $row['milestone_id'] : null,
        'is_published' => (bool) $row['is_published'],
        'published_at' => $row['published_at'],
        'discord_message_id' => (string) ($row['discord_message_id'] ?? ''),
        'discord_target' => (string) ($row['discord_target'] ?? ''),
        'created_at' => $row['created_at'],
        'updated_at' => $row['updated_at'],
    ];
}

// Öffentlich: nur veröffentlichte, neueste zuerst. Im Admin: Entwürfe oben.
function oys_updates_list(PDO $pdo, bool $publishedOnly, int $limit = 100, int $offset = 0): array
{
    $sql = $publishedOnly
        ? 'SELECT * FROM updates WHERE is_published = 1 ORDER BY published_at DESC, id DESC'
        : 'SELECT * FROM updates ORDER BY is_published ASC, COALESCE(published_at, created_at) DESC, id DESC';
    $sql .= ' LIMIT ' . max(1, $limit) . ' OFFSET ' . max(0, $offset);
    return array_map('oys_update_from_row', $pdo->query($sql)->fetchAll());
}

function oys_updates_count(PDO $pdo, bool $publishedOnly): int
{
    return (int) $pdo->query('SELECT COUNT(*) FROM updates' . ($publishedOnly ? ' WHERE is_published = 1' : ''))->fetchColumn();
}

function oys_update_get(PDO $pdo, int $id): ?array
{
    $stmt = $pdo->prepare('SELECT * FROM updates WHERE id = ?');
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    return $row ? oys_update_from_row($row) : null;
}

// Speichert ein Update aus dem Admin-Formular. Gibt [id, fehler] zurück.
function oys_update_save(PDO $pdo, array $in, ?array $existing): array
{
    $title = oys_clean_text($in['title'] ?? '', 160);
    if ($title === '') {
        return [null, 'Please enter a title.'];
    }
    $body = oys_clean_text($in['body'] ?? '', 20000, true);
    $version = preg_replace('/[^\w.\- ]+/u', '', oys_clean_text($in['version'] ?? '', 40));
    $category = isset(OYS_UPDATE_CATEGORIES[$in['category'] ?? '']) ? $in['category'] : 'new';
    $milestoneId = (int) ($in['milestone_id'] ?? 0);
    if ($milestoneId && !oys_milestone_get($pdo, $milestoneId)) {
        $milestoneId = 0;
    }
    $publish = !empty($in['publish']);

    // Datum: frei wählbar (für ältere Einträge), sonst heute bzw. das bisherige Datum
    $date = (string) ($in['date'] ?? '');
    $publishedAt = $existing['published_at'] ?? null;
    if (preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $date, $m) && checkdate((int) $m[2], (int) $m[3], (int) $m[1])) {
        if (!$publishedAt || substr($publishedAt, 0, 10) !== $date) {
            // Entwurf mit dem heutigen (vorausgefüllten) Datum: der Zeitpunkt kommt erst beim Veröffentlichen
            $publishedAt = !$publish && $date === date('Y-m-d') ? null
                : $date . ' ' . ($date === date('Y-m-d') ? date('H:i:s') : '12:00:00');
        }
    }
    if ($publish && !$publishedAt) {
        $publishedAt = date('Y-m-d H:i:s');
    }

    $now = date('Y-m-d H:i:s');
    $params = [$title, $body, $version, $category, $milestoneId ?: null, $publish ? 1 : 0, $publishedAt, $now];
    if ($existing) {
        $pdo->prepare('UPDATE updates SET title = ?, body = ?, version = ?, category = ?, milestone_id = ?, is_published = ?, published_at = ?, updated_at = ? WHERE id = ?')
            ->execute(array_merge($params, [$existing['id']]));
        return [(int) $existing['id'], null];
    }
    $pdo->prepare('INSERT INTO updates (title, body, version, category, milestone_id, is_published, published_at, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        ->execute(array_merge($params, [$now]));
    return [(int) $pdo->lastInsertId(), null];
}

function oys_update_set_published(PDO $pdo, array $update, bool $published): void
{
    $publishedAt = $update['published_at'] ?: ($published ? date('Y-m-d H:i:s') : null);
    $pdo->prepare('UPDATE updates SET is_published = ?, published_at = ?, updated_at = ? WHERE id = ?')
        ->execute([$published ? 1 : 0, $publishedAt, date('Y-m-d H:i:s'), $update['id']]);
}

function oys_update_delete(PDO $pdo, int $id): void
{
    $pdo->prepare('DELETE FROM updates WHERE id = ?')->execute([$id]);
}

// ---------------------------------------------------------------
// Roadmap: Meilensteine mit Teilaufgaben
// ---------------------------------------------------------------

function oys_milestone_from_row(array $row): array
{
    return [
        'id' => (int) $row['id'],
        'title' => (string) $row['title'],
        'description' => (string) ($row['description'] ?? ''),
        'status' => isset(OYS_MILESTONE_STATUSES[$row['status'] ?? '']) ? $row['status'] : 'planned',
        'target' => (string) ($row['target'] ?? ''),
        'position' => (int) $row['position'],
        'is_public' => (bool) $row['is_public'],
        'started_at' => $row['started_at'],
        'done_at' => $row['done_at'],
        'created_at' => $row['created_at'],
        'updated_at' => $row['updated_at'],
        'tasks' => [],
        'progress' => null,
    ];
}

function oys_milestone_get(PDO $pdo, int $id): ?array
{
    $stmt = $pdo->prepare('SELECT * FROM milestones WHERE id = ?');
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    if (!$row) {
        return null;
    }
    $ms = oys_milestone_from_row($row);
    $list = oys_milestones_attach_tasks($pdo, [$ms]);
    return $list[0];
}

// Alle Meilensteine, sortiert nach Status (now, next, planned, done) und Position – mit Aufgaben und Fortschritt
function oys_milestones(PDO $pdo, bool $publicOnly): array
{
    $sql = 'SELECT * FROM milestones' . ($publicOnly ? ' WHERE is_public = 1' : '')
        . " ORDER BY FIELD(status, 'now', 'next', 'planned', 'done'), CASE WHEN status = 'done' THEN COALESCE(done_at, updated_at) END DESC, position ASC, id ASC";
    $list = array_map('oys_milestone_from_row', $pdo->query($sql)->fetchAll());
    return oys_milestones_attach_tasks($pdo, $list);
}

function oys_milestones_attach_tasks(PDO $pdo, array $milestones): array
{
    if (!$milestones) {
        return [];
    }
    $ids = array_map(function ($m) { return (int) $m['id']; }, $milestones);
    $tasks = [];
    foreach ($pdo->query('SELECT * FROM milestone_tasks WHERE milestone_id IN (' . implode(',', $ids) . ') ORDER BY position ASC, id ASC')->fetchAll() as $t) {
        $tasks[(int) $t['milestone_id']][] = ['id' => (int) $t['id'], 'title' => (string) $t['title'], 'is_done' => (bool) $t['is_done'], 'done_at' => $t['done_at']];
    }
    foreach ($milestones as &$m) {
        $m['tasks'] = $tasks[$m['id']] ?? [];
        $m['progress'] = oys_milestone_progress($m);
    }
    unset($m);
    return $milestones;
}

// Fortschritt nur aus echten, abgehakten Teilaufgaben – keine geschätzten Prozentzahlen
function oys_milestone_progress(array $m): ?array
{
    $total = count($m['tasks']);
    $done = count(array_filter($m['tasks'], function ($t) { return $t['is_done']; }));
    if ($m['status'] === 'done') {
        return ['done' => $total, 'total' => $total, 'percent' => 100];
    }
    if ($total === 0) {
        return null;
    }
    return ['done' => $done, 'total' => $total, 'percent' => (int) floor($done * 100 / $total)];
}

function oys_milestone_save(PDO $pdo, array $in, ?array $existing): array
{
    $title = oys_clean_text($in['title'] ?? '', 160);
    if ($title === '') {
        return [null, 'Please enter a title for the milestone.'];
    }
    $description = oys_clean_text($in['description'] ?? '', 4000, true);
    $status = isset(OYS_MILESTONE_STATUSES[$in['status'] ?? '']) ? $in['status'] : 'planned';
    $target = oys_clean_text($in['target'] ?? '', 40);
    $public = !empty($in['is_public']) ? 1 : 0;
    $now = date('Y-m-d H:i:s');

    if ($existing) {
        $pdo->prepare('UPDATE milestones SET title = ?, description = ?, target = ?, is_public = ?, updated_at = ? WHERE id = ?')
            ->execute([$title, $description, $target, $public, $now, $existing['id']]);
        $id = (int) $existing['id'];
        if ($status !== $existing['status']) {
            oys_milestone_set_status($pdo, $existing, $status);
        }
    } else {
        $pos = (int) $pdo->query('SELECT COALESCE(MAX(position), 0) + 1 FROM milestones')->fetchColumn();
        $pdo->prepare('INSERT INTO milestones (title, description, status, target, position, is_public, started_at, done_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            ->execute([$title, $description, $status, $target, $pos, $public, $status === 'now' ? $now : null, $status === 'done' ? $now : null, $now, $now]);
        $id = (int) $pdo->lastInsertId();
    }
    // Neue Aufgaben: eine pro Zeile („[x] …“ = schon erledigt)
    foreach (preg_split('/\R/', (string) ($in['tasks'] ?? '')) as $line) {
        $done = (bool) preg_match('/^\s*(?:[-*•]\s*)?\[[xX]\]/u', $line);
        $line = trim(preg_replace('/^\s*(?:[-*•]\s*)?(?:\[[ xX]?\])?\s*/u', '', $line));
        if ($line !== '') {
            oys_task_add($pdo, $id, $line, $done);
        }
    }
    return [$id, null];
}

function oys_milestone_set_status(PDO $pdo, array $ms, string $status): void
{
    if (!isset(OYS_MILESTONE_STATUSES[$status])) {
        return;
    }
    $now = date('Y-m-d H:i:s');
    $started = $ms['started_at'] ?: ($status === 'now' || $status === 'done' ? $now : null);
    $done = $status === 'done' ? ($ms['done_at'] ?: $now) : null;
    $pdo->prepare('UPDATE milestones SET status = ?, started_at = ?, done_at = ?, updated_at = ? WHERE id = ?')
        ->execute([$status, $started, $done, $now, $ms['id']]);
}

function oys_milestone_move(PDO $pdo, array $ms, string $direction): void
{
    // Innerhalb derselben Spalte mit dem Nachbarn tauschen
    $list = array_values(array_filter(oys_milestones($pdo, false), function ($m) use ($ms) { return $m['status'] === $ms['status']; }));
    foreach ($list as $i => $m) {
        if ($m['id'] !== $ms['id']) {
            continue;
        }
        $j = $direction === 'up' ? $i - 1 : $i + 1;
        if (!isset($list[$j])) {
            return;
        }
        $order = array_column($list, 'id');
        [$order[$i], $order[$j]] = [$order[$j], $order[$i]];
        $stmt = $pdo->prepare('UPDATE milestones SET position = ? WHERE id = ?');
        foreach ($order as $pos => $id) {
            $stmt->execute([$pos + 1, $id]);
        }
        return;
    }
}

function oys_milestone_delete(PDO $pdo, int $id): void
{
    $pdo->prepare('DELETE FROM milestone_tasks WHERE milestone_id = ?')->execute([$id]);
    $pdo->prepare('UPDATE updates SET milestone_id = NULL WHERE milestone_id = ?')->execute([$id]);
    $pdo->prepare('DELETE FROM milestones WHERE id = ?')->execute([$id]);
}

function oys_task_add(PDO $pdo, int $milestoneId, string $title, bool $done = false): void
{
    $title = oys_clean_text($title, 200);
    if ($title === '') {
        return;
    }
    $pos = $pdo->prepare('SELECT COALESCE(MAX(position), 0) + 1 FROM milestone_tasks WHERE milestone_id = ?');
    $pos->execute([$milestoneId]);
    $pdo->prepare('INSERT INTO milestone_tasks (milestone_id, title, is_done, position, done_at) VALUES (?, ?, ?, ?, ?)')
        ->execute([$milestoneId, $title, $done ? 1 : 0, (int) $pos->fetchColumn(), $done ? date('Y-m-d H:i:s') : null]);
    oys_milestone_touch($pdo, $milestoneId);
}

function oys_task_get(PDO $pdo, int $id): ?array
{
    $stmt = $pdo->prepare('SELECT * FROM milestone_tasks WHERE id = ?');
    $stmt->execute([$id]);
    return $stmt->fetch() ?: null;
}

function oys_task_toggle(PDO $pdo, array $task): void
{
    $done = !(int) $task['is_done'];
    $pdo->prepare('UPDATE milestone_tasks SET is_done = ?, done_at = ? WHERE id = ?')
        ->execute([$done ? 1 : 0, $done ? date('Y-m-d H:i:s') : null, $task['id']]);
    oys_milestone_touch($pdo, (int) $task['milestone_id']);
}

function oys_task_delete(PDO $pdo, array $task): void
{
    $pdo->prepare('DELETE FROM milestone_tasks WHERE id = ?')->execute([$task['id']]);
    oys_milestone_touch($pdo, (int) $task['milestone_id']);
}

function oys_milestone_touch(PDO $pdo, int $id): void
{
    $pdo->prepare('UPDATE milestones SET updated_at = ? WHERE id = ?')->execute([date('Y-m-d H:i:s'), $id]);
}

// ---------------------------------------------------------------
// Einfaches, sicheres Markdown (gleiche Schreibweise wie in Discord)
// ---------------------------------------------------------------

function oys_markdown(string $md): string
{
    $lines = explode("\n", str_replace(["\r\n", "\r"], "\n", $md));
    $html = '';
    $para = [];
    $list = null;
    $inCode = false;
    $code = [];
    $flushPara = function () use (&$para, &$html) {
        if ($para) {
            $html .= '<p>' . implode('<br>', array_map('oys_md_inline', $para)) . '</p>';
            $para = [];
        }
    };
    $closeList = function () use (&$list, &$html) {
        if ($list) {
            $html .= '</' . $list . '>';
            $list = null;
        }
    };
    foreach ($lines as $line) {
        if (preg_match('/^\s*```/', $line)) {
            if ($inCode) {
                $html .= '<pre><code>' . e(implode("\n", $code)) . '</code></pre>';
                $code = [];
                $inCode = false;
            } else {
                $flushPara();
                $closeList();
                $inCode = true;
            }
            continue;
        }
        if ($inCode) {
            $code[] = $line;
            continue;
        }
        if (trim($line) === '') {
            $flushPara();
            $closeList();
            continue;
        }
        if (preg_match('/^(#{1,3})\s+(.+)$/', $line, $m)) {
            $flushPara();
            $closeList();
            $tag = strlen($m[1]) === 3 ? 'h5' : 'h4';
            $html .= '<' . $tag . '>' . oys_md_inline($m[2]) . '</' . $tag . '>';
            continue;
        }
        if (preg_match('/^\s*(?:[-*•]|(\d+)[.)])\s+(.+)$/u', $line, $m)) {
            $flushPara();
            $want = $m[1] !== '' ? 'ol' : 'ul';
            if ($list !== $want) {
                $closeList();
                $html .= '<' . $want . '>';
                $list = $want;
            }
            $html .= '<li>' . oys_md_inline($m[2]) . '</li>';
            continue;
        }
        if (preg_match('/^>\s?(.*)$/', $line, $m)) {
            $flushPara();
            $closeList();
            $html .= '<blockquote>' . oys_md_inline($m[1]) . '</blockquote>';
            continue;
        }
        $closeList();
        $para[] = $line;
    }
    if ($inCode) {
        $html .= '<pre><code>' . e(implode("\n", $code)) . '</code></pre>';
    }
    $flushPara();
    $closeList();
    return $html;
}

// Zeile: Code und Links zuerst beiseitelegen, den Rest maskieren, dann nur bekannte Muster in Tags verwandeln
function oys_md_inline(string $text): string
{
    $text = str_replace(["\x01", "\x02"], '', $text);
    $keep = [];
    $stash = function (string $html) use (&$keep): string {
        $keep[] = $html;
        return "\x01" . (count($keep) - 1) . "\x02";
    };
    $text = preg_replace_callback('/`([^`]+)`/', function ($m) use ($stash) {
        return $stash('<code>' . e($m[1]) . '</code>');
    }, $text);
    // Adressen dürfen ausgeglichene Klammern enthalten, z. B. …/wiki/Foo_(bar)
    $text = preg_replace_callback('/\[([^\]\n]{1,200})\]\(((?:[^()\s]|\([^()\s]*\)){1,500})\)/', function ($m) use ($stash) {
        $url = oys_clean_url($m[2]);
        return $url === '' ? $m[0] : $stash('<a href="' . e($url) . '" target="_blank" rel="noopener noreferrer">' . oys_md_emphasis(e($m[1])) . '</a>');
    }, $text);
    // Nackte Adressen: Satzzeichen und Markdown-Zeichen am Ende gehören nicht dazu
    $text = preg_replace_callback('#\bhttps?://(?:[^\s<>"()\x01\x02]|\([^\s<>"()\x01\x02]*\))+(?<![.,;:!?\]"\'*_~])#i', function ($m) use ($stash) {
        return $stash('<a href="' . e($m[0]) . '" target="_blank" rel="noopener noreferrer">' . e(oys_pretty_url($m[0])) . '</a>');
    }, $text);
    $text = oys_md_emphasis(e($text));
    // Platzhalter einsetzen (auch verschachtelte, z. B. Code in einem Link)
    for ($i = 0; $i < 3 && strpos($text, "\x01") !== false; $i++) {
        $text = preg_replace_callback('/\x01(\d+)\x02/', function ($m) use ($keep) { return $keep[(int) $m[1]] ?? ''; }, $text);
    }
    return str_replace(["\x01", "\x02"], '', $text);
}

function oys_md_emphasis(string $escaped): string
{
    $s = preg_replace('/\*\*(?=\S)(.+?)(?<=\S)\*\*/', '<strong>$1</strong>', $escaped);
    $s = preg_replace('/~~(?=\S)(.+?)(?<=\S)~~/', '<del>$1</del>', $s);
    $s = preg_replace('/(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])/', '<em>$1</em>', $s);
    return preg_replace('/(?<![\w_])_(?=\S)(.+?)(?<=\S)_(?![\w_])/', '<em>$1</em>', $s);
}

// Kurzer Klartext (für Feeds, Vorschauen)
function oys_md_plain(string $md, int $max = 200): string
{
    $text = preg_replace(['/```.*?```/s', '/\[([^\]\n]+)\]\((?:[^()\s]|\([^()\s]*\))+\)/', '/[*_~`#>]+/'], ['', '$1', ''], $md);
    $text = trim(preg_replace('/\s+/u', ' ', (string) $text));
    return mb_strlen($text) > $max ? rtrim(mb_substr($text, 0, $max - 1)) . '…' : $text;
}

// ---------------------------------------------------------------
// Discord: Webhook-Link oder Bot
// ---------------------------------------------------------------

function oys_discord_defaults(): array
{
    return [
        'mode' => 'webhook', 'webhook_url' => '', 'bot_token' => '', 'channel_id' => '',
        'mention' => '', 'username' => '', 'avatar_url' => '', 'invite_url' => '', 'auto_post' => true,
    ];
}

// Einstellungen liegen verschlüsselt in oys_meta (Webhook-Link und Bot-Token sind Zugangsdaten)
function oys_discord_settings(PDO $pdo): array
{
    $stmt = $pdo->prepare("SELECT meta_value FROM oys_meta WHERE meta_key = 'discord'");
    $stmt->execute();
    $raw = (string) $stmt->fetchColumn();
    $data = $raw !== '' ? json_decode((string) decryptData($raw), true) : null;
    return array_replace(oys_discord_defaults(), is_array($data) ? array_intersect_key($data, oys_discord_defaults()) : []);
}

function oys_discord_store(PDO $pdo, ?array $settings): void
{
    if ($settings === null) {
        $pdo->exec("DELETE FROM oys_meta WHERE meta_key = 'discord'");
        return;
    }
    $pdo->prepare("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('discord', ?)")
        ->execute([encryptData(json_encode($settings, JSON_UNESCAPED_SLASHES))]);
}

function oys_discord_configured(array $s): bool
{
    return $s['mode'] === 'bot' ? ($s['bot_token'] !== '' && $s['channel_id'] !== '') : $s['webhook_url'] !== '';
}

function oys_discord_base(): string
{
    return rtrim((string) oys_config('discord_api_base', 'https://discord.com/api'), '/');
}

// Prüft einen Webhook-Link (nur Discord selbst – keine beliebigen Adressen) und gibt [id, token] zurück
function oys_discord_parse_webhook(string $url): ?array
{
    $url = trim($url);
    if (preg_match('#^https://(?:(?:ptb|canary)\.)?discord(?:app)?\.com/api(?:/v\d+)?/webhooks/(\d{5,25})/([A-Za-z0-9_-]{20,120})/?$#', $url, $m)) {
        return [$m[1], $m[2]];
    }
    $base = oys_discord_base();
    if ($base !== 'https://discord.com/api' && preg_match('#^' . preg_quote($base, '#') . '/webhooks/(\d{5,25})/([A-Za-z0-9_-]{20,120})/?$#', $url, $m)) {
        return [$m[1], $m[2]];
    }
    return null;
}

// Speichert die Einstellungen aus dem Formular. Leere Geheimnis-Felder behalten den alten Wert.
function oys_discord_save_settings(PDO $pdo, array $in): ?string
{
    $s = oys_discord_settings($pdo);
    $s['mode'] = ($in['mode'] ?? '') === 'bot' ? 'bot' : 'webhook';

    $webhook = trim((string) ($in['webhook_url'] ?? ''));
    if ($webhook !== '') {
        if (!oys_discord_parse_webhook($webhook)) {
            return 'That doesn’t look like a Discord webhook link (https://discord.com/api/webhooks/…).';
        }
        $s['webhook_url'] = $webhook;
    }
    $token = trim((string) ($in['bot_token'] ?? ''));
    if ($token !== '') {
        if (!preg_match('/^[A-Za-z0-9_.\-]{50,120}$/', $token)) {
            return 'That doesn’t look like a bot token. Copy it from the Discord Developer Portal (Bot → Reset Token).';
        }
        $s['bot_token'] = $token;
    }
    $channel = trim((string) ($in['channel_id'] ?? ''));
    if ($channel !== '' && !preg_match('/^\d{15,25}$/', $channel)) {
        return 'The channel ID is a long number. In Discord: enable Developer Mode, right-click the channel → Copy Channel ID.';
    }
    $s['channel_id'] = $channel;

    $mention = strtolower(trim((string) ($in['mention'] ?? ''), " @<&>\t"));
    if ($mention !== '' && !in_array($mention, ['everyone', 'here'], true) && !preg_match('/^\d{15,25}$/', $mention)) {
        return 'Ping: enter a role ID, “everyone” or “here” – or leave it empty.';
    }
    $s['mention'] = $mention;

    $username = oys_clean_text($in['username'] ?? '', 80);
    if ($username !== '' && preg_match('/discord|clyde/i', $username)) {
        return 'Discord doesn’t allow “discord” or “clyde” in the webhook name.';
    }
    $s['username'] = $username;
    $avatar = trim((string) ($in['avatar_url'] ?? ''));
    $s['avatar_url'] = $avatar !== '' && preg_match('#^https://#i', $avatar) ? oys_clean_url($avatar) : '';
    $invite = trim((string) ($in['invite_url'] ?? ''));
    $s['invite_url'] = $invite !== '' ? oys_clean_url($invite) : '';
    if ($s['invite_url'] !== '' && stripos($s['invite_url'], 'https://') !== 0) {
        $s['invite_url'] = '';
    }
    $s['auto_post'] = !empty($in['auto_post']);

    if ($s['mode'] === 'bot' && ($s['bot_token'] === '' || $s['channel_id'] === '')) {
        oys_discord_store($pdo, $s);
        return 'Saved – for the bot, a token and a channel ID are both needed.';
    }
    oys_discord_store($pdo, $s);
    return null;
}

// Ziel einer Nachricht: Webhook (mit Token) oder Bot-Kanal
function oys_discord_target(array $s): ?array
{
    if ($s['mode'] === 'bot') {
        if ($s['bot_token'] === '' || $s['channel_id'] === '') {
            return null;
        }
        return ['key' => 'bot:' . $s['channel_id'], 'url' => oys_discord_base() . '/v10/channels/' . $s['channel_id'] . '/messages', 'headers' => ['Authorization: Bot ' . $s['bot_token']], 'bot' => true];
    }
    $hook = oys_discord_parse_webhook($s['webhook_url']);
    if (!$hook) {
        return null;
    }
    return ['key' => 'webhook:' . $hook[0], 'url' => oys_discord_base() . '/webhooks/' . $hook[0] . '/' . $hook[1], 'headers' => [], 'bot' => false];
}

function oys_discord_request(string $method, string $url, ?array $json = null, array $headers = []): array
{
    $body = $json === null ? null : json_encode($json, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    // Discord verlangt dieses Format für den User-Agent
    $headers = array_merge(['Content-Type: application/json', 'User-Agent: DiscordBot (https://' . oys_base_host() . ', 2.2)'], $headers);
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_TIMEOUT => 10,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_FOLLOWLOCATION => false,
        ]);
        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }
        $resp = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $error = $resp === false ? curl_error($ch) : '';
        curl_close($ch);
    } else {
        $ctx = stream_context_create(['http' => [
            'method' => $method, 'header' => implode("\r\n", $headers), 'content' => (string) $body,
            'timeout' => 10, 'ignore_errors' => true, 'follow_location' => 0,
        ]]);
        $resp = @file_get_contents($url, false, $ctx);
        $status = 0;
        foreach ($http_response_header ?? [] as $h) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) {
                $status = (int) $m[1];
            }
        }
        $error = $resp === false ? 'connection failed' : '';
    }
    $data = is_string($resp) && $resp !== '' ? json_decode($resp, true) : null;
    return ['status' => $status, 'data' => is_array($data) ? $data : null, 'error' => $error];
}

function oys_discord_error(array $res, bool $bot): string
{
    $status = $res['status'];
    $message = (string) ($res['data']['message'] ?? '');
    if ($status === 0) {
        return 'Couldn’t reach Discord' . ($res['error'] !== '' ? ' (' . $res['error'] . ')' : '') . '.';
    }
    if ($status === 401) {
        return 'Discord rejected the bot token – please check it.';
    }
    if ($status === 403) {
        return 'The bot isn’t allowed to post in this channel. It needs “View Channel”, “Send Messages” and “Embed Links”.';
    }
    if ($status === 404) {
        return $bot ? 'Discord couldn’t find the channel or message.' : 'Discord couldn’t find this webhook – it may have been deleted.';
    }
    if ($status === 429) {
        return 'Discord is rate limiting us – please try again in a moment.';
    }
    return 'Discord error ' . $status . ($message !== '' ? ': ' . $message : '') . '.';
}

// Nachricht für ein Update: Embed mit Titel, Text, Farbe der Kategorie und Link zur Seite
function oys_discord_update_payload(array $u, array $s): array
{
    $cat = OYS_UPDATE_CATEGORIES[$u['category']] ?? OYS_UPDATE_CATEGORIES['news'];
    $url = oys_main_url('/updates#update-' . $u['id']);
    $title = ($u['version'] !== '' ? $u['version'] . ' – ' : '') . $u['title'];
    $desc = trim($u['body']);
    if (mb_strlen($desc) > 3800) {
        $desc = rtrim(mb_substr($desc, 0, 3800)) . "…\n\n[Read the full update](" . $url . ')';
    }
    $embed = [
        'title' => mb_substr($title, 0, 256),
        'url' => $url,
        'color' => hexdec(ltrim($cat['color'], '#')),
        'author' => ['name' => $cat['label']],
        'footer' => ['text' => 'OnYourSite Updates'],
        'timestamp' => gmdate('Y-m-d\TH:i:s\Z', strtotime((string) ($u['published_at'] ?: 'now'))),
    ];
    if ($desc !== '') {
        $embed['description'] = $desc;
    }
    return oys_discord_with_mention(['embeds' => [$embed]], $s);
}

function oys_discord_with_mention(array $payload, array $s): array
{
    $payload['allowed_mentions'] = ['parse' => []];
    $mention = $s['mention'];
    if ($mention === 'everyone' || $mention === 'here') {
        $payload['content'] = '@' . $mention;
        $payload['allowed_mentions'] = ['parse' => ['everyone']];
    } elseif ($mention !== '') {
        $payload['content'] = '<@&' . $mention . '>';
        $payload['allowed_mentions'] = ['parse' => [], 'roles' => [$mention]];
    }
    if ($s['mode'] === 'webhook') {
        if ($s['username'] !== '') {
            $payload['username'] = $s['username'];
        }
        if ($s['avatar_url'] !== '') {
            $payload['avatar_url'] = $s['avatar_url'];
        }
    }
    return $payload;
}

// Neue Nachricht senden. Gibt ['ok', 'id', 'target', 'error'] zurück.
function oys_discord_send(array $s, array $payload): array
{
    $t = oys_discord_target($s);
    if (!$t) {
        return ['ok' => false, 'id' => '', 'target' => '', 'error' => 'Discord isn’t set up yet (Admin → Discord).'];
    }
    $res = oys_discord_request('POST', $t['url'] . ($t['bot'] ? '' : '?wait=true'), $payload, $t['headers']);
    if ($res['status'] >= 200 && $res['status'] < 300) {
        return ['ok' => true, 'id' => (string) ($res['data']['id'] ?? ''), 'target' => $t['key'], 'error' => null];
    }
    return ['ok' => false, 'id' => '', 'target' => '', 'error' => oys_discord_error($res, $t['bot'])];
}

// Bestehende Nachricht ändern oder löschen – nur über dasselbe Ziel, über das sie gesendet wurde
function oys_discord_change(array $s, string $target, string $messageId, ?array $payload): array
{
    $t = oys_discord_target($s);
    if (!$t || $t['key'] !== $target || !preg_match('/^\d{5,25}$/', $messageId)) {
        return ['ok' => false, 'status' => 0, 'error' => 'gone'];
    }
    if ($payload !== null) {
        unset($payload['username'], $payload['avatar_url']);
    }
    // Webhook: /webhooks/{id}/{token}/messages/{msg} – Bot: /channels/{id}/messages/{msg}
    $res = oys_discord_request($payload === null ? 'DELETE' : 'PATCH', $t['url'] . ($t['bot'] ? '' : '/messages') . '/' . $messageId, $payload, $t['headers']);
    $ok = $res['status'] >= 200 && $res['status'] < 300;
    return ['ok' => $ok, 'status' => $res['status'], 'error' => $ok ? null : oys_discord_error($res, $t['bot'])];
}

// Update in Discord veröffentlichen bzw. die vorhandene Nachricht aktualisieren. Gibt eine Fehlermeldung oder null zurück.
function oys_discord_publish_update(PDO $pdo, array $u, array $s): ?string
{
    $payload = oys_discord_update_payload($u, $s);
    if ($u['discord_message_id'] !== '') {
        $res = oys_discord_change($s, $u['discord_target'], $u['discord_message_id'], $payload);
        if ($res['ok']) {
            return null;
        }
        if ($res['status'] !== 404 && $res['error'] !== 'gone') {
            return $res['error'];
        }
        // In Discord gelöscht oder über ein anderes Ziel gesendet → neu senden
    }
    $sent = oys_discord_send($s, $payload);
    if (!$sent['ok']) {
        return $sent['error'];
    }
    $pdo->prepare('UPDATE updates SET discord_message_id = ?, discord_target = ? WHERE id = ?')->execute([$sent['id'], $sent['target'], $u['id']]);
    return null;
}

// Nachricht eines Updates aus Discord entfernen (z. B. beim Löschen oder Zurückziehen)
function oys_discord_remove_update(PDO $pdo, array $u, array $s): ?string
{
    if ($u['discord_message_id'] === '') {
        return null;
    }
    $res = oys_discord_change($s, $u['discord_target'], $u['discord_message_id'], null);
    $pdo->prepare('UPDATE updates SET discord_message_id = NULL, discord_target = NULL WHERE id = ?')->execute([$u['id']]);
    return $res['ok'] || $res['status'] === 404 || $res['error'] === 'gone' ? null : $res['error'];
}

// ---------------------------------------------------------------
// Admin-Aktionen (Formulare im Admin-Panel). Gibt ['tab', 'ok'|'error', 'query'?] zurück.
// ---------------------------------------------------------------

function oys_admin_updates_handle(PDO $pdo, array $post): ?array
{
    $action = (string) ($post['oys_action'] ?? '');
    $id = (int) ($post['id'] ?? 0);
    $discord = oys_discord_settings($pdo);
    $ready = oys_discord_configured($discord);

    switch ($action) {
        case 'update_save':
            $existing = $id ? oys_update_get($pdo, $id) : null;
            [$newId, $error] = oys_update_save($pdo, $post, $existing);
            if ($error) {
                return ['tab' => 'updates', 'error' => $error, 'query' => $existing ? '?edit_update=' . $existing['id'] : ''];
            }
            $u = oys_update_get($pdo, $newId);
            $note = '';
            if ($u['is_published'] && $ready && ($u['discord_message_id'] !== '' || !empty($post['post_discord']))) {
                $err = oys_discord_publish_update($pdo, $u, $discord);
                $note = $err ? ' But Discord: ' . $err : ($u['discord_message_id'] !== '' ? ' The Discord post was updated too.' : ' It was posted to Discord.');
            } elseif (!$u['is_published'] && $u['discord_message_id'] !== '') {
                $err = oys_discord_remove_update($pdo, $u, $discord);
                $note = $err ? ' But Discord: ' . $err : ' The Discord post was removed.';
            }
            $msg = ($u['is_published'] ? 'Update published.' : 'Draft saved.') . $note;
            $kind = strpos($note, 'But Discord') !== false ? 'error' : 'ok';
            return ['tab' => 'updates', $kind => $msg];

        case 'update_publish':
            $u = oys_update_get($pdo, $id);
            if (!$u) {
                return ['tab' => 'updates', 'error' => 'Update not found.'];
            }
            $publish = !empty($post['state']);
            oys_update_set_published($pdo, $u, $publish);
            $u = oys_update_get($pdo, $id);
            if (!$publish && $u['discord_message_id'] !== '') {
                $err = oys_discord_remove_update($pdo, $u, $discord);
                return $err ? ['tab' => 'updates', 'error' => 'Moved back to drafts. But Discord: ' . $err] : ['tab' => 'updates', 'ok' => 'Moved back to drafts and removed from Discord.'];
            }
            if ($publish && $ready && $discord['auto_post'] && $u['discord_message_id'] === '') {
                $err = oys_discord_publish_update($pdo, $u, $discord);
                return $err ? ['tab' => 'updates', 'error' => 'Published. But Discord: ' . $err] : ['tab' => 'updates', 'ok' => 'Published and posted to Discord.'];
            }
            return ['tab' => 'updates', 'ok' => $publish ? 'Update published.' : 'Moved back to drafts.'];

        case 'update_discord':
            $u = oys_update_get($pdo, $id);
            if (!$u || !$u['is_published']) {
                return ['tab' => 'updates', 'error' => 'Only published updates can be posted to Discord.'];
            }
            $err = oys_discord_publish_update($pdo, $u, $discord);
            return $err ? ['tab' => 'updates', 'error' => $err] : ['tab' => 'updates', 'ok' => 'Posted to Discord.'];

        case 'update_delete':
            $u = oys_update_get($pdo, $id);
            if ($u) {
                $err = oys_discord_remove_update($pdo, $u, $discord);
                oys_update_delete($pdo, $id);
                return $err ? ['tab' => 'updates', 'error' => 'Update deleted. But Discord: ' . $err] : ['tab' => 'updates', 'ok' => 'Update deleted.'];
            }
            return ['tab' => 'updates', 'error' => 'Update not found.'];

        case 'milestone_save':
            $existing = $id ? oys_milestone_get($pdo, $id) : null;
            [$newId, $error] = oys_milestone_save($pdo, $post, $existing);
            if ($error) {
                return ['tab' => 'roadmap', 'error' => $error, 'query' => $existing ? '?edit_milestone=' . $existing['id'] : ''];
            }
            return ['tab' => 'roadmap', 'ok' => $existing ? 'Milestone saved.' : 'Milestone added.'];

        case 'milestone_status':
            $ms = oys_milestone_get($pdo, $id);
            $status = (string) ($post['status'] ?? '');
            if ($ms && isset(OYS_MILESTONE_STATUSES[$status])) {
                oys_milestone_set_status($pdo, $ms, $status);
                return ['tab' => 'roadmap', 'ok' => '“' . $ms['title'] . '” moved to ' . OYS_MILESTONE_STATUSES[$status]['label'] . '.'];
            }
            return ['tab' => 'roadmap', 'error' => 'Milestone not found.'];

        case 'milestone_move':
            $ms = oys_milestone_get($pdo, $id);
            if ($ms) {
                oys_milestone_move($pdo, $ms, ($post['dir'] ?? '') === 'up' ? 'up' : 'down');
            }
            return ['tab' => 'roadmap', 'ok' => 'Order updated.'];

        case 'milestone_delete':
            oys_milestone_delete($pdo, $id);
            return ['tab' => 'roadmap', 'ok' => 'Milestone deleted.'];

        case 'task_add':
            if (oys_milestone_get($pdo, $id) && trim((string) ($post['title'] ?? '')) !== '') {
                oys_task_add($pdo, $id, (string) $post['title']);
                return ['tab' => 'roadmap', 'ok' => 'Task added.'];
            }
            return ['tab' => 'roadmap', 'error' => 'Please enter a task.'];

        case 'task_toggle':
        case 'task_delete':
            $task = oys_task_get($pdo, $id);
            if (!$task) {
                return ['tab' => 'roadmap', 'error' => 'Task not found.'];
            }
            $action === 'task_toggle' ? oys_task_toggle($pdo, $task) : oys_task_delete($pdo, $task);
            return ['tab' => 'roadmap', 'ok' => $action === 'task_toggle' ? 'Task updated.' : 'Task removed.'];

        case 'discord_save':
            $err = oys_discord_save_settings($pdo, $post);
            return $err ? ['tab' => 'discord', 'error' => $err] : ['tab' => 'discord', 'ok' => 'Discord settings saved.'];

        case 'discord_test':
            if (!$ready) {
                return ['tab' => 'discord', 'error' => 'Please save a webhook link or bot first.'];
            }
            $payload = oys_discord_with_mention(['embeds' => [[
                'title' => 'Discord is connected',
                'description' => 'New updates from ' . oys_base_host() . ' will show up here.',
                'url' => oys_main_url('/updates'),
                'color' => hexdec('6366f1'),
                'footer' => ['text' => 'OnYourSite Updates'],
            ]]], array_replace($discord, ['mention' => '']));
            $sent = oys_discord_send($discord, $payload);
            return $sent['ok'] ? ['tab' => 'discord', 'ok' => 'Test message sent – check your Discord channel.'] : ['tab' => 'discord', 'error' => $sent['error']];

        case 'discord_disconnect':
            oys_discord_store($pdo, null);
            return ['tab' => 'discord', 'ok' => 'Discord disconnected.'];
    }
    return null;
}
