<?php
// Admin: Updates, Roadmap und Discord (eingebunden in views/admin.php)
/** @var PDO $pdo */
$discordSettings = oys_discord_settings($pdo);
$discordReady = oys_discord_configured($discordSettings);
$allUpdates = oys_updates_list($pdo, false, 300);
$allMilestones = oys_milestones($pdo, false);
$editUpdate = isset($_GET['edit_update']) ? oys_update_get($pdo, (int) $_GET['edit_update']) : null;
$prefillMs = isset($_GET['new_update_for']) ? oys_milestone_get($pdo, (int) $_GET['new_update_for']) : null;
$editMilestone = isset($_GET['edit_milestone']) ? oys_milestone_get($pdo, (int) $_GET['edit_milestone']) : null;

$in = 'w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm';
$lbl = 'block text-sm font-medium text-gray-300 mb-1.5';
$btn = 'inline-flex items-center gap-1.5 px-3 py-2 min-h-[36px] rounded-lg text-xs font-medium border border-bordercolor text-gray-300 hover:text-white hover:bg-white/5 transition-colors';
$fmt = function ($d) { return $d ? date('M j, Y', strtotime((string) $d)) : '—'; };

$uf = $editUpdate ?: [
    'id' => 0,
    'title' => $prefillMs ? 'Shipped: ' . $prefillMs['title'] : '',
    'body' => $prefillMs ? $prefillMs['description'] : '',
    'version' => '', 'category' => 'new', 'milestone_id' => $prefillMs ? $prefillMs['id'] : null,
    'is_published' => false, 'published_at' => null, 'discord_message_id' => '',
];
$ufDate = $uf['published_at'] ? substr((string) $uf['published_at'], 0, 10) : date('Y-m-d');
$mf = $editMilestone ?: ['id' => 0, 'title' => '', 'description' => '', 'status' => 'next', 'target' => '', 'is_public' => true];

$byStatus = ['now' => [], 'next' => [], 'planned' => [], 'done' => []];
foreach ($allMilestones as $m) {
    $byStatus[$m['status']][] = $m;
}
$hook = $discordSettings['webhook_url'] !== '' ? oys_discord_parse_webhook($discordSettings['webhook_url']) : null;
$maskedHook = $hook ? 'https://discord.com/api/webhooks/' . $hook[0] . '/••••••••' : '';
$maskedToken = $discordSettings['bot_token'] !== '' ? '••••••••' . substr($discordSettings['bot_token'], -4) : '';
?>
            <!-- ===================== Updates ===================== -->
            <div id="tab-updates" class="admin-tab-content max-w-5xl mx-auto space-y-8 hidden">
                <div class="bg-card border border-bordercolor rounded-xl shadow-xl p-5 sm:p-6">
                    <div class="flex flex-wrap items-center justify-between gap-3 mb-6 border-b border-bordercolor pb-4">
                        <h2 class="text-base font-semibold text-white flex items-center gap-2"><i class='bx bx-edit text-xl text-sky-400'></i> <?= $editUpdate ? 'Edit update' : 'Write an update' ?></h2>
                        <a href="/updates" target="_blank" rel="noopener" class="text-sm text-gray-400 hover:text-white flex items-center gap-1 py-2">View /updates <i class='bx bx-link-external'></i></a>
                    </div>
                    <form action="/admin" method="POST" class="space-y-5">
                        <?= oys_csrf_field() ?>
                        <input type="hidden" name="oys_action" value="update_save">
                        <input type="hidden" name="id" value="<?= (int) $uf['id'] ?>">
                        <div>
                            <label class="<?= $lbl ?>" for="uTitle">Title</label>
                            <input id="uTitle" type="text" name="title" required maxlength="160" value="<?= e($uf['title']) ?>" placeholder="e.g. New themes and a faster editor" class="<?= $in ?>">
                        </div>
                        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            <div>
                                <label class="<?= $lbl ?>" for="uVersion">Version <span class="text-gray-500 font-normal">(optional)</span></label>
                                <input id="uVersion" type="text" name="version" maxlength="40" value="<?= e($uf['version']) ?>" placeholder="e.g. 2.3" class="<?= $in ?>">
                            </div>
                            <div>
                                <label class="<?= $lbl ?>" for="uCategory">Category</label>
                                <select id="uCategory" name="category" class="<?= $in ?>">
                                    <?php foreach (OYS_UPDATE_CATEGORIES as $key => $cat): ?>
                                    <option value="<?= e($key) ?>"<?= $uf['category'] === $key ? ' selected' : '' ?>><?= e($cat['label']) ?></option>
                                    <?php endforeach; ?>
                                </select>
                            </div>
                            <div>
                                <label class="<?= $lbl ?>" for="uDate">Date</label>
                                <input id="uDate" type="date" name="date" value="<?= e($ufDate) ?>" class="<?= $in ?>">
                            </div>
                        </div>
                        <div>
                            <label class="<?= $lbl ?>" for="uMilestone">Milestone <span class="text-gray-500 font-normal">(optional)</span></label>
                            <select id="uMilestone" name="milestone_id" class="<?= $in ?>">
                                <option value="0">— none —</option>
                                <?php foreach ($allMilestones as $m): ?>
                                <option value="<?= $m['id'] ?>"<?= (int) $uf['milestone_id'] === $m['id'] ? ' selected' : '' ?>><?= e($m['title']) ?> (<?= e(OYS_MILESTONE_STATUSES[$m['status']]['short']) ?>)</option>
                                <?php endforeach; ?>
                            </select>
                        </div>
                        <div>
                            <label class="<?= $lbl ?>" for="uBody">Text</label>
                            <textarea id="uBody" name="body" rows="10" maxlength="20000" placeholder="What changed? Lists with “- ”, **bold**, *italic*, `code`, [links](https://…)" class="<?= $in ?> font-mono leading-relaxed"><?= e($uf['body']) ?></textarea>
                            <p class="text-xs text-gray-500 mt-1.5">Same formatting as in Discord: <code>**bold**</code>, <code>*italic*</code>, <code>- list</code>, <code>[text](https://…)</code>, <code>`code`</code>.</p>
                        </div>
                        <div class="flex flex-col sm:flex-row sm:items-center gap-4 pt-2 border-t border-bordercolor">
                            <div class="flex gap-4 text-sm pt-3 sm:pt-4">
                                <label class="flex items-center gap-2 cursor-pointer"><input type="radio" name="publish" value="1" class="accent-brand-500"<?= $uf['is_published'] || !$editUpdate ? ' checked' : '' ?>> Publish</label>
                                <label class="flex items-center gap-2 cursor-pointer"><input type="radio" name="publish" value=""<?= $editUpdate && !$uf['is_published'] ? ' checked' : '' ?> class="accent-brand-500"> Save as draft</label>
                            </div>
                            <div class="sm:pt-4 text-sm">
                                <?php if (!$discordReady): ?>
                                <span class="text-gray-500 flex items-center gap-1.5"><i class='bx bxl-discord-alt text-lg'></i> Connect Discord under <a href="#discord" onclick="switchAdminTab('discord')" class="text-brand-400 hover:text-white">Discord</a> to announce updates.</span>
                                <?php elseif ($uf['discord_message_id'] !== ''): ?>
                                <span class="text-emerald-400 flex items-center gap-1.5"><i class='bx bxl-discord-alt text-lg'></i> Already on Discord – changes are synced, drafts are removed there.</span>
                                <?php else: ?>
                                <label class="flex items-center gap-2 cursor-pointer text-gray-300"><input type="checkbox" name="post_discord" value="1" class="accent-[#5865F2]"<?= $discordSettings['auto_post'] ? ' checked' : '' ?>> <i class='bx bxl-discord-alt text-lg text-[#5865F2]'></i> Announce on Discord when published</label>
                                <?php endif; ?>
                            </div>
                        </div>
                        <div class="flex flex-wrap justify-end gap-3">
                            <?php if ($editUpdate || $prefillMs): ?><a href="/admin#updates" class="px-4 py-2.5 rounded-lg text-sm font-medium text-gray-400 hover:bg-white/5">Cancel</a><?php endif; ?>
                            <button type="submit" class="bg-white text-black hover:bg-gray-200 font-bold py-2.5 px-6 rounded-lg transition-all flex items-center gap-2"><i class='bx bx-save'></i> <?= $editUpdate ? 'Save changes' : 'Save update' ?></button>
                        </div>
                    </form>
                </div>

                <div class="bg-card border border-bordercolor rounded-xl shadow-xl overflow-hidden">
                    <div class="flex items-center justify-between px-5 sm:px-6 py-4 border-b border-bordercolor">
                        <h2 class="text-base font-semibold text-white">All updates</h2>
                        <span class="text-xs text-gray-500"><?= count(array_filter($allUpdates, function ($u) { return $u['is_published']; })) ?> published · <?= count(array_filter($allUpdates, function ($u) { return !$u['is_published']; })) ?> drafts</span>
                    </div>
                    <?php if (!$allUpdates): ?>
                    <p class="px-6 py-10 text-center text-sm text-gray-500">No updates yet. Write your first one above.</p>
                    <?php endif; ?>
                    <ul class="divide-y divide-bordercolor">
                        <?php foreach ($allUpdates as $u): $cat = OYS_UPDATE_CATEGORIES[$u['category']]; ?>
                        <li class="px-5 sm:px-6 py-4 flex flex-col lg:flex-row lg:items-center gap-3">
                            <div class="min-w-0 flex-1">
                                <div class="flex flex-wrap items-center gap-2">
                                    <?php if ($u['is_published']): ?><span class="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400">Published</span><?php else: ?><span class="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-white/10 text-gray-400">Draft</span><?php endif; ?>
                                    <span class="text-[10px] font-bold uppercase px-2 py-0.5 rounded" style="color:<?= e($cat['color']) ?>;background:<?= e($cat['color']) ?>22"><?= e($cat['label']) ?></span>
                                    <?php if ($u['discord_message_id'] !== ''): ?><span class="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-[#5865F2]/20 text-[#8b93ff] flex items-center gap-1"><i class='bx bxl-discord-alt'></i> On Discord</span><?php endif; ?>
                                </div>
                                <p class="mt-1.5 text-white font-medium truncate"><?= e($u['title']) ?></p>
                                <p class="text-xs text-gray-500 mt-0.5"><?= e($fmt($u['published_at'])) ?><?= $u['version'] !== '' ? ' · v' . e(ltrim($u['version'], 'vV')) : '' ?></p>
                            </div>
                            <div class="flex flex-wrap gap-2 shrink-0">
                                <a href="/admin?edit_update=<?= $u['id'] ?>#updates" class="<?= $btn ?>"><i class='bx bx-edit-alt'></i> Edit</a>
                                <?php if ($u['is_published']): ?><a href="/updates#update-<?= $u['id'] ?>" target="_blank" rel="noopener" class="<?= $btn ?>"><i class='bx bx-show'></i> View</a><?php endif; ?>
                                <form action="/admin" method="POST" class="m-0"><?= oys_csrf_field() ?><input type="hidden" name="oys_action" value="update_publish"><input type="hidden" name="id" value="<?= $u['id'] ?>"><input type="hidden" name="state" value="<?= $u['is_published'] ? '' : '1' ?>">
                                    <button type="submit" class="<?= $btn ?>"><i class='bx <?= $u['is_published'] ? 'bx-hide' : 'bx-send' ?>'></i> <?= $u['is_published'] ? 'Unpublish' : 'Publish' ?></button></form>
                                <?php if ($u['is_published'] && $discordReady && $u['discord_message_id'] === ''): ?>
                                <form action="/admin" method="POST" class="m-0"><?= oys_csrf_field() ?><input type="hidden" name="oys_action" value="update_discord"><input type="hidden" name="id" value="<?= $u['id'] ?>">
                                    <button type="submit" class="<?= $btn ?> text-[#8b93ff]"><i class='bx bxl-discord-alt'></i> Post to Discord</button></form>
                                <?php endif; ?>
                                <form action="/admin" method="POST" class="m-0" onsubmit="return confirm('Delete this update<?= $u['discord_message_id'] !== '' ? ' and its Discord post' : '' ?>?');"><?= oys_csrf_field() ?><input type="hidden" name="oys_action" value="update_delete"><input type="hidden" name="id" value="<?= $u['id'] ?>">
                                    <button type="submit" class="<?= $btn ?> hover:text-red-400" title="Delete"><i class='bx bx-trash'></i></button></form>
                            </div>
                        </li>
                        <?php endforeach; ?>
                    </ul>
                </div>
            </div>

            <!-- ===================== Roadmap ===================== -->
            <div id="tab-roadmap" class="admin-tab-content max-w-6xl mx-auto space-y-8 hidden">
                <div class="bg-card border border-bordercolor rounded-xl shadow-xl p-5 sm:p-6">
                    <div class="flex flex-wrap items-center justify-between gap-3 mb-6 border-b border-bordercolor pb-4">
                        <h2 class="text-base font-semibold text-white flex items-center gap-2"><i class='bx bx-map-alt text-xl text-amber-400'></i> <?= $editMilestone ? 'Edit milestone' : 'Add a milestone' ?></h2>
                        <a href="/updates#roadmap" target="_blank" rel="noopener" class="text-sm text-gray-400 hover:text-white flex items-center gap-1 py-2">View roadmap <i class='bx bx-link-external'></i></a>
                    </div>
                    <form action="/admin" method="POST" class="space-y-5">
                        <?= oys_csrf_field() ?>
                        <input type="hidden" name="oys_action" value="milestone_save">
                        <input type="hidden" name="id" value="<?= (int) $mf['id'] ?>">
                        <div class="grid grid-cols-1 sm:grid-cols-[1fr_180px_160px] gap-4">
                            <div>
                                <label class="<?= $lbl ?>" for="mTitle">Title</label>
                                <input id="mTitle" type="text" name="title" required maxlength="160" value="<?= e($mf['title']) ?>" placeholder="e.g. Custom domains" class="<?= $in ?>">
                            </div>
                            <div>
                                <label class="<?= $lbl ?>" for="mStatus">Status</label>
                                <select id="mStatus" name="status" class="<?= $in ?>">
                                    <?php foreach (OYS_MILESTONE_STATUSES as $key => $st): ?>
                                    <option value="<?= e($key) ?>"<?= $mf['status'] === $key ? ' selected' : '' ?>><?= e($st['label']) ?></option>
                                    <?php endforeach; ?>
                                </select>
                            </div>
                            <div>
                                <label class="<?= $lbl ?>" for="mTarget">Target <span class="text-gray-500 font-normal">(rough)</span></label>
                                <input id="mTarget" type="text" name="target" maxlength="40" value="<?= e($mf['target']) ?>" placeholder="e.g. Q1 2027" class="<?= $in ?>">
                            </div>
                        </div>
                        <div>
                            <label class="<?= $lbl ?>" for="mDesc">Description <span class="text-gray-500 font-normal">(optional)</span></label>
                            <textarea id="mDesc" name="description" rows="3" maxlength="4000" placeholder="What is it and why does it matter?" class="<?= $in ?>"><?= e($mf['description']) ?></textarea>
                        </div>
                        <div>
                            <label class="<?= $lbl ?>" for="mTasks"><?= $editMilestone ? 'Add tasks' : 'Tasks' ?> <span class="text-gray-500 font-normal">(one per line – the progress bar is based on these)</span></label>
                            <textarea id="mTasks" name="tasks" rows="4" placeholder="Design the settings page&#10;Connect the DNS check&#10;[x] Write the docs" class="<?= $in ?> font-mono"></textarea>
                        </div>
                        <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                            <label class="flex items-center gap-2 text-sm text-gray-300 cursor-pointer"><input type="checkbox" name="is_public" value="1" class="accent-brand-500"<?= $mf['is_public'] ? ' checked' : '' ?>> Show on the public roadmap</label>
                            <div class="flex gap-3 justify-end">
                                <?php if ($editMilestone): ?><a href="/admin#roadmap" class="px-4 py-2.5 rounded-lg text-sm font-medium text-gray-400 hover:bg-white/5">Cancel</a><?php endif; ?>
                                <button type="submit" class="bg-white text-black hover:bg-gray-200 font-bold py-2.5 px-6 rounded-lg transition-all flex items-center gap-2"><i class='bx bx-save'></i> <?= $editMilestone ? 'Save changes' : 'Add milestone' ?></button>
                            </div>
                        </div>
                    </form>
                </div>

                <div class="grid gap-6 lg:grid-cols-2 xl:grid-cols-4">
                    <?php foreach (OYS_MILESTONE_STATUSES as $status => $st): ?>
                    <div class="min-w-0">
                        <div class="flex items-center gap-2 mb-3">
                            <span class="w-2.5 h-2.5 rounded-full" style="background:<?= e($st['color']) ?>"></span>
                            <h3 class="text-sm font-semibold text-white uppercase tracking-wider"><?= e($st['label']) ?></h3>
                            <span class="text-xs text-gray-500"><?= count($byStatus[$status]) ?></span>
                        </div>
                        <div class="space-y-4">
                            <?php if (!$byStatus[$status]): ?><div class="rounded-xl border border-dashed border-bordercolor p-4 text-xs text-gray-500">Empty</div><?php endif; ?>
                            <?php foreach ($byStatus[$status] as $i => $m): $p = $m['progress']; ?>
                            <div class="bg-card border border-bordercolor rounded-xl p-4">
                                <div class="flex items-start justify-between gap-2">
                                    <p class="font-semibold text-white leading-snug min-w-0"><?= e($m['title']) ?></p>
                                    <?php if (!$m['is_public']): ?><span class="shrink-0 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-white/10 text-gray-400" title="Not shown on /updates">Hidden</span><?php endif; ?>
                                </div>
                                <?php if ($m['target'] !== ''): ?><p class="text-xs text-gray-500 mt-1">Target: <?= e($m['target']) ?></p><?php endif; ?>
                                <?php if ($p): ?>
                                <div class="mt-3">
                                    <div class="flex justify-between text-[11px] text-gray-400 mb-1"><span><?= $p['done'] ?>/<?= $p['total'] ?> tasks</span><span><?= $p['percent'] ?>%</span></div>
                                    <div class="h-1.5 rounded-full bg-white/10 overflow-hidden"><div class="h-full rounded-full" style="width:<?= $p['percent'] ?>%;background:<?= e($st['color']) ?>"></div></div>
                                </div>
                                <?php endif; ?>
                                <?php if ($m['tasks']): ?>
                                <ul class="mt-3 space-y-1">
                                    <?php foreach ($m['tasks'] as $t): ?>
                                    <li class="flex items-center gap-1.5 text-sm group">
                                        <form action="/admin" method="POST" class="m-0 min-w-0 flex-1"><?= oys_csrf_field() ?><input type="hidden" name="oys_action" value="task_toggle"><input type="hidden" name="id" value="<?= $t['id'] ?>">
                                            <button type="submit" class="flex items-start gap-2 text-left w-full py-1.5 <?= $t['is_done'] ? 'text-gray-500' : 'text-gray-200' ?>"><i class='bx <?= $t['is_done'] ? 'bx-checkbox-checked text-emerald-400' : 'bx-checkbox text-gray-500' ?> text-xl leading-none shrink-0'></i><span class="<?= $t['is_done'] ? 'line-through' : '' ?> min-w-0 break-words"><?= e($t['title']) ?></span></button></form>
                                        <form action="/admin" method="POST" class="m-0" onsubmit="return confirm('Remove this task?');"><?= oys_csrf_field() ?><input type="hidden" name="oys_action" value="task_delete"><input type="hidden" name="id" value="<?= $t['id'] ?>">
                                            <button type="submit" class="w-8 h-8 inline-flex items-center justify-center text-gray-600 hover:text-red-400" title="Remove task"><i class='bx bx-x'></i></button></form>
                                    </li>
                                    <?php endforeach; ?>
                                </ul>
                                <?php endif; ?>
                                <form action="/admin" method="POST" class="m-0 mt-2 flex gap-2"><?= oys_csrf_field() ?><input type="hidden" name="oys_action" value="task_add"><input type="hidden" name="id" value="<?= $m['id'] ?>">
                                    <input type="text" name="title" maxlength="200" placeholder="Add a task…" class="min-w-0 flex-1 bg-inputbg border border-bordercolor rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:ring-1 focus:ring-brand-500">
                                    <button type="submit" class="px-2.5 rounded-lg border border-bordercolor text-gray-300 hover:text-white hover:bg-white/5" title="Add task"><i class='bx bx-plus'></i></button></form>
                                <div class="mt-3 pt-3 border-t border-bordercolor flex flex-wrap items-center gap-2">
                                    <form action="/admin" method="POST" class="m-0"><?= oys_csrf_field() ?><input type="hidden" name="oys_action" value="milestone_status"><input type="hidden" name="id" value="<?= $m['id'] ?>">
                                        <select name="status" onchange="this.form.submit()" aria-label="Status" class="bg-inputbg border border-bordercolor rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none">
                                            <?php foreach (OYS_MILESTONE_STATUSES as $key => $s2): ?><option value="<?= e($key) ?>"<?= $key === $status ? ' selected' : '' ?>><?= e($s2['label']) ?></option><?php endforeach; ?>
                                        </select></form>
                                    <form action="/admin" method="POST" class="m-0"><?= oys_csrf_field() ?><input type="hidden" name="oys_action" value="milestone_move"><input type="hidden" name="id" value="<?= $m['id'] ?>"><input type="hidden" name="dir" value="up">
                                        <button type="submit" class="w-9 h-9 inline-flex items-center justify-center rounded-lg hover:bg-white/5 text-gray-400 hover:text-white disabled:opacity-30" title="Move up"<?= $i === 0 ? ' disabled' : '' ?>><i class='bx bx-up-arrow-alt'></i></button></form>
                                    <form action="/admin" method="POST" class="m-0"><?= oys_csrf_field() ?><input type="hidden" name="oys_action" value="milestone_move"><input type="hidden" name="id" value="<?= $m['id'] ?>"><input type="hidden" name="dir" value="down">
                                        <button type="submit" class="w-9 h-9 inline-flex items-center justify-center rounded-lg hover:bg-white/5 text-gray-400 hover:text-white disabled:opacity-30" title="Move down"<?= $i === count($byStatus[$status]) - 1 ? ' disabled' : '' ?>><i class='bx bx-down-arrow-alt'></i></button></form>
                                    <a href="/admin?edit_milestone=<?= $m['id'] ?>#roadmap" class="w-9 h-9 inline-flex items-center justify-center rounded-lg hover:bg-white/5 text-gray-400 hover:text-white" title="Edit"><i class='bx bx-edit-alt'></i></a>
                                    <a href="/admin?new_update_for=<?= $m['id'] ?>#updates" class="w-9 h-9 inline-flex items-center justify-center rounded-lg hover:bg-white/5 text-gray-400 hover:text-white" title="Write an update about it"><i class='bx bx-news'></i></a>
                                    <form action="/admin" method="POST" class="m-0 ml-auto" onsubmit="return confirm('Delete this milestone and its tasks?');"><?= oys_csrf_field() ?><input type="hidden" name="oys_action" value="milestone_delete"><input type="hidden" name="id" value="<?= $m['id'] ?>">
                                        <button type="submit" class="w-9 h-9 inline-flex items-center justify-center rounded-lg hover:bg-white/5 text-gray-500 hover:text-red-400" title="Delete"><i class='bx bx-trash'></i></button></form>
                                </div>
                            </div>
                            <?php endforeach; ?>
                        </div>
                    </div>
                    <?php endforeach; ?>
                </div>
            </div>

            <!-- ===================== Discord ===================== -->
            <div id="tab-discord" class="admin-tab-content max-w-4xl mx-auto space-y-8 hidden">
                <div class="bg-card border border-bordercolor rounded-xl shadow-xl p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center gap-4">
                    <span class="w-12 h-12 rounded-xl flex items-center justify-center shrink-0 <?= $discordReady ? 'bg-[#5865F2]/20 text-[#8b93ff]' : 'bg-white/5 text-gray-500' ?>"><i class='bx bxl-discord-alt text-3xl'></i></span>
                    <div class="flex-1 min-w-0">
                        <p class="text-white font-semibold"><?= $discordReady ? 'Discord is connected' : 'Discord isn’t connected yet' ?></p>
                        <p class="text-sm text-gray-400 truncate"><?= $discordReady ? ($discordSettings['mode'] === 'bot' ? 'Via bot · channel ' . e($discordSettings['channel_id']) : 'Via webhook · ' . e($maskedHook)) : 'Paste a webhook link or connect a bot below.' ?></p>
                    </div>
                    <?php if ($discordReady): ?>
                    <div class="flex gap-2">
                        <form action="/admin" method="POST" class="m-0"><?= oys_csrf_field() ?><input type="hidden" name="oys_action" value="discord_test"><button type="submit" class="<?= $btn ?>"><i class='bx bx-paper-plane'></i> Send test</button></form>
                        <form action="/admin" method="POST" class="m-0" onsubmit="return confirm('Disconnect Discord? Saved links and tokens are removed.');"><?= oys_csrf_field() ?><input type="hidden" name="oys_action" value="discord_disconnect"><button type="submit" class="<?= $btn ?> hover:text-red-400"><i class='bx bx-unlink'></i> Disconnect</button></form>
                    </div>
                    <?php endif; ?>
                </div>

                <div class="bg-card border border-bordercolor rounded-xl shadow-xl p-5 sm:p-6">
                    <h2 class="text-base font-semibold text-white mb-5 flex items-center gap-2"><i class='bx bx-cog text-xl text-[#8b93ff]'></i> Settings</h2>
                    <form action="/admin" method="POST" class="space-y-5" id="discordForm">
                        <?= oys_csrf_field() ?>
                        <input type="hidden" name="oys_action" value="discord_save">
                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <label class="flex gap-3 p-4 rounded-xl border border-bordercolor cursor-pointer has-[:checked]:border-[#5865F2] has-[:checked]:bg-[#5865F2]/10">
                                <input type="radio" name="mode" value="webhook" class="mt-1 accent-[#5865F2]"<?= $discordSettings['mode'] !== 'bot' ? ' checked' : '' ?>>
                                <span><span class="block text-white font-medium text-sm">Webhook link</span><span class="block text-xs text-gray-400 mt-0.5">Easiest – no bot needed. Posts into one channel.</span></span>
                            </label>
                            <label class="flex gap-3 p-4 rounded-xl border border-bordercolor cursor-pointer has-[:checked]:border-[#5865F2] has-[:checked]:bg-[#5865F2]/10">
                                <input type="radio" name="mode" value="bot" class="mt-1 accent-[#5865F2]"<?= $discordSettings['mode'] === 'bot' ? ' checked' : '' ?>>
                                <span><span class="block text-white font-medium text-sm">Discord bot</span><span class="block text-xs text-gray-400 mt-0.5">Your own bot posts as itself into a channel.</span></span>
                            </label>
                        </div>
                        <div data-mode="webhook" class="space-y-4">
                            <div>
                                <label class="<?= $lbl ?>" for="dHook">Webhook link</label>
                                <input id="dHook" type="password" name="webhook_url" autocomplete="off" placeholder="<?= e($maskedHook !== '' ? $maskedHook . ' (saved – paste a new one to replace it)' : 'https://discord.com/api/webhooks/…') ?>" class="<?= $in ?>">
                            </div>
                            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div>
                                    <label class="<?= $lbl ?>" for="dName">Name in Discord <span class="text-gray-500 font-normal">(optional)</span></label>
                                    <input id="dName" type="text" name="username" maxlength="80" value="<?= e($discordSettings['username']) ?>" placeholder="OnYourSite Updates" class="<?= $in ?>">
                                </div>
                                <div>
                                    <label class="<?= $lbl ?>" for="dAvatar">Avatar image link <span class="text-gray-500 font-normal">(optional)</span></label>
                                    <input id="dAvatar" type="url" name="avatar_url" value="<?= e($discordSettings['avatar_url']) ?>" placeholder="https://…/logo.png" class="<?= $in ?>">
                                </div>
                            </div>
                        </div>
                        <div data-mode="bot" class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label class="<?= $lbl ?>" for="dToken">Bot token</label>
                                <input id="dToken" type="password" name="bot_token" autocomplete="off" placeholder="<?= e($maskedToken !== '' ? $maskedToken . ' (saved)' : 'From the Developer Portal → Bot') ?>" class="<?= $in ?>">
                            </div>
                            <div>
                                <label class="<?= $lbl ?>" for="dChannel">Channel ID</label>
                                <input id="dChannel" type="text" name="channel_id" inputmode="numeric" value="<?= e($discordSettings['channel_id']) ?>" placeholder="e.g. 1234567890123456789" class="<?= $in ?>">
                            </div>
                        </div>
                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-4 border-t border-bordercolor">
                            <div>
                                <label class="<?= $lbl ?>" for="dMention">Ping <span class="text-gray-500 font-normal">(optional)</span></label>
                                <input id="dMention" type="text" name="mention" maxlength="30" value="<?= e($discordSettings['mention']) ?>" placeholder="Role ID, “everyone” or “here”" class="<?= $in ?>">
                                <p class="text-xs text-gray-500 mt-1.5">Who gets notified when an update is posted. Empty = nobody is pinged.</p>
                            </div>
                            <div>
                                <label class="<?= $lbl ?>" for="dInvite">Invite link for visitors <span class="text-gray-500 font-normal">(optional)</span></label>
                                <input id="dInvite" type="url" name="invite_url" value="<?= e($discordSettings['invite_url']) ?>" placeholder="https://discord.gg/…" class="<?= $in ?>">
                                <p class="text-xs text-gray-500 mt-1.5">Used for “Get updates on Discord” on /updates.</p>
                            </div>
                        </div>
                        <label class="flex items-center gap-2 text-sm text-gray-300 cursor-pointer"><input type="checkbox" name="auto_post" value="1" class="accent-[#5865F2]"<?= $discordSettings['auto_post'] ? ' checked' : '' ?>> Announce new updates on Discord by default</label>
                        <div class="flex justify-end">
                            <button type="submit" class="bg-white text-black hover:bg-gray-200 font-bold py-2.5 px-6 rounded-lg transition-all flex items-center gap-2"><i class='bx bx-save'></i> Save settings</button>
                        </div>
                    </form>
                </div>

                <div class="grid gap-6 md:grid-cols-2">
                    <div class="bg-card border border-bordercolor rounded-xl p-5 text-sm text-gray-400">
                        <h3 class="text-white font-semibold mb-3 flex items-center gap-2"><i class='bx bx-link'></i> Get a webhook link</h3>
                        <ol class="list-decimal pl-5 space-y-1.5">
                            <li>In Discord, open the channel settings (gear icon) of your updates channel.</li>
                            <li><b class="text-gray-300">Integrations → Webhooks → New Webhook</b>.</li>
                            <li>Click <b class="text-gray-300">Copy Webhook URL</b> and paste it above.</li>
                        </ol>
                    </div>
                    <div class="bg-card border border-bordercolor rounded-xl p-5 text-sm text-gray-400">
                        <h3 class="text-white font-semibold mb-3 flex items-center gap-2"><i class='bx bx-bot'></i> Use a bot</h3>
                        <ol class="list-decimal pl-5 space-y-1.5">
                            <li>On <b class="text-gray-300">discord.com/developers</b> create an application → <b class="text-gray-300">Bot</b> → copy the token.</li>
                            <li>Invite the bot to your server with “Send Messages” and “Embed Links”.</li>
                            <li>Enable Developer Mode in Discord, right-click the channel → <b class="text-gray-300">Copy Channel ID</b>.</li>
                        </ol>
                    </div>
                </div>
                <p class="text-xs text-gray-500 text-center">Webhook links and bot tokens are stored encrypted and never shown again.</p>
            </div>
