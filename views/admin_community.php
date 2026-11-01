<?php
// Admin: Community – Vorschläge aus Discord annehmen/ablehnen, Support-Tickets beantworten (eingebunden in views/admin.php)
/** @var PDO $pdo */
$botReady = oys_bot_secret() !== '';
$botSeen = oys_bot_last_seen($pdo);
$botOnline = $botSeen !== null && time() - $botSeen < 300;
$suggestionFilter = in_array($_GET['suggestions'] ?? 'open', ['open', 'accepted', 'declined', 'all'], true) ? ($_GET['suggestions'] ?? 'open') : 'open';
$suggestions = $suggestionFilter === 'all'
    ? $pdo->query('SELECT * FROM community_suggestions ORDER BY id DESC LIMIT 100')->fetchAll()
    : (function () use ($pdo, $suggestionFilter) {
        $stmt = $pdo->prepare('SELECT * FROM community_suggestions WHERE status = ? ORDER BY id DESC LIMIT 100');
        $stmt->execute([$suggestionFilter]);
        return $stmt->fetchAll();
    })();
$counts = ['open' => 0, 'accepted' => 0, 'declined' => 0];
foreach ($pdo->query('SELECT status, COUNT(*) AS n FROM community_suggestions GROUP BY status')->fetchAll() as $row) {
    $counts[$row['status']] = (int) $row['n'];
}
$counts['all'] = array_sum($counts);
$tickets = $pdo->query("SELECT t.*, (SELECT COUNT(*) FROM community_ticket_messages m WHERE m.ticket_id = t.id) AS message_count
    FROM community_tickets t ORDER BY t.status = 'open' DESC, t.updated_at DESC LIMIT 50")->fetchAll();
$openTickets = count(array_filter($tickets, function ($t) { return $t['status'] === 'open'; }));
$ticketView = isset($_GET['ticket']) ? oys_ticket_get($pdo, (int) $_GET['ticket']) : null;
$ticketMessages = $ticketView ? oys_ticket_messages($pdo, (int) $ticketView['id']) : [];
$pendingOutbox = (int) $pdo->query('SELECT COUNT(*) FROM community_outbox WHERE done_at IS NULL AND attempts < 10')->fetchColumn();
$failedOutbox = $pdo->query('SELECT action, last_error, attempts FROM community_outbox WHERE done_at IS NULL AND last_error IS NOT NULL ORDER BY id DESC LIMIT 3')->fetchAll();

$in = 'w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm';
$btn = 'inline-flex items-center gap-1.5 px-3 py-2 min-h-[36px] rounded-lg text-xs font-medium border border-bordercolor text-gray-300 hover:text-white hover:bg-white/5 transition-colors';
$when = function ($d) { return $d ? date('M j, Y H:i', strtotime((string) $d)) : '—'; };
$badge = [
    'open' => 'bg-sky-500/15 text-sky-400', 'accepted' => 'bg-emerald-500/15 text-emerald-400', 'declined' => 'bg-red-500/15 text-red-400',
    'closed' => 'bg-white/10 text-gray-400',
];
?>
            <!-- ===================== Community ===================== -->
            <div id="tab-community" class="admin-tab-content max-w-5xl mx-auto space-y-8 hidden">
                <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div class="bg-card border border-bordercolor rounded-xl p-5">
                        <p class="text-xs text-gray-500 uppercase tracking-wider font-semibold">Open suggestions</p>
                        <p class="text-3xl font-bold text-white mt-1"><?= $counts['open'] ?></p>
                    </div>
                    <div class="bg-card border border-bordercolor rounded-xl p-5">
                        <p class="text-xs text-gray-500 uppercase tracking-wider font-semibold">Open tickets</p>
                        <p class="text-3xl font-bold text-white mt-1"><?= $openTickets ?></p>
                    </div>
                    <div class="bg-card border border-bordercolor rounded-xl p-5">
                        <p class="text-xs text-gray-500 uppercase tracking-wider font-semibold">Discord bot</p>
                        <?php if (!$botReady): ?>
                        <p class="text-sm text-amber-400 mt-2 font-medium">Not set up</p>
                        <?php elseif ($botOnline): ?>
                        <p class="text-sm text-emerald-400 mt-2 font-medium flex items-center gap-1.5"><span class="h-2 w-2 rounded-full bg-emerald-400"></span> Connected</p>
                        <?php else: ?>
                        <p class="text-sm text-gray-400 mt-2 font-medium">Offline<?= $botSeen ? ' – last seen ' . e($when(date('Y-m-d H:i:s', $botSeen))) : '' ?></p>
                        <?php endif; ?>
                        <?php if ($pendingOutbox): ?>
                        <p class="text-xs text-gray-500 mt-1"><?= $pendingOutbox ?> change<?= $pendingOutbox === 1 ? '' : 's' ?> waiting for the bot</p>
                        <?php endif; ?>
                    </div>
                </div>

                <?php if (!$botReady): ?>
                <div class="rounded-xl border border-amber-500/30 bg-amber-500/5 p-5 text-sm text-gray-300 space-y-2">
                    <p class="font-semibold text-amber-300">Connect the Discord bot</p>
                    <ol class="list-decimal pl-5 space-y-1">
                        <li>Add this line to <code>config.php</code> (a random secret, made just now): <code class="text-white break-all">'bot_secret' =&gt; '<?= bin2hex(random_bytes(32)) ?>',</code></li>
                        <li>Put the same value into <code>BOT_SECRET</code> in the bot’s <code>.env</code> and start the bot – see <code>discord-bot/README.md</code>.</li>
                    </ol>
                </div>
                <?php endif; ?>
                <?php foreach ($failedOutbox as $f): ?>
                <div class="rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-300">The bot couldn’t carry out “<?= e($f['action']) ?>” (<?= (int) $f['attempts'] ?> tries): <?= e($f['last_error']) ?></div>
                <?php endforeach; ?>

                <!-- Vorschläge -->
                <div class="bg-card border border-bordercolor rounded-xl shadow-xl overflow-hidden">
                    <div class="flex flex-wrap items-center justify-between gap-3 p-5 sm:p-6 border-b border-bordercolor">
                        <h2 class="text-base font-semibold text-white flex items-center gap-2"><i class='bx bx-bulb text-xl text-brand-400'></i> Suggestions from Discord</h2>
                        <div class="flex flex-wrap gap-1.5">
                            <?php foreach (['open' => 'Open', 'accepted' => 'Accepted', 'declined' => 'Declined', 'all' => 'All'] as $key => $label): ?>
                            <a href="/admin?suggestions=<?= $key ?>#community" class="<?= $btn ?> <?= $suggestionFilter === $key ? '!bg-white/10 !text-white' : '' ?>"><?= $label ?> <span class="text-gray-500"><?= $counts[$key] ?></span></a>
                            <?php endforeach; ?>
                        </div>
                    </div>
                    <?php if (!$suggestions): ?>
                    <p class="p-6 text-sm text-gray-500"><?= $suggestionFilter === 'open' ? 'No open suggestions. New posts in the suggestion forum on Discord show up here.' : 'Nothing here yet.' ?></p>
                    <?php else: ?>
                    <div class="divide-y divide-bordercolor">
                        <?php foreach ($suggestions as $s): ?>
                        <div class="p-5 sm:px-6" id="suggestion-<?= (int) $s['id'] ?>">
                            <div class="flex flex-wrap items-start justify-between gap-3">
                                <div class="min-w-0">
                                    <p class="text-white font-medium break-words"><span class="text-gray-500">#<?= (int) $s['id'] ?></span> <?= e($s['title']) ?></p>
                                    <p class="text-xs text-gray-500 mt-1">by <?= e($s['author_name'] !== '' ? $s['author_name'] : $s['author_id']) ?> · <?= e($when($s['created_at'])) ?></p>
                                </div>
                                <span class="shrink-0 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded <?= $badge[$s['status']] ?? $badge['open'] ?>"><?= e($s['status']) ?></span>
                            </div>
                            <?php if ($s['body'] !== ''): ?>
                            <details class="mt-3 text-sm text-gray-300">
                                <summary class="cursor-pointer text-gray-400 hover:text-white text-xs">Show text</summary>
                                <div class="mt-2 whitespace-pre-wrap break-words bg-inputbg border border-bordercolor rounded-lg p-3"><?= e($s['body']) ?></div>
                            </details>
                            <?php endif; ?>
                            <?php if ($s['status'] === 'open'): ?>
                            <form action="/admin" method="POST" class="mt-3 flex flex-col sm:flex-row gap-2">
                                <?= oys_csrf_field() ?><input type="hidden" name="community_action" value="suggestion_decide"><input type="hidden" name="id" value="<?= (int) $s['id'] ?>">
                                <input type="text" name="reason" maxlength="500" placeholder="Note for the community (optional)" class="<?= $in ?> !py-2 sm:flex-1">
                                <div class="flex gap-2 shrink-0">
                                    <button type="submit" name="status" value="accepted" class="<?= $btn ?> !text-emerald-400 hover:!bg-emerald-500/10"><i class='bx bx-check'></i> Accept</button>
                                    <button type="submit" name="status" value="declined" class="<?= $btn ?> !text-red-400 hover:!bg-red-500/10"><i class='bx bx-x'></i> Decline</button>
                                </div>
                            </form>
                            <?php else: ?>
                            <p class="mt-3 text-xs text-gray-400"><?= e(ucfirst($s['status'])) ?> by <?= e($s['decided_by']) ?> <?= $s['decided_via'] === 'web' ? 'on the website' : 'in Discord' ?> · <?= e($when($s['decided_at'])) ?><?= $s['reason'] !== '' ? ' – “' . e($s['reason']) . '”' : '' ?></p>
                            <?php endif; ?>
                        </div>
                        <?php endforeach; ?>
                    </div>
                    <?php endif; ?>
                </div>

                <!-- Support -->
                <div class="bg-card border border-bordercolor rounded-xl shadow-xl overflow-hidden" id="community-tickets">
                    <div class="flex items-center gap-3 p-5 sm:p-6 border-b border-bordercolor">
                        <i class='bx bx-support text-xl text-brand-400'></i>
                        <h2 class="text-base font-semibold text-white">Support tickets</h2>
                    </div>
                    <?php if ($ticketView): ?>
                    <div class="p-5 sm:p-6 border-b border-bordercolor bg-white/[0.02]">
                        <div class="flex flex-wrap items-start justify-between gap-3 mb-4">
                            <div class="min-w-0">
                                <p class="text-white font-semibold break-words"><span class="text-gray-500">#<?= (int) $ticketView['id'] ?></span> <?= e($ticketView['subject']) ?></p>
                                <p class="text-xs text-gray-500 mt-1"><?= e($ticketView['user_name'] !== '' ? $ticketView['user_name'] : $ticketView['user_id']) ?> · opened <?= e($when($ticketView['created_at'])) ?><?= $ticketView['status'] === 'closed' ? ' · closed by ' . e($ticketView['closed_by']) . ' ' . e($when($ticketView['closed_at'])) : '' ?></p>
                            </div>
                            <a href="/admin#community" class="<?= $btn ?>"><i class='bx bx-x'></i> Close view</a>
                        </div>
                        <div class="space-y-3 max-h-[480px] overflow-y-auto pr-1">
                            <?php foreach ($ticketMessages as $msg): ?>
                            <div class="flex <?= $msg['is_team'] ? 'justify-end' : '' ?>">
                                <div class="max-w-[85%] rounded-xl px-4 py-3 text-sm <?= $msg['is_team'] ? 'bg-brand-500/15 border border-brand-500/30' : 'bg-inputbg border border-bordercolor' ?>">
                                    <p class="text-xs mb-1 <?= $msg['is_team'] ? 'text-brand-400' : 'text-gray-400' ?>"><?= e($msg['author_name'] !== '' ? $msg['author_name'] : 'Unknown') ?><?= $msg['is_team'] ? ' (team' . ($msg['source'] === 'web' ? ', website' : '') . ')' : '' ?> · <?= e($when($msg['created_at'])) ?></p>
                                    <p class="text-gray-200 whitespace-pre-wrap break-words"><?= e($msg['body']) ?></p>
                                </div>
                            </div>
                            <?php endforeach; ?>
                        </div>
                        <?php if ($ticketView['status'] === 'open'): ?>
                        <form action="/admin" method="POST" class="mt-4 space-y-3">
                            <?= oys_csrf_field() ?><input type="hidden" name="id" value="<?= (int) $ticketView['id'] ?>">
                            <textarea name="body" rows="3" maxlength="2000" placeholder="Write a reply – it’s posted in the ticket channel on Discord." class="<?= $in ?>"></textarea>
                            <div class="flex flex-wrap gap-2 justify-end">
                                <button type="submit" name="community_action" value="ticket_close" class="<?= $btn ?> !text-red-400 hover:!bg-red-500/10" onclick="return confirm('Close this ticket?')"><i class='bx bx-lock-alt'></i> Close ticket</button>
                                <button type="submit" name="community_action" value="ticket_reply" class="bg-white text-black hover:bg-gray-200 font-bold py-2 px-5 rounded-lg transition-all flex items-center gap-2 text-sm"><i class='bx bx-send'></i> Send reply</button>
                            </div>
                        </form>
                        <?php endif; ?>
                    </div>
                    <?php endif; ?>
                    <?php if (!$tickets): ?>
                    <p class="p-6 text-sm text-gray-500">No tickets yet. People open them with the support button on Discord.</p>
                    <?php else: ?>
                    <div class="divide-y divide-bordercolor">
                        <?php foreach ($tickets as $t): ?>
                        <a href="/admin?ticket=<?= (int) $t['id'] ?>#community" class="flex items-center gap-3 px-5 sm:px-6 py-3 hover:bg-white/[0.03] transition-colors <?= $ticketView && (int) $ticketView['id'] === (int) $t['id'] ? 'bg-white/[0.04]' : '' ?>">
                            <span class="shrink-0 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded <?= $badge[$t['status']] ?? $badge['closed'] ?>"><?= e($t['status']) ?></span>
                            <span class="min-w-0 flex-1">
                                <span class="block text-sm text-white truncate"><span class="text-gray-500">#<?= (int) $t['id'] ?></span> <?= e($t['subject']) ?></span>
                                <span class="block text-xs text-gray-500 truncate"><?= e($t['user_name'] !== '' ? $t['user_name'] : $t['user_id']) ?> · <?= (int) $t['message_count'] ?> message<?= (int) $t['message_count'] === 1 ? '' : 's' ?> · last activity <?= e($when($t['updated_at'])) ?></span>
                            </span>
                            <i class='bx bx-chevron-right text-gray-500 text-xl'></i>
                        </a>
                        <?php endforeach; ?>
                    </div>
                    <?php endif; ?>
                </div>
            </div>
