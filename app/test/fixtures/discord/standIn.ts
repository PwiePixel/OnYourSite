// Ersatz für die Discord-API in den Tests (nur lokal, nie im Betrieb): Webhooks prüfen, senden, bearbeiten und
// löschen – auch in Foren und Threads – und die Kanäle eines alten Bot-Tokens. Bei den Regeln verhält er sich wie
// Discord: Namensregeln für den Absender, ein Forum braucht thread_name oder thread_id, thread_name nur in Foren,
// Nachrichten in einem Thread findet man nur mit ?thread_id=.
//   Webhook-IDs mit Vorsilbe: 404… unbekannt (10015), 401… ungültiger Token (50027), 429… Rate-Limit, 500… Fehler,
//   155… Webhook in einem Forum-Kanal. Thread-IDs mit 404… gibt es nicht (10003). Bot-Kanäle 403…: keine Rechte.
// Steuerung: /__log (Aufrufe), /__restart (alles auf Anfang), /__forget (alle Nachrichten „in Discord gelöscht“),
//   /__fail=N (nächste Anfrage mit Status N), /__hang (nächste Anfrage bekommt keine Antwort),
//   /__delay=MS (nächste Anfrage antwortet erst nach MS Millisekunden)
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { GOOD_TOKEN } from '../updates/discordStandIn.js';

export { GOOD_TOKEN };

export interface Call { method: string; path: string; auth: string; ua: string; body: unknown }
export interface DiscordStandIn {
  root: string;
  base: string;
  calls(): Call[];
  restart(): void;
  failNext(status: number): void;
  hangNext(): void;
  delayNext(ms: number): void;
  forget(): void;
  messages(): Map<string, { hook: string; channel: string; body: unknown }>;
  close(): Promise<void>;
}

export const TEXT_CHANNEL = '1200000000000000001';
export const FORUM_CHANNEL = '1500000000000000001';
export const GUILD = '1100000000000000001';

// Discords Regeln für den Absendernamen eines Webhooks
function nameProblem(name: string): string | null {
  for (const bad of ['@', '#', ':', '```']) if (name.includes(bad)) return `Username cannot contain "${bad}"`;
  for (const word of ['discord', 'clyde']) if (name.toLowerCase().includes(word)) return `Username cannot contain "${word}"`;
  if (['everyone', 'here'].includes(name.toLowerCase())) return `Username cannot be "${name}"`;
  return null;
}

export async function startStandIn(port = 0): Promise<DiscordStandIn> {
  let log: Call[] = [];
  let failNext: number[] = [];
  let hang = 0;
  let delays: number[] = [];
  let nextId = 1300000000000000001n;
  let messages = new Map<string, { hook: string; channel: string; body: unknown }>();
  const hanging: http.ServerResponse[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = req.url ?? '/';
      const send = (code: number, data?: unknown): void => {
        const body = data === undefined ? '' : JSON.stringify(data);
        const headers: Record<string, string | number> = { 'Content-Length': Buffer.byteLength(body) };
        if (data !== undefined) headers['Content-Type'] = 'application/json';
        res.writeHead(code, headers);
        res.end(body);
      };
      if (path === '/__log') return send(200, log);
      if (path === '/__restart') {
        restart();
        return send(200, { ok: true });
      }
      if (path === '/__forget') {
        messages.clear();
        return send(200, { ok: true });
      }
      if (path.startsWith('/__fail=')) {
        failNext.push(Number(path.slice(8)));
        return send(200, { ok: true });
      }
      if (path === '/__hang') {
        hang++;
        return send(200, { ok: true });
      }
      if (path.startsWith('/__delay=')) {
        delays.push(Number(path.slice(9)));
        return send(200, { ok: true });
      }
      let body: unknown = null;
      const raw = Buffer.concat(chunks);
      if (raw.length) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          body = '<<invalid json>>';
        }
      }
      log.push({ method: req.method ?? '', path, auth: String(req.headers.authorization ?? ''), ua: String(req.headers['user-agent'] ?? ''), body });
      const delay = delays.shift();
      if (delay !== undefined) {
        setTimeout(() => answer(path, body, req, res, send), delay);
        return;
      }
      answer(path, body, req, res, send);
    });
  });

  function answer(path: string, body: unknown, req: http.IncomingMessage, res: http.ServerResponse, send: (code: number, data?: unknown) => void): void {
    {
      if (hang > 0) {
        hang--;
        hanging.push(res);
        return;
      }
      if (failNext.length) {
        const code = failNext.shift() as number;
        if (code === 429) return send(429, { message: 'You are being rate limited.', retry_after: 1.5, global: false });
        return send(code, { message: 'Simulated failure', code: 0 });
      }
      const [p, query = ''] = path.split('?');
      const params = new Map(query.split('&').filter(Boolean).map((kv) => kv.split('=') as [string, string]));
      const threadParam = params.get('thread_id');
      const newId = (): string => String(nextId++);
      const b = (body ?? {}) as Record<string, unknown>;

      const hook = /^\/api(?:\/v\d+)?\/webhooks\/(\d+)\/([\w-]+)(?:\/messages\/(\d+))?$/.exec(p);
      if (hook) {
        const [, id, token, mid] = hook;
        if (id.startsWith('404')) return send(404, { message: 'Unknown Webhook', code: 10015 });
        if (id.startsWith('401')) return send(401, { message: 'Invalid Webhook Token', code: 50027 });
        if (id.startsWith('429')) return send(429, { message: 'You are being rate limited.', retry_after: 2.2, global: false });
        if (id.startsWith('500')) return send(500, { message: '500: Internal Server Error', code: 0 });
        const forum = id.startsWith('155');
        const channel = forum ? FORUM_CHANNEL : TEXT_CHANNEL;
        if (threadParam !== undefined && threadParam.startsWith('404')) return send(404, { message: 'Unknown Channel', code: 10003 });
        if (mid === undefined && req.method === 'GET') {
          return send(200, { application_id: null, avatar: null, channel_id: channel, guild_id: GUILD, id, name: 'Captain Hook', type: 1, token });
        }
        if (mid === undefined && req.method === 'POST') {
          const problem = typeof b.username === 'string' ? nameProblem(b.username) : null;
          if (problem) {
            return send(400, { code: 50035, errors: { username: { _errors: [{ code: 'USERNAME_INVALID_CONTAINS', message: problem }] } }, message: 'Invalid Form Body' });
          }
          if (b.thread_name !== undefined && !forum) return send(400, { message: 'Webhooks can only create threads in forum channels', code: 220003 });
          if (forum && b.thread_name === undefined && threadParam === undefined) {
            return send(400, { message: 'Webhooks posted to forum channels must have a thread_name or thread_id', code: 220001 });
          }
          if (!path.includes('wait=true')) return send(204);
          const m = newId();
          // Ein neuer Forenbeitrag: der Thread hat dieselbe ID wie seine erste Nachricht
          const where = b.thread_name !== undefined ? m : threadParam ?? channel;
          messages.set(m, { hook: id, channel: where, body });
          return send(200, { id: m, channel_id: where, content: typeof b.content === 'string' ? b.content : '' });
        }
        const msg = mid !== undefined ? messages.get(mid) : undefined;
        // Nachrichten in einem Thread findet Discord nur mit ?thread_id=
        if (!msg || msg.hook !== id || (msg.channel !== channel && msg.channel !== threadParam)) return send(404, { message: 'Unknown Message', code: 10008 });
        if (req.method === 'PATCH') {
          messages.set(mid as string, { ...msg, body });
          return send(200, { id: mid, channel_id: msg.channel });
        }
        if (req.method === 'DELETE') {
          messages.delete(mid as string);
          return send(204);
        }
        return send(405, { message: '405: Method Not Allowed', code: 0 });
      }

      const bot = /^\/api\/v10\/channels\/(\d+)\/messages(?:\/(\d+))?$/.exec(p);
      if (bot) {
        const [, channel, mid] = bot;
        if (String(req.headers.authorization ?? '') !== 'Bot ' + GOOD_TOKEN) return send(401, { message: '401: Unauthorized', code: 0 });
        if (channel.startsWith('403')) return send(403, { message: 'Missing Permissions', code: 50013 });
        if (mid === undefined && req.method === 'POST') {
          const m = newId();
          messages.set(m, { hook: 'bot', channel, body });
          return send(200, { id: m, channel_id: channel });
        }
        const msg = mid !== undefined ? messages.get(mid) : undefined;
        if (!msg || msg.channel !== channel) return send(404, { message: 'Unknown Message', code: 10008 });
        if (req.method === 'PATCH') {
          messages.set(mid as string, { ...msg, body });
          return send(200, { id: mid });
        }
        if (req.method === 'DELETE') {
          messages.delete(mid as string);
          return send(204);
        }
      }
      return send(404, { message: '404: Not Found', code: 0 });
    }
  }

  function restart(): void {
    log = [];
    failNext = [];
    hang = 0;
    delays = [];
    messages = new Map();
    nextId = 1300000000000000001n;
    for (const res of hanging.splice(0)) res.destroy();
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    root,
    base: root + '/api',
    calls: () => log.slice(),
    restart,
    failNext: (status: number) => void failNext.push(status),
    hangNext: () => void hang++,
    delayNext: (ms: number) => void delays.push(ms),
    forget: () => messages.clear(),
    messages: () => messages,
    close: () => new Promise<void>((resolve) => {
      for (const res of hanging.splice(0)) res.destroy();
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
