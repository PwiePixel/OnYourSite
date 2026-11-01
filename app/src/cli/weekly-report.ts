// Wochenbericht als Befehl (cron/weekly_report.php). Eigener Server: montags um 8:00 über den systemd-Timer
// onyoursite-weekly-report.
//   node dist/cli/weekly-report.js        (Entwicklung: node --import tsx src/cli/weekly-report.ts)
// Ausgabe und Rückgabewert wie in PHP: eine Zeile „Y-m-d H:i – Weekly reports sent: N, failed: M“ und 0. Ist die
// Datenbank nicht erreichbar, steht wie bei PHP (db.php) die Hinweisseite in der Ausgabe – auch dann mit 0. Jeder andere
// Fehler endet wie ein PHP Fatal error mit 255.
import { ConfigMissingError, loadConfig } from '../config.js';
import { DbUnavailableError, closePool, timeZone, value } from '../db.js';
import { ensureSchemaOnce } from '../schema.js';
import { date } from '../php.js';
import { DB_FAILED_TEXT, DB_FAILED_TITLE, setupErrorPage } from '../web/setupError.js';
import { runWeeklyReports } from '../app/report.js';

// Text auf stdout – erst weiter, wenn er geschrieben ist (stdout an eine Datei oder Pipe ist asynchron)
const out = (text: string): Promise<void> => new Promise((resolve) => process.stdout.write(text, () => resolve()));

export async function weeklyReportCli(): Promise<number> {
  try {
    loadConfig();
  } catch (err) {
    // Ohne config.json startet auch der Server nicht (Meldung, Rückgabewert 1)
    if (err instanceof ConfigMissingError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }
  process.env.TZ = timeZone();
  try {
    // lib/bootstrap.php: Verbindung (db.php) und Schema – schlägt die Verbindung fehl, die Hinweisseite
    try {
      await value('SELECT 1');
      await ensureSchemaOnce();
    } catch (err) {
      if (!(err instanceof DbUnavailableError)) throw err;
      console.error('DB connection failed: ' + err.message);
      await out(setupErrorPage(DB_FAILED_TITLE, DB_FAILED_TEXT));
      return 0;
    }
    const result = await runWeeklyReports();
    await out(date('Y-m-d H:i') + ' – Weekly reports sent: ' + result.sent + ', failed: ' + result.failed + '\n');
    return 0;
  } catch (err) {
    console.error('Weekly report failed:', err);
    return 255;
  } finally {
    await closePool().catch(() => undefined);
  }
}

const isMain = process.argv[1] && /weekly-report\.(js|ts)$/.test(process.argv[1]);
if (isMain) {
  process.exitCode = await weeklyReportCli();
}
