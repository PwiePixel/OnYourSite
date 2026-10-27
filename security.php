<?php
// security.php – Verschlüsselung sensibler Daten (Discord-ID, Termin-Anfragen, Nachrichten).
// Der Schlüssel (EXAKT 32 Zeichen) steht in config.php unter 'aes_key'.
require_once __DIR__ . '/lib/config.php';

if (!defined('AES_256_KEY')) {
    define('AES_256_KEY', (string) oys_config('aes_key', ''));
}

function encryptData($plaintext) {
    if (empty($plaintext)) return $plaintext;

    // Wenn der Text schon verschlüsselt ist (falls man ihn versehentlich doppelt speichert), abbrechen
    if (strpos($plaintext, 'ENC:') === 0) return $plaintext;

    $iv_length = openssl_cipher_iv_length('aes-256-cbc');
    $iv = openssl_random_pseudo_bytes($iv_length);

    $ciphertext = openssl_encrypt($plaintext, 'aes-256-cbc', AES_256_KEY, 0, $iv);

    // Wir setzen "ENC:" als Marker davor!
    return 'ENC:' . base64_encode($iv . $ciphertext);
}

function decryptData($encryptedString) {
    if (empty($encryptedString)) return $encryptedString;

    // FALLBACK: Wenn der String NICHT mit "ENC:" anfängt, ist es ein alter/unverschlüsselter Text!
    if (strpos($encryptedString, 'ENC:') !== 0) {
        return $encryptedString;
    }

    // Das "ENC:" wieder abschneiden, um an den echten Code zu kommen
    $base64 = substr($encryptedString, 4);
    $data = base64_decode($base64, true);

    if ($data === false) return $encryptedString;

    $iv_length = openssl_cipher_iv_length('aes-256-cbc');

    // Sicherheitscheck: Ist der String überhaupt lang genug für AES-256?
    if (strlen($data) <= $iv_length) return $encryptedString;

    $iv = substr($data, 0, $iv_length);
    $ciphertext = substr($data, $iv_length);

    $decrypted = openssl_decrypt($ciphertext, 'aes-256-cbc', AES_256_KEY, 0, $iv);

    return $decrypted !== false ? $decrypted : $encryptedString;
}
