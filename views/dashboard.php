<?php
// --- IMPERSONATION CHECK ---
$is_impersonating = isset($_SESSION['original_admin_id']);
$has_premium_access = ($user_data['is_admin'] || $is_impersonating);

// --- 30-TAGE COOLDOWN LOGIK ---
$last_change_str = $user_data['last_subdomain_change'] ?? date('Y-m-d H:i:s', strtotime('-31 days'));
$last_change_time = strtotime($last_change_str);
$days_since_change = floor((time() - $last_change_time) / (60 * 60 * 24));
$days_to_wait = max(0, 30 - $days_since_change);
$can_change_subdomain = ($days_to_wait === 0);

// --- LAYOUT COOLDOWN LOGIK ---
$layout = $user_data['layout_type'] ?? null;
$last_layout_time = strtotime($user_data['last_layout_change'] ?? '0');
$now = time();
$time_since_layout_change = $now - $last_layout_time;

$grace_period = 10 * 60; // 10 Min
$cooldown_period = 20 * 60; // 20 Min
$can_change_layout = false;
$layout_status_msg = "";

if ($is_impersonating || empty($layout)) {
    $can_change_layout = true;
    if ($is_impersonating && !empty($layout)) $layout_status_msg = "<span class='text-brand-400'><i class='bx bx-mask'></i> Admin Override: Cooldown disabled.</span>";
} elseif ($time_since_layout_change <= $grace_period) {
    $can_change_layout = true;
    $mins_left = ceil(($grace_period - $time_since_layout_change) / 60);
    $layout_status_msg = "<span class='text-emerald-400'><i class='bx bx-check-circle'></i> Free switch active! You have $mins_left min to test layouts.</span>";
} elseif ($time_since_layout_change >= $cooldown_period) {
    $can_change_layout = true;
    $layout_status_msg = "<span class='text-gray-400'>You can change your layout mode now.</span>";
} else {
    $hours_left = ceil(($cooldown_period - $time_since_layout_change) / 3600);
    $layout_status_msg = "<span class='text-red-400'><i class='bx bx-time'></i> Cooldown active. Switch again in $hours_left hours.</span>";
}

$layout_type = $layout ?? 'link-tree'; 
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Dashboard | OnYourSite</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <link href='https://unpkg.com/boxicons@2.1.4/css/boxicons.min.css' rel='stylesheet'>
    <link rel="icon" type="image/png" href="/static/images/favicon.png">
    
    <script src="https://cdn.jsdelivr.net/npm/sortablejs@latest/Sortable.min.js"></script>
    <script src="https://cdn.tailwindcss.com"></script>
    
    <script>
        tailwind.config = { theme: { extend: { fontFamily: { sans: ['Inter', 'sans-serif'], }, colors: { background: '#000000', card: '#0a0a0a', inputbg: '#121212', bordercolor: '#27272a', brand: { 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5', } } } } }
    </script>
    <style>
        .custom-scrollbar::-webkit-scrollbar { width: 5px; } .custom-scrollbar::-webkit-scrollbar-track { background: transparent; } .custom-scrollbar::-webkit-scrollbar-thumb { background: #27272a; border-radius: 10px; } .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #3f3f46; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(-5px); } to { opacity: 1; transform: translateY(0); } }
        .animate-fade-in { animation: fadeIn 0.2s ease forwards; } .force-hide { display: none !important; } .preview-link-anim { transition: all 0.3s ease; }
        .drag-handle { cursor: grab; } .drag-handle:active { cursor: grabbing; } .sortable-ghost { opacity: 0.4; }
    </style>
</head>
<body class="bg-background text-gray-300 font-sans h-screen flex flex-col overflow-hidden selection:bg-brand-500/30">

    <?php if($is_impersonating): ?>
    <div class="bg-emerald-500 text-white text-center py-2.5 text-sm font-bold flex items-center justify-center gap-2 shadow-lg relative z-[200] shrink-0 w-full">
        <i class='bx bx-mask text-xl'></i> Admin Mode: Editing as <?php echo htmlspecialchars($user_data['full_name']); ?>
        <a href="/admin_return.php" class="ml-4 bg-white/20 hover:bg-white/30 px-3 py-1 rounded-md transition-colors border border-white/20 flex items-center gap-1 shadow-sm"><i class='bx bx-left-arrow-alt'></i> Return to Admin Panel</a>
    </div>
    <?php endif; ?>

    <div class="flex-1 flex overflow-hidden">
        <?php if(empty($layout)): ?>
        <div id="setupOverlay" class="fixed inset-0 z-[100] bg-black/90 backdrop-blur-md flex flex-col items-center justify-center p-4 overflow-y-auto custom-scrollbar">
            <div class="text-center mb-8 max-w-2xl animate-fade-in mt-10">
                <h1 class="text-4xl font-extrabold text-white mb-4">Choose your Vibe 🚀</h1>
                <p class="text-gray-400 text-lg">Select a layout engine for your page. Don't worry, you can switch back and forth freely for the next 10 minutes to test them out!</p>
            </div>
            <form action="/dashboard" method="POST" class="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-5xl w-full animate-fade-in pb-20" style="animation-delay: 0.2s;">
                <input type="hidden" name="update_action" value="general">
                <button type="submit" name="layout_type" value="link-tree" class="bg-card border border-bordercolor hover:border-brand-500 rounded-3xl p-8 text-left transition-all duration-300 group hover:-translate-y-2 shadow-2xl"><div class="w-14 h-14 bg-brand-500/20 text-brand-400 rounded-2xl flex items-center justify-center text-3xl mb-5 group-hover:scale-110 transition-transform"><i class='bx bx-list-ul'></i></div><h2 class="text-xl font-bold text-white mb-2">Link-in-Bio</h2><p class="text-gray-400 text-sm">Sleek, vertical, and fast. Perfect for Instagram or TikTok bios.</p></button>
                <button type="submit" name="layout_type" value="about-me" class="bg-card border border-bordercolor hover:border-purple-500 rounded-3xl p-8 text-left transition-all duration-300 group hover:-translate-y-2 shadow-2xl"><div class="w-14 h-14 bg-purple-500/20 text-purple-400 rounded-2xl flex items-center justify-center text-3xl mb-5 group-hover:scale-110 transition-transform"><i class='bx bx-layout'></i></div><h2 class="text-xl font-bold text-white mb-2">Split Presentation</h2><p class="text-gray-400 text-sm">A beautiful 2-column magazine layout. Great for personal branding.</p></button>
                <button type="submit" name="layout_type" value="bento-grid" class="bg-card border border-bordercolor hover:border-emerald-500 rounded-3xl p-8 text-left transition-all duration-300 group hover:-translate-y-2 shadow-2xl"><div class="w-14 h-14 bg-emerald-500/20 text-emerald-400 rounded-2xl flex items-center justify-center text-3xl mb-5 group-hover:scale-110 transition-transform"><i class='bx bx-grid-alt'></i></div><h2 class="text-xl font-bold text-white mb-2">Bento Grid</h2><p class="text-gray-400 text-sm">Trendy tile-based design. Highly visual and modern.</p></button>
                <button type="submit" name="layout_type" value="minimal-cv" class="bg-card border border-bordercolor hover:border-rose-500 rounded-3xl p-8 text-left transition-all duration-300 group hover:-translate-y-2 shadow-2xl"><div class="w-14 h-14 bg-rose-500/20 text-rose-400 rounded-2xl flex items-center justify-center text-3xl mb-5 group-hover:scale-110 transition-transform"><i class='bx bx-file-blank'></i></div><h2 class="text-xl font-bold text-white mb-2">Minimal CV</h2><p class="text-gray-400 text-sm">Clean, sharp, text-focused. The ultimate professional developer look.</p></button>
            </form>
        </div>
        <?php endif; ?>

        <aside class="w-20 lg:w-64 border-r border-bordercolor bg-card flex flex-col justify-between py-6 transition-all z-20 shrink-0">
            <div>
                <div class="px-6 mb-8 flex items-center gap-2 cursor-pointer transition-transform hover:scale-105" onclick="window.scrollTo(0,0)">
                    <i class='bx bx-hive text-3xl text-brand-500'></i><span class="font-bold text-xl text-white tracking-tight hidden lg:block">OnYourSite</span>
                </div>
                <div class="px-4 mb-2 hidden lg:block"><p class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Menu</p></div>
                <nav class="space-y-1 px-3">
                    <button type="button" onclick="switchTab('builder')" id="nav-builder" class="nav-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-brand-500/10 text-brand-400 font-medium transition-all"><i class='bx bx-layout text-xl'></i> <span class="hidden lg:block text-sm">Builder</span></button>
                    <button type="button" onclick="switchTab('integrations')" id="nav-integrations" class="nav-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/5 text-gray-400 hover:text-white transition-all"><i class='bx bx-plug text-xl'></i> <span class="hidden lg:block text-sm">Integrations</span></button>
                    <button type="button" onclick="switchTab('analytics')" id="nav-analytics" class="nav-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/5 text-gray-400 hover:text-white transition-all"><i class='bx bx-bar-chart-alt-2 text-xl'></i> <span class="hidden lg:block text-sm">Analytics</span></button>
                    <button type="button" onclick="switchTab('seo')" id="nav-seo" class="nav-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/5 text-gray-400 hover:text-white transition-all"><i class='bx bx-search-alt text-xl'></i> <span class="hidden lg:block text-sm">SEO</span></button>
                    <button type="button" onclick="switchTab('branding')" id="nav-branding" class="nav-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/5 text-gray-400 hover:text-white transition-all"><i class='bx bx-brush text-xl'></i> <span class="hidden lg:block text-sm">Branding</span></button>
                    <button type="button" onclick="switchTab('settings')" id="nav-settings" class="nav-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/5 text-gray-400 hover:text-white transition-all"><i class='bx bx-cog text-xl'></i> <span class="hidden lg:block text-sm">Settings</span></button>
                </nav>
            </div>
            <div class="px-3">
                <a href="/logout" class="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-red-500/10 text-gray-500 hover:text-red-400 transition-colors"><i class='bx bx-log-out text-xl'></i> <span class="hidden lg:block text-sm">Log Out</span></a>
            </div>
        </aside>

        <div class="flex-1 flex flex-col h-full overflow-hidden w-full bg-background relative">
            <header class="h-16 border-b border-bordercolor bg-background/80 backdrop-blur-md flex items-center justify-between px-8 shrink-0 z-10">
                <h1 class="text-lg font-semibold text-white tracking-tight" id="page-title">Profile Builder</h1>
                <div class="flex items-center gap-4">
                    <?php if(!empty($user_data['username'])): ?>
                    <a href="https://<?php echo htmlspecialchars($user_data['username']); ?>.on-your.site" target="_blank" class="text-sm text-gray-400 hover:text-brand-400 hidden sm:flex items-center gap-1.5 transition-colors bg-white/5 px-3 py-1.5 rounded-md border border-bordercolor hover:border-brand-500/30">
                        <?php echo htmlspecialchars($user_data['username']); ?>.on-your.site <i class='bx bx-link-external'></i>
                    </a>
                    <?php endif; ?>
                    <button type="submit" form="mainForm" class="bg-white text-black hover:bg-gray-200 px-5 py-1.5 rounded-md text-sm font-semibold transition-all shadow-sm">Save Changes</button>
                </div>
            </header>

            <?php if(isset($_SESSION['success'])): ?><div class="absolute top-20 left-1/2 -translate-x-1/2 z-50 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-4 py-2 rounded-lg flex items-center gap-2 shadow-lg backdrop-blur-md text-sm font-medium animate-fade-in z-50"><i class='bx bx-check-circle text-lg'></i> <?php echo $_SESSION['success']; unset($_SESSION['success']); ?></div><?php endif; ?>
            <?php if(isset($_SESSION['error'])): ?><div class="absolute top-20 left-1/2 -translate-x-1/2 z-50 bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-2 rounded-lg flex items-center gap-2 shadow-lg backdrop-blur-md text-sm font-medium animate-fade-in z-50"><i class='bx bx-error-circle text-lg'></i> <?php echo $_SESSION['error']; unset($_SESSION['error']); ?></div><?php endif; ?>

            <div class="flex-1 flex overflow-hidden relative">
                <div class="flex-1 overflow-y-auto p-4 md:p-8 custom-scrollbar relative">
                    <form id="mainForm" action="/dashboard" method="POST" enctype="multipart/form-data">
                        <input type="hidden" name="update_action" value="general">
                        
                        <div id="tab-builder" class="tab-content max-w-3xl mx-auto space-y-8 block pb-12">
                            <section>
                                <h2 class="text-base font-semibold text-white mb-4 flex items-center justify-between">
                                    Profile Information 
                                    <span id="modeBadge" class="bg-inputbg border border-bordercolor px-2 py-0.5 rounded text-xs text-gray-400 uppercase tracking-wider">
                                        <?php echo strtoupper(str_replace('-', ' ', $layout_type)); ?>
                                    </span>
                                </h2>
                                <div class="bg-card border border-bordercolor rounded-xl p-6">
                                    <div class="flex items-center gap-6 mb-6 pb-6 border-b border-bordercolor">
                                        <div class="w-16 h-16 rounded-full bg-inputbg border border-bordercolor flex items-center justify-center text-gray-500 overflow-hidden shadow-inner">
                                            <?php if(!empty($user_data['profile_image'])): ?><img src="/static/uploads/<?php echo htmlspecialchars($user_data['profile_image']); ?>" class="w-full h-full object-cover"><?php else: ?><i class='bx bx-user text-2xl'></i><?php endif; ?>
                                        </div>
                                        <div><input type="file" name="profile_image" id="profileUpload" accept="image/*" class="hidden"><label for="profileUpload" class="cursor-pointer px-4 py-2 bg-white/5 hover:bg-white/10 border border-bordercolor rounded-lg text-sm font-medium transition-colors inline-block mb-1 text-white">Upload Avatar</label></div>
                                    </div>
                                    <div class="space-y-5">
                                        <div><label class="block text-sm font-medium text-gray-300 mb-1.5">Display Name</label><input type="text" id="nameInput" name="full_name" value="<?php echo htmlspecialchars($user_data['full_name'] ?? ''); ?>" class="w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm"></div>
                                        <div><label class="block text-sm font-medium text-gray-300 mb-1.5">Short Bio (Top)</label><textarea id="bioInput" name="bio" rows="2" class="w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm resize-none"><?php echo htmlspecialchars($user_data['bio'] ?? ''); ?></textarea></div>

                                        <div id="aboutMeFields" class="<?php echo $layout_type === 'link-tree' ? 'hidden' : ''; ?> space-y-5 border-t border-bordercolor pt-5 mt-5">
                                            <div><label class="block text-sm font-medium text-brand-400 mb-1.5">Profession / Subtitle</label><input type="text" id="professionInput" name="profession" value="<?php echo htmlspecialchars($user_data['profession'] ?? ''); ?>" placeholder="e.g. Web Developer" class="w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm"></div>
                                            <div><label class="block text-sm font-medium text-brand-400 mb-1.5">Detailed "About Me" Text</label><textarea id="detailedBioInput" name="detailed_bio" rows="6" class="w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm resize-y custom-scrollbar"><?php echo htmlspecialchars($user_data['detailed_bio'] ?? ''); ?></textarea></div>
                                        </div>
                                    </div>
                                </div>
                            </section>

                            <section>
                                <div class="flex justify-between items-end mb-4">
                                    <h2 class="text-base font-semibold text-white">Your Links</h2>
                                    <button type="button" onclick="addLinkField()" class="text-white text-sm font-medium flex items-center gap-1 bg-inputbg border border-bordercolor hover:bg-white/5 px-3 py-1.5 rounded-lg transition-colors shadow-sm"><i class='bx bx-plus'></i> Add Link</button>
                                </div>
                                <div class="bg-card border border-bordercolor rounded-xl p-4">
                                    <div id="linksContainer" class="space-y-3">
                                        <?php if(!empty($user_links)): ?>
                                            <?php foreach($user_links as $link): ?>
                                                <div class="link-item bg-inputbg p-3 rounded-lg border border-bordercolor flex items-center gap-3 relative group">
                                                    <div class="shrink-0 drag-handle text-gray-600 px-1 hidden md:block hover:text-white"><i class='bx bx-grid-vertical text-xl'></i></div>
                                                    <div class="shrink-0 flex justify-center items-center">
                                                        <input type="hidden" name="link_ids[]" value="<?php echo $link['id']; ?>">
                                                        <input type="hidden" name="link_icons[]" value="<?php echo htmlspecialchars($link['icon_class'] ?? ''); ?>">
                                                        <button type="button" onclick="openIconPicker(this)" class="w-10 h-10 rounded-md bg-card border border-bordercolor hover:border-brand-500 flex items-center justify-center text-white hover:text-brand-400"><i class="<?php echo !empty($link['icon_class']) ? htmlspecialchars($link['icon_class']) : 'bx bx-image-alt'; ?> text-xl picker-icon-preview"></i></button>
                                                    </div>
                                                    <div class="flex-1 flex flex-col md:flex-row gap-2">
                                                        <input type="text" name="link_titles[]" value="<?php echo htmlspecialchars($link['title']); ?>" placeholder="Title" oninput="updateLivePreviewLinks()" class="title-input w-full md:w-1/3 bg-transparent text-white font-medium focus:outline-none text-sm">
                                                        <input type="url" name="link_urls[]" value="<?php echo htmlspecialchars($link['url']); ?>" oninput="formatUrlInput(this); updateLivePreviewLinks()" placeholder="https:// or mailto:you@email.com" class="url-input w-full flex-1 bg-transparent text-gray-400 focus:outline-none text-sm">
                                                    </div>
                                                    <button type="button" onclick="this.closest('.link-item').remove(); updateLivePreviewLinks();" class="text-gray-500 hover:text-red-400 p-2 rounded-md"><i class='bx bx-trash text-lg'></i></button>
                                                </div>
                                            <?php endforeach; ?>
                                        <?php endif; ?>
                                    </div>
                                    <p class="text-[10px] text-gray-500 text-center mt-4 hidden md:block"><i class='bx bx-info-circle'></i> Drag the handles on the left to reorder your links. You can also use "mailto:name@mail.com".</p>
                                </div>
                            </section>

                            <section>
                                <h2 class="text-base font-semibold text-white mb-4">Appearance</h2>
                                <div class="bg-card border border-bordercolor rounded-xl p-6 space-y-6">
                                    <div>
                                        <label class="block text-sm font-medium text-gray-300 mb-2">Background Image (Overrides Theme)</label>
                                        <div class="flex flex-col sm:flex-row sm:items-center gap-4">
                                            <input type="file" name="bg_image" id="bgUpload" accept="image/*" class="hidden">
                                            <label for="bgUpload" class="cursor-pointer flex items-center justify-center gap-2 px-4 py-2 bg-inputbg hover:bg-white/5 rounded-lg text-sm font-medium transition-colors border border-bordercolor text-white shadow-sm w-fit"><i class='bx bx-upload text-lg text-gray-400'></i> Upload Background</label>
                                            <?php if(!empty($user_data['bg_image'])): ?>
                                            <label class="flex items-center gap-2 text-sm text-red-400 hover:text-red-300 cursor-pointer bg-red-500/10 px-3 py-2 rounded-lg border border-red-500/20 w-fit transition-colors">
                                                <input type="checkbox" name="delete_bg_image" value="1" class="w-4 h-4 rounded border-red-500 bg-black text-red-500 focus:ring-red-500"> Delete existing
                                            </label>
                                            <?php endif; ?>
                                        </div>
                                    </div>
                                    <hr class="border-bordercolor">
                                    <div>
                                        <label class="block text-sm font-medium text-gray-300 mb-3">Base Theme</label>
                                        <div class="grid grid-cols-3 sm:grid-cols-5 gap-3">
                                            <?php
                                            $themes = [
                                                'deep-dark' => ['name' => 'Dark', 'style' => 'bg-[#09090b]'],
                                                'midnight' => ['name' => 'Midnight', 'style' => 'bg-gradient-to-br from-indigo-500 to-purple-600'],
                                                'glass' => ['name' => 'Glass', 'style' => 'bg-gradient-to-tr from-gray-200 to-gray-300'],
                                                'cyberpunk' => ['name' => 'Cyber', 'style' => 'bg-[#fcee0a] border-b-4 border-r-4 border-black'],
                                                'forest' => ['name' => 'Forest', 'style' => 'bg-gradient-to-br from-emerald-500 to-teal-700'],
                                                'sunset' => ['name' => 'Sunset', 'style' => 'bg-gradient-to-br from-rose-500 to-orange-500'],
                                                'ocean' => ['name' => 'Ocean', 'style' => 'bg-gradient-to-t from-blue-700 to-cyan-500'],
                                                'cherry' => ['name' => 'Cherry', 'style' => 'bg-gradient-to-r from-pink-500 to-rose-400'],
                                                'hacker' => ['name' => 'Hacker', 'style' => 'bg-black border border-green-500'],
                                                'minimal' => ['name' => 'Minimal', 'style' => 'bg-white border border-gray-200']
                                            ];
                                            $current = $user_data['theme'] ?: 'deep-dark';
                                            foreach($themes as $val => $t):
                                                $checked = ($current === $val) ? 'checked' : '';
                                            ?>
                                            <label class="cursor-pointer group relative">
                                                <input type="radio" name="theme" value="<?php echo $val; ?>" class="peer sr-only" <?php echo $checked; ?>>
                                                <div class="h-16 rounded-lg <?php echo $t['style']; ?> border-2 border-transparent peer-checked:border-white mb-1.5 transition-all shadow-sm ring-1 ring-bordercolor peer-checked:ring-0"></div>
                                                <p class="text-[11px] text-center text-gray-500 peer-checked:text-white font-medium uppercase tracking-wide"><?php echo $t['name']; ?></p>
                                            </label>
                                            <?php endforeach; ?>
                                        </div>
                                    </div>
                                </div>
                            </section>
                        </div>

                        <?php include 'views/tab_integrations.php'; ?>

                        <div id="tab-analytics" class="tab-content max-w-3xl mx-auto space-y-6 hidden pb-12">
                            <h2 class="text-xl font-bold text-white mb-6">Profile Analytics</h2>
                            <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
                                <div class="bg-card border border-bordercolor rounded-xl p-6 flex flex-col items-center justify-center text-center shadow-lg relative overflow-hidden">
                                    <div class="absolute inset-0 bg-brand-500/5"></div>
                                    <i class='bx bx-show text-4xl text-brand-400 mb-3 relative z-10'></i>
                                    <h3 class="text-4xl font-black text-white relative z-10"><?php echo number_format($user_data['profile_views'] ?? 0); ?></h3>
                                    <p class="text-gray-400 text-sm font-medium mt-1 relative z-10">Total Profile Views</p>
                                </div>
                                <div class="bg-card border border-bordercolor rounded-xl p-6 flex flex-col items-center justify-center text-center shadow-lg relative overflow-hidden">
                                    <div class="absolute inset-0 bg-purple-500/5"></div>
                                    <i class='bx bx-mouse text-4xl text-purple-400 mb-3 relative z-10'></i>
                                    <?php $total_clicks = 0; foreach($user_links as $l) $total_clicks += $l['clicks']; ?>
                                    <h3 class="text-4xl font-black text-white relative z-10"><?php echo number_format($total_clicks); ?></h3>
                                    <p class="text-gray-400 text-sm font-medium mt-1 relative z-10">Total Link Clicks</p>
                                </div>
                            </div>
                            <h3 class="text-lg font-semibold text-white mb-4">Clicks per Link</h3>
                            <div class="bg-card border border-bordercolor rounded-xl overflow-hidden shadow-lg">
                                <?php if(empty($user_links)): ?>
                                    <div class="p-6 text-center text-gray-500 text-sm">No links added yet.</div>
                                <?php else: ?>
                                    <table class="w-full text-left">
                                        <thead>
                                            <tr class="bg-inputbg/50 border-b border-bordercolor text-xs uppercase text-gray-500 tracking-wider">
                                                <th class="px-6 py-4 font-semibold">Link Title</th>
                                                <th class="px-6 py-4 font-semibold text-right">Clicks</th>
                                            </tr>
                                        </thead>
                                        <tbody class="divide-y divide-bordercolor">
                                            <?php foreach($user_links as $link): ?>
                                            <tr class="hover:bg-white/5 transition-colors">
                                                <td class="px-6 py-4">
                                                    <div class="flex items-center gap-3">
                                                        <i class="<?php echo htmlspecialchars($link['icon_class']); ?> text-xl text-gray-400"></i>
                                                        <span class="text-white font-medium text-sm"><?php echo htmlspecialchars($link['title']); ?></span>
                                                    </div>
                                                </td>
                                                <td class="px-6 py-4 text-right">
                                                    <span class="inline-flex items-center gap-1.5 bg-brand-500/10 text-brand-400 border border-brand-500/20 px-3 py-1 rounded-full font-bold text-sm">
                                                        <?php echo number_format($link['clicks']); ?> <i class='bx bx-mouse-alt'></i>
                                                    </span>
                                                </td>
                                            </tr>
                                            <?php endforeach; ?>
                                        </tbody>
                                    </table>
                                <?php endif; ?>
                            </div>
                        </div>

                        <div id="tab-seo" class="tab-content max-w-3xl mx-auto space-y-6 hidden pb-12">
                            <section>
                                <h2 class="text-base font-semibold text-white mb-4">Search Engine Optimization</h2>
                                <div class="bg-card border border-bordercolor rounded-xl p-6 space-y-5">
                                    <div><label class="block text-sm font-medium text-gray-300 mb-1.5">Meta Title</label><input type="text" name="seo_title" value="<?php echo htmlspecialchars($user_data['seo_title'] ?? ''); ?>" placeholder="Default: Your Name" class="w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm"></div>
                                    <div><label class="block text-sm font-medium text-gray-300 mb-1.5">Meta Description</label><textarea name="seo_description" rows="3" class="w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm resize-none"><?php echo htmlspecialchars($user_data['seo_description'] ?? ''); ?></textarea></div>
                                    <div><label class="block text-sm font-medium text-gray-300 mb-1.5">Keywords</label><input type="text" name="seo_keywords" value="<?php echo htmlspecialchars($user_data['seo_keywords'] ?? ''); ?>" placeholder="comma, separated, tags" class="w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm"></div>
                                </div>
                            </section>
                        </div>

                        <div id="tab-branding" class="tab-content max-w-3xl mx-auto space-y-6 hidden pb-12">
                            <section>
                                <h2 class="text-base font-semibold text-white mb-4">White Label</h2>
                                <div class="bg-card border border-bordercolor rounded-xl p-6 flex items-center justify-between">
                                    <div>
                                        <h3 class="text-sm font-medium text-white flex items-center gap-2">Hide OnYourSite Branding <?php if(!$has_premium_access): ?><span class="bg-brand-500/20 text-brand-400 text-[10px] uppercase font-bold px-2 py-0.5 rounded flex items-center gap-1"><i class='bx bxs-lock'></i> Premium</span><?php endif; ?></h3>
                                        <p class="text-xs text-gray-500 mt-1">Remove the powered-by badge from your profile footer.</p>
                                    </div>
                                    <?php if($has_premium_access): ?>
                                        <label class="relative inline-flex items-center cursor-pointer">
                                            <input type="checkbox" name="hide_branding" value="1" class="sr-only peer" <?php echo ($user_data['hide_branding']) ? 'checked' : ''; ?>>
                                            <div class="w-11 h-6 bg-inputbg peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-gray-400 peer-checked:after:bg-white after:border-bordercolor after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-white border border-bordercolor"></div>
                                        </label>
                                    <?php else: ?>
                                        <label class="relative inline-flex items-center opacity-50 cursor-not-allowed">
                                            <input type="checkbox" disabled class="sr-only peer" <?php echo ($user_data['hide_branding']) ? 'checked' : ''; ?>>
                                            <div class="w-11 h-6 bg-inputbg rounded-full peer after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-gray-400 after:border-bordercolor after:border after:rounded-full after:h-5 after:w-5 border border-bordercolor"></div>
                                        </label>
                                    <?php endif; ?>
                                </div>
                            </section>
                            <section>
                                <h2 class="text-base font-semibold text-white mb-4 flex items-center gap-2"><i class='bx bx-code-alt text-brand-400'></i> Custom CSS</h2>
                                <div class="bg-card border border-bordercolor rounded-xl overflow-hidden focus-within:ring-1 focus-within:ring-brand-500 transition-all">
                                    <div class="bg-inputbg px-4 py-2 border-b border-bordercolor flex gap-1.5">
                                        <div class="w-3 h-3 rounded-full bg-red-500/20 border border-red-500/50"></div>
                                        <div class="w-3 h-3 rounded-full bg-yellow-500/20 border border-yellow-500/50"></div>
                                        <div class="w-3 h-3 rounded-full bg-green-500/20 border border-green-500/50"></div>
                                    </div>
                                    <textarea name="custom_css" rows="6" class="w-full bg-black p-4 text-brand-400 font-mono text-sm focus:outline-none resize-y min-h-[150px] custom-scrollbar" placeholder="/* Inject your CSS here */"><?php echo htmlspecialchars($user_data['custom_css'] ?? ''); ?></textarea>
                                </div>
                            </section>
                        </div>

                        <div id="tab-settings-main" class="tab-content max-w-3xl mx-auto space-y-8 hidden pb-12">
                            <section>
                                <h2 class="text-base font-semibold text-white mb-4">Layout Engine</h2>
                                <div class="bg-card border border-bordercolor rounded-xl p-6 space-y-4">
                                    <p class="text-sm font-medium"><?php echo $layout_status_msg; ?></p>
                                    
                                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                        <label class="cursor-pointer group <?php echo !$can_change_layout ? 'opacity-50 pointer-events-none' : ''; ?>">
                                            <input type="radio" name="layout_type" value="link-tree" class="peer sr-only" <?php echo ($layout_type === 'link-tree') ? 'checked' : ''; ?> onchange="toggleLayoutMode(this.value)">
                                            <div class="bg-inputbg border-2 border-bordercolor peer-checked:border-brand-500 rounded-xl p-4 flex gap-4 transition-all">
                                                <div class="w-10 h-10 bg-card rounded-lg flex items-center justify-center text-brand-400 shrink-0"><i class='bx bx-list-ul text-xl'></i></div>
                                                <div><h3 class="text-white font-bold text-sm mb-1">Link-Tree</h3><p class="text-gray-500 text-[11px]">Classic vertical layout.</p></div>
                                            </div>
                                        </label>
                                        <label class="cursor-pointer group <?php echo !$can_change_layout ? 'opacity-50 pointer-events-none' : ''; ?>">
                                            <input type="radio" name="layout_type" value="about-me" class="peer sr-only" <?php echo ($layout_type === 'about-me') ? 'checked' : ''; ?> onchange="toggleLayoutMode(this.value)">
                                            <div class="bg-inputbg border-2 border-bordercolor peer-checked:border-purple-500 rounded-xl p-4 flex gap-4 transition-all">
                                                <div class="w-10 h-10 bg-card rounded-lg flex items-center justify-center text-purple-400 shrink-0"><i class='bx bx-layout text-xl'></i></div>
                                                <div><h3 class="text-white font-bold text-sm mb-1">About-Me Split</h3><p class="text-gray-500 text-[11px]">Magazine 2-col style.</p></div>
                                            </div>
                                        </label>
                                        <label class="cursor-pointer group <?php echo !$can_change_layout ? 'opacity-50 pointer-events-none' : ''; ?>">
                                            <input type="radio" name="layout_type" value="bento-grid" class="peer sr-only" <?php echo ($layout_type === 'bento-grid') ? 'checked' : ''; ?> onchange="toggleLayoutMode(this.value)">
                                            <div class="bg-inputbg border-2 border-bordercolor peer-checked:border-emerald-500 rounded-xl p-4 flex gap-4 transition-all">
                                                <div class="w-10 h-10 bg-card rounded-lg flex items-center justify-center text-emerald-400 shrink-0"><i class='bx bx-grid-alt text-xl'></i></div>
                                                <div><h3 class="text-white font-bold text-sm mb-1">Bento Grid</h3><p class="text-gray-500 text-[11px]">Modern tiled boxes.</p></div>
                                            </div>
                                        </label>
                                        <label class="cursor-pointer group <?php echo !$can_change_layout ? 'opacity-50 pointer-events-none' : ''; ?>">
                                            <input type="radio" name="layout_type" value="minimal-cv" class="peer sr-only" <?php echo ($layout_type === 'minimal-cv') ? 'checked' : ''; ?> onchange="toggleLayoutMode(this.value)">
                                            <div class="bg-inputbg border-2 border-bordercolor peer-checked:border-rose-500 rounded-xl p-4 flex gap-4 transition-all">
                                                <div class="w-10 h-10 bg-card rounded-lg flex items-center justify-center text-rose-400 shrink-0"><i class='bx bx-file-blank text-xl'></i></div>
                                                <div><h3 class="text-white font-bold text-sm mb-1">Minimal CV</h3><p class="text-gray-500 text-[11px]">Clean resume look.</p></div>
                                            </div>
                                        </label>
                                    </div>
                                </div>
                            </section>

                            <section>
                                <h2 class="text-base font-semibold text-white mb-4">Domain & Connection</h2>
                                <div class="bg-card border border-bordercolor rounded-xl p-6 space-y-6">
                                    <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                                        <div>
                                            <label class="block text-sm font-medium text-gray-300 mb-1.5">Username (Subdomain)</label>
                                            <div class="flex shadow-sm rounded-xl overflow-hidden focus-within:ring-1 focus-within:ring-brand-500 transition-all border border-bordercolor <?php echo !$can_change_subdomain ? 'opacity-60 cursor-not-allowed bg-inputbg/50' : 'bg-inputbg'; ?>">
                                                <input type="text" name="subdomain" value="<?php echo htmlspecialchars($user_data['username'] ?? ''); ?>" placeholder="e.g. max" class="w-full bg-transparent px-4 py-2 text-white focus:outline-none text-sm" <?php echo !$can_change_subdomain ? 'readonly' : ''; ?>>
                                                <span class="inline-flex items-center px-4 bg-[#111113] border-l border-bordercolor text-gray-500 text-xs font-medium">.on-your.site</span>
                                            </div>
                                            <?php if(!$can_change_subdomain): ?><p class="text-xs text-red-400 mt-2 flex items-center gap-1"><i class='bx bx-lock-alt'></i> You can change this again in <?php echo $days_to_wait; ?> days.</p><?php endif; ?>
                                        </div>
                                        <div>
                                            <label class="block text-sm font-medium text-gray-300 mb-1.5 flex justify-between">Discord ID <span class="text-[10px] text-[#5865F2] bg-[#5865F2]/10 px-1.5 rounded flex items-center">Auto-Role</span></label>
                                            <div class="flex shadow-sm rounded-lg overflow-hidden focus-within:ring-1 focus-within:ring-[#5865F2] border border-bordercolor">
                                                <span class="inline-flex items-center px-3 bg-card border-r border-bordercolor text-[#5865F2]"><i class='bx bxl-discord-alt text-lg'></i></span>
                                                <input type="text" name="discord_id" value="<?php echo htmlspecialchars($user_data['discord_id'] ?? ''); ?>" placeholder="1234567890" class="w-full bg-inputbg px-4 py-2 text-white focus:outline-none text-sm">
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </section>
                        </div>
                    </form> 

                    <div id="tab-settings-security" class="tab-content max-w-3xl mx-auto space-y-8 hidden pb-12">
                        <section>
                            <h2 class="text-base font-semibold text-white mb-4">Change Email Address</h2>
                            <form action="/dashboard" method="POST" class="bg-card border border-bordercolor rounded-xl p-6 space-y-5">
                                <input type="hidden" name="update_action" value="email">
                                <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                                    <div><label class="block text-sm font-medium text-gray-300 mb-1.5">Current Email</label><input type="email" value="<?php echo htmlspecialchars($user_data['email'] ?? ''); ?>" disabled class="w-full bg-inputbg/50 border border-bordercolor rounded-lg px-4 py-2 text-gray-500 cursor-not-allowed text-sm"></div>
                                    <div><label class="block text-sm font-medium text-gray-300 mb-1.5">New Email Address</label><input type="email" name="new_email" required class="w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm"></div>
                                </div>
                                <div class="p-4 bg-red-500/5 border border-red-500/20 rounded-lg flex flex-col md:flex-row gap-4 items-end">
                                    <div class="flex-1 w-full"><label class="block text-sm font-medium text-red-400 mb-1.5 flex items-center gap-2"><i class='bx bx-lock-alt'></i> Verify Current Password</label><input type="password" name="current_password_email" required class="w-full bg-background border border-red-500/30 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-1 focus:ring-red-500 text-sm"></div>
                                    <button type="submit" class="bg-red-500 hover:bg-red-600 text-white px-5 py-2 rounded-lg text-sm font-bold transition-all shadow-sm w-full md:w-auto">Confirm Email</button>
                                </div>
                            </form>
                        </section>
                        <section>
                            <h2 class="text-base font-semibold text-white mb-4">Change Password</h2>
                            <form action="/dashboard" method="POST" class="bg-card border border-bordercolor rounded-xl p-6 space-y-5">
                                <input type="hidden" name="update_action" value="password">
                                <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                                    <div><label class="block text-sm font-medium text-gray-300 mb-1.5">New Password</label><input type="password" name="new_password" required class="w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm"></div>
                                    <div><label class="block text-sm font-medium text-gray-300 mb-1.5">Confirm New Password</label><input type="password" name="confirm_new_password" required class="w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm"></div>
                                </div>
                                <div class="p-4 bg-red-500/5 border border-red-500/20 rounded-lg flex flex-col md:flex-row gap-4 items-end">
                                    <div class="flex-1 w-full"><label class="block text-sm font-medium text-red-400 mb-1.5 flex items-center gap-2"><i class='bx bx-lock-alt'></i> Verify Current Password</label><input type="password" name="current_password_pwd" required class="w-full bg-background border border-red-500/30 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-1 focus:ring-red-500 text-sm"></div>
                                    <button type="submit" class="bg-red-500 hover:bg-red-600 text-white px-5 py-2 rounded-lg text-sm font-bold transition-all shadow-sm w-full md:w-auto">Confirm Password</button>
                                </div>
                            </form>
                        </section>
                    </div>
                </div>

                <?php include 'views/preview.php'; ?>

            </div>
        </div> 

        <div id="iconModal" class="hidden fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
            <div class="bg-card w-full max-w-lg rounded-xl border border-bordercolor shadow-2xl flex flex-col max-h-[80vh] overflow-hidden transform scale-100">
                <div class="p-4 border-b border-bordercolor flex justify-between items-center bg-inputbg">
                    <h3 class="text-white font-semibold text-sm">Select Icon</h3>
                    <button type="button" onclick="closeIconPicker()" class="text-gray-500 hover:text-white transition-colors"><i class='bx bx-x text-2xl'></i></button>
                </div>
                <div class="p-5 overflow-y-auto custom-scrollbar flex-1 bg-background">
                    <div class="grid grid-cols-6 gap-2">
                        <script>
                            const icons = [
                                'bx bxl-instagram', 'bx bxl-twitter', 'bx bxl-discord-alt', 'bx bxl-youtube', 'bx bxl-tiktok', 'bx bxl-twitch', 'bx bxl-facebook', 'bx bxl-snapchat',
                                'bx bxl-github', 'bx bxl-linkedin', 'bx bxl-spotify', 'bx bxl-apple', 'bx bxl-android', 'bx bxl-windows', 'bx bxl-steam', 'bx bxl-reddit',
                                'bx bx-envelope', 'bx bx-globe', 'bx bx-link', 'bx bx-store', 'bx bx-music', 'bx bx-palette', 'bx bx-game', 'bx bx-coffee'
                            ];
                            icons.forEach(ic => {
                                document.write(`<button type="button" onclick="selectIcon('${ic}')" class="h-10 w-full rounded-lg bg-inputbg border border-bordercolor hover:border-brand-500 hover:text-brand-400 flex items-center justify-center transition-all text-gray-400 shadow-sm"><i class="${ic} text-xl"></i></button>`);
                            });
                        </script>
                    </div>
                </div>
            </div>
        </div>

        <script>
            let currentThemeClass = 'bg-white/10 border border-white/20 shadow-lg text-white backdrop-blur-md'; 
            let currentLayout = '<?php echo $layout_type; ?>';

            document.addEventListener('DOMContentLoaded', function() {
                var el = document.getElementById('linksContainer');
                if (el) {
                    new Sortable(el, {
                        handle: '.drag-handle',
                        animation: 150,
                        ghostClass: 'sortable-ghost',
                        onEnd: function () {
                            updateLivePreviewLinks();
                        }
                    });
                }
            });

            function formatUrlInput(input) {
                let val = input.value.trim();
                if (val.includes('@') && !val.includes('/') && !val.startsWith('mailto:')) {
                    input.value = 'mailto:' + val;
                } else if ((val.startsWith('+') || val.startsWith('00')) && !val.startsWith('tel:') && !val.includes('http')) {
                    if (!/[a-zA-Z]/.test(val)) input.value = 'tel:' + val;
                }
            }

            function switchTab(tabName) {
                document.querySelectorAll('.tab-content').forEach(tab => tab.classList.add('hidden'));
                document.querySelectorAll('.nav-btn').forEach(btn => btn.className = "nav-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/5 text-gray-400 hover:text-white transition-all");
                
                const previewPane = document.getElementById('previewPaneWrapper');
                if(tabName === 'settings') {
                    document.getElementById('tab-settings-main').classList.remove('hidden');
                    document.getElementById('tab-settings-security').classList.remove('hidden');
                    previewPane.classList.add('force-hide');
                } else {
                    document.getElementById('tab-' + tabName).classList.remove('hidden');
                    previewPane.classList.remove('force-hide');
                }

                document.getElementById('nav-' + tabName).className = "nav-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-brand-500/10 text-brand-400 font-medium transition-all";
                
                const titles = { 'builder': 'Profile Builder', 'integrations': 'Integrations & Downloads', 'analytics': 'Profile Analytics', 'seo': 'Search Engine Optimization', 'branding': 'White Label Branding', 'settings': 'Account Settings' };
                document.getElementById('page-title').innerText = titles[tabName] || 'Dashboard';
            }

            function toggleLayoutMode(mode) {
                currentLayout = mode;
                const phone = document.getElementById('phonePreview');
                const imgContainer = document.getElementById('previewImgContainer');
                
                document.getElementById('modeBadge').textContent = mode.replace('-', ' ').toUpperCase();
                
                if(mode === 'about-me' || mode === 'bento-grid' || mode === 'minimal-cv') {
                    document.getElementById('aboutMeFields').classList.remove('hidden');
                    
                    phone.classList.replace('w-[300px]', 'w-[360px]');
                    imgContainer.classList.replace('w-20', 'w-28');
                    imgContainer.classList.replace('h-20', 'h-28');
                    
                    document.getElementById('previewProfession').classList.remove('hidden');
                    document.getElementById('previewDetailedBioWrapper').classList.remove('hidden');
                } else {
                    document.getElementById('aboutMeFields').classList.add('hidden');
                    
                    phone.classList.replace('w-[360px]', 'w-[300px]');
                    imgContainer.classList.replace('w-28', 'w-20');
                    imgContainer.classList.replace('h-28', 'h-20');
                    
                    document.getElementById('previewProfession').classList.add('hidden');
                    document.getElementById('previewDetailedBioWrapper').classList.add('hidden');
                }
                
                const currentTheme = document.querySelector('input[name="theme"]:checked');
                if(currentTheme) updateThemePreview(currentTheme.value);
                
                updateLivePreviewLinks();
            }

            let currentIconInput = null; let currentIconButton = null;
            function openIconPicker(btn) { 
                currentIconButton = btn; currentIconInput = btn.previousElementSibling; 
                document.getElementById('iconModal').classList.remove('hidden'); 
            }
            function closeIconPicker() { document.getElementById('iconModal').classList.add('hidden'); }
            function selectIcon(iconClass) { 
                if(currentIconInput) { 
                    currentIconInput.value = iconClass; 
                    currentIconButton.innerHTML = `<i class="${iconClass} text-xl picker-icon-preview"></i>`; 
                    currentIconButton.classList.add('text-brand-400', 'border-brand-500'); 
                } 
                closeIconPicker(); updateLivePreviewLinks();
            }

            function addLinkField() {
                const container = document.getElementById('linksContainer');
                const newLink = document.createElement('div');
                newLink.className = "link-item bg-inputbg p-3 rounded-lg border border-bordercolor flex items-center gap-3 relative group animate-fade-in mt-3";
                newLink.innerHTML = `
                    <div class="shrink-0 drag-handle text-gray-600 px-1 hidden md:block hover:text-white"><i class='bx bx-grid-vertical text-xl'></i></div>
                    <div class="shrink-0 flex justify-center items-center">
                        <input type="hidden" name="link_ids[]" value="">
                        <input type="hidden" name="link_icons[]" value="">
                        <button type="button" onclick="openIconPicker(this)" class="w-10 h-10 rounded-md bg-card border border-bordercolor hover:border-brand-500 flex items-center justify-center text-gray-500 transition-colors shadow-inner"><i class="bx bx-image-add text-xl picker-icon-preview"></i></button>
                    </div>
                    <div class="flex-1 flex flex-col md:flex-row gap-2">
                        <input type="text" name="link_titles[]" placeholder="Title" oninput="updateLivePreviewLinks()" class="title-input w-full md:w-1/3 bg-transparent text-white font-medium focus:outline-none text-sm">
                        <input type="url" name="link_urls[]" placeholder="https:// or mailto:you@email.com" oninput="formatUrlInput(this); updateLivePreviewLinks()" class="url-input w-full flex-1 bg-transparent text-gray-400 focus:outline-none text-sm">
                    </div>
                    <button type="button" onclick="this.closest('.link-item').remove(); updateLivePreviewLinks();" class="text-gray-500 hover:text-red-400 p-2 rounded-md transition-colors shrink-0"><i class='bx bx-trash text-lg'></i></button>
                `;
                container.appendChild(newLink);
                updateLivePreviewLinks();
            }

            function updateLivePreviewLinks() {
                const previewContainer = document.getElementById('previewLinksContainer');
                previewContainer.innerHTML = ''; 
                const linkItems = document.querySelectorAll('.link-item');
                
                if(linkItems.length === 0) {
                    previewContainer.innerHTML = `<div class="w-full py-2.5 px-4 rounded-xl text-center text-xs font-medium preview-link-anim ${currentThemeClass}">Preview Link</div>`;
                    return;
                }

                if(currentLayout === 'about-me' || currentLayout === 'bento-grid' || currentLayout === 'minimal-cv') {
                    const gridDiv = document.createElement('div');
                    gridDiv.className = "grid grid-cols-2 gap-2 w-full";
                    linkItems.forEach(item => {
                        const title = item.querySelector('.title-input').value || 'Link';
                        const iconVal = item.querySelector('input[name="link_icons[]"]').value;
                        const iconHtml = iconVal ? `<i class='${iconVal} text-base'></i>` : '';
                        gridDiv.innerHTML += `<div class="py-2 px-3 flex items-center justify-center gap-2 text-[11px] font-medium preview-link-anim ${currentThemeClass}">${iconHtml} <span class="truncate">${title}</span></div>`;
                    });
                    previewContainer.appendChild(gridDiv);
                } else {
                    linkItems.forEach(item => {
                        const title = item.querySelector('.title-input').value || 'Link';
                        const iconVal = item.querySelector('input[name="link_icons[]"]').value;
                        const iconHtml = iconVal ? `<i class='${iconVal} absolute left-4 text-lg'></i>` : '';
                        previewContainer.innerHTML += `<div class="w-full py-2.5 px-4 flex items-center justify-center relative text-xs font-medium preview-link-anim ${currentThemeClass}">${iconHtml} <span class="truncate px-6">${title}</span></div>`;
                    });
                }
            }

            document.getElementById('nameInput').addEventListener('input', (e) => document.getElementById('previewName').textContent = e.target.value || 'Your Name');
            const bioInput = document.getElementById('bioInput');
            if(bioInput) bioInput.addEventListener('input', (e) => document.getElementById('previewBio').innerHTML = e.target.value.replace(/\n/g, '<br>') || 'Your bio will appear here.');
            const profInput = document.getElementById('professionInput');
            if(profInput) profInput.addEventListener('input', (e) => document.getElementById('previewProfession').textContent = e.target.value.toUpperCase() || 'YOUR PROFESSION');
            const detBioInput = document.getElementById('detailedBioInput');
            if(detBioInput) detBioInput.addEventListener('input', (e) => document.getElementById('previewDetailedBio').innerHTML = e.target.value.replace(/\n/g, '<br>') || 'Your detailed story goes here...');
            
            document.getElementById('bgUpload').addEventListener('change', function(e) {
                if (this.files && this.files[0]) {
                    const url = URL.createObjectURL(this.files[0]);
                    document.getElementById('phoneBgLayer').style.backgroundImage = `url('${url}')`;
                    document.getElementById('phoneBgLayer').style.backgroundSize = 'cover';
                    document.getElementById('phoneBgLayer').style.backgroundPosition = 'center';
                }
            });

            function updateThemePreview(themeValue) {
                const phone = document.getElementById('phonePreview');
                const name = document.getElementById('previewName');
                const bio = document.getElementById('previewBio');
                const detBioWrap = document.getElementById('previewDetailedBioWrapper');
                const prof = document.getElementById('previewProfession');
                const detBioTitle = document.getElementById('previewDetailedBioTitle');
                const detBioText = document.getElementById('previewDetailedBio');
                const imgContainer = document.getElementById('previewImgContainer');

                let phoneClasses = "h-[620px] border-[8px] border-[#1f1f22] rounded-[2.5rem] relative shadow-2xl overflow-hidden flex flex-col items-center py-10 px-5 transition-all duration-500 custom-scrollbar overflow-y-auto ";
                
                if (currentLayout === 'link-tree') {
                    phoneClasses += "w-[300px] ";
                    imgContainer.className = "w-20 h-20 rounded-full flex items-center justify-center mt-3 shrink-0 z-10 overflow-hidden transition-all duration-300 ";
                } else {
                    phoneClasses += "w-[360px] ";
                    imgContainer.className = "w-28 h-28 rounded-full flex items-center justify-center mt-3 shrink-0 z-10 overflow-hidden transition-all duration-300 ";
                }

                name.className = "font-bold text-base mb-1 z-10 text-center drop-shadow-md transition-colors ";
                prof.className = "text-[10px] font-semibold uppercase tracking-widest mb-2 z-10 transition-all duration-300 ";
                bio.className = "text-xs text-center mb-6 z-10 drop-shadow-md px-2 transition-colors ";
                
                if(detBioWrap) detBioWrap.className = "w-full p-4 mb-4 z-10 transition-all duration-300 ";
                if(detBioTitle) detBioTitle.className = "font-bold text-xs mb-2 pb-1 flex items-center gap-1 ";
                if(detBioText) detBioText.className = "text-[10px] leading-relaxed ";

                if(currentLayout === 'link-tree') {
                    prof.classList.add('hidden');
                    if(detBioWrap) detBioWrap.classList.add('hidden');
                } else {
                    prof.classList.remove('hidden');
                    if(detBioWrap) detBioWrap.classList.remove('hidden');
                }

                if(themeValue === 'deep-dark') {
                    phoneClasses += "bg-[#09090b] ";
                    imgContainer.className += "bg-white/10 backdrop-blur-md border border-white/20 shadow-lg ";
                    name.className += "text-white ";
                    prof.className += "text-white/60 ";
                    bio.className += "text-gray-300 ";
                    if(detBioWrap) detBioWrap.className += "bg-white/5 backdrop-blur-md border border-white/10 rounded-xl ";
                    if(detBioTitle) detBioTitle.className += "border-b border-white/20 text-white ";
                    if(detBioText) detBioText.className += "text-gray-300 ";
                    currentThemeClass = "bg-white/10 border border-white/20 shadow-lg text-white backdrop-blur-md rounded-xl";
                }
                else if(themeValue === 'midnight') {
                    phoneClasses += "bg-gradient-to-br from-indigo-500 to-purple-600 ";
                    imgContainer.className += "bg-white/10 backdrop-blur-md border border-white/20 shadow-lg ";
                    name.className += "text-white ";
                    prof.className += "text-white/60 ";
                    bio.className += "text-gray-200 ";
                    if(detBioWrap) detBioWrap.className += "bg-white/10 backdrop-blur-md border border-white/20 rounded-xl ";
                    if(detBioTitle) detBioTitle.className += "border-b border-white/30 text-white ";
                    if(detBioText) detBioText.className += "text-gray-200 ";
                    currentThemeClass = "bg-white/10 border border-white/20 shadow-lg text-white backdrop-blur-md rounded-xl";
                }
                else if(themeValue === 'forest') {
                    phoneClasses += "bg-gradient-to-br from-emerald-500 to-teal-700 ";
                    imgContainer.className += "bg-white/10 backdrop-blur-md border border-white/20 shadow-lg ";
                    name.className += "text-white ";
                    prof.className += "text-emerald-100/60 ";
                    bio.className += "text-emerald-50 ";
                    if(detBioWrap) detBioWrap.className += "bg-white/10 backdrop-blur-md border border-white/20 rounded-xl ";
                    if(detBioTitle) detBioTitle.className += "border-b border-white/30 text-white ";
                    if(detBioText) detBioText.className += "text-emerald-50 ";
                    currentThemeClass = "bg-white/10 border border-white/20 shadow-lg text-white backdrop-blur-md rounded-xl";
                }
                else if(themeValue === 'sunset') {
                    phoneClasses += "bg-gradient-to-br from-rose-500 to-orange-500 ";
                    imgContainer.className += "bg-white/10 backdrop-blur-md border border-white/20 shadow-lg ";
                    name.className += "text-white ";
                    prof.className += "text-orange-100/60 ";
                    bio.className += "text-orange-50 ";
                    if(detBioWrap) detBioWrap.className += "bg-white/10 backdrop-blur-md border border-white/20 rounded-xl ";
                    if(detBioTitle) detBioTitle.className += "border-b border-white/30 text-white ";
                    if(detBioText) detBioText.className += "text-orange-50 ";
                    currentThemeClass = "bg-white/10 border border-white/20 shadow-lg text-white backdrop-blur-md rounded-xl";
                }
                else if(themeValue === 'ocean') {
                    phoneClasses += "bg-gradient-to-t from-blue-700 to-cyan-500 ";
                    imgContainer.className += "bg-white/10 backdrop-blur-md border border-white/20 shadow-lg ";
                    name.className += "text-white ";
                    prof.className += "text-cyan-100/60 ";
                    bio.className += "text-cyan-50 ";
                    if(detBioWrap) detBioWrap.className += "bg-white/10 backdrop-blur-md border border-white/20 rounded-xl ";
                    if(detBioTitle) detBioTitle.className += "border-b border-white/30 text-white ";
                    if(detBioText) detBioText.className += "text-cyan-50 ";
                    currentThemeClass = "bg-white/10 border border-white/20 shadow-lg text-white backdrop-blur-md rounded-xl";
                }
                else if(themeValue === 'cherry') {
                    phoneClasses += "bg-gradient-to-r from-pink-500 to-rose-400 ";
                    imgContainer.className += "bg-white/10 backdrop-blur-md border border-white/20 shadow-lg ";
                    name.className += "text-white ";
                    prof.className += "text-rose-100/60 ";
                    bio.className += "text-rose-50 ";
                    if(detBioWrap) detBioWrap.className += "bg-white/10 backdrop-blur-md border border-white/20 rounded-xl ";
                    if(detBioTitle) detBioTitle.className += "border-b border-white/30 text-white ";
                    if(detBioText) detBioText.className += "text-rose-50 ";
                    currentThemeClass = "bg-white/10 border border-white/20 shadow-lg text-white backdrop-blur-md rounded-xl";
                }
                else if(themeValue === 'hacker') {
                    phoneClasses += "bg-black border-green-500 ";
                    imgContainer.className += "bg-black border border-green-500 shadow-[0_0_15px_rgba(34,197,94,0.2)] rounded-none ";
                    name.className += "text-green-500 font-mono ";
                    prof.className += "text-green-500/60 font-mono ";
                    bio.className += "text-green-400 font-mono ";
                    if(detBioWrap) detBioWrap.className += "bg-black border border-green-500 shadow-[0_0_10px_rgba(34,197,94,0.2)] rounded-none ";
                    if(detBioTitle) detBioTitle.className += "border-b border-green-500/30 text-green-500 font-mono ";
                    if(detBioText) detBioText.className += "text-green-400 font-mono ";
                    currentThemeClass = "rounded-none border border-green-500 bg-black text-green-500 font-mono shadow-[0_0_10px_rgba(34,197,94,0.2)]";
                }
                else if(themeValue === 'minimal') {
                    phoneClasses += "bg-white border-gray-200 ";
                    imgContainer.className += "bg-gray-50 border border-gray-200 shadow-sm ";
                    name.className += "text-black ";
                    prof.className += "text-gray-500 ";
                    bio.className += "text-gray-600 ";
                    if(detBioWrap) detBioWrap.className += "bg-white border border-gray-200 shadow-sm rounded-xl ";
                    if(detBioTitle) detBioTitle.className += "border-b border-gray-200 text-black ";
                    if(detBioText) detBioText.className += "text-gray-600 ";
                    currentThemeClass = "bg-white border border-gray-200 shadow-sm text-black rounded-xl";
                }
                else if(themeValue === 'glass') {
                    phoneClasses += "bg-gradient-to-tr from-gray-100 to-gray-300 ";
                    imgContainer.className += "bg-white/40 border border-white/50 shadow-sm ";
                    name.className += "text-gray-900 ";
                    prof.className += "text-gray-600 ";
                    bio.className += "text-gray-700 ";
                    if(detBioWrap) detBioWrap.className += "bg-white/40 border border-white/50 backdrop-blur-xl shadow-sm rounded-xl ";
                    if(detBioTitle) detBioTitle.className += "border-b border-gray-300 text-gray-900 ";
                    if(detBioText) detBioText.className += "text-gray-700 ";
                    currentThemeClass = "bg-white/40 border border-white/50 shadow-sm text-gray-900 rounded-xl";
                }
                else if(themeValue === 'cyberpunk') {
                    phoneClasses += "bg-[#fcee0a] ";
                    imgContainer.className += "bg-[#fcee0a] border-4 border-black rounded-none shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] ";
                    name.className += "text-black ";
                    prof.className += "text-black/70 ";
                    bio.className += "text-black font-semibold ";
                    if(detBioWrap) detBioWrap.className += "bg-[#fcee0a] border-4 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] rounded-none ";
                    if(detBioTitle) detBioTitle.className += "border-b-4 border-black text-black ";
                    if(detBioText) detBioText.className += "text-black font-medium ";
                    currentThemeClass = "bg-black border-2 border-black text-[#fcee0a] shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] rounded-none font-bold";
                }
                
                phone.className = phoneClasses;
                updateLivePreviewLinks();
            }

            document.querySelectorAll('input[name="theme"]').forEach(radio => radio.addEventListener('change', (e) => updateThemePreview(e.target.value)));
            
            window.onload = () => {
                const currentTheme = document.querySelector('input[name="theme"]:checked');
                if(currentTheme) updateThemePreview(currentTheme.value);
                toggleLayoutMode(currentLayout);
            };
        </script>
    </div>
</body>
</html>