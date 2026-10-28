<?php
// Termin-Anfrage (eingebauter Kalender) im Design der Profilseite.
// Ohne Session/Cookies: Erfolg wird per ?ok=1 angezeigt.
/** @var PDO $pdo */
/** @var array $page */
/** @var string $calendarKey  '' oder Schlüssel eines geschützten Termin-Blocks */

$slots = ['09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00'];
$selfUrl = oys_page_url($page, 'kalender') . ($calendarKey !== '' ? '?k=' . rawurlencode($calendarKey) : '');
$okUrl = $selfUrl . ($calendarKey !== '' ? '&' : '?') . 'ok=1';
$error = null;

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    $name = oys_clean_text($_POST['guest_name'] ?? '', 80);
    $email = trim((string) ($_POST['guest_email'] ?? ''));
    $date = (string) ($_POST['booking_date'] ?? '');
    $time = (string) ($_POST['booking_time'] ?? '');
    $token = (string) ($_POST['t'] ?? '');
    $validToken = preg_match('/^(\d{9,11})\.([a-f0-9]{32})$/', $token, $tm)
        && hash_equals(substr(oys_hmac('booking|' . $page['id'] . '|' . $tm[1]), 0, 32), $tm[2])
        && time() - (int) $tm[1] < 86400;

    if (trim((string) ($_POST['website'] ?? '')) !== '' || !$validToken) {
        oys_redirect($okUrl, 303);
    }
    if ($name === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        $error = 'Please enter your name and a valid email address.';
    } elseif (!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $date, $dm) || !checkdate((int) $dm[2], (int) $dm[3], (int) $dm[1])
        || $date < date('Y-m-d') || $date > date('Y-m-d', strtotime('+1 year'))) {
        $error = 'Please choose a date between today and one year from now.';
    } elseif (!in_array($time, $slots, true)) {
        $error = 'Please choose a time.';
    } elseif (!oys_rate_limit($pdo, 'booking:' . $page['id'] . ':' . oys_client_key(), 5, 3600)
        || !oys_rate_limit($pdo, 'booking:' . $page['id'], 30, 3600)) {
        $error = 'There are a lot of requests right now. Please try again later.';
    } else {
        $pdo->prepare('INSERT INTO user_bookings (user_id, guest_name, guest_email, booking_date, booking_time) VALUES (?, ?, ?, ?, ?)')
            ->execute([$page['user_id'], encryptData($name), encryptData($email), $date, $time]);
        $dateDe = date('M j, Y', strtotime($date));
        oys_notify($pdo, (int) $page['user_id'], 'booking', 'New booking request from ' . $name, $dateDe . ' at ' . $time, '/dashboard#messages');
        $owner = $pdo->prepare('SELECT email, full_name FROM users WHERE id = ?');
        $owner->execute([$page['user_id']]);
        if ($user = $owner->fetch()) {
            sendCustomEmail($user['email'], 'new_booking', [
                'full_name' => e($user['full_name'] ?: $page['title']),
                'guest_name' => e($name),
                'guest_email' => e($email),
                'booking_date' => e($dateDe),
                'booking_time' => e($time),
                'dashboard_url' => e(oys_main_url('/dashboard')),
            ], 'New booking: ' . $name . ' on ' . $dateDe, $email);
        }
        oys_redirect($okUrl, 303);
    }
}

$ts = time();
$token = $ts . '.' . substr(oys_hmac('booking|' . $page['id'] . '|' . $ts), 0, 32);
$avatar = !empty($page['avatar']) ? oys_upload_url($page['avatar']) : '';
$name = $page['title'] ?: $page['slug'];

ob_start();
?>
<div class="oys-card">
  <a class="oys-back" href="<?= e(oys_page_url($page)) ?>"><?= oys_ui_icon('left') ?> Back to profile</a>
  <div style="display:flex;align-items:center;gap:14px;margin-bottom:18px">
    <div class="oys-avatar" style="--avatar-size:56px;margin:0"><div class="oys-avatar-inner">
      <?php if ($avatar): ?><img src="<?= e($avatar) ?>" alt=""><?php else: ?><span class="oys-initials" style="font-size:1.1em"><?= e(oys_initials($name)) ?></span><?php endif; ?>
    </div></div>
    <div><h1 style="margin:0">Request a meeting</h1><p style="margin:0">with <?= e($name) ?></p></div>
  </div>

  <?php if (isset($_GET['ok'])): ?>
    <div class="oys-alert ok"><?= oys_ui_icon('check') ?> Your request has been sent! You’ll get a reply by email.</div>
  <?php else: ?>
    <?php if ($error): ?><div class="oys-alert err"><?= e($error) ?></div><?php endif; ?>
    <form class="oys-contact" method="post" action="<?= e($selfUrl) ?>">
      <input type="hidden" name="t" value="<?= e($token) ?>">
      <div class="oys-hp" aria-hidden="true"><label>Website <input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
      <label class="oys-field"><span>Your name</span><input type="text" name="guest_name" required maxlength="80" autocomplete="name" value="<?= e($_POST['guest_name'] ?? '') ?>"></label>
      <label class="oys-field"><span>Your email</span><input type="email" name="guest_email" required autocomplete="email" value="<?= e($_POST['guest_email'] ?? '') ?>"></label>
      <div class="oys-grid2">
        <label class="oys-field"><span>Preferred date</span><input type="date" name="booking_date" required min="<?= date('Y-m-d') ?>" max="<?= date('Y-m-d', strtotime('+1 year')) ?>" value="<?= e($_POST['booking_date'] ?? '') ?>"></label>
        <label class="oys-field"><span>Time</span>
          <select name="booking_time" required>
            <option value="" disabled<?= empty($_POST['booking_time']) ? ' selected' : '' ?>>Please choose…</option>
            <?php foreach ($slots as $slot): ?><option value="<?= $slot ?>"<?= ($_POST['booking_time'] ?? '') === $slot ? ' selected' : '' ?>><?= $slot ?></option><?php endforeach; ?>
          </select>
        </label>
      </div>
      <button class="oys-contact-send" type="submit"><?= oys_ui_icon('calendar') ?><span>Request a meeting</span></button>
      <p class="oys-contact-note">Your details are stored encrypted and only used to arrange the meeting.</p>
    </form>
  <?php endif; ?>
</div>
<?php
echo oys_render_simple($page, 'Request a meeting | ' . $name, (string) ob_get_clean());
