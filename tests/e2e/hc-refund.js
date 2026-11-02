// Ende-zu-Ende: Admin, Bereich „Honeycombs“, Details eines Nutzers (honeycomb-shop HC-6a). Der Admin erstattet einen Kauf
// über den eigenen Bestätigungsdialog (Betrag vorgegeben, „Also remove“ vorgewählt) → Meldung, Abzeichen „Refunded“,
// genau eine Buchung und eine Glocke; dann schenkt er die Code-Seite wieder und nimmt sie über den Dialog weg. Zuletzt
// „Give honeycombs“: normale Gaben ohne Rückfrage, Abziehen und große Gaben nur über den eigenen Dialog.
// Jeder native Dialog (alert/confirm/prompt) lässt den Lauf scheitern.
//   node tests/e2e/hc-refund.js
// Startet die Seite selbst (Port OYS_E2E_PORT, Vorgabe 14216) und legt ein eigenes Testkonto an (id 9403), das am Ende
// wieder verschwindet. Nur gegen eine Test-Datenbank (Name beginnt mit oys_test, sonst Abbruch mit Code 2 vor jedem
// SQL). Umgebung: OYS_CONFIG, OYS_E2E_PASSWORD, OYS_E2E_SHOTS.
'use strict';
const path = require('path');
const { chromium } = require('playwright');
const { ok, watchPage, step, summary } = require('./lib');
const { testSite } = require('./site');

const site = testSite(14216);
const { sql, count } = site;
const B = site.base;
const PASSWORD = process.env.OYS_E2E_PASSWORD || ['test', '1234'].join('');
const SHOTS = process.env.OYS_E2E_SHOTS || '';
const U = 9403;

function cleanup() {
  sql(`DELETE FROM notifications WHERE user_id = ${U};
    DELETE FROM honeycomb_ledger WHERE user_id = ${U};
    DELETE FROM hc_entitlements WHERE user_id = ${U}; DELETE FROM hc_purchases WHERE user_id = ${U}; DELETE FROM hc_accounts WHERE user_id = ${U};
    DELETE FROM hc_audit WHERE user_id = ${U};
    DELETE FROM users WHERE id = ${U};`);
}
// Ein Konto mit gekaufter Code-Seite (Kauf, Buchung und Berechtigung wie nach buy())
function fixtures() {
  cleanup();
  sql(`INSERT INTO users (id, email, password, full_name, username, created_at, code_terms_at)
      SELECT ${U}, 'hc-refund@test.de', password, 'Refund <i>Tester</i>', 'refundtester', '2026-01-01 10:00:00', NOW() FROM users WHERE id = 5;
    INSERT INTO honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (${U}, 300, 'admin', 'a3-00000000000e2e01', 'Start', NOW());
    INSERT INTO honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (${U}, -100, 'purchase', 'e2e-refund-1', 'Code page', NOW());
    INSERT INTO hc_purchases (user_id, request_id, item_key, feature, lot, units, days, list_price, price, offer_id, ledger_id, via, created_at)
      VALUES (${U}, 'e2e00000000000000000000000000001', 'code_page', 'code_page', 0, 1, NULL, 100, 100, NULL, LAST_INSERT_ID(), 'shop', NOW());
    INSERT INTO hc_entitlements (user_id, feature, lot, quantity, permanent, expires_at, source, created_at, updated_at)
      VALUES (${U}, 'code_page', 0, 1, 1, NULL, 'purchase', NOW(), NOW());`);
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
const shot = async (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true });
const details = (page) => page.goto(B + '/admin?hc_tab=users&hc_user=' + U + '#honeycombs');
async function confirmDialog(page, title) {
  await page.waitForSelector('.ui-dialog');
  const text = await page.locator('.ui-dialog').innerText();
  ok(text.includes(title), 'the dialog asks “' + title + '” (' + text.split('\n')[0] + ')');
  await Promise.all([page.waitForNavigation(), page.click('.ui-dialog .ui-foot .ui-btn:not(.is-ghost)')]);
}
const toast = async (page, part) => {
  const t = page.locator('.ui-toast', { hasText: part });
  await t.first().waitFor({ timeout: 5000 });
  return t.first().innerText();
};

(async () => {
  fixtures();
  await site.start();
  browser = await chromium.launch({ args: site.browserArgs });
  try {
    await step('the admin refunds a purchase through the dialog: one entry, one bell, the badge', async () => {
      const { ctx, page } = await newPage();
      await login(page, 'admin@test.de');
      await details(page);
      await page.waitForSelector('#hcUserDetails');
      ok((await page.locator('#hcUserDetails h2').innerText()).includes('Refund <i>Tester</i>'), 'the name is shown as text');
      const form = page.locator('#hcUserPurchases li[data-purchase] form');
      ok((await form.locator('[name=amount]').inputValue()) === '100', 'the refundable value is the default');
      ok((await form.locator('[name=remove]').inputValue()) === '1', '“Also remove what was bought” is chosen for a full refund');
      await shot(page, 'hc-refund-details');
      await form.locator('button[type=submit]').click();
      await confirmDialog(page, 'Refund 100 honeycombs to Refund <i>Tester</i>?');
      const msg = await toast(page, 'Refunded');
      ok(msg.includes('Refunded 100 honeycombs to Refund <i>Tester</i>. The code page is locked again.'), 'the success message (' + msg + ')');
      ok((await page.locator('#hcUserPurchases').innerText()).toLowerCase().includes('refunded +100'), 'the purchase shows “Refunded +100”');
      ok(count(`SELECT COUNT(*) FROM honeycomb_ledger WHERE user_id = ${U} AND reason = 'refund'`) === 1, 'one refund entry');
      ok(count(`SELECT COUNT(*) FROM notifications WHERE user_id = ${U} AND type = 'honeycombs'`) === 1, 'one bell');
      ok(count(`SELECT quantity FROM hc_entitlements WHERE user_id = ${U} AND feature = 'code_page'`) === 0, 'the code page is locked');
      await ctx.close();
    });

    await step('the admin gives the code page back and removes it through the dialog', async () => {
      const { ctx, page } = await newPage();
      await login(page, 'admin@test.de');
      await details(page);
      await page.selectOption('#hcGiveUnlock [name=feature]', 'code_page');
      await page.selectOption('#hcGiveUnlock [name=mode]', 'permanent');
      await Promise.all([page.waitForNavigation(), page.click('#hcGiveUnlock button[type=submit]')]);
      const given = await toast(page, 'given');
      ok(given.includes('Code page given to Refund <i>Tester</i>.'), 'given (' + given + ')');
      ok(count(`SELECT quantity FROM hc_entitlements WHERE user_id = ${U} AND feature = 'code_page'`) === 1, 'the code page is unlocked again');
      await page.locator('#hcUserUnlocks tr[data-ent="code_page:0"] button[type=submit]').click();
      await confirmDialog(page, 'Remove Code page from Refund <i>Tester</i>?');
      const removed = await toast(page, 'removed');
      ok(removed.includes('Code page removed from Refund <i>Tester</i>.'), 'removed (' + removed + ')');
      ok(count(`SELECT quantity FROM hc_entitlements WHERE user_id = ${U} AND feature = 'code_page'`) === 0, 'the code page is locked again');
      ok(count(`SELECT COUNT(*) FROM notifications WHERE user_id = ${U} AND type = 'unlock'`) === 2, 'one bell each for give and remove');
      await shot(page, 'hc-refund-removed');
      await ctx.close();
    });

    await step('give honeycombs: a normal gift without a dialog, taking away and a large gift only through the dialog', async () => {
      const { ctx, page } = await newPage();
      await login(page, 'admin@test.de');
      await page.goto(B + '/admin?hc_tab=users#honeycombs');
      const send = async (amount) => {
        await page.selectOption('#hcUser', String(U));
        await page.fill('#hcAmount', String(amount));
        await page.click('#hcGrantForm button[type=submit]');
      };
      const entries = () => count(`SELECT COUNT(*) FROM honeycomb_ledger WHERE user_id = ${U} AND reason = 'admin'`);
      const before = entries();
      await Promise.all([page.waitForNavigation(), send(10)]);
      const given = await toast(page, 'honeycombs for');
      ok(given.includes('+10 honeycombs for Refund <i>Tester</i>.'), 'a normal gift goes out without a dialog (' + given + ')');
      ok(entries() === before + 1, 'one entry for the gift');
      await send(-5);
      await page.waitForSelector('.ui-dialog');
      ok((await page.locator('.ui-dialog').innerText()).includes('Take 5 honeycombs from Refund <i>Tester</i>?'), 'the dialog names the amount and the user as text');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.ui-dialog', { state: 'detached' });
      ok(entries() === before + 1, 'cancelled: nothing is taken');
      await send(-5);
      await confirmDialog(page, 'Take 5 honeycombs from Refund <i>Tester</i>?');
      const taken = await toast(page, 'honeycombs for');
      ok(taken.includes('−5 honeycombs for Refund <i>Tester</i>.'), 'taken after the dialog (' + taken + ')');
      await send(5000);
      await confirmDialog(page, 'Give 5,000 honeycombs to Refund <i>Tester</i>?');
      const big = await toast(page, 'honeycombs for');
      ok(big.includes('+5000 honeycombs for Refund <i>Tester</i>.'), 'a large gift after the dialog (' + big + ')');
      ok(entries() === before + 3, 'three entries in all');
      await ctx.close();
    });
  } finally {
    await browser.close();
    site.stop();
    cleanup();
  }
  summary('hc-refund');
})().catch((err) => {
  console.error(err);
  try { site.stop(); } catch (e) { /* egal */ }
  try { cleanup(); } catch (e) { /* Datenbank nicht erreichbar */ }
  process.exitCode = 1;
});
