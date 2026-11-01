// /dashboard: Editor (GET) und E-Mail/Passwort ändern (POST) – lib/routes_app.php, views/dashboard.php
import type { Ctx } from '../web/ctx.js';
import type { Row } from '../db.js';
import { notPorted } from '../web/notPorted.js';

export async function dashboard(ctx: Ctx, _user: Row): Promise<void> {
  notPorted(ctx, 'dashboard');
}
