// Kleiner Einstieg für die Befehle der Statusseiten, solange cli.ts sie nicht selbst kennt:
//   node app/dist/status/ctl.js ping backup        (Ende von server/backup.sh)
//   node app/dist/status/ctl.js ping weekly        (nach dem Wochenbericht)
//   node app/dist/status/ctl.js planned 600        (vor dem Neustart bei install.sh --update; danach planned 0)
import { ConfigMissingError, loadConfig } from '../config.js';
import { closePool, timeZone } from '../db.js';
import { statusCommand } from './commands.js';

async function main(): Promise<number> {
  try {
    loadConfig();
  } catch (err) {
    process.stderr.write((err instanceof ConfigMissingError ? err.message : String(err)) + '\n');
    return 1;
  }
  process.env.TZ = timeZone();
  try {
    return await statusCommand(process.argv.slice(2), { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) });
  } finally {
    await closePool().catch(() => undefined);
  }
}

if (process.argv[1] && /status[\\/]ctl\.(js|ts)$/.test(process.argv[1])) {
  void main().then((code) => process.exit(code));
}
