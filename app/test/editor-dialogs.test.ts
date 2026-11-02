// Editor mit eigenen Dialogen (custom-dialogs CD-2): die Startdaten (Konto-ID für die Entwürfe im Browser, beim Öffnen
// verdiente Honigwaben als notices – nur beim Aufruf, der sie verdient, nie im Nutzer-Modus eines Admins), die Seite
// (Skripte mit defer, keine alte Hinweis-Leiste, Vorschau der Code-Seite ohne allow-modals, Fenster mit Rolle) und
// editor.js selbst (keine Browser-Popups, Seitenwechsel nur über die Wache). Die Abläufe im Browser prüft
// tests/e2e/editor-dialogs.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_DIR } from '../src/config.js';
import { makeTestCtx } from '../src/web/ctx.js';
import { appRoutes } from '../src/app/dispatch.js';
import { loginSession, runRequest, testDatabase, type TestDb } from './coreHarness.js';
// @ts-ignore – reines ES-Modul ohne Typen
import { checkText } from '../../tools/check-native-dialogs.mjs';

let t: TestDb;

before(async () => {
  t = await testDatabase('edialogs');
});

after(async () => {
  await t.done();
});

interface Opened { status: number; html: string; data: Record<string, unknown> }

// /dashboard eines angemeldeten Kontos (optional als Admin im Nutzer-Modus) und die Startdaten des Editors
async function open(userId: number, impersonatedBy?: number): Promise<Opened> {
  const sid = await loginSession(userId, { impersonatedBy });
  const ctx = makeTestCtx({ url: '/dashboard', cookies: { PHPSESSID: sid } });
  await runRequest(ctx, appRoutes);
  const html = String(ctx.body);
  const m = /<script>window\.OYS_EDITOR = (.*?);<\/script>/s.exec(html);
  assert.ok(m, 'editor data in the page');
  return { status: ctx.status, html, data: JSON.parse(m[1]) as Record<string, unknown> };
}
const dailyRows = async (userId: number): Promise<number> => {
  const [rows] = await t.admin.query(`SELECT COUNT(*) AS n FROM \`${t.name}\`.honeycomb_ledger WHERE user_id = ? AND reason = 'daily'`, [userId]);
  return Number((rows as Array<{ n: number }>)[0].n);
};

test('bootstrap: the account id for the drafts and the rewards of this visit as honeycomb notices', async () => {
  await t.admin.query(`DELETE FROM \`${t.name}\`.honeycomb_ledger WHERE user_id = 5 AND reason = 'daily'`);
  const first = await open(5);
  assert.equal(first.status, 200);
  const user = first.data.user as Record<string, unknown>;
  assert.equal(user.id, 5);
  // Bisherige Schlüssel bleiben vorn
  assert.deepEqual(Object.keys(user), ['name', 'email', 'weekly', 'discord', 'admin', 'id']);
  assert.deepEqual(first.data.notices, [{ tone: 'hc', text: 'for being active today', amount: 5 }]);
  assert.equal(await dailyRows(5), 1);
  // Beim nächsten Öffnen ist nichts neu verdient: keine Hinweise (kein zweiter Toast)
  const second = await open(5);
  assert.deepEqual(second.data.notices, []);
  assert.equal(await dailyRows(5), 1);
});

test('bootstrap: an admin working as the user earns nothing and gets no notices', async () => {
  await t.admin.query(`DELETE FROM \`${t.name}\`.honeycomb_ledger WHERE user_id = 6 AND reason = 'daily'`);
  const o = await open(6, 3);
  assert.deepEqual(o.data.notices, []);
  assert.equal((o.data.user as Record<string, unknown>).id, 6);
  assert.equal(await dailyRows(6), 0);
});

test('bootstrap: the editor data stays data inside its script (no raw < or >, JSON_HEX_TAG)', async () => {
  const o = await open(5);
  assert.doesNotMatch(o.html.split('window.OYS_EDITOR = ')[1].split(';</script>')[0], /[<>]/);
});

test('the editor page: deferred scripts after ui.js, no old toast bar, code preview without pop-ups, labelled window', async () => {
  const { html } = await open(5);
  // ui.js im Kopf (defer), share.js, bell.js (CD-5b) und editor.js danach ebenfalls mit defer – so laufen sie in dieser
  // Reihenfolge
  assert.match(html, /<script src="\/static\/js\/ui\.js\?v=[0-9a-f]{8}" defer><\/script>/);
  assert.match(html, /<script src="\/static\/js\/share\.js\?v=[0-9a-f]{8}" defer><\/script>\n {4}<script src="\/static\/js\/bell\.js\?v=[0-9a-f]{8}" defer><\/script>\n {4}<script src="\/static\/js\/editor\.js\?v=[0-9a-f]{8}" defer><\/script>/);
  assert.ok(html.indexOf('/static/js/ui.js') < html.indexOf('window.OYS_EDITOR'));
  assert.ok(html.indexOf('window.OYS_EDITOR') < html.indexOf('/static/js/editor.js'));
  assert.ok(!html.includes('id="toasts"'), 'the old toast container is gone (ui.js creates its own)');
  assert.match(html, /<iframe class="pv-code" title="Preview of your code page" id="pvCode" sandbox="allow-scripts allow-forms allow-popups"><\/iframe>/);
  assert.ok(!html.includes('allow-modals'));
  assert.ok(html.includes('<p class="hint pv-note" id="pvCodeNote">Pop-ups like alert&#40;) only run on your live page.</p>'));
  assert.ok(html.includes('<div class="modal-box" id="modalBox" role="dialog" aria-modal="true" aria-labelledby="modalTitle"></div>'));
  assert.match(html, /<meta name="robots" content="noindex">/);
  // Die Seite selbst enthält keinen Browser-Dialog
  assert.deepEqual(checkText(html), []);
});

test('editor.js: no browser pop-ups, one guard, page changes only through it, previews without allow-modals', () => {
  const js = readFileSync(join(ROOT_DIR, 'static/js/editor.js'), 'utf8');
  // Prüfskript: kein alert/confirm/prompt, keine Seitenwechsel an der Wache vorbei (location.href = … usw.)
  assert.deepEqual(checkText(js, { file: 'static/js/editor.js' }), []);
  assert.equal(js.match(/OYSUI\.guard\(/g)?.length, 1);
  assert.ok(js.includes("var UI = window.OYSUI;\n  if (!UI) { editorUnavailable(); return; }"), 'without ui.js the editor stops with a notice');
  assert.doesNotMatch(js, /sandbox[^\n]*allow-modals/, 'no preview may open browser pop-ups');
  assert.ok(!js.includes("$('#toasts')") && !js.includes('beforeunload'), 'no own toast bar and no own beforeunload');
  // Entwürfe: je Konto, ohne Passwörter, 7 Tage
  assert.ok(js.includes("var PREFIX = 'oys.draft.', MAX_AGE = 7 * 864e5;"));
  assert.ok(js.includes("p.blocks.forEach(function (b) { b.password = ''; });"));
});

test('editor.css: the code preview hint only shows in code mode', () => {
  const css = readFileSync(join(ROOT_DIR, 'static/css/editor.css'), 'utf8');
  assert.match(css, /\n\.pv-note \{ display: none;/);
  assert.match(css, /\nbody\.code-mode \.pv-note \{ display: block; \}/);
});
