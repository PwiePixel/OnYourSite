// Startseite (views/landingpage.php). user = angemeldeter Nutzer, nur wenn die Sitzung schon läuft.
import type { Ctx } from '../web/ctx.js';
import type { Row } from '../db.js';
import { landingView } from './views/landing.js';

export async function landing(ctx: Ctx, user: Row | null): Promise<void> {
  ctx.write(landingView({ user }));
}
