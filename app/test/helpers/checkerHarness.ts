// Test-Einstieg des Prüfdienstes: derselbe Kern (Checker) wie im Betrieb, aber mit einer Richtlinie, die nur 127.0.0.1
// auf den Ports der Testserver erlaubt, einem Test-DNS, Kanarienvögeln auf dem Testserver und einer verstellbaren Uhr.
// Der Einstieg des Dienstes (src/status/worker.ts) kennt keine solche Ausnahme – weder Umgebung noch Einstellung.
import { Checker, type CheckerDeps } from '../../src/status/checker.js';
import { addressList } from '../../src/status/guard.js';
import { noLimits, systemLimits, type StatusLimits } from '../../src/status/limits.js';
import { PublicResolver } from '../../src/status/resolver.js';
import { statusSettings } from '../../src/status/settings.js';
import type { SystemFacts } from '../../src/status/system.js';
import type { FakeDns } from './dnsServer.js';
import type { Targets } from './targets.js';

export interface TestClock {
  now: () => number;
  advance(ms: number): void;
}

export function testClock(): TestClock {
  let offset = 0;
  return { now: () => Date.now() + offset, advance: (ms) => void (offset += ms) };
}

export interface HarnessOptions {
  dns: FakeDns;
  targets: Targets;
  clock: TestClock;
  ca?: string;
  facts?: Partial<SystemFacts>;
  userChecks?: number; // so viele Prüfungen haben Nutzer (ohne Shop gäbe es keine)
  log?: string[];
}

export function testChecker(o: HarnessOptions): Checker {
  const t = o.targets;
  const ports = [t.httpPort, t.httpsPort];
  const deps: CheckerDeps = {
    policy: (s) => ({ ports: [...s.ports, ...ports], tunnel: false, self: addressList([]), testAllow: (ip, port) => ip === '127.0.0.1' && ports.includes(port) }),
    resolver: new PublicResolver({ servers: [o.dns.server], timeoutMs: 300, tries: 1, now: o.clock.now }),
    clock: o.clock.now,
    ipv6: false,
    userAgent: 'OnYourSite-Monitor/1.0 (+test)',
    canaries: [1, 2, 3].map((n) => `http://canary${n}.zz:${t.httpPort}/canary/${n}`),
    dnsServers: [o.dns.server],
    canaryNames: ['canary1.zz', 'canary2.zz', 'canary3.zz'],
    baseUrl: `http://web.zz:${t.httpPort}`,
    healthUrl: `http://health.web.zz:${t.httpPort}/_/health`,
    tz: 'Europe/Berlin',
    facts: () => ({ botSecret: false, smtp: false, tunnel: false, ...o.facts }),
    scheduler: { concurrency: 50, keywordConcurrency: 8, userInflight: 8 },
    limitsFor: async (uid): Promise<StatusLimits> => {
      const s = await statusSettings();
      if (uid === null) return systemLimits(s);
      return o.userChecks ? { ...noLimits(s), plan: 'free', checks: o.userChecks, components: s.components_max, minInterval: 60 } : noLimits(s);
    },
    ca: o.ca,
    canaryTimeoutSec: 1,
    log: (line) => void o.log?.push(line),
  };
  return new Checker(deps);
}
