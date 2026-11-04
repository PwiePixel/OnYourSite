// Ende-zu-Ende: die große Block-Auswahl (D2) – am Schreibtisch bis zu 4 Spalten großer Kacheln (Icon, Name, kurzer
// Satz), am Handy 2 Spalten ohne seitliches Scrollen; die Suche filtert Kacheln und Gruppen, „No block matches“ ohne
// Treffer, Enter nimmt den ersten Treffer, ein Tipp fügt den Block hinzu.
// Jeder native Dialog (alert/confirm/prompt) lässt den Lauf scheitern.
//   node tests/e2e/block-picker.js
// Startet die Seite selbst (Port OYS_E2E_PORT, Vorgabe 14208) und legt ein eigenes Testkonto an (id 9405 mit Seite 9415),
// das am Ende wieder verschwindet. Nur gegen eine Test-Datenbank (Name beginnt mit oys_test, sonst Abbruch mit Code 2
// vor jedem SQL). Umgebung: OYS_CONFIG, OYS_E2E_PASSWORD, OYS_E2E_ONLY, OYS_E2E_SHOTS.
'use strict';
const path = require('path');
const { chromium } = require('playwright');
const { ok, watchPage, step, summary } = require('./lib');
const { testSite } = require('./site');

const site = testSite(14208);
const { sql } = site;
const B = site.base;
const PASSWORD = process.env.OYS_E2E_PASSWORD || ['test', '1234'].join('');
const SHOTS = process.env.OYS_E2E_SHOTS || '';
const U = 9405, P = 9415;

function cleanup() {
  sql(`DELETE FROM page_blocks WHERE page_id IN (SELECT id FROM pages WHERE user_id = ${U});
    DELETE FROM pages WHERE user_id = ${U};
    DELETE FROM notifications WHERE user_id = ${U};
    DELETE FROM honeycomb_ledger WHERE user_id = ${U};
    DELETE FROM hc_accounts WHERE user_id = ${U};
    DELETE FROM users WHERE id = ${U};`);
}
function fixtures() {
  cleanup();
  sql(`INSERT INTO users (id, email, password, full_name, username, created_at)
      SELECT ${U}, 'picker@test.de', password, 'Picker Bee', 'pickerbee', '2026-01-01 10:00:00' FROM users WHERE id = 5;
    INSERT INTO pages (id, user_id, slug, position, title, subtitle, bio, theme, layout, address_mode, settings, created_at, updated_at)
      SELECT ${P}, ${U}, 'pickerbee', 0, 'Picker Bee', '', '', theme, layout, 'subdomain', settings, NOW(), NOW() FROM pages WHERE id = 2;
    INSERT IGNORE INTO honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES
      (${U}, 0, 'daily', DATE_FORMAT(CURDATE() - INTERVAL 1 DAY, '%Y-%m-%d'), '', NOW()), (${U}, 0, 'daily', DATE_FORMAT(CURDATE(), '%Y-%m-%d'), '', NOW()),
      (${U}, 0, 'daily', DATE_FORMAT(CURDATE() + INTERVAL 1 DAY, '%Y-%m-%d'), '', NOW());`);
}

let browser;
const IGNORED_CONSOLE = /tailwindcss|favicon|ERR_FAILED|net::|preload|404/;
const shot = async (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, name + '.png') });

async function openEditor(ctx) {
  const page = await ctx.newPage();
  watchPage(page);
  page.on('console', (m) => { if (m.type() === 'error' && !IGNORED_CONSOLE.test(m.text())) ok(false, 'console error: ' + m.text()); });
  await page.goto(B + '/login');
  await page.fill('input[name=email]', 'picker@test.de');
  await page.fill('input[name=password]', PASSWORD);
  await Promise.all([page.waitForNavigation(), page.click('form[action="/login"] button[type=submit]')]);
  await page.goto(B + '/dashboard?page=' + P + '&load=1#content');
  await page.waitForSelector('#blockList');
  return page;
}
// Spalten der ersten Gruppe, Größe der ersten Kachel und ihres Icons
const layout = (page) => page.evaluate(() => {
  const grid = document.querySelector('.modal-box.picker .add-grid');
  const item = grid.querySelector('.add-item');
  const icon = item.querySelector('.ai').getBoundingClientRect();
  const box = document.querySelector('.modal-box.picker').getBoundingClientRect();
  return {
    cols: getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length,
    h: item.getBoundingClientRect().height, w: item.getBoundingClientRect().width, icon: icon.width,
    name: parseFloat(getComputedStyle(item.querySelector('b')).fontSize), box: box.width,
    scroll: document.querySelector('.modal-box.picker').scrollWidth - document.querySelector('.modal-box.picker').clientWidth,
  };
});
const visibleTypes = (page) => page.evaluate(() => [...document.querySelectorAll('.add-item')].filter((b) => b.getClientRects().length).map((b) => b.dataset.add));
const visibleGroups = (page) => page.evaluate(() => [...document.querySelectorAll('.add-section')].filter((s) => s.getClientRects().length).length);
const blockTypes = (page) => page.evaluate(() => [...document.querySelectorAll('#blockList .blk')].length);

(async () => {
  fixtures();
  await site.start();
  browser = await chromium.launch({ args: site.browserArgs });
  try {
    await step('desktop: big tiles in 4 columns, search, Enter adds the first match', async () => {
      const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      const page = await openEditor(ctx);
      await page.click('h2 [data-action="add-block"]');
      await page.waitForSelector('.modal-box.picker .add-item');
      const l = await layout(page);
      ok(l.cols === 4, '4 columns (' + l.cols + ')');
      ok(l.box >= 860, 'the window is wide (' + Math.round(l.box) + 'px)');
      ok(l.h >= 120 && l.icon >= 48 && l.name >= 15, 'big tiles: ' + JSON.stringify(l));
      const all = (await visibleTypes(page)).length;
      const groups = await visibleGroups(page);
      ok(await page.evaluate(() => document.activeElement && document.activeElement.id === 'addSearch'), 'the search has the focus');
      await page.waitForTimeout(400);
      await shot(page, 'block-picker-desktop');
      await page.fill('#addSearch', 'video');
      const vids = await visibleTypes(page);
      ok(vids.includes('youtube') && vids.length < all, 'searching "video" keeps YouTube and hides others (' + vids.join(', ') + ')');
      // Gesucht wird in Name und Beschreibung, nicht im Namen der Gruppe („Videos, music & images“)
      ok(!vids.includes('spotify') && !vids.includes('image'), 'the group name alone is no match (' + vids.join(', ') + ')');
      ok((await visibleGroups(page)) < groups, 'groups without a match are hidden');
      ok(!(await page.isVisible('.add-none')), 'no "nothing found" note while there are matches');
      await page.fill('#addSearch', 'zzzz-nothing');
      ok((await visibleTypes(page)).length === 0 && (await page.isVisible('.add-none')), '"No block matches your search." without a match');
      await page.fill('#addSearch', '');
      ok((await visibleTypes(page)).length === all, 'clearing the search shows every block again');
      // Enter ohne Suchtext fügt nichts hinzu
      const empty = await blockTypes(page);
      await page.press('#addSearch', 'Enter');
      await page.waitForTimeout(200);
      ok((await blockTypes(page)) === empty && (await page.isVisible('.modal-box.picker')), 'Enter with an empty search adds nothing');
      await page.fill('#addSearch', 'countdown');
      const before = await blockTypes(page);
      await page.press('#addSearch', 'Enter');
      await page.waitForSelector('#modal.hidden', { state: 'attached' });
      ok((await blockTypes(page)) === before + 1, 'Enter added the first match');
      ok(await page.evaluate(() => /countdown/i.test(document.querySelector('#blockList .blk:last-child').textContent)), 'the new block is a countdown');
      await ctx.close();
    });

    await step('phone: 2 columns, nothing scrolls sideways, a tap adds the block', async () => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const page = await openEditor(ctx);
      await page.locator('[data-action="add-block"]').last().scrollIntoViewIfNeeded();
      await page.locator('[data-action="add-block"]').last().tap();
      await page.waitForSelector('.modal-box.picker .add-item');
      await page.waitForTimeout(150);
      ok(await page.evaluate(() => !document.activeElement || document.activeElement.id !== 'addSearch'), 'on a phone the keyboard doesn’t open by itself (the search has no focus)');
      const l = await layout(page);
      ok(l.cols === 2, '2 columns (' + l.cols + ')');
      ok(l.scroll <= 0, 'no sideways scrolling in the window (' + l.scroll + ')');
      ok(l.h >= 120 && l.w >= 150, 'tiles are big enough to tap: ' + JSON.stringify(l));
      const box = await page.locator('.modal-box.picker').boundingBox();
      ok(box.height >= 844 * 0.8, 'the window uses most of the screen (' + Math.round(box.height) + 'px)');
      await page.waitForTimeout(400);
      await shot(page, 'block-picker-phone');
      // Nach dem Scrollen bleibt die Suche oben sichtbar
      await page.evaluate(() => { document.querySelector('.modal-box.picker').scrollTop = 400; });
      await page.waitForTimeout(150);
      const s = await page.locator('#addSearch').boundingBox();
      const head = await page.locator('.modal-box.picker .modal-head').boundingBox();
      ok(s && s.y >= head.y + head.height && s.y < head.y + head.height + 40, 'the search stays fully visible below the head while scrolling (search ' + (s && Math.round(s.y)) + ', head ends ' + Math.round(head.y + head.height) + ')');
      const before = await blockTypes(page);
      await page.evaluate(() => { document.querySelector('.modal-box.picker').scrollTop = 0; });
      await page.locator('.add-item[data-add="link"]').tap();
      await page.waitForSelector('#modal.hidden', { state: 'attached' });
      ok((await blockTypes(page)) === before + 1, 'a tap added the block');
      await ctx.close();
    });
  } finally {
    await browser.close();
    site.stop();
    cleanup();
    summary('block-picker');
  }
})().catch((err) => {
  console.error(err);
  site.stop();
  process.exit(1);
});
