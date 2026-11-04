// Ende-zu-Ende: Blöcke im Editor verschieben (D1) – am Schreibtisch mit der Maus, auch nachdem der Bereich „Content“
// neu gezeichnet wurde (Profilbild entfernt), und am Handy mit dem Finger am Griff. Die neue Reihenfolge wird
// gespeichert. SortableJS kommt von der eigenen Seite (kein CDN).
// Jeder native Dialog (alert/confirm/prompt) lässt den Lauf scheitern.
//   node tests/e2e/block-reorder.js
// Startet die Seite selbst (Port OYS_E2E_PORT, Vorgabe 14207) und legt ein eigenes Testkonto an (id 9404 mit Seite 9414
// und vier Blöcken), das am Ende wieder verschwindet. Nur gegen eine Test-Datenbank (Name beginnt mit oys_test, sonst
// Abbruch mit Code 2 vor jedem SQL). Umgebung: OYS_CONFIG, OYS_E2E_PASSWORD, OYS_E2E_ONLY, OYS_E2E_SHOTS.
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
const U = 9404, P = 9414;
const BLOCKS = ['One', 'Two', 'Three', 'Four'];

function cleanup() {
  sql(`DELETE FROM page_blocks WHERE page_id IN (SELECT id FROM pages WHERE user_id = ${U});
    DELETE FROM pages WHERE user_id = ${U};
    DELETE FROM notifications WHERE user_id = ${U};
    DELETE FROM honeycomb_ledger WHERE user_id = ${U};
    DELETE FROM hc_accounts WHERE user_id = ${U};
    DELETE FROM users WHERE id = ${U};`);
}
// Vier Link-Blöcke in fester Reihenfolge, das Profilbild gesetzt (sein „Remove“ zeichnet den Bereich neu)
function fixtures() {
  cleanup();
  sql(`INSERT INTO users (id, email, password, full_name, username, created_at)
      SELECT ${U}, 'reorder@test.de', password, 'Reorder Bee', 'reorderbee', '2026-01-01 10:00:00' FROM users WHERE id = 5;
    INSERT INTO pages (id, user_id, slug, position, title, subtitle, bio, avatar, theme, layout, address_mode, settings, created_at, updated_at)
      SELECT ${P}, ${U}, 'reorderbee', 0, 'Reorder Bee', '', '', 'avatar_${U}.png', theme, layout, 'subdomain', settings, NOW(), NOW() FROM pages WHERE id = 2;
    INSERT IGNORE INTO honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES
      (${U}, 0, 'daily', DATE_FORMAT(CURDATE() - INTERVAL 1 DAY, '%Y-%m-%d'), '', NOW()), (${U}, 0, 'daily', DATE_FORMAT(CURDATE(), '%Y-%m-%d'), '', NOW()),
      (${U}, 0, 'daily', DATE_FORMAT(CURDATE() + INTERVAL 1 DAY, '%Y-%m-%d'), '', NOW());
    INSERT INTO page_blocks (page_id, type, position, is_visible, data, created_at) VALUES ` +
    BLOCKS.map((t, i) => `(${P}, 'link', ${i}, 1, '{"title":"${t}","url":"https://example.com/${i}"}', NOW())`).join(', ') + ';');
}
const savedOrder = () => sql(`SELECT JSON_UNQUOTE(JSON_EXTRACT(data, '$.title')) FROM page_blocks WHERE page_id = ${P} ORDER BY position, id`).split('\n');

let browser;
const IGNORED_CONSOLE = /tailwindcss|favicon|ERR_FAILED|net::|preload|404/;
const shot = async (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, name + '.png') });

async function openEditor(ctx) {
  const page = await ctx.newPage();
  watchPage(page);
  page.on('console', (m) => { if (m.type() === 'error' && !IGNORED_CONSOLE.test(m.text())) ok(false, 'console error: ' + m.text()); });
  const external = [];
  page.on('request', (r) => { if (/sortable/i.test(r.url()) && !r.url().startsWith(B)) external.push(r.url()); });
  await page.goto(B + '/login');
  await page.fill('input[name=email]', 'reorder@test.de');
  await page.fill('input[name=password]', PASSWORD);
  await Promise.all([page.waitForNavigation(), page.click('form[action="/login"] button[type=submit]')]);
  await page.goto(B + '/dashboard?page=' + P + '&load=1#content');
  await page.waitForSelector('#blockList .blk');
  ok(external.length === 0, 'SortableJS comes from the site itself (' + external.join(', ') + ')');
  return page;
}
const order = (page) => page.evaluate(() => [...document.querySelectorAll('#blockList .blk')].map((el) => el.dataset.id));
const live = (page) => page.evaluate(() => !!(window.Sortable && window.Sortable.get(document.getElementById('blockList'))));

// Der erste Block an das Ende der Liste (Maus)
async function mouseDragFirstToEnd(page) {
  await page.evaluate(() => document.getElementById('blockList').scrollIntoView({ block: 'center' }));
  const h = await page.locator('#blockList .blk-drag').first().boundingBox();
  const l = await page.locator('#blockList .blk').last().boundingBox();
  const x = h.x + h.width / 2, y0 = h.y + h.height / 2, y1 = l.y + l.height - 4;
  await page.mouse.move(x, y0);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) { await page.mouse.move(x, y0 + (y1 - y0) * i / 20); await page.waitForTimeout(20); }
  await page.mouse.up();
  await page.waitForTimeout(400);
}
// Dasselbe mit dem Finger (echte Touch-Ereignisse)
async function touchDragFirstToEnd(page, ctx) {
  await page.evaluate(() => document.getElementById('blockList').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  const h = await page.locator('#blockList .blk-drag').first().boundingBox();
  const l = await page.locator('#blockList .blk').last().boundingBox();
  const x = h.x + h.width / 2, y0 = h.y + h.height / 2, y1 = l.y + l.height - 4;
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
  await page.waitForTimeout(150);
  for (let i = 1; i <= 20; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + (y1 - y0) * i / 20 }] });
    await page.waitForTimeout(25);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(400);
}
async function saveAndCheck(page, want, label) {
  await page.click('#saveBtn');
  await page.waitForFunction(() => !document.getElementById('saveBtn').classList.contains('ring-2'), null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(500);
  const got = savedOrder();
  ok(JSON.stringify(got) === JSON.stringify(want), label + ' is saved (' + got.join(', ') + ')');
}

(async () => {
  fixtures();
  await site.start();
  browser = await chromium.launch({ args: site.browserArgs });
  try {
    await step('desktop: drag a block by its handle, also after the Content area was drawn again', async () => {
      const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      const page = await openEditor(ctx);
      const ids = await order(page);
      await mouseDragFirstToEnd(page);
      const after = await order(page);
      ok(JSON.stringify(after) === JSON.stringify([...ids.slice(1), ids[0]]), 'the first block moved to the end (' + after.join(', ') + ')');
      await saveAndCheck(page, ['Two', 'Three', 'Four', 'One'], 'the new order');
      // „Remove“ am Profilbild zeichnet den Bereich neu – das Verschieben muss weiter gehen
      await page.click('#avatarDel');
      ok(await live(page), 'the new list can still be dragged');
      const ids2 = await order(page);
      await mouseDragFirstToEnd(page);
      const after2 = await order(page);
      ok(JSON.stringify(after2) === JSON.stringify([...ids2.slice(1), ids2[0]]), 'after drawing it again, dragging still works (' + after2.join(', ') + ')');
      await saveAndCheck(page, ['Three', 'Four', 'One', 'Two'], 'the second order');
      await shot(page, 'block-reorder-desktop');
      await ctx.close();
    });

    await step('phone: drag a block with a finger on the handle', async () => {
      fixtures();
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const page = await openEditor(ctx);
      const ta = await page.evaluate(() => getComputedStyle(document.querySelector('#blockList .blk-drag')).touchAction);
      ok(ta === 'none', 'the handle takes the touch, not the page scroll (touch-action: ' + ta + ')');
      const ids = await order(page);
      await touchDragFirstToEnd(page, ctx);
      const after = await order(page);
      ok(JSON.stringify(after) === JSON.stringify([...ids.slice(1), ids[0]]), 'the first block moved to the end (' + after.join(', ') + ')');
      await saveAndCheck(page, ['Two', 'Three', 'Four', 'One'], 'the new order');
      // Auch hier nach dem Neuzeichnen
      await page.evaluate(() => document.getElementById('avatarDel').scrollIntoView({ block: 'center' }));
      await page.tap('#avatarDel');
      const ids2 = await order(page);
      await touchDragFirstToEnd(page, ctx);
      const after2 = await order(page);
      ok(JSON.stringify(after2) === JSON.stringify([...ids2.slice(1), ids2[0]]), 'after drawing it again, dragging still works (' + after2.join(', ') + ')');
      await shot(page, 'block-reorder-phone');
      await ctx.close();
    });
  } finally {
    await browser.close();
    site.stop();
    cleanup();
    summary('block-reorder');
  }
})().catch((err) => {
  console.error(err);
  site.stop();
  process.exit(1);
});
