// Browser-Test der Discord-Einstellungen (Admin → Discord) mit Chromium und einem Discord-Ersatz.
// Kern ist die Schleife, in der der Besitzer festhing (DECISIONS.md Q13): Webhook-Link → „braucht eine Kanal-ID“,
// Kanal-ID → „braucht einen Webhook-Link“. Dazu: nur die Felder des sichtbaren Formulars werden gesendet (Autofill),
// keine Passwortfelder, jede Meldung nennt genau, was fehlt, Speichern fragt bei Discord nach und zeigt dessen Fehler.
// Start: cd app && oys-db.sh run node --import tsx --test test/e2e/discord-settings.e2e.ts
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { exec, value } from '../../src/db.js';
import { decryptData, encryptData } from '../../src/crypto.js';
import { startStandIn, type DiscordStandIn } from '../fixtures/discord/standIn.js';
import { SITE, flash, launch, login, startSite, type Site } from './harness.js';

type Browser = Awaited<ReturnType<typeof launch>>;
type Page = import('playwright').Page;

let site: Site;
let discord: DiscordStandIn;
let browser: Browser;
let page: Page;

// Webhook-Links zur Laufzeit zusammengesetzt (kein tokenförmiger Text im Repository)
const token = (seed: string): string => (seed + 'Xy9_-').repeat(12).slice(0, 68);
const hookLink = (id: string): string => `${discord.base}/webhooks/${id}/${token('h' + id.slice(-3))}`;
const OK_HOOK = '1301234567890123456';
const FORUM_HOOK = '1551234567890123456';

async function storeDiscord(settings: Record<string, unknown> | null): Promise<void> {
  if (settings === null) await exec("DELETE FROM oys_meta WHERE meta_key = 'discord'");
  else await exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('discord', ?)", [encryptData(JSON.stringify(settings)) ?? null]);
}
async function storedDiscord(): Promise<Record<string, unknown> | null> {
  const raw = await value("SELECT meta_value FROM oys_meta WHERE meta_key = 'discord'");
  return raw === null ? null : (JSON.parse(String(decryptData(String(raw)))) as Record<string, unknown>);
}

// Die beiden Meldungen der alten Schleife (Q13) dürfen in keiner Meldung mehr vorkommen
const OLD_LOOP = [/a token and a channel ID/i, /a webhook link or bot/i, /for the bot/i];
async function checkedFlash(): Promise<string> {
  const text = await flash(page);
  for (const old of OLD_LOOP) assert.doesNotMatch(text, old);
  return text;
}

// Ein Formular so senden, wie es eine alte, noch offene Seite täte – mit dem CSRF-Wert der Seite
async function postAdmin(fields: Record<string, string>): Promise<string> {
  await Promise.all([page.waitForNavigation(), page.evaluate((f) => {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/admin';
    const all: Record<string, string> = { csrf: (document.querySelector('input[name=csrf]') as HTMLInputElement).value, ...f };
    for (const [name, v] of Object.entries(all)) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = v;
      form.append(input);
    }
    document.body.append(form);
    form.submit();
  }, fields)]);
  return checkedFlash();
}

async function openDiscordTab(): Promise<void> {
  await page.goto(SITE + '/admin#discord');
  await page.locator('#tab-discord').waitFor({ state: 'visible' });
}

// Das Formular absenden, in dem das Feld steht (wie Enter im Feld)
async function submitFormOf(locator: ReturnType<Page['locator']>): Promise<string> {
  await Promise.all([page.waitForNavigation(), locator.evaluate((el) => (el as HTMLInputElement).form!.requestSubmit())]);
  return checkedFlash();
}

before(async () => {
  discord = await startStandIn();
  site = await startSite({ discord_api_base: discord.base });
  browser = await launch();
});

after(async () => {
  await browser?.close();
  await site?.stop();
  await discord?.close();
});

beforeEach(async () => {
  discord.restart();
  await exec("DELETE FROM rate_limits WHERE rl_key LIKE 'discord%'");
  await exec('UPDATE updates SET discord_message_id = NULL, discord_target = NULL');
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  page.on('dialog', (d) => void d.accept());
  await login(page);
});

test('Q13: with the bot mode stored, pasting a webhook link saves and checks it, and "Send test" reaches Discord', async () => {
  // Stand des Besitzers: früher „Discord bot“ gewählt, aber nie Token und Kanal gespeichert
  await storeDiscord({ mode: 'bot', webhook_url: '', bot_token: '', channel_id: '', mention: '', username: '', avatar_url: '', invite_url: '', auto_post: true });
  await openDiscordTab();
  const link = page.locator('#tab-discord').getByLabel('Webhook link', { exact: true });
  await link.fill(hookLink(OK_HOOK), { force: true });
  const saved = await submitFormOf(link);
  assert.match(saved, /^Webhook saved and checked – Discord knows it as “Captain Hook”/, 'saving the webhook link works whatever mode was stored');
  assert.equal(discord.calls().filter((c) => c.method === 'GET' && c.path.includes('/webhooks/' + OK_HOOK + '/')).length, 1, 'saving asked Discord once');
  const stored = await storedDiscord();
  assert.equal(stored?.mode, 'webhook');
  assert.equal(stored?.webhook_url, hookLink(OK_HOOK));
  assert.match(await page.locator('#tab-discord').innerText(), /Posting with the webhook “Captain Hook”/);

  await Promise.all([page.waitForNavigation(), page.locator('#discordWebhookForm').getByRole('button', { name: 'Send test' }).click()]);
  assert.equal(await checkedFlash(), 'Test message sent – check your Discord channel.');
  const post = discord.calls().find((c) => c.method === 'POST' && c.path.includes('/webhooks/' + OK_HOOK + '/'));
  assert.ok(post, 'the test message reached Discord');
  assert.equal((post!.body as { embeds: Array<{ title: string }> }).embeds[0].title, 'Discord is connected');
});

test('Q13: a channel ID alone is never "saved" – the old combined form changes nothing', async () => {
  await storeDiscord({ mode: 'bot', webhook_url: '', bot_token: '', channel_id: '', mention: '', username: '', avatar_url: '', invite_url: '', auto_post: true });
  await openDiscordTab();
  const before = await storedDiscord();
  // Die Kanal-ID in das Feld für den Link (das einzige Feld dafür): abgelehnt, und die Meldung sagt, was fehlt
  const link = page.locator('#discordWebhookForm').getByLabel('Webhook link', { exact: true });
  await link.fill('1301234567890123456');
  assert.equal(await submitFormOf(link), 'That’s a channel ID – posting with a webhook needs the webhook’s link instead. In Discord: channel settings → Integrations → Webhooks → Copy Webhook URL.');
  assert.deepEqual(await storedDiscord(), before, 'nothing was stored');
  const text = await postAdmin({ oys_action: 'discord_save', mode: 'bot', webhook_url: '', bot_token: '', channel_id: '1301234567890123456' });
  assert.equal(text, 'This form is out of date – please reload the page.');
  assert.deepEqual(await storedDiscord(), before, 'nothing was stored');
  // Ohne gespeicherten Token gibt es auch kein Feld für eine Kanal-ID
  assert.equal(await page.locator('#tab-discord').getByLabel('Channel ID').count(), 0);
});

test('Q13: every message names exactly what is missing for the chosen destination', async () => {
  await storeDiscord(null);
  await openDiscordTab();
  const form = page.locator('#discordWebhookForm');
  // Kein Link
  let text = await submitFormOf(form.getByLabel('Webhook link', { exact: true }));
  assert.equal(text, 'Webhook link is missing – in Discord: channel settings → Integrations → Webhooks → Copy Webhook URL, then paste it here.');
  assert.equal(await storedDiscord(), null, 'nothing stored');
  // Thread gewählt, aber keine Thread-ID
  await openDiscordTab();
  await form.getByLabel('Webhook link', { exact: true }).fill(hookLink(OK_HOOK));
  await form.getByText('In a thread', { exact: true }).click();
  text = await submitFormOf(form.getByLabel('Webhook link', { exact: true }));
  assert.equal(text, 'Thread ID is missing – in Discord turn on Developer Mode, right-click the thread → Copy Thread ID.');
  assert.equal(await storedDiscord(), null, 'nothing stored');
  // Die eingegebenen Werte (außer dem Link) bleiben, das Feld ist markiert
  assert.equal(await form.locator('input[name=post_in][value=thread]').isChecked(), true);
  assert.match(String(await form.locator('input[name=thread_id]').getAttribute('class')), /ring-red-500/);
  // Test ohne Webhook: sagt, was zu tun ist
  text = await postAdmin({ oys_action: 'discord_webhook_test' });
  assert.equal(text, 'There is no webhook to test yet – paste a webhook link under “Post with a webhook” and save it.');
});

test('Q13: saving checks the webhook with Discord and shows Discord\'s own error; nothing is stored then', async () => {
  await storeDiscord(null);
  await openDiscordTab();
  const link = page.locator('#discordWebhookForm').getByLabel('Webhook link', { exact: true });
  await link.fill(hookLink('4041234567890123456'));
  const text = await submitFormOf(link);
  assert.match(text, /^Discord doesn’t know this webhook – it was deleted or the link is incomplete\./);
  assert.match(text, /Discord said: “Unknown Webhook” \(10015\)/);
  assert.equal(await storedDiscord(), null);
  // Ein Name, den Discord ablehnt, wird schon beim Speichern abgewiesen (früher erst beim ersten Beitrag: Invalid Form Body)
  await openDiscordTab();
  await link.fill(hookLink(OK_HOOK));
  await page.locator('#discordWebhookForm').getByLabel('Display name').fill('admin@test.de');
  assert.equal(await submitFormOf(link), 'Display name: Discord doesn’t allow “@” in names.');
  assert.equal(await storedDiscord(), null);
});

test('autofill: only the webhook form\'s own fields are sent, and the Discord tab has no password fields', async () => {
  await storeDiscord(null);
  await openDiscordTab();
  const tab = page.locator('#tab-discord');
  assert.equal(await tab.locator('input[type=password]').count(), 0, 'no password inputs');
  assert.equal(await tab.locator('input[name=username], input[name=email], input[name=webhook_url], input[name=bot_token], input[name=channel_id]').count(), 0, 'no field names a browser fills with logins');
  // Alles außerhalb des Webhook-Formulars ausfüllen, wie es ein Passwort-Manager täte
  for (const input of await tab.locator('input[type=text], input[type=url], input:not([type])').all()) {
    const inWebhookForm = await input.evaluate((el) => !!el.closest('#discordWebhookForm'));
    if (!inWebhookForm && (await input.isEditable())) await input.fill('admin@test.de');
  }
  const form = page.locator('#discordWebhookForm');
  await form.getByLabel('Webhook link', { exact: true }).fill(hookLink(OK_HOOK));
  const sent: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/admin')) sent.push(r.postData() ?? '');
  });
  const text = await submitFormOf(form.getByLabel('Webhook link', { exact: true }));
  assert.match(text, /^Webhook saved and checked/);
  assert.equal(sent.length, 1);
  const keys = [...new URLSearchParams(sent[0]).keys()].sort();
  assert.deepEqual(keys, ['avatar_url', 'csrf', 'display_name', 'mention', 'oys_action', 'post_in', 'webhook_link'], 'the hidden thread field is not sent either');
  assert.ok(!sent[0].includes('admin%40test.de'), 'no value from another form was sent');
});

test('Q13: a webhook link pasted into another field goes into the webhook link field (also when one is saved)', async () => {
  await storeDiscord(null);
  await openDiscordTab();
  const form = page.locator('#discordWebhookForm');
  await form.getByLabel('Webhook link', { exact: true }).fill(hookLink(OK_HOOK));
  assert.match(await submitFormOf(form.getByLabel('Webhook link', { exact: true })), /^Webhook saved and checked/);
  // Gespeichert: kein Eingabefeld mit dem Link im Dokument
  assert.equal(await form.locator('input[name=webhook_link]').count(), 0);
  const paste = (selector: string, text: string) => page.locator(selector).evaluate((el, t) => {
    const data = new DataTransfer();
    data.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
  const thread = '1401234567890123456';
  await paste('#dDisplayName', hookLink('1309876543210987654') + '?thread_id=' + thread);
  const link = form.locator('input[name=webhook_link]');
  assert.equal(await link.inputValue(), hookLink('1309876543210987654') + '?thread_id=' + thread);
  assert.equal(await form.locator('#dDisplayName').inputValue(), '', 'not pasted into the name');
  assert.equal(await form.locator('input[name=post_in][value=thread]').isChecked(), true, 'the thread was chosen');
  assert.equal(await form.locator('input[name=thread_id]').inputValue(), thread);
  assert.match(await submitFormOf(link), /^Webhook saved and checked/);
  const stored = await storedDiscord();
  assert.equal(stored?.webhook_url, hookLink('1309876543210987654'));
  assert.equal(stored?.post_in, 'thread');
});

test('the installed bot is shown without asking for a token', async () => {
  await storeDiscord(null);
  await exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('bot_last_seen', UNIX_TIMESTAMP() - 120)");
  await openDiscordTab();
  const card = page.locator('#discordBotCard');
  assert.equal(await card.isVisible(), true);
  assert.match(await card.innerText(), /last seen 2 minutes ago/);
  assert.equal(await page.locator('#tab-discord input[name*=token]').count(), 0, 'no token field');
});

test('forum webhook: the first test creates one post after a confirmation, later tests go into it', async () => {
  await storeDiscord(null);
  await openDiscordTab();
  const form = page.locator('#discordWebhookForm');
  await form.getByLabel('Webhook link', { exact: true }).fill(hookLink(FORUM_HOOK));
  await form.getByText('As a new forum post for each update', { exact: true }).click();
  assert.match(await submitFormOf(form.getByLabel('Webhook link', { exact: true })), /^Webhook saved and checked/);
  const dialogs: string[] = [];
  page.removeAllListeners('dialog');
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.accept();
  });
  await Promise.all([page.waitForNavigation(), form.getByRole('button', { name: 'Send test' }).click()]);
  assert.equal(await checkedFlash(), 'Test message sent – check your Discord channel.');
  assert.equal(dialogs.length, 1, 'the first forum test asks first');
  await Promise.all([page.waitForNavigation(), form.getByRole('button', { name: 'Send test' }).click()]);
  assert.equal(await checkedFlash(), 'Test message sent – check your Discord channel.');
  assert.equal(dialogs.length, 1, 'the second test goes into the same post without asking');
  const posts = discord.calls().filter((c) => c.method === 'POST' && c.path.includes('/webhooks/' + FORUM_HOOK + '/'));
  assert.equal(posts.length, 2);
  assert.equal((posts[0].body as { thread_name?: string }).thread_name, 'OnYourSite test');
  assert.ok(posts[1].path.includes('thread_id='), 'the second test goes into the first post');
});
