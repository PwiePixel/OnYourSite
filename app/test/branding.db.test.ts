// Branding mit Datenbank (premium-domains PD-1): der Schritt V_BRANDING_LEGACY (Bestandsschutz Q9 – mit dem alten
// Schalter oder mit CSS, das den Hinweis ausblendet; Admins und Premium-Besitzer bleiben, wie sie sind; wiederholbar),
// dann über den Server: die Seite, die Schnittstelle und das Vorschaubild folgen dem Premium des Besitzers, eigenes CSS
// blendet den Hinweis nicht mehr aus (feste Stile, Hinweis beim Speichern), der Bestandsschutz lässt sich nur
// ausschalten, das Team schaltet den gespeicherten Wert, und die Wartezeit für Adressen gilt für alle außer dem Team.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { one } from '../src/db.js';
import { V_BRANDING_LEGACY, ensureSchema } from '../src/schema.js';
import { makeTestCtx, type Ctx } from '../src/web/ctx.js';
import { dispatch } from '../src/router.js';
import { appRoutes } from '../src/app/dispatch.js';
import { loadPage } from '../src/content/pages.js';
import { ogHash, ogSupported } from '../src/content/share.js';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_FAVICON, FOOTER_STYLE, CSS_WARNING, iconHash } from '../src/content/branding.js';
import { codeBadge, codeServe } from '../src/code/serve.js';
import { lossPreview } from '../src/honeycombs/features.js';
import { poolDb } from '../src/honeycombs/util.js';
import { passwordHash } from '../src/crypto.js';
import { addDays, nowStr } from '../src/honeycombs/clock.js';
import { CSRF, SOURCE, loginSession, runRequest, testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
const HOST = 'oys.test:8080';
const MIG = { free: 0, freeCss: 0, freeStyle: 0, premium: 0, admin: 0, expired: 0, list: 0, broken: 0, emoji: 0 };

async function sql(query: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [r] = await t.admin.query<RowDataPacket[]>(query.replace(/`DB`/g, '`' + t.name + '`'), params);
  return r;
}
const settingsOf = async (id: number): Promise<string> => String((await sql('SELECT settings FROM `DB`.pages WHERE id = ?', [id]))[0].settings);

async function addPage(userId: number, slug: string, settings: string): Promise<number> {
  const [r] = await t.admin.query(`INSERT INTO \`${t.name}\`.pages (user_id, slug, position, title, subtitle, bio, theme, layout, address_mode, settings, created_at, updated_at)
    VALUES (?, ?, 9, ?, '', '', 'minimal', 'buttons', 'subdomain', ?, NOW(), NOW())`, [userId, slug, 'T ' + slug, settings]);
  return (r as { insertId: number }).insertId;
}

before(async () => {
  // Eigene Datenbank auf dem Stand direkt vor dem Schritt (Tabellen der Quelle, dann bis V_BRANDING_LEGACY - 1)
  t = await testDatabase('brand', { empty: true });
  const [tables] = await t.admin.query<RowDataPacket[]>(`SHOW TABLES FROM \`${SOURCE}\``);
  for (const row of tables) {
    const name = String(Object.values(row)[0]);
    await t.admin.query(`CREATE TABLE \`${t.name}\`.\`${name}\` LIKE \`${SOURCE}\`.\`${name}\``);
    await t.admin.query(`INSERT INTO \`${t.name}\`.\`${name}\` SELECT * FROM \`${SOURCE}\`.\`${name}\``);
  }
  // Ist die Quelle schon weiter (z. B. nach einem Start der Seite), zurück auf den Stand davor – der Schritt ist reine
  // Datenarbeit und darf noch einmal laufen
  await sql("UPDATE `DB`.oys_meta SET meta_value = LEAST(CAST(meta_value AS UNSIGNED), ?) WHERE meta_key = 'schema_version'", [V_BRANDING_LEGACY - 1]);
  await ensureSchema({ upTo: V_BRANDING_LEGACY - 1 });
  // Besitzer: Mia (5) ohne Premium, Tom (6) mit Premium, Lea (7) mit abgelaufenem Premium, Admin (3)
  await sql('UPDATE `DB`.users SET premium_until = ? WHERE id = 6', [addDays(nowStr(), 20)]);
  await sql("UPDATE `DB`.users SET premium_until = '2026-01-01 00:00:00' WHERE id = 7");
  MIG.free = await addPage(5, 'mig-free', '{"seo":{"title":"","description":"","keywords":""},"custom_css":"","hide_branding":true,"notify_email":true}');
  MIG.freeCss = await addPage(5, 'mig-css', '{"custom_css":".oys-foot{display:none}","hide_branding":false,"share_button":true}');
  MIG.freeStyle = await addPage(5, 'mig-style', '{"custom_css":".oys-foot a{color:#fff}","hide_branding":false}');
  MIG.premium = await addPage(6, 'mig-premium', '{"hide_branding":true}');
  MIG.admin = await addPage(3, 'mig-admin', '{"hide_branding":true,"custom_css":"footer{opacity:0}"}');
  MIG.expired = await addPage(7, 'mig-expired', '{"hide_branding":true}');
  MIG.list = await addPage(8, 'mig-list', '[]');
  MIG.broken = await addPage(8, 'mig-broken', '{"hide_branding":tru');
  MIG.emoji = await addPage(8, 'mig-emoji', '{"seo":{"title":"Café 🐝 \\/ slash","description":"","keywords":""},"custom_css":"main > :last-child { visibility: hidden }","hide_branding":"0"}');
});

after(async () => {
  await t.done();
});

test('V_BRANDING_LEGACY keeps what pages show today: free pages that hide the note keep hiding it, nothing else changes, and it can run again', async () => {
  const before = new Map<number, string>();
  for (const id of Object.values(MIG)) before.set(id, await settingsOf(id));
  const page1 = await settingsOf(1);
  await ensureSchema({ upTo: V_BRANDING_LEGACY });
  assert.equal(String((await sql("SELECT meta_value FROM `DB`.oys_meta WHERE meta_key = 'schema_version'"))[0].meta_value), String(V_BRANDING_LEGACY));
  // Alter Schalter ohne Premium → Bestandsschutz (Schlüssel am Ende, sonst unverändert)
  assert.equal(await settingsOf(MIG.free), '{"seo":{"title":"","description":"","keywords":""},"custom_css":"","hide_branding":true,"notify_email":true,"branding_legacy":true}');
  // CSS, das den Hinweis ausblendet → Schalter an + Bestandsschutz
  assert.equal(await settingsOf(MIG.freeCss), '{"custom_css":".oys-foot{display:none}","hide_branding":true,"share_button":true,"branding_legacy":true}');
  assert.equal(await settingsOf(MIG.emoji), '{"seo":{"title":"Café 🐝 \\/ slash","description":"","keywords":""},"custom_css":"main > :last-child { visibility: hidden }","hide_branding":true,"branding_legacy":true}');
  // Abgelaufenes Premium zählt wie keins
  assert.equal(await settingsOf(MIG.expired), '{"hide_branding":true,"branding_legacy":true}');
  // CSS, das nur umgestaltet; Premium-Besitzer; Admins; kaputte oder leere Einstellungen: unverändert
  for (const id of [MIG.freeStyle, MIG.premium, MIG.admin, MIG.list, MIG.broken]) assert.equal(await settingsOf(id), before.get(id), String(id));
  assert.equal(await settingsOf(1), page1, 'the admin’s own page');
  // Noch einmal: nichts ändert sich mehr
  const after1 = new Map<number, string>();
  for (const id of Object.values(MIG)) after1.set(id, await settingsOf(id));
  await sql("UPDATE `DB`.oys_meta SET meta_value = ? WHERE meta_key = 'schema_version'", [String(V_BRANDING_LEGACY - 1)]);
  await ensureSchema({ upTo: V_BRANDING_LEGACY });
  for (const id of Object.values(MIG)) assert.equal(await settingsOf(id), after1.get(id), 'second run ' + id);
});

// ---------------------------------------------------------------- über den Server

async function get(url: string, host = HOST): Promise<Ctx> {
  return runRequest(makeTestCtx({ url, host }), dispatch);
}

async function api(userId: number, action: string, json?: unknown, impersonatedBy?: number): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  const sid = await loginSession(userId, { impersonatedBy });
  const post = json !== undefined;
  const ctx = makeTestCtx({
    method: post ? 'POST' : 'GET', url: '/dashboard/api/' + action, host: HOST,
    headers: post ? { 'content-type': 'application/json', 'x-csrf-token': CSRF } : {}, cookies: { PHPSESSID: sid },
    rawBody: post ? Buffer.from(JSON.stringify(json)) : undefined,
  });
  await runRequest(ctx, appRoutes);
  const raw = String(ctx.body);
  return { status: ctx.status, body: raw.startsWith('{') ? JSON.parse(raw) as Record<string, unknown> : {}, raw };
}

// Speichern wie der Editor: die gespeicherte Seite mit geänderten Einstellungen, die Blöcke wie sie sind
async function save(userId: number, pageId: number, settings: Record<string, unknown>, impersonatedBy?: number) {
  const page = (await loadPage(pageId))!;
  const stored = JSON.parse(String(page.settings)) as Record<string, unknown>;
  return api(userId, 'save', { page: { id: pageId, title: page.title, subtitle: page.subtitle, bio: page.bio, theme: page.theme, layout: page.layout,
    settings: { ...stored, ...settings } }, blocks: [] }, impersonatedBy);
}

const PINNED = `<footer class="oys-foot" style="${FOOTER_STYLE}">`;
const hasFooter = (html: string): boolean => html.includes('Made with <strong');
const apiHidden = async (slug: string): Promise<unknown> =>
  (JSON.parse(String((await get('/api.php?user=' + slug)).body)) as { data: { profile: { hide_branding: unknown } } }).data.profile.hide_branding;

test('a free page: the switch stays off, custom CSS can’t hide the pinned note, and the save answer says so', async () => {
  const res = await save(5, 2, { hide_branding: true, custom_css: '.oys-foot{display:none!important}' });
  assert.equal(res.body.ok, true, res.raw);
  assert.equal(res.body.cssWarning, CSS_WARNING);
  const stored = JSON.parse(await settingsOf(2)) as Record<string, unknown>;
  assert.equal(stored.hide_branding, false, 'free accounts can’t switch it on');
  assert.equal(stored.custom_css, '.oys-foot{display:none!important}', 'custom CSS stays free');
  const html = String((await get('/', 'mia.' + HOST)).body);
  assert.ok(html.includes(PINNED), 'pinned footer');
  assert.ok(html.includes('.oys-foot{display:none!important}'), 'the CSS is still printed');
  assert.equal(await apiHidden('mia'), false);
  // CSS, das den Hinweis nicht anspricht: kein Hinweis
  const plain = await save(5, 2, { custom_css: '.oys-name{letter-spacing:.1em}' });
  assert.equal(plain.body.ok, true);
  assert.equal('cssWarning' in plain.body, false);
});

test('a Premium page hides the note, the card mark and the API flag – until Premium ends', async () => {
  const res = await save(6, 3, { hide_branding: true, custom_css: '.oys-foot{display:none}' });
  assert.equal(res.body.ok, true, res.raw);
  assert.equal('cssWarning' in res.body, false, 'no hint while the note is hidden anyway');
  let html = String((await get('/', 'tom.' + HOST)).body);
  assert.equal(hasFooter(html), false);
  assert.equal(await apiHidden('tom'), true);
  const page = (await loadPage(3))!;
  const hidden = ogHash(page, true);
  assert.ok(html.includes(`/_/og/3-${hidden}.png`), 'card URL with the mark hidden');
  if (ogSupported()) assert.equal((res.body.page as { og: string }).og.endsWith(`/_/og/3-${hidden}.png`), true, 'editor payload');
  if (ogSupported()) assert.equal((await get(`/_/og/3-${hidden}.png`, 'tom.' + HOST)).status, 200);
  // Premium endet: Hinweis, Zeichen und Schnittstelle sind sofort zurück, der Schalter bleibt gespeichert
  await sql("UPDATE `DB`.users SET premium_until = '2026-01-02 00:00:00' WHERE id = 6");
  html = String((await get('/', 'tom.' + HOST)).body);
  assert.ok(html.includes(PINNED));
  assert.equal(await apiHidden('tom'), false);
  const shown = ogHash(page, false);
  assert.notEqual(shown, hidden);
  assert.ok(html.includes(`/_/og/3-${shown}.png`));
  if (ogSupported()) {
    const old = await get(`/_/og/3-${hidden}.png`, 'tom.' + HOST);
    assert.equal(old.status, 302, 'the old card forwards to the current one');
    assert.equal(old.header('Location'), `/_/og/3-${shown}.png`);
  }
  assert.equal((JSON.parse(await settingsOf(3)) as { hide_branding: boolean }).hide_branding, true);
  await sql('UPDATE `DB`.users SET premium_until = ? WHERE id = 6', [addDays(nowStr(), 20)]);
  assert.equal(hasFooter(String((await get('/', 'tom.' + HOST)).body)), false, 'renewing restores it without any action');
});

test('legacy pages keep hiding the note, can turn it off, and need Premium to turn it on again', async () => {
  assert.equal(hasFooter(String((await get('/', 'mig-expired.' + HOST)).body)), false);
  assert.equal(await apiHidden('mig-expired'), true);
  let res = await save(7, MIG.expired, { hide_branding: true });
  assert.equal(res.body.ok, true, res.raw);
  assert.equal((res.body.page as { settings: { branding_legacy?: boolean } }).settings.branding_legacy, true, 'the editor sees the flag');
  // Aus der Eingabe kommt der Bestandsschutz nie
  res = await save(5, 2, { hide_branding: true, branding_legacy: true });
  assert.equal((JSON.parse(await settingsOf(2)) as Record<string, unknown>).branding_legacy, undefined);
  // Ausschalten: der Bestandsschutz fällt weg, der Hinweis ist zurück
  res = await save(7, MIG.expired, { hide_branding: false });
  assert.equal(await settingsOf(MIG.expired) === '{"hide_branding":true,"branding_legacy":true}', false);
  assert.equal((JSON.parse(await settingsOf(MIG.expired)) as Record<string, unknown>).branding_legacy, undefined);
  assert.ok(hasFooter(String((await get('/', 'mig-expired.' + HOST)).body)));
  // Wieder einschalten geht ohne Premium nicht mehr
  await save(7, MIG.expired, { hide_branding: true });
  assert.equal((JSON.parse(await settingsOf(MIG.expired)) as Record<string, unknown>).hide_branding, false);
});

test('staff switch the stored value for a user, but it only counts with the user’s Premium (preview included)', async () => {
  const res = await save(5, 2, { hide_branding: true }, 3);
  assert.equal(res.body.ok, true, res.raw);
  assert.equal((JSON.parse(await settingsOf(2)) as Record<string, unknown>).hide_branding, true, 'stored');
  assert.ok(hasFooter(String((await get('/', 'mia.' + HOST)).body)), 'Mia has no Premium – the note stays');
  const page = (await loadPage(2))!;
  const preview = await api(5, 'preview', { page: { id: 2, title: page.title, settings: { hide_branding: true } }, blocks: [] }, 3);
  assert.ok(hasFooter(preview.raw), 'the preview shows what visitors will see');
  const own = await api(6, 'preview', { page: { id: 3, title: 'Tom', settings: { hide_branding: true } }, blocks: [] });
  assert.equal(hasFooter(own.raw), false, 'Premium preview without the note');
  await save(5, 2, { hide_branding: false }, 3);
});

test('Premium removes the rest: no “| OnYourSite” in title and alt text, the avatar as favicon (64 × 64, centre, generated once)', async () => {
  // Tom (Premium, Schalter an) bekommt ein Profilbild: links rot, rechts blau (200 × 100)
  const { default: sharp } = await import('sharp');
  const name = 'avatar_6_1700000000_abcdef01.png';
  const blue = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#0000ff' } }).png().toBuffer();
  writeFileSync(join(t.uploads, name), await sharp({ create: { width: 200, height: 100, channels: 3, background: '#ff0000' } })
    .composite([{ input: blue, left: 100, top: 0 }]).png().toBuffer());
  await sql('UPDATE `DB`.pages SET avatar = ? WHERE id = 3', [name]);
  const icon = `/_/icon/3-${iconHash(name)}.png`;
  let html = String((await get('/', 'tom.' + HOST)).body);
  assert.match(html, /<title>Tom Weber<\/title>/);
  assert.ok(html.includes(`<link rel="icon" type="image/png" href="${icon}">`));
  if (ogSupported()) assert.ok(html.includes('<meta property="og:image:alt" content="Tom Weber">'));
  assert.equal(hasFooter(html), false);

  const res = await get(icon, 'tom.' + HOST);
  assert.equal(res.status, 200);
  assert.equal(res.header('Content-Type'), 'image/png');
  assert.equal(res.header('Cache-Control'), 'public, max-age=31536000, s-maxage=3600, immutable');
  const png = res.body as Buffer;
  const meta = await sharp(png).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['png', 64, 64]);
  // Mitte ausgeschnitten: links rot, rechts blau
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3));
  assert.deepEqual(px(4, 32), [255, 0, 0]);
  assert.deepEqual(px(59, 32), [0, 0, 255]);
  // Zwischengespeichert neben den Vorschaubildern: auch ohne die Datei des Profilbilds geliefert
  assert.ok(existsSync(join(t.uploads, 'og', `icon-3-${iconHash(name)}.png`)));
  unlinkSync(join(t.uploads, name));
  const cached = await get(icon, 'tom.' + HOST);
  assert.equal(cached.status, 200);
  assert.ok(Buffer.compare(cached.body as Buffer, png) === 0);
  // Alte Adresse (anderes Profilbild): weiter zum aktuellen Favicon
  const old = await get('/_/icon/3-000000000000.png', 'tom.' + HOST);
  assert.deepEqual([old.status, old.header('Location')], [302, icon]);

  // Passwort-Abfrage eines geschützten Links: dasselbe Favicon
  const [ins] = await t.admin.query(`INSERT INTO \`${t.name}\`.page_blocks (page_id, type, position, is_visible, data, protection, password_hash, created_at)
    VALUES (3, 'link', 9, 1, ?, 'password', ?, NOW())`, [JSON.stringify({ title: 'Secret', url: 'https://example.com/secret' }), await passwordHash('pw-' + process.pid)]);
  const gate = String((await get('/_/go/' + (ins as { insertId: number }).insertId, 'tom.' + HOST)).body);
  assert.ok(gate.includes(`<link rel="icon" type="image/png" href="${icon}">`), 'gate page');

  // Premium endet: Titel, Favicon und Abzeichen sind sofort zurück; die Favicon-Adresse führt zum OnYourSite-Favicon
  await sql("UPDATE `DB`.users SET premium_until = '2026-01-02 00:00:00' WHERE id = 6");
  html = String((await get('/', 'tom.' + HOST)).body);
  assert.match(html, /<title>Tom Weber \| OnYourSite<\/title>/);
  assert.ok(html.includes(`<link rel="icon" type="image/png" href="${DEFAULT_FAVICON}">`));
  const gone = await get(icon, 'tom.' + HOST);
  assert.deepEqual([gone.status, gone.header('Location')], [302, DEFAULT_FAVICON]);
  assert.equal(gone.header('Cache-Control'), 'public, max-age=300');
  await sql('UPDATE `DB`.users SET premium_until = ? WHERE id = 6', [addDays(nowStr(), 20)]);

  // Kein Bild (kaputte Datei): ebenfalls das OnYourSite-Favicon, ohne Fehler
  const broken = 'avatar_6_1700000001_abcdef02.png';
  writeFileSync(join(t.uploads, broken), 'not an image');
  await sql('UPDATE `DB`.pages SET avatar = ? WHERE id = 3', [broken]);
  const bad = await get(`/_/icon/3-${iconHash(broken)}.png`, 'tom.' + HOST);
  assert.deepEqual([bad.status, bad.header('Location')], [302, DEFAULT_FAVICON]);
  await sql('UPDATE `DB`.pages SET avatar = NULL WHERE id = 3');
  html = String((await get('/', 'tom.' + HOST)).body);
  assert.ok(html.includes(`<link rel="icon" type="image/png" href="${DEFAULT_FAVICON}">`), 'no avatar: the OnYourSite favicon');
  assert.match(html, /<title>Tom Weber<\/title>/);

  // Bestandsschutz ohne Premium: nur der Hinweis bleibt weg – Titel und Favicon wie bei allen
  html = String((await get('/', 'mig-free.' + HOST)).body);
  assert.equal(hasFooter(html), false);
  assert.match(html, /<title>T mig-free \| OnYourSite<\/title>/);
  assert.ok(html.includes(`<link rel="icon" type="image/png" href="${DEFAULT_FAVICON}">`));
});

test('the code page badge follows the owner’s Premium; the report link is always there; what Premium’s end brings back', async () => {
  const site = async (uid: number, slug: string): Promise<Record<string, unknown>> => {
    const [r] = await t.admin.query(`INSERT INTO \`${t.name}\`.code_sites (user_id, slug, title, is_published, created_at, updated_at) VALUES (?, ?, ?, 1, NOW(), NOW())`, [uid, slug, slug]);
    const id = (r as { insertId: number }).insertId;
    await t.admin.query(`INSERT INTO \`${t.name}\`.code_files (site_id, path, content, updated_at) VALUES (?, 'index.html', '<html><body><h1>Hi</h1></body></html>', NOW())`, [id]);
    return (await one('SELECT * FROM code_sites WHERE id = ?', [id]))!;
  };
  const serve = async (row: Record<string, unknown>): Promise<string> => {
    const ctx = makeTestCtx({ url: '/', host: String(row.slug) + '.' + HOST });
    await codeServe(ctx, row, '/');
    return String(ctx.body);
  };
  const tomSite = await site(6, 'tom-code');
  const miaSite = await site(5, 'mia-code');
  assert.equal(await serve(tomSite), '<html><body><h1>Hi</h1>' + codeBadge(true) + '</body></html>');
  assert.equal(await serve(miaSite), '<html><body><h1>Hi</h1>' + codeBadge(false) + '</body></html>');
  await sql("UPDATE `DB`.users SET premium_until = '2026-01-02 00:00:00' WHERE id = 6");
  assert.ok((await serve(tomSite)).includes(codeBadge(false)), 'the badge is back when Premium ends');
  await sql('UPDATE `DB`.users SET premium_until = ? WHERE id = 6', [addDays(nowStr(), 20)]);
  // Erinnerung und Hinweis des Shops: was beim Ende von Premium zurückkommt
  const lines = await lossPreview('premium', 6, poolDb);
  // Toms Seite und seine „mig-premium“ (Premium-Besitzer bekamen beim Schritt keinen Bestandsschutz)
  assert.ok(lines.includes('“Made with OnYourSite” will be shown again on 2 pages.'), lines.join(' / '));
  assert.ok(lines.includes('Your code page shows the OnYourSite badge again.'), lines.join(' / '));
  // Bestandsschutz kommt nicht zurück (er bleibt) – darum keine Zeile für Mias Seite mit Bestandsschutz
  assert.ok(!(await lossPreview('premium', 5, poolDb)).some((l) => l.startsWith('“Made with OnYourSite”')));
});

test('the address wait applies to everyone but staff (Premium doesn’t change it)', async () => {
  await sql('UPDATE `DB`.pages SET slug_changed_at = NOW() WHERE id IN (2, 3)');
  const free = await api(5, 'address', { page_id: 2, slug: 'mia-new', mode: 'subdomain' });
  assert.match(String(free.body.error), /^You can change your address again in 30 days\.$/);
  const premium = await api(6, 'address', { page_id: 3, slug: 'tom-new', mode: 'subdomain' });
  assert.match(String(premium.body.error), /^You can change your address again in 30 days\.$/, 'Premium has the same wait');
  const staff = await api(5, 'address', { page_id: 2, slug: 'mia-staff', mode: 'subdomain' }, 3);
  assert.equal(staff.body.ok, true, staff.raw);
  assert.equal((await one('SELECT slug FROM pages WHERE id = 2'))?.slug, 'mia-staff');
});
