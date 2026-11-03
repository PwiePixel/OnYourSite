// Ende-zu-Ende: Zusatzpakete und Premium einer Statusseite (status-pages ST-7). Mit dem Paket „Extra checks“ zeigt der
// Bereich „Status“ 20 Prüfungen und das Ende des Pakets; ohne Premium ist der Schalter „Hide “Made with OnYourSite”“
// gesperrt („Comes with Premium.“), mit Premium lässt er sich speichern – die öffentliche Seite zeigt den Hinweis dann
// nicht mehr, „Report this page“ bleibt. Jeder native Dialog (alert/confirm/prompt) lässt den Lauf scheitern.
//   node tests/e2e/status-addons.js
// Startet die Seite selbst (Port OYS_E2E_PORT, Vorgabe 14228) und legt ein eigenes Testkonto an (id 9453 mit Seite 9463),
// das am Ende wieder verschwindet. Nur gegen eine Test-Datenbank (Name beginnt mit oys_test, sonst Abbruch mit Code 2
// vor jedem SQL). Umgebung: OYS_CONFIG, OYS_E2E_PASSWORD, OYS_E2E_SHOTS.
'use strict';
const path = require('path');
const { chromium } = require('playwright');
const { ok, watchPage, step, summary } = require('./lib');
const { testSite } = require('./site');

const site = testSite(14228);
const { sql, count } = site;
const B = site.base;
const PASSWORD = process.env.OYS_E2E_PASSWORD || ['test', '1234'].join('');
const SHOTS = process.env.OYS_E2E_SHOTS || '';
const U = 9453, P = 9463;
const SLUG = 'e2e-st7-status';

function cleanup() {
  sql(`DELETE FROM status_outbox WHERE page_id IN (SELECT id FROM status_pages WHERE user_id = ${U});
    DELETE FROM status_channels WHERE page_id IN (SELECT id FROM status_pages WHERE user_id = ${U});
    DELETE FROM status_monitors WHERE page_id IN (SELECT id FROM status_pages WHERE user_id = ${U});
    DELETE FROM status_pages WHERE user_id = ${U};
    DELETE FROM site_addresses WHERE slug LIKE '${SLUG}%' OR user_id = ${U};
    DELETE FROM page_blocks WHERE page_id IN (SELECT id FROM pages WHERE user_id = ${U});
    DELETE FROM pages WHERE user_id = ${U};
    DELETE FROM notifications WHERE user_id = ${U};
    DELETE FROM honeycomb_ledger WHERE user_id = ${U};
    DELETE FROM hc_entitlements WHERE user_id = ${U}; DELETE FROM hc_accounts WHERE user_id = ${U};
    DELETE FROM rate_limits WHERE rl_key LIKE 'status%:${U}' OR rl_key LIKE 'statusverifylink:%';
    DELETE FROM users WHERE id = ${U};`);
}
// Konto mit freigeschalteter Statusseite (noch ohne Seite); heute schon aktiv gewesen
function fixtures() {
  cleanup();
  sql(`INSERT INTO users (id, email, password, full_name, username, created_at, code_terms_at)
      SELECT ${U}, 'st7-user@test.de', password, 'Addon Owner', 'addonowner', '2026-01-01 10:00:00', NOW() FROM users WHERE id = 5;
    INSERT INTO pages (id, user_id, slug, position, title, subtitle, bio, theme, layout, address_mode, settings, created_at, updated_at)
      SELECT ${P}, ${U}, 'addonowner', 0, 'Addon Owner', '', '', theme, layout, 'subdomain', settings, NOW(), NOW() FROM pages WHERE id = 2;
    INSERT INTO honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (${U}, 0, 'daily', DATE_FORMAT(NOW(), '%Y-%m-%d'), '', NOW()),
      (${U}, 0, 'unlock', 'status_page', 'Unlocked by the team', NOW());
    INSERT INTO hc_entitlements (user_id, feature, lot, quantity, permanent, expires_at, source, created_at, updated_at) VALUES (${U}, 'status_page', 0, 1, 1, NULL, 'admin', NOW(), NOW());`);
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

const toast = async (page, part) => {
  const t = page.locator('.ui-toast', { hasText: part });
  await t.first().waitFor({ timeout: 8000 });
  return t.first().innerText();
};

(async () => {
  fixtures();
  await site.start();
  browser = await chromium.launch({ args: site.browserArgs });
  try {
    await step('an Extra checks pack shows 20 checks with its end; Premium unlocks hiding “Made with OnYourSite”', async () => {
      const { ctx, page } = await newPage();
      await login(page, 'st7-user@test.de');
      await page.goto(B + '/dashboard?page=' + P + '&load=1#status');
      await page.locator('#tab-status:not(.hidden) #stmNewTitle').waitFor();
      await page.fill('#stmNewTitle', 'Addon status');
      await page.fill('#stmNewSlug', SLUG);
      await page.click('[data-stm="create-page"]');
      await page.locator('.st-m-headcard').waitFor();
      ok((await page.locator('#stmUsage').innerText()).includes('0 of 10 checks'), 'free plan: 10 checks');
      sql(`INSERT INTO hc_entitlements (user_id, feature, lot, quantity, permanent, expires_at, source, created_at, updated_at)
          VALUES (${U}, 'status_more_checks', 0, 1, 0, NOW() + INTERVAL 20 DAY, 'admin', NOW(), NOW())`);
      await page.goto(B + '/dashboard?page=' + P + '&load=2#status');
      await page.locator('#stmUsage').waitFor();
      const usage = await page.locator('#stmUsage').innerText();
      ok(usage.includes('0 of 20 checks') && usage.includes('with add-ons until'), 'pack: 20 checks and its end (' + usage + ')');
      await page.click('[data-stm-tab="settings"]');
      const box = page.locator('#stmBody [name=hide_branding]');
      ok(await box.isDisabled(), 'without Premium the switch is off');
      ok((await page.locator('#stmBody').innerText()).includes('Comes with Premium.'), 'hint: Comes with Premium');
      sql(`UPDATE users SET premium_until = NOW() + INTERVAL 30 DAY WHERE id = ${U};
        INSERT INTO hc_entitlements (user_id, feature, lot, quantity, permanent, expires_at, source, created_at, updated_at)
          VALUES (${U}, 'premium', 0, 1, 0, NOW() + INTERVAL 30 DAY, 'admin', NOW(), NOW());`);
      await page.goto(B + '/dashboard?page=' + P + '&load=3#status');
      await page.locator('.st-m-headcard').waitFor();
      ok((await page.locator('#stmUsage').innerText()).includes('of 30 checks · Premium'), 'Premium: 30 checks');
      await page.click('[data-stm-tab="settings"]');
      ok(await page.locator('#stmBody [name=hide_branding]').isEnabled(), 'with Premium the switch works');
      await page.click('#stmBody label.switch:has([name=hide_branding])');
      await page.click('[data-stm="save-page"]');
      await toast(page, 'Settings saved');
      ok(JSON.parse(sql(`SELECT settings FROM status_pages WHERE user_id = ${U}`)).hide_branding === true, 'saved');
      await shot(page, 'st7-settings');
      const pub = await browser.newContext();
      const pp = await pub.newPage();
      watchPage(pp);
      await pp.goto('http://' + SLUG + '.' + site.host + ':' + site.port + '/');
      const foot = await pp.locator('footer').innerText();
      ok(!foot.includes('Made with') && foot.includes('Report this page'), 'the public page hides “Made with OnYourSite” (' + foot.trim() + ')');
      await pub.close();
      await page.setViewportSize({ width: 390, height: 844 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      ok(overflow <= 0, 'phone width: no horizontal page scroll (' + overflow + ')');
      await ctx.close();
    });
  } finally {
    await browser.close();
    site.stop();
    cleanup();
  }
  summary('status-addons');
})().catch((err) => {
  console.error(err);
  try { site.stop(); } catch (e) { /* egal */ }
  try { cleanup(); } catch (e) { /* Datenbank nicht erreichbar */ }
  process.exitCode = 1;
});
