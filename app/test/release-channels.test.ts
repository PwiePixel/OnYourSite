// Zwei Release-Kanäle: scripts/release.sh für Releases (X.Y.Z) und Pre-Releases (X.Y.Z-beta.N), scripts/publish-releases.sh
// auf GitHub – main veröffentlicht Releases, beta nur das aktuelle Pre-Release (als Pre-Release markiert, nie „Latest“).
// Beide Skripte laufen hier in einem Testordner; gh ist ein nachgebautes Programm, das seine Aufrufe aufschreibt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT_DIR } from '../src/config.js';

function project(version: string, changelog: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'oys-release-'));
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'app', 'src', 'updates'), { recursive: true });
  for (const f of ['release.sh', 'publish-releases.sh']) copyFileSync(join(ROOT_DIR, 'scripts', f), join(dir, 'scripts', f));
  writeFileSync(join(dir, 'VERSION'), version + '\n');
  writeFileSync(join(dir, 'app', 'package.json'), JSON.stringify({ version }) + '\n');
  writeFileSync(join(dir, 'app', 'package-lock.json'), JSON.stringify({ version, packages: { '': { version } } }) + '\n');
  writeFileSync(join(dir, 'app', 'src', 'updates', 'releaseNotes.ts'), "version: '3.6.0'\n");
  writeFileSync(join(dir, 'CHANGELOG.md'), changelog);
  return dir;
}
const release = (dir: string, v: string) => spawnSync('bash', [join(dir, 'scripts', 'release.sh'), v], { encoding: 'utf8' });
const read = (dir: string, f: string) => readFileSync(join(dir, f), 'utf8');
const LOG = '# Changelog\n\n## [Unreleased]\n\n### Added\n- The beta website\n\n## [3.5.0] - 2026-11-05\n\n### Added\n- The beta area\n';

test('release.sh: a pre-release copies [Unreleased], the release then takes it over and drops its pre-releases', () => {
  const dir = project('3.5.0', LOG);
  try {
    let r = release(dir, '3.6.0-beta.1');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /bring it to the branch beta/);
    assert.equal(read(dir, 'VERSION'), '3.6.0-beta.1\n');
    assert.equal(JSON.parse(read(dir, 'app/package.json')).version, '3.6.0-beta.1');
    assert.match(read(dir, 'CHANGELOG.md'), /## \[Unreleased\]\n\n### Added\n- The beta website\n\n## \[3\.6\.0-beta\.1\] - \d{4}-\d\d-\d\d\n\n### Added\n- The beta website\n\n## \[3\.5\.0\]/);
    // Nicht höher: abgelehnt
    for (const v of ['3.6.0-beta.1', '3.5.9', '3.6', '3.6.0-rc.1', '3.6.0-beta.0']) assert.notEqual(release(dir, v).status, 0, v);
    assert.equal(release(dir, '3.6.0-beta.2').status, 0);
    r = release(dir, '3.6.0');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /merge it into main/);
    const log = read(dir, 'CHANGELOG.md');
    assert.doesNotMatch(log, /beta\.\d\]/, 'the pre-release sections are gone');
    assert.match(log, /## \[Unreleased\]\n\n## \[3\.6\.0\] - \d{4}-\d\d-\d\d\n\n### Added\n- The beta website\n\n## \[3\.5\.0\]/);
    assert.equal(read(dir, 'VERSION'), '3.6.0\n');
    // Nach dem Release kein Pre-Release derselben Version mehr
    assert.notEqual(release(dir, '3.6.0-beta.3').status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// publish-releases.sh mit einem git-Repository und einem gh, das „release view“ für die genannten Tags bejaht
function publish(dir: string, channel: string, existing: string[]): { status: number | null; calls: string[]; out: string; notes: string } {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
echo "$*" >> "${join(dir, 'gh.log')}"
if [ "$1 $2" = "release view" ]; then case " ${existing.join(' ')} " in *" $3 "*) exit 0 ;; *) exit 1 ;; esac; fi
if [ "$1 $2" = "release create" ]; then for a in "$@"; do if [ "$prev" = --notes-file ]; then cat "$a" >> "${join(dir, 'notes.log')}"; fi; prev=$a; done; fi
exit 0
`);
  chmodSync(join(bin, 'gh'), 0o755);
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'x');
  const r = spawnSync('bash', [join(dir, 'scripts', 'publish-releases.sh')], {
    encoding: 'utf8',
    env: { ...process.env, PATH: bin + ':' + process.env.PATH, GITHUB_REPOSITORY: 'o/r', GITHUB_REF_NAME: channel, GITHUB_SHA: git('rev-parse', 'HEAD').trim() },
  });
  let calls: string[] = [];
  let notes = '';
  try { calls = read(dir, 'gh.log').trim().split('\n').filter((l) => l.startsWith('release create')); } catch { calls = []; }
  try { notes = read(dir, 'notes.log'); } catch { notes = ''; }
  return { status: r.status, calls, out: r.stdout + r.stderr, notes };
}

test('publish-releases.sh: beta publishes only the current pre-release, marked as one and never "Latest"', () => {
  const dir = project('3.5.0', LOG);
  try {
    release(dir, '3.6.0-beta.1');
    const r = publish(dir, 'beta', ['v3.5.0']);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.calls.length, 1, r.calls.join('\n'));
    assert.match(r.calls[0], /^release create v3\.6\.0-beta\.1 \S+OnYourSite-v3\.6\.0-beta\.1\.zip --repo o\/r --title OnYourSite 3\.6\.0-beta\.1 .*--target [0-9a-f]{40} --latest=false --prerelease$/);
    assert.match(r.notes, /^> \*\*Pre-release\*\* – only on the beta website for beta testers\. Everyone gets it with OnYourSite 3\.6\.0\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('publish-releases.sh: main publishes releases as "Latest", skips pre-releases and refuses a pre-release VERSION', () => {
  const dir = project('3.5.0', LOG);
  try {
    release(dir, '3.6.0-beta.1');
    let r = publish(dir, 'main', ['v3.5.0']);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /main needs a release version/);
    release(dir, '3.6.0');
    rmSync(join(dir, '.git'), { recursive: true, force: true });
    rmSync(join(dir, 'gh.log'), { force: true });
    r = publish(dir, 'main', ['v3.5.0', 'v3.6.0-beta.1']);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.calls.length, 1, r.calls.join('\n'));
    assert.match(r.calls[0], /^release create v3\.6\.0 .* --latest=true$/);
    // Ein Release auf beta (z. B. nach dem Abgleich mit main): nichts zu tun
    rmSync(join(dir, '.git'), { recursive: true, force: true });
    rmSync(join(dir, 'gh.log'), { force: true });
    assert.deepEqual(publish(dir, 'beta', ['v3.5.0']).calls, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
