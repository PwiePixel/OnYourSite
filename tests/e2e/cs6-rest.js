// E2E: der Rest von CS-6 mit Lea (id 7, Code-Seiten freigeschaltet). „Create a new page“ mit der Karte „Code page“
// legt eine Code-Seite auf einem neuen Platz an; der Code-Tab zeigt „Where it lives“ mit „Download files“ (JSON mit
// allen Dateien, auch ungespeicherten), „Show link page again“ (die Code-Seite zieht an eine eigene Adresse) und
// „Move to one of your pages“ (zurück auf den Platz). Dann zeigt jeder Platz eine Code-Seite (U13): die Startbox sagt
// das, die Einstellungen zeigen nur, was zum Konto gehört, und die Karte „Code page“ ist mit dem Grund gesperrt. Der
// Lösch-Dialog bietet „Download files“. Kein Browser-Dialog (alert/confirm/prompt) darf erscheinen.
//
// Start (Datenbank muss laufen, Test-Datenbank aus npm run test:seed):
//   OYS_E2E_PORT=14261 node tests/e2e/cs6-rest.js
// Nur gegen eine Test-Datenbank (Name beginnt mit oys_test; sonst Abbruch mit Code 2, bevor er die Datenbank aufruft).
// Der Test setzt Code-Seiten, Seiten (außer der ersten) und die Freischaltung von Lea vorher und nachher zurück.
const { chromium } = require('playwright');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.OYS_E2E_PORT || 14261);
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
    DELETE FROM pages WHERE user_id = 7 AND slug <> 'lea';
    DELETE FROM site_addresses WHERE slug IN ('lea-studio', 'lea-own', 'lea-second', 'lea-first', 'lea-studio2');
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

    // Kostet „More code pages“ etwas, sperrt schon die erste Code-Seite – auch eine, die eben im Code-Tab entstand
    // (ohne neu zu laden: die Übersicht folgt der Antwort der Code-API)
    const morePrice = sql("SELECT IFNULL(MAX(price), -1) FROM hc_items WHERE item_key = 'code_more'");
    ok(morePrice !== '-1', 'The shop has the item More code pages');
    sql("UPDATE hc_items SET price = 40 WHERE item_key = 'code_more'");
    try {
      await p.goto('about:blank');
      await p.goto(BASE + '/dashboard#code', { waitUntil: 'networkidle' });
      await p.locator('#codeSlug').waitFor();
      await p.fill('#codeSlug', 'lea-first');
      await p.click('[data-code=create]');
      await p.locator('#tab-code #codeEditor').waitFor();
      await openMenu(p);
      await p.click('#pageMenu [data-action=new-page]');
      await p.locator('#npSlug').waitFor();
      ok(await p.locator('[data-np-kind=code]').getAttribute('aria-disabled') === 'true' && (await p.locator('#npWhy-code').innerText()).includes('More code pages'), 'After the first code page, the Code page card needs More code pages');
      await p.keyboard.press('Escape');
    } finally {
      sql(`UPDATE hc_items SET price = ${Number(morePrice) < 0 ? 0 : Number(morePrice)} WHERE item_key = 'code_more'`);
      sql("DELETE FROM code_files WHERE site_id IN (SELECT id FROM code_sites WHERE user_id = 7); DELETE FROM code_sites WHERE user_id = 7; DELETE FROM site_addresses WHERE slug = 'lea-first';");
    }
    await p.goto('about:blank');
    await p.goto(BASE + '/dashboard', { waitUntil: 'networkidle' });

    // „Create a new page“: zwei Karten, Link-Seite vorgewählt; die Code-Karte legt die Seite als Code-Seite an
    await openMenu(p);
    await p.click('#pageMenu [data-action=new-page]');
    await p.locator('#npSlug').waitFor();
    const linkCard = p.locator('[data-np-kind=link]'), codeCard = p.locator('[data-np-kind=code]');
    ok(await linkCard.getAttribute('aria-checked') === 'true' && await codeCard.getAttribute('aria-disabled') === null, 'New page: Link page is chosen, Code page can be chosen');
    // Tastatur wie bei Radioknöpfen: Pfeil nach rechts wählt die Code-Karte, nach links wieder die Link-Karte
    await linkCard.focus();
    await p.keyboard.press('ArrowRight');
    ok(await codeCard.getAttribute('aria-checked') === 'true' && await p.evaluate(() => document.activeElement.dataset.npKind) === 'code', 'Arrow keys choose and focus the Code page card');
    await p.keyboard.press('ArrowLeft');
    ok(await linkCard.getAttribute('aria-checked') === 'true', 'Arrow keys go back to the Link page card');
    await codeCard.click();
    ok(await codeCard.getAttribute('aria-checked') === 'true', 'The Code page card is chosen');
    await p.fill('#npSlug', 'lea-studio');
    await p.fill('#npTitle', 'Studio');
    await Promise.all([p.waitForNavigation(), p.click('#npCreate')]);
    const studio = Number(sql("SELECT IFNULL(MAX(code_site_id), 0) FROM pages WHERE user_id = 7 AND slug = 'lea-studio'"));
    ok(studio > 0 && new RegExp('site=' + studio + '#code$').test(p.url()), 'Create page → Code page puts a code page on a new page slot and opens it');
    await p.locator('#tab-code #codeEditor').waitFor();

    // Where it lives: auf einer Seitenadresse
    const where = p.locator('#codeWhere');
    ok((await where.innerText()).includes('It replaces the link page of lea-studio.'), 'Where it lives names the page address');
    ok(await where.getByRole('button', { name: 'Show link page again' }).count() === 1, 'Show link page again is offered');

    // Download files: mit ungespeicherter Änderung, das sagt der Hinweis
    // Inhalt im Editor setzen – CodeMirror oder das einfache Textfeld (falls CodeMirror nicht geladen ist)
    const setCode = (text) => p.evaluate((text) => {
      const cm = document.querySelector('.CodeMirror');
      if (cm && cm.CodeMirror) { const old = cm.CodeMirror.getValue(); cm.CodeMirror.setValue(text); return old; }
      const t = document.querySelector('#codeEditor textarea');
      const old = t.value;
      t.value = text;
      t.dispatchEvent(new Event('input', { bubbles: true }));
      return old;
    }, text);
    const original = await setCode('<p>unsaved</p>');
    const [dl] = await Promise.all([p.waitForEvent('download'), where.getByRole('button', { name: 'Download files' }).click()]);
    const file = await dl.path();
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    ok(/^lea-studio-code-\d{4}-\d{2}-\d{2}\.json$/.test(dl.suggestedFilename()), 'The download is named after the address and the day (' + dl.suggestedFilename() + ')');
    ok(data.address.startsWith('lea-studio.') && data.files['index.html'] === '<p>unsaved</p>' && /Z$/.test(data.exported), 'The file holds the address, the time and every file with the unsaved change');
    await p.getByText('Files downloaded – with the changes you haven’t saved yet.').waitFor();
    // Die Änderung zurücknehmen: wieder wie gespeichert, der Editor fragt beim Verlassen nicht
    await setCode(original);

    // Show link page again → Edit mit „Link page“ vorgewählt; die Code-Seite zieht an eine eigene Adresse
    await where.getByRole('button', { name: 'Show link page again' }).click();
    await p.locator('#edOwnSlug').waitFor();
    ok(await p.locator('input[name=edType][value=link]').isChecked(), 'Show link page again opens Edit with Link page chosen');
    ok(await p.locator('#edMore [data-code-download]').count() === 1, 'The dialog offers Download files');
    await p.fill('#edOwnSlug', 'lea-own');
    await p.click('#edSave');
    // Ungespeichertes (falls das Rückgängig nicht alles traf): ohne Speichern weiter
    const leave = p.locator('.ui-dialog .ui-btn', { hasText: 'Continue' });
    if (await leave.count()) await leave.click();
    await p.waitForURL(/page=\d+/);
    ok(sql(`SELECT slug FROM code_sites WHERE id = ${studio}`) === 'lea-own' && sql("SELECT IFNULL(code_site_id, 'null') FROM pages WHERE slug = 'lea-studio'") === 'null', 'The code page has its own address, the page shows its link page');

    // Move to one of your pages: zurück auf den Platz
    await p.goto(BASE + '/dashboard?site=' + studio + '#code', { waitUntil: 'networkidle' });
    await p.locator('#tab-code #codeEditor').waitFor();
    ok((await where.innerText()).includes('It has its own address.'), 'Where it lives: its own address');
    await where.getByRole('button', { name: 'Move to one of your pages' }).click();
    await p.locator('#mvPage').waitFor();
    const slot = sql("SELECT id FROM pages WHERE slug = 'lea-studio'");
    await p.selectOption('#mvPage', slot);
    ok((await p.locator('#mvWarn').innerText()).includes('lea-studio.'), 'The dialog says which address shows the code page');
    // Dieselbe Adresse (?site=…#code): der Editor lädt neu, die Adresse ändert sich dabei nicht – auf „load“ warten
    await Promise.all([p.waitForEvent('load'), p.click('#mvGo')]);
    await p.locator('#tab-code #codeEditor').waitFor();
    await p.waitForLoadState('networkidle');
    ok(sql(`SELECT IFNULL(code_site_id, 0) FROM pages WHERE id = ${slot}`) === String(studio) && sql(`SELECT IFNULL(slug, 'null') FROM code_sites WHERE id = ${studio}`) === 'null', 'The code page moved onto the page slot');

    // Jeder Platz zeigt eine Code-Seite (U13): die erste Seite bekommt auch eine (direkt in der Datenbank – über die
    // Oberfläche erlaubt max_on_pages 1 nur eine)
    sql(`INSERT INTO code_sites (user_id, slug, title, created_at, updated_at) VALUES (7, NULL, 'Second', NOW(), NOW());
      UPDATE pages SET code_site_id = LAST_INSERT_ID() WHERE user_id = 7 AND slug = 'lea';`);
    await p.goto(BASE + '/dashboard#content', { waitUntil: 'networkidle' }).catch((e) => { throw new Error(e.message.split('\n')[0] + ' – browser dialogs: ' + JSON.stringify(dialogs)); });
    const box = p.locator('#noPageBox');
    ok((await box.innerText()).includes('Your pages show code pages') && (await box.innerText()).includes('Show a link page again or create a new page.'), 'Without a link page the editor says that every page shows a code page');
    ok(await box.getByRole('button', { name: 'Create page' }).count() === 1, 'A free page slot offers Create page');
    ok((await p.locator('#psLabel').innerText()) === 'Your pages', 'The page switcher doesn’t say “No page yet”');
    await box.getByRole('button', { name: 'Open code pages' }).click();
    await p.locator('#tab-code #codeEditor').waitFor();
    ok(await box.isHidden(), 'Open code pages opens the Code tab');

    // Einstellungen ohne Link-Seite: Your pages mit beiden Code-Seiten, Wochenbericht, Discord – kein Subdomain-Abschnitt
    await p.click('#mainNav [data-tab=settings]');
    await p.locator('#yourPagesSection').waitFor();
    ok(await p.locator('#yourPagesSection [data-open-site]').count() === 2, 'Your pages lists both code pages with Open code editor');
    ok((await p.locator('#yourPagesSection').innerText()).includes('Your link page is saved and hidden'), 'The rows say the link pages are kept');
    ok(await p.locator('#weeklyToggle').count() === 1 && await p.locator('#discordId').count() === 1, 'The weekly report and the Discord ID stay available');
    ok(await p.locator('#subdomainSection').count() === 0 && await p.locator('[data-bind="page.settings.notify_email"]').count() === 0, 'No sections of a link page');
    ok(await box.isHidden(), 'The start box stays hidden in Settings');

    // Die Karte „Code page“ ist jetzt gesperrt, mit dem Grund
    await p.click('#yourPagesSection [data-action=new-page]');
    await p.locator('#npSlug').waitFor();
    ok(await codeCard.getAttribute('aria-disabled') === 'true' && (await p.locator('#npWhy-code').innerText()).includes('Only one of your pages can show a code page.') && await codeCard.getAttribute('aria-describedby') === 'npWhy-code', 'The Code page card is locked with its reason');
    // Playwright klickt gesperrte Elemente nicht von selbst – der Klick muss trotzdem ins Leere gehen
    await codeCard.click({ force: true });
    ok(await linkCard.getAttribute('aria-checked') === 'true', 'A locked card can’t be chosen');
    await p.keyboard.press('Escape');

    // „Delete code page“ im Seitenwechsler: der Dialog bietet Download files
    await openMenu(p);
    await p.click(`#pageMenu [data-del-site="${studio}"]`);
    await p.locator('.ui-dialog').waitFor();
    ok(await p.locator('.ui-dialog [data-code-download]').count() === 1, 'The delete dialog offers Download files');
    const [dl2] = await Promise.all([p.waitForEvent('download'), p.click('.ui-dialog [data-code-download]')]);
    ok(dl2.suggestedFilename().startsWith('lea-studio-code-'), 'Download files from the delete dialog (a page that is not open)');
    await p.keyboard.press('Escape');

    // Telefon: Startbox, Einstellungen, Dialog „Create a new page“ und Code-Tab ohne seitliches Scrollen
    const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const phone = await phoneCtx.newPage();
    phone.on('pageerror', (e) => errors.push(e.message));
    await phone.goto(BASE + '/login');
    await phone.fill('input[name=email]', 'lea@test.de');
    await phone.fill('input[name=password]', PASSWORD);
    await Promise.all([phone.waitForNavigation(), phone.click('button[type=submit]')]);
    const overflow = () => phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await phone.goto(BASE + '/dashboard#content', { waitUntil: 'networkidle' });
    ok(await overflow() <= 0, 'Phone: the start box fits');
    await phone.goto('about:blank');
    await phone.goto(BASE + '/dashboard#settings', { waitUntil: 'networkidle' });
    await phone.locator('#yourPagesSection').waitFor();
    ok(await overflow() <= 0, 'Phone: Settings without a link page fit');
    await phone.click('#yourPagesSection [data-action=new-page]');
    await phone.locator('#npSlug').waitFor();
    ok(await overflow() <= 0, 'Phone: the Create a new page dialog fits');
    await phone.goto(BASE + '/dashboard?site=' + studio + '#code', { waitUntil: 'networkidle' });
    await phone.locator('#codeWhere').waitFor();
    ok(await overflow() <= 0, 'Phone: the Code tab with Where it lives fits');
    await phoneCtx.close();

    // Neue Subdomain einer Code-Seite auf einem Platz: „Where it lives“ nennt gleich die neue Adresse
    sql("UPDATE pages SET slug_changed_at = NULL WHERE user_id = 7 AND slug = 'lea-studio'");
    await p.goto('about:blank');
    await p.goto(BASE + '/dashboard?site=' + studio + '#code', { waitUntil: 'networkidle' });
    await p.locator('#codeSlugEdit').waitFor();
    await p.fill('#codeSlugEdit', 'lea-studio2');
    await p.click('[data-code=address]');
    await p.locator('.ui-dialog').waitFor();
    await p.click('.ui-dialog .ui-foot .ui-btn:has-text("Move")');
    await p.getByText(/Your code page is now at lea-studio2\./).waitFor();
    ok((await where.innerText()).includes('It replaces the link page of lea-studio2.'), 'Where it lives follows a new subdomain without reloading');

    // Settings → Your pages: ein Platz mit Code-Seite wird als Seite gelöscht – mit der Code-Seite
    await p.click('#mainNav [data-tab=settings]');
    const slotRow = p.locator(`#yourPagesSection [data-del-page="${slot}"]`);
    await slotRow.waitFor();
    await slotRow.click();
    await p.locator('.ui-dialog').waitFor();
    ok((await p.locator('.ui-dialog .ui-text').innerText()).includes('This deletes the code page and the saved link page'), 'Deleting a slot says it deletes the code page and the link page');
    await p.type('.ui-dialog .ui-input', 'lea-studio2');
    await Promise.all([p.waitForEvent('load'), p.click('.ui-dialog .ui-foot .ui-btn:has-text("Delete page")')]);
    ok(sql(`SELECT COUNT(*) FROM pages WHERE id = ${slot}`) === '0' && sql(`SELECT COUNT(*) FROM code_sites WHERE id = ${studio}`) === '0', 'The page and its code page are deleted');

    // Ohne Freischaltung: „Open the shop“ unter der gesperrten Karte geht auch mit der Tastatur
    sql("DELETE FROM honeycomb_ledger WHERE user_id = 7 AND reason = 'unlock'");
    if (sql("SHOW TABLES LIKE 'hc\\_entitlements'") !== '') sql('DELETE FROM hc_entitlements WHERE user_id = 7;');
    await p.goto('about:blank');
    await p.goto(BASE + '/dashboard#content', { waitUntil: 'networkidle' });
    await p.locator('#noPageBox [data-action=new-page]').click();
    await p.locator('#npSlug').waitFor();
    const shop = p.locator('#modal [data-np-shop]');
    ok((await p.locator('#npWhy-code').innerText()).includes('Unlock code pages with honeycombs first.'), 'Without the unlock the card says so');
    await shop.focus();
    await p.keyboard.press('Enter');
    await p.locator('#tab-honeycombs').waitFor({ state: 'visible' });
    ok(await p.locator('#modal').isHidden(), 'Enter on Open the shop closes the dialog and opens the shop');

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
