// Öffentliche Endpunkte unter /_/… (lib/routes_public.php) und die Profilseiten aus index.php: alte Klick-Zählung,
// Profil im Pfad-Modus (on-your.site/name) und auf der Subdomain (name.on-your.site). Setzt KEINE Cookies.
import type { Ctx } from '../web/ctx.js';
import { one, type Row } from '../db.js';
import { config } from '../config.js';
import { passwordVerify, safeEqual } from '../crypto.js';
import { e } from '../html.js';
import { addressUrl, cleanUrl, customOrigin, isBot, isMainHost, liveDomain, mainUrl, onPageHost, pageOrigin, pageUrl, pageUrls, uploadUrl, type PageLike } from '../helpers.js';
import { ctypeDigit, intval, phpStr, phpTruthy, strtolower } from '../php.js';
import { attemptFailed, attemptsAllowed } from '../web/security.js';
import { botApi } from '../community/api.js';
import { blockIsClickable, bookingIsInternal, calendarKey, scheduleActive } from '../content/blocks.js';
import { demoPage } from '../content/demo.js';
import { contactCheck, storeMessage } from '../content/messages.js';
import { blockFromRow, calendarAccess, isShownLinkPage, loadBlocks, loadPage, loadPageBySlug, type Block } from '../content/pages.js';
import { renderPage, renderSimple } from '../content/render.js';
import { ogServe } from '../content/share.js';
import { brands, uiIcon } from '../content/social.js';
import { recordClick, recordView, requestFromOwnSite } from '../content/stats.js';
import { layouts } from '../content/themes.js';
import { isArr, jsonDecode, own } from '../content/util.js';
import { codeServe } from '../code/serve.js';
import { codeSiteById, codeSiteBySlug, codeUrl } from '../code/sites.js';
import { runWeeklyReports } from '../app/report.js';
import { domainsAvailable } from '../domains/config.js';
import { controlResponse } from '../domains/answers.js';
import { forwardingDomain, hostnameForPage } from '../domains/store.js';
import { notFound } from './notFound.js';
import { kalender } from './views/kalender.js';

// Block mit dem Ergebnis der Zeitsteuerung (active)
export type PublicBlock = Block & { active: boolean };

// oys_public_block(): Block samt Seite laden (nur sichtbare Blöcke; active = gerade laut Zeitsteuerung sichtbar). Die
// Link-Seite eines Platzes, der eine Code-Seite zeigt, gibt es für Besucher nicht (kein Klick, kein Passwort, kein
// Kontaktformular – /_/c, /_/unlock, /_/go, /_/contact).
export async function publicBlock(id: unknown): Promise<{ block: PublicBlock; page: Row } | null> {
  if (!ctypeDigit(phpStr(id))) return null;
  const row = await one('SELECT * FROM page_blocks WHERE id = ?', [intval(id)]);
  if (!row || intval(row.is_visible) === 0) return null;
  const page = await loadPage(intval(row.page_id));
  if (!page || !isShownLinkPage(page)) return null;
  const block = blockFromRow(row);
  return { block: { ...block, active: scheduleActive(block.schedule, Date.now() / 1000) }, page };
}

// oys_block_target(): Ziel-Adresse eines klickbaren Blocks. extraHosts: weitere eigene Hosts der Seite für den
// Termin-Block (ihre Domain in jedem Zustand, siehe bookingHosts)
export function blockTarget(block: Block, page: Row, extraHosts: readonly string[] = []): string {
  const d = block.data;
  switch (block.type) {
    case 'booking':
      if (bookingIsInternal(d, page as unknown as PageLike, extraHosts)) {
        // Geschützter Termin-Block: Kalender nur mit Schlüssel (sonst ließe sich der Schutz über /kalender umgehen)
        return pageUrl(page as unknown as PageLike, 'kalender') + (block.protection !== 'none' ? '?k=' + calendarKey(page, block) : '');
      }
      return cleanUrl(phpStr(own(d, 'url') ?? ''), true);
    case 'file': {
      const src = own(d, 'src');
      if (!phpTruthy(src)) return '';
      // oys_upload_url(?string): ein Array ist in PHP ein TypeError (500)
      if (isArr(src)) throw new TypeError('oys_upload_url(): Argument #1 ($file) must be of type ?string, array given');
      return mainUrl(uploadUrl(phpStr(src)));
    }
    default: {
      const url = cleanUrl(phpStr(own(d, 'url') ?? ''), true);
      if (url !== '' && url[0] === '/') return pageUrl(page as unknown as PageLike) + url;
      return url;
    }
  }
}

// Eigene Domain der Seite (in jedem Zustand) für einen Termin-Block mit voller Adresse – eine Abfrage nur dann, wenn
// der Block nicht schon so auf den eigenen Kalender zeigt (/kalender oder eine OnYourSite-Adresse)
export async function bookingHosts(block: Block, page: Row): Promise<string[]> {
  if (block.type !== 'booking' || bookingIsInternal(block.data, page as unknown as PageLike)) return [];
  const host = await hostnameForPage(intval(page.id));
  return host !== null ? [host] : [];
}

// oys_wants_json(): stripos() vergleicht nur ASCII ohne Groß-/Kleinschreibung
export function wantsJson(ctx: Ctx): boolean {
  return strtolower(headerText(ctx.headers.accept)).includes('application/json');
}

// oys_render_gate(): Zwischenseite für geschützte Links ohne JavaScript
export function renderGate(page: Row, block: Block, kind: 'age' | 'password', error: string | null = null): string {
  const t = own(block.data, 'title') ?? '';
  const title = phpTruthy(t) ? t : 'Link';
  const back = '<a class="oys-back" href="' + e(pageUrl(page as unknown as PageLike)) + '">' + uiIcon('left') + ' Back to '
    + e(phpTruthy(page.title) ? page.title : page.slug) + '</a>';
  let body: string;
  if (kind === 'age') {
    body = '<div class="oys-card">' + back
      + '<div class="oys-modal-icon" style="margin:0 0 12px">18+</div><h1>Adults only</h1>'
      + '<p>“' + e(title) + '” is for adults only. Are you at least 18 years old?</p>'
      + '<form method="post" action="/_/go/' + intval(block.id) + '"><input type="hidden" name="age" value="yes">'
      + '<button class="oys-contact-send" type="submit"><span>Yes, I’m 18 or older</span></button></form></div>';
  } else {
    body = '<form class="oys-card oys-contact" method="post" action="/_/go/' + intval(block.id) + '">' + back
      + '<h1>Protected link</h1><p>“' + e(title) + '” is password protected.</p>'
      + (phpTruthy(error) ? '<div class="oys-alert err">' + e(error) + '</div>' : '')
      + '<label class="oys-field"><span>Password</span><input type="password" name="pw" required autofocus></label>'
      + '<button class="oys-contact-send" type="submit">' + uiIcon('lock') + '<span>Unlock</span></button></form>';
  }
  return renderSimple(page, 'Protected link', body);
}

// Kopfzeile als Text (Node fasst doppelte zusammen, Arrays nur bei Set-Cookie)
function headerText(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v.join(', ') : (v ?? '');
}

// php://input: bei POST mit multipart/form-data (Typ klein geschrieben bis zum ersten ';', ',' oder Leerzeichen) liest
// PHP den Inhalt selbst ein und lässt php://input leer – aber nur, wenn rfc1867.c eine Grenze findet: "boundary" (erst
// genau so, sonst ohne Rücksicht auf Groß-/Kleinschreibung), danach ein '=' und bei '"' ein schließendes '"' (die Grenze
// darf leer sein). Sonst bricht PHP vorher ab und der Inhalt bleibt in php://input.
export function phpInput(ctx: Ctx): Buffer {
  if (ctx.method !== 'POST') return ctx.rawBody;
  const type = headerText(ctx.headers['content-type']);
  const cut = type.search(/[;, ]/);
  if (strtolower(cut >= 0 ? type.slice(0, cut) : type) !== 'multipart/form-data') return ctx.rawBody;
  let at = type.indexOf('boundary');
  if (at < 0) at = strtolower(type).indexOf('boundary');
  const eq = at < 0 ? -1 : type.indexOf('=', at);
  if (eq < 0 || (type[eq + 1] === '"' && type.indexOf('"', eq + 2) < 0)) return ctx.rawBody;
  return Buffer.alloc(0);
}

// --- /_/… auf jeder Adresse (index.php → lib/routes_public.php). X-Robots-Tag setzt schon der Router. ---
export async function publicRoutes(ctx: Ctx): Promise<void> {
  const path = ctx.path;
  const method = ctx.method;
  let m: RegExpExecArray | null;

  // --- Selbsttest des Domain-Dienstes (nur mit eigenen Domains, nur auf der Hauptdomain) ---
  if (path === '/_/domain-check' && (method === 'GET' || method === 'HEAD') && domainsAvailable() && isMainHost(ctx.host)) {
    return controlResponse(ctx);
  }

  // --- Aufruf zählen ---
  if (path === '/_/v' && method === 'POST') {
    if (!isBot(ctx.userAgent()) && requestFromOwnSite(ctx)) {
      const pageId = intval(own(ctx.post, 'p') ?? 0);
      // Nur gezeigte Link-Seiten (nicht die geparkte eines Platzes mit Code-Seite)
      if (pageId > 0 && isShownLinkPage(await loadPage(pageId))) await recordView(pageId);
    }
    ctx.status = 204;
    ctx.halt();
  }

  // --- Klick zählen ---
  if (path === '/_/c' && method === 'POST') {
    if (!isBot(ctx.userAgent()) && requestFromOwnSite(ctx)) {
      const found = await publicBlock(own(ctx.post, 'b') ?? '');
      if (found && found.block.protection === 'none') {
        let item = '';
        if (found.block.type === 'socials') {
          item = ctx.p('s');
          if (!Object.hasOwn(brands(), item)) item = '';
        }
        await recordClick(intval(found.page.id), found.block.id, item);
      }
    }
    ctx.status = 204;
    ctx.halt();
  }

  // --- Passwort prüfen (per JavaScript) ---
  if (path === '/_/unlock' && method === 'POST') {
    const found = await publicBlock(own(ctx.post, 'b') ?? '');
    if (!found || !found.block.active || found.block.protection !== 'password') {
      ctx.json({ ok: false, error: 'This link isn’t available right now.' }, 404);
    }
    const block = found.block;
    if (!(await attemptsAllowed(ctx, 'pw:' + block.id, 10, 200, 900))) {
      ctx.json({ ok: false, error: 'Too many attempts. Please wait a few minutes.' }, 429);
    }
    const pw = ctx.p('pw');
    if (pw === '' || !(await passwordVerify(pw, phpStr(block.password_hash)))) {
      await attemptFailed(ctx, 'pw:' + block.id, 900);
      ctx.json({ ok: false, error: 'Wrong password.' });
    }
    await recordClick(intval(found.page.id), block.id);
    ctx.json({ ok: true, url: blockTarget(block, found.page, await bookingHosts(block, found.page)) });
  }

  // --- Weiterleitung /_/go/123 (nur geschützte Links: Passwort, Ab-18-Bestätigung, Fallback ohne JS) ---
  // Weitergeleitet wird nur nach einem POST – so taugt /_/go nicht als offene Weiterleitung.
  if ((m = /^\/_\/go\/(\d+)(?=\n?$)/.exec(path))) {
    const found = await publicBlock(m[1]);
    if (!found || !found.block.active || !blockIsClickable(found.block.type)) return notFound(ctx);
    const { block, page } = found;
    const pageLike = page as unknown as PageLike;
    if (block.protection === 'none') ctx.redirect(pageUrl(pageLike));
    if (!onPageHost(ctx, pageLike)) ctx.redirect(pageOrigin(pageLike) + '/_/go/' + intval(block.id));
    const target = blockTarget(block, page, await bookingHosts(block, page));
    if (target === '') ctx.redirect(pageUrl(pageLike));
    ctx.header('Cache-Control', 'no-store');

    if (block.protection === 'age') {
      if (method !== 'POST' || (own(ctx.post, 'age') ?? '') !== 'yes') ctx.send(renderGate(page, block, 'age'));
    } else {
      if (method !== 'POST') ctx.send(renderGate(page, block, 'password'));
      if (!(await attemptsAllowed(ctx, 'pw:' + block.id, 10, 200, 900))) {
        ctx.send(renderGate(page, block, 'password', 'Too many attempts. Please wait a few minutes.'));
      }
      if (!(await passwordVerify(ctx.p('pw'), phpStr(block.password_hash)))) {
        await attemptFailed(ctx, 'pw:' + block.id, 900);
        ctx.send(renderGate(page, block, 'password', 'Wrong password.'));
      }
    }
    if (!isBot(ctx.userAgent())) await recordClick(intval(page.id), block.id);
    ctx.redirect(target, 303);
  }

  // --- Kontaktformular ---
  if (path === '/_/contact' && method === 'POST') {
    const found = await publicBlock(own(ctx.post, 'b') ?? '');
    const json = wantsJson(ctx);
    // Auf einer eigenen Domain bleibt der Besucher auf ihr (nie zur OnYourSite-Startseite)
    const domainHome = ctx.customDomain ? customOrigin(ctx.customDomain.hostname) : null;
    if (!found || found.block.type !== 'contact' || !found.block.active) {
      if (json) ctx.json({ ok: false, error: 'This form is no longer available.' }, 404);
      ctx.redirect(domainHome !== null ? domainHome + '/' : mainUrl('/'));
    }
    const page = found.page;
    const blockId = String(found.block.id);
    const [ok, error, spam] = await contactCheck(ctx, page, blockId, ctx.post);
    if (ok && !spam) await storeMessage(page, ctx.post);
    if (json) ctx.json(ok ? { ok: true } : { ok: false, error });
    ctx.redirect((domainHome ?? pageUrl(page as unknown as PageLike)) + (ok ? '?sent=' + blockId : '') + '#contact-' + blockId);
  }

  // --- Vorschaubild für geteilte Links (Discord, WhatsApp, X …) ---
  if ((m = /^\/_\/og\/(\d+)-([0-9a-f]{12})\.png(?=\n?$)/.exec(path))) {
    return ogServe(ctx, intval(m[1]), m[2]);
  }

  // --- Demo-Seiten für die Startseite ---
  if ((m = /^\/_\/demo\/([a-z0-9-]+)(?=\n?$)/.exec(path))) {
    const demo = demoPage(m[1]);
    if (!demo) {
      ctx.status = 404;
      ctx.halt();
    }
    if (own(ctx.get, 'layout') !== undefined && Object.hasOwn(layouts(), ctx.q('layout'))) {
      demo.page.layout = ctx.q('layout');
    }
    ctx.header('Cache-Control', 'public, max-age=600');
    ctx.send(renderPage(demo.page, demo.blocks, { mode: 'demo', entrance: 'skip', host: ctx.host }));
  }

  // --- Schnittstelle für den Discord-Bot (signiert mit bot_secret, siehe community/api.ts) ---
  if (path.startsWith('/_/bot/')) return botApi(ctx);

  // --- Wochenbericht per Web-Cron (nur mit Geheimnis aus den Einstellungen) ---
  if (path === '/_/cron/weekly-report') {
    const secret = phpStr(config('cron_secret', ''));
    if (secret === '' || !safeEqual(secret, ctx.q('key'))) ctx.send('Forbidden', 403);
    ctx.header('Content-Type', 'text/plain; charset=utf-8');
    const result = await runWeeklyReports();
    ctx.send('Weekly reports sent: ' + phpStr(result.sent) + ', failed: ' + phpStr(result.failed) + (result.skipped > 0 ? ', skipped: ' + result.skipped : ''));
  }

  return notFound(ctx);
}

// --- POST /track-click: alte Klick-Zählung (für noch offene alte Profilseiten), index.php ---
export async function trackClick(ctx: Ctx): Promise<void> {
  const data = jsonDecode(phpInput(ctx));
  // $data['link_id'] ?? 0: nur ein Array hat Schlüssel (bei Text, Zahl oder null bleibt es 0)
  const legacyId = intval(isArr(data) ? (own(data, 'link_id') ?? 0) : 0);
  if (legacyId > 0 && !isBot(ctx.userAgent())) {
    const row = await one('SELECT id, page_id FROM page_blocks WHERE legacy_link_id = ? LIMIT 1', [legacyId]);
    // Die geparkte Link-Seite eines Platzes mit Code-Seite zählt nichts (Antwort wie immer)
    const page = row ? await loadPage(intval(row.page_id)) : null;
    if (row && (!page || isShownLinkPage(page))) await recordClick(intval(row.page_id), intval(row.id));
  }
  ctx.json({ status: 'success' });
}

// oys_serve_page(): Profilseite (oder deren Termin-Seite) zeigen – auch auf einer eigenen Domain (domains/targets.ts)
export async function servePage(ctx: Ctx, page: Row, sub: string): Promise<void> {
  ctx.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  ctx.header('X-Content-Type-Options', 'nosniff');
  if (sub === 'kalender') {
    const calendarKeyGiven = await calendarAccess(page, ctx.q('k'));
    if (calendarKeyGiven === null) return notFound(ctx);
    return kalender(ctx, page, calendarKeyGiven);
  }
  let notice: string | null = null;
  const sent = own(ctx.get, 'sent');
  if (sent !== undefined && ctypeDigit(phpStr(sent))) notice = 'sent:' + phpStr(sent);
  ctx.send(renderPage(page, await loadBlocks(intval(page.id)), { mode: 'public', host: ctx.host, notice }));
}

// Abfrage weitergeben, wie sie kam (?a=1&b=2), nur wenn es eine gibt
const queryPart = (ctx: Ctx): string => (ctx.queryString !== '' ? '?' + ctx.queryString : '');

// Weiterleitung auf eine eigene Domain: nie aus dem Zwischenspeicher (pausiert die Domain, leitet sie zurück – ein
// gespeichertes 301/302 ergäbe eine Schleife)
function redirectToDomain(ctx: Ctx, page: Row, sub: string, withQuery: boolean): never {
  ctx.header('Cache-Control', 'no-store');
  ctx.redirect(pageUrl(page as unknown as PageLike, sub) + (withQuery ? queryPart(ctx) : ''), 302);
}

// Seitenadresse ausliefern: die Link-Seite – oder, wenn der Platz eine Code-Seite zeigt, die Code-Seite (unter der
// Adresse des Platzes, eigener Ursprung wie jede Code-Seite). Die einzige Stelle, die zwischen beiden entscheidet.
export async function serveSlot(ctx: Ctx, page: Row, sub: string): Promise<void> {
  if (!isShownLinkPage(page)) {
    const site = await codeSiteById(intval(page.code_site_id));
    // Kaputte Verbindung (nur durch Handarbeit in der Datenbank möglich): wie eine unbekannte Adresse
    if (!site || intval(site.user_id) !== intval(page.user_id)) return notFound(ctx);
    await codeServe(ctx, site, ctx.path, phpStr(page.slug));
    ctx.halt();
  }
  return servePage(ctx, page, sub);
}

// --- Hauptdomain: on-your.site/name bzw. on-your.site/name/kalender (slug klein geschrieben, sub '' oder 'kalender') ---
export async function pathProfile(ctx: Ctx, slug: string, sub: string): Promise<void> {
  const page = await loadPageBySlug(slug);
  // Code gibt es nie auf der Hauptdomain: ein Platz mit Code-Seite leitet auf seine Subdomain weiter (ohne Abfrage),
  // /name/kalender gibt es dort nicht
  if (page && !isShownLinkPage(page)) {
    if (sub === '') ctx.redirect(pageUrls(page as unknown as PageLike).subdomain + '/', 302);
    return notFound(ctx);
  }
  // Code-Seiten gibt es nur unter name.on-your.site (eigener Ursprung)
  if (!page && sub === '') {
    const site = await codeSiteBySlug(slug);
    if (site) ctx.redirect(codeUrl(site) + '/', 302);
  }
  if (page) {
    // Hauptadresse ist die Live-Domain (mit eingeschalteter Weiterleitung) → dorthin
    if ((await forwardingDomain(page)) !== null) redirectToDomain(ctx, page, sub, true);
    // Hauptadresse ist name.on-your.site → dorthin weiterleiten
    if (page.address_mode !== 'path') ctx.redirect(addressUrl(page as unknown as PageLike, sub) + queryPart(ctx), 302);
    return servePage(ctx, page, sub);
  }
  return notFound(ctx);
}

// --- Subdomain: name.on-your.site – Profil (oder die Code-Seite seines Platzes), sonst Code-Seite mit eigener Adresse,
// sonst 404 (sub = Pfad klein und ohne / am Rand) ---
export async function subdomain(ctx: Ctx, slug: string, sub: string): Promise<void> {
  const page = await loadPageBySlug(slug);
  if (page) {
    // Platz mit Code-Seite: jeder Pfad gehört der Code-Seite (kein Kalender, keine Weiterleitung, kein Pfad-Modus)
    if (!isShownLinkPage(page)) return serveSlot(ctx, page, sub);
    if (sub !== '' && sub !== 'kalender') {
      if (liveDomain(page as unknown as PageLike) !== '') redirectToDomain(ctx, page, '', false);
      ctx.redirect(pageUrl(page as unknown as PageLike), 302);
    }
    // Hauptadresse ist die Live-Domain (mit eingeschalteter Weiterleitung) → dorthin
    if ((await forwardingDomain(page)) !== null) redirectToDomain(ctx, page, sub, true);
    // Hauptadresse ist on-your.site/name → dorthin weiterleiten
    if (page.address_mode === 'path') ctx.redirect(addressUrl(page as unknown as PageLike, sub) + queryPart(ctx), 302);
    return servePage(ctx, page, sub);
  }
  const site = await codeSiteBySlug(slug);
  if (site) {
    await codeServe(ctx, site, ctx.path);
    ctx.halt();
  }
  return notFound(ctx);
}
