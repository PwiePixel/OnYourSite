// Konto löschen – alles oder nichts. Jede Funktion, die Daten eines Kontos hält, meldet sich mit
// registerUserDeletion({ name, order, run }) an (in ihrem eigenen Modul, das beim Start geladen wird). deleteAccount()
// führt alle Haken nach `order` sortiert in EINER Transaktion auf EINER Verbindung aus: Schlägt einer fehl, bleibt jede
// Zeile, wie sie war. Ein Haken arbeitet nur über `db` und greift nie ins Netz; Dateien und Ähnliches meldet er mit
// afterCommit() an – das läuft erst, wenn alles gelöscht ist.
//
// Reihenfolge (ROADMAP §3.9): 10 domains · 20 status · 30 code · 40 honeycombs · 50 pages · 60 account data ·
// 70 addresses · 99 user. Die Haken des Kerns stehen unten.
import { unlinkSync } from 'node:fs';
import { transaction, type Db } from '../db.js';
import type { Ctx } from '../web/ctx.js';
import { phpStr } from '../php.js';
import { cleanupFiles, deletePage, userPages } from '../content/pages.js';
import { codeDeleteUser } from '../code/sites.js';
import { hcDeleteUser } from '../honeycombs/deletion.js';
import { userUploadFiles } from '../content/uploads.js';
import { uploadPath } from '../content/storage.js';
import { releaseUserAddresses } from '../content/addresses.js';

export interface DeletionRun {
  // Arbeit nach dem Commit (Dateien aufräumen …) – läuft nur, wenn das Konto wirklich gelöscht wurde
  afterCommit(fn: () => Promise<void> | void): void;
}

export interface UserDeletionHook {
  name: string;
  order: number;
  run(db: Db, uid: number, deletion: DeletionRun): Promise<void>;
}

// Ein Haken ist fehlgeschlagen – nichts wurde gelöscht
export class AccountDeletionError extends Error {
  constructor(readonly hook: string, readonly reason: unknown) {
    super(`account deletion failed in "${hook}": ${reason instanceof Error ? reason.message : String(reason)}`);
  }
}

const hooks: UserDeletionHook[] = [];

export function registerUserDeletion(hook: UserDeletionHook): void {
  if (!/^[a-z][a-z0-9 _-]{0,39}$/.test(hook.name)) throw new Error(`invalid account deletion hook name: ${hook.name}`);
  if (!Number.isInteger(hook.order)) throw new Error(`account deletion hook "${hook.name}" needs an integer order`);
  if (hooks.some((h) => h.name === hook.name)) throw new Error(`account deletion hook "${hook.name}" is registered twice`);
  hooks.push(hook);
  // Stabil: gleiche Nummern bleiben in der Reihenfolge der Anmeldung
  hooks.sort((a, b) => a.order - b.order);
}

// Für Tests und die Fehlersuche: welche Haken in welcher Reihenfolge laufen
export function userDeletionHooks(): Array<{ name: string; order: number }> {
  return hooks.map((h) => ({ name: h.name, order: h.order }));
}

// Für Tests: einen Haken wieder abmelden
export function unregisterUserDeletionForTests(name: string): void {
  const i = hooks.findIndex((h) => h.name === name);
  if (i >= 0) hooks.splice(i, 1);
}

// Konto mit allem löschen. Ein unbekanntes Konto ist kein Fehler (wie bisher: es wird nur nichts gefunden).
export async function deleteAccount(ctx: Ctx | null, uid: number): Promise<void> {
  const after: Array<() => Promise<void> | void> = [];
  const deletion: DeletionRun = { afterCommit: (fn) => void after.push(fn) };
  try {
    await transaction(async (_conn, db) => {
      // Sperrreihenfolge wie überall: zuerst das Konto (users → pages → code_sites → status_pages → site_addresses).
      // Laufende Änderungen desselben Kontos (Plätze, Honigwaben) sind damit vorher fertig oder warten.
      await db.q('SELECT id FROM users WHERE id = ? FOR UPDATE', [uid]);
      for (const hook of hooks) {
        try {
          await hook.run(db, uid, deletion);
        } catch (err) {
          throw new AccountDeletionError(hook.name, err);
        }
      }
    });
  } catch (err) {
    const by = ctx?.session?.get('user_id');
    console.error(`Deleting account #${uid}${by !== undefined && by !== null ? ` (by #${phpStr(by)})` : ''} was rolled back: `
      + (err instanceof Error ? err.message : String(err)));
    throw err;
  }
  for (const fn of after) {
    try {
      await fn();
    } catch (err) {
      // Das Konto ist schon weg – übrig gebliebene Dateien sind kein Grund für eine Fehlermeldung
      console.error(`Clean-up after deleting account #${uid} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ---------------------------------------------------------------- Haken des Kerns

// Code-Seite mit Dateien
registerUserDeletion({
  name: 'code',
  order: 30,
  run: (db, uid) => codeDeleteUser(uid, db),
});

// Honigwaben: Buchungen, Berechtigungen und Shop-Zeilen (das Protokoll verliert nur den Bezug zum Konto). Angemeldet
// hier und nicht im Shop: Dieses Modul lädt den Shop schon über code/sites.ts – eine Anmeldung dort liefe, bevor es
// die Liste der Haken gibt. So ist der Haken überall da, wo Konten gelöscht werden.
registerUserDeletion({
  name: 'honeycombs',
  order: 40,
  run: (db, uid) => hcDeleteUser(uid, db),
});

// Alle Profilseiten mit Blöcken, Statistik und Nachrichten; ihre Dateien nach dem Commit
registerUserDeletion({
  name: 'pages',
  order: 50,
  run: async (db, uid, deletion) => {
    const files: unknown[] = [];
    for (const page of await userPages(uid)) files.push(...(await deletePage(page, db)));
    deletion.afterCommit(() => cleanupFiles(uid, files));
  },
});

// Übrige Daten des Kontos (auch aus den alten Tabellen). Community-Daten bleiben (wie bisher).
registerUserDeletion({
  name: 'account data',
  order: 60,
  run: async (db, uid) => {
    for (const table of ['notifications', 'messages', 'user_links', 'user_bookings', 'user_certificates']) {
      await db.exec(`DELETE FROM ${table} WHERE user_id = ?`, [uid]);
    }
  },
});

// Adressen des Kontos: für niemanden reserviert (Link- und Code-Seiten 30 Tage, wenn sie mindestens 7 Tage benutzt
// wurden, Statusseiten 90 Tage) – ohne Bezug zur Person (content/addresses.ts)
registerUserDeletion({
  name: 'addresses',
  order: 70,
  run: (db, uid) => releaseUserAddresses(db, uid),
});

// Zuletzt das Konto selbst; danach alles, was noch im Upload-Ordner liegt (z. B. Bilder der Code-Seite)
registerUserDeletion({
  name: 'user',
  order: 99,
  run: async (db, uid, deletion) => {
    await db.exec('DELETE FROM users WHERE id = ?', [uid]);
    deletion.afterCommit(() => {
      for (const name of userUploadFiles(uid).keys()) {
        try {
          unlinkSync(uploadPath(name));
        } catch {
          // wie @unlink: Fehler still übergehen
        }
      }
    });
  },
});
