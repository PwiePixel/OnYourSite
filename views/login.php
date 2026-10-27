<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Login | On Your Site</title>
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
        <i class='bx bx-left-arrow-alt text-2xl'></i> Back to Home
    </a>

    <div class="w-full max-w-md p-8 md:p-10 bg-card rounded-3xl border border-bordercolor shadow-2xl relative z-10 mx-4">
        <div class="flex justify-center mb-8">
            <i class='bx bx-hive text-5xl text-white'></i>
        </div>
        
        <h2 class="text-3xl font-bold text-white text-center mb-2">Welcome back</h2>
        <p class="text-gray-400 text-center mb-8">Enter your details to access your dashboard.</p>
        
        <form action="/login" method="POST" class="space-y-5">
            <div>
                <label class="block text-sm font-medium text-gray-300 mb-2">Email Address</label>
                <input type="email" name="email" required placeholder="max@example.com" class="w-full bg-[#09090b] border border-bordercolor rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-gray-400 transition-all">
            </div>
            
            <div>
                <div class="flex justify-between items-center mb-2">
                    <label class="block text-sm font-medium text-gray-300">Password</label>
                    <a href="#" class="text-xs text-brand-400 hover:text-brand-300 transition-colors">Forgot password?</a>
                </div>
                <input type="password" name="password" required placeholder="••••••••" class="w-full bg-[#09090b] border border-bordercolor rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-gray-400 transition-all">
            </div>
            
            <button type="submit" name="action" value="login" class="w-full bg-white text-black hover:bg-gray-200 font-bold py-3.5 rounded-xl transition-all duration-300 mt-4">
                Sign In
            </button>
        </form>

        <p class="text-center text-gray-500 mt-8 text-sm">
            Don't have an account yet? <a href="/register" class="text-white hover:text-gray-300 font-medium transition-colors">Sign up</a>
        </p>
    </div>

</body>
</html>