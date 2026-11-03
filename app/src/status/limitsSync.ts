// Statusseiten: Abgleich, sobald sich ändert, was ein Konto besitzt (ST-7) – Freischaltung, Zusatzpakete, Premium.
// Die Grenzen selbst gelten zur Laufzeit (limits.ts); dieser Abgleich macht eine Änderung nur sofort sichtbar: er
// setzt changed_at und status_rev (der Prüfdienst liest die Grenzen beim nächsten Abgleich neu) und schickt genau dann
// eine Glocke, wenn sich die Zahl der Prüfungen über der Grenze ändert (status_pages.limit_paused). Er schreibt keinen
// Zustand einer Prüfung – zweimal laufen ändert nichts, und eine Verlängerung im Wettlauf mit dem Ende lässt nichts
// pausiert zurück.
import { transaction, type Db } from '../db.js';
import { notify } from '../notify/notify.js';
import { registerEnforcer } from '../honeycombs/reconcile.js';
import { effectiveMonitors, statusLimits } from './limits.js';
import { bumpRev } from './model.js';
import { FAST_CHECKS_KEY, MORE_CHECKS_KEY, STATUS_FEATURE_KEY } from './shop.js';

// Glocke zum Wechsel (rein, für Tests)
export function limitNotice(before: number, paused: number, checks: number, plan = 'free'): { title: string; body: string } | null {
  if (before === paused) return null;
  if (paused === 0) return { title: 'All your status checks run again', body: 'Every component of your status page is checked again.' };
  // Ohne Freischaltung lässt sich kein Zusatzpaket kaufen – dann nichts empfehlen
  if (plan === 'none') return { title: `${paused} status check${paused === 1 ? ' is' : 's are'} paused`, body: 'Your status page has no checks right now – the status page unlock has ended. The checks and their history are kept.' };
  return {
    title: `${paused} status check${paused === 1 ? ' is' : 's are'} paused`,
    body: `Your status page can run ${checks} check${checks === 1 ? '' : 's'} right now. The last ones by position wait – their history is kept. Extra checks or Premium bring them back.`,
  };
}

export async function refreshStatusLimitsIn(db: Db, uid: number): Promise<void> {
  const page = await db.one('SELECT id, limit_paused FROM status_pages WHERE user_id = ? AND is_system = 0 FOR UPDATE', [uid]);
  if (!page) return;
  const limits = await statusLimits(uid, db);
  const rows = await db.q('SELECT id, type, position, interval_s FROM status_monitors WHERE page_id = ?', [Number(page.id)]);
  const paused = effectiveMonitors(rows.map((r) => ({ id: Number(r.id), type: String(r.type), position: Number(r.position ?? 0), interval_s: Number(r.interval_s ?? 300) })), limits)
    .filter((m) => m.overLimit).length;
  const before = Number(page.limit_paused ?? 0);
  if (paused !== before) await db.exec('UPDATE status_pages SET limit_paused = ? WHERE id = ?', [paused, Number(page.id)]);
  await bumpRev(db, Number(page.id));
  const n = limitNotice(before, paused, limits.checks, limits.plan);
  if (n) await notify(uid, 'status_team', n.title, n.body, '/dashboard#status', { db });
}

export async function refreshStatusLimits(uid: number): Promise<void> {
  await transaction(async (_conn, db) => refreshStatusLimitsIn(db, uid));
}

registerEnforcer({ name: 'status', features: [STATUS_FEATURE_KEY, MORE_CHECKS_KEY, FAST_CHECKS_KEY, 'premium'], inline: true, run: refreshStatusLimits });
