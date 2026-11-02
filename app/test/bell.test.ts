// Glocke im Editor und im Kopf des Admin-Bereichs (custom-dialogs CD-5b): dasselbe Markup aus bellMarkup() mit Konto
// (data-user, Schlüssel im Browser) und Nur-Lesen im Nutzer-Modus eines Admins (data-readonly), bell.js auf beiden Seiten
// (defer, nach ui.js; im Editor vor editor.js), Ziele /admin#<bereich> im Admin ohne Neuladen und bell.js selbst (keine
// Browser-Popups, Texte nur escaped, Symbole und Farben nur aus der Liste). Die Abläufe im Browser prüft tests/e2e/bell.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_DIR } from '../src/config.js';
import { makeTestCtx } from '../src/web/ctx.js';
import { Session } from '../src/web/session.js';
import { appRoutes } from '../src/app/dispatch.js';
import { bellMarkup } from '../src/views/partials/ui.js';
import { CSRF, loginSession, runRequest, testDatabase, type TestDb } from './coreHarness.js';
// @ts-ignore – reines ES-Modul ohne Typen
import { checkText, targetFiles } from '../../tools/check-native-dialogs.mjs';

let t: TestDb;

before(async () => {
  t = await testDatabase('bell');
});

after(async () => {
  await t.done();
});

// Seite eines angemeldeten Kontos (optional als Admin im Nutzer-Modus)
async function get(url: string, userId: number, impersonatedBy?: number): Promise<string> {
  const sid = await loginSession(userId, { impersonatedBy });
  const ctx = makeTestCtx({ url, cookies: { PHPSESSID: sid } });
  await runRequest(ctx, appRoutes);
  assert.equal(ctx.status, 200, url);
  return String(ctx.body);
}
// Das öffnende Tag der Glocke (es gibt genau eine)
function bellTag(html: string): string {
  const all = html.match(/<div class="relative" data-bell[^>]*>/g) ?? [];
  assert.equal(all.length, 1, 'one bell');
  assert.equal(html.match(/id="bellBtn"/g)?.length, 1, 'one bell button');
  return all[0];
}
const ASSET = (name: string): string => `<script src="/static/js/${name}\\.js\\?v=[0-9a-f]{8}" defer></script>`;

test('bellMarkup(): CSRF token, the account for the browser key, read-only while an admin works as the user', async () => {
  const ctx = makeTestCtx({ url: '/dashboard' });
  const s = await Session.start(ctx);
  // Ohne Konto in der Sitzung: kein data-user (bell.js speichert dann nichts im Browser)
  s.set('csrf', CSRF);
  assert.ok((await bellMarkup(ctx)).startsWith(`<div class="relative" data-bell data-csrf="${CSRF}">\n`));
  s.set('user_id', 5);
  const html = await bellMarkup(ctx);
  assert.ok(html.startsWith(`<div class="relative" data-bell data-csrf="${CSRF}" data-user="5">\n`));
  assert.ok(html.includes('id="bellBtn"') && html.includes('aria-expanded="false" aria-controls="bellMenu"'));
  assert.ok(html.includes('<div id="bellMenu" class="dropdown hidden w-80 right-0" role="region" aria-label="Notifications"></div>'));
  // Wie isset(): original_admin_id = null zählt nicht
  s.set('original_admin_id', null);
  assert.ok(!(await bellMarkup(ctx)).includes('data-readonly'));
  s.set('original_admin_id', 3);
  assert.ok((await bellMarkup(ctx)).startsWith(`<div class="relative" data-bell data-csrf="${CSRF}" data-user="5" data-readonly>\n`));
  // Werte aus der Sitzung nur als Zahl bzw. escaped
  s.set('user_id', '7"><script>');
  s.set('csrf', 'a"b<c');
  const odd = await bellMarkup(ctx);
  assert.ok(odd.startsWith('<div class="relative" data-bell data-csrf="a&quot;b&lt;c" data-user="7" data-readonly>\n'));
  assert.ok(!odd.includes('<script>'));
});

test('the editor: the bell from bellMarkup() with the account, bell.js between share.js and editor.js', async () => {
  const html = await get('/dashboard', 5);
  assert.equal(bellTag(html), `<div class="relative" data-bell data-csrf="${CSRF}" data-user="5">`);
  assert.match(html, new RegExp(ASSET('share') + '\\n {4}' + ASSET('bell') + '\\n {4}' + ASSET('editor')));
  assert.ok(html.indexOf('/static/js/ui.js') < html.indexOf('/static/js/bell.js'));
  // Die Glocke steht weiter zwischen Honigwaben und Teilen
  assert.ok(html.indexOf('id="hcBalance"') < html.indexOf('data-bell') && html.indexOf('data-bell') < html.indexOf('id="shareBtn"'));
  assert.deepEqual(checkText(html), []);
});

test('the editor of an admin working as the user: a read-only bell for the user’s account', async () => {
  const html = await get('/dashboard', 5, 3);
  assert.equal(bellTag(html), `<div class="relative" data-bell data-csrf="${CSRF}" data-user="5" data-readonly>`);
});

test('the editor without a page: the bell is there as well', async () => {
  await t.admin.query(`INSERT INTO \`${t.name}\`.users (id, email, password, full_name, username, created_at) VALUES (9401, 'bell-unit@test.de', 'x', 'Bell Unit', NULL, NOW())`);
  const html = await get('/dashboard', 9401);
  assert.ok(html.includes('id="noPageBox"'));
  assert.equal(bellTag(html), `<div class="relative" data-bell data-csrf="${CSRF}" data-user="9401">`);
  assert.match(html, new RegExp(ASSET('bell')));
});

test('the admin page: bell in the header before “View Live Site”, bell.js after ui.js, /admin#<tab> without reloading', async () => {
  const html = await get('/admin', 3);
  assert.equal(bellTag(html), `<div class="relative" data-bell data-csrf="${CSRF}" data-user="3">`);
  const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  assert.ok(header.indexOf('id="admin-page-title"') < header.indexOf('data-bell'), 'in the header, after the title');
  assert.ok(header.indexOf('data-bell') < header.indexOf('View Live Site'), 'next to “View Live Site”');
  const head = html.slice(0, html.indexOf('</head>'));
  assert.match(head, new RegExp(ASSET('ui') + '[\\s\\S]*' + ASSET('bell')));
  assert.ok(html.includes("if (window.OYSBell) OYSBell.mount(document.querySelector('[data-bell]'));"));
  // Nur Ziele dieser Seite ohne Abfrage; ein unbekannter Bereich geht den normalen Weg (Navigation über ui.js)
  assert.ok(html.includes("if (url.pathname !== '/admin' || url.search) return false;"));
  assert.ok(html.includes("if (tab === '') return true;"));
  assert.ok(html.includes('if (!Object.prototype.hasOwnProperty.call(ADMIN_TABS, tab)) return false;'));
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.deepEqual(checkText(html), []);
});

test('bell.js: no browser pop-ups, escaped texts, listed icons and colours, reads only what was shown', () => {
  const js = readFileSync(join(ROOT_DIR, 'static/js/bell.js'), 'utf8');
  assert.ok((targetFiles() as string[]).some((f) => f.endsWith('/static/js/bell.js')), 'the native-dialog check covers bell.js');
  assert.deepEqual(checkText(js, { file: 'static/js/bell.js' }), []);
  // Symbol nur nach dem Muster aus custom-dialogs §6.10, Farbe nur aus der Liste
  assert.ok(js.includes('var BX = /^bx[sl]?-[a-z0-9-]+$/;'));
  assert.ok(js.includes("icon: typeof n.icon === 'string' && BX.test(n.icon) ? n.icon : 'bx-bell',"));
  assert.ok(js.includes("var TONES = { ok: 1, info: 1, warn: 1, err: 1, hc: 1 };") && js.includes("tone: TONES[n.tone] ? n.tone : 'info'"));
  // Texte aus der Antwort nur escaped in die Liste (Hinweise setzt ui.js als Text)
  for (const part of ['esc(n.id)', 'esc(n.title)', 'esc(n.body)', 'esc(n.ago)']) assert.ok(js.includes(part), part);
  assert.equal(js.match(/innerHTML/g)?.length, 1, 'one innerHTML (render)');
  // Gelesen: ein Eintrag, alles bis zum zuletzt gezeigten, nichts im Nutzer-Modus eines Admins; immer mit CSRF-Token
  assert.ok(js.includes("if (!readonly) request('notifications-read', { id: n.id });"));
  assert.ok(js.includes("if (readonly || !latest) return;") && js.includes("request('notifications-read', { upTo: latest })"));
  assert.ok(js.includes("headers: { 'X-CSRF-Token': csrf }") && js.includes("fetch('/dashboard/api/' + path, o)"));
  // „Gelesen“ überlebt das Laden der Zielseite
  assert.ok(js.includes('o.keepalive = true;'));
  assert.ok(js.includes('return handle(r.status,'), 'answers go through OYSUI.handle()');
  // Ziele nur über OYSUI.openLink() (eigene Pfade, gleiche Herkunft)
  assert.ok(js.includes('if (n.link) openLink(n.link);') && !/location\.(href|assign|replace)/.test(js));
  // Takt und Grenzen aus custom-dialogs §6.10 / ROADMAP §3.6
  assert.ok(js.includes('var POLL_MS = 60000, REFRESH_MS = 15000, MAX_TOASTS = 3;'));
  assert.ok(js.includes("var KEY = 'oys.notify.' + user;") && js.includes('try { var v = localStorage.getItem(KEY);'));
  assert.ok(js.includes("' more notifications'"));
});

test('editor.js and the admin page use bell.js; the old bell code is gone', () => {
  const js = readFileSync(join(ROOT_DIR, 'static/js/editor.js'), 'utf8');
  assert.ok(js.includes('bell = window.OYSBell.mount($(\'[data-bell]\'), {'));
  assert.ok(!/loadNotifications|lastUnread|notif-read|open-messages/.test(js));
  // Ohne Seite fragt die Glocke trotzdem ab (Start außerhalb von „if (state.page)“)
  assert.ok(js.includes('  draft.start();\n  startBell();\n'));
  const css = readFileSync(join(ROOT_DIR, 'static/css/ui.css'), 'utf8');
  assert.ok(css.includes('[data-bell] .notif .ni.tone-hc { background: var(--hc-soft); color: var(--hc); }'));
  assert.ok(css.includes('[data-bell] .dropdown.hidden { display: none; }'));
  // Eine Quelle für das Aussehen: editor.css hat keine eigenen Regeln für die Glocke mehr
  const editorCss = readFileSync(join(ROOT_DIR, 'static/css/editor.css'), 'utf8');
  assert.ok(!/\.notif\b|\.bell-badge|\.bell-ring|#bellMenu/.test(editorCss));
});
