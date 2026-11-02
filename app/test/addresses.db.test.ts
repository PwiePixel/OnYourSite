// Liste aller Adressen mit Datenbank: der Schritt V_SITE_ADDRESSES (Bestand, alte Doppelungen, Statusseiten, erneuter
// Lauf), Reservierungen nach jeder Art der Freigabe (Seite gelöscht, Adresse geändert, Code-Seite umbenannt, Konto
// gelöscht), ihr Ablauf, die 404-Seite, Wettläufe zwischen Link- und Code-Seiten (auch während der Prüfung), die
// Namensregeln beim Anlegen, sites:repair und sites:release. Strenger Schalter: wer innerhalb einer Transaktion eine
// zweite Verbindung will, fällt sofort auf.
process.env.OYS_DB_STRICT = '1';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { closePool, one, transaction } from '../src/db.js';
import { date, time } from '../src/php.js';
import { setConfigForTests, type ConfigData } from '../src/config.js';
import { V_SITE_ADDRESSES, ensureSchema, hasIndex } from '../src/schema.js';
import { withConnection } from '../src/db.js';
import { makeTestCtx, type Ctx } from '../src/web/ctx.js';
import { Session } from '../src/web/session.js';
import { appRoutes } from '../src/app/dispatch.js';
import { setAuthMailerForTests } from '../src/app/auth.js';
import { notFoundData, notFoundView } from '../src/public/notFound.js';
import { slugProblem } from '../src/helpers.js';
import { createPage } from '../src/content/pages.js';
import { codeCreate } from '../src/code/sites.js';
import { deleteUser } from '../src/admin/users.js';
import { AddressTakenError, addressRow, claimAddress, releaseAddress, repairAddresses } from '../src/content/addresses.js';
import { sitesCommand, type SitesIo } from '../src/cli/sites.js';
import { BASE, CSRF, jsonBody, loginSession, runRequest, testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
const q = async (s: string, p: unknown[] = []): Promise<RowDataPacket[]> => (await t.admin.query<RowDataPacket[]>(s, p))[0];
const ago = (days: number): string => date('Y-m-d H:i:s', time() - Math.round(days * 86400));
const TAKEN = (slug: string) => `Sorry, the address “${slug}” is already taken.`;

before(async () => {
  t = await testDatabase('cs2addr');
  await t.admin.query('USE `' + t.name + '`');
  // Code-Seiten für Mia (5) und Tom (6) freigeschaltet, Regeln akzeptiert
  await q("INSERT INTO honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (5, 0, 'unlock', 'code_page', '', NOW()), (6, 0, 'unlock', 'code_page', '', NOW())");
  await q('UPDATE users SET code_terms_at = NOW() WHERE id IN (5, 6)');
  setAuthMailerForTests(null);
});

after(async () => {
  setAuthMailerForTests(undefined);
  await t.done();
});

// Editor-API wie über den Server (Sitzung mit Login und CSRF-Token)
async function api(userId: number, action: string, json?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const sid = await loginSession(userId);
  const post = json !== undefined;
  const ctx = makeTestCtx({
    method: post ? 'POST' : 'GET',
    url: '/dashboard/api/' + action,
    headers: post ? { 'content-type': 'application/json', 'x-csrf-token': CSRF } : {},
    cookies: { PHPSESSID: sid },
    rawBody: post ? Buffer.from(JSON.stringify(json)) : undefined,
  });
  await runRequest(ctx, appRoutes);
  return { status: ctx.status, body: jsonBody(ctx) };
}

// Registrierung wie über den Server (Gast-Sitzung mit CSRF-Token); Rückgabe: Weiterleitung und Hinweis
async function register(form: Record<string, string>): Promise<{ location: string | undefined; error: unknown }> {
  await q('DELETE FROM rate_limits');
  const guest = makeTestCtx({ url: '/register' });
  const s = await Session.start(guest);
  s.set('csrf', CSRF);
  await s.close();
  const ctx: Ctx = makeTestCtx({ method: 'POST', url: '/register', cookies: { PHPSESSID: s.id }, post: { csrf: CSRF, password: 'longenough', ...form } });
  await runRequest(ctx, appRoutes);
  return { location: ctx.header('Location'), error: ctx.session?.data.error };
}

const row = async (slug: string) => (await q('SELECT * FROM site_addresses WHERE slug = ?', [slug]))[0] as RowDataPacket | undefined;
const pageId = async (slug: string): Promise<number> => Number((await q('SELECT id FROM pages WHERE slug = ?', [slug]))[0]?.id ?? 0);
const isFree = async (slug: string): Promise<boolean> => (await notFoundData(makeTestCtx({ url: '/', host: slug + '.oys.test:8080' }))).isFree;

test('the step creates the list, keeps the link page on old collisions, adds status pages when present and can run again', async () => {
  // Eigene leere Datenbank auf dem Stand vor dem Schritt
  const name = t.name + '_mig';
  await t.admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await t.admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await closePool();
  setConfigForTests({ ...BASE, db: { ...(BASE.db as ConfigData), name }, uploads_dir: t.uploads });
  try {
    await ensureSchema({ upTo: V_SITE_ADDRESSES - 1 });
    const m = async (s: string, p: unknown[] = []) => (await t.admin.query<RowDataPacket[]>(s.replace(/`M`/g, '`' + name + '`'), p))[0];
    assert.equal((await m("SHOW TABLES FROM `M` LIKE 'site\\_addresses'")).length, 0);
    await m("INSERT INTO `M`.users (id, email, password) VALUES (5, 'mia@test.de', 'x'), (6, 'tom@test.de', 'x')");
    await m(`INSERT INTO \`M\`.pages (id, user_id, slug, slug_changed_at, created_at) VALUES
      (1, 5, 'mia', NULL, '2026-01-02 10:00:00'), (2, 5, 'mia-two', '2026-03-04 10:00:00', '2026-01-03 10:00:00'), (3, 6, 'clash', NULL, '2026-02-01 10:00:00')`);
    await m(`INSERT INTO \`M\`.code_sites (id, user_id, slug, title, created_at) VALUES (7, 6, 'tom-code', 't', '2026-05-01 10:00:00'), (8, 5, 'clash', 'c', '2026-05-02 10:00:00')`);
    // Statusseiten (aus ihrem eigenen Schritt, hier nur die Spalten, die die Übernahme braucht)
    await m('CREATE TABLE `M`.status_pages (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NULL, slug VARCHAR(63) NOT NULL, created_at DATETIME NULL)');
    await m("INSERT INTO `M`.status_pages (id, user_id, slug, created_at) VALUES (1, NULL, 'status', '2026-06-01 10:00:00'), (2, 6, 'tom-status', NULL)");
    await ensureSchema({ upTo: V_SITE_ADDRESSES });
    const rows = (await m('SELECT slug, kind, ref_id, user_id, claimed_at, released_at, hold_until FROM `M`.site_addresses ORDER BY slug')).map((r) => ({ ...r }));
    const tomStatus = rows.find((r) => r.slug === 'tom-status');
    assert.ok(tomStatus && /^\d{4}-/.test(String(tomStatus.claimed_at)), 'a status page without a date is claimed now');
    assert.deepEqual(rows.map((r) => (r.slug === 'tom-status' ? { ...r, claimed_at: 'NOW' } : r)), [
      { slug: 'clash', kind: 'page', ref_id: 3, user_id: 6, claimed_at: '2026-02-01 10:00:00', released_at: null, hold_until: null },
      { slug: 'mia', kind: 'page', ref_id: 1, user_id: 5, claimed_at: '2026-01-02 10:00:00', released_at: null, hold_until: null },
      { slug: 'mia-two', kind: 'page', ref_id: 2, user_id: 5, claimed_at: '2026-03-04 10:00:00', released_at: null, hold_until: null },
      { slug: 'status', kind: 'status', ref_id: 1, user_id: null, claimed_at: '2026-06-01 10:00:00', released_at: null, hold_until: null },
      { slug: 'tom-code', kind: 'code', ref_id: 7, user_id: 6, claimed_at: '2026-05-01 10:00:00', released_at: null, hold_until: null },
      { slug: 'tom-status', kind: 'status', ref_id: 2, user_id: 6, claimed_at: 'NOW', released_at: null, hold_until: null },
    ]);
    await withConnection(async (_db, conn) => {
      for (const idx of ['PRIMARY', 'idx_ref', 'idx_user', 'idx_hold']) assert.equal(await hasIndex(conn, 'site_addresses', idx), true, idx);
    });
    // Abgebrochen nach dem Anlegen (halb gefüllt): der Schritt läuft noch einmal und ergänzt nur
    await m("DELETE FROM `M`.site_addresses WHERE slug IN ('mia', 'tom-code')");
    await m("UPDATE `M`.oys_meta SET meta_value = ? WHERE meta_key = 'schema_version'", [String(V_SITE_ADDRESSES - 1)]);
    await ensureSchema({ upTo: V_SITE_ADDRESSES });
    const again = (await m('SELECT slug, kind, ref_id, user_id, claimed_at FROM `M`.site_addresses ORDER BY slug')).map((r) => ({ ...r }));
    assert.deepEqual(again.map((r) => r.slug), ['clash', 'mia', 'mia-two', 'status', 'tom-code', 'tom-status']);
    assert.equal(again.find((r) => r.slug === 'tom-status')?.claimed_at, tomStatus?.claimed_at);
  } finally {
    await closePool();
    setConfigForTests({ ...BASE, db: { ...(BASE.db as ConfigData), name: t.name }, uploads_dir: t.uploads });
    await t.admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  }
});

test('a page used for less than 7 days is free at once after deleting it; an older one is held 30 days for its owner', async () => {
  // Neu angelegt und gleich gelöscht: sofort frei (kein Horten durch Anlegen und Löschen)
  let res = await api(5, 'page-create', { slug: 'mia-fresh', title: 'Fresh' });
  assert.equal(res.body.ok, true);
  const fresh = Number(res.body.id);
  assert.deepEqual({ ...(await row('mia-fresh')) }, { slug: 'mia-fresh', kind: 'page', ref_id: fresh, user_id: 5, claimed_at: (await row('mia-fresh'))?.claimed_at, released_at: null, hold_until: null });
  res = await api(5, 'page-delete', { id: fresh, confirm: 'mia-fresh' });
  assert.equal(res.body.ok, true);
  assert.equal(await row('mia-fresh'), undefined);
  assert.equal(await isFree('mia-fresh'), true);
  res = await api(6, 'page-create', { slug: 'mia-fresh', title: 'Tom' });
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  res = await api(6, 'page-delete', { id: Number(res.body.id), confirm: 'mia-fresh' });
  assert.equal(res.body.ok, true);

  // Lange benutzt: reserviert für Mia
  res = await api(5, 'page-create', { slug: 'mia-old', title: 'Old' });
  const old = Number(res.body.id);
  await q("UPDATE site_addresses SET claimed_at = ? WHERE slug = 'mia-old'", [ago(10)]);
  res = await api(5, 'page-delete', { id: old, confirm: 'mia-old' });
  assert.equal(res.body.ok, true);
  const held = await row('mia-old');
  assert.equal(held?.kind, 'held');
  assert.equal(held?.ref_id, null);
  assert.equal(held?.user_id, 5);
  const until = Math.round((new Date(String(held?.hold_until).replace(' ', 'T')).getTime() - new Date(String(held?.released_at).replace(' ', 'T')).getTime()) / 86400000);
  assert.equal(until, 30);
  // Für alle anderen vergeben – auch auf der 404-Seite und bei der Registrierung
  res = await api(6, 'page-create', { slug: 'mia-old', title: 'Tom' });
  assert.deepEqual(res.body, { ok: false, error: TAKEN('mia-old') });
  assert.equal(await isFree('mia-old'), false);
  const page404 = notFoundView(await notFoundData(makeTestCtx({ url: '/mia-old' })));
  assert.ok(page404.includes('Page not found') && !page404.includes('This address is available'));
  assert.equal(await slugProblem('mia-old'), TAKEN('mia-old'));
  assert.equal(await slugProblem('mia-old', null, null, { userId: 6 }), TAKEN('mia-old'));
  assert.equal(await slugProblem('mia-old', null, null, { userId: 5 }), null);
  const reg = await register({ fullname: 'Squatter', email: 'squat@test.de', subdomain: 'mia-old' });
  assert.equal(reg.location, '/register');
  assert.equal(reg.error, TAKEN('mia-old'));
  // Mia nimmt sie zurück
  res = await api(5, 'page-create', { slug: 'mia-old', title: 'Back' });
  assert.equal(res.body.ok, true);
  assert.equal((await row('mia-old'))?.kind, 'page');
  assert.equal((await row('mia-old'))?.ref_id, Number(res.body.id));
  await api(5, 'page-delete', { id: Number(res.body.id), confirm: 'mia-old' });
});

test('a hold ends with hold_until: then anyone can take the address, and the next release prunes old holds', async () => {
  await q("INSERT INTO site_addresses (slug, kind, ref_id, user_id, claimed_at, released_at, hold_until) VALUES ('was-mine', 'held', NULL, 5, ?, ?, ?)", [ago(60), ago(31), ago(1)]);
  assert.equal(await isFree('was-mine'), true);
  assert.equal(await slugProblem('was-mine', null, null, { userId: 6 }), null);
  const res = await api(6, 'page-create', { slug: 'was-mine', title: 'Tom' });
  assert.equal(res.body.ok, true);
  const taken = await row('was-mine');
  assert.equal(taken?.kind, 'page');
  assert.equal(taken?.user_id, 6);
  assert.equal(taken?.hold_until, null);
  assert.equal(taken?.released_at, null);
  await api(6, 'page-delete', { id: Number(res.body.id), confirm: 'was-mine' });

  // Abgelaufene Reservierungen verschwinden bei der nächsten Freigabe (höchstens 50 auf einmal)
  for (let i = 0; i < 55; i++) {
    await q("INSERT INTO site_addresses (slug, kind, ref_id, user_id, claimed_at, released_at, hold_until) VALUES (?, 'held', NULL, NULL, ?, ?, ?)", ['gone-' + i, ago(90), ago(40), ago(10 - i / 10)]);
  }
  await q("INSERT INTO site_addresses (slug, kind, ref_id, user_id, claimed_at, released_at, hold_until) VALUES ('still-held', 'held', NULL, 7, ?, ?, ?)", [ago(90), ago(1), date('Y-m-d H:i:s', time() + 86400)]);
  const count = async () => Number((await q("SELECT COUNT(*) AS n FROM site_addresses WHERE slug LIKE 'gone-%'"))[0].n);
  assert.equal(await count(), 55);
  await transaction(async (_c, db) => releaseAddress(db, 'no-such-address', 5));
  assert.equal(await count(), 5);
  await transaction(async (_c, db) => releaseAddress(db, 'no-such-address', 5));
  assert.equal(await count(), 0);
  assert.equal((await row('still-held'))?.kind, 'held');
});

test('status addresses are held 90 days even after a short use; the system page is held for nobody', async () => {
  await q("INSERT INTO site_addresses (slug, kind, ref_id, user_id, claimed_at) VALUES ('tom-status', 'status', 2, 6, ?), ('sys-status', 'status', 1, NULL, ?)", [ago(1), ago(1)]);
  await transaction(async (_c, db) => {
    await releaseAddress(db, 'tom-status', 6, 'owner', { kind: 'status', refId: 2 });
    await releaseAddress(db, 'sys-status', null);
  });
  for (const [slug, owner] of [['tom-status', 6], ['sys-status', null]] as const) {
    const r = await row(slug);
    assert.equal(r?.kind, 'held', slug);
    assert.equal(r?.user_id, owner, slug);
    const days = Math.round((new Date(String(r?.hold_until).replace(' ', 'T')).getTime() - Date.now()) / 86400000);
    assert.equal(days, 90, slug);
  }
  // Freigabe mit falschem Besitzer oder falscher Seite ändert nichts
  await q("INSERT INTO site_addresses (slug, kind, ref_id, user_id, claimed_at) VALUES ('lea-keeps', 'page', 4, 7, ?)", [ago(100)]);
  await transaction(async (_c, db) => {
    await releaseAddress(db, 'lea-keeps', 6);
    await releaseAddress(db, 'lea-keeps', 7, 'owner', { kind: 'code', refId: 4 });
    await releaseAddress(db, 'lea-keeps', 7, 'owner', { kind: 'page', refId: 99 });
  });
  assert.equal((await row('lea-keeps'))?.kind, 'page');
  await q("DELETE FROM site_addresses WHERE slug IN ('tom-status', 'sys-status', 'lea-keeps')");
});

test('changing a link page address claims the new one and holds the old one; the owner can switch back', async () => {
  const mia = await pageId('mia');
  await q("UPDATE site_addresses SET claimed_at = ? WHERE slug = 'mia'", [ago(200)]);
  let res = await api(5, 'address', { page_id: mia, slug: 'mia-renamed', mode: 'subdomain' });
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  assert.equal((await row('mia-renamed'))?.ref_id, mia);
  assert.equal((await row('mia'))?.kind, 'held');
  assert.equal((await row('mia'))?.user_id, 5);
  assert.equal(await isFree('mia'), false);
  // Tom bekommt die alte Adresse nicht – weder als Seite noch als Code-Seite
  res = await api(6, 'page-create', { slug: 'mia', title: 'x' });
  assert.deepEqual(res.body, { ok: false, error: TAKEN('mia') });
  res = await api(6, 'code-create', { slug: 'mia', title: 'x', terms: true });
  assert.deepEqual(res.body, { ok: false, error: TAKEN('mia') });
  // Zurück (nach der Sperrfrist von 30 Tagen für Adresswechsel)
  await q('UPDATE pages SET slug_changed_at = ? WHERE id = ?', [ago(31), mia]);
  await q("UPDATE site_addresses SET claimed_at = ? WHERE slug = 'mia-renamed'", [ago(2)]);
  res = await api(5, 'address', { page_id: mia, slug: 'mia', mode: 'subdomain' });
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  assert.equal((await row('mia'))?.kind, 'page');
  assert.equal((await row('mia'))?.ref_id, mia);
  // Nur 2 Tage benutzt: sofort wieder frei
  assert.equal(await row('mia-renamed'), undefined);
  assert.equal((await one('SELECT username FROM users WHERE id = 5'))?.username, 'mia');
});

test('code pages: creating claims the address, renaming holds the old one, brand names are refused', async () => {
  let res = await api(6, 'code-create', { slug: 'paypal-status', title: 'x', terms: true });
  assert.deepEqual(res.body, { ok: false, error: 'The address “paypal-status” contains a brand name. Code pages can’t use brand names in their address.' });
  res = await api(6, 'code-create', { slug: 'onyoursite-lab', title: 'x', terms: true });
  assert.deepEqual(res.body, { ok: false, error: 'The address “onyoursite-lab” can’t use the OnYourSite name.' });
  // Für Link-Seiten gilt nur der Name von OnYourSite
  res = await api(6, 'page-create', { slug: 'onyoursite-fan', title: 'x' });
  assert.deepEqual(res.body, { ok: false, error: 'The address “onyoursite-fan” can’t use the OnYourSite name.' });

  res = await api(6, 'code-create', { slug: 'tom-lab', title: 'Lab', terms: true });
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  const site = (res.body.site as { id: number }).id;
  assert.equal((await row('tom-lab'))?.kind, 'code');
  assert.equal((await row('tom-lab'))?.ref_id, site);
  // Lange benutzt, dann umbenannt
  await q("UPDATE site_addresses SET claimed_at = ? WHERE slug = 'tom-lab'", [ago(40)]);
  res = await api(6, 'code-address', { slug: 'tom-lab2' });
  assert.equal((res.body.site as { slug: string }).slug, 'tom-lab2');
  assert.equal((await row('tom-lab2'))?.kind, 'code');
  assert.equal((await row('tom-lab'))?.kind, 'held');
  assert.equal((await row('tom-lab'))?.user_id, 6);
  res = await api(5, 'page-create', { slug: 'tom-lab', title: 'x' });
  assert.deepEqual(res.body, { ok: false, error: TAKEN('tom-lab') });
  // Tom darf seine alte Adresse wieder nehmen – auch für eine Link-Seite
  res = await api(6, 'page-create', { slug: 'tom-lab', title: 'Lab page' });
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  assert.equal((await row('tom-lab'))?.kind, 'page');
  await api(6, 'page-delete', { id: Number(res.body.id), confirm: 'tom-lab' });
  // Eine fremde Adresse für die Code-Seite: vergeben
  res = await api(6, 'code-address', { slug: 'lea' });
  assert.deepEqual(res.body, { ok: false, error: TAKEN('lea') });
  assert.equal((await row('tom-lab2'))?.kind, 'code');
});

test('races: a claim that lands during the request wins; nothing half-made stays behind', async () => {
  // Eine andere Transaktion belegt die Adresse, nachdem die Prüfung sie frei gesehen hat: die Anfrage wartet, sieht die
  // fremde Zeile und legt nichts an
  const other = await (await import('./coreHarness.js')).adminConnection();
  await other.query('USE `' + t.name + '`');
  const race = async (slug: string, run: () => Promise<unknown>, commit: boolean): Promise<unknown> => {
    await other.query('START TRANSACTION');
    await other.query("INSERT INTO site_addresses (slug, kind, ref_id, user_id, claimed_at) VALUES (?, 'page', 999, 7, NOW())", [slug]);
    const pending = run();
    // Erst weiter, wenn die Anfrage an der Adresse wartet (ihre Prüfung hat sie also frei gesehen)
    for (let i = 0; ; i++) {
      const [w] = await q("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE DB = ? AND INFO LIKE 'INSERT INTO site_addresses%'", [t.name]);
      if (Number(w.n) > 0) break;
      if (i > 400) throw new Error('the request never reached the address list');
      await new Promise((r) => setTimeout(r, 25));
    }
    await other.query(commit ? 'COMMIT' : 'ROLLBACK');
    return pending;
  };
  try {
    const users = Number((await q('SELECT COUNT(*) AS n FROM users'))[0].n);
    const reg = await race('race-one', () => register({ fullname: 'Racer', email: 'racer@test.de', subdomain: 'race-one' }), true) as { error: unknown };
    assert.equal(reg.error, 'This email address or page address is already registered.');
    assert.equal(Number((await q('SELECT COUNT(*) AS n FROM users'))[0].n), users, 'no account without a page');
    assert.equal(await pageId('race-one'), 0);

    const page = await race('race-two', () => api(5, 'page-create', { slug: 'race-two', title: 'x' }), true) as { body: Record<string, unknown> };
    assert.deepEqual(page.body, { ok: false, error: TAKEN('race-two') });
    assert.equal(await pageId('race-two'), 0);

    const code = await race('race-three', () => api(5, 'code-create', { slug: 'race-three', title: 'x', terms: true }), true) as { body: Record<string, unknown> };
    assert.deepEqual(code.body, { ok: false, error: TAKEN('race-three') });
    assert.equal((await q("SELECT COUNT(*) AS n FROM code_sites WHERE slug = 'race-three'"))[0].n, 0);

    // Die andere Transaktion wird zurückgenommen: dann klappt es
    const ok = await race('race-four', () => api(5, 'page-create', { slug: 'race-four', title: 'x' }), false) as { body: Record<string, unknown> };
    assert.equal(ok.body.ok, true);
    assert.equal((await row('race-four'))?.ref_id, await pageId('race-four'));
    await api(5, 'page-delete', { id: await pageId('race-four'), confirm: 'race-four' });
  } finally {
    await other.end();
  }
  await q("DELETE FROM site_addresses WHERE slug IN ('race-one', 'race-two', 'race-three')");
});

test('races between kinds: a link page and a code page for the same address – exactly one wins, every time', async () => {
  for (let i = 0; i < 6; i++) {
    const slug = 'both-' + i;
    const [page, code] = await Promise.all([
      transaction((_c, db) => createPage(7, slug, 'Lea', db)).then((id) => ({ ok: true, id }), (err: unknown) => ({ ok: false, err })),
      codeCreate(5, slug, 'Mia'),
    ]);
    const pageWon = page.ok;
    const codeWon = code[0] !== null;
    assert.notEqual(pageWon, codeWon, `${slug}: exactly one wins`);
    if (!pageWon) assert.ok((page as { err: unknown }).err instanceof AddressTakenError || /Duplicate/.test(String((page as { err: unknown }).err)), String((page as { err: unknown }).err));
    if (!codeWon) assert.equal(code[1], TAKEN(slug));
    const r = await row(slug);
    assert.equal(r?.kind, pageWon ? 'page' : 'code');
    const inPages = Number((await q('SELECT COUNT(*) AS n FROM pages WHERE slug = ?', [slug]))[0].n);
    const inCode = Number((await q('SELECT COUNT(*) AS n FROM code_sites WHERE slug = ?', [slug]))[0].n);
    assert.equal(inPages + inCode, 1, slug);
    // Aufräumen für die nächste Runde (eine Code-Seite je Konto)
    if (codeWon) {
      await q('DELETE FROM code_files WHERE site_id = ?', [Number(code[0]?.id)]);
      await q('DELETE FROM code_sites WHERE id = ?', [Number(code[0]?.id)]);
    } else {
      await q('DELETE FROM page_blocks WHERE page_id = ?', [(page as { id: number }).id]);
      await q('DELETE FROM pages WHERE id = ?', [(page as { id: number }).id]);
    }
    await q('DELETE FROM site_addresses WHERE slug = ?', [slug]);
  }
});

test('claimAddress: idempotent for the same site, refuses someone else, takes over own and expired holds', async () => {
  await q("INSERT INTO site_addresses (slug, kind, ref_id, user_id, claimed_at, released_at, hold_until) VALUES ('h-own', 'held', NULL, 5, ?, ?, ?), ('h-nobody', 'held', NULL, NULL, ?, ?, ?)",
    [ago(50), ago(5), date('Y-m-d H:i:s', time() + 86400 * 20), ago(50), ago(5), date('Y-m-d H:i:s', time() + 86400 * 20)]);
  await transaction(async (_c, db) => {
    await claimAddress(db, 'h-own', 'page', 501, 5);
    await claimAddress(db, 'h-own', 'page', 501, 5);
    await assert.rejects(claimAddress(db, 'h-own', 'page', 502, 5), AddressTakenError);
    await assert.rejects(claimAddress(db, 'h-nobody', 'page', 503, 5), AddressTakenError);
    await assert.rejects(claimAddress(db, 'h-nobody', 'status', 1, null), AddressTakenError);
  });
  assert.equal((await addressRow('h-own'))?.ref_id, 501);
  assert.equal((await addressRow('h-nobody'))?.kind, 'held');
  await q("DELETE FROM site_addresses WHERE slug IN ('h-own', 'h-nobody')");
});

test('deleting an account holds every address of it for nobody', async () => {
  // Lea (7): ihre Seite lange benutzt, eine eigene Reservierung, eine frische Code-Seite
  await q("UPDATE site_addresses SET claimed_at = ? WHERE slug = 'lea'", [ago(300)]);
  await q("INSERT INTO site_addresses (slug, kind, ref_id, user_id, claimed_at, released_at, hold_until) VALUES ('lea-before', 'held', NULL, 7, ?, ?, ?)",
    [ago(90), ago(3), date('Y-m-d H:i:s', time() + 86400 * 27)]);
  await q("INSERT INTO code_sites (user_id, slug, title, created_at, updated_at) VALUES (7, 'lea-code', 'L', NOW(), NOW())");
  await q("INSERT INTO site_addresses (slug, kind, ref_id, user_id, claimed_at) SELECT 'lea-code', 'code', id, 7, NOW() FROM code_sites WHERE slug = 'lea-code'");
  await deleteUser(7);
  assert.equal(Number((await q('SELECT COUNT(*) AS n FROM users WHERE id = 7'))[0].n), 0);
  const lea = await row('lea');
  assert.equal(lea?.kind, 'held');
  assert.equal(lea?.user_id, null);
  const before = await row('lea-before');
  assert.equal(before?.kind, 'held');
  assert.equal(before?.user_id, null);
  // Nur einen Tag benutzt: sofort frei
  assert.equal(await row('lea-code'), undefined);
  assert.equal(Number((await q('SELECT COUNT(*) AS n FROM site_addresses WHERE user_id = 7'))[0].n), 0);
  // Niemand bekommt die Adresse – auch nicht über die 404-Seite
  assert.equal(await isFree('lea'), false);
  const res = await api(5, 'page-create', { slug: 'lea', title: 'x' });
  assert.deepEqual(res.body, { ok: false, error: TAKEN('lea') });
});

// Ausgabe der CLI-Befehle sammeln
function io(answer?: string): SitesIo & { text: () => string } {
  let out = '';
  return {
    out: (s) => void (out += s),
    err: (s) => void (out += s),
    ask: answer === undefined ? undefined : async () => answer,
    text: () => out,
  };
}

test('sites:repair adds missing rows, holds orphaned ones, keeps status rows and never hands a reservation to someone else', async () => {
  const hasStatusTable = (await q("SHOW TABLES LIKE 'status\\_pages'")).length > 0;
  // Abweichungen wie nach Handarbeit in der Datenbank
  await q("INSERT INTO pages (user_id, slug, title, created_at) VALUES (5, 'by-hand', 'x', ?)", [ago(20)]);
  await q("INSERT INTO pages (user_id, slug, title, created_at) VALUES (5, 'onyoursite-old', 'x', ?)", [ago(400)]);
  await q("INSERT INTO site_addresses (slug, kind, ref_id, user_id, claimed_at) VALUES ('orphan', 'page', 9999, 6, ?)", [ago(100)]);
  await q("INSERT INTO site_addresses (slug, kind, ref_id, user_id, claimed_at, released_at, hold_until) VALUES ('held-for-tom', 'held', NULL, 6, ?, ?, ?), ('own-hold', 'held', NULL, 5, ?, ?, ?)",
    [ago(100), ago(2), date('Y-m-d H:i:s', time() + 86400 * 28), ago(100), ago(2), date('Y-m-d H:i:s', time() + 86400 * 28)]);
  await q("INSERT INTO pages (user_id, slug, title, created_at) VALUES (5, 'held-for-tom', 'x', NOW()), (5, 'own-hold', 'x', NOW())");
  await q("INSERT INTO site_addresses (slug, kind, ref_id, user_id, claimed_at) VALUES ('status', 'status', 1, NULL, ?), ('tom-status', 'status', 2, 6, ?)", [ago(30), ago(30)]);
  await q("INSERT INTO pages (user_id, slug, title, created_at) VALUES (5, 'tom-status', 'x', NOW())");

  const first = io();
  assert.equal(await sitesCommand('sites:repair', [], first), 0);
  const text = first.text();
  assert.match(text, /Added to the address list \(2\):\n  - link page #\d+ \(by-hand\)\n  - link page #\d+ \(onyoursite-old\)\n/);
  assert.match(text, /Name rule: link page #\d+ \(onyoursite-old\) – The address “onyoursite-old” can’t use the OnYourSite name\./);
  assert.match(text, /orphan \(link page #9999\) is reserved for user #6 for 30 days/);
  assert.match(text, /Reserved: link page #\d+ \(held-for-tom\) uses an address that is reserved for user #6/);
  assert.match(text, /link page #\d+ \(own-hold\): took back its own reservation/);
  assert.match(text, /Collision: link page #\d+ \(tom-status\) uses the address of status page #2/);
  assert.equal((await row('by-hand'))?.kind, 'page');
  assert.equal((await row('orphan'))?.kind, 'held');
  assert.equal((await row('orphan'))?.user_id, 6);
  assert.equal((await row('held-for-tom'))?.kind, 'held');
  assert.equal((await row('held-for-tom'))?.user_id, 6);
  assert.equal((await row('own-hold'))?.kind, 'page');
  // Ohne die Tabelle der Statusseiten bleiben deren Zeilen, wie sie sind
  if (!hasStatusTable) {
    assert.equal((await row('status'))?.kind, 'status');
    assert.equal((await row('tom-status'))?.kind, 'status');
  }

  // Zweiter Lauf: nichts mehr zu ändern, nur noch das Auffällige
  const second = io();
  await sitesCommand('sites:repair', [], second);
  assert.doesNotMatch(second.text(), /Added|Updated|Reserved for their owner/);
  assert.match(second.text(), /Please check/);

  // Mit der Tabelle: eine bestehende Statusseite behält ihre Zeile (auch gegen eine Link-Seite), eine verschwundene wird
  // reserviert. (Gibt es die echte Tabelle der Statusseiten schon, prüft das deren eigener Test.)
  if (!hasStatusTable) await q('CREATE TABLE status_pages (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NULL, slug VARCHAR(63) NOT NULL, created_at DATETIME NULL)');
  if (!hasStatusTable) try {
    await q("INSERT INTO status_pages (id, user_id, slug) VALUES (2, 6, 'tom-status')");
    const third = io();
    await sitesCommand('sites:repair', [], third);
    assert.equal((await row('tom-status'))?.kind, 'status');
    assert.equal((await row('tom-status'))?.ref_id, 2);
    assert.match(third.text(), /status \(status page #1\) is reserved for nobody for 90 days/);
    assert.equal((await row('status'))?.kind, 'held');
  } finally {
    await q('DROP TABLE status_pages');
  }
  await q("DELETE FROM pages WHERE slug IN ('by-hand', 'onyoursite-old', 'held-for-tom', 'own-hold', 'tom-status')");
  await q("DELETE FROM site_addresses WHERE slug IN ('by-hand', 'onyoursite-old', 'orphan', 'held-for-tom', 'own-hold', 'status', 'tom-status')");
});

test('sites:release ends a hold after showing it, only with a confirmation', async () => {
  await q("INSERT INTO site_addresses (slug, kind, ref_id, user_id, claimed_at, released_at, hold_until) VALUES ('support-me', 'held', NULL, 5, ?, ?, ?)",
    [ago(100), ago(2), date('Y-m-d H:i:s', time() + 86400 * 28)]);
  let out = io();
  assert.equal(await sitesCommand('sites:release', ['support-me'], out), 1);
  assert.match(out.text(), /The address “support-me” is reserved for user #5 \(mia@test\.de\) since .*, until .*\.\nRun again with --yes/);
  out = io('no');
  assert.equal(await sitesCommand('sites:release', ['support-me'], out), 1);
  assert.match(out.text(), /Nothing was changed\./);
  assert.equal((await row('support-me'))?.kind, 'held');
  out = io('yes');
  assert.equal(await sitesCommand('sites:release', ['support-me'], out), 0);
  assert.match(out.text(), /The address “support-me” is free again\./);
  assert.equal(await row('support-me'), undefined);
  // Keine Reservierung, unbekannt, falsch aufgerufen
  out = io();
  assert.equal(await sitesCommand('sites:release', ['pixel', '--yes'], out), 1);
  assert.match(out.text(), /is not reserved – it belongs to page #1/);
  out = io();
  assert.equal(await sitesCommand('sites:release', ['nothing-here', '--yes'], out), 1);
  assert.match(out.text(), /not in the address list/);
  out = io();
  assert.equal(await sitesCommand('sites:release', [], out), 1);
  assert.equal(await sitesCommand('sites:repair', ['extra'], out), 1);
  assert.match(out.text(), /Usage: node app\/dist\/cli\.js sites:repair \| sites:release <address> \[--yes\]/);
});

test('repairAddresses runs in one transaction and leaves a consistent list behind', async () => {
  const report = await transaction((_c, db) => repairAddresses(db));
  assert.deepEqual(report.added, []);
  assert.deepEqual(report.held, []);
  // Jede Link- und Code-Seite hat genau ihre Zeile
  const missing = await q(`SELECT p.slug FROM pages p LEFT JOIN site_addresses a ON a.slug = p.slug AND a.kind = 'page' AND a.ref_id = p.id WHERE a.slug IS NULL
    UNION SELECT s.slug FROM code_sites s LEFT JOIN site_addresses a ON a.slug = s.slug AND a.kind = 'code' AND a.ref_id = s.id WHERE s.slug IS NOT NULL AND a.slug IS NULL`);
  assert.deepEqual(missing.map((r) => r.slug), []);
});

// Warten, bis so viele Verbindungen dieser Datenbank gerade eine Anweisung nach einem dieser Muster (LIKE) ausführen –
// sie warten dann auf eine Sperre, die der Test hält
async function waitForStatements(patterns: string[], count: number): Promise<void> {
  const where = patterns.map(() => 'INFO LIKE ?').join(' OR ');
  for (let i = 0; ; i++) {
    const [w] = await q(`SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE DB = ? AND (${where})`, [t.name, ...patterns]);
    if (Number(w.n) >= count) return;
    if (i > 400) throw new Error(`never saw ${count} × ${patterns.join(' | ')}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
// Eine Anfrage, die eine Seite oder Code-Seite ändern will und an deren Zeile wartet (UPDATE oder Lesen mit Sperre)
const waitingOn = (table: string, id: number): string[] => [`UPDATE ${table} SET slug%`, `SELECT % FROM ${table} WHERE id = ${id} AND user_id = % FOR UPDATE`];

// Lebende Zeilen der Liste, die auf diese Seite zeigen
const liveRows = async (kind: string, id: number): Promise<string[]> =>
  (await q('SELECT slug FROM site_addresses WHERE kind = ? AND ref_id = ? ORDER BY slug', [kind, id])).map((r) => String(r.slug));

// Seiten der Wettlauf-Tests direkt entfernen (auch nach einem fehlgeschlagenen Test)
async function dropRacePages(prefix: string): Promise<void> {
  const ids = (await q('SELECT id FROM pages WHERE slug LIKE ?', [prefix + '%'])).map((r) => Number(r.id));
  for (const id of ids) {
    await q('DELETE FROM page_blocks WHERE page_id = ?', [id]);
    await q('DELETE FROM pages WHERE id = ?', [id]);
  }
  await q('DELETE FROM site_addresses WHERE slug LIKE ?', [prefix + '%']);
  await q('DELETE FROM rate_limits');
}

test('two address changes of one page at once leave exactly one live address; the one in between is not kept', async () => {
  await dropRacePages('mia-race-');
  const created = await api(5, 'page-create', { slug: 'mia-race-a', title: 'Race' });
  assert.equal(created.body.ok, true, JSON.stringify(created.body));
  const id = Number(created.body.id);
  const other = await (await import('./coreHarness.js')).adminConnection();
  await other.query('USE `' + t.name + '`');
  try {
    // Beide Anfragen lesen die Seite (Adresse mia-race-a) und warten dann an der Zeile, die der Test sperrt
    await other.query('START TRANSACTION');
    await other.query('SELECT id FROM pages WHERE id = ? FOR UPDATE', [id]);
    const first = api(5, 'address', { page_id: id, slug: 'mia-race-b', mode: 'subdomain' });
    await waitForStatements(waitingOn('pages', id), 1);
    const second = api(5, 'address', { page_id: id, slug: 'mia-race-c', mode: 'subdomain' });
    await waitForStatements(waitingOn('pages', id), 2);
    await other.query('COMMIT');
    const answers = [(await first).body, (await second).body];
    // Die Änderung, die als zweite an die Reihe kommt, sieht die erste: für sie gilt deren Sperrfrist (wie bei zwei
    // Änderungen nacheinander)
    const won = answers.findIndex((b) => b.ok === true);
    assert.notEqual(won, -1, JSON.stringify(answers));
    assert.deepEqual(answers[1 - won], { ok: false, error: 'You can change your address again in 30 days.' });
    const [winner, loser] = won === 0 ? ['mia-race-b', 'mia-race-c'] : ['mia-race-c', 'mia-race-b'];
    // Die Liste kennt genau die Adresse, die die Seite jetzt hat – keine zweite bleibt für sie belegt
    assert.equal(String((await q('SELECT slug FROM pages WHERE id = ?', [id]))[0].slug), winner);
    assert.deepEqual(await liveRows('page', id), [winner], JSON.stringify(answers));
    assert.equal(await row(loser), undefined);
  } finally {
    await other.query('ROLLBACK').catch(() => undefined);
    await other.end();
    await dropRacePages('mia-race-');
  }
});

test('an address change that waited for the deletion of its page answers 409 and claims nothing', async () => {
  await dropRacePages('mia-race-');
  const created = await api(5, 'page-create', { slug: 'mia-race-d', title: 'Race' });
  assert.equal(created.body.ok, true, JSON.stringify(created.body));
  const id = Number(created.body.id);
  const other = await (await import('./coreHarness.js')).adminConnection();
  await other.query('USE `' + t.name + '`');
  try {
    await other.query('START TRANSACTION');
    await other.query('SELECT id FROM pages WHERE id = ? FOR UPDATE', [id]);
    // Zuerst wartet das Löschen (unter der Sperre der Seitenplätze), dann die Adressänderung – beide an derselben Zeile
    const del = api(5, 'page-delete', { id, confirm: 'mia-race-d' });
    await waitForStatements(waitingOn('pages', id), 1);
    const pending = api(5, 'address', { page_id: id, slug: 'mia-race-e', mode: 'subdomain' }).catch((err: Error) => err);
    await waitForStatements(waitingOn('pages', id), 2);
    await other.query('COMMIT');
    assert.deepEqual((await del).body, { ok: true });
    const change = await pending;
    assert.ok(!(change instanceof Error), 'the address change must not crash: ' + String(change));
    // Das Löschen wartete zuerst und kommt zuerst dran: die Änderung findet ihre Seite nicht mehr (409, neu laden). Ginge
    // die Änderung voraus, gäbe das Löschen danach ihre neue Adresse frei – in beiden Fällen bleibt nichts belegt.
    if (change.status === 409) assert.equal(change.body.reload, true, JSON.stringify(change.body));
    else assert.equal(change.body.ok, true, JSON.stringify(change.body));
    // Keine Zeile der Liste zeigt auf die gelöschte Seite, und die neue Adresse ist nicht belegt
    assert.deepEqual(await liveRows('page', id), []);
    assert.equal(await row('mia-race-e'), undefined);
    assert.equal(await isFree('mia-race-e'), true);
  } finally {
    await other.query('ROLLBACK').catch(() => undefined);
    await other.end();
    await dropRacePages('mia-race-');
  }
});

test('two address changes of one code page at once leave exactly one live address', async () => {
  const site = Number((await q('SELECT id FROM code_sites WHERE user_id = 6 AND slug IS NOT NULL'))[0].id);
  const before = String((await q('SELECT slug FROM code_sites WHERE id = ?', [site]))[0].slug);
  const other = await (await import('./coreHarness.js')).adminConnection();
  await other.query('USE `' + t.name + '`');
  try {
    await other.query('START TRANSACTION');
    await other.query('SELECT id FROM code_sites WHERE id = ? FOR UPDATE', [site]);
    const first = api(6, 'code-address', { slug: 'tom-race-b' });
    await waitForStatements(waitingOn('code_sites', site), 1);
    const second = api(6, 'code-address', { slug: 'tom-race-c' });
    await waitForStatements(waitingOn('code_sites', site), 2);
    await other.query('COMMIT');
    const answers = [(await first).body, (await second).body];
    assert.equal(answers[0].ok, true, JSON.stringify(answers[0]));
    assert.equal(answers[1].ok, true, JSON.stringify(answers[1]));
    // Beide nacheinander: die zweite gilt; die Adresse dazwischen war nur kurz belegt und ist sofort wieder frei
    const slug = String((await q('SELECT slug FROM code_sites WHERE id = ?', [site]))[0].slug);
    assert.ok(slug === 'tom-race-b' || slug === 'tom-race-c', slug);
    assert.deepEqual(await liveRows('code', site), [slug], JSON.stringify(answers));
    assert.equal(await row(slug === 'tom-race-b' ? 'tom-race-c' : 'tom-race-b'), undefined);
    assert.notEqual((await row(before))?.kind, 'code');
  } finally {
    await other.query('ROLLBACK').catch(() => undefined);
    await other.end();
  }
});

test('a block by the team that lands while a code page changes its address wins: the address stays', async () => {
  const site = Number((await q('SELECT id FROM code_sites WHERE user_id = 6 AND slug IS NOT NULL'))[0].id);
  const before = String((await q('SELECT slug FROM code_sites WHERE id = ?', [site]))[0].slug);
  const other = await (await import('./coreHarness.js')).adminConnection();
  await other.query('USE `' + t.name + '`');
  try {
    // Das Team sperrt die Code-Seite (noch nicht bestätigt), während die Anfrage sie noch als offen gelesen hat
    await other.query('START TRANSACTION');
    await other.query("UPDATE code_sites SET is_blocked = 1, blocked_reason = 'Phishing' WHERE id = ?", [site]);
    const pending = api(6, 'code-address', { slug: 'tom-race-d' });
    await waitForStatements(waitingOn('code_sites', site), 1);
    await other.query('COMMIT');
    assert.deepEqual((await pending).body, { ok: false, error: 'Your code page has been blocked by the team: Phishing' });
    assert.equal(String((await q('SELECT slug FROM code_sites WHERE id = ?', [site]))[0].slug), before);
    assert.equal(await row('tom-race-d'), undefined);
    assert.deepEqual(await liveRows('code', site), [before]);
  } finally {
    await other.query('ROLLBACK').catch(() => undefined);
    await other.end();
    await q('UPDATE code_sites SET is_blocked = 0, blocked_reason = NULL WHERE id = ?', [site]);
  }
});
