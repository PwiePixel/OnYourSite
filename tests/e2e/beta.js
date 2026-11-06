// Ende-zu-Ende: der Beta-Bereich – im Admin eine Testerin freischalten (Discord nötig), sie meldet sich auf
// beta.<domain> mit ihrem OnYourSite-Konto an, sieht das Panel, schickt eine Meldung; der Admin antwortet, sie sieht die
// Antwort; über „Open the website“ sieht sie die Beta-Webseite (eine zweite Installation mit beta_build, hier derselbe
// Code auf einem eigenen Port) – angemeldet, mit dem Hinweis zurück zum Panel; jemand ohne Freischaltung sieht nur den
// Hinweis, auch auf jeder anderen Adresse; am Handy scrollt nichts seitlich.
// Jeder native Dialog (alert/confirm/prompt) lässt den Lauf scheitern.
//   node tests/e2e/beta.js
// Startet die Seite selbst (Port OYS_E2E_PORT, Vorgabe 14211). Nutzt die Konten des Seeds (admin@test.de, mia@test.de,
// tom@test.de) und setzt Beta-Felder, Meldungen und Bot-Aufträge am Ende zurück. Nur gegen eine Test-Datenbank (Name
// beginnt mit oys_test, sonst Abbruch mit Code 2 vor jedem SQL). Umgebung: OYS_CONFIG, OYS_E2E_PASSWORD, OYS_E2E_ONLY,
// OYS_E2E_SHOTS.
'use strict';
const path = require('path');
const { chromium } = require('playwright');
const { ok, watchPage, step, summary } = require('./lib');
const { testSite } = require('./site');

const fs = require('fs');
const os = require('os');
const site = testSite(14211);
const betaSite = testSite(14212);
const { sql } = site;
const B = site.base;
const BETA = 'http://beta.' + site.host + ':' + site.port;
const PASSWORD = process.env.OYS_E2E_PASSWORD || ['test', '1234'].join('');
const SHOTS = process.env.OYS_E2E_SHOTS || '';
const shot = async (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true });
const IGNORED_CONSOLE = /tailwindcss|favicon|ERR_FAILED|net::|preload|404/;

function reset() {
  sql(`UPDATE users SET beta_at = NULL, beta_by = NULL, beta_discord = NULL, beta_role = NULL, beta_role_error = NULL WHERE id IN (3, 5, 6);
    DELETE FROM beta_reports WHERE user_id IN (5, 6);
    DELETE FROM community_outbox WHERE action = 'beta.role';
    DELETE FROM notifications WHERE type = 'beta';
    DELETE FROM oys_meta WHERE meta_key = 'beta_notes';`);
}

async function newPage(ctx) {
  const page = await ctx.newPage();
  watchPage(page);
  page.on('console', (m) => { if (m.type() === 'error' && !IGNORED_CONSOLE.test(m.text())) ok(false, 'console error: ' + m.text()); });
  return page;
}
async function loginMain(page, email) {
  await page.goto(B + '/login');
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', PASSWORD);
  await Promise.all([page.waitForNavigation(), page.click('form[action="/login"] button[type=submit]')]);
}

let browser;
(async () => {
  reset();
  // Die Beta-Webseite: ihre Version liegt in VERSION ihres Code-Ordners (hier ein Ordner nur dafür)
  const betaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oys-e2e-beta-'));
  fs.writeFileSync(path.join(betaDir, 'VERSION'), '3.6.0-beta.1\n');
  await betaSite.start({ port: betaSite.port, config: { beta_build: true, base_domain: 'beta.' + site.host + ':' + site.port } });
  await site.start({ config: { beta_site: { port: betaSite.port, dir: betaDir } } });
  browser = await chromium.launch({ args: site.browserArgs });
  try {
    await step('admin: add a tester (only with Discord), write what to test', async () => {
      const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      const mia = await newPage(ctx);
      await loginMain(mia, 'mia@test.de');
      // Discord verknüpfen wie ein Nutzer: Editor → Einstellungen → Discord ID → Save
      await mia.goto(B + '/dashboard?load=1#settings');
      await mia.waitForSelector('#discordId');
      await mia.fill('#discordId', '111111111111111111');
      const [resp] = await Promise.all([mia.waitForResponse((r) => r.url().includes('/dashboard/api/discord')), mia.click('#saveDiscord')]);
      const res = resp.status();
      ok(res === 200, 'Mia links her Discord in the editor (' + res + ')');
      await ctx.close();

      const actx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      const admin = await newPage(actx);
      await loginMain(admin, 'admin@test.de');
      await admin.goto(B + '/admin#beta');
      await admin.waitForSelector('#tab-beta:not(.hidden)');
      ok((await admin.innerText('#admin-page-title')).trim() === 'Beta', 'the page title reads "Beta"');
      await admin.fill('#beta-who', 'tom@test.de');
      await Promise.all([admin.waitForNavigation(), admin.click('#tab-beta form:has(#beta-who) button[type=submit]')]);
      ok(/has no Discord linked/.test(await admin.innerText('body')), 'Tom without Discord can’t be added');
      await admin.goto(B + '/admin#beta');
      await admin.waitForSelector('#tab-beta:not(.hidden)');
      await admin.fill('#beta-who', 'mia');
      await Promise.all([admin.waitForNavigation(), admin.click('#tab-beta form:has(#beta-who) button[type=submit]')]);
      ok(/mia@test\.de is a beta tester now/.test(await admin.innerText('body')), 'Mia is a tester');
      ok(await admin.isVisible('[data-tester="5"]'), 'Mia is in the list');
      ok(/waiting for the bot/i.test(await admin.innerText('[data-tester="5"]')), 'the role waits for the bot');
      ok(sql("SELECT COUNT(*) FROM community_outbox WHERE action = 'beta.role' AND done_at IS NULL") === '1', 'one job for the bot');
      await admin.fill('#tab-beta textarea[name=notes]', 'Try the new block picker and the winter look.');
      await Promise.all([admin.waitForNavigation(), admin.click('#tab-beta form:has(textarea[name=notes]) button[type=submit]')]);
      await admin.goto(B + '/admin#beta');
      await admin.waitForSelector('#tab-beta:not(.hidden)');
      await shot(admin, 'beta-admin');
      await actx.close();
    });

    await step('beta.<domain>: Mia logs in with her account, sees the panel and sends a report', async () => {
      const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      const page = await newPage(ctx);
      await page.goto(BETA + '/');
      ok(/Welcome to the beta/.test(await page.innerText('body')), 'the login of the beta area');
      await shot(page, 'beta-login');
      await page.fill('#beta-email', 'mia@test.de');
      await page.fill('#beta-password', 'wrong-password');
      await Promise.all([page.waitForNavigation(), page.click('form[action="/_beta/login"] button[type=submit]')]);
      ok(/Wrong email or password/.test(await page.innerText('body')), 'a wrong password is refused');
      await page.fill('#beta-email', 'mia@test.de');
      await page.fill('#beta-password', PASSWORD);
      await Promise.all([page.waitForNavigation(), page.click('form[action="/_beta/login"] button[type=submit]')]);
      ok(/thanks for testing!/.test(await page.innerText('body')), 'the panel');
      ok(/Try the new block picker and the winter look\./.test(await page.innerText('body')), 'what to test');
      await page.selectOption('#r-kind', 'bug');
      await page.selectOption('#r-area', 'editor');
      await page.fill('#r-title', 'Countdown shows the wrong time');
      await page.fill('#r-body', 'It is one hour off after the time change.');
      await page.fill('#r-steps', '1. Add a countdown 2. Look at it');
      await Promise.all([page.waitForNavigation(), page.click('form[action="/_beta/report"] button[type=submit]')]);
      ok(/Thanks! Your report was sent to the team\./.test(await page.innerText('body')), 'the report was sent');
      ok(/Countdown shows the wrong time/.test(await page.innerText('#reports')), 'it is in the list');
      ok(/open/i.test(await page.innerText('#reports [data-report]')), 'status Open');
      await shot(page, 'beta-panel');
      ok(/3\.6\.0-beta\.1/.test(await page.innerText('#beta-website')), 'the panel shows the version of the beta website');
      // „Open the website“: die Beta-Webseite unter derselben Adresse, schon angemeldet
      await Promise.all([page.waitForNavigation(), page.click('[data-open-website]')]);
      ok(page.url() === BETA + '/', 'the beta website at ' + BETA + '/ (' + page.url() + ')');
      ok(await page.isVisible('#oys-beta-pill'), 'the note back to the panel');
      ok(/^BETA\s*3\.6\.0-beta\.1\s*·\s*Panel$/.test((await page.innerText('#oys-beta-pill')).trim()), 'with the version');
      await shot(page, 'beta-website');
      await page.goto(BETA + '/dashboard');
      ok(page.url().startsWith(BETA + '/dashboard'), 'the editor of the beta website, logged in with the same session (' + page.url() + ')');
      await page.waitForSelector('#oys-beta-pill');
      await Promise.all([page.waitForNavigation(), page.click('#oys-beta-pill')]);
      ok(/thanks for testing!/.test(await page.innerText('body')), 'back in the panel');
      ok(/beta website/.test(betaSite.log()), 'the beta website answered the requests');
      await ctx.close();
    });

    await step('admin answers; Mia sees the status and the reply', async () => {
      const actx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      const admin = await newPage(actx);
      await loginMain(admin, 'admin@test.de');
      await admin.goto(B + '/admin#beta');
      await admin.waitForSelector('#tab-beta:not(.hidden) [data-report]');
      const rep = admin.locator('#tab-beta [data-report]').first();
      await rep.locator('select[name=status]').selectOption('in_progress');
      await rep.locator('textarea[name=reply]').fill('Thanks, we’re on it.');
      await Promise.all([admin.waitForNavigation(), rep.locator('button[type=submit]').click()]);
      ok(/Report saved/.test(await admin.innerText('body')), 'the answer is saved');
      await actx.close();
      const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      const page = await newPage(ctx);
      await page.goto(BETA + '/');
      await page.fill('#beta-email', 'mia@test.de');
      await page.fill('#beta-password', PASSWORD);
      await Promise.all([page.waitForNavigation(), page.click('form[action="/_beta/login"] button[type=submit]')]);
      const list = await page.innerText('#reports');
      ok(/in progress/i.test(list) && /Thanks, we’re on it\./.test(list), 'status and reply are shown');
      await ctx.close();
    });

    await step('someone who isn’t a tester sees a note; the phone layout fits', async () => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const page = await newPage(ctx);
      await page.goto(BETA + '/');
      await page.fill('#beta-email', 'tom@test.de');
      await page.fill('#beta-password', PASSWORD);
      await Promise.all([page.waitForNavigation(), page.click('form[action="/_beta/login"] button[type=submit]')]);
      ok(/For beta testers only/.test(await page.innerText('body')), 'Tom sees the note');
      await page.goto(BETA + '/dashboard');
      ok(page.url() === BETA + '/_beta/' && /For beta testers only/.test(await page.innerText('body')), 'not the beta website either (' + page.url() + ')');
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      ok(wide <= 0, 'no sideways scrolling (' + wide + ')');
      await shot(page, 'beta-denied-phone');
      await ctx.close();
      const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const mia = await newPage(mctx);
      await mia.goto(BETA + '/');
      await mia.fill('#beta-email', 'mia@test.de');
      await mia.fill('#beta-password', PASSWORD);
      await Promise.all([mia.waitForNavigation(), mia.click('form[action="/_beta/login"] button[type=submit]')]);
      const w2 = await mia.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      ok(w2 <= 0, 'the panel fits on a phone (' + w2 + ')');
      await shot(mia, 'beta-panel-phone');
      await mctx.close();
    });
  } finally {
    await browser.close();
    site.stop();
    betaSite.stop();
    reset();
    sql("UPDATE users SET discord_id = NULL WHERE id = 5");
    summary('beta');
  }
})().catch((err) => {
  console.error(err);
  site.stop();
  betaSite.stop();
  reset();
  process.exit(1);
});
