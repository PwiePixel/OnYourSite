<?php
// Einbinden der PHPMailer Klassen
use PHPMailer\PHPMailer\PHPMailer;
use PHPMailer\PHPMailer\Exception;

require_once __DIR__ . '/PHPMailer/src/Exception.php';
require_once __DIR__ . '/PHPMailer/src/PHPMailer.php';
require_once __DIR__ . '/PHPMailer/src/SMTP.php';

function sendCustomEmail($to_email, $template_name, $variables = [], $subject_override = null) {
    $email_dir = __DIR__ . '/email/';
    $smtp_file = $email_dir . 'smtp.json';
    $template_file = $email_dir . $template_name . '.json';

    if (!file_exists($smtp_file) || !file_exists($template_file)) {
        error_log("Mail Error: SMTP config or Template '$template_name' missing.");
        return false;
    }

    $smtp_config = json_decode(file_get_contents($smtp_file), true);
    $template = json_decode(file_get_contents($template_file), true);

    if (!$smtp_config || !$template) {
        error_log("Mail Error: JSON format invalid.");
        return false;
    }

    $subject = $subject_override ?: ($template['subject'] ?? 'Notification');
    $body = $template['body'] ?? '';

    foreach ($variables as $key => $value) {
        $subject = str_replace('{' . $key . '}', $value, $subject);
        $body = str_replace('{' . $key . '}', $value, $body);
    }

    $mail = new PHPMailer(true);

    try {
        $mail->isSMTP();
        $mail->Host       = $smtp_config['host'];
        $mail->SMTPAuth   = true;
        $mail->Username   = $smtp_config['username'];
        $mail->Password   = $smtp_config['password'];
        
        // NEU: Automatische Erkennung der Verschlüsselung anhand des Ports!
        if ((int)$smtp_config['port'] === 465) {
            $mail->SMTPSecure = PHPMailer::ENCRYPTION_SMTPS; // SSL
        } else {
            $mail->SMTPSecure = PHPMailer::ENCRYPTION_STARTTLS; // TLS (meist 587)
        }
        
        $mail->Port       = $smtp_config['port'];
        $mail->CharSet    = 'UTF-8';
        
        // NEU: Nach 10 Sekunden aufgeben, damit das Dashboard nicht "100 Jahre" lädt
        $mail->Timeout    = 10; 

        $mail->setFrom($smtp_config['from_email'], $smtp_config['from_name']);
        $mail->addAddress($to_email);

        $mail->isHTML(true);
        $mail->Subject = $subject;
        $mail->Body    = nl2br($body); 
        $mail->AltBody = strip_tags($body); 

        $mail->send();
        return true;
    } catch (Exception $e) {
        error_log("Mailer Error: {$mail->ErrorInfo}");
        return false;
    }
}
?>