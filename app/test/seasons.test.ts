// Saison-Themes für OnYourSites eigene Seiten (Admin → Seasons, seasons/seasons.ts): Zeitraum über den Jahreswechsel,
// welches Thema gilt, der Einbau in fertige Seiten – und über die echten Routen: welche Seiten es bekommen und welche
// nicht, die Vorschau, das Formular im Admin (eigene Test-Datenbank).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { makeTestCtx, type Ctx } from '../src/web/ctx.js';
import { dispatch } from '../src/router.js';
import { ensureSchema } from '../src/schema.js';
import { loadConfig, setConfigForTests } from '../src/config.js';
import { date } from '../src/php.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_DIR } from '../src/config.js';
import {
  applySeason, forgetSeasonCache, inWindow, isMonthDay, isSeasonPath, normalizeSettings, pickSeason, seasonalBody, SEASONS_META_KEY,
} from '../src/seasons/seasons.js';
import { CSRF, loginSession, runRequest, testDatabase, type TestDb } from './coreHarness.js';

// ---------------------------------------------------------------- ohne Datenbank

test('month-day values: real days only, 02-29 allowed', () => {
  for (const v of ['12-01', '01-06', '02-29', '12-31', '04-30']) assert.ok(isMonthDay(v), v);
  for (const v of ['13-01', '00-10', '12-32', '02-30', '04-31', '1-6', '12/01', ' 12-01', '', null, 1201]) assert.ok(!isMonthDay(v), String(v));
});

test('the window works inside a year and across the new year', () => {
  assert.ok(inWindow('12-24', '12-01', '01-06'));
  assert.ok(inWindow('01-06', '12-01', '01-06'));
  assert.ok(inWindow('12-01', '12-01', '01-06'));
  assert.ok(!inWindow('01-07', '12-01', '01-06'));
  assert.ok(!inWindow('11-30', '12-01', '01-06'));
  assert.ok(inWindow('07-15', '07-01', '07-31'));
  assert.ok(!inWindow('08-01', '07-01', '07-31'));
});

test('settings: unknown themes and broken values fall back to the defaults; "On" wins over "Automatic"', () => {
  // Ohne gespeicherte Einstellung: Winter automatisch vom 1. Dezember bis 6. Januar (so wie der Text auf /updates sagt)
  assert.deepEqual(normalizeSettings(null), { winter: { mode: 'auto', from: '12-01', to: '01-06' } });
  assert.deepEqual(normalizeSettings('not json'), { winter: { mode: 'auto', from: '12-01', to: '01-06' } });
  assert.deepEqual(normalizeSettings('{}'), { winter: { mode: 'auto', from: '12-01', to: '01-06' } });
  // Ein kaputter gespeicherter Wert ist „Off“ (der Admin hat etwas gespeichert – nichts erfinden)
  assert.deepEqual(normalizeSettings('{"winter":{"mode":"party","from":"13-01","to":"x"},"summer":{"mode":"on"}}'), { winter: { mode: 'off', from: '12-01', to: '01-06' } });
  assert.equal(pickSeason({ winter: { mode: 'off', from: '12-01', to: '01-06' } }, '12-24'), null);
  assert.equal(pickSeason({ winter: { mode: 'auto', from: '12-01', to: '01-06' } }, '12-24'), 'winter');
  assert.equal(pickSeason({ winter: { mode: 'auto', from: '12-01', to: '01-06' } }, '06-24'), null);
  assert.equal(pickSeason({ winter: { mode: 'on', from: '12-01', to: '01-06' } }, '06-24'), 'winter');
});

test('applying a theme: stylesheet before </head>, a class on <body>, the decoration right after it', () => {
  const html = '<!DOCTYPE html>\n<html><head><title>x</title></head>\n<body class="bg-black text-white">\n<p>Hi</p></body></html>';
  const out = applySeason(html, 'winter');
  assert.match(out, /<link rel="stylesheet" href="\/static\/css\/season-winter\.css\?v=[0-9a-f]{8}"><\/head>/);
  assert.match(out, /<body class="bg-black text-white season-winter"><div class="oys-season" aria-hidden="true">/);
  assert.equal(out.replace(/<link rel="stylesheet" href="\/static\/css\/season-winter[^>]*>/, '').replace(' season-winter', '').replace(/<div class="oys-season"[^]*?<\/div><div class="oys-season-lights" aria-hidden="true"><\/div>/, ''), html);
  // <body> ohne Klasse, mit anderen Attributen
  assert.match(applySeason('<html><head></head><body id="b" data-x="1"></body></html>', 'winter'), /<body id="b" data-x="1" class="season-winter"><div class="oys-season"/);
  // Ohne <head> oder <body>, oder ein unbekanntes Thema: unverändert
  for (const piece of ['<p>no page</p>', '<body><p>x</p></body>', '<html><head></head></html>']) assert.equal(applySeason(piece, 'winter'), piece);
  assert.equal(applySeason(html, 'summer'), html);
  // Keine Emojis in der Deko
  assert.doesNotMatch(out, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
});

test('the snow loops without jumping: every animation ends on a whole tile', () => {
  const css = readFileSync(join(ROOT_DIR, 'static', 'css', 'season-winter.css'), 'utf8');
  const frames = new Map([...css.matchAll(/@keyframes ([a-z0-9-]+) \{ from \{ background-position: 0 0; \} to \{ background-position: (-?\d+)px (-?\d+)px; \} \}/g)]
    .map((m) => [m[1], [Number(m[2]), Number(m[3])]]));
  const layers = [...css.matchAll(/background-size: (\d+)px (\d+)px;[\s\S]*?animation: (oys-season-snow[a-z0-9-]*) /g)];
  assert.equal(layers.length, 2, 'two snow layers');
  for (const [, w, h, name] of layers) {
    const end = frames.get(name);
    assert.ok(end, name);
    assert.equal(Math.abs(end[0] % Number(w)), 0, `${name}: x ends on a whole tile`);
    assert.equal(Math.abs(end[1] % Number(h)), 0, `${name}: y ends on a whole tile`);
  }
  // Unter der Navigation und den Hinweisen der Seiten (z-50), über dem Inhalt
  assert.match(css, /\.oys-season \{ position: fixed; inset: 0; z-index: 40;/);
});

test('the Santa hat on the logo: a working SVG (no raw “#” in the data address), only on the logo icons, and the fairy lights', () => {
  const css = readFileSync(join(ROOT_DIR, 'static', 'css', 'season-winter.css'), 'utf8');
  const uris = [...css.matchAll(/url\("data:image\/svg\+xml,([^"]*)"\)/g)].map((m) => m[1]);
  assert.equal(uris.length, 1, 'one hat');
  // Ein rohes # beendet die Adresse (Rest = Fragment): die Mütze wäre unsichtbar
  assert.doesNotMatch(uris[0], /#/);
  const svg = decodeURIComponent(uris[0]);
  assert.match(svg, /^<svg xmlns='http:\/\/www\.w3\.org\/2000\/svg' viewBox='0 0 64 56'>[\s\S]*<\/svg>$/);
  assert.match(svg, /fill='#dc2626'/);
  // Nur das Logo (Kopfzeile: text-brand-500, Anmelden/Registrieren: text-white) – nicht die gelben Honigwaben im Text
  assert.match(css, /\.season-winter \.bx-hive\.text-brand-500::after, \.season-winter \.bx-hive\.text-white::after \{/);
  assert.doesNotMatch(css, /text-yellow/);
  // Die Lichterkette liegt über der Navigation (z-50), fängt aber nichts ab und steht still ohne Bewegung
  assert.match(css, /\.oys-season-lights \{\n {2}position: fixed; left: 0; right: 0; top: 0; height: 22px; z-index: 55; pointer-events: none;/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{\n {2}\.oys-season-1, \.oys-season-2, \.oys-season-lights \{ animation: none; \}/);
});

test('the pages that get a theme', () => {
  for (const p of ['/', '/login', '/register', '/updates', '/updates/12', '/roadmap', '/suggestions', '/suggestions/3', '/imprint', '/privacy', '/terms', '/terms/code-pages', '/challenge']) {
    assert.ok(isSeasonPath(p), p);
  }
  for (const p of ['/dashboard', '/admin', '/updates/feed.xml', '/dashboard/api/x', '/logout', '/mia', '/_/og/1.png', '/updates/x']) assert.ok(!isSeasonPath(p), p);
});

// ---------------------------------------------------------------- über die Routen

let t: TestDb;
let sid = '';
const ADMIN = 3, MIA = 5;

async function sql(query: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [r] = await t.admin.query<RowDataPacket[]>(query.replace(/`DB`/g, '`' + t.name + '`'), params);
  return r;
}
async function setSeason(value: unknown): Promise<void> {
  await sql('REPLACE INTO `DB`.oys_meta (meta_key, meta_value) VALUES (?, ?)', [SEASONS_META_KEY, JSON.stringify(value)]);
  forgetSeasonCache();
}
// Wie server.ts: erst die Routen, dann das Saison-Thema
async function get(url: string, o: { host?: string; method?: string; cookies?: Record<string, string> } = {}): Promise<Ctx> {
  const ctx = await runRequest(makeTestCtx({ url, host: o.host, method: o.method, cookies: o.cookies }), dispatch);
  await seasonalBody(ctx);
  return ctx;
}
async function post(form: Record<string, string>): Promise<Ctx> {
  return runRequest(makeTestCtx({ method: 'POST', url: '/admin', cookies: { PHPSESSID: sid }, post: { csrf: CSRF, ...form } }), dispatch);
}
const flash = async (): Promise<string> => {
  const html = String((await get('/admin', { cookies: { PHPSESSID: sid } })).body);
  return /<div data-flash="[a-z]+"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1].replace(/<[^>]+>/g, '').trim() ?? '';
};
const stored = async (): Promise<unknown> => JSON.parse(String((await sql('SELECT meta_value FROM `DB`.oys_meta WHERE meta_key = ?', [SEASONS_META_KEY]))[0]?.meta_value ?? 'null'));

before(async () => {
  t = await testDatabase('seasons', { empty: true });
  setConfigForTests({ ...loadConfig(), db: { ...(loadConfig().db as Record<string, string>), name: t.name }, base_domain: 'oys.test:8080', scheme: 'http' });
  await ensureSchema();
  const user = 'INSERT INTO `DB`.users (id, email, password, full_name, username, is_admin, created_at) VALUES (?, ?, \'x\', ?, ?, ?, ?)';
  await sql(user, [ADMIN, 'admin@test.de', 'Pixel Admin', 'pixel', 1, '2025-01-01 10:00:00']);
  await sql(user, [MIA, 'mia@test.de', 'Mia', 'mia', 0, '2025-01-01 10:00:00']);
  await sql("INSERT INTO `DB`.pages (user_id, slug, title, created_at) VALUES (?, 'mia', 'Mia', '2025-01-01 10:00:00')", [MIA]);
  sid = await loginSession(ADMIN);
});
after(async () => {
  await t.done();
});
beforeEach(async () => {
  await sql('DELETE FROM `DB`.oys_meta WHERE meta_key = ?', [SEASONS_META_KEY]);
  forgetSeasonCache();
});

const HAS = /season-winter\.css/;

test('nothing stored: winter is automatic from December 1 to January 6', async () => {
  const inside = date('m-d') >= '12-01' || date('m-d') <= '01-06';
  assert.equal(/season-winter\.css/.test(String((await get('/')).body)), inside);
});

test('off: the own pages are byte for byte as before', async () => {
  await setSeason({ winter: { mode: 'off', from: '12-01', to: '01-06' } });
  // Anmelden und Registrieren haben in jeder Antwort ein neues Formular-Token – dort zählt nur: kein Thema
  for (const url of ['/', '/login', '/register', '/imprint', '/updates', '/roadmap']) {
    const before = String((await runRequest(makeTestCtx({ url }), dispatch)).body);
    const ctx = await get(url);
    if (url !== '/login' && url !== '/register') assert.equal(String(ctx.body), before, url);
    assert.doesNotMatch(String(ctx.body), /oys-season|season-winter/, url);
  }
});

test('on: the own pages, the 404 page and the preview get the theme; users’ pages, the editor and the admin don’t', async () => {
  await setSeason({ winter: { mode: 'on', from: '12-01', to: '01-06' } });
  for (const url of ['/', '/login', '/register', '/imprint', '/privacy', '/terms', '/updates', '/roadmap']) {
    const ctx = await get(url);
    assert.equal(ctx.status, 200, url);
    assert.match(String(ctx.body), HAS, url);
    assert.match(String(ctx.body), /<body[^>]*\bseason-winter\b[^>]*><div class="oys-season" aria-hidden="true">/, url);
  }
  const missing = await get('/no-such-page-at-all');
  assert.equal(missing.status, 404);
  assert.match(String(missing.body), HAS, 'the 404 page');
  // Seite einer Nutzerin (Subdomain und Pfad), Editor, Admin, Feed: ohne Thema
  assert.doesNotMatch(String((await get('/', { host: 'mia.oys.test:8080' })).body), HAS, 'mia.oys.test');
  assert.doesNotMatch(String((await get('/mia')).body), HAS, '/mia');
  assert.doesNotMatch(String((await get('/admin', { cookies: { PHPSESSID: sid } })).body), HAS, '/admin');
  assert.doesNotMatch(String((await get('/dashboard', { cookies: { PHPSESSID: sid } })).body), HAS, '/dashboard');
  assert.doesNotMatch(String((await get('/updates/feed.xml')).body), HAS, 'feed');
  // Ein fremder Hostname (nicht diese Seite): die 404-Seite ohne Thema
  const foreign = await get('/x', { host: 'unknown.example.net' });
  assert.doesNotMatch(String(foreign.body), HAS, 'a foreign host');
  assert.equal(foreign.seasonPage, false);
  // HEAD: kein Umbau
  assert.doesNotMatch(String((await get('/', { method: 'HEAD' })).body), HAS, 'HEAD');
});

test('automatic: only inside its dates; the preview shows a theme while it is off', async () => {
  // Tage in der Zeitzone der Seite (wie seasons.ts)
  const md = (d: Date) => date('m-d', Math.floor(d.getTime() / 1000));
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86_400_000);
  const later = new Date(today.getTime() + 5 * 86_400_000);
  await setSeason({ winter: { mode: 'auto', from: md(tomorrow), to: md(later) } });
  assert.doesNotMatch(String((await get('/')).body), HAS, 'not yet');
  await setSeason({ winter: { mode: 'auto', from: md(today), to: md(later) } });
  assert.match(String((await get('/')).body), HAS, 'from today');
  await setSeason({ winter: { mode: 'off' } });
  assert.match(String((await get('/?season_preview=winter')).body), HAS, 'preview');
  assert.doesNotMatch(String((await get('/?season_preview=summer')).body), HAS, 'an unknown preview is ignored');
  assert.doesNotMatch(String((await get('/mia?season_preview=winter')).body), HAS, 'no preview on users’ pages');
});

test('Admin → Seasons: the section, saving On, Automatic and Off, refusing bad dates', async () => {
  const html = String((await get('/admin', { cookies: { PHPSESSID: sid } })).body);
  assert.match(html, /id="nav-seasons"/);
  assert.match(html, /<div id="tab-seasons" class="admin-tab-content/);
  assert.match(html, /seasons: \['Seasons'/);
  assert.match(html, /data-season="winter"/);
  assert.match(html, /href="\/\?season_preview=winter"/);
  assert.doesNotMatch(html, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'no emoji in the admin section');

  let r = await post({ season_action: 'save', season: 'winter', mode: 'on', from: '12-01', to: '01-06' });
  assert.equal(r.header('Location'), '/admin#seasons');
  assert.deepEqual(await stored(), { winter: { mode: 'on', from: '12-01', to: '01-06' } });
  assert.equal(await flash(), 'Winter is on for OnYourSite’s own pages.');
  assert.match(String((await get('/admin', { cookies: { PHPSESSID: sid } })).body), /Active now/);

  await post({ season_action: 'save', season: 'winter', mode: 'auto', from: ' 11-28 ', to: '01-02' });
  assert.deepEqual(await stored(), { winter: { mode: 'auto', from: '11-28', to: '01-02' } });
  assert.equal(await flash(), 'Winter turns on by itself from Nov 28 to Jan 2.');

  r = await post({ season_action: 'save', season: 'winter', mode: 'auto', from: '02-30', to: '01-02' });
  assert.equal(await flash(), 'Please enter the dates as month-day, e.g. 12-01 for December 1.');
  assert.deepEqual(await stored(), { winter: { mode: 'auto', from: '11-28', to: '01-02' } }, 'nothing changed');
  await post({ season_action: 'save', season: 'winter', mode: 'party', from: '12-01', to: '01-06' });
  assert.equal(await flash(), 'Please choose Off, On or Automatic.');
  await post({ season_action: 'save', season: 'summer', mode: 'on', from: '12-01', to: '01-06' });
  assert.equal(await flash(), 'Unknown action.');

  await post({ season_action: 'save', season: 'winter', mode: 'off', from: '12-01', to: '01-06' });
  assert.equal(await flash(), 'Winter is off.');
  forgetSeasonCache();
  assert.doesNotMatch(String((await get('/')).body), HAS);
  // Ohne Admin: kein Speichern
  const mia = await loginSession(MIA);
  await runRequest(makeTestCtx({ method: 'POST', url: '/admin', cookies: { PHPSESSID: mia }, post: { csrf: CSRF, season_action: 'save', season: 'winter', mode: 'on', from: '12-01', to: '01-06' } }), dispatch);
  assert.equal((await stored() as { winter: { mode: string } }).winter.mode, 'off');
});
