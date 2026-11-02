// Ziele für Tests der Prüfungen: ein HTTP- und ein HTTPS-Server auf 127.0.0.1 (zufällige Ports), die nach Pfad
// antworten – 200, 500, 503 mit Retry-After, 429, 403, langsam, hängend, Stichwort, kein Text, Gzip-Bombe,
// Weiterleitungen (Kette, Schleife, auf private Adressen) und robots.txt je Host. Das HTTPS-Zertifikat wählt der
// Server nach dem Namen (SNI). Jede Anfrage wird mit ihren Kopfzeilen gemerkt.
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import { createSecureContext } from 'node:tls';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import type { Leaf } from './certs.js';

export interface SeenRequest {
  host: string;
  path: string;
  method: string;
  headers: IncomingMessage['headers'];
  tls: boolean;
}

export interface Targets {
  httpPort: number;
  httpsPort: number;
  seen: SeenRequest[];
  robots: Map<string, { status: number; body: string }>; // Host → robots.txt (Status 0: keine Antwort)
  status: Map<string, number>; // Pfad → fester Status (für „schalte um“)
  close(): Promise<void>;
}

const BOMB = zlib.gzipSync(Buffer.alloc(30 * 1024 * 1024, 0x61)); // 30 MB „a“, gepackt etwa 30 KB

function handler(t: Omit<Targets, 'close' | 'httpPort' | 'httpsPort'>, tls: boolean) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
    const url = new URL(req.url ?? '/', 'http://x');
    t.seen.push({ host, path: url.pathname + url.search, method: req.method ?? '', headers: req.headers, tls });
    const p = url.pathname;
    const fixed = t.status.get(p);
    if (fixed !== undefined) {
      res.writeHead(fixed, { 'Content-Type': 'text/plain' });
      res.end('fixed');
      return;
    }
    if (p === '/robots.txt') {
      const r = t.robots.get(host);
      if (!r) {
        res.writeHead(404);
        res.end();
        return;
      }
      // Status 0: der Host antwortet nie (hängende robots.txt)
      if (r.status === 0) return;
      res.writeHead(r.status, { 'Content-Type': 'text/plain' });
      res.end(r.body);
      return;
    }
    switch (p) {
      case '/ok':
      case '/switch':
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('hello world');
        return;
      case '/health':
      case '/_/health':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true,"db":true}');
        return;
      case '/canary/1':
      case '/canary/2':
      case '/canary/3':
        res.writeHead(204);
        res.end();
        return;
      case '/500':
        res.writeHead(500);
        res.end('broken');
        return;
      case '/503':
        res.writeHead(503, { 'Retry-After': '600' });
        res.end('maintenance');
        return;
      case '/429':
        res.writeHead(429, { 'Retry-After': '120' });
        res.end('slow down');
        return;
      case '/403':
        res.writeHead(403);
        res.end('no');
        return;
      case '/slow':
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('late');
        }, 300);
        return;
      case '/hang':
        return; // antwortet nie
      case '/keyword':
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><p>All systems: GREEN</p></body></html>');
        return;
      case '/keyword-gzip':
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
        res.end(zlib.gzipSync('<p>packed GREEN text</p>'));
        return;
      case '/binary':
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        return;
      case '/bomb':
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip' });
        res.end(BOMB);
        return;
      case '/redirect/loop':
        res.writeHead(302, { Location: '/redirect/loop' });
        res.end();
        return;
      case '/redirect/private':
        res.writeHead(302, { Location: 'http://10.0.0.1/' });
        res.end();
        return;
      case '/redirect/local':
        res.writeHead(301, { Location: 'http://localhost/' });
        res.end();
        return;
      case '/redirect/see-other':
        res.writeHead(303, { Location: '/ok' });
        res.end();
        return;
      default: {
        const m = /^\/redirect\/(\d+)$/.exec(p);
        if (m) {
          const n = Number(m[1]);
          res.writeHead(302, { Location: n <= 1 ? '/ok' : `/redirect/${n - 1}` });
          res.end();
          return;
        }
        res.writeHead(404);
        res.end('not found');
      }
    }
  };
}

export async function startTargets(certs: { byName: Map<string, Leaf>; fallback: Leaf }): Promise<Targets> {
  const state = { seen: [] as SeenRequest[], robots: new Map<string, { status: number; body: string }>(), status: new Map<string, number>() };
  const plain = http.createServer(handler(state, false));
  const contexts = new Map([...certs.byName].map(([name, leaf]) => [name, createSecureContext({ key: leaf.key, cert: leaf.cert })]));
  const secure = https.createServer({
    key: certs.fallback.key,
    cert: certs.fallback.cert,
    SNICallback: (name, cb) => cb(null, contexts.get(name) ?? contexts.get('*.' + name.split('.').slice(1).join('.')) ?? undefined),
  }, handler(state, true));
  await new Promise<void>((r) => plain.listen(0, '127.0.0.1', () => r()));
  await new Promise<void>((r) => secure.listen(0, '127.0.0.1', () => r()));
  const sockets = new Set<import('node:net').Socket>();
  for (const s of [plain, secure]) s.on('connection', (c) => {
    sockets.add(c);
    c.on('close', () => sockets.delete(c));
  });
  return {
    ...state,
    httpPort: (plain.address() as AddressInfo).port,
    httpsPort: (secure.address() as AddressInfo).port,
    async close() {
      for (const c of sockets) c.destroy();
      await new Promise<void>((r) => plain.close(() => r()));
      await new Promise<void>((r) => secure.close(() => r()));
    },
  };
}
