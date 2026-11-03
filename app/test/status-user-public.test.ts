// Öffentliche Statusseite eines Nutzers (ST-4): mit dem bestehenden Renderer auf der eigenen Subdomain, Texte maskiert;
// ohne Freischaltung (Plan 'none') „offline“ (404); die Seite eines Kontos ist nie OnYourSites Seite.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { ensureSchema } from '../src/schema.js';
import { buildServer } from '../src/server.js';
import { resetStatusRoutesForTests } from '../src/status/routes.js';
import { grantFeature } from '../src/honeycombs/grants.js';
import '../src/status/shop.js';
import { testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
let app: FastifyInstance;
const OLD = '2026-01-01 10:00:00';
const HOST = 'mia-checks.oys.test:8080';

async function sql(query: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [r] = await t.admin.query<RowDataPacket[]>(query.replace(/`DB`/g, '`' + t.name + '`'), params);
  return r;
}
const get = (url: string, host = HOST) => app.inject({ method: 'GET', url, headers: { host } });

before(async () => {
  t = await testDatabase('st4public', { empty: true });
  await ensureSchema();
  const user = 'INSERT INTO `DB`.users (id, email, password, full_name, is_admin, created_at) VALUES (?, ?, \'x\', ?, ?, ?)';
  await sql(user, [3, 'admin@test.de', 'Admin', 1, OLD]);
  await sql(user, [5, 'mia@test.de', 'Mia', 0, OLD]);
  await sql(`INSERT INTO \`DB\`.status_pages (user_id, is_system, slug, title, description, is_published, created_at, updated_at)
    VALUES (5, 0, 'mia-checks', '<script>alert(1)</script> Mia “checks”', '', 1, NOW(), NOW())`);
  const id = Number((await sql("SELECT id FROM `DB`.status_pages WHERE slug = 'mia-checks'"))[0].id);
  await sql("INSERT INTO `DB`.site_addresses (slug, kind, ref_id, user_id, claimed_at) VALUES ('mia-checks', 'status', ?, 5, NOW())", [id]);
  await sql(`INSERT INTO \`DB\`.status_monitors (page_id, user_id, type, name, group_name, is_public, target, config, interval_s, manual_status, manual_since, changed_at, created_at, updated_at)
    VALUES (?, 5, 'manual', '<img src=x onerror=alert(2)> Shop', '', 1, '', '{}', 300, 'operational', 0, 0, NOW(), NOW())`, [id]);
  app = await buildServer();
  await app.ready();
});

after(async () => {
  await app.close();
  await t.done();
});

test('without the unlock the user page is offline; with it the existing renderer serves it escaped', async () => {
  resetStatusRoutesForTests();
  let res = await get('/');
  assert.equal(res.statusCode, 404);
  assert.match(res.body, /This status page is offline/);
  const g = await grantFeature(3, 5, 'status_page', { permanent: true }, 'test');
  assert.ok(!('error' in g && g.error), JSON.stringify(g));
  resetStatusRoutesForTests();
  res = await get('/');
  assert.equal(res.statusCode, 200, res.body.slice(0, 300));
  assert.ok(!res.body.includes('<script>alert(1)</script>'), 'the title is escaped');
  assert.ok(!res.body.includes('<img src=x onerror=alert(2)>'), 'component names are escaped');
  assert.match(res.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt; Mia/);
  assert.match(res.body, /Shop/);
  // OnYourSites eigene Seite bleibt, wie sie ist
  res = await get('/', 'status.oys.test:8080');
  assert.equal(res.statusCode, 200);
  assert.doesNotMatch(res.body, /Mia “checks”|Mia &ldquo;checks/);
});
