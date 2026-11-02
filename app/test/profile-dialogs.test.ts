// Profilseiten mit eigenen Dialogen und Meldungen unter den Feldern (custom-dialogs CD-4): Kontaktformular, Termin- und
// Passwort-Seite tragen die Texte des Servers als data-error-*, page.js nutzt ui.js nur, wenn es da ist (ohne ui.js wie
// bisher), und das Startskript neuer Code-Seiten öffnet kein Browser-Popup mehr. Die Vergleiche mit PHP entfernen diese
// Zusätze (support/dialogParity.ts); die Abläufe im Browser prüft tests/e2e/profile-dialogs.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_DIR } from '../src/config.js';
import { renderPage, renderSimple } from '../src/content/render.js';
import { kalenderView } from '../src/public/views/kalender.js';
import { renderGate } from '../src/public/routes.js';
import { codeStarterFiles } from '../src/code/sites.js';
import { withoutDialogs } from './support/dialogParity.js';
// @ts-ignore – reines ES-Modul ohne Typen
import { checkText } from '../../tools/check-native-dialogs.mjs';

const page = { id: 7, user_id: 5, slug: 'mia', title: 'Mia', subtitle: '', bio: '', theme: 'candy', layout: 'buttons', address_mode: 'subdomain', settings: null };
const contactBlock = { id: 31, type: 'contact', is_visible: 1, data: JSON.stringify({ title: 'Message me', button: 'Send' }), schedule: null, protection: 'none', effect: 'none' };

test('contact form: the server’s words under each field and its minimum length', () => {
  const html = renderPage(page, [contactBlock]);
  assert.ok(html.includes('<input type="text" name="name" maxlength="80" required autocomplete="name" placeholder="Your name" data-error-required="Please enter your name.">'));
  assert.ok(html.includes('<input type="email" name="email" maxlength="190" required autocomplete="email" placeholder="you@example.com" data-error-required="Please enter a valid email address." data-error-type="Please enter a valid email address.">'));
  assert.ok(html.includes('<textarea name="message" rows="4" maxlength="2000" minlength="5" required placeholder="Your message…" data-error-required="Your message is a bit short." data-error-short="Your message is a bit short."></textarea>'));
  // novalidate bleibt: page.js prüft selbst (mit ui.js je Feld, ohne ui.js die bisherige Zeile)
  assert.match(html, /<form class="oys-block oys-card oys-contact" id="contact-31" method="post" action="\/_\/contact" novalidate>/);
  // ui.js vor page.js, beide mit defer; die Seite setzt dafür nichts im Browser (kein Cookie, keine Wache)
  assert.match(html, /<script src="\/static\/js\/ui\.js\?v=[0-9a-f]{8}" defer><\/script>\n<script src="\/static\/js\/page\.js\?v=[0-9a-f]{8}" defer><\/script>/);
  // Ohne die Zusätze ist die Ausgabe wieder die bisherige (Vergleich mit PHP)
  const plain = withoutDialogs(html);
  assert.ok(plain.includes('<textarea name="message" rows="4" maxlength="2000" required placeholder="Your message…"></textarea>'));
  assert.ok(!/data-error-|minlength="5"/.test(plain));
});

test('booking page: name, email, date and time carry the server’s texts; password page: the password field', () => {
  const html = kalenderView({ pageUrl: 'https://mia.on-your.site', avatar: '', name: 'Mia', ok: false, error: null, selfUrl: '/kalender', token: '1.x', post: {}, today: '2026-11-02', maxDate: '2027-11-02' });
  assert.ok(html.includes('name="guest_name" required maxlength="80" autocomplete="name" data-error-required="Please enter your name." value=""'));
  assert.ok(html.includes('name="guest_email" required autocomplete="email" data-error-required="Please enter a valid email address." data-error-type="Please enter a valid email address." value=""'));
  const date = 'Please choose a date between today and one year from now.';
  assert.ok(html.includes(`name="booking_date" required data-error-required="${date}" data-error-min="${date}" data-error-max="${date}" data-error-number="${date}" min="2026-11-02" max="2027-11-02"`));
  assert.ok(html.includes('<select name="booking_time" required data-error-required="Please choose a time.">'));
  const gate = renderGate(page, { id: 20, page_id: 7, type: 'link', data: { title: 'Secret' }, protection: 'password' } as never, 'password');
  assert.ok(gate.includes('<input type="password" name="pw" required autofocus data-error-required="Please enter the password.">'));
  // Einfache Seiten laden ui.js im Kopf (Seiten-Skin, keine App-Styles)
  const simple = renderSimple(page, 'Request a meeting', html);
  assert.match(simple, /<script src="\/static\/js\/ui\.js\?v=[0-9a-f]{8}" defer><\/script><\/head>/);
  assert.ok(!simple.includes('ui.css'));
});

test('page.js: own dialogs only with ui.js; without it everything stays as before', () => {
  const js = readFileSync(join(ROOT_DIR, 'static/js/page.js'), 'utf8');
  assert.deepEqual(checkText(js, { file: 'static/js/page.js' }), []);
  assert.ok(js.includes('var UI = window.OYSUI || null;'));
  assert.ok(js.includes("if (UI && !modalLayer) modalLayer = UI.layer(modal, { labelledBy: 'oys-modal-title', onEscape: closeModal });"));
  // Ohne ui.js: eigenes Escape und Fokus zurück wie bisher
  assert.ok(js.includes("if (!UI) document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && !modal.hidden) closeModal(); });"));
  assert.ok(js.includes('data-error-required="Please enter the password."'));
  assert.ok(js.includes('if (!UI.validate(form))') && js.includes("status.textContent = 'Please fill in all fields correctly.';"));
  assert.ok(js.includes("if (UI) layer = UI.layer(lb, { onEscape: close"));
  // Profilseiten bleiben ohne Cookies und ohne Speicher im Browser
  assert.ok(!/document\.cookie\s*=|localStorage|sessionStorage/.test(js));
});

test('new code pages: the starter script writes its greeting into the page instead of a browser pop-up', () => {
  const script = codeStarterFiles('Mia')['script.js'];
  assert.deepEqual(checkText(script), []);
  assert.ok(script.includes("note.textContent = 'Hello from your own website!';"));
  assert.ok(codeStarterFiles('Mia')['index.html'].includes('<button id="hello">Click me</button>'));
});
