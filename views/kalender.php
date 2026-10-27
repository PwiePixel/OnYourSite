<?php
// Basis-Klassen (Theme Logik, identisch zum Profil)
$bgClass = "bg-[#09090b]";
$textClass = "text-white";
$cardClass = "bg-white/5 border border-white/10 backdrop-blur-xl shadow-2xl rounded-[2rem]";
$btnClass = "bg-white/10 hover:bg-white/20 border border-white/20 text-white shadow-lg";
$inputClass = "bg-black/40 border border-white/20 text-white focus:border-white placeholder-white/40";

if ($user_data['theme'] === 'midnight') { $bgClass = "bg-gradient-to-br from-indigo-900 via-purple-900 to-black"; }
if ($user_data['theme'] === 'forest') { $bgClass = "bg-gradient-to-br from-emerald-900 to-teal-900"; }
if ($user_data['theme'] === 'sunset') { $bgClass = "bg-gradient-to-br from-rose-900 to-orange-900"; }
if ($user_data['theme'] === 'ocean') { $bgClass = "bg-gradient-to-t from-blue-900 to-cyan-900"; }
if ($user_data['theme'] === 'cherry') { $bgClass = "bg-gradient-to-r from-pink-900 to-rose-900"; }

if ($user_data['theme'] === 'glass') { 
    $bgClass = "bg-gradient-to-tr from-gray-100 to-gray-300"; $textClass = "text-gray-900"; 
    $cardClass = "bg-white/40 border border-white/50 backdrop-blur-2xl shadow-xl rounded-[2rem]";
    $btnClass = "bg-white/50 hover:bg-white/80 border border-white/60 text-gray-900";
    $inputClass = "bg-white/50 border border-white/60 text-gray-900 focus:border-gray-500 placeholder-gray-500";
}
if ($user_data['theme'] === 'minimal') { 
    $bgClass = "bg-gray-50"; $textClass = "text-black"; 
    $cardClass = "bg-white border border-gray-200 shadow-2xl rounded-[2rem]";
    $btnClass = "bg-black hover:bg-gray-800 text-white border border-black";
    $inputClass = "bg-white border border-gray-300 text-black focus:border-black placeholder-gray-400";
}
if ($user_data['theme'] === 'cyberpunk') { 
    $bgClass = "bg-[#fcee0a]"; $textClass = "text-black font-semibold";
    $cardClass = "bg-[#fcee0a] border-[6px] border-black rounded-none shadow-[12px_12px_0px_0px_rgba(0,0,0,1)]";
    $btnClass = "bg-black hover:bg-gray-900 border-2 border-black text-[#fcee0a] rounded-none shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] uppercase";
    $inputClass = "bg-white border-4 border-black text-black focus:border-black placeholder-gray-500 rounded-none shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]";
}
if ($user_data['theme'] === 'hacker') { 
    $bgClass = "bg-black"; $textClass = "text-green-500 font-mono"; 
    $cardClass = "bg-black border border-green-500 rounded-none shadow-[0_0_30px_rgba(34,197,94,0.15)]";
    $btnClass = "bg-green-500 hover:bg-green-600 text-black border border-green-500 rounded-none font-mono";
    $inputClass = "bg-black border border-green-500 text-green-400 focus:border-green-400 placeholder-green-700 rounded-none font-mono";
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Book a Meeting | <?php echo htmlspecialchars($user_data['full_name']); ?></title>
    <link rel="icon" type="image/png" href="/static/images/favicon.png">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Fira+Code:wght@400;600&display=swap" rel="stylesheet">
    <link href='https://unpkg.com/boxicons@2.1.4/css/boxicons.min.css' rel='stylesheet'>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { font-family: 'Inter', sans-serif; }
        <?php if($user_data['theme'] === 'hacker') echo "body { font-family: 'Fira Code', monospace; }"; ?>
        <?php echo htmlspecialchars_decode($user_data['custom_css'] ?? ''); ?>
    </style>
</head>
<body class="<?php echo $bgClass; ?> <?php echo $textClass; ?> min-h-screen flex items-center justify-center p-4">

    <?php if(!empty($user_data['bg_image'])): ?>
        <div class="fixed inset-0 z-0 pointer-events-none" style="background-image: url('/static/uploads/<?php echo htmlspecialchars($user_data['bg_image']); ?>'); background-size: cover; background-position: center; <?php echo ($user_data['theme'] === 'glass' || $user_data['theme'] === 'minimal') ? 'opacity-30' : 'opacity-50 mix-blend-overlay'; ?>"></div>
    <?php endif; ?>

    <div class="w-full max-w-lg relative z-10 <?php echo $cardClass; ?> p-8 md:p-10">
        
        <a href="https://<?php echo htmlspecialchars($user_data['username']); ?>.on-your.site" class="inline-flex items-center gap-2 text-sm font-semibold opacity-60 hover:opacity-100 transition-opacity mb-8 border-b border-transparent hover:border-current pb-0.5">
            <i class='bx bx-left-arrow-alt text-lg'></i> Back to Profile
        </a>

        <div class="flex items-center gap-4 mb-8">
            <div class="w-16 h-16 rounded-full overflow-hidden shrink-0 border border-current/20">
                <?php if(!empty($user_data['profile_image'])): ?>
                    <img src="/static/uploads/<?php echo htmlspecialchars($user_data['profile_image']); ?>" class="w-full h-full object-cover">
                <?php else: ?>
                    <div class="w-full h-full bg-black/20 flex items-center justify-center"><i class='bx bx-user text-2xl'></i></div>
                <?php endif; ?>
            </div>
            <div>
                <h1 class="text-2xl font-black tracking-tight">Book a Meeting</h1>
                <p class="text-sm opacity-70">with <?php echo htmlspecialchars($user_data['full_name']); ?></p>
            </div>
        </div>

        <?php if(isset($_SESSION['booking_success'])): ?>
            <div class="p-6 rounded-2xl bg-green-500/20 border border-green-500/40 text-center mb-6">
                <i class='bx bx-check-circle text-4xl text-green-500 mb-2'></i>
                <h3 class="font-bold text-lg mb-1">Request Sent!</h3>
                <p class="text-sm opacity-80"><?php echo $_SESSION['booking_success']; unset($_SESSION['booking_success']); ?></p>
            </div>
        <?php else: ?>
            
            <?php if(isset($_SESSION['booking_error'])): ?>
                <div class="p-4 mb-6 rounded-xl bg-red-500/20 border border-red-500/40 text-red-500 text-sm font-semibold text-center">
                    <?php echo $_SESSION['booking_error']; unset($_SESSION['booking_error']); ?>
                </div>
            <?php endif; ?>

            <form action="/kalender" method="POST" class="space-y-5">
                <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
                    <div>
                        <label class="block text-sm font-bold opacity-80 mb-1.5">Your Name</label>
                        <input type="text" name="guest_name" required class="w-full px-4 py-3 outline-none transition-all <?php echo $inputClass; ?>" placeholder="John Doe">
                    </div>
                    <div>
                        <label class="block text-sm font-bold opacity-80 mb-1.5">Your Email</label>
                        <input type="email" name="guest_email" required class="w-full px-4 py-3 outline-none transition-all <?php echo $inputClass; ?>" placeholder="john@example.com">
                    </div>
                </div>
                
                <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
                    <div>
                        <label class="block text-sm font-bold opacity-80 mb-1.5">Preferred Date</label>
                        <input type="date" name="booking_date" required min="<?php echo date('Y-m-d'); ?>" class="w-full px-4 py-3 outline-none transition-all <?php echo $inputClass; ?>">
                    </div>
                    <div>
                        <label class="block text-sm font-bold opacity-80 mb-1.5">Time</label>
                        <select name="booking_time" required class="w-full px-4 py-3 outline-none transition-all appearance-none <?php echo $inputClass; ?>">
                            <option value="" disabled selected>Select time...</option>
                            <option value="09:00">09:00 AM</option>
                            <option value="10:00">10:00 AM</option>
                            <option value="11:00">11:00 AM</option>
                            <option value="13:00">01:00 PM</option>
                            <option value="14:00">02:00 PM</option>
                            <option value="15:00">03:00 PM</option>
                            <option value="16:00">04:00 PM</option>
                        </select>
                    </div>
                </div>

                <div class="pt-4">
                    <button type="submit" class="w-full py-4 font-black tracking-wide transition-all duration-300 flex items-center justify-center gap-2 <?php echo $btnClass; ?>">
                        <i class='bx bx-calendar-check text-xl'></i> Request Appointment
                    </button>
                </div>
            </form>
        <?php endif; ?>

    </div>
</body>
</html>