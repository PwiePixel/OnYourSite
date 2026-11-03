// server/install.sh, eigene Domains (PD-6): Funktionen werden aus dem Skript geholt und in bash ausgeführt – mit einer
// nachgebauten Cloudflare-API (ein kleiner HTTP-Server hier, CF_API zeigt darauf) und Platzhaltern für systemctl &
// Co. Geprüft: das Zusammenführen der Tunnel-Regeln (fremde Regeln bleiben, nur der Rest-Eintrag ändert sich),
// server.conf behält die neuen Schlüssel, Apache nimmt jeden Host an, die Unit des Domain-Dienstes, die Einrichtung
// mit --domains (Token-Fehler, DNS, Rückfall-Adresse, config.json), der stille Schritt beim Update und --reset.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT_DIR } from '../src/config.js';

const SCRIPT = readFileSync(join(ROOT_DIR, 'server', 'install.sh'), 'utf8');
let dir = '';

function fn(name: string): string {
  const m = new RegExp(`^${name}\\(\\) \\{ .*; \\}$`, 'm').exec(SCRIPT) ?? new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, 'm').exec(SCRIPT);
  if (!m) throw new Error(`function ${name} not found in server/install.sh`);
  return m[0];
}
const HELPERS = ['bold', 'info', 'warn', 'fail', 'conf_get', 'conf_set', 'in_list', 'cf', 'cf_err', 'choose', 'prompt'].map(fn).join('\n');

function bash(script: string, input = ''): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn('bash', ['-c', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.stdin.end(input);
    p.on('close', (code) => resolve({ code, out }));
  });
}

// ---------------------------------------------------------------- Nachgebaute Cloudflare-API

interface Call { method: string; path: string; body: unknown; auth: string }
let server: Server;
let api = '';
const calls: Call[] = [];
// Antworten je „METHODE pfad“ (Pfad ohne Abfrage); eine Funktion bekommt den Inhalt
let routes: Record<string, (body: unknown) => { status?: number; json: unknown }> = {};
const ok = (result: unknown) => ({ json: { success: true, errors: [], result } });
const err = (status: number, code: number, message: string) => ({ status, json: { success: false, errors: [{ code, message }], result: null } });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'oys-install-domains-'));
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const path = (req.url ?? '').replace(/^\/client\/v4/, '').split('?')[0];
      const body = raw ? JSON.parse(raw) as unknown : null;
      calls.push({ method: req.method ?? '', path, body, auth: String(req.headers.authorization ?? '') });
      const route = routes[`${req.method} ${path}`];
      const r = route ? route(body) : err(404, 7003, 'No route for that URI');
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  api = `http://127.0.0.1:${addr.port}/client/v4`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- Tunnel-Regeln

const cfg = (ingress: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ config: { ingress, ...extra } });
async function merged(current: string, customDomains: string): Promise<{ config: { ingress: Array<Record<string, unknown>>; [k: string]: unknown } }> {
  const r = await bash(`${HELPERS}\n${fn('tunnel_rules_json')}\nDOMAIN=on-your.site; CUSTOM_DOMAINS=${customDomains}\ntunnel_rules_json '${current.replace(/'/g, "'\\''")}'`);
  assert.equal(r.code, 0, r.out);
  return JSON.parse(r.out) as { config: { ingress: Array<Record<string, unknown>> } };
}

test('tunnel rules: the site’s three names are ensured, rules of others and other keys stay, only the catch-all changes', async () => {
  const own = (h: string) => ({ hostname: h, service: 'https://127.0.0.1:443', originRequest: { originServerName: 'on-your.site', noTLSVerify: true } });
  const nas = { hostname: 'nas.example.org', service: 'http://192.168.1.5:5000' };
  // Leer (ein neuer Tunnel): die drei Namen und der Rest-Eintrag 404
  let m = await merged('{}', '');
  assert.deepEqual(m.config.ingress, [own('on-your.site'), own('www.on-your.site'), own('*.on-your.site'), { service: 'http_status:404' }]);
  // Eine Regel des Admins und ein anderer Schlüssel bleiben; mit eigenen Domains geht der Rest an die Webseite
  m = await merged(cfg([nas, own('on-your.site'), { service: 'http_status:404' }], { 'warp-routing': { enabled: false } }), 'yes');
  assert.deepEqual(m.config.ingress, [nas, own('on-your.site'), own('www.on-your.site'), own('*.on-your.site'),
    { service: 'https://127.0.0.1:443', originRequest: { originServerName: 'on-your.site', noTLSVerify: true } }]);
  assert.deepEqual(m.config['warp-routing'], { enabled: false });
  // Eine eigene Regel, die der Admin angepasst hat, bleibt wie sie ist
  const tuned = { hostname: 'www.on-your.site', service: 'https://127.0.0.1:443', originRequest: { originServerName: 'on-your.site', noTLSVerify: true, http2Origin: true } };
  m = await merged(cfg([own('on-your.site'), tuned, own('*.on-your.site'), { service: 'http_status:404' }]), '');
  assert.deepEqual(m.config.ingress[1], tuned);
  assert.equal(m.config.ingress.length, 4);
});

// ---------------------------------------------------------------- server.conf, Apache, Unit

test('server.conf keeps the custom domain keys; Apache takes any host only with custom domains', async () => {
  const conf = join(dir, 'server.conf');
  const r = await bash(`${HELPERS}\n${fn('save_conf')}\nCONF_DIR=${dir}; CONF=${conf}; DOMAIN=on-your.site CODE=/c NODE=/n SSH_KEYONLY=yes TUNNEL=yes TUNNEL_ID=t BACKUP_DAYS=14
    CUSTOM_DOMAINS=yes SAAS_ORIGIN=origin SAAS_TARGET=edge; save_conf; cat ${conf}`);
  assert.equal(r.code, 0, r.out);
  for (const line of ['CUSTOM_DOMAINS=yes', 'SAAS_ORIGIN=origin', 'SAAS_TARGET=edge']) assert.ok(r.out.includes(line), line);
  const site = async (on: string) => (await bash(`${fn('apache_site')}\nDOMAIN=on-your.site SSL_DIR=/ssl PORT=3000 CUSTOM_DOMAINS=${on}; apache_site`)).out;
  const vhost443 = (s: string) => s.slice(s.lastIndexOf('<VirtualHost *:443>'));
  assert.match(vhost443(await site('yes')), /ServerAlias www\.on-your\.site \*\.on-your\.site\n(?: {4}#[^\n]*\n)? {4}ServerAlias \*\n/);
  assert.doesNotMatch(vhost443(await site('')), /ServerAlias \*\n/);
});

test('the domain worker unit: hardened, the token only as a credential, written only with custom domains', async () => {
  const units = join(dir, 'units');
  mkdirSync(units, { recursive: true });
  const stub = `systemctl() { echo "systemctl $*" >> ${dir}/systemctl.log; }\nwrite_if_changed() { local f=$1; cat > "$f.new"; if [ -f "$f" ] && cmp -s "$f" "$f.new"; then rm -f "$f.new"; return 1; fi; mv "$f.new" "$f"; return 0; }`;
  let r = await bash(`${HELPERS}\n${stub}\n${fn('write_domain_worker')}\nUNITS=${units}; CODE=/var/www/onyoursite; NODE=/usr/bin/node; CONF_DIR=/etc/onyoursite; CUSTOM_DOMAINS=yes; write_domain_worker; echo rc=$?`);
  assert.match(r.out, /rc=0/);
  const unit = readFileSync(join(units, 'onyoursite-domains.service'), 'utf8');
  for (const line of ['LoadCredential=cf_saas_token:/etc/onyoursite/cf-saas.token', 'DynamicUser=yes', 'SupplementaryGroups=www-data',
    'ExecStart=/usr/bin/node /var/www/onyoursite/app/dist/cli.js domains:worker', 'ProtectSystem=strict', 'NoNewPrivileges=true', 'MemoryMax=256M']) {
    assert.ok(unit.includes(line), line);
  }
  assert.ok(!/CF_|TOKEN=/.test(unit), 'no token in the unit');
  assert.match(readFileSync(join(dir, 'systemctl.log'), 'utf8'), /enable --now onyoursite-domains/);
  // Ohne eigene Domains: keine Unit, eine alte wird abgeschaltet
  r = await bash(`${HELPERS}\n${stub}\n${fn('write_domain_worker')}\nUNITS=${units}; CODE=/c; NODE=/n; CONF_DIR=/e; CUSTOM_DOMAINS=; write_domain_worker; echo rc=$?`);
  assert.ok(!existsSync(join(units, 'onyoursite-domains.service')));
  assert.match(readFileSync(join(dir, 'systemctl.log'), 'utf8'), /disable --now onyoursite-domains/);
});

// ---------------------------------------------------------------- --domains

function domainsScript(extra = ''): string {
  return `${HELPERS}
${['tunnel_rules_json', 'tunnel_rules_sync', 'saas_token_check', 'saas_name_taken', 'saas_ask_name', 'domains_not_now', 'step_domains', 'write_domain_worker', 'cfg_get', 'cf_fail'].map(fn).join('\n')}
apt_install() { :; }
systemctl() { :; }
write_if_changed() { cat > /dev/null; return 1; }
UNITS=${dir}/units-domains; NODE=/usr/bin/node; CONFIG_MJS=/none
mariadb() { cat >/dev/null; echo "\${TAKEN:-0}"; }
config_set() { echo "config $1=$2" >> ${dir}/config.log; }
CF_API=${api}; CF_ERRFILE=$(mktemp); CONF_DIR=${dir}/etc; CONF=${dir}/etc/server.conf; mkdir -p ${dir}/etc
DOMAIN=on-your.site; ZONE_ID=zone1; ACC_ID=acc1; TUNNEL=yes; TUNNEL_ID=tun1; CF_TOKEN=installer; SUDO_HINT=""; CODE=/c
cf_login() { return 0; }
${extra}
`;
}

test('--domains: refuses a token without the right permission and a zone without SaaS – nothing is written', async () => {
  calls.length = 0;
  routes = { 'GET /zones/zone1/custom_hostnames/quota': () => err(403, 9109, 'Unauthorized to access requested resource') };
  let r = await bash(domainsScript() + 'step_domains force; echo rc=$?', 'y\nsaas-token-one\n\n');
  assert.match(r.out, /This token can’t manage custom hostnames – it needs Zone · SSL and Certificates · Edit for on-your\.site\./);
  assert.ok(!existsSync(join(dir, 'etc', 'cf-saas.token')));
  routes = { 'GET /zones/zone1/custom_hostnames/quota': () => err(403, 1449, 'Cloudflare for SaaS entitlement is required') };
  r = await bash(domainsScript() + 'step_domains force; echo rc=$?', 'y\nsaas-token-one\n\n');
  assert.match(r.out, /Cloudflare for SaaS isn’t enabled for on-your\.site yet/);
  assert.ok(!calls.some((c) => c.method !== 'GET'), 'nothing was changed at Cloudflare');
});

test('--domains: DNS for origin and edge, the fallback origin, the merged tunnel rules, the token file and config.json', async () => {
  calls.length = 0;
  rmSync(join(dir, 'config.log'), { force: true });
  let fallback = '';
  routes = {
    'GET /zones/zone1/custom_hostnames/quota': () => ok({ allocated: 100, used: 0 }),
    'GET /zones/zone1/dns_records': () => ok([{ id: 'r1', type: 'CNAME', name: 'on-your.site', content: 'tun1.cfargotunnel.com', proxied: true }]),
    'POST /zones/zone1/dns_records/batch': () => ok({}),
    'PUT /zones/zone1/custom_hostnames/fallback_origin': (b) => { fallback = (b as { origin: string }).origin; return ok({ origin: fallback, status: 'pending_deployment' }); },
    'GET /zones/zone1/custom_hostnames/fallback_origin': () => ok({ origin: fallback, status: 'active' }),
    'GET /accounts/acc1/cfd_tunnel/tun1/configurations': () => ok({ config: { ingress: [{ hostname: 'nas.example.org', service: 'http://x' }, { service: 'http_status:404' }] } }),
    'PUT /accounts/acc1/cfd_tunnel/tun1/configurations': () => ok({}),
  };
  const r = await bash(domainsScript() + 'step_domains force; echo rc=$?; cat ${CONF}', 'y\nsaas-token-one\n\n\ny\n');
  assert.match(r.out, /rc=0/, r.out);
  // Der Token liegt nur in der Datei (nur root), nie in einem Aufruf
  const tokenFile = join(dir, 'etc', 'cf-saas.token');
  assert.equal(readFileSync(tokenFile, 'utf8').trim(), 'saas-token-one');
  assert.ok(!r.out.includes('saas-token-one'), 'the token is never printed');
  const batch = calls.find((c) => c.path === '/zones/zone1/dns_records/batch')?.body as { posts: Array<Record<string, unknown>> };
  assert.deepEqual(batch.posts.map((p) => [p.name, p.content, p.proxied]), [['origin.on-your.site', 'tun1.cfargotunnel.com', true], ['edge.on-your.site', 'origin.on-your.site', true]]);
  assert.equal(fallback, 'origin.on-your.site');
  // Welches Token: die Rückfall-Adresse mit dem der Webseite, DNS und Tunnel mit dem des Installers
  assert.equal(calls.find((c) => c.method === 'PUT' && c.path.endsWith('/fallback_origin'))?.auth, 'Bearer saas-token-one');
  assert.equal(calls.find((c) => c.path.endsWith('/dns_records/batch'))?.auth, 'Bearer installer');
  assert.equal(calls.find((c) => c.method === 'PUT' && c.path.endsWith('/configurations'))?.auth, 'Bearer installer');
  // Nur root darf das Token lesen
  assert.equal((await import('node:fs')).statSync(tokenFile).mode & 0o777, 0o600);
  const put = calls.find((c) => c.method === 'PUT' && c.path.endsWith('/configurations'))?.body as { config: { ingress: Array<Record<string, unknown>> } };
  assert.equal(put.config.ingress[0].hostname, 'nas.example.org', 'the admin’s rule stays');
  assert.equal(put.config.ingress.at(-1)?.service, 'https://127.0.0.1:443', 'the catch-all goes to the website');
  const config = readFileSync(join(dir, 'config.log'), 'utf8');
  for (const line of ['config cloudflare.zone_id=zone1', 'config custom_domains.cname_target=edge.on-your.site', 'config custom_domains.fallback_origin=origin.on-your.site']) assert.ok(config.includes(line), line);
  for (const line of ['CUSTOM_DOMAINS=yes', 'SAAS_ORIGIN=origin', 'SAAS_TARGET=edge']) assert.ok(r.out.includes(line), line);
  assert.match(r.out, /Custom domains: on – customers point their CNAME to edge\.on-your\.site\. Switch them on for users in the admin area \(Custom domains\)\./);
});

test('--domains: a name a page already uses is refused; a foreign record is only replaced after a yes', async () => {
  // Der vorgeschlagene Name ist vergeben: Hinweis, dann wird gefragt, bis die Eingabe endet
  let r = await bash(domainsScript('TAKEN=1') + 'step_domains force; echo rc=$?', 'y\nsaas-token-one\n\n');
  assert.match(r.out, /origin\.on-your\.site is used by a page – choose another name\./);
  // Ein fremder Eintrag für edge: der Plan nennt ihn, ohne „y“ ändert sich nichts
  calls.length = 0;
  routes['GET /zones/zone1/dns_records'] = () => ok([{ id: 'x1', type: 'A', name: 'edge.on-your.site', content: '203.0.113.9', proxied: false }]);
  r = await bash(domainsScript() + 'step_domains force; echo rc=$?', 'y\nsaas-token-one\n\n\nn\n');
  assert.match(r.out, /\* replace DNS {2}edge\.on-your\.site \(it points somewhere else now\)/);
  assert.match(r.out, /Nothing was changed/);
  assert.ok(!calls.some((c) => c.method !== 'GET'), 'nothing was changed at Cloudflare');
});

// ---------------------------------------------------------------- --update und --reset

test('--update: a broken token only warns; a missing fallback origin is set again; nothing stops the update', async () => {
  calls.length = 0;
  writeFileSync(join(dir, 'etc', 'cf-saas.token'), 'saas-token-one\n');
  routes = {
    'GET /zones/zone1/custom_hostnames/quota': () => err(401, 10000, 'Authentication error'),
  };
  let r = await bash(domainsScript(`CF_ENV=${dir}/etc/cloudflare.env; printf 'CF_API_TOKEN=installer\\n' > $CF_ENV; CUSTOM_DOMAINS=yes; SAAS_ORIGIN=origin; SAAS_TARGET=edge; ${fn('cf_token_quiet')}\n${fn('domains_update')}`) + 'domains_update; echo rc=$?');
  assert.match(r.out, /rc=0/);
  assert.match(r.out, /The custom-domain token no longer works – run .*--domains/);
  routes = {
    'GET /zones/zone1/custom_hostnames/quota': () => ok({ allocated: 100 }),
    'GET /zones/zone1/custom_hostnames/fallback_origin': () => err(404, 1551, 'No fallback origin'),
    'PUT /zones/zone1/custom_hostnames/fallback_origin': () => ok({ origin: 'origin.on-your.site', status: 'pending_deployment' }),
    'GET /zones/zone1/dns_records': () => ok([{ type: 'CNAME', name: 'origin.on-your.site', content: 'tun1.cfargotunnel.com', proxied: true }, { type: 'CNAME', name: 'edge.on-your.site', content: 'origin.on-your.site', proxied: true }]),
    'GET /accounts/acc1/cfd_tunnel/tun1/configurations': () => ok({ config: { ingress: [] } }),
    'PUT /accounts/acc1/cfd_tunnel/tun1/configurations': () => ok({}),
  };
  calls.length = 0;
  r = await bash(domainsScript(`CF_ENV=${dir}/etc/cloudflare.env; CUSTOM_DOMAINS=yes; SAAS_ORIGIN=origin; SAAS_TARGET=edge; ${fn('cf_token_quiet')}\n${fn('domains_update')}`) + 'domains_update; echo rc=$?');
  assert.match(r.out, /rc=0/, r.out);
  assert.ok(calls.some((c) => c.method === 'PUT' && c.path.endsWith('/fallback_origin')), 'the fallback origin is set again');
  assert.ok(!calls.some((c) => c.path.endsWith('/dns_records/batch')), 'DNS in place: nothing changed');
});

test('--reset deletes the custom hostnames at Cloudflare with the website token', async () => {
  calls.length = 0;
  routes = { 'DELETE /zones/zone1/custom_hostnames/h1': () => ok({ id: 'h1' }), 'DELETE /zones/zone1/custom_hostnames/h2': () => err(404, 1436, 'not found') };
  const r = await bash(domainsScript(`mariadb() { printf 'h1\\nh2\\n'; }\n${fn('reset_custom_hostnames')}`) + 'reset_custom_hostnames; echo rc=$?');
  assert.match(r.out, /rc=0/);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['DELETE /zones/zone1/custom_hostnames/h1', 'DELETE /zones/zone1/custom_hostnames/h2']);
  assert.match(r.out, /Deleted 1 custom hostname at Cloudflare\./);
  assert.match(r.out, /1 custom hostname couldn’t be deleted.*SSL\/TLS → Custom Hostnames/);
});

test('--update under set -euo pipefail, as the installer runs, without a token set before: warnings only, exit 0', async () => {
  mkdirSync(join(dir, 'etc'), { recursive: true });
  writeFileSync(join(dir, 'etc', 'cf-saas.token'), 'saas-token-one\n');
  routes = { 'GET /zones/zone1/custom_hostnames/quota': () => err(401, 10000, 'Authentication error') };
  const script = domainsScript(`CF_ENV=${dir}/etc/cloudflare.env; CUSTOM_DOMAINS=yes; SAAS_ORIGIN=origin; SAAS_TARGET=edge; ${fn('cf_token_quiet')}\n${fn('domains_update')}`)
    .replace('CF_TOKEN=installer;', '');
  const r = await bash('set -euo pipefail\nunset CF_TOKEN\n' + script + 'domains_update; echo rc=$?');
  assert.match(r.out, /rc=0/, r.out);
  assert.doesNotMatch(r.out, /unbound variable/);
  assert.match(r.out, /The custom-domain token no longer works/, 'the token check really ran');
});

test('tunnel rules: when the current rules can’t be read, nothing is written (the admin’s rules would be lost)', async () => {
  calls.length = 0;
  routes = { 'GET /accounts/acc1/cfd_tunnel/tun1/configurations': () => err(500, 1000, 'Internal error') };
  const r = await bash(domainsScript() + 'tunnel_rules_sync; echo rc=$?');
  assert.match(r.out, /rc=1/);
  assert.ok(!calls.some((c) => c.method === 'PUT'));
  // Unverändert: kein PUT
  calls.length = 0;
  const same = { config: { ingress: [{ hostname: 'on-your.site', service: 'https://127.0.0.1:443', originRequest: { originServerName: 'on-your.site', noTLSVerify: true } },
    { hostname: 'www.on-your.site', service: 'https://127.0.0.1:443', originRequest: { originServerName: 'on-your.site', noTLSVerify: true } },
    { hostname: '*.on-your.site', service: 'https://127.0.0.1:443', originRequest: { originServerName: 'on-your.site', noTLSVerify: true } }, { service: 'http_status:404' }] } };
  routes = { 'GET /accounts/acc1/cfd_tunnel/tun1/configurations': () => ok(same) };
  await bash(domainsScript() + 'CUSTOM_DOMAINS=; tunnel_rules_sync');
  assert.ok(!calls.some((c) => c.method === 'PUT'), 'no PUT without a difference');
});

test('names: www, addresses of the website and the other name are refused', async () => {
  for (const [input, refused] of [['www\n', 'www'], ['status\n', 'status'], ['edge-x\nedge-x\n', 'edge-x']] as const) {
    const r = await bash(domainsScript() + 'saas_ask_name A "First" origin; ' + (refused === 'edge-x' ? 'saas_ask_name B "Second" edge "$A"; ' : '') + 'echo got=$A', input);
    assert.match(r.out, new RegExp(`${refused}\\.on-your\\.site is needed by the website – choose another name\\.`), input);
  }
});

test('a new domain for the website: hostnames of the old zone go, live domains get 7 days from now, others keep their state, the old settings go', async () => {
  const log = join(dir, 'change.log');
  rmSync(log, { force: true });
  const r = await bash(domainsScript(`mariadb() { if [ "\${3:-}" = -e ] || [ "\${2:-}" = -e ]; then echo "SQL \${*: -1}" >> ${log}; fi; echo 2; }
    config_set() { echo "config $1=[$2]" >> ${log}; }
    reset_custom_hostnames() { echo "reset $DOMAIN" >> ${log}; }
    ${fn('domains_domain_change')}`) + 'CUSTOM_DOMAINS=yes; OLD_DOMAIN=old.example; DOMAIN=new.example; SAAS_TARGET=edge; printf "CUSTOM_DOMAINS=yes\n" > $CONF; domains_domain_change; echo rc=$?; cat $CONF');
  assert.match(r.out, /rc=0/, r.out);
  const done = readFileSync(log, 'utf8');
  assert.match(done, /reset old\.example/, 'hostnames deleted in the old zone');
  assert.match(done, /state = 'broken', state_at = NOW\(\), problem = 'target_changed'.*WHERE state IN \('pending', 'active', 'broken'\)/s);
  for (const k of ['cloudflare.zone_id', 'custom_domains.cname_target', 'custom_domains.fallback_origin']) assert.ok(done.includes(`config ${k}=[]`), k);
  assert.match(r.out, /pointed to edge\.old\.example\. Their owners must change the CNAME to edge\.new\.example\./);
  assert.ok(!r.out.includes('CUSTOM_DOMAINS=yes'), 'custom domains have to be set up again');
});
