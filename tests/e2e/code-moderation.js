// E2E: Moderation der Code-Seiten im Admin (CS-5): Quelltext ansehen (nur als Text), Löschen mit getippter Adresse und
// Grund, Code-Seiten für ein Konto aus- und wieder einschalten, das Protokoll. Der Besitzer sieht den Hinweis im Editor.
//
// Start (Datenbank muss laufen):
//   node tests/e2e/code-moderation.js
// Umgebung: OYS_E2E_PORT (Vorgabe 14204), OYS_CONFIG (Vorgabe config.json im Projekt), OYS_E2E_PASSWORD, OYS_E2E_SHOTS.
// Läuft nur gegen eine Datenbank, deren Name mit oys_test beginnt (sonst Abbruch mit Code 2). Code-Seiten, Buchungen,
// Protokoll und Hinweise der Testkonten mia (5) und tom (6) werden am Anfang angelegt und am Ende entfernt, die Sperre
// des Kontos wird zurückgesetzt.
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

// Code-Seiten, Buchungen, Protokoll und Hinweise der Testkonten entfernen (vor dem Test und danach)
let ledgerStart = 0;
let noteStart = 0;
const clean = () => {
  sql(`DELETE FROM code_files WHERE site_id IN (SELECT id FROM code_sites WHERE user_id IN (5, 6));
    DELETE FROM code_sites WHERE user_id IN (5, 6);
    DELETE FROM honeycomb_ledger WHERE user_id IN (5, 6) OR id > ${ledgerStart};
    DELETE FROM notifications WHERE user_id IN (5, 6) AND id > ${noteStart};
    UPDATE users SET code_banned_at = NULL, code_ban_reason = NULL WHERE id IN (5, 6);`);
  if (sql("SHOW TABLES LIKE 'code\\_moderation'") !== '') sql('DELETE FROM code_moderation WHERE user_id IN (5, 6)');
  if (sql("SHOW TABLES LIKE 'hc\\_entitlements'") !== '') {
    sql('DELETE FROM hc_entitlements WHERE user_id IN (5, 6); DELETE FROM hc_accounts WHERE user_id IN (5, 6);');
  }
};

function seed() {
  ledgerStart = Number(sql('SELECT COALESCE(MAX(id), 0) FROM honeycomb_ledger'));
  noteStart = Number(sql('SELECT COALESCE(MAX(id), 0) FROM notifications'));
  clean();
  sql(`INSERT INTO honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES
      (5, 0, 'unlock', 'code_page', 'Unlocked by the team', NOW()), (6, 0, 'unlock', 'code_page', 'Unlocked by the team', NOW());
    INSERT INTO code_sites (user_id, slug, title, is_published, is_blocked, views, created_at, updated_at) VALUES
      (5, 'miacode', 'Mia Code', 1, 0, 12, NOW(), NOW()), (6, 'tomcode', 'Tom Code', 1, 0, 3, NOW(), NOW());
    INSERT INTO code_files (site_id, path, content, updated_at) SELECT id, 'index.html', '<p>Hello</p><script>window.ran = 1</script>', NOW() FROM code_sites WHERE user_id IN (5, 6);
    INSERT INTO code_files (site_id, path, content, updated_at) SELECT id, 'style.css', 'body { color: red }', NOW() FROM code_sites WHERE user_id = 5;
    UPDATE code_sites s SET file_count = (SELECT COUNT(*) FROM code_files f WHERE f.site_id = s.id), bytes = (SELECT COALESCE(SUM(LENGTH(f.content)), 0) FROM code_files f WHERE f.site_id = s.id) WHERE user_id IN (5, 6);`);
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

const login = async (p, email) => {
  await p.goto(BASE + '/login');
  await p.fill('input[name=email]', email);
  await p.fill('input[name=password]', PASSWORD);
  await Promise.all([p.waitForNavigation(), p.click('button[type=submit]')]);
};

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
    p.on('dialog', (d) => { errors.push('native ' + d.type() + ': ' + d.message()); d.dismiss().catch(() => {}); });
    await login(p, 'admin@test.de');
    await p.goto(BASE + '/admin#code-pages', { waitUntil: 'networkidle' });

    // Quelltext ansehen: als Text, nichts läuft
    const miaId = sql("SELECT id FROM code_sites WHERE slug = 'miacode'");
    const tomId = sql("SELECT id FROM code_sites WHERE slug = 'tomcode'");
    await Promise.all([p.waitForNavigation(), p.click(`#tab-code-pages a[href="/admin?code_site=${miaId}#code-pages"]`)]);
    const pre = p.locator('#codeViewer pre');
    ok(await p.locator('#codeViewer').isVisible() && (await pre.innerText()).includes('<script>window.ran = 1</script>'), 'Viewer shows index.html as text');
    ok(await p.evaluate(() => window.ran === undefined) && await p.locator('#codeViewer script').count() === 0, 'Viewer runs nothing');
    await Promise.all([p.waitForNavigation(), p.click('#codeViewer nav a:has-text("style.css")')]);
    ok((await pre.innerText()).includes('body { color: red }'), 'Viewer switches to another file');
    await shot(p, 'code-moderation-viewer');
    await Promise.all([p.waitForNavigation(), p.click('#codeViewer a:has-text("Close")')]);
    ok(await p.locator('#codeViewer').count() === 0 && await p.locator('#tab-code-pages').isVisible(), 'Viewer closes back to the list');

    // Löschen: Grund im Formular, Adresse im eigenen Dialog tippen
    const del = p.locator(`#tab-code-pages form:has(input[name=code_action][value=delete]):has(input[name=site_id][value="${tomId}"])`);
    await del.locator('input[name=reason]').fill('Copyright');
    await del.locator('button[type=submit]').click();
    await p.waitForSelector('.ui-dialog');
    dialogs.push((await p.locator('.ui-dialog .ui-title').innerText()).trim());
    ok(dialogs.includes('Delete “tomcode”?'), 'Delete asks first (own dialog)');
    const okBtn = p.locator('.ui-dialog .ui-foot .ui-btn:not(.is-ghost)');
    await p.fill('.ui-dialog .ui-input', 'tomcod');
    await okBtn.click({ force: true });
    await p.waitForTimeout(300);
    ok(await p.locator('.ui-dialog').count() === 1 && sql(`SELECT COUNT(*) FROM code_sites WHERE id = ${tomId}`) === '1', 'A wrong address deletes nothing');
    await p.fill('.ui-dialog .ui-input', 'tomcode');
    await Promise.all([p.waitForNavigation(), okBtn.click()]);
    ok((await flash(p)).includes('“tomcode” was deleted.'), 'Flash after deleting');
    ok(sql(`SELECT COUNT(*) FROM code_sites WHERE id = ${tomId}`) === '0', 'Code page deleted');
    ok(sql(`SELECT body FROM notifications WHERE user_id = 6 AND id > ${noteStart} ORDER BY id DESC LIMIT 1`) === 'tomcode: Copyright', 'Owner gets the reason');

    // Code-Seiten für Mia ausschalten: „Block their code pages“ ist vorgewählt
    const ban = p.locator('#tab-code-pages form:has(input[name=code_action][value=ban]):has(input[name=user_id][value="5"])');
    ok(await ban.locator('input[name=block_all]').isChecked(), '“Block their code pages” is checked by default');
    await ban.locator('input[name=reason]').fill('Spam');
    await ban.locator('button[type=submit]').click();
    await Promise.all([p.waitForNavigation(), confirmUi(p, dialogs)]);
    ok(dialogs.includes('Turn code pages off for Mia Müller?'), 'Turning code pages off asks first');
    ok((await flash(p)).includes('can no longer create or change code pages. 1 code page blocked.'), 'Flash after turning code pages off');
    ok(sql("SELECT CONCAT(u.code_ban_reason, '|', s.is_blocked) FROM users u JOIN code_sites s ON s.user_id = u.id WHERE u.id = 5") === 'Spam|1', 'Account turned off and its page blocked');

    // Mia sieht den Hinweis im Editor
    const mctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const m = await mctx.newPage();
    m.on('pageerror', (e) => errors.push('mia: ' + e.message));
    m.on('dialog', (d) => { errors.push('native ' + d.type() + ': ' + d.message()); d.dismiss().catch(() => {}); });
    await login(m, 'mia@test.de');
    // Eigene Abfrage, damit nicht nur der Hash wechselt (sonst lädt die Seite nicht neu)
    await m.goto(BASE + '/dashboard?load=1#code', { waitUntil: 'networkidle' });
    await m.waitForSelector('#codeBanned', { timeout: 10000 }).catch(() => {});
    ok(await m.locator('#codeBanned').isVisible() && (await m.locator('#codeBanned').innerText()).includes('Spam'), 'Owner sees that code pages are off, with the reason');
    await shot(m, 'code-moderation-banned');
    await mctx.close();

    // Wieder einschalten: die gesperrte Seite bleibt gesperrt
    const unban = p.locator('#tab-code-pages form:has(input[name=code_action][value=unban]):has(input[name=user_id][value="5"])');
    await unban.locator('button[type=submit]').click();
    await Promise.all([p.waitForNavigation(), confirmUi(p, dialogs)]);
    ok((await flash(p)).includes('can use code pages again. 1 code page stays blocked'), 'Flash after turning code pages on names the blocked page');
    ok(sql("SELECT CONCAT(COALESCE(u.code_banned_at, '-'), '|', s.is_blocked) FROM users u JOIN code_sites s ON s.user_id = u.id WHERE u.id = 5") === '-|1', 'Account on again, page still blocked');

    // Protokoll
    const log = await p.locator('#codeLog').innerText();
    ok(/unban/.test(log) && /ban · mia@test\.de · Spam/.test(log) && /delete · tomcode · tom@test\.de · Copyright/.test(log), 'Moderation log lists delete, ban and unban');

    // „More code pages“ ohne Honigwaben über das Formular
    await p.selectOption('#codeItem', 'code_more');
    await p.selectOption('#codeUser', '5');
    await p.click('#codeAccessForm button[type=submit]');
    await Promise.all([p.waitForNavigation(), confirmUi(p, dialogs)]);
    ok((await flash(p)).includes('More code pages unlocked for Mia Müller.'), 'More code pages unlocked from the form');
    ok(sql("SELECT COUNT(*) FROM code_moderation WHERE user_id = 5 AND action = 'unlock' AND reason = 'code_more'") === '1', 'More code pages is logged');

    await p.setViewportSize({ width: 390, height: 844 });
    await p.goto(BASE + '/admin#code-pages', { waitUntil: 'networkidle' });
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(overflow <= 0, 'Phone width: no horizontal page scroll (' + overflow + ')');

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
