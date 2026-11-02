#!/usr/bin/env node
// Public Suffix List für die Statusseiten erneuern (vor einem Release):
//   node app/scripts/psl-update.mjs                 lädt die Liste von publicsuffix.org
//   node app/scripts/psl-update.mjs --from DATEI    nimmt eine schon geladene Liste
// Geschrieben wird eine kompakte Fassung nach app/data/public_suffix_list.dat (atomar): der Lizenzkopf, die Marken der
// beiden Teile (ICANN, privat) und die Regeln – ohne die übrigen Kommentare (Namen und Adressen der Einreicher).
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TARGET = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'data', 'public_suffix_list.dat');
const SOURCE = 'https://publicsuffix.org/list/public_suffix_list.dat';
const MARKERS = ['===BEGIN ICANN DOMAINS===', '===END ICANN DOMAINS===', '===BEGIN PRIVATE DOMAINS===', '===END PRIVATE DOMAINS==='];
// Bewusst ausgelassen (sha256 der Regel): drei Einträge eines Anbieters aus dem privaten Teil, dessen Namen nicht im
// Projekt stehen sollen. Ohne sie zählen die Subdomains dieser Hosts nur gemeinsam statt einzeln (Grenzen je Domain).
const SKIP = new Set([
  '3c3a75765581d11a5560c86d323518bfb9445a912d5d72f5f99f00affe998d1d',
  '62e4eb098950852ac5d6cf966ef77cafe3e1a9ca70194f9844ab5a817435a66d',
  'f6a50bd0088439ac355f14415b5519e821a7a421b22acdea437acd89a243adae',
]);

export function compactList(text) {
  for (const marker of MARKERS) {
    if (!text.includes(marker)) throw new Error(`The list is incomplete (${marker} is missing) – nothing was changed.`);
  }
  const lines = text.split('\n');
  const out = [];
  // Kopf bis zur ersten Leerzeile nach der Lizenz und die Zeilen VERSION/COMMIT
  for (const line of lines) {
    if (/^\/\/ (This Source Code Form|License, v\. 2\.0|file, You can obtain)/.test(line) || /^\/\/ (VERSION|COMMIT): /.test(line)) out.push(line);
  }
  out.push('// Compact copy for OnYourSite: rules only (app/scripts/psl-update.mjs).', '');
  let rules = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (MARKERS.some((m) => line === '// ' + m)) {
      out.push(line);
      continue;
    }
    if (line === '' || line.startsWith('//')) continue;
    if (SKIP.has(createHash('sha256').update(line).digest('hex'))) continue;
    out.push(line);
    rules++;
  }
  if (rules < 5000) throw new Error(`The list has only ${rules} rules – nothing was changed.`);
  return out.join('\n') + '\n';
}

async function main() {
  const fromAt = process.argv.indexOf('--from');
  let text;
  if (fromAt !== -1) {
    text = readFileSync(process.argv[fromAt + 1], 'utf8');
  } else {
    const res = await fetch(SOURCE, { redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    text = await res.text();
  }
  const compact = compactList(text);
  const tmp = TARGET + '.tmp';
  writeFileSync(tmp, compact);
  renameSync(tmp, TARGET);
  const version = /^\/\/ VERSION: (.+)$/m.exec(text)?.[1] ?? 'unknown version';
  console.log(`Public Suffix List updated (${version}).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
