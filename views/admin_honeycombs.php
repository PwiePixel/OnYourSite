<?php
// Admin: Honigwaben vergeben, Regeln einstellen, Code-Seiten prüfen und sperren (eingebunden in views/admin.php)
/** @var PDO $pdo */
/** @var array $all_users */
$hcRules = oys_hc_settings($pdo);
$hcBalances = [];
foreach ($pdo->query('SELECT user_id, SUM(amount) AS balance, SUM(GREATEST(amount, 0)) AS earned, SUM(GREATEST(-amount, 0)) AS spent FROM honeycomb_ledger GROUP BY user_id')->fetchAll() as $row) {
    $hcBalances[(int) $row['user_id']] = $row;
}
$hcUnlocked = array_flip(array_map('intval', $pdo->query("SELECT user_id FROM honeycomb_ledger WHERE reason = 'unlock' AND ref = 'code_page'")->fetchAll(PDO::FETCH_COLUMN)));
$hcUsers = $all_users;
usort($hcUsers, function ($a, $b) use ($hcBalances) {
    return (int) ($hcBalances[(int) $b['id']]['balance'] ?? 0) <=> (int) ($hcBalances[(int) $a['id']]['balance'] ?? 0) ?: (int) $b['id'] <=> (int) $a['id'];
});
$codeSites = $pdo->query('SELECT s.*, u.full_name, u.email,
        (SELECT COUNT(*) FROM code_files f WHERE f.site_id = s.id) AS file_count,
        (SELECT COALESCE(SUM(LENGTH(f.content)), 0) FROM code_files f WHERE f.site_id = s.id) AS bytes
    FROM code_sites s JOIN users u ON u.id = s.user_id ORDER BY s.updated_at DESC')->fetchAll();
$hcRecent = $pdo->query('SELECT l.*, u.full_name, u.email FROM honeycomb_ledger l JOIN users u ON u.id = l.user_id ORDER BY l.id DESC LIMIT 25')->fetchAll();

$in = 'w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm';
$lbl = 'block text-sm font-medium text-gray-300 mb-1.5';
$btn = 'inline-flex items-center gap-1.5 px-3 py-2 min-h-[36px] rounded-lg text-xs font-medium border border-bordercolor text-gray-300 hover:text-white hover:bg-white/5 transition-colors';
$userName = function (array $u) { return $u['full_name'] !== '' && $u['full_name'] !== null ? $u['full_name'] : $u['email']; };
$kb = function (int $b) { return $b >= 1048576 ? round($b / 1048576, 1) . ' MB' : max(1, round($b / 1024)) . ' KB'; };
$ruleFields = [
    'daily' => ['Active day', 'For opening the editor (once a day)'],
    'profile' => ['Complete profile', 'Once: profile picture, bio and at least 3 links'],
    'views' => ['Visitors', 'Per step of page views (one step a day, up to ' . OYS_HC_MAX_VIEW_REWARDS . ' times)'],
    'views_step' => ['Views per step', 'How many page views make one step'],
    'code_page' => ['Price: code page', 'What unlocking the code page costs'],
];
?>
            <!-- ===================== Honigwaben ===================== -->
            <div id="tab-honeycombs" class="admin-tab-content max-w-5xl mx-auto space-y-8 hidden">
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    <div class="bg-card border border-bordercolor rounded-xl shadow-xl p-5 sm:p-6">
                        <div class="flex items-center gap-3 mb-5 border-b border-bordercolor pb-4">
                            <i class='bx bx-hive text-2xl text-brand-400'></i>
                            <h2 class="text-base font-semibold text-white">Give honeycombs</h2>
                        </div>
                        <form action="/admin" method="POST" class="space-y-4" id="hcGrantForm">
                            <?= oys_csrf_field() ?>
                            <input type="hidden" name="hc_action" value="grant">
                            <div>
                                <label class="<?= $lbl ?>" for="hcUser">User</label>
                                <select id="hcUser" name="user_id" required class="<?= $in ?>">
                                    <option value="">Choose a user …</option>
                                    <?php foreach ($all_users as $u): ?>
                                    <option value="<?= (int) $u['id'] ?>"><?= e($userName($u)) ?> · <?= e($u['email']) ?> (<?= (int) ($hcBalances[(int) $u['id']]['balance'] ?? 0) ?>)</option>
                                    <?php endforeach; ?>
                                </select>
                            </div>
                            <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
                                <div>
                                    <label class="<?= $lbl ?>" for="hcAmount">Amount</label>
                                    <input id="hcAmount" type="number" name="amount" required min="-100000" max="100000" step="1" placeholder="50" class="<?= $in ?>">
                                </div>
                                <div class="sm:col-span-2">
                                    <label class="<?= $lbl ?>" for="hcNote">Note <span class="text-gray-500 font-normal">(the user sees it)</span></label>
                                    <input id="hcNote" type="text" name="note" maxlength="150" placeholder="e.g. Thanks for your feedback!" class="<?= $in ?>">
                                </div>
                            </div>
                            <p class="text-xs text-gray-500">A negative amount takes honeycombs away (e.g. −20). The balance can’t go below 0.</p>
                            <button type="submit" class="bg-white text-black hover:bg-gray-200 font-bold py-2.5 px-6 rounded-lg transition-all flex items-center gap-2"><i class='bx bx-gift'></i> Send</button>
                        </form>
                    </div>

                    <div class="bg-card border border-bordercolor rounded-xl shadow-xl p-5 sm:p-6">
                        <div class="flex items-center gap-3 mb-5 border-b border-bordercolor pb-4">
                            <i class='bx bx-slider-alt text-2xl text-brand-400'></i>
                            <h2 class="text-base font-semibold text-white">How users earn them</h2>
                        </div>
                        <form action="/admin" method="POST" class="space-y-3">
                            <?= oys_csrf_field() ?>
                            <input type="hidden" name="hc_action" value="settings">
                            <?php foreach ($ruleFields as $key => [$title, $hint]): ?>
                            <div class="flex items-center gap-3">
                                <label class="flex-1 min-w-0" for="hcRule-<?= $key ?>"><span class="block text-sm text-white"><?= e($title) ?></span><span class="block text-xs text-gray-500"><?= e($hint) ?></span></label>
                                <input id="hcRule-<?= $key ?>" type="number" name="<?= $key ?>" min="<?= $key === 'views_step' ? 1 : 0 ?>" max="100000" step="1" value="<?= (int) $hcRules[$key] ?>" class="<?= $in ?> !w-28 text-right">
                            </div>
                            <?php endforeach; ?>
                            <p class="text-xs text-gray-500 pt-1">0 switches a reward off. Changes count from now on – nobody loses honeycombs they already have.</p>
                            <button type="submit" class="bg-white text-black hover:bg-gray-200 font-bold py-2.5 px-6 rounded-lg transition-all flex items-center gap-2"><i class='bx bx-save'></i> Save</button>
                        </form>
                    </div>
                </div>

                <div class="bg-card border border-bordercolor rounded-xl shadow-xl overflow-hidden">
                    <div class="flex flex-wrap items-center justify-between gap-3 p-5 sm:p-6 border-b border-bordercolor">
                        <h2 class="text-base font-semibold text-white flex items-center gap-2"><i class='bx bx-code-alt text-xl text-brand-400'></i> Code pages <span class="text-gray-500 text-sm font-normal"><?= count($codeSites) ?></span></h2>
                        <a href="/terms/code-pages" target="_blank" rel="noopener" class="text-sm text-gray-400 hover:text-white flex items-center gap-1 py-2">Rules for code pages <i class='bx bx-link-external'></i></a>
                    </div>
                    <?php if (!$codeSites): ?>
                    <p class="p-6 text-sm text-gray-500">No code pages yet.</p>
                    <?php else: ?>
                    <div class="divide-y divide-bordercolor">
                        <?php foreach ($codeSites as $cs): $csUrl = oys_code_url($cs); ?>
                        <div class="p-4 sm:px-6 flex flex-col lg:flex-row lg:items-center gap-3">
                            <div class="min-w-0 flex-1">
                                <div class="flex items-center gap-2 flex-wrap">
                                    <a href="<?= e($csUrl) ?>/" target="_blank" rel="noopener" class="text-white font-medium hover:text-brand-400 break-all"><?= e($cs['slug'] . '.' . oys_base_authority()) ?></a>
                                    <?php if ($cs['is_blocked']): ?>
                                    <span class="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-red-500/15 text-red-400">Blocked</span>
                                    <?php elseif (!$cs['is_published']): ?>
                                    <span class="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-white/10 text-gray-400">Offline</span>
                                    <?php else: ?>
                                    <span class="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400">Online</span>
                                    <?php endif; ?>
                                </div>
                                <p class="text-xs text-gray-500 mt-1"><?= e($cs['title']) ?> · <?= e($userName($cs)) ?> (<?= e($cs['email']) ?>) · <?= (int) $cs['file_count'] ?> files · <?= e($kb((int) $cs['bytes'])) ?> · <?= number_format((int) $cs['views']) ?> views · changed <?= e(date('M j, Y', strtotime($cs['updated_at']))) ?></p>
                                <?php if ($cs['is_blocked'] && $cs['blocked_reason']): ?>
                                <p class="text-xs text-red-300 mt-1">Reason: <?= e($cs['blocked_reason']) ?></p>
                                <?php endif; ?>
                            </div>
                            <?php if ($cs['is_blocked']): ?>
                            <form action="/admin" method="POST" class="m-0 shrink-0">
                                <?= oys_csrf_field() ?><input type="hidden" name="hc_action" value="code_unblock"><input type="hidden" name="site_id" value="<?= (int) $cs['id'] ?>">
                                <button type="submit" class="<?= $btn ?>"><i class='bx bx-check-circle'></i> Unblock</button>
                            </form>
                            <?php else: ?>
                            <form action="/admin" method="POST" class="m-0 shrink-0 flex gap-2" onsubmit="return confirm('Block this code page? Visitors will only see a notice.')">
                                <?= oys_csrf_field() ?><input type="hidden" name="hc_action" value="code_block"><input type="hidden" name="site_id" value="<?= (int) $cs['id'] ?>">
                                <input type="text" name="reason" maxlength="200" placeholder="Reason (the user sees it)" class="<?= $in ?> !py-2 lg:!w-56">
                                <button type="submit" class="<?= $btn ?> !text-red-400 hover:!bg-red-500/10"><i class='bx bx-block'></i> Block</button>
                            </form>
                            <?php endif; ?>
                        </div>
                        <?php endforeach; ?>
                    </div>
                    <?php endif; ?>
                </div>

                <div class="bg-card border border-bordercolor rounded-xl shadow-xl overflow-hidden">
                    <div class="flex flex-wrap items-center justify-between gap-3 p-5 sm:p-6 border-b border-bordercolor">
                        <h2 class="text-base font-semibold text-white flex items-center gap-2"><i class='bx bx-wallet text-xl text-brand-400'></i> Balances</h2>
                        <input type="search" id="hcFilter" placeholder="Search users …" class="<?= $in ?> sm:!w-64">
                    </div>
                    <div class="overflow-x-auto">
                        <table class="w-full text-sm text-left">
                            <thead class="text-xs text-gray-500 uppercase bg-inputbg">
                                <tr><th class="px-5 py-3 font-medium">User</th><th class="px-4 py-3 font-medium text-right">Balance</th><th class="px-4 py-3 font-medium text-right hidden sm:table-cell">Earned</th><th class="px-4 py-3 font-medium text-right hidden sm:table-cell">Spent</th><th class="px-4 py-3 font-medium">Code page</th><th class="px-5 py-3"></th></tr>
                            </thead>
                            <tbody class="divide-y divide-bordercolor" id="hcRows">
                                <?php foreach ($hcUsers as $u): $uid = (int) $u['id']; $b = $hcBalances[$uid] ?? null; ?>
                                <tr data-search="<?= e(strtolower($userName($u) . ' ' . $u['email'] . ' ' . $u['username'])) ?>">
                                    <td class="px-5 py-3"><span class="text-white"><?= e($userName($u)) ?></span><span class="block text-xs text-gray-500 break-all"><?= e($u['email']) ?></span></td>
                                    <td class="px-4 py-3 text-right font-bold text-white whitespace-nowrap"><?= number_format((int) ($b['balance'] ?? 0)) ?> <i class='bx bx-hive text-brand-400'></i></td>
                                    <td class="px-4 py-3 text-right text-gray-400 hidden sm:table-cell"><?= number_format((int) ($b['earned'] ?? 0)) ?></td>
                                    <td class="px-4 py-3 text-right text-gray-400 hidden sm:table-cell"><?= number_format((int) ($b['spent'] ?? 0)) ?></td>
                                    <td class="px-4 py-3">
                                        <?php if (isset($hcUnlocked[$uid])): ?>
                                        <span class="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400">Unlocked</span>
                                        <?php else: ?>
                                        <form action="/admin" method="POST" class="m-0" onsubmit="return confirm('Unlock the code page for this user for free?')">
                                            <?= oys_csrf_field() ?><input type="hidden" name="hc_action" value="code_unlock"><input type="hidden" name="user_id" value="<?= $uid ?>">
                                            <button type="submit" class="text-xs text-gray-400 hover:text-white underline underline-offset-2 py-1">Unlock for free</button>
                                        </form>
                                        <?php endif; ?>
                                    </td>
                                    <td class="px-5 py-3 text-right"><button type="button" class="<?= $btn ?>" data-hc-give="<?= $uid ?>"><i class='bx bx-gift'></i> Give</button></td>
                                </tr>
                                <?php endforeach; ?>
                            </tbody>
                        </table>
                    </div>
                </div>

                <div class="bg-card border border-bordercolor rounded-xl shadow-xl p-5 sm:p-6">
                    <div class="flex items-center gap-3 mb-4 border-b border-bordercolor pb-4">
                        <i class='bx bx-history text-2xl text-brand-400'></i>
                        <h2 class="text-base font-semibold text-white">Latest activity</h2>
                    </div>
                    <?php if (!$hcRecent): ?>
                    <p class="text-sm text-gray-500">Nothing yet.</p>
                    <?php else: ?>
                    <ul class="divide-y divide-bordercolor text-sm">
                        <?php foreach ($hcRecent as $r): $amt = (int) $r['amount']; ?>
                        <li class="py-2.5 flex items-center justify-between gap-3">
                            <span class="min-w-0"><span class="text-white"><?= e($userName($r)) ?></span> <span class="text-gray-400">– <?= e(oys_hc_describe($r)) ?></span><span class="block text-xs text-gray-500"><?= e(date('M j, Y H:i', strtotime($r['created_at']))) ?></span></span>
                            <span class="shrink-0 font-bold <?= $amt > 0 ? 'text-emerald-400' : ($amt < 0 ? 'text-red-400' : 'text-gray-500') ?>"><?= $amt > 0 ? '+' . number_format($amt) : ($amt < 0 ? '−' . number_format(-$amt) : 'free') ?></span>
                        </li>
                        <?php endforeach; ?>
                    </ul>
                    <?php endif; ?>
                </div>
            </div>
            <script>
                // „Give“ in der Liste wählt den Nutzer oben aus; Suche filtert die Liste
                document.querySelectorAll('[data-hc-give]').forEach(b => b.addEventListener('click', () => {
                    document.getElementById('hcUser').value = b.dataset.hcGive;
                    document.getElementById('hcGrantForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
                    setTimeout(() => document.getElementById('hcAmount').focus(), 300);
                }));
                document.getElementById('hcFilter').addEventListener('input', e => {
                    const q = e.target.value.trim().toLowerCase();
                    document.querySelectorAll('#hcRows tr').forEach(tr => { tr.hidden = q !== '' && !tr.dataset.search.includes(q); });
                });
            </script>
