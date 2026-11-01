// 404-Seite (views/404.php). Den Status setzt der Aufrufer bzw. diese Funktion auf 404.
import type { Ctx } from '../web/ctx.js';
import { notPorted } from '../web/notPorted.js';

export async function notFound(ctx: Ctx): Promise<void> {
  notPorted(ctx, '404 view');
}
