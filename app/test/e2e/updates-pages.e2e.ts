// Browser-Test der eigenen Seiten /updates und /roadmap: Unternavigation (auch auf schmalen Telefonen), keine Cookies
// für Besucher, alte Anker (#roadmap, #milestone-N) landen auf /roadmap – auch mit der alten 301 von /roadmap im Cache
// des Browsers, ohne Schleife.
// Start: cd app && oys-db.sh run node --import tsx --test test/e2e/updates-pages.e2e.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { exec } from '../../src/db.js';
import { PORT, SITE, launch, startSite, type Site } from './harness.js';

type Browser = Awaited<ReturnType<typeof launch>>;

let site: Site;
let browser: Browser;

before(async () => {
  site = await startSite();
  browser = await launch();
  await exec('DELETE FROM milestones WHERE id >= 9000');
  await exec("INSERT INTO milestones (id, title, description, status, target, position, is_public, started_at, done_at, created_at, updated_at) VALUES (9000, 'Working on it', '', 'now', '', 1, 1, NOW(), NULL, NOW(), NOW())");
  for (let i = 1; i <= 14; i++) {
    await exec("INSERT INTO milestones (id, title, description, status, target, position, is_public, started_at, done_at, created_at, updated_at) VALUES (?, ?, '', 'done', '', 1, 1, NULL, DATE_SUB(NOW(), INTERVAL ? DAY), NOW(), NOW())",
      [9000 + i, 'Shipped ' + i, i]);
  }
});

after(async () => {
  await exec('DELETE FROM milestones WHERE id >= 9000').catch(() => undefined);
  await browser?.close();
  await site?.stop();
});

test('Changelog → Roadmap → Changelog with aria-current, and no cookie for visitors', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(SITE + '/updates');
  const nav = page.getByRole('navigation', { name: 'Updates sections' });
  assert.equal(await nav.locator('[aria-current=page]').innerText(), 'Changelog');
  await Promise.all([page.waitForURL(SITE + '/roadmap'), nav.getByRole('link', { name: 'Roadmap' }).click()]);
  assert.equal(await page.title(), 'Roadmap | OnYourSite');
  assert.equal(await page.getByRole('navigation', { name: 'Updates sections' }).locator('[aria-current=page]').innerText(), 'Roadmap');
  await Promise.all([page.waitForURL(SITE + '/updates'), page.getByRole('navigation', { name: 'Updates sections' }).getByRole('link', { name: 'Changelog' }).click()]);
  assert.equal(await page.title(), 'Updates | OnYourSite');
  assert.deepEqual(await context.cookies(), [], 'no cookies after both pages');
  await context.close();
});

test('the sub-navigation fits on phones; at 320 px it scrolls inside itself, never the page', async () => {
  for (const width of [320, 360, 375, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 800 } });
    const page = await context.newPage();
    for (const path of ['/updates', '/roadmap']) {
      await page.goto(SITE + path, { waitUntil: 'networkidle' });
      const nav = page.getByRole('navigation', { name: 'Updates sections' });
      const box = (await nav.boundingBox())!;
      assert.ok(box.x >= 0 && box.x + box.width <= width, `${path} at ${width}: nav inside the viewport`);
      const pageScroll = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(pageScroll <= 0, `${path} at ${width}: the page does not scroll sideways`);
      const last = (await nav.locator('a').last().boundingBox())!;
      if (width >= 360) assert.ok(last.x + last.width <= box.x + box.width + 0.5, `${path} at ${width}: the last pill is fully visible`);
      else assert.ok(await nav.evaluate((el) => el.scrollWidth >= el.clientWidth), `${path} at ${width}: the pills scroll inside the nav`);
    }
    await context.close();
  }
});

test('an old link /updates#milestone-N opens the roadmap at that milestone, also inside the folded list', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(SITE + '/updates#milestone-9014');
  await page.waitForURL(SITE + '/roadmap?from=updates#milestone-9014');
  assert.equal(await page.title(), 'Roadmap | OnYourSite');
  assert.equal(await page.locator('#milestone-9014').isVisible(), true, 'the folded part was opened');
  assert.equal(await page.locator('link[rel=canonical]').getAttribute('href'), 'http://' + site.config.base_domain + '/roadmap');
  await page.goto(SITE + '/updates#roadmap');
  await page.waitForURL(SITE + '/roadmap?from=updates#roadmap');
  // Ein normaler Anker auf /updates bleibt, wo er ist
  await page.goto(SITE + '/updates#changelog');
  await page.waitForTimeout(300);
  assert.equal(page.url(), SITE + '/updates#changelog');
  await context.close();
});

test('a browser that cached the old 301 of /roadmap ends on the roadmap without a loop', async () => {
  // Ein Vermittler vor der Seite: zuerst wie die alte Seite (301 /roadmap → /updates#roadmap ohne Cache-Control, alte
  // Seite /updates ohne Weiterleitung), dann reicht er alles an die neue Seite durch
  let mode: 'old' | 'new' = 'old';
  const hits: Record<string, number> = { '/roadmap': 0, '/updates': 0 };
  const proxy = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path in hits) hits[path]++;
    if (mode === 'old' && path === '/roadmap') {
      res.writeHead(301, { Location: '/updates#roadmap', 'Content-Length': 0 });
      res.end();
      return;
    }
    if (mode === 'old' && path === '/updates') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!DOCTYPE html><title>Updates &amp; roadmap | OnYourSite</title><section id="roadmap">Old roadmap</section>');
      return;
    }
    const up = http.request({ host: '127.0.0.1', port: PORT, method: req.method, path: req.url, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', () => resolve()));
  const base = `http://oys.test:${(proxy.address() as AddressInfo).port}`;
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(base + '/roadmap');
    assert.equal(page.url(), base + '/updates#roadmap', 'the old site redirected');
    mode = 'new';
    hits['/roadmap'] = 0;
    hits['/updates'] = 0;
    await page.goto(base + '/imprint');
    await page.goto(base + '/roadmap', { waitUntil: 'commit' }).catch(() => undefined);
    await page.waitForURL(base + '/roadmap?from=updates#roadmap', { timeout: 10000 });
    await page.waitForLoadState('load');
    assert.equal(await page.title(), 'Roadmap | OnYourSite');
    assert.ok(hits['/updates'] <= 2, `/updates was requested ${hits['/updates']} times`);
  } finally {
    await context.close();
    await new Promise<void>((resolve) => {
      proxy.closeAllConnections();
      proxy.close(() => resolve());
    });
  }
});
