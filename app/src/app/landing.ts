// Startseite (views/landingpage.php). user = angemeldeter Nutzer, nur wenn die Sitzung schon läuft.
import type { Ctx } from '../web/ctx.js';
import type { Row } from '../db.js';
import { notPorted } from '../web/notPorted.js';

export async function landing(ctx: Ctx, _user: Row | null): Promise<void> {
  notPorted(ctx, 'landing page');
}
