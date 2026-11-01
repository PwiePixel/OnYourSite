// GET /api.php?user=<name> – öffentliche JSON-Schnittstelle (api.php)
import type { Ctx } from '../web/ctx.js';
import { notPorted } from '../web/notPorted.js';

export async function api(ctx: Ctx): Promise<void> {
  notPorted(ctx, 'api.php');
}
