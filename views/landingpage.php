<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    
    <title>OnYourSite | Next-Gen Personal Webspace</title>
    <meta name="description" content="Deploy your beautiful Link-in-Bio, Bento Grid, or Minimal CV in seconds. Free SSL, custom subdomains, premium dark-mode themes, and Discord integration.">
    <meta name="keywords" content="link in bio, personal website, free hosting, custom subdomain, developer portfolio, creator page, bento grid, minimal cv">
    <meta name="author" content="OnYourSite">
    
    <meta property="og:type" content="website">
    <meta property="og:url" content="https://on-your.site/">
    <meta property="og:title" content="OnYourSite | Next-Gen Personal Webspace">
    <meta property="og:description" content="Deploy your beautiful Link-in-Bio, Bento Grid, or Minimal CV in seconds. Secure, blazing fast, and hosted on your own custom subdomain.">
    <meta property="og:image" content="https://on-your.site/static/images/favicon.png">

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
    <link rel="stylesheet" href="/static/css/styles.css">
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
                    <a href="#how-it-works" class="text-sm font-medium text-gray-400 hover:text-white transition-colors">How it works</a>
                    <a href="#faq" class="text-sm font-medium text-gray-400 hover:text-white transition-colors">FAQ</a>
                    <a href="https://discord.on-your.site" target="_blank" class="text-sm font-medium text-[#5865F2] hover:text-[#4752C4] transition-colors flex items-center gap-1"><i class='bx bxl-discord-alt text-lg'></i> Community</a>
                    <div class="h-5 w-px bg-bordercolor"></div>
                    <a href="/login" class="text-sm font-medium text-white hover:text-brand-400 transition-colors">Sign In</a>
                    <a href="/register" class="text-sm font-medium bg-white text-black px-5 py-2.5 rounded-full hover:bg-gray-200 transition-all duration-300 transform hover:scale-105 shadow-[0_0_15px_rgba(255,255,255,0.1)]">
                        Get Started
                    </a>
                </div>
            </div>
        </div>
    </nav>

    <main class="relative pt-32 pb-20 lg:pt-48 lg:pb-32 overflow-hidden">
        <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-brand-500/20 rounded-full blur-[120px] -z-10 pointer-events-none"></div>
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center relative z-10">
            <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-bordercolor bg-white/5 backdrop-blur-sm text-xs font-medium text-gray-300 mb-8 animate-fade-in">
                <span class="flex h-2 w-2 rounded-full bg-brand-500 animate-pulse"></span>
                v0.8 Beta is now open
            </div>
            <h1 class="text-5xl md:text-7xl font-extrabold text-white tracking-tight mb-6 drop-shadow-lg">
                Your personal space on the <br class="hidden md:block">
                <span class="bg-clip-text text-transparent bg-gradient-to-r from-brand-400 to-purple-500">
                    modern web.
                </span>
            </h1>
            <p class="mt-4 max-w-2xl mx-auto text-lg md:text-xl text-gray-400 mb-10 leading-relaxed">
                Deploy your professional Link-in-Bio, trendy Bento Grid, or Minimal CV in seconds. Secure, beautifully designed, and hosted on your own custom subdomain: <span class="text-white font-medium bg-white/10 px-2 py-0.5 rounded">yourname.on-your.site</span>
            </p>
            <div class="flex flex-col sm:flex-row justify-center gap-4">
                <a href="/register" class="inline-flex justify-center items-center gap-2 bg-brand-500 hover:bg-brand-600 text-white px-8 py-3.5 rounded-full font-semibold transition-all duration-300 shadow-[0_0_30px_rgba(99,102,241,0.3)] hover:shadow-[0_0_40px_rgba(99,102,241,0.5)] transform hover:-translate-y-1">
                    Claim your domain <i class='bx bx-rocket text-xl'></i>
                </a>
                <a href="#features" class="inline-flex justify-center items-center gap-2 bg-card border border-bordercolor hover:border-brand-500/50 text-white px-8 py-3.5 rounded-full font-medium transition-all duration-300">
                    Learn more
                </a>
            </div>
        </div>
    </main>

    <section id="features" class="py-24 border-t border-bordercolor bg-background relative">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div class="text-center max-w-3xl mx-auto mb-16">
                <h2 class="text-3xl md:text-5xl font-bold text-white mb-4">Everything you need.</h2>
                <p class="text-lg text-gray-400">Stop wrestling with complex website builders. We give you the tools to look professional instantly.</p>
            </div>
            
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                <div class="group p-8 rounded-3xl bg-card border border-bordercolor hover:border-brand-500/50 transition-all duration-500 hover:-translate-y-1">
                    <div class="w-14 h-14 rounded-2xl bg-white/5 border border-bordercolor flex items-center justify-center mb-6 group-hover:bg-brand-500/20 group-hover:text-brand-400 transition-all">
                        <i class='bx bx-layout text-3xl text-gray-400 group-hover:text-brand-400'></i>
                    </div>
                    <h3 class="text-xl font-bold text-white mb-3">4 Layout Engines</h3>
                    <p class="text-gray-400 text-sm leading-relaxed">Don't settle for boring lists. Choose between a classic Link-in-Bio, a detailed About-Me split page, a trendy Bento Grid, or a Minimal CV.</p>
                </div>
                <div class="group p-8 rounded-3xl bg-card border border-bordercolor hover:border-brand-500/50 transition-all duration-500 hover:-translate-y-1">
                    <div class="w-14 h-14 rounded-2xl bg-white/5 border border-bordercolor flex items-center justify-center mb-6 group-hover:bg-purple-500/20 group-hover:text-purple-400 transition-all">
                        <i class='bx bx-palette text-3xl text-gray-400 group-hover:text-purple-400'></i>
                    </div>
                    <h3 class="text-xl font-bold text-white mb-3">Premium Themes</h3>
                    <p class="text-gray-400 text-sm leading-relaxed">Choose from 10+ stunning designs like Cyberpunk, Midnight, or Glassmorphism to make your layout truly yours.</p>
                </div>
                <div class="group p-8 rounded-3xl bg-card border border-bordercolor hover:border-brand-500/50 transition-all duration-500 hover:-translate-y-1">
                    <div class="w-14 h-14 rounded-2xl bg-white/5 border border-bordercolor flex items-center justify-center mb-6 group-hover:bg-[#5865F2]/20 group-hover:text-[#5865F2] transition-all">
                        <i class='bx bxl-discord-alt text-3xl text-gray-400 group-hover:text-[#5865F2]'></i>
                    </div>
                    <h3 class="text-xl font-bold text-white mb-3">Discord Integration</h3>
                    <p class="text-gray-400 text-sm leading-relaxed">Link your Discord ID in your dashboard and automatically receive exclusive verified customer roles on our official server.</p>
                </div>
                <div class="group p-8 rounded-3xl bg-card border border-bordercolor hover:border-brand-500/50 transition-all duration-500 hover:-translate-y-1">
                    <div class="w-14 h-14 rounded-2xl bg-white/5 border border-bordercolor flex items-center justify-center mb-6 group-hover:bg-emerald-500/20 group-hover:text-emerald-400 transition-all">
                        <i class='bx bx-cloud-lightning text-3xl text-gray-400 group-hover:text-emerald-400'></i>
                    </div>
                    <h3 class="text-xl font-bold text-white mb-3">Instant Deployment</h3>
                    <p class="text-gray-400 text-sm leading-relaxed">Enter your details and go live instantly. No FTP, no server setups, no database configurations required.</p>
                </div>
                <div class="group p-8 rounded-3xl bg-card border border-bordercolor hover:border-brand-500/50 transition-all duration-500 hover:-translate-y-1">
                    <div class="w-14 h-14 rounded-2xl bg-white/5 border border-bordercolor flex items-center justify-center mb-6 group-hover:bg-blue-500/20 group-hover:text-blue-400 transition-all">
                        <i class='bx bx-lock-alt text-3xl text-gray-400 group-hover:text-blue-400'></i>
                    </div>
                    <h3 class="text-xl font-bold text-white mb-3">Free SSL Included</h3>
                    <p class="text-gray-400 text-sm leading-relaxed">Every custom subdomain gets an automated SSL certificate. Your profile is served securely over HTTPS from day one.</p>
                </div>
                <div class="group p-8 rounded-3xl bg-card border border-bordercolor hover:border-brand-500/50 transition-all duration-500 hover:-translate-y-1">
                    <div class="w-14 h-14 rounded-2xl bg-white/5 border border-bordercolor flex items-center justify-center mb-6 group-hover:bg-yellow-500/20 group-hover:text-yellow-400 transition-all">
                        <i class='bx bx-code-block text-3xl text-gray-400 group-hover:text-yellow-400'></i>
                    </div>
                    <h3 class="text-xl font-bold text-white mb-3">Custom CSS & SEO</h3>
                    <p class="text-gray-400 text-sm leading-relaxed">Control how you look on Google with custom Meta Tags, and inject your own CSS to modify every single element to your liking.</p>
                </div>
            </div>
        </div>
    </section>

    <section id="how-it-works" class="py-24 border-t border-bordercolor bg-[#0a0a0c] relative overflow-hidden">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
            <div class="text-center max-w-3xl mx-auto mb-16">
                <h2 class="text-3xl md:text-5xl font-bold text-white mb-4">How it works</h2>
                <p class="text-lg text-gray-400">Get your personal website up and running in three simple steps.</p>
            </div>
            
            <div class="grid grid-cols-1 md:grid-cols-3 gap-12 text-center relative">
                <div class="hidden md:block absolute top-10 left-[20%] right-[20%] h-0.5 bg-gradient-to-r from-transparent via-brand-500/50 to-transparent -z-10"></div>

                <div>
                    <div class="w-20 h-20 mx-auto bg-card border border-bordercolor rounded-full flex items-center justify-center text-2xl font-bold text-brand-400 mb-6 shadow-[0_0_20px_rgba(99,102,241,0.2)]">1</div>
                    <h4 class="text-xl font-bold text-white mb-2">Create Account</h4>
                    <p class="text-gray-400 text-sm leading-relaxed px-4">Sign up securely using your email address to get access to your personal dashboard.</p>
                </div>
                <div>
                    <div class="w-20 h-20 mx-auto bg-card border border-bordercolor rounded-full flex items-center justify-center text-2xl font-bold text-brand-400 mb-6 shadow-[0_0_20px_rgba(99,102,241,0.2)]">2</div>
                    <h4 class="text-xl font-bold text-white mb-2">Claim Subdomain</h4>
                    <p class="text-gray-400 text-sm leading-relaxed px-4">Choose your unique <em>.on-your.site</em> address before someone else takes it.</p>
                </div>
                <div>
                    <div class="w-20 h-20 mx-auto bg-brand-500 border border-brand-400 rounded-full flex items-center justify-center text-2xl font-bold text-white mb-6 shadow-[0_0_30px_rgba(99,102,241,0.5)]">3</div>
                    <h4 class="text-xl font-bold text-white mb-2">Publish & Share</h4>
                    <p class="text-gray-400 text-sm leading-relaxed px-4">Pick your layout, add your bio and links, and go live instantly.</p>
                </div>
            </div>
        </div>
    </section>

    <section id="faq" class="py-24 border-t border-bordercolor bg-background">
        <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
            <div class="text-center mb-16">
                <h2 class="text-3xl md:text-4xl font-bold text-white mb-4">Frequently Asked Questions</h2>
                <p class="text-gray-400">Everything you need to know about OnYourSite.</p>
            </div>

            <div class="space-y-6">
                <div class="bg-card border border-bordercolor p-6 rounded-2xl">
                    <h3 class="text-lg font-bold text-white mb-2">Is OnYourSite really free?</h3>
                    <p class="text-gray-400 text-sm leading-relaxed">Yes! Claiming your subdomain, creating your profile, and using our standard themes is 100% free. We operate this as a community project.</p>
                </div>
                <div class="bg-card border border-bordercolor p-6 rounded-2xl">
                    <h3 class="text-lg font-bold text-white mb-2">Can I change my layout later?</h3>
                    <p class="text-gray-400 text-sm leading-relaxed">Absolutely! You can seamlessly switch between our Link-Tree, About-Me, Bento Grid, and Minimal CV engines at any time directly from your dashboard.</p>
                </div>
                <div class="bg-card border border-bordercolor p-6 rounded-2xl">
                    <h3 class="text-lg font-bold text-white mb-2">Do I need to know how to code?</h3>
                    <p class="text-gray-400 text-sm leading-relaxed">Not at all. Our intuitive visual dashboard lets you arrange links, upload images, and write your bio without touching a single line of code. (Though if you do know CSS, you can inject it!)</p>
                </div>
                <div class="bg-card border border-bordercolor p-6 rounded-2xl">
                    <h3 class="text-lg font-bold text-white mb-2">Can I change my subdomain later?</h3>
                    <p class="text-gray-400 text-sm leading-relaxed">Yes. However, to prevent abuse and domain hoarding, you are limited to changing your subdomain once every 30 days.</p>
                </div>
            </div>
        </div>
    </section>

    <section class="py-24 border-t border-bordercolor bg-[#0a0a0c] relative overflow-hidden">
        <div class="absolute inset-0 bg-brand-500/5"></div>
        <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center relative z-10">
            <h2 class="text-3xl md:text-5xl font-extrabold text-white mb-6">Ready to stand out?</h2>
            <p class="text-lg text-gray-400 mb-10">Join the community and create your personalized profile today. It takes less than a minute.</p>
            <a href="/register" class="inline-flex justify-center items-center gap-2 bg-white text-black hover:bg-gray-200 px-10 py-4 rounded-full font-bold transition-all duration-300 transform hover:scale-105 shadow-xl text-lg">
                Create your Profile <i class='bx bx-right-arrow-alt text-2xl'></i>
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

    <style>
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .animate-fade-in { animation: fadeIn 0.6s ease forwards; }
    </style>
</body>
</html>