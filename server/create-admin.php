<?php
// Legt das erste Admin-Konto mit seiner Seite an (aufgerufen von server/install.sh).
// Nur auf der Kommandozeile; die Angaben kommen über die Umgebung, damit sie nicht in der Prozessliste stehen.
if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit;
}
chdir(dirname(__DIR__));
require dirname(__DIR__) . '/lib/bootstrap.php';

$fail = function (string $message): void {
    fwrite(STDERR, $message . PHP_EOL);
    exit(1);
};
$name = oys_clean_text((string) getenv('OYS_NAME'), 120);
$email = strtolower(trim((string) getenv('OYS_EMAIL')));
$password = (string) getenv('OYS_PASSWORD');
$slug = oys_normalize_slug((string) getenv('OYS_SLUG'));

if ($name === '' || $email === '' || $password === '' || $slug === '') {
    $fail('Please fill in everything.');
}
if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    $fail('Please enter a valid email address.');
}
if (strlen($password) < 8) {
    $fail('The password must be at least 8 characters long.');
}
if ($problem = oys_slug_problem($pdo, $slug)) {
    $fail($problem);
}
$check = $pdo->prepare('SELECT id FROM users WHERE email = ? OR username = ? LIMIT 1');
$check->execute([$email, $slug]);
if ($check->fetch()) {
    $fail('This email address or page address is already taken.');
}
$pdo->prepare("INSERT INTO users (email, password, full_name, username, layout_type, last_ip, theme, is_admin) VALUES (?, ?, ?, ?, 'link-tree', '', ?, 1)")
    ->execute([$email, password_hash($password, PASSWORD_DEFAULT), $name, $slug, OYS_DEFAULT_THEME]);
oys_create_page($pdo, (int) $pdo->lastInsertId(), $slug, $name);
echo 'Admin account created – log in at ' . oys_main_url('/login') . ' with ' . $email . '. Your page: ' . oys_page_urls(['slug' => $slug])['subdomain'] . PHP_EOL;
