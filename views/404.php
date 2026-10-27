<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Domain Available | OnYourSite</title>
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
                        background: '#09090b', 
                        card: '#18181b',
                        bordercolor: 'rgba(255, 255, 255, 0.08)',
                        brand: { 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5', }
                    }
                }
            }
        }
    </script>
</head>
<body class="bg-background text-gray-300 font-sans antialiased overflow-x-hidden selection:bg-brand-500/30 flex flex-col min-h-screen">

    <nav class="fixed w-full z-50 top-0 transition-all duration-300 backdrop-blur-md bg-background/80 border-b border-bordercolor">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div class="flex justify-between items-center h-20">
                <a href="https://on-your.site" class="flex-shrink-0 flex items-center gap-2 cursor-pointer transition-transform hover:scale-105">
                    <i class='bx bx-hive text-3xl text-brand-500'></i>
                    <span class="font-bold text-xl text-white tracking-tight">OnYourSite</span>
                </a>
                <div class="hidden md:flex items-center space-x-8">
                    <a href="https://on-your.site#features" class="text-sm font-medium text-gray-400 hover:text-white transition-colors">Features</a>
                    <a href="https://on-your.site#how-it-works" class="text-sm font-medium text-gray-400 hover:text-white transition-colors">How it works</a>
                    <div class="h-5 w-px bg-bordercolor"></div>
                    <a href="https://on-your.site/login" class="text-sm font-medium text-white hover:text-brand-400 transition-colors">Sign In</a>
                    <a href="https://on-your.site/register" class="text-sm font-medium bg-white text-black px-5 py-2.5 rounded-full hover:bg-gray-200 transition-all duration-300 transform hover:scale-105 shadow-[0_0_15px_rgba(255,255,255,0.1)]">
                        Get Started
                    </a>
                </div>
            </div>
        </div>
    </nav>

    <main class="relative flex-1 flex flex-col items-center justify-center pt-32 pb-20 lg:pt-48 lg:pb-32 overflow-hidden">
        <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-brand-500/20 rounded-full blur-[120px] -z-10 pointer-events-none"></div>
        
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center relative z-10">
            
            <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 backdrop-blur-sm text-xs font-medium text-emerald-400 mb-8">
                <span class="flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse"></span>
                Domain is available
            </div>
            
            <h1 class="text-5xl md:text-7xl font-extrabold text-white tracking-tight mb-6 drop-shadow-lg">
                <span class="bg-clip-text text-transparent bg-gradient-to-r from-brand-400 to-purple-500">
                    <?php echo htmlspecialchars($subdomain); ?>.on-your.site
                </span><br class="md:hidden">
            </h1>
            
            <p class="mt-4 max-w-2xl mx-auto text-lg md:text-xl text-gray-400 mb-10 leading-relaxed">
                This space is currently empty. You can claim this exact web address right now and launch your personal page in seconds.
            </p>
            
            <div class="flex flex-col sm:flex-row justify-center items-center gap-4">
                <a href="https://on-your.site/register" class="w-full sm:w-auto inline-flex justify-center items-center gap-2 bg-brand-500 hover:bg-brand-600 text-white px-8 py-3.5 rounded-full font-semibold transition-all duration-300 shadow-[0_0_30px_rgba(99,102,241,0.3)] hover:shadow-[0_0_40px_rgba(99,102,241,0.5)] transform hover:-translate-y-1">
                    Claim it now <i class='bx bx-rocket text-xl'></i>
                </a>
                <a href="https://on-your.site" class="w-full sm:w-auto inline-flex justify-center items-center gap-2 bg-card border border-bordercolor hover:border-brand-500/50 text-white px-8 py-3.5 rounded-full font-medium transition-all duration-300">
                    Learn more
                </a>
            </div>
            
        </div>
    </main>

    <footer class="border-t border-bordercolor bg-[#050505] py-12 mt-auto relative z-10">
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
                <a href="/imprint" class="hover:text-white transition-colors">Legal Notice</a>
                <span>&bull;</span>
                <a href="/privacy" class="hover:text-white transition-colors">Privacy Policy</a>
                <span>&bull;</span>
                <a href="/terms" class="hover:text-white transition-colors">Terms of Service</a>
            </div>
            <p class="text-gray-500 text-sm">
                &copy; <?php echo date("Y"); ?> OnYourSite. Crafted with <i class='bx bxs-heart text-red-500 mx-1'></i> for the community.
            </p>
        </div>
    </footer>

</body>
</html>