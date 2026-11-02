// Bot und Webseite zusammen: die echten Module des Bots (Bericht, Abholen, Updates posten, signierte Anfragen) gegen
// die laufende Seite (eigener Prozess, Port OYS_E2E_PORT) und nachgebaute Discord-Objekte. Ein Update wird gepostet,
// bearbeitet und gelöscht, ohne dass irgendwo ein Token eingetragen ist. Fällt die Webseite zwischen dem Posten und der
// Rückmeldung aus, entsteht kein zweiter Beitrag – weder, wenn der Bot die Rückmeldung nachschickt, noch, wenn er sie
// verloren hat (neu gestartet): dann gibt die Webseite den Auftrag mit recheck aus und der Bot findet seinen Beitrag.
// Ein in Discord gelöschter Vorschlagsbeitrag (rohes Gateway-Ereignis) verschwindet von /suggestions.
// Start: cd app && OYS_E2E_PORT=14205 NODE_PATH=$(npm root -g) node --import tsx --test test/e2e/bot-site.e2e.ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { join } from 'node:path';
import { configString, ROOT_DIR } from '../../src/config.js';
import { exec, one, q, value } from '../../src/db.js';
import { adminUpdatesHandle } from '../../src/updates/admin.js';
import { HOST, PORT, startSite, type Site } from './harness.js';

const require = createRequire(import.meta.url);
const BOT_DIR = join(ROOT_DIR, 'discord-bot');
const { SiteClient } = require(join(BOT_DIR, 'src/site.js')) as { SiteClient: any };
const { startOutbox } = require(join(BOT_DIR, 'src/outbox.js')) as { startOutbox: any };
const { setupUpdates } = require(join(BOT_DIR, 'src/updates.js')) as { setupUpdates: any };
const { setupReport } = require(join(BOT_DIR, 'src/report.js')) as { setupReport: any };
const { setupSuggestions } = require(join(BOT_DIR, 'src/suggestions.js')) as { setupSuggestions: any };
const { FakeChannel, BOT_ID } = require(join(BOT_DIR, 'test/fakes.js')) as { FakeChannel: any; BOT_ID: string };

let site: Site | null = null;
let restore: (() => Promise<void>) | null = null;
after(async () => {
  await restore?.();
  await site?.stop();
});

// Die Testdatenbank teilen sich alle Tests: nur entfernen, was dieser Test angelegt hat, und die Einstellungen danach
// wiederherstellen
const KEYS = ['discord', 'discord_bot_report', 'discord_bot_test', 'bot_last_seen', 'community_pages'];
async function keepState(): Promise<() => Promise<void>> {
  const maxUpdate = Number(await value('SELECT COALESCE(MAX(id), 0) FROM updates'));
  const maxJob = Number(await value('SELECT COALESCE(MAX(id), 0) FROM community_outbox'));
  const maxSuggestion = Number(await value('SELECT COALESCE(MAX(id), 0) FROM community_suggestions'));
  const meta = await q(`SELECT meta_key, meta_value FROM oys_meta WHERE meta_key IN (${KEYS.map(() => '?').join(', ')})`, KEYS);
  return async () => {
    await exec('DELETE FROM update_discord_posts WHERE update_id > ?', [maxUpdate]);
    await exec('DELETE FROM updates WHERE id > ?', [maxUpdate]);
    await exec('DELETE FROM community_outbox WHERE id > ?', [maxJob]);
    await exec('DELETE FROM community_suggestions WHERE id > ?', [maxSuggestion]);
    await exec(`DELETE FROM oys_meta WHERE meta_key IN (${KEYS.map(() => '?').join(', ')})`, KEYS);
    for (const m of meta) await exec('INSERT INTO oys_meta (meta_key, meta_value) VALUES (?, ?)', [m.meta_key as string, m.meta_value as string]);
  };
}

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
type Discord = ReturnType<typeof fakeDiscord>;

// Ein Bot-Prozess: Bericht, Abholen (nur über tick(); das Intervall ist eine Stunde) und die Updates-Aufträge.
// afterPost läuft einmal nach dem Posten in Discord – vor der Rückmeldung an die Webseite.
function startBot(d: Discord, logs: string[]) {
  const log = (l: string) => logs.push(l);
  const siteClient = new SiteClient(`http://127.0.0.1:${PORT}`, configString('bot_secret'), { timeoutMs: 5000, log });
  const updates = setupUpdates(d.client, log);
  const report = setupReport(d.client, d.cfg, siteClient, log, ['updates.v1']);
  const hooks: { afterPost: null | (() => Promise<void>) } = { afterPost: null };
  const outbox = startOutbox(siteClient, {
    'update.post': async (data: unknown, item: unknown) => {
      const r = await updates.post(data, item);
      const hook = hooks.afterPost;
      hooks.afterPost = null;
      if (hook) await hook();
      return r;
    },
    'update.edit': (data: unknown) => updates.edit(data),
    'update.delete': (data: unknown) => updates.remove(data),
    'bot.report': async () => {
      await report.send();
      return {};
    },
  }, 3600, log, { features: ['updates.v1'] });
  return { report, outbox, hooks };
}

const postOf = (updateId: number) => one('SELECT * FROM update_discord_posts WHERE update_id = ? AND via = ?', [updateId, 'bot']);
async function publish(title: string): Promise<number> {
  const saved = await adminUpdatesHandle({ oys_action: 'update_save', title, body: 'Text', category: 'new', publish: '1', announce_field: '1', post_discord: '1' });
  assert.deepEqual(saved, { tab: 'updates', ok: 'Update published. The bot posts it to Discord within a few seconds.' });
  return Number((await one('SELECT id FROM updates WHERE title = ?', [title]))!.id);
}
// Die Webseite fällt aus (der Prozess endet)
const outage = async (): Promise<void> => {
  await site!.stop();
  site = null;
};

test('the bot posts, edits and deletes updates by itself; an outage between posting and /done never posts twice', async () => {
  site = await startSite();
  restore ??= await keepState();
  // Ohne Webhook und ohne alten Token: der installierte Bot postet von selbst
  await exec(`DELETE FROM oys_meta WHERE meta_key IN ('discord', 'discord_bot_report', 'discord_bot_test', 'bot_last_seen')`);
  const d = fakeDiscord();
  const logs: string[] = [];
  let bot = startBot(d, logs);
  try {
    // Bericht: #updates, der Bot darf dort posten – die Webseite nennt ihre Funktionen
    const hello = await bot.report.send();
    assert.equal(hello.ok, true, JSON.stringify(hello));
    assert.ok(bot.report.siteFeatures().includes('updates.v1'));

    // Veröffentlichen → der Bot holt den Auftrag ab und postet; die Webseite kennt danach die Nachricht
    const first = await publish('Bot news');
    await bot.outbox.tick();
    assert.equal(d.channel.sent.length, 1, logs.join('\n'));
    const msg = d.channel.sent[0];
    assert.equal(msg.payload.embeds[0].title.includes('Bot news'), true);
    assert.deepEqual(msg.payload.allowedMentions, { parse: [] });
    let row = (await postOf(first))!;
    assert.deepEqual([row.state, row.message_id, row.channel_id], ['posted', msg.id, d.channel.id]);

    // Bearbeiten → dieselbe Nachricht ändert sich, ohne neuen Ping
    const edited = await adminUpdatesHandle({ oys_action: 'update_save', id: String(first), title: 'Bot news, edited', body: 'New', category: 'new', publish: '1' });
    assert.deepEqual(edited, { tab: 'updates', ok: 'Update published. The bot updates its post within a few seconds.' });
    await bot.outbox.tick();
    assert.equal(msg.edits.length, 1, logs.join('\n'));
    assert.equal('content' in msg.edits[0], false);
    assert.equal(msg.embeds[0].title.includes('edited'), true);
    assert.equal(d.channel.sent.length, 1);

    // Löschen → die Nachricht verschwindet aus Discord, die Zeile aus der Datenbank
    const deleted = await adminUpdatesHandle({ oys_action: 'update_delete', id: String(first) });
    assert.match(String((deleted as { ok?: string }).ok), /^Update deleted\./);
    await bot.outbox.tick();
    assert.equal(msg.deleted, true, logs.join('\n'));
    assert.equal(await postOf(first), null);

    // Ausfall nach dem Posten: die Rückmeldung bleibt beim Bot und geht nach, sobald die Seite wieder da ist
    const second = await publish('Second news');
    bot.hooks.afterPost = outage;
    await bot.outbox.tick();
    assert.equal(d.channel.sent.length, 1);
    assert.equal(bot.outbox.pending.size, 1);
    site = await startSite();
    await bot.outbox.tick();
    assert.equal(bot.outbox.pending.size, 0);
    row = (await postOf(second))!;
    assert.deepEqual([row.state, row.message_id], ['posted', d.channel.sent[0].id]);
    assert.equal(d.channel.sent.length, 1, 'posted once');

    // Ausfall nach dem Posten, und der Bot startet neu (die Rückmeldung ist weg): die Webseite gibt den Auftrag noch
    // einmal aus, mit recheck – der Bot findet seinen Beitrag und postet nichts
    const third = await publish('Third news');
    bot.hooks.afterPost = outage;
    await bot.outbox.tick();
    assert.equal(d.channel.sent.length, 2);
    await bot.outbox.stop(300);
    bot.report.stop();
    site = await startSite();
    bot = startBot(d, logs);
    await bot.outbox.tick();
    assert.equal(d.channel.sent.length, 2, 'not posted twice: ' + logs.join('\n'));
    row = (await postOf(third))!;
    assert.deepEqual([row.state, row.message_id], ['posted', d.channel.sent[1].id]);
  } finally {
    await bot.outbox.stop(300);
    bot.report.stop();
  }
});

// Seite der Webseite als Besucher (Host der Hauptseite)
function getPage(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path, headers: { host: HOST } }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).on('error', reject);
  });
}

test('a suggestion post deleted in Discord (raw gateway packet) disappears from /suggestions', async () => {
  site ??= await startSite();
  restore ??= await keepState();
  const FORUM = '1450000000000000001';
  const THREAD = '1450000000000000002';
  await exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('community_pages', ?)", [JSON.stringify({ suggestions: 'on' })]);
  await exec(`INSERT INTO community_suggestions (thread_id, author_id, author_name, title, body, status, decided_by, decided_via, decided_at, web_notice, created_at, updated_at)
    VALUES (?, '1450000000000000003', 'Mia', 'Deleted later', 'Some words', 'accepted', 'Team', 'discord', NOW(), 1, NOW(), NOW())`, [THREAD]);
  try {
    assert.match((await getPage('/suggestions')).body, /Deleted later/);
    const d = fakeDiscord();
    const logs: string[] = [];
    const log = (l: string) => logs.push(l);
    const siteClient = new SiteClient(`http://127.0.0.1:${PORT}`, configString('bot_secret'), { timeoutMs: 5000, log });
    const report = setupReport(d.client, d.cfg, siteClient, log, ['updates.v1', 'suggestions.v2']);
    await report.send();
    assert.ok(report.siteFeatures().includes('suggestions.v2'), 'the website can do suggestions.v2');
    setupSuggestions(d.client, { ...d.cfg, suggestionForumId: FORUM }, siteClient, log, { siteFeatures: () => report.siteFeatures() });
    d.client.emit('raw', { t: 'THREAD_DELETE', d: { id: THREAD, parent_id: FORUM, guild_id: d.cfg.guildId, type: 11 } });
    for (let i = 0; i < 50 && (await one('SELECT removed_at FROM community_suggestions WHERE thread_id = ?', [THREAD]))!.removed_at === null; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const row = (await one('SELECT body, removed_at FROM community_suggestions WHERE thread_id = ?', [THREAD]))!;
    assert.notEqual(row.removed_at, null, logs.join('\n'));
    assert.equal(row.body, '');
    const page = await getPage('/suggestions');
    assert.doesNotMatch(page.body, /Deleted later|Some words/);
    report.stop();
  } finally {
    await exec("DELETE FROM oys_meta WHERE meta_key = 'community_pages'");
  }
});
