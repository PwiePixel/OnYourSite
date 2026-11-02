// server/install.sh in Teilen: einzelne Funktionen werden aus dem Skript geholt und in bash mit Platzhaltern für
// systemctl, git, Apache usw. ausgeführt – so lassen sich Reihenfolgen und Fehlerwege prüfen, ohne einen Server
// umzubauen. Die vollständigen Proben (PHP-Installation → Node.js) laufen außerhalb der Tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT_DIR } from '../src/config.js';

const SCRIPT = readFileSync(join(ROOT_DIR, 'server', 'install.sh'), 'utf8');
const IS_ROOT = process.getuid?.() === 0;
let dir = '';

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'oys-install-sh-'));
});
after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// Eine Funktion aus install.sh: einzeilig (name() { …; }) oder von „name() {“ bis zur ersten „}“ am Zeilenanfang
function fn(name: string): string {
  const m = new RegExp(`^${name}\\(\\) \\{ .*; \\}$`, 'm').exec(SCRIPT) ?? new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, 'm').exec(SCRIPT);
  if (!m) throw new Error(`function ${name} not found in server/install.sh`);
  return m[0];
}
// Eine Zeile mit einer Zuweisung (z. B. DENY_MARK=…)
function assignment(name: string): string {
  const m = new RegExp(`^${name}=.*$`, 'm').exec(SCRIPT);
  if (!m) throw new Error(`${name}= not found in server/install.sh`);
  return m[0];
}

function bash(script: string, timeoutMs: number): Promise<{ code: number | null; out: string; ms: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn('bash', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill('SIGKILL');
    }, timeoutMs);
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, ms: Date.now() - t0, timedOut });
    });
  });
}

const HELPERS = ['bold', 'info', 'warn', 'fail'].map(fn).join('\n');

// ---------------------------------------------------------------- Warten auf die Webseite

test('wait_web gives up after WEB_WAIT seconds when the website takes connections but never answers', async () => {
  const sockets: Socket[] = [];
  const server: Server = createServer((s) => void sockets.push(s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const r = await bash(`set -euo pipefail\n${fn('wait_web')}\nWEB_WAIT=3 PORT=${port} DOMAIN=example.test\nsystemctl() { echo 0; }\n`
      + 'if wait_web; then echo answered; else echo gave-up; fi', 40_000);
    // Früher zählte die Schleife 300 Versuche zu je bis zu 5 Sekunden: 25 Minuten ohne Webseite
    assert.equal(r.timedOut, false, 'wait_web was still waiting after 40 seconds');
    assert.match(r.out, /gave-up/);
    assert.ok(r.ms < 3000 + 5000 + 2000, `took ${r.ms} ms`);
  } finally {
    for (const s of sockets) s.destroy();
    server.close();
  }
});

// ---------------------------------------------------------------- Prüfung vor dem Update

test('preflight doesn’t end the installer silently when du fails (missing upload folder)', async () => {
  const backups = join(dir, 'backups');
  const code = join(dir, 'pf', 'code');
  mkdirSync(code, { recursive: true });
  const r = await bash(`set -euo pipefail\n${HELPERS}\n${fn('preflight')}
load_db_pass() { DB_PASS=pw; }
db_as_site() { return 0; }
cfg_file() { echo config.json; }
schema_version() { echo 5; }
mariadb() { echo 0; }
choose() { echo n; }
UPLOADS=${join(dir, 'no-such-uploads')} BACKUPS=${backups} CODE=${code} MIGRATE=0 DB_NAME=onyoursite
preflight
echo "after preflight"`, 30_000);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Database, disk space and passwords: all fine\./);
  assert.match(r.out, /after preflight/);
});

// ---------------------------------------------------------------- Umschalten von PHP auf Node.js

// Platzhalter für alles außerhalb des Code-Ordners; protokolliert in $LOG, was wann passiert
function switchHarness(root: string, migrate: 0 | 1, verify: 'ok' | 'fail'): string {
  const code = join(root, 'code');
  const stage = join(root, 'stage');
  for (const d of [join(code, 'email'), join(code, 'app', 'node_modules'), join(code, 'app', 'dist'), join(stage, 'app', 'node_modules'), join(stage, 'app', 'dist'), join(root, 'etc'), join(root, 'data'), join(root, 'units')]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(join(stage, 'app', 'package.json'), '{"type":"module"}');
  writeFileSync(join(stage, 'config.json'), '{"aes_key":"new"}');
  writeFileSync(join(root, 'site.conf'), 'PHP vhost\n');
  writeFileSync(join(root, 'units', 'onyoursite-web.service'), 'old unit\n');
  if (migrate) {
    // Code-Ordner mit der PHP-Version: index.php und ihre .htaccess, die vorhandene Dateien ausliefert
    writeFileSync(join(code, 'index.php'), '<?php');
    writeFileSync(join(code, '.htaccess'), 'RewriteEngine On\n');
    rmSync(join(code, 'app'), { recursive: true });
  } else {
    writeFileSync(join(code, 'config.json'), '{"aes_key":"old"}');
  }
  return `set -euo pipefail
${HELPERS}
${['switch_release', 'revert_release', 'on_exit', 'put_build', 'deny_code_folder', 'undeny_code_folder'].map(fn).join('\n')}
${assignment('DENY_MARK')}
LOG=${join(root, 'log')}
CODE=${code} STAGE=${stage} NEW_CFG=${join(stage, 'config.json')} SITE_CONF=${join(root, 'site.conf')}
CONF_DIR=${join(root, 'etc')} PREVIOUS_SITE=${join(root, 'etc', 'site.previous')} WEB_UNIT=${join(root, 'units', 'onyoursite-web.service')}
DATA_DIR=${join(root, 'data')} WEB=www-data MIGRATE=${migrate} IN_PLACE=0 NEW=new OLD_REL=old OLD_BRANCH=main BRANCH_NOW=main
PHPV=8.3 BACKUP_DIR="" SWITCH_STATE="" CHECKED_OUT=0 APACHE_SWITCHED=0 DOMAIN=example.test PORT=3000 VERIFY=${verify}
gitstub() { return 1; }
GIT=(gitstub)
systemctl() { echo "systemctl $*" >> "$LOG"; }
checkout_release() {
  echo "checkout $1" >> "$LOG"
  # Nur der Stand mit PHP hat index.php und die .htaccess (git überschreibt dabei eine fremde .htaccess)
  if [ "$MIGRATE" = 1 ]; then
    if [ "$1" = new ]; then command rm -f "$CODE/index.php" "$CODE/.htaccess"; else echo '<?php' > "$CODE/index.php"; echo 'RewriteEngine On' > "$CODE/.htaccess"; fi
  fi
}
write_web_unit() { echo 'new unit' > "$WEB_UNIT"; }
web_port() { echo 3000; }
wait_web() { return 0; }
write_apache() { echo "write_apache" >> "$LOG"; echo 'Node vhost' > "$SITE_CONF"; return 0; }
apache_check() { return 0; }
verify_site() { [ "$VERIFY" = ok ]; }
web_log() { :; }
mv() {
  if [ "\${@: -1}" = "$CODE/config.json" ]; then
    if grep -qxF "$DENY_MARK" "$CODE/.htaccess" 2>/dev/null; then echo "config.json arrives (code folder locked)" >> "$LOG"
    elif [ -e "$CODE/.htaccess" ] || [ "$MIGRATE" = 1 ]; then echo "config.json arrives (code folder OPEN)" >> "$LOG"
    else echo "config.json arrives" >> "$LOG"; fi
  fi
  command mv "$@"
}
rm() {
  local a
  for a in "$@"; do if [ "$a" = "$CODE/config.json" ] && [ -e "$a" ]; then echo "config.json removed" >> "$LOG"; fi; done
  command rm "$@"
}
trap on_exit EXIT
switch_release
`;
}

function events(root: string): string[] {
  return readFileSync(join(root, 'log'), 'utf8').trim().split('\n');
}
function before_(list: string[], a: string, b: string): boolean {
  const i = list.indexOf(a);
  const j = list.indexOf(b);
  return i >= 0 && j >= 0 && i < j;
}

test('moving from PHP: Apache switches before the code folder changes, and the folder is locked before config.json arrives', { skip: !IS_ROOT && 'needs root (www-data group)' }, async () => {
  const root = mkdtempSync(join(dir, 'mig-ok-'));
  const r = await bash(switchHarness(root, 1, 'ok'), 30_000);
  assert.equal(r.code, 0, r.out);
  const log = events(root);
  // Neu laden zuerst: laufende PHP-Anfragen finden ihre Dateien noch, neue gehen an Node.js
  assert.ok(before_(log, 'systemctl reload apache2', 'checkout new'), log.join('\n'));
  // Apache-Prozesse mit der PHP-Einstellung lesen die Sperre, bevor es config.json im Code-Ordner gibt
  assert.ok(log.includes('config.json arrives (code folder locked)'), log.join('\n'));
  const code = join(root, 'code');
  assert.match(readFileSync(join(code, '.htaccess'), 'utf8'), /^Require all denied$/m);
  assert.equal(readFileSync(join(code, 'config.json'), 'utf8'), '{"aes_key":"new"}');
  assert.equal(existsSync(join(code, 'index.php')), false);
  assert.equal(existsSync(join(root, 'units', 'onyoursite-web.service.d')), false);
});

test('moving from PHP: a failed check after the switch removes config.json before the PHP files return and reloads Apache', { skip: !IS_ROOT && 'needs root (www-data group)' }, async () => {
  const root = mkdtempSync(join(dir, 'mig-fail-'));
  const r = await bash(switchHarness(root, 1, 'fail'), 30_000);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /The PHP website runs as before/);
  const log = events(root);
  assert.ok(before_(log, 'config.json removed', 'checkout old'), log.join('\n'));
  // Apache war schon umgeschaltet: die PHP-Einstellung kommt zurück und gilt erst nach dem Neuladen
  assert.equal(log.filter((l) => l === 'systemctl reload apache2').length, 2, log.join('\n'));
  assert.ok(log.includes('systemctl disable --now onyoursite-web'), log.join('\n'));
  const code = join(root, 'code');
  assert.equal(existsSync(join(code, 'config.json')), false);
  assert.equal(readFileSync(join(code, '.htaccess'), 'utf8'), 'RewriteEngine On\n');
  assert.equal(existsSync(join(code, 'index.php')), true);
  assert.equal(readFileSync(join(root, 'site.conf'), 'utf8'), 'PHP vhost\n');
  assert.equal(existsSync(join(root, 'units', 'onyoursite-web.service')), false);
});

test('node update: a failed check after the switch brings back code, build, settings and the Apache file', { skip: !IS_ROOT && 'needs root (www-data group)' }, async () => {
  const root = mkdtempSync(join(dir, 'node-fail-'));
  const code = join(root, 'code');
  const r0 = switchHarness(root, 0, 'fail');
  writeFileSync(join(code, 'app', 'dist', 'old-build'), '');
  const r = await bash(r0, 30_000);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /The previous version runs again/);
  const log = events(root);
  assert.ok(before_(log, 'systemctl stop onyoursite-web', 'checkout new'), log.join('\n'));
  assert.ok(before_(log, 'checkout new', 'checkout old'), log.join('\n'));
  assert.equal(log.filter((l) => l === 'systemctl reload apache2').length, 2, log.join('\n'));
  assert.ok(log.includes('systemctl restart onyoursite-web'), log.join('\n'));
  assert.equal(readFileSync(join(code, 'config.json'), 'utf8'), '{"aes_key":"old"}');
  assert.equal(existsSync(join(code, 'app', 'dist', 'old-build')), true);
  assert.equal(readFileSync(join(root, 'site.conf'), 'utf8'), 'PHP vhost\n');
  assert.equal(readFileSync(join(root, 'units', 'onyoursite-web.service'), 'utf8'), 'old unit\n');
  // Bei einem Update zwischen zwei Node.js-Versionen kommt keine Sperre in den Code-Ordner
  assert.equal(existsSync(join(code, '.htaccess')), false);
});

test('the lock keeps and restores a .htaccess that isn’t ours (code copied without git)', { skip: !IS_ROOT && 'needs root (www-data group)' }, async () => {
  const root = mkdtempSync(join(dir, 'lock-'));
  const code = join(root, 'code');
  mkdirSync(code, { recursive: true });
  writeFileSync(join(code, '.htaccess'), 'RewriteEngine On\n');
  const r = await bash(`set -euo pipefail\n${fn('deny_code_folder')}\n${fn('undeny_code_folder')}\n${assignment('DENY_MARK')}
CODE=${code} DATA_DIR=${join(root, 'data')} WEB=www-data
deny_code_folder; deny_code_folder
grep -c 'Require all denied' "$CODE/.htaccess"
undeny_code_folder
cat "$CODE/.htaccess"
deny_code_folder; command rm -f "$DATA_DIR/next/htaccess.previous"; undeny_code_folder
[ -e "$CODE/.htaccess" ] && echo still-there || echo removed`, 10_000);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out, '1\nRewriteEngine On\nremoved\n');
});

// ---------------------------------------------------------------- Sicherung und Wiederherstellen

test('backup.sh notes the running release, and the restore command of server/README.md puts it back (also without a branch)', async () => {
  const backup = readFileSync(join(ROOT_DIR, 'server', 'backup.sh'), 'utf8');
  const release = /^# Welche Version lief[\s\S]*?^fi$/m.exec(backup)?.[0];
  assert.ok(release, 'release block not found in server/backup.sh');
  const readme = readFileSync(join(ROOT_DIR, 'server', 'README.md'), 'utf8');
  const checkout = /^git -C \/var\/www\/onyoursite checkout .*$/m.exec(readme)?.[0];
  assert.ok(checkout, 'checkout line not found in server/README.md');
  const root = mkdtempSync(join(dir, 'restore-'));
  const repo = join(root, 'code');
  const r = await bash(`set -euo pipefail
g() { git -c user.name=t -c user.email=t@example.test -c commit.gpgsign=false -C ${repo} "$@"; }
git init -q -b main ${repo}
g commit -q --allow-empty -m one; one=$(g rev-parse HEAD)
g commit -q --allow-empty -m two
for mode in branch detached; do
  g checkout -q -f main
  if [ $mode = detached ]; then g checkout -q --detach "$one"; else g reset -q --hard "$one"; fi
  CODE=${repo} dir=${root}
  ${release}
  cat ${root}/release
  # Später: eine andere Version läuft – dann wiederherstellen wie in der Anleitung
  g checkout -q -f main; g reset -q --hard main@{1} 2>/dev/null || true; g commit -q --allow-empty -m later
  (. ${root}/release; ${checkout.replace('/var/www/onyoursite', repo)})
  echo "$mode: $(g rev-parse HEAD | cut -c1-7) on $(g rev-parse --abbrev-ref HEAD)"
  [ "$(g rev-parse HEAD)" = "$one" ]
done`, 20_000);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^commit=[0-9a-f]{40}\nbranch=main\n/m);
  assert.match(r.out, /^commit=[0-9a-f]{40}\nbranch=\n/m);
  assert.match(r.out, /^branch: [0-9a-f]{7} on main$/m);
  assert.match(r.out, /^detached: [0-9a-f]{7} on HEAD$/m);
});

// ---------------------------------------------------------------- Ablauf von --update

function updateHarness(root: string, release: string): string {
  mkdirSync(join(root, 'code', '.git'), { recursive: true });
  return `set -euo pipefail
${HELPERS}
${fn('update_site')}
LOG=${join(root, 'log')}
log() { echo "$*" >> "$LOG"; }
CODE=${join(root, 'code')} OYS_RELEASE=${release} OYS_RELEASE_BRANCH=main MIGRATE=0 NEW="" OLD_REL="" STAGE="" PHPV=""
# update_site setzt GIT=(git -c … -C …) selbst – git ist hier ein Platzhalter
git() { case "$*" in *"rev-parse --abbrev-ref HEAD"*) echo main ;; *"rev-parse HEAD"*) echo current ;; esac; }
conf_get() { echo example.test; }
php_live() { return 1; }
on_exit() { :; }
keep_php_running() { log keep_php_running; }
stage_release() { STAGE=${join(root, 'stage')}; NEW_CFG=$STAGE/config.json; log stage_release; }
step_packages() { log step_packages; }
preflight() { log preflight; }
take_backup() { BACKUP_DIR=/backups/x; log "take_backup $1"; }
build_current() { return 0; }
app_cli() { log "app_cli $3 \${4:-}"; return 0; }
update_settings_only() { log update_settings_only; }
write_config_json() { log write_config_json; }
build_app() { log build_app; }
cfg_file() { echo config.json; }
stage_check() { log stage_check; }
status_window() { log "status_window $1"; }
switch_release() { log switch_release; }
retire_php() { log retire_php; }
update_finish() { log update_finish; }
update_site
`;
}

test('--update takes a backup first, also when there is no new version', async () => {
  for (const [release, last] of [['current', 'update_settings_only'], ['newer', 'update_finish']]) {
    const root = mkdtempSync(join(dir, 'upd-'));
    const r = await bash(updateHarness(root, release), 10_000);
    assert.equal(r.code, 0, r.out);
    const log = events(root);
    assert.ok(before_(log, 'preflight', 'take_backup before-update'), log.join('\n'));
    assert.ok(before_(log, 'take_backup before-update', last), `${release}: ${log.join('\n')}`);
    assert.equal(log.filter((l) => l.startsWith('take_backup')).length, 1, log.join('\n'));
    // Vor dem Umschalten ein geplantes Fenster für die Statusseite (der Neustart zählt nicht als Störung)
    if (release === 'newer') assert.ok(before_(log, 'status_window 600', 'switch_release'), log.join('\n'));
    else assert.ok(!log.some((l) => l.startsWith('status_window')), log.join('\n'));
  }
});

// ---------------------------------------------------------------- Neue Installation mit Daten vom alten Server

test('after importing a database, the installer checks that the imported key reads its encrypted data', async () => {
  for (const [imported, crypto, expectWarning] of [[1, 1, true], [1, 0, false], [0, 1, false]] as const) {
    const root = mkdtempSync(join(dir, 'web-'));
    const code = join(root, 'code');
    mkdirSync(join(code, 'email'), { recursive: true });
    writeFileSync(join(code, 'config.json'), '{}');
    const r = await bash(`set -euo pipefail
${HELPERS}
${fn('step_website')}
LOG=${join(root, 'log')}
CODE=${code} DATA_DIR=${join(root, 'data')} UPLOADS=${join(root, 'uploads')} WEB=www-data NODE=node SUDO_HINT=""
IMP_CONFIG=${join(root, 'import', 'config.php')} DB_IMPORTED=${imported} DB_EMPTY=0 IMP_SMTP="" IMP_UPLOADS="" PORT=3000
chown() { :; }
install() { :; }
fix_permissions() { :; }
write_config_json() { :; }
build_current() { return 0; }
app_cli() {
  echo "app_cli $3 \${4:-}" >> "$LOG"
  case "$3 \${4:-}" in
    "check --crypto") echo "  messages.message   2 checked, 2 can’t be read"; return ${crypto} ;;
    *) return 0 ;;
  esac
}
web_port() { echo 3000; }
write_web_unit() { return 1; }
systemctl() { :; }
wait_web() { return 0; }
write_apache() { return 1; }
ensure_cert() { :; }
apache_check() { return 0; }
step_website`, 10_000);
    assert.equal(r.code, 0, r.out);
    const log = events(root);
    assert.equal(log.includes('app_cli check --crypto'), imported === 1, log.join('\n'));
    assert.equal(/doesn’t read the encrypted data of the imported database/.test(r.out), expectWarning, r.out);
  }
});

// ---------------------------------------------------------------- Statusseiten (ST-3): Dienste im Installer

// Ein Abschnitt von install.sh zwischen zwei Zeilen (für die Reihenfolge der Aufrufe in einem Modus)
function block(start: string, end: string): string {
  const i = SCRIPT.indexOf(start);
  assert.ok(i >= 0, `${start} not found`);
  const j = SCRIPT.indexOf(end, i + start.length);
  assert.ok(j > i, `${end} not found after ${start}`);
  return SCRIPT.slice(i, j);
}
const order = (text: string, ...parts: string[]): boolean => parts.every((p, k) => k === 0 || text.indexOf(parts[k - 1]) < text.indexOf(p)) && parts.every((p) => text.includes(p));

test('the status services are set up wherever the topology can change: install, --update, --https and --tunnel', () => {
  assert.ok(order(fn('step_services'), 'step_protect', 'write_timers', 'status_services'), fn('step_services'));
  assert.ok(order(fn('update_finish'), 'write_timers', 'status_services update', 'check_site', 'status_window 0'), fn('update_finish'));
  assert.ok(order(fn('update_site'), 'stage_check', 'status_window 600', 'switch_release'));
  assert.ok(order(block('  https)', ';;'), 'step_https force', 'write_timers', 'status_services'));
  assert.ok(order(block('  tunnel)', ';;'), 'status_window 600', 'step_tunnel force', 'step_protect', 'status_services', 'check_site', 'status_window 0'));
  // --reset hält alle Status-Units vor DROP DATABASE an
  assert.ok(order(block('  reset)', ';;'), 'systemctl stop onyoursite-web', 'status_units_stop', 'DROP DATABASE'));
  // Der Tunnel hat einen festen Port für die Messwerte (der Sensor fragt /ready)
  assert.match(fn('tunnel_local'), /^Environment=TUNNEL_METRICS=\$\{STATUS_TUNNEL_METRICS:-127\.0\.0\.1:20241\}$/m);
  // MariaDB: der Puffer kommt aus status_buffer_pool_line in dieselbe Datei
  assert.ok(order(fn('step_protect'), 'status_load', 'status_buffer_pool_line', '90-onyoursite.cnf', 'systemctl restart mariadb'));
  assert.match(fn('summary'), /status_summary_line "\$DOMAIN"/);
  // Sicherung: ohne die einzelnen Messungen, danach der Heartbeat
  const backup = readFileSync(join(ROOT_DIR, 'server', 'backup.sh'), 'utf8');
  assert.ok(order(backup, '. "$CODE/server/status-units.sh"', 'status_backup_dump "$DB"', 'status_ping backup'));
});

test('status_services: only with Node.js and a built checker; a failure only warns', async () => {
  const root = mkdtempSync(join(dir, 'status-'));
  const code = join(root, 'code');
  mkdirSync(join(code, 'server'), { recursive: true });
  writeFileSync(join(code, 'server', 'status-units.sh'), 'write_status_units() { echo "write_status_units $* port=$PORT"; return ${STATUS_RC:-0}; }\n');
  const run = (env: string): Promise<{ code: number | null; out: string }> => bash(`set -euo pipefail
${HELPERS}
${fn('status_load')}
${fn('status_services')}
web_port() { echo 3123; }
CODE=${code}
${env}
status_services update
echo end`, 10_000);
  let r = await run('NODE=/usr/bin/node');
  assert.equal(r.out.includes('write_status_units'), false, 'no built checker yet: nothing');
  mkdirSync(join(code, 'app', 'dist', 'status'), { recursive: true });
  writeFileSync(join(code, 'app', 'dist', 'status', 'worker.js'), '');
  r = await run('NODE=""');
  assert.equal(r.out.includes('write_status_units'), false, 'without Node.js: nothing');
  r = await run('NODE=/usr/bin/node');
  assert.match(r.out, /write_status_units update port=3123\nend/);
  r = await run('NODE=/usr/bin/node; export STATUS_RC=1');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /The status services weren’t set up – see above\. The website works without them\.[\s\S]*end/);
});
