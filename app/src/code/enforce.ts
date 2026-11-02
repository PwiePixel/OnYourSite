// Abgleich der Code-Seiten mit den Freischaltungen (Vertrag registerEnforcer des Shops): läuft unter der Platz-Sperre
// des Kontos – derselben Sperre wie alle Änderungen an Plätzen und Code-Seiten – und hält nur deren Verbindung.
// Wiederholbar: ein zweiter Lauf findet nichts mehr zu tun. Dateien bleiben immer erhalten.
// - code_page nicht mehr vorhanden (Erstattung oder Entzug – dann gibt es eine Zeile ohne aktive Menge): alle
//   Code-Seiten des Kontos gehen offline. Nach einer neuen Freischaltung kann der Nutzer sie wieder einschalten. Ein
//   Konto ohne jede code_page-Zeile (nie gehabt, z. B. alte Daten) behält seine Seiten – der Abgleich läuft auch nach
//   Käufen, die mit Code-Seiten nichts zu tun haben.
// - code_more erstattet/entzogen (eine Zeile ohne aktive Menge – nicht eine Preisänderung): die neuesten Code-Seiten
//   über der ersten gehen offline (D11). Wer code_more nie hatte (Preis 0), behält alle.
// Premium ändert an Seiten- und Code-Seiten-Grenzen nichts (Q1 = b) und läuft hier nicht mit.
import { intval } from '../php.js';
import { registerEnforcer } from '../honeycombs/reconcile.js';
import { has } from '../honeycombs/entitlements.js';
import { SlotGoneError, withSlotLock } from './slots.js';

// Ergebnis für Tests und Protokoll: wie viele Code-Seiten offline gingen
export async function enforceSlots(uid: number): Promise<number> {
  try {
    return await withSlotLock(uid, async (db) => {
      const online = await db.q('SELECT id FROM code_sites WHERE user_id = ? AND is_published = 1 ORDER BY id FOR UPDATE', [uid]);
      if (!online.length) return 0;
      let off: number[] = [];
      if (!(await has(uid, 'code_page', db))) {
        const pageLots = intval(await db.value("SELECT COUNT(*) FROM hc_entitlements WHERE user_id = ? AND feature = 'code_page'", [uid]));
        if (pageLots > 0) off = online.map((r) => intval(r.id));
      } else {
        const lots = intval(await db.value("SELECT COUNT(*) FROM hc_entitlements WHERE user_id = ? AND feature = 'code_more'", [uid]));
        if (lots > 0 && !(await has(uid, 'code_more', db))) {
          // Die älteste Code-Seite (auch offline) ist durch code_page gedeckt; alle anderen, die online sind, gehen offline
          const first = intval(await db.value('SELECT MIN(id) FROM code_sites WHERE user_id = ?', [uid]));
          off = online.map((r) => intval(r.id)).filter((id) => id !== first);
        }
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
