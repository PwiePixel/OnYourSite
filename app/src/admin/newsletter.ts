// Admin: Mail-Server (email/smtp.json), Vorlagen und Newsletter/Test-Mails (views/admin.php)
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { ROOT_DIR } from '../config.js';
import { q, type Row } from '../db.js';
import { phpJson } from '../html.js';
import { phpTrim, phpTruthy, type PhpArray } from '../php.js';
import { PhpArr, phpJsonDecode, type PhpJson } from '../community/json.js';
import { sendCustomEmail } from '../mail.js';

// email/ im Code-Ordner (__DIR__ . '/../email/' in views/admin.php) – Tests können einen anderen Ordner setzen
let dirForTests: string | null = null;
export function setEmailDirForTests(dir: string | null): void {
  dirForTests = dir;
}
export const emailDir = (): string => (dirForTests ?? ROOT_DIR + '/email') + '/';

// Ordner für E-Mails und Einstellungen sicherstellen (mkdir mit 0755; ein Fehler ist in PHP nur eine Warnung)
export function ensureEmailDir(): void {
  const dir = emailDir();
  try {
    if (statSync(dir).isDirectory()) return;
  } catch {
    // fehlt
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
  } catch {
    // wie mkdir() mit Warnung: weiter ohne Ordner
  }
}

// trim($_POST['key'] ?? ''): ein Array ist in PHP ein TypeError (die Anfrage endet mit 500)
function trimField(post: PhpArray, key: string): string {
  const v = post[key] ?? '';
  if (typeof v !== 'string') throw new TypeError('trim(): Argument #1 ($string) must be of type string, array given');
  return phpTrim(v);
}

// Mail-Server speichern: nur getrimmt, nichts geprüft. json_encode(…, JSON_PRETTY_PRINT) – vier Leerzeichen, \/ und
// \uXXXX, kein Zeilenende am Schluss. Ein Schreibfehler bleibt wie bei file_put_contents() unbemerkt.
export function saveSmtp(post: PhpArray): void {
  const data = {
    host: trimField(post, 'smtp_host'),
    port: trimField(post, 'smtp_port'),
    username: trimField(post, 'smtp_username'),
    password: trimField(post, 'smtp_password'),
    from_email: trimField(post, 'from_email'),
    from_name: trimField(post, 'from_name'),
  };
  try {
    writeFileSync(emailDir() + 'smtp.json', phpJson(data, { prettyPrint: true }));
  } catch {
    // wie file_put_contents() mit Warnung
  }
}

// $smtp_config für das Formular: json_decode(smtp.json, true), ohne Datei ein leeres Array
export function smtpConfig(): PhpJson {
  const file = emailDir() + 'smtp.json';
  let raw: Buffer;
  try {
    statSync(file);
  } catch {
    return new PhpArr();
  }
  try {
    raw = readFileSync(file);
  } catch {
    // Ordner oder keine Rechte: file_get_contents() liefert nichts Lesbares
    raw = Buffer.alloc(0);
  }
  return phpJsonDecode(raw);
}

// Vorlagen: glob(email/*.json) ohne smtp.json – nach Bytes sortiert, ohne Namen mit Punkt am Anfang. Die Namen kommen
// als Bytes; ungültiges UTF-8 ersetzt htmlspecialchars() (ENT_SUBSTITUTE) beim Ausgeben – hier schon beim Lesen.
export function emailTemplates(): string[] {
  let names: Buffer[];
  try {
    names = readdirSync(emailDir(), { encoding: 'buffer' });
  } catch {
    return [];
  }
  const suffix = Buffer.from('.json');
  const smtp = Buffer.from('smtp.json');
  return names
    .filter((n) => n[0] !== 0x2e && n.length >= suffix.length && n.subarray(n.length - suffix.length).equals(suffix))
    .filter((n) => !n.equals(smtp))
    .sort(Buffer.compare)
    .map(utf8Substitute);
}

// UTF-8 lesen wie htmlspecialchars() mit ENT_SUBSTITUTE (get_next_char() in ext/standard/html.c): jede ungültige Folge
// wird ein U+FFFD, aber mit den Regeln von PHP – z. B. ein kodiertes Ersatzzeichen (ED A0 80) ist ein Fehler für drei
// Bytes, während TextDecoder für jedes Byte einen meldet.
export function utf8Substitute(b: Buffer): string {
  const lead = (c: number | undefined) => c !== undefined && (c < 0x80 || (c >= 0xc2 && c <= 0xf4));
  const trail = (c: number | undefined) => c !== undefined && c >= 0x80 && c <= 0xbf;
  let out = '';
  let i = 0;
  const fail = (n: number) => {
    out += '�';
    i += n;
  };
  while (i < b.length) {
    const c = b[i];
    const left = b.length - i;
    if (c < 0x80) {
      out += String.fromCharCode(c);
      i++;
    } else if (c < 0xc2) {
      fail(1);
    } else if (c < 0xe0) {
      if (left < 2) fail(1);
      else if (!trail(b[i + 1])) fail(lead(b[i + 1]) ? 1 : 2);
      else {
        out += String.fromCodePoint(((c & 0x1f) << 6) | (b[i + 1] & 0x3f));
        i += 2;
      }
    } else if (c < 0xf0) {
      if (left < 3 || !trail(b[i + 1]) || !trail(b[i + 2])) {
        if (left < 2 || lead(b[i + 1])) fail(1);
        else if (left < 3 || lead(b[i + 2])) fail(2);
        else fail(3);
        continue;
      }
      const cp = ((c & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f);
      if (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff)) fail(3);
      else {
        out += String.fromCodePoint(cp);
        i += 3;
      }
    } else if (c < 0xf5) {
      if (left < 4 || !trail(b[i + 1]) || !trail(b[i + 2]) || !trail(b[i + 3])) {
        if (left < 2 || lead(b[i + 1])) fail(1);
        else if (left < 3 || lead(b[i + 2])) fail(2);
        else if (left < 4 || lead(b[i + 3])) fail(3);
        else fail(4);
        continue;
      }
      const cp = ((c & 0x07) << 18) | ((b[i + 1] & 0x3f) << 12) | ((b[i + 2] & 0x3f) << 6) | (b[i + 3] & 0x3f);
      if (cp < 0x10000 || cp > 0x10ffff) fail(4);
      else {
        out += String.fromCodePoint(cp);
        i += 4;
      }
    } else {
      fail(1);
    }
  }
  return out;
}

// Empfänger je Zielgruppe (ohne ORDER BY – Reihenfolge wie die Datenbank sie liefert)
export async function newsletterRecipients(audience: unknown, singleEmail: string): Promise<Row[]> {
  if (audience === 'all') {
    return q('SELECT email, full_name, username FROM users');
  }
  if (audience === 'with_domain') {
    return q("SELECT email, full_name, username FROM users WHERE username IS NOT NULL AND username != ''");
  }
  if (audience === 'no_domain') {
    return q("SELECT email, full_name, username FROM users WHERE username IS NULL OR username = ''");
  }
  if (audience === 'single' && phpTruthy(singleEmail)) {
    return q('SELECT email, full_name, username FROM users WHERE email = ?', [singleEmail]);
  }
  return [];
}

type SendMail = (to: unknown, template: string, vars: Record<string, unknown>, subject: unknown) => Promise<boolean>;
let mailer: SendMail | undefined;
// Für Tests: statt SMTP eine eigene Funktion
export function setNewsletterMailerForTests(fn: SendMail | undefined): void {
  mailer = fn;
}

// Newsletter oder Test-Mail an eine Adresse: nacheinander, je Empfänger eine eigene Verbindung (sendCustomEmail).
// Die Werte gehen unverändert (nicht HTML-maskiert) in die Vorlage.
export async function sendNewsletter(post: PhpArray): Promise<{ ok: string } | { error: string }> {
  // str_replace('.json', '', …) entfernt jedes ".json"; ein Array wird später zu "Array"
  const templateFile = post.template_file ?? '';
  const templateName = typeof templateFile === 'string' ? templateFile.split('.json').join('') : 'Array';
  const subject = trimField(post, 'email_subject');
  const audience = post.audience ?? 'all';
  const singleEmail = trimField(post, 'single_email');

  const recipients = await newsletterRecipients(audience, singleEmail);
  if (recipients.length === 0) {
    return { error: 'No users found for this audience. Mail aborted.' };
  }
  let sent = 0;
  for (const r of recipients) {
    const vars = {
      full_name: r.full_name,
      subdomain: phpTruthy(r.username) ? r.username : 'yourname',
    };
    const send = mailer ?? sendCustomEmail;
    if (await send(r.email, templateName, vars, phpTruthy(subject) ? subject : null)) {
      sent++;
    }
  }
  if (sent > 0) {
    return { ok: 'Successfully sent ' + sent + ' email(s)!' };
  }
  return { error: 'Failed to send emails. Check your SMTP settings and PHPMailer installation.' };
}
