// Einstieg des Domain-Dienstes (node app/dist/cli.js domains:worker) und die Diagnose für Admins (domains:check).
// Der Dienst migriert nie: Er wartet nur lesend, bis die Datenbank den Schritt der eigenen Domains hat, läuft nur mit
// der Leitsperre (ein zweiter wartet) und endet bei SIGTERM nach der laufenden Runde.
import { closePool } from '../../db.js';
import { schemaAtLeast, V_CUSTOM_DOMAINS } from '../../schema.js';
import { baseHost } from '../../helpers.js';
import { intval } from '../../php.js';
import { LeaderLock } from '../../status/lock.js';
import { nowStr, toUnix } from '../../honeycombs/clock.js';
import { cnameTarget, domainsAvailable } from '../config.js';
import { domainByHost, domainById } from '../store.js';
import { normalizeHostname } from '../hostname.js';
import { probeAnswer } from '../tokens.js';
import { domainSettings, workerState } from '../settings.js';
import { cloudflareFromConfig } from './cloudflare.js';
import { dohFromConfig } from './dns.js';
import { configuredEdgeIps, probeConfig } from './probe.js';
import { runControl } from './control.js';
import { evaluate, NO_FACTS } from './evaluate.js';
import { DomainWorker, errText } from './worker.js';
import { CfRanges } from './cfips.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface WorkerIo {
  out(text: string): void;
  err(text: string): void;
}

// Läuft, bis stop() true wird. Für Tests: eigener Dienst, eigene Sperre, kurze Wartezeiten.
export async function runDomainWorker(o: { stop: () => boolean; worker?: DomainWorker; lock?: LeaderLock; loopMs?: number; waitMs?: number; log?: (l: string) => void }): Promise<void> {
  const log = o.log ?? ((l: string) => console.log(l));
  const loopMs = o.loopMs ?? 5000;
  const waitMs = o.waitMs ?? 30_000;
  const pause = async (ms: number): Promise<void> => {
    for (let t = 0; t < ms && !o.stop(); t += 250) await sleep(Math.min(250, ms));
  };
  // Nur lesend auf die Migration warten
  let logged = false;
  while (!o.stop() && !(await schemaAtLeast(V_CUSTOM_DOMAINS).catch(() => false))) {
    if (!logged) log(`Domains: waiting for the database update (custom domains need schema ${V_CUSTOM_DOMAINS}).`);
    logged = true;
    await pause(10_000);
  }
  const lock = o.lock ?? new LeaderLock('oys_domains_worker');
  let waiting = false;
  while (!o.stop()) {
    if (!domainsAvailable()) {
      if (!waiting) log('Domains: custom domains aren’t set up (install.sh --domains) – nothing to do.');
      waiting = true;
      await pause(60_000);
      continue;
    }
    let got = false;
    try {
      got = await lock.acquire();
    } catch (err) {
      log(`Domains: the database isn’t reachable (${errText(err)}) – trying again.`);
    }
    if (!got) {
      if (!waiting) log('Domains: another domain worker is running – waiting.');
      waiting = true;
      await pause(waitMs);
      continue;
    }
    waiting = false;
    log('Domains: worker started.');
    const worker = o.worker ?? new DomainWorker({ cf: cloudflareFromConfig(), doh: dohFromConfig() });
    let lastLockCheck = Date.now();
    while (!o.stop()) {
      try {
        await worker.tick();
      } catch (err) {
        log(`Domains: round failed: ${errText(err)}`);
      }
      if (Date.now() - lastLockCheck >= 10_000) {
        lastLockCheck = Date.now();
        if (!(await lock.alive())) {
          log('Domains: lost the lock – waiting for it again.');
          break;
        }
      }
      await pause(loopMs);
    }
    await lock.release();
  }
  log('Domains: worker stopped.');
}

// Dienst als Programm (eigener kleiner Pool: 4 Verbindungen plus die der Sperre)
export async function domainsWorkerCommand(io: WorkerIo): Promise<number> {
  let stopping = false;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => {
    stopping = true;
  });
  try {
    await runDomainWorker({ stop: () => stopping, log: (l) => io.out(l + '\n') });
    return 0;
  } catch (err) {
    io.err(`Domains: ${errText(err)}\n`);
    return 1;
  } finally {
    await closePool().catch(() => undefined);
  }
}

// Diagnose: alles, was der Dienst für eine Domain sehen würde – ohne etwas zu schreiben oder bei Cloudflare zu ändern
export async function domainsCheckCommand(args: string[], io: WorkerIo): Promise<number> {
  if (args.length !== 1) {
    io.err('Usage: node app/dist/cli.js domains:check <hostname>\n');
    return 1;
  }
  if (!domainsAvailable()) {
    io.err('Custom domains aren’t set up on this server (sudo bash server/install.sh --domains).\n');
    return 1;
  }
  const name = normalizeHostname(args[0], baseHost());
  if (!name.ok) {
    io.err(name.error + '\n');
    return 1;
  }
  const row = await domainByHost(name.ascii);
  if (!row) {
    io.err(`${name.ascii} isn’t connected to any page.\n`);
    return 1;
  }
  const full = (await domainById(intval(row.id)))!;
  const worker = new DomainWorker({ cf: cloudflareFromConfig(), doh: dohFromConfig(), ranges: new CfRanges((await workerState()).cf_ips ?? undefined) });
  const cfg = probeConfig();
  const control = await runControl({
    doh: dohFromConfig(), ranges: worker.ranges, target: cnameTarget(), base: baseHost(), expected: probeAnswer(baseHost()), port: cfg.port, ca: cfg.ca,
    fixedEdgeIps: configuredEdgeIps(),
  }).catch((err) => ({ ok: false, error: errText(err), edgeIps: [] as string[], edgeAddrs: [] as string[], probe: null }));
  worker.useEdge(control.edgeIps, control.edgeAddrs);
  const obs = await worker.observe(full, true);
  const now = Math.floor(Date.now() / 1000);
  const decision = evaluate({ row: full, obs, settings: await domainSettings(), frozen: !control.ok, now, at: nowStr, toUnix, manual: true, facts: NO_FACTS });
  io.out(JSON.stringify({
    hostname: full.hostname, state: full.state, problem: full.problem, cf_id: full.cf_id, control: { ok: control.ok, error: control.error, edge: control.edgeIps },
    observations: obs, wouldDo: { state: decision.state, cfAction: decision.cfAction, problem: decision.set.problem ?? full.problem, notice: decision.notice },
  }, null, 2) + '\n');
  return 0;
}
