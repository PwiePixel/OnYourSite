<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <!-- Die Seite ist schon dunkel: kein Nachtmodus des Browsers darüber (z. B. Brave, Dark Reader) -->
    <meta name="color-scheme" content="dark">
    <meta name="darkreader-lock">
    <title>Terms of Service | OnYourSite</title>
    
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
                <h1 class="text-4xl md:text-5xl font-extrabold text-white tracking-tight mb-4">Terms of Service</h1>
                <p class="text-lg text-gray-400">The comprehensive rules and legal agreements for using OnYourSite.</p>
                <p class="text-xs text-gray-500 mt-2">Last Updated: <?php echo date('F j, Y'); ?></p>
            </div>

            <div class="bg-card border border-bordercolor rounded-2xl p-8 md:p-12 shadow-2xl space-y-10 text-sm md:text-base text-gray-400 leading-relaxed">
                
                <section>
                    <p class="text-lg text-white font-medium mb-4">Welcome to OnYourSite!</p>
                    <p>
                        By accessing, registering for, or using OnYourSite (the "Service"), you explicitly agree to be bound by these Terms of Service. If you do not agree to every provision of these terms, you are not authorized to use our Service. Your continued use of the Service constitutes acceptance of these Terms and our <a href="/privacy" class="text-brand-400 hover:text-brand-300 transition-colors">Privacy Policy</a>.
                    </p>
                </section>

                <a href="/terms/code-pages" class="flex items-start gap-4 bg-brand-500/5 border border-brand-500/20 hover:border-brand-500/50 p-4 rounded-xl transition-colors group">
                    <span class="w-10 h-10 shrink-0 rounded-xl bg-brand-500/15 text-brand-400 flex items-center justify-center text-2xl"><i class='bx bx-code-alt'></i></span>
                    <span><strong class="text-white block">Building your own website with a code page?</strong><span class="text-gray-400">Code pages have additional rules – most importantly, they must not be used to sell anything or to make money. Read the <span class="text-brand-400 group-hover:text-brand-300">Code Page Terms</span>.</span></span>
                </a>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-map-pin text-brand-400 text-2xl'></i> 1. Jurisdiction & Provider Status
                    </h2>
                    <p class="mb-3">
                        OnYourSite is operated as a free, non-commercial service. The platform is hosted and legally governed under the laws of the State of <strong>Arizona, United States</strong>, without regard to its conflict of law provisions.
                    </p>
                    <p>
                        Because we do not operate as a registered commercial corporate entity, do not sell physical or digital goods, and do not serve advertisements, we are not legally obligated under US law to publicly disclose a physical address. All official and legal inquiries must be directed to the contact email provided in our Legal Notice.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-user-pin text-brand-400 text-2xl'></i> 2. User Responsibility & Local Laws
                    </h2>
                    <div class="bg-red-500/5 border border-red-500/20 p-4 rounded-xl mb-4 text-gray-300">
                        <strong class="text-red-400 block mb-1">Crucial Notice Regarding Your Subdomain:</strong>
                        You are 100% solely responsible and legally liable for any text, images, links, code, and overall content you publish on your <em>*.on-your.site</em> subdomain. OnYourSite functions strictly as a host provider.
                    </div>
                    <p class="mb-3">
                        <strong>Compliance with Local Laws:</strong> While our platform operates under US jurisdiction, <strong>you must comply with the laws of your own country of residence</strong> regarding the content you publish. 
                    </p>
                    <p>
                        For example: If you reside in a country within the European Union (e.g., Germany, Austria) that legally requires an "Impressum" (Imprint) for publicly accessible websites, <strong>it is your explicit responsibility to add a link or button to your profile containing your required contact information</strong>. We will not be held liable for any legal warnings, fines, or damages (e.g., Abmahnungen) directed at you due to missing legal disclosures on your personal profile.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-shield-x text-brand-400 text-2xl'></i> 3. Acceptable Use & Content Moderation
                    </h2>
                    <p class="mb-3">You agree not to use the Service to publish, host, or distribute:</p>
                    <ul class="list-disc pl-6 space-y-2 mb-4">
                        <li>Content that is illegal, fraudulent, or promotes illegal activities.</li>
                        <li>Hate speech, harassment, severe bullying, threats, or discriminatory content.</li>
                        <li>Nudity, pornography, or sexually explicit material.</li>
                        <li>Malware, phishing links, spam, or malicious scripts.</li>
                        <li>Content that incites violence or self-harm.</li>
                    </ul>
                    <p class="text-white font-medium">
                        <strong>Zero Tolerance Policy:</strong> We reserve the absolute and unquestionable right to suspend, block, or permanently delete any user account, subdomain, or content at any time, <strong>without prior notice or explanation</strong>, if we determine that the content is inappropriate, harmful, or violates these Terms.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-copyright text-brand-400 text-2xl'></i> 4. Intellectual Property & Copyright (DMCA)
                    </h2>
                    <p class="mb-3">
                        You retain all rights to the content you upload. By uploading content, you grant OnYourSite a license to host, display, and distribute that content solely for the purpose of operating the Service.
                    </p>
                    <p>
                        We respect the intellectual property rights of others. If you believe that your copyrighted work has been copied in a way that constitutes copyright infringement and is accessible via the Service, please notify us immediately via email. We process valid DMCA (Digital Millennium Copyright Act) takedown notices and will remove infringing content or terminate accounts of repeat infringers.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-purchase-tag text-brand-400 text-2xl'></i> 5. Subdomains & Trademarks
                    </h2>
                    <p>
                        Users are allowed to claim available subdomains on a first-come, first-served basis. However, you may not claim subdomains that explicitly violate established trademark rights of third parties (e.g., claiming "apple.on-your.site" or "nike.on-your.site") with malicious intent or to impersonate the brand. We reserve the right to reclaim, reassign, or delete subdomains that violate trademark laws or are used for cybersquatting.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-user-check text-brand-400 text-2xl'></i> 6. Age Requirements
                    </h2>
                    <p>
                        You must be at least 13 years old to use the Service. If you are under the age of majority in your jurisdiction, you must have the permission of your parent or legal guardian to use the Service. By registering an account, you represent and warrant that you meet these age requirements.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-server text-brand-400 text-2xl'></i> 7. Service Availability & Uptime
                    </h2>
                    <p>
                        We strive to keep OnYourSite online and running smoothly. However, the Service is provided on an "AS IS" and "AS AVAILABLE" basis. <strong>We do not guarantee 100% uptime.</strong> The Service may experience unexpected outages, scheduled maintenance windows, or temporary data loss. We are not liable for any damages or losses resulting from the unavailability of your profile or our platform.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-check-shield text-brand-400 text-2xl'></i> 8. Limitation of Liability
                    </h2>
                    <p>
                        To the maximum extent permitted by applicable law, in no event shall OnYourSite, its administrators, or contributors be liable for any indirect, punitive, incidental, special, consequential, or exemplary damages, including without limitation damages for loss of profits, goodwill, use, data, or other intangible losses, that result from the use of, or inability to use, this Service.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-briefcase-alt text-brand-400 text-2xl'></i> 9. Indemnification
                    </h2>
                    <p>
                        You agree to defend, indemnify, and hold harmless OnYourSite and its administrators from and against any and all claims, damages, obligations, losses, liabilities, costs, or debt, and expenses (including but not limited to attorney's fees) arising from: (a) your use of and access to the Service; (b) your violation of any term of these Terms of Service; (c) your violation of any third-party right, including without limitation any copyright, property, or privacy right; or (d) any claim that your content caused damage to a third party.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-refresh text-brand-400 text-2xl'></i> 10. Modifications to Terms
                    </h2>
                    <p>
                        We reserve the right to modify, replace, or update these Terms of Service or our Privacy Policy at any time, without prior individual notice for minor adjustments. 
                    </p>
                    <p class="mt-3">
                        However, if a revision constitutes a <strong>major, material change</strong> that significantly impacts your rights or obligations, we will make reasonable efforts to provide at least <strong>one (1) week's notice</strong> prior to any new terms taking effect (e.g., via an announcement in your dashboard or an email newsletter). What constitutes a material change will be determined at our sole discretion. By continuing to access or use our Service after those revisions become effective, you agree to be bound by the revised terms.
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
            
            <div class="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 mb-6 text-sm text-gray-500 font-medium">
                <a href="/imprint" class="hover:text-white transition-colors">Legal Notice</a>
                <span>&bull;</span>
                <a href="/privacy" class="hover:text-white transition-colors">Privacy Policy</a>
                <span>&bull;</span>
                <a href="/terms" class="hover:text-white transition-colors">Terms of Service</a>
                <span>&bull;</span>
                <a href="/terms/code-pages" class="hover:text-white transition-colors">Code Page Terms</a>
            </div>

            <p class="text-gray-600 text-sm">
                &copy; <?php echo date("Y"); ?> OnYourSite. Crafted with <i class='bx bxs-heart text-red-500 mx-1'></i> for the community.
            </p>
        </div>
    </footer>

</body>
</html>