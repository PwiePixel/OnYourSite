// Mails des Domain-Dienstes: die Zeilen im Verlauf mit mail = 1 (geschrieben in der Transaktion des Zustands), nach
// dem Commit verschickt – je Minute höchstens so viele, wie das Budget in den Einstellungen erlaubt (Q11, Standard 20),
// je Zeile höchstens 5 Versuche. Vorlage email/domain_notice.json im Aussehen des Wochenberichts.
import type { Db } from '../../db.js';
import { e } from '../../html.js';
import { baseHost, mainUrl } from '../../helpers.js';
import { intval, phpStr } from '../../php.js';
import { sendCustomEmail } from '../../mail.js';
import { poolDb } from '../../honeycombs/util.js';
import { NOTICE_TITLES } from '../notify.js';

export interface DomainMail {
  to: string;
  title: string;
  text: string;
  button: string;
  url: string;
  footer: string;
}

export type MailSender = (m: DomainMail) => Promise<boolean>;

// Versand über den Mail-Server der Seite (alle Werte im HTML maskiert)
export const defaultSender: MailSender = (m) => sendCustomEmail(m.to, 'domain_notice', {
  title: e(m.title), text: e(m.text), button_url: e(m.url), button: e(m.button), footer: e(m.footer),
}, m.title, null, { timeoutMs: 15_000 });

const MAX_TRIES = 5;

// Fällige Mails senden; Rückgabe: Anzahl gesendet. at(unix) = Zeit als Text in der Zeitzone der Seite.
export async function sendDomainMails(o: { budget: number; now: number; at: (unix: number) => string; send?: MailSender; db?: Db }): Promise<number> {
  const db = o.db ?? poolDb;
  const send = o.send ?? defaultSender;
  const recent = intval(await db.value('SELECT COUNT(*) FROM custom_domain_log WHERE mailed_at >= ?', [o.at(o.now - 60)]));
  const room = Math.max(0, o.budget - recent);
  if (room === 0) return 0;
  const rows = await db.q(`SELECT l.id, l.event, l.detail, l.domain_id, l.mail_tries, u.email, d.target_id
      FROM custom_domain_log l LEFT JOIN users u ON u.id = l.user_id LEFT JOIN custom_domains d ON d.id = l.domain_id
      WHERE l.mail = 1 AND l.mailed_at IS NULL AND l.mail_tries < ? ORDER BY l.id LIMIT ?`, [MAX_TRIES, room]);
  let sent = 0;
  for (const r of rows) {
    const email = phpStr(r.email ?? '');
    // Ohne Empfänger (Konto gelöscht) wird nichts mehr versucht
    if (email === '') {
      await db.exec('UPDATE custom_domain_log SET mail = 0 WHERE id = ?', [intval(r.id)]);
      continue;
    }
    const event = phpStr(r.event);
    const admin = event === 'alert';
    const title = (NOTICE_TITLES as Record<string, string>)[event] ?? NOTICE_TITLES.alert;
    const targetId = r.target_id === null || r.target_id === undefined ? 0 : intval(r.target_id);
    const mail: DomainMail = {
      to: email, title, text: phpStr(r.detail),
      button: admin ? 'Open Admin → Custom domains' : 'Open the editor',
      url: admin ? mainUrl('/admin#domains') : mainUrl(targetId > 0 ? '/dashboard?page=' + targetId + '#settings/domain' : '/dashboard#settings'),
      footer: admin ? `You’re getting this email because you’re an admin of ${baseHost()}.` : `You’re getting this email about your custom domain on ${baseHost()}.`,
    };
    let ok = false;
    try {
      ok = await send(mail);
    } catch {
      ok = false;
    }
    if (ok) {
      await db.exec('UPDATE custom_domain_log SET mailed_at = ? WHERE id = ? AND mailed_at IS NULL', [o.at(o.now), intval(r.id)]);
      sent++;
    } else {
      await db.exec('UPDATE custom_domain_log SET mail_tries = mail_tries + 1 WHERE id = ?', [intval(r.id)]);
    }
  }
  return sent;
}
