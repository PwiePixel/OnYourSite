// Ende-zu-Ende: Serie und Tageslimit (honeycomb-shop HC-8). Beim Öffnen des Editors am 7. Tag in Folge kommen zwei
// gelbe Meldungen (Tagesbonus und 7-Tage-Bonus); der Bereich „Honeycombs“ zeigt die Serie („Day 7 · best 9“), die
// Regel „Keep a streak“ mit dem nächsten Bonus und das Tageslimit; schmal ohne waagrechtes Verschieben. Im Admin
// stehen die neuen Felder unter „Earning rules“, das Tageslimit wird auf mindestens 50 begrenzt.
// Jeder native Dialog (alert/confirm/prompt) lässt den Lauf scheitern.
//   node tests/e2e/hc-streaks.js
// Startet die Seite selbst (Port OYS_E2E_PORT, Vorgabe 14207) und legt ein eigenes Testkonto an (id 9402 mit Seite 9412),
// das am Ende wieder verschwindet; die Regeln der Honigwaben werden zurückgesetzt. Nur gegen eine Test-Datenbank (Name
// beginnt mit oys_test, sonst Abbruch mit Code 2 vor jedem SQL). Umgebung: OYS_CONFIG, OYS_E2E_PASSWORD, OYS_E2E_SHOTS.
'use strict';
const path = require('path');
const { chromium } = require('playwright');
const { ok, watchPage, step, summary } = require('./lib');
const { testSite } = require('./site');

const site = testSite(14207);
const { sql } = site;
const B = site.base;
const PASSWORD = process.env.OYS_E2E_PASSWORD || ['test', '1234'].join('');
const SHOTS = process.env.OYS_E2E_SHOTS || '';
const U = 9402, P = 9412;
let rulesBefore = null;

function cleanup() {
  sql(`DELETE FROM page_blocks WHERE page_id IN (SELECT id FROM pages WHERE user_id = ${U});
    DELETE FROM pages WHERE user_id = ${U};
    DELETE FROM notifications WHERE user_id = ${U};
    DELETE FROM honeycomb_ledger WHERE user_id = ${U};
    DELETE FROM hc_entitlements WHERE user_id = ${U}; DELETE FROM hc_purchases WHERE user_id = ${U}; DELETE FROM hc_accounts WHERE user_id = ${U};
    DELETE FROM rate_limits WHERE rl_key IN ('hcbuy:${U}', 'hchist:${U}');
    DELETE FROM users WHERE id = ${U};`);
}
// Gestern im Kalender der Seite (config.timezone), nicht der Datenbank
function yesterday() {
  const tz = String(site.cfg.timezone || 'Europe/Berlin');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const d = new Date(parts + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
// Konto am 7. Tag: Serie 6 bis gestern, beste 9, heute noch nichts verdient
function fixtures() {
  cleanup();
  sql(`INSERT INTO users (id, email, password, full_name, username, created_at)
      SELECT ${U}, 'hc-streak@test.de', password, 'Streak Keeper', 'streakkeeper', '2026-01-01 10:00:00' FROM users WHERE id = 5;
    INSERT INTO pages (id, user_id, slug, position, title, subtitle, bio, theme, layout, address_mode, settings, created_at, updated_at)
      SELECT ${P}, ${U}, 'streakkeeper', 0, 'Streak Keeper', '', '', theme, layout, 'subdomain', settings, NOW(), NOW() FROM pages WHERE id = 2;
    INSERT INTO hc_accounts (user_id, streak, streak_day, best_streak, created_at, updated_at) VALUES (${U}, 6, '${yesterday()}', 9, NOW(), NOW());`);
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
  rulesBefore = sql("SELECT meta_value FROM oys_meta WHERE meta_key = 'honeycombs'");
  sql("DELETE FROM oys_meta WHERE meta_key = 'honeycombs'");
  await site.start();
  browser = await chromium.launch({ args: site.browserArgs });
  try {
    await step('day 7: two yellow notices, the streak chip, the streak rule and the daily limit', async () => {
      fixtures();
      const { ctx, page } = await newPage();
      // Die Anmeldung führt in den Editor: dieses erste Laden bucht und zeigt die Meldungen
      await login(page, 'hc-streak@test.de');
      const streakToast = page.locator('.ui-toast.hc', { hasText: 'for a 7-day streak' });
      await streakToast.waitFor({ timeout: 8000 });
      ok((await streakToast.innerText()).includes('15'), 'toast: +15 for a 7-day streak');
      ok(await page.locator('.ui-toast.hc', { hasText: 'for being active today' }).count() === 1, 'toast: for being active today');
      ok(sql(`SELECT CONCAT(streak, '|', best_streak) FROM hc_accounts WHERE user_id = ${U}`) === '7|9', 'streak 7, best 9');
      ok(sql(`SELECT SUM(amount) FROM honeycomb_ledger WHERE user_id = ${U}`) === '20', 'booked 5 + 15');
      await page.goto(B + '/dashboard?page=' + P + '&load=1#honeycombs');
      await page.waitForSelector('#tab-honeycombs:not(.hidden) .shop-wallet');
      ok((await page.locator('#shopStreak').innerText()).trim() === 'Day 7 · best 9', 'streak chip: Day 7 · best 9');
      const rule = page.locator('#tab-honeycombs .hc-rule', { hasText: 'Keep a streak' });
      ok((await rule.innerText()).includes('Day 7 – 7 more days to +15'), 'streak rule shows the next bonus');
      ok((await page.locator('#shopCap').innerText()).includes('Daily limit: 300 of 300 left today'), 'daily limit hint');
      await shot(page, 'hc-streaks-wallet');
      // Neu laden: nichts kommt doppelt
      await page.goto(B + '/dashboard?page=' + P + '&load=2#honeycombs');
      await page.waitForSelector('#tab-honeycombs:not(.hidden) .shop-wallet');
      await page.waitForTimeout(1500);
      ok(await page.locator('.ui-toast.hc', { hasText: 'for a 7-day streak' }).count() === 0, 'reload: no second notice');
      ok(sql(`SELECT SUM(amount) FROM honeycomb_ledger WHERE user_id = ${U}`) === '20', 'reload: nothing booked twice');
      await ctx.close();
    });

    await step('phone width: the wallet with the streak chip fits', async () => {
      const { ctx, page } = await newPage(390, 844);
      await login(page, 'hc-streak@test.de');
      await page.goto(B + '/dashboard?page=' + P + '&load=3#honeycombs');
      await page.waitForSelector('#tab-honeycombs:not(.hidden) .shop-wallet');
      ok(await page.locator('#shopStreak').isVisible(), 'streak chip visible on a phone');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      ok(overflow <= 0, 'no horizontal page scroll (' + overflow + ')');
      await shot(page, 'hc-streaks-phone');
      await ctx.close();
    });

    await step('admin: the earning rules have the streak bonuses and the daily limit (at least 50)', async () => {
      const { ctx, page } = await newPage();
      await login(page, 'admin@test.de');
      await page.goto(B + '/admin?hc_tab=rules#honeycombs');
      for (const k of ['streak_week', 'streak_month', 'daily_cap']) ok(await page.locator('#hcRule-' + k).isVisible(), 'field ' + k);
      ok(await page.locator('#hcRule-daily_cap').getAttribute('min') === '50', 'daily limit min 50');
      await page.fill('#hcRule-streak_week', '20');
      // Unter dem Minimum: der Browser prüft über ui.js (eigene Meldung), also direkt über das Formular schicken
      await page.evaluate(() => { document.getElementById('hcRule-daily_cap').removeAttribute('min'); });
      await page.fill('#hcRule-daily_cap', '10');
      await Promise.all([page.waitForNavigation(), page.click('#hcRulesForm button[type=submit]')]);
      const saved = JSON.parse(sql("SELECT meta_value FROM oys_meta WHERE meta_key = 'honeycombs'"));
      ok(saved.streak_week === 20 && saved.daily_cap === 50, 'saved: streak 20, daily limit clamped to 50');
      ok(await page.locator('#hcRule-daily_cap').inputValue() === '50', 'the form shows 50 again');
      await shot(page, 'hc-streaks-admin');
      await ctx.close();
    });
  } finally {
    await browser.close();
    site.stop();
    cleanup();
    if (rulesBefore) sql(`REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('honeycombs', '${rulesBefore.replace(/'/g, "''")}')`);
    else sql("DELETE FROM oys_meta WHERE meta_key = 'honeycombs'");
  }
  summary('hc-streaks');
})().catch((err) => {
  console.error(err);
  try { site.stop(); } catch (e) { /* egal */ }
  try { cleanup(); } catch (e) { /* Datenbank nicht erreichbar */ }
  process.exitCode = 1;
});
