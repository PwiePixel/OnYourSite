// E-Mails mit den Vorlagen aus email/*.json über den SMTP-Server aus email/smtp.json (mail.php mit PHPMailer).
// Gleiches Verhalten wie PHPMailer 7: Port 465 = TLS ab der ersten Zeile, jeder andere Port = STARTTLS (Pflicht),
// Anmeldung immer, zehn Sekunden Zeit, Absender aus smtp.json. Fehler: false und eine Zeile im Fehlerprotokoll.
import { existsSync, readFileSync } from 'node:fs';
import { domainToASCII } from 'node:url';
import SMTPConnection from 'nodemailer/lib/smtp-connection';
import MailComposer from 'nodemailer/lib/mail-composer';
import { ROOT_DIR } from './config.js';
import { baseHost, validateEmail, validateUrl } from './helpers.js';
import { intval, isNumeric, nl2br, phpTruthy, phpTrim } from './php.js';
import { PhpArr, PhpFloat, PhpInt, jsonField, phpCastString, phpJsonDecode, phpJsonTruthy, type PhpJson } from './community/json.js';

const TIMEOUT_MS = 10_000;

// Ordner mit smtp.json und den Vorlagen (Tests können einen anderen setzen)
let mailDir: string | null = null;
export function setMailDirForTests(dir: string | null): void {
  mailDir = dir;
}
const emailDir = (): string => (mailDir ?? ROOT_DIR + '/email') + '/';
// Pfad der Mail-Einstellungen (email/smtp.json)
export const smtpConfigPath = (): string => emailDir() + 'smtp.json';

// error_log(): eine Zeile ins Fehlerprotokoll
function errorLog(message: string): void {
  console.error(message);
}

// Ein PHPMailer-Fehler (PHPMailer\PHPMailer\Exception) – führt zu false
class MailerError extends Error {}
// Ein TypeError in PHP (z. B. kaputte smtp.json) – fängt sendCustomEmail() nicht ab, die Anfrage endet mit 500
export class PhpTypeError extends Error {}

// file_get_contents(): die Bytes der Datei, bei einem Fehler (Ordner, keine Rechte) wie PHP ein leerer Text.
// Bytes statt Text: json_decode() lehnt ungültiges UTF-8 ab (z. B. eine Vorlage in Windows-1252), statt es zu ersetzen.
function readBytes(file: string): Buffer {
  try {
    return readFileSync(file);
  } catch {
    return Buffer.alloc(0);
  }
}

// Wert aus einem dekodierten JSON-Array; Nicht-Arrays haben (wie Strings in PHP mit ??) keine Schlüssel
const get = (arr: PhpJson, key: string): PhpJson | undefined => jsonField(arr, key);

// $smtp_config['key'] ohne ??: bei einem Text wirft PHP einen TypeError, bei Zahlen/true gibt es null
function configValue(config: PhpJson, key: string): PhpJson {
  if (typeof config === 'string') throw new PhpTypeError('Cannot access offset of type string on string');
  return config instanceof PhpArr ? (config.get(key) ?? null) : null;
}

// Text wie PHP ihn aus Vorlage und Variablen macht (str_replace/nl2br wandeln Zahlen um; Arrays → TypeError)
function scalarText(v: PhpJson | string): string {
  if (v instanceof PhpArr) throw new PhpTypeError('Array given where a string was expected');
  return phpCastString(v);
}

// str_replace() für einen Suchtext; ein Array bleibt ein Array (der Fehler kommt in PHP erst später)
const replaceAll = (subject: PhpJson | string, search: string, replace: string): PhpJson | string =>
  subject instanceof PhpArr ? subject : scalarText(subject).split(search).join(replace);

// strip_tags() – der Zustandsautomat von PHP (php_strip_tags_ex ohne erlaubte Tags)
export function stripTags(input: string): string {
  const s = input;
  const n = s.length;
  const at = (i: number): string => (i >= 0 && i < n ? s[i] : '\0');
  const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\v' || c === '\f' || c === '\r';
  let out = '';
  let state = 0;
  let depth = 0;
  let inQ = '';
  let lc = '';
  let br = 0;
  let isXml = false;
  for (let p = 0; p < n; p++) {
    const c = s[p];
    if (state === 0) {
      if (c === '\0') continue;
      if (c === '<') {
        if (inQ) continue;
        if (isSpace(at(p + 1))) {
          out += c;
          continue;
        }
        lc = '<';
        state = 1;
        continue;
      }
      if (c === '>') {
        if (depth) {
          depth--;
          continue;
        }
        if (inQ) continue;
        out += c;
        continue;
      }
      out += c;
    } else if (state === 1) {
      if (c === '\0') continue;
      if (c === '<') {
        if (inQ) continue;
        if (isSpace(at(p + 1))) continue;
        depth++;
        continue;
      }
      if (c === '>') {
        if (depth) {
          depth--;
          continue;
        }
        if (inQ) continue;
        lc = '>';
        if (isXml && at(p - 1) === '-') continue;
        inQ = '';
        state = 0;
        isXml = false;
        continue;
      }
      if (c === '"' || c === "'") {
        if (p !== 0 && (!inQ || c === inQ)) inQ = inQ ? '' : c;
        continue;
      }
      if (c === '!' && at(p - 1) === '<') {
        state = 3;
        lc = c;
        continue;
      }
      if (c === '?' && at(p - 1) === '<') {
        br = 0;
        state = 2;
        continue;
      }
    } else if (state === 2) {
      if (c === '(') {
        if (lc !== '"' && lc !== "'") {
          lc = '(';
          br++;
        }
      } else if (c === ')') {
        if (lc !== '"' && lc !== "'") {
          lc = ')';
          br--;
        }
      } else if (c === '>') {
        if (depth) {
          depth--;
          continue;
        }
        if (inQ) continue;
        if (!br && p >= 1 && lc !== '"' && at(p - 1) === '?') {
          inQ = '';
          state = 0;
        }
      } else if (c === '"' || c === "'") {
        if (p >= 1 && at(p - 1) !== '\\') {
          if (lc === c) lc = '';
          else if (lc !== '\\') lc = c;
          if (p !== 0 && (!inQ || c === inQ)) inQ = inQ ? '' : c;
        }
      } else if (c === 'l' || c === 'L') {
        // <?xml: zurück in den HTML-Zustand
        if (p > 4 && (at(p - 1) === 'm' || at(p - 1) === 'M') && (at(p - 2) === 'x' || at(p - 2) === 'X') && at(p - 3) === '?' && at(p - 4) === '<') {
          state = 1;
          isXml = true;
        }
      }
    } else if (state === 3) {
      if (c === '>') {
        if (depth) {
          depth--;
          continue;
        }
        if (inQ) continue;
        inQ = '';
        state = 0;
      } else if (c === '"' || c === "'") {
        if (p !== 0 && at(p - 1) !== '\\' && (!inQ || c === inQ)) inQ = inQ ? '' : c;
      } else if (c === '-') {
        if (p >= 2 && at(p - 1) === '-' && at(p - 2) === '!') state = 4;
      } else if (c === 'E' || c === 'e') {
        // <!DOCTYPE wie ein normaler Tag
        if (p > 6 && /^doctyp$/i.test(s.slice(p - 6, p))) state = 1;
      }
    } else if (c === '>' && !inQ && p >= 2 && at(p - 1) === '-' && at(p - 2) === '-') {
      // Kommentar zu Ende
      inQ = '';
      state = 0;
    }
  }
  return out;
}

// PHPMailer::normalizeBreaks(): jede Zeilenart → CRLF (SMTP verträgt keine einzelnen CR oder LF)
const normalizeBreaks = (s: string): string => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');

// PHPMailer::validateAddress(): keine Zeilenumbrüche, dann FILTER_VALIDATE_EMAIL
const validAddress = (a: string): boolean => !/[\r\n]/.test(a) && validateEmail(a);

// PHPMailer::punyencodeAddress(): Domain mit Umlauten → Punycode (wie idn_to_ascii mit UTS #46)
function punyencode(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 0) return address;
  const domain = address.slice(at + 1);
  if (!/[^\x00-\x7f]/.test(domain)) return address;
  const ascii = domainToASCII(domain);
  return ascii === '' ? address : address.slice(0, at + 1) + ascii;
}

// PHPMailer::addAddress()/addReplyTo(): trim, @ nötig, dann prüfen (Domains mit Umlauten nach der Umwandlung)
function checkAddress(kind: string, raw: unknown): string {
  const address = phpTrim(phpCastString(raw));
  if (!address.includes('@')) throw new MailerError(`Invalid address:  (${kind}): ${address}`);
  if (!validAddress(punyencode(address))) throw new MailerError(`Invalid address:  (${kind}): ${address}`);
  return punyencode(address);
}

// PHPMailer::isValidHost()
function isValidHost(host: string): boolean {
  if (host === '' || host === '0' || Buffer.byteLength(host, 'utf8') > 256 || !/^([a-z\d.-]*|\[[a-f\d:]+\])\n?$/i.test(host)) return false;
  if (host.length > 2 && host.startsWith('[') && host.endsWith(']')) return isIPv6(host.slice(1, -1));
  if (isNumeric(host.replace(/\./g, ''))) return isIPv4(host);
  return validateUrl('https://' + host);
}
const isIPv4 = (s: string): boolean => /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(s);
function isIPv6(s: string): boolean {
  try {
    return new URL('http://[' + s + ']/').hostname !== '';
  } catch {
    return false;
  }
}

// Port als Text, wie PHPMailer ihn an stream_socket_client("host:port") weitergibt: leer (empty()) → 25,
// sonst (string) $port (ein Array wird zu "Array")
function portText(port: PhpJson): string {
  if (!phpJsonTruthy(port)) return '25';
  return port instanceof PhpArr ? 'Array' : phpCastString(port);
}

// Port der Verbindung: PHP liest ihn mit atoi() (Leerraum, Vorzeichen, Ziffern – der Rest zählt nicht, zu große Zahlen
// bleiben am Rand stehen) und nimmt davon 16 Bit; 0 heißt: keine Verbindung
function tcpPort(text: string): number {
  const m = /^[ \t\n\v\f\r]*([+-]?\d+)/.exec(text);
  if (!m) return 0;
  const max = 2n ** 63n - 1n;
  let n = BigInt(m[1]);
  if (n > max) n = max;
  else if (n < -max - 1n) n = -max - 1n;
  return Number(BigInt.asUintN(16, n));
}

// Findet PHP für die Prüfung des Zertifikats den Namen des Servers? Es liest ihn mit parse_url("host:port") (auch bei
// ssl://) – das klappt nur, wenn der Port aus 1 bis 5 Ziffern besteht (höchstens 65535, danach höchstens ein "/…").
// Sonst scheitert TLS, nachdem die Verbindung steht: bei STARTTLS nach EHLO, bei Port 465 gleich beim Verbinden.
function peerNameFound(text: string): boolean {
  const m = /^(\d{1,5})(?:\/|$)/.exec(text);
  return m !== null && Number(m[1]) <= 65535;
}

// PHPMailer::serverHostname(): der Name, mit dem sich die Seite beim Server meldet (EHLO)
function helloName(): string {
  const host = baseHost();
  return isValidHost(host) ? host : 'localhost.localdomain';
}

// Ein Schritt mit dem SMTP-Server als Promise (Fehler kommen per Rückruf oder als Ereignis)
function step<T>(conn: SMTPConnection, start: (done: (err?: Error | null, value?: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error | null, value?: T): void => {
      if (settled) return;
      settled = true;
      conn.removeListener('error', onError);
      conn.removeListener('end', onEnd);
      if (err) reject(err);
      else resolve(value as T);
    };
    const onError = (err: Error): void => finish(err);
    const onEnd = (): void => finish(new Error('Connection closed'));
    conn.on('error', onError);
    conn.on('end', onEnd);
    start(finish);
  });
}

interface SmtpTarget {
  host: string;
  // Port als Text (siehe portText)
  port: string;
  secure: boolean;
}

// PHPMailer::smtpConnect(): mehrere Server mit ";" getrennt, je Eintrag "ssl://" oder "tls://" und ":port" möglich
function smtpTargets(hostSetting: string, port: PhpJson, smtps: boolean): SmtpTarget[] {
  const out: SmtpTarget[] = [];
  for (const entry of hostSetting.split(';')) {
    const m = /^(?:(ssl|tls):\/\/)?(.+?)(?::(\d+))?\n?$/.exec(phpTrim(entry));
    if (!m || !isValidHost(m[2])) continue;
    const secure = m[1] === 'ssl' || (m[1] === undefined && smtps);
    let text = portText(port);
    // Ein Port am Servernamen gilt als (int)
    if (m[3] !== undefined && intval(m[3]) > 0 && intval(m[3]) < 65536) text = String(intval(m[3]));
    out.push({ host: m[2], port: text, secure });
  }
  return out;
}

// Verbinden, (STARTTLS,) anmelden – wie PHPMailer mit CRAM-MD5 vor LOGIN vor PLAIN, und nie ohne AUTH-Angebot
async function openConnection(target: SmtpTarget, user: string, pass: string, timeoutMs = TIMEOUT_MS): Promise<SMTPConnection> {
  const port = tcpPort(target.port);
  if (port === 0) throw new MailerError('SMTP Error: Could not connect to SMTP host. Failed to connect to server');
  const conn = new SMTPConnection({
    host: target.host,
    port,
    secure: target.secure,
    requireTLS: !target.secure,
    name: helloName(),
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
    // Ohne Namen des Servers scheitert die Prüfung des Zertifikats wie in PHP
    ...(peerNameFound(target.port) ? {} : { tls: { checkServerIdentity: () => new Error('SMTP Error: the peer certificate name could not be determined') } }),
  });
  // Spätere Fehler nach dem letzten Schritt nicht unbehandelt lassen
  conn.on('error', () => undefined);
  try {
    await step<void>(conn, (done) => conn.connect((err?: Error) => done(err ?? null)));
    // Ohne AUTH im EHLO meldet sich PHPMailer gar nicht erst an; nach HELO nimmt es LOGIN
    const inner = conn as unknown as { _supportedAuth?: string[]; _ehloLines?: string[] };
    if (!conn.allowsAuth) throw new MailerError('SMTP Error: Could not authenticate.');
    let method: string | undefined;
    if (Array.isArray(inner._supportedAuth)) {
      method = ['CRAM-MD5', 'LOGIN', 'PLAIN'].find((x) => inner._supportedAuth!.includes(x));
      if (!method && inner._ehloLines === undefined) method = 'LOGIN';
      if (!method) throw new MailerError('SMTP Error: Could not authenticate.');
    }
    await step<void>(conn, (done) => conn.login({ credentials: { user, pass }, method } as unknown as SMTPConnection.AuthenticationCredentials, (err?: Error | null) => done(err ?? null)));
    return conn;
  } catch (err) {
    conn.quit();
    throw err;
  }
}

// sendCustomEmail($to_email, $template_name, $variables = [], $subject_override = null, $reply_to = null)
// variables: Reihenfolge zählt (Werte, die {andere} enthalten, werden später mit ersetzt)
export async function sendCustomEmail(
  toEmail: unknown,
  templateName: string,
  variables: Record<string, unknown> = {},
  subjectOverride: unknown = null,
  replyTo: unknown = null,
): Promise<boolean> {
  const smtpFile = emailDir() + 'smtp.json';
  const templateFile = emailDir() + templateName + '.json';
  // existsSync ist bei Nullbytes false – wie file_exists()
  if (!existsSync(smtpFile) || !existsSync(templateFile)) {
    errorLog(`Mail Error: SMTP config or Template '${templateName}' missing.`);
    return false;
  }
  const smtpConfig = phpJsonDecode(readBytes(smtpFile));
  const template = phpJsonDecode(readBytes(templateFile));
  if (!jsonTruthy(smtpConfig) || !jsonTruthy(template)) {
    errorLog('Mail Error: JSON format invalid.');
    return false;
  }

  let subject: PhpJson | string = phpTruthy(subjectOverride) ? phpCastString(subjectOverride) : (get(template, 'subject') ?? 'Notification');
  let body: PhpJson | string = get(template, 'body') ?? '';
  for (const [key, value] of Object.entries(variables)) {
    const search = '{' + key + '}';
    const replace = phpCastString(value);
    subject = replaceAll(subject, search, replace);
    body = replaceAll(body, search, replace);
  }

  try {
    // Reihenfolge wie in mail.php: Einstellungen, Absender, Empfänger, Antwortadresse, Inhalt, dann senden
    const host = configValue(smtpConfig, 'host');
    const user = phpCastString(configValue(smtpConfig, 'username'));
    const pass = phpCastString(configValue(smtpConfig, 'password'));
    const port = configValue(smtpConfig, 'port');
    const smtps = intval(port instanceof PhpInt ? Number(port.value) : port instanceof PhpFloat ? port.value : port) === 465;

    // setFrom(): trim, Zeilenumbrüche aus dem Namen
    const fromEmail = phpTrim(phpCastString(configValue(smtpConfig, 'from_email')));
    const fromNameValue = configValue(smtpConfig, 'from_name');
    if (fromNameValue instanceof PhpArr) throw new PhpTypeError('trim(): Argument #1 ($string) must be of type string, array given');
    const fromName = phpTrim(phpCastString(fromNameValue).replace(/[\r\n]+/g, ''));
    if (!fromEmail.includes('@') || !validAddress(punyencode(fromEmail))) throw new MailerError(`Invalid address:  (From): ${fromEmail}`);
    const from = punyencode(fromEmail);
    const to = checkAddress('to', toEmail);
    const reply = phpTruthy(replyTo) && validateEmail(phpCastString(replyTo)) ? checkAddress('Reply-To', replyTo) : null;

    const bodyText = scalarText(body);
    const html = nl2br(bodyText);
    const alt = stripTags(bodyText);
    if (!phpTruthy(html)) throw new MailerError('Message body empty');
    const subjectText = phpTrim(phpTrim(scalarText(subject)).replace(/[\r\n]/g, ''));

    // Mehrteilig nur, wenn es einen Text-Teil gibt (empty($AltBody) wie PHPMailer)
    const composer = new MailComposer({
      from: fromName !== '' ? { name: fromName, address: from } : from,
      to,
      replyTo: reply ?? undefined,
      subject: subjectText,
      html: normalizeBreaks(html),
      text: phpTruthy(alt) ? normalizeBreaks(alt) : undefined,
      textEncoding: 'quoted-printable',
    });
    let message = await composer.compile().build();
    // PHPMailer schreibt die Betreffzeile auch, wenn sie leer ist
    if (subjectText === '') message = Buffer.concat([Buffer.from('Subject: \r\n'), message]);

    if (host instanceof PhpArr) throw new PhpTypeError('explode(): Argument #2 ($string) must be of type string, array given');
    const targets = smtpTargets(host === null ? 'localhost' : scalarText(host), port, smtps);
    let lastError: unknown = new MailerError('SMTP Error: Could not connect to SMTP host.');
    for (const target of targets) {
      let conn: SMTPConnection;
      try {
        conn = await openConnection(target, user, pass);
      } catch (err) {
        // Nächsten Server versuchen
        lastError = err;
        continue;
      }
      try {
        await step(conn, (done) => conn.send({ from, to: [to] }, message, (err, info) => done(err ?? null, info)));
      } finally {
        conn.quit();
      }
      return true;
    }
    throw lastError;
  } catch (err) {
    if (err instanceof PhpTypeError) throw err;
    errorLog(`Mailer Error: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// Text-Mail ohne Vorlage, wie server/cert-alert.php sie mit PHPMailer verschickt: Server und Zugang aus smtp.json,
// Port (int) ($smtp['port'] ?? 587) – 465 = TLS ab der ersten Zeile, sonst STARTTLS –, 15 Sekunden Zeit, Absender
// from_email/from_name (sonst „OnYourSite“), nur Text. Ein Fehler kommt als Exception mit der Meldung zurück.
export async function sendPlainEmail(smtpConfig: PhpJson, toEmail: string, subject: string, text: string, timeoutMs = 15_000): Promise<void> {
  const field = (key: string): PhpJson | undefined => get(smtpConfig, key) ?? undefined;
  const host = field('host');
  if (host instanceof PhpArr) throw new PhpTypeError('explode(): Argument #2 ($string) must be of type string, array given');
  const user = phpCastString(field('username') ?? '');
  const pass = phpCastString(field('password') ?? '');
  const portValue = field('port') ?? new PhpInt(587n);
  const port = intval(portValue instanceof PhpInt ? Number(portValue.value) : portValue instanceof PhpFloat ? portValue.value : portValue);
  // setFrom(): trim, Zeilenumbrüche aus dem Namen
  const fromEmail = phpTrim(phpCastString(field('from_email') ?? ''));
  const fromNameValue = field('from_name') ?? 'OnYourSite';
  if (fromNameValue instanceof PhpArr) throw new PhpTypeError('trim(): Argument #1 ($string) must be of type string, array given');
  const fromName = phpTrim(phpCastString(fromNameValue).replace(/[\r\n]+/g, ''));
  if (!fromEmail.includes('@') || !validAddress(punyencode(fromEmail))) throw new MailerError(`Invalid address:  (From): ${fromEmail}`);
  const from = punyencode(fromEmail);
  const to = checkAddress('to', toEmail);
  if (!phpTruthy(text)) throw new MailerError('Message body empty');
  const subjectText = phpTrim(phpTrim(subject).replace(/[\r\n]/g, ''));
  const message = await new MailComposer({
    from: fromName !== '' ? { name: fromName, address: from } : from,
    to,
    subject: subjectText,
    text: normalizeBreaks(text),
    textEncoding: 'quoted-printable',
  }).compile().build();
  const targets = smtpTargets(host === undefined || host === null ? 'localhost' : phpCastString(host), String(port), port === 465);
  let lastError: unknown = new MailerError('SMTP Error: Could not connect to SMTP host.');
  for (const target of targets) {
    let conn: SMTPConnection;
    try {
      conn = await openConnection(target, user, pass, timeoutMs);
    } catch (err) {
      lastError = err;
      continue;
    }
    try {
      await step(conn, (done) => conn.send({ from, to: [to] }, message, (err, info) => done(err ?? null, info)));
    } finally {
      conn.quit();
    }
    return;
  }
  throw lastError;
}

// !$value für dekodiertes JSON (leeres Array, "", "0", 0, false, null sind falsch)
function jsonTruthy(v: PhpJson): boolean {
  if (v instanceof PhpArr) return v.map.size > 0;
  if (v instanceof PhpInt) return v.value !== 0n;
  if (v instanceof PhpFloat) return v.value !== 0;
  return phpTruthy(v);
}
