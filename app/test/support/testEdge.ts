// Eine „Cloudflare-Kante“ für Tests: HTTPS mit Zertifikaten einer Test-CA je Name (SNI), leitet jede Anfrage mit
// unverändertem Host an die App weiter (Fastify inject) – so läuft die echte Prüfung des Domain-Dienstes bis zur
// Antwort von /_/domain-check. Je Name umschaltbar: richtiges, fremdes oder abgelaufenes Zertifikat, keins (Abbruch
// im Handshake), feste Antwort (z. B. 530 oder 404), Herausforderung (cf-mitigated) oder keine Antwort.
import https from 'node:https';
import tls from 'node:tls';
import type { TestPki, Leaf } from '../helpers/certs.js';

export type EdgeMode =
  | { kind: 'forward' }
  | { kind: 'status'; status: number; body?: string }
  | { kind: 'challenge' }
  | { kind: 'hang' };

export type CertMode = 'valid' | 'other' | 'expired' | 'none';

export interface TestEdge {
  port: number;
  modes: Map<string, EdgeMode>; // je Host (ohne Eintrag: weiterleiten)
  certs: Map<string, CertMode>; // je Host (ohne Eintrag: gültig)
  all: EdgeMode | null; // für alle Hosts (z. B. Ausfall)
  requests: Array<{ host: string; path: string }>;
  close(): Promise<void>;
}

export interface Forwarded {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export async function startTestEdge(pki: TestPki, forward: (host: string, path: string, method: string) => Promise<Forwarded>): Promise<TestEdge> {
  const leaves = new Map<string, Leaf>();
  const leaf = (key: string, names: string[], opts?: { start: string; end: string }): Leaf => {
    let l = leaves.get(key);
    if (!l) {
      l = pki.leaf(names, opts);
      leaves.set(key, l);
    }
    return l;
  };
  const edge: TestEdge = { port: 0, modes: new Map(), certs: new Map(), all: null, requests: [], close: async () => undefined };
  const server = https.createServer({
    SNICallback: (servername, cb) => {
      const mode = edge.certs.get(servername) ?? 'valid';
      // Kein Zertifikat für den Namen: ohne Kontext bricht OpenSSL den Handshake mit einer Warnung ab (wie die Kante)
      if (mode === 'none') return cb(null, undefined);
      const l = mode === 'other' ? leaf('other', ['other.invalid'])
        : mode === 'expired' ? leaf('expired:' + servername, [servername], { start: '20200101000000Z', end: '20200201000000Z' })
          : leaf('valid:' + servername, [servername]);
      cb(null, tls.createSecureContext({ key: l.key, cert: l.cert }));
    },
  }, (req, res) => {
    const host = String(req.headers.host ?? '').split(':')[0];
    edge.requests.push({ host, path: req.url ?? '/' });
    const mode = edge.all ?? edge.modes.get(host) ?? { kind: 'forward' };
    if (mode.kind === 'hang') return;
    if (mode.kind === 'challenge') {
      res.writeHead(403, { 'cf-mitigated': 'challenge', 'Content-Type': 'text/html' });
      res.end('<html>Just a moment…</html>');
      return;
    }
    if (mode.kind === 'status') {
      res.writeHead(mode.status, { 'Content-Type': 'text/plain' });
      res.end(mode.body ?? 'error');
      return;
    }
    forward(host, req.url ?? '/', req.method ?? 'GET').then((r) => {
      res.writeHead(r.status, r.headers);
      res.end(r.body);
    }, () => {
      res.writeHead(502);
      res.end('bad gateway');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  edge.port = (server.address() as { port: number }).port;
  edge.close = () => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  return edge;
}
