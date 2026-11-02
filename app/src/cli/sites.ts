// Befehle für die Liste aller Adressen (content/addresses.ts):
//   sites:repair            Liste und Tabellen abgleichen (install.sh --update nach der Prüfung der neuen Version):
//                           fehlende Einträge anlegen, verwaiste zu Reservierungen machen, Zähler der Code-Seiten
//                           neu zählen, Auffälliges melden
//   sites:release <adresse> [--yes]
//                           eine Reservierung vorzeitig beenden (z. B. nach einer Anfrage beim Support); zeigt zuerst,
//                           für wen und bis wann sie gilt, und fragt nach (--yes: ohne Nachfrage)
// Aufruf über app/dist/cli.js (sitesCommand) oder direkt: node dist/cli/sites.js repair | release <adresse> [--yes]
// (Entwicklung: node --import tsx src/cli/sites.ts …). Rückgabe 0 = in Ordnung, 1 = Fehler oder abgebrochen.
import { createInterface } from 'node:readline/promises';
import { ConfigMissingError, loadConfig } from '../config.js';
import { DbUnavailableError, closePool, one, timeZone, transaction } from '../db.js';
import { ensureSchemaOnce } from '../schema.js';
import { intval, phpStr } from '../php.js';
import { addressRow, endHold, repairAddresses } from '../content/addresses.js';
import { codeRepair } from '../code/sites.js';

// Ausgabe, Umgebung und Rückfrage – Tests geben eigene mit (gleiche Form wie in app/src/cli.ts)
export interface SitesIo {
  out(text: string): void;
  err(text: string): void;
  // Frage auf dem Terminal; fehlt sie (kein Terminal), wird nicht gefragt
  ask?(question: string): Promise<string>;
}

const firstLine = (err: unknown): string => String(err instanceof Error ? err.message : err).split('\n').find((l) => l.trim() !== '') ?? 'unknown error';

// Einstieg für app/dist/cli.js: 'sites:repair' und 'sites:release' (die Einstellungen sind dort schon geladen)
export async function sitesCommand(command: string, args: string[], io: SitesIo): Promise<number> {
  try {
    await ensureSchemaOnce();
    if (command === 'sites:repair' && args.length === 0) return await sitesRepair(io);
    if (command === 'sites:release') return await sitesRelease(args, io);
    io.err('Usage: node app/dist/cli.js sites:repair | sites:release <address> [--yes]\n');
    return 1;
  } catch (err) {
    if (err instanceof DbUnavailableError) io.err(`The database can’t be reached: ${firstLine(err)}\n`);
    else io.err(`The address list couldn’t be checked: ${firstLine(err)}\n`);
    return 1;
  }
}

// sites:repair – in einer Transaktion; mehrfach aufrufbar
export async function sitesRepair(io: SitesIo): Promise<number> {
  const report = await transaction((_conn, db) => repairAddresses(db));
  // Code-Seiten: Zähler für Dateien und Größe, Seiten ohne Adresse, kaputte Plätze
  const code = await transaction((_conn, db) => codeRepair(db));
  if (code.recounted > 0) report.claimed.push(`Recounted the files of ${code.recounted} code page${code.recounted === 1 ? '' : 's'}`);
  report.anomalies.push(...code.anomalies);
  const section = (title: string, lines: string[]) => {
    if (!lines.length) return;
    io.out(`${title} (${lines.length}):\n`);
    for (const line of lines) io.out(`  - ${line}\n`);
  };
  section('Added to the address list', report.added);
  section('Updated', report.claimed);
  section('Reserved for their owner (the site no longer uses the address)', report.held);
  section('Please check', report.anomalies);
  const changes = report.added.length + report.claimed.length + report.held.length;
  io.out(changes === 0 && !report.anomalies.length ? 'Address list: everything is in order.\n'
    : `Address list: ${changes} change${changes === 1 ? '' : 's'}, ${report.anomalies.length} thing${report.anomalies.length === 1 ? '' : 's'} to check.\n`);
  return 0;
}

// sites:release <adresse> [--yes]
export async function sitesRelease(args: string[], io: SitesIo): Promise<number> {
  const yes = args.includes('--yes');
  const rest = args.filter((a) => a !== '--yes');
  const slug = (rest[0] ?? '').toLowerCase();
  if (rest.length !== 1 || !/^[a-z0-9-]{1,63}$/.test(slug)) {
    io.err('Usage: node app/dist/cli.js sites:release <address> [--yes]\n');
    return 1;
  }
  const row = await addressRow(slug);
  if (!row) {
    io.err(`The address “${slug}” is not in the address list – it is free.\n`);
    return 1;
  }
  if (row.kind !== 'held') {
    io.err(`The address “${slug}” is not reserved – it belongs to ${row.kind} #${intval(row.ref_id)}.\n`);
    return 1;
  }
  let owner = 'nobody (the account was deleted or the team removed the site)';
  if (row.user_id !== null) {
    const user = await one('SELECT email FROM users WHERE id = ?', [intval(row.user_id)]);
    owner = `user #${intval(row.user_id)}` + (user ? ` (${phpStr(user.email)})` : ' (account deleted)');
  }
  io.out(`The address “${slug}” is reserved for ${owner} since ${phpStr(row.released_at ?? '?')}, until ${phpStr(row.hold_until ?? '?')}.\n`);
  if (!yes) {
    if (!io.ask) {
      io.err('Run again with --yes to end this reservation.\n');
      return 1;
    }
    const answer = (await io.ask('End this reservation now? Anyone can then take the address. Type yes to confirm: ')).trim().toLowerCase();
    if (answer !== 'yes') {
      io.out('Nothing was changed.\n');
      return 1;
    }
  }
  if (!(await transaction((_conn, db) => endHold(db, slug)))) {
    io.err(`The address “${slug}” is no longer reserved – nothing was changed.\n`);
    return 1;
  }
  io.out(`The address “${slug}” is free again.\n`);
  return 0;
}

// Direkt aufgerufen: node dist/cli/sites.js repair | release <adresse> [--yes]
const isMain = process.argv[1] && /[\\/]cli[\\/]sites\.(js|ts)$/.test(process.argv[1]);
if (isMain) {
  const [sub, ...rest] = process.argv.slice(2);
  let code = 1;
  try {
    loadConfig();
    process.env.TZ = timeZone();
    const tty = process.stdin.isTTY && process.stdout.isTTY;
    const io: SitesIo = {
      out: (text) => process.stdout.write(text),
      err: (text) => process.stderr.write(text),
      ask: tty ? async (question) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          return await rl.question(question);
        } finally {
          rl.close();
        }
      } : undefined,
    };
    code = await sitesCommand(sub === 'repair' ? 'sites:repair' : sub === 'release' ? 'sites:release' : String(sub), rest, io);
  } catch (err) {
    if (err instanceof ConfigMissingError) process.stderr.write(err.message + '\n');
    else throw err;
  } finally {
    await closePool().catch(() => undefined);
  }
  process.exitCode = code;
}
