// Statusseiten: die Richtlinie für guard.ts im Betrieb – erlaubte Ports aus den Einstellungen, Tunnel und eigene
// Adressen aus config.json (status.self_ips, vom Installer) plus alle globalen Adressen der Netzwerkkarten zur
// Laufzeit. Tests bauen ihre Richtlinie selbst (es gibt hier keinen Schalter für Ausnahmen).
import { networkInterfaces } from 'node:os';
import { addressList, classifyIp, type GuardPolicy } from './guard.js';
import type { StatusServerConfig, StatusSettings } from './settings.js';

type InterfaceList = Record<string, Array<{ address: string; internal: boolean }> | undefined>;

// Globale (öffentliche) Adressen dieses Servers laut Netzwerkkarten. Scheitert die Abfrage (eine Sandbox ohne Netlink:
// getifaddrs → EAFNOSUPPORT), bleibt es bei den Adressen aus config.json (status.self_ips) – der Prüfdienst darf daran
// nicht scheitern.
export function interfaceAddresses(read: () => InterfaceList = networkInterfaces): string[] {
  let lists: InterfaceList;
  try {
    lists = read();
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const list of Object.values(lists)) {
    for (const a of list ?? []) {
      if (!a.internal && classifyIp(a.address.replace(/%.*$/, '')) === 'public') out.push(a.address.replace(/%.*$/, ''));
    }
  }
  return out;
}

export function runtimePolicy(settings: StatusSettings, server: StatusServerConfig, extraSelf: string[] = interfaceAddresses()): GuardPolicy {
  return {
    ports: settings.ports,
    tunnel: server.tunnel,
    self: addressList([...server.self_ips, ...extraSelf]),
  };
}
