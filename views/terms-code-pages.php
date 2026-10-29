<?php
// Zusatzbedingungen für Code-Seiten (selbst geschriebene Websites unter name.on-your.site)
$codePrice = oys_hc_settings($pdo)['code_page'];
?>
<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <!-- Die Seite ist schon dunkel: kein Nachtmodus des Browsers darüber (z. B. Brave, Dark Reader) -->
    <meta name="color-scheme" content="dark">
    <meta name="darkreader-lock">
    <title>Code Page Terms | OnYourSite</title>
    <meta name="description" content="Additional rules for websites you build yourself with HTML, CSS and JavaScript on OnYourSite.">

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
                    <a href="/terms" class="text-sm font-medium text-gray-400 hover:text-white transition-colors">Terms of Service</a>
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
                <div class="w-16 h-16 mx-auto mb-5 rounded-2xl bg-gradient-to-br from-brand-500 to-indigo-700 text-white flex items-center justify-center text-4xl shadow-[0_16px_40px_-12px_rgba(99,102,241,0.7)]"><i class='bx bx-code-alt'></i></div>
                <h1 class="text-4xl md:text-5xl font-extrabold text-white tracking-tight mb-4">Code Page Terms</h1>
                <p class="text-lg text-gray-400">Additional rules for websites you build yourself with HTML, CSS and JavaScript.</p>
                <p class="text-xs text-gray-500 mt-2">Last updated: October 29, 2026</p>
            </div>

            <div class="bg-card border border-bordercolor rounded-2xl p-8 md:p-12 shadow-2xl space-y-10 text-sm md:text-base text-gray-400 leading-relaxed">

                <section>
                    <p class="text-lg text-white font-medium mb-4">Your own website – for information, not for business.</p>
                    <p>
                        A <strong class="text-white">code page</strong> is a website you write yourself and host on OnYourSite at <em>yourname.on-your.site</em>. These Code Page Terms apply <strong>in addition to</strong> our general <a href="/terms" class="text-brand-400 hover:text-brand-300 transition-colors">Terms of Service</a> whenever you create, edit or publish a code page. If something here differs from the general Terms, these Code Page Terms apply to your code page. By unlocking or publishing a code page, you accept them.
                    </p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-block text-brand-400 text-2xl'></i> 1. Non-Commercial Use Only
                    </h2>
                    <div class="bg-red-500/5 border border-red-500/20 p-4 rounded-xl mb-5 text-gray-300">
                        <strong class="text-red-400 block mb-1">The most important rule:</strong>
                        A code page may only inform about or promote something. It must not sell anything and must not be used to make money – neither directly nor indirectly.
                    </div>
                    <div class="grid md:grid-cols-2 gap-4">
                        <div class="bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-4">
                            <p class="text-emerald-400 font-semibold mb-2 flex items-center gap-1.5"><i class='bx bx-check-circle'></i> Allowed</p>
                            <ul class="list-disc pl-5 space-y-1.5">
                                <li>Personal websites, portfolios and CVs</li>
                                <li>Pages about your projects, hobbies, music, art or videos</li>
                                <li>Pages for a community, club, Discord server or event</li>
                                <li>Documentation, tutorials and open-source project pages</li>
                                <li>Fan pages, small games, experiments and demos</li>
                                <li>Promoting yourself, your work or your channels – as long as nothing is sold</li>
                            </ul>
                        </div>
                        <div class="bg-red-500/5 border border-red-500/20 rounded-xl p-4">
                            <p class="text-red-400 font-semibold mb-2 flex items-center gap-1.5"><i class='bx bx-x-circle'></i> Not allowed</p>
                            <ul class="list-disc pl-5 space-y-1.5">
                                <li>Online shops, selling products or services, order forms or price lists to order from</li>
                                <li>Payment buttons, checkouts, collecting payment details, crypto payment addresses</li>
                                <li>Donation or tip requests that collect money</li>
                                <li>Advertising: ad networks, banners, sponsored content, paid placements</li>
                                <li>Affiliate, referral or tracking links you get paid for</li>
                                <li>Paid content, memberships, subscriptions or paywalls</li>
                                <li>Gambling, betting, lotteries or giveaways with paid entry</li>
                                <li>Pages whose main purpose is to send visitors to a shop or paid offer</li>
                            </ul>
                        </div>
                    </div>
                    <p class="mt-4">Not sure whether your idea is allowed? Ask us before you publish it – we’re happy to help.</p>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-shield-x text-brand-400 text-2xl'></i> 2. Forbidden Content and Code
                    </h2>
                    <p class="mb-3">Everything that is forbidden on OnYourSite in general is also forbidden on code pages. In addition, your code page must not contain or be used for:</p>
                    <ul class="list-disc pl-6 space-y-2">
                        <li><strong class="text-white">Phishing and deception:</strong> fake login pages, pages that imitate OnYourSite, banks or other services, or that trick people into giving away passwords or personal data.</li>
                        <li><strong class="text-white">Harmful code:</strong> malware, crypto miners, exploits, forced downloads, pop-up floods or redirects to dangerous websites.</li>
                        <li><strong class="text-white">Attacks:</strong> trying to get around the sandbox, attacking OnYourSite, other users or anyone else, scanning or overloading websites.</li>
                        <li><strong class="text-white">Hidden tracking:</strong> collecting data about visitors without telling them, or without a legal basis.</li>
                        <li><strong class="text-white">Spam:</strong> link farms, SEO spam, mass-generated pages or misleading redirects.</li>
                        <li><strong class="text-white">Other people’s work:</strong> copying websites, designs, code, images or fonts you don’t have the rights to.</li>
                        <li><strong class="text-white">Misuse of hosting:</strong> using your code page as file storage or as a server for other websites.</li>
                    </ul>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-code-block text-brand-400 text-2xl'></i> 3. How Code Pages Work
                    </h2>
                    <ul class="list-disc pl-6 space-y-2">
                        <li><strong class="text-white">Files only, no server code:</strong> a code page consists of HTML, CSS, JavaScript, JSON, SVG, XML, text and Markdown files. PHP or any other server-side code is not executed, and there is no database.</li>
                        <li><strong class="text-white">Limits:</strong> up to 30 files, 256 KB per file and 2 MB in total. Images come from your OnYourSite uploads and count towards your storage.</li>
                        <li><strong class="text-white">Sandbox:</strong> for the safety of everyone, every code page runs in a sandbox with its own anonymous origin. Cookies, localStorage and similar browser storage are not available, and your page can’t access OnYourSite accounts. Some browser features may therefore not work.</li>
                        <li><strong class="text-white">OnYourSite badge:</strong> a small “OnYourSite” badge is added to every page. It lets visitors report a page. Don’t hide, cover or remove it.</li>
                        <li><strong class="text-white">Things you load from elsewhere</strong> (fonts, scripts, videos, APIs) are your responsibility, including what they do with your visitors’ data.</li>
                    </ul>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-user-pin text-brand-400 text-2xl'></i> 4. Your Responsibility
                    </h2>
                    <p class="mb-3">You are solely responsible for your code page – for its content, its code and everything it loads from other websites.</p>
                    <ul class="list-disc pl-6 space-y-2">
                        <li><strong class="text-white">Legal notice:</strong> depending on the country you live in, your page may need a legal notice (for example an “Impressum” in Germany or Austria). Adding it is your responsibility.</li>
                        <li><strong class="text-white">Privacy:</strong> if your page collects personal data (for example with a contact form or statistics) or embeds services that do (for example videos or external fonts), you must inform your visitors and follow the data protection laws that apply to you.</li>
                        <li><strong class="text-white">Keep a copy:</strong> please keep your own copy of important code. As described in our general Terms, we can’t guarantee that data is never lost.</li>
                    </ul>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-hive text-brand-400 text-2xl'></i> 5. Honeycombs
                    </h2>
                    <p class="mb-3">
                        Code pages are unlocked with <strong class="text-white">honeycombs</strong> (currently <?= number_format((int) $codePrice) ?>). Honeycombs are free points you collect by using OnYourSite actively, or that our team gives out.
                    </p>
                    <ul class="list-disc pl-6 space-y-2">
                        <li>Honeycombs have no monetary value. They can’t be bought, sold, traded, transferred to others or paid out.</li>
                        <li>We may change how honeycombs are earned and what things cost, correct wrong balances, and remove honeycombs that were collected by cheating (for example fake page views or automated logins).</li>
                        <li>Honeycombs spent on a code page are not refunded if the page is blocked or deleted because it broke these rules.</li>
                    </ul>
                </section>

                <hr class="border-bordercolor">

                <section>
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-check-shield text-brand-400 text-2xl'></i> 6. Moderation, Blocking and Deletion
                    </h2>
                    <p class="mb-3">We may look at code pages, including their code, at any time. If a code page breaks these rules or our general Terms, or puts visitors, other users or OnYourSite at risk, we may – with or without notice:</p>
                    <ul class="list-disc pl-6 space-y-2 mb-3">
                        <li>block the page (visitors then only see a notice),</li>
                        <li>change or take away its address, or delete the page,</li>
                        <li>remove your access to code pages, or close your whole account for serious or repeated violations.</li>
                    </ul>
                    <p>We may also change the limits of code pages or discontinue the feature. For major changes, we give notice as described in our general Terms.</p>
                </section>

                <hr class="border-bordercolor">

                <section id="report" class="scroll-mt-28">
                    <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <i class='bx bx-flag text-brand-400 text-2xl'></i> 7. Report a Code Page
                    </h2>
                    <div class="bg-brand-500/5 border border-brand-500/20 p-5 rounded-xl text-gray-300">
                        <p class="mb-3">Found a code page that sells something, tries to steal data, spreads malware or breaks the law? Please tell us – it only takes a minute:</p>
                        <ol class="list-decimal pl-6 space-y-1.5 mb-4">
                            <li>Copy the address of the page (for example <em>name.on-your.site</em>).</li>
                            <li>Send it to us with a few words about the problem.</li>
                        </ol>
                        <div class="flex flex-wrap gap-3">
                            <a href="mailto:contact@on-your.site?subject=Report%20a%20code%20page" class="inline-flex items-center gap-2 bg-white text-black px-4 py-2.5 rounded-lg font-semibold text-sm hover:bg-gray-200 transition-colors"><i class='bx bx-envelope text-lg'></i> contact@on-your.site</a>
                            <a href="https://discord.gg/nNT8NnM6py" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-2 border border-bordercolor text-white px-4 py-2.5 rounded-lg font-semibold text-sm hover:border-[#5865F2] hover:text-[#8b93ff] transition-colors"><i class='bx bxl-discord-alt text-lg'></i> Tell us on Discord</a>
                        </div>
                        <p class="text-xs text-gray-500 mt-4">We review every report as quickly as we can. Please don’t visit or share pages you think are dangerous.</p>
                    </div>
                </section>

            </div>
        </div>
    </main>

    <footer class="border-t border-bordercolor bg-[#050505] py-12 mt-auto relative z-10">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col items-center">
            <div class="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 mb-6 text-sm text-gray-500 font-medium">
                <a href="/imprint" class="inline-block py-2 hover:text-white transition-colors">Legal Notice</a>
                <span>&bull;</span>
                <a href="/privacy" class="inline-block py-2 hover:text-white transition-colors">Privacy Policy</a>
                <span>&bull;</span>
                <a href="/terms" class="inline-block py-2 hover:text-white transition-colors">Terms of Service</a>
                <span>&bull;</span>
                <a href="/terms/code-pages" class="inline-block py-2 text-gray-300 hover:text-white transition-colors">Code Page Terms</a>
            </div>

            <p class="text-gray-600 text-sm">
                &copy; <?php echo date("Y"); ?> OnYourSite. Crafted with <i class='bx bxs-heart text-red-500 mx-1'></i> for the community.
            </p>
        </div>
    </footer>

</body>
</html>
