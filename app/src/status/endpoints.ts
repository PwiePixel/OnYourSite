// Statusseiten: Endpunkte auf jeder Adresse (ohne Cookies, noindex):
// - GET /_/health  → {"ok":true,"db":true,"time":…} oder 503 {"ok":false,"db":false}; die Antwort der Datenbank bleibt
//   2 s im Speicher. Ziel der eigenen Prüfungen (web, pages) und des Sensors (origin) – antwortet auch ohne Datenbank.
// - /_/hb/<token> und /_/hb/<token>/fail (GET, HEAD, POST) – Heartbeats: das Token (32 Zeichen base64url) wird über
//   sha256 gesucht; unbekannte Tokens merkt sich der Prozess 60 s (keine Datenbank bei einer Flut falscher Tokens).
//   Grenzen je Token (10 in 10 s) und je Absender nur für unbekannte Tokens (600 je Minute; wer sie ausgeschöpft hat,
//   wird vor der Suche abgewiesen, außer mit einem Token, das der Prozess schon als echt kennt), alles im Speicher –
//   nichts davon schreibt in rate_limits. Geschrieben wird höchstens alle 10 s je Token. Inhalte der Anfrage zählen nicht.
import type { Ctx } from '../web/ctx.js';
import { exec, one, value } from '../db.js';
import { sha256Hex } from '../crypto.js';
import { clientKey } from '../web/security.js';

// ---------------------------------------------------------------- /_/health

let healthCache: { at: number; ok: boolean } | null = null;

export function resetHealthCacheForTests(): void {
  healthCache = null;
}

export async function statusHealth(ctx: Ctx): Promise<void> {
  ctx.header('X-Robots-Tag', 'noindex');
  if (ctx.method !== 'GET' && ctx.method !== 'HEAD') {
    ctx.header('Allow', 'GET, HEAD');
    ctx.json({ ok: false, error: 'Method not allowed' }, 405);
  }
  const now = Date.now();
  if (!healthCache || now - healthCache.at >= 2000) {
    let ok = false;
    try {
      ok = Number(await value('SELECT 1')) === 1;
    } catch {
      ok = false;
    }
    healthCache = { at: now, ok };
  }
  if (healthCache.ok) ctx.json({ ok: true, db: true, time: Math.floor(now / 1000) });
  ctx.json({ ok: false, db: false }, 503);
}

// ---------------------------------------------------------------- /_/hb/<token>

// Kleiner Speicher mit fester Größe: der älteste Eintrag fällt heraus
class Lru<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(k: string): V | undefined {
    return this.map.get(k);
  }
  set(k: string, v: V): void {
    this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
  delete(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

interface Window {
  start: number;
  hits: number;
}

const TOKEN_WINDOW = 10_000;
const TOKEN_MAX = 10;
const CLIENT_WINDOW = 60_000;
const CLIENT_MAX = 600;
const UNKNOWN_TTL = 60_000;
const KNOWN_TTL = 25 * 3600_000; // echte Tokens: länger als der längste Abstand eines Heartbeats (24 h)
const WRITE_EVERY = 10;

const tokenHits = new Lru<Window>(50_000);
const clientHits = new Lru<Window>(50_000);
const unknown = new Lru<number>(50_000);
const known = new Lru<number>(50_000); // Tokens, die dieser Prozess schon in der Datenbank gefunden hat → bis

export function resetHeartbeatMemoryForTests(): void {
  tokenHits.clear();
  clientHits.clear();
  unknown.clear();
  known.clear();
}

// Hat der Schlüssel sein Fenster schon ausgeschöpft? (zählt nicht mit)
function spent(store: Lru<Window>, key: string, max: number, windowMs: number, now: number): boolean {
  const w = store.get(key);
  return w !== undefined && now - w.start < windowMs && w.hits >= max;
}

// true = noch erlaubt (zählt mit)
function hit(store: Lru<Window>, key: string, max: number, windowMs: number, now: number): boolean {
  const w = store.get(key);
  if (!w || now - w.start >= windowMs) {
    store.set(key, { start: now, hits: 1 });
    return true;
  }
  w.hits++;
  return w.hits <= max;
}

function text(ctx: Ctx, body: string, status = 200): never {
  ctx.header('Content-Type', 'text/plain; charset=UTF-8');
  ctx.header('Cache-Control', 'no-store');
  ctx.header('X-Robots-Tag', 'noindex');
  ctx.send(ctx.method === 'HEAD' ? '' : body, status);
}

const HB_PATH = /^\/_\/hb\/([A-Za-z0-9_-]{32})(\/fail)?\/?$/;

export async function statusHeartbeat(ctx: Ctx): Promise<void> {
  const m = HB_PATH.exec(ctx.path);
  if (!m) text(ctx, 'Not found', 404);
  if (ctx.method !== 'GET' && ctx.method !== 'HEAD' && ctx.method !== 'POST') {
    ctx.header('Allow', 'GET, HEAD, POST');
    text(ctx, 'Method not allowed', 405);
  }
  const now = Date.now();
  const hash = sha256Hex(m[1]);
  // Grenze je Token: viele Jobs hinter einer Adresse (NAT, CI) haben je ihr eigenes Token
  if (!hit(tokenHits, hash, TOKEN_MAX, TOKEN_WINDOW, now)) text(ctx, 'Too many requests', 429);
  const unknownUntil = unknown.get(hash);
  const refuse = (): never => {
    // Unbekannte Tokens: höchstens 600 je Minute und Absender
    if (!hit(clientHits, clientKey(ctx), CLIENT_MAX, CLIENT_WINDOW, now)) text(ctx, 'Too many requests', 429);
    text(ctx, 'Not found', 404);
  };
  if (unknownUntil !== undefined && unknownUntil > now) return refuse();
  // Wer seine unbekannten Tokens schon ausgeschöpft hat, kostet keine Suche mehr – außer für ein Token, das dieser
  // Prozess schon als echt kennt (Jobs hinter derselben Adresse laufen weiter)
  if (!((known.get(hash) ?? 0) > now) && spent(clientHits, clientKey(ctx), CLIENT_MAX, CLIENT_WINDOW, now)) refuse();
  const row = await one(`SELECT m.id, m.is_paused, m.admin_paused, m.auto_paused, p.is_blocked FROM status_monitors m
      JOIN status_pages p ON p.id = m.page_id WHERE m.hb_token_hash = ? AND m.type = 'heartbeat' LIMIT 1`, [hash]);
  if (!row) {
    unknown.set(hash, now + UNKNOWN_TTL);
    return refuse();
  }
  unknown.delete(hash);
  known.set(hash, now + KNOWN_TTL);
  const paused = Number(row.is_paused) === 1 || Number(row.admin_paused) === 1 || (row.auto_paused !== null && row.auto_paused !== '') || Number(row.is_blocked) === 1;
  if (paused) text(ctx, 'OK (paused)');
  const at = Math.floor(now / 1000);
  const column = m[2] ? 'hb_last_fail_at' : 'hb_last_ping_at';
  // Höchstens ein Schreiben je 10 s und Token
  await exec(`UPDATE status_monitors SET ${column} = ? WHERE id = ? AND (${column} IS NULL OR ${column} <= ?)`, [at, Number(row.id), at - WRITE_EVERY]);
  text(ctx, 'OK');
}

// ---------------------------------------------------------------- Start der Webseite

// Einmal beim Start (server.ts): die Minute davor war unser Eingang weg – Heartbeat-Fristen beginnen danach neu
export async function recordWebStart(at = Math.floor(Date.now() / 1000)): Promise<void> {
  await exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('status_web_start', ?)", [String(at)]);
}
