// Ende-zu-Ende: eigene Dialoge, Wache und Entwürfe im Editor (custom-dialogs CD-2): Abläufe 1–4, 7 (Editor ohne
// ui.js: Hinweis in der Seite), 8 (Vorschau der Code-Seite ohne Browser-Popups), 11 (Handy) und das Rennen zwischen
// Speichern und Löschen, dazu Texte als reiner Text (kein HTML aus Namen), Entwürfe je Konto und ohne Passwörter.
//   node tests/e2e/editor-dialogs.js
// Startet die Seite selbst (Port OYS_E2E_PORT, Vorgabe 14206) mit einer Kopie der Einstellungen, deren base_domain auf
// diesen Port zeigt, und legt eigene Testkonten an (ids 9101, 9102 mit Seiten, Nachrichten, Termin, Code-Seite), die
// am Ende wieder verschwinden. Umgebung: OYS_CONFIG (Vorgabe config.json im Projekt), OYS_E2E_PASSWORD,
// OYS_E2E_ONLY="teil" (nur Schritte mit diesem Namen).
// Nur gegen eine Test-Datenbank (Name beginnt mit oys_test, sonst Abbruch mit Code 2 vor jedem SQL). Jeder native
// Dialog lässt den Lauf scheitern – außer einem ausdrücklich erwarteten beforeunload.
'use strict';
const { chromium } = require('playwright');
const { ok, watchPage, step, summary, sleep } = require('./lib');
const { testSite } = require('./site');

// Einstellungen, SQL und die eigene Seite (Abbruch vor jedem SQL, wenn es keine Test-Datenbank ist)
const site = testSite(14206);
const { sql, count } = site;
const HOST = site.host, PORT = site.port, B = site.base;
// Passwort der Testkonten (seed.php) – zur Laufzeit zusammengesetzt
const PASSWORD = process.env.OYS_E2E_PASSWORD || ['test', '1234'].join('');

// Eigene Konten: U1 mit zwei Seiten und Code-Seite, U2 mit einer Seite (für die Trennung der Entwürfe)
const U1 = 9101, U2 = 9102, P1 = 9111, P2 = 9112, P3 = 9121, SITE = 91401;
const USERS = `${U1}, ${U2}`;
function cleanup() {
  sql(`DELETE FROM code_files WHERE site_id IN (SELECT id FROM code_sites WHERE user_id IN (${USERS}));
    DELETE FROM code_sites WHERE user_id IN (${USERS});
    DELETE FROM page_blocks WHERE page_id IN (SELECT id FROM pages WHERE user_id IN (${USERS}));
    DELETE FROM stats_daily WHERE page_id IN (SELECT id FROM pages WHERE user_id IN (${USERS}));
    DELETE FROM block_clicks_daily WHERE page_id IN (SELECT id FROM pages WHERE user_id IN (${USERS}));
    DELETE FROM messages WHERE user_id IN (${USERS});
    DELETE FROM pages WHERE user_id IN (${USERS});
    DELETE FROM user_bookings WHERE user_id IN (${USERS});
    DELETE FROM notifications WHERE user_id IN (${USERS});
    DELETE FROM honeycomb_ledger WHERE user_id IN (${USERS});
    DELETE FROM users WHERE id IN (${USERS});`);
}
// Tagesbelohnung schon vergeben (gestern, heute, morgen – unabhängig von der Zeitzone): kein Hinweis beim Öffnen
const DAILY = (u) => `INSERT IGNORE INTO honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES
  (${u}, 5, 'daily', DATE_FORMAT(CURDATE() - INTERVAL 1 DAY, '%Y-%m-%d'), '', NOW()), (${u}, 5, 'daily', DATE_FORMAT(CURDATE(), '%Y-%m-%d'), '', NOW()),
  (${u}, 5, 'daily', DATE_FORMAT(CURDATE() + INTERVAL 1 DAY, '%Y-%m-%d'), '', NOW());`;
function fixtures() {
  cleanup();
  sql(`INSERT INTO users (id, email, password, full_name, username, created_at, code_terms_at)
      SELECT ${U1}, 'ed-one@test.de', password, 'Edda One', 'eddaone', NOW(), NOW() FROM users WHERE id = 5;
    INSERT INTO users (id, email, password, full_name, username, created_at)
      SELECT ${U2}, 'ed-two@test.de', password, 'Eddie Two', 'eddiethree', NOW() FROM users WHERE id = 5;
    INSERT INTO pages (id, user_id, slug, position, title, subtitle, bio, theme, layout, address_mode, settings, created_at, updated_at)
      SELECT ${P1}, ${U1}, 'eddaone', 0, 'Edda One', '', '', theme, layout, 'subdomain', settings, NOW(), NOW() FROM pages WHERE id = 2;
    INSERT INTO pages (id, user_id, slug, position, title, subtitle, bio, theme, layout, address_mode, settings, created_at, updated_at)
      SELECT ${P2}, ${U1}, 'eddatwo', 1, 'Edda Two', '', '', theme, layout, 'subdomain', settings, NOW(), NOW() FROM pages WHERE id = 2;
    INSERT INTO pages (id, user_id, slug, position, title, subtitle, bio, theme, layout, address_mode, settings, created_at, updated_at)
      SELECT ${P3}, ${U2}, 'eddiethree', 0, 'Eddie Three', '', '', theme, layout, 'subdomain', settings, NOW(), NOW() FROM pages WHERE id = 2;
    ${DAILY(U1)} ${DAILY(U2)}
    INSERT INTO honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (${U1}, 0, 'unlock', 'code_page', '', NOW());`);
  resetContent();
}
// Inhalt der Seiten, Nachrichten, Termin und Code-Seite (vor jedem Schritt, der sie ändert)
function resetContent() {
  sql(`DELETE FROM page_blocks WHERE page_id IN (${P1}, ${P2}, ${P3});
    INSERT INTO page_blocks (id, page_id, type, position, is_visible, data, created_at) VALUES
      (91101, ${P1}, 'heading', 0, 1, '{"text":"Hello","size":"m","align":"center"}', NOW()),
      (91102, ${P1}, 'link', 1, 1, '{"title":"First","url":"https://example.com/one","subtitle":"","icon":"","thumb":"","featured":false}', NOW()),
      (91103, ${P1}, 'link', 2, 1, '{"title":"Second","url":"https://example.com/two","subtitle":"","icon":"","thumb":"","featured":false}', NOW()),
      (91104, ${P1}, 'text', 3, 1, '{"text":"Some words","align":"center"}', NOW()),
      (91105, ${P2}, 'heading', 0, 1, '{"text":"Page two","size":"m","align":"center"}', NOW()),
      (91106, ${P3}, 'heading', 0, 1, '{"text":"Eddie","size":"m","align":"center"}', NOW());
    UPDATE pages SET title = 'Edda One', user_id = ${U1} WHERE id = ${P1};
    UPDATE pages SET title = 'Edda Two', user_id = ${U1} WHERE id = ${P2};
    DELETE FROM pages WHERE user_id = ${U1} AND id NOT IN (${P1}, ${P2});
    DELETE FROM messages WHERE user_id IN (${USERS});
    INSERT INTO messages (id, page_id, user_id, name, email, message, is_read, created_at) VALUES
      (91201, ${P1}, ${U1}, '<img src=x onerror="window.__xss=1">Eve', 'eve@example.org', 'Hello there', 0, NOW() - INTERVAL 1 MINUTE),
      (91202, ${P1}, ${U1}, 'Bob', 'bob@example.org', 'Second message', 1, NOW() - INTERVAL 2 MINUTE);
    DELETE FROM user_bookings WHERE user_id IN (${USERS});
    INSERT INTO user_bookings (id, user_id, guest_name, guest_email, booking_date, booking_time) VALUES
      (91301, ${U1}, 'Carol <b>bold</b>', 'carol@example.org', CURDATE() + INTERVAL 3 DAY, '14:00');
    DELETE FROM code_files WHERE site_id = ${SITE};
    DELETE FROM code_sites WHERE id = ${SITE};
    INSERT INTO code_sites (id, user_id, slug, title, is_published, created_at, updated_at) VALUES (${SITE}, ${U1}, 'eddacode', 'Edda code', 1, NOW(), NOW());
    INSERT INTO code_files (site_id, path, content, updated_at) VALUES
      (${SITE}, 'index.html', '<!DOCTYPE html><html><head><title>Edda</title><script src="/script.js"></script></head><body><h1 id="hi">Hi</h1></body></html>', NOW()),
      (${SITE}, 'script.js', 'window.addEventListener("load", function () { alert("from the code page"); confirm("sure?"); prompt("name?"); });', NOW()),
      (${SITE}, 'about.html', '<p>About</p>', NOW());`);
}

let browser;
const IGNORED_CONSOLE = /tailwindcss|favicon|ERR_FAILED|net::|preload/;
async function newPage(opts = {}) {
  const ctx = opts.ctx || await browser.newContext({ viewport: opts.viewport || { width: 1400, height: 900 }, isMobile: !!opts.mobile, hasTouch: !!opts.mobile });
  if (opts.init) await ctx.addInitScript(opts.init);
  const page = await ctx.newPage();
  const t = watchPage(page, opts.t || {});
  t.console = [];
  page.on('console', (m) => {
    t.console.push(m.text());
    if (m.type() === 'error' && !IGNORED_CONSOLE.test(m.text()) && !(opts.allowConsole && opts.allowConsole.test(m.text()))) ok(false, 'console error: ' + m.text());
  });
  if (opts.blockUi) await page.route('**/static/js/ui.js*', (r) => r.abort());
  return { ctx, page, t };
}
async function login(page, email) {
  await page.goto(B + '/login');
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', PASSWORD);
  await Promise.all([page.waitForNavigation(), page.click('form[action="/login"] button[type=submit]')]);
}
// Editor einer Seite öffnen und warten, bis er bereit ist
async function editor(page, pageId, hash = '') {
  await page.goto(B + '/dashboard?page=' + pageId + hash);
  await page.waitForFunction(() => !!window.OYSUI && !!document.querySelector('#blockList, #tab-code > *'));
}
const dlg = (page) => page.locator('.ui-dialog');
const dialogTitle = (page) => page.locator('.ui-dialog .ui-title').textContent();
const dialogText = (page) => page.locator('.ui-dialog .ui-text').textContent();
const button = (page, label) => page.locator('.ui-dialog .ui-foot .ui-btn', { hasText: label });
const isDirty = (page) => page.evaluate(() => document.getElementById('saveBtn').classList.contains('ring-2'));
const draftKeys = (page) => page.evaluate(() => Object.keys(localStorage).filter((k) => k.indexOf('oys.draft.') === 0).sort());
const activeLabel = (page) => page.evaluate(() => { const a = document.activeElement; return a ? (a.getAttribute('aria-label') || a.textContent || a.id || a.tagName).trim() : ''; });
async function openBlock(page, title) {
  const card = page.locator('.blk', { hasText: title }).first();
  if (!(await card.evaluate((n) => n.classList.contains('open')))) await card.locator('[data-blk="toggle"]').click();
  return page.locator('.blk.open', { hasText: title }).first();
}
async function makeDirty(page, value) {
  await page.fill('[data-bind="page.title"]', value);
  await page.waitForFunction(() => document.getElementById('saveBtn').classList.contains('ring-2'));
}
const sessionId = async (ctx) => ((await ctx.cookies()).find((c) => c.name === 'PHPSESSID') || {}).value || '';

(async () => {
  fixtures();
  await site.start();
  browser = await chromium.launch({ args: site.browserArgs });
  try {
    await step('1 delete a block: cancel, Escape, ✕, confirm; focus and text', async () => {
      resetContent();
      const { ctx, page } = await newPage();
      await login(page, 'ed-one@test.de');
      await editor(page, P1);
      ok(await page.locator('#blockList .blk').count() === 4, 'four blocks');
      let card = await openBlock(page, 'Second');
      await card.locator('[data-blk="del"]').click();
      await dlg(page).waitFor();
      ok(await dialogTitle(page) === 'Delete this block?' && await dialogText(page) === 'It’s removed from your page when you save.', 'title and text');
      ok(await dlg(page).getAttribute('role') === 'alertdialog' && await dlg(page).getAttribute('aria-modal') === 'true', 'alertdialog, modal');
      ok(await activeLabel(page) === 'Cancel', 'Cancel is focused (danger)');
      await button(page, 'Cancel').click();
      await sleep(150);
      ok(await page.locator('#blockList .blk').count() === 4 && !(await isDirty(page)), 'Cancel keeps the block, nothing unsaved');
      ok(await activeLabel(page) === 'Delete', 'focus back on the Delete button');
      for (const how of ['Escape', 'x']) {
        await card.locator('[data-blk="del"]').click();
        await dlg(page).waitFor();
        if (how === 'Escape') await page.keyboard.press('Escape');
        else await page.click('.ui-dialog .ui-x');
        await sleep(150);
        ok(await dlg(page).count() === 0 && await page.locator('#blockList .blk').count() === 4, how + ' cancels');
      }
      await card.locator('[data-blk="del"]').click();
      await button(page, 'Delete').click();
      await sleep(200);
      ok(await page.locator('#blockList .blk').count() === 3 && await page.locator('.blk', { hasText: 'Second' }).count() === 0, 'Delete removes it');
      ok(await isDirty(page), 'the editor has unsaved changes');
      ok(await page.evaluate(() => document.activeElement && document.activeElement.closest('#blockList, [data-action="add-block"]') !== null), 'focus returns to the block list');
      // Strg+S unter einem offenen Dialog speichert nicht
      const saves = [];
      page.on('request', (r) => { if (r.url().endsWith('/dashboard/api/save')) saves.push(r); });
      card = await openBlock(page, 'First');
      await card.locator('[data-blk="del"]').click();
      await dlg(page).waitFor();
      await page.keyboard.press('Control+s');
      await sleep(300);
      ok(saves.length === 0, 'Ctrl+S does nothing while a dialog is open');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+s');
      await page.waitForFunction(() => document.getElementById('saveLabel').textContent === 'Saved', null, { timeout: 5000 });
      ok(saves.length === 1 && count('SELECT COUNT(*) FROM page_blocks WHERE id = 91103') === 0, 'Ctrl+S saves without a dialog; the block is gone in the database');
      ok((await draftKeys(page)).length === 0, 'no draft left after saving');
      await ctx.close();
    });

    await step('1 quick-add YouTube: embed, link, dismiss', async () => {
      resetContent();
      const { ctx, page } = await newPage();
      await login(page, 'ed-one@test.de');
      await editor(page, P1);
      const add = async (url) => { await page.fill('#quickUrl', url); await page.click('[data-action="quick-add"].btn-primary'); };
      await add('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      await dlg(page).waitFor();
      ok(await dialogTitle(page) === 'Embed this YouTube link?' && await dialogText(page) === 'Show it right on your page, or add it as a normal link button.', 'choice dialog texts');
      ok(await dlg(page).getAttribute('role') === 'dialog', 'choice is a dialog');
      await button(page, 'Embed it').click();
      await sleep(200);
      ok(await page.locator('.blk', { hasText: 'YouTube' }).count() === 1 && await page.inputValue('#quickUrl') === '', 'Embed it adds a YouTube block and clears the field');
      await add('https://youtu.be/dQw4w9WgXcQ');
      await button(page, 'Add as link').click();
      await sleep(200);
      ok(await page.locator('#blockList .blk').count() === 6, 'Add as link adds a link block');
      await add('https://youtu.be/abcdefghijk');
      await dlg(page).waitFor();
      await page.keyboard.press('Escape');
      await sleep(200);
      ok(await page.locator('#blockList .blk').count() === 6 && await page.inputValue('#quickUrl') === 'https://youtu.be/abcdefghijk', 'Escape adds nothing, the address stays');
      ok(await page.evaluate(() => document.activeElement.id) === 'quickUrl', 'focus back in the field');
      await ctx.close();
    });

    await step('1 switch pages and log out with unsaved changes', async () => {
      resetContent();
      const { ctx, page } = await newPage();
      await login(page, 'ed-one@test.de');
      await editor(page, P1);
      await makeDirty(page, 'Edda changed');
      await page.click('#pageSwitcherBtn');
      await page.click(`#pageMenu [data-page="${P2}"]`);
      await dlg(page).waitFor();
      ok(await dialogTitle(page) === 'Switch pages?' && await dialogText(page) === 'You have unsaved changes. They’re lost if you switch now.', 'switch dialog');
      ok(await activeLabel(page) === 'Stay', 'Stay is focused');
      await button(page, 'Stay').click();
      await sleep(200);
      ok(page.url().includes('page=' + P1) && await isDirty(page), 'Stay keeps the page and the changes');
      await sleep(1000);
      ok((await draftKeys(page)).includes(`oys.draft.${U1}.${P1}`), 'the unsaved changes are kept as a draft');
      await page.click('#pageSwitcherBtn');
      await page.click(`#pageMenu [data-page="${P2}"]`);
      await Promise.all([page.waitForURL(new RegExp('page=' + P2)), button(page, 'Switch without saving').click()]);
      await page.waitForFunction(() => !!window.OYSUI);
      ok(!(await draftKeys(page)).includes(`oys.draft.${U1}.${P1}`), 'switching without saving deletes the draft');
      ok(count(`SELECT COUNT(*) FROM pages WHERE id = ${P1} AND title = 'Edda One'`) === 1, 'nothing was saved');

      await editor(page, P2);
      await makeDirty(page, 'Two changed');
      await page.click('aside.app-rail form[action="/logout"] button');
      await dlg(page).waitFor();
      ok(await dialogTitle(page) === 'Leave without saving?', 'log out asks first');
      await button(page, 'Stay').click();
      await sleep(200);
      ok(page.url().includes('/dashboard'), 'Stay keeps the editor open');
      await page.click('aside.app-rail form[action="/logout"] button');
      await Promise.all([page.waitForNavigation(), button(page, 'Leave without saving').click()]);
      await page.goto(B + '/dashboard');
      ok(page.url().endsWith('/login'), 'logged out');
      ok((await draftKeys(page)).length === 0, 'leaving without saving deletes the draft');
      await ctx.close();
    });

    await step('1 delete a message and a booking; names stay plain text', async () => {
      resetContent();
      const { ctx, page } = await newPage();
      await login(page, 'ed-one@test.de');
      await editor(page, P1, '#messages');
      await page.waitForSelector('[data-msg="91201"]');
      await page.click('[data-msg="91201"] [data-msg-act="delete"]');
      await dlg(page).waitFor();
      ok(await dialogTitle(page) === 'Delete this message?', 'message dialog');
      ok(await dialogText(page) === 'The message from <img src=x onerror="window.__xss=1">Eve is deleted for good.', 'the visitor’s name is shown as text');
      ok(await page.locator('.ui-dialog img').count() === 0 && await page.evaluate(() => window.__xss === undefined), 'no element and no script from the name');
      await button(page, 'Cancel').click();
      await sleep(200);
      ok(count('SELECT COUNT(*) FROM messages WHERE id = 91201') === 1, 'Cancel keeps the message');
      await page.click('[data-msg="91201"] [data-msg-act="delete"]');
      await button(page, 'Delete').click();
      await page.waitForSelector('[data-msg="91201"]', { state: 'detached' });
      ok(count('SELECT COUNT(*) FROM messages WHERE id = 91201') === 0, 'message deleted in the database');
      ok((await page.locator('.ui-toast.ok').allTextContents()).some((s) => s.includes('Message deleted.')), 'toast "Message deleted."');
      await page.click('[data-booking-del="91301"]');
      await dlg(page).waitFor();
      ok(await dialogTitle(page) === 'Delete this booking request?', 'booking dialog');
      ok(/^[A-Z][a-z]{2} \d{1,2}, \d{4} · 14:00 from Carol <b>bold<\/b> is deleted for good\.$/.test(await dialogText(page)), 'date, time and name as text: ' + await dialogText(page));
      await button(page, 'Delete').click();
      await page.waitForSelector('[data-booking-del="91301"]', { state: 'detached' });
      ok(count('SELECT COUNT(*) FROM user_bookings WHERE id = 91301') === 0, 'booking deleted in the database');
      ok((await page.locator('.ui-toast.ok').allTextContents()).some((s) => s.includes('Booking request deleted.')), 'booking toast');
      await ctx.close();
    });

    await step('1 code page: delete a file, move the address', async () => {
      resetContent();
      const { ctx, page } = await newPage({ allowConsole: /sandboxed|allow-modals/ });
      await login(page, 'ed-one@test.de');
      await editor(page, P1, '#code');
      await page.waitForSelector('[data-file="about.html"]');
      await page.click('[data-file="about.html"]');
      await page.click('[data-code="delete"]');
      await dlg(page).waitFor();
      ok(await dialogTitle(page) === 'Delete about.html?' && await dialogText(page) === 'It’s removed from your code page when you save.', 'file dialog');
      await button(page, 'Cancel').click();
      await sleep(200);
      ok(await page.locator('[data-file="about.html"]').count() === 1, 'Cancel keeps the file');
      await page.click('[data-code="delete"]');
      await button(page, 'Delete file').click();
      await sleep(300);
      ok(await page.locator('[data-file="about.html"]').count() === 0 && await isDirty(page), 'Delete file removes it (unsaved)');
      await page.click('#saveBtn');
      await page.waitForFunction(() => document.getElementById('saveLabel').textContent === 'Saved', null, { timeout: 5000 });
      ok(count(`SELECT COUNT(*) FROM code_files WHERE site_id = ${SITE} AND path = 'about.html'`) === 0, 'saved: the file is gone');
      await page.fill('#codeSlugEdit', 'eddamoved');
      await page.click('[data-code="address"]');
      await dlg(page).waitFor();
      ok(await dialogTitle(page) === 'Move your code page?' && await dialogText(page) === `New address: eddamoved.${HOST}:${PORT}. The old address stops working right away.`, 'address dialog: ' + await dialogText(page));
      ok(await activeLabel(page) === 'Cancel', 'Cancel focused (warn)');
      await button(page, 'Cancel').click();
      await sleep(200);
      ok(sql(`SELECT slug FROM code_sites WHERE id = ${SITE}`) === 'eddacode', 'Cancel keeps the address');
      await page.click('[data-code="address"]');
      await button(page, 'Move').click();
      await page.waitForFunction(() => [...document.querySelectorAll('.ui-toast')].some((n) => n.textContent.includes('Your code page is now at')));
      ok(sql(`SELECT slug FROM code_sites WHERE id = ${SITE}`) === 'eddamoved', 'moved');
      await ctx.close();
    });

    await step('1 delete a page: typed confirmation, error in the dialog, then deleted', async () => {
      resetContent();
      const { ctx, page } = await newPage();
      await login(page, 'ed-one@test.de');
      await editor(page, P1, '#settings');
      await page.click(`[data-del-page="${P1}"]`);
      await dlg(page).waitFor();
      ok(await dialogTitle(page) === 'Delete page “eddaone”?' && await dialogText(page) === 'All its blocks, stats and messages are deleted. This can’t be undone.', 'page dialog');
      ok(await page.locator('.ui-dialog .ui-label').textContent() === 'Type eddaone to confirm', 'label names the address');
      const okBtn = button(page, 'Delete page');
      ok(await okBtn.isDisabled(), 'disabled while empty');
      await page.type('.ui-dialog .ui-input', 'EDDA one');
      ok(await page.inputValue('.ui-dialog .ui-input') === 'eddaone' && !(await okBtn.isDisabled()), 'typing is lower-cased and stripped; then enabled');
      // Auf dem Server ist es inzwischen die letzte Seite: Fehler im Dialog, der offen bleibt
      sql(`UPDATE pages SET user_id = ${U2} WHERE id = ${P2}`);
      await okBtn.click();
      await page.waitForSelector('.ui-dialog .ui-msg.is-err:not([hidden])');
      ok(await page.textContent('.ui-dialog .ui-msg') === 'You can’t delete your last page.' && await dlg(page).count() === 1, 'server error inside the dialog');
      sql(`UPDATE pages SET user_id = ${U1} WHERE id = ${P2}`);
      await Promise.all([page.waitForNavigation(), okBtn.click()]);
      await page.waitForFunction(() => !!window.OYSUI && !!document.querySelector('#blockList'));
      ok(count(`SELECT COUNT(*) FROM pages WHERE id = ${P1}`) === 0, 'page deleted');
      ok(new URL(page.url()).hash === '#settings' && await page.textContent('#psLabel') !== '', 'the editor reloaded with the other page');
      await ctx.close();
      fixtures();
    });

    await step('2 save race: a save finishes while the delete dialog is open', async () => {
      resetContent();
      const { ctx, page } = await newPage();
      await login(page, 'ed-one@test.de');
      await editor(page, P1);
      let held = null, hold = true;
      await page.route('**/dashboard/api/save', (route) => { if (hold) held = route; else route.continue(); });
      await makeDirty(page, 'Race title');
      await page.click('#saveBtn');
      await page.waitForFunction(() => document.getElementById('saveLabel').textContent === 'Saving…');
      const card = await openBlock(page, 'Second');
      await card.locator('[data-blk="del"]').click();
      await dlg(page).waitFor();
      hold = false;
      const answered = page.waitForResponse((r) => r.url().endsWith('/dashboard/api/save'));
      await held.continue();
      await answered;
      await page.waitForFunction(() => document.getElementById('saveLabel').textContent === 'Saved');
      ok(await dlg(page).count() === 1, 'the dialog is still open after the save');
      await button(page, 'Delete').click();
      await sleep(200);
      ok(await page.locator('.blk', { hasText: 'Second' }).count() === 0, 'Delete removes the block from the new list');
      ok(await isDirty(page), 'and the editor has unsaved changes');
      await page.click('#saveBtn');
      await page.waitForFunction(() => document.getElementById('saveLabel').textContent === 'Saved');
      ok(count('SELECT COUNT(*) FROM page_blocks WHERE id = 91103') === 0 && count(`SELECT COUNT(*) FROM pages WHERE id = ${P1} AND title = 'Race title'`) === 1, 'database: block gone, title saved');
      await ctx.close();
    });

    await step('3 navigations: new page with unsaved code; mailto keeps the protection', async () => {
      resetContent();
      const { ctx, page } = await newPage({ allowConsole: /sandboxed|allow-modals/ });
      await login(page, 'ed-one@test.de');
      await editor(page, P1, '#code');
      await page.waitForSelector('.CodeMirror, #codeArea');
      await page.evaluate(() => { const cm = document.querySelector('.CodeMirror'); if (cm && cm.CodeMirror) cm.CodeMirror.replaceRange('<!-- changed -->', { line: 0, ch: 0 }); });
      if (await page.locator('.CodeMirror').count() === 0) await page.type('#codeArea', ' ');
      await page.waitForFunction(() => document.getElementById('saveBtn').classList.contains('ring-2'));
      await sleep(1000);
      ok((await draftKeys(page)).includes(`oys.draft.${U1}.code.${SITE}`), 'unsaved code is kept as a draft');
      await page.click('#pageSwitcherBtn');
      await page.click('#pageMenu [data-action="new-page"]');
      await page.fill('#npSlug', 'eddafour');
      await page.click('#npCreate');
      await dlg(page).waitFor();
      ok(await dialogTitle(page) === 'Create the page without saving?' && await dialogText(page) === 'You have unsaved changes on this page. They’re lost if you continue.', 'create dialog');
      await button(page, 'Cancel').click();
      await sleep(200);
      ok(await page.isVisible('#npCreate') && count("SELECT COUNT(*) FROM pages WHERE slug = 'eddafour'") === 0, 'Cancel creates nothing');
      await page.click('#npCreate');
      await Promise.all([page.waitForURL((u) => /page=\d+/.test(u.href) && !u.href.includes('page=' + P1)), button(page, 'Create without saving').click()]);
      await page.waitForFunction(() => !!window.OYSUI && !!document.querySelector('#blockList'));
      ok(count("SELECT COUNT(*) FROM pages WHERE slug = 'eddafour'") === 1, 'the new page exists and is open');
      ok(!(await draftKeys(page)).includes(`oys.draft.${U1}.code.${SITE}`), 'the code draft is deleted');
      await ctx.close();

      // mailto: kein Dialog; danach greift der Schutz wieder. Ohne Speicher im Browser fragt der Browser beim Schließen
      // (D19: sonst liegt die Arbeit als Entwurf vor, und der Browser fragt nicht)
      for (const storage of [true, false]) {
        const t = { expectBeforeUnload: true };
        const init = storage ? undefined : () => { Storage.prototype.setItem = function () { throw new DOMException('full', 'QuotaExceededError'); }; };
        const s = await newPage({ t, init });
        await login(s.page, 'ed-one@test.de');
        await editor(s.page, P1);
        await makeDirty(s.page, 'Mail while dirty');
        await s.page.click('#mainNav [data-tab="messages"]');
        await s.page.waitForSelector('[data-msg] a[href^="mailto:"]');
        await s.page.click('[data-msg] a[href^="mailto:"]');
        await sleep(400);
        ok(await dlg(s.page).count() === 0 && !t.sawBeforeUnload, (storage ? '' : 'no storage: ') + 'Reply opens the mail app without any dialog');
        await sleep(1700);
        await s.page.close({ runBeforeUnload: true });
        await sleep(800);
        ok(storage ? !t.sawBeforeUnload : t.sawBeforeUnload === 1, storage ? 'closing the tab: no browser dialog, the draft keeps the work' : 'without a draft the browser still asks when the tab is closed');
        await s.ctx.close();
      }
    });

    await step('4 session: logged out → Close → Log in → Restore → Save; 419 → Reload', async () => {
      resetContent();
      // Abgelehnte Anfragen (401, 419) meldet der Browser selbst in der Konsole – hier erwartet
      const { ctx, page } = await newPage({ allowConsole: /status of 4(01|19)/ });
      await login(page, 'ed-one@test.de');
      await editor(page, P1);
      await makeDirty(page, 'Restored title');
      await sleep(1000);
      sql(`DELETE FROM oys_sessions WHERE id = '${(await sessionId(ctx)).replace(/[^A-Za-z0-9,-]/g, '')}'`);
      await page.click('#saveBtn');
      await dlg(page).waitFor();
      ok(await dialogTitle(page) === 'You’re logged out', '401 dialog');
      ok(await dialogText(page) === 'Log in again to continue. Your unsaved changes are kept in this browser and offered again after you log in.', 'text mentions the kept changes');
      ok(await dlg(page).count() === 1 && await page.locator('.ui-toast.err').count() === 0, 'one dialog, no error toast');
      await button(page, 'Close').click();
      const note = page.locator('.ui-toast', { hasText: 'You’re logged out.' });
      await note.waitFor();
      ok(await note.locator('.ui-toast-act').textContent() === 'Log in', 'sticky toast with Log in');
      // Weitere Anfragen ohne Sitzung: kein zweiter Dialog, keine Fehler-Hinweise
      await page.click('#mainNav [data-tab="stats"]');
      await sleep(600);
      ok(await dlg(page).count() === 0 && await page.locator('.ui-toast.err').count() === 0, 'later requests: no second dialog, no error toasts');
      await page.click('#mainNav [data-tab="content"]');
      ok(await page.inputValue('[data-bind="page.title"]') === 'Restored title', 'the text is still there to copy');
      await Promise.all([page.waitForURL(/\/login$/), note.locator('.ui-toast-act').click()]);
      await page.fill('input[name=email]', 'ed-one@test.de');
      await page.fill('input[name=password]', PASSWORD);
      await Promise.all([page.waitForNavigation(), page.click('form[action="/login"] button[type=submit]')]);
      await dlg(page).waitFor();
      ok(await dialogTitle(page) === 'Restore unsaved changes?' && /^You have changes from \d\d:\d\d that weren’t saved\.$/.test(await dialogText(page)), 'restore offered: ' + await dialogText(page));
      await button(page, 'Restore').click();
      await sleep(300);
      ok(await page.inputValue('[data-bind="page.title"]') === 'Restored title' && await isDirty(page), 'content back, unsaved');
      ok(count(`SELECT COUNT(*) FROM pages WHERE id = ${P1} AND title = 'Restored title'`) === 0, 'nothing saved automatically');
      await page.click('#saveBtn');
      await page.waitForFunction(() => document.getElementById('saveLabel').textContent === 'Saved');
      ok(count(`SELECT COUNT(*) FROM pages WHERE id = ${P1} AND title = 'Restored title'`) === 1, 'saved after restoring');
      ok((await draftKeys(page)).length === 0, 'draft gone after saving');

      // 419: abgelaufenes Formular-Token → „Reload“ lädt neu, ohne Fenster des Browsers; der Entwurf wird angeboten.
      // Die nächste Anfrage (hier die Vorschau nach der Änderung) bringt den Dialog.
      await page.evaluate(() => { window.OYS_EDITOR.csrf = 'x'.repeat(64); });
      await page.fill('[data-bind="page.title"]', 'Expired title');
      await dlg(page).waitFor();
      ok(await dialogTitle(page) === 'Your session has expired' && await dialogText(page) === 'Reload the editor to continue. Your unsaved changes are kept in this browser.', '419 dialog');
      await Promise.all([page.waitForNavigation(), button(page, 'Reload').click()]);
      await dlg(page).waitFor();
      ok(await dialogTitle(page) === 'Restore unsaved changes?', 'after the reload the draft is offered');
      await button(page, 'Discard').click();
      await sleep(200);
      ok(await page.inputValue('[data-bind="page.title"]') === 'Restored title' && (await draftKeys(page)).length === 0, 'Discard keeps the saved version and deletes the draft');
      await ctx.close();
    });

    await step('4 drafts: per account, without passwords, older pages offered, base changed', async () => {
      resetContent();
      const shared = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      const a = await newPage({ ctx: shared });
      await login(a.page, 'ed-one@test.de');
      await editor(a.page, P1);
      // Geschützter Link mit Passwort: das Passwort landet nie im Entwurf
      const card = await openBlock(a.page, 'First');
      await card.locator('[data-extra="protect"]').click();
      await a.page.click('.blk.open [data-set="protection"][data-val="password"]');
      const linkPassword = ['Link', 'pass', String(4 * 10 + 2)].join('-');
      await a.page.fill('.blk.open [data-f="password"]', linkPassword);
      await makeDirty(a.page, 'Draft of one');
      await sleep(1100);
      const stored = await a.page.evaluate((k) => localStorage.getItem(k), `oys.draft.${U1}.${P1}`);
      ok(!!stored && stored.includes('Draft of one') && !stored.includes(linkPassword), 'the draft holds the change but no password');
      // Absturz (Tab weg ohne Frage), dann meldet sich ein anderes Konto im selben Browser an
      await a.page.close();
      const b = await newPage({ ctx: shared });
      await login(b.page, 'ed-two@test.de');
      await editor(b.page, P3);
      await sleep(600);
      ok(await dlg(b.page).count() === 0 && await b.page.locator('.ui-toast', { hasText: 'Unsaved changes' }).count() === 0, 'another account sees nothing of it');
      ok((await draftKeys(b.page)).includes(`oys.draft.${U1}.${P1}`), 'the first account’s draft stays in the browser');
      await b.page.close();
      // Zurück beim ersten Konto: die Seite wurde inzwischen anderswo gespeichert → Hinweis im Dialog.
      // Ein Entwurf, der älter als 7 Tage ist, verschwindet beim Laden (auch der eines anderen Kontos).
      sql(`UPDATE pages SET bio = 'Saved elsewhere' WHERE id = ${P1}`);
      const c = await newPage({ ctx: shared });
      await login(c.page, 'ed-one@test.de');
      await c.page.evaluate((k) => {
        const old = { v: 1, at: Date.now() - 8 * 864e5, base: '', page: { page: { title: 'Ancient' }, blocks: [] } };
        localStorage.setItem(k[0], JSON.stringify(old));
        localStorage.setItem(k[1], JSON.stringify(old));
      }, [`oys.draft.${U1}.${P2}`, `oys.draft.${U2}.${P3}`]);
      await editor(c.page, P2);
      ok(!(await draftKeys(c.page)).some((k) => k.endsWith('.' + P2) || k.endsWith('.' + P3)), 'drafts older than 7 days are deleted on load');
      ok(await c.page.locator('.ui-dialog', { hasText: 'Restore unsaved changes?' }).count() === 0, 'and not offered');
      const other = c.page.locator('.ui-toast', { hasText: 'Unsaved changes on “Edda One”.' });
      await other.waitFor();
      ok(await other.locator('.ui-toast-act').textContent() === 'Open', 'drafts of other pages: a sticky note with Open');
      await Promise.all([c.page.waitForURL(new RegExp('page=' + P1)), other.locator('.ui-toast-act').click()]);
      await dlg(c.page).waitFor();
      ok((await dialogText(c.page)).endsWith('This page was saved again after that – restoring replaces that version when you save.'), 'the dialog says the page was saved again');
      await button(c.page, 'Restore').click();
      await sleep(300);
      ok(await c.page.inputValue('[data-bind="page.title"]') === 'Draft of one', 'restored');
      // Das Passwort des geschützten Links muss neu eingegeben werden
      await c.page.click('#saveBtn');
      await c.page.locator('.ui-toast.err', { hasText: 'Please set a password for the protected link.' }).waitFor();
      ok(await c.page.locator('.blk.open [data-f="password"]').count() === 1, 'the protected link asks for its password again');
      await shared.close();
    });

    await step('4 drafts: two tabs on one page – the other tab never drops or overwrites this tab’s draft', async () => {
      resetContent();
      const shared = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      const ta = { expectBeforeUnload: true }, tb = { expectBeforeUnload: true };
      const a = await newPage({ ctx: shared, t: ta });
      await login(a.page, 'ed-one@test.de');
      await editor(a.page, P1);
      const b = await newPage({ ctx: shared, t: tb });
      await editor(b.page, P1);
      const key = `oys.draft.${U1}.${P1}`;
      const stored = (p) => p.evaluate((k) => localStorage.getItem(k) || '', key);
      // Tab A: ungespeichert → Entwurf. Tab B ändert und speichert etwas anderes.
      await makeDirty(a.page, 'Title from tab A');
      await sleep(1100);
      ok((await stored(a.page)).includes('Title from tab A'), 'tab A keeps its work as a draft');
      await makeDirty(b.page, 'Title from tab B');
      await sleep(1100);
      ok((await stored(b.page)).includes('Title from tab A'), 'tab B does not overwrite the draft of tab A');
      await b.page.click('#saveBtn');
      await b.page.waitForFunction(() => document.getElementById('saveLabel').textContent === 'Saved');
      await sleep(200);
      ok((await stored(b.page)).includes('Title from tab A'), 'saving in tab B keeps the draft of tab A');
      // Ein dritter Tab verwirft den angebotenen Entwurf; Tab A ist noch offen und sichert seine Arbeit beim Schließen neu
      const c = await newPage({ ctx: shared });
      await editor(c.page, P1);
      await dlg(c.page).waitFor();
      await button(c.page, 'Discard').click();
      await sleep(200);
      ok(!(await stored(c.page)), 'Discard in a third tab deletes the offered draft');
      await c.page.close();
      await a.page.close({ runBeforeUnload: true });
      await sleep(800);
      ok(!ta.sawBeforeUnload && (await stored(b.page)).includes('Title from tab A'), 'closing tab A: its work is stored again, no browser dialog');
      // Tab B kann seine Arbeit nicht als Entwurf ablegen (der Platz gehört Tab A): beim Schließen fragt der Browser
      await makeDirty(b.page, 'Another title from tab B');
      await sleep(1100);
      ok((await stored(b.page)).includes('Title from tab A'), 'tab B still leaves the draft of tab A alone');
      await b.page.close({ runBeforeUnload: true });
      await sleep(800);
      ok(tb.sawBeforeUnload === 1, 'closing tab B: its work is in no draft, so the browser asks');
      await shared.close();
    });

    await step('4 drafts: Escape on “Restore unsaved changes?” keeps the old draft until the user decides', async () => {
      resetContent();
      const t = { expectBeforeUnload: true };
      const { ctx, page } = await newPage({ t });
      await login(page, 'ed-one@test.de');
      const key = `oys.draft.${U1}.${P1}`;
      await page.evaluate((k) => localStorage.setItem(k, JSON.stringify({ v: 1, at: Date.now() - 3600e3, base: '', page: { page: { title: 'Written yesterday' }, blocks: [] } })), key);
      await editor(page, P1);
      await dlg(page).waitFor();
      ok(await dialogTitle(page) === 'Restore unsaved changes?', 'the draft is offered');
      await page.keyboard.press('Escape');
      await sleep(200);
      ok(await dlg(page).count() === 0, 'Escape closes the dialog');
      await makeDirty(page, 'Typed today');
      await sleep(1100);
      ok((await page.evaluate((k) => localStorage.getItem(k) || '', key)).includes('Written yesterday'), 'the next change does not overwrite the old draft');
      await page.close({ runBeforeUnload: true });
      await sleep(800);
      ok(t.sawBeforeUnload === 1, 'today’s work is in no draft, so the browser asks when the tab is closed');
      const again = await newPage({ ctx });
      await editor(again.page, P1);
      await dlg(again.page).waitFor();
      ok(await dialogTitle(again.page) === 'Restore unsaved changes?', 'the old draft is offered again');
      await button(again.page, 'Discard').click();
      await sleep(200);
      ok((await draftKeys(again.page)).length === 0, 'Discard deletes it');
      await ctx.close();
    });

    await step('4 session without a draft: “Log in” leaves the browser’s leave dialog in place', async () => {
      resetContent();
      const t = { expectBeforeUnload: true };
      const init = () => { Storage.prototype.setItem = function () { throw new DOMException('full', 'QuotaExceededError'); }; };
      const { ctx, page } = await newPage({ t, init, allowConsole: /status of 4(01|19)/ });
      await login(page, 'ed-one@test.de');
      await editor(page, P1);
      await makeDirty(page, 'Not storable');
      await sleep(1000);
      sql(`DELETE FROM oys_sessions WHERE id = '${(await sessionId(ctx)).replace(/[^A-Za-z0-9,-]/g, '')}'`);
      await page.click('#saveBtn');
      await dlg(page).waitFor();
      ok(await dialogText(page) === 'Log in again to continue.', 'no promise of kept changes');
      await Promise.all([page.waitForURL(/\/login$/), button(page, 'Log in').click()]);
      ok(t.sawBeforeUnload === 1, 'the browser asks before the unsaved work is lost');
      // 419 → „Reload“: ebenso
      await page.fill('input[name=email]', 'ed-one@test.de');
      await page.fill('input[name=password]', PASSWORD);
      await Promise.all([page.waitForNavigation(), page.click('form[action="/login"] button[type=submit]')]);
      await editor(page, P1);
      await page.evaluate(() => { window.OYS_EDITOR.csrf = 'x'.repeat(64); });
      await makeDirty(page, 'Still not storable');
      await dlg(page).waitFor();
      ok(await dialogText(page) === 'Reload the editor to continue.', '419 dialog without the promise');
      await Promise.all([page.waitForNavigation(), button(page, 'Reload').click()]);
      ok(t.sawBeforeUnload === 2, 'Reload: the browser asks as well');
      await ctx.close();
    });

    await step('4 drafts: logging out removes the account’s drafts, other accounts’ stay', async () => {
      resetContent();
      const { ctx, page } = await newPage();
      await login(page, 'ed-one@test.de');
      await editor(page, P1);
      await page.evaluate((ks) => {
        const d = { v: 1, at: Date.now(), base: '', page: { page: { title: 'Left behind' }, blocks: [] } };
        ks.forEach((k) => localStorage.setItem(k, JSON.stringify(d)));
      }, [`oys.draft.${U1}.${P2}`, `oys.draft.${U1}.code.${SITE}`, `oys.draft.${U2}.${P3}`]);
      await Promise.all([page.waitForNavigation(), page.locator('form[action="/logout"] button[type=submit]').first().click()]);
      const left = await draftKeys(page);
      ok(!left.some((k) => k.indexOf(`oys.draft.${U1}.`) === 0) && left.includes(`oys.draft.${U2}.${P3}`), 'only the drafts of the account that logged out are gone: ' + left.join(', '));
      await ctx.close();
    });

    await step('7 editor without ui.js: an in-page notice, no editing', async () => {
      const { ctx, page } = await newPage({ blockUi: true });
      await login(page, 'ed-one@test.de');
      await page.goto(B + '/dashboard?page=' + P1);
      await page.waitForSelector('#editorOff');
      ok(await page.evaluate(() => typeof window.OYSUI) === 'undefined', 'ui.js blocked');
      ok((await page.textContent('#editorOff')).includes('The editor couldn’t load completely. Please reload the page.'), 'the notice');
      ok(await page.locator('#blockList').count() === 0 && await page.isDisabled('#saveBtn'), 'no blocks, saving off');
      ok(await page.getAttribute('#editorOff a', 'href') === '/dashboard?page=' + P1, 'Reload link to the same address');
      await ctx.close();
    });

    await step('8 code preview: the user’s code cannot open browser pop-ups', async () => {
      resetContent();
      const { ctx, page, t } = await newPage({ allowConsole: /sandboxed|allow-modals/ });
      await login(page, 'ed-one@test.de');
      await editor(page, P1, '#code');
      ok(!(await page.getAttribute('#pvCode', 'sandbox')).includes('allow-modals'), 'small preview without allow-modals');
      await page.waitForFunction(() => !!document.getElementById('pvCode').getAttribute('src'));
      await sleep(2000);
      ok(await page.isVisible('#pvCodeNote') && await page.textContent('#pvCodeNote') === 'Pop-ups like alert() only run on your live page.', 'the hint under the preview');
      await page.click('[data-code="preview"]');
      await page.waitForSelector('#bigPreview:not(.hidden)');
      ok(!(await page.getAttribute('#bigPreviewFrame', 'sandbox')).includes('allow-modals'), 'large preview without allow-modals');
      await sleep(2000);
      console.log('  (browser messages about blocked pop-ups: ' + t.console.filter((m) => /sandboxed|allow-modals/.test(m)).length + ')');
      await page.keyboard.press('Escape');
      ok(await page.isHidden('#bigPreview'), 'Escape closes the large preview');
      await ctx.close();
    });

    await step('11 phone 390×844: dialogs fit, 16 px inputs, no sideways scroll', async () => {
      resetContent();
      const { ctx, page } = await newPage({ viewport: { width: 390, height: 844 }, mobile: true });
      await login(page, 'ed-one@test.de');
      await editor(page, P1, '#settings');
      await page.click(`[data-del-page="${P2}"]`);
      await dlg(page).waitFor();
      const box = await dlg(page).boundingBox();
      ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844, 'the dialog fits the screen');
      ok(await page.locator('.ui-dialog .ui-input').evaluate((n) => getComputedStyle(n).fontSize) === '16px', 'input 16 px (no zoom)');
      for (const b of await page.locator('.ui-dialog .ui-foot .ui-btn').all()) {
        const r = await b.boundingBox();
        ok(r && r.x >= 0 && r.x + r.width <= 390 && r.y + r.height <= 844, 'button reachable');
      }
      ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal scroll');
      await page.keyboard.press('Escape');
      await ctx.close();
    });

    await step('offline note, start notices, deep links, layers', async () => {
      resetContent();
      sql(`DELETE FROM honeycomb_ledger WHERE user_id = ${U1} AND reason = 'daily'`);
      const { ctx, page } = await newPage();
      // Die Seite prüft Belohnungen je Konto höchstens alle 10 Sekunden (honeycombs/earn.ts, THROTTLE_MS) – der Schritt
      // davor hat den Editor mit demselben Konto geöffnet; ohne die Pause käme die Tagesbelohnung je nach Tempo nicht
      await sleep(10_500);
      // Das erste Öffnen nach dem Anmelden bringt die Tagesbelohnung
      await login(page, 'ed-one@test.de');
      const earned = page.locator('.ui-toast.hc', { hasText: 'for being active today' });
      await earned.waitFor();
      ok((await earned.locator('.ui-amt').textContent()).startsWith('+5'), 'reward notice with its amount');
      sql(DAILY(U1));
      await ctx.setOffline(true);
      const off = page.locator('.ui-toast.warn', { hasText: 'You’re offline. Keep this tab open and save again when you’re back online.' });
      await off.waitFor();
      ok(await off.locator('i.bx-wifi-off').count() === 1, 'offline note with its icon');
      await ctx.setOffline(false);
      await page.locator('.ui-toast.info', { hasText: /^Back online\.$/ }).waitFor();
      await sleep(400);
      ok(await off.count() === 0, 'offline note closed when back online');
      // Ziel im Editor beim Laden: der Bereich „Honeycombs“; ein Fenster des Editors ist eine Ebene mit Escape und Fokus zurück
      await page.goto('about:blank');
      await page.goto(B + '/dashboard?page=' + P1 + '#honeycombs');
      await page.waitForSelector('#tab-honeycombs:not(.hidden) .shop-wallet');
      ok(await page.textContent('#pageTitle') === 'Honeycombs', 'the Honeycombs tab opens from #honeycombs');
      await page.click('#shareBtn');
      await page.waitForSelector('#modal:not(.hidden) #shareUrl');
      ok(await page.getAttribute('#modalBox', 'role') === 'dialog', 'the share window is a dialog');
      ok(await page.evaluate(() => document.querySelector('main').closest('[inert]') !== null), 'the editor behind is inert');
      await page.keyboard.press('Escape');
      await sleep(150);
      ok(await page.isHidden('#modal'), 'Escape closes it');
      ok(await page.evaluate(() => document.activeElement.id) === 'shareBtn', 'focus back on the button that opened it');
      // Eigene Links: andere Seite über die Wache, eigene Tabs ohne Neuladen, fremde Ziele nie
      const opened = await page.evaluate(() => [OYSUI.openLink('/dashboard#stats'), OYSUI.openLink('//evil.example/'), OYSUI.openLink('javascript:alert(1)')]);
      await sleep(300);
      ok(opened.join() === 'true,false,false' && await page.isVisible('#tab-stats') && page.url().includes('page=' + P1), 'in-app link opens the tab, foreign ones are refused');
      await ctx.close();
    });
  } finally {
    await browser.close();
    site.stop();
    cleanup();
  }
  summary('editor-dialogs');
})().catch((err) => {
  console.error(err);
  try { site.stop(); } catch (e) { /* egal */ }
  process.exitCode = 1;
});
