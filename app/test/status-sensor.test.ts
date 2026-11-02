// Statusseiten, Sensor (local.ts): Messungen (Tunnel, Webseite direkt mit Host-Kopf, Speicher, Mail-Server alle
// 10 Minuten), status_probe, die Datei mit den Adressen der Admins (0600), der Wächter (Prüfdienst still → Glocke und
// E-Mail höchstens einmal je Stunde) und Alarme ganz ohne Datenbank (nach 2 Minuten, einmal je Stunde, und „back“).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RowDataPacket } from 'mysql2/promise';
import { setConfigForTests, type ConfigData } from '../src/config.js';
import { closePool } from '../src/db.js';
import { ensureSchema } from '../src/schema.js';
import { runSensor, type SensorOptions } from '../src/status/local.js';
import { BASE, testDatabase, type TestDb } from './coreHarness.js';
import { hasOpenssl, testPki, type TestPki } from './helpers/certs.js';
import { startTargets, type Targets } from './helpers/targets.js';

let db: TestDb;
let pki: TestPki;
let t: Targets;
let stateDir = '';
const skip = !hasOpenssl();

async function q(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  await db.admin.query(`USE \`${db.name}\``);
  return (await db.admin.query<RowDataPacket[]>(sql, params))[0];
}

before(async () => {
  if (skip) return;
  db = await testDatabase('st2sensor');
  await ensureSchema();
  pki = testPki();
  const leaf = pki.leaf(['site.zz']);
  t = await startTargets({ byName: new Map([['site.zz', leaf]]), fallback: leaf });
  stateDir = mkdtempSync(join(tmpdir(), 'oys-status-state-'));
});

after(async () => {
  if (skip) return;
  await t.close();
  pki.done();
  rmSync(stateDir, { recursive: true, force: true });
  await db.done();
});

interface Mail {
  to: string;
  subject: string;
  text: string;
}

function options(mails: Mail[], o: Partial<SensorOptions> = {}): SensorOptions {
  return {
    stateDir,
    tunnel: true,
    tunnelUrl: `http://127.0.0.1:${t.httpPort}/_/health`,
    originUrl: `http://127.0.0.1:${t.httpPort}/_/health`,
    originHost: 'oys.test',
    diskPaths: [tmpdir()],
    smtp: false,
    sendMail: async (to, subject, _title, text) => {
      mails.push({ to, subject, text });
      return true;
    },
    log: () => undefined,
    ...o,
  };
}

const admins = async (): Promise<string[]> => (await q('SELECT email FROM users WHERE is_admin = 1 ORDER BY id')).map((r) => String(r.email));

test('measurements are stored as status_probe; the admins\' addresses are kept in a private file', { skip }, async () => {
  let verified = 0;
  const mails: Mail[] = [];
  const at = Date.now();
  const report = await runSensor(options(mails, { now: () => at, smtp: true, smtpVerify: async () => ++verified > 0 }));
  assert.equal(report.db, true);
  assert.deepEqual((report.probe.tunnel as { ok: boolean }).ok, true);
  assert.deepEqual((report.probe.origin as { ok: boolean }).ok, true);
  assert.ok(typeof (report.probe.disk as { free_pct: number }).free_pct === 'number');
  assert.deepEqual(report.probe.smtp, { ok: true, at: Math.floor(at / 1000) });
  const stored = JSON.parse(String((await q("SELECT meta_value FROM oys_meta WHERE meta_key = 'status_probe'"))[0].meta_value)) as Record<string, unknown>;
  assert.equal(stored.at, Math.floor(at / 1000));
  // Der Ursprung wurde mit dem Host der Seite gefragt
  assert.ok(t.seen.some((s) => s.host === 'oys.test' && s.path === '/_/health'));
  // SMTP nur alle 10 Minuten
  await runSensor(options(mails, { now: () => at + 60_000, smtp: true, smtpVerify: async () => ++verified > 0 }));
  assert.equal(verified, 1);
  await runSensor(options(mails, { now: () => at + 601_000, smtp: true, smtpVerify: async () => ++verified > 0 }));
  assert.equal(verified, 2);
  // Adressen der Admins (nur für den Besitzer lesbar)
  const file = join(stateDir, 'alert-contacts.json');
  const contacts = JSON.parse(readFileSync(file, 'utf8')) as { admins: string[] };
  assert.deepEqual(contacts.admins, await admins());
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(stateDir, 'sensor.json')).mode & 0o777, 0o600);
  // Ein Tunnel, der nicht antwortet
  const bad = await runSensor(options(mails, { now: () => at + 700_000, tunnelUrl: `http://127.0.0.1:${t.httpPort}/500` }));
  assert.equal((bad.probe.tunnel as { ok: boolean }).ok, false);
  assert.equal(mails.length, 0);
});

test('the watchdog: a silent checker gives each admin a bell notice and an email, at most once an hour', { skip }, async () => {
  const mails: Mail[] = [];
  const now = Date.now();
  await q("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('status_worker', ?)", [JSON.stringify({ at: Math.floor(now / 1000) - 600 })]);
  await q("DELETE FROM notifications WHERE type = 'status'");
  const first = await runSensor(options(mails, { now: () => now }));
  const list = await admins();
  assert.equal(first.alerts.filter((a) => a.startsWith('watchdog:')).length, list.length);
  assert.ok(mails.every((m) => m.text.startsWith('Status checks have stopped on ') && m.text.endsWith('Check: journalctl -u onyoursite-status')));
  const bells = await q("SELECT title, link FROM notifications WHERE type = 'status'");
  assert.equal(bells.length, list.length);
  assert.deepEqual([bells[0].title, bells[0].link], ['Status checks have stopped', '/admin#status']);
  // Innerhalb einer Stunde nichts mehr
  const again = await runSensor(options(mails, { now: () => now + 30 * 60_000 }));
  assert.equal(again.alerts.length, 0);
  assert.equal((await q("SELECT COUNT(*) AS n FROM notifications WHERE type = 'status'"))[0].n, list.length);
  // Läuft der Prüfdienst wieder, ist alles still
  await q("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('status_worker', ?)", [JSON.stringify({ at: Math.floor(now / 1000) + 7200 })]);
  assert.equal((await runSensor(options(mails, { now: () => now + 2 * 3600_000 }))).alerts.length, 0);
});

test('without a database: after 2 minutes the sensor writes to the admins itself, once an hour, then "back"', { skip }, async () => {
  const mails: Mail[] = [];
  const now = Date.now();
  const list = await admins();
  await closePool();
  setConfigForTests({ ...BASE, db: { ...(BASE.db as ConfigData), name: db.name, host: '127.0.0.1', port: '1' }, uploads_dir: db.uploads });
  try {
    const down1 = await runSensor(options(mails, { now: () => now }));
    assert.equal(down1.db, false);
    assert.equal(down1.alerts.length, 0, 'not before 2 minutes');
    const down2 = await runSensor(options(mails, { now: () => now + 121_000 }));
    assert.deepEqual(down2.alerts, list.map((a) => 'db-down:' + a));
    assert.match(mails[0].text, /^The database on .+ isn’t reachable since \d\d:\d\d – the website answers 503\.$/);
    assert.match(mails[0].subject, /^\[Down\] Database – /);
    const down3 = await runSensor(options(mails, { now: () => now + 30 * 60_000 }));
    assert.equal(down3.alerts.length, 0, 'at most once an hour');
    const down4 = await runSensor(options(mails, { now: () => now + 63 * 60_000 }));
    assert.equal(down4.alerts.length, list.length);
  } finally {
    await closePool();
    setConfigForTests({ ...BASE, db: { ...(BASE.db as ConfigData), name: db.name }, uploads_dir: db.uploads });
  }
  const back = await runSensor(options(mails, { now: () => now + 70 * 60_000 }));
  assert.equal(back.db, true);
  assert.deepEqual(back.alerts, list.map((a) => 'db-up:' + a));
  assert.equal((await runSensor(options(mails, { now: () => now + 71 * 60_000 }))).alerts.length, 0, '"back" only once');
});

// Prüfbericht: der Sensor merkte sich „schon gemeldet“ erst NACH dem Versand. Bricht systemd den Lauf ab (TimeoutStartSec
// 50 s, z. B. bei einem langsamen Mail-Server und mehreren Admins), fehlt der Eintrag – und die Meldung ging jede Minute
// erneut an alle, die sie schon hatten.
test('without a database: "already alerted" is stored before the emails go out', { skip }, async () => {
  const mails: Mail[] = [];
  const now = Date.now() + 10 * 3600_000;
  const stateOf = (): Record<string, unknown> => JSON.parse(readFileSync(join(stateDir, 'sensor.json'), 'utf8')) as Record<string, unknown>;
  // Ein Lauf mit Datenbank legt die Adressen der Admins ab
  await runSensor(options(mails, { now: () => now - 60_000 }));
  await closePool();
  setConfigForTests({ ...BASE, db: { ...(BASE.db as ConfigData), name: db.name, host: '127.0.0.1', port: '1' }, uploads_dir: db.uploads });
  try {
    await runSensor(options(mails, { now: () => now }));
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    let started = 0;
    const run = runSensor(options(mails, { now: () => now + 121_000, sendMail: async () => {
      started++;
      await slow;
      return true;
    } }));
    for (let i = 0; i < 250 && started === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(started, 1, 'the first email is on its way');
    assert.equal(stateOf().db_alert_at, Math.floor((now + 121_000) / 1000), 'stored before the first email');
    release();
    await run;
  } finally {
    await closePool();
    setConfigForTests({ ...BASE, db: { ...(BASE.db as ConfigData), name: db.name }, uploads_dir: db.uploads });
  }
  // Wieder da: auch „back“ wird vor dem Versand vermerkt
  let release!: () => void;
  const slow = new Promise<void>((r) => (release = r));
  let started = 0;
  const back = runSensor(options(mails, { now: () => now + 200_000, sendMail: async () => {
    started++;
    await slow;
    return true;
  } }));
  for (let i = 0; i < 250 && started === 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(started, 1);
  assert.equal(stateOf().db_down_since, null, '"back" is stored before the first email');
  release();
  await back;
});
