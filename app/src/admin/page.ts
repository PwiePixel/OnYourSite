// /admin (views/admin.php mit admin_updates, admin_community, admin_honeycombs, admin_storage) – nur für Admins.
// Honigwaben und Code-Seiten sind getrennte Bereiche (#honeycombs, #code-pages).
// POST: zuerst CSRF und die Bestätigung (_confirmed), dann genau in dieser Reihenfolge Speicher → Community →
// Honigwaben → Code-Seiten → Updates (null: weiter) → Mail-Server → Konto löschen → Admin-Rolle → Passwort →
// Newsletter. Passt nichts, wird die Seite (200) angezeigt.
import type { Ctx } from '../web/ctx.js';
import { q, type Row } from '../db.js';
import { Session } from '../web/session.js';
import { csrfCheck, csrfField } from '../web/security.js';
import { decryptData } from '../crypto.js';
import { intval, phpTruthy, type PhpArray } from '../php.js';
import { storageDownloadZip, storageMoveToDataDir, uploadsDir } from '../content/storage.js';
import { adminCommunityPost } from '../community/admin.js';
import { adminCommunityView } from '../community/adminView.js';
import { adminHcHandle } from '../honeycombs/honeycombs.js';
import { adminHoneycombsView } from '../honeycombs/adminView.js';
import { adminCodeHandle, legacyCodePost } from '../code/admin.js';
import { adminCodePagesView } from '../code/adminView.js';
import { adminStatusView } from '../status/adminView.js';
import { adminUpdatesHandle } from '../updates/admin.js';
import { adminUpdatesView } from '../updates/adminView.js';
import { resetPassword, toggleAdmin } from './users.js';
import { deleteAccount } from './accountDeletion.js';
import { emailTemplates, ensureEmailDir, saveSmtp, sendNewsletter, smtpConfig } from './newsletter.js';
import { adminView, CutOffPage, type AdminViewData } from './views/admin.js';
import { adminStorageData, adminStorageView } from './views/storage.js';
import { adminBackUrl, refuseUnconfirmed } from './confirm.js';

export async function adminPage(ctx: Ctx, user: Row): Promise<void> {
  const session = await Session.start(ctx);
  const isPost = ctx.method === 'POST';
  const post = ctx.post;

  // Alle Admin-Formulare sind gegen CSRF geschützt
  if (isPost && !csrfCheck(ctx, post.csrf ?? null)) {
    session.set('admin_error', 'Session expired – please try again.');
    ctx.redirect('/admin');
  }
  // Formulare mit eigenem Bestätigungsdialog: ohne „1“ wird nichts ausgeführt (fällt ui.js aus, passiert nichts)
  if (isPost) refuseUnconfirmed(ctx, session, adminBackUrl(post));

  // Speicherort und Backups der Uploads (lib/storage.php)
  if (isPost && post.storage_action !== undefined) {
    if (post.storage_action === 'zip') {
      // Liefert bei Erfolg direkt das ZIP aus und beendet die Anfrage
      session.set('admin_error', await storageDownloadZip(ctx));
    } else if (post.storage_action === 'move') {
      const moved = storageMoveToDataDir();
      if (phpTruthy(moved.error)) {
        session.set('admin_error', moved.error);
      } else {
        session.set('admin_success', moved.moved + ' file(s) moved to ' + uploadsDir()
          + (phpTruthy(moved.skipped) ? ' – ' + moved.skipped + ' were already there and stayed in static/uploads.' : '.'));
      }
    }
    ctx.redirect('/admin#storage');
  }

  // Community: Vorschläge aus Discord entscheiden, Tickets beantworten (Meldung und Weiterleitung dort)
  if (isPost && post.community_action !== undefined) {
    await adminCommunityPost(ctx, user);
  }

  // Honigwaben vergeben/einstellen
  if (isPost && post.hc_action !== undefined) {
    // Formulare der Code-Seiten von vor der Trennung (hc_action=code_*) gehen an den Bereich Code-Seiten
    const legacy = legacyCodePost(post);
    if (legacy) await codeAction(ctx, session, legacy);
    const result = await adminHcHandle(post, intval(session.get('user_id')));
    if (result) flashResult(session, result);
    ctx.redirect('/admin#honeycombs');
  }

  // Code-Seiten sperren/entsperren, ohne Honigwaben freischalten
  if (isPost && post.code_action !== undefined) {
    await codeAction(ctx, session, post);
  }

  // Updates, Roadmap und Discord – nur weiterleiten, wenn die Aktion dorthin gehört
  if (isPost && post.oys_action !== undefined) {
    const result = await adminUpdatesHandle(post, ctx);
    if (result) {
      flashResult(session, result);
      ctx.redirect('/admin' + (result.query ?? '') + '#' + result.tab);
    }
  }

  // Ordner für E-Mails und Einstellungen sicherstellen
  ensureEmailDir();

  // Mail-Server (SMTP) speichern
  if (isPost && post.save_smtp !== undefined) {
    saveSmtp(post);
    session.set('admin_success', 'Mail Server settings successfully saved.');
    ctx.redirect('/admin');
  }

  // Konto löschen (nie das eigene)
  if (isPost && post.delete_user_id !== undefined) {
    const id = intval(post.delete_user_id);
    if (sameId(id, session.get('user_id'))) {
      session.set('admin_error', 'You cannot delete your own admin account!');
    } else {
      try {
        await deleteAccount(ctx, id);
        session.set('admin_success', 'User successfully deleted.');
      } catch {
        // Alles zurückgerollt (Grund steht im Protokoll)
        session.set('admin_error', 'The user couldn’t be deleted – please try again.');
      }
    }
    ctx.redirect('/admin');
  }

  // Admin-Rolle umschalten (nie die eigene)
  if (isPost && post.toggle_admin_id !== undefined) {
    const id = intval(post.toggle_admin_id);
    if (sameId(id, session.get('user_id'))) {
      session.set('admin_error', 'You cannot change your own admin status here!');
    } else {
      const status = await toggleAdmin(id);
      session.set('admin_success', 'User successfully ' + (status ? 'promoted to Admin' : 'demoted to User') + '.');
    }
    ctx.redirect('/admin');
  }

  // Passwort für ein Konto neu setzen (ohne Passwort geht es weiter zur Seite)
  if (isPost && post.reset_password_id !== undefined && phpTruthy(post.new_password)) {
    const id = phpIntBig(post.reset_password_id);
    const password = post.new_password;
    // password_hash(array) ist in PHP ein TypeError (500)
    if (typeof password !== 'string') throw new TypeError('password_hash(): Argument #1 ($password) must be of type string, array given');
    await resetPassword(id, password);
    session.set('admin_success', 'Password for user #' + id + ' successfully changed.');
    ctx.redirect('/admin');
  }

  // Newsletter und einzelne Mails senden
  if (isPost && post.send_newsletter !== undefined) {
    flashResult(session, await sendNewsletter(post));
    ctx.redirect('/admin');
  }

  let page: string;
  try {
    page = adminView(await adminViewData(ctx, session));
  } catch (err) {
    if (!(err instanceof CutOffPage)) throw err;
    // Wie PHP ohne Fehleranzeige: der Anfang der Seite ist schon gesendet (200), der Fehler steht nur im Protokoll
    console.error(`[${new Date().toISOString()}] ${ctx.method} ${ctx.rawUrl}:`, err.reason);
    ctx.write(err.html);
    ctx.halt();
  }
  ctx.write(page);
}

// Aktion im Bereich Code-Seiten: Meldung merken und zurück zum Bereich (beendet die Anfrage)
async function codeAction(ctx: Ctx, session: Session, post: PhpArray): Promise<never> {
  const result = await adminCodeHandle(post);
  if (result) flashResult(session, result);
  ctx.redirect('/admin#code-pages');
}

// $_SESSION[isset($result['error']) ? 'admin_error' : 'admin_success'] = $result['error'] ?? $result['ok']
function flashResult(session: Session, result: { ok?: string; error?: string }): void {
  if (result.error !== undefined && result.error !== null) session.set('admin_error', result.error);
  else session.set('admin_success', result.ok ?? null);
}

// $id === $_SESSION['user_id']: in PHP sind beide int – nur dann gleich
const sameId = (id: number, sessionId: unknown): boolean => typeof sessionId === 'number' && id === sessionId;

// (int) $v genau wie PHP auch jenseits von 2^53 (für die Meldung mit der Nummer): ganze Zahlen im Text bleiben exakt,
// zu große werden PHP_INT_MAX/MIN, Kommazahlen werden abgeschnitten, unendlich ergibt 0, Arrays 0 oder 1
export function phpIntBig(v: unknown): bigint {
  if (typeof v !== 'string') return BigInt(intval(v));
  const m = /^[ \t\n\v\f\r]*([+-]?)(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(v);
  if (!m) return 0n;
  const max = 2n ** 63n - 1n;
  const min = -(2n ** 63n);
  if (m[3] === undefined && m[4] === undefined && /^\d/.test(m[2])) {
    const n = BigInt(m[1] + m[2]);
    return n > max ? max : n < min ? min : n;
  }
  const f = Number(m[0].replace(/^[ \t\n\v\f\r]+/, ''));
  if (!Number.isFinite(f)) return 0n;
  if (f >= 2 ** 63) return max;
  if (f < -(2 ** 63)) return min;
  return BigInt(Math.trunc(f));
}

// Daten der Seite (admin.php ab „Alle User laden“) und die eingebundenen Teile in der Reihenfolge von PHP
async function adminViewData(ctx: Ctx, session: Session): Promise<AdminViewData> {
  const allUsers = await q('SELECT id, full_name, email, username, discord_id, is_admin, created_at FROM users ORDER BY id DESC');
  // Die verschlüsselten Discord-IDs für die Tabelle wieder lesbar machen
  for (const u of allUsers) {
    u.discord_id = decryptData(u.discord_id as string | null) ?? null;
  }
  // Seiten (bis zu 3 je Nutzer) für die Tabelle
  const pagesByUser = new Map<number, Row[]>();
  let totalPages = 0;
  for (const pg of await q('SELECT * FROM pages ORDER BY position, id')) {
    const owner = intval(pg.user_id);
    const list = pagesByUser.get(owner);
    if (list) list.push(pg);
    else pagesByUser.set(owner, [pg]);
    totalPages++;
  }
  const templates = emailTemplates();
  const smtp = smtpConfig();

  // Hinweise nur einmal zeigen (isset → anzeigen und entfernen)
  const flashSuccess = takeFlash(session, 'admin_success');
  const flashError = takeFlash(session, 'admin_error');
  const csrf = String(await csrfField(ctx));
  return {
    csrfField: csrf,
    flashSuccess,
    flashError,
    sessionUserId: session.get('user_id'),
    allUsers,
    pagesByUser,
    totalUsers: allUsers.length,
    // $u['is_admin'] == 1 (TINYINT: Zahl oder NULL)
    totalAdmins: allUsers.filter((u) => u.is_admin !== null && u.is_admin !== undefined && Number(u.is_admin) === 1).length,
    totalDomains: allUsers.filter((u) => phpTruthy(u.username)).length,
    totalPages,
    templates,
    smtpConfig: smtp,
    updatesHtml: await adminUpdatesView(ctx),
    communityHtml: await adminCommunityView(ctx),
    honeycombsHtml: await adminHoneycombsView(ctx, allUsers),
    codePagesHtml: await adminCodePagesView(ctx, allUsers),
    statusHtml: await adminStatusView(ctx),
    storageHtml: adminStorageView(adminStorageData(csrf)),
  };
}

// isset($_SESSION[$key]) … unset(): gesetzt und nicht null → Wert, sonst undefined (dann bleibt alles, wie es ist)
function takeFlash(session: Session, key: string): unknown {
  const v = session.get(key);
  if (v === undefined || v === null) return undefined;
  session.delete(key);
  return v;
}
