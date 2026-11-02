// Gemeinsame Hilfsfunktionen aus lib/helpers.php und blacklist.php – gleiche Namen ohne oys_, gleiche Ergebnisse.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { configString } from './config.js';
import { ROOT_DIR } from './config.js';
import { one, type Db } from './db.js';
import { md5Hex } from './crypto.js';
import { addressNameProblem, addressTaken, type AddressKind } from './content/addresses.js';
import { strtolower, phpStr, phpTruthy, rawurlencode, strtotime, date, time, phpLtrim } from './php.js';
import * as compat from './compat/core.js';
import type { Ctx } from './web/ctx.js';
import { domainsAvailable, reservedSlugs as domainReservedSlugs } from './domains/config.js';

// ---------------------------------------------------------------- Domains & Adressen

export const baseAuthority = (): string => strtolower(configString('base_domain', 'on-your.site'));
export const baseHost = (): string => baseAuthority().split(':')[0];
export const scheme = (): 'http' | 'https' => (configString('scheme', 'https') === 'http' ? 'http' : 'https');
export const mainUrl = (path = '/'): string => scheme() + '://' + baseAuthority() + path;
export const isMainHost = (host: string): boolean => host === baseHost() || host === 'www.' + baseHost();

// custom_domain: Live-Domain der Seite (pages.custom_domain, nur im Zustand active gesetzt) – dann ist sie die Hauptadresse
export interface PageLike { slug: unknown; address_mode?: unknown; custom_domain?: unknown }

// Eigene Domain (Premium): Ursprung https://<domain> – Schema wie die Seite, in lokalen Tests mit custom_domains.url_port
export const customOrigin = (host: string): string => scheme() + '://' + host + configString('custom_domains.url_port', '');
// Live-Domain einer Seite als Hauptadresse – nur, solange eigene Domains eingerichtet sind. Fehlen die Werte in
// config.json (z. B. nach einer Wiederherstellung ohne --domains), beantwortet der Router die Domain nicht: dann bleibt
// die OnYourSite-Adresse die Hauptadresse, statt auf eine Domain zu zeigen, die hier niemand bedient.
export const liveDomain = (p: PageLike): string => {
  const h = phpStr(p.custom_domain ?? '');
  return h !== '' && domainsAvailable() ? h : '';
};
const customUrl = (p: PageLike): string | null => {
  const h = liveDomain(p);
  return h !== '' ? customOrigin(h) : null;
};

// oys_page_urls(): Reihenfolge der Schlüssel zählt (api.php); custom nur mit Live-Domain (ohne bleibt alles wie bisher)
export function pageUrls(p: PageLike): { subdomain: string; path: string; custom?: string } {
  const slug = phpStr(p.slug);
  const urls: { subdomain: string; path: string; custom?: string } = {
    subdomain: scheme() + '://' + slug + '.' + baseAuthority(), path: scheme() + '://' + baseAuthority() + '/' + slug,
  };
  const c = customUrl(p);
  if (c !== null) urls.custom = c;
  return urls;
}
// OnYourSite-Adresse nach address_mode (ohne eigene Domain) – Ziel der Weiterleitungen zwischen Subdomain und Pfad
export function addressUrl(p: PageLike, sub = ''): string {
  const urls = pageUrls(p);
  const url = phpStr(p.address_mode) === 'path' ? urls.path : urls.subdomain;
  return sub !== '' ? url + '/' + phpLtrim(sub, '/') : url;
}
// oys_page_url(): Hauptadresse – die Live-Domain, sonst die OnYourSite-Adresse
export function pageUrl(p: PageLike, sub = ''): string {
  const c = customUrl(p);
  if (c === null) return addressUrl(p, sub);
  return sub !== '' ? c + '/' + phpLtrim(sub, '/') : c;
}
export const pageDisplayUrl = (p: PageLike): string => pageUrl(p).replace(/^https?:\/\//, '');
export const pageOrigin = (p: PageLike): string => customUrl(p) ?? (phpStr(p.address_mode) === 'path' ? mainUrl('') : pageUrls(p).subdomain);
export function onPageHost(ctx: Ctx, p: PageLike): boolean {
  const custom = liveDomain(p);
  if (custom !== '') return ctx.host === custom;
  if (phpStr(p.address_mode) === 'path') return isMainHost(ctx.host);
  return ctx.host === strtolower(phpStr(p.slug)) + '.' + baseHost();
}

// ---------------------------------------------------------------- Texte, Links, Adressen

export const cleanText = (v: unknown, max = 255, multiline = false): string => compat.oysCleanText(v, max, multiline) as string;
export const cleanUrl = (v: unknown, allowRelative = false): string => compat.oysCleanUrl(v, allowRelative) as string;
export const prettyUrl = (u: string): string => compat.oysPrettyUrl(u) as string;
export const normalizeSlug = (s: unknown): string => compat.oysNormalizeSlug(s) as string;
export const initials = (n: string): string => compat.oysInitials(n) as string;
export const isBot = (ua: string): boolean => compat.oysIsBot(ua) as boolean;
export const looksLikeSpam = (t: string): boolean => compat.oysLooksLikeSpam(t) as boolean;
export const validateEmail = (s: string): boolean => compat.phpValidateEmail(s) as boolean;
export const validateUrl = (s: string): boolean => compat.phpFilterValidateUrl(s) as boolean;

// blacklist.php: verbotene Subdomains (Listen aus PHP exportiert)
const BL = JSON.parse(readFileSync(new URL('./data/blacklist.json', import.meta.url), 'utf8')) as {
  subdomains: string[]; contains: string[]; regex: Array<{ source: string; flags: string }>;
};
const forbidden = compat.makeBlacklist({
  subdomains: BL.subdomains,
  contains: BL.contains,
  regex: BL.regex.map((r) => new RegExp(r.source, r.flags.replace(/[^imsu]/g, ''))),
}) as (s: string) => boolean;
export const isForbiddenSubdomain = (s: string): boolean => forbidden(s);

const RESERVED = ['login', 'logout', 'register', 'dashboard', 'admin', 'challenge', 'imprint', 'privacy', 'terms', 'api', 'static', 'track-click', 'kalender',
  'cron', 'lib', 'email', 'install', 'phpmailer', 'robots', 'sitemap', 'favicon', 'index', 'config', 'go', 'demo', 'impressum', 'datenschutz', 'agb', 'updates',
  'roadmap', 'changelog', 'news', 'feed', 'suggestions',
  // Statusseiten: status.<domain> ist OnYourSites eigene Statusseite, health.<domain> das Ziel der eigenen Prüfung
  'status', 'health'];
export const reservedPaths = (): string[] => RESERVED;

// Wer fragt (slugProblem): userId darf seine eigenen reservierten Adressen wieder nehmen, exceptStatusId ist die eigene
// Statusseite, kind die Art der neuen Seite (Namensregeln), db die feste Verbindung einer laufenden Transaktion
export interface SlugOptions {
  userId?: number | null;
  exceptStatusId?: number | null;
  kind?: AddressKind;
  db?: Db;
}

// oys_slug_problem(): Meldung oder null. Vergeben ist eine Adresse laut Liste aller Adressen (content/addresses.ts –
// auch reservierte zählen, außer den eigenen) und, als Rückhalt gegen Handarbeit in der Datenbank, wie bisher laut
// Link- und Code-Seiten. Ohne userId (404-Seite, Registrierung) zählt jede Reservierung als vergeben.
export async function slugProblem(slug: string, exceptPageId: number | null = null, exceptCodeId: number | null = null,
  opts: SlugOptions = {}): Promise<string | null> {
  if (slug === '') return 'Please enter an address.';
  const len = Buffer.byteLength(slug, 'utf8');
  if (len < 2 || len > 30) return 'The address must be 2–30 characters long.';
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug) || slug.includes('--')) return 'Only a–z, 0–9 and single hyphens are allowed (not at the start or end).';
  if (isForbiddenSubdomain(slug)) return `The address “${slug}” is reserved or not allowed.`;
  if (RESERVED.includes(slug)) return `The address “${slug}” is reserved.`;
  const named = addressNameProblem(slug, opts.kind ?? 'page');
  if (named !== null) return named;
  // Namen der eigenen Domains aus der Einrichtung (CNAME-Ziel, Rückfall-Ursprung) gehören nie einer Seite
  if (domainReservedSlugs(baseHost()).includes(slug)) return `The address “${slug}” is reserved.`;
  const sql: Pick<Db, 'one'> = opts.db ?? { one };
  const taken = `Sorry, the address “${slug}” is already taken.`;
  if (await addressTaken(slug, { pageId: exceptPageId, codeId: exceptCodeId, statusId: opts.exceptStatusId ?? null, userId: opts.userId ?? null }, sql)) return taken;
  if (await sql.one('SELECT id FROM pages WHERE slug = ? AND id <> ? LIMIT 1', [slug, exceptPageId ?? 0])) return taken;
  if (await sql.one('SELECT id FROM code_sites WHERE slug = ? AND id <> ? LIMIT 1', [slug, exceptCodeId ?? 0])) return taken;
  return null;
}

// ---------------------------------------------------------------- Dateien & Zeit

// oys_upload_url()
export const uploadUrl = (f: unknown): string => (phpTruthy(f) ? '/static/uploads/' + rawurlencode(phpStr(f)) : '');

// oys_asset(): ?v= aus der Änderungszeit der Datei (wie PHP: md5 der Sekunden, 8 Zeichen)
const assetCache = new Map<string, string>();
export function asset(path: string): string {
  let v = assetCache.get(path);
  if (v === undefined || process.env.OYS_DEV === '1') {
    try {
      const st = statSync(join(ROOT_DIR, path));
      v = st.isFile() ? md5Hex(String(Math.floor(st.mtimeMs / 1000))).slice(0, 8) : '1';
    } catch {
      v = '1';
    }
    assetCache.set(path, v);
  }
  return path + '?v=' + v;
}

// oys_time_ago()
export function timeAgo(dt: unknown): string {
  if (!phpTruthy(dt)) return '';
  const t = strtotime(phpStr(dt));
  const diff = time() - (t === false ? 0 : t);
  if (diff < 60) return 'just now';
  if (diff < 3600) {
    const m = Math.floor(diff / 60);
    return m === 1 ? '1 minute ago' : `${m} minutes ago`;
  }
  if (diff < 86400) {
    const h = Math.floor(diff / 3600);
    return h === 1 ? '1 hour ago' : `${h} hours ago`;
  }
  if (diff < 7 * 86400) {
    const d = Math.floor(diff / 86400);
    return d === 1 ? 'yesterday' : `${d} days ago`;
  }
  return date('M j, Y', t === false ? 0 : t);
}
