// Browser-Test der Bot-Karte und der Chips (DP-2b) mit Chromium, der laufenden Seite (Port OYS_E2E_PORT) und einem
// echten Bot (die Module aus discord-bot/: signierte Anfragen, Bericht, Abholen, Updates) vor nachgebauten
// Discord-Objekten. Abläufe:
// - Q13 / Ablauf 3: Stand des Besitzers (früher „Discord bot“ gewählt, nie Token oder Webhook) – die Karte bietet
//   „Use #updates“ an, nirgends ein Feld für einen Token; nach dem Klick „Checking with the bot…“, der Bot meldet
//   sich, „Ready“ erscheint ohne Neuladen; „Send test“ geht über den Bot, das Ergebnis erscheint ohne Neuladen.
// - Ablauf 4: Veröffentlichen, Bearbeiten, Zurückziehen – Auftrag, Ergebnis, Chips ohne Neuladen.
// Kein Fenster des Browsers (alert/confirm) darf erscheinen.
// Start: cd app && OYS_E2E_PORT=14209 NODE_PATH=$(npm root -g) oys-db.sh run node --import tsx --test test/e2e/discord-bot-admin.e2e.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { configString, ROOT_DIR } from '../../src/config.js';
import { exec, one, q, value } from '../../src/db.js';
import { encryptData } from '../../src/crypto.js';
import { PORT, SITE, flash, launch, login, startSite, type Site } from './harness.js';

const require = createRequire(import.meta.url);
const BOT_DIR = join(ROOT_DIR, 'discord-bot');
const { SiteClient } = require(join(BOT_DIR, 'src/site.js')) as { SiteClient: any };
const { startOutbox } = require(join(BOT_DIR, 'src/outbox.js')) as { startOutbox: any };
const { setupUpdates } = require(join(BOT_DIR, 'src/updates.js')) as { setupUpdates: any };
const { setupReport } = require(join(BOT_DIR, 'src/report.js')) as { setupReport: any };
const { FakeChannel, BOT_ID } = require(join(BOT_DIR, 'test/fakes.js')) as { FakeChannel: any; BOT_ID: string };

type Browser = Awaited<ReturnType<typeof launch>>;
type Page = import('playwright').Page;

let site: Site;
let browser: Browser;
let restore: (() => Promise<void>) | null = null;

// Die Testdatenbank teilen sich alle Tests: nur entfernen, was dieser Test angelegt hat, die Einstellungen danach
// wiederherstellen
const KEYS = ['discord', 'discord_bot_report', 'discord_bot_test', 'bot_last_seen'];
async function keepState(): Promise<() => Promise<void>> {
  const maxUpdate = Number(await value('SELECT COALESCE(MAX(id), 0) FROM updates'));
  const maxJob = Number(await value('SELECT COALESCE(MAX(id), 0) FROM community_outbox'));
  const meta = await q(`SELECT meta_key, meta_value FROM oys_meta WHERE meta_key IN (${KEYS.map(() => '?').join(', ')})`, KEYS);
  return async () => {
    await exec('DELETE FROM update_discord_posts WHERE update_id > ?', [maxUpdate]);
    await exec('DELETE FROM updates WHERE id > ?', [maxUpdate]);
    await exec('DELETE FROM community_outbox WHERE id > ?', [maxJob]);
    await exec(`DELETE FROM oys_meta WHERE meta_key IN (${KEYS.map(() => '?').join(', ')})`, KEYS);
    for (const m of meta) await exec('INSERT INTO oys_meta (meta_key, meta_value) VALUES (?, ?)', [m.meta_key as string, m.meta_value as string]);
  };
}

before(async () => {
  site = await startSite();
  restore = await keepState();
  browser = await launch();
});

after(async () => {
  await browser?.close();
  await restore?.();
  await site?.stop();
});

// Der Discord-Server des Bots: ein Textkanal #updates, in dem er posten darf
function fakeDiscord() {
  const channel = new FakeChannel({ name: 'updates' });
  channel.rawPosition = 0;
  const guild = {
    id: channel.guild.id, name: 'OnYourSite', features: [],
    channels: { cache: new Map([[channel.id, channel]]) }, roles: { cache: new Map() }, members: { me: { id: BOT_ID } },
  };
  const client = Object.assign(new EventEmitter(), {
    user: { id: BOT_ID },
    guilds: { cache: new Map([[guild.id, guild]]) },
    channels: {
      fetch: async (id: string) => {
        if (id === channel.id) return channel;
        throw Object.assign(new Error('Unknown Channel'), { status: 404, code: 10003 });
      },
    },
  });
  return { channel, client, cfg: { guildId: guild.id, updatesChannelId: channel.id, supportCategoryId: '', suggestionForumId: '' } };
}

// Ein Bot-Prozess: Bericht und Abholen nur über tick() (das Intervall ist eine Stunde)
function startBot(d: ReturnType<typeof fakeDiscord>, logs: string[]) {
  const log = (l: string) => logs.push(l);
  const siteClient = new SiteClient(`http://127.0.0.1:${PORT}`, configString('bot_secret'), { timeoutMs: 5000, log });
  const updates = setupUpdates(d.client, log);
  const report = setupReport(d.client, d.cfg, siteClient, log, ['updates.v1']);
  const outbox = startOutbox(siteClient, {
    'update.post': (data: unknown, item: unknown) => updates.post(data, item),
    'update.edit': (data: unknown) => updates.edit(data),
    'update.delete': (data: unknown) => updates.remove(data),
    'update.test': (data: unknown, item: unknown) => updates.test(data, item),
    'bot.report': async () => {
      await report.send();
      return {};
    },
  }, 3600, log, { features: ['updates.v1'] });
  return { report, outbox };
}

// Neue Seite; ein Fenster des Browsers (alert/confirm/prompt) ist ein Fehler
async function newPage(dialogs: string[], viewport = { width: 1440, height: 900 }): Promise<Page> {
  const page = await (await browser.newContext({ viewport })).newPage();
  page.on('dialog', (dlg) => {
    dialogs.push(dlg.type() + ': ' + dlg.message());
    void dlg.dismiss();
  });
  await login(page);
  return page;
}

// Merker im Fenster: bleibt er stehen, wurde die Seite nicht neu geladen
async function markPage(page: Page): Promise<void> {
  await page.evaluate(() => { (window as unknown as { oysMarker: number }).oysMarker = 42; });
}
async function notReloaded(page: Page): Promise<void> {
  assert.equal(await page.evaluate(() => (window as unknown as { oysMarker?: number }).oysMarker), 42, 'the page was not reloaded');
}
async function waitForText(page: Page, selector: string, text: RegExp, timeout = 15000): Promise<string> {
  await page.waitForFunction(([sel, src]) => {
    const el = document.querySelector(sel);
    return !!el && new RegExp(src).test(el.textContent ?? '');
  }, [selector, text.source] as const, { timeout });
  return (await page.locator(selector).first().textContent()) ?? '';
}
// Alle Hinweise (Toasts), die bisher erschienen sind
async function toasts(page: Page): Promise<string[]> {
  return page.locator('.ui-toast .ui-toast-text').allInnerTexts();
}

test('Q13 and flow 3: the owner’s stored “bot” mode – “Use #updates”, checking with the bot, Ready and a test through the bot, without reloading', async () => {
  // Stand des Besitzers: früher „Discord bot“ gewählt, aber nie Token, Kanal oder Webhook gespeichert
  await exec(`DELETE FROM oys_meta WHERE meta_key IN ('discord_bot_report', 'discord_bot_test', 'bot_last_seen')`);
  await exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('discord', ?)", [String(encryptData(JSON.stringify(
    { mode: 'bot', webhook_url: '', bot_token: '', channel_id: '', mention: '', username: '', avatar_url: '', invite_url: '', auto_post: true },
  )))]);
  const d = fakeDiscord();
  const logs: string[] = [];
  const bot = startBot(d, logs);
  const dialogs: string[] = [];
  try {
    const hello = await bot.report.send();
    assert.equal(hello.ok, true, JSON.stringify(hello));
    const page = await newPage(dialogs);
    await page.goto(SITE + '/admin#discord');
    const tab = page.locator('#tab-discord');
    await tab.waitFor({ state: 'visible' });
    // Nirgends ein Feld für einen Token und kein Passwortfeld – der installierte Bot braucht keins
    assert.equal(await tab.locator('input[name*=token], input[type=password]').count(), 0);
    const card = page.locator('#discordBotCard');
    assert.match(await card.innerText(), /The bot is ready to post in #updates\./);
    await Promise.all([page.waitForNavigation(), card.getByRole('button', { name: 'Use #updates' }).click()]);
    assert.equal(await flash(page), 'Saved – the bot checks #updates now.');
    assert.equal((await card.locator('[data-bot-line]').textContent())?.trim(), 'Checking with the bot…');
    assert.match(await page.locator('[data-bot-badge]').innerText(), /checking/i);
    await markPage(page);
    // Der Bot holt den Auftrag ab und schickt seinen Bericht – die Karte wechselt ohne Neuladen auf „Ready“
    await bot.outbox.tick();
    assert.equal(await waitForText(page, '#discordBotCard [data-bot-line]', /^Ready – the bot can post in #updates\.$/), 'Ready – the bot can post in #updates.');
    await notReloaded(page);
    assert.match(await page.locator('[data-bot-badge]').innerText(), /online/i);
    await page.waitForFunction(() => [...document.querySelectorAll('.ui-toast .ui-toast-text')].some((t) => /Ready – the bot can post in #updates/.test(t.textContent ?? '')));
    // Testnachricht über den Bot
    await Promise.all([page.waitForNavigation(), card.getByRole('button', { name: 'Send test' }).click()]);
    assert.equal(await flash(page), 'Test message queued – the bot posts it within a few seconds.');
    assert.equal((await card.locator('[data-bot-test]').textContent())?.trim(), 'Sending the test through the bot…');
    await markPage(page);
    await bot.outbox.tick();
    const line = await waitForText(page, '#discordBotCard [data-bot-test]', /^Test message posted in #updates at \d\d:\d\d\.$/);
    assert.match(line, /^Test message posted in #updates at \d\d:\d\d\.$/);
    await notReloaded(page);
    assert.equal(d.channel.sent.length, 1, logs.join('\n'));
    assert.equal(d.channel.sent[0].payload.embeds[0].title, 'Discord is connected');
    assert.deepEqual(d.channel.sent[0].payload.allowedMentions, { parse: [] }, 'a test never pings');
    // Immer noch kein Token-Feld – auch nicht, nachdem der Bot gespeichert ist
    assert.equal(await tab.locator('input[name*=token], input[type=password]').count(), 0);
    // Am Telefon passt die Karte in die Breite
    const phone = await newPage(dialogs, { width: 390, height: 844 });
    await phone.goto(SITE + '/admin#discord');
    await phone.locator('#discordBotCard').waitFor({ state: 'visible' });
    const box = await phone.locator('#discordBotCard').boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390 + 1, JSON.stringify(box));
    assert.deepEqual(dialogs, [], 'no browser dialogs');
  } finally {
    await bot.outbox.stop(300);
    bot.report.stop();
  }
});

test('flow 4: publish, edit and unpublish – the job, the bot’s result and the chips change without reloading', async () => {
  const d = fakeDiscord();
  const logs: string[] = [];
  const bot = startBot(d, logs);
  const dialogs: string[] = [];
  try {
    await bot.report.send();
    // Der Bot ist für #updates gespeichert (wie nach „Use #updates“)
    await exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('discord', ?)", [String(encryptData(JSON.stringify(
      { v: 2, auto_post: true, invite_url: '', bot: { enabled: true, channel_id: d.channel.id, channel_type: 'text', mention: '', saved_at: '2026-01-01 00:00:00' }, webhook: {}, bot_token: '', channel_id: '', mention: '' },
    )))]);
    const page = await newPage(dialogs);
    await page.goto(SITE + '/admin#updates');
    const form = page.locator('#tab-updates form').first();
    await form.locator('input[name=title]').fill('Bot chip news');
    await form.locator('textarea[name=body]').fill('Posted by the installed bot.');
    assert.equal(await form.locator('input[name=post_discord]').isChecked(), true);
    assert.match(await form.innerText(), /Announce on Discord when published\s*\(bot in #updates\)/);
    await Promise.all([page.waitForNavigation(), form.getByRole('button', { name: 'Save update' }).click()]);
    assert.equal(await flash(page), 'Update published. The bot posts it to Discord within a few seconds.');
    const id = Number((await one('SELECT id FROM updates WHERE title = ?', ['Bot chip news']))!.id);
    const chip = page.locator(`#tab-updates [data-discord-chips="${id}"] [data-discord-post]`);
    assert.equal((await chip.locator('[data-chip-label]').textContent())?.trim(), 'Bot · posting…');
    assert.equal(await chip.getAttribute('data-state'), 'queued');
    await markPage(page);
    // Der Bot postet; der Chip wechselt ohne Neuladen, ein Hinweis sagt es
    await bot.outbox.tick();
    await waitForText(page, `#tab-updates [data-discord-chips="${id}"] [data-chip-label]`, /^Bot · posted$/);
    await notReloaded(page);
    await page.waitForFunction(() => [...document.querySelectorAll('.ui-toast .ui-toast-text')].some((t) => /Posted to Discord: “Bot chip news”\./.test(t.textContent ?? '')));
    assert.equal(d.channel.sent.length, 1, logs.join('\n'));
    const msg = d.channel.sent[0];
    // Bearbeiten: der Bot ändert seine Nachricht (ohne neuen Ping); der Chip zeigt, dass das noch läuft, bis es fertig ist
    await page.goto(SITE + `/admin?edit_update=${id}#updates`);
    const edit = page.locator('#tab-updates form').first();
    assert.match(await edit.innerText(), /On Discord \(bot in #updates\) – changes are synced, drafts are removed there\./);
    await edit.locator('input[name=title]').fill('Bot chip news, edited');
    await Promise.all([page.waitForNavigation(), edit.getByRole('button', { name: 'Save changes' }).click()]);
    assert.equal(await flash(page), 'Update published. The bot updates its post within a few seconds.');
    assert.equal(await page.locator(`#tab-updates [data-discord-chips="${id}"] [data-discord-post]`).getAttribute('data-busy'), '1');
    await markPage(page);
    await bot.outbox.tick();
    await page.waitForFunction((uid) => document.querySelector(`#tab-updates [data-discord-chips="${uid}"] [data-discord-post]`)?.getAttribute('data-busy') === '0', id, { timeout: 15000 });
    await page.waitForFunction(() => [...document.querySelectorAll('.ui-toast .ui-toast-text')].some((t) => /The Discord post of “Bot chip news, edited” is updated\./.test(t.textContent ?? '')));
    await notReloaded(page);
    assert.equal(msg.edits.length, 1);
    assert.equal(msg.embeds[0].title.includes('edited'), true);
    // Zurückziehen: „removing…“, dann verschwindet der Chip
    const row = page.locator('#tab-updates li', { has: page.locator(`[data-discord-chips="${id}"]`) });
    await Promise.all([page.waitForNavigation(), row.getByRole('button', { name: 'Unpublish' }).click()]);
    assert.equal(await flash(page), 'Moved back to drafts. The bot removes its post within a few seconds.');
    assert.equal((await page.locator(`#tab-updates [data-discord-chips="${id}"] [data-chip-label]`).textContent())?.trim(), 'Bot · removing…');
    await markPage(page);
    await bot.outbox.tick();
    await page.waitForFunction((uid) => document.querySelectorAll(`#tab-updates [data-discord-chips="${uid}"] [data-discord-post]`).length === 0, id, { timeout: 15000 });
    await page.waitForFunction(() => [...document.querySelectorAll('.ui-toast .ui-toast-text')].some((t) => /Removed from Discord: “Bot chip news, edited”\./.test(t.textContent ?? '')));
    await notReloaded(page);
    assert.equal(msg.deleted, true);
    assert.equal(await one('SELECT id FROM update_discord_posts WHERE update_id = ?', [id]), null);
    assert.ok((await toasts(page)).length >= 1);
    assert.deepEqual(dialogs, [], 'no browser dialogs');
  } finally {
    await bot.outbox.stop(300);
    bot.report.stop();
  }
});
