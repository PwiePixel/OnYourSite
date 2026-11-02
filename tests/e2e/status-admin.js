// E2E: Admin-Bereich „Status pages“ (Statusseiten, Karte „Health“): Eintrag in der Navigation (Farbe lime), der
// Bereich als direkter Link, die Dienste und die eigenen Bestandteile, auf dem Handy ohne waagrechtes Verschieben.
//
// Start (Datenbank muss laufen, z. B. über oys-db.sh run):
//   node tests/e2e/status-admin.js
// Umgebung: OYS_E2E_PORT (Port des Node-Servers, Vorgabe 14212), OYS_CONFIG (Vorgabe config.json im Projekt),
// OYS_E2E_PASSWORD (Passwort der Test-Konten), OYS_E2E_SHOTS (Ordner für Bildschirmfotos, optional).
// Der Test schreibt nur Einträge der Statusseiten in oys_meta (status_worker, status_gate) und entfernt sie am Ende.
const { chromium } = require('playwright');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.OYS_E2E_PORT || 14212);
const CONFIG = process.env.OYS_CONFIG || path.join(ROOT, 'config.json');
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const HOST = String(cfg.base_domain || 'on-your.site').split(':')[0];
const BASE = `http://${HOST}:${PORT}`;
// Passwort der Testkonten aus dem Seed (zur Laufzeit zusammengesetzt)
const PASSWORD = process.env.OYS_E2E_PASSWORD || ['test', '1234'].join('');
const SHOTS = process.env.OYS_E2E_SHOTS || '';

const mysqlArgs = ['--default-character-set=utf8mb4', '-N', '-h', String(cfg.db.host || 'localhost'), '-u', String(cfg.db.user), String(cfg.db.name)];
const sql = (query) => execFileSync('mysql', [...mysqlArgs, '-e', query], { env: { ...process.env, MYSQL_PWD: String(cfg.db.pass || '') } }).toString().trim();
let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) failed++;
};

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

const clean = () => sql("DELETE FROM oys_meta WHERE meta_key IN ('status_worker', 'status_gate')");
const shot = async (p, name) => SHOTS && p.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true });

(async () => {
  const server = await startServer();
  // Ein laufender Prüfdienst und eine geschlossene Sperre (wie sie der Dienst schreibt)
  const now = Math.floor(Date.now() / 1000);
  sql(`REPLACE INTO oys_meta (meta_key, meta_value) VALUES
      ('status_worker', '{"at":${now},"pid":1,"started":${now - 3600},"version":"1","monitors":{"active":6,"paused":7},"checks_min":5,"inflight":0,"delayed_10m":0,"lag_p95_ms":120}'),
      ('status_gate', '{"state":"ok","since":${now - 3600},"reason":"","canaries":{"ok":3,"of":3}}')`);
  const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1, MAP *.${HOST} 127.0.0.1`] });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const p = await context.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('dialog', (d) => d.accept());
    await p.goto(BASE + '/login');
    await p.fill('input[name=email]', 'admin@test.de');
    await p.fill('input[name=password]', PASSWORD);
    await Promise.all([p.waitForNavigation(), p.click('button[type=submit]')]);
    await p.goto(BASE + '/admin', { waitUntil: 'networkidle' });

    const nav = p.locator('#nav-status');
    ok((await nav.innerText()).trim() === 'Status pages' && await nav.locator('i.bx-pulse').count() === 1, 'Nav entry "Status pages" with the pulse icon');
    const order = await p.evaluate(() => ['nav-code-pages', 'nav-status', 'nav-storage'].map((id) => [...document.querySelectorAll('.admin-nav-btn')].findIndex((b) => b.id === id)));
    ok(order[0] < order[1] && order[1] < order[2], 'After Code pages, before Storage');
    await nav.click();
    ok(await p.locator('#tab-status').isVisible() && p.url().endsWith('#status'), 'The section opens with #status');
    ok((await p.locator('#admin-page-title').innerText()).trim() === 'Status pages', 'Page title');
    // Farbe erst nach dem Übergang (transition-all) und dem Erzeugen der Klassen durch das Tailwind-Skript lesen
    const lime = /rgb\(163, 230, 53\)|oklch\(0\.84[0-9]* 0\.18/;
    let color = '';
    for (let i = 0; i < 20 && !lime.test(color); i++) {
      await p.waitForTimeout(100);
      color = await nav.evaluate((el) => getComputedStyle(el).color);
    }
    ok(lime.test(color), 'Active entry in lime (' + color + ')');
    const text = await p.locator('#tab-status').innerText();
    ok(text.includes('Health') && /Checker\s+RUNNING/i.test(text), 'Health card: the checker runs');
    // Seit ST-3 gibt es den Notifier-Dienst; im Test läuft er nicht und hat sich noch nie gemeldet
    ok(/Notifier\s+NOT RUNNING/i.test(text) && text.includes('It hasn’t reported yet'), 'Health card: the notifier hasn’t reported yet');
    ok(text.includes('OK') && text.includes('canaries 3/3'), 'Platform gate with the canaries');
    ok(text.includes('OnYourSite components') && text.includes('Website') && text.includes('Database'), 'The own components are listed');
    await shot(p, 'admin-status');

    await p.goto(BASE + '/admin#status', { waitUntil: 'networkidle' });
    ok(await p.locator('#tab-status').isVisible() && await p.locator('#nav-status.shadow-inner').count() === 1, '#status deep link opens the section');

    await p.setViewportSize({ width: 390, height: 844 });
    await p.goto(BASE + '/admin#status', { waitUntil: 'networkidle' });
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(overflow <= 0, 'Phone width: no horizontal page scroll (' + overflow + ')');
    await shot(p, 'admin-status-phone');
    ok(errors.length === 0, 'No script errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  } finally {
    await browser.close();
    server.kill();
    clean();
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
