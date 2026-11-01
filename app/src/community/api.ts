// /_/bot/…: signierte Schnittstelle für den Discord-Bot (oys_bot_api in lib/community.php)
import type { Ctx } from '../web/ctx.js';
import { exec, q, withNamedLock, type Row } from '../db.js';
import { mainUrl } from '../helpers.js';
import { date, intval, strtolower, time } from '../php.js';
import { PhpArr, jsonField, oysJsonBody, phpCastString, phpJsonDecode, phpJsonTruthy, type PhpJson } from './json.js';
import {
  BOT_TEXT_MAX, botSecret, botSeen, botVerify, communityText, headerValue, snowflake, suggestionDecide, suggestionGet,
  suggestionPublic, ticketAddMessage, ticketClose, ticketGet, ticketPublic,
} from './community.js';

// Größter Inhalt, den die Schnittstelle annimmt
const MAX_BODY = 65536;

// oys_json() mit den Regeln von json_encode() (ein Fehler ergibt einen leeren Inhalt)
function json(ctx: Ctx, data: unknown, code = 200): never {
  return ctx.json(data, code, oysJsonBody);
}

// php://input: bei multipart/form-data liest PHP den Inhalt selbst ein und lässt php://input leer.
// Den Typ vergleicht PHP klein geschrieben bis zum ersten ';', ',' oder Leerzeichen.
function phpInput(ctx: Ctx): Buffer {
  const type = headerValue(ctx.headers['content-type']);
  const cut = type.search(/[;, ]/);
  if (strtolower(cut >= 0 ? type.slice(0, cut) : type) === 'multipart/form-data') return Buffer.alloc(0);
  return ctx.rawBody;
}

// $in['key'] ?? $fallback
function input(arr: PhpJson, key: string, fallback: PhpJson = ''): PhpJson {
  const v = jsonField(arr, key);
  return v === undefined || v === null ? fallback : v;
}

// oys_bot_api()
export async function botApi(ctx: Ctx): Promise<void> {
  ctx.header('X-Robots-Tag', 'noindex, nofollow');
  ctx.header('Cache-Control', 'no-store');
  const method = ctx.method;
  // Ohne Geheimnis in den Einstellungen gibt es die Schnittstelle nicht
  if (botSecret() === '') {
    json(ctx, { ok: false, error: 'Not found.' }, 404);
  }
  const raw = method === 'POST' ? phpInput(ctx) : Buffer.alloc(0);
  if (raw.length > MAX_BODY || !botVerify(method, ctx.rawUrl, raw, headerValue(ctx.headers['x-oys-timestamp']), headerValue(ctx.headers['x-oys-signature']))) {
    json(ctx, { ok: false, error: 'Unauthorized.' }, 401);
  }
  const data: PhpJson = raw.length ? phpJsonDecode(raw) : new PhpArr();
  if (!(data instanceof PhpArr)) {
    json(ctx, { ok: false, error: 'Invalid JSON.' }, 400);
  }
  await botSeen();
  const route = ctx.path.slice('/_/bot'.length);
  const now = date('Y-m-d H:i:s');
  let m: RegExpExecArray | null;

  if (route === '/ping' && method === 'GET') {
    json(ctx, { ok: true, time: time(), site: mainUrl('/') });
  }

  // --- Vorschläge ---
  if (route === '/suggestions' && method === 'POST') {
    const thread = snowflake(input(data, 'thread_id'));
    const author = snowflake(input(data, 'author_id'));
    const title = communityText(input(data, 'title'), 200);
    if (!thread || !author || title === '') {
      json(ctx, { ok: false, error: 'thread_id, author_id and title are required.' }, 400);
    }
    await exec(
      'INSERT IGNORE INTO community_suggestions (thread_id, author_id, author_name, title, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [thread, author, communityText(input(data, 'author_name'), 100), title, communityText(input(data, 'body'), BOT_TEXT_MAX), 'open', now, now],
    );
    const rows = await q('SELECT * FROM community_suggestions WHERE thread_id = ?', [thread]);
    json(ctx, { ok: true, suggestion: suggestionPublic(rows[0]) });
  }
  if ((m = /^\/suggestions\/(\d+)(\/decision)?\n?$/.exec(route)) && method === 'POST') {
    let s = await suggestionGet(intval(m[1]));
    if (!s) {
      json(ctx, { ok: false, error: 'Suggestion not found.' }, 404);
    }
    if (!m[2]) {
      const msg = snowflake(input(data, 'status_message_id'));
      if (msg) {
        await exec('UPDATE community_suggestions SET status_message_id = ?, updated_at = ? WHERE id = ?', [msg, now, s.id as number]);
      }
      json(ctx, { ok: true, suggestion: suggestionPublic((await suggestionGet(intval(s.id))) as Row) });
    }
    // Der Knopf gehört zu genau einem Beitrag – nach einem Neuanfang können Nummern wieder vorkommen
    const thread = snowflake(input(data, 'thread_id'));
    if (thread && thread !== phpCastString(s.thread_id)) {
      json(ctx, { ok: false, error: 'This button belongs to an older post.' }, 409);
    }
    const status = phpCastString(input(data, 'status'));
    if (status !== 'accepted' && status !== 'declined') {
      json(ctx, { ok: false, error: 'status must be accepted or declined.' }, 400);
    }
    let changed: boolean;
    [s, changed] = await suggestionDecide(s, status, communityText(input(data, 'reason'), 500), communityText(input(data, 'by_name', 'Team'), 100), 'discord');
    json(ctx, { ok: true, changed, suggestion: suggestionPublic(s as Row) });
  }

  // --- Tickets ---
  if (route === '/tickets' && method === 'POST') {
    const user = snowflake(input(data, 'user_id'));
    const subject = communityText(input(data, 'subject'), 100);
    const body = communityText(input(data, 'body'), BOT_TEXT_MAX);
    const name = communityText(input(data, 'user_name'), 100);
    if (!user || subject === '' || body === '') {
      json(ctx, { ok: false, error: 'user_id, subject and body are required.' }, 400);
    }
    // Höchstens ein offenes Ticket je Person (Sperre gegen Doppelklicks). Wie in PHP läuft alles auf der Verbindung, die
    // die Sperre hält – und das Ergebnis von GET_LOCK prüft PHP nicht: nach zehn Sekunden geht es auch ohne Sperre weiter.
    let id = 0;
    const open = await withNamedLock('oys_ticket_' + user, 10, async (db) => {
      const found = await db.one("SELECT * FROM community_tickets WHERE user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", [user]);
      if (!found) {
        const res = await db.exec("INSERT INTO community_tickets (user_id, user_name, subject, status, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?)", [user, name, subject, now, now]);
        id = res.insertId;
        await ticketAddMessage(id, null, user, name, false, 'discord', body, db);
      }
      return found;
    }, 'run');
    if (open) {
      json(ctx, { ok: false, error: 'open_ticket', ticket: ticketPublic(open) }, 409);
    }
    json(ctx, { ok: true, ticket: ticketPublic((await ticketGet(id)) as Row) });
  }
  if ((m = /^\/tickets\/by-channel\/(\d{15,22})\n?$/.exec(route)) && method === 'GET') {
    const t = (await q('SELECT * FROM community_tickets WHERE channel_id = ? LIMIT 1', [m[1]]))[0];
    json(ctx, t ? { ok: true, ticket: ticketPublic(t) } : { ok: false, error: 'Ticket not found.' }, t ? 200 : 404);
  }
  if ((m = /^\/tickets\/(\d+)\/(channel|messages|close)\n?$/.exec(route)) && method === 'POST') {
    const t = await ticketGet(intval(m[1]));
    if (!t) {
      json(ctx, { ok: false, error: 'Ticket not found.' }, 404);
    }
    if (m[2] === 'channel') {
      const channel = snowflake(input(data, 'channel_id'));
      if (!channel || phpJsonTruthy(t.channel_id)) {
        json(ctx, { ok: false, error: channel ? 'The ticket already has a channel.' : 'channel_id is required.' }, 400);
      }
      await exec('UPDATE community_tickets SET channel_id = ?, updated_at = ? WHERE id = ?', [channel, now, t.id as number]);
      json(ctx, { ok: true, ticket: ticketPublic((await ticketGet(intval(t.id))) as Row) });
    }
    if (m[2] === 'messages') {
      const body = communityText(input(data, 'body'), BOT_TEXT_MAX);
      if (body === '' || t.status !== 'open') {
        json(ctx, { ok: false, error: body === '' ? 'body is required.' : 'The ticket is closed.' }, 400);
      }
      const added = await ticketAddMessage(
        intval(t.id), snowflake(input(data, 'message_id')), snowflake(input(data, 'author_id')), communityText(input(data, 'author_name'), 100),
        phpJsonTruthy(jsonField(data, 'team')), 'discord', body,
      );
      json(ctx, { ok: true, added });
    }
    const changed = await ticketClose(t, communityText(input(data, 'by_name'), 100), 'discord');
    json(ctx, { ok: true, changed, ticket: ticketPublic((await ticketGet(intval(t.id))) as Row) });
  }

  // --- Aufträge der Webseite ---
  if (route === '/outbox' && method === 'GET') {
    const rows = await q('SELECT id, action, payload, attempts FROM community_outbox WHERE done_at IS NULL AND attempts < 10 ORDER BY id LIMIT 20');
    json(ctx, {
      ok: true,
      items: rows.map((r) => ({ id: intval(r.id), action: r.action, data: phpJsonDecode(phpCastString(r.payload)), attempts: intval(r.attempts) })),
    });
  }
  if ((m = /^\/outbox\/(\d+)\/done\n?$/.exec(route)) && method === 'POST') {
    const error = communityText(input(data, 'error'), 200);
    if (error === '') {
      await exec('UPDATE community_outbox SET done_at = ?, last_error = NULL WHERE id = ?', [now, intval(m[1])]);
    } else {
      await exec('UPDATE community_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?', [error, intval(m[1])]);
    }
    json(ctx, { ok: true });
  }

  json(ctx, { ok: false, error: 'Not found.' }, 404);
}
