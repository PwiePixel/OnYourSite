// Ende-zu-Ende: Event-Codes (honeycomb-shop HC-9). Der Admin legt im Unterbereich „Codes“ einen Code an; der Nutzer löst
// ihn im Bereich „Honeycombs“ ein (gelbe Meldung, Kontostand, Verlauf), ein zweites Mal geht nicht; der Admin schaltet den
// Code über den eigenen Dialog ab, danach gilt er nicht mehr; sechs falsche Codes → „Too many tries“.
// Jeder native Dialog (alert/confirm/prompt) lässt den Lauf scheitern.
//   node tests/e2e/hc-codes.js
// Startet die Seite selbst (Port OYS_E2E_PORT, Vorgabe 14218) und legt ein eigenes Testkonto an (id 9406 mit Seite 9416),
// das am Ende wieder verschwindet; die angelegten Codes (E2E-…) werden gelöscht. Nur gegen eine Test-Datenbank (Name
// beginnt mit oys_test, sonst Abbruch mit Code 2 vor jedem SQL). Umgebung: OYS_CONFIG, OYS_E2E_PASSWORD, OYS_E2E_SHOTS.
'use strict';
const path = require('path');
const { chromium } = require('playwright');
const { ok, watchPage, step, summary } = require('./lib');
const { testSite } = require('./site');

const site = testSite(14218);
const { sql, count } = site;
const B = site.base;
const PASSWORD = process.env.OYS_E2E_PASSWORD || ['test', '1234'].join('');
const SHOTS = process.env.OYS_E2E_SHOTS || '';
const U = 9406;

const P = 9416;
function cleanup() {
  sql(`DELETE FROM notifications WHERE user_id = ${U};
    DELETE FROM honeycomb_ledger WHERE user_id = ${U};
    DELETE FROM hc_accounts WHERE user_id = ${U};
    DELETE FROM rate_limits WHERE rl_key LIKE 'hcredeem:${U}%';
    DELETE FROM page_blocks WHERE page_id IN (SELECT id FROM pages WHERE user_id = ${U});
    DELETE FROM pages WHERE user_id = ${U};
    DELETE FROM users WHERE id = ${U};
    DELETE FROM hc_codes WHERE code LIKE 'E2E-%';
    DELETE FROM hc_audit WHERE action IN ('code_create', 'code_disable') AND created_at > NOW() - INTERVAL 1 DAY;`);
}
function fixtures() {
  cleanup();
  sql(`INSERT INTO users (id, email, password, full_name, username, created_at)
      SELECT ${U}, 'hc-codes@test.de', password, 'Code Fan', 'codefan', '2026-01-01 10:00:00' FROM users WHERE id = 5;
    INSERT INTO pages (id, user_id, slug, position, title, subtitle, bio, theme, layout, address_mode, settings, created_at, updated_at)
      SELECT ${P}, ${U}, 'codefan', 0, 'Code Fan', '', '', theme, layout, 'subdomain', settings, NOW(), NOW() FROM pages WHERE id = 2;
    INSERT INTO hc_accounts (user_id, streak, streak_day, best_streak, created_at, updated_at) VALUES (${U}, 1, CURDATE(), 1, NOW(), NOW());
    INSERT INTO honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (${U}, 0, 'daily', DATE_FORMAT(NOW(), '%Y-%m-%d'), '', NOW());`);
}
const balance = () => count(`SELECT COALESCE(SUM(amount), 0) FROM honeycomb_ledger WHERE user_id = ${U}`);
let loads = 0;
async function shopTab(page) {
  await page.goto(B + '/dashboard?page=' + P + '&load=' + ++loads + '#honeycombs');
  await page.waitForSelector('#tab-honeycombs:not(.hidden) .shop-wallet');
}
async function redeem(page, value) {
  await page.fill('#shopCode', value);
  await page.click('#shopRedeemForm button[type=submit]');
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
    await step('the admin creates a code; the user redeems it once', async () => {
      const a = await newPage();
      await login(a.page, 'admin@test.de');
      await a.page.goto(B + '/admin?hc_tab=codes#honeycombs');
      await a.page.fill('#hcCode', 'e2e-spooky');
      await a.page.fill('#hcCodeAmount', '40');
      await a.page.fill('#hcCodeNote', 'Spooky night');
      await Promise.all([a.page.waitForNavigation(), a.page.click('#hcCodeForm button[type=submit]')]);
      ok((await toast(a.page, 'E2E-SPOOKY')).includes('created'), 'toast: code created');
      ok((await a.page.locator('#hcCodeRows').innerText()).includes('E2E-SPOOKY'), 'listed');
      await shot(a.page, 'hc-codes-admin');

      const u = await newPage();
      await login(u.page, 'hc-codes@test.de');
      await shopTab(u.page);
      await u.page.click('[data-shop-redeem-focus]');
      ok(await u.page.evaluate(() => document.activeElement && document.activeElement.id === 'shopCode'), '“Redeem a code” focuses the input');
      await redeem(u.page, ' e2e-spooky ');
      const t = u.page.locator('.ui-toast.hc', { hasText: 'Spooky night' });
      await t.waitFor({ timeout: 8000 });
      ok((await t.innerText()).includes('40'), 'yellow toast +40');
      ok(balance() === 40, 'balance 40');
      ok((await u.page.locator('#hcBalance').innerText()).trim() === '40', 'balance pill shows 40');
      await u.page.locator('#shopHist .hc-hist-row', { hasText: 'Spooky night' }).waitFor();
      ok(true, 'the history shows the code');
      await redeem(u.page, 'E2E-SPOOKY');
      await u.page.locator('#shopCodeErr:not([hidden])').waitFor();
      ok((await u.page.locator('#shopCodeErr').innerText()) === 'You’ve already used this code.', 'second time refused');
      await redeem(u.page, '');
      ok((await u.page.locator('#shopCodeErr').innerText()) === 'Please enter a code.', 'empty input');
      await shot(u.page, 'hc-codes-user');

      // Abschalten über den eigenen Dialog: danach gilt der Code nicht mehr
      sql("INSERT INTO hc_codes (code, amount, note, uses, min_account_days, created_by, created_at) VALUES ('E2E-SECOND', 10, '', 0, 0, 3, NOW())");
      // Eigener Parameter: dieselbe Adresse mit Anker lädt nicht neu
      await a.page.goto(B + '/admin?hc_tab=codes&reload=1#honeycombs');
      const id = sql("SELECT id FROM hc_codes WHERE code = 'E2E-SECOND'");
      await a.page.locator(`#hcCodeRows [data-code="${id}"] button`, { hasText: 'Disable' }).click();
      await confirmDialog(a.page, 'Turn off the code E2E-SECOND?');
      ok(/off/i.test(await a.page.locator(`#hcCodeRows [data-code="${id}"]`).innerText()), 'the code shows “off”');
      await redeem(u.page, 'E2E-SECOND');
      await u.page.waitForFunction(() => document.getElementById('shopCodeErr').textContent.includes('expired'));
      ok(balance() === 40, 'a disabled code gives nothing');
      await a.ctx.close();
      await u.ctx.close();
    });

    await step('wrong codes: after five tries “Too many tries”', async () => {
      const u = await newPage();
      await login(u.page, 'hc-codes@test.de');
      await shopTab(u.page);
      for (let i = 0; i < 5; i++) {
        await redeem(u.page, 'E2E-WRONG-' + i);
        await u.page.waitForFunction((n) => document.getElementById('shopCodeErr').textContent.includes('expired') && document.getElementById('shopCode').value === 'E2E-WRONG-' + n, i);
      }
      await redeem(u.page, 'E2E-WRONG-X');
      await u.page.waitForFunction(() => document.getElementById('shopCodeErr').textContent.includes('Too many tries'));
      ok((await u.page.locator('#shopCodeErr').innerText()) === 'Too many tries. Please wait 15 minutes.', 'rate limit text');
      await u.page.setViewportSize({ width: 390, height: 844 });
      const overflow = await u.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      ok(overflow <= 0, 'phone width: no horizontal page scroll (' + overflow + ')');
      await u.ctx.close();
    });
  } finally {
    await browser.close();
    site.stop();
    cleanup();
  }
  summary('hc-codes');
})().catch((err) => {
  console.error(err);
  try { site.stop(); } catch (e) { /* egal */ }
  try { cleanup(); } catch (e) { /* Datenbank nicht erreichbar */ }
  process.exitCode = 1;
});
