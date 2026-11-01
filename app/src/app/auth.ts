// Anmelden, Registrieren, Abmelden (lib/routes_app.php, views/login.php, views/register.php)
import type { Ctx } from '../web/ctx.js';
import { Session } from '../web/session.js';
import { attemptFailed, attemptsAllowed, clientKey, csrfCheck, csrfField, rateLimit } from '../web/security.js';
import { DbUnavailableError, exec, one, type Param } from '../db.js';
import { encryptData, passwordHash, passwordVerify, sha256Hex } from '../crypto.js';
import { cleanText, normalizeSlug, slugProblem, validateEmail } from '../helpers.js';
import { intval, phpEmpty, phpTrim, strlen, strtolower, type PhpArray } from '../php.js';
import { e } from '../html.js';
import { createPage } from '../content/pages.js';
import { DEFAULT_THEME } from '../content/themes.js';
import { sendCustomEmail } from '../mail.js';
import { flash } from './context.js';
import { loginView } from './views/login.js';
import { registerView } from './views/register.js';

// /logout: nur per POST mit CSRF-Token – sonst könnte jede fremde Seite (oder eigenes CSS) abmelden
export async function logout(ctx: Ctx): Promise<void> {
  const session = ctx.session;
  if (ctx.method === 'POST' && session && csrfCheck(ctx, ctx.post.csrf ?? null)) {
    session.data = {};
    session.destroy();
    ctx.redirect('/');
  }
  ctx.redirect(phpEmpty(session?.get('user_id')) ? '/' : '/dashboard');
}

// ---------------------------------------------------------------
// Registrierung
// ---------------------------------------------------------------

export async function register(ctx: Ctx): Promise<void> {
  const session = await Session.start(ctx);
  if (ctx.method === 'POST') {
    const fullname = cleanText(ctx.post.fullname ?? '', 120);
    const email = strtolower(phpTrim(ctx.p('email')));
    const password = ctx.p('password');
    const slug = normalizeSlug(ctx.post.subdomain ?? '');
    session.set('old', { fullname, email, subdomain: slug });

    let problem: string | null;
    if (!csrfCheck(ctx, ctx.post.csrf ?? null)) {
      flash(ctx, 'error', 'Your session has expired. Please try again.');
    } else if (fullname === '' || email === '' || password === '' || slug === '') {
      flash(ctx, 'error', 'Please fill in all fields.');
    } else if (!validateEmail(email)) {
      flash(ctx, 'error', 'Please enter a valid email address.');
    } else if (strlen(password) < 8) {
      flash(ctx, 'error', 'Your password must be at least 8 characters long.');
    } else if ((problem = await slugProblem(slug)) !== null) {
      flash(ctx, 'error', problem);
    } else if (!(await rateLimit('register:' + clientKey(ctx), 5, 3600)) || !(await rateLimit('register', 50, 3600))) {
      // Massen-Anmeldungen bremsen (jedes Konto bekommt Speicherplatz und eine Begrüßungs-Mail) – je Absender
      // und insgesamt, falls jemand viele Adressen hat
      flash(ctx, 'error', 'A lot of accounts were just created from here. Please try again later.');
    } else {
      const check = await one('SELECT id FROM users WHERE email = ? OR username = ? LIMIT 1', [email, slug]);
      if (check) {
        flash(ctx, 'error', 'This email address or page address is already registered.');
      } else {
        try {
          // password_hash() steht in PHP vor dem INSERT: ein Nullbyte im Passwort endet mit 500 (kein PDO-Fehler)
          const { insertId } = await exec("INSERT INTO users (email, password, full_name, username, layout_type, last_ip, theme) VALUES (?, ?, ?, ?, 'link-tree', ?, ?)",
            [email, await passwordHash(password), fullname, slug, encryptData(ctx.ip) ?? null, DEFAULT_THEME]);
          const userId = intval(insertId);
          const pageId = await createPage(userId, slug, fullname);
          session.regenerate();
          session.set('user_id', userId);
          session.set('page_id', pageId);
          session.delete('old');
          flash(ctx, 'success', 'Welcome! Your page is live.');
          await sendMail(email, 'register', { full_name: e(fullname), subdomain: e(slug) });
          ctx.redirect('/dashboard');
        } catch (err) {
          // Nur Datenbankfehler wie catch (PDOException) – alles andere (auch das Ende der Anfrage) geht weiter
          if (!isDbError(err)) throw err;
          console.error('Sign-up failed: ' + (err as Error).message);
          flash(ctx, 'error', 'This email address is already registered.');
        }
      }
    }
    ctx.redirect('/register');
  }

  // views/register.php: Hinweis und Eingaben des letzten Versuchs nur einmal zeigen
  const flashError = session.take('error') ?? null;
  const old = registerOld(session.get('old'), ctx.get);
  session.delete('old');
  ctx.write(registerView({ flashError, old, csrfField: String(await csrfField(ctx)) }));
}

// Kopf von views/register.php: $old = $_SESSION['old'] ?? []; ohne Adresse ein Vorschlag aus ?name= (Link der 404-Seite)
export function registerOld(stored: unknown, get: PhpArray): Record<string, unknown> {
  const old: Record<string, unknown> = isRecord(stored) ? { ...stored } : {};
  if (phpEmpty(old.subdomain) && Object.hasOwn(get, 'name')) {
    old.subdomain = normalizeSlug(get.name);
  }
  return old;
}

// ---------------------------------------------------------------
// Login
// ---------------------------------------------------------------

export async function login(ctx: Ctx): Promise<void> {
  const session = await Session.start(ctx);
  if (ctx.method === 'POST') {
    const email = strtolower(phpTrim(ctx.p('email')));
    const password = ctx.p('password');
    const loginKey = 'login:' + sha256Hex(email).slice(0, 40);
    if (!csrfCheck(ctx, ctx.post.csrf ?? null)) {
      flash(ctx, 'error', 'Your session has expired. Please try again.');
    } else if (!(await attemptsAllowed(ctx, loginKey, 10, 50, 900))) {
      flash(ctx, 'error', 'Too many attempts. Please wait 15 minutes.');
    } else {
      const user = await one('SELECT * FROM users WHERE email = ?', [email]);
      if (!user || !(await passwordVerify(password, user.password))) {
        // Nur Fehlversuche zählen – je Absender und je Konto
        await attemptFailed(ctx, loginKey, 900);
      } else {
        session.regenerate();
        session.set('user_id', intval(user.id));
        await exec('UPDATE users SET last_ip = ? WHERE id = ?', [encryptData(ctx.ip) ?? null, user.id as Param]);
        ctx.redirect('/dashboard');
      }
      flash(ctx, 'error', 'Wrong email or password.');
    }
    ctx.redirect('/login');
  }

  // views/login.php: Hinweise nur einmal zeigen
  const flashError = session.take('error') ?? null;
  const flashSuccess = session.take('success') ?? null;
  ctx.write(loginView({ flashError, flashSuccess, csrfField: String(await csrfField(ctx)) }));
}

// ---------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// Wie catch (PDOException): Fehler der Datenbank (SQL-Fehler, verlorene Verbindung), nicht aber andere Ausnahmen
function isDbError(err: unknown): boolean {
  if (err instanceof DbUnavailableError) return true;
  if (!(err instanceof Error)) return false;
  const x = err as Error & { sqlState?: unknown; fatal?: unknown };
  return typeof x.sqlState === 'string' || x.fatal === true;
}

// sendCustomEmail() aus mail.ts; das Ergebnis wird wie in PHP nicht ausgewertet. Fest eingebunden: fehlt das Modul,
// meldet das schon die Typprüfung, statt dass die Begrüßungs-Mail still ausbleibt.
type SendMail = (to: unknown, template: string, vars: Record<string, unknown>) => Promise<boolean>;
let mailer: SendMail | null = sendCustomEmail;

// Für Tests: eigene Versandfunktion (null = nichts senden, undefined = wieder mail.ts verwenden)
export function setAuthMailerForTests(fn: SendMail | null | undefined): void {
  mailer = fn === undefined ? sendCustomEmail : fn;
}

async function sendMail(to: string, template: string, vars: Record<string, unknown>): Promise<void> {
  if (mailer) await mailer(to, template, vars);
}
