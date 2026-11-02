// Einstieg des Benachrichtigungsdienstes onyoursite-status-notify.service: node app/dist/status/notify.js
// (Entwicklung: npx tsx src/status/notify.ts). Wie der Prüfdienst: migriert nie (wartet nur lesend auf den Schritt der
// Statusseiten), läuft nur mit der Leitsperre 'oys_status_notify' (ein zweiter Dienst wartet) und endet bei SIGTERM
// sauber. Anders als der Prüfdienst darf er den Resolver des Systems, den Mail-Server (auch einen lokalen) und
// Discord erreichen – mit Adressen von Nutzern verbindet er sich nie.
import { ConfigMissingError, loadConfig } from '../config.js';
import { closePool, timeZone } from '../db.js';
import { LeaderLock } from './lock.js';
import { Notifier } from './notifier.js';
import { waitForSchema } from './worker.js';
// Register der Bot-Aufträge (status.alert usw.) – für den Auftrag an den Bot
import './posts.js';

const log = (line: string): void => console.log(line);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runNotifier(opts: { stop: () => boolean; makeNotifier?: () => Notifier; lock?: LeaderLock; waitMs?: number } = { stop: () => false }): Promise<void> {
  const lock = opts.lock ?? new LeaderLock('oys_status_notify');
  const waitMs = opts.waitMs ?? 30_000;
  let waitingLogged = false;
  while (!opts.stop()) {
    let got = false;
    try {
      got = await lock.acquire();
    } catch (err) {
      log(`Status notifier: the database isn’t reachable (${(err as Error).message}) – trying again.`);
    }
    if (!got) {
      if (!waitingLogged) log('Another status notifier is running – waiting.');
      waitingLogged = true;
      for (let t = 0; t < waitMs && !opts.stop(); t += 500) await sleep(500);
      continue;
    }
    waitingLogged = false;
    log('Status notifier started.');
    let notifier: Notifier | null = null;
    let lost = false;
    try {
      notifier = opts.makeNotifier ? opts.makeNotifier() : new Notifier();
      await notifier.start();
      let lastPing = Date.now();
      while (!opts.stop() && !lost) {
        notifier.tick();
        await sleep(500);
        if (Date.now() - lastPing >= 10_000) {
          lastPing = Date.now();
          if (!(await lock.alive())) lost = true;
        }
      }
    } catch (err) {
      log(`Status notifier stopped after an error: ${(err as Error).message}`);
      lost = true;
    }
    if (lost) {
      log('Status notifier: lost the lock – waiting for it again.');
      await notifier?.settle().catch(() => undefined);
      await lock.release();
      await sleep(1000);
      continue;
    }
    await notifier?.stop();
    await lock.release();
    log('Status notifier stopped.');
  }
}

async function main(): Promise<void> {
  try {
    loadConfig();
  } catch (err) {
    console.error(err instanceof ConfigMissingError ? err.message : String(err));
    process.exit(1);
  }
  process.env.TZ = timeZone();
  let stopping = false;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => {
    stopping = true;
  });
  if (await waitForSchema(() => stopping)) await runNotifier({ stop: () => stopping });
  await closePool().catch(() => undefined);
  process.exit(0);
}

if (process.argv[1] && /status[\\/]notify\.(js|ts)$/.test(process.argv[1])) void main();
