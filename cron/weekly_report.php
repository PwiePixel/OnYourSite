<?php
// Weekly report: every Monday a short email with views, clicks and the best link.
//
// Plesk: "Scheduled Tasks" → "Run a PHP script"
//   Script:   /httpdocs/cron/weekly_report.php   (adjust the path to your installation)
//   Schedule: Mondays, 8:00   (cron: 0 8 * * 1)
//
// Alternatively as a web cron (if 'cron_secret' is set in config.php):
//   https://on-your.site/_/cron/weekly-report?key=YOUR_SECRET

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('Command line / Plesk task only.');
}

chdir(dirname(__DIR__));
require dirname(__DIR__) . '/lib/bootstrap.php';

$result = oys_run_weekly_reports($pdo);
echo date('Y-m-d H:i') . ' – Weekly reports sent: ' . $result['sent'] . ', failed: ' . $result['failed'] . PHP_EOL;
