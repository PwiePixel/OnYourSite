<?php
// ---------------------------------------------------------------
// OnYourSite – Konfiguration
// Kopiere diese Datei nach "config.php" und trage deine Daten ein.
// config.php wird NICHT ins Git-Repo übernommen (siehe .gitignore).
// ---------------------------------------------------------------
return [
    // Datenbank (bei Plesk meistens localhost)
    'db' => [
        'host' => 'localhost',
        'name' => 'onyoursite_',
        'user' => 'onyoursiteuser',
        'pass' => '',
    ],

    // AES-256-Schlüssel, EXAKT 32 Zeichen.
    // WICHTIG beim Update: den alten Wert aus deiner bisherigen security.php
    // (define('AES_256_KEY', '...')) hier eintragen – sonst können bereits
    // verschlüsselte Daten (Discord-IDs, Termin-Anfragen) nicht mehr gelesen werden.
    'aes_key' => '',

    // Zufälliger, geheimer Text (mind. 32 Zeichen) für Formular-Signaturen
    // (Spamschutz im Kontaktformular). Einfach einmal z. B. mit
    // php -r "echo bin2hex(random_bytes(32));" erzeugen.
    'app_secret' => '',

    // Hauptdomain ohne "www" – Profile liegen unter name.DOMAIN oder DOMAIN/name
    'base_domain' => 'on-your.site',
    'scheme' => 'https',

    'timezone' => 'Europe/Berlin',

    // Wie viele Seiten ein Konto anlegen darf
    'max_pages' => 3,

    // Optional: Geheimnis, um den Wochenbericht per Web-Cron aufzurufen
    // (https://on-your.site/cron/weekly_report.php ist gesperrt; nutze stattdessen
    // die Plesk-Aufgabe "PHP-Skript ausführen" – dann wird das hier nicht gebraucht).
    'cron_secret' => '',

    // Fehler im Browser anzeigen (nur zum Testen auf true setzen)
    'debug' => false,
];
