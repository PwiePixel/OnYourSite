// Statusseiten: Befehle für den Server (server/backup.sh, den Wochenbericht und server/install.sh).
//   ping <job>         Heartbeat eines Jobs ohne Adresse: backup | weekly (setzt hb_last_ping_at direkt in der Datenbank)
//   planned <sekunden> Unser Eingang ist bis jetzt + Sekunden absichtlich gestört (Update); 0 = das Fenster endet jetzt.
//                      Heartbeat-Fristen beginnen nach dem Fenster neu, es zählt nichts als ausgefallen.
// Aufruf über cli.ts (status:ping, status:planned) oder direkt: node app/dist/status/ctl.js ping backup
import { exec, one, withConnection } from '../db.js';
import { schemaAtLeast, V_STATUS_TABLES } from '../schema.js';

export interface StatusIo {
  out(text: string): void;
  err(text: string): void;
}

export const STATUS_JOBS = ['backup', 'weekly'] as const;

const now = (): number => Math.floor(Date.now() / 1000);

// Rückgabe: true = gespeichert, false = es gibt den Bestandteil (noch) nicht
export async function statusPing(job: string, at = now()): Promise<boolean> {
  if (!(STATUS_JOBS as readonly string[]).includes(job)) throw new Error(`unknown job: ${job}`);
  if (!(await schemaAtLeast(V_STATUS_TABLES))) return false;
  const res = await exec("UPDATE status_monitors SET hb_last_ping_at = ? WHERE type = 'system' AND target = ?", [at, 'job:' + job]);
  return res.affectedRows > 0 || (await one("SELECT id FROM status_monitors WHERE type = 'system' AND target = ?", ['job:' + job])) !== null;
}

export async function statusPlanned(seconds: number, at = now()): Promise<number> {
  const until = at + Math.max(0, Math.min(seconds, 6 * 3600));
  await withConnection((db) => db.exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('status_planned', ?)", [String(until)]));
  return until;
}

// argv: ['ping', 'backup'] oder ['planned', '600']; Rückgabe wie ein Programm (0 = in Ordnung)
export async function statusCommand(argv: string[], io: StatusIo): Promise<number> {
  const [cmd, arg] = argv;
  try {
    if (cmd === 'ping' && argv.length === 2) {
      if (!(STATUS_JOBS as readonly string[]).includes(arg)) {
        io.err(`Unknown job "${arg}" – use one of: ${STATUS_JOBS.join(', ')}.\n`);
        return 1;
      }
      const ok = await statusPing(arg);
      io.out(ok ? `Status: ping for ${arg} saved.\n` : 'Status: the status tables don’t exist yet – nothing to do.\n');
      return 0;
    }
    if (cmd === 'planned' && argv.length === 2 && /^\d{1,5}$/.test(arg)) {
      const until = await statusPlanned(Number(arg));
      io.out(Number(arg) === 0 ? 'Status: the planned window ended.\n' : `Status: planned window until ${new Date(until * 1000).toISOString()}.\n`);
      return 0;
    }
  } catch (err) {
    io.err(`Status: ${(err as Error).message}\n`);
    return 1;
  }
  io.err('Usage: status:ping backup|weekly | status:planned <seconds>\n');
  return 1;
}
