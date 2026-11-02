// Wochenbericht als Befehl (cron/weekly_report.php). Eigener Server: montags um 8:00 über den systemd-Timer
// onyoursite-weekly-report.
//   node dist/cli/weekly-report.js        (Entwicklung: node --import tsx src/cli/weekly-report.ts)
// Ausgabe: eine Zeile „Y-m-d H:i – Weekly reports sent: N, failed: M“ (dazu „, skipped: K“, wenn Konten nichts zu
// berichten hatten) und 0. Ist die Datenbank nicht erreichbar: „The database can’t be reached: …“ und 1, damit der
// systemd-Timer den Fehler zeigt. Jeder andere Fehler: Meldung mit Stack und 255.
import { ConfigMissingError, loadConfig } from '../config.js';
import { DbUnavailableError, closePool, timeZone, value } from '../db.js';
import { ensureSchemaOnce } from '../schema.js';
import { date } from '../php.js';
import { runWeeklyReports } from '../app/report.js';

// Ausgabe des Befehls: Text auf stdout (erst weiter, wenn er geschrieben ist – stdout an eine Datei oder Pipe ist
// asynchron) und Meldungen auf stderr. Tests geben eigene Empfänger mit, statt process.stdout zu ersetzen (der
// Test-Runner schreibt dort selbst).
export interface CliOutput {
  out(text: string): Promise<void>;
  err(line: string): void;
}
const stdio: CliOutput = {
  out: (text) => new Promise((resolve) => process.stdout.write(text, () => resolve())),
  err: (line) => console.error(line),
};

export async function weeklyReportCli(io: CliOutput = stdio): Promise<number> {
  try {
    loadConfig();
  } catch (err) {
    // Ohne config.json startet auch der Server nicht (Meldung, Rückgabewert 1)
    if (err instanceof ConfigMissingError) {
      io.err(err.message);
      return 1;
    }
    throw err;
  }
  process.env.TZ = timeZone();
  try {
    // Verbindung und Schema – ist die Datenbank nicht erreichbar, eine klare Meldung und 1 (systemd zeigt den Fehler)
    try {
      await value('SELECT 1');
      await ensureSchemaOnce();
    } catch (err) {
      if (!(err instanceof DbUnavailableError)) throw err;
      io.err('The database can’t be reached: ' + (err.message.split('\n').find((l) => l.trim() !== '') ?? 'unknown error'));
      return 1;
    }
    const result = await runWeeklyReports();
    await io.out(date('Y-m-d H:i') + ' – Weekly reports sent: ' + result.sent + ', failed: ' + result.failed
      + (result.skipped > 0 ? ', skipped: ' + result.skipped : '') + '\n');
    return 0;
  } catch (err) {
    io.err('Weekly report failed: ' + (err instanceof Error ? (err.stack ?? err.message) : String(err)));
    return 255;
  } finally {
    await closePool().catch(() => undefined);
  }
}

const isMain = process.argv[1] && /weekly-report\.(js|ts)$/.test(process.argv[1]);
if (isMain) {
  process.exitCode = await weeklyReportCli();
}
