// Termin-Anfrage (eingebauter Kalender) im Design der Profilseite (views/kalender.php).
// Ohne Session/Cookies: Erfolg wird per ?ok=1 angezeigt. Eine Anfrage wird verschlüsselt gespeichert, der Besitzer
// bekommt einen Eintrag in der Glocke und eine E-Mail.
import type { Ctx } from '../../web/ctx.js';
import { exec, one, type Param, type Row } from '../../db.js';
import { encryptData, hmac, safeEqual } from '../../crypto.js';
import { e } from '../../html.js';
import { cleanText, initials, mainUrl, pageUrl, uploadUrl, validateEmail, type PageLike } from '../../helpers.js';
import { date, intval, phpEmpty, phpStr, phpTrim, phpTruthy, rawurlencode, strtotime, time, type PhpArray } from '../../php.js';
import { sendCustomEmail } from '../../mail.js';
import { clientKey, rateLimit } from '../../web/security.js';
import { notify } from '../../content/messages.js';
import { renderSimple } from '../../content/render.js';
import { uiIcon } from '../../content/social.js';
import { own } from '../../content/util.js';

const SLOTS: readonly string[] = ['09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00'];

// sendCustomEmail() – Tests können den Versand ersetzen (null = wieder mail.ts)
type SendMail = (to: unknown, template: string, vars: Record<string, unknown>, subject?: unknown, replyTo?: unknown) => Promise<boolean>;
let mailer: SendMail | null = null;
export function setBookingMailerForTests(fn: SendMail | null): void {
  mailer = fn;
}

// checkdate(): gibt es diesen Tag im gregorianischen Kalender? (Jahr 1 bis 32767)
export function checkdate(month: number, day: number, year: number): boolean {
  if (month < 1 || month > 12 || day < 1 || year < 1 || year > 32767) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= days;
}

// Daten der Vorlage
export interface KalenderData {
  pageUrl: string;
  avatar: string;
  name: string;
  ok: boolean;
  error: string | null;
  selfUrl: string;
  token: string;
  // $_POST (nur bei POST gefüllt): die Eingaben stehen nach einem Fehler wieder im Formular
  post: PhpArray;
  today: string;
  maxDate: string;
}

// views/kalender.php: calendarKey = '' oder der Schlüssel eines geschützten Termin-Blocks
export async function kalender(ctx: Ctx, page: Row, calendarKey: string): Promise<void> {
  const pageLike = page as unknown as PageLike;
  const selfUrl = pageUrl(pageLike, 'kalender') + (calendarKey !== '' ? '?k=' + rawurlencode(calendarKey) : '');
  const okUrl = selfUrl + (calendarKey !== '' ? '&' : '?') + 'ok=1';
  let error: string | null = null;

  if (ctx.method === 'POST') {
    const name = cleanText(own(ctx.post, 'guest_name') ?? '', 80);
    const email = phpTrim(ctx.p('guest_email'));
    const bookingDate = ctx.p('booking_date');
    const bookingTime = ctx.p('booking_time');
    const token = ctx.p('t');
    // $ von PCRE passt auch vor einem letzten \n
    const tm = /^(\d{9,11})\.([a-f0-9]{32})(?=\n?$)/.exec(token);
    const validToken = tm !== null
      && safeEqual(hmac('booking|' + phpStr(page.id) + '|' + tm[1]).slice(0, 32), tm[2])
      && time() - intval(tm[1]) < 86400;

    if (phpTrim(ctx.p('website')) !== '' || !validToken) ctx.redirect(okUrl, 303);
    const dm = /^(\d{4})-(\d{2})-(\d{2})(?=\n?$)/.exec(bookingDate);
    if (name === '' || !validateEmail(email)) {
      error = 'Please enter your name and a valid email address.';
    } else if (!dm || !checkdate(intval(dm[2]), intval(dm[3]), intval(dm[1]))
      || bookingDate < date('Y-m-d') || bookingDate > date('Y-m-d', strtotime('+1 year') as number)) {
      // Vergleich als Text wie in PHP (beide Seiten sind keine Zahlen-Strings)
      error = 'Please choose a date between today and one year from now.';
    } else if (!SLOTS.includes(bookingTime)) {
      error = 'Please choose a time.';
    } else if (!(await rateLimit('booking:' + phpStr(page.id) + ':' + clientKey(ctx), 5, 3600))
      || !(await rateLimit('booking:' + phpStr(page.id), 30, 3600))) {
      error = 'There are a lot of requests right now. Please try again later.';
    } else {
      await exec('INSERT INTO user_bookings (user_id, guest_name, guest_email, booking_date, booking_time) VALUES (?, ?, ?, ?, ?)',
        [page.user_id as Param, encryptData(name) ?? null, encryptData(email) ?? null, bookingDate, bookingTime]);
      const dateDe = date('M j, Y', strtotime(bookingDate) as number);
      await notify(intval(page.user_id), 'booking', 'New booking request from ' + name, dateDe + ' at ' + bookingTime, '/dashboard#messages');
      const user = await one('SELECT email, full_name FROM users WHERE id = ?', [page.user_id as Param]);
      if (user) {
        // Reihenfolge zählt: sendCustomEmail ersetzt die Platzhalter nacheinander
        await (mailer ?? sendCustomEmail)(user.email, 'new_booking', {
          full_name: e(phpTruthy(user.full_name) ? user.full_name : page.title),
          guest_name: e(name),
          guest_email: e(email),
          booking_date: e(dateDe),
          booking_time: e(bookingTime),
          dashboard_url: e(mainUrl('/dashboard')),
        }, 'New booking: ' + name + ' on ' + dateDe, email);
      }
      ctx.redirect(okUrl, 303);
    }
  }

  const ts = time();
  const token = ts + '.' + hmac('booking|' + phpStr(page.id) + '|' + ts).slice(0, 32);
  const avatar = phpTruthy(page.avatar) ? uploadUrl(page.avatar) : '';
  const name = phpStr(phpTruthy(page.title) ? page.title : page.slug);
  const body = kalenderView({
    pageUrl: pageUrl(pageLike),
    avatar,
    name,
    ok: own(ctx.get, 'ok') !== undefined,
    error,
    selfUrl,
    token,
    post: ctx.method === 'POST' ? ctx.post : {},
    today: date('Y-m-d'),
    maxDate: date('Y-m-d', strtotime('+1 year') as number),
  });
  ctx.send(renderSimple(page, 'Request a meeting | ' + name, body));
}

// Inhalt der Seite (ob_start() … ob_get_clean()) – der feste Text ist Byte für Byte übernommen (view2ts)
export function kalenderView(d: KalenderData): string {
  let o = '';
  o += "<div class=\"oys-card\">\n  <a class=\"oys-back\" href=\"";
  o += e(d.pageUrl);
  o += "\">";
  o += uiIcon('left');
  o += " Back to profile</a>\n  <div style=\"display:flex;align-items:center;gap:14px;margin-bottom:18px\">\n    <div class=\"oys-avatar\" style=\"--avatar-size:56px;margin:0\"><div class=\"oys-avatar-inner\">\n      ";
  if (d.avatar !== '') {
    o += "<img src=\"";
    o += e(d.avatar);
    o += "\" alt=\"\">";
  } else {
    o += "<span class=\"oys-initials\" style=\"font-size:1.1em\">";
    o += e(initials(d.name));
    o += "</span>";
  }
  o += "    </div></div>\n    <div><h1 style=\"margin:0\">Request a meeting</h1><p style=\"margin:0\">with ";
  o += e(d.name);
  o += "</p></div>\n  </div>\n\n  ";
  if (d.ok) {
    o += "    <div class=\"oys-alert ok\">";
    o += uiIcon('check');
    o += " Your request has been sent! You’ll get a reply by email.</div>\n  ";
  } else {
    o += "    ";
    if (phpTruthy(d.error)) {
      o += "<div class=\"oys-alert err\">";
      o += e(d.error);
      o += "</div>";
    }
    o += "    <form class=\"oys-contact\" method=\"post\" action=\"";
    o += e(d.selfUrl);
    o += "\">\n      <input type=\"hidden\" name=\"t\" value=\"";
    o += e(d.token);
    o += "\">\n      <div class=\"oys-hp\" aria-hidden=\"true\"><label>Website <input type=\"text\" name=\"website\" tabindex=\"-1\" autocomplete=\"off\"></label></div>\n      <label class=\"oys-field\"><span>Your name</span><input type=\"text\" name=\"guest_name\" required maxlength=\"80\" autocomplete=\"name\" value=\"";
    o += e(own(d.post, 'guest_name') ?? '');
    o += "\"></label>\n      <label class=\"oys-field\"><span>Your email</span><input type=\"email\" name=\"guest_email\" required autocomplete=\"email\" value=\"";
    o += e(own(d.post, 'guest_email') ?? '');
    o += "\"></label>\n      <div class=\"oys-grid2\">\n        <label class=\"oys-field\"><span>Preferred date</span><input type=\"date\" name=\"booking_date\" required min=\"";
    o += d.today;
    o += "\" max=\"";
    o += d.maxDate;
    o += "\" value=\"";
    o += e(own(d.post, 'booking_date') ?? '');
    o += "\"></label>\n        <label class=\"oys-field\"><span>Time</span>\n          <select name=\"booking_time\" required>\n            <option value=\"\" disabled";
    o += (phpEmpty(own(d.post, 'booking_time')) ? ' selected' : '');
    o += ">Please choose…</option>\n            ";
    for (const slot of SLOTS) {
      o += "<option value=\"";
      o += slot;
      o += "\"";
      o += ((own(d.post, 'booking_time') ?? '') === slot ? ' selected' : '');
      o += ">";
      o += slot;
      o += "</option>";
    }
    o += "          </select>\n        </label>\n      </div>\n      <button class=\"oys-contact-send\" type=\"submit\">";
    o += uiIcon('calendar');
    o += "<span>Request a meeting</span></button>\n      <p class=\"oys-contact-note\">Your details are stored encrypted and only used to arrange the meeting.</p>\n    </form>\n  ";
  }
  o += "</div>\n";
  return o;
}
