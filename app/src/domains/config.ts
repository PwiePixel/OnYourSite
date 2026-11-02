// Eigene Domains (Premium): Werte aus config.json. Liest nur die Einstellungen – nie die Datenbank, damit der Router
// ohne eingerichtete Funktion keine einzige Abfrage mehr macht. Das Cloudflare-Token steht NICHT hier: es erreicht nur
// den Domain-Dienst (systemd-Credential), nie die Website.
import { configString } from '../config.js';
import { strtolower } from '../php.js';

// Eingerichtet? Erst wenn der Installer Zone, CNAME-Ziel und Rückfall-Ursprung geschrieben hat (nach geprüftem Token)
export function domainsAvailable(): boolean {
  return configString('cloudflare.zone_id') !== '' && cnameTarget() !== '' && fallbackOrigin() !== '';
}

// Darauf zeigt der CNAME der Kunden (z. B. edge.on-your.site)
export const cnameTarget = (): string => strtolower(configString('custom_domains.cname_target'));
// Rückfall-Ursprung der eigenen Hostnamen bei Cloudflare (z. B. origin.on-your.site)
export const fallbackOrigin = (): string => strtolower(configString('custom_domains.fallback_origin'));

// Namen direkt unter der Domain der Seite, die der Installer für eigene Domains belegt hat (edge, origin oder eigene
// Namen): sie dürfen keine Adresse einer Seite werden. base = Host der Seite ohne Port.
export function reservedSlugs(base: string): string[] {
  const out: string[] = [];
  for (const name of [cnameTarget(), fallbackOrigin()]) {
    if (name === '' || !name.endsWith('.' + base)) continue;
    const label = name.slice(0, name.length - base.length - 1);
    if (label !== '' && !label.includes('.') && !out.includes(label)) out.push(label);
  }
  return out;
}
