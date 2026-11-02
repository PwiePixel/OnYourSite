// Abgleich der Code-Seiten mit den Freischaltungen (Vertrag registerEnforcer des Shops): läuft unter der Platz-Sperre
// des Kontos – derselben Sperre wie alle Änderungen an Plätzen und Code-Seiten – und hält nur deren Verbindung.
// Wiederholbar: ein zweiter Lauf findet nichts mehr zu tun. Dateien bleiben immer erhalten.
// - code_page nicht mehr vorhanden (Erstattung oder Entzug – dann gibt es eine Zeile ohne aktive Menge): alle
//   Code-Seiten des Kontos gehen offline. Nach einer neuen Freischaltung kann der Nutzer sie wieder einschalten. Ein
//   Konto ohne jede code_page-Zeile (nie gehabt, z. B. alte Daten) behält seine Seiten – der Abgleich läuft auch nach
//   Käufen, die mit Code-Seiten nichts zu tun haben.
// - code_more erstattet/entzogen (eine Zeile ohne aktive Menge – nicht eine Preisänderung), solange weitere Code-Seiten
//   etwas kosten: die neuesten Code-Seiten über der ersten gehen offline (D11). Wer code_more nie hatte, behält alle;
//   bei Preis 0 sind weitere Code-Seiten für alle frei (freeAtZero), dann bleibt ebenfalls alles online.
// Dieselbe Regel gilt für den Online-Schalter des Editors (mustStayOffline) – sonst schaltet der Nutzer die Seiten
// gleich wieder ein und behält, was erstattet wurde.
// Premium ändert an Seiten- und Code-Seiten-Grenzen nichts (Q1 = b) und läuft hier nicht mit.
import type { Db } from '../db.js';
import { intval } from '../php.js';
import { registerEnforcer } from '../honeycombs/reconcile.js';
import { has } from '../honeycombs/entitlements.js';
import { shopPrice } from '../honeycombs/catalogue.js';
import { poolDb } from '../honeycombs/util.js';
import { SlotGoneError, withSlotLock } from './slots.js';

// Welche Code-Seiten eines Kontos nach dem Verlust einer Freischaltung offline bleiben: 'all' (code_page verloren),
// 'newer' (code_more verloren, solange es etwas kostet: alle außer der ältesten) oder null (keine Einschränkung)
async function lostUnlock(db: Db, uid: number): Promise<'all' | 'newer' | null> {
  const lots = async (feature: string): Promise<number> =>
    intval(await db.value('SELECT COUNT(*) FROM hc_entitlements WHERE user_id = ? AND feature = ?', [uid, feature]));
  if (!(await has(uid, 'code_page', db))) return (await lots('code_page')) > 0 ? 'all' : null;
  if ((await lots('code_more')) > 0 && !(await has(uid, 'code_more', db)) && (await shopPrice('code_more', uid, db)) > 0) return 'newer';
  return null;
}

// Älteste Code-Seite des Kontos (auch offline) – sie ist durch code_page gedeckt
const oldestSite = async (db: Db, uid: number): Promise<number> =>
  intval(await db.value('SELECT MIN(id) FROM code_sites WHERE user_id = ?', [uid]));

// Darf diese Code-Seite nicht online gehen? (Online-Schalter; db = Verbindung des Aufrufers, Zeile vorher gesperrt)
export async function mustStayOffline(uid: number, siteId: number, db: Db = poolDb): Promise<boolean> {
  const rule = await lostUnlock(db, uid);
  return rule === 'all' || (rule === 'newer' && siteId !== (await oldestSite(db, uid)));
}

// Ergebnis für Tests und Protokoll: wie viele Code-Seiten offline gingen
export async function enforceSlots(uid: number): Promise<number> {
  try {
    return await withSlotLock(uid, async (db) => {
      const online = await db.q('SELECT id FROM code_sites WHERE user_id = ? AND is_published = 1 ORDER BY id FOR UPDATE', [uid]);
      if (!online.length) return 0;
      let off: number[] = [];
      const rule = await lostUnlock(db, uid);
      if (rule === 'all') off = online.map((r) => intval(r.id));
      if (rule === 'newer') {
        // Die älteste Code-Seite (auch offline) ist durch code_page gedeckt; alle anderen, die online sind, gehen offline
        const first = await oldestSite(db, uid);
        off = online.map((r) => intval(r.id)).filter((id) => id !== first);
      }
      if (!off.length) return 0;
      await db.exec(`UPDATE code_sites SET is_published = 0 WHERE user_id = ? AND id IN (${off.map(() => '?').join(', ')})`, [uid, ...off]);
      return off.length;
    });
  } catch (err) {
    // Konto inzwischen gelöscht: nichts mehr abzugleichen
    if (err instanceof SlotGoneError) return 0;
    throw err;
  }
}

registerEnforcer({
  name: 'code-slots',
  features: ['code_page', 'code_more'],
  inline: true,
  run: async (uid) => { await enforceSlots(uid); },
});
