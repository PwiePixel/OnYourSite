// Gemeinsamer Hintergrund-Läufer (honeycomb-shop §4.13): Bereiche melden ihre Aufgaben an (registerJob, registerNightly),
// `cli.js jobs:tick` startet alle 5 Minuten (systemd-Timer onyoursite-jobs.timer) und führt aus, was fällig ist.
// - Je Aufgabe eine Datenbanksperre GET_LOCK('oys_job_<name>', 0): ist sie belegt (ein Lauf dauert noch), wird die
//   Aufgabe übersprungen – so läuft jede Aufgabe genau einmal, egal wie viele Läufer starten.
// - Ist das Schema älter als nötig (die neue Version ist gebaut, migrate lief noch nicht), passiert nichts.
// - Jeder Lauf schreibt {at (Unix-Sekunden), every (Sekunden), ok, error, ms} nach oys_meta['jobs'] – die Statusseite
//   meldet den Läufer als verspätet, wenn ein Lauf länger als 3 × every her ist (status/system.ts, job:runner).
// - Nächtliche Aufgaben laufen im ersten Durchgang nach 04:00 Ortszeit, einmal am Tag (auch eine fehlgeschlagene erst
//   am nächsten Tag wieder).
// Im Web-Prozess läuft nichts davon (keine Zeitgeber), also nie doppelt.
import { withConnection, withLockConnection, type Db } from '../db.js';
import { date, intval, mbSubstr, time } from '../php.js';
import { schemaVersion } from '../schema.js';

export interface JobContext {
  deadline: number; // Unix-Millisekunden: danach keine neuen Zeilen mehr anfangen
  log: (line: string) => void;
}

export interface Job {
  name: string;
  everyMinutes: number;
  minSchema: number;
  budgetSec: number;
  run: (c: JobContext) => Promise<void>;
}

interface Nightly { name: string; minSchema: number; run: (c: JobContext) => Promise<void> }

const jobs = new Map<string, Job>();
const nightlies = new Map<string, Nightly>();
const NAME = /^[a-z][a-z0-9_-]{0,39}$/;
export const NIGHTLY_HOUR = 4;
export const JOBS_META_KEY = 'jobs';

export function registerJob(j: Job): void {
  if (!NAME.test(j.name) || jobs.has(j.name)) throw new Error(`registerJob: invalid or duplicate name ${j.name}`);
  if (!Number.isInteger(j.everyMinutes) || j.everyMinutes < 1) throw new Error(`registerJob(${j.name}): everyMinutes must be ≥ 1`);
  jobs.set(j.name, j);
}

export function registerNightly(name: string, run: (c: JobContext) => Promise<void>, minSchema = 0): void {
  if (!NAME.test(name) || nightlies.has(name)) throw new Error(`registerNightly: invalid or duplicate name ${name}`);
  nightlies.set(name, { name, minSchema, run });
}

export function unregisterJobsForTests(): void {
  jobs.clear();
  nightlies.clear();
}

export const registeredJobs = (): string[] => [...jobs.keys()];

export interface JobRun { at: number; every: number; ok: boolean; error: string; ms: number; day?: string }
export type JobsState = Record<string, JobRun>;

async function readState(db: Db): Promise<JobsState> {
  const raw = await db.value('SELECT meta_value FROM oys_meta WHERE meta_key = ?', [JOBS_META_KEY]);
  try {
    const o = JSON.parse(String(raw ?? '{}'));
    return o !== null && typeof o === 'object' && !Array.isArray(o) ? o as JobsState : {};
  } catch {
    return {};
  }
}

// Nur die eigene Zeile ändern (andere Aufgaben können gleichzeitig schreiben): unter einer kurzen Sperre lesen und schreiben
async function writeRun(db: Db, key: string, run: JobRun): Promise<void> {
  const [lock] = await db.q("SELECT GET_LOCK('oys_jobs_meta', 5) AS l");
  // Ohne die Sperre lieber nicht schreiben (sonst ginge der Eintrag einer anderen Aufgabe verloren)
  if (intval(lock?.l) !== 1) throw new Error('the jobs state is locked by another run');
  try {
    const st = await readState(db);
    st[key] = run;
    await db.exec('REPLACE INTO oys_meta (meta_key, meta_value) VALUES (?, ?)', [JOBS_META_KEY, JSON.stringify(st)]);
  } finally {
    await db.q("SELECT RELEASE_LOCK('oys_jobs_meta')");
  }
}

export async function jobsState(db?: Db): Promise<JobsState> {
  return db ? readState(db) : withConnection((d) => readState(d));
}

export interface TickResult { name: string; outcome: 'ran' | 'failed' | 'busy' | 'not-due' | 'schema' }

// Ein Durchgang. now: Unix-Sekunden (Tests geben eine Zeit vor); force: auch nicht fällige Aufgaben laufen lassen
export async function tick(opts: { now?: number; force?: boolean; log?: (line: string) => void } = {}): Promise<TickResult[]> {
  const now = opts.now ?? time();
  const log = opts.log ?? ((line: string) => console.log(line));
  const out: TickResult[] = [];
  const work: Array<{ key: string; lockName: string; minSchema: number; budgetSec: number; every: number; run: Job['run']; due: (st: JobsState) => boolean }> = [];
  for (const j of jobs.values()) {
    work.push({ key: j.name, lockName: 'oys_job_' + j.name, minSchema: j.minSchema, budgetSec: j.budgetSec, every: j.everyMinutes * 60, run: j.run,
      // 30 Sekunden Spielraum: ein Timer alle 5 Minuten trifft „alle 15 Minuten“ sonst nur jedes vierte Mal
      due: (st) => opts.force === true || !st[j.name] || now - lastAt(st[j.name]) >= j.everyMinutes * 60 - 30 });
  }
  const today = date('Y-m-d', now);
  const afterFour = intval(date('G', now)) >= NIGHTLY_HOUR;
  for (const n of nightlies.values()) {
    work.push({ key: 'nightly:' + n.name, lockName: 'oys_nightly_' + n.name, minSchema: n.minSchema, budgetSec: 600, every: 86400, run: n.run,
      due: (st) => opts.force === true || (afterFour && st['nightly:' + n.name]?.day !== today) });
  }
  for (const w of work) {
    const r = await withLockConnection(async (db) => {
      if (!w.due(await readState(db))) return 'not-due' as const;
      const [lock] = await db.q('SELECT GET_LOCK(?, 0) AS l', [w.lockName]);
      if (intval(lock?.l) !== 1) return 'busy' as const;
      try {
        // Unter der Sperre noch einmal: ein anderer Läufer kann eben fertig geworden sein
        if (!w.due(await readState(db))) return 'not-due' as const;
        const version = await withConnection(async (_d, conn) => schemaVersion(conn));
        if (version < w.minSchema) {
          log(`${w.key}: schema too old – skipped`);
          return 'schema' as const;
        }
        const start = Date.now();
        let error = '';
        try {
          await w.run({ deadline: start + w.budgetSec * 1000, log: (line) => log(`${w.key}: ${line}`) });
        } catch (err) {
          error = mbSubstr(err instanceof Error ? err.message : String(err), 0, 300);
          log(`${w.key}: failed: ${error}`);
        }
        await writeRun(db, w.key, { at: now, every: w.every, ok: error === '', error, ms: Date.now() - start, ...(w.key.startsWith('nightly:') ? { day: today } : {}) });
        return error === '' ? 'ran' as const : 'failed' as const;
      } finally {
        await db.q('SELECT RELEASE_LOCK(?)', [w.lockName]);
      }
    });
    out.push({ name: w.key, outcome: r });
  }
  return out;
}

// Zeit des letzten Laufs (Unix-Sekunden); Unlesbares gilt als lange her
const lastAt = (r: JobRun): number => (typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : 0);
