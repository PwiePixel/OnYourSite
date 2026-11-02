// Browser-Test der eigenen Statusseite (Chromium): das Admin öffnet /dashboard#status/system (wie der Link im Admin),
// meldet über die eigenen Dialoge einen Vorfall, schreibt ein Update, löst ihn und plant eine Wartung; die öffentliche
// Seite status.oys.test zeigt ihn (Banner role=status) und die Verlaufsseite. Ein Nutzer sieht keinen Bereich „Status“
// (und #status/system bleibt beim Inhalt). Auf dem Telefon (390×844): der Bereich öffnet aus den Einstellungen, die
// öffentliche Seite hat 30 Balken je Bestandteil und scrollt nie quer.
// Start: cd app && OYS_E2E_PORT=14208 NODE_PATH=$(npm root -g) node --import tsx --test test/e2e/status-system.e2e.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { exec, one, value } from '../../src/db.js';
import { PORT, SITE, launch, login, startSite, type Site } from './harness.js';

type Browser = Awaited<ReturnType<typeof launch>>;
type Page = import('playwright').Page;

let site: Site;
let browser: Browser;
let maxIncident = 0;
let userEmail = '';
const STATUS_SITE = `http://status.oys.test:${PORT}`;

before(async () => {
  site = await startSite();
  browser = await launch();
  maxIncident = Number(await value('SELECT COALESCE(MAX(id), 0) FROM status_incidents'));
  // Ein Nutzer ohne Admin-Rechte mit demselben Passwort wie das Admin-Konto des Tests
  userEmail = `status-e2e-${Date.now()}@test.de`;
  await exec(`INSERT INTO users (email, password, full_name, is_admin, created_at)
    SELECT ?, password, 'Status E2E', 0, NOW() FROM users WHERE email = 'admin@test.de'`, [userEmail]);
});

after(async () => {
  await exec('DELETE FROM status_incident_updates WHERE incident_id > ?', [maxIncident]).catch(() => undefined);
  await exec('DELETE FROM status_incident_monitors WHERE incident_id > ?', [maxIncident]).catch(() => undefined);
  await exec('DELETE FROM status_incident_posts WHERE incident_id > ?', [maxIncident]).catch(() => undefined);
  await exec('DELETE FROM status_incidents WHERE id > ?', [maxIncident]).catch(() => undefined);
  await exec('DELETE FROM users WHERE email = ?', [userEmail]).catch(() => undefined);
  await browser?.close();
  await site?.stop();
});

// Voll laden (wie der Link aus dem Admin): nach dem Anmelden steht der Browser schon auf /dashboard – ein Wechsel nur
// des Ankers würde die Seite nicht neu laden
async function open(page: Page, path: string): Promise<void> {
  await page.goto('about:blank');
  await page.goto(SITE + path);
}

async function dialog(page: Page): Promise<import('playwright').Locator> {
  const d = page.locator('.ui-dialog').last();
  await d.waitFor({ state: 'visible' });
  return d;
}

test('admin: report an incident, post an update, resolve it and schedule maintenance from the editor; the public page shows it', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page);
  await open(page, '/dashboard#status/system');
  await page.locator('#tab-status .st-m-headcard').waitFor();
  assert.equal(await page.locator('#mainNav .nav-btn[data-tab="status"]').isVisible(), true);
  assert.match(await page.locator('#tab-status .st-m-title h2').innerText(), /OnYourSite status/);
  assert.equal(await page.locator('body.status-mode').count(), 1, 'no profile preview in the status area');

  // Vorfall melden (eigener Dialog, nie ein Browser-Popup)
  page.on('dialog', () => errors.push('native dialog'));
  await page.click('[data-stm-tab="incidents"]');
  await page.click('[data-stm="report"]');
  let d = await dialog(page);
  await d.locator('[name=title]').fill('E2E <b>payments</b> slow');
  await d.locator('[name=body]').fill('We are looking into it.');
  const firstCheck = d.locator('[data-mon]').first();
  if (await firstCheck.count()) await firstCheck.check({ force: true });
  await d.locator('.ui-btn.is-primary').click();
  await page.locator('.ui-toast', { hasText: 'Incident posted.' }).waitFor();
  const card = page.locator('.st-m-inc', { hasText: 'E2E <b>payments</b> slow' });
  await card.waitFor();
  const id = Number(await card.getAttribute('data-inc'));
  assert.ok(id > maxIncident);

  // Update, dann lösen
  await card.locator('[data-stm="update"]').click();
  d = await dialog(page);
  await d.locator('[name=status]').selectOption('identified');
  await d.locator('[name=body]').fill('Found the cause.');
  await d.locator('.ui-btn.is-primary').click();
  await page.locator('.ui-toast', { hasText: 'Update posted.' }).waitFor();
  assert.equal(String((await one('SELECT status FROM status_incidents WHERE id = ?', [id]))?.status), 'identified');

  // Öffentliche Seite: der Vorfall mit maskiertem Titel, Banner als Status
  const visitor = await browser.newContext();
  const pub = await visitor.newPage();
  const res = await pub.goto(STATUS_SITE + '/');
  assert.equal(res?.status(), 200);
  assert.equal((await visitor.cookies()).length, 0, 'no cookie for visitors');
  await pub.locator('.st-banner[role="status"]').waitFor();
  assert.match(await pub.locator('.st-active').innerText(), /E2E <b>payments<\/b> slow/);
  assert.equal(await pub.locator('.st-active b').count(), 0, 'the title is text, not markup');

  await page.locator('.st-m-inc', { hasText: 'E2E <b>payments</b> slow' }).locator('[data-stm="resolve"]').click();
  d = await dialog(page);
  await d.locator('.ui-btn.is-primary').click();
  await page.locator('.ui-toast', { hasText: 'Update posted.' }).waitFor();
  assert.notEqual((await one('SELECT resolved_at FROM status_incidents WHERE id = ?', [id]))?.resolved_at, null);

  // Wartung planen
  await page.click('[data-stm="maint"]');
  d = await dialog(page);
  await d.locator('[name=title]').fill('E2E database upgrade');
  await d.locator('[name=body]').fill('A few minutes of downtime.');
  await d.locator('.ui-btn.is-primary').click();
  await page.locator('.ui-toast', { hasText: 'Maintenance scheduled.' }).waitFor();
  await page.locator('.st-m-inc', { hasText: 'E2E database upgrade' }).waitFor();

  // Verlauf der öffentlichen Seite
  await pub.goto(STATUS_SITE + '/history');
  assert.match(await pub.locator('main').innerText(), /E2E <b>payments<\/b> slow/);
  await visitor.close();
  assert.deepEqual(errors, []);
  await context.close();
});

test('a user sees no Status area; #status/system stays on the content', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await login(page, userEmail);
  await open(page, '/dashboard#status/system');
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('#tab-status').count(), 0);
  assert.equal(await page.locator('#mainNav .nav-btn[data-tab="status"]').count(), 0);
  assert.equal(await page.locator('#statusSettingsRow').count(), 0);
  const api = await page.evaluate(async () => {
    const r = await fetch('/dashboard/api/status?scope=system', { credentials: 'same-origin' });
    return { status: r.status, body: await r.json() };
  });
  assert.deepEqual(api, { status: 403, body: { ok: false, error: 'Not allowed.' } });
  await context.close();
});

test('phone (390×844): the area opens from Settings; the public page shows 30 bars and never scrolls sideways', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await login(page);
  await open(page, '/dashboard#settings');
  const row = page.locator('#statusSettingsRow [data-open-status]');
  await row.waitFor();
  await row.click();
  await page.locator('#tab-status .st-m-headcard').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'editor: no sideways scroll');

  const pub = await context.newPage();
  await pub.goto(STATUS_SITE + '/');
  await pub.locator('.st-components').waitFor();
  const bars = await pub.evaluate(() => {
    const first = document.querySelector('.st-bars');
    if (!first) return { visible: 0, total: 0 };
    const all = Array.from(first.querySelectorAll('.st-bar'));
    return { visible: all.filter((b) => getComputedStyle(b).display !== 'none').length, total: all.length };
  });
  assert.deepEqual(bars, { visible: 30, total: 90 });
  assert.equal(await pub.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'public page: no sideways scroll');
  await context.close();
});
