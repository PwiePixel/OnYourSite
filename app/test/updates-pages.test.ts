// Die eigenen Seiten /updates (Changelog) und /roadmap über den ganzen Weg der Anfrage (router → app): keine Cookies,
// kanonische Adressen, Unternavigation, Weiterleitung alter Anker, Schrägstrich am Ende (301 mit kurzem Cache – auch wenn
// eine Profilseite so heißt), Meilenstein-Chips und die fertigen Meilensteine. Teile, die gleich geblieben sind,
// vergleicht updates-db.test.ts weiter mit PHP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { exec } from '../src/db.js';
import { mainUrl } from '../src/helpers.js';
import { isHalt, makeTestCtx, type Ctx } from '../src/web/ctx.js';
import { dispatch } from '../src/router.js';
import { landingView } from '../src/app/views/landing.js';
import { BASE_CONFIG, createTestEnv, loadFixture, type TestEnv } from './fixtures/updates/harness.js';
import type { ConfigData } from '../src/config.js';

let env: TestEnv;

before(async () => {
  env = await createTestEnv(String((BASE_CONFIG.db as ConfigData | undefined)?.name ?? 'oys_test') + '_pages', 'http://127.0.0.1:1/api');
});
after(async () => {
  await env?.close();
});

const ms = (id: number, title: string, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, title, description: '', status, target: '', position: id, is_public: 1, started_at: null, done_at: null,
  created_at: '2026-10-01 10:00:00', updated_at: '2026-10-02 10:00:00', ...extra,
});
const up = (id: number, title: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, title, body: '', version: '', category: 'new', milestone_id: null, is_published: 1, published_at: `2026-10-${String(10 + (id % 18)).padStart(2, '0')} 12:00:00`,
  discord_announce: 1, discord_message_id: null, discord_target: null, created_at: '2026-10-01 10:00:00', updated_at: null, ...extra,
});

function fixture(): Record<string, Array<Record<string, unknown>>> {
  const milestones = [
    ms(1, 'Custom domains', 'now', { started_at: '2026-10-20 10:00:00' }),
    ms(2, 'Themes', 'next'),
    ms(3, 'Secret plan', 'planned', { is_public: 0 }),
    // 14 fertige: 12 zu sehen, 2 im aufklappbaren Teil (nach done_at sortiert, neueste zuerst)
    ...Array.from({ length: 14 }, (_, i) => ms(10 + i, 'Shipped ' + (10 + i), 'done', { done_at: `2026-09-${String(28 - i).padStart(2, '0')} 10:00:00` })),
  ];
  const updates = [
    up(1, 'Launch', { milestone_id: 10, published_at: '2026-10-31 12:00:00' }),
    up(2, 'Hidden milestone', { milestone_id: 3, published_at: '2026-10-30 12:00:00' }),
    up(3, 'Old shipped', { milestone_id: 23 }),
    up(4, 'Draft', { is_published: 0, milestone_id: 11 }),
    ...Array.from({ length: 20 }, (_, i) => up(100 + i, 'Filler ' + i)),
  ];
  return { milestones, milestone_tasks: [{ id: 1, milestone_id: 1, title: 'Do it', is_done: 1, position: 1, done_at: null }], updates };
}

interface Res { status: number; body: string; headers: Array<[string, string]>; ctx: Ctx }
async function get(url: string, opts: { host?: string; cookies?: Record<string, string> } = {}): Promise<Res> {
  const ctx = makeTestCtx({ url, host: opts.host, cookies: opts.cookies });
  try {
    await dispatch(ctx);
  } catch (err) {
    if (!isHalt(err)) throw err;
  } finally {
    await ctx.session?.close();
  }
  return { status: ctx.status, body: String(ctx.body ?? ''), headers: ctx.headersOut(), ctx };
}
const header = (r: Res, name: string): string[] => r.headers.filter(([k]) => k.toLowerCase() === name.toLowerCase()).map(([, v]) => v);

test('/roadmap is its own page: 200, no cookie, canonical /roadmap also for ?from=updates', async () => {
  await loadFixture(env, fixture());
  for (const url of ['/roadmap', '/roadmap?from=updates', '/roadmap?page=3&x=<b>']) {
    const r = await get(url);
    assert.equal(r.status, 200, url);
    assert.deepEqual(header(r, 'Set-Cookie'), [], 'no cookie for visitors');
    assert.match(r.body, /<title>Roadmap \| OnYourSite<\/title>/);
    assert.ok(r.body.includes(`<link rel="canonical" href="${mainUrl('/roadmap')}">`), url);
    assert.ok(r.body.includes(`<meta property="og:url" content="${mainUrl('/roadmap')}">`));
    assert.ok(!r.body.includes('<b>'), 'the query is never echoed');
  }
  const r = await get('/roadmap');
  assert.match(r.body, /<a href="\/roadmap" aria-current="page" class="[^"]*bg-white text-black"><i class='bx bx-map-alt hidden sm:inline-block'><\/i> Roadmap<\/a>/);
  assert.match(r.body, /<a href="\/updates" class="[^"]*text-gray-400[^"]*"><i class='bx bx-news hidden sm:inline-block'><\/i> Changelog<\/a>/);
  assert.ok(r.body.includes('<section id="roadmap"'));
  assert.ok(r.body.includes('id="milestone-1"') && r.body.includes('id="milestone-2"'));
  assert.ok(!r.body.includes('Secret plan'), 'hidden milestones stay hidden');
  assert.ok(r.body.includes('<link rel="alternate" type="application/atom+xml" title="OnYourSite updates" href="/updates/feed.xml">'));
});

test('/roadmap: 12 shipped milestones are shown, the rest folded away; "Read the update" uses the permalink', async () => {
  await loadFixture(env, fixture());
  const r = await get('/roadmap');
  const shipped = r.body.slice(r.body.indexOf('<section id="shipped"'));
  const [open, folded] = shipped.split('<details class="mt-4">');
  assert.equal((open.match(/id="milestone-\d+"/g) ?? []).length, 12);
  assert.match(folded, /<summary[^>]*>2 more shipped<\/summary>/);
  assert.deepEqual(folded.match(/id="milestone-\d+"/g), ['id="milestone-22"', 'id="milestone-23"']);
  assert.ok(open.includes('<a href="/updates/1" class="text-brand-400 hover:text-white">Read the update</a>'), 'linked through the permalink');
  assert.ok(folded.includes('<a href="/updates/3"'));
  assert.ok(!r.body.includes('/updates/4"'), 'drafts are never linked');
  // Anker in einem zugeklappten Teil: das Skript klappt ihn auf
  assert.match(r.body, /closest\('details'\)/);
  // Missing something? → Discord
  assert.ok(r.body.includes('Post your idea in #suggestions on our Discord.'));
});

test('/roadmap without milestones says so and still has the old anchors', async () => {
  await loadFixture(env, { milestones: [], milestone_tasks: [], updates: [] });
  const r = await get('/roadmap');
  assert.equal(r.status, 200);
  assert.ok(r.body.includes('Nothing on the roadmap right now – see what shipped in the <a href="/updates" class="text-brand-400 hover:text-white">changelog</a>.'));
  assert.ok(r.body.includes('<section id="roadmap"') && r.body.includes('<span id="shipped"></span>'));
});

test('/updates is the changelog: sub-navigation, forward script for old anchors, chips link to the roadmap', async () => {
  await loadFixture(env, fixture());
  const r = await get('/updates');
  assert.equal(r.status, 200);
  assert.deepEqual(header(r, 'Set-Cookie'), []);
  assert.match(r.body, /<title>Updates \| OnYourSite<\/title>/);
  assert.ok(r.body.includes(`<link rel="canonical" href="${mainUrl('/updates')}">`));
  assert.ok(!r.body.includes('<section id="roadmap"') && !r.body.includes('<section id="shipped"'), 'the roadmap has moved');
  assert.ok(r.body.includes('<span id="roadmap"></span><span id="shipped"></span>'));
  assert.ok(r.body.includes("<script>if (/^#(roadmap|shipped|milestone-\\d+)$/.test(location.hash)) location.replace('/roadmap?from=updates' + location.hash);</script>"));
  assert.match(r.body, /<a href="\/updates" aria-current="page" class="[^"]*bg-white text-black"><i class='bx bx-news hidden sm:inline-block'><\/i> Changelog<\/a>/);
  assert.ok(r.body.includes('<a href="/roadmap#milestone-10" class="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-white border border-bordercolor rounded-full px-2.5 py-1.5"><i class=\'bx bx-flag\'></i> Shipped 10</a>'));
  assert.ok(!r.body.includes('milestone-3"') && !r.body.includes('Secret plan'), 'no chip for a hidden milestone');
  assert.ok(r.body.includes('Every change to OnYourSite, newest first.'));
  // Seite 2: eigene kanonische Adresse
  const p2 = await get('/updates?page=2');
  assert.ok(p2.body.includes(`<link rel="canonical" href="${mainUrl('/updates?page=2')}">`));
  assert.ok(p2.body.includes('<a href="/updates#changelog"'), 'pager back to page 1');
});

test('a visitor with a session cookie keeps it; the pages still answer', async () => {
  await loadFixture(env, fixture());
  const r = await get('/roadmap', { cookies: { PHPSESSID: 'x'.repeat(26) } });
  assert.equal(r.status, 200);
});

test('/updates/ and /roadmap/ answer 301 to the address without the slash (query kept, cached for an hour)', async () => {
  await loadFixture(env, fixture());
  // Eine Profilseite im Pfad-Modus mit diesem Namen (z. B. nach der Umstellung von 2.x zurückgeschaltet)
  await exec("INSERT INTO pages (id, user_id, slug, address_mode, title, position) VALUES (9001, 5, 'updates', 'path', 'Not the real changelog', 9) ON DUPLICATE KEY UPDATE slug = 'updates'");
  try {
    for (const [url, to] of [['/updates/', '/updates'], ['/roadmap/', '/roadmap'], ['/updates/?page=2', '/updates?page=2'], ['/roadmap/?from=updates&x=1', '/roadmap?from=updates&x=1']]) {
      const r = await get(url);
      assert.equal(r.status, 301, url);
      assert.deepEqual(header(r, 'Location'), [to], url);
      assert.deepEqual(header(r, 'Cache-Control'), ['max-age=3600'], url);
      assert.ok(!r.body.includes('Not the real changelog'));
    }
    // Auf einer Subdomain bleibt alles beim Alten
    const sub = await get('/roadmap/', { host: 'mia.oys.test:8080' });
    assert.notEqual(sub.status, 301);
  } finally {
    await exec('DELETE FROM pages WHERE id = 9001');
  }
});

test('other spellings of /updates and /roadmap never reach a profile page with that name', async () => {
  await loadFixture(env, fixture());
  // Der Profil-Pfad unterscheidet keine Groß-/Kleinschreibung: /Updates fand bisher die Seite „updates“ (Pfad-Modus,
  // zeigte sie unter der Adresse von OnYourSite) bzw. leitete zu roadmap.<domain> weiter (Subdomain-Modus)
  await exec(`INSERT INTO pages (id, user_id, slug, address_mode, title, position) VALUES
    (9001, 5, 'updates', 'path', 'Not the real changelog', 9), (9002, 6, 'roadmap', 'subdomain', 'Not the real roadmap', 9)`);
  try {
    for (const [url, to] of [['/Updates', '/updates'], ['/UPDATES/', '/updates'], ['/Updates/?page=2', '/updates?page=2'], ['/Roadmap', '/roadmap'], ['/ROADMAP/?from=updates', '/roadmap?from=updates']]) {
      const r = await get(url);
      assert.equal(r.status, 301, url);
      assert.deepEqual(header(r, 'Location'), [to], url);
      assert.deepEqual(header(r, 'Cache-Control'), ['max-age=3600'], url);
      assert.ok(!r.body.includes('Not the real'), url);
    }
    // Einen Kalender haben die eigenen Seiten nicht
    for (const url of ['/updates/kalender', '/Roadmap/kalender', '/roadmap/Kalender/']) {
      const r = await get(url);
      assert.equal(r.status, 404, url);
      assert.deepEqual(header(r, 'Location'), [], url);
      assert.ok(!r.body.includes('Not the real'), url);
    }
    // Die echten Adressen bleiben, wie sie sind
    assert.equal((await get('/updates')).status, 200);
    assert.equal((await get('/roadmap')).status, 200);
  } finally {
    await exec('DELETE FROM pages WHERE id IN (9001, 9002)');
  }
});

test('the landing page links to both pages', async () => {
  const html = landingView({ user: null });
  assert.ok(html.includes('<a href="/updates" class="inline-block py-2 hover:text-white transition-colors">Updates</a>'));
  assert.ok(html.includes('<a href="/roadmap" class="inline-block py-2 hover:text-white transition-colors">Roadmap</a>'));
  assert.ok(!html.includes('Updates &amp; roadmap'));
});
