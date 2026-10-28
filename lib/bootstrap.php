<?php
// Lädt Konfiguration, Datenbank und alle Bausteine. Muss auf oberster Ebene eingebunden werden
// (blacklist.php legt globale Listen an).
require_once __DIR__ . '/config.php';

$oys_debug = (bool) oys_config('debug', false);
ini_set('display_errors', $oys_debug ? '1' : '0');
ini_set('log_errors', '1');
error_reporting(E_ALL);
date_default_timezone_set(oys_config('timezone', 'Europe/Berlin'));
mb_internal_encoding('UTF-8');

require_once dirname(__DIR__) . '/db.php';
require_once dirname(__DIR__) . '/security.php';
require_once dirname(__DIR__) . '/mail.php';
require_once dirname(__DIR__) . '/blacklist.php';

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/schema.php';
require_once __DIR__ . '/themes.php';
require_once __DIR__ . '/social.php';
require_once __DIR__ . '/blocks.php';
require_once __DIR__ . '/pages.php';
require_once __DIR__ . '/render.php';
require_once __DIR__ . '/stats.php';
require_once __DIR__ . '/spam.php';
require_once __DIR__ . '/uploads.php';
require_once __DIR__ . '/report.php';
require_once __DIR__ . '/updates.php';

oys_ensure_schema($pdo);
