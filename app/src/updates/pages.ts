// Öffentliche Updates-Seite, Feed und Dauerlinks (lib/routes_app.php, views/updates.php, views/updates_feed.php)
import type { Ctx } from '../web/ctx.js';
import { q, type Row } from '../db.js';
import { intval, phpTruthy, strtotime, time } from '../php.js';
import { UPDATES_PER_PAGE, milestones, updatePageOf, updatesCount, updatesList, type Milestone } from './updates.js';
import { discordSettings } from './discord.js';
import { updatesView } from './views/updatesView.js';
import { feedView } from './views/feedView.js';

// GET /updates (user = angemeldeter Nutzer, nur wenn die Sitzung schon läuft)
export async function updatesPage(ctx: Ctx, user: Row | null): Promise<void> {
  const total = await updatesCount(true);
  const lastPage = Math.max(1, Math.ceil(total / UPDATES_PER_PAGE));
  const pageNo = Math.min(lastPage, Math.max(1, intval(ctx.get.page ?? 1)));
  const updates = await updatesList(true, UPDATES_PER_PAGE, (pageNo - 1) * UPDATES_PER_PAGE);

  const columns: Record<'now' | 'next' | 'planned' | 'done', Milestone[]> = { now: [], next: [], planned: [], done: [] };
  const milestoneTitles = new Map<number, string>();
  for (const m of await milestones(true)) {
    columns[m.status as keyof typeof columns].push(m);
    milestoneTitles.set(m.id, m.title);
  }
  const hasRoadmap = columns.now.length > 0 || columns.next.length > 0 || columns.planned.length > 0;
  const shipped = columns.done.slice(0, 6);
  // Meilensteine, die hier als Karte stehen (nur auf die kann ein Update verlinken)
  const milestoneShown = new Set([...columns.now, ...columns.next, ...columns.planned, ...shipped].map((m) => m.id));
  const onThisPage = new Set(updates.map((u) => u.id));
  const updateLink = (id: number): string => (onThisPage.has(id) ? '#update-' + id : '/updates/' + id);

  // Zu jedem fertigen Meilenstein das passende Update verlinken (das neueste gewinnt)
  const updateForMilestone = new Map<number, number>();
  if (shipped.length) {
    for (const row of await q('SELECT id, milestone_id FROM updates WHERE is_published = 1 AND milestone_id IS NOT NULL ORDER BY published_at DESC')) {
      const mid = intval(row.milestone_id);
      if (!updateForMilestone.has(mid)) updateForMilestone.set(mid, intval(row.id));
    }
  }

  const discord = await discordSettings();
  ctx.write(updatesView({
    loggedIn: phpTruthy(user),
    pageNo,
    lastPage,
    updates,
    columns,
    milestoneTitles,
    hasRoadmap,
    shipped,
    milestoneShown,
    updateForMilestone,
    updateLink,
    invite: discord.invite_url !== '' ? discord.invite_url : 'https://discord.on-your.site',
    description: 'Follow along as OnYourSite grows – what we’re building right now, what’s up next and everything we’ve shipped.',
  }));
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
