// Statistik ohne Cookies und ohne IP-Adressen: Es werden nur Zähler pro Tag gespeichert (lib/stats.php).
import type { Ctx } from '../web/ctx.js';
import { exec, q, value, type Row } from '../db.js';
import { baseHost } from '../helpers.js';
import { date, intval, phpStr, phpTruthy, strtolower } from '../php.js';
import { phpParseUrl } from '../compat/core.js';
import { blockTypes } from './blocks.js';
import { loadBlocks } from './pages.js';
import { brands, socialUrl } from './social.js';
import { own, values } from './util.js';
import { phpRound } from './phpMath.js';

// oys_record_view()
export async function recordView(pageId: number): Promise<void> {
  const today = date('Y-m-d');
  await exec('INSERT INTO stats_daily (page_id, day, views) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE views = views + 1', [pageId, today]);
  await exec('UPDATE pages SET views = views + 1 WHERE id = ?', [pageId]);
}

// oys_record_click(): Klick auf einen Block (bei Social-Icons je Plattform: item)
export async function recordClick(pageId: number, blockId: number, item = ''): Promise<void> {
  const today = date('Y-m-d');
  // Nur a–z und 0–9 (die Klasse arbeitet in PHP auf Bytes – übrig bleibt in beiden Fällen nur ASCII)
  const key = strtolower(item).replace(/[^a-z0-9]/g, '').slice(0, 24);
  await exec('INSERT INTO block_clicks_daily (block_id, item, day, page_id, clicks) VALUES (?, ?, ?, ?, 1) ON DUPLICATE KEY UPDATE clicks = clicks + 1', [blockId, key, today, pageId]);
  await exec('INSERT INTO stats_daily (page_id, day, clicks) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE clicks = clicks + 1', [pageId, today]);
  await exec('UPDATE page_blocks SET clicks = clicks + 1 WHERE id = ?', [blockId]);
}

// oys_request_from_own_site(): kommt die Anfrage von unserer eigenen Seite? (einfacher Schutz gegen fremdes Hochzählen)
export function requestFromOwnSite(ctx: Ctx): boolean {
  const h = ctx.headers;
  // $_SERVER['HTTP_ORIGIN'] ?? $_SERVER['HTTP_REFERER'] ?? '' – ein leerer Origin-Kopf zählt als gesetzt
  const origin = h.origin !== undefined ? String(h.origin) : h.referer !== undefined ? String(h.referer) : '';
  if (origin === '' || origin === 'null') return true;
  const parsed = phpParseUrl(origin) as false | { host?: string };
  const host = strtolower(parsed === false ? '' : phpStr(parsed.host ?? ''));
  // Auf einer eigenen Domain zählen Aufrufe von genau dieser Domain (welche Seite, prüft domains/host.ts)
  if (ctx.customDomain && host === ctx.host) return true;
  const base = baseHost();
  return host === base || host.endsWith('.' + base);
}

// ---------------------------------------------------------------- Tage rechnen (Ortszeit; Mitternacht bleibt Mitternacht)

// Tag als laufende Nummer (proleptischer gregorianischer Kalender, auch vor Jahr 1 wie PHP)
function dayNumber(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function fromDayNumber(n: number): [number, number, number] {
  const z = n + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}

// format('Y-m-d'): Jahr mit mindestens vier Ziffern, davor „-“ vor Christus
function ymd(n: number): string {
  const [y, m, d] = fromDayNumber(n);
  const year = (y < 0 ? '-' : '') + String(Math.abs(y)).padStart(4, '0');
  return year + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

// new DateTimeImmutable('YYYY-MM-DD') aus der Datenbank (DATE): Überläufe wie PHP weiterrechnen ('0000-00-00' → -0001-11-30).
// Etwas anderes liefert eine DATE-Spalte nicht – PHP würde dann eine Ausnahme werfen, hier ebenso.
function parseDay(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`DateTimeImmutable::__construct(): Failed to parse time string (${s})`);
  const month = Number(m[2]) - 1;
  const y = Number(m[1]) + Math.floor(month / 12);
  return dayNumber(y, (((month % 12) + 12) % 12) + 1, 1) + Number(m[3]) - 1;
}

export interface StatsLink {
  id: unknown;
  item: unknown;
  title: unknown;
  kind: string;
  icon: string;
  url?: unknown;
  clicks: number;
  total: number | null;
}

export interface StatsResult {
  range: number;
  from: string;
  bucket: number;
  views: number;
  clicks: number;
  ctr: number;
  total_views: number;
  series: Array<{ day: string; views: number; clicks: number }>;
  links: StatsLink[];
  best: StatsLink | null;
}

// Parameter vom Typ string einer PHP-Funktion (ohne strict_types): Zahlen und Wahrheitswerte werden Text, null und
// Arrays lösen einen TypeError aus (die Anfrage endet dann mit 500)
function stringArg(v: unknown): string {
  if (v === null || v === undefined || typeof v === 'object') throw new TypeError('oys_social_url(): Argument #1 ($platform) must be of type string');
  return phpStr(v);
}

// oys_stats(): Auswertung für den Editor. days = 0 bedeutet „gesamt“.
export async function stats(page: Row, days: number): Promise<StatsResult> {
  const pageId = intval(page.id);
  const today = parseDay(date('Y-m-d'));

  let from: number;
  if (days > 0) {
    from = today - (days - 1);
  } else {
    const min = await value('SELECT MIN(day) FROM stats_daily WHERE page_id = ?', [pageId]);
    from = phpTruthy(min) ? parseDay(String(min)) : today - 29;
    if (from > today - 6) from = today - 6;
  }

  const byDay = new Map<string, Row>();
  for (const row of await q('SELECT day, views, clicks FROM stats_daily WHERE page_id = ? AND day >= ? ORDER BY day', [pageId, ymd(from)])) {
    byDay.set(String(row.day), row);
  }

  // Lückenlos auffüllen; bei langen Zeiträumen nach Wochen bündeln
  const series: StatsResult['series'] = [];
  const span = Math.abs(today - from) + 1;
  const bucket = span > 120 ? 7 : 1;
  for (let d = from; d <= today; d += bucket) {
    let views = 0;
    let clicks = 0;
    for (let i = 0; i < bucket; i++) {
      const row = byDay.get(ymd(d + i));
      if (row) {
        views += intval(row.views);
        clicks += intval(row.clicks);
      }
    }
    series.push({ day: ymd(d), views, clicks });
  }

  const views = series.reduce((s, x) => s + x.views, 0);
  const clicks = series.reduce((s, x) => s + x.clicks, 0);

  // Klicks je Block (und je Plattform bei Social-Icons)
  const clicksBy = new Map<string, number>();
  for (const row of await q('SELECT block_id, item, SUM(clicks) AS clicks FROM block_clicks_daily WHERE page_id = ? AND day >= ? GROUP BY block_id, item', [pageId, ymd(from)])) {
    clicksBy.set(phpStr(row.block_id) + '|' + phpStr(row.item), intval(row.clicks));
  }

  const links: StatsLink[] = [];
  const brandList = brands();
  const types = blockTypes();
  for (const b of await loadBlocks(pageId)) {
    const d = b.data;
    if (b.type === 'socials') {
      for (const item of values(own(d, 'items') ?? [])) {
        // "abc"['p'] ist in PHP 8 ein Fehler; Zahlen/null ergeben null (→ TypeError beim Aufruf unten)
        if (typeof item === 'string') throw new TypeError('Cannot access offset of type string on string');
        const p = own(item, 'p') ?? null;
        if (socialUrl(stringArg(p), phpStr(own(item, 'v') ?? null)) === '') continue;
        const key = phpStr(p);
        links.push({
          id: b.id,
          item: p,
          title: Object.hasOwn(brandList, key) ? brandList[key].name : null,
          kind: 'Social icon',
          icon: 'brand:' + key,
          clicks: clicksBy.get(b.id + '|' + key) ?? 0,
          total: null,
        });
      }
      continue;
    }
    if (!['link', 'booking', 'file', 'image', 'countdown', 'embed'].includes(b.type)) continue;
    if (['image', 'countdown', 'embed'].includes(b.type) && !(clicksBy.get(b.id + '|') ?? 0)) continue;
    let title = own(d, 'title') ?? '';
    if (title === '') title = Object.hasOwn(types, b.type) ? types[b.type] : 'Block';
    links.push({
      id: b.id,
      item: '',
      title,
      kind: Object.hasOwn(types, b.type) ? types[b.type] : '',
      icon: b.type === 'link' ? phpStr(own(d, 'icon') ?? '') : '',
      url: own(d, 'url') ?? '',
      clicks: clicksBy.get(b.id + '|') ?? 0,
      total: b.clicks,
    });
  }
  // usort ist seit PHP 8 stabil – Array.prototype.sort auch
  links.sort((a, z) => z.clicks - a.clicks);

  return {
    range: days,
    from: ymd(from),
    bucket,
    views,
    clicks,
    ctr: views > 0 ? phpRound((clicks / views) * 100, 1) : 0,
    total_views: intval(page.views),
    series,
    links,
    best: links.length && links[0].clicks > 0 ? links[0] : null,
  };
}
