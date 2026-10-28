<?php
// Kontaktformular: Prüfung und Schutzfilter gegen Spam (ohne Captcha, ohne IP-Adressen).

// Gibt [ok(bool), fehlermeldung|null, ist_spam(bool)] zurück
function oys_contact_check(PDO $pdo, array $page, string $blockId, array $post): array
{
    // 1. Honigtopf-Feld: Menschen sehen es nicht, Bots füllen es aus
    if (trim((string) ($post['website'] ?? '')) !== '') {
        return [true, null, true];
    }

    // 2. Zeit-Token: signiert, mind. 3 Sekunden alt, höchstens 1 Tag
    $token = (string) ($post['t'] ?? '');
    if (!preg_match('/^(\d{9,11})\.([a-f0-9]{32})$/', $token, $m)) {
        return [false, 'This form has expired. Please reload the page.', false];
    }
    $expected = substr(oys_hmac($page['id'] . '|' . $blockId . '|' . $m[1]), 0, 32);
    if (!hash_equals($expected, $m[2])) {
        return [false, 'This form has expired. Please reload the page.', false];
    }
    $age = time() - (int) $m[1];
    if ($age < 3) {
        return [true, null, true];
    }
    if ($age > 86400) {
        return [false, 'This form has expired. Please reload the page.', false];
    }

    $name = oys_clean_text($post['name'] ?? '', 80);
    $email = trim((string) ($post['email'] ?? ''));
    $message = oys_clean_text($post['message'] ?? '', 2000, true);

    if ($name === '' || $message === '') {
        return [false, 'Please fill in your name and message.', false];
    }
    if (!filter_var($email, FILTER_VALIDATE_EMAIL) || mb_strlen($email) > 190) {
        return [false, 'Please enter a valid email address.', false];
    }
    if (mb_strlen($message) < 5) {
        return [false, 'Your message is a bit short.', false];
    }

    // 3. Inhaltsfilter
    if (oys_looks_like_spam($name . ' ' . $message)) {
        return [true, null, true];
    }

    // 4. Begrenzung: je Absender 5, je Seite 30 Nachrichten pro Stunde
    //    (ein Störer allein kann das Formular so nicht für alle sperren)
    if (!oys_rate_limit($pdo, 'contact:' . $page['id'] . ':' . oys_client_key(), 5, 3600)
        || !oys_rate_limit($pdo, 'contact:' . $page['id'], 30, 3600)) {
        return [false, 'A lot of messages are coming in right now. Please try again later.', false];
    }

    return [true, null, false];
}

function oys_looks_like_spam(string $text): bool
{
    $lower = mb_strtolower($text);
    if (preg_match_all('#https?://|www\.#i', $text) > 2) {
        return true;
    }
    if (preg_match('#\[url=|<a\s+href|\[link=#i', $text)) {
        return true;
    }
    $words = [
        'viagra', 'cialis', 'casino', 'porn', 'xxx', 'crypto investment', 'bitcoin investment', 'forex', 'loan offer',
        'seo services', 'backlinks', 'rank your website', 'guest post', 'buy followers', 'cheap followers', 'onlyfans leak',
        'escort', 'betting tips', 'binary option', 'payday loan', 'weight loss pill', 'work from home and earn',
    ];
    foreach ($words as $w) {
        if (strpos($lower, $w) !== false) {
            return true;
        }
    }
    // Fast nur kyrillische/chinesische Zeichen in einem deutschsprachigen Formular → häufig Spam
    $letters = preg_match_all('/\p{L}/u', $text);
    $foreign = preg_match_all('/[\p{Cyrillic}\p{Han}]/u', $text);
    return $letters > 20 && $foreign / max(1, $letters) > 0.6;
}

function oys_store_message(PDO $pdo, array $page, array $post): int
{
    $now = date('Y-m-d H:i:s');
    $name = oys_clean_text($post['name'] ?? '', 80);
    $email = trim((string) $post['email']);
    $message = oys_clean_text($post['message'] ?? '', 2000, true);

    $pdo->prepare('INSERT INTO messages (page_id, user_id, name, email, message, is_read, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
        ->execute([$page['id'], $page['user_id'], encryptData($name), encryptData($email), encryptData($message), $now]);
    $id = (int) $pdo->lastInsertId();

    oys_notify($pdo, (int) $page['user_id'], 'message', 'New message from ' . $name, mb_substr($message, 0, 120), '/dashboard#messages');

    $settings = oys_page_settings($page);
    if ($settings['notify_email']) {
        $owner = $pdo->prepare('SELECT email, full_name FROM users WHERE id = ?');
        $owner->execute([$page['user_id']]);
        $user = $owner->fetch();
        if ($user && function_exists('sendCustomEmail')) {
            sendCustomEmail($user['email'], 'new_message', [
                'full_name' => e($user['full_name'] ?: $page['title']),
                'guest_name' => e($name),
                'guest_email' => e($email),
                'message' => e($message),
                'page_url' => e(oys_page_display_url($page)),
                'dashboard_url' => e(oys_main_url('/dashboard')),
            ], 'New message from ' . $name, $email);
        }
    }
    return $id;
}

function oys_notify(PDO $pdo, int $userId, string $type, string $title, string $body = '', string $link = ''): void
{
    $pdo->prepare('INSERT INTO notifications (user_id, type, title, body, link, is_read, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
        ->execute([$userId, $type, mb_substr($title, 0, 190), mb_substr($body, 0, 255), $link, date('Y-m-d H:i:s')]);
}
