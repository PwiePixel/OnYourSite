// GET /admin/api/discord-status?updates=12,13 – Stand des Bots, des Webhooks und der Beiträge der genannten Updates für
// das Nachladen im Admin (discord-pages §5.3). Nur lesen; Admin-Sitzung und Antworten auf 401/403 prüft admin/api.ts.
// Texte kommen fertig mit (die Seite setzt sie nur als Text ein).
import type { Ctx } from '../web/ctx.js';
import { activeWebhook, discordSettings } from './settings.js';
import { loadBotCard } from './adminView.js';
import { postsOf } from './posts.js';
import { chipOf, openJobsOf } from './chips.js';
import { q } from '../db.js';
import { intval, phpStr, time } from '../php.js';

// Höchstens so viele Updates je Abfrage
export const MAX_STATUS_UPDATES = 100;

// ?updates=12,13 → Zahlen (unbrauchbare Einträge fallen weg, höchstens 100, ohne Doppelte)
export function statusUpdateIds(raw: unknown): number[] {
  if (typeof raw !== 'string' || raw === '') return [];
  const out: number[] = [];
  for (const part of raw.split(',', 1000)) {
    if (!/^\d{1,10}$/.test(part)) continue;
    const id = Number(part);
    if (id > 0 && !out.includes(id)) out.push(id);
    if (out.length >= MAX_STATUS_UPDATES) break;
  }
  return out;
}

export async function discordStatusApi(ctx: Ctx): Promise<never> {
  const ids = statusUpdateIds(ctx.get.updates);
  const s = await discordSettings();
  const { card, report, installed, lastSeen } = await loadBotCard(s);
  const posts = await postsOf(ids);
  const rows = [...posts.values()].flat();
  const jobs = await openJobsOf(rows.map((r) => r.id));
  const titles = new Map<number, string>();
  if (ids.length) {
    for (const r of await q(`SELECT id, title, version FROM updates WHERE id IN (${ids.map(() => '?').join(', ')})`, ids)) {
      titles.set(intval(r.id), (phpStr(r.version) !== '' ? phpStr(r.version) + ' – ' : '') + phpStr(r.title));
    }
  }
  const now = time();
  const target = card.target;
  return ctx.json({
    ok: true,
    bot: {
      installed,
      online: card.online,
      last_seen: installed ? lastSeen : null,
      version: report?.version ?? '',
      ready: card.line?.tone === 'ok' && target !== null,
      checking: card.state === 'checking',
      channel: target && target.name !== '' ? '#' + target.name : '',
      state: card.state,
      status: card.status,
      line: card.line,
      badge: card.badge,
      test: card.test,
    },
    webhook: { enabled: !!activeWebhook(s), checked_at: s.webhook.checked_at, error: s.webhook.check_error },
    posts: rows.map((row) => {
      const c = chipOf(row, jobs.get(row.id), installed, now);
      return {
        id: c.id, update_id: c.update_id, via: c.via, state: c.state, error: row.error ?? '', forget: c.forget, retry: c.retry, busy: c.busy,
        label: c.label, tone: c.tone, title: c.error, update_title: titles.get(c.update_id) ?? '',
      };
    }),
  });
}
