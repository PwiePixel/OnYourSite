'use strict';
// install.sh --update und --channel in einem Testordner: die Docker-Art mit einem nachgebauten docker (es entsteht kein
// Container), alle festen Pfade unter OYS_BOT_TEST_ROOT, Discord nachgebaut (DISCORD_API_BASE). Geprüft wird: ein
// fehlender Kanal wird einmal angelegt und als eine Zeile ergänzt – jede andere Zeile bleibt Byte für Byte, die Datei
// bleibt nur für root lesbar; nach einem Fehlschlag steht der Schlüssel leer da und --update versucht es nicht noch
// einmal, --channel schon. Läuft nur als root (wie der Installer); die volle Einrichtung wird hier nie gestartet.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { startFakeDiscord } = require('./fakeDiscord');

const BOT_DIR = path.join(__dirname, '..');
const skip = !(typeof process.getuid === 'function' && process.getuid() === 0 && fs.existsSync('/bin/bash'))
  && 'install.sh runs only as root';

// Nachgebautes docker: nur die Aufrufe von install.sh; „compose run … bot node index.js ARGS“ startet den Bot hier
const FAKE_DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_DOCKER_LOG"
case "\${1:-}" in
  --version) echo "Docker version 0.0.0 (test)"; exit 0 ;;
  info) exit 0 ;;
  compose) shift ;;
  *) exit 1 ;;
esac
case "\${1:-}" in
  version|build|up|logs|down|restart) exit 0 ;;
  run)
    while [ $# -gt 0 ] && [ "$1" != bot ]; do shift; done
    [ "\${2:-}" = node ] && [ "\${3:-}" = index.js ] || exit 1
    shift 3
    for a in "$@"; do if [ "$a" = --check ]; then echo "Website connection OK (test)."; exit 0; fi; done
    exec node index.js "$@"
    ;;
esac
exit 1
`;

// Eine Kopie des Bots in einem eigenen Ordner, dazu docker und sleep (der Installer wartet sonst 6 s auf die Logs)
function prepare(patch) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oys-bot-install-'));
  const src = path.join(root, 'bot');
  fs.mkdirSync(src);
  for (const f of ['install.sh', 'index.js', 'package.json', 'package-lock.json', 'docker-compose.yml', 'Dockerfile']) {
    fs.copyFileSync(path.join(BOT_DIR, f), path.join(src, f));
  }
  fs.cpSync(path.join(BOT_DIR, 'src'), path.join(src, 'src'), { recursive: true });
  fs.symlinkSync(fs.realpathSync(path.join(BOT_DIR, 'node_modules')), path.join(src, 'node_modules'));
  if (patch) patch(src);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.mkdirSync(path.join(root, 'fakeroot'));
  return { root, src, bin, env: path.join(src, '.env'), log: path.join(root, 'docker.log'), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function install(h, d, args) {
  return new Promise((resolve) => {
    const child = execFile('/bin/bash', [path.join(h.src, 'install.sh'), ...args], {
      env: {
        PATH: `${h.bin}:${path.dirname(process.execPath)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
        OYS_BOT_TEST_ROOT: path.join(h.root, 'fakeroot'),
        DISCORD_API_BASE: d.base,
        FAKE_DOCKER_LOG: h.log,
        HOME: h.root,
        LANG: 'C.UTF-8',
      },
      timeout: 90000,
    }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: stdout + stderr }));
    child.stdin.end();
  });
}

// Einstellungen wie nach einer Installation von 0.1 (ohne UPDATES_CHANNEL_ID) – mit einer eigenen Notiz, einem Wert mit
// „=“ und ohne Zeilenende am Schluss
function settings(d) {
  return [
    '# OnYourSite Discord bot – written by install.sh on 2026-01-01. Keep this file private.',
    `DISCORD_TOKEN=${d.token}`,
    `DISCORD_CLIENT_ID=${d.appId}`,
    `GUILD_ID=${d.guildId}`,
    'TEAM_ROLE_ID=1500000000000000901',
    'WELCOME_CHANNEL_ID=1500000000000000902',
    'WELCOME_ROLE_ID=',
    'RULES_CHANNEL_ID=1500000000000000903',
    'SUPPORT_CHANNEL_ID=1500000000000000904',
    'SUGGESTION_FORUM_ID=1500000000000000905',
    'TAG_ACCEPTED_ID=1500000000000000906',
    'TAG_DECLINED_ID=1500000000000000907',
    'SUPPORT_CATEGORY_ID=1500000000000000908',
    'SITE_URL=https://example.org',
    `BOT_SECRET=${crypto.randomBytes(32).toString('hex')}`,
    'POLL_SECONDS=10',
    '',
    '# own note – stays',
    'EXTRA_NOTE=a=b  ',
  ].join('\n');
}

const modeOf = (file) => fs.statSync(file).mode & 0o777;

test('--update adds #updates, #status and #alerts once: one new line each, every other line byte for byte, still readable only by root', { skip }, async () => {
  const d = await startFakeDiscord({ community: true });
  const h = prepare();
  try {
    const before = settings(d);
    fs.writeFileSync(h.env, before);
    fs.chmodSync(h.env, 0o640);
    const r = await install(h, d, ['--docker', '--update']);
    assert.equal(r.code, 0, r.out);
    const created = d.state.channels.find((c) => c.name === 'updates');
    const status = d.state.channels.find((c) => c.name === 'status');
    const alerts = d.state.channels.find((c) => c.name === 'alerts');
    assert.ok(created && status && alerts, r.out);
    const after = `${before}\nUPDATES_CHANNEL_ID=${created.id}\nSTATUS_CHANNEL_ID=${status.id}\nALERTS_CHANNEL_ID=${alerts.id}\n`;
    assert.equal(fs.readFileSync(h.env, 'utf8'), after);
    assert.equal(modeOf(h.env), 0o600);
    assert.match(r.out, /Adding the #updates channel …\n\s+Created channel #updates\n/);
    assert.match(r.out, /Adding the #status channel …\n\s+Created channel #status\n/);
    assert.match(r.out, /Adding the #alerts channel …\n\s+Created the private channel #alerts \(only Staff and the bot\)\n/);
    assert.deepEqual(d.writes().map((c) => `${c.method} ${c.path}`), Array(3).fill(`POST /api/v10/guilds/${d.guildId}/channels`), 'only these channels – no roles, no other channels');
    // #alerts: die Rolle des Teams aus den Einstellungen sieht ihn, @everyone nicht
    assert.ok(alerts.permission_overwrites.some((o) => o.id === '1500000000000000901' && BigInt(o.allow) & 1024n), JSON.stringify(alerts.permission_overwrites));
    assert.ok(alerts.permission_overwrites.some((o) => o.id === d.guildId && BigInt(o.deny) & 1024n));
    assert.equal(status.type, 5, '#status is an announcement channel on a community server');
    assert.equal(r.out.includes(d.token), false, 'the token is never shown');
    assert.match(fs.readFileSync(h.log, 'utf8'), /compose run --rm --no-deps -T .*-e TEAM_ROLE_ID .*-e UPDATES_CHANNEL_ID -e STATUS_CHANNEL_ID -e ALERTS_CHANNEL_ID +bot node index\.js --discord-channel ALERTS_CHANNEL_ID \d+/);

    // Das nächste --update hat nichts mehr anzulegen
    const again = await install(h, d, ['--docker', '--update']);
    assert.equal(again.code, 0, again.out);
    assert.equal(fs.readFileSync(h.env, 'utf8'), after);
    assert.doesNotMatch(again.out, /Adding the #/);
    assert.equal(d.writes().length, 3);
    assert.deepEqual(fs.readdirSync(path.join(h.root, 'fakeroot')), [], 'nothing outside the bot folder');
  } finally {
    h.cleanup();
    await d.close();
  }
});

test('a channel that can’t be added is stored empty with a note; --update doesn’t try again, --channel does', { skip }, async () => {
  const d = await startFakeDiscord({ community: false });
  const h = prepare();
  try {
    const before = `${settings(d)}\n`;
    fs.writeFileSync(h.env, before, { mode: 0o600 });
    d.state.failCreate = { status: 403, code: 50013, message: 'Missing Permissions' };
    const r = await install(h, d, ['--docker', '--update']);
    assert.equal(r.code, 0, r.out);
    const empty = 'UPDATES_CHANNEL_ID=\nSTATUS_CHANNEL_ID=\nALERTS_CHANNEL_ID=\n';
    assert.equal(fs.readFileSync(h.env, 'utf8'), `${before}${empty}`);
    assert.match(r.out, /Note: The #updates channel couldn’t be added: Missing Permissions \(HTTP 403\) – run bash \S+\/install\.sh --channel UPDATES_CHANNEL_ID to try again\./);
    assert.match(r.out, /Note: The #alerts channel couldn’t be added: Missing Permissions \(HTTP 403\) – run bash \S+\/install\.sh --channel ALERTS_CHANNEL_ID to try again\./);
    assert.equal(d.writes().length, 3);

    // Kein neuer Versuch beim nächsten --update
    const again = await install(h, d, ['--docker', '--update']);
    assert.equal(again.code, 0, again.out);
    assert.equal(d.writes().length, 3);
    assert.equal(fs.readFileSync(h.env, 'utf8'), `${before}${empty}`);

    // --channel versucht es noch einmal: der Wert steht danach in derselben Zeile
    d.state.failCreate = null;
    const retry = await install(h, d, ['--docker', '--channel', 'UPDATES_CHANNEL_ID']);
    assert.equal(retry.code, 0, retry.out);
    const id = d.state.channels.find((c) => c.name === 'updates').id;
    assert.equal(fs.readFileSync(h.env, 'utf8'), `${before}UPDATES_CHANNEL_ID=${id}\nSTATUS_CHANNEL_ID=\nALERTS_CHANNEL_ID=\n`);
    assert.match(retry.out, /Created channel #updates \(a text channel – announcement channels need a community server\)/);
    assert.equal(modeOf(h.env), 0o600);

    // Unbekannte oder ungültige Schlüssel: Abbruch, nichts geändert
    const unknown = await install(h, d, ['--docker', '--channel', 'FOO_CHANNEL_ID']);
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.out, /Unknown channel setting: FOO_CHANNEL_ID \(known: UPDATES_CHANNEL_ID/);
    const invalid = await install(h, d, ['--docker', '--channel', 'x;y']);
    assert.notEqual(invalid.code, 0);
    assert.match(invalid.out, /Use --channel with the name of a channel setting/);
    assert.equal(fs.readFileSync(h.env, 'utf8'), `${before}UPDATES_CHANNEL_ID=${id}\nSTATUS_CHANNEL_ID=\nALERTS_CHANNEL_ID=\n`);
    assert.equal(d.writes().length, 4);
  } finally {
    h.cleanup();
    await d.close();
  }
});

test('a later version with another channel adds only that one – #updates, #status and #alerts stay as they are', { skip }, async () => {
  const d = await startFakeDiscord({ community: true });
  // Eine spätere Version kennt noch einen Kanal
  const h = prepare((src) => {
    const file = path.join(src, 'src', 'setup.js');
    const code = fs.readFileSync(file, 'utf8');
    const spec = "UPDATES_CHANNEL_ID: { name: 'updates', topic: 'Release notes and updates from OnYourSite.' },";
    assert.ok(code.includes(spec));
    fs.writeFileSync(file, code.replace(spec, `${spec}\n  NEWS_CHANNEL_ID: { name: 'news', topic: 'News.' },`));
  });
  try {
    const before = `${settings(d)}\nUPDATES_CHANNEL_ID=1500000000000000909\nSTATUS_CHANNEL_ID=1500000000000000910\nALERTS_CHANNEL_ID=\n`;
    fs.writeFileSync(h.env, before, { mode: 0o600 });
    const r = await install(h, d, ['--docker', '--update']);
    assert.equal(r.code, 0, r.out);
    const news = d.state.channels.find((c) => c.name === 'news');
    assert.ok(news, r.out);
    assert.equal(fs.readFileSync(h.env, 'utf8'), `${before}NEWS_CHANNEL_ID=${news.id}\n`);
    assert.deepEqual(d.writes().map((c) => c.body.name), ['news']);
  } finally {
    h.cleanup();
    await d.close();
  }
});
