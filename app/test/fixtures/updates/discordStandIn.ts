// Lokaler Ersatz für die Discord-API (nur für Tests) – verhält sich wie die Test-Attrappe discord_mock.py: merkt sich
// alle Aufrufe, kennt Webhooks und Bot-Kanäle, besondere IDs (404…, 401…, 429…, 403…) und erzwungene Fehler.
//   /__log      bisherige Aufrufe (Methode, Pfad, Authorization, User-Agent, JSON-Inhalt)
//   /__reset    Liste leeren        /__forget  alle Nachrichten „in Discord löschen“
//   /__fail=N   nächste Anfrage mit Status N beantworten
//   /__restart  alles auf Anfang (auch die Nachrichten-IDs), damit PHP und Node dieselben IDs bekommen
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Erfundener Token im Format von Discord (nur für die Formatprüfung) – zur Laufzeit zusammengesetzt, damit kein
// tokenförmiger Text im Repository steht (Secret-Scanner würden ihn melden)
export const GOOD_TOKEN = [Buffer.from('1300000000000000001').toString('base64').replace(/=+$/, ''), 'GaBcDe', 'abcdefghijklmnopqrstuvwxyz0123456789AB'].join('.');

export interface StandIn { base: string; root: string; close(): Promise<void> }

export async function startDiscordStandIn(port = 0): Promise<StandIn> {
  let log: unknown[] = [];
  let failNext: number[] = [];
  let messages = new Map<string, unknown>();
  let nextId = 1300000000000000001n;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const path = req.url ?? '/';
      const send = (code: number, data?: unknown): void => {
        const body = data === undefined ? '' : JSON.stringify(data);
        const headers: Record<string, string | number> = { 'Content-Length': Buffer.byteLength(body) };
        if (data !== undefined) headers['Content-Type'] = 'application/json';
        res.writeHead(code, headers);
        res.end(body);
      };
      if (path === '/__log') return send(200, log);
      if (path === '/__reset') {
        log = [];
        return send(200, { ok: true });
      }
      if (path === '/__restart') {
        log = [];
        failNext = [];
        messages = new Map();
        nextId = 1300000000000000001n;
        return send(200, { ok: true });
      }
      if (path === '/__forget') {
        messages.clear();
        return send(200, { ok: true });
      }
      if (path.startsWith('/__fail')) {
        failNext.push(Number(path.split('=')[1]));
        return send(200, { ok: true });
      }
      let body: unknown = null;
      if (raw.length) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          body = '<<invalid json>>';
        }
      }
      const auth = String(req.headers.authorization ?? '');
      log.push({ method: req.method, path, auth, ua: String(req.headers['user-agent'] ?? ''), body });
      const p = path.split('?')[0];
      if (failNext.length) {
        const code = failNext.shift() as number;
        if (code === 429) return send(429, { message: 'You are being rate limited.', retry_after: 1.0, global: false });
        return send(code, { message: 'Simulated failure', code: 0 });
      }
      const newId = (): string => String(nextId++);
      const hook = /^\/api(?:\/v\d+)?\/webhooks\/(\d+)\/([\w-]+)(?:\/messages\/(\d+))?$/.exec(p);
      const bot = /^\/api\/v10\/channels\/(\d+)\/messages(?:\/(\d+))?$/.exec(p);
      let mid: string | undefined;
      if (hook) {
        const [, id] = hook;
        mid = hook[3];
        if (id.startsWith('404')) return send(404, { message: 'Unknown Webhook', code: 10015 });
        if (id.startsWith('401')) return send(401, { message: 'Invalid Webhook Token', code: 50027 });
        if (id.startsWith('429')) return send(429, { message: 'You are being rate limited.', retry_after: 1.0 });
        if (mid === undefined && req.method === 'POST') {
          if (!path.includes('wait=true')) return send(204);
          mid = newId();
          messages.set(mid, body);
          return send(200, { id: mid, channel_id: '1200000000000000001', content: (body as { content?: string } | null)?.content ?? '' });
        }
      } else if (bot) {
        const [, channel] = bot;
        mid = bot[2];
        if (auth !== 'Bot ' + GOOD_TOKEN) return send(401, { message: '401: Unauthorized', code: 0 });
        if (channel.startsWith('403')) return send(403, { message: 'Missing Permissions', code: 50013 });
        if (mid === undefined && req.method === 'POST') {
          mid = newId();
          messages.set(mid, body);
          return send(200, { id: mid, channel_id: channel });
        }
      } else {
        return send(404, { message: '404: Not Found', code: 0 });
      }
      if (mid === undefined || !messages.has(mid)) return send(404, { message: 'Unknown Message', code: 10008 });
      if (req.method === 'PATCH') {
        messages.set(mid, body);
        return send(200, { id: mid });
      }
      if (req.method === 'DELETE') {
        messages.delete(mid);
        return send(204);
      }
      return send(405, { message: '405: Method Not Allowed', code: 0 });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    root,
    base: root + '/api',
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
