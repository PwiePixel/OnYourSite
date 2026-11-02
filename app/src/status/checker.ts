// Statusseiten: der Kern des Prüfdienstes (ohne Einstieg, ohne Sperre – die macht worker.ts). Alles, was nach außen
// geht, kommt als Abhängigkeit herein (Richtlinie, Resolver, Uhr, Kanarienvögel), damit Tests eine eigene Richtlinie
// für lokale Testserver geben können; der Dienst selbst hat dafür keinen Schalter.
// Ablauf: tick() erledigt, was fällig ist – Abgleich mit der Datenbank (5 s, bei geändertem status_rev), „Jetzt prüfen“
// (2 s), Heartbeats und Jobs (15 s), Schreiben (Rohdaten und Zustand 5 s, Summen 10 s), Plattform-Sperre (Kanarienvögel
// alle 30 s, während „hold“ alle 10 s), Gesundheitseintrag (30 s), Aufräumen (Warteschlange jede Minute, Aufbewahrung
// stündlich um :07, Partitionen täglich 00:20 UTC und beim Start) – und startet alle fälligen Prüfungen, die die
// Grenzen erlauben.
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import type { Db } from '../db.js';
import { transaction, withConnection } from '../db.js';
import { Aggregator, creditWindow, type Bucket, type SpanKind } from './aggregate.js';
import { gateRecordJson, gateStep, initialGate, type GateRecord, type GateSignals, type IngressSignals } from './gate.js';
import { hostRule, parseTarget, type GuardPolicy, type HostRule } from './guard.js';
import { runHttpCheck, type HttpCheckInput, type HttpOutcome } from './http.js';
import { effectiveMonitors, statusLimits, type StatusLimits } from './limits.js';
import { partitionDay, partitionPlan, utcDay } from './partitions.js';
import { registrableDomain } from './psl.js';
import { dnsOutcome, resolverCanary, type PublicResolver } from './resolver.js';
import { ROBOTS_TTL, robotsAfterFetch, robotsAllows, rulesFromJson, type RobotsRule } from './robots.js';
import { Scheduler, firstDue, nextDue, retryDelay, type Job } from './scheduler.js';
import { statusSettings, type StatusSettings } from './settings.js';
import {
  BLOCKED_PAUSE_AFTER, REFUSED_PAUSE_AFTER, discardHeld, heartbeatVerdict, initialState, releaseHeld, step, type CheckResult, type StateEvent,
  type StateRecord, type StepConfig,
} from './state.js';
import { JOB_HEARTBEATS, systemProbe, type ProbeContext, type SystemFacts } from './system.js';

export const CHECKER_VERSION = '1';

export interface CheckerDeps {
  policy: (settings: StatusSettings) => GuardPolicy;
  resolver: PublicResolver;
  clock: () => number; // ms
  ipv6: boolean;
  userAgent: string;
  canaries: string[]; // HTTPS-Adressen
  dnsServers: string[]; // für den Resolver-Kanarienvogel
  canaryNames: string[]; // Namen für den Resolver-Kanarienvogel
  baseUrl: string;
  healthUrl: string;
  tz: string;
  facts: () => SystemFacts;
  scheduler: { concurrency: number; keywordConcurrency: number; userInflight: number };
  limitsFor?: (userId: number | null, db?: Db) => Promise<StatusLimits>;
  ca?: string | Buffer | Array<string | Buffer>; // nur Tests
  canaryTimeoutSec?: number;
  log?: (line: string) => void;
}

interface PageRt {
  id: number;
  userId: number | null;
  isSystem: boolean;
  blocked: boolean;
  ownerSeenAt: string | null;
}

interface MonitorRt {
  id: number;
  pageId: number;
  userId: number | null;
  type: string;
  name: string;
  target: string;
  host: string;
  domain: string;
  position: number;
  intervalS: number;
  config: Record<string, unknown>;
  paused: boolean;
  adminPaused: boolean;
  autoPaused: string | null;
  // laufend
  st: StateRecord;
  lastCheckAt: number | null;
  lastOkAt: number | null;
  lastResultAt: number | null;
  lastMs: number | null;
  lastCode: number | null;
  lastError: string | null;
  certExpires: number | null;
  throttledAt: number | null;
  seen: { ping: number | null; fail: number | null; missedFor: number | null };
  hbPing: number | null;
  hbFail: number | null;
  dirty: boolean;
  active: boolean; // läuft (nicht pausiert, nicht über der Grenze …)
  hidden: boolean; // System-Teil ohne Funktion
  effectiveInterval: number;
  maintenance: boolean;
  lastFail: { error: string | null; code: number | null };
  changedAt: number; // status_monitors.changed_at beim letzten Laden
  runSoon: boolean; // geändert: in den nächsten 5 s prüfen (Entwurf §4.8.2)
}

export type Periodic = 'sync' | 'runs' | 'sweep' | 'flush' | 'aggregates' | 'canaries' | 'gate' | 'meta' | 'purge' | 'retention' | 'partitions' | 'reload' | 'robots';

const DAY = 86400;

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const truthy = (v: unknown): boolean => v === 1 || v === '1' || v === true;

function parseJson(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw === '') return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const cfgNum = (c: Record<string, unknown>, k: string, d: number, min: number, max: number): number => {
  const v = num(c[k]);
  return v === null ? d : Math.min(max, Math.max(min, Math.trunc(v)));
};

export class Checker {
  readonly scheduler: Scheduler;
  settings!: StatusSettings;
  policy!: GuardPolicy;
  gate: GateRecord;
  private readonly pages = new Map<number, PageRt>();
  private readonly monitors = new Map<number, MonitorRt>();
  private rules: HostRule[] = [];
  private robots = new Map<string, { at: number; rules: RobotsRule[] }>();
  private robotsLoading = new Map<string, Promise<void>>();
  private readonly limitsCache = new Map<string, { at: number; limits: StatusLimits }>();
  private readonly agg: Aggregator;
  private raw: Array<[number, number, number, number | null, number | null, string | null]> = [];
  private events: Array<[number, number, string, string | null, number | null]> = [];
  private readonly inflight = new Map<number, Promise<void>>();
  private readonly aborts = new Map<number, AbortController>();
  private readonly hostResults = new Map<string, { at: number; failed: boolean }>();
  private readonly last = new Map<Periodic, number>();
  private readonly busy = new Set<Periodic>();
  private readonly bg = new Set<Promise<void>>();
  private readonly memory = new Map<string, number>();
  private rev = '';
  private lastSync = 0;
  private started = 0;
  private resumedAt: number | null = null;
  private checksDone: number[] = []; // Zeitpunkte erledigter Prüfungen (für „checks_min“)
  private stopping = false;
  private readonly loopDelay: IntervalHistogram;
  private loopP99 = 0;
  private readonly log: (line: string) => void;
  private dbOk = true;

  constructor(readonly deps: CheckerDeps) {
    const now = deps.clock();
    this.gate = initialGate(Math.floor(now / 1000));
    this.scheduler = new Scheduler({
      concurrency: deps.scheduler.concurrency,
      keywordConcurrency: deps.scheduler.keywordConcurrency,
      userInflight: deps.scheduler.userInflight,
      hostPerMin: 30,
      domainPerMin: 60,
      ipPerMin: 3000,
    });
    this.agg = new Aggregator(deps.tz);
    this.log = deps.log ?? ((line) => console.log(line));
    this.loopDelay = monitorEventLoopDelay({ resolution: 20 });
    this.loopDelay.enable();
  }

  private nowMs(): number {
    return this.deps.clock();
  }
  private nowS(): number {
    return Math.floor(this.deps.clock() / 1000);
  }

  // ---------------------------------------------------------------- Laden und Abgleich

  async start(): Promise<void> {
    this.started = this.nowS();
    this.settings = await statusSettings();
    this.policy = this.deps.policy(this.settings);
    // Lücke: war der Prüfdienst länger als 2 Minuten weg, beginnen die Heartbeat-Fristen neu
    const worker = parseJson(await this.metaValue('status_worker'));
    const lastAt = num(worker.at);
    if (lastAt === null || this.started - lastAt > 120) this.resumedAt = this.started;
    const gate = parseJson(await this.metaValue('status_gate'));
    const recovered = num(gate.ingress_recovered_at);
    if (recovered !== null) this.gate.ingressRecoveredAt = recovered;
    this.rev = String((await this.metaValue('status_rev')) ?? '');
    await this.reload(true);
    await this.maintainPartitions().catch((err) => this.log(`Partitions: ${(err as Error).message}`));
    this.last.set('partitions', this.nowMs());
  }

  private async metaValue(key: string, db?: Db): Promise<string | null> {
    const run = async (d: Db): Promise<string | null> => {
      const v = await d.value('SELECT meta_value FROM oys_meta WHERE meta_key = ?', [key]);
      return v === null || v === undefined ? null : String(v);
    };
    return db ? run(db) : withConnection((d) => run(d));
  }

  private async limitsOf(userId: number | null, fresh = false): Promise<StatusLimits> {
    const key = userId === null ? 'system' : String(userId);
    const hit = this.limitsCache.get(key);
    if (!fresh && hit && this.nowMs() - hit.at < 60_000) return hit.limits;
    const limits = await (this.deps.limitsFor ?? statusLimits)(userId);
    this.limitsCache.set(key, { at: this.nowMs(), limits });
    return limits;
  }

  // Alles neu laden (Start, alle 10 Minuten) oder nur Geändertes (bei neuem status_rev)
  async reload(full: boolean): Promise<void> {
    const since = full ? 0 : Math.max(0, this.lastSync - 2);
    const syncAt = this.nowS();
    await withConnection(async (db) => {
      this.settings = await statusSettings(db);
      this.policy = this.deps.policy(this.settings);
      const pageRows = await db.q('SELECT id, user_id, is_system, is_blocked, owner_seen_at, changed_at FROM status_pages WHERE changed_at >= ?', [since]);
      const changedOwners = new Set<number | null>();
      for (const p of pageRows) {
        const page: PageRt = { id: Number(p.id), userId: num(p.user_id), isSystem: truthy(p.is_system), blocked: truthy(p.is_blocked), ownerSeenAt: p.owner_seen_at === null ? null : String(p.owner_seen_at) };
        this.pages.set(page.id, page);
        if (!full) changedOwners.add(page.userId);
      }
      const monitorRows = await db.q(`SELECT id, page_id, user_id, type, name, target, target_host, target_domain, position, interval_s, config,
          is_paused, admin_paused, auto_paused, hb_last_ping_at, hb_last_fail_at, changed_at FROM status_monitors WHERE changed_at >= ?`, [since]);
      const ids = monitorRows.map((m) => Number(m.id));
      const states = new Map<number, Record<string, unknown>>();
      if (ids.length) {
        for (let i = 0; i < ids.length; i += 1000) {
          const chunk = ids.slice(i, i + 1000);
          for (const s of await db.q(`SELECT * FROM status_state WHERE monitor_id IN (${chunk.map(() => '?').join(',')})`, chunk)) states.set(Number(s.monitor_id), s);
        }
      }
      for (const m of monitorRows) this.upsertMonitor(m, states.get(Number(m.id)));
      if (full) {
        const pageIds = new Set(pageRows.map((p) => Number(p.id)));
        for (const id of [...this.pages.keys()]) if (!pageIds.has(id)) this.pages.delete(id);
        const monIds = new Set(ids);
        for (const id of [...this.monitors.keys()]) if (!monIds.has(id)) this.dropMonitor(id);
      }
      this.rules = (await db.q('SELECT host, rule, max_monitors, note FROM status_host_rules')).map((r) => ({
        host: String(r.host), rule: r.rule === 'allow' ? 'allow' : 'block', max_monitors: num(r.max_monitors), note: String(r.note ?? ''),
      }));
      // Gelöschte Prüfungen und Seiten kommen über die Warteschlange zum Aufräumen
      for (const p of await db.q('SELECT kind, ref_id FROM status_purge')) {
        if (p.kind === 'monitor') this.dropMonitor(Number(p.ref_id));
        else if (p.kind === 'page') {
          this.pages.delete(Number(p.ref_id));
          for (const m of [...this.monitors.values()]) if (m.pageId === Number(p.ref_id)) this.dropMonitor(m.id);
        }
      }
      // Laufende Wartungen decken ihre Bestandteile ab
      const maint = new Set<number>();
      for (const r of await db.q(`SELECT im.monitor_id FROM status_incidents i JOIN status_incident_monitors im ON im.incident_id = i.id
          WHERE i.kind = 'maintenance' AND i.status = 'in_progress' AND i.resolved_at IS NULL`)) maint.add(Number(r.monitor_id));
      for (const m of this.monitors.values()) m.maintenance = maint.has(m.id);
      for (const owner of changedOwners) await this.limitsOf(owner, true);
    });
    this.lastSync = syncAt;
    await this.recompute();
  }

  private upsertMonitor(m: Record<string, unknown>, state?: Record<string, unknown>): void {
    const id = Number(m.id);
    const prev = this.monitors.get(id);
    const config = parseJson(m.config);
    const type = String(m.type);
    let host = String(m.target_host ?? '');
    let domain = String(m.target_domain ?? '');
    if (type === 'http' && host === '') {
      const t = parseTarget(String(m.target ?? ''), this.policy);
      if (t.ok) host = t.host;
    }
    if (type === 'http' && domain === '' && host !== '') domain = registrableDomain(host);
    const rt: MonitorRt = prev ?? {
      id, pageId: 0, userId: null, type, name: '', target: '', host: '', domain: '', position: 0, intervalS: 300, config: {}, paused: false, adminPaused: false,
      autoPaused: null, st: initialState(), lastCheckAt: null, lastOkAt: null, lastResultAt: null, lastMs: null, lastCode: null, lastError: null,
      certExpires: null, throttledAt: null, seen: { ping: null, fail: null, missedFor: null }, hbPing: null, hbFail: null, dirty: false, active: false,
      hidden: false, effectiveInterval: 300, maintenance: false, lastFail: { error: null, code: null }, changedAt: 0, runSoon: false,
    };
    const targetChanged = prev !== undefined && (prev.target !== String(m.target ?? '') || prev.type !== type);
    // Vom Besitzer oder Team geändert (nicht nur neu gelesen, wie beim vollen Abgleich alle 10 Minuten)
    const changedAt = Number(m.changed_at ?? 0);
    if (prev !== undefined && changedAt > prev.changedAt) rt.runSoon = true;
    Object.assign(rt, {
      pageId: Number(m.page_id), userId: num(m.user_id), type, name: String(m.name ?? ''), target: String(m.target ?? ''), host, domain,
      position: Number(m.position ?? 0), intervalS: Math.max(15, Number(m.interval_s ?? 300)), config, paused: truthy(m.is_paused),
      adminPaused: truthy(m.admin_paused), autoPaused: m.auto_paused === null || m.auto_paused === undefined || m.auto_paused === '' ? null : String(m.auto_paused),
      hbPing: num(m.hb_last_ping_at), hbFail: num(m.hb_last_fail_at), changedAt,
    });
    if (!prev && state) {
      rt.st = {
        ...initialState(),
        state: (['unknown', 'up', 'degraded', 'down'].includes(String(state.state)) ? String(state.state) : 'unknown') as StateRecord['state'],
        since: num(state.since), flapping: truthy(state.flapping), fails: Number(state.fails ?? 0), certWarned: num(state.cert_warned),
        refusedSince: num(state.refused_since),
      };
      if (rt.st.fails > 0 && rt.st.state !== 'down') rt.st.firstFailAt = num(state.last_check_at);
      rt.lastCheckAt = num(state.last_check_at);
      rt.lastOkAt = num(state.last_ok_at);
      rt.lastResultAt = rt.lastCheckAt;
      rt.lastMs = num(state.last_ms);
      rt.lastCode = num(state.last_code);
      rt.lastError = state.last_error === null || state.last_error === undefined ? null : String(state.last_error);
      rt.certExpires = num(state.cert_expires_at);
      rt.throttledAt = num(state.throttled_at);
      // Heartbeats: schon ausgewertete Pings nicht noch einmal zählen
      rt.seen = { ping: rt.hbPing, fail: rt.hbFail, missedFor: null };
    } else if (!prev) {
      rt.seen = { ping: null, fail: null, missedFor: null };
    }
    if (targetChanged) {
      // Neues Ziel: neu anfangen (der Verlauf bleibt in der Datenbank)
      rt.st = initialState();
      rt.lastResultAt = null;
      rt.dirty = true;
    }
    this.monitors.set(id, rt);
  }

  private dropMonitor(id: number): void {
    this.monitors.delete(id);
    this.scheduler.remove(id);
    this.aborts.get(id)?.abort();
  }

  // Welche Prüfungen laufen (Grenzen, Pausen, Sperren, Notschalter, Inaktivität) und wann
  private async recompute(): Promise<void> {
    const s = this.settings;
    const byPage = new Map<number, MonitorRt[]>();
    for (const m of this.monitors.values()) {
      const list = byPage.get(m.pageId);
      if (list) list.push(m);
      else byPage.set(m.pageId, [m]);
    }
    const inactiveBefore = this.nowS() - s.inactive_days * DAY;
    // 1. Was liefe ohne die Grenzen je Host und Domain (Pausen, Sperren, Grenzen des Nutzers, Notschalter, Inaktivität)
    const plan = new Map<number, { e: ReturnType<typeof effectiveMonitors>[number] | undefined; base: boolean }>();
    for (const [pageId, list] of byPage) {
      const page = this.pages.get(pageId);
      const limits = page ? await this.limitsOf(page.isSystem ? null : page.userId) : null;
      const eff = limits ? effectiveMonitors(list.map((m) => ({ id: m.id, type: m.type, position: m.position, interval_s: m.intervalS })), limits) : [];
      const effById = new Map(eff.map((e) => [e.id, e]));
      for (const m of list) {
        const e = effById.get(m.id);
        const userPage = page !== undefined && !page.isSystem;
        const inactive = userPage && page.ownerSeenAt !== null && Date.parse(page.ownerSeenAt + 'T00:00:00Z') / 1000 < inactiveBefore;
        const base = page !== undefined && e !== undefined && !e.overLimit && !m.paused && !m.adminPaused && m.autoPaused === null && !page.blocked
          && !(userPage && (!s.run_user_checks || inactive)) && !(m.type === 'http' && hostRule(m.host, this.rules)?.rule === 'block')
          && (m.type === 'http' || m.type === 'heartbeat' || m.type === 'system');
        plan.set(m.id, { e, base });
      }
    }
    // 2. Grenzen je Host und Domain auch im laufenden Betrieb (falls Daten an der Prüfung beim Speichern vorbei kamen) –
    //    gezählt werden nur Prüfungen, die sonst liefen, die ältesten zuerst: eine gesperrte Seite oder angehaltene
    //    Prüfungen belegen keine Plätze
    const perHost = new Map<string, number>();
    const perDomain = new Map<string, number>();
    const httpSorted = [...this.monitors.values()].filter((m) => m.type === 'http').sort((a, b) => a.id - b.id);
    const capped = new Set<number>();
    for (const m of httpSorted) {
      if (!plan.get(m.id)?.base) continue;
      const rule = hostRule(m.host, this.rules);
      const hostMax = rule?.rule === 'allow' && rule.max_monitors !== null ? rule.max_monitors : s.host_cap;
      const domainMax = rule?.rule === 'allow' && rule.max_monitors !== null ? Math.max(rule.max_monitors, s.domain_cap) : s.domain_cap;
      const h = (perHost.get(m.host) ?? 0) + 1;
      const d = (perDomain.get(m.domain) ?? 0) + 1;
      if (h > hostMax || d > domainMax) {
        capped.add(m.id);
        continue;
      }
      perHost.set(m.host, h);
      perDomain.set(m.domain, d);
    }
    // 3. Übernehmen und einplanen
    for (const [, list] of byPage) {
      for (const m of list) {
        const { e, base } = plan.get(m.id) ?? { e: undefined, base: false };
        const runnable = base && !capped.has(m.id);
        m.effectiveInterval = e ? e.effectiveInterval : m.intervalS;
        const wasActive = m.active;
        m.active = runnable;
        const scheduled = m.type === 'http' || (m.type === 'system' && !JOB_HEARTBEATS.has(m.target));
        if (!runnable || !scheduled) {
          this.scheduler.remove(m.id);
        } else if (!this.scheduler.has(m.id)) {
          const intervalMs = m.effectiveInterval * 1000;
          const last = m.lastCheckAt === null ? null : m.lastCheckAt * 1000;
          this.scheduler.upsert({ id: m.id, due: wasActive ? this.nowMs() : m.runSoon ? this.soon() : firstDue(m.id, intervalMs, last, this.nowMs()), ...this.jobFields(m) });
          m.runSoon = false;
        } else {
          // Schon eingeplant: Host, Domain und Stichwort folgen dem aktuellen Ziel (Höflichkeit gilt dem Host, der die
          // Anfragen bekommt); geändert → in den nächsten 5 s. Läuft die Prüfung gerade, macht das runJob() danach.
          const queued = this.scheduler.queuedJob(m.id);
          if (queued) {
            const f = this.jobFields(m);
            const soon = m.runSoon ? this.soon() : null;
            if (soon !== null || queued.host !== f.host || queued.domain !== f.domain || queued.keyword !== f.keyword || queued.userId !== f.userId) {
              this.scheduler.upsert(soon !== null && soon < queued.due ? { ...queued, ...f, due: soon, notBefore: undefined, origDue: undefined } : { ...queued, ...f });
            }
            m.runSoon = false;
          }
        }
      }
    }
    for (const m of this.monitors.values()) {
      if (!this.pages.has(m.pageId)) {
        m.active = false;
        this.scheduler.remove(m.id);
      }
    }
  }

  // Was der Zeitplan von einer Prüfung wissen muss (Höflichkeit je Host und Domain, Grenzen je Nutzer)
  private jobFields(m: MonitorRt): Pick<Job, 'userId' | 'host' | 'domain' | 'keyword'> {
    const page = this.pages.get(m.pageId);
    return {
      userId: page && !page.isSystem ? page.userId : null,
      host: m.type === 'http' ? m.host : '',
      domain: m.domain,
      keyword: m.type === 'http' && String(m.config.keyword ?? '') !== '',
    };
  }

  // Bald: in den nächsten 5 s (verteilt, damit viele Änderungen nicht in derselben Sekunde prüfen)
  private soon(): number {
    return this.nowMs() + Math.floor(Math.random() * 5000);
  }

  // ---------------------------------------------------------------- Takt

  private due(task: Periodic, everyMs: number): boolean {
    const now = this.nowMs();
    if (this.busy.has(task)) return false;
    const last = this.last.get(task) ?? 0;
    if (now - last < everyMs) return false;
    this.last.set(task, now);
    return true;
  }

  private async guarded(task: Periodic, fn: () => Promise<void>): Promise<void> {
    this.busy.add(task);
    try {
      await fn();
    } catch (err) {
      this.log(`Status checker (${task}): ${(err as Error).message}`);
    } finally {
      this.busy.delete(task);
    }
  }

  // Einmal alles Fällige anstoßen; liefert, wann es wieder etwas zu tun gibt (ms). Die regelmäßigen Aufgaben laufen
  // im Hintergrund (jede höchstens einmal gleichzeitig), damit eine langsame Aufgabe (Kanarienvögel, Aufräumen) keine
  // fällige Prüfung aufhält.
  tick(): number {
    const now = this.nowMs();
    const run = (task: Periodic, everyMs: number, fn: () => Promise<void>): void => {
      if (!this.due(task, everyMs)) return;
      const p = this.guarded(task, fn).finally(() => this.bg.delete(p));
      this.bg.add(p);
    };
    run('sync', 5_000, () => this.syncIfChanged());
    run('reload', 600_000, () => this.reload(true));
    run('runs', 2_000, () => this.runRequests());
    run('sweep', 15_000, () => this.sweep());
    run('flush', 5_000, () => this.flush());
    run('aggregates', 10_000, () => this.flushAggregates());
    run('canaries', this.gate.state === 'hold' ? 10_000 : 30_000, () => this.canaryRound());
    run('gate', 10_000, () => this.gateRound());
    run('meta', 30_000, () => this.writeHealth());
    run('purge', 60_000, () => this.purge());
    // Täglich die Prüfungen nachsehen, die wegen robots.txt ruhen (eigene Aufgabe: eine hängende robots.txt hält so
    // keinen Gesundheitseintrag auf)
    run('robots', DAY * 1000, () => this.robotsRecheck());
    const d = new Date(now);
    if (d.getUTCMinutes() === 7) run('retention', 3_000_000, () => this.retention());
    if (d.getUTCHours() === 0 && d.getUTCMinutes() === 20) run('partitions', 3_000_000, () => this.maintainPartitions());
    if (!this.stopping) this.startDue();
    const wake = this.scheduler.nextWake();
    return wake === null ? now + 1000 : Math.min(now + 1000, Math.max(now + 10, wake));
  }

  // Tests: alle angestoßenen Hintergrundaufgaben abwarten
  async settle(): Promise<void> {
    while (this.bg.size) await Promise.all([...this.bg]);
  }

  // Tests: eine regelmäßige Aufgabe sofort fällig machen
  makeDue(task: Periodic): void {
    this.last.delete(task);
  }

  private async syncIfChanged(): Promise<void> {
    const rev = String((await this.metaValue('status_rev')) ?? '');
    if (rev === this.rev) return;
    this.rev = rev;
    await this.reload(false);
  }

  // „Jetzt prüfen“ ohne Neuladen aller Prüfungen
  private async runRequests(): Promise<void> {
    const rows = await withConnection((db) => db.q('SELECT monitor_id, requested_at FROM status_run_requests LIMIT 500'));
    if (!rows.length) return;
    for (const r of rows) {
      const m = this.monitors.get(Number(r.monitor_id));
      if (m && m.active && !this.scheduler.isRunning(m.id) && (m.type === 'http' || m.type === 'system')) this.runNow(m.id);
    }
    await withConnection(async (db) => {
      for (const r of rows) await db.exec('DELETE FROM status_run_requests WHERE monitor_id = ? AND requested_at <= ?', [Number(r.monitor_id), Number(r.requested_at)]);
    });
  }

  private startDue(): void {
    const jobs = this.scheduler.takeRunnable(this.nowMs());
    for (const job of jobs) {
      const m = this.monitors.get(job.id);
      if (!m) {
        this.scheduler.finish(job.id);
        continue;
      }
      const ctrl = new AbortController();
      this.aborts.set(job.id, ctrl);
      const p = this.runJob(m, job, ctrl.signal)
        .catch((err) => this.log(`Status check #${m.id} failed internally: ${(err as Error).message}`))
        .finally(() => {
          this.aborts.delete(job.id);
          this.inflight.delete(job.id);
        });
      this.inflight.set(job.id, p);
    }
  }

  // ---------------------------------------------------------------- eine Prüfung

  private httpDeps(signal?: AbortSignal) {
    return {
      policy: this.policy,
      resolver: this.deps.resolver,
      now: this.deps.clock,
      ipv6: this.deps.ipv6,
      userAgent: this.deps.userAgent,
      takeIp: (ip: string, now: number) => this.scheduler.takeIp(ip, now),
      loopBlocked: () => this.loopP99 > 1e9,
      ca: this.deps.ca,
      signal,
    };
  }

  private async runJob(m: MonitorRt, job: Job, signal: AbortSignal): Promise<void> {
    let reschedule: number | null = null;
    try {
      if (m.type === 'system') {
        reschedule = await this.runSystem(m, job);
        return;
      }
      // robots.txt (höchstens einmal am Tag je Host) vor der Prüfung
      const target = parseTarget(m.target, this.policy);
      if (!target.ok) {
        await this.apply(m, { kind: 'fail', at: this.nowS(), error: 'blocked' }, null);
        return;
      }
      const robots = await this.robotsFor(target.host, target.scheme, target.port);
      if (robots && !robotsAllows(robots, target.path)) {
        await this.autoPause(m, 'robots');
        return;
      }
      const c = m.config;
      const input: HttpCheckInput = {
        url: target.url,
        method: c.method === 'HEAD' ? 'HEAD' : 'GET',
        expect: typeof c.expect === 'string' ? c.expect : '200-299',
        keyword: typeof c.keyword === 'string' ? c.keyword : '',
        keywordMode: c.keyword_mode === 'absent' ? 'absent' : 'contains',
        keywordCase: c.keyword_case === true,
        timeoutSec: Math.min(this.settings.timeout_max, cfgNum(c, 'timeout', 10, 1, 30)),
        redirects: c.redirects !== false,
        tlsIgnore: c.tls_ignore === true,
        slowMs: cfgNum(c, 'slow_ms', 0, 0, 60000),
        keywordKb: this.settings.keyword_kb,
      };
      const started = m.target;
      const out = await runHttpCheck(input, this.httpDeps(signal));
      if (signal.aborted || this.stopping) return;
      // Während der Prüfung geändert: das Ergebnis gehört zum alten Ziel und zählt nicht
      if (m.target !== started) return;
      reschedule = await this.handleHttp(m, out, input);
    } finally {
      this.scheduler.finish(job.id);
      if (this.monitors.get(m.id) === m && m.active && !this.stopping) {
        const intervalMs = m.effectiveInterval * 1000;
        const due = m.runSoon ? this.soon() : (reschedule ?? nextDue(job.origDue ?? job.due, intervalMs, this.nowMs()));
        m.runSoon = false;
        this.scheduler.upsert({ ...job, ...this.jobFields(m), due, notBefore: undefined, origDue: undefined, throttled: false });
      }
    }
  }

  // Ergebnis einer HTTP-Prüfung auswerten; Rückgabe: frühere Wiederholung (ms) oder null (normaler Takt)
  private async handleHttp(m: MonitorRt, out: HttpOutcome, input: HttpCheckInput): Promise<number | null> {
    const at = this.nowS();
    const intervalMs = m.effectiveInterval * 1000;
    if (out.kind === 'throttled') {
      m.throttledAt = at;
      m.dirty = true;
      return this.nowMs() + (out.wait ?? 1000);
    }
    if (out.localError) await this.updateGate({ localErrors: 1 });
    if (out.kind === 'delayed') {
      // 429: der Host pausiert (höchstens eine Stunde), kein Ergebnis
      const pauseS = Math.min(out.retryAfter ?? 60, 3600);
      if (out.host) this.scheduler.pauseHost(out.host, this.nowMs() + pauseS * 1000);
      m.throttledAt = at;
      await this.apply(m, { kind: 'delayed', at, code: out.code, refused: true }, input);
      return this.nowMs() + pauseS * 1000;
    }
    let kind: CheckResult['kind'] = out.kind === 'ok' ? 'ok' : out.kind === 'internal' ? 'internal' : 'fail';
    if (kind === 'fail' && out.error === 'dns' && dnsOutcome({ error: 'dns', transient: out.dnsTransient }, this.gate.canaries.resolverOk) === 'internal') kind = 'internal';
    if (out.host && (kind === 'ok' || kind === 'fail')) this.hostResults.set(out.host, { at, failed: kind === 'fail' });
    const outcome = await this.apply(m, { kind, at, ms: out.ms, code: out.code, error: kind === 'internal' ? 'internal' : out.error, slow: out.slow,
      certExpires: out.certExpires, refused: out.refused }, input);
    if (outcome === 'pending') return this.nowMs() + retryDelay(intervalMs, out.code === 503 ? out.retryAfter : null);
    return null;
  }

  // System-Bestandteile: Rückgabe wie oben
  private async runSystem(m: MonitorRt, job: Job): Promise<number | null> {
    void job;
    const probe = systemProbe(m.target);
    const ctx: ProbeContext = {
      now: this.nowS(),
      facts: this.deps.facts(),
      baseUrl: this.deps.baseUrl,
      healthUrl: this.deps.healthUrl,
      http: (url, keyword) => runHttpCheck({ url, method: 'GET', expect: '200', keyword, keywordMode: 'contains', keywordCase: true, timeoutSec: 10,
        redirects: false, tlsIgnore: false, slowMs: 5000, keywordKb: 16 }, this.httpDeps()),
      meta: (key) => this.metaValue(key),
      dbPing: () => this.dbPing(),
      memory: this.memory,
    };
    const result = probe ? await probe(ctx) : null;
    if (result === null) {
      if (!m.hidden) {
        m.hidden = true;
        m.dirty = true;
      }
      return null;
    }
    m.hidden = false;
    const kind = result.kind;
    const outcome = await this.apply(m, { kind, at: this.nowS(), ms: result.ms ?? null, code: result.code ?? null, error: result.error ?? null, slow: result.slow }, null);
    if (outcome === 'pending') return this.nowMs() + retryDelay(m.effectiveInterval * 1000);
    return null;
  }

  async dbPing(): Promise<number | null> {
    const t = this.nowMs();
    try {
      await withConnection((db) => db.value('SELECT 1'));
      this.dbOk = true;
      return Math.max(0, this.nowMs() - t);
    } catch {
      this.dbOk = false;
      return null;
    }
  }

  private stepConfig(m: MonitorRt): StepConfig {
    const userCheck = m.type === 'http' || m.type === 'heartbeat';
    const gate = userCheck ? this.gate.state : 'ok';
    if (m.type === 'heartbeat' || JOB_HEARTBEATS.has(m.target)) return { retries: 0, slowRun: 255, certWarn: false, gate, maintenance: m.maintenance };
    if (m.type === 'system') return { retries: m.target === 'web' || m.target === 'pages' ? 1 : 0, slowRun: 1, certWarn: false, gate, maintenance: m.maintenance };
    return { retries: cfgNum(m.config, 'retries', 1, 0, 3), slowRun: 3, certWarn: m.config.cert_warn !== false, gate, maintenance: m.maintenance };
  }

  // Ein Ergebnis in Zustand, Rohdaten, Summen und Ereignisse übernehmen
  private async apply(m: MonitorRt, r: CheckResult, input: HttpCheckInput | null): Promise<'pending' | 'done'> {
    const cfg = this.stepConfig(m);
    const userCheck = m.type === 'http' || m.type === 'heartbeat';
    // Geschlossene Sperre: jedes Ergebnis zählt als unsere Seite
    if (userCheck && this.gate.state === 'frozen' && (r.kind === 'ok' || r.kind === 'fail')) r = { ...r, kind: 'internal', error: 'internal' };
    const prevState = m.st.state;
    const prevAt = m.lastResultAt;
    const outcome = step(m.st, r, cfg);
    if (r.kind === 'ok' || r.kind === 'fail') {
      // Zeit seit dem vorigen Ergebnis dem Zustand davor gutschreiben
      // Heartbeats: die Spanne bis zum nächsten Ping ist Periode + Kulanz, nicht der Abstand
      const beat = m.type === 'heartbeat' || JOB_HEARTBEATS.has(m.target);
      const every = beat ? cfgNum(m.config, 'period', 3600, 60, 7 * DAY) : m.effectiveInterval;
      const timeout = beat ? cfgNum(m.config, 'grace', 300, 60, 6 * 3600) : input ? input.timeoutSec : 10;
      const win = creditWindow(prevAt, r.at, every, timeout);
      if (win && prevState !== 'unknown') {
        const kind: SpanKind = cfg.maintenance ? 'maint' : prevState === 'down' ? 'down' : prevState === 'degraded' ? 'degraded' : 'up';
        this.agg.addSpan(m.id, win[0], win[1], kind);
      }
      this.agg.addResult(m.id, r.at, r.kind === 'ok', r.kind === 'ok' ? (r.ms ?? null) : null);
      m.lastResultAt = r.at;
      m.lastCheckAt = r.at;
      m.lastMs = r.ms ?? null;
      m.lastCode = r.code ?? null;
      // Eingeschränkt: der Schlüssel der eigenen Bestandteile (z. B. disk_low), sonst „langsam“
      m.lastError = r.kind === 'ok' ? (r.slow ? (r.error ?? 'degraded') : null) : (r.error ?? null);
      if (r.kind === 'ok') m.lastOkAt = r.at;
      if (r.certExpires !== undefined && r.certExpires !== null) m.certExpires = r.certExpires;
      if (r.kind === 'fail') m.lastFail = { error: r.error ?? null, code: r.code ?? null };
      this.raw.push([m.id, r.at, r.kind === 'ok' ? 1 : 0, r.ms ?? null, r.code ?? null, r.kind === 'ok' ? null : (r.error ?? null)]);
      this.checksDone.push(r.at);
    } else if (r.kind === 'internal') {
      // Nicht abgedeckt: weder auf noch ab
      m.lastResultAt = r.at;
      m.lastCheckAt = r.at;
      m.lastError = 'internal';
      this.raw.push([m.id, r.at, 0, null, null, 'internal']);
    } else if (r.kind === 'unknown') {
      m.lastResultAt = null;
      m.lastCheckAt = r.at;
    }
    m.st = outcome.next;
    m.dirty = true;
    this.recordEvents(m, outcome.events);
    // Selbst anhalten: dreimal hintereinander eine private Adresse, 24 h nur 403/429
    if (m.st.blocked >= BLOCKED_PAUSE_AFTER) await this.autoPause(m, 'private_ip');
    else if (m.type === 'http' && m.st.refusedSince !== null && r.at - m.st.refusedSince >= REFUSED_PAUSE_AFTER) await this.autoPause(m, 'refused');
    return outcome.pending ? 'pending' : 'done';
  }

  private recordEvents(m: MonitorRt, events: StateEvent[]): void {
    for (const ev of events) {
      if (ev.kind === 'down' && ev.since !== undefined && ev.since < ev.at) {
        // Die Zeit seit dem ersten Fehlschlag war Ausfall – aber nur, soweit sie schon abgedeckt ist (bis zum letzten
        // Ergebnis); den Rest bucht das nächste Ergebnis (nach einem „hold“ liegt das Ende von „hold“ später)
        this.agg.addDownBackdate(m.id, ev.since, Math.min(ev.at, m.lastResultAt ?? ev.at));
      }
      this.events.push([m.id, ev.at, ev.kind, ev.error, ev.code]);
      if (ev.kind === 'down' || ev.kind === 'up') {
        this.log(`monitor #${m.id} ${ev.kind}${ev.error ? ` (${ev.error})` : ''}`);
      }
    }
  }

  private async autoPause(m: MonitorRt, why: 'private_ip' | 'refused' | 'robots'): Promise<void> {
    if (m.autoPaused === why) return;
    const at = this.nowS();
    await withConnection((db) => db.exec('UPDATE status_monitors SET auto_paused = ?, auto_paused_at = ? WHERE id = ? AND auto_paused IS NULL', [why, at, m.id]));
    m.autoPaused = why;
    m.active = false;
    this.scheduler.remove(m.id);
    this.events.push([m.id, at, 'paused', why, null]);
    if (why === 'private_ip') this.log(`monitor #${m.id} paused itself: its address points to a private network`);
  }

  // ---------------------------------------------------------------- robots.txt

  private async robotsFor(host: string, scheme: 'http' | 'https', port: number): Promise<RobotsRule[] | null> {
    const now = this.nowS();
    let entry = this.robots.get(host);
    if (!entry) {
      const row = await withConnection((db) => db.one('SELECT robots_at, robots_rules FROM status_host_meta WHERE host = ?', [host]));
      if (row && row.robots_at !== null) {
        entry = { at: Number(row.robots_at), rules: rulesFromJson(row.robots_rules) };
        this.robots.set(host, entry);
      }
    }
    if (!entry || now - entry.at >= ROBOTS_TTL) {
      let loading = this.robotsLoading.get(host);
      if (!loading) {
        loading = this.fetchRobots(host, scheme, port, entry?.rules ?? null).finally(() => this.robotsLoading.delete(host));
        this.robotsLoading.set(host, loading);
      }
      await loading;
      entry = this.robots.get(host);
    }
    return entry ? entry.rules : null;
  }

  private async fetchRobots(host: string, scheme: 'http' | 'https', port: number, previous: RobotsRule[] | null): Promise<void> {
    const defaultPort = scheme === 'https' ? 443 : 80;
    const hostPart = host.includes(':') ? `[${host}]` : host;
    const url = `${scheme}://${hostPart}${port === defaultPort ? '' : ':' + port}/robots.txt`;
    const out = await runHttpCheck({ url, method: 'GET', expect: '100-599', keyword: '', keywordMode: 'contains', keywordCase: false, timeoutSec: 10,
      redirects: true, sameHostOnly: true, tlsIgnore: false, slowMs: 0, keywordKb: 64, readBody: 64 * 1024 }, this.httpDeps());
    const status = out.kind === 'ok' ? out.code : out.kind === 'delayed' ? 429 : null;
    const { rules, error } = robotsAfterFetch(status, out.body ?? null, previous);
    const at = this.nowS();
    this.robots.set(host, { at, rules });
    await withConnection((db) => db.exec('REPLACE INTO status_host_meta (host, robots_at, robots_rules, robots_error) VALUES (?, ?, ?, ?)',
      [host, at, JSON.stringify(rules), error]));
    // Eine Prüfung, die wegen robots.txt ruhte, läuft wieder, sobald die Regeln sie erlauben
    for (const m of this.monitors.values()) {
      if (m.autoPaused !== 'robots' || m.host !== host) continue;
      const t = parseTarget(m.target, this.policy);
      if (t.ok && robotsAllows(rules, t.path)) {
        await withConnection((db) => db.exec("UPDATE status_monitors SET auto_paused = NULL, auto_paused_at = NULL WHERE id = ? AND auto_paused = 'robots'", [m.id]));
        m.autoPaused = null;
        this.events.push([m.id, at, 'resumed', 'robots', null]);
      }
    }
    await this.recompute();
  }

  // Ruhende Prüfungen wegen robots.txt: einmal am Tag nachsehen, ob die Seite es inzwischen erlaubt
  private async robotsRecheck(): Promise<void> {
    const hosts = new Map<string, MonitorRt>();
    for (const m of this.monitors.values()) if (m.autoPaused === 'robots' && !hosts.has(m.host)) hosts.set(m.host, m);
    for (const [host, m] of hosts) {
      const t = parseTarget(m.target, this.policy);
      if (t.ok) await this.robotsFor(host, t.scheme, t.port);
    }
  }

  // ---------------------------------------------------------------- Heartbeats und Jobs (alle 15 s)

  private ingressDown(): boolean {
    return this.gate.ingressDownSince !== null;
  }

  async sweep(): Promise<void> {
    const rows = await withConnection((db) => db.q(`SELECT id, hb_last_ping_at, hb_last_fail_at FROM status_monitors
        WHERE type = 'heartbeat' OR (type = 'system' AND target IN ('job:backup', 'job:weekly'))`));
    const now = this.nowS();
    for (const r of rows) {
      const m = this.monitors.get(Number(r.id));
      if (!m || !m.active) continue;
      m.hbPing = num(r.hb_last_ping_at);
      m.hbFail = num(r.hb_last_fail_at);
      const period = cfgNum(m.config, 'period', 3600, 60, 7 * DAY);
      const grace = cfgNum(m.config, 'grace', 300, 60, 6 * 3600);
      const systemJob = m.type === 'system';
      const v = heartbeatVerdict({
        lastPingAt: m.hbPing, lastFailAt: m.hbFail, period, grace,
        // Jobs schreiben direkt in die Datenbank – unser Eingang spielt für sie keine Rolle
        ingressRecoveredAt: systemJob ? null : this.gate.ingressRecoveredAt,
        ingressDown: systemJob ? false : this.ingressDown(),
      }, m.seen, now);
      if (v.kind === 'none') continue;
      if (v.kind === 'ok') m.seen.ping = v.at;
      else if (v.error === 'hb_failed') m.seen.fail = v.at;
      else m.seen.missedFor = Math.max(m.hbPing ?? 0, systemJob ? 0 : (this.gate.ingressRecoveredAt ?? 0)) + period + grace;
      await this.apply(m, v.kind === 'ok' ? { kind: 'ok', at: v.at } : { kind: 'fail', at: v.at, error: v.error }, null);
    }
  }

  // ---------------------------------------------------------------- Plattform-Sperre

  private async canaryRound(): Promise<void> {
    const timeoutSec = this.deps.canaryTimeoutSec ?? 5;
    const results = await Promise.all(this.deps.canaries.map((url) => runHttpCheck({ url, method: 'GET', expect: '200-399', keyword: '', keywordMode: 'contains',
      keywordCase: false, timeoutSec, redirects: false, tlsIgnore: false, slowMs: 0, keywordKb: 16 }, this.httpDeps())));
    const ok = results.filter((r) => r.kind === 'ok').length;
    const local = results.filter((r) => r.localError).length;
    const resolver = await resolverCanary(this.deps.dnsServers, this.deps.canaryNames, 2500).catch(() => ({ ok: false, answered: 0, of: 0 }));
    await this.updateGate({ canaryRound: { ok, of: results.length, resolverOk: resolver.ok }, localErrors: local });
  }

  private async gateRound(): Promise<void> {
    const now = this.nowS();
    // Verschiedene Hosts der letzten 2 Minuten und wie viele davon scheitern
    let total = 0;
    let failed = 0;
    for (const [host, r] of this.hostResults) {
      if (now - r.at > 120) {
        this.hostResults.delete(host);
        continue;
      }
      total++;
      if (r.failed) failed++;
    }
    // Eingang: web/pages, Tunnel/Ursprung (Sensor), Datenbank, geplantes Fenster, Start der Webseite, Lücke des Dienstes
    const meta = await withConnection((db) => db.q("SELECT meta_key, meta_value FROM oys_meta WHERE meta_key IN ('status_planned', 'status_web_start', 'status_probe')"))
      .catch(() => [] as Array<Record<string, unknown>>);
    const value = (k: string): unknown => meta.find((r) => r.meta_key === k)?.meta_value ?? null;
    const probe = parseJson(value('status_probe'));
    const probeAt = num(probe.at);
    const probeFresh = probeAt !== null && now - probeAt <= 180;
    const part = (k: string): boolean | null => {
      const v = probe[k];
      return probeFresh && v && typeof v === 'object' ? (v as { ok?: unknown }).ok === true : null;
    };
    const sys = (key: string): MonitorRt | undefined => [...this.monitors.values()].find((m) => m.type === 'system' && m.target === key && m.active && !m.hidden);
    const failing = (m: MonitorRt | undefined): boolean => m !== undefined && m.st.state === 'down';
    const unhealthy = failing(sys('web')) || failing(sys('pages')) || part('tunnel') === false || part('origin') === false || !this.dbOk;
    const ingress: IngressSignals = { unhealthy, plannedUntil: num(value('status_planned')), webStart: num(value('status_web_start')), resumedAt: this.resumedAt };
    await this.updateGate({ hosts: { failed, total }, ingress });
  }

  private async updateGate(signals: GateSignals): Promise<void> {
    const before = this.gate.state;
    this.gate = gateStep(this.gate, signals, this.nowS());
    if (this.gate.state === before) return;
    this.log(`Status gate: ${before} → ${this.gate.state}${this.gate.reason ? ` (${this.gate.reason})` : ''}`);
    const now = this.nowS();
    if (before === 'hold' && this.gate.state === 'ok') {
      // Die Ausfälle waren echt: wartende Wechsel jetzt, mit der Zeit des ersten Fehlschlags – bei Websites wie bei
      // Heartbeats (auch deren Frist kann in einem „hold“ ablaufen; gemeldet wird sie nur einmal)
      for (const m of this.monitors.values()) {
        if ((m.type !== 'http' && m.type !== 'heartbeat') || m.st.state === 'down') continue;
        const cfg = this.stepConfig(m);
        const out = releaseHeld(m.st, now, cfg.retries, cfg, m.lastFail);
        if (out.events.length) {
          m.st = out.next;
          m.dirty = true;
          this.recordEvents(m, out.events);
        }
      }
    } else if (this.gate.state === 'frozen') {
      for (const m of this.monitors.values()) {
        if ((m.type === 'http' || m.type === 'heartbeat') && m.st.state !== 'down' && m.st.fails > 0) {
          m.st = discardHeld(m.st);
          m.dirty = true;
        }
      }
    }
    await this.writeGate();
  }

  private async writeGate(): Promise<void> {
    await withConnection((db) => db.exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('status_gate', ?)", [JSON.stringify(gateRecordJson(this.gate))]));
  }

  // ---------------------------------------------------------------- Schreiben

  // Rohdaten, Zustand und Ereignisse alle 5 s in einer Transaktion; schlägt sie fehl, bleibt alles für den nächsten Versuch
  async flush(): Promise<void> {
    const raw = this.raw;
    const events = this.events;
    const dirty = [...this.monitors.values()].filter((m) => m.dirty);
    if (!raw.length && !events.length && !dirty.length) return;
    this.raw = [];
    this.events = [];
    for (const m of dirty) m.dirty = false;
    try {
      await transaction(async (_conn, db) => {
        for (let i = 0; i < raw.length; i += 500) {
          const part = raw.slice(i, i + 500);
          await db.exec(`INSERT IGNORE INTO status_checks (monitor_id, at, ok, ms, code, error) VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`, part.flat());
        }
        for (let i = 0; i < dirty.length; i += 200) {
          const part = dirty.slice(i, i + 200);
          const now = this.nowS();
          await db.exec(`INSERT INTO status_state (monitor_id, state, since, flapping, fails, last_check_at, last_ok_at, last_ms, last_code, last_error,
              cert_expires_at, cert_warned, throttled_at, refused_since, updated_at) VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
            ON DUPLICATE KEY UPDATE state = VALUES(state), since = VALUES(since), flapping = VALUES(flapping), fails = VALUES(fails),
              last_check_at = VALUES(last_check_at), last_ok_at = VALUES(last_ok_at), last_ms = VALUES(last_ms), last_code = VALUES(last_code),
              last_error = VALUES(last_error), cert_expires_at = VALUES(cert_expires_at), cert_warned = VALUES(cert_warned),
              throttled_at = VALUES(throttled_at), refused_since = VALUES(refused_since), updated_at = VALUES(updated_at)`,
          part.flatMap((m) => [m.id, m.st.state, m.st.since, m.st.flapping ? 1 : 0, Math.min(255, m.st.fails), m.lastCheckAt, m.lastOkAt,
            m.lastMs === null ? null : Math.max(0, Math.round(m.lastMs)), m.lastCode, m.lastError === null ? null : m.lastError.slice(0, 20), m.certExpires,
            m.st.certWarned, m.throttledAt, m.st.refusedSince, now]));
        }
        for (let i = 0; i < events.length; i += 500) {
          const part = events.slice(i, i + 500);
          await db.exec(`INSERT INTO status_events (monitor_id, at, kind, error, code) VALUES ${part.map(() => '(?, ?, ?, ?, ?)').join(', ')}`,
            part.map((e) => [e[0], e[1], e[2], e[3] === null ? null : e[3].slice(0, 20), e[4]]).flat());
        }
      });
      this.dbOk = true;
    } catch (err) {
      this.raw = raw.concat(this.raw);
      this.events = events.concat(this.events);
      for (const m of dirty) m.dirty = true;
      this.dbOk = false;
      throw err;
    }
  }

  // Summen je Stunde und Tag alle 10 s (eine Transaktion; schlägt sie fehl, kommen dieselben Änderungen zurück).
  // ms_min/ms_max: LEAST/GREATEST mit COALESCE auf beiden Seiten – ein NULL (keine Antwortzeit) löscht nichts.
  async flushAggregates(): Promise<void> {
    if (!this.agg.size) return;
    const data = this.agg.take();
    const seconds = (cap: number): string => ['covered_s', 'down_s', 'degraded_s', 'maint_s'].map((c) => `${c} = LEAST(${cap}, ${c} + VALUES(${c}))`).join(', ');
    const counters = 'checks = checks + VALUES(checks), fails = fails + VALUES(fails), ms_sum = ms_sum + VALUES(ms_sum), ms_count = ms_count + VALUES(ms_count), '
      + 'ms_max = GREATEST(COALESCE(ms_max, VALUES(ms_max)), COALESCE(VALUES(ms_max), ms_max))';
    const capped = (b: Bucket, cap: number): number[] => [Math.min(cap, b.covered_s), Math.min(cap, b.down_s), Math.min(cap, b.degraded_s), Math.min(cap, b.maint_s)];
    try {
      await transaction(async (_conn, db) => {
        for (let i = 0; i < data.hourly.length; i += 300) {
          const part = data.hourly.slice(i, i + 300);
          await db.exec(`INSERT INTO status_hourly (monitor_id, hour, checks, fails, ms_sum, ms_count, ms_min, ms_max, covered_s, down_s, degraded_s, maint_s)
            VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
            ON DUPLICATE KEY UPDATE ${counters}, ms_min = LEAST(COALESCE(ms_min, VALUES(ms_min)), COALESCE(VALUES(ms_min), ms_min)), ${seconds(3600)}`,
          part.flatMap(([id, hour, b]) => [id, hour, b.checks, b.fails, b.ms_sum, b.ms_count, b.ms_min, b.ms_max, ...capped(b, 3600)]));
        }
        for (let i = 0; i < data.daily.length; i += 300) {
          const part = data.daily.slice(i, i + 300);
          await db.exec(`INSERT INTO status_daily (monitor_id, day, checks, fails, ms_sum, ms_count, ms_max, covered_s, down_s, degraded_s, maint_s)
            VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
            ON DUPLICATE KEY UPDATE ${counters}, ${seconds(90000)}`,
          part.flatMap(([id, day, b]) => [id, day, b.checks, b.fails, b.ms_sum, b.ms_count, b.ms_max, ...capped(b, 90000)]));
        }
      });
    } catch (err) {
      this.agg.merge(data);
      throw err;
    }
  }

  // Gesundheitseintrag für Admin und Sensor (alle 30 s)
  async writeHealth(): Promise<void> {
    const now = this.nowS();
    this.policy = this.deps.policy(this.settings);
    this.loopP99 = this.loopDelay.percentile(99);
    this.loopDelay.reset();
    this.checksDone = this.checksDone.filter((t) => t > now - 60);
    let active = 0;
    let paused = 0;
    for (const m of this.monitors.values()) {
      if (m.type === 'manual' || m.hidden) continue;
      if (m.active) active++;
      else paused++;
    }
    const record = {
      at: now, pid: process.pid, started: this.started, version: CHECKER_VERSION,
      monitors: { active, paused }, checks_min: this.checksDone.length, inflight: this.scheduler.inflight,
      delayed_10m: this.scheduler.delayed10m(this.nowMs()), lag_p95_ms: this.scheduler.lagP95(this.nowMs()),
    };
    await withConnection(async (db) => {
      await db.exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('status_worker', ?)", [JSON.stringify(record)]);
      await db.exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('status_gate', ?)", [JSON.stringify(gateRecordJson(this.gate))]);
    });
    this.dbOk = true;
    // Kurze Zusammenfassung im Protokoll etwa alle 10 Minuten
    if (now % 600 < 30) {
      this.log(`Status checks: ${record.checks_min} in the last minute, ${record.delayed_10m} delayed in 10 min, lag p95 ${(record.lag_p95_ms / 1000).toFixed(1)} s`);
    }
  }

  // ---------------------------------------------------------------- Aufräumen

  private async batchDelete(sql: string, params: Array<string | number>): Promise<number> {
    let total = 0;
    for (;;) {
      const res = await withConnection((db) => db.exec(sql + ' LIMIT 5000', params));
      total += res.affectedRows;
      if (res.affectedRows < 5000 || this.stopping) return total;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // Daten gelöschter Prüfungen und Seiten (jede Minute). Vertrag für alle, die löschen (Editor, Admin, Löschen eines
  // Kontos): die Zeilen in status_monitors sind dann schon weg – deshalb je gelöschter Prüfung eine Zeile 'monitor'
  // (Zustand, Summen, Ereignisse) und je gelöschter Seite eine Zeile 'page' (Ausgang, alte Adressen). Eine Zeile 'page'
  // allein findet die Prüfungen der Seite nicht mehr.
  async purge(): Promise<void> {
    const rows = await withConnection((db) => db.q('SELECT id, kind, ref_id FROM status_purge ORDER BY id LIMIT 100'));
    for (const r of rows) {
      const ref = Number(r.ref_id);
      if (r.kind === 'monitor') {
        for (const table of ['status_hourly', 'status_daily', 'status_events', 'status_incident_monitors', 'status_run_requests']) {
          await this.batchDelete(`DELETE FROM ${table} WHERE monitor_id = ?`, [ref]);
        }
        await withConnection((db) => db.exec('DELETE FROM status_state WHERE monitor_id = ?', [ref]));
      } else if (r.kind === 'page') {
        await this.batchDelete('DELETE FROM status_outbox WHERE page_id = ?', [ref]);
        await this.batchDelete('DELETE FROM status_slug_redirects WHERE page_id = ?', [ref]);
      }
      await withConnection((db) => db.exec('DELETE FROM status_purge WHERE id = ?', [Number(r.id)]));
    }
  }

  // Aufbewahrung (stündlich um :07)
  async retention(): Promise<void> {
    const s = this.settings;
    const now = this.nowS();
    await this.batchDelete('DELETE FROM status_events WHERE at < ?', [now - s.events_days * DAY]);
    await this.batchDelete('DELETE FROM status_hourly WHERE hour < ?', [now - s.hourly_days * DAY]);
    await this.batchDelete('DELETE FROM status_daily WHERE day < ?', [new Date((now - s.daily_days * DAY) * 1000).toISOString().slice(0, 10)]);
    await this.batchDelete("DELETE FROM status_outbox WHERE state <> 'pending' AND created_at < ?", [now - 30 * DAY]);
    await this.batchDelete("DELETE FROM status_channels WHERE verified_at IS NULL AND type = 'email' AND created_at < ?", [new Date((now - 7 * DAY) * 1000).toISOString().slice(0, 19).replace('T', ' ')]);
    await this.batchDelete('DELETE FROM status_slug_redirects WHERE until < ?', [now]);
    // Ohne Partitionen: alte Rohdaten in Schritten löschen
    if (!(await this.partitioned())) await this.batchDelete('DELETE FROM status_checks WHERE at < ?', [utcDay(now) - s.raw_days * DAY]);
  }

  private async partitioned(): Promise<boolean> {
    const rows = await withConnection((db) => db.q("SELECT PARTITION_NAME FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'status_checks' AND PARTITION_NAME IS NOT NULL"));
    return rows.length > 0;
  }

  // Tagespartitionen: drei Tage voraus anlegen, Tage älter als raw_days entfernen (täglich 00:20 UTC und beim Start)
  async maintainPartitions(): Promise<void> {
    const rows = await withConnection((db) => db.q(`SELECT PARTITION_NAME AS name FROM information_schema.PARTITIONS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'status_checks' AND PARTITION_NAME IS NOT NULL ORDER BY PARTITION_ORDINAL_POSITION`));
    if (!rows.length) return;
    const names = rows.map((r) => String(r.name));
    const now = this.nowS();
    const days = names.map(partitionDay).filter((d): d is number => d !== null);
    const lastDay = days.length ? Math.max(...days) : utcDay(now) - DAY;
    const missing = partitionPlan(now).filter((p) => p.day > lastDay);
    if (missing.length && names.includes('pmax')) {
      const parts = missing.map((p) => `PARTITION ${p.name} VALUES LESS THAN (${p.lessThan})`);
      await withConnection((db) => db.exec(`ALTER TABLE status_checks REORGANIZE PARTITION pmax INTO (${parts.join(', ')}, PARTITION pmax VALUES LESS THAN MAXVALUE)`));
    }
    // Älter als raw_days (die jüngste Partition bleibt immer)
    const keepFrom = utcDay(now) - this.settings.raw_days * DAY;
    const old = names.filter((n) => {
      const d = partitionDay(n);
      return d !== null && d < keepFrom;
    });
    const remaining = names.filter((n) => n !== 'pmax').length + missing.length - old.length;
    if (old.length && remaining >= 1) {
      await withConnection((db) => db.exec(`ALTER TABLE status_checks DROP PARTITION ${old.join(', ')}`));
    }
  }

  // ---------------------------------------------------------------- Ende

  // Alle laufenden Prüfungen abwarten (Tests, Ende des Dienstes)
  async idle(timeoutMs = 10_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (this.inflight.size && Date.now() < until) {
      await Promise.race([Promise.all([...this.inflight.values()]), new Promise((r) => setTimeout(r, Math.max(1, until - Date.now())))]);
    }
  }

  // Ende: nichts Neues mehr, laufende höchstens 10 s, dann alles schreiben
  async stop(abortRunning = false): Promise<void> {
    this.stopping = true;
    if (abortRunning) for (const c of this.aborts.values()) c.abort();
    await this.idle(abortRunning ? 2000 : 10_000);
    for (const c of this.aborts.values()) c.abort();
    this.loopDelay.disable();
    if (!abortRunning) {
      await this.flush().catch((err) => this.log(`Status checker: final write failed – ${(err as Error).message}`));
      await this.flushAggregates().catch(() => undefined);
      await this.writeHealth().catch(() => undefined);
    }
  }

  // Tests und „Jetzt prüfen“: eine eingeplante Prüfung sofort fällig machen
  runNow(id: number): boolean {
    const job = this.scheduler.queuedJob(id);
    if (!job) return false;
    this.scheduler.upsert({ ...job, due: this.nowMs(), notBefore: undefined });
    return true;
  }

  // Für Tests und das Admin: Momentaufnahme eines Bestandteils
  snapshot(id: number): { state: StateRecord; active: boolean; hidden: boolean; lastError: string | null; autoPaused: string | null } | null {
    const m = this.monitors.get(id);
    return m ? { state: m.st, active: m.active, hidden: m.hidden, lastError: m.lastError, autoPaused: m.autoPaused } : null;
  }
}
