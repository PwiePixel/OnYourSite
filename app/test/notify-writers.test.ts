// Prüfregel: Benachrichtigungen schreibt nur app/src/notify/ (notify(), notifyAdmins()). Nur so gelten überall
// dieselben Regeln (Längen, sichere Ziele, Typen) und „genau einmal“ über die Transaktion der Funktion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const RAW_WRITE = /\b(?:INSERT|REPLACE)\s+(?:LOW_PRIORITY\s+|DELAYED\s+|HIGH_PRIORITY\s+)?(?:IGNORE\s+)?INTO\s+`?notifications`?(?![A-Za-z0-9_])/i;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(p));
    else if (/\.(ts|js|mjs)$/.test(entry.name)) out.push(p);
  }
  return out;
}

// Zeilen (ab 1) mit einem direkten Schreibzugriff. Über den ganzen Text gesucht: Eine SQL-Anweisung kann über mehrere
// Zeilen gehen (`INSERT INTO` am Zeilenende, `notifications` in der nächsten).
function rawWrites(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(new RegExp(RAW_WRITE.source, 'gi'))) out.push(text.slice(0, m.index).split('\n').length);
  return out;
}

test('only app/src/notify/ writes rows into notifications', () => {
  const offenders: string[] = [];
  for (const file of files(SRC)) {
    const rel = relative(SRC, file).split('\\').join('/');
    if (rel.startsWith('notify/')) continue;
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    for (const n of rawWrites(text)) offenders.push(`${rel}:${n}: ${lines[n - 1].trim()}`);
  }
  assert.deepEqual(offenders, [], 'use notify()/notifyAdmins() from app/src/notify/notify.ts instead');
  // Die Regel findet, was sie finden soll – auch über Zeilen hinweg und mit der richtigen Zeilennummer
  for (const bad of ['INSERT INTO notifications (user_id)', 'insert ignore into `notifications` (x)', 'REPLACE INTO notifications SET', 'INSERT LOW_PRIORITY INTO notifications']) {
    assert.deepEqual(rawWrites(bad), [1], bad);
  }
  assert.deepEqual(rawWrites('const a = 1;\nawait exec(`INSERT INTO\n    notifications (user_id, type) VALUES (?, ?)`);\n'), [2]);
  for (const ok of ['DELETE FROM notifications WHERE user_id = ?', 'UPDATE notifications SET is_read = 1', 'INSERT INTO notifications_archive (id)']) {
    assert.deepEqual(rawWrites(ok), [], ok);
  }
});
