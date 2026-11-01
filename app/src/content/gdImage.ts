// Truecolor-Bild wie GD 2.3 (gd.c), damit die Vorschaubilder wie in PHP entstehen: Pixel als Zahl mit 7-Bit-Alpha
// (0 = deckend, 127 = durchsichtig), Mischen mit gdAlphaBlend, gefüllte Ellipsen, Kopieren und Verkleinern mit
// derselben (float-)Rechnung wie libgd. Text: Stift-Positionen genau wie gdImageStringFTEx (ogFont.ts), die Kanten-
// glättung der einzelnen Zeichen zeichnet @napi-rs/canvas aus den Umrissen der Schrift (FreeType rechnet dort minimal anders).
import { createRequire } from 'node:module';
import { deflateSync, constants as zlibConstants, crc32 } from 'node:zlib';
import { gdLayout, loadFont } from './ogFont.js';

// @napi-rs/canvas erst beim ersten Zeichnen laden (spart Start-Zeit und Speicher in Prozessen ohne Vorschaubilder)
const requireModule = createRequire(import.meta.url);
let canvasModule: typeof import('@napi-rs/canvas') | null = null;
const createCanvas = (w: number, h: number) => (canvasModule ??= requireModule('@napi-rs/canvas') as typeof import('@napi-rs/canvas')).createCanvas(w, h);

export const ALPHA_MAX = 127;
export const ALPHA_TRANSPARENT = 127;

// gdTrueColorAlpha()
export const trueColorAlpha = (r: number, g: number, b: number, a: number): number => (a << 24) + (r << 16) + (g << 8) + b;
const alphaOf = (c: number): number => (c >> 24) & 0x7f;
const redOf = (c: number): number => (c >> 16) & 0xff;
const greenOf = (c: number): number => (c >> 8) & 0xff;
const blueOf = (c: number): number => c & 0xff;

// gdAlphaBlend(): src über dst (Ganzzahl-Rechnung wie in C; alle Werte sind positiv, | 0 schneidet ab)
export function alphaBlend(dst: number, src: number): number {
  const sa = (src >> 24) & 0x7f;
  if (sa === 0) return src;
  const da = (dst >> 24) & 0x7f;
  if (sa === ALPHA_TRANSPARENT) return dst;
  if (da === ALPHA_TRANSPARENT) return src;
  const sw = ALPHA_TRANSPARENT - sa;
  const dw = (((ALPHA_TRANSPARENT - da) * sa) / ALPHA_MAX) | 0;
  const tw = sw + dw;
  const a = ((sa * da) / ALPHA_MAX) | 0;
  const r = ((((src >> 16) & 0xff) * sw + ((dst >> 16) & 0xff) * dw) / tw) | 0;
  const g = ((((src >> 8) & 0xff) * sw + ((dst >> 8) & 0xff) * dw) / tw) | 0;
  const b = (((src & 0xff) * sw + (dst & 0xff) * dw) / tw) | 0;
  return (a << 24) + (r << 16) + (g << 8) + b;
}

export class GdImage {
  readonly px: Int32Array;
  // imagealphablending(): neu angelegte Truecolor-Bilder mischen
  alphaBlending = true;
  // imagesavealpha(): nur dann wird Alpha als PNG gespeichert
  saveAlpha = false;

  // imagecreatetruecolor(): schwarz, deckend
  constructor(readonly width: number, readonly height: number) {
    this.px = new Int32Array(width * height);
  }

  // gdImageGetPixel() / imagecolorat(): außerhalb 0
  getPixel(x: number, y: number): number {
    return x >= 0 && y >= 0 && x < this.width && y < this.height ? this.px[y * this.width + x] : 0;
  }

  // gdImageSetPixel(): außerhalb nichts; mit Mischen gdAlphaBlend, sonst Ersetzen
  setPixel(x: number, y: number, c: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = y * this.width + x;
    this.px[i] = this.alphaBlending ? alphaBlend(this.px[i], c) : c;
  }

  // gdImageFill(): Flächenfüllung (vierfach zusammenhängend, ohne Mischen) ab x/y – zeilenweise
  fill(x: number, y: number, nc: number): void {
    const w = this.width;
    const oc = this.getPixel(x, y);
    if (oc === nc || x < 0 || y < 0 || x >= w || y >= this.height) return;
    const px = this.px;
    const stack: number[] = [x, y];
    while (stack.length) {
      const sy = stack.pop()!;
      const sx = stack.pop()!;
      const row = sy * w;
      if (px[row + sx] !== oc) continue;
      let a = sx;
      let b = sx;
      while (a > 0 && px[row + a - 1] === oc) a--;
      while (b < w - 1 && px[row + b + 1] === oc) b++;
      px.fill(nc, row + a, row + b + 1);
      for (const ny of [sy - 1, sy + 1]) {
        if (ny < 0 || ny >= this.height) continue;
        const nrow = ny * w;
        let inRun = false;
        for (let i = a; i <= b; i++) {
          const same = px[nrow + i] === oc;
          if (same && !inRun) stack.push(i, ny);
          inRun = same;
        }
      }
    }
  }

  // Eine Zeile von x0 bis x1 setzen (wie gdImageSetPixel für jedes Pixel)
  private span(y: number, x0: number, x1: number, c: number): void {
    if (y < 0 || y >= this.height) return;
    const a = Math.max(0, x0);
    const b = Math.min(this.width - 1, x1);
    if (a > b) return;
    const row = y * this.width;
    if (!this.alphaBlending) {
      this.px.fill(c, row + a, row + b + 1);
      return;
    }
    // Gleiche Nachbarpixel ergeben dasselbe Ergebnis (die Lichtflecken haben breite einfarbige Ringe)
    let lastDst = -1;
    let lastRes = 0;
    for (let i = row + a; i <= row + b; i++) {
      const d = this.px[i];
      if (d !== lastDst) {
        lastDst = d;
        lastRes = alphaBlend(d, c);
      }
      this.px[i] = lastRes;
    }
  }

  // gdImageFilledEllipse(): Zeilen zwischen den Ellipsenpunkten (Mittelpunkt-Verfahren, ganze Pixel)
  filledEllipse(mx: number, my: number, w: number, h: number, c: number): void {
    const a = w >> 1;
    const b = h >> 1;
    this.span(my, mx - a, mx + a, c);
    let mx1 = mx - a;
    let my1 = my;
    let mx2 = mx + a;
    let my2 = my;
    const aq = a * a;
    const bq = b * b;
    const dx = aq * 2;
    const dy = bq * 2;
    let r = a * bq;
    let rx = r * 2;
    let ry = 0;
    let x = a;
    let oldY2 = -2;
    while (x > 0) {
      if (r > 0) {
        my1++;
        my2--;
        ry += dx;
        r -= ry;
      }
      if (r <= 0) {
        x--;
        mx1++;
        mx2--;
        rx -= dy;
        r += rx;
      }
      // gdImageSetPixel für (i, my2) und (i, my1) abwechselnd – bei my1 = my2 also zweimal je Pixel
      if (oldY2 !== my2) {
        this.span(my2, mx1, mx2, c);
        this.span(my1, mx1, mx2, c);
      }
      oldY2 = my2;
    }
  }

  // gdImageCopy() (Truecolor auf Truecolor): jedes Pixel über gdImageSetPixel
  copy(src: GdImage, dstX: number, dstY: number, srcX: number, srcY: number, w: number, h: number): void {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) this.setPixel(dstX + x, dstY + y, src.getPixel(srcX + x, srcY + y));
    }
  }

  // gdImageCopyResampled(): Flächenmittel mit Alpha-Gewichtung, in float gerechnet wie libgd
  copyResampled(src: GdImage, dstX: number, dstY: number, srcX: number, srcY: number, dstW: number, dstH: number, srcW: number, srcH: number): void {
    const f = Math.fround;
    for (let y = dstY; y < dstY + dstH; y++) {
      for (let x = dstX; x < dstX + dstW; x++) {
        let spixels = 0;
        let red = 0;
        let green = 0;
        let blue = 0;
        let alpha = 0;
        let alphaSum = 0;
        let contribSum = 0;
        const sy1 = f(f(f(y - dstY) * f(srcH)) / f(dstH));
        const sy2 = f(f(f(y + 1 - dstY) * f(srcH)) / f(dstH));
        let sy = sy1;
        do {
          let yportion: number;
          if (Math.floor(sy) === Math.floor(sy1)) {
            yportion = f(1.0 - f(sy - Math.floor(sy)));
            if (yportion > f(sy2 - sy1)) yportion = f(sy2 - sy1);
            sy = Math.floor(sy);
          } else if (sy === Math.floor(sy2)) {
            yportion = f(sy2 - Math.floor(sy2));
          } else {
            yportion = 1;
          }
          const sx1 = f(f(f(x - dstX) * f(srcW)) / f(dstW));
          const sx2 = f(f(f(x + 1 - dstX) * f(srcW)) / f(dstW));
          let sx = sx1;
          do {
            let xportion: number;
            if (Math.floor(sx) === Math.floor(sx1)) {
              xportion = f(1.0 - f(sx - Math.floor(sx)));
              if (xportion > f(sx2 - sx1)) xportion = f(sx2 - sx1);
              sx = Math.floor(sx);
            } else if (sx === Math.floor(sx2)) {
              xportion = f(sx2 - Math.floor(sx2));
            } else {
              xportion = 1;
            }
            const contribution = f(xportion * yportion);
            const p = src.getPixel(Math.trunc(sx) + srcX, Math.trunc(sy) + srcY);
            const alphaFactor = f((ALPHA_MAX - alphaOf(p)) * contribution);
            red = f(red + f(redOf(p) * alphaFactor));
            green = f(green + f(greenOf(p) * alphaFactor));
            blue = f(blue + f(blueOf(p) * alphaFactor));
            alpha = f(alpha + f(alphaOf(p) * contribution));
            alphaSum = f(alphaSum + alphaFactor);
            contribSum = f(contribSum + contribution);
            spixels = f(spixels + f(xportion * yportion));
            sx = f(sx + 1.0);
          } while (sx < sx2);
          sy = f(sy + 1);
        } while (sy < sy2);

        if (spixels !== 0) {
          red = f(red / spixels);
          green = f(green / spixels);
          blue = f(blue / spixels);
          alpha = f(alpha / spixels);
        }
        if (alphaSum !== 0) {
          if (contribSum !== 0) alphaSum = f(alphaSum / contribSum);
          red = f(red / alphaSum);
          green = f(green / alphaSum);
          blue = f(blue / alphaSum);
        }
        // Aufrunden auf den nächsten Kanalwert, höchstens 255 (bzw. 127)
        red = red >= 255.5 ? 255 : f(red + 0.5);
        blue = blue >= 255.5 ? 255 : f(blue + 0.5);
        green = green >= 255.5 ? 255 : f(green + 0.5);
        alpha = alpha >= ALPHA_MAX + 0.5 ? ALPHA_MAX : f(alpha + 0.5);
        this.setPixel(x, y, trueColorAlpha(Math.trunc(red), Math.trunc(green), Math.trunc(blue), Math.trunc(alpha)));
      }
    }
  }

  // imagettftext($im, $pt, 0, $x, $y, $color, $font, $text): Zeichen an den Stift-Positionen von GD, jedes einzeln
  // gerastert und wie gdft_draw_bitmap() gemischt (Deckung in 128 Stufen)
  text(pt: number, x: number, y: number, color: number, fontPath: string, text: string): void {
    const font = loadFont(fontPath);
    const scale = font.scaleFor(pt, 96);
    for (const { gid, pen } of gdLayout(font, text, pt).glyphs) {
      const { outline } = font.glyph(gid, scale);
      if (!outline.xs.length) continue;
      // Begrenzung des Bitmaps wie FreeType (auf ganze Pixel)
      const left = Math.floor(Math.min(...outline.xs) / 64);
      const right = Math.ceil(Math.max(...outline.xs) / 64);
      const top = Math.ceil(Math.max(...outline.ys) / 64);
      const bottom = Math.floor(Math.min(...outline.ys) / 64);
      const w = right - left;
      const h = top - bottom;
      if (w <= 0 || h <= 0) continue;
      const penX = Math.trunc(x + (pen * 96) / (300 * 64) + left);
      const penY = y - top;
      const coverage = rasterize(outline, left, top, w, h);
      this.drawCoverage(coverage, w, h, penX, penY, color);
    }
  }

  // gdft_draw_bitmap() für Truecolor: Deckung → Alpha (0–127), dann mischen
  private drawCoverage(cov: Uint8Array, w: number, h: number, penX: number, penY: number, fg: number): void {
    for (let row = 0; row < h; row++) {
      const yy = penY + row;
      if (yy < 0 || yy >= this.height) continue;
      for (let col = 0; col < w; col++) {
        let level = Math.trunc((cov[row * w + col] * ALPHA_MAX) / 255);
        if (level === 0) continue;
        level = Math.trunc((level * (ALPHA_MAX - alphaOf(fg))) / ALPHA_MAX);
        level = ALPHA_MAX - level;
        const xx = penX + col;
        if (xx < 0 || xx >= this.width) continue;
        const i = yy * this.width + xx;
        const c = (level << 24) + (fg & 0xffffff);
        this.px[i] = this.alphaBlending && alphaOf(this.px[i]) !== ALPHA_TRANSPARENT ? alphaBlend(this.px[i], c) : c;
      }
    }
  }

  // imagepng($im, null, 6): RGB (ohne imagesavealpha) bzw. RGBA, 8 Bit, 96 dpi (pHYs), Daten in 8-KiB-Blöcken
  png(level = 6): Buffer {
    const channels = this.saveAlpha ? 4 : 3;
    const stride = this.width * channels;
    const rows = Buffer.alloc((stride + 1) * this.height);
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < this.height; y++) {
      const line = Buffer.alloc(stride);
      for (let x = 0; x < this.width; x++) {
        const c = this.px[y * this.width + x];
        const o = x * channels;
        line[o] = redOf(c);
        line[o + 1] = greenOf(c);
        line[o + 2] = blueOf(c);
        // 7-Bit-Alpha zurück in 8 Bit wie gd_png.c (127 → 0, 0 → 255)
        if (channels === 4) line[o + 3] = 255 - ((alphaOf(c) << 1) + (alphaOf(c) >> 6));
      }
      writeFiltered(rows, y * (stride + 1), line, prev, channels);
      prev = line;
    }
    const idat = deflateSync(rows, { level, strategy: zlibConstants.Z_FILTERED });
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.width, 0);
    ihdr.writeUInt32BE(this.height, 4);
    ihdr[8] = 8;
    ihdr[9] = channels === 4 ? 6 : 2;
    const phys = Buffer.alloc(9);
    phys.writeUInt32BE(3780, 0);
    phys.writeUInt32BE(3780, 4);
    phys[8] = 1;
    const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('pHYs', phys)];
    for (let o = 0; o < idat.length; o += 8192) parts.push(chunk('IDAT', idat.subarray(o, o + 8192)));
    parts.push(chunk('IEND', Buffer.alloc(0)));
    return Buffer.concat(parts);
  }
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

// Zeilenfilter wie libpng: der mit der kleinsten Summe der (vorzeichenbehafteten) Beträge
function writeFiltered(out: Buffer, at: number, line: Buffer, prev: Buffer, bpp: number): void {
  const n = line.length;
  const cand = filterRows(n);
  for (let i = 0; i < n; i++) {
    const a = i >= bpp ? line[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    const x = line[i];
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    cand[0][i] = x;
    cand[1][i] = (x - a) & 0xff;
    cand[2][i] = (x - b) & 0xff;
    cand[3][i] = (x - ((a + b) >> 1)) & 0xff;
    cand[4][i] = (x - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
  }
  let best = 0;
  let bestSum = Infinity;
  for (let type = 0; type < 5; type++) {
    const f = cand[type];
    let sum = 0;
    for (let i = 0; i < n; i++) sum += f[i] < 128 ? f[i] : 256 - f[i];
    if (sum < bestSum) {
      bestSum = sum;
      best = type;
    }
  }
  out[at] = best;
  out.set(cand[best].subarray(0, n), at + 1);
}

// Puffer für die fünf Filter-Kandidaten einer Zeile (wiederverwendet)
let filterBuf: Uint8Array[] = [];
function filterRows(n: number): Uint8Array[] {
  if (!filterBuf.length || filterBuf[0].length < n) filterBuf = Array.from({ length: 5 }, () => new Uint8Array(n));
  return filterBuf;
}

// Umriss (26.6, y nach oben) als Deckung 0–255 in einem w×h-Raster mit der linken oberen Ecke bei (left, top) Pixel
function rasterize(o: { xs: number[]; ys: number[]; on: boolean[]; ends: number[] }, left: number, top: number, w: number, h: number): Uint8Array {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const X = (i: number): number => o.xs[i] / 64 - left;
  const Y = (i: number): number => top - o.ys[i] / 64;
  ctx.beginPath();
  let start = 0;
  for (const end of o.ends) {
    const n = end - start + 1;
    const at = (k: number): number => start + (((k % n) + n) % n);
    if (n > 1) {
      // Beginn auf dem ersten Punkt auf der Kurve; gibt es keinen, in der Mitte zwischen den ersten beiden
      let s = 0;
      while (s < n && !o.on[start + s]) s++;
      const onStart = s < n;
      const from = onStart ? s : 0;
      const sx = onStart ? X(start + s) : (X(at(0)) + X(at(1))) / 2;
      const sy = onStart ? Y(start + s) : (Y(at(0)) + Y(at(1))) / 2;
      ctx.moveTo(sx, sy);
      // TrueType: zwei Kontrollpunkte nacheinander haben einen gedachten Punkt auf der Kurve dazwischen
      let ctrl: [number, number] | null = null;
      for (let k = 1; k <= (onStart ? n - 1 : n); k++) {
        const i = at(from + k);
        const px = X(i);
        const py = Y(i);
        if (o.on[i]) {
          if (ctrl) ctx.quadraticCurveTo(ctrl[0], ctrl[1], px, py);
          else ctx.lineTo(px, py);
          ctrl = null;
        } else {
          if (ctrl) ctx.quadraticCurveTo(ctrl[0], ctrl[1], (ctrl[0] + px) / 2, (ctrl[1] + py) / 2);
          ctrl = [px, py];
        }
      }
      if (ctrl) ctx.quadraticCurveTo(ctrl[0], ctrl[1], sx, sy);
      else ctx.lineTo(sx, sy);
      ctx.closePath();
    }
    start = end + 1;
  }
  ctx.fillStyle = '#ffffff';
  ctx.fill('nonzero');
  const data = ctx.getImageData(0, 0, w, h).data;
  const cov = new Uint8Array(w * h);
  for (let i = 0; i < cov.length; i++) cov[i] = data[i * 4 + 3];
  return cov;
}
