// /dashboard/api/{aktion}: JSON-Schnittstelle des Editors (lib/routes_app.php)
import type { Ctx } from '../web/ctx.js';
import type { Row } from '../db.js';
import { notPorted } from '../web/notPorted.js';

export async function editorApi(ctx: Ctx, _user: Row): Promise<void> {
  notPorted(ctx, 'editor API');
}
