<?php
// Wochenbericht: jeden Montag eine kurze Mail mit Aufrufen, Klicks und dem besten Link.
//
// Plesk: "Geplante Aufgaben" → "PHP-Skript ausführen"
//   Skript:   /httpdocs/cron/weekly_report.php   (Pfad an deine Installation anpassen)
//   Zeitplan: Montags, 8:00 Uhr   (Cron: 0 8 * * 1)
//
// Alternativ per Web-Cron (wenn 'cron_secret' in config.php gesetzt ist):
//   https://on-your.site/_/cron/weekly-report?key=DEIN_GEHEIMNIS

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('Nur über die Kommandozeile / Plesk-Aufgabe.');
}

chdir(dirname(__DIR__));
require dirname(__DIR__) . '/lib/bootstrap.php';

$result = oys_run_weekly_reports($pdo);
echo date('Y-m-d H:i') . ' – Wochenberichte gesendet: ' . $result['sent'] . ', fehlgeschlagen: ' . $result['failed'] . PHP_EOL;
