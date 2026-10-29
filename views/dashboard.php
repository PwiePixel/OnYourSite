<?php
// Editor (Dashboard). Inhalt und Vorschau werden von static/js/editor.js gesteuert.
/** @var array $user_data */
/** @var ?array $page */
/** @var array $pages */
/** @var array $blocks */
/** @var bool $is_impersonating */
/** @var bool $has_premium_access */

$brands = [];
foreach (oys_brands() as $key => $b) {
    $brands[] = ['key' => $key, 'name' => $b['name'], 'color' => $b['color'], 'svg' => $b['svg'], 'url' => $b['url'], 'domains' => $b['domains']];
}
$editorData = [
    'csrf' => oys_csrf_token(),
    'page' => $page ? oys_page_for_editor($page) : null,
    'blocks' => array_map('oys_block_for_editor', $blocks),
    'pages' => array_map(fn($p) => ['id' => (int) $p['id'], 'slug' => $p['slug'], 'title' => $p['title'], 'url' => oys_page_display_url($p), 'avatar' => $p['avatar'] ? oys_upload_url($p['avatar']) : ''], $pages),
    'maxPages' => (int) oys_config('max_pages', 3),
    'premium' => (bool) $has_premium_access,
    'themes' => oys_themes(),
    'defaultTheme' => OYS_DEFAULT_THEME,
    'layouts' => oys_layouts(),
    'fonts' => oys_font_choices(),
    'brands' => $brands,
    'bxIcons' => oys_bx_icons(),
    'baseHost' => oys_base_authority(),
    'scheme' => oys_scheme(),
    'timezone' => oys_config('timezone', 'Europe/Berlin'),
    'uploadLimitMb' => oys_upload_limit_mb(),
    'qrJs' => oys_asset('/static/vendor/qrcode/qrcode.js'),
    'honeycombs' => $honeycombs,
    'cm' => ['js' => oys_asset('/static/vendor/codemirror/codemirror.js'), 'css' => oys_asset('/static/vendor/codemirror/codemirror.css')],
    'codeTerms' => '/terms/code-pages',
    'slugDaysLeft' => $page && $page['slug_changed_at'] && !$has_premium_access ? max(0, 30 - (int) floor((time() - strtotime($page['slug_changed_at'])) / 86400)) : 0,
    'user' => [
        'name' => $user_data['full_name'] ?? '',
        'email' => $user_data['email'] ?? '',
        'weekly' => !empty($user_data['weekly_report']),
        'discord' => $user_data['discord_id'] ?? '',
        'admin' => !empty($user_data['is_admin']),
    ],
];
$flashSuccess = $_SESSION['success'] ?? null;
$flashError = $_SESSION['error'] ?? null;
unset($_SESSION['success'], $_SESSION['error']);
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Editor | OnYourSite</title>
    <meta name="robots" content="noindex">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="<?= e(oys_asset('/static/vendor/boxicons/css/boxicons.min.css')) ?>">
    <link rel="icon" type="image/png" href="/static/images/favicon.png">
    <script src="https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/Sortable.min.js"></script>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = { theme: { extend: { fontFamily: { sans: ['Inter', 'sans-serif'], }, colors: { background: '#000000', card: '#0a0a0a', inputbg: '#121212', bordercolor: '#27272a', brand: { 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5', } } } } }
    </script>
    <link rel="stylesheet" href="<?= e(oys_asset('/static/css/fonts.css')) ?>">
    <link rel="stylesheet" href="<?= e(oys_asset('/static/css/themes.css')) ?>">
    <link rel="stylesheet" href="<?= e(oys_asset('/static/css/page.css')) ?>">
    <link rel="stylesheet" href="<?= e(oys_asset('/static/css/editor.css')) ?>">
</head>
<body class="bg-background text-gray-300 font-sans h-screen flex flex-col overflow-hidden selection:bg-brand-500/30">

    <?php if ($is_impersonating): ?>
    <div class="bg-emerald-500 text-white text-center py-2.5 text-sm font-bold flex items-center justify-center gap-2 shadow-lg relative z-[200] shrink-0 w-full">
        <i class='bx bx-mask text-xl'></i> Admin mode: You’re editing <?= e($user_data['full_name']) ?>
        <form method="post" action="/admin_return.php" class="ml-4 m-0"><?= oys_csrf_field() ?><button type="submit" class="bg-white/20 hover:bg-white/30 px-3 py-1 rounded-md transition-colors border border-white/20 flex items-center gap-1 shadow-sm"><i class='bx bx-left-arrow-alt'></i> Back to admin panel</button></form>
    </div>
    <?php endif; ?>

    <div class="flex-1 flex overflow-hidden">
        <aside class="app-rail w-16 sm:w-20 lg:w-64 border-r border-bordercolor bg-card flex flex-col justify-between py-6 transition-all z-20 shrink-0">
            <div>
                <a href="/" class="rail-logo px-3 sm:px-6 mb-8 flex items-center justify-center lg:justify-start gap-2 transition-transform hover:scale-105">
                    <i class='bx bx-hive text-3xl text-brand-500'></i><span class="font-bold text-xl text-white tracking-tight hidden lg:block">OnYourSite</span>
                </a>
                <div class="rail-label px-4 mb-2 hidden lg:block"><p class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Menu</p></div>
                <nav class="space-y-1 px-2 sm:px-3" id="mainNav">
                    <button type="button" data-tab="content" class="nav-btn"><i class='bx bx-layout text-xl'></i> <span class="hidden lg:block text-sm">Content</span></button>
                    <button type="button" data-tab="design" class="nav-btn"><i class='bx bx-palette text-xl'></i> <span class="hidden lg:block text-sm">Design</span></button>
                    <button type="button" data-tab="stats" class="nav-btn"><i class='bx bx-bar-chart-alt-2 text-xl'></i> <span class="hidden lg:block text-sm">Stats</span></button>
                    <button type="button" data-tab="messages" class="nav-btn"><i class='bx bx-envelope text-xl'></i> <span class="hidden lg:block text-sm"><span class="nav-full">Messages</span><span class="nav-short">Inbox</span></span><span class="nav-badge" id="navMsgBadge" hidden>0</span></button>
                    <button type="button" data-tab="code" class="nav-btn"><i class='bx bx-code-alt text-xl'></i> <span class="hidden lg:block text-sm">Code<span class="nav-long"> page</span></span></button>
                    <button type="button" data-tab="settings" class="nav-btn"><i class='bx bx-cog text-xl'></i> <span class="hidden lg:block text-sm">Settings</span></button>
                    <button type="button" id="navPreviewBtn" class="nav-btn nav-preview"><i class='bx bx-mobile-alt text-xl'></i> <span class="hidden lg:block text-sm">Preview</span></button>
                </nav>
            </div>
            <div class="rail-foot px-2 sm:px-3 space-y-1">
                <?php if (!empty($user_data['is_admin'])): ?>
                <a href="/admin" class="flex items-center justify-center lg:justify-start gap-3 px-3 py-2.5 rounded-lg hover:bg-white/5 text-gray-500 hover:text-white transition-colors"><i class='bx bx-shield-quarter text-xl'></i> <span class="hidden lg:block text-sm">Admin</span></a>
                <?php endif; ?>
                <form method="post" action="/logout" class="m-0"><?= oys_csrf_field() ?><button type="submit" class="w-full flex items-center justify-center lg:justify-start gap-3 px-3 py-2.5 rounded-lg hover:bg-red-500/10 text-gray-500 hover:text-red-400 transition-colors"><i class='bx bx-log-out text-xl'></i> <span class="hidden lg:block text-sm">Log out</span></button></form>
            </div>
        </aside>

        <div class="flex-1 flex flex-col h-full overflow-hidden w-full bg-background relative min-w-0">
            <header class="h-16 border-b border-bordercolor bg-background/80 backdrop-blur-md flex items-center justify-between gap-2 sm:gap-3 px-2 sm:px-6 shrink-0 z-30">
                <div class="flex items-center gap-3 min-w-0">
                    <div class="relative" id="pageSwitcher">
                        <button type="button" id="pageSwitcherBtn" class="flex items-center gap-2 max-w-[42vw] sm:max-w-xs bg-white/5 hover:bg-white/10 border border-bordercolor rounded-lg pl-1.5 pr-2.5 py-1.5 transition-colors">
                            <span class="ps-avatar" id="psAvatar"></span>
                            <span class="text-sm text-white font-medium truncate hidden min-[420px]:inline" id="psLabel">Page</span>
                            <i class='bx bx-chevron-down text-gray-400'></i>
                        </button>
                        <div id="pageMenu" class="dropdown hidden w-72 left-0"></div>
                    </div>
                    <h1 class="text-base font-semibold text-white tracking-tight hidden md:block" id="pageTitle">Content</h1>
                </div>
                <div class="flex items-center gap-2 sm:gap-3">
                    <button type="button" id="hcBtn" class="hc-pill" data-action="honeycombs" title="Your honeycombs" aria-label="Your honeycombs"><i class='bx bx-hive'></i><span id="hcBalance"><?= (int) $honeycombs['balance'] ?></span></button>
                    <div class="relative">
                        <button type="button" id="bellBtn" class="relative w-9 h-9 rounded-lg hover:bg-white/5 border border-transparent hover:border-bordercolor flex items-center justify-center text-gray-400 hover:text-white transition-colors" aria-label="Notifications">
                            <i class='bx bx-bell text-xl'></i><span id="bellBadge" class="bell-badge" hidden>0</span>
                        </button>
                        <div id="bellMenu" class="dropdown hidden w-80 right-0"></div>
                    </div>
                    <button type="button" id="shareBtn" data-action="share"<?= $page ? '' : ' style="display:none"' ?> class="h-9 px-2.5 rounded-lg hover:bg-white/5 border border-transparent hover:border-bordercolor flex items-center gap-1.5 text-gray-400 hover:text-white transition-colors" aria-label="Share your page" title="Share your page">
                        <i class='bx bx-share-alt text-xl'></i><span class="hidden xl:inline text-sm">Share</span>
                    </button>
                    <a id="viewPageLink" href="#" target="_blank" rel="noopener"<?= $page ? '' : ' style="display:none"' ?> class="text-sm text-gray-400 hover:text-brand-400 hidden sm:flex items-center gap-1.5 transition-colors bg-white/5 px-3 py-1.5 rounded-md border border-bordercolor hover:border-brand-500/30 max-w-[220px]">
                        <span class="truncate" id="viewPageLabel"></span> <i class='bx bx-link-external shrink-0'></i>
                    </a>
                    <button type="button" id="saveBtn" class="bg-white text-black hover:bg-gray-200 px-4 sm:px-5 py-1.5 rounded-md text-sm font-semibold transition-all shadow-sm flex items-center gap-1.5 disabled:opacity-60">
                        <i class='bx bx-check text-lg hidden' id="saveIcon"></i><span id="saveLabel">Save</span>
                    </button>
                </div>
            </header>

            <div class="flex-1 flex overflow-hidden relative">
                <main id="editorScroll" class="flex-1 overflow-y-auto p-4 md:p-8 custom-scrollbar relative min-w-0">
                    <?php if (!$page): ?>
                        <div id="noPageBox" class="max-w-lg mx-auto mt-10 bg-card border border-bordercolor rounded-2xl p-8 text-center">
                            <div class="w-14 h-14 mx-auto rounded-2xl bg-brand-500/20 text-brand-400 flex items-center justify-center text-3xl mb-4"><i class='bx bx-rocket'></i></div>
                            <h2 class="text-xl font-bold text-white mb-2">Create your first page</h2>
                            <p class="text-gray-400 text-sm mb-6">Choose an address – you can still change it later.</p>
                            <button type="button" class="btn-primary mx-auto" data-action="new-page"><i class='bx bx-plus'></i> Create page</button>
                        </div>
                    <?php endif; ?>
                    <div id="tab-content" class="tab-content"></div>
                    <div id="tab-design" class="tab-content hidden"></div>
                    <div id="tab-stats" class="tab-content hidden"></div>
                    <div id="tab-messages" class="tab-content hidden"></div>
                    <div id="tab-code" class="tab-content hidden"></div>
                    <div id="tab-settings" class="tab-content hidden">
                        <div id="settingsDynamic"></div>
                        <section class="max-w-3xl mx-auto mt-8">
                            <h2 class="section-title">Account</h2>
                            <div class="grid gap-6 md:grid-cols-2">
                                <form action="/dashboard" method="POST" class="panel space-y-4">
                                    <?= oys_csrf_field() ?>
                                    <input type="hidden" name="update_action" value="email">
                                    <h3 class="text-sm font-semibold text-white flex items-center gap-2"><i class='bx bx-envelope text-brand-400'></i> Change email address</h3>
                                    <p class="text-xs text-gray-500">Current: <span class="text-gray-300"><?= e($user_data['email'] ?? '') ?></span></p>
                                    <input type="email" name="new_email" required placeholder="New email address" class="field">
                                    <input type="password" name="current_password_email" required placeholder="Current password" class="field">
                                    <button type="submit" class="btn-secondary w-full justify-center">Change email</button>
                                </form>
                                <form action="/dashboard" method="POST" class="panel space-y-4">
                                    <?= oys_csrf_field() ?>
                                    <input type="hidden" name="update_action" value="password">
                                    <h3 class="text-sm font-semibold text-white flex items-center gap-2"><i class='bx bx-lock-alt text-brand-400'></i> Change password</h3>
                                    <input type="password" name="new_password" required minlength="8" placeholder="New password (min. 8 characters)" class="field">
                                    <input type="password" name="confirm_new_password" required minlength="8" placeholder="Repeat new password" class="field">
                                    <input type="password" name="current_password_pwd" required placeholder="Current password" class="field">
                                    <button type="submit" class="btn-secondary w-full justify-center">Change password</button>
                                </form>
                            </div>
                            <!-- Auf dem Handy gibt es keine Seitenleiste: Admin und Abmelden hier -->
                            <div class="sm:hidden mt-6 grid gap-3">
                                <?php if (!empty($user_data['is_admin'])): ?>
                                <a href="/admin" class="btn-secondary w-full justify-center"><i class='bx bx-shield-quarter'></i> Admin panel</a>
                                <?php endif; ?>
                                <form method="post" action="/logout" class="m-0"><?= oys_csrf_field() ?><button type="submit" class="btn-secondary w-full justify-center text-red-400"><i class='bx bx-log-out'></i> Log out</button></form>
                            </div>
                        </section>
                    </div>
                </main>

                <aside id="previewPane" class="preview-pane hidden lg:flex"<?= $page ? '' : ' style="display:none"' ?>>
                    <div class="preview-stage" id="previewStage">
                        <div class="preview-glow" id="previewGlow"></div>
                        <div class="phone-wrap" id="phoneWrap">
                            <div class="phone" id="phone">
                                <div class="phone-island"></div>
                                <div class="phone-screen">
                                    <iframe class="pv-frame on" title="Preview" id="pvA"></iframe>
                                    <iframe class="pv-frame" title="Preview" id="pvB"></iframe>
                                    <iframe class="pv-code" title="Preview of your code page" id="pvCode" sandbox="allow-scripts allow-forms allow-popups allow-modals"></iframe>
                                    <div class="pv-loading" id="pvLoading"><i class='bx bx-loader-alt bx-spin'></i></div>
                                </div>
                            </div>
                        </div>
                        <div class="preview-dots" id="previewDots"></div>
                    </div>
                    <div class="preview-bar">
                        <span class="pv-live"><span></span> <span id="pvLiveLabel">Live preview</span></span>
                        <div class="flex items-center gap-1">
                            <button type="button" class="pv-btn" id="pvEntrance" title="Play entrance in preview" hidden><i class='bx bx-play-circle'></i></button>
                            <button type="button" class="pv-btn" id="pvReload" title="Reload"><i class='bx bx-refresh'></i></button>
                            <button type="button" class="pv-btn" id="pvBig" title="Large view (desktop)"><i class='bx bx-desktop'></i></button>
                            <a class="pv-btn" id="pvOpen" href="#" target="_blank" rel="noopener" title="Open page"><i class='bx bx-link-external'></i></a>
                        </div>
                    </div>
                </aside>
            </div>
        </div>
    </div>

    <button type="button" id="mobilePreviewBtn" class="mobile-preview-btn lg:hidden"><i class='bx bx-mobile-alt'></i> Preview</button>
    <div id="mobilePreview" class="mobile-preview hidden">
        <button type="button" class="mobile-preview-close" id="mobilePreviewClose"><i class='bx bx-x'></i></button>
        <div class="mobile-preview-holder" id="mobilePreviewHolder"></div>
    </div>

    <div id="bigPreview" class="big-preview hidden">
        <div class="big-preview-box">
            <div class="big-preview-bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="big-preview-url" id="bigPreviewUrl"></span><button type="button" id="bigPreviewClose"><i class='bx bx-x'></i></button></div>
            <iframe id="bigPreviewFrame" title="Large view"></iframe>
        </div>
    </div>

    <div id="modal" class="modal hidden"><div class="modal-box" id="modalBox"></div></div>
    <div id="toasts" class="toasts"></div>

    <script>window.OYS_EDITOR = <?= json_encode($editorData, JSON_HEX_TAG | JSON_HEX_AMP | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) ?>;</script>
    <?php if ($flashSuccess || $flashError): ?>
    <script>window.OYS_FLASH = <?= json_encode(['success' => $flashSuccess, 'error' => $flashError], JSON_HEX_TAG | JSON_UNESCAPED_UNICODE) ?>;</script>
    <?php endif; ?>
    <script src="<?= e(oys_asset('/static/js/share.js')) ?>"></script>
    <script src="<?= e(oys_asset('/static/js/editor.js')) ?>"></script>
</body>
</html>
