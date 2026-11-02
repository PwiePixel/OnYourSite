// Aufträge für den Bot, die zum Reiter Discord gehören: Updates (update.*), der Bericht und der Test des Bots (bot.*,
// update.test) und der Satz in den Richtlinien von #suggestions (suggestions.notice). Ihre Fehler stehen im Reiter
// Discord – nicht mehr im roten Hinweis der Community, der nur noch Vorschläge und Tickets nennt.
import { intval, phpStr } from '../php.js';
import { q } from '../db.js';

// SQL-Bedingung für community_outbox (LIKE: der Punkt ist ein gewöhnliches Zeichen)
export const DISCORD_TAB_JOBS_SQL = "(action LIKE 'update.%' OR action LIKE 'bot.%' OR action = 'suggestions.notice')";

export function isDiscordTabJob(action: string): boolean {
  return action.startsWith('update.') || action.startsWith('bot.') || action === 'suggestions.notice';
}

// Tote Aufträge ohne eigenen Beitrag lassen sich ausblenden („Dismiss“); Beiträge gehen über Retry und Forget
export const DISMISSABLE_JOBS = ['update.test', 'bot.report', 'suggestions.notice'];

const LABELS: Record<string, string> = {
  'update.post': 'post an update',
  'update.edit': 'update a post',
  'update.delete': 'remove a post',
  'update.test': 'send the test message',
  'bot.report': 'send its channel list',
  'suggestions.notice': 'change the note in the #suggestions guidelines',
};

export interface FailingJob { id: number; action: string; label: string; error: string; tries: number; dead: boolean; dismissable: boolean; post: boolean }

// Aufträge mit Fehler, die noch offen sind (laufen weiter oder sind tot) – die neuesten zuerst
export async function failingJobs(limit = 5): Promise<FailingJob[]> {
  const rows = await q(`SELECT id, action, last_error, attempts FROM community_outbox WHERE done_at IS NULL AND last_error IS NOT NULL AND ${DISCORD_TAB_JOBS_SQL} ORDER BY id DESC LIMIT ${Math.max(1, Math.min(50, limit))}`);
  return rows.map((r) => {
    const action = phpStr(r.action);
    const tries = intval(r.attempts);
    return {
      id: intval(r.id), action, label: LABELS[action] ?? 'carry out “' + action + '”', error: phpStr(r.last_error), tries, dead: tries >= 10,
      dismissable: tries >= 10 && DISMISSABLE_JOBS.includes(action), post: ['update.post', 'update.edit', 'update.delete'].includes(action),
    };
  });
}
