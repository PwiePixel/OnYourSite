// Ende-zu-Ende: der Bereich „Honeycombs“ auf dem Handy (honeycomb-shop Ablauf 7, 390 × 844). Die Leiste unten behält
// ihre 7 Punkte (Honeycombs steht nur auf dem Schreibtisch in der Leiste), der Kontostand oben öffnet den Bereich, die
// Karten stehen in einer Spalte, nichts scrollt seitlich, und der Kaufdialog passt auf den Schirm.
// Jeder native Dialog (alert/confirm/prompt) lässt den Lauf scheitern.
//   node tests/e2e/hc-mobile.js
// Startet die Seite selbst (Port OYS_E2E_PORT, Vorgabe 14206) und legt ein eigenes Testkonto an (id 9403 mit Seite 9413),
// das am Ende wieder verschwindet. Nur gegen eine Test-Datenbank (Name beginnt mit oys_test, sonst Abbruch mit Code 2
// vor jedem SQL). Umgebung: OYS_CONFIG, OYS_E2E_PASSWORD, OYS_E2E_ONLY, OYS_E2E_SHOTS.
'use strict';
const path = require('path');
const { chromium } = require('playwright');
const { ok, watchPage, step, summary } = require('./lib');
const { testSite } = require('./site');

const site = testSite(14206);
const { sql } = site;
const B = site.base;
const PASSWORD = process.env.OYS_E2E_PASSWORD || ['test', '1234'].join('');
const SHOTS = process.env.OYS_E2E_SHOTS || '';
const U = 9403, P = 9413;

function cleanup() {
  sql(`DELETE FROM page_blocks WHERE page_id IN (SELECT id FROM pages WHERE user_id = ${U});
    DELETE FROM pages WHERE user_id = ${U};
    DELETE FROM notifications WHERE user_id = ${U};
    DELETE FROM honeycomb_ledger WHERE user_id = ${U};
    DELETE FROM hc_entitlements WHERE user_id = ${U}; DELETE FROM hc_purchases WHERE user_id = ${U}; DELETE FROM hc_accounts WHERE user_id = ${U};
    DELETE FROM rate_limits WHERE rl_key IN ('hcbuy:${U}', 'hchist:${U}');
    DELETE FROM users WHERE id = ${U};`);
}
function fixtures() {
  cleanup();
  sql(`INSERT INTO users (id, email, password, full_name, username, created_at)
      SELECT ${U}, 'hc-mobile@test.de', password, 'Mobile Bee', 'mobilebee', '2026-01-01 10:00:00' FROM users WHERE id = 5;
    INSERT INTO pages (id, user_id, slug, position, title, subtitle, bio, theme, layout, address_mode, settings, created_at, updated_at)
      SELECT ${P}, ${U}, 'mobilebee', 0, 'Mobile Bee', '', '', theme, layout, 'subdomain', settings, NOW(), NOW() FROM pages WHERE id = 2;
    INSERT IGNORE INTO honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES
      (${U}, 0, 'daily', DATE_FORMAT(CURDATE() - INTERVAL 1 DAY, '%Y-%m-%d'), '', NOW()), (${U}, 0, 'daily', DATE_FORMAT(CURDATE(), '%Y-%m-%d'), '', NOW()),
      (${U}, 0, 'daily', DATE_FORMAT(CURDATE() + INTERVAL 1 DAY, '%Y-%m-%d'), '', NOW()),
      (${U}, 150, 'admin', CONCAT('a3-', LPAD(HEX(FLOOR(RAND() * 4294967295)), 16, '0')), 'Start', NOW());`);
}

let browser;
const IGNORED_CONSOLE = /tailwindcss|favicon|ERR_FAILED|net::|preload/;
const shot = async (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, name + '.png') });

(async () => {
  fixtures();
  await site.start();
  browser = await chromium.launch({ args: site.browserArgs });
  try {
    await step('phone: 7 items in the bottom bar, the pill opens the tab, one column, no sideways scrolling', async () => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const page = await ctx.newPage();
      watchPage(page);
      page.on('console', (m) => { if (m.type() === 'error' && !IGNORED_CONSOLE.test(m.text())) ok(false, 'console error: ' + m.text()); });
      await page.goto(B + '/login');
      await page.fill('input[name=email]', 'hc-mobile@test.de');
      await page.fill('input[name=password]', PASSWORD);
      await Promise.all([page.waitForNavigation(), page.click('form[action="/login"] button[type=submit]')]);
      await page.goto(B + '/dashboard?page=' + P + '&load=1#content');
      await page.waitForSelector('#blockList, #tab-content > *');
      const visible = await page.evaluate(() => [...document.querySelectorAll('#mainNav > .nav-btn')].filter((b) => b.getClientRects().length > 0 && getComputedStyle(b).display !== 'none').map((b) => b.textContent.trim()));
      ok(visible.length === 7, 'the bottom bar keeps 7 items (' + visible.join(', ') + ')');
      ok(!visible.some((t) => /Honeycombs/.test(t)), 'no Honeycombs item in the bottom bar');
      await page.tap('#hcBtn');
      await page.waitForSelector('#tab-honeycombs:not(.hidden) .shop-wallet');
      ok(await page.isVisible('#shop-code_page'), 'the pill opens the tab with the shop');
      const cols = await page.evaluate(() => getComputedStyle(document.querySelector('.shop-grid')).gridTemplateColumns.split(' ').filter(Boolean).length);
      ok(cols === 1, 'the shop grid has one column (' + cols + ')');
      const wide = await page.evaluate(() => {
        const main = document.getElementById('editorScroll');
        return { doc: document.documentElement.scrollWidth, win: window.innerWidth, main: main.scrollWidth, mainW: main.clientWidth };
      });
      ok(wide.doc <= wide.win && wide.main <= wide.mainW, 'no horizontal scroll (' + JSON.stringify(wide) + ')');
      await shot(page, 'hc-mobile-tab');
      // Der Kaufdialog passt auf den Schirm
      await page.tap('#shop-code_page [data-shop-buy]');
      await page.waitForSelector('.ui-dialog');
      const box = await page.locator('.ui-dialog').boundingBox();
      ok(box && box.x >= 0 && box.x + box.width <= 390, 'the purchase dialog fits the screen (' + JSON.stringify(box) + ')');
      ok(await page.locator('.ui-dialog input[name=terms]').isVisible(), 'the rules box is visible');
      await shot(page, 'hc-mobile-dialog');
      await page.locator('.ui-dialog .ui-foot .ui-btn', { hasText: 'Cancel' }).tap();
      await page.waitForSelector('.ui-dialog', { state: 'detached' });
      ok(sql(`SELECT COUNT(*) FROM hc_purchases WHERE user_id = ${U}`) === '0', 'cancel buys nothing');
      await ctx.close();
    });
  } finally {
    await browser.close();
    site.stop();
    cleanup();
  }
  summary('hc-mobile');
})().catch((err) => {
  console.error(err);
  try { site.stop(); } catch (e) { /* egal */ }
  try { cleanup(); } catch (e) { /* Datenbank nicht erreichbar */ }
  process.exitCode = 1;
});
