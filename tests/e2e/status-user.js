// Ende-zu-Ende: Statusseiten für Nutzer (status-pages ST-4). Ein Konto ohne Freischaltung sieht keinen Bereich
// „Status“; im Bereich „Honeycombs“ kauft es die Statusseite (150), „Open“ lädt den Editor in den Bereich „Status“;
// dort legt es Name und Adresse an, sieht die Seite, ändert den Namen und löscht sie über den Dialog der Seite.
// Jeder native Dialog (alert/confirm/prompt) lässt den Lauf scheitern.
//   node tests/e2e/status-user.js
// Startet die Seite selbst (Port OYS_E2E_PORT, Vorgabe 14207) und legt ein eigenes Testkonto an (id 9451 mit Seite 9461),
// das am Ende wieder verschwindet. Nur gegen eine Test-Datenbank (Name beginnt mit oys_test, sonst Abbruch mit Code 2
// vor jedem SQL). Umgebung: OYS_CONFIG, OYS_E2E_PASSWORD, OYS_E2E_ONLY, OYS_E2E_SHOTS (Ordner für Bildschirmfotos).
'use strict';
const path = require('path');
const { chromium } = require('playwright');
const { ok, watchPage, step, summary } = require('./lib');
const { testSite } = require('./site');

const site = testSite(14207);
const { sql, count } = site;
const B = site.base;
const PASSWORD = process.env.OYS_E2E_PASSWORD || ['test', '1234'].join('');
const SHOTS = process.env.OYS_E2E_SHOTS || '';
const U = 9451, P = 9461;
const SLUG = 'e2e-st4-status';

function cleanup() {
  sql(`DELETE FROM status_monitors WHERE page_id IN (SELECT id FROM status_pages WHERE user_id = ${U});
    DELETE FROM status_pages WHERE user_id = ${U};
    DELETE FROM site_addresses WHERE slug = '${SLUG}' OR user_id = ${U};
    DELETE FROM page_blocks WHERE page_id IN (SELECT id FROM pages WHERE user_id = ${U});
    DELETE FROM pages WHERE user_id = ${U};
    DELETE FROM notifications WHERE user_id = ${U};
    DELETE FROM honeycomb_ledger WHERE user_id = ${U};
    DELETE FROM hc_entitlements WHERE user_id = ${U}; DELETE FROM hc_purchases WHERE user_id = ${U}; DELETE FROM hc_accounts WHERE user_id = ${U};
    DELETE FROM rate_limits WHERE rl_key IN ('hcbuy:${U}', 'hchist:${U}', 'statuscreate:${U}');
    DELETE FROM users WHERE id = ${U};`);
}
function fixtures(balance) {
  cleanup();
  sql(`INSERT INTO users (id, email, password, full_name, username, created_at)
      SELECT ${U}, 'st4-user@test.de', password, 'Status Owner', 'statusowner', '2026-01-01 10:00:00' FROM users WHERE id = 5;
    INSERT INTO pages (id, user_id, slug, position, title, subtitle, bio, theme, layout, address_mode, settings, created_at, updated_at)
      SELECT ${P}, ${U}, 'statusowner', 0, 'Status Owner', '', '', theme, layout, 'subdomain', settings, NOW(), NOW() FROM pages WHERE id = 2;
    INSERT IGNORE INTO honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES
      (${U}, 0, 'daily', DATE_FORMAT(CURDATE() - INTERVAL 1 DAY, '%Y-%m-%d'), '', NOW()), (${U}, 0, 'daily', DATE_FORMAT(CURDATE(), '%Y-%m-%d'), '', NOW()),
      (${U}, 0, 'daily', DATE_FORMAT(CURDATE() + INTERVAL 1 DAY, '%Y-%m-%d'), '', NOW()),
      (${U}, ${balance}, 'admin', CONCAT('a3-', LPAD(HEX(FLOOR(RAND() * 4294967295)), 16, '0')), 'Start', NOW());`);
}

let browser;
const IGNORED_CONSOLE = /tailwindcss|favicon|ERR_FAILED|net::|preload/;
async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  watchPage(page);
  page.on('console', (m) => { if (m.type() === 'error' && !IGNORED_CONSOLE.test(m.text())) ok(false, 'console error: ' + m.text()); });
  return { ctx, page };
}
async function login(page, email) {
  await page.goto(B + '/login');
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', PASSWORD);
  await Promise.all([page.waitForNavigation(), page.click('form[action="/login"] button[type=submit]')]);
}
const shot = async (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, name + '.png') });

(async () => {
  cleanup();
  await site.start();
  browser = await chromium.launch({ args: site.browserArgs });
  try {
    await step('buy the status page in the shop, “Open” leads into the Status tab, create, rename and delete the page', async () => {
      fixtures(200);
      const { ctx, page } = await newPage();
      await login(page, 'st4-user@test.de');
      await page.goto(B + '/dashboard?page=' + P + '#honeycombs');
      await page.waitForSelector('#tab-honeycombs:not(.hidden) .shop-wallet');
      ok(await page.locator('[data-tab="status"]').count() === 0, 'no Status tab without the unlock');
      const card = page.locator('#shop-status_page');
      ok(await card.count() === 1, 'the shop shows the status page card');
      ok((await card.innerText()).includes('150'), 'the card shows 150 honeycombs');
      await page.click('#shop-status_page [data-shop-buy]');
      await page.locator('.ui-dialog').waitFor();
      await page.locator('.ui-dialog .ui-foot .ui-btn.is-hc').click();
      await page.locator('.ui-dialog').waitFor({ state: 'detached' });
      await page.locator('#shop-status_page .bdg.green').waitFor();
      ok(count(`SELECT COUNT(*) FROM honeycomb_ledger WHERE user_id = ${U} AND reason = 'unlock' AND amount = -150`) === 1, 'one unlock booked: −150');
      await Promise.all([page.waitForNavigation(), page.click('#shop-status_page [data-shop-open]')]);
      await page.locator('#tab-status:not(.hidden) #stmNewTitle').waitFor();
      ok(await page.locator('[data-tab="status"]').count() >= 1, 'the Status tab is there after the unlock');
      await shot(page, 'st4-create');
      // Ungültige Adresse: die Meldung des Servers erscheint im Formular
      await page.fill('#stmNewTitle', 'Owner <b>status</b>');
      await page.fill('#stmNewSlug', 'status');
      await page.click('[data-stm="create-page"]');
      await page.locator('.st-m-err:not([hidden])').waitFor();
      ok((await page.locator('.st-m-err').innerText()).length > 0, 'an address error is shown in the form');
      await page.fill('#stmNewSlug', SLUG);
      await page.click('[data-stm="create-page"]');
      await page.locator('.st-m-headcard').waitFor();
      ok((await page.locator('.st-m-headcard h2').innerText()).includes('Owner <b>status</b>'), 'the name is shown as text');
      ok((await page.locator('.st-m-url').innerText()).includes(SLUG + '.'), 'the page lives on its own subdomain');
      ok(await page.locator('[data-stm-tab="alerts"]').count() === 0, 'no admin alerts tab on a user page');
      ok(count(`SELECT COUNT(*) FROM status_pages WHERE user_id = ${U} AND slug = '${SLUG}' AND is_system = 0`) === 1, 'the page is stored for the account');
      await shot(page, 'st4-page');
      // Bestandteile mit Zustand: Leiste und Abzeichen in der Farbe des Zustands
      sql(`INSERT INTO status_monitors (page_id, user_id, type, name, group_name, is_public, target, config, interval_s, manual_status, manual_since, changed_at, created_at, updated_at)
        SELECT id, ${U}, 'manual', 'Website', '', 1, '', '{}', 300, 'operational', UNIX_TIMESTAMP(), 0, NOW(), NOW() FROM status_pages WHERE user_id = ${U};
        INSERT INTO status_monitors (page_id, user_id, type, name, group_name, is_public, target, config, interval_s, manual_status, manual_since, changed_at, created_at, updated_at)
        SELECT id, ${U}, 'manual', 'Payments', '', 1, '', '{}', 300, 'major', UNIX_TIMESTAMP(), 0, NOW(), NOW() FROM status_pages WHERE user_id = ${U};`);
      await page.goto(B + '/dashboard?page=' + P + '&load=2#status');
      await page.locator('#tab-status .st-m-row').first().waitFor();
      ok(await page.locator('#tab-status .st-m-row').count() === 2, 'both components are listed');
      ok(await page.locator('#tab-status .st-m-row.st-m-r-down').count() === 1, 'the major outage row carries the down colour');
      await shot(page, 'st4-components');
      // Namen ändern
      await page.click('[data-stm-tab="settings"]');
      await page.fill('#stmBody [name=title]', 'Owner services');
      await page.click('[data-stm="save-page"]');
      await page.locator('.st-m-headcard h2', { hasText: 'Owner services' }).waitFor();
      ok(true, 'the new name is saved');
      // Löschen über den Dialog der Seite
      await page.click('[data-stm-tab="settings"]');
      await page.click('[data-stm="delete-page"]');
      await page.locator('.ui-dialog').waitFor();
      await page.locator('.ui-dialog .ui-foot .ui-btn.is-danger').click();
      await page.locator('#stmNewTitle').waitFor();
      ok(count(`SELECT COUNT(*) FROM status_pages WHERE user_id = ${U}`) === 0, 'the page is deleted');
      ok(sql(`SELECT CONCAT(kind, '|', user_id) FROM site_addresses WHERE slug = '${SLUG}'`) === 'held|' + U, 'the address stays reserved for the owner');
      await ctx.close();
    });
  } finally {
    await browser.close();
    site.stop();
    cleanup();
  }
  summary('status-user');
})().catch((err) => {
  console.error(err);
  try { site.stop(); } catch (e) { /* egal */ }
  try { cleanup(); } catch (e) { /* Datenbank nicht erreichbar */ }
  process.exitCode = 1;
});
