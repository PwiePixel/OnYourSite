// Formularschutz (CSRF), Kennung des Absenders und Begrenzung von Versuchen – wie lib/helpers.php
import { exec, one } from '../db.js';
import { hmac, randomHex, safeEqual } from '../crypto.js';
import { gmdate, time } from '../php.js';
import { e } from '../html.js';
import { oysClientKey } from '../compat/core.js';
import { loadConfig } from '../config.js';
import { Session } from './session.js';
import type { Ctx } from './ctx.js';

// oys_csrf_token(): einmal je Sitzung, 64 Hex-Zeichen
export async function csrfToken(ctx: Ctx): Promise<string> {
  const s = await Session.start(ctx);
  let token = s.get<string>('csrf');
  if (!token) {
    token = randomHex(32);
    s.set('csrf', token);
  }
  return token;
}

export async function csrfField(ctx: Ctx): Promise<string> {
  return `<input type="hidden" name="csrf" value="${e(await csrfToken(ctx))}">`;
}

// oys_csrf_check(): nur ein Text, der genau dem Wert der Sitzung entspricht
export function csrfCheck(ctx: Ctx, token: unknown): boolean {
  const mine = ctx.session?.get<string>('csrf');
  return !!mine && typeof token === 'string' && safeEqual(mine, token);
}

// oys_csrf_from_request(): Header X-CSRF-Token (auch leer), sonst das Formularfeld csrf
export function csrfFromRequest(ctx: Ctx): unknown {
  const h = ctx.headers['x-csrf-token'];
  if (h !== undefined) return Array.isArray(h) ? h[0] : h;
  return ctx.post.csrf;
}

// oys_client_key(): nicht umkehrbar, wechselt täglich (UTC), IPv6 je /64
export function clientKey(ctx: Ctx): string {
  return oysClientKey(ctx.ip, loadConfig()) as string;
}

// Für Tests: dieselbe Rechnung mit dem Hilfsmodul der Seite
export function clientKeyFor(ip: string, at = new Date()): string {
  return oysClientKey(ip, loadConfig(), at) as string;
}

export function hmacHex(data: string): string {
  return hmac(data);
}

// oys_rate_ok()
export async function rateOk(key: string, max: number, windowSeconds: number): Promise<boolean> {
  const row = await one<{ hits: number; ws: number }>('SELECT hits, UNIX_TIMESTAMP(window_start) AS ws FROM rate_limits WHERE rl_key = ?', [key]);
  if (!row) return true;
  if (time() - Number(row.ws) >= windowSeconds) return true;
  return Number(row.hits) < max;
}

// oys_rate_hit(): genau das SQL der PHP-Version (hits zuerst – beide IF lesen das alte window_start)
export async function rateHit(key: string, windowSeconds: number): Promise<void> {
  const now = time();
  await exec(
    `INSERT INTO rate_limits (rl_key, hits, window_start) VALUES (?, 1, FROM_UNIXTIME(?))
     ON DUPLICATE KEY UPDATE hits = IF(window_start <= FROM_UNIXTIME(?), 1, hits + 1),
         window_start = IF(window_start <= FROM_UNIXTIME(?), FROM_UNIXTIME(?), window_start)`,
    [key, now, now - windowSeconds, now - windowSeconds, now],
  );
  if (Math.floor(Math.random() * 50) === 0) {
    await exec('DELETE FROM rate_limits WHERE window_start < FROM_UNIXTIME(?)', [now - 86400]);
  }
}

// oys_rate_limit(): zählt nur, wenn noch erlaubt
export async function rateLimit(key: string, max: number, windowSeconds: number): Promise<boolean> {
  if (!(await rateOk(key, max, windowSeconds))) return false;
  await rateHit(key, windowSeconds);
  return true;
}

// oys_attempts_allowed() / oys_attempt_failed(): je Absender und insgesamt, gezählt werden nur Fehlversuche
export async function attemptsAllowed(ctx: Ctx, key: string, perClient: number, total: number, windowSeconds: number): Promise<boolean> {
  return (await rateOk(key + ':' + clientKey(ctx), perClient, windowSeconds)) && (await rateOk(key, total, windowSeconds));
}
export async function attemptFailed(ctx: Ctx, key: string, windowSeconds: number): Promise<void> {
  await rateHit(key + ':' + clientKey(ctx), windowSeconds);
  await rateHit(key, windowSeconds);
}

export { gmdate };
