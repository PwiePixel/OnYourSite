// E2E: Honigwaben-Symbole sind überall gelb (honeycomb-shop §5.1): Kontostand oben im Editor, Hinweis beim Verdienen,
// Fenster „Your honeycombs“, Freischalten der Code-Seite, Admin (Navigation, aktiver Bereich, Symbole) und die
// Bedingungen der Code-Seiten. Das Logo bleibt in der Markenfarbe. Geprüft werden die berechneten Farben.
//
// Start (Datenbank muss laufen, z. B. über oys-db.sh run):
//   node tests/e2e/hc-yellow.js
// Umgebung wie tests/e2e/admin-split.js: OYS_E2E_PORT, OYS_CONFIG, OYS_E2E_PASSWORD, OYS_E2E_SHOTS.
// Der Test löscht die Honigwaben-Buchungen und Code-Seiten des Testkontos lea@test.de (id 7) vorher und nachher
// (Ausgangsstand: keine) und am Ende jede Buchung, die während des Laufs entstanden ist.
const { chromium } = require('playwright');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.OYS_E2E_PORT || 14204);
const CONFIG = process.env.OYS_CONFIG || path.join(ROOT, 'config.json');
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const HOST = String(cfg.base_domain || 'on-your.site').split(':')[0];
const BASE = `http://${HOST}:${PORT}`;
const PASSWORD = process.env.OYS_E2E_PASSWORD || ['test', '1234'].join('');
const SHOTS = process.env.OYS_E2E_SHOTS || '';

// Tailwind yellow-400 (--hc), yellow-300 (--hc-2), yellow-200 (--hc-text), amber-500, Marke brand-500
const YELLOW = 'rgb(250, 204, 21)';
const YELLOW_2 = 'rgb(253, 224, 71)';
const YELLOW_TEXT = 'rgb(254, 240, 138)';
const AMBER = 'rgb(245, 158, 11)';
const BRAND = 'rgb(99, 102, 241)';

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

const style = (loc, prop) => loc.evaluate((el, p) => getComputedStyle(el)[p], prop);
const shot = async (p, name) => SHOTS && p.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false });

async function login(browser, email, width = 1400) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const p = await context.newPage();
  await p.goto(BASE + '/login');
  await p.fill('input[name=email]', email);
  await p.fill('input[name=password]', PASSWORD);
  await Promise.all([p.waitForNavigation(), p.click('button[type=submit]')]);
  return p;
}

// Lea ohne Buchungen und ohne Code-Seite; dazu alle Buchungen seit dem Start
let ledgerStart = 0;
const clean = () => sql(`DELETE FROM code_files WHERE site_id IN (SELECT id FROM code_sites WHERE user_id = 7);
    DELETE FROM code_sites WHERE user_id = 7; DELETE FROM honeycomb_ledger WHERE user_id = 7 OR id > ${ledgerStart};`);

(async () => {
  // Ohne Buchungen gibt es beim ersten Öffnen des Editors die Tagesbelohnung (gelber Hinweis)
  ledgerStart = Number(sql('SELECT COALESCE(MAX(id), 0) FROM honeycomb_ledger'));
  clean();
  const server = await startServer();
  const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1, MAP *.${HOST} 127.0.0.1`] });
  const errors = [];
  try {
    // ---------------------------------------------------------- Editor
    const p = await login(browser, 'lea@test.de');
    p.on('pageerror', (e) => errors.push(e.message));
    await p.waitForURL(/\/dashboard/);
    const toastEl = p.locator('#toasts .toast.hc').first();
    await toastEl.waitFor({ state: 'visible', timeout: 5000 });
    ok((await toastEl.innerText()).includes('honeycombs for being active today'), 'Earned reward shows a honeycomb toast');
    ok(await style(toastEl, 'color') === YELLOW_2, '.toast.hc text is yellow (' + await style(toastEl, 'color') + ')');
    ok((await style(toastEl, 'borderTopColor')).startsWith('rgba(250, 204, 21'), '.toast.hc border is yellow');
    ok(await style(toastEl.locator('i.bx-hive'), 'color') === YELLOW_2, '.toast.hc icon is yellow');
    await shot(p, 'hc-toast');

    const pillIcon = p.locator('#hcBtn i');
    ok(await style(pillIcon, 'color') === YELLOW, '.hc-pill i is ' + YELLOW + ' (' + await style(pillIcon, 'color') + ')');
    ok(await style(p.locator('#hcBtn'), 'color') === YELLOW_TEXT, '.hc-pill text is yellow');
    ok((await style(p.locator('#hcBtn'), 'backgroundColor')).startsWith('rgba(250, 204, 21'), '.hc-pill background is yellow');
    const logo = p.locator('aside.app-rail i.bx-hive').first();
    ok(await style(logo, 'color') === BRAND, 'The rail logo keeps the brand colour (' + await style(logo, 'color') + ')');

    // Fenster „Your honeycombs“
    await p.click('#hcBtn');
    await p.locator('#hcModal .hc-big').waitFor();
    ok(await style(p.locator('#hcModal .hc-big > i'), 'color') === YELLOW, '.hc-big icon is yellow');
    const openRule = p.locator('#hcModal .hc-rule:not(.done) .ri').first();
    ok(await style(openRule, 'color') === YELLOW, '.hc-rule icon is yellow');
    ok(await style(p.locator('#hcModal .hc-rule .amt').first(), 'color') === YELLOW, '.hc-rule amount is yellow');
    ok(await style(p.locator('#hcModal .hc-rule.done .ri').first(), 'color') === 'rgb(74, 222, 128)', 'Done rules stay green');
    ok(await style(p.locator('#hcModal [data-action=open-code] i.bx-hive'), 'color') === YELLOW, 'Price icon of the code page is yellow');
    await shot(p, 'hc-modal');
    await p.click('#hcModal [data-action=open-code]');

    // Code-Seite freischalten (gesperrt)
    await p.locator('#tab-code .code-hero').waitFor();
    const badge = p.locator('#tab-code .bdg.hc');
    ok((await badge.innerText()).includes('Unlock with honeycombs') && await style(badge, 'color') === YELLOW, '"Unlock with honeycombs" badge is yellow');
    ok(await style(p.locator('#tab-code .code-price .hc-icon').first(), 'color') === YELLOW, 'Balance icon of the unlock box is yellow');
    ok(await style(p.locator('#tab-code [data-action=honeycombs] i'), 'color') === YELLOW, '"How to earn honeycombs" icon is yellow');
    const bar = await style(p.locator('#tab-code .hc-bar span'), 'backgroundImage');
    ok(bar.includes(AMBER) && bar.includes(YELLOW), 'Progress bar is amber to yellow');
    await shot(p, 'hc-code-locked');

    // Schmal: Kontostand bleibt gelb
    await p.setViewportSize({ width: 390, height: 844 });
    ok(await style(pillIcon, 'color') === YELLOW, 'Phone width: the pill icon stays yellow');

    // ---------------------------------------------------------- Admin
    const a = await login(browser, 'admin@test.de');
    a.on('pageerror', (e) => errors.push(e.message));
    await a.goto(BASE + '/admin#users', { waitUntil: 'networkidle' });
    ok(await style(a.locator('#nav-honeycombs i'), 'color') === YELLOW, 'Admin nav: honeycomb icon is yellow while inactive');
    ok(await style(a.locator('aside a i.bx-hive'), 'color') === 'rgb(255, 255, 255)', 'Admin logo keeps its look');
    await a.click('#nav-honeycombs');
    await a.waitForTimeout(400);
    const nav = a.locator('#nav-honeycombs');
    ok((await nav.getAttribute('class')).includes('border-yellow-500/30 bg-yellow-500/10 text-yellow-400'), 'Active honeycombs tab uses the yellow style');
    ok(await style(nav, 'color') === YELLOW && (await style(nav, 'borderTopColor')).startsWith('rgba(234, 179, 8'), 'Active honeycombs tab is yellow');
    const hcIcons = a.locator('#tab-honeycombs i.bx-hive');
    const colors = await hcIcons.evaluateAll((els) => els.map((el) => getComputedStyle(el).color));
    ok(colors.length >= 2 && colors.every((c) => c === YELLOW), 'Every honeycomb icon in the Honeycombs section is yellow (' + colors.length + ')');
    await shot(a, 'hc-admin');
    await a.click('#nav-code-pages');
    await a.waitForTimeout(400);
    const codeIcons = await a.locator('#tab-code-pages i.bx-hive').evaluateAll((els) => els.map((el) => getComputedStyle(el).color));
    ok(codeIcons.length >= 2 && codeIcons.every((c) => c === YELLOW), 'Honeycomb icons in the Code pages section are yellow');
    ok(await style(a.locator('#nav-code-pages'), 'color') === 'rgb(129, 140, 248)', 'Code pages tab keeps the brand style');

    // ---------------------------------------------------------- Bedingungen der Code-Seiten
    await a.goto(BASE + '/terms/code-pages', { waitUntil: 'networkidle' });
    const termsIcons = await a.locator('i.bx-hive').evaluateAll((els) => els.map((el) => getComputedStyle(el).color));
    ok(termsIcons.length === 2 && termsIcons[0] === BRAND && termsIcons[1] === YELLOW, 'Terms: logo brand, honeycomb heading yellow');

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
