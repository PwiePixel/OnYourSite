// Wochenbericht (lib/report.php): jeden Montag eine kurze Mail mit Aufrufen, Klicks und dem besten Link.
// Aufgerufen vom Befehl cli/weekly-report.ts (cron/weekly_report.php), von /_/cron/weekly-report und vom Editor
// (Test-Bericht an sich selbst).
import { exec, one, q, type Param, type Row } from '../db.js';
import { e } from '../html.js';
import { date, intval, numberFormat, phpStr, phpTruthy } from '../php.js';
import { mainUrl, pageDisplayUrl, type PageLike } from '../helpers.js';
import { sendCustomEmail } from '../mail.js';
import { blockTypes } from '../content/blocks.js';
import { isShownLinkPage, userPages } from '../content/pages.js';
import { brands } from '../content/social.js';
import { phpRound } from '../content/phpMath.js';
import { jsonDecode, own } from '../content/util.js';

export interface WeeklyResult {
  sent: number;
  failed: number;
  // Konten, deren Plätze alle Code-Seiten zeigen: nichts zu berichten (nicht gesendet, nicht fehlgeschlagen)
  skipped: number;
}

// Ein Kalendertag (ohne Uhrzeit) – wie DateTimeImmutable('yesterday') mit modify('-N days'): reine Kalenderrechnung,
// eine Zeitumstellung verschiebt nichts
export interface ReportDay {
  y: number;
  m: number;
  d: number;
}

export interface BestLink {
  title: unknown;
  clicks: number;
}

export interface WeeklyPage {
  page: Row;
  views: number;
  clicks: number;
  prev_views: number;
  best: BestLink | null;
}

export interface WeeklyReport {
  from: ReportDay;
  to: ReportDay;
  pages: WeeklyPage[];
  views: number;
  clicks: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number): string => String(n).padStart(2, '0');

// Tag + n Tage (Monats- und Jahreswechsel wie modify())
function addDays(day: ReportDay, n: number): ReportDay {
  const t = new Date(0);
  t.setUTCFullYear(day.y, day.m - 1, day.d + n);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

// format('Y-m-d'), format('M j'), format('M j, Y')
export const dayYmd = (day: ReportDay): string => `${String(day.y).padStart(4, '0')}-${pad(day.m)}-${pad(day.d)}`;
const dayMj = (day: ReportDay): string => MONTHS[day.m - 1] + ' ' + day.d;
const dayMjY = (day: ReportDay): string => dayMj(day) + ', ' + day.y;

// Heute in der Zeitzone der Seite
function today(): ReportDay {
  const [y, m, d] = date('Y-m-d').split('-').map(Number);
  return { y, m, d };
}

// oys_week_numbers()
async function weekNumbers(pageId: number, from: string, to: string): Promise<{ views: number; clicks: number }> {
  const row = await one('SELECT COALESCE(SUM(views),0) AS views, COALESCE(SUM(clicks),0) AS clicks FROM stats_daily WHERE page_id = ? AND day BETWEEN ? AND ?', [pageId, from, to]);
  return { views: intval(row?.views), clicks: intval(row?.clicks) };
}

// oys_week_best_link(): der meistgeklickte Block (bzw. die Plattform eines Social-Icons) der Woche.
// Bewusst anders als lib/report.php: Bei gleich vielen Klicks entscheiden block_id und dann item. PHP sortiert nur nach
// clicks – unter gleichauf liegenden Links darf MariaDB dann irgendeinen liefern (je nach Ausführungsplan), und derselbe
// Bericht nannte mal den einen, mal den anderen Link. So gewinnt immer der Block mit der kleinsten ID, innerhalb eines
// Social-Blocks die Plattform nach dem Alphabet.
async function weekBestLink(pageId: number, from: string, to: string): Promise<BestLink | null> {
  const row = await one('SELECT block_id, item, SUM(clicks) AS clicks FROM block_clicks_daily WHERE page_id = ? AND day BETWEEN ? AND ? GROUP BY block_id, item ORDER BY clicks DESC, block_id, item LIMIT 1', [pageId, from, to]);
  if (!row || intval(row.clicks) === 0) return null;
  const block = await one('SELECT * FROM page_blocks WHERE id = ?', [row.block_id as Param]);
  if (!block) return null;
  // json_decode(…, true) ?: []
  const decoded = jsonDecode(phpStr(block.data));
  const data = phpTruthy(decoded) ? decoded : [];
  let title: unknown;
  if (row.item !== '') {
    const item = phpStr(row.item);
    const list = brands();
    title = Object.hasOwn(list, item) ? list[item].name : row.item;
  } else {
    const blockTitle = own(data, 'title') ?? '';
    const types = blockTypes();
    const type = phpStr(block.type);
    title = phpTruthy(blockTitle) ? blockTitle : Object.hasOwn(types, type) ? types[type] : 'Link';
  }
  return { title, clicks: intval(row.clicks) };
}

// oys_weekly_report_data(): Zahlen aller gezeigten Link-Seiten eines Nutzers (letzte 7 volle Tage und die Woche davor).
// Ein Platz, der eine Code-Seite zeigt, fehlt: seine Link-Seite ist geparkt, ihre Zahlen stehen still.
export async function weeklyReportData(userId: number): Promise<WeeklyReport> {
  const to = addDays(today(), -1);
  const from = addDays(to, -6);
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -6);

  const pages: WeeklyPage[] = [];
  for (const page of (await userPages(userId)).filter(isShownLinkPage)) {
    const pageId = intval(page.id);
    const now = await weekNumbers(pageId, dayYmd(from), dayYmd(to));
    const prev = await weekNumbers(pageId, dayYmd(prevFrom), dayYmd(prevTo));
    pages.push({
      page,
      views: now.views,
      clicks: now.clicks,
      prev_views: prev.views,
      best: await weekBestLink(pageId, dayYmd(from), dayYmd(to)),
    });
  }
  return {
    from,
    to,
    pages,
    views: pages.reduce((s, p) => s + p.views, 0),
    clicks: pages.reduce((s, p) => s + p.clicks, 0),
  };
}

// oys_weekly_report_html(): eine Karte je Seite (Text genau wie in PHP)
export function weeklyReportHtml(report: WeeklyReport): string {
  let rows = '';
  for (const p of report.pages) {
    let trend = '';
    if (p.prev_views > 0) {
      const pct = intval(phpRound(((p.views - p.prev_views) / p.prev_views) * 100));
      const color = pct >= 0 ? '#34d399' : '#f87171';
      trend = '<span style="color:' + color + ';font-size:12px;font-weight:bold;"> ' + (pct >= 0 ? '+' : '') + pct + '%</span>';
    }
    const best = p.best
      ? '🏆 Best link: <strong style="color:#ffffff;">' + e(p.best.title) + '</strong> (' + intval(p.best.clicks) + (intval(p.best.clicks) === 1 ? ' click)' : ' clicks)')
      : 'No links were clicked this week.';
    rows += '<div style="background-color:#0a0a0a;border:1px solid #27272a;border-radius:12px;padding:20px;margin:0 auto 16px auto;max-width:460px;text-align:left;">'
      + '<p style="margin:0 0 12px 0;font-size:14px;color:#818cf8;font-weight:bold;">' + e(pageDisplayUrl(p.page as unknown as PageLike)) + '</p>'
      + '<table role="presentation" width="100%" style="border-collapse:collapse;"><tr>'
      + '<td style="padding:0;width:50%;"><div style="font-size:26px;font-weight:bold;color:#ffffff;">' + numberFormat(p.views) + trend + '</div><div style="font-size:12px;color:#9ca3af;">Views</div></td>'
      + '<td style="padding:0;width:50%;"><div style="font-size:26px;font-weight:bold;color:#ffffff;">' + numberFormat(p.clicks) + '</div><div style="font-size:12px;color:#9ca3af;">Clicks</div></td>'
      + '</tr></table>'
      + '<p style="margin:14px 0 0 0;font-size:13px;color:#9ca3af;">' + best + '</p></div>';
  }
  return rows;
}

// sendCustomEmail() aus mail.ts; Tests können eine eigene Funktion setzen (undefined = wieder mail.ts)
type SendMail = (to: unknown, template: string, vars: Record<string, unknown>, subject?: unknown) => Promise<boolean>;
let mailer: SendMail | undefined;
export function setReportMailerForTests(fn: SendMail | undefined): void {
  mailer = fn;
}

// oys_send_weekly_report(): false, wenn der Nutzer keine Seite hat oder die Mail nicht rausging
export async function sendWeeklyReport(user: Row): Promise<boolean> {
  const report = await weeklyReportData(intval(user.id));
  if (!report.pages.length) return false;
  const period = dayMj(report.from) + ' – ' + dayMjY(report.to);
  const send = mailer ?? sendCustomEmail;
  // Reihenfolge der Platzhalter wie in PHP (report_html kann {dashboard_url} enthalten – es wird danach ersetzt)
  return send(user.email, 'weekly_report', {
    full_name: e(phpTruthy(user.full_name) ? user.full_name : 'there'),
    period: e(period),
    views: numberFormat(report.views),
    clicks: numberFormat(report.clicks),
    report_html: weeklyReportHtml(report),
    dashboard_url: e(mainUrl('/dashboard')),
  }, 'Your weekly report: ' + numberFormat(report.views) + (report.views === 1 ? ' view, ' : ' views, ') + numberFormat(report.clicks) + (report.clicks === 1 ? ' click' : ' clicks'));
}

// Hat das Konto Seiten, aber keine gezeigte Link-Seite (alle Plätze zeigen Code-Seiten)?
export async function onlyCodeSlots(userId: number): Promise<boolean> {
  const row = await one('SELECT COUNT(*) AS total, COALESCE(SUM(code_site_id IS NULL), 0) AS shown FROM pages WHERE user_id = ?', [userId]);
  return intval(row?.total) > 0 && intval(row?.shown) === 0;
}

// oys_run_weekly_reports(): allen Nutzern mit Wochenbericht ihre Mail schicken (höchstens einmal am Tag). Konten, deren
// Plätze alle Code-Seiten zeigen, haben nichts zu berichten: übersprungen und für heute erledigt, nicht fehlgeschlagen.
export async function runWeeklyReports(): Promise<WeeklyResult> {
  const todayStart = date('Y-m-d 00:00:00');
  const users = await q('SELECT id, email, full_name FROM users WHERE weekly_report = 1 AND (weekly_report_sent_at IS NULL OR weekly_report_sent_at < ?)', [todayStart]);
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const user of users) {
    if (await onlyCodeSlots(intval(user.id))) {
      skipped++;
      await exec('UPDATE users SET weekly_report_sent_at = ? WHERE id = ?', [date('Y-m-d H:i:s'), user.id as Param]);
      continue;
    }
    if (await sendWeeklyReport(user)) {
      sent++;
      await exec('UPDATE users SET weekly_report_sent_at = ? WHERE id = ?', [date('Y-m-d H:i:s'), user.id as Param]);
    } else {
      failed++;
    }
  }
  return { sent, failed, skipped };
}
