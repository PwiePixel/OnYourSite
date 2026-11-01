// Statistik und Kontaktformular gegen PHP: dieselben Aufrufe (Aufrufe/Klicks zählen, Auswertung, eigene Seite?,
// Kontakt prüfen, Nachricht speichern, Benachrichtigung) laufen in PHP und Node auf je einer frischen Kopie der
// Test-Datenbank. Rückgaben, versandte E-Mails und alle betroffenen Tabellen müssen übereinstimmen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, setConfigForTests } from '../src/config.js';
import { closePool, exec, value } from '../src/db.js';
import { decryptData, hmac } from '../src/crypto.js';
import { strtotime, time } from '../src/php.js';
import { makeTestCtx } from '../src/web/ctx.js';
import { loadPage } from '../src/content/pages.js';
import { recordClick, recordView, requestFromOwnSite, stats } from '../src/content/stats.js';
import { contactCheck, notify, setMailerForTests, storeMessage } from '../src/content/messages.js';
import { jsonDecode } from '../src/content/util.js';
import type { PhpArray } from '../src/php.js';
import { copyDatabase, configWith, runPhp, type DbCopies } from './filesHarness.js';
import { enc, FLAGS, jsonText } from './modelHarness.js';

const BASE = loadConfig();
const TABLES = ['pages', 'page_blocks', 'stats_daily', 'block_clicks_daily', 'messages', 'notifications', 'rate_limits'];
let dbs: DbCopies;
let started = 0;

before(async () => {
  dbs = await copyDatabase('f');
  started = time();
});

after(async () => {
  setConfigForTests(BASE);
  await closePool();
  await dbs.drop();
});

const sql = (s: string): [string, unknown[]] => ['sql', [s]];
const now = time();
const token = (pageId: number, blockId: string, at: number) => at + '.' + hmac(pageId + '|' + blockId + '|' + at).slice(0, 32);

// Blöcke für die Auswertung: alle Typen, Klicks heute, gestern, vor 100 und vor 400 Tagen, Social-Plattformen
const SETUP: Array<[string, unknown[]]> = [
  sql('DELETE FROM rate_limits'),
  sql(`INSERT INTO page_blocks (id, page_id, type, position, is_visible, data, clicks, created_at) VALUES
    (20, 2, 'socials', 0, 1, '{"items":[{"p":"instagram","v":"mia"},{"p":"tiktok","v":""},{"p":"email","v":"mia@test.de"},{"p":"website","v":"mia.design"},{"p":"nope","v":"x.de"}],"style":"icons"}', 0, '2026-01-01 00:00:00'),
    (21, 2, 'image', 10, 1, '{"src":"","url":"https://img.example","title":""}', 0, '2026-01-01 00:00:00'),
    (22, 2, 'image', 11, 1, '{"src":"","url":""}', 0, '2026-01-01 00:00:00'),
    (23, 2, 'countdown', 12, 1, '{"title":"Release","target":"2027-01-01T00:00"}', 0, '2026-01-01 00:00:00'),
    (24, 2, 'embed', 13, 1, '[]', 0, '2026-01-01 00:00:00'),
    (25, 2, 'link', 14, 1, '{"title":"","url":"https://x.de","icon":"brand:github"}', 2, '2026-01-01 00:00:00'),
    (26, 2, 'link', 15, 0, '{"title":5,"url":7,"icon":["a"]}', 1, '2026-01-01 00:00:00'),
    (27, 2, 'gallery', 16, 1, '{"images":[]}', 0, '2026-01-01 00:00:00'),
    (30, 3, 'socials', 0, 1, '{"items":"broken"}', 0, '2026-01-01 00:00:00'),
    (31, 4, 'socials', 0, 1, '{"items":[{"v":"no platform"}]}', 0, '2026-01-01 00:00:00'),
    (32, 1, 'socials', 9, 1, '{"items":["text"]}', 0, '2026-01-01 00:00:00')`),
  sql(`INSERT INTO stats_daily (page_id, day, views, clicks) VALUES
    (2, CURDATE(), 10, 3), (2, CURDATE() - INTERVAL 1 DAY, 7, 0), (2, CURDATE() - INTERVAL 6 DAY, 1, 1), (2, CURDATE() - INTERVAL 29 DAY, 5, 2),
    (2, CURDATE() - INTERVAL 100 DAY, 9, 4), (2, CURDATE() - INTERVAL 400 DAY, 3, 3), (2, CURDATE() + INTERVAL 3 DAY, 2, 2),
    (3, CURDATE() - INTERVAL 2 DAY, 4, 1), (1, CURDATE() - INTERVAL 125 DAY, 80, 23)`),
  sql(`INSERT INTO block_clicks_daily (block_id, item, day, page_id, clicks) VALUES
    (20, 'instagram', CURDATE(), 2, 4), (20, 'email', CURDATE() - INTERVAL 40 DAY, 2, 2), (20, 'website', CURDATE() - INTERVAL 1 DAY, 2, 6),
    (21, '', CURDATE(), 2, 3), (23, '', CURDATE() - INTERVAL 200 DAY, 2, 1), (8, '', CURDATE(), 2, 6), (8, '', CURDATE() - INTERVAL 1 DAY, 2, 3),
    (25, '', CURDATE(), 2, 6), (4, '', CURDATE() - INTERVAL 10 DAY, 2, 2), (11, '', CURDATE(), 3, 1)`),
];

const PAGE_MIA = '@page:mia';
const OPS: Array<[string, unknown[]]> = [
  ...SETUP,
  // Zählen
  ['record_view', [2]], ['record_view', [2]], ['record_view', [4]], ['record_view', [999]],
  ['record_click', [2, 8, '']], ['record_click', [2, 20, 'Instagram']], ['record_click', [2, 20, 'ÄÖ-Web_site!12345678901234567890xyz']],
  ['record_click', [3, 11, '']], ['record_click', [2, 999, 'x']],
  // Auswertung
  ['stats', [PAGE_MIA, 7]], ['stats', [PAGE_MIA, 30]], ['stats', [PAGE_MIA, 90]], ['stats', [PAGE_MIA, 0]], ['stats', [PAGE_MIA, 1]], ['stats', [PAGE_MIA, -5]],
  ['stats', ['@page:tom', 0]], ['stats', ['@page:pixel', 0]], ['stats', ['@page:lea', 0]], ['stats', ['@page:lea', 7]],
  sql("UPDATE page_blocks SET data = '{\"items\":[{\"p\":\"instagram\",\"v\":\"x\"}]}' WHERE id = 31"),
  ['stats', ['@page:lea', 7]],
  sql('DELETE FROM stats_daily WHERE page_id = 3'),
  ['stats', ['@page:tom', 0]],
  // Eigene Seite?
  ['own_site', [null, null]], ['own_site', ['', 'https://evil.example/']], ['own_site', ['null', null]], ['own_site', ['http://oys.test:8080', null]],
  ['own_site', ['https://MIA.OYS.TEST', null]], ['own_site', ['https://evil.example', 'http://mia.oys.test:8080/']], ['own_site', [null, 'http://mia.oys.test/x']],
  ['own_site', [null, 'http://xoys.test/']], ['own_site', ['http:///broken', null]], ['own_site', ['oys.test', null]], ['own_site', [null, '//oys.test/x']],
  // Kontaktformular (Block 6 von Mia steht hier für den Formular-Block)
  ['contact', [PAGE_MIA, '6', { website: ' x ', t: 'bad' }, '1.2.3.4']],
  ['contact', [PAGE_MIA, '6', { t: 'bad' }, '1.2.3.4']],
  ['contact', [PAGE_MIA, '6', { t: token(2, '7', now - 10) }, '1.2.3.4']],
  ['contact', [PAGE_MIA, '6', { t: token(2, '6', now + 60), name: 'A', message: 'Hello there' }, '1.2.3.4']],
  ['contact', [PAGE_MIA, '6', { t: token(2, '6', now + 500), name: 'A', message: 'Hello there' }, '1.2.3.4']],
  ['contact', [PAGE_MIA, '6', { t: token(2, '6', now - 90000), name: 'A', message: 'Hello there' }, '1.2.3.4']],
  ['contact', [PAGE_MIA, '6', { t: token(2, '6', now - 10) + '\n', name: '', message: 'Hello there', email: 'a@b.de' }, '1.2.3.4']],
  ['contact', [PAGE_MIA, '6', { t: token(2, '6', now - 10), name: 'Tom', message: '  \u0001 ', email: 'a@b.de' }, '1.2.3.4']],
  ['contact', [PAGE_MIA, '6', { t: token(2, '6', now - 10), name: 'Tom', message: 'Hello there', email: 'not-an-email' }, '1.2.3.4']],
  ['contact', [PAGE_MIA, '6', { t: token(2, '6', now - 10), name: 'Tom', message: 'Hello there', email: 'a'.repeat(185) + '@b.de' }, '1.2.3.4']],
  ['contact', [PAGE_MIA, '6', { t: token(2, '6', now - 10), name: 'Tom', message: 'Hi', email: 'a@b.de' }, '1.2.3.4']],
  ['contact', [PAGE_MIA, '6', { t: token(2, '6', now - 10), name: 'Tom', message: 'Buy cheap followers now', email: 'a@b.de' }, '1.2.3.4']],
  ['contact', [PAGE_MIA, '6', { t: ['x'], name: 'Tom', message: 'Hello there', email: 'a@b.de' }, '1.2.3.4']],
  ['contact', [PAGE_MIA, '6', { website: ['x'], t: 'bad' }, '1.2.3.4']],
  ...Array.from({ length: 6 }, (): [string, unknown[]] => ['contact', [PAGE_MIA, '6', { t: token(2, '6', now - 10), name: 'Tom', message: 'Hello there', email: ' tom@test.de ' }, '1.2.3.4']]),
  ['contact', [PAGE_MIA, '6', { t: token(2, '6', now - 10), name: 'Lea', message: 'Hello there', email: 'lea@test.de' }, '2001:db8::1']],
  ['contact', [PAGE_MIA, '6', { t: token(2, '6', now - 10), name: 'Lea', message: 'Hello there', email: 'lea@test.de' }, '2001:db8::2']],
  ['contact', [PAGE_MIA, '6', { t: token(2, '6', now - 10), name: 'Lea', message: 'Hello there', email: 'lea@test.de' }, '10.0.0.1']],
  // Nachrichten speichern (E-Mail nur mit notify_email; Platzhalter in Name und Nachricht)
  ['store', [PAGE_MIA, { name: '  Tom <b>\u202E', email: ' tom@test.de ', message: 'Hallo {message} &\r\n\r\n\r\n\r\nzweite Zeile ' + 'x'.repeat(130) }]],
  ['store', ['@page:tom', { name: '0', email: 'a@b.de', message: '0' }]],
  sql(`UPDATE pages SET settings = '{"notify_email":false}' WHERE id = 3`),
  ['store', ['@page:tom', { name: 'Ann', email: 'ann@example.com', message: 'No mail please' }]],
  sql(`UPDATE pages SET settings = 'not json', title = 'Lea Page' WHERE id = 4`),
  sql(`UPDATE users SET full_name = '' WHERE id = 7`),
  ['store', ['@page:lea', { name: 'Bob', email: 'bob@example.com', message: 'Für Lea 🐝' }]],
  ['store', ['@page:lea', { name: ['x'], message: 'Array name' }]],
  // Benachrichtigungen
  ['notify', [5, 'booking', 'T'.repeat(200), 'B'.repeat(300), '/dashboard#messages']],
  ['notify', [6, 'x', '🐝'.repeat(195), '', '']],
  ['dump', TABLES],
];

const PHP_SCENARIO = `
  $out = [];
  $resolve = function ($v) use (&$resolve, $pdo) {
    if (is_string($v) && str_starts_with($v, '@page:')) { $s = $pdo->prepare('SELECT id FROM pages WHERE slug = ?'); $s->execute([substr($v, 6)]); $id = $s->fetchColumn(); return $id === false ? null : (int) $id; }
    if (is_array($v)) { foreach ($v as $k => $x) $v[$k] = $resolve($x); }
    return $v;
  };
  foreach ($in as [$op, $args]) {
    try {
      $args = $resolve($args);
      $GLOBALS['mails'] = [];
      unset($_SERVER['HTTP_ORIGIN'], $_SERVER['HTTP_REFERER']);
      switch ($op) {
        case 'sql': $pdo->exec($args[0]); $r = null; break;
        case 'dump': $r = null; break;
        case 'record_view': oys_record_view($pdo, $args[0]); $r = null; break;
        case 'record_click': oys_record_click($pdo, $args[0], $args[1], $args[2]); $r = null; break;
        case 'stats': $r = oys_stats($pdo, oys_load_page($pdo, $args[0]), $args[1]); break;
        case 'own_site':
          if ($args[0] !== null) $_SERVER['HTTP_ORIGIN'] = $args[0];
          if ($args[1] !== null) $_SERVER['HTTP_REFERER'] = $args[1];
          $r = oys_request_from_own_site(); break;
        case 'contact': $_SERVER['REMOTE_ADDR'] = $args[3]; $r = oys_contact_check($pdo, oys_load_page($pdo, $args[0]), $args[1], $args[2]); break;
        case 'store': $r = [oys_store_message($pdo, oys_load_page($pdo, $args[0]), $args[1]), $GLOBALS['mails']]; break;
        case 'notify': oys_notify($pdo, $args[0], $args[1], $args[2], $args[3], $args[4]); $r = null; break;
      }
      $out[] = json_encode($r, ${FLAGS});
    } catch (Throwable $e) { $out[] = 'THROW'; }
  }
  echo json_encode($out);`;

async function nodeScenario(ops: Array<[string, unknown[]]>): Promise<string[]> {
  const mails: unknown[][] = [];
  setMailerForTests(async (to, template, vars, subject, replyTo) => {
    mails.push([to, template, vars, subject, replyTo]);
    return true;
  });
  const resolve = async (v: unknown): Promise<unknown> => {
    if (typeof v === 'string' && v.startsWith('@page:')) {
      const id = await value('SELECT id FROM pages WHERE slug = ?', [v.slice(6)]);
      return id === null ? null : Number(id);
    }
    if (Array.isArray(v)) return Promise.all(v.map(resolve));
    return v;
  };
  const out: string[] = [];
  try {
    for (const [op, rawArgs] of ops) {
      mails.length = 0;
      try {
        const args = (await resolve(rawArgs)) as unknown[];
        let r: unknown = null;
        switch (op) {
          case 'sql': await exec(args[0] as string); break;
          case 'dump': break;
          case 'record_view': await recordView(args[0] as number); break;
          case 'record_click': await recordClick(args[0] as number, args[1] as number, args[2] as string); break;
          case 'stats': r = await stats((await loadPage(args[0] as number))!, args[1] as number); break;
          case 'own_site': {
            const headers: Record<string, string> = {};
            if (args[0] !== null) headers.origin = args[0] as string;
            if (args[1] !== null) headers.referer = args[1] as string;
            r = requestFromOwnSite(makeTestCtx({ url: '/_/v', method: 'POST', headers }));
            break;
          }
          case 'contact': {
            const ctx = makeTestCtx({ url: '/_/contact', method: 'POST', ip: args[3] as string });
            r = await contactCheck(ctx, (await loadPage(args[0] as number))!, args[1] as string, args[2] as PhpArray);
            break;
          }
          case 'store': r = [await storeMessage((await loadPage(args[0] as number))!, args[1] as PhpArray), [...mails]]; break;
          case 'notify': await notify(args[0] as number, args[1] as string, args[2] as string, args[3] as string, args[4] as string); break;
        }
        out.push(enc(r));
      } catch {
        out.push('THROW');
      }
    }
  } finally {
    setMailerForTests(undefined);
  }
  return out;
}

// Zeitstempel von „jetzt“ und verschlüsselte Werte (zufälliger IV) vereinheitlichen
function normalize(json: string): string {
  return json
    .replace(/"(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)"/g, (m, ts: string) => {
      const t = strtotime(ts);
      return t !== false && t >= started - 2 && t <= time() + 2 ? '"NOW"' : m;
    })
    .replace(/ENC:[A-Za-z0-9+/=]+/g, (m) => 'DEC(' + String(decryptData(m)) + ')');
}

test('stats, contact checks, messages and notifications write exactly what PHP writes', async () => {
  const phpOut = JSON.parse(runPhp(PHP_SCENARIO, jsonText(OPS), { config: configWith(BASE, dbs.names.php), db: true })) as string[];
  setConfigForTests(configWith(BASE, dbs.names.node));
  await closePool();
  let nodeOut: string[];
  try {
    nodeOut = await nodeScenario(jsonDecode(jsonText(OPS)) as Array<[string, unknown[]]>);
  } finally {
    await closePool();
    setConfigForTests(BASE);
  }
  const mismatches = OPS.map((op, i) => ({ i, op: op[0], args: JSON.stringify(op[1]).slice(0, 120), node: normalize(nodeOut[i]).slice(0, 1500), php: normalize(phpOut[i]).slice(0, 1500) }))
    .filter((m) => m.node !== m.php);
  assert.deepEqual(mismatches, []);

  // Tabellen (Zeitstempel „jetzt“ und verschlüsselte Werte vereinheitlicht)
  const phpDb = await dbs.dump(dbs.names.php, TABLES);
  const nodeDb = await dbs.dump(dbs.names.node, TABLES);
  for (const t of TABLES) assert.deepEqual(jsonDecode(normalize(JSON.stringify(nodeDb[t]))), jsonDecode(normalize(JSON.stringify(phpDb[t]))), `table ${t}`);

  // Stichproben: Wochen-Bündel, ctr, Fehler bei kaputten Social-Daten, Rate-Limit nach 5 Nachrichten, E-Mail mit Platzhaltern
  const idx = (op: string, n = 0) => OPS.map((o, i) => [o[0], i] as [string, number]).filter(([o]) => o === op)[n][1];
  const all = jsonDecode(phpOut[idx('stats', 3)]) as { bucket: number; series: unknown[] };
  assert.equal(all.bucket, 7);
  assert.equal(phpOut[idx('stats', 7)], 'THROW');
  const contacts = OPS.map((o, i) => [o[0], i] as [string, number]).filter(([o]) => o === 'contact').map(([, i]) => phpOut[i]);
  assert.ok(contacts.some((c) => c.includes('A lot of messages')));
  assert.ok(normalize(phpOut[idx('store')]).includes('"new_message"'));
});
