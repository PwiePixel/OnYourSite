<?php
// Wochenbericht: jeden Montag eine kurze Mail mit Aufrufen, Klicks und dem besten Link.

function oys_week_numbers(PDO $pdo, int $pageId, string $from, string $to): array
{
    $stmt = $pdo->prepare('SELECT COALESCE(SUM(views),0) AS views, COALESCE(SUM(clicks),0) AS clicks FROM stats_daily WHERE page_id = ? AND day BETWEEN ? AND ?');
    $stmt->execute([$pageId, $from, $to]);
    $row = $stmt->fetch();
    return ['views' => (int) $row['views'], 'clicks' => (int) $row['clicks']];
}

function oys_week_best_link(PDO $pdo, int $pageId, string $from, string $to): ?array
{
    $stmt = $pdo->prepare('SELECT block_id, item, SUM(clicks) AS clicks FROM block_clicks_daily WHERE page_id = ? AND day BETWEEN ? AND ? GROUP BY block_id, item ORDER BY clicks DESC LIMIT 1');
    $stmt->execute([$pageId, $from, $to]);
    $row = $stmt->fetch();
    if (!$row || (int) $row['clicks'] === 0) {
        return null;
    }
    $b = $pdo->prepare('SELECT * FROM page_blocks WHERE id = ?');
    $b->execute([$row['block_id']]);
    $block = $b->fetch();
    if (!$block) {
        return null;
    }
    $data = json_decode((string) $block['data'], true) ?: [];
    $title = $row['item'] !== '' ? (oys_brands()[$row['item']]['name'] ?? $row['item']) : (($data['title'] ?? '') ?: (oys_block_types()[$block['type']] ?? 'Link'));
    return ['title' => $title, 'clicks' => (int) $row['clicks']];
}

// Baut die Daten für alle Seiten eines Nutzers (letzte 7 volle Tage)
function oys_weekly_report_data(PDO $pdo, int $userId): array
{
    $to = new DateTimeImmutable('yesterday');
    $from = $to->modify('-6 days');
    $prevTo = $from->modify('-1 day');
    $prevFrom = $prevTo->modify('-6 days');

    $pages = [];
    foreach (oys_user_pages($pdo, $userId) as $page) {
        $now = oys_week_numbers($pdo, (int) $page['id'], $from->format('Y-m-d'), $to->format('Y-m-d'));
        $prev = oys_week_numbers($pdo, (int) $page['id'], $prevFrom->format('Y-m-d'), $prevTo->format('Y-m-d'));
        $pages[] = [
            'page' => $page,
            'views' => $now['views'],
            'clicks' => $now['clicks'],
            'prev_views' => $prev['views'],
            'best' => oys_week_best_link($pdo, (int) $page['id'], $from->format('Y-m-d'), $to->format('Y-m-d')),
        ];
    }
    return [
        'from' => $from,
        'to' => $to,
        'pages' => $pages,
        'views' => array_sum(array_column($pages, 'views')),
        'clicks' => array_sum(array_column($pages, 'clicks')),
    ];
}

function oys_weekly_report_html(array $report): string
{
    $rows = '';
    foreach ($report['pages'] as $p) {
        $trend = '';
        if ($p['prev_views'] > 0) {
            $pct = (int) round(($p['views'] - $p['prev_views']) / $p['prev_views'] * 100);
            $color = $pct >= 0 ? '#34d399' : '#f87171';
            $trend = '<span style="color:' . $color . ';font-size:12px;font-weight:bold;"> ' . ($pct >= 0 ? '+' : '') . $pct . '%</span>';
        }
        $best = $p['best']
            ? '🏆 Best link: <strong style="color:#ffffff;">' . e($p['best']['title']) . '</strong> (' . (int) $p['best']['clicks'] . ((int) $p['best']['clicks'] === 1 ? ' click)' : ' clicks)')
            : 'No links were clicked this week.';
        $rows .= '<div style="background-color:#0a0a0a;border:1px solid #27272a;border-radius:12px;padding:20px;margin:0 auto 16px auto;max-width:460px;text-align:left;">'
            . '<p style="margin:0 0 12px 0;font-size:14px;color:#818cf8;font-weight:bold;">' . e(oys_page_display_url($p['page'])) . '</p>'
            . '<table role="presentation" width="100%" style="border-collapse:collapse;"><tr>'
            . '<td style="padding:0;width:50%;"><div style="font-size:26px;font-weight:bold;color:#ffffff;">' . number_format($p['views']) . $trend . '</div><div style="font-size:12px;color:#9ca3af;">Views</div></td>'
            . '<td style="padding:0;width:50%;"><div style="font-size:26px;font-weight:bold;color:#ffffff;">' . number_format($p['clicks']) . '</div><div style="font-size:12px;color:#9ca3af;">Clicks</div></td>'
            . '</tr></table>'
            . '<p style="margin:14px 0 0 0;font-size:13px;color:#9ca3af;">' . $best . '</p></div>';
    }
    return $rows;
}

function oys_send_weekly_report(PDO $pdo, array $user): bool
{
    $report = oys_weekly_report_data($pdo, (int) $user['id']);
    if (!$report['pages']) {
        return false;
    }
    $period = $report['from']->format('M j') . ' – ' . $report['to']->format('M j, Y');
    return sendCustomEmail($user['email'], 'weekly_report', [
        'full_name' => e($user['full_name'] ?: 'there'),
        'period' => e($period),
        'views' => number_format($report['views']),
        'clicks' => number_format($report['clicks']),
        'report_html' => oys_weekly_report_html($report),
        'dashboard_url' => e(oys_main_url('/dashboard')),
    ], 'Your weekly report: ' . number_format($report['views']) . ($report['views'] === 1 ? ' view, ' : ' views, ') . number_format($report['clicks']) . ($report['clicks'] === 1 ? ' click' : ' clicks'));
}

// Für den Cronjob: schickt allen Nutzern mit Wochenbericht ihre Mail (max. einmal pro Tag)
function oys_run_weekly_reports(PDO $pdo): array
{
    $todayStart = date('Y-m-d 00:00:00');
    $stmt = $pdo->prepare('SELECT id, email, full_name FROM users WHERE weekly_report = 1 AND (weekly_report_sent_at IS NULL OR weekly_report_sent_at < ?)');
    $stmt->execute([$todayStart]);
    $sent = $failed = 0;
    foreach ($stmt->fetchAll() as $user) {
        if (oys_send_weekly_report($pdo, $user)) {
            $sent++;
            $pdo->prepare('UPDATE users SET weekly_report_sent_at = ? WHERE id = ?')->execute([date('Y-m-d H:i:s'), $user['id']]);
        } else {
            $failed++;
        }
    }
    return ['sent' => $sent, 'failed' => $failed];
}
