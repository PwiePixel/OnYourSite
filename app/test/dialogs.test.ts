// Eigene Dialoge und Hinweise auf der Server-Seite (views/partials/ui.ts) und das Prüfskript gegen Browser-Popups
// (tools/check-native-dialogs.mjs). Die Bibliothek selbst prüfen die Browser-Tests in tests/e2e/ui-kit.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestCtx } from '../src/web/ctx.js';
import { Session } from '../src/web/session.js';
import { bellMarkup, confirmAttrs, confirmField, flashBanner, flashMarkup, uiAssets, unconfirmed, UNCONFIRMED_MESSAGE } from '../src/views/partials/ui.js';
// @ts-ignore – reines ES-Modul ohne Typen (läuft auch als Kommandozeile)
import { checkFiles, checkText, targetFiles } from '../../tools/check-native-dialogs.mjs';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { ROOT_DIR } from '../src/config.js';

test('uiAssets() loads ui.css and ui.js (deferred, versioned) on app pages and only ui.js on profile pages', () => {
  const app = uiAssets('app');
  assert.match(app, /^<link rel="stylesheet" href="\/static\/css\/ui\.css\?v=[0-9a-f]{8}">\n {4}<script src="\/static\/js\/ui\.js\?v=[0-9a-f]{8}" defer><\/script>$/);
  assert.match(uiAssets('page'), /^<script src="\/static\/js\/ui\.js\?v=[0-9a-f]{8}" defer><\/script>$/);
  assert.match(uiAssets('app', { toastTop: 96 }), /\n {4}<style>:root \{ --ui-toast-top: 96px; \}<\/style>$/);
  assert.match(uiAssets('app', { indent: '  ' }), /">\n {2}<script /);
});

test('confirmAttrs() escapes every value and leaves out what is not set; confirmField() is the fail-closed field', () => {
  assert.equal(confirmAttrs({ title: 'Delete this user?' }), ' data-confirm="Delete this user?"');
  const all = confirmAttrs({ title: 'Log in as "Mia" <x>?', text: "O'Brien & co can’t", ok: 'Delete', tone: 'danger', match: 'studio', label: 'Type it', normalize: 'slug', into: 'confirm' });
  assert.equal(all, ' data-confirm="Log in as &quot;Mia&quot; &lt;x&gt;?" data-confirm-text="O&#039;Brien &amp; co can’t" data-confirm-ok="Delete" data-confirm-tone="danger"'
    + ' data-confirm-match="studio" data-confirm-label="Type it" data-confirm-normalize="slug" data-confirm-into="confirm"');
  assert.equal(confirmField(), '<input type="hidden" name="_confirmed" value="0" autocomplete="off">');
});

test('unconfirmed(): only forms that carry _confirmed and did not send "1" are refused', () => {
  assert.equal(unconfirmed({}), false);
  assert.equal(unconfirmed({ _confirmed: '1' }), false);
  assert.equal(unconfirmed({ _confirmed: '0' }), true);
  assert.equal(unconfirmed({ _confirmed: '' }), true);
  assert.equal(unconfirmed({ _confirmed: ' 1' }), true);
  assert.equal(unconfirmed({ _confirmed: { 0: '1' } }), true);
  assert.equal(UNCONFIRMED_MESSAGE, 'Nothing was changed. Please confirm in the dialog – if no dialog appears, reload the page.');
});

test('flashBanner() reads and removes the keys, escapes the text and marks the tone for ui.js', async () => {
  const ctx = makeTestCtx({ url: '/admin' });
  const s = await Session.start(ctx);
  s.set('admin_success', 'User <b>"x"</b> deleted.');
  s.set('admin_error', 'Nope & no');
  s.set('other', 'stays');
  const html = flashBanner(ctx, ['admin_success', 'admin_error']);
  assert.equal(s.get('admin_success'), undefined);
  assert.equal(s.get('admin_error'), undefined);
  assert.equal(s.get('other'), 'stays');
  assert.ok(html.includes('data-flash="ok" role="status"') && html.includes('data-flash="err" role="alert"'));
  assert.ok(html.includes('User &lt;b&gt;&quot;x&quot;&lt;/b&gt; deleted.') && html.includes('Nope &amp; no'));
  assert.ok(html.indexOf('data-flash="ok"') < html.indexOf('data-flash="err"'), 'in the order of the keys');
  // Wie isset(): null zählt als nicht gesetzt und bleibt stehen
  s.set('admin_error', null);
  assert.equal(flashBanner(ctx, ['admin_success', 'admin_error']), '');
  assert.equal(s.get('admin_error'), null);
  // Das Banner selbst: die bisherige Optik der Admin-Seite
  assert.equal(flashMarkup('ok', 'Saved.'), '            <div data-flash="ok" role="status" class="absolute top-20 left-1/2 -translate-x-1/2 z-50 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-4 py-2 rounded-lg flex items-center gap-2 shadow-lg backdrop-blur-md text-sm font-medium animate-fade-in">\n                <i class=\'bx bx-check-circle text-lg\'></i> Saved.            </div>\n        ');
});

test('bellMarkup() carries the CSRF token of the session and the ARIA attributes', async () => {
  const ctx = makeTestCtx({ url: '/admin' });
  const s = await Session.start(ctx);
  s.set('csrf', 'f'.repeat(64));
  const html = await bellMarkup(ctx);
  assert.ok(html.includes('data-csrf="' + 'f'.repeat(64) + '"'));
  assert.ok(html.includes('id="bellBtn"') && html.includes('aria-expanded="false"') && html.includes('role="region" aria-label="Notifications"'));
});

test('the native-dialog check finds browser pop-ups and leaves the own library alone', () => {
  const rules = (src: string, opts = {}) => (checkText(src, opts) as Array<{ rule: string }>).map((f) => f.rule);
  assert.deepEqual(rules("if (!confirm('Delete?')) return;"), ['native-dialog']);
  assert.deepEqual(rules("window.alert('x'); self.prompt ('y')"), ['native-dialog', 'native-dialog']);
  assert.deepEqual(rules("OYSUI.confirm({}); guard.confirm(); UI.alert('x'); myconfirm(); $prompt(); obj.prompt()"), []);
  assert.deepEqual(rules('<form onsubmit="return confirm(\'x\')">'), ['native-dialog', 'inline-confirm']);
  assert.deepEqual(rules('o += "<button onclick=\\"return confirm(\'Close?\')\\">";'), ['native-dialog', 'inline-confirm']);
  assert.deepEqual(rules('<button onclick="toggle()">'), []);
  // Seitenwechsel an der Wache vorbei – nur in Skripten mit OYSUI.guard()
  assert.deepEqual(rules("location.href = '/x'; location.reload();"), []);
  assert.deepEqual(rules("var g = OYSUI.guard({ isDirty: d }); location.href = '/x'; if (location.href === y) {} location.reload(); window.location = 'z';"), ['guard-bypass', 'guard-bypass', 'guard-bypass']);
  // Benachrichtigungen nur über notify()
  assert.deepEqual(rules("await exec('INSERT INTO notifications (user_id) VALUES (?)', [1]);"), ['raw-notification']);
  assert.deepEqual(rules("await exec('INSERT INTO notifications (user_id) VALUES (?)', [1]);", { notifyAllowed: true }), []);
});

test('the native-dialog check over the code base is an error: nothing may be found', () => {
  // Admin und Anmelden (CD-3), Editor (CD-2), Profilseiten und das Startskript der Code-Seiten (CD-4) sind umgestellt
  const found = checkFiles() as Array<{ file: string; line: number; rule: string; match: string }>;
  assert.deepEqual(found.map((f) => `${f.file}:${f.line} ${f.rule}: ${f.match.trim()}`), []);
  // Die Bibliothek selbst wird nie geprüft (sie ersetzt die Browser-Popups); geprüft werden Skripte und Server-Code
  const files = (targetFiles() as string[]).map((f) => relative(ROOT_DIR, f));
  assert.ok(!files.includes('static/js/ui.js'));
  for (const f of ['static/js/editor.js', 'static/js/page.js', 'static/js/share.js', 'app/src/code/sites.ts', 'app/src/content/render.ts']) assert.ok(files.includes(f), f);
});

test('the check is an error on the command line (exit 1), --warn only warns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oys-lint-'));
  try {
    // Eine Kopie des Prüfskripts über einem Baum mit einem Browser-Popup
    mkdirSync(join(dir, 'tools'));
    mkdirSync(join(dir, 'static/js'), { recursive: true });
    mkdirSync(join(dir, 'app/src'), { recursive: true });
    copyFileSync(join(ROOT_DIR, 'tools/check-native-dialogs.mjs'), join(dir, 'tools/check-native-dialogs.mjs'));
    writeFileSync(join(dir, 'static/js/x.js'), "if (!confirm('Sure?')) return;\n");
    const run = (args: string[]) => spawnSync(process.execPath, [join(dir, 'tools/check-native-dialogs.mjs'), ...args], { encoding: 'utf8' });
    const strict = run([]);
    assert.equal(strict.status, 1);
    assert.match(strict.stdout, /^error static\/js\/x\.js:1 native-dialog: confirm\(/m);
    const warn = run(['--warn']);
    assert.equal(warn.status, 0);
    assert.match(warn.stdout, /^warning static\/js\/x\.js:1 native-dialog/m);
    writeFileSync(join(dir, 'static/js/x.js'), "OYSUI.confirm({ title: 'Sure?' });\n");
    const clean = run([]);
    assert.equal(clean.status, 0);
    assert.match(clean.stdout, /no native dialogs found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
