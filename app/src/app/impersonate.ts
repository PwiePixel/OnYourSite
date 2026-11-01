// Als Nutzer anmelden und zurück zum Admin (admin_impersonate.php, admin_return.php)
import type { Ctx } from '../web/ctx.js';
import { notPorted } from '../web/notPorted.js';

export async function adminImpersonate(ctx: Ctx): Promise<void> {
  notPorted(ctx, 'admin_impersonate.php');
}
export async function adminReturn(ctx: Ctx): Promise<void> {
  notPorted(ctx, 'admin_return.php');
}
