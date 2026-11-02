// E2E: eigene Domain (PD-2, ohne Editor und ohne Cloudflare): Die Domain wird direkt in der Datenbank aktiviert, wie es
// der Domain-Dienst später tut. Im echten Browser: die OnYourSite-Adresse leitet auf die Domain, die Seite erscheint mit
// Designs, Profilbild und kanonischer Adresse der Domain, der Aufruf wird gezählt (page.js von der Domain aus), es
// entsteht kein Cookie, App-Seiten und fremde Dateien gibt es dort nicht; Schalter „Weiterleiten“ aus und Pause.
//
// Start (Datenbank muss laufen, z. B. über oys-db.sh run):
//   node tests/e2e/domains-host.js
// Umgebung: OYS_E2E_PORT (Port des Node-Servers, Vorgabe 14214), OYS_CONFIG (Vorgabe config.json im Projekt),
// OYS_E2E_SHOTS (Ordner für Bildschirmfotos, optional). Der Test legt eine eigene Konfiguration (mit den Werten der
// Einrichtung) im temporären Ordner an und schreibt nur in die Datenbank daraus: eine Domain für Mias Seite (id 2), am
// Ende wieder entfernt; der Aufrufzähler der Seite wird zurückgesetzt.
const { chromium } = require('playwright');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.OYS_E2E_PORT || 14214);
const SOURCE = process.env.OYS_CONFIG || path.join(ROOT, 'config.json');
const SHOTS = process.env.OYS_E2E_SHOTS || '';
const base = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
const HOST = String(base.base_domain || 'on-your.site').split(':')[0];
const DOMAIN = 'links.example.com';
const SITE = `http://${HOST}:${PORT}`;
const MIA = `http://mia.${HOST}:${PORT}`;
const ORIGIN = `http://${DOMAIN}:${PORT}`;

// Eigene Konfiguration: Port in allen Adressen, Werte der Einrichtung für eigene Domains
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oys-e2e-domains-'));
const CONFIG = path.join(dir, 'config.json');
fs.writeFileSync(CONFIG, JSON.stringify({
  ...base, base_domain: `${HOST}:${PORT}`, scheme: 'http',
  cloudflare: { zone_id: 'f'.repeat(32) },
  custom_domains: { cname_target: `edge.${HOST}`, fallback_origin: `origin.${HOST}`, url_port: `:${PORT}` },
}), { mode: 0o600 });

const mysqlArgs = ['--default-character-set=utf8mb4', '-N', '-h', String(base.db.host || 'localhost'), '-u', String(base.db.user), String(base.db.name)];
const sql = (query) => execFileSync('mysql', [...mysqlArgs, '-e', query], { env: { ...process.env, MYSQL_PWD: String(base.db.pass || '') } }).toString().trim();
let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) failed++;
};
const shot = async (p, name) => SHOTS && p.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false });

async function startServer() {
  const server = spawn(path.join(ROOT, 'app/node_modules/.bin/tsx'), ['src/server.ts'], {
    cwd: path.join(ROOT, 'app'), env: { ...process.env, PORT: String(PORT), OYS_CONFIG: CONFIG }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 150; i++) {
    if (log.includes('listening')) return server;
    if (server.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  server.kill();
  throw new Error('server did not start:\n' + log);
}

const clean = () => sql(`DELETE FROM custom_domains WHERE hostname = '${DOMAIN}'; DELETE FROM custom_domain_log WHERE hostname = '${DOMAIN}';
  UPDATE pages SET custom_domain = NULL WHERE custom_domain = '${DOMAIN}';`);
const setState = (state, redirect = 1) => sql(`UPDATE custom_domains SET state = '${state}', redirect = ${redirect}, version = version + 1, state_at = NOW()
  WHERE hostname = '${DOMAIN}'; UPDATE pages SET custom_domain = ${state === 'active' ? `'${DOMAIN}'` : 'NULL'} WHERE id = 2;`);

(async () => {
  const server = await startServer();
  // Der Server hat das Schema beim Start auf den neuesten Stand gebracht
  clean();
  const views = Number(sql('SELECT views FROM pages WHERE id = 2'));
  // Tageszähler der Seite (jeder Seitenaufruf im Test zählt): am Ende wieder wie vorher
  const today = sql("SELECT CONCAT(day, ' ', views, ' ', clicks) FROM stats_daily WHERE page_id = 2 AND day = CURDATE()");
  const avatarBefore = sql("SELECT COALESCE(avatar, '') FROM pages WHERE id = 2");
  // Profilbild des Besitzers (1×1 PNG) im Upload-Ordner der Seite – muss auf der Domain laden
  const uploads = base.uploads_dir ? path.resolve(ROOT, String(base.uploads_dir)) : path.join(ROOT, 'static/uploads');
  const avatarFile = 'avatar_5_1700000000_e2e00001.png';
  fs.mkdirSync(uploads, { recursive: true });
  fs.writeFileSync(path.join(uploads, avatarFile), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  sql(`UPDATE pages SET avatar = '${avatarFile}' WHERE id = 2`);
  sql(`INSERT INTO custom_domains (hostname, target_type, target_id, user_id, state, version, state_at, created_at, updated_at)
    VALUES ('${DOMAIN}', 'page', 2, 5, 'verifying', 0, NOW(), NOW(), NOW())`);
  setState('active');
  const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1, MAP *.${HOST} 127.0.0.1, MAP ${DOMAIN} 127.0.0.1`] });
  const errors = [];
  const failedRequests = [];
  try {
    // Gewöhnlicher Browser-Kennzeichner: „HeadlessChrome“ gilt als Bot und würde nicht gezählt
    const context = await browser.newContext({
      viewport: { width: 1280, height: 860 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    const p = await context.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('response', (r) => r.status() >= 400 && failedRequests.push(r.status() + ' ' + r.url()));

    // 1. Die OnYourSite-Adresse führt auf die Domain, die Seite erscheint vollständig
    await p.goto(MIA + '/?from=qr', { waitUntil: 'networkidle' });
    ok(p.url() === ORIGIN + '/?from=qr', 'Subdomain forwards to the custom domain with the query (' + p.url() + ')');
    ok((await p.locator('link[rel=canonical]').getAttribute('href')) === ORIGIN, 'Canonical is the domain');
    ok(await p.locator('.oys-name, h1').first().isVisible(), 'The page renders');
    const bg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
    ok(bg !== '' && bg !== 'rgba(0, 0, 0, 0)', 'Theme CSS from /static is applied (' + bg + ')');
    const img = p.locator(`img[src="/static/uploads/${avatarFile}"]`).first();
    ok(await img.evaluate((el) => el.complete && el.naturalWidth > 0).catch(() => false), 'The owner’s avatar loads on the domain');
    ok(failedRequests.length === 0, 'No failed requests' + (failedRequests.length ? ': ' + failedRequests.join(' | ') : ''));
    await shot(p, 'domain-page');

    // 2. Der Aufruf von der Domain zählt (sendBeacon an /_/v mit Origin = Domain)
    let counted = false;
    for (let i = 0; i < 30 && !counted; i++) {
      counted = Number(sql('SELECT views FROM pages WHERE id = 2')) > views;
      if (!counted) await p.waitForTimeout(200);
    }
    ok(counted, 'The view counts');
    ok((await context.cookies()).length === 0, 'No cookie at all');

    // 3. Keine App, keine fremden Dateien auf der Domain
    for (const route of ['/login', '/dashboard', '/admin', '/api.php?user=mia', '/static/uploads/file_6_1700000000_abcdef02.pdf']) {
      const res = await p.goto(ORIGIN + route);
      ok(res.status() === 404 && (await p.locator('body').innerText()).includes('isn’t connected to a page'), `${route}: neutral 404`);
    }
    await shot(p, 'domain-neutral');
    const other = await p.goto(ORIGIN + '/whatever');
    ok(other.status() === 200 && p.url() === ORIGIN + '/', 'Other paths go to the start of the domain');

    // 4. Schalter „Weiterleiten“ aus: die Subdomain zeigt die Seite selbst, kanonisch bleibt die Domain
    setState('active', 0);
    await p.goto(MIA + '/', { waitUntil: 'networkidle' });
    ok(p.url() === MIA + '/', 'Forwarding off: the subdomain shows the page');
    ok((await p.locator('link[rel=canonical]').getAttribute('href')) === ORIGIN, 'Forwarding off: canonical is still the domain');

    // 5. Pause (Premium endete): die Domain leitet zur OnYourSite-Adresse
    setState('suspended');
    await p.goto(ORIGIN + '/?x=1', { waitUntil: 'networkidle' });
    ok(p.url() === MIA + '/?x=1', 'Paused: the domain forwards to the OnYourSite address (' + p.url() + ')');
    ok((await p.locator('link[rel=canonical]').getAttribute('href')) === MIA, 'Paused: canonical is the OnYourSite address');

    // 6. Nicht (mehr) verbunden
    setState('blocked');
    const blocked = await p.goto(ORIGIN + '/');
    ok(blocked.status() === 404 && (await p.locator('body').innerText()).includes('isn’t connected to a page'), 'Blocked: neutral 404');
    ok(!(await p.content()).includes('OnYourSite'), 'The neutral page doesn’t advertise OnYourSite');

    // 7. Ohne Domain: alles wie bisher
    clean();
    await p.goto(MIA + '/', { waitUntil: 'networkidle' });
    ok(p.url() === MIA + '/' && (await p.locator('link[rel=canonical]').getAttribute('href')) === MIA, 'Without a domain nothing changes');
    await p.goto(SITE + '/mia');
    ok(p.url() === MIA + '/', 'Path address still forwards to the subdomain');

    ok(errors.length === 0, 'No script errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  } finally {
    await browser.close();
    server.kill();
    clean();
    sql(`UPDATE pages SET views = ${views}, avatar = ${avatarBefore === '' ? 'NULL' : `'${avatarBefore}'`} WHERE id = 2`);
    if (today === '') {
      sql('DELETE FROM stats_daily WHERE page_id = 2 AND day = CURDATE()');
    } else {
      const [day, v, c] = today.split(' ');
      sql(`UPDATE stats_daily SET views = ${Number(v)}, clicks = ${Number(c)} WHERE page_id = 2 AND day = '${day}'`);
    }
    fs.rmSync(path.join(uploads, avatarFile), { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
