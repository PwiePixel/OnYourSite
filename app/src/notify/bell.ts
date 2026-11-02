// Glocke im Editor (und später im Admin-Kopf): die letzten 15 Benachrichtigungen eines Kontos und „gelesen“.
// Jede Abfrage filtert nach user_id aus der Sitzung; „gelesen bis“ betrifft nur, was der Nutzer schon gesehen hat.
import type { Ctx } from '../web/ctx.js';
import { exec, q, value } from '../db.js';
import { intval, phpTruthy } from '../php.js';
import { timeAgo } from '../helpers.js';
import { isArr, own, type PhpArr } from '../content/util.js';
import { safeLink } from './links.js';
import { notifyType, type Tone } from './types.js';

export interface BellItem {
  id: number;
  type: unknown;
  title: unknown;
  body: unknown;
  read: boolean;
  ago: string;
  link: string;
  icon: string;
  tone: Tone;
}

// GET /dashboard/api/notifications – die bisherigen Schlüssel zuerst, neue hinten (link, icon, tone, latest)
export async function bellList(userId: number): Promise<{ ok: true; unread: number; messages_unread: number; items: BellItem[]; latest: number }> {
  const rows = await q('SELECT id, type, title, body, link, is_read, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 15', [userId]);
  const items = rows.map((n): BellItem => {
    const look = notifyType(n.type);
    return {
      id: intval(n.id),
      type: n.type,
      title: n.title,
      body: n.body,
      read: phpTruthy(n.is_read),
      ago: timeAgo(n.created_at),
      // Gespeichertes Ziel nur, wenn es (noch) ein eigener Pfad ist, sonst das Ziel des Typs
      link: safeLink(n.link) || look.link,
      icon: look.icon,
      tone: look.tone,
    };
  });
  const unread = intval(await value('SELECT COUNT(*) FROM notifications WHERE user_id = ? AND is_read = 0', [userId]));
  const messagesUnread = intval(await value('SELECT COUNT(*) FROM messages WHERE user_id = ? AND is_read = 0', [userId]));
  return { ok: true, unread, messages_unread: messagesUnread, items, latest: items.length ? items[0].id : 0 };
}

export type BellReadTarget = { id: number } | { upTo: number } | { all: true };

// Nummer einer Benachrichtigung aus dem JSON: nur ganze Zahlen 1 … 4294967295 (auch als Ziffern-Text)
function rowId(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 1 && v <= 4294967295 ? v : null;
  if (typeof v === 'string' && /^[1-9][0-9]{0,9}$/.test(v)) return rowId(Number(v));
  return null;
}

// Was soll gelesen werden? {id} eine, {upTo} alles bis zur neuesten gesehenen, {} alles (nur Editor-Tabs, die vor
// dem Update geöffnet wurden – sie schicken höchstens page_id). null: ungültige Angabe.
export function bellReadTarget(input: PhpArr): BellReadTarget | null {
  const has = (k: string): boolean => isArr(input) && own(input, k) !== undefined;
  if (has('id')) {
    const id = rowId(own(input, 'id'));
    return id === null ? null : { id };
  }
  if (has('upTo')) {
    const upTo = rowId(own(input, 'upTo'));
    return upTo === null ? null : { upTo };
  }
  return { all: true };
}

// POST /dashboard/api/notifications-read → [Status, Antwort]. Im Nutzer-Modus eines Admins wird nichts geschrieben:
// Der Nutzer soll seine ungelesenen Hinweise danach noch sehen.
export async function bellRead(ctx: Ctx, userId: number, input: PhpArr): Promise<[number, Record<string, unknown>]> {
  const target = bellReadTarget(input);
  if (target === null) return [400, { ok: false, error: 'Unknown notification.' }];
  const original = ctx.session?.get('original_admin_id');
  if (original !== undefined && original !== null) return [200, { ok: true, readonly: true }];
  if ('id' in target) {
    await exec('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND id = ?', [userId, target.id]);
  } else if ('upTo' in target) {
    await exec('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND id <= ? AND is_read = 0', [userId, target.upTo]);
  } else {
    await exec('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0', [userId]);
  }
  return [200, { ok: true }];
}
