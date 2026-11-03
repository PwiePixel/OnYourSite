// E2E: Code-Seiten-Plätze im Seitenwechsler „Your pages“ (CS-6). Lea (id 7) hat Code-Seiten freigeschaltet: Sie legt
// über „Add a code page“ zuerst die Code-Seite an eigener Adresse an, dann eine weitere auf einem neuen Seitenplatz
// (More code pages kostet nichts), sieht beide im Wechsler, öffnet sie und löscht die zweite mit getippter Adresse im
// Dialog der Seite. Kein Browser-Dialog (alert/confirm/prompt) darf erscheinen.
//
// Start (Datenbank muss laufen, z. B. über oys-db.sh run):
//   OYS_E2E_PORT=14260 node tests/e2e/cs6-slots.js
// Nur gegen eine Test-Datenbank (Name beginnt mit oys_test; sonst Abbruch mit Code 2, bevor er die Datenbank aufruft).
// Der Test setzt Code-Seiten, Seiten (außer der ersten) und die Freischaltung von Lea vorher und nachher zurück.
const { chromium } = require('playwright');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.OYS_E2E_PORT || 14260);
const CONFIG = process.env.OYS_CONFIG || path.join(ROOT, 'config.json');
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const DB_NAME = String((cfg.db && cfg.db.name) || '');
if (!DB_NAME.startsWith('oys_test')) {
  console.error(`Refusing to run: ${CONFIG} uses the database "${DB_NAME}", which is not a test database (oys_test…).`);
  process.exit(2);
}
const HOST = String(cfg.base_domain || 'on-your.site').split(':')[0];
const BASE = `http://${HOST}:${PORT}`;
const PASSWORD = process.env.OYS_E2E_PASSWORD || ['test', '1234'].join('');

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

// Lea ohne Code-Seiten und ohne weitere Seiten; Code-Seiten freigeschaltet (Geschenk), Regeln akzeptiert
const reset = () => {
  sql(`UPDATE pages SET code_site_id = NULL WHERE user_id = 7;
    DELETE FROM code_files WHERE site_id IN (SELECT id FROM code_sites WHERE user_id = 7);
    DELETE FROM code_sites WHERE user_id = 7;
    DELETE FROM pages WHERE user_id = 7 AND slug IN ('lea-lab', 'lea-extra');
    DELETE FROM site_addresses WHERE slug IN ('lea-lab', 'lea-extra', 'lea-lab-two');
    DELETE FROM rate_limits WHERE rl_key = 'slots:7';
    DELETE FROM honeycomb_ledger WHERE user_id = 7 AND reason = 'unlock';
    UPDATE users SET code_terms_at = NOW() WHERE id = 7;`);
  if (sql("SHOW TABLES LIKE 'hc\\_entitlements'") !== '') sql('DELETE FROM hc_entitlements WHERE user_id = 7;');
  sql("INSERT INTO honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (7, 0, 'unlock', 'code_page', 'e2e', NOW())");
};

async function login(browser, email) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const p = await context.newPage();
  await p.goto(BASE + '/login');
  await p.fill('input[name=email]', email);
  await p.fill('input[name=password]', PASSWORD);
  await Promise.all([p.waitForNavigation(), p.click('button[type=submit]')]);
  return p;
}

const openMenu = async (p) => {
  await p.click('#pageSwitcherBtn');
  await p.locator('#pageMenu:not(.hidden)').waitFor();
};

async function addCode(p, slug, title) {
  await openMenu(p);
  await p.click('#pageMenu [data-action=new-code]');
  await p.locator('#ncSlug').waitFor();
  await p.fill('#ncSlug', slug);
  await p.fill('#ncTitle', title);
  // Neu laden abwarten (die Adresse kann schon vorher auf ?site=…#code stehen)
  await Promise.all([p.waitForNavigation(), p.click('#ncCreate')]);
  ok(/\/dashboard\?site=\d+#code$/.test(p.url()), 'Opens /dashboard?site=ID#code (' + slug + ')');
  await p.locator('#tab-code #codeEditor').waitFor();
}

(async () => {
  reset();
  const server = await startServer();
  const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1, MAP *.${HOST} 127.0.0.1`] });
  const errors = [];
  const dialogs = [];
  try {
    const p = await login(browser, 'lea@test.de');
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
    await p.goto(BASE + '/dashboard', { waitUntil: 'networkidle' });

    await openMenu(p);
    const add = p.locator('#pageMenu [data-action=new-code]');
    ok(await add.count() === 1 && (await add.innerText()).includes('0 of 2 code pages'), 'Your pages offers “Add a code page” with the free code page slots');
    await p.keyboard.press('Escape');
    await p.click('body', { position: { x: 5, y: 890 } });

    // Erste Code-Seite: eigene Adresse
    await addCode(p, 'lea-lab', 'Lea <i>Lab</i>');
    ok((await p.locator('#codeUrl').innerText()).includes('lea-lab.'), 'The new code page opens in the Code tab at its subdomain');
    const lab = Number(sql("SELECT id FROM code_sites WHERE user_id = 7 AND slug = 'lea-lab'"));
    ok(lab > 0, 'Code page with its own address created');

    // Zweite Code-Seite (More code pages): eine neue Seite, die die Code-Seite zeigt
    await openMenu(p);
    ok((await p.locator(`#pageMenu [data-open-site="${lab}"]`).innerText()).includes('Lea <i>Lab</i>'), 'The code page is listed, its name as text');
    ok(await p.locator('#pageMenu i:has-text("Lab")').count() === 0, 'No HTML from the name');
    ok((await add.innerText()).includes('1 of 2 code pages'), 'One more code page slot is free');
    await p.click('body', { position: { x: 5, y: 890 } });
    await addCode(p, 'lea-extra', 'Extra');
    const extra = Number(sql("SELECT IFNULL(MAX(code_site_id), 0) FROM pages WHERE user_id = 7 AND slug = 'lea-extra'"));
    ok(extra > 0 && sql(`SELECT title FROM code_sites WHERE id = ${extra} AND slug IS NULL`) === 'Extra', 'The extra code page lives on a new page slot');
    ok((await p.locator('#codeUrl').innerText()).includes('lea-extra.'), 'The extra code page opens in the Code tab');

    // Beide im Wechsler, keine freien Code-Plätze mehr
    await openMenu(p);
    ok(await p.locator('#pageMenu [data-open-site]').count() === 2, 'Both code pages are listed');
    ok(await add.count() === 0 && (await p.locator('#pageMenu').innerText()).includes('2 of 2 code pages'), 'No more free code page slots');
    ok(await p.locator(`#pageMenu [data-open-site="${extra}"].current`).count() === 1, 'The open code page is marked');

    // Wechseln zur ersten Code-Seite
    await Promise.all([p.waitForURL(new RegExp('site=' + lab + '#code$')), p.click(`#pageMenu [data-open-site="${lab}"]`)]);
    await p.locator('#tab-code #codeEditor').waitFor();
    ok((await p.locator('#codeUrl').innerText()).includes('lea-lab.'), 'Switching opens the other code page');

    // Die zweite löschen: Adresse tippen im Dialog der Seite
    await openMenu(p);
    await p.click(`#pageMenu [data-del-site="${extra}"]`);
    await p.locator('.ui-dialog').waitFor();
    ok((await p.locator('.ui-dialog .ui-title').textContent()) === 'Delete code page “lea-extra”?', 'Delete dialog of the site');
    const okBtn = p.locator('.ui-dialog .ui-foot .ui-btn', { hasText: 'Delete code page' });
    ok(await okBtn.isDisabled(), 'Delete is disabled until the address is typed');
    await p.type('.ui-dialog .ui-input', 'lea-extra');
    await Promise.all([p.waitForNavigation(), okBtn.click()]);
    await p.locator('#tab-code #codeEditor').waitFor();
    ok(sql(`SELECT COUNT(*) FROM code_sites WHERE id = ${extra}`) === '0', 'The extra code page is deleted');
    ok(sql("SELECT IFNULL(code_site_id, 'null') FROM pages WHERE user_id = 7 AND slug = 'lea-extra'") === 'null', 'Its page shows its link page again');
    await openMenu(p);
    ok((await add.innerText()).includes('1 of 2 code pages'), 'The code page slot is free again');

    // Edit: die Seite lea-extra wird wieder eine Code-Seite, dann zurück zur Link-Seite (Code-Seite löschen)
    const slot = Number(sql("SELECT id FROM pages WHERE user_id = 7 AND slug = 'lea-extra'"));
    await p.click(`#pageMenu [data-edit-page="${slot}"]`);
    await p.locator('#edSlug').waitFor();
    ok((await p.inputValue('#edSlug')) === 'lea-extra', 'Edit shows the address of the page');
    await p.check('input[name=edType][value=code]');
    await p.selectOption('#edWhich', 'new');
    await Promise.all([p.waitForNavigation(), p.click('#edSave')]);
    const onSlot = Number(sql(`SELECT IFNULL(code_site_id, 0) FROM pages WHERE id = ${slot}`));
    ok(onSlot > 0 && new RegExp('site=' + onSlot + '#code$').test(p.url()), 'Edit → Code page puts a new code page on the slot and opens it');
    await p.locator('#tab-code #codeEditor').waitFor();
    await openMenu(p);
    await p.click(`#pageMenu [data-edit-site="${onSlot}"]`);
    await p.locator('#edSlug').waitFor();
    ok(await p.locator('input[name=edType][value=code]').isChecked(), 'Edit knows the page shows a code page');
    await p.check('input[name=edType][value=link]');
    await p.locator('#edConfirm').waitFor();
    await p.click('#edSave');
    await p.locator('#edErr:not(.hidden)').waitFor();
    ok((await p.locator('#edErr').innerText()) === 'To confirm, please type the address of the code page.', 'Without the typed address nothing is deleted');
    await p.fill('#edConfirm', 'lea-extra');
    await Promise.all([p.waitForNavigation(), p.click('#edSave')]);
    ok(sql(`SELECT COUNT(*) FROM code_sites WHERE id = ${onSlot}`) === '0' && sql(`SELECT IFNULL(code_site_id, 'null') FROM pages WHERE id = ${slot}`) === 'null', 'Edit → Link page shows the link page again');
    ok(new RegExp('page=' + slot + '(#|$)').test(p.url()), 'The editor opens the link page (' + p.url() + ')');

    // Edit: Adresse der Code-Seite mit eigener Adresse ändern
    await openMenu(p);
    await p.click(`#pageMenu [data-edit-site="${lab}"]`);
    await p.locator('#edSlug').waitFor();
    ok(await p.locator('input[name=edType]').count() === 0, 'The own-address code page has no type choice');
    await p.fill('#edSlug', 'lea-lab-two');
    await Promise.all([p.waitForNavigation(), p.click('#edSave')]);
    ok(sql(`SELECT slug FROM code_sites WHERE id = ${lab}`) === 'lea-lab-two', 'Edit changes the address of the code page');

    // Subdomain: eigener Abschnitt für die Code-Seite (Code-Tab) und für die Link-Seite (Settings)
    await p.goto(BASE + '/dashboard?site=' + lab + '#code', { waitUntil: 'networkidle' });
    await p.locator('#tab-code #codeSubdomain').waitFor();
    ok((await p.locator('#codeSubdomain h3').innerText()).trim() === 'Subdomain' && (await p.inputValue('#codeSlugEdit')) === 'lea-lab-two', 'The code page has a Subdomain section with its name');
    await p.goto(BASE + '/dashboard?page=' + slot + '#settings', { waitUntil: 'networkidle' });
    await p.locator('#subdomainSection').waitFor();
    ok((await p.locator('#subdomainSection .section-title').innerText()).startsWith('Subdomain') && (await p.inputValue('#slugInput')) === 'lea-extra', 'The link page has a Subdomain section with its name');

    ok(errors.length === 0, 'No script errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
    ok(dialogs.length === 0, 'No browser dialogs');
  } catch (err) {
    console.error(err);
    failed++;
  } finally {
    await browser.close();
    server.kill();
    reset();
    sql("DELETE FROM honeycomb_ledger WHERE user_id = 7 AND reason = 'unlock' AND note = 'e2e'");
  }
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
