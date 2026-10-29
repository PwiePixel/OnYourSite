<?php
$flashError = $_SESSION['error'] ?? null;
unset($_SESSION['error']);
$old = $_SESSION['old'] ?? [];
if (empty($old['subdomain']) && isset($_GET['name'])) {
    $old['subdomain'] = oys_normalize_slug($_GET['name']);
}
unset($_SESSION['old']);
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <!-- Die Seite ist schon dunkel: kein Nachtmodus des Browsers darüber (z. B. Brave, Dark Reader) -->
    <meta name="color-scheme" content="dark">
    <meta name="darkreader-lock">
    <title>Create account | OnYourSite</title>
	<link rel="icon" type="image/png" href="/static/images/favicon.png">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="<?= e(oys_asset('/static/vendor/boxicons/css/boxicons.min.css')) ?>">
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = {
            theme: {
                extend: {
                    fontFamily: { sans: ['Inter', 'sans-serif'], },
                    colors: {
                        background: '#000000', card: '#0a0a0a', inputbg: '#121212', bordercolor: '#27272a',
                        brand: { 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5', }
                    }
                }
            }
        }
    </script>
    <style>
        /* iOS zoomt bei Eingaben unter 16px ungefragt in die Seite */
        @media (max-width: 639px) { input:not([type=checkbox]):not([type=radio]), select, textarea { font-size: 16px !important; } }
    </style>
</head>
<body class="bg-background text-gray-300 font-sans min-h-screen flex flex-col items-center justify-center relative overflow-x-hidden selection:bg-brand-500/30 py-16">

    <div class="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[800px] bg-brand-500/10 rounded-full blur-[120px] -z-10 pointer-events-none"></div>

    <a href="/" class="absolute top-6 left-6 py-2 text-gray-500 hover:text-white flex items-center gap-2 transition-colors text-sm font-medium">
        <i class='bx bx-left-arrow-alt text-xl'></i> Back to home
    </a>

    <div class="w-full max-w-md p-8 md:p-10 bg-card rounded-2xl border border-bordercolor shadow-2xl relative z-10 mx-4">

        <div class="flex justify-center mb-6">
            <div class="w-12 h-12 rounded-lg bg-gradient-to-br from-brand-500 to-purple-600 flex items-center justify-center shadow-lg shadow-brand-500/20">
                <i class='bx bx-hive text-2xl text-white'></i>
            </div>
        </div>

        <h2 class="text-2xl font-bold text-white text-center mb-2 tracking-tight">Create your account</h2>
        <p class="text-gray-400 text-center mb-8 text-sm">Claim your address and get started – for free.</p>

        <?php if ($flashError): ?>
            <div class="mb-6 bg-red-500/10 border border-red-500/20 text-red-400 p-3 rounded-lg flex items-center gap-2 text-sm font-medium">
                <i class='bx bx-error-circle text-lg'></i> <?= e($flashError) ?>
            </div>
        <?php endif; ?>

        <form action="/register" method="POST" class="space-y-5">
            <?= oys_csrf_field() ?>
            <div>
                <label class="block text-sm font-medium text-gray-300 mb-1.5">Your address</label>
                <div class="flex shadow-sm rounded-lg overflow-hidden focus-within:ring-1 focus-within:ring-brand-500 transition-all border border-bordercolor">
                    <input type="text" name="subdomain" id="regSlug" required maxlength="30" value="<?= e($old['subdomain'] ?? '') ?>" placeholder="e.g. max" autocomplete="off" class="w-full bg-inputbg px-4 py-2.5 text-white focus:outline-none text-sm">
                    <span class="inline-flex items-center px-3 bg-card border-l border-bordercolor text-gray-500 text-xs font-medium">.<?= e(oys_base_authority()) ?></span>
                </div>
                <p class="text-[11px] text-gray-500 mt-1.5">Also available at <span class="text-gray-400"><?= e(oys_base_authority()) ?>/<span id="regSlugEcho"><?= e(($old['subdomain'] ?? '') ?: 'max') ?></span></span> – later you choose which one is your primary address.</p>
            </div>

            <div>
                <label class="block text-sm font-medium text-gray-300 mb-1.5">Name</label>
                <input type="text" name="fullname" required maxlength="120" value="<?= e($old['fullname'] ?? '') ?>" placeholder="Max Smith" autocomplete="name" class="w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 transition-all text-sm">
            </div>

            <div>
                <label class="block text-sm font-medium text-gray-300 mb-1.5">Email address</label>
                <input type="email" name="email" required value="<?= e($old['email'] ?? '') ?>" placeholder="max@example.com" autocomplete="email" class="w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 transition-all text-sm">
            </div>

            <div>
                <label class="block text-sm font-medium text-gray-300 mb-1.5">Password</label>
                <input type="password" name="password" required minlength="8" placeholder="At least 8 characters" autocomplete="new-password" class="w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 transition-all text-sm">
            </div>

            <button type="submit" class="w-full bg-white text-black hover:bg-gray-200 font-bold py-2.5 rounded-lg transition-all duration-300 mt-2 shadow-sm text-sm">
                Sign up for free
            </button>
            <p class="text-[11px] text-gray-500 text-center">By signing up, you accept the <a href="/terms" class="underline hover:text-white">Terms of Service</a> and the <a href="/privacy" class="underline hover:text-white">Privacy Policy</a>.</p>
        </form>

        <p class="text-center text-gray-500 mt-8 text-sm">
            Already have an account? <a href="/login" class="text-white hover:text-brand-400 font-medium transition-colors">Log in</a>
        </p>
    </div>

    <script>
        (function () {
            var input = document.getElementById('regSlug'), echo = document.getElementById('regSlugEcho');
            input.addEventListener('input', function () {
                input.value = input.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
                echo.textContent = input.value || 'max';
            });
        })();
    </script>
</body>
</html>
