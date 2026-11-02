// Statusseiten: registrierbare Domain eines Hosts nach der Public Suffix List (mit dem privaten Teil, damit
// alice.github.io und bob.github.io getrennt zählen). Die Liste liegt als Datei in app/data/ (ohne npm-Paket) und
// wird vor einem Release mit app/scripts/psl-update.mjs erneuert. Regeln wie auf publicsuffix.org/list beschrieben:
// längste passende Regel, „*.x“ für jedes Label vor x, „!y.x“ als Ausnahme davon, ohne passende Regel gilt „*“.
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { domainToASCII } from 'node:url';
import { APP_DIR } from '../config.js';

export const PSL_FILE = join(APP_DIR, 'data', 'public_suffix_list.dat');

interface Rules {
  normal: Set<string>;
  wildcard: Set<string>; // „*.ck“ → „ck“
  exception: Set<string>; // „!www.ck“ → „www.ck“
}

let rules: Rules | null = null;

// Label für Label nach ASCII (Punycode); „*“ bleibt
function asciiRule(rule: string): string {
  return rule
    .split('.')
    .map((label) => (label === '*' || /^[\x00-\x7f]*$/.test(label) ? label.toLowerCase() : domainToASCII(label)))
    .join('.');
}

export function parsePsl(text: string): Rules {
  const r: Rules = { normal: new Set(), wildcard: new Set(), exception: new Set() };
  for (const raw of text.split('\n')) {
    const line = raw.trim().split(/\s/)[0] ?? '';
    if (line === '' || line.startsWith('//')) continue;
    if (line.startsWith('!')) r.exception.add(asciiRule(line.slice(1)));
    else if (line.startsWith('*.')) r.wildcard.add(asciiRule(line.slice(2)));
    else r.normal.add(asciiRule(line));
  }
  return r;
}

function loaded(): Rules {
  rules ??= parsePsl(readFileSync(PSL_FILE, 'utf8'));
  return rules;
}

// Nur Tests: eine eigene Liste
export function setPslForTests(text: string | null): void {
  rules = text === null ? null : parsePsl(text);
}

// Anzahl der Labels des öffentlichen Suffixes (mindestens 1)
function suffixLabels(labels: string[], r: Rules): number {
  let best = 1;
  for (let i = 0; i < labels.length; i++) {
    const suffix = labels.slice(i).join('.');
    const count = labels.length - i;
    // Ausnahme: das Suffix ist die Regel ohne ihr linkes Label
    if (r.exception.has(suffix)) return count - 1;
    if (r.normal.has(suffix) && count > best) best = count;
    if (i + 1 < labels.length && r.wildcard.has(labels.slice(i + 1).join('.')) && count > best) best = count;
  }
  return best;
}

// a.victim.com → victim.com, x.co.uk → x.co.uk, alice.github.io → alice.github.io. Eine IP-Adresse ist ihre eigene
// Domain; ist der Host selbst ein öffentliches Suffix, zählt der Host.
export function registrableDomain(host: string): string {
  let h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (isIP(h)) return h;
  if (!/^[\x00-\x7f]*$/.test(h)) h = domainToASCII(h) || h;
  const labels = h.split('.').filter((l) => l !== '');
  if (labels.length === 0) return h;
  const n = suffixLabels(labels, loaded());
  if (labels.length <= n) return labels.join('.');
  return labels.slice(labels.length - n - 1).join('.');
}
