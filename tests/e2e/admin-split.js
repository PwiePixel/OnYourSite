// E2E: Admin getrennt in „Honeycombs“ und „Code pages“ (code-slots-admin, Ablauf 5): zwei Einträge in der Navigation,
// #honeycombs ohne Code-Seiten, #code-pages als direkter Link, Meldungen nach den Aktionen, alte Lesezeichen und alte
// Formulare (hc_action=code_*) funktionieren weiter.
//
// Start (Datenbank muss laufen, z. B. über oys-db.sh run):
//   node tests/e2e/admin-split.js
// Umgebung: OYS_E2E_PORT (Port des Node-Servers, Vorgabe 14204), OYS_CONFIG (Vorgabe config.json im Projekt),
// OYS_E2E_PASSWORD (Passwort der Test-Konten), OYS_E2E_SHOTS (Ordner für Bildschirmfotos, optional).
// Der Test schreibt nur in die Datenbank aus der Konfiguration und läuft nur, wenn deren Name mit oys_test beginnt
// (sonst Abbruch mit Code 2, bevor er die Datenbank aufruft): Code-Seiten und Honigwaben-Buchungen der Testkonten
// mia (5), tom (6) und lea (7) werden am Anfang angelegt und am Ende wieder entfernt (Ausgangsstand: keine), ebenso
// jede Buchung, die während des Laufs entsteht (z. B. die Tagesbelohnung beim Anmelden).
const { chromium } = require('playwright');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.OYS_E2E_PORT || 14204);
const CONFIG = process.env.OYS_CONFIG || path.join(ROOT, 'config.json');
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
// Nur gegen eine Test-Datenbank (Name beginnt mit oys_test): der Ablauf löscht Code-Seiten und Buchungen
const DB_NAME = String((cfg.db && cfg.db.name) || '');
if (!DB_NAME.startsWith('oys_test')) {
  console.error(`Refusing to run: ${CONFIG} uses the database "${DB_NAME}", which is not a test database (oys_test…).`);
  process.exit(2);
}
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

// Code-Seiten und Buchungen der Testkonten entfernen (vor dem Test und danach) und alle Buchungen seit dem Start
let ledgerStart = 0;
const clean = () => {
  sql(`DELETE FROM code_files WHERE site_id IN (SELECT id FROM code_sites WHERE user_id IN (5, 6, 7));
    DELETE FROM code_sites WHERE user_id IN (5, 6, 7);
    DELETE FROM honeycomb_ledger WHERE user_id IN (5, 6, 7) OR id > ${ledgerStart};`);
  // Berechtigungen des Shops (die Tabellen legt erst der Server beim ersten Start an)
  if (sql("SHOW TABLES LIKE 'hc\\_entitlements'") !== '') {
    sql('DELETE FROM hc_entitlements WHERE user_id IN (5, 6, 7); DELETE FROM hc_accounts WHERE user_id IN (5, 6, 7);');
  }
};

function seed() {
  ledgerStart = Number(sql('SELECT COALESCE(MAX(id), 0) FROM honeycomb_ledger'));
  clean();
  sql(`INSERT INTO honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES
      (5, 120, 'admin', 'a3-e2e0000000000001', 'Welcome', NOW()), (5, -100, 'unlock', 'code_page', '', NOW()),
      (6, 0, 'unlock', 'code_page', 'Unlocked by the team', NOW());
    INSERT INTO code_sites (user_id, slug, title, is_published, is_blocked, views, created_at, updated_at) VALUES
      (5, 'miacode', 'Mia Code', 1, 0, 12, NOW(), NOW()), (6, 'tomcode', 'Tom Code', 1, 0, 3, NOW() - INTERVAL 1 DAY, NOW() - INTERVAL 1 DAY);
    INSERT INTO code_files (site_id, path, content, updated_at) SELECT id, 'index.html', '<p>Hello</p>', NOW() FROM code_sites WHERE user_id IN (5, 6);`);
}

// Meldungen: ui.js macht aus den Bannern Toasts (ohne ui.js bleiben die Banner)
const flash = async (p) => (await p.locator('.animate-fade-in, .ui-toast').first().innerText()).trim();
// Eigener Bestätigungsdialog (ui.js): Titel merken und mit OK bestätigen
const confirmUi = async (p, titles) => {
  await p.waitForSelector('.ui-dialog');
  titles.push((await p.locator('.ui-dialog .ui-title').innerText()).trim());
  await p.click('.ui-dialog .ui-foot .ui-btn:not(.is-ghost)');
};
const shot = async (p, name) => SHOTS && p.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false });

(async () => {
  seed();
  const server = await startServer();
  const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1, MAP *.${HOST} 127.0.0.1`] });
  const errors = [];
  const dialogs = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const p = await context.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    // Jeder native Dialog (alert/confirm/prompt) ist ein Fehler – die Formulare fragen mit den eigenen Dialogen nach
    p.on('dialog', (d) => { errors.push('native ' + d.type() + ': ' + d.message()); d.dismiss().catch(() => {}); });

    await p.goto(BASE + '/login');
    await p.fill('input[name=email]', 'admin@test.de');
    await p.fill('input[name=password]', PASSWORD);
    await Promise.all([p.waitForNavigation(), p.click('button[type=submit]')]);
    await p.goto(BASE + '/admin', { waitUntil: 'networkidle' });

    // Installierte Version unten im Menü (Datei VERSION)
    const version = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
    const versionLine = p.locator('aside p[title^="Installed version"]');
    ok(await versionLine.isVisible(), 'the admin menu shows the installed version');
    ok((await versionLine.innerText()).trim() === 'OnYourSite v' + version, 'the version line reads "OnYourSite v' + version + '"');

    // Zwei Einträge in der Navigation
    const hcNav = p.locator('#nav-honeycombs');
    const codeNav = p.locator('#nav-code-pages');
    ok((await hcNav.innerText()).trim() === 'Honeycombs' && (await codeNav.innerText()).trim() === 'Code pages', 'Two nav entries: Honeycombs and Code pages');
    ok(await codeNav.locator('i.bx-code-alt').count() === 1 && await hcNav.locator('i.bx-hive').count() === 1, 'Nav icons: hive and code');

    // Honeycombs: keine Code-Seiten mehr
    await hcNav.click();
    ok(await p.locator('#tab-honeycombs').isVisible() && !(await p.locator('#tab-code-pages').isVisible()), 'Honeycombs section opens');
    ok((await p.locator('#admin-page-title').innerText()).trim() === 'Honeycombs' && p.url().endsWith('#honeycombs'), 'Title and hash: Honeycombs');
    const hcText = await p.locator('#tab-honeycombs').innerText();
    const heads = await p.locator('#tab-honeycombs thead th').allInnerTexts();
    ok(!hcText.includes('miacode') && !hcText.includes('Unlock for free') && !heads.some((h) => /code page/i.test(h))
      && await p.locator('#tab-honeycombs [name=code_action], #tab-honeycombs [value^=code_]').count() === 0, '#honeycombs shows no code list and no code page column');
    ok(hcText.includes('Latest activity') && hcText.includes('In circulation'), 'Honeycombs opens with its overview');
    // Vergeben und Kontostände stehen im Unterbereich „Users“
    await Promise.all([p.waitForNavigation(), p.click('#hcTabs a[href="/admin?hc_tab=users#honeycombs"]')]);
    const usersText = await p.locator('#tab-honeycombs').innerText();
    ok(await p.locator('#tab-honeycombs').isVisible() && usersText.includes('Give honeycombs') && usersText.includes('Balances'), 'Honeycombs keeps its cards under Users');
    await shot(p, 'admin-honeycombs');

    // Code pages
    await codeNav.click();
    ok(await p.locator('#tab-code-pages').isVisible() && !(await p.locator('#tab-honeycombs').isVisible()), 'Code pages section opens');
    ok((await p.locator('#admin-page-title').innerText()).trim() === 'Code pages' && p.url().endsWith('#code-pages'), 'Title and hash: Code pages');
    const codeText = await p.locator('#tab-code-pages').innerText();
    ok(codeText.includes('miacode.') && codeText.includes('tomcode.') && codeText.includes('Give code access') && codeText.includes('Access'), 'Code pages: list, access card and access table');
    ok(/Paid 100/i.test(codeText) && /\bFree\b/i.test(codeText), 'Access shows paid and free unlocks');
    await shot(p, 'admin-code-pages');

    // Direkter Link
    await p.goto(BASE + '/admin#code-pages', { waitUntil: 'networkidle' });
    ok(await p.locator('#tab-code-pages').isVisible() && await p.locator('#nav-code-pages.shadow-inner').count() === 1, '#code-pages deep link opens the section and marks the nav entry');

    // Sperren mit Grund → Meldung im Bereich Code pages
    const mia = p.locator('#tab-code-pages form:has(input[name=site_id])').filter({ has: p.locator('input[name=reason]') }).first();
    await mia.locator('input[name=reason]').fill('Phishing');
    await mia.locator('button[type=submit]').click();
    await Promise.all([p.waitForNavigation(), confirmUi(p, dialogs)]);
    ok(dialogs.includes('Block this code page?'), 'Block asks first (own dialog)');
    ok(p.url().endsWith('/admin#code-pages') && await p.locator('#tab-code-pages').isVisible(), 'After the action: back on #code-pages');
    ok((await flash(p)).includes('is blocked.'), 'Flash after blocking');
    ok(sql("SELECT CONCAT(is_blocked, '|', blocked_reason) FROM code_sites WHERE slug = 'miacode'") === '1|Phishing', 'Blocked with the reason');

    const unblock = p.locator('#tab-code-pages form:has(input[name=code_action][value=unblock])').first();
    // Auch „Unblock“ fragt zuerst (CS-5: jedes Formular der Moderation)
    await unblock.locator('button[type=submit]').click();
    await Promise.all([p.waitForNavigation(), confirmUi(p, dialogs)]);
    ok(dialogs.includes('Unblock this code page?'), 'Unblock asks first (own dialog)');
    ok((await flash(p)).includes('is online again.') && sql("SELECT is_blocked FROM code_sites WHERE slug = 'miacode'") === '0', 'Unblock with flash');

    // Code-Zugang ohne Honigwaben
    await p.selectOption('#codeUser', '7');
    await p.click('#codeAccessForm button[type=submit]');
    await Promise.all([p.waitForNavigation(), confirmUi(p, dialogs)]);
    ok(dialogs.includes('Unlock for free?'), 'Give code access asks first (own dialog)');
    ok((await flash(p)).includes('Code page unlocked for Lea.'), 'Give code access: flash');
    ok(sql("SELECT CONCAT(amount, '|', note) FROM honeycomb_ledger WHERE user_id = 7 AND reason = 'unlock' AND ref = 'code_page'") === '0|Unlocked by the team', 'Give code access: free unlock booked');
    ok((await p.locator('#codeAccessRows').innerText()).includes('lea@test.de'), 'Access table lists the new unlock');
    await p.fill('#codeAccessFilter', 'mia');
    const visibleRows = await p.locator('#codeAccessRows tr:visible').count();
    ok(visibleRows === 1 && (await p.locator('#codeAccessRows tr:visible').innerText()).includes('mia@test.de'), 'Access search filters the rows');

    // Preis: Link zu „Catalogue & prices“ im Bereich Honeycombs
    await Promise.all([p.waitForNavigation(), p.click('#tab-code-pages a[href="/admin?hc_tab=catalogue#honeycombs"]')]);
    ok(await p.locator('#tab-honeycombs').isVisible() && await p.locator('#tab-honeycombs form[data-item="code_page"] [name=price]').isVisible(), 'Prices link opens Honeycombs with the price field');

    // Altes Lesezeichen
    await p.goto(BASE + '/admin#honeycombs', { waitUntil: 'networkidle' });
    ok(await p.locator('#tab-honeycombs').isVisible() && !(await p.locator('#tab-honeycombs').innerText()).includes('tomcode'), 'Old bookmark /admin#honeycombs opens Honeycombs');

    // Altes Formular aus einem Tab von vor dem Update
    const csrf = await p.locator('input[name=csrf]').first().inputValue();
    const tomId = sql("SELECT id FROM code_sites WHERE slug = 'tomcode'");
    await Promise.all([p.waitForNavigation(), p.evaluate(([token, id]) => {
      const f = document.createElement('form');
      f.method = 'POST';
      f.action = '/admin';
      for (const [k, v] of [['csrf', token], ['hc_action', 'code_block'], ['site_id', id], ['reason', 'Old tab']]) {
        const i = document.createElement('input');
        i.type = 'hidden'; i.name = k; i.value = v; f.appendChild(i);
      }
      document.body.appendChild(f);
      f.submit();
    }, [csrf, tomId])]);
    ok(p.url().endsWith('/admin#code-pages') && (await flash(p)).includes('“tomcode” is blocked.'), 'Old form hc_action=code_block still works and lands on #code-pages');
    ok(sql("SELECT CONCAT(is_blocked, '|', blocked_reason) FROM code_sites WHERE slug = 'tomcode'") === '1|Old tab', 'Old form: blocked');

    // Schmal (Handy): beide Einträge sichtbar, keine waagrechte Verschiebung der Seite
    await p.setViewportSize({ width: 390, height: 844 });
    await p.goto(BASE + '/admin#code-pages', { waitUntil: 'networkidle' });
    ok(await hcNav.isVisible() && await codeNav.isVisible(), 'Phone width: both nav entries visible');
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(overflow <= 0, 'Phone width: no horizontal page scroll (' + overflow + ')');
    await shot(p, 'admin-code-pages-phone');

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
