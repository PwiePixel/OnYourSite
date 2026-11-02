// Ende-zu-Ende: Profilseiten mit eigenen Dialogen im Design der Seite (custom-dialogs CD-4, Ablauf 10): geschützter
// Link in drei Themes (dunkel, hell, bunt) mit Fokus im Dialog, Meldung unter dem Feld statt Browser-Blase, Escape
// bringt Fokus und Scroll-Position zurück; Kontaktformular mit Meldungen je Feld; Großansicht der Galerie; Termin- und
// Passwort-Seite ohne JavaScript-Anfrage; ohne ui.js bleibt alles wie bisher. Profilseiten setzen kein Cookie.
//   node tests/e2e/profile-dialogs.js
// Startet die Seite selbst (Port OYS_E2E_PORT, Vorgabe 14206) und legt ein eigenes Testkonto an (id 9201 mit drei
// Seiten), das am Ende wieder verschwindet. Nur gegen eine Test-Datenbank (oys_test…, sonst Abbruch mit Code 2 vor
// jedem SQL). Jeder native Dialog lässt den Lauf scheitern.
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { ROOT, ok, watchPage, step, summary, sleep } = require('./lib');
const { testSite } = require('./site');

const site = testSite(14206);
const { sql, count } = site;
// Passwort des geschützten Links (= Passwort der Testkonten aus seed.php, dessen Hash übernommen wird) – zur Laufzeit
const LINK_PASSWORD = process.env.OYS_E2E_PASSWORD || ['test', '1234'].join('');

const U = 9201;
const PAGES = [
  { id: 9211, slug: 'pdark', theme: 'deep-dark', kind: 'dark' },
  { id: 9212, slug: 'plight', theme: 'minimal', kind: 'light' },
  { id: 9213, slug: 'pcandy', theme: 'candy', kind: 'colourful' },
];
const IMAGE = 'gal_9201_e2e.png';
const IMAGE_FILE = path.join(ROOT, 'static/uploads', IMAGE);
// Block-IDs je Seite: 10 Text (für die Höhe), 20 geschützter Link, 21 ab 18, 30 Kontakt, 40 Galerie, 50 Termin
const block = (p, n) => p.id * 100 + n;
const pageUrl = (p, rest = '/') => 'http://' + p.slug + '.' + site.host + ':' + site.port + rest;

function cleanup() {
  sql(`DELETE FROM page_blocks WHERE page_id IN (SELECT id FROM pages WHERE user_id = ${U});
    DELETE FROM stats_daily WHERE page_id IN (SELECT id FROM pages WHERE user_id = ${U});
    DELETE FROM block_clicks_daily WHERE page_id IN (SELECT id FROM pages WHERE user_id = ${U});
    DELETE FROM messages WHERE user_id = ${U};
    DELETE FROM user_bookings WHERE user_id = ${U};
    DELETE FROM notifications WHERE user_id = ${U};
    DELETE FROM pages WHERE user_id = ${U};
    DELETE FROM users WHERE id = ${U};`);
  fs.rmSync(IMAGE_FILE, { force: true });
}
function fixtures() {
  cleanup();
  const rows = [];
  for (const p of PAGES) {
    const text = [];
    for (let i = 0; i < 6; i++) text.push(`(${block(p, 10 + i)}, ${p.id}, 'text', ${i}, 1, '{"text":"Line ${i + 1} – some words to make the page long enough to scroll.","align":"center"}', NULL, 'none', NULL, NOW())`);
    rows.push(...text,
      `(${block(p, 20)}, ${p.id}, 'link', 10, 1, '{"title":"Secret link","url":"https://example.com/secret","subtitle":"","icon":"","thumb":"","featured":false}', NULL, 'password', (SELECT password FROM users WHERE id = 5), NOW())`,
      `(${block(p, 21)}, ${p.id}, 'link', 11, 1, '{"title":"Adults link","url":"https://example.com/adults","subtitle":"","icon":"","thumb":"","featured":false}', NULL, 'age', NULL, NOW())`,
      `(${block(p, 30)}, ${p.id}, 'contact', 12, 1, '{"title":"Message me","intro":"","button":"Send message","success":"Thanks! Your message has been sent."}', NULL, 'none', NULL, NOW())`,
      `(${block(p, 40)}, ${p.id}, 'gallery', 13, 1, '{"images":[{"src":"${IMAGE}","caption":"First picture"}],"ratio":"square","autoplay":false}', NULL, 'none', NULL, NOW())`,
      `(${block(p, 50)}, ${p.id}, 'booking', 14, 1, '{"title":"Book a meeting","url":"/kalender"}', NULL, 'none', NULL, NOW())`);
  }
  sql(`INSERT INTO users (id, email, password, full_name, username, created_at) SELECT ${U}, 'profile-e2e@test.de', password, 'Pia Profile', 'pdark', NOW() FROM users WHERE id = 5;
    INSERT INTO pages (id, user_id, slug, position, title, subtitle, bio, theme, layout, address_mode, settings, created_at, updated_at) VALUES
    ${PAGES.map((p, i) => `(${p.id}, ${U}, '${p.slug}', ${i}, 'Pia ${p.kind}', '', '', '${p.theme}', 'buttons', 'subdomain', NULL, NOW(), NOW())`).join(',\n')};
    INSERT INTO page_blocks (id, page_id, type, position, is_visible, data, schedule, protection, password_hash, created_at) VALUES
    ${rows.join(',\n')};`);
  fs.mkdirSync(path.dirname(IMAGE_FILE), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'static/images/favicon.png'), IMAGE_FILE);
}

let browser;
async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1100, height: 700 } });
  const page = await ctx.newPage();
  const t = watchPage(page, {});
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|net::|ERR_FAILED|status of 4\d\d/.test(m.text())) ok(false, 'console error: ' + m.text()); });
  if (opts.blockUi) await page.route('**/static/js/ui.js*', (r) => r.abort());
  const posts = [];
  page.on('request', (r) => { if (r.method() === 'POST') posts.push(new URL(r.url()).pathname); });
  return { ctx, page, t, posts };
}
// Farbe von var(--surface) im Theme der Seite (über ein Hilfselement aufgelöst)
const surface = (page) => page.evaluate(() => {
  const n = document.createElement('div');
  n.style.background = 'var(--surface)';
  document.body.appendChild(n);
  const c = getComputedStyle(n).backgroundColor;
  n.remove();
  return c;
});
const fieldError = (page, sel) => page.evaluate((s) => {
  const f = document.querySelector(s);
  const id = f && f.getAttribute('data-ui-err');
  const p = id ? document.getElementById(id) : null;
  return p ? p.textContent : null;
}, sel);
const inModal = (page) => page.evaluate(() => document.getElementById('oys-modal').contains(document.activeElement));

(async () => {
  fixtures();
  await site.start();
  browser = await chromium.launch({ args: site.browserArgs });
  try {
    for (const p of PAGES) {
      await step(`10 protected link (${p.kind} theme): themed layer, focus, inline error, Escape restores focus and scroll`, async () => {
        const { ctx, page, posts } = await newPage();
        const res = await page.goto(pageUrl(p));
        ok(res.status() === 200 && !res.headers()['set-cookie'], 'profile page without a cookie');
        await page.waitForFunction(() => !!window.OYSUI);
        const link = page.locator(`a[data-b="${block(p, 20)}"]`);
        await link.scrollIntoViewIfNeeded();
        await page.mouse.wheel(0, 120);
        await sleep(200);
        const y = await page.evaluate(() => window.scrollY);
        ok(y > 0, 'the page is scrolled (' + y + ')');
        await link.click();
        await page.waitForSelector('#oys-modal:not([hidden])');
        ok(await page.evaluate(() => document.documentElement.classList.contains('ui-lock') && document.querySelector('main').closest('[inert]') !== null), 'a layer: scroll locked, page behind inert');
        const bg = await page.locator('.oys-modal-box').evaluate((n) => getComputedStyle(n).backgroundColor);
        ok(bg === await surface(page), 'dialog background is the theme’s --surface (' + bg + ')');
        await sleep(100);
        ok(await page.evaluate(() => document.activeElement.name) === 'pw', 'focus in the password field');
        for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
        ok(await inModal(page), 'Tab stays inside the dialog');
        await page.click('.oys-unlock button[type=submit]');
        await sleep(200);
        ok(await fieldError(page, '.oys-unlock input[name=pw]') === 'Please enter the password.', 'empty → message under the field');
        ok(!posts.includes('/_/unlock'), 'no request for an empty password');
        ok(await page.locator('.oys-unlock input[name=pw]').evaluate((n) => getComputedStyle(n).borderTopColor) === 'rgb(239, 68, 68)', 'the field is marked red');
        await page.fill('.oys-unlock input[name=pw]', 'wrong-pass');
        await page.click('.oys-unlock button[type=submit]');
        await page.waitForSelector('.oys-unlock .oys-err:not([hidden])');
        ok(await page.textContent('.oys-unlock .oys-err') === 'Wrong password.' && await fieldError(page, '.oys-unlock input[name=pw]') === null, 'wrong password: today’s inline error, the field message is gone');
        await page.keyboard.press('Escape');
        await sleep(200);
        ok(await page.isHidden('#oys-modal'), 'Escape closes the dialog');
        ok(await page.evaluate((id) => document.activeElement && document.activeElement.getAttribute('data-b') === String(id), block(p, 20)), 'focus back on the link');
        ok(await page.evaluate(() => window.scrollY) === y && !(await page.evaluate(() => document.documentElement.classList.contains('ui-lock'))), 'scroll position kept, page unlocked');
        // Eigene Dialoge aus ui.js tragen dasselbe Design
        await page.evaluate(() => { window.__done = false; OYSUI.alert({ title: 'Hello', text: 'A themed dialog.' }).then(() => { window.__done = true; }); });
        await page.waitForSelector('.ui-dialog');
        ok(await page.locator('.ui-dialog').evaluate((n) => getComputedStyle(n).backgroundColor) === await surface(page), 'ui.js dialogs use the theme’s --surface');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => window.__done === true);
        // Richtiges Passwort: freigeschaltet
        await link.click();
        await page.fill('.oys-unlock input[name=pw]', LINK_PASSWORD);
        await page.click('.oys-unlock button[type=submit]');
        await page.waitForSelector('#oys-modal a.oys-btn');
        ok((await page.textContent('#oys-modal h2')) === 'Unlocked', 'right password: unlocked');
        ok(await page.evaluate(() => document.cookie) === '', 'still no cookie');
        await ctx.close();
      });
    }

    await step('10 adults-only link: themed dialog, Escape', async () => {
      const p = PAGES[1];
      const { ctx, page } = await newPage();
      await page.goto(pageUrl(p));
      await page.waitForFunction(() => !!window.OYSUI);
      await page.click(`a[data-b="${block(p, 21)}"]`);
      await page.waitForSelector('#oys-modal:not([hidden])');
      ok((await page.textContent('#oys-modal h2')) === 'Adults only', 'age dialog');
      await page.keyboard.press('Escape');
      await sleep(150);
      ok(await page.isHidden('#oys-modal'), 'Escape closes it');
      await ctx.close();
    });

    await step('10 contact form: a message under each field in the theme, then sent', async () => {
      const p = PAGES[2];
      const { ctx, page, posts } = await newPage();
      await page.goto(pageUrl(p));
      await page.waitForFunction(() => !!window.OYSUI);
      const form = `#contact-${block(p, 30)}`;
      await page.locator(form).scrollIntoViewIfNeeded();
      await page.click(form + ' .oys-contact-send');
      await sleep(200);
      ok(await fieldError(page, form + ' [name=name]') === 'Please enter your name.', 'name');
      ok(await fieldError(page, form + ' [name=email]') === 'Please enter a valid email address.', 'email');
      ok(await fieldError(page, form + ' [name=message]') === 'Your message is a bit short.', 'message');
      ok(await page.evaluate(() => document.activeElement.name) === 'name', 'focus on the first field');
      ok(await page.textContent(form + ' .oys-contact-status') === '' && !posts.includes('/_/contact'), 'no generic line, nothing sent');
      ok(await page.locator(form + ' .ui-field-err').first().evaluate((n) => getComputedStyle(n).color) === 'rgb(239, 68, 68)', 'messages in red');
      await page.fill(form + ' [name=name]', 'Visitor');
      await page.fill(form + ' [name=email]', 'visitor@');
      await page.fill(form + ' [name=message]', 'abc');
      await page.click(form + ' .oys-contact-send');
      await sleep(200);
      ok(await fieldError(page, form + ' [name=name]') === null, 'a fixed field loses its message');
      ok(await fieldError(page, form + ' [name=email]') === 'Please enter a valid email address.' && await fieldError(page, form + ' [name=message]') === 'Your message is a bit short.', 'invalid email, short message');
      await page.fill(form + ' [name=email]', 'visitor@example.org');
      await page.fill(form + ' [name=message]', 'Hello there, nice page!');
      // Das Zeit-Token des Formulars muss mindestens 3 Sekunden alt sein
      await sleep(3200);
      await page.click(form + ' .oys-contact-send');
      await page.waitForSelector(form + '.is-sent');
      ok((await page.textContent(form + ' .oys-contact-status')) === 'Thanks! Your message has been sent.', 'sent');
      ok(count(`SELECT COUNT(*) FROM messages WHERE page_id = ${p.id}`) === 1, 'message stored');
      await ctx.close();
    });

    await step('10 gallery: large view as a dialog, Escape, focus back on the picture', async () => {
      const p = PAGES[0];
      const { ctx, page } = await newPage();
      await page.goto(pageUrl(p));
      await page.waitForFunction(() => !!window.OYSUI);
      const img = page.locator(`.oys-gallery img`).first();
      await img.scrollIntoViewIfNeeded();
      const y = await page.evaluate(() => window.scrollY);
      await img.click();
      await page.waitForSelector('.oys-lightbox[role=dialog]');
      ok(await page.getAttribute('.oys-lightbox', 'aria-modal') === 'true' && await page.locator('.oys-lightbox .oys-lightbox-close').count() === 1, 'dialog with a close button');
      ok(await page.evaluate(() => document.activeElement.classList.contains('oys-lightbox-close')), 'focus on Close');
      await page.keyboard.press('Escape');
      await sleep(150);
      ok(await page.locator('.oys-lightbox').count() === 0, 'Escape closes it');
      ok(await page.evaluate(() => document.activeElement.tagName === 'IMG' && !!document.activeElement.closest('.oys-gallery')), 'focus back on the picture');
      ok(await page.evaluate(() => window.scrollY) === y, 'scroll position kept');
      await img.click();
      await page.click('.oys-lightbox-close');
      await sleep(150);
      ok(await page.locator('.oys-lightbox').count() === 0, 'Close closes it');
      await ctx.close();
    });

    await step('10 booking page and password page: messages under the fields, nothing sent', async () => {
      const p = PAGES[0];
      const { ctx, page, posts } = await newPage();
      await page.goto(pageUrl(p, '/kalender'));
      await page.waitForFunction(() => !!window.OYSUI);
      await page.click('form.oys-contact button[type=submit]');
      await sleep(200);
      ok(await fieldError(page, '[name=guest_name]') === 'Please enter your name.', 'name');
      ok(await fieldError(page, '[name=guest_email]') === 'Please enter a valid email address.', 'email');
      ok(await fieldError(page, '[name=booking_date]') === 'Please choose a date between today and one year from now.', 'date');
      ok(await fieldError(page, '[name=booking_time]') === 'Please choose a time.', 'time');
      ok(posts.length === 0, 'nothing sent');
      await page.fill('[name=guest_email]', 'x@');
      await page.click('form.oys-contact button[type=submit]');
      await sleep(200);
      ok(await fieldError(page, '[name=guest_email]') === 'Please enter a valid email address.', 'invalid email');
      ok(await page.evaluate(() => document.body.classList.contains('oys') && OYSUI.skin === 'page'), 'page skin');

      const gate = await page.goto(pageUrl(p, '/_/go/' + block(p, 20)));
      ok(gate.status() === 200 && !gate.headers()['set-cookie'], 'password page without a cookie');
      await page.waitForFunction(() => !!window.OYSUI);
      await page.click('form.oys-contact button[type=submit]');
      await sleep(200);
      ok(await fieldError(page, '[name=pw]') === 'Please enter the password.', 'password page: message under the field');
      ok(posts.length === 0, 'nothing sent');
      await ctx.close();
    });

    await step('7 profile page without ui.js: everything as before', async () => {
      const p = PAGES[1];
      const { ctx, page, posts } = await newPage({ blockUi: true });
      await page.goto(pageUrl(p));
      await page.waitForLoadState('load');
      ok(await page.evaluate(() => typeof window.OYSUI) === 'undefined', 'ui.js blocked');
      await page.click(`a[data-b="${block(p, 20)}"]`);
      await page.waitForSelector('#oys-modal:not([hidden])');
      ok(await page.evaluate(() => document.activeElement.name) === 'pw', 'the dialog opens as before');
      await page.keyboard.press('Escape');
      await sleep(150);
      ok(await page.isHidden('#oys-modal'), 'Escape closes it (own handler)');
      const form = `#contact-${block(p, 30)}`;
      await page.click(form + ' .oys-contact-send');
      await sleep(200);
      ok(await page.textContent(form + ' .oys-contact-status') === 'Please fill in all fields correctly.' && !posts.includes('/_/contact'), 'contact form: the generic line as before');
      await page.click('.oys-gallery img');
      await page.waitForSelector('.oys-lightbox');
      await page.click('.oys-lightbox');
      ok(await page.locator('.oys-lightbox').count() === 0, 'lightbox closes with a click as before');
      await ctx.close();
    });

    await step('11 phone 390×844: the dialog fits, the field is 16 px', async () => {
      const p = PAGES[2];
      const { ctx, page } = await newPage({ viewport: { width: 390, height: 844 } });
      await page.goto(pageUrl(p));
      await page.waitForFunction(() => !!window.OYSUI);
      await page.click(`a[data-b="${block(p, 20)}"]`);
      await page.waitForSelector('#oys-modal:not([hidden])');
      const box = await page.locator('.oys-modal-box').boundingBox();
      ok(box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844, 'fits');
      ok(await page.locator('.oys-unlock input').evaluate((n) => getComputedStyle(n).fontSize) === '16px', '16 px input');
      ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll');
      await ctx.close();
    });
  } finally {
    await browser.close();
    site.stop();
    cleanup();
  }
  summary('profile-dialogs');
})().catch((err) => {
  console.error(err);
  try { site.stop(); } catch (e) { /* egal */ }
  process.exitCode = 1;
});
