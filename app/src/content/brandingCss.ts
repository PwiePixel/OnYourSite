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

// Regeln aus (gesäubertem) CSS: Zeichenketten und Escapes werden übersprungen, Verschachtelung (auch @media) gefolgt.
// Kein vollständiger Parser – nur genug, um Selektoren und ihre Deklarationen zu finden. Läuft in einem Durchgang.
export function cssRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  const stack: Array<{ prelude: string; body: string }> = [];
  let skip = 0;
  let chunk = '';
  const close = (): void => {
    const top = stack.pop();
    if (!top || top.prelude.startsWith('@')) return;
    const selector = [...stack.map((s) => s.prelude), top.prelude].filter((p) => !p.startsWith('@')).join(' ');
    rules.push({ selector, body: top.body });
  };
  for (let i = 0; i < css.length; i++) {
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
  while (stack.length) {
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
  for (const m of low.matchAll(/\[[^\]]*\]/g)) {
    const attr = m[0];
    if (attr.includes('on-your') || attr.includes('onyoursite') || attr.includes('foot') || (host !== '' && attr.includes(host))) return true;
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
        if (/scale(?:x|y|z|3d)?\(\s*[-+]?(?:0+\.?0*|\.0+)\s*[,)]/.test(v) || /translate(?:x|y|z|3d)?\([^)]*(?:-\d{4,}|\d{4,}(?:px|em|rem|vw|vh|%))/.test(v)) return true;
        break;
      case 'scale': case 'zoom':
        if (ZERO.test(v.split(' ')[0] ?? '')) return true;
        break;
      case 'filter':
        if (/opacity\(\s*(?:0+\.?0*|\.0+)%?\s*\)/.test(v) || v.includes('blur(')) return true;
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

// Strenger: blendet das CSS den Hinweis heute aus? Ein Selektor für den Hinweis UND eine ausblendende Deklaration in
// derselben Regel. Für den Bestandsschutz (Q9): solche Seiten behalten ihr Aussehen.
export function cssHides(css: string, base = ''): boolean {
  for (const r of cssRules(css)) {
    // Jede Angabe der Liste für sich; was nur in :not(…) steht, meint gerade nicht den Hinweis
    const parts = r.selector.split(',').map((p) => p.replace(/:not\([^)]*\)/gi, ''));
    if (!parts.some((p) => selectorTargetsBranding(p, base) && !TRANSIENT.test(strtolower(p)))) continue;
    const decls = new Map<string, string>();
    for (const decl of r.body.split(';')) {
      const at = decl.indexOf(':');
      if (at < 0) continue;
      const prop = strtolower(decl.slice(0, at).trim());
      const value = strtolower(collapse(decl.slice(at + 1))).replace(/\s*!\s*important$/, '');
      if (prop !== '') decls.set(prop, value);
    }
    if (hidesWith(decls)) return true;
  }
  return false;
}
