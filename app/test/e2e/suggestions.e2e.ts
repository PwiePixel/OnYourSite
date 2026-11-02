// Browser-Test der öffentlichen Vorschlagsseite (Chromium): aus → 404; das Admin schaltet sie über den eigenen Dialog
// ein; ein entschiedener Vorschlag, dessen Autor Bescheid weiß, erscheint, Verbergen nimmt ihn weg; ein alter (ohne
// Hinweis an den Autor) erscheint erst nach „Show on website“ und der Warnung. Dazu die Unternavigation mit drei Pillen
// auf Telefonen (360, 375, 390 px ganz sichtbar, 320 px scrollt in sich, die Seite nie) und kein Cookie für Besucher.
// Start: cd app && OYS_E2E_PORT=14205 NODE_PATH=$(npm root -g) node --import tsx --test test/e2e/suggestions.e2e.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { exec, one, value } from '../../src/db.js';
import { date } from '../../src/php.js';
import { SITE, flash, launch, login, startSite, type Site } from './harness.js';

type Browser = Awaited<ReturnType<typeof launch>>;
type Page = import('playwright').Page;

let site: Site;
let browser: Browser;
let thread = 0;
// Die Testdatenbank teilen sich alle Tests: nur entfernen, was dieser Test angelegt hat
let maxSuggestion = 0;
let maxJob = 0;
let pages: string | null = null;

before(async () => {
  site = await startSite();
  browser = await launch();
  maxSuggestion = Number(await value('SELECT COALESCE(MAX(id), 0) FROM community_suggestions'));
  maxJob = Number(await value('SELECT COALESCE(MAX(id), 0) FROM community_outbox'));
  const stored = await value("SELECT meta_value FROM oys_meta WHERE meta_key = 'community_pages'");
  pages = stored === null ? null : String(stored);
  await exec("DELETE FROM oys_meta WHERE meta_key = 'community_pages'");
  // Nur die Vorschläge dieses Tests sind sichtbar
  await exec("UPDATE community_suggestions SET web_state = 'hidden' WHERE id <= ? AND web_state = 'auto'", [maxSuggestion]);
});

after(async () => {
  await exec('DELETE FROM community_suggestions WHERE id > ?', [maxSuggestion]).catch(() => undefined);
  await exec('DELETE FROM community_outbox WHERE id > ?', [maxJob]).catch(() => undefined);
  await exec("UPDATE community_suggestions SET web_state = 'auto' WHERE id <= ? AND web_state = 'hidden'", [maxSuggestion]).catch(() => undefined);
  await exec("DELETE FROM oys_meta WHERE meta_key = 'community_pages'").catch(() => undefined);
  if (pages !== null) await exec("INSERT INTO oys_meta (meta_key, meta_value) VALUES ('community_pages', ?)", [pages]).catch(() => undefined);
  await browser?.close();
  await site?.stop();
});

async function addSuggestion(title: string, webNotice: number): Promise<number> {
  const now = date('Y-m-d H:i:s');
  const res = await exec(`INSERT INTO community_suggestions (thread_id, author_id, author_name, title, body, status, reason, decided_by, decided_via,
      decided_at, web_notice, created_at, updated_at) VALUES (?, '1400000000000000900', 'Hidden Name', ?, 'Some text', 'accepted', '', 'Team', 'discord', ?, ?, ?, ?)`,
  [String(1400000000000000000n + BigInt(++thread)), title, now, webNotice, now, now]);
  return res.insertId;
}

// Öffentliche Liste in einem eigenen Browser-Kontext (Besucher ohne Anmeldung)
async function publicTitles(): Promise<{ status: number; titles: string[] }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const res = await page.goto(SITE + '/suggestions');
  const titles = res && res.status() === 200 ? await page.locator('article h3').allInnerTexts() : [];
  await context.close();
  return { status: res ? res.status() : 0, titles };
}

// Bestätigen im eigenen Dialog der Seite
async function confirmDialog(page: Page, title: string): Promise<void> {
  await page.waitForSelector('.ui-dialog');
  assert.equal((await page.locator('.ui-dialog .ui-title').innerText()).trim(), title);
  await Promise.all([page.waitForNavigation(), page.click('.ui-dialog .ui-foot .ui-btn:not(.is-ghost)')]);
}

test('moderation: off → 404; on after the dialog; decided and told appears, hide removes it, an old one only after the warning', async () => {
  const told = await addSuggestion('Told and decided', 1);
  const old = await addSuggestion('From before the page', 0);
  assert.equal((await publicTitles()).status, 404);

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await login(page);
  await page.goto(SITE + '/admin?suggestions=all#community');
  const card = page.locator('#community-suggestions-page');
  await card.getByRole('button', { name: 'On', exact: true }).click();
  await confirmDialog(page, 'Turn on the suggestions page?');
  assert.equal(await flash(page), 'The suggestions page is on.');
  assert.equal(JSON.parse(String((await one("SELECT meta_value FROM oys_meta WHERE meta_key = 'community_pages'"))!.meta_value)).suggestions, 'on');
  assert.deepEqual((await publicTitles()).titles, ['Told and decided']);

  // Verbergen (ohne Rückfrage)
  await page.goto(SITE + '/admin?suggestions=all#community');
  await Promise.all([page.waitForNavigation(), page.locator('#suggestion-' + told).getByRole('button', { name: 'Hide on website' }).click()]);
  assert.equal(await flash(page), `Suggestion #${told} is now hidden on the website.`);
  assert.deepEqual((await publicTitles()).titles, []);

  // Ein alter Vorschlag: erst die Warnung, dann sichtbar
  await page.goto(SITE + '/admin?suggestions=all#community');
  const row = page.locator('#suggestion-' + old);
  assert.equal(await row.locator('span[title]').first().getAttribute('title'), 'the author wasn’t told it could appear on the website');
  await row.getByRole('button', { name: 'Show on website' }).click();
  await confirmDialog(page, 'Show it anyway?');
  assert.equal(await flash(page), `Suggestion #${old} is now shown on the website.`);
  assert.deepEqual((await publicTitles()).titles, ['From before the page']);
  await context.close();
});

test('Changelog → Roadmap → Suggestions with aria-current; the three pills fit phones; no cookie for visitors', async () => {
  await exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('community_pages', ?)", [JSON.stringify({ suggestions: 'on' })]);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(SITE + '/updates');
  for (const [label, url] of [['Roadmap', '/roadmap'], ['Suggestions', '/suggestions'], ['Changelog', '/updates']]) {
    await Promise.all([page.waitForURL(SITE + url), page.getByRole('navigation', { name: 'Updates sections' }).getByRole('link', { name: label }).click()]);
    assert.equal(await page.getByRole('navigation', { name: 'Updates sections' }).locator('[aria-current=page]').innerText(), label);
  }
  assert.deepEqual(await context.cookies(), [], 'no cookies after all three pages');
  await context.close();

  for (const width of [320, 360, 375, 390]) {
    const phone = await browser.newContext({ viewport: { width, height: 800 } });
    const p = await phone.newPage();
    for (const path of ['/updates', '/roadmap', '/suggestions']) {
      await p.goto(SITE + path, { waitUntil: 'networkidle' });
      const nav = p.getByRole('navigation', { name: 'Updates sections' });
      assert.equal(await nav.locator('a').count(), 3, `${path}: three pills`);
      const box = (await nav.boundingBox())!;
      assert.ok(box.x >= 0 && box.x + box.width <= width, `${path} at ${width}: nav inside the viewport`);
      assert.ok(await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, `${path} at ${width}: the page does not scroll sideways`);
      const last = (await nav.locator('a').last().boundingBox())!;
      if (width >= 360) assert.ok(last.x + last.width <= box.x + box.width + 0.5, `${path} at ${width}: the last pill is fully visible`);
      else assert.ok(await nav.evaluate((el) => el.scrollWidth >= el.clientWidth), `${path} at ${width}: the pills scroll inside the nav`);
    }
    assert.deepEqual(await phone.cookies(), []);
    await phone.close();
  }
});
