// Eigene Domains: feste Antworten ohne Seite – die neutrale 404 („Not connected“), die Prüfstelle /_/domain-check
// und deren Selbsttest auf der Domain der Seite (Schutzschalter des Domain-Dienstes)
import type { Ctx } from '../web/ctx.js';
import { value } from '../db.js';
import { baseHost } from '../helpers.js';
import { renderSimple } from '../content/render.js';
import { probeAnswer } from './tokens.js';

const NEUTRAL_TITLE = 'Not connected';
const NEUTRAL_BODY = '<div class="oys-card"><h1>Not connected</h1><p>This domain isn’t connected to a page right now.</p></div>';

// Jede „nicht gefunden“-Antwort auf einer eigenen Domain: schlichte Seite im Design deep-dark, ohne Werbung und ohne
// Link zu OnYourSite, nicht für Suchmaschinen
export function neutralNotFound(ctx: Ctx): never {
  ctx.removeHeader('Content-Type');
  ctx.header('X-Robots-Tag', 'noindex');
  ctx.send(renderSimple({ theme: 'deep-dark' }, NEUTRAL_TITLE, NEUTRAL_BODY), 404);
}

// Antwort der Prüfstelle für einen Host (nur der Domain-Dienst fragt sie ab, nie im Zwischenspeicher)
export function probeResponse(ctx: Ctx, host: string): never {
  ctx.header('Content-Type', 'text/plain; charset=utf-8');
  ctx.header('Cache-Control', 'no-store');
  ctx.header('X-Robots-Tag', 'noindex');
  ctx.send(probeAnswer(host), 200);
}

// Selbsttest auf der Domain der Seite: antwortet erst nach einer Abfrage an die Datenbank, sonst 503 – so sieht der
// Dienst den eigenen Ausfall und zählt ihn nie gegen die Domains der Nutzer
export async function controlResponse(ctx: Ctx): Promise<never> {
  try {
    await value('SELECT 1');
  } catch {
    ctx.header('Content-Type', 'text/plain; charset=utf-8');
    ctx.header('Cache-Control', 'no-store');
    ctx.header('X-Robots-Tag', 'noindex');
    ctx.send('Service unavailable', 503);
  }
  probeResponse(ctx, baseHost());
}
