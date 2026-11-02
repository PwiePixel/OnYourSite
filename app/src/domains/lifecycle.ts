// Eigene Domains und Premium: Abgleich je Konto (Enforcer für honeycomb-shop), was beim Ende von Premium wegfällt
// (Zeilen für Erinnerung und Hinweis des Shops), Gesundheit für status-pages und freie Plätze für den Shop.
// Nur Datenbank – kein Cloudflare, kein DNS: Hostnamen löscht der Domain-Dienst.
import { transaction, withNamedLock, type Db, type Row } from '../db.js';
import { intval, phpTruthy } from '../php.js';
import { toUnix, nowStr } from '../honeycombs/clock.js';
import { isPremiumRow } from '../honeycombs/premium.js';
import { quantity } from '../honeycombs/entitlements.js';
import { poolDb } from '../honeycombs/util.js';
import { domainsAvailable } from './config.js';
import { domainSettings, workerState, type DomainSettings } from './settings.js';
import { displayHostname } from './hostname.js';
import { transition, type DomainRow } from './store.js';
import { domainNotice, pageAddress } from './notify.js';

const DAY = 86400;
// Weiterleiten nach dem Ende von Premium nur, wenn die Domain mindestens die letzten 14 Tage live war (sonst blockierte
// kurzes Premium die freien Plätze bei Cloudflare)
export const FORWARD_MIN_LIVE_DAYS = 14;

// War die Domain beim Pausieren mindestens 14 Tage durchgehend live?
export function forwardEligible(row: { state: string; cf_id?: unknown; activated_at?: unknown }, now: number): boolean {
  if (row.state !== 'active' || row.cf_id === null || row.cf_id === undefined || row.cf_id === '') return false;
  const at = typeof row.activated_at === 'string' && row.activated_at !== '' ? toUnix(row.activated_at) : null;
  return at !== null && now - at >= FORWARD_MIN_LIVE_DAYS * DAY;
}

// Wie viele Domains darf das Konto gerade haben? Ohne Premium keine; Admins ohne Grenze; mit „slots“ zusätzlich die
// gekauften Domain-Plätze
async function allowance(user: Row | null, uid: number, s: DomainSettings, db: Db): Promise<number> {
  if (!user || !isPremiumRow(user)) return 0;
  if (phpTruthy(user.is_admin)) return Number.POSITIVE_INFINITY;
  return s.slots ? Math.min(s.per_user, await quantity(uid, 'custom_domain', db)) : s.per_user;
}

// Abgleich eines Kontos (registerEnforcer 'domains', inline): unter der eigenen Sperre je Konto die Domains lesen,
// dann das Konto, dann pausieren oder fortsetzen – jede Änderung ein Compare-and-set. Die ältesten Domains behalten
// ihren Platz; pausierte kommen nur zurück, solange Platz ist. Wiederholbar ohne Folgen: ein zweiter Lauf findet nichts.
export async function reconcileUser(uid: number): Promise<void> {
  await withNamedLock('oys_domains_u' + uid, 5, async (db) => {
    const rows = await db.q<DomainRow>(`SELECT * FROM custom_domains WHERE user_id = ? AND state IN ('verifying','pending','active','broken','suspended')
      ORDER BY created_at, id`, [uid]);
    if (!rows.length) return;
    const user = await db.one('SELECT id, is_admin, premium_until FROM users WHERE id = ?', [uid]);
    const s = await domainSettings(db);
    const premium = user !== null && isPremiumRow(user);
    let free = await allowance(user, uid, s, db);
    const now = Math.floor(Date.now() / 1000);
    // Premium ging ohne Änderung einer Berechtigung verloren (Admin-Rolle entzogen): dann meldet der Shop nichts
    const viaRole = !premium && (await db.one("SELECT id FROM hc_entitlements WHERE user_id = ? AND feature = 'premium' LIMIT 1", [uid])) === null;
    for (const row of rows.filter((r) => r.state !== 'suspended')) {
      if (free > 0) {
        free--;
        continue;
      }
      const forward = forwardEligible(row, now);
      const page = await db.one('SELECT * FROM pages WHERE id = ?', [intval(row.target_id)]);
      // Transaktion auf der Verbindung der Sperre (transaction() nimmt die laufende Verbindung)
      await transaction(async (_c, tx) => {
        const ok = await transition(row, {
          state: 'suspended',
          set: { problem: premium ? 'over_limit' : 'premium_ended', problem_detail: forward ? 'forward' : 'release', fail_count: 0, fail_since: null,
            fast_until: null, next_check_at: nowStr(now) },
          log: { event: 'suspended', detail: premium ? 'over the domain limit' : 'Premium ended' },
        }, tx);
        if (ok && viaRole) {
          const text = forward
            ? `You’re no longer an admin, so ${displayHostname(row.hostname)} forwards to ${pageAddress(page)}.`
            : `You’re no longer an admin, so ${displayHostname(row.hostname)} is disconnected until you have Premium again.`;
          await domainNotice(tx, row, 'domain_paused', text);
        }
      });
    }
    for (const row of rows.filter((r) => r.state === 'suspended')) {
      if (free <= 0) break;
      free--;
      const hasHost = row.cf_id !== null && row.cf_id !== '';
      await transaction((_c, tx) => transition(row, {
        state: hasHost ? 'pending' : 'verifying',
        set: { problem: '', problem_detail: '', fail_count: 0, fail_since: null, next_check_at: nowStr(now), fast_until: hasHost ? nowStr(now + 900) : null },
        log: { event: 'resumed', detail: hasHost ? 'Premium is back – reconnecting.' : 'Premium is back – checking the records.' },
      }, tx));
    }
  }, 'fail');
}

// Zeilen für „was beim Ende von Premium wegfällt“ (registerLossPreview('premium'))
export async function premiumLossPreview(uid: number, db: Db): Promise<string[]> {
  const rows = await db.q<DomainRow>(`SELECT d.*, p.slug, p.address_mode FROM custom_domains d JOIN pages p ON p.id = d.target_id
    WHERE d.user_id = ? AND d.target_type = 'page' AND d.state IN ('verifying','pending','active','broken') ORDER BY d.created_at, d.id`, [uid]);
  if (!rows.length) return [];
  const s = await domainSettings(db);
  const now = Math.floor(Date.now() / 1000);
  return rows.map((r) => {
    const host = displayHostname(r.hostname);
    return forwardEligible(r, now) && s.grace_days > 0
      ? `${host} will forward to ${pageAddress(r)} for ${s.grace_days} ${s.grace_days === 1 ? 'day' : 'days'}.`
      : `${host} will be disconnected.`;
  });
}

// ---------------------------------------------------------------- Gesundheit und freie Plätze

export interface DomainsHealth {
  configured: boolean; // vom Installer eingerichtet
  activeDomains: number;
  workerAt: string | null; // zuletzt gesehen
  workerOk: boolean; // in den letzten 3 Minuten gesehen
  probeOkAt: string | null; // letzte erfolgreiche Prüfung einer Kunden-Domain
  ok: boolean; // Dienst läuft und – wenn Domains live sind – die letzte gute Prüfung ist jünger als 20 Minuten
  frozen: boolean; // Schutzschalter offen
  reason: string;
}

// Für status-pages (Bestandteile „domains“ und „job:domains“) und den Admin: nur lesen, im Prozess
export async function domainsHealth(db: Db = poolDb, now = Math.floor(Date.now() / 1000)): Promise<DomainsHealth> {
  if (!domainsAvailable()) {
    return { configured: false, activeDomains: 0, workerAt: null, workerOk: false, probeOkAt: null, ok: false, frozen: false, reason: 'Custom domains aren’t set up.' };
  }
  const st = await workerState(db);
  const active = intval(await db.value("SELECT COUNT(*) FROM custom_domains WHERE state = 'active'"));
  const age = (v: string | null): number | null => (v ? now - toUnix(v) : null);
  const workerAge = age(st.worker_at);
  const workerOk = workerAge !== null && workerAge < 180;
  const probeAge = age(st.probe_ok_at);
  const probeOk = active === 0 || (probeAge !== null && probeAge < 1200);
  const reason = !workerOk ? (st.worker_at ? `The domain worker was last seen at ${st.worker_at}.` : 'The domain worker hasn’t run yet.')
    : !probeOk ? 'No custom domain answered through Cloudflare in the last 20 minutes.'
      : st.freeze ? `Checks are paused: ${st.freeze.detail}` : '';
  return { configured: true, activeDomains: active, workerAt: st.worker_at, workerOk, probeOkAt: st.probe_ok_at, ok: workerOk && probeOk, frozen: st.freeze !== null, reason };
}

export interface DomainsCapacity {
  available: boolean; // eingerichtet und neue Domains erlaubt
  full: boolean;
  free: number;
  waiting: number; // bestätigte Domains, die auf einen Platz warten
}

// Freie Plätze für Hostnamen (für die Premium-Karte des Shops und den Editor)
export async function domainsCapacity(db: Db = poolDb): Promise<DomainsCapacity> {
  const s = await domainSettings(db);
  const available = domainsAvailable() && s.enabled;
  const used = intval(await db.value('SELECT COUNT(*) FROM custom_domains WHERE cf_id IS NOT NULL'));
  const waiting = intval(await db.value("SELECT COUNT(*) FROM custom_domains WHERE state = 'verifying' AND problem = 'quota'"));
  let free = s.max_total - used;
  const q = (await workerState(db)).quota;
  if (q) free = Math.min(free, (s.allow_paid ? (q.hard_cap > 0 ? q.hard_cap : Number.POSITIVE_INFINITY) : q.allocated) - q.used);
  free = Math.max(0, Number.isFinite(free) ? free : s.max_total - used);
  return { available, full: free <= 0, free, waiting };
}
