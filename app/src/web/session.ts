// Sitzungen wie PHP: Cookie PHPSESSID (nur für diesen Host, HttpOnly, SameSite=Lax, secure bei https), gespeichert in
// der Datenbank statt in Dateien. Unbekannte IDs bekommen eine neue (strict mode); nach 24 Minuten ohne Aufruf läuft
// eine Sitzung ab. Je Sitzung läuft immer nur eine Anfrage gleichzeitig (wie die Dateisperre von PHP).
// Die Tabelle oys_sessions legt schema.ts an (Version 5).
import { randomBytes } from 'node:crypto';
import { exec, one } from '../db.js';
import { configInt, configString } from '../config.js';
import type { Ctx } from './ctx.js';

export const SESSION_COOKIE = 'PHPSESSID';
type SessionData = Record<string, unknown>;

const idleSeconds = () => configInt('session_idle_seconds', 1440);
const now = () => Math.floor(Date.now() / 1000);

// Eine Anfrage je Sitzung zur Zeit
const locks = new Map<string, Promise<void>>();
async function lock(id: string): Promise<() => void> {
  const prev = locks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chain = prev.then(() => mine);
  locks.set(id, chain);
  await prev;
  return () => {
    release();
    if (locks.get(id) === chain) locks.delete(id);
  };
}

// 32 Zeichen aus [0-9a-v] wie die IDs von PHP (160 Bit)
function newId(): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuv';
  const bytes = randomBytes(32);
  let id = '';
  for (const b of bytes) id += alphabet[b & 31];
  return id;
}

export class Session {
  id: string;
  data: SessionData = {};
  private original = '{}';
  private destroyed = false;
  private release: (() => void) | null = null;
  private oldIds: string[] = [];
  // Abfrage im Hintergrund (Glocke): liest die Sitzung, zählt aber nicht als Aktivität – die Zeit bis zum Abmelden
  // nach session_idle_seconds läuft weiter. lastSeen: die gespeicherte Zeit der letzten Aktivität
  private background = false;
  private lastSeen = 0;

  private constructor(private ctx: Ctx, id: string) {
    this.id = id;
  }

  // session_start()
  static async start(ctx: Ctx): Promise<Session> {
    if (ctx.session) return ctx.session;
    const cookieId = ctx.cookie(SESSION_COOKIE);
    let session: Session | null = null;
    if (cookieId && /^[0-9a-zA-Z,-]{22,64}$/.test(cookieId)) {
      const release = await lock(cookieId);
      const row = await one<{ data: string; last_seen: number }>('SELECT data, last_seen FROM oys_sessions WHERE id = ?', [cookieId]);
      if (row && now() - Number(row.last_seen) <= idleSeconds()) {
        session = new Session(ctx, cookieId);
        session.release = release;
        session.lastSeen = Number(row.last_seen);
        try {
          session.data = JSON.parse(row.data) as SessionData;
        } catch {
          session.data = {};
        }
        session.original = JSON.stringify(session.data);
      } else {
        release();
      }
    }
    if (!session) {
      session = new Session(ctx, newId());
      session.release = await lock(session.id);
      session.original = '';
      session.sendCookie();
    }
    // Was PHP bei session_start() von selbst schickt (cache_limiter nocache)
    ctx.header('Expires', 'Thu, 19 Nov 1981 08:52:00 GMT');
    ctx.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    ctx.header('Pragma', 'no-cache');
    ctx.session = session;
    return session;
  }

  get<T = unknown>(key: string): T | undefined {
    return this.data[key] as T | undefined;
  }
  set(key: string, value: unknown): void {
    this.data[key] = value;
  }
  delete(key: string): void {
    delete this.data[key];
  }
  // Wert lesen und entfernen (Hinweise, die nur einmal erscheinen)
  take<T = unknown>(key: string): T | undefined {
    const v = this.data[key] as T | undefined;
    delete this.data[key];
    return v;
  }

  private sendCookie(): void {
    const secure = configString('scheme', 'https') === 'http' ? '' : '; secure';
    this.ctx.header('Set-Cookie', `${SESSION_COOKIE}=${this.id}; path=/${secure}; HttpOnly; SameSite=Lax`, false);
  }

  // session_regenerate_id(true): neue ID, Daten bleiben, die alte Sitzung wird gelöscht
  regenerate(): void {
    this.oldIds.push(this.id);
    this.id = newId();
    this.original = '';
    // Ein früheres Sitzungs-Cookie dieser Anfrage ersetzen
    this.ctx.removeCookieHeader(SESSION_COOKIE);
    this.sendCookie();
  }

  // Diese Anfrage hält die Sitzung nicht wach (nur die Abfrage der Glocke im Hintergrund)
  keepIdle(): void {
    this.background = true;
  }

  // $_SESSION = []; session_destroy() – ohne Cookie-Header (wie PHP)
  destroy(): void {
    this.data = {};
    this.destroyed = true;
  }

  // Am Ende der Anfrage: speichern (oder nur die Zeit erneuern), Sperre lösen
  async close(): Promise<void> {
    try {
      for (const old of this.oldIds) await exec('DELETE FROM oys_sessions WHERE id = ?', [old]);
      if (this.destroyed) {
        await exec('DELETE FROM oys_sessions WHERE id = ?', [this.id]);
      } else {
        const json = JSON.stringify(this.data);
        // Im Hintergrund bleibt die Zeit der letzten Aktivität stehen (geänderte Daten werden trotzdem gespeichert)
        const idle = this.background && this.lastSeen > 0;
        if (json !== this.original) {
          await exec('REPLACE INTO oys_sessions (id, data, last_seen) VALUES (?, ?, ?)', [this.id, json, idle ? this.lastSeen : now()]);
        } else if (!idle) {
          await exec('UPDATE oys_sessions SET last_seen = ? WHERE id = ?', [now(), this.id]);
        }
      }
      // Alte Sitzungen gelegentlich wegräumen (wie die Aufräumarbeit von PHP)
      if (Math.random() < 0.01) await exec('DELETE FROM oys_sessions WHERE last_seen < ?', [now() - idleSeconds()]);
    } finally {
      this.release?.();
      this.release = null;
    }
  }
}
