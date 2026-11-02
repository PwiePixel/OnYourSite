// Ende-zu-Ende: die Glocke im Editor und im Kopf des Admin-Bereichs (custom-dialogs CD-5b, Ablauf 5 und der Glocken-Teil
// von 6): neue Einträge erscheinen als Hinweise, sobald der Tab wieder sichtbar ist (höchstens 3, dann „+N more“), ein
// zweiter Tab zeigt sie nicht noch einmal, ein Klick öffnet das Ziel und markiert den Eintrag gelesen, „Mark all as read“
// betrifft nur Gesehenes, im Nutzer-Modus eines Admins wird nichts geschrieben, ein Konto ohne Seite kommt in den
// Eingang, im Admin öffnet ein Team-Eintrag seinen Bereich. Texte bleiben Text, fremde Ziele und Symbole wirken nicht.
//   node tests/e2e/bell.js
// Startet die Seite selbst (Port OYS_E2E_PORT, Vorgabe 14206), legt eigene Testkonten an (ids 9301 mit Seite, 9302 ohne
// Seite) und räumt sie und die eigenen Einträge des Admins (id 3) am Ende weg. Umgebung: OYS_CONFIG, OYS_E2E_PASSWORD,
// OYS_E2E_ONLY="teil". Nur gegen eine Test-Datenbank (oys_test…, sonst Abbruch mit Code 2 vor jedem SQL). Jeder native
// Dialog lässt den Lauf scheitern.
'use strict';
const { chromium } = require('playwright');
const { ok, watchPage, step, summary, sleep } = require('./lib');
const { testSite } = require('./site');

const site = testSite(14206);
const { sql, count } = site;
const B = site.base;
// Passwort der Testkonten (seed.php) – zur Laufzeit zusammengesetzt
const PASSWORD = process.env.OYS_E2E_PASSWORD || ['test', '1234'].join('');
const U1 = 9301, U2 = 9302, P1 = 9311, ADMIN = 3;
const USERS = `${U1}, ${U2}`;
// Einträge des Admins aus diesem Lauf (der Admin behält seine anderen)
const ADMIN_TAG = 'E2E bell: ';

function cleanup() {
  sql(`DELETE FROM page_blocks WHERE page_id IN (SELECT id FROM pages WHERE user_id IN (${USERS}));
    DELETE FROM stats_daily WHERE page_id IN (SELECT id FROM pages WHERE user_id IN (${USERS}));
    DELETE FROM block_clicks_daily WHERE page_id IN (SELECT id FROM pages WHERE user_id IN (${USERS}));
    DELETE FROM messages WHERE user_id IN (${USERS});
    DELETE FROM pages WHERE user_id IN (${USERS});
    DELETE FROM notifications WHERE user_id IN (${USERS}) OR (user_id = ${ADMIN} AND title LIKE '${ADMIN_TAG}%');
    DELETE FROM honeycomb_ledger WHERE user_id IN (${USERS});
    DELETE FROM users WHERE id IN (${USERS});`);
}
// Tagesbelohnung schon vergeben (gestern, heute, morgen – unabhängig von der Zeitzone): kein Hinweis beim Öffnen
const DAILY = (u) => `INSERT IGNORE INTO honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES
  (${u}, 5, 'daily', DATE_FORMAT(CURDATE() - INTERVAL 1 DAY, '%Y-%m-%d'), '', NOW()), (${u}, 5, 'daily', DATE_FORMAT(CURDATE(), '%Y-%m-%d'), '', NOW()),
  (${u}, 5, 'daily', DATE_FORMAT(CURDATE() + INTERVAL 1 DAY, '%Y-%m-%d'), '', NOW());`;
function fixtures() {
  cleanup();
  sql(`INSERT INTO users (id, email, password, full_name, username, created_at) SELECT ${U1}, 'bell-one@test.de', password, 'Bella One', 'bellaone', NOW() FROM users WHERE id = 5;
    INSERT INTO users (id, email, password, full_name, username, created_at) SELECT ${U2}, 'bell-two@test.de', password, 'Bella Two', NULL, NOW() FROM users WHERE id = 5;
    INSERT INTO pages (id, user_id, slug, position, title, subtitle, bio, theme, layout, address_mode, settings, created_at, updated_at)
      VALUES (${P1}, ${U1}, 'bellaone', 0, 'Bella One', '', '', 'deep-dark', 'buttons', 'subdomain', NULL, NOW(), NOW());
    INSERT INTO page_blocks (page_id, type, position, is_visible, data, created_at) VALUES (${P1}, 'heading', 0, 1, '{"text":"Bella","size":"m","align":"center"}', NOW());
    ${DAILY(U1)} ${DAILY(U2)}`);
}
const q = (s) => (s === null ? 'NULL' : "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'");
// Eintrag direkt in die Tabelle (im Betrieb schreibt nur notify(); diese Prüfregel gilt für app/src)
function notice(user, type, title, body, link, read = 0) {
  return Number(sql(`INSERT INTO notifications (user_id, type, title, body, link, is_read, created_at) VALUES (${user}, ${q(type)}, ${q(title)}, ${q(body)}, ${q(link)}, ${read}, NOW()); SELECT LAST_INSERT_ID();`));
}
const isRead = (id) => count(`SELECT is_read FROM notifications WHERE id = ${id}`) === 1;

let browser;
async function newPage(ctx, viewport) {
  const context = ctx || await browser.newContext({ viewport: viewport || { width: 1400, height: 900 } });
  const page = await context.newPage();
  const t = watchPage(page, {});
  page.on('console', (m) => { if (m.type() === 'error' && !/tailwindcss|favicon|net::|ERR_FAILED|preload/.test(m.text())) ok(false, 'console error: ' + m.text()); });
  return { ctx: context, page, t };
}
async function login(page, email) {
  await page.goto(B + '/login');
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', PASSWORD);
  await Promise.all([page.waitForNavigation(), page.click('form[action="/login"] button[type=submit]')]);
}
// Abfrage der Glocke (GET) – nicht „gelesen“ (POST notifications-read)
const isPoll = (r) => new URL(r.url()).pathname === '/dashboard/api/notifications' && r.request().method() === 'GET';
const nextPoll = (page) => page.waitForResponse(isPoll);
// Der Tab wird wieder sichtbar – „später“ (die Glocke fragt nur nach, wenn die letzte Abfrage über 15 s her ist)
async function comeBack(page) {
  const answered = nextPoll(page);
  await page.evaluate(() => {
    const now = Date.now;
    Date.now = () => now() + 20000;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await answered;
  await sleep(250);
}
const toasts = (page) => page.locator('.ui-toast');
const badge = (page) => page.locator('#bellBadge');
// Liegt die Mitte des Elements oben (nicht von der Seite verdeckt)? Sonst: was dort liegt (für die Meldung)
async function onTop(page, loc) {
  const box = await loc.boundingBox();
  const hit = await page.evaluate(([x, y]) => {
    const n = document.elementFromPoint(x, y);
    if (n && n.closest('#bellMenu')) return '';
    return n ? n.tagName + '#' + n.id + '.' + String(n.className).slice(0, 80) : 'nothing';
  }, [box.x + box.width / 2, box.y + box.height / 2]);
  if (hit) console.log('  covered by ' + hit);
  return hit === '';
}

(async () => {
  fixtures();
  await site.start();
  browser = await chromium.launch({ args: site.browserArgs });
  try {
    await step('5 a notice after the tab comes back: toast and badge; a click opens the inbox and marks it read', async () => {
      notice(U1, 'system', 'Old news', '', '', 1);
      const { ctx, page } = await newPage();
      const polled = nextPoll(page);
      await login(page, 'bell-one@test.de');
      await polled;
      await sleep(300);
      ok(await badge(page).isHidden() && await toasts(page).count() === 0, 'first visit: only a baseline');
      ok(await page.evaluate((u) => localStorage.getItem('oys.notify.' + u) !== null, U1), 'the baseline is stored per account');
      ok(await page.getAttribute('[data-bell]', 'data-user') === String(U1) && await page.getAttribute('#bellBtn', 'aria-expanded') === 'false', 'bell markup: account and aria-expanded');
      const id = notice(U1, 'message', 'New message from <b>Eve</b>', 'Hello & welcome', '/dashboard#messages');
      await comeBack(page);
      const t = toasts(page).filter({ hasText: 'New message from <b>Eve</b>' });
      ok(await t.count() === 1 && await toasts(page).count() === 1, 'one toast with the title as text');
      ok(await t.locator('b b').count() === 0 && (await t.textContent()).includes('Hello & welcome'), 'no markup from the title; the body as second line');
      ok(await t.locator('i.bx-envelope').count() === 1, 'the type’s icon');
      ok(await badge(page).textContent() === '1' && await badge(page).isVisible(), 'badge 1');
      ok(await page.locator('#bellBtn i.bell-ring').count() === 1, 'the bell rings');
      await t.locator('.ui-toast-text').click();
      await page.waitForSelector('#tab-messages:not(.hidden) .section-title');
      ok(new URL(page.url()).hash === '#messages', 'the inbox is open');
      await sleep(300);
      ok(isRead(id), 'the notice is marked read');
      ok(await badge(page).isHidden(), 'badge gone');
      // Eine neue Nachricht lädt den offenen Eingang neu
      sql(`INSERT INTO messages (id, page_id, user_id, name, email, message, is_read, created_at) VALUES (93101, ${P1}, ${U1}, 'Frank <i>F</i>', 'frank@example.org', 'Fresh message', 0, NOW())`);
      notice(U1, 'message', 'New message from Frank', 'Fresh message', '/dashboard#messages');
      await comeBack(page);
      await page.waitForSelector('#tab-messages [data-msg="93101"]', { timeout: 5000 });
      ok((await page.textContent('#tab-messages [data-msg="93101"] b')) === 'Frank <i>F</i>', 'the open inbox shows the new message (as text)');
      await ctx.close();
    });

    await step('5 five at once: three toasts and “+2 more notifications”; a second tab shows none again', async () => {
      const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      const { page } = await newPage(ctx);
      const polled = nextPoll(page);
      await login(page, 'bell-one@test.de');
      await polled;
      sql(`UPDATE notifications SET is_read = 1 WHERE user_id = ${U1}`);
      const ids = [];
      for (let i = 1; i <= 5; i++) ids.push(notice(U1, 'honeycombs', 'Gift number ' + i, 'From the team', '/dashboard#honeycombs'));
      await comeBack(page);
      const titles = await toasts(page).locator('b').allTextContents();
      ok(titles.join('|') === 'Gift number 5|Gift number 4|Gift number 3', 'the three newest: ' + titles.join('|'));
      const more = toasts(page).filter({ hasText: '+2 more notifications' });
      ok(await more.count() === 1 && await toasts(page).count() === 4, '“+2 more notifications”');
      ok(await toasts(page).filter({ hasText: 'Gift number 5' }).evaluate((n) => n.classList.contains('hc')), 'honeycomb notices are yellow');
      ok(await badge(page).textContent() === '5', 'badge 5');
      await more.locator('.ui-toast-act').click();
      await page.waitForSelector('#bellMenu:not(.hidden) [data-bell-item]');
      ok(await page.locator('#bellMenu [data-bell-item]').count() >= 5, '“Show” opens the bell');
      ok(await page.getAttribute('#bellBtn', 'aria-expanded') === 'true', 'aria-expanded');
      await sleep(400);
      ok(await toasts(page).count() === 0, 'the open list replaces the bell’s toasts');
      ok(await onTop(page, page.locator(`#bellMenu [data-bell-item="${ids[4]}"]`)), 'the list is on top of the editor');
      // Ein Eintrag aus der Liste: das Honigwaben-Ziel öffnet den Bereich „Honeycombs“, nur dieser Eintrag wird gelesen
      await page.click(`#bellMenu [data-bell-item="${ids[0]}"]`);
      await page.waitForSelector('#tab-honeycombs:not(.hidden) .shop-wallet');
      await sleep(300);
      ok(isRead(ids[0]) && !isRead(ids[1]), 'only the clicked item is read');
      ok(await page.isHidden('#bellMenu') && await page.getAttribute('#bellBtn', 'aria-expanded') === 'false', 'the list closed');
      // Zweiter Tab desselben Browsers: der zuletzt gezeigte Eintrag ist gespeichert – keine Hinweise noch einmal
      const second = await newPage(ctx);
      const p2 = nextPoll(second.page);
      await second.page.goto(B + '/dashboard');
      await p2;
      await sleep(400);
      ok(await toasts(second.page).count() === 0, 'second tab: no toast again');
      ok(await badge(second.page).textContent() === '4', 'but the badge counts them');
      // Escape schließt die Liste und gibt den Fokus an die Glocke zurück
      await second.page.click('#bellBtn');
      await second.page.waitForSelector('#bellMenu:not(.hidden) [data-bell-item]');
      await second.page.focus(`#bellMenu [data-bell-item="${ids[1]}"]`);
      await second.page.keyboard.press('Escape');
      ok(await second.page.isHidden('#bellMenu') && await second.page.evaluate(() => document.activeElement && document.activeElement.id) === 'bellBtn', 'Escape closes the list, focus on the bell');
      ok(!isRead(ids[1]), 'Escape reads nothing');
      await ctx.close();
    });

    await step('5 “Mark all as read” only marks what the list showed; stored texts and links stay harmless', async () => {
      sql(`UPDATE notifications SET is_read = 0 WHERE user_id = ${U1}`);
      const evil = notice(U1, 'message', '<img src=x onerror="window.__bellXss=1">Spam', '<script>window.__bellXss=2</script>', '//evil.example/x');
      const { ctx, page } = await newPage();
      const polled = nextPoll(page);
      await login(page, 'bell-one@test.de');
      await polled;
      const opened = nextPoll(page);
      await page.click('#bellBtn');
      await opened;
      await page.waitForSelector('#bellMenu [data-bell-read]');
      const item = page.locator(`#bellMenu [data-bell-item="${evil}"]`);
      ok((await item.textContent()).includes('<img src=x onerror="window.__bellXss=1">Spam'), 'the title as text');
      ok(await page.locator('#bellMenu img, #bellMenu script').count() === 0 && await page.evaluate(() => window.__bellXss) === undefined, 'no markup, no script');
      const late = notice(U1, 'message', 'Arrived later', '', '/dashboard#messages');
      const marked = page.waitForResponse((r) => r.url().endsWith('/dashboard/api/notifications-read'));
      await page.click('#bellMenu [data-bell-read]');
      const req = (await marked).request();
      ok(/^\{"upTo":\d+\}$/.test(req.postData() || ''), 'sends upTo: ' + req.postData());
      ok(req.headers()['x-csrf-token'] === await page.getAttribute('[data-bell]', 'data-csrf'), 'with the CSRF token');
      await sleep(400);
      ok(count(`SELECT COUNT(*) FROM notifications WHERE user_id = ${U1} AND is_read = 0`) === 1 && !isRead(late), 'the new item stays unread');
      ok(await toasts(page).count() === 0, 'no toast over the open list');
      // Gespeichertes fremdes Ziel: der Server gibt das Ziel des Typs, der Klick bleibt auf der Seite
      await item.click();
      await page.waitForSelector('#tab-messages:not(.hidden) .section-title');
      ok(new URL(page.url()).origin === B && new URL(page.url()).hash === '#messages', 'a foreign target becomes the inbox');
      await ctx.close();
    });

    await step('5 answers are text: markup, icons, colours and links from an answer do nothing', async () => {
      const { ctx, page } = await newPage();
      let crafted = null;
      await page.route('**/dashboard/api/notifications', (route) => (crafted && route.request().method() === 'GET'
        ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(crafted) })
        : route.continue()));
      const polled = nextPoll(page);
      await login(page, 'bell-one@test.de');
      await polled;
      const reads = [];
      page.on('request', (r) => { if (r.url().endsWith('/notifications-read')) reads.push(r.postData()); });
      crafted = { ok: true, unread: 3, messages_unread: 0, latest: 999999, items: [
        { id: 999999, type: 'message', title: '<img src=x onerror="window.__bell=1">Hi', body: '<script>window.__bell=2</script>', read: false, ago: '<b>now</b>', link: 'javascript:window.__bell=3', icon: 'bx-x" onmouseover="window.__bell=4', tone: 'evil" style="color:red' },
        { id: 999998, type: 'system', title: 'Elsewhere', body: '', read: false, ago: '1 min', link: '//evil.example/steal', icon: 'bx-bell', tone: 'info' },
        { id: 999997, type: 'system', title: 'Backslash', body: '', read: false, ago: '1 min', link: '/\\evil.example', icon: 'bxs-bell', tone: 'warn' },
      ] };
      await comeBack(page);
      const first = toasts(page).filter({ hasText: 'Hi' });
      ok(await toasts(page).count() === 3, 'three toasts');
      ok((await first.textContent()).includes('<img src=x onerror="window.__bell=1">Hi') && await page.locator('.ui-toast img').count() === 0, 'toast title as text');
      ok(await first.locator('i').first().getAttribute('class') === 'bx bx-bell' && await first.evaluate((n) => n.classList.contains('info') && !/["=:]/.test(n.className)), 'unknown icon and colour fall back');
      const before = page.url();
      await first.locator('.ui-toast-act').click();
      await sleep(400);
      ok(page.url() === before && await page.evaluate(() => window.__bell) === undefined, 'a javascript: target is ignored');
      ok(reads.length === 1 && reads[0] === '{"id":999999}', 'the item is still marked read (own rows only on the server): ' + reads.join(' '));
      await page.click('#bellBtn');
      await page.waitForSelector('#bellMenu [data-bell-item="999998"]');
      ok(await page.locator('#bellMenu img, #bellMenu script').count() === 0 && (await page.textContent('#bellMenu')).includes('<b>now</b>'), 'list: everything as text');
      ok(await page.locator('#bellMenu [data-bell-item="999999"] .ni.tone-info i.bx-bell').count() === 1, 'list: fallback icon and colour');
      ok(await page.locator('#bellMenu [data-bell-item="999997"] .ni.tone-warn i.bxs-bell').count() === 1, 'list: valid icon and colour stay');
      const markup = await page.innerHTML('#bellMenu');
      ok(!markup.includes('onmouseover') && !markup.includes('style="color'), 'no attribute from the answer');
      await page.click('#bellMenu [data-bell-item="999998"]');
      await sleep(300);
      ok(page.url() === before, '//host target ignored');
      await page.click('#bellBtn');
      await page.click('#bellMenu [data-bell-item="999997"]');
      await sleep(300);
      ok(page.url() === before && await page.evaluate(() => window.__bell) === undefined, '/\\host target ignored');
      await ctx.close();
    });

    await step('5 an admin working as the user: the bell only reads', async () => {
      const id = notice(U1, 'message', 'Unread while admin looks', '', '/dashboard#messages');
      const { ctx, page } = await newPage();
      await login(page, 'admin@test.de');
      await page.goto(B + '/admin');
      await page.locator('#userTable tbody tr', { hasText: 'bell-one@test.de' }).locator('button[title="Login as this User"]').click();
      await page.waitForSelector('.ui-dialog');
      await Promise.all([page.waitForURL(/\/dashboard/), page.click('.ui-dialog .ui-btn.is-primary')]);
      await page.waitForSelector('[data-bell][data-readonly]');
      const writes = [];
      page.on('request', (r) => { if (r.url().endsWith('/notifications-read')) writes.push(r.postData()); });
      await page.click('#bellBtn');
      await page.waitForSelector(`#bellMenu [data-bell-item="${id}"]`);
      ok(await page.locator('#bellMenu [data-bell-read]').count() === 0, 'no “Mark all as read”');
      await page.click(`#bellMenu [data-bell-item="${id}"]`);
      await page.waitForSelector('#tab-messages:not(.hidden) .section-title');
      await sleep(400);
      ok(!isRead(id) && writes.length === 0, 'the target opens, nothing is written for the user');
      await Promise.all([page.waitForURL(/\/admin/), page.click('text=Back to admin panel')]);
      await ctx.close();
    });

    await step('5 an account without a page: the bell polls and a message notice opens the inbox', async () => {
      const id = notice(U2, 'message', 'Message for a code page owner', 'Hi', '/dashboard#messages');
      const { ctx, page } = await newPage();
      // Kein gespeicherter Stand: der erste Abruf ist nur die Grundlinie, die Glocke zählt aber mit
      const polled = nextPoll(page);
      await login(page, 'bell-two@test.de');
      await polled;
      await sleep(300);
      ok(await page.locator('#noPageBox').isVisible() && await badge(page).textContent() === '1', 'no page, badge 1');
      await page.click('#bellBtn');
      await page.click(`#bellMenu [data-bell-item="${id}"]`);
      await page.waitForSelector('#tab-messages:not(.hidden) .section-title');
      ok((await page.textContent('#tab-messages .section-title')).startsWith('Messages') && await page.locator('#addContact').count() === 0, 'the inbox opens without a page and offers no contact form');
      await sleep(300);
      ok(isRead(id), 'read');
      // Auch ohne Seite kommen neue Einträge als Hinweis
      notice(U2, 'booking', 'New booking request', 'Tomorrow at 10:00', '/dashboard#messages');
      await comeBack(page);
      ok(await toasts(page).filter({ hasText: 'New booking request' }).locator('i.bx-calendar-check').count() === 1, 'toast without a page');
      await ctx.close();
    });

    await step('6 admin header bell: a team notice opens its section', async () => {
      const { ctx, page } = await newPage();
      await login(page, 'admin@test.de');
      const polled = nextPoll(page);
      await page.goto(B + '/admin#users');
      await polled;
      ok(await page.getAttribute('[data-bell]', 'data-user') === String(ADMIN) && (await page.getAttribute('[data-bell]', 'data-readonly')) === null, 'the admin’s own bell');
      const id = notice(ADMIN, 'team', ADMIN_TAG + 'Honeycomb check failed', 'Two balances differ from the ledger.', '/admin#honeycombs');
      const again = nextPoll(page);
      await page.click('#bellBtn');
      await again;
      const item = page.locator(`#bellMenu [data-bell-item="${id}"]`);
      await item.waitFor();
      ok(await item.locator('.ni.tone-warn i.bx-shield-quarter').count() === 1, 'team icon and colour');
      ok(await onTop(page, item), 'the list is on top of the admin page');
      ok(await toasts(page).count() === 0, 'no toast over the open list');
      await page.evaluate(() => { window.__stay = 1; });
      await item.click();
      await sleep(300);
      ok(await page.isVisible('#tab-honeycombs') && new URL(page.url()).hash === '#honeycombs', 'the Honeycombs section is open');
      ok(await page.evaluate(() => window.__stay) === 1, 'without reloading the page');
      ok(isRead(id), 'read');
      ok(await page.isHidden('#bellMenu'), 'the list closes');
      // Ein Team-Eintrag ohne Bereich (Ziel /admin) lässt den offenen Bereich stehen
      const plain = notice(ADMIN, 'team', ADMIN_TAG + 'Something needs a look', '', null);
      await comeBack(page);
      const toast = toasts(page).filter({ hasText: 'Something needs a look' });
      ok(await toast.count() === 1, 'a toast in the admin');
      await toast.locator('.ui-toast-act').click();
      await sleep(300);
      ok(await page.isVisible('#tab-honeycombs') && await page.evaluate(() => window.__stay) === 1 && isRead(plain), '/admin keeps the open section, the item is read');
      // Dieselben Team-Einträge stehen in der Glocke des Editors; ein Klick führt in den Admin-Bereich zum Abschnitt
      const fromEditor = notice(ADMIN, 'team', ADMIN_TAG + 'Code page reported', 'A visitor reported a code page.', '/admin#code-pages');
      const polledEditor = nextPoll(page);
      await page.goto(B + '/dashboard');
      await polledEditor;
      await page.click('#bellBtn');
      await page.locator(`#bellMenu [data-bell-item="${fromEditor}"]`).click();
      await page.waitForURL(/\/admin#code-pages$/);
      await page.waitForSelector('#tab-code-pages:not(.hidden)');
      await sleep(300);
      ok(isRead(fromEditor), 'from the editor bell: the admin section opens and the item is read');
      await ctx.close();
    });

    await step('11 phone: the bell list fits the screen in the editor and the admin', async () => {
      const { ctx, page } = await newPage(null, { width: 390, height: 844 });
      await login(page, 'admin@test.de');
      notice(ADMIN, 'team', ADMIN_TAG + 'Phone check', 'A longer body text that should wrap inside the list on a small screen.', '/admin#users');
      for (const url of ['/dashboard', '/admin']) {
        const polled = nextPoll(page);
        await page.goto(B + url);
        await polled;
        // Andere Hinweise (z. B. die Tagesbelohnung beim ersten Öffnen) liegen wie immer oben – erst abwarten
        await page.waitForFunction(() => !document.querySelector('.ui-toast'), null, { timeout: 10000 });
        const wide = () => page.evaluate(() => document.documentElement.scrollWidth);
        const before = await wide();
        await page.click('#bellBtn');
        const first = page.locator('#bellMenu [data-bell-item]').first();
        await first.waitFor();
        const box = await page.locator('#bellMenu').boundingBox();
        ok(box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844, url + ': inside the screen ' + JSON.stringify(box));
        ok(await onTop(page, first), url + ': on top');
        ok(await wide() <= Math.max(before, 390), url + ': no sideways scroll from the list');
      }
      await ctx.close();
    });
  } finally {
    await browser.close();
    site.stop();
    cleanup();
  }
  summary('bell');
})().catch((err) => {
  console.error(err);
  try { site.stop(); } catch (e) { /* egal */ }
  process.exitCode = 1;
});
