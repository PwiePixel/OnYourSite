// Ende-zu-Ende: die Designs für Winter und Weihnachten (D3) – im Editor der Filter „Winter & Christmas“ mit fünf
// Karten und dem Schild „Winter“, ein Klick setzt das Design in der Vorschau und wird gespeichert; jede Demo-Seite
// (/_/demo/<design>) zeigt ihr Design ohne Fehler und ohne seitliches Scrollen am Handy.
// Jeder native Dialog (alert/confirm/prompt) lässt den Lauf scheitern.
//   node tests/e2e/themes-winter.js
// Startet die Seite selbst (Port OYS_E2E_PORT, Vorgabe 14209) und legt ein eigenes Testkonto an (id 9406 mit Seite 9416),
// das am Ende wieder verschwindet. Nur gegen eine Test-Datenbank (Name beginnt mit oys_test, sonst Abbruch mit Code 2
// vor jedem SQL). Umgebung: OYS_CONFIG, OYS_E2E_PASSWORD, OYS_E2E_ONLY, OYS_E2E_SHOTS (Bildschirmfotos jedes Designs).
'use strict';
const path = require('path');
const { chromium } = require('playwright');
const { ok, watchPage, step, summary } = require('./lib');
const { testSite } = require('./site');

const site = testSite(14209);
const { sql } = site;
const B = site.base;
const PASSWORD = process.env.OYS_E2E_PASSWORD || ['test', '1234'].join('');
const SHOTS = process.env.OYS_E2E_SHOTS || '';
const U = 9406, P = 9416;
const WINTER = ['snowy-night', 'candy-cane', 'gingerbread', 'christmas-market', 'frost'];

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
      SELECT ${U}, 'winter@test.de', password, 'Winter Bee', 'winterbee', '2026-01-01 10:00:00' FROM users WHERE id = 5;
    INSERT INTO pages (id, user_id, slug, position, title, subtitle, bio, theme, layout, address_mode, settings, created_at, updated_at)
      SELECT ${P}, ${U}, 'winterbee', 0, 'Winter Bee', '', '', 'deep-dark', layout, 'subdomain', settings, NOW(), NOW() FROM pages WHERE id = 2;
    INSERT IGNORE INTO honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES
      (${U}, 0, 'daily', DATE_FORMAT(CURDATE() - INTERVAL 1 DAY, '%Y-%m-%d'), '', NOW()), (${U}, 0, 'daily', DATE_FORMAT(CURDATE(), '%Y-%m-%d'), '', NOW()),
      (${U}, 0, 'daily', DATE_FORMAT(CURDATE() + INTERVAL 1 DAY, '%Y-%m-%d'), '', NOW());`);
}

let browser;
const IGNORED_CONSOLE = /tailwindcss|favicon|ERR_FAILED|net::|preload|404/;
const shot = async (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, name + '.png') });

(async () => {
  fixtures();
  await site.start();
  browser = await chromium.launch({ args: site.browserArgs });
  try {
    await step('editor: the "Winter & Christmas" filter shows the five themes, a click sets one and it is saved', async () => {
      const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      const page = await ctx.newPage();
      watchPage(page);
      page.on('console', (m) => { if (m.type() === 'error' && !IGNORED_CONSOLE.test(m.text())) ok(false, 'console error: ' + m.text()); });
      await page.goto(B + '/login');
      await page.fill('input[name=email]', 'winter@test.de');
      await page.fill('input[name=password]', PASSWORD);
      await Promise.all([page.waitForNavigation(), page.click('form[action="/login"] button[type=submit]')]);
      await page.goto(B + '/dashboard?page=' + P + '&load=1#design');
      await page.waitForSelector('#themeFilter [data-filter="seasonal"]');
      const chip = (await page.innerText('#themeFilter [data-filter="seasonal"]')).replace(/\s+/g, ' ').trim();
      ok(chip === 'Winter & Christmas 5', 'the filter chip reads "Winter & Christmas 5" (' + chip + ')');
      ok(/35 themes/.test(await page.innerText('#tab-design .section-title')), 'the gallery counts 35 themes');
      await page.click('#themeFilter [data-filter="seasonal"]');
      const cards = await page.$$eval('#themeGrid .theme-card', (els) => els.map((e) => e.dataset.theme));
      ok(JSON.stringify(cards) === JSON.stringify(WINTER), 'exactly the five winter themes (' + cards.join(', ') + ')');
      const tags = await page.$$eval('#themeGrid .theme-tag.winter', (els) => els.map((e) => e.textContent.trim().toLowerCase()));
      ok(tags.length === 5 && tags.every((t) => t === 'winter'), 'each card has the "Winter" tag');
      await page.waitForTimeout(500);
      await shot(page, 'winter-gallery');
      await page.click('#themeGrid .theme-card[data-theme="candy-cane"]');
      await page.waitForFunction(() => [...document.querySelectorAll('#pvA, #pvB')].some((f) => {
        try { return f.contentDocument && f.contentDocument.body && f.contentDocument.body.classList.contains('t-candy-cane'); } catch (e) { return false; }
      }), null, { timeout: 10000 }).then(() => ok(true, 'the preview shows Candy Cane'), () => ok(false, 'the preview shows Candy Cane'));
      await page.click('#saveBtn');
      await page.waitForTimeout(1200);
      ok(sql(`SELECT theme FROM pages WHERE id = ${P}`) === 'candy-cane', 'the theme is saved');
      await ctx.close();
    });

    await step('demo pages: every winter theme renders on a phone without errors or sideways scrolling', async () => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      for (const k of WINTER) {
        const page = await ctx.newPage();
        watchPage(page);
        page.on('console', (m) => { if (m.type() === 'error' && !IGNORED_CONSOLE.test(m.text())) ok(false, k + ': console error: ' + m.text()); });
        const res = await page.goto(B + '/_/demo/' + k, { waitUntil: 'networkidle' });
        ok(res.status() === 200, k + ': 200');
        ok(await page.evaluate((key) => document.body.classList.contains('t-' + key), k), k + ': the page uses its theme');
        const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        ok(wide <= 0, k + ': no sideways scrolling (' + wide + ')');
        await page.waitForTimeout(300);
        await shot(page, 'winter-' + k);
        await page.close();
      }
      await ctx.close();
    });
  } finally {
    await browser.close();
    site.stop();
    cleanup();
    summary('themes-winter');
  }
})().catch((err) => {
  console.error(err);
  site.stop();
  process.exit(1);
});
