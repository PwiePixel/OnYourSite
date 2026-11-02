// Statusseiten: robots.txt der geprüften Seiten (RFC 9309). Es zählt nur eine Gruppe, die „OnYourSite-Monitor“ nennt
// (Groß-/Kleinschreibung egal) – Gruppen für „*“ gelten Crawlern, nicht Verfügbarkeitsprüfungen. Längste passende
// Regel gewinnt, bei gleicher Länge „Allow“; „*“ steht für beliebige Zeichen, „$“ am Ende für das Ende des Pfads.
// Geholt wird höchstens einmal am Tag je Host (64 KiB, 10 s, Weiterleitungen nur auf demselben Host). 4xx = keine
// Regeln, 5xx oder nicht erreichbar = die zuletzt bekannten Regeln bleiben (sonst pausierte eine Prüfung genau dann,
// wenn die Seite ausfällt).

export const ROBOTS_AGENT = 'onyoursite-monitor';
export const ROBOTS_MAX = 64 * 1024;
export const ROBOTS_TTL = 86400;

export type RobotsRule = ['allow' | 'disallow', string];

// Regeln der eigenen Gruppe(n)
export function parseRobots(text: string, agent = ROBOTS_AGENT): RobotsRule[] {
  const body = Buffer.from(text, 'utf8').subarray(0, ROBOTS_MAX).toString('utf8');
  const rules: RobotsRule[] = [];
  let agents: string[] = [];
  let inRules = false; // die letzte Zeile war eine Regel → eine neue user-agent-Zeile beginnt eine neue Gruppe
  for (const raw of body.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (inRules) {
        agents = [];
        inRules = false;
      }
      agents.push(value.toLowerCase().split(/[\s/]/)[0]);
      continue;
    }
    if (key === 'allow' || key === 'disallow') {
      inRules = true;
      if (!agents.includes(agent)) continue;
      // Leeres Disallow erlaubt alles – das ist keine Regel
      if (value === '') continue;
      rules.push([key, normalizePath(value)]);
    }
  }
  return rules;
}

// Prozent-Kodierung vereinheitlichen: erlaubte Zeichen dekodieren, sonst Großbuchstaben (%2f → %2F)
function normalizePath(p: string): string {
  return p.replace(/%([0-9a-fA-F]{2})/g, (_m, hex: string) => {
    const c = String.fromCharCode(parseInt(hex, 16));
    return /[A-Za-z0-9\-._~]/.test(c) ? c : '%' + hex.toUpperCase();
  });
}

// Passt das Muster auf den Anfang des Pfads? „*“ = beliebige Zeichen, „$“ am Ende = Ende des Pfads (sonst ein
// gewöhnliches Zeichen). Bewusst ohne regulären Ausdruck: die Regeln kommen aus einer fremden Datei, und „/a*a*a*…b“
// als Ausdruck mit Rückverfolgung braucht exponentiell lange. Stattdessen die Menge der Stellen im Pfad, an denen der
// bisher gelesene Teil des Musters enden kann (wie Googles Parser) – höchstens Muster × Pfad Schritte.
export function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const pat = anchored ? pattern.slice(0, -1) : pattern;
  let pos: number[] = [0];
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*') {
      if (i > 0 && pat[i - 1] === '*') continue;
      // ab der frühesten möglichen Stelle passt jede spätere
      const from = pos[0];
      pos = [];
      for (let p = from; p <= path.length; p++) pos.push(p);
      continue;
    }
    const next: number[] = [];
    for (const p of pos) if (p < path.length && path[p] === c) next.push(p + 1);
    if (!next.length) return false;
    pos = next;
  }
  return anchored ? pos[pos.length - 1] === path.length : true;
}

// Ergebnisse je Regelsatz merken (der Prüfdienst fragt für dieselben Pfade immer wieder; der Satz eines Hosts bleibt
// bis zum nächsten Abruf dasselbe Objekt) – höchstens 1000 Pfade je Satz
const memo = new WeakMap<readonly RobotsRule[], Map<string, boolean>>();

// Darf dieser Pfad (mit Query) geprüft werden? /robots.txt selbst ist immer erlaubt.
export function robotsAllows(rules: readonly RobotsRule[], path: string): boolean {
  const p = normalizePath(path === '' ? '/' : path);
  if (p === '/robots.txt') return true;
  let known = memo.get(rules);
  const hit = known?.get(p);
  if (hit !== undefined) return hit;
  let best: RobotsRule | null = null;
  for (const r of rules) {
    // Eine Regel kann den Ausschlag nur geben, wenn sie mindestens so lang ist wie die bisher beste
    if (best && (r[1].length < best[1].length || (r[1].length === best[1].length && r[0] !== 'allow'))) continue;
    if (!patternMatches(r[1], p)) continue;
    best = r;
  }
  const allowed = !best || best[0] === 'allow';
  if (!known) {
    known = new Map();
    memo.set(rules, known);
  }
  if (known.size < 1000) known.set(p, allowed);
  return allowed;
}

// Ergebnis eines Abrufs: 2xx → die Regeln, 4xx → keine, sonst (5xx, nicht erreichbar) → die bisherigen
export function robotsAfterFetch(status: number | null, body: string | null, previous: RobotsRule[] | null): { rules: RobotsRule[]; error: string | null } {
  if (status !== null && status >= 200 && status < 300) return { rules: parseRobots(body ?? ''), error: null };
  if (status !== null && status >= 400 && status < 500) return { rules: [], error: null };
  return { rules: previous ?? [], error: status === null ? 'unreachable' : 'status' };
}

// Gespeicherte Regeln lesen (status_host_meta.robots_rules)
export function rulesFromJson(raw: unknown): RobotsRule[] {
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) return [];
    return data.filter((r): r is RobotsRule => Array.isArray(r) && (r[0] === 'allow' || r[0] === 'disallow') && typeof r[1] === 'string');
  } catch {
    return [];
  }
}
