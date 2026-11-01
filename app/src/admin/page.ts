// /admin (views/admin.php mit admin_updates, admin_community, admin_honeycombs, admin_storage) – nur für Admins
import type { Ctx } from '../web/ctx.js';
import type { Row } from '../db.js';
import { notPorted } from '../web/notPorted.js';

export async function adminPage(ctx: Ctx, _user: Row): Promise<void> {
  notPorted(ctx, 'admin');
}
