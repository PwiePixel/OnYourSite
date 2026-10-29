<!DOCTYPE html>
<html lang="de" class="scroll-smooth">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <!-- Die Seite ist schon dunkel: kein Nachtmodus des Browsers darüber (z. B. Brave, Dark Reader) -->
    <meta name="color-scheme" content="dark">
    <meta name="darkreader-lock">
    <title>Creator Challenge | OnYourSiteDE</title>
    
    <meta name="description" content="Mach mit bei der OnYourSite Creator Challenge! Erreiche mit uns 150 aktive Discord-Member und gewinne fettes Discord Nitro (Premium & Basic).">
    
    <link rel="icon" type="image/png" href="/static/images/favicon.png">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
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
                        inputbg: '#121212',
                        bordercolor: 'rgba(255, 255, 255, 0.08)',
                        brand: { 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5', },
                        nitro: { 400: '#ff73fa', 500: '#f47fff', 600: '#b061ff' } 
                    },
                    animation: {
                        'float': 'float 6s ease-in-out infinite',
                        'shimmer': 'shimmer 2s infinite linear',
                    },
                    keyframes: {
                        float: {
                            '0%, 100%': { transform: 'translateY(0)' },
                            '50%': { transform: 'translateY(-15px)' },
                        },
                        shimmer: {
                            '0%': { transform: 'translateX(-100%)' },
                            '100%': { transform: 'translateX(100%)' }
                        }
                    }
                }
            }
        }
    </script>
    <style>
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.1); border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.2); }
        
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .animate-fade-in { animation: fadeIn 0.6s ease forwards; }
    </style>
</head>
<body class="bg-background text-gray-300 font-sans antialiased overflow-x-hidden selection:bg-nitro-500/30 flex flex-col min-h-screen">

    <nav class="fixed w-full z-50 top-0 transition-all duration-300 backdrop-blur-md bg-background/80 border-b border-bordercolor">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div class="flex justify-between items-center h-20">
                <a href="/" class="flex-shrink-0 flex items-center gap-3 cursor-pointer transition-transform hover:scale-105">
                    <img src="/static/images/onyoursitedelogo1.png" alt="OnYourSite DE Logo" class="h-8 md:h-9 object-contain">
                    <span class="font-bold text-xl text-white tracking-tight hidden sm:block">OnYourSite</span>
                </a>
                <div class="hidden md:flex items-center space-x-8">
                    <a href="https://discord.gg/nNT8NnM6py" target="_blank" class="text-sm font-medium text-[#5865F2] hover:text-white transition-colors flex items-center gap-1 group">
                        <i class='bx bxl-discord-alt text-lg group-hover:scale-110 transition-transform'></i> Server beitreten
                    </a>
                    <div class="h-5 w-px bg-bordercolor"></div>
                    <a href="/login" class="text-sm font-medium text-white hover:text-brand-400 transition-colors">Sign In</a>
                    <a href="/register" class="text-sm font-medium bg-white text-black px-6 py-2.5 rounded-full hover:bg-gray-200 transition-all duration-300 transform hover:scale-105 shadow-[0_0_15px_rgba(255,255,255,0.1)]">
                        Get Started
                    </a>
                </div>
            </div>
        </div>
    </nav>

    <main class="relative pt-32 pb-20 lg:pt-48 lg:pb-32 overflow-hidden">
        <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-nitro-600/20 rounded-full blur-[120px] -z-10 pointer-events-none"></div>
        
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center relative z-10">
            
            <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-bordercolor bg-white/5 backdrop-blur-sm text-xs font-medium text-gray-300 mb-8 animate-fade-in">
                <span class="flex h-2 w-2 rounded-full bg-nitro-500 animate-pulse"></span>
                Exklusives Community Event
            </div>
            
            <h1 class="text-5xl md:text-7xl font-extrabold text-white tracking-tight mb-6 animate-fade-in" style="animation-delay: 100ms;">
                Die große <br class="hidden md:block">
                <span class="bg-clip-text text-transparent [-webkit-text-fill-color:transparent] box-decoration-clone bg-gradient-to-r from-nitro-400 to-[#b061ff]">
                    Creator Challenge
                </span>
            </h1>
            
            <p class="mt-4 max-w-2xl mx-auto text-lg md:text-xl text-gray-400 mb-10 leading-relaxed animate-fade-in" style="animation-delay: 200ms;">
                Wir suchen die aktivsten deutschen Creator! Erreiche mit uns die <strong class="text-white">150-Member-Marke</strong> auf unserem Discord und sichere dir <span class="text-white font-medium bg-white/10 px-2 py-0.5 rounded">Discord Nitro</span> for free.
            </p>
            
            <div class="flex flex-col sm:flex-row justify-center gap-4 animate-fade-in" style="animation-delay: 300ms;">
                <a href="https://discord.gg/nNT8NnM6py" target="_blank" class="inline-flex justify-center items-center gap-2 bg-[#5865F2] hover:bg-[#4752C4] text-white px-8 py-3.5 rounded-full font-semibold transition-all duration-300 shadow-[0_0_30px_rgba(88,101,242,0.3)] hover:shadow-[0_0_40px_rgba(88,101,242,0.5)] transform hover:-translate-y-1">
                    Server beitreten <i class='bx bxl-discord-alt text-xl'></i>
                </a>
                <a href="#how-it-works" class="inline-flex justify-center items-center gap-2 bg-card border border-bordercolor hover:border-nitro-500/50 text-white px-8 py-3.5 rounded-full font-medium transition-all duration-300">
                    Mehr erfahren
                </a>
            </div>
        </div>
    </main>

    <section class="py-24 border-t border-bordercolor bg-[#0a0a0c] relative z-10">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div class="grid grid-cols-1 lg:grid-cols-12 gap-16 items-center">
                
                <div class="lg:col-span-6 flex flex-col items-center lg:items-start text-center lg:text-left w-full">
                    <h2 class="text-3xl md:text-5xl font-bold text-white mb-6">Road to 150</h2>
                    <p class="text-lg text-gray-400 leading-relaxed mb-10 max-w-lg">
                        Sobald unser Server die magische Grenze von 150 Mitgliedern erreicht hat <strong class="text-white">UND</strong> wir sehen, dass im Chat richtig was los ist, schütten wir die Gewinne aus!
                    </p>
                    
                    <div class="w-full bg-card border border-bordercolor p-8 rounded-3xl hover:border-nitro-500/30 transition-all duration-500 shadow-xl">
                        <div class="flex justify-between text-sm font-bold text-white mb-4 uppercase tracking-widest">
                            <span>Status</span>
                            <span class="text-nitro-400 font-mono" id="progress-text">Lade...</span>
                        </div>
                        <div class="relative w-full h-4 bg-background rounded-full overflow-hidden border border-bordercolor">
                            <div id="progress-bar" class="absolute top-0 left-0 h-full bg-gradient-to-r from-[#5865F2] to-nitro-500 w-[0%] transition-all duration-1000 shadow-[0_0_10px_rgba(244,127,255,0.5)]"></div>
                        </div>
                    </div>
                </div>

                <div class="lg:col-span-6 flex justify-center lg:justify-end w-full py-10">
                    <div class="relative w-full max-w-[380px] animate-float">
                        
                        <div class="absolute -inset-[2px] bg-gradient-to-r from-[#5865F2] to-purple-600 rounded-[2.5rem] blur-xl opacity-30"></div>
                        
                        <div class="relative bg-card border border-bordercolor rounded-[2rem] p-8 shadow-2xl flex flex-col pt-14 items-center text-center">
                            
                            <div class="absolute -top-12 w-24 h-24 rounded-3xl bg-[#5865F2] flex items-center justify-center shadow-[0_0_30px_rgba(88,101,242,0.5)] border-4 border-background transform rotate-3 hover:rotate-0 transition-transform duration-300">
                                <img src="/static/images/favicon.png" alt="Logo" class="w-14 h-14 object-contain filter brightness-0 invert">
                            </div>
                            
                            <h2 class="text-2xl font-extrabold text-white mb-2 tracking-tight">OnYourSite</h2>
                            
                            <div class="flex items-center justify-center gap-4 text-sm font-medium mb-6">
                                <span class="flex items-center gap-1.5 text-gray-400">
                                    <span class="w-2.5 h-2.5 rounded-full bg-gray-500"></span> <span id="total-members">Lade...</span>
                                </span>
                                <span class="flex items-center gap-1.5 text-gray-400">
                                    <span class="w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)] animate-pulse"></span> <span id="online-members">Lade...</span>
                                </span>
                            </div>
                            
                            <div class="w-full space-y-3 mb-8">
                                <div class="h-12 w-full bg-background rounded-xl border border-bordercolor flex items-center px-4 gap-3 relative overflow-hidden">
                                    <div class="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent animate-shimmer"></div>
                                    <div class="w-6 h-6 rounded-full bg-emerald-500/20 flex items-center justify-center shrink-0">
                                        <i class='bx bx-user-plus text-emerald-500 text-xs'></i>
                                    </div>
                                    <div class="h-2 w-24 bg-gray-700 rounded-full"></div>
                                </div>
                                <div class="h-12 w-full bg-background rounded-xl border border-bordercolor flex items-center px-4 gap-3 relative overflow-hidden">
                                    <div class="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent animate-shimmer" style="animation-delay: 1s;"></div>
                                    <div class="w-6 h-6 rounded-full bg-[#5865F2]/20 flex items-center justify-center shrink-0">
                                        <i class='bx bx-message-rounded-dots text-[#5865F2] text-xs'></i>
                                    </div>
                                    <div class="h-2 w-32 bg-gray-700 rounded-full"></div>
                                </div>
                            </div>

                            <a href="https://discord.gg/nNT8NnM6py" target="_blank" class="w-full block text-center bg-[#5865F2] hover:bg-[#4752C4] text-white py-3.5 rounded-[14px] font-bold text-lg transition-all shadow-[0_0_20px_rgba(88,101,242,0.3)] hover:shadow-[0_0_25px_rgba(88,101,242,0.4)] transform hover:-translate-y-1">
                                Accept Invite
                            </a>
                            <p class="text-xs text-gray-500 mt-4">Opens Discord app or web browser</p>
                        </div>
                    </div>
                </div>

            </div>
        </div>
    </section>

    <section class="py-24 border-t border-bordercolor bg-background relative overflow-hidden">
        <div class="absolute top-0 right-0 w-[600px] h-[600px] bg-brand-500/5 rounded-full blur-[100px] pointer-events-none"></div>
        
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
            <div class="text-center max-w-3xl mx-auto mb-16">
                <h2 class="text-3xl md:text-5xl font-bold text-white mb-4">Die Gewinne</h2>
                <p class="text-lg text-gray-400">Insgesamt vergeben wir <strong class="text-white">10x Discord Nitro</strong> an unsere Community.</p>
            </div>
            
            <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div class="group p-8 rounded-3xl bg-card border border-bordercolor hover:border-nitro-500/50 transition-all duration-500 hover:-translate-y-1 flex flex-col items-center text-center relative overflow-hidden">
                    <div class="absolute top-0 inset-x-0 h-1 bg-gradient-to-r from-nitro-400 to-brand-500 opacity-0 group-hover:opacity-100 transition-opacity"></div>
                    <div class="w-16 h-16 rounded-2xl bg-nitro-500/10 border border-nitro-500/30 flex items-center justify-center mb-6 text-nitro-400 shadow-[0_0_15px_rgba(244,127,255,0.2)]">
                        <i class='bx bxl-discord text-4xl'></i>
                    </div>
                    <div class="text-nitro-400 font-bold uppercase tracking-widest text-[10px] mb-3">Hauptgewinn (1x)</div>
                    <h3 class="text-2xl font-bold text-white mb-1">3 Monate Nitro</h3>
                    <p class="text-sm font-medium text-gray-500 line-through mb-4">Wert: ~30,00€</p>
                    <p class="text-gray-400 text-sm leading-relaxed">Für den absolut aktivsten und hilfreichsten Creator in unserem Discord-Chat.</p>
                </div>

                <div class="group p-8 rounded-3xl bg-card border border-bordercolor hover:border-[#5865F2]/50 transition-all duration-500 hover:-translate-y-1 flex flex-col items-center text-center relative overflow-hidden">
                    <div class="absolute top-0 inset-x-0 h-1 bg-[#5865F2] opacity-0 group-hover:opacity-100 transition-opacity"></div>
                    <div class="w-16 h-16 rounded-2xl bg-[#5865F2]/10 border border-[#5865F2]/30 flex items-center justify-center mb-6 text-[#5865F2] shadow-[0_0_15px_rgba(88,101,242,0.2)]">
                        <i class='bx bxl-discord text-4xl'></i>
                    </div>
                    <div class="text-[#5865F2] font-bold uppercase tracking-widest text-[10px] mb-3">Premium (3x)</div>
                    <h3 class="text-2xl font-bold text-white mb-1">1 Monat Nitro</h3>
                    <p class="text-sm font-medium text-gray-500 line-through mb-4">Wert: 9,99€</p>
                    <p class="text-gray-400 text-sm leading-relaxed">Wird unter allen aktiven Mitgliedern auf dem Server komplett zufällig verlost.</p>
                </div>

                <div class="group p-8 rounded-3xl bg-card border border-bordercolor hover:border-cyan-400/50 transition-all duration-500 hover:-translate-y-1 flex flex-col items-center text-center relative overflow-hidden">
                    <div class="absolute top-0 inset-x-0 h-1 bg-cyan-400 opacity-0 group-hover:opacity-100 transition-opacity"></div>
                    <div class="w-16 h-16 rounded-2xl bg-cyan-400/10 border border-cyan-400/30 flex items-center justify-center mb-6 text-cyan-400 shadow-[0_0_15px_rgba(34,211,238,0.2)]">
                        <i class='bx bxl-discord text-4xl'></i>
                    </div>
                    <div class="text-cyan-400 font-bold uppercase tracking-widest text-[10px] mb-3">Basic (6x)</div>
                    <h3 class="text-2xl font-bold text-white mb-1">Nitro Basic</h3>
                    <p class="text-sm font-medium text-gray-500 line-through mb-4">Wert: 2,99€</p>
                    <p class="text-gray-400 text-sm leading-relaxed">Der Trostpreis! Perfekt für Custom Emojis und größere Uploads überall auf Discord.</p>
                </div>
            </div>
        </div>
    </section>

    <section id="how-it-works" class="py-24 border-t border-bordercolor bg-[#0a0a0c] relative overflow-hidden">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
            <div class="text-center max-w-3xl mx-auto mb-16">
                <h2 class="text-3xl md:text-5xl font-bold text-white mb-4">So bist du dabei</h2>
                <p class="text-lg text-gray-400">Erfülle diese drei simplen Schritte, um am Giveaway teilzunehmen.</p>
            </div>
            
            <div class="grid grid-cols-1 md:grid-cols-3 gap-12 text-center relative">
                <div class="hidden md:block absolute top-10 left-[20%] right-[20%] h-0.5 bg-gradient-to-r from-transparent via-brand-500/50 to-transparent -z-10"></div>

                <div>
                    <div class="w-20 h-20 mx-auto bg-card border border-bordercolor rounded-full flex items-center justify-center text-2xl font-bold text-brand-400 mb-6 shadow-[0_0_20px_rgba(99,102,241,0.2)]">1</div>
                    <h4 class="text-xl font-bold text-white mb-2">Tritt dem Discord bei</h4>
                    <p class="text-gray-400 text-sm leading-relaxed px-4">Verbinde deinen Account im Dashboard oder klicke auf den Invite-Link.</p>
                </div>
                <div>
                    <div class="w-20 h-20 mx-auto bg-card border border-bordercolor rounded-full flex items-center justify-center text-2xl font-bold text-brand-400 mb-6 shadow-[0_0_20px_rgba(99,102,241,0.2)]">2</div>
                    <h4 class="text-xl font-bold text-white mb-2">Bewerbe die Plattform</h4>
                    <p class="text-gray-400 text-sm leading-relaxed px-4">Zeig deinen <span class="bg-white/10 px-2 py-0.5 rounded text-white">.on-your.site</span> Link auf Social Media oder lade Freunde ein.</p>
                </div>
                <div>
                    <div class="w-20 h-20 mx-auto bg-brand-500 border border-brand-400 rounded-full flex items-center justify-center text-2xl font-bold text-white mb-6 shadow-[0_0_30px_rgba(99,102,241,0.5)]">3</div>
                    <h4 class="text-xl font-bold text-white mb-2">Sei aktiv im Chat</h4>
                    <p class="text-gray-400 text-sm leading-relaxed px-4">Zeig deine Designs, hilf anderen und chatte mit uns. Wer auffällt, gewinnt!</p>
                </div>
            </div>
        </div>
    </section>

    <section class="py-24 border-t border-bordercolor bg-background relative overflow-hidden">
        <div class="absolute inset-0 bg-brand-500/5 pointer-events-none"></div>
        <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center relative z-10">
            <h2 class="text-3xl md:text-5xl font-extrabold text-white mb-6">Bereit, die Community zu rocken?</h2>
            <p class="text-lg text-gray-400 mb-10">Werde Teil des Servers und sichere dir die Chance auf fette Nitro Preise. Die Aktion läuft nur, bis das Ziel erreicht ist.</p>
            <a href="https://discord.gg/nNT8NnM6py" target="_blank" class="inline-flex justify-center items-center gap-2 bg-white text-black hover:bg-gray-200 px-10 py-4 rounded-full font-bold transition-all duration-300 transform hover:scale-105 shadow-xl text-lg">
                Jetzt Mitmachen <i class='bx bx-right-arrow-alt text-2xl'></i>
            </a>
        </div>
    </section>

    <footer class="border-t border-bordercolor bg-[#050505] py-12 mt-auto relative z-10">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col items-center">
            <div class="flex space-x-6 mb-8">
                <a href="#" class="w-12 h-12 rounded-full bg-card border border-bordercolor flex items-center justify-center text-gray-400 hover:text-white hover:border-brand-500 transition-all duration-300"><i class='bx bxl-twitter text-2xl'></i></a>
                <a href="https://discord.gg/nNT8NnM6py" target="_blank" class="w-12 h-12 rounded-full bg-card border border-bordercolor flex items-center justify-center text-gray-400 hover:text-[#5865F2] hover:border-[#5865F2] transition-all duration-300"><i class='bx bxl-discord-alt text-2xl'></i></a>
                <a href="#" class="w-12 h-12 rounded-full bg-card border border-bordercolor flex items-center justify-center text-gray-400 hover:text-white hover:border-white transition-all duration-300"><i class='bx bxl-github text-2xl'></i></a>
            </div>
            
            <div class="flex items-center gap-4 mb-6 text-sm text-gray-500 font-medium">
                <a href="/imprint" class="hover:text-white transition-colors">Legal Notice</a><span>&bull;</span>
                <a href="/privacy" class="hover:text-white transition-colors">Privacy Policy</a><span>&bull;</span>
                <a href="/terms" class="hover:text-white transition-colors">Terms of Service</a>
            </div>
            <p class="text-gray-600 text-sm text-center">
                &copy; <?php echo date("Y"); ?> OnYourSite DE. Diese Aktion steht in keiner Verbindung zu Discord Inc.
            </p>
        </div>
    </footer>

    <script>
        document.addEventListener("DOMContentLoaded", () => {
            const inviteCode = "nNT8NnM6py"; 
            const serverId = "1482819373717655653"; 

            // 1. Echte Anzahl der Mitglieder abfragen
            fetch(`https://discord.com/api/v9/invites/${inviteCode}?with_counts=true`)
                .then(res => res.json())
                .then(data => {
                    if(data.approximate_member_count) {
                        const total = data.approximate_member_count;
                        document.getElementById('total-members').textContent = `${total} Members`;
                        
                        let percentage = (total / 150) * 100;
                        if(percentage > 100) percentage = 100;
                        
                        document.getElementById('progress-bar').style.width = `${percentage}%`;
                        document.getElementById('progress-text').textContent = `${total} / 150`;
                    }
                }).catch(err => {
                    document.getElementById('total-members').textContent = `Offline`;
                    console.error(err);
                });

            // 2. Echte Online-User abfragen
            fetch(`https://discord.com/api/guilds/${serverId}/widget.json`)
                .then(res => {
                    if (!res.ok) throw new Error("Widget API disabled");
                    return res.json();
                })
                .then(data => {
                    document.getElementById('online-members').textContent = `${data.presence_count} Online`;
                })
                .catch(err => {
                    document.getElementById('online-members').textContent = "Offline";
                });
        });
    </script>
</body>
</html>