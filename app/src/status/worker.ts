// Einstieg des Prüfdienstes onyoursite-status.service: node app/dist/status/worker.js (Entwicklung: npx tsx
// src/status/worker.ts). Migriert nie: wartet nur lesend, bis die Datenbank den Schritt der Statusseiten hat. Läuft nur
// mit der Leitsperre (ein zweiter Dienst wartet), braucht die Datenbank über den Unix-Socket (der Dienst darf keine
// lokale Adresse erreichen) und endet bei SIGTERM sauber: nichts Neues, laufende Prüfungen höchstens 10 s, alles
// schreiben, Sperre freigeben.
import { configString, loadConfig, ConfigMissingError } from '../config.js';
import { closePool, timeZone } from '../db.js';
import { baseAuthority, baseHost, mainUrl, scheme } from '../helpers.js';
import { botSecret } from '../community/community.js';
import { schemaAtLeast, V_STATUS_TABLES } from '../schema.js';
import { Checker, type CheckerDeps } from './checker.js';
import { LeaderLock } from './lock.js';
import { interfaceAddresses, runtimePolicy } from './policy.js';
import { PublicResolver } from './resolver.js';
import { statusServerConfig } from './settings.js';
import { smtpConfigured } from './system.js';

const log = (line: string): void => console.log(line);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const USER_AGENT = (): string => `OnYourSite-Monitor/1.0 (+${mainUrl('/terms/status-pages#checks')})`;

// Abhängigkeiten im Betrieb – alles aus config.json und den Einstellungen, keine Ausnahmen
export function productionDeps(): CheckerDeps {
  const server = statusServerConfig();
  const canaryHosts = server.canaries.map((u) => {
    const m = /^https:\/\/([^/:]+)/.exec(u);
    return m ? m[1] : '';
  }).filter((h) => h !== '');
  return {
    policy: (settings) => runtimePolicy(settings, statusServerConfig()),
    resolver: new PublicResolver({ servers: server.dns }),
    clock: Date.now,
    ipv6: interfaceAddresses().some((a) => a.includes(':')),
    userAgent: USER_AGENT(),
    canaries: server.canaries,
    dnsServers: server.dns,
    canaryNames: [...canaryHosts, baseHost()],
    baseUrl: mainUrl(''),
    healthUrl: `${scheme()}://health.${baseAuthority()}/_/health`,
    tz: timeZone(),
    facts: () => ({ botSecret: botSecret() !== '', smtp: smtpConfigured(), tunnel: statusServerConfig().tunnel }),
    scheduler: { concurrency: server.concurrency, keywordConcurrency: server.keyword_concurrency, userInflight: server.user_inflight },
  };
}

// Nur lesend warten, bis die Webseite (oder cli.js migrate) die Datenbank auf den Stand gebracht hat – der Dienst
// migriert nie (während --reset schreibt er so nie in eine halb angelegte Datenbank). false = abgebrochen.
export async function waitForSchema(stop: () => boolean, pollMs = 10_000): Promise<boolean> {
  let logged = false;
  while (!stop()) {
    if (await schemaAtLeast(V_STATUS_TABLES).catch(() => false)) return true;
    if (!logged) log(`Waiting for the database update (the status tables need schema ${V_STATUS_TABLES}).`);
    logged = true;
    for (let t = 0; t < pollMs && !stop(); t += Math.min(500, pollMs)) await sleep(Math.min(500, pollMs));
  }
  return false;
}

// Läuft, bis stop() aufgerufen wird; makeChecker/makeLock für Tests der Sperre
export async function runWorker(opts: { stop: () => boolean; makeChecker?: () => Checker; lock?: LeaderLock; waitMs?: number } = { stop: () => false }): Promise<void> {
  const lock = opts.lock ?? new LeaderLock('oys_status_worker');
  const waitMs = opts.waitMs ?? 30_000;
  let waitingLogged = false;
  while (!opts.stop()) {
    let got = false;
    try {
      got = await lock.acquire();
    } catch (err) {
      log(`Status checker: the database isn’t reachable (${(err as Error).message}) – trying again.`);
    }
    if (!got) {
      if (!waitingLogged) log('Another status worker is running – waiting.');
      waitingLogged = true;
      for (let t = 0; t < waitMs && !opts.stop(); t += 500) await sleep(500);
      continue;
    }
    waitingLogged = false;
    log('Status checker started.');
    let checker: Checker | null = null;
    let lost = false;
    try {
      // Auch das Anlegen gehört hierher: ein Fehler dabei (z. B. die Netzwerkkarten) wird protokolliert und neu
      // versucht, statt das Programm zu beenden
      checker = opts.makeChecker ? opts.makeChecker() : new Checker(productionDeps());
      await checker.start();
      let lastPing = Date.now();
      while (!opts.stop() && !lost) {
        const wake = checker.tick();
        await sleep(Math.max(10, Math.min(1000, wake - Date.now())));
        if (Date.now() - lastPing >= 10_000) {
          lastPing = Date.now();
          if (!(await lock.alive())) lost = true;
        }
      }
    } catch (err) {
      log(`Status checker stopped after an error: ${(err as Error).message}`);
      lost = true;
    }
    if (lost) {
      // Ohne Sperre wird nichts mehr geschrieben – laufende Prüfungen brechen ab
      log('Status checker: lost the lock – stopping the checks and waiting for it again.');
      await checker?.stop(true);
      await lock.release();
      await sleep(1000);
      continue;
    }
    await checker?.stop(false);
    await lock.release();
    log('Status checker stopped.');
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
  // Der Dienst erreicht keine lokale Adresse (IPAddressDeny) – nur den Socket der Datenbank
  if (configString('db.host', 'localhost') !== 'localhost') {
    console.error('The status checker needs the database socket – set db.host to localhost in config.json.');
    process.exit(1);
  }
  let stopping = false;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => {
    stopping = true;
  });
  if (await waitForSchema(() => stopping)) await runWorker({ stop: () => stopping });
  await closePool().catch(() => undefined);
  process.exit(0);
}

if (process.argv[1] && /status[\\/]worker\.(js|ts)$/.test(process.argv[1])) void main();
