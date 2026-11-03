// Admin, Bereich „Code pages“ (POST code_action, CS-5): Grenzen, Code-Seiten sperren, entsperren und löschen, Konten
// für Code-Seiten sperren und wieder zulassen, Code-Seiten ohne Honigwaben freischalten. Alles, was die Code-Seiten
// eines Kontos ändert, läuft unter dessen Platz-Sperre (withSlotLock), liest die Zeilen FOR UPDATE neu, schreibt das
// Protokoll (code_moderation) und den Hinweis an den Besitzer (notify, ohne ref) in derselben Transaktion; Dateien
// werden erst nach dem Commit aufgeräumt. Grenzen und Freischaltungen schreiben ihre eigene Zeile und danach das
// Protokoll (eigene Abfrage). CSRF, Admin-Sitzung und Bestätigung prüft admin/page.ts vorher.
import { date, field, intval, phpStr, phpTruthy, type PhpArray } from '../php.js';
import type { Db, Row } from '../db.js';
import { cleanText } from '../helpers.js';
import { HcBusyError, hcAdd, type AdminResult } from '../honeycombs/honeycombs.js';
import { phpInt, poolDb } from '../honeycombs/util.js';
import { notify } from '../notify/notify.js';
import { cleanupFiles } from '../content/pages.js';
import { SlotBusyError, SlotGoneError, SLOT_BUSY_TEXT, withSlotLock } from './slots.js';
import { codeDeleteRows } from './sites.js';
import { saveCodeSettings, type CodeSettings } from './settings.js';

// Was sich im Admin freischalten lässt
export const CODE_UNLOCK_ITEMS: readonly string[] = ['code_page', 'code_more'];

const NOT_FOUND = { error: 'Code page not found.' };
const NO_USER = { error: 'Please choose a user.' };

// Adresse einer Code-Seite (eigene oder die des Platzes, der sie zeigt) – unter der Sperre gelesen
async function addressOf(db: Db, site: Row): Promise<string> {
  if (phpTruthy(site.slug)) return phpStr(site.slug);
  const slot = await db.one('SELECT slug FROM pages WHERE code_site_id = ? AND user_id = ?', [intval(site.id), intval(site.user_id)]);
  return slot ? phpStr(slot.slug) : '';
}

async function log(db: Db, adminId: number, action: string, o: { siteId?: number | null; userId?: number | null; address?: string; reason?: string }): Promise<void> {
  await db.exec('INSERT INTO code_moderation (site_id, user_id, admin_id, action, address, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [o.siteId ?? null, o.userId ?? null, adminId, action, (o.address ?? '').slice(0, 100), (o.reason ?? '').slice(0, 200), date('Y-m-d H:i:s')]);
}

// So heißt die Seite in Meldungen (ohne Adresse: ihre Nummer)
const shown = (address: string, site: Row): string => (address !== '' ? '“' + address + '”' : 'Code page #' + intval(site.id));

const nameOf = (u: Row): string => (phpStr(u.full_name ?? '') !== '' ? phpStr(u.full_name) : phpStr(u.email));

// Unter der Platz-Sperre des Besitzers einer Code-Seite; die Seite FOR UPDATE neu gelesen
async function underOwner<T>(siteId: number, fn: (db: Db, site: Row) => Promise<T>): Promise<T | typeof NOT_FOUND> {
  const peek = await poolDb.one('SELECT user_id FROM code_sites WHERE id = ?', [siteId]);
  if (!peek) return NOT_FOUND;
  return withSlotLock(intval(peek.user_id), async (db) => {
    const site = await db.one('SELECT * FROM code_sites WHERE id = ? FOR UPDATE', [siteId]);
    if (!site || intval(site.user_id) !== intval(peek.user_id)) return NOT_FOUND;
    return fn(db, site);
  });
}

// $post wie $_POST. null = keine bekannte Aktion. adminId: wer handelt (fürs Protokoll)
export async function adminCodeHandle(post: PhpArray, adminId = 0): Promise<AdminResult> {
  const action = field(post, 'code_action');
  try {
    return await run(action, post, adminId);
  } catch (err) {
    if (err instanceof SlotBusyError) return { error: SLOT_BUSY_TEXT };
    // Konto während der Aktion gelöscht: bei Aktionen auf eine Seite ist die Seite weg
    if (err instanceof SlotGoneError) return ['ban', 'unban', 'unlock'].includes(action) ? NO_USER : NOT_FOUND;
    throw err;
  }
}

async function run(action: string, post: PhpArray, adminId: number): Promise<AdminResult> {
  const siteId = phpInt(post.site_id ?? 0);
  switch (action) {
    case 'settings': {
      // Leere Felder fehlen im Patch (ein Schlüssel mit undefined würde den gespeicherten Wert auf den Standard setzen)
      const patch: Partial<CodeSettings> = { paused: field(post, 'paused') === '1' };
      for (const k of ['max_on_pages', 'max_files', 'max_file_kb', 'max_total_kb'] as const) {
        if (field(post, k).trim() !== '') patch[k] = intval(field(post, k));
      }
      const s = await saveCodeSettings(patch);
      await log(poolDb, adminId, 'limits', { reason: `on pages ${s.max_on_pages}, files ${s.max_files}, ${s.max_file_kb} KB per file, ${s.max_total_kb} KB in total${s.paused ? ', paused' : ''}` });
      return { ok: 'Code page settings saved.' };
    }

    case 'block':
    case 'unblock': {
      const block = action === 'block';
      const reason = block ? cleanText(post.reason ?? '', 200) : '';
      return underOwner(siteId, async (db, site) => {
        const address = await addressOf(db, site);
        if (phpTruthy(site.is_blocked) === block) return { ok: shown(address, site) + ' ' + (block ? 'is already blocked.' : 'isn’t blocked.') };
        await db.exec('UPDATE code_sites SET is_blocked = ?, blocked_reason = ?, updated_at = ? WHERE id = ?',
          [block ? 1 : 0, reason !== '' ? reason : null, date('Y-m-d H:i:s'), intval(site.id)]);
        await log(db, adminId, action, { siteId: intval(site.id), userId: intval(site.user_id), address, reason });
        const link = '/dashboard?site=' + intval(site.id) + '#code';
        if (block) await notify(intval(site.user_id), 'code', 'Your code page was blocked', reason !== '' ? `${address || 'Your code page'}: ${reason}` : `${address || 'Your code page'} broke the rules for code pages.`, link, { db });
        else await notify(intval(site.user_id), 'code', 'Your code page is online again', address || 'Your code page', link, { db });
        return { ok: shown(address, site) + ' is ' + (block ? 'blocked.' : 'online again.') };
      });
    }

    case 'delete': {
      const reason = cleanText(post.reason ?? '', 200);
      const typed = field(post, 'confirm').trim().toLowerCase();
      let files: string[] = [];
      let owner = 0;
      const r = await underOwner(siteId, async (db, site) => {
        const address = await addressOf(db, site);
        // Ohne Adresse gibt es nichts zu tippen – so eine Seite wird nur gesperrt
        if (address === '') return { error: 'A code page without an address can’t be deleted here – block it instead.' };
        if (typed !== address) return { error: 'To delete it, type the address “' + address + '”.' };
        const onPage = !phpTruthy(site.slug);
        // Vom Team gelöscht: die eigene Adresse bleibt für niemanden reserviert (der Besitzer bekommt sie nicht zurück)
        files = [...await codeDeleteRows(db, site, 'nobody')];
        owner = intval(site.user_id);
        await log(db, adminId, 'delete', { siteId: intval(site.id), userId: owner, address, reason });
        await notify(owner, 'code', 'Your code page was deleted by the team', address + (reason !== '' ? ': ' + reason : ''), '/dashboard#code', { db });
        return { ok: shown(address, site) + ' was deleted' + (onPage ? ' – the address shows the link page again.' : '.') };
      });
      if ('ok' in r && owner > 0) await cleanupFiles(owner, files);
      return r;
    }

    case 'ban':
    case 'unban': {
      const uid = phpInt(post.user_id ?? 0);
      const exists = await poolDb.one('SELECT id FROM users WHERE id = ?', [uid]);
      if (!exists) return NO_USER;
      const ban = action === 'ban';
      const reason = ban ? cleanText(post.reason ?? '', 200) : '';
      return withSlotLock(uid, async (db, user) => {
        const name = nameOf(await db.one('SELECT full_name, email FROM users WHERE id = ?', [uid]) ?? user);
        if (phpTruthy(user.code_banned_at) === ban) return { ok: name + (ban ? ' already can’t use code pages.' : ' can already use code pages.') };
        await db.exec('UPDATE users SET code_banned_at = ?, code_ban_reason = ? WHERE id = ?', [ban ? date('Y-m-d H:i:s') : null, ban && reason !== '' ? reason : null, uid]);
        let blocked = 0;
        if (ban && field(post, 'block_all') === '1') {
          const res = await db.exec('UPDATE code_sites SET is_blocked = 1, blocked_reason = ?, updated_at = ? WHERE user_id = ? AND is_blocked = 0',
            [reason !== '' ? reason : null, date('Y-m-d H:i:s'), uid]);
          blocked = res.affectedRows;
        }
        await log(db, adminId, action, { userId: uid, reason: reason + (blocked ? ` (${blocked} blocked)` : '') });
        if (ban) await notify(uid, 'code', 'Code pages are turned off for your account', reason !== '' ? reason : 'Please contact us if you have questions.', '/dashboard#code', { db });
        else await notify(uid, 'code', 'You can use code pages again', '', '/dashboard#code', { db });
        if (!ban) {
          // Gesperrte Seiten bleiben gesperrt, bis sie einzeln entsperrt werden
          const still = intval(await db.value('SELECT COUNT(*) FROM code_sites WHERE user_id = ? AND is_blocked = 1', [uid]));
          return { ok: name + ' can use code pages again.' + (still ? ` ${still} code page${still === 1 ? ' stays' : 's stay'} blocked until you unblock ${still === 1 ? 'it' : 'them'}.` : '') };
        }
        return { ok: name + ' can no longer create or change code pages.' + (blocked ? ` ${blocked} code page${blocked === 1 ? '' : 's'} blocked.` : '') };
      });
    }

    case 'unlock': {
      // Ohne Honigwaben freischalten (z. B. für Tester): eine Buchung über 0, wie ein Kauf nur einmal je Konto
      const user = await poolDb.one('SELECT id, full_name, email FROM users WHERE id = ?', [phpInt(post.user_id ?? 0)]);
      if (!user) return NO_USER;
      const item = field(post, 'item', 'code_page');
      if (!CODE_UNLOCK_ITEMS.includes(item)) return { error: 'Please choose what to unlock.' };
      const name = nameOf(user);
      let booked: boolean;
      try {
        booked = await hcAdd(intval(user.id), 0, 'unlock', item, 'Unlocked by the team');
      } catch (err) {
        if (err instanceof HcBusyError) return { error: err.message };
        throw err;
      }
      const more = item === 'code_more';
      if (!booked) return { ok: name + (more ? ' had already unlocked more code pages.' : ' had already unlocked the code page.') };
      await log(poolDb, adminId, 'unlock', { userId: intval(user.id), reason: item });
      return { ok: (more ? 'More code pages unlocked for ' : 'Code page unlocked for ') + name + '.' };
    }
  }
  return null;
}

// Formulare von vor der Trennung (ein Admin-Tab, der seit dem Update offen ist): hc_action=code_block/code_unblock/
// code_unlock wird zur passenden code_action. Gilt ein Release lang; danach entfällt die Zuordnung.
const LEGACY: Readonly<Record<string, string>> = { code_block: 'block', code_unblock: 'unblock', code_unlock: 'unlock' };

export function legacyCodePost(post: PhpArray): PhpArray | null {
  const action = post.hc_action;
  if (typeof action !== 'string' || !Object.hasOwn(LEGACY, action)) return null;
  const mapped: PhpArray = { ...post, code_action: LEGACY[action] };
  delete mapped.hc_action;
  if (action === 'code_unlock') mapped.item = 'code_page';
  return mapped;
}
