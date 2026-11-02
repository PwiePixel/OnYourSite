// Ende-zu-Ende: Kaufen im Bereich „Honeycombs“ des Editors (honeycomb-shop HC-4, Ablauf 2). Die Code-Seite wird im
// Shop freigeschaltet (die Regeln im Dialog halten „Buy“ gesperrt, bis sie angekreuzt sind) und ist danach im Code-Tab
// offen; zu wenig Honigwaben → gesperrter Knopf „N more needed“; ein Doppelklick auf „Buy“ bucht einmal; ein Fehler beim
// Laden zeigt den Hinweis; ein Ziel /dashboard#honeycombs/<funktion> springt zur Karte; im Admin-Modus ist Kaufen aus.
// Jeder native Dialog (alert/confirm/prompt) lässt den Lauf scheitern.
//   node tests/e2e/hc-buy.js
// Startet die Seite selbst (Port OYS_E2E_PORT, Vorgabe 14206) und legt ein eigenes Testkonto an (id 9401 mit Seite 9411),
// das am Ende wieder verschwindet. Nur gegen eine Test-Datenbank (Name beginnt mit oys_test, sonst Abbruch mit Code 2
// vor jedem SQL). Umgebung: OYS_CONFIG, OYS_E2E_PASSWORD, OYS_E2E_ONLY, OYS_E2E_SHOTS (Ordner für Bildschirmfotos).
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
const U = 9401, P = 9411;

function cleanup() {
  sql(`DELETE FROM code_files WHERE site_id IN (SELECT id FROM code_sites WHERE user_id = ${U});
    DELETE FROM code_sites WHERE user_id = ${U};
    DELETE FROM page_blocks WHERE page_id IN (SELECT id FROM pages WHERE user_id = ${U});
    DELETE FROM pages WHERE user_id = ${U};
    DELETE FROM notifications WHERE user_id = ${U};
    DELETE FROM honeycomb_ledger WHERE user_id = ${U};
    DELETE FROM hc_entitlements WHERE user_id = ${U}; DELETE FROM hc_purchases WHERE user_id = ${U}; DELETE FROM hc_accounts WHERE user_id = ${U};
    DELETE FROM rate_limits WHERE rl_key IN ('hcbuy:${U}', 'hchist:${U}');
    DELETE FROM users WHERE id = ${U};
    UPDATE hc_items SET price = 100 WHERE item_key = 'code_page'; UPDATE hc_items SET price = 0 WHERE item_key = 'code_more';`);
}
// Konto ohne Freischaltung, Regeln nicht akzeptiert; die Tagesbelohnung ist schon vergeben (gestern bis morgen, damit
// das Öffnen des Editors nichts dazu verdient und der Kontostand genau stimmt)
function fixtures(balance) {
  cleanup();
  sql(`INSERT INTO users (id, email, password, full_name, username, created_at)
      SELECT ${U}, 'hc-buy@test.de', password, 'Honey Buyer', 'honeybuyer', '2026-01-01 10:00:00' FROM users WHERE id = 5;
    INSERT INTO pages (id, user_id, slug, position, title, subtitle, bio, theme, layout, address_mode, settings, created_at, updated_at)
      SELECT ${P}, ${U}, 'honeybuyer', 0, 'Honey Buyer', '', '', theme, layout, 'subdomain', settings, NOW(), NOW() FROM pages WHERE id = 2;
    INSERT IGNORE INTO honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES
      (${U}, 0, 'daily', DATE_FORMAT(CURDATE() - INTERVAL 1 DAY, '%Y-%m-%d'), '', NOW()), (${U}, 0, 'daily', DATE_FORMAT(CURDATE(), '%Y-%m-%d'), '', NOW()),
      (${U}, 0, 'daily', DATE_FORMAT(CURDATE() + INTERVAL 1 DAY, '%Y-%m-%d'), '', NOW()),
      (${U}, ${balance}, 'admin', CONCAT('a3-', LPAD(HEX(FLOOR(RAND() * 4294967295)), 16, '0')), 'Start', NOW());`);
}
const unlocks = () => count(`SELECT COUNT(*) FROM honeycomb_ledger WHERE user_id = ${U} AND reason = 'unlock'`);

let browser;
const IGNORED_CONSOLE = /tailwindcss|favicon|ERR_FAILED|net::|preload/;
async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  watchPage(page);
  page.on('console', (m) => { if (m.type() === 'error' && !IGNORED_CONSOLE.test(m.text()) && !(opts.allowConsole && opts.allowConsole.test(m.text()))) ok(false, 'console error: ' + m.text()); });
  return { ctx, page };
}
async function login(page, email) {
  await page.goto(B + '/login');
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', PASSWORD);
  await Promise.all([page.waitForNavigation(), page.click('form[action="/login"] button[type=submit]')]);
}
// Den Editor neu laden (ein reiner Wechsel des Ankers lädt nicht neu) und warten, bis der Bereich steht
let loads = 0;
async function shopTab(page, hash = '#honeycombs') {
  await page.goto(B + '/dashboard?page=' + P + '&load=' + ++loads + hash);
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
    await step('load error: the tab shows the notice instead of the shop', async () => {
      fixtures(150);
      const { ctx, page } = await newPage({ allowConsole: /500/ });
      await login(page, 'hc-buy@test.de');
      await page.route('**/dashboard/api/shop*', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false,"error":"boom"}' }));
      await page.goto(B + '/dashboard?page=' + P + '&load=err#honeycombs');
      const err = page.locator('#tab-honeycombs .panel.empty-state');
      await err.waitFor();
      ok((await err.innerText()).includes('Couldn’t load your honeycombs – please reload.'), 'load error notice');
      await ctx.close();
    });

    await step('not enough honeycombs: disabled “N more needed” and a link to the earn list', async () => {
      fixtures(30);
      const { ctx, page } = await newPage();
      await login(page, 'hc-buy@test.de');
      await shopTab(page);
      const btn = page.locator('#shop-code_page .shop-foot .btn-primary');
      ok(await btn.isDisabled() && (await btn.innerText()).includes('70 more needed'), 'disabled button: 70 more needed (' + (await btn.innerText()) + ')');
      await page.click('#shop-code_page [data-shop-go="earn"]');
      await sleep(600);
      const top = await page.evaluate(() => document.getElementById('shopEarn').getBoundingClientRect().top);
      ok(top >= 0 && top < 300, '“How to earn honeycombs” scrolls to the earn list (' + Math.round(top) + ')');
      ok(await page.locator('#tab-honeycombs .hc-rule', { hasText: 'Be active' }).count() === 1, 'the earn list shows the daily reward');
      await shot(page, 'hc-buy-not-enough');
      await ctx.close();
    });

    await step('buy the code page: the rules keep “Buy” disabled, then one booking and the code tab is unlocked', async () => {
      fixtures(150);
      const { ctx, page } = await newPage();
      await login(page, 'hc-buy@test.de');
      await shopTab(page);
      ok((await page.locator('#hcBalance').innerText()).trim() === '150', 'balance pill shows 150');
      await page.click('#shop-code_page [data-shop-buy]');
      await dlg(page).waitFor();
      ok((await page.locator('.ui-dialog .ui-title').innerText()) === 'Unlock your code page?', 'dialog title');
      ok((await page.locator('.ui-dialog .hc-big b').innerText()) === '100', 'the dialog shows the price');
      ok((await page.locator('.ui-dialog .ui-content').innerText()).includes('Afterwards you have 50 honeycombs left.'), 'what is left afterwards');
      ok(await okButton(page).isDisabled(), '“Buy” is disabled until the rules are ticked');
      ok((await okButton(page).innerText()).includes('Buy for 100'), 'button label “Buy for 100”');
      await shot(page, 'hc-buy-dialog');
      await page.check('.ui-dialog input[name=terms]');
      ok(await okButton(page).isEnabled(), 'ticking the rules enables “Buy”');
      await okButton(page).click();
      await dlg(page).waitFor({ state: 'detached' });
      await page.locator('#shop-code_page .bdg.green').waitFor();
      const toast = page.locator('.ui-toast.hc', { hasText: 'Code page unlocked' });
      await toast.waitFor();
      ok((await toast.locator('.ui-amt').innerText()).includes('100'), 'yellow toast with the amount spent');
      ok((await page.locator('#hcBalance').innerText()).trim() === '50', 'balance pill shows 50');
      ok(unlocks() === 1 && sql(`SELECT CONCAT(amount, '|', ref) FROM honeycomb_ledger WHERE user_id = ${U} AND reason = 'unlock'`) === '-100|code_page', 'one unlock booked: −100');
      ok(sql(`SELECT CONCAT(via, '|', price) FROM hc_purchases WHERE user_id = ${U}`) === 'shop|100', 'one purchase via the shop');
      ok(sql(`SELECT code_terms_at IS NOT NULL FROM users WHERE id = ${U}`) === '1', 'the rules are accepted with the purchase');
      ok((await page.locator('#tab-honeycombs .hc-rule', { hasText: 'Code page' }).innerText()).includes('Unlocked for good'), '“Your unlocks” lists the code page');
      await page.locator('#shopHist .hc-hist-row', { hasText: 'Unlocked your code page' }).waitFor();
      ok((await page.locator('#shopHist .hc-hist-row').first().innerText()).includes('−100'), 'the history shows −100 first');
      await shot(page, 'hc-buy-owned');
      // „Open“ führt in den Code-Tab, dort ist die Code-Seite jetzt freigeschaltet
      await page.click('#shop-code_page [data-shop-open]');
      await page.locator('#tab-code #codeSlug').waitFor();
      ok(await page.isVisible('#tab-code #codeSlug'), 'the code tab offers “Create your code page”');
      await ctx.close();
    });

    await step('double click on “Buy” books once', async () => {
      fixtures(300);
      const { ctx, page } = await newPage();
      await login(page, 'hc-buy@test.de');
      await shopTab(page);
      await page.click('#shop-code_page [data-shop-buy]');
      await dlg(page).waitFor();
      await page.check('.ui-dialog input[name=terms]');
      await okButton(page).dblclick();
      await dlg(page).waitFor({ state: 'detached' });
      await page.locator('#shop-code_page .bdg.green').waitFor();
      await sleep(300);
      ok(unlocks() === 1 && count(`SELECT COUNT(*) FROM hc_purchases WHERE user_id = ${U}`) === 1, 'one unlock and one purchase');
      ok((await page.locator('#hcBalance').innerText()).trim() === '200', 'balance 200');
      await ctx.close();
    });

    await step('/dashboard#honeycombs/code_page opens the tab at that card; the pill opens the tab', async () => {
      fixtures(150);
      const { ctx, page } = await newPage();
      await login(page, 'hc-buy@test.de');
      await page.goto(B + '/dashboard?page=' + P + '&load=deep#honeycombs/code_page');
      await page.waitForSelector('#shop-code_page.flash');
      ok(await page.textContent('#pageTitle') === 'Honeycombs', 'the tab is open');
      await page.click('#mainNav [data-tab=content]');
      await page.click('#hcBtn');
      await page.waitForSelector('#tab-honeycombs:not(.hidden) .shop-wallet');
      ok(await page.isHidden('#tab-content'), 'the pill switches to the tab');
      // Die alte Adresse #shop führt ebenfalls hierher
      await page.goto(B + '/dashboard?page=' + P + '&load=old#shop');
      await page.waitForSelector('#tab-honeycombs:not(.hidden) .shop-wallet');
      ok(true, '#shop opens the tab');
      await ctx.close();
    });

    await step('history: 20 entries, “Show more” loads the older ones, texts stay text', async () => {
      fixtures(10);
      const rows = [];
      for (let i = 1; i <= 24; i++) rows.push(`(${U}, ${i}, 'admin', CONCAT('a3-', LPAD(HEX(${i} * 65536 + FLOOR(RAND() * 65535)), 16, '0')), ${i === 24 ? "'<img src=x onerror=window.__x=1>Gift'" : "'Gift " + i + "'"}, NOW())`);
      sql('INSERT INTO honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES ' + rows.join(', '));
      const { ctx, page } = await newPage();
      await login(page, 'hc-buy@test.de');
      await shopTab(page, '#honeycombs/history');
      const hist = page.locator('#shopHist .hc-hist-row');
      ok(await hist.count() === 20, '20 entries first (' + (await hist.count()) + ')');
      ok((await hist.first().innerText()).includes('<img src=x onerror=window.__x=1>Gift'), 'a note with markup is shown as text');
      ok(await page.evaluate(() => window.__x === undefined && !document.querySelector('#shopHist img')), 'no markup from a note');
      await page.click('#shopHist [data-shop-more]');
      await page.waitForFunction(() => document.querySelectorAll('#shopHist .hc-hist-row').length > 20);
      // 24 Geschenke, Startguthaben und 3 Tagesbelohnungen
      ok(await hist.count() === 28 && await page.locator('#shopHist [data-shop-more]').count() === 0, 'all 28 entries, no more button');
      await ctx.close();
    });

    await step('more code pages without accepted rules: the dialog shows the rules for code pages, not the general terms', async () => {
      fixtures(150);
      // Code-Seite vom Team (Regeln nie angenommen); weitere Code-Seiten kosten etwas
      sql(`INSERT INTO hc_entitlements (user_id, feature, lot, quantity, permanent, source, created_at, updated_at) VALUES (${U}, 'code_page', 0, 1, 1, 'grant', NOW(), NOW());
        UPDATE hc_items SET price = 40 WHERE item_key = 'code_more';`);
      const { ctx, page } = await newPage();
      await login(page, 'hc-buy@test.de');
      await shopTab(page);
      await page.click('#shop-code_more [data-shop-buy]');
      await dlg(page).waitFor();
      const terms = page.locator('.ui-dialog label.code-terms');
      ok((await terms.innerText()).includes('rules for code pages'), 'the checkbox names the rules for code pages (' + (await terms.innerText()) + ')');
      ok((await terms.locator('a').getAttribute('href')) === '/terms/code-pages', 'the link opens the rules for code pages');
      await page.keyboard.press('Escape');
      await dlg(page).waitFor({ state: 'detached' });
      ok(sql(`SELECT code_terms_at IS NULL FROM users WHERE id = ${U}`) === '1', 'nothing is accepted without buying');
      await ctx.close();
    });

    await step('admin mode: a banner, buying is off and nothing is booked', async () => {
      fixtures(150);
      const { ctx, page } = await newPage();
      await login(page, 'admin@test.de');
      await page.goto(B + '/admin');
      await page.evaluate((id) => {
        const f = document.createElement('form');
        f.method = 'POST';
        f.action = '/admin_impersonate.php';
        for (const [k, v] of [['csrf', document.querySelector('input[name=csrf]').value], ['id', String(id)]]) {
          const i = document.createElement('input');
          i.type = 'hidden';
          i.name = k;
          i.value = v;
          f.appendChild(i);
        }
        document.body.appendChild(f);
        f.submit();
      }, U);
      await page.waitForURL(/\/dashboard/);
      await shopTab(page);
      ok((await page.locator('#tab-honeycombs .shop-banner.info').innerText()).includes('Admin mode – you can look around, but buying is turned off.'), 'admin mode banner');
      ok(await page.locator('#shop-code_page [data-shop-buy]').isDisabled(), 'the buy button is disabled');
      ok(unlocks() === 0, 'nothing booked');
      await ctx.close();
    });
  } finally {
    await browser.close();
    site.stop();
    cleanup();
  }
  summary('hc-buy');
})().catch((err) => {
  console.error(err);
  try { site.stop(); } catch (e) { /* egal */ }
  try { cleanup(); } catch (e) { /* Datenbank nicht erreichbar */ }
  process.exitCode = 1;
});
