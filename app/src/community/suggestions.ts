// Öffentliche Vorschlagsseite (/suggestions): ob sie an ist, welche Vorschläge die Besucher sehen und als welcher Text.
// visible() ist die einzige Stelle, die entscheidet, ob ein Vorschlag öffentlich ist – alles andere fragt über sie.
// Namen (Autor, wer entschieden hat) und Discord-IDs der Personen werden für die öffentliche Seite nie gelesen.
import { exec, one, q, transaction, value, type Db } from '../db.js';
import { baseAuthority } from '../helpers.js';
import { date, intval, mbSubstr, phpStr } from '../php.js';
import { registerBotAction } from './outbox.js';
import { botSecret, outboxAdd, supersede } from './community.js';

export const SUGGESTIONS_PER_PAGE = 20;
export const EXCERPT_CHARS = 280;
export const PUBLIC_FILTERS = ['all', 'open', 'accepted', 'declined'] as const;
export type PublicFilter = (typeof PUBLIC_FILTERS)[number];
export type WebState = 'auto' | 'shown' | 'hidden';

// Der Bot setzt den Satz in die Richtlinien des Forums (nur ein Bot, der suggestions.v2 kann)
registerBotAction('suggestions.notice', { feature: 'suggestions.v2' });

const POOL: Db = { q, one, value, exec };

// community_pages in oys_meta (einfaches JSON): {"suggestions": "off|on"}; fehlt der Schlüssel, ist die Seite aus
export async function communityPages(db: Db = POOL): Promise<{ suggestions: 'on' | 'off' }> {
  const raw = await db.value("SELECT meta_value FROM oys_meta WHERE meta_key = 'community_pages'");
  let on = false;
  try {
    const v = JSON.parse(phpStr(raw ?? '')) as unknown;
    on = v !== null && typeof v === 'object' && (v as Record<string, unknown>).suggestions === 'on';
  } catch {
    on = false;
  }
  return { suggestions: on ? 'on' : 'off' };
}

// Die Seite ist an: im Admin eingeschaltet und der Bot eingerichtet (ohne ihn kommt nichts Neues dazu)
export async function suggestionsPageOn(db: Db = POOL): Promise<boolean> {
  return botSecret() !== '' && (await communityPages(db)).suggestions === 'on';
}

// Bedingung (SQL für WHERE), unter der ein Vorschlag öffentlich ist: die Seite ist an, der Beitrag ist nicht in Discord
// gelöscht, und das Team zeigt ihn ausdrücklich – oder er ist entschieden und der Bot hat dem Autor im Beitrag gesagt,
// dass er auf der Webseite erscheinen kann (web_notice).
export function visible(pageOn: boolean): string {
  if (!pageOn) return '(1 = 0)';
  return "(removed_at IS NULL AND (web_state = 'shown' OR (web_state = 'auto' AND web_notice = 1 AND status <> 'open')))";
}

// Warum ein Vorschlag nicht auf der Webseite steht (für das Admin; nur zur Erklärung – entschieden hat visible())
export function hiddenReason(s: { removed_at?: unknown; web_state?: unknown; web_notice?: unknown; status?: unknown }): string {
  if (s.removed_at !== null && s.removed_at !== undefined) return 'deleted in Discord';
  if (s.web_state === 'hidden') return 'hidden by the team';
  if (s.web_state !== 'shown' && intval(s.web_notice) !== 1) return 'the author wasn’t told it could appear on the website';
  return 'waiting for a decision';
}

// Was der Bot zu einem Vorschlag über die Webseite erfährt: ob neue Beiträge den Hinweis bekommen, und die Adresse
export async function suggestionWeb(db: Db = POOL): Promise<{ notice: boolean; host: string }> {
  return { notice: await suggestionsPageOn(db), host: baseAuthority() };
}

// Satz für die Richtlinien des Forums und der Hinweis im Beitrag
export const guidelineSentence = (): string => `Decided ideas are shown on ${baseAuthority()}/suggestions without your name.`;

// Text für die Webseite: Erwähnungen und eigene Emojis aus Discord ersetzen, mehr als zwei Leerzeilen zusammenfassen.
// Danach nur noch mit e() ausgeben (kein Markdown, keine klickbaren Links). Alle Muster ohne verschachtelte
// Wiederholungen (kein Backtracking-Risiko).
export function suggestionText(body: unknown): string {
  let t = phpStr(body ?? '')
    .replace(/<@!?\d{1,25}>/g, '@member')
    .replace(/<@&\d{1,25}>/g, '@role')
    .replace(/<#\d{1,25}>/g, '#channel')
    .replace(/<a?:([A-Za-z0-9_]{1,32}):\d{1,25}>/g, ':$1:');
  // Leerzeichen am Zeilenende weg (trimEnd: kein regulärer Ausdruck), dann höchstens zwei Leerzeilen am Stück
  t = t.split('\n').map((line) => line.trimEnd()).join('\n').replace(/\n{4,}/g, '\n\n\n');
  return t.trim();
}

// Anfang eines Textes für die Karte (Codepunkte); more = es gibt mehr
export function excerpt(text: string): { text: string; more: boolean } {
  const cut = mbSubstr(text, 0, EXCERPT_CHARS);
  return { text: cut, more: cut.length < text.length };
}

export interface PublicSuggestion {
  id: number;
  thread_id: string;
  title: string;
  body: string;
  status: string;
  reason: string;
  created_at: string | null;
  decided_at: string | null;
}

// Nur diese Spalten – nie author_id, author_name oder decided_by
const PUBLIC_COLUMNS = 'id, thread_id, title, body, status, reason, created_at, decided_at';

const statusFilter = (filter: PublicFilter): { sql: string; params: string[] } => (filter === 'all' ? { sql: '', params: [] } : { sql: ' AND status = ?', params: [filter] });

export async function publicCounts(pageOn: boolean): Promise<Record<PublicFilter, number>> {
  const counts: Record<PublicFilter, number> = { all: 0, open: 0, accepted: 0, declined: 0 };
  for (const row of await q(`SELECT status, COUNT(*) AS n FROM community_suggestions WHERE ${visible(pageOn)} GROUP BY status`)) {
    const status = phpStr(row.status);
    if (status === 'open' || status === 'accepted' || status === 'declined') counts[status] += intval(row.n);
    counts.all += intval(row.n);
  }
  return counts;
}

export async function publicSuggestions(pageOn: boolean, filter: PublicFilter, pageNo: number): Promise<PublicSuggestion[]> {
  const f = statusFilter(filter);
  const rows = await q(`SELECT ${PUBLIC_COLUMNS} FROM community_suggestions WHERE ${visible(pageOn)}${f.sql} ORDER BY id DESC LIMIT ${SUGGESTIONS_PER_PAGE} OFFSET ?`,
    [...f.params, (Math.max(1, pageNo) - 1) * SUGGESTIONS_PER_PAGE]);
  return rows.map((r) => ({
    id: intval(r.id), thread_id: phpStr(r.thread_id), title: phpStr(r.title), body: phpStr(r.body), status: phpStr(r.status), reason: phpStr(r.reason),
    created_at: r.created_at === null ? null : phpStr(r.created_at), decided_at: r.decided_at === null ? null : phpStr(r.decided_at),
  }));
}

// Seite der Liste (ohne Filter), auf der ein sichtbarer Vorschlag steht – sonst null
export async function suggestionPageOf(pageOn: boolean, id: number): Promise<number | null> {
  if (!(await one(`SELECT id FROM community_suggestions WHERE id = ? AND ${visible(pageOn)}`, [id]))) return null;
  const newer = intval(await value(`SELECT COUNT(*) FROM community_suggestions WHERE ${visible(pageOn)} AND id > ?`, [id]));
  return Math.floor(newer / SUGGESTIONS_PER_PAGE) + 1;
}

// Zahlen für die Karte im Admin: sichtbar, sichtbar nach der Entscheidung, nicht gezeigt
export async function webCounts(pageOn: boolean): Promise<{ shown: number; waiting: number; hidden: number }> {
  const total = intval(await value('SELECT COUNT(*) FROM community_suggestions'));
  const shown = intval(await value(`SELECT COUNT(*) FROM community_suggestions WHERE ${visible(pageOn)}`));
  const waiting = pageOn
    ? intval(await value("SELECT COUNT(*) FROM community_suggestions WHERE removed_at IS NULL AND web_state = 'auto' AND web_notice = 1 AND status = 'open'"))
    : 0;
  return { shown, waiting, hidden: Math.max(0, total - shown - waiting) };
}

// Admin: Seite ein- oder ausschalten. Der Bot setzt oder entfernt den Satz in den Richtlinien des Forums (ein noch nicht
// abgeholter Auftrag wird ersetzt). Eine Transaktion, die zuerst die Zeile der Einstellung sperrt: schalten zwei Admins
// gleichzeitig, gelten am Ende Einstellung und Auftrag desselben Klicks.
export async function setSuggestionsPage(on: boolean): Promise<void> {
  await transaction(async (_conn, db) => {
    await db.exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('community_pages', ?)", [JSON.stringify({ suggestions: on ? 'on' : 'off' })]);
    await supersede('notice', 'suggestions.notice', db);
    await outboxAdd('suggestions.notice', { on, text: guidelineSentence() }, { ref: 'notice', db });
  });
}

// Admin: einen Vorschlag zeigen oder verbergen
export async function setWebState(id: number, state: 'shown' | 'hidden'): Promise<boolean> {
  const res = await exec('UPDATE community_suggestions SET web_state = ?, updated_at = ? WHERE id = ?', [state, date('Y-m-d H:i:s'), id]);
  return res.affectedRows > 0;
}
