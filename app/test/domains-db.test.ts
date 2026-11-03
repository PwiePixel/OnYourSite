// Eigene Domains (PD-2), Datenbank: der Schritt V_CUSTOM_DOMAINS (wiederholbar), Compare-and-set mit der
// Hauptadresse der Seite, „in jedem Zustand“ für hasDomain (XD-02), Entfernen, beforePageRemoved in der Transaktion
// des Aufrufers und der Haken „domains“ beim Löschen eines Kontos. Pool mit EINER Verbindung und strengem Schalter:
// eine zweite Verbindung (z. B. aus einem Haken) fiele sofort auf.
process.env.OYS_DB_POOL_SIZE = '1';
process.env.OYS_DB_STRICT = '1';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { RowDataPacket } from 'mysql2/promise';
import { loadConfig, setConfigForTests } from '../src/config.js';
import { exec, one, q, transaction, value, type Db } from '../src/db.js';
import { date, strtotime, time } from '../src/php.js';
import { ensureSchema, SCHEMA_VERSION, V_CUSTOM_DOMAINS, V_DOMAIN_BLOCKS } from '../src/schema.js';
import { slugProblem } from '../src/helpers.js';
import {
  AccountDeletionError, deleteAccount, registerUserDeletion, unregisterUserDeletionForTests, userDeletionHooks,
} from '../src/admin/accountDeletion.js';
import {
  beforePageRemoved, createDomain, domainById, hasDomain, hostnameBlocked, hostnameForPage, releaseBlock, removeDomain, transition, type DomainRow,
  type DomainState,
} from '../src/domains/index.js';
import { forwardingDomain, removeUserDomains } from '../src/domains/store.js';
import { testDatabase, type TestDb } from './coreHarness.js';

let t: TestDb;
// Abfragen über den Pool, für Aufrufe außerhalb einer Transaktion
const POOL: Db = { q, one, value, exec };
const STATES: DomainState[] = ['verifying', 'pending', 'active', 'broken', 'suspended', 'failed', 'blocked', 'removing'];

const ddl = async (table: string): Promise<string> => {
  const [r] = await t.admin.query<RowDataPacket[]>(`SHOW CREATE TABLE \`${t.name}\`.\`${table}\``);
  return String(r[0]['Create Table']).replace(/ AUTO_INCREMENT=\d+/, '');
};
const pageDomain = async (pageId: number): Promise<unknown> => value('SELECT custom_domain FROM pages WHERE id = ?', [pageId]);
const logRows = async (hostname: string): Promise<Array<Record<string, unknown>>> =>
  q('SELECT domain_id, hostname, user_id, event, detail, cf_id, mail, mailed_at FROM custom_domain_log WHERE hostname = ? ORDER BY id', [hostname]);
const fresh = async (id: number): Promise<DomainRow> => (await domainById(id))!;

// Domain anlegen und über den Store in einen Zustand bringen (ohne Cloudflare, wie der Dienst es täte)
async function domainIn(state: DomainState, hostname: string, pageId: number, userId: number, cfId: string | null = null): Promise<DomainRow> {
  const id = await createDomain({ hostname, targetId: pageId, userId });
  if (state !== 'verifying' || cfId !== null) {
    assert.equal(await transition(await fresh(id), { state, set: cfId !== null ? { cf_id: cfId } : {} }), true);
  }
  return fresh(id);
}

before(async () => {
  t = await testDatabase('pd2db');
  setConfigForTests({ ...loadConfig(), cloudflare: { zone_id: 'f'.repeat(32) }, custom_domains: { cname_target: 'edge.oys.test', fallback_origin: 'origin.oys.test' } });
  await ensureSchema();
});

after(async () => {
  await t.done();
});

test('the step creates both tables and pages.custom_domain, and running it again changes nothing', async () => {
  const tables = ['custom_domains', 'custom_domain_log', 'pages'];
  const first = await Promise.all(tables.map(ddl));
  assert.match(first[0], /`hostname` varchar\(253\) CHARACTER SET ascii COLLATE ascii_bin NOT NULL/);
  assert.match(first[0], /UNIQUE KEY `uq_hostname` \(`hostname`\)/);
  assert.match(first[0], /UNIQUE KEY `uq_target` \(`target_type`,`target_id`\)/);
  assert.match(first[0], /KEY `idx_due` \(`next_check_at`\)/);
  assert.match(first[1], /KEY `idx_mail` \(`mail`,`mailed_at`\)/);
  assert.match(first[2], /`custom_domain` varchar\(253\) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL/);
  assert.match(first[2], /UNIQUE KEY `uq_custom_domain` \(`custom_domain`\)/);
  // Noch einmal ab dem Stand davor: jede Anweisung ist wiederholbar
  await t.admin.query(`REPLACE INTO \`${t.name}\`.oys_meta (meta_key, meta_value) VALUES ('schema_version', ?)`, [String(V_CUSTOM_DOMAINS - 1)]);
  await ensureSchema();
  assert.deepEqual(await Promise.all(tables.map(ddl)), first);
  assert.equal(await value("SELECT meta_value FROM oys_meta WHERE meta_key = 'schema_version'"), String(SCHEMA_VERSION));
  // Bestehende Seiten bleiben ohne Domain
  assert.equal(Number(await value('SELECT COUNT(*) FROM pages WHERE custom_domain IS NOT NULL')), 0);
});

test('a new domain waits for its first check; names and pages are unique', async () => {
  const started = time();
  const id = await createDomain({ hostname: 'links.example.com', targetId: 2, userId: 5 });
  const row = await fresh(id);
  assert.equal(row.state, 'verifying');
  assert.equal(row.version, 0);
  assert.equal(row.target_type, 'page');
  assert.equal(row.redirect, 1);
  assert.equal(row.cf_id, null);
  const due = strtotime(String(row.next_check_at)) as number;
  assert.ok(due >= started + 590 && due <= time() + 610, String(row.next_check_at));
  assert.deepEqual((await logRows('links.example.com')).map((r) => [r.event, r.domain_id, r.user_id]), [['added', id, 5]]);
  await assert.rejects(createDomain({ hostname: 'links.example.com', targetId: 3, userId: 6 }), /Duplicate entry/);
  await assert.rejects(createDomain({ hostname: 'www.example.com', targetId: 2, userId: 5 }), /Duplicate entry/);
  await removeDomain(POOL, id, 'test');
});

test('compare-and-set: a stale version writes nothing; the live state sets and clears the page’s primary address', async () => {
  const id = await createDomain({ hostname: 'cas.example.com', targetId: 4, userId: 7 });
  const v0 = await fresh(id);
  assert.equal(await transition(v0, { state: 'pending', set: { cf_id: 'cf-cas-1', cf_created_at: date('Y-m-d H:i:s') } }), true);
  // Dieselbe (veraltete) Version noch einmal: nichts geschieht
  assert.equal(await transition(v0, { state: 'active' }), false);
  assert.equal((await fresh(id)).state, 'pending');
  assert.equal(await pageDomain(4), null);

  const v1 = await fresh(id);
  assert.equal(v1.version, 1);
  assert.equal(await transition(v1, { state: 'active', log: { event: 'active', mail: true } }), true);
  const live = await fresh(id);
  assert.equal(live.version, 2);
  assert.ok(live.activated_at !== null);
  assert.equal(await pageDomain(4), 'cas.example.com');
  // Felder ohne Zustandswechsel lassen die Hauptadresse stehen
  assert.equal(await transition(live, { set: { redirect: 0 } }), true);
  assert.equal(await pageDomain(4), 'cas.example.com');
  assert.equal(await forwardingDomain((await one('SELECT * FROM pages WHERE id = 4'))!), null);
  assert.equal(await transition(await fresh(id), { set: { redirect: 1 } }), true);
  assert.equal(await forwardingDomain((await one('SELECT * FROM pages WHERE id = 4'))!), 'cas.example.com');
  // Pause: Hauptadresse weg, Beginn der Pause festgehalten
  assert.equal(await transition(await fresh(id), { state: 'suspended' }), true);
  const paused = await fresh(id);
  assert.ok(paused.suspended_at !== null);
  assert.equal(await pageDomain(4), null);
  assert.equal(await forwardingDomain((await one('SELECT * FROM pages WHERE id = 4'))!), null);
  // Nur bekannte Spalten
  await assert.rejects(transition(paused, { set: { 'state = 1, hostname': 'x' } }), /can't be changed here/);
  await assert.rejects(transition(paused, { state: 'gone' as DomainState }), /unknown custom domain state/);
  const log = await logRows('cas.example.com');
  assert.deepEqual(log.map((r) => [r.event, r.mail]), [['added', 0], ['active', 1]]);
  assert.equal(await removeDomain(POOL, id, 'test'), 'removing');
  await t.admin.query(`DELETE FROM \`${t.name}\`.custom_domains WHERE id = ?`, [id]);
});

test('a domain that moves to another page (transfer) takes its primary address along – the old page never keeps it', async () => {
  // Live auf Leas Seite (4)
  const d = await domainIn('active', 'moving.example.com', 4, 7);
  assert.equal(await pageDomain(4), 'moving.example.com');
  // Übernahme in den Zustand verifying (wie das Design sie vorsieht): beide Seiten ohne Hauptadresse
  assert.equal(await transition(d, { state: 'verifying', set: { target_id: 3, user_id: 6 } }), true);
  assert.equal(await pageDomain(4), null);
  assert.equal(await pageDomain(3), null);
  // Wieder live – jetzt auf Toms Seite (3), nie auf der alten
  assert.equal(await transition(await fresh(d.id), { state: 'active' }), true);
  assert.equal(await pageDomain(3), 'moving.example.com');
  // Ziel wechseln, während die Domain live bleibt: die Hauptadresse wandert mit, die alte Seite leitet nicht weiter
  assert.equal(await transition(await fresh(d.id), { set: { target_id: 4, user_id: 7 } }), true);
  assert.equal(await pageDomain(3), null);
  assert.equal(await pageDomain(4), 'moving.example.com');
  assert.equal(await forwardingDomain((await one('SELECT * FROM pages WHERE id = 3'))!), null);
  // Ziel und Zustand zugleich: nur das neue Ziel zählt
  assert.equal(await transition(await fresh(d.id), { state: 'active', set: { target_id: 3, user_id: 6 } }), true);
  assert.equal(await pageDomain(4), null);
  assert.equal(await pageDomain(3), 'moving.example.com');
  const row = await fresh(d.id);
  assert.deepEqual([row.target_id, row.user_id, row.state], [3, 6, 'active']);
  assert.equal(await removeDomain(POOL, d.id, 'test'), 'deleted');
  assert.equal(await pageDomain(3), null);
});

test('hasDomain and hostnameForPage see a domain in every state (XD-02); removing it frees the page', async () => {
  for (const [i, state] of STATES.entries()) {
    const host = `s${i}.example.org`;
    const d = await domainIn(state, host, 3, 6, state === 'removing' ? 'cf-x' : null);
    assert.equal(d.state, state);
    assert.equal(await hasDomain(3), true, state);
    assert.equal(await hostnameForPage(3), host, state);
    assert.equal(await pageDomain(3), state === 'active' ? host : null, state);
    await t.admin.query(`DELETE FROM \`${t.name}\`.custom_domains WHERE id = ?`, [d.id]);
    await t.admin.query(`UPDATE \`${t.name}\`.pages SET custom_domain = NULL WHERE id = 3`);
  }
  assert.equal(await hasDomain(3), false);
  assert.equal(await hostnameForPage(3), null);
  assert.equal(await hasDomain(999999), false);
});

test('removing: without a Cloudflare hostname the row goes at once, otherwise the worker takes over; never twice', async () => {
  const db = POOL;
  const a = await domainIn('active', 'gone.example.com', 2, 5);
  assert.equal(await pageDomain(2), 'gone.example.com');
  assert.equal(await removeDomain(db, a.id, 'user'), 'deleted');
  assert.equal(await domainById(a.id), null);
  assert.equal(await pageDomain(2), null);
  assert.deepEqual((await logRows('gone.example.com')).map((r) => [r.event, r.detail]), [['added', ''], ['removed', 'user']]);

  const b = await domainIn('active', 'kept.example.com', 2, 5, 'cf-kept-1');
  assert.equal(await removeDomain(db, b.id, 'admin'), 'removing');
  const r = await fresh(b.id);
  assert.equal(r.state, 'removing');
  assert.equal(r.cf_id, 'cf-kept-1');
  assert.equal(await pageDomain(2), null);
  // Sofort fällig für den Dienst, der den Hostnamen löscht
  assert.ok((strtotime(String(r.next_check_at)) as number) <= time());
  assert.equal(await removeDomain(db, b.id, 'admin'), 'removing');
  assert.equal(await removeDomain(db, 999999, 'admin'), 'gone');
  assert.deepEqual((await logRows('kept.example.com')).map((x) => x.event), ['added', 'removed']);
  await t.admin.query(`DELETE FROM \`${t.name}\`.custom_domains WHERE id = ?`, [b.id]);
});

test('beforePageRemoved runs on the caller’s connection: a rolled-back page deletion keeps the domain live', async () => {
  const d = await domainIn('active', 'page.example.com', 4, 7, 'cf-page-1');
  await assert.rejects(transaction(async (_conn, db) => {
    await db.q('SELECT id FROM users WHERE id = 7 FOR UPDATE');
    await beforePageRemoved(4, db);
    assert.equal(await db.value('SELECT state FROM custom_domains WHERE id = ?', [d.id]), 'removing');
    throw new Error('refused after the checks');
  }), /refused after the checks/);
  assert.equal((await fresh(d.id)).state, 'active');
  assert.equal(await pageDomain(4), 'page.example.com');

  await transaction(async (_conn, db) => beforePageRemoved(4, db));
  assert.equal((await fresh(d.id)).state, 'removing');
  assert.equal(await pageDomain(4), null);
  // Eine Seite ohne Domain: nichts zu tun
  await transaction(async (_conn, db) => beforePageRemoved(1, db));
  await t.admin.query(`DELETE FROM \`${t.name}\`.custom_domains WHERE id = ?`, [d.id]);
});

test('deleting an account: the domains hook runs first, cancels pending mails and keeps no link to the person', async () => {
  assert.deepEqual(userDeletionHooks()[0], { name: 'domains', order: 10 });
  const live = await domainIn('active', 'mine.example.com', 4, 7, 'cf-mine-1');
  // Zweite Domain des Kontos auf einer Seite, die es nicht mehr gibt (darf das Löschen nicht aufhalten)
  const waiting = await domainIn('verifying', 'waiting.example.com', 1004, 7);
  const other = await domainIn('active', 'other.example.com', 2, 5, 'cf-other-1');
  const sql = (s: string, p: unknown[]) => t.admin.query(s.replace(/`DB`/g, '`' + t.name + '`'), p);
  await sql("INSERT INTO `DB`.custom_domain_log (domain_id, hostname, user_id, event, mail, created_at) VALUES (?, 'mine.example.com', 7, 'broken', 1, ?)", [live.id, date('Y-m-d H:i:s')]);
  await sql("INSERT INTO `DB`.custom_domain_log (domain_id, hostname, user_id, event, mail, mailed_at, created_at) VALUES (?, 'mine.example.com', 7, 'active', 1, ?, ?)", [live.id, date('Y-m-d H:i:s'), date('Y-m-d H:i:s')]);
  await sql("INSERT INTO `DB`.custom_domain_log (domain_id, hostname, user_id, event, mail, created_at) VALUES (?, 'other.example.com', 5, 'broken', 1, ?)", [other.id, date('Y-m-d H:i:s')]);

  // Ein späterer Haken schlägt fehl: alles bleibt, wie es war
  registerUserDeletion({ name: 'test-later-fails', order: 45, run: async () => { throw new Error('later hook failed'); } });
  const orig = console.error;
  console.error = () => undefined;
  try {
    const err = await deleteAccount(null, 7).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof AccountDeletionError && err.hook === 'test-later-fails');
  } finally {
    console.error = orig;
    unregisterUserDeletionForTests('test-later-fails');
  }
  assert.equal((await fresh(live.id)).state, 'active');
  assert.ok(await domainById(waiting.id));
  assert.equal(await pageDomain(4), 'mine.example.com');
  assert.equal(Number(await value("SELECT COUNT(*) FROM custom_domain_log WHERE user_id = 7 AND hostname = 'mine.example.com' AND mail = 1 AND mailed_at IS NULL")), 1);

  await deleteAccount(null, 7);
  assert.equal(await value('SELECT id FROM users WHERE id = 7'), null);
  // Mit Hostnamen: der Dienst löscht ihn noch; ohne: sofort weg
  const gone = await fresh(live.id);
  assert.equal(gone.state, 'removing');
  assert.equal(await domainById(waiting.id), null);
  // Verlauf: kein Konto mehr, offene Mails verworfen, verschickte bleiben verschickt
  const log = await q('SELECT user_id, event, detail, mail, mailed_at FROM custom_domain_log WHERE hostname IN (?, ?) ORDER BY id', ['mine.example.com', 'waiting.example.com']);
  assert.ok(log.length >= 5);
  assert.ok(log.every((r) => r.user_id === null), JSON.stringify(log));
  assert.ok(log.every((r) => r.mail === 0 || r.mailed_at !== null), JSON.stringify(log));
  assert.ok(log.some((r) => r.event === 'removed' && r.detail === 'account deleted'));
  assert.equal(Number(await value('SELECT COUNT(*) FROM custom_domain_log WHERE user_id = 7')), 0);
  assert.equal(Number(await value('SELECT COUNT(*) FROM custom_domain_log WHERE user_id IS NULL AND mail = 1 AND mailed_at IS NULL')), 0);
  // Andere Konten: unberührt
  assert.equal((await fresh(other.id)).state, 'active');
  assert.equal(await pageDomain(2), 'other.example.com');
  assert.equal(Number(await value('SELECT COUNT(*) FROM custom_domain_log WHERE user_id = 5 AND mail = 1')), 1);
  await t.admin.query(`DELETE FROM \`${t.name}\`.custom_domains WHERE id IN (?, ?)`, [live.id, other.id]);
  await t.admin.query(`UPDATE \`${t.name}\`.pages SET custom_domain = NULL WHERE id = 2`);
});

test('the names of the custom-domain setup can’t become page addresses', async () => {
  assert.equal(await slugProblem('edge'), 'The address “edge” is reserved or not allowed.');
  assert.equal(await slugProblem('origin'), 'The address “origin” is reserved or not allowed.');
  setConfigForTests({ ...loadConfig(), custom_domains: { cname_target: 'customers.oys.test', fallback_origin: 'fallback.oys.test' } });
  assert.equal(await slugProblem('customers'), 'The address “customers” is reserved.');
  assert.equal(await slugProblem('fallback'), 'The address “fallback” is reserved.');
  assert.equal(await slugProblem('customer'), null);
});

test('R2: a blocked domain keeps its hostname blocked when its page or account goes; only releaseBlock frees it', async () => {
  const blocks = await ddl('custom_domain_blocks');
  assert.match(blocks, /`hostname` varchar\(253\) CHARACTER SET ascii COLLATE ascii_bin NOT NULL/);
  assert.match(blocks, /PRIMARY KEY \(`hostname`\)/);
  await t.admin.query(`REPLACE INTO \`${t.name}\`.oys_meta (meta_key, meta_value) VALUES ('schema_version', ?)`, [String(V_DOMAIN_BLOCKS - 1)]);
  await ensureSchema();
  assert.equal(await ddl('custom_domain_blocks'), blocks);
  const now = date('Y-m-d H:i:s');
  for (const uid of [990, 991]) {
    await exec('INSERT INTO users (id, email, password, full_name, is_admin, created_at) VALUES (?, ?, \'x\', ?, 0, ?)', [uid, `r2-${uid}@test.de`, 'R2', now]);
  }
  const page = async (uid: number, slug: string): Promise<number> =>
    (await exec('INSERT INTO pages (user_id, slug, title, created_at) VALUES (?, ?, ?, ?)', [uid, slug, slug, now])).insertId;
  const a = await domainIn('blocked', 'gone-page.example.com', await page(990, 'r2-one'), 990);
  const b = await domainIn('blocked', 'gone-account.example.com', await page(990, 'r2-two'), 990, 'cf-r2');
  const c = await domainIn('blocked', 'still-on.example.com', await page(991, 'r2-three'), 991);
  // Seite gelöscht: die Zeile geht, die Sperre bleibt
  await transaction(async (_conn, db) => beforePageRemoved(a.target_id, db));
  assert.equal(await domainById(a.id), null);
  assert.equal(await hostnameBlocked('gone-page.example.com'), true);
  // Konto gelöscht, Hostname noch bei Cloudflare: removing für den Dienst, die Sperre bleibt
  await transaction(async (_conn, db) => removeUserDomains(db, 990));
  assert.equal((await fresh(b.id)).state, 'removing');
  assert.equal(await hostnameBlocked('gone-account.example.com'), true);
  assert.equal(await hostnameBlocked('free.example.com'), false);
  // Freigabe einer noch angehängten gesperrten Domain: wieder in der Prüfung, sofort fällig
  await exec("UPDATE custom_domains SET blocked_reason = 'spam' WHERE id = ?", [c.id]);
  assert.equal(await hostnameBlocked('still-on.example.com'), true);
  assert.equal(await releaseBlock('still-on.example.com'), true);
  const back = await fresh(c.id);
  assert.deepEqual([back.state, back.blocked_reason], ['verifying', null]);
  assert.ok(String(back.next_check_at) <= date('Y-m-d H:i:s'));
  assert.equal(await hostnameBlocked('still-on.example.com'), false);
  assert.deepEqual((await logRows('still-on.example.com')).map((l) => l.event).slice(-1), ['unblocked']);
  // Freigabe nach dem Entfernen: nur der Eintrag geht
  assert.equal(await releaseBlock('gone-page.example.com'), true);
  assert.equal(await hostnameBlocked('gone-page.example.com'), false);
  assert.equal(await releaseBlock('gone-page.example.com'), false);
  assert.equal(await releaseBlock('free.example.com'), false);
});
