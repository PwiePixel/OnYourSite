// Statusseiten: Einstellungen des Moduls (Vorgaben, Begrenzung, Speichern mit Mail-Budget), Einstellungen einer Seite
// (Vorgaben, unbekannte Schlüssel), Server-Fakten aus config.json und die Grenzen (statusLimits, effectiveMonitors) –
// bis zur Freischaltung im Shop: feste Grenzen für OnYourSites Seite, Plan 'none' für Nutzer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { setConfigForTests, type ConfigData } from '../src/config.js';
import { withConnection } from '../src/db.js';
import { ensureSchema } from '../src/schema.js';
import {
  DEFAULT_CANARIES, DEFAULT_DNS, pageSettingsDefaults, statusDefaults, statusPageSettings, statusSaveSettings, statusServerConfig,
  statusSettings, statusSettingsFrom,
} from '../src/status/settings.js';
import { effectiveMonitors, statusLimits, type StatusLimits } from '../src/status/limits.js';
import { BASE, testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;

before(async () => {
  t = await testDatabase('st1settings');
  await ensureSchema();
});

after(async () => {
  await t.done();
});

const meta = async (): Promise<string | undefined> =>
  ((await t.admin.query<RowDataPacket[]>(`SELECT meta_value FROM \`${t.name}\`.oys_meta WHERE meta_key = 'status'`))[0])[0]?.meta_value as string | undefined;

test('module defaults: Premium only raises checks, interval and subscribers (Q1 = b)', () => {
  const d = statusDefaults();
  assert.deepEqual(d.free, { checks: 10, min_interval: 180, channels: 3, subscribers: 50, broadcasts_day: 3 });
  assert.deepEqual(d.premium, { checks: 30, min_interval: 60, channels: 3, subscribers: 250, broadcasts_day: 3 });
  assert.deepEqual(d.addons, { more_checks: 10, fast_interval: 60 });
  assert.deepEqual(d.intervals, [60, 120, 180, 300]);
  assert.deepEqual(d.ports, [80, 443, 8080, 8443]);
  assert.equal(d.allow_new, true);
  assert.equal(d.run_user_checks, true);
  assert.equal(d.components_max, 40);
  assert.equal(d.mail_per_day, 1000);
  // Ein leerer oder kaputter Eintrag ergibt genau die Vorgaben
  for (const raw of [null, 'x', 5, [], {}]) assert.deepEqual(statusSettingsFrom(raw), d, JSON.stringify(raw));
});

test('values are clamped, lists are parsed and minimum intervals snap to an allowed one', () => {
  const s = statusSettingsFrom({
    allow_new: '0', run_user_checks: 'off',
    free: { checks: '-5', min_interval: '150', channels: 999, subscribers: '12', broadcasts_day: 'x' },
    premium: { checks: 100000, min_interval: 45 },
    addons: { more_checks: '15', fast_interval: 90 },
    intervals: '300, 60,  60, 120 , abc, 59, 7200',
    ports: [443, '80', 0, 70000, 8443, 443],
    host_cap: 0, domain_cap: '123', timeout_max: 99, raw_days: 0, inactive_days: 1, unknown_key: 'dropped',
  });
  assert.equal(s.allow_new, false);
  assert.equal(s.run_user_checks, false);
  assert.deepEqual(s.free, { checks: 0, min_interval: 300, channels: 20, subscribers: 12, broadcasts_day: 3 });
  assert.equal(s.premium.checks, 500);
  assert.equal(s.premium.min_interval, 60);
  assert.deepEqual(s.addons, { more_checks: 15, fast_interval: 60 });
  assert.deepEqual(s.intervals, [60, 120, 300]);
  assert.deepEqual(s.ports, [80, 443, 8443]);
  assert.equal(s.host_cap, 1);
  assert.equal(s.domain_cap, 123);
  assert.equal(s.timeout_max, 30);
  assert.equal(s.raw_days, 1);
  assert.equal(s.inactive_days, 30);
  assert.equal(Object.hasOwn(s, 'unknown_key'), false);
  // Leere Listen fallen auf die Vorgaben zurück
  assert.deepEqual(statusSettingsFrom({ intervals: 'none', ports: [] }).intervals, [60, 120, 180, 300]);
});

test('saving: stored as JSON and read back; subscriber limits must fit a quarter of the daily mail budget', async () => {
  assert.equal(await meta(), undefined);
  assert.deepEqual(await statusSettings(), statusDefaults());

  const refused = await statusSaveSettings({ premium: { subscribers: 300 }, mail_per_day: 1000 });
  assert.deepEqual(refused, { ok: false, error: 'One update to 300 subscribers would use more than a quarter of the daily email budget (1,000).' });
  const refusedFree = await statusSaveSettings({ free: { subscribers: 600 }, premium: { subscribers: 100 }, mail_per_day: 2000 });
  assert.equal(refusedFree.ok, false);
  assert.equal(await meta(), undefined, 'nothing stored');

  const saved = await statusSaveSettings({ premium: { subscribers: 250 }, mail_per_day: 1000, components_max: '25', allow_new: false });
  assert.equal(saved.ok, true);
  const stored = JSON.parse(String(await meta())) as Record<string, unknown>;
  assert.equal(stored.components_max, 25);
  assert.equal(stored.allow_new, false);
  const back = await statusSettings();
  assert.equal(back.components_max, 25);
  assert.equal(back.allow_new, false);
  // Über eine Verbindung des Aufrufers (Transaktion) dasselbe
  await withConnection(async (db) => {
    assert.equal((await statusSettings(db)).components_max, 25);
  });

  // Ein kaputter Eintrag ergibt die Vorgaben
  await t.admin.query(`REPLACE INTO \`${t.name}\`.oys_meta (meta_key, meta_value) VALUES ('status', '{broken')`);
  assert.deepEqual(await statusSettings(), statusDefaults());
  await t.admin.query(`DELETE FROM \`${t.name}\`.oys_meta WHERE meta_key = 'status'`);
});

test('page settings: defaults, checked values, unknown keys dropped, bot channels only on the system page', () => {
  assert.deepEqual(statusPageSettings(null), pageSettingsDefaults());
  assert.deepEqual(statusPageSettings({ settings: '{nope' }), pageSettingsDefaults());
  const s = statusPageSettings({
    settings: JSON.stringify({
      accent: '#ABCDEF', logo_page_id: '7', back_page_id: -3, show_uptime: false, show_response: 1, history_days: 99, subscribe: '0',
      hide_branding: true, noindex: 'on', auto_incident: 900, notify_auto: false, evil: '<script>',
      alerts: { owner: false, admins: true, events: ['down', 'cert', 'reboot', 'down'] },
      bot: { status_channel_id: '123456789012345678', alerts_channel_id: 'x' },
    }),
  });
  assert.deepEqual(s, {
    accent: '#abcdef', logo_page_id: 7, back_page_id: 0, show_uptime: false, show_response: true, history_days: 30, subscribe: false,
    hide_branding: true, noindex: true, auto_incident: 900, notify_auto: false,
    alerts: { owner: false, admins: true, events: ['down', 'cert'] },
  });
  assert.equal(statusPageSettings({ settings: '{"accent":"red","auto_incident":120}' }).accent, '');
  assert.equal(statusPageSettings({ settings: '{"auto_incident":120}' }).auto_incident, 300);
  assert.equal(statusPageSettings({ settings: '{"auto_incident":0}' }).auto_incident, 0);
  const system = statusPageSettings({ is_system: 1, settings: '{"bot":{"status_channel_id":"123456789012345678","alerts_channel_id":"1"}}' });
  assert.deepEqual(system.bot, { status_channel_id: '123456789012345678', alerts_channel_id: '', saved: false });
  assert.equal(statusPageSettings({ is_system: 0, settings: '{"bot":{"status_channel_id":"123456789012345678"}}' }).bot, undefined);
});

test('server facts from config.json: defaults and checked values', () => {
  try {
    setConfigForTests({ ...BASE });
    const d = statusServerConfig();
    assert.deepEqual(d.dns, DEFAULT_DNS);
    assert.deepEqual(d.canaries, DEFAULT_CANARIES);
    assert.equal(d.concurrency, 1000);
    assert.equal(d.keyword_concurrency, 64);
    assert.equal(d.user_inflight, 32);
    assert.equal(d.tunnel, false);
    assert.deepEqual(d.self_ips, []);
    assert.equal(d.kernel_guard, null);

    setConfigForTests({
      ...BASE,
      status: {
        dns: ['9.9.9.9', 'resolver.example', '127.0.0.1:5353', '[2620:fe::fe]:53'], canaries: ['http://insecure.example/', 'https://ok.example/x'],
        concurrency: 999999, tunnel: true, self_ips: ['203.0.113.5', 'not-an-ip', '2a01:4f8::1'], kernel_guard: false,
      } as unknown as ConfigData,
    });
    const c = statusServerConfig();
    assert.deepEqual(c.dns, ['9.9.9.9', '127.0.0.1:5353', '[2620:fe::fe]:53']);
    assert.deepEqual(c.canaries, ['https://ok.example/x']);
    assert.equal(c.concurrency, 5000);
    assert.equal(c.tunnel, true);
    assert.deepEqual(c.self_ips, ['203.0.113.5', '2a01:4f8::1']);
    assert.equal(c.kernel_guard, false);
  } finally {
    setConfigForTests({ ...BASE, db: { ...(BASE.db as ConfigData), name: t.name }, uploads_dir: t.uploads });
  }
});

test('limits: fixed limits for the system page, nothing for users without the unlock, Premium limits for admins (included)', async () => {
  const system = await statusLimits(null);
  assert.deepEqual(system, { plan: 'system', checks: 40, components: 40, minInterval: 60, channels: 3, subscribers: 250, broadcastsDay: 3, until: null });
  for (const uid of [5, 999]) {
    assert.deepEqual(await statusLimits(uid), { plan: 'none', checks: 0, components: 0, minInterval: 180, channels: 0, subscribers: 0, broadcastsDay: 0, until: null });
  }
  // Konto 3 ist Admin: status_page ist für Admins dabei (ST-4, ROADMAP §3.2), und die Rolle zählt als Premium (ST-7)
  assert.deepEqual(await statusLimits(3), { plan: 'premium', checks: 30, components: 40, minInterval: 60, channels: 3, subscribers: 250, broadcastsDay: 3, until: null });
  await statusSaveSettings({ components_max: 12, intervals: [120, 300] });
  try {
    const s = await statusLimits(null);
    assert.equal(s.checks, 12);
    assert.equal(s.minInterval, 120);
  } finally {
    await t.admin.query(`DELETE FROM \`${t.name}\`.oys_meta WHERE meta_key = 'status'`);
  }
});

test('effectiveMonitors: the first checks by position stay active, intervals stretch, manual and system never count', () => {
  const limits: StatusLimits = { plan: 'free', checks: 2, components: 40, minInterval: 180, channels: 3, subscribers: 50, broadcastsDay: 3, until: null };
  const rows = [
    { id: 5, type: 'http', position: 3, interval_s: 60 },
    { id: 1, type: 'manual', position: 0, interval_s: 300 },
    { id: 2, type: 'http', position: 1, interval_s: 300 },
    { id: 9, type: 'heartbeat', position: 2, interval_s: 60 },
    { id: 4, type: 'http', position: 2, interval_s: 120 },
    { id: 7, type: 'system', position: 9, interval_s: 60 },
  ];
  const out = effectiveMonitors(rows, limits);
  assert.deepEqual(out.map((m) => [m.id, m.overLimit, m.effectiveInterval]), [
    [1, false, 300], [2, false, 300], [4, false, 180], [9, true, 60], [5, true, 180], [7, false, 60],
  ]);
  // Plan 'none': keine Prüfung läuft, Daten bleiben
  const none = effectiveMonitors(rows, { ...limits, plan: 'none', checks: 0 });
  assert.deepEqual(none.filter((m) => !m.overLimit).map((m) => m.id), [1, 7]);
  // Die Eingabe bleibt unverändert
  assert.equal(rows[0].id, 5);
  assert.equal(Object.hasOwn(rows[0], 'overLimit'), false);
});
