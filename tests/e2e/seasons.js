// Ende-zu-Ende: Admin → Seasons und das Winter-Thema auf OnYourSites eigenen Seiten – im Admin „On“ speichern, dann
// haben Startseite, Anmelden und die 404-Seite den Schnee (ohne Klicks abzufangen, ohne seitliches Scrollen am Handy),
// eine Nutzerseite und der Editor nicht; die Vorschau zeigt das Thema, während es aus ist; „Off“ nimmt es wieder weg.
// Jeder native Dialog (alert/confirm/prompt) lässt den Lauf scheitern.
//   node tests/e2e/seasons.js
// Startet die Seite selbst (Port OYS_E2E_PORT, Vorgabe 14210). Nutzt das Admin-Konto des Seeds (admin@test.de) und
// stellt das Thema am Anfang ausdrücklich aus (ohne Einstellung wäre es vom 1.12. bis 6.1. an) und entfernt die
// Einstellung oys_meta['site_seasons'] am Ende wieder. Nur gegen eine Test-Datenbank (Name beginnt mit
// oys_test, sonst Abbruch mit Code 2 vor jedem SQL). Umgebung: OYS_CONFIG, OYS_E2E_PASSWORD, OYS_E2E_ONLY, OYS_E2E_SHOTS.
'use strict';
const path = require('path');
const { chromium } = require('playwright');
const { ok, watchPage, step, summary, sleep } = require('./lib');
const { testSite } = require('./site');

const site = testSite(14210);
const { sql } = site;
const B = site.base;
const PASSWORD = process.env.OYS_E2E_PASSWORD || ['test', '1234'].join('');
const SHOTS = process.env.OYS_E2E_SHOTS || '';
const reset = () => sql("DELETE FROM oys_meta WHERE meta_key = 'site_seasons'");
const startOff = () => sql("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('site_seasons', '{\"winter\":{\"mode\":\"off\",\"from\":\"12-01\",\"to\":\"01-06\"}}')");

let browser;
const IGNORED_CONSOLE = /tailwindcss|favicon|ERR_FAILED|net::|preload|404/;
const shot = async (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, name + '.png') });
const hasSnow = (page) => page.evaluate(() => !!document.querySelector('body.season-winter > .oys-season') && [...document.styleSheets].some((s) => /season-winter\.css/.test(s.href || '')));

async function login(page, email) {
  await page.goto(B + '/login');
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', PASSWORD);
  await Promise.all([page.waitForNavigation(), page.click('form[action="/login"] button[type=submit]')]);
}

(async () => {
  startOff();
  await site.start();
  browser = await chromium.launch({ args: site.browserArgs });
  try {
    await step('admin: the Seasons section saves "On", the own pages get the winter theme', async () => {
      const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      const page = await ctx.newPage();
      watchPage(page);
      page.on('console', (m) => { if (m.type() === 'error' && !IGNORED_CONSOLE.test(m.text())) ok(false, 'console error: ' + m.text()); });
      // Aus: die Startseite ohne Thema, die Vorschau mit
      await page.goto(B + '/');
      ok(!(await hasSnow(page)), 'off: the home page has no theme');
      await page.goto(B + '/?season_preview=winter');
      ok(await hasSnow(page), 'the preview shows the theme while it is off');

      await login(page, 'admin@test.de');
      await page.goto(B + '/admin#seasons');
      await page.waitForSelector('#tab-seasons:not(.hidden) [data-season="winter"]');
      ok((await page.innerText('#admin-page-title')).trim() === 'Seasons', 'the page title reads "Seasons"');
      ok(await page.isVisible('#nav-seasons'), 'Seasons is in the menu');
      await shot(page, 'seasons-admin-off');
      await page.check('[data-season="winter"] input[name=mode][value=on]');
      await Promise.all([page.waitForNavigation(), page.click('[data-season="winter"] button[type=submit]')]);
      ok(/Winter is on for OnYourSite’s own pages\./.test(await page.innerText('body')), 'the notice says it is on');
      ok(/active now/i.test(await page.innerText('[data-season="winter"]')), 'the card says "Active now"');
      await shot(page, 'seasons-admin-on');

      for (const url of ['/', '/login', '/register', '/updates', '/imprint', '/no-such-page-at-all']) {
        await page.goto(B + url);
        ok(await hasSnow(page), url + ': winter theme');
      }
      await page.goto(B + '/');
      await sleep(600);
      await shot(page, 'seasons-home-winter');
      // Der Schnee fängt keine Klicks ab: ein Link der Startseite ist anklickbar
      const pe = await page.evaluate(() => getComputedStyle(document.querySelector('.oys-season')).pointerEvents);
      ok(pe === 'none', 'the decoration lets clicks through (' + pe + ')');
      const link = page.locator('main a:visible, a:visible').first();
      const box = await link.boundingBox();
      const hit = await page.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y); return !!(el && el.closest('a')); }, [box.x + box.width / 2, box.y + box.height / 2]);
      ok(hit, 'a link under the snow is still the element that gets the click');
      // Nicht: Editor und Admin
      await page.goto(B + '/dashboard');
      ok(!(await hasSnow(page)), 'the editor has no theme');
      await page.goto(B + '/admin');
      ok(!(await hasSnow(page)), 'the admin panel has no theme');
      await ctx.close();
    });

    await step('phone: the theme fits, users’ pages stay as they are', async () => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const page = await ctx.newPage();
      watchPage(page);
      await page.goto(B + '/');
      ok(await hasSnow(page), 'the home page has the theme');
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      ok(wide <= 0, 'no sideways scrolling (' + wide + ')');
      await sleep(600);
      await shot(page, 'seasons-home-phone');
      await page.goto('http://mia.' + site.host + ':' + site.port + '/');
      ok(await page.evaluate(() => document.body.classList.contains('oys')), 'mia’s page loads');
      ok(!(await hasSnow(page)), 'a user’s page has no season theme');
      await ctx.close();
    });

    await step('admin: "Off" takes the theme away again', async () => {
      const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      const page = await ctx.newPage();
      watchPage(page);
      await login(page, 'admin@test.de');
      await page.goto(B + '/admin#seasons');
      await page.waitForSelector('#tab-seasons:not(.hidden) [data-season="winter"]');
      await page.check('[data-season="winter"] input[name=mode][value=off]');
      await Promise.all([page.waitForNavigation(), page.click('[data-season="winter"] button[type=submit]')]);
      ok(/Winter is off\./.test(await page.innerText('body')), 'the notice says it is off');
      await page.goto(B + '/');
      ok(!(await hasSnow(page)), 'the home page is back to normal');
      await ctx.close();
    });
  } finally {
    await browser.close();
    site.stop();
    reset();
    summary('seasons');
  }
})().catch((err) => {
  console.error(err);
  site.stop();
  reset();
  process.exit(1);
});
