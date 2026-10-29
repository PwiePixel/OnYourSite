<?php
/** @var ?array $user_data */
require_once dirname(__DIR__) . '/lib/demo.php';
$base = oys_base_authority();
$loggedIn = !empty($user_data);
$heroThemes = ['holo', 'galaxy', 'sakura', 'blueprint'];
$themeCount = count(oys_themes());
$features = [
    ['bx-link', 'Links & social icons', 'As many links as you like, each with a matching icon, plus icons for Instagram, TikTok, YouTube, Twitch, Discord and 20+ more.', '#818cf8'],
    ['bx-play-circle', 'Videos, music & images', 'YouTube, Twitch and Spotify right on your page, plus images, headings and text.', '#ef4444'],
    ['bx-palette', $themeCount . ' themes', 'Deep Dark, Glass, Brutal, Candy, Zen, Code, Café, Noir, Holo and many more – plus special templates like Galaxy, Notebook, Comic, Ocean, Midnight, Blueprint or Sakura.', '#ff7a1a'],
    ['bx-mobile-alt', 'Live preview', 'On the right side of the editor you instantly see how your page looks on a phone.', '#22c55e'],
    ['bx-bar-chart-alt-2', 'Stats without cookies', 'Views and clicks per link – no cookies, no IP addresses, no cookie banner for your visitors.', '#38bdf8'],
    ['bx-globe', 'Two addresses', $base . '/name or name.' . $base . ' – you choose, the other one redirects.', '#a78bfa'],
    ['bx-time-five', 'Scheduling', '“Live now” only on Fridays from 6 to 11 pm? Links appear and disappear automatically.', '#f59e0b'],
    ['bx-grid-alt', '13 layouts', 'Buttons, wide cards, tiles, app grid, timeline, cloud, two columns – or tree, bento, carousel, polaroid, magazine and stack.', '#14b8a6'],
    ['bx-star', 'Effects', 'An animated ring around your profile picture, shine or wobble for single links, snow, confetti or fireflies across the page and sparks behind the mouse cursor.', '#facc15'],
    ['bx-lock-alt', 'Protected links', 'Single links only with a password or after an “18+” confirmation.', '#f87171'],
    ['bx-copy', 'Up to 3 pages', 'One page for you, one for your project – each with its own address and stats, switchable in the editor.', '#818cf8'],
    ['bx-envelope', 'Weekly report', 'If you like, a short email every Monday with views, clicks and your best link.', '#60a5fa'],
    ['bx-music', 'Entrance with music', 'Visitors tap to enter, the page opens with an animation and your music starts.', '#ec4899'],
    ['bx-timer', 'Countdown & gallery', 'Count down to your next release or show several images to swipe through.', '#fb923c'],
    ['bx-message-square-dots', 'Contact form', 'Visitors message you directly – with a spam filter and a heads-up via the bell.', '#34d399'],
];
$themes = oys_themes();
?>
<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">

    <title>OnYourSite | Your link-in-bio page with <?= $themeCount ?> themes</title>
    <meta name="description" content="Your own link-in-bio page at name.<?= e($base) ?>: <?= $themeCount ?> themes, 13 layouts, live preview, stats without cookies, scheduling, protected links, contact form and more – for free.">
    <meta name="keywords" content="link in bio, linktree alternative, personal page, social links, creator page, stats without cookies">
    <meta name="author" content="OnYourSite">

    <meta property="og:type" content="website">
    <meta property="og:url" content="<?= e(oys_main_url('/')) ?>">
    <meta property="og:title" content="OnYourSite | Your link-in-bio page with <?= $themeCount ?> themes">
    <meta property="og:description" content="Links, videos, music, countdown and contact form on one page – with live preview and stats without cookies.">
    <meta property="og:image" content="<?= e(oys_main_url('/static/images/favicon.png')) ?>">

    <link rel="icon" type="image/png" href="/static/images/favicon.png">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="<?= e(oys_asset('/static/vendor/boxicons/css/boxicons.min.css')) ?>">
    <link rel="stylesheet" href="<?= e(oys_asset('/static/css/fonts.css')) ?>">
    <link rel="stylesheet" href="<?= e(oys_asset('/static/css/themes.css')) ?>">
    <link rel="stylesheet" href="<?= e(oys_asset('/static/css/page.css')) ?>">
    <script src="https://cdn.tailwindcss.com"></script>

    <script>
        tailwind.config = {
            theme: {
                extend: {
                    fontFamily: { sans: ['Inter', 'sans-serif'], },
                    colors: {
                        background: '#09090b',
                        card: '#18181b',
                        bordercolor: 'rgba(255, 255, 255, 0.08)',
                        brand: { 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5', }
                    }
                }
            }
        }
    </script>
    <link rel="stylesheet" href="/static/css/styles.css">
    <style>
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .animate-fade-in { animation: fadeIn 0.6s ease forwards; }

        /* Handy mit Dynamic Island und Punkten */
        .hero-stage { position: relative; display: flex; flex-direction: column; align-items: center; }
        .hero-glow { position: absolute; left: 50%; top: 46%; width: 560px; height: 640px; transform: translate(-50%, -50%); background: radial-gradient(closest-side, var(--glow, rgba(255, 122, 26, .3)), transparent 72%); filter: blur(10px); pointer-events: none; transition: background .6s; }
        .hero-phone-wrap { position: relative; width: calc(410px * var(--ps)); height: calc(864px * var(--ps)); --ps: .72; }
        @media (max-width: 420px) { .hero-phone-wrap { --ps: .66; } }
        .hero-phone { position: absolute; top: 0; left: 0; width: 410px; height: 864px; border-radius: 62px; padding: 10px; background: linear-gradient(145deg, #2a2a2e, #161618); box-shadow: inset 0 0 0 2px #3a3a3f, 0 0 0 1px #000, 0 40px 80px -20px rgba(0, 0, 0, .9); transform: scale(var(--ps)); transform-origin: top left; }
        .hero-island { position: absolute; top: 22px; left: 50%; width: 118px; height: 34px; margin-left: -59px; border-radius: 20px; background: #000; z-index: 5; }
        .hero-screen { position: relative; width: 390px; height: 844px; border-radius: 52px; overflow: hidden; background: #0b0b0d; }
        .hero-screen iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; opacity: 0; transition: opacity .6s ease; pointer-events: none; }
        .hero-screen iframe.on { opacity: 1; pointer-events: auto; }
        .hero-dots { display: flex; gap: 0; justify-content: center; margin-top: 8px; position: relative; }
        /* große Tippfläche, kleiner sichtbarer Punkt */
        .hero-dots button { position: relative; width: 32px; height: 32px; background: none; transition: width .3s; }
        .hero-dots button::before { content: ''; position: absolute; left: 50%; top: 50%; width: 8px; height: 8px; transform: translate(-50%, -50%); border-radius: 99px; background: #3f3f46; transition: all .3s; }
        .hero-dots button.on { width: 40px; }
        .hero-dots button.on::before { width: 26px; background: var(--dot, #ff7a1a); }
        .hero-caption { margin-top: 10px; font-size: 13px; color: #a1a1aa; position: relative; min-height: 20px; }

        /* Leiste mit allen Designs */
        .theme-strip { display: flex; gap: 18px; overflow-x: auto; scroll-snap-type: x proximity; padding: 8px 4px 24px; scrollbar-width: thin; scrollbar-color: #27272a transparent; }
        .theme-tile { flex: 0 0 168px; scroll-snap-align: start; text-align: left; display: flex; flex-direction: column; justify-content: flex-start; }
        .theme-tile .mini-frame { position: relative; width: 168px; height: 276px; border-radius: 18px; overflow: hidden; border: 1px solid rgba(255, 255, 255, .08); box-shadow: 0 16px 36px -16px rgba(0, 0, 0, .9); transition: transform .25s, border-color .25s; }
        .theme-tile:hover .mini-frame, .theme-tile.on .mini-frame { transform: translateY(-4px); border-color: rgba(129, 140, 248, .7); }
        .oys-mini { position: absolute; top: 0; left: 0; width: 390px; height: 640px; transform-origin: top left; transform: scale(.4308); pointer-events: none; }
        .oys-mini .oys-main { min-height: 0; padding-top: 40px; }
        .oys-mini .oys-link { animation: none; }
        .oys-mini .oys-blocks { margin-top: 20px; }
    </style>
</head>
<body class="bg-background text-gray-300 font-sans antialiased overflow-x-hidden selection:bg-brand-500/30">

    <nav class="fixed w-full z-50 top-0 transition-all duration-300 backdrop-blur-md bg-background/80 border-b border-bordercolor">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div class="flex justify-between items-center h-20">
                <div class="flex-shrink-0 flex items-center gap-2 cursor-pointer transition-transform hover:scale-105" onclick="window.scrollTo(0,0)">
                    <i class='bx bx-hive text-3xl text-brand-500'></i>
                    <span class="font-bold text-xl text-white tracking-tight">OnYourSite</span>
                </div>
                <div class="hidden md:flex items-center space-x-8">
                    <a href="#features" class="text-sm font-medium text-gray-400 hover:text-white transition-colors">Features</a>
                    <a href="#designs" class="text-sm font-medium text-gray-400 hover:text-white transition-colors">Themes</a>
                    <a href="#how-it-works" class="text-sm font-medium text-gray-400 hover:text-white transition-colors">How it works</a>
                    <a href="#faq" class="text-sm font-medium text-gray-400 hover:text-white transition-colors">FAQ</a>
                    <a href="/updates" class="text-sm font-medium text-gray-400 hover:text-white transition-colors">Updates</a>
                    <a href="https://discord.on-your.site" target="_blank" rel="noopener" class="text-sm font-medium text-[#5865F2] hover:text-[#4752C4] transition-colors flex items-center gap-1"><i class='bx bxl-discord-alt text-lg'></i> Community</a>
                    <div class="h-5 w-px bg-bordercolor"></div>
                    <?php if ($loggedIn): ?>
                    <a href="/dashboard" class="text-sm font-medium bg-white text-black px-5 py-2.5 rounded-full hover:bg-gray-200 transition-all duration-300 transform hover:scale-105 shadow-[0_0_15px_rgba(255,255,255,0.1)]">Open editor</a>
                    <?php else: ?>
                    <a href="/login" class="text-sm font-medium text-white hover:text-brand-400 transition-colors">Log in</a>
                    <a href="/register" class="text-sm font-medium bg-white text-black px-5 py-2.5 rounded-full hover:bg-gray-200 transition-all duration-300 transform hover:scale-105 shadow-[0_0_15px_rgba(255,255,255,0.1)]">
                        Start for free
                    </a>
                    <?php endif; ?>
                </div>
                <a href="<?= $loggedIn ? '/dashboard' : '/register' ?>" class="md:hidden text-sm font-medium bg-white text-black px-4 py-2 rounded-full"><?= $loggedIn ? 'Editor' : 'Get started' ?></a>
            </div>
        </div>
    </nav>

    <main class="relative pt-28 pb-16 lg:pt-36 lg:pb-24 overflow-hidden">
        <div class="absolute top-1/2 left-1/3 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-brand-500/15 rounded-full blur-[120px] -z-10 pointer-events-none"></div>
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 grid lg:grid-cols-2 gap-14 items-center relative z-10">
            <div class="text-center lg:text-left">
                <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-bordercolor bg-white/5 backdrop-blur-sm text-xs font-medium text-gray-300 mb-8 animate-fade-in">
                    <span class="flex h-2 w-2 rounded-full bg-brand-500 animate-pulse"></span>
                    New: <?= $themeCount ?> themes, 13 layouts & live preview
                </div>
                <h1 class="text-5xl md:text-6xl xl:text-7xl font-extrabold text-white tracking-tight mb-6 drop-shadow-lg">
                    Everything you do,<br class="hidden md:block">
                    <span class="bg-clip-text text-transparent bg-gradient-to-r from-brand-400 to-purple-500">on one page.</span>
                </h1>
                <p class="mt-4 max-w-xl mx-auto lg:mx-0 text-lg md:text-xl text-gray-400 mb-10 leading-relaxed">
                    Links, social icons, videos, music, countdown and contact form – in <?= $themeCount ?> themes, with live preview and stats without cookies. At your own address:
                    <span class="text-white font-medium bg-white/10 px-2 py-0.5 rounded whitespace-nowrap">name.<?= e($base) ?></span>
                </p>
                <div class="flex flex-col sm:flex-row justify-center lg:justify-start gap-4">
                    <a href="<?= $loggedIn ? '/dashboard' : '/register' ?>" class="inline-flex justify-center items-center gap-2 bg-brand-500 hover:bg-brand-600 text-white px-8 py-3.5 rounded-full font-semibold transition-all duration-300 shadow-[0_0_30px_rgba(99,102,241,0.3)] hover:shadow-[0_0_40px_rgba(99,102,241,0.5)] transform hover:-translate-y-1">
                        <?= $loggedIn ? 'Open editor' : 'Claim your address' ?> <i class='bx bx-rocket text-xl'></i>
                    </a>
                    <a href="#features" class="inline-flex justify-center items-center gap-2 bg-card border border-bordercolor hover:border-brand-500/50 text-white px-8 py-3.5 rounded-full font-medium transition-all duration-300">
                        All features
                    </a>
                </div>
                <div class="mt-10 flex flex-wrap justify-center lg:justify-start gap-x-6 gap-y-2 text-sm text-gray-500">
                    <span class="flex items-center gap-1.5"><i class='bx bx-check-circle text-emerald-400'></i> Free</span>
                    <span class="flex items-center gap-1.5"><i class='bx bx-check-circle text-emerald-400'></i> No cookie banner</span>
                    <span class="flex items-center gap-1.5"><i class='bx bx-check-circle text-emerald-400'></i> SSL included</span>
                </div>
            </div>

            <div class="hero-stage" id="heroStage">
                <div class="hero-glow"></div>
                <div class="hero-phone-wrap">
                    <div class="hero-phone">
                        <div class="hero-island"></div>
                        <div class="hero-screen" id="heroScreen">
                            <?php foreach ($heroThemes as $i => $t): ?>
                                <iframe title="Example page in the <?= e($themes[$t]['name']) ?> theme" src="/_/demo/<?= e($t) ?>" data-theme="<?= e($t) ?>" class="<?= $i === 0 ? 'on' : '' ?>" <?= $i === 0 ? '' : 'loading="lazy"' ?>></iframe>
                            <?php endforeach; ?>
                        </div>
                    </div>
                </div>
                <div class="hero-dots" id="heroDots">
                    <?php foreach ($heroThemes as $i => $t): ?>
                        <button type="button" class="<?= $i === 0 ? 'on' : '' ?>" data-i="<?= $i ?>" aria-label="<?= e($themes[$t]['name']) ?> theme"></button>
                    <?php endforeach; ?>
                </div>
                <div class="hero-caption" id="heroCaption">Theme: <b class="text-white"><?= e($themes[$heroThemes[0]]['name']) ?></b></div>
            </div>
        </div>
    </main>

    <section id="features" class="py-24 border-t border-bordercolor bg-background relative">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div class="text-center max-w-3xl mx-auto mb-16">
                <h2 class="text-3xl md:text-5xl font-bold text-white mb-4">Everything you need.</h2>
                <p class="text-lg text-gray-400">No complicated site builders. You fill in blocks – and instantly see the result on the right.</p>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                <?php foreach ($features as [$icon, $title, $text, $color]): ?>
                <div class="group p-8 rounded-3xl bg-card border border-bordercolor hover:border-brand-500/50 transition-all duration-500 hover:-translate-y-1">
                    <div class="w-14 h-14 rounded-2xl bg-white/5 border border-bordercolor flex items-center justify-center mb-6 transition-all" style="color: <?= e($color) ?>">
                        <i class='bx <?= e($icon) ?> text-3xl'></i>
                    </div>
                    <h3 class="text-xl font-bold text-white mb-3"><?= e($title) ?></h3>
                    <p class="text-gray-400 text-sm leading-relaxed"><?= e($text) ?></p>
                </div>
                <?php endforeach; ?>
            </div>

            <div class="mt-10 flex flex-wrap justify-center gap-3 text-sm">
                <span class="px-4 py-2 rounded-full bg-card border border-bordercolor text-gray-400"><i class='bx bx-lock-alt text-blue-400'></i> Free SSL</span>
                <span class="px-4 py-2 rounded-full bg-card border border-bordercolor text-gray-400"><i class='bx bx-calendar-check text-purple-400'></i> Built-in booking calendar</span>
                <span class="px-4 py-2 rounded-full bg-card border border-bordercolor text-gray-400"><i class='bx bx-code-block text-yellow-400'></i> Custom CSS & SEO</span>
                <span class="px-4 py-2 rounded-full bg-card border border-bordercolor text-gray-400"><i class='bx bxl-discord-alt text-[#5865F2]'></i> Discord role</span>
            </div>
        </div>
    </section>

    <section id="designs" class="py-24 border-t border-bordercolor bg-[#0a0a0c] relative overflow-hidden">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
            <div class="text-center max-w-3xl mx-auto mb-12">
                <h2 class="text-3xl md:text-5xl font-bold text-white mb-4"><?= $themeCount ?> themes. One click.</h2>
                <p class="text-lg text-gray-400">Tap a theme – the phone above shows it in action right away.</p>
            </div>
            <div class="theme-strip" id="themeStrip">
                <?php foreach ($themes as $key => $t): ?>
                <button type="button" class="theme-tile" data-theme="<?= e($key) ?>">
                    <div class="mini-frame"><?= oys_mini_html($key) ?></div>
                    <div class="mt-3 px-1 flex items-center justify-between gap-2">
                        <span><b class="text-white text-sm"><?= e($t['name']) ?></b><?php if ($key === OYS_DEFAULT_THEME): ?> <span class="text-[11px] font-bold uppercase tracking-wide text-[#ff7a1a]">Default</span><?php elseif ($t['group'] === 'special'): ?> <span class="text-[11px] font-bold uppercase tracking-wide text-brand-400">Template</span><?php endif; ?>
                            <small class="block text-xs text-gray-500"><?= e($t['desc']) ?></small></span>
                        <span class="w-3 h-3 rounded-full shrink-0" style="background: <?= e($t['accent']) ?>"></span>
                    </div>
                </button>
                <?php endforeach; ?>
            </div>
        </div>
    </section>

    <section id="how-it-works" class="py-24 border-t border-bordercolor bg-background relative overflow-hidden">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
            <div class="text-center max-w-3xl mx-auto mb-16">
                <h2 class="text-3xl md:text-5xl font-bold text-white mb-4">How it works</h2>
                <p class="text-lg text-gray-400">Your own page in three steps.</p>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-3 gap-12 text-center relative">
                <div class="hidden md:block absolute top-10 left-[20%] right-[20%] h-0.5 bg-gradient-to-r from-transparent via-brand-500/50 to-transparent -z-10"></div>
                <div>
                    <div class="w-20 h-20 mx-auto bg-card border border-bordercolor rounded-full flex items-center justify-center text-2xl font-bold text-brand-400 mb-6 shadow-[0_0_20px_rgba(99,102,241,0.2)]">1</div>
                    <h4 class="text-xl font-bold text-white mb-2">Claim your address</h4>
                    <p class="text-gray-400 text-sm leading-relaxed px-4">Pick your name: <em>name.<?= e($base) ?></em> or <em><?= e($base) ?>/name</em>.</p>
                </div>
                <div>
                    <div class="w-20 h-20 mx-auto bg-card border border-bordercolor rounded-full flex items-center justify-center text-2xl font-bold text-brand-400 mb-6 shadow-[0_0_20px_rgba(99,102,241,0.2)]">2</div>
                    <h4 class="text-xl font-bold text-white mb-2">Add blocks</h4>
                    <p class="text-gray-400 text-sm leading-relaxed px-4">Add links, social icons, videos, a countdown or a contact form – the preview shows everything live.</p>
                </div>
                <div>
                    <div class="w-20 h-20 mx-auto bg-brand-500 border border-brand-400 rounded-full flex items-center justify-center text-2xl font-bold text-white mb-6 shadow-[0_0_30px_rgba(99,102,241,0.5)]">3</div>
                    <h4 class="text-xl font-bold text-white mb-2">Pick a theme & share</h4>
                    <p class="text-gray-400 text-sm leading-relaxed px-4">Pick one of <?= $themeCount ?> themes and 13 layouts, save, put the link in your bio – done.</p>
                </div>
            </div>
        </div>
    </section>

    <section id="faq" class="py-24 border-t border-bordercolor bg-[#0a0a0c]">
        <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
            <div class="text-center mb-16">
                <h2 class="text-3xl md:text-4xl font-bold text-white mb-4">Frequently asked questions</h2>
                <p class="text-gray-400">Everything you need to know about OnYourSite.</p>
            </div>

            <div class="space-y-6">
                <div class="bg-card border border-bordercolor p-6 rounded-2xl">
                    <h3 class="text-lg font-bold text-white mb-2">Is OnYourSite really free?</h3>
                    <p class="text-gray-400 text-sm leading-relaxed">Yes! Your address, your page, all <?= $themeCount ?> themes and the stats are free. We run OnYourSite as a community project.</p>
                </div>
                <div class="bg-card border border-bordercolor p-6 rounded-2xl">
                    <h3 class="text-lg font-bold text-white mb-2">Do I need a cookie banner for my visitors?</h3>
                    <p class="text-gray-400 text-sm leading-relaxed">No. Your page sets no cookies and stores no IP addresses – only views and clicks per day are counted. Videos from YouTube, Twitch or Spotify only load once someone taps them.</p>
                </div>
                <div class="bg-card border border-bordercolor p-6 rounded-2xl">
                    <h3 class="text-lg font-bold text-white mb-2">Can I change the theme and layout later?</h3>
                    <p class="text-gray-400 text-sm leading-relaxed">Anytime. Hover over or tap a theme in the editor and you instantly see it in the phone preview – it only goes live when you save.</p>
                </div>
                <div class="bg-card border border-bordercolor p-6 rounded-2xl">
                    <h3 class="text-lg font-bold text-white mb-2">Can I change my address?</h3>
                    <p class="text-gray-400 text-sm leading-relaxed">Yes, every 30 days. Whether <em>name.<?= e($base) ?></em> or <em><?= e($base) ?>/name</em> is your primary address, you can switch anytime – the other one redirects automatically.</p>
                </div>
                <div class="bg-card border border-bordercolor p-6 rounded-2xl">
                    <h3 class="text-lg font-bold text-white mb-2">Do I need to know how to code?</h3>
                    <p class="text-gray-400 text-sm leading-relaxed">Not at all. If you like, you can still add your own CSS and set your own SEO details.</p>
                </div>
            </div>
        </div>
    </section>

    <section class="py-24 border-t border-bordercolor bg-background relative overflow-hidden">
        <div class="absolute inset-0 bg-brand-500/5"></div>
        <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center relative z-10">
            <h2 class="text-3xl md:text-5xl font-extrabold text-white mb-6">Ready for your page?</h2>
            <p class="text-lg text-gray-400 mb-10">Sign up, pick an address, get started. Takes less than a minute.</p>
            <a href="<?= $loggedIn ? '/dashboard' : '/register' ?>" class="inline-flex justify-center items-center gap-2 bg-white text-black hover:bg-gray-200 px-10 py-4 rounded-full font-bold transition-all duration-300 transform hover:scale-105 shadow-xl text-lg">
                <?= $loggedIn ? 'Open editor' : 'Create your page' ?> <i class='bx bx-right-arrow-alt text-2xl'></i>
            </a>
        </div>
    </section>

    <footer class="border-t border-bordercolor bg-[#050505] py-12">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col items-center">
            <div class="flex space-x-6 mb-8">
                <a href="#" class="w-12 h-12 rounded-full bg-card border border-bordercolor flex items-center justify-center text-gray-400 hover:text-white hover:border-brand-500 hover:shadow-[0_0_15px_rgba(99,102,241,0.3)] transition-all duration-300">
                    <i class='bx bxl-twitter text-2xl'></i>
                </a>
                <a href="https://discord.gg/nNT8NnM6py" target="_blank" rel="noopener noreferrer" class="w-12 h-12 rounded-full bg-card border border-bordercolor flex items-center justify-center text-gray-400 hover:text-[#5865F2] hover:border-[#5865F2] hover:shadow-[0_0_15px_rgba(88,101,242,0.3)] transition-all duration-300">
                    <i class='bx bxl-discord-alt text-2xl'></i>
                </a>
                <a href="#" class="w-12 h-12 rounded-full bg-card border border-bordercolor flex items-center justify-center text-gray-400 hover:text-white hover:border-white transition-all duration-300">
                    <i class='bx bxl-github text-2xl'></i>
                </a>
            </div>

            <div class="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 mb-6 text-sm text-gray-500 font-medium">
                <a href="/updates" class="inline-block py-2 hover:text-white transition-colors">Updates &amp; roadmap</a>
                <span>&bull;</span>
                <a href="/imprint" class="inline-block py-2 hover:text-white transition-colors">Legal notice</a>
                <span>&bull;</span>
                <a href="/privacy" class="inline-block py-2 hover:text-white transition-colors">Privacy</a>
                <span>&bull;</span>
                <a href="/terms" class="inline-block py-2 hover:text-white transition-colors">Terms</a>
                <span>&bull;</span>
                <a href="/terms/code-pages" class="inline-block py-2 hover:text-white transition-colors">Code page terms</a>
            </div>

            <p class="text-gray-500 text-sm">
                &copy; <?php echo date("Y"); ?> OnYourSite. Made with <i class='bx bxs-heart text-red-500 mx-1'></i> for the community.
            </p>
        </div>
    </footer>

    <script>
    (function () {
        var themes = <?= json_encode(array_map(fn($t) => ['name' => $t['name'], 'accent' => $t['accent']], $themes), JSON_UNESCAPED_UNICODE) ?>;
        var stage = document.getElementById('heroStage');
        var screen = document.getElementById('heroScreen');
        var frames = Array.prototype.slice.call(screen.querySelectorAll('iframe'));
        var dots = Array.prototype.slice.call(document.querySelectorAll('#heroDots button'));
        var caption = document.getElementById('heroCaption');
        var index = 0, timer = null, custom = null;

        function hexA(hex, a) {
            var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
            return m ? 'rgba(' + parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16) + ',' + a + ')' : 'rgba(255,122,26,' + a + ')';
        }
        function paint(key) {
            var t = themes[key] || {};
            stage.style.setProperty('--glow', hexA(t.accent || '#ff7a1a', .32));
            stage.style.setProperty('--dot', t.accent || '#ff7a1a');
            caption.innerHTML = 'Theme: <b class="text-white">' + (t.name || key) + '</b>';
        }
        function show(i) {
            index = (i + frames.length) % frames.length;
            if (custom) { custom.classList.remove('on'); }
            frames.forEach(function (f, k) { f.classList.toggle('on', k === index); });
            dots.forEach(function (d, k) { d.classList.toggle('on', k === index); });
            paint(frames[index].dataset.theme);
        }
        function start() { clearInterval(timer); timer = setInterval(function () { show(index + 1); }, 4500); }
        dots.forEach(function (d, k) { d.addEventListener('click', function () { show(k); start(); }); });
        paint(frames[0].dataset.theme);
        if (!window.matchMedia || !window.matchMedia('(prefers-reduced-motion: reduce)').matches) start();

        // Klick auf ein Design in der Leiste zeigt es im Handy
        document.getElementById('themeStrip').addEventListener('click', function (ev) {
            var tile = ev.target.closest('[data-theme]');
            if (!tile) return;
            clearInterval(timer);
            var key = tile.dataset.theme;
            var existing = frames.filter(function (f) { return f.dataset.theme === key; })[0];
            if (existing) { show(frames.indexOf(existing)); }
            else {
                if (!custom) { custom = document.createElement('iframe'); custom.title = 'Example page'; screen.appendChild(custom); }
                custom.dataset.theme = key;
                custom.src = '/_/demo/' + key;
                frames.forEach(function (f) { f.classList.remove('on'); });
                dots.forEach(function (d) { d.classList.remove('on'); });
                custom.classList.add('on');
                paint(key);
            }
            document.querySelectorAll('.theme-tile').forEach(function (t) { t.classList.toggle('on', t === tile); });
            stage.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
    })();
    </script>
</body>
</html>
