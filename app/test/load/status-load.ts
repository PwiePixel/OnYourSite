// Lasttest des Prüfdienstes (nicht Teil von npm test):
//   node --import tsx test/load/status-load.ts [--monitors 2000] [--minutes 10] [--slow 0.1]
// Ein lokaler HTTPS-Server antwortet für alle Testnamen (ein Test-DNS löst sie nach 127.0.0.1 auf; jeder Name ist eine
// eigene Domain, damit die Grenzen je Domain nicht greifen); ein Teil antwortet erst nach 8 s oder nie (Zeitlimit 10 s).
// Alle Prüfungen jede Minute. Geprüft am Ende: p95 der Verzögerung unter 5 s, keine gesunde Prüfung zweimal in ihrem
// Abstand, Speicher unter 400 MB, nie mehr gleichzeitig als erlaubt.
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { ensureSchema } from '../../src/schema.js';
import { closePool } from '../../src/db.js';
import { testDatabase } from '../coreHarness.js';
import { startDns } from '../helpers/dnsServer.js';
import { testPki } from '../helpers/certs.js';
import { testChecker, testClock } from '../helpers/checkerHarness.js';
import type { Targets } from '../helpers/targets.js';

const arg = (name: string, d: number): number => {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? d : Number(process.argv[i + 1]);
};
const MONITORS = arg('monitors', 2000);
const MINUTES = arg('minutes', 10);
const SLOW = arg('slow', 0.1);
const CONCURRENCY = 1000;

async function main(): Promise<number> {
  const db = await testDatabase('st2load', {});
  await ensureSchema();
  const names = Array.from({ length: MONITORS }, (_v, i) => `t${i + 1}.zz`);
  const pki = testPki();
  const leaf = pki.leaf(names);
  const starts = new Map<string, number[]>();
  const server = https.createServer({ key: leaf.key, cert: leaf.cert }, (req, res) => {
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
    // robots.txt holt der Prüfdienst einmal am Tag je Host – das ist keine Prüfung
    if (req.url === '/robots.txt') {
      res.writeHead(404);
      res.end();
      return;
    }
    const list = starts.get(host) ?? [];
    list.push(Date.now());
    starts.set(host, list);
    if (req.url === '/hang') return;
    if (req.url === '/slow') {
      setTimeout(() => res.end('late'), 8000);
      return;
    }
    res.end('ok');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  const dns = await startDns(Object.fromEntries(names.map((n) => [n, { A: ['127.0.0.1'], ttl: 300 }])));

  // 100 Konten mit je einer Seite; die Grenzen der Nutzer kommen aus dem Test-Einstieg
  const now = Math.floor(Date.now() / 1000);
  for (let u = 0; u < 100; u++) {
    await db.admin.query(`INSERT INTO \`${db.name}\`.status_pages (user_id, slug, title, changed_at, created_at, updated_at) VALUES (?, ?, 'Load', ?, NOW(), NOW())`, [10_000 + u, `load-${u}`, now]);
  }
  const [pages] = await db.admin.query(`SELECT id, user_id FROM \`${db.name}\`.status_pages WHERE slug LIKE 'load-%' ORDER BY id`);
  const pageList = pages as Array<{ id: number; user_id: number }>;
  const healthy = new Set<string>();
  for (let i = 0; i < MONITORS; i++) {
    const p = pageList[i % pageList.length];
    const bad = i < MONITORS * SLOW;
    const path = bad ? (i % 2 ? '/hang' : '/slow') : '/ok';
    if (!bad) healthy.add(names[i]);
    await db.admin.query(`INSERT INTO \`${db.name}\`.status_monitors (page_id, user_id, type, name, target, target_host, target_domain, config, interval_s, position, changed_at, created_at, updated_at)
      VALUES (?, ?, 'http', ?, ?, ?, ?, '{"timeout":10,"retries":1}', 60, ?, ?, NOW(), NOW())`, [p.id, p.user_id, names[i], `https://${names[i]}:${port}${path}`, names[i], names[i], i, now]);
  }

  const targets = { httpPort: port, httpsPort: port, seen: [], robots: new Map(), status: new Map(), close: async () => undefined } as unknown as Targets;
  const clock = testClock();
  const c = testChecker({ dns, targets, clock, ca: pki.ca, userChecks: 1_000_000 });
  (c.deps.scheduler as { concurrency: number }).concurrency = CONCURRENCY;
  await c.start();
  let maxInflight = 0;
  let maxRss = 0;
  const until = Date.now() + MINUTES * 60_000;
  let lastReport = Date.now();
  while (Date.now() < until) {
    const wake = c.tick();
    maxInflight = Math.max(maxInflight, c.scheduler.inflight);
    maxRss = Math.max(maxRss, process.memoryUsage().rss);
    if (Date.now() - lastReport > 30_000) {
      lastReport = Date.now();
      console.log(`… ${Math.round((until - Date.now()) / 1000)} s left, in flight ${c.scheduler.inflight}, lag p95 ${c.scheduler.lagP95(Date.now())} ms, rss ${Math.round(process.memoryUsage().rss / 1e6)} MB`);
    }
    await new Promise((r) => setTimeout(r, Math.max(10, Math.min(1000, wake - Date.now()))));
  }
  const lag = c.scheduler.lagP95(Date.now());
  await c.stop(true);
  // Gesunde Prüfungen: nie zweimal innerhalb ihres Abstands (mit 2 s Spiel)
  let doubled = 0;
  for (const [host, list] of starts) {
    if (!healthy.has(host)) continue;
    for (let i = 1; i < list.length; i++) if (list[i] - list[i - 1] < 58_000) doubled++;
  }
  const checks = [...starts.values()].reduce((a, l) => a + l.length, 0);
  console.log(`${MONITORS} monitors, ${MINUTES} min: ${checks} checks, lag p95 ${lag} ms, max in flight ${maxInflight}, max rss ${Math.round(maxRss / 1e6)} MB, doubled ${doubled}`);
  const ok = lag < 5000 && doubled === 0 && maxRss < 400e6 && maxInflight <= CONCURRENCY;
  console.log(ok ? 'PASS' : 'FAIL');
  server.closeAllConnections();
  server.close();
  await dns.stop();
  pki.done();
  await closePool();
  await db.done();
  return ok ? 0 : 1;
}

void main().then((code) => process.exit(code), (err) => {
  console.error(err);
  process.exit(1);
});
