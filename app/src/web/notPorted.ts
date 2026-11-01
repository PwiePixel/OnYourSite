// Platzhalter für Bereiche, die noch nicht übertragen sind: 501, damit der Vergleich mit PHP die Lücke zeigt
import type { Ctx } from './ctx.js';

export function notPorted(ctx: Ctx, name: string): never {
  ctx.status = 501;
  ctx.header('Content-Type', 'text/plain; charset=utf-8');
  ctx.write(`Not ported yet: ${name}`);
  ctx.halt();
}
