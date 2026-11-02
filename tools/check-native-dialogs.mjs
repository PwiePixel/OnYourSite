#!/usr/bin/env node
// Prüft, dass keine Browser-Popups zurückkommen: alert/confirm/prompt, Bestätigungen im HTML (onsubmit=, return confirm),
// Seitenwechsel an der Wache vorbei (location.href = … in Skripten mit OYSUI.guard) und Benachrichtigungen ohne notify().
// Aufruf: node tools/check-native-dialogs.mjs [--strict]   (ohne --strict nur Warnungen, Exit 0; mit --strict Exit 1)
// Die Tests (app/test/native-dialogs.test.ts) laufen es bei jedem npm test mit.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Native Dialoge: trifft confirm( und window.alert(, aber nicht OYSUI.confirm( oder guard.confirm(
export const NATIVE = /(?<![\w$.])(?:(?:window|globalThis|self|top|parent)\.)?(alert|confirm|prompt)\s*\(/g;
// Bestätigungen im HTML: onsubmit=… und on…="return confirm(…)"
export const INLINE = /\bonsubmit\s*=|\bon[a-z]+\s*=\s*(?:\\?["'])\s*return\s+confirm/gi;
// In Skripten mit einer Wache: Seitenwechsel nur über guard.navigate() / guard.reload()
export const GUARDED = /OYSUI\.guard\s*\(/;
export const BYPASS = /\blocation\.href\s*=(?!=)|\blocation\.(?:assign|replace|reload)\s*\(|\bwindow\.location\s*=(?!=)/g;
// Benachrichtigungen schreibt nur app/src/notify/ (notify(), notifyAdmins())
export const RAW_NOTIFY = /INSERT\s+INTO\s+`?notifications`?/gi;

// Zeilennummer einer Fundstelle
function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

// Fundstellen in einem Text: [{ rule, line, match }]
export function checkText(text, { file = '', notifyAllowed = false } = {}) {
  const out = [];
  const scan = (re, rule) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) out.push({ file, rule, line: lineOf(text, m.index), match: m[0] });
  };
  scan(NATIVE, 'native-dialog');
  scan(INLINE, 'inline-confirm');
  if (GUARDED.test(text)) scan(BYPASS, 'guard-bypass');
  if (!notifyAllowed) scan(RAW_NOTIFY, 'raw-notification');
  return out.sort((a, b) => a.line - b.line);
}

function walk(dir, filter, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, filter, acc);
    else if (filter(p)) acc.push(p);
  }
  return acc;
}

// Geprüfte Dateien: die Skripte der Seite (ohne ui.js selbst) und der ganze Server-Code
export function targetFiles(root = ROOT) {
  const js = walk(join(root, 'static/js'), (p) => p.endsWith('.js') && !p.endsWith('/ui.js'));
  const ts = walk(join(root, 'app/src'), (p) => /\.(ts|js|mjs)$/.test(p));
  return [...js, ...ts];
}

export function checkFiles(files = targetFiles(), root = ROOT) {
  const out = [];
  for (const f of files) {
    const rel = relative(root, f);
    out.push(...checkText(readFileSync(f, 'utf8'), { file: rel, notifyAllowed: rel.startsWith('app/src/notify/') }));
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const strict = process.argv.includes('--strict');
  const found = checkFiles();
  for (const f of found) console.log(`${strict ? 'error' : 'warning'} ${f.file}:${f.line} ${f.rule}: ${f.match.trim()}`);
  console.log(found.length ? `${found.length} finding(s)` : 'no native dialogs found');
  process.exitCode = strict && found.length ? 1 : 0;
}
