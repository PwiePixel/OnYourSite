// /dashboard/api/{aktion}: JSON-Schnittstelle des Editors (lib/routes_app.php, Abschnitt „Editor-API“).
// Die Reihenfolge der Prüfungen ist die von PHP: CSRF vor dem JSON, Seiten-ID vor allem anderen (auch vor Code-Seite
// und Upload), dann die Aktion. Jede Antwort endet mit ctx.json() (= oys_json(); exit).
import type { Ctx } from '../web/ctx.js';
import { exec, transaction, type Db, type Param, type Row } from '../db.js';
import { csrfCheck, csrfFromRequest, rateHit, rateLimit, rateOk } from '../web/security.js';
import { encryptData } from '../crypto.js';
import { baseAuthority, cleanText, normalizeSlug, reservedPaths, slugProblem, uploadUrl } from '../helpers.js';
import { phpJson } from '../html.js';
import { date, intval, phpStr, phpTruthy, strtolower, strtotime, time, type PhpArray } from '../php.js';
import { IMAGE_EXTS, blockNormalize, validUpload } from '../content/blocks.js';
import {
  blockForEditor, cleanupFiles, createPage, deletePage, isShownLinkPage, loadPage, pageForEditor, pageSettings, savePage, settingsNormalize, syncUsername,
  userPages,
} from '../content/pages.js';
import { renderPage } from '../content/render.js';
import { stats } from '../content/stats.js';
import { layoutKey, themeKey } from '../content/themes.js';
import { UPLOAD_QUOTA_MB, UPLOAD_QUOTA_PREMIUM_MB, handleUpload, sweepUploads, uploadKinds, userUploadFiles } from '../content/uploads.js';
import { entries, isArr, jsonDecode, own, values, type PhpArr } from '../content/util.js';
import { hcForEditor } from '../honeycombs/honeycombs.js';
import { REQUEST_ID, adminMode, buy } from '../honeycombs/shop.js';
import { phpFloatString } from '../community/json.js';
import {
  CODE_MAX_FILES, codeChangeAddress, codeCreate, codeDeleteRows, codeEditorState, codeFileCount, codeSave, codeSite, codeSiteById, codeSiteOfUser, codeUnlocked,
} from '../code/sites.js';
import {
  SLOT_BUSY_TEXT, SLOT_GONE_TEXT, SLOT_RATE_MAX, SLOT_RATE_TEXT, SLOT_RATE_WINDOW, SlotBusyError, SlotGoneError, pageAllowance, pageLimitText, slotRateKey,
  withSlotLock, type SlotUser,
} from '../code/slots.js';
import { beforePageRemoved } from '../domains/index.js';
import { claimAddress, isTakenError, releaseAddress } from '../content/addresses.js';
import { currentPage, hasPremium } from './context.js';
import { accountApi } from './accountApi.js';
import { sendWeeklyReport } from './report.js';
import { statusEditorApi } from '../status/editorApi.js';

// Aktionen, die die Link-Seite eines Platzes bearbeiten (oder ihre Zahlen zeigen) – nicht, solange er eine Code-Seite zeigt
const LINK_PAGE_ACTIONS: ReadonlySet<string> = new Set(['save', 'preview', 'address', 'stats']);
const PAGE_BLOCKED_TEXT = 'This page shows a code page that has been blocked by the team. It can’t be deleted right now.';
// Die Seite gibt es nicht mehr (anderer Tab) oder sie gehört inzwischen einem anderen Konto (Admin-Modus)
const PAGE_GONE = { ok: false, error: 'This page no longer exists, or you’re now logged in with a different account. Please reload the editor.', reload: true };

// 30-Tage-Regel für Adressänderungen: Tage bis zur nächsten Änderung (0 = jetzt möglich)
function addressDaysLeft(changedAt: unknown): number {
  const changed = phpTruthy(changedAt) ? strtotime(phpStr(changedAt)) : 0;
  if (changed === false || !phpTruthy(changed)) return 0;
  const left = 30 - intval(Math.floor((time() - changed) / 86400));
  return left > 0 ? left : 0;
}
const addressDaysText = (days: number): string => `You can change your address again in ${days} ` + (days === 1 ? 'day.' : 'days.');

// is_scalar()
const isScalar = (v: unknown): boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

// Ganzzahliger Array-Schlüssel in PHP ("5", "-3"; nicht "05", "-0", "1.5" oder außerhalb von 64 Bit)
function isIntKey(k: string): boolean {
  if (k.length > 20 || !/^(?:0|-?[1-9][0-9]*)$/.test(k)) return false;
  const n = BigInt(k);
  return n >= -(2n ** 63n) && n <= 2n ** 63n - 1n;
}

// array_slice($a, 0, $len) mit Schlüsseln: ganzzahlige Schlüssel werden neu durchgezählt, Text-Schlüssel bleiben
export function sliceEntries(arr: PhpArr, len: number): Array<[string, unknown]> {
  let next = 0;
  return entries(arr).slice(0, len).map(([k, v]): [string, unknown] => [isIntKey(k) ? String(next++) : k, v]);
}

// (string) $input[$key] für eine Zahl der ersten Ebene aus dem JSON: In PHP ist eine ganze Zahl (bis 2^63-1) ein int
// mit allen Stellen, alles andere ein float (precision 14: 4.6316989E+14, 6.04E-6). Eine JavaScript-Zahl verliert ab
// 2^53 Stellen, und phpStr() kennt den Unterschied int/float nicht. Discord-IDs haben 17–20 Stellen – darum zählt hier
// der Text der Zahl in der Anfrage.
export function jsonValueText(raw: Buffer, key: string, value: unknown): string {
  if (typeof value !== 'number') return phpStr(value);
  const sources = new Map<unknown, string | undefined>();
  // php-ok: JSON.parse nur, um den Text der Zahl zu finden (json_decode() hat dieselben Bytes schon angenommen)
  const root: unknown = JSON.parse(raw.toString('utf8'), function (this: unknown, k: string, v: unknown, c?: { source?: string }) {
    if (k === key && typeof v === 'number') sources.set(this, c?.source);
    return v;
  });
  const source = sources.get(root) ?? '';
  if (/^-?(?:0|[1-9][0-9]*)$/.test(source)) {
    const n = BigInt(source);
    if (n >= -(2n ** 63n) && n <= 2n ** 63n - 1n) return n.toString();
  }
  return phpFloatString(value);
}

// Seite der Anfrage: $input['page']['id'] ?? $input['page_id'] ?? $_POST['page_id'] ?? $_GET['page'] (?? wie in PHP:
// nur null und „fehlt“ gehen weiter, eine 0 nicht), dann nur ganze Zahlen > 0
export function requestedPageId(input: PhpArr, post: PhpArray, get: PhpArray): number | null {
  const v = own(own(input, 'page'), 'id') ?? own(input, 'page_id') ?? own(post, 'page_id') ?? own(get, 'page') ?? null;
  return isScalar(v) && intval(v) > 0 ? intval(v) : null;
}

// ID eines Blocks in der Vorschau: $b['id'] ?? 'n' . $i, nur aus Buchstaben und Ziffern (preg_match('/^[a-z0-9]+$/i'):
// $ erlaubt ein \n am Ende), sonst 'n' . $i. (string) -0.0 ist in PHP "-0" (json_decode macht nur aus "-0.0" eine -0).
export function previewBlockId(b: PhpArr, key: string): string {
  const raw = own(b, 'id') ?? 'n' + key;
  const id = Object.is(raw, -0) ? '-0' : phpStr(raw);
  return /^[a-z0-9]+(?=\n?$)/i.test(id) ? id : 'n' + key;
}

export async function editorApi(ctx: Ctx, user: Row): Promise<void> {
  const userId = intval(user.id);
  const premium = hasPremium(ctx, user);
  const session = ctx.session!;

  const action = ctx.path.slice('/dashboard/api/'.length);
  const isPost = ctx.method === 'POST';
  if (isPost && !csrfCheck(ctx, csrfFromRequest(ctx))) {
    ctx.json({ ok: false, error: 'Session expired – please reload the page.' }, 419);
  }
  // stripos($_SERVER['CONTENT_TYPE'], 'application/json'): JSON nur mit passendem Typ und nur per POST
  const isJsonBody = strtolower(String(ctx.headers['content-type'] ?? '')).includes('application/json');
  const raw = isPost && isJsonBody ? ctx.rawBody : Buffer.alloc(0);
  // json_decode($raw, true) auf den Bytes: ungültiges UTF-8 ist wie in PHP ein Fehler
  const decoded: unknown = raw.length ? jsonDecode(raw) : [];
  if (!isArr(decoded)) {
    // Kaputtes JSON nie als „leere Seite“ speichern
    ctx.json({ ok: false, error: 'Not all of the data arrived. Please try again.' }, 400);
  }
  const input: PhpArr = decoded;
  const inp = (key: string): unknown => own(input, key);

  const requestedPage = requestedPageId(input, ctx.post, ctx.get);
  let page: Row | null;
  if (requestedPage !== null && action !== 'page-create') {
    // Nie still auf eine andere Seite ausweichen: gelöschte Seite (anderer Tab) oder inzwischen ein anderes Konto
    // (Admin-Modus in einem zweiten Tab) → ablehnen statt die falsche Seite zu überschreiben
    page = await loadPage(requestedPage);
    if (!page || intval(page.user_id) !== userId) {
      ctx.json(PAGE_GONE, 409);
    }
    // Der Platz zeigt inzwischen eine Code-Seite: seine Link-Seite ist geparkt und wird nicht mehr bearbeitet (ein
    // älterer Tab darf nichts in sie schreiben)
    if (!isShownLinkPage(page) && LINK_PAGE_ACTIONS.has(action)) {
      ctx.json({ ok: false, error: 'This page now shows a code page. Please reload the editor.', reload: true }, 409);
    }
    session.set('page_id', requestedPage);
  } else {
    page = await currentPage(ctx, user);
  }
  if ((action === 'save' || action === 'address') && requestedPage === null) {
    ctx.json({ ok: false, error: 'The request doesn’t say which page it’s for. Please reload the editor.', reload: true }, 400);
  }

  // Honigwaben und Code-Seite gehören zum Konto, nicht zu einer Profilseite
  if (action === 'honeycombs') {
    ctx.json({ ok: true, honeycombs: await hcForEditor(userId) });
  }
  // Glocke, Nachrichten und Termine ebenso (auch ohne gezeigte Profilseite)
  await accountApi(ctx, userId, action, isPost, input);
  if (action.startsWith('code')) await codeApi(ctx, user, action, isPost, input);
  // Statusseiten (status*): gehören zum Konto bzw. zu OnYourSites eigener Seite, nie zu einer Profilseite
  if (action === 'status' || action.startsWith('status-')) await statusEditorApi(ctx, user, action, isPost, input);

  // Hochladen gehört zum Konto, nicht zu einer Seite (auch Bilder für die Code-Seite)
  if (action === 'upload' && isPost) {
    const kind = phpStr(ctx.post.kind ?? '');
    const file = ctx.files.file;
    if (!file) {
      ctx.json({ ok: false, error: 'No file received (it may be too large for the server).' });
    }
    if (!(await rateLimit('upload:' + userId, 120, 3600))) {
      ctx.json({ ok: false, error: 'Too many uploads in a short time – please wait a moment.' });
    }
    // Speicherplatz begrenzen (vorher nie gespeicherte Uploads aufräumen)
    const quotaMb = premium ? UPLOAD_QUOTA_PREMIUM_MB : UPLOAD_QUOTA_MB;
    let usedBytes = 0;
    for (const size of (await sweepUploads(userId, userUploadFiles(userId))).values()) usedBytes += size;
    // Feld file[…]: in PHP sind size und error Arrays – (int) davon ist 1, oys_handle_upload() meldet Fehler 1
    if (usedBytes + (file.multiple ? 1 : intval(file.size ?? 0)) > quotaMb * 1048576) {
      ctx.json({ ok: false, error: 'Your storage (' + quotaMb + ' MB) is full. Remove images, music or files you no longer need and save.' });
    }
    const res = !file.multiple ? await handleUpload(file, kind, userId)
      : { error: Object.hasOwn(uploadKinds(), kind) ? 'Upload failed (error code 1).' : 'Unknown upload type.' };
    if ('error' in res) ctx.json({ ok: false, error: res.error });
    ctx.json({ ok: true, file: res.file, url: uploadUrl(res.file) });
  }

  // Seite anlegen geht auch ohne bestehende Seite – unter der Sperre der Seitenplätze des Kontos (code/slots.ts):
  // Anzahl, Adresse und Anlegen sehen denselben Stand, auch bei gleichzeitigen Anfragen
  if (action === 'page-create' && isPost) {
    if (!(await rateOk(slotRateKey(userId), SLOT_RATE_MAX, SLOT_RATE_WINDOW))) ctx.json({ ok: false, error: SLOT_RATE_TEXT });
    const slug = normalizeSlug(inp('slug') ?? '');
    const cleanTitle = cleanText(inp('title') ?? '', 120);
    const title = phpTruthy(cleanTitle) ? cleanTitle : phpStr(user.full_name ?? '');
    let created: { error: string } | { id: number; first: boolean } = { error: '' };
    try {
      created = await slotChange(ctx, userId, async (db, locked) => {
        const count = intval(await db.value('SELECT COUNT(*) FROM pages WHERE user_id = ?', [userId]));
        const allowance = await pageAllowance(ctx, locked, db);
        if (count >= allowance.max && !allowance.unlimited) return { error: pageLimitText(allowance.max) };
        // Eigene reservierte Adressen (in den letzten 30 Tagen freigegeben) darf man wieder nehmen
        const problem = await slugProblem(slug, null, null, { userId, db });
        if (problem !== null) return { error: problem };
        // Ist die Adresse inzwischen vergeben, wirft createPage – die Transaktion wird zurückgerollt
        return { id: await createPage(userId, slug, title, db), first: count === 0 };
      });
    } catch (err) {
      // Gleichzeitige Anfrage hat die Adresse genommen: Meldung statt Fehler 500, nichts angelegt
      if (!isTakenError(err)) throw err;
      ctx.json({ ok: false, error: `Sorry, the address “${slug}” is already taken.` });
    }
    if ('error' in created) ctx.json({ ok: false, error: created.error });
    await rateHit(slotRateKey(userId), SLOT_RATE_WINDOW);
    session.set('page_id', created.id);
    if (created.first) await syncUsername(userId);
    ctx.json({ ok: true, id: created.id });
  }

  // Ab hier Aktionen des Kontos, die auch ohne gezeigte Link-Seite gehen (alle Plätze können Code-Seiten zeigen)
  if (action === 'page-delete' && isPost) {
    const target = await loadPage(intval(inp('id') ?? 0));
    if (!target || intval(target.user_id) !== userId) {
      ctx.json({ ok: false, error: 'Page not found.' }, 404);
    }
    // Die letzte Seite bleibt – gezählt werden alle Plätze, auch die mit Code-Seite
    if ((await userPages(userId)).length <= 1) {
      ctx.json({ ok: false, error: 'You can’t delete your last page.' });
    }
    if ((inp('confirm') ?? '') !== target.slug) {
      ctx.json({ ok: false, error: 'To confirm, please type the page’s address.' });
    }
    if (!isShownLinkPage(target) && phpTruthy((await codeSiteById(intval(target.code_site_id)))?.is_blocked)) {
      ctx.json({ ok: false, error: PAGE_BLOCKED_TEXT });
    }
    if (!(await rateOk(slotRateKey(userId), SLOT_RATE_MAX, SLOT_RATE_WINDOW))) ctx.json({ ok: false, error: SLOT_RATE_TEXT });
    const deleted = await slotChange(ctx, userId, async (db) => {
      // Unter der Sperre noch einmal: die Seite, die Zahl der Plätze und die Code-Seite des Platzes (gesperrt – eine
      // Sperre durch das Team, die gerade kommt, gilt)
      const page = await db.one('SELECT * FROM pages WHERE id = ? AND user_id = ? FOR UPDATE', [intval(target.id), userId]);
      if (!page) return { error: 'Page not found.', status: 404 };
      if (intval(await db.value('SELECT COUNT(*) FROM pages WHERE user_id = ?', [userId])) <= 1) return { error: 'You can’t delete your last page.' };
      const site = isShownLinkPage(page) ? null : await codeSiteOfUser(userId, intval(page.code_site_id), db, true);
      if (site && phpTruthy(site.is_blocked)) return { error: PAGE_BLOCKED_TEXT };
      // Eigene Domain der Seite entfernen (nur Datenbank; nach allen Prüfungen, damit eine abgelehnte Löschung nie eine
      // Domain trennt)
      await beforePageRemoved(intval(page.id), db);
      const codeUploads = site ? await codeDeleteRows(db, site) : new Set<string>();
      const files = await deletePage(page, db);
      return { files: [...files, ...codeUploads] };
    });
    if ('error' in deleted) ctx.json({ ok: false, error: deleted.error }, deleted.status ?? 200);
    // Nach dem Commit: Dateien der Seite und Bilder der Code-Seite, die nichts anderes mehr benutzt
    await cleanupFiles(userId, deleted.files);
    session.delete('page_id');
    await syncUsername(userId);
    await rateHit(slotRateKey(userId), SLOT_RATE_WINDOW);
    ctx.json({ ok: true });
  }

  if (action === 'weekly' && isPost) {
    await exec('UPDATE users SET weekly_report = ? WHERE id = ?', [phpTruthy(inp('enabled')) ? 1 : 0, userId]);
    ctx.json({ ok: true });
  }

  if (action === 'weekly-test' && isPost) {
    // Ohne gezeigte Link-Seite gibt es nichts zu berichten (zählt nicht als Test)
    if (!(await userPages(userId)).some(isShownLinkPage)) {
      ctx.json({ ok: false, error: 'There’s no link page to report on yet.' });
    }
    if (!(await rateLimit('weeklytest:' + userId, 3, 3600))) {
      ctx.json({ ok: false, error: 'You can send up to 3 test reports per hour.' });
    }
    const ok = await sendWeeklyReport(user);
    ctx.json(ok ? { ok: true } : { ok: false, error: 'The email couldn’t be sent. Please check the mail settings in the admin area.' });
  }

  if (action === 'discord' && isPost) {
    const discord = jsonValueText(raw, 'discord_id', inp('discord_id') ?? '').replace(/[^0-9]/g, '');
    await exec('UPDATE users SET discord_id = ? WHERE id = ?', [discord !== '' ? (encryptData(discord.slice(0, 25)) ?? '') : '', userId]);
    ctx.json({ ok: true });
  }

  if (!page) {
    ctx.json({ ok: false, error: 'Create a page first.' }, 404);
  }

  switch (action) {
    case 'preview': {
      if (!isPost) break;
      const pIn = inp('page') ?? null;
      const p: PhpArr = isArr(pIn) ? pIn : [];
      const get = (key: string): unknown => own(p, key);
      const draft: Row = {
        ...page,
        title: cleanText(get('title') ?? '', 120),
        subtitle: cleanText(get('subtitle') ?? '', 160),
        bio: cleanText(get('bio') ?? '', 1000, true),
        avatar: validUpload(get('avatar') ?? '', userId, IMAGE_EXTS),
        bg_image: validUpload(get('bg_image') ?? '', userId, IMAGE_EXTS),
        theme: themeKey(get('theme') ?? page.theme),
        layout: layoutKey(get('layout') ?? page.layout),
        // json_encode() ohne Optionen (renderPage liest die Einstellungen wieder daraus)
        settings: phpJson(settingsNormalize(get('settings') ?? [], userId, premium, pageSettings(page))),
      };
      const blocks: Array<Record<string, unknown>> = [];
      const blocksIn = inp('blocks') ?? null;
      for (const [i, b] of sliceEntries(isArr(blocksIn) ? blocksIn : [], 150)) {
        if (!isArr(b)) continue;
        const norm = await blockNormalize(b, userId, null, true);
        if (!norm) continue;
        blocks.push({
          id: previewBlockId(b, i),
          type: norm.type,
          is_visible: norm.is_visible,
          data: norm.data,
          schedule: norm.schedule,
          protection: norm.protection,
          effect: norm.effect,
        });
      }
      ctx.header('Content-Type', 'text/html; charset=utf-8');
      ctx.header('Cache-Control', 'no-store');
      ctx.send(renderPage(draft, blocks, {
        mode: 'preview',
        entrance: (inp('entrance') ?? '') === 'show' ? 'show' : 'skip',
        host: ctx.host,
      }));
    }
    case 'save': {
      if (!isPost) break;
      if (!isArr(inp('page') ?? null) || !isArr(inp('blocks') ?? null)) {
        ctx.json({ ok: false, error: 'Not all of the data arrived. Please try again.' }, 400);
      }
      let result;
      try {
        result = await savePage(page, input, userId, premium);
      } catch (err) {
        console.error('Saving failed: ' + (err instanceof Error ? err.message : String(err)));
        ctx.json({ ok: false, error: 'Saving failed. Please try again.' }, 500);
      }
      ctx.json({
        ok: true,
        page: pageForEditor(result.page as Row),
        blocks: result.blocks.map(blockForEditor),
        // Reihenfolge der Schlüssel wie in PHP (savePage liefert sie schon so)
        idmap: result.idmap,
        warnings: result.warnings,
      });
    }
    case 'address': {
      if (!isPost) break;
      const slug = normalizeSlug(inp('slug') ?? page.slug);
      const mode = (inp('mode') ?? 'subdomain') === 'path' ? 'path' : 'subdomain';
      if (slug !== page.slug) {
        const daysLeft = addressDaysLeft(page.slug_changed_at);
        if (daysLeft > 0 && !premium) ctx.json({ ok: false, error: addressDaysText(daysLeft) });
        const problem = await slugProblem(slug, intval(page.id), null, { userId });
        if (problem !== null) ctx.json({ ok: false, error: problem });
        // Neue Adresse belegen, alte für den Besitzer reservieren – zusammen mit der Seite (Sperren: pages → Adressen).
        // Die Seite wird dafür gesperrt neu gelesen: Hat ein anderer Tab die Adresse inzwischen geändert oder die Seite
        // gelöscht, gilt das – freigegeben wird nur die Adresse, die die Seite wirklich hat, und für eine gelöschte Seite
        // wird nichts belegt.
        let refused: { body: Record<string, unknown>; status: number } | null = null;
        try {
          refused = await transaction(async (_conn, db) => {
            const cur = await db.one('SELECT slug, slug_changed_at FROM pages WHERE id = ? AND user_id = ? FOR UPDATE', [intval(page.id), userId]);
            if (!cur) return { body: PAGE_GONE, status: 409 };
            if (phpStr(cur.slug) !== phpStr(page.slug)) {
              // Inzwischen geändert: dann gilt die Sperrfrist dieser Änderung (wie bei zwei Änderungen nacheinander)
              const left = premium ? 0 : addressDaysLeft(cur.slug_changed_at);
              if (left > 0) return { body: { ok: false, error: addressDaysText(left) }, status: 200 };
              if (phpStr(cur.slug) === slug) return null;
            }
            await db.exec('UPDATE pages SET slug = ?, slug_changed_at = ? WHERE id = ?', [slug, date('Y-m-d H:i:s'), intval(page.id)]);
            await claimAddress(db, slug, 'page', intval(page.id), userId);
            await releaseAddress(db, phpStr(cur.slug), userId, 'owner', { kind: 'page', refId: intval(page.id) });
            return null;
          });
        } catch (err) {
          if (!isTakenError(err)) throw err;
          ctx.json({ ok: false, error: `Sorry, the address “${slug}” is already taken.` });
        }
        if (refused) ctx.json(refused.body, refused.status);
      }
      // Namen, die OnYourSite auf der Hauptdomain selbst benutzt (z. B. /suggestions): nur als Subdomain
      if (mode === 'path' && reservedPaths().includes(slug)) {
        ctx.json({ ok: false, error: `This address is used by OnYourSite on the main domain – your page stays at ${slug}.${baseAuthority()}.` });
      }
      await exec('UPDATE pages SET address_mode = ? WHERE id = ?', [mode, page.id as Param]);
      await syncUsername(userId);
      const saved = await loadPage(intval(page.id));
      if (!saved) ctx.json(PAGE_GONE, 409);
      ctx.json({ ok: true, page: pageForEditor(saved) });
    }
    case 'stats': {
      let range = intval(ctx.get.range ?? 7);
      if (![7, 30, 90, 0].includes(range)) range = 7;
      ctx.json({ ok: true, stats: await stats(page, range) });
    }
  }
  ctx.json({ ok: false, error: 'Unknown action.' }, 404);
}

// Änderung unter der Sperre der Seitenplätze des Kontos. Kommt die Sperre nicht (3 s), antwortet die Anfrage „busy“;
// gibt es das Konto nicht mehr, 409 mit reload. Beides beendet die Anfrage.
async function slotChange<T>(ctx: Ctx, userId: number, fn: (db: Db, user: SlotUser) => Promise<T>): Promise<T> {
  try {
    return await withSlotLock(userId, fn);
  } catch (err) {
    if (err instanceof SlotBusyError) ctx.json({ ok: false, error: SLOT_BUSY_TEXT, busy: true });
    if (err instanceof SlotGoneError) ctx.json({ ok: false, error: SLOT_GONE_TEXT, reload: true }, 409);
    throw err;
  }
}

// Code-Seite: alle Aktionen, die mit „code“ beginnen (enden immer hier)
async function codeApi(ctx: Ctx, user: Row, action: string, isPost: boolean, input: PhpArr): Promise<never> {
  const userId = intval(user.id);
  const inp = (key: string): unknown => own(input, key);
  const site = await codeSite(userId);
  const termsAccepted = phpTruthy(user.code_terms_at);
  const state = async (): Promise<Record<string, unknown>> => ({ ok: true, ...(await codeEditorState(userId)) });

  if (action === 'code') ctx.json(await state());
  if (!isPost) ctx.json({ ok: false, error: 'Not found.' }, 404);
  // Freischalten über den Shop (Vertrag der Kauf-Routen): Anfrage-ID aus dem Dialog und der Preis, den er zeigte.
  // Die Regeln akzeptiert der Kauf selbst (in seiner Transaktion) – im Admin-Modus wird also nichts geschrieben.
  if (action === 'code-unlock') {
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
    const r = await buy(ctx, userId, 'code_page', requestId as string, price, { via: 'code', terms: phpTruthy(inp('terms')) });
    // Schon freigeschaltet: Erfolg ohne Abbuchung (wie bisher)
    if (r.ok) ctx.json({ ...(await state()), notices: r.notices });
    if (r.code === 'owned') ctx.json(await state());
    ctx.json(r.price === undefined ? { ok: false, code: r.code, error: r.error } : { ok: false, code: r.code, price: r.price, error: r.error }, r.status);
  }
  // Wer die Regeln noch nicht akzeptiert hat, muss es jetzt tun
  if (action === 'code-create' && !termsAccepted) {
    if (!phpTruthy(inp('terms'))) {
      ctx.json({ ok: false, error: 'Please read and accept the rules for code pages first.' });
    }
    await exec('UPDATE users SET code_terms_at = ? WHERE id = ?', [date('Y-m-d H:i:s'), userId]);
  }
  if (!(await codeUnlocked(userId))) {
    ctx.json({ ok: false, error: 'Unlock code pages with honeycombs first.' }, 403);
  }
  if (action === 'code-create') {
    const [, error] = await codeCreate(userId, normalizeSlug(inp('slug') ?? ''), phpStr(inp('title') ?? ''));
    ctx.json(phpTruthy(error) ? { ok: false, error } : await state());
  }
  if (!site) {
    ctx.json({ ok: false, error: 'Create your code page first.' }, 404);
  }
  if (phpTruthy(site.is_blocked)) {
    ctx.json({ ok: false, error: 'Your code page has been blocked by the team' + (phpTruthy(site.blocked_reason) ? ': ' + phpStr(site.blocked_reason) : '.') });
  }
  if (action === 'code-save') {
    // Dateien in der Reihenfolge der Anfrage (json_decode behält sie), gelöschte Pfade nur als Text
    const filesIn = inp('files') ?? null;
    const files: PhpArr = isArr(filesIn) ? filesIn : [];
    const deletedIn = inp('deleted') ?? null;
    const deleted = values(isArr(deletedIn) ? deletedIn : []).filter((x) => typeof x === 'string');
    if (codeFileCount(files) > CODE_MAX_FILES * 2 || deleted.length > CODE_MAX_FILES * 2) {
      ctx.json({ ok: false, error: 'Too many files.' }, 400);
    }
    const error = await codeSave(site, files, deleted);
    if (phpTruthy(error)) ctx.json({ ok: false, error });
    // array_key_exists(): auch ein null-Wert zählt als vorhanden
    const title = Object.hasOwn(input, 'title') ? cleanText(inp('title'), 120) : site.title;
    const online = Object.hasOwn(input, 'online') ? phpTruthy(inp('online')) : phpTruthy(site.is_published);
    await exec('UPDATE code_sites SET title = ?, is_published = ? WHERE id = ?', [(title !== '' ? title : site.slug) as Param, online ? 1 : 0, site.id as Param]);
    ctx.json(await state());
  }
  if (action === 'code-address') {
    const slug = normalizeSlug(inp('slug') ?? '');
    if (slug !== site.slug) {
      const problem = await codeChangeAddress(site, slug, userId);
      if (problem !== null) ctx.json({ ok: false, error: problem });
    }
    ctx.json(await state());
  }
  ctx.json({ ok: false, error: 'Not found.' }, 404);
}
