// Saison-Themes für OnYourSites eigene Seiten (Startseite, Anmelden, Updates, Roadmap, Vorschläge, rechtliche Seiten,
// 404) – nicht für die Seiten der Nutzer, den Editor oder den Admin-Bereich. Der Admin schaltet jedes Thema unter
// Admin → Seasons aus, an oder automatisch in einem Zeitraum (Monat-Tag, auch über den Jahreswechsel). Ist keins aktiv,
// bleibt jede Seite Byte für Byte, wie sie war.
// Einstellungen: oys_meta['site_seasons'] = {"winter": {"mode": "auto", "from": "12-01", "to": "01-06"}}
import { exec, value } from '../db.js';
import { asset } from '../helpers.js';
import { date } from '../php.js';
import type { Ctx } from '../web/ctx.js';

export type SeasonMode = 'off' | 'on' | 'auto';
export interface SeasonTheme {
  name: string;
  desc: string;
  css: string; // Stylesheet unter /static/css
  mode: SeasonMode; // Vorgabe, solange der Admin für dieses Thema nichts gespeichert hat
  from: string; // Vorgabe für „automatisch“ (MM-DD)
  to: string;
  swatch: string; // Farbe der Karte im Admin
}
export interface SeasonSetting { mode: SeasonMode; from: string; to: string }

export const SEASONS: Readonly<Record<string, SeasonTheme>> = Object.freeze({
  winter: Object.freeze({
    name: 'Winter', desc: 'Falling snow, fairy lights along the top, a Santa hat on the logo and a frosty glow.',
    css: '/static/css/season-winter.css', mode: 'auto', from: '12-01', to: '01-06', swatch: '#bfdbfe',
  }),
});

export const SEASONS_META_KEY = 'site_seasons';
const MMDD = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const isMonthDay = (v: unknown): v is string => typeof v === 'string' && MMDD.test(v) && validDay(v);
// 02-30 und 04-31 gibt es nicht (02-29 schon: in Schaltjahren)
function validDay(v: string): boolean {
  const [m, d] = v.split('-').map(Number);
  return d <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

// Gespeicherte Einstellungen, ergänzt um die Vorgaben (unbekannte Themen und kaputte Werte fallen weg)
export function normalizeSettings(raw: unknown): Record<string, SeasonSetting> {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }
  }
  const src = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  const out: Record<string, SeasonSetting> = {};
  for (const [key, theme] of Object.entries(SEASONS)) {
    const stored = src[key] && typeof src[key] === 'object' ? src[key] as Record<string, unknown> : null;
    const s = stored ?? {};
    // Noch nie gespeichert: die Vorgabe des Themas (Winter: automatisch); ein kaputter gespeicherter Wert ist „Off“
    const mode = stored === null ? theme.mode : s.mode === 'on' || s.mode === 'auto' ? s.mode : 'off';
    out[key] = { mode, from: isMonthDay(s.from) ? s.from : theme.from, to: isMonthDay(s.to) ? s.to : theme.to };
  }
  return out;
}

// Liegt der Tag (MM-DD) im Zeitraum? from > to läuft über den Jahreswechsel (12-01 bis 01-06)
export function inWindow(day: string, from: string, to: string): boolean {
  return from <= to ? day >= from && day <= to : day >= from || day <= to;
}

// Das aktive Thema: „on“ vor „auto“ im Zeitraum; der Reihe nach das erste
export function pickSeason(settings: Record<string, SeasonSetting>, day: string): string | null {
  for (const [key, s] of Object.entries(settings)) if (s.mode === 'on') return key;
  for (const [key, s] of Object.entries(settings)) if (s.mode === 'auto' && inWindow(day, s.from, s.to)) return key;
  return null;
}

export async function loadSettings(): Promise<Record<string, SeasonSetting>> {
  return normalizeSettings(await value('SELECT meta_value FROM oys_meta WHERE meta_key = ?', [SEASONS_META_KEY]));
}

export async function saveSettings(settings: Record<string, SeasonSetting>): Promise<void> {
  await exec('REPLACE INTO oys_meta (meta_key, meta_value) VALUES (?, ?)', [SEASONS_META_KEY, JSON.stringify(normalizeSettings(settings))]);
  cache = null;
}

// Je Prozess kurz zwischengespeichert: jede Seite fragt sonst die Datenbank
const CACHE_MS = 15_000;
let cache: { at: number; settings: Record<string, SeasonSetting> } | null = null;
export function forgetSeasonCache(): void {
  cache = null;
}
export async function activeSeason(now = Date.now()): Promise<string | null> {
  if (!cache || now - cache.at > CACHE_MS) {
    let settings: Record<string, SeasonSetting>;
    try {
      settings = await loadSettings();
    } catch {
      // Datenbank nicht erreichbar: die Seite kommt ohne Saison-Thema
      settings = normalizeSettings({});
    }
    cache = { at: now, settings };
  }
  return pickSeason(cache.settings, date('m-d', Math.floor(now / 1000)));
}

// Das Thema in eine fertige Seite einbauen: Stylesheet vor </head>, Klasse season-<key> an <body>, die Deko gleich
// danach. Ohne <head>/<body> (z. B. ein Ausschnitt) bleibt die Seite, wie sie ist.
export function applySeason(html: string, key: string): string {
  const theme = SEASONS[key];
  if (!theme) return html;
  const head = html.indexOf('</head>');
  const bodyMatch = /<body\b[^>]*>/i.exec(html);
  if (head === -1 || !bodyMatch || bodyMatch.index < head) return html;
  let body = bodyMatch[0];
  const cls = /\sclass="([^"]*)"/i.exec(body);
  body = cls ? body.replace(cls[0], () => ' class="' + (cls[1] ? cls[1] + ' ' : '') + 'season-' + key + '"') : body.replace(/>$/, ' class="season-' + key + '">');
  // Deko unter der Navigation (Schnee, Schein)
  const deco = '<div class="oys-season" aria-hidden="true"><span class="oys-season-1"></span><span class="oys-season-2"></span><span class="oys-season-3"></span></div>';
  const link = '<link rel="stylesheet" href="' + asset(theme.css) + '">';
  const afterBody = bodyMatch.index + bodyMatch[0].length;
  let rest = html.slice(afterBody);
  // Schnee, der unten liegt: im ersten <footer> (Klasse oys-season-footer, die Verwehung gleich hinter dem Tag) –
  // ohne Footer unten am Fenster
  const footer = /<footer\b[^>]*>/i.exec(rest);
  const drift = '<div class="oys-season-drift" aria-hidden="true"></div>';
  if (footer) {
    let tag = footer[0];
    const fc = /\sclass="([^"]*)"/i.exec(tag);
    tag = fc ? tag.replace(fc[0], () => ' class="' + (fc[1] ? fc[1] + ' ' : '') + 'oys-season-footer"') : tag.replace(/>$/, ' class="oys-season-footer">');
    rest = rest.slice(0, footer.index) + tag + drift + rest.slice(footer.index + footer[0].length);
  }
  // Die Lichterkette: in der fixierten Kopfzeile ganz hinten (unter Logo und Mütze), sonst oben am Fenster
  // Eine <nav> mit der Klasse „fixed“ (als eigenes Wort in class, nicht md:fixed oder fixed-top)
  const nav = /<nav\b[^>]*\sclass="(?:[^"]*\s)?fixed(?:\s[^"]*)?"[^>]*>/i.exec(rest);
  let lights = '';
  if (nav) rest = rest.slice(0, nav.index + nav[0].length) + '<div class="oys-season-lights in-nav" aria-hidden="true"></div>' + rest.slice(nav.index + nav[0].length);
  else lights = '<div class="oys-season-lights" aria-hidden="true"></div>';
  const bottom = (footer ? '' : '<div class="oys-season-drift is-fixed" aria-hidden="true"></div>') + lights;
  return html.slice(0, head) + link + html.slice(head, bodyMatch.index) + body + deco + bottom + rest;
}

// Seiten, die ein Saison-Thema bekommen (Adresse auf der Hauptseite); die 404-Seite setzt es selbst
const SEASON_PATHS = new Set(['/', '/login', '/register', '/updates', '/roadmap', '/suggestions', '/challenge', '/imprint', '/privacy', '/terms', '/terms/code-pages']);
export const isSeasonPath = (path: string): boolean => SEASON_PATHS.has(path) || /^\/(updates|suggestions)\/\d+$/.test(path);

// Nach der Antwort (server.ts): nur HTML-Seiten mit Status 200 oder 404, die als Saison-Seite markiert sind.
// ?season_preview=<thema> zeigt ein Thema schon vorher (für den Admin; ändert nichts Gespeichertes).
export async function seasonalBody(ctx: Ctx): Promise<void> {
  if (!ctx.seasonPage || typeof ctx.body !== 'string' || (ctx.status !== 200 && ctx.status !== 404) || ctx.method === 'HEAD') return;
  const type = ctx.header('Content-Type');
  if (type !== undefined && !/^text\/html\b/i.test(type)) return;
  const preview = ctx.q('season_preview');
  const key = preview !== '' && Object.hasOwn(SEASONS, preview) ? preview : await activeSeason();
  if (key === null) return;
  ctx.body = applySeason(ctx.body, key);
  // Die Länge stimmt nicht mehr, falls eine Seite sie gesetzt hat
  ctx.removeHeader('Content-Length');
}
