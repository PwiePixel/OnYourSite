// DNS über DoH (JSON) bei zwei festen öffentlichen Resolvern, parallel, je 4 s. Nie an eine Adresse aus einer Eingabe:
// gefragt wird nur nach Namen; die Resolver stehen in der Konfiguration. Ein Eintrag zählt als vorhanden, wenn einer der
// beiden ihn zeigt; „falsch“ ist das DNS nur, wenn beide geantwortet haben (Status 0 oder 3) und keiner passt.
// SERVFAIL oder keine Antwort zählt als unbekannt.
import { config, configString } from '../../config.js';
import { strtolower } from '../../php.js';

export const DOH_DEFAULT = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'];
const TIMEOUT_MS = 4000;

export type RecordType = 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'SOA';
const TYPE_NUM: Record<RecordType, number> = { A: 1, CNAME: 5, SOA: 6, TXT: 16, AAAA: 28 };

export interface DnsRecord {
  name: string; // klein, ohne Punkt am Ende
  type: number;
  data: string;
}

export interface DohReply {
  rcode: number | null; // 0 NOERROR, 2 SERVFAIL, 3 NXDOMAIN; null = keine (brauchbare) Antwort
  answer: DnsRecord[];
  authority: DnsRecord[];
}

// Antwort beantwortet (gilt für „falsch“): NOERROR oder NXDOMAIN
export const answered = (r: DohReply): boolean => r.rcode === 0 || r.rcode === 3;

const cleanName = (n: unknown): string => strtolower(String(n ?? '')).replace(/\.$/, '');

function records(list: unknown): DnsRecord[] {
  if (!Array.isArray(list)) return [];
  const out: DnsRecord[] = [];
  for (const r of list) {
    if (r === null || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.type !== 'number' || typeof o.data !== 'string') continue;
    out.push({ name: cleanName(o.name), type: o.type, data: o.data });
  }
  return out;
}

export class Doh {
  constructor(readonly endpoints: string[], private readonly fetchImpl?: typeof fetch, private readonly timeoutMs = TIMEOUT_MS) {}

  // Eine Frage an alle Resolver gleichzeitig; je Resolver eine Antwort (auch „keine“)
  async query(name: string, type: RecordType): Promise<DohReply[]> {
    return Promise.all(this.endpoints.map((ep) => this.ask(ep, name, type)));
  }

  private async ask(endpoint: string, name: string, type: RecordType): Promise<DohReply> {
    const none: DohReply = { rcode: null, answer: [], authority: [] };
    try {
      const res = await (this.fetchImpl ?? fetch)(endpoint + '?name=' + encodeURIComponent(name) + '&type=' + type, {
        headers: { Accept: 'application/dns-json' }, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => undefined);
        return none;
      }
      const text = await res.text();
      if (text.length > 256_000) return none;
      const body = JSON.parse(text) as Record<string, unknown>;
      const rcode = typeof body.Status === 'number' ? body.Status : null;
      return { rcode, answer: records(body.Answer), authority: records(body.Authority) };
    } catch {
      return none;
    }
  }
}

export function dohFromConfig(fetchImpl?: typeof fetch): Doh {
  const list = config<unknown>('custom_domains.doh', null);
  const endpoints = Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string' && /^https?:\/\//.test(x)) : [];
  return new Doh(endpoints.length ? endpoints : DOH_DEFAULT, fetchImpl);
}

// ---------------------------------------------------------------- TXT

// Daten eines TXT-Eintrags: in Anführungszeichen, auch in mehreren Teilen ("a" "b" → ab), mit \" und \ddd
export function txtData(data: string): string {
  const s = data.trim();
  if (!s.startsWith('"')) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    while (i < s.length && s[i] === ' ') i++;
    if (s[i] !== '"') break;
    i++;
    while (i < s.length && s[i] !== '"') {
      if (s[i] === '\\' && i + 1 < s.length) {
        const dec = /^\d{3}/.exec(s.slice(i + 1, i + 4));
        if (dec) {
          out += String.fromCharCode(Number(dec[0]));
          i += 4;
          continue;
        }
        out += s[i + 1];
        i += 2;
        continue;
      }
      out += s[i++];
    }
    i++;
  }
  return out;
}

export interface TxtView {
  values: string[]; // alle Werte (beide Resolver zusammen)
  mine: boolean; // der Wert dieses Kontos ist da
  others: string[]; // OnYourSite-Werte anderer Konten
  answered: number; // Resolver mit Antwort (0 oder 3)
  unknown: boolean; // kein Resolver hat geantwortet
}

export function txtView(replies: DohReply[], name: string, token: string): TxtView {
  const values: string[] = [];
  for (const r of replies) {
    if (r.rcode !== 0) continue;
    for (const rec of r.answer) {
      if (rec.type !== TYPE_NUM.TXT || rec.name !== name) continue;
      const v = txtData(rec.data);
      if (!values.includes(v)) values.push(v);
    }
  }
  const n = replies.filter(answered).length;
  return {
    values, mine: values.includes(token), others: values.filter((v) => v.startsWith('onyoursite-verify=') && v !== token),
    answered: n, unknown: n === 0,
  };
}

// ---------------------------------------------------------------- Wohin zeigt der Name?

export interface AddressView {
  rcode: number | null;
  cnames: string[]; // Kette der CNAME-Ziele, in Reihenfolge
  addrs: string[]; // A und AAAA am Ende der Kette
}

export function addressView(a: DohReply, aaaa: DohReply): AddressView {
  const cnames: string[] = [];
  const addrs: string[] = [];
  for (const rep of [a, aaaa]) {
    if (rep.rcode !== 0) continue;
    for (const rec of rep.answer) {
      if (rec.type === TYPE_NUM.CNAME) {
        const t = cleanName(rec.data);
        if (!cnames.includes(t)) cnames.push(t);
      } else if ((rec.type === TYPE_NUM.A || rec.type === TYPE_NUM.AAAA) && !addrs.includes(rec.data)) {
        addrs.push(rec.data);
      }
    }
  }
  // Der A-Antwort folgt das Urteil (AAAA allein ist zu wenig – viele Namen haben nur IPv4)
  return { rcode: a.rcode, cnames, addrs };
}

export interface DnsVerdict {
  verdict: 'ok' | 'cf_ips' | 'wrong' | 'unknown';
  problem: '' | 'cname_missing' | 'cname_wrong' | 'cname_proxied' | 'a_records' | 'apex_ips' | 'dns_error';
  found: string; // was stattdessen da ist (Ziel des CNAME oder eine Adresse)
}

export interface JudgeOptions {
  target: string; // unser CNAME-Ziel (edge.on-your.site)
  base: string; // Domain der Seite
  apex: boolean;
  cfActive: boolean; // Cloudflare meldet den Hostnamen als aktiv
  isCloudflare: (ip: string) => boolean;
  edgeAddrs: ReadonlySet<string>; // aktuelle Adressen unseres CNAME-Ziels
}

// Urteil über die Antwort EINES Resolvers (Tabelle „points to us“ im Entwurf, §4.7)
export function judgeResolver(v: AddressView, o: JudgeOptions): DnsVerdict {
  if (v.rcode !== 0 && v.rcode !== 3) return { verdict: 'unknown', problem: 'dns_error', found: '' };
  if (v.cnames.length) {
    const ours = v.cnames.some((c) => c === o.target || c === o.base || c.endsWith('.' + o.base));
    return ours ? { verdict: 'ok', problem: '', found: '' } : { verdict: 'wrong', problem: 'cname_wrong', found: v.cnames[0] };
  }
  if (!v.addrs.length) return { verdict: 'wrong', problem: 'cname_missing', found: '' };
  if (v.addrs.every((ip) => o.isCloudflare(ip))) {
    if (!o.apex) return { verdict: 'wrong', problem: 'cname_proxied', found: v.addrs[0] };
    return o.cfActive && v.addrs.some((ip) => o.edgeAddrs.has(ip))
      ? { verdict: 'cf_ips', problem: '', found: '' }
      : { verdict: 'wrong', problem: 'apex_ips', found: v.addrs[0] };
  }
  return { verdict: 'wrong', problem: 'a_records', found: v.addrs.find((ip) => !o.isCloudflare(ip)) ?? v.addrs[0] };
}

// Urteil über beide Resolver: einer passt → passt; beide haben geantwortet und keiner passt → falsch; sonst unbekannt
export function judgeDns(per: DnsVerdict[]): DnsVerdict {
  const good = per.find((p) => p.verdict === 'ok') ?? per.find((p) => p.verdict === 'cf_ips');
  if (good) return good;
  if (per.length > 0 && per.every((p) => p.verdict === 'wrong')) return per[0];
  return { verdict: 'unknown', problem: 'dns_error', found: '' };
}

// Ein Name über beide Resolver (A und AAAA, mit Kette)
export async function lookupAddress(doh: Doh, host: string): Promise<AddressView[]> {
  const [a, aaaa] = await Promise.all([doh.query(host, 'A'), doh.query(host, 'AAAA')]);
  return a.map((rep, i) => addressView(rep, aaaa[i] ?? { rcode: null, answer: [], authority: [] }));
}

// Adressen eines eigenen Namens (CNAME-Ziel der Kunden): alle A/AAAA beider Resolver; ok = beide haben welche
export async function resolveOwn(doh: Doh, name: string): Promise<{ addrs: string[]; bothResolved: boolean }> {
  const views = await lookupAddress(doh, name);
  const addrs: string[] = [];
  for (const v of views) for (const ip of v.addrs) if (!addrs.includes(ip)) addrs.push(ip);
  return { addrs, bothResolved: views.length > 0 && views.every((v) => v.rcode === 0 && v.addrs.length > 0) };
}

// ---------------------------------------------------------------- Zone und Wurzeldomain

const validZone = (zone: string, host: string, base: string): boolean =>
  zone.includes('.') && (host === zone || host.endsWith('.' + zone)) && zone !== base && !zone.endsWith('.' + base);

// Zone des Nutzers aus der Authority-SOA der Antwort für _onyoursite.<host> (nie aus der Antwort für den Namen selbst –
// zeigt er schon auf uns, folgt sie in unsere Zone). Steht dort ein CNAME oder passt die SOA nicht: die Eltern des
// Namens mit SOA-Fragen durchgehen, bis eine Antwort-SOA genau diesem Namen gehört. Die Zone der Seite gilt nie.
export async function detectZone(doh: Doh, host: string, base: string): Promise<{ zone: string; apex: boolean } | null> {
  const first = await doh.query('_onyoursite.' + host, 'SOA');
  let walk = false;
  for (const r of first) {
    if (!answered(r)) continue;
    if (r.answer.some((rec) => rec.type === TYPE_NUM.CNAME)) {
      walk = true;
      continue;
    }
    const soa = [...r.answer, ...r.authority].find((rec) => rec.type === TYPE_NUM.SOA);
    if (soa && validZone(soa.name, host, base)) return { zone: soa.name, apex: soa.name === host };
    walk = true;
  }
  if (!walk) return null;
  const labels = host.split('.');
  for (let i = 0; i <= labels.length - 2; i++) {
    const name = labels.slice(i).join('.');
    const replies = await doh.query(name, 'SOA');
    const owner = replies.some((r) => r.rcode === 0 && r.answer.some((rec) => rec.type === TYPE_NUM.SOA && rec.name === name));
    if (owner && validZone(name, host, base)) return { zone: name, apex: name === host };
    if (replies.every((r) => r.rcode === null || r.rcode === 2)) return null;
  }
  return null;
}

// Für Tests und Diagnose: das CNAME-Ziel aus der Konfiguration
export const cnameTargetName = (): string => strtolower(configString('custom_domains.cname_target'));
