// Community (lib/community.php, views/admin_community.php) gegen PHP: Textregeln, Discord-IDs, Signatur, JSON wie
// json_decode/json_encode, die Admin-Aktionen und die Admin-Ansicht – beide Seiten auf derselben eigenen Test-Datenbank.
// PHP läuft aus einer unveränderten Kopie der Dateien der PHP-Version (support/phpRef.ts), damit es auch ohne
// bot_secret geprüft werden kann.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { loadConfig, setConfigForTests, configString, type ConfigData } from '../src/config.js';
import { closePool } from '../src/db.js';
import { decrypt } from '../src/crypto.js';
import { strtotime, time, date } from '../src/php.js';
import { ensureSchema } from '../src/schema.js';
import { Ctx } from '../src/web/ctx.js';
import type { Session } from '../src/web/session.js';
import { PhpArr, PhpFloat, PhpInt, phpCastString, phpFloatString, phpJsonDecode, phpJsonEncode, phpJsonFloat, phpJsonTruthy, type PhpJson } from '../src/community/json.js';
import { botVerify, communitySeal, communityText, snowflake, communityOpen } from '../src/community/community.js';
import { adminCommunityHandle, adminCommunityPost } from '../src/community/admin.js';
import { adminCommunityView } from '../src/community/adminView.js';
import { withoutDialogs, withoutNativeConfirms } from './support/dialogParity.js';
import { withoutPublicPage, withoutWeb } from './support/suggestionsParity.js';
import { PHP_SKIP, phpRef, writePhpConfig } from './support/phpRef.js';

const BASE = loadConfig();
// Eigene Datenbank je Arbeitsordner (der Name der Test-Datenbank aus den Einstellungen plus Endung), damit zwei
// Arbeitsordner gleichzeitig testen können
const DB = String((BASE.db as ConfigData).name ?? 'oys_test').replace(/[^a-z0-9_]/gi, '') + '_community_t';
const CSRF = 'c'.repeat(64);
let admin: Connection;
let phpRoots: { withSecret: string; noSecret: string };

// ---------------------------------------------------------------- PHP

// Unveränderte Kopie der PHP-Dateien mit eigener config.php (z. B. ohne bot_secret)
function phpTree(config: ConfigData): string {
  const root = mkdtempSync(join(tmpdir(), 'oys-community-'));
  for (const dir of ['lib', 'views']) mkdirSync(join(root, dir));
  for (const file of ['lib/config.php', 'lib/helpers.php', 'lib/community.php', 'security.php', 'views/admin_community.php']) {
    copyFileSync(phpRef(file), join(root, file));
    assert.equal(readFileSync(join(root, file), 'utf8'), readFileSync(phpRef(file), 'utf8'));
  }
  writePhpConfig(root, config);
  writeFileSync(join(root, 'harness.php'), `<?php
    $root = __DIR__;
    require $root . '/lib/config.php';
    date_default_timezone_set(oys_config('timezone', 'Europe/Berlin'));
    mb_internal_encoding('UTF-8');
    require $root . '/security.php'; require $root . '/lib/helpers.php'; require $root . '/lib/community.php';
    $in = json_decode(stream_get_contents(STDIN), true);
    if (isset($in['db'])) {
      $pdo = new PDO('mysql:host=' . oys_config('db.host', 'localhost') . ';dbname=' . $in['db'] . ';charset=utf8mb4', oys_config('db.user', ''), oys_config('db.pass', ''),
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
      $pdo->exec("SET time_zone = '" . date('P') . "'");
    }
    $out = (function ($in, $pdo, $root) { return eval($in['code']); })($in, $pdo ?? null, $root);
    echo json_encode($out, JSON_PARTIAL_OUTPUT_ON_ERROR, 100000);
  `);
  return root;
}

function php(code: string, input: Record<string, unknown> = {}, root = phpRoots.withSecret): any {
  const out = execFileSync('php', ['-d', 'display_errors=0', '-d', 'log_errors=0', join(root, 'harness.php')], {
    input: JSON.stringify({ ...input, code }), maxBuffer: 1e8,
  }).toString();
  return JSON.parse(out);
}

// PHP-Typen als vergleichbare Beschreibung (Node: aus phpJsonDecode)
const PHP_DESCRIBE = `function d($v) { if (is_int($v)) return ['int', (string) $v]; if (is_float($v)) return ['float', (string) $v]; if (is_string($v)) return ['str', $v];
  if (is_bool($v)) return ['bool', $v]; if ($v === null) return ['null']; $o = []; foreach ($v as $k => $x) $o[] = [is_int($k) ? 'i' : 's', (string) $k, d($x)]; return ['arr', $o]; }`;
const intKey = (k: string): boolean => /^(0|-?[1-9][0-9]*)$/.test(k) && BigInt(k) <= 9223372036854775807n && BigInt(k) >= -9223372036854775808n;
function describe(v: PhpJson): unknown {
  if (v instanceof PhpInt) return ['int', v.value.toString()];
  if (v instanceof PhpFloat) return ['float', phpCastString(v)];
  if (typeof v === 'string') return ['str', v];
  if (typeof v === 'boolean') return ['bool', v];
  if (v === null) return ['null'];
  return ['arr', [...v.map.entries()].map(([k, x]) => [intKey(k) ? 'i' : 's', k, describe(x)])];
}

// ---------------------------------------------------------------- Test-Datenbank

let started = 0;
async function useTestDb(extra: ConfigData = {}): Promise<void> {
  setConfigForTests({ ...BASE, db: { ...(BASE.db as ConfigData), name: DB }, ...extra });
  await closePool();
}

// Fester Ausgangsstand – verschlüsselte Werte einmal erzeugt, damit beide Seiten genau dieselben Bytes lesen
let SEALED: Record<string, string> | null = null;
async function fixtures(variant: 'full' | 'empty' = 'full', meta: string | null = String(time() - 10)): Promise<void> {
  for (const t of ['community_suggestions', 'community_tickets', 'community_ticket_messages', 'community_outbox']) await admin.query(`TRUNCATE TABLE \`${DB}\`.\`${t}\``);
  await admin.query(`DELETE FROM \`${DB}\`.oys_meta WHERE meta_key = 'bot_last_seen'`);
  if (meta !== null) await admin.query(`INSERT INTO \`${DB}\`.oys_meta (meta_key, meta_value) VALUES ('bot_last_seen', ?)`, [meta]);
  if (variant === 'empty') return;
  SEALED ??= {
    a: communitySeal('The upload fails with an error.'),
    b: communitySeal('Here is a screenshot <img src=x onerror=alert(1)>\n\n[1 attachment(s): error.png]'),
    c: communitySeal('Looking into it – “quotes” & <b>tags</b>'),
    d: communitySeal('Reply from the website'),
    e: communitySeal('ENC:looks encrypted'),
  };
  const s = 'INSERT INTO `' + DB + '`.community_suggestions (id, thread_id, author_id, author_name, title, body, status, reason, decided_by, decided_via, decided_at, status_message_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)';
  const rows: unknown[][] = [
    [1, '100000000000000001', '200000000000000001', 'Mia', 'Dark mode for the editor', 'Please add <dark> mode & more\nSecond line', 'open', '', '', '', null, null, '2026-10-30 10:00:00', '2026-10-30 10:00:00'],
    [2, '100000000000000002', '200000000000000002', '', 'Ümlauts & “quotes” \'single\'', '', 'open', '', '', '', null, '300000000000000002', '2026-10-30 11:00:00', '2026-10-30 11:00:00'],
    [3, '100000000000000003', '200000000000000003', 'Tom', 'Accepted idea', 'Body', 'accepted', 'Coming in the next update.', 'Boss', 'discord', '2026-10-31 09:15:00', '300000000000000003', '2026-10-29 08:00:00', '2026-10-31 09:15:00'],
    [4, '100000000000000004', '200000000000000004', 'Lea', 'Declined idea', '', 'declined', '', 'Pixel Admin', 'web', '2026-10-31 12:00:00', null, '2026-10-28 08:00:00', '2026-10-31 12:00:00'],
    [5, '100000000000000005', '200000000000000005', 'X', 'Odd status', '', 'Open', '', '', '', null, null, '2026-10-27 08:00:00', '2026-10-27 08:00:00'],
    [6, '100000000000000006', '200000000000000006', 'Y', 'Unknown status', 'b', 'weird', 'r', 'z', 'mail', '2026-03-29 02:30:00', null, '2026-10-26 08:00:00', '2026-10-26 08:00:00'],
  ];
  for (const r of rows) await admin.query(s, r);
  const t = 'INSERT INTO `' + DB + '`.community_tickets (id, user_id, user_name, subject, channel_id, status, closed_by, closed_via, closed_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)';
  for (const r of [
    [1, '400000000000000001', 'Mia', 'Upload <fails>', '500000000000000001', 'open', '', '', null, '2026-10-31 10:00:00', '2026-10-31 12:00:00'],
    [2, '400000000000000002', '', 'Closed one', '500000000000000002', 'closed', 'Team', 'discord', '2026-10-31 13:00:00', '2026-10-31 09:00:00', '2026-10-31 13:00:00'],
    [3, '400000000000000003', 'Tom', 'No channel yet', null, 'open', '', '', null, '2026-10-31 11:00:00', '2026-10-31 11:00:00'],
    [4, '400000000000000004', 'Lea', 'Odd', '0', 'pending', '', '', null, '2026-10-30 11:00:00', '2026-10-31 11:00:00'],
  ]) await admin.query(t, r);
  const m = 'INSERT INTO `' + DB + '`.community_ticket_messages (id, ticket_id, discord_message_id, author_id, author_name, is_team, source, body, created_at) VALUES (?,?,?,?,?,?,?,?,?)';
  for (const r of [
    [1, 1, '600000000000000001', '400000000000000001', 'Mia', 0, 'discord', SEALED.a, '2026-10-31 10:00:00'],
    [2, 1, '600000000000000002', '400000000000000001', '', 0, 'discord', SEALED.b, '2026-10-31 10:05:00'],
    [3, 1, '600000000000000003', '700000000000000001', 'Boss', 1, 'discord', SEALED.c, '2026-10-31 11:00:00'],
    [4, 1, null, null, 'Pixel Admin', 1, 'web', SEALED.d, '2026-10-31 12:00:00'],
    [5, 2, '600000000000000005', '400000000000000002', 'Anon', 0, 'discord', SEALED.e, '2026-10-31 09:00:00'],
    [6, 2, null, null, 'Legacy', 0, 'web', 'plain text without seal', '2026-10-31 09:30:00'],
    [7, 2, null, null, 'Broken', 0, 'web', 'ENC:!!!', '2026-10-31 09:40:00'],
  ]) await admin.query(m, r);
  const o = 'INSERT INTO `' + DB + '`.community_outbox (id, action, payload, attempts, last_error, created_at, done_at) VALUES (?,?,?,?,?,?,?)';
  for (const r of [
    [1, 'suggestion.decided', '{"id":4,"status":"declined"}', 0, null, '2026-10-31 12:00:00', '2026-10-31 12:00:05'],
    [2, 'ticket.reply', '{"id":1,"body":"x"}', 2, 'The ticket channel no longer exists.', '2026-10-31 12:01:00', null],
    [3, 'ticket.close', '{"id":2}', 10, 'Missing <access>', '2026-10-31 12:02:00', null],
    [4, 'suggestion.decided', '{"id":3}', 0, null, '2026-10-31 12:03:00', null],
  ]) await admin.query(o, r);
}

const NODE_OUTBOX_COLUMNS = ['ref', 'next_try_at', 'claimed_at'];

// Inhalt der Community-Tabellen: Zeitstempel von „jetzt“ vereinheitlicht, verschlüsselte Texte entschlüsselt
async function snapshot(): Promise<unknown> {
  const out: Record<string, unknown> = {};
  for (const t of ['community_suggestions', 'community_tickets', 'community_ticket_messages', 'community_outbox', 'oys_meta']) {
    const [rows] = await admin.query<RowDataPacket[]>(`SELECT * FROM \`${DB}\`.\`${t}\` ORDER BY 1`);
    // Reihenfolge (ref), Pause und Abholzeit der Aufträge gibt es nur in Node (eigener Test unten)
    if (t === 'community_outbox') for (const row of rows) for (const k of NODE_OUTBOX_COLUMNS) delete row[k];
    // Spalten der öffentlichen Vorschlagsseite gibt es nur in Node (eigene Tests in suggestions-*.test.ts)
    if (t === 'community_suggestions') for (const row of rows) for (const k of ['web_state', 'web_notice', 'removed_at']) delete row[k];
    // Der Vorschlag für den Bot trägt in Node zusätzlich web
    if (t === 'community_outbox') for (const row of rows) row.payload = withoutWeb(String(row.payload));
    out[t] = rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => {
      if (typeof v === 'string' && v.startsWith('ENC:')) return [k, 'DEC(' + JSON.stringify(decrypt(v)) + ')'];
      // Zeitpunkte dieses Tests („jetzt“) – auch innerhalb von JSON (decided_at in der Warteschlange)
      if (typeof v === 'string') {
        v = v.replace(/\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/g, (m) => {
          const at = strtotime(m);
          return at !== false && at >= started - 2 && at <= time() + 2 ? 'NOW' : m;
        });
      }
      if (t === 'oys_meta' && k === 'meta_value' && row.meta_key === 'bot_last_seen') return [k, Math.abs(Number(v) - time()) <= 3 ? 'NOW' : v];
      return [k, v];
    })));
  }
  return out;
}

before(async () => {
  started = time();
  admin = await mysql.createConnection({
    host: configString('db.host', 'localhost'), user: configString('db.user', ''), password: configString('db.pass', ''),
    charset: 'utf8mb4_unicode_ci', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await useTestDb();
  await ensureSchema();
  if (!PHP_SKIP) {
    const { bot_secret: _secret, ...noSecret } = BASE;
    phpRoots = { withSecret: phpTree(BASE), noSecret: phpTree(noSecret) };
  }
});

after(async () => {
  await closePool();
  setConfigForTests(BASE);
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.end();
  for (const root of Object.values(phpRoots ?? {})) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- reine Funktionen

const JSON_VALUES = ['"  Hi\\r\\nthere\\u0000  "', '"a\\rb\\r\\n\\nc"', '"\\r\\u0000\\n"', '"  "', '""', '"0"', '0', '-0', '-0.0', '1.5', '1e25', '0.00001', '1e400', 'true', 'false', 'null',
  '[]', '{}', '[1]', '{"a":1}', '123456789012345678', '1234567890123456', '9223372036854775808', '12345678901234567890', '100000000000000', '"123456789012345"',
  '"1234567890123456789012"', '"12345678901234567890123"', '"12345678901234\\n"', '"123456789012345\\n"', '"123456789012345\\n\\n"', '" 123456789012345"', '"１２３４５６７８９０１２３４５"',
  '"é😀 \\u2028 x"', '"' + 'ü'.repeat(250) + '"', '"\\ud83d\\ude00' + 'x'.repeat(10) + '"', '"\\t tab \\u000b vt \\f ff "', '"\\u00a0nbsp\\u00a0"'];

test('fixed values: community text, invalid UTF-8 in JSON, -0 and INF', () => {
  assert.equal(communityText('  Hi\r\nthere\0  ', 7), 'Hi\nther');
  assert.equal(phpJsonDecode(Buffer.from([0x22, 0xff, 0x22])), null);
  assert.equal(phpFloatString(-0), '-0');
  assert.equal(phpJsonFloat(Infinity), null);
});

test('community text and Discord IDs match PHP', { skip: PHP_SKIP }, () => {
  const maxes = [0, 1, 5, 7, 100, 200, 4000];
  const ref = php(`return array_map(function ($s) { $v = json_decode($s, true); $o = ['sf' => oys_snowflake($v)];
      foreach ([0, 1, 5, 7, 100, 200, 4000] as $m) $o['t' . $m] = @oys_community_text($v, $m); return $o; }, $in['values']);`, { values: JSON_VALUES });
  const mine = JSON_VALUES.map((s) => {
    const v = phpJsonDecode(s);
    const o: Record<string, unknown> = { sf: snowflake(v) };
    for (const m of maxes) o['t' + m] = communityText(v, m);
    return o;
  });
  assert.deepEqual(mine, ref);
});

test('sealed ticket messages open in PHP and back', { skip: PHP_SKIP }, () => {
  const texts = ['', 'x', 'ENC: looks encrypted', 'Ümlaut 😀\n\nline', '\x01starts with the marker'];
  const sealedByPhp: string[] = php('return array_map("oys_community_seal", $in["t"]);', { t: texts });
  assert.deepEqual(sealedByPhp.map(communityOpen), texts);
  assert.deepEqual(php('return array_map("oys_community_open", $in["t"]);', { t: texts.map(communitySeal) }), texts);
  // Nicht entschlüsselbar oder alt: wird so angezeigt, wie es gespeichert ist
  const odd = ['ENC:!!!', 'plain', '0', ''];
  assert.deepEqual(odd.map(communityOpen), php('return array_map("oys_community_open", $in["t"]);', { t: odd }));
});

function signatureCases(): Array<{ ts: string; sig: string; method: string; uri: string; body: Buffer }> {
  const secret = configString('bot_secret');
  assert.ok(secret.length >= 32, 'the test settings need a bot_secret');
  const now = time();
  const sign = (ts: string, method: string, uri: string, body: Buffer) =>
    createHmac('sha256', secret).update(Buffer.concat([Buffer.from(`${ts}\n${method.toUpperCase()}\n`, 'latin1'), Buffer.from(uri, 'latin1'), Buffer.from('\n'), body])).digest('hex');
  const body = Buffer.from('{"title":"Ä \\u00e9"}\xff', 'latin1');
  const cases: Array<{ ts: string; sig: string; method: string; uri: string; body: Buffer }> = [];
  const add = (ts: string, sig: string, method = 'POST', uri = '/_/bot/suggestions?x=1&y=%20', b = body) => cases.push({ ts, sig, method, uri, body: b });
  const t = String(now);
  add(t, sign(t, 'POST', '/_/bot/suggestions?x=1&y=%20', body));
  add(t, sign(t, 'POST', '/_/bot/suggestions?x=1&y=%20', body).toUpperCase());
  add(t, sign(t, 'POST', '/_/bot/suggestions?x=1&y=%20', body) + '\n');
  add(t, sign(t, 'POST', '/_/bot/suggestions', body));
  add(t, sign(t, 'POST', '/_/bot/suggestions?x=1&y=%20', Buffer.from('other')));
  add(t, sign(t, 'post', '/_/bot/suggestions?x=1&y=%20', body), 'post');
  add('000' + t, sign('000' + t, 'POST', '/_/bot/suggestions?x=1&y=%20', body));
  for (const d of [-301, -300, 299, 301, 100000]) {
    const ts = String(now + d);
    add(ts, sign(ts, 'POST', '/_/bot/suggestions?x=1&y=%20', body));
  }
  for (const ts of ['', ' ' + t, t + ' ', '+' + t, t + '.0', '1e9', '-5', '99999999999999999999999']) add(ts, sign(ts, 'POST', '/_/bot/suggestions?x=1&y=%20', body));
  add(t, '');
  add(t, 'z'.repeat(64));
  add(t, sign(t, 'POST', '/_/bot/suggestions?x=1&y=%20', body).slice(0, 63));
  add(t, sign(t, 'GET', '/_/bot/ping\xe4', Buffer.alloc(0)), 'GET', '/_/bot/ping\xe4', Buffer.alloc(0));
  return cases;
}

test('request signatures are checked: time window, exact method, path and body', () => {
  const results = signatureCases().map((c) => botVerify(c.method, c.uri, c.body, c.ts, c.sig));
  assert.ok(results.filter(Boolean).length >= 5 && results.filter((x) => !x).length >= 10, 'both outcomes are covered');
  assert.equal(results[0], true);
  assert.equal(results[4], false, 'another body');
});

test('request signatures are checked like PHP', { skip: PHP_SKIP }, () => {
  const cases = signatureCases();
  const ref = php(`return array_map(function ($c) {
      $_SERVER['HTTP_X_OYS_TIMESTAMP'] = $c['ts']; $_SERVER['HTTP_X_OYS_SIGNATURE'] = $c['sig'];
      return oys_bot_verify($c['method'], base64_decode($c['uri']), base64_decode($c['body'])); }, $in['cases']);`,
  { cases: cases.map((c) => ({ ...c, uri: Buffer.from(c.uri, 'latin1').toString('base64'), body: c.body.toString('base64') })) });
  assert.deepEqual(cases.map((c) => botVerify(c.method, c.uri, c.body, c.ts, c.sig)), ref);
  assert.ok(ref.filter(Boolean).length >= 5 && ref.filter((x: boolean) => !x).length >= 10, 'both outcomes are covered');
});

test('JSON is decoded and encoded like PHP', { skip: PHP_SKIP }, () => {
  let seed = 4242;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const scalars = ['0', '-0', '1', '-1', '1.5', '-0.0', '0.0', '1e400', '1E2', '9223372036854775807', '9223372036854775808', '-9223372036854775808', '-9223372036854775809',
    '123456789012345678', '12345678901234567890', '1e-5', '5e-324', 'true', 'false', 'null', '"a"', '""', '"0"', '"\\u00e9"', '"\\ud83d\\ude00"', '"\\u2028"', '"\\/"',
    '"a\\"b"', '"\\b\\f\\n\\r\\t"', '"\\u0000"', '"é😀\u007f"'];
  const bad = ['01', '+1', '.5', '1.', "'a'", '"\\ud800"', '"\\udc00"', '"\\ud800\\u0041"', '"\\x"', '"a\tb"', 'tru', 'NaN', '"\\u12"', '[1,]', '{"a":1,}', '{a:1}', '[1 2]', '"', '['];
  const keys = ['"a"', '"0"', '"1"', '"2"', '""', '"-0"', '"01"', '"9223372036854775808"', '"-5"', '"__proto__"', '"a"'];
  const gen = (d: number): string => {
    const k = rnd(10);
    if (d > 3 || k < 5) return rnd(25) === 0 ? bad[rnd(bad.length)] : scalars[rnd(scalars.length)];
    const ws = () => [' ', '', '\n', '\t', '\r', ''][rnd(6)];
    const n = rnd(4);
    if (k < 8) return '[' + ws() + Array.from({ length: n }, () => gen(d + 1)).join(ws() + ',' + ws()) + ws() + ']';
    return '{' + ws() + Array.from({ length: n }, () => keys[rnd(keys.length)] + ws() + ':' + ws() + gen(d + 1)).join(',') + ws() + '}';
  };
  const inputs: string[] = [];
  for (let i = 0; i < 1500; i++) inputs.push(gen(0) + (rnd(30) === 0 ? ' x' : ''));
  for (const n of [510, 511, 512, 513]) inputs.push('['.repeat(n) + ']'.repeat(n), '{"a":'.repeat(n - 1) + '[]' + '}'.repeat(n - 1));
  inputs.push('\ufeff[1]', ' ', '{"0":"a","1":"b"}', '{"1":"a","0":"b"}', '{"0":{"0":[]}}');
  const ref = php(`${PHP_DESCRIBE} return array_map(function ($s) { $v = json_decode($s, true); if (json_last_error()) return 'error';
      $e = json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES); $e2 = json_encode($v);
      return [d($v), $e === false ? false : $e, $e2 === false ? false : $e2, !empty($v)]; }, $in['s']);`, { s: inputs });
  const mine = inputs.map((s) => {
    const v = phpJsonDecode(Buffer.from(s, 'utf8'));
    if (v === null && s.trim() !== 'null') return 'error';
    return [describe(v), phpJsonEncode(v, { unescapedUnicode: true, unescapedSlashes: true }), phpJsonEncode(v), phpJsonTruthy(v)];
  });
  // Als Text vergleichen: deepEqual stößt bei 500 Ebenen an die Grenze des Stapels
  mine.forEach((m, i) => assert.equal(JSON.stringify(m), JSON.stringify(ref[i]), inputs[i].slice(0, 200)));
  // Ungültiges UTF-8 lehnt json_decode ab
  assert.equal(php('return json_decode(base64_decode("Iv8i"), true);'), null);
});

test('float formatting matches PHP (string casts and json_encode)', { skip: PHP_SKIP }, () => {
  let seed = 7;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const vals: number[] = [10000000000000.5, 10000000000001.5, 1000000000000.25, 70368744177664.5, 1e-5, 1e-4, 9.99999999999999e-5, 9.999999999999999e-5,
    5e-324, 1.7976931348623157e308, 0.1 + 0.2, 1e15, 1e16, 1e17, 123456789012345678, 0.5, 2.5];
  for (let i = 0; i < 4000; i++) vals.push(Number(String(rnd(1e8)) + '.' + String(rnd(1e8)).padStart(8, '0') + 'e' + (rnd(40) - 20)), (rnd(2e9) + 0.5) * 10 ** (rnd(20) - 10));
  const all = vals.flatMap((v) => [v, -v]);
  const ref = php('return array_map(function ($s) { $f = (float) $s; return [(string) $f, json_encode($f)]; }, $in["v"]);', { v: all.map((v) => v.toPrecision(17)) });
  const mine = all.map((v) => {
    const f = Number(v.toPrecision(17));
    return [phpFloatString(f), phpJsonFloat(f)];
  });
  assert.deepEqual(mine, ref);
});

// ---------------------------------------------------------------- Admin-Aktionen

type Post = Record<string, unknown>;
const HANDLER_CASES: Array<{ name: string; post: Post; adminName?: string }> = [
  { name: 'no action', post: {} },
  { name: 'unknown action', post: { community_action: 'nope', id: '1' } },
  { name: 'action as array', post: { community_action: { 0: 'suggestion_decide' }, id: '1', status: 'accepted' } },
  { name: 'accept with note', post: { community_action: 'suggestion_decide', id: '1', status: 'accepted', reason: '  Good idea – “soon” <b>\r\n</b>  ' } },
  { name: 'decline without note', post: { community_action: 'suggestion_decide', id: '2', status: 'declined' }, adminName: '' },
  { name: 'decide with long note and name', post: { community_action: 'suggestion_decide', id: '1', status: 'declined', reason: 'ü'.repeat(600) }, adminName: 'N'.repeat(150) },
  { name: 'id with junk', post: { community_action: 'suggestion_decide', id: '1abc', status: 'accepted' } },
  { name: 'id as array', post: { community_action: 'suggestion_decide', id: { 0: '5' }, status: 'accepted' } },
  { name: 'reason as array', post: { community_action: 'suggestion_decide', id: '2', status: 'accepted', reason: { a: 'x' } } },
  { name: 'missing suggestion', post: { community_action: 'suggestion_decide', id: '99', status: 'accepted' } },
  { name: 'invalid status', post: { community_action: 'suggestion_decide', id: '1', status: 'open' } },
  { name: 'status case', post: { community_action: 'suggestion_decide', id: '1', status: 'Accepted' } },
  { name: 'already accepted', post: { community_action: 'suggestion_decide', id: '3', status: 'declined' } },
  { name: 'already declined on the web', post: { community_action: 'suggestion_decide', id: '4', status: 'accepted' } },
  { name: 'odd status Open', post: { community_action: 'suggestion_decide', id: '5', status: 'accepted' } },
  { name: 'reply', post: { community_action: 'ticket_reply', id: '1', body: '  Thanks!\r\nWe are on it – <b>soon</b> 😀  ' }, adminName: 'Pixel Admin' },
  { name: 'reply to ticket without channel', post: { community_action: 'ticket_reply', id: '3', body: 'Hello' } },
  { name: 'reply too long', post: { community_action: 'ticket_reply', id: '1', body: 'x'.repeat(2100) } },
  { name: 'empty reply', post: { community_action: 'ticket_reply', id: '1', body: ' \r\n\0 ' } },
  { name: 'reply without body', post: { community_action: 'ticket_reply', id: '1' } },
  { name: 'reply to closed ticket', post: { community_action: 'ticket_reply', id: '2', body: 'Hello' } },
  { name: 'reply to odd status', post: { community_action: 'ticket_reply', id: '4', body: 'Hello' } },
  { name: 'reply to missing ticket', post: { community_action: 'ticket_reply', id: '0', body: 'Hello' } },
  { name: 'close', post: { community_action: 'ticket_close', id: '1' }, adminName: 'Ädmin "Quote"/Slash' },
  { name: 'close without channel', post: { community_action: 'ticket_close', id: '3' } },
  { name: 'close closed', post: { community_action: 'ticket_close', id: '2' } },
  { name: 'close missing', post: { community_action: 'ticket_close', id: 'abc' } },
];

test('admin actions change the same rows and answer like PHP', { skip: PHP_SKIP }, async () => {
  await useTestDb();
  for (const c of HANDLER_CASES) {
    const adminName = c.adminName ?? 'Pixel Admin';
    const seen = String(time() - 10);
    await fixtures('full', seen);
    const ref = php('return oys_admin_community_handle($pdo, $in["post"], $in["admin"]);', { db: DB, post: c.post, admin: adminName });
    const phpDb = await snapshot();
    await fixtures('full', seen);
    const mine = await adminCommunityHandle(c.post as never, adminName);
    const nodeDb = await snapshot();
    assert.deepEqual(mine, ref, `result: ${c.name}`);
    assert.deepEqual(nodeDb, phpDb, `database: ${c.name}`);
  }
});

test('community jobs carry a ref, so a reply and the close of one ticket stay in order', async () => {
  await useTestDb();
  await fixtures('full', String(time() - 10));
  await adminCommunityHandle({ community_action: 'suggestion_decide', id: '1', status: 'accepted' } as never, 'Pixel Admin');
  await adminCommunityHandle({ community_action: 'ticket_reply', id: '1', body: 'Hello' } as never, 'Pixel Admin');
  await adminCommunityHandle({ community_action: 'ticket_close', id: '1' } as never, 'Pixel Admin');
  const [rows] = await admin.query<RowDataPacket[]>(`SELECT action, ref FROM \`${DB}\`.community_outbox WHERE id > 4 ORDER BY id`);
  assert.deepEqual(rows.map((r) => [r.action, r.ref]), [['suggestion.decided', 'suggestion:1'], ['ticket.reply', 'ticket:1'], ['ticket.close', 'ticket:1']]);
});

// ---------------------------------------------------------------- Admin-Ansicht

function fakeCtx(query: string): Ctx {
  const ctx = new Ctx({ method: 'GET', url: '/admin' + query, headers: { host: 'oys.test:8080' }, peer: '127.0.0.1' });
  // Sitzung mit festem CSRF-Wert (PHP bekommt denselben)
  ctx.session = { get: (k: string) => (k === 'csrf' ? CSRF : undefined), set: () => undefined } as unknown as Session;
  return ctx;
}

const VIEW_CASES: Array<{ name: string; query: string; get: unknown; variant?: 'full' | 'empty'; meta?: string | null; noSecret?: boolean }> = [
  { name: 'default, bot online', query: '', get: {} },
  { name: 'accepted filter', query: '?suggestions=accepted', get: { suggestions: 'accepted' } },
  { name: 'declined filter', query: '?suggestions=declined', get: { suggestions: 'declined' } },
  { name: 'all', query: '?suggestions=all', get: { suggestions: 'all' } },
  { name: 'unknown filter', query: '?suggestions=weird', get: { suggestions: 'weird' } },
  { name: 'filter as array', query: '?suggestions[]=all', get: { suggestions: ['all'] } },
  { name: 'open ticket', query: '?ticket=1', get: { ticket: '1' } },
  { name: 'closed ticket', query: '?ticket=2&suggestions=all', get: { ticket: '2', suggestions: 'all' } },
  { name: 'ticket with odd status', query: '?ticket=4', get: { ticket: '4' } },
  { name: 'missing ticket', query: '?ticket=99', get: { ticket: '99' } },
  { name: 'ticket junk', query: '?ticket=1x', get: { ticket: '1x' } },
  { name: 'ticket array', query: '?ticket[]=3', get: { ticket: ['3'] } },
  { name: 'bot offline', query: '', get: {}, meta: String(time() - 3600) },
  { name: 'bot never seen', query: '', get: {}, meta: null },
  { name: 'bot seen zero', query: '', get: {}, meta: '0' },
  { name: 'bot seen junk', query: '', get: {}, meta: 'abc' },
  { name: 'bot not set up', query: '', get: {}, noSecret: true },
  { name: 'empty', query: '', get: {}, variant: 'empty' },
  { name: 'empty, other filter', query: '?suggestions=all', get: { suggestions: 'all' }, variant: 'empty' },
];

test('admin view offers a fresh bot secret while the bot isn’t set up', async () => {
  await useTestDb({ bot_secret: null });
  await fixtures('full', String(time() - 10));
  assert.match(await adminCommunityView(fakeCtx('')), /'bot_secret' =&gt; '[0-9a-f]{64}'/);
  await useTestDb();
});

test('admin view renders the same HTML as PHP', { skip: PHP_SKIP }, async () => {
  for (const c of VIEW_CASES) {
    await useTestDb(c.noSecret ? { bot_secret: null } : {});
    await fixtures(c.variant ?? 'full', c.meta === undefined ? String(time() - 10) : c.meta);
    const ref = php(`$_SESSION = ['csrf' => $in['csrf']]; $_GET = $in['get']; ob_start(); include $root . '/views/admin_community.php'; return ob_get_clean();`,
      { db: DB, csrf: CSRF, get: c.get }, c.noSecret ? phpRoots.noSecret : phpRoots.withSecret);
    const mine = await adminCommunityView(fakeCtx(c.query));
    // Nur das frisch erzeugte Geheimnis im Hinweis „Connect the Discord bot“ ist zufällig
    const norm = (h: string) => h.replace(/('bot_secret' =&gt; ')[0-9a-f]{64}'/, '$1SECRET\'');
    assert.equal(withoutDialogs(withoutPublicPage(norm(mine))), withoutNativeConfirms(norm(ref)), c.name);
    if (c.noSecret) assert.match(mine, /'bot_secret' =&gt; '[0-9a-f]{64}'/);
  }
  await useTestDb();
});

test('the view shows a pending count only for open work', async () => {
  // Einzahl/Mehrzahl und das Datum „last seen“
  await useTestDb();
  const seen = time() - 7200;
  await fixtures('full', String(seen));
  await admin.query(`UPDATE \`${DB}\`.community_outbox SET done_at = NOW() WHERE id <> 4`);
  const ctx = fakeCtx('');
  ctx.session = { get: () => 'x', set: () => undefined } as unknown as Session;
  const html = await adminCommunityView(ctx);
  assert.match(html, /1 change waiting for the bot/);
  assert.match(html, new RegExp('Offline – last seen ' + date('M j, Y H:i', seen)));
});

test('the view shows a pending count only for open work like PHP', { skip: PHP_SKIP }, async () => {
  // Einzahl/Mehrzahl und das Datum „last seen“ wie PHP
  await useTestDb();
  await fixtures('full', String(time() - 7200));
  await admin.query(`UPDATE \`${DB}\`.community_outbox SET done_at = NOW() WHERE id <> 4`);
  const ref = php(`$_SESSION = ['csrf' => 'x']; $_GET = []; ob_start(); include $root . '/views/admin_community.php'; return ob_get_clean();`, { db: DB });
  const ctx = fakeCtx('');
  ctx.session = { get: () => 'x', set: () => undefined } as unknown as Session;
  assert.equal(withoutDialogs(withoutPublicPage(await adminCommunityView(ctx))), withoutNativeConfirms(ref));
  assert.match(ref, /1 change waiting for the bot/);
  assert.match(ref, new RegExp('Offline – last seen ' + date('M j, Y H:i', time() - 7200)));
});

// ---------------------------------------------------------------- POST /admin (Community-Teil)

test('the community branch of POST /admin redirects and flashes like views/admin.php', { skip: PHP_SKIP }, async () => {
  // Genau der Block aus views/admin.php, nur header()/exit für den Test abgefangen
  const src = readFileSync(phpRef('views/admin.php'), 'utf8');
  const start = src.indexOf("if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['community_action'])) {");
  const end = src.indexOf('\n}\n', start) + 2;
  assert.ok(start > 0 && end > start);
  const block = src.slice(start, end).replace(/header\(/g, '$hdr[] = (').replace(/exit;/g, '');
  await useTestDb();
  const cases: Array<Record<string, unknown>> = [
    { community_action: 'ticket_reply', id: '1', body: 'Thanks' },
    { community_action: 'ticket_close', id: '3x' },
    { community_action: 'ticket_reply', id: '1', body: '' },
    { community_action: 'suggestion_decide', id: '1', status: 'accepted' },
    { community_action: 'suggestion_decide', id: '3', status: 'accepted' },
    { community_action: 'nope', id: '1' },
    { community_action: { 0: 'ticket_reply' }, id: '1' },
    { community_action: 'ticket_unknown' },
  ];
  for (const post of cases) {
    const seen = String(time() - 10);
    await fixtures('full', seen);
    const ref = php(`$_SERVER['REQUEST_METHOD'] = 'POST'; $_POST = $in['post']; $_SESSION = []; $user_data = ['full_name' => 'Pixel Admin']; $hdr = [];
      ${block} return ['headers' => $hdr, 'session' => (object) $_SESSION];`, { db: DB, post });
    const phpDb = await snapshot();
    await fixtures('full', seen);
    const ctx = new Ctx({ method: 'POST', url: '/admin', headers: { host: 'oys.test:8080' }, peer: '127.0.0.1' });
    ctx.post = post as never;
    const flashes: Record<string, unknown> = {};
    ctx.session = { get: () => undefined, set: (k: string, v: unknown) => { flashes[k] = v; } } as unknown as Session;
    await assert.rejects(() => (adminCommunityPost(ctx, { full_name: 'Pixel Admin' }) as Promise<unknown>), (err: { halt?: boolean }) => err.halt === true);
    assert.deepEqual({ headers: ['Location: ' + ctx.header('Location')], session: flashes }, ref, JSON.stringify(post));
    assert.equal(ctx.status, 302);
    assert.deepEqual(await snapshot(), phpDb, JSON.stringify(post));
  }
});
