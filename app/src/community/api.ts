// /_/bot/…: signierte Schnittstelle für den Discord-Bot (oys_bot_api in lib/community.php)
import type { Ctx } from '../web/ctx.js';
import { notPorted } from '../web/notPorted.js';

export async function botApi(ctx: Ctx): Promise<void> {
  notPorted(ctx, '/_/bot/');
}
