// Eigene Domains im Admin (PD-5, Entwurf §4.6): POST /admin mit domain_action – CSRF, Admin-Sitzung (R1) und die
// Bestätigung prüft admin/page.ts vorher. Keine Aktion fragt Cloudflare: Prüfen, Hostnamen anlegen und löschen erledigt
// der Domain-Dienst (worker/), hier entstehen nur Zustände, Aufträge und Hinweise – jeweils in einer Transaktion.
import type { Ctx } from '../web/ctx.js';
import type { Session } from '../web/session.js';
import { transaction, type Db } from '../db.js';
import { date, field, intval, mbSubstr, phpStr, type PhpArray } from '../php.js';
import { cleanText } from '../helpers.js';
import { normalizeHostname, displayHostname } from './hostname.js';
import { domainById, releaseBlock, removeDomain, transition, type DomainRow } from './store.js';
import { requestWorker, saveDomainSettings } from './settings.js';
import { domainNotice, noticeText } from './notify.js';

export const DOMAINS_TAB = '/admin#domains';
// So lange prüft der Dienst nach „Check now“ öfter (wie im Editor)
const FAST_MINUTES = 15;

type Result = { ok: boolean; text: string };
const GONE: Result = { ok: false, text: 'This domain no longer exists.' };
const CHANGED: Result = { ok: false, text: 'This domain changed meanwhile – please try again.' };

export async function domainAdminPost(ctx: Ctx, session: Session, post: PhpArray): Promise<never> {
  const action = field(post, 'domain_action');
  const r = await run(action, post);
  session.set(r.ok ? 'admin_success' : 'admin_error', r.text);
  return ctx.redirect(DOMAINS_TAB);
}

async function run(action: string, post: PhpArray): Promise<Result> {
  const now = date('Y-m-d H:i:s');
  switch (action) {
    case 'settings':
      // Kästchen fehlen im Formular, wenn sie aus sind
      await saveDomainSettings({
        enabled: field(post, 'enabled') === '1', allow_paid: field(post, 'allow_paid') === '1', slots: field(post, 'slots') === '1',
        per_user: field(post, 'per_user'), max_total: field(post, 'max_total'), grace_days: field(post, 'grace_days'),
        pending_days: field(post, 'pending_days'), min_account_days: field(post, 'min_account_days'), mails_per_minute: field(post, 'mails_per_minute'),
      });
      return { ok: true, text: 'Custom domain settings saved.' };
    case 'test':
      await requestWorker('test', now);
      return { ok: true, text: 'Test started – the result shows up here in a few seconds.' };
    case 'control':
      await requestWorker('control', now);
      return { ok: true, text: 'Checking the connection again.' };
    case 'check':
      return check(intval(field(post, 'domain_id')));
    case 'disable':
      return disable(intval(field(post, 'domain_id')), cleanText(field(post, 'reason'), 200));
    case 'enable':
      return enable(intval(field(post, 'domain_id')));
    case 'remove':
      return remove(intval(field(post, 'domain_id')));
    case 'release': {
      const norm = normalizeHostname(field(post, 'hostname'), '');
      const host = norm.ok ? norm.ascii : mbSubstr(field(post, 'hostname').trim().toLowerCase(), 0, 253);
      return (await releaseBlock(host)) ? { ok: true, text: `${displayHostname(host)} can be connected again.` } : { ok: false, text: `${displayHostname(host)} isn’t blocked.` };
    }
  }
  return { ok: false, text: 'Unknown action.' };
}

// Name in Meldungen: wie angezeigt, bei internationalen Namen dazu die ASCII-Form (ähnliche Zeichen fallen so auf)
const label = (row: Pick<DomainRow, 'hostname'>): string => {
  const shown = displayHostname(row.hostname);
  return shown === row.hostname ? shown : `${shown} (${row.hostname})`;
};
// So lang darf der Text eines Eintrags im Verlauf sein (custom_domain_log.detail, logEvent kürzt darauf)
const LOG_DETAIL_MAX = 255;

// „Check now“: wie im Editor, ohne dessen Wartezeit
async function check(id: number): Promise<Result> {
  const row = await domainById(id);
  if (!row) return GONE;
  if (row.state === 'removing' || row.state === 'blocked') return { ok: false, text: `${label(row)} isn’t checked in this state.` };
  const res = await transaction((_c, db) => db.exec(
    `UPDATE custom_domains SET manual_at = NOW(), next_check_at = NOW(), fast_until = NOW() + INTERVAL ${FAST_MINUTES} MINUTE, version = version + 1, updated_at = NOW()
     WHERE id = ? AND version = ?`, [row.id, row.version]));
  return res.affectedRows ? { ok: true, text: `${label(row)}: check started.` } : CHANGED;
}

const pageOf = (db: Db, row: DomainRow) => db.one('SELECT * FROM pages WHERE id = ?', [intval(row.target_id)]);

// Sperren: blocked mit dem Grund, den der Besitzer sieht; die Hauptadresse geht sofort (transition), der Dienst löscht
// den Hostnamen bei Cloudflare bei seiner nächsten Runde; der Hostname bleibt gesperrt, bis ein Admin ihn freigibt (R2)
async function disable(id: number, reason: string): Promise<Result> {
  return transaction(async (_c, db) => {
    const row = await domainById(id, db);
    if (!row) return GONE;
    if (row.state === 'blocked') return { ok: false, text: `${label(row)} is already disabled.` };
    if (row.state === 'removing') return { ok: false, text: `${label(row)} is being removed.` };
    const ok = await transition(row, { state: 'blocked', set: { blocked_reason: reason === '' ? null : reason, next_check_at: date('Y-m-d H:i:s'), fast_until: null, manual_at: null },
      log: { event: 'blocked', detail: reason } }, db);
    if (!ok) return CHANGED;
    // Der Text wird auch als Mail aus dem Verlauf verschickt (detail höchstens 255 Zeichen): der Grund wird dafür
    // gekürzt, statt dass die Mail mitten im Satz endet
    const page = await pageOf(db, row);
    let body = noticeText.removed(row, page, 'blocked', reason);
    if (body.length > LOG_DETAIL_MAX) {
      const room = LOG_DETAIL_MAX - noticeText.removed(row, page, 'blocked', '…').length;
      body = noticeText.removed(row, page, 'blocked', mbSubstr(reason, 0, Math.max(0, room)).trimEnd() + '…');
    }
    await domainNotice(db, row, 'domain_removed', body);
    return { ok: true, text: `${label(row)} is disabled.` };
  });
}

// Wieder einschalten: die Sperre fällt (auch der Eintrag für den Hostnamen), die Domain beginnt mit der Prüfung
async function enable(id: number): Promise<Result> {
  const row = await domainById(id);
  if (!row) return GONE;
  if (row.state !== 'blocked') return { ok: false, text: `${label(row)} isn’t disabled.` };
  if (!(await releaseBlock(phpStr(row.hostname)))) return CHANGED;
  return { ok: true, text: `${label(row)} is being reconnected.` };
}

// Entfernen: wie „Remove“ im Editor (ohne Hostnamen bei Cloudflare sofort, sonst über den Dienst); der Besitzer erfährt es
// Der Stand vor der Transaktion (ohne Sperre) dient nur dem Hinweis: removeDomain() sperrt in der festen Reihenfolge
// Ziel → Domain und liest die Zeile selbst neu
async function remove(id: number): Promise<Result> {
  const row = await domainById(id);
  if (!row) return GONE;
  return transaction(async (_c, db) => {
    const page = await pageOf(db, row);
    const outcome = await removeDomain(db, id, 'admin');
    if (outcome === 'gone') return GONE;
    // Keine zweite Nachricht: eine gesperrte Domain hat der Besitzer beim Sperren verloren (und davon erfahren); eine,
    // die schon entfernt wird, hat er selbst oder das Konto entfernt
    if (row.state !== 'removing' && row.state !== 'blocked') await domainNotice(db, row, 'domain_removed', noticeText.removed(row, page, 'admin'));
    return { ok: true, text: `${label(row)} was removed.` };
  });
}
