<?php
// ---------------------------------------------------------------
// OnYourSite – configuration
// Copy this file to "config.php" and fill in your details.
// config.php is NOT committed to the Git repo (see .gitignore).
// ---------------------------------------------------------------
return [
    // Database (usually localhost – on your own server, server/install.sh fills this in)
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
    // (https://on-your.site/cron/weekly_report.php is blocked). Not needed when the report
    // runs on the server itself: own server (server/install.sh) or a Plesk scheduled task.
    'cron_secret' => '',

    // Optional: shared secret for the Discord bot (discord-bot/), at least 32 characters.
    // Generate one with: php -r "echo bin2hex(random_bytes(32));"
    // The bot needs the same value as BOT_SECRET (its installer asks for it – server/install.sh
    // takes care of both sides). Empty = bot connection off.
    'bot_secret' => '',

    // Show errors in the browser (only set to true for testing)
    'debug' => false,
];
