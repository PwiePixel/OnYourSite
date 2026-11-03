// Honigwaben an mehrere Nutzer (HC-6b) – die Schritte mit der Sitzung: grant_preview liest die Liste und merkt sich
// die gefundenen Konten (hc_bulk, 15 Minuten), grant_bulk bucht genau diese, grant_bulk_cancel verwirft sie.
// grant_bulk bucht nur nach dem eigenen Dialog (_confirmed=1); nach dem Buchen bleibt ein Vermerk in der Sitzung, damit
// ein zweiter Klick „schon gebucht“ hört und ein älterer Tab erfährt, dass inzwischen eine andere Liste geprüft wurde.
import { field, phpStr, time, type PhpArray } from '../php.js';
import { cleanText } from '../helpers.js';
import type { Session } from '../web/session.js';
import { UNCONFIRMED_MESSAGE } from '../views/partials/ui.js';
import { BULK_VALID_SEC, bookBulk, resolveUserList, type BulkEntry, type BulkPreview } from './teamTools.js';

export const BULK_SESSION_KEY = 'hc_bulk';

export interface BulkSession extends BulkPreview { found: BulkEntry[]; unclear: string[]; missing: string[]; booked?: boolean }

const BAD = 'Not all of the data arrived. Please try again.';

// Gültige gemerkte Liste (sonst null – auch, wenn sie zu alt ist)
export function bulkFromSession(session: Session, nowSec: number = time()): BulkSession | null {
  const v = session.get(BULK_SESSION_KEY) as BulkSession | null | undefined;
  if (!v || typeof v !== 'object' || !Array.isArray(v.ids) || typeof v.at !== 'number' || v.booked === true) return null;
  return nowSec - v.at <= BULK_VALID_SEC ? v : null;
}

// null = keine dieser Aktionen
export async function hcBulkAction(session: Session, post: PhpArray, adminId: number): Promise<{ ok: string } | { error: string } | null> {
  const action = post.hc_action;
  if (action === 'grant_bulk_cancel') {
    session.delete(BULK_SESSION_KEY);
    return { ok: 'The list was dropped – nothing was booked.' };
  }
  if (action === 'grant_preview') {
    for (const k of ['user_list', 'amount', 'note', 'grant_ref']) if (post[k] !== undefined && typeof post[k] !== 'string') return { error: BAD };
    const amountText = field(post, 'amount').trim();
    const amount = /^-?[0-9]{1,6}$/.test(amountText) ? Number(amountText) : NaN;
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 100000) return { error: 'Enter an amount between −100,000 and 100,000 (not 0).' };
    const ref = field(post, 'grant_ref');
    if (!/^[0-9a-f]{16}$/.test(ref)) return { error: BAD };
    const list = await resolveUserList(field(post, 'user_list'), amount);
    if ('error' in list) return list;
    session.set(BULK_SESSION_KEY, { ref, amount, note: cleanText(post.note ?? '', 150), at: time(), ids: list.found.map((f) => f.uid), ...list });
    if (!list.found.length) return { error: 'None of these users were found – check the list below.' };
    return null;
  }
  if (action === 'grant_bulk') {
    if (post._confirmed !== '1') return { error: UNCONFIRMED_MESSAGE };
    const stored = session.get(BULK_SESSION_KEY) as BulkSession | null | undefined;
    const ref = phpStr(post.grant_ref ?? '');
    // Gebucht wird je Liste einmal: danach bleibt nur der Vermerk (ein zweiter Klick bekommt die passende Meldung)
    if (stored && stored.ref === ref && stored.booked === true) return { error: 'This was already booked – the form was sent twice.' };
    // Ein anderer Tab hat inzwischen eine neue Liste geprüft
    if (stored && stored.ref !== ref && bulkFromSession(session)) return { error: 'Another list was checked since – please confirm the newest one.' };
    const p = bulkFromSession(session);
    if (!p || p.ref !== ref) return { error: 'The checked list is older than 15 minutes – please check it again.' };
    const out = await bookBulk(adminId, p, time());
    session.set(BULK_SESSION_KEY, { ref: p.ref, booked: true, at: p.at, ids: [], amount: 0, note: '', found: [], unclear: [], missing: [] });
    return out;
  }
  return null;
}
