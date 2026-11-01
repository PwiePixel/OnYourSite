// Code-Seite unter name.on-your.site ausliefern (oys_code_serve in lib/codesites.php)
import type { Ctx } from '../web/ctx.js';
import type { Row } from '../db.js';
import { notPorted } from '../web/notPorted.js';

export async function codeServe(ctx: Ctx, _site: Row, _path: string): Promise<void> {
  notPorted(ctx, 'code page');
}
