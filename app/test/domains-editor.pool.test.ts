// Eigene Domain im Editor mit einer einzigen Datenbankverbindung (PD-4): Hinzufügen unter der Platz-Sperre, Übernahme
// mit DoH-Abfrage (ohne gehaltene Verbindung), Prüfen und Entfernen laufen durch, ohne auf eine zweite Verbindung zu
// warten (OYS_DB_STRICT meldet Pool-Abfragen innerhalb einer Transaktion). Zwei Konten wollen gleichzeitig denselben
// Hostnamen: genau eines bekommt ihn.
process.env.OYS_DB_POOL_SIZE = '1';
process.env.OYS_DB_STRICT = '1';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { loadConfig, setConfigForTests } from '../src/config.js';
import { makeTestCtx, type Ctx } from '../src/web/ctx.js';
import { appRoutes } from '../src/app/dispatch.js';
import { ensureSchema } from '../src/schema.js';
import { createDomain, ownershipToken, saveDomainSettings } from '../src/domains/index.js';
import { setDohForTests } from '../src/domains/editor.js';
import type { Doh, DohReply } from '../src/domains/worker/dns.js';
import { CSRF, jsonBody, loginSession, runRequest, testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
const pages: Record<string, number> = {};
let txt: string[] = [];

async function sql(query: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [r] = await t.admin.query<RowDataPacket[]>(query.replace(/`DB`/g, '`' + t.name + '`'), params);
  return r;
}
async function api(userId: number, action: string, json: unknown): Promise<Ctx> {
  const sid = await loginSession(userId);
  const ctx = makeTestCtx({ method: 'POST', url: '/dashboard/api/' + action, cookies: { PHPSESSID: sid },
    headers: { 'content-type': 'application/json', 'x-csrf-token': CSRF }, rawBody: Buffer.from(JSON.stringify(json)) });
  return runRequest(ctx, appRoutes);
}

before(async () => {
  t = await testDatabase('pd4pool', { empty: true });
  setConfigForTests({ ...loadConfig(), base_domain: 'oys.test', scheme: 'http', cloudflare: { zone_id: 'a'.repeat(32) },
    custom_domains: { cname_target: 'edge.oys.test', fallback_origin: 'origin.oys.test' } });
  await ensureSchema();
  for (const id of [5, 6, 7]) {
    await sql("INSERT INTO `DB`.users (id, email, password, full_name, is_admin, created_at, premium_until) VALUES (?, ?, 'x', 'U', 0, '2025-01-01 10:00:00', '2030-01-01 10:00:00')", [id, `p${id}@test.de`]);
    const [r] = await t.admin.query(`INSERT INTO \`${t.name}\`.pages (user_id, slug, title, created_at) VALUES (?, ?, 'x', NOW())`, [id, 'pool-' + id]);
    pages[id] = (r as { insertId: number }).insertId;
  }
  await saveDomainSettings({ enabled: true, per_user: 3, min_account_days: 0 });
  setDohForTests({ query: async (name: string): Promise<DohReply[]> => [{ rcode: 0, answer: txt.map((v) => ({ name, type: 16, data: '"' + v + '"' })), authority: [] }] } as unknown as Doh);
});

after(async () => {
  setDohForTests(null);
  await t.done();
});

test('add, claim, check and remove with a pool of one', { timeout: 60000 }, async () => {
  const a = await api(5, 'domain-add', { page_id: pages[5], hostname: 'one.example.com' });
  assert.equal(a.status, 200, JSON.stringify(jsonBody(a)));
  await createDomain({ hostname: 'two.example.com', targetId: pages[6], userId: 6 });
  txt = [ownershipToken(7, 'two.example.com')];
  const c = await api(7, 'domain-add', { page_id: pages[7], hostname: 'two.example.com', claim: true });
  assert.equal(c.status, 200, JSON.stringify(jsonBody(c)));
  assert.equal(jsonBody(c).transferred, true);
  assert.equal((await api(5, 'domain-check', { page_id: pages[5] })).status, 200);
  assert.equal((await api(5, 'domain-remove', { page_id: pages[5], confirm: 'one.example.com' })).status, 200);
  assert.equal((await sql('SELECT COUNT(*) AS n FROM `DB`.custom_domains WHERE hostname = ?', ['one.example.com']))[0].n, 0);
});

test('two accounts add the same new hostname at once: exactly one gets it', { timeout: 60000 }, async () => {
  const [x, y] = await Promise.all([
    api(5, 'domain-add', { page_id: pages[5], hostname: 'race.example.com' }),
    api(6, 'domain-add', { page_id: pages[6], hostname: 'race.example.com' }),
  ]);
  const oks = [x, y].filter((r) => r.status === 200 && jsonBody(r).ok === true);
  assert.equal(oks.length, 1, JSON.stringify([jsonBody(x), jsonBody(y)]));
  assert.equal((await sql('SELECT COUNT(*) AS n FROM `DB`.custom_domains WHERE hostname = ?', ['race.example.com']))[0].n, 1);
});
