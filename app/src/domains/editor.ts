// Eigene Domains im Editor (PD-4): /dashboard/api/domain, domain-add, domain-check, domain-remove, domain-settings.
// Die Vorrede der Editor-API gilt (angemeldet, CSRF bei POST, JSON, page_id gehört dem Konto). Keine dieser Routen ruft
// Cloudflare oder prüft über die Kante – das macht nur der Domain-Dienst. Einzige Netzarbeit im Web-Prozess: eine
// DoH-TXT-Abfrage für „I’ve added it“ (claim), ohne gehaltene Datenbankverbindung, höchstens 2 gleichzeitig, 4 s.
import type { Ctx } from '../web/ctx.js';
import { one, q, transaction, value, type Db, type Row } from '../db.js';
import { date, intval, phpStr, phpTruthy, strtotime, time } from '../php.js';
import { own, type PhpArr } from '../content/util.js';
import { rateLimit } from '../web/security.js';
import { baseHost } from '../helpers.js';
import { isShownLinkPage } from '../content/pages.js';
import { premiumState } from '../honeycombs/premium.js';
import { quantity } from '../honeycombs/entitlements.js';
import { SlotBusyError, withSlotLock } from '../code/slots.js';
import { cnameTarget, domainsAvailable } from './config.js';
import { displayHostname, looksLikeApex, normalizeHostname, recordHosts, relativeName, guessZone, TXT_PREFIX } from './hostname.js';
import { createDomain, domainForTarget, hostnameBlocked, logEvent, removeDomain, transition, type DomainRow } from './store.js';
import { domainTarget } from './targets.js';
import { domainSettings, workerState, type DomainSettings } from './settings.js';
import { ownershipToken } from './tokens.js';
import { decodeExtraRecords } from './records.js';
import { domainsCapacity } from './lifecycle.js';
import { Doh, dohFromConfig, txtView, type TxtView } from './worker/dns.js';
import { NOTICE_TITLES, domainLink, noticeText } from './notify.js';
import { notify } from '../notify/notify.js';
import { pausePoint } from '../honeycombs/ledger.js';
import { adminMode } from '../honeycombs/shop.js';

export const DOMAIN_ACTIONS: ReadonlySet<string> = new Set(['domain', 'domain-add', 'domain-check', 'domain-remove', 'domain-settings']);
export const isDomainAction = (action: string): boolean => DOMAIN_ACTIONS.has(action);

// Grenzen (Entwurf 4.5.2)
export const ADD_RATE = { max: 10, windowSec: 86400 };
export const CHECK_RATE = { max: 60, windowSec: 3600 };
export const CHECK_COOLDOWN_SEC = 30;
export const FAST_MINUTES = 15;
const PREMIUM_MIN_DAYS = 7;

type Step = 'done' | 'waiting' | 'problem' | 'unchecked';
export interface DnsRecordView {
  type: 'TXT' | 'CNAME'; host: string; name: string; value: string;
  status: 'ok' | 'missing' | 'wrong' | 'unknown' | 'unchecked'; found: string; note: string;
}
export interface DomainView {
  hostname: string; display: string; state: string; primary: boolean; redirect: boolean; url: string; apex: boolean;
  steps: { ownership: Step; dns: Step; https: Step };
  records: DnsRecordView[]; extra: DnsRecordView[];
  problem: string; message: string; checking: boolean; checkedAt: string | null; fastUntil: string | null;
  waiting: number | null; graceUntil: string | null; blockedReason: string;
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : phpStr(v));
// Zeitpunkt in Sekunden (ungültig → 0)
const ts = (v: string): number => {
  const t = strtotime(v);
  return t === false ? 0 : t;
};
const when = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const DNS_PROBLEMS = new Set(['cname_missing', 'cname_wrong', 'cname_proxied', 'a_records', 'apex_ips', 'dns_error']);

// Fertiger englischer Text zum Zustand (Tabelle 2.4)
export function domainMessage(row: Row, target: string, settings: Pick<DomainSettings, 'grace_days'>): string {
  const host = displayHostname(str(row.hostname));
  const state = str(row.state);
  const problem = str(row.problem);
  if (state === 'active') return '';
  if (state === 'removing') return 'This domain is being removed.';
  if (state === 'blocked') return 'This domain was disabled by the team.' + (str(row.blocked_reason) ? ' Reason: ' + str(row.blocked_reason) : '');
  if (state === 'suspended') return 'Your Premium has ended, so this domain is paused. Renew Premium to switch it back on.';
  if (state === 'failed') return 'We couldn’t confirm your domain within 7 days. Check the records and select Check again.';
  switch (problem) {
    case 'txt_missing': return 'We can’t see the TXT record yet. DNS changes usually show up within minutes, sometimes up to an hour.';
    case 'txt_wrong': return 'The TXT record has a different value. Please copy the value again.';
    case 'cname_missing': return `The CNAME record for ${host} is missing.`;
    case 'cname_wrong': return `${host} points somewhere else – it should point to ${target}.`;
    case 'a_records': case 'apex_ips': return `${host} points to an IP address. Replace that record with the CNAME above.`;
    case 'cname_proxied': return `${host} is proxied by Cloudflare (orange cloud) or flattened. Use a plain CNAME set to “DNS only” (grey cloud).`;
    case 'dns_error': return 'Your domain’s DNS answers with an error (SERVFAIL) – often a DNSSEC problem at your provider.';
    case 'caa': return 'A CAA record on your domain blocks the certificate. Allow letsencrypt.org, pki.goog and ssl.com, or remove the CAA record.';
    case 'ssl_pending': case 'cf_pending': return 'Your domain points to us. The HTTPS certificate is being issued – this usually takes a few minutes.';
    case 'quota': return 'Custom domains are fully booked right now. Yours is next in line – we connect it as soon as a place is free.';
    case 'waiting_own': return 'We’ll set this one up as soon as your other domain is live.';
    case 'probe_failed': case 'broken_timeout': return `${host} doesn’t reach your page right now. Check the records below.`;
    case 'setup_timeout': case 'verify_timeout': return 'The setup took too long. Check the records and select Check now.';
    case 'cert_expiring': return 'The HTTPS certificate could not be renewed yet. Keep the CNAME record in place.';
    default: break;
  }
  if (state === 'pending') return 'Your domain points to us. The HTTPS certificate is being issued – this usually takes a few minutes.';
  if (state === 'broken') return `${host} doesn’t reach your page right now. Check the records below.`;
  return row.checked_at ? 'Waiting for your DNS records.' : 'Add the two records below, then select Check now.';
}

function steps(row: Row): DomainView['steps'] {
  const state = str(row.state);
  const problem = str(row.problem);
  const checked = row.checked_at !== null && row.checked_at !== undefined;
  const ownership: Step = row.verified_at || ['pending', 'active', 'broken', 'suspended'].includes(state) ? 'done'
    : problem === 'txt_missing' || problem === 'txt_wrong' || state === 'failed' ? 'problem' : checked ? 'waiting' : 'unchecked';
  const serving = ['pending', 'active', 'broken'].includes(state);
  const dns: Step = DNS_PROBLEMS.has(problem) ? 'problem' : state === 'active' || (serving && problem !== 'probe_failed') ? 'done'
    : ownership === 'done' ? 'waiting' : 'unchecked';
  const https: Step = state === 'active' || str(row.cf_ssl_status) === 'active' ? 'done' : problem === 'caa' ? 'problem'
    : serving ? 'waiting' : 'unchecked';
  return { ownership, dns, https };
}

// Ansicht einer Zeile für den Editor (nur Lesen)
export async function domainView(row: DomainRow, opts: { settings?: DomainSettings; db?: Db } = {}): Promise<DomainView> {
  const s = opts.settings ?? (await domainSettings());
  const target = cnameTarget();
  const ascii = str(row.hostname);
  const zone = str(row.zone_name) || guessZone(ascii);
  const hosts = recordHosts(ascii, zone);
  const st = steps(row);
  const apex = intval(row.is_apex) === 1;
  const problem = str(row.problem);
  const txtStatus: DnsRecordView['status'] = st.ownership === 'done' ? 'ok' : problem === 'txt_missing' ? 'missing' : problem === 'txt_wrong' ? 'wrong' : 'unchecked';
  const cnameStatus: DnsRecordView['status'] = st.dns === 'done' ? 'ok' : problem === 'cname_missing' ? 'missing'
    : DNS_PROBLEMS.has(problem) ? (problem === 'dns_error' ? 'unknown' : 'wrong') : 'unchecked';
  const records: DnsRecordView[] = [
    { type: 'TXT', host: hosts.txt, name: TXT_PREFIX + ascii, value: ownershipToken(intval(row.user_id), ascii), status: txtStatus, found: '', note: '' },
    { type: 'CNAME', host: hosts.cname, name: ascii, value: target, status: cnameStatus, found: '',
      note: apex ? 'For a root domain, use your provider’s CNAME flattening or ALIAS record.' : '' },
  ];
  const state = str(row.state);
  const extra = apex || state === 'pending' || state === 'broken'
    ? decodeExtraRecords(row.extra_records).map((r): DnsRecordView => ({ type: r.type, host: relativeName(r.name, zone), name: r.name, value: r.value, status: 'unchecked', found: '', note: '' }))
    : [];
  const manual = when(row.manual_at);
  const checkedAt = when(row.checked_at);
  let waiting: number | null = null;
  if (problem === 'quota') {
    waiting = 1 + intval(await (opts.db ?? { value }).value(
      "SELECT COUNT(*) FROM custom_domains WHERE state = 'verifying' AND problem = 'quota' AND (verified_at < ? OR (verified_at = ? AND id < ?))",
      [str(row.verified_at), str(row.verified_at), row.id]));
  }
  const suspendedAt = when(row.suspended_at);
  return {
    hostname: ascii, display: displayHostname(ascii), state, primary: state === 'active', redirect: intval(row.redirect) === 1,
    url: 'https://' + ascii, apex, steps: st, records, extra, problem, message: domainMessage(row, target, s),
    checking: manual !== null && (checkedAt === null || checkedAt < manual) && state !== 'removing',
    checkedAt, fastUntil: when(row.fast_until), waiting,
    graceUntil: state === 'suspended' && suspendedAt ? date('Y-m-d H:i:s', ts(suspendedAt) + s.grace_days * 86400) : null,
    blockedReason: state === 'blocked' ? str(row.blocked_reason) : '',
  };
}

// ---------------------------------------------------------------- DoH für „I’ve added it“

let dohOverride: Doh | null = null;
let dohBusy = 0;
export function setDohForTests(d: Doh | null): void {
  dohOverride = d;
}
async function lookupTxt(name: string, token: string): Promise<TxtView | null> {
  if (dohBusy >= 2) return null;
  dohBusy++;
  try {
    const doh = dohOverride ?? new Doh(dohFromConfig().endpoints, undefined, 4000);
    return txtView(await doh.query(name, 'TXT'), name, token);
  } finally {
    dohBusy--;
  }
}

// ---------------------------------------------------------------- Routen

const NOT_AVAILABLE = { ok: false, error: 'Custom domains aren’t available right now.' };
const NO_DOMAIN = { ok: false, error: 'This page has no custom domain.' };
const TRY_AGAIN = { ok: false, error: 'Please try again.' };
const LINK_ONLY = { ok: false, error: 'Custom domains work for link pages only.' };
// Vom Team gesperrt (R2): für jedes Konto, auch das bisherige, bis ein Admin den Hostnamen freigibt
export const BLOCKED = { ok: false, error: 'This domain was disabled by the OnYourSite team and can’t be connected. Please contact support.' };

function premiumEnds(until: string): string {
  return date('M j', ts(until));
}

interface AddOutcome { status: number; body: Record<string, unknown> }

export async function domainEditorApi(ctx: Ctx, user: Row, action: string, isPost: boolean, input: PhpArr, page: Row | null, staff: boolean): Promise<never> {
  const uid = intval(user.id);
  if (action !== 'domain' && !isPost) ctx.json({ ok: false, error: 'Not found.' }, 404);
  if (!domainsAvailable()) {
    if (action === 'domain') ctx.json({ ok: true, available: false, enabled: false, domain: null });
    ctx.json(NOT_AVAILABLE, 404);
  }
  if (!page || intval(page.user_id) !== uid) ctx.json({ ok: false, error: 'Please reload the editor.', reload: true }, 409);
  const pageId = intval(page.id);
  // R8: ein Admin, der als dieser Nutzer arbeitet, sieht die Domain, ändert aber nichts (wie beim Kaufen)
  const asAdmin = adminMode(ctx);
  if (isPost && asAdmin) ctx.json({ ok: false, code: 'admin_mode', error: 'Custom domains can’t be changed in admin mode.' }, 403);
  const s = await domainSettings();
  const row = await domainForTarget('page', pageId);
  const inp = (k: string): unknown => own(input, k);

  if (action === 'domain') {
    const prem = await premiumState(uid);
    const used = intval(await value("SELECT COUNT(*) FROM custom_domains WHERE user_id = ? AND state <> 'removing'", [uid]));
    const ws = await workerState();
    const workerAge = ws.worker_at ? time() - ts(ws.worker_at) : null;
    const cap = await domainsCapacity();
    ctx.json({
      ok: true, available: true, enabled: s.enabled, adminMode: asAdmin,
      premium: { active: prem.active, until: prem.until, forever: prem.forever },
      target: cnameTarget(), linkPage: isShownLinkPage(page),
      limits: { perUser: staff ? null : s.per_user, used, slots: s.slots ? await quantity(uid, 'custom_domain') : null },
      capacity: { full: cap.full, waiting: cap.waiting },
      delayed: row !== null && (workerAge === null || workerAge > 300),
      domain: row ? await domainView(row, { settings: s }) : null,
    });
  }

  if (action === 'domain-check') {
    if (!row) ctx.json(NO_DOMAIN, 404);
    if (!(await rateLimit('domain-check-user:' + uid, CHECK_RATE.max, CHECK_RATE.windowSec))) {
      ctx.json({ ok: false, error: 'Please wait a moment before checking again.' }, 429);
    }
    if (row.state === 'removing' || row.state === 'blocked') ctx.json({ ok: true, domain: await domainView(row, { settings: s }) });
    const manual = when(row.manual_at);
    if (manual && time() - ts(manual) < CHECK_COOLDOWN_SEC) {
      ctx.json({ ok: true, cooldown: true, domain: await domainView(row, { settings: s }) });
    }
    const res = await transaction((_c, db) => db.exec(
      `UPDATE custom_domains SET manual_at = NOW(), next_check_at = NOW(), fast_until = NOW() + INTERVAL ${FAST_MINUTES} MINUTE, version = version + 1, updated_at = NOW()
       WHERE id = ? AND version = ?`, [row.id, row.version]));
    if (res.affectedRows === 0) ctx.json(TRY_AGAIN, 409);
    const fresh = await domainForTarget('page', pageId);
    if (!fresh) ctx.json(NO_DOMAIN, 404);
    ctx.json({ ok: true, domain: await domainView(fresh, { settings: s }) });
  }

  if (action === 'domain-remove') {
    if (!row) ctx.json(NO_DOMAIN, 404);
    const typed = str(inp('confirm')).trim().toLowerCase().replace(/\.$/, '');
    const ascii = str(row.hostname);
    if (typed === '' || (typed !== ascii && typed !== displayHostname(ascii).toLowerCase())) {
      ctx.json({ ok: false, error: 'To confirm, please type the domain.' }, 400);
    }
    const view = await domainView(row, { settings: s });
    await pausePoint('domain-remove', { uid, pageId });
    // Unter der Sperre der Seite (Reihenfolge pages → custom_domains wie überall) muss die gelesene Zeile noch zu
    // dieser Seite und diesem Konto gehören. Hat inzwischen ein anderes Konto die Domain mit seinem TXT-Nachweis
    // übernommen, ist sie dessen Domain – removeDomain() allein würde ihr zum neuen Ziel folgen und sie entfernen.
    const removed = await transaction(async (_c, db) => {
      if (!(await db.one('SELECT id FROM pages WHERE id = ? AND user_id = ? FOR UPDATE', [pageId, uid]))) return false;
      await pausePoint('domain-remove-locked', { uid, pageId });
      const still = await db.one("SELECT id FROM custom_domains WHERE id = ? AND target_type = 'page' AND target_id = ? AND user_id = ? FOR UPDATE",
        [row.id, pageId, uid]);
      if (!still) return false;
      await removeDomain(db, intval(row.id), 'user');
      return true;
    });
    if (!removed) ctx.json(NO_DOMAIN, 404);
    ctx.json({ ok: true, records: view.records });
  }

  if (action === 'domain-settings') {
    if (!row) ctx.json(NO_DOMAIN, 404);
    const redirect = phpTruthy(inp('redirect')) ? 1 : 0;
    const ok = await transaction(async (_c, db) => {
      const res = await db.exec('UPDATE custom_domains SET redirect = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?',
        [redirect, date('Y-m-d H:i:s'), row.id, row.version]);
      if (res.affectedRows === 0) return false;
      await logEvent(db, row, 'redirect', redirect ? 'on' : 'off');
      return true;
    });
    if (!ok) ctx.json(TRY_AGAIN, 409);
    const fresh = await domainForTarget('page', pageId);
    ctx.json({ ok: true, domain: fresh ? await domainView(fresh, { settings: s }) : null });
  }

  // ---- domain-add
  // 1. eingerichtet und eingeschaltet
  if (!s.enabled) ctx.json(NOT_AVAILABLE, 404);
  // 2. nur Link-Seiten
  if (!isShownLinkPage(page)) ctx.json(LINK_ONLY, 409);
  // 3. Premium (Admins zählen als Premium)
  const prem = await premiumState(uid);
  if (!prem.active) ctx.json({ ok: false, premium: false, error: 'Custom domains are part of Premium.' }, 403);
  // 4. mindestens 7 Tage Premium übrig (oder für immer / Admin)
  if (!prem.forever && prem.until && ts(prem.until) - time() < PREMIUM_MIN_DAYS * 86400) {
    ctx.json({ ok: false, error: `Your Premium ends on ${premiumEnds(prem.until)}. Extend it to connect a domain.` }, 403);
  }
  // 5. Mindestalter des Kontos (nicht fürs Team und nicht für geschenktes Premium)
  if (!staff && prem.source !== 'admin' && prem.source !== 'admin-role' && s.min_account_days > 0) {
    const created = str(user.created_at);
    if (created !== '' && time() - ts(created) < s.min_account_days * 86400) {
      ctx.json({ ok: false, error: `Custom domains are available once your account is ${s.min_account_days} days old.` }, 403);
    }
  }
  // 6. Ratenlimit
  if (!(await rateLimit('domain-add:' + uid, ADD_RATE.max, ADD_RATE.windowSec))) {
    ctx.json({ ok: false, error: 'You’ve added too many domains today. Please try again tomorrow.' }, 429);
  }
  // 7. Hostname
  const norm = normalizeHostname(inp('hostname'), baseHost());
  if (!norm.ok) ctx.json({ ok: false, error: norm.error }, 400);
  const ascii = norm.ascii;
  // 7a. Vom Team gesperrt (R2): auch nach „Entfernen“, für jedes Konto, auch mit TXT-Nachweis – bis ein Admin freigibt
  if (await hostnameBlocked(ascii)) ctx.json(BLOCKED, 409);
  // 8. Wurzeldomain? Erst nachfragen
  const apex = looksLikeApex(ascii);
  if (apex && !phpTruthy(inp('apex_ok'))) {
    ctx.json({
      ok: false, confirm: 'apex', suggest: 'www.' + ascii,
      error: `${norm.unicode} is a root domain. Many providers can’t point a root domain to another server. Use www.${norm.unicode} instead, or continue if your provider supports CNAME flattening or ALIAS records.`,
    });
  }
  // 9. Gehört der Hostname einem anderen Konto? (vor jeder Transaktion; Zustand des anderen Kontos bleibt verborgen)
  const existing = (await one('SELECT * FROM custom_domains WHERE hostname = ?', [ascii])) as DomainRow | null;
  const token = ownershipToken(uid, ascii);
  const hosts = recordHosts(ascii, guessZone(ascii));
  const challenge = { type: 'TXT', host: hosts.txt, name: TXT_PREFIX + ascii, value: token };
  const CHALLENGE = { ok: false, challenge, error: 'This domain is connected to or waiting in another account. To use it here, add this TXT record to prove it’s yours, then select “I’ve added it”.' };
  let claimVersion: number | null = null;
  if (existing && intval(existing.user_id) !== uid) {
    if (existing.state === 'blocked') ctx.json(BLOCKED, 409);
    if (existing.state === 'removing') ctx.json({ ok: false, error: 'This domain is being disconnected from another page. Please try again in a few minutes.' }, 409);
    if (!phpTruthy(inp('claim'))) ctx.json(CHALLENGE, 409);
    const txt = await lookupTxt(TXT_PREFIX + ascii, token);
    if (!txt || txt.unknown) ctx.json({ ok: false, error: 'We couldn’t check your DNS right now. Please try again in a few minutes.' }, 409);
    if (txt.others.length) {
      ctx.json({ ok: false, challenge, error: `There is another OnYourSite TXT value on ${TXT_PREFIX + norm.unicode}. Remove it at your DNS provider (keep yours: ${token}), then try again.` }, 409);
    }
    if (!txt.mine) ctx.json(CHALLENGE, 409);
    claimVersion = intval(existing.version);
  } else if (existing && intval(existing.target_id) !== pageId) {
    const other = await one('SELECT slug FROM pages WHERE id = ?', [existing.target_id]);
    ctx.json({ ok: false, error: `This domain is already connected to your page “${str(other?.slug)}”. Remove it there first.` }, 409);
  } else if (existing) {
    ctx.json({ ok: true, domain: await domainView(existing, { settings: s }) });
  }

  // 10. Eine Transaktion unter der Platz-Sperre des Kontos
  await pausePoint('domain-add', { uid, pageId });
  let outcome: AddOutcome;
  try {
    outcome = await withSlotLock(uid, async (db): Promise<AddOutcome> => {
      const p = await db.one('SELECT * FROM pages WHERE id = ? AND user_id = ? FOR UPDATE', [pageId, uid]);
      if (!p) return { status: 409, body: { ok: false, error: 'Please reload the editor.', reload: true } };
      if (!isShownLinkPage(p)) return { status: 409, body: LINK_ONLY };
      // Übernahme: die Seite des anderen Kontos vor jeder Domain-Zeile sperren (Reihenfolge pages → custom_domains wie
      // in removeDomain(), transition() und beim Domain-Dienst). Sonst hielte die Übernahme die Domain-Zeile und wartete
      // auf dessen Seite, während dessen „Remove“ die Seite hält und auf die Zeile wartet – eine Verklemmung, die einer
      // der beiden Anfragen als Fehler zurückkommt. Ist die Zeile inzwischen woanders, scheitert unten der Vergleich.
      if (claimVersion !== null && existing) await domainTarget(existing.target_type)?.lock(db, intval(existing.target_id));
      const onPage = (await db.one("SELECT * FROM custom_domains WHERE target_type = 'page' AND target_id = ? FOR UPDATE", [pageId])) as DomainRow | null;
      if (onPage) {
        // Doppelklick oder Wiederholung: dieselbe Domain steht schon auf dieser Seite (Entwurf 2.8: die bestehende Zeile)
        if (onPage.hostname === ascii && intval(onPage.user_id) === uid) {
          return { status: 200, body: { ok: true, domain: await domainView(onPage, { settings: s, db }) } };
        }
        return { status: 409, body: { ok: false, error: 'This page already has a domain. Remove it first.' } };
      }
      if (!staff) {
        const used = intval(await db.value("SELECT COUNT(*) FROM custom_domains WHERE user_id = ? AND state <> 'removing'", [uid]));
        if (used >= s.per_user) {
          return { status: 409, body: { ok: false, error: `You’ve connected ${used} of ${s.per_user} domains. Remove one from another page to connect a new one.` } };
        }
        if (s.slots && used >= (await quantity(uid, 'custom_domain', db))) {
          return { status: 409, body: { ok: false, need: 'custom_domain', error: 'Each custom domain needs a domain slot. Get one in the shop.' } };
        }
      }
      const cur = (await db.one('SELECT * FROM custom_domains WHERE hostname = ? FOR UPDATE', [ascii])) as DomainRow | null;
      // Sperre erst nach der Zeile lesen (Reihenfolge custom_domains → custom_domain_blocks wie in removeDomain()):
      // hat der Besitzer die gesperrte Domain eben entfernt, steht ihr Eintrag schon da
      if (await hostnameBlocked(ascii, db, true)) return { status: 409, body: BLOCKED };
      if (claimVersion === null) {
        if (cur) return { status: 409, body: TRY_AGAIN };
        const id = await createDomain({ hostname: ascii, targetId: pageId, userId: uid, isApex: apex }, db);
        const fresh = (await db.one('SELECT * FROM custom_domains WHERE id = ?', [id])) as DomainRow;
        return { status: 200, body: { ok: true, domain: await domainView(fresh, { settings: s, db }) } };
      }
      // Übernahme: nur wenn sich die fremde Zeile seit der Abfrage nicht geändert hat
      if (!cur || intval(cur.version) !== claimVersion || intval(cur.user_id) === uid || cur.state === 'blocked' || cur.state === 'removing') {
        return { status: 409, body: TRY_AGAIN };
      }
      const now = date('Y-m-d H:i:s');
      const fast = date('Y-m-d H:i:s', time() + FAST_MINUTES * 60);
      const loser = intval(cur.user_id);
      // Die Einrichtungsfrist (pending_days, gezählt ab cf_created_at) beginnt für das neue Konto jetzt: mit dem
      // Zeitpunkt des alten Kontos liefe sie bei einer lange live gewesenen Domain sofort ab, und der Dienst würde den
      // Hostnamen gleich nach dem Nachweis löschen (setup_timeout)
      const hostKept = cur.cf_id !== null && cur.cf_id !== undefined && cur.cf_id !== '';
      const ok = await transition(cur, {
        state: 'verifying',
        set: { target_type: 'page', target_id: pageId, user_id: uid, is_apex: apex ? 1 : 0, verified_at: null, problem: '', problem_detail: '',
          next_check_at: now, fast_until: fast, manual_at: now, notice_state: 0, notice_at: null, ...(hostKept ? { cf_created_at: now } : {}) },
        log: { event: 'transferred', detail: 'claimed by account #' + uid },
      }, db);
      if (!ok) return { status: 409, body: TRY_AGAIN };
      // Das bisherige Konto erfährt es über die Glocke und per Mail (Entwurf 4.11: domain_removed wird gemailt; der
      // Domain-Dienst verschickt die Zeile im Verlauf) – in derselben Transaktion. Die Mail-Zeile trägt keine
      // domain_id: die Domain gehört jetzt zur Seite des neuen Kontos, und der Knopf der Mail führte sonst dorthin.
      const lost = noticeText.removed(cur, null, 'transferred');
      await notify(loser, 'domain_removed', NOTICE_TITLES.domain_removed, lost, domainLink(cur), { db });
      await logEvent(db, { id: null, hostname: cur.hostname, user_id: loser }, 'domain_removed', lost, { mail: true });
      const fresh = (await db.one('SELECT * FROM custom_domains WHERE id = ?', [cur.id])) as DomainRow;
      return { status: 200, body: { ok: true, transferred: true, domain: await domainView(fresh, { settings: s, db }) } };
    });
  } catch (err) {
    if (err instanceof SlotBusyError) ctx.json(TRY_AGAIN, 409);
    // Zwei gleichzeitige Anfragen für denselben Hostnamen: der eindeutige Schlüssel entscheidet
    if (Number((err as { errno?: unknown } | null)?.errno ?? 0) === 1062) ctx.json(TRY_AGAIN, 409);
    throw err;
  }
  ctx.json(outcome.body, outcome.status);
}

// Für das Dashboard (E.domains): nur Lesen, ohne Einrichtung nichts
export async function editorDomainFlags(): Promise<{ available: boolean; enabled: boolean; target: string; perUser: number }> {
  if (!domainsAvailable()) return { available: false, enabled: false, target: '', perUser: 0 };
  const s = await domainSettings();
  return { available: true, enabled: s.enabled, target: cnameTarget(), perUser: s.per_user };
}

// Seiten des Kontos mit Domain in irgendeinem Zustand (pages[].custom_domain im Editor)
export async function pagesWithDomain(uid: number): Promise<Set<number>> {
  if (!domainsAvailable()) return new Set();
  return new Set((await q("SELECT target_id FROM custom_domains WHERE target_type = 'page' AND user_id = ?", [uid])).map((r) => intval(r.target_id)));
}
