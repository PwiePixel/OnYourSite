// Der Domain-Dienst (onyoursite-domains): die einzige Stelle mit Netzwerkarbeit für eigene Domains – Cloudflare, DNS
// über DoH, Prüfung über die Kante, Mails. Eine Instanz (GET_LOCK 'oys_domains_worker'), eigener kleiner Pool.
// Jede Prüfung liest ihre Zeile, gibt die Verbindung zurück, fragt im Netz nach, entscheidet (evaluate) und schreibt
// in EINER kurzen Transaktion per Compare-and-set – nie hält sie eine Verbindung, während sie im Netz wartet.
//   alle 5 s     fällige Domains (höchstens 50, 8 gleichzeitig)
//   jede Minute  Selbsttest und Schutzschalter, Premium-Netz, fällige Fristen, Warteschlange, Mails, Admin-Aufträge
//   alle 10 Min  Status aller Hostnamen aus der Liste von Cloudflare
//   täglich      IP-Bereiche, Kontingent und Rückfall-Ursprung, verwaiste Hostnamen, Aufräumen
import { exec, one, q, transaction, value, type Param } from '../../db.js';
import { baseHost } from '../../helpers.js';
import { date, intval, phpStr } from '../../php.js';
import { nowStr, toUnix } from '../../honeycombs/clock.js';
import { reconcileUser } from '../lifecycle.js';
import { poolDb } from '../../honeycombs/util.js';
import { isPremiumRow } from '../../honeycombs/premium.js';
import { cnameTarget } from '../config.js';
import { domainById, hostnameBlocked, logEvent, removeDomain, transition, type DomainRow, type DomainState } from '../store.js';
import { ownershipToken, probeAnswer } from '../tokens.js';
import { TXT_PREFIX } from '../hostname.js';
import {
  domainSettings, takeWorkerRequests, updateWorkerState, workerState, type DomainSettings, type WorkerState,
} from '../settings.js';
import { adminAlert, backNoticeAllowed, domainNotice, noticeText, problemNoticeAllowed } from '../notify.js';
import { CfAuthError, CfError, CfUnavailable, type Cloudflare, type CfQuota } from './cloudflare.js';
import { detectZone, judgeDns, judgeResolver, lookupAddress, txtView, type Doh } from './dns.js';
import { CfRanges } from './cfips.js';
import { configuredEdgeIps, probeConfig, probeHost, type ProbeOutcome } from './probe.js';
import { breaker, runControl, type ControlResult } from './control.js';
import { evaluate, NO_FACTS, type CfObs, type Decision, type Facts, type Obs } from './evaluate.js';
import { nextDelay } from './schedule.js';
import { sendDomainMails, type MailSender } from './mail.js';

const MIN = 60;
const DAY = 86400;
const CONCURRENCY = 8;
const BATCH = 50;

export interface WorkerDeps {
  cf: Cloudflare;
  doh: Doh;
  ranges?: CfRanges;
  clock?: () => number; // Millisekunden
  send?: MailSender;
  log?: (line: string) => void;
  probe?: typeof probeHost;
}

// Meldung an die Admins: höchstens einmal je `hours` Stunden je Art (key)
interface Alert {
  key: string;
  hours: number;
  text: string;
  also?: string[];
}

const at = (unix: number): string => nowStr(unix);
const str = (v: unknown): string => (v === null || v === undefined ? '' : phpStr(v));

export class DomainWorker {
  readonly ranges: CfRanges;
  private lastMinute = 0;
  private lastList = 0;
  private edgeIps: string[] = [];
  private edgeAddrs = new Set<string>();
  private frozen = false;
  private quotaCache: { at: number; q: CfQuota } | null = null;
  private createChain: Promise<unknown> = Promise.resolve();
  private probeOkAt: number | null = null;
  private log: (line: string) => void;

  constructor(private readonly d: WorkerDeps) {
    this.ranges = d.ranges ?? new CfRanges();
    this.log = d.log ?? ((line) => console.log(line));
  }

  private nowSec(): number {
    return Math.floor((this.d.clock ?? Date.now)() / 1000);
  }

  // Adressen der Kante aus einem Selbsttest übernehmen (Diagnose ohne Minutenaufgaben)
  useEdge(edgeIps: string[], edgeAddrs: string[]): void {
    this.edgeIps = edgeIps;
    this.edgeAddrs = new Set(edgeAddrs);
  }

  // Eine Runde: Minuten-, 10-Minuten- und Tagesaufgaben, wenn fällig, dann die fälligen Domains
  async tick(): Promise<number> {
    const now = this.nowSec();
    if (now - this.lastMinute >= MIN) {
      this.lastMinute = now;
      await this.minute();
    }
    if (now - this.lastList >= 10 * MIN) {
      this.lastList = now;
      await this.statusList().catch((err) => this.log(`Domains: the status list failed: ${errText(err)}`));
    }
    await this.dailyIfDue().catch((err) => this.log(`Domains: the daily tasks failed: ${errText(err)}`));
    return this.runDue();
  }

  // Fällige Domains prüfen (älteste zuerst), höchstens 8 gleichzeitig
  async runDue(): Promise<number> {
    const ids = (await q('SELECT id FROM custom_domains WHERE next_check_at IS NOT NULL AND next_check_at <= ? ORDER BY next_check_at, id LIMIT ?',
      [at(this.nowSec()), BATCH])).map((r) => intval(r.id));
    let next = 0;
    const work = async (): Promise<void> => {
      while (next < ids.length) {
        const id = ids[next++];
        await this.check(id).catch((err) => this.log(`Domains: check of #${id} failed: ${errText(err)}`));
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, work));
    return ids.length;
  }

  // ---------------------------------------------------------------- eine Domain

  // Beobachtungen im Netz (ohne Datenbankverbindung)
  async observe(row: DomainRow, manual: boolean): Promise<Obs> {
    const obs: Obs = {};
    const host = row.hostname;
    const hasHost = str(row.cf_id) !== '';
    const txt = async (): Promise<void> => {
      const name = TXT_PREFIX + host;
      obs.txt = txtView(await this.d.doh.query(name, 'TXT'), name, ownershipToken(intval(row.user_id), host));
      if (obs.txt.mine && str(row.zone_name) === '') obs.zone = await detectZone(this.d.doh, host, baseHost()).catch(() => null);
    };
    const cfGet = async (): Promise<void> => {
      try {
        const h = await this.d.cf.getHostname(str(row.cf_id));
        obs.cf = h === null ? { kind: 'gone' } : { kind: 'ok', status: h.status, sslStatus: str(h.ssl?.status), host: h };
      } catch (err) {
        this.tokenTrouble(err);
        obs.cf = { kind: 'unknown', error: errText(err) };
      }
    };
    const cached = (): CfObs => {
      const st = str(row.cf_status);
      if (st === 'deleted') return { kind: 'gone' };
      return st === '' ? { kind: 'unknown', error: 'no status yet' } : { kind: 'ok', status: st, sslStatus: str(row.cf_ssl_status), host: null };
    };
    const dns = async (): Promise<void> => {
      const cfActive = obs.cf?.kind === 'ok' && (obs.cf.status === 'active' || obs.cf.status === 'active_redeploying');
      const views = await lookupAddress(this.d.doh, host);
      obs.dns = judgeDns(views.map((v) => judgeResolver(v, {
        target: cnameTarget(), base: baseHost(), apex: intval(row.is_apex) === 1, cfActive, isCloudflare: (ip) => this.ranges.has(ip), edgeAddrs: this.edgeAddrs,
      })));
    };
    const probe = async (): Promise<void> => {
      if (!this.edgeIps.length) {
        obs.probe = { result: 'unknown', reason: 'no_edge', certValidTo: null };
        return;
      }
      const cfg = probeConfig();
      obs.probe = await (this.d.probe ?? probeHost)({ hostname: host, ips: this.edgeIps, port: cfg.port, ca: cfg.ca, expected: probeAnswer(host) });
      if (obs.probe.result === 'ok') this.probeOkAt = this.nowSec();
    };
    switch (row.state) {
      case 'verifying':
        await txt();
        break;
      case 'failed':
        if (manual && !hasHost) await txt();
        break;
      case 'pending':
        await cfGet();
        await dns();
        if (obs.cf?.kind === 'ok' && obs.cf.sslStatus === 'active') await probe();
        break;
      case 'active':
        if (manual || !['active', 'active_redeploying'].includes(str(row.cf_status)) || str(row.cf_ssl_status) !== 'active') await cfGet();
        else obs.cf = cached();
        await dns();
        await probe();
        break;
      case 'broken':
        if (hasHost) {
          await cfGet();
          await dns();
          await probe();
        } else {
          await dns();
          if (obs.dns?.verdict === 'ok' || obs.dns?.verdict === 'cf_ips') await txt();
        }
        break;
      case 'suspended':
        if (hasHost) {
          obs.cf = cached();
          await dns();
        }
        break;
    }
    return obs;
  }

  // Aus der Datenbank: darf jetzt ein Hostname angelegt werden?
  async facts(row: DomainRow, s: DomainSettings, now: number): Promise<Facts> {
    const withHost = intval(await value('SELECT COUNT(*) FROM custom_domains WHERE cf_id IS NOT NULL AND id <> ?', [row.id]));
    const placeFree = withHost < s.max_total && (await this.quotaAllows(s));
    const ownPending = (await one("SELECT id FROM custom_domains WHERE user_id = ? AND state = 'pending' AND id <> ? LIMIT 1", [row.user_id, row.id])) !== null;
    const recentCreates = intval(await value("SELECT COUNT(*) FROM custom_domain_log WHERE domain_id = ? AND event = 'cf_created' AND created_at >= ?", [row.id, at(now - DAY)]));
    const mine = typeof row.verified_at === 'string' && row.verified_at !== '' ? row.verified_at : at(now);
    const olderWaiting = (await one(`SELECT id FROM custom_domains WHERE state = 'verifying' AND problem = 'quota' AND id <> ? AND verified_at IS NOT NULL
      AND (verified_at < ? OR (verified_at = ? AND id < ?)) LIMIT 1`, [row.id, mine, mine, row.id])) !== null;
    return { placeFree, ownPending, recentCreates, olderWaiting };
  }

  // Kontingent bei Cloudflare (10 Minuten zwischengespeichert): voll ohne bezahlte Hostnamen oder an der harten Grenze
  private async quotaAllows(s: DomainSettings): Promise<boolean> {
    const now = this.nowSec();
    if (!this.quotaCache || now - this.quotaCache.at >= 10 * MIN) {
      try {
        this.quotaCache = { at: now, q: await this.d.cf.quota() };
      } catch (err) {
        this.tokenTrouble(err);
        return true; // unbekannt: Cloudflare lehnt notfalls selbst ab
      }
    }
    const qt = this.quotaCache.q;
    if (qt.hard_cap > 0 && qt.used >= qt.hard_cap) return false;
    return !(qt.allocated > 0 && qt.used >= qt.allocated && !s.allow_paid);
  }

  // Eine Domain prüfen und den Zustand schreiben
  async check(id: number): Promise<void> {
    const row = await domainById(id);
    if (!row) return;
    const now = this.nowSec();
    const manual = typeof row.manual_at === 'string' && row.manual_at !== '' && (row.checked_at === null || str(row.manual_at) >= str(row.checked_at));
    const obs = await this.observe(row, manual);
    const s = await domainSettings();
    const needFacts = obs.txt?.mine === true && str(row.cf_id) === '';
    const facts = needFacts ? await this.facts(row, s, now) : NO_FACTS;
    let d = evaluate({ row, obs, settings: s, frozen: this.frozen, now, at, toUnix, manual, facts });
    if (d.cfAction === 'create') d = await this.create(row, d, s, now, obs, manual);
    else if (d.cfAction === 'delete') d = await this.release(row, d);
    else if (d.cfAction === 'patch' || d.cfAction === 'txt_fallback') await this.patch(row, d, now);
    await this.write(row, d, now);
  }

  // Hostname anlegen – nacheinander (nie zwei gleichzeitig: Plätze und „eine Domain je Konto in pending“ stimmen so)
  private create(row: DomainRow, d: Decision, s: DomainSettings, now: number, obs: Obs, manual: boolean): Promise<Decision> {
    const run = async (): Promise<Decision> => {
      // Vom Team gesperrter Hostname (R2): nie bei Cloudflare anlegen – auch nicht für eine Zeile am Editor vorbei
      if (await hostnameBlocked(row.hostname)) return { ...d, state: row.state, cfAction: 'none', event: null, notice: null, set: { checked_at: at(now) } };
      // Nur mit Premium (oder als Admin): „Check again“ auf einer gescheiterten Domain prüft den TXT-Eintrag auch ohne
      // Premium – dann bleibt alles, wie es ist, und kein Hostname entsteht
      const owner = await one('SELECT id, is_admin, premium_until FROM users WHERE id = ?', [row.user_id]);
      if (!owner || !isPremiumRow(owner)) return { ...d, state: row.state, cfAction: 'none', event: null, notice: null, set: { checked_at: at(now) } };
      const fresh = await this.facts(row, s, now);
      if (!(fresh.placeFree && !fresh.olderWaiting && !fresh.ownPending && fresh.recentCreates < 3)) {
        return evaluate({ row, obs, settings: s, frozen: this.frozen, now, at, toUnix, manual, facts: fresh });
      }
      let created;
      try {
        created = await this.d.cf.createHostname(row.hostname);
      } catch (err) {
        this.tokenTrouble(err);
        const msg = err instanceof CfError ? err.message : 'Cloudflare isn’t reachable right now.';
        return { ...d, state: row.state, cfAction: 'none', set: { checked_at: at(now), problem: 'api_error', problem_detail: msg.slice(0, 255) },
          event: err instanceof CfError ? 'api_error' : null, detail: msg, unknown: true };
      }
      const h = created.hostname;
      // Die ID sofort festhalten – auch wenn der Zustand danach nicht geschrieben wird (sonst bliebe sie unbemerkt)
      const stored = await transaction(async (_c, db) => {
        const res = await db.exec('UPDATE custom_domains SET cf_id = ?, cf_created_at = ?, cf_status = ?, cf_ssl_status = ? WHERE id = ? AND cf_id IS NULL AND version = ?',
          [h.id, at(now), h.status, str(h.ssl?.status), row.id, row.version]);
        if (res.affectedRows === 0) return false;
        await logEvent(db, row, created.adopted ? 'cf_adopted' : 'cf_created', '', { cfId: h.id });
        return true;
      });
      if (!stored) {
        // Inzwischen entfernt oder geändert: der neue Hostname darf nicht stehen bleiben. Erst im Verlauf als „von hier
        // angelegt“ vermerken – scheitert das Löschen, findet ihn so die tägliche Suche nach verwaisten Hostnamen.
        if ((await one('SELECT id FROM custom_domains WHERE cf_id = ?', [h.id])) === null) {
          const why = 'removed while it was being set up';
          await logEvent(poolDb, row, created.adopted ? 'cf_adopted' : 'cf_created', why, { cfId: h.id });
          try {
            await this.d.cf.deleteHostname(h.id);
            await logEvent(poolDb, row, 'cf_deleted', why, { cfId: h.id });
          } catch (err) {
            this.tokenTrouble(err);
            this.log(`Domains: deleting the new hostname ${row.hostname} failed (the daily sweep tries again): ${errText(err)}`);
          }
        }
        return { ...d, state: row.state, cfAction: 'none', event: null, notice: null, set: { checked_at: at(now) } };
      }
      // Die Antwort auf das Anlegen enthält oft noch nicht alles (Prüfeinträge) – 10 s später noch einmal lesen
      return { ...d, cfAction: 'none', set: { ...d.set, cf_status: h.status, cf_ssl_status: str(h.ssl?.status) }, recheckIn: 10 };
    };
    const p = this.createChain.then(run, run);
    this.createChain = p.catch(() => undefined);
    return p;
  }

  // Hostname löschen (404 = schon weg); klappt das nicht, bleibt alles, wie es ist, und es wird bald erneut versucht
  private async release(row: DomainRow, d: Decision): Promise<Decision> {
    const id = str(row.cf_id);
    if (id === '') return { ...d, cfAction: 'none' };
    try {
      await this.d.cf.deleteHostname(id);
    } catch (err) {
      this.tokenTrouble(err);
      // Pausiert (Frist vorbei, freigegeben): „getrennt“ erst, wenn der Hostname wirklich weg ist – sonst käme der Hinweis
      // samt Mail bei jedem neuen Versuch noch einmal; problem_detail bleibt, damit der nächste Versuch ihn wieder setzt
      if (row.state === 'suspended') {
        const set = { ...d.set };
        delete set.problem_detail;
        return { ...d, cfAction: 'none', deleteRow: false, unknown: true, notice: null, set };
      }
      return { ...d, state: row.state === 'removing' ? 'removing' : d.state, cfAction: 'none', deleteRow: false, unknown: true,
        notice: row.state === 'removing' ? null : d.notice, set: { ...d.set } };
    }
    await logEvent(poolDb, row, 'cf_deleted', '', { cfId: id });
    return { ...d, cfAction: 'none', set: { ...d.set, cf_id: null, cf_status: '', cf_ssl_status: '' } };
  }

  // PATCH bei Cloudflare: Prüfung neu anstoßen (Check now) oder Wurzeldomain auf TXT umstellen
  private async patch(row: DomainRow, d: Decision, now: number): Promise<void> {
    const ssl = d.cfAction === 'txt_fallback' ? { method: 'txt', type: 'dv' } : { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } };
    try {
      await this.d.cf.patchSsl(str(row.cf_id), ssl);
      d.set.patched_at = at(now);
      if (d.cfAction === 'txt_fallback') {
        d.event = 'check';
        d.detail = 'Switched the certificate check to TXT.';
      }
    } catch (err) {
      this.tokenTrouble(err);
    }
    d.cfAction = 'none';
  }

  // Ergebnis schreiben: Compare-and-set auf version; Hinweise in derselben Transaktion
  private async write(row: DomainRow, d: Decision, now: number): Promise<void> {
    if (d.deleteRow) {
      if (str(row.cf_id) !== '' && d.set.cf_id !== null) {
        // Löschen bei Cloudflare klappte nicht: später erneut
        await exec('UPDATE custom_domains SET next_check_at = ? WHERE id = ? AND version = ?', [at(now + this.retryDelay(row, now)), row.id, row.version]);
        return;
      }
      await exec("DELETE FROM custom_domains WHERE id = ? AND version = ? AND state = 'removing'", [row.id, row.version]);
      return;
    }
    const state: DomainState = d.state;
    const cfAfter = d.set.cf_id === null ? null : str(row.cf_id) !== '' ? str(row.cf_id) : null;
    const cfCreated = typeof row.cf_created_at === 'string' && row.cf_created_at !== '' ? toUnix(row.cf_created_at) : null;
    let delay = nextDelay({
      id: row.id, state, cf_id: cfAfter, created: toUnix(str(row.created_at) || at(now)), cfCreated: d.cfAction === 'none' && d.state === 'pending' && cfCreated === null ? now : cfCreated,
      stateAt: state !== row.state ? now : toUnix(str(row.state_at) || at(now)),
      fastUntil: typeof d.set.fast_until === 'string' ? toUnix(d.set.fast_until) : d.set.fast_until === null ? null : typeof row.fast_until === 'string' ? toUnix(row.fast_until) : null,
    }, now);
    // Unbekanntes früher erneut prüfen – bei verifying nur, wenn der Nachweis da war und Cloudflare nicht antwortete
    const retrySoon = state === 'active' || state === 'broken' || state === 'pending' || (state === 'verifying' && d.set.problem === 'api_error');
    if (d.unknown && delay !== null && retrySoon) delay = Math.min(delay, 5 * MIN);
    if (d.recheckIn !== undefined && delay !== null) delay = Math.min(delay, d.recheckIn);
    const set: Record<string, Param> = { ...d.set, next_check_at: delay === null ? null : at(now + delay) };
    // Hinweise mit Schutz vor Flattern (Spalten gehören zum Compare-and-set)
    let notice = d.notice;
    if (notice?.type === 'domain_problem') {
      const g = problemNoticeAllowed(row, at(now), at(now - DAY));
      Object.assign(set, g.set);
      if (!g.allowed) notice = null;
    } else if (notice?.type === 'domain_back') {
      const g = backNoticeAllowed(row);
      Object.assign(set, g.set);
      if (!g.allowed) notice = null;
    }
    await transaction(async (_c, db) => {
      const ok = await transition(row, { state: state !== row.state ? state : undefined, set, log: d.event ? { event: d.event, detail: d.detail } : undefined }, db);
      if (!ok) return;
      if (notice) {
        const page = await db.one('SELECT * FROM pages WHERE id = ?', [row.target_id]);
        const text = notice.type === 'domain_live' ? noticeText.live(row, page)
          : notice.type === 'domain_problem' ? noticeText.problem(row, page, notice.reason)
            : notice.type === 'domain_back' ? noticeText.back(row)
              : notice.type === 'domain_paused' ? noticeText.paused(row, page)
                : noticeText.removed(row, page, notice.reason, str(row.blocked_reason));
        await domainNotice(db, row, notice.type, text);
      }
      // Meldung an die Admins zu dieser Domain (Zertifikat läuft ab) höchstens einmal je 24 Stunden – sonst käme sie nach
      // jedem einzelnen Fehler dazwischen erneut
      const alerted = d.adminAlert !== null && (await db.one("SELECT id FROM custom_domain_log WHERE event = 'alert' AND hostname = ? AND created_at >= ? LIMIT 1",
        [row.hostname, at(now - DAY)])) !== null;
      if (d.adminAlert && !alerted) await adminAlert(db, d.adminAlert, row.hostname);
    });
  }

  private retryDelay(row: DomainRow, now: number): number {
    return Math.min(3600, Math.max(MIN, now - toUnix(str(row.state_at) || at(now))));
  }

  // Token ungültig: Zustand merken (einmal am Tag die Admins)
  private tokenProblem: string | null = null;
  private tokenTrouble(err: unknown): void {
    if (err instanceof CfAuthError) this.tokenProblem = err.message;
  }

  // ---------------------------------------------------------------- jede Minute

  async minute(): Promise<void> {
    const now = this.nowSec();
    const st = await workerState();
    const s = await domainSettings();
    // 1. Selbsttest und Schutzschalter
    const cfg = probeConfig();
    let control: ControlResult;
    try {
      control = await runControl({
        doh: this.d.doh, ranges: this.ranges, target: cnameTarget(), base: baseHost(), expected: probeAnswer(baseHost()), port: cfg.port, ca: cfg.ca,
        fixedEdgeIps: configuredEdgeIps(),
      });
    } catch (err) {
      control = { ok: false, error: errText(err), edgeIps: [], edgeAddrs: [], probe: null };
    }
    this.edgeIps = control.edgeIps;
    this.edgeAddrs = new Set(control.edgeAddrs);
    const live = intval(await value("SELECT COUNT(*) FROM custom_domains WHERE state = 'active'"));
    const failing = intval(await value("SELECT COUNT(*) FROM custom_domains WHERE state = 'active' AND fail_count > 0 AND checked_at >= ?", [at(now - 12 * MIN)]));
    const b = breaker({ controlOk: control.ok, controlError: control.error, live, failing, freeze: st.freeze, now: at(now) });
    this.frozen = b.freeze !== null;
    if (b.opened) this.log(`Domains: checks paused – ${b.freeze?.detail}`);
    if (b.closed) this.log('Domains: checks running again.');

    // 2. Zustand schreiben (mit Meldungen an die Admins in derselben Transaktion)
    const alerts: Alert[] = [];
    if (b.opened && b.freeze) alerts.push({ key: 'breaker', hours: 6, text: `Custom domain checks are paused: ${b.freeze.detail}` });
    if (this.tokenProblem !== null) alerts.push({ key: 'token', hours: 24, text: `The Cloudflare token for custom domains doesn’t work: ${this.tokenProblem}` });
    await this.saveState(st, {
      worker_at: at(now), control: { ok: control.ok, at: at(now), error: control.error }, freeze: b.freeze,
      ...(this.probeOkAt !== null ? { probe_ok_at: at(this.probeOkAt) } : {}),
      ...(this.tokenProblem !== null ? { token: 'error' as const, token_error: this.tokenProblem.slice(0, 200) } : {}),
    }, alerts, now);
    this.tokenProblem = null;

    // 3. Sicherheitsnetz für Premium: Abgleich für Konten, deren Domains nicht zum Premium-Stand passen. premium_until ist
    // NULL nach Erstattung, Entzug oder ohne Kauf (Ex-Admin) – NOT (… OR NULL > ?) wäre NULL, das Konto fiele heraus
    const lost = await q(`SELECT DISTINCT d.user_id FROM custom_domains d JOIN users u ON u.id = d.user_id
        WHERE d.state IN ('verifying','pending','active','broken') AND u.is_admin = 0 AND (u.premium_until IS NULL OR u.premium_until <= ?)`, [at(now)]);
    const back = await q(`SELECT DISTINCT d.user_id FROM custom_domains d JOIN users u ON u.id = d.user_id
        WHERE d.state = 'suspended' AND (u.is_admin = 1 OR u.premium_until > ?)`, [at(now)]);
    for (const r of [...lost, ...back]) {
      await reconcileUser(intval(r.user_id)).catch((err) => this.log(`Domains: reconcile of account #${phpStr(r.user_id)} failed: ${errText(err)}`));
    }

    // 4. Fällige Fristen und Löschungen sofort prüfen (ohne auf den Zeitplan zu warten)
    await exec(`UPDATE custom_domains SET next_check_at = ? WHERE (next_check_at IS NULL OR next_check_at > ?) AND (
        (state = 'verifying' AND created_at <= ? AND problem NOT IN ('quota', 'waiting_own'))
        OR (state = 'pending' AND cf_created_at <= ?)
        OR (state = 'broken' AND state_at <= ?)
        OR (state = 'suspended' AND cf_id IS NOT NULL AND (problem_detail = 'release' OR suspended_at <= ?))
        OR (state IN ('blocked', 'failed', 'removing') AND cf_id IS NOT NULL AND next_check_at IS NULL)
        OR (state = 'removing' AND cf_id IS NULL))`,
    [at(now), at(now), at(now - 7 * DAY), at(now - s.pending_days * DAY), at(now - 7 * DAY), at(now - s.grace_days * DAY)]);

    // 5. Warteschlange: freie Plätze an die am längsten wartenden bestätigten Domains; wer auf die eigene andere Domain
    // wartete, darf weiter, sobald die nicht mehr in pending ist
    const used = intval(await value('SELECT COUNT(*) FROM custom_domains WHERE cf_id IS NOT NULL'));
    const free = Math.max(0, s.max_total - used);
    if (free > 0 && (await this.quotaAllows(s))) {
      const waiting = await q("SELECT id FROM custom_domains WHERE state = 'verifying' AND problem = 'quota' ORDER BY verified_at, id LIMIT ?", [Math.min(free, BATCH)]);
      for (const w of waiting) await exec('UPDATE custom_domains SET next_check_at = ? WHERE id = ?', [at(now), intval(w.id)]);
    }
    const own = await q(`SELECT d.id FROM custom_domains d WHERE d.state = 'verifying' AND d.problem = 'waiting_own'
        AND NOT EXISTS (SELECT 1 FROM custom_domains p WHERE p.user_id = d.user_id AND p.state = 'pending')`);
    for (const w of own) await exec('UPDATE custom_domains SET next_check_at = ? WHERE id = ?', [at(now), intval(w.id)]);

    // 6. Mails (eigenes Budget je Minute)
    await sendDomainMails({ budget: s.mails_per_minute, now, at, send: this.d.send }).catch((err) => this.log(`Domains: sending mails failed: ${errText(err)}`));

    // 7. Aufträge aus dem Admin
    const requests = await transaction((_c, db) => takeWorkerRequests(db));
    if (requests.includes('test')) await this.testConnection(now);
  }

  // Zustand des Dienstes schreiben; Meldungen an die Admins nur, wenn die letzte dieser Art lange genug her ist
  private async saveState(st: WorkerState, change: Partial<WorkerState>, alerts: Alert[], now: number): Promise<void> {
    await transaction(async (_c, db) => {
      const alertTimes = { ...st.alerts };
      for (const a of alerts) {
        const last = alertTimes[a.key];
        if (last && now - toUnix(last) < a.hours * 3600) continue;
        alertTimes[a.key] = at(now);
        // Eine schwerere Meldung gilt auch für die leichtere derselben Art (100 % → keine 80 %-Meldung am selben Tag)
        for (const k of a.also ?? []) alertTimes[k] = at(now);
        await adminAlert(db, a.text);
      }
      await updateWorkerState({ ...change, alerts: alertTimes }, db);
    });
  }

  // „Test connection“ im Admin: Kontingent, Rückfall-Ursprung und IP-Bereiche neu lesen
  async testConnection(now = this.nowSec()): Promise<string> {
    let result: string;
    try {
      const [quota, fallback] = await Promise.all([this.d.cf.quota(), this.d.cf.fallbackOrigin()]);
      this.quotaCache = { at: now, q: quota };
      await this.refreshIps();
      result = `Token works. ${quota.used} of ${quota.allocated} hostnames used; fallback origin ${fallback.origin || '(none)'} is ${fallback.status || 'unknown'}.`;
      await updateWorkerState({
        token: 'ok', token_error: '', quota: { ...quota, checked_at: at(now) }, fallback: { origin: fallback.origin, status: fallback.status, checked_at: at(now) },
        test: { at: at(now), result },
      });
    } catch (err) {
      result = err instanceof CfAuthError ? `The token doesn’t work: ${err.message}` : `Cloudflare isn’t reachable: ${errText(err)}`;
      await updateWorkerState({ ...(err instanceof CfAuthError ? { token: 'error' as const, token_error: err.message.slice(0, 200) } : {}), test: { at: at(now), result } });
    }
    return result;
  }

  // ---------------------------------------------------------------- alle 10 Minuten

  // Status aller Hostnamen in einer Liste (ein Aufruf je 1000): Abweichungen machen die Domain sofort fällig
  async statusList(): Promise<void> {
    const now = this.nowSec();
    let all;
    try {
      all = await this.d.cf.allHostnames();
    } catch (err) {
      this.tokenTrouble(err);
      return;
    }
    const byId = new Map(all.map((h) => [h.id, h]));
    const rows = await q("SELECT id, state, cf_id, cf_status, cf_ssl_status, cf_created_at FROM custom_domains WHERE cf_id IS NOT NULL AND state IN ('pending','active','broken','suspended')");
    for (const r of rows) {
      const h = byId.get(str(r.cf_id));
      // Gerade erst angelegt: die Liste kennt ihn vielleicht noch nicht
      const young = typeof r.cf_created_at === 'string' && now - toUnix(r.cf_created_at) < 10 * MIN;
      const status = h ? h.status : young ? str(r.cf_status) : 'deleted';
      const ssl = h ? str(h.ssl?.status) : str(r.cf_ssl_status);
      if (status === str(r.cf_status) && ssl === str(r.cf_ssl_status)) continue;
      const problem = status === 'moved' || status === 'deleted' || status === 'blocked' || (ssl !== 'active' && r.state === 'active');
      await exec('UPDATE custom_domains SET cf_status = ?, cf_ssl_status = ?' + (problem ? ', next_check_at = ?' : '') + ' WHERE id = ?',
        problem ? [status, ssl, at(now), intval(r.id)] : [status, ssl, intval(r.id)]);
    }
    await updateWorkerState({ list_at: at(now) });
  }

  // ---------------------------------------------------------------- täglich

  private async refreshIps(): Promise<void> {
    const ips = await this.d.cf.ips();
    if (ips.v4.length || ips.v6.length) {
      this.ranges.set(ips);
      await updateWorkerState({ cf_ips: { v4: ips.v4, v6: ips.v6, fetched_at: at(this.nowSec()) } });
    }
  }

  // Erste Runde nach 04:30 Uhr (Zeit der Seite), einmal am Tag
  async dailyIfDue(): Promise<void> {
    const now = this.nowSec();
    const st = await workerState();
    if (st.daily_at === date('Y-m-d', now) || date('H:i', now) < '04:30') {
      if (st.cf_ips && !this.ipsLoaded) {
        this.ranges.set(st.cf_ips);
        this.ipsLoaded = true;
      }
      return;
    }
    await this.daily();
  }
  private ipsLoaded = false;

  async daily(): Promise<void> {
    const now = this.nowSec();
    const s = await domainSettings();
    await updateWorkerState({ daily_at: date('Y-m-d', now) });
    await this.refreshIps().catch((err) => this.log(`Domains: Cloudflare IP ranges: ${errText(err)}`));
    const alerts: Alert[] = [];
    const change: Partial<WorkerState> = {};
    try {
      const quota = await this.d.cf.quota();
      this.quotaCache = { at: now, q: quota };
      change.quota = { ...quota, checked_at: at(now) };
      change.token = 'ok';
      change.token_error = '';
      const limit = s.allow_paid && quota.hard_cap > 0 ? quota.hard_cap : quota.allocated;
      if (limit > 0 && quota.used >= limit) {
        alerts.push({ key: 'quota100', hours: 24, also: ['quota80'], text: `All ${limit} custom hostnames are in use – new domains wait in line.` });
      }
      else if (limit > 0 && quota.used >= 0.8 * limit) alerts.push({ key: 'quota80', hours: 24, text: `${quota.used} of ${limit} custom hostnames are in use.` });
      const fallback = await this.d.cf.fallbackOrigin();
      change.fallback = { origin: fallback.origin, status: fallback.status, checked_at: at(now) };
      if (fallback.status !== 'active') alerts.push({ key: 'fallback', hours: 24, text: `The fallback origin ${fallback.origin || '(none)'} isn’t active (${fallback.status || 'unknown'}).` });
    } catch (err) {
      if (err instanceof CfAuthError) {
        change.token = 'error';
        change.token_error = err.message.slice(0, 200);
        alerts.push({ key: 'token', hours: 24, text: `The Cloudflare token for custom domains doesn’t work: ${err.message}` });
      }
    }
    // Verwaiste Hostnamen: angelegt von hier (Verlauf kennt die ID), aber keiner Domain mehr zugeordnet → löschen;
    // von Hand angelegte nur auflisten. Nie während ein Hostname gerade angelegt wird.
    await this.createChain;
    try {
      const all = await this.d.cf.allHostnames();
      const known = new Set((await q('SELECT cf_id FROM custom_domains WHERE cf_id IS NOT NULL')).map((r) => str(r.cf_id)));
      const ours = new Set((await q("SELECT DISTINCT cf_id FROM custom_domain_log WHERE event IN ('cf_created','cf_adopted') AND cf_id IS NOT NULL")).map((r) => str(r.cf_id)));
      const unmanaged: WorkerState['unmanaged'] = [];
      for (const h of all) {
        if (known.has(h.id)) continue;
        if (ours.has(h.id)) {
          try {
            await this.d.cf.deleteHostname(h.id);
            const last = await one("SELECT domain_id, user_id FROM custom_domain_log WHERE cf_id = ? ORDER BY id DESC LIMIT 1", [h.id]);
            await logEvent(poolDb, { id: last?.domain_id === undefined ? null : (last.domain_id as number | null), hostname: h.hostname, user_id: null },
              'cf_deleted', 'orphan', { cfId: h.id });
          } catch (err) {
            this.log(`Domains: deleting the orphan hostname ${h.hostname} failed: ${errText(err)}`);
          }
        } else if (unmanaged.length < 200) {
          unmanaged.push({ hostname: h.hostname, id: h.id, status: h.status });
        }
      }
      change.unmanaged = unmanaged;
    } catch (err) {
      this.log(`Domains: the orphan sweep failed: ${errText(err)}`);
    }
    await this.saveState(await workerState(), change, alerts, now);
    // Aufräumen: Verlauf nach 90 Tagen (außer IDs angelegter Hostnamen ohne Löschung), gescheiterte Domains nach
    // 30 Tagen, pausierte ohne Hostnamen nach 90 Tagen
    await exec(`DELETE l FROM custom_domain_log l LEFT JOIN custom_domain_log x ON x.event = 'cf_deleted' AND x.cf_id = l.cf_id
        WHERE l.created_at < ? AND (l.event NOT IN ('cf_created','cf_adopted') OR l.cf_id IS NULL OR x.id IS NOT NULL)`, [at(now - 90 * DAY)]);
    const stale = await q(`SELECT id FROM custom_domains WHERE cf_id IS NULL AND ((state = 'failed' AND state_at < ?) OR (state = 'suspended' AND suspended_at < ?))`,
      [at(now - 30 * DAY), at(now - 90 * DAY)]);
    for (const r of stale) await transaction((_c, db) => removeDomain(db, intval(r.id), 'cleaned up'));
  }
}

export function errText(err: unknown): string {
  if (err instanceof CfUnavailable || err instanceof CfError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

export type { ProbeOutcome };
