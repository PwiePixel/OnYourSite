// DB: Mails des Shops (honeycomb-shop HC-7b). In die Warteschlange: Erinnerung auf Stufe 2 (3 Tage vorher) genau
// einmal je Ende, nicht bei einem weiteren Paket, nicht abgeschaltet; Ende (Ablauf, Erstattung mit „Also remove“, vom
// Team entfernt) nur mit Zeilen „was wegfällt“. Versand: Budget je Lauf, nach 5 Fehlversuchen aufgeben, alte
// Erinnerungen nicht mehr schicken, ohne Empfänger erledigt, alte Zeilen nachts weg; die echte Vorlage maskiert alles.
// Dazu der Schalter im Editor (shop-reminders) und das Budget im Admin.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RowDataPacket } from 'mysql2/promise';
import { makeTestCtx, type Ctx } from '../src/web/ctx.js';
import { appRoutes } from '../src/app/dispatch.js';
import { ensureSchema } from '../src/schema.js';
import { ROOT_DIR } from '../src/config.js';
import { addSeconds, nowStr } from '../src/honeycombs/clock.js';
import { registerFeature, registerLossPreview, unregisterFeatureForTests, type Feature } from '../src/honeycombs/features.js';
import { expiryStep, reminderStep } from '../src/honeycombs/job.js';
import { defaultShopSender, mailBudgetFrom, pruneShopMails, sendShopMails, setShopMailSenderForTests, type ShopMail } from '../src/honeycombs/outbox.js';
import { grantFeature, revokeFeature } from '../src/honeycombs/grants.js';
import { buy, refund } from '../src/honeycombs/shop.js';
import { ensureCatalogue } from '../src/honeycombs/catalogue.js';
import { setMailDirForTests, setMailTransportForTests, type CapturedMail } from '../src/mail.js';
import { adminHcHandle } from '../src/honeycombs/honeycombs.js';
import { randomHex } from '../src/crypto.js';
import { decodeWords, header, leaves, parseMessage } from './support/mime.js';
import { CSRF, jsonBody, loginSession, runRequest, testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
let mailDir = '';
const U = 5;
const OLD = '2026-01-01 10:00:00';
const ctx = () => ({ deadline: Date.now() + 60_000, log: () => undefined });
let lossLines: string[] = ['Your page goes back to the free plan.'];

async function sql(query: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [r] = await t.admin.query<RowDataPacket[]>(query.replace(/`DB`/g, '`' + t.name + '`'), params);
  return r;
}
const n = async (query: string, params: unknown[] = []): Promise<number> => Number(Object.values((await sql(query, params))[0])[0]);
const outbox = async () => (await sql('SELECT user_id, ref, subject, vars, sent_at, tries, last_error FROM `DB`.hc_mail_outbox ORDER BY id')).map((r) => ({ ...r }));
async function lot(o: { uid?: number; lot?: number; expires: string; reminded?: number }): Promise<number> {
  const [r] = await t.admin.query<import('mysql2/promise').ResultSetHeader>(`INSERT INTO \`${t.name}\`.hc_entitlements
      (user_id, feature, lot, quantity, permanent, expires_at, source, reminded, created_at, updated_at) VALUES (?, 'mail_pass', ?, 1, 0, ?, 'purchase', ?, ?, ?)`,
  [o.uid ?? U, o.lot ?? 0, o.expires, o.reminded ?? 0, OLD, OLD]);
  return r.insertId;
}
const PASS: Feature = { key: 'mail_pass', owner: 'tests', title: 'Mail pass', icon: 'bx-time', description: 'Timed test.', kind: 'timed', stack: 2,
  items: { mail_pass_30: { days: 30, price: 10, active: true } } };

before(async () => {
  t = await testDatabase('hcmails', { empty: true });
  await ensureSchema();
  const user = 'INSERT INTO `DB`.users (id, email, password, full_name, is_admin, created_at) VALUES (?, ?, \'x\', ?, ?, ?)';
  await sql(user, [3, 'admin@test.de', 'Pixel Admin', 1, OLD]);
  await sql(user, [5, 'mia@test.de', 'Mia <b>M</b>', 0, OLD]);
  await sql(user, [6, 'tom@test.de', 'Tom', 0, OLD]);
  registerFeature(PASS);
  registerLossPreview('mail_pass', async () => lossLines);
  mailDir = mkdtempSync(join(tmpdir(), 'oys-hc-mail-'));
  // Zugangsdaten zur Laufzeit zusammengesetzt (keine festen Werte im Repository)
  writeFileSync(join(mailDir, 'smtp.json'), JSON.stringify({ host: '127.0.0.1', port: 1, username: 'noreply@on-your.site', password: ['t', 'e', 's', 't'].join('') + process.pid, from_email: 'noreply@on-your.site', from_name: 'OnYourSite' }));
  copyFileSync(join(ROOT_DIR, 'email', 'unlock_reminder.json'), join(mailDir, 'unlock_reminder.json'));
  setMailDirForTests(mailDir);
});

beforeEach(async () => {
  for (const tb of ['hc_entitlements', 'notifications', 'honeycomb_ledger', 'hc_mail_outbox']) await sql(`DELETE FROM \`DB\`.${tb}`);
  await sql('UPDATE `DB`.hc_accounts SET mail_reminders = 1');
  lossLines = ['Your page goes back to the free plan.'];
  setShopMailSenderForTests(null);
});

after(async () => {
  setShopMailSenderForTests(null);
  setMailTransportForTests(null);
  setMailDirForTests(null);
  unregisterFeatureForTests('mail_pass');
  rmSync(mailDir, { recursive: true, force: true });
  await t.done();
});

test('reminder mail: once at stage 2 (not at stage 1, not twice, not with another pack, not when switched off)', async () => {
  const now = nowStr();
  const id = await lot({ expires: addSeconds(now, 6 * 86400) });
  await reminderStep(ctx(), now);
  assert.equal((await outbox()).length, 0, 'stage 1: bell only');
  const later = addSeconds(now, 3.5 * 86400);
  await reminderStep(ctx(), later);
  await reminderStep(ctx(), later);
  const o = await outbox();
  assert.equal(o.length, 1);
  assert.match(String(o[0].ref), new RegExp(`^rem2:${id}:\\d+$`));
  assert.match(String(o[0].subject), /^Your Mail pass ends on \w{3} \d{1,2}, \d{4}$/);
  assert.deepEqual(JSON.parse(String(o[0].vars)).text, 'Your page goes back to the free plan. Renew it in the shop to keep it.');
  // Stufe 3: keine zweite Mail
  await reminderStep(ctx(), addSeconds(now, 5.5 * 86400));
  assert.equal((await outbox()).length, 1);
  // Abgeschaltet: keine Mail (die Glocke kommt trotzdem)
  await sql('DELETE FROM `DB`.hc_entitlements');
  await sql('INSERT INTO `DB`.hc_accounts (user_id, mail_reminders, created_at, updated_at) VALUES (6, 0, ?, ?) ON DUPLICATE KEY UPDATE mail_reminders = 0', [now, now]);
  await lot({ uid: 6, expires: addSeconds(now, 2 * 86400) });
  await reminderStep(ctx(), now);
  assert.equal(await n('SELECT COUNT(*) FROM `DB`.hc_mail_outbox WHERE user_id = 6'), 0);
  assert.equal(await n('SELECT COUNT(*) FROM `DB`.notifications WHERE user_id = 6'), 1);
  // Ein weiteres Paket läuft danach weiter: keine Mail
  await lot({ uid: U, lot: 0, expires: addSeconds(now, 2 * 86400) });
  await lot({ uid: U, lot: 1, expires: addSeconds(now, 40 * 86400) });
  await sql('DELETE FROM `DB`.hc_mail_outbox');
  await reminderStep(ctx(), now);
  assert.equal((await outbox()).length, 0);
});

test('ended mail: on expiry only with loss lines; after a refund with “Also remove”; after a revoke by the team', async () => {
  const now = nowStr();
  const id = await lot({ expires: addSeconds(now, -60) });
  await expiryStep(ctx(), now);
  await expiryStep(ctx(), now);
  const o = await outbox();
  assert.equal(o.length, 1);
  assert.match(String(o[0].ref), new RegExp(`^end:${id}:\\d+$`));
  assert.equal(o[0].subject, 'Your Mail pass has ended');
  // Nichts fällt weg: keine Mail
  await sql('DELETE FROM `DB`.hc_entitlements');
  await sql('DELETE FROM `DB`.hc_mail_outbox');
  lossLines = [];
  await lot({ expires: addSeconds(now, -60) });
  await expiryStep(ctx(), now);
  assert.equal((await outbox()).length, 0);
  // Vom Team entfernt
  lossLines = ['Your page goes back to the free plan.'];
  await sql('DELETE FROM `DB`.hc_entitlements');
  const g = await grantFeature(3, U, 'mail_pass', { days: 30, formRef: randomHex(8) }, '');
  assert.ok('ok' in g, JSON.stringify(g));
  const r = await revokeFeature(3, U, 'mail_pass', null, '', randomHex(8));
  assert.ok('ok' in r, JSON.stringify(r));
  assert.match(String((await outbox()).at(-1)?.ref), /^end:\d+:\d+$/);
  // Gekauft und mit „Also remove“ ganz erstattet: endet jetzt → dieselbe Mail
  await sql('DELETE FROM `DB`.hc_entitlements');
  await sql('DELETE FROM `DB`.hc_mail_outbox');
  await sql("INSERT INTO `DB`.honeycomb_ledger (user_id, amount, reason, ref, note, created_at) VALUES (?, 100, 'admin', ?, '', ?)", [U, 'a3-' + randomHex(8), now]);
  await ensureCatalogue();
  await sql("UPDATE `DB`.hc_items SET is_active = 1 WHERE item_key = 'mail_pass_30'");
  const bought = await buy(null, U, 'mail_pass_30', randomHex(16), 10, { via: 'shop', terms: true });
  assert.ok(bought.ok, JSON.stringify(bought));
  assert.equal((await outbox()).length, 0, 'buying sends nothing');
  const pid = await n('SELECT MAX(id) FROM `DB`.hc_purchases WHERE user_id = ?', [U]);
  const rf = await refund(3, pid, null, true, '');
  assert.ok('ok' in rf, JSON.stringify(rf));
  const after = await outbox();
  assert.equal(after.length, 1);
  assert.equal(after[0].subject, 'Your Mail pass has ended');
});

test('sending: budget per run, success once, 5 failures give up, old reminders and missing users are closed', async () => {
  const now = nowStr();
  const sent: ShopMail[] = [];
  let fail = false;
  setShopMailSenderForTests(async (m) => { if (fail) throw new Error('connection refused'); sent.push(m); return true; });
  for (let i = 0; i < 5; i++) await sql("INSERT INTO `DB`.hc_mail_outbox (user_id, template, ref, subject, vars, created_at) VALUES (5, 'unlock_reminder', ?, 'S', '{\"headline\":\"H\",\"text\":\"T\",\"feature\":\"premium\"}', ?)", ['end:' + i, now]);
  assert.equal(await sendShopMails({ budget: 3, now }), 3);
  assert.equal(await sendShopMails({ budget: 3, now }), 2);
  assert.equal(await sendShopMails({ budget: 3, now }), 0, 'each mail once');
  assert.equal(sent[0].shopUrl.endsWith('/dashboard#honeycombs/premium'), true);
  assert.equal(sent[0].fullName, 'Mia <b>M</b>');
  // Fehler: 5 Versuche, dann aufgegeben (sichtbar mit Fehler)
  await sql('DELETE FROM `DB`.hc_mail_outbox');
  await sql("INSERT INTO `DB`.hc_mail_outbox (user_id, template, ref, subject, vars, created_at) VALUES (5, 'unlock_reminder', 'end:x', 'S', '{}', ?)", [now]);
  fail = true;
  for (let i = 0; i < 5; i++) assert.equal(await sendShopMails({ budget: 10, now }), 0);
  assert.deepEqual((await outbox()).map((r) => [r.tries, r.sent_at !== null, r.last_error]), [[5, true, 'connection refused']]);
  // Alte Erinnerung, gelöschtes Konto
  fail = false;
  await sql('DELETE FROM `DB`.hc_mail_outbox');
  await sql("INSERT INTO `DB`.hc_mail_outbox (user_id, template, ref, subject, vars, created_at) VALUES (5, 'unlock_reminder', 'rem2:1:1', 'S', '{}', ?), (999, 'unlock_reminder', 'end:9', 'S', '{}', ?)", [addSeconds(now, -4 * 86400), now]);
  const before = sent.length;
  assert.equal(await sendShopMails({ budget: 10, now }), 0);
  assert.equal(sent.length, before);
  assert.deepEqual((await outbox()).map((r) => r.last_error), ['too old to send', 'no recipient']);
  // Nachts: älter als 30 Tage weg
  await sql('UPDATE `DB`.hc_mail_outbox SET created_at = ?', [addSeconds(now, -31 * 86400)]);
  assert.equal(await pruneShopMails(undefined, now), 2);
});

test('the real template: subject, the shop link and every value escaped', async () => {
  const mails: CapturedMail[] = [];
  setMailTransportForTests((m) => void mails.push(m));
  try {
    assert.equal(await defaultShopSender({ to: 'mia@test.de', fullName: 'Mia <b>M</b>', headline: 'Premium ends on Dec 1', text: 'a <script>x</script> b', shopUrl: 'https://on-your.site/dashboard#honeycombs/premium', subject: 'Your Premium ends on Dec 1' }), true);
  } finally {
    setMailTransportForTests(null);
  }
  const msg = parseMessage(mails[0].raw);
  assert.equal(decodeWords(header(msg, 'subject') ?? ''), 'Your Premium ends on Dec 1');
  const raw = leaves(msg).find((p) => p.type === 'text/html')!.body.toString('utf8');
  assert.ok(raw.includes('href="https://on-your.site/dashboard#honeycombs/premium"'), 'shop link');
  assert.ok(raw.includes('Mia &lt;b&gt;M&lt;/b&gt;') && !raw.includes('<script>x'), 'escaped');
  assert.ok(raw.includes('You can turn these emails off in the editor under Honeycombs.'));
});

test('the switch in the editor and the budget in the admin', async () => {
  const api = async (body: unknown, o: { impersonatedBy?: number; method?: string } = {}): Promise<Ctx> => {
    const sid = await loginSession(U, { impersonatedBy: o.impersonatedBy });
    const method = o.method ?? 'POST';
    return runRequest(makeTestCtx({ method, url: '/dashboard/api/shop-reminders', headers: { 'content-type': 'application/json', 'x-csrf-token': CSRF }, cookies: { PHPSESSID: sid }, rawBody: method === 'POST' ? Buffer.from(JSON.stringify(body)) : undefined }), appRoutes);
  };
  assert.deepEqual(jsonBody(await api({ enabled: false })), { ok: true });
  assert.equal(await n('SELECT mail_reminders FROM `DB`.hc_accounts WHERE user_id = ?', [U]), 0);
  const shop = jsonBody(await runRequest(makeTestCtx({ url: '/dashboard/api/shop', cookies: { PHPSESSID: await loginSession(U) }, headers: { 'x-csrf-token': CSRF } }), appRoutes)).shop as { mailReminders: boolean };
  assert.equal(shop.mailReminders, false);
  assert.equal((await api({ enabled: 'yes' })).status, 400);
  assert.equal((await api({ enabled: true }, { method: 'GET' })).status, 404);
  const am = await api({ enabled: true }, { impersonatedBy: 3 });
  assert.equal(am.status, 403);
  assert.equal(await n('SELECT mail_reminders FROM `DB`.hc_accounts WHERE user_id = ?', [U]), 0);
  assert.deepEqual(jsonBody(await api({ enabled: true })), { ok: true });
  assert.equal(await n('SELECT mail_reminders FROM `DB`.hc_accounts WHERE user_id = ?', [U]), 1);
  // Budget: 1–1000, Standard 100
  assert.equal(mailBudgetFrom(''), 100);
  assert.deepEqual(await adminHcHandle({ hc_action: 'settings', mail_per_run: '5000' }, 3), { ok: 'Honeycomb settings saved.' });
  assert.equal(JSON.parse(String((await sql("SELECT meta_value FROM `DB`.oys_meta WHERE meta_key = 'honeycombs'"))[0].meta_value)).mail_per_run, 1000);
});

test('review: a pack that ends sooner doesn’t swallow the reminder of the last one; switched off before sending → not sent', async () => {
  const now = nowStr();
  // Paket 1 endet in 2 Tagen, Paket 0 in 3 Tagen: Paket 0 ist das letzte → seine Erinnerung kommt (Glocke ohne „A pack of“, Mail)
  await lot({ lot: 1, expires: addSeconds(now, 2 * 86400) });
  const last = await lot({ lot: 0, expires: addSeconds(now, 2.9 * 86400) });
  await reminderStep(ctx(), now);
  const refs = (await outbox()).map((r) => String(r.ref));
  assert.ok(refs.some((r) => r.startsWith(`rem2:${last}:`)), 'the last pack gets its mail: ' + refs.join(', '));
  assert.ok(!refs.some((r) => !r.startsWith(`rem2:${last}:`)), 'only that one');
  // Schalter aus, bevor die Mail rausgeht: sie wird nicht verschickt
  const sent: ShopMail[] = [];
  setShopMailSenderForTests(async (m) => { sent.push(m); return true; });
  await sql('UPDATE `DB`.hc_accounts SET mail_reminders = 0 WHERE user_id = ?', [U]);
  assert.equal(await sendShopMails({ budget: 10, now }), 0);
  assert.equal(sent.length, 0);
  assert.deepEqual((await outbox()).map((r) => r.last_error), ['switched off']);
});
