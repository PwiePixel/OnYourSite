<?php
// Öffentliche Seite /updates: Roadmap (was gerade passiert, was als Nächstes kommt) und Verlauf aller Updates.
/** @var PDO $pdo */
/** @var ?array $user_data */
$loggedIn = !empty($user_data);
$perPage = OYS_UPDATES_PER_PAGE;
$total = oys_updates_count($pdo, true);
$lastPage = max(1, (int) ceil($total / $perPage));
$pageNo = min($lastPage, max(1, (int) ($_GET['page'] ?? 1)));
$updates = oys_updates_list($pdo, true, $perPage, ($pageNo - 1) * $perPage);

$milestones = oys_milestones($pdo, true);
$columns = ['now' => [], 'next' => [], 'planned' => [], 'done' => []];
$milestoneTitles = [];
foreach ($milestones as $m) {
    $columns[$m['status']][] = $m;
    $milestoneTitles[$m['id']] = $m['title'];
}
$hasRoadmap = $columns['now'] || $columns['next'] || $columns['planned'];
$shipped = array_slice($columns['done'], 0, 6);
// Meilensteine, die hier als Karte stehen (nur auf die kann ein Update verlinken)
$milestoneShown = [];
foreach (array_merge($columns['now'], $columns['next'], $columns['planned'], $shipped) as $m) {
    $milestoneShown[$m['id']] = true;
}
$onThisPage = array_flip(array_column($updates, 'id'));
$updateLink = function (int $id) use ($onThisPage) { return isset($onThisPage[$id]) ? '#update-' . $id : '/updates/' . $id; };

// Zu jedem fertigen Meilenstein das passende Update verlinken
$updateForMilestone = [];
if ($shipped) {
    foreach ($pdo->query('SELECT id, milestone_id FROM updates WHERE is_published = 1 AND milestone_id IS NOT NULL ORDER BY published_at DESC')->fetchAll() as $row) {
        $updateForMilestone[(int) $row['milestone_id']] = $updateForMilestone[(int) $row['milestone_id']] ?? (int) $row['id'];
    }
}

$discord = oys_discord_settings($pdo);
$invite = $discord['invite_url'] !== '' ? $discord['invite_url'] : 'https://discord.on-your.site';
$fmtDate = function ($dt) { return $dt ? date('M j, Y', strtotime((string) $dt)) : ''; };
$description = 'Follow along as OnYourSite grows – what we’re building right now, what’s up next and everything we’ve shipped.';
?>
<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Updates &amp; roadmap | OnYourSite</title>
    <meta name="description" content="<?= e($description) ?>">
    <meta property="og:type" content="website">
    <meta property="og:url" content="<?= e(oys_main_url('/updates')) ?>">
    <meta property="og:title" content="Updates &amp; roadmap | OnYourSite">
    <meta property="og:description" content="<?= e($description) ?>">
    <meta property="og:image" content="<?= e(oys_main_url('/static/images/banner-onyoursite.png')) ?>">
    <link rel="alternate" type="application/atom+xml" title="OnYourSite updates" href="/updates/feed.xml">
    <link rel="icon" type="image/png" href="/static/images/favicon.png">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="<?= e(oys_asset('/static/vendor/boxicons/css/boxicons.min.css')) ?>">
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = {
            theme: {
                extend: {
                    fontFamily: { sans: ['Inter', 'sans-serif'] },
                    colors: {
                        background: '#09090b',
                        card: '#18181b',
                        bordercolor: 'rgba(255, 255, 255, 0.08)',
                        brand: { 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5' }
                    }
                }
            }
        }
    </script>
    <style>
        /* Text aus dem Admin (einfaches Markdown) */
        .md { color: #d4d4d8; line-height: 1.7; overflow-wrap: anywhere; }
        .md > * + * { margin-top: .7em; }
        .md ul { list-style: disc; padding-left: 1.25em; }
        .md ol { list-style: decimal; padding-left: 1.4em; }
        .md li + li { margin-top: .3em; }
        .md li::marker { color: #6366f1; }
        .md strong { color: #fff; font-weight: 600; }
        .md a { color: #a5b4fc; text-decoration: underline; text-underline-offset: 3px; }
        .md a:hover { color: #fff; }
        .md h4 { color: #fff; font-weight: 700; font-size: 1.05em; margin-top: 1.1em; }
        .md h5 { color: #fff; font-weight: 600; margin-top: 1em; }
        .md code { background: rgba(255, 255, 255, .08); padding: .1em .35em; border-radius: 5px; font-size: .9em; }
        .md pre { background: #0b0b0d; border: 1px solid rgba(255, 255, 255, .08); border-radius: 10px; padding: 12px 14px; overflow-x: auto; }
        .md pre code { background: none; padding: 0; }
        .md blockquote { border-left: 3px solid #3f3f46; padding-left: .9em; color: #a1a1aa; }
        .md del { color: #71717a; }
        .md-sm { font-size: .92rem; }
        .bar { height: 6px; border-radius: 99px; background: rgba(255, 255, 255, .08); overflow: hidden; }
        .bar > span { display: block; height: 100%; border-radius: inherit; }
        details > summary { list-style: none; cursor: pointer; }
        details > summary::-webkit-details-marker { display: none; }
        @media (max-width: 639px) { .timeline-line { display: none; } }
    </style>
</head>
<body class="bg-background text-gray-300 font-sans antialiased overflow-x-hidden selection:bg-brand-500/30">

    <nav class="fixed w-full z-50 top-0 backdrop-blur-md bg-background/80 border-b border-bordercolor">
        <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
            <div class="flex justify-between items-center h-16 sm:h-20">
                <a href="/" class="flex items-center gap-2 transition-transform hover:scale-105">
                    <i class='bx bx-hive text-3xl text-brand-500'></i>
                    <span class="font-bold text-xl text-white tracking-tight">OnYourSite</span>
                </a>
                <div class="hidden md:flex items-center space-x-8">
                    <a href="/#features" class="text-sm font-medium text-gray-400 hover:text-white transition-colors">Features</a>
                    <a href="/#designs" class="text-sm font-medium text-gray-400 hover:text-white transition-colors">Themes</a>
                    <a href="/updates" class="text-sm font-medium text-white">Updates</a>
                    <a href="<?= e($invite) ?>" target="_blank" rel="noopener" class="text-sm font-medium text-[#5865F2] hover:text-[#4752C4] transition-colors flex items-center gap-1"><i class='bx bxl-discord-alt text-lg'></i> Community</a>
                    <div class="h-5 w-px bg-bordercolor"></div>
                    <?php if ($loggedIn): ?>
                    <a href="/dashboard" class="text-sm font-medium bg-white text-black px-5 py-2.5 rounded-full hover:bg-gray-200 transition-all">Open editor</a>
                    <?php else: ?>
                    <a href="/login" class="text-sm font-medium text-white hover:text-brand-400 transition-colors">Log in</a>
                    <a href="/register" class="text-sm font-medium bg-white text-black px-5 py-2.5 rounded-full hover:bg-gray-200 transition-all">Start for free</a>
                    <?php endif; ?>
                </div>
                <a href="<?= $loggedIn ? '/dashboard' : '/register' ?>" class="md:hidden text-sm font-medium bg-white text-black px-4 py-2 rounded-full"><?= $loggedIn ? 'Editor' : 'Get started' ?></a>
            </div>
        </div>
    </nav>

    <header class="relative pt-28 sm:pt-36 pb-10 sm:pb-14 px-4">
        <div class="absolute top-0 left-1/2 -translate-x-1/2 w-[700px] max-w-full h-[420px] bg-brand-500/15 rounded-full blur-[110px] -z-10 pointer-events-none"></div>
        <div class="max-w-3xl mx-auto text-center">
            <span class="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-bordercolor bg-white/5 text-xs font-medium text-gray-300"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> Changelog &amp; roadmap</span>
            <h1 class="mt-5 text-4xl sm:text-6xl font-extrabold text-white tracking-tight">What’s new at <span class="text-transparent bg-clip-text bg-gradient-to-r from-brand-400 to-purple-400">OnYourSite</span></h1>
            <p class="mt-5 text-base sm:text-lg text-gray-400"><?= e($description) ?></p>
            <div class="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
                <a href="<?= e($invite) ?>" target="_blank" rel="noopener" class="inline-flex justify-center items-center gap-2 bg-[#5865F2] hover:bg-[#4752C4] text-white px-6 py-3 rounded-full font-medium transition-colors"><i class='bx bxl-discord-alt text-xl'></i> Get updates on Discord</a>
                <a href="/updates/feed.xml" class="inline-flex justify-center items-center gap-2 bg-card border border-bordercolor hover:border-brand-500/50 text-white px-6 py-3 rounded-full font-medium transition-colors"><i class='bx bx-rss text-xl'></i> RSS feed</a>
            </div>
        </div>
    </header>

    <main class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pb-20 space-y-20">

        <?php if ($hasRoadmap): ?>
        <section id="roadmap" class="scroll-mt-24">
            <div class="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2 mb-6">
                <div>
                    <h2 class="text-2xl sm:text-3xl font-bold text-white">Roadmap</h2>
                    <p class="text-gray-400 text-sm mt-1">Progress comes from finished tasks – no guesswork. Targets are rough and can move.</p>
                </div>
            </div>
            <div class="grid gap-5 md:grid-cols-3">
                <?php foreach (['now', 'next', 'planned'] as $status): $info = OYS_MILESTONE_STATUSES[$status]; ?>
                <div class="min-w-0">
                    <div class="flex items-center gap-2 mb-3 px-1">
                        <span class="w-2.5 h-2.5 rounded-full<?= $status === 'now' ? ' animate-pulse' : '' ?>" style="background:<?= e($info['color']) ?>"></span>
                        <h3 class="text-sm font-semibold text-white uppercase tracking-wider"><?= e($info['label']) ?></h3>
                        <span class="text-xs text-gray-500"><?= count($columns[$status]) ?></span>
                    </div>
                    <div class="space-y-4">
                        <?php if (!$columns[$status]): ?>
                            <div class="rounded-2xl border border-dashed border-bordercolor p-5 text-sm text-gray-500"><?= $status === 'now' ? 'Nothing in progress right now.' : 'Nothing here yet.' ?></div>
                        <?php endif; ?>
                        <?php foreach ($columns[$status] as $m): $p = $m['progress']; ?>
                        <article id="milestone-<?= (int) $m['id'] ?>" class="rounded-2xl border border-bordercolor bg-card/70 p-5 scroll-mt-24<?= $status === 'now' ? ' shadow-[0_0_0_1px_rgba(34,197,94,.15),0_20px_40px_-25px_rgba(34,197,94,.35)]' : '' ?>">
                            <div class="flex items-start justify-between gap-3">
                                <h4 class="font-semibold text-white leading-snug"><?= e($m['title']) ?></h4>
                                <?php if ($m['target'] !== ''): ?><span class="shrink-0 text-[11px] font-medium text-gray-300 bg-white/5 border border-bordercolor rounded-full px-2 py-0.5" title="Rough target"><?= e($m['target']) ?></span><?php endif; ?>
                            </div>
                            <?php if ($m['description'] !== ''): ?><div class="md md-sm mt-2 text-gray-400"><?= oys_markdown($m['description']) ?></div><?php endif; ?>
                            <?php if ($p): ?>
                            <div class="mt-4">
                                <div class="flex justify-between text-xs mb-1.5"><span class="text-gray-400"><?= $p['done'] ?> of <?= $p['total'] ?> tasks done</span><span class="text-white font-semibold"><?= $p['percent'] ?>%</span></div>
                                <div class="bar"><span style="width:<?= $p['percent'] ?>%;background:<?= e($info['color']) ?>"></span></div>
                            </div>
                            <?php endif; ?>
                            <?php if ($m['tasks']): $shown = array_slice($m['tasks'], 0, 5); $rest = array_slice($m['tasks'], 5); ?>
                            <ul class="mt-4 space-y-1.5 text-sm">
                                <?php foreach ($shown as $t): ?>
                                <li class="flex gap-2 <?= $t['is_done'] ? 'text-gray-500' : 'text-gray-300' ?>"><i class='bx <?= $t['is_done'] ? 'bx-check-circle text-emerald-400' : 'bx-circle text-gray-600' ?> text-base mt-0.5 shrink-0'></i><span class="<?= $t['is_done'] ? 'line-through decoration-gray-600' : '' ?>"><?= e($t['title']) ?></span></li>
                                <?php endforeach; ?>
                            </ul>
                            <?php if ($rest): ?>
                            <details class="mt-1.5 text-sm">
                                <summary class="text-brand-400 hover:text-white py-1"><?= count($rest) ?> more task<?= count($rest) === 1 ? '' : 's' ?></summary>
                                <ul class="mt-1 space-y-1.5">
                                    <?php foreach ($rest as $t): ?>
                                    <li class="flex gap-2 <?= $t['is_done'] ? 'text-gray-500' : 'text-gray-300' ?>"><i class='bx <?= $t['is_done'] ? 'bx-check-circle text-emerald-400' : 'bx-circle text-gray-600' ?> text-base mt-0.5 shrink-0'></i><span class="<?= $t['is_done'] ? 'line-through decoration-gray-600' : '' ?>"><?= e($t['title']) ?></span></li>
                                    <?php endforeach; ?>
                                </ul>
                            </details>
                            <?php endif; ?>
                            <?php endif; ?>
                            <p class="mt-4 text-xs text-gray-500">
                                <?php if ($status === 'now' && $m['started_at']): ?>Started <?= e($fmtDate($m['started_at'])) ?> · <?php endif; ?>Updated <?= e(oys_time_ago($m['updated_at'])) ?>
                            </p>
                        </article>
                        <?php endforeach; ?>
                    </div>
                </div>
                <?php endforeach; ?>
            </div>
        </section>
        <?php endif; ?>

        <?php if ($shipped): ?>
        <section id="shipped" class="scroll-mt-24">
            <h2 class="text-xl sm:text-2xl font-bold text-white mb-5">Recently shipped</h2>
            <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <?php foreach ($shipped as $m): $uid = $updateForMilestone[$m['id']] ?? null; ?>
                <div id="milestone-<?= (int) $m['id'] ?>" class="flex gap-3 rounded-xl border border-bordercolor bg-card/50 p-4 scroll-mt-24">
                    <span class="w-9 h-9 rounded-lg bg-amber-500/10 text-amber-400 flex items-center justify-center shrink-0"><i class='bx bx-rocket text-xl'></i></span>
                    <div class="min-w-0">
                        <p class="font-medium text-white leading-snug"><?= e($m['title']) ?></p>
                        <p class="text-xs text-gray-500 mt-1">Shipped <?= e($fmtDate($m['done_at'] ?: $m['updated_at'])) ?><?php if ($uid): ?> · <a href="<?= e($updateLink($uid)) ?>" class="text-brand-400 hover:text-white">Read the update</a><?php endif; ?></p>
                    </div>
                </div>
                <?php endforeach; ?>
            </div>
        </section>
        <?php endif; ?>

        <section id="changelog" class="scroll-mt-24">
            <div class="flex items-end justify-between gap-3 mb-8">
                <div>
                    <h2 class="text-2xl sm:text-3xl font-bold text-white">Changelog</h2>
                    <p class="text-gray-400 text-sm mt-1">Everything that changed, newest first.</p>
                </div>
            </div>

            <?php if (!$updates): ?>
                <div class="rounded-2xl border border-dashed border-bordercolor p-10 text-center">
                    <i class='bx bx-news text-4xl text-gray-600'></i>
                    <p class="mt-3 text-gray-400">No updates yet – stay tuned.</p>
                </div>
            <?php else: ?>
            <div class="relative">
                <div class="timeline-line absolute left-[152px] top-2 bottom-2 w-px bg-bordercolor"></div>
                <div class="space-y-10">
                    <?php foreach ($updates as $u): $cat = OYS_UPDATE_CATEGORIES[$u['category']]; ?>
                    <article id="update-<?= $u['id'] ?>" class="relative sm:grid sm:grid-cols-[132px_1fr] sm:gap-10 scroll-mt-24">
                        <div class="sm:text-right sm:pt-1 mb-3 sm:mb-0">
                            <time datetime="<?= e(date('Y-m-d', strtotime((string) $u['published_at']))) ?>" class="text-sm text-gray-400"><?= e($fmtDate($u['published_at'])) ?></time>
                            <?php if ($u['version'] !== ''): ?><div class="inline-block sm:block ml-2 sm:ml-0 sm:mt-1 text-xs font-mono text-gray-500">v<?= e(ltrim($u['version'], 'vV')) ?></div><?php endif; ?>
                        </div>
                        <span class="timeline-line absolute left-[147px] top-2 w-[11px] h-[11px] rounded-full border-2 border-background" style="background:<?= e($cat['color']) ?>"></span>
                        <div class="min-w-0 rounded-2xl border border-bordercolor bg-card/50 p-5 sm:p-6">
                            <div class="flex flex-wrap items-center gap-2 mb-3">
                                <span class="text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full" style="color:<?= e($cat['color']) ?>;background:<?= e($cat['color']) ?>1f"><?= e($cat['label']) ?></span>
                                <?php if ($u['milestone_id'] && isset($milestoneShown[$u['milestone_id']])): ?>
                                <a href="#milestone-<?= (int) $u['milestone_id'] ?>" class="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-white border border-bordercolor rounded-full px-2.5 py-1.5"><i class='bx bx-flag'></i> <?= e($milestoneTitles[$u['milestone_id']]) ?></a>
                                <?php elseif ($u['milestone_id'] && isset($milestoneTitles[$u['milestone_id']])): ?>
                                <span class="inline-flex items-center gap-1 text-xs text-gray-400 border border-bordercolor rounded-full px-2.5 py-1.5"><i class='bx bx-flag'></i> <?= e($milestoneTitles[$u['milestone_id']]) ?></span>
                                <?php endif; ?>
                            </div>
                            <h3 class="text-lg sm:text-xl font-bold text-white leading-snug"><a href="#update-<?= $u['id'] ?>" class="hover:text-brand-400 transition-colors"><?= e($u['title']) ?></a></h3>
                            <?php if (trim($u['body']) !== ''): ?><div class="md mt-3"><?= oys_markdown($u['body']) ?></div><?php endif; ?>
                        </div>
                    </article>
                    <?php endforeach; ?>
                </div>
            </div>

            <?php if ($lastPage > 1): ?>
            <nav class="mt-10 flex items-center justify-between gap-3 text-sm" aria-label="Pages">
                <?php if ($pageNo > 1): ?><a href="/updates<?= $pageNo - 1 > 1 ? '?page=' . ($pageNo - 1) : '' ?>#changelog" class="inline-flex items-center gap-1 px-4 py-2.5 rounded-full border border-bordercolor hover:border-brand-500/50 text-white"><i class='bx bx-left-arrow-alt'></i> Newer</a><?php else: ?><span></span><?php endif; ?>
                <span class="text-gray-500">Page <?= $pageNo ?> of <?= $lastPage ?></span>
                <?php if ($pageNo < $lastPage): ?><a href="/updates?page=<?= $pageNo + 1 ?>#changelog" class="inline-flex items-center gap-1 px-4 py-2.5 rounded-full border border-bordercolor hover:border-brand-500/50 text-white">Older <i class='bx bx-right-arrow-alt'></i></a><?php else: ?><span></span><?php endif; ?>
            </nav>
            <?php endif; ?>
            <?php endif; ?>
        </section>
    </main>

    <footer class="border-t border-bordercolor bg-[#050505] py-12">
        <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col items-center">
            <div class="flex items-center flex-wrap justify-center gap-x-4 mb-6 text-sm text-gray-500 font-medium">
                <a href="/" class="inline-block py-2 hover:text-white transition-colors">Home</a>
                <span>&bull;</span>
                <a href="/imprint" class="inline-block py-2 hover:text-white transition-colors">Legal notice</a>
                <span>&bull;</span>
                <a href="/privacy" class="inline-block py-2 hover:text-white transition-colors">Privacy</a>
                <span>&bull;</span>
                <a href="/terms" class="inline-block py-2 hover:text-white transition-colors">Terms</a>
            </div>
            <p class="text-gray-500 text-sm">&copy; <?= date('Y') ?> OnYourSite. Made with <i class='bx bxs-heart text-red-500 mx-1'></i> for the community.</p>
        </div>
    </footer>
</body>
</html>
