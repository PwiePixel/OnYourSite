// Admin, Bereich „Status pages“ (#status): vorerst die Karte „Health“ – Prüfdienst, Benachrichtigungsdienst und Sensor
// (läuft / angehalten), Prüfungen je Minute, Verzögerung, aktive und ruhende Bestandteile, die Plattform-Sperre mit
// den Kanarienvögeln, der Schutz im Kernel (Test des Installers), E-Mails je Klasse und das Alter der lokalen Messung –
// dazu der Zustand von OnYourSites eigenen Bestandteilen. Nur lesen; Aktionen kommen mit den Seiten der Nutzer.
// Aussehen wie die anderen Bereiche (Karten bg-card, Abzeichen wie bei den Code-Seiten).
import type { Ctx } from '../web/ctx.js';
import { q } from '../db.js';
import { e } from '../html.js';
import { date } from '../php.js';
import { schemaAtLeast, V_STATUS_TABLES } from '../schema.js';
import { errorText } from './errors.js';
import { statusServerConfig } from './settings.js';

const BADGE = 'text-[10px] font-bold uppercase px-1.5 py-0.5 rounded';
const OK = `${BADGE} bg-emerald-500/15 text-emerald-400`;
const WARN = `${BADGE} bg-amber-500/15 text-amber-400`;
const BAD = `${BADGE} bg-red-500/15 text-red-400`;
const OFF = `${BADGE} bg-white/10 text-gray-400`;

type Json = Record<string, unknown>;

function parse(raw: unknown): Json | null {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    return null;
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// „40 s ago“, „3 min ago“, „2 h ago“, sonst das Datum
export function ago(at: number, now: number): string {
  const d = Math.max(0, now - at);
  if (d < 90) return `${d} s ago`;
  if (d < 5400) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  return date('M j, H:i', at);
}

interface ServiceLine {
  label: string;
  hint: string;
  badge: string;
  badgeText: string;
  detail: string;
}

// Ein Dienst mit Gesundheitseintrag {at, started}: läuft, wenn der Eintrag höchstens 3 Minuten alt ist
function service(label: string, rec: Json | null, now: number, missing: string, hint: string): ServiceLine {
  const at = num(rec?.at);
  if (at === null) return { label, hint, badge: OFF, badgeText: 'Not running', detail: missing };
  if (now - at <= 180) {
    const started = num(rec?.started);
    return { label, hint, badge: OK, badgeText: 'Running', detail: started !== null ? 'since ' + date('M j, H:i', started) : 'last seen ' + ago(at, now) };
  }
  return { label, hint, badge: BAD, badgeText: 'Stopped', detail: 'last seen ' + date('M j, H:i', at) };
}

const STATE_BADGE: Record<string, [string, string]> = {
  up: [OK, 'Operational'],
  degraded: [WARN, 'Degraded'],
  down: [BAD, 'Down'],
  unknown: [OFF, 'No data yet'],
};

export async function adminStatusView(ctx: Ctx): Promise<string> {
  void ctx;
  const now = Math.floor(Date.now() / 1000);
  let o = '';
  o += '            <!-- ===================== Statusseiten ===================== -->\n';
  o += '            <div id="tab-status" class="admin-tab-content max-w-5xl mx-auto space-y-8 hidden">\n';
  if (!(await schemaAtLeast(V_STATUS_TABLES).catch(() => false))) {
    o += '                <div class="bg-card border border-bordercolor rounded-xl shadow-xl p-5 sm:p-6 text-sm text-gray-400">The database update for status pages hasn’t run yet.</div>\n';
    return o + '            </div>\n';
  }
  const meta = new Map<string, unknown>();
  for (const r of await q("SELECT meta_key, meta_value FROM oys_meta WHERE meta_key IN ('status_worker', 'status_notify', 'status_probe', 'status_gate')")) {
    meta.set(String(r.meta_key), r.meta_value);
  }
  const worker = parse(meta.get('status_worker'));
  const notifier = parse(meta.get('status_notify'));
  const probe = parse(meta.get('status_probe'));
  const gate = parse(meta.get('status_gate'));
  const server = statusServerConfig();

  const services: ServiceLine[] = [
    service('Checker', worker, now, 'It hasn’t reported yet – see journalctl -u onyoursite-status', 'onyoursite-status'),
    service('Notifier', notifier, now, 'Not installed yet', 'onyoursite-status-notify'),
  ];
  const probeAt = num(probe?.at);
  services.push(probeAt === null
    ? { label: 'Local probe', hint: 'onyoursite-status-local.timer', badge: OFF, badgeText: 'Not running', detail: 'No measurement yet' }
    : now - probeAt <= 180
      ? { label: 'Local probe', hint: 'onyoursite-status-local.timer', badge: OK, badgeText: 'Running', detail: ago(probeAt, now) }
      : { label: 'Local probe', hint: 'onyoursite-status-local.timer', badge: BAD, badgeText: 'Local probe isn’t running', detail: 'last seen ' + date('M j, H:i', probeAt) });

  // Plattform-Sperre
  const gateState = typeof gate?.state === 'string' ? gate.state : 'ok';
  const canaries = gate?.canaries as { ok?: unknown; of?: unknown } | undefined;
  const canaryText = num(canaries?.of) ? `canaries ${num(canaries?.ok) ?? 0}/${num(canaries?.of)}` : 'canaries not checked yet';
  const since = num(gate?.since);
  const gateLine = gateState === 'frozen'
    ? `<span class="${BAD}">Paused</span> <span class="text-sm text-gray-300">since ${e(since !== null ? date('M j, H:i', since) : '—')}: ${e(canaryText)}</span>`
    : gateState === 'hold'
      ? `<span class="${WARN}">Holding</span> <span class="text-sm text-gray-300">since ${e(since !== null ? date('M j, H:i', since) : '—')}: many sites fail at once – ${e(canaryText)}</span>`
      : `<span class="${OK}">OK</span> <span class="text-sm text-gray-300">${e(canaryText)}</span>`;
  const kernel = server.kernel_guard === true
    ? `<span class="${OK}">On</span>`
    : server.kernel_guard === false
      ? `<span class="${WARN}">Off</span> <span class="text-sm text-amber-300">This server ignores IPAddressDeny – checks rely on the app guard only.</span>`
      : `<span class="${OFF}">Not checked yet</span> <span class="text-sm text-gray-500">The installer tests it when it sets up the status services.</span>`;
  const mail = notifier?.mail_today as Json | undefined;
  const mailText = mail ? ['system', 'confirm', 'owner', 'broadcast'].map((k) => `${k} ${num(mail[k]) ?? 0}`).join(' · ') : 'No emails yet';
  const monitors = worker?.monitors as { active?: unknown; paused?: unknown } | undefined;
  const lag = num(worker?.lag_p95_ms);

  const rows: Array<[string, string]> = [
    ['Checks per minute', e(String(num(worker?.checks_min) ?? 0))],
    ['Schedule lag (p95)', e(lag === null ? '—' : (lag / 1000).toFixed(1) + ' s')],
    ['Components', e(`${num(monitors?.active) ?? 0} active · ${num(monitors?.paused) ?? 0} paused`)],
    ['Delayed in the last 10 min', e(String(num(worker?.delayed_10m) ?? 0))],
    ['Platform gate', gateLine],
    ['Kernel guard', kernel],
    ['Emails today', e(mailText)],
    ['Version', e(typeof worker?.version === 'string' ? worker.version : '—')],
  ];

  o += `                <div class="bg-card border border-bordercolor rounded-xl shadow-xl p-5 sm:p-6">
                    <div class="flex items-center gap-3 mb-5 border-b border-bordercolor pb-4">
                        <i class='bx bx-pulse text-2xl text-lime-400'></i>
                        <h2 class="text-base font-semibold text-white">Health</h2>
                    </div>
                    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6" id="statusServices">
`;
  for (const s of services) {
    o += `                        <div class="rounded-lg border border-bordercolor p-4">
                            <p class="text-xs text-gray-500 uppercase tracking-wider font-semibold">${e(s.label)}</p>
                            <p class="mt-2 flex items-center gap-2 flex-wrap"><span class="${s.badge}">${e(s.badgeText)}</span> <span class="text-sm text-gray-300">${e(s.detail)}</span></p>
                            <p class="text-xs text-gray-500 mt-1">${e(s.hint)}</p>
                        </div>
`;
  }
  o += `                    </div>
                    <dl class="divide-y divide-bordercolor" id="statusHealth">
`;
  for (const [label, valueHtml] of rows) {
    o += `                        <div class="py-2.5 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4">
                            <dt class="text-sm text-gray-400 sm:w-56 shrink-0">${e(label)}</dt>
                            <dd class="flex items-center gap-2 flex-wrap text-sm text-white">${valueHtml}</dd>
                        </div>
`;
  }
  o += `                    </dl>
                </div>
`;

  // OnYourSites eigene Bestandteile
  const parts = await q(`SELECT m.id, m.name, m.target, m.is_public, m.is_paused, s.state, s.last_check_at, s.last_error, s.last_code, s.last_ms
      FROM status_monitors m JOIN status_pages p ON p.id = m.page_id AND p.is_system = 1 LEFT JOIN status_state s ON s.monitor_id = m.id
      WHERE m.type = 'system' ORDER BY m.position, m.id`);
  o += `                <div class="bg-card border border-bordercolor rounded-xl shadow-xl overflow-hidden">
                    <div class="flex flex-wrap items-center justify-between gap-3 p-5 sm:p-6 border-b border-bordercolor">
                        <h2 class="text-base font-semibold text-white flex items-center gap-2"><i class='bx bx-server text-xl text-lime-400'></i> OnYourSite components <span class="text-gray-500 text-sm font-normal">${parts.length}</span></h2>
                    </div>
`;
  if (!parts.length) {
    o += '                    <p class="p-6 text-sm text-gray-500">No components yet.</p>\n';
  } else {
    o += '                    <div class="divide-y divide-bordercolor" id="statusComponents">\n';
    for (const p of parts) {
      const state = typeof p.state === 'string' && STATE_BADGE[p.state] ? p.state : 'unknown';
      const [cls, label] = STATE_BADGE[state];
      const checked = num(p.last_check_at);
      const err = state === 'down' || state === 'degraded' ? errorText(typeof p.last_error === 'string' ? p.last_error : null, { code: num(p.last_code) }) : '';
      o += `                        <div class="p-4 sm:px-6 flex flex-col sm:flex-row sm:items-center gap-2">
                            <div class="min-w-0 flex-1">
                                <div class="flex items-center gap-2 flex-wrap">
                                    <span class="text-white font-medium">${e(p.name)}</span>
                                    <span class="${cls}">${e(label)}</span>
${Number(p.is_public) === 1 ? '' : `                                    <span class="${OFF}">Private</span>\n`}                                </div>
                                <p class="text-xs text-gray-500 mt-1">${e(p.target)}${checked !== null ? ' · checked ' + e(ago(checked, now)) : ''}${err !== '' ? ' · ' + e(err) : ''}</p>
                            </div>
                        </div>
`;
    }
    o += '                    </div>\n';
  }
  o += '                </div>\n';
  o += '            </div>\n';
  return o;
}
