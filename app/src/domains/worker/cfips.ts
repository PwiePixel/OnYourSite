// IP-Bereiche von Cloudflare (für „zeigt nur auf Cloudflare-Adressen“ und die Kanten-Adresse der Prüfung). Täglich
// frisch von GET /ips; bis dahin – oder wenn das scheitert – die eingebaute Liste.
import { BlockList, isIP } from 'node:net';

// Stand 2026 (https://www.cloudflare.com/ips/)
export const CF_IPS_BUILTIN = {
  v4: ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20',
    '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'],
  v6: ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'],
};

export class CfRanges {
  private list = new BlockList();
  constructor(ranges: { v4: readonly string[]; v6: readonly string[] } = CF_IPS_BUILTIN) {
    this.set(ranges);
  }

  // Neue Bereiche übernehmen (ungültige Einträge werden übergangen; eine leere Liste ändert nichts)
  set(ranges: { v4: readonly string[]; v6: readonly string[] }): void {
    const next = new BlockList();
    let n = 0;
    for (const [family, cidrs] of [['ipv4', ranges.v4], ['ipv6', ranges.v6]] as const) {
      for (const cidr of cidrs) {
        const m = /^([0-9a-f.:]+)\/(\d{1,3})$/i.exec(cidr);
        if (!m || isIP(m[1]) !== (family === 'ipv4' ? 4 : 6)) continue;
        next.addSubnet(m[1], Number(m[2]), family);
        n++;
      }
    }
    if (n > 0) this.list = next;
  }

  has(ip: string): boolean {
    const v = isIP(ip);
    return v !== 0 && this.list.check(ip, v === 4 ? 'ipv4' : 'ipv6');
  }
}
