'use strict';
// Browser: Admin-Rechte nur in der eigenen Sitzung des Admins (Entscheidung R1). Der Admin arbeitet über „Log in as“
// als ein anderes Admin-Konto (Tom, für den Ablauf kurz Admin); ein zweiter, älterer Tab des Admin-Bereichs kann weder
// zu einem dritten Konto wechseln noch ein Admin-Formular ausführen. „Back to admin panel“ führt zurück.
const { chromium } = require('playwright');
const { ok, watchPage, step, summary } = require('./lib');
const { testSite } = require('./site');
const site = testSite(14206);
const { sql, count } = site;
const B = site.base;
const PASSWORD = process.env.OYS_E2E_PASSWORD || ['test', '1234'].join('');
let browser;
// Formular mit dem CSRF-Token der Seite abschicken (wie ein Klick auf einen Knopf dieses Tabs) und die neue Seite abwarten
async function postForm(page, action, fields) {
  await Promise.all([page.waitForNavigation(), page.evaluate(([action, fields]) => {
    const f = document.createElement('form');
    f.method = 'POST';
    f.action = action;
    for (const [k, v] of Object.entries({ csrf: document.querySelector('input[name=csrf]').value, ...fields })) {
      const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; f.appendChild(i);
    }
    document.body.appendChild(f);
    f.submit();
  }, [action, fields])]);
}
(async () => {
  // Tom (#6) ist für diesen Ablauf Admin – am Ende wieder nicht
  sql('UPDATE users SET is_admin = 1 WHERE id = 6');
  await site.start();
  browser = await chromium.launch({ args: site.browserArgs });
  try {
    await step('R1 in the browser: stale admin tab can neither switch on nor act while working as another admin', async () => {
      const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      const page1 = await ctx.newPage(); watchPage(page1);
      await page1.goto(B + '/login');
      await page1.fill('input[name=email]', 'admin@test.de');
      await page1.fill('input[name=password]', PASSWORD);
      await Promise.all([page1.waitForNavigation(), page1.click('form[action="/login"] button[type=submit]')]);
      await page1.goto(B + '/admin');
      const page2 = await ctx.newPage(); watchPage(page2);
      await page2.goto(B + '/admin');
      ok(page2.url().endsWith('/admin'), 'second admin tab open');
      await postForm(page1, '/admin_impersonate.php', { id: '6', _confirmed: '1' });
      ok(page1.url().includes('/dashboard'), 'working as Tom (admin): editor');
      let html = await page1.content();
      ok(html.includes('action="/admin_return.php"'), 'Back to admin panel shown');
      ok(!html.includes('href="/admin"'), 'no admin link');
      await page1.goto(B + '/admin');
      ok(page1.url().includes('/dashboard'), '/admin answers as for a user');
      const before = count('SELECT COUNT(*) FROM honeycomb_ledger WHERE user_id = 7');
      await postForm(page2, '/admin_impersonate.php', { id: '7', _confirmed: '1' });
      ok(page2.url().includes('/dashboard'), 'stale Log in as lands in the editor');
      html = await page2.content();
      ok(html.includes('tom@test.de') && !html.includes('lea@test.de'), 'still Tom, not switched to Lea');
      await postForm(page2, '/admin', { hc_action: 'grant', user_id: '7', amount: '25', note: 'x', _confirmed: '1' });
      ok(page2.url().includes('/dashboard'), 'stale admin form lands in the editor');
      ok(count('SELECT COUNT(*) FROM honeycomb_ledger WHERE user_id = 7') === before, 'nothing booked');
      await page1.goto(B + '/dashboard');
      await Promise.all([page1.waitForNavigation(), page1.click('form[action="/admin_return.php"] button[type=submit]')]);
      ok(page1.url().endsWith('/admin'), 'back in the admin panel');
      ok((await page1.content()).includes('Welcome back!'), 'welcome back notice');
      await ctx.close();
    });
  } finally {
    await browser.close();
    site.stop();
    sql('UPDATE users SET is_admin = 0 WHERE id = 6');
  }
  summary('admin-own-session');
})().catch((err) => { console.error(err); try { site.stop(); } catch (e) { /* egal */ } sql('UPDATE users SET is_admin = 0 WHERE id = 6'); process.exitCode = 1; });
