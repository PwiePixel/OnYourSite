// Wochenbericht: lib/report.php und cron/weekly_report.php gegen src/app/report.ts und src/cli/weekly-report.ts.
// 1. Daten, HTML und die Werte für die Mail – auf einer Kopie der Testdatenbank mit erzeugten Zahlen (Trend mit halben
//    Prozenten, Titel mit HTML, Plattformen, gelöschte Blöcke …). PHP bekommt einen Ersatz für sendCustomEmail(), der
//    die Argumente aufzeichnet (die Mail selbst prüft mail.test.ts für jede Vorlage). Gleichstände beim besten Link
//    löst seed() auf – bei einem Gleichstand legt sich nur Node fest (eigener Test).
// 2. Der Lauf über alle Nutzer (oys_run_weekly_reports) samt weekly_report_sent_at.
// 3. Der Befehl selbst: PHP aus einer Kopie des Codes (eigene config.php) und Node, beide über einen kleinen SMTP-Server
//    mit STARTTLS – verglichen werden Ausgabe, Rückgabewert, Datenbank und die zugestellten Mails.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { ROOT_DIR, configString, loadConfig, setConfigForTests, type ConfigData } from '../src/config.js';
import { closePool, exec, q } from '../src/db.js';
import { date, time } from '../src/php.js';
import { setMailDirForTests } from '../src/mail.js';
import { dayYmd, runWeeklyReports, sendWeeklyReport, setReportMailerForTests, weeklyReportData, weeklyReportHtml } from '../src/app/report.js';
import { weeklyReportCli } from '../src/cli/weekly-report.js';
import { enc, rng, runPhp } from './modelHarness.js';
import { SmtpSink } from './support/smtpSink.js';
import { decodeWords, header, leaves, parseMessage } from './support/mime.js';
import { ensureSchema } from '../src/schema.js';

const BASE = loadConfig();
const SOURCE = configString('db.name');
const DB = SOURCE + '_report';
const CONFIG: ConfigData = { ...BASE, db: { ...(BASE.db as Record<string, string>), name: DB } };
let admin: Connection;
let dir = '';
const USERS: number[] = [];

// ---------------------------------------------------------------- Aufbau

before(async () => {
  admin = await mysql.createConnection({ host: configString('db.host', 'localhost'), user: configString('db.user', ''), password: configString('db.pass', ''), charset: 'utf8mb4_unicode_ci' });
  const [tables] = await admin.query<RowDataPacket[]>(`SHOW TABLES FROM \`${SOURCE}\``);
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  for (const row of tables) {
    const t = String(Object.values(row)[0]);
    await admin.query(`CREATE TABLE \`${DB}\`.\`${t}\` LIKE \`${SOURCE}\`.\`${t}\``);
    await admin.query(`INSERT INTO \`${DB}\`.\`${t}\` SELECT * FROM \`${SOURCE}\`.\`${t}\``);
  }
  await closePool();
  setConfigForTests(CONFIG);
  // Die Kopie kommt aus der Test-Datenbank: auf den neuesten Stand des Schemas bringen
  await ensureSchema();
  dir = mkdtempSync(join(tmpdir(), 'oys-report-'));
  await seed();
});

after(async () => {
  setReportMailerForTests(undefined);
  setMailDirForTests(null);
  await closePool();
  setConfigForTests(BASE);
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.end();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// Erzeugte Nutzer, Seiten, Blöcke und Zahlen (fester Startwert). Tage relativ zu CURDATE() in der Zeitzone der Seite:
// gestern bis vor 7 Tagen = diese Woche, vor 8 bis 14 Tagen = Woche davor; heute und vor 15 Tagen zählen nicht.
async function seed(): Promise<void> {
  const r = rng(20261102);
  const names = [null, '', '0', 'Zoë <b>"Q"</b> & Co', 'Max', '  spaced  ', "O'Neil {views}"];
  const sentAt = ['NULL', 'NOW() - INTERVAL 1 DAY', 'CURDATE()', 'CURDATE() - INTERVAL 1 SECOND', 'NOW() - INTERVAL 1 HOUR', "'2026-01-01 00:00:00'"];
  const datas = ['{"title":"<b>Shop</b> & more"}', '{"title":""}', '{"title":"0"}', '{"title":5}', '{"title":1.5}', '{"title":["x"]}', '{}', 'not json', '[]', '"str"', '5', 'null',
    '{"title":"{dashboard_url} link"}', '{"title":"Ünïcödé 🎧"}'];
  const types = ['link', 'file', 'image', 'socials', 'booking', 'heading', 'gallery', 'unknown'];
  const items = ['', '', '', 'instagram', 'youtube', 'nope', '5', 'email'];
  // Paare (diese Woche, Woche davor) mit Trend genau auf halben Prozenten und Rundungs-Grenzen
  const pairs: Array<[number, number]> = [[9, 8], [7, 8], [1, 2], [4, 3], [5, 6], [3, 2], [1, 8], [15, 8], [0, 4], [4, 0], [0, 0], [1, 1],
    [1001, 1000], [999, 1000], [1234567, 7654321], [2, 3], [1, 3], [5, 40], [11, 40], [7, 400], [2147, 1000]];
  for (let i = 0; i < 48; i++) {
    const id = 3000 + i;
    USERS.push(id);
    await exec(`INSERT INTO users (id, email, password, full_name, username, weekly_report, weekly_report_sent_at) VALUES (?, ?, 'x', ?, ?, ?, ${r.pick(sentAt)})`,
      [id, `wr${i}${r.chance(0.2) ? '-fail' : ''}@example.org`, r.pick(names), 'wr' + i, r.chance(0.7) ? 1 : 0]);
    const pageCount = i % 7 === 0 ? 0 : r.next(4);
    for (let k = 0; k < pageCount; k++) {
      const { insertId: pageId } = await exec("INSERT INTO pages (user_id, slug, position, title, subtitle, bio, theme, layout, address_mode, settings, created_at, updated_at) VALUES (?, ?, ?, ?, '', '', 'deep-dark', 'buttons', ?, '{}', NOW(), NOW())",
        [id, `wr${i}-p${k}`, r.next(2), 'Page ' + k, r.chance(0.3) ? 'path' : 'subdomain']);
      const [now, prev] = r.chance(0.6) ? r.pick(pairs) : [r.next(500), r.next(500)];
      // Zahlen auf mehrere Tage verteilt (dazu Tage, die nicht zählen)
      const spread = async (total: number, from: number, to: number): Promise<void> => {
        const a = r.next(total + 1);
        const days = [from + r.next(to - from + 1), from + r.next(to - from + 1)];
        if (days[0] === days[1]) days[1] = days[0] === to ? from : days[0] + 1;
        await exec('INSERT INTO stats_daily (page_id, day, views, clicks) VALUES (?, CURDATE() - INTERVAL ? DAY, ?, ?)', [pageId, days[0], a, r.next(50)]);
        await exec('INSERT INTO stats_daily (page_id, day, views, clicks) VALUES (?, CURDATE() - INTERVAL ? DAY, ?, ?)', [pageId, days[1], total - a, r.next(50)]);
      };
      if (now || r.chance(0.5)) await spread(now, 1, 7);
      if (prev || r.chance(0.5)) await spread(prev, 8, 14);
      if (r.chance(0.5)) await exec('INSERT INTO stats_daily (page_id, day, views, clicks) VALUES (?, CURDATE(), ?, ?)', [pageId, r.next(100), r.next(100)]);
      if (r.chance(0.5)) await exec('INSERT INTO stats_daily (page_id, day, views, clicks) VALUES (?, CURDATE() - INTERVAL 15 DAY, ?, ?)', [pageId, r.next(100), r.next(100)]);
      // Blöcke und Klicks
      const blockIds: number[] = [];
      for (let b = 0; b < r.next(5); b++) {
        const { insertId } = await exec('INSERT INTO page_blocks (page_id, type, position, is_visible, data, created_at) VALUES (?, ?, ?, 1, ?, NOW())',
          [pageId, r.pick(types), b, r.pick(datas)]);
        blockIds.push(insertId);
      }
      if (r.chance(0.3)) blockIds.push(900000 + i * 10 + k); // gelöschter Block
      for (const blockId of blockIds) {
        for (let c = 0; c < r.next(3); c++) {
          await exec('INSERT IGNORE INTO block_clicks_daily (block_id, item, day, page_id, clicks) VALUES (?, ?, CURDATE() - INTERVAL ? DAY, ?, ?)',
            [blockId, r.pick(items), r.next(16), pageId, r.chance(0.2) ? 0 : 1 + r.next(9)]);
        }
      }
    }
  }
  // Fest: ein Termin-Block ohne Titel (Name des Typs), ein unbekannter Typ („Link“) und ein Titel mit HTML als bester Link
  for (const [n, type, data] of [[0, 'booking', '{"url":"/kalender"}'], [1, 'mystery', '{}'], [2, 'link', '{"title":"<b>Shop</b> & more"}']] as const) {
    const id = 3100 + n;
    USERS.push(id);
    await exec("INSERT INTO users (id, email, password, full_name, username, weekly_report) VALUES (?, ?, 'x', 'Fixed', ?, 1)", [id, `fixed${n}@example.org`, 'fixed' + n]);
    const { insertId: pageId } = await exec("INSERT INTO pages (user_id, slug, position, title, subtitle, bio, theme, layout, address_mode, settings, created_at, updated_at) VALUES (?, ?, 0, 'Fixed', '', '', 'deep-dark', 'buttons', 'subdomain', '{}', NOW(), NOW())",
      [id, 'fixed-' + n]);
    const { insertId } = await exec('INSERT INTO page_blocks (page_id, type, position, is_visible, data, created_at) VALUES (?, ?, 0, 1, ?, NOW())', [pageId, type, data]);
    await exec("INSERT INTO block_clicks_daily (block_id, item, day, page_id, clicks) VALUES (?, '', CURDATE() - INTERVAL 2 DAY, ?, 99)", [insertId, pageId]);
  }
  // Kein Gleichstand beim besten Link: lib/report.php sortiert nur nach den Klicks, unter gleich oft geklickten Links
  // liefert MariaDB dann irgendeinen (je nach Ausführungsplan – auch im PHP- und im Node-Lauf verschieden). Node nimmt
  // bewusst den ersten nach block_id und item; dieser Link bekommt hier einen Klick mehr (gestern), damit PHP und Node
  // denselben nennen und alle Vergleiche exakt bleiben. Den Gleichstand selbst prüft ein eigener Test (nur Node).
  const groups = await q<{ page_id: number; block_id: number; item: string; clicks: string }>(`SELECT page_id, block_id, item, SUM(clicks) AS clicks
    FROM block_clicks_daily WHERE day BETWEEN CURDATE() - INTERVAL 7 DAY AND CURDATE() - INTERVAL 1 DAY
    GROUP BY page_id, block_id, item ORDER BY page_id, clicks DESC, block_id, item`);
  for (const [n, best] of groups.entries()) {
    if (n > 0 && groups[n - 1].page_id === best.page_id) continue; // nur der beste Link jeder Seite
    const next = groups[n + 1];
    if (next?.page_id === best.page_id && Number(best.clicks) > 0 && Number(next.clicks) === Number(best.clicks)) {
      await exec('INSERT INTO block_clicks_daily (block_id, item, day, page_id, clicks) VALUES (?, ?, CURDATE() - INTERVAL 1 DAY, ?, 1) ON DUPLICATE KEY UPDATE clicks = clicks + 1',
        [best.block_id, best.item, best.page_id]);
    }
  }
}

// PHP mit lib/report.php und einem Ersatz für sendCustomEmail() (zeichnet auf; Adressen mit „fail“ schlagen fehl)
function php(body: string, input: unknown): unknown {
  const out = runPhp(`
    $GLOBALS['calls'] = [];
    function sendCustomEmail(...$args) { $GLOBALS['calls'][] = $args; return strpos((string) $args[0], 'fail') === false; }
    require '${ROOT_DIR}/lib/report.php';
    ${body}`, JSON.stringify(input), { config: CONFIG, db: true });
  return JSON.parse(out);
}

// Node: dieselbe Aufzeichnung
const calls: unknown[][] = [];
function recordMails(): void {
  calls.length = 0;
  setReportMailerForTests(async (...args) => {
    calls.push(args);
    return !String(args[0]).includes('fail');
  });
}

// ---------------------------------------------------------------- 1. Daten, HTML, Mail

test('report data and HTML match PHP for every generated user', async () => {
  const ids = [...USERS, 3, 5, 6, 7, 8, 9];
  const phpOut = php(`
    $out = [];
    foreach ($in as $uid) {
      $r = oys_weekly_report_data($pdo, $uid);
      $out[] = json_encode(['from' => $r['from']->format('Y-m-d'), 'to' => $r['to']->format('Y-m-d'), 'views' => $r['views'], 'clicks' => $r['clicks'],
        'pages' => array_map(fn($p) => ['id' => (int) $p['page']['id'], 'views' => $p['views'], 'clicks' => $p['clicks'], 'prev' => $p['prev_views'], 'best' => $p['best']], $r['pages']),
        'html' => oys_weekly_report_html($r)], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }
    echo json_encode($out);`, ids) as string[];
  const nodeOut: string[] = [];
  for (const uid of ids) {
    const r = await weeklyReportData(uid);
    nodeOut.push(enc({ from: dayYmd(r.from), to: dayYmd(r.to), views: r.views, clicks: r.clicks,
      pages: r.pages.map((p) => ({ id: Number(p.page.id), views: p.views, clicks: p.clicks, prev: p.prev_views, best: p.best })),
      html: weeklyReportHtml(r) }));
  }
  for (let i = 0; i < ids.length; i++) assert.equal(nodeOut[i], phpOut[i], 'user ' + ids[i]);
  // Die Daten treffen die Zweige, für die sie gedacht sind
  const all = nodeOut.join('\n');
  for (const s of ['No links were clicked this week.', '🏆 Best link', '(1 click)', ' clicks)', '+13%', '-13%', '-50%', '+0%', 'Instagram', 'Book a meeting', '<strong style=\\"color:#ffffff;\\">Link</strong>', '&lt;b&gt;Shop&lt;/b&gt;']) {
    assert.ok(all.includes(s), 'covers ' + s);
  }
});

// Gleichstand beim besten Link – nur Node (PHP überlässt die Wahl MariaDB): Es gewinnt der Block mit der kleinsten ID,
// innerhalb eines Social-Blocks die Plattform nach dem Alphabet, auch wenn der andere Link seine Klicks früher bekam.
// Eigener Nutzer ohne Wochenbericht: Die Läufe über alle Nutzer (2. und 3.) schicken ihm nichts.
test('a tie for the best link goes to the first block, then to the first platform', async () => {
  const userId = 3200;
  await exec("INSERT INTO users (id, email, password, full_name, username, weekly_report) VALUES (?, 'tie@example.org', 'x', 'Tie', 'tie', 0)", [userId]);
  const page = async (position: number): Promise<number> => (await exec("INSERT INTO pages (user_id, slug, position, title, subtitle, bio, theme, layout, address_mode, settings, created_at, updated_at) VALUES (?, ?, ?, 'Tie', '', '', 'deep-dark', 'buttons', 'subdomain', '{}', NOW(), NOW())",
    [userId, 'tie-' + position, position])).insertId;
  const block = async (pageId: number, type: string, data: string): Promise<number> =>
    (await exec('INSERT INTO page_blocks (page_id, type, position, is_visible, data, created_at) VALUES (?, ?, 0, 1, ?, NOW())', [pageId, type, data])).insertId;
  const click = (pageId: number, blockId: number, item: string, daysAgo: number, clicks: number) =>
    exec('INSERT INTO block_clicks_daily (block_id, item, day, page_id, clicks) VALUES (?, ?, CURDATE() - INTERVAL ? DAY, ?, ?)', [blockId, item, daysAgo, pageId, clicks]);
  // Zwei Links mit je 7 Klicks …
  const links = await page(0);
  const older = await block(links, 'link', '{"title":"Older"}');
  const newer = await block(links, 'link', '{"title":"Newer"}');
  await click(links, newer, '', 7, 7);
  await click(links, older, '', 2, 4);
  await click(links, older, '', 1, 3);
  // … und zwei Plattformen eines Social-Blocks mit je 5 Klicks, dazu ein späterer Block mit ebenso vielen
  const socials = await page(1);
  const icons = await block(socials, 'socials', '{}');
  const later = await block(socials, 'link', '{"title":"Later"}');
  await click(socials, later, '', 6, 5);
  await click(socials, icons, 'youtube', 5, 5);
  await click(socials, icons, 'instagram', 3, 5);
  const report = await weeklyReportData(userId);
  assert.deepEqual(report.pages.map((p) => p.best), [{ title: 'Older', clicks: 7 }, { title: 'Instagram', clicks: 5 }]);
});

test('the mail gets the same values, subject and order of placeholders as in PHP', async () => {
  const ids = [...USERS, 3, 5, 8];
  const phpOut = php(`
    $out = [];
    foreach ($in as $uid) {
      $GLOBALS['calls'] = [];
      $u = $pdo->query('SELECT * FROM users WHERE id = ' . (int) $uid)->fetch();
      $ok = oys_send_weekly_report($pdo, $u);
      $out[] = json_encode(['ok' => $ok, 'calls' => $GLOBALS['calls']], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }
    echo json_encode($out);`, ids) as string[];
  recordMails();
  const nodeOut: string[] = [];
  for (const uid of ids) {
    calls.length = 0;
    const user = (await q('SELECT * FROM users WHERE id = ?', [uid]))[0];
    const ok = await sendWeeklyReport(user);
    nodeOut.push(enc({ ok, calls }));
  }
  for (let i = 0; i < ids.length; i++) assert.equal(nodeOut[i], phpOut[i], 'user ' + ids[i]);
  assert.ok(nodeOut.some((x) => x.includes('"ok":false,"calls":[]')), 'a user without pages sends nothing');
  assert.ok(nodeOut.some((x) => x.includes('view, ')), 'singular view');
  assert.ok(nodeOut.some((x) => x.includes('"full_name":"there"')), 'fallback name');
});

// ---------------------------------------------------------------- 2. Lauf über alle Nutzer

async function sentState(): Promise<string[]> {
  const now = time();
  return (await q('SELECT id, weekly_report_sent_at AS s, UNIX_TIMESTAMP(weekly_report_sent_at) AS u FROM users ORDER BY id')).map((r) =>
    `${r.id}:${r.s === null ? 'NULL' : Math.abs(now - Number(r.u)) <= 120 ? 'NOW' : String(r.s)}`);
}
async function restoreSent(state: Array<{ id: number; s: string | null }>): Promise<void> {
  for (const row of state) await exec('UPDATE users SET weekly_report_sent_at = ? WHERE id = ?', [row.s, row.id]);
}

test('running all reports sends, counts and marks the same users as PHP', async () => {
  const before = (await q('SELECT id, weekly_report_sent_at AS s FROM users')) as Array<{ id: number; s: string | null }>;
  const phpOut = php(`
    $r = oys_run_weekly_reports($pdo);
    echo json_encode(['result' => $r, 'to' => array_map(fn($c) => $c[0], $GLOBALS['calls'])]);`, null) as { result: unknown; to: unknown[] };
  const phpState = await sentState();
  await restoreSent(before);
  recordMails();
  const result = await runWeeklyReports();
  const nodeState = await sentState();
  await restoreSent(before);
  // Neu in Node: übersprungene Konten (alle Plätze zeigen Code-Seiten) – hier gibt es keine
  assert.equal(result.skipped, 0);
  assert.deepEqual({ result: { sent: result.sent, failed: result.failed }, to: calls.map((c) => c[0]) }, phpOut);
  assert.deepEqual(nodeState, phpState);
  assert.ok((phpOut.result as { sent: number }).sent > 3 && (phpOut.result as { failed: number }).failed > 3, JSON.stringify(phpOut.result));
});

// ---------------------------------------------------------------- 3. Der Befehl (PHP-Skript gegen Node)

// Kopie des PHP-Codes mit eigener config.php (Datenbank der Tests) und eigenem email/-Ordner. Kopiert statt verlinkt:
// __DIR__ zeigt in PHP auf das echte Verzeichnis einer verlinkten Datei.
function phpTree(cfg: ConfigData, smtp: Record<string, unknown> | null): string {
  const root = mkdtempSync(join(dir, 'php-'));
  for (const d of ['lib', 'cron', 'email']) mkdirSync(join(root, d));
  for (const f of readdirSync(join(ROOT_DIR, 'lib'))) copyFileSync(join(ROOT_DIR, 'lib', f), join(root, 'lib', f));
  copyFileSync(join(ROOT_DIR, 'cron/weekly_report.php'), join(root, 'cron/weekly_report.php'));
  for (const f of ['db.php', 'security.php', 'mail.php', 'blacklist.php']) copyFileSync(join(ROOT_DIR, f), join(root, f));
  symlinkSync(join(ROOT_DIR, 'PHPMailer'), join(root, 'PHPMailer'));
  for (const f of readdirSync(join(ROOT_DIR, 'email'))) if (f.endsWith('.json') && f !== 'smtp.json') copyFileSync(join(ROOT_DIR, 'email', f), join(root, 'email', f));
  if (smtp) writeFileSync(join(root, 'email/smtp.json'), JSON.stringify(smtp));
  execFileSync('php', ['-r', 'file_put_contents($argv[1], "<?php\\nreturn " . var_export(json_decode($argv[2], true), true) . ";\\n");', '--', join(root, 'config.php'), JSON.stringify(cfg)]);
  return root;
}

function runPhpCli(root: string, ca: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('php', ['-d', `openssl.cafile=${ca}`, join(root, 'cron/weekly_report.php')], { cwd: root }, (err, stdout, stderr) => {
      resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// Der Befehl in diesem Prozess (dieselbe Funktion wie node dist/cli/weekly-report.js), Ausgabe aufgefangen
// Ausgabe über eigene Empfänger (process.stdout zu ersetzen fing auch Nachrichten des Test-Runners ein)
async function runNodeCli(cfg: ConfigData, mailDir: string | null): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  setReportMailerForTests(undefined);
  setMailDirForTests(mailDir);
  setConfigForTests(cfg);
  try {
    const code = await weeklyReportCli({ out: async (text) => void out.push(text), err: (line) => void err.push(line) });
    return { code, stdout: out.join(''), stderr: err.join('\n') };
  } finally {
    setConfigForTests(CONFIG);
  }
}

// Zeile des Befehls: Zeit (Minute, Zeitzone der Seite) und Zahlen
function cliLine(stdout: string): string {
  const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) – Weekly reports sent: \d+, failed: \d+\n$/.exec(stdout);
  assert.ok(m, 'output line: ' + JSON.stringify(stdout));
  const t = Date.parse(m![1].replace(' ', 'T') + ':00Z');
  const local = Date.parse(date('Y-m-d H:i').replace(' ', 'T') + ':00Z');
  assert.ok(Math.abs(local - t) <= 120000, 'time of the run in the site time zone');
  return stdout.slice(m![1].length);
}

function mailSummary(raw: Buffer | null) {
  if (!raw) return null;
  const msg = parseMessage(raw);
  return {
    to: header(msg, 'to'),
    subject: decodeWords(header(msg, 'subject') ?? ''),
    parts: leaves(msg).map((p) => ({ type: p.type, body: p.body.toString('utf8').replace(/\r\n|\r|\n/g, '\n').replace(/\n+$/, '') })),
  };
}

test('the command prints the same line, sends the same mails and marks the same users as cron/weekly_report.php', async () => {
  // Zertifikate für STARTTLS (PHPMailer verlangt es bei jedem Port außer 465)
  const run = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=OnYourSite Report CA');
  run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'srv.key', '-out', 'srv.csr', '-subj', '/CN=localhost');
  writeFileSync(join(dir, 'ext.cnf'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
  run('x509', '-req', '-in', 'srv.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'srv.pem', '-days', '2', '-extfile', 'ext.cnf');
  const ca = readFileSync(join(dir, 'ca.pem'), 'utf8');
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), ca]);
  const sink = new SmtpSink({ user: 'noreply@on-your.site', pass: 'secret' }, { key: readFileSync(join(dir, 'srv.key')), cert: readFileSync(join(dir, 'srv.pem')) });
  const port = await sink.listen('127.0.0.1', 0, false);
  sink.behavior = { startTls: true };
  try {
    const smtp = { host: '127.0.0.1', port: String(port), username: 'noreply@on-your.site', password: 'secret', from_email: 'noreply@on-your.site', from_name: 'OnYourSite' };
    const root = phpTree(CONFIG, smtp);
    const before = (await q('SELECT id, weekly_report_sent_at AS s FROM users')) as Array<{ id: number; s: string | null }>;

    sink.sessions = [];
    const phpRun = await runPhpCli(root, join(dir, 'ca.pem'));
    const phpMails = sink.sessions.map((s) => mailSummary(s.data));
    const phpState = await sentState();
    await restoreSent(before);

    sink.sessions = [];
    const nodeRun = await runNodeCli(CONFIG, join(root, 'email'));
    const nodeMails = sink.sessions.map((s) => mailSummary(s.data));
    const nodeState = await sentState();
    await restoreSent(before);

    assert.equal(nodeRun.code, phpRun.code);
    assert.equal(cliLine(nodeRun.stdout), cliLine(phpRun.stdout));
    assert.ok(/sent: [1-9]\d*, failed: [1-9]/.test(phpRun.stdout), phpRun.stdout);
    assert.deepEqual(nodeMails, phpMails);
    assert.deepEqual(nodeState, phpState);
    assert.ok(phpMails.length > 3 && phpMails.every((m) => m && /^Your weekly report: /.test(m.subject)));

    // Zweiter Lauf am selben Tag: niemand bekommt die Mail doppelt (nur die bisher fehlgeschlagenen werden versucht)
    await runPhpCli(root, join(dir, 'ca.pem'));
    sink.sessions = [];
    const phpAgain = await runPhpCli(root, join(dir, 'ca.pem'));
    const phpAgainMails = sink.sessions.length;
    const phpAgainState = await sentState();
    await restoreSent(before);
    await runNodeCli(CONFIG, join(root, 'email'));
    sink.sessions = [];
    const nodeAgain = await runNodeCli(CONFIG, join(root, 'email'));
    assert.equal(cliLine(nodeAgain.stdout), cliLine(phpAgain.stdout));
    assert.equal(sink.sessions.length, phpAgainMails);
    assert.deepEqual(await sentState(), phpAgainState);
    assert.ok(/sent: 0, failed: [1-9]/.test(phpAgain.stdout), phpAgain.stdout);
    await restoreSent(before);

    // Ohne smtp.json: alles schlägt fehl, nichts wird markiert
    const noMail = phpTree(CONFIG, null);
    const p = await runPhpCli(noMail, join(dir, 'ca.pem'));
    const n = await runNodeCli(CONFIG, join(noMail, 'email'));
    assert.equal(cliLine(n.stdout), cliLine(p.stdout));
    assert.ok(/sent: 0, failed: [1-9]/.test(p.stdout), p.stdout);
    assert.equal(n.code, 0);
    assert.equal(p.code, 0);
  } finally {
    await sink.close();
  }
});

test('without a database the command prints the setup page and ends with 0 like PHP', async () => {
  const broken: ConfigData = { ...CONFIG, db: { ...(CONFIG.db as Record<string, string>), name: 'oys_missing_' + Date.now() } };
  const root = phpTree(broken, null);
  const phpRun = await runPhpCli(root, '/dev/null');
  await closePool();
  const nodeRun = await runNodeCli(broken, null);
  await closePool();
  assert.equal(phpRun.code, 0);
  assert.equal(nodeRun.code, 0);
  // Gleiche Seite – die Node-Version nennt config.json statt config.php (wie der Server)
  assert.equal(nodeRun.stdout, phpRun.stdout.replace('<code>config.php</code>', '<code>config.json</code>'));
  assert.match(phpRun.stdout, /^<!DOCTYPE html>.*Database connection failed\./s);
  assert.match(nodeRun.stderr, /^DB connection failed: /);
});
