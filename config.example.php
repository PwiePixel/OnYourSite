<?php
// ---------------------------------------------------------------
// OnYourSite – configuration
// Copy this file to "config.php" and fill in your details.
// config.php is NOT committed to the Git repo (see .gitignore).
// ---------------------------------------------------------------
return [
    // Database (on Plesk usually localhost)
    'db' => [
        'host' => 'localhost',
        'name' => 'onyoursite_',
        'user' => 'onyoursiteuser',
        'pass' => '',
    ],

    // AES-256 key, EXACTLY 32 characters.
    // IMPORTANT when updating: enter the old value from your previous security.php
    // (define('AES_256_KEY', '...')) here – otherwise data that is already
    // encrypted (Discord IDs, booking requests) can no longer be read.
    'aes_key' => '',

    // Random secret text (at least 32 characters) for form signatures
    // (spam protection in the contact form). Just generate it once, e.g. with
    // php -r "echo bin2hex(random_bytes(32));"
    'app_secret' => '',

    // Main domain without "www" – profiles live at name.DOMAIN or DOMAIN/name
    'base_domain' => 'on-your.site',
    'scheme' => 'https',

    'timezone' => 'Europe/Berlin',

    // How many pages an account may create
    'max_pages' => 3,

    // Optional: secret for running the weekly report via web cron
    // (https://on-your.site/cron/weekly_report.php is blocked; use the Plesk
    // task "Run a PHP script" instead – then you don’t need this).
    'cron_secret' => '',

    // Show errors in the browser (only set to true for testing)
    'debug' => false,
];
