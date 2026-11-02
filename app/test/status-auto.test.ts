// Statusseiten: was der Prüfdienst an Vorfällen selbst tut (ST-3) – Wartungen beginnen und enden zur geplanten Zeit,
// ein automatischer Vorfall öffnet sich nach auto_incident Sekunden „down“ (nur öffentlich, nicht in Wartung, nicht
// flatternd, Sperre offen), nimmt in 10 Minuten weitere Bestandteile auf und schließt sich, wenn alle wieder da sind;
// hat jemand darin geschrieben, nur ein Update „monitoring“; „{Name} is no longer monitored.“; eingefroren wird gewartet.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { ensureSchema } from '../src/schema.js';
import { autoIncidentRound, maintenanceRound, type AutoMonitor, type AutoPage } from '../src/status/auto.js';
import { autoTexts } from '../src/status/incidents.js';
import { testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
let pageId = 0;
const ids: number[] = [];
const NOW = Math.floor(Date.now() / 1000);

async function sql(query: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [r] = await t.admin.query<RowDataPacket[]>(query.replace(/`DB`/g, '`' + t.name + '`'), params);
  return r;
}

const pages = (auto = 300): Map<number, AutoPage> => new Map([[pageId, { id: pageId, autoIncident: auto }]]);
function mon(i: number, over: Partial<AutoMonitor> = {}): AutoMonitor {
  return { id: ids[i], pageId, name: ['Website', 'API', 'Secret'][i], isPublic: i !== 2, state: 'down', since: NOW - 400, flapping: false, monitored: true, maintenance: false, ...over };
}
const openAuto = async () => sql("SELECT id, title, status, resolved_at, auto_edited FROM `DB`.status_incidents WHERE is_auto = 1 ORDER BY id");
const updatesOf = async (id: number) => (await sql('SELECT status, body, is_auto FROM `DB`.status_incident_updates WHERE incident_id = ? ORDER BY id', [id])).map((r) => [r.status, r.body]);

before(async () => {
  t = await testDatabase('st3auto', { empty: true });
  await ensureSchema();
  pageId = Number((await sql('SELECT id FROM `DB`.status_pages WHERE is_system = 1'))[0].id);
  for (const [name, isPublic] of [['Website', 1], ['API', 1], ['Secret', 0]] as const) {
    await sql(`INSERT INTO \`DB\`.status_monitors (page_id, user_id, type, name, is_public, target, config, interval_s, changed_at, created_at, updated_at)
      VALUES (?, NULL, 'http', ?, ?, 'https://example.com/', '{}', 300, 0, NOW(), NOW())`, [pageId, name, isPublic]);
    ids.push(Number((await sql('SELECT MAX(id) AS id FROM `DB`.status_monitors'))[0].id));
  }
});

after(async () => {
  await t.done();
});

beforeEach(async () => {
  await sql('DELETE FROM `DB`.status_incident_updates');
  await sql('DELETE FROM `DB`.status_incident_monitors');
  await sql('DELETE FROM `DB`.status_incidents');
});

test('an auto incident opens after auto_incident seconds – not for private, flapping, maintenance, unmonitored or a frozen gate', async () => {
  // Zu kurz unten, privat, flatternd, in Wartung, nicht geprüft, Sperre zu, Seite ohne automatische Vorfälle: nichts
  for (const [m, gate, auto] of [
    [mon(0, { since: NOW - 100 }), 'ok', 300], [mon(2), 'ok', 300], [mon(0, { flapping: true }), 'ok', 300], [mon(0, { maintenance: true }), 'ok', 300],
    [mon(0, { monitored: false }), 'ok', 300], [mon(0), 'frozen', 300], [mon(0), 'hold', 300], [mon(0), 'ok', 0],
  ] as Array<[AutoMonitor, 'ok' | 'hold' | 'frozen', number]>) {
    const r = await autoIncidentRound(pages(auto), [m], gate, NOW);
    assert.deepEqual(r.opened, [], JSON.stringify({ m, gate, auto }));
  }
  assert.equal((await openAuto()).length, 0);
  const rev0 = Number((await sql('SELECT rev FROM `DB`.status_pages WHERE id = ?', [pageId]))[0].rev);
  const r = await autoIncidentRound(pages(), [mon(0)], 'ok', NOW);
  assert.equal(r.opened.length, 1);
  assert.deepEqual(r.changedPages, [pageId]);
  const [inc] = await openAuto();
  assert.equal(inc.title, 'Website is unavailable');
  assert.equal(inc.status, 'investigating');
  assert.deepEqual(await updatesOf(Number(inc.id)), [['investigating', autoTexts.opened('Website')]]);
  assert.ok(Number((await sql('SELECT rev FROM `DB`.status_pages WHERE id = ?', [pageId]))[0].rev) > rev0);
  // Eine zweite Runde öffnet keinen zweiten Vorfall
  assert.deepEqual((await autoIncidentRound(pages(), [mon(0)], 'ok', NOW + 30)).opened, []);
});

test('a second component joins a fresh auto incident; all back → resolved with one closing update', async () => {
  await autoIncidentRound(pages(), [mon(0)], 'ok', NOW);
  await autoIncidentRound(pages(), [mon(0), mon(1)], 'ok', NOW + 60);
  let [inc] = await openAuto();
  assert.equal(inc.title, autoTexts.several);
  assert.deepEqual((await sql('SELECT monitor_id FROM `DB`.status_incident_monitors WHERE incident_id = ? ORDER BY monitor_id', [inc.id])).map((r) => Number(r.monitor_id)), [ids[0], ids[1]]);
  // Einer ist wieder da: noch offen
  let r = await autoIncidentRound(pages(), [mon(0, { state: 'up' }), mon(1)], 'ok', NOW + 120);
  assert.deepEqual(r.resolved, []);
  // Eingefroren: es wird gewartet
  r = await autoIncidentRound(pages(), [mon(0, { state: 'up' }), mon(1, { state: 'up' })], 'frozen', NOW + 150);
  assert.deepEqual(r.resolved, []);
  r = await autoIncidentRound(pages(), [mon(0, { state: 'up' }), mon(1, { state: 'up' })], 'ok', NOW + 180);
  assert.deepEqual(r.resolved, [Number(inc.id)]);
  [inc] = await openAuto();
  assert.equal(inc.status, 'resolved');
  assert.notEqual(inc.resolved_at, null);
  const ups = await updatesOf(Number(inc.id));
  assert.deepEqual(ups[ups.length - 1], ['resolved', autoTexts.allBack]);
  // Nichts doppelt
  assert.deepEqual((await autoIncidentRound(pages(), [mon(0, { state: 'up' }), mon(1, { state: 'up' })], 'ok', NOW + 210)).resolved, []);
});

test('written in by someone (auto_edited): only a “monitoring” update – once; a deleted or paused component is “no longer monitored”', async () => {
  await autoIncidentRound(pages(), [mon(0)], 'ok', NOW);
  let [inc] = await openAuto();
  await sql('UPDATE `DB`.status_incidents SET auto_edited = 1 WHERE id = ?', [inc.id]);
  await autoIncidentRound(pages(), [mon(0, { state: 'up' })], 'ok', NOW + 60);
  await autoIncidentRound(pages(), [mon(0, { state: 'up' })], 'ok', NOW + 90);
  [inc] = await openAuto();
  assert.equal(inc.resolved_at, null, 'the owner closes it');
  const ups = await updatesOf(Number(inc.id));
  assert.deepEqual(ups.slice(1), [['monitoring', autoTexts.back('Website')]], 'one update, not two');

  await sql('DELETE FROM `DB`.status_incident_updates');
  await sql('DELETE FROM `DB`.status_incident_monitors');
  await sql('DELETE FROM `DB`.status_incidents');
  await autoIncidentRound(pages(), [mon(0)], 'ok', NOW);
  [inc] = await openAuto();
  // Der Bestandteil wird nicht mehr geprüft (gelöscht oder pausiert): Hinweis und Schluss
  const r = await autoIncidentRound(pages(), [], 'ok', NOW + 60);
  assert.deepEqual(r.resolved, [Number(inc.id)]);
  assert.deepEqual((await updatesOf(Number(inc.id))).slice(1), [['investigating', autoTexts.unmonitored('Website')], ['resolved', autoTexts.closedUnmonitored]]);
});

test('maintenance starts and ends on time, each with one automatic update', async () => {
  await sql(`INSERT INTO \`DB\`.status_incidents (page_id, kind, title, status, impact, is_auto, starts_at, ends_at, notify, created_at, updated_at)
    VALUES (?, 'maintenance', 'Upgrade', 'scheduled', 'none', 0, ?, ?, 1, NOW(), NOW())`, [pageId, NOW + 60, NOW + 600]);
  const id = Number((await sql('SELECT MAX(id) AS id FROM `DB`.status_incidents'))[0].id);
  await sql("INSERT INTO `DB`.status_incident_monitors (incident_id, monitor_id, effect) VALUES (?, ?, 'maintenance')", [id, ids[0]]);
  await sql("INSERT INTO `DB`.status_incident_updates (incident_id, status, body, is_auto, created_at) VALUES (?, 'scheduled', 'Short downtime.', 0, ?)", [id, NOW]);
  assert.deepEqual(await maintenanceRound(NOW), [], 'not yet');
  let ch = await maintenanceRound(NOW + 60);
  assert.deepEqual(ch, [{ incidentId: id, pageId, ended: false, monitorIds: [ids[0]] }]);
  assert.equal((await sql('SELECT status FROM `DB`.status_incidents WHERE id = ?', [id]))[0].status, 'in_progress');
  assert.deepEqual(await maintenanceRound(NOW + 90), [], 'started once');
  ch = await maintenanceRound(NOW + 600);
  assert.equal(ch[0].ended, true);
  const row = (await sql('SELECT status, resolved_at FROM `DB`.status_incidents WHERE id = ?', [id]))[0];
  assert.equal(row.status, 'completed');
  assert.equal(Number(row.resolved_at), NOW + 600);
  assert.deepEqual((await updatesOf(id)).slice(1), [['in_progress', autoTexts.maintenanceStarted], ['completed', autoTexts.maintenanceDone]]);
});

test('an auto incident whose components were all deleted closes as “no longer monitored”', async () => {
  await sql(`INSERT INTO \`DB\`.status_monitors (page_id, user_id, type, name, is_public, target, config, interval_s, changed_at, created_at, updated_at)
    VALUES (?, NULL, 'http', 'Gone', 1, 'https://example.com/', '{}', 300, 0, NOW(), NOW())`, [pageId]);
  const gone = Number((await sql('SELECT MAX(id) AS id FROM `DB`.status_monitors'))[0].id);
  const r = await autoIncidentRound(pages(), [{ ...mon(0), id: gone, name: 'Gone' }], 'ok', NOW);
  assert.equal(r.opened.length, 1);
  // Gelöscht wie im Editor (status-monitor-delete): Verknüpfung und Bestandteil weg
  await sql('DELETE FROM `DB`.status_incident_monitors WHERE monitor_id = ?', [gone]);
  await sql('DELETE FROM `DB`.status_monitors WHERE id = ?', [gone]);
  const r2 = await autoIncidentRound(pages(), [], 'ok', NOW + 30);
  assert.deepEqual(r2.resolved, r.opened);
  const [inc] = await openAuto();
  assert.equal(inc.status, 'resolved');
  const ups = await updatesOf(Number(inc.id));
  assert.deepEqual(ups[ups.length - 1], ['resolved', autoTexts.closedUnmonitored]);
});

// Discord: ein Bot mit status.v1 schlägt #status vor
const CH = (n: number): string => String(1300000000000000000n + BigInt(n));
const report = (): string => JSON.stringify({
  reported_at: Math.floor(Date.now() / 1000), version: '0.3.0', runtime: 'service', features: ['updates.v1', 'status.v1'],
  guild: { id: CH(1), name: 'OnYourSite', community: true }, updates_channel_id: '', status_channel_id: CH(20), categories: [],
  channels: [{ id: CH(20), name: 'status', type: 'announcement', parent_id: '', can_post: true, can_mention_everyone: false, missing: [] }],
  threads: [], roles: [], truncated: false,
});

test('no Discord post while OnYourSite’s status page is offline or its address belongs to a profile page', async () => {
  const posts = async () => (await sql("SELECT COUNT(*) AS n FROM `DB`.community_outbox WHERE action = 'status.post'"))[0].n
    + (await sql('SELECT COUNT(*) AS n FROM `DB`.status_incident_posts'))[0].n;
  const reset = async () => {
    for (const q of ['DELETE FROM `DB`.status_incident_posts', "DELETE FROM `DB`.community_outbox WHERE action LIKE 'status.%'", 'DELETE FROM `DB`.status_incident_updates',
      'DELETE FROM `DB`.status_incident_monitors', 'DELETE FROM `DB`.status_incidents']) await sql(q);
  };
  await sql("REPLACE INTO `DB`.oys_meta (meta_key, meta_value) VALUES ('discord_bot_report', ?)", [report()]);
  await sql("INSERT IGNORE INTO `DB`.users (id, email, password, full_name, is_admin, created_at) VALUES (9, 'mia@test.de', 'x', 'Mia', 0, NOW())");
  try {
    await reset();
    await sql('UPDATE `DB`.status_pages SET is_published = 0 WHERE id = ?', [pageId]);
    assert.equal((await autoIncidentRound(pages(), [mon(0)], 'ok', NOW)).opened.length, 1);
    assert.equal(Number(await posts()), 0, 'offline: the incident stays on the site');
    // Online, aber die Adresse gehört einer Profilseite
    await reset();
    await sql('UPDATE `DB`.status_pages SET is_published = 1 WHERE id = ?', [pageId]);
    const slug = String((await sql('SELECT slug FROM `DB`.status_pages WHERE id = ?', [pageId]))[0].slug);
    await sql("INSERT INTO `DB`.pages (user_id, slug, title, created_at) VALUES (9, ?, 'x', NOW())", [slug]);
    assert.equal((await autoIncidentRound(pages(), [mon(0)], 'ok', NOW)).opened.length, 1);
    assert.equal(Number(await posts()), 0, 'the address is used by a profile page');
    // Ohne Konflikt: ein Beitrag
    await reset();
    await sql('DELETE FROM `DB`.pages WHERE user_id = 9');
    assert.equal((await autoIncidentRound(pages(), [mon(0)], 'ok', NOW)).opened.length, 1);
    assert.equal(Number(await posts()), 2, 'one post row and one status.post job');
  } finally {
    await reset();
    await sql('DELETE FROM `DB`.pages WHERE user_id = 9');
    await sql("DELETE FROM `DB`.oys_meta WHERE meta_key = 'discord_bot_report'");
  }
});

test('OnYourSite’s own components (exempt from the platform gate) open and close auto incidents while the gate is on hold or frozen', async () => {
  const sys = (over: Partial<AutoMonitor> = {}): AutoMonitor => mon(0, { gateExempt: true, ...over });
  for (const gate of ['hold', 'frozen'] as const) {
    await sql('DELETE FROM `DB`.status_incident_updates');
    await sql('DELETE FROM `DB`.status_incident_monitors');
    await sql('DELETE FROM `DB`.status_incidents');
    const r = await autoIncidentRound(pages(), [sys(), mon(1)], gate, NOW);
    assert.equal(r.opened.length, 1, gate);
    const [inc] = await openAuto();
    assert.deepEqual((await sql('SELECT monitor_id FROM `DB`.status_incident_monitors WHERE incident_id = ?', [inc.id])).map((x) => Number(x.monitor_id)), [ids[0]], 'only the exempt one');
    const r2 = await autoIncidentRound(pages(), [sys({ state: 'up' }), mon(1)], gate, NOW + 60);
    assert.deepEqual(r2.resolved, [Number(inc.id)], gate);
  }
});
