// Fehler beim Senden und Ausfall der Datenbank: der Server läuft immer weiter. Ohne Datenbank antwortet Node wie PHP
// (db.php: 503-Hinweisseite vor allem anderen) – auch dann, wenn die Datenbank erst im laufenden Betrieb wegfällt.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, cpSync, createReadStream, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ROOT_DIR, loadConfig, setConfigForTests, type ConfigData } from '../src/config.js';
import { closePool } from '../src/db.js';
import { buildServer } from '../src/server.js';
import type { Ctx } from '../src/web/ctx.js';

const BASE = loadConfig();
const MISSING = String((BASE.db as ConfigData).name ?? 'oys_test') + '_missing_db';
const withoutDb: ConfigData = { ...BASE, db: { ...(BASE.db as ConfigData), name: MISSING } };

after(async () => {
  setConfigForTests(BASE);
  await closePool();
});

type Res = { status: number; type: string; body: Buffer; aborted: boolean };

function request(port: number, method: string, path: string, opts: { host?: string; body?: string; type?: string } = {}): Promise<Res> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = { Host: opts.host ?? 'oys.test:8080' };
    if (opts.body !== undefined) headers['Content-Type'] = opts.type ?? 'application/x-www-form-urlencoded';
    const req = http.request({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      let aborted = false;
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('aborted', () => (aborted = true));
      res.on('error', () => (aborted = true));
      res.on('close', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks), aborted: aborted || !res.complete }));
    });
    req.on('error', () => resolve({ status: 0, type: '', body: Buffer.alloc(0), aborted: true }));
    req.end(opts.body);
  });
}

// ---------------------------------------------------------------- Datenbank nicht erreichbar

// Die PHP-Seite mit eigener config.php (Datenbank, die es nicht gibt): Kopie der PHP-Dateien, statische Ordner verlinkt
const ROUTER = `<?php
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (preg_match('#^/(lib|cron|email|PHPMailer|tests|scripts|views|discord-bot|server)(/|$)#i', $path) || preg_match('#^/config(\\.example)?\\.php$#', $path)) {
    http_response_code(403); echo 'Forbidden'; return true;
}
$file = __DIR__ . $path;
if ($path !== '/' && is_file($file)) {
    if (substr($file, -4) === '.php') { chdir(__DIR__); require $file; return true; }
    return false;
}
chdir(__DIR__);
$_SERVER['SCRIPT_NAME'] = '/index.php';
require __DIR__ . '/index.php';
`;

function phpTree(config: ConfigData): string {
  const dir = mkdtempSync(join(tmpdir(), 'oys-dbdown-'));
  for (const f of ['index.php', 'api.php', 'admin_impersonate.php', 'admin_return.php', 'db.php', 'security.php', 'mail.php', 'blacklist.php', 'robots.txt']) {
    copyFileSync(join(ROOT_DIR, f), join(dir, f));
  }
  for (const d of ['lib', 'views', 'email']) cpSync(join(ROOT_DIR, d), join(dir, d), { recursive: true });
  for (const d of ['PHPMailer', 'static']) symlinkSync(join(ROOT_DIR, d), join(dir, d));
  const json = Buffer.from(JSON.stringify(config)).toString('base64');
  writeFileSync(join(dir, 'config.php'), `<?php return json_decode(base64_decode('${json}'), true);\n`, { mode: 0o600 });
  writeFileSync(join(dir, 'router.php'), ROUTER);
  return dir;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

async function startPhp(dir: string): Promise<{ port: number; stop(): void }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await freePort();
    const child: ChildProcess = spawn('php', ['-d', 'display_errors=0', '-d', 'session.use_strict_mode=1', '-S', `127.0.0.1:${port}`, '-t', dir, join(dir, 'router.php')],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    const started = await new Promise<boolean>((resolve) => {
      let log = '';
      child.stderr!.on('data', (c: Buffer) => {
        log += c.toString();
        if (/Development Server \(.*\) started/.test(log)) resolve(true);
      });
      child.once('exit', () => resolve(false));
    });
    if (started) return { port, stop: () => child.kill() };
  }
  throw new Error('php -S did not start');
}

// Anfragen quer durch index.php, api.php und die alten Einstiege (anonym, ohne Sitzung)
const REQUESTS: Array<[string, string, { host?: string; body?: string; type?: string }?]> = [
  ['GET', '/'], ['HEAD', '/'], ['GET', '/login'], ['POST', '/login', { body: 'email=a%40b.de&password=x' }], ['GET', '/register'], ['GET', '/dashboard'],
  ['GET', '/admin'], ['GET', '/challenge'], ['GET', '/imprint'], ['GET', '/privacy'], ['GET', '/terms'], ['GET', '/terms/code-pages'], ['GET', '/updates'],
  ['GET', '/updates/3'], ['GET', '/roadmap'], ['GET', '/updates/feed.xml'], ['GET', '/pixel'], ['GET', '/pixel/kalender'], ['GET', '/no-such-page'],
  ['GET', '/a/b/c'], ['GET', '/', { host: 'mia.oys.test:8080' }], ['GET', '/kalender', { host: 'mia.oys.test:8080' }], ['GET', '/x', { host: 'other.example' }],
  ['GET', '/_/v?p=1'], ['POST', '/_/c', { body: 'p=1&b=2' }], ['GET', '/_/og/1.png'], ['GET', '/_/go?u=x'], ['GET', '/_/cron/weekly-report'],
  ['POST', '/track-click', { body: '{"link_id":1}', type: 'application/json' }], ['GET', '/api.php?user=mia'], ['GET', '/api.php'],
  ['GET', '/admin_return.php'], ['GET', '/admin_impersonate.php?id=5'],
  // ohne Datenbank (vor db.php): Dateien und Uploads
  ['GET', '/robots.txt'], ['GET', '/static/uploads/none.png'], ['GET', '/lib/config.php'],
];

// db.php nennt config.php, die Node-Version config.json (dort stehen die Zugangsdaten jetzt) – sonst gleich
const normalize = (r: Res) => ({ status: r.status, type: r.type.toLowerCase().replace(/; ?charset=utf-8$/, ''), body: r.body.toString().replace('config.json', 'config.php') });

async function answers(port: number): Promise<Array<ReturnType<typeof normalize>>> {
  const out = [];
  for (const [method, path, opts] of REQUESTS) out.push(normalize(await request(port, method, path, opts)));
  return out;
}

function compare(node: Array<ReturnType<typeof normalize>>, php: Array<ReturnType<typeof normalize>>, label: string): void {
  // Dateien liefert sonst Apache – php -S setzt andere Content-Types, darum dort nur Status und Inhalt
  const diffs = REQUESTS.map(([m, p, o], i) => ({ req: `${m} ${o?.host ?? ''}${p}`, node: node[i], php: php[i] }))
    .map((d) => (d.req.includes('/robots.txt') ? { ...d, node: { ...d.node, type: '' }, php: { ...d.php, type: '' } } : d));
  // Gesperrte Ordner beantwortet im Betrieb Apache selbst (403 mit Apaches Seite) – Node antwortet genauso, php -S nicht
  for (const d of diffs.filter((x) => x.req.endsWith('/lib/config.php'))) assert.equal(d.node.status, 403, `${label}: ${d.req}`);
  // Fremde Hosts berühren die Datenbank nie (premium-domains PD-2): die 404-Seite statt der Hinweisseite von PHP
  for (const d of diffs.filter((x) => x.req.includes('other.example'))) assert.equal(d.node.status, 404, `${label}: ${d.req}`);
  assert.deepEqual(diffs.filter((d) => !d.req.endsWith('/lib/config.php') && !d.req.includes('other.example') && JSON.stringify(d.node) !== JSON.stringify(d.php)), [], label);
}

test('without the database Node answers every request like PHP – at start and when it fails later', async () => {
  const dir = phpTree(withoutDb);
  const php = await startPhp(dir);
  const quiet = console.error;
  console.error = () => {};
  try {
    const expected = await answers(php.port);
    // Sicherstellen, dass PHP wirklich die Hinweisseite zeigt (sonst prüft der Test nichts)
    assert.equal(expected[0].status, 503);
    assert.match(expected[0].body, /Database connection failed\./);

    // 1. Datenbank schon beim Start nicht erreichbar (dieser Test läuft als erster: das Schema wurde in diesem Prozess
    // noch nie geprüft)
    setConfigForTests(withoutDb);
    await closePool();
    let app = await buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    // Erst schließen, dann vergleichen: ein offener Server hielte den Testlauf bei einem Fehlschlag fest
    const atStart = await answers((app.server.address() as net.AddressInfo).port);
    await app.close();
    compare(atStart, expected, 'database down at start');

    // 2. Datenbank fällt im Betrieb weg (Schema schon geprüft, Verbindungen im Pool)
    setConfigForTests(BASE);
    await closePool();
    app = await buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as net.AddressInfo).port;
    assert.equal((await request(port, 'GET', '/imprint')).status, 200);
    setConfigForTests(withoutDb);
    await closePool();
    const whileRunning = await answers(port);
    await app.close();
    compare(whileRunning, expected, 'database gone while running');
  } finally {
    console.error = quiet;
    php.stop();
    setConfigForTests(BASE);
    await closePool();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- Fehler beim Senden

const SLOW = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAILING: Record<string, (ctx: Ctx) => Promise<void>> = {
  // scheitert beim ersten Lesen (vor dem ersten Byte)
  '/early': async (ctx) => {
    ctx.body = new Readable({ read() { this.destroy(new Error('read failed')); } });
  },
  // scheitert nach 200 KB
  '/late': async (ctx) => {
    let n = 0;
    ctx.body = new Readable({ read() { if (n++ < 4) this.push(Buffer.alloc(50000, 97)); else this.destroy(new Error('read failed later')); } });
  },
  // scheitert, bevor der Server ihn überhaupt sendet (die Anfrage arbeitet noch) – beendete früher den ganzen Prozess
  '/before-send': async (ctx) => {
    const stream = new Readable({ read() {} });
    setImmediate(() => stream.destroy(new Error('gone before sending')));
    ctx.body = stream;
    await SLOW(30);
  },
  // Datei verschwindet zwischen Prüfung und Öffnen
  '/missing-file': async (ctx) => {
    ctx.body = createReadStream(join(tmpdir(), 'oys-no-such-file-' + process.pid));
    await SLOW(30);
  },
  // Kopfzeilen, die Node nicht senden kann, fallen weg – die Seite kommt trotzdem
  '/headers': async (ctx) => {
    ctx.header('Content-Disposition', 'attachment; filename="Größe €.txt"');
    ctx.header('X-Broken', 'a\nb');
    ctx.header('X Broken Name', 'x');
    ctx.header('X-Fine', 'yes');
    ctx.body = 'page';
  },
  '/ok': async (ctx) => {
    ctx.body = 'still running';
  },
};

test('errors while a response is being sent never stop the server', async () => {
  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => uncaught.push(err);
  process.on('uncaughtException', onUncaught);
  const app = await buildServer({ dispatch: async (ctx) => FAILING[ctx.path](ctx) });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as net.AddressInfo).port;
  const quiet = console.error;
  console.error = () => {};
  try {
    // Vor dem ersten Byte: leere 500 wie PHP ohne Fehleranzeige (keine Fehlermeldung als JSON)
    for (const path of ['/early', '/before-send', '/missing-file']) {
      const r = await request(port, 'GET', path);
      assert.deepEqual([r.status, r.type, r.body.toString()], [500, 'text/html; charset=UTF-8', ''], path);
    }
    // Mitten im Senden: nur noch Abbruch der Verbindung
    const late = await request(port, 'GET', '/late');
    assert.equal(late.status, 200);
    assert.ok(late.aborted && late.body.length >= 50000 && late.body.length < 250000, 'late failure cuts the response');
    const h = await new Promise<http.IncomingMessage>((resolve) => http.get({ host: '127.0.0.1', port, path: '/headers', agent: false, headers: { Host: 'oys.test:8080' } }, (res) => {
      res.resume();
      resolve(res);
    }));
    assert.equal(h.statusCode, 200);
    assert.equal(h.headers['content-disposition'], undefined);
    assert.equal(h.headers['x-fine'], 'yes');
    assert.equal(h.headers['x-broken'], undefined);
    // Der Server antwortet weiter
    const ok = await request(port, 'GET', '/ok');
    assert.deepEqual([ok.status, ok.body.toString()], [200, 'still running']);
    await SLOW(50);
    assert.deepEqual(uncaught, []);
  } finally {
    console.error = quiet;
    process.off('uncaughtException', onUncaught);
    await app.close();
  }
});
