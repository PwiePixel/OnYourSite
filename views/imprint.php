<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <!-- Die Seite ist schon dunkel: kein Nachtmodus des Browsers darüber (z. B. Brave, Dark Reader) -->
    <meta name="color-scheme" content="dark">
    <meta name="darkreader-lock">
    <title>Legal Notice | OnYourSite</title>
    
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <link href='https://unpkg.com/boxicons@2.1.4/css/boxicons.min.css' rel='stylesheet'>
    <link rel="icon" type="image/png" href="/static/images/favicon.png">
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

    <main class="relative flex-1 pt-32 pb-20 lg:pt-40 lg:pb-32 overflow-hidden">
        <div class="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[600px] bg-brand-500/10 rounded-full blur-[120px] -z-10 pointer-events-none"></div>
        
        <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
            
            <div class="text-center mb-12">
                <h1 class="text-4xl md:text-5xl font-extrabold text-white tracking-tight mb-4">Legal Notice</h1>
                <p class="text-lg text-gray-400">Important legal information and contact details for OnYourSite.</p>
            </div>

            <div class="bg-card border border-bordercolor rounded-2xl p-8 md:p-12 shadow-2xl space-y-10 text-sm md:text-base text-gray-400 leading-relaxed">
                
                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-envelope text-brand-400 text-2xl'></i> Contact Information
                    </h2>
                    <div class="bg-inputbg border border-bordercolor p-5 rounded-xl space-y-3">
                        <p><strong>Platform Name:</strong> OnYourSite</p>
                        <p><strong>Location / Jurisdiction:</strong> Phoenix, Arizona, United States</p>
                        <p><strong>Primary Email:</strong> <a href="mailto:contact@on-your.site" class="text-brand-400 hover:text-brand-300 transition-colors font-medium">contact@on-your.site</a></p>
                    </div>
                    <p class="text-xs text-gray-500 italic mt-4">
                        Please note: OnYourSite is operated strictly as an independent, non-commercial hobbyist service. We do not sell physical goods, digital assets, or charge for our basic platform usage. Therefore, under applicable jurisdiction, a physical address is not provided.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-error text-brand-400 text-2xl'></i> General Disclaimer
                    </h2>
                    <p class="mb-4">
                        All information and services on this website are provided "as is" and without any warranties of any kind, whether express or implied. OnYourSite does not warrant or guarantee that the platform will be error-free, constantly available, or completely secure against unauthorized access or malicious attacks.
                    </p>
                    <p>
                        We explicitly disclaim any liability for damages, whether direct, indirect, incidental, or consequential, arising from the use or inability to use this platform. Use of OnYourSite is entirely at your own risk.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-user-pin text-brand-400 text-2xl'></i> Liability for User-Generated Content
                    </h2>
                    <p class="mb-4">
                        OnYourSite acts exclusively as a hosting provider. We allow users to create personal profiles and host content on customized subdomains (e.g., <em>*.on-your.site</em>). 
                    </p>
                    <p class="mb-4">
                        <strong>We do not pre-screen, monitor, or endorse the content uploaded by our users.</strong> Therefore, we cannot assume any liability for the texts, images, links, or code published on user subdomains. The respective user is solely legally responsible for the content published under their chosen subdomain.
                    </p>
                    <p>
                        If we are made aware of any concrete legal violations (such as copyright infringement, hate speech, or illicit material), we will promptly investigate and remove or block the offending content without prior notice. Please use our contact email to report any such violations.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-link-external text-brand-400 text-2xl'></i> Liability for External Links
                    </h2>
                    <p>
                        Our platform and the user-generated profiles contain numerous links to external third-party websites. We have no control over the content or security of these external sites. As such, we cannot assume any liability for the content or privacy practices of these linked sites. The provider or operator of the respective external site is always responsible for its content. A permanent control of the linked pages is unreasonable without concrete evidence of a violation of the law.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-copyright text-brand-400 text-2xl'></i> Copyright & Trademarks
                    </h2>
                    <p class="mb-4">
                        The overall design, architecture, branding, and structural code of OnYourSite are protected by copyright law. Reproduction, editing, distribution, or any kind of exploitation outside the limits of copyright law require the written consent of OnYourSite.
                    </p>
                    <p>
                        Content hosted on individual user subdomains remains the intellectual property of the respective user. Furthermore, users are strictly prohibited from using brand names or trademarks owned by third parties as their subdomain names (cybersquatting). We reserve the right to confiscate such subdomains.
                    </p>
                </section>

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

            <p class="text-gray-600 text-sm">
                &copy; <?php echo date("Y"); ?> OnYourSite. Crafted with <i class='bx bxs-heart text-red-500 mx-1'></i> for the community.
            </p>
        </div>
    </footer>

</body>
</html>