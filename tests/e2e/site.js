// Gemeinsame Hilfen der Browser-Abläufe, die die Seite selbst starten (Editor, Profilseiten, Glocke): Einstellungen
// (nur mit einer Test-Datenbank), SQL über den mysql-Client und die Seite als eigener Prozess mit einer Kopie der
// Einstellungen, deren base_domain auf den Port des Laufs zeigt (so stimmen erzeugte Adressen, z. B. die Vorschau).
// Umgebung: OYS_CONFIG (Vorgabe config.json im Projekt), OYS_E2E_PORT.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { ROOT, sleep } = require('./lib');

// Einstellungen lesen; mit jeder anderen als einer Test-Datenbank (Name beginnt mit oys_test) Abbruch mit Code 2,
// bevor irgendetwas die Datenbank aufruft
function testSite(defaultPort) {
  const file = process.env.OYS_CONFIG || path.join(ROOT, 'config.json');
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const db = cfg.db || {};
  const name = String(db.name || '');
  if (!name.startsWith('oys_test') || !/^[A-Za-z0-9_]+$/.test(name)) {
    console.error(`Refusing to run: the database "${name}" is not a test database (oys_test…).`);
    process.exit(2);
  }
  const port = Number(process.env.OYS_E2E_PORT || defaultPort);
  const host = String(cfg.base_domain || 'oys.test').split(':')[0].toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host) || !Number.isInteger(port)) throw new Error('invalid host or port');

  const args = ['--default-character-set=utf8mb4', '-N'].concat(db.host ? ['-h', String(db.host)] : [], db.user ? ['-u', String(db.user)] : [], [name]);
  const sql = (q) => execFileSync('mysql', args, { input: q, env: { ...process.env, MYSQL_PWD: String(db.pass || process.env.MYSQL_PWD || '') } }).toString().trim();

  let server = null;
  let tmpDir = '';
  let log = '';
  // Die Seite mit dem aktuellen Code (tsx src/server.ts) und einer Kopie der Einstellungen (nur für den Besitzer lesbar)
  async function start() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oys-e2e-site-'));
    const conf = path.join(tmpDir, 'config.json');
    fs.writeFileSync(conf, JSON.stringify({ ...cfg, base_domain: host + ':' + port }), { mode: 0o600 });
    server = spawn(path.join(ROOT, 'app/node_modules/.bin/tsx'), ['src/server.ts'], {
      cwd: path.join(ROOT, 'app'), env: { ...process.env, PORT: String(port), OYS_CONFIG: conf }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', (d) => (log += d));
    server.stderr.on('data', (d) => (log += d));
    for (let i = 0; i < 150; i++) {
      if (log.includes('listening')) return;
      if (server.exitCode !== null) break;
      await sleep(200);
    }
    throw new Error('server did not start:\n' + log);
  }
  function stop() {
    if (server) server.kill();
    server = null;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  }
  return {
    cfg, host, port, base: 'http://' + host + ':' + port, sql, count: (q) => Number(sql(q)), start, stop, log: () => log,
    // Chromium: der Name der Seite (und jede Subdomain) zeigt auf diesen Rechner
    browserArgs: ['--host-resolver-rules=MAP *.' + host + ' 127.0.0.1, MAP ' + host + ' 127.0.0.1'],
  };
}

module.exports = { testSite };
