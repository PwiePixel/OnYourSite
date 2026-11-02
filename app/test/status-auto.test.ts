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
