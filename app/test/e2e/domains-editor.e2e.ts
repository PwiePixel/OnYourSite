// Browser-Test der eigenen Domain im Editor (PD-4, Chromium): ohne Premium nur der Hinweis „Get Premium“; mit Premium
// über /dashboard#settings/domain eine ungültige Eingabe (Markup bleibt Text), dann eine Domain verbinden (Hinweis,
// Abzeichen „Waiting for DNS“, TXT- und CNAME-Zeile mit Kopierknöpfen), „Check now“ (prüft, dann Wartezeit), Text
// des Teams mit Markup als Text, Entfernen über den eigenen Dialog mit Eingabe der Domain. Auf dem Telefon kein
// seitliches Scrollen. Cloudflare wird nie gefragt.
// Start: cd app && OYS_E2E_PORT=14215 NODE_PATH=$(npm root -g) node --import tsx --test test/e2e/domains-editor.e2e.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { exec, value } from '../../src/db.js';
import { saveDomainSettings } from '../../src/domains/settings.js';
import { SITE, launch, login, startSite, type Site } from './harness.js';

type Browser = Awaited<ReturnType<typeof launch>>;

let site: Site;
let browser: Browser;
const stamp = Date.now();
const premiumEmail = `pd4-prem-${stamp}@test.de`;
const freeEmail = `pd4-free-${stamp}@test.de`;
const HOST = `links-${stamp}.example.com`;
let premiumId = 0;
let freeId = 0;

async function addUser(email: string, premium: boolean): Promise<number> {
  await exec(`INSERT INTO users (email, password, full_name, is_admin, created_at, premium_until)
    SELECT ?, password, 'Domain E2E', 0, '2025-01-01 10:00:00', ? FROM users WHERE email = 'admin@test.de'`, [email, premium ? '2030-01-01 10:00:00' : null]);
  const id = Number(await value('SELECT id FROM users WHERE email = ?', [email]));
  await exec("INSERT INTO pages (user_id, slug, title, created_at) VALUES (?, ?, 'Domain E2E', NOW())", [id, 'pd4-' + (premium ? 'p' : 'f') + '-' + stamp]);
  return id;
}

// Voll laden: nach dem Anmelden steht der Browser schon auf /dashboard – nur den Anker zu ändern lädt nicht neu
async function open(page: import('playwright').Page, path: string): Promise<void> {
  await page.goto('about:blank');
  await page.goto(SITE + path);
}

before(async () => {
  site = await startSite({ cloudflare: { zone_id: 'e'.repeat(32) }, custom_domains: { cname_target: 'edge.oys.test', fallback_origin: 'origin.oys.test' } });
  browser = await launch();
  await saveDomainSettings({ enabled: true, per_user: 3, min_account_days: 0 });
  premiumId = await addUser(premiumEmail, true);
  freeId = await addUser(freeEmail, false);
});

after(async () => {
  for (const id of [premiumId, freeId]) {
    if (!id) continue;
    await exec('DELETE FROM custom_domains WHERE user_id = ?', [id]).catch(() => undefined);
    await exec('DELETE FROM custom_domain_log WHERE user_id = ?', [id]).catch(() => undefined);
    await exec('DELETE FROM pages WHERE user_id = ?', [id]).catch(() => undefined);
    await exec('DELETE FROM users WHERE id = ?', [id]).catch(() => undefined);
  }
  await exec("DELETE FROM oys_meta WHERE meta_key = 'custom_domains'").catch(() => undefined);
  await browser?.close();
  await site?.stop();
});

test('without Premium: the section shows the Premium teaser only', async () => {
  const page = await browser.newPage();
  await login(page, freeEmail);
  await open(page, '/dashboard#settings/domain');
  const sec = page.locator('#domainSection');
  await sec.getByText('Use your own domain, like links.yourname.com, for this page.').waitFor();
  assert.equal(await sec.locator('#domainInput').count(), 0);
  await sec.getByRole('button', { name: 'Get Premium' }).click();
  await page.locator('#tab-honeycombs').waitFor({ state: 'visible' });
  await page.close();
});

test('with Premium: connect, check, team text as text, remove', async () => {
  const page = await browser.newPage();
  await login(page, premiumEmail);
  await open(page, '/dashboard#settings/domain');
  const sec = page.locator('#domainSection');
  await sec.locator('#domainInput').waitFor();
  // Markup in der Eingabe: Fehler vom Server, nichts ausgeführt
  await sec.locator('#domainInput').fill('<img src=x onerror="window.__xss=1">.com');
  await sec.getByRole('button', { name: 'Connect domain' }).click();
  await sec.locator('[role=alert]').waitFor();
  assert.equal(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss), undefined);
  // Verbinden
  await sec.locator('#domainInput').fill('https://' + HOST.toUpperCase() + '/path');
  await sec.getByRole('button', { name: 'Connect domain' }).click();
  await sec.getByText('Waiting for DNS', { exact: true }).waitFor();
  await page.getByText('Domain added – add the DNS records below.').waitFor();
  assert.equal(await sec.locator('#domainName').innerText(), HOST);
  const rows = sec.locator('.dns-table .dns-row:not(.dns-head)');
  assert.equal(await rows.count(), 2);
  assert.match(await rows.nth(0).innerText(), /TXT[\s\S]*_onyoursite\.links-\d+[\s\S]*onyoursite-verify=/);
  assert.match(await rows.nth(1).innerText(), /CNAME[\s\S]*links-\d+[\s\S]*edge\.oys\.test/);
  assert.equal(await rows.nth(0).locator('[data-copy]').count(), 2);
  // Prüfen: danach läuft die Prüfung (Knopf gesperrt), die Zeile ist zur Prüfung vorgemerkt
  await sec.getByRole('button', { name: 'Check now' }).click();
  await sec.locator('[data-dom="check"][disabled]').waitFor();
  assert.ok(await value('SELECT manual_at FROM custom_domains WHERE hostname = ?', [HOST]));
  // Text des Teams mit Markup: bleibt Text
  await exec("UPDATE custom_domains SET state = 'blocked', blocked_reason = ? WHERE hostname = ?", ['<b id="inj">bad</b><img src=x onerror="window.__xss=2">', HOST]);
  await open(page, '/dashboard#settings/domain');
  await sec.getByText('Disabled by the team', { exact: true }).waitFor();
  assert.equal(await page.locator('#inj').count(), 0);
  assert.equal(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss), undefined);
  await exec("UPDATE custom_domains SET state = 'verifying', blocked_reason = NULL WHERE hostname = ?", [HOST]);
  await open(page, '/dashboard#settings/domain');
  await sec.getByText('Waiting for DNS', { exact: true }).waitFor();
  // Entfernen über den eigenen Dialog: erst nach Eingabe der Domain
  await sec.locator('[data-dom="remove"]').click();
  const dialog = page.locator('.ui-dialog').last();
  await dialog.waitFor();
  const ok = dialog.getByRole('button', { name: 'Remove domain' });
  assert.equal(await ok.isDisabled(), true);
  await dialog.locator('input').fill(HOST);
  await ok.click();
  await page.getByText('Domain removed.').waitFor();
  await sec.locator('#domainInput').waitFor();
  assert.equal(Number(await value('SELECT COUNT(*) FROM custom_domains WHERE hostname = ?', [HOST])), 0);
  await page.close();
});

test('phone: the records table fits without sideways scrolling', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await login(page, premiumEmail);
  await open(page, '/dashboard#settings/domain');
  const sec = page.locator('#domainSection');
  await sec.locator('#domainInput').fill('m.' + HOST);
  await sec.getByRole('button', { name: 'Connect domain' }).click();
  await sec.getByText('Waiting for DNS', { exact: true }).waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, 'no sideways scrolling: ' + overflow);
  await ctx.close();
});
