// Entscheidung für eine Domain aus ihren Beobachtungen (rein, ohne Datenbank und Netz): neuer Zustand, Aktion bei
// Cloudflare, Zähler und Hinweise. Regeln (Entwurf §2.6, §2.11, §4.7):
//   - unbekannte Beobachtungen (Netz, 5xx, cf-mitigated, SERVFAIL) zählen nie;
//   - eine Live-Domain wird erst nach 2 eindeutigen Fehlern mit mindestens 10 Minuten Abstand „broken“;
//   - zeigt sie woandershin, hat keinen Eintrag mehr oder meldet Cloudflare moved/deleted, verliert sie dabei sofort
//     ihren Hostnamen (sonst finge er die Domain weiter ab);
//   - DNS-Fehler bei beiden Resolvern zählen erst nach 3 Prüfungen und 30 Minuten;
//   - bei offenem Schutzschalter: keine Herabstufung und kein Löschen wegen DNS oder Prüfung (Aufstufungen schon);
//   - Fristen zählen ab created_at / cf_created_at / state_at und werden von „Check now“ nicht zurückgesetzt.
import type { Param } from '../../db.js';
import type { DomainRow, DomainState, LogEvent } from '../store.js';
import type { DomainNoticeType } from '../notify.js';
import type { DomainSettings } from '../settings.js';
import type { DnsVerdict, TxtView } from './dns.js';
import type { CfHostname } from './cloudflare.js';
import { encodeExtraRecords, extraRecordsFrom } from '../records.js';
import type { ProbeOutcome } from './probe.js';

export type CfObs =
  | { kind: 'ok'; status: string; sslStatus: string; host: CfHostname | null } // host = null: Stand aus der 10-Minuten-Liste
  | { kind: 'gone' } // 404 bzw. nicht mehr in der Liste
  | { kind: 'unknown'; error: string };

export interface Obs {
  txt?: TxtView;
  zone?: { zone: string; apex: boolean } | null;
  dns?: DnsVerdict;
  cf?: CfObs;
  probe?: ProbeOutcome;
}

// Aus der Datenbank, kurz vor der Entscheidung gelesen (nur für das Anlegen eines Hostnamens)
export interface Facts {
  placeFree: boolean; // unter max_total und im Kontingent von Cloudflare
  ownPending: boolean; // eine andere Domain des Kontos ist gerade in pending
  recentCreates: number; // Hostnamen dieser Domain in den letzten 24 Stunden
  olderWaiting: boolean; // eine früher bestätigte Domain wartet schon auf einen Platz
}

export const NO_FACTS: Readonly<Facts> = Object.freeze({ placeFree: true, ownPending: false, recentCreates: 0, olderWaiting: false });

export type CfAction = 'none' | 'create' | 'delete' | 'patch' | 'txt_fallback';

export interface Decision {
  state: DomainState;
  cfAction: CfAction;
  set: Record<string, Param>;
  event: LogEvent | null;
  detail: string;
  notice: { type: DomainNoticeType; reason: string } | null;
  adminAlert: string | null;
  deleteRow: boolean; // removing: Zeile löschen, sobald der Hostname weg ist
  unknown: boolean; // etwas war unbekannt → nächste Prüfung früher
  recheckIn?: number; // nächste Prüfung spätestens in so vielen Sekunden (nach dem Anlegen: 10 s)
}

export interface EvalInput {
  row: DomainRow;
  obs: Obs;
  settings: DomainSettings;
  frozen: boolean;
  now: number; // Unix-Sekunden
  at: (unix: number) => string; // Unix → 'Y-m-d H:i:s' (Zeitzone der Seite)
  toUnix: (dt: string) => number;
  manual: boolean; // „Check now“ seit der letzten Prüfung
  facts: Facts;
}

const MIN = 60;
const DAY = 86400;
// Ursachen, bei denen der Hostname sofort gelöscht wird (die Domain zeigt woandershin oder Cloudflare gab sie frei)
const RELEASE_CAUSES = new Set(['cname_missing', 'cname_wrong', 'cname_proxied', 'a_records', 'apex_ips', 'cf_moved']);
const CF_LIVE = new Set(['active', 'active_redeploying']);
const CF_GONE = new Set(['moved', 'deleted']);

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const num = (v: unknown): number => Number(v ?? 0) || 0;

export function evaluate(i: EvalInput): Decision {
  const r = i.row;
  const d: Decision = {
    state: r.state, cfAction: 'none', set: { checked_at: i.at(i.now) }, event: null, detail: '', notice: null, adminAlert: null, deleteRow: false, unknown: false,
  };
  const since = (col: string): number | null => {
    const v = r[col];
    return typeof v === 'string' && v !== '' ? i.now - i.toUnix(v) : null;
  };
  const cfId = str(r.cf_id);
  switch (r.state) {
    case 'removing':
      d.cfAction = cfId !== '' ? 'delete' : 'none';
      d.deleteRow = true;
      return d;
    case 'blocked':
      if (cfId !== '') d.cfAction = 'delete';
      return d;
    case 'failed':
      if (cfId !== '') {
        d.cfAction = 'delete';
        return d;
      }
      // Nur auf Anfrage („Check again“): der TXT-Eintrag zählt, die Fristen nicht
      return i.manual ? verify(i, d) : d;
    case 'verifying':
      return verify(i, d);
    case 'pending':
      return pending(i, d, since);
    case 'active':
      return live(i, d, since);
    case 'broken':
      return cfId !== '' ? live(i, d, since) : brokenWithoutHost(i, d, since);
    case 'suspended':
      return suspended(i, d, since);
    default:
      return d;
  }
}

// TXT-Nachweis (verifying, failed auf Anfrage, auch für ein Konto nach einer Übernahme). Die Frist von 7 Tagen ab dem
// Hinzufügen gilt nur, solange der Eintrag fehlt (ein Konto mit wieder aktivem Premium verbindet sich mit dem alten
// Eintrag sofort wieder) und nie, solange die Domain auf einen freien Platz wartet.
function verify(i: EvalInput, d: Decision): Decision {
  const r = i.row;
  const waiting = r.problem === 'quota' || r.problem === 'waiting_own';
  const created = typeof r.created_at === 'string' ? i.now - i.toUnix(r.created_at) : 0;
  const txt = i.obs.txt;
  const timedOut = r.state === 'verifying' && !waiting && created >= 7 * DAY;
  if (!txt || txt.unknown) {
    d.set.problem = 'dns_error';
    d.unknown = true;
    return d;
  }
  if (!txt.mine && timedOut) {
    d.state = 'failed';
    d.set.problem = 'verify_timeout';
    d.set.problem_detail = '';
    d.event = 'failed';
    d.detail = 'verify_timeout';
    if (str(r.cf_id) !== '') d.cfAction = 'delete';
    return d;
  }
  if (i.obs.zone) {
    d.set.zone_name = i.obs.zone.zone;
    d.set.is_apex = i.obs.zone.apex ? 1 : 0;
  }
  if (!txt.mine) {
    // Eine gescheiterte Domain behält ihren Grund (der Nutzer sieht, warum); nur der Zeitpunkt der Prüfung ändert sich
    if (r.state === 'failed') return d;
    d.set.problem = txt.values.length ? 'txt_wrong' : 'txt_missing';
    d.set.problem_detail = '';
    // Ein Hostname ohne Nachweis dieses Kontos (z. B. nach einer Übernahme) bleibt nicht stehen
    if (str(r.cf_id) !== '' && txt.answered >= 2) d.cfAction = 'delete';
    return d;
  }
  d.set.verified_at = i.at(i.now);
  if (r.state === 'verifying' && !waiting && (r.verified_at === null || r.verified_at === undefined)) d.event = 'txt_ok';
  // Schon mit Hostnamen (Premium zurück, Übernahme): weiter zur Einrichtung
  if (str(r.cf_id) !== '') {
    d.state = 'pending';
    d.set.problem = '';
    d.set.problem_detail = '';
    d.set.fast_until = i.at(i.now + 15 * MIN);
    return d;
  }
  const f = i.facts;
  if (f.placeFree && !f.olderWaiting && !f.ownPending && f.recentCreates < 3) {
    d.state = 'pending';
    d.cfAction = 'create';
    d.set.problem = '';
    d.set.problem_detail = '';
    d.set.fast_until = i.at(i.now + 15 * MIN);
    return d;
  }
  const problem = !f.placeFree || f.olderWaiting ? 'quota' : f.ownPending ? 'waiting_own' : 'api_error';
  d.set.problem = problem;
  d.set.problem_detail = problem === 'api_error' ? 'Three setups in 24 hours – trying again later.' : '';
  if (r.problem !== problem && problem !== 'api_error') d.event = 'waiting';
  return d;
}

// Hostname angelegt, die Einrichtung läuft
function pending(i: EvalInput, d: Decision, since: (col: string) => number | null): Decision {
  const r = i.row;
  const age = since('cf_created_at') ?? since('state_at') ?? 0;
  if (age >= i.settings.pending_days * DAY) {
    d.state = 'failed';
    d.cfAction = 'delete';
    d.set.problem = 'setup_timeout';
    d.set.problem_detail = '';
    d.event = 'failed';
    d.detail = 'setup_timeout';
    d.notice = { type: 'domain_removed', reason: 'setup_timeout' };
    return d;
  }
  const cf = i.obs.cf;
  if (!cf || cf.kind === 'unknown') {
    d.unknown = true;
    return d;
  }
  if (cf.kind === 'gone') {
    // Bei Cloudflare verschwunden (z. B. von Hand gelöscht): neu nachweisen, dann neu anlegen
    d.state = 'verifying';
    d.set.cf_id = null;
    d.set.cf_status = '';
    d.set.cf_ssl_status = '';
    d.set.problem = '';
    d.event = 'check';
    d.detail = 'The hostname is gone at Cloudflare.';
    return d;
  }
  d.set.cf_status = cf.status;
  d.set.cf_ssl_status = cf.sslStatus;
  // Zusatz-Einträge nur aus einer vollständigen Antwort (die 10-Minuten-Liste lässt sie stehen)
  if (cf.host) d.set.extra_records = encodeExtraRecords(extraRecordsFrom(cf.host));
  const cfOk = CF_LIVE.has(cf.status);
  const sslOk = cf.sslStatus === 'active';
  const dns = i.obs.dns;
  const dnsOk = dns !== undefined && (dns.verdict === 'ok' || dns.verdict === 'cf_ips');
  const probe = i.obs.probe;
  if (probe?.certValidTo) d.set.cert_expires_at = probe.certValidTo;
  if (cfOk && sslOk && dnsOk && probe?.result === 'ok') {
    d.state = 'active';
    d.set.problem = '';
    d.set.problem_detail = '';
    d.set.fail_count = 0;
    d.set.fail_since = null;
    d.set.dns_unknown_count = 0;
    d.set.dns_unknown_since = null;
    d.set.fast_until = null;
    d.event = 'active';
    // Nach einem gemeldeten Problem (Hostname wurde neu angelegt): „wieder da“ statt „live“
    d.notice = num(r.notice_state) === 1 ? { type: 'domain_back', reason: '' } : { type: 'domain_live', reason: '' };
    return d;
  }
  // Was fehlt noch? (Fehler von Cloudflare zuerst – eine CAA-Meldung heißt: das Zertifikat ist blockiert)
  const errors = [...(cf.host?.verification_errors ?? []), ...(cf.host?.ssl?.validation_errors ?? []).map((e) => str(e?.message))].join(' ');
  let problem = 'cf_pending';
  if (/\bcaa\b/i.test(errors)) problem = 'caa';
  else if (dns && dns.verdict === 'wrong') problem = dns.problem;
  else if (dns && dns.verdict === 'unknown') problem = 'dns_error';
  else if (!cfOk) problem = 'cf_pending';
  else if (!sslOk) problem = 'ssl_pending';
  else if (probe && probe.result === 'wrong') problem = 'probe_failed';
  d.set.problem = problem;
  d.set.problem_detail = errors.slice(0, 255);
  if (dns?.verdict === 'unknown' || probe?.result === 'unknown') d.unknown = true;
  // Wurzeldomain ohne Delegation: nach 30 Minuten ohne Erfolg per HTTP auf TXT umstellen
  const ssl = cf.host?.ssl;
  if (r.is_apex && ssl && ssl.method === 'http' && !(ssl.dcv_delegation_records?.length) && !sslOk && age >= 30 * MIN) {
    d.cfAction = 'txt_fallback';
  } else if (i.manual && cf.host && !sslOk) {
    // „Check now“: dieselbe Anfrage noch einmal (setzt die Wartezeit der Prüfung bei Cloudflare zurück), höchstens alle 5 Minuten
    const patched = since('patched_at');
    if (patched === null || patched >= 5 * MIN) d.cfAction = 'patch';
  }
  return d;
}

// Live (active) oder kaputt mit Hostnamen (broken): DNS, Cloudflare, Prüfung über die Kante
function live(i: EvalInput, d: Decision, since: (col: string) => number | null): Decision {
  const r = i.row;
  // 7 Tage kaputt: Hostname löschen, gescheitert
  if (r.state === 'broken' && (since('state_at') ?? 0) >= 7 * DAY) {
    d.state = 'failed';
    d.cfAction = str(r.cf_id) !== '' ? 'delete' : 'none';
    d.set.problem = 'broken_timeout';
    d.event = 'failed';
    d.detail = 'broken_timeout';
    d.notice = { type: 'domain_removed', reason: 'broken_timeout' };
    return d;
  }
  const failures: Array<{ cause: string; release: boolean }> = [];
  const add = (cause: string): void => void failures.push({ cause, release: RELEASE_CAUSES.has(cause) });
  const cf = i.obs.cf;
  let cfOk = false;
  if (cf?.kind === 'gone') add('cf_moved');
  else if (cf?.kind === 'ok') {
    d.set.cf_status = cf.status;
    d.set.cf_ssl_status = cf.sslStatus;
    if (CF_GONE.has(cf.status)) add('cf_moved');
    else if (cf.status === 'blocked' || cf.status === 'pending_blocked') add('cf_blocked');
    else if (cf.sslStatus === 'expired' || cf.sslStatus === 'inactive') add('ssl_expired');
    cfOk = CF_LIVE.has(cf.status) && cf.sslStatus === 'active';
  } else if (cf?.kind === 'unknown') d.unknown = true;
  // DNS: eindeutig falsch, oder bei beiden Resolvern lange unbekannt
  const dns = i.obs.dns;
  if (dns?.verdict === 'wrong') {
    add(dns.problem);
    d.set.dns_unknown_count = 0;
    d.set.dns_unknown_since = null;
  } else if (dns?.verdict === 'unknown') {
    const count = num(r.dns_unknown_count) + 1;
    const first = typeof r.dns_unknown_since === 'string' && r.dns_unknown_since !== '' ? r.dns_unknown_since : i.at(i.now);
    d.set.dns_unknown_count = Math.min(count, 65535);
    d.set.dns_unknown_since = first;
    if (count >= 3 && i.now - i.toUnix(first) >= 30 * MIN) add('dns_unknown');
    else d.unknown = true;
  } else if (dns) {
    d.set.dns_unknown_count = 0;
    d.set.dns_unknown_since = null;
  }
  // Prüfung über die Kante
  const probe = i.obs.probe;
  if (probe?.certValidTo) d.set.cert_expires_at = probe.certValidTo;
  if (probe?.result === 'wrong') add(probe.reason === 'cert_expired' ? 'ssl_expired' : probe.reason.startsWith('cert') || probe.reason === 'no_certificate' ? 'cert_invalid' : 'probe_failed');
  else if (probe?.result === 'unknown') d.unknown = true;
  // Abgelaufen zählt nur mit dem Zertifikat dieser Prüfung (ein gespeicherter alter Wert kann überholt sein)
  const freshCert = probe?.certValidTo ? i.toUnix(probe.certValidTo) : null;
  if (freshCert !== null && freshCert <= i.now && !failures.some((f) => f.cause === 'ssl_expired')) add('ssl_expired');
  const certText = probe?.certValidTo ?? (typeof r.cert_expires_at === 'string' && r.cert_expires_at !== '' ? r.cert_expires_at : null);
  const certAt = certText !== null ? i.toUnix(certText) : null;

  if (failures.length) {
    // Gründe zum Freigeben zuerst (sie entscheiden über das Löschen des Hostnamens)
    failures.sort((a, b) => Number(b.release) - Number(a.release));
    const cause = failures[0];
    const count = num(r.fail_count) + 1;
    const first = typeof r.fail_since === 'string' && r.fail_since !== '' ? r.fail_since : i.at(i.now);
    d.set.fail_count = Math.min(count, 65535);
    d.set.fail_since = first;
    d.set.problem = cause.cause;
    if (i.frozen) return d; // Schutzschalter offen: nur zählen
    const confirmed = count >= 2 && i.now - i.toUnix(first) >= 10 * MIN;
    if (!confirmed) return d;
    if (r.state === 'active') {
      d.state = 'broken';
      d.event = 'broken';
      d.detail = cause.cause;
      d.notice = { type: 'domain_problem', reason: cause.cause };
    }
    if (cause.release && str(r.cf_id) !== '') d.cfAction = 'delete';
    return d;
  }
  // Keine eindeutigen Fehler mehr
  d.set.fail_count = 0;
  d.set.fail_since = null;
  const dnsOk = dns !== undefined && (dns.verdict === 'ok' || dns.verdict === 'cf_ips');
  if (r.state === 'broken') {
    if (cfOk && dnsOk && probe?.result === 'ok') {
      d.state = 'active';
      d.set.problem = '';
      d.set.problem_detail = '';
      d.event = 'recovered';
      d.notice = { type: 'domain_back', reason: '' };
    }
    return d;
  }
  // Live: Zertifikat läuft bald ab und Cloudflare hat (noch) keins erneuert → einmal melden
  const cfSsl = cf?.kind === 'ok' ? cf.sslStatus : str(r.cf_ssl_status);
  if (certAt !== null && certAt - i.now < 14 * DAY && cfSsl !== 'active') {
    if (r.problem !== 'cert_expiring') {
      d.set.problem = 'cert_expiring';
      d.notice = { type: 'domain_problem', reason: 'cert_expiring' };
      d.adminAlert = `The HTTPS certificate for ${r.hostname} expires soon and Cloudflare hasn’t renewed it yet.`;
    }
    return d;
  }
  if (!d.unknown) {
    d.set.problem = '';
    d.set.problem_detail = '';
  }
  return d;
}

// Kaputt und ohne Hostnamen (zeigte woandershin): sobald das DNS wieder auf uns zeigt und der TXT-Nachweis noch da ist,
// einen neuen Hostnamen anlegen (höchstens 3 je Domain und Tag)
function brokenWithoutHost(i: EvalInput, d: Decision, since: (col: string) => number | null): Decision {
  if ((since('state_at') ?? 0) >= 7 * DAY) {
    d.state = 'failed';
    d.set.problem = 'broken_timeout';
    d.event = 'failed';
    d.detail = 'broken_timeout';
    d.notice = { type: 'domain_removed', reason: 'broken_timeout' };
    return d;
  }
  const dns = i.obs.dns;
  const dnsOk = dns !== undefined && (dns.verdict === 'ok' || dns.verdict === 'cf_ips');
  if (dns?.verdict === 'unknown') d.unknown = true;
  if (!dnsOk) {
    if (dns?.verdict === 'wrong') d.set.problem = dns.problem;
    return d;
  }
  const txt = i.obs.txt;
  if (!txt || !txt.mine) {
    d.set.problem = txt && !txt.unknown ? (txt.values.length ? 'txt_wrong' : 'txt_missing') : 'dns_error';
    return d;
  }
  const f = i.facts;
  if (f.placeFree && !f.olderWaiting && !f.ownPending && f.recentCreates < 3) {
    d.state = 'pending';
    d.cfAction = 'create';
    d.set.problem = '';
    d.set.verified_at = i.at(i.now);
    d.set.fail_count = 0;
    d.set.fail_since = null;
    d.set.fast_until = i.at(i.now + 15 * MIN);
  } else {
    d.set.problem = !f.placeFree || f.olderWaiting ? 'quota' : f.ownPending ? 'waiting_own' : 'api_error';
  }
  return d;
}

// Pausiert (Premium endete): Hostname nach der Frist löschen – oder sofort, wenn die Domain nicht 14 Tage live war
// (problem_detail 'release'), woandershin zeigt oder Cloudflare sie freigab
function suspended(i: EvalInput, d: Decision, since: (col: string) => number | null): Decision {
  const r = i.row;
  if (str(r.cf_id) === '') return d;
  const graceOver = (since('suspended_at') ?? 0) >= i.settings.grace_days * DAY;
  if (r.problem_detail === 'release' || graceOver) {
    d.cfAction = 'delete';
    if (graceOver && r.problem_detail !== 'release') {
      d.notice = { type: 'domain_removed', reason: 'grace_over' };
      d.set.problem_detail = 'released';
    }
    return d;
  }
  const cf = i.obs.cf;
  if (cf?.kind === 'gone' || (cf?.kind === 'ok' && CF_GONE.has(cf.status))) {
    d.cfAction = 'delete';
    d.set.problem_detail = 'released';
    return d;
  }
  const dns = i.obs.dns;
  if (dns?.verdict === 'wrong' && RELEASE_CAUSES.has(dns.problem)) {
    const count = num(r.fail_count) + 1;
    d.set.fail_count = count;
    d.set.fail_since = typeof r.fail_since === 'string' && r.fail_since !== '' ? r.fail_since : i.at(i.now);
    if (count >= 2 && !i.frozen) {
      d.cfAction = 'delete';
      d.set.problem_detail = 'released';
    }
  } else if (dns && dns.verdict !== 'unknown') {
    d.set.fail_count = 0;
    d.set.fail_since = null;
  }
  return d;
}
