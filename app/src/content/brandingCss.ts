// Eigenes CSS und der Hinweis „Made with OnYourSite“ (premium-domains PD-1): Welche Regeln sprechen ihn an (Hinweis beim
// Speichern), und welche blenden ihn heute aus (Bestandsschutz Q9, Schema-Schritt V_BRANDING_LEGACY)? Rein – ohne
// Datenbank, ohne Einstellungen; gearbeitet wird auf dem gesäuberten CSS (cleanCss: Kommentare entfernt, Escapes von
// Buchstaben und Ziffern aufgelöst – .o\79s-foot ist dort schon .oys-foot).
import { strtolower } from '../php.js';

export const CSS_WARNING = 'Your custom CSS targets the “Made with OnYourSite” note. Hiding it is part of Premium, so it stays visible.';

export interface CssRule {
  selector: string; // Selektoren der Regel samt aller umschließenden Regeln (Verschachtelung), ohne @-Regeln
  body: string; // Deklarationen direkt in diesem Block (ohne verschachtelte Blöcke)
}

const collapse = (s: string): string => s.replace(/[ \t\n\r\f]+/g, ' ').trim();

// Tiefer verschachtelte Blöcke werden übersprungen (begrenzt die Arbeit bei Unsinn wie 20 000 „{“)
const MAX_DEPTH = 16;
// Jede verschachtelte Regel wiederholt die Selektoren der umschließenden – 20 000 Zeichen CSS ergäben so bis zu 30 Mio.
// Zeichen Selektoren. Darüber werden keine weiteren Regeln geliefert (gewöhnliches CSS bleibt weit darunter).
const MAX_SELECTOR_CHARS = 256 * 1024;

// Regeln aus (gesäubertem) CSS: Zeichenketten und Escapes werden übersprungen, Verschachtelung (auch @media) gefolgt.
// Kein vollständiger Parser – nur genug, um Selektoren und ihre Deklarationen zu finden. Läuft in einem Durchgang.
export function cssRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  const stack: Array<{ prelude: string; body: string }> = [];
  let skip = 0;
  let chunk = '';
  let total = 0; // Zeichen aller gelieferten Selektoren
  let full = false;
  const close = (): void => {
    const top = stack.pop();
    if (!top || top.prelude.startsWith('@') || full) return;
    const parts = [...stack.map((s) => s.prelude), top.prelude].filter((p) => !p.startsWith('@'));
    total += parts.reduce((n, p) => n + p.length + 1, 0);
    if (total > MAX_SELECTOR_CHARS) {
      full = true;
      return;
    }
    rules.push({ selector: parts.join(' '), body: top.body });
  };
  for (let i = 0; i < css.length && !full; i++) {
    const c = css[i];
    if (c === '\\') {
      chunk += css.slice(i, i + 2);
      i++;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== c) j += css[j] === '\\' ? 2 : 1;
      chunk += css.slice(i, j + 1);
      i = j;
    } else if (c === '{') {
      if (skip > 0 || stack.length >= MAX_DEPTH) skip++;
      else stack.push({ prelude: collapse(chunk), body: '' });
      chunk = '';
    } else if (c === '}') {
      if (skip > 0) {
        skip--;
      } else {
        if (stack.length) stack[stack.length - 1].body += chunk;
        close();
      }
      chunk = '';
    } else if (skip > 0) {
      continue;
    } else if (c === ';') {
      if (stack.length) stack[stack.length - 1].body += chunk + ';';
      chunk = '';
    } else {
      chunk += c;
    }
  }
  // Nicht geschlossene Blöcke am Ende zählen wie geschlossene (der Browser macht es genauso)
  while (stack.length && !full) {
    stack[stack.length - 1].body += chunk;
    chunk = '';
    close();
  }
  return rules;
}

// Spricht dieser Selektor den Hinweis an? Die Klasse oys-foot, das Element footer, das letzte Kind von main/.oys-main
// oder ein Attribut mit „foot“ oder der Adresse von OnYourSite (Link des Hinweises; base = Host der Seite ohne Port)
export function selectorTargetsBranding(selector: string, base = ''): boolean {
  if (selector.includes('oys-foot')) return true;
  const low = strtolower(selector);
  if (/(?:^|[^a-z0-9_.#\\-])footer(?![a-z0-9_-])/.test(low)) return true;
  const main = /\.oys-main(?![a-z0-9_-])|\.profile-container(?![a-z0-9_-])|(?:^|[^a-z0-9_.#\\-])main(?![a-z0-9_-])/.test(low);
  if (main && /:(?:last-child|last-of-type|nth-last-child|nth-last-of-type)/.test(low)) return true;
  const host = strtolower(base);
  // Attribute wie früher mit /\[[^\]]*\]/g: vom nächsten „[“ bis zum ersten „]“ danach – aber in einem Durchgang (der
  // Ausdruck brauchte bei vielen „[“ ohne „]“ quadratische Zeit)
  for (let open = low.indexOf('['); open >= 0;) {
    const end = low.indexOf(']', open);
    if (end < 0) break;
    const attr = low.slice(open, end + 1);
    if (attr.includes('on-your') || attr.includes('onyoursite') || attr.includes('foot') || (host !== '' && attr.includes(host))) return true;
    open = low.indexOf('[', end + 1);
  }
  return false;
}

// Spricht das CSS den Hinweis an? (beim Speichern: Hinweis im Editor, gespeichert wird trotzdem)
export function cssTouches(css: string, base = ''): boolean {
  return cssRules(css).some((r) => selectorTargetsBranding(r.selector, base));
}

// Ein Wert, der 0 ist (0, 0px, .0em, 0%)
const ZERO = /^[-+]?(?:0+(?:\.0*)?|\.0+)(?:[a-z%]+)?$/;
// Weit aus dem Bild geschoben (-9999px, 10000px …)
const FAR = /-\d{4,}|(?:^|[^\d.])\d{4,}(?:px|em|rem|vw|vh|%)/;
// Eine Zahl 0 in scale(…) bzw. opacity(…): 0+(?:\.0*)? statt 0+\.?0* (dieselben Texte, aber ohne quadratisches Zurückgehen)
const SCALE_ZERO = /scale(?:x|y|z|3d)?\(\s*[-+]?(?:0+(?:\.0*)?|\.0+)\s*[,)]/;
const OPACITY_ZERO = /opacity\(\s*(?:0+(?:\.0*)?|\.0+)%?\s*\)/;
const TRANSLATE = /translate(?:x|y|z|3d)?\(/;
const FAR_SHIFT = /-\d{4,}|(?<!\d)\d{4,}(?:px|em|rem|vw|vh|%)/;

// Weit verschoben mit translate(…)? Wie früher /translate(?:x|y|z|3d)?\([^)]*(?:-\d{4,}|\d{4,}(?:px|…|%))/, aber in einem
// Durchgang: je Abschnitt bis zur nächsten „)“ zählt der Text nach dem ersten translate( darin
function farTranslate(v: string): boolean {
  for (const seg of v.split(')')) {
    const m = TRANSLATE.exec(seg);
    if (m && FAR_SHIFT.test(seg.slice(m.index + m[0].length))) return true;
  }
  return false;
}

// Deklarationen, die ein Element verschwinden lassen – genau die, gegen die die festen Stile der Fußzeile jetzt wirken.
// decls: Eigenschaft → Wert (klein, ohne !important) einer Regel.
function hidesWith(decls: Map<string, string>): boolean {
  const clipped = /^(?:hidden|clip)$/.test(decls.get('overflow') ?? decls.get('overflow-x') ?? decls.get('overflow-y') ?? '');
  for (const [prop, v] of decls) {
    const num = /^[-+]?(?:\d+\.?\d*|\.\d+)/.exec(v);
    const n = num ? Number(num[0]) : NaN;
    switch (prop) {
      case 'display':
        if (v === 'none') return true;
        break;
      case 'visibility':
        if (v === 'hidden' || v === 'collapse') return true;
        break;
      case 'opacity':
        if (v.endsWith('%') ? n < 10 : n < 0.1) return true;
        break;
      case 'font-size':
        if (ZERO.test(v) || (/px$/.test(v) && n < 3)) return true;
        break;
      case 'height': case 'max-height':
        if (ZERO.test(v)) return true;
        break;
      case 'width': case 'max-width':
        if (clipped && ZERO.test(v)) return true;
        break;
      case 'clip-path': case 'mask': case '-webkit-mask': case 'mask-image': case '-webkit-mask-image':
        if (v !== 'none' && v !== '') return true;
        break;
      case 'clip':
        if (v !== 'auto' && v !== '') return true;
        break;
      case 'content-visibility':
        if (v === 'hidden') return true;
        break;
      case 'transform':
        if (SCALE_ZERO.test(v) || farTranslate(v)) return true;
        break;
      case 'scale': case 'zoom':
        if (ZERO.test(v.split(' ')[0] ?? '')) return true;
        break;
      case 'filter':
        if (OPACITY_ZERO.test(v) || v.includes('blur(')) return true;
        break;
      case 'text-indent': case 'left': case 'right': case 'top': case 'bottom': case 'inset': case 'translate':
        if (FAR.test(v)) return true;
        break;
    }
  }
  return false;
}

// Zustände und Pseudo-Elemente blenden den Hinweis nicht dauerhaft aus (::before, :hover …)
const TRANSIENT = /::|:(?:before|after|first-line|first-letter|hover|focus|focus-visible|focus-within|active|visited)(?![a-z-])/;

// :not(…) bis zur ersten „)“ entfernen – wie früher p.replace(/:not\([^)]*\)/gi, ''), aber in einem Durchgang
function dropNot(p: string): string {
  const open = /:not\(/gi;
  let out = '';
  let from = 0;
  for (let m = open.exec(p); m; m = open.exec(p)) {
    const end = p.indexOf(')', m.index + 5);
    if (end < 0) break;
    out += p.slice(from, m.index);
    from = end + 1;
    open.lastIndex = end + 1;
  }
  return out + p.slice(from);
}

// Strenger: blendet das CSS den Hinweis heute aus? Ein Selektor für den Hinweis UND eine ausblendende Deklaration in
// derselben Regel. Für den Bestandsschutz (Q9): solche Seiten behalten ihr Aussehen.
export function cssHides(css: string, base = ''): boolean {
  for (const r of cssRules(css)) {
    // Jede Angabe der Liste für sich; was nur in :not(…) steht, meint gerade nicht den Hinweis
    const parts = r.selector.split(',').map(dropNot);
    if (!parts.some((p) => selectorTargetsBranding(p, base) && !TRANSIENT.test(strtolower(p)))) continue;
    const decls = new Map<string, string>();
    for (const decl of r.body.split(';')) {
      const at = decl.indexOf(':');
      if (at < 0) continue;
      const prop = strtolower(decl.slice(0, at).trim());
      // !important am Ende weg – wie früher .replace(/\s*!\s*important$/, ''), ohne quadratisches Zurückgehen über lange
      // Folgen von Leerraum (z. B. U+00A0, das collapse() nicht zusammenfasst)
      const raw = strtolower(collapse(decl.slice(at + 1)));
      const bang = /!\s*important$/.exec(raw);
      const value = bang ? raw.slice(0, bang.index).trimEnd() : raw;
      if (prop !== '') decls.set(prop, value);
    }
    if (hidesWith(decls)) return true;
  }
  return false;
}
