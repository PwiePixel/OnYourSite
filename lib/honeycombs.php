<?php
// Honigwaben (Honeycombs): Punkte für aktive Nutzung, mit denen man Extras freischaltet (z. B. eine Code-Seite).
// Jede Buchung steht in honeycomb_ledger. Grund + Bezug sind eindeutig – so kann niemand etwas doppelt verdienen.

function oys_hc_defaults(): array
{
    return [
        'daily' => 5,        // an jedem Tag, an dem man den Editor öffnet
        'profile' => 20,     // einmalig: Profilbild, Bio und mindestens 3 Links
        'views' => 10,       // je erreichte Stufe an Aufrufen …
        'views_step' => 100, // … alle 100 Aufrufe (eine Stufe pro Tag, höchstens OYS_HC_MAX_VIEW_REWARDS-mal)
        'code_page' => 100,  // Preis: eigene Code-Seite freischalten
    ];
}

const OYS_HC_MAX_VIEW_REWARDS = 20;

function oys_hc_settings(PDO $pdo): array
{
    $stmt = $pdo->prepare("SELECT meta_value FROM oys_meta WHERE meta_key = 'honeycombs'");
    $stmt->execute();
    $data = json_decode((string) $stmt->fetchColumn(), true);
    $s = oys_hc_defaults();
    foreach ($s as $key => $default) {
        if (is_array($data) && isset($data[$key]) && is_numeric($data[$key])) {
            $s[$key] = max(0, min(100000, (int) $data[$key]));
        }
    }
    $s['views_step'] = max(1, $s['views_step']);
    return $s;
}

function oys_hc_save_settings(PDO $pdo, array $in): void
{
    $s = [];
    foreach (oys_hc_defaults() as $key => $default) {
        $s[$key] = max(0, min(100000, (int) ($in[$key] ?? $default)));
    }
    $s['views_step'] = max(1, $s['views_step']);
    $pdo->prepare("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('honeycombs', ?)")->execute([json_encode($s)]);
}

function oys_hc_balance(PDO $pdo, int $userId): int
{
    $stmt = $pdo->prepare('SELECT COALESCE(SUM(amount), 0) FROM honeycomb_ledger WHERE user_id = ?');
    $stmt->execute([$userId]);
    return (int) $stmt->fetchColumn();
}

function oys_hc_has(PDO $pdo, int $userId, string $reason, string $ref): bool
{
    $stmt = $pdo->prepare('SELECT 1 FROM honeycomb_ledger WHERE user_id = ? AND reason = ? AND ref = ? LIMIT 1');
    $stmt->execute([$userId, $reason, $ref]);
    return (bool) $stmt->fetchColumn();
}

// Bucht Honigwaben (+ verdient, − ausgegeben). Gibt false zurück, wenn es diese Buchung schon gibt.
function oys_hc_add(PDO $pdo, int $userId, int $amount, string $reason, string $ref, string $note = ''): bool
{
    $stmt = $pdo->prepare('INSERT IGNORE INTO honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    $stmt->execute([$userId, $amount, $reason, mb_substr($ref, 0, 80), mb_substr($note, 0, 200), date('Y-m-d H:i:s')]);
    return $stmt->rowCount() > 0;
}

function oys_hc_history(PDO $pdo, int $userId, int $limit = 20): array
{
    $stmt = $pdo->prepare('SELECT amount, reason, ref, note, created_at FROM honeycomb_ledger WHERE user_id = ? ORDER BY id DESC LIMIT ' . max(1, $limit));
    $stmt->execute([$userId]);
    return array_map(function ($r) {
        return ['amount' => (int) $r['amount'], 'text' => oys_hc_describe($r), 'at' => $r['created_at']];
    }, $stmt->fetchAll());
}

function oys_hc_describe(array $r): string
{
    switch ($r['reason']) {
        case 'daily':
            return 'Active on OnYourSite';
        case 'profile':
            return 'Profile completed';
        case 'views':
            return number_format((int) $r['note']) . ' page views reached';
        case 'unlock':
            return $r['ref'] === 'code_page' ? 'Unlocked your code page' : 'Unlocked an extra';
        case 'admin':
            return $r['note'] !== '' ? $r['note'] : ((int) $r['amount'] >= 0 ? 'Gift from the team' : 'Correction by the team');
    }
    return $r['note'] !== '' ? $r['note'] : ucfirst((string) $r['reason']);
}

// Profil vollständig: eine Seite mit Profilbild, Text und mindestens 3 sichtbaren Links
function oys_hc_profile_complete(PDO $pdo, int $userId): bool
{
    $stmt = $pdo->prepare("SELECT p.id FROM pages p WHERE p.user_id = ? AND p.avatar IS NOT NULL AND p.avatar <> ''
        AND (COALESCE(p.bio, '') <> '' OR p.subtitle <> '')
        AND (SELECT COUNT(*) FROM page_blocks b WHERE b.page_id = p.id AND b.type = 'link' AND b.is_visible = 1) >= 3 LIMIT 1");
    $stmt->execute([$userId]);
    return (bool) $stmt->fetchColumn();
}

// Verdienen beim Öffnen des Editors. Gibt die neu verdienten Buchungen zurück (für die Meldung im Editor).
function oys_hc_earn(PDO $pdo, int $userId): array
{
    $cfg = oys_hc_settings($pdo);
    $new = [];
    if ($cfg['daily'] > 0 && oys_hc_add($pdo, $userId, $cfg['daily'], 'daily', date('Y-m-d'))) {
        $new[] = ['amount' => $cfg['daily'], 'text' => 'for being active today'];
    }
    if ($cfg['profile'] > 0 && !oys_hc_has($pdo, $userId, 'profile', 'complete') && oys_hc_profile_complete($pdo, $userId)
        && oys_hc_add($pdo, $userId, $cfg['profile'], 'profile', 'complete')) {
        $new[] = ['amount' => $cfg['profile'], 'text' => 'for completing your profile'];
    }
    // Aufrufe lassen sich leicht künstlich hochtreiben: höchstens eine Stufe pro Tag (Bezug = Datum)
    if ($cfg['views'] > 0) {
        $count = $pdo->prepare("SELECT COUNT(*) FROM honeycomb_ledger WHERE user_id = ? AND reason = 'views'");
        $count->execute([$userId]);
        $have = (int) $count->fetchColumn();
        $level = ($have + 1) * $cfg['views_step'];
        if ($have < OYS_HC_MAX_VIEW_REWARDS) {
            $stmt = $pdo->prepare('SELECT COALESCE(SUM(views), 0) FROM pages WHERE user_id = ?');
            $stmt->execute([$userId]);
            if ((int) $stmt->fetchColumn() >= $level && oys_hc_add($pdo, $userId, $cfg['views'], 'views', date('Y-m-d'), (string) $level)) {
                $new[] = ['amount' => $cfg['views'], 'text' => 'for ' . number_format($level) . ' page views'];
            }
        }
    }
    return $new;
}

// Sperre je Nutzer: gleichzeitige Buchungen (zwei Klicks, ein Admin) dürfen den Kontostand nicht unter 0 bringen.
// Gibt zurück, was $fn zurückgibt – oder eine Fehlermeldung, wenn die Sperre nicht frei wird.
function oys_hc_locked(PDO $pdo, int $userId, callable $fn)
{
    $lock = 'oys_hc_' . $userId;
    if ((int) $pdo->query("SELECT GET_LOCK('$lock', 10)")->fetchColumn() !== 1) {
        return 'Honeycombs are busy right now – please try again in a moment.';
    }
    try {
        return $fn();
    } finally {
        $pdo->query("SELECT RELEASE_LOCK('$lock')");
    }
}

// Mit Honigwaben bezahlen (je Bezug nur einmal). Gibt eine Fehlermeldung zurück oder null.
function oys_hc_spend(PDO $pdo, int $userId, int $cost, string $ref): ?string
{
    return oys_hc_locked($pdo, $userId, function () use ($pdo, $userId, $cost, $ref) {
        if (oys_hc_has($pdo, $userId, 'unlock', $ref)) {
            return null;
        }
        $balance = oys_hc_balance($pdo, $userId);
        if ($balance < $cost) {
            return 'You need ' . $cost . ' honeycombs – you have ' . $balance . '.';
        }
        oys_hc_add($pdo, $userId, -$cost, 'unlock', $ref);
        return null;
    });
}

// Daten für den Editor: Kontostand, Verlauf und wie man mehr verdient
function oys_hc_for_editor(PDO $pdo, int $userId, array $earned = []): array
{
    $cfg = oys_hc_settings($pdo);
    $count = $pdo->prepare("SELECT COUNT(*) FROM honeycomb_ledger WHERE user_id = ? AND reason = 'views'");
    $count->execute([$userId]);
    return [
        'balance' => oys_hc_balance($pdo, $userId),
        'earned' => $earned,
        'history' => oys_hc_history($pdo, $userId, 15),
        'rules' => $cfg,
        'today' => oys_hc_has($pdo, $userId, 'daily', date('Y-m-d')),
        'profile' => oys_hc_has($pdo, $userId, 'profile', 'complete'),
        'viewRewards' => (int) $count->fetchColumn(),
        'maxViewRewards' => OYS_HC_MAX_VIEW_REWARDS,
        'codeUnlocked' => oys_hc_has($pdo, $userId, 'unlock', 'code_page'),
    ];
}

// ---------------------------------------------------------------
// Admin: Einstellungen, vergeben/abziehen, Code-Seiten sperren
// ---------------------------------------------------------------
function oys_admin_hc_handle(PDO $pdo, array $post, int $adminId): ?array
{
    $action = (string) ($post['hc_action'] ?? '');
    switch ($action) {
        case 'settings':
            oys_hc_save_settings($pdo, $post);
            return ['ok' => 'Honeycomb settings saved.'];

        case 'grant':
            $userId = (int) ($post['user_id'] ?? 0);
            $amount = (int) ($post['amount'] ?? 0);
            $stmt = $pdo->prepare('SELECT id, full_name, email FROM users WHERE id = ?');
            $stmt->execute([$userId]);
            $user = $stmt->fetch();
            if (!$user) {
                return ['error' => 'Please choose a user.'];
            }
            if ($amount === 0 || abs($amount) > 100000) {
                return ['error' => 'Enter an amount between −100,000 and 100,000 (not 0).'];
            }
            $note = oys_clean_text($post['note'] ?? '', 150);
            // Jedes Formular hat einen eigenen Schlüssel: doppelt abgeschickt wird nur einmal gebucht
            $formRef = (string) ($post['grant_ref'] ?? '');
            $ref = 'a' . $adminId . '-' . (preg_match('/^[0-9a-f]{16}$/', $formRef) ? $formRef : bin2hex(random_bytes(8)));
            $booked = oys_hc_locked($pdo, $userId, function () use ($pdo, $userId, $amount, $ref, $note) {
                if ($amount < 0 && oys_hc_balance($pdo, $userId) + $amount < 0) {
                    return 'That would take the balance below 0 (current: ' . oys_hc_balance($pdo, $userId) . ').';
                }
                return oys_hc_add($pdo, $userId, $amount, 'admin', $ref, $note) ? true : 'This was already booked – the form was sent twice.';
            });
            if ($booked !== true) {
                return ['error' => $booked];
            }
            $name = ($user['full_name'] ?? '') !== '' ? $user['full_name'] : $user['email'];
            return ['ok' => ($amount > 0 ? '+' : '−') . abs($amount) . ' honeycombs for ' . $name . '. New balance: ' . oys_hc_balance($pdo, $userId) . '.'];

        case 'code_block':
        case 'code_unblock':
            $site = oys_code_site_by_id($pdo, (int) ($post['site_id'] ?? 0));
            if (!$site) {
                return ['error' => 'Code page not found.'];
            }
            $block = $action === 'code_block';
            $reason = $block ? oys_clean_text($post['reason'] ?? '', 200) : '';
            $pdo->prepare('UPDATE code_sites SET is_blocked = ?, blocked_reason = ?, updated_at = ? WHERE id = ?')
                ->execute([$block ? 1 : 0, $reason !== '' ? $reason : null, date('Y-m-d H:i:s'), $site['id']]);
            return ['ok' => $block ? '“' . $site['slug'] . '” is blocked.' : '“' . $site['slug'] . '” is online again.'];

        case 'code_unlock':
            // Code-Seite ohne Honigwaben freischalten (z. B. für Tester)
            $stmt = $pdo->prepare('SELECT id, full_name, email FROM users WHERE id = ?');
            $stmt->execute([(int) ($post['user_id'] ?? 0)]);
            $user = $stmt->fetch();
            if (!$user) {
                return ['error' => 'Please choose a user.'];
            }
            $name = ($user['full_name'] ?? '') !== '' ? $user['full_name'] : $user['email'];
            if (!oys_hc_add($pdo, (int) $user['id'], 0, 'unlock', 'code_page', 'Unlocked by the team')) {
                return ['ok' => $name . ' had already unlocked the code page.'];
            }
            return ['ok' => 'Code page unlocked for ' . $name . '.'];
    }
    return null;
}
