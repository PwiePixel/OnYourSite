// Ende-zu-Ende: Mails des Shops (honeycomb-shop HC-7b) im Editor und im Admin. Der Schalter „Email me before an unlock
// ends“ unter „Your unlocks“ ist an, lässt sich aus- und wieder einschalten (gespeichert, Meldung, nach dem Neuladen
// gleich); im Admin steht das Budget „Emails per run“ (Standard 100) unter „Earning rules“.
// Jeder native Dialog (alert/confirm/prompt) lässt den Lauf scheitern.
//   node tests/e2e/hc-mails.js
// Startet die Seite selbst (Port OYS_E2E_PORT, Vorgabe 14219) und legt ein eigenes Testkonto an (id 9407 mit Seite 9417),
// das am Ende wieder verschwindet. Nur gegen eine Test-Datenbank (Name beginnt mit oys_test, sonst Abbruch mit Code 2 vor
// jedem SQL). Umgebung: OYS_CONFIG, OYS_E2E_PASSWORD, OYS_E2E_SHOTS.
'use strict';
const path = require('path');
const { chromium } = require('playwright');
const { ok, watchPage, step, summary } = require('./lib');
const { testSite } = require('./site');

const site = testSite(14219);
const { sql, count } = site;
const B = site.base;
const PASSWORD = process.env.OYS_E2E_PASSWORD || ['test', '1234'].join('');
const SHOTS = process.env.OYS_E2E_SHOTS || '';
const U = 9407;

const P = 9417;
function cleanup() {
  sql(`DELETE FROM notifications WHERE user_id = ${U};
    DELETE FROM honeycomb_ledger WHERE user_id = ${U};
    DELETE FROM hc_accounts WHERE user_id = ${U};
    DELETE FROM page_blocks WHERE page_id IN (SELECT id FROM pages WHERE user_id = ${U});
    DELETE FROM pages WHERE user_id = ${U};
    DELETE FROM users WHERE id = ${U};
    DELETE FROM rate_limits WHERE rl_key = 'hcset:${U}';`);
}
function fixtures() {
  cleanup();
  sql(`INSERT INTO users (id, email, password, full_name, username, created_at)
      SELECT ${U}, 'hc-mails@test.de', password, 'Mail Fan', 'mailfan', '2026-01-01 10:00:00' FROM users WHERE id = 5;
    INSERT INTO pages (id, user_id, slug, position, title, subtitle, bio, theme, layout, address_mode, settings, created_at, updated_at)
      SELECT ${P}, ${U}, 'mailfan', 0, 'Mail Fan', '', '', theme, layout, 'subdomain', settings, NOW(), NOW() FROM pages WHERE id = 2;
    INSERT INTO hc_accounts (user_id, streak, streak_day, best_streak, created_at, updated_at) VALUES (${U}, 1, CURDATE(), 1, NOW(), NOW());
    INSERT INTO honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (${U}, 0, 'daily', DATE_FORMAT(NOW(), '%Y-%m-%d'), '', NOW());`);
}
const balance = () => count(`SELECT COALESCE(SUM(amount), 0) FROM honeycomb_ledger WHERE user_id = ${U}`);
let loads = 0;
async function shopTab(page) {
  await page.goto(B + '/dashboard?page=' + P + '&load=' + ++loads + '#honeycombs');
  await page.waitForSelector('#tab-honeycombs:not(.hidden) .shop-wallet');
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
    await step('the switch “Email me before an unlock ends”: on by default, off is saved, admin mode only shows it', async () => {
      const u = await newPage();
      await login(u.page, 'hc-mails@test.de');
      await shopTab(u.page);
      const box = u.page.locator('#shopMailReminders');
      ok(await box.isChecked(), 'on by default');
      await u.page.click('#shopMailRow label.switch');
      await toast(u.page, 'No more emails');
      ok(sql(`SELECT mail_reminders FROM hc_accounts WHERE user_id = ${U}`) === '0', 'saved: off');
      await shopTab(u.page);
      ok(!(await u.page.locator('#shopMailReminders').isChecked()), 'still off after a reload');
      await u.page.click('#shopMailRow label.switch');
      await toast(u.page, 'You’ll get an email');
      ok(sql(`SELECT mail_reminders FROM hc_accounts WHERE user_id = ${U}`) === '1', 'saved: on');
      await shot(u.page, 'hc-mails-switch');
      await u.ctx.close();

      // Admin: das Budget steht bei den Regeln
      const a = await newPage();
      await login(a.page, 'admin@test.de');
      await a.page.goto(B + '/admin?hc_tab=rules#honeycombs');
      ok(await a.page.locator('#hcRule-mail_per_run').inputValue() === '100', 'admin: emails per run, default 100');
      await a.ctx.close();
    });
  } finally {
    await browser.close();
    site.stop();
    cleanup();
  }
  summary('hc-mails');
})().catch((err) => {
  console.error(err);
  try { site.stop(); } catch (e) { /* egal */ }
  try { cleanup(); } catch (e) { /* Datenbank nicht erreichbar */ }
  process.exitCode = 1;
});
