<?php
// Layout Type (Standardmäßig Link-Tree)
$layout = $user_data['layout_type'] ?? 'link-tree';

// Basis-Klassen (Fallback)
$bgClass = "bg-[#09090b]";
$textClass = "text-white";
$linkClass = "bg-white/10 hover:bg-white/20 border border-white/20 hover:border-white/30 text-white backdrop-blur-md shadow-lg hover:shadow-xl rounded-xl transition-all duration-300";
$cardClass = "bg-white/5 border border-white/10 backdrop-blur-xl shadow-2xl rounded-[2rem]";
$imgClass = "rounded-[2rem] shadow-xl border border-white/10 bg-black/20";
$pillClass = "bg-white/10 border border-white/20 text-white";

// --- THEME LOGIK ---
if ($user_data['theme'] === 'midnight') { $bgClass = "bg-gradient-to-br from-indigo-900 via-purple-900 to-black"; }
if ($user_data['theme'] === 'forest') { $bgClass = "bg-gradient-to-br from-emerald-900 to-teal-900"; }
if ($user_data['theme'] === 'sunset') { $bgClass = "bg-gradient-to-br from-rose-900 to-orange-900"; }
if ($user_data['theme'] === 'ocean') { $bgClass = "bg-gradient-to-t from-blue-900 to-cyan-900"; }
if ($user_data['theme'] === 'cherry') { $bgClass = "bg-gradient-to-r from-pink-900 to-rose-900"; }

// Spezielle Themes (überschreiben Card-Klassen für ihre eigenen Styles)
if ($user_data['theme'] === 'glass') { 
    $bgClass = "bg-gradient-to-tr from-gray-100 to-gray-300"; 
    $textClass = "text-gray-900"; 
    $linkClass = "bg-white/50 hover:bg-white/80 border border-white/60 text-gray-900 shadow-sm rounded-xl transition-all duration-300";
    $cardClass = "bg-white/40 border border-white/50 backdrop-blur-2xl shadow-xl rounded-[2rem] text-gray-900";
    $imgClass  = "rounded-[2rem] shadow-lg border border-white/50 bg-white/20";
    $pillClass = "bg-white/50 border border-white/60 text-gray-800";
}
if ($user_data['theme'] === 'minimal') { 
    $bgClass = "bg-gray-50"; 
    $textClass = "text-black"; 
    $linkClass = "bg-white hover:bg-gray-100 border border-gray-200 text-black shadow-sm rounded-xl transition-all duration-300";
    $cardClass = "bg-white border border-gray-200 shadow-2xl rounded-[2rem] text-black";
    $imgClass  = "rounded-[2rem] shadow-md border border-gray-100 bg-gray-50";
    $pillClass = "bg-gray-100 border border-gray-200 text-gray-600";
}
if ($user_data['theme'] === 'cyberpunk') { 
    $bgClass = "bg-[#fcee0a]"; 
    $textClass = "text-black font-semibold";
    $linkClass = "bg-black hover:bg-gray-900 border-2 border-black text-[#fcee0a] rounded-none shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:translate-y-[2px] hover:shadow-[0px_0px_0px_0px_rgba(0,0,0,1)] transition-all uppercase tracking-wide";
    $cardClass = "bg-[#fcee0a] border-[6px] border-black rounded-none shadow-[12px_12px_0px_0px_rgba(0,0,0,1)] text-black";
    $imgClass  = "border-4 border-black rounded-none bg-black/5";
    $pillClass = "bg-white border-2 border-black text-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] font-bold uppercase";
}
if ($user_data['theme'] === 'hacker') { 
    $bgClass = "bg-black"; 
    $textClass = "text-green-500 font-mono"; 
    $linkClass = "bg-black hover:bg-green-500/20 border border-green-500 text-green-500 rounded-none shadow-[0_0_10px_rgba(34,197,94,0.1)] transition-all font-mono";
    $cardClass = "bg-black border border-green-500 rounded-none shadow-[0_0_30px_rgba(34,197,94,0.15)] text-green-500 font-mono";
    $imgClass  = "border border-green-500 rounded-none opacity-80 filter sepia hue-rotate-[100deg] saturate-[300%] bg-black";
    $pillClass = "bg-black border border-green-500 text-green-400";
}

$seoTitle = !empty($user_data['seo_title']) ? $user_data['seo_title'] : $user_data['full_name'] . " | OnYourSite";

// --- DYNAMISCHE BUTTON-LOGIK FÜR DEN DATEI-DOWNLOAD ---
$downloadText = "Download File";
$downloadIcon = "bx-download";
if (!empty($user_data['cv_file'])) {
    $ext = strtolower(pathinfo($user_data['cv_file'], PATHINFO_EXTENSION));
    if ($ext === 'pdf') {
        $downloadText = "Download Resume";
        $downloadIcon = "bxs-file-pdf";
    } elseif ($ext === 'vcf') {
        $downloadText = "Save Contact";
        $downloadIcon = "bxs-contact";
    }
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title><?php echo htmlspecialchars($seoTitle); ?></title>
    <?php if(!empty($user_data['seo_description'])): ?><meta name="description" content="<?php echo htmlspecialchars($user_data['seo_description']); ?>"><?php endif; ?>
    <?php if(!empty($user_data['seo_keywords'])): ?><meta name="keywords" content="<?php echo htmlspecialchars($user_data['seo_keywords']); ?>"><?php endif; ?>
    <meta property="og:title" content="<?php echo htmlspecialchars($seoTitle); ?>">
    <meta property="og:type" content="profile">
    <meta property="og:url" content="https://<?php echo htmlspecialchars($user_data['username']); ?>.on-your.site">
    <link rel="icon" type="image/png" href="/static/images/favicon.png">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Fira+Code:wght@400;600&display=swap" rel="stylesheet">
    <link href='https://unpkg.com/boxicons@2.1.4/css/boxicons.min.css' rel='stylesheet'>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = { theme: { extend: { fontFamily: { sans: ['Inter', 'sans-serif'], mono: ['Fira Code', 'monospace'], } } } }
    </script>
    <style>
        body { font-family: 'Inter', sans-serif; }
        <?php if($user_data['theme'] === 'hacker') echo "body { font-family: 'Fira Code', monospace; }"; ?>
        <?php echo htmlspecialchars_decode($user_data['custom_css'] ?? ''); ?>
    </style>
</head>
<body class="<?php echo $bgClass; ?> <?php echo $textClass; ?> min-h-screen flex flex-col items-center py-10 md:py-16 px-4 selection:bg-current/30 relative">

    <?php if(!empty($user_data['bg_image'])): ?>
        <div class="fixed inset-0 z-0 pointer-events-none" style="background-image: url('/static/uploads/<?php echo htmlspecialchars($user_data['bg_image']); ?>'); background-size: cover; background-position: center; <?php echo ($user_data['theme'] === 'glass' || $user_data['theme'] === 'minimal') ? 'opacity-30' : 'opacity-50 mix-blend-overlay'; ?>"></div>
    <?php endif; ?>

    <?php if($layout === 'link-tree'): ?>
        <div class="w-full max-w-[680px] flex flex-col items-center profile-container relative z-10">
            <div class="w-28 h-28 rounded-full flex items-center justify-center mb-6 shadow-2xl overflow-hidden <?php echo ($user_data['theme'] === 'glass' || $user_data['theme'] === 'minimal') ? 'bg-white/40 border-2 border-black/10' : 'bg-white/10 backdrop-blur-md border-2 border-white/20'; ?>">
                <?php if(!empty($user_data['profile_image'])): ?>
                    <img src="/static/uploads/<?php echo htmlspecialchars($user_data['profile_image']); ?>" class="w-full h-full object-cover">
                <?php else: ?><i class='bx bx-user text-5xl opacity-50'></i><?php endif; ?>
            </div>
            <h1 class="text-2xl font-bold mb-2 text-center drop-shadow-md"><?php echo htmlspecialchars($user_data['full_name']); ?></h1>
            <p class="text-center mb-8 max-w-md text-sm md:text-base leading-relaxed opacity-80 drop-shadow-sm"><?php echo nl2br(htmlspecialchars($user_data['bio'])); ?></p>
            
            <?php if(!empty($user_data['booking_url']) || !empty($user_data['cv_file'])): ?>
            <div class="w-full flex flex-col sm:flex-row gap-3 mb-6">
                <?php if(!empty($user_data['booking_url'])): ?>
                    <a href="<?php echo htmlspecialchars($user_data['booking_url']); ?>" target="_blank" class="flex-1 py-3 px-6 bg-brand-500 hover:bg-brand-600 text-white rounded-xl font-bold transition-all duration-300 flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(99,102,241,0.4)] hover:-translate-y-1">
                        <i class='bx bx-calendar-event text-xl'></i> Book a Meeting
                    </a>
                <?php endif; ?>
                <?php if(!empty($user_data['cv_file'])): ?>
                    <a href="/static/uploads/<?php echo htmlspecialchars($user_data['cv_file']); ?>" download class="flex-1 py-3 px-6 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 rounded-xl font-bold transition-all duration-300 flex items-center justify-center gap-2">
                        <i class='bx <?php echo $downloadIcon; ?> text-xl'></i> <?php echo $downloadText; ?>
                    </a>
                <?php endif; ?>
            </div>
            <?php endif; ?>

            <div class="w-full space-y-4 links-container">
                <?php if(!empty($user_links)): ?>
                    <?php foreach($user_links as $link): ?>
                        <a href="<?php echo htmlspecialchars($link['url']); ?>" target="_blank" rel="noopener noreferrer" onclick="trackClick(<?php echo $link['id']; ?>)" class="block w-full py-4 px-6 font-bold flex items-center justify-center relative <?php echo $linkClass; ?>">
                            <?php if(!empty($link['icon_class'])): ?><i class='<?php echo htmlspecialchars($link['icon_class']); ?> text-2xl absolute left-6'></i><?php endif; ?>
                            <span><?php echo htmlspecialchars($link['title']); ?></span>
                        </a>
                    <?php endforeach; ?>
                <?php endif; ?>
            </div>
        </div>

    <?php elseif($layout === 'about-me'): ?>
        <div class="w-full max-w-[1000px] relative z-10 profile-container flex-1 flex items-center justify-center">
            <div class="w-full flex flex-col md:flex-row overflow-hidden <?php echo $cardClass; ?> min-h-[500px]">
                <div class="w-full md:w-5/12 lg:w-1/2 p-6 md:p-8 flex items-center justify-center border-b md:border-b-0 md:border-r border-current/10">
                    <div class="w-full max-w-[300px] md:max-w-full aspect-square overflow-hidden flex items-center justify-center <?php echo $imgClass; ?>">
                        <?php if(!empty($user_data['profile_image'])): ?>
                            <img src="/static/uploads/<?php echo htmlspecialchars($user_data['profile_image']); ?>" class="w-full h-full object-cover">
                        <?php else: ?><i class='bx bx-user text-9xl opacity-20'></i><?php endif; ?>
                    </div>
                </div>
                <div class="w-full md:w-7/12 lg:w-1/2 p-8 md:p-12 flex flex-col justify-center">
                    <div class="mb-2"><span class="text-xs font-bold tracking-widest uppercase opacity-60">About Me</span></div>
                    <h1 class="text-4xl md:text-5xl lg:text-6xl font-extrabold mb-3 tracking-tight leading-none"><?php echo htmlspecialchars($user_data['full_name']); ?></h1>
                    <?php if(!empty($user_data['profession'])): ?><h2 class="text-lg md:text-xl font-semibold mb-6 opacity-70"><?php echo htmlspecialchars($user_data['profession']); ?></h2><?php endif; ?>
                    
                    <div class="text-sm md:text-base leading-loose opacity-80 mb-6 space-y-4">
                        <?php if(!empty($user_data['bio'])): ?><p class="font-medium italic border-l-2 border-current/30 pl-4 py-1">"<?php echo nl2br(htmlspecialchars($user_data['bio'])); ?>"</p><?php endif; ?>
                        <?php if(!empty($user_data['detailed_bio'])): ?><p><?php echo nl2br(htmlspecialchars($user_data['detailed_bio'])); ?></p><?php endif; ?>
                    </div>

                    <?php if(!empty($user_data['booking_url']) || !empty($user_data['cv_file'])): ?>
                    <div class="flex flex-wrap gap-3 mb-6">
                        <?php if(!empty($user_data['booking_url'])): ?>
                            <a href="<?php echo htmlspecialchars($user_data['booking_url']); ?>" target="_blank" class="px-5 py-2.5 bg-brand-500 hover:bg-brand-600 text-white rounded-lg font-bold transition-all shadow-lg flex items-center gap-2 text-sm hover:-translate-y-0.5"><i class='bx bx-calendar-event text-lg'></i> Book Me</a>
                        <?php endif; ?>
                        <?php if(!empty($user_data['cv_file'])): ?>
                            <a href="/static/uploads/<?php echo htmlspecialchars($user_data['cv_file']); ?>" download class="px-5 py-2.5 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 rounded-lg font-bold transition-all flex items-center gap-2 text-sm"><i class='bx <?php echo $downloadIcon; ?> text-lg'></i> <?php echo $downloadText; ?></a>
                        <?php endif; ?>
                    </div>
                    <?php endif; ?>

                    <?php if(!empty($user_links)): ?>
                        <div class="flex flex-wrap gap-3 mt-auto pt-4 border-t border-current/10">
                            <?php foreach($user_links as $link): ?>
                                <a href="<?php echo htmlspecialchars($link['url']); ?>" target="_blank" rel="noopener noreferrer" onclick="trackClick(<?php echo $link['id']; ?>)" class="inline-flex items-center gap-2 px-5 py-3 font-semibold text-sm <?php echo $linkClass; ?>">
                                    <?php if(!empty($link['icon_class'])): ?><i class='<?php echo htmlspecialchars($link['icon_class']); ?> text-lg'></i><?php endif; ?>
                                    <span><?php echo htmlspecialchars($link['title']); ?></span>
                                </a>
                            <?php endforeach; ?>
                        </div>
                    <?php endif; ?>
                </div>
            </div>
        </div>

    <?php elseif($layout === 'bento-grid'): ?>
        <div class="w-full max-w-[1100px] relative z-10 profile-container">
            <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                
                <div class="md:col-span-2 p-8 md:p-10 flex flex-col justify-center <?php echo $cardClass; ?>">
                    <div class="flex flex-col sm:flex-row items-center sm:items-start gap-6 mb-6">
                        <div class="w-28 h-28 sm:w-32 sm:h-32 shrink-0 rounded-full flex items-center justify-center overflow-hidden <?php echo $imgClass; ?>">
                            <?php if(!empty($user_data['profile_image'])): ?>
                                <img src="/static/uploads/<?php echo htmlspecialchars($user_data['profile_image']); ?>" class="w-full h-full object-cover">
                            <?php else: ?><i class='bx bx-user text-5xl opacity-20'></i><?php endif; ?>
                        </div>
                        <div class="text-center sm:text-left mt-2">
                            <h1 class="text-4xl md:text-5xl font-extrabold tracking-tight mb-2"><?php echo htmlspecialchars($user_data['full_name']); ?></h1>
                            <?php if(!empty($user_data['profession'])): ?>
                                <span class="inline-block px-3 py-1 text-xs font-bold uppercase tracking-widest <?php echo $pillClass; ?> rounded-full mb-3">
                                    <?php echo htmlspecialchars($user_data['profession']); ?>
                                </span>
                            <?php endif; ?>
                            <p class="opacity-80 text-sm md:text-base leading-relaxed mb-4"><?php echo nl2br(htmlspecialchars($user_data['bio'])); ?></p>
                            
                            <?php if(!empty($user_data['booking_url']) || !empty($user_data['cv_file'])): ?>
                            <div class="flex flex-wrap justify-center sm:justify-start gap-2">
                                <?php if(!empty($user_data['booking_url'])): ?>
                                    <a href="<?php echo htmlspecialchars($user_data['booking_url']); ?>" target="_blank" class="px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white rounded-lg font-bold transition-all shadow-md flex items-center gap-1.5 text-xs hover:-translate-y-0.5"><i class='bx bx-calendar-event text-base'></i> Book a Meeting</a>
                                <?php endif; ?>
                                <?php if(!empty($user_data['cv_file'])): ?>
                                    <a href="/static/uploads/<?php echo htmlspecialchars($user_data['cv_file']); ?>" download class="px-4 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 rounded-lg font-bold transition-all flex items-center gap-1.5 text-xs"><i class='bx <?php echo $downloadIcon; ?> text-base'></i> <?php echo $downloadText; ?></a>
                                <?php endif; ?>
                            </div>
                            <?php endif; ?>
                        </div>
                    </div>
                </div>

                <div class="p-8 <?php echo $cardClass; ?> flex flex-col">
                    <h3 class="font-bold text-lg mb-4 flex items-center gap-2 opacity-80"><i class='bx bx-link-alt'></i> Connect</h3>
                    <div class="flex flex-col gap-3 flex-1 justify-center">
                        <?php if(!empty($user_links)): ?>
                            <?php foreach($user_links as $link): ?>
                                <a href="<?php echo htmlspecialchars($link['url']); ?>" target="_blank" rel="noopener noreferrer" onclick="trackClick(<?php echo $link['id']; ?>)" class="flex items-center gap-3 px-4 py-3 font-semibold text-sm <?php echo $linkClass; ?>">
                                    <?php if(!empty($link['icon_class'])): ?><i class='<?php echo htmlspecialchars($link['icon_class']); ?> text-xl opacity-80'></i><?php endif; ?>
                                    <span class="truncate"><?php echo htmlspecialchars($link['title']); ?></span>
                                </a>
                            <?php endforeach; ?>
                        <?php else: ?>
                            <p class="opacity-50 text-sm text-center">No links added.</p>
                        <?php endif; ?>
                    </div>
                </div>

                <?php if(!empty($user_data['detailed_bio'])): ?>
                <div class="md:col-span-3 p-8 md:p-10 <?php echo $cardClass; ?>">
                    <h3 class="font-bold text-lg mb-4 flex items-center gap-2 opacity-80"><i class='bx bx-book-open'></i> Story</h3>
                    <p class="leading-loose opacity-85"><?php echo nl2br(htmlspecialchars($user_data['detailed_bio'])); ?></p>
                </div>
                <?php endif; ?>

            </div>
        </div>

    <?php elseif($layout === 'minimal-cv'): ?>
        <?php 
            $cvCardClass = str_replace('rounded-[2rem]', 'rounded-xl', $cardClass); 
        ?>
        <div class="w-full max-w-[850px] relative z-10 profile-container">
            <div class="p-8 md:p-16 <?php echo $cvCardClass; ?>">
                
                <div class="flex flex-col md:flex-row items-center md:items-start gap-8 mb-12 border-b border-current/20 pb-12">
                    <div class="w-32 h-32 md:w-40 md:h-40 shrink-0 flex items-center justify-center overflow-hidden <?php echo str_replace('rounded-[2rem]', 'rounded-2xl', $imgClass); ?>">
                        <?php if(!empty($user_data['profile_image'])): ?>
                            <img src="/static/uploads/<?php echo htmlspecialchars($user_data['profile_image']); ?>" class="w-full h-full object-cover">
                        <?php else: ?><i class='bx bx-user text-5xl opacity-20'></i><?php endif; ?>
                    </div>
                    <div class="text-center md:text-left pt-2 w-full">
                        <h1 class="text-4xl md:text-6xl font-black tracking-tighter mb-2"><?php echo htmlspecialchars($user_data['full_name']); ?></h1>
                        <?php if(!empty($user_data['profession'])): ?><h2 class="text-lg md:text-xl opacity-60 tracking-widest uppercase mb-4"><?php echo htmlspecialchars($user_data['profession']); ?></h2><?php endif; ?>
                        <p class="opacity-80 text-sm md:text-base leading-relaxed max-w-xl mb-6">"<?php echo nl2br(htmlspecialchars($user_data['bio'])); ?>"</p>
                        
                        <?php if(!empty($user_data['booking_url']) || !empty($user_data['cv_file'])): ?>
                        <div class="flex flex-wrap justify-center md:justify-start gap-3">
                            <?php if(!empty($user_data['booking_url'])): ?>
                                <a href="<?php echo htmlspecialchars($user_data['booking_url']); ?>" target="_blank" class="px-5 py-2 bg-brand-500 hover:bg-brand-600 text-white rounded-md font-bold transition-all shadow-sm flex items-center gap-2 text-sm"><i class='bx bx-calendar-event text-lg'></i> Schedule Call</a>
                            <?php endif; ?>
                            
                            <?php if(!empty($user_data['cv_file'])): ?>
                                <a href="/static/uploads/<?php echo htmlspecialchars($user_data['cv_file']); ?>" download class="px-5 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-emerald-500 rounded-md font-bold transition-all flex items-center gap-2 text-sm"><i class='bx <?php echo $downloadIcon; ?> text-lg'></i> <?php echo $downloadText; ?></a>
                            <?php endif; ?>
                        </div>
                        <?php endif; ?>
                    </div>
                </div>

                <div class="grid grid-cols-1 md:grid-cols-3 gap-12">
                    <div class="md:col-span-2">
                        <?php if(!empty($user_data['detailed_bio'])): ?>
                            <h3 class="text-xs font-bold uppercase tracking-widest mb-6 opacity-50 border-l-2 border-current pl-3">Profile</h3>
                            <div class="text-sm leading-loose opacity-85 space-y-4">
                                <?php echo nl2br(htmlspecialchars($user_data['detailed_bio'])); ?>
                            </div>
                        <?php endif; ?>
                    </div>
                    
                    <div>
                        <h3 class="text-xs font-bold uppercase tracking-widest mb-6 opacity-50 border-l-2 border-current pl-3">Contact & Links</h3>
                        <div class="flex flex-col gap-3">
                            <?php if(!empty($user_links)): ?>
                                <?php foreach($user_links as $link): ?>
                                    <a href="<?php echo htmlspecialchars($link['url']); ?>" target="_blank" rel="noopener noreferrer" onclick="trackClick(<?php echo $link['id']; ?>)" class="group flex items-center gap-3 text-sm font-semibold opacity-80 hover:opacity-100 transition-opacity">
                                        <?php if(!empty($link['icon_class'])): ?><i class='<?php echo htmlspecialchars($link['icon_class']); ?> text-xl'></i><?php endif; ?>
                                        <span class="border-b border-transparent group-hover:border-current transition-colors pb-0.5"><?php echo htmlspecialchars($link['title']); ?></span>
                                    </a>
                                <?php endforeach; ?>
                            <?php endif; ?>
                        </div>
                    </div>
                </div>

            </div>
        </div>
    <?php endif; ?>

    <?php if(!$user_data['hide_branding']): ?>
    <a href="https://on-your.site" target="_blank" class="mt-auto pt-16 text-xs font-medium tracking-wide flex items-center gap-1 transition-colors opacity-40 hover:opacity-100 z-10 <?php echo $textClass; ?>">
        <i class='bx bx-hive text-base'></i> Powered by On Your Site
    </a>
    <?php endif; ?>

    <script>
    function trackClick(linkId) {
        fetch('/track-click', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ link_id: linkId })
        }).catch(err => console.error("Tracking Error:", err));
    }
    </script>
</body>
</html>