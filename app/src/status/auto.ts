// Statusseiten: was der Prüfdienst an Vorfällen selbst tut (Entwurf §4.8.10), alle 30 s und nach einem „up“:
// - Wartungen beginnen und enden zur geplanten Zeit (mit einem automatischen Update);
// - automatische Vorfälle: ist ein öffentlicher Bestandteil länger als settings.auto_incident (z. B. 5 min) „down“
//   (nicht in einer Wartung, nicht flatternd, Sperre offen), öffnet sich ein Vorfall – oder der Bestandteil kommt zu
//   einem gerade (< 10 min) eröffneten, unveränderten automatischen Vorfall dazu. Sind alle Bestandteile wieder da oder
//   nicht mehr geprüft, schließt er sich – außer der Besitzer hat darin geschrieben (auto_edited): dann ein Update
//   „monitoring“ und der Besitzer schließt ihn.
// Jede Änderung läuft in einer eigenen Transaktion mit gesperrter Seite (Reihenfolge Seite → Vorfall → Beiträge) und
// setzt rev/status_rev; Schreibzugriffe auf automatische Vorfälle prüfen auto_edited und resolved_at (compare-and-set).
import { transaction, withConnection, type Db } from '../db.js';
import { date } from '../php.js';
import { addIncidentUpdate, autoTexts, createIncident, loadIncident, loadIncidents, type Incident } from './incidents.js';
import { bumpRev, lockStatusPage, pageFromRow } from './model.js';
import { syncIncidentPosts } from './posts.js';

export interface AutoMonitor {
  id: number;
  pageId: number;
  name: string;
  isPublic: boolean;
  state: 'unknown' | 'up' | 'degraded' | 'down';
  since: number | null;
  flapping: boolean;
  monitored: boolean; // läuft (nicht pausiert, nicht über der Grenze, Seite nicht gesperrt …)
  maintenance: boolean;
  gateExempt?: boolean; // OnYourSites eigene Bestandteile: die Plattform-Sperre gilt für sie nicht (Entwurf §4.8.15)
}

export interface AutoPage {
  id: number;
  autoIncident: number; // Sekunden „down“ bis zum Vorfall (0 = aus)
}

const JOIN_WINDOW = 600; // ein automatischer Vorfall nimmt 10 Minuten lang weitere Bestandteile auf
const PAGE_COLUMNS = 'id, user_id, is_system, slug, title, description, theme, settings, is_published, is_blocked, blocked_reason, review_note, reviewed_at, rev, created_at';

async function pageRow(db: Db, pageId: number) {
  const r = await db.one(`SELECT ${PAGE_COLUMNS} FROM status_pages WHERE id = ?`, [pageId]);
  return r ? pageFromRow(r) : null;
}

// ---------------------------------------------------------------- Wartungen

export interface MaintenanceChange {
  incidentId: number;
  pageId: number;
  ended: boolean;
  monitorIds: number[];
}

export async function maintenanceRound(now: number): Promise<MaintenanceChange[]> {
  const due = await withConnection((db) => db.q(`SELECT id, page_id, status, starts_at, ends_at FROM status_incidents
      WHERE kind = 'maintenance' AND resolved_at IS NULL AND ((status = 'scheduled' AND starts_at <= ?) OR (status IN ('scheduled', 'in_progress') AND ends_at <= ?))
      ORDER BY starts_at LIMIT 200`, [now, now]));
  const out: MaintenanceChange[] = [];
  for (const r of due) {
    const pageId = Number(r.page_id);
    const id = Number(r.id);
    const change = await transaction(async (_conn, db) => {
      if (!(await lockStatusPage(db, pageId))) return null;
      const inc = await loadIncident(db, pageId, id, true);
      if (!inc || inc.resolvedAt !== null) return null;
      const end = inc.endsAt !== null && inc.endsAt <= now;
      if (end) {
        const res = await db.exec("UPDATE status_incidents SET status = 'completed', resolved_at = ?, updated_at = ? WHERE id = ? AND status IN ('scheduled', 'in_progress') AND resolved_at IS NULL",
          [now, date('Y-m-d H:i:s', now), id]);
        if (!res.affectedRows) return null;
        await db.exec('INSERT INTO status_incident_updates (incident_id, status, body, is_auto, created_at) VALUES (?, ?, ?, 1, ?)', [id, 'completed', autoTexts.maintenanceDone, now]);
      } else {
        const res = await db.exec("UPDATE status_incidents SET status = 'in_progress', updated_at = ? WHERE id = ? AND status = 'scheduled'", [date('Y-m-d H:i:s', now), id]);
        if (!res.affectedRows) return null;
        await db.exec('INSERT INTO status_incident_updates (incident_id, status, body, is_auto, created_at) VALUES (?, ?, ?, 1, ?)', [id, 'in_progress', autoTexts.maintenanceStarted, now]);
      }
      const page = await pageRow(db, pageId);
      if (page) await syncIncidentPosts(db, page, id);
      await bumpRev(db, pageId, now);
      return { incidentId: id, pageId, ended: end, monitorIds: inc.monitors.map((m) => m.id) };
    });
    if (change) out.push(change);
  }
  return out;
}

// ---------------------------------------------------------------- Automatische Vorfälle

// Nur zu öffnen, wenn er lange genug unten ist und nichts dagegen spricht
function opensIncident(m: AutoMonitor, page: AutoPage, gateOk: boolean, now: number): boolean {
  return page.autoIncident > 0 && gateOk && m.isPublic && m.monitored && !m.maintenance && !m.flapping && m.state === 'down'
    && m.since !== null && now - m.since >= page.autoIncident;
}

export interface AutoRoundResult {
  opened: number[];
  resolved: number[];
  changedPages: number[];
}

export async function autoIncidentRound(pages: ReadonlyMap<number, AutoPage>, monitors: readonly AutoMonitor[], gate: 'ok' | 'hold' | 'frozen', now: number): Promise<AutoRoundResult> {
  const result: AutoRoundResult = { opened: [], resolved: [], changedPages: [] };
  const byId = new Map(monitors.map((m) => [m.id, m]));
  // Offene Vorfälle (alle Seiten): welche Bestandteile schon einen haben, und die automatischen zum Schließen
  const open = await withConnection((db) => loadIncidents(db, "kind = 'incident' AND resolved_at IS NULL", [], { order: 'id' }));
  const covered = new Set<number>();
  for (const inc of open) for (const m of inc.monitors) covered.add(m.id);
  const changed = new Set<number>();

  // Öffnen bzw. dazunehmen
  const candidates = new Map<number, AutoMonitor[]>();
  for (const m of monitors) {
    const page = pages.get(m.pageId);
    if (!page || covered.has(m.id) || !opensIncident(m, page, gate === 'ok' || m.gateExempt === true, now)) continue;
    const list = candidates.get(m.pageId);
    if (list) list.push(m);
    else candidates.set(m.pageId, [m]);
  }
  for (const [pageId, list] of candidates) {
    const touched = await transaction(async (_conn, db) => {
      if (!(await lockStatusPage(db, pageId))) return false;
      const page = await pageRow(db, pageId);
      if (!page) return false;
      // Innerhalb der Sperre noch einmal: hat inzwischen jemand einen Vorfall dafür eröffnet?
      const fresh = await loadIncidents(db, "page_id = ? AND kind = 'incident' AND resolved_at IS NULL", [pageId], { order: 'id' });
      const taken = new Set<number>();
      for (const inc of fresh) for (const mm of inc.monitors) taken.add(mm.id);
      let target: Incident | undefined = fresh.filter((i) => i.isAuto && !i.autoEdited && now - i.startsAt < JOIN_WINDOW).pop();
      let any = false;
      for (const m of list) {
        if (taken.has(m.id)) continue;
        if (!target) {
          const id = await createIncident(db, pageId, {
            kind: 'incident', title: autoTexts.title(m.name), status: 'investigating', impact: 'major', startsAt: now, endsAt: null,
            monitors: [{ id: m.id, effect: 'major' }], body: autoTexts.opened(m.name),
          }, null, now, { auto: true });
          result.opened.push(id);
          target = (await loadIncident(db, pageId, id)) ?? undefined;
          await syncIncidentPosts(db, page, id, { post: true });
        } else {
          // Nur solange niemand eingegriffen hat (compare-and-set)
          const res = await db.exec("UPDATE status_incidents SET title = ?, updated_at = ? WHERE id = ? AND is_auto = 1 AND auto_edited = 0 AND resolved_at IS NULL",
            [autoTexts.several, date('Y-m-d H:i:s', now), target.id]);
          if (!res.affectedRows) continue;
          await db.exec("INSERT IGNORE INTO status_incident_monitors (incident_id, monitor_id, effect) VALUES (?, ?, 'major')", [target.id, m.id]);
          await db.exec("INSERT INTO status_incident_updates (incident_id, status, body, is_auto, created_at) VALUES (?, 'investigating', ?, 1, ?)", [target.id, autoTexts.joined(m.name), now]);
          await syncIncidentPosts(db, page, target.id);
        }
        taken.add(m.id);
        any = true;
      }
      if (any) await bumpRev(db, pageId, now);
      return any;
    });
    if (touched) changed.add(pageId);
  }

  // Schließen: jeder Bestandteil ist wieder da oder wird nicht mehr geprüft. Eine eingefrorene Sperre ist kein „nicht
  // mehr geprüft“ – dann wird gewartet.
  for (const inc of open.filter((i) => i.isAuto)) {
    // Eingefroren: warten – außer alle Bestandteile sind von der Sperre ausgenommen
    if (gate === 'frozen' && inc.monitors.some((im) => byId.get(im.id)?.gateExempt !== true)) continue;
    const states = inc.monitors.map((im) => {
      const m = byId.get(im.id);
      const unmonitored = !m || !m.monitored;
      return { im, back: !!m && m.monitored && m.state !== 'down' && m.state !== 'unknown', unmonitored };
    });
    const newlyUnmonitored = states.filter((s) => s.unmonitored);
    // Ohne verbliebene Bestandteile (alle gelöscht) wird nichts mehr geprüft: auch dann schließt er sich
    const done = states.every((s) => s.back || s.unmonitored);
    if (!newlyUnmonitored.length && !done) continue;
    const touched = await transaction(async (_conn, db) => {
      if (!(await lockStatusPage(db, inc.pageId))) return false;
      const cur = await loadIncident(db, inc.pageId, inc.id, true);
      if (!cur || cur.resolvedAt !== null) return false;
      const page = await pageRow(db, inc.pageId);
      if (!page) return false;
      let any = false;
      // „{Name} is no longer monitored.“ – je Bestandteil einmal
      for (const s of newlyUnmonitored) {
        const text = autoTexts.unmonitored(s.im.name);
        if (cur.updates.some((u) => u.isAuto && u.body === text)) continue;
        await db.exec('INSERT INTO status_incident_updates (incident_id, status, body, is_auto, created_at) VALUES (?, ?, ?, 1, ?)', [cur.id, cur.status, text, now]);
        any = true;
      }
      if (done) {
        const allBack = states.every((s) => s.back);
        const noneChecked = states.every((s) => s.unmonitored);
        const text = noneChecked ? autoTexts.closedUnmonitored : allBack ? (states.length === 1 ? autoTexts.back(states[0].im.name) : autoTexts.allBack) : autoTexts.mixedBack;
        if (!cur.autoEdited) {
          const res = await db.exec("UPDATE status_incidents SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ? AND auto_edited = 0 AND resolved_at IS NULL",
            [now, date('Y-m-d H:i:s', now), cur.id]);
          if (res.affectedRows) {
            await db.exec("INSERT INTO status_incident_updates (incident_id, status, body, is_auto, created_at) VALUES (?, 'resolved', ?, 1, ?)", [cur.id, text, now]);
            result.resolved.push(cur.id);
            any = true;
          }
        } else {
          // Der Besitzer hat eingegriffen: nur melden (einmal), schließen tut er selbst
          const last = cur.updates[cur.updates.length - 1];
          if (!(last && last.isAuto && last.status === 'monitoring')) {
            await addIncidentUpdate(db, cur, 'monitoring', text, null, now, true);
            any = true;
          }
        }
      }
      if (any) {
        await syncIncidentPosts(db, page, cur.id);
        await bumpRev(db, cur.pageId, now);
      }
      return any;
    });
    if (touched) changed.add(inc.pageId);
  }
  result.changedPages = [...changed];
  return result;
}
