// Öffentliche Updates-Seite, Feed und Dauerlinks (views/updates.php, views/updates_feed.php, lib/updates.php)
import type { Ctx } from '../web/ctx.js';
import type { Row } from '../db.js';
import { notPorted } from '../web/notPorted.js';

// GET /updates (user = angemeldeter Nutzer, nur wenn die Sitzung schon läuft)
export async function updatesPage(ctx: Ctx, _user: Row | null): Promise<void> {
  notPorted(ctx, '/updates');
}
// GET /updates/feed.xml
export async function updatesFeed(ctx: Ctx): Promise<void> {
  notPorted(ctx, '/updates/feed.xml');
}
// GET /updates/{id}: zur Seite weiterleiten, auf der das Update gerade steht
export async function updateLink(ctx: Ctx, _id: number): Promise<void> {
  notPorted(ctx, '/updates/{id}');
}
