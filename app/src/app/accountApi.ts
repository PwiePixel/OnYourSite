// Aktionen der Editor-API, die zum Konto gehören statt zu einer Profilseite: Glocke, Nachrichten und Termine.
// Sie laufen vor „Create a page first.“ – so funktionieren sie auch für Konten ohne (gezeigte) Profilseite. Jede
// Abfrage filtert nach dem Konto der Sitzung. Kehrt nur zurück, wenn die Aktion nicht hierher gehört (oder per GET
// kam, wo POST nötig ist – dann antwortet editorApi wie bisher mit „Unknown action.“).
import type { Ctx } from '../web/ctx.js';
import { exec, q } from '../db.js';
import { decryptData } from '../crypto.js';
import { timeAgo } from '../helpers.js';
import { date, intval, phpStr, phpTruthy, strtotime } from '../php.js';
import { own, type PhpArr } from '../content/util.js';
import { bellList, bellRead } from '../notify/bell.js';

export async function accountApi(ctx: Ctx, userId: number, action: string, isPost: boolean, input: PhpArr): Promise<void> {
  const inp = (key: string): unknown => own(input, key);
  switch (action) {
    case 'notifications':
      // Die Abfrage der Glocke im Hintergrund (X-OYS-Poll: 1, jede Minute) hält die Sitzung nicht wach: ein offener
      // Tab ohne Bedienung wird nach session_idle_seconds abgemeldet wie ohne Glocke
      if (ctx.headers['x-oys-poll'] === '1') ctx.session?.keepIdle();
      ctx.json(await bellList(userId));

    case 'notifications-read': {
      if (!isPost) break;
      const [status, body] = await bellRead(ctx, userId, input);
      ctx.json(body, status);
    }

    case 'messages': {
      const messages = (await q('SELECT m.*, p.slug FROM messages m LEFT JOIN pages p ON p.id = m.page_id WHERE m.user_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT 200', [userId]))
        .map((m) => {
          const created = strtotime(phpStr(m.created_at));
          return {
            id: intval(m.id),
            page: m.slug,
            name: decryptData(m.name as string),
            email: decryptData(m.email as string),
            message: decryptData(m.message as string),
            read: phpTruthy(m.is_read),
            date: date('M j, Y, H:i', created === false ? 0 : created),
            ago: timeAgo(m.created_at),
          };
        });
      const bookings = (await q('SELECT * FROM user_bookings WHERE user_id = ? ORDER BY booking_date DESC, booking_time DESC LIMIT 200', [userId]))
        .map((b) => {
          const day = phpTruthy(b.booking_date) ? strtotime(phpStr(b.booking_date)) : 0;
          return {
            id: intval(b.id),
            name: decryptData((b.guest_name ?? '') as string),
            email: decryptData((b.guest_email ?? '') as string),
            date: phpTruthy(b.booking_date) ? date('M j, Y', day === false ? 0 : day) : '',
            time: b.booking_time,
            // Vergleich als Text (Y-m-d)
            past: phpTruthy(b.booking_date) && phpStr(b.booking_date) < date('Y-m-d'),
          };
        });
      ctx.json({ ok: true, messages, bookings });
    }

    case 'message': {
      if (!isPost) break;
      const id = intval(inp('id') ?? 0);
      const act = phpStr(inp('action') ?? '');
      if (act === 'delete') {
        await exec('DELETE FROM messages WHERE id = ? AND user_id = ?', [id, userId]);
      } else if (act === 'read' || act === 'unread') {
        await exec('UPDATE messages SET is_read = ? WHERE id = ? AND user_id = ?', [act === 'read' ? 1 : 0, id, userId]);
      }
      ctx.json({ ok: true });
    }

    case 'booking-delete': {
      if (!isPost) break;
      await exec('DELETE FROM user_bookings WHERE id = ? AND user_id = ?', [intval(inp('id') ?? 0), userId]);
      ctx.json({ ok: true });
    }
  }
}
