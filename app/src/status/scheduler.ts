// Statusseiten: Zeitplan des Prüfdienstes (ohne Netz, mit einstellbarer Uhr). Ein Min-Heap nach Fälligkeit; der erste
// Lauf verteilt sich gleichmäßig (crc32(id) mod Abstand), danach ohne Drift (vorige Fälligkeit + Abstand). Höflichkeit:
// Token-Eimer je Host, je registrierbarer Domain und je aufgelöster IP; dazu Obergrenzen für gleichzeitige Prüfungen
// (insgesamt, mit Stichwort, je Nutzer, je Prüfung genau eine). 429 pausiert den Host. Zeiten in Millisekunden.

export interface SchedulerOptions {
  concurrency: number; // gleichzeitig insgesamt (1000)
  keywordConcurrency: number; // davon mit Stichwort (64)
  userInflight: number; // je Nutzer (32)
  hostPerMin: number; // Anfragen je Host und Minute (30, Stoß 5)
  domainPerMin: number; // je registrierbarer Domain (60, Stoß 10)
  ipPerMin: number; // je aufgelöster IP (3000, Stoß 100)
}

export interface Job {
  id: number;
  due: number; // fällig ab (ms)
  userId: number | null; // null = OnYourSites Seite (keine Grenze je Nutzer)
  host: string; // '' = keine Netzprüfung (Heartbeat, System ohne Ziel)
  domain: string;
  keyword: boolean;
  notBefore?: number; // wegen Höflichkeit verschoben bis …
  throttled?: boolean; // zuletzt wegen der Eimer verschoben
  origDue?: number; // ursprüngliche Fälligkeit, solange die Kapazität nicht reicht (für die Verzögerung)
}

// ---------------------------------------------------------------- Min-Heap

export class DueHeap {
  private readonly items: Job[] = [];
  private readonly index = new Map<number, number>();

  get size(): number {
    return this.items.length;
  }

  has(id: number): boolean {
    return this.index.has(id);
  }

  get(id: number): Job | undefined {
    const i = this.index.get(id);
    return i === undefined ? undefined : this.items[i];
  }

  peek(): Job | undefined {
    return this.items[0];
  }

  push(job: Job): void {
    if (this.index.has(job.id)) this.remove(job.id);
    this.items.push(job);
    this.index.set(job.id, this.items.length - 1);
    this.up(this.items.length - 1);
  }

  pop(): Job | undefined {
    if (!this.items.length) return undefined;
    const top = this.items[0];
    this.removeAt(0);
    return top;
  }

  remove(id: number): Job | undefined {
    const i = this.index.get(id);
    if (i === undefined) return undefined;
    const job = this.items[i];
    this.removeAt(i);
    return job;
  }

  private removeAt(i: number): void {
    const last = this.items.length - 1;
    this.index.delete(this.items[i].id);
    if (i !== last) {
      this.items[i] = this.items[last];
      this.index.set(this.items[i].id, i);
    }
    this.items.pop();
    if (i < this.items.length) {
      this.down(i);
      this.up(i);
    }
  }

  private swap(a: number, b: number): void {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    this.index.set(this.items[a].id, a);
    this.index.set(this.items[b].id, b);
  }

  private up(i: number): void {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.items[p].due <= this.items[i].due) break;
      this.swap(p, i);
      i = p;
    }
  }

  private down(i: number): void {
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < this.items.length && this.items[l].due < this.items[m].due) m = l;
      if (r < this.items.length && this.items[r].due < this.items[m].due) m = r;
      if (m === i) return;
      this.swap(m, i);
      i = m;
    }
  }
}

// ---------------------------------------------------------------- Takt

// CRC-32 einer Zahl (verteilt die ersten Läufe gleichmäßig)
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
export function crc32(value: number | string): number {
  const bytes = Buffer.from(String(value), 'utf8');
  let c = -1;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// Erster Lauf: nach der letzten Prüfung + Abstand; überfällig oder nie geprüft → über den Abstand verteilt
export function firstDue(id: number, intervalMs: number, lastCheckAtMs: number | null, now: number): number {
  if (lastCheckAtMs !== null) {
    const anchored = lastCheckAtMs + intervalMs;
    if (anchored >= now) return anchored;
  }
  return now + (crc32(id) % Math.max(1, intervalMs));
}

// Nächster Lauf ohne Drift; liegt er mehr als einen Abstand zurück, ab jetzt neu
export function nextDue(prevDue: number, intervalMs: number, now: number): number {
  const d = prevDue + intervalMs;
  return now - d > intervalMs ? now + intervalMs : d;
}

// Wiederholung nach einem Fehlschlag: min(20 s, Abstand/3); ein 503 mit Retry-After höchstens bis zum Abstand später
export function retryDelay(intervalMs: number, retryAfterSec: number | null = null): number {
  const normal = Math.min(20_000, Math.floor(intervalMs / 3));
  if (retryAfterSec === null || !(retryAfterSec > 0)) return normal;
  return Math.max(normal, Math.min(retryAfterSec * 1000, intervalMs));
}

// ---------------------------------------------------------------- Token-Eimer

export class TokenBucket {
  private tokens: number;
  private at: number;
  constructor(private readonly perMin: number, private readonly burst: number, now: number) {
    this.tokens = burst;
    this.at = now;
  }

  private refill(now: number): void {
    if (now > this.at) {
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) * this.perMin) / 60_000);
      this.at = now;
    }
  }

  // 0 = genommen, sonst Wartezeit in ms bis zum nächsten Token
  take(now: number): number {
    this.refill(now);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil(((1 - this.tokens) * 60_000) / this.perMin));
  }

  // Zurückgeben (eine Prüfung startete doch nicht)
  refund(): void {
    this.tokens = Math.min(this.burst, this.tokens + 1);
  }

  full(now: number): boolean {
    this.refill(now);
    return this.tokens >= this.burst;
  }
}

class Buckets {
  private readonly map = new Map<string, TokenBucket>();
  constructor(private readonly perMin: number, private readonly burst: number) {}
  get(key: string, now: number): TokenBucket {
    let b = this.map.get(key);
    if (!b) {
      b = new TokenBucket(this.perMin, this.burst, now);
      this.map.set(key, b);
    }
    return b;
  }
  // volle Eimer vergessen (sonst wächst die Liste mit jedem Host)
  prune(now: number): void {
    for (const [k, b] of this.map) if (b.full(now)) this.map.delete(k);
  }
}

// ---------------------------------------------------------------- Zeitplan

export class Scheduler {
  private readonly heap = new DueHeap();
  private readonly running = new Map<number, Job>();
  private readonly hosts: Buckets;
  private readonly domains: Buckets;
  private readonly ips: Buckets;
  private readonly pausedHosts = new Map<string, number>(); // Host → bis (429)
  private readonly users = new Map<number, number>(); // Nutzer → laufende Prüfungen
  private keywordRunning = 0;
  private readonly lags: Array<[number, number]> = []; // [Start, Verzögerung]
  private readonly delays: number[] = []; // Zeitpunkte, an denen eine Prüfung wegen Höflichkeit warten musste
  private lastPrune = 0;

  constructor(readonly opts: SchedulerOptions) {
    this.hosts = new Buckets(opts.hostPerMin, 5);
    this.domains = new Buckets(opts.domainPerMin, 10);
    this.ips = new Buckets(opts.ipPerMin, 100);
  }

  get queued(): number {
    return this.heap.size;
  }

  get inflight(): number {
    return this.running.size;
  }

  get keywordInflight(): number {
    return this.keywordRunning;
  }

  isRunning(id: number): boolean {
    return this.running.has(id);
  }

  has(id: number): boolean {
    return this.heap.has(id) || this.running.has(id);
  }

  queuedJob(id: number): Job | undefined {
    return this.heap.get(id);
  }

  // Neu einplanen oder ändern (eine laufende Prüfung bleibt laufend; der Aufrufer plant sie nach dem Ende neu)
  upsert(job: Job): void {
    if (this.running.has(job.id)) return;
    this.heap.push({ ...job });
  }

  remove(id: number): void {
    this.heap.remove(id);
  }

  // Frühester Zeitpunkt, an dem etwas fällig wird
  nextWake(): number | null {
    return this.heap.peek()?.due ?? null;
  }

  pauseHost(host: string, until: number): void {
    if (host !== '') this.pausedHosts.set(host, Math.max(until, this.pausedHosts.get(host) ?? 0));
  }

  hostPausedUntil(host: string, now: number): number | null {
    const until = this.pausedHosts.get(host);
    if (until === undefined) return null;
    if (until <= now) {
      this.pausedHosts.delete(host);
      return null;
    }
    return until;
  }

  // Alles Fällige, das die Grenzen erlauben, herausnehmen; der Rest wartet (Höflichkeit: bis der Eimer reicht,
  // Kapazität: 250 ms)
  takeRunnable(now: number, max = Number.MAX_SAFE_INTEGER): Job[] {
    const out: Job[] = [];
    const later: Job[] = [];
    while (out.length < max) {
      const top = this.heap.peek();
      if (!top || top.due > now) break;
      this.heap.pop();
      const job = top;
      if (this.running.size >= this.opts.concurrency || (job.keyword && this.keywordRunning >= this.opts.keywordConcurrency)
        || (job.userId !== null && (this.users.get(job.userId) ?? 0) >= this.opts.userInflight)) {
        later.push({ ...job, due: now + 250, origDue: job.origDue ?? job.due });
        continue;
      }
      if (job.host !== '') {
        const paused = this.hostPausedUntil(job.host, now);
        if (paused !== null) {
          later.push({ ...job, due: paused, notBefore: paused, throttled: true });
          this.delays.push(now);
          continue;
        }
        const hb = this.hosts.get(job.host, now);
        const waitHost = hb.take(now);
        if (waitHost > 0) {
          later.push({ ...job, due: now + waitHost, notBefore: now + waitHost, throttled: true });
          this.delays.push(now);
          continue;
        }
        const db = this.domains.get(job.domain || job.host, now);
        const waitDomain = db.take(now);
        if (waitDomain > 0) {
          hb.refund();
          later.push({ ...job, due: now + waitDomain, notBefore: now + waitDomain, throttled: true });
          this.delays.push(now);
          continue;
        }
      }
      const started = { ...job, throttled: false };
      this.running.set(job.id, started);
      if (job.keyword) this.keywordRunning++;
      if (job.userId !== null) this.users.set(job.userId, (this.users.get(job.userId) ?? 0) + 1);
      this.lags.push([now, Math.max(0, now - Math.max(job.origDue ?? job.due, job.notBefore ?? 0))]);
      out.push(started);
    }
    for (const j of later) this.heap.push(j);
    if (now - this.lastPrune > 60_000) this.prune(now);
    return out;
  }

  // Nach der Namensauflösung: darf diese IP jetzt? 0 = ja, sonst Wartezeit in ms
  takeIp(ip: string, now: number): number {
    const wait = this.ips.get(ip, now).take(now);
    if (wait > 0) this.delays.push(now);
    return wait;
  }

  // Eine Prüfung ist fertig (oder wurde abgebrochen) – gibt ihre Plätze frei
  finish(id: number): Job | undefined {
    const job = this.running.get(id);
    if (!job) return undefined;
    this.running.delete(id);
    if (job.keyword) this.keywordRunning--;
    if (job.userId !== null) {
      const n = (this.users.get(job.userId) ?? 1) - 1;
      if (n > 0) this.users.set(job.userId, n);
      else this.users.delete(job.userId);
    }
    return job;
  }

  private prune(now: number): void {
    this.lastPrune = now;
    this.hosts.prune(now);
    this.domains.prune(now);
    this.ips.prune(now);
    for (const [h, until] of this.pausedHosts) if (until <= now) this.pausedHosts.delete(h);
    this.trim(now);
  }

  private trim(now: number): void {
    const cut = now - 600_000;
    while (this.lags.length && this.lags[0][0] < cut) this.lags.shift();
    while (this.delays.length && this.delays[0] < cut) this.delays.shift();
    if (this.lags.length > 200_000) this.lags.splice(0, this.lags.length - 200_000);
  }

  // p95 der Verzögerung (Start − Fälligkeit) der letzten 10 Minuten
  lagP95(now: number): number {
    this.trim(now);
    if (!this.lags.length) return 0;
    const sorted = this.lags.map((l) => l[1]).sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  }

  // Wie oft in den letzten 10 Minuten wegen Höflichkeit verschoben
  delayed10m(now: number): number {
    this.trim(now);
    return this.delays.length;
  }
}
