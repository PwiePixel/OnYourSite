<div id="tab-integrations" class="tab-content max-w-4xl mx-auto space-y-8 hidden pb-12">
    <section>
        <h2 class="text-xl font-bold text-white mb-6">Integrations & Downloads</h2>
        
        <div class="bg-card border border-bordercolor rounded-xl p-6 space-y-8 shadow-lg">
            
            <div>
                <div class="flex items-center justify-between mb-2">
                    <label class="block text-sm font-medium text-brand-400 flex items-center gap-2">
                        <i class='bx bx-calendar-event text-xl'></i> Booking & Meetings
                    </label>
                    <?php if($user_data['booking_url'] === '/kalender'): ?>
                        <span class="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] uppercase font-bold px-2 py-0.5 rounded flex items-center gap-1"><i class='bx bx-check'></i> Native Calendar Active</span>
                    <?php endif; ?>
                </div>
                
                <!-- ACHTUNG: type="text" statt type="url", damit '/kalender' beim Speichern nicht blockiert wird -->
                <input type="text" name="booking_url" value="<?php echo htmlspecialchars($user_data['booking_url'] ?? ''); ?>" placeholder="e.g. https://calendly.com/your-name or /kalender" class="w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm transition-all shadow-inner">
                
                <p class="text-xs text-gray-400 mt-3 p-3 bg-white/5 rounded-lg border border-white/5 leading-relaxed">
                    <strong class="text-white">Want to accept bookings?</strong> Paste your external link (like Calendly) here. <br>
                    <span class="text-brand-400">💡 Pro Tip:</span> Type <code class="bg-black px-1.5 py-0.5 rounded font-mono text-[10px] border border-white/10">/kalender</code> into the field to use our built-in native booking system! <strong>Leave empty to hide the button completely.</strong>
                </p>
            </div>
            
            <hr class="border-bordercolor">
            
            <div>
                <label class="block text-sm font-medium text-emerald-400 mb-2 flex items-center gap-2">
                    <i class='bx bx-cloud-download text-xl'></i> Downloadable File
                </label>
                <p class="text-xs text-gray-400 mb-4">Provide a file for your visitors to download. Allowed formats: <strong>.pdf</strong> (Resume/CV) or <strong>.vcf</strong> (Contact Card).</p>
                
                <div class="flex flex-col sm:flex-row sm:items-center gap-4">
                    <input type="file" name="cv_file" id="cvUpload" accept=".pdf,.vcf" class="hidden">
                    <label for="cvUpload" class="cursor-pointer flex items-center justify-center gap-2 px-5 py-2.5 bg-inputbg hover:bg-white/5 rounded-lg text-sm font-medium transition-colors border border-bordercolor text-white shadow-sm w-fit">
                        <i class='bx bx-upload text-lg'></i> Select File
                    </label>
                    
                    <?php if(!empty($user_data['cv_file'])): ?>
                    <div class="flex items-center gap-2 text-sm text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-4 py-2 rounded-lg">
                        <i class='bx bxs-file'></i> File active 
                        <label class="ml-3 flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300 cursor-pointer border-l border-emerald-500/30 pl-3 transition-colors">
                            <input type="checkbox" name="delete_cv_file" value="1" class="w-3.5 h-3.5 rounded border-red-500 bg-black text-red-500 focus:ring-red-500"> 
                            Delete
                        </label>
                    </div>
                    <?php endif; ?>
                </div>
            </div>

        </div>
    </section>

    <section class="mt-12">
        <h2 class="text-xl font-bold text-white mb-6 flex items-center gap-2"><i class='bx bx-calendar'></i> Your Incoming Bookings</h2>
        
        <div class="bg-card border border-bordercolor rounded-xl overflow-hidden shadow-lg">
            <?php if(empty($user_bookings)): ?>
                <div class="p-8 text-center text-gray-500">
                    <i class='bx bx-calendar-x text-5xl mb-3 opacity-20'></i>
                    <p class="text-sm">No bookings yet. Share your profile to get your first meeting!</p>
                </div>
            <?php else: ?>
                <div class="overflow-x-auto">
                    <table class="w-full text-left">
                        <thead>
                            <tr class="bg-inputbg/50 border-b border-bordercolor text-xs uppercase text-gray-500 tracking-wider">
                                <th class="px-6 py-4 font-semibold">Date & Time</th>
                                <th class="px-6 py-4 font-semibold">Guest Details</th>
                                <th class="px-6 py-4 font-semibold">Status</th>
                                <th class="px-6 py-4 text-right font-semibold">Action</th>
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-bordercolor">
                            <?php foreach($user_bookings as $book): ?>
                            <tr class="hover:bg-white/5 transition-colors">
                                <td class="px-6 py-4">
                                    <div class="text-white font-medium text-sm mb-1"><?php echo date('M j, Y', strtotime($book['booking_date'])); ?></div>
                                    <div class="text-brand-400 text-xs flex items-center gap-1"><i class='bx bx-time-five'></i> <?php echo htmlspecialchars($book['booking_time']); ?></div>
                                </td>
                                <td class="px-6 py-4">
                                    <div class="text-white text-sm font-medium mb-1"><?php echo htmlspecialchars($book['guest_name']); ?></div>
                                    <a href="mailto:<?php echo htmlspecialchars($book['guest_email']); ?>" class="text-gray-500 text-xs hover:text-white transition-colors flex items-center gap-1"><i class='bx bx-envelope'></i> <?php echo htmlspecialchars($book['guest_email']); ?></a>
                                </td>
                                <td class="px-6 py-4">
                                    <span class="bg-yellow-500/10 text-yellow-500 border border-yellow-500/20 text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wider">Pending</span>
                                </td>
                                <td class="px-6 py-4 text-right">
                                    <form action="/dashboard" method="POST" onsubmit="return confirm('Delete this booking?');">
                                        <input type="hidden" name="delete_booking_id" value="<?php echo $book['id']; ?>">
                                        <button type="submit" class="text-gray-500 hover:text-red-400 p-2 rounded-md transition-colors"><i class='bx bx-trash text-lg'></i></button>
                                    </form>
                                </td>
                            </tr>
                            <?php endforeach; ?>
                        </tbody>
                    </table>
                </div>
            <?php endif; ?>
        </div>
    </section>
</div>