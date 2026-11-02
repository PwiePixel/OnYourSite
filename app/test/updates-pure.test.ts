// Updates ohne Datenbank gegen PHP (PHP-Version, siehe support/phpRef.ts): Zeilen → Updates/Meilensteine,
// Aufgaben-Zeilen (mit dem \R-Fehler von PHP), Discord-Adressen, Nachrichten, Fehlertexte und Hinweise, dazu die
// Hilfen für den Feed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { intval } from '../src/php.js';
import { milestoneFromRow, milestoneProgress, taskLines, updateFromRow } from '../src/updates/updates.js';
import {
  discordBase, discordChange, discordConfigured, discordDefaults, discordError, discordParseWebhook, discordRemoveNote, discordTarget, discordUpdatePayload,
  discordWithMention, type DiscordChange, type DiscordResponse, type DiscordSettings,
} from '../src/updates/discord.js';
import { xmlEscape } from '../src/html.js';
import type { Update } from '../src/updates/updates.js';
import { PHP_SKIP, phpFile, phpRoot } from './support/phpRef.js';

function php(code: string, input: unknown): unknown {
  const script = `require '${phpFile('lib/config.php')}'; date_default_timezone_set(oys_config('timezone', 'Europe/Berlin')); mb_internal_encoding('UTF-8');`
    + `require '${phpFile('security.php')}'; require '${phpFile('lib/helpers.php')}'; require '${phpFile('lib/updates.php')}';`
    + `$in = json_decode(stream_get_contents(STDIN), true); $out = (function ($in) { ${code} })($in);`
    + 'echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);';
  return JSON.parse(execFileSync('php', ['-d', 'display_errors=stderr', '-r', script], {
    input: JSON.stringify(input), cwd: phpRoot(), stdio: ['pipe', 'pipe', 'pipe'],
  }).toString());
}

test('rows become updates and milestones like in PHP', { skip: PHP_SKIP }, () => {
  const updates = [
    { id: 7, title: 'T', body: null, version: null, category: 'fixed', milestone_id: 3, is_published: 1, published_at: '2026-10-01 12:00:00', discord_announce: 0,
      discord_message_id: null, discord_target: null, created_at: null, updated_at: '2026-10-02 08:00:00' },
    { id: '8', title: 5, body: 'b', version: '2.0', category: 'weird', milestone_id: null, is_published: 0, published_at: null, discord_announce: 1,
      discord_message_id: '1300000000000000001', discord_target: 'webhook:123', created_at: '2026-01-01 00:00:00', updated_at: null },
    { id: 9, title: '', body: '', version: '', category: 'constructor', milestone_id: '4', is_published: '1', published_at: '0000-00-00 00:00:00', discord_announce: null,
      discord_message_id: '', discord_target: '', created_at: null, updated_at: null },
  ];
  assert.deepEqual(updates.map((r) => updateFromRow(r)), php('return array_map("oys_update_from_row", $in);', updates));
  const ms = [
    { id: 1, title: 'M', description: null, status: 'now', target: null, position: 2, is_public: 1, started_at: '2026-10-20 10:00:00', done_at: null,
      created_at: null, updated_at: '2026-10-21 10:00:00' },
    { id: '2', title: 'N', description: 'd', status: 'weird', target: 'Q1', position: '3', is_public: 0, started_at: null, done_at: null, created_at: null, updated_at: null },
    { id: 3, title: 'O', description: '', status: '__proto__', target: '', position: 0, is_public: '0', started_at: null, done_at: '2026-10-25 10:00:00',
      created_at: null, updated_at: null },
  ];
  assert.deepEqual(ms.map((r) => milestoneFromRow(r)), php('return array_map("oys_milestone_from_row", $in);', ms));
  const lists = [[], [{ is_done: true }], [{ is_done: false }, { is_done: true }, { is_done: true }], [{ is_done: true }, { is_done: false }, { is_done: false }]];
  const tasks = lists.map((l) => ({ tasks: l.map((t, i) => ({ id: i, title: 'x', is_done: t.is_done, done_at: null })) }));
  assert.deepEqual(tasks.map(milestoneProgress), php('return array_map("oys_milestone_progress", $in);', tasks));
});

test('task lines are split like PHP, including the byte 0x85 bug of \\R', { skip: PHP_SKIP }, () => {
  const inputs = [
    'Design the page\r\n- [x] Done thing\n* [ ] open\n\u{2022} [X] bullet done\n[] empty box\nPolish \u{105} task\n\u{C5}ngstr\u{F6}m\nnormal\x0Bvt\n   \n',
    'a\rb\r\n\r\nc\fd\x85e', '\u{FEFF}[x] bom', '  -   [x]   spaced  ', '-[x]tight', '\u{2022}\u{A0}[x]\u{A0}nbsp', '[x]', '[ ]', '- ', '\u{2028}line\u{2029}sep\u{2028}',
    'Kyrillisch \u{445}\u{43E}\u{440}\u{43E}\u{448}\u{43E}', '\u{2160} roman one', '\u{1F145} squared', '\u{105}', 'x'.repeat(300), 'tab\tin\tline', 'ctrl\x01char', '\x01',
    '\u{85}\u{85}', '[X] done\n[x] done\n[x]', '* * * [x] stars', '\u{3000}[x] ideographic space',
  ];
  const ours = inputs.map(taskLines);
  const theirs = php(`return array_map(function ($in) { $out = [];
      foreach (preg_split('/\\R/', $in) as $line) {
        $done = (bool) preg_match('/^\\s*(?:[-*•]\\s*)?\\[[xX]\\]/u', $line);
        $line = @trim(preg_replace('/^\\s*(?:[-*•]\\s*)?(?:\\[[ xX]?\\])?\\s*/u', '', $line));
        if ($line !== '') $out[] = ['title' => $line, 'done' => $done];
      } return $out; }, $in);`, inputs);
  assert.deepEqual(ours, theirs);
  // Der Fehler selbst: „ą“ (C4 85) und „Å“ (C3 85) werden an 0x85 getrennt
  assert.deepEqual(taskLines('Polish \u{105} task'), [{ title: 'task', done: false }]);
  assert.deepEqual(taskLines('\u{C5}ngstr\u{F6}m'), [{ title: 'ngstr\u{F6}m', done: false }]);
});

test('webhook links, targets and the API base match PHP', { skip: PHP_SKIP }, () => {
  const base = discordBase();
  const urls = [
    'https://discord.com/api/webhooks/1301234567890123456/' + 'Ab_-9'.repeat(13) + 'xyz', ' https://discord.com/api/webhooks/12345/abcdefghijklmnopqrstuvwxyz \n',
    'https://ptb.discord.com/api/v10/webhooks/12345/abcdefghijklmnopqrstuvwxyz/', 'https://canary.discordapp.com/api/v9/webhooks/12345/abcdefghijklmnopqrstuvwxyz',
    'https://discord.com/api/webhooks/1234/abcdefghijklmnopqrstuvwxyz', 'https://discord.com/api/webhooks/12345/short', 'http://discord.com/api/webhooks/12345/abcdefghijklmnopqrstuvwxyz',
    'https://discord.com/channels/123456789012345678/123456789012345678', 'https://DISCORD.com/api/webhooks/12345/abcdefghijklmnopqrstuvwxyz',
    'https://discord.com/api/webhooks/12345/abcdefghijklmnopqrstuvwxyz?wait=true', 'https://discord.com/api/webhooks/12345/abcdefghijklmnopqrstuvwxyz\n',
    base + '/webhooks/123456/abcdefghijklmnopqrstuvwxyz', base + '/v10/webhooks/123456/abcdefghijklmnopqrstuvwxyz', base + '/webhooks/4041234/abcdefghijklmnopqrstuvwxyz/',
    'https://evil.com/api/webhooks/12345/abcdefghijklmnopqrstuvwxyz', '', 'https://discord.com/api/webhooks/12345/' + 'a'.repeat(121),
    // Aus tests/unit.php: Doppelgänger-Host, versteckt in einer Abfrage, zusätzlicher Pfad
    'https://discord.com.evil.io/api/webhooks/123456789012345678/' + 'aB3_-'.repeat(8),
    'https://evil.io/?u=https://discord.com/api/webhooks/123456789012345678/' + 'aB3_-'.repeat(8),
    'https://discord.com/api/webhooks/123456789012345678/' + 'aB3_-'.repeat(8) + '/messages/1',
  ];
  assert.deepEqual(urls.map(discordParseWebhook), php('return array_map("oys_discord_parse_webhook", $in);', urls));
  assert.equal(base, php('return oys_discord_base();', null));
  const settings: DiscordSettings[] = [
    discordDefaults(),
    { ...discordDefaults(), webhook_url: urls[0] },
    { ...discordDefaults(), webhook_url: urls[11] },
    { ...discordDefaults(), webhook_url: 'nonsense' },
    { ...discordDefaults(), mode: 'bot', bot_token: 'x'.repeat(60), channel_id: '1301234567890123456' },
    { ...discordDefaults(), mode: 'bot', bot_token: '', channel_id: '1301234567890123456' },
    { ...discordDefaults(), mode: 'bot', bot_token: 'x'.repeat(60), channel_id: '' },
    { ...discordDefaults(), mode: 'other', webhook_url: urls[0] },
  ];
  assert.deepEqual(settings.map(discordTarget), php('return array_map("oys_discord_target", $in);', settings));
  assert.deepEqual(settings.map(discordConfigured), php('return array_map("oys_discord_configured", $in);', settings));
});

test('Discord messages, error texts and notes match PHP', { skip: PHP_SKIP }, async () => {
  const s = (over: Partial<DiscordSettings>): DiscordSettings => ({ ...discordDefaults(), webhook_url: 'https://discord.com/api/webhooks/12345/abcdefghijklmnopqrstuvwxyz', ...over });
  const settings = [
    s({}), s({ mention: 'everyone' }), s({ mention: 'here', username: 'News', avatar_url: 'https://x.y/a.png' }), s({ mention: '1301234567890123457' }),
    s({ mode: 'bot', mention: '1301234567890123457\n', username: 'ignored', avatar_url: 'https://x.y/a.png' }), s({ mention: 'EVERYONE' }),
  ];
  const u = (over: Partial<Update>): Update => ({
    id: 7, title: 'Title', body: '', version: '', category: 'new', milestone_id: null, is_published: true, published_at: '2026-10-25 02:30:00',
    discord_announce: true, discord_message_id: '', discord_target: '', created_at: null, updated_at: null, ...over,
  });
  const updates = [
    u({}), u({ version: 'v2.4', category: 'fixed', body: ' **x**\n' }), u({ category: 'improved', title: 'T'.repeat(300), version: '1.0' }),
    u({ category: 'news', body: '\u{E4}'.repeat(3801) }), u({ body: 'word '.repeat(800) + '\u{1F41D}'.repeat(10) }), u({ published_at: '2026-03-29 02:30:00' }),
    u({ published_at: '2026-07-01 23:59:59', title: '"quotes" & <tags> / slashes \u{2028}' }), u({ published_at: 'garbage' }),
  ];
  const ours = updates.flatMap((x) => settings.map((st) => discordUpdatePayload(x, st)));
  const theirs = php('$r = []; foreach ($in[0] as $u) foreach ($in[1] as $s) $r[] = oys_discord_update_payload($u, $s); return $r;', [updates, settings]);
  assert.deepEqual(ours, theirs);
  // Dieselbe Reihenfolge der Schlüssel (sie bestimmt das gesendete JSON)
  assert.equal(JSON.stringify(ours), JSON.stringify(theirs));
  // Ohne Ziel oder über ein anderes Ziel wird nichts gesendet (kein Aufruf bei Discord)
  const changeStates = await Promise.all([
    discordChange(settings[0], 'bot:1', '123456', null), discordChange(discordDefaults(), 'webhook:1', '123456', null),
    discordChange(settings[0], 'webhook:12345', 'abc', null), discordChange(settings[0], 'webhook:12345', '1234', { embeds: [] }),
  ]);
  assert.deepEqual(changeStates, php(`return [oys_discord_change($in[0], 'bot:1', '123456', null), oys_discord_change(oys_discord_defaults(), 'webhook:1', '123456', null),
    oys_discord_change($in[0], 'webhook:12345', 'abc', null), oys_discord_change($in[0], 'webhook:12345', '1234', ['embeds' => []])];`, settings));
  const test = { embeds: [{ title: 'Discord is connected', color: 6514417 }] };
  assert.equal(JSON.stringify(settings.map((st) => discordWithMention(test, st))), JSON.stringify(php('return array_map(function ($s) use ($in) { return oys_discord_with_mention($in[0], $s); }, $in[1]);', [test, settings])));
  assert.equal(JSON.stringify(settings.map((st) => discordWithMention({}, st))), JSON.stringify(php('return array_map(function ($s) { return oys_discord_with_mention([], $s); }, $in);', settings)));

  const responses: DiscordResponse[] = [0, 200, 400, 401, 403, 404, 405, 418, 429, 500, 502].flatMap((status) => [
    { status, data: null, code: null, error: status === 0 ? 'Could not resolve host: discord.com' : '' },
    { status, data: { message: 'Something <odd>', code: 10003 }, code: 10003, error: '' },
    { status, data: { message: ['list'] }, code: null, error: '' },
  ]);
  assert.deepEqual(responses.flatMap((r) => [discordError(r, true), discordError(r, false)]),
    php('$r = []; foreach ($in as $res) { $r[] = oys_discord_error($res, true); $r[] = oys_discord_error($res, false); } return $r;', responses));

  const changes: DiscordChange[] = [
    { state: 'ok', error: null, transient: false }, { state: 'missing', error: null, transient: false },
    { state: 'disconnected', error: 'Discord isn’t connected', transient: false }, { state: 'unreachable', error: 'it was posted through a different webhook or bot', transient: false },
    { state: 'failed', error: 'Discord error 500: Simulated failure.', transient: true }, { state: 'failed', error: 'Discord is rate limiting us...', transient: true },
  ];
  assert.deepEqual(changes.flatMap((c) => [discordRemoveNote(c), discordRemoveNote(c, true)]),
    php('$r = []; foreach ($in as $c) { $r[] = oys_discord_remove_note($c); $r[] = oys_discord_remove_note($c, true); } return $r;', changes));
});

test('feed escaping and (int) of overflowing numbers match PHP', { skip: PHP_SKIP }, () => {
  const texts = ['a & b', '<tag attr="x">', "it's", '&amp;', '\u{1F41D} \u{E4}', ''];
  assert.deepEqual(texts.map(xmlEscape), php('return array_map(function ($s) { return htmlspecialchars($s, ENT_XML1 | ENT_QUOTES | ENT_SUBSTITUTE, "UTF-8"); }, $in);', texts));
  // ?page=1e400 auf /updates: PHP macht aus der unendlichen Zahl 0, nicht die größte Zahl
  const numbers = ['1e400', '-1e400', '1e3', '12abc', ' 7', '-3', '2.9', 'abc', ''];
  assert.deepEqual(numbers.map(intval), php('return array_map("intval", $in);', numbers));
});
