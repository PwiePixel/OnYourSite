// Abgleich mit den anderen Bereichen (Domains, Code-Seiten, Statusseiten): Jede Änderung dessen, was ein Konto besitzt,
// setzt in DERSELBEN Transaktion einen Merker (markReconcile). Nach dem Commit laufen die schnellen Abgleiche einmal
// (reconcileNow); der Hintergrundjob versucht alle anderen und alle fehlgeschlagenen erneut. So geht nach einem
// Absturz, einer belegten Sperre oder einem Fehler nichts verloren.
//
// Vertrag für einen Abgleich (Enforcer): Er liest den aktuellen Stand unter seiner EIGENEN Sperre je Konto und bringt
// seine Objekte in Ordnung; er hält höchstens eine Verbindung und läuft nie, solange der Aufrufer eine hält. Er ist
// wiederholbar – auch mit seinen Folgen: ein zweiter Lauf schreibt keine Glocke und keine Mail. Hinweise an den Nutzer
// gibt es nur zusammen mit einem Übergang, den der Bereich in seinen eigenen Zeilen festhält.
import { exec, outsidePinned, value, type Db } from '../db.js';
import { intval, mbSubstr } from '../php.js';
import { nowStr } from './clock.js';
import { pausePoint } from './ledger.js';

export interface Enforcer {
  name: string;
  features: readonly string[] | '*'; // betroffene Funktionen (zur Übersicht; laufen tun bei einem Abgleich alle)
  inline: boolean; // false: langsam (z. B. Cloudflare) – läuft nur im Job
  run: (uid: number) => Promise<void>;
}

const enforcers: Enforcer[] = [];

export function registerEnforcer(e: Enforcer): void {
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(e.name)) throw new Error(`registerEnforcer: invalid name ${e.name}`);
  if (enforcers.some((x) => x.name === e.name)) throw new Error(`registerEnforcer: ${e.name} is registered twice`);
  enforcers.push(e);
}

export const registeredEnforcers = (): Array<{ name: string; inline: boolean }> => enforcers.map((e) => ({ name: e.name, inline: e.inline }));

export function unregisterEnforcerForTests(name: string): void {
  const i = enforcers.findIndex((e) => e.name === name);
  if (i >= 0) enforcers.splice(i, 1);
}

// Merker setzen – immer in der Transaktion der Änderung. reconcile_gen zählt jede Änderung: Der Merker wird nur
// gelöscht, wenn sich seit dem Start des Abgleichs nichts mehr geändert hat.
export async function markReconcile(db: Db, uid: number, now: string = nowStr()): Promise<void> {
  await db.exec(`INSERT INTO hc_accounts (user_id, reconcile_at, reconcile_gen, created_at, updated_at) VALUES (?, ?, 1, ?, ?)
      ON DUPLICATE KEY UPDATE reconcile_at = COALESCE(reconcile_at, VALUES(reconcile_at)), reconcile_gen = reconcile_gen + 1, updated_at = VALUES(updated_at)`,
  [uid, now, now, now]);
}

// Abgleich jetzt – nach dem Commit, ohne gehaltene Verbindung (läuft deshalb außerhalb des laufenden Abschnitts).
// inlineOnly: nur die schnellen Abgleiche (Anfragen); der Merker bleibt dann für den Job, falls es langsame gibt.
// Wirft nie: Fehler werden protokolliert und beim Konto vermerkt (der Käufer sieht sie nicht). true = alles erledigt.
export async function reconcileNow(uid: number, opts: { inlineOnly?: boolean } = {}): Promise<boolean> {
  return outsidePinned(async () => {
    try {
      const gen = await value('SELECT reconcile_gen FROM hc_accounts WHERE user_id = ? AND reconcile_at IS NOT NULL', [uid]);
      if (gen === null) return true;
      let firstError = '';
      let skipped = false;
      for (const e of [...enforcers]) {
        if (opts.inlineOnly && !e.inline) {
          skipped = true;
          continue;
        }
        try {
          await pausePoint('enforcer', { uid, name: e.name });
          await e.run(uid);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`honeycombs: reconcile "${e.name}" for #${uid} failed: ${msg}`);
          firstError ||= `${e.name}: ${msg}`;
        }
      }
      const now = nowStr();
      if (firstError) {
        await exec('UPDATE hc_accounts SET reconcile_tries = LEAST(reconcile_tries + 1, 65535), reconcile_error = ?, updated_at = ? WHERE user_id = ?',
          [mbSubstr(firstError, 0, 200), now, uid]);
        return false;
      }
      if (skipped) return false;
      // Nur löschen, wenn inzwischen nichts Neues dazukam (sonst bleibt der Merker für den nächsten Lauf)
      const res = await exec("UPDATE hc_accounts SET reconcile_at = NULL, reconcile_tries = 0, reconcile_error = '', updated_at = ? WHERE user_id = ? AND reconcile_gen = ?",
        [now, uid, intval(gen)]);
      return res.affectedRows > 0;
    } catch (err) {
      console.error(`honeycombs: reconcile for #${uid} failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  });
}
