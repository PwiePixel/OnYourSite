<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Create Account | On Your Site</title>
	<link rel="icon" type="image/png" href="/static/images/favicon.png">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <link href='https://unpkg.com/boxicons@2.1.4/css/boxicons.min.css' rel='stylesheet'>
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
</head>
<body class="bg-background text-gray-300 font-sans min-h-screen flex flex-col items-center justify-center relative overflow-hidden selection:bg-brand-500/30">

    <div class="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[800px] bg-brand-500/10 rounded-full blur-[120px] -z-10 pointer-events-none"></div>

    <a href="/" class="absolute top-8 left-8 text-gray-500 hover:text-white flex items-center gap-2 transition-colors text-sm font-medium">
        <i class='bx bx-left-arrow-alt text-xl'></i> Back to Home
    </a>

    <div class="w-full max-w-md p-8 md:p-10 bg-card rounded-2xl border border-bordercolor shadow-2xl relative z-10 mx-4">
        
        <div class="flex justify-center mb-6">
            <div class="w-12 h-12 rounded-lg bg-gradient-to-br from-brand-500 to-purple-600 flex items-center justify-center shadow-lg shadow-brand-500/20">
                <i class='bx bx-hive text-2xl text-white'></i>
            </div>
        </div>
        
        <h2 class="text-2xl font-bold text-white text-center mb-2 tracking-tight">Create your account</h2>
        <p class="text-gray-400 text-center mb-8 text-sm">Claim your domain and start building.</p>

        <?php if(isset($_SESSION['error'])): ?>
            <div class="mb-6 bg-red-500/10 border border-red-500/20 text-red-400 p-3 rounded-lg flex items-center gap-2 text-sm font-medium animate-pulse">
                <i class='bx bx-error-circle text-lg'></i> <?php echo $_SESSION['error']; unset($_SESSION['error']); ?>
            </div>
        <?php endif; ?>
        
        <form action="/register" method="POST" class="space-y-5">
            
            <div>
                <label class="block text-sm font-medium text-gray-300 mb-1.5">Claim your Domain</label>
                <div class="flex shadow-sm rounded-lg overflow-hidden focus-within:ring-1 focus-within:ring-brand-500 transition-all border border-bordercolor">
                    <input type="text" name="subdomain" required placeholder="e.g. max" class="w-full bg-inputbg px-4 py-2.5 text-white focus:outline-none text-sm">
                    <span class="inline-flex items-center px-3 bg-card border-l border-bordercolor text-gray-500 text-xs font-medium">.on-your.site</span>
                </div>
            </div>

            <div>
                <label class="block text-sm font-medium text-gray-300 mb-1.5">Full Name</label>
                <input type="text" name="fullname" required placeholder="Max Mustermann" class="w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 transition-all text-sm">
            </div>

            <div>
                <label class="block text-sm font-medium text-gray-300 mb-1.5">Email Address</label>
                <input type="email" name="email" required placeholder="max@example.com" class="w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 transition-all text-sm">
            </div>
            
            <div>
                <label class="block text-sm font-medium text-gray-300 mb-1.5">Password</label>
                <input type="password" name="password" required placeholder="••••••••" class="w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 transition-all text-sm">
            </div>
            
            <button type="submit" name="action" value="register" class="w-full bg-white text-black hover:bg-gray-200 font-bold py-2.5 rounded-lg transition-all duration-300 mt-2 shadow-sm text-sm">
                Sign Up
            </button>
        </form>

        <p class="text-center text-gray-500 mt-8 text-sm">
            Already have an account? <a href="/login" class="text-white hover:text-brand-400 font-medium transition-colors">Sign in</a>
        </p>
    </div>

</body>
</html>