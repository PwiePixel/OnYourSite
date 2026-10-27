<?php
/** @var ?array $user_data */
require_once dirname(__DIR__) . '/lib/demo.php';
$base = oys_base_authority();
$loggedIn = !empty($user_data);
$heroThemes = ['trs', 'galaxy', 'notebook', 'comic'];
$features = [
    ['bx-link', 'Links & Social-Icons', 'Beliebig viele Links mit passendem Symbol, dazu Icons für Instagram, TikTok, YouTube, Twitch, Discord und 22 weitere.', '#818cf8'],
    ['bx-play-circle', 'Videos, Musik & Bilder', 'YouTube, Twitch und Spotify direkt auf der Seite, dazu Bilder, Überschriften und Text.', '#ef4444'],
    ['bx-palette', '25 Designs', 'TRS-Design als Standard, dazu Glas, Brutal, Candy, Zen, Code, Café und mehr – und besondere Vorlagen wie Galaxie, Notizbuch, Comic, Ozean oder Mitternacht.', '#ff7a1a'],
    ['bx-mobile-alt', 'Live-Vorschau', 'Rechts im Editor siehst du sofort, wie deine Seite auf dem Handy aussieht.', '#22c55e'],
    ['bx-bar-chart-alt-2', 'Statistik ohne Cookies', 'Aufrufe und Klicks je Link – ohne Cookies, ohne IP-Adressen, ohne Cookie-Banner für deine Besucher.', '#38bdf8'],
    ['bx-globe', 'Zwei Adressen', $base . '/name oder name.' . $base . ' – du wählst, die andere leitet weiter.', '#a78bfa'],
    ['bx-time-five', 'Zeitsteuerung', '„Jetzt live“ nur freitags 18–23 Uhr? Links erscheinen und verschwinden automatisch.', '#f59e0b'],
    ['bx-grid-alt', '13 Anordnungen', 'Knöpfe, breite Karten, Kacheln, App-Raster, Zeitstrahl, Wolke, zwei Spalten – oder Baum, Bento, Karussell, Polaroid, Magazin und Stapel.', '#14b8a6'],
    ['bx-star', 'Effekte', 'Animierter Ring ums Profilbild, Glanz oder Wackeln für einzelne Links, Schnee, Konfetti oder Glühwürmchen über der Seite und Funken hinter dem Mauszeiger.', '#facc15'],
    ['bx-lock-alt', 'Geschützte Links', 'Einzelne Links nur mit Passwort oder erst nach „Ab 18“-Bestätigung.', '#f87171'],
    ['bx-copy', 'Bis zu 3 Seiten', 'Eine Seite für dich, eine fürs Projekt – mit eigener Adresse und Statistik, umschaltbar im Editor.', '#818cf8'],
    ['bx-envelope', 'Wochenbericht', 'Auf Wunsch jeden Montag eine kurze Mail mit Aufrufen, Klicks und deinem besten Link.', '#60a5fa'],
    ['bx-music', 'Eingang mit Musik', 'Besucher tippen zum Betreten, die Seite öffnet sich mit Animation und deine Musik startet.', '#ec4899'],
    ['bx-timer', 'Countdown & Galerie', 'Zähl bis zum nächsten Release herunter oder zeig mehrere Bilder zum Wischen.', '#fb923c'],
    ['bx-message-square-dots', 'Kontaktformular', 'Besucher schreiben dir direkt – mit Schutzfilter gegen Spam und Hinweis über die Glocke.', '#34d399'],
];
$themes = oys_themes();
?>
<!DOCTYPE html>
<html lang="de" class="scroll-smooth">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">

    <title>OnYourSite | Deine Link-in-Bio-Seite mit 25 Designs</title>
    <meta name="description" content="Deine eigene Link-in-Bio-Seite unter name.<?= e($base) ?>: 25 Designs, 13 Anordnungen, Live-Vorschau, Statistik ohne Cookies, Zeitsteuerung, geschützte Links, Kontaktformular und mehr – kostenlos.">
    <meta name="keywords" content="link in bio, linktree alternative, eigene seite, social links, creator seite, statistik ohne cookies">
    <meta name="author" content="OnYourSite">

    <meta property="og:type" content="website">
    <meta property="og:url" content="<?= e(oys_main_url('/')) ?>">
    <meta property="og:title" content="OnYourSite | Deine Link-in-Bio-Seite mit 25 Designs">
    <meta property="og:description" content="Links, Videos, Musik, Countdown und Kontaktformular auf einer Seite – mit Live-Vorschau und Statistik ohne Cookies.">
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
        .hero-dots { display: flex; gap: 7px; justify-content: center; margin-top: 18px; position: relative; }
        .hero-dots button { width: 8px; height: 8px; border-radius: 99px; background: #3f3f46; transition: all .3s; }
        .hero-dots button.on { width: 26px; background: var(--dot, #ff7a1a); }
        .hero-caption { margin-top: 10px; font-size: 13px; color: #a1a1aa; position: relative; min-height: 20px; }

        /* Leiste mit allen 25 Designs */
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
                    <a href="#features" class="text-sm font-medium text-gray-400 hover:text-white transition-colors">Funktionen</a>
                    <a href="#designs" class="text-sm font-medium text-gray-400 hover:text-white transition-colors">Designs</a>
                    <a href="#how-it-works" class="text-sm font-medium text-gray-400 hover:text-white transition-colors">So geht's</a>
                    <a href="#faq" class="text-sm font-medium text-gray-400 hover:text-white transition-colors">FAQ</a>
                    <a href="https://discord.on-your.site" target="_blank" rel="noopener" class="text-sm font-medium text-[#5865F2] hover:text-[#4752C4] transition-colors flex items-center gap-1"><i class='bx bxl-discord-alt text-lg'></i> Community</a>
                    <div class="h-5 w-px bg-bordercolor"></div>
                    <?php if ($loggedIn): ?>
                    <a href="/dashboard" class="text-sm font-medium bg-white text-black px-5 py-2.5 rounded-full hover:bg-gray-200 transition-all duration-300 transform hover:scale-105 shadow-[0_0_15px_rgba(255,255,255,0.1)]">Zum Editor</a>
                    <?php else: ?>
                    <a href="/login" class="text-sm font-medium text-white hover:text-brand-400 transition-colors">Anmelden</a>
                    <a href="/register" class="text-sm font-medium bg-white text-black px-5 py-2.5 rounded-full hover:bg-gray-200 transition-all duration-300 transform hover:scale-105 shadow-[0_0_15px_rgba(255,255,255,0.1)]">
                        Kostenlos starten
                    </a>
                    <?php endif; ?>
                </div>
                <a href="<?= $loggedIn ? '/dashboard' : '/register' ?>" class="md:hidden text-sm font-medium bg-white text-black px-4 py-2 rounded-full"><?= $loggedIn ? 'Editor' : 'Starten' ?></a>
            </div>
        </div>
    </nav>

    <main class="relative pt-28 pb-16 lg:pt-36 lg:pb-24 overflow-hidden">
        <div class="absolute top-1/2 left-1/3 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-brand-500/15 rounded-full blur-[120px] -z-10 pointer-events-none"></div>
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 grid lg:grid-cols-2 gap-14 items-center relative z-10">
            <div class="text-center lg:text-left">
                <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-bordercolor bg-white/5 backdrop-blur-sm text-xs font-medium text-gray-300 mb-8 animate-fade-in">
                    <span class="flex h-2 w-2 rounded-full bg-brand-500 animate-pulse"></span>
                    Neu: 25 Designs, 13 Anordnungen & Live-Vorschau
                </div>
                <h1 class="text-5xl md:text-6xl xl:text-7xl font-extrabold text-white tracking-tight mb-6 drop-shadow-lg">
                    Alles von dir auf<br class="hidden md:block">
                    <span class="bg-clip-text text-transparent bg-gradient-to-r from-brand-400 to-purple-500">einer Seite.</span>
                </h1>
                <p class="mt-4 max-w-xl mx-auto lg:mx-0 text-lg md:text-xl text-gray-400 mb-10 leading-relaxed">
                    Links, Social-Icons, Videos, Musik, Countdown und Kontaktformular – in 25 Designs, mit Live-Vorschau und Statistik ohne Cookies. Unter deiner eigenen Adresse:
                    <span class="text-white font-medium bg-white/10 px-2 py-0.5 rounded whitespace-nowrap">name.<?= e($base) ?></span>
                </p>
                <div class="flex flex-col sm:flex-row justify-center lg:justify-start gap-4">
                    <a href="<?= $loggedIn ? '/dashboard' : '/register' ?>" class="inline-flex justify-center items-center gap-2 bg-brand-500 hover:bg-brand-600 text-white px-8 py-3.5 rounded-full font-semibold transition-all duration-300 shadow-[0_0_30px_rgba(99,102,241,0.3)] hover:shadow-[0_0_40px_rgba(99,102,241,0.5)] transform hover:-translate-y-1">
                        <?= $loggedIn ? 'Zum Editor' : 'Adresse sichern' ?> <i class='bx bx-rocket text-xl'></i>
                    </a>
                    <a href="#features" class="inline-flex justify-center items-center gap-2 bg-card border border-bordercolor hover:border-brand-500/50 text-white px-8 py-3.5 rounded-full font-medium transition-all duration-300">
                        Alle Funktionen
                    </a>
                </div>
                <div class="mt-10 flex flex-wrap justify-center lg:justify-start gap-x-6 gap-y-2 text-sm text-gray-500">
                    <span class="flex items-center gap-1.5"><i class='bx bx-check-circle text-emerald-400'></i> Kostenlos</span>
                    <span class="flex items-center gap-1.5"><i class='bx bx-check-circle text-emerald-400'></i> Ohne Cookie-Banner</span>
                    <span class="flex items-center gap-1.5"><i class='bx bx-check-circle text-emerald-400'></i> SSL inklusive</span>
                </div>
            </div>

            <div class="hero-stage" id="heroStage">
                <div class="hero-glow"></div>
                <div class="hero-phone-wrap">
                    <div class="hero-phone">
                        <div class="hero-island"></div>
                        <div class="hero-screen" id="heroScreen">
                            <?php foreach ($heroThemes as $i => $t): ?>
                                <iframe title="Beispielseite im Design <?= e($themes[$t]['name']) ?>" src="/_/demo/<?= e($t) ?>" data-theme="<?= e($t) ?>" class="<?= $i === 0 ? 'on' : '' ?>" <?= $i === 0 ? '' : 'loading="lazy"' ?>></iframe>
                            <?php endforeach; ?>
                        </div>
                    </div>
                </div>
                <div class="hero-dots" id="heroDots">
                    <?php foreach ($heroThemes as $i => $t): ?>
                        <button type="button" class="<?= $i === 0 ? 'on' : '' ?>" data-i="<?= $i ?>" aria-label="Design <?= e($themes[$t]['name']) ?>"></button>
                    <?php endforeach; ?>
                </div>
                <div class="hero-caption" id="heroCaption">Design: <b class="text-white"><?= e($themes[$heroThemes[0]]['name']) ?></b></div>
            </div>
        </div>
    </main>

    <section id="features" class="py-24 border-t border-bordercolor bg-background relative">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div class="text-center max-w-3xl mx-auto mb-16">
                <h2 class="text-3xl md:text-5xl font-bold text-white mb-4">Alles, was du brauchst.</h2>
                <p class="text-lg text-gray-400">Keine komplizierten Baukästen. Du füllst Blöcke aus – und siehst rechts sofort das Ergebnis.</p>
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
                <span class="px-4 py-2 rounded-full bg-card border border-bordercolor text-gray-400"><i class='bx bx-lock-alt text-blue-400'></i> Kostenloses SSL</span>
                <span class="px-4 py-2 rounded-full bg-card border border-bordercolor text-gray-400"><i class='bx bx-calendar-check text-purple-400'></i> Eingebauter Terminkalender</span>
                <span class="px-4 py-2 rounded-full bg-card border border-bordercolor text-gray-400"><i class='bx bx-code-block text-yellow-400'></i> Eigenes CSS & SEO</span>
                <span class="px-4 py-2 rounded-full bg-card border border-bordercolor text-gray-400"><i class='bx bxl-discord-alt text-[#5865F2]'></i> Discord-Rolle</span>
            </div>
        </div>
    </section>

    <section id="designs" class="py-24 border-t border-bordercolor bg-[#0a0a0c] relative overflow-hidden">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
            <div class="text-center max-w-3xl mx-auto mb-12">
                <h2 class="text-3xl md:text-5xl font-bold text-white mb-4">25 Designs. Ein Klick.</h2>
                <p class="text-lg text-gray-400">Tippe auf ein Design – oben im Handy siehst du es sofort in Aktion.</p>
            </div>
            <div class="theme-strip" id="themeStrip">
                <?php foreach ($themes as $key => $t): ?>
                <button type="button" class="theme-tile" data-theme="<?= e($key) ?>">
                    <div class="mini-frame"><?= oys_mini_html($key) ?></div>
                    <div class="mt-3 px-1 flex items-center justify-between gap-2">
                        <span><b class="text-white text-sm"><?= e($t['name']) ?></b><?php if ($key === 'trs'): ?> <span class="text-[10px] font-bold uppercase tracking-wide text-[#ff7a1a]">Standard</span><?php elseif ($t['group'] === 'special'): ?> <span class="text-[10px] font-bold uppercase tracking-wide text-brand-400">Vorlage</span><?php endif; ?>
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
                <h2 class="text-3xl md:text-5xl font-bold text-white mb-4">So geht's</h2>
                <p class="text-lg text-gray-400">In drei Schritten zu deiner eigenen Seite.</p>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-3 gap-12 text-center relative">
                <div class="hidden md:block absolute top-10 left-[20%] right-[20%] h-0.5 bg-gradient-to-r from-transparent via-brand-500/50 to-transparent -z-10"></div>
                <div>
                    <div class="w-20 h-20 mx-auto bg-card border border-bordercolor rounded-full flex items-center justify-center text-2xl font-bold text-brand-400 mb-6 shadow-[0_0_20px_rgba(99,102,241,0.2)]">1</div>
                    <h4 class="text-xl font-bold text-white mb-2">Adresse sichern</h4>
                    <p class="text-gray-400 text-sm leading-relaxed px-4">Wähle deinen Namen: <em>name.<?= e($base) ?></em> oder <em><?= e($base) ?>/name</em>.</p>
                </div>
                <div>
                    <div class="w-20 h-20 mx-auto bg-card border border-bordercolor rounded-full flex items-center justify-center text-2xl font-bold text-brand-400 mb-6 shadow-[0_0_20px_rgba(99,102,241,0.2)]">2</div>
                    <h4 class="text-xl font-bold text-white mb-2">Blöcke hinzufügen</h4>
                    <p class="text-gray-400 text-sm leading-relaxed px-4">Links einfügen, Social-Icons, Videos, Countdown oder Kontaktformular – die Vorschau zeigt alles live.</p>
                </div>
                <div>
                    <div class="w-20 h-20 mx-auto bg-brand-500 border border-brand-400 rounded-full flex items-center justify-center text-2xl font-bold text-white mb-6 shadow-[0_0_30px_rgba(99,102,241,0.5)]">3</div>
                    <h4 class="text-xl font-bold text-white mb-2">Design wählen & teilen</h4>
                    <p class="text-gray-400 text-sm leading-relaxed px-4">Eins von 25 Designs und 13 Anordnungen aussuchen, speichern, Link in deine Bio – fertig.</p>
                </div>
            </div>
        </div>
    </section>

    <section id="faq" class="py-24 border-t border-bordercolor bg-[#0a0a0c]">
        <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
            <div class="text-center mb-16">
                <h2 class="text-3xl md:text-4xl font-bold text-white mb-4">Häufige Fragen</h2>
                <p class="text-gray-400">Alles Wichtige zu OnYourSite.</p>
            </div>

            <div class="space-y-6">
                <div class="bg-card border border-bordercolor p-6 rounded-2xl">
                    <h3 class="text-lg font-bold text-white mb-2">Ist OnYourSite wirklich kostenlos?</h3>
                    <p class="text-gray-400 text-sm leading-relaxed">Ja! Adresse, Seite, alle 25 Designs und die Statistik sind kostenlos. Wir betreiben OnYourSite als Community-Projekt.</p>
                </div>
                <div class="bg-card border border-bordercolor p-6 rounded-2xl">
                    <h3 class="text-lg font-bold text-white mb-2">Brauchen meine Besucher einen Cookie-Banner?</h3>
                    <p class="text-gray-400 text-sm leading-relaxed">Nein. Deine Seite setzt keine Cookies und speichert keine IP-Adressen – gezählt werden nur Aufrufe und Klicks pro Tag. Videos von YouTube, Twitch oder Spotify laden erst, wenn jemand darauf tippt.</p>
                </div>
                <div class="bg-card border border-bordercolor p-6 rounded-2xl">
                    <h3 class="text-lg font-bold text-white mb-2">Kann ich Design und Anordnung später ändern?</h3>
                    <p class="text-gray-400 text-sm leading-relaxed">Jederzeit. Fahr im Editor mit der Maus über ein Design und du siehst es sofort in der Handy-Vorschau – erst beim Speichern wird es live.</p>
                </div>
                <div class="bg-card border border-bordercolor p-6 rounded-2xl">
                    <h3 class="text-lg font-bold text-white mb-2">Kann ich meine Adresse ändern?</h3>
                    <p class="text-gray-400 text-sm leading-relaxed">Ja, alle 30 Tage. Ob <em>name.<?= e($base) ?></em> oder <em><?= e($base) ?>/name</em> die Hauptadresse ist, kannst du jederzeit umstellen – die andere leitet automatisch weiter.</p>
                </div>
                <div class="bg-card border border-bordercolor p-6 rounded-2xl">
                    <h3 class="text-lg font-bold text-white mb-2">Muss ich programmieren können?</h3>
                    <p class="text-gray-400 text-sm leading-relaxed">Überhaupt nicht. Wer mag, kann trotzdem eigenes CSS einfügen und SEO-Angaben selbst festlegen.</p>
                </div>
            </div>
        </div>
    </section>

    <section class="py-24 border-t border-bordercolor bg-background relative overflow-hidden">
        <div class="absolute inset-0 bg-brand-500/5"></div>
        <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center relative z-10">
            <h2 class="text-3xl md:text-5xl font-extrabold text-white mb-6">Bereit für deine Seite?</h2>
            <p class="text-lg text-gray-400 mb-10">Registrieren, Adresse wählen, loslegen. Dauert keine Minute.</p>
            <a href="<?= $loggedIn ? '/dashboard' : '/register' ?>" class="inline-flex justify-center items-center gap-2 bg-white text-black hover:bg-gray-200 px-10 py-4 rounded-full font-bold transition-all duration-300 transform hover:scale-105 shadow-xl text-lg">
                <?= $loggedIn ? 'Zum Editor' : 'Seite erstellen' ?> <i class='bx bx-right-arrow-alt text-2xl'></i>
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

            <div class="flex items-center gap-4 mb-6 text-sm text-gray-500 font-medium">
                <a href="/imprint" class="hover:text-white transition-colors">Impressum</a>
                <span>&bull;</span>
                <a href="/privacy" class="hover:text-white transition-colors">Datenschutz</a>
                <span>&bull;</span>
                <a href="/terms" class="hover:text-white transition-colors">Nutzungsbedingungen</a>
            </div>

            <p class="text-gray-500 text-sm">
                &copy; <?php echo date("Y"); ?> OnYourSite. Mit <i class='bx bxs-heart text-red-500 mx-1'></i> für die Community gemacht.
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
            caption.innerHTML = 'Design: <b class="text-white">' + (t.name || key) + '</b>';
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
                if (!custom) { custom = document.createElement('iframe'); custom.title = 'Beispielseite'; screen.appendChild(custom); }
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
