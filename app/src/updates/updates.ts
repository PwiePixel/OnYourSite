// Updates (Changelog) und Roadmap mit Meilensteinen und Teilaufgaben (lib/updates.php, oberer Teil).
// Öffentlich unter /updates, gepflegt im Admin-Panel. Gleiche Abfragen und Schreibzugriffe wie PHP.
import { exec, one, q, value, type Row } from '../db.js';
import { cleanText, mainUrl } from '../helpers.js';
import { date, intval, phpStr, phpTrim, phpTruthy } from '../php.js';
import { phpKey } from './util.js';
import { UCP_WORD, UCP_WS } from './pcre.js';

export interface Category { label: string; color: string }
export interface MilestoneStatus { label: string; short: string; color: string }

// OYS_UPDATE_CATEGORIES – die Reihenfolge zählt (Auswahlliste im Admin)
export const UPDATE_CATEGORIES: Record<string, Category> = {
  new: { label: 'New', color: '#22c55e' },
  improved: { label: 'Improved', color: '#818cf8' },
  fixed: { label: 'Fixed', color: '#f59e0b' },
  news: { label: 'News', color: '#ec4899' },
};

// Einträge pro Seite auf /updates
export const UPDATES_PER_PAGE = 15;

// OYS_MILESTONE_STATUSES
export const MILESTONE_STATUSES: Record<string, MilestoneStatus> = {
  now: { label: 'Working on now', short: 'In progress', color: '#22c55e' },
  next: { label: 'Up next', short: 'Up next', color: '#818cf8' },
  planned: { label: 'Later', short: 'Planned', color: '#a1a1aa' },
  done: { label: 'Shipped', short: 'Shipped', color: '#f59e0b' },
};

// isset(KONSTANTE[$x]): nur eigene Schlüssel; ein Array als Schlüssel ist in PHP ein TypeError (HTTP 500)
export const isCategory = (key: unknown): key is string => Object.hasOwn(UPDATE_CATEGORIES, phpKey(key));
export const isMilestoneStatus = (key: unknown): key is string => Object.hasOwn(MILESTONE_STATUSES, phpKey(key));

export interface Update {
  id: number;
  title: string;
  body: string;
  version: string;
  category: string;
  milestone_id: number | null;
  is_published: boolean;
  published_at: string | null;
  discord_announce: boolean;
  discord_message_id: string;
  discord_target: string;
  created_at: string | null;
  updated_at: string | null;
}

export interface Task { id: number; title: string; is_done: boolean; done_at: string | null }
export interface Progress { done: number; total: number; percent: number }

export interface Milestone {
  id: number;
  title: string;
  description: string;
  status: string;
  target: string;
  position: number;
  is_public: boolean;
  started_at: string | null;
  done_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  tasks: Task[];
  progress: Progress | null;
}

// Formularfelder wie $_POST (Text oder Array)
export type Input = Record<string, unknown>;

const now = (): string => date('Y-m-d H:i:s');
// Version: nur \w (Unicode), Punkt, Bindestrich und Leerzeichen bleiben
const VERSION_JUNK = new RegExp(`[^${UCP_WORD}.\\- ]+`, 'gu');
const nullable = (v: unknown): string | null => (v === null || v === undefined ? null : phpStr(v));

// ---------------------------------------------------------------- Updates

// oys_update_from_row()
export function updateFromRow(row: Row): Update {
  return {
    id: intval(row.id),
    title: phpStr(row.title),
    body: phpStr(row.body ?? ''),
    version: phpStr(row.version ?? ''),
    category: isCategory(row.category ?? '') ? (row.category as string) : 'news',
    milestone_id: row.milestone_id !== null && row.milestone_id !== undefined ? intval(row.milestone_id) : null,
    is_published: phpTruthy(row.is_published),
    published_at: nullable(row.published_at),
    discord_announce: phpTruthy(row.discord_announce ?? true),
    discord_message_id: phpStr(row.discord_message_id ?? ''),
    discord_target: phpStr(row.discord_target ?? ''),
    created_at: nullable(row.created_at),
    updated_at: nullable(row.updated_at),
  };
}

// oys_updates_list(): öffentlich nur veröffentlichte, neueste zuerst; im Admin Entwürfe oben
export async function updatesList(publishedOnly: boolean, limit = 100, offset = 0): Promise<Update[]> {
  let sql = publishedOnly
    ? 'SELECT * FROM updates WHERE is_published = 1 ORDER BY published_at DESC, id DESC'
    : 'SELECT * FROM updates ORDER BY is_published ASC, COALESCE(published_at, created_at) DESC, id DESC';
  sql += ' LIMIT ' + Math.max(1, Math.trunc(limit)) + ' OFFSET ' + Math.max(0, Math.trunc(offset));
  return (await q(sql)).map(updateFromRow);
}

// oys_updates_count()
export async function updatesCount(publishedOnly: boolean): Promise<number> {
  return intval(await value('SELECT COUNT(*) FROM updates' + (publishedOnly ? ' WHERE is_published = 1' : '')));
}

// oys_update_get()
export async function updateGet(id: number): Promise<Update | null> {
  const row = await one('SELECT * FROM updates WHERE id = ?', [id]);
  return row ? updateFromRow(row) : null;
}

// oys_update_save(): speichert ein Update aus dem Admin-Formular → [id, null] oder [null, Fehler]
export async function updateSave(input: Input, existing: Update | null): Promise<[number, null] | [null, string]> {
  const title = cleanText(input.title ?? '', 160);
  if (title === '') return [null, 'Please enter a title.'];
  const body = cleanText(input.body ?? '', 20000, true);
  const version = cleanText(input.version ?? '', 40).replace(VERSION_JUNK, '');
  const category = isCategory(input.category ?? '') ? (input.category as string) : 'new';
  let milestoneId = intval(input.milestone_id ?? 0);
  if (milestoneId && !(await milestoneGet(milestoneId))) milestoneId = 0;
  const publish = phpTruthy(input.publish);
  // In Discord ankündigen: die Wahl aus dem Formular gilt auch für späteres Veröffentlichen
  const announce = phpTruthy(input.announce_field) ? phpTruthy(input.post_discord) : phpTruthy(existing?.discord_announce ?? true);

  // Datum nur übernehmen, wenn es im Formular geändert wurde. Sonst bleibt der bisherige Zeitpunkt –
  // Entwürfe bekommen ihren erst beim Veröffentlichen.
  const today = date('Y-m-d');
  const day = phpTrim(phpStr(input.date ?? ''));
  let publishedAt: string | null = existing?.published_at ?? null;
  if (day !== '' && day !== phpStr(input.date_default ?? '')) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
    if (!m || !checkdate(intval(m[2]), intval(m[3]), intval(m[1]))) return [null, 'Please enter a valid date.'];
    if (day > today) return [null, 'The date can’t be in the future.'];
    if (!phpTruthy(publishedAt) || publishedAt!.slice(0, 10) !== day) {
      publishedAt = day + ' ' + (day === today ? date('H:i:s') : '12:00:00');
    }
  }
  if (publish && !phpTruthy(publishedAt)) publishedAt = now();

  const stamp = now();
  const params = [title, body, version, category, milestoneId || null, publish ? 1 : 0, publishedAt, announce ? 1 : 0, stamp];
  if (existing) {
    await exec('UPDATE updates SET title = ?, body = ?, version = ?, category = ?, milestone_id = ?, is_published = ?, published_at = ?, discord_announce = ?, updated_at = ? WHERE id = ?',
      [...params, existing.id]);
    return [existing.id, null];
  }
  const res = await exec('INSERT INTO updates (title, body, version, category, milestone_id, is_published, published_at, discord_announce, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [...params, stamp]);
  return [res.insertId, null];
}

// checkdate(): gültiges Datum im gregorianischen Kalender (Jahr 1–32767)
function checkdate(month: number, day: number, year: number): boolean {
  if (month < 1 || month > 12 || day < 1 || year < 1 || year > 32767) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

// oys_update_set_published(): der Zeitpunkt bleibt beim Zurückziehen erhalten
export async function updateSetPublished(update: Update, published: boolean): Promise<void> {
  const publishedAt = phpTruthy(update.published_at) ? update.published_at : published ? now() : null;
  await exec('UPDATE updates SET is_published = ?, published_at = ?, updated_at = ? WHERE id = ?', [published ? 1 : 0, publishedAt, now(), update.id]);
}

// oys_update_delete()
export async function updateDelete(id: number): Promise<void> {
  await exec('DELETE FROM updates WHERE id = ?', [id]);
}

// oys_update_url(): dauerhafter Link zu einem Update – leitet auf die richtige Seite von /updates weiter
export const updateUrl = (id: number): string => mainUrl('/updates/' + id);

// oys_update_page_of(): auf welcher Seite von /updates steht ein veröffentlichtes Update? null = nicht (mehr) öffentlich
export async function updatePageOf(id: number): Promise<number | null> {
  const u = await updateGet(id);
  if (!u || !u.is_published || !phpTruthy(u.published_at)) return null;
  const count = await value('SELECT COUNT(*) FROM updates WHERE is_published = 1 AND (published_at > ? OR (published_at = ? AND id > ?))',
    [u.published_at, u.published_at, id]);
  return Math.floor(intval(count) / UPDATES_PER_PAGE) + 1;
}

// ---------------------------------------------------------------- Roadmap

// oys_milestone_from_row()
export function milestoneFromRow(row: Row): Milestone {
  return {
    id: intval(row.id),
    title: phpStr(row.title),
    description: phpStr(row.description ?? ''),
    status: isMilestoneStatus(row.status ?? '') ? (row.status as string) : 'planned',
    target: phpStr(row.target ?? ''),
    position: intval(row.position),
    is_public: phpTruthy(row.is_public),
    started_at: nullable(row.started_at),
    done_at: nullable(row.done_at),
    created_at: nullable(row.created_at),
    updated_at: nullable(row.updated_at),
    tasks: [],
    progress: null,
  };
}

// oys_milestone_get(): mit Aufgaben und Fortschritt
export async function milestoneGet(id: number): Promise<Milestone | null> {
  const row = await one('SELECT * FROM milestones WHERE id = ?', [id]);
  if (!row) return null;
  return (await milestonesAttachTasks([milestoneFromRow(row)]))[0];
}

// oys_milestones(): sortiert nach Status (now, next, planned, done) und Position – mit Aufgaben und Fortschritt
export async function milestones(publicOnly: boolean): Promise<Milestone[]> {
  const sql = 'SELECT * FROM milestones' + (publicOnly ? ' WHERE is_public = 1' : '')
    + " ORDER BY FIELD(status, 'now', 'next', 'planned', 'done'), CASE WHEN status = 'done' THEN COALESCE(done_at, updated_at) END DESC, position ASC, id ASC";
  return milestonesAttachTasks((await q(sql)).map(milestoneFromRow));
}

// oys_milestones_attach_tasks()
export async function milestonesAttachTasks(list: Milestone[]): Promise<Milestone[]> {
  if (!list.length) return [];
  const ids = list.map((m) => m.id);
  const tasks = new Map<number, Task[]>();
  for (const t of await q('SELECT * FROM milestone_tasks WHERE milestone_id IN (' + ids.join(',') + ') ORDER BY position ASC, id ASC')) {
    const mid = intval(t.milestone_id);
    if (!tasks.has(mid)) tasks.set(mid, []);
    tasks.get(mid)!.push({ id: intval(t.id), title: phpStr(t.title), is_done: phpTruthy(t.is_done), done_at: nullable(t.done_at) });
  }
  for (const m of list) {
    m.tasks = tasks.get(m.id) ?? [];
    m.progress = milestoneProgress(m);
  }
  return list;
}

// oys_milestone_progress(): nur aus echten, abgehakten Teilaufgaben – keine geschätzten Prozentzahlen
export function milestoneProgress(m: { tasks: Task[] }): Progress | null {
  const total = m.tasks.length;
  if (total === 0) return null;
  const done = m.tasks.filter((t) => t.is_done).length;
  return { done, total, percent: Math.floor((done * 100) / total) };
}

// oys_milestone_save() → [id, null] oder [null, Fehler]
export async function milestoneSave(input: Input, existing: Milestone | null): Promise<[number, null] | [null, string]> {
  const title = cleanText(input.title ?? '', 160);
  if (title === '') return [null, 'Please enter a title for the milestone.'];
  const description = cleanText(input.description ?? '', 4000, true);
  const status = isMilestoneStatus(input.status ?? '') ? (input.status as string) : 'planned';
  const target = cleanText(input.target ?? '', 40);
  const isPublic = phpTruthy(input.is_public) ? 1 : 0;
  const stamp = now();

  let id: number;
  if (existing) {
    await exec('UPDATE milestones SET title = ?, description = ?, target = ?, is_public = ?, updated_at = ? WHERE id = ?',
      [title, description, target, isPublic, stamp, existing.id]);
    id = existing.id;
    if (status !== existing.status) await milestoneSetStatus(existing, status);
  } else {
    const pos = intval(await value('SELECT COALESCE(MAX(position), 0) + 1 FROM milestones'));
    const res = await exec('INSERT INTO milestones (title, description, status, target, position, is_public, started_at, done_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [title, description, status, target, pos, isPublic, status === 'now' ? stamp : null, status === 'done' ? stamp : null, stamp, stamp]);
    id = res.insertId;
  }
  // Neue Aufgaben: eine pro Zeile („[x] …“ = schon erledigt)
  for (const line of taskLines(phpStr(input.tasks ?? ''))) {
    await taskAdd(id, line.title, line.done);
  }
  return [id, null];
}

const TASK_DONE = new RegExp(`^[${UCP_WS}]*(?:[-*\\u{2022}][${UCP_WS}]*)?\\[[xX]\\]`, 'u');
const TASK_PREFIX = new RegExp(`^[${UCP_WS}]*(?:[-*\\u{2022}][${UCP_WS}]*)?(?:\\[[ xX]?\\])?[${UCP_WS}]*`, 'u');
// ignoreBOM: ein U+FEFF am Anfang bleibt wie in PHP Teil der Zeile
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// Aufgaben-Zeilen wie in PHP: preg_split('/\R/') läuft ohne /u auf Bytes und trennt darum auch am Byte 0x85, das in
// vielen UTF-8-Zeichen steckt (ą, Å, х …). Solche Bruchstücke sind kein gültiges UTF-8 – die Muster mit /u schlagen
// dann fehl und die Zeile fällt weg. Absichtlich gleich wie PHP – die Korrektur kommt als eigene Änderung.
export function taskLines(text: string): Array<{ title: string; done: boolean }> {
  const out: Array<{ title: string; done: boolean }> = [];
  const bytes = Buffer.from(text, 'utf8').toString('latin1');
  for (const part of bytes.split(/\r\n|[\n\v\f\r\x85]/)) {
    let line: string;
    try {
      line = UTF8.decode(Buffer.from(part, 'latin1'));
    } catch {
      continue;
    }
    const done = TASK_DONE.test(line);
    const title = phpTrim(line.replace(TASK_PREFIX, ''));
    if (title !== '') out.push({ title, done });
  }
  return out;
}

// oys_milestone_set_status(): in der neuen Spalte hinten anstellen
export async function milestoneSetStatus(ms: Milestone, status: string): Promise<void> {
  if (!isMilestoneStatus(status) || status === ms.status) return;
  const stamp = now();
  const started = phpTruthy(ms.started_at) ? ms.started_at : status === 'now' || status === 'done' ? stamp : null;
  const done = status === 'done' ? (phpTruthy(ms.done_at) ? ms.done_at : stamp) : null;
  const pos = intval(await value('SELECT COALESCE(MAX(position), 0) + 1 FROM milestones WHERE status = ? AND id <> ?', [status, ms.id]));
  await exec('UPDATE milestones SET status = ?, position = ?, started_at = ?, done_at = ?, updated_at = ? WHERE id = ?',
    [status, pos, started, done, stamp, ms.id]);
}

// oys_milestone_move(): innerhalb derselben Spalte mit dem Nachbarn tauschen („Shipped“ ist nach Datum sortiert)
export async function milestoneMove(ms: Milestone, direction: string): Promise<void> {
  if (ms.status === 'done') return;
  const list = (await milestones(false)).filter((m) => m.status === ms.status);
  const i = list.findIndex((m) => m.id === ms.id);
  if (i < 0) return;
  const j = direction === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= list.length) return;
  const order = list.map((m) => m.id);
  [order[i], order[j]] = [order[j], order[i]];
  for (let pos = 0; pos < order.length; pos++) {
    await exec('UPDATE milestones SET position = ? WHERE id = ?', [pos + 1, order[pos]]);
  }
}

// oys_milestone_delete(): Aufgaben weg, Updates verlieren nur den Verweis
export async function milestoneDelete(id: number): Promise<void> {
  await exec('DELETE FROM milestone_tasks WHERE milestone_id = ?', [id]);
  await exec('UPDATE updates SET milestone_id = NULL WHERE milestone_id = ?', [id]);
  await exec('DELETE FROM milestones WHERE id = ?', [id]);
}

// oys_task_add()
export async function taskAdd(milestoneId: number, title: string, done = false): Promise<void> {
  const clean = cleanText(title, 200);
  if (clean === '') return;
  const pos = intval(await value('SELECT COALESCE(MAX(position), 0) + 1 FROM milestone_tasks WHERE milestone_id = ?', [milestoneId]));
  await exec('INSERT INTO milestone_tasks (milestone_id, title, is_done, position, done_at) VALUES (?, ?, ?, ?, ?)',
    [milestoneId, clean, done ? 1 : 0, pos, done ? now() : null]);
  await milestoneTouch(milestoneId);
}

// oys_task_get(): die Zeile, wie sie in der Datenbank steht
export async function taskGet(id: number): Promise<Row | null> {
  return one('SELECT * FROM milestone_tasks WHERE id = ?', [id]);
}

// oys_task_toggle()
export async function taskToggle(task: Row): Promise<void> {
  const done = !intval(task.is_done);
  await exec('UPDATE milestone_tasks SET is_done = ?, done_at = ? WHERE id = ?', [done ? 1 : 0, done ? now() : null, intval(task.id)]);
  await milestoneTouch(intval(task.milestone_id));
}

// oys_task_delete()
export async function taskDelete(task: Row): Promise<void> {
  await exec('DELETE FROM milestone_tasks WHERE id = ?', [intval(task.id)]);
  await milestoneTouch(intval(task.milestone_id));
}

// oys_milestone_touch()
export async function milestoneTouch(id: number): Promise<void> {
  await exec('UPDATE milestones SET updated_at = ? WHERE id = ?', [now(), id]);
}
