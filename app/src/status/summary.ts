// Statusseiten: /summary.json (Entwurf §4.4) – für Einbindungen anderswo und für status.js (alle 60 s). Nur öffentliche
// Bestandteile; Zeiten in UTC (ISO 8601).
import { INDICATOR_TEXT } from './aggregate.js';
import { incidentPath } from './links.js';
import { iso } from './render.js';
import type { IncidentView, PageView } from './view.js';

function incident(view: PageView, i: IncidentView): Record<string, unknown> {
  const last = i.updates[i.updates.length - 1];
  const out: Record<string, unknown> = {
    id: i.id,
    title: i.title,
    status: i.status,
    impact: i.kind === 'maintenance' ? 'maintenance' : i.impact,
    started_at: iso(i.startsAt),
    updated_at: iso(last ? last.createdAt : i.startsAt),
    url: view.url.replace(/\/$/, '') + incidentPath(i.id),
  };
  if (i.kind === 'maintenance' && i.endsAt !== null) out.ends_at = iso(i.endsAt);
  return out;
}

export function summaryJson(view: PageView): Record<string, unknown> {
  return {
    page: { name: view.page.title || view.page.slug, url: view.url, updated_at: iso(view.updatedAt ?? view.generatedAt) },
    status: { indicator: view.indicator, description: INDICATOR_TEXT[view.indicator] },
    components: view.components.map((c) => ({
      id: c.id,
      name: c.name,
      group: c.group,
      status: c.status,
      uptime_90d: c.uptime,
      updated_at: c.updatedAt === null ? null : iso(c.updatedAt),
    })),
    incidents: view.active.filter((i) => i.kind === 'incident').map((i) => incident(view, i)),
    maintenance: [...view.active.filter((i) => i.kind === 'maintenance'), ...view.upcoming].map((i) => incident(view, i)),
    ...(view.gate.state === 'frozen' ? { notice: 'Checks are paused – a problem on our side.' } : {}),
    ...(view.dbDown !== null ? { notice: 'We can’t load live data right now.' } : {}),
  };
}
