<?php
// Admin: Speicherort der Uploads und Backups (eingebunden in views/admin.php)
$uploadsDir = oys_uploads_dir();
$external = oys_uploads_external();
$files = oys_storage_files();
$bytes = array_sum($files);
$leftInCode = $external ? count(oys_storage_files(oys_uploads_default_dir())) : 0;
$fmtSize = function (int $b) { return $b >= 1073741824 ? round($b / 1073741824, 2) . ' GB' : ($b >= 1048576 ? round($b / 1048576, 1) . ' MB' : round($b / 1024) . ' KB'); };
$suggested = oys_uploads_suggested_dir();
?>
            <div id="tab-storage" class="admin-tab-content max-w-4xl mx-auto space-y-8 hidden">
                <div class="bg-card border border-bordercolor rounded-xl shadow-xl p-5 sm:p-6">
                    <div class="flex items-center gap-3 mb-5 border-b border-bordercolor pb-4">
                        <i class='bx bx-hdd text-2xl text-teal-400'></i>
                        <h2 class="text-base font-semibold text-white">Upload folder</h2>
                    </div>
                    <p class="text-sm text-gray-400 mb-4">Everything your users upload – profile pictures, backgrounds, gallery images, music and files – is stored in this folder:</p>
                    <div class="flex flex-col sm:flex-row sm:items-center gap-3 bg-inputbg border border-bordercolor rounded-lg px-4 py-3">
                        <code class="text-sm text-white break-all flex-1" id="uploadsDir"><?= e($uploadsDir) ?></code>
                        <?php if ($external): ?>
                        <span class="shrink-0 text-[11px] font-bold uppercase px-2 py-1 rounded bg-emerald-500/15 text-emerald-400 flex items-center gap-1"><i class='bx bx-check-shield'></i> Outside the code – safe from updates</span>
                        <?php else: ?>
                        <span class="shrink-0 text-[11px] font-bold uppercase px-2 py-1 rounded bg-amber-500/15 text-amber-400 flex items-center gap-1"><i class='bx bx-error'></i> Inside the code folder</span>
                        <?php endif; ?>
                    </div>
                    <p class="text-sm text-gray-400 mt-3"><?= count($files) ?> file<?= count($files) === 1 ? '' : 's' ?> · <?= e($fmtSize($bytes)) ?></p>

                    <?php if (!$external): ?>
                    <div class="mt-6 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-gray-300 space-y-2">
                        <p class="font-semibold text-amber-300 flex items-center gap-2"><i class='bx bx-bulb'></i> Keep uploads safe when you update the code</p>
                        <p>Right now the uploads live inside the code folder. If you ever replace that folder (copying in a new version or restoring a code backup), the uploads go with it. Move them next to the code instead:</p>
                        <ol class="list-decimal pl-5 space-y-1">
                            <li>Add this line to <code>config.php</code>: <code class="text-white break-all">'uploads_dir' =&gt; '<?= e($suggested) ?>',</code></li>
                            <li>Come back here and click <b>Move files</b> – all existing uploads are moved there once. Addresses of images don’t change. (If this page still shows the old folder, PHP hasn’t noticed the change yet – wait a minute and reload.)</li>
                        </ol>
                    </div>
                    <?php elseif ($leftInCode > 0): ?>
                    <form action="/admin" method="POST" class="mt-6 rounded-xl border border-sky-500/30 bg-sky-500/5 p-4 text-sm text-gray-300 flex flex-col sm:flex-row sm:items-center gap-3">
                        <?= oys_csrf_field() ?><input type="hidden" name="storage_action" value="move">
                        <p class="flex-1"><b class="text-white"><?= $leftInCode ?> file<?= $leftInCode === 1 ? '' : 's' ?></b> are still in <code>static/uploads/</code> inside the code. Move them to the new folder once.</p>
                        <button type="submit" class="bg-white text-black hover:bg-gray-200 font-bold py-2.5 px-5 rounded-lg transition-all flex items-center justify-center gap-2 shrink-0"><i class='bx bx-transfer'></i> Move files</button>
                    </form>
                    <?php endif; ?>
                </div>

                <div class="bg-card border border-bordercolor rounded-xl shadow-xl p-5 sm:p-6">
                    <div class="flex items-center gap-3 mb-5 border-b border-bordercolor pb-4">
                        <i class='bx bx-archive-in text-2xl text-teal-400'></i>
                        <h2 class="text-base font-semibold text-white">Backups</h2>
                    </div>
                    <p class="text-sm text-gray-400 mb-4">For a complete backup, save these four things. When you restore one, put them back the same way – nobody has to upload anything again.</p>
                    <ul class="space-y-2 text-sm text-gray-300 mb-6">
                        <li class="flex gap-2"><i class='bx bx-data text-lg text-teal-400 shrink-0'></i><span><b class="text-white">The database</b> – in Plesk under <i>Databases → Export dump</i> or via Plesk backups.</span></li>
                        <li class="flex gap-2"><i class='bx bx-images text-lg text-teal-400 shrink-0'></i><span><b class="text-white">The upload folder</b> above – or simply download it here as a ZIP.</span></li>
                        <li class="flex gap-2"><i class='bx bx-key text-lg text-teal-400 shrink-0'></i><span><b class="text-white">config.php</b> – your database password and the encryption key (without the key, encrypted data can’t be read).</span></li>
                        <li class="flex gap-2"><i class='bx bx-envelope text-lg text-teal-400 shrink-0'></i><span><b class="text-white">The folder email/</b> – mail server settings and newsletter templates.</span></li>
                    </ul>
                    <form action="/admin" method="POST" class="m-0">
                        <?= oys_csrf_field() ?><input type="hidden" name="storage_action" value="zip">
                        <button type="submit" class="bg-white text-black hover:bg-gray-200 font-bold py-2.5 px-6 rounded-lg transition-all flex items-center gap-2"<?= $files ? '' : ' disabled' ?>><i class='bx bx-download'></i> Download all uploads (ZIP)</button>
                    </form>
                    <p class="text-xs text-gray-500 mt-3">To restore: unpack the ZIP and copy the files from its “uploads” folder into the upload folder above.</p>
                </div>
            </div>
