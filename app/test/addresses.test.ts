// Liste aller Adressen ohne Datenbank: wem eine Zeile die Adresse versperrt (addressBlocks), die Namensregeln für neue
// Adressen (D12: der Name von OnYourSite für alle, Marken für Code- und Statusseiten), die Regeln für Reservierungen
// und die Zuordnung doppelter Schlüssel (MariaDB und MySQL schreiben den Namen verschieden).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOLD_POLICY, addressBlocks, addressNameProblem, duplicateKey, holdExpired, isTakenError, AddressTakenError } from '../src/content/addresses.js';

const NOW = '2026-11-02 12:00:00';
const row = (kind: string, ref: number | null, user: number | null, holdUntil: string | null = null) => ({ kind, ref_id: ref, user_id: user, hold_until: holdUntil });

test('the hold policy: link and code pages 30 days after at least 7 days of use, status pages always 90 days', () => {
  assert.deepEqual(HOLD_POLICY, { page: { days: 30, minUseDays: 7 }, code: { days: 30, minUseDays: 7 }, status: { days: 90, minUseDays: 0 } });
});

test('addressBlocks: own targets and own holds pass, everything else blocks', () => {
  // Die eigene Seite (nur die passende Art)
  assert.equal(addressBlocks(row('page', 2, 5), { pageId: 2, now: NOW }), false);
  assert.equal(addressBlocks(row('page', 2, 5), { codeId: 2, now: NOW }), true);
  assert.equal(addressBlocks(row('code', 7, 5), { codeId: 7, now: NOW }), false);
  assert.equal(addressBlocks(row('code', 7, 5), { pageId: 7, userId: 5, now: NOW }), true);
  assert.equal(addressBlocks(row('status', 4, 5), { statusId: 4, now: NOW }), false);
  assert.equal(addressBlocks(row('status', 4, 5), { statusId: 5, userId: 5, now: NOW }), true);
  // Eine Seite desselben Kontos ist trotzdem eine andere Seite
  assert.equal(addressBlocks(row('page', 3, 5), { pageId: 2, userId: 5, now: NOW }), true);
  // Reservierungen: die eigene geht, fremde und die für niemanden nicht – außer sie sind abgelaufen
  const until = '2026-11-20 10:00:00';
  assert.equal(addressBlocks(row('held', null, 5, until), { userId: 5, now: NOW }), false);
  assert.equal(addressBlocks(row('held', null, 5, until), { userId: 6, now: NOW }), true);
  assert.equal(addressBlocks(row('held', null, 5, until), { now: NOW }), true);
  assert.equal(addressBlocks(row('held', null, null, until), { userId: 5, now: NOW }), true);
  assert.equal(addressBlocks(row('held', null, null, until), { now: NOW }), true);
  assert.equal(addressBlocks(row('held', null, 5, '2026-11-02 11:59:59'), { userId: 6, now: NOW }), false);
  assert.equal(addressBlocks(row('held', null, null, '2026-11-01 00:00:00'), { now: NOW }), false);
  // Genau jetzt endet sie noch nicht; ohne Ende (Handarbeit) nie
  assert.equal(addressBlocks(row('held', null, 6, NOW), { now: NOW }), true);
  assert.equal(addressBlocks(row('held', null, 6, null), { now: NOW }), true);
  assert.equal(holdExpired({ hold_until: null }, NOW), false);
  // Zahlen aus der Datenbank können auch als Text kommen
  assert.equal(addressBlocks({ kind: 'page', ref_id: '2' as unknown as number, user_id: 5, hold_until: null }, { pageId: 2, now: NOW }), false);
});

test('name rules: the OnYourSite name is refused for every kind', () => {
  const refused = ['onyoursite-status', 'oys-status', 'onyoursitestatus', 'on-your-site-help', 'my-onyoursite', '0nyoursite-fan', 'onyours1te', 'oys', 'my-oys-page',
    'oys2', '0ys-shop', 'oonyoursite', 'on-yyour-site'];
  for (const slug of refused) {
    for (const kind of ['page', 'code', 'status'] as const) {
      assert.equal(addressNameProblem(slug, kind), `The address “${slug}” can’t use the OnYourSite name.`, `${slug} (${kind})`);
    }
  }
  for (const slug of ['oysters', 'boys-club', 'toys', 'royston', 'on-your-way', 'your-site', 'mia', 'site-on-your']) {
    assert.equal(addressNameProblem(slug, 'page'), null, slug);
  }
});

test('name rules: brands are refused for code and status pages only (whole tokens, distinctive brands anywhere)', () => {
  // Liste aus status-pages (status.names.test.ts) – alle diese Adressen sind in blacklist.php heute erlaubt
  const refused = ['discord-status', 'paypal-status', 'github-status', 'cloudflare-status', 'paypalstatus', 'status-paypal', 'pay-pal-status', 'paypa1-status',
    'ppaypal-status', 'x-status', 'my-x', 'ms-login', 'live-help', 'box-files', 'teams-meet', 'signal-chat', 'stripe-pay', 'notion-docs', 'office-portal',
    'g00gle-docs', 'instagramhelp', 'free-netflix', 'mycoinbase', 'discordnitro', 'amazon-deals', 'open-ai-tools', 'openai-key', 'gitlab-ci', 'gdrive-share',
    'faceb00k-login', 'ggithub', 'paypal2', 'my-gitlab', 'mygdrive', 'openaitools',
    // Kurze und wortähnliche Marken als ganzer Teil (Teile trennen Bindestriche und Ziffern) – so will es D12
    'live2', 'prime-numbers', 'meta-data', 'outlook-weather', 'telegram-art', 'android-tips'];
  for (const slug of refused) {
    assert.equal(addressNameProblem(slug, 'code'), `The address “${slug}” contains a brand name. Code pages can’t use brand names in their address.`, slug);
    assert.equal(addressNameProblem(slug, 'status'), `The address “${slug}” contains a brand name. Status pages can’t use brand names in their address.`, slug);
    assert.equal(addressNameProblem(slug, 'page'), null, `${slug} stays allowed for link pages`);
  }
  // Gewöhnliche Adressen, die Marken nur enthalten (kurze Marken zählen nur als ganzer Teil)
  const allowed = ['items-status', 'delivery-status', 'approval-status', 'acme-status', 'signals-lab', 'digit-lab', 'big-drive', 'open-air-cinema', 'boxing-club',
    'mia-dev', 'studio', 'visas-info', 'wiser', 'zoomer', 'slacker', 'steamboat', 'teamspeak', 'xylophone', 'max', 'emsland', 'outlooks', 'dockers',
    'androids', 'openair', 'digitlab-studio', 'bigdrive', 'metadata', 'primetime'];
  for (const slug of allowed) {
    for (const kind of ['page', 'code', 'status'] as const) assert.equal(addressNameProblem(slug, kind), null, `${slug} (${kind})`);
  }
});

test('duplicate keys are named the same for MariaDB and MySQL; taken errors are recognised', () => {
  const dup = (key: string) => Object.assign(new Error(`Duplicate entry 'x' for key '${key}'`), { code: 'ER_DUP_ENTRY', errno: 1062, sqlMessage: `Duplicate entry 'x' for key '${key}'` });
  assert.equal(duplicateKey(dup('uq_own')), 'uq_own');
  assert.equal(duplicateKey(dup('code_sites.uq_own')), 'uq_own');
  assert.equal(duplicateKey(dup('PRIMARY')), 'PRIMARY');
  assert.equal(duplicateKey(dup('site_addresses.PRIMARY')), 'PRIMARY');
  assert.equal(duplicateKey(Object.assign(new Error('Lock wait timeout exceeded'), { code: 'ER_LOCK_WAIT_TIMEOUT', errno: 1205 })), null);
  assert.equal(duplicateKey(new Error('boom')), null);
  assert.equal(duplicateKey(null), null);
  assert.equal(isTakenError(new AddressTakenError('mia')), true);
  assert.equal(isTakenError(dup('uq_slug')), true);
  assert.equal(isTakenError(dup('pages.uq_slug')), true);
  assert.equal(isTakenError(dup('PRIMARY')), true);
  assert.equal(isTakenError(dup('uq_email')), false);
  assert.equal(isTakenError(dup('uq_user')), false);
  assert.equal(isTakenError(new Error('x')), false);
});
