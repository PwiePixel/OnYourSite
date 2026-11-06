// Beta-Bereich (beta.<domain>): Tester, Zugang, Discord-Rolle und Meldungen.
// - Tester schaltet ein Admin frei (users.beta_at). Dafür muss Discord verknüpft sein (users.discord_id): jeder Tester
//   bekommt über den Bot die Rolle „Beta Tester“ auf dem Discord-Server (Auftrag beta.role, Funktion beta.v1).
// - Zugang zu beta.<domain>: freigeschaltet und Discord verknüpft – oder Admin.
// - Ändert ein Tester seine Discord-ID, geht die Rolle mit (alte ID: entfernen, neue: geben); ohne ID ruht der Zugang.
// - Meldungen (beta_reports): Fehler, Ideen, Sonstiges, mit Status und Antwort des Teams.
import type { Row } from '../db.js';
import { exec, one, q, transaction, type Db } from '../db.js';
import { decryptData } from '../crypto.js';
import { baseAuthority, baseHost, scheme } from '../helpers.js';
import { date, intval, phpStr } from '../php.js';
import { isBetaBuild } from '../config.js';
import { notify } from '../notify/notify.js';
import { registerBotAction, type BotResult, type OutboxJob } from '../community/outbox.js';
import { outboxAdd } from '../community/community.js';

export const betaHost = (): string => 'beta.' + baseHost();
// Auf der Beta-Webseite selbst (beta_build) ist beta.<domain> schon die eigene Adresse
export const betaUrl = (path = '/'): string => scheme() + '://' + (isBetaBuild() ? '' : 'beta.') + baseAuthority() + path;
export const isBetaHost = (host: string): boolean => host === betaHost();

export const REPORT_KINDS: Readonly<Record<string, string>> = Object.freeze({ bug: 'Bug', idea: 'Idea', other: 'Other' });
export const REPORT_AREAS: Readonly<Record<string, string>> = Object.freeze({
  editor: 'Editor', page: 'My page', design: 'Themes & design', shop: 'Honeycombs & shop', code: 'Code pages',
  status: 'Status pages', account: 'Account & login', other: 'Something else',
});
export const REPORT_STATUSES: Readonly<Record<string, { label: string; cls: string }>> = Object.freeze({
  open: { label: 'Open', cls: 'border-sky-500/30 bg-sky-500/10 text-sky-300' },
  planned: { label: 'Planned', cls: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-300' },
  in_progress: { label: 'In progress', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-300' },
  fixed: { label: 'Fixed', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' },
  wont_fix: { label: 'Won’t fix', cls: 'border-bordercolor bg-white/5 text-gray-400' },
  duplicate: { label: 'Duplicate', cls: 'border-bordercolor bg-white/5 text-gray-400' },
});

// Discord-ID eines Kontos (entschlüsselt, nur Ziffern) oder ''
export function discordOf(user: Row): string {
  const id = phpStr(decryptData((user.discord_id ?? null) as string | null) ?? '').replace(/[^0-9]/g, '');
  return /^\d{15,22}$/.test(id) ? id : '';
}

export type BetaAccess = 'ok' | 'not_tester' | 'no_discord';
export function betaAccess(user: Row): BetaAccess {
  if (intval(user.is_admin) === 1) return 'ok';
  if (user.beta_at === null || user.beta_at === undefined || user.beta_at === '') return 'not_tester';
  return discordOf(user) === '' ? 'no_discord' : 'ok';
}

// Auftrag an den Bot: Rolle „Beta Tester“ geben oder nehmen. ref je Konto: die Aufträge eines Kontos gehen der Reihe
// nach (erst die alte ID entfernen, dann der neuen geben)
async function queueRole(db: Db, userId: number, discordId: string, add: boolean): Promise<void> {
  await outboxAdd('beta.role', { user_id: userId, discord_id: discordId, add }, { ref: 'beta:' + userId, db });
}

export type GrantResult = { ok: true } | { ok: false; error: string };

export async function grantBeta(adminId: number, userId: number): Promise<GrantResult> {
  return transaction(async (_conn, db) => {
    const user = await db.one('SELECT * FROM users WHERE id = ? FOR UPDATE', [userId]);
    if (!user) return { ok: false, error: 'This account doesn’t exist.' };
    if (user.beta_at !== null && user.beta_at !== undefined) return { ok: false, error: 'This account is already a beta tester.' };
    const discord = discordOf(user);
    if (discord === '') return { ok: false, error: 'This account has no Discord linked – beta testers need it for the Beta Tester role. Ask them to add their Discord ID in the editor under Settings.' };
    await db.exec("UPDATE users SET beta_at = ?, beta_by = ?, beta_discord = ?, beta_role = 'pending', beta_role_error = NULL WHERE id = ?",
      [date('Y-m-d H:i:s'), adminId, discord, userId]);
    await queueRole(db, userId, discord, true);
    await notify(userId, 'beta', 'You’re a beta tester now',
      `Open ${betaHost()} and log in with your OnYourSite account to try new things first and report bugs. On Discord you get the Beta Tester role.`,
      '/_/beta', { db });
    return { ok: true };
  });
}

export async function revokeBeta(userId: number): Promise<GrantResult> {
  return transaction(async (_conn, db) => {
    const user = await db.one('SELECT * FROM users WHERE id = ? FOR UPDATE', [userId]);
    if (!user || user.beta_at === null || user.beta_at === undefined) return { ok: false, error: 'This account isn’t a beta tester.' };
    const given = phpStr(user.beta_discord ?? '');
    await db.exec("UPDATE users SET beta_at = NULL, beta_by = NULL, beta_role = ?, beta_role_error = NULL WHERE id = ?", [given ? 'pending' : null, userId]);
    if (given) await queueRole(db, userId, given, false);
    return { ok: true };
  });
}

// Noch einmal versuchen (z. B. nachdem der Tester dem Discord-Server beigetreten ist): bei einem Tester die Rolle geben,
// bei einem entfernten Konto, dessen Entfernen fehlschlug, die Rolle noch einmal nehmen
export async function retryRole(userId: number): Promise<GrantResult> {
  return transaction(async (_conn, db) => {
    const user = await db.one('SELECT * FROM users WHERE id = ? FOR UPDATE', [userId]);
    if (!user) return { ok: false, error: 'This account doesn’t exist.' };
    const given = phpStr(user.beta_discord ?? '');
    if (user.beta_at === null || user.beta_at === undefined) {
      if (!given) return { ok: false, error: 'This account isn’t a beta tester.' };
      await db.exec("UPDATE users SET beta_role = 'pending', beta_role_error = NULL WHERE id = ?", [userId]);
      await queueRole(db, userId, given, false);
      return { ok: true };
    }
    const discord = discordOf(user);
    if (discord === '') return { ok: false, error: 'This account has no Discord linked.' };
    // Eine alte ID mit der Rolle (Entfernen nach einem Wechsel schlug fehl) verliert sie dabei
    const stale = /old Discord ID (\d{15,22})/.exec(phpStr(user.beta_role_error ?? ''));
    if (stale && stale[1] !== discord) await queueRole(db, userId, stale[1], false);
    await db.exec("UPDATE users SET beta_discord = ?, beta_role = 'pending', beta_role_error = NULL WHERE id = ?", [discord, userId]);
    await queueRole(db, userId, discord, true);
    return { ok: true };
  });
}

// Die Discord-ID eines Kontos ändern (Editor → Einstellungen; stored = verschlüsselt oder ''): bei einem Tester geht die
// Rolle mit – Speichern und Aufträge in einer Transaktion. Ohne stored nur die Rolle abgleichen.
export async function discordChanged(userId: number, stored?: string): Promise<void> {
  await transaction(async (_conn, db) => {
    if (stored !== undefined) await db.exec('UPDATE users SET discord_id = ? WHERE id = ?', [stored, userId]);
    const user = await db.one('SELECT * FROM users WHERE id = ? FOR UPDATE', [userId]);
    if (!user || user.beta_at === null || user.beta_at === undefined) return;
    const now = discordOf(user);
    const given = phpStr(user.beta_discord ?? '');
    if (now === given) return;
    if (given) await queueRole(db, userId, given, false);
    if (now) await queueRole(db, userId, now, true);
    await db.exec("UPDATE users SET beta_discord = ?, beta_role = ?, beta_role_error = NULL WHERE id = ?", [now || null, now ? 'pending' : null, userId]);
  });
}

// Rückmeldung des Bots: Stand der Rolle am Konto (nur, wenn der Auftrag zur aktuellen Discord-ID passt)
async function onRoleResult(db: Db, job: OutboxJob, result: BotResult | null, error: string, final: boolean): Promise<void> {
  const data = job.data ?? {};
  const userId = intval(data.user_id);
  const discordId = phpStr(data.discord_id ?? '');
  const add = data.add === true;
  const user = await db.one('SELECT id, beta_at, beta_discord FROM users WHERE id = ? FOR UPDATE', [userId]);
  if (!user) return;
  const current = phpStr(user.beta_discord ?? '');
  if (error !== '') {
    if (!final) return;
    if (discordId === current) {
      await db.exec("UPDATE users SET beta_role = 'error', beta_role_error = ? WHERE id = ?", [(add ? '' : 'Removing the role failed: ') + error.slice(0, 160), userId]);
    } else if (!add) {
      // Die alte ID (nach einem Wechsel) behielt die Rolle: im Admin sichtbar machen, „Try again“ nimmt sie weg
      await db.exec("UPDATE users SET beta_role_error = ? WHERE id = ?", [('The role stayed on the old Discord ID ' + discordId + ': ' + error).slice(0, 200), userId]);
    }
    return;
  }
  const state = phpStr(result?.state ?? '');
  if (add) {
    if (discordId !== current || user.beta_at === null) return;
    await db.exec('UPDATE users SET beta_role = ?, beta_role_error = NULL WHERE id = ?', [state === 'not_on_server' ? 'not_on_server' : 'given', userId]);
  } else if (discordId === current && (user.beta_at === null || user.beta_at === undefined)) {
    // Entfernt (oder war gar nicht auf dem Server): nichts mehr vergeben
    await db.exec("UPDATE users SET beta_discord = NULL, beta_role = 'removed', beta_role_error = NULL WHERE id = ?", [userId]);
  }
}

registerBotAction('beta.role', { feature: 'beta.v1', onResult: onRoleResult });

// ---------------------------------------------------------------- Meldungen

export interface NewReport { kind: string; area: string; title: string; body: string; steps: string; pageUrl: string; userAgent: string }

const clean = (v: unknown, max: number): string => phpStr(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);

export function readReport(input: Record<string, unknown>, userAgent: string): NewReport | string {
  const kind = phpStr(input.kind ?? '');
  const area = phpStr(input.area ?? '');
  const r: NewReport = {
    kind: Object.hasOwn(REPORT_KINDS, kind) ? kind : 'bug',
    area: Object.hasOwn(REPORT_AREAS, area) ? area : 'other',
    title: clean(input.title, 160).replace(/\n+/g, ' '),
    body: clean(input.body, 5000),
    steps: clean(input.steps, 3000),
    pageUrl: clean(input.page_url, 500).replace(/\s+/g, ''),
    userAgent: clean(userAgent, 300),
  };
  if (r.title.length < 4) return 'Please give your report a short title.';
  if (r.body.length < 10) return 'Please describe what happened (at least a few words).';
  if (r.pageUrl !== '' && !/^https?:\/\/[^\s]+$/i.test(r.pageUrl)) return 'The link must start with https://';
  return r;
}

export async function addReport(userId: number, r: NewReport): Promise<number> {
  const now = date('Y-m-d H:i:s');
  const res = await exec('INSERT INTO beta_reports (user_id, kind, area, title, body, steps, page_url, user_agent, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [userId, r.kind, r.area, r.title, r.body, r.steps || null, r.pageUrl || null, r.userAgent || null, 'open', now, now]);
  return res.insertId;
}

export const reportsOf = (userId: number): Promise<Row[]> => q('SELECT * FROM beta_reports WHERE user_id = ? ORDER BY id DESC LIMIT 100', [userId]);

export async function answerReport(adminId: number, id: number, status: string, reply: string): Promise<GrantResult> {
  if (!Object.hasOwn(REPORT_STATUSES, status)) return { ok: false, error: 'Unknown status.' };
  const row = await one('SELECT id, user_id, title, status, reply FROM beta_reports WHERE id = ?', [id]);
  if (!row) return { ok: false, error: 'This report doesn’t exist.' };
  const text = clean(reply, 3000);
  await exec('UPDATE beta_reports SET status = ?, reply = ?, replied_by = ?, updated_at = ? WHERE id = ?', [status, text || null, text ? adminId : null, date('Y-m-d H:i:s'), id]);
  if (status !== phpStr(row.status) || text !== phpStr(row.reply ?? '')) {
    await notify(intval(row.user_id), 'beta', 'Your beta report: ' + REPORT_STATUSES[status].label,
      `“${phpStr(row.title).slice(0, 120)}”${text ? ' – the team replied.' : ''} See it in the beta area at ${betaHost()}.`, '/_/beta');
  }
  return { ok: true };
}

// Text „What to test right now“ (Admin → Beta), oys_meta['beta_notes']
export async function betaNotes(): Promise<string> {
  const r = await one("SELECT meta_value FROM oys_meta WHERE meta_key = 'beta_notes'");
  return phpStr(r?.meta_value ?? '');
}
export async function saveBetaNotes(text: string): Promise<void> {
  await exec("REPLACE INTO oys_meta (meta_key, meta_value) VALUES ('beta_notes', ?)", [clean(text, 4000)]);
}

// Konto löschen (admin/accountDeletion.ts): Meldungen weg; hatte das Konto die Rolle, nimmt der Bot sie (die Rückmeldung
// findet das Konto dann nicht mehr und ändert nichts)
export async function betaForgetUser(db: Db, userId: number): Promise<void> {
  const user = await db.one('SELECT beta_discord FROM users WHERE id = ?', [userId]);
  const given = phpStr(user?.beta_discord ?? '');
  if (given) await queueRole(db, userId, given, false);
  await db.exec('DELETE FROM beta_reports WHERE user_id = ?', [userId]);
}
