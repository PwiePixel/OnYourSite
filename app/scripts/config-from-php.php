<?php
// config.php (PHP-Version) → config.json (Node-Version), gleiche Schlüssel. Aufruf: php config-from-php.php config.php
$file = $argv[1] ?? 'config.php';
$config = include $file;
if (!is_array($config)) {
    fwrite(STDERR, "No settings in $file\n");
    exit(1);
}
echo json_encode($config, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), "\n";
