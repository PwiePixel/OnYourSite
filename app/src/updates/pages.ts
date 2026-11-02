// Öffentliche Seiten /updates (Changelog) und /roadmap, Feed und Dauerlinks (lib/routes_app.php, views/updates.php,
// views/updates_feed.php)
import type { Ctx } from '../web/ctx.js';
import { q, type Row } from '../db.js';
import { intval, phpStr, phpTruthy, strtotime, time } from '../php.js';
import { UPDATES_PER_PAGE, milestones, updatePageOf, updatesCount, updatesList, type Milestone } from './updates.js';
import { discordSettings } from './discord.js';
import { updatesView } from './views/updatesView.js';
import { roadmapView } from './views/roadmapView.js';
import { feedView } from './views/feedView.js';

// Einladungslink für „Get updates on Discord“ und „Join the Discord“
async function invite(): Promise<string> {
  const discord = await discordSettings();
  return discord.invite_url !== '' ? discord.invite_url : 'https://discord.on-your.site';
}

// GET /updates (user = angemeldeter Nutzer, nur wenn die Sitzung schon läuft): der Changelog
export async function updatesPage(ctx: Ctx, user: Row | null): Promise<void> {
  const total = await updatesCount(true);
  const lastPage = Math.max(1, Math.ceil(total / UPDATES_PER_PAGE));
  const pageNo = Math.min(lastPage, Math.max(1, intval(ctx.get.page ?? 1)));
  const updates = await updatesList(true, UPDATES_PER_PAGE, (pageNo - 1) * UPDATES_PER_PAGE);
  // Öffentliche Meilensteine: Chips im Changelog verlinken auf ihre Karte auf /roadmap
  const milestoneTitles = new Map<number, string>();
  for (const row of await q('SELECT id, title FROM milestones WHERE is_public = 1')) milestoneTitles.set(intval(row.id), phpStr(row.title));
  ctx.write(updatesView({ loggedIn: phpTruthy(user), pageNo, lastPage, updates, milestoneTitles, invite: await invite() }));
}

// GET /roadmap: Spalten (jetzt, als Nächstes, geplant) und fertige Meilensteine; jede Abfrage (?from=updates) wird
// ignoriert, die kanonische Adresse bleibt /roadmap
export async function roadmapPage(ctx: Ctx, user: Row | null): Promise<void> {
  const columns: Record<'now' | 'next' | 'planned' | 'done', Milestone[]> = { now: [], next: [], planned: [], done: [] };
  for (const m of await milestones(true)) {
    if (Object.hasOwn(columns, m.status)) columns[m.status as keyof typeof columns].push(m);
  }
  // Zu jedem fertigen Meilenstein das passende Update (das neueste gewinnt)
  const updateForMilestone = new Map<number, number>();
  if (columns.done.length) {
    for (const row of await q('SELECT id, milestone_id FROM updates WHERE is_published = 1 AND milestone_id IS NOT NULL ORDER BY published_at DESC')) {
      const mid = intval(row.milestone_id);
      if (!updateForMilestone.has(mid)) updateForMilestone.set(mid, intval(row.id));
    }
  }
  ctx.write(roadmapView({ loggedIn: phpTruthy(user), columns, updateForMilestone, invite: await invite() }));
}

// GET /updates/feed.xml: die 30 neuesten veröffentlichten Updates
export async function updatesFeed(ctx: Ctx): Promise<void> {
  const updates = await updatesList(true, 30);
  const stamps = updates.map((u) => {
    const t = strtotime(phpTruthy(u.updated_at) ? (u.updated_at as string) : u.published_at ?? '');
    return t === false ? 0 : t;
  });
  const newest = stamps.length ? Math.max(...stamps) : time();
  ctx.header('Content-Type', 'application/atom+xml; charset=utf-8');
  ctx.header('Cache-Control', 'public, max-age=600');
  ctx.write(feedView(updates, newest));
}

// GET /updates/{id}: zur Seite weiterleiten, auf der das Update gerade steht
export async function updateLink(ctx: Ctx, id: number): Promise<void> {
  const pageNo = await updatePageOf(id);
  ctx.redirect(pageNo === null ? '/updates' : '/updates' + (pageNo > 1 ? '?page=' + pageNo : '') + '#update-' + id);
}
