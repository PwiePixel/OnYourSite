<?php
// Lädt config.php (Zugangsdaten liegen nicht im Code).

function oys_config(?string $key = null, $default = null)
{
    static $config = null;

    if ($config === null) {
        $file = dirname(__DIR__) . '/config.php';
        if (!is_file($file)) {
            oys_setup_error(
                'Die Datei <code>config.php</code> fehlt.',
                'Kopiere <code>config.example.php</code> nach <code>config.php</code> und trage deine Datenbank-Zugangsdaten '
                . 'sowie den AES-Schlüssel aus deiner alten <code>security.php</code> ein.'
            );
        }
        $loaded = require $file;
        $config = is_array($loaded) ? $loaded : [];
    }

    if ($key === null) {
        return $config;
    }

    // Punkt-Notation: oys_config('db.host')
    $value = $config;
    foreach (explode('.', $key) as $part) {
        if (!is_array($value) || !array_key_exists($part, $value)) {
            return $default;
        }
        $value = $value[$part];
    }
    return $value;
}

function oys_setup_error(string $title, string $text): void
{
    http_response_code(503);
    header('Content-Type: text/html; charset=utf-8');
    echo '<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
        . '<title>Einrichtung | OnYourSite</title></head>'
        . '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#09090b;color:#d4d4d8;font-family:system-ui,sans-serif;padding:24px">'
        . '<div style="max-width:560px;background:#18181b;border:1px solid #27272a;border-radius:16px;padding:32px">'
        . '<h1 style="color:#fff;font-size:20px;margin:0 0 12px">' . $title . '</h1>'
        . '<p style="line-height:1.6;margin:0">' . $text . '</p></div></body></html>';
    exit;
}
