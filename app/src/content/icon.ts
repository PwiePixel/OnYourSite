// Favicon einer Profilseite mit Premium (Q2 = c): /_/icon/{id}-{hash}.png ist ein 64 × 64 PNG aus dem Profilbild
// (Mitte ausgeschnitten, bei Animationen das erste Bild), mit sharp erzeugt und neben den Vorschaubildern
// zwischengespeichert (uploads/og/icon-{id}-{hash}.png). Die Adresse ändert sich mit dem Profilbild – darum darf der
// Browser sie ein Jahr behalten. Ohne Premium, ohne Profilbild oder wenn sharp scheitert: das Favicon von OnYourSite.
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { safeEqual } from '../crypto.js';
import { phpStr } from '../php.js';
import type { Ctx } from '../web/ctx.js';
import { isFile, uploadNameOk, uploadReadPath, uploadsDir } from './storage.js';
import { isShownLinkPage, loadPage, pageSettings } from './pages.js';
import { basename } from './util.js';
import { DEFAULT_FAVICON, iconHash, pageBranding } from './branding.js';

export const ICON_SIZE = 64;
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;

// 64 × 64 PNG aus einer hochgeladenen Datei; null, wenn es nicht geht (fehlt, zu groß, kein Bild)
export async function iconRender(avatar: string): Promise<Buffer | null> {
  const name = basename(avatar);
  if (!uploadNameOk(name)) return null;
  const path = uploadReadPath(name);
  try {
    if (!isFile(path) || statSync(path).size > MAX_BYTES) return null;
    // sharp erst hier laden (nur wenn ein Favicon erzeugt wird)
    const { default: sharp } = await import('sharp');
    return await sharp(readFileSync(path), { limitInputPixels: MAX_PIXELS, failOn: 'none' })
      .rotate()
      .resize(ICON_SIZE, ICON_SIZE, { fit: 'cover', position: 'centre' })
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}

// Gleichzeitige erste Abrufe desselben Favicons erzeugen es nur einmal
const inflight = new Map<string, Promise<Buffer | null>>();

// Speichern ohne Fehler nach außen (das Bild wird trotzdem geliefert); ältere Favicons dieser Seite aufräumen
function store(dir: string, file: string, id: number, png: Buffer): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
  } catch {
    /* Ordner fehlt und lässt sich nicht anlegen */
  }
  const prefix = 'icon-' + id + '-';
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    /* Ordner fehlt */
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.png')) continue;
    try {
      unlinkSync(dir + '/' + name);
    } catch {
      /* schon weg */
    }
  }
  const tmp = file + '.' + process.pid + '.tmp';
  try {
    writeFileSync(tmp, png);
    renameSync(tmp, file);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* nichts geschrieben */
    }
  }
}

// /_/icon/{id}-{hash}.png ausliefern (aus dem Zwischenspeicher oder frisch erzeugt)
export async function iconServe(ctx: Ctx, id: number, hash: string): Promise<void> {
  const page = await loadPage(id);
  // Die geparkte Link-Seite eines Platzes mit Code-Seite hat kein Favicon
  if (!page || !isShownLinkPage(page)) {
    ctx.status = 404;
    ctx.halt();
  }
  const fallback: () => never = () => {
    ctx.header('Cache-Control', 'public, max-age=300');
    ctx.redirect(DEFAULT_FAVICON);
  };
  const avatar = page.avatar === null || page.avatar === undefined ? '' : phpStr(page.avatar);
  // Nur mit Premium des Besitzers (wie der Titel ohne „| OnYourSite“); eine Seite ohne zeigt die Adresse gar nicht
  if (avatar === '' || !(await pageBranding(page, pageSettings(page))).fullyUnbranded) fallback();
  const current = iconHash(avatar);
  if (!safeEqual(current, hash)) {
    // Alte Adresse (neues Profilbild): zum aktuellen Favicon weiterleiten, nichts neu erzeugen
    ctx.header('Cache-Control', 'public, max-age=300');
    ctx.redirect('/_/icon/' + id + '-' + current + '.png');
  }
  const dir = uploadsDir() + '/og';
  const file = dir + '/icon-' + id + '-' + current + '.png';
  let png: Buffer | null = null;
  if (isFile(file)) {
    try {
      png = readFileSync(file);
    } catch {
      png = null;
    }
  }
  if (!png || png.length === 0) {
    const key = id + '-' + current;
    let job = inflight.get(key);
    if (!job) {
      job = iconRender(avatar).finally(() => inflight.delete(key));
      inflight.set(key, job);
    }
    png = await job;
    if (!png) fallback();
    store(dir, file, id, png);
  }
  ctx.header('Content-Type', 'image/png');
  ctx.header('Content-Length', String(png.length));
  // Browser: ein Jahr (die Adresse ändert sich mit dem Bild); Zwischenspeicher wie Cloudflare: eine Stunde (wie das
  // Vorschaubild – ein entferntes Profilbild verschwindet dort bald)
  ctx.header('Cache-Control', 'public, max-age=31536000, s-maxage=3600, immutable');
  ctx.send(png);
}
