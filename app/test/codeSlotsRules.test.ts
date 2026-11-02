// Regeln für Code-Seiten ohne Datenbank: die Matrix E1–E8 (erste verletzte Regel gewinnt) und die Einstellungen
// 'code_pages' (Standardwerte, Grenzen, kaputte Werte).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canCreate, canMove, onPagesText, type CodeQuota } from '../src/code/slots.js';
import { CODE_SETTINGS_DEFAULTS, codeLimits, codeSettingsFrom } from '../src/code/settings.js';

// Ein Konto, dem alles erlaubt ist: freigeschaltet, nichts belegt, ein Platz für Code-Seiten
const base = (o: Partial<CodeQuota> = {}): CodeQuota => ({
  unlocked: true, more: false, morePrice: 0, banned: null, paused: false,
  own: 0, onPages: 0, total: 0, maxOnPages: 1, pagesUsed: 1, pages: { max: 3, unlimited: false }, ...o,
});
const free = { hasDomain: false };
const domain = { hasDomain: true };

test('canCreate: everything allowed for a fresh unlocked account', () => {
  assert.equal(canCreate(base(), 'own'), null);
  assert.equal(canCreate(base(), 'page', free), null);
  assert.equal(canCreate(base(), 'new-page'), null);
});

test('E1 banned wins over every other rule, with and without a reason', () => {
  const q = base({ banned: '', unlocked: false, paused: true, own: 1, onPages: 9, total: 5, morePrice: 10 });
  assert.deepEqual(canCreate(q, 'own'), { error: 'Code pages have been turned off for your account by the team.', status: 200 });
  assert.deepEqual(canCreate({ ...q, banned: 'spam' }, 'page', domain), { error: 'Code pages have been turned off for your account by the team: spam', status: 200 });
  assert.equal(canMove({ ...q, banned: 'spam' }, 'own')?.error, 'Code pages have been turned off for your account by the team: spam');
});

test('E2 not unlocked: 403 with need code_page, before the pause', () => {
  const r = canCreate(base({ unlocked: false, paused: true }), 'new-page');
  assert.deepEqual(r, { error: 'Unlock code pages with honeycombs first.', status: 403, need: 'code_page' });
  // Umziehen braucht keine Freischaltung (die Code-Seite gibt es schon)
  assert.equal(canMove(base({ unlocked: false }), 'own'), null);
});

test('E3 paused: different texts for new code pages and for moves', () => {
  assert.equal(canCreate(base({ paused: true }), 'own')?.error, 'New code pages are paused right now. Please try again later.');
  assert.equal(canMove(base({ paused: true }), 'page', free)?.error, 'Code pages can’t move to a new address right now. Please try again later.');
  assert.equal(canMove(base({ paused: true }), 'own')?.error, 'Code pages can’t move to a new address right now. Please try again later.');
});

test('E4 one own address: create own and move to own', () => {
  assert.equal(canCreate(base({ own: 1, total: 1 }), 'own')?.error, 'You already have a code page with its own address.');
  assert.equal(canMove(base({ own: 1 }), 'own')?.error, 'You already have a code page with its own address.');
  // Ein Platz ist davon nicht betroffen
  assert.equal(canCreate(base({ own: 1, total: 1 }), 'page', free), null);
});

test('E5 page slots for code: 0 (default), one, several', () => {
  assert.equal(canCreate(base({ maxOnPages: 0 }), 'page', free)?.error, 'Code pages can’t use your page addresses right now.');
  assert.equal(canCreate(base({ maxOnPages: 0 }), 'new-page')?.error, 'Code pages can’t use your page addresses right now.');
  assert.equal(canMove(base({ maxOnPages: 0 }), 'page', free)?.error, 'Code pages can’t use your page addresses right now.');
  assert.equal(canCreate(base({ onPages: 1, total: 1 }), 'page', free)?.error, 'Only one of your pages can show a code page.');
  assert.equal(canCreate(base({ onPages: 2, maxOnPages: 2, total: 2 }), 'page', free)?.error, 'Up to 2 of your pages can show a code page.');
  assert.equal(onPagesText(3), 'Up to 3 of your pages can show a code page.');
  // own ist davon nicht betroffen
  assert.equal(canCreate(base({ maxOnPages: 0 }), 'own'), null);
});

test('E6 page allowance only for a new page, staff unlimited', () => {
  assert.equal(canCreate(base({ pagesUsed: 3 }), 'new-page')?.error, 'You can create up to 3 pages.');
  assert.equal(canCreate(base({ pagesUsed: 1, pages: { max: 1, unlimited: false } }), 'new-page')?.error, 'You can create up to 1 page.');
  assert.equal(canCreate(base({ pagesUsed: 3 }), 'page', free), null);
  assert.equal(canCreate(base({ pagesUsed: 30, pages: { max: 3, unlimited: true } }), 'new-page'), null);
});

test('E7 a slot with a custom domain cannot show code', () => {
  const text = 'Remove the custom domain of this page first – custom domains work for link pages only.';
  assert.equal(canCreate(base(), 'page', domain)?.error, text);
  assert.equal(canMove(base(), 'page', domain)?.error, text);
  // E5 kommt vorher
  assert.equal(canCreate(base({ maxOnPages: 0 }), 'page', domain)?.error, 'Code pages can’t use your page addresses right now.');
});

test('E8 more code pages cost honeycombs only at a price, and comes last', () => {
  const need = { error: 'Unlock more code pages with honeycombs first.', status: 403, need: 'code_more' };
  assert.deepEqual(canCreate(base({ total: 1, own: 1, morePrice: 50 }), 'page', free), need);
  assert.equal(canCreate(base({ total: 1, own: 1, morePrice: 50, more: true }), 'page', free), null);
  assert.equal(canCreate(base({ total: 1, own: 1, morePrice: 0 }), 'page', free), null);
  assert.equal(canCreate(base({ total: 0, morePrice: 50 }), 'own'), null);
  // Eine andere Regel lehnt ab: dann wird nicht zum Bezahlen aufgefordert
  assert.equal(canCreate(base({ total: 1, own: 1, morePrice: 50 }), 'own')?.error, 'You already have a code page with its own address.');
  assert.equal(canCreate(base({ total: 1, own: 1, morePrice: 50 }), 'page', domain)?.error,
    'Remove the custom domain of this page first – custom domains work for link pages only.');
  // Umziehen schafft keine weitere Code-Seite
  assert.equal(canMove(base({ total: 2, own: 1, morePrice: 50 }), 'page', free), null);
});

test('code_pages settings: defaults, clamps, broken values', () => {
  assert.deepEqual(codeSettingsFrom(null, 3), CODE_SETTINGS_DEFAULTS);
  assert.deepEqual(codeSettingsFrom('{broken', 3), CODE_SETTINGS_DEFAULTS);
  assert.deepEqual(codeSettingsFrom('[1,2]', 3), CODE_SETTINGS_DEFAULTS);
  assert.equal(CODE_SETTINGS_DEFAULTS.max_on_pages, 1);
  const s = codeSettingsFrom({ max_on_pages: 9, max_files: 0, max_file_kb: 4096, max_total_kb: 300, paused: 'true' }, 3);
  assert.deepEqual(s, { max_on_pages: 3, max_files: 1, max_file_kb: 1024, max_total_kb: 1024, paused: false });
  // max_on_pages höchstens max_pages
  assert.equal(codeSettingsFrom({ max_on_pages: 3 }, 2).max_on_pages, 2);
  assert.equal(codeSettingsFrom('{"max_on_pages":"2","paused":true}', 3).max_on_pages, 2);
  assert.equal(codeSettingsFrom('{"paused":true}', 3).paused, true);
  assert.equal(codeSettingsFrom({ max_files: 'x' }, 3).max_files, 30);
  assert.deepEqual(codeLimits(CODE_SETTINGS_DEFAULTS), { files: 30, file: 262144, total: 2097152 });
});
