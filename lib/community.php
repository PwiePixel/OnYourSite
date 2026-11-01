<?php
// Community: Discord-Bot ↔ Webseite – Vorschläge (Forum-Kanal) und Support-Tickets.
//
// Der Bot meldet sich über /_/bot/… (jede Anfrage signiert mit 'bot_secret' aus config.php) und holt Aufträge
// der Webseite (z. B. „im Admin angenommen“) aus einer Warteschlange ab. Die Webseite kennt keinen Bot-Token und
// spricht Discord nie selbst an – von außen gibt es nichts, was ohne das Geheimnis etwas tut.

const OYS_BOT_MAX_SKEW = 300;          // Sekunden, die eine signierte Anfrage alt sein darf
const OYS_BOT_TEXT_MAX = 4000;         // längster Text (Vorschlag, Ticket-Nachricht)
const OYS_SUGGESTION_STATUSES = ['open', 'accepted', 'declined'];

function oys_bot_secret(): string
{
    $secret = (string) oys_config('bot_secret', '');
    return strlen($secret) >= 32 ? $secret : '';
}

// Signatur prüfen: HMAC-SHA256 über Zeitstempel, Methode, Pfad (mit Query) und Inhalt
function oys_bot_verify(string $method, string $uri, string $body): bool
{
    $secret = oys_bot_secret();
    $ts = (string) ($_SERVER['HTTP_X_OYS_TIMESTAMP'] ?? '');
    $sig = strtolower((string) ($_SERVER['HTTP_X_OYS_SIGNATURE'] ?? ''));
    if ($secret === '' || !ctype_digit($ts) || abs(time() - (int) $ts) > OYS_BOT_MAX_SKEW || !preg_match('/^[0-9a-f]{64}$/', $sig)) {
        return false;
    }
    $expected = hash_hmac('sha256', $ts . "\n" . strtoupper($method) . "\n" . $uri . "\n" . $body, $secret);
    return hash_equals($expected, $sig);
}

function oys_snowflake($value): ?string
{
    $value = (string) $value;
    return preg_match('/^\d{15,22}$/', $value) ? $value : null;
}

function oys_community_text($value, int $max): string
{
    $text = str_replace(["\r\n", "\r", "\0"], ["\n", "\n", ''], (string) $value);
    $text = trim(mb_check_encoding($text, 'UTF-8') ? $text : mb_convert_encoding($text, 'UTF-8', 'UTF-8'));
    return mb_substr($text, 0, $max);
}

// Ticket-Nachrichten verschlüsselt speichern (wie Kontaktnachrichten). Das Vorzeichen sorgt dafür,
// dass auch ein Text, der zufällig mit „ENC:“ beginnt, verschlüsselt wird.
function oys_community_seal(string $text): string
{
    return encryptData("\x01" . $text);
}

function oys_community_open(?string $stored): string
{
    $plain = (string) decryptData((string) $stored);
    return strpos($plain, "\x01") === 0 ? substr($plain, 1) : $plain;
}

// Letzter Kontakt des Bots (höchstens einmal pro Minute schreiben)
function oys_bot_seen(PDO $pdo): void
{
    $last = (int) oys_bot_last_seen($pdo);
    if (time() - $last >= 60) {
        $pdo->prepare("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('bot_last_seen', ?)")->execute([(string) time()]);
    }
}

function oys_bot_last_seen(PDO $pdo): ?int
{
    $stmt = $pdo->prepare("SELECT meta_value FROM oys_meta WHERE meta_key = 'bot_last_seen'");
    $stmt->execute();
    $value = $stmt->fetchColumn();
    return $value === false ? null : (int) $value;
}

// ---------------------------------------------------------------
// Vorschläge
// ---------------------------------------------------------------
function oys_suggestion_get(PDO $pdo, int $id): ?array
{
    $stmt = $pdo->prepare('SELECT * FROM community_suggestions WHERE id = ?');
    $stmt->execute([$id]);
    return $stmt->fetch() ?: null;
}

function oys_suggestion_public(array $s): array
{
    return [
        'id' => (int) $s['id'],
        'thread_id' => $s['thread_id'],
        'title' => $s['title'],
        'status' => $s['status'],
        'reason' => (string) $s['reason'],
        'decided_by' => (string) $s['decided_by'],
        'decided_via' => (string) $s['decided_via'],
        'decided_at' => $s['decided_at'],
        'status_message_id' => (string) $s['status_message_id'],
        'author_id' => $s['author_id'],
    ];
}

// Entscheidung speichern (nur solange offen). Gibt [Vorschlag, geändert?] zurück.
function oys_suggestion_decide(PDO $pdo, array $s, string $status, string $reason, string $byName, string $via): array
{
    if ($s['status'] !== 'open' || !in_array($status, ['accepted', 'declined'], true)) {
        return [$s, false];
    }
    $now = date('Y-m-d H:i:s');
    $stmt = $pdo->prepare("UPDATE community_suggestions SET status = ?, reason = ?, decided_by = ?, decided_via = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'open'");
    $stmt->execute([$status, $reason, $byName, $via, $now, $now, $s['id']]);
    return [oys_suggestion_get($pdo, (int) $s['id']), $stmt->rowCount() > 0];
}

// ---------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------
function oys_ticket_get(PDO $pdo, int $id): ?array
{
    $stmt = $pdo->prepare('SELECT * FROM community_tickets WHERE id = ?');
    $stmt->execute([$id]);
    return $stmt->fetch() ?: null;
}

function oys_ticket_public(array $t): array
{
    return [
        'id' => (int) $t['id'],
        'channel_id' => (string) $t['channel_id'],
        'user_id' => $t['user_id'],
        'subject' => $t['subject'],
        'status' => $t['status'],
    ];
}

function oys_ticket_add_message(PDO $pdo, int $ticketId, ?string $messageId, ?string $authorId, string $authorName, bool $team, string $source, string $body): bool
{
    $now = date('Y-m-d H:i:s');
    $stmt = $pdo->prepare('INSERT IGNORE INTO community_ticket_messages (ticket_id, discord_message_id, author_id, author_name, is_team, source, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    $stmt->execute([$ticketId, $messageId, $authorId, $authorName, $team ? 1 : 0, $source, oys_community_seal($body), $now]);
    if ($stmt->rowCount()) {
        $pdo->prepare('UPDATE community_tickets SET updated_at = ? WHERE id = ?')->execute([$now, $ticketId]);
        return true;
    }
    return false;
}

function oys_ticket_close(PDO $pdo, array $t, string $byName, string $via): bool
{
    if ($t['status'] !== 'open') {
        return false;
    }
    $now = date('Y-m-d H:i:s');
    $stmt = $pdo->prepare("UPDATE community_tickets SET status = 'closed', closed_by = ?, closed_via = ?, closed_at = ?, updated_at = ? WHERE id = ? AND status = 'open'");
    $stmt->execute([$byName, $via, $now, $now, $t['id']]);
    return $stmt->rowCount() > 0;
}

function oys_ticket_messages(PDO $pdo, int $ticketId): array
{
    $stmt = $pdo->prepare('SELECT * FROM community_ticket_messages WHERE ticket_id = ? ORDER BY id');
    $stmt->execute([$ticketId]);
    return array_map(function ($m) {
        $m['body'] = oys_community_open($m['body']);
        return $m;
    }, $stmt->fetchAll());
}

// ---------------------------------------------------------------
// Aufträge für den Bot (Warteschlange)
// ---------------------------------------------------------------
function oys_outbox_add(PDO $pdo, string $action, array $data): void
{
    $pdo->prepare('INSERT INTO community_outbox (action, payload, created_at) VALUES (?, ?, ?)')
        ->execute([$action, json_encode($data, JSON_UNESCAPED_UNICODE), date('Y-m-d H:i:s')]);
}

// ---------------------------------------------------------------
// Schnittstelle für den Bot: /_/bot/…
// ---------------------------------------------------------------
function oys_bot_api(PDO $pdo, string $path, string $method): void
{
    header('X-Robots-Tag: noindex, nofollow');
    header('Cache-Control: no-store');
    // Ohne Geheimnis in config.php gibt es die Schnittstelle nicht
    if (oys_bot_secret() === '') {
        oys_json(['ok' => false, 'error' => 'Not found.'], 404);
    }
    $raw = $method === 'POST' ? (string) file_get_contents('php://input') : '';
    if (strlen($raw) > 65536 || !oys_bot_verify($method, (string) ($_SERVER['REQUEST_URI'] ?? $path), $raw)) {
        oys_json(['ok' => false, 'error' => 'Unauthorized.'], 401);
    }
    $in = $raw !== '' ? json_decode($raw, true) : [];
    if (!is_array($in)) {
        oys_json(['ok' => false, 'error' => 'Invalid JSON.'], 400);
    }
    oys_bot_seen($pdo);
    $route = substr($path, strlen('/_/bot'));
    $now = date('Y-m-d H:i:s');

    if ($route === '/ping' && $method === 'GET') {
        oys_json(['ok' => true, 'time' => time(), 'site' => oys_main_url('/')]);
    }

    // --- Vorschläge ---
    if ($route === '/suggestions' && $method === 'POST') {
        $thread = oys_snowflake($in['thread_id'] ?? '');
        $author = oys_snowflake($in['author_id'] ?? '');
        $title = oys_community_text($in['title'] ?? '', 200);
        if (!$thread || !$author || $title === '') {
            oys_json(['ok' => false, 'error' => 'thread_id, author_id and title are required.'], 400);
        }
        $pdo->prepare('INSERT IGNORE INTO community_suggestions (thread_id, author_id, author_name, title, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            ->execute([$thread, $author, oys_community_text($in['author_name'] ?? '', 100), $title, oys_community_text($in['body'] ?? '', OYS_BOT_TEXT_MAX), 'open', $now, $now]);
        $stmt = $pdo->prepare('SELECT * FROM community_suggestions WHERE thread_id = ?');
        $stmt->execute([$thread]);
        oys_json(['ok' => true, 'suggestion' => oys_suggestion_public($stmt->fetch())]);
    }
    if (preg_match('#^/suggestions/(\d+)(/decision)?$#', $route, $m) && $method === 'POST') {
        $s = oys_suggestion_get($pdo, (int) $m[1]);
        if (!$s) {
            oys_json(['ok' => false, 'error' => 'Suggestion not found.'], 404);
        }
        if (empty($m[2])) {
            $msg = oys_snowflake($in['status_message_id'] ?? '');
            if ($msg) {
                $pdo->prepare('UPDATE community_suggestions SET status_message_id = ?, updated_at = ? WHERE id = ?')->execute([$msg, $now, $s['id']]);
            }
            oys_json(['ok' => true, 'suggestion' => oys_suggestion_public(oys_suggestion_get($pdo, (int) $s['id']))]);
        }
        // Der Knopf gehört zu genau einem Beitrag – nach einem Neuanfang können Nummern wieder vorkommen
        $thread = oys_snowflake($in['thread_id'] ?? '');
        if ($thread && $thread !== (string) $s['thread_id']) {
            oys_json(['ok' => false, 'error' => 'This button belongs to an older post.'], 409);
        }
        $status = (string) ($in['status'] ?? '');
        if (!in_array($status, ['accepted', 'declined'], true)) {
            oys_json(['ok' => false, 'error' => 'status must be accepted or declined.'], 400);
        }
        [$s, $changed] = oys_suggestion_decide($pdo, $s, $status, oys_community_text($in['reason'] ?? '', 500), oys_community_text($in['by_name'] ?? 'Team', 100), 'discord');
        oys_json(['ok' => true, 'changed' => $changed, 'suggestion' => oys_suggestion_public($s)]);
    }

    // --- Tickets ---
    if ($route === '/tickets' && $method === 'POST') {
        $user = oys_snowflake($in['user_id'] ?? '');
        $subject = oys_community_text($in['subject'] ?? '', 100);
        $body = oys_community_text($in['body'] ?? '', OYS_BOT_TEXT_MAX);
        $name = oys_community_text($in['user_name'] ?? '', 100);
        if (!$user || $subject === '' || $body === '') {
            oys_json(['ok' => false, 'error' => 'user_id, subject and body are required.'], 400);
        }
        // Höchstens ein offenes Ticket je Person (Sperre gegen Doppelklicks)
        $lock = 'oys_ticket_' . $user;
        $pdo->query("SELECT GET_LOCK('$lock', 10)");
        try {
            $stmt = $pdo->prepare("SELECT * FROM community_tickets WHERE user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1");
            $stmt->execute([$user]);
            $open = $stmt->fetch() ?: null;
            if (!$open) {
                $pdo->prepare("INSERT INTO community_tickets (user_id, user_name, subject, status, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?)")
                    ->execute([$user, $name, $subject, $now, $now]);
                $id = (int) $pdo->lastInsertId();
                oys_ticket_add_message($pdo, $id, null, $user, $name, false, 'discord', $body);
            }
        } finally {
            $pdo->query("SELECT RELEASE_LOCK('$lock')");
        }
        if ($open) {
            oys_json(['ok' => false, 'error' => 'open_ticket', 'ticket' => oys_ticket_public($open)], 409);
        }
        oys_json(['ok' => true, 'ticket' => oys_ticket_public(oys_ticket_get($pdo, $id))]);
    }
    if (preg_match('#^/tickets/by-channel/(\d{15,22})$#', $route, $m) && $method === 'GET') {
        $stmt = $pdo->prepare('SELECT * FROM community_tickets WHERE channel_id = ? LIMIT 1');
        $stmt->execute([$m[1]]);
        $t = $stmt->fetch();
        oys_json($t ? ['ok' => true, 'ticket' => oys_ticket_public($t)] : ['ok' => false, 'error' => 'Ticket not found.'], $t ? 200 : 404);
    }
    if (preg_match('#^/tickets/(\d+)/(channel|messages|close)$#', $route, $m) && $method === 'POST') {
        $t = oys_ticket_get($pdo, (int) $m[1]);
        if (!$t) {
            oys_json(['ok' => false, 'error' => 'Ticket not found.'], 404);
        }
        if ($m[2] === 'channel') {
            $channel = oys_snowflake($in['channel_id'] ?? '');
            if (!$channel || $t['channel_id']) {
                oys_json(['ok' => false, 'error' => $channel ? 'The ticket already has a channel.' : 'channel_id is required.'], 400);
            }
            $pdo->prepare('UPDATE community_tickets SET channel_id = ?, updated_at = ? WHERE id = ?')->execute([$channel, $now, $t['id']]);
            oys_json(['ok' => true, 'ticket' => oys_ticket_public(oys_ticket_get($pdo, (int) $t['id']))]);
        }
        if ($m[2] === 'messages') {
            $body = oys_community_text($in['body'] ?? '', OYS_BOT_TEXT_MAX);
            if ($body === '' || $t['status'] !== 'open') {
                oys_json(['ok' => false, 'error' => $body === '' ? 'body is required.' : 'The ticket is closed.'], 400);
            }
            $added = oys_ticket_add_message($pdo, (int) $t['id'], oys_snowflake($in['message_id'] ?? ''), oys_snowflake($in['author_id'] ?? ''), oys_community_text($in['author_name'] ?? '', 100), !empty($in['team']), 'discord', $body);
            oys_json(['ok' => true, 'added' => $added]);
        }
        $changed = oys_ticket_close($pdo, $t, oys_community_text($in['by_name'] ?? '', 100), 'discord');
        oys_json(['ok' => true, 'changed' => $changed, 'ticket' => oys_ticket_public(oys_ticket_get($pdo, (int) $t['id']))]);
    }

    // --- Aufträge der Webseite ---
    if ($route === '/outbox' && $method === 'GET') {
        $rows = $pdo->query('SELECT id, action, payload, attempts FROM community_outbox WHERE done_at IS NULL AND attempts < 10 ORDER BY id LIMIT 20')->fetchAll();
        oys_json(['ok' => true, 'items' => array_map(function ($r) {
            return ['id' => (int) $r['id'], 'action' => $r['action'], 'data' => json_decode((string) $r['payload'], true), 'attempts' => (int) $r['attempts']];
        }, $rows)]);
    }
    if (preg_match('#^/outbox/(\d+)/done$#', $route, $m) && $method === 'POST') {
        $error = oys_community_text($in['error'] ?? '', 200);
        if ($error === '') {
            $pdo->prepare('UPDATE community_outbox SET done_at = ?, last_error = NULL WHERE id = ?')->execute([$now, (int) $m[1]]);
        } else {
            $pdo->prepare('UPDATE community_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?')->execute([$error, (int) $m[1]]);
        }
        oys_json(['ok' => true]);
    }

    oys_json(['ok' => false, 'error' => 'Not found.'], 404);
}

// ---------------------------------------------------------------
// Admin: Vorschläge entscheiden, Tickets beantworten und schließen
// ---------------------------------------------------------------
function oys_admin_community_handle(PDO $pdo, array $post, string $adminName): ?array
{
    $action = (string) ($post['community_action'] ?? '');
    $adminName = oys_community_text($adminName !== '' ? $adminName : 'Team', 100);
    if ($action === 'suggestion_decide') {
        $s = oys_suggestion_get($pdo, (int) ($post['id'] ?? 0));
        $status = (string) ($post['status'] ?? '');
        if (!$s || !in_array($status, ['accepted', 'declined'], true)) {
            return ['error' => 'Suggestion not found.'];
        }
        [$s, $changed] = oys_suggestion_decide($pdo, $s, $status, oys_community_text($post['reason'] ?? '', 500), $adminName, 'web');
        if (!$changed) {
            return ['error' => 'This suggestion was already ' . $s['status'] . ' by ' . $s['decided_by'] . '.'];
        }
        oys_outbox_add($pdo, 'suggestion.decided', oys_suggestion_public($s));
        return ['ok' => 'Suggestion #' . $s['id'] . ' ' . $status . '. It updates in Discord within a few seconds.'];
    }
    if ($action === 'ticket_reply' || $action === 'ticket_close') {
        $t = oys_ticket_get($pdo, (int) ($post['id'] ?? 0));
        if (!$t) {
            return ['error' => 'Ticket not found.'];
        }
        if ($t['status'] !== 'open') {
            return ['error' => 'This ticket is already closed.'];
        }
        if ($action === 'ticket_reply') {
            $body = oys_community_text($post['body'] ?? '', 2000);
            if ($body === '') {
                return ['error' => 'Please write a reply.'];
            }
            oys_ticket_add_message($pdo, (int) $t['id'], null, null, $adminName, true, 'web', $body);
            oys_outbox_add($pdo, 'ticket.reply', oys_ticket_public($t) + ['author_name' => $adminName, 'body' => $body]);
            return ['ok' => 'Reply sent. It appears in Discord within a few seconds.'];
        }
        oys_ticket_close($pdo, $t, $adminName, 'web');
        oys_outbox_add($pdo, 'ticket.close', oys_ticket_public($t) + ['by_name' => $adminName]);
        return ['ok' => 'Ticket #' . $t['id'] . ' closed.'];
    }
    return null;
}
