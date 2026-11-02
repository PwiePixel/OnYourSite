// Ende-zu-Ende: Angebote im Bereich „Honeycombs“ (honeycomb-shop Ablauf 3). Ein Admin legt im Admin-Bereich ein Angebot
// über 30 % an → der Nutzer sieht den durchgestrichenen Preis und das Abzeichen (der Name des Angebots als reiner Text)
// und kauft zum Angebotspreis; der Admin ändert den Preis, während der Dialog offen ist → der Dialog bleibt offen mit
// „The price changed“ und „Buy for …“ und kauft mit derselben Kennung zum neuen Preis.
// Jeder native Dialog (alert/confirm/prompt) lässt den Lauf scheitern.
//   node tests/e2e/hc-offer.js
// Startet die Seite selbst (Port OYS_E2E_PORT, Vorgabe 14206) und legt ein eigenes Testkonto an (id 9402 mit Seite 9412),
// das am Ende wieder verschwindet; Angebote mit dem Namen „e2e …“ werden gelöscht und der Preis der Code-Seite steht
// danach wieder auf 100. Nur gegen eine Test-Datenbank (Name beginnt mit oys_test, sonst Abbruch mit Code 2 vor jedem
// SQL). Umgebung: OYS_CONFIG, OYS_E2E_PASSWORD, OYS_E2E_ONLY, OYS_E2E_SHOTS.
'use strict';
const path = require('path');
const { chromium } = require('playwright');
const { ok, watchPage, step, summary, sleep } = require('./lib');
const { testSite } = require('./site');

const site = testSite(14206);
const { sql, count } = site;
const B = site.base;
const PASSWORD = process.env.OYS_E2E_PASSWORD || ['test', '1234'].join('');
const SHOTS = process.env.OYS_E2E_SHOTS || '';
const U = 9402, P = 9412;
const LABEL = 'e2e <b>Launch</b> deal';

function cleanup() {
  sql(`DELETE FROM page_blocks WHERE page_id IN (SELECT id FROM pages WHERE user_id = ${U});
    DELETE FROM pages WHERE user_id = ${U};
    DELETE FROM notifications WHERE user_id = ${U};
    DELETE FROM honeycomb_ledger WHERE user_id = ${U};
    DELETE FROM hc_entitlements WHERE user_id = ${U}; DELETE FROM hc_purchases WHERE user_id = ${U}; DELETE FROM hc_accounts WHERE user_id = ${U};
    DELETE FROM rate_limits WHERE rl_key IN ('hcbuy:${U}', 'hchist:${U}');
    DELETE FROM users WHERE id = ${U};
    DELETE FROM hc_offers WHERE label LIKE 'e2e%';
    UPDATE hc_items SET price = 100 WHERE item_key = 'code_page';`);
}
function fixtures(balance) {
  cleanup();
  sql(`INSERT INTO users (id, email, password, full_name, username, created_at, code_terms_at)
      SELECT ${U}, 'hc-offer@test.de', password, 'Offer Hunter', 'offerhunter', '2026-01-01 10:00:00', NOW() FROM users WHERE id = 5;
    INSERT INTO pages (id, user_id, slug, position, title, subtitle, bio, theme, layout, address_mode, settings, created_at, updated_at)
      SELECT ${P}, ${U}, 'offerhunter', 0, 'Offer Hunter', '', '', theme, layout, 'subdomain', settings, NOW(), NOW() FROM pages WHERE id = 2;
    INSERT IGNORE INTO honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES
      (${U}, 0, 'daily', DATE_FORMAT(CURDATE() - INTERVAL 1 DAY, '%Y-%m-%d'), '', NOW()), (${U}, 0, 'daily', DATE_FORMAT(CURDATE(), '%Y-%m-%d'), '', NOW()),
      (${U}, 0, 'daily', DATE_FORMAT(CURDATE() + INTERVAL 1 DAY, '%Y-%m-%d'), '', NOW()),
      (${U}, ${balance}, 'admin', CONCAT('a3-', LPAD(HEX(FLOOR(RAND() * 4294967295)), 16, '0')), 'Start', NOW());`);
}
// Ein Angebot direkt in der Datenbank (für den Schritt, der nur den Dialog prüft)
const offer = (percent) => sql(`INSERT INTO hc_offers (label, scope, percent_off, fixed_price, starts_at, ends_at, max_uses, uses, per_user_max, min_account_days,
    min_active_days, cancelled_at, form_ref, created_by, created_at) VALUES ('e2e sale', 'item:code_page', ${percent}, NULL, NOW() - INTERVAL 1 DAY,
    NOW() + INTERVAL 3 DAY, NULL, 0, NULL, 0, 0, NULL, LPAD(HEX(FLOOR(RAND() * 4294967295)), 16, '0'), 3, NOW())`);

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
let loads = 0;
async function shopTab(page) {
  await page.goto(B + '/dashboard?page=' + P + '&load=' + ++loads + '#honeycombs');
  await page.waitForSelector('#tab-honeycombs:not(.hidden) .shop-wallet');
}
const shot = async (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, name + '.png') });
const dlg = (page) => page.locator('.ui-dialog');
const okButton = (page) => page.locator('.ui-dialog .ui-foot .ui-btn.is-hc');

(async () => {
  cleanup();
  await site.start();
  browser = await chromium.launch({ args: site.browserArgs });
  try {
    await step('the admin creates a 30 % offer; the user sees the struck-through price and the badge and buys at the discount', async () => {
      fixtures(150);
      // Admin: Angebot über das Formular im Bereich „Honeycombs“ → „Offers“
      const admin = await newPage();
      await login(admin.page, 'admin@test.de');
      await admin.page.goto(B + '/admin?hc_tab=offers#honeycombs');
      await admin.page.waitForSelector('#hcOfferForm');
      await admin.page.fill('#hcOfferForm [name=label]', LABEL);
      await admin.page.selectOption('#hcOfferForm [name=scope]', 'item:code_page');
      await admin.page.fill('#hcOfferForm [name=percent_off]', '30');
      const pad = (n) => String(n).padStart(2, '0');
      const local = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      const now = new Date();
      await admin.page.fill('#hcOfferForm [name=starts_at]', local(new Date(now.getTime() - 3600e3)));
      await admin.page.fill('#hcOfferForm [name=ends_at]', local(new Date(now.getTime() + 3 * 864e5)));
      await Promise.all([admin.page.waitForNavigation(), admin.page.click('#hcOfferForm button[type=submit]')]);
      const flash = admin.page.locator('.ui-toast', { hasText: 'created' });
      await flash.waitFor();
      ok((await flash.innerText()).includes('Offer “' + LABEL + '” created.'), 'offer created in the admin (' + (await flash.innerText()) + ')');
      ok(count("SELECT COUNT(*) FROM hc_offers WHERE label LIKE 'e2e%' AND percent_off = 30 AND scope = 'item:code_page'") === 1, 'one offer stored');
      await shot(admin.page, 'hc-offer-admin');

      const { ctx, page } = await newPage();
      await login(page, 'hc-offer@test.de');
      await shopTab(page);
      const cardEl = page.locator('#shop-code_page');
      ok((await cardEl.locator('.shop-price b').innerText()) === '70', 'offer price 70');
      ok((await cardEl.locator('.shop-price s').innerText()) === '100', 'list price 100 struck through');
      const badge = cardEl.locator('.shop-badges .bdg.hc');
      ok((await badge.innerText()).includes(LABEL + ' · −30 % · ends'), 'badge with the offer name, the discount and the end (' + (await badge.innerText()) + ')');
      ok(await badge.locator('b').count() === 0, 'the offer name is shown as text, not as markup');
      await shot(page, 'hc-offer-card');
      await cardEl.locator('[data-shop-buy]').click();
      await dlg(page).waitFor();
      ok((await page.locator('.ui-dialog .hc-big b').innerText()) === '70', 'the dialog shows 70');
      await okButton(page).click();
      await dlg(page).waitFor({ state: 'detached' });
      await page.locator('#shop-code_page .bdg.green').waitFor();
      ok(sql(`SELECT CONCAT(p.price, '|', p.list_price, '|', o.label) FROM hc_purchases p JOIN hc_offers o ON o.id = p.offer_id WHERE p.user_id = ${U}`) === '70|100|' + LABEL,
        'bought at 70 with the offer recorded');
      ok(count("SELECT uses FROM hc_offers WHERE label LIKE 'e2e%'") === 1, 'the offer counts one use');
      ok((await page.locator('#hcBalance').innerText()).trim() === '80', 'balance 80');
      await ctx.close();
      await admin.ctx.close();
    });

    await step('the admin changes the price while the dialog is open: it stays open with the new price and buys at it', async () => {
      fixtures(300);
      offer(30);
      const { ctx, page } = await newPage();
      await login(page, 'hc-offer@test.de');
      await shopTab(page);
      await page.click('#shop-code_page [data-shop-buy]');
      await dlg(page).waitFor();
      ok((await okButton(page).innerText()).includes('Buy for 70'), 'dialog offers “Buy for 70”');
      // Admin: neuer Listenpreis 400 im Bereich „Catalogue & prices“ (mit dem Angebot: 280)
      const admin = await newPage();
      await login(admin.page, 'admin@test.de');
      await admin.page.goto(B + '/admin?hc_tab=catalogue#honeycombs');
      const row = admin.page.locator('form[data-item="code_page"]');
      await row.waitFor();
      await row.locator('[name=price]').fill('400');
      await Promise.all([admin.page.waitForNavigation(), row.locator('button[type=submit]').click()]);
      ok(count("SELECT price FROM hc_items WHERE item_key = 'code_page'") === 400, 'the admin saved the new price');
      await admin.ctx.close();

      await okButton(page).click();
      const msg = page.locator('.ui-dialog .ui-msg');
      await msg.waitFor();
      ok((await msg.innerText()) === 'The price changed – this now costs 280 honeycombs (it was 70).', 'the dialog says the price changed (' + (await msg.innerText()) + ')');
      ok((await okButton(page).innerText()).includes('Buy for 280'), 'button “Buy for 280”');
      ok((await page.locator('.ui-dialog .hc-big b').innerText()) === '280', 'the price box shows 280');
      ok(count(`SELECT COUNT(*) FROM hc_purchases WHERE user_id = ${U}`) === 0, 'nothing bought on a price change');
      await shot(page, 'hc-offer-price-changed');
      await okButton(page).click();
      await dlg(page).waitFor({ state: 'detached' });
      await sleep(200);
      ok(sql(`SELECT CONCAT(price, '|', list_price) FROM hc_purchases WHERE user_id = ${U}`) === '280|400', 'bought at the new price (280 of 400)');
      ok((await page.locator('#hcBalance').innerText()).trim() === '20', 'balance 20');
      await ctx.close();
    });
  } finally {
    await browser.close();
    site.stop();
    cleanup();
  }
  summary('hc-offer');
})().catch((err) => {
  console.error(err);
  try { site.stop(); } catch (e) { /* egal */ }
  try { cleanup(); } catch (e) { /* Datenbank nicht erreichbar */ }
  process.exitCode = 1;
});
