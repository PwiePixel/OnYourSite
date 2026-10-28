<?php
// Statistik ohne Cookies und ohne IP-Adressen: Es werden nur Zähler pro Tag gespeichert.

function oys_record_view(PDO $pdo, int $pageId): void
{
    $today = date('Y-m-d');
    $pdo->prepare('INSERT INTO stats_daily (page_id, day, views) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE views = views + 1')
        ->execute([$pageId, $today]);
    $pdo->prepare('UPDATE pages SET views = views + 1 WHERE id = ?')->execute([$pageId]);
}

function oys_record_click(PDO $pdo, int $pageId, int $blockId, string $item = ''): void
{
    $today = date('Y-m-d');
    $item = substr(preg_replace('/[^a-z0-9]/', '', strtolower($item)), 0, 24);
    $pdo->prepare('INSERT INTO block_clicks_daily (block_id, item, day, page_id, clicks) VALUES (?, ?, ?, ?, 1) ON DUPLICATE KEY UPDATE clicks = clicks + 1')
        ->execute([$blockId, $item, $today, $pageId]);
    $pdo->prepare('INSERT INTO stats_daily (page_id, day, clicks) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE clicks = clicks + 1')
        ->execute([$pageId, $today]);
    $pdo->prepare('UPDATE page_blocks SET clicks = clicks + 1 WHERE id = ?')->execute([$blockId]);
}

// Kommt die Anfrage von unserer eigenen Seite? (einfacher Schutz gegen fremdes Hochzählen)
function oys_request_from_own_site(): bool
{
    $origin = $_SERVER['HTTP_ORIGIN'] ?? ($_SERVER['HTTP_REFERER'] ?? '');
    if ($origin === '' || $origin === 'null') {
        return true;
    }
    $host = strtolower((string) parse_url($origin, PHP_URL_HOST));
    $base = oys_base_host();
    return $host === $base || str_ends_with($host, '.' . $base);
}

// Auswertung für den Editor. $days = 0 bedeutet "gesamt".
function oys_stats(PDO $pdo, array $page, int $days): array
{
    $pageId = (int) $page['id'];
    $today = new DateTimeImmutable('today');

    if ($days > 0) {
        $from = $today->modify('-' . ($days - 1) . ' days');
    } else {
        $first = $pdo->prepare('SELECT MIN(day) FROM stats_daily WHERE page_id = ?');
        $first->execute([$pageId]);
        $min = $first->fetchColumn();
        $from = $min ? new DateTimeImmutable($min) : $today->modify('-29 days');
        if ($from > $today->modify('-6 days')) {
            $from = $today->modify('-6 days');
        }
    }

    $stmt = $pdo->prepare('SELECT day, views, clicks FROM stats_daily WHERE page_id = ? AND day >= ? ORDER BY day');
    $stmt->execute([$pageId, $from->format('Y-m-d')]);
    $byDay = [];
    foreach ($stmt->fetchAll() as $row) {
        $byDay[$row['day']] = $row;
    }

    // Lückenlos auffüllen; bei langen Zeiträumen nach Wochen bündeln
    $series = [];
    $span = (int) $from->diff($today)->days + 1;
    $bucket = $span > 120 ? 7 : 1;
    for ($d = $from; $d <= $today; $d = $d->modify("+$bucket days")) {
        $views = $clicks = 0;
        for ($i = 0; $i < $bucket; $i++) {
            $key = $d->modify("+$i days")->format('Y-m-d');
            if (isset($byDay[$key])) {
                $views += (int) $byDay[$key]['views'];
                $clicks += (int) $byDay[$key]['clicks'];
            }
        }
        $series[] = ['day' => $d->format('Y-m-d'), 'views' => $views, 'clicks' => $clicks];
    }

    $views = array_sum(array_column($series, 'views'));
    $clicks = array_sum(array_column($series, 'clicks'));

    // Klicks je Block (und je Plattform bei Social-Icons)
    $stmt = $pdo->prepare('SELECT block_id, item, SUM(clicks) AS clicks FROM block_clicks_daily WHERE page_id = ? AND day >= ? GROUP BY block_id, item');
    $stmt->execute([$pageId, $from->format('Y-m-d')]);
    $clicksBy = [];
    foreach ($stmt->fetchAll() as $row) {
        $clicksBy[$row['block_id'] . '|' . $row['item']] = (int) $row['clicks'];
    }

    $links = [];
    $brands = oys_brands();
    foreach (oys_load_blocks($pdo, $pageId) as $b) {
        $d = $b['data'];
        if ($b['type'] === 'socials') {
            foreach ($d['items'] ?? [] as $item) {
                if (oys_social_url($item['p'], (string) $item['v']) === '') continue;
                $links[] = [
                    'id' => $b['id'],
                    'item' => $item['p'],
                    'title' => $brands[$item['p']]['name'],
                    'kind' => 'Social icon',
                    'icon' => 'brand:' . $item['p'],
                    'clicks' => $clicksBy[$b['id'] . '|' . $item['p']] ?? 0,
                    'total' => null,
                ];
            }
            continue;
        }
        if (!in_array($b['type'], ['link', 'booking', 'file', 'image', 'countdown', 'embed'], true)) {
            continue;
        }
        if (in_array($b['type'], ['image', 'countdown', 'embed'], true) && empty($clicksBy[$b['id'] . '|'])) {
            continue;
        }
        $title = $d['title'] ?? '';
        if ($title === '') {
            $title = oys_block_types()[$b['type']] ?? 'Block';
        }
        $links[] = [
            'id' => $b['id'],
            'item' => '',
            'title' => $title,
            'kind' => oys_block_types()[$b['type']] ?? '',
            'icon' => $b['type'] === 'link' ? (string) ($d['icon'] ?? '') : '',
            'url' => $d['url'] ?? '',
            'clicks' => $clicksBy[$b['id'] . '|'] ?? 0,
            'total' => $b['clicks'],
        ];
    }
    usort($links, fn($a, $b) => $b['clicks'] <=> $a['clicks']);

    return [
        'range' => $days,
        'from' => $from->format('Y-m-d'),
        'bucket' => $bucket,
        'views' => $views,
        'clicks' => $clicks,
        'ctr' => $views > 0 ? round($clicks / $views * 100, 1) : 0,
        'total_views' => (int) $page['views'],
        'series' => $series,
        'links' => $links,
        'best' => $links && $links[0]['clicks'] > 0 ? $links[0] : null,
    ];
}
