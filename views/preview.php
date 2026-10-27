<div id="previewPaneWrapper" class="hidden xl:flex w-[400px] border-l border-bordercolor bg-card items-center justify-center p-8 shrink-0 relative transition-all duration-300">
    
    <div id="phonePreview" class="w-[300px] h-[620px] border-[8px] border-[#1f1f22] rounded-[2.5rem] bg-black relative shadow-2xl overflow-hidden flex flex-col items-center py-10 px-5 transition-all duration-500 custom-scrollbar overflow-y-auto">
        
        <div id="phoneBgLayer" class="absolute inset-0 z-0 pointer-events-none transition-all duration-500 opacity-50 mix-blend-overlay" style="<?php echo !empty($user_data['bg_image']) ? 'background-image: url(\'/static/uploads/'.htmlspecialchars($user_data['bg_image']).'\'); background-size: cover; background-position: center;' : ''; ?>"></div>
        
        <div class="absolute top-0 inset-x-0 h-5 bg-[#1f1f22] rounded-b-2xl w-1/2 mx-auto z-20"></div>
        
        <div id="previewHeaderCard" class="w-full flex flex-col items-center z-10 transition-all duration-300">
            
            <div id="previewImgContainer" class="w-20 h-20 rounded-full bg-white/10 backdrop-blur-md border border-white/20 mb-3 flex items-center justify-center mt-3 shrink-0 z-10 overflow-hidden shadow-lg transition-all duration-300">
                <?php if(!empty($user_data['profile_image'])): ?>
                    <img src="/static/uploads/<?php echo htmlspecialchars($user_data['profile_image']); ?>" class="w-full h-full object-cover">
                <?php else: ?>
                    <i class='bx bx-user text-3xl opacity-50 text-white'></i>
                <?php endif; ?>
            </div>

            <h3 id="previewName" class="font-bold text-base mb-1 z-10 text-center drop-shadow-md text-white transition-colors"><?php echo htmlspecialchars($user_data['full_name'] ?? 'Your Name'); ?></h3>
            
            <h4 id="previewProfession" class="text-[10px] font-semibold uppercase tracking-widest text-white/60 mb-2 z-10 hidden transition-all duration-300"><?php echo htmlspecialchars($user_data['profession'] ?? 'YOUR PROFESSION'); ?></h4>

            <p id="previewBio" class="text-xs text-center mb-6 z-10 drop-shadow-md text-gray-300 px-2 transition-colors"><?php echo nl2br(htmlspecialchars($user_data['bio'] ?? 'Your bio will appear here.')); ?></p>
            
        </div>

        <div id="previewPremiumButtons" class="w-full flex flex-col gap-2 mb-4 z-10 transition-all duration-300 <?php echo (!empty($user_data['booking_url']) || !empty($user_data['cv_file'])) ? 'flex' : 'hidden'; ?>">
            <?php if(!empty($user_data['booking_url'])): ?>
                <div class="w-full py-2.5 px-4 bg-brand-500 text-white rounded-lg text-xs font-bold flex items-center justify-center gap-1 shadow-md">
                    <i class='bx bx-calendar-event text-sm'></i> Book a Meeting
                </div>
            <?php endif; ?>
            
            <?php if(!empty($user_data['cv_file'])): ?>
                <div class="w-full py-2.5 px-4 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 rounded-lg text-xs font-bold flex items-center justify-center gap-1">
                    <i class='bx bx-download text-sm'></i> Download File
                </div>
            <?php endif; ?>
        </div>
        
        <div id="previewDetailedBioWrapper" class="w-full bg-white/5 backdrop-blur-md border border-white/10 rounded-xl p-4 mb-4 z-10 hidden transition-all duration-300">
            <h5 id="previewDetailedBioTitle" class="font-bold text-xs mb-2 border-b border-white/20 pb-1 flex items-center gap-1 text-white"><i class='bx bx-book-open'></i> About Me</h5>
            <p id="previewDetailedBio" class="text-gray-300 text-[10px] leading-relaxed"><?php echo nl2br(htmlspecialchars($user_data['detailed_bio'] ?? 'Your detailed story goes here...')); ?></p>
        </div>

        <div class="w-full space-y-2.5 z-10 overflow-visible pr-1 pb-4 flex-1" id="previewLinksContainer">
            </div>
        
    </div>
</div>

<script>
    // JS Logic um das CSS der Profile auf das Preview Handy zu spiegeln.
    window.addEventListener('load', () => {
        // Wir fangen die updateThemePreview von der dashboard.php ab und hängen uns dran.
        if (typeof window.originalUpdateThemePreview === 'undefined' && typeof window.updateThemePreview === 'function') {
            window.originalUpdateThemePreview = window.updateThemePreview;
            
            window.updateThemePreview = function(themeValue) {
                // Das Original-Script für Layout, Colors, Container aufrufen
                window.originalUpdateThemePreview(themeValue);
                
                const headerCard = document.getElementById('previewHeaderCard');
                const detBioWrap = document.getElementById('previewDetailedBioWrapper');
                const bgLayer = document.getElementById('phoneBgLayer');
                const premiumBtns = document.getElementById('previewPremiumButtons');
                
                // Hintergrund-Opazität an Theme anpassen (Glass und Minimal brauchen weniger Overlay)
                if (themeValue === 'glass' || themeValue === 'minimal') {
                    bgLayer.className = "absolute inset-0 z-0 pointer-events-none transition-all duration-500 opacity-30";
                } else {
                    bgLayer.className = "absolute inset-0 z-0 pointer-events-none transition-all duration-500 opacity-50 mix-blend-overlay";
                }

                // Layout-Spezifische Header Anpassungen
                if(window.currentLayout !== 'link-tree') {
                    // Falls es nicht Link-Tree ist, machen wir die Header Card auch zu so einer "Box" wie das About-Me Feld
                    if (detBioWrap) {
                        headerCard.className = detBioWrap.className.replace('hidden', '') + " flex flex-col items-center p-5 mb-4";
                    }
                    const bioEl = document.getElementById('previewBio');
                    if (bioEl) bioEl.className = bioEl.className.replace('mb-6', 'mb-2');
                    
                    // Premium Buttons ans Ende der Header Card schieben (Simulation der Split/Bento View)
                    if(premiumBtns && premiumBtns.parentElement !== headerCard) {
                        headerCard.appendChild(premiumBtns);
                        premiumBtns.className = premiumBtns.className.replace('mb-4', 'mt-4');
                    }
                } else {
                    headerCard.className = "w-full flex flex-col items-center z-10 transition-all duration-300";
                    const bioEl = document.getElementById('previewBio');
                    if (bioEl) bioEl.className = bioEl.className.replace('mb-2', 'mb-6');
                    
                    // Premium Buttons unter den Header (Simulation Link-Tree)
                    if(premiumBtns && premiumBtns.parentElement === headerCard) {
                        headerCard.parentNode.insertBefore(premiumBtns, headerCard.nextSibling);
                        premiumBtns.className = premiumBtns.className.replace('mt-4', 'mb-4');
                    }
                }
            };
            
            // Initial call to set correct layout/theme
            const currentTheme = document.querySelector('input[name="theme"]:checked');
            if(currentTheme) window.updateThemePreview(currentTheme.value);
        }
        
        // Input Listener für Booking URL, um Button live einzublenden
        const bookingInput = document.querySelector('input[name="booking_url"]');
        if(bookingInput) {
            bookingInput.addEventListener('input', (e) => {
                const premiumContainer = document.getElementById('previewPremiumButtons');
                const hasValue = e.target.value.trim().length > 0;
                // Sehr rudimentäre Live-Preview (Echte Vorschau passiert erst nach dem Speichern für Dateien)
                if(premiumContainer) {
                    if (hasValue) premiumContainer.classList.remove('hidden');
                }
            });
        }
    });
</script>