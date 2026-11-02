// Seitenplätze ohne Datenbank: wo eine Code-Seite zu sehen ist, ob ein Platz seine Link-Seite zeigt, der
// Vorschau-Schlüssel je Adresse und die Zahl der Seitenplätze (Team unbegrenzt).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestCtx } from '../src/web/ctx.js';
import { isShownLinkPage } from '../src/content/pages.js';
import { codeAddress, codePreviewToken, codePreviewValid, codeUrl } from '../src/code/sites.js';
import { pageAllowance, pageLimitText } from '../src/code/slots.js';
import { setConfigForTests } from '../src/config.js';
import { BASE } from './coreHarness.js';

test('codeAddress: its own address, the address of the slot that shows it, or nowhere', () => {
  const own = { id: 3, user_id: 5, slug: 'mia-dev' };
  const onPage = { id: 7, user_id: 5, slug: null };
  const slot = { id: 42, user_id: 5, slug: 'studio', code_site_id: 7 };
  assert.deepEqual(codeAddress(own), { kind: 'own', slug: 'mia-dev', slot: null });
  assert.deepEqual(codeAddress(own, slot), { kind: 'own', slug: 'mia-dev', slot: null });
  assert.deepEqual(codeAddress(onPage, slot), { kind: 'page', slug: 'studio', slot });
  assert.equal(codeAddress(onPage), null);
  assert.equal(codeAddress(onPage, { ...slot, code_site_id: 8 }), null);
  assert.equal(codeAddress(onPage, { ...slot, user_id: 6 }), null);
  assert.equal(codeAddress({ ...onPage, slug: '' }, null), null);
  assert.equal(codeUrl('studio'), codeUrl({ slug: 'studio' }));
});

test('a slot shows its link page unless it points to a code page', () => {
  assert.equal(isShownLinkPage(null), false);
  assert.equal(isShownLinkPage(undefined), false);
  assert.equal(isShownLinkPage({ id: 1, code_site_id: null }), true);
  // Vor dem Schritt V_CODE_SLOTS gibt es die Spalte nicht
  assert.equal(isShownLinkPage({ id: 1 }), true);
  assert.equal(isShownLinkPage({ id: 1, code_site_id: 7 }), false);
  assert.equal(isShownLinkPage({ id: 1, code_site_id: 0 }), false);
});

test('preview tokens: unchanged for the own address, bound to the address a code page is shown at', () => {
  const at = 1793000000;
  const own = { id: 3, slug: 'mia-dev' };
  assert.equal(codePreviewToken(own, at), codePreviewToken(own, at, 'mia-dev'));
  const onPage = { id: 7, slug: null };
  const token = codePreviewToken(onPage, null, 'studio');
  assert.equal(codePreviewValid(onPage, token, 'studio'), true);
  assert.equal(codePreviewValid(onPage, token, 'other'), false);
  assert.equal(codePreviewValid(onPage, token), false);
  assert.notEqual(codePreviewToken(onPage, at, 'studio'), codePreviewToken({ id: 8, slug: null }, at, 'studio'));
});

test('page allowance: max_pages for everyone, unlimited for the team', async () => {
  setConfigForTests({ ...BASE, max_pages: 3 });
  try {
    const ctx = makeTestCtx({ url: '/dashboard' });
    assert.deepEqual(await pageAllowance(ctx, { id: 5, is_admin: 0 }), { max: 3, unlimited: false });
    assert.deepEqual(await pageAllowance(ctx, { id: 3, is_admin: 1 }), { max: 3, unlimited: true });
    setConfigForTests({ ...BASE, max_pages: 1 });
    assert.deepEqual(await pageAllowance(ctx, { id: 5, is_admin: null }), { max: 1, unlimited: false });
    assert.equal(pageLimitText(1), 'You can create up to 1 page.');
    assert.equal(pageLimitText(3), 'You can create up to 3 pages.');
  } finally {
    setConfigForTests(BASE);
  }
});
