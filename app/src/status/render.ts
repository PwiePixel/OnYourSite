// Statusseiten: HTML der öffentlichen Seite, eines Vorfalls, des Verlaufs und der Hinweise (Entwurf §5.3, §5.4, §5.5).
// Dasselbe Grundgerüst wie die Profilseiten (Klassen oys t-<Design>, page.css, themes.css, fonts.css) plus status.css,
// alles vom eigenen Ursprung – keine fremden Skripte, keine Schriften von anderswo: eine Statusseite muss laden, wenn
// anderes gerade ausfällt. Jeder Text von Nutzern wird maskiert; Vorfall-Texte gehen durch das sichere Markdown.
import { e } from '../html.js';
import { asset, mainUrl } from '../helpers.js';
import { date } from '../php.js';
import { timeZone } from '../db.js';
import { themeKey, themes } from '../content/themes.js';
import { markdown } from '../updates/markdown.js';
import { INDICATOR_TEXT, STATUS_TEXT, type ComponentStatus } from './aggregate.js';
import { EFFECT_LABEL, IMPACT_LABEL, STATUS_LABEL, duration, isFinal } from './incidents.js';
import { historyPath, incidentPath } from './links.js';
import type { StatusPageRow } from './model.js';
import { statusPageSettings } from './settings.js';
import { BAR_DAYS, lastDays, type ComponentView, type IncidentView, type PageView } from './view.js';

export interface RenderLinks {
  discord: string; // Einladung (nur OnYourSites Seite)
}

// ---------------------------------------------------------------- Zeit

function zone(unix: number): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timeZone(), timeZoneName: 'short' }).formatToParts(new Date(unix * 1000));
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

export const iso = (unix: number): string => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

// <time> mit Uhrzeit der Seite und Zeitzone; status.js zeigt sie in der Zone des Besuchers (data-f: d = Datum, t = Zeit,
// dt = beides)
function timeTag(unix: number, kind: 'd' | 't' | 'dt' = 'dt'): string {
  const text = kind === 'd' ? date('M j, Y', unix) : kind === 't' ? date('H:i', unix) : date('M j, H:i', unix);
  const z = kind === 'd' ? '' : zone(unix);
  return `<time datetime="${iso(unix)}" data-f="${kind}">${e(text)}${z ? ' ' + e(z) : ''}</time>`;
}

function agoText(unix: number, now: number): string {
  const d = Math.max(0, now - unix);
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return date('M j', unix);
}

// ---------------------------------------------------------------- Rahmen

interface Frame {
  page: StatusPageRow;
  title: string;
  description: string;
  canonical: string;
  noindex: boolean;
  accent: string;
  body: string;
}

function frame(f: Frame): string {
  const theme = themeKey(f.page.theme);
  const meta = themes()[theme];
  const style = f.accent ? ` style="--accent:${e(f.accent)}"` : '';
  let o = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n';
  o += `<title>${e(f.title)}</title>\n`;
  if (f.description) o += `<meta name="description" content="${e(f.description)}">\n`;
  if (f.noindex) o += '<meta name="robots" content="noindex">\n';
  else if (f.canonical) o += `<link rel="canonical" href="${e(f.canonical)}">\n`;
  o += `<meta property="og:title" content="${e(f.title)}">\n<meta property="og:type" content="website">\n`;
  if (f.canonical) o += `<meta property="og:url" content="${e(f.canonical)}">\n`;
  if (f.description) o += `<meta property="og:description" content="${e(f.description)}">\n`;
  o += `<meta name="theme-color" content="${meta.dark ? '#0b0b0d' : '#ffffff'}">\n`;
  o += '<link rel="icon" type="image/png" href="/static/images/favicon.png">\n';
  for (const css of ['/static/css/fonts.css', '/static/css/themes.css', '/static/css/page.css', '/static/css/status.css']) {
    o += `<link rel="stylesheet" href="${e(asset(css))}">\n`;
  }
  o += `<script src="${e(asset('/static/js/status.js'))}" defer></script>\n`;
  o += '</head>\n';
  o += `<body class="oys t-${e(theme)} l-buttons mode-status"${style}>\n`;
  o += '<div class="oys-bg" aria-hidden="true"><span class="oys-deco oys-deco-1"></span><span class="oys-deco oys-deco-2"></span><span class="oys-deco oys-deco-3"></span></div>\n';
  o += f.body;
  o += '</body>\n</html>\n';
  return o;
}

function accentOf(page: StatusPageRow): string {
  const s = statusPageSettings({ settings: page.settings, is_system: page.isSystem ? 1 : 0 });
  return s.accent;
}

function header(view: Pick<PageView, 'page' | 'url'>, links: RenderLinks, asH1 = false): string {
  const home = '/';
  const p = view.page;
  const name = p.title || p.slug;
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('') || '?';
  let o = '  <header class="st-head">\n';
  o += `    <a class="st-logo" href="${e(home)}" aria-label="${e(name)}">`;
  o += p.isSystem ? '<img src="/static/images/favicon.png" alt="" width="48" height="48">' : `<span>${e(initials)}</span>`;
  o += '</a>\n';
  const tag = asH1 ? 'h1' : 'p';
  o += `    <div class="st-titles"><${tag} class="st-title">${e(name)}</${tag}>`;
  if (p.description) o += `<p class="st-desc">${e(p.description)}</p>`;
  o += '</div>\n';
  if (p.isSystem) {
    o += '    <nav class="st-links" aria-label="OnYourSite">';
    o += `<a href="${e(mainUrl('/'))}">on-your.site</a><a href="${e(mainUrl('/updates'))}">Updates</a><a href="${e(mainUrl('/roadmap'))}">Roadmap</a>`;
    if (links.discord) o += `<a href="${e(links.discord)}" target="_blank" rel="noopener">Discord</a>`;
    o += '</nav>\n';
  }
  o += '  </header>\n';
  return o;
}

function footer(page: StatusPageRow): string {
  let o = '  <footer class="oys-foot st-foot">\n';
  if (page.isSystem) {
    o += `    <a href="${e(mainUrl('/'))}">OnYourSite</a> <a href="${e(mainUrl('/privacy'))}">Privacy</a> <a href="${e(mainUrl('/imprint'))}">Legal notice</a>\n`;
  } else {
    o += `    <a href="${e(mainUrl('/'))}" target="_blank" rel="noopener">Made with <strong>OnYourSite</strong></a>\n`;
    o += `    <a href="${e(mainUrl('/terms/status-pages?page=' + encodeURIComponent(page.slug) + '#report'))}" target="_blank" rel="noopener">Report this page</a>\n`;
  }
  o += '  </footer>\n';
  return o;
}

// ---------------------------------------------------------------- Bausteine

const STATUS_CLASS: Record<ComponentStatus, string> = {
  operational: 'st-s-ok', degraded: 'st-s-degraded', partial: 'st-s-partial', major: 'st-s-major', maintenance: 'st-s-maint', unknown: 'st-s-unknown',
};

export function pill(status: ComponentStatus): string {
  return `<span class="st-pill ${STATUS_CLASS[status]}" data-status="${status}"><span class="st-dot" aria-hidden="true"></span>${e(STATUS_TEXT[status])}</span>`;
}

function impactClass(inc: IncidentView): string {
  if (isFinal(inc.status)) return 'st-i-resolved';
  if (inc.kind === 'maintenance') return 'st-i-maint';
  return 'st-i-' + (['none', 'minor', 'major', 'critical'].includes(inc.impact) ? inc.impact : 'minor');
}

function md(view: Pick<PageView, 'page' | 'url'>, body: string): string {
  return view.page.isSystem ? markdown(body, { base: mainUrl('/') }) : markdown(body, { base: view.url, ugc: true });
}

function lasted(inc: IncidentView, now: number): string {
  if (inc.kind === 'maintenance') {
    if (inc.status === 'scheduled' && inc.endsAt !== null) return `Scheduled for ${timeTag(inc.startsAt)} – ${timeTag(inc.endsAt, 't')}`;
    if (inc.resolvedAt !== null) return `Lasted ${e(duration(inc.resolvedAt - inc.startsAt))}`;
    return `In progress since ${timeTag(inc.startsAt)}${inc.endsAt !== null ? `, until ${timeTag(inc.endsAt, 't')}` : ''}`;
  }
  if (inc.resolvedAt !== null) return `Lasted ${e(duration(inc.resolvedAt - inc.startsAt))}`;
  return `Ongoing for ${e(duration(now - inc.startsAt))}`;
}

function incidentCard(view: PageView, inc: IncidentView): string {
  const last = inc.updates[inc.updates.length - 1];
  let o = `  <article class="oys-card st-incident ${impactClass(inc)}">\n`;
  o += `    <div class="st-incident-head"><a class="st-incident-title" href="${e(incidentPath(inc.id))}">${e(inc.title)}</a>`;
  o += `<span class="st-incident-state">${e(STATUS_LABEL[inc.status] ?? inc.status)} · ${lasted(inc, view.generatedAt)}</span></div>\n`;
  if (last) o += `    <div class="md st-incident-last">${md(view, last.body)}</div>\n`;
  o += '    <p class="st-incident-foot">';
  if (inc.affected.length) o += `Affected: ${e(inc.affected.join(', '))} · `;
  if (last) o += `Updated ${timeTag(last.createdAt)} · `;
  o += `<a href="${e(incidentPath(inc.id))}">View details</a></p>\n`;
  o += '  </article>\n';
  return o;
}

function componentRow(c: ComponentView, showUptime: boolean): string {
  let o = `      <div class="st-comp${c.stale ? ' st-stale' : ''}" data-id="${c.id}">\n`;
  o += `        <div class="st-comp-head"><span class="st-comp-name">${e(c.name)}</span>`;
  if (c.description) o += `<span class="st-help" title="${e(c.description)}">?</span>`;
  o += pill(c.status) + '</div>\n';
  if (c.type !== 'manual') {
    o += `        <div class="st-bars" role="group" aria-label="${e(`Uptime of ${c.name} in the last ${BAR_DAYS} days`)}">`;
    for (const b of c.bars) o += `<i class="st-bar ${b.color}" role="img" title="${e(b.label)}" aria-label="${e(b.label)}"></i>`;
    o += '</div>\n';
    o += '        <div class="st-legend"><span><span class="st-wide">90 days ago</span><span class="st-narrow">30 days ago</span></span>';
    if (showUptime) o += `<span>${c.uptime === null ? '—' : e(c.uptime.toFixed(2)) + '% uptime'}</span>`;
    o += '<span>Today</span></div>\n';
  }
  if (c.spark.length && c.spark.some((v) => v > 0)) o += '        ' + sparkline(c) + '\n';
  o += '      </div>\n';
  return o;
}

// Antwortzeiten der letzten 24 Stunden als kleine Linie (SVG im Dokument, ohne Skript)
function sparkline(c: ComponentView): string {
  const max = Math.max(...c.spark, 1);
  const pts = c.spark.map((v, i) => `${(i * (240 / 23)).toFixed(1)},${(36 - (v / max) * 32).toFixed(1)}`).join(' ');
  const avg = Math.round(c.spark.filter((v) => v > 0).reduce((a, b) => a + b, 0) / Math.max(1, c.spark.filter((v) => v > 0).length));
  return `<div class="st-spark"><svg viewBox="0 0 240 40" preserveAspectRatio="none" role="img" aria-label="${e(`Response time of ${c.name} in the last 24 hours, about ${avg} ms`)}"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke"/></svg><span>${avg} ms</span></div>`;
}

function groups(view: PageView): string {
  const order: string[] = [];
  const byGroup = new Map<string, ComponentView[]>();
  for (const c of view.components) {
    if (!byGroup.has(c.group)) {
      order.push(c.group);
      byGroup.set(c.group, []);
    }
    byGroup.get(c.group)!.push(c);
  }
  let o = '';
  for (const g of order) {
    const list = byGroup.get(g)!;
    if (g === '') {
      for (const c of list) o += componentRow(c, view.settings.show_uptime);
      continue;
    }
    const worst = list.reduce<ComponentStatus>((acc, c) => (c.status === 'major' || (c.status === 'partial' && acc !== 'major') || (c.status === 'degraded' && !['major', 'partial'].includes(acc)) ? c.status : acc), 'operational');
    const open = !(view.page.isSystem && g === 'Infrastructure' && worst === 'operational');
    o += `      <details class="st-group"${open ? ' open' : ''}><summary><span>${e(g)}</span>${pill(worst)}</summary>\n`;
    for (const c of list) o += componentRow(c, view.settings.show_uptime);
    o += '      </details>\n';
  }
  return o;
}

function banner(view: PageView): string {
  let o = `  <section class="st-banner ${STATUS_CLASS[view.indicator]}" role="status" aria-live="polite" data-indicator="${view.indicator}">`;
  o += `<span class="st-dot" aria-hidden="true"></span><strong data-banner-text>${e(INDICATOR_TEXT[view.indicator])}</strong>`;
  o += `<span class="st-updated">Updated <time datetime="${iso(view.generatedAt)}" data-f="rel">${e(agoText(view.generatedAt, view.generatedAt))}</time></span></section>\n`;
  return o;
}

function notices(view: PageView): string {
  let o = '';
  if (view.dbDown !== null) {
    o += `  <div class="st-alert st-alert-red" role="alert">We can’t load live data right now (since ${timeTag(view.dbDown, 't')}). What you see below may be out of date.</div>\n`;
  }
  if (view.modulePaused) {
    o += '  <div class="st-alert" role="note">Live checks are paused.</div>\n';
  } else if (view.gate.state === 'frozen') {
    o += `  <div class="st-alert" role="note">Checks are paused – a problem on our side since ${timeTag(view.gate.since ?? view.generatedAt, 't')}. The status below is from before that.</div>\n`;
  } else if (view.checker.stale && view.components.some((c) => c.type !== 'manual')) {
    o += `  <div class="st-alert" role="note">Live checks are paused${view.checker.at !== null ? ` since ${timeTag(view.checker.at, 't')}` : ''} – the data below may be out of date.</div>\n`;
  }
  return o;
}

// „Past incidents“: je Tag (neuester zuerst) die abgeschlossenen Vorfälle, sonst „No incidents reported.“
function past(view: PageView): string {
  const days = view.settings.history_days;
  if (days <= 0) return '';
  let o = '  <section class="st-past" aria-labelledby="st-past-title">\n    <h2 id="st-past-title" class="st-h2">Past incidents</h2>\n';
  const list = lastDays(view.generatedAt, days, timeZone()).reverse();
  for (const d of list) {
    const items = view.past.filter((i) => i.startsAt >= d.start && i.startsAt < d.end);
    o += `    <div class="st-day"><h3>${timeTag(d.start + 3600, 'd')}</h3>`;
    if (!items.length) o += '<p class="st-none">No incidents reported.</p>';
    for (const i of items) {
      o += `<p class="st-past-item ${impactClass(i)}"><a href="${e(incidentPath(i.id))}">${e(i.title)}</a> <span>${e(STATUS_LABEL[i.status] ?? i.status)} · ${lasted(i, view.generatedAt)}</span></p>`;
    }
    o += '</div>\n';
  }
  o += `    <p class="st-more"><a href="${e(historyPath())}">Incident history</a></p>\n  </section>\n`;
  return o;
}

// ---------------------------------------------------------------- Seiten

export function renderStatusPage(view: PageView, links: RenderLinks): string {
  const p = view.page;
  let body = '<main class="oys-main st-main" data-summary="/summary.json">\n';
  body += header(view, links, true);
  body += banner(view);
  body += notices(view);
  if (view.active.length) {
    body += '  <section class="st-active" aria-label="Current incidents">\n';
    for (const inc of view.active) body += incidentCard(view, inc);
    body += '  </section>\n';
  }
  if (view.upcoming.length) {
    body += '  <section class="st-upcoming" aria-labelledby="st-up-title">\n    <h2 id="st-up-title" class="st-h2">Scheduled maintenance</h2>\n';
    for (const inc of view.upcoming) body += incidentCard(view, inc);
    body += '  </section>\n';
  }
  body += '  <section class="oys-card st-components" aria-label="Components">\n';
  body += view.components.length ? groups(view) : '    <p class="st-none">No components yet.</p>\n';
  body += '  </section>\n';
  body += past(view);
  body += footer(p);
  body += '</main>\n';
  return frame({
    page: p, title: (p.title || p.slug), description: p.description, canonical: view.url, noindex: view.noindex, accent: accentOf(p), body,
  });
}

export function renderIncidentPage(view: PageView, inc: IncidentView, links: RenderLinks): string {
  const p = view.page;
  let body = '<main class="oys-main st-main">\n';
  body += header(view, links);
  body += notices(view);
  body += `  <p class="st-back"><a href="/">← ${e(p.title || p.slug)}</a></p>\n`;
  body += `  <article class="oys-card st-incident-page ${impactClass(inc)}">\n`;
  body += `    <h1 class="st-h1">${e(inc.title)}</h1>\n`;
  body += '    <p class="st-meta">';
  body += `<span class="st-tag">${e(inc.kind === 'maintenance' ? 'Maintenance' : (IMPACT_LABEL[inc.impact] ?? 'Minor') + ' impact')}</span>`;
  body += ` <span>${e(STATUS_LABEL[inc.status] ?? inc.status)}</span> · <span>${lasted(inc, view.generatedAt)}</span>`;
  body += '</p>\n';
  if (inc.affected.length) {
    const effects = inc.monitors.filter((m) => m.isPublic).map((m) => `${m.name} (${(EFFECT_LABEL[m.effect] ?? '').toLowerCase()})`);
    body += `    <p class="st-affected">Affected: ${e(inc.kind === 'maintenance' ? inc.affected.join(', ') : effects.join(', '))}</p>\n`;
  }
  body += '    <ol class="st-timeline">\n';
  for (const u of [...inc.updates].reverse()) {
    body += `      <li><p class="st-tl-head"><strong>${e(STATUS_LABEL[u.status] ?? u.status)}</strong> ${timeTag(u.createdAt)}${u.editedAt !== null ? ' <span class="st-edited">(edited)</span>' : ''}</p>`;
    body += `<div class="md">${md(view, u.body)}</div></li>\n`;
  }
  body += '    </ol>\n  </article>\n';
  body += footer(p);
  body += '</main>\n';
  return frame({
    page: p, title: `${inc.title} – ${p.title || p.slug}`, description: inc.updates.length ? inc.updates[inc.updates.length - 1].body.slice(0, 160) : '',
    canonical: view.url.replace(/\/$/, '') + incidentPath(inc.id), noindex: view.noindex, accent: accentOf(p), body,
  });
}

export interface HistoryPage {
  items: IncidentView[];
  page: number;
  more: boolean;
}

export function renderHistoryPage(view: PageView, h: HistoryPage, links: RenderLinks): string {
  const p = view.page;
  let body = '<main class="oys-main st-main">\n';
  body += header(view, links);
  body += `  <p class="st-back"><a href="/">← ${e(p.title || p.slug)}</a></p>\n`;
  body += '  <h1 class="st-h1">Incident history</h1>\n';
  if (!h.items.length) body += '  <p class="st-none">No incidents or maintenance yet.</p>\n';
  let month = '';
  for (const inc of h.items) {
    const m = date('F Y', inc.startsAt);
    if (m !== month) {
      if (month !== '') body += '  </section>\n';
      month = m;
      body += `  <section class="oys-card st-month"><h2 class="st-h2">${e(m)}</h2>\n`;
    }
    body += `    <p class="st-past-item ${impactClass(inc)}"><span class="st-dot" aria-hidden="true"></span><a href="${e(incidentPath(inc.id))}">${e(inc.title)}</a> `;
    body += `<span>${timeTag(inc.startsAt, 'd')} · ${inc.kind === 'maintenance' ? 'Maintenance' : e(STATUS_LABEL[inc.status] ?? inc.status)} · ${lasted(inc, view.generatedAt)}</span></p>\n`;
  }
  if (month !== '') body += '  </section>\n';
  if (h.page > 1 || h.more) {
    body += '  <nav class="st-pager" aria-label="Pages">';
    if (h.page > 1) body += `<a href="${e(historyPath(h.page - 1))}">Newer</a>`;
    if (h.more) body += `<a href="${e(historyPath(h.page + 1))}">Older</a>`;
    body += '</nav>\n';
  }
  body += footer(p);
  body += '</main>\n';
  return frame({
    page: p, title: `Incident history – ${p.title || p.slug}`, description: '', canonical: view.url.replace(/\/$/, '') + historyPath(h.page),
    noindex: view.noindex, accent: accentOf(p), body,
  });
}

// Hinweis im Design der Seite (offline, gesperrt, nicht gefunden, nicht ladbar)
export function renderNotice(page: Pick<StatusPageRow, 'theme' | 'settings' | 'isSystem' | 'slug' | 'title'> & Partial<StatusPageRow>, title: string, text: string): string {
  const p = { id: 0, userId: null, description: '', published: true, blocked: false, blockedReason: '', reviewNote: '', reviewedAt: null, rev: 0, createdAt: null, ...page } as StatusPageRow;
  let body = '<main class="oys-main st-main st-notice">\n';
  body += `  <section class="oys-card st-notice-card"><h1 class="st-h1">${e(title)}</h1><p>${e(text)}</p></section>\n`;
  body += '</main>\n';
  return frame({ page: p, title, description: '', canonical: '', noindex: true, accent: accentOf(p), body });
}

// Bestätigung einer Alarm-Adresse (ST-5): Hinweis mit einem Knopf, der dieselbe Adresse per POST aufruft
export function renderConfirm(title: string, text: string, button: string | null): string {
  const p = { id: 0, userId: null, isSystem: false, slug: '', title: 'OnYourSite', description: '', theme: null, settings: null, published: true, blocked: false,
    blockedReason: '', reviewNote: '', reviewedAt: null, rev: 0, createdAt: null } as unknown as StatusPageRow;
  let body = '<main class="oys-main st-main st-notice">\n';
  body += `  <section class="oys-card st-notice-card"><h1 class="st-h1">${e(title)}</h1><p>${e(text)}</p>`;
  if (button !== null) body += `<form method="POST" class="st-confirm"><button type="submit" class="st-btn">${e(button)}</button></form>`;
  body += '</section>\n</main>\n';
  return frame({ page: p, title, description: '', canonical: '', noindex: true, accent: accentOf(p), body });
}

// OnYourSites Seite ohne Datenbank und ohne gespeicherte Ausgabe (z. B. die Webseite startete während des Ausfalls)
export function renderSystemFallback(page: Pick<StatusPageRow, 'slug' | 'title'>, since: number, links: RenderLinks): string {
  const p: StatusPageRow = {
    id: 0, userId: null, isSystem: true, slug: page.slug, title: page.title || 'OnYourSite status', description: '', theme: 'deep-dark',
    settings: '{"accent":"#6366f1"}', published: true, blocked: false, blockedReason: '', reviewNote: '', reviewedAt: null, slugChangedAt: null, rev: 0, createdAt: null,
  };
  let body = '<main class="oys-main st-main">\n';
  body += header({ page: p, url: '' }, links, true);
  body += `  <section class="st-banner st-s-major" role="status"><span class="st-dot" aria-hidden="true"></span><strong>${e(INDICATOR_TEXT.major)}</strong></section>\n`;
  body += `  <div class="st-alert st-alert-red" role="alert">We can’t load live data right now (since ${timeTag(since, 't')}). What you see below may be out of date.</div>\n`;
  body += '  <section class="oys-card st-components" aria-label="Components">\n';
  for (const name of ['Website', 'Database']) {
    body += `      <div class="st-comp"><div class="st-comp-head"><span class="st-comp-name">${e(name)}</span>${pill('major')}</div></div>\n`;
  }
  body += '  </section>\n';
  body += '  <p class="st-more">';
  if (links.discord) body += `Updates on <a href="${e(links.discord)}" target="_blank" rel="noopener">our Discord</a> · `;
  body += `<a href="${e(mainUrl('/updates'))}">Changelog</a></p>\n`;
  body += footer(p);
  body += '</main>\n';
  return frame({ page: p, title: p.title, description: '', canonical: '', noindex: false, accent: '#6366f1', body });
}
