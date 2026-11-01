// Community: Discord-Bot ↔ Webseite – Vorschläge (Forum-Kanal) und Support-Tickets (lib/community.php).
//
// Der Bot meldet sich über /_/bot/… (jede Anfrage signiert mit 'bot_secret' aus den Einstellungen) und holt
// Aufträge der Webseite (z. B. „im Admin angenommen“) aus einer Warteschlange ab. Die Webseite kennt keinen
// Bot-Token und spricht Discord nie selbst an.
import { createHmac } from 'node:crypto';
import { configString } from '../config.js';
import { decrypt, encryptData, safeEqual } from '../crypto.js';
import { exec, one, q, value, type Db, type Row } from '../db.js';
import { ctypeDigit, date, intval, mbSubstr, phpStr, phpTrim, strlen, strtolower, strtoupper, time } from '../php.js';
import { phpCastString, phpJsonEncode } from './json.js';

export const BOT_MAX_SKEW = 300; // Sekunden, die eine signierte Anfrage alt sein darf
export const BOT_TEXT_MAX = 4000; // längster Text (Vorschlag, Ticket-Nachricht)
export const SUGGESTION_STATUSES = ['open', 'accepted', 'declined'];

// oys_bot_secret(): erst ab 32 Bytes gilt das Geheimnis
export function botSecret(): string {
  const secret = configString('bot_secret', '');
  return strlen(secret) >= 32 ? secret : '';
}

// Wert eines Request-Headers wie $_SERVER['HTTP_…'] (mehrfach gesendet: mit ", " verbunden)
export function headerValue(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v.join(', ') : (v ?? '');
}

// oys_bot_verify(): Signatur prüfen – HMAC-SHA256 über Zeitstempel, Methode, Pfad (mit Query) und Inhalt.
// uri ist das rohe REQUEST_URI (Node liefert es als latin1-Text, also Byte für Byte zurückwandelbar).
export function botVerify(method: string, uri: string, body: Buffer, tsHeader: string, sigHeader: string): boolean {
  const secret = botSecret();
  const ts = tsHeader;
  const sig = strtolower(sigHeader);
  // PCRE: $ passt auch vor einem letzten Zeilenumbruch
  if (secret === '' || !ctypeDigit(ts) || Math.abs(time() - intval(ts)) > BOT_MAX_SKEW || !/^[0-9a-f]{64}\n?$/.test(sig)) {
    return false;
  }
  const data = Buffer.concat([Buffer.from(ts + '\n' + strtoupper(method) + '\n', 'latin1'), Buffer.from(uri, 'latin1'), Buffer.from('\n'), body]);
  const expected = createHmac('sha256', secret).update(data).digest('hex');
  return safeEqual(expected, sig);
}

// oys_snowflake(): Discord-ID (15–22 Ziffern) als Text, sonst null
export function snowflake(value: unknown): string | null {
  const s = phpCastString(value);
  return /^\d{15,22}\n?$/.test(s) ? s : null;
}

// oys_community_text(): Zeilenenden vereinheitlichen, Nullbytes weg, trim, auf max Zeichen kürzen
export function communityText(value: unknown, max: number): string {
  let text = phpCastString(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\0/g, '');
  // Ungültiges UTF-8 ersetzt PHP durch „?“ – in JavaScript-Text können nur einzelne Ersatzzeichen ungültig sein
  text = text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '?');
  return mbSubstr(phpTrim(text), 0, max);
}

// oys_community_seal(): Ticket-Nachrichten verschlüsselt speichern. Das Vorzeichen sorgt dafür, dass auch ein
// Text, der zufällig mit „ENC:“ beginnt, verschlüsselt wird.
export function communitySeal(text: string): string {
  return String(encryptData('\x01' + text));
}

// oys_community_open()
export function communityOpen(stored: unknown): string {
  const plain = decrypt(stored === null || stored === undefined ? '' : phpStr(stored));
  return plain.startsWith('\x01') ? plain.slice(1) : plain;
}

// oys_bot_last_seen(): letzter Kontakt des Bots (Unix-Zeit) oder null
export async function botLastSeen(): Promise<number | null> {
  const rows = await q("SELECT meta_value FROM oys_meta WHERE meta_key = 'bot_last_seen'");
  return rows.length ? intval(rows[0].meta_value) : null;
}

// oys_bot_seen(): höchstens einmal pro Minute schreiben
export async function botSeen(): Promise<void> {
  const last = intval(await botLastSeen());
  if (time() - last >= 60) {
    await exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('bot_last_seen', ?)", [String(time())]);
  }
}

// ---------------------------------------------------------------- Vorschläge

// oys_suggestion_get()
export async function suggestionGet(id: number): Promise<Row | null> {
  return one('SELECT * FROM community_suggestions WHERE id = ?', [id]);
}

// oys_suggestion_public(): was der Bot über einen Vorschlag erfährt (IDs bleiben Text)
export function suggestionPublic(s: Row): Record<string, unknown> {
  return {
    id: intval(s.id),
    thread_id: s.thread_id,
    title: s.title,
    status: s.status,
    reason: phpStr(s.reason),
    decided_by: phpStr(s.decided_by),
    decided_via: phpStr(s.decided_via),
    decided_at: s.decided_at,
    status_message_id: phpStr(s.status_message_id),
    author_id: s.author_id,
  };
}

// oys_suggestion_decide(): Entscheidung speichern (nur solange offen). Gibt [Vorschlag, geändert?] zurück.
export async function suggestionDecide(s: Row, status: string, reason: string, byName: string, via: string): Promise<[Row | null, boolean]> {
  if (s.status !== 'open' || !(status === 'accepted' || status === 'declined')) {
    return [s, false];
  }
  const now = date('Y-m-d H:i:s');
  const res = await exec(
    "UPDATE community_suggestions SET status = ?, reason = ?, decided_by = ?, decided_via = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'open'",
    [status, reason, byName, via, now, now, s.id as number],
  );
  return [await suggestionGet(intval(s.id)), res.affectedRows > 0];
}

// ---------------------------------------------------------------- Tickets

// oys_ticket_get()
export async function ticketGet(id: number): Promise<Row | null> {
  return one('SELECT * FROM community_tickets WHERE id = ?', [id]);
}

// oys_ticket_public()
export function ticketPublic(t: Row): Record<string, unknown> {
  return {
    id: intval(t.id),
    channel_id: phpStr(t.channel_id),
    user_id: t.user_id,
    subject: t.subject,
    status: t.status,
  };
}

// Abfragen über den Pool (je Abfrage eine freie Verbindung)
const POOL: Db = { q, one, value, exec };

// oys_ticket_add_message(): true, wenn die Nachricht neu ist (dieselbe Discord-Nachricht kommt nur einmal hinein).
// db: die Verbindung, die gerade die Ticket-Sperre hält (wie in PHP alles auf einer Verbindung)
export async function ticketAddMessage(ticketId: number, messageId: string | null, authorId: string | null, authorName: string, team: boolean, source: string, body: string, db: Db = POOL): Promise<boolean> {
  const now = date('Y-m-d H:i:s');
  const res = await db.exec(
    'INSERT IGNORE INTO community_ticket_messages (ticket_id, discord_message_id, author_id, author_name, is_team, source, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [ticketId, messageId, authorId, authorName, team ? 1 : 0, source, communitySeal(body), now],
  );
  if (res.affectedRows) {
    await db.exec('UPDATE community_tickets SET updated_at = ? WHERE id = ?', [now, ticketId]);
    return true;
  }
  return false;
}

// oys_ticket_close(): true, wenn das Ticket gerade geschlossen wurde
export async function ticketClose(t: Row, byName: string, via: string): Promise<boolean> {
  if (t.status !== 'open') {
    return false;
  }
  const now = date('Y-m-d H:i:s');
  const res = await exec(
    "UPDATE community_tickets SET status = 'closed', closed_by = ?, closed_via = ?, closed_at = ?, updated_at = ? WHERE id = ? AND status = 'open'",
    [byName, via, now, now, t.id as number],
  );
  return res.affectedRows > 0;
}

// oys_ticket_messages(): alle Nachrichten eines Tickets, entschlüsselt
export async function ticketMessages(ticketId: number): Promise<Row[]> {
  const rows = await q('SELECT * FROM community_ticket_messages WHERE ticket_id = ? ORDER BY id', [ticketId]);
  return rows.map((m) => ({ ...m, body: communityOpen(m.body) }));
}

// ---------------------------------------------------------------- Aufträge für den Bot (Warteschlange)

// oys_outbox_add(): JSON mit Umlauten, aber maskierten Schrägstrichen (JSON_UNESCAPED_UNICODE)
export async function outboxAdd(action: string, data: unknown): Promise<void> {
  const payload = phpJsonEncode(data, { unescapedUnicode: true });
  await exec('INSERT INTO community_outbox (action, payload, created_at) VALUES (?, ?, ?)', [action, payload === false ? '' : payload, date('Y-m-d H:i:s')]);
}
