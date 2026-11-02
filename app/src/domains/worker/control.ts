// Selbsttest des eigenen Wegs und Schutzschalter (einmal je Minute, vor jeder Herabstufung). Unsere eigenen Ausfälle
// zählen nie gegen die Domains der Nutzer: Lösen beide Resolver unser CNAME-Ziel nicht auf, oder antwortet unsere
// eigene Domain nicht korrekt über dieselbe Kante, ist der Schalter offen – ebenso, wenn mehr als 20 % der Live-
// Domains (und mindestens 3) gerade eindeutig scheitern. Solange er offen ist: keine Herabstufung, kein Löschen wegen
// DNS oder Prüfung; Aufstufungen laufen weiter. Er schließt sich von selbst.
import type { Freeze } from '../settings.js';
import type { Doh } from './dns.js';
import { resolveOwn } from './dns.js';
import type { CfRanges } from './cfips.js';
import { probeHost, type ProbeOutcome } from './probe.js';

export interface ControlResult {
  ok: boolean;
  error: string;
  edgeIps: string[]; // Adressen der Kante für die Prüfungen dieser Minute (v4 zuerst)
  edgeAddrs: string[]; // alle aktuellen Adressen des CNAME-Ziels (für Wurzeldomains)
  probe: ProbeOutcome | null;
}

export interface ControlDeps {
  doh: Doh;
  ranges: CfRanges;
  target: string; // edge.on-your.site
  base: string; // on-your.site
  expected: string; // probeAnswer(base)
  port: number;
  ca?: Buffer;
  fixedEdgeIps: string[]; // nur Tests
}

// Eine v4- und eine v6-Adresse (wenn vorhanden)
export function pickEdge(addrs: string[]): string[] {
  const v4 = addrs.find((a) => !a.includes(':'));
  const v6 = addrs.find((a) => a.includes(':'));
  return [v4, v6].filter((x): x is string => x !== undefined);
}

export async function runControl(d: ControlDeps): Promise<ControlResult> {
  const own = await resolveOwn(d.doh, d.target);
  if (!own.bothResolved) {
    return { ok: false, error: `Our DNS resolvers couldn’t resolve ${d.target}.`, edgeIps: [], edgeAddrs: own.addrs, probe: null };
  }
  const edge = d.fixedEdgeIps.length ? d.fixedEdgeIps : own.addrs.filter((ip) => d.ranges.has(ip));
  if (!edge.length) return { ok: false, error: `${d.target} doesn’t point to Cloudflare.`, edgeIps: [], edgeAddrs: own.addrs, probe: null };
  const edgeIps = pickEdge(edge);
  const probe = await probeHost({ hostname: d.base, ips: edgeIps, port: d.port, expected: d.expected, ca: d.ca });
  if (probe.result !== 'ok') {
    return { ok: false, error: `Our own site didn’t answer through Cloudflare (${probe.reason || probe.result}).`, edgeIps, edgeAddrs: own.addrs, probe };
  }
  return { ok: true, error: '', edgeIps, edgeAddrs: own.addrs, probe };
}

export interface BreakerInput {
  controlOk: boolean;
  controlError: string;
  live: number; // Domains im Zustand active
  failing: number; // davon mit eindeutigem Fehler bei der letzten Prüfung (in den letzten 10 Minuten)
  freeze: Freeze | null;
  now: string;
}

// Rein: neuer Zustand des Schalters; opened/closed nur beim Wechsel (für die Meldung an die Admins)
export function breaker(i: BreakerInput): { freeze: Freeze | null; opened: boolean; closed: boolean } {
  const mass = i.failing >= 3 && i.failing > 0.2 * i.live;
  if (!i.controlOk || mass) {
    const freeze: Freeze = i.freeze ?? {
      since: i.now,
      reason: i.controlOk ? 'mass' : 'control',
      detail: i.controlOk ? `${i.failing} of ${i.live} live domains failed at the same time.` : i.controlError,
    };
    return { freeze, opened: i.freeze === null, closed: false };
  }
  return { freeze: null, opened: false, closed: i.freeze !== null };
}
