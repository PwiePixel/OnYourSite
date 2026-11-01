// Kontaktformular: Prüfung und Schutzfilter gegen Spam (ohne Captcha, ohne IP-Adressen), Nachrichten speichern und
// Benachrichtigungen (lib/spam.php). oys_looks_like_spam() steht als looksLikeSpam() in helpers.ts.
import type { Ctx } from '../web/ctx.js';
import { exec, one, type Param, type Row } from '../db.js';
import { encryptData, hmac, safeEqual } from '../crypto.js';
import { e } from '../html.js';
import { cleanText, looksLikeSpam, mainUrl, pageDisplayUrl, validateEmail, type PageLike } from '../helpers.js';
import { date, intval, mbStrlen, mbSubstr, phpStr, phpTrim, phpTruthy, time, type PhpArray } from '../php.js';
import { clientKey, rateLimit } from '../web/security.js';
import { pageSettings } from './pages.js';
import { own } from './util.js';

// [ok, Fehlermeldung oder null, ist Spam]
export type ContactResult = [ok: boolean, error: string | null, spam: boolean];

const EXPIRED = 'This form has expired. Please reload the page.';

// oys_contact_check()
export async function contactCheck(ctx: Ctx, page: Row, blockId: string, post: PhpArray): Promise<ContactResult> {
  // 1. Honigtopf-Feld: Menschen sehen es nicht, Bots füllen es aus
  if (phpTrim(phpStr(own(post, 'website') ?? '')) !== '') return [true, null, true];

  // 2. Zeit-Token: signiert, mind. 3 Sekunden alt, höchstens 1 Tag
  const token = phpStr(own(post, 't') ?? '');
  const m = /^(\d{9,11})\.([a-f0-9]{32})(?=\n?$)/.exec(token);
  if (!m) return [false, EXPIRED, false];
  const expected = hmac(phpStr(page.id) + '|' + blockId + '|' + m[1]).slice(0, 32);
  if (!safeEqual(expected, m[2])) return [false, EXPIRED, false];
  const age = time() - intval(m[1]);
  if (age < 3) return [true, null, true];
  if (age > 86400) return [false, EXPIRED, false];

  const name = cleanText(own(post, 'name') ?? '', 80);
  const email = phpTrim(phpStr(own(post, 'email') ?? ''));
  const message = cleanText(own(post, 'message') ?? '', 2000, true);

  if (name === '' || message === '') return [false, 'Please fill in your name and message.', false];
  if (!validateEmail(email) || mbStrlen(email) > 190) return [false, 'Please enter a valid email address.', false];
  if (mbStrlen(message) < 5) return [false, 'Your message is a bit short.', false];

  // 3. Inhaltsfilter
  if (looksLikeSpam(name + ' ' + message)) return [true, null, true];

  // 4. Begrenzung: je Absender 5, je Seite 30 Nachrichten pro Stunde
  //    (ein Störer allein kann das Formular so nicht für alle sperren)
  if (!(await rateLimit('contact:' + phpStr(page.id) + ':' + clientKey(ctx), 5, 3600))
    || !(await rateLimit('contact:' + phpStr(page.id), 30, 3600))) {
    return [false, 'A lot of messages are coming in right now. Please try again later.', false];
  }
  return [true, null, false];
}

// sendCustomEmail() aus mail.ts (Paket Mail). Fehlt das Modul, wird – wie ohne mail.php (function_exists) – nichts gesendet.
export type SendMail = (to: unknown, template: string, vars: Record<string, unknown>, subject?: unknown, replyTo?: unknown) => Promise<boolean>;
let mailer: SendMail | null | undefined;

// Für Tests: eigene Versandfunktion (null = nichts senden, undefined = wieder mail.ts verwenden)
export function setMailerForTests(fn: SendMail | null | undefined): void {
  mailer = fn;
}

async function getMailer(): Promise<SendMail | null> {
  if (mailer !== undefined) return mailer;
  // Über eine Variable, damit die Typprüfung nicht schon jetzt nach mail.ts sucht
  const spec = '../mail.js';
  try {
    const mod = (await import(spec)) as { sendCustomEmail?: SendMail };
    mailer = typeof mod.sendCustomEmail === 'function' ? mod.sendCustomEmail : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw err;
    mailer = null;
  }
  return mailer;
}

// oys_store_message(): Nachricht verschlüsselt speichern, Glocke im Dashboard, auf Wunsch eine E-Mail an den Besitzer
export async function storeMessage(page: Row, post: PhpArray): Promise<number> {
  const now = date('Y-m-d H:i:s');
  const name = cleanText(own(post, 'name') ?? '', 80);
  const email = phpTrim(phpStr(own(post, 'email')));
  const message = cleanText(own(post, 'message') ?? '', 2000, true);

  const { insertId } = await exec('INSERT INTO messages (page_id, user_id, name, email, message, is_read, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
    [page.id as Param, page.user_id as Param, encryptData(name) ?? null, encryptData(email) ?? null, encryptData(message) ?? null, now]);
  const id = intval(insertId);

  await notify(intval(page.user_id), 'message', 'New message from ' + name, mbSubstr(message, 0, 120), '/dashboard#messages');

  const settings = pageSettings(page);
  if (phpTruthy(settings.notify_email)) {
    const user = await one('SELECT email, full_name FROM users WHERE id = ?', [page.user_id as Param]);
    const send = user ? await getMailer() : null;
    if (user && send) {
      // Reihenfolge zählt: sendCustomEmail ersetzt die Platzhalter nacheinander
      await send(user.email, 'new_message', {
        full_name: e(phpTruthy(user.full_name) ? user.full_name : page.title),
        guest_name: e(name),
        guest_email: e(email),
        message: e(message),
        page_url: e(pageDisplayUrl(page as unknown as PageLike)),
        dashboard_url: e(mainUrl('/dashboard')),
      }, 'New message from ' + name, email);
    }
  }
  return id;
}

// oys_notify(): Eintrag für die Glocke im Dashboard
export async function notify(userId: number, type: string, title: string, body = '', link = ''): Promise<void> {
  await exec('INSERT INTO notifications (user_id, type, title, body, link, is_read, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
    [userId, type, mbSubstr(title, 0, 190), mbSubstr(body, 0, 255), link, date('Y-m-d H:i:s')]);
}
