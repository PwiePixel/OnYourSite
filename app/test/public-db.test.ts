// Termin-Anfrage gegen PHP (views/kalender.php der PHP-Version, siehe support/phpRef.ts): dieselben gültigen Anfragen
// laufen in PHP und Node auf je einer frischen Kopie der Test-Datenbank. Weiterleitung, die E-Mail an den Besitzer
// (Vorlage, Platzhalter in ihrer Reihenfolge, Betreff, Antwortadresse) und alle betroffenen Tabellen müssen
// übereinstimmen – die Golden-Master-Suite vergleicht E-Mails nicht, weil es dort keinen SMTP-Server gibt. Ohne PHP
// laufen die Anfragen nur in Node (eigene Kopie) und werden an Stichproben geprüft.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, setConfigForTests } from '../src/config.js';
import { closePool, exec } from '../src/db.js';
import { decryptData, hmac } from '../src/crypto.js';
import { date, strtotime, time, type PhpArray } from '../src/php.js';
import { isHalt, makeTestCtx } from '../src/web/ctx.js';
import { loadPage } from '../src/content/pages.js';
import { jsonDecode } from '../src/content/util.js';
import { kalender, setBookingMailerForTests } from '../src/public/views/kalender.js';
import { copyDatabase, configWith, runPhp, type DbCopies } from './filesHarness.js';
import { phpRenderLibs } from './renderHarness.js';
import { PHP_SKIP, phpFile } from './support/phpRef.js';

const BASE = loadConfig();
const TABLES = ['user_bookings', 'notifications', 'rate_limits'];
let dbs: DbCopies;
let solo: DbCopies;
let started = 0;

before(async () => {
  dbs = await copyDatabase('pk');
  solo = await copyDatabase('pks');
  started = time();
});

after(async () => {
  setConfigForTests(BASE);
  await closePool();
  await dbs.drop();
  await solo.drop();
});

// Nur Seiten aus gm/pristine.sql; sql = Änderungen vor der Anfrage (in beiden Kopien gleich)
interface Scenario { pageId: number; key: string; host: string; sql?: string[]; post: Record<string, string | string[]> }

// Ein Tag in der Zukunft (Ortszeit der Seite) und ein gültiges Token wie im Formular
const inDays = (n: number): string => date('Y-m-d', time() + n * 86400);
const token = (pageId: number): string => {
  const ts = time() - 30;
  return ts + '.' + hmac('booking|' + pageId + '|' + ts).slice(0, 32);
};

const SCENARIOS: Scenario[] = [
  { pageId: 2, key: '', host: 'mia.oys.test:8080', post: { t: token(2), website: '', guest_name: 'Guest Person', guest_email: 'guest@example.org', booking_date: inDays(3), booking_time: '10:00' } },
  // Platzhalter im Namen, HTML, Steuerzeichen und Leerraum: Reihenfolge der Ersetzungen und e() wie in PHP
  { pageId: 2, key: '', host: 'mia.oys.test:8080', post: { t: token(2), website: ' ', guest_name: '  {guest_email} <b>&"\'</b>\u0007\u202e ', guest_email: ' a.b+c@example.org ', booking_date: inDays(0), booking_time: '16:00' } },
  // Besitzer ohne Namen: Seitentitel; Seite im Pfad-Modus mit geschütztem Kalender (Schlüssel in der Weiterleitung)
  { pageId: 4, key: 'k3y', host: 'oys.test:8080', sql: ["UPDATE pages SET address_mode = 'path' WHERE id = 4", "UPDATE users SET full_name = '' WHERE id = 7"], post: { t: token(4), guest_name: 'Zoë 🐝', guest_email: 'zoe@example.org', booking_date: inDays(365), booking_time: '09:00' } },
  // Besitzer ohne Konto (gelöscht): keine E-Mail, Eintrag und Glocke trotzdem
  { pageId: 3, key: '', host: 'tom.oys.test:8080', sql: ['UPDATE pages SET user_id = 99 WHERE id = 3'], post: { t: token(3), guest_name: 'Nobody', guest_email: 'n@example.org', booking_date: inDays(1), booking_time: '13:00' } },
];

const phpScript = (): string => `${phpRenderLibs()}
  $c = $in;
  foreach ($c['sql'] ?? [] as $sql) $pdo->exec($sql);
  $_SERVER['REQUEST_METHOD'] = 'POST';
  $_SERVER['REMOTE_ADDR'] = '10.0.0.1';
  $_SERVER['HTTP_HOST'] = $c['host'];
  $_GET = [];
  $_POST = $c['post'];
  $page = oys_load_page($pdo, $c['pageId']);
  $calendarKey = $c['key'];
  // oys_redirect() beendet mit exit: Status, Ziel ($okUrl – headers_list() ist auf der Kommandozeile leer) und
  // E-Mails am Ende ausgeben
  register_shutdown_function(function () {
    echo json_encode(['status' => http_response_code(), 'location' => $GLOBALS['okUrl'] ?? null, 'mails' => $GLOBALS['mails']], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  });
  include '${phpFile('views/kalender.php')}';`;

// Zeitstempel von „jetzt“ und verschlüsselte Werte (zufälliger IV) vereinheitlichen
function normalize(json: string): string {
  return json
    .replace(/"(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)"/g, (m, ts: string) => {
      const t = strtotime(ts);
      return t !== false && t >= started - 2 && t <= time() + 2 ? '"NOW"' : m;
    })
    .replace(/ENC:[A-Za-z0-9+/=]+/g, (m) => 'DEC(' + String(decryptData(m)) + ')');
}

// Die Anfragen in Node auf dieser Datenbank: Status, Ziel und die E-Mails je Anfrage
async function nodeRun(db: string): Promise<string[]> {
  setConfigForTests(configWith(BASE, db));
  await closePool();
  const nodeOut: string[] = [];
  const mails: unknown[][] = [];
  setBookingMailerForTests(async (to, template, vars, subject, replyTo) => {
    mails.push([to, template, vars, subject, replyTo]);
    return true;
  });
  try {
    for (const s of SCENARIOS) {
      mails.length = 0;
      for (const sql of s.sql ?? []) await exec(sql);
      const ctx = makeTestCtx({ method: 'POST', url: '/kalender', host: s.host, ip: '10.0.0.1', post: s.post as PhpArray });
      try {
        await kalender(ctx, (await loadPage(s.pageId))!, s.key);
      } catch (err) {
        if (!isHalt(err)) throw err;
      }
      nodeOut.push(JSON.stringify({ status: ctx.status, location: ctx.header('Location') ?? null, mails }));
    }
  } finally {
    setBookingMailerForTests(null);
    await closePool();
    setConfigForTests(BASE);
  }
  return nodeOut;
}

test('a valid booking request writes, notifies and mails the owner', async () => {
  const before = Number((await solo.dump(solo.names.node, ['user_bookings'])).user_bookings.length);
  const out = (await nodeRun(solo.names.node)).map((x) => JSON.parse(x) as { status: number; location: string; mails: unknown[][] });
  assert.deepEqual(out.map((o) => o.status), SCENARIOS.map(() => 303));
  assert.equal(out[2].location, 'http://oys.test:8080/lea/kalender?k=k3y&ok=1');
  assert.deepEqual(out.map((o) => o.mails.length), [1, 1, 1, 0]);
  assert.equal(out[0].mails[0][1], 'new_booking');
  assert.equal((await solo.dump(solo.names.node, ['user_bookings'])).user_bookings.length, before + SCENARIOS.length);
});

test('a valid booking request writes, notifies and mails exactly like views/kalender.php', { skip: PHP_SKIP }, async () => {
  // PHP: jede Anfrage in einem eigenen Prozess (exit), alle auf derselben Kopie
  const phpOut: string[] = [];
  for (const s of SCENARIOS) phpOut.push(runPhp(phpScript(), JSON.stringify(s), { config: configWith(BASE, dbs.names.php), db: true }));
  const nodeOut = await nodeRun(dbs.names.node);

  for (let i = 0; i < SCENARIOS.length; i++) {
    assert.deepEqual(jsonDecode(normalize(nodeOut[i])), jsonDecode(normalize(phpOut[i])), `scenario ${i}`);
    assert.equal((JSON.parse(phpOut[i]) as { status: number }).status, 303, `scenario ${i} reaches the success redirect`);
  }
  assert.equal((JSON.parse(phpOut[2]) as { location: string }).location, 'http://oys.test:8080/lea/kalender?k=k3y&ok=1');
  assert.equal((JSON.parse(phpOut[3]) as { mails: unknown[] }).mails.length, 0);

  const phpDb = await dbs.dump(dbs.names.php, TABLES);
  const nodeDb = await dbs.dump(dbs.names.node, TABLES);
  for (const t of TABLES) assert.deepEqual(jsonDecode(normalize(JSON.stringify(nodeDb[t]))), jsonDecode(normalize(JSON.stringify(phpDb[t]))), `table ${t}`);
});
