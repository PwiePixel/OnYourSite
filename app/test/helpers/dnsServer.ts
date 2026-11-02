// Kleiner DNS-Server für Tests (UDP auf 127.0.0.1, zufälliger Port): beantwortet A, AAAA und CNAME aus einer Zone,
// kann SERVFAIL/NXDOMAIN liefern oder gar nicht antworten (Zeitüberschreitung) und zählt die Anfragen je Name und Typ.
import { createSocket, type Socket } from 'node:dgram';
import { isIPv4 } from 'node:net';

export interface ZoneEntry {
  A?: string[];
  AAAA?: string[];
  CNAME?: string; // Ziel (ohne Punkt am Ende)
  ttl?: number;
  rcode?: number; // 2 = SERVFAIL, 3 = NXDOMAIN, 5 = REFUSED
  drop?: boolean; // keine Antwort
}

export interface FakeDns {
  port: number;
  server: string; // für Resolver.setServers()
  zone: Map<string, ZoneEntry>;
  queries: Map<string, number>; // „name/A“ → Anzahl
  stopped: boolean;
  stop(): Promise<void>;
  start(): Promise<void>; // nach stop() wieder auf demselben Port
}

const TYPE_A = 1;
const TYPE_CNAME = 5;
const TYPE_AAAA = 28;

function encodeName(name: string): Buffer {
  const parts = name.replace(/\.$/, '').split('.').filter((p) => p !== '');
  const out: Buffer[] = [];
  for (const p of parts) {
    const b = Buffer.from(p, 'ascii');
    out.push(Buffer.from([b.length]), b);
  }
  out.push(Buffer.from([0]));
  return Buffer.concat(out);
}

// IPv6-Text → 16 Bytes (mit :: und eingebetteter IPv4-Adresse am Ende)
export function ipv6Bytes(ip: string): Buffer {
  let s = ip;
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m && isIPv4(m[2])) {
    const o = m[2].split('.').map(Number);
    s = m[1] + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const parts = s.split('::');
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length > 1 && parts[1] ? parts[1].split(':') : [];
  const zeros = parts.length > 1 ? 8 - head.length - tail.length : 0;
  const words = [...head, ...new Array<string>(Math.max(0, zeros)).fill('0'), ...tail].map((w) => parseInt(w, 16));
  const buf = Buffer.alloc(16);
  words.slice(0, 8).forEach((w, i) => buf.writeUInt16BE(w & 0xffff, i * 2));
  return buf;
}

function record(name: string, type: number, ttl: number, data: Buffer): Buffer {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(1, 2);
  head.writeUInt32BE(ttl, 4);
  head.writeUInt16BE(data.length, 8);
  return Buffer.concat([encodeName(name), head, data]);
}

// Frage lesen: Name, Typ, Ende der Frage
function readQuestion(msg: Buffer): { name: string; type: number; end: number } | null {
  let off = 12;
  const labels: string[] = [];
  while (off < msg.length) {
    const len = msg[off];
    if (len === 0) {
      off++;
      break;
    }
    labels.push(msg.subarray(off + 1, off + 1 + len).toString('ascii'));
    off += 1 + len;
  }
  if (off + 4 > msg.length) return null;
  return { name: labels.join('.').toLowerCase(), type: msg.readUInt16BE(off), end: off + 4 };
}

export async function startDns(zone: Record<string, ZoneEntry> = {}): Promise<FakeDns> {
  const state: FakeDns = {
    port: 0,
    server: '',
    zone: new Map(Object.entries(zone).map(([k, v]) => [k.toLowerCase(), v])),
    queries: new Map(),
    stopped: false,
    stop: async () => undefined,
    start: async () => undefined,
  };
  let sock: Socket | null = null;

  const answer = (msg: Buffer, rinfo: { address: string; port: number }): void => {
    const q = readQuestion(msg);
    if (!q || !sock) return;
    const key = `${q.name}/${q.type === TYPE_A ? 'A' : q.type === TYPE_AAAA ? 'AAAA' : String(q.type)}`;
    state.queries.set(key, (state.queries.get(key) ?? 0) + 1);
    const entry = state.zone.get(q.name);
    if (entry?.drop) return;
    const answers: Buffer[] = [];
    let rcode = 0;
    if (!entry) {
      rcode = 3;
    } else if (entry.rcode) {
      rcode = entry.rcode;
    } else {
      let current = q.name;
      let e: ZoneEntry | undefined = entry;
      for (let hops = 0; e && hops < 8; hops++) {
        const ttl = e.ttl ?? 300;
        if (e.CNAME) {
          answers.push(record(current, TYPE_CNAME, ttl, encodeName(e.CNAME)));
          current = e.CNAME.toLowerCase();
          e = state.zone.get(current);
          continue;
        }
        if (q.type === TYPE_A) for (const a of e.A ?? []) answers.push(record(current, TYPE_A, ttl, Buffer.from(a.split('.').map(Number))));
        if (q.type === TYPE_AAAA) for (const a of e.AAAA ?? []) answers.push(record(current, TYPE_AAAA, ttl, ipv6Bytes(a)));
        break;
      }
    }
    const head = Buffer.alloc(12);
    msg.copy(head, 0, 0, 2);
    const rd = msg[2] & 0x01;
    head[2] = 0x84 | rd; // QR, AA, RD
    head[3] = 0x80 | rcode; // RA, RCODE
    head.writeUInt16BE(1, 4);
    head.writeUInt16BE(answers.length, 6);
    const reply = Buffer.concat([head, msg.subarray(12, q.end), ...answers]);
    sock.send(reply, rinfo.port, rinfo.address);
  };

  const open = (port: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const s = createSocket('udp4');
      s.on('message', answer);
      s.once('error', reject);
      s.bind(port, '127.0.0.1', () => {
        sock = s;
        state.port = (s.address() as { port: number }).port;
        state.server = `127.0.0.1:${state.port}`;
        state.stopped = false;
        resolve();
      });
    });

  state.stop = () =>
    new Promise((resolve) => {
      state.stopped = true;
      if (!sock) return resolve();
      const s = sock;
      sock = null;
      s.close(() => resolve());
    });
  state.start = () => open(state.port);
  await open(0);
  return state;
}
