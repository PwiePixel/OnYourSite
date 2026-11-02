// Ein Abzeichen („Chip“) je Beitrag eines Updates in Discord – in der Liste der Updates, in der Karte „Discord posts“
// und in /admin/api/discord-status. Was „Retry“ und „Forget“ dürfen, entscheidet dieselbe Tabelle wie beim Ausführen
// (decide() in posts.ts), damit nie ein Knopf erscheint, den der Server dann ablehnt.
import { q, type Db } from '../db.js';
import { e } from '../html.js';
import { intval, phpStr, strtotime, time } from '../php.js';
import { confirmAttrs, confirmField } from '../views/partials/ui.js';
import { TEXTS, decide, refOf, type Facts, type PostRow } from './posts.js';

export type ChipTone = 'posted' | 'warn' | 'err';

export interface Chip {
  id: number;
  update_id: number;
  via: PostRow['via'];
  state: PostRow['state'];
  label: string;
  tone: ChipTone;
  // Fehler des Beitrags oder des letzten Versuchs (Text für title und die Karte)
  error: string;
  retry: boolean;
  forget: boolean;
  // Ein Auftrag für den Bot ist noch offen (z. B. eine Änderung, die er gleich übernimmt)
  busy: boolean;
}

// Offener Auftrag eines Beitrags (ref post:{id}): noch nicht tot = er läuft noch; Fehler und Versuche des letzten Laufs
export interface OpenJob { busy: boolean; error: string; tries: number }

const VIA_LABEL: Record<PostRow['via'], string> = { bot: 'Bot', webhook: 'Webhook', token: 'Old token' };

export async function openJobsOf(postIds: number[], db?: Db): Promise<Map<number, OpenJob>> {
  const out = new Map<number, OpenJob>();
  const ids = postIds.filter((i) => Number.isSafeInteger(i) && i > 0);
  if (!ids.length) return out;
  const refs = ids.map(refOf);
  const sql = `SELECT ref, attempts, last_error FROM community_outbox WHERE done_at IS NULL AND ref IN (${refs.map(() => '?').join(', ')}) ORDER BY id`;
  const rows = db ? await db.q(sql, refs) : await q(sql, refs);
  for (const r of rows) {
    const id = intval(phpStr(r.ref).slice('post:'.length));
    const tries = intval(r.attempts);
    const prev = out.get(id) ?? { busy: false, error: '', tries: 0 };
    out.set(id, {
      busy: prev.busy || tries < 10,
      error: r.last_error !== null && r.last_error !== undefined && phpStr(r.last_error) !== '' ? phpStr(r.last_error) : prev.error,
      tries: Math.max(prev.tries, tries),
    });
  }
  return out;
}

export function chipOf(row: PostRow, job: OpenJob | undefined, botInstalled: boolean, now = time()): Chip {
  const t = strtotime(row.updated_at);
  const error = row.error ?? '';
  const f: Facts = {
    via: row.via, state: row.state, ageSec: t === false ? 0 : now - t, jobClaimed: false, hasError: error !== '', botInstalled, updateGone: false,
  };
  const retryDecision = decide('retry', f, row.via);
  const otherBot = row.legacy && error === TEXTS.otherBot;
  let label: string;
  let tone: ChipTone;
  switch (row.state) {
    case 'queued':
    case 'posting':
      label = 'posting…';
      tone = 'warn';
      break;
    case 'posted':
      label = error !== '' ? 'not updated' : 'posted';
      tone = error !== '' ? 'warn' : 'posted';
      break;
    case 'failed':
      label = 'failed';
      tone = 'err';
      break;
    case 'removing':
      label = 'removing…';
      tone = 'warn';
      break;
    default:
      label = 'couldn’t remove';
      tone = 'err';
  }
  // Ein Auftrag, der noch läuft, aber schon gescheitert ist: Grund und Versuche (der Bot versucht es weiter)
  const pending = row.state === 'queued' || row.state === 'removing' || (row.state === 'posted' && !!job?.busy);
  const jobNote = job && job.busy && job.error !== '' && pending ? `Last try failed (${job.tries} ${job.tries === 1 ? 'try' : 'tries'}): ${job.error} – the bot tries again.` : '';
  return {
    id: row.id, update_id: row.update_id, via: row.via, state: row.state, label: VIA_LABEL[row.via] + ' · ' + label, tone,
    error: error !== '' ? error : jobNote,
    retry: !otherBot && (retryDecision === 'edit' || retryDecision === 'queue_post' || retryDecision === 'claim_post' || retryDecision === 'delete'),
    // Ein Beitrag, der einfach in Discord steht, braucht kein „Forget“ (discord-pages §3.3: posted → keine Aktion)
    forget: decide('forget', f, row.via) === 'drop_jobs' && !(row.state === 'posted' && error === ''),
    busy: !!job?.busy,
  };
}

const TONE_CLASS: Record<ChipTone, string> = {
  posted: 'bg-[#5865F2]/20 text-[#8b93ff]',
  warn: 'bg-amber-500/15 text-amber-400',
  err: 'bg-red-500/15 text-red-400',
};
export const chipToneClass = (tone: ChipTone): string => TONE_CLASS[tone];

// Abzeichen wie das frühere „On Discord“ (gleiche Klassen), mit Daten für das Nachladen des Zustands; updateTitle nennt
// das Update in den Hinweisen nach dem Nachladen
export function chipHtml(c: Chip, updateTitle = ''): string {
  return `<span class="text-[10px] font-bold uppercase px-2 py-0.5 rounded ${TONE_CLASS[c.tone]} flex items-center gap-1" data-discord-post="${c.id}" data-update-id="${c.update_id}" data-state="${e(c.state)}" data-busy="${c.busy ? '1' : '0'}"${updateTitle !== '' ? ` data-title="${e(updateTitle)}"` : ''}${c.error !== '' ? ` title="${e(c.error)}"` : ''}><i class='bx bxl-discord-alt'></i> <span data-chip-label>${e(c.label)}</span></span>`;
}

// Kann sich der Beitrag noch ohne Zutun des Admins ändern (Bot-Ergebnis, Aufräumen, Forget wird möglich)?
export const chipMayChange = (c: Chip): boolean => c.state !== 'posted' || c.error !== '' || c.busy;

const btn = 'inline-flex items-center gap-1.5 px-3 py-2 min-h-[36px] rounded-lg text-xs font-medium border border-bordercolor text-gray-300 hover:text-white hover:bg-white/5 transition-colors';

// „Retry“ und „Forget“ eines Beitrags; nicht verfügbare Knöpfe stehen versteckt da, damit das Nachladen sie zeigen kann.
// back: Bereich, in den die Seite danach zurückkehrt (updates oder discord). named: Ziel im Text nennen (mehrere Beiträge).
export function chipActionsHtml(c: Chip, csrf: string, back: 'updates' | 'discord', named = false): string {
  const who = VIA_LABEL[c.via].toLowerCase();
  const suffix = named ? ' ' + who : '';
  const forget = confirmAttrs({ title: 'Forget this post?', text: 'If it is in Discord, it stays there and can’t be edited from here any more.', ok: 'Forget', tone: 'danger' });
  return `<form action="/admin" method="POST" class="m-0" data-post-retry="${c.id}"${c.retry ? '' : ' hidden'}>${csrf}<input type="hidden" name="oys_action" value="discord_post_retry"><input type="hidden" name="id" value="${c.id}"><input type="hidden" name="back" value="${back}"><button type="submit" class="${btn} text-[#8b93ff]" title="Try the ${who} post again"><i class='bx bx-revision'></i> Retry${e(suffix)}</button></form>`
    + `<form action="/admin" method="POST" class="m-0" data-post-forget="${c.id}"${forget}${c.forget ? '' : ' hidden'}>${csrf}${confirmField()}<input type="hidden" name="oys_action" value="discord_post_forget"><input type="hidden" name="id" value="${c.id}"><input type="hidden" name="back" value="${back}"><button type="submit" class="${btn} hover:text-red-400" title="Forget the ${who} post"><i class='bx bx-x'></i> Forget${e(suffix)}</button></form>`;
}
