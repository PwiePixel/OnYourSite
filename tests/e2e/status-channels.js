// Ende-zu-Ende: zusätzliche Alarm-Kanäle einer Statusseite (status-pages ST-5). Im Bereich „Status“ → Alerts fügt der
// Besitzer eine E-Mail-Adresse hinzu („Waiting for confirmation“, Resend erst nach 10 Minuten), bestätigt sie über den Link
// (GET zeigt nur einen Knopf, POST bestätigt) → „Working“ mit Test; der Typ „Discord webhook“ zeigt „Incident updates“;
// ohne E-Mail an sich selbst und ohne Kanal erscheint die Warnung; Entfernen über den eigenen Dialog; schmal ohne
// waagrechtes Verschieben. Jeder native Dialog (alert/confirm/prompt) lässt den Lauf scheitern.
//   node tests/e2e/status-channels.js
// Startet die Seite selbst (Port OYS_E2E_PORT, Vorgabe 14227) und legt ein eigenes Testkonto an (id 9452 mit Seite 9462),
// das am Ende wieder verschwindet. Nur gegen eine Test-Datenbank (Name beginnt mit oys_test, sonst Abbruch mit Code 2
// vor jedem SQL). Umgebung: OYS_CONFIG, OYS_E2E_PASSWORD, OYS_E2E_SHOTS.
'use strict';
const path = require('path');
const { chromium } = require('playwright');
const { ok, watchPage, step, summary } = require('./lib');
const { testSite } = require('./site');

const site = testSite(14227);
const { sql, count } = site;
const B = site.base;
const PASSWORD = process.env.OYS_E2E_PASSWORD || ['test', '1234'].join('');
const SHOTS = process.env.OYS_E2E_SHOTS || '';
const U = 9452, P = 9462;
const SLUG = 'e2e-st5-status';

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
      SELECT ${U}, 'st5-user@test.de', password, 'Channel Owner', 'channelowner', '2026-01-01 10:00:00', NOW() FROM users WHERE id = 5;
    INSERT INTO pages (id, user_id, slug, position, title, subtitle, bio, theme, layout, address_mode, settings, created_at, updated_at)
      SELECT ${P}, ${U}, 'channelowner', 0, 'Channel Owner', '', '', theme, layout, 'subdomain', settings, NOW(), NOW() FROM pages WHERE id = 2;
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
    await step('add an email address, confirm it through the link, test and remove it', async () => {
      const { ctx, page } = await newPage();
      await login(page, 'st5-user@test.de');
      await page.goto(B + '/dashboard?page=' + P + '&load=1#status');
      await page.locator('#tab-status:not(.hidden) #stmNewTitle').waitFor();
      await page.fill('#stmNewTitle', 'Channel status');
      await page.fill('#stmNewSlug', SLUG);
      await page.click('[data-stm="create-page"]');
      await page.locator('.st-m-headcard').waitFor();
      await page.click('[data-stm-tab="alerts"]');
      await page.locator('#stChannels').waitFor();
      ok((await page.locator('#stChannels').innerText()).includes('0 of 3 channels used'), 'empty list with the limit');
      // Discord zeigt „Incident updates“, E-Mail nicht
      ok(await page.locator('#stChInc').isHidden(), 'email: no incident updates');
      await page.selectOption('#stChType', 'discord');
      ok(await page.locator('#stChInc').isVisible(), 'discord: incident updates');
      ok((await page.getAttribute('#stChTarget', 'placeholder')).includes('discord.com/api/webhooks'), 'discord placeholder');
      await page.selectOption('#stChType', 'email');
      await page.fill('#stChTarget', 'ops@example.com');
      await page.click('[data-stm="ch-add"]');
      await toast(page, 'confirmation link');
      const row = page.locator('#stChannels .st-m-ch');
      ok(await row.count() === 1 && /waiting for confirmation/i.test(await row.innerText()), 'the row waits for confirmation');
      ok(await row.locator('[data-stm="ch-resend"]').isDisabled(), 'resend only after 10 minutes');
      await shot(page, 'st5-waiting');
      // Den Link erzeugt erst der Versand: hier wie der Benachrichtigungsdienst ein Token setzen
      const tok = 'e2eTokenE2ETokenE2ETokenE2EToken'.slice(0, 32);
      const hash = require('crypto').createHash('sha256').update(tok).digest('hex');
      sql(`UPDATE status_channels SET verify_hash = '${hash}', verify_sent_at = UNIX_TIMESTAMP() WHERE page_id IN (SELECT id FROM status_pages WHERE user_id = ${U})`);
      const v = await browser.newContext();
      const vp = await v.newPage();
      watchPage(vp);
      await vp.goto(B + '/_/status/verify/' + tok);
      ok((await vp.locator('h1').innerText()) === 'Confirm status alerts', 'GET shows the question');
      ok(count(`SELECT COUNT(*) FROM status_channels WHERE verified_at IS NOT NULL AND page_id IN (SELECT id FROM status_pages WHERE user_id = ${U})`) === 0, 'GET confirms nothing');
      await Promise.all([vp.waitForNavigation(), vp.click('form button[type=submit]')]);
      ok((await vp.locator('h1').innerText()) === 'Address confirmed', 'POST confirms');
      await v.close();
      await page.click('[data-stm-tab="components"]');
      await page.click('[data-stm-tab="alerts"]');
      await page.locator('#stChannels .st-m-ch .bdg.green').waitFor();
      ok(/working/i.test(await row.innerText()), 'the row is working');
      await row.locator('[data-stm="ch-test"]').click();
      await toast(page, 'Test sent');
      ok(count(`SELECT COUNT(*) FROM status_outbox WHERE kind = 'test' AND page_id IN (SELECT id FROM status_pages WHERE user_id = ${U})`) === 1, 'a test is queued');
      // E-Mail an sich selbst aus und kein Kanal: Warnung
      await row.locator('[data-stm="ch-remove"]').click();
      await page.locator('.ui-dialog').waitFor();
      ok((await page.locator('.ui-dialog .ui-title').innerText()).startsWith('Remove op'), 'own dialog asks first');
      await page.click('.ui-dialog .ui-foot .ui-btn:not(.is-ghost)');
      await toast(page, 'Channel removed');
      ok(await page.locator('#stChannels .st-m-ch').count() === 0, 'removed');
      await page.click('#stmBody label.switch');
      await page.click('[data-stm="save-owner-alerts"]');
      await toast(page, 'Alerts saved');
      await page.locator('.st-m-warn').waitFor();
      ok((await page.locator('.st-m-warn').innerText()).includes('You won’t be notified when something breaks.'), 'warning without any alert');
      await page.setViewportSize({ width: 390, height: 844 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      ok(overflow <= 0, 'phone width: no horizontal page scroll (' + overflow + ')');
      await shot(page, 'st5-phone');
      await ctx.close();
    });
  } finally {
    await browser.close();
    site.stop();
    cleanup();
  }
  summary('status-channels');
})().catch((err) => {
  console.error(err);
  try { site.stop(); } catch (e) { /* egal */ }
  try { cleanup(); } catch (e) { /* Datenbank nicht erreichbar */ }
  process.exitCode = 1;
});
