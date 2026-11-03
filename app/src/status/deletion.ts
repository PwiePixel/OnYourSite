// Konto löschen, Teil „status“ (Haken 20 in admin/accountDeletion.ts, ROADMAP §3.9 / ST-4): die Statusseite des Kontos
// mit Bestandteilen, Vorfällen, Discord-Beiträgen, Kanälen, offenen Benachrichtigungen und Weiterleitungen. Messwerte
// (state, checks, events, hourly, daily) räumt der Prüfdienst über status_purge auf. Die Adresse gibt der Haken
// „addresses“ frei (Statusseiten bleiben 90 Tage für niemanden reserviert). OnYourSites eigene Seite (is_system) bleibt
// immer stehen, auch wenn ein Admin-Konto gelöscht wird.
import type { Db } from '../db.js';
import { deleteIncidentRows } from './incidents.js';
import { bumpGlobalRev } from './model.js';

export async function deleteUserStatus(db: Db, uid: number): Promise<void> {
  const pages = await db.q('SELECT id FROM status_pages WHERE user_id = ? AND is_system = 0 FOR UPDATE', [uid]);
  if (!pages.length) return;
  const t = Math.floor(Date.now() / 1000);
  for (const p of pages) {
    const pageId = Number(p.id);
    for (const inc of await db.q('SELECT id FROM status_incidents WHERE page_id = ?', [pageId])) {
      await db.exec('DELETE FROM status_incident_posts WHERE incident_id = ?', [Number(inc.id)]);
      await deleteIncidentRows(db, Number(inc.id));
    }
    for (const m of await db.q('SELECT id FROM status_monitors WHERE page_id = ?', [pageId])) {
      await db.exec('DELETE FROM status_run_requests WHERE monitor_id = ?', [Number(m.id)]);
      await db.exec("INSERT INTO status_purge (kind, ref_id, created_at) VALUES ('monitor', ?, ?)", [Number(m.id), t]);
    }
    await db.exec('DELETE FROM status_monitors WHERE page_id = ?', [pageId]);
    await db.exec('DELETE FROM status_channels WHERE page_id = ?', [pageId]);
    await db.exec('DELETE FROM status_outbox WHERE page_id = ?', [pageId]);
    await db.exec('DELETE FROM status_slug_redirects WHERE page_id = ?', [pageId]);
    await db.exec("INSERT INTO status_purge (kind, ref_id, created_at) VALUES ('page', ?, ?)", [pageId, t]);
    await db.exec('DELETE FROM status_pages WHERE id = ? AND is_system = 0', [pageId]);
  }
  await bumpGlobalRev(db);
}
