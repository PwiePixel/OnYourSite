// /dashboard/api/{aktion}: JSON-Schnittstelle des Editors (lib/routes_app.php, Abschnitt „Editor-API“).
// Die Reihenfolge der Prüfungen ist die von PHP: CSRF vor dem JSON, Seiten-ID vor allem anderen (auch vor Code-Seite
// und Upload), dann die Aktion. Jede Antwort endet mit ctx.json() (= oys_json(); exit).
import type { Ctx } from '../web/ctx.js';
import { exec, type Param, type Row } from '../db.js';
import { config } from '../config.js';
import { csrfCheck, csrfFromRequest, rateLimit } from '../web/security.js';
import { encryptData } from '../crypto.js';
import { cleanText, normalizeSlug, slugProblem, uploadUrl } from '../helpers.js';
import { phpJson } from '../html.js';
import { date, intval, phpStr, phpTruthy, strtolower, strtotime, time, type PhpArray } from '../php.js';
import { IMAGE_EXTS, blockNormalize, validUpload } from '../content/blocks.js';
import {
  blockForEditor, createPage, deletePage, loadPage, pageForEditor, pageSettings, savePage, settingsNormalize, syncUsername, userPages,
} from '../content/pages.js';
import { renderPage } from '../content/render.js';
import { stats } from '../content/stats.js';
import { layoutKey, themeKey } from '../content/themes.js';
import { UPLOAD_QUOTA_MB, UPLOAD_QUOTA_PREMIUM_MB, handleUpload, sweepUploads, uploadKinds, userUploadFiles } from '../content/uploads.js';
import { entries, isArr, jsonDecode, own, values, type PhpArr } from '../content/util.js';
import { hcForEditor, hcSettings, hcSpend } from '../honeycombs/honeycombs.js';
import { phpFloatString } from '../community/json.js';
import { CODE_MAX_FILES, codeCreate, codeEditorState, codeFileCount, codeSave, codeSite, codeUnlocked } from '../code/sites.js';
import { currentPage, hasPremium } from './context.js';
import { accountApi } from './accountApi.js';
import { sendWeeklyReport } from './report.js';

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
      ctx.json({ ok: false, error: 'This page no longer exists, or you’re now logged in with a different account. Please reload the editor.', reload: true }, 409);
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

  // Seite anlegen geht auch ohne bestehende Seite
  if (action === 'page-create' && isPost) {
    const count = (await userPages(userId)).length;
    const max = intval(config('max_pages', 3));
    if (count >= max && !premium) {
      ctx.json({ ok: false, error: `You can create up to ${max} ` + (max === 1 ? 'page.' : 'pages.') });
    }
    const slug = normalizeSlug(inp('slug') ?? '');
    const problem = await slugProblem(slug);
    if (problem !== null) ctx.json({ ok: false, error: problem });
    const cleanTitle = cleanText(inp('title') ?? '', 120);
    const title = phpTruthy(cleanTitle) ? cleanTitle : phpStr(user.full_name ?? '');
    const newId = await createPage(userId, slug, title);
    session.set('page_id', newId);
    if (count === 0) await syncUsername(userId);
    ctx.json({ ok: true, id: newId });
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
        const changed = phpTruthy(page.slug_changed_at) ? strtotime(phpStr(page.slug_changed_at)) : 0;
        const last = changed === false ? 0 : changed;
        const daysLeft = 30 - intval(Math.floor((time() - last) / 86400));
        if (phpTruthy(changed) && daysLeft > 0 && !premium) {
          ctx.json({ ok: false, error: `You can change your address again in ${daysLeft} ` + (daysLeft === 1 ? 'day.' : 'days.') });
        }
        const problem = await slugProblem(slug, intval(page.id));
        if (problem !== null) ctx.json({ ok: false, error: problem });
        await exec('UPDATE pages SET slug = ?, slug_changed_at = ? WHERE id = ?', [slug, date('Y-m-d H:i:s'), page.id as Param]);
      }
      await exec('UPDATE pages SET address_mode = ? WHERE id = ?', [mode, page.id as Param]);
      await syncUsername(userId);
      ctx.json({ ok: true, page: pageForEditor((await loadPage(intval(page.id))) as Row) });
    }
    case 'page-delete': {
      if (!isPost) break;
      const target = await loadPage(intval(inp('id') ?? 0));
      if (!target || intval(target.user_id) !== userId) {
        ctx.json({ ok: false, error: 'Page not found.' }, 404);
      }
      if ((await userPages(userId)).length <= 1) {
        ctx.json({ ok: false, error: 'You can’t delete your last page.' });
      }
      if ((inp('confirm') ?? '') !== target.slug) {
        ctx.json({ ok: false, error: 'To confirm, please type the page’s address.' });
      }
      await deletePage(target);
      session.delete('page_id');
      await syncUsername(userId);
      ctx.json({ ok: true });
    }
    case 'stats': {
      let range = intval(ctx.get.range ?? 7);
      if (![7, 30, 90, 0].includes(range)) range = 7;
      ctx.json({ ok: true, stats: await stats(page, range) });
    }

    case 'weekly': {
      if (!isPost) break;
      await exec('UPDATE users SET weekly_report = ? WHERE id = ?', [phpTruthy(inp('enabled')) ? 1 : 0, userId]);
      ctx.json({ ok: true });
    }

    case 'weekly-test': {
      if (!isPost) break;
      if (!(await rateLimit('weeklytest:' + userId, 3, 3600))) {
        ctx.json({ ok: false, error: 'You can send up to 3 test reports per hour.' });
      }
      const ok = await sendWeeklyReport(user);
      ctx.json(ok ? { ok: true } : { ok: false, error: 'The email couldn’t be sent. Please check the mail settings in the admin area.' });
    }

    case 'discord': {
      if (!isPost) break;
      const discord = jsonValueText(raw, 'discord_id', inp('discord_id') ?? '').replace(/[^0-9]/g, '');
      await exec('UPDATE users SET discord_id = ? WHERE id = ?', [discord !== '' ? (encryptData(discord.slice(0, 25)) ?? '') : '', userId]);
      ctx.json({ ok: true });
    }
  }
  ctx.json({ ok: false, error: 'Unknown action.' }, 404);
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
  // Wer die Regeln noch nicht akzeptiert hat, muss es jetzt tun
  if ((action === 'code-unlock' || action === 'code-create') && !termsAccepted) {
    if (!phpTruthy(inp('terms'))) {
      ctx.json({ ok: false, error: 'Please read and accept the rules for code pages first.' });
    }
    await exec('UPDATE users SET code_terms_at = ? WHERE id = ?', [date('Y-m-d H:i:s'), userId]);
  }
  if (action === 'code-unlock') {
    const error = await hcSpend(userId, (await hcSettings()).code_page, 'code_page');
    if (phpTruthy(error)) ctx.json({ ok: false, error });
    ctx.json(await state());
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
      const problem = await slugProblem(slug, null, intval(site.id));
      if (problem !== null) ctx.json({ ok: false, error: problem });
      await exec('UPDATE code_sites SET slug = ?, updated_at = ? WHERE id = ?', [slug, date('Y-m-d H:i:s'), site.id as Param]);
    }
    ctx.json(await state());
  }
  ctx.json({ ok: false, error: 'Not found.' }, 404);
}
