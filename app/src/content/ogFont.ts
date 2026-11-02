// TrueType-Schrift lesen und Text messen wie GD 2.3 (imagettfbbox/imagettftext) mit FreeType 2.13, damit die
// Zeilenumbrüche der Vorschaubilder genau wie in PHP fallen. Nachgebaut ist, was GD und FreeType dabei tun:
// - Text: UTF-8 mit HTML-Entities (&#123; &#x7B; &amp; …) wie gdTcl_UtfToUniChar; 4-Byte-Zeichen zerfallen in Einzelbytes
// - Layout bei 300 dpi, Zeichnen bei 96 dpi (Größe in Punkt); Maßstab wie FT_Request_Metrics (Inter: ohne ganzzahlige ppem)
// - Umriss skaliert mit FT_MulFix, Hinting ohne Glyphen-Programme (v40, Rückwärtskompatibilität): Vorschub auf ganze
//   Pixel gerundet, linker Rand abgerundet (ft_glyphslot_grid_fit_metrics); keine Unterschneidung (keine kern-Tabelle)
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------- FreeType-Rechnung (26.6 und 16.16)

// FT_MulFix(): (a*b) / 65536, gerundet (halbe Werte von der Null weg)
export function mulFix(a: number, b: number): number {
  const ab = a * b;
  return Math.floor((ab + 0x8000 - (ab < 0 ? 1 : 0)) / 65536);
}

// FT_DivFix(): (a << 16) / b, gerundet
export function divFix(a: number, b: number): number {
  const s = (a < 0 ? -1 : 1) * (b < 0 ? -1 : 1);
  const q = b !== 0 ? Math.floor((Math.abs(a) * 65536 + Math.floor(Math.abs(b) / 2)) / Math.abs(b)) : 0x7fffffff;
  return s * q;
}

const pixRound = (x: number): number => Math.floor((x + 32) / 64) * 64;
const pixFloor = (x: number): number => Math.floor(x / 64) * 64;


// ---------------------------------------------------------------- Text wie GD

// HTML-4.0-Entities aus GD (entities.h): Name → Zeichen
const ENTITIES: Record<string, number> = Object.freeze(Object.fromEntries(
  ('AElig:198 Aacute:193 Acirc:194 Agrave:192 Alpha:913 Aring:197 Atilde:195 Auml:196 Beta:914 Ccedil:199 Chi:935 Dagger:8225 Delta:916 '
  + 'ETH:208 Eacute:201 Ecirc:202 Egrave:200 Epsilon:917 Eta:919 Euml:203 Gamma:915 Iacute:205 Icirc:206 Igrave:204 Iota:921 Iuml:207 '
  + 'Kappa:922 Lambda:923 Mu:924 Ntilde:209 Nu:925 OElig:338 Oacute:211 Ocirc:212 Ograve:210 Omega:937 Omicron:927 Oslash:216 Otilde:213 '
  + 'Ouml:214 Phi:934 Pi:928 Prime:8243 Psi:936 Rho:929 Scaron:352 Sigma:931 THORN:222 Tau:932 Theta:920 Uacute:218 Ucirc:219 Ugrave:217 '
  + 'Upsilon:933 Uuml:220 Xi:926 Yacute:221 Yuml:376 Zeta:918 aacute:225 acirc:226 acute:180 aelig:230 agrave:224 alefsym:8501 alpha:945 '
  + 'amp:38 and:8743 ang:8736 aring:229 asymp:8776 atilde:227 auml:228 bdquo:8222 beta:946 brvbar:166 bull:8226 cap:8745 ccedil:231 '
  + 'cedil:184 cent:162 chi:967 circ:710 clubs:9827 cong:8773 copy:169 crarr:8629 cup:8746 curren:164 dArr:8659 dagger:8224 darr:8595 '
  + 'deg:176 delta:948 diams:9830 divide:247 eacute:233 ecirc:234 egrave:232 empty:8709 emsp:8195 ensp:8194 epsilon:949 equiv:8801 '
  + 'eta:951 eth:240 euml:235 euro:8364 exist:8707 fnof:402 forall:8704 frac12:189 frac14:188 frac34:190 frasl:8260 gamma:947 ge:8805 '
  + 'gt:62 hArr:8660 harr:8596 hearts:9829 hellip:8230 iacute:237 icirc:238 iexcl:161 igrave:236 image:8465 infin:8734 int:8747 iota:953 '
  + 'iquest:191 isin:8712 iuml:239 kappa:954 lArr:8656 lambda:955 lang:9001 laquo:171 larr:8592 lceil:8968 ldquo:8220 le:8804 lfloor:8970 '
  + 'lowast:8727 loz:9674 lrm:8206 lsaquo:8249 lsquo:8216 lt:60 macr:175 mdash:8212 micro:181 middot:183 minus:8722 mu:956 nabla:8711 '
  + 'nbsp:160 ndash:8211 ne:8800 ni:8715 not:172 notin:8713 nsub:8836 ntilde:241 nu:957 oacute:243 ocirc:244 oelig:339 ograve:242 '
  + 'oline:8254 omega:969 omicron:959 oplus:8853 or:8744 ordf:170 ordm:186 oslash:248 otilde:245 otimes:8855 ouml:246 para:182 part:8706 '
  + 'permil:8240 perp:8869 phi:966 pi:960 piv:982 plusmn:177 pound:163 prime:8242 prod:8719 prop:8733 psi:968 quot:34 rArr:8658 '
  + 'radic:8730 rang:9002 raquo:187 rarr:8594 rceil:8969 rdquo:8221 real:8476 reg:174 rfloor:8971 rho:961 rlm:8207 rsaquo:8250 '
  + 'rsquo:8217 sbquo:8218 scaron:353 sdot:8901 sect:167 shy:173 sigma:963 sigmaf:962 sim:8764 spades:9824 sub:8834 sube:8838 sum:8721 '
  + 'sup:8835 sup1:185 sup2:178 sup3:179 supe:8839 szlig:223 tau:964 there4:8756 theta:952 thetasym:977 thinsp:8201 thorn:254 '
  + 'tilde:732 times:215 trade:8482 uArr:8657 uacute:250 uarr:8593 ucirc:251 ugrave:249 uml:168 upsih:978 upsilon:965 uuml:252 '
  + 'weierp:8472 xi:958 yacute:253 yen:165 yuml:255 zeta:950 zwj:8205 zwnj:8204').split(' ').map((p) => {
    const i = p.indexOf(':');
    return [p.slice(0, i), Number(p.slice(i + 1))];
  }),
));

const isHex = (b: number): boolean => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);

// gdTcl_UtfToUniChar() über den ganzen Text (bis zum ersten Nullbyte, wie die C-Schleife)
export function gdChars(s: string): number[] {
  const b = Buffer.from(s, 'utf8');
  const at = (i: number): number => (i < b.length ? b[i] : 0);
  const out: number[] = [];
  let i = 0;
  while (i < b.length && b[i] !== 0) {
    const byte = b[i];
    if (byte === 0x26) {
      // &#123; &#x7B; (höchstens 6 bzw. 5 Ziffern) oder &name; (höchstens 8 Zeichen)
      if (at(i + 1) === 0x23) {
        let n = 0;
        let k: number;
        let c = at(i + 2);
        if (c === 0x78 || c === 0x58) {
          for (k = 3; k < 8; k++) {
            c = at(i + k);
            if (!isHex(c)) break;
            n = n * 16 + parseInt(String.fromCharCode(c), 16);
          }
        } else {
          for (k = 2; k < 8; k++) {
            c = at(i + k);
            if (c < 0x30 || c > 0x39) break;
            n = n * 10 + (c - 0x30);
          }
        }
        if (c === 0x3b) {
          out.push(n);
          i += k + 1;
          continue;
        }
      } else {
        let name = '';
        for (let k = 1; k <= 9; k++) {
          const c = at(i + k);
          if (c === 0) break;
          if (c === 0x3b) {
            if (Object.hasOwn(ENTITIES, name)) {
              out.push(ENTITIES[name]);
              i += k + 1;
              name = '\0';
            }
            break;
          }
          name += String.fromCharCode(c);
        }
        if (name === '\0') continue;
      }
    }
    // UTF-8 mit höchstens 3 Bytes (TCL_UTF_MAX 3); alles andere zählt als einzelnes Zeichen
    if (byte < 0xc0) {
      out.push(byte);
      i += 1;
    } else if (byte < 0xe0 && (at(i + 1) & 0xc0) === 0x80) {
      out.push(((byte & 0x1f) << 6) | (at(i + 1) & 0x3f));
      i += 2;
    } else if (byte >= 0xe0 && byte < 0xf0 && (at(i + 1) & 0xc0) === 0x80 && (at(i + 2) & 0xc0) === 0x80) {
      out.push(((byte & 0x0f) << 12) | ((at(i + 1) & 0x3f) << 6) | (at(i + 2) & 0x3f));
      i += 3;
    } else {
      out.push(byte);
      i += 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------- Schriftdatei

// Umriss in 26.6 (skaliert), Konturen mit Punkten (on = auf der Kurve)
export interface Outline {
  xs: number[];
  ys: number[];
  on: boolean[];
  ends: number[];
}

interface Loaded extends Outline {
  pp1: number;
  pp2: number;
}

// Glyphe so geladen, wie FreeType sie für GD liefert
export interface GlyphMetrics {
  advance: number; // 26.6, ganze Pixel
  bearingX: number; // 26.6, abgerundet
  outline: Outline;
}

export class TtFont {
  private readonly b: Buffer;
  private readonly tables = new Map<string, { off: number; len: number }>();
  readonly unitsPerEm: number;
  // head.flags Bit 3: Maßstab aus ganzzahligen ppem (tt_size_reset)
  private readonly integerPpem: boolean;
  private readonly numGlyphs: number;
  private readonly numHMetrics: number;
  private readonly longLoca: boolean;
  private readonly cmapOff: number;
  private readonly metricsCache = new Map<string, GlyphMetrics>();

  constructor(data: Buffer) {
    this.b = data;
    const n = data.readUInt16BE(4);
    for (let i = 0; i < n; i++) {
      const o = 12 + i * 16;
      this.tables.set(data.toString('latin1', o, o + 4), { off: data.readUInt32BE(o + 8), len: data.readUInt32BE(o + 12) });
    }
    const head = this.table('head');
    this.unitsPerEm = data.readUInt16BE(head + 18);
    this.integerPpem = (data.readUInt16BE(head + 16) & 8) !== 0;
    this.longLoca = data.readInt16BE(head + 50) === 1;
    this.numGlyphs = data.readUInt16BE(this.table('maxp') + 4);
    this.numHMetrics = data.readUInt16BE(this.table('hhea') + 34);
    this.cmapOff = this.charmap();
  }

  private table(tag: string): number {
    const t = this.tables.get(tag);
    if (!t) throw new Error(`font table ${tag} missing`);
    return t.off;
  }

  // Erste Unicode-Tabelle in der Reihenfolge der Datei (wie GD: FT_ENCODING_UNICODE/MS_SYMBOL)
  private charmap(): number {
    const c = this.table('cmap');
    const n = this.b.readUInt16BE(c + 2);
    for (let i = 0; i < n; i++) {
      const r = c + 4 + i * 8;
      const platform = this.b.readUInt16BE(r);
      const encoding = this.b.readUInt16BE(r + 2);
      if (platform === 0 || (platform === 3 && (encoding === 0 || encoding === 1 || encoding === 10))) return c + this.b.readUInt32BE(r + 4);
    }
    throw new Error('font without unicode cmap');
  }

  // FT_Get_Char_Index()
  glyphIndex(cp: number): number {
    const b = this.b;
    const t = this.cmapOff;
    const format = b.readUInt16BE(t);
    let gid = 0;
    if (format === 4) {
      if (cp > 0xffff) return 0;
      const segX2 = b.readUInt16BE(t + 6);
      const ends = t + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const ranges = deltas + segX2;
      for (let s = 0; s < segX2; s += 2) {
        if (b.readUInt16BE(ends + s) < cp) continue;
        const start = b.readUInt16BE(starts + s);
        if (start > cp) break;
        const delta = b.readUInt16BE(deltas + s);
        const range = b.readUInt16BE(ranges + s);
        if (range === 0) {
          gid = (cp + delta) & 0xffff;
        } else {
          const p = ranges + s + range + (cp - start) * 2;
          const g = b.readUInt16BE(p);
          gid = g === 0 ? 0 : (g + delta) & 0xffff;
        }
        break;
      }
    } else if (format === 12) {
      const groups = b.readUInt32BE(t + 12);
      for (let g = 0; g < groups; g++) {
        const o = t + 16 + g * 12;
        const start = b.readUInt32BE(o);
        if (cp >= start && cp <= b.readUInt32BE(o + 4)) {
          gid = b.readUInt32BE(o + 8) + (cp - start);
          break;
        }
      }
    }
    return gid < this.numGlyphs ? gid : 0;
  }

  private hmtx(gid: number): { advance: number; lsb: number } {
    const h = this.table('hmtx');
    if (gid < this.numHMetrics) return { advance: this.b.readUInt16BE(h + gid * 4), lsb: this.b.readInt16BE(h + gid * 4 + 2) };
    return { advance: this.b.readUInt16BE(h + (this.numHMetrics - 1) * 4), lsb: this.b.readInt16BE(h + this.numHMetrics * 4 + (gid - this.numHMetrics) * 2) };
  }

  private location(gid: number): { off: number; len: number } {
    const l = this.table('loca');
    const glyf = this.table('glyf');
    const a = this.longLoca ? this.b.readUInt32BE(l + gid * 4) : this.b.readUInt16BE(l + gid * 2) * 2;
    const z = this.longLoca ? this.b.readUInt32BE(l + gid * 4 + 4) : this.b.readUInt16BE(l + gid * 2 + 2) * 2;
    return { off: glyf + a, len: z - a };
  }

  // load_truetype_glyph(): Umriss in 26.6 mit Phantompunkten pp1/pp2 (ungerundet, Hinting-Rückwärtskompatibilität)
  private load(gid: number, scale: number, depth: number): Loaded {
    const b = this.b;
    const { advance, lsb } = this.hmtx(gid);
    const { off, len } = this.location(gid);
    const out: Loaded = { xs: [], ys: [], on: [], ends: [], pp1: 0, pp2: 0 };
    const contours = len > 0 ? b.readInt16BE(off) : 0;
    const xMin = len > 0 && contours !== 0 ? b.readInt16BE(off + 2) : 0;
    // tt_loader_set_pp()
    out.pp1 = mulFix(xMin - lsb, scale);
    out.pp2 = mulFix(xMin - lsb + advance, scale);
    if (len === 0 || contours === 0) return out;

    if (contours > 0) {
      let p = off + 10;
      for (let c = 0; c < contours; c++, p += 2) out.ends.push(b.readUInt16BE(p));
      const count = out.ends[contours - 1] + 1;
      p += 2 + b.readUInt16BE(p);
      const flags: number[] = [];
      while (flags.length < count) {
        const f = b[p++];
        flags.push(f);
        if (f & 8) for (let r = b[p++]; r > 0; r--) flags.push(f);
      }
      let v = 0;
      const xu: number[] = [];
      for (const f of flags) {
        if (f & 2) v += f & 16 ? b[p++] : -b[p++];
        else if (!(f & 16)) {
          v += b.readInt16BE(p);
          p += 2;
        }
        xu.push(v);
      }
      v = 0;
      for (const [k, f] of flags.slice(0, count).entries()) {
        if (f & 4) v += f & 32 ? b[p++] : -b[p++];
        else if (!(f & 32)) {
          v += b.readInt16BE(p);
          p += 2;
        }
        out.xs.push(mulFix(xu[k], scale));
        out.ys.push(mulFix(v, scale));
        out.on.push((f & 1) === 1);
      }
      return out;
    }

    // Zusammengesetzte Glyphe (z. B. Buchstabe mit Akzent)
    if (depth > 8) return out;
    let p = off + 10;
    for (;;) {
      const flags = b.readUInt16BE(p);
      const index = b.readUInt16BE(p + 2);
      p += 4;
      let arg1: number;
      let arg2: number;
      if (flags & 1) {
        arg1 = flags & 2 ? b.readInt16BE(p) : b.readUInt16BE(p);
        arg2 = flags & 2 ? b.readInt16BE(p + 2) : b.readUInt16BE(p + 2);
        p += 4;
      } else {
        arg1 = flags & 2 ? b.readInt8(p) : b[p];
        arg2 = flags & 2 ? b.readInt8(p + 1) : b[p + 1];
        p += 2;
      }
      let xx = 0x10000;
      let xy = 0;
      let yx = 0;
      let yy = 0x10000;
      if (flags & 8) {
        xx = yy = b.readInt16BE(p) * 4;
        p += 2;
      } else if (flags & 0x40) {
        xx = b.readInt16BE(p) * 4;
        yy = b.readInt16BE(p + 2) * 4;
        p += 4;
      } else if (flags & 0x80) {
        xx = b.readInt16BE(p) * 4;
        yx = b.readInt16BE(p + 2) * 4;
        xy = b.readInt16BE(p + 4) * 4;
        yy = b.readInt16BE(p + 6) * 4;
        p += 8;
      }
      const sub = this.load(index, scale, depth + 1);
      // USE_MY_METRICS: Vorschub und Ränder der Komponente
      if (flags & 0x200) {
        out.pp1 = sub.pp1;
        out.pp2 = sub.pp2;
      }
      const haveScale = (flags & (8 | 0x40 | 0x80)) !== 0;
      if (haveScale) {
        for (let k = 0; k < sub.xs.length; k++) {
          const x = sub.xs[k];
          const y = sub.ys[k];
          sub.xs[k] = mulFix(x, xx) + mulFix(y, xy);
          sub.ys[k] = mulFix(x, yx) + mulFix(y, yy);
        }
      }
      let dx: number;
      let dy: number;
      if (!(flags & 2)) {
        // Punkt-Anker: Punkt arg2 der Komponente auf Punkt arg1 der bisherigen Umrisse
        if (arg1 >= out.xs.length || arg2 >= sub.xs.length) throw new Error('invalid composite glyph');
        dx = out.xs[arg1] - sub.xs[arg2];
        dy = out.ys[arg1] - sub.ys[arg2];
      } else {
        dx = arg1;
        dy = arg2;
        if (dx || dy) {
          if (haveScale && flags & 0x800) {
            dx = mulFix(dx, Math.round(Math.hypot(xx, xy)));
            dy = mulFix(dy, Math.round(Math.hypot(yy, yx)));
          }
          dx = mulFix(dx, scale);
          dy = mulFix(dy, scale);
          // ROUND_XY_TO_GRID: mit dem v40-Interpreter nur senkrecht
          if (flags & 4) dy = pixRound(dy);
        }
      }
      const base = out.xs.length;
      for (let k = 0; k < sub.xs.length; k++) {
        out.xs.push(sub.xs[k] + dx);
        out.ys.push(sub.ys[k] + dy);
        out.on.push(sub.on[k]);
      }
      for (const e of sub.ends) out.ends.push(e + base);
      if (!(flags & 0x20)) break;
    }
    return out;
  }

  // Maßstab (16.16) nach FT_Set_Char_Size(face, 0, pt * 64, dpi, dpi): FT_Request_Metrics, ggf. tt_size_reset
  scaleFor(pt: number, dpi: number): number {
    const height = Math.max(Math.trunc(pt * 64), 64);
    const scaled = Math.trunc((height * dpi + 36) / 72);
    return this.integerPpem ? divFix(((scaled + 32) >> 6) << 6, this.unitsPerEm) : divFix(scaled, this.unitsPerEm);
  }

  // FT_Load_Glyph(FT_LOAD_DEFAULT) beim Maßstab: Vorschub und linker Rand wie GD sie sieht, dazu der Umriss
  glyph(gid: number, scale: number): GlyphMetrics {
    const key = gid + '@' + scale;
    const cached = this.metricsCache.get(key);
    if (cached) return cached;
    const g = this.load(gid, scale, 0);
    // Ursprung auf pp1 (TT_Load_Glyph verschiebt den Umriss)
    if (g.pp1) for (let k = 0; k < g.xs.length; k++) g.xs[k] -= g.pp1;
    const minX = g.xs.length ? Math.min(...g.xs) : 0;
    const m: GlyphMetrics = {
      advance: pixRound(g.pp2 - g.pp1),
      bearingX: pixFloor(minX),
      outline: { xs: g.xs, ys: g.ys, on: g.on, ends: g.ends },
    };
    this.metricsCache.set(key, m);
    return m;
  }
}

const fonts = new Map<string, TtFont>();

// Schrift aus dem Dateipfad (einmal gelesen)
export function loadFont(path: string): TtFont {
  let f = fonts.get(path);
  if (!f) {
    f = new TtFont(readFileSync(path));
    fonts.set(path, f);
  }
  return f;
}

// ---------------------------------------------------------------- Messen und Setzen wie gdImageStringFTEx

// Ein gesetztes Zeichen: Glyphe und Stift-Position (26.6 bei 300 dpi)
export interface Placed {
  gid: number;
  pen: number;
}

const METRIC_RES = 300;
const GD_RESOLUTION = 96;

// Layout und Begrenzungsrahmen (nur waagerecht) wie gdImageStringFTEx() ohne libraqm
export function gdLayout(font: TtFont, s: string, pt: number): { glyphs: Placed[]; minX: number; maxX: number } {
  const scale = font.scaleFor(pt, METRIC_RES);
  const glyphs: Placed[] = [];
  let pen = 0;
  let minX = 0;
  let maxX = 0;
  const chars = gdChars(s);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    // Wagenrücklauf und Zeilenumbruch setzen nur den Stift zurück
    if (ch === 13 || ch === 10) {
      pen = 0;
      continue;
    }
    const gid = font.glyphIndex(ch);
    const m = font.glyph(gid, scale);
    const gMin = pen + m.bearingX;
    const gMax = pen + m.advance;
    if (i === 0) {
      minX = gMin;
      maxX = gMax;
    } else {
      if (gMin < minX) minX = gMin;
      if (gMax > maxX) maxX = gMax;
    }
    glyphs.push({ gid, pen });
    pen += m.advance;
  }
  return { glyphs, minX, maxX };
}

// imagettfbbox($pt, 0, $font, $s): Breite = |brect[2] - brect[0]|
export function gdTextWidth(font: TtFont, s: string, pt: number): number {
  const { minX, maxX } = gdLayout(font, s, pt);
  const scalex = GD_RESOLUTION / (64 * METRIC_RES);
  return Math.abs(Math.trunc(maxX * scalex) - Math.trunc(minX * scalex));
}

// gdTextWidth(erste k Zeichen von s + suffix) für jedes k von 0 bis zur Zahl der Zeichen (Codepoints wie Array.from) in
// einem Durchlauf – dieselben Werte wie einzeln gemessen, solange s kein & (Entity, liest voraus) und kein Nullbyte
// enthält: dann zerlegt gdChars() den ganzen Text Zeichen für Zeichen gleich (ein Zeichen über U+FFFF sind vier Bytes,
// jedes andere eines). Einzeln gemessen wäre das Kürzen in ogFit() quadratisch.
export function gdPrefixWidths(font: TtFont, s: string, suffix: string, pt: number): number[] {
  const scale = font.scaleFor(pt, METRIC_RES);
  const scalex = GD_RESOLUTION / (64 * METRIC_RES);
  const all = gdChars(s);
  const tail = gdChars(suffix);
  const metrics = new Map<number, GlyphMetrics>();
  const glyphOf = (ch: number): GlyphMetrics => {
    let m = metrics.get(ch);
    if (!m) {
      m = font.glyph(font.glyphIndex(ch), scale);
      metrics.set(ch, m);
    }
    return m;
  };
  // Stand nach den ersten Zeichen (wie gdLayout(): index zählt auch Zeilenumbrüche mit)
  let pen = 0;
  let minX = 0;
  let maxX = 0;
  let index = 0;
  const out: number[] = [];
  const measure = (): void => {
    let p = pen;
    let lo = minX;
    let hi = maxX;
    let i = index;
    for (const ch of tail) {
      if (ch === 13 || ch === 10) {
        p = 0;
      } else {
        const m = glyphOf(ch);
        if (i === 0) {
          lo = p + m.bearingX;
          hi = p + m.advance;
        } else {
          lo = Math.min(lo, p + m.bearingX);
          hi = Math.max(hi, p + m.advance);
        }
        p += m.advance;
      }
      i++;
    }
    out.push(Math.abs(Math.trunc(hi * scalex) - Math.trunc(lo * scalex)));
  };
  measure();
  let at = 0;
  for (let u = 0; u < s.length; ) {
    const cp = s.codePointAt(u) as number;
    u += cp > 0xffff ? 2 : 1;
    for (let n = cp > 0xffff ? 4 : 1; n > 0; n--) {
      const ch = all[at++];
      if (ch === 13 || ch === 10) {
        pen = 0;
      } else {
        const m = glyphOf(ch);
        if (index === 0) {
          minX = pen + m.bearingX;
          maxX = pen + m.advance;
        } else {
          minX = Math.min(minX, pen + m.bearingX);
          maxX = Math.max(maxX, pen + m.advance);
        }
        pen += m.advance;
      }
      index++;
    }
    measure();
  }
  return out;
}
