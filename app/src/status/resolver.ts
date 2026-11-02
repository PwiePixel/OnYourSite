// Statusseiten: Namensauflösung nur über die öffentlichen Resolver aus config.json (status.dns) – nie getaddrinfo,
// /etc/hosts oder der Resolver des Systems (auf dem Server zeigt /etc/hosts die eigene Domain auf 127.0.0.1).
// Jede gelieferte Adresse muss die Regeln von guard.ts erfüllen, sonst gilt der Host als gesperrt. IPv4 zuerst,
// IPv6 nur ohne A-Einträge. Ergebnisse bleiben min(TTL, 300 s) im Speicher, NXDOMAIN/NODATA 60 s; Ausfälle des
// Resolvers (Zeitüberschreitung, SERVFAIL) nur 10 s, damit nach seiner Erholung nichts Falsches hängen bleibt.
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ipVerdict, type GuardPolicy } from './guard.js';

export type DnsFailure = 'nxdomain' | 'nodata' | 'servfail' | 'timeout' | 'refused' | 'other';

export type ResolveResult =
  | { ok: true; family: 4 | 6; addresses: string[]; ttl: number }
  // transient: der Resolver hat nicht geantwortet (Zeit, SERVFAIL) – ob das unser Problem ist, entscheidet die
  // Plattform-Sperre mit dem Resolver-Kanarienvogel
  | { ok: false; error: 'dns'; failure: DnsFailure; transient: boolean }
  | { ok: false; error: 'blocked'; address: string };

export interface ResolverOptions {
  servers: string[];
  timeoutMs?: number; // je Versuch (2,5 s)
  tries?: number; // Versuche je Server (2)
  maxTtl?: number; // Sekunden (300)
  negativeTtl?: number; // NXDOMAIN/NODATA (60)
  transientTtl?: number; // Ausfall des Resolvers (10)
  maxEntries?: number;
  now?: () => number; // Millisekunden (Tests)
}

interface Raw {
  a: string[];
  aaaa: string[];
  ttl: number;
  failure: DnsFailure | null;
}

const TRANSIENT = new Set<DnsFailure>(['servfail', 'timeout', 'refused', 'other']);

function failureOf(err: unknown): DnsFailure {
  const code = (err as { code?: string }).code ?? '';
  if (code === 'ENOTFOUND') return 'nxdomain';
  if (code === 'ENODATA') return 'nodata';
  if (code === 'ESERVFAIL') return 'servfail';
  if (code === 'ETIMEOUT') return 'timeout';
  if (code === 'EREFUSED' || code === 'ECONNREFUSED') return 'refused';
  return 'other';
}

export interface ResolverHealth {
  okAt: number | null; // ms: letzte Antwort eines Resolvers (auch NXDOMAIN)
  failAt: number | null; // ms: letzter Ausfall
  failures: number; // Ausfälle in Folge
}

export class PublicResolver {
  private readonly resolver: Resolver;
  private readonly cache = new Map<string, { until: number; raw: Raw }>();
  private readonly pending = new Map<string, Promise<Raw>>();
  private readonly opts: Required<Omit<ResolverOptions, 'servers'>>;
  private state: ResolverHealth = { okAt: null, failAt: null, failures: 0 };

  constructor(readonly options: ResolverOptions) {
    this.opts = {
      timeoutMs: options.timeoutMs ?? 2500,
      tries: options.tries ?? 2,
      maxTtl: options.maxTtl ?? 300,
      negativeTtl: options.negativeTtl ?? 60,
      transientTtl: options.transientTtl ?? 10,
      maxEntries: options.maxEntries ?? 50000,
      now: options.now ?? Date.now,
    };
    this.resolver = new Resolver({ timeout: this.opts.timeoutMs, tries: this.opts.tries });
    this.resolver.setServers(options.servers);
  }

  health(): ResolverHealth {
    return { ...this.state };
  }

  clear(): void {
    this.cache.clear();
  }

  // Beide Familien gleichzeitig fragen; gleichzeitige Anfragen für denselben Host teilen sich eine
  private async lookup(host: string): Promise<Raw> {
    const now = this.opts.now();
    const hit = this.cache.get(host);
    if (hit && hit.until > now) return hit.raw;
    const running = this.pending.get(host);
    if (running) return running;
    const p = this.query(host).finally(() => this.pending.delete(host));
    this.pending.set(host, p);
    return p;
  }

  private async query(host: string): Promise<Raw> {
    const [a, aaaa] = await Promise.allSettled([this.resolver.resolve4(host, { ttl: true }), this.resolver.resolve6(host, { ttl: true })]);
    const now = this.opts.now();
    const raw: Raw = { a: [], aaaa: [], ttl: this.opts.maxTtl, failure: null };
    const failures: DnsFailure[] = [];
    for (const [res, list] of [[a, raw.a], [aaaa, raw.aaaa]] as const) {
      if (res.status === 'fulfilled') {
        for (const r of res.value) {
          list.push(r.address);
          raw.ttl = Math.min(raw.ttl, Math.max(0, r.ttl));
        }
      } else {
        failures.push(failureOf(res.reason));
      }
    }
    let ttl = raw.ttl;
    if (raw.a.length === 0 && raw.aaaa.length === 0) {
      // NXDOMAIN schlägt alles, dann ein Ausfall des Resolvers, zuletzt „keine Einträge“
      raw.failure = failures.includes('nxdomain') ? 'nxdomain' : (failures.find((f) => TRANSIENT.has(f)) ?? 'nodata');
      ttl = TRANSIENT.has(raw.failure) ? this.opts.transientTtl : this.opts.negativeTtl;
    }
    if (raw.failure && TRANSIENT.has(raw.failure)) {
      this.state = { okAt: this.state.okAt, failAt: now, failures: this.state.failures + 1 };
    } else {
      this.state = { okAt: now, failAt: this.state.failAt, failures: 0 };
    }
    if (ttl > 0) {
      if (this.cache.size >= this.opts.maxEntries) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      this.cache.delete(host);
      this.cache.set(host, { until: now + ttl * 1000, raw });
    }
    return raw;
  }

  // Öffentliche, geprüfte Adressen eines Hosts für diesen Port (eine IP-Adresse wird direkt geprüft)
  async resolvePublic(host: string, port: number, policy: GuardPolicy): Promise<ResolveResult> {
    const ip = isIP(host);
    if (ip) {
      return ipVerdict(host, port, policy).ok
        ? { ok: true, family: ip as 4 | 6, addresses: [host], ttl: 0 }
        : { ok: false, error: 'blocked', address: host };
    }
    const raw = await this.lookup(host);
    if (raw.failure) return { ok: false, error: 'dns', failure: raw.failure, transient: TRANSIENT.has(raw.failure) };
    // Jede Adresse muss erlaubt sein – auch die der Familie, die nicht benutzt wird
    for (const address of [...raw.a, ...raw.aaaa]) {
      if (!ipVerdict(address, port, policy).ok) return { ok: false, error: 'blocked', address };
    }
    return raw.a.length
      ? { ok: true, family: 4, addresses: [...raw.a], ttl: raw.ttl }
      : { ok: true, family: 6, addresses: [...raw.aaaa], ttl: raw.ttl };
  }
}

// Resolver-Kanarienvogel (Plattform-Sperre): jeden Resolver einzeln nach den Namen fragen. Ein Resolver „antwortet“,
// wenn er für mindestens einen Namen eine Antwort gibt (auch NXDOMAIN). ok = mindestens einer antwortet.
export async function resolverCanary(servers: string[], names: string[], timeoutMs = 2500): Promise<{ ok: boolean; answered: number; of: number }> {
  const results = await Promise.all(servers.map(async (server) => {
    const r = new Resolver({ timeout: timeoutMs, tries: 1 });
    r.setServers([server]);
    const answers = await Promise.allSettled(names.map((n) => r.resolve4(n)));
    return answers.some((x) => x.status === 'fulfilled' || ['nxdomain', 'nodata'].includes(failureOf(x.reason)));
  }));
  const answered = results.filter(Boolean).length;
  return { ok: answered > 0, answered, of: servers.length };
}

// Wessen Problem ist ein DNS-Fehler? Antwortet kein Resolver (Zeit, SERVFAIL) und fällt zugleich der
// Resolver-Kanarienvogel aus, liegt es bei uns ('internal': zählt nicht gegen das Ziel). NXDOMAIN, leere Antworten und
// Ausfälle bei gesundem Kanarienvogel gehören dem Ziel (eine Zone mit toten Nameservern sieht genau so aus).
export function dnsOutcome(result: { error: 'dns'; transient: boolean }, canaryOk: boolean): 'dns' | 'internal' {
  return result.transient && !canaryOk ? 'internal' : 'dns';
}
