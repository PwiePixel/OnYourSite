<?php
// Mail an alle Admins, wenn das HTTPS-Zertifikat bald abläuft (aufgerufen von server/cert-check.sh). Nur Kommandozeile.
if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit;
}
chdir(dirname(__DIR__));
require dirname(__DIR__) . '/lib/bootstrap.php';

$days = (int) ($argv[1] ?? 0);
$domain = oys_base_host();
$smtp = json_decode((string) @file_get_contents(dirname(__DIR__) . '/email/smtp.json'), true);
if (!is_array($smtp) || empty($smtp['host'])) {
    fwrite(STDERR, 'No mail server is set up (Admin → Mail Server) – no warning sent.' . PHP_EOL);
    exit(1);
}
$admins = $pdo->query('SELECT email FROM users WHERE is_admin = 1')->fetchAll(PDO::FETCH_COLUMN);
$subject = "HTTPS certificate of $domain expires in $days days";
$text = "The HTTPS certificate of $domain and *.$domain expires in $days days, and the automatic renewal didn't work.\n\n"
    . "Please log in to the server and run:\n\n    sudo bash " . dirname(__DIR__) . "/server/install.sh --https\n\n"
    . "It shows what goes wrong – often the API token of the DNS provider has expired or was deleted.\n"
    . "Details: journalctl -u onyoursite-certs\n";
$sent = 0;
foreach ($admins as $to) {
    $mail = new \PHPMailer\PHPMailer\PHPMailer(true);
    try {
        $mail->isSMTP();
        $mail->Host = $smtp['host'];
        $mail->SMTPAuth = true;
        $mail->Username = $smtp['username'] ?? '';
        $mail->Password = $smtp['password'] ?? '';
        $mail->SMTPSecure = (int) ($smtp['port'] ?? 0) === 465 ? \PHPMailer\PHPMailer\PHPMailer::ENCRYPTION_SMTPS : \PHPMailer\PHPMailer\PHPMailer::ENCRYPTION_STARTTLS;
        $mail->Port = (int) ($smtp['port'] ?? 587);
        $mail->CharSet = 'UTF-8';
        $mail->Timeout = 15;
        $mail->setFrom($smtp['from_email'] ?? '', $smtp['from_name'] ?? 'OnYourSite');
        $mail->addAddress($to);
        $mail->Subject = $subject;
        $mail->Body = $text;
        $mail->send();
        $sent++;
    } catch (\Throwable $e) {
        fwrite(STDERR, 'Mail to ' . $to . ' failed: ' . ($mail->ErrorInfo ?: $e->getMessage()) . PHP_EOL);
    }
}
echo "Warning sent to $sent of " . count($admins) . ' admins.' . PHP_EOL;
exit($sent > 0 ? 0 : 1);
