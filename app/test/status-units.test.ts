// Statusseiten, server/status-units.sh in einer Attrappen-Umgebung: systemctl, systemd-run, curl, ip, runuser,
// mariadb und mysqldump sind kleine Skripte, die ihre Aufrufe aufschreiben; config.mjs ist ein Ersatz mit get/set.
// Geprüft: die Units mit und ohne Tunnel (eigene Adressen in IPAddressDeny), config.json → status (Resolver von Hand
// bleiben), der Test des Schutzes im Kernel (wirkt / wirkt nicht / nicht prüfbar), Neustart bei --update, kein
// Einrichten mit TCP-Datenbank, Anhalten bei --reset, Puffer von MariaDB, Sicherung ohne Rohdaten, ping und planned.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT_DIR } from '../src/config.js';

const SCRIPT = join(ROOT_DIR, 'server', 'status-units.sh');
let dir = '';
let bin = '';
let code = '';
let units = '';

function stub(name: string, body: string): void {
  const file = join(bin, name);
  writeFileSync(file, `#!/bin/bash\necho "${name} $*" >> "$STUB_LOG"\n${body}\n`);
  chmodSync(file, 0o755);
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'oys-status-units-'));
  bin = join(dir, 'bin');
  code = join(dir, 'code');
  units = join(dir, 'units');
  for (const d of [bin, code, units, join(code, 'app', 'dist', 'status')]) mkdirSync(d, { recursive: true });
  stub('systemctl', 'exit 0');
  // IPAddressDeny wirkt (STUB_KERNEL=blocks), wird ignoriert (ignores) oder systemd-run geht gar nicht (broken)
  // STUB_CURL=down: die Webseite antwortet auch ohne Sperre nicht (dann ist nichts prüfbar)
  stub('systemd-run', 'case "$STUB_KERNEL" in blocks) [ "${STUB_CURL:-ok}" = ok ] || exit 7; [[ "$*" == *IPAddressDeny* ]] && exit 7; exit 0 ;; '
    + 'ignores) [ "${STUB_CURL:-ok}" = ok ] || exit 7; exit 0 ;; *) exit 1 ;; esac');
  stub('curl', '[ "${STUB_CURL:-ok}" = ok ] && exit 0; exit 7');
  stub('ip', "echo '2: eth0    inet 93.184.216.34/24 brd 93.184.216.255 scope global eth0'; echo '2: eth0    inet6 2a01:4f8::1/64 scope global'");
  stub('runuser', 'exit 0');
  stub('mariadb', '[ "${STUB_TABLE:-1}" = 1 ] && echo status_checks; exit 0');
  stub('mysqldump', 'echo "-- dump $*"');
  // Ersatz für app/scripts/config.mjs (get/set wie das Original)
  writeFileSync(join(dir, 'config.mjs'), [
    "import fs from 'node:fs';",
    'const [cmd, key, ...rest] = process.argv.slice(2);',
    "const file = rest[rest.indexOf('--file') + 1];",
    "const data = JSON.parse(fs.readFileSync(file, 'utf8'));",
    "if (cmd === 'get') { const v = key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), data); if (v !== undefined && typeof v !== 'object') process.stdout.write(String(v)); }",
    "if (cmd === 'set') { data[key] = JSON.parse(process.env.OYS_VALUE); fs.writeFileSync(file, JSON.stringify(data, null, 2)); }",
    '',
  ].join('\n'));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Run {
  status: number;
  out: string;
  calls: string[];
}

function run(snippet: string, env: Record<string, string> = {}): Run {
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  const script = `
    set -euo pipefail
    CODE='${code}'; NODE='${process.execPath}'; WEB=www-data; UNITS='${units}'; CONFIG_MJS='${join(dir, 'config.mjs')}'
    TUNNEL=\${TUNNEL:-no}; PORT=3000
    info() { printf 'INFO %s\\n' "$*"; }
    warn() { printf 'WARN %s\\n' "$*"; }
    write_if_changed() { local tmp; tmp=$(mktemp); cat > "$tmp"; if [ -f "$1" ] && cmp -s "$tmp" "$1"; then rm -f "$tmp"; return 1; fi; install -m "\${2:-644}" "$tmp" "$1"; rm -f "$tmp"; }
    . '${SCRIPT}'
    ${snippet}
  `;
  const r = spawnSync('bash', ['-c', script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_LOG: log, ...env }, encoding: 'utf8' });
  return { status: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? ''), calls: readFileSync(log, 'utf8').split('\n').filter((l) => l !== '') };
}

const config = (): Record<string, unknown> => JSON.parse(readFileSync(join(code, 'config.json'), 'utf8')) as Record<string, unknown>;
const unit = (name: string): string => readFileSync(join(units, name), 'utf8');

test('loading the file does nothing; the functions are there', () => {
  const r = run('type write_status_units status_units_stop status_units_disable status_planned status_buffer_pool_line status_backup_dump status_ping status_summary_line >/dev/null && echo "$STATUS_TUNNEL_METRICS"');
  assert.equal(r.status, 0, r.out);
  assert.equal(r.out.trim(), '127.0.0.1:20241');
  assert.deepEqual(r.calls, []);
});

test('with the tunnel: own addresses are denied, config.json gets the status block, the kernel guard works', () => {
  writeFileSync(join(code, 'config.json'), JSON.stringify({ db: { host: 'localhost' }, base_domain: 'on-your.site' }));
  const r = run('write_status_units', { TUNNEL: 'yes', STUB_KERNEL: 'blocks' });
  assert.equal(r.status, 0, r.out);
  const checker = unit('onyoursite-status.service');
  assert.match(checker, /^User=www-data$/m);
  assert.match(checker, new RegExp(`^ExecStart=${process.execPath.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} --max-old-space-size=384 ${code.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/app/dist/status/worker\\.js$`, 'm'));
  assert.match(checker, /^IPAddressDeny=localhost link-local multicast .* fec0::\/10 2a01:4f8::1 93\.184\.216\.34$/m);
  assert.doesNotMatch(checker, /^IPAddressAllow=/m);
  assert.match(checker, /^CPUQuota=200%$/m);
  // Prüfbericht: ohne AF_NETLINK scheitert os.networkInterfaces() (getifaddrs) mit EAFNOSUPPORT – der Prüfdienst brach
  // direkt nach dem Start ab und lief unter systemd nie. Netlink öffnet keine Verbindung ins Netz (IPAddressDeny bleibt).
  assert.match(checker, /^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK$/m);
  assert.match(unit('onyoursite-status-local.service'), /^ExecStart=.*\/app\/dist\/status\/local\.js$/m);
  assert.match(unit('onyoursite-status-local.service'), /^StateDirectory=onyoursite-status$/m);
  assert.match(unit('onyoursite-status-local.timer'), /^OnUnitActiveSec=60s$/m);
  assert.ok(r.calls.includes('systemctl daemon-reload'));
  assert.ok(r.calls.includes('systemctl enable --now onyoursite-status.service onyoursite-status-local.timer'));
  assert.ok(!r.calls.some((c) => c.startsWith('systemctl restart')), 'no restart outside --update');
  const status = config().status as Record<string, unknown>;
  assert.equal(status.tunnel, true);
  assert.deepEqual(status.self_ips, ['2a01:4f8::1', '93.184.216.34']);
  assert.deepEqual(status.egress_ips, status.self_ips);
  assert.deepEqual(status.dns, ['1.1.1.1', '1.0.0.1', '9.9.9.9']);
  assert.equal(status.kernel_guard, true);
  assert.equal(status.concurrency, 1000);
  assert.equal((config().db as { host: string }).host, 'localhost', 'other settings stay');
});

test('without the tunnel and on --update: no own addresses denied, hand-edited resolvers kept, the checker restarts', () => {
  const cfg = config();
  (cfg.status as Record<string, unknown>).dns = ['9.9.9.9'];
  writeFileSync(join(code, 'config.json'), JSON.stringify(cfg));
  const r = run('write_status_units update', { TUNNEL: 'no', STUB_KERNEL: 'blocks' });
  assert.equal(r.status, 0, r.out);
  assert.match(unit('onyoursite-status.service'), /^IPAddressDeny=localhost .* fec0::\/10$/m);
  const status = config().status as Record<string, unknown>;
  assert.equal(status.tunnel, false);
  assert.deepEqual(status.dns, ['9.9.9.9']);
  assert.ok(r.calls.includes('systemctl restart onyoursite-status.service'));
});

test('the kernel guard: ignored → warning and false; not testable → the old value stays', () => {
  let r = run('write_status_units', { STUB_KERNEL: 'ignores' });
  assert.equal(r.status, 0, r.out);
  assert.ok(r.out.includes('WARN This server ignores IPAddressDeny – status checks rely on the app guard only.'));
  assert.equal((config().status as Record<string, unknown>).kernel_guard, false);
  r = run('write_status_units', { STUB_KERNEL: 'blocks', STUB_CURL: 'down' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /couldn’t be tested right now/);
  assert.equal((config().status as Record<string, unknown>).kernel_guard, false, 'unchanged');
  r = run('write_status_units', { STUB_KERNEL: 'broken' });
  assert.equal((config().status as Record<string, unknown>).kernel_guard, false, 'systemd-run failing is not a result either');
});

test('a TCP database is refused – the checker needs the socket', () => {
  const cfg = config();
  (cfg.db as Record<string, unknown>).host = '127.0.0.1';
  writeFileSync(join(code, 'config.json'), JSON.stringify(cfg));
  rmSync(join(units, 'onyoursite-status.service'));
  const r = run('write_status_units || echo "rc=$?"', { STUB_KERNEL: 'blocks' });
  assert.match(r.out, /WARN The status checker needs the database socket: set db\.host to localhost\./);
  assert.match(r.out, /rc=1/);
  assert.equal(existsSync(join(units, 'onyoursite-status.service')), false);
  (cfg.db as Record<string, unknown>).host = 'localhost';
  writeFileSync(join(code, 'config.json'), JSON.stringify(cfg));
});

test('--reset and removal stop the status units; planned windows and pings go through the web user', () => {
  let r = run('status_units_stop');
  assert.deepEqual(r.calls, ['systemctl stop onyoursite-status.service onyoursite-status-local.timer onyoursite-status-local.service onyoursite-status-notify.service']);
  r = run('status_units_disable');
  assert.deepEqual(r.calls, ['systemctl disable --now onyoursite-status.service onyoursite-status-local.timer onyoursite-status-local.service onyoursite-status-notify.service']);
  r = run('status_planned 600');
  assert.deepEqual(r.calls, [`runuser -u www-data -- env NODE_ENV=production ${process.execPath} ${code}/app/dist/status/ctl.js planned 600`]);
  // ping: ohne gebauten Code nichts, sonst über den Webserver-Benutzer – ein Fehler bricht die Sicherung nicht ab
  r = run('status_ping backup; echo done');
  assert.deepEqual(r.calls, []);
  writeFileSync(join(code, 'app', 'dist', 'status', 'ctl.js'), '');
  r = run('status_ping backup; echo done');
  assert.deepEqual(r.calls, [`runuser -u www-data -- env NODE_ENV=production ${process.execPath} ${code}/app/dist/status/ctl.js ping backup`]);
  assert.match(r.out, /done/);
  assert.equal(run('status_summary_line on-your.site').out.trim(), 'Status page: https://status.on-your.site · checks: systemctl status onyoursite-status onyoursite-status-local.timer');
});

test('the MariaDB buffer: a quarter of the memory, 512 MB to 16 GB, unless set elsewhere', () => {
  const meminfo = join(dir, 'meminfo');
  const conf = join(dir, 'mysql');
  mkdirSync(join(conf, 'mariadb.conf.d'), { recursive: true });
  const line = (kb: number): string => {
    writeFileSync(meminfo, `MemTotal:       ${kb} kB\nMemFree:        1000 kB\n`);
    return run('status_buffer_pool_line', { STATUS_MEMINFO: meminfo, STATUS_MYSQL_CONF: conf }).out.trim();
  };
  assert.equal(line(8 * 1024 * 1024), 'innodb_buffer_pool_size = 2048M');
  assert.equal(line(1024 * 1024), 'innodb_buffer_pool_size = 512M');
  assert.equal(line(128 * 1024 * 1024), 'innodb_buffer_pool_size = 16384M');
  // die eigene Datei zählt nicht, eine andere schon
  writeFileSync(join(conf, 'mariadb.conf.d', '90-onyoursite.cnf'), '[mysqld]\ninnodb_buffer_pool_size = 2048M\n');
  assert.equal(line(8 * 1024 * 1024), 'innodb_buffer_pool_size = 2048M');
  writeFileSync(join(conf, 'mariadb.conf.d', '60-admin.cnf'), '[mysqld]\ninnodb_buffer_pool_size = 4G\n');
  assert.equal(line(8 * 1024 * 1024), '');
});

test('backups leave out the raw checks but keep the table', () => {
  let r = run('status_backup_dump onyoursite', { STUB_TABLE: '1' });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.calls.filter((c) => c.startsWith('mysqldump')), [
    'mysqldump --single-transaction --quick --routines --default-character-set=utf8mb4 --ignore-table=onyoursite.status_checks onyoursite',
    'mysqldump --single-transaction --no-data --default-character-set=utf8mb4 onyoursite status_checks',
  ]);
  r = run('status_backup_dump onyoursite', { STUB_TABLE: '0' });
  assert.deepEqual(r.calls.filter((c) => c.startsWith('mysqldump')), [
    'mysqldump --single-transaction --quick --routines --default-character-set=utf8mb4 onyoursite',
  ]);
});
