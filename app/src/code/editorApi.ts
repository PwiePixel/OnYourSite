// Editor-API der Code-Seiten (/dashboard/api/code*): mehrere Code-Seiten je Konto – höchstens eine an eigener Adresse,
// weitere auf Seitenplätzen (pages.code_site_id). Alles, was Plätze, Code-Seiten oder Adressen ändert, läuft unter
// withSlotLock(uid); die Regeln E1–E8 werden in der Sperre auf den gesperrten Zeilen geprüft (canCreate/canMove).
// Die Prüfungen vor der Sperre sind nur schnelle frühe Antworten. Was nach dem Commit läuft: rateHit, Dateien
// aufräumen, Benutzername abgleichen.
// Auth und CSRF kommen aus der Präambel von app/editorApi.ts (401 ohne Sitzung, 419 ohne gültigen Token).
import type { Ctx } from '../web/ctx.js';
import { exec, one, q, type Db, type Row } from '../db.js';
import { rateHit, rateLimit, rateOk } from '../web/security.js';
import { cleanText, normalizeSlug, pageDisplayUrl, slugProblem, uploadUrl, type PageLike } from '../helpers.js';
import { date, intval, phpStr, phpTruthy, strtotime, time } from '../php.js';
import { isArr, own, values, type PhpArr } from '../content/util.js';
import { cleanupFiles, createPage, syncUsername } from '../content/pages.js';
import { addressNameProblem, claimAddress, duplicateKey, isTakenError, releaseAddress } from '../content/addresses.js';
import { hasDomain } from '../domains/index.js';
import { hcBalance } from '../honeycombs/honeycombs.js';
import { has } from '../honeycombs/entitlements.js';
import { shopPrice } from '../honeycombs/catalogue.js';
import { REQUEST_ID, adminMode, buy } from '../honeycombs/shop.js';
import { isStaff } from '../app/context.js';
import {
  CODE_TYPES, codeDeleteRows, codeFileCount, codeFiles, codePreviewToken, codeSave, codeSites, codeStarterFiles, codeUrl,
} from './sites.js';
import {
  CODE_MORE_TEXT, CODE_UNLOCK_TEXT, SLOT_BUSY_TEXT, SLOT_GONE_TEXT, SLOT_RATE_MAX, SLOT_RATE_TEXT, SLOT_RATE_WINDOW, SlotBusyError, SlotGoneError,
  canCreate, canMove, codeBannedText, codeQuota, pageAllowance, slotRateKey, withSlotLock, type CodeDenied, type SlotUser,
} from './slots.js';
import { CODE_MAX_FILES_BOUND, codeLimits, codeSettings } from './settings.js';
import { CODE_TERMS_REQUIRED } from './shop.js';
import { mustStayOffline } from './enforce.js';

export const CODE_STALE_TAB = { ok: false, error: 'This tab is out of date. Please reload the editor.', reload: true } as const;
export const CODE_SITE_GONE = { ok: false, error: 'This code page no longer exists. Please reload the editor.', reload: true } as const;
const CHOOSE_TEXT = 'Choose where your code page should go.';
const SHOWS_CODE_TEXT = 'This page already shows a code page.';
const CONFIRM_TEXT = 'To confirm, please type the address of the code page.';
// Eine Code-Seite übernimmt die Adresse eines Platzes: dieselben Namensregeln wie jede neue Code-Seiten-Adresse (Marken,
// der Name von OnYourSite) – sonst würde aus einer Link-Seite mit Markennamen eine Code-Seite
const BRAND_SLOT_TEXT = 'This page’s address contains a brand name. Code pages can’t use brand names in their address.';
const slotNameRefused = (page: Row): boolean => addressNameProblem(phpStr(page.slug), 'code') !== null;
const takenText = (slug: string): string => `Sorry, the address “${slug}” is already taken.`;
const blockedText = (site: Row): string =>
  'Your code page has been blocked by the team' + (phpTruthy(site.blocked_reason) ? ': ' + phpStr(site.blocked_reason) : '.');

// Ergebnis einer Änderung unter der Sperre: Ablehnung (mit Status) oder die betroffene Code-Seite
type Refused = { refused: Record<string, unknown>; status: number };
const refuse = (error: string, status = 200, extra: Record<string, unknown> = {}): Refused => ({ refused: { ok: false, error, ...extra }, status });
const fromDenied = (d: CodeDenied): Refused => refuse(d.error, d.status, d.need ? { need: d.need } : {});

// Wert von „site“: is_scalar && intval > 0, sonst null
function idParam(v: unknown): number | null {
  if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return null;
  const n = intval(v);
  return n > 0 ? n : null;
}

// 30-Tage-Regel einer Seitenadresse (wie E.slugDaysLeft der Link-Seite); 0 für eigene Adressen und das Team
function addressDaysLeft(changedAt: unknown): number {
  const changed = phpTruthy(changedAt) ? strtotime(phpStr(changedAt)) : 0;
  if (changed === false || !phpTruthy(changed)) return 0;
  const left = 30 - intval(Math.floor((time() - changed) / 86400));
  return left > 0 ? left : 0;
}
const addressDaysText = (days: number): string => `You can change your address again in ${days} ` + (days === 1 ? 'day.' : 'days.');

// Platz einer Code-Seite (die Seite, die sie zeigt) – nur Seiten desselben Kontos
const slotOf = (site: Row): Promise<Row | null> =>
  one('SELECT * FROM pages WHERE code_site_id = ? AND user_id = ?', [intval(site.id), intval(site.user_id)]);

// Code-Seite mit Startdateien anlegen (auf der Verbindung der Sperre); slug null = auf einem Seitenplatz
async function insertCodeSite(db: Db, userId: number, slug: string | null, title: string): Promise<number> {
  const now = date('Y-m-d H:i:s');
  const res = await db.exec('INSERT INTO code_sites (user_id, slug, title, is_published, is_blocked, views, created_at, updated_at) VALUES (?, ?, ?, 1, 0, 0, ?, ?)',
    [userId, slug, title, now, now]);
  const id = intval(res.insertId);
  const starter = Object.entries(codeStarterFiles(title));
  for (const [path, content] of starter) {
    await db.exec('INSERT INTO code_files (site_id, path, content, updated_at) VALUES (?, ?, ?, ?)', [id, path, content, now]);
  }
  await db.exec('UPDATE code_sites SET file_count = ?, bytes = ? WHERE id = ?', [starter.length, starter.reduce((n, [, c]) => n + Buffer.byteLength(c, 'utf8'), 0), id]);
  if (slug !== null) await claimAddress(db, slug, 'code', id, userId);
  return id;
}

// Platz auf die Code-Seite umstellen – nur wenn er noch seine Link-Seite zeigt (sonst Abbruch der Transaktion)
async function pointSlot(db: Db, pageId: number, siteId: number): Promise<void> {
  const res = await db.exec('UPDATE pages SET code_site_id = ? WHERE id = ? AND code_site_id IS NULL', [siteId, pageId]);
  if (intval(res.affectedRows) !== 1) throw new SlotGoneError(`page #${pageId} changed during the request`);
}

// Zustand für jede erfolgreiche code*-Antwort (die fünf bisherigen Schlüssel zuerst)
export async function codeApiState(ctx: Ctx, user: Row, selectedId: number | null): Promise<Record<string, unknown>> {
  const uid = intval(user.id);
  const fresh = await one('SELECT * FROM users WHERE id = ?', [uid]);
  const u = fresh ?? user;
  const settings = await codeSettings();
  const sites = await codeSites(uid);
  const pages = await q('SELECT * FROM pages WHERE user_id = ? ORDER BY position ASC, id ASC', [uid]);
  const slotFor = (site: Row): Row | null => pages.find((p) => intval(p.code_site_id) === intval(site.id)) ?? null;
  const ownSite = sites.find((s) => phpTruthy(s.slug)) ?? null;
  const selected = (selectedId !== null ? sites.find((s) => intval(s.id) === selectedId) : null)
    ?? ownSite ?? sites.find((s) => slotFor(s) !== null) ?? null;
  const addressOf = (site: Row): string => phpTruthy(site.slug) ? phpStr(site.slug) : phpStr(slotFor(site)?.slug ?? '');
  const allowance = await pageAllowance(ctx, u);
  const morePrice = await shopPrice('code_more', uid);
  const staff = isStaff(ctx, u);
  let site: Record<string, unknown> | null = null;
  if (selected) {
    const slot = slotFor(selected);
    const slug = addressOf(selected);
    const files = await codeFiles(intval(selected.id));
    site = {
      id: intval(selected.id), slug, title: phpStr(selected.title), online: phpTruthy(selected.is_published),
      blocked: phpTruthy(selected.is_blocked), blocked_reason: phpStr(selected.blocked_reason ?? ''),
      url: codeUrl(slug), preview: codeUrl(slug) + '/?oys-preview=' + codePreviewToken(selected, null, slug),
      views: intval(selected.views), files: files.size ? Object.fromEntries(files) : [],
      limits: { ...codeLimits(settings), types: [...CODE_TYPES.keys()] },
      kind: slot ? 'page' : 'own', slot: slot ? intval(slot.id) : null,
      days_left: slot && !staff ? addressDaysLeft(slot.slug_changed_at) : 0,
    };
  }
  const domains = new Map<number, boolean>();
  for (const p of pages) domains.set(intval(p.id), await hasDomain(intval(p.id)));
  return {
    ok: true,
    unlocked: await has(uid, 'code_page'),
    terms: phpTruthy(u.code_terms_at),
    cost: await shopPrice('code_page', uid),
    balance: await hcBalance(uid),
    site,
    sites: sites.filter((s) => phpTruthy(s.slug) || slotFor(s)).map((s) => ({
      id: intval(s.id), kind: phpTruthy(s.slug) ? 'own' : 'page', slug: addressOf(s), url: codeUrl(addressOf(s)), title: phpStr(s.title),
      online: phpTruthy(s.is_published), blocked: phpTruthy(s.is_blocked), slot: slotFor(s) ? intval(slotFor(s)?.id) : null,
    })),
    slots: {
      pages: { used: pages.length, max: allowance.max, unlimited: allowance.unlimited },
      own: { used: ownSite ? 1 : 0, max: 1 },
      onPages: { used: pages.filter((p) => p.code_site_id !== null && p.code_site_id !== undefined).length, max: settings.max_on_pages },
    },
    more: { unlocked: morePrice === 0 || (await has(uid, 'code_more')), cost: morePrice },
    banned: phpTruthy(u.code_banned_at) ? { reason: phpStr(u.code_ban_reason ?? '') } : null,
    paused: settings.paused,
    pages: pages.map((p) => ({
      id: intval(p.id), slug: p.slug, title: p.title, url: pageDisplayUrl(p as unknown as PageLike),
      avatar: phpTruthy(p.avatar) ? uploadUrl(p.avatar) : '',
      code: p.code_site_id === null || p.code_site_id === undefined ? null : intval(p.code_site_id),
      custom_domain: domains.get(intval(p.id)) ?? false,
    })),
  };
}

// Übersicht der Code-Seiten für den Start des Editors (OYS_EDITOR.code, CS-6): Seitenwechsler und Dialoge ohne Anfrage.
// Nur Zeilen dieses Kontos; Dateien werden nicht gelesen.
export async function codeSummary(user: Row): Promise<Record<string, unknown>> {
  const uid = intval(user.id);
  const settings = await codeSettings();
  const sites = await codeSites(uid);
  const pages = await q('SELECT id, slug, code_site_id FROM pages WHERE user_id = ?', [uid]);
  const slotFor = (site: Row): Row | null => pages.find((p) => intval(p.code_site_id) === intval(site.id)) ?? null;
  const morePrice = await shopPrice('code_more', uid);
  const list = sites.filter((s) => phpTruthy(s.slug) || slotFor(s)).map((s) => {
    const slot = slotFor(s);
    const slug = phpTruthy(s.slug) ? phpStr(s.slug) : phpStr(slot?.slug ?? '');
    return {
      id: intval(s.id), kind: phpTruthy(s.slug) ? 'own' : 'page', slug, url: codeUrl(slug), title: phpStr(s.title),
      online: phpTruthy(s.is_published), blocked: phpTruthy(s.is_blocked), slot: slot ? intval(slot.id) : null,
    };
  });
  return {
    unlocked: await has(uid, 'code_page'),
    more: { unlocked: morePrice === 0 || (await has(uid, 'code_more')), cost: morePrice },
    cost: await shopPrice('code_page', uid),
    terms: phpTruthy(user.code_terms_at),
    banned: phpTruthy(user.code_banned_at) ? { reason: phpStr(user.code_ban_reason ?? '') } : null,
    paused: settings.paused,
    own: list.filter((s) => s.kind === 'own').length,
    onPages: pages.filter((p) => p.code_site_id !== null && p.code_site_id !== undefined).length,
    maxOnPages: settings.max_on_pages,
    total: sites.length,
    sites: list,
  };
}

// Änderung unter der Sperre: busy (200) oder Konto weg (409 reload) beenden die Anfrage; eine Ablehnung ebenso.
// slug: die verlangte Adresse – für die Meldung, wenn ein anderes Konto sie gleichzeitig belegt (doppelter Schlüssel
// in pages/code_sites statt AddressTakenError)
async function locked<T>(ctx: Ctx, userId: number, fn: (db: Db, user: SlotUser) => Promise<T | Refused>, slug = ''): Promise<T> {
  let out: T | Refused;
  try {
    out = await withSlotLock(userId, async (db, user) => {
      const r = await fn(db, user);
      // Abgelehnt: nichts schreiben (die Transaktion wird zurückgerollt)
      if (r !== null && typeof r === 'object' && 'refused' in (r as object)) throw new RefusedError(r as Refused);
      return r;
    });
  } catch (err) {
    if (err instanceof RefusedError) out = err.r;
    else if (err instanceof SlotBusyError) ctx.json({ ok: false, error: SLOT_BUSY_TEXT, busy: true });
    else if (err instanceof SlotGoneError) ctx.json({ ok: false, error: SLOT_GONE_TEXT, reload: true }, 409);
    else if (isTakenError(err)) ctx.json({ ok: false, error: takenText(phpStr((err as { slug?: unknown }).slug ?? slug)) });
    else if (duplicateKey(err) === 'uq_own') ctx.json({ ok: false, error: 'You already have a code page with its own address.' });
    else throw err;
  }
  if (out !== null && typeof out === 'object' && 'refused' in (out as object)) ctx.json((out as Refused).refused, (out as Refused).status);
  return out as T;
}
class RefusedError extends Error { constructor(public r: Refused) { super('refused'); } }

// Alle Aktionen, die mit „code“ beginnen (enden immer hier)
export async function codeApi(ctx: Ctx, user: Row, action: string, isPost: boolean, input: PhpArr): Promise<never> {
  const userId = intval(user.id);
  const inp = (key: string): unknown => own(input, key);
  const state = (siteId: number | null): Promise<Record<string, unknown>> => codeApiState(ctx, user, siteId);
  const banned = phpTruthy(user.code_banned_at) ? codeBannedText(phpStr(user.code_ban_reason ?? '')) : null;

  // Auswahl einer Code-Seite dieses Kontos (409 reload, wenn es sie nicht gibt oder sie einem anderen Konto gehört)
  const siteOf = async (raw: unknown, required: boolean): Promise<Row | null> => {
    const id = idParam(raw);
    if (id === null) {
      if (required) ctx.json(CODE_STALE_TAB, 409);
      if (raw !== undefined && raw !== null && raw !== '') ctx.json(CODE_SITE_GONE, 409);
      return null;
    }
    const site = await one('SELECT * FROM code_sites WHERE id = ? AND user_id = ?', [id, userId]);
    if (!site) ctx.json(CODE_SITE_GONE, 409);
    return site;
  };

  if (action === 'code') {
    const site = await siteOf(ctx.get.site, false);
    ctx.json(await state(site ? intval(site.id) : null));
  }
  if (!isPost) ctx.json({ ok: false, error: 'Not found.' }, 404);

  // Freischalten über den Shop (Vertrag der Kauf-Routen): Anfrage-ID aus dem Dialog und der Preis, den er zeigte.
  // item = code_page (Standard) oder code_more. Die Regeln akzeptiert der Kauf selbst (in seiner Transaktion).
  if (action === 'code-unlock') {
    const itemIn = inp('item');
    const item = itemIn === undefined || itemIn === null || itemIn === '' ? 'code_page' : itemIn;
    if (item !== 'code_page' && item !== 'code_more') ctx.json({ ok: false, error: 'Not all of the data arrived. Please try again.' }, 400);
    if (banned !== null) ctx.json({ ok: false, error: banned });
    if (item === 'code_more') {
      if (!(await has(userId, 'code_page'))) ctx.json({ ok: false, error: CODE_UNLOCK_TEXT, need: 'code_page' }, 403);
      // Weitere Code-Seiten kosten nichts: nichts zu kaufen
      if ((await shopPrice('code_more', userId)) === 0) ctx.json(await state(null));
    }
    const requestId = inp('request_id');
    const expected = inp('expected_price');
    const missing = (v: unknown): boolean => v === undefined || v === null || v === '';
    if (missing(requestId) || missing(expected)) {
      ctx.json({ ok: false, error: 'OnYourSite was updated – please reload the editor.', reload: true }, 409);
    }
    const price = typeof expected === 'number' ? expected : typeof expected === 'string' && /^[0-9]{1,7}$/.test(expected) ? Number(expected) : -1;
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId) || !Number.isSafeInteger(price) || price < 0) {
      ctx.json({ ok: false, error: 'Not all of the data arrived. Please try again.' }, 400);
    }
    if (adminMode(ctx)) ctx.json({ ok: false, code: 'admin_mode', error: 'Buying is turned off in admin mode.' }, 403);
    if (!(await rateLimit('hcbuy:' + userId, 20, 600))) {
      ctx.json({ ok: false, error: 'Too many purchases in a short time – please wait a moment.' });
    }
    const r = await buy(ctx, userId, item as string, requestId as string, price, { via: 'code', terms: phpTruthy(inp('terms')) });
    // Schon freigeschaltet: Erfolg ohne Abbuchung (wie bisher)
    if (r.ok) ctx.json({ ...(await state(null)), notices: r.notices });
    if (r.code === 'owned') ctx.json(await state(null));
    ctx.json(r.price === undefined ? { ok: false, code: r.code, error: r.error } : { ok: false, code: r.code, price: r.price, error: r.error }, r.status);
  }

  // Neue Code-Seite (eigene Adresse oder Seitenplatz): Bann → Regeln akzeptieren → freigeschaltet
  if (action === 'code-create' || action === 'code-connect') {
    if (banned !== null) ctx.json({ ok: false, error: banned });
    if (!phpTruthy(user.code_terms_at)) {
      if (!phpTruthy(inp('terms'))) ctx.json({ ok: false, error: CODE_TERMS_REQUIRED });
      await exec('UPDATE users SET code_terms_at = ? WHERE id = ?', [date('Y-m-d H:i:s'), userId]);
    }
    if (!(await has(userId, 'code_page'))) ctx.json({ ok: false, error: CODE_UNLOCK_TEXT, need: 'code_page' }, 403);
    const slotIn = inp('slot');
    const slotId = action === 'code-connect' && slotIn !== 'new' ? idParam(slotIn) : null;
    if (action === 'code-connect' && slotIn !== 'new' && slotId === null) ctx.json({ ok: false, error: CHOOSE_TEXT });
    if (!(await rateOk(slotRateKey(userId), SLOT_RATE_MAX, SLOT_RATE_WINDOW))) ctx.json({ ok: false, error: SLOT_RATE_TEXT });
    const slug = normalizeSlug(inp('slug') ?? '');
    const clean = cleanText(inp('title') ?? '', 120);
    let firstPage = false;
    const id = await locked<number>(ctx, userId, async (db, lockedUser) => {
      const quota = await codeQuota(lockedUser, ctx, db);
      if (action === 'code-create') {
        const d = canCreate(quota, 'own');
        if (d) return fromDenied(d);
        const problem = await slugProblem(slug, null, null, { userId, db, kind: 'code' });
        if (problem !== null) return refuse(problem);
        return insertCodeSite(db, userId, slug, phpTruthy(clean) ? clean : slug);
      }
      if (slotId !== null) {
        // Platz dieses Kontos, gesperrt (Sperrreihenfolge users → pages → code_sites)
        const page = await db.one('SELECT * FROM pages WHERE id = ? AND user_id = ? FOR UPDATE', [slotId, userId]);
        if (!page) return refuse('Page not found.', 404);
        if (page.code_site_id !== null && page.code_site_id !== undefined) return refuse(SHOWS_CODE_TEXT);
        const d = canCreate(quota, 'page', { hasDomain: await hasDomain(slotId, db) });
        if (d) return fromDenied(d);
        if (slotNameRefused(page)) return refuse(BRAND_SLOT_TEXT);
        const siteId = await insertCodeSite(db, userId, null, phpTruthy(clean) ? clean : phpStr(page.slug));
        await pointSlot(db, slotId, siteId);
        return siteId;
      }
      // Neue Seite, die gleich die Code-Seite zeigt
      const d = canCreate(quota, 'new-page');
      if (d) return fromDenied(d);
      const problem = await slugProblem(slug, null, null, { userId, db, kind: 'code' });
      if (problem !== null) return refuse(problem);
      firstPage = quota.pagesUsed === 0;
      const title = phpTruthy(clean) ? clean : slug;
      const pageId = await createPage(userId, slug, title, db);
      const siteId = await insertCodeSite(db, userId, null, title);
      await pointSlot(db, pageId, siteId);
      return siteId;
    }, slug);
    if (firstPage) await syncUsername(userId);
    await rateHit(slotRateKey(userId), SLOT_RATE_WINDOW);
    ctx.json(await state(id));
  }

  // Ab hier immer eine bestimmte Code-Seite: „site“ ist Pflicht (ein alter Tab ohne site überschreibt sonst eine andere)
  if (!['code-save', 'code-address', 'code-move', 'code-delete'].includes(action)) ctx.json({ ok: false, error: 'Not found.' }, 404);
  const site = (await siteOf(inp('site'), true)) as Row;
  const siteId = intval(site.id);

  if (action === 'code-delete') {
    // Gesperrte Konten dürfen löschen; eine vom Team gesperrte Code-Seite nicht
    if (phpTruthy(site.is_blocked)) ctx.json({ ok: false, error: blockedText(site) });
    const slot = phpTruthy(site.slug) ? null : await slotOf(site);
    const address = phpTruthy(site.slug) ? phpStr(site.slug) : phpStr(slot?.slug ?? '');
    const confirm = inp('confirm');
    if (typeof confirm !== 'string' || confirm.trim() !== address || address === '') ctx.json({ ok: false, error: CONFIRM_TEXT });
    if (!(await rateOk(slotRateKey(userId), SLOT_RATE_MAX, SLOT_RATE_WINDOW))) ctx.json({ ok: false, error: SLOT_RATE_TEXT });
    const used = await locked<Set<string>>(ctx, userId, async (db) => {
      const cur = await db.one('SELECT * FROM code_sites WHERE id = ? AND user_id = ? FOR UPDATE', [siteId, userId]);
      if (!cur) return { refused: CODE_SITE_GONE, status: 409 };
      if (phpTruthy(cur.is_blocked)) return refuse(blockedText(cur));
      return codeDeleteRows(db, cur);
    });
    await cleanupFiles(userId, [...used]);
    await rateHit(slotRateKey(userId), SLOT_RATE_WINDOW);
    ctx.json(await state(null));
  }

  if (banned !== null) ctx.json({ ok: false, error: banned });
  // Wie bisher: ändern nur mit Freischaltung (nach einer Erstattung bleiben die Code-Seiten offline, bis sie wieder da ist)
  if (!(await has(userId, 'code_page'))) ctx.json({ ok: false, error: CODE_UNLOCK_TEXT, need: 'code_page' }, 403);
  if (phpTruthy(site.is_blocked)) ctx.json({ ok: false, error: blockedText(site) });

  if (action === 'code-save') {
    // Dateien in der Reihenfolge der Anfrage (json_decode behält sie), gelöschte Pfade nur als Text
    const filesIn = inp('files') ?? null;
    const files: PhpArr = isArr(filesIn) ? filesIn : [];
    const deletedIn = inp('deleted') ?? null;
    const deleted = values(isArr(deletedIn) ? deletedIn : []).filter((x) => typeof x === 'string');
    // Feste Obergrenze (höchste einstellbare Dateizahl): die genaue Grenze prüft codeWrite, auch für Seiten über einer gesenkten
    const max = CODE_MAX_FILES_BOUND;
    if (codeFileCount(files) > max * 2 || deleted.length > max * 2) ctx.json({ ok: false, error: 'Too many files.' }, 400);
    // array_key_exists(): auch ein null-Wert zählt als vorhanden
    const wantOnline = Object.hasOwn(input, 'online') ? phpTruthy(inp('online')) : null;
    // Einschalten nur, wenn der Abgleich die Seite nicht offline hält (code_more verloren, solange es etwas kostet) –
    // früh, damit nichts gespeichert wird, und unten noch einmal auf der gesperrten Zeile
    const moreNeeded = { ok: false, error: CODE_MORE_TEXT, need: 'code_more' };
    if (wantOnline === true && (await mustStayOffline(userId, siteId))) ctx.json(moreNeeded, 403);
    const title = Object.hasOwn(input, 'title') ? cleanText(inp('title'), 120) : phpStr(site.title);
    const name = title !== '' ? title : phpStr(site.slug ?? (await slotOf(site))?.slug ?? '');
    // Dateien, Name und Online-Schalter in einer Transaktion auf der gesperrten Zeile: ein Abgleich, der inzwischen lief,
    // gilt – ohne Schalter bleibt der Stand der Zeile (nicht der vom Anfang der Anfrage)
    const error = await codeSave(site, files, deleted, async (db) => {
      if (wantOnline === true && (await mustStayOffline(userId, siteId, db))) return CODE_MORE_TEXT;
      const online = wantOnline ?? phpTruthy(await db.value('SELECT is_published FROM code_sites WHERE id = ?', [siteId]));
      await db.exec('UPDATE code_sites SET title = ?, is_published = ? WHERE id = ? AND user_id = ?', [name, online ? 1 : 0, siteId, userId]);
      return null;
    });
    if (error === CODE_MORE_TEXT) ctx.json(moreNeeded, 403);
    if (phpTruthy(error)) ctx.json({ ok: false, error });
    ctx.json(await state(siteId));
  }

  // Adresse ändern und umziehen: nicht während der Pause (E3)
  const paused = (await codeSettings()).paused;
  if (paused) ctx.json({ ok: false, error: 'Code pages can’t move to a new address right now. Please try again later.' });

  if (action === 'code-address') {
    const slug = normalizeSlug(inp('slug') ?? '');
    if (!(await rateOk(slotRateKey(userId), SLOT_RATE_MAX, SLOT_RATE_WINDOW))) ctx.json({ ok: false, error: SLOT_RATE_TEXT });
    let changed = false;
    let pageKind = false;
    await locked<boolean>(ctx, userId, async (db, lockedUser) => {
      const slot = await db.one('SELECT * FROM pages WHERE code_site_id = ? AND user_id = ? FOR UPDATE', [siteId, userId]);
      const cur = await db.one('SELECT * FROM code_sites WHERE id = ? AND user_id = ? FOR UPDATE', [siteId, userId]);
      if (!cur) return { refused: CODE_SITE_GONE, status: 409 };
      if (phpTruthy(cur.is_blocked)) return refuse(blockedText(cur));
      const quota = await codeQuota(lockedUser, ctx, db);
      if (quota.banned !== null) return refuse(codeBannedText(quota.banned));
      if (quota.paused) return refuse('Code pages can’t move to a new address right now. Please try again later.');
      if (phpTruthy(cur.slug)) {
        if (phpStr(cur.slug) === slug) return false;
        const problem = await slugProblem(slug, null, siteId, { userId, db, kind: 'code' });
        if (problem !== null) return refuse(problem);
        await db.exec('UPDATE code_sites SET slug = ?, updated_at = ? WHERE id = ?', [slug, date('Y-m-d H:i:s'), siteId]);
        await claimAddress(db, slug, 'code', siteId, userId);
        await releaseAddress(db, phpStr(cur.slug), userId, 'owner', { kind: 'code', refId: siteId });
        changed = true;
        return true;
      }
      if (!slot) return { refused: CODE_SITE_GONE, status: 409 };
      pageKind = true;
      if (phpStr(slot.slug) === slug) return false;
      // Seitenadresse: dieselbe 30-Tage-Regel wie die Link-Seite (das Team ist ausgenommen)
      const left = isStaff(ctx, lockedUser) ? 0 : addressDaysLeft(slot.slug_changed_at);
      if (left > 0) return refuse(addressDaysText(left));
      const problem = await slugProblem(slug, intval(slot.id), siteId, { userId, db, kind: 'code' });
      if (problem !== null) return refuse(problem);
      await db.exec('UPDATE pages SET slug = ?, slug_changed_at = ? WHERE id = ?', [slug, date('Y-m-d H:i:s'), intval(slot.id)]);
      await claimAddress(db, slug, 'page', intval(slot.id), userId);
      await releaseAddress(db, phpStr(slot.slug), userId, 'owner', { kind: 'page', refId: intval(slot.id) });
      changed = true;
      return true;
    }, slug);
    if (changed) {
      if (pageKind) await syncUsername(userId);
      await rateHit(slotRateKey(userId), SLOT_RATE_WINDOW);
    }
    ctx.json(await state(siteId));
  }

  // code-move: genau eines von slot (auf einen Platz) und slug (an eine eigene Adresse)
  const slotIn = inp('slot');
  const slugIn = inp('slug');
  const toPage = slotIn !== undefined && slotIn !== null && slotIn !== '';
  const toOwn = slugIn !== undefined && slugIn !== null && slugIn !== '';
  if (toPage === toOwn) ctx.json({ ok: false, error: CHOOSE_TEXT });
  const targetPage = toPage ? idParam(slotIn) : null;
  if (toPage && targetPage === null) ctx.json({ ok: false, error: CHOOSE_TEXT });
  const slug = toOwn ? normalizeSlug(slugIn) : '';
  if (!(await rateOk(slotRateKey(userId), SLOT_RATE_MAX, SLOT_RATE_WINDOW))) ctx.json({ ok: false, error: SLOT_RATE_TEXT });
  await locked<boolean>(ctx, userId, async (db, lockedUser) => {
    const slot = await db.one('SELECT * FROM pages WHERE code_site_id = ? AND user_id = ? FOR UPDATE', [siteId, userId]);
    const target = targetPage !== null ? await db.one('SELECT * FROM pages WHERE id = ? AND user_id = ? FOR UPDATE', [targetPage, userId]) : null;
    const cur = await db.one('SELECT * FROM code_sites WHERE id = ? AND user_id = ? FOR UPDATE', [siteId, userId]);
    if (!cur) return { refused: CODE_SITE_GONE, status: 409 };
    if (phpTruthy(cur.is_blocked)) return refuse(blockedText(cur));
    const quota = await codeQuota(lockedUser, ctx, db);
    if (toPage) {
      // Auf einen Platz: nur eine Code-Seite mit eigener Adresse, nur auf eine gezeigte Link-Seite dieses Kontos
      if (!phpTruthy(cur.slug)) return refuse(CHOOSE_TEXT);
      if (!target) return refuse('Page not found.', 404);
      if (target.code_site_id !== null && target.code_site_id !== undefined) return refuse(SHOWS_CODE_TEXT);
      const d = canMove(quota, 'page', { hasDomain: await hasDomain(intval(target.id), db) });
      if (d) return fromDenied(d);
      if (slotNameRefused(target)) return refuse(BRAND_SLOT_TEXT);
      await db.exec('UPDATE code_sites SET slug = NULL, updated_at = ? WHERE id = ?', [date('Y-m-d H:i:s'), siteId]);
      await pointSlot(db, intval(target.id), siteId);
      await releaseAddress(db, phpStr(cur.slug), userId, 'owner', { kind: 'code', refId: siteId });
      return true;
    }
    // An eine eigene Adresse: nur eine Code-Seite auf einem Platz
    if (phpTruthy(cur.slug) || !slot) return refuse(CHOOSE_TEXT);
    const d = canMove(quota, 'own');
    if (d) return fromDenied(d);
    const problem = await slugProblem(slug, null, siteId, { userId, db, kind: 'code' });
    if (problem !== null) return refuse(problem);
    await db.exec('UPDATE pages SET code_site_id = NULL WHERE code_site_id = ?', [siteId]);
    await db.exec('UPDATE code_sites SET slug = ?, updated_at = ? WHERE id = ?', [slug, date('Y-m-d H:i:s'), siteId]);
    await claimAddress(db, slug, 'code', siteId, userId);
    return true;
  }, slug);
  await rateHit(slotRateKey(userId), SLOT_RATE_WINDOW);
  ctx.json(await state(siteId));
}
