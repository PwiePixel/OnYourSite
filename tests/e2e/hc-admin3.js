// Ende-zu-Ende: Admin, Bereich „Honeycombs“, Teil III (honeycomb-shop HC-6b). Der Admin nimmt eine Gabe im Unterbereich
// „Ledger“ über den eigenen Dialog zurück (danach „Reversed“, Glocke beim Nutzer), hält ein Konto mit Grund an und gibt
// es wieder frei, und gibt mehreren Nutzern Honigwaben: Liste prüfen → Vorschau mit unklaren und fehlenden Einträgen →
// „Confirm“ im Dialog → genau eine Buchung je Konto. Schmal ohne waagrechtes Verschieben.
// Jeder native Dialog (alert/confirm/prompt) lässt den Lauf scheitern.
//   node tests/e2e/hc-admin3.js
// Startet die Seite selbst (Port OYS_E2E_PORT, Vorgabe 14217) und legt zwei eigene Testkonten an (ids 9404 und 9405), die
// am Ende wieder verschwinden. Nur gegen eine Test-Datenbank (Name beginnt mit oys_test, sonst Abbruch mit Code 2 vor
// jedem SQL). Umgebung: OYS_CONFIG, OYS_E2E_PASSWORD, OYS_E2E_SHOTS.
'use strict';
const path = require('path');
const { chromium } = require('playwright');
const { ok, watchPage, step, summary } = require('./lib');
const { testSite } = require('./site');

const site = testSite(14217);
const { sql, count } = site;
const B = site.base;
const PASSWORD = process.env.OYS_E2E_PASSWORD || ['test', '1234'].join('');
const SHOTS = process.env.OYS_E2E_SHOTS || '';
const U = 9404, T = 9405;

function cleanup() {
  for (const id of [U, T]) {
    sql(`DELETE FROM notifications WHERE user_id = ${id};
      DELETE FROM honeycomb_ledger WHERE user_id = ${id};
      DELETE FROM hc_entitlements WHERE user_id = ${id}; DELETE FROM hc_accounts WHERE user_id = ${id};
      DELETE FROM hc_audit WHERE user_id = ${id};
      DELETE FROM users WHERE id = ${id};`);
  }
}
function fixtures() {
  cleanup();
  sql(`INSERT INTO users (id, email, password, full_name, username, created_at)
      SELECT ${U}, 'hc-team1@test.de', password, 'Team <i>One</i>', 'teamone', '2026-01-01 10:00:00' FROM users WHERE id = 5;
    INSERT INTO users (id, email, password, full_name, username, created_at)
      SELECT ${T}, 'hc-team2@test.de', password, 'Team Two', 'teamtwo', '2026-01-01 10:00:00' FROM users WHERE id = 5;
    INSERT INTO honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES
      (${U}, 300, 'admin', 'a3-00000000000e2e11', 'Start', NOW()), (${U}, 40, 'admin', 'a3-00000000000e2e12', 'Contest', NOW()),
      (${T}, 10, 'admin', 'a3-00000000000e2e13', 'Start', NOW());`);
}
const balance = (id) => count(`SELECT COALESCE(SUM(amount), 0) FROM honeycomb_ledger WHERE user_id = ${id}`);

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
    await step('ledger: reverse a gift through the dialog; the row shows “Reversed”, the user gets a bell', async () => {
      const { ctx, page } = await newPage();
      await login(page, 'admin@test.de');
      await page.goto(B + '/admin?hc_tab=ledger&hc_q=hc-team1#honeycombs');
      const id = sql("SELECT id FROM honeycomb_ledger WHERE ref = 'a3-00000000000e2e12'");
      const row = page.locator(`#hcLedgerRows [data-ledger="${id}"]`);
      ok(await row.count() === 1 && (await row.innerText()).includes('Contest'), 'the gift is listed');
      await row.locator('button', { hasText: 'Reverse' }).click();
      await confirmDialog(page, 'Reverse this entry?');
      ok(page.url().includes('hc_tab=ledger'), 'back on the ledger');
      ok((await toast(page, 'Reversed')).includes('−40 honeycombs'), 'toast: Reversed −40');
      ok(balance(U) === 300, 'balance 300');
      ok(sql(`SELECT title FROM notifications WHERE user_id = ${U} ORDER BY id DESC LIMIT 1`) === '−40 honeycombs (correction by the team)', 'bell for the user');
      await page.goto(B + '/admin?hc_tab=ledger&hc_q=hc-team1#honeycombs');
      ok(/reversed/i.test(await page.locator(`#hcLedgerRows [data-ledger="${id}"]`).innerText()), 'the row shows “Reversed”');
      ok(!(await page.content()).includes('<i>One</i>'), 'names are escaped');
      await shot(page, 'hc-admin3-ledger');
      await ctx.close();
    });

    await step('freeze with a reason through the dialog, then unfreeze', async () => {
      const { ctx, page } = await newPage();
      await login(page, 'admin@test.de');
      await details(page);
      await page.fill('#hcFreezeReason', 'Checking unusual activity.');
      await page.click('#hcFreeze button[type=submit]');
      await confirmDialog(page, 'on hold?');
      ok((await toast(page, 'on hold now')).length > 0, 'toast: on hold');
      ok(sql(`SELECT frozen_reason FROM hc_accounts WHERE user_id = ${U}`) === 'Checking unusual activity.', 'frozen with the reason');
      ok((await page.locator('#hcFreeze').innerText()).includes('On hold since'), 'the details show the hold');
      await page.click('#hcFreeze button[type=submit]');
      await confirmDialog(page, 'use honeycombs again?');
      ok(sql(`SELECT frozen_at IS NULL FROM hc_accounts WHERE user_id = ${U}`) === '1', 'unfrozen');
      await ctx.close();
    });

    await step('several users: check the list, see unclear and missing entries, confirm once', async () => {
      const { ctx, page } = await newPage();
      await login(page, 'admin@test.de');
      await page.goto(B + '/admin?hc_tab=users#honeycombs');
      await page.click('#hcBulk summary');
      await page.fill('#hcBulkList', 'hc-team1@test.de\n#' + T + '\n1234\nnobody@test.de');
      await page.fill('#hcBulkAmount', '25');
      await page.fill('#hcBulkNote', 'Thanks!');
      await Promise.all([page.waitForNavigation(), page.click('#hcBulkForm button[type=submit]')]);
      const prev = page.locator('#hcBulkPreview');
      ok(await prev.isVisible(), 'the preview is open');
      const text = await prev.innerText();
      ok(text.includes('+25 honeycombs for 2 users'), 'preview: 2 users');
      ok(text.includes('Not clear') && text.includes('1234') && text.includes('Not found') && text.includes('nobody@test.de'), 'unclear and missing entries are named');
      await shot(page, 'hc-admin3-bulk');
      await prev.locator('button', { hasText: 'Confirm' }).click();
      await confirmDialog(page, 'Send +25 honeycombs to 2 users?');
      ok((await toast(page, 'for 2 users')).includes('+25'), 'toast: +25 for 2 users');
      ok(balance(U) === 325 && balance(T) === 35, 'booked once each (' + balance(U) + ', ' + balance(T) + ')');
      ok(await page.locator('#hcBulkPreview').count() === 0, 'the preview is gone');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(B + '/admin?hc_tab=ledger#honeycombs');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      ok(overflow <= 0, 'phone width: no horizontal page scroll (' + overflow + ')');
      await ctx.close();
    });
  } finally {
    await browser.close();
    site.stop();
    cleanup();
  }
  summary('hc-admin3');
})().catch((err) => {
  console.error(err);
  try { site.stop(); } catch (e) { /* egal */ }
  try { cleanup(); } catch (e) { /* Datenbank nicht erreichbar */ }
  process.exitCode = 1;
});
