// DoH (JSON) zum Nachbauen für die Tests des Domain-Dienstes: zwei „Resolver“ (/a und /b) auf einem node:http-Server
// mit gemeinsamen Einträgen, die der Test jederzeit ändert – und Abweichungen je Resolver (z. B. SERVFAIL nur bei b).
// Zonen liefern ihre SOA in der Authority (NXDOMAIN/NODATA), CNAME-Ketten werden aufgelöst. Zählt jede Frage.
import { createServer } from 'node:http';

export interface DnsEntry {
  A?: string[];
  AAAA?: string[];
  CNAME?: string;
  TXT?: string[]; // Werte (werden in Anführungszeichen ausgeliefert, lange in Teilen)
  rcode?: number; // z. B. 2 = SERVFAIL für diesen Namen
}

export interface DohMock {
  urls: [string, string]; // Resolver a und b
  records: Map<string, DnsEntry>;
  zones: Set<string>; // Namen, die eine Zone sind (SOA)
  only: { a: Map<string, DnsEntry>; b: Map<string, DnsEntry> }; // Abweichungen je Resolver
  queries: Array<{ resolver: string; name: string; type: string }>;
  count(name: string, type?: string): number;
  close(): Promise<void>;
}

const TYPES: Record<string, number> = { A: 1, CNAME: 5, SOA: 6, TXT: 16, AAAA: 28 };

// "abc…" in Stücken zu 255 Zeichen, wie DNS lange TXT-Werte überträgt
const quoteTxt = (v: string): string => (v.match(/.{1,255}/g) ?? ['']).map((p) => '"' + p.replace(/"/g, '\\"') + '"').join(' ');

export async function startDohMock(): Promise<DohMock> {
  const records = new Map<string, DnsEntry>();
  const zones = new Set<string>();
  const only = { a: new Map<string, DnsEntry>(), b: new Map<string, DnsEntry>() };
  const queries: DohMock['queries'] = [];
  const zoneOf = (name: string): string | null => {
    const labels = name.split('.');
    for (let i = 0; i < labels.length; i++) {
      const z = labels.slice(i).join('.');
      if (zones.has(z)) return z;
    }
    return null;
  };
  const soa = (z: string) => ({ name: z + '.', type: 6, TTL: 300, data: `ns1.${z}. hostmaster.${z}. 1 7200 3600 1209600 300` });

  function answer(resolver: 'a' | 'b', name: string, type: string): Record<string, unknown> {
    const get = (n: string): DnsEntry | undefined => only[resolver].get(n) ?? records.get(n);
    const entry = get(name);
    const t = TYPES[type] ?? 0;
    if (entry?.rcode !== undefined) return { Status: entry.rcode };
    const Answer: Array<Record<string, unknown>> = [];
    let cur = name;
    let e = entry;
    // CNAME-Kette folgen (außer bei einer Frage nach CNAME selbst)
    for (let hops = 0; e?.CNAME && type !== 'CNAME' && hops < 8; hops++) {
      Answer.push({ name: cur + '.', type: 5, TTL: 300, data: e.CNAME + '.' });
      cur = e.CNAME;
      e = get(cur);
      if (e?.rcode !== undefined) return { Status: e.rcode, Answer };
    }
    if (type === 'SOA' && zones.has(cur)) Answer.push(soa(cur));
    else if (type === 'TXT') for (const v of e?.TXT ?? []) Answer.push({ name: cur + '.', type: t, TTL: 300, data: quoteTxt(v) });
    else if (type === 'A' || type === 'AAAA') for (const ip of e?.[type] ?? []) Answer.push({ name: cur + '.', type: t, TTL: 300, data: ip });
    else if (type === 'CNAME' && e?.CNAME) Answer.push({ name: cur + '.', type: 5, TTL: 300, data: e.CNAME + '.' });
    const exists = e !== undefined || zones.has(cur) || [...records.keys(), ...zones].some((k) => k.endsWith('.' + cur));
    const out: Record<string, unknown> = { Status: Answer.length || exists ? 0 : 3, Answer };
    const z = zoneOf(cur);
    // Keine Antwort des gefragten Typs: SOA der Zone in der Authority (wie echte Resolver)
    if (!Answer.some((a) => a.type === t) && z) out.Authority = [soa(z)];
    return out;
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const resolver = url.pathname.startsWith('/b') ? 'b' : 'a';
    const name = (url.searchParams.get('name') ?? '').toLowerCase().replace(/\.$/, '');
    const type = url.searchParams.get('type') ?? 'A';
    queries.push({ resolver, name, type });
    const body = JSON.stringify(answer(resolver, name, type));
    res.writeHead(200, { 'Content-Type': 'application/dns-json' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    urls: [`http://127.0.0.1:${port}/a/dns-query`, `http://127.0.0.1:${port}/b/resolve`], records, zones, only, queries,
    count: (name, type) => queries.filter((q) => q.name === name && (type === undefined || q.type === type)).length,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
