<?php
// db.php
$host = 'localhost'; // Bei Plesk meistens localhost
$dbname = 'onyoursite_';
$user = 'onyoursiteuser';
$pass = 'DEIN_DB_PASSWORT';

try {
    $pdo = new PDO("mysql:host=$host;dbname=$dbname;charset=utf8mb4", $user, $pass);
    // Setze den PDO Fehlermodus auf Exception
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
} catch(PDOException $e) {
    die("Datenbankverbindung fehlgeschlagen: " . $e->getMessage());
}
?>