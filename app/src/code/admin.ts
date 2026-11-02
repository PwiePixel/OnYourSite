// Admin, Bereich „Code pages“ (POST code_action): Code-Seiten sperren und entsperren, Code-Seiten ohne Honigwaben
// freischalten. Bis zur Trennung lagen diese Aktionen als hc_action=code_* im Honigwaben-Teil – Prüfungen, Texte und
// Schreibvorgänge sind unverändert übernommen.
import { date, field, intval, phpStr, type PhpArray } from '../php.js';
import { cleanText } from '../helpers.js';
import { hcAdd, type AdminResult } from '../honeycombs/honeycombs.js';
import { phpInt, poolDb } from '../honeycombs/util.js';
import { codeAddress, codeSiteById, slotOfSite } from './sites.js';

// Was sich im Admin freischalten lässt (weitere Code-Seiten kommen mit den Code-Seiten-Plätzen dazu)
export const CODE_UNLOCK_ITEMS: readonly string[] = ['code_page'];

// $post wie $_POST. null = keine bekannte Aktion.
export async function adminCodeHandle(post: PhpArray): Promise<AdminResult> {
  const action = field(post, 'code_action');
  switch (action) {
    case 'block':
    case 'unblock': {
      const site = await codeSiteById(phpInt(post.site_id ?? 0));
      if (!site) return { error: 'Code page not found.' };
      const block = action === 'block';
      const reason = block ? cleanText(post.reason ?? '', 200) : '';
      await poolDb.exec('UPDATE code_sites SET is_blocked = ?, blocked_reason = ?, updated_at = ? WHERE id = ?',
        [block ? 1 : 0, reason !== '' ? reason : null, date('Y-m-d H:i:s'), intval(site.id)]);
      // Die Adresse, unter der die Code-Seite zu sehen ist (auf einem Seitenplatz dessen Adresse)
      const address = codeAddress(site, await slotOfSite(intval(site.id)))?.slug ?? phpStr(site.slug);
      return { ok: block ? '“' + address + '” is blocked.' : '“' + address + '” is online again.' };
    }

    case 'unlock': {
      // Ohne Honigwaben freischalten (z. B. für Tester): eine Buchung über 0, wie ein Kauf nur einmal je Konto
      const user = await poolDb.one('SELECT id, full_name, email FROM users WHERE id = ?', [phpInt(post.user_id ?? 0)]);
      if (!user) return { error: 'Please choose a user.' };
      if (!CODE_UNLOCK_ITEMS.includes(field(post, 'item', 'code_page'))) return { error: 'Please choose what to unlock.' };
      const name = phpStr(user.full_name ?? '') !== '' ? phpStr(user.full_name) : phpStr(user.email);
      if (!(await hcAdd(intval(user.id), 0, 'unlock', 'code_page', 'Unlocked by the team'))) {
        return { ok: name + ' had already unlocked the code page.' };
      }
      return { ok: 'Code page unlocked for ' + name + '.' };
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
