<?php
$flashError = $_SESSION['error'] ?? null;
$flashSuccess = $_SESSION['success'] ?? null;
unset($_SESSION['error'], $_SESSION['success']);
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Log in | OnYourSite</title>
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
                        background: '#09090b', card: '#18181b', bordercolor: 'rgba(255, 255, 255, 0.08)',
                        brand: { 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5', }
                    }
                }
            }
        }
    </script>
</head>
<body class="bg-background text-gray-300 font-sans min-h-screen flex flex-col items-center justify-center relative overflow-hidden selection:bg-brand-500/30">

    <div class="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[600px] bg-white/5 rounded-full blur-[100px] -z-10 pointer-events-none"></div>

    <a href="/" class="absolute top-8 left-8 text-gray-500 hover:text-white flex items-center gap-2 transition-colors">
        <i class='bx bx-left-arrow-alt text-2xl'></i> Back to home
    </a>

    <div class="w-full max-w-md p-8 md:p-10 bg-card rounded-3xl border border-bordercolor shadow-2xl relative z-10 mx-4">
        <div class="flex justify-center mb-8">
            <i class='bx bx-hive text-5xl text-white'></i>
        </div>

        <h2 class="text-3xl font-bold text-white text-center mb-2">Welcome back</h2>
        <p class="text-gray-400 text-center mb-8">Log in to edit your page.</p>

        <?php if ($flashError): ?>
            <div class="mb-6 bg-red-500/10 border border-red-500/20 text-red-400 p-3 rounded-lg flex items-center gap-2 text-sm font-medium">
                <i class='bx bx-error-circle text-lg'></i> <?= e($flashError) ?>
            </div>
        <?php endif; ?>
        <?php if ($flashSuccess): ?>
            <div class="mb-6 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 p-3 rounded-lg flex items-center gap-2 text-sm font-medium">
                <i class='bx bx-check-circle text-lg'></i> <?= e($flashSuccess) ?>
            </div>
        <?php endif; ?>

        <form action="/login" method="POST" class="space-y-5">
            <?= oys_csrf_field() ?>
            <div>
                <label class="block text-sm font-medium text-gray-300 mb-2">Email address</label>
                <input type="email" name="email" required autocomplete="email" placeholder="max@example.com" class="w-full bg-[#09090b] border border-bordercolor rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-gray-400 transition-all">
            </div>

            <div>
                <label class="block text-sm font-medium text-gray-300 mb-2">Password</label>
                <input type="password" name="password" required autocomplete="current-password" placeholder="••••••••" class="w-full bg-[#09090b] border border-bordercolor rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-gray-400 transition-all">
            </div>

            <button type="submit" class="w-full bg-white text-black hover:bg-gray-200 font-bold py-3.5 rounded-xl transition-all duration-300 mt-4">
                Log in
            </button>
        </form>

        <p class="text-center text-gray-500 mt-8 text-sm">
            Don’t have an account? <a href="/register" class="text-white hover:text-gray-300 font-medium transition-colors">Sign up now</a>
        </p>
    </div>

</body>
</html>
