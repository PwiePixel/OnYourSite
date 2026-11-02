// Eigene Domains: Datenbank. Zeilen lesen (jeder Lese-Aufruf nimmt die Verbindung des Aufrufers mit), neue Domains
// anlegen und Zustände wechseln. Jeder Wechsel ist ein Compare-and-set auf custom_domains.version und setzt die
// Hauptadresse des Ziels (pages.custom_domain) in derselben Transaktion: custom_domain = hostname ⇔ Zustand active.
// Sperrreihenfolge wie überall: users → pages (das Ziel) → custom_domains. Kein Netz: Cloudflare, DNS und die
// Prüfung über die Kante macht nur der Domain-Dienst.
import { exec, one, q, transaction, value, type Db, type Param, type Row } from '../db.js';
import { date, intval, mbSubstr, phpStr, time } from '../php.js';
import { liveDomain, type PageLike } from '../helpers.js';
import { domainTarget, type DomainTarget } from './targets.js';

export const DOMAIN_STATES = ['verifying', 'pending', 'active', 'broken', 'suspended', 'failed', 'blocked', 'removing'] as const;
export type DomainState = (typeof DOMAIN_STATES)[number];
// Bei Cloudflare eingerichtet und erreichbar: die Prüfstelle antwortet, die Seite (oder die Weiterleitung) erscheint
export const SERVING_STATES: ReadonlySet<string> = new Set(['pending', 'active', 'broken', 'suspended']);

export const LOG_EVENTS = ['added', 'txt_ok', 'waiting', 'cf_created', 'cf_adopted', 'cf_deleted', 'active', 'broken', 'recovered',
  'suspended', 'resumed', 'failed', 'blocked', 'unblocked', 'removed', 'transferred', 'redirect', 'check', 'api_error'] as const;
export type LogEvent = (typeof LOG_EVENTS)[number];

// Zeile aus custom_domains (Zahlen als Zahl, Zeiten als 'Y-m-d H:i:s' wie überall)
export interface DomainRow extends Row {
  id: number;
  hostname: string;
  target_type: string;
  target_id: number;
  user_id: number;
  state: DomainState;
  version: number;
  redirect: number;
}

// Kopf einer Zeile – genug für Compare-and-set, Hauptadresse und Verlauf
export type DomainRef = Pick<DomainRow, 'id' | 'hostname' | 'target_type' | 'target_id' | 'user_id' | 'state' | 'version'>;

// Ohne eigene Verbindung: einzelne Abfragen über den Pool (innerhalb eines Abschnitts dessen Verbindung)
const POOL: Db = { q, one, value, exec };
const use = (db?: Db): Db => db ?? POOL;

const asRow = (r: Row | null): DomainRow | null => (r ? (r as DomainRow) : null);

// ---------------------------------------------------------------- Lesen

// Zeile zum Host einer Anfrage (eindeutiger Schlüssel). Zustand und Ziel werden bei jeder Anfrage frisch gelesen –
// kein Zwischenspeicher für bekannte Hosts, damit mehrere Web-Prozesse nie Veraltetes ausliefern.
export async function domainByHost(host: string, db?: Db): Promise<DomainRow | null> {
  return asRow(await use(db).one('SELECT id, state, version, target_type, target_id, user_id, hostname, redirect FROM custom_domains WHERE hostname = ?', [host]));
}

export async function domainById(id: number, db?: Db): Promise<DomainRow | null> {
  return asRow(await use(db).one('SELECT * FROM custom_domains WHERE id = ?', [id]));
}

// Die Domain eines Ziels (in jedem Zustand) oder null
export async function domainForTarget(type: string, id: number, db?: Db): Promise<DomainRow | null> {
  return asRow(await use(db).one('SELECT * FROM custom_domains WHERE target_type = ? AND target_id = ?', [type, id]));
}

// Hat die Seite eine Domain – in irgendeinem Zustand? (code-slots-admin E7, unter deren Platz-Sperre)
export async function hasDomain(pageId: number, db?: Db): Promise<boolean> {
  return (await use(db).one("SELECT id FROM custom_domains WHERE target_type = 'page' AND target_id = ? LIMIT 1", [pageId])) !== null;
}

// Hostname der Domain einer Seite in jedem Zustand, oder null (Termin-Block: interner Kalender)
export async function hostnameForPage(pageId: number, db?: Db): Promise<string | null> {
  const v = await use(db).value("SELECT hostname FROM custom_domains WHERE target_type = 'page' AND target_id = ? LIMIT 1", [pageId]);
  return v === null || v === undefined ? null : phpStr(v);
}

// Live-Domain einer Seite, auf die ihre OnYourSite-Adressen weiterleiten (Schalter „Forward my OnYourSite addresses“),
// sonst null. Fragt nur bei Seiten mit Live-Domain (pages.custom_domain, bei eingerichteten eigenen Domains) – alle
// anderen kostet das nichts.
export async function forwardingDomain(page: Row, db?: Db): Promise<string | null> {
  const host = liveDomain(page as unknown as PageLike);
  if (host === '') return null;
  const r = await use(db).one("SELECT redirect FROM custom_domains WHERE hostname = ? AND target_type = 'page' AND target_id = ? AND state = 'active'",
    [host, intval(page.id)]);
  return r !== null && intval(r.redirect) === 1 ? host : null;
}

// ---------------------------------------------------------------- Unbekannte Hosts (je Prozess, 10 s)

// Anfragen an Namen ohne Zeile (Unsinn über die Sammelregel des Tunnels) kosten so höchstens eine Abfrage je 10 s.
// Bekannte Hosts werden nie zwischengespeichert.
const UNKNOWN_TTL_MS = 10_000;
const UNKNOWN_MAX = 5000;
const unknownHosts = new Map<string, number>();
// Nur Zeichen, die ein gespeicherter Hostname haben kann (klein, ASCII) – alles andere ohne Abfrage
const HOST_CHARS = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

export async function lookupHost(host: string): Promise<DomainRow | null> {
  if (!HOST_CHARS.test(host)) return null;
  const now = Date.now();
  const until = unknownHosts.get(host);
  if (until !== undefined) {
    if (until > now) return null;
    unknownHosts.delete(host);
  }
  const row = await domainByHost(host);
  if (!row) {
    if (unknownHosts.size >= UNKNOWN_MAX) unknownHosts.clear();
    unknownHosts.set(host, now + UNKNOWN_TTL_MS);
  }
  return row;
}

// Neue Domain in diesem Prozess sofort erkennen (andere Prozesse spätestens nach 10 s)
export function forgetUnknownHost(host: string): void {
  unknownHosts.delete(host);
}

export function clearUnknownHostsForTests(): void {
  unknownHosts.clear();
}

// ---------------------------------------------------------------- Schreiben

// Spalten, die Aufrufer über DomainChange.set ändern dürfen (Namen nur aus dem Code, trotzdem geprüft)
const SETTABLE = new Set(['is_apex', 'zone_name', 'redirect', 'cf_id', 'cf_status', 'cf_ssl_status', 'cf_created_at', 'problem', 'problem_detail',
  'fail_count', 'fail_since', 'dns_unknown_count', 'dns_unknown_since', 'checked_at', 'next_check_at', 'fast_until', 'manual_at', 'patched_at',
  'verified_at', 'notice_state', 'notice_at', 'blocked_reason', 'cert_expires_at', 'target_type', 'target_id', 'user_id']);

export interface DomainChange {
  // Neuer Zustand: setzt state_at; active setzt den Beginn der Live-Phase, suspended den Beginn der Pause
  state?: DomainState;
  set?: Record<string, Param>;
  log?: { event: LogEvent; detail?: string; mail?: boolean; cfId?: string | null };
}

export interface NewDomain {
  hostname: string;
  targetType?: string;
  targetId: number;
  userId: number;
  isApex?: boolean;
  zoneName?: string | null;
}

// Eintrag im Verlauf (zugleich Mail-Warteschlange des Domain-Dienstes und Liste der angelegten Cloudflare-IDs)
export async function logEvent(db: Db, d: { id: number | null; hostname: string; user_id: number | null }, event: LogEvent, detail = '',
  opts: { mail?: boolean; cfId?: string | null } = {}): Promise<void> {
  await db.exec('INSERT INTO custom_domain_log (domain_id, hostname, user_id, event, detail, cf_id, mail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [d.id, d.hostname, d.user_id, event, mbSubstr(detail, 0, 255), opts.cfId ?? null, opts.mail ? 1 : 0, date('Y-m-d H:i:s')]);
}

// Neue Domain im Zustand verifying (erste automatische Prüfung nach 10 Minuten), Verlauf „added“. Die Regeln
// (Premium, Grenzen, Übernahme, Platz-Sperre) prüft der Aufrufer. Gibt die ID zurück.
export async function createDomain(d: NewDomain, db?: Db): Promise<number> {
  const run = async (x: Db): Promise<number> => {
    const t = time();
    const now = date('Y-m-d H:i:s', t);
    const { insertId } = await x.exec(
      `INSERT INTO custom_domains (hostname, target_type, target_id, user_id, state, version, state_at, is_apex, zone_name, next_check_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'verifying', 0, ?, ?, ?, ?, ?, ?)`,
      [d.hostname, d.targetType ?? 'page', d.targetId, d.userId, now, d.isApex ? 1 : 0, d.zoneName ?? null, date('Y-m-d H:i:s', t + 600), now, now]);
    await logEvent(x, { id: insertId, hostname: d.hostname, user_id: d.userId }, 'added');
    return insertId;
  };
  const id = db ? await run(db) : await transaction((_conn, x) => run(x));
  forgetUnknownHost(d.hostname);
  return id;
}

// Compare-and-set: true = geschrieben, false = die Zeile hat sich inzwischen geändert oder ist weg (der Aufrufer liest
// neu). Mit db auf dessen Verbindung (dessen Transaktion), sonst in einer eigenen Transaktion.
// Wechselt das Ziel (Übernahme durch ein anderes Konto: target_type/target_id in set), wandert die Hauptadresse mit:
// das alte Ziel verliert sie immer, das neue hat sie genau dann, wenn die Zeile danach live ist.
export async function transition(row: DomainRef, change: DomainChange, db?: Db): Promise<boolean> {
  const run = async (x: Db): Promise<boolean> => {
    const target = domainTarget(row.target_type);
    const set = change.set ?? {};
    const nextType = set.target_type !== undefined && set.target_type !== null ? phpStr(set.target_type) : row.target_type;
    const nextId = set.target_id !== undefined && set.target_id !== null ? intval(set.target_id) : intval(row.target_id);
    const moved = nextType !== row.target_type || nextId !== intval(row.target_id);
    const nextTarget = moved ? domainTarget(nextType) : target;
    // Ziele vor der Domain sperren; zwei Ziele in fester Reihenfolge (Art, dann ID), damit zwei Übernahmen in
    // Gegenrichtung nicht aufeinander warten
    const locks: Array<[DomainTarget | null, string, number]> = [[target, row.target_type, intval(row.target_id)]];
    if (moved) locks.push([nextTarget, nextType, nextId]);
    locks.sort((a, b) => (a[1] === b[1] ? a[2] - b[2] : a[1] < b[1] ? -1 : 1));
    for (const [t, , id] of locks) if (t) await t.lock(x, id);
    const now = date('Y-m-d H:i:s');
    const sets = ['version = version + 1', 'updated_at = ?'];
    const params: Param[] = [now];
    if (change.state !== undefined) {
      if (!(DOMAIN_STATES as readonly string[]).includes(change.state)) throw new Error(`unknown custom domain state: ${change.state}`);
      sets.push('state = ?', 'state_at = ?');
      params.push(change.state, now);
      if (change.state === 'active' && row.state !== 'active') {
        sets.push('activated_at = ?');
        params.push(now);
      }
      if (change.state === 'suspended' && row.state !== 'suspended') {
        sets.push('suspended_at = ?');
        params.push(now);
      }
    }
    for (const [col, v] of Object.entries(change.set ?? {})) {
      if (!SETTABLE.has(col)) throw new Error(`custom_domains.${col} can't be changed here`);
      sets.push(`${col} = ?`);
      params.push(v);
    }
    const res = await x.exec(`UPDATE custom_domains SET ${sets.join(', ')} WHERE id = ? AND version = ?`, [...params, row.id, row.version]);
    if (res.affectedRows === 0) return false;
    // Hauptadresse folgt dem Zustand – auch beim Wechsel zwischen zwei anderen Zuständen (heilt Abweichungen)
    const live = (change.state ?? row.state) === 'active';
    if (moved) {
      if (target) await target.setPrimary(x, intval(row.target_id), null);
      if (nextTarget) await nextTarget.setPrimary(x, nextId, live ? row.hostname : null);
    } else if (change.state !== undefined && target) {
      await target.setPrimary(x, intval(row.target_id), live ? row.hostname : null);
    }
    if (change.log) {
      await logEvent(x, { id: row.id, hostname: row.hostname, user_id: row.user_id }, change.log.event, change.log.detail ?? '',
        { mail: change.log.mail, cfId: change.log.cfId });
    }
    return true;
  };
  return db ? run(db) : transaction((_conn, x) => run(x));
}

// Domain entfernen (Nutzer, Admin, Seite oder Konto gelöscht): die Hauptadresse ist sofort weg. Ohne Hostnamen bei
// Cloudflare wird die Zeile gleich gelöscht, sonst übernimmt der Domain-Dienst (removing → Hostname löschen → Zeile
// löschen). Keine Weiterleitung danach. Nur Datenbank, auf der Verbindung des Aufrufers (dessen Transaktion und Sperren);
// blockiert nie: eine Zeile, die sich gerade ändert, wird neu gelesen.
export async function removeDomain(db: Db, id: number, detail: string): Promise<'deleted' | 'removing' | 'gone'> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const peek = await domainById(id, db);
    if (!peek) return 'gone';
    const target = domainTarget(peek.target_type);
    if (target) await target.lock(db, peek.target_id);
    const row = asRow(await db.one('SELECT * FROM custom_domains WHERE id = ? FOR UPDATE', [id]));
    if (!row) return 'gone';
    // Inzwischen an ein anderes Ziel gegangen (Übernahme): dessen Sperre fehlt – neu beginnen
    if (row.target_type !== peek.target_type || intval(row.target_id) !== intval(peek.target_id)) continue;
    if (row.cf_id === null || row.cf_id === undefined) {
      const res = await db.exec('DELETE FROM custom_domains WHERE id = ? AND version = ?', [id, row.version]);
      if (res.affectedRows === 0) continue;
      if (target) await target.setPrimary(db, row.target_id, null);
      await logEvent(db, row, 'removed', detail);
      return 'deleted';
    }
    if (row.state === 'removing') {
      if (target) await target.setPrimary(db, row.target_id, null);
      return 'removing';
    }
    // Der Dienst löscht den Hostnamen bei der nächsten Runde (sofort fällig) und danach die Zeile
    const ok = await transition(row, { state: 'removing', set: { next_check_at: date('Y-m-d H:i:s'), fast_until: null, manual_at: null },
      log: { event: 'removed', detail } }, db);
    if (ok) return 'removing';
  }
  throw new Error(`custom domain #${id} kept changing while it was being removed`);
}

// Vor dem Löschen einer Seite (code-slots-admin: page-delete in der Transaktion unter der Platz-Sperre, nach den
// letzten Prüfungen): wie „Entfernen“. Nur Datenbank – blockiert das Löschen nie.
export async function beforePageRemoved(pageId: number, db: Db): Promise<void> {
  for (const r of await db.q("SELECT id FROM custom_domains WHERE target_type = 'page' AND target_id = ?", [pageId])) {
    await removeDomain(db, intval(r.id), 'page deleted');
  }
}

// Konto löschen (Haken „domains“, Reihenfolge 10): jede Domain wie „Entfernen“, offene Mails verworfen, der Verlauf
// behält den Domainnamen (bis 90 Tage), aber nicht mehr das Konto
export async function removeUserDomains(db: Db, uid: number): Promise<void> {
  for (const r of await db.q('SELECT id FROM custom_domains WHERE user_id = ? ORDER BY id', [uid])) {
    await removeDomain(db, intval(r.id), 'account deleted');
  }
  await db.exec('UPDATE custom_domain_log SET mail = 0 WHERE user_id = ? AND mail = 1 AND mailed_at IS NULL', [uid]);
  await db.exec('UPDATE custom_domain_log SET user_id = NULL WHERE user_id = ?', [uid]);
}
