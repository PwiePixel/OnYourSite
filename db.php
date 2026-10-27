<?php
// db.php – baut die Datenbankverbindung auf. Die Zugangsdaten stehen in config.php.
require_once __DIR__ . '/lib/config.php';

if (!isset($pdo)) {
    $host = oys_config('db.host', 'localhost');
    $dbname = oys_config('db.name', '');
    $user = oys_config('db.user', '');
    $pass = oys_config('db.pass', '');

    date_default_timezone_set(oys_config('timezone', 'Europe/Berlin'));

    try {
        $pdo = new PDO("mysql:host=$host;dbname=$dbname;charset=utf8mb4", $user, $pass, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
        // Gleiche Zeitzone wie PHP, damit "heute" in Statistik und Zeitsteuerung übereinstimmt
        $pdo->exec("SET time_zone = '" . date('P') . "'");
    } catch (PDOException $e) {
        error_log('DB-Verbindung fehlgeschlagen: ' . $e->getMessage());
        oys_setup_error('Datenbankverbindung fehlgeschlagen.', 'Bitte prüfe die Zugangsdaten in <code>config.php</code>.');
    }
}
