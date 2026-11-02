// Schreibende Funktionen gegen PHP: dieselben Aufrufe (Seite anlegen, speichern, löschen, Benutzername, Dateien
// aufräumen, Kalender) laufen in PHP und Node auf je einer frischen Kopie der Test-Datenbank und je einem eigenen
// Upload-Ordner. Danach müssen alle betroffenen Tabellen und die Dateien übereinstimmen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { loadConfig, setConfigForTests, configString, type ConfigData } from '../src/config.js';
import { closePool, exec, q, value } from '../src/db.js';
import { ensureSchema } from '../src/schema.js';
import { passwordVerify } from '../src/crypto.js';
import { strtotime, time } from '../src/php.js';
import { calendarKey } from '../src/content/blocks.js';
import {
  createPage, savePage, deletePage, syncUsername, usedFiles, cleanupFiles, calendarAccess, pageFiles, loadPage, loadBlocks,
} from '../src/content/pages.js';
import { entries, isArr, jsonDecode, phpArray, type PhpArr } from '../src/content/util.js';
import { runPhp, enc, FLAGS, jsonText, O, Raw } from './modelHarness.js';

const BASE = loadConfig();
const SOURCE = configString('db.name');
const DBS = { php: SOURCE + '_mphp', node: SOURCE + '_mnode' };
const TABLES = ['users', 'pages', 'page_blocks', 'block_clicks_daily', 'stats_daily', 'messages', 'code_sites', 'code_files', 'notifications', 'user_bookings'];
const PASSWORDS = ['secret123', 'another-pass'];
let admin: Connection;
let started = 0;
let tmp = '';

const FILES = ['avatar_5_1700000001_abcdef12.png', 'bg_5_1700000002_abcdef12.jpg', 'img_5_1700000003_abcdef12.png', 'thumb_5_1700000004_abcdef12.webp',
  'gal_5_1700000005_abcdef12.png', 'gal_5_1700000006_abcdef12.png', 'music_5_1700000007_abcdef12.mp3', 'avatar_6_1700000008_abcdef12.png',
  'avatar_5_1700000009_abcdef12.png', 'file_5_1773643714.pdf', 'unused_5_1700000011_abcdef12.png', 'legacy name.png', '.htaccess'];

const dirs = (side: 'php' | 'node') => ({ base: join(tmp, side), uploads: join(tmp, side, 'uploads') });

before(async () => {
  admin = await mysql.createConnection({
    host: configString('db.host', 'localhost'), user: configString('db.user', ''), password: configString('db.pass', ''),
    charset: 'utf8mb4_unicode_ci', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false,
  });
  const [tables] = await admin.query<RowDataPacket[]>(`SHOW TABLES FROM \`${SOURCE}\``);
  for (const db of Object.values(DBS)) {
    await admin.query(`DROP DATABASE IF EXISTS \`${db}\``);
    await admin.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    for (const row of tables) {
      const t = String(Object.values(row)[0]);
      await admin.query(`CREATE TABLE \`${db}\`.\`${t}\` LIKE \`${SOURCE}\`.\`${t}\``);
      await admin.query(`INSERT INTO \`${db}\`.\`${t}\` SELECT * FROM \`${SOURCE}\`.\`${t}\``);
    }
  }
  // Beide Kopien auf den Stand dieses Codes (die Quelle ist vielleicht noch nicht migriert); PHP arbeitet auf demselben
  // Schema und kennt die neuen Tabellen einfach nicht
  for (const db of Object.values(DBS)) {
    await closePool();
    setConfigForTests({ ...BASE, db: { ...(BASE.db as ConfigData), name: db } });
    await ensureSchema();
  }
  await closePool();
  setConfigForTests(BASE);
  tmp = mkdtempSync(join(tmpdir(), 'oys-model-'));
  for (const side of ['php', 'node'] as const) {
    const d = dirs(side);
    mkdirSync(d.uploads, { recursive: true });
    for (const f of FILES) writeFileSync(join(d.uploads, f), 'x' + f);
    // ein Ordner mit dem Namen einer Upload-Datei: is_file() ist falsch, er bleibt
    mkdirSync(join(d.uploads, 'dir_5_1700000013_abcdef12.png'));
    // liegt außerhalb des Upload-Ordners: '../escape_…' unter den Kandidaten
    writeFileSync(join(d.base, 'escape_5_1700000010_abcdef12.png'), 'x');
  }
  started = time();
});

after(async () => {
  setConfigForTests(BASE);
  await closePool();
  for (const db of Object.values(DBS)) await admin.query(`DROP DATABASE IF EXISTS \`${db}\``);
  await admin.end();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------- Ablauf (für beide Seiten gleich)

const FIXED_HASH = '$2y$10$fixedfixedfixedfixedfuJ8Qk1z9Zq0Zq0Zq0Zq0Zq0Zq0Zq0Zq';
const sql = (s: string): [string, unknown[]] => ['sql', [s]];
const SNAPSHOT: [string, unknown[]] = ['dump', ['pages', 'page_blocks', 'block_clicks_daily', 'stats_daily', 'messages', 'users']];

const SAVE_1 = new O([
  ['page', new O([['title', '  Mia M. '], ['subtitle', 'Design'], ['bio', 'Hello\r\nWorld\n\n\n\nBye'], ['avatar', 'avatar_5_1700000009_abcdef12.png'],
    ['bg_image', '../bg_5_1.jpg/'], ['theme', 'galaxy'], ['layout', 'nope'],
    ['settings', { accent: '#AABBCC', hide_branding: true, entrance: { enabled: true, music: 'music_5_1700000007_abcdef12.mp3', volume: '30' }, custom_css: 'a{background:url(https://evil.com/x)}' }]])],
  ['blocks', [
    { id: 4, type: 'booking', data: { title: 'Book me', url: '/kalender' }, visible: true },
    { id: '5', type: 'file', data: { title: 'CV', src: '' } },
    { id: 'n1', type: 'link', data: { title: 'Secret', url: 'https://secret.example' }, protection: 'password', password: 'secret123', effect: 'pulse' },
    { id: 1, type: 'heading', data: { text: 'Foreign id' } },
    { id: 'n2', type: 'gallery', data: { images: [{ src: 'gal_5_1700000005_abcdef12.png' }, { src: 'gal_6_1700000005_abcdef12.png' }] } },
    { id: 'n3', type: 'link', data: { title: 'No pw' }, protection: 'password' },
    { id: 'n4', type: 'embed', data: { url: 'https://vimeo.com/1' } },
    { id: 'n5', type: 'embed', data: { url: 'https://vimeo.com/2' } },
    { id: 7, type: 'text', data: { text: 'first' } },
    { id: 7, type: 'text', data: { text: 'second' }, schedule: { enabled: true, days: [5, 1], from: '09:00', to: '17:00' } },
    { id: 'n6', type: 'unknown' },
    'not-an-array',
    { id: true, type: 'divider', data: { style: 'dots' } },
    { id: '0012', type: 'divider' },
    { id: '@block:Gallery', type: 'gallery', data: { images: [{ src: 'gal_5_1700000006_abcdef12.png' }] } },
    { id: '@block:Thumb', type: 'link', data: { title: 'Thumb', url: 'https://x.de', thumb: 'thumb_5_1700000004_abcdef12.webp' }, protection: 'password', password: '' },
    { id: null, type: 'link', data: { title: 'null id' } },
  ]],
]);

const SAVE_2 = {
  page: { title: 'Mia', theme: 'minimal', settings: { hide_branding: true } },
  blocks: [
    { id: '@idmap:n1', type: 'link', data: { title: 'Secret', url: 'https://secret.example' }, protection: 'password', password: '' },
    { id: '@idmap:n2', type: 'gallery', data: { images: [] } },
    { id: 'x', type: 'link', data: { title: 'New pw' }, protection: 'password', password: 'another-pass' },
  ],
};

// Prüfung des Pakets: ein Fehler mitten im Speichern macht alles rückgängig (auch die schon geschriebene Seite);
// Block-IDs als Kommazahl (-0.0 heißt in der idmap "-0", 5.0 ist die 5); tief verschachtelte Namen in einer
// Einbettungs-Adresse fallen wie in PHP weg (max_input_nesting_level), statt das Speichern abzubrechen
const SAVE_FAIL_PASSWORD = {
  page: { title: 'Never saved' },
  blocks: [{ id: 'n1', type: 'heading', data: { text: 'first' } }, { id: 'n2', type: 'link', data: { title: 'pw' }, protection: 'password', password: 'abc\u0000defgh' }],
};
const SAVE_FAIL_EMBED = {
  page: { title: 'Never saved either', theme: 'galaxy' },
  blocks: [{ id: 'n1', type: 'text', data: { text: 'first' } }, { id: 'n2', type: 'embed', data: { url: 'https://youtube.com/watch?v[]=dQw4w9WgXcQ' } }],
};
const SAVE_3 = new O([
  ['page', { title: 'Mia', theme: 'minimal' }],
  ['blocks', [
    { id: '@idmap:x', type: 'link', data: { title: 'Kept' } },
    new O([['id', new Raw('-0.0')], ['type', 'divider'], ['data', { style: 'dots' }]]),
    { id: 'n9', type: 'embed', data: { url: 'https://youtube.com/watch?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG&v' + '[]'.repeat(65) + '=1' } },
    new O([['id', new Raw('5.0')], ['type', 'text'], ['data', { text: 'float id' }]]),
    new O([['id', new Raw('-5.0')], ['type', 'text'], ['data', { text: 'negative float id' }]]),
    new O([['id', new Raw('1e15')], ['type', 'text'], ['data', { text: 'big float id' }]]),
    { id: '12', type: 'divider' },
  ]],
]);

const SCENARIO: Array<[string, unknown[]]> = [
  // Ausgangslage: Dateien auf Mias Seite, eine Code-Seite mit Upload, Statistik und Nachrichten
  sql(`UPDATE pages SET avatar = 'avatar_5_1700000001_abcdef12.png', bg_image = 'bg_5_1700000002_abcdef12.jpg',
    settings = '{"entrance":{"music":"music_5_1700000007_abcdef12.mp3","enabled":true},"hide_branding":true,"zzz":5}' WHERE id = 2`),
  sql(`INSERT INTO page_blocks (page_id, type, position, is_visible, data, schedule, protection, password_hash, effect, clicks, created_at)
    VALUES (2, 'link', 6, 1, '{"title":"Thumb","url":"https://x.de","thumb":"thumb_5_1700000004_abcdef12.webp"}', NULL, 'password', '${FIXED_HASH}', 'shine', 4, '2026-01-01 00:00:00')`),
  sql(`INSERT INTO page_blocks (page_id, type, position, is_visible, data, created_at)
    VALUES (2, 'gallery', 7, 1, '{"images":[{"src":"gal_5_1700000005_abcdef12.png","caption":"Gallery"},{"src":"gal_5_1700000006_abcdef12.png"}],"ratio":"square"}', '2026-01-01 00:00:00')`),
  sql(`INSERT INTO code_sites (user_id, slug, title, is_published, is_blocked, views, created_at, updated_at) VALUES (5, 'mia-code', 'Mia Code', 1, 0, 0, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`),
  sql(`INSERT INTO code_files (site_id, path, content, updated_at) SELECT id, 'index.html', '<img src="/static/uploads/img_5_1700000003_abcdef12.png"> <a href="static/uploads/legacy%20name.png">x</a>', '2026-01-01 00:00:00' FROM code_sites WHERE user_id = 5`),
  sql(`INSERT INTO block_clicks_daily (block_id, item, day, page_id, clicks) VALUES (6, '', '2026-10-01', 2, 3), (8, '', '2026-10-01', 2, 1), (4, '', '2026-10-02', 2, 2),
    (1, '', '2026-10-01', 1, 7), (6, 'x', '2026-10-03', 3, 1), (9, 'instagram', '2026-10-03', 4, 2)`),
  sql(`INSERT INTO stats_daily (page_id, day, views, clicks) VALUES (2, '2026-10-01', 5, 1), (3, '2026-10-01', 2, 0), (2, '2026-10-02', 1, 1)`),
  sql(`INSERT INTO messages (page_id, user_id, name, email, message, is_read, created_at) VALUES (2, 5, 'a', 'b', 'c', 0, '2026-10-01 10:00:00'), (3, 6, 'd', 'e', 'f', 1, '2026-10-01 11:00:00')`),
  // Kalender auf Toms Seite: geschützt (Passwort/Alter), versteckt, zeitgesteuert, fremd
  sql(`INSERT INTO page_blocks (page_id, type, position, is_visible, data, schedule, protection, password_hash, effect, created_at) VALUES
    (3, 'booking', 4, 1, '{"title":"PwCal","url":"/kalender"}', NULL, 'password', 'H1', 'none', '2026-01-01 00:00:00'),
    (3, 'booking', 5, 1, '{"title":"AgeCal","url":"http://tom.oys.test:8080/kalender"}', NULL, 'age', NULL, 'none', '2026-01-01 00:00:00'),
    (3, 'booking', 6, 0, '{"title":"Hidden","url":"/kalender"}', NULL, 'none', NULL, 'none', '2026-01-01 00:00:00'),
    (3, 'booking', 7, 1, '{"title":"Later","url":"/kalender"}', '{"enabled":true,"days":[],"from":"","to":"","start":"2099-01-01T00:00","end":""}', 'none', NULL, 'none', '2026-01-01 00:00:00')`),
  ['page_files', ['@page:mia']],
  ['used_files', [5]],
  ['calendar_access', ['@page:tom', '']],
  ['calendar_access', ['@page:tom', '@calkey:PwCal']],
  ['calendar_access', ['@page:tom', '@calkey:AgeCal']],
  ['calendar_access', ['@page:tom', 'wrong']],
  ['calendar_access', ['@page:mia', '']],
  ['calendar_access', ['@page:pixel', '']],
  // Speichern: neue, geänderte, doppelte, fremde und entfernte Blöcke, Passwörter, Warnungen, Dateien
  ['save_page', ['@page:mia', SAVE_1, 5, false]],
  SNAPSHOT,
  ['page_files', ['@page:mia']],
  ['save_page', ['@page:mia', SAVE_2, 5, true]],
  SNAPSHOT,
  ['save_page', ['@page:mia', SAVE_FAIL_PASSWORD, 5, false]],
  SNAPSHOT,
  ['save_page', ['@page:mia', SAVE_FAIL_EMBED, 5, true]],
  SNAPSHOT,
  ['save_page', ['@page:mia', SAVE_3, 5, false]],
  SNAPSHOT,
  ['save_page', ['@page:tom', { page: { title: 'Tom' }, blocks: [] }, 6, false]],
  SNAPSHOT,
  ['used_files', [5]],
  ['cleanup_files', [5, ['img_5_1700000003_abcdef12.png', 'avatar_6_1700000008_abcdef12.png', 'legacy name.png', '../escape_5_1700000010_abcdef12.png',
    'unused_5_1700000011_abcdef12.png', 5, null, 'missing_5_1700000012_abcdef12.png', 'unused_5_1700000011_abcdef12.png']]],
  ['cleanup_files', [5, []]],
  ['cleanup_files', [5, ['dir_5_1700000013_abcdef12.png', 'dir_5_1700000013_abcdef12.png/', ' unused_5_1700000011_abcdef12.png']]],
  // Lea: Seite und Blöcke nicht als Array (alles wird geleert), danach mehr als 150 Blöcke (nur 150 zählen)
  ['save_page', ['@page:lea', { page: 'nope', blocks: 'nope' }, 7, false]],
  ['save_page', ['@page:lea', { page: { title: 'Lea' }, blocks: Array.from({ length: 152 }, (_, i) => ({ id: 'n' + i, type: 'divider', data: { style: i % 2 ? 'dots' : 'wave' } })) }, 7, false]],
  SNAPSHOT,
  // Anlegen, Benutzernamen, Löschen
  ['create_page', [5, 'mia2', 'Mia Zwei 🐝']],
  ['create_page', [7, 'lea-b', 'x'.repeat(130)]],
  SNAPSHOT,
  ['create_page', [5, 'mia', 'dup']],
  ['sync_username', [7]],
  ['sync_username', [8]],
  SNAPSHOT,
  ['sync_username', [99]],
  sql(`UPDATE users SET username = 'lea-b' WHERE id = 8`),
  ['delete_page', ['@page:lea']],
  SNAPSHOT,
  ['sync_username', [7]],
  ['delete_page', ['@page:mia2']],
  SNAPSHOT,
  ['delete_page', ['@page:mia']],
  SNAPSHOT,
  ['sync_username', [5]],
  ['used_files', [5]],
  ['used_files', [6]],
  // Kalender auf Toms (inzwischen leerer) Seite: Start mit \n am Ende gilt wie in PHP (der öffentliche Block startet erst
  // 2099 und bleibt deshalb aus – nur wenn die Zeitsteuerung wirklich gelesen wird); ein ungültiges Datum wirft
  sql(`INSERT INTO page_blocks (page_id, type, position, is_visible, data, schedule, protection, password_hash, effect, created_at) VALUES
    (3, 'booking', 4, 1, '{"title":"NlFuture","url":"/kalender"}', '{"enabled":true,"days":[],"from":"","to":"","start":"2099-01-01T10:00\\\\n","end":""}', 'none', NULL, 'none', '2026-01-01 00:00:00'),
    (3, 'booking', 5, 1, '{"title":"NlCal","url":"/kalender"}', '{"enabled":true,"days":[],"from":"","to":"","start":"2026-01-01T10:00\\\\n","end":""}', 'password', 'H2', 'none', '2026-01-01 00:00:00')`),
  ['calendar_access', ['@page:tom', '']],
  ['calendar_access', ['@page:tom', '@calkey:NlCal']],
  sql(`INSERT INTO page_blocks (page_id, type, position, is_visible, data, schedule, protection, password_hash, effect, created_at) VALUES
    (3, 'booking', 0, 1, '{"title":"Broken","url":"/kalender"}', '{"enabled":true,"days":[],"from":"","to":"","start":"2026-13-45T25:61","end":""}', 'none', NULL, 'none', '2026-01-01 00:00:00')`),
  ['calendar_access', ['@page:tom', '']],
];

// Platzhalter: @page:<slug> → ID, @idmap:<Editor-ID> → neue ID aus dem letzten Speichern, @block:<Titel> → Block-ID,
// @calkey:<Titel> → Kalender-Schlüssel dieses Blocks
const PHP_SCENARIO = `
  $last = []; $out = [];
  $resolve = function ($v) use (&$resolve, &$last, $pdo) {
    if (is_string($v) && str_starts_with($v, '@page:')) { $s = $pdo->prepare('SELECT id FROM pages WHERE slug = ?'); $s->execute([substr($v, 6)]); $id = $s->fetchColumn(); return $id === false ? null : (int) $id; }
    if (is_string($v) && str_starts_with($v, '@idmap:')) return $last[substr($v, 7)] ?? null;
    if (is_string($v) && str_starts_with($v, '@block:')) { $s = $pdo->prepare("SELECT id FROM page_blocks WHERE JSON_VALUE(data, '$.title') = ? OR JSON_VALUE(data, '$.images[0].caption') = ?"); $s->execute([substr($v, 7), substr($v, 7)]); return (int) $s->fetchColumn(); }
    if (is_array($v)) { foreach ($v as $k => $x) $v[$k] = $resolve($x); }
    return $v;
  };
  foreach ($in as [$op, $args]) {
    try {
      $args = $resolve($args);
      switch ($op) {
        case 'sql': $pdo->exec($args[0]); $r = null; break;
        case 'dump': $r = []; foreach ($args as $t) $r[$t] = $pdo->query('SELECT ' . ($t === 'users' ? 'id, email, username' : '*') . " FROM \`$t\` ORDER BY 1, 2, 3")->fetchAll(); break;
        case 'create_page': $r = oys_create_page($pdo, $args[0], $args[1], $args[2]); break;
        case 'save_page': $r = oys_save_page($pdo, oys_load_page($pdo, $args[0]), $args[1], $args[2], $args[3]); $last = (array) $r['idmap']; break;
        case 'delete_page': oys_delete_page($pdo, oys_load_page($pdo, $args[0])); $r = null; break;
        case 'sync_username': oys_sync_username($pdo, $args[0]); $r = null; break;
        case 'used_files': $r = array_map('strval', array_keys(oys_used_files($pdo, $args[0]))); break;
        case 'cleanup_files': oys_cleanup_files($pdo, $args[0], $args[1]); $r = null; break;
        case 'page_files': $r = oys_page_files(oys_load_page($pdo, $args[0]), oys_load_blocks($pdo, $args[0])); break;
        case 'calendar_access':
          $page = oys_load_page($pdo, $args[0]);
          $given = $args[1];
          if (str_starts_with($given, '@calkey:')) foreach (oys_load_blocks($pdo, $args[0]) as $b) if (($b['data']['title'] ?? '') === substr($given, 8)) $given = oys_calendar_key($page, $b);
          $r = oys_calendar_access($pdo, $page, $given);
          break;
      }
      $out[] = json_encode($r, ${FLAGS});
    } catch (Throwable $e) { $out[] = 'THROW'; }
  }
  echo json_encode($out);`;

async function nodeScenario(ops: Array<[string, unknown[]]>): Promise<string[]> {
  let last: Record<string, number> = {};
  const resolve = async (v: unknown): Promise<unknown> => {
    if (typeof v === 'string' && v.startsWith('@page:')) {
      const id = await value('SELECT id FROM pages WHERE slug = ?', [v.slice(6)]);
      return id === null ? null : Number(id);
    }
    if (typeof v === 'string' && v.startsWith('@idmap:')) return Object.hasOwn(last, v.slice(7)) ? last[v.slice(7)] : null;
    if (typeof v === 'string' && v.startsWith('@block:')) {
      return Number(await value("SELECT id FROM page_blocks WHERE JSON_VALUE(data, '$.title') = ? OR JSON_VALUE(data, '$.images[0].caption') = ?", [v.slice(7), v.slice(7)]));
    }
    if (Array.isArray(v)) return Promise.all(v.map(resolve));
    if (isArr(v)) return phpArray(await Promise.all(entries(v).map(async ([k, x]): Promise<[string, unknown]> => [k, await resolve(x)])));
    return v;
  };
  const out: string[] = [];
  for (const [op, rawArgs] of ops) {
    try {
      const args = (await resolve(rawArgs)) as unknown[];
      let r: unknown = null;
      switch (op) {
        case 'sql': await exec(args[0] as string); break;
        case 'dump': {
          const tables: Record<string, unknown> = {};
          for (const t of args as string[]) tables[t] = await q(`SELECT ${t === 'users' ? 'id, email, username' : '*'} FROM \`${t}\` ORDER BY 1, 2, 3`);
          r = tables;
          break;
        }
        case 'create_page': r = await createPage(args[0] as number, args[1] as string, args[2] as string); break;
        case 'save_page': {
          const res = await savePage((await loadPage(args[0] as number))!, args[1] as PhpArr, args[2] as number, args[3] as boolean);
          last = res.idmap;
          r = res;
          break;
        }
        case 'delete_page': await deletePage((await loadPage(args[0] as number))!); break;
        case 'sync_username': await syncUsername(args[0] as number); break;
        case 'used_files': r = [...(await usedFiles(args[0] as number))]; break;
        case 'cleanup_files': await cleanupFiles(args[0] as number, args[1] as unknown[]); break;
        case 'page_files': r = pageFiles((await loadPage(args[0] as number))!, await loadBlocks(args[0] as number)); break;
        case 'calendar_access': {
          const page = (await loadPage(args[0] as number))!;
          let given = args[1] as string;
          if (given.startsWith('@calkey:')) for (const b of await loadBlocks(args[0] as number)) if ((b.data as Record<string, unknown>).title === given.slice(8)) given = calendarKey(page, b);
          r = await calendarAccess(page, given);
          break;
        }
      }
      out.push(enc(r));
    } catch {
      out.push('THROW');
    }
  }
  return out;
}

// ---------------------------------------------------------------- Vergleich

// Welches der Test-Passwörter passt zu einem Hash (einmal je Hash prüfen – bcrypt ist absichtlich langsam)
const labels = new Map<string, Promise<string>>();
function hashLabel(h: string): Promise<string> {
  if (!labels.has(h)) {
    labels.set(h, (async () => {
      for (const pw of PASSWORDS) if (await passwordVerify(pw, h)) return 'BCRYPT:' + pw;
      return 'BCRYPT:unknown';
    })());
  }
  return labels.get(h)!;
}

// Zeitstempel „jetzt“ und neue bcrypt-Hashes (zufälliges Salz) vereinheitlichen – die Hashes vorher prüfen
async function normalize(v: unknown, hashes: string[]): Promise<unknown> {
  if (typeof v === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(v)) {
    const t = strtotime(v);
    if (t !== false && t >= started - 2 && t <= time() + 2) return 'NOW';
  }
  if (typeof v === 'string' && /^\$2y\$10\$[./A-Za-z0-9]{53}$/.test(v) && v !== FIXED_HASH) {
    hashes.push(v);
    return hashLabel(v);
  }
  if (Array.isArray(v)) return Promise.all(v.map((x) => normalize(x, hashes)));
  if (v && typeof v === 'object') return Object.fromEntries(await Promise.all(Object.entries(v).map(async ([k, x]) => [k, await normalize(x, hashes)])));
  return v;
}

// Dasselbe auf dem JSON-Text der Rückgaben: alles andere bleibt Byte für Byte (auch die Reihenfolge der Schlüssel)
async function normText(json: string, hashes: string[]): Promise<string> {
  let out = json.replace(/"(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)"/g, (m, ts: string) => {
    const t = strtotime(ts);
    return t !== false && t >= started - 2 && t <= time() + 2 ? '"NOW"' : m;
  });
  for (const h of new Set([...out.matchAll(/\$2y\$10\$[./A-Za-z0-9]{53}/g)].map((m) => m[0]).filter((x) => x !== FIXED_HASH))) {
    hashes.push(h);
    out = out.split(h).join(await hashLabel(h));
  }
  return out;
}

async function dump(db: string): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const t of TABLES) out[t] = (await admin.query<RowDataPacket[]>(`SELECT * FROM \`${db}\`.\`${t}\` ORDER BY 1, 2, 3`))[0];
  return out;
}

const listing = (side: 'php' | 'node') => ({
  uploads: readdirSync(dirs(side).uploads).sort(),
  base: readdirSync(dirs(side).base).sort(),
});

test('creating, saving, deleting and cleaning up pages writes exactly what PHP writes', async () => {
  const config = (side: 'php' | 'node'): ConfigData => ({ ...BASE, db: { ...(BASE.db as ConfigData), name: DBS[side] }, uploads_dir: dirs(side).uploads });
  const ops = jsonDecode(jsonText(SCENARIO)) as Array<[string, unknown[]]>;
  const phpOut = JSON.parse(runPhp(PHP_SCENARIO, jsonText(SCENARIO), { config: config('php'), db: true })) as string[];

  setConfigForTests(config('node'));
  await closePool();
  let nodeOut: string[];
  try {
    nodeOut = await nodeScenario(ops);
  } finally {
    await closePool();
    setConfigForTests(BASE);
  }

  const hashes: { php: string[]; node: string[] } = { php: [], node: [] };
  const norm = async (list: string[], side: 'php' | 'node') => Promise.all(list.map((x) => normText(x, hashes[side])));
  const phpNorm = await norm(phpOut, 'php');
  const nodeNorm = await norm(nodeOut, 'node');
  const mismatches = SCENARIO.map((op, i) => ({ i, op: op[0], node: nodeNorm[i], php: phpNorm[i] })).filter((m) => m.node !== m.php);
  assert.deepEqual(mismatches, []);

  // Rückgaben stichprobenartig: Warnungen einmalig, idmap in Block-Reihenfolge, Fehler beim doppelten Namen
  const save1 = jsonDecode(phpNorm[SCENARIO.findIndex((o) => o[0] === 'save_page')]) as { idmap: Record<string, number>; warnings: string[] };
  assert.deepEqual(Object.keys(save1.idmap), ['n1', '1', 'n2', 'n3', 'n4', 'n5', '0012']);
  assert.equal(save1.warnings.length, 2);
  assert.equal(phpOut[SCENARIO.findIndex((o) => o[0] === 'create_page' && o[1][1] === 'mia')], 'THROW');
  // Die beiden abgebrochenen Speichervorgänge ändern nichts; danach: idmap mit "-0" und der Playlist aus der tiefen Adresse
  const at = (save: unknown) => SCENARIO.findIndex((o) => o[0] === 'save_page' && o[1][1] === save);
  assert.equal(phpOut[at(SAVE_FAIL_PASSWORD)], 'THROW');
  assert.equal(phpOut[at(SAVE_FAIL_EMBED)], 'THROW');
  assert.equal(phpNorm[at(SAVE_FAIL_PASSWORD) + 1], phpNorm[at(SAVE_FAIL_PASSWORD) - 1]);
  assert.equal(phpNorm[at(SAVE_FAIL_EMBED) + 1], phpNorm[at(SAVE_FAIL_PASSWORD) - 1]);
  const save3 = jsonDecode(phpNorm[at(SAVE_3)]) as { idmap: Record<string, number>; blocks: Array<{ data: Record<string, unknown> }> };
  // (Block 5 hat SAVE_2 entfernt, Block 12 gehört zu Toms Seite: beide werden neu angelegt; Reihenfolge wie in PHP)
  assert.deepEqual(Object.keys(save3.idmap), ['-0', 'n9', '5', '-5', '1.0E+15', '12']);
  assert.ok(save3.blocks.some((b) => b.data.provider === 'youtube'));
  // Kalender: Schlüssel über den Block mit \n im Start, Fehler beim ungültigen Datum
  const cal = SCENARIO.map((o, i) => [o, phpOut[i]] as const).filter(([o]) => o[0] === 'calendar_access').map(([, r]) => r);
  assert.deepEqual(cal.slice(-3).map((r) => (r === 'THROW' || r === 'null' ? r : 'KEY')), ['null', 'KEY', 'THROW']);
  // Lea: 150 von 152 Blöcken
  const lea = jsonDecode(phpNorm[SCENARIO.findIndex((o) => o[0] === 'save_page' && o[1][0] === '@page:lea' && (o[1][1] as { page: unknown }).page !== 'nope')]) as { blocks: unknown[]; idmap: Record<string, number> };
  assert.equal(lea.blocks.length, 150);
  assert.equal(Object.keys(lea.idmap).length, 150);

  // Tabellen
  // (die Login-Hashes der Nutzer sind auf beiden Seiten gleich und zählen hier nicht mit)
  const phpDb = await normalize(await dump(DBS.php), []);
  const nodeDb = await normalize(await dump(DBS.node), []);
  for (const t of TABLES) assert.deepEqual((nodeDb as Record<string, unknown>)[t], (phpDb as Record<string, unknown>)[t], `table ${t}`);
  // Die Zeitsteuerung mit \n steht wirklich als gültiges JSON in der Tabelle (sonst wäre sie null und der Block immer an)
  const nlRow = (phpDb as Record<string, Array<Record<string, unknown>>>).page_blocks.find((b) => String(b.data).includes('NlFuture'));
  assert.equal((jsonDecode(String(nlRow?.schedule)) as { start: string }).start, '2099-01-01T10:00\n');
  // Neue Passwörter wurden gehasht (die Seite ist am Ende gelöscht – geprüft wird an den Rückgaben von save_page)
  const saved = phpNorm.join('\n');
  assert.ok(saved.includes('BCRYPT:secret123') && saved.includes('BCRYPT:another-pass') && !saved.includes('BCRYPT:unknown'));

  // PHP akzeptiert die Hashes, die Node geschrieben hat
  const phpVerify = JSON.parse(runPhp('echo json_encode(array_map(fn($h) => password_verify("secret123", $h) || password_verify("another-pass", $h), $in));', JSON.stringify(hashes.node))) as boolean[];
  assert.ok(hashes.node.length > 0 && phpVerify.every(Boolean));

  // Dateien: dieselben gelöscht und behalten (auch die eine außerhalb des Ordners über '../')
  assert.deepEqual(listing('node'), listing('php'));
  assert.ok(!listing('php').uploads.includes('avatar_5_1700000001_abcdef12.png') && listing('php').uploads.includes('img_5_1700000003_abcdef12.png'));
});
