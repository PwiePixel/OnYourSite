// Die Browser-Abläufe in tests/e2e löschen Code-Seiten und Honigwaben-Buchungen der Testkonten – und jede Buchung,
// die während des Laufs entsteht, egal von wem. Sie lesen standardmäßig die config.json der Seite. Deshalb dürfen sie
// nur eine Test-Datenbank (Name beginnt mit oys_test) anfassen: mit jeder anderen Datenbank brechen sie ab, bevor sie
// die Datenbank überhaupt aufrufen. Geprüft mit Ersatz-Programmen für mysql (schreibt jeden Aufruf mit) und playwright.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT_DIR } from '../src/config.js';

const SCRIPTS = ['admin-split.js', 'hc-yellow.js', 'e2e-dialogs.js'];
const tmp = mkdtempSync(join(tmpdir(), 'oys-e2e-guard-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

// mysql-Ersatz: jeder Aufruf landet in calls, dann ein Fehler (der Ablauf bricht dort ab)
const bin = join(tmp, 'bin');
const calls = join(tmp, 'mysql-calls.log');
mkdirSync(bin);
writeFileSync(join(bin, 'mysql'), `#!/bin/sh\necho "$*" >> '${calls}'\nexit 1\n`);
chmodSync(join(bin, 'mysql'), 0o755);
// playwright-Ersatz: der Browser wird nie gestartet
const mods = join(tmp, 'node_modules');
mkdirSync(join(mods, 'playwright'), { recursive: true });
writeFileSync(join(mods, 'playwright', 'index.js'), "module.exports = { chromium: { launch: () => { throw new Error('no browser in this test'); } } };\n");

function run(script: string, dbName: string): { status: number | null; stderr: string; mysql: string } {
  const config = join(tmp, 'config-' + dbName + '.json');
  writeFileSync(config, JSON.stringify({ base_domain: 'oys.test:8080', db: { host: '127.0.0.1', user: 'oys', name: dbName } }));
  rmSync(calls, { force: true });
  const r = spawnSync(process.execPath, [join(ROOT_DIR, 'tests/e2e', script)], {
    env: { ...process.env, OYS_CONFIG: config, NODE_PATH: mods, PATH: bin + ':' + (process.env.PATH ?? ''), OYS_E2E_PORT: '9' },
    encoding: 'utf8',
    timeout: 30000,
  });
  return { status: r.status, stderr: r.stderr, mysql: existsSync(calls) ? readFileSync(calls, 'utf8') : '' };
}

test('e2e flows refuse a database that is not a test database, before any SQL', () => {
  for (const script of SCRIPTS) {
    for (const name of ['onyoursite', 'oys', 'production_oys_test', '']) {
      const r = run(script, name);
      assert.equal(r.mysql, '', `${script} with "${name}" ran SQL: ${r.mysql}`);
      assert.equal(r.status, 2, `${script} with "${name}": exit ${r.status} ${r.stderr}`);
      assert.match(r.stderr, /not a test database \(oys_test…\)/, script);
    }
  }
});

test('e2e flows still run against a test database (oys_test…)', () => {
  for (const script of SCRIPTS) {
    const r = run(script, 'oys_test_guard');
    // Bis zum ersten SQL-Aufruf (der Ersatz schlägt dort fehl): die Prüfung lässt den Lauf durch
    assert.match(r.mysql, /oys_test_guard/, script);
    assert.equal(r.status, 1, script);
  }
});
