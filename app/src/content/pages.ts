// Seiten (bis zu 3 pro Konto): Laden, Anlegen, Speichern, Löschen (lib/pages.php).
// Eigenes CSS (oys_clean_css, oys_css_unescape, oys_css_external) steht in src/css.ts.
import { unlinkSync } from 'node:fs';
import type { ResultSetHeader } from 'mysql2/promise';
import { q, one, exec, value, transaction, type Param, type Row } from '../db.js';
import { cleanCss } from '../css.js';
import { cleanText, cleanUrl, pageUrl, pageUrls, type PageLike } from '../helpers.js';
import { safeEqual } from '../crypto.js';
import { phpJson } from '../html.js';
import { ctypeDigit, date, intval, mbSubstr, phpStr, phpTruthy, strtolower } from '../php.js';
import { codeUsedUploads } from '../code/sites.js';
import { isFile, uploadsDir } from './storage.js';
import { DEFAULT_THEME, fontChoices, layoutKey, themeKey } from './themes.js';
import { IMAGE_EXTS, blockNormalize, bookingIsInternal, calendarKey, pick, scheduleActive, validUpload } from './blocks.js';
import { ogSupported, ogUrl } from './share.js';
import { arrayKey, arrayReplace, isArr, jsonDecode, own, phpArray, toObject, values, type PhpArr } from './util.js';

// Einstellungen nach oys_settings_normalize(): feste Schlüssel in fester Reihenfolge
export interface Settings {
  accent: string;
  font: string;
  button: string;
  avatar_shape: string;
  avatar_ring: string;
  particles: string;
  cursor_sparks: boolean;
  bg_overlay: number;
  entrance: { enabled: boolean; text: string; animation: string; music: string; music_url: string; volume: number; loop: boolean };
  seo: { title: string; description: string; keywords: string };
  custom_css: string;
  hide_branding: boolean;
  notify_email: boolean;
  share_button: boolean;
}

// Einstellungen aus der Datenbank (oys_page_settings): Werte wie gespeichert, ohne Typprüfung, alte Zusatz-Schlüssel hinten
export type PageSettings = Record<string, unknown> & { entrance: Record<string, unknown>; seo: Record<string, unknown>; custom_css: string };

// Block wie aus oys_load_blocks()
export interface Block {
  id: number;
  type: string;
  is_visible: number;
  data: PhpArr;
  schedule: PhpArr | null;
  protection: string;
  has_password: boolean;
  password_hash: string | null;
  effect: string;
  clicks: number;
}

// Block für den Editor (ohne Passwort-Hash)
export interface EditorBlock {
  id: unknown;
  type: unknown;
  visible: boolean;
  data: Record<string, unknown>;
  schedule: unknown;
  protection: unknown;
  has_password: boolean;
  password: '';
  effect: unknown;
  clicks: number;
}

export interface EditorPage {
  id: number;
  slug: unknown;
  title: unknown;
  subtitle: unknown;
  bio: string;
  avatar: string;
  bg_image: string;
  theme: string;
  layout: string;
  address_mode: 'path' | 'subdomain';
  settings: PageSettings;
  urls: { subdomain: string; path: string };
  url: string;
  og: string;
}

// oys_default_settings()
export function defaultSettings(): Settings {
  return {
    accent: '',
    font: '',
    button: '',
    avatar_shape: 'circle',
    avatar_ring: 'none',
    particles: 'none',
    cursor_sparks: false,
    bg_overlay: 45,
    entrance: { enabled: false, text: 'Tap to enter', animation: 'zoom', music: '', music_url: '', volume: 70, loop: true },
    seo: { title: '', description: '', keywords: '' },
    custom_css: '',
    hide_branding: false,
    notify_email: true,
    share_button: true,
  };
}

// oys_page_settings()
export function pageSettings(page: { settings?: unknown }): PageSettings {
  const decoded = jsonDecode(phpStr(page.settings ?? ''));
  const stored: PhpArr = isArr(decoded) ? decoded : [];
  const defaults = defaultSettings();
  const settings = arrayReplace(defaults as unknown as PhpArr, stored) as PageSettings;
  for (const nested of ['entrance', 'seo'] as const) {
    const s = own(stored, nested);
    settings[nested] = arrayReplace(defaults[nested], isArr(s) ? s : []) as Record<string, unknown>;
  }
  // Auch übernommenes CSS aus der alten Version nie ungeprüft ausgeben
  settings.custom_css = cleanCss(settings.custom_css);
  return settings;
}

// oys_settings_normalize(): Einstellungen aus dem Editor prüfen
export function settingsNormalize(input: unknown, userId: number, premium: boolean, old: unknown): Settings {
  const inp: PhpArr = isArr(input) ? input : [];
  const s = defaultSettings();
  // ?? wie in PHP: nur null und „nicht gesetzt“ zählen als leer
  const get = (from: unknown, key: string, fallback: unknown): unknown => own(from, key) ?? fallback;
  const isSet = (from: unknown, key: string): boolean => own(from, key) !== undefined && own(from, key) !== null;

  const accent = phpStr(get(inp, 'accent', ''));
  s.accent = /^#[0-9a-fA-F]{6}(?=\n?$)/.test(accent) ? strtolower(accent) : '';
  s.font = Object.hasOwn(fontChoices(), phpStr(get(inp, 'font', ''))) ? phpStr(own(inp, 'font')) : '';
  s.button = pick(get(inp, 'button', ''), ['', 'rounded', 'pill', 'square'], '');
  s.avatar_shape = pick(get(inp, 'avatar_shape', 'circle'), ['circle', 'rounded', 'square'], 'circle');
  s.avatar_ring = pick(get(inp, 'avatar_ring', 'none'), ['none', 'accent', 'rainbow', 'story', 'pulse'], 'none');
  s.particles = pick(get(inp, 'particles', 'none'), ['none', 'snow', 'confetti', 'fireflies'], 'none');
  s.cursor_sparks = phpTruthy(own(inp, 'cursor_sparks'));
  s.bg_overlay = Math.max(0, Math.min(90, intval(get(inp, 'bg_overlay', 45))));

  const enIn = own(inp, 'entrance');
  const en: PhpArr = isArr(enIn) ? enIn : [];
  // Musik per Link: MP3 oder YouTube (auch ohne https:// eingegeben)
  const musicUrl = cleanUrl(phpStr(get(en, 'music_url', '')));
  const text = cleanText(get(en, 'text', ''), 60);
  s.entrance = {
    enabled: phpTruthy(own(en, 'enabled')),
    text: phpTruthy(text) ? text : 'Tap to enter',
    animation: pick(get(en, 'animation', 'zoom'), ['fade', 'zoom', 'curtain', 'blur', 'flip'], 'zoom'),
    music: validUpload(get(en, 'music', ''), userId, ['mp3', 'm4a', 'ogg', 'wav']) ?? '',
    music_url: /^https:\/\//i.test(musicUrl) ? musicUrl : '',
    volume: Math.max(0, Math.min(100, intval(get(en, 'volume', 70)))),
    loop: !isSet(en, 'loop') || phpTruthy(own(en, 'loop')),
  };

  const seoIn = own(inp, 'seo');
  const seo: PhpArr = isArr(seoIn) ? seoIn : [];
  s.seo = {
    title: cleanText(get(seo, 'title', ''), 120),
    description: cleanText(get(seo, 'description', ''), 300),
    keywords: cleanText(get(seo, 'keywords', ''), 255),
  };

  s.custom_css = cleanCss(get(inp, 'custom_css', ''));
  // Branding ausblenden ist nur mit Premium möglich – sonst alten Wert behalten
  s.hide_branding = premium ? phpTruthy(own(inp, 'hide_branding')) : phpTruthy(own(old, 'hide_branding'));
  s.notify_email = !isSet(inp, 'notify_email') || phpTruthy(own(inp, 'notify_email'));
  s.share_button = !isSet(inp, 'share_button') || phpTruthy(own(inp, 'share_button'));
  return s;
}

// ---------------------------------------------------------------
// Laden
// ---------------------------------------------------------------

// oys_load_page()
export const loadPage = (id: number): Promise<Row | null> => one('SELECT * FROM pages WHERE id = ?', [id]);
// oys_load_page_by_slug()
export const loadPageBySlug = (slug: string): Promise<Row | null> => one('SELECT * FROM pages WHERE slug = ? LIMIT 1', [slug]);
// oys_user_pages(): Reihenfolge wie im Editor
export const userPages = (userId: number): Promise<Row[]> => q('SELECT * FROM pages WHERE user_id = ? ORDER BY position ASC, id ASC', [userId]);

// oys_load_blocks()
export async function loadBlocks(pageId: number): Promise<Block[]> {
  const rows = await q('SELECT * FROM page_blocks WHERE page_id = ? ORDER BY position ASC, id ASC', [pageId]);
  return rows.map(blockFromRow);
}

// oys_block_from_row(): Daten und Zeitsteuerung aus JSON; kaputtes JSON → leere Daten bzw. keine Zeitsteuerung
export function blockFromRow(row: Row): Block {
  const data = jsonDecode(phpStr(row.data ?? ''));
  const schedule = jsonDecode(phpStr(row.schedule ?? ''));
  return {
    id: intval(row.id),
    type: row.type as string,
    is_visible: intval(row.is_visible),
    data: isArr(data) ? data : [],
    schedule: isArr(schedule) ? schedule : null,
    protection: phpTruthy(row.protection) ? (row.protection as string) : 'none',
    has_password: phpTruthy(row.password_hash),
    password_hash: (row.password_hash ?? null) as string | null,
    effect: phpTruthy(row.effect) ? (row.effect as string) : 'none',
    clicks: intval(row.clicks),
  };
}

// oys_block_for_editor(): Form für den Editor (ohne Passwort-Hash); data ist immer ein Objekt
export function blockForEditor(b: Block): EditorBlock {
  return {
    id: b.id,
    type: b.type,
    visible: phpTruthy(b.is_visible),
    data: toObject(b.data),
    schedule: phpTruthy(b.schedule) ? b.schedule : { enabled: false, days: [], from: '', to: '', start: '', end: '' },
    protection: b.protection,
    has_password: phpTruthy(b.has_password ?? false),
    password: '',
    effect: b.effect,
    clicks: intval(b.clicks ?? 0),
  };
}

// oys_page_for_editor()
export function pageForEditor(page: Row): EditorPage {
  return {
    id: intval(page.id),
    slug: page.slug ?? null,
    title: page.title ?? null,
    subtitle: page.subtitle ?? null,
    bio: phpStr(page.bio),
    avatar: phpStr(page.avatar),
    bg_image: phpStr(page.bg_image),
    theme: themeKey(page.theme),
    layout: layoutKey(page.layout),
    address_mode: page.address_mode === 'path' ? 'path' : 'subdomain',
    settings: pageSettings(page),
    urls: pageUrls(page as unknown as PageLike),
    url: pageUrl(page as unknown as PageLike),
    og: ogSupported() ? ogUrl(page) : '',
  };
}

// ---------------------------------------------------------------
// Anlegen
// ---------------------------------------------------------------

// oys_create_page(): neue Seite samt Startinhalt; gibt die neue ID zurück
export async function createPage(userId: number, slug: string, title: string): Promise<number> {
  const position = intval(await value('SELECT COUNT(*) FROM pages WHERE user_id = ?', [userId]));
  const now = date('Y-m-d H:i:s');
  const { insertId } = await exec(
    "INSERT INTO pages (user_id, slug, position, title, subtitle, bio, theme, layout, address_mode, settings, created_at, updated_at)\n        VALUES (?, ?, ?, ?, '', '', ?, 'buttons', 'subdomain', ?, ?, ?)",
    [userId, slug, position, mbSubstr(title, 0, 120), DEFAULT_THEME, phpJson(defaultSettings(), { unescapedUnicode: true }), now, now],
  );
  const pageId = intval(insertId);

  // Startinhalt, damit niemand vor einer leeren Seite sitzt
  const starter: Array<[string, unknown]> = [
    ['socials', { items: [{ p: 'instagram', v: '' }, { p: 'tiktok', v: '' }, { p: 'youtube', v: '' }], style: 'icons' }],
    ['link', { title: 'My first link', url: '', subtitle: '', icon: '', thumb: '', featured: false }],
  ];
  for (const [i, [type, data]] of starter.entries()) {
    await exec('INSERT INTO page_blocks (page_id, type, position, is_visible, data, created_at) VALUES (?, ?, ?, 1, ?, ?)',
      [pageId, type, i, phpJson(data, { unescapedUnicode: true }), now]);
  }
  return pageId;
}

// ---------------------------------------------------------------
// Speichern (aus dem Editor)
// ---------------------------------------------------------------

export interface SaveResult {
  page: Row | null;
  blocks: Block[];
  // Editor-ID (z. B. "n3") → neue ID; immer ein Objekt, Schlüssel in der Reihenfolge der Blöcke
  idmap: Record<string, number>;
  warnings: string[];
}

// oys_save_page(): Seite und Blöcke in einer Transaktion speichern, danach ungenutzte Dateien löschen
export async function savePage(page: Row, input: PhpArr, userId: number, premium: boolean): Promise<SaveResult> {
  const pIn = own(input, 'page');
  const p: PhpArr = isArr(pIn) ? pIn : [];
  const pageId = page.id as Param;
  const oldSettings = pageSettings(page);
  const oldFiles = pageFiles(page, await loadBlocks(intval(page.id)));

  const fields: Array<[string, Param]> = [
    ['title', cleanText(own(p, 'title') ?? '', 120)],
    ['subtitle', cleanText(own(p, 'subtitle') ?? '', 160)],
    ['bio', cleanText(own(p, 'bio') ?? '', 1000, true)],
    ['avatar', validUpload(own(p, 'avatar') ?? '', userId, IMAGE_EXTS)],
    ['bg_image', validUpload(own(p, 'bg_image') ?? '', userId, IMAGE_EXTS)],
    ['theme', themeKey(own(p, 'theme') ?? DEFAULT_THEME)],
    ['layout', layoutKey(own(p, 'layout') ?? 'buttons')],
    ['settings', phpJson(settingsNormalize(own(p, 'settings') ?? [], userId, premium, oldSettings), { unescapedUnicode: true })],
    ['updated_at', date('Y-m-d H:i:s')],
  ];

  const existing = new Map<number, Row>();
  for (const row of await q('SELECT * FROM page_blocks WHERE page_id = ?', [pageId])) existing.set(intval(row.id), row);

  const warnings: string[] = [];
  const idMap: Array<[string, number]> = [];
  const kept = new Set<number>();
  const now = date('Y-m-d H:i:s');

  await transaction(async (conn) => {
    const sets = fields.map(([k]) => `${k} = ?`).join(', ');
    await conn.query(`UPDATE pages SET ${sets} WHERE id = ?`, [...fields.map(([, v]) => v), pageId]);

    const update = 'UPDATE page_blocks SET type = ?, position = ?, is_visible = ?, data = ?, schedule = ?, protection = ?, password_hash = ?, effect = ? WHERE id = ? AND page_id = ?';
    const insert = 'INSERT INTO page_blocks (page_id, type, position, is_visible, data, schedule, protection, password_hash, effect, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

    let position = 0;
    const blocksIn = own(input, 'blocks');
    for (const blockIn of values(isArr(blocksIn) ? blocksIn : []).slice(0, 150)) {
      if (!isArr(blockIn)) continue;
      const id = own(blockIn, 'id') ?? null;
      // (string) $id: -0.0 (nur als Kommazahl möglich, json_decode macht aus "-0" eine 0) ist in PHP "-0"
      const idText = Object.is(id, -0) ? '-0' : phpStr(id);
      // is_int($id) || ctype_digit((string) $id)
      const known = (typeof id === 'number' && Number.isInteger(id) && idText !== '-0') || ctypeDigit(idText);
      const old = known ? (existing.get(intval(id)) ?? null) : null;
      const norm = await blockNormalize(blockIn, userId, old);
      if (!norm) continue;
      if (norm.warning) warnings.push(norm.warning);
      const vals: Param[] = [
        norm.type, position++, norm.is_visible,
        phpJson(norm.data, { unescapedUnicode: true }),
        norm.schedule ? phpJson(norm.schedule) : null,
        norm.protection, norm.password_hash, norm.effect,
      ];
      if (old) {
        await conn.query(update, [...vals, old.id as Param, pageId]);
        kept.add(intval(old.id));
      } else {
        const [res] = await conn.query<ResultSetHeader>(insert, [pageId, ...vals, now]);
        const newId = intval(res.insertId);
        kept.add(newId);
        if (id !== null) idMap.push([idText, newId]);
      }
    }

    const removed = [...existing.keys()].filter((k) => !kept.has(k));
    if (removed.length) {
      const list = removed.map((x) => intval(x)).join(',');
      await conn.query(`DELETE FROM page_blocks WHERE page_id = ${intval(page.id)} AND id IN (${list})`);
      await conn.query(`DELETE FROM block_clicks_daily WHERE block_id IN (${list})`);
    }
  });

  const fresh = await loadPage(intval(page.id));
  await cleanupFiles(userId, oldFiles);

  return {
    page: fresh,
    blocks: await loadBlocks(intval(page.id)),
    idmap: toObject(phpArray(idMap)) as Record<string, number>,
    warnings: [...new Set(warnings)],
  };
}

// array_unique() + array_values(): Vergleich als Text, der erste Eintrag bleibt
function arrayUnique(list: unknown[]): unknown[] {
  const seen = new Set<string>();
  return list.filter((v) => {
    const k = phpStr(v);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// oys_page_files(): alle Upload-Dateien, die eine Seite verwendet
export function pageFiles(page: Row, blocks: ReadonlyArray<{ data: unknown }>): unknown[] {
  const files: unknown[] = [];
  const settings = pageSettings(page);
  for (const f of [page.avatar ?? '', page.bg_image ?? '', own(settings.entrance, 'music') ?? '']) {
    if (phpTruthy(f)) files.push(f);
  }
  for (const b of blocks) {
    const d = b.data;
    for (const k of ['thumb', 'src']) {
      const f = own(d, k);
      if (phpTruthy(f) && typeof f === 'string') files.push(f);
    }
    // (array) $x: ein einzelner Wert wird zur Liste
    const images = own(d, 'images') ?? [];
    for (const img of isArr(images) ? values(images) : [images]) {
      const src = own(img, 'src');
      if (phpTruthy(src)) files.push(src);
    }
  }
  return arrayUnique(files);
}

// oys_calendar_access(): darf der eingebaute Kalender gezeigt werden? Nur mit aktivem Termin-Block, der auf ihn zeigt.
// '' = frei zugänglich, Schlüssel = über einen geschützten Termin-Block freigegeben, null = nein.
export async function calendarAccess(page: Row, given: string): Promise<string | null> {
  const now = Date.now() / 1000;
  let access: string | null = null;
  for (const b of await loadBlocks(intval(page.id))) {
    if (b.type !== 'booking' || !phpTruthy(b.is_visible) || !scheduleActive(b.schedule, now) || !bookingIsInternal(b.data, page as unknown as PageLike)) continue;
    if (b.protection === 'none') return '';
    const key = calendarKey(page, b);
    if (given !== '' && safeEqual(key, given)) access = key;
  }
  return access;
}

// oys_used_files(): alle Dateien, die eine Seite des Nutzers (oder seine Code-Seite) verwendet
export async function usedFiles(userId: number): Promise<Set<string>> {
  const used = await codeUsedUploads(userId);
  for (const p of await userPages(userId)) {
    for (const f of pageFiles(p, await loadBlocks(intval(p.id)))) used.add(arrayKey(f));
  }
  return used;
}

// oys_cleanup_files(): löscht Dateien, die von keiner Seite des Nutzers mehr verwendet werden
export async function cleanupFiles(userId: number, candidates: readonly unknown[]): Promise<void> {
  if (!candidates.length) return;
  const used = await usedFiles(userId);
  const dir = uploadsDir() + '/';
  for (const file of candidates) {
    if (!used.has(arrayKey(file)) && validUpload(file, userId) && isFile(dir + phpStr(file))) {
      try {
        unlinkSync(dir + phpStr(file));
      } catch {
        // wie @unlink: Fehler still übergehen
      }
    }
  }
}

// oys_delete_page(): Seite mit Blöcken, Statistik und Nachrichten löschen, danach ungenutzte Dateien
export async function deletePage(page: Row): Promise<void> {
  const id = intval(page.id);
  const files = pageFiles(page, await loadBlocks(id));
  await transaction(async (conn) => {
    await conn.query('DELETE FROM block_clicks_daily WHERE page_id = ?', [id]);
    await conn.query('DELETE FROM stats_daily WHERE page_id = ?', [id]);
    await conn.query('DELETE FROM page_blocks WHERE page_id = ?', [id]);
    await conn.query('DELETE FROM messages WHERE page_id = ?', [id]);
    await conn.query('DELETE FROM pages WHERE id = ?', [id]);
  });
  await cleanupFiles(intval(page.user_id), files);
}

// oys_sync_username(): hält users.username (für Admin & alte Mail-Vorlagen) auf der ersten Seite
export async function syncUsername(userId: number): Promise<void> {
  const pages = await userPages(userId);
  if (pages.length) {
    try {
      await exec('UPDATE users SET username = ? WHERE id = ?', [pages[0].slug as Param, userId]);
    } catch (err) {
      console.error('username sync failed: ' + (err as Error).message);
    }
  }
}

