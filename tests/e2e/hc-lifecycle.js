// Ende-zu-Ende: Hinweise zum Ende zeitlich begrenzter Freischaltungen (honeycomb-shop HC-7a, §5.2). Endet Premium in
// 2 Tagen, steht über dem Kontostand ein gelber Hinweis mit „Renew“ und „Hide for today“ (danach bis morgen weg, auch
// nach dem Neuladen); ist Premium seit 3 Tagen beendet, ein grauer mit „Renew“ und „Dismiss“ (für dieses Ende weg).
// Ohne gespeicherte Auswahl im Browser (localStorage gesperrt) erscheint der Hinweis einfach wieder. Schmal ohne
// waagrechtes Verschieben. Jeder native Dialog (alert/confirm/prompt) lässt den Lauf scheitern.
//   node tests/e2e/hc-lifecycle.js
// Startet die Seite selbst (Port OYS_E2E_PORT, Vorgabe 14208) und legt ein eigenes Testkonto an (id 9403 mit Seite 9413),
// das am Ende wieder verschwindet. Nur gegen eine Test-Datenbank (Name beginnt mit oys_test, sonst Abbruch mit Code 2
// vor jedem SQL). Umgebung: OYS_CONFIG, OYS_E2E_PASSWORD, OYS_E2E_SHOTS.
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
const U = 9403, P = 9413;

function cleanup() {
  sql(`DELETE FROM page_blocks WHERE page_id IN (SELECT id FROM pages WHERE user_id = ${U});
    DELETE FROM pages WHERE user_id = ${U};
    DELETE FROM notifications WHERE user_id = ${U};
    DELETE FROM honeycomb_ledger WHERE user_id = ${U};
    DELETE FROM hc_entitlements WHERE user_id = ${U}; DELETE FROM hc_purchases WHERE user_id = ${U}; DELETE FROM hc_accounts WHERE user_id = ${U};
    DELETE FROM rate_limits WHERE rl_key IN ('hcbuy:${U}', 'hchist:${U}');
    DELETE FROM users WHERE id = ${U};
    UPDATE hc_items SET is_active = 0 WHERE item_key = 'premium_30';`);
}
// Premium endet in 2 Tagen (> 0) oder endete vor 3 Tagen (< 0); heute schon aktiv gewesen (keine Meldungen). Die
// Option premium_30 ist für den Lauf eingeschaltet (sonst gibt es keine Karte und kein „Renew“)
function fixtures(endsInDays) {
  cleanup();
  const at = `NOW() ${endsInDays >= 0 ? '+' : '-'} INTERVAL ${Math.abs(endsInDays) * 24} HOUR`;
  sql(`INSERT INTO users (id, email, password, full_name, username, created_at, premium_until)
      SELECT ${U}, 'hc-life@test.de', password, 'Life Cycle', 'lifecycle', '2026-01-01 10:00:00', ${at} FROM users WHERE id = 5;
    INSERT INTO pages (id, user_id, slug, position, title, subtitle, bio, theme, layout, address_mode, settings, created_at, updated_at)
      SELECT ${P}, ${U}, 'lifecycle', 0, 'Life Cycle', '', '', theme, layout, 'subdomain', settings, NOW(), NOW() FROM pages WHERE id = 2;
    INSERT INTO hc_accounts (user_id, streak, streak_day, best_streak, created_at, updated_at) VALUES (${U}, 1, CURDATE(), 1, NOW(), NOW());
    INSERT INTO honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (${U}, 0, 'daily', DATE_FORMAT(NOW(), '%Y-%m-%d'), '', NOW());
    INSERT INTO hc_entitlements (user_id, feature, lot, quantity, permanent, expires_at, source, reminded, expiry_done_at, created_at, updated_at)
      VALUES (${U}, 'premium', 0, 1, 0, ${at}, 'purchase', 2, ${endsInDays < 0 ? 'NOW()' : 'NULL'}, NOW(), NOW());
    UPDATE hc_items SET is_active = 1 WHERE item_key = 'premium_30';`);
}

let browser;
const IGNORED_CONSOLE = /tailwindcss|favicon|ERR_FAILED|net::|preload/;
async function newPage(width = 1400, height = 900) {
  const ctx = await browser.newContext({ viewport: { width, height } });
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
    await step('Premium ends in 2 days: a yellow notice with Renew; “Hide for today” keeps it away after a reload', async () => {
      fixtures(2);
      const { ctx, page } = await newPage();
      await login(page, 'hc-life@test.de');
      // Der Katalog entsteht beim ersten Lesen des Shops: danach die Option einschalten
      await page.goto(B + '/dashboard?page=' + P + '&load=0#honeycombs');
      await page.waitForSelector('#tab-honeycombs:not(.hidden) .shop-wallet');
      sql("UPDATE hc_items SET is_active = 1 WHERE item_key = 'premium_30'");
      await page.goto(B + '/dashboard?page=' + P + '&load=1#honeycombs');
      await page.waitForSelector('#tab-honeycombs:not(.hidden) .shop-wallet');
      const ban = page.locator('#tab-honeycombs .shop-banner.warn.shop-end');
      ok(await ban.count() === 1, 'one “ends soon” notice');
      ok((await ban.innerText()).includes('Premium ends in 2 days'), 'text: Premium ends in 2 days (' + (await ban.innerText()).trim() + ')');
      ok(await ban.locator('[data-shop-renew="premium"]').count() === 1, 'Renew button');
      await shot(page, 'hc-lifecycle-soon');
      await ban.locator('[data-end-dismiss]').click();
      ok(await ban.count() === 0, 'hidden at once');
      await page.goto(B + '/dashboard?page=' + P + '&load=2#honeycombs');
      await page.waitForSelector('#tab-honeycombs:not(.hidden) .shop-wallet');
      ok(await page.locator('#tab-honeycombs .shop-end').count() === 0, 'still hidden after a reload (today)');
      await ctx.close();
    });

    await step('without browser storage the notice simply comes back', async () => {
      const { ctx, page } = await newPage();
      await ctx.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } }); });
      await login(page, 'hc-life@test.de');
      await page.goto(B + '/dashboard?page=' + P + '&load=3#honeycombs');
      await page.waitForSelector('#tab-honeycombs:not(.hidden) .shop-wallet');
      const ban = page.locator('#tab-honeycombs .shop-end');
      ok(await ban.count() === 1, 'notice shown');
      await ban.locator('[data-end-dismiss]').click();
      ok(await ban.count() === 0, 'hidden for now');
      await page.goto(B + '/dashboard?page=' + P + '&load=4#honeycombs');
      await page.waitForSelector('#tab-honeycombs:not(.hidden) .shop-wallet');
      ok(await page.locator('#tab-honeycombs .shop-end').count() === 1, 'back after a reload');
      await ctx.close();
    });

    await step('Premium ended 3 days ago: a grey notice with Renew and Dismiss; phone width fits', async () => {
      fixtures(-3);
      const { ctx, page } = await newPage(390, 844);
      await login(page, 'hc-life@test.de');
      await page.goto(B + '/dashboard?page=' + P + '&load=5#honeycombs');
      await page.waitForSelector('#tab-honeycombs:not(.hidden) .shop-wallet');
      const ban = page.locator('#tab-honeycombs .shop-banner.ended.shop-end');
      ok(await ban.count() === 1 && (await ban.innerText()).includes('Premium ended on'), 'one “ended” notice');
      ok(await ban.locator('[data-shop-renew="premium"]').count() === 1, 'Renew button');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      ok(overflow <= 0, 'no horizontal page scroll (' + overflow + ')');
      await shot(page, 'hc-lifecycle-ended-phone');
      await ban.locator('[data-end-dismiss]').click();
      await page.goto(B + '/dashboard?page=' + P + '&load=6#honeycombs');
      await page.waitForSelector('#tab-honeycombs:not(.hidden) .shop-wallet');
      ok(await page.locator('#tab-honeycombs .shop-end').count() === 0, 'dismissed for this end');
      await ctx.close();
    });
  } finally {
    await browser.close();
    site.stop();
    cleanup();
  }
  summary('hc-lifecycle');
})().catch((err) => {
  console.error(err);
  try { site.stop(); } catch (e) { /* egal */ }
  try { cleanup(); } catch (e) { /* Datenbank nicht erreichbar */ }
  process.exitCode = 1;
});
