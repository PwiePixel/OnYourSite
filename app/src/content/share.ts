// Teilen (lib/share.php): Adressen zum Teilen und das Vorschaubild (og:image) für geteilte Links – Discord, WhatsApp,
// X & Co. zeigen es als Karte. Das Bild wird beim ersten Abruf erzeugt und im Upload-Ordner unter og/ zwischengespeichert.
// Gezeichnet wird wie mit GD (gdImage.ts), Text gemessen und gesetzt wie GD mit FreeType (ogFont.ts).
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { PCRE_WS } from '../compat/core.js';
import { ROOT_DIR } from '../config.js';
import { safeEqual } from '../crypto.js';
import { baseAuthority, initials, pageOrigin, pageUrl, type PageLike } from '../helpers.js';
import { intval, phpLtrim, phpRtrim, phpStr, phpTrim, phpTruthy, rawurlencode } from '../php.js';
import type { Ctx } from '../web/ctx.js';
import { GdImage, trueColorAlpha } from './gdImage.js';
import { gdTextWidth, loadFont } from './ogFont.js';
import { idx, phpRound, strArg } from './phpValues.js';
import { isFile, uploadReadPath, uploadsDir } from './storage.js';
import { loadPage, pageSettings } from './pages.js';
import { DEFAULT_THEME, themeKey, themes } from './themes.js';
import { basename, own } from './util.js';

// /\s+/u von PCRE (Unicode-Leerraum, aber nicht U+FEFF)
const U_SPACES = new RegExp('[' + PCRE_WS + ']+', 'gu');

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

// oys_share_links(): Adressen zum Teilen (Discord hat keine – dort wird der Link eingefügt und als Karte angezeigt)
export function shareLinks(url: string, title: string): { whatsapp: string; x: string } {
  return {
    whatsapp: 'https://wa.me/?text=' + rawurlencode(title !== '' ? title + ' ' + url : url),
    x: 'https://x.com/intent/tweet?url=' + rawurlencode(url) + (title !== '' ? '&text=' + rawurlencode(title) : ''),
  };
}

// oys_og_supported(): Node zeichnet mit @napi-rs/canvas (immer vorhanden) – wie in PHP zählt nur, ob die Schrift da ist
export function ogSupported(): boolean {
  return isFile(ogFont(true));
}

// oys_og_font()
export function ogFont(bold: boolean): string {
  return ROOT_DIR + '/static/fonts/inter-' + (bold ? '700' : '400') + '.ttf';
}

// oys_og_hash(): Kennung des Bildes – ändert sich, sobald sich etwas Sichtbares ändert; dann laden Discord & Co. es neu.
// Muss genau wie in PHP sein, sonst gelten bereits geteilte Adressen und gespeicherte Bilder nicht mehr.
export function ogHash(page: Record<string, unknown>): string {
  const s = pageSettings(page);
  const parts = [
    'og-1', intval(page.id ?? 0), page.slug ?? '', page.address_mode ?? '', page.title ?? '',
    page.subtitle ?? '', phpStr(page.bio ?? ''), phpStr(page.avatar ?? ''),
    themeKey(page.theme ?? DEFAULT_THEME), own(s, 'accent'), phpTruthy(own(s, 'hide_branding')) ? 1 : 0, baseAuthority(),
  ];
  // Live-Domain (Premium) als letzter Teil: die Karte zeigt sie als Adresse. Ohne Domain bleibt der Wert wie bisher.
  if (phpStr(page.custom_domain ?? '') !== '') parts.push(page.custom_domain);
  return createHash('sha1').update(parts.map(phpStr).join('\n'), 'utf8').digest('hex').slice(0, 12);
}

// oys_og_url()
export function ogUrl(page: Record<string, unknown>): string {
  return pageOrigin(page as unknown as PageLike) + '/_/og/' + intval(page.id) + '-' + ogHash(page) + '.png';
}

// ---------------------------------------------------------------- Vorschaubild zeichnen und ausliefern

type Rgb = [number, number, number];

// oys_og_serve(): /_/og/{id}-{hash}.png ausliefern (aus dem Zwischenspeicher oder frisch erzeugt)
export async function ogServe(ctx: Ctx, id: number, hash: string): Promise<void> {
  const page = await loadPage(id);
  if (!page || !ogSupported()) {
    ctx.status = 404;
    ctx.halt();
  }
  const current = ogHash(page);
  if (!safeEqual(current, hash)) {
    // Alte Adresse (Seite wurde geändert): zum aktuellen Bild weiterleiten, nichts neu erzeugen
    ctx.header('Cache-Control', 'public, max-age=300');
    ctx.redirect('/_/og/' + id + '-' + current + '.png');
  }
  const dir = uploadsDir() + '/og';
  const file = dir + '/' + id + '-' + current + '.png';
  let png: Buffer;
  if (!isFile(file)) {
    png = await ogRender(page);
    // Fehler beim Speichern bleiben still (wie @mkdir/@unlink/@file_put_contents) – das Bild wird trotzdem geliefert
    try {
      mkdirSync(dir, { recursive: true, mode: 0o755 });
    } catch {
      /* wie @mkdir */
    }
    // Ältere Bilder dieser Seite aufräumen (glob "{id}-*.png")
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      /* Ordner fehlt */
    }
    const prefix = id + '-';
    for (const name of names) {
      if (name.startsWith(prefix) && name.endsWith('.png') && name.length >= prefix.length + 4) {
        try {
          unlinkSync(dir + '/' + name);
        } catch {
          /* wie @unlink */
        }
      }
    }
    try {
      writeFileSync(file + '.tmp', png);
      try {
        renameSync(file + '.tmp', file);
      } catch {
        /* wie @rename */
      }
    } catch {
      /* wie @file_put_contents */
    }
  } else {
    try {
      png = readFileSync(file);
    } catch {
      png = Buffer.alloc(0);
    }
  }
  ctx.header('Content-Type', 'image/png');
  ctx.header('Content-Length', String(png.length));
  // Browser: ein Jahr (die Adresse ändert sich mit dem Inhalt). Zwischenspeicher wie Cloudflare: eine Stunde –
  // ist die Seite gelöscht oder das Bild entfernt, verschwindet die Karte dort bald
  ctx.header('Cache-Control', 'public, max-age=31536000, s-maxage=3600, immutable');
  ctx.send(png);
}

// oys_og_render(): Hintergrund in den Farben des Designs, Profilbild, Name, Untertitel und Adresse; PNG 1200×630
export async function ogRender(pageIn: object): Promise<Buffer> {
  const page = pageIn as Record<string, unknown>;
  const W = OG_WIDTH;
  const H = OG_HEIGHT;
  const s = pageSettings(page);
  const theme = themes()[themeKey(page.theme ?? DEFAULT_THEME)];
  const dark = theme.dark;
  const accent = ogRgb(strArg(phpTruthy(s.accent) ? s.accent : theme.accent));
  const base: Rgb = dark ? [11, 11, 15] : [248, 248, 251];
  const text: Rgb = dark ? [255, 255, 255] : [24, 24, 27];
  const muted: Rgb = dark ? [161, 161, 170] : [82, 82, 91];
  // Akzentfarbe, die sich vom Hintergrund abhebt (z. B. Weiß auf hellem Design → dunkel)
  const accentText = ogContrast(accent, base) >= 2.2 ? accent : text;

  const im = new GdImage(W, H);

  // Weicher Farbverlauf: viele Ellipsen mit wenig Deckkraft übereinander ergeben runde Lichtflecken
  im.fill(0, 0, trueColorAlpha(base[0], base[1], base[2], 0));
  const glow = trueColorAlpha(accent[0], accent[1], accent[2], dark ? 122 : 124);
  for (const [cx, cy, rw, rh] of [[90, 40, 1150, 900], [1130, 640, 1000, 760]]) {
    for (let i = 0; i < 48; i++) {
      const f = 1 - i / 48;
      im.filledEllipse(cx, cy, Math.trunc(rw * f), Math.trunc(rh * f), glow);
    }
  }

  // Profilbild (oder Initialen) mit Ring in der Akzentfarbe
  const disc = 300;
  const avatar = await ogAvatar(page, disc, accent, base, dark);
  im.copy(avatar, 96, Math.trunc((H - disc) / 2), 0, 0, disc, disc);

  // Texte rechts daneben
  const x = 456;
  const maxW = W - x - 90;
  const cleaned = ogClean(phpStr(page.title ?? ''));
  const title = phpTruthy(cleaned) ? cleaned : phpStr(idx(page, 'slug'));
  let sub = ogClean(phpStr(page.subtitle ?? ''));
  if (sub === '') {
    const token = strtokNewline(phpStr(page.bio ?? ''));
    sub = ogClean(token !== false && phpTruthy(token) ? token : '');
  }
  const address = pageUrl(page as unknown as PageLike).replace(/^https?:\/\//, '');

  // Name: Schrift verkleinern, bis er in zwei Zeilen passt – erst bei der kleinsten Größe kürzen
  let size = 72;
  for (; size > 48; size -= 4) {
    if (ogWrap(title, ogFont(true), size, maxW, 99).length <= 2) break;
  }
  const titleLines = ogWrap(title, ogFont(true), size, maxW, 2);
  const subLines = sub !== '' ? ogWrap(sub, ogFont(false), 32, maxW, 2) : [];

  // Block aus Name, Untertitel und Adresse senkrecht mittig setzen (y = Oberkante der jeweiligen Zeile)
  const lineH = Math.trunc(phpRound(size * 1.16));
  const block = titleLines.length * lineH + (subLines.length ? 16 + subLines.length * 44 : 0) + 30 + 36;
  let y = Math.trunc((H - block) / 2);
  const cText = trueColorAlpha(text[0], text[1], text[2], 0);
  const cMuted = trueColorAlpha(muted[0], muted[1], muted[2], 0);
  const cAccent = trueColorAlpha(accentText[0], accentText[1], accentText[2], 0);
  for (const line of titleLines) {
    im.text(size, x, y + Math.trunc(phpRound(size * 0.92)), cText, ogFont(true), line);
    y += lineH;
  }
  if (subLines.length) {
    y += 16;
    for (const line of subLines) {
      im.text(32, x, y + 32, cMuted, ogFont(false), line);
      y += 44;
    }
  }
  y += 30;
  im.text(30, x, y + 30, cAccent, ogFont(true), ogFit(address, ogFont(true), 30, maxW));

  if (!phpTruthy(s.hide_branding)) {
    const mark = 'OnYourSite';
    const w = ogWidth(mark, ogFont(true), 24);
    im.text(24, W - w - 48, H - 42, cMuted, ogFont(true), mark);
  }
  return im.png(6);
}

// strtok($s, "\n"): erstes Stück zwischen Zeilenumbrüchen (führende werden übersprungen), false wenn keins
function strtokNewline(s: string): string | false {
  let a = 0;
  while (a < s.length && s[a] === '\n') a++;
  if (a >= s.length) return false;
  const b = s.indexOf('\n', a);
  return s.slice(a, b < 0 ? s.length : b);
}

// oys_og_avatar(): rundes Profilbild mit Ring (doppelt so groß gezeichnet und verkleinert → glatte Kanten)
export async function ogAvatar(page: Record<string, unknown>, size: number, accent: Rgb, base: Rgb, dark: boolean): Promise<GdImage> {
  const big = size * 2;
  const im = new GdImage(big, big);
  im.alphaBlending = false;
  im.fill(0, 0, trueColorAlpha(0, 0, 0, 127));
  im.alphaBlending = true;
  im.filledEllipse(size, size, big - 4, big - 4, trueColorAlpha(accent[0], accent[1], accent[2], 0));
  const gap = 14;
  im.filledEllipse(size, size, big - 4 - 2 * gap, big - 4 - 2 * gap, trueColorAlpha(base[0], base[1], base[2], 0));

  const inner = big - 4 - 2 * gap - 2 * 10;
  const photo = await ogLoadImage(phpStr(page.avatar ?? ''));
  const disc = new GdImage(inner, inner);
  if (photo) {
    // Quadratisch zuschneiden (Mitte), auf die Kreisgröße bringen
    const pw = photo.width;
    const ph = photo.height;
    const side = Math.min(pw, ph);
    disc.copyResampled(photo, 0, 0, Math.trunc((pw - side) / 2), Math.trunc((ph - side) / 2), inner, inner, side, side);
  } else {
    const bg = dark ? ogMix(accent, [0, 0, 0], 0.55) : ogMix(accent, [255, 255, 255], 0.75);
    disc.fill(0, 0, trueColorAlpha(bg[0], bg[1], bg[2], 0));
    const title = page.title ?? '';
    const ini = ogClean(initials(phpStr(title !== '' ? page.title : idx(page, 'slug'))));
    const fs = Math.trunc(inner * 0.3);
    const w = ogWidth(ini, ogFont(true), fs);
    const c = dark ? [255, 255, 255] : ogMix(accent, [0, 0, 0], 0.35);
    disc.text(fs, Math.trunc((inner - w) / 2), Math.trunc(inner / 2 + fs * 0.36), trueColorAlpha(c[0], c[1], c[2], 0), ogFont(true), ini);
  }
  // Als Kreis maskieren
  const r = inner / 2;
  const off = Math.trunc((big - inner) / 2);
  for (let py = 0; py < inner; py++) {
    for (let px = 0; px < inner; px++) {
      const d = Math.sqrt((px - r + 0.5) ** 2 + (py - r + 0.5) ** 2);
      if (d <= r) im.setPixel(off + px, off + py, disc.getPixel(px, py));
    }
  }

  const out = new GdImage(size, size);
  out.alphaBlending = false;
  out.saveAlpha = true;
  out.fill(0, 0, trueColorAlpha(0, 0, 0, 127));
  out.copyResampled(im, 0, 0, 0, 0, size, size, big, big);
  out.alphaBlending = true;
  return out;
}

// getimagesize() für die Bildarten, die GD hier lädt: Art und Größe aus dem Dateikopf wie ext/standard/image.c (sonst null)
function imageInfo(b: Buffer): { type: 'jpeg' | 'png' | 'gif' | 'webp'; width: number; height: number; animated: boolean } | null {
  const sig = b.toString('latin1', 0, 3);
  if (sig === 'GIF') {
    return b.length >= 11 ? { type: 'gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8), animated: false } : null;
  }
  if (b.length >= 3 && b[0] === 0x89 && sig.slice(1) === 'PN') {
    if (!b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) || b.length < 25) return null;
    return { type: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20), animated: false };
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    // php_handle_jpeg(): Markierungen bis zum ersten SOFn (Füllbytes und fremde Bytes davor überspringen)
    const read2 = (p: number): number => (p + 2 <= b.length ? b.readUInt16BE(p) : 0);
    let p = 3;
    let ffRead = true;
    for (;;) {
      if (!ffRead) {
        while (p < b.length && b[p] !== 0xff) p++;
        if (p >= b.length) return null;
        p++;
      }
      ffRead = false;
      let marker: number;
      do {
        if (p >= b.length) return null;
        marker = b[p++];
      } while (marker === 0xff);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: 'jpeg', width: read2(p + 5), height: read2(p + 3), animated: false };
      }
      if (marker === 0xda || marker === 0xd9) return null;
      const length = read2(p);
      if (length < 2) return null;
      p += length;
    }
  }
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' && b.toString('latin1', 12, 15) === 'VP8') {
    const f = b[15];
    if (f === 0x20) return { type: 'webp', width: b[26] + ((b[27] & 0x3f) << 8), height: b[28] + ((b[29] & 0x3f) << 8), animated: false };
    if (f === 0x4c) return { type: 'webp', width: b[21] + ((b[22] & 0x3f) << 8) + 1, height: (b[22] >> 6) + (b[23] << 2) + ((b[24] & 0xf) << 10) + 1, animated: false };
    if (f === 0x58) return { type: 'webp', width: b[24] + (b[25] << 8) + (b[26] << 16) + 1, height: b[27] + (b[28] << 8) + (b[29] << 16) + 1, animated: (b[20] & 0x02) !== 0 };
  }
  return null;
}

// imagecreatefromgif() (gd_gif_in.c) liest nur das erste Einzelbild – in dessen eigener Größe, ohne den Versatz auf
// der Fläche. Es scheitert bei einer anderen Version als 87a/89a, einem leeren oder über die Fläche hinausragenden
// Einzelbild, einer Code-Größe über 12 und abgeschnittenen Köpfen; Erweiterungen und fremde Bytes vor dem Bild
// überspringt es. Farben: die eigene Tabelle, sonst die globale, ohne beide Schwarz mit Weiß an Stelle 1 – fehlende
// Einträge sind schwarz; durchsichtig ist die Farbe aus dem letzten Steuerblock mit gesetztem Bit. Gibt das erste
// Einzelbild als eigenes, schlichtes GIF zurück (mit voller Farbtabelle – so liest sharp genau das), sonst null.
function gifFirstFrame(b: Buffer): Buffer | null {
  const version = b.toString('latin1', 3, 6);
  if (b.length < 13 || (version !== '87a' && version !== '89a')) return null;
  const screenW = b.readUInt16LE(6);
  const screenH = b.readUInt16LE(8);
  const gct = b[10] & 0x80 ? b.subarray(13, 13 + 3 * (2 << (b[10] & 0x07))) : null;
  let p = 13 + (gct ? 3 * (2 << (b[10] & 0x07)) : 0);
  let transparent = -1;
  for (;;) {
    if (p >= b.length) return null;
    const c = b[p++];
    // Ende vor dem ersten Bild
    if (c === 0x3b) return null;
    if (c === 0x21) {
      // Erweiterung: Art, dann Datenblöcke (Länge, Daten) bis zu einem leeren Block. Steuerblock (0xF9): sein erster
      // Datenblock zählt nie als Ende (auch leer nicht); darin Bit 0 des ersten Bytes = durchsichtige Farbe, ihr Index
      // im vierten Byte (fehlende Bytes zählen als 0)
      const label = b[p++];
      for (let first = label === 0xf9; p < b.length; first = false) {
        const n = b[p++];
        if (first && n > 0 && b[p] & 1) transparent = n >= 4 ? b[p + 3] ?? 0 : 0;
        if (n === 0 && !first) break;
        p += n;
      }
      continue;
    }
    if (c !== 0x2c) continue;
    if (p + 9 > b.length) return null;
    const width = b.readUInt16LE(p + 4);
    const height = b.readUInt16LE(p + 6);
    const flags = b[p + 8];
    if (b.readUInt16LE(p) + width > screenW || b.readUInt16LE(p + 2) + height > screenH || width === 0 || height === 0) return null;
    p += 9;
    // Eigene Farbtabelle, dann die Code-Größe des LZW-Verfahrens
    const lct = flags & 0x80 ? b.subarray(p, p + 3 * (2 << (flags & 0x07))) : null;
    if (lct) p += lct.length;
    if (p >= b.length || b[p] > 12) return null;
    // Bilddaten: Code-Größe und Datenblöcke bis zum leeren Block (oder bis zum Dateiende)
    let end = p + 1;
    while (end < b.length) {
      const n = b[end++];
      if (n === 0) break;
      end += n;
    }
    const head = Buffer.alloc(13);
    head.write('GIF89a', 0, 'latin1');
    head.writeUInt16LE(width, 6);
    head.writeUInt16LE(height, 8);
    head[10] = 0x87;
    const colors = Buffer.alloc(3 * 256);
    if (lct) lct.copy(colors);
    else if (gct) gct.copy(colors);
    else colors.fill(0xff, 3, 6);
    const gce = transparent >= 0 ? Buffer.from([0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, transparent, 0x00]) : Buffer.alloc(0);
    const desc = Buffer.alloc(10);
    desc[0] = 0x2c;
    desc.writeUInt16LE(width, 5);
    desc.writeUInt16LE(height, 7);
    // Nur den Zeilensprung übernehmen (die Farben stehen jetzt in der globalen Tabelle)
    desc[9] = flags & 0x40;
    return Buffer.concat([head, colors, gce, desc, b.subarray(p, Math.min(end, b.length)), Buffer.from([0x3b])]);
  }
}

// oys_og_load_image(): hochgeladenes Bild laden (nur aus dem Upload-Ordner, nur echte Bilddateien bis 15 MiB/40 MPx).
// Pixel wie GD: Alpha 7 Bit (127 - a/2), ICC-Profile werden nicht angewendet, fehlerhafte Daten so weit wie lesbar;
// animiertes WebP kann GD nicht lesen → null (dann Initialen); bei GIF nur das erste Einzelbild wie GD
export async function ogLoadImage(file: string): Promise<GdImage | null> {
  const name = basename(file);
  const path = uploadReadPath(name);
  if (name === '' || !isFile(path) || statSync(path).size > 15 * 1024 * 1024) return null;
  let data: Buffer;
  try {
    data = readFileSync(path);
  } catch {
    return null;
  }
  const info = imageInfo(data);
  if (!info || info.width * info.height > 40000000 || info.animated) return null;
  const frame = info.type === 'gif' ? gifFirstFrame(data) : null;
  if (info.type === 'gif' && !frame) return null;
  try {
    // sharp erst hier laden (nur wenn ein Vorschaubild mit Foto gezeichnet wird)
    const { default: sharp } = await import('sharp');
    const options = { limitInputPixels: false, ignoreIcc: true, failOn: 'none' } as const;
    if (info.type === 'jpeg' && (await sharp(data, options).metadata()).space === 'cmyk') return await cmykJpeg(sharp(data, options), jpegAdobe(data));
    const { data: px, info: out } = await sharp(frame ?? data, options)
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (out.channels !== 4) return null;
    const img = new GdImage(out.width, out.height);
    // Deckend: JPEG und RGB-PNG – auch mit tRNS-Farbe (GD merkt sie sich nur, die Pixel bleiben deckend)
    const opaque = info.type === 'jpeg' || (info.type === 'png' && data[25] === 2);
    for (let i = 0; i < out.width * out.height; i++) {
      const a = opaque ? 0 : 127 - (px[i * 4 + 3] >> 1);
      img.px[i] = trueColorAlpha(px[i * 4], px[i * 4 + 1], px[i * 4 + 2], a);
    }
    return img;
  } catch {
    return null;
  }
}

// Hat ein JPEG die Adobe-Kennung (APP14 mit „Adobe“, mindestens 12 Bytes)? Dann ist CMYK für GD invertiert gespeichert.
function jpegAdobe(b: Buffer): boolean {
  let p = 2;
  while (p + 4 <= b.length && b[p] === 0xff) {
    const marker = b[p + 1];
    if (marker === 0xff) {
      p++;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break;
    const length = b.readUInt16BE(p + 2);
    if (marker === 0xee && length - 2 >= 12 && b.toString('latin1', p + 4, p + 9) === 'Adobe') return true;
    p += 2 + length;
  }
  return false;
}

// CMYK-JPEG (auch YCCK) wie gd_jpeg.c: R = (255 - C) · (255 - K) / 255 usw. (ganzzahlig), die Werte mit Adobe-Kennung
// invertiert gelesen. sharp liefert CMYK immer invertiert – ohne Adobe-Kennung also zurückdrehen.
async function cmykJpeg(input: import('sharp').Sharp, adobe: boolean): Promise<GdImage | null> {
  const { data: px, info: out } = await input.pipelineColourspace('cmyk').toColourspace('cmyk').raw().toBuffer({ resolveWithObject: true });
  if (out.channels !== 4) return null;
  const flip = adobe ? 0 : 255;
  const img = new GdImage(out.width, out.height);
  for (let i = 0; i < out.width * out.height; i++) {
    const k = 255 - Math.abs(flip - px[i * 4 + 3]);
    const ch = (j: number): number => Math.trunc(((255 - Math.abs(flip - px[i * 4 + j])) * k) / 255);
    img.px[i] = trueColorAlpha(ch(0), ch(1), ch(2), 0);
  }
  return img;
}

// oys_og_clean(): Emoji und Steuerzeichen raus (die Schrift kennt sie nicht), Leerraum zusammenfassen
export function ogClean(s: string): string {
  s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200B}-\u{200F}\u{E0000}-\u{E007F}]/gu, '');
  return phpTrim(s.replace(U_SPACES, ' '));
}

// oys_og_width(): Breite wie imagettfbbox() (|brect[2] - brect[0]|)
export function ogWidth(s: string, font: string, size: number): number {
  return gdTextWidth(loadFont(font), s, size);
}

// oys_og_wrap(): Text auf höchstens maxLines Zeilen umbrechen, die letzte bei Bedarf mit … kürzen
export function ogWrap(s: string, font: string, size: number, maxW: number, maxLines: number): string[] {
  const words = s.split(U_SPACES).filter((w) => w !== '');
  const lines: string[] = [];
  let line = '';
  for (const [i, word] of words.entries()) {
    const attempt = line === '' ? word : line + ' ' + word;
    if (line !== '' && ogWidth(attempt, font, size) > maxW) {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) {
        lines[maxLines - 1] = ogFit(lines[maxLines - 1] + ' ' + words.slice(i).join(' '), font, size, maxW);
        return lines;
      }
    } else {
      line = attempt;
    }
  }
  if (line !== '') lines.push(ogFit(line, font, size, maxW));
  return lines.length ? lines : [''];
}

// oys_og_fit(): kürzen (Zeichen für Zeichen) und … anhängen, bis es passt
export function ogFit(s: string, font: string, size: number, maxW: number): string {
  if (ogWidth(s, font, size) <= maxW) return s;
  const chars = Array.from(s);
  while (chars.length > 1 && ogWidth(chars.join('') + '…', font, size) > maxW) chars.pop();
  return phpRtrim(chars.join('')) + '…';
}

// oys_og_rgb(): #rrggbb → [r, g, b] (ungültig → Indigo)
export function ogRgb(hex: string): Rgb {
  hex = phpLtrim(hex, '#');
  if (!/^[0-9a-f]{6}(?=\n?$)/i.test(hex)) return [99, 102, 241];
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

// oys_og_mix(): Farbe a in Richtung b mischen (t = 0 … 1)
export function ogMix(a: readonly number[], b: readonly number[], t: number): Rgb {
  return [0, 1, 2].map((i) => Math.trunc(phpRound(a[i] + (b[i] - a[i]) * t))) as Rgb;
}

// oys_og_contrast(): Kontrastverhältnis nach WCAG
export function ogContrast(a: readonly number[], b: readonly number[]): number {
  const lum = (c: readonly number[]): number => {
    const v = c.map((x) => {
      x /= 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  const l1 = lum(a);
  const l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
