<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <!-- Die Seite ist schon dunkel: kein Nachtmodus des Browsers darüber (z. B. Brave, Dark Reader) -->
    <meta name="color-scheme" content="dark">
    <meta name="darkreader-lock">
    <title>Privacy Policy | OnYourSite</title>
    
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
        
        <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
            
            <div class="text-center mb-12">
                <h1 class="text-4xl md:text-5xl font-extrabold text-white tracking-tight mb-4">Privacy Policy</h1>
                <p class="text-lg text-gray-400">How we handle, protect, and respect your personal data.</p>
                <p class="text-xs text-gray-500 mt-2">Last Updated: <?php echo date('F j, Y'); ?></p>
            </div>

            <div class="bg-card border border-bordercolor rounded-2xl p-8 md:p-12 shadow-2xl space-y-10 text-sm md:text-base text-gray-400 leading-relaxed">
                
                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-data text-brand-400 text-2xl'></i> 1. Information We Collect
                    </h2>
                    <p class="mb-3">When you register and use OnYourSite, we collect specific information to provide our services to you:</p>
                    <ul class="list-disc pl-6 space-y-2 mb-4">
                        <li><strong>Account Information:</strong> Your email address and a securely hashed password.</li>
                        <li><strong>Profile Data:</strong> Information you voluntarily provide for your public subdomain, including your display name, biography, links, and uploaded images.</li>
                    </ul>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-cog text-brand-400 text-2xl'></i> 2. How We Use Your Information
                    </h2>
                    <p class="mb-3">We use your data strictly to operate our platform:</p>
                    <ul class="list-disc pl-6 space-y-2 mb-4">
                        <li>To host and display your personalized web page at <em>*.on-your.site</em>.</li>
                        <li>To secure your account and allow you to log in.</li>
                        <li>To communicate essential updates regarding your profile.</li>
                    </ul>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-mail-send text-brand-400 text-2xl'></i> 3. Registration Emails & Discord Tokens
                    </h2>
                    <p>
                        Immediately upon registration, we are authorized to send an automated <strong>Registration Email</strong> to the address you provided. In the future, this email will also contain a unique Registration Token, which you will need to securely link your OnYourSite account with our Discord community. This is a core function of our account creation process.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-error-circle text-brand-400 text-2xl'></i> 4. Service Announcements & Maintenance
                    </h2>
                    <p>
                        We reserve the right to send you mandatory service announcements. This includes, but is not limited to, notices about server maintenance, security alerts, or major updates to our legal terms. Because these emails are vital for the continued secure use of your account, you cannot opt-out of them unless you completely delete your account.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-news text-brand-400 text-2xl'></i> 5. Newsletter & Promotional Emails
                    </h2>
                    <p>
                        If you explicitly opt-in or register for our Newsletter, you grant us permission to send promotional emails, marketing materials, and new feature announcements to your stored email address. You have the right to revoke this consent and unsubscribe from promotional emails at any time without affecting your account status.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bxl-discord-alt text-brand-400 text-2xl'></i> 6. Discord Integration Liability
                    </h2>
                    <div class="bg-blue-500/10 border border-blue-500/20 p-4 rounded-xl mb-4 text-gray-300">
                        <strong class="text-blue-400 block mb-1">Important Notice:</strong>
                        Discord is an independent, third-party platform. We do not govern, control, or take responsibility for how Discord handles your privacy.
                    </div>
                    <p>
                        If you link your Discord account, any data shared on their platform falls entirely under Discord's Privacy Policy. OnYourSite is explicitly <strong>not liable</strong> for data protection, data breaches, or any privacy concerns related to the Discord platform.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-cookie text-brand-400 text-2xl'></i> 7. Cookies & Tracking
                    </h2>
                    <p>
                        We do not use third-party ad trackers. We solely use <strong>essential session cookies</strong> (PHP Sessions) which are absolutely necessary to keep you logged into your dashboard securely.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-line-chart text-brand-400 text-2xl'></i> 8. Analytics & Server Logs
                    </h2>
                    <p>
                        Like most standard websites, we may collect basic server logs (such as IP addresses, browser types, and access times) to ensure platform stability, prevent DDoS attacks, and diagnose technical errors. This data is not used to identify individual users.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-globe text-brand-400 text-2xl'></i> 9. Public Information & Subdomains
                    </h2>
                    <p>
                        Any information you enter into the Profile Builder will be <strong>publicly accessible</strong> on the internet. Do not share sensitive personal information (like your home address or phone number) on your public profile.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-link-external text-brand-400 text-2xl'></i> 10. Links to External Websites
                    </h2>
                    <p>
                        User profiles may contain links to external sites. We have no control over the content or privacy practices of those websites and accept no responsibility for them.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-lock-alt text-brand-400 text-2xl'></i> 11. Data Security Measures
                    </h2>
                    <p>
                        Your passwords are never stored in plain text; they are protected using strong cryptographic hashing algorithms (bcrypt). However, no electronic storage is 100% secure.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-time text-brand-400 text-2xl'></i> 12. Data Retention
                    </h2>
                    <p>
                        We retain your personal information only for as long as your account is active and necessary to provide our services.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-trash text-brand-400 text-2xl'></i> 13. Account Deletion & Right to Erasure
                    </h2>
                    <p>
                        If you request to delete your account, your profile data, uploaded images, and subdomains are permanently erased from our active databases, abiding by the "Right to be Forgotten."
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-user-x text-brand-400 text-2xl'></i> 14. Data Sharing & Disclosure
                    </h2>
                    <div class="bg-emerald-500/10 border border-emerald-500/20 p-4 rounded-xl mb-4 text-emerald-400 font-medium">
                        <i class='bx bx-shield-check'></i> We will never sell, rent, or trade your personal data.
                    </div>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-buildings text-brand-400 text-2xl'></i> 15. Business Transfers
                    </h2>
                    <p>
                        If OnYourSite is involved in a merger, acquisition, or asset sale, your personal data may be transferred. We will provide notice before your personal data is transferred and becomes subject to a different Privacy Policy.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-certification text-brand-400 text-2xl'></i> 16. Law Enforcement & Legal Requests
                    </h2>
                    <p>
                        We may disclose your information if required to do so by law, or in response to valid requests by public authorities (e.g., a court subpoena or a government agency warrant).
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-check-shield text-brand-400 text-2xl'></i> 17. Your General Rights & Choices
                    </h2>
                    <p>
                        You have the right to access and modify your personal data directly through your Dashboard settings at any time.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-export text-brand-400 text-2xl'></i> 18. Data Portability
                    </h2>
                    <p>
                        Upon verifiable request, you have the right to receive a copy of the personal data we hold about you in a structured, commonly used, and machine-readable format.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-user-check text-brand-400 text-2xl'></i> 19. Revocation of Consent
                    </h2>
                    <p>
                        Where our processing of your personal information is based on your consent, you have the right to withdraw that consent at any time.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-bot text-brand-400 text-2xl'></i> 20. Automated Decision-Making
                    </h2>
                    <p>
                        We do not use your personal data for automated decision-making processes or extensive profiling that produces legal effects concerning you.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-child text-brand-400 text-2xl'></i> 21. Children's Privacy (COPPA)
                    </h2>
                    <p>
                        Our Service is not directed to anyone under the age of 13. We do not knowingly collect personally identifiable information from children. If discovered, such data will be immediately erased.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-transfer text-brand-400 text-2xl'></i> 22. International Data Transfers
                    </h2>
                    <p>
                        Your information may be transferred to and maintained on servers located outside of your jurisdiction. By using our Service, you consent to this transfer.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-world text-brand-400 text-2xl'></i> 23. European Privacy Rights (GDPR)
                    </h2>
                    <p>
                        If you are a resident of the European Economic Area (EEA), you have specific data protection rights under the General Data Protection Regulation (GDPR), including the right to object to processing and the right to lodge a complaint with a supervisory authority.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-map-alt text-brand-400 text-2xl'></i> 24. California Privacy Rights (CCPA)
                    </h2>
                    <p>
                        If you are a California resident, the California Consumer Privacy Act (CCPA) grants you specific rights regarding your personal information, including the right to know what data is collected and the right to non-discrimination for exercising your privacy rights.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-hide text-brand-400 text-2xl'></i> 25. "Do Not Track" Signals
                    </h2>
                    <p>
                        Because we do not track you across third-party websites, our Service does not respond to or require handling of "Do Not Track" (DNT) browser signals.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-error text-brand-400 text-2xl'></i> 26. Data Breaches
                    </h2>
                    <p>
                        In the event of a data breach compromising your email address, we will notify you as soon as reasonably possible with the nature of the breach and our mitigation steps.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-refresh text-brand-400 text-2xl'></i> 27. Changes to This Policy
                    </h2>
                    <p>
                        We may update our Privacy Policy. We will notify you of major changes by posting the new Policy here and sending an email notice if applicable.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-envelope text-brand-400 text-2xl'></i> 28. Contact Us
                    </h2>
                    <p>
                        If you have any questions or concerns about this Privacy Policy, please contact us at:
                        <br><br>
                        <a href="mailto:contact@on-your.site" class="text-brand-400 hover:text-brand-300 font-medium transition-colors">contact@on-your.site</a>
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