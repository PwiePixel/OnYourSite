// Statusseiten: Schutz gegen SSRF (rein, ohne Netz und ohne Datenbank). Gilt beim Speichern einer Prüfung und vor
// jeder Prüfung (auch für jede Weiterleitung):
// - parseTarget(): nur http/https, keine Zugangsdaten in der Adresse, erlaubte Ports, keine lokalen Namen; die Adresse
//   wird so normalisiert, wie Node sie später auch öffnet (WHATWG-URL: 0x7f.1, 2130706433, ①②⑦.0.0.1 → 127.0.0.1)
// - classifyIp()/ipVerdict(): nur öffentliche Adressen; eigene Adressen des Servers mit Tunnel nie, ohne Tunnel nur
//   auf 80/443 (dann wird die Seite ohnehin von dort ausgeliefert)
// - hostRule(): Regeln des Teams je Host oder Domain (sperren / mehr erlauben)
// Die Richtlinie (GuardPolicy) kommt immer vom Aufrufer: der Prüfdienst baut sie aus den Einstellungen (policy.ts),
// die Tests bauen sich eine eigene – es gibt keinen Schalter in Umgebung oder Einstellungen.
import { BlockList, isIP } from 'node:net';
import { domainToASCII } from 'node:url';

export interface GuardPolicy {
  ports: readonly number[]; // erlaubte Ports (Admin-Einstellung)
  tunnel: boolean; // Cloudflare-Tunnel: eigene Adressen führen am Tunnel vorbei → immer gesperrt
  self: BlockList; // alle eigenen Adressen des Servers
  // Nur Tests: weitere erlaubte Ziele (z. B. 127.0.0.1 auf einem Test-Port). Der Prüfdienst setzt es nie.
  testAllow?: (ip: string, port: number) => boolean;
}

export const MAX_URL = 500;
// Längste Eingabe vor dem Abschneiden von Leerraum (Leerzeichen außen zählen nicht zu den 500 Zeichen)
const MAX_INPUT = 2048;

export const PRIVATE_TEXT = 'This address points to a private or local network – only public websites can be checked.';

// ---------------------------------------------------------------- IP-Adressen

// Gesperrte Bereiche (Entwurf §6.1). IPv6: alles außerhalb von 2000::/3 (das deckt ::, ::1, ::ffff:0:0/96, NAT64,
// 100::/64, fc00::/7, fe80::/10, fec0::/10 und ff00::/8 ab) und darin die Sonderbereiche. Zwei getrennte Listen: Node
// prüft eine IPv4-Adresse auch gegen IPv6-Bereiche, die ::ffff:0:0/96 enthalten – ::/3 sperrte sonst jede IPv4-Adresse.
const BLOCKED_V4 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['168.63.129.16', 32], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as Array<[string, number]>) {
  BLOCKED_V4.addSubnet(net, prefix, 'ipv4');
}
const BLOCKED_V6 = new BlockList();
for (const [net, prefix] of [
  ['::', 3], ['4000::', 2], ['8000::', 1], // außerhalb von 2000::/3
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20], // Teredo/IETF, Dokumentation, 6to4
] as Array<[string, number]>) {
  BLOCKED_V6.addSubnet(net, prefix, 'ipv6');
}

export type IpClass = 'public' | 'blocked' | 'invalid';

// Öffentlich oder gesperrt (ohne Port und ohne eigene Adressen)
export function classifyIp(ip: string): IpClass {
  const family = isIP(ip);
  if (family === 4) return BLOCKED_V4.check(ip, 'ipv4') ? 'blocked' : 'public';
  if (family === 6) return BLOCKED_V6.check(ip, 'ipv6') ? 'blocked' : 'public';
  return 'invalid';
}

// Liste eigener Adressen (Text wie aus der Konfiguration oder os.networkInterfaces(); Ungültiges wird übergangen)
export function addressList(ips: Iterable<string>): BlockList {
  const list = new BlockList();
  for (const raw of ips) {
    const ip = raw.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
    const family = isIP(ip);
    if (family) list.addAddress(ip, family === 4 ? 'ipv4' : 'ipv6');
  }
  return list;
}

export type IpVerdict = { ok: true } | { ok: false; reason: 'invalid' | 'private' | 'self' };

// Darf eine Prüfung genau diese Adresse auf diesem Port erreichen?
export function ipVerdict(ip: string, port: number, policy: GuardPolicy): IpVerdict {
  if (policy.testAllow?.(ip, port)) return { ok: true };
  const family = isIP(ip);
  if (!family) return { ok: false, reason: 'invalid' };
  if (classifyIp(ip) !== 'public') return { ok: false, reason: 'private' };
  if (policy.self.check(ip, family === 4 ? 'ipv4' : 'ipv6')) {
    if (policy.tunnel || (port !== 80 && port !== 443)) return { ok: false, reason: 'self' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------- Adressen der Prüfungen

// Namen, die nie ins öffentliche Internet führen (dazu jeder Name ohne Punkt)
export const SPECIAL_NAMES = ['localhost', 'localdomain', 'local', 'internal', 'intranet', 'lan', 'home', 'corp', 'home.arpa', 'arpa',
  'test', 'invalid', 'example', 'onion', 'alt'];

export function specialName(host: string): boolean {
  if (!host.includes('.')) return true;
  return SPECIAL_NAMES.some((n) => host === n || host.endsWith('.' + n));
}

// Hostname in ASCII (Labels bis 63 Zeichen, insgesamt bis 253)
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/;

export interface Target {
  ok: true;
  url: string; // normalisiert, ohne #Fragment – so wird es gespeichert
  scheme: 'http' | 'https';
  host: string; // ASCII, klein, ohne Punkt am Ende, IPv6 ohne Klammern
  port: number;
  path: string; // Pfad + Query (für robots.txt und die Anfrage)
  ip: 0 | 4 | 6; // IP-Adresse statt Name?
}
export interface TargetProblem {
  ok: false;
  field: 'url';
  code: 'empty' | 'long' | 'invalid' | 'scheme' | 'userinfo' | 'port' | 'private';
  error: string;
}

const problem = (code: TargetProblem['code'], error: string): TargetProblem => ({ ok: false, field: 'url', code, error });

// Hat die Eingabe ein Schema? „example.com:8080/x“ ist ein Host mit Port, kein Schema „example.com“.
const hasScheme = (s: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^:/?#]+:\d+(?:[/?#]|$)/.test(s);

export function parseTarget(input: unknown, policy: GuardPolicy): Target | TargetProblem {
  // Riesige Eingaben gar nicht erst bearbeiten: das Abschneiden von Leerraum am Ende ist quadratisch in der Länge
  if (typeof input === 'string' && input.length > MAX_INPUT) return problem('long', 'This address is too long – 500 characters at most.');
  let s = typeof input === 'string' ? input.replace(/^[\s ﻿]+|[\s ﻿]+$/g, '') : '';
  if (s === '') return problem('empty', 'Please enter the address to check.');
  if (s.length > MAX_URL) return problem('long', 'This address is too long – 500 characters at most.');
  if (!hasScheme(s)) s = 'https://' + s.replace(/^\/+/, '');
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return problem('invalid', 'This doesn’t look like a web address.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return problem('scheme', 'Please enter an address starting with http:// or https://.');
  }
  if (url.username !== '' || url.password !== '') return problem('userinfo', 'Addresses with a user name or password can’t be checked.');
  const scheme = url.protocol === 'http:' ? 'http' : 'https';
  const port = url.port === '' ? (scheme === 'http' ? 80 : 443) : Number(url.port);
  if (!policy.ports.includes(port)) {
    return problem('port', `Port ${port} can’t be checked. Allowed ports: ${policy.ports.join(', ')}.`);
  }
  let host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  const ip = isIP(host) as 0 | 4 | 6;
  if (!ip) {
    if (!HOSTNAME.test(host)) return problem('invalid', 'This doesn’t look like a web address.');
    if (specialName(host)) return problem('private', PRIVATE_TEXT);
  } else {
    if (!ipVerdict(host, port, policy).ok) return problem('private', PRIVATE_TEXT);
  }
  // Ohne Punkt am Ende speichern; das Fragment geht nie an den Server
  if (url.hostname.endsWith('.')) url.hostname = ip === 6 ? `[${host}]` : host;
  url.hash = '';
  const normalized = url.href;
  if (normalized.length > MAX_URL) return problem('long', 'This address is too long – 500 characters at most.');
  host = ip === 6 ? host.toLowerCase() : host;
  return { ok: true, url: normalized, scheme, host, port, path: url.pathname + url.search, ip };
}

export const portAllowed = (port: number, ports: readonly number[]): boolean => Number.isInteger(port) && ports.includes(port);

// ---------------------------------------------------------------- Regeln des Teams je Host oder Domain

export interface HostRule {
  host: string; // „example.com“ = genau dieser Host, „.example.com“ = die Domain und alle Subdomains
  rule: 'block' | 'allow';
  max_monitors: number | null;
  note: string;
}

// Die genaueste passende Regel: der genaue Host vor einer Domain-Regel, eine längere Domain vor einer kürzeren
export function hostRule(host: string, rules: readonly HostRule[]): HostRule | null {
  let best: HostRule | null = null;
  let bestScore = -1;
  for (const r of rules) {
    let score = -1;
    if (r.host.startsWith('.')) {
      const domain = r.host.slice(1);
      if (domain !== '' && (host === domain || host.endsWith('.' + domain))) score = domain.length;
    } else if (r.host === host) {
      score = Number.MAX_SAFE_INTEGER;
    }
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best;
}

// Eingabe einer Regel normalisieren (Admin): Host oder „.domain“, klein, ASCII, ohne Punkt am Ende; sonst null
export function normalizeRuleHost(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let s = input.trim().toLowerCase();
  const domain = s.startsWith('.');
  if (domain) s = s.slice(1);
  s = s.replace(/\.+$/, '').replace(/^\[|\]$/g, '');
  if (s === '') return null;
  if (isIP(s)) return domain ? null : s;
  const ascii = domainToASCII(s);
  if (ascii === '' || !HOSTNAME.test(ascii) || !ascii.includes('.')) return null;
  return (domain ? '.' : '') + ascii;
}
