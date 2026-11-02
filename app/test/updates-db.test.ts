// Updates, Roadmap und Discord mit Datenbank: dieselben Schritte laufen einmal mit den PHP-Funktionen und einmal mit
// Node – jeweils vom selben Ausgangsstand. Verglichen werden die Ergebnisse, alle Tabellen (Discord-Einstellungen
// entschlüsselt), die Aufrufe bei der Discord-Attrappe (Methode, Pfad, Authorization, User-Agent, JSON) und das HTML
// der Seiten. Die Attrappe startet der Test selbst; mit OYS_DISCORD_MOCK=http://127.0.0.1:PORT läuft er stattdessen
// gegen eine schon laufende (z. B. discord_mock.py mit /__restart). Die PHP-Seite kommt aus der PHP-Version
// (support/phpRef.ts); ohne OYS_PHP_REF prüft nur der erste Test die Node-Seite allein.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { setConfigForTests, type ConfigData } from '../src/config.js';
import { exec } from '../src/db.js';
import { date, time } from '../src/php.js';
import { Ctx } from '../src/web/ctx.js';
import { adminUpdatesHandle } from '../src/updates/admin.js';
import { adminUpdatesView } from '../src/updates/adminView.js';
import { discordSettings } from '../src/updates/discord.js';
import { updatesFeed, updatesPage, updateLink } from '../src/updates/pages.js';
import { milestoneGet, milestones, taskGet, updateGet, updatePageOf, updatesCount, updatesList } from '../src/updates/updates.js';
import { startDiscordStandIn, GOOD_TOKEN, type StandIn } from './fixtures/updates/discordStandIn.js';
import { BASE_CONFIG, createTestEnv, loadFixture, normalizeNow, snapshot, type TestEnv } from './fixtures/updates/harness.js';
import { random } from './fixtures/updates/random.js';
import { PHP_SKIP, phpFile } from './support/phpRef.js';

let env: TestEnv;
let standIn: StandIn | null = null;
let apiBase = '';
let mockRoot = '';

type Fields = Record<string, unknown>;
interface Step { post?: Fields; mock?: string; sql?: string; call?: string; args?: unknown[] }
const post = (action: unknown, fields: Fields = {}): Step => ({ post: { oys_action: action, ...fields } });
const mock = (path: string): Step => ({ mock: path });
const sql = (q: string): Step => ({ sql: q });
const call = (fn: string, ...args: unknown[]): Step => ({ call: fn, args });

const TODAY = date('Y-m-d');
const hook = (id: string, base = apiBase): string => `${base}/webhooks/${id}/AbCdEfGhIjKlMnOpQrStUvWxYz0123`;
const CHANNEL = '1301234567890123456';

// Ausgangsstand: Meilensteine in allen Spalten, Aufgaben, veröffentlichte Updates, Entwürfe und Updates, die schon
// eine Discord-Nachricht haben (Webhook 123456 bzw. Bot-Kanal)
function fixture(): Record<string, Array<Record<string, unknown>>> {
  const ms = (id: number, title: string, status: string, position: number, extra: Fields = {}): Fields => ({
    id, title, description: '', status, target: '', position, is_public: 1, started_at: null, done_at: null,
    created_at: '2026-10-01 10:00:00', updated_at: '2026-10-02 10:00:00', ...extra,
  });
  const up = (id: number, title: string, extra: Fields = {}): Fields => ({
    id, title, body: '', version: '', category: 'new', milestone_id: null, is_published: 1, published_at: '2026-10-20 12:00:00', discord_announce: 1,
    discord_message_id: null, discord_target: null, created_at: '2026-10-19 10:00:00', updated_at: '2026-10-20 12:00:00', ...extra,
  });
  return {
    milestones: [
      ms(1, 'Custom domains', 'now', 1, { description: 'Use **your** domain', target: 'Q1 2027', started_at: '2026-10-20 10:00:00' }),
      ms(2, 'Faster editor', 'now', 2),
      ms(3, 'Themes', 'next', 1, { description: '- dark\n- light' }),
      ms(4, 'Secret', 'planned', 1, { is_public: 0 }),
      ms(5, 'QR codes', 'done', 1, { done_at: '2026-10-20 12:00:00' }),
      ms(6, 'Old feature', 'done', 2, { updated_at: '2026-09-01 10:00:00' }),
      ms(7, 'Weird', 'weird', 5),
      ms(8, 'Next two', 'next', 2),
      ms(9, 'Next three', 'next', 3),
    ],
    milestone_tasks: [
      ...[1, 2, 3, 4, 5, 6].map((i) => ({ id: i, milestone_id: 1, title: 'Task ' + i, is_done: i % 2, position: i, done_at: i % 2 ? '2026-10-21 10:00:00' : null })),
      { id: 7, milestone_id: 3, title: 'Pick colors', is_done: 0, position: 1, done_at: null },
      { id: 8, milestone_id: 3, title: 'Ship it', is_done: 1, position: 2, done_at: '2026-10-22 10:00:00' },
      { id: 9, milestone_id: 8, title: 'Only task', is_done: 0, position: 1, done_at: null },
    ],
    updates: [
      up(1, 'Launch', { body: '**Hello** [docs](/updates)', version: 'v2.0', milestone_id: 5 }),
      up(2, 'Weird category', { body: '- a\n- b', category: 'weird', published_at: '2026-10-21 09:00:00' }),
      up(3, 'Draft', { category: 'fixed', is_published: 0, published_at: null, discord_announce: 0 }),
      up(4, 'On Discord', { body: 'x', category: 'improved', published_at: '2026-10-22 08:00:00', discord_message_id: '1300000000000000050', discord_target: 'webhook:123456' }),
      up(5, 'Draft on Discord', { is_published: 0, published_at: '2026-10-10 10:00:00', discord_message_id: '1300000000000000051', discord_target: 'webhook:123456' }),
      up(6, 'Tie', { milestone_id: 1 }),
      up(7, 'Bot posted', { published_at: '2026-10-23 08:00:00', discord_message_id: '1300000000000000052', discord_target: 'bot:' + CHANNEL }),
      up(8, 'Bad message id', { published_at: '2026-10-24 08:00:00', discord_message_id: 'abc', discord_target: 'webhook:123456' }),
    ],
  };
}

// Viele veröffentlichte Updates für Seiten und Dauerlinks (Gleichstände bei published_at eingeschlossen)
function bigFixture(): Record<string, Array<Record<string, unknown>>> {
  const f = fixture();
  for (let i = 10; i < 50; i++) {
    const day = String(1 + (i % 28)).padStart(2, '0');
    f.updates.push({
      id: i, title: 'Update ' + i, body: i % 3 ? 'Body **' + i + '**' : '', version: i % 4 ? '' : 'v' + i, category: ['new', 'improved', 'fixed', 'news'][i % 4],
      milestone_id: i % 5 === 0 ? 5 : i % 7 === 0 ? 4 : null, is_published: i % 9 === 0 ? 0 : 1, published_at: `2026-09-${day} ${i % 2 ? '10:00:00' : '12:00:00'}`,
      discord_announce: 1, discord_message_id: null, discord_target: null, created_at: '2026-09-01 00:30:00', updated_at: i % 6 ? null : '2026-10-01 10:00:00',
    });
  }
  return f;
}

async function runSteps(side: 'php' | 'node', steps: Step[], base: string): Promise<unknown[]> {
  if (side === 'php') {
    return (await env.php(`$out = [];
      foreach ($in['steps'] as $s) {
        try {
          if (array_key_exists('post', $s)) { $out[] = ['r' => oys_admin_updates_handle($pdo, $s['post'])]; }
          elseif (isset($s['mock'])) { file_get_contents($in['mockRoot'] . $s['mock']); $out[] = ['r' => null]; }
          elseif (isset($s['sql'])) { $pdo->exec($s['sql']); $out[] = ['r' => null]; }
          else { $fn = $s['call']; $out[] = ['r' => $fn($pdo, ...($s['args'] ?? []))]; }
        } catch (Throwable $e) { $out[] = ['throw' => get_class($e)]; }
      }
      return $out;`, { steps, mockRoot }, base)) as unknown[];
  }
  setConfigForTests({ ...BASE_CONFIG, db: { ...(BASE_CONFIG.db as ConfigData), name: env.db }, discord_api_base: base });
  const calls: Record<string, (...a: never[]) => Promise<unknown>> = {
    oys_update_page_of: (id: number) => updatePageOf(id),
    oys_updates_list: (p: boolean, l: number, o: number) => updatesList(p, l, o),
    oys_updates_count: (p: boolean) => updatesCount(p),
    oys_update_get: (id: number) => updateGet(id),
    oys_milestones: (p: boolean) => milestones(p),
    oys_milestone_get: (id: number) => milestoneGet(id),
    oys_task_get: (id: number) => taskGet(id),
    oys_discord_settings: () => discordSettings(),
  };
  const out: unknown[] = [];
  for (const s of steps) {
    try {
      if (s.post !== undefined) out.push({ r: await adminUpdatesHandle(s.post) });
      else if (s.mock !== undefined) {
        await fetch(mockRoot + s.mock);
        out.push({ r: null });
      } else if (s.sql !== undefined) {
        await exec(s.sql);
        out.push({ r: null });
      } else out.push({ r: await calls[s.call as string](...((s.args ?? []) as never[])) });
    } catch (e) {
      out.push({ throw: (e as Error).constructor.name });
    }
  }
  return out;
}

// Ein Ablauf von beiden Seiten aus demselben Stand; Rückgabe für weitere Prüfungen
async function same(steps: Step[], opts: { fixture?: () => Record<string, Array<Record<string, unknown>>>; base?: string } = {}): Promise<{ results: unknown[]; log: unknown[] }> {
  const base = opts.base ?? apiBase;
  const runs: Record<string, { results: string; log: string; snap: string; raw: unknown[]; rawLog: unknown[] }> = {};
  for (const side of ['php', 'node'] as const) {
    await loadFixture(env, (opts.fixture ?? fixture)());
    await fetch(mockRoot + '/__restart');
    const from = time();
    const raw = await runSteps(side, steps, base);
    const to = time();
    const rawLog = (await (await fetch(mockRoot + '/__log')).json()) as unknown[];
    runs[side] = {
      results: normalizeNow(JSON.stringify(raw, null, 1), from, to),
      log: normalizeNow(JSON.stringify(rawLog, null, 1), from, to),
      snap: normalizeNow(await snapshot(env), from, to),
      raw,
      rawLog,
    };
  }
  assert.equal(runs.node.results, runs.php.results, 'results');
  assert.equal(runs.node.log, runs.php.log, 'requests to Discord');
  assert.equal(runs.node.snap, runs.php.snap, 'database');
  return { results: runs.php.raw, log: runs.php.rawLog };
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

before(async () => {
  const external = process.env.OYS_DISCORD_MOCK;
  if (external) {
    mockRoot = external.replace(/\/+$/, '');
  } else {
    standIn = await startDiscordStandIn();
    mockRoot = standIn.root;
  }
  apiBase = mockRoot + '/api';
  // Eigene Datenbank je Arbeitsordner (Name der konfigurierten Datenbank + _upd), damit sich Testläufe nicht stören
  env = await createTestEnv(String((BASE_CONFIG.db as ConfigData | undefined)?.name ?? 'oys_test') + '_upd', apiBase);
});

after(async () => {
  await env?.close();
  await standIn?.close();
});

// Nur Node, vom selben Ausgangsstand: Ergebnisse und Aufrufe bei der Discord-Attrappe
async function nodeOnly(steps: Step[]): Promise<{ results: unknown[]; log: Array<{ method: string; path: string; body: unknown }> }> {
  await loadFixture(env, fixture());
  await fetch(mockRoot + '/__restart');
  const results = await runSteps('node', steps, apiBase);
  return { results, log: (await (await fetch(mockRoot + '/__log')).json()) as Array<{ method: string; path: string; body: unknown }> };
}

test('updates, the roadmap and the Discord webhook work in Node on their own', async () => {
  const { results, log } = await nodeOnly([
    post('discord_save', { mode: 'webhook', webhook_url: hook('123456'), username: 'OnYourSite Updates', auto_post: '1' }),
    post('update_save', { title: 'New thing', body: '**x**', version: 'v2.5', category: 'new', publish: '1', announce_field: '1', post_discord: '1', date: TODAY, date_default: TODAY }),
    post('update_save', { id: '9', title: 'New thing, edited', body: 'changed', publish: '1', announce_field: '1', date: TODAY, date_default: TODAY }),
    call('oys_update_get', 9),
    post('update_delete', { id: '9' }),
    call('oys_update_get', 9),
    post('milestone_save', { title: 'Next big thing', status: 'next', tasks: 'One\n[x] Two' }),
    call('oys_milestones', false),
  ]);
  const r = results as Array<{ r: unknown }>;
  assert.deepEqual(r[0], { r: { tab: 'discord', ok: 'Discord settings saved.' } });
  assert.deepEqual(r[1], { r: { tab: 'updates', ok: 'Update published. It was posted to Discord.' } });
  assert.deepEqual(r[2], { r: { tab: 'updates', ok: 'Update published. The Discord post was updated too.' } });
  const saved = r[3].r as Fields;
  assert.deepEqual([saved.title, saved.body, saved.is_published, saved.discord_message_id, saved.discord_target],
    ['New thing, edited', 'changed', true, '1300000000000000001', 'webhook:123456']);
  assert.deepEqual(r.slice(4, 7), [{ r: { tab: 'updates', ok: 'Update deleted.' } }, { r: null }, { r: { tab: 'roadmap', ok: 'Milestone added.' } }]);
  const added = (r[7].r as Array<{ title: string; tasks: Array<{ title: string; is_done: boolean }>; progress: unknown }>).find((m) => m.title === 'Next big thing');
  assert.deepEqual(added?.tasks.map((t) => [t.title, t.is_done]), [['One', false], ['Two', true]]);
  assert.deepEqual(added?.progress, { done: 1, total: 2, percent: 50 });
  // Discord: neu, bearbeitet, gelöscht – über denselben Webhook, dieselbe Nachricht
  const path = new URL(hook('123456')).pathname.replace('/api/', '/api/v10/');
  assert.deepEqual(log.map((l) => [l.method, l.path]), [['POST', path + '?wait=true'], ['PATCH', path + '/messages/1300000000000000001'],
    ['DELETE', path + '/messages/1300000000000000001']]);
  const sent = log[0].body as { username?: string; embeds?: Array<{ title?: string }> };
  assert.equal(sent.username, 'OnYourSite Updates');
  assert.match(String(sent.embeds?.[0]?.title), /New thing/);
});

test('updates: saving, dates, versions and validation like PHP', { skip: PHP_SKIP }, async () => {
  const { results } = await same([
    post('update_save', { title: '' }),
    post('update_save', { id: '1', title: '   ' }),
    post('update_save', { title: 'New', body: 'b\r\n\r\n\r\n\r\nc\x01 \u{202E}x', version: 'v2.0-beta_1 \u{2728} \u{BD} \u{B2} \u{1E4F0}\u{11F50} \u{E9}t\u{E9}', category: 'new', milestone_id: '3', publish: '1', date: TODAY, date_default: TODAY }),
    post('update_save', { title: 'Past', publish: '1', date: '2026-10-05', date_default: TODAY }),
    post('update_save', { title: 'Invalid', date: '2026-02-30', date_default: TODAY }),
    post('update_save', { title: 'Leap', date: '2024-02-29', date_default: TODAY, publish: '1' }),
    post('update_save', { title: 'Future', date: '2999-01-01', date_default: TODAY }),
    post('update_save', { title: 'Format', date: '1.10.2026', date_default: TODAY }),
    post('update_save', { title: 'Year zero', date: '0000-01-01' }),
    post('update_save', { title: 'Spaces', date: '  2026-10-07  ', date_default: TODAY, publish: '1' }),
    post('update_save', { title: 'Today changed', publish: '', date: TODAY, date_default: '2026-10-01' }),
    post('update_save', { id: '1', title: 'Launch edited', publish: '1', date: '2026-10-20', date_default: '2026-10-20' }),
    post('update_save', { id: '1', title: 'Launch', publish: '1', date: '2026-10-20', date_default: '2026-10-19' }),
    post('update_save', { id: '6', title: 'Moved', publish: '1', date: '2026-10-01', date_default: '2026-10-20' }),
    post('update_save', { title: 'Weird category', category: 'bogus', milestone_id: '999', publish: '1' }),
    post('update_save', { title: 'Array category', category: ['x'] }),
    post('update_save', { title: ['array title'] }),
    post('update_save', { id: '999', title: 'Ghost' }),
    post('update_save', { title: 'Announce off', announce_field: '1' }),
    post('update_save', { id: '3', title: 'Draft kept', publish: '' }),
    post('update_save', { title: 'x'.repeat(200), body: 'y'.repeat(20010), version: 'v'.repeat(50), milestone_id: '1e3' }),
    post('update_save', { title: '\u{202E}bidi\u{202A} \t tab', body: 'a\r\nb', publish: '0' }),
    post('update_save', { title: 'Date array', date: ['2026-10-01'] }),
    post('update_save', { id: '2', title: 'Milestone array', milestone_id: ['5'], publish: 'yes', date: '', date_default: '2026-10-21' }),
    call('oys_update_get', 1), call('oys_update_get', 999), call('oys_updates_count', true), call('oys_updates_count', false),
  ]);
  assert.deepEqual(results[0], { r: { tab: 'updates', error: 'Please enter a title.', query: '' } });
  assert.deepEqual(results[15], { throw: 'TypeError' });
});

test('updates: publishing, drafts and deleting without Discord like PHP', { skip: PHP_SKIP }, async () => {
  await same([
    post('update_publish', { id: '3', state: '1' }),
    post('update_publish', { id: '1', state: '' }),
    post('update_publish', { id: '999', state: '1' }),
    post('update_publish', { id: '5', state: '' }),
    post('update_discord', { id: '3' }),
    post('update_discord', { id: '999' }),
    post('update_discord', { id: '1' }),
    post('update_discord_remove', { id: '1' }),
    post('update_discord_remove', { id: '4' }),
    post('update_delete', { id: '999' }),
    post('update_delete', { id: '2' }),
    post('update_delete', { id: '4' }),
    post('update_save', { id: '7', title: 'Bot posted', publish: '1' }),
    post('update_save', { id: '5', title: 'Draft on Discord', publish: '' }),
    post('update_publish', { id: '6', state: ['1'] }),
    post('update_save', { id: '6', title: 'Tie', publish: '1', post_discord: '1' }),
  ]);
});

test('roadmap: milestones and tasks like PHP', { skip: PHP_SKIP }, async () => {
  const tasks = 'Design the page\r\n- [x] Done thing\n* [ ] open\n\u{2022} [X] bullet done\n[] empty box\nPolish \u{105} task\n\u{C5}ngstr\u{F6}m\nnormal\x0Bvt\n   \n'
    + 'x'.repeat(250) + '\n\u{2028}sep\n\t[x]\ttabbed\n';
  await same([
    post('milestone_save', { title: '' }),
    post('milestone_save', { id: '1', title: '' }),
    post('milestone_save', { title: 'New now', status: 'now', target: 'Q2 2027', description: 'd\r\n\r\n\r\nx', is_public: '1', tasks }),
    post('milestone_save', { title: 'New done', status: 'done', is_public: '1' }),
    post('milestone_save', { title: 'Bad status', status: 'nope', target: 't'.repeat(50) }),
    post('milestone_save', { title: 'Array status', status: ['now'] }),
    post('milestone_save', { id: '3', title: 'Themes v2', status: 'now', is_public: '1', tasks: '[x] added done\nnew task' }),
    post('milestone_save', { id: '1', title: 'Custom domains', status: 'now', is_public: '' }),
    post('milestone_save', { id: '999', title: 'Ghost milestone', status: 'planned' }),
    post('milestone_save', { title: 'Tasks array', tasks: ['a'] }),
    post('milestone_status', { id: '3', status: 'done' }),
    post('milestone_status', { id: '3', status: 'done' }),
    post('milestone_status', { id: '999', status: 'now' }),
    post('milestone_status', { id: '2', status: 'bogus' }),
    post('milestone_status', { id: '2', status: ['now'] }),
    post('milestone_status', { id: '5', status: 'now' }),
    post('milestone_move', { id: '8', dir: 'up' }),
    post('milestone_move', { id: '9', dir: 'up' }),
    post('milestone_move', { id: '9', dir: 'down' }),
    post('milestone_move', { id: '9', dir: 'sideways' }),
    post('milestone_move', { id: '6', dir: 'up' }),
    post('milestone_move', { id: '999', dir: 'up' }),
    post('milestone_move', { id: '7', dir: 'down' }),
    post('milestone_move', { id: '4', dir: 'up' }),
    post('task_add', { id: '1', title: 'Another task' }),
    post('task_add', { id: '1', title: '   ' }),
    post('task_add', { id: '999', title: 'x' }),
    post('task_add', { id: '1', title: '\x01' }),
    post('task_add', { id: '1', title: ['a'] }),
    post('task_add', { id: '2', title: ' \u{E4}'.repeat(150) }),
    post('task_toggle', { id: '1' }),
    post('task_toggle', { id: '2' }),
    post('task_delete', { id: '3' }),
    post('task_toggle', { id: '999' }),
    post('task_delete', { id: '999' }),
    // „Shipped“ ist nach done_at sortiert: zwei Meilensteine, die in diesem Lauf fertig wurden, stünden sonst je nach
    // Sekundenwechsel in anderer Reihenfolge – darum bekommen beide denselben festen Zeitpunkt
    sql("UPDATE milestones SET done_at = '2026-10-31 12:00:00' WHERE done_at > '2026-10-21 00:00:00'"),
    call('oys_task_get', 1), call('oys_task_get', 999), call('oys_milestone_get', 1), call('oys_milestone_get', 999),
    call('oys_milestones', true), call('oys_milestones', false),
    post('milestone_delete', { id: '1' }),
    post('milestone_delete', { id: '999' }),
    post('nope'),
    post(['update_save']),
    { post: {} },
  ]);
});

test('reading updates, pages and permalinks like PHP', { skip: PHP_SKIP }, async () => {
  const ids = [...Array(50).keys()];
  await same([
    ...ids.map((id) => call('oys_update_page_of', id)),
    call('oys_updates_list', true, 15, 0), call('oys_updates_list', true, 15, 15), call('oys_updates_list', true, 15, 30), call('oys_updates_list', true, 15, 45),
    call('oys_updates_list', false, 300, 0), call('oys_updates_list', true, 0, -5), call('oys_updates_count', true), call('oys_updates_count', false),
    call('oys_milestones', true), call('oys_milestones', false),
  ], { fixture: bigFixture });
});

test('Discord settings: validation, storage and odd stored values like PHP', { skip: PHP_SKIP }, async () => {
  await same([
    post('discord_save', { mode: 'webhook', webhook_url: 'https://discord.com/channels/123456789012345678/123456789012345678' }),
    call('oys_discord_settings'),
    post('discord_save', { mode: 'webhook', webhook_url: ' ' + hook('123456') + '\n', username: 'OnYourSite Updates', avatar_url: 'https://x.y/logo.png', mention: '@everyone', invite_url: 'discord.gg/abc', auto_post: '1' }),
    call('oys_discord_settings'),
    post('discord_save', { mode: 'webhook', webhook_url: '', username: 'admin@test.de', mention: '', invite_url: 'http://insecure.example', avatar_url: 'http://x.y/a.png', auto_post: '' }),
    call('oys_discord_settings'),
    post('discord_save', { username: 'My Discord News' }),
    post('discord_save', { username: 'CLYDE bot' }),
    post('discord_save', { mention: '@someone' }),
    post('discord_save', { mention: '<@&1301234567890123457>', username: '\u{1F41D} News \u{E4}' }),
    call('oys_discord_settings'),
    post('discord_save', { mention: ' 1301234567890123457\n' }),
    call('oys_discord_settings'),
    post('discord_save', { mention: 'HERE' }),
    post('discord_save', { mode: 'bot', bot_token: 'short' }),
    post('discord_save', { mode: 'bot', bot_token: GOOD_TOKEN, channel_id: '12345' }),
    post('discord_save', { mode: 'bot', bot_token: GOOD_TOKEN, channel_id: '' }),
    call('oys_discord_settings'),
    post('discord_save', { mode: 'bot', bot_token: '', channel_id: CHANNEL }),
    call('oys_discord_settings'),
    post('discord_save', { mode: 'webhook', webhook_url: ['x'] }),
    post('discord_save', { mode: ['bot'], invite_url: 'HTTPS://Discord.gg/x', auto_post: '0' }),
    call('oys_discord_settings'),
    post('discord_save', { invite_url: 'javascript:alert(1)', avatar_url: 'HTTPS://cdn.example/a b.png' }),
    call('oys_discord_settings'),
    post('discord_disconnect'),
    call('oys_discord_settings'),
    sql("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('discord', 'ENC:garbage')"),
    call('oys_discord_settings'),
    sql("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('discord', '[1,2]')"),
    call('oys_discord_settings'),
    sql(`REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('discord', '{"mode":"bot","extra":1,"bot_token":"${GOOD_TOKEN}","channel_id":"${CHANNEL}"}')`),
    call('oys_discord_settings'),
    post('discord_save', { mode: 'bot' }),
    post('discord_test'),
  ]);
});

test('Discord webhook: announce, sync and remove send the same requests as PHP', { skip: PHP_SKIP }, async () => {
  const { log } = await same([
    post('discord_test'),
    post('discord_save', { mode: 'webhook', webhook_url: hook('123456'), username: 'OnYourSite Updates', avatar_url: 'https://x.y/logo.png', mention: '@everyone', invite_url: 'discord.gg/abc', auto_post: '1' }),
    post('discord_test'),
    post('update_save', { title: 'New thing', body: '**x** and [docs](/updates#roadmap)\n- one', version: 'v2.5', category: 'new', publish: '1', announce_field: '1', post_discord: '1', date: TODAY, date_default: TODAY }),
    post('update_save', { id: '9', title: 'New thing, edited', body: 'changed', version: '2.5.1', category: 'fixed', publish: '1', announce_field: '1', date: '2026-10-30', date_default: TODAY }),
    post('update_publish', { id: '9', state: '' }),
    post('update_publish', { id: '9', state: '1' }),
    post('update_discord', { id: '9' }),
    post('update_discord_remove', { id: '9' }),
    post('update_discord_remove', { id: '9' }),
    post('update_save', { title: 'Silent draft', publish: '', announce_field: '1', post_discord: '1' }),
    post('update_publish', { id: '10', state: '1' }),
    post('update_save', { title: 'Opted out', publish: '1', announce_field: '1' }),
    post('update_publish', { id: '11', state: '' }),
    post('update_publish', { id: '11', state: '1' }),
    post('update_discord', { id: '11' }),
    post('update_save', { id: '11', title: 'Opted out, now a draft', publish: '' }),
    post('update_delete', { id: '9' }),
    post('update_delete', { id: '10' }),
    post('update_save', { title: 'L'.repeat(150), body: 'w\u{E4}rd '.repeat(900), version: 'v9', publish: '1', post_discord: '1', announce_field: '1' }),
    post('update_save', { id: '1', title: 'Launch', publish: '1', post_discord: '1', announce_field: '1' }),
    post('discord_disconnect'),
  ]);
  assert.ok(log.length >= 10, 'the flow talked to Discord');
});

test('Discord webhook: deleted posts, other webhooks and failures like PHP', { skip: PHP_SKIP }, async () => {
  await same([
    post('discord_save', { mode: 'webhook', webhook_url: hook('123456'), mention: '1301234567890123457', auto_post: '1' }),
    post('update_save', { id: '4', title: 'On Discord', publish: '1' }),
    post('update_discord', { id: '4' }),
    post('update_save', { id: '8', title: 'Bad message id', publish: '1' }),
    post('update_discord', { id: '1' }),
    mock('/__forget'),
    post('update_save', { id: '1', title: 'Launch again', publish: '1' }),
    post('update_discord', { id: '1' }),
    post('discord_save', { mode: 'webhook', webhook_url: hook('654321'), auto_post: '1' }),
    post('update_save', { id: '1', title: 'Launch three', publish: '1' }),
    post('update_discord', { id: '1' }),
    mock('/__fail=500'),
    post('update_save', { id: '1', title: 'Launch four', publish: '1' }),
    mock('/__fail=503'),
    post('update_delete', { id: '1' }),
    mock('/__fail=403'),
    post('update_publish', { id: '1', state: '' }),
    post('update_publish', { id: '1', state: '1' }),
    mock('/__fail=429'),
    post('update_discord', { id: '2' }),
    mock('/__fail=403'),
    post('update_delete', { id: '1' }),
    mock('/__fail=401'),
    post('update_discord', { id: '2' }),
    mock('/__fail=404'),
    post('update_discord', { id: '6' }),
    mock('/__fail=418'),
    post('discord_test'),
    post('discord_save', { mode: 'webhook', webhook_url: hook('4041234') }),
    post('update_discord', { id: '6' }),
    sql("UPDATE updates SET discord_message_id = '1300000000000000077', discord_target = 'webhook:4041234' WHERE id = 6"),
    post('update_save', { id: '6', title: 'Tie', publish: '1' }),
    sql("UPDATE updates SET discord_message_id = '1300000000000000078', discord_target = 'webhook:4041234' WHERE id = 6"),
    post('update_delete', { id: '6' }),
    post('discord_save', { mode: 'webhook', webhook_url: hook('4011234') }),
    post('update_discord', { id: '2' }),
    post('discord_test'),
    post('discord_save', { mode: 'webhook', webhook_url: hook('4291234') }),
    post('update_discord', { id: '2' }),
    sql("UPDATE updates SET discord_message_id = '1300000000000000079', discord_target = 'webhook:4291234' WHERE id = 2"),
    post('update_delete', { id: '2' }),
    post('discord_disconnect'),
    post('update_save', { id: '7', title: 'Bot posted', publish: '1' }),
    post('update_publish', { id: '7', state: '' }),
    post('update_delete', { id: '7' }),
  ]);
});

test('Discord bot: announce, sync, remove and its errors like PHP', { skip: PHP_SKIP }, async () => {
  await same([
    post('discord_save', { mode: 'bot', bot_token: GOOD_TOKEN, channel_id: CHANNEL, mention: '<@&1301234567890123457>', username: 'not used for bots', avatar_url: 'https://x.y/a.png', auto_post: '1' }),
    post('update_save', { title: 'Bot news', body: 'Hello **bot**', publish: '1', announce_field: '1', post_discord: '1' }),
    post('update_save', { id: '9', title: 'Bot news, edited', publish: '1' }),
    post('update_save', { id: '7', title: 'Bot posted', publish: '1' }),
    post('update_publish', { id: '9', state: '' }),
    post('update_publish', { id: '9', state: '1' }),
    post('discord_test'),
    post('update_discord_remove', { id: '9' }),
    post('discord_save', { mode: 'bot', bot_token: '', channel_id: '4031234567890123456' }),
    post('update_discord', { id: '9' }),
    post('update_save', { id: '9', title: 'Other channel', publish: '1' }),
    post('discord_save', { mode: 'bot', bot_token: 'x'.repeat(72), channel_id: CHANNEL }),
    post('update_discord', { id: '2' }),
    post('discord_test'),
    post('discord_save', { mode: 'bot', bot_token: GOOD_TOKEN, channel_id: '' }),
    post('update_save', { title: 'Not ready', publish: '1', announce_field: '1', post_discord: '1' }),
    post('update_publish', { id: '6', state: '1' }),
    post('discord_test'),
  ]);
});

test('Discord: a stored message ID with a line break is never sent, like curl in PHP', { skip: PHP_SKIP }, async () => {
  // /^\d{5,25}$/ lässt in PHP ein \n am Ende durch; curl lehnt die Adresse dann ab – nichts wird geändert oder gelöscht
  await same([
    post('discord_save', { mode: 'webhook', webhook_url: hook('123456'), auto_post: '1' }),
    sql("UPDATE updates SET discord_message_id = '1300000000000000050\\n' WHERE id = 4"),
    post('update_save', { id: '4', title: 'On Discord, edited', publish: '1' }),
    post('update_discord', { id: '4' }),
    post('update_publish', { id: '4', state: '' }),
    post('update_discord_remove', { id: '4' }),
    post('update_delete', { id: '4' }),
  ]);
});

test('Discord unreachable: the same message (curl wording) as PHP', { skip: PHP_SKIP }, async () => {
  const closed = `http://127.0.0.1:${await freePort()}/api`;
  await same([
    post('discord_save', { mode: 'webhook', webhook_url: hook('123456', closed), auto_post: '1' }),
    post('discord_test'),
    post('update_discord', { id: '1' }),
    post('update_save', { id: '4', title: 'On Discord', publish: '1' }),
    post('update_delete', { id: '4' }),
  ], { base: closed });
});

// Zufällige Folgen von Admin-Aktionen mit Grenzwerten in allen Feldern (leer, Leerraum, Zahlen als Text, Arrays,
// Unicode, Daten, feindliche Adressen, Discord-Einstellungen, erzwungene Fehler bei Discord) – Ergebnis, Tabellen und
// Aufrufe bei Discord wie in PHP
test('random admin action sequences behave like PHP', { skip: PHP_SKIP }, async () => {
  const rnd = random(20261102);
  const pick = <T>(list: readonly T[]): T => list[rnd(list.length)];
  const texts = ['', ' ', '0', '1', 'yes', 'abc', '  padded  ', '\u{E4}\u{F6}\u{FC}', '\u{1F41D} bee', '<b>&"\'', 'a\r\nb\r\n\r\n\r\nc', '\u{202E}rtl\u{2066}',
    '9'.repeat(30), '-1', '1e3', ' 2 ', 'x'.repeat(170), '\t\n', '- [x] done\n* [ ] open\n\u{2022} [X] dot\nPolish \u{105}', '**bold** [l](/updates#roadmap)'];
  const values: unknown[] = [...texts, ['x'], [], undefined, undefined];
  const ids = ['', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '999', 'abc', ' 3', '3abc', ['4']];
  const dates = ['', TODAY, '2026-10-05', '2026-02-29', '2024-02-29', '2999-12-31', '0000-00-00', '2026-1-5', ' 2026-10-07 ', 'yesterday', ['2026-10-01']];
  const field = (list: readonly unknown[]): unknown => pick(list);
  const maybe = (f: Fields, key: string, list: readonly unknown[]): void => {
    const v = field(list);
    if (v !== undefined && rnd(5) > 0) f[key] = v;
  };
  const step = (): Step => {
    const action = pick(['update_save', 'update_save', 'update_save', 'update_publish', 'update_discord', 'update_discord_remove', 'update_delete', 'milestone_save',
      'milestone_save', 'milestone_status', 'milestone_move', 'milestone_delete', 'task_add', 'task_toggle', 'task_delete', 'discord_save', 'discord_save', 'discord_test',
      'discord_disconnect', 'mock', 'nope'] as const);
    if (action === 'mock') return mock(pick(['/__fail=500', '/__fail=429', '/__fail=404', '/__fail=403', '/__forget']));
    const f: Fields = {};
    maybe(f, 'id', ids);
    if (action === 'update_save') {
      maybe(f, 'title', [...values, 'Release notes', 'Fix', 'Fix']);
      maybe(f, 'body', values);
      maybe(f, 'version', [...values, 'v2.4', '2.4.1-beta_2', 'V3 \u{1E4F0}']);
      maybe(f, 'category', ['new', 'improved', 'fixed', 'news', 'bogus', '', 'constructor', ['new']]);
      maybe(f, 'milestone_id', ids);
      maybe(f, 'publish', ['1', '', '0', 'yes', ['1']]);
      maybe(f, 'announce_field', ['1', '', '0']);
      maybe(f, 'post_discord', ['1', '', '0']);
      maybe(f, 'date', dates);
      maybe(f, 'date_default', dates);
    } else if (action === 'update_publish') {
      maybe(f, 'state', ['1', '', '0', ['1']]);
    } else if (action === 'milestone_save') {
      maybe(f, 'title', [...values, 'Custom domains', 'Themes']);
      maybe(f, 'description', values);
      maybe(f, 'status', ['now', 'next', 'planned', 'done', 'bogus', '', '__proto__', ['now']]);
      maybe(f, 'target', values);
      maybe(f, 'is_public', ['1', '', '0']);
      maybe(f, 'tasks', values);
    } else if (action === 'milestone_status') {
      maybe(f, 'status', ['now', 'next', 'planned', 'done', 'bogus', '', ['done']]);
    } else if (action === 'milestone_move') {
      maybe(f, 'dir', ['up', 'down', 'UP', '', ['up']]);
    } else if (action === 'task_add') {
      maybe(f, 'title', values);
    } else if (action === 'discord_save') {
      maybe(f, 'mode', ['webhook', 'bot', 'BOT', '', ['bot']]);
      maybe(f, 'webhook_url', ['', ' ', hook('123456'), hook('654321') + '\n', hook('4041234'), 'https://discord.com/api/webhooks/12/short', ['x']]);
      maybe(f, 'bot_token', ['', GOOD_TOKEN, 'x'.repeat(72), 'short']);
      maybe(f, 'channel_id', ['', CHANNEL, '4031234567890123456', '123', ' ' + CHANNEL + ' ']);
      maybe(f, 'mention', ['', 'everyone', '@here', 'HERE', '<@&1301234567890123457>', ' 1301234567890123457\n', 'someone']);
      maybe(f, 'username', ['', 'News', 'My Discord', 'clyde', '\u{1F41D} \u{E4}']);
      maybe(f, 'avatar_url', ['', 'https://x.y/a.png', 'http://x.y/a.png', 'HTTPS://x.y/a b.png', 'javascript:x']);
      maybe(f, 'invite_url', ['', 'https://discord.gg/x', 'discord.gg/abc', 'http://x.y', 'javascript:x']);
      maybe(f, 'auto_post', ['1', '', '0']);
    }
    return post(action, f);
  };
  for (let run = 0; run < 4; run++) {
    const steps = [post('discord_save', { mode: 'webhook', webhook_url: hook('123456'), auto_post: '1' }), ...Array.from({ length: 45 }, step)];
    await same(steps);
  }
});

// ------------------------------------------------------------------ Seiten

async function sessionCtx(url: string, csrf: string): Promise<Ctx> {
  const id = 'updatestest' + Math.random().toString(36).slice(2).padEnd(14, '0');
  await exec('INSERT INTO oys_sessions (id, data, last_seen) VALUES (?, ?, ?)', [id, JSON.stringify({ csrf }), time()]);
  return new Ctx({ method: 'GET', url, headers: { host: 'oys.test:8080', cookie: 'PHPSESSID=' + id }, peer: '127.0.0.1' });
}

test('admin view: the HTML of admin_updates.php for every state', { skip: PHP_SKIP }, async () => {
  const csrf = 'c'.repeat(64);
  const variants: Array<{ get: Record<string, string>; setup: Step[] }> = [
    { get: {}, setup: [] },
    { get: { edit_update: '1' }, setup: [] },
    { get: { edit_update: '3' }, setup: [post('discord_save', { mode: 'webhook', webhook_url: hook('123456'), auto_post: '' })] },
    { get: { edit_update: '4' }, setup: [post('discord_save', { mode: 'webhook', webhook_url: hook('123456'), auto_post: '1', username: 'A "quoted" <name>', mention: 'here', invite_url: 'https://discord.gg/x' })] },
    { get: { edit_update: '7', edit_milestone: '1' }, setup: [post('discord_save', { mode: 'bot', bot_token: GOOD_TOKEN, channel_id: CHANNEL })] },
    { get: { edit_update: '999', new_update_for: '3' }, setup: [post('discord_save', { mode: 'bot', bot_token: GOOD_TOKEN, channel_id: '' })] },
    { get: { new_update_for: '1' }, setup: [post('discord_save', { mode: 'webhook', webhook_url: hook('123456'), auto_post: '1' })] },
    { get: { edit_milestone: '4', edit_update: 'abc' }, setup: [] },
    { get: { edit_milestone: '999', new_update_for: '' }, setup: [sql('DELETE FROM updates'), sql('DELETE FROM milestones')] },
    { get: { edit_update: '5' }, setup: [post('discord_save', { mode: 'webhook', webhook_url: hook('123456'), auto_post: '1' }), sql("UPDATE updates SET version = 'V3.1', title = '<b>x</b> & ''y''' WHERE id = 5")] },
  ];
  for (const v of variants) {
    const html: Record<string, string> = {};
    for (const side of ['php', 'node'] as const) {
      await loadFixture(env, fixture());
      await runSteps(side, v.setup, apiBase);
      if (side === 'php') {
        html.php = (await env.php(`$_GET = $in['get']; $_SESSION = ['csrf' => $in['csrf']]; ob_start(); require '${phpFile('views/admin_updates.php')}'; return ob_get_clean();`,
          { get: v.get, csrf })) as string;
      } else {
        const query = new URLSearchParams(v.get).toString();
        const ctx = await sessionCtx('/admin' + (query ? '?' + query : ''), csrf);
        html.node = await adminUpdatesView(ctx);
        await ctx.session?.close();
      }
    }
    assert.equal(html.node, html.php, JSON.stringify(v.get));
  }
});

test('public pages: /updates, the feed and permalinks render the same HTML as PHP', { skip: PHP_SKIP }, async () => {
  const user = { id: 5, email: 'mia@test.de', full_name: 'Mia', is_admin: 0 };
  const cases: Array<{ url: string; user: unknown; fixture: () => Record<string, Array<Record<string, unknown>>>; setup?: Step[] }> = [
    { url: '/updates', user: null, fixture },
    { url: '/updates', user, fixture, setup: [post('discord_save', { mode: 'webhook', webhook_url: hook('123456'), invite_url: 'https://discord.gg/abc?x=1&y=2' })] },
    { url: '/updates?page=2', user: null, fixture: bigFixture },
    { url: '/updates?page=3', user, fixture: bigFixture },
    { url: '/updates?page=99', user: null, fixture: bigFixture },
    { url: '/updates?page=0', user: null, fixture: bigFixture },
    { url: '/updates?page=-2', user: null, fixture: bigFixture },
    { url: '/updates?page=abc', user: null, fixture: bigFixture },
    { url: '/updates?page=2.9', user: null, fixture: bigFixture },
    { url: '/updates?page=1e400', user: null, fixture: bigFixture },
    { url: '/updates?page[]=3', user: null, fixture: bigFixture },
    { url: '/updates', user: null, fixture: () => ({ updates: [], milestones: [], milestone_tasks: [] }) },
    { url: '/updates', user: null, fixture: () => ({ ...fixture(), milestones: fixture().milestones.filter((m) => m.status === 'done') }) },
    { url: '/updates', user: null, fixture: () => ({ ...fixture(), milestones: fixture().milestones.filter((m) => m.status !== 'done') }) },
  ];
  for (const c of cases) {
    const html: Record<string, string> = {};
    for (const side of ['php', 'node'] as const) {
      await loadFixture(env, c.fixture());
      await runSteps(side, c.setup ?? [], apiBase);
      const get = Object.fromEntries(new URLSearchParams(c.url.split('?')[1] ?? ''));
      if (side === 'php') {
        html.php = (await env.php(`$user_data = $in['user']; $_GET = $in['get']; ob_start(); require '${phpFile('views/updates.php')}'; return ob_get_clean();`,
          { user: c.user, get: c.url.includes('page[]') ? { page: ['3'] } : get })) as string;
      } else {
        const ctx = new Ctx({ method: 'GET', url: c.url, headers: { host: 'oys.test:8080' }, peer: '127.0.0.1' });
        await updatesPage(ctx, c.user as never);
        html.node = String(ctx.body);
      }
    }
    assert.equal(html.node, html.php, c.url);
  }
  for (const f of [fixture, bigFixture, () => ({ updates: [], milestones: [], milestone_tasks: [] })]) {
    const xml: Record<string, string> = {};
    for (const side of ['php', 'node'] as const) {
      await loadFixture(env, f());
      if (side === 'php') {
        xml.php = (await env.php(`ob_start(); require '${phpFile('views/updates_feed.php')}'; return ob_get_clean();`)) as string;
      } else {
        const ctx = new Ctx({ method: 'GET', url: '/updates/feed.xml', headers: { host: 'oys.test:8080' }, peer: '127.0.0.1' });
        await updatesFeed(ctx);
        assert.equal(ctx.header('Content-Type'), 'application/atom+xml; charset=utf-8');
        assert.equal(ctx.header('Cache-Control'), 'public, max-age=600');
        xml.node = String(ctx.body);
      }
    }
    // Ohne Updates steht die aktuelle Zeit im Feed – sie darf sich um eine Sekunde unterscheiden
    assert.equal(normalizeNow(xml.node, time() - 5, time()), normalizeNow(xml.php, time() - 5, time()));
  }
  // Dauerlinks: dieselbe Weiterleitung wie routes_app.php
  await loadFixture(env, bigFixture());
  for (const id of [1, 2, 3, 10, 11, 18, 27, 40, 49, 999, 0]) {
    const ctx = new Ctx({ method: 'GET', url: '/updates/' + id, headers: { host: 'oys.test:8080' }, peer: '127.0.0.1' });
    await updateLink(ctx, id).catch(() => undefined);
    const pageNo = (await env.php('return oys_update_page_of($pdo, $in);', id)) as number | null;
    assert.equal(ctx.status, 302);
    assert.equal(ctx.header('Location'), pageNo === null ? '/updates' : '/updates' + (pageNo > 1 ? '?page=' + pageNo : '') + '#update-' + id);
  }
});

// Zufällige Datenbestände: Meilensteine in allen Spalten (auch unbekannter Status, versteckt, mit und ohne Aufgaben,
// um die Grenze von 5 sichtbaren Aufgaben), Updates als Entwurf, ohne Datum, mit unbekannter Kategorie, mit fehlendem
// oder verstecktem Meilenstein; mit discord = true haben manche Updates schon eine Nachricht in Discord
function randomData(rnd: (n: number) => number, discord = false): Record<string, Fields[]> {
  const pick = <T>(list: readonly T[]): T => list[rnd(list.length)];
  const day = (): string => `202${5 + rnd(2)}-${String(1 + rnd(9)).padStart(2, '0')}-${String(1 + rnd(28)).padStart(2, '0')} ${pick(['00:30:00', '12:00:00', '23:59:59', '02:30:00'])}`;
  const maybeDay = (): string | null => (rnd(4) ? day() : null);
  const md = (): string => Array.from({ length: rnd(5) }, () => pick(['- item', '1. one', '**bold**', '*it*', '`code`', '[link](https://a.b/c_(d))', '[own](/updates#roadmap)',
    'https://x.y/z.', '> quote', '# Head', '```\ncode <b>\n```', 'plain & <text>', '', '\u{1F41D} \u{E4}', '[j](javascript:x)'])).join(pick(['\n', '\n\n', ' ']));
  const milestones: Fields[] = [];
  const tasks: Fields[] = [];
  let taskId = 1;
  const msCount = rnd(14);
  for (let id = 1; id <= msCount; id++) {
    milestones.push({
      id, title: pick(['Custom domains', 'Themes <b>', '"Quoted" & more', 'x'.repeat(160), '\u{1F41D} Bees']), description: rnd(2) ? md() : '',
      status: pick(['now', 'next', 'planned', 'done', 'done', 'done', 'weird']), target: pick(['', 'Q1 2027', '<soon>']), position: rnd(5), is_public: rnd(5) ? 1 : 0,
      started_at: maybeDay(), done_at: maybeDay(), created_at: maybeDay(), updated_at: maybeDay(),
    });
    for (let t = 0, n = pick([0, 0, 1, 4, 5, 6, 7, 11]); t < n; t++) {
      tasks.push({ id: taskId++, milestone_id: id, title: pick(['Task', 'Do <it>', '\u{E4}hm']), is_done: rnd(2), position: rnd(4), done_at: maybeDay() });
    }
  }
  const updates: Fields[] = [];
  const upCount = rnd(45);
  for (let id = 1; id <= upCount; id++) {
    updates.push({
      id, title: pick(['Launch', 'Fix <x> & "y"', '\u{1F41D} New', 't'.repeat(160)]), body: rnd(4) ? md() : pick(['', '   ', '\n']), version: pick(['', 'v2.4', 'V1', '3.0', 'vv']),
      category: pick(['new', 'improved', 'fixed', 'news', 'weird']), milestone_id: rnd(3) ? null : 1 + rnd(msCount + 2), is_published: rnd(5) ? 1 : 0,
      published_at: rnd(8) ? day() : null, discord_announce: 1, discord_message_id: null, discord_target: null, created_at: maybeDay(), updated_at: maybeDay(),
    });
    if (discord) {
      const u = updates[updates.length - 1];
      u.discord_announce = rnd(2);
      if (rnd(3) === 0) Object.assign(u, { discord_message_id: '13000000000000000' + String(10 + id), discord_target: pick(['webhook:123456', 'bot:' + CHANNEL, 'webhook:999999']) });
    }
  }
  return { milestones, milestone_tasks: tasks, updates };
}

test('random data: every page of /updates and the feed render the same HTML as PHP', { skip: PHP_SKIP }, async () => {
  const rnd = random(77001);
  for (let round = 0; round < 6; round++) {
    const rows = randomData(rnd);
    const { updates } = rows;
    const data = (): Record<string, Fields[]> => structuredClone(rows);
    const published = updates.filter((u) => u.is_published).length;
    const pages = Math.max(1, Math.ceil(published / 15));
    for (const url of [...Array.from({ length: pages + 1 }, (_, i) => '/updates?page=' + (i + 1)), '/updates/feed.xml']) {
      const out: Record<string, string> = {};
      for (const side of ['php', 'node'] as const) {
        await loadFixture(env, data());
        const feed = url.endsWith('.xml');
        if (side === 'php') {
          out.php = (await env.php(feed ? `ob_start(); require '${phpFile('views/updates_feed.php')}'; return ob_get_clean();`
            : `$user_data = null; $_GET = $in; ob_start(); require '${phpFile('views/updates.php')}'; return ob_get_clean();`,
          Object.fromEntries(new URLSearchParams(url.split('?')[1] ?? '')))) as string;
        } else {
          const ctx = new Ctx({ method: 'GET', url, headers: { host: 'oys.test:8080' }, peer: '127.0.0.1' });
          await (feed ? updatesFeed(ctx) : updatesPage(ctx, null));
          out.node = String(ctx.body);
        }
      }
      // Ohne Updates steht im Feed die aktuelle Zeit – sie darf sich um eine Sekunde unterscheiden
      assert.equal(normalizeNow(out.node, time() - 5, time()), normalizeNow(out.php, time() - 5, time()), `round ${round} ${url}`);
    }
  }
});

// Die Admin-Ansicht auf zufälligen Daten: Formulare zum Bearbeiten, Vorbefüllen aus einem Meilenstein, alle Spalten und
// alle Discord-Zustände (nicht verbunden, Webhook, Bot, Bot ohne Kanal) – wie admin_updates.php
test('random data: the admin view renders the same HTML as PHP', { skip: PHP_SKIP }, async () => {
  const rnd = random(99017);
  const csrf = 'd'.repeat(64);
  const discordSetups: Step[][] = [
    [],
    [post('discord_save', { mode: 'webhook', webhook_url: hook('123456'), auto_post: '1', username: 'News <x>', mention: 'everyone', invite_url: 'https://discord.gg/x' })],
    [post('discord_save', { mode: 'webhook', webhook_url: hook('123456'), auto_post: '' })],
    [post('discord_save', { mode: 'bot', bot_token: GOOD_TOKEN, channel_id: CHANNEL, auto_post: '1' })],
    [post('discord_save', { mode: 'bot', bot_token: GOOD_TOKEN, channel_id: '' })],
  ];
  for (let round = 0; round < 10; round++) {
    const rows = randomData(rnd, true);
    const ids = (list: Fields[]): string[] => ['', '0', '999', 'x', ...list.map((r) => String(r.id))];
    const get: Record<string, string> = {};
    for (const [key, list] of [['edit_update', rows.updates], ['new_update_for', rows.milestones], ['edit_milestone', rows.milestones]] as const) {
      if (rnd(2)) get[key] = ids(list)[rnd(ids(list).length)];
    }
    const setup = discordSetups[rnd(discordSetups.length)];
    const html: Record<string, string> = {};
    for (const side of ['php', 'node'] as const) {
      await loadFixture(env, structuredClone(rows));
      await runSteps(side, setup, apiBase);
      if (side === 'php') {
        html.php = (await env.php(`$_GET = $in['get']; $_SESSION = ['csrf' => $in['csrf']]; ob_start(); require '${phpFile('views/admin_updates.php')}'; return ob_get_clean();`,
          { get, csrf })) as string;
      } else {
        const query = Object.entries(get).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
        const ctx = await sessionCtx('/admin' + (query ? '?' + query : ''), csrf);
        html.node = await adminUpdatesView(ctx);
        await ctx.session?.close();
      }
    }
    assert.equal(html.node, html.php, `round ${round} ${JSON.stringify(get)}`);
  }
});
