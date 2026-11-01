// Upload-Ordner (lib/storage.php). /static/uploads/{name} ausliefern, wenn der Ordner außerhalb des Codes liegt.
import type { Ctx } from '../web/ctx.js';
import { notPorted } from '../web/notPorted.js';

export async function serveUpload(ctx: Ctx, _name: string): Promise<void> {
  notPorted(ctx, 'uploads');
}
